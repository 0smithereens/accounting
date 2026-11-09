/**
 * 科目与准则层检查。
 *
 * 这一层解决「用的科目对不对、符不符合所选准则」的问题。
 * 关键设计：准则档案（StandardProfile）与科目表都由本模块自行加载，原因有三：
 *  1. 审核必须能在「准则模块尚未初始化」的情况下独立运行（并行开发、单测、离线复核）；
 *  2. 科目表可能按准则分目录存放（config/standard/<id>/chart-of-accounts.yaml），
 *     也可能只有一份通用表（config/chart-of-accounts.yaml），需要按优先级回退；
 *  3. 加载失败时不能抛异常把整个审核拖垮，而应降级为「跳过该维度」，
 *     由 report 的 checksRun 证明「检查项跑过了」，而不是假装检查过。
 *
 * 小企业会计准则禁止的科目（如 1811 递延所得税资产）来自 StandardProfile.forbiddenAccounts；
 * 若准则模块尚未提供档案，这里内置一份保守的兜底清单，保证监管红线不会因为「配置没准备好」而失守。
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type {
  AccountingStandardId,
  LawBasis,
  ReviewContext,
  ReviewFinding,
  ReviewInput,
  ReviewTarget,
  StandardFeatureFlags,
  StandardProfile,
} from '../../core/contracts.ts';
import type { AccountDef } from '../../core/types.ts';
import type { AccountTable } from '../../core/config.ts';
import { CONFIG_DIR, PROJECT_ROOT, loadAccounts } from '../../core/config.ts';
import { formatYuan } from '../../core/money.ts';
import {
  LAW_ACCOUNTING_BASIS_60,
  LAW_ACCOUNTING_LAW_13,
  LAW_ACCOUNTING_LAW_9,
  LAW_CAS_BASIC_9,
  LAW_CAS_BASIC_12,
  LAW_ENTERPRISE_SYSTEM_11,
  LAW_SMALL_STANDARD_3,
  LAW_SMALL_STANDARD_5,
} from '../legal.ts';
import type { CheckDefinition } from '../engine.ts';

/* ================================================================== */
/* 一、规则 id                                                         */
/* ================================================================== */

export const ACCOUNT_RULE_IDS = {
  leaf: 'ACC-LEAF-001',
  exists: 'ACC-EXIST-001',
  forbidden: 'ACC-FORBIDDEN-001',
  direction: 'ACC-DIRECTION-001',
  period: 'ACC-PERIOD-001',
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
    category: 'standard',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s === '' ? undefined : s;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.map((item) => String(item).trim()).filter((item) => item !== '');
  return result.length > 0 ? result : undefined;
}

function resolveConfigDir(configDir?: string): string {
  if (configDir === undefined || configDir === '') return CONFIG_DIR;
  return isAbsolute(configDir) ? configDir : resolve(PROJECT_ROOT, configDir);
}

/** 科目前缀匹配：'1811' 命中 '1811' 与 '1811.01'，不命中 '18110'。 */
function matchesAccountPrefix(code: string, prefix: string): boolean {
  return code === prefix || code.startsWith(`${prefix}.`);
}

/* ================================================================== */
/* 三、准则档案（兜底 + 可覆盖）                                       */
/* ================================================================== */

const CAS_FEATURES: StandardFeatureFlags = {
  deferredTax: true,
  fairValueMeasurement: true,
  assetImpairment: true,
  developmentCapitalization: true,
  revenueFiveStep: true,
  equityMethod: true,
  borrowingCostCapitalization: true,
  leaseCapitalization: true,
  priorPeriodAdjustment: true,
  cashFlowStatement: true,
  equityStatement: true,
  notesRequired: true,
};

const SMALL_FEATURES: StandardFeatureFlags = {
  deferredTax: false,
  fairValueMeasurement: false,
  assetImpairment: false,
  developmentCapitalization: false,
  revenueFiveStep: false,
  equityMethod: false,
  borrowingCostCapitalization: true,
  leaseCapitalization: false,
  priorPeriodAdjustment: false,
  cashFlowStatement: true,
  equityStatement: false,
  notesRequired: true,
};

