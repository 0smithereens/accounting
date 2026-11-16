/**
 * 财务分析：比率、杜邦、趋势、结构、风险预警。
 *
 * 三条设计原则：
 *  1. **指标口径来自配置**。30 个指标的公式写在 config/report/ratios.yaml 里，
 *     会计可以自己改阈值和行业参考区间，不需要改代码；本文件只做求值。
 *  2. **算不出来就说算不出来**。分母为 0、缺少上期数据时返回 null 而不是 0，
 *     评级为 unknown，避免把「没有数据」伪装成「表现良好」。
 *  3. **结论必须能被数字复算**。所有比率保留 4 位小数、百分比保留 2 位，
 *     并在 comment 里写明公式与参考区间，便于复核人手工验算。
 */

import type {
  AnalysisAlert,
  Cents,
  DupontBreakdown,
  FinancialAnalysis,
  FinancialRatio,
  FinancialStatement,
  LedgerBalance,
  Period,
  StructureAnalysis,
  TrendPoint,
} from '../core/contracts.ts';
import { RATIO_GROUP_LABEL } from '../core/contracts.ts';
import { CONFIG_DIR } from '../core/config.ts';
import { formatYuan } from '../core/money.ts';
import type {
  MetricDef,
  MetricExpr,
  RatingRule,
  RatioConfig,
  RatioDef,
  StructureDef,
} from './mapping.ts';
import {
  createBalanceIndex,
  loadRatioConfig,
  loadStatementFormat,
  sumAccounts,
} from './mapping.ts';
import type { PeriodSnapshot, ReportInput } from './statements.ts';
import { deriveCashFlow, reportingBalances } from './statements.ts';
import { buildNarratives } from './narrative.ts';
import type { NarrativeContext } from './narrative.ts';

/* ================================================================== */
/* 一、基础指标求值                                                    */
/* ================================================================== */

/** 指标包：一次求值的结果，支持按需惰性取值。 */
export interface MetricBag {
  values: Map<string, number>;
  /** 账簿中完全没有对应科目的指标名称 */
  missing: string[];
  get(key: string): number | null;
}

function evalExpr(expr: MetricExpr, resolve: (key: string) => number | null): number | null {
  if (expr.m !== undefined) return resolve(expr.m);
  if (expr.k !== undefined) return expr.k;

  const op = expr.op;
  if (op === undefined) return null;
  const args = expr.args ?? [];
  const vals = args.map((a) => evalExpr(a, resolve));

  if (op === 'abs') {
    const v = vals[0];
    return v === undefined || v === null ? null : Math.abs(v);
  }
  if (op === 'neg') {
    const v = vals[0];
    return v === undefined || v === null ? null : -v;
  }
  if (vals.length === 0) return null;
  if (vals.some((v) => v === null)) return null;

  const nums = vals as number[];
  switch (op) {
    case 'add':
      return nums.reduce((a, b) => a + b, 0);
    case 'sub': {
      const first = nums[0] ?? 0;
      return nums.slice(1).reduce((a, b) => a - b, first);
    }
    case 'mul':
      return nums.reduce((a, b) => a * b, 1);
    case 'div': {
      const a = nums[0];
      const b = nums[1];
      if (a === undefined || b === undefined || b === 0) return null;
      return a / b;
    }
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    default:
      return null;
  }
}

/**
 * 计算基础指标。
 *
 * priorBag 用于解析表达式里的 prior.xxx；没有上期数据时相关指标返回 null。
 * 科目在账簿中不存在时按 0 计（这是会计事实：该科目没有余额），
 * 但会把指标名称记入 missing，供报告提示「该项目本期无数据」。
 */
