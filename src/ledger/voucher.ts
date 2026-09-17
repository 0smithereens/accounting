/**
 * 凭证生成与借贷平衡校验。
 *
 * 铁律：输出的每一张凭证必须满足 Σ借方 = Σ贷方。
 * 如果规则配置有误导致不平，这里不会悄悄丢掉差额，而是：
 *   1. 生成一条「【系统配平】」分录挂到待处理科目
 *   2. 在 warnings 里写明差额金额与原始单据
 * 这样既保证了导出文件能被金蝶/用友直接导入，又不会掩盖配置问题。
 */

import type {
  Cents,
  DocumentRecord,
  ProcessingIssue,
  Provenance,
  Voucher,
  VoucherLine,
} from '../core/types.ts';
import type { AppConfig } from '../core/config.ts';
import { formatYuan, sumCents } from '../core/money.ts';
import { periodOf } from '../core/datetime.ts';
import { buildLinesFromRule, matchRule } from '../core/rules.ts';

export interface BuildVouchersOptions {
  /** 缺省会计期间（YYYY-MM），用于日期缺失的单据 */
  defaultPeriod?: string;
  /** 缺省记账日期（YYYY-MM-DD） */
  defaultDate?: string;
  /** 是否自动配平，默认 true */
  autoBalance?: boolean;
}

export interface BuildVouchersResult {
  vouchers: Voucher[];
  issues: ProcessingIssue[];
  unmatched: DocumentRecord[];
}

/** 一张凭证的累计状态，用于配平与汇总。 */
interface VoucherDraft {
  date: string;
  period: string;
  lines: VoucherLine[];
  attachments: number;
  warnings: string[];
  sources: Provenance[];
}

/**
 * 把单据集合转换为凭证。
 */
