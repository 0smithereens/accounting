/**
 * 报表取数映射引擎（声明式 DSL）与报表/指标配置加载。
 *
 * 为什么要有这一层：
 *  同一张报表在不同准则下的行次与项目名称不同，而每家企业的科目表又千差万别。
 *  如果把「科目 → 报表行」写死在代码里，换准则、加科目都要改程序，而且会计人员
 *  无法审阅「这一行的数字是怎么来的」。因此这里把取数规则做成 YAML 里的声明式
 *  DSL：会计可以逐行复核，程序只负责执行规则并做勾稽。
 *
 * 六种取数规则：
 *  header   分组表头，不取数
 *  accounts 按科目取数（支持下级科目、借贷方向、备抵科目、期末/期初/发生额三种口径）
 *  sum      若干行相加
 *  diff     首行减去其余各行
 *  ratio    两行相除并按小数位放大成整数
 *  skip     本准则下不列示的项目（仍检查该科目是否还有余额，有则告警）
 *
 * 金额一律以「分」为单位的整数参与运算；ratio 行通过 scale 与 decimals 放大成
 * 整数，避免浮点误差进入报表。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type {
  AccountingStandardId,
  Cents,
  LawBasis,
  LedgerBalance,
  ProcessingIssue,
  RatioGroup,
  Severity,
  StatementCheck,
  StatementKind,
} from '../core/contracts.ts';
import { CONFIG_DIR, ConfigError } from '../core/config.ts';
import { formatYuan } from '../core/money.ts';

/* ================================================================== */
/* 一、DSL 类型                                                        */
/* ================================================================== */

/** 取数方向：debit 表示借方为正（资产/成本/费用），credit 表示贷方为正（负债/权益/收入）。 */
export type RuleSign = 'debit' | 'credit';

/**
 * 取数口径：
 *  closing 期末余额（借方为正，即 debit - credit）
 *  opening 期初余额（借方为正）
 *  net     本期发生额净额（借方为正，即 debitTotal - creditTotal）
 *
 * 利润表必须用 net：期末结账把损益类科目结转到本年利润后，closing 会变成 0，
 * 用 closing 取数会得到一张全零的利润表。
 */
export type BalanceSource = 'closing' | 'opening' | 'net';

export interface HeaderRule {
  kind: 'header';
}

export interface AccountsRule {
  kind: 'accounts';
  /** 科目编码列表；默认按前缀包含下级明细科目 */
  codes: string[];
  sign: RuleSign;
  /**
   * 备抵科目（坏账准备、累计折旧、存货跌价准备等）。
   * 这类科目余额方向与主科目相反，按同口径并入后自然形成扣减。
   */
  minus: string[];
  /**
   * 需要从汇总中剔除的科目。
   * 用于「上级科目已按前缀包含了某个下级，但该下级要单列」的场景，
   * 例如管理费用 6602 已包含研发费用 6602.18，而利润表要把研发费用单列一行。
   * 与 minus 的区别：minus 是备抵（余额为负，相加即扣减），exclude 是真正的排除（相减）。
   */
  exclude: string[];
  source: BalanceSource;
  /** 是否把 codes 当作前缀、把下级明细一并汇总（默认 true） */
  includeChildren: boolean;
}

export interface SumRule {
  kind: 'sum';
  of: string[];
}

export interface DiffRule {
  kind: 'diff';
  /** of[0] - of[1] - of[2] ... */
  of: string[];
}

export interface RatioRule {
  kind: 'ratio';
  numerator: string;
  denominator: string;
  /** 放大倍数，默认 100（百分比） */
  scale: number;
  /** 小数位，金额按 10^decimals 放大成整数存储 */
  decimals: number;
}

export interface SkipRule {
  kind: 'skip';
  /** 该准则下不应出现的科目；若仍有余额则告警 */
  codes?: string[];
  reason?: string;
}

export type StatementRule =
  | HeaderRule
  | AccountsRule
  | SumRule
  | DiffRule
  | RatioRule
  | SkipRule;

/** 报表行定义。 */
export interface StatementRowDef {
  /** 行次编码，对应财政部报表格式的行次；分组行用 H1/H2 之类的占位 */
  code: string;
  /** 行键，供 sum/diff/ratio 引用；缺省等于 code */
  key: string;
  label: string;
  level: number;
  isTotal: boolean;
  /** 只参与计算、不在报表上显示的行（如「营业收入-营业成本-…」的中间值） */
  hidden: boolean;
  /** 取数说明；缺省由规则自动生成中文说明 */
  formula?: string;
  rule: StatementRule;
}

/** 勾稽校验定义。 */
export interface CheckDef {
  id: string;
  label: string;
  /** 被校验的行键 */
  actual: string;
  /** 期望值 = Σsum − Σminus；缺省表示期望为 0 */
  expected?: { sum?: string[]; minus?: string[] };
  /** 允许差额（分），默认 0 */
  tolerance?: Cents;
  detail?: string;
}

/** 编制提示（如「小企业会计准则未强制要求编制现金流量表」），以通过的勾稽项形式展示。 */
export interface StatementNoteDef {
  id: string;
  level: Severity;
  text: string;
}

/** 现金流量表项目分类定义。 */
export interface CashFlowItemDef {
  key: string;
  flow: 'operating' | 'investing' | 'financing';
  direction: 'in' | 'out';
  /** 对方科目前缀；不写表示该类别的兜底项 */
  accounts?: string[];
}

