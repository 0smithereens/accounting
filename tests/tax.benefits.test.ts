/**
 * 税收优惠匹配、印花税与统一编排的单元测试。
 *
 * 覆盖：优惠命中/不命中、印花税各税目、申报表草稿状态与指纹、
 * 端到端一次算出全部税种。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { LedgerSnapshot, TaxLine } from '../src/core/contracts.ts';
import type { TaxpayerProfile } from '../src/tax/index.ts';
import {
  computePayloadHash,
  computeStampDuty,
  computeTaxes,
  createDraftReturn,
  eligibleBenefits,
  findReturn,
  matchBenefits,
  resolvePayable,
  totalEstimatedBenefit,
  withPrepayment,
} from '../src/tax/index.ts';

const SMALL_TAXPAYER: TaxpayerProfile = {
  id: '91310000TEST0001X',
  name: '示例科技有限公司',
  kind: 'small_scale',
  cityTaxRate: 0.07,
  industry: '软件和信息技术服务业',
  employees: 20,
  totalAssets: 500_000_000,
  isHighTech: false,
  isSmallLowProfit: true,
  rdExpense: 0,
  region: '上海',
};

const GENERAL_TAXPAYER: TaxpayerProfile = {
  ...SMALL_TAXPAYER,
  id: '91310000TEST0002X',
  kind: 'general',
  isSmallLowProfit: false,
};

const FINANCIALS = {
  revenue: 100_000_000,
  profit: 50_000_000,
  rdExpense: 0,
  vatPayable: 0,
};

/* ------------------------------------------------------------------ */
/* 优惠匹配                                                            */
/* ------------------------------------------------------------------ */

describe('税收优惠 · 匹配', () => {
  it('小型微利企业命中，预计减免 = 法定税额 - 5% 税额', () => {
    const matches = matchBenefits(SMALL_TAXPAYER, FINANCIALS, { period: '2024-06' });
    const hit = matches.find((m) => m.policyId === 'cit-small-low-profit');
    assert.ok(hit);
    assert.equal(hit.eligible, true);
    assert.equal(hit.estimatedBenefit, 10_000_000, '12,500,000 - 2,500,000');
    assert.equal(hit.basis.length > 0, true);
    assert.equal(hit.manualChecks.length > 0, true);
  });

  it('利润超过 300 万元时不命中，并说明原因', () => {
    const matches = matchBenefits(
      SMALL_TAXPAYER,
      { ...FINANCIALS, profit: 400_000_000 },
      { period: '2024-06' },
    );
    const miss = matches.find((m) => m.policyId === 'cit-small-low-profit');
    assert.ok(miss);
    assert.equal(miss.eligible, false);
    assert.equal(miss.estimatedBenefit, 0);
    assert.ok(miss.reasons.some((r) => r.includes('超过') && r.includes('上限')));
  });

  it('小规模纳税人命中增值税减免，减免 = 2 倍的 1% 税额', () => {
    const matches = matchBenefits(
      SMALL_TAXPAYER,
      { ...FINANCIALS, vatPayable: 100_000 },
      { period: '2024-06' },
    );
    const hit = matches.find((m) => m.policyId === 'vat-small-scale-reduction');
    assert.ok(hit);
    assert.equal(hit.eligible, true);
    assert.equal(hit.estimatedBenefit, 200_000);
  });

  it('一般纳税人不命中增值税小规模减免', () => {
    const matches = matchBenefits(GENERAL_TAXPAYER, FINANCIALS, { period: '2024-06' });
    const miss = matches.find((m) => m.policyId === 'vat-small-scale-reduction');
    assert.ok(miss);
    assert.equal(miss.eligible, false);
    assert.ok(miss.reasons.some((r) => r.includes('一般纳税人')));
  });

  it('六税两费减半：按实缴增值税与附加税费率折算', () => {
    const matches = matchBenefits(
      SMALL_TAXPAYER,
      { ...FINANCIALS, vatPayable: 1_000_000 },
      { period: '2024-06' },
    );
    const hit = matches.find((m) => m.policyId === 'surcharge-six-taxes-half');
    assert.ok(hit);
    assert.equal(hit.eligible, true);
    assert.equal(hit.estimatedBenefit, 60_000, '1,000,000 × 12% × 50%');
  });

  it('研发费用加计扣除按适用税率折算减免', () => {
    const matches = matchBenefits(
      GENERAL_TAXPAYER,
      { ...FINANCIALS, profit: 10_000_000, rdExpense: 10_000_000 },
      { period: '2024-06' },
    );
    const hit = matches.find((m) => m.policyId === 'cit-rd-super-deduction');
    assert.ok(hit);
    assert.equal(hit.eligible, true);
    assert.equal(hit.estimatedBenefit, 2_500_000, '10,000,000 × 100% × 25%');
  });

  it('无研发投入时不命中研发加计', () => {
    const matches = matchBenefits(GENERAL_TAXPAYER, FINANCIALS, { period: '2024-06' });
    const miss = matches.find((m) => m.policyId === 'cit-rd-super-deduction');
    assert.ok(miss);
    assert.equal(miss.eligible, false);
  });

  it('高新技术企业 15%：减免 = 10% 的应纳税所得额', () => {
    const highTech: TaxpayerProfile = { ...GENERAL_TAXPAYER, isHighTech: true };
    const matches = matchBenefits(highTech, { ...FINANCIALS, profit: 10_000_000 }, { period: '2024-06' });
    const hit = matches.find((m) => m.policyId === 'cit-high-tech');
    assert.ok(hit);
    assert.equal(hit.eligible, true);
    assert.equal(hit.estimatedBenefit, 1_000_000);
  });

  it('未标记高新资质时不命中', () => {
    const matches = matchBenefits(GENERAL_TAXPAYER, FINANCIALS, { period: '2024-06' });
    const miss = matches.find((m) => m.policyId === 'cit-high-tech');
    assert.ok(miss);
    assert.equal(miss.eligible, false);
  });

  it('政策窗口外（2028 年）全部不命中', () => {
    const matches = matchBenefits(SMALL_TAXPAYER, FINANCIALS, { period: '2028-06' });
    const hit = matches.find((m) => m.policyId === 'cit-small-low-profit');
    assert.ok(hit);
    assert.equal(hit.eligible, false);
    assert.ok(hit.reasons.some((r) => r.includes('政策窗口')));
  });

  it('可享受的优惠排在前面，并汇总预计减免总额', () => {
    const matches = matchBenefits(
      SMALL_TAXPAYER,
      { ...FINANCIALS, vatPayable: 100_000 },
      { period: '2024-06' },
    );
    const eligible = eligibleBenefits(matches);
    assert.equal(matches[0]?.eligible, true, '命中项应排在首位');
    assert.equal(eligible.every((m) => m.eligible), true);
    assert.ok(totalEstimatedBenefit(matches) >= 10_000_000);
  });
});

