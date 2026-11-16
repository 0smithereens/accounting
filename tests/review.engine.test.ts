/**
 * 审核引擎（engine.ts）单元测试。
 *
 * 重点覆盖「引擎自己的逻辑」而不是某条检查项：
 *  - 评分口径（100 / -8 / -2 / -0.5 / 下限 0）
 *  - 同一 ruleId + target 去重
 *  - 严重度覆盖与检查项关闭
 *  - 人工豁免（warning 可豁免、error 不可豁免）
 *  - 阻断汇总与 assertReviewPassed
 *  - 报告渲染与配置加载
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ReviewFinding,
  ReviewInput,
  ReviewReport,
  Voucher,
  VoucherLine,
} from '../src/core/contracts.ts';
import { sumCents } from '../src/core/money.ts';
import { CONFIG_DIR } from '../src/core/config.ts';
import {
  LAW_LIBRARY,
  REVIEW_RULE_IDS,
  ReviewBlockedError,
  ReviewConfigError,
  ReviewInputError,
  ReviewWaiverError,
  assertReviewPassed,
  listChecks,
  loadReviewConfig,
  nowIsoDateTime,
  renderReviewMarkdown,
  renderReviewText,
  runReview,
} from '../src/review/index.ts';

/* ================================================================== */
/* 一、测试夹具                                                        */
/* ================================================================== */

const PERIOD = '2024-01';

function line(
  accountCode: string,
  debit: number,
  credit: number,
  summary = '支付办公室租金',
): VoucherLine {
  return {
    accountCode,
    accountName: accountCode,
    debit,
    credit,
    summary,
    source: { file: 'test.xlsx', sheet: 'Sheet1', row: 2 },
  };
}

function makeVoucher(overrides: Partial<Voucher> & { lines: VoucherLine[] }): Voucher {
  const totalDebit = sumCents(overrides.lines.map((item) => item.debit));
  const totalCredit = sumCents(overrides.lines.map((item) => item.credit));
  return {
    id: 'v-001',
    date: '2024-01-15',
    period: PERIOD,
    word: '记-0001',
    attachments: 1,
    balanced: totalDebit === totalCredit,
    totalDebit,
    totalCredit,
    source: { file: 'test.xlsx' },
    warnings: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return { period: PERIOD, standard: 'cas', vouchers: [], documents: [], ...overrides };
}

function findingsFor(report: ReviewReport, ruleId: string): ReviewFinding[] {
  return report.findings.filter((item) => item.ruleId === ruleId);
}

function singleFinding(report: ReviewReport, ruleId: string): ReviewFinding {
  const matched = findingsFor(report, ruleId);
  assert.equal(matched.length, 1, `期望 ${ruleId} 恰好 1 条结论，实际 ${matched.length} 条`);
  const first = matched[0];
  if (first === undefined) throw new Error(`${ruleId} 没有结论`);
  return first;
}

function expectNone(report: ReviewReport, ruleId: string): void {
  assert.equal(findingsFor(report, ruleId).length, 0, `期望 ${ruleId} 无结论`);
}

/** 借贷不平衡的凭证：借方 100，贷方 90，差额 10。 */
function unbalancedVoucher(id = 'v-001', word = '记-0001'): Voucher {
  return makeVoucher({
    id,
    word,
    lines: [line('6602.01', 100, 0), line('1002.01', 0, 90)],
  });
}

/** 仅触发「未附原始单据」warning 的凭证。 */
function noAttachmentVoucher(): Voucher {
  return makeVoucher({
    id: 'v-attach',
    word: '记-0002',
    attachments: 0,
    lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
  });
}

/* ================================================================== */
/* 二、基础运行与评分                                                  */
/* ================================================================== */

describe('runReview 基础行为与评分', () => {
  it('空输入得 100 分、结论通过、无任何问题', () => {
    const report = runReview(makeInput());
    assert.equal(report.findings.length, 0);
    assert.equal(report.summary.total, 0);
    assert.equal(report.summary.score, 100);
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.blocking, 0);
    assert.equal(report.summary.waived, 0);
    assert.equal(report.period, PERIOD);
    assert.equal(report.standard, 'cas');
    assert.equal(report.engineVersion, '2.0.0');
    assert.match(report.id, /^RV-2024-01-\d{14}-\d{3}$/);
    assert.equal(report.checksRun.length, 34);
  });

  it('单条 error 扣 8 分并计入阻断', () => {
    const report = runReview(makeInput({ vouchers: [unbalancedVoucher()] }));
    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.error, 1);
    assert.equal(report.summary.warning, 0);
    assert.equal(report.summary.blocking, 1);
    assert.equal(report.summary.score, 92);
    assert.equal(report.summary.passed, false);
    assert.equal(report.summary.byCategory.accounting_law, 1);
  });

  it('单条 warning 扣 2 分但不阻断', () => {
    const report = runReview(makeInput({ vouchers: [noAttachmentVoucher()] }));
    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.attachment);
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.blocking, false);
    assert.equal(report.summary.score, 98);
    assert.equal(report.summary.passed, true);
  });

  it('info 每条扣 0.5 分（通过严重度覆盖构造）', () => {
    const report = runReview(makeInput({ vouchers: [noAttachmentVoucher()] }), {
      severityOverrides: { [REVIEW_RULE_IDS.voucher.attachment]: 'info' },
    });
    assert.equal(singleFinding(report, REVIEW_RULE_IDS.voucher.attachment).severity, 'info');
    assert.equal(report.summary.score, 99.5);
    assert.equal(report.summary.passed, true);
  });

  it('评分下限为 0，不会出现负分', () => {
    const vouchers = Array.from({ length: 13 }, (_, index) =>
      makeVoucher({
        id: `v-${index}`,
        word: `记-${String(index + 1).padStart(4, '0')}`,
        lines: [line('6602.01', 1000 + index, 0), line('1002.01', 0, 900 + index)],
      }),
    );
    const report = runReview(makeInput({ vouchers }));
    assert.equal(report.summary.error, 13);
    assert.equal(report.summary.blocking, 13);
    assert.equal(report.summary.score, 0);
    assert.equal(report.summary.passed, false);
  });

  it('同一 ruleId 对同一 target 只报一次', () => {
    // 同时触发「未来日期」与「日期与期间不一致」，必须聚合成一条。
    const voucher = makeVoucher({
      id: 'v-date',
      word: '记-0003',
      date: '2999-01-01',
      period: '2024-02',
      lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
    });
    const report = runReview(makeInput({ vouchers: [voucher] }));
    assert.equal(findingsFor(report, REVIEW_RULE_IDS.voucher.date).length, 1);
    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.date);
    assert.match(finding.detail, /未来日期/);
    assert.match(finding.detail, /不一致/);
    assert.match(finding.id, /^RV-VOUCHER-DATE-001-\d{3}$/);
  });

  it('finding id 在同一输入下稳定生成', () => {
    const input = makeInput({ vouchers: [unbalancedVoucher(), noAttachmentVoucher()] });
    const first = runReview(input);
    const second = runReview(input);
    assert.deepEqual(
      first.findings.map((item) => item.id),
      second.findings.map((item) => item.id),
    );
  });

  it('非法期间抛 ReviewInputError', () => {
    assert.throws(() => runReview(makeInput({ period: '2024-13' })), ReviewInputError);
  });
});