/** 现金流量表的凭证分析填列配置。 */
export interface CashFlowConfig {
  /** 现金及现金等价物科目（库存现金、银行存款、其他货币资金） */
  cashAccounts: string[];
  /** 投资活动对方科目前缀 */
  investing: string[];
  /** 筹资活动对方科目前缀 */
  financing: string[];
  items: CashFlowItemDef[];
}

export interface StatementSectionDef {
  kind: StatementKind;
  title: string;
  rows: StatementRowDef[];
  checks: CheckDef[];
  notes: StatementNoteDef[];
  cashflow?: CashFlowConfig;
}

export interface StatementFormat {
  standard: AccountingStandardId;
  title: string;
  basis: LawBasis[];
  /** 配置文件的绝对路径，写入 issue 便于追溯 */
  file: string;
  sections: Partial<Record<StatementKind, StatementSectionDef>>;
}

/* ================================================================== */
/* 二、指标与比率配置                                                  */
/* ================================================================== */

/** 指标表达式：引用其它指标、常量，或四则运算。 */
export interface MetricExpr {
  /** 引用指标（prior.xxx 表示上期值） */
  m?: string;
  /** 常量 */
  k?: number;
  /** 运算 */
  op?: 'add' | 'sub' | 'mul' | 'div' | 'avg' | 'abs' | 'neg';
  args?: MetricExpr[];
}

/** 基础指标定义：按科目取数或由其它指标推导。 */
export interface MetricDef {
  key: string;
  label: string;
  /** 展示单位：元 / % / 次 / 倍 / 天 */
  unit?: string;
  accounts?: string[];
  sign?: RuleSign;
  /** 取数口径；cashflow 表示由现金流量表的凭证分析结果注入，不在余额表中取数 */
  source?: BalanceSource | 'cashflow';
  minus?: string[];
  expr?: MetricExpr;
}

/** 评级规则。 */
export interface RatingRule {
  direction: 'higher_better' | 'lower_better' | 'range';
  /** 优秀阈值；range 方向时为区间 */
  good: number | [number, number];
  /** 关注阈值；range 方向时为区间 */
  watch: number | [number, number];
}

export interface RatioDef {
  code: string;
  name: string;
  group: RatioGroup;
  unit: string;
  /** 中文公式串，直接展示给使用者 */
  formula: string;
  expr: MetricExpr;
  benchmark?: [number, number] | null;
  rating: RatingRule;
  /** 小数位；缺省时百分比 2 位、其它 4 位 */
  precision?: number;
  /** 指标含义与关注点，写入解读文字 */
  hint?: string;
}

/** 趋势观察项。 */
export interface TrendDef {
  key: string;
  label: string;
  direction: 'higher_better' | 'lower_better';
  unit?: string;
}

/** 结构分析项。 */
export interface StructureDef {
  label: string;
  accounts: string[];
  sign?: RuleSign;
  source?: BalanceSource;
  minus?: string[];
  exclude?: string[];
}

export interface RatioConfig {
  metrics: MetricDef[];
  ratios: RatioDef[];
  trends: TrendDef[];
  structure: {
    revenue: StructureDef[];
    cost: StructureDef[];
    expense: StructureDef[];
  };
}

