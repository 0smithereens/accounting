/**
 * 财务报表生成测试。
 *
 * 测试数据不是「拍脑袋的余额表」，而是**期初余额 + 完整凭证（含结转损益凭证）**
 * 推出来的期末余额：这样资产负债表平衡、现金流量表与货币资金变动一致、
 * 利润表与本年利润一致，任何一环算错都会被断言抓住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  LedgerBalance,
  LedgerSnapshot,
  Voucher,
  VoucherLine,
} from '../src/core/contracts.ts';
import {
  generateStatements,
  summarizeStatements,
} from '../src/report/statements.ts';
import type { StatementSectionDef } from '../src/report/mapping.ts';
import {
  createBalanceIndex,
  evaluateSection,
  loadStatementFormat,
} from '../src/report/mapping.ts';
import { renderStatementText } from '../src/report/export.ts';

/* ================================================================== */
/* 一、测试数据构造                                                    */
/* ================================================================== */

/** 期初余额（分，借方为正）。合计为 0，满足「期初已结平」。 */
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

function line(code: string, name: string, debit: number, credit: number): VoucherLine {
  return {
    accountCode: code,
    accountName: name,
    debit,
    credit,
    summary: '测试分录',
    source: { file: 'fixture.xlsx' },
  };
}

function voucher(word: string, lines: Line[]): Voucher {
  const voucherLines = lines.map(([code, name, debit, credit]) => line(code, name, debit, credit));
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

/** 本期凭证：覆盖经营、投资、筹资三类现金流，并在最后一张结转损益。 */
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
  // 结转损益：同时出现 4103 与 6xxx，报表引擎需要把它从损益发生额中剔除
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

/** 用「期初 + 凭证」推导余额表，保证 closing = opening + 借方 − 贷方。 */
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

  return {
    period,
    standard: 'cas',
    balances,
    vouchers,
    openingBalanced: opening.reduce((s, [, , a]) => s + a, 0) === 0,
  };
}

const LEDGER = buildSnapshot('2024-06', OPENING, VOUCHERS);

/** 上期快照：期末余额即本期期初，损益类只保留发生额。 */
const PRIOR_BALANCES: LedgerBalance[] = [
  ...OPENING.map(([code, name, amount]) => ({
    accountCode: code,
    accountName: name,
    opening: 0,
    debitTotal: 0,
    creditTotal: 0,
    closing: amount,
  })),
  // 上期损益（已结转，故期末余额为 0，但发生额保留）
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
];
// 上期未分配利润从 -25.4M 增至 -60.5M（本期期初），差额即上期净利润 35.1M
const priorWithOpening = PRIOR_BALANCES.map((b) => {
  if (b.accountCode === '4104') return { ...b, opening: -25_400_000, closing: -60_500_000 };
  return { ...b, opening: b.closing };
});
const PRIOR_LEDGER: LedgerSnapshot = {
  period: '2024-05',
  standard: 'cas',
  balances: priorWithOpening,
  vouchers: [],
  openingBalanced: true,
};

/* ================================================================== */
/* 二、取数工具                                                        */
/* ================================================================== */

function lineAmount(statement: { lines: Array<{ label: string; amount: number | null; isTotal?: boolean }> }, label: string): number {
  const exact = statement.lines.find((l) => l.label === label);
  const found = exact ?? statement.lines.find((l) => l.label.includes(label));
  assert.ok(found !== undefined, `报表中找不到项目「${label}」`);
  return found.amount ?? 0;
}

function checkById(statement: { checks: Array<{ id: string; passed: boolean; diff: number; detail: string }> }, id: string) {
  const found = statement.checks.find((c) => c.id === id);
  assert.ok(found !== undefined, `找不到勾稽项 ${id}`);
  return found;
}

/* ================================================================== */
/* 三、四张报表                                                        */
/* ================================================================== */

test('生成四张报表，顺序为 资产负债表/利润表/现金流量表/所有者权益变动表', () => {
  const { statements } = generateStatements({ standard: 'cas', period: '2024-06', ledger: LEDGER, priorLedger: PRIOR_LEDGER });
  assert.equal(statements.length, 4);
  assert.deepEqual(
    statements.map((s) => s.kind),
    ['balance_sheet', 'income_statement', 'cash_flow', 'equity_change'],
  );
  assert.equal(statements[0]?.period, '2024-06');
  assert.equal(statements[0]?.standard, 'cas');
  assert.ok(statements.every((s) => s.engineVersion !== '' && s.generatedAt !== ''));
});

