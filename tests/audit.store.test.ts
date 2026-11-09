/**
 * 审计库（版本表 + 审计事件流）单元测试。
 *
 * 这些测试守护的是「账务数据不能被悄悄篡改」这条底线，所以断言写得比一般单测更细：
 *   - 每个版本必须能还原出「谁、什么时候、把什么改成了什么」；
 *   - 软删除后数据必须仍然可查（history），而不是消失；
 *   - 已结账期间必须真的写不进去；
 *   - 源码里不允许出现任何物理删除/覆盖写的调用。
 *
 * 临时目录一律用 mkdtempSync 建在项目根下（沙盒只允许在项目内写），
 * 测试结束统一删除，避免污染工作区。
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_ROOT } from '../src/core/config.ts';
import type { Voucher } from '../src/core/contracts.ts';
import {
  AuditStore,
  EntityNotFoundError,
  EntitySoftDeletedError,
  PeriodCloseBlockedError,
  PeriodCloseError,
  PeriodLockedError,
  VersionConflictError,
  VersionNotFoundError,
  createAuditRepositories,
  externalValidator,
  listLockedPeriods,
  loadAuditConfig,
} from '../src/audit/index.ts';

/* ------------------------------------------------------------------ */
/* 测试脚手架                                                          */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = [];

function createStore(actor = '张三'): { store: AuditStore; dir: string } {
  const dir = mkdtempSync(join(PROJECT_ROOT, '.test-tmp-audit-'));
  tempDirs.push(dir);
  const store = new AuditStore({ dataDir: dir, actor });
  return { store, dir };
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeVoucher(id: string, period: string, overrides: Partial<Voucher> = {}): Voucher {
  const base: Voucher = {
    id,
    date: `${period}-15`,
    period,
    word: `记-${id}`,
    lines: [
      {
        accountCode: '6602.01',
        accountName: '管理费用/办公费',
        debit: 10000,
        credit: 0,
        summary: '办公费',
        source: { file: 'test.xlsx', row: 2 },
      },
      {
        accountCode: '1002.01',
        accountName: '银行存款/基本户',
        debit: 0,
        credit: 10000,
        summary: '办公费',
        source: { file: 'test.xlsx', row: 2 },
      },
    ],
    attachments: 1,
    balanced: true,
    totalDebit: 10000,
    totalCredit: 10000,
    source: { file: 'test.xlsx' },
    warnings: [],
  };
  return { ...base, ...overrides };
}

function readJsonLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

/* ------------------------------------------------------------------ */
/* 版本语义                                                            */
/* ------------------------------------------------------------------ */

describe('版本语义：新建 / 更新 / 历史', () => {
  it('首次保存生成 v1，记录字段完整', () => {
    const { store } = createStore();
    const record = store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));

    assert.equal(record.entity, 'voucher');
    assert.equal(record.entityId, 'v1');
    assert.equal(record.version, 1);
    assert.equal(record.deleted, false);
    assert.equal(record.createdBy, '张三');
    assert.equal(record.validTo, null);
    assert.equal(record.versionId, 'voucher:v1:v1');
    assert.match(record.validFrom, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    assert.equal((record.data as Voucher).id, 'v1');
    assert.equal(store.current<Voucher>('voucher', 'v1')?.period, '2024-01');
  });

  it('更新追加 v2，并物化 v1 的 validTo', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'), { summary: '初始录入' });
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 3 }), { summary: '补充附件' });

    const history = store.history('voucher', 'v1');
    assert.equal(history.length, 2);
    assert.equal(history[0]?.version, 1);
    assert.equal(history[1]?.version, 2);
    assert.equal(history[0]?.validTo, history[1]?.validFrom);
    assert.equal(history[1]?.validTo, null);
    assert.equal(history[0]?.changeSummary, '初始录入');
    assert.equal(history[1]?.changeSummary, '补充附件');
    assert.equal(history[0]?.data === history[1]?.data, false);
    assert.equal(store.current<Voucher>('voucher', 'v1')?.attachments, 3);
    assert.equal(store.currentRecord('voucher', 'v1')?.version, 2);
  });

  it('连续更新版本号从 1 连续递增', () => {
    const { store } = createStore();
    for (let index = 1; index <= 5; index += 1) {
      store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: index }));
    }
    const history = store.history('voucher', 'v1');
    assert.deepEqual(
      history.map((item) => item.version),
      [1, 2, 3, 4, 5],
    );
    assert.equal(history[4]?.validTo, null);
    assert.equal(store.count('voucher'), 1);
  });

  it('拒绝空数据、空 id、未知实体', () => {
    const { store } = createStore();
    assert.throws(() => store.save('voucher', 'v1', null), /不能为 null/);
    assert.throws(() => store.save('voucher', 'v1', undefined), /不能为 null/);
    assert.throws(() => store.save('voucher', '   ', { a: 1 }), /id 不能为空/);
    assert.throws(
      () => store.save('not_an_entity' as never, 'x', { a: 1 }),
      /未知的实体类型/,
    );
  });

  it('配置要求写摘要的实体（tax_return / statement）缺摘要时拒绝写入', () => {
    const { store } = createStore();
    assert.throws(
      () => store.save('tax_return', 't1', { period: '2024-01' }),
      /必须填写变更摘要/,
    );
    const record = store.save('tax_return', 't1', { period: '2024-01' }, { summary: '生成申报草稿' });
    assert.equal(record.changeSummary, '生成申报草稿');
  });

  it('写入后与调用方对象解耦，读取返回副本', () => {
    const { store } = createStore();
    const data = { name: '原始', amount: 100 };
    store.save('settings', 's1', data);
    data.name = '被外部改掉';

    const first = store.current<{ name: string; amount: number }>('settings', 's1');
    assert.equal(first?.name, '原始');
    assert.equal(first?.amount, 100);

    if (first !== null) first.name = '读出来再改';
    const second = store.current<{ name: string }>('settings', 's1');
    assert.equal(second?.name, '原始');
  });

  it('不存在的实体 current 返回 null，history 返回空数组', () => {
    const { store } = createStore();
    assert.equal(store.current('voucher', 'missing'), null);
    assert.deepEqual(store.history('voucher', 'missing'), []);
    assert.deepEqual(store.list('voucher'), []);
  });
});