/* ================================================================== */
/* 三、YAML 解析工具                                                   */
/* ================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${context} 必须是非空字符串，实际为 ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function optString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s === '' ? undefined : s;
}

function asNumber(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${context} 必须是数字，实际为 ${JSON.stringify(value)}`);
  }
  return n;
}

function asStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${context} 应为字符串数组，实际为 ${JSON.stringify(value)}`);
  }
  return value.map((v, i) => asString(v, `${context}[${i}]`));
}

function asOptionalStringArray(value: unknown, context: string): string[] {
  if (value === undefined || value === null) return [];
  return asStringArray(value, context);
}

/** 读取 YAML 文档；供 analysis 等模块复用同一套错误信息。 */
export function readYamlDocument(path: string): unknown {
  if (!existsSync(path)) {
    throw new ConfigError(`配置文件不存在：${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`YAML 解析失败 ${path}: ${(err as Error).message}`);
  }
}

/* ================================================================== */
/* 四、规则解析                                                        */
/* ================================================================== */

function parseSign(value: unknown, context: string): RuleSign {
  const s = optString(value);
  if (s === undefined) return 'debit';
  if (s !== 'debit' && s !== 'credit') {
    throw new ConfigError(`${context} 必须是 debit 或 credit，实际为 ${s}`);
  }
  return s;
}

function parseSource(value: unknown, context: string): BalanceSource {
  const s = optString(value);
  if (s === undefined) return 'closing';
  if (s !== 'closing' && s !== 'opening' && s !== 'net') {
    throw new ConfigError(`${context} 必须是 closing / opening / net，实际为 ${s}`);
  }
  return s;
}

function parseRule(raw: unknown, context: string): StatementRule {
  if (!isRecord(raw)) throw new ConfigError(`${context} 应为对象`);
  const kind = asString(raw['kind'], `${context}.kind`);

  switch (kind) {
    case 'header':
      return { kind: 'header' };
    case 'accounts': {
      const codes = asStringArray(raw['codes'], `${context}.codes`);
      if (codes.length === 0) throw new ConfigError(`${context}.codes 不能为空`);
      const includeChildren = raw['includeChildren'] === undefined
        ? true
        : raw['includeChildren'] !== false;
      return {
        kind: 'accounts',
        codes,
        sign: parseSign(raw['sign'], `${context}.sign`),
        minus: asOptionalStringArray(raw['minus'], `${context}.minus`),
        exclude: asOptionalStringArray(raw['exclude'], `${context}.exclude`),
        source: parseSource(raw['source'], `${context}.source`),
        includeChildren,
      };
    }
    case 'sum': {
      // 允许空数组：表示该行在本准则下恒为 0（如「终止经营净利润」）
      const of = asStringArray(raw['of'], `${context}.of`);
      return { kind: 'sum', of };
    }
    case 'diff': {
      const of = asStringArray(raw['of'], `${context}.of`);
      if (of.length === 0) throw new ConfigError(`${context}.of 不能为空`);
      return { kind: 'diff', of };
    }
    case 'ratio': {
      const scale = raw['scale'] === undefined ? 100 : asNumber(raw['scale'], `${context}.scale`);
      const decimals = raw['decimals'] === undefined ? 2 : asNumber(raw['decimals'], `${context}.decimals`);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
        throw new ConfigError(`${context}.decimals 必须是 0~6 的整数`);
      }
      return {
        kind: 'ratio',
        numerator: asString(raw['numerator'], `${context}.numerator`),
        denominator: asString(raw['denominator'], `${context}.denominator`),
        scale,
        decimals,
      };
    }
    case 'skip': {
      const codes = raw['codes'] === undefined ? undefined : asStringArray(raw['codes'], `${context}.codes`);
      const reason = optString(raw['reason']);
      return {
        kind: 'skip',
        ...(codes === undefined ? {} : { codes }),
        ...(reason === undefined ? {} : { reason }),
      };
    }
    default:
      throw new ConfigError(
        `${context}.kind 未知规则「${kind}」，可用：header / accounts / sum / diff / ratio / skip`,
      );
  }
}

function parseRow(raw: unknown, index: number, context: string): StatementRowDef {
  if (!isRecord(raw)) throw new ConfigError(`${context}.rows[${index}] 应为对象`);
  const code = asString(raw['code'], `${context}.rows[${index}].code`);
  const key = optString(raw['key']) ?? code;
  const level = raw['level'] === undefined ? 1 : asNumber(raw['level'], `${context}.rows[${index}].level`);
  const formula = optString(raw['formula']);
  return {
    code,
    key,
    label: asString(raw['label'], `${context}.rows[${index}].label`),
    level: Math.max(0, Math.trunc(level)),
    isTotal: raw['isTotal'] === true,
    hidden: raw['hidden'] === true,
    ...(formula === undefined ? {} : { formula }),
    rule: parseRule(raw['rule'], `${context}.rows[${index}].rule`),
  };
}

function parseChecks(raw: unknown, context: string): CheckDef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigError(`${context}.checks 应为数组`);
  return raw.map((item, i) => {
    const ctx = `${context}.checks[${i}]`;
    if (!isRecord(item)) throw new ConfigError(`${ctx} 应为对象`);
    const expectedRaw = item['expected'];
    let expected: { sum?: string[]; minus?: string[] } | undefined;
    if (expectedRaw !== undefined) {
      if (!isRecord(expectedRaw)) throw new ConfigError(`${ctx}.expected 应为对象`);
      expected = {
        sum: asOptionalStringArray(expectedRaw['sum'], `${ctx}.expected.sum`),
        minus: asOptionalStringArray(expectedRaw['minus'], `${ctx}.expected.minus`),
      };
    }
    const tolerance = item['tolerance'] === undefined
      ? 0
      : asNumber(item['tolerance'], `${ctx}.tolerance`);
    const detail = optString(item['detail']);
    return {
      id: asString(item['id'], `${ctx}.id`),
      label: asString(item['label'], `${ctx}.label`),
      actual: asString(item['actual'], `${ctx}.actual`),
      ...(expected === undefined ? {} : { expected }),
      tolerance,
      ...(detail === undefined ? {} : { detail }),
    };
  });
}

function parseNotes(raw: unknown, context: string): StatementNoteDef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigError(`${context}.notes 应为数组`);
  return raw.map((item, i) => {
    const ctx = `${context}.notes[${i}]`;
    if (!isRecord(item)) throw new ConfigError(`${ctx} 应为对象`);
    const levelRaw = optString(item['level']) ?? 'info';
    if (levelRaw !== 'error' && levelRaw !== 'warning' && levelRaw !== 'info') {
      throw new ConfigError(`${ctx}.level 必须是 error / warning / info`);
    }
    return {
      id: asString(item['id'], `${ctx}.id`),
      level: levelRaw,
      text: asString(item['text'], `${ctx}.text`),
    };
  });
}

function parseCashFlow(raw: unknown, context: string): CashFlowConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new ConfigError(`${context}.cashflow 应为对象`);
  const itemsRaw = raw['items'];
  if (!Array.isArray(itemsRaw)) throw new ConfigError(`${context}.cashflow.items 应为数组`);
  const items: CashFlowItemDef[] = itemsRaw.map((item, i) => {
    const ctx = `${context}.cashflow.items[${i}]`;
    if (!isRecord(item)) throw new ConfigError(`${ctx} 应为对象`);
    const flow = asString(item['flow'], `${ctx}.flow`);
    if (flow !== 'operating' && flow !== 'investing' && flow !== 'financing') {
      throw new ConfigError(`${ctx}.flow 必须是 operating / investing / financing`);
    }
    const direction = asString(item['direction'], `${ctx}.direction`);
    if (direction !== 'in' && direction !== 'out') {
      throw new ConfigError(`${ctx}.direction 必须是 in 或 out`);
    }
    const accounts = item['accounts'] === undefined
      ? undefined
      : asStringArray(item['accounts'], `${ctx}.accounts`);
    return {
      key: asString(item['key'], `${ctx}.key`),
      flow,
      direction,
      ...(accounts === undefined ? {} : { accounts }),
    };
  });
  return {
    cashAccounts: asStringArray(raw['cashAccounts'], `${context}.cashflow.cashAccounts`),
    investing: asStringArray(raw['investing'], `${context}.cashflow.investing`),
    financing: asStringArray(raw['financing'], `${context}.cashflow.financing`),
    items,
  };
}

function parseBasis(raw: unknown, context: string): LawBasis[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigError(`${context}.basis 应为数组`);
  return raw.map((item, i) => {
    const ctx = `${context}.basis[${i}]`;
    if (!isRecord(item)) throw new ConfigError(`${ctx} 应为对象`);
    const level = optString(item['level']);
    const allowed = ['law', 'administrative-regulation', 'departmental-rule', 'normative-document', 'standard'];
    if (level !== undefined && !allowed.includes(level)) {
      throw new ConfigError(`${ctx}.level 取值非法：${level}`);
    }
    const article = optString(item['article']);
    const excerpt = optString(item['excerpt']);
    const effectiveFrom = optString(item['effectiveFrom']);
    const url = optString(item['url']);
    return {
      id: asString(item['id'], `${ctx}.id`),
      title: asString(item['title'], `${ctx}.title`),
      ...(article === undefined ? {} : { article }),
      ...(excerpt === undefined ? {} : { excerpt }),
      ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
      ...(url === undefined ? {} : { url }),
      ...(level === undefined ? {} : { level: level as LawBasis['level'] }),
    };
  });
}

/* ================================================================== */
/* 五、报表格式加载                                                    */
/* ================================================================== */

const STATEMENT_KINDS: readonly StatementKind[] = [
  'balance_sheet',
  'income_statement',
  'cash_flow',
  'equity_change',
];

const formatCache = new Map<string, StatementFormat>();

/**
 * 加载某准则的报表格式。
 *
 * 文件约定：<configDir>/report/statements-<standard>.yaml。
 * 配置错误一律抛 ConfigError（属于部署问题，必须让人看见）；
 * 而「科目表里没有某个科目」属于数据问题，由取数引擎记 issue 后按 0 列示，不抛异常。
 */
export function loadStatementFormat(
  standard: AccountingStandardId,
  configDir: string = CONFIG_DIR,
): StatementFormat {
  const file = resolve(join(configDir, 'report', `statements-${standard}.yaml`));
  const cached = formatCache.get(file);
  if (cached !== undefined) return cached;

  const doc = readYamlDocument(file);
  if (!isRecord(doc)) throw new ConfigError(`${file} 顶层应为对象`);

  const docStandard = optString(doc['standard']);
  if (docStandard !== undefined && docStandard !== standard) {
    throw new ConfigError(`${file} 声明的准则为「${docStandard}」，与文件名不符`);
  }

  const statementsRaw = doc['statements'];
  if (!isRecord(statementsRaw)) throw new ConfigError(`${file} 缺少 statements 段`);

  const sections: Partial<Record<StatementKind, StatementSectionDef>> = {};
  for (const kind of STATEMENT_KINDS) {
    const sectionRaw = statementsRaw[kind];
    if (sectionRaw === undefined || sectionRaw === null) continue;
    const context = `${file}#statements.${kind}`;
    if (!isRecord(sectionRaw)) throw new ConfigError(`${context} 应为对象`);
    const rowsRaw = sectionRaw['rows'];
    if (!Array.isArray(rowsRaw)) throw new ConfigError(`${context}.rows 应为数组`);
    const rows = rowsRaw.map((r, i) => parseRow(r, i, context));
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.key)) throw new ConfigError(`${context} 行键重复：${row.key}`);
      seen.add(row.key);
    }
    const cashflow = parseCashFlow(sectionRaw['cashflow'], context);
    sections[kind] = {
      kind,
      title: optString(sectionRaw['title']) ?? kind,
      rows,
      checks: parseChecks(sectionRaw['checks'], context),
      notes: parseNotes(sectionRaw['notes'], context),
      ...(cashflow === undefined ? {} : { cashflow }),
    };
  }

  if (sections.balance_sheet === undefined || sections.income_statement === undefined) {
    throw new ConfigError(`${file} 至少必须定义 balance_sheet 与 income_statement 两张报表`);
  }

  const format: StatementFormat = {
    standard,
    title: optString(doc['title']) ?? `${standard} 财务报表`,
    basis: parseBasis(doc['basis'], file),
    file,
    sections,
  };
  formatCache.set(file, format);
  return format;
}