export function computeMetrics(
  defs: readonly MetricDef[],
  balances: readonly LedgerBalance[],
  cashflow: ReadonlyMap<string, number>,
  priorBag: MetricBag | null = null,
): MetricBag {
  const index = createBalanceIndex(balances);
  const defByKey = new Map<string, MetricDef>();
  for (const def of defs) defByKey.set(def.key, def);

  const values = new Map<string, number>();
  const missing: string[] = [];
  const visiting = new Set<string>();

  const get = (key: string): number | null => {
    if (key.startsWith('prior.')) {
      return priorBag === null ? null : priorBag.get(key.slice('prior.'.length));
    }
    const cached = values.get(key);
    if (cached !== undefined) return cached;
    if (values.has(key)) return null;

    const def = defByKey.get(key);
    if (def === undefined) return null;
    if (visiting.has(key)) return null;

    visiting.add(key);
    let value: number | null = null;

    if (def.expr !== undefined) {
      value = evalExpr(def.expr, get);
    } else if (def.source === 'cashflow') {
      value = cashflow.get(key) ?? null;
    } else if (def.accounts !== undefined) {
      const r = sumAccounts(
        index,
        def.accounts,
        def.sign ?? 'debit',
        def.minus ?? [],
        def.source ?? 'closing',
        true,
      );
      if (!r.matched) missing.push(def.label);
      value = r.amount;
    }

    visiting.delete(key);
    if (value !== null && Number.isFinite(value)) {
      values.set(key, value);
      return value;
    }
    return null;
  };

  for (const def of defs) get(def.key);

  return {
    values,
    missing: [...new Set(missing)],
    get: (key: string) => get(key),
  };
}

/* ================================================================== */
/* 二、比率求值与评级                                                  */
/* ================================================================== */

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function precisionOf(def: RatioDef): number {
  return def.precision ?? (def.unit === '%' ? 2 : 4);
}

/** 数值展示：百分比保留 2 位，其它保留 4 位。 */
export function formatRatioValue(value: number, unit: string): string {
  if (unit === '%') return `${value.toFixed(2)}%`;
  return `${value.toFixed(4)} ${unit}`;
}

function rateValue(value: number | null, rule: RatingRule): FinancialRatio['rating'] {
  if (value === null || !Number.isFinite(value)) return 'unknown';

  if (rule.direction === 'higher_better') {
    const good = rule.good as number;
    const watch = rule.watch as number;
    if (value >= good) return 'good';
    if (value >= watch) return 'watch';
    return 'bad';
  }
  if (rule.direction === 'lower_better') {
    const good = rule.good as number;
    const watch = rule.watch as number;
    if (value <= good) return 'good';
    if (value <= watch) return 'watch';
    return 'bad';
  }
  const good = rule.good as [number, number];
  const watch = rule.watch as [number, number];
  if (value >= good[0] && value <= good[1]) return 'good';
  if (value >= watch[0] && value <= watch[1]) return 'watch';
  return 'bad';
}

const RATING_TEXT: Record<FinancialRatio['rating'], string> = {
  good: '处于健康区间',
  watch: '处于需关注区间',
  bad: '已偏离合理水平，需重点关注',
  unknown: '数据不足，无法评价',
};

function buildRatioComment(def: RatioDef, value: number | null, rating: FinancialRatio['rating']): string {
  if (value === null) {
    return `本期数据不足，无法计算${def.name}（${def.formula}）；需结合行业与经营情况进一步核实。`;
  }
  const head = `${def.name}为 ${formatRatioValue(value, def.unit)}，${RATING_TEXT[rating]}`;
  const bench = def.benchmark ?? null;
  let benchText = '';
  if (bench !== null) {
    const [low, high] = bench;
    const range = def.unit === '%' ? `${low}%~${high}%` : `${low}~${high} ${def.unit}`;
    if (value < low) benchText = `，低于行业参考区间 ${range}`;
    else if (value > high) benchText = `，高于行业参考区间 ${range}`;
    else benchText = `，落在行业参考区间 ${range} 内`;
  }
  return `${head}${benchText}。${def.hint ?? ''}`;
}

function resolveMetric(key: string, current: MetricBag, prior: MetricBag | null): number | null {
  if (key.startsWith('prior.')) {
    return prior === null ? null : prior.get(key.slice('prior.'.length));
  }
  return current.get(key);
}

/** 求单个比率（供趋势与预警复用）。 */
export function evaluateRatio(
  def: RatioDef,
  current: MetricBag,
  prior: MetricBag | null,
): FinancialRatio {
  const raw = evalExpr(def.expr, (key) => resolveMetric(key, current, prior));
  const value = raw === null || !Number.isFinite(raw) ? null : roundTo(raw, precisionOf(def));
  const rating = rateValue(value, def.rating);
  return {
    code: def.code,
    name: def.name,
    group: def.group,
    unit: def.unit,
    value,
    formula: def.formula,
    benchmark: def.benchmark ?? null,
    rating,
    comment: buildRatioComment(def, value, rating),
  };
}

