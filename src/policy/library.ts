/**
 * 政策库（Policy Library）：加载 data/policy/policies.yaml，提供索引与时点查询。
 *
 * 为什么这样设计：
 *  1. 政策是「会随时间变化的事实」，所以核心查询是时点查询
 *     （某日生效的是哪些文件），而不是只看一个 lifecycle 状态字段。
 *     所有判断都落在 [effectiveFrom, effectiveTo] 这个闭区间上。
 *  2. 契约（src/core/contracts.ts）里的 TaxType 只覆盖本系统参与计算的 9 个税种，
 *     而政策库必须覆盖 18 个税种（契税、土地增值税、关税等不参与计算但要能检索、
 *     要能做导航）。因此在契约之外定义了 PolicyTaxCode 超集，
 *     并把 9 个契约税种原样投影回去供计税引擎使用。
 *     这样既不修改只读契约，也不会让「土地增值税政策」因为映射不到 TaxType 而丢失。
 *  3. 数据文件是人工维护的 YAML，加载时必须做严格校验并给出中文定位信息：
 *     一条 id 拼错，图谱就会静默丢边，而这种错误在报表上完全看不出来。
 *  4. 所有查询返回按「生效日期倒序」或「发文日期正序」排好序的副本，
 *     调用方无法通过修改返回数组污染索引。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type {
  IsoDate,
  PolicyFamily,
  PolicyLifecycle,
  PolicyNode,
  PolicyRelation,
  TaxType,
} from '../core/contracts.ts';
import { PROJECT_ROOT } from '../core/config.ts';
import { addDays, isValidDateString } from '../core/datetime.ts';
import { normalizeText } from '../core/text.ts';

/* ================================================================== */
/* 一、税种分类：契约 TaxType 的超集                                    */
/* ================================================================== */

/**
 * 政策库使用的税种编码。
 *
 * 其中 9 个与契约 TaxType 完全一致（vat/cit/iit/surcharge/stamp/property/consumption/
 * resource/vehicle_purchase），可直接交给计税引擎；
 * 另外 10 个是政策库专有的、现行中国税制中真实存在但本系统不参与计算的税种。
 * 顺序即「税种导航」的展示顺序：流转税 → 所得税 → 财产行为税 → 特定目的税 → 关税。
 */
export const POLICY_TAX_CODES = [
  'vat',
  'consumption',
  'cit',
  'iit',
  'surcharge',
  'stamp',
  'property',
  'urban_land',
  'land_vat',
  'deed',
  'vehicle_purchase',
  'vehicle_vessel',
  'resource',
  'environmental',
  'urban_construction',
  'tariff',
  'farmland',
  'tobacco',
  'tonnage',
] as const;

export type PolicyTaxCode = (typeof POLICY_TAX_CODES)[number];

/** 编译期断言：契约税种必须被政策库税种全覆盖，否则说明有人改了 contracts.ts。 */
type AssertTrue<T extends true> = T;
export type ContractTaxTypeCovered = AssertTrue<TaxType extends PolicyTaxCode ? true : false>;

export const POLICY_TAX_CODE_LABEL: Record<PolicyTaxCode, string> = {
  vat: '增值税',
  consumption: '消费税',
  cit: '企业所得税',
  iit: '个人所得税',
  surcharge: '附加税费',
  stamp: '印花税',
  property: '房产税',
  urban_land: '城镇土地使用税',
  land_vat: '土地增值税',
  deed: '契税',
  vehicle_purchase: '车辆购置税',
  vehicle_vessel: '车船税',
  resource: '资源税',
  environmental: '环境保护税',
  urban_construction: '城市维护建设税',
  tariff: '关税',
  farmland: '耕地占用税',
  tobacco: '烟叶税',
  tonnage: '船舶吨税',
};