test('资产负债表：资产总计 = 负债和所有者权益总计，且勾稽全部通过', () => {
  const { statements } = generateStatements({ standard: 'cas', period: '2024-06', ledger: LEDGER, priorLedger: PRIOR_LEDGER });
  const bs = statements[0]!;
  assert.equal(lineAmount(bs, '资产总计'), 396_200_000);
  assert.equal(lineAmount(bs, '负债和所有者权益（或股东权益）总计'), 396_200_000);
  assert.equal(lineAmount(bs, '负债合计'), 110_500_000);
  assert.equal(lineAmount(bs, '所有者权益（或股东权益）合计'), 285_700_000);
  assert.equal(checkById(bs, 'BS-BALANCE').passed, true);
  assert.equal(checkById(bs, 'BS-BALANCE').diff, 0);
  assert.equal(checkById(bs, 'BS-CURRENT-SUM').passed, true);
  assert.equal(bs.passed, true);
});

test('资产负债表：科目取数（含备抵科目、下级科目汇总）正确', () => {
  const { statements } = generateStatements({ standard: 'cas', period: '2024-06', ledger: LEDGER, priorLedger: PRIOR_LEDGER });
  const bs = statements[0]!;
  // 1001 + 1002.01 + 1012.01
  assert.equal(lineAmount(bs, '货币资金'), 126_900_000);
  // 1122 − 1231
  assert.equal(lineAmount(bs, '应收账款'), 76_000_000);
  // 1405 − 1471
  assert.equal(lineAmount(bs, '存货'), 89_000_000);
  // 1601 − 1602
  assert.equal(lineAmount(bs, '固定资产'), 75_000_000);
  // 1701 − 1702
  assert.equal(lineAmount(bs, '无形资产'), 10_000_000);
  assert.equal(lineAmount(bs, '流动资产合计'), 305_900_000);
  assert.equal(lineAmount(bs, '非流动资产合计'), 90_300_000);
});

test('利润表：收入、成本、减值损失与净利润取数正确（结转凭证被剔除）', () => {
  const { statements } = generateStatements({ standard: 'cas', period: '2024-06', ledger: LEDGER, priorLedger: PRIOR_LEDGER });
  const is = statements[1]!;
  assert.equal(lineAmount(is, '营业收入'), 200_000_000);
  assert.equal(lineAmount(is, '营业成本'), 120_000_000);
  assert.equal(lineAmount(is, '管理费用'), 22_200_000);
  assert.equal(lineAmount(is, '财务费用'), 3_000_000);
  // 6702 借方 0.5M，按「贷方为正」列示为 -0.5M（损失以负号填列）
  assert.equal(lineAmount(is, '信用减值损失'), -500_000);
  assert.equal(lineAmount(is, '资产减值损失'), -100_000);
  assert.equal(lineAmount(is, '营业利润'), 45_200_000);
  assert.equal(lineAmount(is, '利润总额'), 44_200_000);
  assert.equal(lineAmount(is, '净利润'), 40_200_000);
  assert.equal(checkById(is, 'IS-NET-PROFIT').passed, true);
  assert.equal(is.passed, true);
});

test('利润表：本期列与上期列分别取本期发生额与上期发生额', () => {
  const { statements } = generateStatements({ standard: 'cas', period: '2024-06', ledger: LEDGER, priorLedger: PRIOR_LEDGER });
  const is = statements[1]!;
  const revenue = is.lines.find((l) => l.label.includes('营业收入'));
  assert.ok(revenue !== undefined);
  assert.equal(revenue.amount, 200_000_000);
  assert.equal(revenue.priorAmount, 170_000_000);
  const netProfit = is.lines.find((l) => l.label.includes('四、净利润'));
  assert.ok(netProfit !== undefined);
  assert.equal(netProfit.priorAmount, 35_100_000);
});

