/**
 * 规则引擎。
 *
 * 一条规则 = 条件（when） + 分录模板（then）。
 * 匹配过程：按优先级从高到低遍历，第一条命中的规则胜出（stop 默认 true）。
 *
 * 金额分配是这里最关键的逻辑，见 resolveAmounts 的「配平」处理。
 */

import type {
  Cents,
  DocumentRecord,
  EntryTemplate,
  Rule,
  RuleCondition,
  Side,
  VoucherLine,
} from './types.ts';
import {
  allocate,
  formatYuan,
  parseAmount,
  splitTax,
  sumCents,
} from './money.ts';
import {
  matchAllKeywords,
  matchAnyKeyword,
  normalizeText,
  safeRegex,
} from './text.ts';

export interface RuleMatchResult {
  rule: Rule;
  /** 命中的关键字/正则等，用于解释「为什么命中」 */
  reasons: string[];
}

/* ------------------------------------------------------------------ */
/* 一、条件评估                                                        */
/* ------------------------------------------------------------------ */

/** 把「元」为单位的规则阈值转成「分」比较。 */
function yuanToCents(yuan: number): Cents {
  return Math.round(yuan * 100);
}

export function evaluateCondition(
  cond: RuleCondition,
  doc: DocumentRecord,
): { matched: boolean; reasons: string[]; failed: string[] } {
  const reasons: string[] = [];
  const failed: string[] = [];

  const check = (ok: boolean, passMsg: string, failMsg: string): void => {
    if (ok) reasons.push(passMsg);
    else failed.push(failMsg);
  };

  if (cond.summary !== undefined && cond.summary.length > 0) {
    const hit = matchAnyKeyword(doc.summary, cond.summary);
    check(hit !== null, `摘要含「${hit ?? ''}」`, `摘要不含 ${cond.summary.join('/')}`);
  }

  if (cond.summaryAll !== undefined && cond.summaryAll.length > 0) {
    const ok = matchAllKeywords(doc.summary, cond.summaryAll);
    check(ok, `摘要含全部 ${cond.summaryAll.join('+')}`, `摘要缺少 ${cond.summaryAll.join('+')}`);
  }

  if (cond.summaryRegex !== undefined && cond.summaryRegex !== '') {
    const re = safeRegex(cond.summaryRegex);
    if (re === null) {
      failed.push(`摘要正则非法: ${cond.summaryRegex}`);
    } else {
      const ok = re.test(doc.summary);
      check(ok, `摘要匹配 /${cond.summaryRegex}/`, `摘要不匹配 /${cond.summaryRegex}/`);
    }
  }

  if (cond.summaryNot !== undefined && cond.summaryNot.length > 0) {
    const hit = matchAnyKeyword(doc.summary, cond.summaryNot);
    check(hit === null, '摘要未命中排除词', `摘要命中排除词「${hit ?? ''}」`);
  }

  if (cond.direction !== undefined) {
    check(
      doc.direction === cond.direction,
      `方向=${cond.direction}`,
      `方向=${doc.direction} ≠ ${cond.direction}`,
    );
  }

  if (cond.counterparty !== undefined && cond.counterparty.length > 0) {
    const cp = doc.counterparty ?? '';
    const hit = matchAnyKeyword(cp, cond.counterparty);
    check(hit !== null, `往来单位含「${hit ?? ''}」`, `往来单位(${cp || '空'})不含 ${cond.counterparty.join('/')}`);
  }

  if (cond.counterpartyRegex !== undefined && cond.counterpartyRegex !== '') {
    const re = safeRegex(cond.counterpartyRegex);
    if (re === null) {
      failed.push(`往来单位正则非法: ${cond.counterpartyRegex}`);
    } else {
      const ok = re.test(doc.counterparty ?? '');
      check(ok, '往来单位匹配正则', '往来单位不匹配正则');
    }
  }

  if (cond.amountMin !== undefined) {
    const min = yuanToCents(cond.amountMin);
    check(doc.amount >= min, `金额≥${cond.amountMin}`, `金额${formatYuan(doc.amount)}<${cond.amountMin}`);
  }

  if (cond.amountMax !== undefined) {
    const max = yuanToCents(cond.amountMax);
    check(doc.amount <= max, `金额≤${cond.amountMax}`, `金额${formatYuan(doc.amount)}>${cond.amountMax}`);
  }

  if (cond.dateFrom !== undefined && cond.dateFrom !== '') {
    const ok = doc.date !== null && doc.date >= cond.dateFrom;
    check(ok, `日期≥${cond.dateFrom}`, `日期${doc.date ?? '空'}<${cond.dateFrom}`);
  }

  if (cond.dateTo !== undefined && cond.dateTo !== '') {
    const ok = doc.date !== null && doc.date <= cond.dateTo;
    check(ok, `日期≤${cond.dateTo}`, `日期${doc.date ?? '空'}>${cond.dateTo}`);
  }

  if (cond.fields !== undefined) {
    for (const [key, expected] of Object.entries(cond.fields)) {
      const actual = doc.fields[key];
      const ok = compareField(actual, expected);
      check(ok, `字段${key}=${String(expected)}`, `字段${key}=${String(actual ?? '空')}≠${String(expected)}`);
    }
  }

  if (cond.fieldContains !== undefined) {
    for (const [key, keywords] of Object.entries(cond.fieldContains)) {
      const actual = doc.fields[key];
      const text = actual === null || actual === undefined ? '' : String(actual);
      const hit = matchAnyKeyword(text, keywords);
      check(hit !== null, `字段${key}含「${hit ?? ''}」`, `字段${key}不含 ${keywords.join('/')}`);
    }
  }

  if (cond.anyOf !== undefined && cond.anyOf.length > 0) {
    let anyOk = false;
    const subReasons: string[] = [];
    for (const sub of cond.anyOf) {
      const r = evaluateCondition(sub, doc);
      if (r.matched) {
        anyOk = true;
        subReasons.push(r.reasons.join('且'));
        break;
      }
    }
    check(anyOk, `任一子条件成立(${subReasons.join('|')})`, '所有子条件均不成立');
  }

  if (cond.allOf !== undefined && cond.allOf.length > 0) {
    let allOk = true;
    for (const sub of cond.allOf) {
      if (!evaluateCondition(sub, doc).matched) {
        allOk = false;
        break;
      }
    }
    check(allOk, '全部子条件成立', '存在不成立的子条件');
  }

  if (cond.not !== undefined) {
    const r = evaluateCondition(cond.not, doc);
    check(!r.matched, '取反条件成立', '取反条件不成立');
  }

  return { matched: failed.length === 0, reasons, failed };
}

