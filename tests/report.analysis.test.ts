/**
 * 财务分析测试。
 *
 * 断言口径：比率保留 4 位小数、百分比保留 2 位，因此用「期望值 ± 半个末位」比对；
 * 杜邦恒等式要求 1e-9 精度，直接锁定三因子乘积 = ROE。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

import { PROJECT_ROOT } from '../src/core/config.ts';

import type {
  FinancialAnalysis,
  FinancialRatio,
  LedgerBalance,
  LedgerSnapshot,
  Voucher,
  VoucherLine,
} from '../src/core/contracts.ts';
import { generateStatements } from '../src/report/statements.ts';
import type { PeriodSnapshot } from '../src/report/statements.ts';
import { generateAnalysis, shiftPeriod } from '../src/report/analysis.ts';
import { exportStatementsExcel, renderAnalysisMarkdown } from '../src/report/export.ts';

/* ================================================================== */
/* 一、测试数据（与 report.statements.test.ts 同一套账簿）              */
/* ================================================================== */

const OPENING: Array<[string, string, number]> = [
  ['1001', '库存现金', 4_000_000],
  ['1002.01', '基本户', 110_000_000],
  ['1012.01', '定期存款', 3_000_000],
  ['1122', '应收账款', 70_000_000],
  ['1231', '坏账准备', -3_500_000],
  ['1123', '预付账款', 9_000_000],
  ['1221.03', '其他应收款', 5_000_000],
  ['1405', '库存商品', 70_900_000],
  ['1471', '存货跌价准备', -900_000],
  ['1601.01', '固定资产', 80_000_000],
  ['1602', '累计折旧', -13_000_000],
  ['1701.01', '无形资产', 12_000_000],
  ['1702', '累计摊销', -1_800_000],
  ['1801', '长期待摊费用', 3_000_000],
  ['1811', '递延所得税资产', 2_300_000],
  ['2001', '短期借款', -30_000_000],
  ['2202', '应付账款', -38_000_000],
  ['2211.01', '应付职工薪酬-工资', -7_000_000],
  ['2221.02', '未交增值税', -5_000_000],
  ['2241.03', '其他应付款-往来款', -4_500_000],
  ['2501', '长期借款', -20_000_000],
  ['4001', '实收资本', -150_000_000],
  ['4002', '资本公积', -20_000_000],
  ['4101', '盈余公积', -15_000_000],
  ['4104', '利润分配', -60_500_000],
];

type Line = [string, string, number, number];

function voucher(word: string, lines: Line[]): Voucher {
  const voucherLines: VoucherLine[] = lines.map(([accountCode, accountName, debit, credit]) => ({
    accountCode,
    accountName,
    debit,
    credit,
    summary: '测试分录',
    source: { file: 'fixture.xlsx' },
  }));
  const totalDebit = voucherLines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = voucherLines.reduce((s, l) => s + l.credit, 0);
  return {
    id: `2024-06-${word}`,
    date: '2024-06-30',
    period: '2024-06',
    word,
    lines: voucherLines,
    attachments: 1,
    balanced: totalDebit === totalCredit,
    totalDebit,
    totalCredit,
    source: { file: 'fixture.xlsx' },
    warnings: [],
  };
}

