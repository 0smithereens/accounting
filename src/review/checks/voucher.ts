/**
 * 凭证层检查。
 *
 * 这一层回答的是会计法最基础的问题：凭证是否真实、完整、平衡、可追溯。
 * 所有检查都围绕「记账凭证」这一最小可审计单元展开：
 *  - 金额形态（借贷平衡、单行金额、负数）
 *  - 业务要素（日期、摘要、附单据数、科目）
 *  - 异常痕迹（兜底科目挂账、重复记账、货币资金负数）
 *
 * 检查函数只负责产出结论内容；severity / category / blocking 由引擎按注册表回填。
 */

import type {
  Cents,
  LawBasis,
  ReviewContext,
  ReviewFinding,
  ReviewInput,
  ReviewTarget,
  Voucher,
  VoucherLine,
} from '../../core/contracts.ts';
import { formatYuan, sumCents } from '../../core/money.ts';
import { isValidDateString, periodOf } from '../../core/datetime.ts';
import { compactText } from '../../core/text.ts';
import {
  LAW_ACCOUNTING_BASIS_51,
  LAW_ACCOUNTING_BASIS_60,
  LAW_ACCOUNTING_LAW_9,
  LAW_ACCOUNTING_LAW_13,
  LAW_ACCOUNTING_LAW_14,
  LAW_CAS_BASIC_9,
  LAW_ENTERPRISE_SYSTEM_11,
} from '../legal.ts';
import type { CheckDefinition } from '../engine.ts';

/* ================================================================== */
/* 一、规则 id                                                         */
/* ================================================================== */

export const VOUCHER_RULE_IDS = {
  balance: 'VOUCHER-BALANCE-001',
  empty: 'VOUCHER-EMPTY-001',
  date: 'VOUCHER-DATE-001',
  summary: 'VOUCHER-SUMMARY-001',
  attachment: 'VOUCHER-ATTACH-001',
  suspense: 'VOUCHER-SUSPENSE-001',
  cash: 'VOUCHER-CASH-001',
  negative: 'VOUCHER-NEGATIVE-001',
  duplicate: 'VOUCHER-DUP-001',
} as const;

/* ================================================================== */
/* 二、工具                                                            */
/* ================================================================== */

function makeFinding(
  ctx: ReviewContext,
  ruleId: string,
  target: ReviewTarget,
  title: string,
  detail: string,
  suggestion: string,
  basis: LawBasis[],
  evidence?: Record<string, unknown>,
): ReviewFinding {
  const finding: ReviewFinding = {
    id: ctx.nextId(),
    ruleId,
    severity: 'warning',
    category: 'accounting_law',
    title,
    detail,
    suggestion,
    basis,
    target,
    blocking: false,
  };
  if (evidence !== undefined) finding.evidence = evidence;
  return finding;
}

function voucherTarget(voucher: Voucher): ReviewTarget {
  return { kind: 'voucher', id: voucher.id, label: `${voucher.word}（${voucher.date}）` };
}

function lineTarget(voucher: Voucher, index: number): ReviewTarget {
  return {
    kind: 'voucher_line',
    id: `${voucher.id}#L${index + 1}`,
    label: `${voucher.word} 第 ${index + 1} 行`,
  };
}

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 兜底科目判定：1901 及其明细（1901.01 …）。 */
function isSuspenseAccount(code: string): boolean {
  return code === '1901' || code.startsWith('1901.');
}

/** 摘要是否「没有信息量」。 */
const VAGUE_SUMMARIES = new Set([
  '费用',
  '报销',
  '付款',
  '收款',
  '转账',
  '往来',
  '其他',
  '支出',
  '收入',
  '借款',
  '还款',
  '结算',
  '业务',
  '办公',
  '发票',
  '银行',
  '现金',
  '材料',
  '商品',
  '费用报销',
  '日常报销',
  '银行转账',
  '银行付款',
  '银行收款',
  '现金付款',
  '现金收款',
  '备用金',
  '杂费',
  '待处理',
  '其他费用',
  '其他支出',
  '其他收入',
]);

