/**
 * 期末结转的单元测试。
 *
 * 重点盯两件事：金额一分不差、凭证一定借贷平衡。
 * 折旧的尾差处理最容易出错，所以专门覆盖「最后一个月封口」与「长期累计」。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  monthlyDepreciation, depreciationForPeriod, buildDepreciationVoucher,
  buildProfitCarryForward, amortizationForPeriod, buildAmortizationVoucher,
  periodLastDate, type FixedAsset, type AmortizationItem,
} from "../src/ledger/closing.ts";

function asset(over: Partial<FixedAsset> = {}): FixedAsset {
  return {
    id: "FA-001",
    name: "数控设备",
    originalCost: 12000000, // 12 万元
    usefulLifeMonths: 120,
    salvageRate: 0.05,
    startPeriod: "2024-01",
    ...over,
  };
}

describe("固定资产折旧", () => {
  test("月折旧额 = (原值 - 残值) / 月数", () => {
    // (12000000 - 600000) / 120 = 95000 分 = 950 元
    assert.equal(monthlyDepreciation(asset()), 95000);
  });

  test("使用年限为 0 时不折旧", () => {
    assert.equal(monthlyDepreciation(asset({ usefulLifeMonths: 0 })), 0);
  });

  test("残值率过高导致可折旧额为 0 时不折旧", () => {
    assert.equal(monthlyDepreciation(asset({ salvageRate: 1 })), 0);
  });

  test("起始期间之前不计提", () => {
    assert.equal(depreciationForPeriod([asset()], "2023-12").length, 0);
  });

  test("起始当月开始计提", () => {
    const rows = depreciationForPeriod([asset()], "2024-01");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.amount, 95000);
    assert.equal(rows[0]?.remainingMonths, 119);
  });

  test("超过使用月数后停止计提", () => {
    assert.equal(depreciationForPeriod([asset()], "2034-01").length, 0);
  });

  test("最后一个月封口，累计恰好等于应提总额", () => {
    // 用 7 个月摊销 100 元：10000/7 = 1428.57，前面取 1428，尾差在最后一个月补齐
    const a = asset({ originalCost: 10000, salvageRate: 0, usefulLifeMonths: 7 });
    let accumulated = 0;
    for (let m = 1; m <= 7; m += 1) {
      const period = "2024-" + String(m).padStart(2, "0");
      const rows = depreciationForPeriod([a], period);
      assert.equal(rows.length, 1);
      accumulated += rows[0]?.amount ?? 0;
    }
    assert.equal(accumulated, 10000);
  });

  test("中途启用（monthsDepreciated）从中间接续", () => {
    const a = asset({ monthsDepreciated: 60 });
    const rows = depreciationForPeriod([a], "2024-01");
    assert.equal(rows[0]?.remainingMonths, 120 - 61);
  });

  test("折旧凭证借贷平衡且贷方按科目合并", () => {
    const rows = depreciationForPeriod([asset(), asset({ id: "FA-002", name: "车辆", originalCost: 6000000, usefulLifeMonths: 60 })], "2024-01");
    const v = buildDepreciationVoucher(rows, "2024-01");
    assert.notEqual(v, null);
    assert.equal(v?.balanced, true);
    assert.equal(v?.totalDebit, v?.totalCredit);
    const creditLines = v?.lines.filter((l) => l.credit > 0) ?? [];
    assert.equal(creditLines.length, 1); // 同一个 1602 合并成一行
  });

  test("没有折旧时不生成凭证", () => {
    assert.equal(buildDepreciationVoucher([], "2024-01"), null);
  });
});

describe("损益结转", () => {
  test("收入大于费用时结转为本年利润（贷方）", () => {
    const r = buildProfitCarryForward([
      { accountCode: "6001", accountName: "主营业务收入", closing: -10000000 },
      { accountCode: "6401", accountName: "主营业务成本", closing: 6000000 },
    ], "2024-01");
    assert.equal(r.profit, 4000000);
    assert.equal(r.voucher?.balanced, true);
    const profitLine = r.voucher?.lines.find((l) => l.accountCode === "4103");
    assert.equal(profitLine?.credit, 4000000);
  });

  test("费用大于收入时结转为本年亏损（借方）", () => {
    const r = buildProfitCarryForward([
      { accountCode: "6001", accountName: "主营业务收入", closing: -1000000 },
      { accountCode: "6602", accountName: "管理费用", closing: 3000000 },
    ], "2024-01");
    assert.equal(r.profit, -2000000);
    const profitLine = r.voucher?.lines.find((l) => l.accountCode === "4103");
    assert.equal(profitLine?.debit, 2000000);
  });

  test("无损益发生时不生成凭证", () => {
    const r = buildProfitCarryForward([{ accountCode: "1002", accountName: "银行存款", closing: 100 }], "2024-01");
    assert.equal(r.voucher, null);
    assert.equal(r.profit, 0);
  });

  test("余额为零的损益科目不产生分录", () => {
    const r = buildProfitCarryForward([
      { accountCode: "6001", accountName: "主营", closing: 0 },
      { accountCode: "6401", accountName: "成本", closing: 0 },
    ], "2024-01");
    assert.equal(r.voucher, null);
  });
});

describe("摊销", () => {
  test("按期摊销并在最后一个月封口", () => {
    const item: AmortizationItem = {
      id: "AM-1", name: "装修费", originalCost: 10000, months: 3,
      startPeriod: "2024-01", assetAccount: "1801", expenseAccount: "6602.11",
    };
    const r1 = amortizationForPeriod([item], "2024-01");
    const r2 = amortizationForPeriod([item], "2024-02");
    const r3 = amortizationForPeriod([item], "2024-03");
    const total = (r1[0]?.amount ?? 0) + (r2[0]?.amount ?? 0) + (r3[0]?.amount ?? 0);
    assert.equal(total, 10000);
    assert.equal(amortizationForPeriod([item], "2024-04").length, 0);
  });

  test("摊销凭证平衡", () => {
    const item: AmortizationItem = {
      id: "AM-1", name: "装修费", originalCost: 30000, months: 3,
      startPeriod: "2024-01", assetAccount: "1801", expenseAccount: "6602.11",
    };
    const rows = amortizationForPeriod([item], "2024-01");
    const v = buildAmortizationVoucher(rows, "2024-01");
    assert.equal(v?.balanced, true);
    assert.equal(v?.lines.length, 2);
  });
});

describe("期间末日", () => {
  test("闰年 2 月", () => {
    assert.equal(periodLastDate("2024-02"), "2024-02-29");
    assert.equal(periodLastDate("2023-02"), "2023-02-28");
    assert.equal(periodLastDate("2024-12"), "2024-12-31");
  });
});
