/**
 * 合规审核引擎（Automated Review Layer）。
 *
 * 定位：在「单据识别 → 记账 → 准则 → 报表 → 税务」全部自动化产出之后，
 * 再独立跑一遍审核，回答三个问题：
 *   1. 这套账是否符合中国现行会计法、会计基础工作规范、企业会计制度、会计准则？
 *   2. 是否触碰税收征管法与刑法的红线？
 *   3. 报表内部、报表与账簿之间是否勾稽一致？
 *
 * 设计原则：
 *  1. **检查项注册制**：每个检查项是一个纯函数 (input, ctx) => ReviewFinding[]，
 *     注册在 CHECKS 里。新增检查只需加一个文件 + 一行注册，引擎主体不动。
 *  2. **严重度由注册表统一回填**：检查函数只描述「发现了什么」，
 *     severity / category / blocking 由引擎按注册表统一赋值。
 *     这样避免 34 个检查项各写一套严重度，导致同一类问题在不同检查项里口径漂移。
 *  3. **可解释**：每条结论必须带法规依据、定位（凭证号/分录行/申报表 id）、
 *     整改建议与机器可读证据；没有依据的结论不允许进入报告。
 *  4. **不阻断式崩溃**：单个检查项抛异常时，引擎把它转成一条「检查项执行异常」结论，
 *     其余检查继续跑。月结现场最怕的是审核器自己挂掉导致整批账卡住。
 *  5. **同一 ruleId + 同一 target 只报一次**：避免一张凭证的 100 行摘要都为空时刷屏，
 *     检查项应自行聚合（本项目的检查项均按凭证/科目/供应商聚合）。
 *
 * 评分口径（写死在代码里，报告与 UI 共用）：
 *   满分 100；error 每条 -8；warning 每条 -2；info 每条 -0.5；下限 0。
 *   已人工豁免的结论不扣分（豁免只能针对 warning/info，error 不允许豁免）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type {
  CheckDescriptor,
  CheckFn,
  IsoDateTime,
  Period,
  ReviewConfig,
  ReviewContext,
  ReviewFinding,
  ReviewInput,
  ReviewReport,
  ReviewSummary,
  Severity,
} from '../core/contracts.ts';
import { ENGINE_VERSION } from '../core/contracts.ts';
import { CONFIG_DIR, ConfigError, PROJECT_ROOT } from '../core/config.ts';
import { isValidPeriod } from '../core/datetime.ts';

import { FALLBACK_BASIS } from './legal.ts';
import { ACCOUNT_RULE_IDS, accountChecks, prepareAccountContext } from './checks/account.ts';
import { CRIMINAL_RULE_IDS, criminalChecks } from './checks/criminal.ts';
import { DATA_RULE_IDS, dataChecks } from './checks/data.ts';
import { STATEMENT_RULE_IDS, statementChecks } from './checks/statement.ts';
import { TAX_RULE_IDS, taxChecks } from './checks/tax.ts';
import { VOUCHER_RULE_IDS, voucherChecks } from './checks/voucher.ts';

/* ================================================================== */
/* 一、公共类型                                                        */
/* ================================================================== */

/** 审核运行选项。 */
export interface ReviewOptions {
  /**
   * 配置根目录（默认 config/）。
   * 会读取 <configDir>/review/rules.yaml；科目表优先读 <configDir>/standard/<准则>/chart-of-accounts.yaml，
   * 不存在时回退到 <configDir>/chart-of-accounts.yaml。
   */
  configDir?: string;
  /** 本次额外关闭的检查项（监管强制项不允许关闭，会抛 ReviewConfigError）。 */
  disabled?: string[];
  /** 本次严重度覆盖，键为检查项 id。 */
  severityOverrides?: Record<string, Severity>;
  /** 人工豁免。只能豁免 warning/info；对 error 发起豁免会抛 ReviewWaiverError。 */
  waiver?: ReviewWaiverInput[];
}

/** 人工豁免输入。豁免必须可追溯：谁、何时、为什么。 */
export interface ReviewWaiverInput {
  ruleId: string;
  targetId: string;
  actor: string;
  at: IsoDateTime;
  reason: string;
}

/**
 * 检查项定义 = 报告里展示的元数据 + 是否阻断 + 执行函数。
 *
 * blocking 的语义是「未整改不得进入下一环节」。
 * 只有 error 级结论才可能阻断：若管理员把某个阻断项的严重度下调为 warning，
 * 引擎会自动解除阻断（blocking = def.blocking && severity === 'error'），
 * 避免出现「warning 却阻断」这种自相矛盾的报告。
 */
