/**
 * 四张财务报表的生成。
 *
 * 设计要点：
 *  1. 报表格式与取数规则全部来自 config/report/statements-<standard>.yaml，
 *     本文件只负责「组装」：建索引 → 执行 DSL → 算勾稽 → 填上期列。
 *  2. 现金流量表无法从余额表直接得出，改为按凭证的「现金对方科目」分析填列；
 *     分析结果与货币资金期初期末变动不一致时，差额并入经营活动兜底项目并记 issue，
 *     绝不让报表在无声无息中被「调平」。
 *  3. 上一期列取 priorLedger 的期末余额：对资产负债表是「上期期末」，
 *     对利润表是「上期发生额」（损益类用 net 口径）。
 */

import type {
  AccountingStandardId,
  Cents,
  FinancialStatement,
  IsoDateTime,
  LedgerBalance,
  LedgerSnapshot,
  Period,
  ProcessingIssue,
  StatementCheck,
  StatementKind,
  StatementLine,
  Voucher,
} from '../core/contracts.ts';
import { ENGINE_VERSION } from '../core/contracts.ts';
import { CONFIG_DIR } from '../core/config.ts';
import { formatYuan } from '../core/money.ts';
import type {
  BalanceIndex,
  CashFlowConfig,
  EvaluateResult,
  StatementFormat,
  StatementSectionDef,
} from './mapping.ts';
import {
  createBalanceIndex,
  describeRule,
  evaluateSection,
  loadStatementFormat,
  notesToChecks,
  runChecks,
} from './mapping.ts';

/* ================================================================== */
/* 一、公共输入输出类型                                                */
/* ================================================================== */

/** 多期快照：趋势分析用。 */
export interface PeriodSnapshot {
  period: Period;
  balances: LedgerBalance[];
  revenue: Cents;
  netProfit: Cents;
  totalAssets: Cents;
  equity: Cents;
  operatingCashFlow: Cents;
}

/** 报表生成输入。 */
export interface ReportInput {
  standard: AccountingStandardId;
  period: Period;
  ledger: LedgerSnapshot;
  /** 上一期账簿快照，用于填列报表的上期/年初列 */
  priorLedger?: LedgerSnapshot;
  /** 多期历史，用于趋势分析 */
  history?: PeriodSnapshot[];
  /** 配置目录，缺省为项目 config/ */
  configDir?: string;
}

export interface GenerateStatementsResult {
  statements: FinancialStatement[];
  issues: ProcessingIssue[];
}

/* ================================================================== */
/* 二、现金流量表的凭证分析填列                                        */
/* ================================================================== */

export interface CashFlowResult {
  /** 现金流量表项目的外部数值（CFX-* 键） */
  seeds: Map<string, Cents>;
  beginningCash: Cents;
  endingCash: Cents;
  netIncrease: Cents;
  /** 三类活动净额，供财务分析直接引用（避免分析模块重复解析凭证） */
  operatingNet: Cents;
  investingNet: Cents;
  financingNet: Cents;
  /** 是否因凭证与货币资金变动不一致而做了差额调整 */
  reconciled: boolean;
  /** 分析过程中的说明 */
  notes: string[];
}

/**
 * 剔除「结转损益」凭证对损益类科目发生额的影响。
 *
 * 为什么必须做这一步：期末做结转凭证后，收入类科目会被借记相同金额，
 * 使 debitTotal 与 creditTotal 相等，利润表若直接用「发生额净额」取数会得到 0。
 * 这里从凭证层面识别结转凭证（同时出现 4103 本年利润与 6xxx 损益科目），
 * 把它的金额从 6xxx 科目的发生额中扣除，还原出真实的当期损益发生额。
 *
 * 只在确实存在结转凭证时生效；没有结转凭证时原样返回，不做任何猜测。
 */