/* ------------------------------------------------------------------ */
/* 软删除与恢复                                                        */
/* ------------------------------------------------------------------ */

describe('软删除与恢复', () => {
  it('软删除后 current 为 null，history 仍能看到完整数据', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    const removed = store.softDelete({
      entity: 'voucher',
      entityId: 'v1',
      actor: '李四',
      reason: '凭证重复录入，作废',
      version: 1,
    });

    assert.equal(removed.version, 2);
    assert.equal(removed.deleted, true);
    assert.equal(removed.deletedBy, '李四');
    assert.equal(removed.deletedReason, '凭证重复录入，作废');
    assert.match(removed.deletedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(store.current('voucher', 'v1'), null);

    const history = store.history('voucher', 'v1');
    assert.equal(history.length, 2);
    assert.equal(history[1]?.deleted, true);
    assert.equal((history[1]?.data as Voucher).id, 'v1');
    assert.equal(history[0]?.validTo, history[1]?.validFrom);
  });

  it('list 默认排除已删除，includeDeleted 能列出', () => {
    const { store } = createStore();
    store.save('voucher', 'a', makeVoucher('a', '2024-01'));
    store.save('voucher', 'b', makeVoucher('b', '2024-01'));
    store.softDelete({ entity: 'voucher', entityId: 'a', actor: '李四', reason: '重复', version: 1 });

    assert.deepEqual(store.list('voucher'), ['b']);
    assert.deepEqual(store.list('voucher', { includeDeleted: true }), ['a', 'b']);
    assert.equal(store.count('voucher'), 1);
    assert.equal(store.count('voucher', { includeDeleted: true }), 2);
  });

  it('restore 追加新版本并恢复可见', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    store.softDelete({ entity: 'voucher', entityId: 'v1', actor: '李四', reason: '误删', version: 1 });
    const restored = store.restore('voucher', 'v1', '王五', '经复核确认不是重复凭证');

    assert.equal(restored.version, 3);
    assert.equal(restored.deleted, false);
    assert.equal(restored.createdBy, '王五');
    assert.equal(restored.changeSummary, '恢复：经复核确认不是重复凭证');
    assert.notEqual(store.current('voucher', 'v1'), null);
    assert.deepEqual(store.list('voucher'), ['v1']);
    assert.equal(store.history('voucher', 'v1').length, 3);
  });

  it('restore 未删除实体 / 空理由 / 不存在实体都会报错', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    assert.throws(() => store.restore('voucher', 'v1', '王五', '不需要恢复'), /无需恢复/);
    store.softDelete({ entity: 'voucher', entityId: 'v1', actor: '李四', reason: '重复', version: 1 });
    assert.throws(() => store.restore('voucher', 'v1', '王五', '   '), /恢复必须填写理由/);
    assert.throws(() => store.restore('voucher', 'nope', '王五', '理由'), EntityNotFoundError);
  });

  it('软删除的版本号必须与当前版本一致（乐观并发）', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 2 }));

    assert.throws(
      () => store.softDelete({ entity: 'voucher', entityId: 'v1', actor: '李四', reason: '重复', version: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof VersionConflictError);
        assert.equal(error.expected, 1);
        assert.equal(error.actual, 2);
        assert.match(error.message, /不会静默覆盖/);
        return true;
      },
    );
  });

  it('软删除不存在 / 已删除的实体、以及空理由都会报错', () => {
    const { store } = createStore();
    assert.throws(
      () => store.softDelete({ entity: 'voucher', entityId: 'nope', actor: '李四', reason: '重复', version: 1 }),
      EntityNotFoundError,
    );

    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    assert.throws(
      () => store.softDelete({ entity: 'voucher', entityId: 'v1', actor: '李四', reason: '  ', version: 1 }),
      /软删除必须填写原因/,
    );

    store.softDelete({ entity: 'voucher', entityId: 'v1', actor: '李四', reason: '重复', version: 1 });
    assert.throws(
      () => store.softDelete({ entity: 'voucher', entityId: 'v1', actor: '李四', reason: '再删一次', version: 2 }),
      EntitySoftDeletedError,
    );
  });

  it('已软删除的实体不能直接 save，必须先 restore', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    store.softDelete({ entity: 'voucher', entityId: 'v1', actor: '李四', reason: '重复', version: 1 });
    assert.throws(
      () => store.save('voucher', 'v1', makeVoucher('v1', '2024-01')),
      (error: unknown) => {
        assert.ok(error instanceof EntitySoftDeletedError);
        assert.match(error.message, /先调用 restore/);
        return true;
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 时点查询                                                            */
/* ------------------------------------------------------------------ */

describe('时点查询 getAt', () => {
  it('返回该时刻生效的版本', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 1 }));
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 2 }));
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 3 }));

    const history = store.history('voucher', 'v1');
    const t1 = history[0]?.validFrom ?? '';
    const t2 = history[1]?.validFrom ?? '';
    const t3 = history[2]?.validFrom ?? '';

    assert.equal(store.getAt<Voucher>('voucher', 'v1', t1)?.attachments, 1);
    assert.equal(store.getAt<Voucher>('voucher', 'v1', t2)?.attachments, 2);
    assert.equal(store.getAt<Voucher>('voucher', 'v1', t3)?.attachments, 3);
  });

  it('早于第一版返回 null，晚于最后一版返回最新值', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 7 }));
    assert.equal(store.getAt('voucher', 'v1', '2000-01-01T00:00:00+08:00'), null);
    assert.equal(store.getAt<Voucher>('voucher', 'v1', '2999-12-31T23:59:59+08:00')?.attachments, 7);
  });

  it('软删除期间 getAt 返回 null，但 versionAt 仍能拿到当时的记录', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    const removed = store.softDelete({
      entity: 'voucher',
      entityId: 'v1',
      actor: '李四',
      reason: '重复',
      version: 1,
    });

    assert.equal(store.getAt('voucher', 'v1', removed.validFrom), null);
    const at = store.versionAt('voucher', 'v1', removed.validFrom);
    assert.equal(at?.deleted, true);
    assert.equal(at?.version, 2);
  });

  it('非法时点抛 AuditValidationError', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    assert.throws(() => store.getAt('voucher', 'v1', '不是时间'), /不是合法的 ISO-8601 时间/);
  });
});

