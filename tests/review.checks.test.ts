/**
 * 审核检查项单元测试。
 *
 * 每个检查项至少覆盖「命中」与「不命中」两组，重点验证：
 *  - 判定条件是否准确（不误报、不漏报）
 *  - 严重度与阻断属性是否符合监管要求
 *  - 刑法第二百零一条的三档（8% 不触发 / 12% 触发 / 30% 加重）边界
 *  - 小企业会计准则下 1811 被 ACC-FORBIDDEN-001 抓住
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  BenefitMatch,
  DocumentRecord,
  FinancialStatement,
  LedgerBalance,
  LedgerSnapshot,
  ManualFilingRecord,
  ReviewFinding,
  ReviewInput,
  ReviewReport,
  Signature,
  SignRole,
  StatementKind,
  StatementLine,
  TaxLine,
  TaxReturn,
  TaxType,
  Voucher,
  VoucherLine,
} from '../src/core/contracts.ts';
import { sumCents } from '../src/core/money.ts';
import {
  REVIEW_RULE_IDS,
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

function makeDocument(
  input: Partial<DocumentRecord> & Pick<DocumentRecord, 'id'>,
): DocumentRecord {
  return {
    kind: 'invoice',
    date: '2024-01-10',
    summary: '采购原材料',
    amount: 100_000,
    direction: 'out',
    counterparty: '甲公司',
    netAmount: null,
    taxAmount: null,
    fields: {},
    source: { file: 'docs.xlsx', sheet: 'Sheet1', row: 2 },
    warnings: [],
    ...input,
  };
}

function taxLine(code: string, label: string, amount: number, rate?: number): TaxLine {
  const item: TaxLine = { code, label, amount };
  if (rate !== undefined) item.rate = rate;
  return item;
}

function makeTaxReturn(
  input: Partial<TaxReturn> & Pick<TaxReturn, 'id' | 'taxType' | 'period'>,
): TaxReturn {
  return {
    taxpayerId: '91310000TEST',
    standard: 'cas',
    status: 'approved',
    version: 1,
    lines: [],
    adjustments: [],
    payable: 0,
    prepaid: 0,
    due: 0,
    benefits: [],
    reviewId: null,
    blockingIssues: 0,
    signatures: [],
    events: [],
    payloadHash: 'hash',
    createdAt: '2024-02-01T10:00:00+08:00',
    updatedAt: '2024-02-01T10:00:00+08:00',
    ...input,
  };
}

function signature(role: SignRole, actor: string): Signature {
  return {
    role,
    actor,
    at: '2024-02-01T10:00:00+08:00',
    method: 'manual',
    payloadHash: 'hash',
  };
}

function manualFiling(paidAmount: number): ManualFilingRecord {
  return {
    channel: 'etax-manual',
    receiptNo: 'R-2024-001',
    filedAt: '2024-02-15T10:00:00+08:00',
    actor: '张三',
    paidAmount,
  };
}

function statementLine(
  code: string,
  label: string,
  amount: number | null,
  priorAmount?: number,
  isTotal = false,
): StatementLine {
  const item: StatementLine = { code, label, level: 1, amount };
  if (priorAmount !== undefined) item.priorAmount = priorAmount;
  if (isTotal) item.isTotal = true;
  return item;
}

function makeStatement(
  kind: StatementKind,
  period: string,
  lines: StatementLine[],
  id = `${kind}-${period}`,
): FinancialStatement {
  return {
    id,
    kind,
    period,
    standard: 'cas',
    lines,
    checks: [],
    passed: true,
    generatedAt: '2024-02-01T10:00:00+08:00',
    engineVersion: '2.0.0',
  };
}

function makeLedger(balances: LedgerBalance[]): LedgerSnapshot {
  return { period: PERIOD, standard: 'cas', balances, vouchers: [], openingBalanced: true };
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

/* ================================================================== */
/* 二、凭证层                                                          */
/* ================================================================== */

describe('VOUCHER-BALANCE-001 借贷不平衡', () => {
  it('借方 100、贷方 90 时命中 error 且阻断', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602.01', 100, 0), line('1002.01', 0, 90)] })],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.balance);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.blocking, true);
    assert.equal(finding.evidence?.['diff'], 10);
    assert.equal(finding.evidence?.['debitTotal'], 100);
    assert.equal(finding.evidence?.['creditTotal'], 90);
  });

  it('借贷相等时不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.voucher.balance);
  });
});

