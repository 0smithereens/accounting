/**
 * 税会智链：一笔业务 → 涉及哪些税 → 申报表哪个栏次 → 税会差异 → 关联政策。
 *
 * 为什么这样设计：
 *  1. 会计人员最怕的不是「不会算」，而是「算完了不知道往哪张表哪个格子填」。
 *     所以业务事项把「税种」和「申报表栏次」绑在一起，栏次精确到 lineCode，
 *     界面可以直接给出「这笔业务要填申报表第 12 栏」的指引。
 *  2. 税会差异必须独立成条（code + label + description + policyIds），
 *     而不是写在备注里：只有独立成条，才能被「按差异反查业务」复用，
 *     也才能要求每条差异都带得出政策依据。
 *  3. taxTypes 只用契约 TaxType 的 9 个税种——这是计税引擎能算的范围。
 *     契税、关税等不在计算范围内的税种，通过 policyIds 关联到对应税法，
 *     并在差异说明里点明，避免「事项涉及契税却在税种列表里看不见」的误导。
 *  4. 关联事项按「共同税种 + 共同政策 + 共同差异」打分，而不是按分组硬编码，
 *     这样新增业务事项时不需要回来改关联逻辑。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { PolicyNode, TaxType } from '../core/contracts.ts';
import { TAX_TYPE_LABEL } from '../core/contracts.ts';
import { compactText } from '../core/text.ts';
import type { PolicyLibrary } from './library.ts';
import {
  getDefaultPolicyLibrary,
  isRecord,
  POLICY_DATA_DIR,
  readPolicyYaml,
} from './library.ts';

/* ================================================================== */
/* 一、类型                                                            */
/* ================================================================== */

/** 一项税会差异。 */
export interface TaxDifference {
  /** 全库唯一的差异编码，供「按差异反查业务」使用 */
  code: string;
  label: string;
  description: string;
  /** 该差异的依据政策 id，至少一条 */
  policyIds: string[];
}

/** 申报表栏次引用。 */
export interface ReturnLineRef {
  taxType: TaxType;
  /** 申报表名称 */
  form: string;
  /** 栏次/行次编号 */
  lineCode: string;
  /** 栏次名称 */
  lineLabel: string;
}

/** 业务事项（税会智链的锚点）。 */
export interface BusinessEvent {
  id: string;
  name: string;
  group: string;
  taxTypes: TaxType[];
  differences: TaxDifference[];
  returnLines: ReturnLineRef[];
  /** 会计处理指引（借贷方向与科目） */
  accountingGuide: string[];
  /** 事项级关联政策，与差异级政策合并后构成完整依据链 */
  policyIds: string[];
}

/** 税会智链的查询结果。 */
export interface EventChain {
  event: BusinessEvent;
  policies: PolicyNode[];
  relatedEvents: BusinessEvent[];
  /** 引用了但政策库中不存在的 id（数据维护提示，正常应为空） */
  missingPolicyIds: string[];
}

/** 业务事项分组（固定 12 组，顺序即界面展示顺序）。 */
export const BUSINESS_EVENT_GROUPS = [
  '薪酬与人力',
  '采购与资产',
  '销售与收入',
  '费用与支出',
  '补助与投资',
  '特殊与优惠',
  '资金与金融',
  '税费与附加',
  '关联与集团',
  '出口与跨境',
  '优惠与备案',
  '租赁与持有',
] as const;

export type BusinessEventGroup = (typeof BUSINESS_EVENT_GROUPS)[number];

/** 业务事项数据错误。 */
export class BusinessEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessEventError';
  }
}

const CONTRACT_TAX_TYPES = Object.keys(TAX_TYPE_LABEL) as TaxType[];

/* ================================================================== */
/* 二、读取与校验                                                      */
/* ================================================================== */

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BusinessEventError(`${context} 必须是非空字符串，实际为 ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BusinessEventError(`${context} 应为非空字符串数组，实际为 ${JSON.stringify(value)}`);
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new BusinessEventError(`${context}[${index}] 必须是非空字符串`);
    }
    result.push(item.trim());
  }
  return result;
}

function requireTaxType(value: unknown, context: string): TaxType {
  const text = requireString(value, context);
  if (!CONTRACT_TAX_TYPES.includes(text as TaxType)) {
    throw new BusinessEventError(
      `${context} 必须是契约税种之一（${CONTRACT_TAX_TYPES.join('/')}），实际为 ${text}`,
    );
  }
  return text as TaxType;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new BusinessEventError(`${context} 应为对象，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

function parseDifferences(value: unknown, context: string): TaxDifference[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BusinessEventError(`${context} 至少要有 1 项税会差异`);
  }
  return value.map((item, index) => {
    const where = `${context}[${index}]`;
    const record = requireRecord(item, where);
    const code = requireString(record['code'], `${where}.code`);
    if (!/^[a-z][a-z0-9-]*$/.test(code)) {
      throw new BusinessEventError(`${code} 只允许小写字母、数字与连字符`);
    }
    return {
      code,
      label: requireString(record['label'], `${code}.label`),
      description: requireString(record['description'], `${code}.description`),
      policyIds: requireStringArray(record['policyIds'], `${code}.policyIds`),
    };
  });
}