export interface CheckDefinition extends CheckDescriptor {
  blocking: boolean;
  run: CheckFn;
}

/* ================================================================== */
/* 二、错误类型                                                        */
/* ================================================================== */

/** 配置错误（关闭了不可关闭的检查项、严重度取值非法等）。 */
export class ReviewConfigError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewConfigError';
  }
}

/** 输入非法（期间格式错误、准则未知）。 */
export class ReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewInputError';
  }
}

/** 豁免非法（对 error 豁免、缺少签署人或理由）。 */
export class ReviewWaiverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewWaiverError';
  }
}

/** 审核未通过。携带完整报告，调用方可以继续展示而不是只拿到一句错误信息。 */
export class ReviewBlockedError extends Error {
  readonly report: ReviewReport;

  constructor(report: ReviewReport, message?: string) {
    super(message ?? defaultBlockedMessage(report));
    this.name = 'ReviewBlockedError';
    this.report = report;
  }
}

/* ================================================================== */
/* 三、检查项注册表                                                    */
/* ================================================================== */

/** 全部检查项 id，按业务层分组，供 UI/测试/集成方引用，避免手写字符串。 */
export const REVIEW_RULE_IDS = {
  voucher: VOUCHER_RULE_IDS,
  account: ACCOUNT_RULE_IDS,
  tax: TAX_RULE_IDS,
  criminal: CRIMINAL_RULE_IDS,
  statement: STATEMENT_RULE_IDS,
  data: DATA_RULE_IDS,
} as const;

/** 执行顺序：凭证 → 科目 → 税务 → 刑事 → 报表 → 数据。先看账，再看表，最后看流程。 */
const CHECKS: readonly CheckDefinition[] = [
  ...voucherChecks,
  ...accountChecks,
  ...taxChecks,
  ...criminalChecks,
  ...statementChecks,
  ...dataChecks,
];

const CHECK_BY_ID = new Map<string, CheckDefinition>();
for (const check of CHECKS) {
  if (CHECK_BY_ID.has(check.id)) {
    // 重复 id 会让「同一 ruleId 对同一 target 只报一次」的去重逻辑串味，必须在启动时暴露。
    throw new Error(`审核检查项 id 重复：${check.id}`);
  }
  CHECK_BY_ID.set(check.id, check);
}

/* ================================================================== */
/* 四、配置                                                            */
/* ================================================================== */

