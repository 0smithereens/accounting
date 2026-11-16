/**
 * 中文财务分析结论生成。
 *
 * 写作纪律（比文采重要）：
 *  1. 每一句结论后面必须跟数字；数字直接取自 analysis 的计算结果，不另行估算。
 *  2. 数据缺失时写「本期无法计算」并说明缺什么，绝不编造趋势或原因。
 *  3. 不做「经营状况良好」这类无信息量的断言：要么给出可复算的比率，
 *     要么给出「需结合行业与经营情况进一步核实」的明确保留。
 */

import type {
  AccountingStandardId,
  AnalysisAlert,
  DupontBreakdown,
  FinancialRatio,
  NarrativeSection,
  Period,
  StructureAnalysis,
  TrendPoint,
} from '../core/contracts.ts';
import { ACCOUNTING_STANDARD_LABEL, RATIO_GROUP_LABEL } from '../core/contracts.ts';
import { formatYuanGrouped } from '../core/money.ts';

/** 生成结论所需的全部素材。 */
export interface NarrativeContext {
  period: Period;
  standard: AccountingStandardId;
  ratios: FinancialRatio[];
  dupont: DupontBreakdown;
  alerts: AnalysisAlert[];
  structure: StructureAnalysis;
  metrics: ReadonlyMap<string, number>;
  priorMetrics: ReadonlyMap<string, number> | null;
  trends: Record<string, TrendPoint[]>;
  dataNotes: string[];
  hasPrior: boolean;
}

/* ================================================================== */
/* 工具                                                                */
/* ================================================================== */

function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${formatYuanGrouped(Math.round(value))} 元`;
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}%`;
}