describe('VOUCHER-EMPTY-001 无有效分录', () => {
  it('没有任何分录行时命中', () => {
    const report = runReview(makeInput({ vouchers: [makeVoucher({ lines: [] })] }));
    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.empty);
    assert.equal(finding.severity, 'error');
    assert.match(finding.detail, /没有任何分录行/);
  });

  it('所有分录金额为 0 时命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602.01', 0, 0), line('1002.01', 0, 0)] })],
      }),
    );
    assert.equal(findingsFor(report, REVIEW_RULE_IDS.voucher.empty).length, 1);
  });

  it('有正常金额时不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.voucher.empty);
  });
});

describe('VOUCHER-DATE-001 日期异常', () => {
  it('未来日期命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            date: '2999-12-31',
            period: '2999-12',
            lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.date);
    assert.match(finding.detail, /未来日期/);
  });

  it('日期与所属期间不一致时命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            date: '2024-02-10',
            period: '2024-01',
            lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
          }),
        ],
      }),
    );
    assert.match(singleFinding(report, REVIEW_RULE_IDS.voucher.date).detail, /不一致/);
  });

  it('正常日期不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.voucher.date);
  });
});

describe('VOUCHER-SUMMARY-001 摘要不合格', () => {
  it('摘要为空时命中 warning', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            lines: [line('6602.01', 100, 0, ''), line('1002.01', 0, 100, '支付办公室租金')],
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.summary);
    assert.equal(finding.severity, 'warning');
    assert.match(finding.detail, /为空/);
  });

  it('摘要笼统（「费用」）时命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({ lines: [line('6602.01', 100, 0, '费用'), line('1002.01', 0, 100, '费用')] }),
        ],
      }),
    );
    assert.equal(findingsFor(report, REVIEW_RULE_IDS.voucher.summary).length, 1);
  });

  it('摘要清晰时不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            lines: [
              line('6602.01', 100, 0, '支付2024年1月办公室租金（租赁合同HT-001）'),
              line('1002.01', 0, 100, '支付2024年1月办公室租金（租赁合同HT-001）'),
            ],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.voucher.summary);
  });
});

describe('VOUCHER-ATTACH-001 未附原始单据', () => {
  it('附单据数为 0 时命中 warning', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            attachments: 0,
            lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
          }),
        ],
      }),
    );
    assert.equal(singleFinding(report, REVIEW_RULE_IDS.voucher.attachment).severity, 'warning');
  });

  it('结转类凭证即使 0 附件也不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            attachments: 0,
            lines: [
              line('4103', 100, 0, '结转本期损益'),
              line('6602.01', 0, 100, '结转本期损益'),
            ],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.voucher.attachment);
  });

  it('有附件时不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            attachments: 3,
            lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.voucher.attachment);
  });
});

describe('VOUCHER-SUSPENSE-001 兜底科目 1901', () => {
  it('出现 1901 时命中 error 且阻断', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('1901', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.suspense);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.blocking, true);
    assert.match(finding.detail, /1901/);
  });

  it('1901 明细科目同样命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('1901.01', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    // 1901.01 不在科目表中，会同时触发 ACC-EXIST；这里只验证兜底科目检查。
    assert.equal(findingsFor(report, REVIEW_RULE_IDS.voucher.suspense).length, 1);
  });

  it('未使用兜底科目时不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.voucher.suspense);
  });
});

describe('VOUCHER-CASH-001 货币资金贷方余额', () => {
  it('库存现金期末为负时命中 warning', () => {
    const report = runReview(
      makeInput({
        ledger: makeLedger([
          {
            accountCode: '1001',
            accountName: '库存现金',
            opening: 0,
            debitTotal: 0,
            creditTotal: 100,
            closing: -100,
          },
        ]),
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.cash);
    assert.equal(finding.severity, 'warning');
    assert.match(finding.detail, /贷方余额/);
  });

  it('余额为正时不命中', () => {
    const report = runReview(
      makeInput({
        ledger: makeLedger([
          {
            accountCode: '1001',
            accountName: '库存现金',
            opening: 0,
            debitTotal: 100,
            creditTotal: 0,
            closing: 100,
          },
        ]),
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.voucher.cash);
  });

  it('没有账簿快照时不做猜测', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.voucher.cash);
  });
});

describe('VOUCHER-NEGATIVE-001 分录金额形态', () => {
  it('同一行借贷同时有值时命中', () => {
    const report = runReview(
      makeInput({ vouchers: [makeVoucher({ lines: [line('6602.01', 100, 100)] })] }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.negative);
    assert.equal(finding.severity, 'error');
    assert.match(finding.detail, /同时有金额/);
  });

  it('同一行借贷同时为 0 时命中', () => {
    const report = runReview(
      makeInput({ vouchers: [makeVoucher({ lines: [line('6602.01', 0, 0)] })] }),
    );
    assert.match(singleFinding(report, REVIEW_RULE_IDS.voucher.negative).detail, /均为 0/);
  });

  it('出现负数金额时命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({ lines: [line('6602.01', -100, 0), line('1002.01', 0, -100)] }),
        ],
      }),
    );
    assert.equal(findingsFor(report, REVIEW_RULE_IDS.voucher.negative).length, 2);
  });

  it('正常分录不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.voucher.negative);
  });
});

