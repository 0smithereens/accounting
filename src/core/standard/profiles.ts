/**
 * 会计准则档案（Accounting Standard Profiles）—— 双轨准则的唯一切换点。
 *
 * 为什么需要这一层，而不是在核算/审核/报表里各写一套 if：
 *  1. 两套准则不是「同一套科目换个名字」。科目编码体系（4/5/6 vs 3/4/5 类）、
 *     禁止使用的科目、报表格式、审核要点都不同。把这 12 项差异收敛成
 *     StandardFeatureFlags 开关，四个引擎读同一份档案，才不会出现
 *     「记账按小企业准则、报表按企业准则」这种致命不一致。
 *  2. 切换准则必须是配置行为：改 settings.yaml 的 accountingStandard 即可，
 *     不碰代码。档案全部来自 config/standard/standards.yaml。
 *  3. 合规结论必须带法规依据：档案里的 basis 与禁用科目的 basisRefs 都指向具体法条，
 *     审核报告可直接引用，审核员不必再去翻文件。
 *
 * ⚠ 本文件最容易写错的地方：编码重号
 *   两套准则的编码体系不同，同一编码可能指向完全不同的科目：
 *     4001 = 企业会计准则「实收资本」      = 小企业会计准则「生产成本」
 *     5001 = 企业会计准则「生产成本」      = 小企业会计准则「主营业务收入」
 *     5301 = 企业会计准则「研发支出」      = 小企业会计准则「营业外收入」
 *     1501 = 企业会计准则「持有至到期投资」= 小企业会计准则「长期债券投资」
 *   所以「该科目是否被本准则禁止」绝不能只比编码，必须「编码 + 科目名称」一起比。
 *   checkAccountAllowed() 因此支持传入 accountName；未传时用本准则科目表里该编码的
 *   实际名称回填，避免把合法的「5301 营业外收入」误判成「5301 研发支出」。
 *   同理，StandardProfile.forbiddenAccounts 里既有「无条件禁用」的编码，也有
 *   「仅同名时禁用」的编码，消费方禁止直接 includes() 判断，必须走 checkAccountAllowed()。
 *
 * 与 core/config.ts 的分工：
 *   config.ts 负责「YAML → AccountTable」的解析与 defaultChild 下钻链校验（约 150 行，
 *   还有大量边界处理）。本文件不重复实现，而是直接复用它的 loadAccounts(configDir)：
 *   该函数固定读取 <configDir>/chart-of-accounts.yaml，所以把科目表所在目录传进去即可。
 *   代价是科目表文件名必须是 chart-of-accounts.yaml（已在 loadStandardAccounts 里校验并
 *   给出可读报错），换来的是「两套科目表与旧科目表走完全相同的解析与下钻逻辑」，
 *   不会出现「旧表能下钻、新表不能」的分裂。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type {
  AccountingStandardId,
  LawBasis,
  StandardBundle,
  StandardFeatureFlags,
  StandardProfile,
} from '../contracts.ts';
import { CONFIG_DIR, PROJECT_ROOT, loadAccounts } from '../config.ts';
import type { AccountTable } from '../config.ts';

/* ================================================================== */
/* 一、错误类型                                                        */
/* ================================================================== */

/**
 * 准则配置错误。
 *
 * 为什么单独定义而不是复用 core/config.ts 的 ConfigError：
 * 上层（CLI/Web）需要把「准则配置坏了」与「单据解析失败」区分开——
 * 前者是配置问题，切换准则即可回滚；后者是数据问题。
 * 两类错误的处置建议完全不同，不能混在一个类型里。
 */
export class StandardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandardConfigError';
  }
}

/* ================================================================== */
/* 二、公共类型                                                        */
/* ================================================================== */

/** 准则注册表：一次加载，多处查询。 */
export interface StandardRegistry {
  /** 已加载的准则 id，按配置文件顺序 */
  readonly ids: AccountingStandardId[];
  /** 取档案；id 不存在时抛 StandardConfigError（绝不返回 undefined 让调用方去猜） */
  get(id: AccountingStandardId): StandardProfile;
  all(): StandardProfile[];
  /** 配置里是否有该准则（入参放宽为 string，便于直接校验用户输入） */
  has(id: string): boolean;
}

/** 一条「禁用科目」规则。 */
export interface ForbiddenAccountRule {
  /** 科目编码，含下级科目一并禁用 */
  code: string;
  /**
   * 企业会计准则下该编码的科目名称。
   * 为空 = 无条件禁用（本准则根本没这个科目）；
   * 非空 = 只有科目名称也对得上才禁用（处理两套准则「同号不同科目」）。
   */
  name?: string;
  /** 与之相关的准则特性，便于前端提示「为什么禁用」 */
  feature?: keyof StandardFeatureFlags;
  /** 可直接展示给用户的中文说明 */
  reason: string;
  /** 法规依据，必定非空 */
  basis: LawBasis[];
}

/** 科目准入判定结果。 */
export interface AccountAllowance {
  /** 是否允许在本准则下使用 */
  allowed: boolean;
  /**
   * 说明。
   * allowed=false 时是「为什么禁用」；
   * allowed=true 且编码与禁用清单重号时，是「为什么这次放行」，便于审计追溯。
   */
  reason?: string;
  /** 法规依据，必定非空（合规结论不允许没有依据） */
  basis: LawBasis[];
}