export function stripClosingEntries(
  balances: readonly LedgerBalance[],
  vouchers: readonly Voucher[],
): LedgerBalance[] {
  const closingVouchers = vouchers.filter((v) => {
    const hasProfit = v.lines.some((l) => l.accountCode === '4103' || l.accountCode.startsWith('4103.'));
    const hasProfitLoss = v.lines.some((l) => l.accountCode.startsWith('6'));
    return hasProfit && hasProfitLoss;
  });
  if (closingVouchers.length === 0) return [...balances];

  const delta = new Map<string, { debit: Cents; credit: Cents }>();
  for (const voucher of closingVouchers) {
    for (const line of voucher.lines) {
      if (!line.accountCode.startsWith('6')) continue;
      const bucket = delta.get(line.accountCode) ?? { debit: 0, credit: 0 };
      bucket.debit += line.debit;
      bucket.credit += line.credit;
      delta.set(line.accountCode, bucket);
    }
  }

  return balances.map((b) => {
    const d = delta.get(b.accountCode);
    if (d === undefined) return b;
    return {
      ...b,
      debitTotal: b.debitTotal - d.debit,
      creditTotal: b.creditTotal - d.credit,
      closing: b.closing - (d.debit - d.credit),
    };
  });
}

/** 报表口径的余额：剔除结转损益凭证的影响。 */
export function reportingBalances(ledger: LedgerSnapshot): LedgerBalance[] {
  return stripClosingEntries(ledger.balances, ledger.vouchers);
}

/** 判断科目编码是否落在某个科目前缀下（含本身与下级）。 */
export function isUnderPrefix(code: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (code === prefix || code.startsWith(`${prefix}.`)) return true;
  }
  return false;
}

function cashTotal(balances: readonly LedgerBalance[], cashAccounts: readonly string[], field: 'opening' | 'closing'): Cents {
  let total = 0;
  for (const b of balances) {
    if (isUnderPrefix(b.accountCode, cashAccounts)) {
      total += field === 'opening' ? b.opening : b.closing;
    }
  }
  return total;
}

/**
 * 按凭证分析填列现金流量表。
 *
 * 算法：逐张凭证计算「现金及现金等价物净变动」= Σ(现金科目借方 − 贷方)；
 * 为 0 的凭证（内部划转）直接跳过；其余凭证按对方科目归类为经营/投资/筹资，
 * 再按对方科目匹配具体报表项目。一张凭证同时涉及多类活动时，按
 * 投资 > 筹资 > 经营 的优先级归类，并在说明里注明。
 *
 * 该方法的局限：无法识别「一笔收款包含增值税与货款」这类需要拆分的情形，
 * 也无法处理未通过现金科目的应计业务，因此结果定位为「分析填列、供复核」，
 * 正式申报与对外报送仍须会计师复核。
 */
export function deriveCashFlow(
  vouchers: readonly Voucher[],
  balances: readonly LedgerBalance[],
  config: CashFlowConfig,
): CashFlowResult {
  const seeds = new Map<string, Cents>();
  for (const item of config.items) seeds.set(item.key, 0);

  const notes: string[] = [];
  const fallbackIn = config.items.find(
    (i) => i.flow === 'operating' && i.direction === 'in' && i.accounts === undefined,
  );
  const fallbackOut = config.items.find(
    (i) => i.flow === 'operating' && i.direction === 'out' && i.accounts === undefined,
  );

  for (const voucher of vouchers) {
    let cashDelta = 0;
    const counterparties: string[] = [];

    for (const line of voucher.lines) {
      if (isUnderPrefix(line.accountCode, config.cashAccounts)) {
        cashDelta += line.debit - line.credit;
      } else if (line.debit !== 0 || line.credit !== 0) {
        counterparties.push(line.accountCode);
      }
    }

    // 现金内部划转（如基本户转一般户）不构成现金流量
    if (cashDelta === 0) continue;

    let flow: 'operating' | 'investing' | 'financing' = 'operating';
    if (counterparties.some((c) => isUnderPrefix(c, config.investing))) {
      flow = 'investing';
    } else if (counterparties.some((c) => isUnderPrefix(c, config.financing))) {
      flow = 'financing';
    }

    const direction = cashDelta > 0 ? 'in' : 'out';
    const candidates = config.items.filter((i) => i.flow === flow && i.direction === direction);
    const matched = candidates.find(
      (i) => i.accounts !== undefined && counterparties.some((c) => isUnderPrefix(c, i.accounts ?? [])),
    );
    const item = matched ?? candidates.find((i) => i.accounts === undefined);

    if (item === undefined) {
      notes.push(
        `凭证 ${voucher.word} 的现金变动 ${formatYuan(cashDelta)} 元找不到可归类的现金流量项目，已忽略`,
      );
      continue;
    }
    seeds.set(item.key, (seeds.get(item.key) ?? 0) + Math.abs(cashDelta));
  }

  const beginningCash = cashTotal(balances, config.cashAccounts, 'opening');
  const endingCash = cashTotal(balances, config.cashAccounts, 'closing');
  const netIncrease = endingCash - beginningCash;

  let operatingNet = 0;
  let investingNet = 0;
  let financingNet = 0;
  for (const item of config.items) {
    const amount = seeds.get(item.key) ?? 0;
    const signed = item.direction === 'in' ? amount : -amount;
    if (item.flow === 'operating') operatingNet += signed;
    else if (item.flow === 'investing') investingNet += signed;
    else financingNet += signed;
  }

  const computed = operatingNet + investingNet + financingNet;
  const diff = netIncrease - computed;
  let reconciled = false;

  if (diff !== 0) {
    const target = diff > 0 ? fallbackIn : fallbackOut;
    if (target !== undefined) {
      seeds.set(target.key, (seeds.get(target.key) ?? 0) + Math.abs(diff));
      reconciled = true;
      notes.push(
        `按凭证分析得出的现金净增加额为 ${formatYuan(computed)} 元，与货币资金期初期末变动 ${formatYuan(netIncrease)} 元相差 ` +
          `${formatYuan(diff)} 元，差额已并入「${target.key}」，请复核是否存在未入账的现金收支或内部划转`,
      );
    } else {
      notes.push(
        `按凭证分析得出的现金净增加额与货币资金变动相差 ${formatYuan(diff)} 元，且未配置经营活动兜底项目，无法调整`,
      );
    }
  }

  seeds.set('CFX-BEGIN', beginningCash);
  return {
    seeds,
    beginningCash,
    endingCash,
    netIncrease,
    operatingNet,
    investingNet,
    financingNet,
    reconciled,
    notes,
  };
}

