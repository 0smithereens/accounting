/**
 * 金额与日期解析的单元测试。
 *
 * 这两块是整个系统的正确性基石：金额算错一分钱，凭证就不能用；
 * 日期认错一天，期间就错一个月。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  allocate,
  centsEqual,
  formatChineseAmount,
  formatYuan,
  formatYuanGrouped,
  parseAmount,
  parseChineseAmount,
  splitTax,
  sumCents,
} from '../src/core/money.ts';
import {
  addDays,
  excelSerialToDateString,
  extractDateFromText,
  inferPeriod,
  inRange,
  isValidDateString,
  isValidPeriod,
  parseDate,
  periodOf,
  periodRange,
} from '../src/core/datetime.ts';

/* ------------------------------------------------------------------ */
/* 金额解析                                                            */
/* ------------------------------------------------------------------ */

describe('parseAmount 金额解析', () => {
  it('解析数字', () => {
    assert.equal(parseAmount(1234.56), 123456);
    assert.equal(parseAmount(0), 0);
    assert.equal(parseAmount(-98.7), -9870);
  });

  it('解析带千分位与货币符号的文本', () => {
    assert.equal(parseAmount('1,234.56'), 123456);
    assert.equal(parseAmount('¥1,234.56'), 123456);
    assert.equal(parseAmount('￥ 1,234.56 元'), 123456);
    assert.equal(parseAmount('1234.56元'), 123456);
    assert.equal(parseAmount('人民币1,234.56'), 123456);
  });

  it('解析会计负数写法', () => {
    assert.equal(parseAmount('(1,234.56)'), -123456);
    assert.equal(parseAmount('（1234.56）'), -123456);
    assert.equal(parseAmount('1234.56-'), -123456);
    assert.equal(parseAmount('-1234.56'), -123456);
  });

  it('解析全角数字', () => {
    assert.equal(parseAmount('１２３４．５６'), 123456);
  });

  it('小数超过两位时四舍五入', () => {
    assert.equal(parseAmount('1.005'), 101);
    assert.equal(parseAmount('1.004'), 100);
    assert.equal(parseAmount('0.999'), 100);
  });

  it('非法输入返回 null 而不是抛异常或猜数', () => {
    assert.equal(parseAmount(null), null);
    assert.equal(parseAmount(undefined), null);
    assert.equal(parseAmount(''), null);
    assert.equal(parseAmount('   '), null);
    assert.equal(parseAmount('abc'), null);
    assert.equal(parseAmount('N/A'), null);
    assert.equal(parseAmount('#REF!'), null);
    assert.equal(parseAmount(Number.NaN), null);
    assert.equal(parseAmount(Number.POSITIVE_INFINITY), null);
  });

  it('避免浮点误差：0.1 + 0.2 类问题不会出现在分单位上', () => {
    const a = parseAmount(0.1) as number;
    const b = parseAmount(0.2) as number;
    assert.equal(a + b, 30);
    assert.equal(formatYuan(a + b), '0.30');
  });
});

describe('人民币大写', () => {
  it('常见金额的大写转换', () => {
    assert.equal(formatChineseAmount(0), '零元整');
    assert.equal(formatChineseAmount(100), '壹元整');
    assert.equal(formatChineseAmount(123456), '壹仟贰佰叁拾肆元伍角陆分');
    assert.equal(formatChineseAmount(90400000), '玖拾万零肆仟元整');
    assert.equal(formatChineseAmount(100000000), '壹佰万元整');
    assert.equal(formatChineseAmount(110), '壹元壹角整');
    assert.equal(formatChineseAmount(101), '壹元零壹分');
  });

  it('大写金额可反向解析回分', () => {
    const cases = [100, 123456, 90400000, 100000000, 110, 101, 1234567890];
    for (const cents of cases) {
      const upper = formatChineseAmount(cents);
      const back = parseChineseAmount(upper);
      assert.equal(back, cents, `大写「${upper}」应能解析回 ${cents}，实际 ${String(back)}`);
    }
  });

  it('解析合同里常见的大写写法', () => {
    assert.equal(parseChineseAmount('玖拾万零肆仟元整'), 90400000);
    assert.equal(parseChineseAmount('壹万贰仟叁佰肆拾伍元陆角柒分'), 1234567);
    assert.equal(parseChineseAmount('贰拾柒万壹仟贰佰元整'), 27120000);
  });
});

