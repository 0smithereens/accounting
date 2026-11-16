/**
 * 个人所得税（工资薪金累计预扣法）单元测试。
 *
 * 覆盖：跨月跨档的累计预扣、七级税率临界点、累计所得额 ≤ 0 不预扣、
 * 前期多预扣时本月按 0 处理（多扣部分只能汇算退税）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  IIT_BRACKETS,
  computeIitCumulative,
  iitBracketOf,
  monthlyBasicDeduction,
  projectCumulativeByAverage,
} from '../src/tax/index.ts';

describe('个人所得税 · 累计预扣', () => {
  it('第 1 个月：累计所得额 20,000 元适用 3%', () => {
    const result = computeIitCumulative({
      period: '2024-01',
      monthsElapsed: 1,
      cumulativeIncome: 3_000_000,          // 30,000 元
      cumulativeSpecialDeduction: 300_000,  // 3,000 元三险一金
      cumulativeAdditionalDeduction: 200_000, // 2,000 元专项附加
    });

    assert.equal(result.cumulativeBasicDeduction, 500_000);
    assert.equal(result.cumulativeTaxableIncome, 2_000_000, '30,000 - 5,000 - 3,000 - 2,000 元');
    assert.equal(result.bracket.rate, 0.03);
    assert.equal(result.cumulativeTax, 60_000, '2,000,000 × 3% = 600 元');
    assert.equal(result.currentWithholding, 60_000);
  });

  it('第 2 个月：累计所得额跨入 10% 档，本期只补差额', () => {
    const result = computeIitCumulative({
      period: '2024-02',
      monthsElapsed: 2,
      cumulativeIncome: 6_000_000,
      cumulativeSpecialDeduction: 600_000,
      cumulativeAdditionalDeduction: 400_000,
      taxWithheldYtd: 60_000,
    });

    assert.equal(result.cumulativeBasicDeduction, 1_000_000, '5000 × 2 个月');
    assert.equal(result.cumulativeTaxableIncome, 4_000_000);
    assert.equal(result.bracket.rate, 0.1);
    assert.equal(result.bracket.quickDeduction, 252_000);
    assert.equal(result.cumulativeTax, 148_000, '4,000,000 × 10% - 252,000');
    assert.equal(result.currentWithholding, 88_000, '148,000 - 60,000');
  });

  it('第 3 个月：累计税额继续增长，本期应扣 = 累计 - 已扣', () => {
    const result = computeIitCumulative({
      period: '2024-03',
      monthsElapsed: 3,
      cumulativeIncome: 9_000_000,
      cumulativeSpecialDeduction: 900_000,
      cumulativeAdditionalDeduction: 600_000,
      taxWithheldYtd: 148_000,
    });

    assert.equal(result.cumulativeTaxableIncome, 6_000_000);
    assert.equal(result.cumulativeTax, 348_000, '6,000,000 × 10% - 252,000');
    assert.equal(result.currentWithholding, 200_000);
  });

  it('累计应纳税所得额 ≤ 0 时不预扣', () => {
    const result = computeIitCumulative({
      period: '2024-03',
      monthsElapsed: 3,
      cumulativeIncome: 3_000_000,
      cumulativeSpecialDeduction: 3_000_000,
    });
    assert.equal(result.cumulativeTaxableIncome, 0);
    assert.equal(result.cumulativeTax, 0);
    assert.equal(result.currentWithholding, 0);
    assert.ok(result.notes.some((n) => n.includes('不预扣')));
  });

  it('七级超额累进税率临界点前后各差 1 分', () => {
    const cases: Array<[number, number, number]> = [
      // [累计应纳税所得额, 期望累计税额, 期望预扣率]
      [3_600_000, 108_000, 0.03],
      [3_600_100, 108_010, 0.1],
      [14_400_000, 1_188_000, 0.1],
      [14_400_100, 1_188_020, 0.2],
      [30_000_000, 4_308_000, 0.2],
      [42_000_000, 7_308_000, 0.25],
      [66_000_000, 14_508_000, 0.3],
      [96_000_000, 25_008_000, 0.35],
      [96_000_100, 25_008_045, 0.45],
    ];
    for (const [taxable, expectedTax, expectedRate] of cases) {
      const result = computeIitCumulative({
        monthsElapsed: 1,
        cumulativeIncome: taxable + 500_000,
      });
      assert.equal(result.cumulativeTaxableIncome, taxable);
      assert.equal(result.bracket.rate, expectedRate, '所得额 ' + taxable + ' 的预扣率');
      assert.equal(result.cumulativeTax, expectedTax, '所得额 ' + taxable + ' 的累计税额');
    }
  });

  it('前期多预扣时本月按 0 预扣，并提示汇算退税', () => {
    const result = computeIitCumulative({
      period: '2024-01',
      monthsElapsed: 1,
      cumulativeIncome: 3_000_000,
      cumulativeSpecialDeduction: 300_000,
      cumulativeAdditionalDeduction: 200_000,
      taxWithheldYtd: 100_000,
    });
    assert.equal(result.currentWithholding, 0);
    assert.ok(result.notes.some((n) => n.includes('汇算清缴')));
  });

  it('累计减免税额先于已预扣税额扣减', () => {
    const result = computeIitCumulative({
      monthsElapsed: 1,
      cumulativeIncome: 3_000_000,
      cumulativeSpecialDeduction: 300_000,
      cumulativeAdditionalDeduction: 200_000,
      cumulativeTaxRelief: 20_000,
    });
    assert.equal(result.cumulativeTax, 60_000);
    assert.equal(result.currentWithholding, 40_000, '60,000 - 20,000');
  });

  it('月份数越界时夹取到 1-12 并留痕', () => {
    const zero = computeIitCumulative({ monthsElapsed: 0, cumulativeIncome: 0 });
    assert.equal(zero.cumulativeBasicDeduction, 500_000);
    assert.ok(zero.notes.some((n) => n.includes('1-12')));

    const thirteen = computeIitCumulative({ monthsElapsed: 13, cumulativeIncome: 0 });
    assert.equal(thirteen.cumulativeBasicDeduction, 6_000_000, '12 × 5000 元');
  });

  it('期间与月份数不一致时给出提示', () => {
    const result = computeIitCumulative({
      period: '2024-06',
      monthsElapsed: 3,
      cumulativeIncome: 3_000_000,
    });
    assert.ok(result.notes.some((n) => n.includes('累计数口径')));
  });

  it('税率级距表与辅助函数一致', () => {
    assert.equal(IIT_BRACKETS.length, 7);
    assert.equal(iitBracketOf(0).rate, 0.03);
    assert.equal(iitBracketOf(Number.MAX_SAFE_INTEGER).rate, 0.45);
    assert.equal(monthlyBasicDeduction(3), 1_500_000);
  });

  it('月均推算：累计收入 = 单月收入 × 月数', () => {
    const projected = projectCumulativeByAverage(3_000_000, 300_000, 4);
    assert.equal(projected.cumulativeIncome, 12_000_000);
    assert.equal(projected.cumulativeSpecialDeduction, 1_200_000);
  });
});
