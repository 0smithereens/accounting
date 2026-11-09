/**
 * 集成层基础件的单元测试：期间运算、账簿快照、企业档案。
 *
 * 这些是报表与税务的取数地基，算错了上面全错，所以单独覆盖边界。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  parsePeriod, formatPeriod, previousPeriod, nextPeriod, sameMonthLastYear,
  quarterOf, quarterMonths, isQuarterEnd, isYearEnd, periodStart, periodEnd,
  periodsYearToDate, comparePeriod, PeriodError,
} from "../src/app/period.ts";
import { buildLedgerSnapshot, applyVirtualClosing, balanceOf, isBalanced, openingFromPrior } from "../src/app/ledger.ts";
import { loadCompanyProfile } from "../src/app/company.ts";
import { PROJECT_ROOT } from "../src/core/config.ts";
import type { Voucher } from "../src/core/contracts.ts";

function makeVoucher(id: string, date: string, lines: Array<[string, number, number]>): Voucher {
  const mapped = lines.map(([accountCode, debit, credit]) => ({
    accountCode,
    accountName: accountCode,
    debit: Math.round(debit * 100),
    credit: Math.round(credit * 100),
    summary: "测试",
    source: { file: "test" },
  }));
  const totalDebit = mapped.reduce((s, l) => s + l.debit, 0);
  const totalCredit = mapped.reduce((s, l) => s + l.credit, 0);
  return {
    id, date, period: date.slice(0, 7), word: id,
    lines: mapped, attachments: 1, balanced: totalDebit === totalCredit,
    totalDebit, totalCredit, source: { file: "test" }, warnings: [],
  };
}

describe("期间运算", () => {
  test("解析与格式化", () => {
    assert.deepEqual(parsePeriod("2024-03"), { year: 2024, month: 3 });
    assert.equal(formatPeriod(2024, 3), "2024-03");
    assert.equal(formatPeriod(999, 9), "0999-09");
    assert.throws(() => parsePeriod("2024-13"), PeriodError);
    assert.throws(() => parsePeriod("202403"), PeriodError);
  });

  test("上一期跨年", () => {
    assert.equal(previousPeriod("2024-01"), "2023-12");
    assert.equal(previousPeriod("2024-03"), "2024-02");
    assert.equal(nextPeriod("2024-12"), "2025-01");
    assert.equal(sameMonthLastYear("2024-07"), "2023-07");
  });

  test("季度归属与季末", () => {
    assert.equal(quarterOf("2024-01"), 1);
    assert.equal(quarterOf("2024-04"), 2);
    assert.equal(quarterOf("2024-09"), 3);
    assert.equal(quarterOf("2024-12"), 4);
    assert.deepEqual(quarterMonths("2024-05"), ["2024-04", "2024-05", "2024-06"]);
    assert.equal(isQuarterEnd("2024-03"), true);
    assert.equal(isQuarterEnd("2024-04"), false);
    assert.equal(isYearEnd("2024-12"), true);
  });

  test("期间首末日（含闰年）", () => {
    assert.equal(periodStart("2024-02"), "2024-02-01");
    assert.equal(periodEnd("2024-02"), "2024-02-29");
    assert.equal(periodEnd("2023-02"), "2023-02-28");
    assert.equal(periodEnd("2024-04"), "2024-04-30");
    assert.equal(periodEnd("2024-12"), "2024-12-31");
  });

  test("年初至今与比较", () => {
    assert.deepEqual(periodsYearToDate("2024-03"), ["2024-01", "2024-02", "2024-03"]);
    assert.equal(comparePeriod("2024-01", "2024-02"), -1);
    assert.equal(comparePeriod("2024-02", "2024-02"), 0);
    assert.equal(comparePeriod("2024-03", "2024-02"), 1);
  });
});

describe("账簿快照", () => {
  test("本期发生额与期末余额", () => {
    const vouchers = [
      makeVoucher("记-1", "2024-03-05", [["1002", 1000, 0], ["6001", 0, 1000]]),
      makeVoucher("记-2", "2024-03-20", [["6602", 300, 0], ["1002", 0, 300]]),
    ];
    const snap = buildLedgerSnapshot({ period: "2024-03", standard: "cas", vouchers });
    assert.equal(snap.balances.length, 3);
    const cash = snap.balances.find((b) => b.accountCode === "1002");
    assert.equal(cash?.debitTotal, 100000);
    assert.equal(cash?.creditTotal, 30000);
    assert.equal(cash?.closing, 70000);
    assert.equal(snap.vouchers.length, 2);
  });

  test("跨期凭证不计入本期发生额", () => {
    const vouchers = [
      makeVoucher("记-1", "2024-02-28", [["1002", 500, 0], ["6001", 0, 500]]),
      makeVoucher("记-2", "2024-03-01", [["1002", 100, 0], ["6001", 0, 100]]),
    ];
    const snap = buildLedgerSnapshot({ period: "2024-03", standard: "cas", vouchers });
    const cash = snap.balances.find((b) => b.accountCode === "1002");
    assert.equal(cash?.debitTotal, 10000);
  });

  test("期初余额结转", () => {
    const vouchers = [makeVoucher("记-1", "2024-03-05", [["1002", 200, 0], ["6001", 0, 200]])];
    const snap = buildLedgerSnapshot({
      period: "2024-03", standard: "cas", vouchers,
      opening: { "1002": 80000, "4001": -80000 },
    });
    const cash = snap.balances.find((b) => b.accountCode === "1002");
    assert.equal(cash?.opening, 80000);
    assert.equal(cash?.closing, 100000);
    assert.equal(snap.openingBalanced, true);
  });

  test("期初有余额但本期无发生额的科目仍出现在快照里", () => {
    const snap = buildLedgerSnapshot({
      period: "2024-03", standard: "small", vouchers: [], opening: { "1601": 500000 },
    });
    assert.equal(snap.balances.length, 1);
    assert.equal(snap.balances[0]?.closing, 500000);
  });

  test("下级明细合计", () => {
    const snap = buildLedgerSnapshot({
      period: "2024-03", standard: "cas",
      vouchers: [
        makeVoucher("记-1", "2024-03-01", [["1002.01", 100, 0], ["4001", 0, 100]]),
        makeVoucher("记-2", "2024-03-02", [["1002.02", 200, 0], ["4001", 0, 200]]),
      ],
    });
    assert.equal(balanceOf(snap, "1002"), 30000);
    assert.equal(balanceOf(snap, "1002.01"), 10000);
    assert.equal(balanceOf(snap, "1002.03"), 0);
  });

  test("虚拟结转损益到本年利润", () => {
    const snap = buildLedgerSnapshot({
      period: "2024-03", standard: "cas",
      vouchers: [
        makeVoucher("记-1", "2024-03-01", [["1002", 1000, 0], ["6001", 0, 1000]]),
        makeVoucher("记-2", "2024-03-02", [["6602", 400, 0], ["1002", 0, 400]]),
      ],
    });
    const closed = applyVirtualClosing(snap);
    const profit = closed.balances.find((b) => b.accountCode === "4103");
    assert.equal(profit?.closing, 60000);
  });

  test("借贷平衡判断", () => {
    assert.equal(isBalanced([makeVoucher("记-1", "2024-03-01", [["1002", 100, 0], ["4001", 0, 100]])]), true);
    assert.equal(isBalanced([makeVoucher("记-2", "2024-03-01", [["1002", 100, 0], ["4001", 0, 90]])]), false);
  });

  test("上期期末取作本期期初", () => {
    const prior = buildLedgerSnapshot({
      period: "2024-02", standard: "cas",
      vouchers: [makeVoucher("记-1", "2024-02-01", [["1002", 500, 0], ["4001", 0, 500]])],
    });
    const opening = openingFromPrior(prior);
    assert.equal(opening["1002"], 50000);
    assert.equal(opening["4001"], -50000);
  });
});

describe("企业档案", () => {
  test("缺文件时返回安全默认（小微、小规模）", () => {
    const dir = mkdtempSync(join(PROJECT_ROOT, ".test-tmp-"));
    try {
      const p = loadCompanyProfile(dir);
      assert.equal(p.kind, "small_scale");
      assert.equal(p.isSmallLowProfit, true);
      assert.equal(p.cityTaxRate, 0.07);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("正常解析并把元换算成分", () => {
    const dir = mkdtempSync(join(PROJECT_ROOT, ".test-tmp-"));
    try {
      writeFileSync(join(dir, "company.yaml"), [
        "company:",
        "  name: 测试科技有限公司",
        "  taxId: \"91110000MA00000001\"",
        "  kind: general",
        "  cityTaxRate: 0.05",
        "  employees: 120",
        "  totalAssets: 12345.67",
        "  rdExpense: 500000",
        "  isHighTech: true",
        "  isSmallLowProfit: false",
      ].join("\n"));
      const p = loadCompanyProfile(dir);
      assert.equal(p.name, "测试科技有限公司");
      assert.equal(p.kind, "general");
      assert.equal(p.cityTaxRate, 0.05);
      assert.equal(p.totalAssets, 1234567);
      assert.equal(p.rdExpense, 50000000);
      assert.equal(p.isHighTech, true);
      assert.equal(p.isSmallLowProfit, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("非法纳税人身份报错", () => {
    const dir = mkdtempSync(join(PROJECT_ROOT, ".test-tmp-"));
    try {
      writeFileSync(join(dir, "company.yaml"), "company:\n  kind: 一般纳税人\n");
      assert.throws(() => loadCompanyProfile(dir), /kind/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("非法城建税税率报错", () => {
    const dir = mkdtempSync(join(PROJECT_ROOT, ".test-tmp-"));
    try {
      writeFileSync(join(dir, "company.yaml"), "company:\n  cityTaxRate: 0.03\n");
      assert.throws(() => loadCompanyProfile(dir), /cityTaxRate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
