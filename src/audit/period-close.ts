/**
 * 期间结账 / 反结账（Period Close / Reopen）。
 *
 * 为什么结账必须「冻结」：
 *   结账意味着该期间的报表、纳税申报已经定稿并对外提供。若事后还能随手改凭证，
 *   就会出现「报表报出去了、账套里却是另一套数」的局面——《会计法》第九条要求
 *   会计核算必须以实际发生的经济业务为依据，《会计档案管理办法》（财政部 国家档案局令
 *   第79号）第十四条要求会计凭证、账簿保存 30 年且不得随意更改。因此结账后一律拒绝写入，
 *   要更正只能走「反结账 → 修改 → 重新结账」这条留下完整痕迹的路径。
 *
 * 为什么把校验做成可注入的回调：
 *   结账前要检查「凭证借贷平衡」「兜底科目是否清理干净」「有没有 error 级审核阻断」。
 *   前两项是账务数据自身的性质，本模块直接实现；第三项属于审核引擎（review 模块）的职责。
 *   通过 CloseValidator 注入，本模块不需要 import review，review 也不需要 import 本模块，
 *   两条线可以并行开发、各自单测。
 *
 * 为什么反结账要强制填写理由：
 *   反结账是审计上最敏感的操作之一。没有理由的反结账记录，事后无法向税务/审计解释
 *   「为什么已归档的期间又被打开过」。理由会写进审计事件（action=reopen_period），
 *   随哈希链一起固化，事后无法抵赖。
 *
 * 依赖方向：本模块只依赖 contracts / datetime / money，不依赖 AuditStore，
 * 由 AuditStore 实现 PeriodCloseStore 接口后调用，避免出现循环依赖。
 */

import type {
  AuditEvent,
  IsoDateTime,
  Period,
  VersionRecord,
  Voucher,
} from '../core/contracts.ts';
import { isValidPeriod } from '../core/datetime.ts';
import { formatYuan } from '../core/money.ts';

/* ------------------------------------------------------------------ */
/* 一、错误类型                                                        */
/* ------------------------------------------------------------------ */

/**
 * 期间已锁定。
 *
 * 单独定义成类而不是普通 Error，是为了让上层（CLI / Web / 批量导入）能精确捕获并
 * 给出「该期间已结账，请先反结账」这种可操作的提示，而不是笼统的「写入失败」。
 */
export class PeriodLockedError extends Error {
  readonly period: Period;

  constructor(period: Period, detail?: string) {
    super(
      `会计期间 ${period} 已结账并锁定，拒绝写入` +
        (detail === undefined || detail === '' ? '' : `（${detail}）`) +
        '。已结账期间的数据受《会计法》与《会计档案管理办法》保护，' +
        '如需更正必须先由授权人员执行反结账并书面说明理由',
    );
    this.name = 'PeriodLockedError';
    this.period = period;
  }
}

/** 结账/反结账流程中的可预期错误码。 */
export type PeriodCloseErrorCode =
  | 'invalid_period'
  | 'invalid_actor'
  | 'already_closed'
  | 'not_closed'
  | 'reason_required'
  | 'blocked';

/** 结账/反结账流程错误基类（带机器可读的 code，便于前端分支处理）。 */
export class PeriodCloseError extends Error {
  readonly code: PeriodCloseErrorCode;

  constructor(code: PeriodCloseErrorCode, message: string) {
    super(message);
    this.name = 'PeriodCloseError';
    this.code = code;
  }
}

/** 结账前校验未通过：携带全部阻断项，一次性告诉用户要改哪些地方。 */
export class PeriodCloseBlockedError extends PeriodCloseError {
  readonly period: Period;
  readonly blockers: string[];
  readonly warnings: string[];

  constructor(period: Period, blockers: readonly string[], warnings: readonly string[]) {
    super(
      'blocked',
      `期间 ${period} 结账前校验未通过，共 ${blockers.length} 项阻断，必须全部处理后才能结账：\n- ` +
        blockers.join('\n- '),
    );
    this.name = 'PeriodCloseBlockedError';
    this.period = period;
    this.blockers = [...blockers];
    this.warnings = [...warnings];
  }
}

/* ------------------------------------------------------------------ */
/* 二、结账校验器（可组合、可注入）                                     */
/* ------------------------------------------------------------------ */

/** 结账校验的输入。 */
export interface CloseCheckContext {
  period: Period;
  /** 该期间当前生效的凭证（来自审计库，已排除软删除的版本） */
  vouchers: readonly Voucher[];
}

