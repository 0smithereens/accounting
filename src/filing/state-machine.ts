/**
 * 申报状态机：唯一合法迁移表 + 非法迁移拦截 + 内容指纹。
 *
 * 为什么要把状态机单独抽出来？
 *   申报环节最容易出的事故不是「算错税」，而是**流程被绕过**：某个脚本直接改 status 字段，
 *   或者某个接口「顺手」把 calculated 置成 filed，让一张没经过人工复核的申报表看起来已经报过税。
 *   所以所有状态写入都必须经过本文件的 applyTransition()：
 *   先查迁移表 → 再查「filed 必须有税务局回执」→ 才写状态并追加 FilingEvent。
 *   只要业务代码不给 ret.status 直接赋值，就不存在第二条改状态的路径。
 *
 * 铁律（与 contracts.ts 中 FilingStatus 的注释一一对应）：
 *   1. TRANSITIONS.calculated 里没有 filed，因此 calculated → filed 在**数据结构层面**不可能成立，
 *      任何尝试都会命中 IllegalTransitionError。
 *   2. filed 只能由 applyTransition(ret, 'filed', …) 写入，且要求 manualFiling.receiptNo 已经存在。
 *      换句话说：系统里没有任何代码路径可以「凭空」把一张表标成已申报。
 *   3. 任何迁移都追加 FilingEvent，只追加、不修改、不删除。
 *   4. 内容指纹（payloadHash）覆盖计算口径本身，签署时锁定它，重算即失效。
 */

import { createHash } from 'node:crypto';

import type {
  FilingEvent,
  FilingStatus,
  IsoDateTime,
  Signature,
  SignRole,
  TaxReturn,
} from '../core/contracts.ts';
import { FILING_STATUS_LABEL } from '../core/contracts.ts';

/* ------------------------------------------------------------------ */
/* 一、迁移表与非法迁移                                                */
/* ------------------------------------------------------------------ */

/**
 * 合法迁移表。
 *
 * 注意两处「自迁移」，它们不是笔误：
 *   approved → approved  导出申报底稿（导出动作本身必须留痕，否则无法证明「这份底稿是什么时候导的」）
 *   filed    → filed     人工申报事实的补录/更正（回执号后补）
 *
 * 而 calculated → filed 永远不在表里：这是本模块存在的全部意义。
 */
export const TRANSITIONS: Readonly<Record<FilingStatus, readonly FilingStatus[]>> = {
  draft: ['calculated', 'void'],
  calculated: ['reviewed', 'rejected', 'void'],
  reviewed: ['approved', 'rejected', 'void'],
  approved: ['approved', 'filed', 'void'],
  filed: ['filed', 'void'],
  rejected: ['draft', 'void'],
  void: [],
};

/** 非法状态迁移。from/to 保留结构化字段，便于上层区分「业务拒绝」与「程序 bug」。 */
export class IllegalTransitionError extends Error {
  readonly from: FilingStatus;
  readonly to: FilingStatus;

