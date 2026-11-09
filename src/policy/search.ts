/**
 * 政策检索：关键词 + 税种 + 层级 + 时间 + 生命周期 + 标签，加权打分排序。
 *
 * 为什么这样设计：
 *  1. 会计人员搜政策的真实场景是「记得大概讲什么，不记得文号」，
 *     所以字段权重必须体现「命中标题 > 命中文号 > 命中标签 > 摘要 > 要点」：
 *     标题命中几乎一定是想要的那份文件，要点命中只能说明提到了这个词。
 *  2. 中文没有空格分词，用户会一口气输入「研发费用加计扣除」，
 *     这种情况下先做整串匹配；整串没有命中时退化为 2-gram 重合度打分（降权 50%），
 *     保证「研发费用加计扣除政策」也能搜到「研发费用加计扣除」。
 *  3. 多关键词取交集（AND）：搜「增值税 小规模」的人不会想看到只讲增值税的文件。
 *     单个关键词内部才做模糊降级，这样 AND 语义不会被模糊匹配破坏。
 *  4. 时间过滤按「施行期间与查询区间有交集」判断，而不是按发文日期，
 *     因为用户问的是「2022 年这笔业务适用哪些文件」。
 */

import type { IsoDate, PolicyLifecycle, PolicyNode } from '../core/contracts.ts';
import { compactText, normalizeText } from '../core/text.ts';
import type { PolicyLibrary, PolicyRecord, PolicyTaxCode } from './library.ts';

/** 检索条件。所有字段都是「有值才过滤」。 */
export interface SearchQuery {
  text?: string;
  /** 税种过滤（任一命中即通过），支持契约外的政策库税种 */
  taxTypes?: Array<PolicyTaxCode>;
  level?: 'central' | 'local';
  /** 施行期间交集起点 */
  from?: IsoDate;
  /** 施行期间交集终点 */
  to?: IsoDate;
  lifecycle?: PolicyLifecycle[];
  /** 标签过滤（任一命中即通过） */
  tags?: string[];
  /** 返回条数上限，默认 20，最大 200 */
  limit?: number;
}

/** 一条命中结果。policy 是 PolicyRecord（PolicyNode 的子类型），带 taxCodes 便于前端直接展示税种。 */
export interface SearchHit {
  policy: PolicyRecord;
  score: number;
  /** 命中的字段中文名，如 ['标题', '摘要'] */
  matchedFields: string[];
  /** 命中位置附近的摘录，用于列表页直接展示 */
  snippet: string;
}

/** 字段权重（唯一来源）。界面据此解释「为什么这条排在前面」。 */
const FIELD_WEIGHT = {
  title: 10,
  documentNo: 8,
  tags: 5,
  summary: 3,
  keyPoints: 2,
} as const;

export const SEARCH_FIELD_WEIGHTS: ReadonlyArray<{ key: string; label: string; weight: number }> = [
  { key: 'title', label: '标题', weight: FIELD_WEIGHT.title },
  { key: 'documentNo', label: '文号', weight: FIELD_WEIGHT.documentNo },
  { key: 'tags', label: '标签', weight: FIELD_WEIGHT.tags },
  { key: 'summary', label: '摘要', weight: FIELD_WEIGHT.summary },
  { key: 'keyPoints', label: '要点', weight: FIELD_WEIGHT.keyPoints },
];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
/** 2-gram 降级打分的折扣系数：模糊命中最多只能拿到精确命中一半的分数。 */
const FUZZY_FACTOR = 0.5;

interface FieldRuntime {
  key: string;
  label: string;
  weight: number;
  read: (policy: PolicyNode) => string;
  /** 已经 compact + 小写的检索文本 */
  haystack: (policy: PolicyNode) => string;
}

const FIELDS: readonly FieldRuntime[] = [
  {
    key: 'title',
    label: '标题',
    weight: FIELD_WEIGHT.title,
    read: (policy) => policy.title,
    haystack: (policy) => compactText(policy.title).toLowerCase(),
  },
  {
    key: 'documentNo',
    label: '文号',
    weight: FIELD_WEIGHT.documentNo,
    read: (policy) => policy.documentNo,
    haystack: (policy) => compactText(policy.documentNo).toLowerCase(),
  },
  {
    key: 'tags',
    label: '标签',
    weight: FIELD_WEIGHT.tags,
    read: (policy) => policy.tags.join(' '),
    haystack: (policy) => compactText(policy.tags.join(' ')).toLowerCase(),
  },
  {
    key: 'summary',
    label: '摘要',
    weight: FIELD_WEIGHT.summary,
    read: (policy) => policy.summary,
    haystack: (policy) => compactText(policy.summary).toLowerCase(),
  },
  {
    key: 'keyPoints',
    label: '要点',
    weight: FIELD_WEIGHT.keyPoints,
    read: (policy) => policy.keyPoints.join(' '),
    haystack: (policy) => compactText(policy.keyPoints.join(' ')).toLowerCase(),
  },
];

/**
 * 把用户输入切成关键词。
 * 中文按空白与常见分隔符切分；英文与数字原样保留。
 */