/* ------------------------------------------------------------------ */
/* 字段级差异                                                          */
/* ------------------------------------------------------------------ */

describe('字段级差异 diff', () => {
  it('识别 added / removed / changed 三类', () => {
    const { store } = createStore();
    store.save('settings', 's1', { a: 1, b: '不变', c: true, list: [1, 2] });
    store.save('settings', 's1', { a: 2, b: '不变', d: '新增', list: [1, 3] });

    const diffs = store.diff('settings', 's1', 1, 2);
    const byField = new Map(diffs.map((item) => [item.field, item]));

    assert.equal(byField.get('a')?.kind, 'changed');
    assert.equal(byField.get('a')?.before, 1);
    assert.equal(byField.get('a')?.after, 2);
    assert.equal(byField.get('c')?.kind, 'removed');
    assert.equal(byField.get('d')?.kind, 'added');
    assert.equal(byField.get('d')?.after, '新增');
    assert.equal(byField.get('list[1]')?.kind, 'changed');
    assert.equal(byField.get('list[1]')?.before, 2);
    assert.equal(byField.get('list[1]')?.after, 3);
    assert.equal(byField.has('b'), false);
  });

  it('嵌套对象用点号路径定位', () => {
    const { store } = createStore();
    store.save('document', 'd1', { meta: { amount: 100, tax: 6 }, tags: ['a'] });
    store.save('document', 'd1', { meta: { amount: 200, tax: 6 }, tags: ['a'] });

    const diffs = store.diff('document', 'd1', 1, 2);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.field, 'meta.amount');
    assert.equal(diffs[0]?.kind, 'changed');
  });

  it('按 JSON 语义处理 undefined 与数组新增元素', () => {
    const { store } = createStore();
    store.save('settings', 's1', { a: 1, list: [1] });
    store.save('settings', 's1', { a: 1, list: [1, null] });

    const diffs = store.diff('settings', 's1', 1, 2);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]?.field, 'list[1]');
    assert.equal(diffs[0]?.kind, 'added');
    assert.equal(diffs[0]?.after, null);
  });

  it('同一版本对比为空，版本不存在报错', () => {
    const { store } = createStore();
    store.save('document', 'd1', { a: 1 });
    assert.deepEqual(store.diff('document', 'd1', 1, 1), []);
    assert.throws(() => store.diff('document', 'd1', 1, 9), VersionNotFoundError);
  });
});

