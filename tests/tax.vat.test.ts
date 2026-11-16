/**
 * 增值税与附加税费单元测试。
 *
 * 覆盖重点是「会算错」的地方：兼营多税率、留抵结转、小规模免征门槛的临界点、
 * 附加税费的计税依据是「实缴」而非「应纳」。
 * 金额一律用分，断言全部精确相等 —— 税务计算不允许「差不多」。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TaxLine } from '../src/core/contracts.ts';
import {
  computeSurcharge,
  computeVat,
  groupSalesByRate,
  inferVatRate,
  isSixTaxesHalfEligible,
} from '../src/tax/index.ts';

function lineOf(lines: readonly TaxLine[], code: string): TaxLine {
  const found = lines.find((l) => l.code === code);
  assert.ok(found, '缺少栏次 ' + code);
  return found;
}

/* ------------------------------------------------------------------ */
/* 一般纳税人                                                          */
/* ------------------------------------------------------------------ */

describe('增值税 · 一般纳税人', () => {
  it('兼营 13% 与 6% 两档税率，销项税额分档计算后汇总', () => {
    const result = computeVat({
      period: '2024-06',
      kind: 'general',
      sales: [
        { category: 'goods', netAmount: 100_000_000 },        // 100 万元 × 13%
        { category: 'modern_service', netAmount: 50_000_000 }, // 50 万元 × 6%
      ],
      purchases: [{ inputTax: 10_000_000 }],                  // 10 万元进项
    });

    assert.equal(result.byRate.length, 2, '两档税率必须拆成两组，不能合并成一个平均税率');
    assert.equal(result.outputTax, 16_000_000, '销项 = 130,000 + 30,000 元');
    assert.equal(result.inputTax, 10_000_000);
    assert.equal(result.payable, 6_000_000, '应纳 = 160,000 - 100,000 元');
    assert.equal(result.creditCarryforwardClosing, 0);

    assert.equal(lineOf(result.lines, '11').amount, 16_000_000);
    assert.equal(lineOf(result.lines, '12').amount, 10_000_000);
    assert.equal(lineOf(result.lines, '19').amount, 6_000_000);
    assert.equal(lineOf(result.lines, '20').amount, 0);
    assert.equal(lineOf(result.lines, '25').amount, 6_000_000);
  });

  it('进项大于销项时形成留抵，应纳税额为 0，留抵结转下期', () => {
    const result = computeVat({
      period: '2024-06',
      kind: 'general',
      sales: [{ category: 'goods', netAmount: 10_000_000 }], // 销项 1,300,000 分
      purchases: [{ inputTax: 2_000_000 }],
      creditCarryforward: 500_000,
    });

    assert.equal(result.outputTax, 1_300_000);
    assert.equal(result.payable, 0, '留抵足以覆盖销项时不得产生应纳税额');
    assert.equal(result.creditCarryforwardClosing, 1_200_000, '留抵 = 2,000,000 + 500,000 - 1,300,000');
    assert.equal(lineOf(result.lines, '19').amount, 0);
    assert.equal(lineOf(result.lines, '20').amount, 1_200_000);
    assert.ok(
      result.notes.some((n) => n.includes('附加税费不得据此计提')),
      '应提示留抵未缴税不计提附加税费',
    );
  });

  it('期初留抵部分抵扣：应纳税额 = 销项 - (进项 + 期初留抵)', () => {
    const result = computeVat({
      period: '2024-06',
      kind: 'general',
      sales: [{ category: 'goods', netAmount: 50_000_000 }], // 销项 6,500,000
      purchases: [{ inputTax: 1_000_000 }],
      creditCarryforward: 1_000_000,
    });

    assert.equal(result.outputTax, 6_500_000);
    assert.equal(result.payable, 4_500_000);
    assert.equal(result.creditCarryforwardClosing, 0, '留抵已全部消化');
  });

  it('进项税额转出会减少可抵扣额', () => {
    const result = computeVat({
      period: '2024-06',
      kind: 'general',
      sales: [{ category: 'goods', netAmount: 10_000_000 }], // 销项 1,300,000
      purchases: [{ inputTax: 500_000 }],
      inputTransferOut: 200_000,
    });

    assert.equal(result.inputTax, 500_000);
    assert.equal(result.inputTransferOut, 200_000);
    assert.equal(result.payable, 1_000_000, '1,300,000 - (500,000 - 200,000)');
    assert.equal(lineOf(result.lines, '17').amount, 300_000);
  });

  it('加计抵减 5% 只抵减应纳税额，不增加留抵', () => {
    const result = computeVat({
      period: '2024-06',
      kind: 'general',
      sales: [{ category: 'modern_service', netAmount: 100_000_000 }], // 6% → 6,000,000
      purchases: [{ inputTax: 2_000_000 }],
      additionalDeductionRate: 0.05,
    });

    assert.equal(result.additionalDeduction, 100_000, '2,000,000 × 5%');
    assert.equal(result.payable, 3_900_000, '6,000,000 - 2,000,000 - 100,000');
    assert.equal(result.creditCarryforwardClosing, 0);
    assert.ok(result.lines.some((l) => l.code === '19-D'));
  });

  it('留抵状态下不计提加计抵减，也不得把应纳税额抵成负数', () => {
    const result = computeVat({
      period: '2024-06',
      kind: 'general',
      sales: [{ category: 'goods', netAmount: 100_000 }], // 销项 13,000
      purchases: [{ inputTax: 100_000 }],                 // 进项大于销项
      additionalDeductionRate: 0.05,                      // 计提 5,000 但无可抵减税额
    });
    assert.equal(result.payable, 0, '应纳税额为 0 时不得出现负数');
    assert.equal(result.additionalDeduction, 0, '加计抵减只能抵减应纳税额，不能增加留抵');
    assert.equal(result.creditCarryforwardClosing, 87_000, '留抵 = 100,000 - 13,000');
  });

  it('未显式传入加计抵减率时默认不享受（资格型优惠）', () => {
    const result = computeVat({
      period: '2024-06',
      kind: 'general',
      sales: [{ category: 'modern_service', netAmount: 10_000_000 }], // 6% → 600,000
      purchases: [{ inputTax: 100_000 }],
    });
    assert.equal(result.additionalDeduction, 0);
    assert.equal(result.payable, 500_000);
  });

  it('零金额：无销项无进项时各栏次均为 0，仍输出完整栏次结构', () => {
    const result = computeVat({ period: '2024-06', kind: 'general', sales: [] });

    assert.equal(result.outputTax, 0);
    assert.equal(result.inputTax, 0);
    assert.equal(result.payable, 0);
    assert.equal(result.due, 0);
    assert.equal(lineOf(result.lines, '11').amount, 0);
    assert.equal(lineOf(result.lines, '19').amount, 0);
    assert.equal(lineOf(result.lines, '20').amount, 0);
    assert.ok(result.notes.some((n) => n.includes('零申报')));
  });

  it('负数进项被按 0 处理并留痕', () => {
    const result = computeVat({
      period: '2024-06',
      kind: 'general',
      sales: [{ category: 'goods', netAmount: 1_000_000 }],
      purchases: [{ inputTax: -500 }],
    });
    assert.equal(result.inputTax, 0);
    assert.ok(result.notes.some((n) => n.includes('负数')));
  });
});

