/**
 * 哈希链与完整性校验的单元测试。
 *
 * 这里模拟的是「有人动了审计库文件」的场景：
 *   - 改一条事件的 actor / 金额；
 *   - 删掉中间一条事件；
 *   - 往版本表里塞一条没有对应事件的记录；
 *   - 删掉某个中间版本造成版本断档；
 *   - 掉电导致末行截断。
 * 每一种都必须被 verifyIntegrity 发现，并且尽量定位到具体位置（seq / 版本号）。
 *
 * 篡改动作由测试自己用 writeFileSync 完成——这正是本模块要防的「绕过仓储直接改文件」。
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_ROOT } from '../src/core/config.ts';
import type { AuditEvent } from '../src/core/contracts.ts';
import {
  AuditLogCorruptError,
  AuditStore,
  ZERO_HASH,
  canonicalJson,
  chainHeadHash,
  computeEventHash,
  formatIntegrityReport,
  sha256Hex,
  verifyEventChain,
  verifyIntegrityOf,
} from '../src/audit/index.ts';

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = [];

function createStore(): { store: AuditStore; dir: string } {
  const dir = mkdtempSync(join(PROJECT_ROOT, '.test-tmp-audit-verify-'));
  tempDirs.push(dir);
  return { store: new AuditStore({ dataDir: dir, actor: '张三' }), dir };
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function lines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function writeLines(path: string, items: string[]): void {
  writeFileSync(path, `${items.join('\n')}\n`, 'utf8');
}

function buildEvent(seq: number, prevHash: string, actor: string): AuditEvent {
  const event: AuditEvent = {
    seq,
    id: `evt-${seq}`,
    at: `2024-01-0${seq}T10:00:00.000+08:00`,
    actor,
    action: 'create',
    entity: 'voucher',
    entityId: `v${seq}`,
    before: null,
    after: { seq },
    prevHash,
    hash: '',
  };
  event.hash = computeEventHash(event);
  return event;
}

/* ------------------------------------------------------------------ */
/* 规范化 JSON                                                         */
/* ------------------------------------------------------------------ */

describe('canonicalJson 规范化', () => {
  it('键名递归排序且无空白', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson({ z: { y: 1, x: [3, { b: 2, a: 1 }] } }), '{"z":{"x":[3,{"a":1,"b":2}],"y":1}}');
    assert.equal(canonicalJson({ a: 1 }).includes(' '), false);
  });

  it('与 JSON.stringify 的边界语义保持一致', () => {
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(undefined), 'null');
    assert.equal(canonicalJson(Number.NaN), 'null');
    assert.equal(canonicalJson(Number.POSITIVE_INFINITY), 'null');
    assert.equal(canonicalJson(-0), '0');
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
    assert.equal(canonicalJson([1, undefined, 2]), '[1,null,2]');
    assert.equal(canonicalJson('中文「引号」'), JSON.stringify('中文「引号」'));
  });

  it('同一份数据从 JSON 往返后哈希不变', () => {
    const data = { b: [1, { d: 4, c: 3 }], a: 'x', n: null };
    const roundTripped = JSON.parse(JSON.stringify(data)) as unknown;
    assert.equal(canonicalJson(data), canonicalJson(roundTripped));
  });

  it('循环引用直接报错，而不是悄悄截断', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    assert.throws(() => canonicalJson(cyclic), /循环引用/);
  });
});

describe('sha256Hex 与事件哈希', () => {
  it('已知向量正确', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex('中文').length, 64);
  });

  it('事件哈希稳定：同内容同哈希，改一个字段就变', () => {
    const first = buildEvent(1, ZERO_HASH, '张三');
    const same = buildEvent(1, ZERO_HASH, '张三');
    assert.equal(first.hash, same.hash);

    const changed = buildEvent(1, ZERO_HASH, '李四');
    assert.notEqual(first.hash, changed.hash);

    const otherPrev = buildEvent(1, 'a'.repeat(64), '张三');
    assert.notEqual(first.hash, otherPrev.hash);
  });

  it('事件哈希不包含 hash 自身（否则无解）', () => {
    const event = buildEvent(1, ZERO_HASH, '张三');
    const tampered = { ...event, hash: 'f'.repeat(64) };
    assert.equal(computeEventHash(tampered), event.hash);
  });
});