/** 「两套准则差异对照表」的一行，供前端直接渲染。 */
export interface FeatureDiffRow {
  feature: keyof StandardFeatureFlags;
  label: string;
  cas: string;
  small: string;
}

/* ================================================================== */
/* 三、常量：准则 id 与 12 项特性                                       */
/* ================================================================== */

/** 系统支持的全部准则 id。新增准则要同时改 contracts.ts 的 AccountingStandardId。 */
export const STANDARD_IDS: readonly AccountingStandardId[] = ['cas', 'small'];

/**
 * 默认准则：小企业会计准则。
 * 理由：中国中小企业占绝大多数，多数小微企业适用《小企业会计准则》；
 * 默认值选错会导致「明明是小企业却按企业准则计提减值」，宁可默认简化口径。
 */
export const DEFAULT_STANDARD: AccountingStandardId = 'small';

interface FeatureMeta {
  label: string;
  cas: string;
  small: string;
}

/**
 * 12 项特性的中文名与两套准则的人话描述。
 * 用 Record<keyof StandardFeatureFlags, ...> 声明，编译器会强制 12 项一个不漏，
 * 以后 contracts.ts 加特性时这里不补会直接编译失败——这是有意为之的「防漏机制」。
 */
const FEATURE_META: Record<keyof StandardFeatureFlags, FeatureMeta> = {
  deferredTax: {
    label: '递延所得税',
    cas: '资产负债表债务法：确认递延所得税资产与递延所得税负债，确认递延所得税费用',
    small: '应付税款法：只确认当期应交所得税（5801），不确认递延所得税',
  },
  fairValueMeasurement: {
    label: '公允价值计量',
    cas: '交易性金融资产、投资性房地产、其他权益工具投资等可按公允价值计量，并确认公允价值变动损益',
    small: '一律按历史成本计量，不确认公允价值变动，也无「公允价值变动损益」科目',
  },
  assetImpairment: {
    label: '资产减值',
    cas: '期末对存货、应收款项、固定资产、无形资产、商誉等计提减值准备，部分可转回',
    small: '资产按成本计量，不计提任何减值准备；坏账、存货毁损于实际发生时直接计入损益',
  },
  developmentCapitalization: {
    label: '研发支出资本化',
    cas: '区分研究阶段（费用化）与开发阶段（满足条件资本化），报表单列「开发支出」',
    small: '研发支出在管理费用列支；自行开发无形资产仅在完成时按成本入账，不单列开发支出',
  },
  revenueFiveStep: {
    label: '收入确认（五步法）',
    cas: '按五步法确认收入，涉及合同资产、合同负债、可变对价与重大融资成分',
    small: '按「风险报酬转移、金额可计量、经济利益很可能流入、成本可计量」四项条件确认，不设合同资产/负债',
  },
  equityMethod: {
    label: '长期股权投资权益法',
    cas: '对联营、合营企业采用权益法，按被投资单位净损益确认投资收益',
    small: '长期股权投资一律采用成本法，被投资单位实现损益不调整投资账面价值',
  },
  borrowingCostCapitalization: {
    label: '借款费用资本化',
    cas: '按实际利率法计算专门借款与一般借款的资本化金额，可资本化期间严格判定',
    small: '购建资产期间的借款费用可计入资产成本，但按合同利率与实际支出简化计算，不计算一般借款资本化率',
  },
  leaseCapitalization: {
    label: '租赁资本化',
    cas: '承租人确认使用权资产与租赁负债，分别确认折旧费用与利息费用',
    small: '经营租赁按期确认租金费用，不确认使用权资产与租赁负债；融资租入固定资产按付款总额入账',
  },
  priorPeriodAdjustment: {
    label: '以前年度损益调整',
    cas: '重要前期差错采用追溯重述法，通过「以前年度损益调整」并调整报表比较数',
    small: '会计政策变更与差错更正一律采用未来适用法，不追溯调整，不设「以前年度损益调整」科目',
  },
  cashFlowStatement: {
    label: '现金流量表',
    cas: '必须编制现金流量表（正表 + 补充资料）',
    small: '必须编制现金流量表（准则第七十八条），格式较企业准则简化',
  },
  equityStatement: {
    label: '所有者权益变动表',
    cas: '必须编制所有者权益变动表',
    small: '不要求编制所有者权益变动表，相关内容在附注中披露',
  },
  notesRequired: {
    label: '财务报表附注',
    cas: '必须编制附注，披露会计政策、重要会计估计、关联方交易等',
    small: '必须编制附注（准则第七十八条），披露内容显著简化',
  },
};

/** 特性 key 的固定展示顺序（= FEATURE_META 的书写顺序）。 */
const FEATURE_KEYS: readonly (keyof StandardFeatureFlags)[] = Object.keys(
  FEATURE_META,
) as Array<keyof StandardFeatureFlags>;