/**
 * 政策库税种 → 契约税种的投影。
 *
 * 城市维护建设税在本系统里并入「附加税费」一起计算（同一张申报表的附列资料），
 * 所以政策节点既要能在税种导航里按「城市维护建设税」出现，
 * 也要能被计税引擎按 surcharge 找到。
 */
const CONTRACT_TAX_PROJECTION: Partial<Record<PolicyTaxCode, TaxType>> = {
  urban_construction: 'surcharge',
};

/** 判断字符串是否为合法的政策库税种编码。 */
export function isPolicyTaxCode(value: string): value is PolicyTaxCode {
  return (POLICY_TAX_CODES as readonly string[]).includes(value);
}

/**
 * 把政策库税种编码投影为契约税种。
 * 无法投影的（如契税、关税）会被丢弃——它们不在计税引擎的计算范围内。
 */
export function toTaxTypes(codes: readonly PolicyTaxCode[]): TaxType[] {
  const result: TaxType[] = [];
  for (const code of codes) {
    // 先判断是否本身就是契约税种，再尝试投影（如城建税并入附加税费）
    const projected = isContractTaxType(code) ? code : CONTRACT_TAX_PROJECTION[code];
    if (projected !== undefined && !result.includes(projected)) result.push(projected);
  }
  return result;
}

function isContractTaxType(code: string): code is TaxType {
  return (
    code === 'vat' ||
    code === 'cit' ||
    code === 'iit' ||
    code === 'surcharge' ||
    code === 'stamp' ||
    code === 'property' ||
    code === 'consumption' ||
    code === 'resource' ||
    code === 'vehicle_purchase'
  );
}

/* ================================================================== */
/* 二、数据结构                                                        */
/* ================================================================== */

/**
 * 政策记录：契约 PolicyNode + 政策库税种全集。
 *
 * taxTypes 是 taxCodes 投影到契约税种后的结果，两个字段同时存在是有意的：
 *  - 计税引擎只认 TaxType，用 taxTypes；
 *  - 检索、导航、图谱认 19 个税种，用 taxCodes。
 */
export interface PolicyRecord extends PolicyNode {
  taxCodes: PolicyTaxCode[];
}

/**
 * 版本族记录：契约 PolicyFamily 的扩展。
 *
 * 契约只保留了 id / name / members，但数据文件里每个族还写了「这一族讲的是什么」，
 * 界面在展开版本族时需要这句话来解释「为什么这几份文件算一族」，
 * 所以在不修改契约的前提下用子类型承载。
 */
export interface PolicyFamilyRecord extends PolicyFamily {
  description?: string;
}

/** 政策库门面。所有方法返回的都是副本，外部修改不会影响索引。 */
export interface PolicyLibrary {
  all(): PolicyRecord[];
  get(id: string): PolicyRecord | undefined;
  byDocumentNo(no: string): PolicyRecord | undefined;
  byTaxType(t: TaxType | PolicyTaxCode): PolicyRecord[];
  /** 在指定日期处于生效状态的政策（考虑施行日与失效日）。 */
  effectiveAt(date: IsoDate): PolicyRecord[];
  /** 在 asOf 之后 days 天内将要施行的政策。 */
  upcoming(asOf: IsoDate, days?: number): PolicyRecord[];
  /** 在 asOf 之后 days 天内将要失效的政策。 */
  expiring(asOf: IsoDate, days?: number): PolicyRecord[];
  byLifecycle(lifecycle: PolicyLifecycle): PolicyRecord[];
  byLevel(level: 'central' | 'local'): PolicyRecord[];
  relations(): PolicyRelation[];
  families(): PolicyFamilyRecord[];
  familyOf(id: string): PolicyFamilyRecord | undefined;
  /** 数据质量问题（缺字段、引用不存在的 id 等），正常的库应为空数组。 */
  warnings(): string[];
  count(): number;
}

/** 加载失败一律抛此错误，信息里带文件路径与字段定位。 */
export class PolicyDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyDataError';
  }
}

/** 政策数据目录。 */
export const POLICY_DATA_DIR = join(PROJECT_ROOT, 'data', 'policy');

