/**
 * 规则引擎与凭证生成的单元测试。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DocumentRecord, Rule, VoucherLine } from '../src/core/types.ts';
import { buildLinesFromRule, evaluateCondition, matchRule, renderTemplate, resolveAmounts } from '../src/core/rules.ts';
import { loadConfig } from '../src/core/config.ts';
import { deduplicate } from '../src/core/dedup.ts';

function doc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'test-1',
    kind: 'bank',
    date: '2024-01-15',
    summary: '支付货款 东莞精密制造有限公司',
    amount: 113000,
    direction: 'out',
    counterparty: '东莞精密制造有限公司',
    netAmount: null,
    taxAmount: null,
    fields: {},
    source: { file: 'test.xlsx', sheet: 'Sheet1', row: 2 },
    warnings: [],
    ...overrides,
  };
}

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'test-rule',
    priority: 100,
    when: {},
    then: { entries: [] },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 条件求值                                                            */
/* ------------------------------------------------------------------ */

describe('evaluateCondition 条件求值', () => {
  const d = doc();

  it('摘要关键字匹配', () => {
    assert.equal(evaluateCondition({ summary: ['货款'] }, d).matched, true);
    assert.equal(evaluateCondition({ summary: ['工资'] }, d).matched, false);
  });

  it('摘要匹配忽略空格与全半角差异', () => {
    const spaced = doc({ summary: '支付 货 款' });
    assert.equal(evaluateCondition({ summary: ['货款'] }, spaced).matched, true);
  });

  it('多条件之间是「与」关系', () => {
    assert.equal(evaluateCondition({ summary: ['货款'], direction: 'out' }, d).matched, true);
    assert.equal(evaluateCondition({ summary: ['货款'], direction: 'in' }, d).matched, false);
  });

  it('方向与往来单位匹配', () => {
    assert.equal(evaluateCondition({ direction: 'out' }, d).matched, true);
    assert.equal(evaluateCondition({ counterparty: ['东莞'] }, d).matched, true);
    assert.equal(evaluateCondition({ counterparty: ['深圳'] }, d).matched, false);
  });

  it('金额区间以「元」为单位书写', () => {
    assert.equal(evaluateCondition({ amountMin: 1000, amountMax: 2000 }, d).matched, true);
    assert.equal(evaluateCondition({ amountMin: 2000 }, d).matched, false);
    assert.equal(evaluateCondition({ amountMax: 1000 }, d).matched, false);
  });

  it('日期区间', () => {
    assert.equal(evaluateCondition({ dateFrom: '2024-01-01', dateTo: '2024-01-31' }, d).matched, true);
    assert.equal(evaluateCondition({ dateFrom: '2024-02-01' }, d).matched, false);
  });

  it('日期为空时日期条件不成立', () => {
    const noDate = doc({ date: null });
    assert.equal(evaluateCondition({ dateFrom: '2024-01-01' }, noDate).matched, false);
  });

  it('排除词', () => {
    assert.equal(evaluateCondition({ summary: ['货款'], summaryNot: ['退款'] }, d).matched, true);
    assert.equal(evaluateCondition({ summaryNot: ['货款'] }, d).matched, false);
  });

  it('字段精确匹配，含布尔值', () => {
    const withField = doc({ fields: { stage: 'payment', settled: true } });
    assert.equal(evaluateCondition({ fields: { stage: 'payment' } }, withField).matched, true);
    assert.equal(evaluateCondition({ fields: { stage: 'accrual' } }, withField).matched, false);
    assert.equal(evaluateCondition({ fields: { settled: true } }, withField).matched, true);
    assert.equal(evaluateCondition({ fields: { settled: false } }, withField).matched, false);
  });

  it('字段包含关键字', () => {
    const withField = doc({ fields: { category: '差旅费' } });
    assert.equal(evaluateCondition({ fieldContains: { category: ['差旅费', '办公费'] } }, withField).matched, true);
    assert.equal(evaluateCondition({ fieldContains: { category: ['水电费'] } }, withField).matched, false);
  });

  it('anyOf / allOf / not', () => {
    assert.equal(evaluateCondition({ anyOf: [{ summary: ['工资'] }, { summary: ['货款'] }] }, d).matched, true);
    assert.equal(evaluateCondition({ anyOf: [{ summary: ['工资'] }, { summary: ['报销'] }] }, d).matched, false);
    assert.equal(evaluateCondition({ allOf: [{ summary: ['货款'] }, { direction: 'out' }] }, d).matched, true);
    assert.equal(evaluateCondition({ allOf: [{ summary: ['货款'] }, { direction: 'in' }] }, d).matched, false);
    assert.equal(evaluateCondition({ not: { summary: ['工资'] } }, d).matched, true);
  });

  it('空条件匹配一切（配置错误检测依赖于此）', () => {
    assert.equal(evaluateCondition({}, d).matched, true);
  });

  it('非法正则不会抛异常，只判定为不匹配', () => {
    assert.equal(evaluateCondition({ summaryRegex: '([' }, d).matched, false);
  });

  it('正则可匹配摘要', () => {
    assert.equal(evaluateCondition({ summaryRegex: '^支付.*有限公司$' }, d).matched, true);
  });
});

