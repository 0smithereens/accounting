/**
 * 金额处理。
 *
 * 会计系统的第一原则：金额绝不用浮点数运算。
 * 本模块统一以「分」为单位的整数（Cents）表示金额，
 * 所有解析、格式化、分摊、汇总都在整数域完成。
 */

import type { Cents } from './types.ts';

/** 安全整数上限，约 90 万亿元，远超任何真实账簿规模。 */
const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/** 全角字符转半角，并去掉货币符号、千分位、空白。 */
function cleanNumericText(input: string): string {
  // 全角转半角
  let s = input.replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  s = s.replace(/\u3000/g, ' ');
  // 常见货币符号与单位
  s = s.replace(/[¥￥$€£]/g, '');
  s = s.replace(/(人民币|元|圆|角|分整|整)/g, '');
  s = s.replace(/[,\s'_]/g, '');
  return s.trim();
}

/**
 * 解析金额文本为「分」。
 *
 * 支持：
 *  - 数字型：1234.56
 *  - 字符串： "1,234.56" / "¥1,234.56" / "1234.56元"
 *  - 会计负数写法： "(1234.56)" / "1234.56-"
 *  - 全角数字与符号
 *  - 空值 / 非数字 → null
 */
export function parseAmount(input: unknown): Cents | null {
  if (input === null || input === undefined) return null;

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }

  if (typeof input === 'boolean') return null;

  let s = String(input);
  if (s.trim() === '') return null;

  let negative = false;

  // 会计负数：括号包裹
  const parenMatch = /^\s*[(（]\s*(.+?)\s*[)）]\s*$/.exec(s);
  if (parenMatch && parenMatch[1] !== undefined) {
    negative = true;
    s = parenMatch[1];
  }

  s = cleanNumericText(s);

  // 会计负数：尾随减号
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (s.startsWith('+')) {
    s = s.slice(1);
  }

  if (s === '' || !/^\d*\.?\d*$/.test(s) || s === '.') {
    // 允许纯汉字大写金额
    const fromChinese = parseChineseAmount(input);
    if (fromChinese !== null) return fromChinese;
    return null;
  }

  const dotIndex = s.indexOf('.');
  let intPart = dotIndex === -1 ? s : s.slice(0, dotIndex);
  let fracPart = dotIndex === -1 ? '' : s.slice(dotIndex + 1);
  if (intPart === '') intPart = '0';

  // 超过两位小数的按四舍五入处理
  if (fracPart.length > 2) {
    const keep = fracPart.slice(0, 2);
    const nextDigit = Number(fracPart[2] ?? '0');
    let cents = Number(intPart) * 100 + Number(keep);
    if (nextDigit >= 5) cents += 1;
    cents = negative ? -cents : cents;
    return checkSafe(cents);
  }

  fracPart = fracPart.padEnd(2, '0');
  const cents = Number(intPart) * 100 + Number(fracPart);
  if (!Number.isFinite(cents)) return null;
  return checkSafe(negative ? -cents : cents);
}

function checkSafe(cents: number): Cents {
  if (!Number.isSafeInteger(cents)) {
    throw new MoneyError(`金额超出安全范围: ${cents}`);
  }
  if (Math.abs(cents) > MAX_SAFE_CENTS) {
    throw new MoneyError(`金额超出安全范围: ${cents}`);
  }
  return cents;
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0,
  壹: 1, 一: 1, 贰: 2, 二: 2, 两: 2,
  叁: 3, 三: 3, 肆: 4, 四: 4,
  伍: 5, 五: 5, 陆: 6, 六: 6,
  柒: 7, 七: 7, 捌: 8, 八: 8,
  玖: 9, 九: 9,
};

const CN_UNITS: Record<string, number> = {
  分: 0.01,
  角: 0.1,
  元: 1, 圆: 1,
  拾: 10, 十: 10,
  佰: 100, 百: 100,
  仟: 1000, 千: 1000,
  万: 10000,
  亿: 100000000,
};

/**
 * 解析人民币中文大写金额，如「壹万贰仟叁佰肆拾伍元陆角柒分」。
 * 主要用于交叉校验合同、支票、凭证上的大写金额。
 */
export function parseChineseAmount(input: unknown): Cents | null {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/[\s,，]/g, '');
  if (s === '') return null;
  if (!/[零〇壹贰叁肆伍陆柒捌玖一二三四五六七八九]/.test(s)) return null;
  if (!/[元圆分角整]/.test(s)) return null;

  let total = 0;      // 累计到「分」
  let section = 0;    // 当前节（万以下）
  let number = 0;     // 当前数字
  let seenUnit = false;

  for (const ch of s) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch] as number;
      continue;
    }
    const unit = CN_UNITS[ch];
    if (unit === undefined) continue;
    seenUnit = true;

    if (unit === 10000 || unit === 100000000) {
      section = (section + number) * unit;
      if (unit === 100000000) {
        total += section;
        section = 0;
      }
      number = 0;
      continue;
    }

    if (unit < 1) {
      // 角、分
      section += number * unit;
      number = 0;
      continue;
    }

    // 拾佰仟元
    section += (number === 0 && !seenUnit ? 1 : number) * unit;
    number = 0;
  }

  const yuanTotal = total + section + number;
  return Math.round(yuanTotal * 100);
}

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

/** 分 → 元字符串，保留两位小数，无千分位。 */
export function formatYuan(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  return `${negative ? '-' : ''}${yuan}.${String(fen).padStart(2, '0')}`;
}