/** 结账校验的产出。 */
export interface CloseCheckResult {
  /** 阻断项：非空则不允许结账 */
  blockers: string[];
  /** 提示项：不阻断，但写进结账记录供复核 */
  warnings: string[];
  /** 实际执行过的检查项说明，写进结账记录，用于证明「结账前检查了什么」 */
  checks: string[];
}

/** 结账校验器：纯函数，便于单测与跨模块注入。 */
export type CloseValidator = (ctx: CloseCheckContext) => CloseCheckResult;

/** 外部阻断来源：review 模块把 error 级审核结论通过这个签名接进来。 */
export type ExternalBlockerProvider = (ctx: CloseCheckContext) => readonly string[];

/** 构造一个空的校验结果，避免各处重复写字面量。 */
export function emptyCheckResult(): CloseCheckResult {
  return { blockers: [], warnings: [], checks: [] };
}

/** 凭证借贷平衡检查：不平的凭证绝不允许结账。 */
export function balanceValidator(): CloseValidator {
  return (ctx) => {
    const blockers: string[] = [];
    for (const voucher of ctx.vouchers) {
      const label = voucherLabel(voucher);
      const debit = sumSide(voucher, 'debit');
      const credit = sumSide(voucher, 'credit');
      const declaredBalanced = voucher.balanced !== false;
      const totalsMatch =
        typeof voucher.totalDebit !== 'number' ||
        typeof voucher.totalCredit !== 'number' ||
        voucher.totalDebit === voucher.totalCredit;
      if (!declaredBalanced || debit !== credit || !totalsMatch) {
        blockers.push(
          `${label} 借贷不平：借方合计 ${formatYuan(debit)} 元、贷方合计 ${formatYuan(credit)} 元，` +
            `差额 ${formatYuan(debit - credit)} 元`,
        );
      }
      if (voucher.lines.length === 0) {
        blockers.push(`${label} 没有任何分录行，空凭证不得结账`);
      }
    }
    return { blockers, warnings: [], checks: ['凭证借贷平衡'] };
  };
}

/**
 * 兜底科目检查。
 *
 * 兜底科目（默认 1901 待处理财产损溢 / 待处理挂账）是记账引擎在「规则没覆盖」或
 * 「借贷不平」时的临时落脚点。它的余额必须由人工逐笔清理成真实科目，
 * 带着兜底余额结账等于把未查明的差错直接带进报表。
 */
export function suspenseAccountValidator(accounts: readonly string[]): CloseValidator {
  const codes = accounts.map((item) => item.trim()).filter((item) => item !== '');
  return (ctx) => {
    if (codes.length === 0) return emptyCheckResult();
    const blockers: string[] = [];
    for (const voucher of ctx.vouchers) {
      const label = voucherLabel(voucher);
      for (const [index, line] of voucher.lines.entries()) {
        const hit = codes.find(
          (code) => line.accountCode === code || line.accountCode.startsWith(`${code}.`),
        );
        if (hit === undefined) continue;
        const amount = line.debit !== 0 ? line.debit : line.credit;
        blockers.push(
          `${label} 第 ${index + 1} 行仍挂在兜底科目 ${hit} ${line.accountName}（${formatYuan(amount)} 元），` +
            '必须人工确认后调整到真实科目才能结账',
        );
      }
    }
    return { blockers, warnings: [], checks: [`兜底科目已清理（${codes.join('/')}）`] };
  };
}

/**
 * 把外部阻断来源包装成校验器。
 *
 * review 模块用法示例：
 *   const reviewCheck = externalValidator('审核无 error 级阻断', (ctx) =>
 *     report.findings.filter(f => f.severity === 'error' && f.target.id 属于 ctx.vouchers)
 *       .map(f => `${f.ruleId} ${f.title}`));
 */
export function externalValidator(id: string, provider: ExternalBlockerProvider): CloseValidator {
  const label = id.trim() === '' ? '外部校验' : id.trim();
  return (ctx) => {
    const blockers = provider(ctx)
      .map((item) => String(item).trim())
      .filter((item) => item !== '');
    return { blockers, warnings: [], checks: [label] };
  };
}