function times(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}`;
}

function ratioOf(ctx: NarrativeContext, code: string): FinancialRatio | undefined {
  return ctx.ratios.find((r) => r.code === code);
}

function ratioText(ctx: NarrativeContext, code: string): string {
  const r = ratioOf(ctx, code);
  if (r === undefined || r.value === null) return '无法计算';
  return r.unit === '%' ? pct(r.value) : `${r.value.toFixed(2)} ${r.unit}`;
}

function metric(ctx: NarrativeContext, key: string): number | null {
  const v = ctx.metrics.get(key);
  return v === undefined ? null : v;
}

function priorMetric(ctx: NarrativeContext, key: string): number | null {
  if (ctx.priorMetrics === null) return null;
  const v = ctx.priorMetrics.get(key);
  return v === undefined ? null : v;
}

/** 取某趋势序列最后一个同比值（%）。 */
function lastYoy(ctx: NarrativeContext, key: string): number | null {
  const series = ctx.trends[`${key}_yoy`];
  if (series === undefined || series.length === 0) return null;
  const last = series[series.length - 1];
  if (last === undefined || typeof last.value !== 'number') return null;
  return last.value;
}

function growthSentence(
  label: string,
  current: number | null,
  previous: number | null,
): string {
  if (current === null || previous === null) {
    return `本期${label} ${money(current)}，缺少上期数据，无法判断同比变化。`;
  }
  if (previous === 0) {
    return `本期${label} ${money(current)}，上期为 0，同比增速不适用。`;
  }
  const rate = ((current - previous) / Math.abs(previous)) * 100;
  const direction = rate >= 0 ? '增长' : '下降';
  return `本期${label} ${money(current)}，上期 ${money(previous)}，同比${direction} ${Math.abs(rate).toFixed(2)}%。`;
}

/** 同比增速：优先用趋势序列（多期历史），没有历史时用上期快照现算。 */
function yoyOf(ctx: NarrativeContext, key: string): number | null {
  const fromTrend = lastYoy(ctx, key);
  if (fromTrend !== null) return fromTrend;
  const current = metric(ctx, key);
  const previous = priorMetric(ctx, key);
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/* ================================================================== */
/* 六个分析段落                                                        */
/* ================================================================== */

function sectionOverview(ctx: NarrativeContext): NarrativeSection {
  const revenue = metric(ctx, 'revenue');
  const netProfit = metric(ctx, 'netProfit');
  const priorRevenue = priorMetric(ctx, 'revenue');
  const priorNetProfit = priorMetric(ctx, 'netProfit');

  const body: string[] = [];
  body.push(
    `${ctx.period} 按${ACCOUNTING_STANDARD_LABEL[ctx.standard]}口径，` +
      growthSentence('营业收入', revenue, priorRevenue) +
      growthSentence('净利润', netProfit, priorNetProfit),
  );

  if (revenue !== null && revenue > 0 && netProfit !== null) {
    const margin = (netProfit / revenue) * 100;
    let marginText = `本期净利率 ${pct(margin)}`;
    if (priorRevenue !== null && priorRevenue > 0 && priorNetProfit !== null) {
      const priorMargin = (priorNetProfit / priorRevenue) * 100;
      const delta = margin - priorMargin;
      marginText += `，较上期 ${pct(priorMargin)} ${delta >= 0 ? '上升' : '下降'} ${Math.abs(delta).toFixed(2)} 个百分点`;
      marginText += delta > 0 && yoyOf(ctx, 'revenue') !== null && yoyOf(ctx, 'netProfit') !== null &&
        (yoyOf(ctx, 'netProfit') ?? 0) > (yoyOf(ctx, 'revenue') ?? 0)
        ? '，利润增速快于收入增速，成本费用控制对利润形成正向贡献。'
        : '。';
    } else {
      marginText += '，缺少上期数据无法判断变化方向。';
    }
    body.push(marginText);
  } else if (revenue !== null && revenue === 0) {
    body.push('本期营业收入为 0.00 元，损益类科目无发生额，请先确认凭证是否已全部入账。');
  }

  const evidence = [
    { label: '营业收入', value: money(revenue) },
    { label: '净利润', value: money(netProfit) },
    { label: '净利率', value: ratioText(ctx, 'PRO-03') },
    { label: '营业收入同比', value: yoyOf(ctx, 'revenue') === null ? '—' : pct(yoyOf(ctx, 'revenue')) },
  ];

  return {
    title: '一、经营成果概览',
    body: body.join('\n\n'),
    evidence,
  };
}

function sectionProfitability(ctx: NarrativeContext): NarrativeSection {
  const body: string[] = [];
  const gross = ratioOf(ctx, 'PRO-01');
  const operating = ratioOf(ctx, 'PRO-02');

  const parts: string[] = [];
  parts.push(`毛利率 ${ratioText(ctx, 'PRO-01')}`);
  parts.push(`营业利润率 ${ratioText(ctx, 'PRO-02')}`);
  parts.push(`净利率 ${ratioText(ctx, 'PRO-03')}`);

  if (gross?.value !== null && gross?.value !== undefined && operating?.value !== null && operating?.value !== undefined) {
    const gap = gross.value - operating.value;
    parts.push(
      `毛利率与营业利润率相差 ${gap.toFixed(2)} 个百分点，对应期间费用与税金及附加的消耗；` +
        `本期期间费用 ${money(metric(ctx, 'periodExpense'))}，期间费用率 ${ratioText(ctx, 'QUA-02')}`,
    );
  }
  body.push(`${parts.join('；')}。`);

  const d = ctx.dupont;
  if (d.roe !== null && d.netProfitMargin !== null && d.assetTurnover !== null && d.equityMultiplier !== null) {
    let dupontText =
      `杜邦分解：ROE ${pct(d.roe)} = 净利率 ${pct(d.netProfitMargin)} × 总资产周转率 ${times(d.assetTurnover)} 次 × 权益乘数 ${times(d.equityMultiplier)} 倍。`;
    if (d.contributions !== undefined) {
      const c = d.contributions;
      const items: string[] = [];
      if (c['netProfitMargin'] !== undefined) items.push(`净利率 ${c['netProfitMargin'] >= 0 ? '+' : ''}${c['netProfitMargin'].toFixed(2)} 个百分点`);
      if (c['assetTurnover'] !== undefined) items.push(`周转率 ${c['assetTurnover'] >= 0 ? '+' : ''}${c['assetTurnover'].toFixed(2)} 个百分点`);
      if (c['equityMultiplier'] !== undefined) items.push(`权益乘数 ${c['equityMultiplier'] >= 0 ? '+' : ''}${c['equityMultiplier'].toFixed(2)} 个百分点`);
      dupontText += `与上期相比，各因子对 ROE 变动的贡献为：${items.join('、')}（合计约 ${((c['netProfitMargin'] ?? 0) + (c['assetTurnover'] ?? 0) + (c['equityMultiplier'] ?? 0)).toFixed(2)} 个百分点）。`;
    } else {
      dupontText += '缺少上期杜邦数据，无法分解 ROE 变动的来源。';
    }
    body.push(dupontText);
  } else {
    body.push('杜邦分解所需数据不完整（净利润、营业收入、平均资产或平均权益缺失），本期不做三因子拆解。');
  }

  const evidence = [
    { label: '毛利率', value: ratioText(ctx, 'PRO-01') },
    { label: '营业利润率', value: ratioText(ctx, 'PRO-02') },
    { label: '净利率', value: ratioText(ctx, 'PRO-03') },
    { label: '净资产收益率', value: ratioText(ctx, 'PRO-05') },
    { label: '总资产报酬率', value: ratioText(ctx, 'PRO-04') },
  ];

  return { title: '二、盈利能力', body: body.join('\n\n'), evidence };
}

function sectionSolvency(ctx: NarrativeContext): NarrativeSection {
  const body: string[] = [];
  body.push(
    `流动比率 ${ratioText(ctx, 'SOL-01')}、速动比率 ${ratioText(ctx, 'SOL-02')}、现金比率 ${ratioText(ctx, 'SOL-03')}；` +
      `流动资产 ${money(metric(ctx, 'currentAssets'))}，其中存货 ${money(metric(ctx, 'inventory'))}，` +
      `流动负债 ${money(metric(ctx, 'currentLiabilities'))}。`,
  );
  body.push(
    `资产负债率 ${ratioText(ctx, 'SOL-04')}，产权比率 ${ratioText(ctx, 'SOL-05')}，` +
      `负债总额 ${money(metric(ctx, 'totalLiabilities'))}、所有者权益 ${money(metric(ctx, 'totalEquity'))}；` +
      `利息保障倍数 ${ratioText(ctx, 'SOL-06')}，利息支出 ${money(metric(ctx, 'interestExpense'))}。`,
  );

  const solvencyAlerts = ctx.alerts.filter((a) => a.code === 'ALERT-CURRENT-RATIO' || a.code === 'ALERT-DEBT-RATIO');
  if (solvencyAlerts.length === 0) {
    body.push('本期未触发流动比率低于 1 或资产负债率高于 70% 的预警阈值。');
  } else {
    body.push(solvencyAlerts.map((a) => `【预警】${a.title}`).join('；') + '。');
  }

  return {
    title: '三、偿债能力与资本结构',
    body: body.join('\n\n'),
    evidence: [
      { label: '流动比率', value: ratioText(ctx, 'SOL-01') },
      { label: '速动比率', value: ratioText(ctx, 'SOL-02') },
      { label: '资产负债率', value: ratioText(ctx, 'SOL-04') },
      { label: '利息保障倍数', value: ratioText(ctx, 'SOL-06') },
    ],
  };
}

function sectionOperation(ctx: NarrativeContext): NarrativeSection {
  const body: string[] = [];
  body.push(
    `应收账款周转率 ${ratioText(ctx, 'OPE-01')}（周转天数 ${ratioText(ctx, 'OPE-02')}），` +
      `存货周转率 ${ratioText(ctx, 'OPE-03')}（周转天数 ${ratioText(ctx, 'OPE-04')}），` +
      `应付账款周转率 ${ratioText(ctx, 'OPE-05')}。`,
  );
  body.push(
    `总资产周转率 ${ratioText(ctx, 'OPE-06')}，固定资产周转率 ${ratioText(ctx, 'OPE-07')}；` +
      `平均资产总额 ${money(metric(ctx, 'averageTotalAssets'))}，营业收入 ${money(metric(ctx, 'revenue'))}。`,
  );

  const arGrowth = yoyOf(ctx, 'accountsReceivable');
  const revenueGrowth = yoyOf(ctx, 'revenue');
  if (arGrowth !== null && revenueGrowth !== null) {
    const gap = arGrowth - revenueGrowth;
    body.push(
      `应收账款同比 ${arGrowth >= 0 ? '增长' : '下降'} ${Math.abs(arGrowth).toFixed(2)}%，营业收入同比 ` +
        `${revenueGrowth >= 0 ? '增长' : '下降'} ${Math.abs(revenueGrowth).toFixed(2)}%，` +
        `两者相差 ${gap.toFixed(2)} 个百分点` +
        (gap > 20
          ? '，超过 20 个百分点的预警阈值，需核查信用政策与收入确认时点。'
          : '，未超过 20 个百分点的预警阈值。'),
    );
  } else {
    body.push('应收账款与营业收入的同比数据不完整，无法判断回款效率的变化方向；需结合行业与经营情况进一步核实。');
  }

  const evidence = [
    { label: '应收账款周转天数', value: ratioText(ctx, 'OPE-02') },
    { label: '存货周转天数', value: ratioText(ctx, 'OPE-04') },
    { label: '总资产周转率', value: ratioText(ctx, 'OPE-06') },
    { label: '应收账款', value: money(metric(ctx, 'accountsReceivable')) },
    { label: '存货', value: money(metric(ctx, 'inventory')) },
  ];

  return { title: '四、营运效率与资产质量', body: body.join('\n\n'), evidence };
}

function sectionCashflow(ctx: NarrativeContext): NarrativeSection {
  const body: string[] = [];
  const ocf = metric(ctx, 'operatingCashFlow');
  const netProfit = metric(ctx, 'netProfit');

  body.push(
    `经营活动现金流量净额 ${money(ocf)}，现金流量比率 ${ratioText(ctx, 'CAS-02')}，` +
      `现金再投资比率 ${ratioText(ctx, 'CAS-03')}。`,
  );

  if (ocf !== null && netProfit !== null && netProfit !== 0) {
    const quality = ocf / netProfit;
    body.push(
      `经营现金流对净利润比 ${ratioText(ctx, 'CAS-01')}（经营现金 ${money(ocf)} ÷ 净利润 ${money(netProfit)}）` +
        (quality >= 1
          ? '，利润基本转化为现金，盈余质量较好。'
          : quality >= 0.5
            ? '，利润的现金含量偏低，需关注应收账款与存货占用的资金。'
            : '，利润的现金含量明显不足，存在「有利润无现金」的风险，需结合应收账款账龄与存货结构进一步核实。'),
    );
  } else {
    body.push('净利润为 0 或缺失，无法计算经营现金流对净利润比；需结合行业与经营情况进一步核实。');
  }

  const ocfTrend = ctx.trends['operatingCashFlow'] ?? [];
  if (ocfTrend.length >= 2) {
    body.push(
      `经营活动现金流量净额近 ${ocfTrend.length} 期：` +
        ocfTrend
          .slice(-4)
          .map((p) => `${p.period} ${money(typeof p.value === 'number' ? p.value : null)}`)
          .join('、') +
        '。',
    );
  } else {
    body.push('未提供多期历史，无法判断经营现金流是否持续为负；需结合行业与经营情况进一步核实。');
  }

  const evidence = [
    { label: '经营活动现金流量净额', value: money(ocf) },
    { label: '经营现金流对净利润比', value: ratioText(ctx, 'CAS-01') },
    { label: '现金流量比率', value: ratioText(ctx, 'CAS-02') },
    { label: '现金再投资比率', value: ratioText(ctx, 'CAS-03') },
  ];

  return { title: '五、现金流量与盈余质量', body: body.join('\n\n'), evidence };
}

function sectionConclusion(ctx: NarrativeContext): NarrativeSection {
  const body: string[] = [];
  const revenue = metric(ctx, 'revenue');
  const revenueYoy = yoyOf(ctx, 'revenue');

  const highlights: string[] = [];
  const concerns: string[] = [];

  if (revenueYoy !== null) {
    (revenueYoy >= 0 ? highlights : concerns).push(
      `营业收入 ${money(revenue)}，同比${revenueYoy >= 0 ? '增长' : '下降'} ${Math.abs(revenueYoy).toFixed(2)}%`,
    );
  }
  const roe = ratioOf(ctx, 'PRO-05');
  if (roe?.value !== null && roe?.value !== undefined) {
    (roe.rating === 'good' ? highlights : concerns).push(`净资产收益率 ${pct(roe.value)}（${roe.rating === 'good' ? '健康' : roe.rating === 'watch' ? '需关注' : '偏低'}）`);
  }
  const debt = ratioOf(ctx, 'SOL-04');
  if (debt?.value !== null && debt?.value !== undefined) {
    const level = debt.rating === 'good' ? '健康' : debt.rating === 'watch' ? '偏高' : '过高';
    (debt.rating === 'good' ? highlights : concerns).push(`资产负债率 ${pct(debt.value)}（${level}）`);
  }

  if (highlights.length > 0) body.push(`相对积极的方面：${highlights.join('；')}。`);
  if (concerns.length > 0) body.push(`需要关注的方面：${concerns.join('；')}。`);

  if (ctx.alerts.length > 0) {
    body.push(
      `本期触发 ${ctx.alerts.length} 条风险预警：` +
        ctx.alerts.map((a) => `${a.title}（建议：${a.action}）`).join('；') +
        '。',
    );
  } else {
    body.push('本期未触发预设的六类风险预警阈值；阈值判定仅基于本报告列示的指标，不代表不存在其他经营风险。');
  }

  body.push(
    '本报告的结论均由账簿数据自动计算，所有数字可在「财务指标」与「趋势」明细中复算；' +
      '涉及行业景气、资产减值、或有事项、关联交易等无法从账簿直接判断的事项，需结合行业与经营情况进一步核实，' +
      '并由会计主管复核后使用。',
  );

  if (ctx.dataNotes.length > 0) {
    body.push(`数据说明：${ctx.dataNotes.join(' ')}`);
  }

  return {
    title: '六、结论与建议',
    body: body.join('\n\n'),
    evidence: [
      { label: '风险预警条数', value: String(ctx.alerts.length) },
      { label: '营业利润率', value: ratioText(ctx, 'PRO-02') },
      { label: '流动比率', value: ratioText(ctx, 'SOL-01') },
      { label: '经营现金流对净利润比', value: ratioText(ctx, 'CAS-01') },
    ],
  };
}

/* ================================================================== */
/* 入口                                                                */
/* ================================================================== */

/** 生成 6 段中文分析结论。 */
export function buildNarratives(ctx: NarrativeContext): NarrativeSection[] {
  return [
    sectionOverview(ctx),
    sectionProfitability(ctx),
    sectionSolvency(ctx),
    sectionOperation(ctx),
    sectionCashflow(ctx),
    sectionConclusion(ctx),
  ];
}

/** 结构分析转成一句中文描述（供导出与前端使用）。 */
export function describeStructure(structure: StructureAnalysis): string {
  const parts: string[] = [];
  const fmt = (items: StructureAnalysis['revenueByCategory']): string =>
    items
      .slice(0, 5)
      .map((i) => `${i.label} ${formatYuanGrouped(i.amount)} 元（${(i.share * 100).toFixed(2)}%）`)
      .join('、');

  if (structure.revenueByCategory.length > 0) parts.push(`收入构成：${fmt(structure.revenueByCategory)}`);
  if (structure.costByCategory.length > 0) parts.push(`成本构成：${fmt(structure.costByCategory)}`);
  if (structure.expenseByCategory.length > 0) parts.push(`费用构成：${fmt(structure.expenseByCategory)}`);
  return parts.join('；');
}

/** 指标分组的展示名，供 Markdown 导出复用。 */
export function groupLabel(group: FinancialRatio['group']): string {
  return RATIO_GROUP_LABEL[group];
}

/** 预警按严重程度排序：error 在前。 */
export function sortAlerts(alerts: readonly AnalysisAlert[]): AnalysisAlert[] {
  const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
  return [...alerts].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
}
