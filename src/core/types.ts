/**
 * 全局类型契约。
 *
 * 数据流：
 *   原始文件 → RawWorkbook/RawText → DocumentRecord（业务单据）→ Voucher（记账凭证）
 *
 * 设计原则：
 *  1. 金额一律使用「分」为单位的整数（Cents），绝不使用浮点数参与运算。
 *  2. 每条分录都带 Provenance 溯源信息，可追溯到源文件的具体单元格行。
 *  3. 识别不确定的地方不猜，写入 warnings，交由人工复核。
 */

/** 以「分」为单位的整数金额。1 元 = 100 分。 */
export type Cents = number;

/** 支持的来源单据类型。 */
export type SourceKind =
  | 'bank'
  | 'invoice'
  | 'expense'
  | 'payroll'
  | 'contract'
  | 'unknown';

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  bank: '银行流水/对账单',
  invoice: '发票台账',
  expense: '报销单/费用明细',
  payroll: '工资表/社保公积金',
  contract: 'Word 合同/凭证文档',
  unknown: '未识别',
};

/** 资金流向。 */
export type Direction = 'in' | 'out' | 'none';

/** 借贷方向。 */
export type Side = 'debit' | 'credit';

/* ------------------------------------------------------------------ */
/* 一、原始读取层                                                       */
/* ------------------------------------------------------------------ */

export type CellValue = string | number | boolean | Date | null;

/** 一张工作表被规整后的二维数据。 */
export interface RawSheet {
  /** 工作表名称 */
  sheetName: string;
  /** 表头所在行（0 基） */
  headerRowIndex: number;
  /** 原始表头文本 */
  headers: string[];
  /** 数据行 */
  rows: RawRow[];
}

export interface RawRow {
  /** Excel 中的 1 基行号，用于溯源与报错定位 */
  rowNumber: number;
  /** 与 headers 等长的单元格值 */
  cells: CellValue[];
}

/** 从 Word/PDF 抽取的纯文本。 */
export interface RawText {
  text: string;
  paragraphCount: number;
}

/* ------------------------------------------------------------------ */
/* 二、业务单据层                                                       */
/* ------------------------------------------------------------------ */

/** 单据上可参与规则匹配的字段。 */
export type FieldValue = string | number | boolean | null;

export interface DocumentRecord {
  /** 稳定唯一 id，用于凭证号编排与去重 */
  id: string;
  kind: SourceKind;
  /** 业务日期 YYYY-MM-DD；无法识别时为 null */
  date: string | null;
  /** 摘要（用于规则匹配与凭证摘要） */
  summary: string;
  /** 金额（正数，分） */
  amount: Cents;
  direction: Direction;
  /** 往来单位：客户/供应商/员工 */
  counterparty: string | null;
  /** 不含税金额（分），仅发票类单据有值 */
  netAmount: Cents | null;
  /** 税额（分），仅发票类单据有值 */
  taxAmount: Cents | null;
  /** 各单据类型的专有字段，规则可通过 field.xxx 匹配 */
  fields: Record<string, FieldValue>;
  /** 原始数据溯源 */
  source: Provenance;
  warnings: string[];
}

export interface Provenance {
  file: string;
  sheet?: string;
  /** 1 基行号 */
  row?: number;
  /** 触发本次识别的规则 id */
  ruleId?: string;
  /** 原始摘要文本（未经加工） */
  rawSummary?: string;
}

/* ------------------------------------------------------------------ */
/* 三、记账凭证层                                                       */
/* ------------------------------------------------------------------ */

export interface VoucherLine {
  /** 科目编码，如 6602.05 */
  accountCode: string;
  /** 科目名称，如 管理费用/水电费 */
  accountName: string;
  debit: Cents;
  credit: Cents;
  /** 分录摘要 */
  summary: string;
  /** 辅助核算维度 */
  auxiliary?: Auxiliary;
  source: Provenance;
}

export interface Auxiliary {
  department?: string;
  customer?: string;
  supplier?: string;
  employee?: string;
  project?: string;
}

