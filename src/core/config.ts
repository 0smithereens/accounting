/**
 * 配置加载：会计科目表 + 记账规则 + 单据布局档案。
 *
 * 所有配置都是 YAML，放在 config/ 目录，改配置不需要改代码。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import type { AccountDef, EntryTemplate, Rule, SourceKind } from './types.ts';
import { sortRules } from './rules.ts';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_DIR = join(PROJECT_ROOT, 'config');

export class ConfigError extends Error {}

/* ------------------------------------------------------------------ */
/* 通用读取                                                            */
/* ------------------------------------------------------------------ */

function readYamlFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new ConfigError(`配置文件不存在: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`YAML 解析失败 ${path}: ${(err as Error).message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${context} 必须是非空字符串，实际为 ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s === '' ? undefined : s;
}

function requireNumber(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${context} 必须是数字，实际为 ${JSON.stringify(value)}`);
  }
  return n;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ConfigError(`期望字符串数组，实际为 ${JSON.stringify(value)}`);
  }
  return value.map((v) => String(v));
}

/* ------------------------------------------------------------------ */
/* 会计科目表                                                          */
/* ------------------------------------------------------------------ */

export interface AccountTable {
  accounts: AccountDef[];
  byCode: Map<string, AccountDef>;
  /** 编码 → 完整科目名称路径，如 6602.05 → 管理费用/水电费 */
  fullName(code: string): string;
  /** 判断是否为明细科目（可挂分录） */
  isLeaf(code: string): boolean;
  get(code: string): AccountDef | undefined;
  /**
   * 把规则里写的科目解析为真正可记账的明细科目。
   * 若引用的是上级科目，则沿 defaultChild 链下钻；
   * 下钻链断裂（未配置 defaultChild）时返回原编码并把原因写进 reason。
   */
  resolve(code: string): AccountResolveResult;
}

export interface AccountResolveResult {
  /** 最终使用的科目编码 */
  code: string;
  name: string;
  /** 是否发生了下钻 */
  changed: boolean;
  /** 无法解析的原因，仅在 changed=false 且科目不可用时给出 */
  problem?: string;
}

export function loadAccounts(configDir = CONFIG_DIR): AccountTable {
  const path = join(configDir, 'chart-of-accounts.yaml');
  const doc = readYamlFile(path);

  const listRaw = isRecord(doc) && Array.isArray(doc['accounts'])
    ? (doc['accounts'] as unknown[])
    : Array.isArray(doc)
      ? doc
      : null;

  if (listRaw === null) {
    throw new ConfigError(`${path} 顶层结构应为 { accounts: [...] }`);
  }

  const accounts: AccountDef[] = [];
  const seen = new Set<string>();

  for (const [index, item] of listRaw.entries()) {
    if (!isRecord(item)) {
      throw new ConfigError(`accounts[${index}] 应为对象`);
    }
    const code = requireString(item['code'], `accounts[${index}].code`);
    if (seen.has(code)) {
      throw new ConfigError(`科目编码重复: ${code}`);
    }
    seen.add(code);

    const categoryRaw = requireString(item['category'], `${code}.category`);
    const validCategories = ['asset', 'liability', 'equity', 'cost', 'profit'];
    if (!validCategories.includes(categoryRaw)) {
      throw new ConfigError(`${code}.category 必须是 ${validCategories.join('/')}，实际为 ${categoryRaw}`);
    }

    const balanceSideRaw = optionalString(item['balanceSide']) ?? defaultBalanceSide(categoryRaw);
    if (balanceSideRaw !== 'debit' && balanceSideRaw !== 'credit') {
      throw new ConfigError(`${code}.balanceSide 必须是 debit/credit`);
    }

    const auxiliaryRaw = item['auxiliary'];
    let auxiliary: Array<keyof AccountDef['auxiliary'] & string> | undefined;
    if (auxiliaryRaw !== undefined && auxiliaryRaw !== null) {
      const arr = stringArray(auxiliaryRaw) ?? [];
      const allowed = ['department', 'customer', 'supplier', 'employee', 'project'];
      for (const dim of arr) {
        if (!allowed.includes(dim)) {
          throw new ConfigError(`${code}.auxiliary 含未知维度 ${dim}，可选 ${allowed.join('/')}`);
        }
      }
      auxiliary = arr as Array<keyof AccountDef['auxiliary'] & string>;
    }

    accounts.push({
      code,
      name: requireString(item['name'], `${code}.name`),
      category: categoryRaw as AccountDef['category'],
      balanceSide: balanceSideRaw,
      parent: optionalString(item['parent']) ?? inferParent(code),
      leaf: item['leaf'] === undefined ? true : Boolean(item['leaf']),
      defaultChild: optionalString(item['defaultChild']),
      auxiliary: auxiliary as AccountDef['auxiliary'],
      note: optionalString(item['note']),
    });
  }

  // 自动把有子科目的科目标记为非明细
  const hasChild = new Set<string>();
  for (const acc of accounts) {
    if (acc.parent !== undefined) hasChild.add(acc.parent);
  }
  for (const acc of accounts) {
    if (hasChild.has(acc.code)) acc.leaf = false;
  }

  const byCode = new Map(accounts.map((a) => [a.code, a]));

  const fullName = (code: string): string => {
    const names: string[] = [];
    let current = byCode.get(code);
    let guard = 0;
    while (current !== undefined && guard < 10) {
      names.unshift(current.name);
      current = current.parent === undefined ? undefined : byCode.get(current.parent);
      guard += 1;
    }
    return names.length > 0 ? names.join('/') : code;
  };

  const resolve = (code: string): AccountResolveResult => {
    let current = byCode.get(code);
    if (current === undefined) {
      return { code, name: code, changed: false, problem: `科目「${code}」不在科目表中` };
    }
    if (current.leaf) {
      return { code: current.code, name: fullName(current.code), changed: false };
    }

    // 沿 defaultChild 链下钻
    let guard = 0;
    const visited = new Set<string>([current.code]);
    while (!current.leaf && guard < 10) {
      const childCode = current.defaultChild;
      if (childCode === undefined) {
        return {
          code,
          name: fullName(code),
          changed: false,
          problem:
            `科目「${code} ${current.name}」还有下级科目且未配置 defaultChild，不能直接记账。` +
            `请在 config/chart-of-accounts.yaml 中为该科目设置 defaultChild（默认明细科目），或把规则改写到具体明细科目。`,
        };
      }
      const child = byCode.get(childCode);
      if (child === undefined) {
        return {
          code,
          name: fullName(code),
          changed: false,
          problem: `科目「${code}」的 defaultChild「${childCode}」不存在于科目表中`,
        };
      }
      if (visited.has(child.code)) {
        return { code, name: fullName(code), changed: false, problem: `科目「${code}」的 defaultChild 链存在循环` };
      }
      visited.add(child.code);
      current = child;
      guard += 1;
    }

    if (!current.leaf) {
      return {
        code,
        name: fullName(code),
        changed: false,
        problem: `科目「${code}」的 defaultChild 下钻层数过深，请检查配置`,
      };
    }

    return { code: current.code, name: fullName(current.code), changed: current.code !== code };
  };

  return {
    accounts,
    byCode,
    fullName,
    isLeaf: (code: string) => byCode.get(code)?.leaf ?? false,
    get: (code: string) => byCode.get(code),
    resolve,
  };
}

function defaultBalanceSide(category: string): string {
  // 资产与成本类余额在借方，负债/权益/损益（收入）在贷方
  return category === 'asset' || category === 'cost' ? 'debit' : 'credit';
}

function inferParent(code: string): string | undefined {
  const idx = code.lastIndexOf('.');
  return idx === -1 ? undefined : code.slice(0, idx);
}

/* ------------------------------------------------------------------ */
/* 记账规则                                                            */
/* ------------------------------------------------------------------ */

export interface RuleSet {
  rules: Rule[];
  /** 规则 id → 规则 */
  byId: Map<string, Rule>;
  /** 规则来源文件，用于报错定位 */
  files: string[];
}

/**
 * 加载 config/mappings/*.yaml 下的全部规则文件。
 * 每个文件的顶层结构：
 *   name: 银行流水规则
 *   rules:
 *     - id: bank-fee
 *       priority: 100
 *       when: {...}
 *       then: { entries: [...] }
 */
export function loadRules(configDir = CONFIG_DIR): RuleSet {
  const mappingsDir = join(configDir, 'mappings');
  if (!existsSync(mappingsDir)) {
    throw new ConfigError(`规则目录不存在: ${mappingsDir}`);
  }

  const files = readdirSync(mappingsDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const rules: Rule[] = [];
  const byId = new Map<string, Rule>();
  const loadedFiles: string[] = [];

  for (const file of files) {
    const path = join(mappingsDir, file);
    const doc = readYamlFile(path);
    if (!isRecord(doc)) {
      throw new ConfigError(`${file} 顶层应为对象`);
    }
    const list = doc['rules'];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new ConfigError(`${file}: rules 应为数组`);
    }

    for (const [index, item] of list.entries()) {
      const rule = parseRule(item, `${file}[${index}]`);
      if (byId.has(rule.id)) {
        throw new ConfigError(`规则 id 重复: ${rule.id}（出现在 ${file}）`);
      }
      byId.set(rule.id, rule);
      rules.push(rule);
    }
    loadedFiles.push(file);
  }

  return { rules: sortRules(rules), byId, files: loadedFiles };
}

function parseRule(item: unknown, context: string): Rule {
  if (!isRecord(item)) {
    throw new ConfigError(`${context} 应为对象`);
  }
  const id = requireString(item['id'], `${context}.id`);
  const when = item['when'];
  if (!isRecord(when)) {
    throw new ConfigError(`规则 ${id} 缺少 when 条件`);
  }
  const then = item['then'];
  if (!isRecord(then) || !Array.isArray(then['entries'])) {
    throw new ConfigError(`规则 ${id} 的 then.entries 应为数组`);
  }

  const entries = then['entries'].map((e, i) => {
    if (!isRecord(e)) throw new ConfigError(`规则 ${id} then.entries[${i}] 应为对象`);
    const sideRaw = requireString(e['side'], `规则 ${id} entries[${i}].side`);
    if (sideRaw !== 'debit' && sideRaw !== 'credit') {
      throw new ConfigError(`规则 ${id} entries[${i}].side 必须是 debit/credit，实际为 ${sideRaw}`);
    }
    const amountRaw = optionalString(e['amount']);
    const validAmounts = ['total', 'net', 'tax', 'balanced'];
    if (
      amountRaw !== undefined &&
      !validAmounts.includes(amountRaw) &&
      !amountRaw.startsWith('field.')
    ) {
      throw new ConfigError(
        `规则 ${id} entries[${i}].amount 必须是 ${validAmounts.join('/')} 或 field.<字段名>，实际为 ${amountRaw}`,
      );
    }
    const auxRaw = e['auxiliary'];
    let auxiliary: Record<string, string> | undefined;
    if (isRecord(auxRaw)) {
      auxiliary = {};
      for (const [k, v] of Object.entries(auxRaw)) {
        auxiliary[k] = String(v);
      }
    }
    return {
      side: sideRaw as EntryTemplate['side'],
      account: requireString(e['account'], `规则 ${id} entries[${i}].account`),
      amount: amountRaw as EntryTemplate['amount'],
      summary: optionalString(e['summary']),
      auxiliary: auxiliary as EntryTemplate['auxiliary'],
    };
  });

  const kinds = stringArray(item['kinds']);
  const validKinds = ['bank', 'invoice', 'expense', 'payroll', 'contract', 'unknown'];
  if (kinds !== undefined) {
    for (const k of kinds) {
      if (!validKinds.includes(k)) {
        throw new ConfigError(`规则 ${id} kinds 含未知类型 ${k}，可选 ${validKinds.join('/')}`);
      }
    }
  }

  return {
    id,
    desc: optionalString(item['desc']),
    kinds: kinds as Rule['kinds'],
    priority: item['priority'] === undefined ? 0 : requireNumber(item['priority'], `${id}.priority`),
    when: parseCondition(when, `规则 ${id}.when`),
    then: { entries },
    stop: item['stop'] === undefined ? true : Boolean(item['stop']),
    warn: optionalString(item['warn']),
  };
}

function parseCondition(raw: Record<string, unknown>, context: string): Rule['when'] {
  // 严格校验条件字段名：拼错的字段名会被静默忽略，导致条件变成「恒真」，
  // 那会让一条本应精确匹配的规则去匹配所有单据 —— 这类 bug 极难排查，所以直接报错。
  const knownKeys = new Set([
    'summary', 'summaryAll', 'summaryRegex', 'summaryNot',
    'direction', 'counterparty', 'counterpartyRegex',
    'amountMin', 'amountMax', 'dateFrom', 'dateTo',
    'fields', 'fieldContains', 'anyOf', 'allOf', 'not',
  ]);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      throw new ConfigError(
        `${context} 含未知条件字段「${key}」。可用条件：${[...knownKeys].join(' / ')}`,
      );
    }
  }

  const cond: Rule['when'] = {};

  const assignArray = (key: keyof Rule['when']): void => {
    const v = raw[key as string];
    if (v === undefined) return;
    const arr = stringArray(v);
    if (arr === undefined) throw new ConfigError(`${context}.${String(key)} 应为字符串数组`);
    (cond as Record<string, unknown>)[key as string] = arr;
  };

  assignArray('summary');
  assignArray('summaryAll');
  assignArray('summaryNot');
  assignArray('counterparty');

  const summaryRegex = optionalString(raw['summaryRegex']);
  if (summaryRegex !== undefined) cond.summaryRegex = summaryRegex;
  const counterpartyRegex = optionalString(raw['counterpartyRegex']);
  if (counterpartyRegex !== undefined) cond.counterpartyRegex = counterpartyRegex;

  const direction = optionalString(raw['direction']);
  if (direction !== undefined) {
    if (direction !== 'in' && direction !== 'out' && direction !== 'none') {
      throw new ConfigError(`${context}.direction 必须是 in/out/none`);
    }
    cond.direction = direction;
  }

  if (raw['amountMin'] !== undefined) cond.amountMin = requireNumber(raw['amountMin'], `${context}.amountMin`);
  if (raw['amountMax'] !== undefined) cond.amountMax = requireNumber(raw['amountMax'], `${context}.amountMax`);
  const dateFrom = optionalString(raw['dateFrom']);
  if (dateFrom !== undefined) cond.dateFrom = dateFrom;
  const dateTo = optionalString(raw['dateTo']);
  if (dateTo !== undefined) cond.dateTo = dateTo;

  const fields = raw['fields'];
  if (isRecord(fields)) {
    cond.fields = {};
    for (const [k, v] of Object.entries(fields)) {
      cond.fields[k] = v === null || v === undefined
        ? null
        : typeof v === 'number' || typeof v === 'boolean'
          ? v
          : String(v);
    }
  }

  const fieldContains = raw['fieldContains'];
  if (isRecord(fieldContains)) {
    cond.fieldContains = {};
    for (const [k, v] of Object.entries(fieldContains)) {
      const arr = stringArray(v);
      if (arr === undefined) throw new ConfigError(`${context}.fieldContains.${k} 应为字符串数组`);
      cond.fieldContains[k] = arr;
    }
  }

  const anyOf = raw['anyOf'];
  if (Array.isArray(anyOf)) {
    cond.anyOf = anyOf.map((c, i) => {
      if (!isRecord(c)) throw new ConfigError(`${context}.anyOf[${i}] 应为对象`);
      return parseCondition(c, `${context}.anyOf[${i}]`);
    });
  }

  const allOf = raw['allOf'];
  if (Array.isArray(allOf)) {
    cond.allOf = allOf.map((c, i) => {
      if (!isRecord(c)) throw new ConfigError(`${context}.allOf[${i}] 应为对象`);
      return parseCondition(c, `${context}.allOf[${i}]`);
    });
  }

  const notRaw = raw['not'];
  if (isRecord(notRaw)) {
    cond.not = parseCondition(notRaw, `${context}.not`);
  }

  return cond;
}

/* ------------------------------------------------------------------ */
/* 全局设置                                                            */
/* ------------------------------------------------------------------ */

export interface AppSettings {
  /** 记账本位币 */
  currency: string;
  /** 凭证字，默认「记」 */
  voucherWord: string;
  /** 生成凭证时是否按日期分组，同一日期合并为一张凭证 */
  mergeByDate: boolean;
  /** 同一日期同一规则是否合并为一张凭证的多个分录行 */
  mergeSameSummary: boolean;
  /** 单张凭证明细行上限，超过则拆分 */
  maxLinesPerVoucher: number;
  /** 是否删除金额为 0 的分录行 */
  dropZeroLines: boolean;
  /** 默认税率，未识别到税率时使用 */
  defaultTaxRate: number;
  /** 未匹配规则时的兜底科目（单边挂账，人工复核） */
  suspenseAccount: string;
  /** 已知部门列表，用于辅助核算识别 */
  departments: string[];
  /** 本企业名称列表，用于判断发票的进项/销项 */
  companyNames: string[];
  /**
   * 报销单的贷方科目。
   *  - "2241.04"（推荐）：先挂「其他应付款-员工报销款」，银行付款时再冲减。
   *    同时处理银行流水时必须用这个，否则银行存款会被记两次。
   *  - "1002"：视为报销时已直接付款。只处理报销单、不导入银行流水时用这个。
   */
  expenseCreditAccount: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  currency: 'CNY',
  voucherWord: '记',
  mergeByDate: false,
  mergeSameSummary: false,
  maxLinesPerVoucher: 100,
  dropZeroLines: true,
  defaultTaxRate: 0.06,
  suspenseAccount: '1901',
  departments: [],
  companyNames: [],
  expenseCreditAccount: '2241.04',
};

export function loadSettings(configDir = CONFIG_DIR): AppSettings {
  const path = join(configDir, 'settings.yaml');
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  const doc = readYamlFile(path);
  if (!isRecord(doc)) return { ...DEFAULT_SETTINGS };

  const settings: AppSettings = { ...DEFAULT_SETTINGS };
  const currency = optionalString(doc['currency']);
  if (currency !== undefined) settings.currency = currency;
  const voucherWord = optionalString(doc['voucherWord']);
  if (voucherWord !== undefined) settings.voucherWord = voucherWord;
  if (doc['mergeByDate'] !== undefined) settings.mergeByDate = Boolean(doc['mergeByDate']);
  if (doc['mergeSameSummary'] !== undefined) settings.mergeSameSummary = Boolean(doc['mergeSameSummary']);
  if (doc['maxLinesPerVoucher'] !== undefined) {
    settings.maxLinesPerVoucher = requireNumber(doc['maxLinesPerVoucher'], 'settings.maxLinesPerVoucher');
  }
  if (doc['dropZeroLines'] !== undefined) settings.dropZeroLines = Boolean(doc['dropZeroLines']);
  if (doc['defaultTaxRate'] !== undefined) {
    settings.defaultTaxRate = requireNumber(doc['defaultTaxRate'], 'settings.defaultTaxRate');
  }
  const suspense = optionalString(doc['suspenseAccount']);
  if (suspense !== undefined) settings.suspenseAccount = suspense;
  const departments = stringArray(doc['departments']);
  if (departments !== undefined) settings.departments = departments;
  const companyNames = stringArray(doc['companyNames']);
  if (companyNames !== undefined) settings.companyNames = companyNames;
  const expenseCreditAccount = optionalString(doc['expenseCreditAccount']);
  if (expenseCreditAccount !== undefined) settings.expenseCreditAccount = expenseCreditAccount;

  return settings;
}

/** 一次性加载全部配置。 */
export interface AppConfig {
  accounts: AccountTable;
  rules: RuleSet;
  settings: AppSettings;
  dedup: DedupConfig;
  configDir: string;
}

/* ------------------------------------------------------------------ */
/* 重复业务检测配置                                                    */
/* ------------------------------------------------------------------ */

/** 单据匹配条件。 */
export interface DedupMatcher {
  kinds?: SourceKind[];
  fields?: Record<string, string | number | boolean>;
  summary?: string[];
  /**
   * 用于金额比对的字段名。
   * 例：工资表「发放」单据的总额是应发工资(211000)，而银行代发是实发工资(150190)，
   * 此时应写 amountField: netPay，用实发工资去和银行流水比对。
   * 不写则用单据的金额字段。
   */
  amountField?: string;
}

export interface DedupPairRule {
  id: string;
  desc: string;
  /** 保留的一侧 */
  keep: DedupMatcher;
  /** 跳过的一侧 */
  drop: DedupMatcher;
  /** 日期容差（天） */
  windowDays: number;
  /** 金额容差（分） */
  amountToleranceCents: number;
}

export interface DedupConfig {
  enabled: boolean;
  pairs: DedupPairRule[];
}

const DEFAULT_DEDUP: DedupConfig = { enabled: true, pairs: [] };

function parseMatcher(raw: unknown, context: string): DedupMatcher {
  if (!isRecord(raw)) {
    throw new ConfigError(`${context} 应为对象`);
  }
  const knownKeys = new Set(['kinds', 'fields', 'summary', 'amountField']);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      throw new ConfigError(`${context} 含未知字段「${key}」，可用：${[...knownKeys].join(' / ')}`);
    }
  }

  const matcher: DedupMatcher = {};
  const kinds = stringArray(raw['kinds']);
  if (kinds !== undefined) matcher.kinds = kinds as SourceKind[];

  const amountField = optionalString(raw['amountField']);
  if (amountField !== undefined) matcher.amountField = amountField;

  const fields = raw['fields'];
  if (isRecord(fields)) {
    matcher.fields = {};
    for (const [k, v] of Object.entries(fields)) {
      matcher.fields[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
    }
  }

  const summary = stringArray(raw['summary']);
  if (summary !== undefined) matcher.summary = summary;

  if (matcher.kinds === undefined && matcher.fields === undefined && matcher.summary === undefined) {
    throw new ConfigError(`${context} 至少要指定 kinds / fields / summary 之一，否则会匹配所有单据`);
  }
  return matcher;
}

export function loadDedup(configDir = CONFIG_DIR): DedupConfig {
  const path = join(configDir, 'dedup.yaml');
  if (!existsSync(path)) return { ...DEFAULT_DEDUP };
  const doc = readYamlFile(path);
  if (!isRecord(doc)) return { ...DEFAULT_DEDUP };

  const enabled = doc['enabled'] === undefined ? true : Boolean(doc['enabled']);
  const list = doc['pairs'];
  if (!Array.isArray(list)) return { enabled, pairs: [] };

  const pairs: DedupPairRule[] = list.map((item, index) => {
    const context = `dedup.yaml pairs[${index}]`;
    if (!isRecord(item)) throw new ConfigError(`${context} 应为对象`);
    const id = requireString(item['id'], `${context}.id`);
    const keepRaw = item['keep'];
    const dropRaw = item['drop'];
    if (keepRaw === undefined || dropRaw === undefined) {
      throw new ConfigError(`${context}（${id}）必须同时提供 keep 与 drop`);
    }
    const windowDays = item['windowDays'] === undefined
      ? 7
      : requireNumber(item['windowDays'], `${context}.windowDays`);
    const toleranceYuan = item['amountTolerance'] === undefined
      ? 0
      : requireNumber(item['amountTolerance'], `${context}.amountTolerance`);

    return {
      id,
      desc: optionalString(item['desc']) ?? id,
      keep: parseMatcher(keepRaw, `${context}.keep`),
      drop: parseMatcher(dropRaw, `${context}.drop`),
      windowDays,
      amountToleranceCents: Math.round(toleranceYuan * 100),
    };
  });

  return { enabled, pairs };
}

export function loadConfig(configDir = CONFIG_DIR): AppConfig {
  return {
    accounts: loadAccounts(configDir),
    rules: loadRules(configDir),
    settings: loadSettings(configDir),
    dedup: loadDedup(configDir),
    configDir,
  };
}