/** 分 → 带千分位的元字符串，用于报表展示。 */
export function formatYuanGrouped(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${String(fen).padStart(2, '0')}`;
}

const CN_UPPER_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];

/** 分 → 人民币大写，如「壹万贰仟叁佰肆拾伍元陆角柒分」。 */
export function formatChineseAmount(cents: Cents): string {
  if (cents === 0) return '零元整';

  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const jiao = Math.floor((abs % 100) / 10);
  const fen = abs % 10;

  let yuanText = yuan === 0 ? '' : yuanToChineseUppercase(yuan);

  if (jiao === 0 && fen === 0) {
    return `${negative ? '负' : ''}${yuanText === '' ? '零元' : `${yuanText}元`}整`;
  }

  let tail: string;
  if (jiao === 0) {
    // 有分无角：必须补「零」，如 1.01 → 壹元零壹分
    tail = `零${CN_UPPER_DIGITS[fen]}分`;
  } else {
    tail = `${CN_UPPER_DIGITS[jiao]}角`;
    tail += fen === 0 ? '整' : `${CN_UPPER_DIGITS[fen]}分`;
  }

  return `${negative ? '负' : ''}${yuanText === '' ? '' : `${yuanText}元`}${tail}`;
}

const CN_UPPER_UNITS = ['', '拾', '佰', '仟'];
const CN_UPPER_SECTIONS = ['', '万', '亿', '万亿'];

/**
 * 整数元 → 中文大写数字（不含「元」字与角分）。
 *
 * 关键规则：阿拉伯数字中间有 0 时，中文大写要写「零」字。
 * 因此 904000 必须写成「玖拾万零肆仟」而不是「玖拾万肆仟」
 * （依据：中国人民银行《正确填写票据和结算凭证的基本规定》）。
 *
 * 做法是逐位处理并记录「是否有待补的零」，而不是按四位一节直接拼接，
 * 否则节与节之间的零会被漏掉。
 */
function yuanToChineseUppercase(yuan: number): string {
  const digits = String(yuan);
  const n = digits.length;
  let result = '';
  let zeroPending = false;

  for (let i = 0; i < n; i += 1) {
    const d = Number(digits[i]);
    const pos = n - 1 - i;              // 从右往左数第几位（0 = 个位）
    const inSection = pos % 4;          // 在本节内的位置
    const sectionIndex = Math.floor(pos / 4);

    if (d === 0) {
      zeroPending = true;
    } else {
      if (zeroPending && result !== '') result += '零';
      zeroPending = false;
      result += CN_UPPER_DIGITS[d] + (CN_UPPER_UNITS[inSection] ?? '');
    }

    // 走到某一节的个位时，若该节内有非零数字，补上节单位（万/亿）
    if (inSection === 0 && pos > 0) {
      let sectionHasNonZero = false;
      for (let k = 0; k < 4 && i - k >= 0; k += 1) {
        if (Number(digits[i - k]) !== 0) {
          sectionHasNonZero = true;
          break;
        }
      }
      if (sectionHasNonZero) {
        result += CN_UPPER_SECTIONS[sectionIndex] ?? '';
        // 注意：这里不能清掉 zeroPending。
        // 904000 的「万」位是 0，节单位后面仍需补「零」→ 玖拾万零肆仟
      }
    }
  }

  return result.replace(/零+$/, '');
}

/* ------------------------------------------------------------------ */
/* 运算                                                                */
/* ------------------------------------------------------------------ */

export function sumCents(list: readonly Cents[]): Cents {
  let total = 0;
  for (const c of list) total += c;
  return total;
}

/**
 * 按权重把一个金额拆分到多份，保证各份之和恰好等于原金额。
 * 用最大余数法分配尾差，避免出现 0.01 元的对不上账。
 */
export function allocate(amount: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0) return [];
  // 归一化 -0：IEEE754 下 (-0) + 0 === +0，避免结果里出现 "-0.00"
  const total = amount + 0;
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) {
    // 权重全零：均分
    const base = Math.floor(total / weights.length);
    const result = new Array<Cents>(weights.length).fill(base);
    let remainder = total - base * weights.length;
    for (let i = 0; i < result.length && remainder !== 0; i += 1) {
      const step = remainder > 0 ? 1 : -1;
      result[i] = (result[i] as number) + step;
      remainder -= step;
    }
    return result;
  }

  const raw = weights.map((w) => (total * w) / weightSum);
  const floored = raw.map((v) => Math.floor(v) + 0);
  let remainder = total - floored.reduce((a, b) => a + b, 0);

  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);

  const result = floored.slice();
  for (const { i } of order) {
    if (remainder <= 0) break;
    result[i] = (result[i] as number) + 1;
    remainder -= 1;
  }
  return result;
}

/**
 * 价税分离：按税率把含税金额拆成不含税金额与税额。
 * 结果满足 net + tax === total。
 */
export function splitTax(
  total: Cents,
  taxRate: number,
): { net: Cents; tax: Cents } {
  if (taxRate <= 0) return { net: total, tax: 0 };
  const net = Math.round(total / (1 + taxRate));
  return { net, tax: total - net };
}

/** 判断两个金额是否相等（分整数，无需容差，保留接口以便将来支持容差配置）。 */
export function centsEqual(a: Cents, b: Cents, tolerance = 0): boolean {
  return Math.abs(a - b) <= tolerance;
}
