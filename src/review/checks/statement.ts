/**
 * 报表勾稽检查。
 *
 * 报表之间的勾稽关系是会计恒等式的最后一道防线：
 *  - 资产 = 负债 + 所有者权益（资产负债表内部）
 *  - 现金流量表期末现金 = 资产负债表货币资金（跨表）
 *  - 利润表净利润 = 所有者权益变动表净利润（跨表）
 *  - 本期期初 = 上期期末（跨期）
 *
 * 取数策略：先按标准行次编码（code）找，找不到再按中文标签找。
 * 原因是对外报表格式可能因准则/行业模板不同而调整编码，但中文标签相对稳定；
 * 反过来，如果只按标签匹配，「流动资产合计」也会命中「资产合计」，所以标签匹配用锚定正则。
 *
 * 数据不足时不猜：例如没有上期报表，就不做「期初 = 上期期末」的判断，
 * 因为没有比较基准的结论只能是猜测。报告会在 checksRun 中如实说明检查项已执行。
 */

import type {
  Cents,
  FinancialStatement,
  LawBasis,
  Period,
  ReviewContext,
  ReviewFinding,
  ReviewInput,
  ReviewTarget,
  StatementCheck,
  StatementKind,
  StatementLine,
} from '../../core/contracts.ts';
import { STATEMENT_KIND_LABEL } from '../../core/contracts.ts';
import { formatYuan } from '../../core/money.ts';
import { compactText } from '../../core/text.ts';
import {
  LAW_ACCOUNTING_BASIS_60,
  LAW_ACCOUNTING_LAW_20,
  LAW_ENTERPRISE_SYSTEM_11,
} from '../legal.ts';
import type { CheckDefinition } from '../engine.ts';

/* ================================================================== */
/* 一、规则 id                                                         */
/* ================================================================== */

export const STATEMENT_RULE_IDS = {
  balance: 'STMT-BALANCE-001',
  cash: 'STMT-CASH-001',
  netProfit: 'STMT-NET-001',
  continuity: 'STMT-CONTINUITY-001',
} as const;

/* ================================================================== */
/* 二、工具                                                            */
/* ================================================================== */

function makeFinding(
  ctx: ReviewContext,
  ruleId: string,
  target: ReviewTarget,
  title: string,
  detail: string,
  suggestion: string,
  basis: LawBasis[],
  evidence?: Record<string, unknown>,
): ReviewFinding {
  const finding: ReviewFinding = {
    id: ctx.nextId(),
    ruleId,
    severity: 'error',
    category: 'data_quality',
    title,
    detail,
    suggestion,
    basis,
    target,
    blocking: false,
  };
  if (evidence !== undefined) finding.evidence = evidence;
  return finding;
}

function statementTarget(statement: FinancialStatement): ReviewTarget {
  return {
    kind: 'statement',
    id: statement.id,
    label: `${STATEMENT_KIND_LABEL[statement.kind]} ${statement.period}`,
  };
}

function pickStatement(
  statements: readonly FinancialStatement[] | undefined,
  kind: StatementKind,
  period: Period,
): FinancialStatement | undefined {
  if (statements === undefined) return undefined;
  const list = statements.filter((item) => item.kind === kind);
  return list.find((item) => item.period === period) ?? list[0];
}

function amountBy(
  statement: FinancialStatement,
  predicate: (line: StatementLine) => boolean,
): Cents | undefined {
  const line = statement.lines.find(predicate);
  if (line === undefined) return undefined;
  return line.amount === null ? undefined : line.amount;
}

/* -------------------------- 行次识别 -------------------------- */

const isTotalAssets = (line: StatementLine): boolean =>
  line.code === 'total_assets' || /^资产(总计|合计)$/.test(compactText(line.label));

const isTotalLiabilities = (line: StatementLine): boolean =>
  line.code === 'total_liabilities' || /^负债(总计|合计)$/.test(compactText(line.label));

const isTotalEquity = (line: StatementLine): boolean => {
  if (line.code === 'total_equity') return true;
  const label = compactText(line.label);
  return /所有者权益|股东权益/.test(label) && /(合计|总计)/.test(label) && !/负债/.test(label);
};

const isMonetaryFunds = (line: StatementLine): boolean =>
  line.code === 'monetary_funds' || compactText(line.label) === '货币资金';

const isEndingCash = (line: StatementLine): boolean =>
  line.code === 'ending_cash' || /期末现金及现金等价物余额/.test(compactText(line.label));

const isNetProfit = (line: StatementLine): boolean =>
  line.code === 'net_profit' || /^净利润/.test(compactText(line.label));

/** 报表容差：分位四舍五入造成的 1 分差异不视为勾稽失败。 */
const TOLERANCE: Cents = 1;

function findFailedCheck(
  statement: FinancialStatement,
  pattern: RegExp,
): StatementCheck | undefined {
  return statement.checks.find(
    (check) => !check.passed && pattern.test(`${check.id} ${check.label}`),
  );
}

/* ================================================================== */
/* 三、检查项                                                          */
/* ================================================================== */

