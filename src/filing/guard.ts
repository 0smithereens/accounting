/**
 * 申报闸门：前置条件校验 + 「不可能自动提交」的结构性禁令 + 流程配置。
 *
 * 这个文件回答三个问题：
 *   1. 什么时候**不许**进入下一步（前置条件）；
 *   2. 系统凭什么说自己**不会**自动申报（submitToTaxBureau 恒抛 + 无网络代码路径）；
 *   3. 企业可以放宽到什么程度（filing.yaml，但监管红线不可关闭）。
 *
 * 为什么提交禁令要写成「恒抛异常」而不是「弹窗提醒」？
 *   提醒是可以被忽略的，异常不行。只要没有合法返回值的函数，就不可能被上层当成正常流程调用；
 *   即使有人写了调用，也会在第一次执行时炸掉，而不是悄悄把数据发出去。
 *   配套的源码级测试（tests/filing.guard.test.ts）会扫描 src/filing/*.ts，
 *   确认整个模块里没有任何外发网络请求的代码（连一行都没有）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type {
  IsoDateTime,
  LawBasis,
  ManualFilingRecord,
  SignRole,
  Signature,
  TaxLine,
  TaxReturn,
} from '../core/contracts.ts';
import { FILING_STATUS_LABEL } from '../core/contracts.ts';
import { ConfigError, PROJECT_ROOT } from '../core/config.ts';
import { formatYuan, sumCents } from '../core/money.ts';
import { hashFilingPayload, latestSignature, nowIso } from './state-machine.ts';

/* ------------------------------------------------------------------ */
/* 一、错误类型                                                        */
/* ------------------------------------------------------------------ */

/** 申报流程的前置条件不满足（缺材料、缺签署、内容不自洽……）。 */
export class FilingGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilingGuardError';
  }
}

/** 复核人不得与制单人为同一人（自我复核）。 */
export class SelfReviewForbidden extends FilingGuardError {
  constructor(message: string) {
    super(message);
    this.name = 'SelfReviewForbidden';
  }
}

/** 审批人不得与复核人为同一人（四眼原则）。 */
export class FourEyesViolation extends FilingGuardError {
  constructor(message: string) {
    super(message);
    this.name = 'FourEyesViolation';
  }
}

/** 缺少某个角色的签署。 */
export class MissingSignatureError extends FilingGuardError {
  constructor(message: string) {
    super(message);
    this.name = 'MissingSignatureError';
  }
}

/** 未到「已审批」状态就导出申报底稿。 */
export class ExportNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportNotAllowedError';
  }
}

/** 签署基于旧版本的计算内容（签署后又被重算/修订）。 */
export class StaleSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleSignatureError';
  }
}

/** 任何试图向税务机关自动提交的行为。 */
export class AutoSubmissionForbidden extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoSubmissionForbidden';
  }
}

/* ------------------------------------------------------------------ */
/* 二、导出声明                                                        */
/* ------------------------------------------------------------------ */

/**
 * 每一份导出文件的表头都必须打印这句话。
 *
 * 文案是监管要求的一部分，不能只写在文档里：拿到 Excel 的人（可能是老板、可能是代账会计）
 * 第一眼就要知道「这张表不是申报成功凭证」，否则会误以为系统已经报过税。
 */
export const FILING_DECLARATION =
  '本文件为申报底稿，需由人工在电子税务局核对后自行申报，系统不代为提交。';

/* ------------------------------------------------------------------ */
/* 三、提交禁令（结构性不可能）                                        */
/* ------------------------------------------------------------------ */

export type FilingGuardAuditAction =
  | 'auto_submission_check'
  | 'submission_blocked'
  | 'export_allowed'
  | 'export_blocked'
  | 'signature_rejected';

/**
 * 闸门自身的审计留痕。
 *
 * 这里刻意不直接写 contracts.ts 的 AuditEvent（那需要哈希链与序号分配，属于 audit 模块），
 * 只记录「闸门做过什么判断」，由上层在持久化时转写为正式 AuditEvent。
 */
export interface FilingGuardAuditEntry {
  seq: number;
  at: IsoDateTime;
  action: FilingGuardAuditAction;
  detail: string;
  actor?: string;
}

const guardAuditTrail: FilingGuardAuditEntry[] = [];
let guardAuditSeq = 0;

