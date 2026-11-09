/**
 * 期末结转：损益结转、固定资产折旧、无形资产与长期待摊费用摊销。
 *
 * 为什么这块必须做：只会「按单据生成凭证」的系统只能算半自动记账。
 * 真实月结里，会计每个月都要做这几件事，缺一件就出不了报表：
 *   1. 计提折旧（固定资产）
 *   2. 摊销（无形资产、长期待摊费用）
 *   3. 结转损益到本年利润
 * 这里把它们做成可审计、可复算的纯函数：给定同样的输入，永远得到同样的输出。
 *
 * 精度原则：折旧按「月」直线法，逐月取整到分；最后一个月用「总额 - 已提累计」兜底，
 * 确保整个使用期内累计折旧恰好等于「原值 - 残值」，不会因为四舍五入差几分钱。
 */

import type { Cents, Period, Provenance, Voucher, VoucherLine } from "../core/contracts.ts";

export interface FixedAsset {
  /** 资产编号 */
  id: string;
  name: string;
  /** 原值（分） */
  originalCost: Cents;
  /** 预计使用月数 */
  usefulLifeMonths: number;
  /** 预计净残值率，0-1，如 0.05 */
  salvageRate: number;
  /** 开始计提的期间 YYYY-MM（当月增加次月计提，所以这里填「次月」） */
  startPeriod: Period;
  /** 已计提月数（台账里维护，用于中途启用的资产） */
  monthsDepreciated?: number;
  /** 部门，用于辅助核算 */
  department?: string;
  /** 资产科目，默认 1601.02 */
  assetAccount?: string;
  /** 累计折旧科目，默认 1602 */
  depreciationAccount?: string;
  /** 费用科目，默认 6602.10（管理费用-折旧费） */
  expenseAccount?: string;
}

export interface DepreciationLine {
  assetId: string;
  name: string;
  /** 本月折旧额（分） */
  amount: Cents;
  /** 截至本月累计折旧（分） */
  accumulated: Cents;
  /** 剩余可提月数，0 表示已提完 */
  remainingMonths: number;
  department?: string;
  expenseAccount: string;
  assetAccount: string;
  depreciationAccount: string;
}

/** 单月折旧额（理论值，未考虑尾差）。 */
export function monthlyDepreciation(asset: FixedAsset): Cents {
  if (asset.usefulLifeMonths <= 0) return 0;
  const depreciable = asset.originalCost - Math.round(asset.originalCost * asset.salvageRate);
  if (depreciable <= 0) return 0;
  return Math.round(depreciable / asset.usefulLifeMonths);
}

/** 应计提总月数。 */
export function totalMonths(asset: FixedAsset): number {
  return Math.max(0, Math.floor(asset.usefulLifeMonths));
}

/** 把 YYYY-MM 转成自 0 年起的月序号，便于做月份差。 */
function monthIndex(period: Period): number {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m === null) throw new Error("会计期间格式应为 YYYY-MM，实际为 " + period);
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

/**
 * 计算某个期间的折旧明细。
 *
 * 折旧从 startPeriod 当月起计提，共 totalMonths 个月。
 * 最后一个月用「应提总额 - 已提累计」封口，消除逐步取整的尾差。
 */
export function depreciationForPeriod(assets: readonly FixedAsset[], period: Period): DepreciationLine[] {
  const out: DepreciationLine[] = [];
  const target = monthIndex(period);

  for (const asset of assets) {
    const start = monthIndex(asset.startPeriod);
    if (target < start) continue;

    const total = totalMonths(asset);
    const elapsedBefore = asset.monthsDepreciated ?? 0;
    const monthNo = target - start + 1 + elapsedBefore; // 第几个月
    if (monthNo < 1 || monthNo > total) continue;

    const depreciable = asset.originalCost - Math.round(asset.originalCost * asset.salvageRate);
    const perMonth = monthlyDepreciation(asset);
    const accumulatedBefore = Math.min(depreciable, perMonth * (monthNo - 1));
    // 最后一个月封口：把之前四舍五入的零头一次性补上
    const amount = monthNo === total ? depreciable - accumulatedBefore : perMonth;
    if (amount <= 0) continue;

    out.push({
      assetId: asset.id,
      name: asset.name,
      amount,
      accumulated: accumulatedBefore + amount,
      remainingMonths: total - monthNo,
      department: asset.department,
      expenseAccount: asset.expenseAccount ?? "6602.10",
      assetAccount: asset.assetAccount ?? "1601.02",
      depreciationAccount: asset.depreciationAccount ?? "1602",
    });
  }

  return out;
}