export interface Voucher {
  /** 凭证唯一 id */
  id: string;
  /** 记账日期 YYYY-MM-DD */
  date: string;
  /** 会计期间 YYYY-MM */
  period: string;
  /** 凭证字号，如 记-0001 */
  word: string;
  lines: VoucherLine[];
  /** 附单据数 */
  attachments: number;
  /** 是否借贷平衡 */
  balanced: boolean;
  /** 借方合计 */
  totalDebit: Cents;
  /** 贷方合计 */
  totalCredit: Cents;
  source: Provenance;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* 四、会计科目层                                                       */
/* ------------------------------------------------------------------ */

/** 科目类别，决定余额方向。 */
export type AccountCategory = 'asset' | 'liability' | 'equity' | 'cost' | 'profit';

export const ACCOUNT_CATEGORY_LABEL: Record<AccountCategory, string> = {
  asset: '资产',
  liability: '负债',
  equity: '所有者权益',
  cost: '成本',
  profit: '损益',
};

export interface AccountDef {
  /** 科目编码，层级用 . 分隔，如 2221.01.01 */
  code: string;
  name: string;
  category: AccountCategory;
  /** 余额方向 */
  balanceSide: Side;
  /** 父科目编码 */
  parent?: string;
  /** 是否明细科目（可挂分录） */
  leaf: boolean;
  /**
   * 默认下钻的明细科目。
   * 当规则引用了非明细的上级科目（如 1002 银行存款）时，
   * 系统会自动改用这里指定的明细科目（如 1002.01 基本户），并给出提示。
   * 这样给银行账户增设明细后，不必修改任何规则文件。
   */
  defaultChild?: string;
  /** 允许的辅助核算维度 */
  auxiliary?: Array<keyof Auxiliary>;
  /** 备注说明 */
  note?: string;
}

/* ------------------------------------------------------------------ */
/* 五、规则引擎层                                                       */
/* ------------------------------------------------------------------ */

/** 规则条件：所有声明的字段之间是「与」关系。 */
export interface RuleCondition {
  /** 摘要包含任一关键字 */
  summary?: string[];
  /** 摘要必须包含全部关键字 */
  summaryAll?: string[];
  /** 摘要匹配正则（不区分大小写） */
  summaryRegex?: string;
  /** 摘要不得包含任一关键字 */
  summaryNot?: string[];
  /** 资金方向 */
  direction?: Direction;
  /** 往来单位包含任一关键字 */
  counterparty?: string[];
  /** 往来单位正则 */
  counterpartyRegex?: string;
  /** 金额下限（元） */
  amountMin?: number;
  /** 金额上限（元） */
  amountMax?: number;
  /** 日期区间，含端点，YYYY-MM-DD */
  dateFrom?: string;
  dateTo?: string;
  /** 专有字段精确匹配，如 { invoiceType: "专用发票" } */
  fields?: Record<string, FieldValue>;
  /** 专有字段包含关键字，如 { goodsName: ["电费"] } */
  fieldContains?: Record<string, string[]>;
  /** 任一子条件成立（与其它条件仍为「与」） */
  anyOf?: RuleCondition[];
  /** 所有子条件成立 */
  allOf?: RuleCondition[];
  /** 子条件成立时取反 */
  not?: RuleCondition;
}

/**
 * 分录金额来源。
 *  - total      单据总金额
 *  - net        不含税金额
 *  - tax        税额
 *  - balanced   差额配平（自动取借贷差额，保证凭证平衡）
 *  - field.xxx  取单据专有字段（如 field.netPay、field.socialInsurance）
 */
export type AmountSource =
  | 'total'
  | 'net'
  | 'tax'
  | 'balanced'
  | `field.${string}`;

/** 单条分录模板。 */
export interface EntryTemplate {
  side: Side;
  /** 科目编码；支持 {field.xxx} 占位符 */
  account: string;
  /** 金额来源，默认为 total */
  amount?: AmountSource;
  /** 摘要模板，支持 {summary} {counterparty} {field.xxx} 占位符 */
  summary?: string;
  /** 辅助核算取值，如 { department: "{field.department}" } */
  auxiliary?: Partial<Record<keyof Auxiliary, string>>;
}

export interface RuleThen {
  /** 多借多贷分录模板 */
  entries: EntryTemplate[];
}

export interface Rule {
  id: string;
  /** 说明 */
  desc?: string;
  /** 适用单据类型；不写表示全部 */
  kinds?: SourceKind[];
  /** 优先级，越大越先匹配 */
  priority: number;
  when: RuleCondition;
  then: RuleThen;
  /** 命中后是否停止后续匹配，默认 true */
  stop?: boolean;
  /** 命中后附加的提示 */
  warn?: string;
}

/* ------------------------------------------------------------------ */
/* 六、处理结果层                                                       */
/* ------------------------------------------------------------------ */

export interface ProcessingIssue {
  level: 'error' | 'warning' | 'info';
  message: string;
  source: Provenance;
}

export interface ProcessResult {
  vouchers: Voucher[];
  documents: DocumentRecord[];
  issues: ProcessingIssue[];
  stats: ProcessStats;
}

export interface ProcessStats {
  files: number;
  documents: number;
  vouchers: number;
  /** 借贷平衡的凭证数 */
  balanced: number;
  /** 借方发生额合计（分） */
  totalDebit: Cents;
  /** 贷方发生额合计（分） */
  totalCredit: Cents;
  /** 未匹配到规则、需人工处理的单据数 */
  unmatched: number;
  /** 因判定为重复业务而跳过的单据数 */
  duplicates: number;
  byKind: Record<string, number>;
  elapsedMs: number;
}
