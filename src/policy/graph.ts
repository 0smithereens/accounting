/**
 * 政策关系图谱：变化轨迹 · 关联图谱。
 *
 * 为什么这样设计：
 *  1. 图的方向语义固定为「from 作用于 to」（修改/替代/废止/依据/贯彻），
 *     这样「追溯一个政策是怎么演变来的」只需沿反向走，
 *     「评估一个政策变化会波及谁」只需沿正向走，不需要为每种关系写一套遍历。
 *  2. 悬空端点（引用了不存在的政策 id）一律抛错而不是静默跳过：
 *     图谱丢一条边，界面上看不出来，但「影响面」会算错，
 *     这种错误只能在加载期暴露才有人会去修。
 *  3. 遍历一律带 visited 集合：政策关系天然存在环
 *     （A 修改 B、B 依据 C、C 又被 A 替代），没有访问标记会无限循环。
 *  4. 所有输出都按「深度升序 + id 升序」排序，保证同样的输入永远得到同样的输出，
 *     否则快照测试与人工核对都无从谈起。
 */

import type { PolicyNode, PolicyRelation, PolicyRelationType } from '../core/contracts.ts';
import { POLICY_RELATION_LABEL } from '../core/contracts.ts';
import type { PolicyLibrary } from './library.ts';

/** 关系类型的固定展示顺序，用于统计与排序。 */
export const POLICY_RELATION_TYPES: readonly PolicyRelationType[] = [
  'amends',
  'supersedes',
  'repeals',
  'based_on',
  'implements',
  'parallel',
];

/** 图谱构建失败（悬空端点、自环、重复 id 等）。 */
export class PolicyGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyGraphError';
  }
}

/** 追溯结果的一项。 */
export interface PolicyTraceStep {
  id: string;
  depth: number;
  /** 发现该节点时走过的关系类型 */
  via: PolicyRelationType;
}

/** 图谱统计。 */
export interface PolicyGraphStats {
  total: number;
  byType: Record<PolicyRelationType, number>;
  keyHubs: Array<{ id: string; title: string; degree: number }>;
}

/** 政策图谱门面。 */
export interface PolicyGraph {
  outEdges(id: string, type?: PolicyRelationType): PolicyRelation[];
  inEdges(id: string, type?: PolicyRelationType): PolicyRelation[];
  /** 沿 out（forward）或 in（backward）方向做广度优先追溯，不含起点自身。 */
  trace(
    id: string,
    direction: 'forward' | 'backward',
    maxDepth?: number,
  ): PolicyTraceStep[];
  /** 同一版本族的成员（按生效日期升序）；不在任何族里时返回该政策自身。 */
  family(id: string): PolicyNode[];
  /** 该政策变化后可能波及的下游文件。 */
  impact(id: string): { affected: string[]; depth: number };
  stats(): PolicyGraphStats;
  /** 全部关系边（只读副本），供界面一次性渲染。 */
  edges(): PolicyRelation[];
  /** 单个政策的度数（入边 + 出边）。 */
  degree(id: string): number;
}

const TYPE_ORDER = new Map<PolicyRelationType, number>(
  POLICY_RELATION_TYPES.map((type, index) => [type, index]),
);

function compareEdge(a: PolicyRelation, b: PolicyRelation): number {
  const left = TYPE_ORDER.get(a.type) ?? 99;
  const right = TYPE_ORDER.get(b.type) ?? 99;
  if (left !== right) return left - right;
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareNodeByEffective(a: PolicyNode, b: PolicyNode): number {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? -1 : 1;
  if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function pushEdge(map: Map<string, PolicyRelation[]>, key: string, edge: PolicyRelation): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [edge]);
  else bucket.push(edge);
}

/**
 * 校验并构建图谱。
 *
 * 校验项：端点必须存在、不允许自环、关系 id 唯一。
 * 一次性把所有问题收集起来抛一个错误，避免「修一个报一个」。
 */