/* ================================================================== */
/* 三、YAML 读取与校验                                                 */
/* ================================================================== */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readPolicyYaml(path: string, what: string): unknown {
  if (!existsSync(path)) {
    throw new PolicyDataError(`${what}数据文件不存在: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  try {
    return parseYaml(raw);
  } catch (error) {
    throw new PolicyDataError(`${what}数据文件 YAML 解析失败 ${path}: ${(error as Error).message}`);
  }
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PolicyDataError(`${context} 必须是非空字符串，实际为 ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function requireIsoDate(value: unknown, context: string): IsoDate {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new PolicyDataError(`${context} 是非法日期`);
    }
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') {
    throw new PolicyDataError(`${context} 应为 YYYY-MM-DD 字符串，实际为 ${JSON.stringify(value)}`);
  }
  const text = value.trim();
  if (!isValidDateString(text)) {
    throw new PolicyDataError(`${context} 不是合法日期（YYYY-MM-DD），实际为 ${JSON.stringify(value)}`);
  }
  return text;
}

function requireStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new PolicyDataError(`${context} 应为字符串数组，实际为 ${JSON.stringify(value)}`);
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new PolicyDataError(`${context}[${index}] 必须是非空字符串`);
    }
    const text = item.trim();
    if (!result.includes(text)) result.push(text);
  }
  return result;
}

const LIFECYCLES: readonly PolicyLifecycle[] = ['effective', 'amended', 'superseded', 'repealed', 'draft'];

function requireLifecycle(value: unknown, context: string): PolicyLifecycle {
  const text = requireString(value, context);
  if (!(LIFECYCLES as readonly string[]).includes(text)) {
    throw new PolicyDataError(`${context} 必须是 ${LIFECYCLES.join('/')} 之一，实际为 ${text}`);
  }
  return text as PolicyLifecycle;
}

function requireTaxCodes(value: unknown, context: string): PolicyTaxCode[] {
  const raw = requireStringArray(value, context);
  const result: PolicyTaxCode[] = [];
  for (const code of raw) {
    if (!isPolicyTaxCode(code)) {
      throw new PolicyDataError(`${context} 含未知税种编码 ${code}，可选值: ${POLICY_TAX_CODES.join('/')}`);
    }
    if (!result.includes(code)) result.push(code);
  }
  return result;
}

/**
 * 文号规范化：用于「用户输入写法各异」的精确查找。
 *
 * 现实中同一个文号至少有四种写法：
 *   财税〔2016〕36号 / 财税[2016]36号 / 财税(2016)36号 / 财税 2016 36 号
 * 括号只是分隔符，不影响「是不是同一份文件」，因此这里直接把括号整类丢弃，
 * 再统一去空白、去「第」字、转小写。这样四种写法会收敛到同一个键。
 */
export function canonicalDocumentNo(input: string): string {
  let text = normalizeText(input).toLowerCase();
  text = text.replace(/[()[\]［］〔〕【】]/g, '');
  text = text.replace(/\s+/g, '');
  text = text.replace(/第(?=\d|[一二三四五六七八九十])/g, '');
  return text;
}

/* ================================================================== */
/* 四、加载：政策 / 关系 / 版本族                                       */
/* ================================================================== */

