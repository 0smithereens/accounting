/**
 * 提取器公共工具。
 */

import { createHash } from 'node:crypto';

import type {
  Auxiliary,
  Cents,
  Direction,
  DocumentRecord,
  Provenance,
  SourceKind,
} from '../core/types.ts';
import type { ColumnMapping } from '../io/table-detect.ts';
import type { CellValue, RawRow } from '../core/types.ts';
import { parseAmount } from '../core/money.ts';
import { isTotalRow, compactText, normalizeText } from '../core/text.ts';
import { isBlank } from '../core/text.ts';

/** 生成稳定的单据 id：同一条流水重复导入时 id 相同，便于去重。 */
export function makeDocId(parts: readonly (string | number | null | undefined)[]): string {
  const raw = parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('\u0001');
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/** 从一行里取金额，非数字返回 null。 */
export function amountOf(value: CellValue): Cents | null {
  if (isBlank(value)) return null;
  const cents = parseAmount(value);
  if (cents === null || cents === 0) return null;
  return cents;
}

/** 判断该行是否是「合计」行，需要跳过。 */
export function isSummaryRow(row: RawRow, mapping: ColumnMapping): boolean {
  const match = mapping.matches.get('summary');
  if (match !== undefined) {
    const v = row.cells[match.index];
    if (!isBlank(v) && isTotalRow(String(v))) return true;
  }
  // 任何单元格出现「合计」且该行金额列为空，也视为汇总行
  for (const cell of row.cells) {
    if (!isBlank(cell) && isTotalRow(String(cell))) return true;
  }
  return false;
}

/**
 * 解析资金方向标志。
 * 覆盖：「借/贷」「收/付」「进/出」「+/-」「D/C」「DR/CR」「转入/转出」
 */
export function parseDirectionFlag(value: CellValue): Direction | null {
  if (isBlank(value)) return null;
  const s = compactText(value).toUpperCase();
  if (s === '') return null;

  if (['借', '借方', '付', '付出', '付方', '支出', '出', '转出', '减少', 'D', 'DR', 'DEBIT', '-', '－'].includes(s)) {
    return 'out';
  }
  if (['贷', '贷方', '收', '收入', '收方', '入', '转入', '增加', 'C', 'CR', 'CREDIT', '+', '＋'].includes(s)) {
    return 'in';
  }
  // 含关键字的模糊匹配
  if (/转出|支出|付款|付出|减少|借方/.test(s)) return 'out';
  if (/转入|收入|收款|增加|贷方/.test(s)) return 'in';
  return null;
}

export interface DocBuilderInput {
  kind: SourceKind;
  file: string;
  sheet?: string;
  row?: number;
  date: string | null;
  summary: string;
  amount: Cents;
  direction: Direction;
  counterparty?: string | null;
  netAmount?: Cents | null;
  taxAmount?: Cents | null;
  fields?: Record<string, string | number | boolean | null>;
  rawSummary?: string;
  warnings?: string[];
}

export function buildDocument(input: DocBuilderInput): DocumentRecord {
  const source: Provenance = { file: input.file };
  if (input.sheet !== undefined) source.sheet = input.sheet;
  if (input.row !== undefined) source.row = input.row;
  if (input.rawSummary !== undefined) source.rawSummary = input.rawSummary;

  return {
    id: makeDocId([
      input.kind,
      input.file,
      input.sheet ?? '',
      input.row ?? '',
      input.date ?? '',
      input.summary,
      input.amount,
      input.counterparty ?? '',
    ]),
    kind: input.kind,
    date: input.date,
    summary: input.summary,
    amount: input.amount,
    direction: input.direction,
    counterparty: input.counterparty ?? null,
    netAmount: input.netAmount ?? null,
    taxAmount: input.taxAmount ?? null,
    fields: input.fields ?? {},
    source,
    warnings: input.warnings ?? [],
  };
}

/** 把辅助核算对象里的空值去掉。 */
export function cleanAuxiliary(aux: Auxiliary): Auxiliary | undefined {
  const entries = Object.entries(aux).filter(([, v]) => v !== undefined && String(v).trim() !== '');
  return entries.length > 0 ? (Object.fromEntries(entries) as Auxiliary) : undefined;
}

/** 从文本里抽「XX部」这类部门信息。 */
export function detectDepartment(text: string, known: readonly string[]): string | null {
  const s = compactText(text);
  if (s === '') return null;
  for (const dept of known) {
    const d = compactText(dept);
    if (d !== '' && s.includes(d)) return dept;
  }
  const m = /([\u4e00-\u9fa5]{2,10}(?:事业部|分公司|营业部|财务部|采购部|销售部|市场部|人事部|行政部|技术部|研发部|生产部|品质部|物流部|客服部|总经办|综合部|办公室|中心|部门|车间|科室|班组))/.exec(s);
  return m?.[1] ?? null;
}

/** 生成人类可读的摘要（去掉多余空白与重复）。 */
export function makeSummary(...parts: readonly (string | null | undefined)[]): string {
  const cleaned = parts
    .map((p) => (p === null || p === undefined ? '' : normalizeText(p)))
    .filter((p) => p !== '');
  // 去重且保持顺序
  const unique: string[] = [];
  for (const c of cleaned) {
    if (!unique.includes(c)) unique.push(c);
  }
  return unique.join(' ');
}