describe('VOUCHER-DUP-001 疑似重复凭证', () => {
  it('日期、金额、科目完全一致时命中第二条', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            id: 'v1',
            word: '记-0001',
            lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
          }),
          makeVoucher({
            id: 'v2',
            word: '记-0002',
            lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.voucher.duplicate);
    assert.equal(finding.target.id, 'v2');
    assert.equal(finding.evidence?.['duplicatedWith'], 'v1');
  });

  it('金额不同时不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            id: 'v1',
            word: '记-0001',
            lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
          }),
          makeVoucher({
            id: 'v2',
            word: '记-0002',
            lines: [line('6602.01', 200, 0), line('1002.01', 0, 200)],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.voucher.duplicate);
  });
});

/* ================================================================== */
/* 三、科目与准则层                                                    */
/* ================================================================== */

describe('ACC-LEAF-001 非明细科目', () => {
  it('使用 6602 管理费用（有下级）时命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.account.leaf);
    assert.equal(finding.severity, 'error');
    assert.match(finding.detail, /6602/);
  });

  it('使用明细科目 6602.01 时不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.account.leaf);
  });
});

describe('ACC-EXIST-001 科目不存在', () => {
  it('科目 9999 不在科目表时命中 error 且阻断', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('9999', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.account.exists);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.blocking, true);
  });

  it('科目存在时不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.account.exists);
  });
});

