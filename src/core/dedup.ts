/**
 * 跨单据重复业务检测。
 *
 * 同一笔业务常常出现在多份文件里：
 *   - 银行流水的「代发工资」 ←→ 工资表生成的「发放工资」凭证
 *   - 银行流水的「报销付款」 ←→ 报销单生成的付款凭证
 * 如果两份文件都处理，就会重复记账（应付职工薪酬出现异常余额、费用翻倍）。
 *
 * 这里的做法是：配置里声明「哪两类单据是同一笔业务」，然后按
 * 「金额相同 + 日期相近」配对，保留其中一份、跳过另一份，并在报告里说明。
 * 配对是保守的：金额必须一致、日期必须在窗口内，否则一律不去重。
 */

import type { Cents, DocumentRecord, ProcessingIssue } from './types.ts';
import type { DedupConfig, DedupPairRule, DedupMatcher } from './config.ts';
import { formatYuan, parseAmount } from './money.ts';

const MS_PER_DAY = 86_400_000;

export interface DedupResult {
  /** 去重后保留的单据 */
  documents: DocumentRecord[];
  /** 被判定为重复而跳过的单据 */
  dropped: Array<{ document: DocumentRecord; pairedWith: DocumentRecord; ruleId: string }>;
  issues: ProcessingIssue[];
}

/** 判断单据是否匹配一个匹配器定义。 */
function matches(doc: DocumentRecord, matcher: DedupMatcher): boolean {
  if (matcher.kinds !== undefined && matcher.kinds.length > 0 && !matcher.kinds.includes(doc.kind)) {
    return false;
  }
  if (matcher.fields !== undefined) {
    for (const [key, expected] of Object.entries(matcher.fields)) {
      if (String(doc.fields[key] ?? '') !== String(expected)) return false;
    }
  }
  if (matcher.summary !== undefined && matcher.summary.length > 0) {
    const text = `${doc.summary} ${doc.source.rawSummary ?? ''}`;
    if (!matcher.summary.some((kw) => text.includes(kw))) return false;
  }
  return true;
}

/**
 * 参与金额比对的金额。
 * 优先使用 matcher.amountField 指定的字段（如工资表的 netPay），
 * 这样可以拿「实发工资」去和银行代发金额比对，而不是应发工资。
 */
function comparableAmount(doc: DocumentRecord, matcher: DedupMatcher): Cents {
  if (matcher.amountField !== undefined) {
    const raw = doc.fields[matcher.amountField];
    const parsed = parseAmount(raw);
    if (parsed !== null) return Math.abs(parsed);
  }
  return Math.abs(doc.amount);
}

/** 两个日期的天数差；任一为空则返回 null。 */
function dayDistance(a: DocumentRecord, b: DocumentRecord): number | null {
  if (a.date === null || b.date === null) return null;
  const ta = Date.parse(`${a.date}T00:00:00Z`);
  const tb = Date.parse(`${b.date}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.abs(ta - tb) / MS_PER_DAY;
}

/**
 * 执行去重。
 * 对每条配对规则，先找出所有「保留方」单据，再为每一条在「丢弃方」中
 * 寻找金额一致、日期最近的候选。
 */
export function deduplicate(
  documents: readonly DocumentRecord[],
  config: DedupConfig,
): DedupResult {
  if (!config.enabled || config.pairs.length === 0) {
    return { documents: [...documents], dropped: [], issues: [] };
  }

  const droppedIds = new Set<string>();
  const dropped: DedupResult['dropped'] = [];
  const issues: ProcessingIssue[] = [];

  for (const rule of config.pairs) {
    const primaries = documents.filter((d) => matches(d, rule.keep));
    if (primaries.length === 0) continue;

    const candidates = documents.filter(
      (d) => !droppedIds.has(d.id) && matches(d, rule.drop) && !matches(d, rule.keep),
    );
    if (candidates.length === 0) continue;

    const usedCandidates = new Set<string>();

    for (const primary of primaries) {
      const primaryAmount = comparableAmount(primary, rule.keep);
      let best: { doc: DocumentRecord; distance: number } | null = null;

      for (const candidate of candidates) {
        if (usedCandidates.has(candidate.id)) continue;
        // 金额必须一致
        const candidateAmount = comparableAmount(candidate, rule.drop);
        if (Math.abs(candidateAmount - primaryAmount) > rule.amountToleranceCents) continue;
        // 日期必须落在窗口内（任一方无日期时不做日期约束，但仍参与配对）
        const distance = dayDistance(candidate, primary);
        if (distance !== null && distance > rule.windowDays) continue;
        const effectiveDistance = distance ?? rule.windowDays;

        if (best === null || effectiveDistance < best.distance) {
          best = { doc: candidate, distance: effectiveDistance };
        }
      }

      if (best === null) continue;

      usedCandidates.add(best.doc.id);
      droppedIds.add(best.doc.id);
      dropped.push({ document: best.doc, pairedWith: primary, ruleId: rule.id });

      issues.push({
        level: 'info',
        message:
          `重复业务已去重：${rule.desc} —— 跳过「${best.doc.summary}」` +
          `（金额 ${formatYuan(comparableAmount(best.doc, rule.drop))}，${best.doc.source.file}），` +
          `保留「${primary.summary}」（${primary.source.file}）。` +
          '如判断有误，请在 config/dedup.yaml 中调整该规则，或用 --no-dedup 关闭去重。',
        source: best.doc.source,
      });
    }
  }

  return {
    documents: documents.filter((d) => !droppedIds.has(d.id)),
    dropped,
    issues,
  };
}

/** 供配置校验使用：列出配对规则的说明。 */
export function describeDedupPairs(pairs: readonly DedupPairRule[]): string[] {
  return pairs.map((p) => `${p.id}: ${p.desc}`);
}