function parseReturnLines(value: unknown, context: string): ReturnLineRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BusinessEventError(`${context} 至少要有 1 个申报表栏次`);
  }
  return value.map((item, index) => {
    const where = `${context}[${index}]`;
    const record = requireRecord(item, where);
    return {
      taxType: requireTaxType(record['taxType'], `${where}.taxType`),
      form: requireString(record['form'], `${where}.form`),
      lineCode: requireString(record['lineCode'], `${where}.lineCode`),
      lineLabel: requireString(record['lineLabel'], `${where}.lineLabel`),
    };
  });
}

/**
 * 加载 business-events.yaml。
 *
 * 校验强度与政策库一致：宁可在加载期报错，也不要让「差异没有依据」
 * 或「栏次写成空串」这种问题出现在界面上。
 */
export function loadBusinessEvents(dataDir: string = POLICY_DATA_DIR): BusinessEvent[] {
  const path = join(dataDir, 'business-events.yaml');
  if (!existsSync(path)) {
    throw new BusinessEventError(`业务事项数据文件不存在: ${path}`);
  }
  const doc = readPolicyYaml(path, '业务事项');
  const list = Array.isArray(doc)
    ? doc
    : isRecord(doc) && Array.isArray(doc['events'])
      ? doc['events']
      : null;
  if (list === null) {
    throw new BusinessEventError(`${path} 顶层结构应为 { events: [...] }`);
  }

  const events: BusinessEvent[] = [];
  const seenIds = new Set<string>();
  const seenDifferenceCodes = new Map<string, string>();

  for (const [index, item] of list.entries()) {
    const where = `events[${index}]`;
    const record = requireRecord(item, where);
    const id = requireString(record['id'], `${where}.id`);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new BusinessEventError(`${where}.id 只允许小写字母、数字与连字符，实际为 ${id}`);
    }
    if (seenIds.has(id)) throw new BusinessEventError(`业务事项 id 重复: ${id}`);
    seenIds.add(id);

    const group = requireString(record['group'], `${id}.group`);
    if (!(BUSINESS_EVENT_GROUPS as readonly string[]).includes(group)) {
      throw new BusinessEventError(
        `${id}.group 必须是 ${BUSINESS_EVENT_GROUPS.join('/')} 之一，实际为 ${group}`,
      );
    }

    const taxTypesRaw = record['taxTypes'];
    if (!Array.isArray(taxTypesRaw) || taxTypesRaw.length === 0) {
      throw new BusinessEventError(`${id}.taxTypes 至少要有 1 个税种`);
    }
    const taxTypes = taxTypesRaw.map((value, i) => requireTaxType(value, `${id}.taxTypes[${i}]`));

    const differences = parseDifferences(record['differences'], `${id}.differences`);
    for (const difference of differences) {
      const owner = seenDifferenceCodes.get(difference.code);
      if (owner !== undefined) {
        throw new BusinessEventError(
          `差异编码 ${difference.code} 重复（${owner} 与 ${id}），按差异反查会失效`,
        );
      }
      seenDifferenceCodes.set(difference.code, id);
    }

    events.push({
      id,
      name: requireString(record['name'], `${id}.name`),
      group,
      taxTypes,
      differences,
      returnLines: parseReturnLines(record['returnLines'], `${id}.returnLines`),
      accountingGuide: requireStringArray(record['accountingGuide'], `${id}.accountingGuide`),
      policyIds: requireStringArray(record['policyIds'], `${id}.policyIds`),
    });
  }

  return events;
}

/* ================================================================== */
/* 三、查询                                                            */
/* ================================================================== */

