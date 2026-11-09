/**
 * 财务报表与财务分析模块门面。
 *
 * 对外只暴露这一层：编排层（src/app/close-run.ts）、CLI、Web 都从
 * '../report/index.ts' 导入，不直接依赖内部文件，便于后续拆分与替换。
 */

/* ---------------------------- 报表生成 ---------------------------- */
export type {
  PeriodSnapshot,
  ReportInput,
  GenerateStatementsResult,
  CashFlowResult,
  StatementSummary,
} from './statements.ts';
export {
  generateStatements,
  deriveCashFlow,
  stripClosingEntries,
  reportingBalances,
  isUnderPrefix,
  statementLineAmount,
  findStatementLine,
  summarizeStatements,
} from './statements.ts';

/* ---------------------------- 财务分析 ---------------------------- */
export type { MetricBag, AnalysisInput } from './analysis.ts';
export {
  generateAnalysis,
  computeMetrics,
  evaluateRatio,
  groupRatios,
  shiftPeriod,
  formatRatioValue,
} from './analysis.ts';

/* ---------------------------- 结论与导出 ---------------------------- */
export type { NarrativeContext } from './narrative.ts';
export { buildNarratives, describeStructure, groupLabel, sortAlerts } from './narrative.ts';
export {
  renderStatementText,
  renderStatementsText,
  renderAnalysisMarkdown,
  exportStatementsExcel,
} from './export.ts';

/* ---------------------------- 配置与取数 DSL ---------------------------- */
export type {
  BalanceIndex,
  BalanceSource,
  CashFlowConfig,
  CashFlowItemDef,
  CheckDef,
  EvaluateOptions,
  EvaluateResult,
  EvaluatedRow,
  MetricDef,
  MetricExpr,
  RatioConfig,
  RatioDef,
  RatingRule,
  RuleSign,
  SkippedRow,
  StatementFormat,
  StatementNoteDef,
  StatementRowDef,
  StatementRule,
  StatementSectionDef,
  StructureDef,
  TrendDef,
} from './mapping.ts';
export {
  createBalanceIndex,
  describeRule,
  evaluateSection,
  loadRatioConfig,
  loadStatementFormat,
  notesToChecks,
  readYamlDocument,
  runChecks,
  sumAccounts,
  clearReportConfigCache,
} from './mapping.ts';
