/**
 * 申报工作流门面（Facade）。
 *
 * 对外只暴露这一个入口文件，目的是让「导入路径」稳定：
 * 上层（CLI / Web / pipeline）不需要知道状态机、闸门、导出的文件划分，
 * 只要 `import { FilingWorkflow } from './filing/index.ts'` 即可。
 *
 * 监管红线（本模块的存在理由，重复三遍也不为过）：
 *   1. 系统不向税务机关提交任何数据，submitToTaxBureau() 恒抛异常；
 *   2. 申报表只有「已审批」才能导出底稿，导出物是给人照抄的 Excel，不是报文；
 *   3. filed 只能由 reportManualFiling() 依据人工申报回执写入。
 */

/* 状态机 */
export {
  TRANSITIONS,
  canTransition,
  assertCanTransition,
  applyTransition,
  assertFiledRequiresRecord,
  hashFilingPayload,
  canonicalJson,
  bumpVersion,
  appendSignature,
  latestSignature,
  nowIso,
  IllegalTransitionError,
} from './state-machine.ts';
export type { TransitionContext } from './state-machine.ts';

/* 闸门与配置 */
export {
  assertNoAutoSubmission,
  submitToTaxBureau,
  assertExportable,
  assertLinesConsistent,
  assertReturnIntegrity,
  assertReviewPassed,
  assertReviewerEligible,
  assertFourEyes,
  assertSignaturesComplete,
  assertSignaturesFresh,
  assertManualFilingRecord,
  assertFilingReadyForManualSubmission,
  isPayableLine,
  selectFinalPayableLines,
  loadFilingConfig,
  defaultFilingConfig,
  recordFilingGuardAudit,
  getFilingGuardAuditTrail,
  normalizeActor,
  normalizeReason,
  FILING_DECLARATION,
  FILING_CONFIG_FILE,
  SIGN_ROLE_LABEL,
  AutoSubmissionForbidden,
  ExportNotAllowedError,
  StaleSignatureError,
  FilingGuardError,
  SelfReviewForbidden,
  FourEyesViolation,
  MissingSignatureError,
} from './guard.ts';
export type {
  FilingConfig,
  FilingRoleConfig,
  FilingMaterialConfig,
  FilingGuards,
  FilingGuardAuditEntry,
  FilingGuardAuditAction,
} from './guard.ts';

/* 工作流 */
export { FilingWorkflow, FilingWorkflowError } from './workflow.ts';
export type { FilingWorkflowOptions, FilingPendingAction } from './workflow.ts';

/* 导出 */
export { exportFilingPackage } from './export.ts';