/* ------------------------------------------------------------------ */
/* 印花税                                                              */
/* ------------------------------------------------------------------ */

describe('印花税', () => {
  it('六个税目分别适用各自税率', () => {
    const result = computeStampDuty({
      period: '2024-06',
      items: [
        { type: 'sale', amount: 10_000_000 },
        { type: 'loan', amount: 10_000_000 },
        { type: 'lease', amount: 10_000_000 },
        { type: 'property_transfer', amount: 10_000_000 },
        { type: 'account_book', amount: 10_000_000 },
        { type: 'securities', amount: 10_000_000 },
      ],
      smallScale: false,
      smallLowProfit: false,
    });

    assert.equal(result.byType.length, 6);
    assert.equal(result.byType.find((t) => t.type === 'sale')?.tax, 3_000, '0.3‰');
    assert.equal(result.byType.find((t) => t.type === 'loan')?.tax, 500, '0.05‰');
    assert.equal(result.byType.find((t) => t.type === 'lease')?.tax, 10_000, '1‰');
    assert.equal(result.byType.find((t) => t.type === 'property_transfer')?.tax, 5_000, '0.5‰');
    assert.equal(result.byType.find((t) => t.type === 'account_book')?.tax, 2_500, '0.25‰');
    assert.equal(result.byType.find((t) => t.type === 'securities')?.tax, 10_000, '1‰');
    assert.equal(result.total, 31_000);
    assert.equal(result.halfReduction, false);
  });

  it('六税两费减半，但证券交易印花税不减半', () => {
    const result = computeStampDuty({
      period: '2024-06',
      items: [
        { type: 'sale', amount: 10_000_000 },
        { type: 'securities', amount: 10_000_000 },
      ],
      smallScale: true,
      smallLowProfit: true,
    });

    assert.equal(result.halfReduction, true);
    assert.equal(result.byType.find((t) => t.type === 'sale')?.tax, 1_500);
    assert.equal(result.byType.find((t) => t.type === 'securities')?.tax, 10_000);
    assert.equal(result.total, 11_500);
    assert.ok(result.notes.some((n) => n.includes('证券交易')));
  });

  it('同一税目多笔合并计税', () => {
    const result = computeStampDuty({
      period: '2024-06',
      items: [
        { type: 'sale', amount: 10_000_000 },
        { type: 'sale', amount: 20_000_000 },
      ],
      smallScale: false,
      smallLowProfit: false,
    });
    assert.equal(result.byType.length, 1);
    assert.equal(result.byType[0]?.amount, 30_000_000);
    assert.equal(result.total, 9_000);
  });

  it('无应税凭证时合计为 0 且给出提示', () => {
    const result = computeStampDuty({ period: '2024-06', items: [] });
    assert.equal(result.total, 0);
    assert.ok(result.lines.some((l) => l.code === 'STAMP-NONE'));
  });
});