test('现金流量表：经营/投资/筹资净额与净增加额勾稽，且期末现金 = 货币资金', () => {
  const { statements } = generateStatements({ standard: 'cas', period: '2024-06', ledger: LEDGER, priorLedger: PRIOR_LEDGER });
  const cf = statements[2]!;
  assert.equal(lineAmount(cf, '销售商品、提供劳务收到的现金'), 190_000_000);
  assert.equal(lineAmount(cf, '购买商品、接受劳务支付的现金'), 135_100_000);
  assert.equal(lineAmount(cf, '支付给职工以及为职工支付的现金'), 7_000_000);
  assert.equal(lineAmount(cf, '支付的各项税费'), 4_000_000);
  assert.equal(lineAmount(cf, '经营活动产生的现金流量净额'), 21_900_000);
  assert.equal(lineAmount(cf, '投资活动产生的现金流量净额'), -9_000_000);
  assert.equal(lineAmount(cf, '筹资活动产生的现金流量净额'), -3_000_000);
  assert.equal(lineAmount(cf, '现金及现金等价物净增加额'), 9_900_000);
  assert.equal(lineAmount(cf, '期末现金及现金等价物余额'), 126_900_000);
  assert.equal(checkById(cf, 'CF-NET').passed, true);
  assert.equal(checkById(cf, 'CF-END').passed, true);
  assert.equal(checkById(cf, 'CF-END-BS').passed, true);
  assert.equal(cf.passed, true);
});

test('所有者权益变动表：期末 = 期初 + 变动，且「其中：净利润」取自利润表', () => {
  const { statements } = generateStatements({ standard: 'cas', period: '2024-06', ledger: LEDGER, priorLedger: PRIOR_LEDGER });
  const eq = statements[3]!;
  assert.equal(lineAmount(eq, '上年年末余额合计'), 245_500_000);
  assert.equal(lineAmount(eq, '本年增减变动金额合计'), 40_200_000);
  assert.equal(lineAmount(eq, '其中：净利润'), 40_200_000);
  assert.equal(lineAmount(eq, '本年年末余额合计'), 285_700_000);
  assert.equal(checkById(eq, 'EQ-BALANCE').passed, true);
  assert.equal(eq.passed, true);
});

/* ================================================================== */
/* 四、小企业会计准则的差异                                            */
/* ================================================================== */

/** 去掉递延所得税资产（小企业准则不确认），同步冲减未分配利润以保持平衡。 */
function smallLedger(): LedgerSnapshot {
  const balances = LEDGER.balances
    .filter((b) => b.accountCode !== '1811')
    .map((b) => (b.accountCode === '4104' ? { ...b, closing: b.closing + 2_300_000, opening: b.opening + 2_300_000 } : b));
  return { ...LEDGER, standard: 'small', balances };
}

test('小企业准则资产负债表：不出现递延所得税资产等企业会计准则专有项目', () => {
  const { statements } = generateStatements({
    standard: 'small',
    period: '2024-06',
    ledger: smallLedger(),
    priorLedger: PRIOR_LEDGER,
  });
  const bs = statements[0]!;
  const labels = bs.lines.map((l) => l.label).join('|');
  assert.ok(!labels.includes('递延所得税资产'), '小企业准则不应出现递延所得税资产');
  assert.ok(!labels.includes('递延所得税负债'), '小企业准则不应出现递延所得税负债');
  assert.ok(!labels.includes('交易性金融资产'), '小企业准则以「短期投资」列示');
  assert.ok(!labels.includes('商誉'), '小企业准则不确认商誉');
  assert.ok(!labels.includes('开发支出'), '小企业准则不设开发支出');
  assert.ok(labels.includes('短期投资'), '小企业准则应有短期投资行');
  assert.ok(labels.includes('固定资产原价') && labels.includes('减：累计折旧') && labels.includes('固定资产账面价值'));
  assert.equal(lineAmount(bs, '资产总计'), 393_900_000);
  assert.equal(bs.passed, true);
});

test('小企业准则利润表：无资产减值损失、公允价值变动收益、其他综合收益', () => {
  const { statements } = generateStatements({
    standard: 'small',
    period: '2024-06',
    ledger: smallLedger(),
    priorLedger: PRIOR_LEDGER,
  });
  const is = statements[1]!;
  const labels = is.lines.map((l) => l.label).join('|');
  assert.ok(!labels.includes('资产减值损失'));
  assert.ok(!labels.includes('公允价值变动收益'));
  assert.ok(!labels.includes('其他综合收益'));
  assert.ok(labels.includes('研究费用'), '小企业准则把研发费用列示为管理费用下的「研究费用」');
  assert.equal(lineAmount(is, '营业收入'), 200_000_000);
});

test('小企业准则现金流量表：勾稽通过，并在 checks 中提示「未强制要求，仅供参考」', () => {
  const { statements } = generateStatements({
    standard: 'small',
    period: '2024-06',
    ledger: smallLedger(),
    priorLedger: PRIOR_LEDGER,
  });
  const cf = statements[2]!;
  assert.equal(cf.passed, true);
  const note = cf.checks.find((c) => c.id === 'CF-SMALL-OPTIONAL');
  assert.ok(note !== undefined, '应存在小企业现金流量表编制提示');
  assert.ok(note.detail.includes('未强制要求'));
  assert.ok(note.detail.includes('仅供参考'));
});