/** 读取 policies.yaml 并校验。 */
export function loadPolicies(dataDir: string = POLICY_DATA_DIR): PolicyRecord[] {
  const path = join(dataDir, 'policies.yaml');
  const doc = readPolicyYaml(path, '政策库');

  const list = Array.isArray(doc)
    ? doc
    : isRecord(doc) && Array.isArray(doc['policies'])
      ? doc['policies']
      : null;
  if (list === null) {
    throw new PolicyDataError(`${path} 顶层结构应为 { policies: [...] }`);
  }

  const records: PolicyRecord[] = [];
  for (const [index, item] of list.entries()) {
    const where = `policies[${index}]`;
    if (!isRecord(item)) {
      throw new PolicyDataError(`${where} 应为对象`);
    }
    const id = requireString(item['id'], `${where}.id`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new PolicyDataError(`${where}.id 只允许小写字母、数字与连字符，实际为 ${id}`);
    }
    const taxCodes = requireTaxCodes(item['taxCodes'], `${id}.taxCodes`);
    const level = requireString(item['level'], `${id}.level`);
    if (level !== 'central' && level !== 'local') {
      throw new PolicyDataError(`${id}.level 必须是 central / local，实际为 ${level}`);
    }

    const effectiveFrom = requireIsoDate(item['effectiveFrom'], `${id}.effectiveFrom`);
    const effectiveToRaw = item['effectiveTo'];
    const effectiveTo = effectiveToRaw === undefined || effectiveToRaw === null
      ? undefined
      : requireIsoDate(effectiveToRaw, `${id}.effectiveTo`);
    if (effectiveTo !== undefined && effectiveTo < effectiveFrom) {
      throw new PolicyDataError(`${id} 的 effectiveTo(${effectiveTo}) 早于 effectiveFrom(${effectiveFrom})`);
    }

    records.push({
      id,
      documentNo: requireString(item['documentNo'], `${id}.documentNo`),
      title: requireString(item['title'], `${id}.title`),
      issuer: requireString(item['issuer'], `${id}.issuer`),
      issuedAt: requireIsoDate(item['issuedAt'], `${id}.issuedAt`),
      effectiveFrom,
      effectiveTo,
      lifecycle: requireLifecycle(item['lifecycle'], `${id}.lifecycle`),
      taxCodes,
      taxTypes: toTaxTypes(taxCodes),
      level,
      region: optionalString(item['region']),
      summary: requireString(item['summary'], `${id}.summary`),
      keyPoints: requireStringArray(item['keyPoints'], `${id}.keyPoints`),
      url: optionalString(item['url']),
      tags: requireStringArray(item['tags'], `${id}.tags`),
    });
  }

  // id 唯一
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) {
      throw new PolicyDataError(`政策 id 重复: ${record.id}`);
    }
    seen.add(record.id);
  }
  return records;
}

/** 读取 relations.yaml（关系边）。存在性由调用方决定。 */
export function loadRelations(dataDir: string = POLICY_DATA_DIR): PolicyRelation[] {
  const path = join(dataDir, 'relations.yaml');
  const doc = readPolicyYaml(path, '政策关系');
  const list = Array.isArray(doc)
    ? doc
    : isRecord(doc) && Array.isArray(doc['relations'])
      ? doc['relations']
      : null;
  if (list === null) {
    throw new PolicyDataError(`${path} 顶层结构应为 { relations: [...] }`);
  }

  const result: PolicyRelation[] = [];
  const seen = new Set<string>();
  for (const [index, item] of list.entries()) {
    const where = `relations[${index}]`;
    if (!isRecord(item)) {
      throw new PolicyDataError(`${where} 应为对象`);
    }
    const id = requireString(item['id'], `${where}.id`);
    if (seen.has(id)) throw new PolicyDataError(`关系 id 重复: ${id}`);
    seen.add(id);

    const type = requireString(item['type'], `${id}.type`);
    const allowed: readonly string[] = ['amends', 'supersedes', 'repeals', 'based_on', 'implements', 'parallel'];
    if (!allowed.includes(type)) {
      throw new PolicyDataError(`${id}.type 必须是 ${allowed.join('/')} 之一，实际为 ${type}`);
    }
    result.push({
      id,
      from: requireString(item['from'], `${id}.from`),
      to: requireString(item['to'], `${id}.to`),
      type: type as PolicyRelation['type'],
      note: optionalString(item['note']),
    });
  }
  return result;
}