/** 特性 key → 中文名，供前端与审核报告复用。 */
export const STANDARD_FEATURE_LABEL: Record<keyof StandardFeatureFlags, string> = Object.fromEntries(
  FEATURE_KEYS.map((key) => [key, FEATURE_META[key].label]),
) as Record<keyof StandardFeatureFlags, string>;

/**
 * 两套准则差异对照表（模块级常量，内容不变，避免每次渲染都重建）。
 * 覆盖全部 12 项特性——FEATURE_META 的类型约束保证了这一点。
 */
export const FEATURE_DIFF: readonly FeatureDiffRow[] = FEATURE_KEYS.map((feature) => {
  const meta = FEATURE_META[feature];
  return { feature, label: meta.label, cas: meta.cas, small: meta.small };
});

/**
 * 两套准则差异对照表。
 * 前端「准则差异」页面直接渲染这个数组即可，不需要知道 StandardFeatureFlags 的结构。
 */
export function describeFeatureDiff(): Array<{
  feature: keyof StandardFeatureFlags;
  label: string;
  cas: string;
  small: string;
}> {
  // 返回副本：调用方可能排序或改写，不希望污染模块级常量
  return FEATURE_DIFF.map((row) => ({ ...row }));
}

/* ================================================================== */
/* 四、内置的「禁用科目」知识（YAML 未提供说明时的兜底）                */
/* ================================================================== */

interface ForbiddenKnowledge {
  /** 企业会计准则下的科目名称（用于「编码 + 名称」双重判定） */
  name: string;
  feature?: keyof StandardFeatureFlags;
}

/**
 * 编码 → 企业会计准则科目名。
 *
 * 为什么要在代码里再放一份：checkAccountAllowed() 可能收到不是由 loadStandardRegistry()
 * 造出来的 profile（例如单元测试直接构造、或其它模块按标准 id 克隆了档案）。
 * 这时读不到 YAML 里的富文本说明，但「哪些编码属于企业会计准则专属科目」是准则常识，
 * 内置一份可以让判定结果与说明依然正确，而不是抛错或放行。
 * 真值仍以 standards.yaml 为准：YAML 里没列出的编码，本表也不会凭空禁用。
 */
const FORBIDDEN_KNOWLEDGE: Record<string, ForbiddenKnowledge> = {
  '1101': { name: '交易性金融资产', feature: 'fairValueMeasurement' },
  '1231': { name: '坏账准备', feature: 'assetImpairment' },
  '1471': { name: '存货跌价准备', feature: 'assetImpairment' },
  '1501': { name: '持有至到期投资', feature: 'fairValueMeasurement' },
  '1502': { name: '持有至到期投资减值准备', feature: 'assetImpairment' },
  '1503': { name: '可供出售金融资产', feature: 'fairValueMeasurement' },
  '1504': { name: '其他权益工具投资', feature: 'fairValueMeasurement' },
  '1511': { name: '持有至到期投资', feature: 'fairValueMeasurement' },
  '1512': { name: '长期股权投资减值准备', feature: 'assetImpairment' },
  '1521': { name: '投资性房地产', feature: 'fairValueMeasurement' },
  '1603': { name: '固定资产减值准备', feature: 'assetImpairment' },
  '1612': { name: '使用权资产', feature: 'leaseCapitalization' },
  '1613': { name: '使用权资产累计折旧', feature: 'leaseCapitalization' },
  '1703': { name: '无形资产减值准备', feature: 'assetImpairment' },
  '1711': { name: '商誉' },
  '1811': { name: '递延所得税资产', feature: 'deferredTax' },
  '2703': { name: '租赁负债', feature: 'leaseCapitalization' },
  '2901': { name: '递延所得税负债', feature: 'deferredTax' },
  '4003': { name: '其他综合收益' },
  '4201': { name: '库存股' },
  '5301': { name: '研发支出', feature: 'developmentCapitalization' },
  '6101': { name: '公允价值变动损益', feature: 'fairValueMeasurement' },
  '6701': { name: '资产减值损失', feature: 'assetImpairment' },
  '6702': { name: '信用减值损失', feature: 'assetImpairment' },
  '6901': { name: '以前年度损益调整', feature: 'priorPeriodAdjustment' },
};

/** 兜底规则只需要准则名称与依据，不必传整个档案（单元测试常只构造这两个字段）。 */
interface RuleContext {
  label: string;
  basis: LawBasis[];
}

/** 用内置知识拼一条兜底规则（YAML 未提供说明时使用）。 */
function builtinRuleFor(code: string, profile: RuleContext): ForbiddenAccountRule {
  const known = FORBIDDEN_KNOWLEDGE[code];
  const featureLabel = known?.feature === undefined ? undefined : STANDARD_FEATURE_LABEL[known.feature];
  const namePart = known === undefined ? `${code}` : `${code} ${known.name}`;
  const featurePart = featureLabel === undefined ? '' : `（涉及「${featureLabel}」）`;
  const rule: ForbiddenAccountRule = {
    code,
    reason:
      `科目「${namePart}」属于企业会计准则专属科目${featurePart}，` +
      `${profile.label}不予确认，不得使用。` +
      (profile.basis.length > 0 ? '依据见所附法规。' : ''),
    basis: profile.basis,
  };
  if (known?.feature !== undefined) rule.feature = known.feature;
  return rule;
}