/** 追加一条闸门审计记录（只追加，不提供删除接口）。 */
export function recordFilingGuardAudit(
  action: FilingGuardAuditAction,
  detail: string,
  actor?: string,
): FilingGuardAuditEntry {
  guardAuditSeq += 1;
  const entry: FilingGuardAuditEntry = {
    seq: guardAuditSeq,
    at: nowIso(),
    action,
    detail,
    actor,
  };
  guardAuditTrail.push(entry);
  return entry;
}

/** 读取闸门审计流水（返回副本，防止外部改写历史）。 */
export function getFilingGuardAuditTrail(): readonly FilingGuardAuditEntry[] {
  return guardAuditTrail.slice();
}

/**
 * 恒通过，但一定留痕。
 *
 * 为什么需要这个函数？因为它给「我们确实检查过」留下了一条可举证的时间点记录。
 * 它永远不会抛错——它的职责不是拦截，而是把「本次操作不包含自动提交」写进审计日志。
 */
export function assertNoAutoSubmission(): void {
  recordFilingGuardAudit(
    'auto_submission_check',
    '已确认：本次操作不包含任何向税务机关自动提交的代码路径，输出仅为申报底稿',
  );
}

/**
 * 提交到税务局——恒抛异常，永远不可能成功。
 *
 * 保留这个导出是为了「显式失败」：任何调用方都会在第一时间收到 AutoSubmissionForbidden，
 * 而不是在 try/catch 里被静默吞掉后误以为提交成功。
 */
export function submitToTaxBureau(...args: unknown[]): never {
  recordFilingGuardAudit(
    'submission_blocked',
    `拦截一次向税务机关自动提交的调用（实参 ${args.length} 个）`,
  );
  throw new AutoSubmissionForbidden(
    '系统禁止自动向税务机关提交申报。申报底稿必须由人工在电子税务局核对后自行申报，' +
      '申报完成后再通过 reportManualFiling() 回填受理回执号。',
  );
}

/* ------------------------------------------------------------------ */
/* 四、流程配置                                                        */
/* ------------------------------------------------------------------ */

export const SIGN_ROLE_LABEL: Record<SignRole, string> = {
  preparer: '制单人',
  reviewer: '复核人',
  approver: '审批人',
};

export interface FilingRoleConfig {
  role: SignRole;
  label: string;
  description: string;
  /** 该角色负责的动作（用于待办列表与权限校验） */
  actions: string[];
}

/** 申报必备材料。导出时作为人工申报前的自查清单。 */
export interface FilingMaterialConfig {
  id: string;
  label: string;
  /** true 表示缺了就不能申报；false 为建议材料 */
  required: boolean;
  description: string;
  /** 要求该材料的法规依据 */
  basis: LawBasis[];
}

export interface FilingConfig {
  /** 配置文件所在目录 */
  configDir: string;
  /** 配置文件绝对路径 */
  sourceFile: string;
  version: number;
  /** 四眼原则：审批人 ≠ 复核人 */
  fourEyes: boolean;
  /** 是否允许复核人 = 制单人 */
  allowSelfReview: boolean;
  /** 进入复核前是否必须有审核报告（reviewId 非空） */
  requireReviewReport: boolean;
  /** 是否要求制单人签署（calculate 时自动记录） */
  requirePreparerSignature: boolean;
  /** 作废理由最短字数 */
  minVoidReasonLength: number;
  /** 已申报后是否仍允许作废（作废只置状态，不删除数据） */
  allowVoidAfterFiled: boolean;
  /** 导出文件名前缀 */
  exportFilePrefix: string;
  /** 导出文件表头声明 */
  exportDeclaration: string;
  roles: Record<SignRole, FilingRoleConfig>;
  requiredMaterials: FilingMaterialConfig[];
}

const DEFAULT_ROLES: Record<SignRole, FilingRoleConfig> = {
  preparer: {
    role: 'preparer',
    label: '制单人（税务会计）',
    description: '负责税额计算与申报表填制，对计算口径负责。',
    actions: ['calculate', 'revise'],
  },
  reviewer: {
    role: 'reviewer',
    label: '复核人（税务主管）',
    description: '独立复核计算过程与法规依据，对「算得对不对」负责。',
    actions: ['review', 'reject'],
  },
  approver: {
    role: 'approver',
    label: '审批人（财务负责人）',
    description: '对「报不报、报多少」做最终决定，并负责人工申报与回填。',
    actions: ['approve', 'exportForFiling', 'reportManualFiling', 'void'],
  },
};

/**
 * 缺省配置（不读文件）。
 *
 * 用于 exportFilingPackage 这种拿不到配置对象的纯函数场景，
 * 也用于配置缺省项的兜底。所有开关都取**最保守**的取值。
 */