/* ================================================================== */
/* 三、杜邦分析                                                        */
/* ================================================================== */

/**
 * 杜邦分解：ROE = 净利率 × 总资产周转率 × 权益乘数。
 *
 * 采用平均余额口径（与「净资产收益率」指标一致），因此三因子乘积严格等于 ROE，
 * 差异只来自浮点误差（< 1e-9），便于用测试锁定恒等式。
 */
function buildDupont(current: MetricBag, prior: MetricBag | null): DupontBreakdown {
  const np = current.get('netProfit');
  const revenue = current.get('revenue');
  const assets = current.get('averageTotalAssets');
  const equity = current.get('averageTotalEquity');

  const margin = np !== null && revenue !== null && revenue !== 0 ? (np / revenue) * 100 : null;
  const turnover = revenue !== null && assets !== null && assets !== 0 ? revenue / assets : null;
  const multiplier = assets !== null && equity !== null && equity !== 0 ? assets / equity : null;
  const roe = margin !== null && turnover !== null && multiplier !== null
    ? margin * turnover * multiplier
    : null;

  const result: DupontBreakdown = {
    roe,
    netProfitMargin: margin,
    assetTurnover: turnover,
    equityMultiplier: multiplier,
  };

  if (prior === null || roe === null) return result;
  if (margin === null || turnover === null || multiplier === null) return result;

  const pNp = prior.get('netProfit');
  const pRevenue = prior.get('revenue');
  const pAssets = prior.get('averageTotalAssets');
  const pEquity = prior.get('averageTotalEquity');
  if (pNp === null || pRevenue === null || pAssets === null || pEquity === null) return result;
  if (pRevenue === 0 || pAssets === 0 || pEquity === 0) return result;

  const pMargin = (pNp / pRevenue) * 100;
  const pTurnover = pRevenue / pAssets;
  const pMultiplier = pAssets / pEquity;

  // 连环替代法：依次替换净利率、周转率、权益乘数，三者之和 = ROE 变动（百分点）
  const c1 = (margin - pMargin) * pTurnover * pMultiplier;
  const c2 = margin * (turnover - pTurnover) * pMultiplier;
  const c3 = margin * turnover * (multiplier - pMultiplier);

  result.contributions = {
    netProfitMargin: roundTo(c1, 4),
    assetTurnover: roundTo(c2, 4),
    equityMultiplier: roundTo(c3, 4),
  };
  return result;
}

/* ================================================================== */
/* 四、趋势                                                            */
/* ================================================================== */

/** 期间平移：YYYY-MM 加减若干月。 */
export function shiftPeriod(period: Period, months: number): Period {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const total = year * 12 + (month - 1) + months;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  return `${newYear}-${String(newMonth).padStart(2, '0')}`;
}

function changeRate(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return roundTo(((current - previous) / Math.abs(previous)) * 100, 2);
}

function snapshotField(snapshot: PeriodSnapshot, key: string): number | null {
  switch (key) {
    case 'revenue':
      return snapshot.revenue;
    case 'netProfit':
      return snapshot.netProfit;
    case 'totalAssets':
      return snapshot.totalAssets;
    case 'equity':
      return snapshot.equity;
    case 'operatingCashFlow':
      return snapshot.operatingCashFlow;
    default:
      return null;
  }
}