function voucherOf(
  id: string,
  date: string,
  period: Period,
  word: string,
  lines: VoucherLine[],
  rawSummary: string,
): Voucher {
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  return {
    id,
    date,
    period,
    word,
    lines,
    attachments: 1,
    balanced: totalDebit === totalCredit,
    totalDebit,
    totalCredit,
    source: { file: "(系统生成)", rawSummary },
    warnings: [],
  };
}

/** 取期间最后一天，作为计提凭证的记账日期。 */
export function periodLastDate(period: Period): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m === null) throw new Error("会计期间格式应为 YYYY-MM，实际为 " + period);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return period + "-" + String(days).padStart(2, "0");
}

/** 生成折旧凭证：借 费用-折旧费 / 贷 累计折旧。 */
export function buildDepreciationVoucher(
  lines: readonly DepreciationLine[],
  period: Period,
  word = "记",
): Voucher | null {
  if (lines.length === 0) return null;
  const date = periodLastDate(period);
  const source: Provenance = { file: "(系统生成)", rawSummary: "计提 " + period + " 固定资产折旧" };

  const voucherLines: VoucherLine[] = [];
  for (const line of lines) {
    voucherLines.push({
      accountCode: line.expenseAccount,
      accountName: "折旧费",
      debit: line.amount,
      credit: 0,
      summary: "计提折旧：" + line.name,
      auxiliary: line.department === undefined ? undefined : { department: line.department },
      source,
    });
  }
  // 累计折旧按科目合并，避免一张凭证里出现十几行同一个贷方科目
  const byAccount = new Map<string, Cents>();
  for (const line of lines) {
    byAccount.set(line.depreciationAccount, (byAccount.get(line.depreciationAccount) ?? 0) + line.amount);
  }
  for (const [account, amount] of byAccount) {
    voucherLines.push({
      accountCode: account,
      accountName: "累计折旧",
      debit: 0,
      credit: amount,
      summary: "计提 " + period + " 折旧",
      source,
    });
  }

  return voucherOf("DEP-" + period, date, period, word, voucherLines, "计提折旧");
}

/**
 * 结转损益：把所有损益类科目余额结转到本年利润。
 *
 * 规则：损益类科目（6001-6901）期末余额反向结平；
 * 收入类（贷方余额）→ 借 收入 / 贷 本年利润；
 * 费用类（借方余额）→ 借 本年利润 / 贷 费用。
 */