/* ================================================================== */
/* 五、YAML 解析                                                       */
/* ================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StandardConfigError(`${context} 必须是非空字符串，实际为 ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function readYamlFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new StandardConfigError(`准则配置文件不存在: ${path}`);
  }
  try {
    return parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new StandardConfigError(`准则配置 YAML 解析失败 ${path}: ${(err as Error).message}`);
  }
}

const LAW_LEVELS: readonly string[] = [
  'law',
  'administrative-regulation',
  'departmental-rule',
  'normative-document',
  'standard',
];

function parseBasis(raw: unknown, context: string): LawBasis {
  if (!isRecord(raw)) {
    throw new StandardConfigError(`${context} 应为对象`);
  }
  const basis: LawBasis = {
    id: requireString(raw['id'], `${context}.id`),
    title: requireString(raw['title'], `${context}.title`),
  };
  const article = optionalString(raw['article']);
  if (article !== undefined) basis.article = article;
  const excerpt = optionalString(raw['excerpt']);
  if (excerpt !== undefined) basis.excerpt = excerpt;
  const effectiveFrom = optionalString(raw['effectiveFrom']);
  if (effectiveFrom !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      throw new StandardConfigError(`${context}.effectiveFrom 应为 YYYY-MM-DD，实际为「${effectiveFrom}」`);
    }
    basis.effectiveFrom = effectiveFrom;
  }
  const url = optionalString(raw['url']);
  if (url !== undefined) basis.url = url;
  const level = optionalString(raw['level']);
  if (level !== undefined) {
    if (!LAW_LEVELS.includes(level)) {
      throw new StandardConfigError(
        `${context}.level 必须是 ${LAW_LEVELS.join(' / ')} 之一，实际为「${level}」`,
      );
    }
    basis.level = level as LawBasis['level'];
  }
  return basis;
}

function parseFeatures(raw: unknown, context: string): StandardFeatureFlags {
  if (!isRecord(raw)) {
    throw new StandardConfigError(`${context} 应为对象`);
  }
  // 先拒绝未知字段：把 leasingCapitalization 拼成 leasingCapitalisation 会静默走默认分支，
  // 这类拼写错误会让引擎按错误的准则口径处理，必须当场炸掉
  for (const key of Object.keys(raw)) {
    if (!(FEATURE_KEYS as readonly string[]).includes(key)) {
      throw new StandardConfigError(
        `${context} 含未知特性「${key}」，可用：${FEATURE_KEYS.join(' / ')}`,
      );
    }
  }
  const features = {} as StandardFeatureFlags;
  for (const key of FEATURE_KEYS) {
    const value = raw[key];
    if (typeof value !== 'boolean') {
      throw new StandardConfigError(
        `${context}.${key} 必须是 true/false，实际为 ${JSON.stringify(value)}`,
      );
    }
    features[key] = value;
  }
  return features;
}

function stringArrayOf(raw: unknown, context: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new StandardConfigError(`${context} 应为字符串数组`);
  }
  return raw.map((item) => requireString(item, `${context}[]`));
}

interface ParsedStandard {
  profile: StandardProfile;
  rules: ForbiddenAccountRule[];
}

function parseStandard(raw: unknown, context: string): ParsedStandard {
  if (!isRecord(raw)) {
    throw new StandardConfigError(`${context} 应为对象`);
  }

  const idRaw = requireString(raw['id'], `${context}.id`);
  if (!(STANDARD_IDS as readonly string[]).includes(idRaw)) {
    throw new StandardConfigError(
      `${context}.id 必须是 ${STANDARD_IDS.join(' / ')} 之一，实际为「${idRaw}」`,
    );
  }
  const id = idRaw as AccountingStandardId;
  const label = requireString(raw['label'], `${context}.label`);
  const summary = requireString(raw['summary'], `${context}.summary`);

  const basisRaw = raw['basis'];
  if (!Array.isArray(basisRaw) || basisRaw.length === 0) {
    throw new StandardConfigError(`${context}.basis 应是非空数组：没有法规依据的准则档案不允许上线`);
  }
  const basis = basisRaw.map((item, index) => parseBasis(item, `${context}.basis[${index}]`));
  const basisById = new Map<string, LawBasis>();
  for (const entry of basis) {
    if (basisById.has(entry.id)) {
      throw new StandardConfigError(`${context}.basis 的 id 重复: ${entry.id}`);
    }
    basisById.set(entry.id, entry);
  }

  const chartFile = requireString(raw['chartFile'], `${context}.chartFile`);
  const mappingDir = requireString(raw['mappingDir'], `${context}.mappingDir`);
  const statementFile = requireString(raw['statementFile'], `${context}.statementFile`);

  const features = parseFeatures(raw['features'], `${context}.features`);

  const forbiddenRaw = raw['forbiddenAccounts'];
  if (forbiddenRaw !== undefined && forbiddenRaw !== null && !Array.isArray(forbiddenRaw)) {
    throw new StandardConfigError(`${context}.forbiddenAccounts 应为数组`);
  }
  const forbiddenList: unknown[] = Array.isArray(forbiddenRaw) ? forbiddenRaw : [];
  const rules: ForbiddenAccountRule[] = [];
  const ruleCodes = new Set<string>();
  for (const [index, item] of forbiddenList.entries()) {
    const rule = parseForbiddenRule(item, `${context}.forbiddenAccounts[${index}]`, basisById, {
      label,
      basis,
    });
    if (ruleCodes.has(rule.code)) {
      // 同一编码出现两次会让「哪条理由生效」不可预测，也说明配置写重了
      throw new StandardConfigError(
        `${context}.forbiddenAccounts 中科目编码「${rule.code}」重复，同一编码只允许出现一次`,
      );
    }
    ruleCodes.add(rule.code);
    rules.push(rule);
  }

  const requiredClosingAccounts = stringArrayOf(
    raw['requiredClosingAccounts'],
    `${context}.requiredClosingAccounts`,
  );

  const profile: StandardProfile = {
    id,
    label,
    basis,
    chartFile,
    mappingDir,
    statementFile,
    features,
    forbiddenAccounts: rules.map((rule) => rule.code),
    requiredClosingAccounts,
    summary,
  };

  return { profile, rules };
}

function parseForbiddenRule(
  raw: unknown,
  context: string,
  basisById: Map<string, LawBasis>,
  summary: { label: string; basis: LawBasis[] },
): ForbiddenAccountRule {
  // 写法一：纯字符串，表示「本准则根本没有这个科目」，无需再解释
  if (typeof raw === 'string') {
    const code = raw.trim();
    if (code === '') {
      throw new StandardConfigError(`${context} 的科目编码不能为空`);
    }
    return builtinRuleFor(code, { label: summary.label, basis: summary.basis });
  }

  if (!isRecord(raw)) {
    throw new StandardConfigError(`${context} 应为字符串或对象`);
  }

  const code = requireString(raw['code'], `${context}.code`);
  const name = optionalString(raw['name']);
  const featureRaw = optionalString(raw['feature']);
  let feature: keyof StandardFeatureFlags | undefined;
  if (featureRaw !== undefined) {
    if (!(FEATURE_KEYS as readonly string[]).includes(featureRaw)) {
      throw new StandardConfigError(
        `${context}.feature 含未知特性「${featureRaw}」，可用：${FEATURE_KEYS.join(' / ')}`,
      );
    }
    feature = featureRaw as keyof StandardFeatureFlags;
  }

  const refs = stringArrayOf(raw['basisRefs'], `${context}.basisRefs`);
  const basis: LawBasis[] = [];
  for (const ref of refs) {
    const entry = basisById.get(ref);
    if (entry === undefined) {
      throw new StandardConfigError(
        `${context}.basisRefs 引用了不存在的依据「${ref}」，请先在 basis 中定义`,
      );
    }
    basis.push(entry);
  }
  if (basis.length === 0) {
    // 没写 basisRefs 时退回档案整体依据：结论可以粗，但不能没有依据
    basis.push(...summary.basis);
  }

  const explicitReason = optionalString(raw['reason']);
  const known = FORBIDDEN_KNOWLEDGE[code];
  const codeName = name ?? known?.name;
  const codeLabel = codeName === undefined ? code : `${code} ${codeName}`;
  const reason =
    explicitReason ?? `科目「${codeLabel}」不得在${summary.label}下使用。`;

  const rule: ForbiddenAccountRule = { code, reason, basis };
  if (name !== undefined) rule.name = name;
  if (feature !== undefined) rule.feature = feature;
  return rule;
}

/* ================================================================== */
/* 六、注册表加载                                                      */
/* ================================================================== */