function summaryProblem(summary: string): string | null {
  const text = compactText(summary);
  if (text === '') return '摘要为空';
  if (text.length < 4) return '摘要过短（不足 4 个字符）';
  if (/^[\d\s.,:;()\-_/#]+$/.test(text)) return '摘要仅含数字或符号，无法辨认业务';
  if (VAGUE_SUMMARIES.has(text)) return '摘要表述笼统，未说明具体业务';
  return null;
}

/* ================================================================== */
/* 三、检查项                                                          */
/* ================================================================== */

/** VOUCHER-BALANCE-001：借贷不平衡。 */
function checkBalance(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const voucher of input.vouchers) {
    const debitTotal = sumCents(voucher.lines.map((line) => line.debit));
    const creditTotal = sumCents(voucher.lines.map((line) => line.credit));
    const diff = debitTotal - creditTotal;
    if (diff === 0) continue;

    findings.push(
      makeFinding(
        ctx,
        VOUCHER_RULE_IDS.balance,
        voucherTarget(voucher),
        '凭证借贷不平衡',
        `凭证 ${voucher.word}（记账日期 ${voucher.date}）借方合计 ${formatYuan(debitTotal)} 元，` +
          `贷方合计 ${formatYuan(creditTotal)} 元，差额 ${formatYuan(diff)} 元。` +
          '借贷不平衡的凭证无法过账，也无法通过试算平衡，属于会计法意义上的不合格记账凭证。',
        '检查该凭证的取数来源与分录模板：是否漏记税额、是否把含税金额同时计入借贷两方、' +
          '是否在配平时把差额挂入待处理科目。必须调整至借贷相等后才能进入下一环节。',
        [LAW_ACCOUNTING_LAW_13, LAW_ACCOUNTING_BASIS_51, LAW_ENTERPRISE_SYSTEM_11],
        {
          voucherId: voucher.id,
          word: voucher.word,
          debitTotal,
          creditTotal,
          diff,
          declaredBalanced: voucher.balanced,
          declaredDebit: voucher.totalDebit,
          declaredCredit: voucher.totalCredit,
        },
      ),
    );
  }

  return findings;
}

/** VOUCHER-EMPTY-001：无分录或全零分录。 */
function checkEmpty(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const voucher of input.vouchers) {
    const allZero = voucher.lines.every((line) => line.debit === 0 && line.credit === 0);
    if (voucher.lines.length > 0 && !allZero) continue;

    const reason = voucher.lines.length === 0 ? '没有任何分录行' : `${voucher.lines.length} 行分录金额全部为 0`;
    findings.push(
      makeFinding(
        ctx,
        VOUCHER_RULE_IDS.empty,
        voucherTarget(voucher),
        '凭证无有效分录',
        `凭证 ${voucher.word}（记账日期 ${voucher.date}）${reason}。` +
          '没有金额的记账凭证不反映任何经济业务，既不能作为记账依据，也会污染凭证连续编号与档案完整性。',
        '删除该凭证前必须先确认它是否由空单据/零金额单据生成：' +
          '若是，应修正上游规则或单据识别；若确需作废，应保留凭证并标注「作废」，不得物理删除。',
        [LAW_ACCOUNTING_LAW_14, LAW_ACCOUNTING_BASIS_51],
        { voucherId: voucher.id, lineCount: voucher.lines.length, allZero },
      ),
    );
  }

  return findings;
}

/** VOUCHER-DATE-001：日期在未来，或日期与所属期间不一致。 */
function checkDate(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const today = todayString();

  for (const voucher of input.vouchers) {
    const problems: string[] = [];

    if (!isValidDateString(voucher.date)) {
      problems.push(`记账日期「${voucher.date}」不是合法的 YYYY-MM-DD 日期`);
    } else {
      if (voucher.date > today) {
        problems.push(`记账日期 ${voucher.date} 晚于今天 ${today}，属于未来日期`);
      }
      const datePeriod = periodOf(voucher.date);
      if (datePeriod !== voucher.period) {
        problems.push(
          `凭证所属期间 ${voucher.period} 与记账日期 ${voucher.date} 所在期间 ${datePeriod} 不一致`,
        );
      }
    }

    if (problems.length === 0) continue;

    findings.push(
      makeFinding(
        ctx,
        VOUCHER_RULE_IDS.date,
        voucherTarget(voucher),
        '凭证日期异常',
        `凭证 ${voucher.word}：${problems.join('；')}。` +
          '未来日期会提前确认收入/费用，跨期日期会破坏权责发生制与期间可比性。',
        '按经济业务实际发生日期或权责发生制归属期间更正记账日期；' +
          '确需跨期调整的，应通过「以前年度损益调整」等专门科目处理并在附注披露。',
        [LAW_ACCOUNTING_LAW_14, LAW_ACCOUNTING_BASIS_51, LAW_CAS_BASIC_9],
        { voucherId: voucher.id, date: voucher.date, period: voucher.period, today, problems },
      ),
    );
  }

  return findings;
}