describe('ACC-FORBIDDEN-001 准则禁止科目', () => {
  it('小企业准则下使用 1811 递延所得税资产时命中', () => {
    const report = runReview(
      makeInput({
        standard: 'small',
        vouchers: [makeVoucher({ lines: [line('1811', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.account.forbidden);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.blocking, true);
    assert.match(finding.detail, /小企业会计准则/);
    assert.match(finding.detail, /1811/);
    assert.match(finding.detail, /递延所得税/);
  });

  it('企业会计准则下使用 1811 不命中', () => {
    const report = runReview(
      makeInput({
        standard: 'cas',
        vouchers: [makeVoucher({ lines: [line('1811', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.account.forbidden);
  });

  it('小企业准则下使用普通科目不命中', () => {
    const report = runReview(
      makeInput({
        standard: 'small',
        vouchers: [makeVoucher({ lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.account.forbidden);
  });
});

describe('ACC-DIRECTION-001 余额方向', () => {
  it('资产科目出现贷方余额时命中 warning', () => {
    const report = runReview(
      makeInput({
        ledger: makeLedger([
          {
            accountCode: '1001',
            accountName: '库存现金',
            opening: 0,
            debitTotal: 0,
            creditTotal: 100,
            closing: -100,
          },
        ]),
      }),
    );
    assert.equal(singleFinding(report, REVIEW_RULE_IDS.account.direction).severity, 'warning');
  });

  it('资产科目借方余额时不命中', () => {
    const report = runReview(
      makeInput({
        ledger: makeLedger([
          {
            accountCode: '1001',
            accountName: '库存现金',
            opening: 0,
            debitTotal: 100,
            creditTotal: 0,
            closing: 100,
          },
        ]),
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.account.direction);
  });
});

describe('ACC-PERIOD-001 跨期记账', () => {
  it('凭证期间与审核期间不一致时命中 warning', () => {
    const report = runReview(
      makeInput({
        period: '2024-01',
        vouchers: [
          makeVoucher({
            period: '2023-12',
            date: '2023-12-31',
            lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
          }),
        ],
      }),
    );
    assert.equal(singleFinding(report, REVIEW_RULE_IDS.account.period).severity, 'warning');
  });

  it('期间一致时不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [makeVoucher({ lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.account.period);
  });
});

/* ================================================================== */
/* 四、税务层                                                          */
/* ================================================================== */

describe('TAX-DRAFT-001 未复核草稿', () => {
  it('draft 状态命中 error 且阻断', () => {
    const report = runReview(
      makeInput({
        taxReturns: [makeTaxReturn({ id: 'vat-1', taxType: 'vat', period: PERIOD, status: 'draft' })],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.tax.draft);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.blocking, true);
  });

  it('calculated 状态同样命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({ id: 'vat-2', taxType: 'vat', period: PERIOD, status: 'calculated' }),
        ],
      }),
    );
    assert.equal(findingsFor(report, REVIEW_RULE_IDS.tax.draft).length, 1);
  });

  it('approved 且签署齐全时不命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-3',
            taxType: 'vat',
            period: PERIOD,
            status: 'approved',
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.tax.draft);
  });
});

describe('TAX-NOFILED-001 缺人工回执', () => {
  it('filed 但没有 manualFiling 时命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-4',
            taxType: 'vat',
            period: PERIOD,
            status: 'filed',
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.tax.noFiled);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.blocking, true);
    assert.match(finding.detail, /未回填人工申报回执/);
  });

  it('filed 且回执完整时不命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-5',
            taxType: 'vat',
            period: PERIOD,
            status: 'filed',
            payable: 100_000,
            manualFiling: manualFiling(100_000),
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.tax.noFiled);
  });
});

describe('TAX-VAT-MISMATCH-001 销项税额不符', () => {
  it('销项税额 12000 与销售额 100000×13% 不符时命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-6',
            taxType: 'vat',
            period: PERIOD,
            payable: 1_200_000,
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            lines: [
              taxLine('sales_amount', '销售额', 10_000_000, 0.13),
              taxLine('output_tax', '销项税额', 1_200_000, 0.13),
            ],
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.tax.vatMismatch);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.evidence?.['expected'], 1_300_000);
    assert.equal(finding.evidence?.['diff'], -100_000);
  });

  it('销项税额正确时不命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-7',
            taxType: 'vat',
            period: PERIOD,
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            lines: [
              taxLine('sales_amount', '销售额', 10_000_000, 0.13),
              taxLine('output_tax', '销项税额', 1_300_000, 0.13),
            ],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.tax.vatMismatch);
  });

  it('差异在 1 元容差内不命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-8',
            taxType: 'vat',
            period: PERIOD,
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            lines: [
              taxLine('sales_amount', '销售额', 10_000_000, 0.13),
              taxLine('output_tax', '销项税额', 1_300_050, 0.13),
            ],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.tax.vatMismatch);
  });
});

describe('TAX-INPUT-001 连续留抵', () => {
  it('连续 3 期留抵时命中 warning', () => {
    const periods = ['2024-01', '2024-02', '2024-03'];
    const report = runReview(
      makeInput({
        period: '2024-03',
        taxReturns: periods.map((period) =>
          makeTaxReturn({
            id: `vat-${period}`,
            taxType: 'vat',
            period,
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            lines: [taxLine('input_tax', '进项税额', 200_000), taxLine('output_tax', '销项税额', 100_000)],
          }),
        ),
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.tax.inputCredit);
    assert.equal(finding.severity, 'warning');
    assert.match(finding.detail, /2024-01/);
    assert.match(finding.detail, /2024-03/);
  });

  it('只有 2 期留抵时不命中', () => {
    const periods = ['2024-01', '2024-02'];
    const report = runReview(
      makeInput({
        period: '2024-02',
        taxReturns: periods.map((period) =>
          makeTaxReturn({
            id: `vat-${period}`,
            taxType: 'vat',
            period,
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            lines: [taxLine('input_tax', '进项税额', 200_000), taxLine('output_tax', '销项税额', 100_000)],
          }),
        ),
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.tax.inputCredit);
  });
});

describe('TAX-SURCHARGE-001 附加税依据', () => {
  it('计税依据与实缴增值税不符时命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-9',
            taxType: 'vat',
            period: PERIOD,
            payable: 200_000,
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
          }),
          makeTaxReturn({
            id: 'sur-9',
            taxType: 'surcharge',
            period: PERIOD,
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            lines: [taxLine('tax_base', '计税依据', 100_000)],
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.tax.surcharge);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.evidence?.['expected'], 200_000);
  });

  it('计税依据正确时不命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-10',
            taxType: 'vat',
            period: PERIOD,
            payable: 200_000,
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
          }),
          makeTaxReturn({
            id: 'sur-10',
            taxType: 'surcharge',
            period: PERIOD,
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            lines: [taxLine('tax_base', '计税依据', 200_000)],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.tax.surcharge);
  });
});