/** 读取 families.yaml（版本族）。 */
export function loadFamilies(dataDir: string = POLICY_DATA_DIR): PolicyFamilyRecord[] {
  const path = join(dataDir, 'families.yaml');
  const doc = readPolicyYaml(path, '政策版本族');
  const list = Array.isArray(doc)
    ? doc
    : isRecord(doc) && Array.isArray(doc['families'])
      ? doc['families']
      : null;
  if (list === null) {
    throw new PolicyDataError(`${path} 顶层结构应为 { families: [...] }`);
  }

  const result: PolicyFamilyRecord[] = [];
  const seen = new Set<string>();
  for (const [index, item] of list.entries()) {
    const where = `families[${index}]`;
    if (!isRecord(item)) {
      throw new PolicyDataError(`${where} 应为对象`);
    }
    const id = requireString(item['id'], `${where}.id`);
    if (seen.has(id)) throw new PolicyDataError(`版本族 id 重复: ${id}`);
    seen.add(id);
    result.push({
      id,
      name: requireString(item['name'], `${id}.name`),
      description: optionalString(item['description']),
      members: requireStringArray(item['members'], `${id}.members`),
    });
  }
  return result;
}

/* ================================================================== */
/* 五、库的构造                                                        */
/* ================================================================== */

export interface CreateLibraryInput {
  policies: PolicyRecord[];
  relations?: PolicyRelation[];
  families?: PolicyFamilyRecord[];
  warnings?: string[];
}

const LIFECYCLE_RANK: Record<PolicyLifecycle, number> = {
  effective: 0,
  amended: 1,
  superseded: 2,
  repealed: 3,
  draft: 4,
};

