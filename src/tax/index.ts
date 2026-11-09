/**
 * 税务计算引擎门面。
 *
 * 对外只暴露这一个入口，内部模块可以自由重构。调用方通常只需要：
 *
 *   import { computeTaxes } from './tax/index.ts';
 *   const result = computeTaxes({ period, standard, taxpayer, ledger, vouchers });
 *   // result.returns  → 各税种申报表草稿（状态恒为 calculated）
 *   // result.risks    → 风险提示
 *   // result.benefits → 优惠匹配
 *   // result.notes    → 每一步的算式与假设
 *
 * 监管红线（本引擎全链路遵守）：
 *  1. 绝不自动向税务机关提交申报。本引擎只产出草稿，filed 状态只能由人工
 *     在电子税务局完成申报后回填事实。
 *  2. AI 生成的税务计算必须 Human-in-the-loop：草稿 → 复核 → 审批，每一环都要人签署。
 *  3. 禁止物理删除：申报表重算只递增 version，历史版本保留。
 *  4. 所有合规结论都带法规依据（法条名称 + 条款号）。
 */

/* ------------------------------ 基础口径 ------------------------------ */
export * from './rates.ts';

/* ------------------------------ 各税种 ------------------------------ */
export * from './vat.ts';
export * from './surcharge.ts';
export * from './cit.ts';
export * from './iit.ts';
export * from './stamp.ts';

/* --------------------------- 优惠与风险 --------------------------- */
export * from './benefits.ts';
export * from './risk.ts';

/* --------------------------- 导航与编排 --------------------------- */
export * from './navigation.ts';
export * from './compute.ts';
