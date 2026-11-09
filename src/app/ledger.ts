/**
 * 账簿快照构建。
 *
 * 为什么要有「快照」而不是让各模块各自去遍历凭证：
 *  报表、税务、审核三个引擎必须用**完全一致**的口径取数，否则会出现
 *  「报表说利润 100 万，所得税却按 90 万算」这种致命不一致。
 *  统一在这里算一次，三边共用同一份数字。
 *
 * 符号约定（全项目统一）：
 *  closing = opening + debitTotal - creditTotal
 *  资产/成本类科目余额在借方 → closing 为正；
 *  负债/权益/损益类科目余额在贷方 → closing 为负。
 *  报表模块按科目方向取负号还原，税务模块按需要取绝对值。
 */

import type {
  AccountingStandardId,
  Cents,
  LedgerBalance,
  LedgerSnapshot,
  Period,
  Voucher,
} from '../core/contracts.ts';

export interface BuildSnapshotInput {
  period: Period;
  standard: AccountingStandardId;
  vouchers: readonly Voucher[];
  /** 期初余额（分，按上面的符号约定）。缺省视为 0。 */
  opening?: Readonly<Record<string, Cents>>;
  /** 科目名称解析函数（编码 → 名称）。缺省用凭证上的名称。 */
  accountName?: (code: string) => string;
  /** 期初是否已结平。缺省按 opening 合计是否为 0 推算。 */
  openingBalanced?: boolean;
}

/**
 * 构建账簿快照。
 *
 * 只统计 date 落在 period 内的凭证；跨期凭证会在审核阶段被单独抓出来，
 * 这里不静默丢弃也不静默纳入，保持「快照 = 本期发生额」的纯粹语义。
 */
export function buildLedgerSnapshot(input: BuildSnapshotInput): LedgerSnapshot {
  const buckets = new Map<string, { name: string; debit: Cents; credit: Cents }>();

  for (const voucher of input.vouchers) {
    if (!voucher.date.startsWith(input.period)) continue;
    for (const line of voucher.lines) {
      const key = line.accountCode;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = {
          name: input.accountName?.(key) ?? line.accountName ?? key,
          debit: 0,
          credit: 0,
        };
        buckets.set(key, bucket);
      }
      bucket.debit += line.debit;
      bucket.credit += line.credit;
    }
  }

  // 期初有余额但本期无发生额的科目也要出现在快照里，否则报表会漏掉长期挂账科目
  for (const code of Object.keys(input.opening ?? {})) {
    if (!buckets.has(code)) {
      buckets.set(code, { name: input.accountName?.(code) ?? code, debit: 0, credit: 0 });
    }
  }

  const balances: LedgerBalance[] = [];
  for (const [code, bucket] of buckets) {
    const opening = input.opening?.[code] ?? 0;
    balances.push({
      accountCode: code,
      accountName: bucket.name,
      opening,
      debitTotal: bucket.debit,
      creditTotal: bucket.credit,
      closing: opening + bucket.debit - bucket.credit,
    });
  }
  balances.sort((a, b) => (a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : 0));

  const openingBalanced =
    input.openingBalanced ??
    Object.values(input.opening ?? {}).reduce((s, v) => s + v, 0) === 0;

  return {
    period: input.period,
    standard: input.standard,
    balances,
    vouchers: input.vouchers,
    openingBalanced,
  };
}

/** 把上一期的期末余额取出来，作为本期的期初。 */
export function openingFromPrior(prior: LedgerSnapshot): Record<string, Cents> {
  const opening: Record<string, Cents> = {};
  for (const b of prior.balances) {
    if (b.closing !== 0) opening[b.accountCode] = b.closing;
  }
  return opening;
}

/** 判断科目编码是否命中前缀（含下级明细，用点号分隔层级）。 */
function matchesPrefix(code: string, prefix: string): boolean {
  return code === prefix || code.startsWith(prefix + ".");
}

/**
 * 把损益类科目的发生额虚拟结转到本年利润（只改快照，不生成凭证）。
 *
 * 为什么需要：资产负债表的「未分配利润」要包含本期损益，
 * 但真实结转凭证要到期末才做。报表若不等结转就出，会出现
 * 「资产 ≠ 负债 + 权益」。这里只在快照上做一次内存结转，不动原始凭证。
 */
export function applyVirtualClosing(
  snapshot: LedgerSnapshot,
  profitAccount = "4103",
  /** 判断损益类科目。默认按企业准则的「6 开头」；小企业准则是 5 开头，必须由调用方传入 */
  isProfitAccount: (code: string) => boolean = (code) => code.startsWith("6"),
): LedgerSnapshot {
  let profit = 0;
  for (const b of snapshot.balances) {
    // closing = 借 - 贷，收益 = -closing
    if (isProfitAccount(b.accountCode)) profit += -b.closing;
  }
  if (profit === 0) return snapshot;

  const balances = snapshot.balances.map((b) => ({ ...b }));
  const existing = balances.find((b) => b.accountCode === profitAccount);
  if (existing !== undefined) {
    existing.closing += profit;
  } else {
    balances.push({
      accountCode: profitAccount,
      accountName: "本年利润",
      opening: 0,
      debitTotal: 0,
      creditTotal: 0,
      closing: profit,
    });
  }
  balances.sort((a, b) => (a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : 0));
  return { ...snapshot, balances };
}

/** 取某科目（含下级明细）的期末余额合计，按「借方为正」的符号返回。 */
export function balanceOf(snapshot: LedgerSnapshot, codePrefix: string): Cents {
  let total = 0;
  for (const b of snapshot.balances) {
    if (matchesPrefix(b.accountCode, codePrefix)) total += b.closing;
  }
  return total;
}

/** 借贷是否平衡（用于结账前校验）。 */
export function isBalanced(vouchers: readonly Voucher[]): boolean {
  let debit = 0;
  let credit = 0;
  for (const v of vouchers) {
    for (const line of v.lines) {
      debit += line.debit;
      credit += line.credit;
    }
  }
  return debit === credit;
}
