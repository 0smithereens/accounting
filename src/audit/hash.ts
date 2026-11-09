/**
 * 规范化 JSON 与 sha256 哈希链。
 *
 * 设计取舍（为什么必须这么写）：
 *
 * 1. 为什么不能直接用 JSON.stringify 算哈希
 *    JSON.stringify 的输出依赖对象属性的插入顺序。同一份业务数据「内存里现序列化」与
 *    「从 JSONL 读回来再序列化」的属性顺序可能不同，直接算 sha256 会得到两个不同的值，
 *    于是昨天写进去的审计记录，今天校验就报断链。canonicalJson 递归按键名排序、去掉全部空白，
 *    保证「同一份数据 → 同一串字符 → 同一个哈希」，与进程、平台、属性插入顺序无关。
 *
 * 2. 为什么把 prevHash 拼在哈希输入的最前面
 *    hash = sha256(prevHash + canonicalJson(payload))。任何一条记录被改动，它之后所有记录的哈希
 *    都会失效；篡改者要伪造就必须重算整条链，而链条头部的哈希可以被外部单独留存
 *    （邮件归档、纸质签署、第三方时间戳），重算也无法自证清白。
 *
 * 3. 为什么 payload 里不含 hash 字段
 *    哈希不能包含自身，否则无解。prevHash 以字符串前缀的方式参与，语义上仍属于链条的一部分。
 *
 * 4. 为什么要刻意对齐 JSON.stringify 的语义
 *    事件是落盘成 JSON 的：读回来时值为 undefined 的属性会消失、NaN 变 null、Date 变字符串。
 *    如果规范化时不按同样规则处理，写入时算的哈希与校验时算的哈希就会不一致——
 *    这不是理论问题，而是「重启后校验必然失败」的生产事故。
 */

import { createHash } from 'node:crypto';

import type { AuditEvent } from '../core/contracts.ts';

/** 哈希链起点：64 个 0，与 sha256 的十六进制输出等长。 */
export const ZERO_HASH = '0'.repeat(64);

/** 规范化失败（循环引用、BigInt 等无法稳定表示的值）。 */
export class AuditSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditSerializationError';
  }
}

/** 计算字符串的 sha256 十六进制摘要。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 把任意 JSON 值写成「键名递归排序、无空白」的规范形式。
 *
 * 同一份数据无论来自内存对象还是 JSONL 反序列化，输出完全一致，
 * 这是哈希链能在重启后依然校验通过的前提。
 */
export function canonicalJson(value: unknown): string {
  return writeCanonical(value, []);
}

function writeCanonical(value: unknown, stack: unknown[]): string {
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'string') return JSON.stringify(value as string);
  if (type === 'boolean') return value === true ? 'true' : 'false';
  if (type === 'number') {
    const num = value as number;
    // JSON.stringify 会把 NaN / Infinity 写成 null，这里必须保持一致
    return Number.isFinite(num) ? String(num) : 'null';
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol') return 'null';
  if (type === 'bigint') {
    throw new AuditSerializationError('审计数据不能包含 BigInt：JSON 无法无损表示，请先转成字符串或整数分');
  }
  if (type !== 'object') return 'null';

  const record = value as Record<string, unknown>;
  const toJSON = record['toJSON'];
  if (typeof toJSON === 'function') {
    const converted = (toJSON as () => unknown).call(value);
    if (converted === value) {
      throw new AuditSerializationError('对象的 toJSON 返回了自身，无法规范化');
    }
    return writeCanonical(converted, stack);
  }

  if (stack.includes(value)) {
    throw new AuditSerializationError('检测到循环引用：审计数据必须是可 JSON 序列化的树状结构');
  }

  stack.push(value);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value) parts.push(writeCanonical(item, stack));
      return `[${parts.join(',')}]`;
    }

    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = record[key];
      // 与 JSON.stringify 一致：值为 undefined 的属性在序列化后直接消失
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${writeCanonical(item, stack)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    stack.pop();
  }
}

/**
 * 取出参与哈希的事件字段（不含 hash 自身）。
 *
 * 显式列字段而不是「对象减去 hash」，是为了让哈希输入成为一份稳定的契约：
 * 将来给 AuditEvent 增加展示型字段时，不会悄悄改变已有记录的哈希。
 */
export function eventHashPayload(event: AuditEvent): Record<string, unknown> {
  return {
    seq: event.seq,
    id: event.id,
    at: event.at,
    actor: event.actor,
    action: event.action,
    entity: event.entity,
    entityId: event.entityId,
    before: event.before,
    after: event.after,
    reason: event.reason,
  };
}

/** 计算一条事件的哈希：sha256(prevHash + canonicalJson(payload))。 */
export function computeEventHash(event: AuditEvent): string {
  return sha256Hex(`${event.prevHash}${canonicalJson(eventHashPayload(event))}`);
}

/** 校验一条哈希是否为合法的 sha256 十六进制串。 */
export function isSha256Hex(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * 重算整条事件链。
 *
 * 同时检查三件事，缺一不可：
 *   - seq 从 1 开始连续递增（有人删掉中间一条会立刻暴露）；
 *   - 每条事件的 prevHash 等于上一条的 hash（链条没有断）；
 *   - 每条事件的 hash 等于重算结果（内容没有被改）。
 *
 * 返回 brokenAt 为第一处异常的 seq，便于人工直接定位到具体那一条记录。
 */
export function verifyEventChain(
  events: readonly AuditEvent[],
): { ok: boolean; brokenAt: number | null } {
  let prevHash = ZERO_HASH;
  let prevSeq = 0;

  for (const event of events) {
    const expectedSeq = prevSeq + 1;
    if (!Number.isInteger(event.seq) || event.seq !== expectedSeq) {
      return { ok: false, brokenAt: Number.isInteger(event.seq) ? event.seq : expectedSeq };
    }
    if (event.prevHash !== prevHash) {
      return { ok: false, brokenAt: event.seq };
    }
    if (computeEventHash(event) !== event.hash) {
      return { ok: false, brokenAt: event.seq };
    }
    prevHash = event.hash;
    prevSeq = event.seq;
  }

  return { ok: true, brokenAt: null };
}

/**
 * 链条头部哈希：最后一条事件的 hash，空链为 ZERO_HASH。
 *
 * 把这一串值定期抄到系统之外（邮件、纸质归档、第三方存证），
 * 就能发现「整条链被重算」或「尾部记录被整段截掉」这类仅靠自校验发现不了的篡改。
 */
export function chainHeadHash(events: readonly AuditEvent[]): string {
  const last = events[events.length - 1];
  return last === undefined ? ZERO_HASH : last.hash;
}