export function buildGraph(lib: PolicyLibrary, rels: PolicyRelation[]): PolicyGraph {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const outMap = new Map<string, PolicyRelation[]>();
  const inMap = new Map<string, PolicyRelation[]>();

  for (const edge of rels) {
    if (seenIds.has(edge.id)) {
      problems.push(`关系 id 重复: ${edge.id}`);
    }
    seenIds.add(edge.id);

    if (!(POLICY_RELATION_TYPES as readonly string[]).includes(edge.type)) {
      problems.push(`关系 ${edge.id} 的类型非法: ${edge.type}`);
      continue;
    }
    if (edge.from === edge.to) {
      problems.push(`关系 ${edge.id} 的起点与终点相同（自环）: ${edge.from}`);
      continue;
    }
    if (lib.get(edge.from) === undefined) {
      problems.push(`关系 ${edge.id} 的起点不存在: ${edge.from}`);
      continue;
    }
    if (lib.get(edge.to) === undefined) {
      problems.push(`关系 ${edge.id} 的终点不存在: ${edge.to}`);
      continue;
    }
    pushEdge(outMap, edge.from, edge);
    pushEdge(inMap, edge.to, edge);
  }

  if (problems.length > 0) {
    const head = problems.slice(0, 5).join('；');
    const tail = problems.length > 5 ? `；另有 ${problems.length - 5} 处问题` : '';
    throw new PolicyGraphError(`政策关系数据校验失败：${head}${tail}`);
  }

  const edges = [...rels].sort(compareEdge);

  const walk = (
    startId: string,
    direction: 'forward' | 'backward',
    maxDepth: number,
  ): PolicyTraceStep[] => {
    const visited = new Map<string, PolicyTraceStep>();
    const seen = new Set<string>([startId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (current.depth >= maxDepth) continue;
      const bucket = (direction === 'forward' ? outMap : inMap).get(current.id) ?? [];
      for (const edge of bucket) {
        const nextId = direction === 'forward' ? edge.to : edge.from;
        if (seen.has(nextId)) continue;
        seen.add(nextId);
        visited.set(nextId, { id: nextId, depth: current.depth + 1, via: edge.type });
        queue.push({ id: nextId, depth: current.depth + 1 });
      }
    }

    return [...visited.values()].sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  };

  return {
    edges: () => edges.slice(),
    degree: (id) => (outMap.get(id)?.length ?? 0) + (inMap.get(id)?.length ?? 0),
    outEdges: (id, type) => {
      const bucket = outMap.get(id) ?? [];
      const filtered = type === undefined ? bucket : bucket.filter((edge) => edge.type === type);
      return filtered.slice().sort(compareEdge);
    },
    inEdges: (id, type) => {
      const bucket = inMap.get(id) ?? [];
      const filtered = type === undefined ? bucket : bucket.filter((edge) => edge.type === type);
      return filtered.slice().sort(compareEdge);
    },
    trace: (id, direction, maxDepth = 3) => {
      if (direction !== 'forward' && direction !== 'backward') {
        throw new PolicyGraphError(`追溯方向必须是 forward 或 backward，实际为 ${String(direction)}`);
      }
      const depth = Math.max(1, Math.min(10, Math.trunc(maxDepth)));
      return walk(id, direction, depth);
    },
    family: (id) => {
      const family = lib.familyOf(id);
      if (family === undefined) {
        const node = lib.get(id);
        return node === undefined ? [] : [node];
      }
      const nodes: PolicyNode[] = [];
      for (const memberId of family.members) {
        const node = lib.get(memberId);
        if (node !== undefined) nodes.push(node);
      }
      return nodes.sort(compareNodeByEffective);
    },
    impact: (id) => {
      // 影响面沿正向（该政策作用于谁）计算；深度上限是防御性的，visited 已能防环
      const steps = walk(id, 'forward', 10);
      const depth = steps.reduce((max, step) => Math.max(max, step.depth), 0);
      return {
        affected: steps
          .filter((step) => step.id !== id)
          .sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.id < b.id ? -1 : 1))
          .map((step) => step.id),
        depth,
      };
    },
    stats: () => {
      const byType = {
        amends: 0,
        supersedes: 0,
        repeals: 0,
        based_on: 0,
        implements: 0,
        parallel: 0,
      } satisfies Record<PolicyRelationType, number>;
      for (const edge of edges) {
        byType[edge.type] += 1;
      }

      const degreeMap = new Map<string, number>();
      for (const edge of edges) {
        degreeMap.set(edge.from, (degreeMap.get(edge.from) ?? 0) + 1);
        degreeMap.set(edge.to, (degreeMap.get(edge.to) ?? 0) + 1);
      }
      const keyHubs = [...degreeMap.entries()]
        .map(([id, degree]) => ({ id, title: lib.get(id)?.title ?? id, degree }))
        .sort((a, b) => (b.degree !== a.degree ? b.degree - a.degree : a.id < b.id ? -1 : 1))
        .slice(0, 10);

      return { total: edges.length, byType, keyHubs };
    },
  };
}

/** 关系类型的中文名，界面直接使用。 */
export function relationLabel(type: PolicyRelationType): string {
  return POLICY_RELATION_LABEL[type];
}