/**
 * 小企业会计准则禁止出现的科目。
 *
 * 判断依据不是「编码不同」，而是「核算方法不同」：
 * 小企业准则采用应付税款法（不确认递延所得税）、不计提资产减值准备、
 * 不单独核算投资性房地产。即使企业用的是同一套 CAS 科目表，
 * 只要凭证里出现这些科目，就说明账务处理已经偏离所选准则。
 */
const SMALL_FORBIDDEN_ACCOUNTS: string[] = [
  '1231', // 坏账准备
  '1471', // 存货跌价准备
  '1512', // 长期股权投资减值准备
  '1521', // 投资性房地产
  '1531', // 长期应收款
  '1603', // 固定资产减值准备
  '1703', // 无形资产减值准备
  '1811', // 递延所得税资产
  '2801', // 预计负债
  '2901', // 递延所得税负债
  '6701', // 资产减值损失
];

const FORBIDDEN_ACCOUNT_REASONS: Record<string, string> = {
  '1231': '坏账准备：小企业会计准则采用直接转销法，不计提坏账准备',
  '1471': '存货跌价准备：小企业会计准则不计提资产减值准备',
  '1512': '长期股权投资减值准备：小企业会计准则不计提资产减值准备',
  '1521': '投资性房地产：小企业会计准则不单独设置该科目，应按固定资产或无形资产核算',
  '1531': '长期应收款：小企业会计准则未设置该科目',
  '1603': '固定资产减值准备：小企业会计准则不计提资产减值准备',
  '1703': '无形资产减值准备：小企业会计准则不计提资产减值准备',
  '1811': '递延所得税资产：小企业会计准则采用应付税款法，不确认递延所得税',
  '2801': '预计负债：小企业会计准则未设置该科目',
  '2901': '递延所得税负债：小企业会计准则采用应付税款法，不确认递延所得税',
  '6701': '资产减值损失：小企业会计准则不计提资产减值准备',
};

const FALLBACK_PROFILES: Record<AccountingStandardId, StandardProfile> = {
  cas: {
    id: 'cas',
    label: '企业会计准则',
    basis: [LAW_CAS_BASIC_12],
    chartFile: 'chart-of-accounts.yaml',
    mappingDir: 'mappings',
    statementFile: 'statements.yaml',
    features: CAS_FEATURES,
    forbiddenAccounts: [],
    requiredClosingAccounts: ['4103', '4104'],
    summary: '适用于上市公司、大中型企业及需要融资、并表的企业；确认递延所得税、资产减值与公允价值计量。',
  },
  small: {
    id: 'small',
    label: '小企业会计准则',
    basis: [LAW_SMALL_STANDARD_3, LAW_SMALL_STANDARD_5],
    chartFile: 'chart-of-accounts.yaml',
    mappingDir: 'mappings',
    statementFile: 'statements.yaml',
    features: SMALL_FEATURES,
    forbiddenAccounts: SMALL_FORBIDDEN_ACCOUNTS,
    requiredClosingAccounts: ['3103', '3104'],
    summary: '适用于符合《中小企业划型标准规定》的小型企业；应付税款法、不计提减值、研发支出全部费用化。',
  },
};

const FEATURE_KEYS: Array<keyof StandardFeatureFlags> = [
  'deferredTax',
  'fairValueMeasurement',
  'assetImpairment',
  'developmentCapitalization',
  'revenueFiveStep',
  'equityMethod',
  'borrowingCostCapitalization',
  'leaseCapitalization',
  'priorPeriodAdjustment',
  'cashFlowStatement',
  'equityStatement',
  'notesRequired',
];

function readFeatures(value: unknown): Partial<StandardFeatureFlags> {
  if (!isRecord(value)) return {};
  const result: Partial<StandardFeatureFlags> = {};
  for (const key of FEATURE_KEYS) {
    const raw = value[key];
    if (typeof raw === 'boolean') result[key] = raw;
  }
  return result;
}

const LAW_LEVELS = new Set(['law', 'administrative-regulation', 'departmental-rule', 'normative-document', 'standard']);