function eventPolicyIds(event: BusinessEvent): string[] {
  const ids: string[] = [];
  for (const id of event.policyIds) {
    if (!ids.includes(id)) ids.push(id);
  }
  for (const difference of event.differences) {
    for (const id of difference.policyIds) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function relatedScore(base: BusinessEvent, other: BusinessEvent): number {
  let score = 0;
  for (const taxType of base.taxTypes) {
    if (other.taxTypes.includes(taxType)) score += 2;
  }
  const basePolicies = new Set(eventPolicyIds(base));
  for (const policyId of eventPolicyIds(other)) {
    if (basePolicies.has(policyId)) score += 1;
  }
  const baseCodes = new Set(base.differences.map((difference) => difference.code));
  for (const difference of other.differences) {
    if (baseCodes.has(difference.code)) score += 3;
  }
  if (base.group === other.group) score += 1;
  return score;
}

/**
 * 取得某个业务事项的完整智链。
 *
 * 找不到事项时抛错而不是返回空对象：调用方拿到空对象会渲染出一个空白页面，
 * 而抛错能让问题在开发期暴露。
 */
export function chainForEvent(
  events: BusinessEvent[],
  id: string,
  lib: PolicyLibrary = getDefaultPolicyLibrary(),
): EventChain {
  const event = events.find((item) => item.id === id);
  if (event === undefined) {
    throw new BusinessEventError(`业务事项不存在: ${id}`);
  }

  const policies: PolicyNode[] = [];
  const missingPolicyIds: string[] = [];
  for (const policyId of eventPolicyIds(event)) {
    const policy = lib.get(policyId);
    if (policy === undefined) {
      missingPolicyIds.push(policyId);
      continue;
    }
    policies.push(policy);
  }

  const relatedEvents = events
    .filter((item) => item.id !== event.id)
    .map((item) => ({ item, score: relatedScore(event, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.item.id < b.item.id ? -1 : 1))
    .slice(0, 6)
    .map((entry) => entry.item);

  return { event, policies, relatedEvents, missingPolicyIds };
}

/**
 * 栏次规范化：去掉「第」「栏」「行」「#」与空白，只留下比较用的核心部分。
 * 「第 1 栏」「第1栏」「1」应当被视为同一栏。
 */
export function normalizeLineCode(code: string): string {
  return compactText(code)
    .toLowerCase()
    .replace(/^第/, '')
    .replace(/(栏次|行次|栏|行)$/, '')
    .replace(/[#＃]/g, '');
}

/**
 * 按「税种 + 申报表栏次」反查业务事项。
 *
 * 这是税会智链最有用的入口：会计拿到一张申报表，
 * 想确认「第 12 栏这笔进项对应哪些业务、有没有税会差异」。
 */
export function locateByReturnLine(
  events: BusinessEvent[],
  taxType: TaxType,
  lineCode: string,
): BusinessEvent[] {
  const needle = normalizeLineCode(lineCode);
  if (needle === '') return [];
  return events.filter((event) =>
    event.returnLines.some(
      (line) => line.taxType === taxType && normalizeLineCode(line.lineCode) === needle,
    ),
  );
}

/** 按差异编码解释差异，并给出涉及该差异的业务事项名称（作为例子）。 */
export function explainTaxDifference(
  code: string,
  events: BusinessEvent[],
): { difference: TaxDifference; examples: string[] } | null {
  for (const event of events) {
    for (const difference of event.differences) {
      if (difference.code !== code) continue;
      const examples = events
        .filter((item) => item.differences.some((candidate) => candidate.code === code))
        .slice(0, 5)
        .map((item) => item.name);
      return { difference, examples };
    }
  }
  return null;
}

/** 按分组聚合业务事项，顺序固定为 BUSINESS_EVENT_GROUPS。 */
export function groupBusinessEvents(
  events: BusinessEvent[],
): Array<{ group: string; events: BusinessEvent[] }> {
  return BUSINESS_EVENT_GROUPS.map((group) => ({
    group,
    events: events.filter((event) => event.group === group),
  })).filter((bucket) => bucket.events.length > 0);
}

/** 全库税会差异清单（按编码升序），供「差异库」页面使用。 */
export function allTaxDifferences(
  events: BusinessEvent[],
): Array<{ difference: TaxDifference; taxTypes: TaxType[]; eventIds: string[] }> {
  const byCode = new Map<string, { difference: TaxDifference; taxTypes: Set<TaxType>; eventIds: string[] }>();
  for (const event of events) {
    for (const difference of event.differences) {
      const existing = byCode.get(difference.code);
      if (existing === undefined) {
        byCode.set(difference.code, {
          difference,
          taxTypes: new Set<TaxType>(event.taxTypes),
          eventIds: [event.id],
        });
      } else {
        for (const taxType of event.taxTypes) existing.taxTypes.add(taxType);
        existing.eventIds.push(event.id);
      }
    }
  }
  return [...byCode.values()]
    .sort((a, b) => (a.difference.code < b.difference.code ? -1 : 1))
    .map((entry) => ({
      difference: entry.difference,
      taxTypes: [...entry.taxTypes],
      eventIds: entry.eventIds,
    }));
}

/** 反查：某条政策被哪些业务事项引用（政策详情页「影响哪些业务」）。 */
export function chainForPolicy(events: BusinessEvent[], policyId: string): BusinessEvent[] {
  return events.filter((event) => eventPolicyIds(event).includes(policyId));
}

/**
 * 校验业务事项引用的政策 id 是否都存在于政策库。
 * 返回缺失清单，正常数据应为空数组——单测用它守住跨文件引用完整性。
 */
export function validateEventPolicyRefs(
  events: BusinessEvent[],
  lib: PolicyLibrary,
): Array<{ eventId: string; missing: string[] }> {
  const problems: Array<{ eventId: string; missing: string[] }> = [];
  for (const event of events) {
    const missing = eventPolicyIds(event).filter((id) => lib.get(id) === undefined);
    if (missing.length > 0) problems.push({ eventId: event.id, missing });
  }
  return problems;
}