/** 已加载档案的禁用规则，key = 准则 id（见 listForbiddenAccounts 的兜底逻辑）。 */
const forbiddenRuleStore = new Map<
  AccountingStandardId,
  { codesKey: string; rules: readonly ForbiddenAccountRule[] }
>();

function codesKey(codes: readonly string[]): string {
  return codes.join('|');
}

/**
 * 加载准则注册表。
 *
 * @param configDir 配置根目录，默认 <项目根>/config；standards.yaml 位于 <configDir>/standard/。
 * @throws StandardConfigError 文件缺失、YAML 结构错误、特性缺失/拼错、id 重复、依据引用失效。
 */
export function loadStandardRegistry(configDir: string = CONFIG_DIR): StandardRegistry {
  const path = join(configDir, 'standard', 'standards.yaml');
  const doc = readYamlFile(path);
  if (!isRecord(doc)) {
    throw new StandardConfigError(`${path} 顶层应为 { standards: [...] }`);
  }
  const listRaw = doc['standards'];
  if (!Array.isArray(listRaw) || listRaw.length === 0) {
    throw new StandardConfigError(`${path} 的 standards 应为非空数组`);
  }

  const fileLabel = displayPath(path);
  const parsed: ParsedStandard[] = [];
  const seen = new Set<string>();
  for (const [index, item] of listRaw.entries()) {
    const result = parseStandard(item, `${fileLabel} standards[${index}]`);
    if (seen.has(result.profile.id)) {
      throw new StandardConfigError(`准则 id 重复: ${result.profile.id}（${fileLabel}）`);
    }
    seen.add(result.profile.id);
    parsed.push(result);
  }

  // 全部解析成功后再写入缓存：避免半途失败留下「半套准则」的脏缓存
  for (const { profile, rules } of parsed) {
    forbiddenRuleStore.set(profile.id, { codesKey: codesKey(profile.forbiddenAccounts), rules });
  }

  const profiles = parsed.map((item) => item.profile);
  const byId = new Map<AccountingStandardId, StandardProfile>(
    profiles.map((profile) => [profile.id, profile]),
  );
  const ids: AccountingStandardId[] = profiles.map((profile) => profile.id);
  Object.freeze(ids);

  const requireProfile = (id: string): StandardProfile => {
    const found = byId.get(id as AccountingStandardId);
    if (found === undefined) {
      const available = profiles.map((profile) => `${profile.id}（${profile.label}）`).join(' / ');
      throw new StandardConfigError(
        `未知会计准则「${id}」，${fileLabel} 中已定义的准则为：${available}`,
      );
    }
    return found;
  };

  return {
    ids,
    get: (id: AccountingStandardId) => requireProfile(id),
    all: () => profiles.slice(),
    has: (id: string) => byId.has(id as AccountingStandardId),
  };
}