  constructor(from: FilingStatus, to: FilingStatus, reason?: string) {
    const detail = reason === undefined || reason === '' ? '' : `。${reason}`;
    super(
      `非法状态迁移：${FILING_STATUS_LABEL[from]}（${from}）→ ${FILING_STATUS_LABEL[to]}（${to}）${detail}`,
    );
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** 查询迁移是否合法。纯函数，供 UI 置灰按钮与单测使用。 */
export function canTransition(from: FilingStatus, to: FilingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 非法迁移直接抛错；正常迁移静默通过。 */
export function assertCanTransition(from: FilingStatus, to: FilingStatus, reason?: string): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to, reason);
}

/* ------------------------------------------------------------------ */
/* 二、迁移执行                                                        */
/* ------------------------------------------------------------------ */

export interface TransitionContext {
  /** 发起人。申报流程里没有「系统自动」这一步，必须有人。 */
  actor: string;
  at: IsoDateTime;
  reason?: string;
  /** 是否由人工发起，默认 true。 */
  humanInitiated?: boolean;
}

/**
 * filed 的前置条件：必须已经有人工申报回填记录。
 *
 * 放在状态机里而不是工作流里，是为了让「绕过工作流直接调 applyTransition」的代码也过不了这一关。
 */
export function assertFiledRequiresRecord(ret: TaxReturn): void {
  const record = ret.manualFiling;
  if (record === undefined || record === null) {
    throw new IllegalTransitionError(
      ret.status,
      'filed',
      '缺少人工申报回填记录：filed 只能由 reportManualFiling() 依据电子税务局受理回执写入，系统不会代为申报',
    );
  }
  const receiptNo = typeof record.receiptNo === 'string' ? record.receiptNo.trim() : '';
  if (receiptNo === '') {
    throw new IllegalTransitionError(
      ret.status,
      'filed',
      '人工申报回执号（receiptNo）为空：没有税务局受理回执就不能认定已经申报',
    );
  }
  if (!Number.isSafeInteger(record.paidAmount)) {
    throw new IllegalTransitionError(
      ret.status,
      'filed',
      `实缴金额必须是整数「分」，实际为 ${String(record.paidAmount)}`,
    );
  }
}

/**
 * 执行一次状态迁移：校验 → 写状态 → 追加事件。
 *
 * 事件在状态写入之后追加，保证「事件流里出现的事件」一定对应真实发生过的迁移。
 */
export function applyTransition(
  ret: TaxReturn,
  to: FilingStatus,
  ctx: TransitionContext,
): FilingEvent {
  const from = ret.status;
  const actor = typeof ctx.actor === 'string' ? ctx.actor.trim() : '';
  if (actor === '') {
    throw new IllegalTransitionError(from, to, '迁移必须记录操作人（actor），否则审计链断裂');
  }
  assertCanTransition(from, to);
  if (to === 'filed') assertFiledRequiresRecord(ret);

  const event: FilingEvent = {
    at: ctx.at,
    from,
    to,
    actor,
    reason: ctx.reason,
    humanInitiated: ctx.humanInitiated ?? true,
  };

  ret.status = to;
  ret.updatedAt = ctx.at;
  ret.events.push(event);
  return event;
}

/* ------------------------------------------------------------------ */
/* 三、内容指纹                                                        */
/* ------------------------------------------------------------------ */

/**
 * 参与指纹计算的字段。
 *
 * 刻意排除 status / signatures / events / updatedAt / createdAt / manualFiling / reviewId / blockingIssues：
 *  - 状态与签署是「围绕内容的动作」，改状态不该让签名失效；
 *  - 审核结论属于审核报告，不属于计算口径。
 * 保留 version：每次重算都换版本号，旧签署因此必然失效，这是「签的不是算的那份」的技术防线。
 */
const HASHED_FIELDS = [
  'id',
  'period',
  'taxType',
  'taxpayerId',
  'standard',
  'version',
  'lines',
  'adjustments',
  'payable',
  'prepaid',
  'due',
  'benefits',
] as const;

type HashedField = (typeof HASHED_FIELDS)[number];

/** 规范化 JSON：对象键排序、丢弃 undefined，保证同样内容永远得到同样指纹。 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new IllegalTransitionError('draft', 'draft', `计算指纹遇到非法数字 ${String(value)}`);
    }
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
  }
  // bigint / symbol / function 不应出现在申报数据里，出现即视为非法内容
  return 'null';
}

/** 计算申报内容指纹（sha256，十六进制）。 */
export function hashFilingPayload(ret: Pick<TaxReturn, HashedField>): string {
  const payload: Record<string, unknown> = {};
  for (const field of HASHED_FIELDS) {
    payload[field] = ret[field];
  }
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/** 版本号 +1（重算与修订都必须调用，保证每次内容变更都是新版本）。 */
export function bumpVersion(ret: TaxReturn, at: IsoDateTime): number {
  const next = Math.max(1, Math.trunc(ret.version) || 1) + 1;
  ret.version = next;
  ret.updatedAt = at;
  return next;
}

/* ------------------------------------------------------------------ */
/* 四、签署（只追加）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 追加一条签署。
 *
 * 这里不做「删除/覆盖」的重载是刻意的：签名一旦落库就是审计证据，
 * 想反悔只能重新签一条新的，旧签名永远留在 signatures 里。
 */
export function appendSignature(ret: TaxReturn, signature: Signature): Signature {
  ret.signatures.push(signature);
  return signature;
}

/** 取某角色的**最新**一条签署。旧签署保留在数组里，但以最新一条为准。 */
export function latestSignature(ret: TaxReturn, role: SignRole): Signature | undefined {
  for (let i = ret.signatures.length - 1; i >= 0; i -= 1) {
    const sig = ret.signatures[i];
    if (sig !== undefined && sig.role === role) return sig;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 五、时钟                                                            */
/* ------------------------------------------------------------------ */

/**
 * 带时区偏移的当前时间（ISO-8601）。
 *
 * 为什么不用 toISOString()？那是 UTC（Z 结尾），会计人员看到的「几点签的字」会差 8 小时，
 * 审计时容易对不上账。工作流允许注入 now()，这里只是默认实现。
 */
export function nowIso(): IsoDateTime {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
