/**
 * 跨模块共享契约（Cross-module contracts）。
 *
 * 本文件是「记账 / 准则 / 税务 / 审核 / 报表 / 审计 / 申报」七个模块的唯一公共类型来源。
 * 任何模块不得在自己的文件里重复定义这里的类型，只能 import。
 *
 * 约定：
 *  1. 金额一律用 Cents（分）整数，绝不出现浮点元。
 *  2. 日期用 IsoDate（YYYY-MM-DD），期间用 Period（YYYY-MM）。
 *  3. 时间戳用 IsoDateTime（ISO-8601 带时区，例如 2024-01-31T18:00:00+08:00）。
 *  4. 所有「结论」都必须带 legalBasis（法规依据），没有依据的结论不允许出现在正式报告里。
 *  5. 所有「修改」都必须经过 VersionedRecord / AuditEvent，物理删除在类型层面被禁止。
 */

import type {
  Cents,
  Direction,
  DocumentRecord,
  ProcessingIssue,
  Provenance,
  Side,
  SourceKind,
  Voucher,
  VoucherLine,
} from './types.ts';

export type {
  Cents,
  Direction,
  DocumentRecord,
  ProcessingIssue,
  Provenance,
  Side,
  SourceKind,
  Voucher,
  VoucherLine,
};

/* ================================================================== */
/* 一、基础标量                                                        */
/* ================================================================== */

/** 日历日期，YYYY-MM-DD。 */
export type IsoDate = string;
/** ISO-8601 时间戳，必须带时区偏移。 */
export type IsoDateTime = string;
/** 会计期间，YYYY-MM。 */
export type Period = string;
/** 纳税识别号 / 统一社会信用代码。 */
export type TaxpayerId = string;

/** 严重程度。error 表示「不得进入下一环节」。 */
export type Severity = 'error' | 'warning' | 'info';

/** 引擎版本号，写入每一次产出的元数据，便于审计追溯。 */
export const ENGINE_VERSION = '2.0.0';

/* ================================================================== */
/* 二、会计准则                                                        */
/* ================================================================== */

/**
 * 支持的会计准则。
 *  cas   企业会计准则（财会〔2006〕3 号及后续修订）
 *  small 小企业会计准则（财会〔2011〕17 号）
 */
export type AccountingStandardId = 'cas' | 'small';

export const ACCOUNTING_STANDARD_LABEL: Record<AccountingStandardId, string> = {
  cas: '企业会计准则',
  small: '小企业会计准则',
};

/**
 * 两套准则在各业务环节的实质差异开关。
 * 核算、审核、报表三个引擎都按这里的分支走，而不是靠散落的 if 判断科目编码。
 */
export interface StandardFeatureFlags {
  /** 是否确认递延所得税（资产负债表债务法）。小企业准则为 false（应付税款法） */
  deferredTax: boolean;
  /** 是否允许公允价值计量 */
  fairValueMeasurement: boolean;
  /** 是否计提资产减值准备 */
  assetImpairment: boolean;
  /** 研发支出是否区分费用化/资本化 */
  developmentCapitalization: boolean;
  /** 收入确认是否采用五步法（合同资产/合同负债） */
  revenueFiveStep: boolean;
  /** 长期股权投资是否可用权益法 */
  equityMethod: boolean;
  /** 借款费用是否可资本化 */
  borrowingCostCapitalization: boolean;
  /** 是否确认使用权资产/租赁负债 */
  leaseCapitalization: boolean;
  /** 是否允许追溯调整（以前年度损益调整） */
  priorPeriodAdjustment: boolean;
  /** 是否要求编制现金流量表 */
  cashFlowStatement: boolean;
  /** 是否要求编制所有者权益变动表 */
  equityStatement: boolean;
  /** 是否要求编制附注 */
  notesRequired: boolean;
}