/* ================================================================== */
/* 三、单张报表组装                                                    */
/* ================================================================== */

interface BuildContext {
  standard: AccountingStandardId;
  period: Period;
  format: StatementFormat;
  index: BalanceIndex;
  priorIndex: BalanceIndex | null;
  generatedAt: IsoDateTime;
  issues: ProcessingIssue[];
}

function labelMapOf(section: StatementSectionDef): (key: string) => string {
  const map = new Map<string, string>();
  for (const row of section.rows) map.set(row.key, row.label);
  return (key: string) => map.get(key) ?? key;
}

function sectionOf(ctx: BuildContext, kind: StatementKind): StatementSectionDef {
  const section = ctx.format.sections[kind];
  if (section === undefined) {
    throw new Error(`${ctx.format.file} 未定义 ${kind} 报表格式`);
  }
  return section;
}

interface BuiltStatement {
  statement: FinancialStatement;
  result: EvaluateResult;
}

function buildOne(
  ctx: BuildContext,
  kind: StatementKind,
  external: ReadonlyMap<string, Cents>,
  priorExternal: ReadonlyMap<string, Cents>,
): BuiltStatement {
  const section = sectionOf(ctx, kind);
  const labelOf = labelMapOf(section);

  const result = evaluateSection(section, {
    balances: ctx.index,
    external,
    sourceFile: ctx.format.file,
  });
  ctx.issues.push(...result.issues);

  const priorResult = ctx.priorIndex === null
    ? null
    : evaluateSection(section, {
        balances: ctx.priorIndex,
        external: priorExternal,
        sourceFile: ctx.format.file,
      });

  const priorByKey = new Map<string, Cents | null>();
  if (priorResult !== null) {
    for (const row of priorResult.rows) priorByKey.set(row.def.key, row.amount);
  }

  const lines: StatementLine[] = result.rows.map((row) => {
    const formula = row.def.formula ?? describeRule(row.def.rule, labelOf);
    const priorAmount = priorResult === null ? null : (priorByKey.get(row.def.key) ?? null);
    return {
      code: row.def.code,
      label: row.def.label,
      level: row.def.level,
      amount: row.amount,
      priorAmount,
      isTotal: row.def.isTotal,
      formula,
    };
  });

  const checkResult = runChecks(section.checks, result.values, external, ctx.format.file);
  ctx.issues.push(...checkResult.issues);

  const checks: StatementCheck[] = [...checkResult.checks, ...notesToChecks(section.notes)];
  const passed = checks.every((c) => c.passed);

  return {
    statement: {
      id: `${ctx.standard}-${ctx.period}-${kind}`,
      kind,
      period: ctx.period,
      standard: ctx.standard,
      lines,
      checks,
      passed,
      generatedAt: ctx.generatedAt,
      engineVersion: ENGINE_VERSION,
    },
    result,
  };
}