/** 清空配置缓存（测试用，避免不同 configDir 之间串数据）。 */
export function clearReportConfigCache(): void {
  formatCache.clear();
  ratioCache.clear();
}

/* ================================================================== */
/* 六、科目余额索引与取数                                              */
/* ================================================================== */

/** 科目余额索引：把余额表变成可按科目/前缀查询的对象。 */
export interface BalanceIndex {
  readonly balances: readonly LedgerBalance[];
  /** 科目是否存在于余额表 */
  has(code: string): boolean;
  /** 一组科目中是否至少有一个存在 */
  hasAny(codes: readonly string[]): boolean;
  /** 取一组科目的金额（借方为正） */
  value(codes: readonly string[], source: BalanceSource, includeChildren: boolean): { amount: Cents; matched: boolean };
}

function rawAmount(balance: LedgerBalance, source: BalanceSource): Cents {
  if (source === 'opening') return balance.opening;
  if (source === 'net') return balance.debitTotal - balance.creditTotal;
  return balance.closing;
}

/**
 * 建立科目余额索引。
 *
 * 取数时优先使用下级明细科目：如果某个上级科目既有下级明细、自身又有余额行，
 * 只按明细汇总，避免「上级汇总行 + 明细行」被重复相加（这是余额表最常见的坑）。
 */