/** 准则档案。 */
export interface StandardProfile {
  id: AccountingStandardId;
  label: string;
  /** 法规依据 */
  basis: LawBasis[];
  /** 科目表文件（相对 config/standard/<id>/） */
  chartFile: string;
  /** 记账规则目录 */
  mappingDir: string;
  /** 报表格式文件 */
  statementFile: string;
  features: StandardFeatureFlags;
  /**
   * 该准则下禁止出现的科目编码（含前缀匹配）。
   * 审核引擎会检查凭证里是否出现这些科目，出现即 error。
   */
  forbiddenAccounts: string[];
  /** 该准则下必须存在、且必须做结转的科目（用于期末结账检查） */
  requiredClosingAccounts: string[];
  /** 一句话说明，用于 UI 顶部提示 */
  summary: string;
}

/** 加载结果：档案 + 科目表 + 报表格式。 */
export interface StandardBundle {
  profile: StandardProfile;
  /** 科目表原始定义（由 core/config.ts 的 AccountTable 承载时可为空） */
  chartLoaded: boolean;
  warnings: string[];
}

/* ================================================================== */
/* 三、法规依据                                                        */
/* ================================================================== */

/** 法规依据条目。任何审核结论都必须引用至少一条。 */
export interface LawBasis {
  /** 稳定 id，如 accounting-law / small-enterprise-standard / criminal-law-201 */
  id: string;
  /** 法规全称 */
  title: string;
  /** 条款，如「第九条」「第二百零一条」 */
  article?: string;
  /** 条款原文要点（用于在报告里直接展示，避免用户还要去翻法条） */
  excerpt?: string;
  /** 生效日期 */
  effectiveFrom?: IsoDate;
  /** 官方链接 */
  url?: string;
  /** 效力层级 */
  level?: 'law' | 'administrative-regulation' | 'departmental-rule' | 'normative-document' | 'standard';
}

/* ================================================================== */
/* 四、审核引擎                                                        */
/* ================================================================== */

/** 审核维度。 */
export type ReviewCategory =
  | 'accounting_law'      // 会计法
  | 'accounting_basis'    // 会计基础工作规范
  | 'accounting_system'   // 企业会计制度
  | 'standard'            // 企业会计准则 / 小企业会计准则
  | 'tax_law'             // 税收征管法、各税种实体法
  | 'criminal_law'        // 刑法（逃税罪、虚开发票罪）
  | 'internal_control'    // 内控与职责分离
  | 'data_quality';       // 数据完整性、勾稽

export const REVIEW_CATEGORY_LABEL: Record<ReviewCategory, string> = {
  accounting_law: '会计法',
  accounting_basis: '会计基础工作规范',
  accounting_system: '企业会计制度',
  standard: '会计准则',
  tax_law: '税收法规',
  criminal_law: '刑法',
  internal_control: '内部控制',
  data_quality: '数据质量',
};

/** 审核对象的引用。 */
export interface ReviewTarget {
  kind: 'voucher' | 'voucher_line' | 'document' | 'tax_return' | 'statement' | 'ledger' | 'policy' | 'run';
  /** 对象 id（凭证号 / 单据 id / 申报表 id …） */
  id: string;
  /** 人可读的定位串，如「记-0001 第 3 行」 */
  label?: string;
}

/** 单条审核结论。 */
export interface ReviewFinding {
  id: string;
  /** 触发它的检查项 id，如 VOUCHER-BALANCE-001 */
  ruleId: string;
  severity: Severity;
  category: ReviewCategory;
  /** 一句话结论 */
  title: string;
  /** 详细说明（发生了什么、为什么不合规） */
  detail: string;
  /** 处理建议（怎么改） */
  suggestion: string;
  /** 法规依据，至少一条 */
  basis: LawBasis[];
  target: ReviewTarget;
  /** 是否阻断流程：true 表示未整改不得进入下一环节 */
  blocking: boolean;
  /** 机器可读的证据，用于前端展开与二次核验 */
  evidence?: Record<string, unknown>;
  /** 是否已由人工豁免（必须填写理由与签署人） */
  waived?: WaiverRecord;
}

