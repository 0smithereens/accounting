/**
 * 政策库门面（src/policy/index.ts）。
 *
 * 上层（CLI / Web / 审核引擎）只从这里 import，不直接依赖内部文件，
 * 这样内部怎么拆、数据放哪里都可以演进，调用方不受影响。
 *
 * 模块分工：
 *   library.ts    政策节点、税种超集、加载与索引
 *   graph.ts      关系图谱（修改/替代/废止/依据/贯彻/平行、版本族、影响面）
 *   search.ts     加权检索（关键词 + 过滤 + 2-gram 降级）
 *   tax-chain.ts  税会智链（业务事项 → 税种 → 申报表栏次 → 税会差异 → 政策）
 *   navigation.ts 税种导航（申报表、申报周期、中央/地方政策数量）
 */

import type { PolicyNode, PolicyRelation } from '../core/contracts.ts';
import type { BusinessEvent } from './tax-chain.ts';
import type { PolicyGraph } from './graph.ts';
import type { PolicyLibrary, PolicyFamilyRecord } from './library.ts';
import type { PolicyTaxCode } from './library.ts';
import type { TaxTypeNavigation } from './navigation.ts';

import {
  POLICY_DATA_DIR,
  POLICY_TAX_CODE_LABEL,
  getDefaultPolicyLibrary,
  loadPolicyLibrary,
} from './library.ts';
import { buildGraph } from './graph.ts';
import { buildNavigation } from './navigation.ts';
import { loadBusinessEvents } from './tax-chain.ts';

/* ------------------------------------------------------------------ */
/* 一、类型与函数直接透出                                              */
/* ------------------------------------------------------------------ */

export {
  POLICY_COMPLIANCE_NOTICE,
  POLICY_DATA_DIR,
  POLICY_TAX_CODES,
  POLICY_TAX_CODE_LABEL,
  PolicyDataError,
  canonicalDocumentNo,
  citationOf,
  createPolicyLibrary,
  getDefaultPolicyLibrary,
  isPolicyTaxCode,
  loadFamilies,
  loadPolicies,
  loadPolicyLibrary,
  loadRelations,
  resetDefaultPolicyLibrary,
  toTaxTypes,
} from './library.ts';
export type {
  PolicyFamilyRecord,
  PolicyLibrary,
  PolicyRecord,
  PolicyTaxCode,
} from './library.ts';

export { POLICY_RELATION_TYPES, PolicyGraphError, buildGraph, relationLabel } from './graph.ts';
export type { PolicyGraph, PolicyGraphStats, PolicyTraceStep } from './graph.ts';

export { SEARCH_FIELD_WEIGHTS, searchPolicies, tokenizeQuery } from './search.ts';
export type { SearchHit, SearchQuery } from './search.ts';

export {
  BUSINESS_EVENT_GROUPS,
  BusinessEventError,
  allTaxDifferences,
  chainForEvent,
  chainForPolicy,
  explainTaxDifference,
  groupBusinessEvents,
  loadBusinessEvents,
  locateByReturnLine,
  normalizeLineCode,
  validateEventPolicyRefs,
} from './tax-chain.ts';
export type {
  BusinessEvent,
  BusinessEventGroup,
  EventChain,
  ReturnLineRef,
  TaxDifference,
} from './tax-chain.ts';

export { buildNavigation, contractTaxNavigations } from './navigation.ts';
export type { TaxTypeNavigation } from './navigation.ts';

/* ------------------------------------------------------------------ */
/* 二、一次加载全部知识资产                                            */
/* ------------------------------------------------------------------ */

/** 政策知识库的完整装配结果。 */
export interface PolicyKnowledgeBase {
  library: PolicyLibrary;
  graph: PolicyGraph;
  events: BusinessEvent[];
  navigation: TaxTypeNavigation[];
  relations: PolicyRelation[];
  families: PolicyFamilyRecord[];
}

/**
 * 加载「政策库 + 图谱 + 业务事项 + 税种导航」。
 *
 * 一次性装配而不是让调用方分别加载，是因为这四者共享同一份数据目录：
 * 分开加载很容易出现「政策库指向 A 目录、图谱指向 B 目录」的错位，
 * 那种错位的表现是图谱边全部悬空，排查成本极高。
 */
export function loadPolicyKnowledgeBase(dataDir: string = POLICY_DATA_DIR): PolicyKnowledgeBase {
  const library = loadPolicyLibrary(dataDir);
  const relations = library.relations();
  const graph = buildGraph(library, relations);
  const events = loadBusinessEvents(dataDir);
  const navigation = buildNavigation(library);
  return {
    library,
    graph,
    events,
    navigation,
    relations,
    families: library.families(),
  };
}

/** 政策详情页所需的全部信息（政策本身 + 出入边 + 版本族 + 相关业务事项）。 */
export interface PolicyDossier {
  policy: PolicyNode;
  /** 该政策作用于谁 */
  outRelations: PolicyRelation[];
  /** 谁作用于该政策（演变来源） */
  inRelations: PolicyRelation[];
  family: PolicyNode[];
  /** 引用该政策的业务事项 */
  events: BusinessEvent[];
}

/**
 * 组装政策详情。
 *
 * 找不到政策时返回 null 而不是抛错：详情页允许参数非法（用户可能从旧链接进入），
 * 上层渲染「未找到该政策」即可。
 */
export function policyDossier(
  kb: PolicyKnowledgeBase,
  policyId: string,
): PolicyDossier | null {
  const policy = kb.library.get(policyId);
  if (policy === undefined) return null;
  const events = kb.events.filter((event) => {
    if (event.policyIds.includes(policyId)) return true;
    return event.differences.some((difference) => difference.policyIds.includes(policyId));
  });
  return {
    policy,
    outRelations: kb.graph.outEdges(policyId),
    inRelations: kb.graph.inEdges(policyId),
    family: kb.graph.family(policyId),
    events,
  };
}

/** 当前默认数据目录下的知识库（进程内缓存政策库，图谱每次重建以保证与政策库一致）。 */
export function defaultKnowledgeBase(): PolicyKnowledgeBase {
  const library = getDefaultPolicyLibrary();
  const relations = library.relations();
  return {
    library,
    graph: buildGraph(library, relations),
    events: loadBusinessEvents(),
    navigation: buildNavigation(library),
    relations,
    families: library.families(),
  };
}

/** 供界面展示的税种中文名（政策库口径，19 个税种）。 */
export function taxCodeLabel(code: PolicyTaxCode): string {
  return POLICY_TAX_CODE_LABEL[code];
}