/* ------------------------------------------------------------------ */
/* 审计事件                                                            */
/* ------------------------------------------------------------------ */

describe('审计事件流', () => {
  it('create / update / soft_delete / restore 全部落事件并成链', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 2 }));
    store.softDelete({ entity: 'voucher', entityId: 'v1', actor: '李四', reason: '重复', version: 2 });
    store.restore('voucher', 'v1', '王五', '复核后确认不重复');

    const events = store.events({ entity: 'voucher', entityId: 'v1' });
    assert.deepEqual(
      events.map((item) => item.action),
      ['create', 'update', 'soft_delete', 'restore'],
    );
    assert.deepEqual(
      events.map((item) => item.seq),
      [1, 2, 3, 4],
    );
    assert.equal(events[0]?.prevHash, '0'.repeat(64));
    assert.equal(events[1]?.prevHash, events[0]?.hash);
    assert.equal(events[3]?.prevHash, events[2]?.hash);
    assert.match(events[0]?.hash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(new Set(events.map((item) => item.id)).size, 4);
  });

  it('事件 before / after 保留完整快照', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 1 }), { summary: '初始' });
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 9 }), { summary: '改附件数' });
    store.softDelete({ entity: 'voucher', entityId: 'v1', actor: '李四', reason: '重复', version: 2 });

    const events = store.events({ entity: 'voucher', entityId: 'v1' });
    assert.equal(events[0]?.before, null);
    assert.equal((events[0]?.after as Voucher).attachments, 1);
    assert.equal((events[1]?.before as Voucher).attachments, 1);
    assert.equal((events[1]?.after as Voucher).attachments, 9);
    assert.equal((events[2]?.before as Voucher).attachments, 9);
    assert.equal((events[2]?.after as Voucher).attachments, 9);
    assert.equal(events[1]?.reason, '改附件数');
    assert.equal(events[2]?.reason, '重复');
  });

  it('按 entity / entityId / actor / 时间区间过滤', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'), { actor: '张三' });
    store.save('voucher', 'v2', makeVoucher('v2', '2024-01'), { actor: '李四' });
    store.save('document', 'd1', { id: 'd1' }, { actor: '李四' });

    assert.equal(store.events({ entity: 'voucher' }).length, 2);
    assert.equal(store.events({ entity: 'voucher', entityId: 'v2' }).length, 1);
    assert.equal(store.events({ actor: '李四' }).length, 2);
    assert.equal(store.events({ entity: 'document' }).length, 1);

    const all = store.events();
    const middle = all[1]?.at ?? '';
    assert.equal(store.events({ from: middle }).length, 2);
    assert.equal(store.events({ to: middle }).length, 2);
    assert.equal(store.events({ from: middle, to: middle }).length, 1);
  });

  it('recordEvent 只写事件不写版本（登录 / 导出 / 签署）', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));

    const event = store.recordEvent({
      action: 'export',
      entity: 'statement',
      entityId: 's1',
      actor: '王五',
      after: { file: '2024-01-报表.xlsx' },
      reason: '导出给管理层复核',
    });
    assert.equal(event.seq, 2);
    assert.equal(event.action, 'export');
    assert.equal(event.actor, '王五');
    assert.equal(event.prevHash.length, 64);
    assert.equal(store.history('statement', 's1').length, 0);
    assert.equal(store.events({ entity: 'statement' }).length, 1);
    assert.equal(store.verifyIntegrity().ok, true);
  });

  it('recordEvent 拒绝变更类动作，避免版本表与事件流对不上', () => {
    const { store } = createStore();
    assert.throws(
      () => store.recordEvent({ action: 'update', entity: 'voucher', entityId: 'v1' }),
      /必须通过 save/,
    );
    assert.throws(
      () => store.recordEvent({ action: 'login', entity: 'voucher', entityId: '  ' }),
      /id 不能为空/,
    );
  });

  it('events 返回副本，改动不影响库内事件', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    const events = store.events();
    if (events[0] !== undefined) {
      (events[0].after as Voucher).attachments = 999;
      events[0].actor = '伪造的人';
    }
    const again = store.events();
    assert.equal((again[0]?.after as Voucher).attachments, 1);
    assert.equal(again[0]?.actor, '张三');
  });
});