/* ------------------------------------------------------------------ */
/* 模板渲染                                                            */
/* ------------------------------------------------------------------ */

describe('renderTemplate 占位符渲染', () => {
  it('渲染单据字段', () => {
    const d = doc({ fields: { department: '销售部', employee: '张伟' } });
    assert.equal(renderTemplate('{field.department}-{field.employee}', d), '销售部-张伟');
    assert.equal(renderTemplate('{summary}', d), d.summary);
    assert.equal(renderTemplate('{counterparty}', d), '东莞精密制造有限公司');
    assert.equal(renderTemplate('{amount}', d), '1130.00');
  });

  it('未知占位符渲染为空字符串', () => {
    assert.equal(renderTemplate('{unknown}', doc()), '');
    assert.equal(renderTemplate('{field.missing}', doc()), '');
  });
});

/* ------------------------------------------------------------------ */
/* 金额分配与配平                                                      */
/* ------------------------------------------------------------------ */

describe('resolveAmounts 金额分配', () => {
  it('total / net / tax 三种来源', () => {
    const d = doc({ amount: 113000, netAmount: 100000, taxAmount: 13000 });
    const { lines } = resolveAmounts(
      [
        { side: 'debit', account: '1403', amount: 'net' },
        { side: 'debit', account: '2221.01.01', amount: 'tax' },
        { side: 'credit', account: '2202', amount: 'total' },
      ],
      d,
    );
    assert.deepEqual(lines.map((l) => l.amount), [100000, 13000, 113000]);
  });

  it('未提供 net/tax 时，net 取全额、tax 取 0', () => {
    const d = doc({ amount: 5000 });
    const { lines } = resolveAmounts(
      [
        { side: 'debit', account: '6602.03', amount: 'net' },
        { side: 'debit', account: '2221.01.01', amount: 'tax' },
        { side: 'credit', account: '1002', amount: 'total' },
      ],
      d,
    );
    assert.deepEqual(lines.map((l) => l.amount), [5000, 0, 5000]);
  });

  it('taxRate 字段可驱动价税分离', () => {
    const d = doc({ amount: 106000, fields: { taxRate: 0.06 } });
    const { lines } = resolveAmounts(
      [
        { side: 'debit', account: '6602.10', amount: 'net' },
        { side: 'debit', account: '2221.01.01', amount: 'tax' },
        { side: 'credit', account: '1002', amount: 'total' },
      ],
      d,
    );
    assert.equal(lines[0]?.amount, 100000);
    assert.equal(lines[1]?.amount, 6000);
    assert.equal((lines[0]?.amount ?? 0) + (lines[1]?.amount ?? 0), lines[2]?.amount);
  });

  it('field.xxx 从专有字段取金额', () => {
    // 注意：fields 里存的是「元」为单位的文本，parseAmount 会换算成「分」
    const d = doc({ amount: 21100000, fields: { netPay: '150190.00', tax: '18355.00' } });
    const { lines } = resolveAmounts(
      [
        { side: 'debit', account: '2211.01', amount: 'total' },
        { side: 'credit', account: '1002', amount: 'field.netPay' },
        { side: 'credit', account: '2221.04', amount: 'field.tax' },
      ],
      d,
    );
    assert.deepEqual(lines.map((l) => l.amount), [21100000, 15019000, 1835500]);
  });

  it('field.xxx 字段缺失时按 0 处理并告警', () => {
    const d = doc({ amount: 1000, fields: {} });
    const { lines, warnings } = resolveAmounts(
      [
        { side: 'debit', account: '2211.01', amount: 'total' },
        { side: 'credit', account: '1002', amount: 'field.netPay' },
      ],
      d,
    );
    assert.equal(lines[1]?.amount, 0);
    assert.ok(warnings.some((w) => w.includes('netPay')));
  });

  it('balanced 自动补足借贷差额', () => {
    const d = doc({ amount: 10000 });
    const { lines } = resolveAmounts(
      [
        { side: 'debit', account: '6602.03', amount: 'total' },
        { side: 'credit', account: '1002', amount: 'total' },
        { side: 'credit', account: '2221.04', amount: 'balanced' },
      ],
      d,
    );
    assert.equal(lines[2]?.amount, 0);

    const r2 = resolveAmounts(
      [
        { side: 'debit', account: '6602.03', amount: 'total' },
        { side: 'credit', account: '1002', amount: 'balanced' },
      ],
      d,
    );
    assert.equal(r2.lines[1]?.amount, 10000);
  });

  it('balanced 配平分录金额为负时告警（借贷方向写反了）', () => {
    const d = doc({ amount: 10000 });
    const { warnings } = resolveAmounts(
      [
        { side: 'debit', account: '6602.03', amount: 'total' },
        { side: 'debit', account: '1002', amount: 'balanced' },
      ],
      d,
    );
    assert.ok(warnings.some((w) => w.includes('为负')), `应提示配平分录金额为负，实际告警：${warnings.join('；')}`);
  });
});