/** 组合多个校验器：阻断项、提示项、检查项说明分别汇总。 */
export function combineValidators(...validators: readonly CloseValidator[]): CloseValidator {
  const list = validators.filter((item) => typeof item === 'function');
  return (ctx) => {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const checks: string[] = [];
    for (const validator of list) {
      const result = validator(ctx);
      blockers.push(...result.blockers);
      warnings.push(...result.warnings);
      checks.push(...result.checks);
    }
    return { blockers, warnings, checks };
  };
}

/* ------------------------------------------------------------------ */
/* 三、期间状态与宿主接口                                              */
/* ------------------------------------------------------------------ */

/**
 * 期间结账状态。
 *
 * 落盘位置是审计库的 period_close 版本表（entity=period_close, entityId=期间），
 * 因此每次结账/反结账都会留下一个不可变的历史版本，而不是覆盖某个状态字段。
 */
export interface PeriodCloseRecord {
  period: Period;
  /** true 表示当前处于结账锁定状态 */
  locked: boolean;
  closedAt?: IsoDateTime;
  closedBy?: string;
  /** 结账说明 */
  note?: string;
  /** 结账时该期间的凭证数 */
  voucherCount: number;
  /** 结账前实际执行的检查项 */
  checks: string[];
  /** 结账前的提示项 */
  warnings: string[];
  reopenedAt?: IsoDateTime;
  reopenedBy?: string;
  /** 反结账理由（必填） */
  reopenReason?: string;
  /** 反结账时被解锁的凭证数 */
  unlockedVouchers?: number;
}

/** 写入一次期间状态变更的入参。 */
export interface PeriodStateWrite {
  period: Period;
  record: PeriodCloseRecord;
  action: 'close_period' | 'reopen_period';
  actor: string;
  reason?: string;
}

/**
 * 本模块对审计库的最小依赖。
 *
 * 只声明这 5 个方法，而不是直接依赖 AuditStore 类，原因有二：
 *   1. 避免 period-close ↔ store 的循环 import；
 *   2. 单测可以用一个内存假实现验证结账逻辑，不必真的落盘。
 */
export interface PeriodCloseStore {
  /** 取一个单调递增的当前时间（由审计库统一发号，保证时间戳不乱序） */
  clockNow(): IsoDateTime;
  readPeriodState(period: Period): PeriodCloseRecord | null;
  listPeriodStates(): PeriodCloseRecord[];
  /** 取该期间当前生效的凭证（已排除软删除） */
  vouchersOf(period: Period): Voucher[];
  writePeriodState(input: PeriodStateWrite): { version: VersionRecord; event: AuditEvent };
}

/* ------------------------------------------------------------------ */
/* 四、结账 / 反结账                                                   */
/* ------------------------------------------------------------------ */

export interface PeriodCloseOptions {
  /** 结账说明，建议写明「本月凭证已全部录入、银行已对账」之类的事实 */
  note?: string;
  /** 额外注入的校验器（审核引擎等） */
  validators?: readonly CloseValidator[];
  /** 结账前必须清零的兜底科目编码 */
  suspenseAccounts?: readonly string[];
}

export interface PeriodCloseOutcome {
  period: Period;
  voucherCount: number;
  checks: string[];
  warnings: string[];
  record: PeriodCloseRecord;
  version: VersionRecord;
  event: AuditEvent;
}

/** 反结账结果：明确列出被解锁的凭证，便于复核人逐张确认。 */
export interface ReopenReport {
  period: Period;
  unlockedVouchers: number;
  unlockedVoucherIds: string[];
  reopenedAt: IsoDateTime;
  actor: string;
  reason: string;
  record: PeriodCloseRecord;
  version: VersionRecord;
  event: AuditEvent;
}

/**
 * 结账：校验通过后把该期间置为锁定状态。
 *
 * 顺序很重要——先校验、后写状态。如果先写状态再校验，校验失败时期间已经被锁，
 * 用户会陷入「改不了也结不了」的死锁。
 */