export function defaultFilingConfig(configDir = ''): FilingConfig {
  return {
    configDir,
    sourceFile: '',
    version: 1,
    fourEyes: true,
    allowSelfReview: false,
    requireReviewReport: true,
    requirePreparerSignature: true,
    minVoidReasonLength: 4,
    allowVoidAfterFiled: true,
    exportFilePrefix: '申报底稿',
    exportDeclaration: FILING_DECLARATION,
    roles: {
      preparer: { ...DEFAULT_ROLES.preparer },
      reviewer: { ...DEFAULT_ROLES.reviewer },
      approver: { ...DEFAULT_ROLES.approver },
    },
    requiredMaterials: [],
  };
}

export const FILING_CONFIG_FILE = 'filing.yaml';

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

function optionalBoolean(value: unknown, fallback: boolean, context: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${context} 必须是 true / false，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalNumber(value: unknown, fallback: number, context: string): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${context} 必须是数字，实际为 ${JSON.stringify(value)}`);
  }
  return n;
}

function stringArray(value: unknown, context: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ConfigError(`${context} 应为字符串数组，实际为 ${JSON.stringify(value)}`);
  }
  return value.map((item) => String(item));
}

const BASIS_LEVELS: ReadonlyArray<LawBasis['level']> = [
  'law',
  'administrative-regulation',
  'departmental-rule',
  'normative-document',
  'standard',
];

function parseBasis(raw: unknown, context: string): LawBasis {
  if (!isRecord(raw)) throw new ConfigError(`${context} 应为对象`);
  const basis: LawBasis = {
    id: requireString(raw['id'], `${context}.id`),
    title: requireString(raw['title'], `${context}.title`),
  };
  const article = optionalString(raw['article']);
  if (article !== undefined) basis.article = article;
  const excerpt = optionalString(raw['excerpt']);
  if (excerpt !== undefined) basis.excerpt = excerpt;
  const effectiveFrom = optionalString(raw['effectiveFrom']);
  if (effectiveFrom !== undefined) basis.effectiveFrom = effectiveFrom;
  const url = optionalString(raw['url']);
  if (url !== undefined) basis.url = url;
  const level = optionalString(raw['level']);
  if (level !== undefined) {
    if (!BASIS_LEVELS.includes(level as LawBasis['level'])) {
      throw new ConfigError(
        `${context}.level 必须是 ${BASIS_LEVELS.join(' / ')}，实际为 ${level}`,
      );
    }
    basis.level = level as LawBasis['level'];
  }
  return basis;
}

function parseRoles(raw: unknown): Record<SignRole, FilingRoleConfig> {
  const result: Record<SignRole, FilingRoleConfig> = {
    preparer: { ...DEFAULT_ROLES.preparer },
    reviewer: { ...DEFAULT_ROLES.reviewer },
    approver: { ...DEFAULT_ROLES.approver },
  };
  if (raw === undefined || raw === null) return result;
  if (!isRecord(raw)) throw new ConfigError('filing.yaml roles 应为对象');

  for (const key of Object.keys(raw)) {
    if (key !== 'preparer' && key !== 'reviewer' && key !== 'approver') {
      throw new ConfigError(
        `filing.yaml roles 含未知角色「${key}」，可用 preparer / reviewer / approver`,
      );
    }
  }

  for (const role of ['preparer', 'reviewer', 'approver'] as const) {
    const item = raw[role];
    if (item === undefined) continue;
    if (!isRecord(item)) throw new ConfigError(`filing.yaml roles.${role} 应为对象`);
    const base = result[role];
    result[role] = {
      role,
      label: optionalString(item['label']) ?? base.label,
      description: optionalString(item['description']) ?? base.description,
      actions: stringArray(item['actions'], `roles.${role}.actions`) ?? base.actions,
    };
  }
  return result;
}

function parseMaterials(raw: unknown): FilingMaterialConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigError('filing.yaml requiredMaterials 应为数组');
  return raw.map((item, index) => {
    const context = `requiredMaterials[${index}]`;
    if (!isRecord(item)) throw new ConfigError(`${context} 应为对象`);
    const basisRaw = item['basis'];
    const basis: LawBasis[] = [];
    if (Array.isArray(basisRaw)) {
      basisRaw.forEach((b, i) => basis.push(parseBasis(b, `${context}.basis[${i}]`)));
    } else if (basisRaw !== undefined && basisRaw !== null) {
      throw new ConfigError(`${context}.basis 应为数组`);
    }
    return {
      id: requireString(item['id'], `${context}.id`),
      label: requireString(item['label'], `${context}.label`),
      required: optionalBoolean(item['required'], true, `${context}.required`),
      description: optionalString(item['description']) ?? '',
      basis,
    };
  });
}

/**
 * 加载申报流程配置。
 *
 * 配置缺失直接报错而不是静默用默认值：申报流程的开关关系到内控是否成立，
 * 「配置文件丢了所以悄悄允许自我复核」这种事绝不能发生。
 */
export function loadFilingConfig(configDir: string = join(PROJECT_ROOT, 'config')): FilingConfig {
  const sourceFile = join(configDir, FILING_CONFIG_FILE);
  if (!existsSync(sourceFile)) {
    throw new ConfigError(
      `申报流程配置文件不存在: ${sourceFile}。请从仓库恢复 config/${FILING_CONFIG_FILE}，` +
        '或显式传入 configDir。申报流程不允许在缺少内控配置的情况下运行。',
    );
  }

  const raw = readFileSync(sourceFile, 'utf8');
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`YAML 解析失败 ${sourceFile}: ${(err as Error).message}`);
  }
  if (!isRecord(doc)) {
    throw new ConfigError(`${sourceFile} 顶层应为对象`);
  }

  const knownKeys = new Set(['version', 'workflow', 'roles', 'requiredMaterials', 'export']);
  for (const key of Object.keys(doc)) {
    if (!knownKeys.has(key)) {
      throw new ConfigError(
        `${FILING_CONFIG_FILE} 含未知顶层字段「${key}」，可用：${[...knownKeys].join(' / ')}`,
      );
    }
  }

  const workflowRaw = doc['workflow'];
  if (workflowRaw !== undefined && !isRecord(workflowRaw)) {
    throw new ConfigError(`${FILING_CONFIG_FILE} workflow 应为对象`);
  }
  const workflow = isRecord(workflowRaw) ? workflowRaw : {};
  const workflowKeys = new Set([
    'fourEyes',
    'allowSelfReview',
    'requireReviewReport',
    'requirePreparerSignature',
    'minVoidReasonLength',
    'allowVoidAfterFiled',
  ]);
  for (const key of Object.keys(workflow)) {
    if (!workflowKeys.has(key)) {
      throw new ConfigError(
        `${FILING_CONFIG_FILE} workflow 含未知字段「${key}」，可用：${[...workflowKeys].join(' / ')}`,
      );
    }
  }

  const exportRaw = doc['export'];
  if (exportRaw !== undefined && !isRecord(exportRaw)) {
    throw new ConfigError(`${FILING_CONFIG_FILE} export 应为对象`);
  }
  const exportSection = isRecord(exportRaw) ? exportRaw : {};
  for (const key of Object.keys(exportSection)) {
    if (key !== 'filePrefix' && key !== 'declaration') {
      throw new ConfigError(
        `${FILING_CONFIG_FILE} export 含未知字段「${key}」，可用：filePrefix / declaration`,
      );
    }
  }

  const config: FilingConfig = {
    configDir,
    sourceFile,
    version: Math.trunc(optionalNumber(doc['version'], 1, `${FILING_CONFIG_FILE}.version`)),
    fourEyes: optionalBoolean(workflow['fourEyes'], true, 'workflow.fourEyes'),
    allowSelfReview: optionalBoolean(workflow['allowSelfReview'], false, 'workflow.allowSelfReview'),
    requireReviewReport: optionalBoolean(
      workflow['requireReviewReport'],
      true,
      'workflow.requireReviewReport',
    ),
    requirePreparerSignature: optionalBoolean(
      workflow['requirePreparerSignature'],
      true,
      'workflow.requirePreparerSignature',
    ),
    minVoidReasonLength: Math.max(
      1,
      Math.trunc(
        optionalNumber(
          workflow['minVoidReasonLength'],
          4,
          'workflow.minVoidReasonLength',
        ),
      ),
    ),
    allowVoidAfterFiled: optionalBoolean(
      workflow['allowVoidAfterFiled'],
      true,
      'workflow.allowVoidAfterFiled',
    ),
    exportFilePrefix: optionalString(exportSection['filePrefix']) ?? '申报底稿',
    exportDeclaration: optionalString(exportSection['declaration']) ?? FILING_DECLARATION,
    roles: parseRoles(doc['roles']),
    requiredMaterials: parseMaterials(doc['requiredMaterials']),
  };

  // 监管红线：四眼原则与「禁止自我复核」可以在极端场景下由企业书面授权关闭，
  // 但关闭后必须能在审计日志里看到（这里只做提示，不做拦截）。
  return config;
}

/* ------------------------------------------------------------------ */
/* 五、前置条件断言                                                    */
/* ------------------------------------------------------------------ */

export interface FilingGuards {
  /** 审核报告是否通过。缺省用 ret.reviewId !== null && ret.blockingIssues === 0 */
  isReviewPassed?: (ret: TaxReturn) => boolean;
  /** 阻断项数量。缺省用 ret.blockingIssues */
  blockingCount?: (ret: TaxReturn) => number;
}

/** 操作人必须实名（工号/姓名），匿名操作在审计上等于没有发生。 */
export function normalizeActor(actor: string, label: string): string {
  const value = typeof actor === 'string' ? actor.trim() : '';
  if (value === '') {
    throw new FilingGuardError(`${label}（actor）不能为空：申报流程的每一步都必须可追溯到具体的人`);
  }
  return value;
}

/** 理由类字段的最小长度校验。 */
export function normalizeReason(reason: string, label: string, minLength = 2): string {
  const value = typeof reason === 'string' ? reason.trim() : '';
  if (value.length < minLength) {
    throw new FilingGuardError(
      `${label}不能为空且至少 ${minLength} 个字（当前 ${value.length} 字）：退回、修订、作废都必须说明原因`,
    );
  }
  return value;
}

/**
 * 判断某一行是否是「本期应纳税额」行。
 *
 * 为什么要有这个约定？因为 TaxLine 只有栏次编码与标签，没有「金额类型」字段。
 * 与其要求税务引擎额外加字段（会破坏契约），不如约定一个可读的编码/标签习惯：
 * 引擎把应纳税额单独写成一行（PAYABLE / 本期应纳税额），工作流就能做勾稽校验。
 * 认不出来时退化为「不勾稽但留痕」，不会因为约定不一致而卡死整条流程。
 */
const PAYABLE_CODE_PATTERN = /^(PAYABLE|TAX_DUE|TAX_PAYABLE|TAXPAYABLE)$/;
const PAYABLE_LABEL_PATTERN = /应纳税额|本期应纳/;
/**
 * 这些标签一定**不是**「应纳税额」行：
 * 应补(退)税额是 payable - prepaid 的结果，已预缴/减免是抵减项，
 * 把它们算进应纳税额合计会得出一个永远对不上的勾稽结果。
 */
const PAYABLE_LABEL_EXCLUDE = /应补|应退|预缴|已缴|减免/;

/**
 * 选出「最终应纳税额」行，用于勾稽。
 *
 * 优先级：
 *  1. 栏次编码精确等于 PAYABLE / TAX_DUE / TAX_PAYABLE / TAXPAYABLE；
 *  2. 标签恰好为「应纳税额」或「本期应纳税额」的行（不加不减）；
 *  3. 退化为所有宽松命中的行。
 */
export function selectFinalPayableLines(lines: readonly TaxLine[]): TaxLine[] {
  const byCode = lines.filter((line) => {
    const code = typeof line.code === 'string' ? line.code.trim().toUpperCase() : '';
    return PAYABLE_CODE_PATTERN.test(code);
  });
  if (byCode.length > 0) return byCode;

  // 「应纳税额」是最具体的名字（对应申报表 19 栏，即减征后的最终数）；
  // 「本期应纳税额」（15 栏）是减征前的全额，只在没有更具体的行时才用。
  const finalLine = lines.filter((line) => typeof line.label === 'string' && line.label.trim() === '应纳税额');
  if (finalLine.length > 0) return finalLine;

  const currentLine = lines.filter((line) => typeof line.label === 'string' && line.label.trim() === '本期应纳税额');
  if (currentLine.length > 0) return currentLine;

  return lines.filter((line) => isPayableLine(line));
}

export function isPayableLine(line: TaxLine): boolean {
  const code = typeof line.code === 'string' ? line.code.trim().toUpperCase() : '';
  if (PAYABLE_CODE_PATTERN.test(code)) return true;
  if (typeof line.label !== 'string') return false;
  if (PAYABLE_LABEL_EXCLUDE.test(line.label)) return false;
  return PAYABLE_LABEL_PATTERN.test(line.label);
}

/**
 * 申报行与应纳税额的自洽性校验。
 *
 * 检查三件事：
 *   1. 有申报行（空表不能算税）；
 *   2. 所有金额都是整数「分」（浮点元一旦进来，后面所有勾稽都会差一分钱）；
 *   3. 若申报表里有「应纳税额」行，它的合计必须等于 payable。
 */
export function assertLinesConsistent(ret: TaxReturn): void {
  if (!Array.isArray(ret.lines) || ret.lines.length === 0) {
    throw new FilingGuardError(
      `申报表「${ret.id}」没有任何申报行，不能计算税额。请先由税务引擎生成申报行。`,
    );
  }
  if (!Number.isSafeInteger(ret.payable)) {
    throw new FilingGuardError(
      `应纳税额必须是整数「分」，实际为 ${String(ret.payable)}。禁止用浮点元参与税额计算。`,
    );
  }
  if (!Number.isSafeInteger(ret.prepaid)) {
    throw new FilingGuardError(
      `已预缴税额必须是整数「分」，实际为 ${String(ret.prepaid)}。`,
    );
  }

  for (const line of ret.lines) {
    if (typeof line.code !== 'string' || line.code.trim() === '') {
      throw new FilingGuardError(`申报行「${line.label}」缺少栏次编码（code）。`);
    }
    if (!Number.isSafeInteger(line.amount)) {
      throw new FilingGuardError(
        `申报行「${line.code} ${line.label}」金额必须是整数「分」，实际为 ${String(line.amount)}。`,
      );
    }
    if (line.rate !== undefined && (!Number.isFinite(line.rate) || line.rate < 0 || line.rate > 1)) {
      throw new FilingGuardError(
        `申报行「${line.code} ${line.label}」税率必须在 0~1 之间（如 0.13 表示 13%），实际为 ${String(line.rate)}。`,
      );
    }
  }

  for (const adjustment of ret.adjustments) {
    if (!Number.isSafeInteger(adjustment.amount)) {
      throw new FilingGuardError(
        `纳税调整项「${adjustment.code} ${adjustment.label}」金额必须是整数「分」，实际为 ${String(adjustment.amount)}。`,
      );
    }
    if (adjustment.basis.length === 0) {
      throw new FilingGuardError(
        `纳税调整项「${adjustment.code} ${adjustment.label}」缺少法规依据：调整必须写明依据哪一条。`,
      );
    }
  }

  // 找出「最终应纳税额」行。
  //
  // 为什么不能简单地把所有 isPayableLine 的行加起来：
  //  增值税申报表里同时存在 15「本期应纳税额」（按 3% 全额）、
  //  16「本期应纳税额减征额」、19「应纳税额」（减征后的最终数）。
  //  三者都含「应纳税额」字样，加总必然与 payable 对不上，
  //  结果是每一张减按征收的申报表都永远无法复核——闸门变成了死锁。
  const payableLines = selectFinalPayableLines(ret.lines);
  if (payableLines.length > 0) {
    const total = sumCents(payableLines.map((line) => line.amount));
    if (total !== ret.payable) {
      throw new FilingGuardError(
        `应纳税额与申报表勾稽不符：payable = ${formatYuan(ret.payable)} 元，` +
          `申报表「应纳税额」行合计 = ${formatYuan(total)} 元，差额 ${formatYuan(ret.payable - total)} 元。` +
          '请先修正申报行或应纳税额，再进入复核。',
      );
    }
  }
}

/**
 * 整表完整性：勾稽 + 指纹。
 *
 * 指纹校验是防篡改的关键：如果有人在内存里改了 lines 却没重算，
 * payloadHash 仍等于旧签署的指纹，但 hashFilingPayload(当前内容) 会对不上。
 */
export function assertReturnIntegrity(ret: TaxReturn): void {
  assertLinesConsistent(ret);
  const expectedDue = ret.payable - ret.prepaid;
  if (ret.due !== expectedDue) {
    throw new FilingGuardError(
      `应补(退)税额勾稽不符：due = ${formatYuan(ret.due)} 元，` +
        `payable - prepaid = ${formatYuan(expectedDue)} 元。`,
    );
  }
  const expectedHash = hashFilingPayload(ret);
  if (ret.payloadHash !== expectedHash) {
    throw new FilingGuardError(
      `申报内容与计算指纹不一致（内容被改动但没有重新计算）。` +
        `当前指纹 ${ret.payloadHash.slice(0, 12)}…，重算指纹 ${expectedHash.slice(0, 12)}…。` +
        '请重新执行 calculate() 生成新版本。',
    );
  }
}

/**
 * 复核前的审核报告校验。
 *
 * 审核模块是独立开发的，所以这里用回调注入而不是直接 import：
 * 工作流只关心「有没有报告、阻断项是否为 0」，不关心报告怎么生成。
 */
export function assertReviewPassed(
  ret: TaxReturn,
  guards: FilingGuards,
  config: FilingConfig,
): void {
  const blocking = guards.blockingCount?.(ret) ?? ret.blockingIssues;
  if (!Number.isFinite(blocking) || blocking < 0) {
    throw new FilingGuardError(`阻断项数量非法：${String(blocking)}。`);
  }
  if (blocking > 0) {
    throw new FilingGuardError(
      `审核报告仍有 ${blocking} 个阻断项，不能进入复核。请先整改（或由有权限的人对 warning 级问题做豁免）。`,
    );
  }
  if (config.requireReviewReport && (ret.reviewId === null || ret.reviewId.trim() === '')) {
    throw new FilingGuardError(
      `缺少审核报告（reviewId 为空）。配置要求「先审核、后复核」：` +
        '没有审核报告就无法证明检查过什么，复核人签的是一张没有依据的表。',
    );
  }
  const passed =
    guards.isReviewPassed?.(ret) ??
    (ret.blockingIssues === 0 && (!config.requireReviewReport || ret.reviewId !== null));
  if (!passed) {
    throw new FilingGuardError('审核报告未通过（isReviewPassed 返回 false），不能进入复核。');
  }
}

/** 自我复核拦截：复核人不得与制单人为同一人。 */
export function assertReviewerEligible(
  ret: TaxReturn,
  reviewerActor: string,
  config: FilingConfig,
): void {
  const reviewer = normalizeActor(reviewerActor, '复核人');
  if (config.allowSelfReview) return;
  const preparer = latestSignature(ret, 'preparer');
  if (preparer === undefined) return;
  if (preparer.actor === reviewer) {
    throw new SelfReviewForbidden(
      `复核人「${reviewer}」与制单人为同一人，禁止自我复核。` +
        '税额计算与复核必须由不同的人完成（配置项 workflow.allowSelfReview = false）。',
    );
  }
}

/** 四眼原则：审批人不得与复核人为同一人。 */
export function assertFourEyes(
  ret: TaxReturn,
  approverActor: string,
  config: FilingConfig,
): void {
  const approver = normalizeActor(approverActor, '审批人');
  const reviewer = latestSignature(ret, 'reviewer');
  if (reviewer === undefined) {
    throw new MissingSignatureError(
      `申报表「${ret.id}」缺少复核人签署，不能进入审批。`,
    );
  }
  if (config.fourEyes && reviewer.actor === approver) {
    throw new FourEyesViolation(
      `审批人「${approver}」与复核人相同，违反四眼原则。` +
        '同一人既复核又审批，等于没有复核（配置项 workflow.fourEyes = true）。',
    );
  }
}

/** 签署齐备性校验（只检查是否存在，不检查是否过期）。 */
export function assertSignaturesComplete(ret: TaxReturn, config: FilingConfig): void {
  const required: readonly SignRole[] = config.requirePreparerSignature
    ? ['preparer', 'reviewer', 'approver']
    : ['reviewer', 'approver'];
  const missing = required.filter((role) => latestSignature(ret, role) === undefined);
  if (missing.length > 0) {
    throw new MissingSignatureError(
      `申报表「${ret.id}」缺少${missing.map((role) => `「${SIGN_ROLE_LABEL[role]}」`).join('、')}签署，` +
        '不能导出或申报。',
    );
  }
}

/**
 * 签署新鲜度校验：签名必须基于**当前**这一版计算内容。
 *
 * 场景：复核人签完字，制单人又改了一版（退回→修订→重算），
 * 此时旧签名的 payloadHash 指向上一版内容。若不校验，就会出现「签的是 A 版、报的是 B 版」。
 */
export function assertSignaturesFresh(
  ret: TaxReturn,
  roles: readonly SignRole[] = ['preparer', 'reviewer', 'approver'],
): void {
  for (const role of roles) {
    const signature = latestSignature(ret, role);
    if (signature === undefined) continue;
    if (signature.payloadHash !== ret.payloadHash) {
      recordFilingGuardAudit(
        'signature_rejected',
        `申报表 ${ret.id} 的「${SIGN_ROLE_LABEL[role]}」签署指纹过期`,
        signature.actor,
      );
      throw new StaleSignatureError(
        `「${SIGN_ROLE_LABEL[role]}」${signature.actor} 的签署基于旧版本计算` +
          `（签署指纹 ${signature.payloadHash.slice(0, 12)}…，当前指纹 ${ret.payloadHash.slice(0, 12)}…），` +
          '请重新签署后再继续。',
      );
    }
  }
}

/** 人工申报回填记录的合法性校验，返回清洗后的记录。 */
export function assertManualFilingRecord(record: ManualFilingRecord): ManualFilingRecord {
  if (record === undefined || record === null || typeof record !== 'object') {
    throw new FilingGuardError('缺少人工申报回填记录（ManualFilingRecord）。');
  }
  const receiptNo = typeof record.receiptNo === 'string' ? record.receiptNo.trim() : '';
  if (receiptNo === '') {
    throw new FilingGuardError(
      '人工申报回执号（receiptNo）不能为空：本系统不代为申报，' +
        'filed 状态只能依据电子税务局的实际受理回执回填。',
    );
  }
  if (!Number.isSafeInteger(record.paidAmount) || record.paidAmount < 0) {
    throw new FilingGuardError(
      `实缴金额必须是整数「分」且不小于 0，实际为 ${String(record.paidAmount)}。`,
    );
  }
  const actor = typeof record.actor === 'string' ? record.actor.trim() : '';
  if (actor === '') {
    throw new FilingGuardError('回填人（actor）不能为空：谁去税务局报的、谁回填的必须留名。');
  }
  const channels: ReadonlyArray<ManualFilingRecord['channel']> = [
    'etax-manual',
    'etax-client',
    'offline-window',
  ];
  if (!channels.includes(record.channel)) {
    throw new FilingGuardError(
      `申报渠道非法：${String(record.channel)}，可用 etax-manual / etax-client / offline-window。`,
    );
  }
  if (typeof record.filedAt !== 'string' || record.filedAt.trim() === '') {
    throw new FilingGuardError('申报时间（filedAt）不能为空。');
  }
  return { ...record, receiptNo, actor, filedAt: record.filedAt.trim() };
}

/**
 * 导出门禁：只有「已审批 + 签署齐备 + 签署未过期」的申报表才能变成 Excel 底稿。
 *
 * config 可选：exportFilingPackage() 拿不到工作流配置时按最保守的口径校验
 * （复核人 + 审批人必签，制单人若签了也必须新鲜）。
 */
export function assertExportable(ret: TaxReturn, config?: FilingConfig): void {
  if (ret.status !== 'approved') {
    recordFilingGuardAudit(
      'export_blocked',
      `申报表 ${ret.id} 当前状态 ${ret.status}，拒绝导出申报底稿`,
    );
    throw new ExportNotAllowedError(
      `当前状态为「${FILING_STATUS_LABEL[ret.status]}」，只有「已审批」的申报表才能导出申报底稿。` +
        '请先完成复核与审批签署——未审批的底稿一旦流出，就等于给了一份「看起来可以照抄」的税表。',
    );
  }
  const required: readonly SignRole[] =
    config !== undefined && !config.requirePreparerSignature
      ? ['reviewer', 'approver']
      : config !== undefined
        ? ['preparer', 'reviewer', 'approver']
        : ['reviewer', 'approver'];
  const missing = required.filter((role) => latestSignature(ret, role) === undefined);
  if (missing.length > 0) {
    recordFilingGuardAudit(
      'export_blocked',
      `申报表 ${ret.id} 缺少 ${missing.join('/')} 签署，拒绝导出`,
    );
    throw new ExportNotAllowedError(
      `申报表「${ret.id}」缺少${missing.map((role) => `「${SIGN_ROLE_LABEL[role]}」`).join('、')}签署，不能导出。`,
    );
  }
  assertSignaturesFresh(ret);
}

/**
 * 统一的提交前自检：给外部（CLI / Web / 定时任务）一个「我确实检查过」的入口。
 * 任何一步不满足都会抛错，绝不会「带病申报」。
 */
export function assertFilingReadyForManualSubmission(ret: TaxReturn, config: FilingConfig): void {
  // 先看状态：一张还没审批的表，连讨论它算得对不对都没有意义。
  if (ret.status !== 'approved') {
    throw new ExportNotAllowedError(
      `申报表「${ret.id}」当前状态为「${FILING_STATUS_LABEL[ret.status]}」，尚未审批，不能交给人工去申报。`,
    );
  }
  assertReturnIntegrity(ret);
  assertSignaturesComplete(ret, config);
  assertSignaturesFresh(ret);
  assertNoAutoSubmission();
}