function compareByIssuedAsc(a: PolicyNode, b: PolicyNode): number {
  if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareByEffectiveDesc(a: PolicyNode, b: PolicyNode): number {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
  if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 用已有数据构造政策库（测试与上层编排都用它，避免重复读盘）。 */
export function createPolicyLibrary(input: CreateLibraryInput): PolicyLibrary {
  const warnings = [...(input.warnings ?? [])];
  const ordered = [...input.policies].sort(compareByIssuedAsc);

  const byId = new Map<string, PolicyRecord>();
  const byDocNo = new Map<string, PolicyRecord[]>();
  const byTitle = new Map<string, PolicyRecord>();
  const byTax = new Map<string, PolicyRecord[]>();

  for (const record of ordered) {
    if (byId.has(record.id)) {
      throw new PolicyDataError(`政策 id 重复: ${record.id}`);
    }
    byId.set(record.id, record);

    const docKey = canonicalDocumentNo(record.documentNo);
    const docBucket = byDocNo.get(docKey);
    if (docBucket === undefined) byDocNo.set(docKey, [record]);
    else docBucket.push(record);

    const titleKey = normalizeText(record.title).toLowerCase();
    if (!byTitle.has(titleKey)) byTitle.set(titleKey, record);

    for (const code of record.taxCodes) {
      const bucket = byTax.get(code);
      if (bucket === undefined) byTax.set(code, [record]);
      else bucket.push(record);
    }
  }

  // 版本族：成员必须存在，否则记警告并剔除（宁可在界面上少一个族，也不要抛错导致整库不可用）
  const familyIndex = new Map<string, PolicyFamilyRecord[]>();
  const families: PolicyFamilyRecord[] = [];
  for (const family of input.families ?? []) {
    const members = family.members.filter((memberId) => {
      if (byId.has(memberId)) return true;
      warnings.push(`版本族 ${family.id} 引用了不存在的政策 id: ${memberId}`);
      return false;
    });
    if (members.length === 0) {
      warnings.push(`版本族 ${family.id} 没有任何有效成员，已忽略`);
      continue;
    }
    const normalized: PolicyFamilyRecord = {
      id: family.id,
      name: family.name,
      description: family.description,
      members,
    };
    families.push(normalized);
    for (const memberId of members) {
      const bucket = familyIndex.get(memberId);
      if (bucket === undefined) familyIndex.set(memberId, [normalized]);
      else bucket.push(normalized);
    }
  }

  const relations = input.relations ?? [];

  const active = (record: PolicyNode, date: IsoDate): boolean => {
    if (record.lifecycle === 'draft') return false;
    if (record.effectiveFrom > date) return false;
    if (record.effectiveTo !== undefined) return record.effectiveTo >= date;
    return record.lifecycle !== 'repealed';
  };

  return {
    all: () => ordered.slice(),
    count: () => ordered.length,
    get: (id) => byId.get(id),
    byDocumentNo: (no) => {
      const bucket = byDocNo.get(canonicalDocumentNo(no));
      if (bucket !== undefined && bucket.length > 0) {
        const sorted = [...bucket].sort((a, b) => {
          const rank = LIFECYCLE_RANK[a.lifecycle] - LIFECYCLE_RANK[b.lifecycle];
          if (rank !== 0) return rank;
          return compareByIssuedAsc(b, a);
        });
        return sorted[0];
      }
      // 允许直接用政策全称查（用户往往记不住文号，只记得文件名）
      return byTitle.get(normalizeText(no).toLowerCase());
    },
    byTaxType: (taxType) => {
      const bucket = byTax.get(taxType);
      const seenIds = new Set<string>();
      const result: PolicyRecord[] = [];
      for (const record of bucket ?? []) {
        if (seenIds.has(record.id)) continue;
        seenIds.add(record.id);
        result.push(record);
      }
      // 契约税种还要把投影到它的政策找出来（如城建税法 → surcharge）
      if (isContractTaxType(taxType)) {
        for (const record of ordered) {
          if (seenIds.has(record.id)) continue;
          if (record.taxTypes.includes(taxType)) {
            seenIds.add(record.id);
            result.push(record);
          }
        }
      }
      return result.sort(compareByEffectiveDesc);
    },
    effectiveAt: (date) => ordered.filter((record) => active(record, date)).sort(compareByEffectiveDesc),
    upcoming: (asOf, days = 365) => {
      const limit = addDays(asOf, days);
      return ordered
        .filter((record) => {
          if (record.lifecycle === 'draft' || record.lifecycle === 'repealed') return false;
          if (record.effectiveFrom <= asOf) return false;
          return record.effectiveFrom <= limit;
        })
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
    },
    expiring: (asOf, days = 90) => {
      const limit = addDays(asOf, days);
      return ordered
        .filter((record) => {
          if (record.lifecycle === 'draft' || record.lifecycle === 'repealed') return false;
          if (record.effectiveTo === undefined) return false;
          return record.effectiveTo >= asOf && record.effectiveTo <= limit;
        })
        .sort((a, b) => {
          const left = a.effectiveTo ?? '';
          const right = b.effectiveTo ?? '';
          return left < right ? -1 : left > right ? 1 : 0;
        });
    },
    byLifecycle: (lifecycle) => ordered.filter((record) => record.lifecycle === lifecycle).sort(compareByEffectiveDesc),
    byLevel: (level) => ordered.filter((record) => record.level === level).sort(compareByEffectiveDesc),
    relations: () => relations.slice(),
    families: () => families.slice(),
    familyOf: (id) => {
      const bucket = familyIndex.get(id);
      return bucket !== undefined && bucket.length > 0 ? bucket[0] : undefined;
    },
    warnings: () => warnings.slice(),
  };
}

/**
 * 从数据目录加载完整政策库。
 *
 * relations.yaml / families.yaml 缺失时不会抛错（政策库本身仍可用），
 * 但会记一条警告——上层据此提示「图谱数据未部署」。
 */
export function loadPolicyLibrary(dataDir: string = POLICY_DATA_DIR): PolicyLibrary {
  const warnings: string[] = [];
  const policies = loadPolicies(dataDir);

  let relations: PolicyRelation[] = [];
  if (existsSync(join(dataDir, 'relations.yaml'))) {
    relations = loadRelations(dataDir);
  } else {
    warnings.push(`未找到 relations.yaml，政策关系图谱为空: ${dataDir}`);
  }

  let families: PolicyFamilyRecord[] = [];
  if (existsSync(join(dataDir, 'families.yaml'))) {
    families = loadFamilies(dataDir);
  } else {
    warnings.push(`未找到 families.yaml，版本族为空: ${dataDir}`);
  }

  // 文档号重复不致命但值得提醒：同一文号的两个节点会让「按文号查」结果不确定
  const docCount = new Map<string, number>();
  for (const record of policies) {
    const key = canonicalDocumentNo(record.documentNo);
    docCount.set(key, (docCount.get(key) ?? 0) + 1);
  }
  for (const [key, count] of docCount) {
    if (count > 1) warnings.push(`文号重复 ${count} 次: ${key}`);
  }

  // 逐条做「可容忍的质量问题」检查：这些问题不阻断加载，但必须让维护者看见
  for (const record of policies) {
    if (record.level === 'local' && record.region === undefined) {
      warnings.push(`地方政策 ${record.id} 未标注 region`);
    }
    if (record.lifecycle === 'repealed' && record.effectiveTo === undefined) {
      warnings.push(`政策 ${record.id} 标记为已废止但未填写 effectiveTo`);
    }
    if (record.keyPoints.length < 2) {
      warnings.push(`政策 ${record.id} 的 keyPoints 少于 2 条`);
    }
  }

  return createPolicyLibrary({ policies, relations, families, warnings });
}

/* ================================================================== */
/* 六、法规引用与合规边界                                              */
/* ================================================================== */

/**
 * 生成可用于报告的法规引用串。
 *
 * 监管要求「所有合规结论必须带法规依据（法条名称 + 条款号）」，
 * 但条款号不在政策节点里（政策是文件级对象，条款级引用由调用方按需补充），
 * 因此这里固定输出「《法规名称》（文号）」，有条款号时再拼上。
 *
 * 例：citationOf(policy) → 《中华人民共和国增值税法》（中华人民共和国主席令第四十一号）
 *     citationOf(policy, '第三十八条') → 《中华人民共和国增值税法》（…）第三十八条
 */
export function citationOf(policy: PolicyNode, article?: string): string {
  const docNo = policy.documentNo.trim();
  const base = docNo === '' ? `《${policy.title}》` : `《${policy.title}》（${docNo}）`;
  return article === undefined || article.trim() === '' ? base : `${base}${article.trim()}`;
}

/**
 * 合规边界声明。
 *
 * 政策库只负责「让人看得懂政策、追得到变化」，
 * 不产出税额结论、不生成申报数据、更不代替人工提交。
 * 界面在政策详情页必须原样展示这句话，避免用户把检索结果当成申报依据。
 */
export const POLICY_COMPLIANCE_NOTICE =
  '政策库仅提供政策检索与关联关系，不构成纳税申报意见；任何申报都必须由人工复核，并由人工在电子税务局完成提交，系统不代为提交、不保存申报回执之外的任何数据。';

/* ================================================================== */
/* 七、默认库（进程内单例）                                            */
/* ================================================================== */

let defaultLibrary: PolicyLibrary | undefined;

/**
 * 默认数据目录的政策库单例。
 *
 * 政策库是只读静态数据，每次调用都重新解析 YAML 会让「打开一个业务事项」
 * 这类交互变慢十几倍，因此缓存一份。数据文件更新后需重启进程或调用
 * resetDefaultPolicyLibrary()（系统不做热加载，避免读盘读到写了一半的文件）。
 */
export function getDefaultPolicyLibrary(): PolicyLibrary {
  if (defaultLibrary === undefined) {
    defaultLibrary = loadPolicyLibrary();
  }
  return defaultLibrary;
}

/** 清空默认库缓存（测试或数据文件重载时使用）。 */
export function resetDefaultPolicyLibrary(): void {
  defaultLibrary = undefined;
}