/** 人工豁免记录。 */
export interface WaiverRecord {
  actor: string;
  at: IsoDateTime;
  reason: string;
  /** 豁免必须留痕，且只能针对 warning/info，error 不允许豁免 */
  scope: 'warning' | 'info';
}

/** 审核报告。 */
export interface ReviewReport {
  id: string;
  /** 被审核的期间 */
  period: Period;
  standard: AccountingStandardId;
  /** 审核时间 */
  checkedAt: IsoDateTime;
  /** 引擎版本 */
  engineVersion: string;
  findings: ReviewFinding[];
  summary: ReviewSummary;
  /** 本次实际启用的检查项 id 与说明，用于证明「检查了什么」 */
  checksRun: CheckDescriptor[];
}

export interface ReviewSummary {
  total: number;
  error: number;
  warning: number;
  info: number;
  /** 阻断项数量 */
  blocking: number;
  /** 已人工豁免的数量 */
  waived: number;
  /** 0-100 合规得分 */
  score: number;
  /** error==0 且 blocking==0 时为 true */
  passed: boolean;
  /** 各维度的问题数 */
  byCategory: Partial<Record<ReviewCategory, number>>;
}

/** 检查项元数据。 */
export interface CheckDescriptor {
  id: string;
  title: string;
  category: ReviewCategory;
  severity: Severity;
  /** 该检查项的判定依据 */
  basis: LawBasis[];
  /** 是否可被配置关闭（监管强制的检查项不允许关闭） */
  configurable: boolean;
}

/** 审核引擎的输入。 */
export interface ReviewInput {
  period: Period;
  standard: AccountingStandardId;
  vouchers: readonly Voucher[];
  documents: readonly DocumentRecord[];
  /** 税务计算结果（尚未生成时可缺省） */
  taxReturns?: readonly TaxReturn[];
  /** 财务报表（尚未生成时可缺省） */
  statements?: readonly FinancialStatement[];
  /** 账簿数据（余额、发生额） */
  ledger?: LedgerSnapshot;
  /** 记账阶段产生的问题 */
  issues?: readonly ProcessingIssue[];
}

/** 单条检查项的签名。纯函数，便于单测。 */
export type CheckFn = (input: ReviewInput, ctx: ReviewContext) => ReviewFinding[];

export interface ReviewContext {
  standard: AccountingStandardId;
  period: Period;
  /** 检查项配置：id → 是否启用 / 严重度覆盖 */
  config: ReviewConfig;
  /** 生成 finding id 的计数器 */
  nextId: () => string;
}

export interface ReviewConfig {
  /** 强制关闭的检查项（监管强制项不允许关闭） */
  disabled: string[];
  /** 严重度覆盖 */
  severityOverrides: Record<string, Severity>;
  /** 是否在 error 存在时仍继续跑后续检查（默认 true，便于一次性列全） */
  continueOnError: boolean;
}

/* ================================================================== */
/* 五、税务引擎                                                        */
/* ================================================================== */

/** 支持的税种。 */
export type TaxType =
  | 'vat'          // 增值税
  | 'cit'          // 企业所得税
  | 'iit'          // 个人所得税（工资薪金）
  | 'surcharge'    // 附加税费（城建税 + 教育费附加 + 地方教育附加）
  | 'stamp'        // 印花税
  | 'property'     // 房产税
  | 'consumption'  // 消费税
  | 'resource'     // 资源税
  | 'vehicle_purchase'; // 车辆购置税

export const TAX_TYPE_LABEL: Record<TaxType, string> = {
  vat: '增值税',
  cit: '企业所得税',
  iit: '个人所得税',
  surcharge: '附加税费',
  stamp: '印花税',
  property: '房产税',
  consumption: '消费税',
  resource: '资源税',
  vehicle_purchase: '车辆购置税',
};