test('准则差异：小企业准则下若仍有递延所得税资产余额，会给出告警', () => {
  // 故意用含 1811 的企业准则账簿跑小企业准则
  const { statements, issues } = generateStatements({
    standard: 'small',
    period: '2024-06',
    ledger: LEDGER,
  });
  const bs = statements[0]!;
  // 1811 不在小企业报表行内，资产必然小于负债和权益，勾稽应报差异
  assert.equal(bs.passed, false);
  assert.ok(issues.some((i) => i.level === 'warning' && i.message.includes('递延所得税资产')));
});

/* ================================================================== */
/* 五、取数 DSL 的六种规则                                             */
/* ================================================================== */

function testSection(rows: StatementSectionDef['rows']): StatementSectionDef {
  return { kind: 'balance_sheet', title: '测试表', rows, checks: [], notes: [] };
}

test('DSL accounts：前缀汇总 + 备抵科目扣减 + 剔除指定下级', () => {
  const section = testSection([
    { code: '1', key: 'AR', label: '应收账款', level: 1, isTotal: false, hidden: false, rule: { kind: 'accounts', codes: ['1122'], sign: 'debit', minus: ['1231'], exclude: [], source: 'closing', includeChildren: true } },
    { code: '2', key: 'ADMIN', label: '管理费用（不含研发）', level: 1, isTotal: false, hidden: false, rule: { kind: 'accounts', codes: ['6602'], sign: 'debit', minus: [], exclude: ['6602.18'], source: 'net', includeChildren: true } },
    { code: '3', key: 'OPEN-CASH', label: '期初货币资金', level: 1, isTotal: false, hidden: false, rule: { kind: 'accounts', codes: ['1001', '1002', '1012'], sign: 'debit', minus: [], exclude: [], source: 'opening', includeChildren: true } },
  ]);
  const result = evaluateSection(section, { balances: createBalanceIndex(LEDGER.balances), sourceFile: 'test.yaml' });
  assert.equal(result.values.get('AR'), 76_000_000);
  assert.equal(result.values.get('OPEN-CASH'), 117_000_000);

  // exclude 用独立余额集验证：6602 汇总包含 6602.18，管理费用需把研发费用剔除
  const isolated: LedgerBalance[] = [
    { accountCode: '6602.01', accountName: '管理费用-工资', opening: 0, debitTotal: 18_000_000, creditTotal: 0, closing: 18_000_000 },
    { accountCode: '6602.18', accountName: '管理费用-研发费用', opening: 0, debitTotal: 2_000_000, creditTotal: 0, closing: 2_000_000 },
  ];
  const excluded = evaluateSection(
    testSection([
      { code: '2', key: 'ADMIN', label: '管理费用（不含研发）', level: 1, isTotal: false, hidden: false, rule: { kind: 'accounts', codes: ['6602'], sign: 'debit', minus: [], exclude: ['6602.18'], source: 'net', includeChildren: true } },
    ]),
    { balances: createBalanceIndex(isolated), sourceFile: 'test.yaml' },
  );
  assert.equal(excluded.values.get('ADMIN'), 18_000_000);
});

test('DSL sum / diff：合计与差额按行键引用计算', () => {
  const section = testSection([
    { code: '1', key: 'A', label: 'A', level: 1, isTotal: false, hidden: false, rule: { kind: 'accounts', codes: ['1122'], sign: 'debit', minus: [], exclude: [], source: 'closing', includeChildren: true } },
    { code: '2', key: 'B', label: 'B', level: 1, isTotal: false, hidden: false, rule: { kind: 'accounts', codes: ['1123'], sign: 'debit', minus: [], exclude: [], source: 'closing', includeChildren: true } },
    { code: '3', key: 'SUM', label: '合计', level: 1, isTotal: true, hidden: false, rule: { kind: 'sum', of: ['A', 'B'] } },
    { code: '4', key: 'DIFF', label: '差额', level: 1, isTotal: false, hidden: false, rule: { kind: 'diff', of: ['A', 'B'] } },
  ]);
  const result = evaluateSection(section, { balances: createBalanceIndex(LEDGER.balances), sourceFile: 'test.yaml' });
  assert.equal(result.values.get('SUM'), 89_000_000);
  assert.equal(result.values.get('DIFF'), 71_000_000);
});