/* ================================================================== */
/* 七、路径解析                                                        */
/* ================================================================== */

/** 科目表文件名：core/config.ts 的 loadAccounts 固定读这个文件名。 */
const CHART_FILE_NAME = 'chart-of-accounts.yaml';

/**
 * 展示用路径：统一用 / 分隔。
 * 配置文件和文档里写的都是 config/standard/...，报错信息如果冒出 Windows 反斜杠，
 * 用户按提示去改配置时会找不到对应文件；顺带让提示文案跨平台一致。
 */
function displayPath(path: string): string {
  const rel = relative(PROJECT_ROOT, path);
  return (rel === '' ? path : rel).split(sep).join('/');
}

/**
 * 把准则档案里的相对路径解析成绝对路径。
 *
 * 三种写法都支持（档案里混用很常见，与其让配置作者去猜，不如都认）：
 *   1. 绝对路径           → 原样规范化；
 *   2. 以 config/ 开头    → 按项目根解析（对应「项目根相对」写法，
 *                          如 config/standard/cas/chart-of-accounts.yaml）；
 *   3. 其它相对路径       → 按 config/standard/<准则 id>/ 解析（对应 contracts.ts 的
 *                          「相对 config/standard/<id>/」约定，如 chart-of-accounts.yaml）。
 *
 * @throws StandardConfigError 路径为空，或解析后落在项目根目录之外（防止 ..\..\ 读到项目外的文件）。
 */
export function resolveStandardFile(profile: StandardProfile, relPath: string): string {
  const raw = relPath.trim();
  if (raw === '') {
    throw new StandardConfigError(`准则「${profile.id}」的文件路径为空`);
  }

  let resolved: string;
  if (isAbsolute(raw)) {
    resolved = resolve(raw);
  } else if (raw === 'config' || raw.startsWith('config/') || raw.startsWith('config\\')) {
    resolved = resolve(PROJECT_ROOT, raw);
  } else {
    resolved = resolve(PROJECT_ROOT, 'config', 'standard', profile.id, raw);
  }

  const relativePath = relative(PROJECT_ROOT, resolved);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new StandardConfigError(
      `准则「${profile.id}」的路径「${raw}」解析后落在项目目录之外（${resolved}），已拒绝`,
    );
  }
  return resolved;
}

/* ================================================================== */
/* 八、科目表加载                                                      */
/* ================================================================== */

/** 科目表缓存：key = 科目表绝对路径。科目表是静态配置，一次解析反复使用。 */
const accountTableCache = new Map<string, AccountTable>();

/** 清空科目表缓存（配置热更新、单元测试隔离用）。 */
export function clearStandardAccountCache(): void {
  accountTableCache.clear();
}

/**
 * 加载某套准则的科目表。
 *
 * 复用 core/config.ts 的 loadAccounts()（见文件头说明），因此两套科目表与旧科目表
 * 的解析规则、defaultChild 下钻链校验完全一致。
 *
 * @throws StandardConfigError 科目表缺失、文件名不符合约定、YAML 结构错误。
 */
export function loadStandardAccounts(profile: StandardProfile): AccountTable {
  const chartPath = resolveStandardFile(profile, profile.chartFile);
  const cached = accountTableCache.get(chartPath);
  if (cached !== undefined) {
    return cached;
  }
  if (!existsSync(chartPath)) {
    throw new StandardConfigError(
      `准则「${profile.id}」的科目表文件不存在: ${chartPath}`,
    );
  }
  if (basename(chartPath) !== CHART_FILE_NAME) {
    throw new StandardConfigError(
      `准则「${profile.id}」的科目表文件名必须是 ${CHART_FILE_NAME}，实际为「${basename(chartPath)}」。` +
        `这是 core/config.ts 的 loadAccounts() 的约定，这样两套科目表才能复用同一套解析逻辑。`,
    );
  }

  let table: AccountTable;
  try {
    table = loadAccounts(dirname(chartPath));
  } catch (err) {
    throw new StandardConfigError(
      `加载准则「${profile.id}」科目表失败（${chartPath}）：${(err as Error).message}`,
    );
  }
  accountTableCache.set(chartPath, table);
  return table;
}