describe('金额格式化', () => {
  it('formatYuan 保留两位小数', () => {
    assert.equal(formatYuan(123456), '1234.56');
    assert.equal(formatYuan(5), '0.05');
    assert.equal(formatYuan(0), '0.00');
    assert.equal(formatYuan(-123456), '-1234.56');
  });

  it('formatYuanGrouped 带千分位', () => {
    assert.equal(formatYuanGrouped(123456789), '1,234,567.89');
    assert.equal(formatYuanGrouped(100), '1.00');
    assert.equal(formatYuanGrouped(-100000000), '-1,000,000.00');
  });
});

/* ------------------------------------------------------------------ */
/* 分摊与价税分离                                                      */
/* ------------------------------------------------------------------ */

describe('allocate 金额分摊', () => {
  it('分摊后各份之和必须等于原金额', () => {
    const cases: Array<[number, number[]]> = [
      [100, [1, 1, 1]],
      [1001, [1, 1, 1]],
      [100, [1, 2, 3]],
      [99999, [7, 11, 13]],
      [-100, [1, 1, 1]],
    ];
    for (const [amount, weights] of cases) {
      const parts = allocate(amount, weights);
      assert.equal(parts.length, weights.length);
      assert.equal(
        sumCents(parts),
        amount,
        `分摊 ${amount} 按 ${weights.join(':')} 得到 ${parts.join('+')}，合计应为 ${amount}`,
      );
    }
  });

  it('权重为零时均分', () => {
    const parts = allocate(100, [0, 0, 0]);
    assert.equal(sumCents(parts), 100);
    assert.deepEqual(parts, [34, 33, 33]);
  });
});

describe('splitTax 价税分离', () => {
  it('不含税金额 + 税额 = 价税合计（不允许丢分）', () => {
    const totals = [113000, 21800, 53000, 904000, 127200, 99999, 1, 3];
    const rates = [0.13, 0.09, 0.06, 0.03, 0.01];
    for (const total of totals) {
      for (const rate of rates) {
        const { net, tax } = splitTax(total, rate);
        assert.equal(
          net + tax,
          total,
          `含税 ${total} 按 ${rate} 拆分得到 ${net}+${tax}，合计应为 ${total}`,
        );
      }
    }
  });

  it('税率为 0 时全额作为不含税金额', () => {
    assert.deepEqual(splitTax(10000, 0), { net: 10000, tax: 0 });
  });

  it('13% 价税合计 113000 应拆为 100000 + 13000', () => {
    assert.deepEqual(splitTax(113000, 0.13), { net: 100000, tax: 13000 });
  });
});

describe('centsEqual', () => {
  it('默认要求完全相等', () => {
    assert.equal(centsEqual(100, 100), true);
    assert.equal(centsEqual(100, 101), false);
  });
  it('可指定容差', () => {
    assert.equal(centsEqual(100, 101, 1), true);
  });
});

/* ------------------------------------------------------------------ */
/* 日期                                                                */
/* ------------------------------------------------------------------ */