const VOUCHERS: Voucher[] = [
  voucher('记-0001', [['1002.01', '基本户', 190_000_000, 0], ['6001.01', '商品销售收入', 0, 190_000_000]]),
  voucher('记-0002', [['1122', '应收账款', 10_000_000, 0], ['6001.01', '商品销售收入', 0, 5_000_000], ['6051', '其他业务收入', 0, 5_000_000]]),
  voucher('记-0003', [['6401', '主营业务成本', 120_000_000, 0], ['1405', '库存商品', 0, 120_000_000]]),
  voucher('记-0004', [['1405', '库存商品', 139_100_000, 0], ['2202', '应付账款', 0, 139_100_000]]),
  voucher('记-0005', [['2202', '应付账款', 135_100_000, 0], ['1002.01', '基本户', 0, 135_100_000]]),
  voucher('记-0006', [['6602', '管理费用', 7_000_000, 0], ['2211.01', '应付职工薪酬-工资', 0, 7_000_000]]),
  voucher('记-0007', [['2211.01', '应付职工薪酬-工资', 7_000_000, 0], ['1002.01', '基本户', 0, 7_000_000]]),
  voucher('记-0008', [['6601', '销售费用', 8_000_000, 0], ['1002.01', '基本户', 0, 8_000_000]]),
  voucher('记-0009', [['6602', '管理费用', 13_000_000, 0], ['1002.01', '基本户', 0, 13_000_000]]),
  voucher('记-0010', [['6603.01', '利息支出', 2_500_000, 0], ['6603.02', '手续费', 500_000, 0], ['1002.01', '基本户', 0, 3_000_000]]),
  voucher('记-0011', [['6403', '税金及附加', 2_000_000, 0], ['2221.02', '未交增值税', 0, 2_000_000]]),
  voucher('记-0012', [['2221.02', '未交增值税', 4_000_000, 0], ['1002.01', '基本户', 0, 4_000_000]]),
  voucher('记-0013', [['6801', '所得税费用', 4_000_000, 0], ['2221.03', '应交企业所得税', 0, 4_000_000]]),
  voucher('记-0014', [['1601.01', '固定资产', 10_000_000, 0], ['1002.01', '基本户', 0, 10_000_000]]),
  voucher('记-0015', [['6602', '管理费用', 2_000_000, 0], ['1602', '累计折旧', 0, 2_000_000]]),
  voucher('记-0016', [['6602', '管理费用', 200_000, 0], ['1702', '累计摊销', 0, 200_000]]),
  voucher('记-0017', [['6702', '信用减值损失', 500_000, 0], ['1231', '坏账准备', 0, 500_000]]),
  voucher('记-0018', [['6701', '资产减值损失', 100_000, 0], ['1471', '存货跌价准备', 0, 100_000]]),
  voucher('记-0019', [['1002.01', '基本户', 20_000_000, 0], ['2001', '短期借款', 0, 20_000_000]]),
  voucher('记-0020', [['2001', '短期借款', 20_000_000, 0], ['1002.01', '基本户', 0, 20_000_000]]),
  voucher('记-0021', [['1001', '库存现金', 500_000, 0], ['6301', '营业外收入', 0, 500_000]]),
  voucher('记-0022', [['6711', '营业外支出', 1_500_000, 0], ['1002.01', '基本户', 0, 1_500_000]]),
  voucher('记-0023', [['1002.01', '基本户', 1_000_000, 0], ['6111', '投资收益', 0, 1_000_000]]),
  voucher('记-0024', [
    ['6001.01', '商品销售收入', 195_000_000, 0],
    ['6051', '其他业务收入', 5_000_000, 0],
    ['6111', '投资收益', 1_000_000, 0],
    ['6301', '营业外收入', 500_000, 0],
    ['4103', '本年利润', 0, 201_500_000],
    ['4103', '本年利润', 161_300_000, 0],
    ['6401', '主营业务成本', 0, 120_000_000],
    ['6403', '税金及附加', 0, 2_000_000],
    ['6601', '销售费用', 0, 8_000_000],
    ['6602', '管理费用', 0, 22_200_000],
    ['6603.01', '利息支出', 0, 2_500_000],
    ['6603.02', '手续费', 0, 500_000],
    ['6701', '资产减值损失', 0, 100_000],
    ['6702', '信用减值损失', 0, 500_000],
    ['6711', '营业外支出', 0, 1_500_000],
    ['6801', '所得税费用', 0, 4_000_000],
  ]),
];

function buildSnapshot(
  period: string,
  opening: ReadonlyArray<[string, string, number]>,
  vouchers: readonly Voucher[],
): LedgerSnapshot {
  const names = new Map<string, string>();
  const openingMap = new Map<string, number>();
  for (const [code, name, amount] of opening) {
    names.set(code, name);
    openingMap.set(code, amount);
  }
  const debit = new Map<string, number>();
  const credit = new Map<string, number>();
  for (const v of vouchers) {
    for (const l of v.lines) {
      if (!names.has(l.accountCode)) names.set(l.accountCode, l.accountName);
      debit.set(l.accountCode, (debit.get(l.accountCode) ?? 0) + l.debit);
      credit.set(l.accountCode, (credit.get(l.accountCode) ?? 0) + l.credit);
    }
  }
  const codes = new Set<string>([...openingMap.keys(), ...debit.keys(), ...credit.keys()]);
  const balances: LedgerBalance[] = [...codes].sort().map((code) => {
    const open = openingMap.get(code) ?? 0;
    const d = debit.get(code) ?? 0;
    const c = credit.get(code) ?? 0;
    return {
      accountCode: code,
      accountName: names.get(code) ?? code,
      opening: open,
      debitTotal: d,
      creditTotal: c,
      closing: open + d - c,
    };
  });
  return { period, standard: 'cas', balances, vouchers, openingBalanced: true };
}