/* ================================================================== */
/* 四、入口                                                            */
/* ================================================================== */

/**
 * 生成四张财务报表。
 *
 * 顺序固定为 资产负债表 → 利润表 → 现金流量表 → 所有者权益变动表，
 * 因为后一张表要用到前一张表的结果：
 *   - 现金流量表的「期末现金 = 资产负债表货币资金」勾稽需要资产负债表；
 *   - 所有者权益变动表的「其中：净利润」需要利润表净利润。
 */
export function generateStatements(input: ReportInput): GenerateStatementsResult {
  const configDir = input.configDir ?? CONFIG_DIR;
  const format = loadStatementFormat(input.standard, configDir);
  const issues: ProcessingIssue[] = [];
  const generatedAt = new Date().toISOString();

  // 报表口径：先剔除结转损益凭证，否则利润表会被结转成 0
  const currentBalances = reportingBalances(input.ledger);
  const priorBalances = input.priorLedger === undefined ? null : reportingBalances(input.priorLedger);

  const ctx: BuildContext = {
    standard: input.standard,
    period: input.period,
    format,
    index: createBalanceIndex(currentBalances),
    priorIndex: priorBalances === null ? null : createBalanceIndex(priorBalances),
    generatedAt,
    issues,
  };

  const emptyExternal = new Map<string, Cents>();
  const statements: FinancialStatement[] = [];

  /* ---------------- 1. 资产负债表 ---------------- */
  const bs = buildOne(ctx, 'balance_sheet', emptyExternal, emptyExternal);
  statements.push(bs.statement);

  /* ---------------- 2. 利润表 ---------------- */
  const is = buildOne(ctx, 'income_statement', emptyExternal, emptyExternal);
  statements.push(is.statement);
  const netProfit = is.result.values.get('IS-NP') ?? 0;

  // 本年利润科目与利润表交叉校验：只提示，不调账
  const currentProfitAccount = ctx.index.value(['4103'], 'net', true);
  if (currentProfitAccount.matched && currentProfitAccount.amount !== 0) {
    const booked = -currentProfitAccount.amount;
    if (booked !== netProfit) {
      issues.push({
        level: 'warning',
        message:
          `本年利润科目（4103）本期净发生额为 ${formatYuan(booked)} 元，与利润表净利润 ${formatYuan(netProfit)} 元不一致，` +
          '请检查损益结转是否完整',
        source: { file: format.file, ruleId: 'IS-NP' },
      });
    }
  }

  /* ---------------- 3. 现金流量表 ---------------- */
  const cfSection = format.sections.cash_flow;
  const cfExternal = new Map<string, Cents>();
  const cfPriorExternal = new Map<string, Cents>();

  if (cfSection !== undefined && cfSection.cashflow !== undefined) {
    const current = deriveCashFlow(input.ledger.vouchers, input.ledger.balances, cfSection.cashflow);
    for (const [k, v] of current.seeds) cfExternal.set(k, v);
    for (const note of current.notes) {
      issues.push({ level: 'info', message: note, source: { file: format.file, ruleId: 'CF-ANALYSIS' } });
    }
    if (input.priorLedger !== undefined) {
      const prior = deriveCashFlow(
        input.priorLedger.vouchers,
        input.priorLedger.balances,
        cfSection.cashflow,
      );
      for (const [k, v] of prior.seeds) cfPriorExternal.set(k, v);
    }
  }

  // 供「期末现金 = 资产负债表货币资金」勾稽使用
  const bsCash = bs.result.values.get('BS-CASH') ?? 0;
  cfExternal.set('BS-CASH', bsCash);
  if (input.priorLedger !== undefined) {
    const priorCash = ctx.priorIndex?.value(['1001', '1002', '1012'], 'closing', true).amount ?? 0;
    cfPriorExternal.set('BS-CASH', priorCash);
  }

  const cf = buildOne(ctx, 'cash_flow', cfExternal, cfPriorExternal);
  statements.push(cf.statement);

  /* ---------------- 4. 所有者权益变动表 ---------------- */
  const eqExternal = new Map<string, Cents>();
  eqExternal.set('EQX-NET-PROFIT', netProfit);

  const eqPriorExternal = new Map<string, Cents>();
  if (ctx.priorIndex !== null) {
    const priorIs = evaluateSection(sectionOf(ctx, 'income_statement'), {
      balances: ctx.priorIndex,
      external: emptyExternal,
      sourceFile: format.file,
    });
    eqPriorExternal.set('EQX-NET-PROFIT', priorIs.values.get('IS-NP') ?? 0);
  }

  const eq = buildOne(ctx, 'equity_change', eqExternal, eqPriorExternal);
  statements.push(eq.statement);

  /* ---------------- 汇总提示 ---------------- */
  for (const statement of statements) {
    if (!statement.passed) {
      const failed = statement.checks.filter((c) => !c.passed);
      issues.push({
        level: 'error',
        message:
          `${statement.id} 存在 ${failed.length} 项勾稽差异：` +
          failed.map((c) => `${c.label}（差额 ${formatYuan(c.diff)} 元）`).join('；'),
        source: { file: format.file, ruleId: statement.kind },
      });
    }
  }

  // 报表借贷恒等式兜底：资产总计与负债和权益总计不一致时单独强调
  const totalAssets = bs.result.values.get('BS-TOTAL-ASSETS') ?? 0;
  const totalLe = bs.result.values.get('BS-TOTAL-LE') ?? 0;
  if (totalAssets !== totalLe) {
    issues.push({
      level: 'error',
      message:
        `资产负债表不平衡：资产总计 ${formatYuan(totalAssets)} 元，负债和所有者权益总计 ${formatYuan(totalLe)} 元，` +
        `差额 ${formatYuan(totalAssets - totalLe)} 元。请先核对试算平衡与损益结转，不得直接调整报表`,
      source: { file: format.file, ruleId: 'BS-BALANCE' },
    });
  }

  return { statements, issues };
}