/* ------------------------------------------------------------------ */
/* 链校验                                                              */
/* ------------------------------------------------------------------ */

describe('verifyEventChain 链校验', () => {
  it('空链视为完整', () => {
    assert.deepEqual(verifyEventChain([]), { ok: true, brokenAt: null });
    assert.equal(chainHeadHash([]), ZERO_HASH);
  });

  it('正常链通过，头部哈希为最后一条', () => {
    const e1 = buildEvent(1, ZERO_HASH, '张三');
    const e2 = buildEvent(2, e1.hash, '张三');
    const e3 = buildEvent(3, e2.hash, '李四');
    assert.deepEqual(verifyEventChain([e1, e2, e3]), { ok: true, brokenAt: null });
    assert.equal(chainHeadHash([e1, e2, e3]), e3.hash);
  });

  it('改内容断链并定位到 seq', () => {
    const e1 = buildEvent(1, ZERO_HASH, '张三');
    const e2 = buildEvent(2, e1.hash, '张三');
    const e3 = buildEvent(3, e2.hash, '张三');
    const tampered = { ...e2, actor: '李四' };
    assert.deepEqual(verifyEventChain([e1, tampered, e3]), { ok: false, brokenAt: 2 });
  });

  it('删掉中间一条断链（seq 不连续）', () => {
    const e1 = buildEvent(1, ZERO_HASH, '张三');
    const e2 = buildEvent(2, e1.hash, '张三');
    const e3 = buildEvent(3, e2.hash, '张三');
    assert.deepEqual(verifyEventChain([e1, e3]), { ok: false, brokenAt: 3 });
  });

  it('prevHash 不匹配断链', () => {
    const e1 = buildEvent(1, ZERO_HASH, '张三');
    const e2 = buildEvent(2, 'b'.repeat(64), '张三');
    assert.deepEqual(verifyEventChain([e1, e2]), { ok: false, brokenAt: 2 });
  });

  it('第一条的 prevHash 不是 64 个 0 也断链', () => {
    const e1 = buildEvent(1, 'c'.repeat(64), '张三');
    assert.deepEqual(verifyEventChain([e1]), { ok: false, brokenAt: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* 完整性报告                                                          */
/* ------------------------------------------------------------------ */

describe('AuditStore.verifyIntegrity 完整性校验', () => {
  it('空库通过，写入后计数正确', () => {
    const { store } = createStore();
    const empty = store.verifyIntegrity();
    assert.equal(empty.ok, true);
    assert.equal(empty.events, 0);
    assert.equal(empty.versionRecords, 0);
    assert.deepEqual(empty.orphans, []);

    store.save('voucher', 'v1', { id: 'v1', period: '2024-01', amount: 100 });
    store.save('voucher', 'v1', { id: 'v1', period: '2024-01', amount: 200 });
    store.save('document', 'd1', { id: 'd1' });

    const report = store.verifyIntegrity();
    assert.equal(report.ok, true);
    assert.equal(report.events, 3);
    assert.equal(report.versionRecords, 3);
    assert.equal(report.brokenAt, null);
    assert.match(report.checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('手工改一条事件的内容 → 断链并定位到 seq', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', { id: 'v1', amount: 100 });
    store.save('voucher', 'v2', { id: 'v2', amount: 200 });
    store.save('voucher', 'v3', { id: 'v3', amount: 300 });

    const path = join(dir, 'audit.events.jsonl');
    const items = lines(path);
    const second = JSON.parse(items[1] ?? '{}') as Record<string, unknown>;
    second['actor'] = '被篡改的人';
    items[1] = JSON.stringify(second);
    writeLines(path, items);

    const report = store.verifyIntegrity();
    assert.equal(report.ok, false);
    assert.equal(report.brokenAt, 2);
    assert.equal(report.events, 3);
  });

  it('手工改第一条事件 → brokenAt 为 1', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', { id: 'v1', amount: 100 });
    store.save('voucher', 'v2', { id: 'v2', amount: 200 });

    const path = join(dir, 'audit.events.jsonl');
    const items = lines(path);
    const first = JSON.parse(items[0] ?? '{}') as Record<string, unknown>;
    first['after'] = { id: 'v1', amount: 999999 };
    items[0] = JSON.stringify(first);
    writeLines(path, items);

    const report = store.verifyIntegrity();
    assert.equal(report.ok, false);
    assert.equal(report.brokenAt, 1);
  });

  it('删掉中间一条事件 → 断链', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', { id: 'v1' });
    store.save('voucher', 'v2', { id: 'v2' });
    store.save('voucher', 'v3', { id: 'v3' });

    const path = join(dir, 'audit.events.jsonl');
    const items = lines(path);
    writeLines(path, [items[0] ?? '', items[2] ?? '']);

    const report = store.verifyIntegrity();
    assert.equal(report.ok, false);
    assert.equal(report.brokenAt, 3);
  });

  it('追加一条伪造事件（prevHash 对但 hash 假）→ 断链', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', { id: 'v1' });
    const path = join(dir, 'audit.events.jsonl');
    const items = lines(path);
    const last = JSON.parse(items[items.length - 1] ?? '{}') as AuditEvent;

    const forged: AuditEvent = {
      ...last,
      seq: last.seq + 1,
      id: 'evt-forged',
      at: '2024-01-01T00:00:00.000+08:00',
      actor: '伪造者',
      before: null,
      after: { id: 'v-伪造' },
      prevHash: last.hash,
      hash: 'f'.repeat(64),
    };
    appendFileSync(path, `${JSON.stringify(forged)}\n`, 'utf8');

    const report = store.verifyIntegrity();
    assert.equal(report.ok, false);
    assert.equal(report.brokenAt, last.seq + 1);
  });

  it('版本表被塞入无事件的孤立记录 → orphans 报出', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', { id: 'v1' });

    const path = join(dir, 'voucher.versions.jsonl');
    const orphan = {
      versionId: 'voucher:v-orphan:v1',
      entity: 'voucher',
      entityId: 'v-orphan',
      version: 1,
      data: { id: 'v-orphan', amount: 888 },
      validFrom: '2024-01-01T00:00:00.000+08:00',
      validTo: null,
      deleted: false,
      createdBy: '绕过仓储的人',
      createdAt: '2024-01-01T00:00:00.000+08:00',
    };
    appendFileSync(path, `${JSON.stringify(orphan)}\n`, 'utf8');

    const report = store.verifyIntegrity();
    assert.equal(report.ok, false);
    assert.equal(report.orphans.some((item) => item.includes('版本与事件不匹配')), true);
    assert.equal(report.versionRecords, 2);
  });

  it('版本断档（删掉 v2）→ orphans 报出', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', { id: 'v1', attachments: 1 });
    store.save('voucher', 'v1', { id: 'v1', attachments: 2 });
    store.save('voucher', 'v1', { id: 'v1', attachments: 3 });

    const path = join(dir, 'voucher.versions.jsonl');
    const items = lines(path);
    writeLines(path, [items[0] ?? '', items[2] ?? '']);

    const report = store.verifyIntegrity();
    assert.equal(report.ok, false);
    assert.equal(report.orphans.some((item) => item.includes('版本断档')), true);
  });

  it('中间行损坏 → 读取跳过损坏行，orphans 报出，健康检查拦截', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', { id: 'v1' });
    store.save('voucher', 'v2', { id: 'v2' });

    const path = join(dir, 'audit.events.jsonl');
    const items = lines(path);
    items.splice(1, 0, '{这不是合法 JSON');
    writeLines(path, items);

    const report = store.verifyIntegrity();
    assert.equal(report.ok, false);
    assert.equal(report.orphans.some((item) => item.includes('不是合法 JSON')), true);

    // 读取仍然可用（跳过损坏行），否则一次宕机就会让整个账套打不开
    assert.equal(store.events().length, 2);
    assert.equal(store.storageProblems().length >= 1, true);
    // 但「拿损坏的账套出报表」必须被拦住
    assert.throws(() => store.assertStorageHealthy(), AuditLogCorruptError);
    assert.throws(() => store.assertStorageHealthy(), /审计库存在/);
  });

  it('末行截断（掉电残留）→ 读取不炸，校验报告问题', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', { id: 'v1' });
    store.save('voucher', 'v2', { id: 'v2' });

    const path = join(dir, 'audit.events.jsonl');
    const raw = readFileSync(path, 'utf8');
    const truncated = raw.slice(0, raw.length - 20);
    writeFileSync(path, truncated, 'utf8');

    assert.equal(store.events().length, 1);
    const report = store.verifyIntegrity();
    assert.equal(report.ok, false);
    assert.equal(report.orphans.length >= 1, true);
    assert.equal(store.storageProblems().some((item) => item.includes('不是合法 JSON')), true);
  });

  it('校验强制重读磁盘，不使用读缓存', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', { id: 'v1' });
    assert.equal(store.verifyIntegrity().ok, true);

    const path = join(dir, 'voucher.versions.jsonl');
    const items = lines(path);
    const record = JSON.parse(items[0] ?? '{}') as Record<string, unknown>;
    record['version'] = 9;
    items[0] = JSON.stringify(record);
    writeLines(path, items);

    const report = store.verifyIntegrity();
    assert.equal(report.ok, false);
    assert.equal(report.orphans.some((item) => item.includes('版本断档')), true);
  });

  it('formatIntegrityReport 输出中文结论', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', { id: 'v1' });
    const okText = formatIntegrityReport(store.verifyIntegrity());
    assert.equal(okText.includes('通过'), true);
    assert.equal(okText.includes('哈希链：完整'), true);
    assert.equal(okText.includes('审计事件：1 条'), true);

    const brokenText = formatIntegrityReport({
      ok: false,
      events: 3,
      brokenAt: 2,
      versionRecords: 3,
      orphans: ['版本断档：voucher/v1 缺少 v2'],
      checkedAt: '2024-01-01T00:00:00.000+08:00',
    });
    assert.equal(brokenText.includes('未通过'), true);
    assert.equal(brokenText.includes('seq=2'), true);
    assert.equal(brokenText.includes('缺少 v2'), true);
  });
});