/** 纳税人身份。 */
export type TaxpayerKind = 'general' | 'small_scale';
/** 申报周期。 */
export type FilingCycle = 'monthly' | 'quarterly' | 'annual';

/** 申报表的一行。 */
export interface TaxLine {
  /** 行次/栏次编码，对应官方申报表栏次 */
  code: string;
  label: string;
  /** 金额（分）；纯比例/税额以外的栏次也用分表示，比例为 0-1 小数放在 rate 字段 */
  amount: Cents;
  /** 计算过程说明，必须可复核 */
  note?: string;
  /** 适用税率/征收率，用于税额栏 */
  rate?: number;
  /** 关联的法规依据 */
  basis?: LawBasis[];
}

/** 纳税调整项（企业所得税汇算核心）。 */
export interface TaxAdjustment {
  code: string;
  label: string;
  /** 调增为正、调减为负（分） */
  amount: Cents;
  reason: string;
  basis: LawBasis[];
  /** 数据来源，便于复核 */
  source?: string;
}

/** 税收优惠匹配结果。 */
export interface BenefitMatch {
  policyId: string;
  policyName: string;
  /** 是否满足条件 */
  eligible: boolean;
  /** 不满足时的原因 */
  reasons: string[];
  /** 满足条件时的测算减免额（分） */
  estimatedBenefit: Cents;
  basis: LawBasis[];
  /** 需要人工确认的条件（系统无法自动判定的部分） */
  manualChecks: string[];
}

/* -------------------------- 申报状态机 -------------------------- */

/**
 * 申报状态。
 *
 *  draft      草稿：系统自动生成，可任意修改，不可提交
 *  calculated 已计算：税额已算定，锁定计算口径，等待复核
 *  reviewed   已复核：复核人签署，可进入审批
 *  approved   已审批：审批人签署，**唯一允许导出的状态**
 *  filed      已申报：由人工在电子税务局完成申报后，回填「已申报」事实
 *  rejected   已退回：复核/审批不通过，退回草稿
 *  void       作废
 *
 * 铁律：系统**没有任何代码路径**可以把状态直接从 calculated 置为 filed。
 *      filed 只能通过 reportManualFiling() 记录「人工已完成申报」这一外部事实。
 */
export type FilingStatus =
  | 'draft'
  | 'calculated'
  | 'reviewed'
  | 'approved'
  | 'filed'
  | 'rejected'
  | 'void';

export const FILING_STATUS_LABEL: Record<FilingStatus, string> = {
  draft: '草稿',
  calculated: '已计算',
  reviewed: '已复核',
  approved: '已审批',
  filed: '已申报',
  rejected: '已退回',
  void: '已作废',
};

/** 签署角色。 */
export type SignRole = 'preparer' | 'reviewer' | 'approver';

/** 签署记录（不可修改，只能追加）。 */
export interface Signature {
  role: SignRole;
  /** 签署人姓名/工号 */
  actor: string;
  at: IsoDateTime;
  /** 签署方式：manual 手工确认 / totp 动态口令 / certificate 数字证书 */
  method: 'manual' | 'totp' | 'certificate';
  /** 签署时看到的计算摘要指纹，防止「签的不是算的那份」 */
  payloadHash: string;
  note?: string;
}

/** 状态迁移事件。 */
export interface FilingEvent {
  at: IsoDateTime;
  from: FilingStatus;
  to: FilingStatus;
  actor: string;
  reason?: string;
  /** 迁移是否由人工发起 */
  humanInitiated: boolean;
}