describe('parseDate 日期解析', () => {
  it('解析各种中文与西文日期写法', () => {
    const expected = '2024-01-05';
    for (const input of [
      '2024-01-05', '2024/1/5', '2024.1.5', '2024年1月5日',
      '2024年01月05日', '20240105', '2024-1-5',
    ]) {
      assert.equal(parseDate(input), expected, `「${input}」应解析为 ${expected}`);
    }
  });

  it('解析 ISO 时间戳并去掉时间部分', () => {
    assert.equal(parseDate('2024-01-05T13:45:00'), '2024-01-05');
    assert.equal(parseDate('2024-01-05 13:45:00'), '2024-01-05');
    assert.equal(parseDate('2024-01-05 13:45:00.000Z'), '2024-01-05');
  });

  it('解析 Excel 日期序列号', () => {
    assert.equal(excelSerialToDateString(45296), '2024-01-05');
    assert.equal(parseDate(45296), '2024-01-05');
  });

  it('解析 Date 对象', () => {
    assert.equal(parseDate(new Date(2024, 0, 5)), '2024-01-05');
  });

  it('两位年份按 00-68 → 2000 年代处理', () => {
    assert.equal(parseDate('24-01-05'), '2024-01-05');
    assert.equal(parseDate('99-01-05'), '1999-01-05');
  });

  it('缺年份时可传默认年份', () => {
    assert.equal(parseDate('1月5日', { defaultYear: 2024 }), '2024-01-05');
    assert.equal(parseDate('1月5日'), null);
  });

  it('只给年月时取当月 1 日', () => {
    assert.equal(parseDate('2024-01'), '2024-01-01');
    assert.equal(parseDate('202401'), '2024-01-01');
    assert.equal(parseDate('2024年1月'), '2024-01-01');
  });

  it('非法日期返回 null 而不是猜一个', () => {
    assert.equal(parseDate('2024-02-30'), null);
    assert.equal(parseDate('2024-13-01'), null);
    assert.equal(parseDate(''), null);
    assert.equal(parseDate(null), null);
    assert.equal(parseDate('尚无日期'), null);
    assert.equal(parseDate(0), null);
    assert.equal(parseDate(999999), null);
  });
});

describe('extractDateFromText', () => {
  it('从摘要里抠出日期', () => {
    assert.equal(extractDateFromText('2024年1月5日 收到货款'), '2024-01-05');
    assert.equal(extractDateFromText('合同编号HT-001 签订于2024/01/16'), '2024-01-16');
    assert.equal(extractDateFromText('没有日期'), null);
  });
});

describe('会计期间工具', () => {
  it('periodOf 取年月', () => {
    assert.equal(periodOf('2024-01-05'), '2024-01');
  });

  it('periodRange 给出月初月末', () => {
    assert.deepEqual(periodRange('2024-01'), { start: '2024-01-01', end: '2024-01-31' });
    assert.deepEqual(periodRange('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
    assert.deepEqual(periodRange('2023-02'), { start: '2023-02-01', end: '2023-02-28' });
  });

  it('isValidPeriod 校验格式', () => {
    assert.equal(isValidPeriod('2024-01'), true);
    assert.equal(isValidPeriod('2024-13'), false);
    assert.equal(isValidPeriod('2024-1'), false);
  });

  it('isValidDateString 校验闰年', () => {
    assert.equal(isValidDateString('2024-02-29'), true);
    assert.equal(isValidDateString('2023-02-29'), false);
    assert.equal(isValidDateString('2024-2-9'), false);
  });

  it('addDays 跨月跨年', () => {
    assert.equal(addDays('2024-01-31', 1), '2024-02-01');
    assert.equal(addDays('2024-12-31', 1), '2025-01-01');
    assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  });

  it('inRange 判断闭区间', () => {
    assert.equal(inRange('2024-01-15', '2024-01-01', '2024-01-31'), true);
    assert.equal(inRange('2024-02-01', '2024-01-01', '2024-01-31'), false);
    assert.equal(inRange('2024-01-01', '2024-01-01', undefined), true);
  });

  it('inferPeriod 取众数期间', () => {
    assert.equal(inferPeriod(['2024-01-05', '2024-01-20', '2024-02-01']), '2024-01');
    assert.equal(inferPeriod([]), null);
  });
});