/* ================================================================== */
/* 九、科目准入判定                                                    */
/* ================================================================== */

/**
 * 取该准则的禁用规则。
 *
 * 优先用 loadStandardRegistry() 解析出的富文本规则（含法规依据对象）；
 * 若传入的 profile 不是注册表产物（或禁用清单被改过），退回内置知识表兜底，
 * 保证判定结果永远与「哪些编码被禁用」一致，只是说明文字朴素一些。
 */
export function listForbiddenAccounts(profile: StandardProfile): readonly ForbiddenAccountRule[] {
  const stored = forbiddenRuleStore.get(profile.id);
  if (stored !== undefined && stored.codesKey === codesKey(profile.forbiddenAccounts)) {
    return stored.rules;
  }
  return profile.forbiddenAccounts.map((code) => builtinRuleFor(code, profile));
}

/**
 * 「允许使用」时的法规依据。
 *
 * 为什么不直接返回 profile.basis：审核证据会随每条凭证行写入报告，
 * 把 8 条法律法规全塞进去既臃肿又不精确。允许某个科目存在的直接依据是
 * 「本准则的会计科目表里有这个科目」，也就是应用指南/附件那一条。
 */
function chartBasis(profile: StandardProfile): LawBasis[] {
  const hit = profile.basis.find(
    (item) => item.title.includes('会计科目') || item.title.includes('应用指南'),
  );
  return hit === undefined ? profile.basis.slice(0, 1) : [hit];
}

/** 科目编码匹配：本级或下级（.分隔）都算命中。 */
function matchesAccountCode(code: string, forbiddenCode: string): boolean {
  return code === forbiddenCode || code.startsWith(`${forbiddenCode}.`);
}