/** 税种的申报记录（本地台账，不是税务局回执）。 */
export interface TaxReturn {
  id: string;
  period: Period;
  taxType: TaxType;
  /** 纳税人识别号 */
  taxpayerId: TaxpayerId;
  standard: AccountingStandardId;
  status: FilingStatus;
  /** 版本号，每次重算 +1，历史版本保留 */
  version: number;
  lines: TaxLine[];
  adjustments: TaxAdjustment[];
  /** 本期应纳税额（分） */
  payable: Cents;
  /** 本期已预缴（分） */
  prepaid: Cents;
  /** 应补(退)税额 = payable - prepaid */
  due: Cents;
  /** 优惠政策匹配结果 */
  benefits: BenefitMatch[];
  /** 审核报告 id 与阻断项数量 */
  reviewId: string | null;
  blockingIssues: number;
  signatures: Signature[];
  events: FilingEvent[];
  /** 计算指纹（内容哈希），签署时校验 */
  payloadHash: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** 人工申报回填 */
  manualFiling?: ManualFilingRecord;
}

/** 人工在电子税务局完成申报后回填的事实。 */
export interface ManualFilingRecord {
  /** 申报渠道 */
  channel: 'etax-manual' | 'etax-client' | 'offline-window';
  /** 税务局受理回执号 */
  receiptNo: string;
  filedAt: IsoDateTime;
  /** 回填人 */
  actor: string;
  /** 实际缴款金额（分），可能与计算值不同（如享受了减免） */
  paidAmount: Cents;
  note?: string;
}

/* ================================================================== */
/* 六、财务报表                                                        */
/* ================================================================== */

export type StatementKind = 'balance_sheet' | 'income_statement' | 'cash_flow' | 'equity_change';

export const STATEMENT_KIND_LABEL: Record<StatementKind, string> = {
  balance_sheet: '资产负债表',
  income_statement: '利润表',
  cash_flow: '现金流量表',
  equity_change: '所有者权益变动表',
};

/** 报表行。 */
export interface StatementLine {
  /** 行次编码，对应官方报表格式的行次（如资产负债表「流动资产」） */
  code: string;
  label: string;
  /** 层级，用于缩进 */
  level: number;
  /** 本期金额（分）；表头行/合计行可为 null */
  amount: Cents | null;
  /** 上年同期/年初金额（分） */
  priorAmount?: Cents | null;
  /** 是否是合计行（加粗显示） */
  isTotal?: boolean;
  /** 取数逻辑说明，便于复核 */
  formula?: string;
}

/** 勾稽校验结果。 */
export interface StatementCheck {
  id: string;
  label: string;
  /** 期望值 - 实际值（分），0 表示通过 */
  diff: Cents;
  passed: boolean;
  detail: string;
}

/** 财务报表。 */
export interface FinancialStatement {
  id: string;
  kind: StatementKind;
  period: Period;
  standard: AccountingStandardId;
  lines: StatementLine[];
  checks: StatementCheck[];
  /** 报表整体是否通过勾稽 */
  passed: boolean;
  generatedAt: IsoDateTime;
  engineVersion: string;
}

/* -------------------------- 财务分析 -------------------------- */

/** 分析指标分组。 */
export type RatioGroup = 'solvency' | 'operation' | 'profitability' | 'growth' | 'cashflow' | 'quality';

export const RATIO_GROUP_LABEL: Record<RatioGroup, string> = {
  solvency: '偿债能力',
  operation: '营运能力',
  profitability: '盈利能力',
  growth: '发展能力',
  cashflow: '现金流量',
  quality: '盈余质量',
};

/** 单个财务指标。 */
export interface FinancialRatio {
  code: string;
  name: string;
  group: RatioGroup;
  /** 指标值（无量纲比率，保留 4 位小数）；无法计算时为 null */
  value: number | null;
  /** 单位，如 % / 次 / 倍 */
  unit: string;
  /** 计算公式 */
  formula: string;
  /** 行业参考区间 [低, 高]，可缺省 */
  benchmark?: [number, number] | null;
  /** 评价：good / watch / bad / unknown */
  rating: 'good' | 'watch' | 'bad' | 'unknown';
  /** 一句话解读 */
  comment: string;
}

/** 趋势分析：连续多期。 */
export interface TrendPoint {
  period: Period;
  value: Cents | number;
}

