/**
 * 审计库完整性校验。
 *
 * 校验两件事，缺一不可：
 *
 * 1. 哈希链是否连续（verifyEventChain）
 *    能发现：改内容、改操作人、删掉中间某条、插一条伪造记录。
 *    发现不了：整条链被重算、尾部被整段截掉。这两类只能靠外部锚定
 *    （定期把 chainHeadHash 抄到系统之外）来发现，所以本模块同时导出 chainHeadHash。
 *
 * 2. 版本表与事件流是否对得上
 *    正常的写入路径「一次变更 = 一条版本记录 + 一条审计事件」。
 *    如果版本表里多出记录（有人绕过仓储直接往 JSONL 里塞数据），
 *    或者版本号断档（有人删掉某一版），这里会报出来。
 *
 * 为什么校验要「强制从磁盘重读」：
 *   如果有人手工改了文件再来点「校验」，用缓存里的旧数据校验等于自欺欺人。
 *   AuditStore.verifyIntegrity() 会绕过读缓存重新解析文件。
 */

import type { AuditEvent, IsoDateTime, VersionRecord } from '../core/contracts.ts';
import { verifyEventChain } from './hash.ts';

/** 完整性报告（对外契约，字段名不可随意改）。 */
export interface IntegrityReport {
  /** 哈希链完整且没有孤立/断档记录时为 true */
  ok: boolean;
  /** 审计事件条数 */
  events: number;
  /** 第一处断链的事件 seq；链完整时为 null */
  brokenAt: number | null;
  /** 版本记录条数 */
  versionRecords: number;
  /** 孤立/断档/损坏记录的人类可读说明 */
  orphans: string[];
  /** 校验时间 */
  checkedAt: IsoDateTime;
}

export interface IntegrityInput {
  events: readonly AuditEvent[];
  versions: readonly VersionRecord[];
  /** 读取阶段发现的问题（损坏行、截断行等） */
  problems?: readonly string[];
  /** 校验时间；不传则用当前时间 */
  checkedAt?: IsoDateTime;
}

/**
 * 计入「变更」的事件动作。
 *
 * 只有这些动作会同时写一条版本记录；login / export 之类的动作只进事件流，
 * 如果把它们的数量也算进版本比对，正常的登录日志就会让校验永远失败。
 */
export const VERSION_MUTATION_ACTIONS: ReadonlySet<AuditEvent['action']> = new Set<AuditEvent['action']>([
  'create',
  'update',
  'soft_delete',
  'restore',
  'close_period',
  'reopen_period',
]);

/** 校验一组事件与版本记录（纯函数，便于单测与离线审计）。 */
export function verifyIntegrityOf(input: IntegrityInput): IntegrityReport {
  const chain = verifyEventChain(input.events);
  const orphans: string[] = [];

  if (input.problems !== undefined) {
    for (const problem of input.problems) {
      const text = String(problem).trim();
      if (text !== '') orphans.push(text);
    }
  }

  const versionGroups = new Map<string, VersionRecord[]>();
  for (const record of input.versions) {
    const key = groupKey(record.entity, record.entityId);
    const list = versionGroups.get(key);
    if (list === undefined) versionGroups.set(key, [record]);
    else list.push(record);
  }

  const eventCounts = new Map<string, number>();
  for (const event of input.events) {
    if (!VERSION_MUTATION_ACTIONS.has(event.action)) continue;
    const key = groupKey(event.entity, event.entityId);
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
  }

  for (const [key, records] of versionGroups) {
    const [entity, entityId] = splitKey(key);
    const sorted = [...records].sort((a, b) => a.version - b.version);

    const seen = new Set<number>();
    let maxVersion = 0;
    for (const record of sorted) {
      if (!Number.isInteger(record.version) || record.version < 1) {
        orphans.push(`版本号非法：${entity}/${entityId} 出现 v${String(record.version)}`);
        continue;
      }
      if (seen.has(record.version)) {
        orphans.push(`版本号重复：${entity}/${entityId} 出现两条 v${record.version}`);
      }
      seen.add(record.version);
      if (record.version > maxVersion) maxVersion = record.version;
    }

    // 断档：v1..vmax 中间少了谁。最多报 20 条，避免被恶意构造的巨大版本号刷屏。
    let reported = 0;
    for (let version = 1; version <= maxVersion && reported < 20; version += 1) {
      if (seen.has(version)) continue;
      orphans.push(`版本断档：${entity}/${entityId} 缺少 v${version}（现有最大 v${maxVersion}）`);
      reported += 1;
    }

    const eventCount = eventCounts.get(key) ?? 0;
    if (eventCount !== sorted.length) {
      orphans.push(
        `版本与事件不匹配：${entity}/${entityId} 有 ${sorted.length} 条版本记录，但只有 ${eventCount} 条变更事件` +
          '（可能有数据绕过仓储直接写入了版本表）',
      );
    }
  }

  for (const [key, count] of eventCounts) {
    if (versionGroups.has(key)) continue;
    const [entity, entityId] = splitKey(key);
    orphans.push(`缺少版本记录：${entity}/${entityId} 有 ${count} 条变更事件，但版本表为空`);
  }

  return {
    ok: chain.ok && orphans.length === 0,
    events: input.events.length,
    brokenAt: chain.brokenAt,
    versionRecords: input.versions.length,
    orphans,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

/** 把完整性报告格式化成中文多行文本（CLI / Web 直接展示）。 */
export function formatIntegrityReport(report: IntegrityReport): string {
  const lines: string[] = [];
  lines.push(report.ok ? '审计库完整性校验：通过' : '审计库完整性校验：未通过');
  lines.push(`- 审计事件：${report.events} 条`);
  lines.push(`- 版本记录：${report.versionRecords} 条`);
  lines.push(
    report.brokenAt === null
      ? '- 哈希链：完整（自第一条起逐条校验通过）'
      : `- 哈希链：在 seq=${report.brokenAt} 处断裂，该条及其之后的记录不可信`,
  );
  lines.push(`- 校验时间：${report.checkedAt}`);
  if (report.orphans.length === 0) {
    lines.push('- 孤立/断档/损坏记录：无');
  } else {
    lines.push(`- 孤立/断档/损坏记录：${report.orphans.length} 项`);
    for (const item of report.orphans) lines.push(`  · ${item}`);
  }
  return lines.join('\n');
}

function groupKey(entity: string, entityId: string): string {
  return `${entity}\u0000${entityId}`;
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf('\u0000');
  if (index < 0) return [key, ''];
  return [key.slice(0, index), key.slice(index + 1)];
}