/** VOUCHER-SUMMARY-001：摘要为空、过短或无信息量。 */
function checkSummary(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const voucher of input.vouchers) {
    const bad: Array<{ line: number; summary: string; reason: string }> = [];

    voucher.lines.forEach((line, index) => {
      const reason = summaryProblem(line.summary);
      if (reason !== null) bad.push({ line: index + 1, summary: line.summary, reason });
    });

    if (bad.length === 0) continue;

    const examples = bad
      .slice(0, 5)
      .map((item) => `第 ${item.line} 行「${item.summary}」：${item.reason}`)
      .join('；');
    const more = bad.length > 5 ? `；……另有 ${bad.length - 5} 行` : '';

    findings.push(
      makeFinding(
        ctx,
        VOUCHER_RULE_IDS.summary,
        voucherTarget(voucher),
        '凭证摘要不合格',
        `凭证 ${voucher.word} 共 ${voucher.lines.length} 行分录，其中 ${bad.length} 行摘要不合格：${examples}${more}。` +
          '摘要无法辨认业务实质时，后续复核、审计与税务检查都无法追溯该笔分录对应的原始凭证。',
        '摘要应写明「谁、因何事、何时、依据什么单据」，例如「支付2024年1月办公室租金（租赁合同HT-001）」，' +
          '不得使用「费用」「转账」「其他」这类无法辨认业务的笼统表述。',
        [LAW_ACCOUNTING_BASIS_51, LAW_ACCOUNTING_LAW_14],
        {
          voucherId: voucher.id,
          badLineCount: bad.length,
          lineCount: voucher.lines.length,
          examples: bad.slice(0, 10),
        },
      ),
    );
  }

  return findings;
}

/** 无需附原始凭证的凭证类型：结账、期末结转、更正错误。 */
const ATTACHMENT_EXEMPT_PATTERN = /结转|结账|期末|更正|冲销|红字/;

/** VOUCHER-ATTACH-001：附单据数为 0。 */
function checkAttachment(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const voucher of input.vouchers) {
    if (voucher.attachments > 0) continue;

    const text = `${voucher.word} ${voucher.lines.map((line) => line.summary).join(' ')}`;
    if (ATTACHMENT_EXEMPT_PATTERN.test(text)) continue;

    findings.push(
      makeFinding(
        ctx,
        VOUCHER_RULE_IDS.attachment,
        voucherTarget(voucher),
        '凭证未附原始单据',
        `凭证 ${voucher.word}（记账日期 ${voucher.date}）附单据数为 0，且摘要未显示为结账/结转/更正类凭证。` +
          '除结账和更正错误的记账凭证外，记账凭证必须附有原始凭证并注明张数，否则无法证明业务真实发生。',
        '补充发票、银行回单、合同、验收单等原始凭证，并在凭证上填写实际附件张数；' +
          '若确属结账或更正凭证，请在摘要中明确标注「结转」「更正」等字样。',
        [LAW_ACCOUNTING_BASIS_51, LAW_ACCOUNTING_LAW_14],
        { voucherId: voucher.id, attachments: voucher.attachments, date: voucher.date },
      ),
    );
  }

  return findings;
}

/** VOUCHER-SUSPENSE-001：使用兜底科目 1901。 */
function checkSuspense(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const voucher of input.vouchers) {
    const hits = voucher.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => isSuspenseAccount(line.accountCode));
    if (hits.length === 0) continue;

    const amount = sumCents(hits.map(({ line }) => line.debit + line.credit));
    const lines = hits
      .slice(0, 5)
      .map(({ line, index }) => `第 ${index + 1} 行 ${line.accountCode} ${formatYuan(line.debit + line.credit)} 元`)
      .join('；');

    findings.push(
      makeFinding(
        ctx,
        VOUCHER_RULE_IDS.suspense,
        voucherTarget(voucher),
        '使用兜底科目 1901 挂账',
        `凭证 ${voucher.word} 使用了待处理科目 1901（待处理财产损溢）：${lines}` +
          `${hits.length > 5 ? `；……共 ${hits.length} 行` : ''}，涉及金额 ${formatYuan(amount)} 元。` +
          '1901 在本系统中是「规则未覆盖或借贷不平时」的临时挂账科目，出现即说明存在未查明差异，' +
          '长期挂账会掩盖真实的资产负债状况。',
        '查明差额原因：是规则缺失、单据识别错误，还是确实存在待处理财产损溢。' +
          '查明后调整至正确科目；确需暂时挂账的，必须在摘要注明原因、责任人与预计清理时间，并在期末前清理完毕。',
        [LAW_ACCOUNTING_LAW_9, LAW_ENTERPRISE_SYSTEM_11, LAW_ACCOUNTING_BASIS_60],
        {
          voucherId: voucher.id,
          hitCount: hits.length,
          amount,
          accounts: hits.map(({ line, index }) => ({ line: index + 1, accountCode: line.accountCode })),
        },
      ),
    );
  }

  return findings;
}