/* ------------------------------------------------------------------ */
/* 落盘格式与追加式                                                    */
/* ------------------------------------------------------------------ */

describe('落盘格式与只追加', () => {
  it('按约定生成 <entity>.versions.jsonl 与 audit.events.jsonl', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    assert.equal(existsSync(join(dir, 'voucher.versions.jsonl')), true);
    assert.equal(existsSync(join(dir, 'audit.events.jsonl')), true);
    assert.equal(existsSync(join(dir, 'period_close.versions.jsonl')), false);
  });

  it('更新只追加新行，旧行逐字节不变', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    const path = join(dir, 'voucher.versions.jsonl');
    const before = readFileSync(path, 'utf8');
    const beforeLines = readJsonLines(path);

    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 5 }), { summary: '追加测试' });
    const after = readFileSync(path, 'utf8');
    const afterLines = readJsonLines(path);

    assert.equal(after.startsWith(before), true);
    assert.equal(afterLines.length, beforeLines.length + 1);
    assert.equal(afterLines[0], beforeLines[0]);
    assert.equal(after.endsWith('\n'), true);
  });

  it('落盘行里 validTo 恒为 null（由下一条版本的 validFrom 推导）', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 2 }));
    const lines = readJsonLines(join(dir, 'voucher.versions.jsonl')).map(
      (line) => JSON.parse(line) as { validTo: unknown },
    );
    assert.equal(lines[0]?.validTo, null);
    assert.equal(lines[1]?.validTo, null);
    assert.equal(store.history('voucher', 'v1')[0]?.validTo !== null, true);
  });

  it('重新打开审计库能读到既有历史', () => {
    const { store, dir } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 2 }));

    const reopened = new AuditStore({ dataDir: dir, actor: '李四' });
    assert.equal(reopened.history('voucher', 'v1').length, 2);
    assert.equal(reopened.current<Voucher>('voucher', 'v1')?.attachments, 2);
    assert.equal(reopened.events().length, 2);
    assert.equal(reopened.verifyIntegrity().ok, true);
  });

  it('两个实例交替写入仍保持版本连续、哈希链完整', () => {
    const dir = mkdtempSync(join(PROJECT_ROOT, '.test-tmp-audit-'));
    tempDirs.push(dir);
    const first = new AuditStore({ dataDir: dir, actor: '张三' });
    const second = new AuditStore({ dataDir: dir, actor: '李四' });

    first.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 1 }));
    second.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 2 }));
    first.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 3 }));

    assert.equal(first.history('voucher', 'v1').length, 3);
    assert.equal(second.history('voucher', 'v1').length, 3);
    assert.equal(second.current<Voucher>('voucher', 'v1')?.attachments, 3);
    assert.deepEqual(
      first.events().map((item) => item.seq),
      [1, 2, 3],
    );
    assert.equal(first.verifyIntegrity().ok, true);
    assert.equal(second.verifyIntegrity().ok, true);
  });

  it('dataDir 不存在时自动递归创建', () => {
    const base = mkdtempSync(join(PROJECT_ROOT, '.test-tmp-audit-'));
    tempDirs.push(base);
    const nested = join(base, 'a', 'b', 'c');
    const store = new AuditStore({ dataDir: nested });
    store.save('settings', 's1', { ok: true });
    assert.equal(existsSync(nested), true);
    assert.equal(existsSync(join(nested, 'audit.events.jsonl')), true);
  });

  it('连续写入的时间戳严格单调递增', () => {
    const { store } = createStore();
    for (let index = 1; index <= 3; index += 1) {
      store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: index }));
    }
    const history = store.history('voucher', 'v1');
    const stamps = history.map((item) => Date.parse(item.validFrom));
    assert.equal(stamps[0]! < stamps[1]!, true);
    assert.equal(stamps[1]! < stamps[2]!, true);
    const eventStamps = store.events().map((item) => Date.parse(item.at));
    assert.equal(eventStamps[0]! <= eventStamps[1]!, true);
    assert.equal(eventStamps[1]! <= eventStamps[2]!, true);
  });

  it('空目录下 verifyIntegrity 通过', () => {
    const { store } = createStore();
    const report = store.verifyIntegrity();
    assert.equal(report.ok, true);
    assert.equal(report.events, 0);
    assert.equal(report.versionRecords, 0);
    assert.deepEqual(report.orphans, []);
  });
});