describe('TAX-CIT-RATE-001 所得税税率', () => {
  it('使用非法税率 33% 时命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'cit-1',
            taxType: 'cit',
            period: '2024-12',
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            lines: [taxLine('cit_rate', '企业所得税税率', 0, 0.33)],
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.tax.citRate);
    assert.equal(finding.severity, 'error');
    assert.match(finding.detail, /不属于法定税率/);
  });

  it('享受小型微利优惠却使用 25% 时命中', () => {
    const benefit: BenefitMatch = {
      policyId: 'small-profit',
      policyName: '小型微利企业所得税优惠',
      eligible: true,
      reasons: [],
      estimatedBenefit: 0,
      basis: [],
      manualChecks: [],
    };
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'cit-2',
            taxType: 'cit',
            period: '2024-12',
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            benefits: [benefit],
            lines: [taxLine('cit_rate', '企业所得税税率', 0, 0.25)],
          }),
        ],
      }),
    );
    assert.match(singleFinding(report, REVIEW_RULE_IDS.tax.citRate).detail, /小型微利/);
  });

  it('使用 25% 且无优惠时不命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'cit-3',
            taxType: 'cit',
            period: '2024-12',
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            lines: [taxLine('cit_rate', '企业所得税税率', 0, 0.25)],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.tax.citRate);
  });
});

describe('TAX-BENEFIT-001 未享受优惠', () => {
  it('符合条件但无减免栏时命中 warning 并附测算额', () => {
    const benefit: BenefitMatch = {
      policyId: 'small-profit',
      policyName: '小型微利企业所得税优惠',
      eligible: true,
      reasons: [],
      estimatedBenefit: 5_000,
      basis: [],
      manualChecks: [],
    };
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'cit-4',
            taxType: 'cit',
            period: '2024-12',
            payable: 100_000,
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            benefits: [benefit],
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.tax.benefit);
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.evidence?.['totalBenefit'], 5_000);
  });

  it('申报表已有减免税额时不命中', () => {
    const benefit: BenefitMatch = {
      policyId: 'small-profit',
      policyName: '小型微利企业所得税优惠',
      eligible: true,
      reasons: [],
      estimatedBenefit: 5_000,
      basis: [],
      manualChecks: [],
    };
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'cit-5',
            taxType: 'cit',
            period: '2024-12',
            payable: 100_000,
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
            benefits: [benefit],
            lines: [taxLine('tax_reduction', '减免税额', 5_000)],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.tax.benefit);
  });
});

/* ================================================================== */
/* 五、刑事红线                                                        */
/* ================================================================== */

function filedVat(id: string, payable: number, paid: number): TaxReturn {
  return makeTaxReturn({
    id,
    taxType: 'vat',
    period: PERIOD,
    status: 'filed',
    payable,
    prepaid: paid,
    due: payable - paid,
    manualFiling: manualFiling(paid),
    signatures: [
      signature('preparer', '李四'),
      signature('reviewer', '王五'),
      signature('approver', '赵六'),
    ],
  });
}

describe('CRIM-TAX-001/002 逃税刑事风险', () => {
  it('比例 8%（8 万元 / 100 万元）不触发', () => {
    const report = runReview(
      makeInput({ taxReturns: [filedVat('vat-8pct', 100_000_000, 92_000_000)] }),
    );
    expectNone(report, REVIEW_RULE_IDS.criminal.taxEvasion);
    expectNone(report, REVIEW_RULE_IDS.criminal.taxEvasionSevere);
    assert.equal(report.findings.length, 0);
    assert.equal(report.summary.passed, true);
  });

  it('比例 12%（12 万元 / 100 万元）触发 error 且阻断', () => {
    const report = runReview(
      makeInput({ taxReturns: [filedVat('vat-12pct', 100_000_000, 88_000_000)] }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.criminal.taxEvasion);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.blocking, true);
    assert.match(finding.detail, /12\.00%/);
    assert.match(finding.detail, /不予追究刑事责任/);
    assert.match(finding.detail, /不构成法律意见/);
    assert.equal(finding.evidence?.['evaded'], 12_000_000);
    expectNone(report, REVIEW_RULE_IDS.criminal.taxEvasionSevere);
  });

  it('比例 30% 且 600 万元触发加重档并标注量刑区间', () => {
    const report = runReview(
      makeInput({ taxReturns: [filedVat('vat-30pct', 2_000_000_000, 1_400_000_000)] }),
    );
    const severe = singleFinding(report, REVIEW_RULE_IDS.criminal.taxEvasionSevere);
    assert.equal(severe.severity, 'error');
    assert.match(severe.detail, /三年以上七年以下/);
    assert.match(severe.detail, /第二百一十一条/);
    assert.equal(severe.evidence?.['sentencing'], '三年以上七年以下有期徒刑，并处罚金');
    assert.equal(findingsFor(report, REVIEW_RULE_IDS.criminal.taxEvasion).length, 1);
  });
});