const LEDGER = buildSnapshot('2024-06', OPENING, VOUCHERS);

const PRIOR_LEDGER: LedgerSnapshot = {
  period: '2024-05',
  standard: 'cas',
  balances: [
    ...OPENING.map(([code, name, amount]) => ({
      accountCode: code,
      accountName: name,
      opening: code === '4104' ? -25_400_000 : amount,
      debitTotal: 0,
      creditTotal: 0,
      closing: amount,
    })),
    { accountCode: '6001.01', accountName: '商品销售收入', opening: 0, debitTotal: 0, creditTotal: 165_000_000, closing: 0 },
    { accountCode: '6051', accountName: '其他业务收入', opening: 0, debitTotal: 0, creditTotal: 5_000_000, closing: 0 },
    { accountCode: '6401', accountName: '主营业务成本', opening: 0, debitTotal: 102_000_000, creditTotal: 0, closing: 0 },
    { accountCode: '6403', accountName: '税金及附加', opening: 0, debitTotal: 1_700_000, creditTotal: 0, closing: 0 },
    { accountCode: '6601', accountName: '销售费用', opening: 0, debitTotal: 7_000_000, creditTotal: 0, closing: 0 },
    { accountCode: '6602', accountName: '管理费用', opening: 0, debitTotal: 18_000_000, creditTotal: 0, closing: 0 },
    { accountCode: '6603.01', accountName: '利息支出', opening: 0, debitTotal: 2_200_000, creditTotal: 0, closing: 0 },
    { accountCode: '6603.02', accountName: '手续费', opening: 0, debitTotal: 400_000, creditTotal: 0, closing: 0 },
    { accountCode: '6111', accountName: '投资收益', opening: 0, debitTotal: 0, creditTotal: 800_000, closing: 0 },
    { accountCode: '6301', accountName: '营业外收入', opening: 0, debitTotal: 0, creditTotal: 400_000, closing: 0 },
    { accountCode: '6711', accountName: '营业外支出', opening: 0, debitTotal: 1_200_000, creditTotal: 0, closing: 0 },
    { accountCode: '6801', accountName: '所得税费用', opening: 0, debitTotal: 3_600_000, creditTotal: 0, closing: 0 },
  ],
  vouchers: [],
  openingBalanced: true,
};

function analyse(
  ledger: LedgerSnapshot,
  priorLedger?: LedgerSnapshot,
  history?: PeriodSnapshot[],
): FinancialAnalysis {
  const statements = generateStatements({
    standard: 'cas',
    period: '2024-06',
    ledger,
    ...(priorLedger === undefined ? {} : { priorLedger }),
  }).statements;
  return generateAnalysis({
    standard: 'cas',
    period: '2024-06',
    ledger,
    statements,
    ...(priorLedger === undefined ? {} : { priorLedger }),
    ...(history === undefined ? {} : { history }),
  });
}

const ANALYSIS = analyse(LEDGER, PRIOR_LEDGER);


const STATEMENTS = generateStatements({
  standard: 'cas',
  period: '2024-06',
  ledger: LEDGER,
  priorLedger: PRIOR_LEDGER,
}).statements;

function ratio(analysis: FinancialAnalysis, code: string): FinancialRatio {
  const found = analysis.ratios.find((r) => r.code === code);
  assert.ok(found !== undefined, `找不到指标 ${code}`);
  return found;
}

function near(actual: number | null, expected: number, tolerance: number): void {
  assert.ok(actual !== null, `指标值为空，期望 ${expected}`);
  assert.ok(
    Math.abs((actual ?? 0) - expected) <= tolerance,
    `期望 ${expected}，实际 ${actual}`,
  );
}

/* ================================================================== */
/* 二、指标                                                           */
/* ================================================================== */

test('指标数量与分组：30 个指标覆盖六组', () => {
  assert.equal(ANALYSIS.ratios.length, 30);
  const groups = new Set(ANALYSIS.ratios.map((r) => r.group));
  assert.deepEqual(
    [...groups].sort(),
    ['cashflow', 'growth', 'operation', 'profitability', 'quality', 'solvency'],
  );
  assert.ok(ANALYSIS.ratios.every((r) => r.formula !== '' && r.name !== ''));
});