/** VOUCHER-CASH-001：库存现金/银行存款出现贷方余额（负数余额）。 */
function checkCashBalance(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const ledger = input.ledger;
  if (ledger === undefined) return [];

  const findings: ReviewFinding[] = [];

  for (const balance of ledger.balances) {
    const isCash = balance.accountCode === '1001' || balance.accountCode.startsWith('1001.')
      || balance.accountCode === '1002' || balance.accountCode.startsWith('1002.');
    if (!isCash) continue;
    if (balance.closing >= 0) continue;

    findings.push(
      makeFinding(
        ctx,
        VOUCHER_RULE_IDS.cash,
        {
          kind: 'ledger',
          id: balance.accountCode,
          label: `${balance.accountCode} ${balance.accountName}`,
        },
        '货币资金出现贷方余额',
        `科目 ${balance.accountCode} ${balance.accountName} 期末余额为 ${formatYuan(balance.closing)} 元` +
          `（贷方余额 ${formatYuan(-balance.closing)} 元）：期初 ${formatYuan(balance.opening)} 元，` +
          `本期借方 ${formatYuan(balance.debitTotal)} 元，本期贷方 ${formatYuan(balance.creditTotal)} 元。` +
          '现金或银行存款不可能出现负数余额，出现即意味着存在未入账的收款、错记的付款，或账实不符。',
        '取得银行对账单与现金盘点表逐笔核对：补记未入账的收款、冲正错记的付款；' +
          '若为未达账项，应编制银行存款余额调节表并留存；不得用其他科目长期垫付货币资金。',
        [LAW_ACCOUNTING_BASIS_60, LAW_ACCOUNTING_LAW_9, LAW_ENTERPRISE_SYSTEM_11],
        {
          accountCode: balance.accountCode,
          opening: balance.opening,
          debitTotal: balance.debitTotal,
          creditTotal: balance.creditTotal,
          closing: balance.closing,
        },
      ),
    );
  }

  return findings;
}

/** VOUCHER-NEGATIVE-001：同一行借贷同时有值、同时为 0，或出现负数金额。 */
function checkLineAmountShape(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const voucher of input.vouchers) {
    voucher.lines.forEach((line, index) => {
      const problems: string[] = [];
      if (line.debit < 0) problems.push(`借方金额为负数（${formatYuan(line.debit)} 元）`);
      if (line.credit < 0) problems.push(`贷方金额为负数（${formatYuan(line.credit)} 元）`);
      if (line.debit > 0 && line.credit > 0) {
        problems.push(`同一行借贷同时有金额（借 ${formatYuan(line.debit)} 元 / 贷 ${formatYuan(line.credit)} 元）`);
      }
      if (line.debit === 0 && line.credit === 0) problems.push('同一行借贷金额均为 0');
      if (problems.length === 0) return;

      findings.push(
        makeFinding(
          ctx,
          VOUCHER_RULE_IDS.negative,
          lineTarget(voucher, index),
          '分录金额形态非法',
          `凭证 ${voucher.word} 第 ${index + 1} 行（科目 ${line.accountCode} ${line.accountName}）：${problems.join('；')}。` +
            '一行分录只能有借方或贷方一个方向的金额；负数金额会破坏借贷合计与报表取数逻辑。',
          '把红字冲销改为相反方向的分录，或使用明确的负数调整科目；删除金额为 0 的空行；' +
            '确保每行分录「有且仅有一个方向、金额为正」。',
          [LAW_ACCOUNTING_BASIS_51, LAW_ACCOUNTING_LAW_14],
          {
            voucherId: voucher.id,
            lineNumber: index + 1,
            accountCode: line.accountCode,
            debit: line.debit,
            credit: line.credit,
            problems,
          },
        ),
      );
    });
  }

  return findings;
}

function voucherFingerprint(voucher: Voucher): string {
  const lines = voucher.lines
    .map((line) => `${line.accountCode}:${line.debit}:${line.credit}`)
    .sort()
    .join('|');
  return `${voucher.date}|${voucher.totalDebit}|${voucher.totalCredit}|${lines}`;
}