function readBasis(value: unknown): LawBasis[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: LawBasis[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = readString(item['id']);
    const title = readString(item['title']);
    if (id === undefined || title === undefined) continue;

    const basis: LawBasis = { id, title };
    const article = readString(item['article']);
    if (article !== undefined) basis.article = article;
    const excerpt = readString(item['excerpt']);
    if (excerpt !== undefined) basis.excerpt = excerpt;
    const effectiveFrom = readString(item['effectiveFrom']);
    if (effectiveFrom !== undefined) basis.effectiveFrom = effectiveFrom;
    const url = readString(item['url']);
    if (url !== undefined) basis.url = url;
    const level = readString(item['level']);
    if (level !== undefined && LAW_LEVELS.has(level)) {
      basis.level = level as LawBasis['level'];
    }
    result.push(basis);
  }
  return result.length > 0 ? result : undefined;
}

function findProfileFile(standard: AccountingStandardId, configDir?: string): string | null {
  const bases: string[] = [];
  const explicit = resolveConfigDir(configDir);
  bases.push(explicit);
  if (!bases.includes(CONFIG_DIR)) bases.push(CONFIG_DIR);

  for (const base of bases) {
    const dir = join(base, 'standard', standard);
    const candidates = [
      join(dir, 'profile.yaml'),
      join(dir, 'profile.yml'),
      join(dir, 'standard.yaml'),
      join(dir, 'standard.yml'),
      join(base, 'standard', `${standard}.yaml`),
      join(base, 'standard', `${standard}.yml`),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function mergeProfile(fallback: StandardProfile, root: Record<string, unknown>): StandardProfile {
  const label = readString(root['label']) ?? readString(root['name']) ?? fallback.label;
  const summary = readString(root['summary']) ?? fallback.summary;
  const chartFile = readString(root['chartFile']) ?? readString(root['chart_file']) ?? fallback.chartFile;
  const mappingDir = readString(root['mappingDir']) ?? readString(root['mapping_dir']) ?? fallback.mappingDir;
  const statementFile =
    readString(root['statementFile']) ?? readString(root['statement_file']) ?? fallback.statementFile;
  const basis = readBasis(root['basis']) ?? fallback.basis;
  const forbiddenAccounts =
    readStringArray(root['forbiddenAccounts']) ?? readStringArray(root['forbidden_accounts']) ?? fallback.forbiddenAccounts;
  const requiredClosingAccounts =
    readStringArray(root['requiredClosingAccounts']) ??
    readStringArray(root['required_closing_accounts']) ??
    fallback.requiredClosingAccounts;

  return {
    ...fallback,
    label,
    summary,
    chartFile,
    mappingDir,
    statementFile,
    basis,
    forbiddenAccounts,
    requiredClosingAccounts,
    features: { ...fallback.features, ...readFeatures(root['features']) },
  };
}

/**
 * 加载指定准则的档案。
 *
 * 文件存在时用文件覆盖内置兜底值；文件不存在或格式非法时返回兜底值。
 * 这里刻意不抛异常：审核引擎的目标是「发现问题」，不是「因为配置缺失而停机」。
 */
export function loadStandardProfile(
  standard: AccountingStandardId,
  configDir?: string,
): StandardProfile {
  const fallback = FALLBACK_PROFILES[standard];
  const file = findProfileFile(standard, configDir);
  if (file === null) return fallback;

  try {
    const doc: unknown = parseYaml(readFileSync(file, 'utf8'));
    if (!isRecord(doc)) return fallback;
    const root = isRecord(doc['profile']) ? doc['profile'] : doc;
    return mergeProfile(fallback, root);
  } catch {
    return fallback;
  }
}

/* ================================================================== */
/* 四、科目表加载（带缓存）                                            */
/* ================================================================== */

const accountTableCache = new Map<string, AccountTable | null>();

function tryLoadAccounts(dir: string): AccountTable | null {
  const cached = accountTableCache.get(dir);
  if (cached !== undefined) return cached;

  let table: AccountTable | null = null;
  try {
    if (existsSync(join(dir, 'chart-of-accounts.yaml'))) {
      table = loadAccounts(dir);
    }
  } catch {
    table = null;
  }
  accountTableCache.set(dir, table);
  return table;
}

/**
 * 按「准则专属科目表 → 通用科目表」的顺序加载。
 * 准则专属表放在 config/standard/<id>/ 下，通用表是 config/chart-of-accounts.yaml。
 */
export function loadReviewAccounts(
  standard: AccountingStandardId,
  configDir?: string,
): AccountTable | null {
  const bases: string[] = [];
  const explicit = resolveConfigDir(configDir);
  bases.push(explicit);
  if (!bases.includes(CONFIG_DIR)) bases.push(CONFIG_DIR);

  for (const base of bases) {
    const fromStandard = tryLoadAccounts(join(base, 'standard', standard));
    if (fromStandard !== null) return fromStandard;
    const fromBase = tryLoadAccounts(base);
    if (fromBase !== null) return fromBase;
  }
  return null;
}

/* ================================================================== */
/* 五、运行时上下文                                                    */
/* ================================================================== */

let activeAccounts: AccountTable | null = null;
let activeProfile: StandardProfile = FALLBACK_PROFILES.cas;
let activeKey = '';
let initialized = false;

/**
 * 由引擎在每次 runReview 开始时调用。
 *
 * 为什么用模块级「当前上下文」而不是把科目表塞进 ReviewContext：
 * ReviewContext 是七个模块共享的只读契约，不能为本模块的便利去改它。
 * runReview 是同步函数，不存在并发交错，因此模块级状态是安全的；
 * 键里带上 standard + configDir，切换准则或配置目录时会自动重载。
 */
export function prepareAccountContext(standard: AccountingStandardId, configDir?: string): void {
  const key = `${standard}|${configDir ?? ''}`;
  if (initialized && key === activeKey) return;

  activeAccounts = loadReviewAccounts(standard, configDir);
  activeProfile = loadStandardProfile(standard, configDir);
  activeKey = key;
  initialized = true;
}

function ensureContext(standard: AccountingStandardId): void {
  if (!initialized) prepareAccountContext(standard, undefined);
}

function currentAccounts(): AccountTable | null {
  return activeAccounts;
}

function currentProfile(): StandardProfile {
  return activeProfile;
}

function accountDef(code: string): AccountDef | undefined {
  return activeAccounts?.get(code);
}

/* ================================================================== */
/* 六、检查项                                                          */
/* ================================================================== */

function lineTarget(voucherId: string, word: string, index: number): ReviewTarget {
  return {
    kind: 'voucher_line',
    id: `${voucherId}#L${index + 1}`,
    label: `${word} 第 ${index + 1} 行`,
  };
}

/** ACC-LEAF-001：使用非明细科目挂分录。 */
function checkLeaf(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  ensureContext(ctx.standard);
  const table = currentAccounts();
  if (table === null) return [];

  const findings: ReviewFinding[] = [];

  for (const voucher of input.vouchers) {
    voucher.lines.forEach((line, index) => {
      const account = table.get(line.accountCode);
      if (account === undefined || account.leaf) return;

      const children = table.accounts.filter((item) => item.parent === account.code);
      findings.push(
        makeFinding(
          ctx,
          ACCOUNT_RULE_IDS.leaf,
          lineTarget(voucher.id, voucher.word, index),
          '使用非明细科目记账',
          `凭证 ${voucher.word} 第 ${index + 1} 行使用了上级科目 ${account.code} ${account.name}` +
            `（下辖 ${children.length} 个明细科目）。上级科目只用于汇总，不能直接挂分录，` +
            '否则明细账与总账无法对应，也无法按明细科目出具报表。',
          children.length > 0
            ? `改用具体明细科目（如 ${children.slice(0, 3).map((item) => `${item.code} ${item.name}`).join('、')}），` +
              '或在科目表中为该科目配置 defaultChild 让系统自动下钻。'
            : '在科目表中为该科目补充明细科目，或把该科目标记为明细科目（leaf: true）。',
          [LAW_ACCOUNTING_LAW_13, LAW_ENTERPRISE_SYSTEM_11],
          {
            voucherId: voucher.id,
            lineNumber: index + 1,
            accountCode: account.code,
            accountName: account.name,
            childCount: children.length,
          },
        ),
      );
    });
  }

  return findings;
}

/** ACC-EXIST-001：科目不在所选准则科目表中。 */
function checkAccountExists(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  ensureContext(ctx.standard);
  const table = currentAccounts();
  if (table === null) return [];

  const findings: ReviewFinding[] = [];

  for (const voucher of input.vouchers) {
    voucher.lines.forEach((line, index) => {
      if (table.get(line.accountCode) !== undefined) return;

      findings.push(
        makeFinding(
          ctx,
          ACCOUNT_RULE_IDS.exists,
          lineTarget(voucher.id, voucher.word, index),
          '科目不在所选准则科目表中',
          `凭证 ${voucher.word} 第 ${index + 1} 行使用的科目 ${line.accountCode} ${line.accountName} ` +
            `不在《${currentProfile().label}》科目表中。可能是规则写错编码、科目表未维护，` +
            '或该科目属于另一套准则体系。',
          '核对科目编码：在 config/chart-of-accounts.yaml（或 config/standard/<准则>/chart-of-accounts.yaml）' +
            '中补充该科目并标记为明细科目，或修正规则中的科目编码。科目编码错误会导致报表取数为空。',
          [LAW_ACCOUNTING_LAW_13, LAW_ENTERPRISE_SYSTEM_11],
          {
            voucherId: voucher.id,
            lineNumber: index + 1,
            accountCode: line.accountCode,
            accountName: line.accountName,
            standard: ctx.standard,
          },
        ),
      );
    });
  }

  return findings;
}

/** ACC-FORBIDDEN-001：所选准则禁止的科目。 */
function checkForbiddenAccounts(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  ensureContext(ctx.standard);
  const profile = currentProfile();
  if (profile.forbiddenAccounts.length === 0) return [];

  const findings: ReviewFinding[] = [];

  for (const voucher of input.vouchers) {
    voucher.lines.forEach((line, index) => {
      const prefix = profile.forbiddenAccounts.find((item) => matchesAccountPrefix(line.accountCode, item));
      if (prefix === undefined) return;

      const reason = FORBIDDEN_ACCOUNT_REASONS[prefix] ?? '该科目属于另一套准则体系，当前准则下不允许使用';
      findings.push(
        makeFinding(
          ctx,
          ACCOUNT_RULE_IDS.forbidden,
          lineTarget(voucher.id, voucher.word, index),
          '使用所选准则禁止的科目',
          `凭证 ${voucher.word} 第 ${index + 1} 行使用了科目 ${line.accountCode} ${line.accountName}，` +
            `但本次选择的会计准则是《${profile.label}》。${reason}。` +
            '继续使用会导致报表口径与准则不符，也会让审计师无法对准则适用性出具意见。',
          `按《${profile.label}》改用允许的科目处理同一业务；若企业实际应适用另一套准则，` +
            '应整体切换准则（同时切换科目表、报表格式与审核检查集），不得只改单张凭证。',
          profile.basis.length > 0 ? [...profile.basis, LAW_ACCOUNTING_LAW_13] : [LAW_ACCOUNTING_LAW_13],
          {
            voucherId: voucher.id,
            lineNumber: index + 1,
            accountCode: line.accountCode,
            accountName: line.accountName,
            forbiddenPrefix: prefix,
            standard: ctx.standard,
          },
        ),
      );
    });
  }

  return findings;
}

/** ACC-DIRECTION-001：余额方向与科目性质相反。 */
function checkBalanceDirection(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  ensureContext(ctx.standard);
  const table = currentAccounts();
  const ledger = input.ledger;
  if (table === null || ledger === undefined) return [];

  const findings: ReviewFinding[] = [];

  for (const balance of ledger.balances) {
    const account = table.get(balance.accountCode);
    if (account === undefined) continue;
    // 损益类与成本类在期末结账后应为 0，方向不具会计意义，跳过以免误报。
    if (account.category === 'profit' || account.category === 'cost') continue;
    if (balance.closing === 0) continue;

    const wrongDirection =
      (account.balanceSide === 'debit' && balance.closing < 0) ||
      (account.balanceSide === 'credit' && balance.closing > 0);
    if (!wrongDirection) continue;

    const actualSide = balance.closing < 0 ? '贷方' : '借方';
    const expectedSide = account.balanceSide === 'debit' ? '借方' : '贷方';

    findings.push(
      makeFinding(
        ctx,
        ACCOUNT_RULE_IDS.direction,
        {
          kind: 'ledger',
          id: balance.accountCode,
          label: `${balance.accountCode} ${balance.accountName}`,
        },
        '余额方向与科目性质相反',
        `科目 ${balance.accountCode} ${balance.accountName} 属于${account.category === 'asset' ? '资产' : account.category === 'liability' ? '负债' : '所有者权益'}类，` +
          `正常余额应在${expectedSide}，但期末余额为 ${formatYuan(balance.closing)} 元（${actualSide}余额）。` +
          '除备抵科目外，方向相反通常意味着记错方向、重复结转或存在未调整的期初差错。',
        '核对本期发生额与期初余额：若为备抵科目（累计折旧、坏账准备等），应在科目表中把余额方向设为相反方向；' +
          '若为错记方向，应编制更正凭证；若为期初差错，应通过以前年度损益调整处理。',
        [LAW_ACCOUNTING_LAW_9, LAW_ENTERPRISE_SYSTEM_11, LAW_ACCOUNTING_BASIS_60],
        {
          accountCode: balance.accountCode,
          category: account.category,
          balanceSide: account.balanceSide,
          opening: balance.opening,
          closing: balance.closing,
        },
      ),
    );
  }

  return findings;
}

/** ACC-PERIOD-001：跨期记账。 */
function checkCrossPeriod(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const voucher of input.vouchers) {
    if (voucher.period === ctx.period) continue;

    findings.push(
      makeFinding(
        ctx,
        ACCOUNT_RULE_IDS.period,
        { kind: 'voucher', id: voucher.id, label: `${voucher.word}（${voucher.date}）` },
        '跨期记账',
        `凭证 ${voucher.word}（记账日期 ${voucher.date}）所属期间为 ${voucher.period}，` +
          `但本次审核期间为 ${ctx.period}。跨期记账会破坏期间损益、期间可比性与已结账期间的不可变性。`,
        '按权责发生制在业务所属期间确认；已结账期间的差错应通过「以前年度损益调整」处理并在附注披露；' +
          '不得通过修改凭证日期或在下期补记来「消化」跨期业务。',
        [LAW_CAS_BASIC_9, LAW_ACCOUNTING_LAW_9],
        { voucherId: voucher.id, voucherPeriod: voucher.period, reviewPeriod: ctx.period, date: voucher.date },
      ),
    );
  }

  return findings;
}

/* ================================================================== */
/* 七、注册                                                            */
/* ================================================================== */

export const accountChecks: readonly CheckDefinition[] = [
  {
    id: ACCOUNT_RULE_IDS.leaf,
    title: '分录使用明细科目',
    category: 'standard',
    severity: 'error',
    blocking: false,
    configurable: true,
    basis: [LAW_ACCOUNTING_LAW_13, LAW_ENTERPRISE_SYSTEM_11],
    run: checkLeaf,
  },
  {
    id: ACCOUNT_RULE_IDS.exists,
    title: '科目存在于所选准则科目表',
    category: 'standard',
    severity: 'error',
    blocking: true,
    configurable: false,
    basis: [LAW_ACCOUNTING_LAW_13, LAW_ENTERPRISE_SYSTEM_11],
    run: checkAccountExists,
  },
  {
    id: ACCOUNT_RULE_IDS.forbidden,
    title: '未使用所选准则禁止的科目',
    category: 'standard',
    severity: 'error',
    blocking: true,
    configurable: false,
    basis: [LAW_SMALL_STANDARD_3, LAW_ACCOUNTING_LAW_13],
    run: checkForbiddenAccounts,
  },
  {
    id: ACCOUNT_RULE_IDS.direction,
    title: '余额方向符合科目性质',
    category: 'standard',
    severity: 'warning',
    blocking: false,
    configurable: true,
    basis: [LAW_ACCOUNTING_LAW_9, LAW_ACCOUNTING_BASIS_60],
    run: checkBalanceDirection,
  },
  {
    id: ACCOUNT_RULE_IDS.period,
    title: '凭证未跨期记账',
    category: 'accounting_law',
    severity: 'warning',
    blocking: false,
    configurable: true,
    basis: [LAW_CAS_BASIC_9, LAW_ACCOUNTING_LAW_9],
    run: checkCrossPeriod,
  },
];
