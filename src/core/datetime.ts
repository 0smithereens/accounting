/**
 * 日期与会计期间处理。
 *
 * 难点在于单据上的日期格式极其混乱：
 *  - Excel 日期序列号（45000）
 *  - 2024-01-05 / 2024/1/5 / 20240105 / 2024.1.5
 *  - 2024年1月5日
 *  - 1月5日（缺年份，需按凭证期间补全）
 *  - 2024年1月（只有年月）
 */

const MS_PER_DAY = 86_400_000;
/** Excel 1900 日期系统的起点偏移量（含 Excel 的 1900 闰年 bug 修正）。 */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/** 判断是否为合法日期字符串（YYYY-MM-DD）。 */
export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

/** Excel 日期序列号 → YYYY-MM-DD。 */
export function excelSerialToDateString(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  // 合理区间：1900-01-01 (1) ~ 2100-12-31 (73415)
  if (serial < 1 || serial > 80000) return null;
  // Excel 错误地把 1900 当作闰年，序列号 60 是不存在的 1900-02-29。
  const adjusted = serial >= 61 ? serial : serial + 1;
  const ms = EXCEL_EPOCH_UTC + adjusted * MS_PER_DAY;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return toDateString(d);
}

function toDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localDateToString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface ParseDateOptions {
  /** 缺省年份，用于「1月5日」这类不含年份的文本 */
  defaultYear?: number;
  /** 缺省年月，用于只有日的情况 */
  defaultMonth?: number;
}

/**
 * 尽最大努力把任意输入解析为 YYYY-MM-DD。
 * 解析失败返回 null —— 调用方应记入 warnings 而不是猜一个日期。
 */
export function parseDate(input: unknown, options: ParseDateOptions = {}): string | null {
  if (input === null || input === undefined) return null;

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    // ExcelJS 返回的日期通常已按本地时区构造，用本地字段更稳
    return localDateToString(input);
  }

  if (typeof input === 'number') {
    return excelSerialToDateString(input);
  }

  let s = String(input).trim();
  if (s === '') return null;

  // 全角转半角
  s = s
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .trim();

  // 去掉时间部分
  s = s.replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i, '');

  // 纯数字：可能是序列号，也可能是 20240105
  if (/^\d+$/.test(s)) {
    if (s.length === 8) {
      const y = Number(s.slice(0, 4));
      const m = Number(s.slice(4, 6));
      const d = Number(s.slice(6, 8));
      const candidate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (isValidDateString(candidate)) return candidate;
    }
    if (s.length === 6) {
      // 202401 → 取当月 1 日
      const y = Number(s.slice(0, 4));
      const m = Number(s.slice(4, 6));
      const candidate = `${y}-${String(m).padStart(2, '0')}-01`;
      if (isValidDateString(candidate)) return candidate;
    }
    const serial = Number(s);
    if (s.length >= 5) return excelSerialToDateString(serial);
    return null;
  }

  // 归一化分隔符
  const normalized = s.replace(/[年月]/g, '-').replace(/日/g, '').replace(/[./\\]/g, '-');
  const parts = normalized.split('-').map((p) => p.trim()).filter((p) => p !== '');

  if (parts.length >= 3) {
    const [yRaw, mRaw, dRaw] = parts as [string, string, string];
    let y = Number(yRaw);
    // 两位年份：00-68 视为 2000 年代，69-99 视为 1900 年代
    if (yRaw.length === 2) y = y <= 68 ? 2000 + y : 1900 + y;
    // 不猜测「月日是否写反」：财务凭据上把年月日认错比认不出来更危险，
    // 遇到 2024-13-01 这类非法日期一律返回 null，交给上层记入 warnings。
    const candidate = `${y}-${String(Number(mRaw)).padStart(2, '0')}-${String(Number(dRaw)).padStart(2, '0')}`;
    if (isValidDateString(candidate)) return candidate;
    return null;
  }

  if (parts.length === 2) {
    const [aRaw, bRaw] = parts as [string, string];
    const a = Number(aRaw);
    const b = Number(bRaw);
    if (aRaw.length === 4) {
      // 2024-01 → 当月 1 日
      const candidate = `${a}-${String(b).padStart(2, '0')}-01`;
      return isValidDateString(candidate) ? candidate : null;
    }
    // 1-5 → 月-日，需要缺省年份
    if (options.defaultYear === undefined) return null;
    const candidate = `${options.defaultYear}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
    return isValidDateString(candidate) ? candidate : null;
  }

  return null;
}

/** 从任意文本中「抠」出第一个日期，用于摘要字段里夹带日期的情况。 */
export function extractDateFromText(text: string, options: ParseDateOptions = {}): string | null {
  const patterns = [
    /(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/,
    /(\d{4})(\d{2})(\d{2})(?!\d)/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const candidate = `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
    if (isValidDateString(candidate)) return candidate;
  }
  if (options.defaultYear !== undefined) {
    const m = /(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/.exec(text);
    if (m) {
      const candidate = `${options.defaultYear}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
      if (isValidDateString(candidate)) return candidate;
    }
  }
  return null;
}

/** YYYY-MM-DD → YYYY-MM 会计期间。 */
export function periodOf(date: string): string {
  return date.slice(0, 7);
}

/** 日期加减天数。 */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateString(d);
}

/** 会计期间字符串校验。 */
export function isValidPeriod(s: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12;
}

/** 取会计期间的月初、月末。 */
export function periodRange(period: string): { start: string; end: string } {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    start: `${period}-01`,
    end: `${period}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** 比较两个日期字符串，a < b 返回负数。 */
export function compareDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 判断日期是否落在闭区间内。 */
export function inRange(date: string, from?: string, to?: string): boolean {
  if (from !== undefined && date < from) return false;
  if (to !== undefined && date > to) return false;
  return true;
}

/** 根据已解析出的日期列表推断主会计期间（取众数）。 */
export function inferPeriod(dates: readonly string[]): string | null {
  const counter = new Map<string, number>();
  for (const d of dates) {
    const p = periodOf(d);
    counter.set(p, (counter.get(p) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const [p, c] of counter) {
    if (c > bestCount) {
      best = p;
      bestCount = c;
    }
  }
  return best;
}