/* ------------------------------------------------------------------ */
/* 纯函数校验（离线审计：只给事件与版本记录，不碰磁盘）                  */
/* ------------------------------------------------------------------ */

describe('verifyIntegrityOf 纯函数', () => {
  it('事件与版本记录一一对应时通过', () => {
    const e1 = buildEvent(1, ZERO_HASH, '张三');
    const report = verifyIntegrityOf({
      events: [e1],
      versions: [
        {
          versionId: 'voucher:v1:v1',
          entity: 'voucher',
          entityId: 'v1',
          version: 1,
          data: { seq: 1 },
          validFrom: e1.at,
          validTo: null,
          deleted: false,
          createdBy: '张三',
          createdAt: e1.at,
        },
      ],
      checkedAt: e1.at,
    });
    assert.equal(report.ok, true);
    assert.equal(report.events, 1);
    assert.equal(report.versionRecords, 1);
    assert.equal(report.checkedAt, e1.at);
  });

  it('有变更事件却没有版本记录 → orphans', () => {
    const e1 = buildEvent(1, ZERO_HASH, '张三');
    const report = verifyIntegrityOf({ events: [e1], versions: [], checkedAt: e1.at });
    assert.equal(report.ok, false);
    assert.equal(report.orphans.some((item) => item.includes('缺少版本记录')), true);
  });

  it('非变更事件（login / export）不计入版本比对', () => {
    const login: AuditEvent = {
      ...buildEvent(1, ZERO_HASH, '张三'),
      action: 'login',
    };
    login.hash = computeEventHash(login);
    const report = verifyIntegrityOf({ events: [login], versions: [], checkedAt: login.at });
    assert.equal(report.ok, true);
  });

  it('传入的读取问题会并入 orphans', () => {
    const report = verifyIntegrityOf({
      events: [],
      versions: [],
      problems: ['audit.events.jsonl 第 3 行：不是合法 JSON'],
    });
    assert.equal(report.ok, false);
    assert.deepEqual(report.orphans, ['audit.events.jsonl 第 3 行：不是合法 JSON']);
  });
});