/** 杜邦分析。 */
export interface DupontBreakdown {
  roe: number | null;
  netProfitMargin: number | null;
  assetTurnover: number | null;
  equityMultiplier: number | null;
  /** 各因子对 ROE 变动的贡献（百分点） */
  contributions?: Record<string, number>;
}

/** 完整的财务分析报告。 */
export interface FinancialAnalysis {
  id: string;
  period: Period;
  standard: AccountingStandardId;
  generatedAt: IsoDateTime;
  ratios: FinancialRatio[];
  dupont: DupontBreakdown;
  /** 多期趋势 */
  trends: Record<string, TrendPoint[]>;
  /** 结构分析（收入构成、成本构成、费用构成） */
  structure: StructureAnalysis;
  /** 自动生成的结论段落 */
  narratives: NarrativeSection[];
  /** 风险预警 */
  alerts: AnalysisAlert[];
  /** 数据完整性问题（缺上期数据等） */
  dataNotes: string[];
}

export interface StructureAnalysis {
  revenueByCategory: Array<{ label: string; amount: Cents; share: number }>;
  costByCategory: Array<{ label: string; amount: Cents; share: number }>;
  expenseByCategory: Array<{ label: string; amount: Cents; share: number }>;
}

export interface NarrativeSection {
  title: string;
  /** Markdown 正文 */
  body: string;
  /** 支撑该结论的关键数字 */
  evidence: Array<{ label: string; value: string }>;
}

export interface AnalysisAlert {
  level: Severity;
  code: string;
  title: string;
  detail: string;
  /** 建议动作 */
  action: string;
}

/* ================================================================== */
/* 七、账簿快照                                                        */
/* ================================================================== */

/** 科目余额表一行。 */
export interface LedgerBalance {
  accountCode: string;
  accountName: string;
  /** 期初余额（分），借方为正 */
  opening: Cents;
  debitTotal: Cents;
  creditTotal: Cents;
  /** 期末余额（分），借方为正 */
  closing: Cents;
}

/** 账簿快照：报表、税务、审核都从这里取数，保证口径一致。 */
export interface LedgerSnapshot {
  period: Period;
  standard: AccountingStandardId;
  balances: LedgerBalance[];
  /** 本期凭证 */
  vouchers: readonly Voucher[];
  /** 期初是否已结平 */
  openingBalanced: boolean;
}

/* ================================================================== */
/* 八、审计与版本（软删除 / 历史版本表）                                */
/* ================================================================== */

/** 受版本控制的实体类型。 */
export type EntityKind =
  | 'voucher'
  | 'voucher_line'
  | 'document'
  | 'account'
  | 'tax_return'
  | 'statement'
  | 'policy'
  | 'settings'
  | 'user'
  | 'period_close'
  /** 审核报告：审核结论本身也要留痕，否则「谁放行的」无法追溯 */
  | 'review'
  /** 申报记录：状态迁移与签署必须可审计 */
  | 'filing'
  /** 一次月结运行 */
  | 'run';

/**
 * 历史版本记录（History Table 的一行）。
 *
 * 不变量：
 *  - 记录一旦写入永不物理删除、永不更新金额字段，只能追加新版本。
 *  - deleted=true 表示「软删除」：记录仍在，但在正常查询中被过滤。
 *  - validTo 为 null 表示该版本当前生效。
 */
export interface VersionRecord {
  /** 版本记录主键 */
  versionId: string;
  entity: EntityKind;
  /** 业务主键，如凭证 id */
  entityId: string;
  /** 从 1 开始的版本号 */
  version: number;
  /** 该版本的数据快照（JSON） */
  data: unknown;
  /** 生效时间 */
  validFrom: IsoDateTime;
  /** 失效时间；null 表示当前生效 */
  validTo: IsoDateTime | null;
  /** 软删除标记 */
  deleted: boolean;
  deletedAt?: IsoDateTime;
  deletedBy?: string;
  deletedReason?: string;
  createdBy: string;
  createdAt: IsoDateTime;
  /** 变更摘要 */
  changeSummary?: string;
}