/* ------------------------------------------------------------------ */
/* 规则匹配                                                            */
/* ------------------------------------------------------------------ */

describe('matchRule 规则匹配', () => {
  it('按优先级从高到低取第一条命中的规则', () => {
    const rules: Rule[] = [
      rule({ id: 'low', priority: 10, when: { summary: ['货款'] } }),
      rule({ id: 'high', priority: 900, when: { summary: ['货款'] } }),
      rule({ id: 'mid', priority: 100, when: { summary: ['货款'] } }),
    ];
    assert.equal(matchRule(rules, doc())?.rule.id, 'high');
  });

  it('kinds 限定适用单据类型', () => {
    const rules: Rule[] = [
      rule({ id: 'only-payroll', priority: 900, kinds: ['payroll'], when: { summary: ['货款'] } }),
    ];
    assert.equal(matchRule(rules, doc({ kind: 'bank' })), null);
    assert.equal(matchRule(rules, doc({ kind: 'payroll' }))?.rule.id, 'only-payroll');
  });

  it('没有规则命中时返回 null', () => {
    assert.equal(matchRule([rule({ when: { summary: ['不存在的关键字'] } })], doc()), null);
  });
});

describe('buildLinesFromRule 生成分录', () => {
  it('生成带科目、摘要与辅助核算的分录', () => {
    const r = rule({
      then: {
        entries: [
          {
            side: 'debit',
            account: '6602.05',
            amount: 'total',
            summary: '支付水电费',
            auxiliary: { department: '{field.department}' },
          },
          { side: 'credit', account: '1002', amount: 'total' },
        ],
      },
    });
    const d = doc({ amount: 843260, fields: { department: '行政部' } });
    const { lines } = buildLinesFromRule(r, d);

    assert.equal(lines.length, 2);
    const debit = lines[0] as VoucherLine;
    assert.equal(debit.accountCode, '6602.05');
    assert.equal(debit.debit, 843260);
    assert.equal(debit.credit, 0);
    assert.equal(debit.auxiliary?.department, '行政部');
    assert.equal(debit.source.ruleId, 'test-rule');
    assert.equal((lines[1] as VoucherLine).credit, 843260);
  });

  it('全部分录金额为 0 时告警', () => {
    const r = rule({
      then: { entries: [{ side: 'debit', account: '1901', amount: 'tax' }, { side: 'credit', account: '1901', amount: 'tax' }] },
    });
    const d = doc({ amount: 0 });
    const { warnings } = buildLinesFromRule(r, d);
    assert.ok(warnings.some((w) => w.includes('所有分录金额都是 0')));
  });
});

/* ------------------------------------------------------------------ */
/* 配置加载                                                            */
/* ------------------------------------------------------------------ */