function compareField(actual: unknown, expected: unknown): boolean {
  if (actual === null || actual === undefined) return expected === null || expected === undefined;
  if (typeof actual === 'number' && typeof expected === 'number') return actual === expected;
  if (typeof actual === 'boolean' || typeof expected === 'boolean') {
    return String(actual) === String(expected);
  }
  return normalizeText(actual) === normalizeText(expected);
}

/* ------------------------------------------------------------------ */
/* 二、模板渲染                                                        */
/* ------------------------------------------------------------------ */

/**
 * 渲染模板中的占位符。
 * 支持：{summary} {counterparty} {date} {amount} {field.xxx} {kind}
 */
export function renderTemplate(template: string, doc: DocumentRecord): string {
  return template.replace(/\{([^{}]+)\}/g, (_full, expr: string) => {
    const key = expr.trim();
    if (key === 'summary') return doc.summary;
    if (key === 'counterparty') return doc.counterparty ?? '';
    if (key === 'date') return doc.date ?? '';
    if (key === 'amount') return formatYuan(doc.amount);
    if (key === 'kind') return doc.kind;
    if (key === 'id') return doc.id;
    if (key.startsWith('field.')) {
      const v = doc.fields[key.slice('field.'.length)];
      return v === null || v === undefined ? '' : String(v);
    }
    return '';
  });
}

/* ------------------------------------------------------------------ */
/* 三、金额解析与配平                                                  */
/* ------------------------------------------------------------------ */

interface PendingLine {
  side: Side;
  accountCode: string;
  summary: string;
  amount: Cents;
  /** 是否为「差颔配平」分录 */
  balanced: boolean;
  template: EntryTemplate;
}