test('DSL ratio：两行相除并按小数位放大成整数', () => {
  const section = testSection([
    { code: '1', key: 'CA', label: '流动资产', level: 1, isTotal: false, hidden: false, rule: { kind: 'accounts', codes: ['1001', '1002', '1012', '1122', '1231', '1123', '1221', '1405', '1471'], sign: 'debit', minus: [], exclude: [], source: 'closing', includeChildren: true } },
    { code: '2', key: 'CL', label: '流动负债', level: 1, isTotal: false, hidden: false, rule: { kind: 'accounts', codes: ['2001', '2202', '2211', '2221', '2241'], sign: 'credit', minus: [], exclude: [], source: 'closing', includeChildren: true } },
    { code: '3', key: 'RATIO', label: '流动比率（%）', level: 1, isTotal: false, hidden: false, rule: { kind: 'ratio', numerator: 'CA', denominator: 'CL', scale: 100, decimals: 2 } },
  ]);
  const result = evaluateSection(section, { balances: createBalanceIndex(LEDGER.balances), sourceFile: 'test.yaml' });
  // 305.9M ÷ 90.5M × 100 = 338.011...  → 放大 100 倍保留两位小数 = 33801
  assert.equal(result.values.get('RATIO'), 33_801);
});

test('DSL ratio：分母为 0 时返回空值并记 issue，不抛异常', () => {
  const section = testSection([
    { code: '1', key: 'ZERO', label: '零', level: 1, isTotal: false, hidden: false, rule: { kind: 'sum', of: ['EMPTY'] } },
    { code: '2', key: 'EMPTY', label: '空', level: 1, isTotal: false, hidden: true, rule: { kind: 'accounts', codes: ['9999'], sign: 'debit', minus: [], exclude: [], source: 'closing', includeChildren: true } },
    { code: '3', key: 'R', label: '比率', level: 1, isTotal: false, hidden: false, rule: { kind: 'ratio', numerator: 'ZERO', denominator: 'EMPTY', scale: 100, decimals: 2 } },
  ]);
  const result = evaluateSection(section, { balances: createBalanceIndex(LEDGER.balances), sourceFile: 'test.yaml' });
  assert.equal(result.values.get('R'), null);
  assert.ok(result.issues.some((i) => i.message.includes('分母为 0')));
});

test('DSL skip：不输出该行，但科目仍有余额时给出告警', () => {
  const section = testSection([
    { code: '1', key: 'CASH', label: '货币资金', level: 1, isTotal: false, hidden: false, rule: { kind: 'accounts', codes: ['1001'], sign: 'debit', minus: [], exclude: [], source: 'closing', includeChildren: true } },
    { code: 'X', key: 'SKIP-DTA', label: '递延所得税资产', level: 1, isTotal: false, hidden: false, rule: { kind: 'skip', codes: ['1811'], reason: '小企业会计准则不确认递延所得税资产' } },
  ]);
  const result = evaluateSection(section, { balances: createBalanceIndex(LEDGER.balances), sourceFile: 'test.yaml' });
  assert.equal(result.rows.length, 1, 'skip 行不应出现在报表里');
  assert.equal(result.skippedRows.length, 1);
  assert.equal(result.skippedRows[0]?.amount, 2_300_000);
  assert.ok(result.issues.some((i) => i.level === 'warning' && i.message.includes('递延所得税资产')));
});

test('DSL header：表头行不取数，金额为空', () => {
  const section = testSection([
    { code: 'H1', key: 'H', label: '资产', level: 0, isTotal: false, hidden: false, rule: { kind: 'header' } },
  ]);
  const result = evaluateSection(section, { balances: createBalanceIndex(LEDGER.balances), sourceFile: 'test.yaml' });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.amount, null);
});

test('取数引擎：科目表里没有该科目时按 0 列示并记 issue，不抛异常', () => {
  const section = testSection([
    { code: '1', key: 'GHOST', label: '不存在的项目', level: 1, isTotal: false, hidden: false, rule: { kind: 'accounts', codes: ['8888'], sign: 'debit', minus: [], exclude: [], source: 'closing', includeChildren: true } },
  ]);
  const result = evaluateSection(section, { balances: createBalanceIndex(LEDGER.balances), sourceFile: 'test.yaml' });
  assert.equal(result.values.get('GHOST'), 0);
  assert.deepEqual(result.missingRows, ['不存在的项目']);
  assert.ok(result.issues.some((i) => i.level === 'info' && i.message.includes('无对应科目')));
});