/* ================================================================== */
/* 三、严重度覆盖与关闭                                                */
/* ================================================================== */

describe('配置：严重度覆盖与检查项关闭', () => {
  it('把阻断项下调为 warning 后解除阻断', () => {
    const report = runReview(makeInput({ vouchers: [unbalancedVoucher()] }), {
      severityOverrides: { [REVIEW_RULE_IDS.voucher.balance]: 'warning' },
    });
    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.balance);
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.blocking, false);
    assert.equal(report.summary.blocking, 0);
    assert.equal(report.summary.score, 98);
    assert.equal(report.summary.passed, true);
  });

  it('可关闭的检查项关闭后不再执行', () => {
    const report = runReview(makeInput({ vouchers: [noAttachmentVoucher()] }), {
      disabled: [REVIEW_RULE_IDS.voucher.attachment],
    });
    expectNone(report, REVIEW_RULE_IDS.voucher.attachment);
    assert.equal(report.checksRun.length, 33);
    assert.ok(!report.checksRun.some((item) => item.id === REVIEW_RULE_IDS.voucher.attachment));
  });

  it('监管强制项不允许关闭', () => {
    assert.throws(
      () =>
        runReview(makeInput({ vouchers: [unbalancedVoucher()] }), {
          disabled: [REVIEW_RULE_IDS.voucher.balance],
        }),
      (error: unknown) =>
        error instanceof ReviewConfigError && /不允许关闭/.test(error.message),
    );
  });

  it('未知检查项 id 被忽略，不影响运行', () => {
    const report = runReview(makeInput(), { disabled: ['NO-SUCH-CHECK-999'] });
    assert.equal(report.summary.passed, true);
    assert.equal(report.checksRun.length, 34);
  });

  it('listChecks 返回 34 项且每项都有法规依据', () => {
    const checks = listChecks();
    assert.equal(checks.length, 34);
    assert.ok(checks.every((item) => item.basis.length > 0));
    assert.ok(checks.every((item) => item.id.trim() !== '' && item.title.trim() !== ''));
    assert.ok(checks.some((item) => item.id === 'CRIM-TAX-001'));
    assert.ok(checks.some((item) => item.id === 'IC-SIGNATURE-001'));
    assert.equal(checks.find((item) => item.id === 'VOUCHER-BALANCE-001')?.configurable, false);
    assert.equal(checks.find((item) => item.id === 'VOUCHER-SUMMARY-001')?.configurable, true);
  });
});