/** STMT-BALANCE-001：资产 ≠ 负债 + 所有者权益。 */
function checkBalanceSheet(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const statement = pickStatement(input.statements, 'balance_sheet', ctx.period);
  if (statement === undefined) return [];

  const assets = amountBy(statement, isTotalAssets);
  const liabilities = amountBy(statement, isTotalLiabilities);
  const equity = amountBy(statement, isTotalEquity);

  if (assets === undefined || liabilities === undefined || equity === undefined) {
    // 行次不完整时，退回使用报表引擎自带的勾稽结果，避免「找不到行就当作通过」。
    const failed = findFailedCheck(statement, /balance|资产.*负债|会计恒等式/i);
    if (failed === undefined) return [];
    return [
      makeFinding(
        ctx,
        STATEMENT_RULE_IDS.balance,
        statementTarget(statement),
        '资产负债表不平衡',
        `${STATEMENT_KIND_LABEL[statement.kind]}（${statement.period}）的勾稽检查「${failed.label}」未通过：` +
          `${failed.detail}（期望值与实际值相差 ${formatYuan(failed.diff)} 元）。` +
          '资产与负债+所有者权益不相等，说明报表取数或结转存在错误，整张报表不可用。',
        '逐项核对总账科目余额与报表取数公式，检查是否漏结损益、重复结转、或直接修改了报表单元格；' +
          '修正后重新生成报表并复核。',
        [LAW_ACCOUNTING_LAW_20, LAW_ENTERPRISE_SYSTEM_11],
        { statementId: statement.id, failedCheck: failed },
      ),
    ];
  }

  const diff = assets - liabilities - equity;
  if (Math.abs(diff) <= TOLERANCE) return [];

  return [
    makeFinding(
      ctx,
      STATEMENT_RULE_IDS.balance,
      statementTarget(statement),
      '资产负债表不平衡',
      `${STATEMENT_KIND_LABEL[statement.kind]}（${statement.period}）：资产总计 ${formatYuan(assets)} 元，` +
        `负债合计 ${formatYuan(liabilities)} 元，所有者权益合计 ${formatYuan(equity)} 元，` +
        `资产与「负债+所有者权益」相差 ${formatYuan(diff)} 元。会计恒等式不成立，整张报表不可用。`,
      '核对总账余额与报表取数：是否漏结转损益、是否重复结转、是否直接修改报表单元格、' +
        '是否把本年利润同时计入权益与损益。修正后重新生成并复核。',
      [LAW_ACCOUNTING_LAW_20, LAW_ENTERPRISE_SYSTEM_11],
      { statementId: statement.id, assets, liabilities, equity, diff },
    ),
  ];
}

/** STMT-CASH-001：现金流量表期末现金 ≠ 资产负债表货币资金。 */
function checkCashFlow(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const cashFlow = pickStatement(input.statements, 'cash_flow', ctx.period);
  const balanceSheet = pickStatement(input.statements, 'balance_sheet', ctx.period);
  if (cashFlow === undefined || balanceSheet === undefined) return [];

  const endingCash = amountBy(cashFlow, isEndingCash);
  const monetaryFunds = amountBy(balanceSheet, isMonetaryFunds);
  if (endingCash === undefined || monetaryFunds === undefined) return [];

  const diff = endingCash - monetaryFunds;
  if (Math.abs(diff) <= TOLERANCE) return [];

  return [
    makeFinding(
      ctx,
      STATEMENT_RULE_IDS.cash,
      statementTarget(cashFlow),
      '现金流量表期末现金与资产负债表货币资金不符',
      `现金流量表（${cashFlow.period}）期末现金及现金等价物余额 ${formatYuan(endingCash)} 元，` +
        `资产负债表（${balanceSheet.period}）货币资金 ${formatYuan(monetaryFunds)} 元，` +
        `相差 ${formatYuan(diff)} 元。现金流量表的期末现金必须能与资产负债表的货币资金衔接。`,
      '核对现金及现金等价物的口径：是否包含受限资金（保证金、冻结存款）、定期存款、' +
        '以及三个月内到期的短期投资；口径差异应在附注说明并保持两表一致。' +
        '若为记账错误，应补充或冲正现金流量项目。',
      [LAW_ACCOUNTING_LAW_20, LAW_ENTERPRISE_SYSTEM_11],
      { cashFlowId: cashFlow.id, balanceSheetId: balanceSheet.id, endingCash, monetaryFunds, diff },
    ),
  ];
}