/* ------------------------------------------------------------------ */
/* 申报表草稿                                                          */
/* ------------------------------------------------------------------ */

describe('申报表草稿', () => {
  const lines: TaxLine[] = [
    { code: '11', label: '销项税额', amount: 13_000_000 },
    { code: '12', label: '进项税额', amount: 3_000_000 },
    { code: '19', label: '应纳税额', amount: 10_000_000 },
    { code: '25', label: '本期应补(退)税额', amount: 10_000_000 },
  ];

  it('状态恒为 calculated，指纹稳定且为 64 位十六进制', () => {
    const a = createDraftReturn('vat', '2024-06', SMALL_TAXPAYER, 'small', lines);
    const b = createDraftReturn('vat', '2024-06', SMALL_TAXPAYER, 'small', lines);

    assert.equal(a.status, 'calculated');
    assert.notEqual(a.status as string, 'filed');
    assert.equal(a.payable, 10_000_000);
    assert.equal(a.prepaid, 0);
    assert.equal(a.due, 10_000_000);
    assert.match(a.payloadHash, /^[0-9a-f]{64}$/);
    assert.equal(a.payloadHash, b.payloadHash, '相同输入必须得到相同指纹');
    assert.equal(a.version, 1);
    assert.equal(a.events.length, 1);
    assert.equal(a.events[0]?.to, 'calculated');
  });

  it('预缴税额会改变应补(退)与指纹', () => {
    const draft = createDraftReturn('vat', '2024-06', SMALL_TAXPAYER, 'small', lines);
    const paid = withPrepayment(draft, 4_000_000);

    assert.equal(paid.prepaid, 4_000_000);
    assert.equal(paid.due, 6_000_000);
    assert.notEqual(paid.payloadHash, draft.payloadHash);
    assert.equal(draft.prepaid, 0, 'withPrepayment 不得修改入参');
  });

  it('金额变动会改变指纹', () => {
    const changed = lines.map((l) => (l.code === '19' ? { ...l, amount: 9_999_999 } : l));
    const a = createDraftReturn('vat', '2024-06', SMALL_TAXPAYER, 'small', lines);
    const b = createDraftReturn('vat', '2024-06', SMALL_TAXPAYER, 'small', changed);
    assert.notEqual(a.payloadHash, b.payloadHash);
  });

  it('规范化 JSON 与键顺序无关', () => {
    const h1 = computePayloadHash({ b: 1, a: [2, 3] });
    const h2 = computePayloadHash({ a: [2, 3], b: 1 });
    assert.equal(h1, h2);
    assert.notEqual(h1, computePayloadHash({ a: [3, 2], b: 1 }));
  });

  it('按登记栏次解析应纳税额，缺失时回退到标签匹配', () => {
    assert.equal(resolvePayable('vat', lines), 10_000_000);
    assert.equal(
      resolvePayable('vat', [{ code: 'X', label: '应纳税额（自定义）', amount: 123 }]),
      123,
    );
    assert.equal(resolvePayable('vat', []), 0);
  });
});

/* ------------------------------------------------------------------ */
/* 端到端编排                                                          */
/* ------------------------------------------------------------------ */