/* ================================================================== */
/* 四、豁免                                                            */
/* ================================================================== */

describe('人工豁免', () => {
  it('warning 可以豁免，豁免后不扣分且仍保留在报告中', () => {
    const voucher = noAttachmentVoucher();
    const report = runReview(makeInput({ vouchers: [voucher] }), {
      waiver: [
        {
          ruleId: REVIEW_RULE_IDS.voucher.attachment,
          targetId: voucher.id,
          actor: '张三',
          at: '2024-02-01T10:00:00+08:00',
          reason: '该笔为银行手续费，回单已单独归档',
        },
      ],
    });

    assert.equal(report.summary.waived, 1);
    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.warning, 1);
    assert.equal(report.summary.score, 100);
    assert.equal(report.summary.passed, true);

    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.attachment);
    assert.equal(finding.waived?.actor, '张三');
    assert.equal(finding.waived?.scope, 'warning');
    assert.equal(finding.waived?.reason, '该笔为银行手续费，回单已单独归档');
  });

  it('error 不允许豁免，且应抛 ReviewWaiverError', () => {
    const voucher = unbalancedVoucher();
    assert.throws(
      () =>
        runReview(makeInput({ vouchers: [voucher] }), {
          waiver: [
            {
              ruleId: REVIEW_RULE_IDS.voucher.balance,
              targetId: voucher.id,
              actor: '张三',
              at: '2024-02-01T10:00:00+08:00',
              reason: '金额很小，想直接放行',
            },
          ],
        }),
      (error: unknown) =>
        error instanceof ReviewWaiverError && /不允许豁免/.test(error.message),
    );
  });

  it('豁免缺少理由或签署人时抛错', () => {
    const voucher = noAttachmentVoucher();
    assert.throws(
      () =>
        runReview(makeInput({ vouchers: [voucher] }), {
          waiver: [
            {
              ruleId: REVIEW_RULE_IDS.voucher.attachment,
              targetId: voucher.id,
              actor: '',
              at: '2024-02-01T10:00:00+08:00',
              reason: '测试',
            },
          ],
        }),
      ReviewWaiverError,
    );
    assert.throws(
      () =>
        runReview(makeInput({ vouchers: [voucher] }), {
          waiver: [
            {
              ruleId: REVIEW_RULE_IDS.voucher.attachment,
              targetId: voucher.id,
              actor: '张三',
              at: '2024-02-01T10:00:00+08:00',
              reason: '   ',
            },
          ],
        }),
      ReviewWaiverError,
    );
  });

  it('过期豁免（对应结论不存在）被安全忽略', () => {
    const report = runReview(makeInput(), {
      waiver: [
        {
          ruleId: REVIEW_RULE_IDS.voucher.attachment,
          targetId: 'not-exist',
          actor: '张三',
          at: '2024-02-01T10:00:00+08:00',
          reason: '历史豁免',
        },
      ],
    });
    assert.equal(report.summary.waived, 0);
    assert.equal(report.summary.passed, true);
  });
});

/* ================================================================== */
/* 五、阻断与断言                                                      */
/* ================================================================== */

describe('assertReviewPassed 阻断机制', () => {
  it('存在阻断项时抛 ReviewBlockedError，错误信息包含阻断项与报告', () => {
    const report = runReview(makeInput({ vouchers: [unbalancedVoucher()] }));
    assert.throws(
      () => assertReviewPassed(report),
      (error: unknown) => {
        assert.ok(error instanceof ReviewBlockedError);
        assert.match(error.message, /阻断项/);
        assert.match(error.message, /VOUCHER-BALANCE-001/);
        assert.equal(error.report, report);
        return true;
      },
    );
  });

  it('仅 warning 时不抛错', () => {
    const report = runReview(makeInput({ vouchers: [noAttachmentVoucher()] }));
    assert.doesNotThrow(() => assertReviewPassed(report));
  });

  it('error 被豁免为 warning 后不再阻断', () => {
    const report = runReview(makeInput({ vouchers: [noAttachmentVoucher()] }), {
      severityOverrides: { [REVIEW_RULE_IDS.voucher.attachment]: 'warning' },
      waiver: [
        {
          ruleId: REVIEW_RULE_IDS.voucher.attachment,
          targetId: 'v-attach',
          actor: '李四',
          at: '2024-02-01T10:00:00+08:00',
          reason: '已补充纸质回单，待扫描',
        },
      ],
    });
    assert.equal(report.summary.waived, 1);
    assert.doesNotThrow(() => assertReviewPassed(report));
  });
});