/* ------------------------------------------------------------------ */
/* 期间锁账                                                            */
/* ------------------------------------------------------------------ */

describe('期间结账与反结账', () => {
  it('结账后该期间写入抛 PeriodLockedError，其它期间不受影响', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    store.closePeriod('2024-01', '李四', '2024 年 1 月月结');

    assert.equal(store.isPeriodLocked('2024-01'), true);
    assert.equal(store.isPeriodLocked('2024-02'), false);

    assert.throws(
      () => store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 2 })),
      (error: unknown) => {
        assert.ok(error instanceof PeriodLockedError);
        assert.equal(error.period, '2024-01');
        assert.match(error.message, /已结账并锁定/);
        return true;
      },
    );

    const other = store.save('voucher', 'v2', makeVoucher('v2', '2024-02'));
    assert.equal(other.version, 1);
  });

  it('AI 不能以「系统」身份结账，必须由人工签署', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    assert.throws(
      () => store.closePeriod('2024-01', '系统'),
      (error: unknown) => {
        assert.ok(error instanceof PeriodCloseError);
        assert.equal(error.code, 'invalid_actor');
        assert.match(error.message, /必须由人工签署/);
        return true;
      },
    );
    assert.equal(store.isPeriodLocked('2024-01'), false);
    store.closePeriod('2024-01', '李四');
    assert.equal(store.isPeriodLocked('2024-01'), true);
  });

  it('结账留痕：period_close 版本 + close_period 事件', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    store.closePeriod('2024-01', '李四', '月结完成');

    const state = store.readPeriodState('2024-01');
    assert.equal(state?.locked, true);
    assert.equal(state?.closedBy, '李四');
    assert.equal(state?.note, '月结完成');
    assert.equal(state?.voucherCount, 1);
    assert.equal(store.history('period_close', '2024-01').length, 1);

    const events = store.events({ entity: 'period_close', entityId: '2024-01' });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.action, 'close_period');
    assert.equal(events[0]?.actor, '李四');
    assert.deepEqual(listLockedPeriods(store), ['2024-01']);
  });

  it('重复结账报 already_closed', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    store.closePeriod('2024-01', '李四');
    assert.throws(
      () => store.closePeriod('2024-01', '李四'),
      (error: unknown) => {
        assert.ok(error instanceof PeriodCloseError);
        assert.equal(error.code, 'already_closed');
        return true;
      },
    );
  });

  it('结账校验不通过时抛出阻断项（借贷不平 / 兜底科目 / 注入校验）', () => {
    const { store } = createStore();
    store.save(
      'voucher',
      'bad',
      makeVoucher('bad', '2024-01', {
        balanced: false,
        totalCredit: 9000,
        lines: [
          { accountCode: '6602.01', accountName: '管理费用', debit: 10000, credit: 0, summary: 'x', source: { file: 't' } },
          { accountCode: '1002.01', accountName: '银行存款', debit: 0, credit: 9000, summary: 'x', source: { file: 't' } },
        ],
      }),
    );
    assert.throws(
      () => store.closePeriod('2024-01', '李四'),
      (error: unknown) => {
        assert.ok(error instanceof PeriodCloseBlockedError);
        assert.equal(error.blockers.length >= 1, true);
        assert.match(error.message, /借贷不平/);
        return true;
      },
    );
    assert.equal(store.isPeriodLocked('2024-01'), false);

    const { store: store2 } = createStore();
    store2.save(
      'voucher',
      'suspense',
      makeVoucher('suspense', '2024-01', {
        lines: [
          { accountCode: '1901', accountName: '待处理财产损溢', debit: 10000, credit: 0, summary: 'x', source: { file: 't' } },
          { accountCode: '1002.01', accountName: '银行存款', debit: 0, credit: 10000, summary: 'x', source: { file: 't' } },
        ],
      }),
    );
    assert.throws(
      () => store2.closePeriod('2024-01', '李四'),
      (error: unknown) => {
        assert.ok(error instanceof PeriodCloseBlockedError);
        assert.match(error.message, /兜底科目/);
        return true;
      },
    );

    const { store: store3 } = createStore();
    store3.save('voucher', 'ok', makeVoucher('ok', '2024-01'));
    store3.setCloseValidator(
      externalValidator('审核无 error 级阻断', () => ['VOUCHER-BALANCE-001 摘要缺失']),
    );
    assert.throws(
      () => store3.closePeriod('2024-01', '李四'),
      (error: unknown) => {
        assert.ok(error instanceof PeriodCloseBlockedError);
        assert.match(error.message, /VOUCHER-BALANCE-001/);
        return true;
      },
    );
  });

  it('结账结果记录实际执行的检查项', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    const outcome = store.closePeriodDetailed('2024-01', '李四', '月结');
    assert.equal(outcome.voucherCount, 1);
    assert.equal(outcome.checks.includes('凭证借贷平衡'), true);
    assert.equal(outcome.checks.some((item) => item.includes('兜底科目')), true);
    assert.equal(outcome.event.action, 'close_period');
    assert.equal(outcome.version.version, 1);
    assert.equal(outcome.record.checks.length, outcome.checks.length);
  });

  it('反结账必须填写理由，并返回被解锁的凭证', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    store.save('voucher', 'v2', makeVoucher('v2', '2024-01'));
    store.closePeriod('2024-01', '李四', '月结');

    assert.throws(
      () => store.reopenPeriod('2024-01', '王五', '   '),
      (error: unknown) => {
        assert.ok(error instanceof PeriodCloseError);
        assert.equal(error.code, 'reason_required');
        assert.match(error.message, /必须填写理由/);
        return true;
      },
    );

    const report = store.reopenPeriodDetailed('2024-01', '王五', '客户补开了一张发票，需要补记');
    assert.equal(report.unlockedVouchers, 2);
    assert.deepEqual(report.unlockedVoucherIds, ['v1', 'v2']);
    assert.equal(report.reason, '客户补开了一张发票，需要补记');
    assert.equal(report.record.locked, false);
    assert.equal(report.event.action, 'reopen_period');
    assert.equal(store.isPeriodLocked('2024-01'), false);

    const saved = store.save('voucher', 'v1', makeVoucher('v1', '2024-01', { attachments: 2 }));
    assert.equal(saved.version, 2);

    const history = store.history('period_close', '2024-01');
    assert.equal(history.length, 2);
    assert.equal(history[1]?.version, 2);
    const events = store.events({ entity: 'period_close', entityId: '2024-01' });
    assert.deepEqual(
      events.map((item) => item.action),
      ['close_period', 'reopen_period'],
    );
  });

  it('未结账期间反结账报 not_closed；非法期间报 invalid_period', () => {
    const { store } = createStore();
    assert.throws(
      () => store.reopenPeriod('2024-01', '王五', '理由'),
      (error: unknown) => {
        assert.ok(error instanceof PeriodCloseError);
        assert.equal(error.code, 'not_closed');
        return true;
      },
    );
    assert.throws(
      () => store.closePeriod('2024-13', '王五'),
      (error: unknown) => {
        assert.ok(error instanceof PeriodCloseError);
        assert.equal(error.code, 'invalid_period');
        return true;
      },
    );
    assert.throws(
      () => store.closePeriod('2024-01', '   '),
      (error: unknown) => {
        assert.ok(error instanceof PeriodCloseError);
        assert.equal(error.code, 'invalid_actor');
        return true;
      },
    );
  });

  it('已结账期间的凭证不能软删除', () => {
    const { store } = createStore();
    store.save('voucher', 'v1', makeVoucher('v1', '2024-01'));
    store.closePeriod('2024-01', '李四');
    assert.throws(
      () => store.softDelete({ entity: 'voucher', entityId: 'v1', actor: '王五', reason: '重复', version: 1 }),
      PeriodLockedError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 仓储层                                                              */
/* ------------------------------------------------------------------ */

describe('面向实体的仓储', () => {
  it('仓储读写与统计', () => {
    const { store } = createStore();
    const { repositories } = createAuditRepositories({ dataDir: store.dataDir, actor: '张三' });

    repositories.vouchers.save('v1', makeVoucher('v1', '2024-01'));
    assert.equal(repositories.vouchers.get('v1')?.id, 'v1');
    assert.equal(repositories.vouchers.exists('v1'), true);
    assert.deepEqual(repositories.vouchers.list(), ['v1']);
    assert.equal(repositories.vouchers.count(), 1);
    assert.equal(repositories.vouchers.history('v1').length, 1);
  });

  it('update 基于版本号做乐观并发', () => {
    const { store } = createStore();
    const { repositories } = createAuditRepositories({ dataDir: store.dataDir, actor: '张三' });
    repositories.vouchers.save('v1', makeVoucher('v1', '2024-01'));

    const record = repositories.vouchers.update(
      'v1',
      (current) => ({ ...current, attachments: 4 }),
      { summary: '补附件' },
    );
    assert.equal(record.version, 2);
    assert.equal(repositories.vouchers.get('v1')?.attachments, 4);

    assert.throws(
      () => store.saveVersioned('voucher', 'v1', makeVoucher('v1', '2024-01'), 1),
      VersionConflictError,
    );
  });

  it('remove / restore / diff / events', () => {
    const { store } = createStore();
    const { repositories } = createAuditRepositories({ dataDir: store.dataDir, actor: '张三' });
    repositories.vouchers.save('v1', makeVoucher('v1', '2024-01'));
    repositories.vouchers.update('v1', (current) => ({ ...current, attachments: 2 }), { summary: '改' });

    const diffs = repositories.vouchers.diff('v1', 1, 2);
    assert.equal(diffs.some((item) => item.field === 'attachments'), true);

    repositories.vouchers.remove('v1', '李四', '重复');
    assert.equal(repositories.vouchers.get('v1'), null);
    assert.equal(repositories.vouchers.exists('v1'), false);
    assert.equal(repositories.vouchers.history('v1').length, 3);
    repositories.vouchers.restore('v1', '王五', '复核后恢复');
    assert.notEqual(repositories.vouchers.get('v1'), null);
    assert.equal(repositories.vouchers.events().length, 4);
  });

  it('VoucherRepository.listByPeriod 按期间取数', () => {
    const { store } = createStore();
    const { repositories } = createAuditRepositories({ dataDir: store.dataDir, actor: '张三' });
    repositories.vouchers.save('v1', makeVoucher('v1', '2024-01'));
    repositories.vouchers.save('v2', makeVoucher('v2', '2024-02'));
    repositories.vouchers.save('v3', makeVoucher('v3', '2024-01'));

    assert.deepEqual(
      repositories.vouchers.listByPeriod('2024-01').map((item) => item.id),
      ['v1', 'v3'],
    );
    assert.equal(repositories.vouchers.listByPeriod('2024-03').length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

describe('审计配置', () => {
  it('能读取 config/audit.yaml 并带出法规依据', () => {
    const config = loadAuditConfig(join(PROJECT_ROOT, 'config'));
    assert.equal(config.storage.hashAlgorithm, 'sha256');
    assert.equal(config.storage.fsync, true);
    assert.equal(config.retention.years, 30);
    assert.equal(config.retention.basis.length >= 2, true);
    assert.equal(config.retention.basis[0]?.article, '第十四条');
    assert.equal(config.lock.enabled, true);
    assert.deepEqual(config.lock.suspenseAccounts, ['1901']);
    assert.equal(config.entities.requireSummary.includes('tax_return'), true);
  });

  it('配置文件缺失时退回缺省值', () => {
    const empty = mkdtempSync(join(PROJECT_ROOT, '.test-tmp-audit-'));
    tempDirs.push(empty);
    const config = loadAuditConfig(empty);
    assert.equal(config.retention.years, 30);
    assert.equal(config.entities.tracked.length, 10);
  });
});

/* ------------------------------------------------------------------ */
/* 源码级约束：禁止物理删除                                            */
/* ------------------------------------------------------------------ */

describe('源码级约束：不存在物理删除路径', () => {
  const auditDir = join(PROJECT_ROOT, 'src', 'audit');
  const files = readdirSync(auditDir)
    .filter((file) => file.endsWith('.ts'))
    .sort();

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  it('src/audit 下的源码不含 unlink / rm / truncate / 覆盖写调用', () => {
    assert.equal(files.length >= 5, true);
    const forbidden = [
      'unlink',
      'unlinkSync',
      'rmSync',
      'rmdirSync',
      'truncate',
      'truncateSync',
      'writeFileSync',
      'renameSync',
      'copyFileSync',
      'createWriteStream',
      'openSync(path, \'w\')',
    ];
    for (const file of files) {
      const code = stripComments(readFileSync(join(auditDir, file), 'utf8'));
      for (const token of forbidden) {
        assert.equal(code.includes(token), false, `${file} 出现了物理删除/覆盖写调用：${token}`);
      }
    }
  });

  it('所有 openSync 只用追加（a）或只读（r）模式', () => {
    const modes: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(join(auditDir, file), 'utf8'));
      for (const match of code.matchAll(/openSync\(\s*[^,]+,\s*'([^']+)'/g)) {
        modes.push(match[1] ?? '');
      }
    }
    assert.equal(modes.length >= 2, true);
    for (const mode of modes) {
      assert.equal(mode === 'a' || mode === 'r', true, `出现了非追加式打开模式：${mode}`);
    }
  });

  it('审计库确实以追加模式写盘并 fsync', () => {
    const code = stripComments(readFileSync(join(auditDir, 'store.ts'), 'utf8'));
    assert.equal(code.includes("openSync(path, 'a')"), true);
    assert.equal(code.includes('fsyncSync'), true);
    assert.equal(code.includes("openSync(path, 'r')"), true);
  });
});