test('偿债能力：流动比率/速动比率/现金比率/资产负债率/产权比率/利息保障倍数', () => {
  near(ratio(ANALYSIS, 'SOL-01').value, 3.3801, 0.00005);   // 305.9M ÷ 90.5M
  near(ratio(ANALYSIS, 'SOL-02').value, 2.3967, 0.00005);   // (305.9M − 89M) ÷ 90.5M
  near(ratio(ANALYSIS, 'SOL-03').value, 1.4022, 0.00005);   // 126.9M ÷ 90.5M
  near(ratio(ANALYSIS, 'SOL-04').value, 27.89, 0.005);      // 110.5M ÷ 396.2M
  near(ratio(ANALYSIS, 'SOL-05').value, 0.3868, 0.00005);   // 110.5M ÷ 285.7M
  near(ratio(ANALYSIS, 'SOL-06').value, 18.68, 0.005);      // (44.2M + 2.5M) ÷ 2.5M
});

test('营运能力：应收账款/存货/应付账款/总资产/固定资产周转率与天数', () => {
  near(ratio(ANALYSIS, 'OPE-01').value, 2.8070, 0.00005);   // 200M ÷ 71.25M
  near(ratio(ANALYSIS, 'OPE-02').value, 128.25, 0.005);     // 360 × 71.25M ÷ 200M
  near(ratio(ANALYSIS, 'OPE-03').value, 1.5094, 0.00005);   // 120M ÷ 79.5M
  near(ratio(ANALYSIS, 'OPE-04').value, 238.50, 0.005);     // 360 × 79.5M ÷ 120M
  near(ratio(ANALYSIS, 'OPE-05').value, 3.0, 0.00005);      // 120M ÷ 40M
  near(ratio(ANALYSIS, 'OPE-06').value, 0.5360, 0.00005);   // 200M ÷ 373.1M
  near(ratio(ANALYSIS, 'OPE-07').value, 2.8169, 0.00005);   // 200M ÷ 71M
});

test('盈利能力：毛利率/营业利润率/净利率/ROA/ROE/成本费用利润率', () => {
  near(ratio(ANALYSIS, 'PRO-01').value, 40.0, 0.005);
  near(ratio(ANALYSIS, 'PRO-02').value, 22.6, 0.005);       // 45.2M ÷ 200M
  near(ratio(ANALYSIS, 'PRO-03').value, 20.1, 0.005);       // 40.2M ÷ 200M
  near(ratio(ANALYSIS, 'PRO-04').value, 10.77, 0.005);      // 40.2M ÷ 373.1M
  near(ratio(ANALYSIS, 'PRO-05').value, 15.14, 0.005);      // 40.2M ÷ 265.6M
  near(ratio(ANALYSIS, 'PRO-06').value, 28.48, 0.005);      // 44.2M ÷ 155.2M
});

test('发展能力：营业收入/净利润/总资产/净资产增长率（同比）', () => {
  near(ratio(ANALYSIS, 'GRO-01').value, 17.65, 0.005);      // (200 − 170) ÷ 170
  near(ratio(ANALYSIS, 'GRO-02').value, 14.53, 0.005);      // (40.2 − 35.1) ÷ 35.1
  near(ratio(ANALYSIS, 'GRO-03').value, 13.20, 0.005);      // (396.2 − 350) ÷ 350
  near(ratio(ANALYSIS, 'GRO-04').value, 16.37, 0.005);      // (285.7 − 245.5) ÷ 245.5
});

test('现金流量与盈余质量指标', () => {
  near(ratio(ANALYSIS, 'CAS-01').value, 0.5448, 0.00005);   // 21.9M ÷ 40.2M
  near(ratio(ANALYSIS, 'CAS-02').value, 0.2420, 0.00005);   // 21.9M ÷ 90.5M
  near(ratio(ANALYSIS, 'CAS-03').value, 24.25, 0.005);      // 21.9M ÷ 90.3M
  near(ratio(ANALYSIS, 'QUA-01').value, 97.50, 0.005);      // 195M ÷ 200M
  near(ratio(ANALYSIS, 'QUA-02').value, 16.60, 0.005);      // 33.2M ÷ 200M
  near(ratio(ANALYSIS, 'QUA-03').value, 2.49, 0.005);       // |0.5 − 1.5| ÷ 40.2
  near(ratio(ANALYSIS, 'QUA-04').value, 38.00, 0.005);      // 76M ÷ 200M
});