describe('统一编排 computeTaxes', () => {
  const ledger: LedgerSnapshot = {
    period: '2024-06',
    standard: 'small',
    openingBalanced: true,
    vouchers: [],
    balances: [
      { accountCode: '6001.01', accountName: '商品销售收入', opening: 0, debitTotal: 0, creditTotal: 100_000_000, closing: -100_000_000 },
      { accountCode: '6401', accountName: '主营业务成本', opening: 0, debitTotal: 60_000_000, creditTotal: 0, closing: 60_000_000 },
      { accountCode: '2221.01.02', accountName: '销项税额', opening: 0, debitTotal: 0, creditTotal: 13_000_000, closing: -13_000_000 },
      { accountCode: '2211.01', accountName: '工资', opening: 0, debitTotal: 0, creditTotal: 10_000_000, closing: -10_000_000 },
      { accountCode: '2241.01', accountName: '社保个人部分', opening: 0, debitTotal: 0, creditTotal: 1_000_000, closing: -1_000_000 },
    ],
  };

  const input = {
    period: '2024-06',
    standard: 'small' as const,
    taxpayer: { ...GENERAL_TAXPAYER, isSmallLowProfit: true, employees: 20, totalAssets: 100_000_000 },
    ledger,
    vouchers: [],
  };

  it('一次算出五个税种，状态全部为 calculated', () => {
    const result = computeTaxes(input);

    assert.equal(result.returns.length, 5);
    assert.deepEqual(
      result.returns.map((r) => r.taxType),
      ['vat', 'surcharge', 'cit', 'iit', 'stamp'],
    );
    for (const ret of result.returns) {
      assert.equal(ret.status, 'calculated', ret.taxType + ' 状态必须为 calculated');
      assert.match(ret.payloadHash, /^[0-9a-f]{64}$/);
      assert.equal(ret.lines.length > 0, true);
    }
    assert.equal(result.returns.some((r) => (r.status as string) === 'filed'), false);
  });

  it('各税种金额与手工核算一致', () => {
    const result = computeTaxes(input);

    assert.equal(findReturn(result.returns, 'vat')?.payable, 13_000_000, '销项 130,000 元，无进项');
    assert.equal(findReturn(result.returns, 'surcharge')?.payable, 780_000, '1,560,000 减半');
    assert.equal(findReturn(result.returns, 'cit')?.payable, 2_000_000, '利润 400,000 元 × 5%');
    assert.equal(findReturn(result.returns, 'stamp')?.payable, 15_000, '销售合同 1,000,000 元 × 0.3‰ × 50%');
    assert.ok((findReturn(result.returns, 'iit')?.payable ?? 0) > 0, '有工资应当预扣个税');
  });

  it('配置文件可正常加载（无回退告警）', () => {
    const result = computeTaxes(input);
    assert.equal(
      result.notes.some((n) => n.includes('税率配置加载失败')),
      false,
      'config/tax/rates.yaml 应能正常解析',
    );
    assert.equal(
      result.notes.some((n) => n.includes('优惠政策库加载失败')),
      false,
      'config/tax/benefits.yaml 应能正常解析',
    );
  });

  it('优惠结果挂载到对应税种的申报表上', () => {
    const result = computeTaxes(input);
    const cit = findReturn(result.returns, 'cit');
    assert.ok(cit);
    assert.equal(cit.benefits.length > 0, true, '企业所得税申报表应挂载 cit-* 优惠');
    assert.equal(cit.benefits.every((b) => b.policyId.startsWith('cit-')), true);

    const vat = findReturn(result.returns, 'vat');
    assert.ok(vat);
    assert.equal(vat.benefits.every((b) => b.policyId.startsWith('vat-')), true);
  });

  it('输出风险提示与说明，且不产生 filed 状态', () => {
    const result = computeTaxes(input);
    assert.equal(Array.isArray(result.risks), true);
    assert.equal(result.notes.length > 0, true);
    assert.ok(result.notes.some((n) => n.includes('不会、也不允许自动向税务机关提交申报')));
    assert.equal(result.benefits.length, 8, '政策库应覆盖 8 项优惠');
  });

  it('零业务账簿也能算出全 0 的申报表而不抛异常', () => {
    const emptyLedger: LedgerSnapshot = {
      period: '2024-06',
      standard: 'small',
      openingBalanced: true,
      vouchers: [],
      balances: [],
    };
    const result = computeTaxes({ ...input, ledger: emptyLedger });
    assert.equal(result.returns.length, 5);
    assert.equal(findReturn(result.returns, 'vat')?.payable, 0);
    assert.equal(findReturn(result.returns, 'cit')?.payable, 0);
    assert.equal(findReturn(result.returns, 'stamp')?.payable, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 与审核层的数据约定                                                  */
/* ------------------------------------------------------------------ */

describe('与审核层的数据约定', () => {
  const ledger: LedgerSnapshot = {
    period: '2024-06',
    standard: 'small',
    openingBalanced: true,
    vouchers: [],
    balances: [
      { accountCode: '6001.01', accountName: '商品销售收入', opening: 0, debitTotal: 0, creditTotal: 100_000_000, closing: -100_000_000 },
      { accountCode: '6401', accountName: '主营业务成本', opening: 0, debitTotal: 60_000_000, creditTotal: 0, closing: 60_000_000 },
      { accountCode: '2221.01.02', accountName: '销项税额', opening: 0, debitTotal: 0, creditTotal: 13_000_000, closing: -13_000_000 },
    ],
  };

  it('增值税表能被「按 code 或 label 关键字」找到销项、进项、留抵、销售额', () => {
    const result = computeTaxes({
      period: '2024-06',
      standard: 'small',
      taxpayer: { ...GENERAL_TAXPAYER, isSmallLowProfit: true },
      ledger,
      vouchers: [],
    });
    const vat = findReturn(result.returns, 'vat');
    assert.ok(vat);

    const hasLabel = (kw: string): boolean => vat.lines.some((l) => l.label.includes(kw));
    assert.equal(hasLabel('销项税额'), true);
    assert.equal(hasLabel('进项税额'), true);
    assert.equal(hasLabel('留抵'), true);
    assert.equal(hasLabel('销售额'), true);
    assert.equal(vat.lines.some((l) => l.code === 'sales_amount'), true);
  });

  it('附加税表能被找到「计税依据」栏且等于实缴增值税', () => {
    const result = computeTaxes({
      period: '2024-06',
      standard: 'small',
      taxpayer: GENERAL_TAXPAYER,
      ledger,
      vouchers: [],
    });
    const surcharge = findReturn(result.returns, 'surcharge');
    assert.ok(surcharge);
    const baseLine = surcharge.lines.find((l) => l.label.includes('计税依据'));
    assert.ok(baseLine);
    assert.equal(baseLine.amount, findReturn(result.returns, 'vat')?.payable);
  });

  it('企业所得税表能被找到「税率」栏，且为优惠后的适用税率', () => {
    const result = computeTaxes({
      period: '2024-06',
      standard: 'small',
      taxpayer: { ...GENERAL_TAXPAYER, isSmallLowProfit: true, employees: 20, totalAssets: 100_000_000 },
      ledger,
      vouchers: [],
    });
    const cit = findReturn(result.returns, 'cit');
    assert.ok(cit);
    const rateLine = cit.lines.find(
      (l) => typeof l.rate === 'number' && l.rate > 0 && /税率/.test(l.code + l.label),
    );
    assert.ok(rateLine);
    assert.equal(rateLine.rate, 0.05, '审核层读到的必须是实际适用的 5%，不是法定 25%');
  });

  it('小规模增值税表带「减免税额」栏，供审核层判断优惠是否已体现', () => {
    // 5 月按月申报，门槛 10 万元；20 万元销售额已超门槛，必然产生 3%→1% 的减征额
    const smallLedger: LedgerSnapshot = {
      ...ledger,
      period: '2024-05',
      balances: [
        { accountCode: '6001.01', accountName: '商品销售收入', opening: 0, debitTotal: 0, creditTotal: 20_000_000, closing: -20_000_000 },
      ],
    };
    const result = computeTaxes({
      period: '2024-05',
      standard: 'small',
      taxpayer: SMALL_TAXPAYER,
      ledger: smallLedger,
      vouchers: [],
    });
    const vat = findReturn(result.returns, 'vat');
    assert.ok(vat);
    const reduction = vat.lines.find((l) => l.code === 'tax_reduction' || l.label.includes('减免'));
    assert.ok(reduction, '必须存在减免税额栏');
    assert.equal(reduction.amount > 0, true);
  });
});
