/**
 * 会计期间运算。
 *
 * 为什么单独一个文件而不塞进 core/datetime.ts：
 *  datetime.ts 处理的是「一个日期怎么解析」，这里处理的是「一个期间处在
 *  哪个季度、哪一年、上期是什么」——是税务申报周期与报表对比列的业务规则，
 *  混进去会让 datetime 承担它不该承担的领域知识。
 */

import type { IsoDate, Period } from "../core/contracts.ts";

export class PeriodError extends Error {}

/** 解析 YYYY-MM，非法时抛错。 */
export function parsePeriod(period: Period): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m === null) throw new PeriodError("会计期间格式应为 YYYY-MM，实际为 " + period);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new PeriodError("会计期间月份非法：" + period);
  return { year, month };
}

export function formatPeriod(year: number, month: number): Period {
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0");
}

/** 上一期。跨年时自动回退到上一年 12 月。 */
export function previousPeriod(period: Period): Period {
  const { year, month } = parsePeriod(period);
  return month === 1 ? formatPeriod(year - 1, 12) : formatPeriod(year, month - 1);
}

/** 下一期。 */
export function nextPeriod(period: Period): Period {
  const { year, month } = parsePeriod(period);
  return month === 12 ? formatPeriod(year + 1, 1) : formatPeriod(year, month + 1);
}

/** 上年同期（报表对比列用）。 */
export function sameMonthLastYear(period: Period): Period {
  const { year, month } = parsePeriod(period);
  return formatPeriod(year - 1, month);
}

/** 所属季度：1-4。 */
export function quarterOf(period: Period): 1 | 2 | 3 | 4 {
  const { month } = parsePeriod(period);
  if (month <= 3) return 1;
  if (month <= 6) return 2;
  if (month <= 9) return 3;
  return 4;
}

/** 所属年度。 */
export function yearOf(period: Period): number {
  return parsePeriod(period).year;
}

/** 季度的三个月份。 */
export function quarterMonths(period: Period): Period[] {
  const { year } = parsePeriod(period);
  const q = quarterOf(period);
  const start = (q - 1) * 3 + 1;
  return [formatPeriod(year, start), formatPeriod(year, start + 1), formatPeriod(year, start + 2)];
}

/** 该季度最后一个月（判断是否为季末申报期）。 */
export function isQuarterEnd(period: Period): boolean {
  const { month } = parsePeriod(period);
  return month === 3 || month === 6 || month === 9 || month === 12;
}

/** 是否为年度最后一个月（企业所得税汇算、年报）。 */
export function isYearEnd(period: Period): boolean {
  return parsePeriod(period).month === 12;
}

/** 期间首日。 */
export function periodStart(period: Period): IsoDate {
  return period + "-01";
}

/** 期间末日。用 Date 的「第 0 天」技巧拿到当月天数。 */
export function periodEnd(period: Period): IsoDate {
  const { year, month } = parsePeriod(period);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return period + "-" + String(days).padStart(2, "0");
}

/** 年度起始期间：YYYY-01。 */
export function fiscalYearStart(period: Period): Period {
  return formatPeriod(yearOf(period), 1);
}

/** 从年初到该期间的期间列表（用于累计数）。 */
export function periodsYearToDate(period: Period): Period[] {
  const { year, month } = parsePeriod(period);
  const out: Period[] = [];
  for (let m = 1; m <= month; m += 1) out.push(formatPeriod(year, m));
  return out;
}

/** 判断两个期间的大小关系：-1 表示 a 早于 b。 */
export function comparePeriod(a: Period, b: Period): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