/** 审计事件（只追加的事件流）。 */
export interface AuditEvent {
  /** 单调递增序号 */
  seq: number;
  id: string;
  at: IsoDateTime;
  actor: string;
  /** 动作类型 */
  action:
    | 'create'
    | 'update'
    | 'soft_delete'
    | 'restore'
    | 'approve'
    | 'reject'
    | 'sign'
    | 'export'
    | 'close_period'
    | 'reopen_period'
    | 'login'
    | 'config_change';
  entity: EntityKind;
  entityId: string;
  /** 变更前快照（create 时为 null） */
  before: unknown;
  /** 变更后快照（soft_delete 时保留被删数据） */
  after: unknown;
  reason?: string;
  /** 上一条事件的哈希，形成哈希链 */
  prevHash: string;
  /** 本条事件的哈希 = sha256(prevHash + 规范化 JSON) */
  hash: string;
}

/** 软删除请求。 */
export interface SoftDeleteRequest {
  entity: EntityKind;
  entityId: string;
  actor: string;
  reason: string;
  version: number;
}

/* ================================================================== */
/* 九、政策库与知识图谱                                                */
/* ================================================================== */

/** 政策生命周期状态。 */
export type PolicyLifecycle = 'effective' | 'amended' | 'superseded' | 'repealed' | 'draft';

/** 政策节点。 */
export interface PolicyNode {
  id: string;
  /** 文号，如「财政部 税务总局公告2023年第7号」 */
  documentNo: string;
  title: string;
  /** 发文机关 */
  issuer: string;
  /** 发布日期 */
  issuedAt: IsoDate;
  /** 施行日期 */
  effectiveFrom: IsoDate;
  /** 失效日期 */
  effectiveTo?: IsoDate;
  lifecycle: PolicyLifecycle;
  /** 涉及税种 */
  taxTypes: TaxType[];
  /** 层级：中央 / 地方 */
  level: 'central' | 'local';
  /** 地区代码（地方政策） */
  region?: string;
  /** 摘要 */
  summary: string;
  /** 关键条款 */
  keyPoints: string[];
  /** 正文链接 */
  url?: string;
  /** 标签，用于检索 */
  tags: string[];
}

/** 关系类型（对应「变化轨迹·关联图谱」）。 */
export type PolicyRelationType =
  | 'amends'        // 修改
  | 'supersedes'    // 替代
  | 'repeals'       // 废止
  | 'based_on'      // 制定依据
  | 'implements'    // 贯彻落实
  | 'parallel';     // 关联平行

export const POLICY_RELATION_LABEL: Record<PolicyRelationType, string> = {
  amends: '修改',
  supersedes: '替代',
  repeals: '废止',
  based_on: '制定依据',
  implements: '贯彻落实',
  parallel: '关联平行',
};

/** 政策关系边。 */
export interface PolicyRelation {
  id: string;
  from: string;
  to: string;
  type: PolicyRelationType;
  /** 关系说明 */
  note?: string;
}

/** 版本族：同一事项的历次文件。 */
export interface PolicyFamily {
  id: string;
  name: string;
  /** 按时间升序的政策 id */
  members: string[];
}

/* ================================================================== */
/* 十、编排（编排层共享的运行上下文）                                  */
/* ================================================================== */

/** 一次完整月结运行的产出。 */
export interface CloseRunResult {
  runId: string;
  period: Period;
  standard: AccountingStandardId;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime;
  vouchers: Voucher[];
  documents: DocumentRecord[];
  issues: ProcessingIssue[];
  review: ReviewReport;
  statements: FinancialStatement[];
  analysis: FinancialAnalysis;
  taxReturns: TaxReturn[];
  /** 是否需要人工复核 */
  requiresHumanReview: boolean;
  /** 阻断原因 */
  blockers: string[];
}