const DEFAULT_CONFIG: ReviewConfig = {
  disabled: [],
  severityOverrides: {},
  continueOnError: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSeverity(value: unknown, context: string): Severity {
  if (value === 'error' || value === 'warning' || value === 'info') return value;
  throw new ReviewConfigError(
    `${context} 的严重度必须是 error / warning / info，实际为 ${JSON.stringify(value)}`,
  );
}

function resolveConfigDir(configDir?: string): string {
  if (configDir === undefined || configDir === '') return CONFIG_DIR;
  return isAbsolute(configDir) ? configDir : resolve(PROJECT_ROOT, configDir);
}

function findReviewConfigFile(configDir: string): string | null {
  const candidates = [
    join(configDir, 'review', 'rules.yaml'),
    join(configDir, 'review', 'rules.yml'),
    join(configDir, 'rules.yaml'),
    join(configDir, 'rules.yml'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 加载审核配置。
 *
 * 文件缺失时返回默认配置而不是抛错 —— 与 core/config.ts 的 loadSettings 保持一致：
 * 审核器必须在「配置还没准备好」的现场也能跑起来，否则月结第一步就卡住。
 * 文件存在但格式非法时抛 ReviewConfigError，因为静默忽略配置错误会让用户
 * 以为「已经关掉了某个检查」，实际还在跑，或者反过来。
 */
export function loadReviewConfig(configDir?: string): ReviewConfig {
  const dir = resolveConfigDir(configDir);
  const file = findReviewConfigFile(dir);
  if (file === null) return { ...DEFAULT_CONFIG, disabled: [], severityOverrides: {} };

  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ReviewConfigError(`审核配置解析失败 ${file}: ${(err as Error).message}`);
  }
  if (!isRecord(doc)) {
    throw new ReviewConfigError(`审核配置 ${file} 顶层应为对象`);
  }

  const disabled = new Set<string>();
  const severityOverrides: Record<string, Severity> = {};
  let continueOnError = true;

  if (doc['disabled'] !== undefined) {
    if (!Array.isArray(doc['disabled'])) {
      throw new ReviewConfigError(`${file}: disabled 应为字符串数组`);
    }
    for (const item of doc['disabled']) {
      disabled.add(String(item));
    }
  }

  if (doc['severityOverrides'] !== undefined) {
    if (!isRecord(doc['severityOverrides'])) {
      throw new ReviewConfigError(`${file}: severityOverrides 应为「检查项 id → 严重度」的对象`);
    }
    for (const [id, value] of Object.entries(doc['severityOverrides'])) {
      severityOverrides[id] = readSeverity(value, `${file}: severityOverrides.${id}`);
    }
  }

  if (doc['continueOnError'] !== undefined) {
    continueOnError = Boolean(doc['continueOnError']);
  }

  if (doc['checks'] !== undefined) {
    if (!isRecord(doc['checks'])) {
      throw new ReviewConfigError(`${file}: checks 应为「检查项 id → 配置」的对象`);
    }
    for (const [id, raw] of Object.entries(doc['checks'])) {
      if (!isRecord(raw)) {
        throw new ReviewConfigError(`${file}: checks.${id} 应为对象`);
      }
      if (raw['enabled'] === false) disabled.add(id);
      if (raw['severity'] !== undefined) {
        const severity = readSeverity(raw['severity'], `${file}: checks.${id}.severity`);
        // 与代码默认值相同的严重度不写入覆盖表：配置文件里写一遍只是文档，
        // 不应该让运行时的「实际覆盖项」凭空多出 30 多条噪声。
        const def = CHECK_BY_ID.get(id);
        if (def === undefined || def.severity !== severity) severityOverrides[id] = severity;
      }
    }
  }

  return { disabled: [...disabled], severityOverrides, continueOnError };
}

function mergeConfig(base: ReviewConfig, options: ReviewOptions): ReviewConfig {
  const disabled = new Set<string>(base.disabled);
  for (const id of options.disabled ?? []) disabled.add(id);

  const severityOverrides: Record<string, Severity> = { ...base.severityOverrides };
  for (const [id, severity] of Object.entries(options.severityOverrides ?? {})) {
    severityOverrides[id] = readSeverity(severity, `options.severityOverrides.${id}`);
  }

  // 监管强制项不可关闭：宁可报错，也不能让用户以为「关掉就合规了」。
  for (const id of disabled) {
    const def = CHECK_BY_ID.get(id);
    if (def !== undefined && !def.configurable) {
      throw new ReviewConfigError(
        `检查项 ${id}（${def.title}）属于监管强制项，不允许关闭。` +
          '该类检查对应会计法、税收征管法或刑法的强制性要求，只能通过整改消除，不能通过配置绕过。',
      );
    }
  }

  return {
    disabled: [...disabled],
    severityOverrides,
    continueOnError: base.continueOnError,
  };
}

/* ================================================================== */
/* 五、时间与报告 id                                                   */
/* ================================================================== */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 生成带时区偏移的 ISO-8601 时间戳。
 * 不用 toISOString() 是因为它是 UTC 的 Z 结尾，中国用户看到的「审核时间」
 * 会和本地时间差 8 小时，审计追溯时容易误判。
 */
export function nowIsoDateTime(): IsoDateTime {
  const d = new Date();
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

let reportSequence = 0;

function makeReportId(period: Period): string {
  reportSequence += 1;
  const stamp = nowIsoDateTime().replace(/[-:T+]/g, '').slice(0, 14);
  return `RV-${period}-${stamp}-${String(reportSequence).padStart(3, '0')}`;
}

/* ================================================================== */
/* 六、执行                                                            */
/* ================================================================== */

function validateInput(input: ReviewInput): void {
  if (typeof input.period !== 'string' || !isValidPeriod(input.period)) {
    throw new ReviewInputError(`审核期间格式非法：${String(input.period)}，应为 YYYY-MM`);
  }
  if (input.standard !== 'cas' && input.standard !== 'small') {
    throw new ReviewInputError(`未知会计准则：${String(input.standard)}，应为 cas 或 small`);
  }
  if (!Array.isArray(input.vouchers) || !Array.isArray(input.documents)) {
    throw new ReviewInputError('审核输入缺少 vouchers / documents 数组');
  }
}

function descriptorOf(def: CheckDefinition, severity: Severity): CheckDescriptor {
  return {
    id: def.id,
    title: def.title,
    category: def.category,
    severity,
    basis: def.basis,
    configurable: def.configurable,
  };
}

/**
 * 统一回填元数据。
 * 检查函数里写的 severity/category/blocking 只是占位，最终以注册表为准，
 * 这样 severityOverrides 才能生效，也保证同一检查项的所有结论口径一致。
 */
function normalizeFinding(
  finding: ReviewFinding,
  def: CheckDefinition,
  severity: Severity,
  index: number,
): ReviewFinding {
  const id =
    typeof finding.id === 'string' && finding.id.trim() !== ''
      ? finding.id
      : `RV-${def.id}-F${String(index + 1).padStart(3, '0')}`;
  return {
    ...finding,
    id,
    ruleId: def.id,
    category: def.category,
    severity,
    blocking: def.blocking && severity === 'error',
    basis: finding.basis.length > 0 ? finding.basis : def.basis.length > 0 ? def.basis : [FALLBACK_BASIS],
    evidence: finding.evidence,
  };
}

function engineFailureFinding(
  def: CheckDefinition,
  ctx: ReviewContext,
  error: unknown,
): ReviewFinding {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: ctx.nextId(),
    ruleId: def.id,
    severity: def.severity === 'error' ? 'error' : 'warning',
    category: def.category,
    title: `检查项 ${def.id} 执行异常`,
    detail:
      `检查项「${def.title}」在执行过程中抛出异常：${message}。` +
      '该检查项未能完成，本次审核结论在这一维度上是不完整的。',
    suggestion:
      '请把该异常反馈给系统管理员，修复后重新审核；' +
      '在修复前，不应把「未发现该检查项的问题」理解为「该维度合规」。',
    basis: def.basis.length > 0 ? def.basis : [FALLBACK_BASIS],
    target: { kind: 'run', id: ctx.period, label: `审核期间 ${ctx.period}` },
    blocking: def.blocking,
  };
}

function applyWaivers(findings: ReviewFinding[], waivers: readonly ReviewWaiverInput[]): void {
  if (waivers.length === 0) return;

  for (const waiver of waivers) {
    if (typeof waiver.actor !== 'string' || waiver.actor.trim() === '') {
      throw new ReviewWaiverError(`豁免 ${waiver.ruleId}/${waiver.targetId} 必须填写签署人（actor）`);
    }
    if (typeof waiver.reason !== 'string' || waiver.reason.trim() === '') {
      throw new ReviewWaiverError(`豁免 ${waiver.ruleId}/${waiver.targetId} 必须填写豁免理由`);
    }
    if (typeof waiver.at !== 'string' || waiver.at.trim() === '') {
      throw new ReviewWaiverError(`豁免 ${waiver.ruleId}/${waiver.targetId} 必须填写豁免时间`);
    }

    const matched = findings.filter(
      (f) => f.ruleId === waiver.ruleId && f.target.id === waiver.targetId,
    );
    // 过期豁免（对应的结论本次没有出现）不报错：允许豁免清单跨期复用。
    if (matched.length === 0) continue;

    for (const finding of matched) {
      if (finding.severity === 'error' || finding.blocking) {
        throw new ReviewWaiverError(
          `检查项 ${waiver.ruleId} 在 ${waiver.targetId} 上的结论为 ${finding.severity} 级` +
            `（${finding.title}），属于必须整改项，不允许豁免。` +
            '豁免只能针对 warning / info，error 必须整改后重新审核。',
        );
      }
      finding.waived = {
        actor: waiver.actor,
        at: waiver.at,
        reason: waiver.reason,
        scope: finding.severity === 'warning' ? 'warning' : 'info',
      };
    }
  }
}

/**
 * 汇总统计口径：
 *  - total / error / warning / info / byCategory 统计报告中的全部结论（含已豁免），
 *    回答「报告里列了多少条」；
 *  - blocking / score / passed 只统计未豁免结论，回答「还欠多少整改」。
 * 豁免只影响后者，不会让问题从报告中消失 —— 留痕比好看重要。
 */
function summarize(findings: readonly ReviewFinding[]): ReviewSummary {
  const summary: ReviewSummary = {
    total: findings.length,
    error: 0,
    warning: 0,
    info: 0,
    blocking: 0,
    waived: 0,
    score: 100,
    passed: true,
    byCategory: {},
  };

  let deduction = 0;
  let activeErrors = 0;

  for (const finding of findings) {
    if (finding.severity === 'error') summary.error += 1;
    else if (finding.severity === 'warning') summary.warning += 1;
    else summary.info += 1;

    summary.byCategory[finding.category] = (summary.byCategory[finding.category] ?? 0) + 1;

    if (finding.waived !== undefined) {
      summary.waived += 1;
      continue;
    }
    if (finding.blocking) summary.blocking += 1;
    if (finding.severity === 'error') activeErrors += 1;

    if (finding.severity === 'error') deduction += 8;
    else if (finding.severity === 'warning') deduction += 2;
    else deduction += 0.5;
  }

  summary.score = Math.max(0, Math.round((100 - deduction) * 10) / 10);
  summary.passed = activeErrors === 0 && summary.blocking === 0;
  return summary;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function sortFindings(findings: ReviewFinding[]): void {
  findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 执行一次完整审核。
 *
 * 纯同步函数：审核过程中不读网络、不写文件、不调用税务接口，
 * 保证「同样的输入 + 同样的配置 = 同样的结论」，便于复核与回归测试。
 */
export function runReview(input: ReviewInput, options: ReviewOptions = {}): ReviewReport {
  validateInput(input);

  const config = mergeConfig(loadReviewConfig(options.configDir), options);
  prepareAccountContext(input.standard, options.configDir);

  const findings: ReviewFinding[] = [];
  const seen = new Set<string>();
  const checksRun: CheckDescriptor[] = [];

  for (const def of CHECKS) {
    if (config.disabled.includes(def.id)) continue;

    const severity = config.severityOverrides[def.id] ?? def.severity;
    let counter = 0;
    const ctx: ReviewContext = {
      standard: input.standard,
      period: input.period,
      config,
      nextId: () => {
        counter += 1;
        return `RV-${def.id}-${String(counter).padStart(3, '0')}`;
      },
    };

    let produced: ReviewFinding[];
    try {
      produced = def.run(input, ctx);
    } catch (err) {
      produced = [engineFailureFinding(def, ctx, err)];
    }

    let hasError = false;
    produced.forEach((finding, index) => {
      const normalized = normalizeFinding(finding, def, severity, index);
      if (normalized.severity === 'error') hasError = true;

      const key = `${normalized.ruleId}::${normalized.target.kind}::${normalized.target.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push(normalized);
    });

    checksRun.push(descriptorOf(def, severity));

    if (!config.continueOnError && hasError) break;
  }

  applyWaivers(findings, options.waiver ?? []);
  sortFindings(findings);

  return {
    id: makeReportId(input.period),
    period: input.period,
    standard: input.standard,
    checkedAt: nowIsoDateTime(),
    engineVersion: ENGINE_VERSION,
    findings,
    summary: summarize(findings),
    checksRun,
  };
}

/* ================================================================== */
/* 七、查询与断言                                                      */
/* ================================================================== */

/** 列出全部检查项（不受配置影响），供 UI 展示「系统会检查什么」。 */
export function listChecks(): CheckDescriptor[] {
  return CHECKS.map((def) => descriptorOf(def, def.severity));
}

function defaultBlockedMessage(report: ReviewReport): string {
  return (
    `审核未通过：存在 ${report.summary.blocking} 项阻断项、${report.summary.error} 项 error，` +
    `合规得分 ${report.summary.score} 分。未整改不得进入下一环节。`
  );
}

/**
 * 审核通过断言：不通过时抛 ReviewBlockedError（携带完整报告）。
 *
 * 调用方（月结编排、导出、申报）应在每个「下一环节」入口调用它，
 * 而不是自己判断 summary.passed —— 否则一旦有人忘了判断，阻断机制就形同虚设。
 */
export function assertReviewPassed(report: ReviewReport): void {
  const blockers = report.findings.filter(
    (f) => f.waived === undefined && (f.blocking || f.severity === 'error'),
  );
  if (blockers.length === 0) return;

  const preview = blockers
    .slice(0, 10)
    .map((f) => `- [${f.severity}] ${f.title}（${f.ruleId} @ ${f.target.label ?? f.target.id}）`)
    .join('\n');
  const more = blockers.length > 10 ? `\n- ……另有 ${blockers.length - 10} 项阻断项，详见报告` : '';

  throw new ReviewBlockedError(
    report,
    `审核未通过：存在 ${blockers.length} 项阻断项，未整改不得进入下一环节。\n${preview}${more}`,
  );
}
