/**
 * 关系图谱测试：变化轨迹 · 关联图谱。
 *
 * 图谱的价值全在「方向」和「深度」上：
 *   方向错 → 追溯变成追踪；
 *   深度错 → 影响面算少一层，用户看到的就是错的结论。
 * 所以这里对 trace / impact / family 逐层断言，而不是只断言「有返回」。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PolicyRelation } from '../src/core/contracts.ts';
import {
  POLICY_RELATION_TYPES,
  PolicyGraphError,
  buildGraph,
  loadPolicyLibrary,
  relationLabel,
} from '../src/policy/index.ts';

const lib = loadPolicyLibrary();
const relations = lib.relations();
const graph = buildGraph(lib, relations);

describe('图谱构建与统计', () => {
  it('全部关系边入图，没有静默丢弃', () => {
    assert.equal(graph.edges().length, relations.length);
    assert.ok(relations.length >= 60);
    assert.equal(graph.stats().total, relations.length);
  });

  it('按类型统计之和等于总边数，六种类型都初始化', () => {
    const stats = graph.stats();
    assert.deepEqual(Object.keys(stats.byType).sort(), [...POLICY_RELATION_TYPES].sort());
    const sum = Object.values(stats.byType).reduce((total, count) => total + count, 0);
    assert.equal(sum, stats.total);
    assert.equal(stats.byType.repeals, 2);
    assert.ok(stats.byType.based_on >= 20);
  });

  it('keyHubs 按度数降序，首位的度数与企业所得税法的入边数一致', () => {
    const hubs = graph.stats().keyHubs;
    assert.ok(hubs.length > 0 && hubs.length <= 10);
    for (let i = 1; i < hubs.length; i += 1) {
      assert.ok((hubs[i - 1]?.degree ?? 0) >= (hubs[i]?.degree ?? 0), '关键节点未按度数降序');
    }
    assert.equal(hubs[0]?.id, 'cit-law');
    assert.equal(hubs[0]?.degree, graph.degree('cit-law'));
    assert.ok((hubs[0]?.title ?? '').includes('企业所得税法'));
  });

  it('空关系集可以正常构建', () => {
    const empty = buildGraph(lib, []);
    assert.equal(empty.stats().total, 0);
    assert.deepEqual(empty.stats().keyHubs, []);
    assert.deepEqual(empty.trace('cit-law', 'forward'), []);
  });
});

describe('出入边查询', () => {
  it('outEdges 能按类型过滤', () => {
    const supersedes = graph.outEdges('ann-2023-7', 'supersedes');
    assert.equal(supersedes.length, 2);
    assert.ok(supersedes.every((edge) => edge.type === 'supersedes'));
    assert.ok(graph.outEdges('ann-2023-7').length > supersedes.length);
    assert.equal(graph.outEdges('no-such-policy').length, 0);
  });

  it('inEdges 能找到「谁废止了暂行条例」', () => {
    const incoming = graph.inEdges('vat-interim-regulation');
    const repealer = incoming.find((edge) => edge.type === 'repeals');
    assert.equal(repealer?.from, 'vat-law-2024');
    assert.ok(incoming.some((edge) => edge.from === 'ann-2019-39'));
  });
});

describe('追溯（trace）', () => {
  it('正向追溯能达到 2 层，并记录经过的关系类型', () => {
    const steps = graph.trace('e-invoice-2024', 'forward', 2);
    const byDepth = new Map(steps.map((step) => [step.id, step]));
    assert.equal(byDepth.get('invoice-measures')?.depth, 1);
    assert.equal(byDepth.get('invoice-measures-2010')?.depth, 2);
    assert.equal(byDepth.get('invoice-measures-2010')?.via, 'supersedes');
    assert.equal(byDepth.get('tax-collection-law')?.depth, 2);
  });

  it('反向追溯能达到 2 层（政策是怎么演变来的）', () => {
    const steps = graph.trace('vat-interim-regulation', 'backward', 2);
    assert.ok(steps.some((step) => step.depth === 1));
    assert.ok(steps.some((step) => step.depth === 2));
    const maxDepth = steps.reduce((max, step) => Math.max(max, step.depth), 0);
    assert.equal(maxDepth, 2);
  });

  it('追溯结果不含起点自身、不重复、按深度升序', () => {
    const steps = graph.trace('vat-interim-regulation', 'backward', 3);
    assert.ok(steps.every((step) => step.id !== 'vat-interim-regulation'));
    assert.equal(new Set(steps.map((step) => step.id)).size, steps.length);
    for (let i = 1; i < steps.length; i += 1) {
      assert.ok((steps[i - 1]?.depth ?? 0) <= (steps[i]?.depth ?? 0), '追溯结果未按深度排序');
    }
  });

  it('maxDepth 生效：1 层时不含 2 层节点', () => {
    const steps = graph.trace('e-invoice-2024', 'forward', 1);
    assert.ok(steps.every((step) => step.depth === 1));
    assert.ok(!steps.some((step) => step.id === 'invoice-measures-2010'));
  });

  it('maxDepth 小于 1 时按 1 处理，避免零深度空转', () => {
    const steps = graph.trace('e-invoice-2024', 'forward', 0);
    assert.ok(steps.length > 0);
    assert.ok(steps.every((step) => step.depth === 1));
  });

  it('非法方向抛 PolicyGraphError', () => {
    assert.throws(
      () => graph.trace('cit-law', 'sideways' as 'forward'),
      (error: unknown) => error instanceof PolicyGraphError,
    );
  });
});

describe('版本族与影响面', () => {
  it('family 按施行日期升序返回', () => {
    const family = graph.family('vat-law-2024');
    assert.deepEqual(
      family.map((policy) => policy.id),
      ['vat-interim-regulation', 'caishui-2016-36', 'vat-law-2024'],
    );
    for (let i = 1; i < family.length; i += 1) {
      assert.ok(
        (family[i - 1]?.effectiveFrom ?? '') <= (family[i]?.effectiveFrom ?? ''),
        '版本族未按施行日期排序',
      );
    }
  });

  it('不在任何版本族里时返回政策自身', () => {
    const family = graph.family('cit-law');
    assert.deepEqual(family.map((policy) => policy.id), ['cit-law']);
    assert.deepEqual(graph.family('no-such-policy'), []);
  });

  it('impact 沿正向计算影响面并给出最大深度', () => {
    const result = graph.impact('e-invoice-2024');
    assert.deepEqual(result.affected, ['invoice-measures', 'invoice-measures-2010', 'tax-collection-law']);
    assert.equal(result.depth, 2);
    assert.ok(!result.affected.includes('e-invoice-2024'));
  });

  it('impact 对未知政策返回空结果', () => {
    assert.deepEqual(graph.impact('no-such-policy'), { affected: [], depth: 0 });
  });
});

describe('图谱校验', () => {
  const base: PolicyRelation = { id: 'rel-test', from: 'cit-law', to: 'vat-law-2024', type: 'parallel' };

  it('悬空端点直接抛错，不静默丢边', () => {
    assert.throws(
      () => buildGraph(lib, [{ ...base, id: 'rel-bad-from', from: 'no-such-policy' }]),
      (error: unknown) =>
        error instanceof PolicyGraphError && /起点不存在/.test((error as Error).message),
    );
    assert.throws(
      () => buildGraph(lib, [{ ...base, id: 'rel-bad-to', to: 'no-such-policy' }]),
      (error: unknown) =>
        error instanceof PolicyGraphError && /终点不存在/.test((error as Error).message),
    );
  });

  it('自环抛错', () => {
    assert.throws(
      () => buildGraph(lib, [{ ...base, id: 'rel-loop', from: 'cit-law', to: 'cit-law' }]),
      (error: unknown) =>
        error instanceof PolicyGraphError && /自环/.test((error as Error).message),
    );
  });

  it('关系 id 重复抛错', () => {
    assert.throws(
      () => buildGraph(lib, [base, { ...base, to: 'stamp-law' }]),
      (error: unknown) =>
        error instanceof PolicyGraphError && /重复/.test((error as Error).message),
    );
  });

  it('关系类型中文名可读', () => {
    assert.equal(relationLabel('amends'), '修改');
    assert.equal(relationLabel('repeals'), '废止');
    assert.equal(relationLabel('based_on'), '制定依据');
  });
});