export function createBalanceIndex(balances: readonly LedgerBalance[]): BalanceIndex {
  const byCode = new Map<string, LedgerBalance>();
  for (const b of balances) {
    if (!byCode.has(b.accountCode)) byCode.set(b.accountCode, b);
  }
  const allCodes = [...byCode.keys()];

  const matchOne = (code: string, includeChildren: boolean): LedgerBalance[] => {
    if (includeChildren) {
      const prefix = `${code}.`;
      const children: LedgerBalance[] = [];
      for (const c of allCodes) {
        if (c.startsWith(prefix)) {
          const row = byCode.get(c);
          if (row !== undefined) children.push(row);
        }
      }
      if (children.length > 0) return children;
    }
    const exact = byCode.get(code);
    return exact === undefined ? [] : [exact];
  };

  return {
    balances,
    has: (code: string) => byCode.has(code),
    hasAny: (codes: readonly string[]) => codes.some((c) => byCode.has(c)),
    value: (codes, source, includeChildren) => {
      const seen = new Set<string>();
      let amount = 0;
      let matched = false;
      for (const code of codes) {
        for (const row of matchOne(code, includeChildren)) {
          if (seen.has(row.accountCode)) continue;
          seen.add(row.accountCode);
          amount += rawAmount(row, source);
          matched = true;
        }
      }
      return { amount, matched };
    },
  };
}

/**
 * 按科目取数：Σ(主科目) − Σ(备抵科目)。
 *
 * 备抵科目（坏账准备 1231、累计折旧 1602、存货跌价准备 1471…）的余额方向与主科目
 * 相反，期末余额本身就是负数，按同一符号口径并入后自然形成扣减。
 * 之所以单独用 minus 列出，是为了让复核人一眼看出这是抵减项，而不是漏配科目。
 */
export function sumAccounts(
  index: BalanceIndex,
  codes: readonly string[],
  sign: RuleSign,
  minus: readonly string[],
  source: BalanceSource,
  includeChildren: boolean,
  exclude: readonly string[] = [],
): { amount: Cents; matched: boolean } {
  let amount = 0;
  let matched = false;

  const apply = (list: readonly string[], factor: 1 | -1): void => {
    for (const code of list) {
      const r = index.value([code], source, includeChildren);
      if (!r.matched) continue;
      matched = true;
      const signed = sign === 'debit' ? r.amount : -r.amount;
      amount += factor * signed;
    }
  };

  apply(codes, 1);
  // 备抵科目与主科目同口径并入：其余额本身为负，相加即扣减
  apply(minus, 1);
  // 剔除已包含在下级汇总里的科目：真正相减
  apply(exclude, -1);
  return { amount, matched };
}

/* ================================================================== */
/* 七、取数引擎                                                        */
/* ================================================================== */

export interface EvaluateOptions {
  balances: BalanceIndex;
  /** 由上层注入的外部数值（现金流量表项目、利润表净利润等） */
  external?: ReadonlyMap<string, Cents>;
  /** 配置文件路径，写入 issue 的溯源字段 */
  sourceFile: string;
}

export interface EvaluatedRow {
  def: StatementRowDef;
  amount: Cents | null;
}

export interface SkippedRow {
  key: string;
  label: string;
  reason: string;
  amount: Cents;
}

export interface EvaluateResult {
  rows: EvaluatedRow[];
  values: Map<string, Cents | null>;
  issues: ProcessingIssue[];
  /** 本期账簿中完全没有对应科目的行（按 0 列示） */
  missingRows: string[];
  /** 因准则差异被跳过、但账簿里仍有余额的行 */
  skippedRows: SkippedRow[];
}

/** 生成中文取数说明，让复核人不必读代码就知道这一行怎么来的。 */
export function describeRule(rule: StatementRule, labelOf: (key: string) => string): string {
  switch (rule.kind) {
    case 'accounts': {
      const parts = rule.codes.join(' + ');
      const minus = rule.minus.length === 0 ? '' : ` − ${rule.minus.join(' − ')}`;
      const exclude = rule.exclude.length === 0 ? '' : `（不含 ${rule.exclude.join('、')}）`;
      const sourceText = rule.source === 'opening'
        ? '期初余额'
        : rule.source === 'net'
          ? '本期发生额'
          : '期末余额';
      const signText = rule.sign === 'debit' ? '借方为正' : '贷方为正';
      return `科目 ${parts}${minus}（${sourceText}，${signText}）${exclude}`;
    }
    case 'sum':
      return `= ${rule.of.map(labelOf).join(' + ')}`;
    case 'diff': {
      const first = rule.of[0] ?? '';
      return `= ${labelOf(first)}${rule.of.slice(1).map((k) => ` − ${labelOf(k)}`).join('')}`;
    }
    case 'ratio':
      return `= ${labelOf(rule.numerator)} ÷ ${labelOf(rule.denominator)} × ${rule.scale}`;
    case 'header':
      return '';
    case 'skip':
      return rule.reason ?? '本准则下不列示';
  }
}

/**
 * 执行一张报表的取数。
 *
 * 依赖按需惰性求值：sum/diff/ratio 可以引用排在后面的行，循环引用会被检出并记 error。
 */