function buildTrends(
  cfg: RatioConfig,
  input: ReportInput,
  currentBag: MetricBag,
  history: readonly PeriodSnapshot[],
): Record<string, TrendPoint[]> {
  const result: Record<string, TrendPoint[]> = {};

  const sorted = [...history].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  const periods = sorted.map((s) => s.period);
  if (!periods.includes(input.period)) periods.push(input.period);

  // 历史各期指标包：按期顺序串联，使「上期」引用可用
  const bags = new Map<Period, MetricBag>();
  let previous: MetricBag | null = null;
  for (const snapshot of sorted) {
    const bag = computeMetrics(
      cfg.metrics,
      snapshot.balances,
      new Map<string, number>([['operatingCashFlow', snapshot.operatingCashFlow]]),
      previous,
    );
    bags.set(snapshot.period, bag);
    previous = bag;
  }

  for (const def of cfg.trends) {
    const ratioDef = cfg.ratios.find((r) => r.code === def.key);
    const metricDef = cfg.metrics.find((m) => m.key === def.key);

    const valueAt = (period: Period): number | null => {
      if (period === input.period) {
        if (ratioDef !== undefined) {
          const r = evaluateRatio(ratioDef, currentBag, previous);
          return r.value;
        }
        if (def.key === 'equity') return currentBag.get('totalEquity');
        if (def.key === 'operatingCashFlow') return currentBag.get('operatingCashFlow');
        return currentBag.get(def.key);
      }
      const snapshot = sorted.find((s) => s.period === period);
      if (snapshot === undefined) return null;
      const field = snapshotField(snapshot, def.key);
      if (field !== null) return field;
      const bag = bags.get(period);
      if (bag === undefined) return null;
      if (ratioDef !== undefined) return evaluateRatio(ratioDef, bag, previous).value;
      if (metricDef !== undefined) return bag.get(metricDef.key);
      return null;
    };

    const points: TrendPoint[] = [];
    for (const period of periods) {
      const value = valueAt(period);
      if (value === null) continue;
      points.push({ period, value });
    }
    result[def.key] = points;

    const yoy: TrendPoint[] = [];
    const mom: TrendPoint[] = [];
    for (const point of points) {
      const value = typeof point.value === 'number' ? point.value : null;
      if (value === null) continue;

      const lastYear = points.find((p) => p.period === shiftPeriod(point.period, -12));
      if (lastYear !== undefined && typeof lastYear.value === 'number') {
        const rate = changeRate(value, lastYear.value);
        if (rate !== null) yoy.push({ period: point.period, value: rate });
      }
      const index = points.findIndex((p) => p.period === point.period);
      const previousPoint = index > 0 ? points[index - 1] : undefined;
      if (previousPoint !== undefined && typeof previousPoint.value === 'number') {
        const rate = changeRate(value, previousPoint.value);
        if (rate !== null) mom.push({ period: point.period, value: rate });
      }
    }
    if (yoy.length > 0) result[`${def.key}_yoy`] = yoy;
    if (mom.length > 0) result[`${def.key}_mom`] = mom;
  }

  return result;
}

/* ================================================================== */
/* 五、结构分析                                                        */
/* ================================================================== */

interface StructureItem {
  label: string;
  amount: Cents;
  share: number;
}

function evaluateStructure(
  defs: readonly StructureDef[],
  balances: readonly LedgerBalance[],
  total: Cents,
  addResidual: boolean,
): StructureItem[] {
  const index = createBalanceIndex(balances);
  const items: StructureItem[] = [];
  let sum = 0;

  for (const def of defs) {
    const r = sumAccounts(
      index,
      def.accounts,
      def.sign ?? 'debit',
      def.minus ?? [],
      def.source ?? 'closing',
      true,
      def.exclude ?? [],
    );
    if (r.amount === 0) continue;
    items.push({ label: def.label, amount: r.amount, share: 0 });
    sum += r.amount;
  }

  const residual = total - sum;
  if (addResidual && residual !== 0) {
    items.push({ label: '其他', amount: residual, share: 0 });
    sum += residual;
  }

  const base = addResidual ? total : sum;
  for (const item of items) {
    item.share = base === 0 ? 0 : roundTo(item.amount / base, 4);
  }

  items.sort((a, b) => b.amount - a.amount);
  return items;
}

function buildStructure(cfg: RatioConfig, balances: readonly LedgerBalance[], revenue: Cents): StructureAnalysis {
  const index = createBalanceIndex(balances);
  const costTotal = sumAccounts(index, ['6401', '6402'], 'debit', [], 'net', true).amount;
  const expenseTotal = sumAccounts(index, ['6601', '6602', '6603', '6403'], 'debit', [], 'net', true).amount;

  return {
    revenueByCategory: evaluateStructure(cfg.structure.revenue, balances, revenue, true),
    costByCategory: evaluateStructure(cfg.structure.cost, balances, costTotal, false),
    expenseByCategory: evaluateStructure(cfg.structure.expense, balances, expenseTotal, false),
  };
}