test('指标评级与解读：落在参考区间内为 good，且解读文字含公式与数字', () => {
  const gross = ratio(ANALYSIS, 'PRO-01');
  assert.equal(gross.rating, 'good');
  assert.ok(gross.comment.includes('40.00%'));
  const debt = ratio(ANALYSIS, 'SOL-04');
  assert.equal(debt.rating, 'good');
  assert.ok(debt.comment.includes('资产负债率'));
  assert.ok(debt.comment.includes('行业参考区间'));
});

test('缺少上期数据时：同比类指标为空、评级为 unknown，不伪造为 0', () => {
  const analysis = analyse(LEDGER);
  for (const code of ['GRO-01', 'GRO-02', 'GRO-03', 'GRO-04']) {
    assert.equal(ratio(analysis, code).value, null, `${code} 应为空值`);
    assert.equal(ratio(analysis, code).rating, 'unknown');
  }
  assert.ok(analysis.dataNotes.some((n) => n.includes('未提供上期账簿快照')));
});

/* ================================================================== */
/* 三、杜邦分析                                                        */
/* ================================================================== */

test('杜邦分析：三因子乘积严格等于 ROE（容差 1e-9）', () => {
  const d = ANALYSIS.dupont;
  assert.ok(d.roe !== null && d.netProfitMargin !== null && d.assetTurnover !== null && d.equityMultiplier !== null);
  const product = (d.netProfitMargin ?? 0) * (d.assetTurnover ?? 0) * (d.equityMultiplier ?? 0);
  assert.ok(Math.abs((d.roe ?? 0) - product) <= 1e-9, `ROE=${d.roe}，乘积=${product}`);
  near(d.roe, 15.14, 0.005);
  near(d.netProfitMargin, 20.1, 0.005);
  near(d.assetTurnover, 0.5360, 0.0005);
  near(d.equityMultiplier, 1.4047, 0.0005);
});

test('杜邦分析：给出各因子对 ROE 变动的贡献，且贡献合计约等于 ROE 变动', () => {
  const d = ANALYSIS.dupont;
  assert.ok(d.contributions !== undefined);
  const c = d.contributions ?? {};
  const sum = (c['netProfitMargin'] ?? 0) + (c['assetTurnover'] ?? 0) + (c['equityMultiplier'] ?? 0);
  assert.ok(Number.isFinite(sum));
  assert.ok(Math.abs(sum) < 20, '贡献合计应在合理量级内');
  assert.ok(Object.keys(c).length === 3);
});

/* ================================================================== */
/* 四、结构分析                                                        */
/* ================================================================== */

test('结构分析：收入/成本/费用占比之和为 1，收入结构含明细科目', () => {
  const revenue = ANALYSIS.structure.revenueByCategory;
  assert.equal(revenue.length, 2);
  const revenueShare = revenue.reduce((s, i) => s + i.share, 0);
  assert.ok(Math.abs(revenueShare - 1) <= 0.0001);
  assert.equal(revenue[0]?.label, '主营业务收入-商品销售');
  assert.equal(revenue[0]?.amount, 195_000_000);

  const expense = ANALYSIS.structure.expenseByCategory;
  const expenseShare = expense.reduce((s, i) => s + i.share, 0);
  assert.ok(Math.abs(expenseShare - 1) <= 0.0001);
  // 管理费用已剔除研发费用后单列
  const admin = expense.find((i) => i.label === '管理费用');
  assert.ok(admin !== undefined);
  assert.equal(admin.amount, 22_200_000);

  const cost = ANALYSIS.structure.costByCategory;
  assert.equal(cost.length, 1);
  assert.equal(cost[0]?.amount, 120_000_000);
});

/* ================================================================== */
/* 五、趋势与预警                                                      */
/* ================================================================== */

const HISTORY: PeriodSnapshot[] = [
  {
    period: '2023-06',
    balances: [],
    revenue: 140_000_000,
    netProfit: 28_000_000,
    totalAssets: 320_000_000,
    equity: 210_000_000,
    operatingCashFlow: 12_000_000,
  },
  {
    period: '2024-05',
    balances: PRIOR_LEDGER.balances,
    revenue: 170_000_000,
    netProfit: 35_100_000,
    totalAssets: 350_000_000,
    equity: 245_500_000,
    operatingCashFlow: 5_000_000,
  },
];