/* ------------------------------------------------------------------ */
/* 小规模纳税人                                                        */
/* ------------------------------------------------------------------ */

describe('增值税 · 小规模纳税人', () => {
  it('月销售额 9.99 万元免征，10.01 万元按 1% 征收', () => {
    const exempt = computeVat({
      period: '2024-06',
      kind: 'small_scale',
      sales: [{ category: 'small_scale_1', netAmount: 9_990_000 }], // 9.99 万元
    });
    assert.equal(exempt.exempt, true);
    assert.equal(exempt.payable, 0);
    assert.equal(lineOf(exempt.lines, '9').amount, 9_990_000);

    const taxable = computeVat({
      period: '2024-06',
      kind: 'small_scale',
      sales: [{ category: 'small_scale_1', netAmount: 10_010_000 }], // 10.01 万元
    });
    assert.equal(taxable.exempt, false);
    assert.equal(taxable.payable, 100_100, '10,010,000 × 1% = 100,100 分');
    assert.equal(lineOf(taxable.lines, '15').amount, 300_300, '按 3% 计算的本期应纳税额');
    assert.equal(lineOf(taxable.lines, '16').amount, 200_200, '减征额 = 3% 与 1% 之差');
    assert.equal(lineOf(taxable.lines, '19').amount, 100_100);
    assert.equal(lineOf(taxable.lines, '15').amount - lineOf(taxable.lines, '16').amount, taxable.payable);
  });

  it('恰好 10 万元（含本数）免征，10 万元零 1 分不免征', () => {
    const atLimit = computeVat({
      period: '2024-06',
      kind: 'small_scale',
      sales: [{ category: 'small_scale_1', netAmount: 10_000_000 }],
    });
    assert.equal(atLimit.exempt, true, '「10 万元以下（含本数）」应包含 10 万元整');

    const overLimit = computeVat({
      period: '2024-06',
      kind: 'small_scale',
      sales: [{ category: 'small_scale_1', netAmount: 10_000_001 }],
    });
    assert.equal(overLimit.exempt, false);
    assert.equal(overLimit.payable, 100_000);
  });

  it('按季申报适用 30 万元门槛', () => {
    const exempt = computeVat({
      period: '2024-06',
      kind: 'small_scale',
      quarterly: true,
      sales: [{ category: 'small_scale_1', netAmount: 30_000_000 }],
    });
    assert.equal(exempt.exempt, true);

    const taxable = computeVat({
      period: '2024-06',
      kind: 'small_scale',
      quarterly: true,
      sales: [{ category: 'small_scale_1', netAmount: 30_010_000 }],
    });
    assert.equal(taxable.exempt, false);
    assert.equal(taxable.payable, 300_100, '30,010,000 × 1%');
  });

  it('含税销售额可反算不含税销售额并参与免征判断', () => {
    const result = computeVat({
      period: '2024-06',
      kind: 'small_scale',
      sales: [],
      grossSales: 10_100_000, // 含税 10.1 万元 → 不含税 10,000,000
    });
    assert.equal(result.taxExclusiveSales, 10_000_000);
    assert.equal(result.exempt, true);
    assert.ok(result.notes.some((n) => n.includes('反算')));
  });

  it('小规模纳税人传入进项会被忽略并说明原因', () => {
    const result = computeVat({
      period: '2024-06',
      kind: 'small_scale',
      sales: [{ category: 'small_scale_1', netAmount: 20_000_000 }],
      purchases: [{ inputTax: 1_000_000 }],
    });
    assert.equal(result.inputTax, 0);
    assert.equal(result.payable, 200_000);
    assert.ok(result.notes.some((n) => n.includes('不得抵扣进项税额')));
  });

  it('政策窗口外（2028 年）回到 3% 法定征收率', () => {
    const result = computeVat({
      period: '2028-06',
      kind: 'small_scale',
      sales: [{ category: 'small_scale_3', netAmount: 20_000_000 }],
    });
    assert.equal(result.payable, 600_000, '20,000,000 × 3%');
    assert.equal(result.lines.some((l) => l.code === '16'), false, '不再有减征额');
  });
});