/** STMT-NET-001：利润表净利润 ≠ 所有者权益变动表净利润。 */
function checkNetProfit(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const income = pickStatement(input.statements, 'income_statement', ctx.period);
  const equity = pickStatement(input.statements, 'equity_change', ctx.period);
  if (income === undefined || equity === undefined) return [];

  const incomeNet = amountBy(income, isNetProfit);
  const equityNet = amountBy(equity, isNetProfit);
  if (incomeNet === undefined || equityNet === undefined) return [];

  const diff = incomeNet - equityNet;
  if (Math.abs(diff) <= TOLERANCE) return [];

  return [
    makeFinding(
      ctx,
      STATEMENT_RULE_IDS.netProfit,
      statementTarget(equity),
      '利润表净利润与所有者权益变动表净利润不符',
      `利润表（${income.period}）净利润 ${formatYuan(incomeNet)} 元，` +
        `所有者权益变动表（${equity.period}）净利润 ${formatYuan(equityNet)} 元，` +
        `相差 ${formatYuan(diff)} 元。两张表对同一期间的净利润必须一致。`,
      '核对利润表「净利润」行与权益变动表「净利润」行的取数来源；' +
        '检查是否存在直接计入所有者权益的利得/损失（其他综合收益）被误计入净利润，' +
        '或权益变动表漏填、错填。',
      [LAW_ACCOUNTING_LAW_20, LAW_ENTERPRISE_SYSTEM_11],
      { incomeId: income.id, equityId: equity.id, incomeNet, equityNet, diff },
    ),
  ];
}

/** STMT-CONTINUITY-001：本期期初 ≠ 上期期末。 */
function checkContinuity(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const statements = input.statements;
  if (statements === undefined) return [];

  const balanceSheets = statements
    .filter((item) => item.kind === 'balance_sheet')
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));

  const current = balanceSheets.find((item) => item.period === ctx.period);
  if (current === undefined) return [];

  const year = Number(ctx.period.slice(0, 4));
  const priorYearEnd = `${year - 1}-12`;
  const baseline = balanceSheets.find((item) => item.period === priorYearEnd);
  // 没有上年年末报表就没有比较基准，不做猜测。
  if (baseline === undefined) return [];

  const diffs: string[] = [];
  const details: Array<{ label: string; opening: Cents; priorClosing: Cents; diff: Cents }> = [];

  for (const line of current.lines) {
    if (line.priorAmount === undefined || line.priorAmount === null) continue;
    if (!(line.isTotal === true || isTotalAssets(line) || isTotalLiabilities(line) || isTotalEquity(line))) {
      continue;
    }

    const previousLine =
      baseline.lines.find((item) => item.code === line.code) ??
      baseline.lines.find((item) => compactText(item.label) === compactText(line.label));
    if (previousLine === undefined || previousLine.amount === null) continue;

    const diff = line.priorAmount - previousLine.amount;
    if (Math.abs(diff) <= TOLERANCE) continue;

    details.push({
      label: line.label,
      opening: line.priorAmount,
      priorClosing: previousLine.amount,
      diff,
    });
    if (diffs.length < 5) {
      diffs.push(
        `「${line.label}」年初余额 ${formatYuan(line.priorAmount)} 元，${priorYearEnd} 期末余额 ${formatYuan(previousLine.amount)} 元，相差 ${formatYuan(diff)} 元`,
      );
    }
  }

  if (details.length === 0) return [];

  return [
    makeFinding(
      ctx,
      STATEMENT_RULE_IDS.continuity,
      statementTarget(current),
      '期初余额与上期期末不一致',
      `${STATEMENT_KIND_LABEL[current.kind]}（${current.period}）的年初余额与 ${priorYearEnd} 期末余额不一致：` +
        `${diffs.join('；')}${details.length > 5 ? `；……共 ${details.length} 项` : ''}。` +
        '期初数必须等于上期期末数，否则本期所有变动都建立在错误的起点上，跨期比较也失去意义。',
      '核对上年结转、审计调整、以前年度损益调整与合并范围变化；' +
        '若为追溯调整，应在附注披露调整依据与影响金额，并保留审批记录；不得直接修改年初数。',
      [LAW_ACCOUNTING_LAW_20, LAW_ACCOUNTING_BASIS_60, LAW_ENTERPRISE_SYSTEM_11],
      { statementId: current.id, baselineId: baseline.id, priorYearEnd, details },
    ),
  ];
}

/* ================================================================== */
/* 四、注册                                                            */
/* ================================================================== */

export const statementChecks: readonly CheckDefinition[] = [
  {
    id: STATEMENT_RULE_IDS.balance,
    title: '资产负债表平衡（资产=负债+权益）',
    category: 'data_quality',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_ACCOUNTING_LAW_20, LAW_ENTERPRISE_SYSTEM_11],
    run: checkBalanceSheet,
  },
  {
    id: STATEMENT_RULE_IDS.cash,
    title: '现金流量表期末现金与货币资金衔接',
    category: 'data_quality',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_ACCOUNTING_LAW_20, LAW_ENTERPRISE_SYSTEM_11],
    run: checkCashFlow,
  },
  {
    id: STATEMENT_RULE_IDS.netProfit,
    title: '利润表净利润与权益变动表一致',
    category: 'data_quality',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_ACCOUNTING_LAW_20, LAW_ENTERPRISE_SYSTEM_11],
    run: checkNetProfit,
  },
  {
    id: STATEMENT_RULE_IDS.continuity,
    title: '期初余额等于上期期末',
    category: 'data_quality',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_ACCOUNTING_LAW_20, LAW_ACCOUNTING_BASIS_60],
    run: checkContinuity,
  },
];