/**
 * 解析各分录模板的金额，并处理 balanced 配平分录。
 *
 * 配平逻辑：
 *   1. 先把所有确定金额的分录算出来，得到借方合计 D 与贷方合计 C。
 *   2. 配平分录需要补足差额：sum(balancedDebit) - sum(balancedCredit) = C - D。
 *   3. 若配平分录只在借方，则其金额 = C - D；只在贷方则为 D - C。
 *   4. 两侧都有配平分录时按均分处理（罕见场景）。
 */
export function resolveAmounts(
  entries: readonly EntryTemplate[],
  doc: DocumentRecord,
): { lines: PendingLine[]; warnings: string[] } {
  const warnings: string[] = [];
  const pending: PendingLine[] = [];

  const taxRate = readTaxRate(doc);
  const split = doc.netAmount === null && taxRate > 0
    ? splitTax(doc.amount, taxRate)
    : { net: doc.netAmount ?? doc.amount, tax: doc.taxAmount ?? 0 };

  for (const entry of entries) {
    const kind = entry.amount ?? 'total';
    let amount: Cents;
    let balanced = false;

    switch (kind) {
      case 'total':
        amount = doc.amount;
        break;
      case 'net':
        amount = split.net;
        break;
      case 'tax':
        amount = split.tax;
        break;
      case 'balanced':
        amount = 0;
        balanced = true;
        break;
      default: {
        // field.xxx：从单据专有字段取金额
        if (kind.startsWith('field.')) {
          const fieldName = kind.slice('field.'.length);
          const raw = doc.fields[fieldName];
          const cents = parseAmount(raw);
          if (cents === null) {
            warnings.push(
              `规则引用的字段 ${fieldName} 无有效金额（实际值 ${JSON.stringify(raw ?? null)}），该分录按 0 处理`,
            );
            amount = 0;
          } else {
            amount = cents;
          }
        } else {
          warnings.push(`未知的金额来源「${kind}」，已按单据总金额处理`);
          amount = doc.amount;
        }
        break;
      }
    }

    pending.push({
      side: entry.side,
      accountCode: renderTemplate(entry.account, doc),
      summary: entry.summary === undefined ? doc.summary : renderTemplate(entry.summary, doc),
      amount,
      balanced,
      template: entry,
    });
  }

  // 处理配平分录
  const balancedLines = pending.filter((l) => l.balanced);
  if (balancedLines.length > 0) {
    const debitTotal = sumCents(pending.filter((l) => !l.balanced && l.side === 'debit').map((l) => l.amount));
    const creditTotal = sumCents(pending.filter((l) => !l.balanced && l.side === 'credit').map((l) => l.amount));
    // 需要补：借方补 x，贷方补 y，满足 (debitTotal+x) = (creditTotal+y)
    const gap = creditTotal - debitTotal;

    const balancedDebit = balancedLines.filter((l) => l.side === 'debit');
    const balancedCredit = balancedLines.filter((l) => l.side === 'credit');

    if (balancedDebit.length > 0 && balancedCredit.length === 0) {
      const shares = allocate(gap, new Array<number>(balancedDebit.length).fill(1));
      balancedDebit.forEach((l, i) => {
        l.amount = shares[i] ?? 0;
      });
      if (gap < 0) {
        warnings.push(`配平分录金额为负(${formatYuan(gap)})，请检查规则模板的借贷方向`);
      }
    } else if (balancedCredit.length > 0 && balancedDebit.length === 0) {
      const shares = allocate(-gap, new Array<number>(balancedCredit.length).fill(1));
      balancedCredit.forEach((l, i) => {
        l.amount = shares[i] ?? 0;
      });
      if (gap > 0) {
        warnings.push(`配平分录金额为负(${formatYuan(-gap)})，请检查规则模板的借贷方向`);
      }
    } else {
      // 两侧都有配平分录：按「不含税/税额」的经验规则很难自动判断，提示人工处理
      warnings.push('同一规则中借贷两侧都使用了 balanced 配平，已按 0 处理，请改用明确金额来源');
      for (const l of balancedLines) l.amount = 0;
    }
  }

  return { lines: pending, warnings };
}

/**
 * 从单据字段中读取税率。
 * 支持小数（0.13）与百分数（13 或 "13%"）两种写法。
 */