/* ================================================================== */
/* 五、工具                                                            */
/* ================================================================== */

/** 取某张报表的某个行次金额；找不到返回 null。 */
export function statementLineAmount(
  statement: FinancialStatement,
  code: string,
): Cents | null {
  for (const line of statement.lines) {
    if (line.code === code) return line.amount;
  }
  return null;
}

/** 按项目名称查找报表行；用于跨模块（审核、申报）取值。 */
export function findStatementLine(
  statement: FinancialStatement,
  predicate: (line: StatementLine) => boolean,
): StatementLine | undefined {
  return statement.lines.find(predicate);
}

/** 把四张报表按 资产总计/负债合计 等常用口径汇总，供审核模块引用。 */
export interface StatementSummary {
  totalAssets: Cents;
  totalLiabilities: Cents;
  totalEquity: Cents;
  revenue: Cents;
  netProfit: Cents;
  operatingCashFlow: Cents;
  cash: Cents;
}

export function summarizeStatements(statements: readonly FinancialStatement[]): StatementSummary {
  const byKind = new Map<StatementKind, FinancialStatement>();
  for (const s of statements) byKind.set(s.kind, s);

  // 按项目名称取数而不是按行次：两套准则的行次不同，名称才是稳定标识
  const pick = (statement: FinancialStatement | undefined, names: readonly string[]): Cents => {
    if (statement === undefined) return 0;
    // 先精确匹配：「负债合计」不能命中「流动负债合计」
    for (const name of names) {
      const exact = statement.lines.find((l) => l.label === name && l.amount !== null);
      if (exact !== undefined) return exact.amount ?? 0;
    }
    for (const name of names) {
      const partial = statement.lines.find((l) => l.label.includes(name) && l.amount !== null);
      if (partial !== undefined) return partial.amount ?? 0;
    }
    return 0;
  };

  const bs = byKind.get('balance_sheet');
  const is = byKind.get('income_statement');
  const cf = byKind.get('cash_flow');

  return {
    totalAssets: pick(bs, ['资产总计']),
    totalLiabilities: pick(bs, ['负债合计']),
    totalEquity: pick(bs, ['所有者权益合计', '所有者权益（或股东权益）合计']),
    revenue: pick(is, ['营业收入']),
    netProfit: pick(is, ['净利润']),
    operatingCashFlow: pick(cf, ['经营活动产生的现金流量净额']),
    cash: pick(bs, ['货币资金']),
  };
}