/** VOUCHER-DUP-001：疑似重复凭证。 */
function checkDuplicate(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const firstSeen = new Map<string, Voucher>();

  for (const voucher of input.vouchers) {
    if (voucher.totalDebit === 0 && voucher.totalCredit === 0) continue;

    const fingerprint = voucherFingerprint(voucher);
    const previous = firstSeen.get(fingerprint);
    if (previous === undefined) {
      firstSeen.set(fingerprint, voucher);
      continue;
    }

    findings.push(
      makeFinding(
        ctx,
        VOUCHER_RULE_IDS.duplicate,
        voucherTarget(voucher),
        '疑似重复凭证',
        `凭证 ${voucher.word} 与凭证 ${previous.word} 在记账日期、借贷合计、科目与逐行金额上完全一致，` +
          '疑似同一业务被重复记账。重复记账会虚增收入/费用与资产负债规模。',
        '核对原始单据是否被重复导入：若确为同一业务，应作废其中一张并保留作废痕迹（不得物理删除）；' +
          '若为同一天发生的多笔同额业务，请在摘要中注明各自单据号或流水号以示区分。',
        [LAW_ACCOUNTING_LAW_9, LAW_ENTERPRISE_SYSTEM_11, LAW_ACCOUNTING_BASIS_60],
        {
          voucherId: voucher.id,
          duplicatedWith: previous.id,
          duplicatedWord: previous.word,
          date: voucher.date,
          totalDebit: voucher.totalDebit,
          lineCount: voucher.lines.length,
        },
      ),
    );
  }

  return findings;
}

/* ================================================================== */
/* 四、注册                                                            */
/* ================================================================== */

export const voucherChecks: readonly CheckDefinition[] = [
  {
    id: VOUCHER_RULE_IDS.balance,
    title: '凭证借贷平衡',
    category: 'accounting_law',
    severity: 'error',
    blocking: true,
    configurable: false,
    basis: [LAW_ACCOUNTING_LAW_13, LAW_ACCOUNTING_BASIS_51],
    run: checkBalance,
  },
  {
    id: VOUCHER_RULE_IDS.empty,
    title: '凭证存在有效分录',
    category: 'accounting_law',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_ACCOUNTING_LAW_14, LAW_ACCOUNTING_BASIS_51],
    run: checkEmpty,
  },
  {
    id: VOUCHER_RULE_IDS.date,
    title: '凭证日期与期间一致且非未来',
    category: 'accounting_law',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_ACCOUNTING_LAW_14, LAW_CAS_BASIC_9],
    run: checkDate,
  },
  {
    id: VOUCHER_RULE_IDS.summary,
    title: '凭证摘要清晰可追溯',
    category: 'accounting_basis',
    severity: 'warning',
    blocking: false,
    configurable: true,
    basis: [LAW_ACCOUNTING_BASIS_51, LAW_ACCOUNTING_LAW_14],
    run: checkSummary,
  },
  {
    id: VOUCHER_RULE_IDS.attachment,
    title: '凭证附有原始单据',
    category: 'accounting_basis',
    severity: 'warning',
    blocking: false,
    configurable: true,
    basis: [LAW_ACCOUNTING_BASIS_51, LAW_ACCOUNTING_LAW_14],
    run: checkAttachment,
  },
  {
    id: VOUCHER_RULE_IDS.suspense,
    title: '未使用兜底科目挂账',
    category: 'accounting_law',
    severity: 'error',
    blocking: true,
    configurable: false,
    basis: [LAW_ACCOUNTING_LAW_9, LAW_ENTERPRISE_SYSTEM_11],
    run: checkSuspense,
  },
  {
    id: VOUCHER_RULE_IDS.cash,
    title: '货币资金无贷方余额',
    category: 'accounting_basis',
    severity: 'warning',
    blocking: false,
    configurable: true,
    basis: [LAW_ACCOUNTING_BASIS_60, LAW_ACCOUNTING_LAW_9],
    run: checkCashBalance,
  },
  {
    id: VOUCHER_RULE_IDS.negative,
    title: '分录金额形态合法',
    category: 'accounting_basis',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_ACCOUNTING_BASIS_51, LAW_ACCOUNTING_LAW_14],
    run: checkLineAmountShape,
  },
  {
    id: VOUCHER_RULE_IDS.duplicate,
    title: '无重复记账凭证',
    category: 'data_quality',
    severity: 'warning',
    blocking: false,
    configurable: true,
    basis: [LAW_ACCOUNTING_LAW_9, LAW_ENTERPRISE_SYSTEM_11],
    run: checkDuplicate,
  },
];