export function readTaxRate(doc: DocumentRecord): number {
  const raw = doc.fields['taxRate'];
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') {
    return raw > 1 ? raw / 100 : raw;
  }
  const s = String(raw).replace('%', '').trim();
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

/* ------------------------------------------------------------------ */
/* 四、规则匹配                                                        */
/* ------------------------------------------------------------------ */

/** 按优先级排序规则（不修改原数组）。 */
export function sortRules(rules: readonly Rule[]): Rule[] {
  return rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (b.r.priority !== a.r.priority) return b.r.priority - a.r.priority;
      return a.i - b.i;
    })
    .map(({ r }) => r);
}

export interface MatchOptions {
  /** 只使用这些单据类型适用的规则 */
  kind: string;
}

/** 匹配单据，返回第一条命中的规则。 */
export function matchRule(
  rules: readonly Rule[],
  doc: DocumentRecord,
): RuleMatchResult | null {
  for (const rule of sortRules(rules)) {
    if (rule.kinds !== undefined && rule.kinds.length > 0 && !rule.kinds.includes(doc.kind)) {
      continue;
    }
    const result = evaluateCondition(rule.when, doc);
    if (result.matched) {
      return { rule, reasons: result.reasons };
    }
  }
  return null;
}

/** 诊断用：返回所有规则的评估明细，用于解释「为什么没匹配上」。 */
export function explainRules(
  rules: readonly Rule[],
  doc: DocumentRecord,
): Array<{ ruleId: string; matched: boolean; reasons: string[]; failed: string[] }> {
  return sortRules(rules)
    .filter((r) => r.kinds === undefined || r.kinds.length === 0 || r.kinds.includes(doc.kind))
    .map((r) => {
      const res = evaluateCondition(r.when, doc);
      return { ruleId: r.id, matched: res.matched, reasons: res.reasons, failed: res.failed };
    });
}

/* ------------------------------------------------------------------ */
/* 五、规则 → 凭证分录                                                 */
/* ------------------------------------------------------------------ */

export interface BuildLinesResult {
  lines: VoucherLine[];
  warnings: string[];
  reasons: string[];
}

/**
 * 把命中的规则渲染为具体的凭证分录。
 * 会计恒等式校验（借贷平衡）在 ledger/voucher.ts 中做，这里只负责生成。
 */
export function buildLinesFromRule(
  rule: Rule,
  doc: DocumentRecord,
  matchReasons: readonly string[] = [],
): BuildLinesResult {
  const { lines: pending, warnings } = resolveAmounts(rule.then.entries, doc);

  const lines: VoucherLine[] = pending.map((p) => ({
    accountCode: p.accountCode,
    accountName: '',
    debit: p.side === 'debit' ? p.amount : 0,
    credit: p.side === 'credit' ? p.amount : 0,
    summary: p.summary,
    auxiliary: renderAuxiliary(p.template, doc),
    source: {
      ...doc.source,
      ruleId: rule.id,
      rawSummary: doc.source.rawSummary ?? doc.summary,
    },
  }));

  const extraWarnings = [...warnings];
  if (rule.warn !== undefined && rule.warn !== '') extraWarnings.push(rule.warn);

  // 单条 0 金额分录是正常现象（如无票报销没有进项税额），
  // 生成凭证时会被 dropZeroLines 自动删除，不必告警。
  // 但如果整条规则算出来的分录全是 0，那就是规则配置错了。
  if (lines.length > 0 && lines.every((line) => line.debit === 0 && line.credit === 0)) {
    extraWarnings.push(
      `规则 ${rule.id} 生成的所有分录金额都是 0，请检查金额来源（amount 字段）与单据金额是否有效`,
    );
  }

  return { lines, warnings: extraWarnings, reasons: [...matchReasons] };
}

function renderAuxiliary(
  template: EntryTemplate,
  doc: DocumentRecord,
): VoucherLine['auxiliary'] {
  if (template.auxiliary === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [key, tpl] of Object.entries(template.auxiliary)) {
    if (tpl === undefined) continue;
    const value = renderTemplate(tpl, doc).trim();
    if (value !== '') result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 供外部使用：把规则里的金额字面量解析成分。 */
export function templateAmountToCents(raw: unknown): Cents | null {
  return parseAmount(raw);
}