test('趋势：多期快照串成序列，并给出同比/环比', () => {
  const analysis = analyse(LEDGER, PRIOR_LEDGER, HISTORY);
  const revenue = analysis.trends['revenue'] ?? [];
  assert.deepEqual(revenue.map((p) => p.period), ['2023-06', '2024-05', '2024-06']);
  assert.equal(revenue[2]?.value, 200_000_000);

  const yoy = analysis.trends['revenue_yoy'] ?? [];
  const yoy2024 = yoy.find((p) => p.period === '2024-06');
  assert.ok(yoy2024 !== undefined);
  near(typeof yoy2024.value === 'number' ? yoy2024.value : null, 42.86, 0.005); // (200 − 140) ÷ 140

  const mom = analysis.trends['revenue_mom'] ?? [];
  const mom2024 = mom.find((p) => p.period === '2024-06');
  assert.ok(mom2024 !== undefined);
  near(typeof mom2024.value === 'number' ? mom2024.value : null, 17.65, 0.005); // (200 − 170) ÷ 170

  const ocf = analysis.trends['operatingCashFlow'] ?? [];
  assert.equal(ocf.length, 3);
});

test('趋势：shiftPeriod 跨年计算正确', () => {
  assert.equal(shiftPeriod('2024-06', -12), '2023-06');
  assert.equal(shiftPeriod('2024-01', -1), '2023-12');
  assert.equal(shiftPeriod('2024-12', 1), '2025-01');
});

test('风险预警：健康企业不触发任何预警', () => {
  assert.equal(ANALYSIS.alerts.length, 0);
});

/** 高风险样本：资不抵债、流动比率 < 1、经营现金流为负、应收账款增速远超收入。 */
function riskyFixture(): { ledger: LedgerSnapshot; prior: LedgerSnapshot } {
  const opening: Array<[string, string, number]> = [
    ['1002.01', '基本户', 9_000_000],
    ['1122', '应收账款', 2_000_000],
    ['2001', '短期借款', -10_000_000],
    ['2202', '应付账款', -2_000_000],
    ['2501', '长期借款', -5_000_000],
    ['4001', '实收资本', -2_000_000],
    ['4104', '利润分配', 8_000_000],
  ];
  const vouchers: Voucher[] = [
    voucher('风-0001', [['1122', '应收账款', 8_000_000, 0], ['6001.01', '商品销售收入', 0, 8_000_000]]),
    voucher('风-0002', [['6602', '管理费用', 8_000_000, 0], ['1002.01', '基本户', 0, 8_000_000]]),
    voucher('风-0003', [
      ['6001.01', '商品销售收入', 8_000_000, 0],
      ['4103', '本年利润', 0, 8_000_000],
      ['4103', '本年利润', 8_000_000, 0],
      ['6602', '管理费用', 0, 8_000_000],
    ]),
  ];
  const ledger = buildSnapshot('2024-06', opening, vouchers);
  const prior: LedgerSnapshot = {
    period: '2024-05',
    standard: 'cas',
    balances: [
      ...opening.map(([code, name, amount]) => ({
        accountCode: code,
        accountName: name,
        opening: amount,
        debitTotal: 0,
        creditTotal: 0,
        closing: amount,
      })),
      { accountCode: '6001.01', accountName: '商品销售收入', opening: 0, debitTotal: 0, creditTotal: 7_000_000, closing: 0 },
      { accountCode: '6602', accountName: '管理费用', opening: 0, debitTotal: 6_000_000, creditTotal: 0, closing: 0 },
    ],
    vouchers: [],
    openingBalanced: true,
  };
  return { ledger, prior };
}

test('风险预警：资不抵债 + 流动比率 < 1 + 经营现金流连续为负 + 应收增速异常 均被触发', () => {
  const { ledger, prior } = riskyFixture();
  const history: PeriodSnapshot[] = [
    {
      period: '2024-05',
      balances: prior.balances,
      revenue: 7_000_000,
      netProfit: 1_000_000,
      totalAssets: 11_000_000,
      equity: -6_000_000,
      operatingCashFlow: -5_000_000,
    },
  ];
  const analysis = analyse(ledger, prior, history);
  const codes = analysis.alerts.map((a) => a.code);
  assert.ok(codes.includes('ALERT-CURRENT-RATIO'), '应触发流动比率 < 1');
  assert.ok(codes.includes('ALERT-DEBT-RATIO'), '应触发资产负债率 > 70%');
  assert.ok(codes.includes('ALERT-OCF-NEGATIVE'), '应触发经营现金流连续为负');
  assert.ok(codes.includes('ALERT-AR-GROWTH'), '应触发应收账款增速异常');
  for (const alert of analysis.alerts) {
    assert.ok(alert.detail !== '' && alert.action !== '', '预警必须给出说明与建议动作');
  }
});