/* ================================================================== */
/* 六、风险预警                                                        */
/* ================================================================== */

function ratioValueOf(ratios: readonly FinancialRatio[], code: string): number | null {
  return ratios.find((r) => r.code === code)?.value ?? null;
}

function buildAlerts(
  ratios: readonly FinancialRatio[],
  cfg: RatioConfig,
  current: MetricBag,
  prior: MetricBag | null,
  trends: Record<string, TrendPoint[]>,
): AnalysisAlert[] {
  const alerts: AnalysisAlert[] = [];

  const currentRatio = ratioValueOf(ratios, 'SOL-01');
  if (currentRatio !== null && currentRatio < 1) {
    alerts.push({
      level: 'warning',
      code: 'ALERT-CURRENT-RATIO',
      title: `流动比率低于 1（${currentRatio.toFixed(2)}）`,
      detail:
        `流动资产 ${formatYuan(current.get('currentAssets') ?? 0)} 元，流动负债 ${formatYuan(current.get('currentLiabilities') ?? 0)} 元，` +
        '流动资产不足以覆盖短期债务。',
      action: '优先安排回款、压缩存货或在到期前落实续贷；如为季节性波动，请在附注中说明。',
    });
  }

  const debtRatio = ratioValueOf(ratios, 'SOL-04');
  if (debtRatio !== null && debtRatio > 70) {
    alerts.push({
      level: 'error',
      code: 'ALERT-DEBT-RATIO',
      title: `资产负债率超过 70%（${debtRatio.toFixed(2)}%）`,
      detail:
        `负债总额 ${formatYuan(current.get('totalLiabilities') ?? 0)} 元，资产总额 ${formatYuan(current.get('totalAssets') ?? 0)} 元，` +
        '财务杠杆偏高，融资空间与抗风险能力受限。',
      action: '制定降杠杆计划（增资、利润留存、处置低效资产），并核查是否存在表外负债与担保。',
    });
  }

  const ocf = trends['operatingCashFlow'] ?? [];
  if (ocf.length >= 2) {
    const lastTwo = ocf.slice(-2);
    const allNegative = lastTwo.every((p) => typeof p.value === 'number' && p.value < 0);
    if (allNegative) {
      alerts.push({
        level: 'error',
        code: 'ALERT-OCF-NEGATIVE',
        title: '经营活动现金流量连续两期为负',
        detail: lastTwo
          .map((p) => `${p.period}：${formatYuan(Number(p.value))} 元`)
          .join('；'),
        action: '核查是否存在收入确认激进、回款失控或关联方资金占用；必要时调整信用政策与备货节奏。',
      });
    }
  }

  const ar = current.get('accountsReceivable');
  const priorAr = prior === null ? null : prior.get('accountsReceivable');
  const revenue = current.get('revenue');
  const priorRevenue = prior === null ? null : prior.get('revenue');
  if (ar !== null && priorAr !== null && priorAr !== 0 && revenue !== null && priorRevenue !== null && priorRevenue !== 0) {
    const arGrowth = ((ar - priorAr) / Math.abs(priorAr)) * 100;
    const revenueGrowth = ((revenue - priorRevenue) / Math.abs(priorRevenue)) * 100;
    if (arGrowth - revenueGrowth > 20) {
      alerts.push({
        level: 'warning',
        code: 'ALERT-AR-GROWTH',
        title: `应收账款增速高出收入增速 ${(arGrowth - revenueGrowth).toFixed(2)} 个百分点`,
        detail:
          `应收账款由 ${formatYuan(priorAr)} 元增至 ${formatYuan(ar)} 元（+${arGrowth.toFixed(2)}%），` +
          `营业收入由 ${formatYuan(priorRevenue)} 元增至 ${formatYuan(revenue)} 元（+${revenueGrowth.toFixed(2)}%）。`,
        action: '检查是否放宽信用政策换收入、是否存在跨期确认收入；对应收账款账龄与坏账准备计提做专项复核。',
      });
    }
  }

  const grossMargin = ratioValueOf(ratios, 'PRO-01');
  const grossMarginDef = cfg.ratios.find((r) => r.code === 'PRO-01');
  if (grossMargin !== null && grossMarginDef !== undefined && prior !== null) {
    const priorGross = evaluateRatio(grossMarginDef, prior, null).value;
    if (priorGross !== null && priorGross - grossMargin > 5) {
      alerts.push({
        level: 'warning',
        code: 'ALERT-GROSS-MARGIN',
        title: `毛利率同比下降 ${(priorGross - grossMargin).toFixed(2)} 个百分点`,
        detail: `本期毛利率 ${grossMargin.toFixed(2)}%，上期 ${priorGross.toFixed(2)}%。`,
        action: '拆解售价、单位成本与产品结构变动；若为原材料涨价，评估调价与套期保值可行性。',
      });
    }
  }

  const inventoryDays = ratioValueOf(ratios, 'OPE-04');
  const inventoryDaysDef = cfg.ratios.find((r) => r.code === 'OPE-04');
  if (inventoryDays !== null && inventoryDaysDef !== undefined && prior !== null) {
    const priorDays = evaluateRatio(inventoryDaysDef, prior, null).value;
    if (priorDays !== null && priorDays > 0 && (inventoryDays - priorDays) / priorDays > 0.5) {
      alerts.push({
        level: 'warning',
        code: 'ALERT-INVENTORY-DAYS',
        title: `存货周转天数同比上升 ${(((inventoryDays - priorDays) / priorDays) * 100).toFixed(2)}%`,
        detail: `本期 ${inventoryDays.toFixed(2)} 天，上期 ${priorDays.toFixed(2)} 天。`,
        action: '盘点呆滞存货、核查跌价准备计提是否充分，并评估备货策略与订单匹配度。',
      });
    }
  }

  // 连续两期恶化（按配置的方向判断）
  for (const def of cfg.trends) {
    const series = trends[def.key] ?? [];
    if (series.length < 3) continue;
    const last = series.slice(-3).map((p) => (typeof p.value === 'number' ? p.value : null));
    const a = last[0];
    const b = last[1];
    const c = last[2];
    if (a === null || b === null || c === null) continue;
    if (a === undefined || b === undefined || c === undefined) continue;
    const worsening = def.direction === 'higher_better' ? b < a && c < b : b > a && c > b;
    if (!worsening) continue;
    const unit = def.unit ?? '';
    alerts.push({
      level: 'warning',
      code: `ALERT-TREND-${def.key}`,
      title: `${def.label}连续两期恶化`,
      detail:
        `${series[series.length - 3]?.period ?? ''} 至 ${series[series.length - 1]?.period ?? ''}：` +
        `${a}${unit} → ${b}${unit} → ${c}${unit}。`,
      action: `对「${def.label}」的驱动因素做专项分析，并在管理报表中持续跟踪。`,
    });
  }

  return alerts;
}

