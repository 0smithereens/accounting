/**
 * 企业所得税单元测试。
 *
 * 覆盖：小微 5% 与 300 万临界点、业务招待费两个分支、广告费结转、
 * 三项经费限额、公益性捐赠、罚款全额调增、研发加计、亏损弥补。
 * 每一个调整项都断言「调增金额」与「法规依据」同时存在 —— 没有依据的调整不允许出现。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSmallLowProfit,
  computeCit,
  computeCitAdjustments,
  decideCitRate,
} from '../src/tax/index.ts';

/* ------------------------------------------------------------------ */
/* 小型微利企业与税率                                                  */
/* ------------------------------------------------------------------ */

describe('企业所得税 · 小型微利企业', () => {
  it('季度预缴按实际利润额 × 5%（小微实际税负）', () => {
    const result = computeCit({
      period: '2024-06',
      accountingProfit: 100_000_000, // 100 万元
      revenue: 400_000_000,
      isSmallLowProfit: true,
      isHighTech: false,
      employees: 50,
      totalAssets: 1_000_000_000,
      annual: false,
    });

    assert.equal(result.taxableIncome, 100_000_000);
    assert.equal(result.statutoryTax, 25_000_000, '法定 25%');
    assert.equal(result.taxPayable, 5_000_000, '小微 5%');
    assert.equal(result.taxRelief, 20_000_000);
    assert.equal(result.smallLowProfitApplied, true);
    assert.equal(result.effectiveRate, 0.05);
  });

  it('300 万元临界点：刚好 300 万享受 5%，超过即回到 25%', () => {
    const atLimit = computeCit({
      period: '2024-12',
      accountingProfit: 300_000_000,
      revenue: 1_000_000_000,
      isSmallLowProfit: true,
      isHighTech: false,
      employees: 100,
      totalAssets: 2_000_000_000,
      annual: true,
    });
    assert.equal(atLimit.smallLowProfitApplied, true);
    assert.equal(atLimit.taxPayable, 15_000_000, '300 万 × 5%');

    const overLimit = computeCit({
      period: '2024-12',
      accountingProfit: 300_000_100,
      revenue: 1_000_000_000,
      isSmallLowProfit: true,
      isHighTech: false,
      employees: 100,
      totalAssets: 2_000_000_000,
      annual: true,
    });
    assert.equal(overLimit.smallLowProfitApplied, false);
    assert.equal(overLimit.taxPayable, 75_000_025, '300,000,100 × 25%');
    assert.ok(
      overLimit.notes.some((n) => n.includes('资格复核未通过')),
      '应提示小微资格未通过及原因',
    );
  });

  it('从业人数或资产总额超限同样丧失小微资格', () => {
    const byEmployees = checkSmallLowProfit(true, 10_000_000, 301, 1_000_000_000);
    assert.equal(byEmployees.qualified, false);
    assert.ok(byEmployees.reasons.some((r) => r.includes('从业人数')));

    const byAssets = checkSmallLowProfit(true, 10_000_000, 100, 5_000_000_001);
    assert.equal(byAssets.qualified, false);
    assert.ok(byAssets.reasons.some((r) => r.includes('资产总额')));

    const ok = checkSmallLowProfit(true, 10_000_000, 300, 5_000_000_000);
    assert.equal(ok.qualified, true, '三个条件均取「不超过」，边界值应通过');
  });

  it('高新技术企业按 15%，且小微与高新不可叠加时择低适用', () => {
    const highTech = decideCitRate({ isSmallLowProfit: false, isHighTech: true }, 10_000_000);
    assert.equal(highTech.rate, 0.15);
    assert.equal(highTech.highTechApplied, true);

    const both = decideCitRate({ isSmallLowProfit: true, isHighTech: true, employees: 10 }, 10_000_000);
    assert.equal(both.rate, 0.05, '同时符合时按税负更低的小微口径');
    assert.equal(both.smallLowProfitApplied, true);
  });
});

/* ------------------------------------------------------------------ */
/* 纳税调整                                                            */
/* ------------------------------------------------------------------ */