describe('CRIM-INVOICE-001 大额进项无合同/物流', () => {
  function invoice(id: string, amount: number, date: string, fields: Record<string, string | number | boolean | null>): DocumentRecord {
    return makeDocument({
      id,
      kind: 'invoice',
      amount,
      date,
      counterparty: '乙材料公司',
      fields: { invoiceSide: 'input', ...fields },
      source: { file: 'invoice.xlsx', sheet: 'Sheet1', row: 2 },
    });
  }

  it('30 天内 120 万元进项且无合同无物流时命中', () => {
    const report = runReview(
      makeInput({
        documents: [
          invoice('inv-1', 60_000_000, '2024-01-05', {}),
          invoice('inv-2', 60_000_000, '2024-01-20', {}),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.criminal.invoiceRisk);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.evidence?.['hasContract'], false);
    assert.equal(finding.evidence?.['hasLogistics'], false);
    assert.match(finding.detail, /不构成法律意见/);
  });

  it('有对应合同时不命中', () => {
    const report = runReview(
      makeInput({
        documents: [
          invoice('inv-3', 60_000_000, '2024-01-05', {}),
          invoice('inv-4', 60_000_000, '2024-01-20', {}),
          makeDocument({
            id: 'contract-1',
            kind: 'contract',
            amount: 120_000_000,
            counterparty: '乙材料公司',
            direction: 'none',
            date: '2024-01-01',
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.criminal.invoiceRisk);
  });

  it('提供物流单号时不命中', () => {
    const report = runReview(
      makeInput({
        documents: [
          invoice('inv-5', 60_000_000, '2024-01-05', { logisticsNo: 'SF123456' }),
          invoice('inv-6', 60_000_000, '2024-01-20', { logisticsNo: 'SF123457' }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.criminal.invoiceRisk);
  });
});

describe('CRIM-INVOICE-002 三流不一致', () => {
  it('发票 11.3 万元、付款 8 万元时命中', () => {
    const report = runReview(
      makeInput({
        documents: [
          makeDocument({
            id: 'inv-flow-1',
            amount: 11_300_000,
            date: '2024-01-10',
            counterparty: '丙公司',
            fields: { invoiceSide: 'input' },
          }),
          makeDocument({
            id: 'bank-flow-1',
            kind: 'bank',
            amount: 8_000_000,
            direction: 'out',
            date: '2024-01-15',
            counterparty: '丙公司',
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.criminal.threeFlows);
    // 默认严重度已由 error 下调为 warning：分期付款/预收款会让「本期开票额」与
    // 「本期付款额」天然不等，按 error 处理会让每一期都报警，反而让人对真正的
    // 刑事风险脱敏。重大异常由 CRIM-INVOICE-001 以 error 拦截。
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.evidence?.['invoiceTotal'], 11_300_000);
    assert.equal(finding.evidence?.['bankTotal'], 8_000_000);
  });

  it('发票与付款金额一致时不命中', () => {
    const report = runReview(
      makeInput({
        documents: [
          makeDocument({
            id: 'inv-flow-2',
            amount: 11_300_000,
            date: '2024-01-10',
            counterparty: '丙公司',
            fields: { invoiceSide: 'input' },
          }),
          makeDocument({
            id: 'bank-flow-2',
            kind: 'bank',
            amount: 11_300_000,
            direction: 'out',
            date: '2024-01-15',
            counterparty: '丙公司',
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.criminal.threeFlows);
  });
});

/* ================================================================== */
/* 六、报表勾稽                                                        */
/* ================================================================== */

describe('STMT-BALANCE-001 资产负债表平衡', () => {
  it('资产 10000 ≠ 负债 4000 + 权益 5000 时命中', () => {
    const report = runReview(
      makeInput({
        statements: [
          makeStatement('balance_sheet', PERIOD, [
            statementLine('total_assets', '资产总计', 1_000_000),
            statementLine('total_liabilities', '负债合计', 400_000),
            statementLine('total_equity', '所有者权益合计', 500_000),
          ]),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.statement.balance);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.evidence?.['diff'], 100_000);
  });

  it('资产 = 负债 + 权益时不命中', () => {
    const report = runReview(
      makeInput({
        statements: [
          makeStatement('balance_sheet', PERIOD, [
            statementLine('total_assets', '资产总计', 1_000_000),
            statementLine('total_liabilities', '负债合计', 400_000),
            statementLine('total_equity', '所有者权益合计', 600_000),
          ]),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.statement.balance);
  });
});

describe('STMT-CASH-001 期末现金衔接', () => {
  it('现金流量表期末现金 10000 ≠ 货币资金 9000 时命中', () => {
    const report = runReview(
      makeInput({
        statements: [
          makeStatement('cash_flow', PERIOD, [
            statementLine('ending_cash', '期末现金及现金等价物余额', 1_000_000),
          ]),
          makeStatement('balance_sheet', PERIOD, [
            statementLine('monetary_funds', '货币资金', 900_000),
          ]),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.statement.cash);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.evidence?.['diff'], 100_000);
  });

  it('金额一致时不命中', () => {
    const report = runReview(
      makeInput({
        statements: [
          makeStatement('cash_flow', PERIOD, [
            statementLine('ending_cash', '期末现金及现金等价物余额', 1_000_000),
          ]),
          makeStatement('balance_sheet', PERIOD, [
            statementLine('monetary_funds', '货币资金', 1_000_000),
          ]),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.statement.cash);
  });
});

describe('STMT-NET-001 净利润一致', () => {
  it('利润表 5000 ≠ 权益变动表 4000 时命中', () => {
    const report = runReview(
      makeInput({
        statements: [
          makeStatement('income_statement', PERIOD, [statementLine('net_profit', '净利润', 500_000)]),
          makeStatement('equity_change', PERIOD, [statementLine('net_profit', '净利润', 400_000)]),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.statement.netProfit);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.evidence?.['diff'], 100_000);
  });

  it('净利润一致时不命中', () => {
    const report = runReview(
      makeInput({
        statements: [
          makeStatement('income_statement', PERIOD, [statementLine('net_profit', '净利润', 500_000)]),
          makeStatement('equity_change', PERIOD, [statementLine('net_profit', '净利润', 500_000)]),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.statement.netProfit);
  });
});

describe('STMT-CONTINUITY-001 期初与上期期末', () => {
  it('年初余额 9000 ≠ 上年年末 10000 时命中', () => {
    const report = runReview(
      makeInput({
        statements: [
          makeStatement('balance_sheet', '2023-12', [
            statementLine('total_assets', '资产总计', 1_000_000, undefined, true),
          ]),
          makeStatement('balance_sheet', PERIOD, [
            statementLine('total_assets', '资产总计', 1_200_000, 900_000, true),
          ]),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.statement.continuity);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.evidence?.['priorYearEnd'], '2023-12');
  });

  it('年初余额等于上年年末时不命中', () => {
    const report = runReview(
      makeInput({
        statements: [
          makeStatement('balance_sheet', '2023-12', [
            statementLine('total_assets', '资产总计', 1_000_000, undefined, true),
          ]),
          makeStatement('balance_sheet', PERIOD, [
            statementLine('total_assets', '资产总计', 1_200_000, 1_000_000, true),
          ]),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.statement.continuity);
  });

  it('没有上年年末报表时不做猜测', () => {
    const report = runReview(
      makeInput({
        statements: [
          makeStatement('balance_sheet', PERIOD, [
            statementLine('total_assets', '资产总计', 1_200_000, 900_000, true),
          ]),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.statement.continuity);
  });
});

/* ================================================================== */
/* 七、数据质量与内控                                                  */
/* ================================================================== */

describe('DATA-MISSING-001 单据要素缺失', () => {
  it('缺日期时命中 warning', () => {
    const report = runReview(
      makeInput({ documents: [makeDocument({ id: 'doc-1', date: null })] }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.data.missing);
    assert.equal(finding.severity, 'warning');
    assert.match(finding.detail, /缺少业务日期/);
  });

  it('金额为 0 时命中 warning', () => {
    const report = runReview(
      makeInput({ documents: [makeDocument({ id: 'doc-2', amount: 0 })] }),
    );
    assert.match(singleFinding(report, REVIEW_RULE_IDS.data.missing).detail, /金额为 0/);
  });

  it('要素完整时不命中', () => {
    const report = runReview(makeInput({ documents: [makeDocument({ id: 'doc-3' })] }));
    expectNone(report, REVIEW_RULE_IDS.data.missing);
  });
});

describe('DATA-UNMATCHED-001 未匹配规则', () => {
  it('单据没有对应凭证时命中 warning', () => {
    const report = runReview(
      makeInput({ documents: [makeDocument({ id: 'doc-4', source: { file: 'docs.xlsx', sheet: 'Sheet1', row: 7 } })] }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.data.unmatched);
    assert.equal(finding.severity, 'warning');
    assert.match(finding.detail, /未能匹配到任何记账规则/);
  });

  it('凭证分录来源与单据一致时不命中', () => {
    const matchedLine: VoucherLine = {
      ...line('6602.01', 100, 0),
      source: { file: 'docs.xlsx', sheet: 'Sheet1', row: 7 },
    };
    const report = runReview(
      makeInput({
        documents: [makeDocument({ id: 'doc-5', source: { file: 'docs.xlsx', sheet: 'Sheet1', row: 7 } })],
        vouchers: [makeVoucher({ lines: [matchedLine, line('1002.01', 0, 100)] })],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.data.unmatched);
  });

  it('金额为 0 的合同不视为账外业务', () => {
    const report = runReview(
      makeInput({
        documents: [
          makeDocument({ id: 'contract-2', kind: 'contract', amount: 0, direction: 'none' }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.data.unmatched);
  });
});

describe('IC-SEGREGATION-001 不相容职务分离', () => {
  it('同一人既编制又复核时命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-11',
            taxType: 'vat',
            period: PERIOD,
            status: 'approved',
            signatures: [signature('preparer', '张三'), signature('reviewer', '张三'), signature('approver', '李四')],
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.data.segregation);
    assert.equal(finding.severity, 'error');
    assert.match(finding.detail, /张三/);
  });

  it('三人分工时不命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-12',
            taxType: 'vat',
            period: PERIOD,
            status: 'approved',
            signatures: [signature('preparer', '张三'), signature('reviewer', '李四'), signature('approver', '王五')],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.data.segregation);
  });
});

describe('IC-SIGNATURE-001 人工签署（HITL）', () => {
  it('approved 但只有复核签署时命中 error 且阻断', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-13',
            taxType: 'vat',
            period: PERIOD,
            status: 'approved',
            signatures: [signature('reviewer', '李四')],
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.data.signature);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.blocking, true);
    assert.deepEqual(finding.evidence?.['missing'], ['approver']);
  });

  it('复核与审批签署齐全时不命中', () => {
    const report = runReview(
      makeInput({
        taxReturns: [
          makeTaxReturn({
            id: 'vat-14',
            taxType: 'vat',
            period: PERIOD,
            status: 'approved',
            signatures: [signature('reviewer', '李四'), signature('approver', '王五')],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.data.signature);
  });
});

describe('IC-SOFTDELETE-001 物理删除痕迹', () => {
  it('凭证断号时命中 error 且阻断', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            id: 'v1',
            word: '记-0001',
            lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
          }),
          makeVoucher({
            id: 'v3',
            word: '记-0003',
            lines: [line('6602.01', 300, 0), line('1002.01', 0, 300)],
          }),
        ],
      }),
    );
    const finding = singleFinding(report, REVIEW_RULE_IDS.data.softDelete);
    assert.equal(finding.severity, 'error');
    assert.equal(finding.blocking, true);
    assert.match(finding.detail, /0002/);
  });

  it('凭证重号时命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            id: 'v1',
            word: '记-0001',
            lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
          }),
          makeVoucher({
            id: 'v2',
            word: '记-0001',
            lines: [line('6602.01', 200, 0), line('1002.01', 0, 200)],
          }),
        ],
      }),
    );
    assert.match(singleFinding(report, REVIEW_RULE_IDS.data.softDelete).detail, /重复使用/);
  });

  it('凭证连续编号时不命中', () => {
    const report = runReview(
      makeInput({
        vouchers: [
          makeVoucher({
            id: 'v1',
            word: '记-0001',
            lines: [line('6602.01', 100, 0), line('1002.01', 0, 100)],
          }),
          makeVoucher({
            id: 'v2',
            word: '记-0002',
            lines: [line('6602.01', 200, 0), line('1002.01', 0, 200)],
          }),
        ],
      }),
    );
    expectNone(report, REVIEW_RULE_IDS.data.softDelete);
  });
});