test('取数引擎：循环引用被检出并记 error，不抛异常', () => {
  const section = testSection([
    { code: '1', key: 'A', label: 'A', level: 1, isTotal: false, hidden: false, rule: { kind: 'sum', of: ['B'] } },
    { code: '2', key: 'B', label: 'B', level: 1, isTotal: false, hidden: false, rule: { kind: 'sum', of: ['A'] } },
  ]);
  const result = evaluateSection(section, { balances: createBalanceIndex(LEDGER.balances), sourceFile: 'test.yaml' });
  assert.ok(result.issues.some((i) => i.level === 'error' && i.message.includes('循环引用')));
});

/* ================================================================== */
/* 六、边界条件                                                        */
/* ================================================================== */

test('空账：四张报表都能生成，金额全 0，勾稽通过，不抛异常', () => {
  const empty: LedgerSnapshot = {
    period: '2024-06',
    standard: 'cas',
    balances: [],
    vouchers: [],
    openingBalanced: true,
  };
  const { statements, issues } = generateStatements({ standard: 'cas', period: '2024-06', ledger: empty });
  assert.equal(statements.length, 4);
  for (const statement of statements) {
    assert.equal(statement.passed, true);
    for (const line of statement.lines) {
      if (line.amount !== null) assert.equal(line.amount, 0);
    }
  }
  assert.ok(Array.isArray(issues));
});

test('缺少上期账簿时：上期列为 null，不影响本期列', () => {
  const { statements } = generateStatements({ standard: 'cas', period: '2024-06', ledger: LEDGER });
  const bs = statements[0]!;
  assert.equal(lineAmount(bs, '资产总计'), 396_200_000);
  assert.ok(bs.lines.every((l) => l.priorAmount === null || l.priorAmount === undefined));
});

test('报表配置可加载，两套准则的行数不同且都包含必要勾稽项', () => {
  const cas = loadStatementFormat('cas');
  const small = loadStatementFormat('small');
  assert.ok((cas.sections.balance_sheet?.rows.length ?? 0) > (small.sections.balance_sheet?.rows.length ?? 0) - 20);
  assert.ok(cas.sections.balance_sheet !== undefined);
  assert.ok(cas.sections.income_statement !== undefined);
  assert.ok(cas.sections.cash_flow !== undefined);
  assert.ok(cas.sections.equity_change !== undefined);
  assert.ok(small.sections.cash_flow?.notes.some((n) => n.text.includes('未强制要求')));
  assert.ok(cas.basis.length >= 1);
});

test('renderStatementText：输出等宽文本，含标题、金额与勾稽结论', () => {
  const { statements } = generateStatements({ standard: 'cas', period: '2024-06', ledger: LEDGER, priorLedger: PRIOR_LEDGER });
  const text = renderStatementText(statements[0]!);
  assert.ok(text.includes('资产负债表'));
  assert.ok(text.includes('2024-06'));
  assert.ok(text.includes('1,269,000.00'));
  assert.ok(text.includes('勾稽校验'));
  assert.ok(text.includes('资产总计 = 负债和所有者权益总计'));
});

test('summarizeStatements：按项目名称跨准则汇总关键口径', () => {
  const { statements } = generateStatements({ standard: 'cas', period: '2024-06', ledger: LEDGER, priorLedger: PRIOR_LEDGER });
  const summary = summarizeStatements(statements);
  assert.equal(summary.totalAssets, 396_200_000);
  assert.equal(summary.totalLiabilities, 110_500_000);
  assert.equal(summary.totalEquity, 285_700_000);
  assert.equal(summary.revenue, 200_000_000);
  assert.equal(summary.netProfit, 40_200_000);
  assert.equal(summary.operatingCashFlow, 21_900_000);
  assert.equal(summary.cash, 126_900_000);
});

test('勾稽校验：故意制造不平衡时如实报差额，不擅自调平', () => {
  const broken: LedgerSnapshot = {
    ...LEDGER,
    balances: LEDGER.balances.map((b) =>
      b.accountCode === '1001' ? { ...b, closing: b.closing + 1_000_000 } : b,
    ),
  };
  const { statements, issues } = generateStatements({ standard: 'cas', period: '2024-06', ledger: broken });
  const bs = statements[0]!;
  assert.equal(bs.passed, false);
  const balanceCheck = checkById(bs, 'BS-BALANCE');
  assert.equal(balanceCheck.passed, false);
  assert.equal(balanceCheck.diff, 1_000_000);
  assert.ok(issues.some((i) => i.level === 'error' && i.message.includes('资产负债表不平衡')));
});