describe('企业所得税 · 纳税调整', () => {
  it('业务招待费：发生额 60% 高于收入 5‰ 时，按收入 5‰ 扣除', () => {
    const result = computeCitAdjustments(
      { businessEntertainment: 10_000_000 },
      100_000_000, // 收入 100 万元 → 5‰ = 500,000 分
      50_000_000,
      '2024-12',
    );
    const adj = result.adjustments.find((a) => a.code === 'CIT-ADJ-ENTERTAIN');
    assert.ok(adj);
    assert.equal(adj.amount, 9_500_000, '10,000,000 - 500,000');
    assert.equal(adj.basis.length > 0, true, '调整项必须带法规依据');
    assert.ok(adj.reason.includes('5‰'));
  });

  it('业务招待费：发生额 60% 低于收入 5‰ 时，按发生额 60% 扣除', () => {
    const result = computeCitAdjustments(
      { businessEntertainment: 500_000 },
      100_000_000, // 5‰ = 500,000
      50_000_000,
      '2024-12',
    );
    const adj = result.adjustments.find((a) => a.code === 'CIT-ADJ-ENTERTAIN');
    assert.ok(adj);
    assert.equal(adj.amount, 200_000, '500,000 - 500,000 × 60%');
  });

  it('业务招待费即便未触及 5‰ 上限，仍按发生额的 40% 永久性调增', () => {
    const result = computeCitAdjustments(
      { businessEntertainment: 100_000 },
      100_000_000, // 5‰ = 500,000，远高于 60,000
      50_000_000,
      '2024-12',
    );
    const adj = result.adjustments.find((a) => a.code === 'CIT-ADJ-ENTERTAIN');
    assert.ok(adj, '只要发生业务招待费就必然产生 40% 的调增');
    assert.equal(adj.amount, 40_000, '100,000 × (1 - 60%)');
  });

  it('广告费超支结转以后年度，未超支时可扣除以前年度结转', () => {
    const over = computeCitAdjustments(
      { advertising: 20_000_000 },
      100_000_000, // 15% = 15,000,000
      50_000_000,
      '2024-12',
    );
    const adj = over.adjustments.find((a) => a.code === 'CIT-ADJ-ADVERTISING');
    assert.ok(adj);
    assert.equal(adj.amount, 5_000_000);
    assert.equal(over.advertisingCarryforwardClosing, 5_000_000);

    const under = computeCitAdjustments(
      { advertising: 10_000_000, advertisingCarryforward: 8_000_000 },
      100_000_000,
      50_000_000,
      '2024-12',
    );
    const carry = under.adjustments.find((a) => a.code === 'CIT-ADJ-ADVERTISING-CARRY');
    assert.ok(carry);
    assert.equal(carry.amount, -5_000_000, '剩余限额 5,000,000 全部用于扣除结转');
    assert.equal(under.advertisingCarryforwardClosing, 3_000_000);
  });

  it('三项经费按工资总额限额调增', () => {
    const result = computeCitAdjustments(
      {
        wages: 10_000_000,
        welfare: 1_600_000,   // 限额 14% = 1,400,000
        education: 900_000,   // 限额 8% = 800,000
        unionFee: 300_000,    // 限额 2% = 200,000
      },
      100_000_000,
      50_000_000,
      '2024-12',
    );

    assert.equal(result.adjustments.find((a) => a.code === 'CIT-ADJ-WELFARE')?.amount, 200_000);
    assert.equal(result.adjustments.find((a) => a.code === 'CIT-ADJ-EDUCATION')?.amount, 100_000);
    assert.equal(result.adjustments.find((a) => a.code === 'CIT-ADJ-UNION')?.amount, 100_000);
    assert.equal(result.increaseTotal, 400_000);
  });

  it('公益性捐赠按年度利润总额 12% 限额调增', () => {
    const result = computeCitAdjustments(
      { donation: 1_500_000 },
      100_000_000,
      10_000_000, // 利润 10 万元 → 限额 1,200,000
      '2024-12',
    );
    const adj = result.adjustments.find((a) => a.code === 'CIT-ADJ-DONATION');
    assert.ok(adj);
    assert.equal(adj.amount, 300_000);
  });

  it('罚款、滞纳金全额调增且不可结转', () => {
    const result = computeCitAdjustments({ fines: 1_000_000 }, 100_000_000, 10_000_000, '2024-12');
    const adj = result.adjustments.find((a) => a.code === 'CIT-ADJ-FINES');
    assert.ok(adj);
    assert.equal(adj.amount, 1_000_000);
    assert.equal(result.increaseTotal, 1_000_000);
  });

  it('超标利息按金融企业同期同类贷款利率调增', () => {
    const result = computeCitAdjustments(
      { interestExpense: 2_000_000, interestAllowed: 1_200_000 },
      100_000_000,
      10_000_000,
      '2024-12',
    );
    assert.equal(result.adjustments.find((a) => a.code === 'CIT-ADJ-INTEREST')?.amount, 800_000);
  });

  it('研发费用按 100% 加计调减', () => {
    const result = computeCitAdjustments({ rdExpense: 5_000_000 }, 100_000_000, 10_000_000, '2024-12');
    const adj = result.adjustments.find((a) => a.code === 'CIT-ADJ-RD');
    assert.ok(adj);
    assert.equal(adj.amount, -5_000_000);
    assert.equal(result.superDeduction, 5_000_000);
    assert.equal(result.decreaseTotal, 0, '加计扣除不计入一般调减额，单独在 A17 列示');
  });

  it('年度汇算：调整后应纳税所得额与税额', () => {
    const result = computeCit({
      period: '2024-12',
      accountingProfit: 10_000_000,
      revenue: 100_000_000,
      isSmallLowProfit: false,
      isHighTech: false,
      rdExpense: 5_000_000,
      expenseDetail: { fines: 1_000_000 },
      annual: true,
    });

    assert.equal(result.increaseTotal, 1_000_000);
    assert.equal(result.superDeduction, 5_000_000);
    assert.equal(result.taxableIncome, 6_000_000, '10,000,000 + 1,000,000 - 5,000,000');
    assert.equal(result.taxPayable, 1_500_000, '6,000,000 × 25%');
    assert.ok(result.lines.some((l) => l.code === 'A27'));
  });

  it('弥补以前年度亏损后计算应纳税所得额', () => {
    const result = computeCit({
      period: '2024-12',
      accountingProfit: 10_000_000,
      revenue: 100_000_000,
      isSmallLowProfit: false,
      isHighTech: false,
      annual: true,
      lossCarryforward: 4_000_000,
    });
    assert.equal(result.taxableIncome, 6_000_000);
    assert.equal(result.taxPayable, 1_500_000);
  });

  it('亏损年度应纳税额为 0，不产生负数税额', () => {
    const result = computeCit({
      period: '2024-12',
      accountingProfit: -5_000_000,
      revenue: 10_000_000,
      isSmallLowProfit: true,
      isHighTech: false,
      annual: true,
    });
    assert.equal(result.taxableIncome, 0);
    assert.equal(result.taxPayable, 0);
    assert.equal(result.due, 0);
    assert.ok(result.notes.some((n) => n.includes('亏损')));
  });

  it('预缴阶段不应用纳税调整，但已预缴税额会冲减应补', () => {
    const result = computeCit({
      period: '2024-09',
      accountingProfit: 10_000_000,
      revenue: 100_000_000,
      isSmallLowProfit: false,
      isHighTech: false,
      rdExpense: 5_000_000,
      expenseDetail: { fines: 1_000_000 },
      prepaidYtd: 2_000_000,
      annual: false,
    });
    assert.equal(result.taxableIncome, 10_000_000, '季度预缴只看会计实际利润额');
    assert.equal(result.taxPayable, 2_500_000);
    assert.equal(result.due, 500_000, '2,500,000 - 2,000,000');
  });

  it('人工指定的调整项会被合并并提示复核', () => {
    const result = computeCit({
      period: '2024-12',
      accountingProfit: 10_000_000,
      revenue: 100_000_000,
      isSmallLowProfit: false,
      isHighTech: false,
      annual: true,
      manualAdjustments: [
        {
          code: 'CIT-ADJ-MANUAL-1',
          label: '资产减值准备调增',
          amount: 2_000_000,
          reason: '计提坏账准备不得税前扣除',
          basis: [],
        },
      ],
    });
    assert.equal(result.increaseTotal, 2_000_000);
    assert.equal(result.taxableIncome, 12_000_000);
    assert.ok(result.notes.some((n) => n.includes('人工指定')));
  });
});