export function buildProfitCarryForward(
  balances: ReadonlyArray<{ accountCode: string; accountName: string; closing: Cents }>,
  period: Period,
  profitAccount = "4103",
  /**
   * 判断某科目是不是损益类。
   * 默认按企业会计准则的「6 开头」判断；小企业会计准则的损益类是 5 开头，
   * 而 5 开头在企业准则里是成本类（生产成本、制造费用），绝不能结转到本年利润。
   * 因此调用方应传入按科目表 category 判断的函数，而不是靠编码前缀猜。
   */
  isProfitAccount: (code: string) => boolean = (code) => code.startsWith("6"),
): { voucher: Voucher | null; profit: Cents } {
  const source: Provenance = { file: "(系统生成)", rawSummary: "结转 " + period + " 损益" };
  const lines: VoucherLine[] = [];
  let profit = 0;

  for (const b of balances) {
    if (!isProfitAccount(b.accountCode)) continue;
    if (b.closing === 0) continue;
    // closing = 借 - 贷；收入类为负（贷方余额），费用类为正
    const amount = Math.abs(b.closing);
    if (b.closing < 0) {
      // 贷方余额（收入）：借记该科目，结平
      lines.push({
        accountCode: b.accountCode, accountName: b.accountName,
        debit: amount, credit: 0, summary: "结转 " + period + " 损益", source,
      });
      profit += amount;
    } else {
      // 借方余额（成本费用）：贷记该科目，结平
      lines.push({
        accountCode: b.accountCode, accountName: b.accountName,
        debit: 0, credit: amount, summary: "结转 " + period + " 损益", source,
      });
      profit -= amount;
    }
  }

  if (lines.length === 0) return { voucher: null, profit: 0 };

  if (profit > 0) {
    lines.push({
      accountCode: profitAccount, accountName: "本年利润",
      debit: 0, credit: profit, summary: "结转本期利润", source,
    });
  } else if (profit < 0) {
    lines.push({
      accountCode: profitAccount, accountName: "本年利润",
      debit: -profit, credit: 0, summary: "结转本期亏损", source,
    });
  }

  return {
    voucher: voucherOf("CF-" + period, periodLastDate(period), period, "记", lines, "结转损益"),
    profit,
  };
}

export interface AmortizationItem {
  id: string;
  name: string;
  /** 待摊/无形资产原值（分） */
  originalCost: Cents;
  /** 摊销月数 */
  months: number;
  startPeriod: Period;
  monthsAmortized?: number;
  /** 资产科目，如 1801 长期待摊费用 / 1701 无形资产 */
  assetAccount: string;
  /** 摊销对方科目，如 6602.11 管理费用-摊销费 */
  expenseAccount: string;
  department?: string;
}

/** 计算某期间的摊销明细（与折旧同构，但无残值）。 */
export function amortizationForPeriod(items: readonly AmortizationItem[], period: Period): Array<{ item: AmortizationItem; amount: Cents; remainingMonths: number }> {
  const out: Array<{ item: AmortizationItem; amount: Cents; remainingMonths: number }> = [];
  const target = monthIndex(period);
  for (const item of items) {
    if (item.months <= 0) continue;
    const start = monthIndex(item.startPeriod);
    if (target < start) continue;
    const monthNo = target - start + 1 + (item.monthsAmortized ?? 0);
    if (monthNo < 1 || monthNo > item.months) continue;
    const perMonth = Math.round(item.originalCost / item.months);
    const before = Math.min(item.originalCost, perMonth * (monthNo - 1));
    const amount = monthNo === item.months ? item.originalCost - before : perMonth;
    if (amount <= 0) continue;
    out.push({ item, amount, remainingMonths: item.months - monthNo });
  }
  return out;
}

/** 生成摊销凭证：借 费用 / 贷 待摊或无形资产。 */
export function buildAmortizationVoucher(
  rows: ReadonlyArray<{ item: AmortizationItem; amount: Cents }>,
  period: Period,
): Voucher | null {
  if (rows.length === 0) return null;
  const source: Provenance = { file: "(系统生成)", rawSummary: "摊销 " + period };
  const lines: VoucherLine[] = [];
  for (const row of rows) {
    lines.push({
      accountCode: row.item.expenseAccount, accountName: "摊销费",
      debit: row.amount, credit: 0, summary: "摊销：" + row.item.name,
      auxiliary: row.item.department === undefined ? undefined : { department: row.item.department },
      source,
    });
    lines.push({
      accountCode: row.item.assetAccount, accountName: row.item.name,
      debit: 0, credit: row.amount, summary: "摊销：" + row.item.name, source,
    });
  }
  return voucherOf("AM-" + period, periodLastDate(period), period, "记", lines, "摊销");
}