/* ================================================================== */
/* 七、入口                                                            */
/* ================================================================== */

export type AnalysisInput = ReportInput & { statements: FinancialStatement[] };

/** 生成完整财务分析报告。 */
export function generateAnalysis(input: AnalysisInput): FinancialAnalysis {
  const configDir = input.configDir ?? CONFIG_DIR;
  const cfg = loadRatioConfig(configDir);
  const format = loadStatementFormat(input.standard, configDir);
  const cfConfig = format.sections.cash_flow?.cashflow;

  const currentCf = new Map<string, number>();
  if (cfConfig !== undefined) {
    const result = deriveCashFlow(input.ledger.vouchers, input.ledger.balances, cfConfig);
    for (const [k, v] of result.seeds) currentCf.set(k, v);
    currentCf.set('operatingCashFlow', result.operatingNet);
  }

  const priorCf = new Map<string, number>();
  if (cfConfig !== undefined && input.priorLedger !== undefined) {
    const result = deriveCashFlow(input.priorLedger.vouchers, input.priorLedger.balances, cfConfig);
    for (const [k, v] of result.seeds) priorCf.set(k, v);
    priorCf.set('operatingCashFlow', result.operatingNet);
  }

  // 与报表同口径：先剔除结转损益凭证，否则损益类指标会被结转成 0
  const currentBalances = reportingBalances(input.ledger);
  const priorBalances = input.priorLedger === undefined ? null : reportingBalances(input.priorLedger);

  const priorBag = priorBalances === null
    ? null
    : computeMetrics(cfg.metrics, priorBalances, priorCf, null);

  const currentBag = computeMetrics(cfg.metrics, currentBalances, currentCf, priorBag);

  const ratios = cfg.ratios.map((def) => evaluateRatio(def, currentBag, priorBag));
  const dupont = buildDupont(currentBag, priorBag);
  const trends = buildTrends(cfg, input, currentBag, input.history ?? []);
  const structure = buildStructure(cfg, currentBalances, currentBag.get('revenue') ?? 0);
  const alerts = buildAlerts(ratios, cfg, currentBag, priorBag, trends);

  /* ---------------- 数据完整性说明 ---------------- */
  const dataNotes: string[] = [];
  if (input.priorLedger === undefined) {
    dataNotes.push('未提供上期账簿快照：同比类指标与报表「上期金额」列无法计算，相关指标按空值列示。');
  }
  if ((input.history ?? []).length === 0) {
    dataNotes.push('未提供多期历史快照：趋势分析仅含本期一个数据点，无法识别连续恶化。');
  }
  if (currentBag.missing.length > 0) {
    dataNotes.push(`本期账簿中无对应科目余额的指标（按 0 参与计算）：${currentBag.missing.join('、')}。`);
  }
  const failedStatements = input.statements.filter((s) => !s.passed);
  if (failedStatements.length > 0) {
    dataNotes.push(
      `以下报表存在勾稽差异，分析结论可能受影响：${failedStatements.map((s) => s.id).join('、')}。`,
    );
  }

  // 指标口径与报表口径交叉核对（避免指标定义漏掉科目）
  const bsTotalAssets = findTotal(input.statements, 'balance_sheet', '资产总计');
  const metricAssets = currentBag.get('totalAssets');
  if (bsTotalAssets !== null && metricAssets !== null && bsTotalAssets !== metricAssets) {
    dataNotes.push(
      `指标口径的资产总计 ${formatYuan(metricAssets)} 元与资产负债表「资产总计」${formatYuan(bsTotalAssets)} 元不一致，` +
        '通常是账簿中存在未纳入指标定义的科目，请核对 config/report/ratios.yaml 的 totalAssets 科目范围。',
    );
  }
  if (dupont.roe !== null) {
    const roeRatio = ratios.find((r) => r.code === 'PRO-05')?.value ?? null;
    if (roeRatio !== null && Math.abs(dupont.roe - roeRatio) > 0.01) {
      dataNotes.push(
        `杜邦分析的 ROE（${dupont.roe.toFixed(2)}%）与「净资产收益率」指标（${roeRatio.toFixed(2)}%）存在差异，` +
          '系平均余额口径与期末口径不同所致，二者均以指标口径为准。',
      );
    }
  }

  const narrativeCtx: NarrativeContext = {
    period: input.period,
    standard: input.standard,
    ratios,
    dupont,
    alerts,
    structure,
    metrics: currentBag.values,
    priorMetrics: priorBag === null ? null : priorBag.values,
    trends,
    dataNotes,
    hasPrior: input.priorLedger !== undefined,
  };
  const narratives = buildNarratives(narrativeCtx);

  return {
    id: `${input.standard}-${input.period}-ANALYSIS`,
    period: input.period,
    standard: input.standard,
    generatedAt: new Date().toISOString(),
    ratios,
    dupont,
    trends,
    structure,
    narratives,
    alerts,
    dataNotes,
  };
}

function findTotal(
  statements: readonly FinancialStatement[],
  kind: FinancialStatement['kind'],
  label: string,
): Cents | null {
  const statement = statements.find((s) => s.kind === kind);
  if (statement === undefined) return null;
  const line = statement.lines.find((l) => l.label.includes(label) && l.amount !== null);
  return line === undefined ? null : (line.amount ?? null);
}

/** 按分组汇总比率，供报告与前端分组展示。 */
export function groupRatios(
  ratios: readonly FinancialRatio[],
): Array<{ group: FinancialRatio['group']; label: string; ratios: FinancialRatio[] }> {
  const order: Array<FinancialRatio['group']> = [
    'solvency',
    'operation',
    'profitability',
    'growth',
    'cashflow',
    'quality',
  ];
  return order.map((group) => ({
    group,
    label: RATIO_GROUP_LABEL[group],
    ratios: ratios.filter((r) => r.group === group),
  }));
}