describe('配置加载', () => {
  const config = loadConfig();

  it('加载会计科目表并推断父子关系', () => {
    assert.ok(config.accounts.accounts.length > 100);
    assert.equal(config.accounts.get('1002')?.leaf, false, '1002 有下级，不应是明细科目');
    assert.equal(config.accounts.get('1002.01')?.leaf, true);
    assert.equal(config.accounts.fullName('6602.05'), '管理费用/水电费');
  });

  it('上级科目按 defaultChild 自动下钻到明细科目', () => {
    const resolved = config.accounts.resolve('1002');
    assert.equal(resolved.code, '1002.01');
    assert.equal(resolved.changed, true);
    assert.equal(resolved.problem, undefined);
  });

  it('明细科目不需要下钻', () => {
    const resolved = config.accounts.resolve('6602.05');
    assert.equal(resolved.code, '6602.05');
    assert.equal(resolved.changed, false);
  });

  it('不存在的科目给出问题说明', () => {
    const resolved = config.accounts.resolve('9999');
    assert.ok(resolved.problem?.includes('不在科目表中'));
  });

  it('加载规则且优先级已排序', () => {
    assert.ok(config.rules.rules.length > 50);
    for (let i = 1; i < config.rules.rules.length; i += 1) {
      const prev = config.rules.rules[i - 1]?.priority ?? 0;
      const curr = config.rules.rules[i]?.priority ?? 0;
      assert.ok(prev >= curr, `规则优先级未降序排列：${prev} < ${curr}`);
    }
  });

  it('规则 id 全局唯一', () => {
    const ids = new Set<string>();
    for (const r of config.rules.rules) {
      assert.ok(!ids.has(r.id), `规则 id 重复：${r.id}`);
      ids.add(r.id);
    }
  });

  it('所有规则引用的静态科目都存在且可下钻到明细科目', () => {
    for (const r of config.rules.rules) {
      for (const entry of r.then.entries) {
        if (entry.account.includes('{')) continue;
        const resolved = config.accounts.resolve(entry.account);
        assert.equal(
          resolved.problem,
          undefined,
          `规则 ${r.id} 引用的科目 ${entry.account} 有问题：${resolved.problem ?? ''}`,
        );
      }
    }
  });

  it('加载去重配置', () => {
    assert.equal(config.dedup.enabled, true);
    assert.ok(config.dedup.pairs.length > 0);
  });
});

/* ------------------------------------------------------------------ */
/* 跨单据去重                                                          */
/* ------------------------------------------------------------------ */

describe('deduplicate 跨单据去重', () => {
  const config = loadConfig();

  function payrollDoc(grossCents: number, netPayYuan: string): DocumentRecord {
    return doc({
      id: 'payroll-payment',
      kind: 'payroll',
      summary: '2024-01 工资发放 共 10 人',
      amount: grossCents,
      direction: 'out',
      date: '2024-01-01',
      fields: { stage: 'payment', netPay: netPayYuan },
      source: { file: 'payroll.xlsx' },
    });
  }

  function bankDoc(amount: number, summary: string, date: string): DocumentRecord {
    return doc({
      id: `bank-${summary}`,
      kind: 'bank',
      summary,
      amount,
      direction: 'out',
      date,
      source: { file: 'bank.xlsx' },
    });
  }

  it('金额按 amountField 指定的字段比对（应发 vs 实发）', () => {
    // 工资表发放单据总额是应发 211000 元，但银行代发的是实发 150190 元
    const payroll = payrollDoc(21100000, '150190.00');
    const bank = bankDoc(15019000, '代发工资', '2024-01-08');
    const result = deduplicate([payroll, bank], config.dedup);

    assert.equal(result.dropped.length, 1);
    assert.equal(result.dropped[0]?.document.id, 'bank-代发工资');
    assert.equal(result.documents.length, 1);
    assert.equal(result.issues[0]?.level, 'info');
  });

  it('金额不同则不去重（保守策略）', () => {
    const payroll = payrollDoc(21100000, '150190.00');
    const bank = bankDoc(20000000, '代发工资', '2024-01-08');
    assert.equal(deduplicate([payroll, bank], config.dedup).dropped.length, 0);
  });

  it('日期超出窗口则不去重', () => {
    const payroll = payrollDoc(21100000, '150190.00');
    const bank = bankDoc(15019000, '代发工资', '2024-03-08');
    assert.equal(deduplicate([payroll, bank], config.dedup).dropped.length, 0);
  });

  it('没有工资表时不误删银行流水（银行代发仍会生成凭证）', () => {
    const bank = bankDoc(15019000, '代发工资', '2024-01-08');
    const result = deduplicate([bank], config.dedup);
    assert.equal(result.dropped.length, 0);
    assert.equal(result.documents.length, 1);
  });

  it('关闭去重后不做任何处理', () => {
    const payroll = payrollDoc(21100000, '150190.00');
    const bank = bankDoc(15019000, '代发工资', '2024-01-08');
    const result = deduplicate([payroll, bank], { enabled: false, pairs: config.dedup.pairs });
    assert.equal(result.dropped.length, 0);
    assert.equal(result.documents.length, 2);
  });
});
