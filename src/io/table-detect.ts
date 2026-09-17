/**
 * 表头 → 字段 的语义映射。
 *
 * 不同银行、不同财务系统导出的表头名称千差万别：
 *   「交易金额」「发生额」「金额(元)」「借方发生额」「付款金额」
 * 都可能是同一件事。这里用「同义词词典 + 相似度打分 + 全局贪心分配」把
 * 任意表头映射到系统内部字段。
 */

import type { CellValue, RawRow, RawSheet } from '../core/types.ts';
import { bestMatch, compactText, isBlank, normalizeText } from '../core/text.ts';

export interface ColumnSpec {
  /** 内部字段名 */
  key: string;
  /** 中文说明，用于报错提示 */
  label: string;
  /** 表头同义词，按优先级排列 */
  synonyms: string[];
  /** 是否必需，缺失则整表不可用 */
  required?: boolean;
  /**
   * 是否为该类单据的特征列。
   * 「借方发生额」「销方名称」这类列只可能出现在特定单据里，
   * 命中它们能显著提高识别置信度，从而把银行流水和发票台账区分开
   * （两者都含「日期」「金额」，只靠必需列无法区分）。
   */
  distinctive?: boolean;
}

export interface ColumnMatch {
  key: string;
  label: string;
  /** 命中的列下标（0 基） */
  index: number;
  /** 命中的表头原文 */
  header: string;
  /** 匹配得分 */
  score: number;
}

export interface ColumnMapping {
  matches: Map<string, ColumnMatch>;
  /** 没有映射到任何字段的表头 */
  unmappedHeaders: string[];
  /** 缺失的必需字段 */
  missingRequired: string[];
  /** 整体置信度 0~1 */
  confidence: number;
}

/** 允许表头带单位后缀：「金额(元)」「税额/元」中的括号内容不影响匹配。 */
function stripUnitSuffix(header: string): string {
  return compactText(header)
    .replace(/[（(][^（()）]*(元|万元|人民币|rmb|cny)[^（()）]*[)）]/gi, '')
    .replace(/(金额|余额|税额|价款|发生额)(元|万元)$/i, '$1');
}

/**
 * 把表头映射到字段。
 *
 * 采用全局贪心：先把所有（字段, 表头）配对按得分排序，从高到低分配，
 * 已被占用的字段或表头不再参与，避免「金额」被同时分给三个字段。
 */
export function mapColumns(
  headers: readonly string[],
  specs: readonly ColumnSpec[],
  minScore = 0.62,
): ColumnMapping {
  const candidates: Array<{ key: string; label: string; index: number; header: string; score: number }> = [];

  for (const spec of specs) {
    for (const [index, rawHeader] of headers.entries()) {
      if (rawHeader === undefined || rawHeader.trim() === '') continue;
      const header = stripUnitSuffix(rawHeader);
      let bestScore = 0;

      // 1) 同义词全等，直接满分
      for (const syn of spec.synonyms) {
        if (header === stripUnitSuffix(syn)) {
          bestScore = 1;
          break;
        }
      }

      // 2) 相似度匹配
      if (bestScore < 1) {
        const m = bestMatch(header, spec.synonyms);
        if (m !== null) bestScore = Math.max(bestScore, m.score);
      }

      // 3) 同义词作为子串出现在表头中（如「对方账户名称」含「对方」）
      if (bestScore < 0.9) {
        for (const syn of spec.synonyms) {
          const s = stripUnitSuffix(syn);
          if (s.length >= 2 && header.includes(s)) {
            const ratio = s.length / Math.max(1, header.length);
            bestScore = Math.max(bestScore, 0.7 + ratio * 0.25);
          }
        }
      }

      if (bestScore >= minScore) {
        candidates.push({ key: spec.key, label: spec.label, index, header: rawHeader, score: bestScore });
      }
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 同分时优先靠左的列（表头顺序通常反映了重要性）
    return a.index - b.index;
  });

  const matches = new Map<string, ColumnMatch>();
  const usedColumns = new Set<number>();

  for (const c of candidates) {
    if (matches.has(c.key) || usedColumns.has(c.index)) continue;
    matches.set(c.key, c);
    usedColumns.add(c.index);
  }

  const unmappedHeaders = headers.filter((h, i) => !usedColumns.has(i) && h.trim() !== '');
  const missingRequired = specs
    .filter((s) => s.required === true && !matches.has(s.key))
    .map((s) => s.label);

  const requiredCount = specs.filter((s) => s.required === true).length;
  const requiredMatched = specs.filter((s) => s.required === true && matches.has(s.key)).length;
  const requiredRatio = requiredCount === 0 ? 1 : requiredMatched / requiredCount;

  const allSpecs = specs.length === 0 ? 1 : specs.length;
  const coverage = matches.size / allSpecs;

  // 特征列命中率：这是区分「银行流水」与「发票台账」这类
  // 共享通用列（日期/金额）的表的关键。
  const distinctiveSpecs = specs.filter((s) => s.distinctive === true);
  const distinctiveMatched = distinctiveSpecs.filter((s) => matches.has(s.key)).length;
  const distinctiveRatio = distinctiveSpecs.length === 0
    ? 0
    : Math.min(1, distinctiveMatched / Math.min(distinctiveSpecs.length, 2));

  const confidence = Math.min(
    1,
    requiredRatio * 0.55 + coverage * 0.2 + distinctiveRatio * 0.25,
  );

  return { matches, unmappedHeaders, missingRequired, confidence };
}

/** 按映射从一行里取值。 */
export function valueOf(row: RawRow, mapping: ColumnMapping, key: string): CellValue {
  const match = mapping.matches.get(key);
  if (match === undefined) return null;
  const value = row.cells[match.index];
  return value === undefined ? null : value;
}

/** 按映射取文本值。 */
export function textOf(row: RawRow, mapping: ColumnMapping, key: string): string {
  const v = valueOf(row, mapping, key);
  return isBlank(v) ? '' : normalizeText(v);
}

/** 判断工作表是否「像」某类单据。 */
export interface SheetScore {
  sheet: RawSheet;
  mapping: ColumnMapping;
  score: number;
}

export function scoreSheet(sheet: RawSheet, specs: readonly ColumnSpec[]): SheetScore {
  const mapping = mapColumns(sheet.headers, specs);
  // 表头命中率 + 数据行数加成（空表不算）
  const dataBonus = sheet.rows.length > 0 ? Math.min(0.15, sheet.rows.length / 500) : -0.3;
  const score = mapping.confidence + dataBonus;
  return { sheet, mapping, score };
}

/** 在多张工作表中挑选最符合某类单据的一张。 */
export function pickBestSheet(
  sheets: readonly RawSheet[],
  specs: readonly ColumnSpec[],
): SheetScore | null {
  let best: SheetScore | null = null;
  for (const sheet of sheets) {
    if (sheet.headers.length === 0) continue;
    const scored = scoreSheet(sheet, specs);
    if (best === null || scored.score > best.score) best = scored;
  }
  return best;
}