export function closePeriod(
  store: PeriodCloseStore,
  period: Period,
  actor: string,
  options: PeriodCloseOptions = {},
): PeriodCloseOutcome {
  if (!isValidPeriod(period)) {
    throw new PeriodCloseError(
      'invalid_period',
      `会计期间格式应为 YYYY-MM（例如 2024-01），实际为「${period}」`,
    );
  }
  const actorName = normalizeActor(actor);

  const existing = store.readPeriodState(period);
  if (existing !== null && existing.locked) {
    throw new PeriodCloseError(
      'already_closed',
      `期间 ${period} 已于 ${existing.closedAt ?? '（时间未知）'} 由 ${existing.closedBy ?? '（未记录）'} 结账，` +
        '如需重新结账请先执行反结账并说明理由',
    );
  }

  const vouchers = store.vouchersOf(period);
  const validator = combineValidators(
    balanceValidator(),
    suspenseAccountValidator(options.suspenseAccounts ?? []),
    ...(options.validators ?? []),
  );
  const result = validator({ period, vouchers });
  if (result.blockers.length > 0) {
    throw new PeriodCloseBlockedError(period, result.blockers, result.warnings);
  }

  const closedAt = store.clockNow();
  const record: PeriodCloseRecord = {
    period,
    locked: true,
    closedAt,
    closedBy: actorName,
    note: typeof options.note === 'string' ? options.note.trim() : '',
    voucherCount: vouchers.length,
    checks: [...result.checks],
    warnings: [...result.warnings],
  };

  const written = store.writePeriodState({
    period,
    record,
    action: 'close_period',
    actor: actorName,
    reason: record.note === '' ? undefined : record.note,
  });

  return {
    period,
    voucherCount: vouchers.length,
    checks: record.checks,
    warnings: record.warnings,
    record,
    version: written.version,
    event: written.event,
  };
}

/**
 * 反结账：解除期间锁定。
 *
 * 必须填写理由；返回被解锁的凭证清单，让复核人明确知道「这次打开了哪几张凭证」。
 */
export function reopenPeriod(
  store: PeriodCloseStore,
  period: Period,
  actor: string,
  reason: string,
): ReopenReport {
  if (!isValidPeriod(period)) {
    throw new PeriodCloseError(
      'invalid_period',
      `会计期间格式应为 YYYY-MM（例如 2024-01），实际为「${period}」`,
    );
  }
  const actorName = normalizeActor(actor);
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why === '') {
    throw new PeriodCloseError(
      'reason_required',
      '反结账必须填写理由：反结账会让已归档的期间重新可写，是审计重点关注的非常规操作；' +
        '没有理由的反结账记录事后无法向税务或审计解释',
    );
  }

  const existing = store.readPeriodState(period);
  if (existing === null || !existing.locked) {
    throw new PeriodCloseError('not_closed', `期间 ${period} 当前未结账，无需反结账`);
  }

  const vouchers = store.vouchersOf(period);
  const reopenedAt = store.clockNow();
  const record: PeriodCloseRecord = {
    ...existing,
    locked: false,
    reopenedAt,
    reopenedBy: actorName,
    reopenReason: why,
    unlockedVouchers: vouchers.length,
  };

  const written = store.writePeriodState({
    period,
    record,
    action: 'reopen_period',
    actor: actorName,
    reason: why,
  });

  return {
    period,
    unlockedVouchers: vouchers.length,
    unlockedVoucherIds: vouchers.map((voucher) => voucher.id).sort(),
    reopenedAt,
    actor: actorName,
    reason: why,
    record,
    version: written.version,
    event: written.event,
  };
}

/** 判断期间是否已结账锁定。 */
export function isPeriodLocked(store: PeriodCloseStore, period: Period): boolean {
  if (!isValidPeriod(period)) return false;
  const state = store.readPeriodState(period);
  return state !== null && state.locked;
}

/** 列出所有当前处于锁定状态的期间（升序）。 */
export function listLockedPeriods(store: PeriodCloseStore): Period[] {
  return store
    .listPeriodStates()
    .filter((item) => item.locked)
    .map((item) => item.period)
    .sort();
}

/* ------------------------------------------------------------------ */
/* 五、内部工具                                                        */
/* ------------------------------------------------------------------ */

function normalizeActor(actor: string): string {
  const name = typeof actor === 'string' ? actor.trim() : '';
  if (name === '') {
    throw new PeriodCloseError(
      'invalid_actor',
      '结账/反结账必须记录操作人：没有签署人的结账记录在审计上无效',
    );
  }
  return name;
}

function voucherLabel(voucher: Voucher): string {
  const word = typeof voucher.word === 'string' && voucher.word !== '' ? voucher.word : voucher.id;
  const date = typeof voucher.date === 'string' ? voucher.date : '（日期缺失）';
  return `凭证 ${word}（${voucher.id}，${date}）`;
}

function sumSide(voucher: Voucher, side: 'debit' | 'credit'): number {
  let total = 0;
  for (const line of voucher.lines) {
    total += side === 'debit' ? line.debit : line.credit;
  }
  return total;
}