export function evaluateSection(
  section: StatementSectionDef,
  options: EvaluateOptions,
): EvaluateResult {
  const byKey = new Map<string, StatementRowDef>();
  for (const row of section.rows) byKey.set(row.key, row);

  const external = options.external ?? new Map<string, Cents>();
  const values = new Map<string, Cents | null>();
  const resolving = new Set<string>();
  const issues: ProcessingIssue[] = [];
  const missingRows: string[] = [];
  const skippedRows: SkippedRow[] = [];

  const report = (level: Severity, message: string, ruleId: string): void => {
    issues.push({ level, message, source: { file: options.sourceFile, ruleId } });
  };

  const resolveKey = (key: string, context: string): Cents | null => {
    if (values.has(key)) return values.get(key) ?? null;

    const row = byKey.get(key);
    if (row === undefined) {
      const ext = external.get(key);
      if (ext !== undefined) return ext;
      report('error', `报表行「${context}」引用了不存在的行键「${key}」`, context);
      return null;
    }

    if (resolving.has(key)) {
      report('error', `报表行「${row.label}」存在循环引用，已按 0 处理`, key);
      return null;
    }
    resolving.add(key);
    const value = evalRule(row);
    resolving.delete(key);
    values.set(key, value);
    return value;
  };

  const evalRule = (row: StatementRowDef): Cents | null => {
    const rule = row.rule;
    switch (rule.kind) {
      case 'header':
        return null;

      case 'skip': {
        if (rule.codes !== undefined && rule.codes.length > 0) {
          const probe = sumAccounts(options.balances, rule.codes, 'debit', [], 'closing', true);
          if (probe.amount !== 0) {
            skippedRows.push({
              key: row.key,
              label: row.label,
              reason: rule.reason ?? '该准则下不列示此项目',
              amount: probe.amount,
            });
          }
        }
        return null;
      }

      case 'accounts': {
        const r = sumAccounts(
          options.balances,
          rule.codes,
          rule.sign,
          rule.minus,
          rule.source,
          rule.includeChildren,
          rule.exclude,
        );
        if (!r.matched) missingRows.push(row.label);
        return r.amount;
      }

      case 'sum': {
        let total = 0;
        for (const key of rule.of) total += resolveKey(key, row.key) ?? 0;
        return total;
      }

      case 'diff': {
        const first = rule.of[0];
        let total = first === undefined ? 0 : resolveKey(first, row.key) ?? 0;
        for (const key of rule.of.slice(1)) total -= resolveKey(key, row.key) ?? 0;
        return total;
      }

      case 'ratio': {
        const numerator = resolveKey(rule.numerator, row.key);
        const denominator = resolveKey(rule.denominator, row.key);
        if (numerator === null || denominator === null) return null;
        if (denominator === 0) {
          report('info', `报表行「${row.label}」的分母为 0，该行按空值列示`, row.key);
          return null;
        }
        const factor = 10 ** rule.decimals;
        return Math.round((numerator / denominator) * rule.scale * factor);
      }
    }
  };

  // 先求值所有行（含隐藏行），再按显示顺序输出
  for (const row of section.rows) resolveKey(row.key, row.key);

  const rows: EvaluatedRow[] = [];
  for (const row of section.rows) {
    if (row.hidden) continue;
    // skip 行只用于「本准则不应出现该科目」的检查，不进入报表
    if (row.rule.kind === 'skip') continue;
    rows.push({ def: row, amount: values.get(row.key) ?? null });
  }

  if (missingRows.length > 0) {
    const unique = [...new Set(missingRows)];
    report(
      'info',
      `「${section.title}」中有 ${unique.length} 个项目在本期账簿中无对应科目余额，已按 0 列示：${unique.join('、')}`,
      section.kind,
    );
  }

  for (const skipped of skippedRows) {
    report(
      'warning',
      `${skipped.reason}，但科目余额表中仍有 ${formatYuan(skipped.amount)} 元余额（${skipped.label}），` +
        '请检查科目设置或准则选择是否恰当',
      skipped.key,
    );
  }

  return { rows, values, issues, missingRows: [...new Set(missingRows)], skippedRows };
}

/* ================================================================== */
/* 八、勾稽校验                                                        */
/* ================================================================== */

function resolveValue(
  key: string,
  values: ReadonlyMap<string, Cents | null>,
  external: ReadonlyMap<string, Cents>,
): Cents | null {
  if (values.has(key)) return values.get(key) ?? null;
  const ext = external.get(key);
  return ext === undefined ? null : ext;
}

/**
 * 执行勾稽校验。
 *
 * 勾稽不通过不是「程序错误」，而是账簿或配置有问题的信号：这里只如实报告差额，
 * 不擅自调平——报表被人为调平比报表不平更危险。
 */