/** 科目名称归一化：去掉空白，取「总账/明细」形式里的最后一段。 */
function normalizeAccountName(name: string): string {
  const trimmed = name.replace(/\s+/g, '');
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function sameAccountName(left: string, right: string): boolean {
  return normalizeAccountName(left) === normalizeAccountName(right);
}

interface ResolvedAccountName {
  name: string;
  /** true = 科目表里就是这个编码；false = 由上级科目推断（企业自建的明细科目） */
  exact: boolean;
}

/**
 * 沿编码向上找最近的、科目表里存在的上级科目名称。
 *
 * 为什么需要：两套准则都允许企业自行增设明细科目，科目表里只列一级科目。
 * 判定「5301.01」时若只做精确匹配，就会得出「查无此科目」，进而把小企业准则下
 * 合法的「5301.01 营业外收入明细」误判成禁用的「5301 研发支出」。
 * 用上级科目的名称来判断，既保持保守，又不会误伤自建明细。
 */
function inheritAccountName(table: AccountTable, code: string): string | undefined {
  const dot = code.lastIndexOf('.');
  if (dot === -1) return undefined;
  const parentCode = code.slice(0, dot);
  const parent = table.get(parentCode);
  if (parent !== undefined) return parent.name;
  return inheritAccountName(table, parentCode);
}

/**
 * 取本次判定使用的科目名称：调用方传了就用，没传就用本准则科目表里的名称
 * （精确匹配不到时用最近一级上级科目的名称）。返回 undefined 表示确实无法确认，
 * 由调用方按保守原则处理。
 */
function resolveAccountName(
  profile: StandardProfile,
  code: string,
  provided: string | undefined,
): ResolvedAccountName | undefined {
  const trimmed = provided?.trim();
  if (trimmed !== undefined && trimmed !== '') {
    return { name: trimmed, exact: true };
  }
  try {
    const table = loadStandardAccounts(profile);
    const direct = table.get(code);
    if (direct !== undefined) {
      return { name: direct.name, exact: true };
    }
    const inherited = inheritAccountName(table, code);
    if (inherited !== undefined) {
      return { name: inherited, exact: false };
    }
  } catch {
    // 科目表尚未就绪（配置迁移中/文件被占用）时不阻断判定，
    // 由 checkAccountAllowed 的「保守判定」兜底，而不是让审核引擎整批报错
  }
  return undefined;
}

/**
 * 判定某科目能否在本准则下使用。
 *
 * 只回答「是否被禁用」，不回答「科目是否存在」——科目存在性由科目表与审核引擎的
 * 科目检查项负责（否则用户自建的明细科目会被误判）。
 *
 * @param accountCode 科目编码，如 1811、6602.05
 * @param accountName 科目名称，强烈建议传（凭证行上有）。不传时按本准则科目表的名称回填，
 *                    以便区分「5301 研发支出」（企业准则，禁用）与「5301 营业外收入」（小企业准则，允许）。
 */
export function checkAccountAllowed(
  profile: StandardProfile,
  accountCode: string,
  accountName?: string,
): AccountAllowance {
  const code = accountCode.trim();
  if (code === '') {
    throw new StandardConfigError('科目编码不能为空，无法判定准则准入');
  }

  const candidates = listForbiddenAccounts(profile).filter((rule) =>
    matchesAccountCode(code, rule.code),
  );
  if (candidates.length === 0) {
    return { allowed: true, basis: chartBasis(profile) };
  }

  const resolved = resolveAccountName(profile, code, accountName);

  for (const rule of candidates) {
    if (rule.name === undefined) {
      // 无条件禁用：本准则根本没有这个科目
      return { allowed: false, reason: rule.reason, basis: rule.basis };
    }
    if (resolved === undefined) {
      // 编码撞上禁用清单，但拿不到名称 → 保守判为禁用。
      // 合规场景下「不确定」不能等于「合规」，宁可让审核员看到一条待确认的 finding。
      return {
        allowed: false,
        reason:
          `科目编码「${code}」与企业会计准则专属科目重号，且无法确认科目名称，按保守原则判定为禁用。` +
          `${rule.reason}`,
        basis: rule.basis,
      };
    }
    if (sameAccountName(resolved.name, rule.name)) {
      return { allowed: false, reason: rule.reason, basis: rule.basis };
    }
  }

  // 编码重号但名称不同：这是另一套准则里同号的合法科目（如 5301 营业外收入）。
  // 放行，但把理由留下，审计追溯时能解释「为什么这条没报错」。
  const conflictNames = candidates
    .filter((rule) => rule.name !== undefined)
    .map((rule) => `「${rule.code} ${rule.name}」`)
    .join('或');
  const shownName = resolved?.name ?? '未知名称';
  const nameNote = resolved !== undefined && !resolved.exact ? '（按上级科目推断）' : '';
  return {
    allowed: true,
    reason:
      `科目编码「${code}」在${profile.label}下为「${shownName}」${nameNote}，` +
      `与禁用清单中的${conflictNames}不是同一科目（两套准则的编码体系不同），判定为允许使用。`,
    basis: chartBasis(profile),
  };
}

/* ================================================================== */
/* 十、完整性自检                                                      */
/* ================================================================== */

/**
 * 加载准则「整包」并做一致性自检：科目表可解析、规则目录存在、报表格式文件存在、
 * 科目表里没有混入禁用科目、requiredClosingAccounts 真实存在。
 *
 * 为什么要有这一步：准则切换是破坏性操作。切换前把「这套档案到底完不完整」一次性
 * 摆给用户看，比让他跑完记账、出表、报税之后才发现少了文件要好得多。
 *
 * @throws StandardConfigError 科目表不可用、科目表混入禁用科目、结转科目不存在
 *         —— 这三类属于配置自相矛盾，必须立刻阻断。
 */
export function loadStandardBundle(profile: StandardProfile): StandardBundle {
  const warnings: string[] = [];

  const table = loadStandardAccounts(profile);

  // 1) 科目表与禁用清单是否自相矛盾
  const conflicts = table.accounts.filter(
    (account) => !checkAccountAllowed(profile, account.code, account.name).allowed,
  );
  if (conflicts.length > 0) {
    const list = conflicts.map((account) => `${account.code} ${account.name}`).join('、');
    throw new StandardConfigError(
      `准则「${profile.label}」的科目表混入了本准则禁用的科目：${list}。` +
        `请修正 ${profile.chartFile} 或 standards.yaml 的 forbiddenAccounts。`,
    );
  }

  // 2) 期末结转科目是否真的存在（结账引擎依赖它们）
  const missingClosing = profile.requiredClosingAccounts.filter(
    (code) => table.get(code) === undefined,
  );
  if (missingClosing.length > 0) {
    throw new StandardConfigError(
      `准则「${profile.label}」的 requiredClosingAccounts 指向科目表中不存在的科目：${missingClosing.join('、')}`,
    );
  }

  // 3) 规则目录（缺失只告警不阻断：切换准则的过渡期允许先建科目表、后补规则）
  const mappingPath = resolveStandardFile(profile, profile.mappingDir);
  if (!existsSync(mappingPath)) {
    warnings.push(
      `准则「${profile.label}」的记账规则目录不存在：${displayPath(mappingPath)}。` +
        `在补齐规则前，该准则无法自动生成凭证（可用 loadRules 的兜底科目人工处理）。`,
    );
  } else {
    const files = readdirSync(mappingPath).filter(
      (file) => file.endsWith('.yaml') || file.endsWith('.yml'),
    );
    if (files.length === 0) {
      warnings.push(
        `准则「${profile.label}」的记账规则目录 ${displayPath(mappingPath)} 下没有任何 YAML 规则文件。`,
      );
    }
  }

  // 4) 报表格式文件（报表引擎的上游依赖）
  const statementPath = resolveStandardFile(profile, profile.statementFile);
  if (!existsSync(statementPath)) {
    warnings.push(
      `准则「${profile.label}」的报表格式文件尚未建立：${displayPath(statementPath)}。` +
        `报表引擎需要该文件才能出表。`,
    );
  }

  return { profile, chartLoaded: true, warnings };
}