/* ================================================================== */
/* 六、报告渲染                                                        */
/* ================================================================== */

describe('报告渲染', () => {
  it('Markdown 报告包含结论、问题、法规依据与免责声明', () => {
    const report = runReview(makeInput({ vouchers: [unbalancedVoucher()] }));
    const markdown = renderReviewMarkdown(report);
    assert.match(markdown, /^# 合规审核报告/);
    assert.match(markdown, /审核结论\*\*：\*\*未通过/);
    assert.match(markdown, /VOUCHER-BALANCE-001/);
    assert.match(markdown, /法规依据/);
    assert.match(markdown, /中华人民共和国会计法/);
    assert.match(markdown, /整改建议/);
    assert.match(markdown, /检查项执行清单/);
    assert.match(markdown, /免责声明/);
  });

  it('无问题时 Markdown 报告明确写出「未发现问题」', () => {
    const report = runReview(makeInput());
    const markdown = renderReviewMarkdown(report);
    assert.match(markdown, /本次审核未发现问题/);
    assert.match(markdown, /\*\*通过\*\*/);
  });

  it('纯文本报告不含 Markdown 标记且包含关键信息', () => {
    const report = runReview(makeInput({ vouchers: [unbalancedVoucher()] }));
    const text = renderReviewText(report);
    assert.match(text, /合  规  审  核  报  告/);
    assert.match(text, /VOUCHER-BALANCE-001/);
    assert.match(text, /法规依据/);
    assert.match(text, /免责声明/);
    assert.ok(!text.includes('# 合规审核报告'));
    assert.ok(!text.includes('###'));
  });

  it('已豁免结论在报告中保留并注明豁免人', () => {
    const voucher = noAttachmentVoucher();
    const report = runReview(makeInput({ vouchers: [voucher] }), {
      waiver: [
        {
          ruleId: REVIEW_RULE_IDS.voucher.attachment,
          targetId: voucher.id,
          actor: '王五',
          at: '2024-02-01T10:00:00+08:00',
          reason: '附件另册保管',
        },
      ],
    });
    assert.match(renderReviewMarkdown(report), /已豁免.*王五/s);
    assert.match(renderReviewText(report), /已豁免.*王五/s);
  });
});

/* ================================================================== */
/* 七、配置与法规库                                                    */
/* ================================================================== */

describe('配置加载与法规库', () => {
  it('读取仓库中的 review/rules.yaml 得到默认配置', () => {
    const config = loadReviewConfig(CONFIG_DIR);
    assert.equal(config.continueOnError, true);
    assert.deepEqual(config.disabled, []);
    // 仓库配置把 CRIM-INVOICE-002 从 error 下调为 warning（理由见 rules.yaml 的 note），
    // 因此 severityOverrides 里应当有且仅有这一条覆盖。
    assert.deepEqual(config.severityOverrides, { 'CRIM-INVOICE-002': 'warning' });
  });

  it('配置目录不存在时返回默认配置而不是抛错', () => {
    const config = loadReviewConfig('D:\\Project\\accounting\\config\\__no_such_dir__');
    assert.equal(config.continueOnError, true);
    assert.deepEqual(config.disabled, []);
  });

  it('法规库覆盖任务要求的全部法规', () => {
    const ids = new Set<string>(Object.values(LAW_LIBRARY).map((item) => item.id));
    const required = [
      'accounting-law-9',
      'accounting-law-13',
      'accounting-law-14',
      'accounting-law-43',
      'accounting-law-44',
      'accounting-basis-48',
      'accounting-basis-51',
      'accounting-basis-60',
      'accounting-basis-79',
      'enterprise-accounting-system-11',
      'small-enterprise-standard-3',
      'cas-basic-standard-12',
      'tax-collection-law-63',
      'tax-collection-law-64',
      'tax-collection-law-32',
      'criminal-law-201',
      'criminal-law-205',
      'criminal-law-205-1',
      'invoice-measures-21',
      'accounting-archives-13',
      'internal-control-29',
    ];
    for (const id of required) {
      assert.ok(ids.has(id), `法规库缺少 ${id}`);
    }
  });

  it('每条法规都有标题、条款与生效日期', () => {
    for (const item of Object.values(LAW_LIBRARY)) {
      assert.ok(item.id.trim() !== '');
      assert.ok(item.title.trim() !== '');
      assert.ok(item.article !== undefined && item.article.trim() !== '', `${item.id} 缺少条款号`);
      assert.match(String(item.effectiveFrom), /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('nowIsoDateTime 生成带时区偏移的时间戳', () => {
    assert.match(nowIsoDateTime(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});