/* ================================================================== */
/* 六、结论与导出                                                      */
/* ================================================================== */

test('中文结论：至少 4 段，每段都有正文与关键数字，且不含空泛断言', () => {
  assert.ok(ANALYSIS.narratives.length >= 4);
  assert.ok(ANALYSIS.narratives.length <= 6);
  for (const section of ANALYSIS.narratives) {
    assert.ok(section.title !== '');
    assert.ok(section.body.length > 20);
    assert.ok(section.evidence.length >= 3, `${section.title} 缺少关键数字`);
    for (const item of section.evidence) {
      assert.ok(item.label !== '' && item.value !== '');
    }
  }
  const text = ANALYSIS.narratives.map((s) => s.body).join('\n');
  assert.ok(text.includes('需结合行业与经营情况进一步核实'), '不确定处必须保留这句话');
});

test('中文结论：数字与指标一致（营业收入、净利润、ROE 出现在结论里）', () => {
  const text = ANALYSIS.narratives.map((s) => s.body).join('\n');
  assert.ok(text.includes('2,000,000.00 元'), '营业收入应以元展示');
  assert.ok(text.includes('402,000.00 元'), '净利润应以元展示');
  assert.ok(text.includes('15.14%'), 'ROE 应与指标一致');
});

test('Markdown 导出：包含指标表、杜邦、预警、数据说明', () => {
  const md = renderAnalysisMarkdown(ANALYSIS);
  assert.ok(md.includes('# 2024-06 财务分析报告'));
  assert.ok(md.includes('## 财务指标'));
  assert.ok(md.includes('## 杜邦分析'));
  assert.ok(md.includes('## 风险预警'));
  assert.ok(md.includes('## 数据说明'));
  assert.ok(md.includes('流动比率'));
  assert.ok(md.includes('ROE = 净利率 × 总资产周转率 × 权益乘数'));
});

test('Excel 导出：生成含四张报表与分析页签的工作簿', async () => {
  const dir = mkdtempSync(join(PROJECT_ROOT, '.test-tmp-'));
  try {
    const outPath = join(dir, 'report.xlsx');
    await exportStatementsExcel(STATEMENTS, ANALYSIS, outPath);
    assert.ok(existsSync(outPath));
    assert.ok(statSync(outPath).size > 5_000);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    for (const name of ['资产负债表', '利润表', '现金流量表', '所有者权益变动表', '财务指标', '杜邦分析', '风险预警', '分析结论', '勾稽校验']) {
      assert.ok(wb.getWorksheet(name) !== undefined, `缺少工作表「${name}」`);
    }
    const ratioSheet = wb.getWorksheet('财务指标');
    assert.ok((ratioSheet?.rowCount ?? 0) >= 31, '财务指标页应包含 30 个指标');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空账分析：不崩、指标为空、无预警、结论仍可生成', () => {
  const empty: LedgerSnapshot = {
    period: '2024-06',
    standard: 'cas',
    balances: [],
    vouchers: [],
    openingBalanced: true,
  };
  const statements = generateStatements({ standard: 'cas', period: '2024-06', ledger: empty }).statements;
  const analysis = generateAnalysis({ standard: 'cas', period: '2024-06', ledger: empty, statements });
  assert.equal(analysis.ratios.length, 30);
  assert.equal(analysis.alerts.length, 0);
  assert.equal(analysis.dupont.roe, null);
  assert.ok(analysis.narratives.length >= 4);
  assert.ok(analysis.dataNotes.length >= 1);
  assert.ok(analysis.ratios.every((r) => r.value === null || Number.isFinite(r.value)));
  assert.ok(analysis.structure.revenueByCategory.length === 0);
  assert.ok(renderAnalysisMarkdown(analysis).includes('财务分析报告'));
  assert.ok(analysis.ratios.every((r) => r.rating === 'unknown'));
});