export function runChecks(
  defs: readonly CheckDef[],
  values: ReadonlyMap<string, Cents | null>,
  external: ReadonlyMap<string, Cents>,
  sourceFile: string,
): { checks: StatementCheck[]; issues: ProcessingIssue[] } {
  const checks: StatementCheck[] = [];
  const issues: ProcessingIssue[] = [];

  for (const def of defs) {
    const actual = resolveValue(def.actual, values, external);
    if (actual === null) {
      issues.push({
        level: 'warning',
        message: `勾稽校验「${def.label}」引用的行「${def.actual}」没有数值，已按 0 处理`,
        source: { file: sourceFile, ruleId: def.id },
      });
    }

    let expected = 0;
    for (const key of def.expected?.sum ?? []) {
      const v = resolveValue(key, values, external);
      if (v === null) {
        issues.push({
          level: 'warning',
          message: `勾稽校验「${def.label}」引用的行「${key}」没有数值，已按 0 处理`,
          source: { file: sourceFile, ruleId: def.id },
        });
      }
      expected += v ?? 0;
    }
    for (const key of def.expected?.minus ?? []) {
      const v = resolveValue(key, values, external);
      expected -= v ?? 0;
    }

    const actualValue = actual ?? 0;
    const diff = actualValue - expected;
    const tolerance = def.tolerance ?? 0;
    const passed = Math.abs(diff) <= tolerance;

    checks.push({
      id: def.id,
      label: def.label,
      diff,
      passed,
      detail: def.detail ??
        (passed
          ? `实际 ${formatYuan(actualValue)} 元，期望 ${formatYuan(expected)} 元，勾稽相符`
          : `实际 ${formatYuan(actualValue)} 元，期望 ${formatYuan(expected)} 元，差额 ${formatYuan(diff)} 元`),
    });
  }

  return { checks, issues };
}

/** 编制提示转成勾稽项：passed=true 表示「这是一条说明，不是差异」。 */
export function notesToChecks(notes: readonly StatementNoteDef[]): StatementCheck[] {
  return notes.map((n) => ({
    id: n.id,
    label: n.level === 'info' ? '编制提示' : '编制提醒',
    diff: 0,
    passed: true,
    detail: n.text,
  }));
}

/* ================================================================== */
/* 九、指标与比率配置加载                                              */
/* ================================================================== */

const RATIO_GROUPS: readonly RatioGroup[] = [
  'solvency',
  'operation',
  'profitability',
  'growth',
  'cashflow',
  'quality',
];

function parseGroup(value: unknown, context: string): RatioGroup {
  const s = asString(value, context);
  if (!RATIO_GROUPS.includes(s as RatioGroup)) {
    throw new ConfigError(`${context} 必须是 ${RATIO_GROUPS.join(' / ')}，实际为 ${s}`);
  }
  return s as RatioGroup;
}

function parseExpr(raw: unknown, context: string): MetricExpr {
  if (!isRecord(raw)) throw new ConfigError(`${context} 应为对象`);
  const m = optString(raw['m']);
  if (m !== undefined) return { m };
  if (raw['k'] !== undefined) return { k: asNumber(raw['k'], `${context}.k`) };
  const op = asString(raw['op'], `${context}.op`);
  const allowed = ['add', 'sub', 'mul', 'div', 'avg', 'abs', 'neg'];
  if (!allowed.includes(op)) {
    throw new ConfigError(`${context}.op 未知运算「${op}」，可用：${allowed.join(' / ')}`);
  }
  const argsRaw = raw['args'];
  if (!Array.isArray(argsRaw) || argsRaw.length === 0) {
    throw new ConfigError(`${context}.args 应为非空数组`);
  }
  return {
    op: op as MetricExpr['op'],
    args: argsRaw.map((a, i) => parseExpr(a, `${context}.args[${i}]`)),
  };
}

function asRange(value: unknown, context: string): number | [number, number] {
  if (Array.isArray(value)) {
    if (value.length !== 2) throw new ConfigError(`${context} 区间必须正好两个数`);
    const low = asNumber(value[0], `${context}[0]`);
    const high = asNumber(value[1], `${context}[1]`);
    if (low > high) throw new ConfigError(`${context} 区间下限大于上限`);
    return [low, high];
  }
  return asNumber(value, context);
}

function parseRating(raw: unknown, context: string): RatingRule {
  if (!isRecord(raw)) throw new ConfigError(`${context} 应为对象`);
  const direction = asString(raw['direction'], `${context}.direction`);
  if (direction !== 'higher_better' && direction !== 'lower_better' && direction !== 'range') {
    throw new ConfigError(`${context}.direction 必须是 higher_better / lower_better / range`);
  }
  if (direction === 'range') {
    const good = asRange(raw['good'], `${context}.good`);
    const watch = asRange(raw['watch'], `${context}.watch`);
    if (!Array.isArray(good) || !Array.isArray(watch)) {
      throw new ConfigError(`${context}：range 方向的 good / watch 必须是区间`);
    }
    return { direction, good, watch };
  }
  return {
    direction,
    good: asNumber(raw['good'], `${context}.good`),
    watch: asNumber(raw['watch'], `${context}.watch`),
  };
}

function parseMetric(raw: unknown, index: number, context: string): MetricDef {
  const ctx = `${context}.metrics[${index}]`;
  if (!isRecord(raw)) throw new ConfigError(`${ctx} 应为对象`);
  const accounts = raw['accounts'] === undefined
    ? undefined
    : asStringArray(raw['accounts'], `${ctx}.accounts`);
  const exprRaw = raw['expr'];
  const sourceRaw = optString(raw['source']);
  if (sourceRaw !== undefined && sourceRaw !== 'closing' && sourceRaw !== 'opening' && sourceRaw !== 'net' && sourceRaw !== 'cashflow') {
    throw new ConfigError(`${ctx}.source 必须是 closing / opening / net / cashflow，实际为 ${sourceRaw}`);
  }
  if (accounts === undefined && exprRaw === undefined && sourceRaw !== 'cashflow') {
    throw new ConfigError(`${ctx} 必须提供 accounts、expr 或 source: cashflow`);
  }
  const unit = optString(raw['unit']);
  return {
    key: asString(raw['key'], `${ctx}.key`),
    label: asString(raw['label'], `${ctx}.label`),
    ...(unit === undefined ? {} : { unit }),
    ...(accounts === undefined ? {} : { accounts }),
    ...(raw['sign'] === undefined ? {} : { sign: parseSign(raw['sign'], `${ctx}.sign`) }),
    ...(sourceRaw === undefined ? {} : { source: sourceRaw as BalanceSource | 'cashflow' }),
    ...(raw['minus'] === undefined
      ? {}
      : { minus: asStringArray(raw['minus'], `${ctx}.minus`) }),
    ...(exprRaw === undefined ? {} : { expr: parseExpr(exprRaw, `${ctx}.expr`) }),
  };
}