export function tokenizeQuery(text: string): string[] {
  const normalized = normalizeText(text).toLowerCase();
  const parts = normalized.split(/[\s,，、;；:：|/\\+]+/);
  const tokens: string[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (token === '') continue;
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

/** 生成中文 2-gram 集合；长度小于 3 的词不做 2-gram（没有意义）。 */
function bigrams(token: string): string[] {
  if (token.length < 3) return [];
  const grams: string[] = [];
  for (let i = 0; i < token.length - 1; i += 1) {
    const gram = token.slice(i, i + 2);
    if (!grams.includes(gram)) grams.push(gram);
  }
  return grams;
}

interface TokenScore {
  score: number;
  fields: string[];
}

/**
 * 单个关键词对单个政策的打分。
 *
 * 精确命中：每个字段只要包含该词，就加上该字段的权重（可叠加多个字段）。
 * 精确未命中：退化为 2-gram 重合度，按字段权重 × 重合率 × 0.5 计分。
 */
function scoreToken(policy: PolicyNode, token: string): TokenScore {
  let exact = 0;
  const fields: string[] = [];
  for (const field of FIELDS) {
    if (field.haystack(policy).includes(token)) {
      exact += field.weight;
      fields.push(field.label);
    }
  }
  if (exact > 0) return { score: exact, fields };

  const grams = bigrams(token);
  if (grams.length === 0) return { score: 0, fields: [] };

  let fuzzy = 0;
  const fuzzyFields: string[] = [];
  for (const field of FIELDS) {
    const haystack = field.haystack(policy);
    let hit = 0;
    for (const gram of grams) {
      if (haystack.includes(gram)) hit += 1;
    }
    if (hit === 0) continue;
    const ratio = hit / grams.length;
    if (ratio < 0.5) continue; // 命中不足一半的 2-gram 视为噪声
    fuzzy += field.weight * ratio * FUZZY_FACTOR;
    if (!fuzzyFields.includes(field.label)) fuzzyFields.push(field.label);
  }
  return { score: fuzzy, fields: fuzzyFields };
}

function matchesFilters(policy: PolicyRecord, query: SearchQuery): boolean {
  if (query.level !== undefined && policy.level !== query.level) return false;

  if (query.taxTypes !== undefined && query.taxTypes.length > 0) {
    const contractTaxes: readonly string[] = policy.taxTypes;
    const hit = query.taxTypes.some(
      (taxType) => policy.taxCodes.includes(taxType) || contractTaxes.includes(taxType),
    );
    if (!hit) return false;
  }

  if (query.lifecycle !== undefined && query.lifecycle.length > 0) {
    if (!query.lifecycle.includes(policy.lifecycle)) return false;
  }

  if (query.tags !== undefined && query.tags.length > 0) {
    const wanted = query.tags.map((tag) => compactText(tag).toLowerCase());
    const owned = policy.tags.map((tag) => compactText(tag).toLowerCase());
    if (!wanted.some((tag) => owned.includes(tag))) return false;
  }

  // 施行期间与查询区间求交集
  const from = query.from;
  const to = query.to;
  if (from !== undefined && policy.effectiveTo !== undefined && policy.effectiveTo < from) return false;
  if (to !== undefined && policy.effectiveFrom > to) return false;

  return true;
}

/** 取命中位置附近的片段；找不到时回退到摘要。 */
function buildSnippet(policy: PolicyNode, tokens: readonly string[], labels: readonly string[]): string {
  const pick = FIELDS.find((field) => labels.includes(field.label));
  if (pick === undefined || tokens.length === 0) {
    const text = normalizeText(policy.summary);
    return text.length <= 60 ? text : `${text.slice(0, 59)}…`;
  }

  const raw = pick.read(policy);
  const haystack = compactText(raw).toLowerCase();
  let index = -1;
  let matchedToken = '';
  for (const token of tokens) {
    const at = haystack.indexOf(token);
    if (at !== -1) {
      index = at;
      matchedToken = token;
      break;
    }
  }
  if (index === -1) {
    const text = normalizeText(policy.summary);
    return text.length <= 60 ? text : `${text.slice(0, 59)}…`;
  }

  // compact 文本与原始文本的偏移不同，这里用原始文本再定位一次，保证截取位置正确
  const rawIndex = raw.toLowerCase().indexOf(matchedToken);
  const base = rawIndex === -1 ? 0 : rawIndex;
  const start = Math.max(0, base - 20);
  const end = Math.min(raw.length, base + matchedToken.length + 40);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < raw.length ? '…' : '';
  return `${prefix}${normalizeText(raw.slice(start, end))}${suffix}`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

/**
 * 执行检索。
 *
 * 排序规则：得分降序 → 发文日期降序（同样相关时先看新的）→ id 升序（保证稳定）。
 */
export function searchPolicies(lib: PolicyLibrary, query: SearchQuery): SearchHit[] {
  const tokens = query.text === undefined ? [] : tokenizeQuery(query.text);
  const hits: SearchHit[] = [];

  for (const record of lib.all()) {
    if (!matchesFilters(record, query)) continue;

    if (tokens.length === 0) {
      hits.push({
        policy: record,
        score: 0,
        matchedFields: [],
        snippet: buildSnippet(record, [], []),
      });
      continue;
    }

    let total = 0;
    const labels: string[] = [];
    let excluded = false;
    for (const token of tokens) {
      const tokenScore = scoreToken(record, token);
      if (tokenScore.score <= 0) {
        excluded = true;
        break;
      }
      total += tokenScore.score;
      for (const label of tokenScore.fields) {
        if (!labels.includes(label)) labels.push(label);
      }
    }
    if (excluded) continue;

    // 按权重降序输出命中字段，界面按此顺序展示徽标
    const ordered = SEARCH_FIELD_WEIGHTS
      .filter((field) => labels.includes(field.label))
      .map((field) => field.label);

    hits.push({
      policy: record,
      score: Math.round(total * 100) / 100,
      matchedFields: ordered,
      snippet: buildSnippet(record, tokens, ordered),
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.policy.issuedAt !== b.policy.issuedAt) {
      return a.policy.issuedAt < b.policy.issuedAt ? 1 : -1;
    }
    return a.policy.id < b.policy.id ? -1 : 1;
  });

  return hits.slice(0, clampLimit(query.limit));
}