export function buildVouchers(
  documents: readonly DocumentRecord[],
  config: AppConfig,
  options: BuildVouchersOptions = {},
): BuildVouchersResult {
  const autoBalance = options.autoBalance ?? true;
  const issues: ProcessingIssue[] = [];
  const unmatched: DocumentRecord[] = [];
  const drafts: VoucherDraft[] = [];

  const fallbackDate = options.defaultDate ?? defaultDateOf(options.defaultPeriod);

  for (const doc of documents) {
    // 合同不是会计事项：只有明确说了款项已收付时才需要记账
    const isContract = doc.kind === 'contract';

    const match = doc.kind === 'unknown'
      ? null
      : matchRule(config.rules.rules, doc);

    if (match === null) {
      if (isContract) {
        issues.push({
          level: 'info',
          message: `合同「${doc.summary}」已登记台账，未生成记账凭证（合同本身不是会计事项）`,
          source: doc.source,
        });
      } else {
        unmatched.push(doc);
        issues.push({
          level: 'warning',
          message:
            `未匹配到任何记账规则：${doc.summary}（金额 ${formatYuan(doc.amount)}，方向 ${doc.direction}）；` +
            '请检查 config/mappings 下的规则是否覆盖该业务',
          source: doc.source,
        });
      }
      continue;
    }

    const built = buildLinesFromRule(match.rule, doc, match.reasons);

    // 合同虽然命中了规则（如明确已收款），但金额为 0 时没有记账意义
    if (isContract && doc.amount === 0) {
      issues.push({
        level: 'info',
        message: `合同「${doc.summary}」未识别到金额，仅登记台账`,
        source: doc.source,
      });
      continue;
    }

    // 科目解析：引用上级科目时自动下钻到默认明细科目
    const lines = built.lines.map((line) => {
      const resolved = config.accounts.resolve(line.accountCode);
      if (resolved.problem !== undefined) {
        issues.push({
          level: 'warning',
          message: `${resolved.problem}（规则 ${match.rule.id}，科目 ${line.accountCode}）`,
          source: line.source,
        });
      } else if (resolved.changed) {
        issues.push({
          level: 'info',
          message:
            `科目 ${line.accountCode} 有下级明细，已自动下钻到 ${resolved.code} ${resolved.name}` +
            `（规则 ${match.rule.id}）`,
          source: line.source,
        });
      }
      return { ...line, accountCode: resolved.code, accountName: resolved.name };
    });

    for (const w of built.warnings) {
      issues.push({ level: 'warning', message: `${doc.summary}：${w}`, source: doc.source });
    }
    for (const w of doc.warnings) {
      issues.push({ level: 'warning', message: `${doc.summary}：${w}`, source: doc.source });
    }

    const date = doc.date ?? fallbackDate;
    if (date === null) {
      issues.push({
        level: 'error',
        message: `单据「${doc.summary}」没有日期，且未指定缺省会计期间，无法生成凭证（请用 --period 指定）`,
        source: doc.source,
      });
      unmatched.push(doc);
      continue;
    }
    if (doc.date === null) {
      issues.push({
        level: 'warning',
        message: `单据「${doc.summary}」缺少业务日期，已使用缺省日期 ${date}`,
        source: doc.source,
      });
    }

    drafts.push({
      date,
      period: periodOf(date),
      lines,
      attachments: 1,
      warnings: [],
      sources: [doc.source],
    });
  }

  /* -------- 合并同日期凭证（可选） -------- */
  let finalDrafts = drafts;
  if (config.settings.mergeByDate) {
    const byDate = new Map<string, VoucherDraft>();
    for (const d of drafts) {
      const existing = byDate.get(d.date);
      if (existing === undefined) {
        byDate.set(d.date, { ...d, lines: [...d.lines] });
      } else {
        existing.lines.push(...d.lines);
        existing.attachments += d.attachments;
        existing.sources.push(...d.sources);
      }
    }
    finalDrafts = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  } else {
    finalDrafts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /* -------- 配平 + 拆分为凭证 -------- */
  const vouchers: Voucher[] = [];
  let sequence = 0;

  for (const draft of finalDrafts) {
    const chunks = splitDraft(draft, config.settings.maxLinesPerVoucher);

    for (const chunk of chunks) {
      // 删除金额为 0 的分录行（规则模板里的空税额、空社保行等）
      if (config.settings.dropZeroLines) {
        const nonZero = chunk.lines.filter((l) => l.debit !== 0 || l.credit !== 0);
        if (nonZero.length > 0 && nonZero.length < chunk.lines.length) {
          const dropped = chunk.lines.length - nonZero.length;
          chunk.lines = nonZero;
          chunk.warnings.push(`已忽略 ${dropped} 条金额为 0 的分录行`);
        }
      }

      // 配平
      const debitTotal = sumCents(chunk.lines.map((l) => l.debit));
      const creditTotal = sumCents(chunk.lines.map((l) => l.credit));
      const diff = debitTotal - creditTotal;

      if (diff !== 0) {
        if (autoBalance) {
          const suspenseCode = config.settings.suspenseAccount;
          const account = config.accounts.get(suspenseCode);
          const plugLine: VoucherLine = diff > 0
            ? {
                accountCode: suspenseCode,
                accountName: account === undefined ? suspenseCode : config.accounts.fullName(suspenseCode),
                debit: 0,
                credit: diff,
                summary: '【系统配平】借方大于贷方的差额',
                source: chunk.lines[0]?.source ?? { file: '' },
              }
            : {
                accountCode: suspenseCode,
                accountName: account === undefined ? suspenseCode : config.accounts.fullName(suspenseCode),
                debit: -diff,
                credit: 0,
                summary: '【系统配平】贷方大于借方的差额',
                source: chunk.lines[0]?.source ?? { file: '' },
              };
          chunk.lines.push(plugLine);
          chunk.warnings.push(
            `借贷不平，差额 ${formatYuan(diff)} 已挂入待处理科目 ${suspenseCode}，请人工调整对应规则`,
          );
          issues.push({
            level: 'error',
            message:
              `凭证借贷不平：借方 ${formatYuan(debitTotal)}，贷方 ${formatYuan(creditTotal)}，` +
              `差额 ${formatYuan(diff)}，已自动挂入待处理科目 ${suspenseCode}`,
            source: chunk.sources[0] ?? { file: '' },
          });
        } else {
          chunk.warnings.push(
            `借贷不平：借方 ${formatYuan(debitTotal)}，贷方 ${formatYuan(creditTotal)}，差额 ${formatYuan(diff)}`,
          );
          issues.push({
            level: 'error',
            message: `凭证借贷不平且未启用自动配平，差额 ${formatYuan(diff)}`,
            source: chunk.sources[0] ?? { file: '' },
          });
        }
      }

      sequence += 1;
      const finalDebit = sumCents(chunk.lines.map((l) => l.debit));
      const finalCredit = sumCents(chunk.lines.map((l) => l.credit));

      vouchers.push({
        id: `${chunk.period}-${String(sequence).padStart(4, '0')}`,
        date: chunk.date,
        period: chunk.period,
        word: `${config.settings.voucherWord}-${String(sequence).padStart(4, '0')}`,
        lines: chunk.lines,
        attachments: chunk.attachments,
        balanced: finalDebit === finalCredit,
        totalDebit: finalDebit,
        totalCredit: finalCredit,
        source: chunk.sources[0] ?? { file: '' },
        warnings: chunk.warnings,
      });
    }
  }

  return { vouchers, issues, unmatched };
}

function defaultDateOf(period?: string): string | null {
  if (period === undefined || period === '') return null;
  return `${period}-01`;
}

/** 明细行超过上限时拆分，保证每张凭证行数可控。 */
function splitDraft(draft: VoucherDraft, maxLines: number): VoucherDraft[] {
  if (maxLines <= 0 || draft.lines.length <= maxLines) return [draft];
  const chunks: VoucherDraft[] = [];
  for (let i = 0; i < draft.lines.length; i += maxLines) {
    chunks.push({
      date: draft.date,
      period: draft.period,
      lines: draft.lines.slice(i, i + maxLines),
      attachments: draft.attachments,
      warnings: [...draft.warnings],
      sources: [...draft.sources],
    });
  }
  return chunks;
}

/* ------------------------------------------------------------------ */
/* 汇总统计                                                            */
/* ------------------------------------------------------------------ */

export interface LedgerSummary {
  totalDebit: Cents;
  totalCredit: Cents;
  /** 科目编码 → 借/贷发生额 */
  byAccount: Map<string, { accountName: string; debit: Cents; credit: Cents; count: number }>;
  unbalancedCount: number;
}

export function summarizeVouchers(vouchers: readonly Voucher[]): LedgerSummary {
  const byAccount = new Map<string, { accountName: string; debit: Cents; credit: Cents; count: number }>();
  let totalDebit = 0;
  let totalCredit = 0;
  let unbalancedCount = 0;

  for (const v of vouchers) {
    totalDebit += v.totalDebit;
    totalCredit += v.totalCredit;
    if (!v.balanced) unbalancedCount += 1;

    for (const line of v.lines) {
      const bucket = byAccount.get(line.accountCode) ?? {
        accountName: line.accountName,
        debit: 0,
        credit: 0,
        count: 0,
      };
      bucket.debit += line.debit;
      bucket.credit += line.credit;
      bucket.count += 1;
      byAccount.set(line.accountCode, bucket);
    }
  }

  return { totalDebit, totalCredit, byAccount, unbalancedCount };
}

/** 试算平衡表：按科目汇总借贷发生额与期末余额方向。 */
export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  category: string;
  debitTotal: Cents;
  creditTotal: Cents;
  /** 借方余额（正数表示借方余额，负数表示贷方余额） */
  balance: Cents;
}

export function buildTrialBalance(
  vouchers: readonly Voucher[],
  config: AppConfig,
): TrialBalanceRow[] {
  const summary = summarizeVouchers(vouchers);
  const rows: TrialBalanceRow[] = [];

  for (const [code, bucket] of summary.byAccount) {
    const account = config.accounts.get(code);
    rows.push({
      accountCode: code,
      accountName: bucket.accountName,
      category: account?.category ?? 'unknown',
      debitTotal: bucket.debit,
      creditTotal: bucket.credit,
      balance: bucket.debit - bucket.credit,
    });
  }

  rows.sort((a, b) => (a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : 0));
  return rows;
}