function parseRatio(raw: unknown, index: number, context: string): RatioDef {
  const ctx = `${context}.ratios[${index}]`;
  if (!isRecord(raw)) throw new ConfigError(`${ctx} 应为对象`);
  const benchmarkRaw = raw['benchmark'];
  let benchmark: [number, number] | null = null;
  if (benchmarkRaw !== undefined && benchmarkRaw !== null) {
    const r = asRange(benchmarkRaw, `${ctx}.benchmark`);
    if (!Array.isArray(r)) throw new ConfigError(`${ctx}.benchmark 必须是 [下限, 上限]`);
    benchmark = r;
  }
  const precision = raw['precision'] === undefined
    ? undefined
    : asNumber(raw['precision'], `${ctx}.precision`);
  const hint = optString(raw['hint']);
  return {
    code: asString(raw['code'], `${ctx}.code`),
    name: asString(raw['name'], `${ctx}.name`),
    group: parseGroup(raw['group'], `${ctx}.group`),
    unit: asString(raw['unit'], `${ctx}.unit`),
    formula: asString(raw['formula'], `${ctx}.formula`),
    expr: parseExpr(raw['expr'], `${ctx}.expr`),
    benchmark,
    rating: parseRating(raw['rating'], `${ctx}.rating`),
    ...(precision === undefined ? {} : { precision }),
    ...(hint === undefined ? {} : { hint }),
  };
}

function parseStructure(raw: unknown, context: string): StructureDef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigError(`${context} 应为数组`);
  return raw.map((item, i) => {
    const ctx = `${context}[${i}]`;
    if (!isRecord(item)) throw new ConfigError(`${ctx} 应为对象`);
    return {
      label: asString(item['label'], `${ctx}.label`),
      accounts: asStringArray(item['accounts'], `${ctx}.accounts`),
      ...(item['sign'] === undefined ? {} : { sign: parseSign(item['sign'], `${ctx}.sign`) }),
      ...(item['source'] === undefined ? {} : { source: parseSource(item['source'], `${ctx}.source`) }),
      ...(item['minus'] === undefined
        ? {}
        : { minus: asStringArray(item['minus'], `${ctx}.minus`) }),
      ...(item['exclude'] === undefined
        ? {}
        : { exclude: asStringArray(item['exclude'], `${ctx}.exclude`) }),
    };
  });
}

const ratioCache = new Map<string, RatioConfig>();

/** 加载指标定义（<configDir>/report/ratios.yaml）。 */
export function loadRatioConfig(configDir: string = CONFIG_DIR): RatioConfig {
  const file = resolve(join(configDir, 'report', 'ratios.yaml'));
  const cached = ratioCache.get(file);
  if (cached !== undefined) return cached;

  const doc = readYamlDocument(file);
  if (!isRecord(doc)) throw new ConfigError(`${file} 顶层应为对象`);

  const metricsRaw = doc['metrics'];
  const ratiosRaw = doc['ratios'];
  if (!Array.isArray(metricsRaw)) throw new ConfigError(`${file} 缺少 metrics 数组`);
  if (!Array.isArray(ratiosRaw)) throw new ConfigError(`${file} 缺少 ratios 数组`);

  const trendsRaw = doc['trends'];
  const trends: TrendDef[] = Array.isArray(trendsRaw)
    ? trendsRaw.map((item, i) => {
        const ctx = `${file}#trends[${i}]`;
        if (!isRecord(item)) throw new ConfigError(`${ctx} 应为对象`);
        const direction = asString(item['direction'], `${ctx}.direction`);
        if (direction !== 'higher_better' && direction !== 'lower_better') {
          throw new ConfigError(`${ctx}.direction 必须是 higher_better / lower_better`);
        }
        const unit = optString(item['unit']);
        return {
          key: asString(item['key'], `${ctx}.key`),
          label: asString(item['label'], `${ctx}.label`),
          direction,
          ...(unit === undefined ? {} : { unit }),
        };
      })
    : [];

  const structureRaw = doc['structure'];
  const structure = {
    revenue: isRecord(structureRaw) ? parseStructure(structureRaw['revenue'], `${file}#structure.revenue`) : [],
    cost: isRecord(structureRaw) ? parseStructure(structureRaw['cost'], `${file}#structure.cost`) : [],
    expense: isRecord(structureRaw) ? parseStructure(structureRaw['expense'], `${file}#structure.expense`) : [],
  };

  const config: RatioConfig = {
    metrics: metricsRaw.map((m, i) => parseMetric(m, i, file)),
    ratios: ratiosRaw.map((r, i) => parseRatio(r, i, file)),
    trends,
    structure,
  };

  const seen = new Set<string>();
  for (const r of config.ratios) {
    if (seen.has(r.code)) throw new ConfigError(`${file} 指标编码重复：${r.code}`);
    seen.add(r.code);
  }

  ratioCache.set(file, config);
  return config;
}