/* ------------------------------------------------------------------ */
/* 附加税费                                                            */
/* ------------------------------------------------------------------ */

describe('附加税费', () => {
  it('计税依据是实际缴纳的增值税，留抵不缴则为 0', () => {
    const paid = computeSurcharge({
      period: '2024-06',
      cityTaxRate: 0.07,
      smallScale: false,
      smallLowProfit: false,
      vatPaid: 6_000_000,
      salesAmount: 100_000_000,
    });

    assert.equal(paid.base, 6_000_000);
    assert.equal(paid.cityTax, 420_000, '6,000,000 × 7%');
    assert.equal(paid.educationSurcharge, 180_000, '6,000,000 × 3%');
    assert.equal(paid.localEducationSurcharge, 120_000, '6,000,000 × 2%');
    assert.equal(paid.total, 720_000);
    assert.equal(paid.halfReduction, false);

    const noPayment = computeSurcharge({
      period: '2024-06',
      cityTaxRate: 0.07,
      smallScale: false,
      smallLowProfit: false,
      vatPaid: 0,
      salesAmount: 100_000_000,
    });
    assert.equal(noPayment.base, 0);
    assert.equal(noPayment.total, 0, '未实际缴纳增值税时不得计提附加税费');
  });

  it('六税两费减半：城建税、教育费附加、地方教育附加各减半', () => {
    const result = computeSurcharge({
      period: '2024-06',
      cityTaxRate: 0.07,
      smallScale: true,
      smallLowProfit: true,
      vatPaid: 6_000_000,
      salesAmount: 100_000_000,
    });

    assert.equal(result.halfReduction, true);
    assert.equal(result.cityTax, 210_000);
    assert.equal(result.educationSurcharge, 90_000);
    assert.equal(result.localEducationSurcharge, 60_000);
    assert.equal(result.total, 360_000);
  });

  it('月销售额 10 万元以下免征教育费附加与地方教育附加，城建税照缴', () => {
    const result = computeSurcharge({
      period: '2024-06',
      cityTaxRate: 0.07,
      smallScale: true,
      smallLowProfit: true,
      vatPaid: 300_000,
      salesAmount: 9_000_000, // 9 万元 < 10 万元
    });

    assert.equal(result.educationExempt, true);
    assert.equal(result.educationSurcharge, 0);
    assert.equal(result.localEducationSurcharge, 0);
    assert.equal(result.cityTax, 10_500, '300,000 × 7% = 21,000，减半后 10,500');
    assert.equal(result.total, 10_500);
  });

  it('一般纳税人且非小型微利企业不得减半', () => {
    assert.equal(isSixTaxesHalfEligible(false, false), false);
    assert.equal(isSixTaxesHalfEligible(true, false), true);
    assert.equal(isSixTaxesHalfEligible(false, true), true);

    const result = computeSurcharge({
      period: '2024-06',
      cityTaxRate: 0.05,
      smallScale: false,
      smallLowProfit: false,
      vatPaid: 1_000_000,
      salesAmount: 50_000_000,
    });
    assert.equal(result.halfReduction, false);
    assert.equal(result.cityTax, 50_000);
    assert.ok(result.notes.some((n) => n.includes('不适用六税两费减半')));
  });

  it('城建税三档税率', () => {
    for (const [rate, expected] of [[0.07, 70_000], [0.05, 50_000], [0.01, 10_000]] as const) {
      const result = computeSurcharge({
        period: '2024-06',
        cityTaxRate: rate,
        smallScale: false,
        smallLowProfit: false,
        vatPaid: 1_000_000,
        salesAmount: 50_000_000,
      });
      assert.equal(result.cityTax, expected, '税率 ' + rate);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 税率推断                                                            */
/* ------------------------------------------------------------------ */

describe('税率推断与分组', () => {
  it('把实算税率吸附到法定档位', () => {
    assert.equal(inferVatRate(100_000, 13_000), 0.13);
    assert.equal(inferVatRate(100_000, 9_000), 0.09);
    assert.equal(inferVatRate(100_000, 6_000), 0.06);
    assert.equal(inferVatRate(100_000, 0), 0);
    assert.equal(inferVatRate(100_000, 30_000), null, '30% 不属于任何法定档位');
    assert.equal(inferVatRate(0, 100), null);
  });

  it('同分类同税率合并、不同税率分行', () => {
    const groups = groupSalesByRate([
      { category: 'goods', netAmount: 1_000_000 },
      { category: 'goods', netAmount: 2_000_000 },
      { category: 'modern_service', netAmount: 3_000_000 },
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.rate, 0.13, '按税率从高到低排序');
    assert.equal(groups[0]?.netAmount, 3_000_000);
    assert.equal(groups[0]?.outputTax, 390_000);
  });
});
