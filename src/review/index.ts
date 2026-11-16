/**
 * 合规审核引擎门面（Facade）。
 *
 * 主智能体与其他模块只应该从这里 import，不要直接引用 review/checks/* 内部文件：
 *  - 内部文件是「检查项实现」，会随法规与业务调整而增删；
 *  - 门面是稳定 API，签名与 core/contracts.ts 的共享契约对齐；
 *  - 未来把审核拆成独立服务时，只需替换门面的实现，调用方不动。
 *
 * 典型用法：
 *   const report = runReview(input, { configDir: CONFIG_DIR });
 *   if (!report.summary.passed) console.log(renderReviewText(report));
 *   assertReviewPassed(report); // 阻断时抛 ReviewBlockedError（带完整报告）
 */

export {
  runReview,
  loadReviewConfig,
  listChecks,
  assertReviewPassed,
  nowIsoDateTime,
  REVIEW_RULE_IDS,
  ReviewBlockedError,
  ReviewConfigError,
  ReviewInputError,
  ReviewWaiverError,
} from './engine.ts';

export type {
  CheckDefinition,
  ReviewOptions,
  ReviewWaiverInput,
} from './engine.ts';

export { renderReviewMarkdown, renderReviewText } from './report.ts';

export {
  LAW_LIBRARY,
  REVIEW_DISCLAIMER,
  CRIMINAL_DISCLAIMER,
  FALLBACK_BASIS,
  law,
  laws,
} from './legal.ts';

export type { LawKey } from './legal.ts';

export { loadReviewAccounts, loadStandardProfile } from './checks/account.ts';
export { CRIMINAL_THRESHOLDS, measureTaxExposure } from './checks/criminal.ts';
export type { TaxExposure, TaxExposureDetail } from './checks/criminal.ts';
export { findTaxLine, latestTaxReturns } from './checks/tax.ts';
