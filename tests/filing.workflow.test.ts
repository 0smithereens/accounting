/**
 * 申报工作流单测：状态机、四眼原则、签署失效、人工申报回填。
 *
 * 这组测试守的不是「功能有没有」，而是「流程能不能被绕过」。
 * 每一条 assert 对应一条监管要求，写错任何一条，系统就可能让一张没复核的申报表变成「已申报」。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { LawBasis, Signature, SignRole, TaxLine, TaxReturn } from '../src/core/contracts.ts';
import {
  AutoSubmissionForbidden,
  ExportNotAllowedError,
  FilingGuardError,
  FilingWorkflow,
  FilingWorkflowError,
  FourEyesViolation,
  IllegalTransitionError,
  MissingSignatureError,
  SelfReviewForbidden,
  StaleSignatureError,
  TRANSITIONS,
  canTransition,
  hashFilingPayload,
  loadFilingConfig,
  submitToTaxBureau,
} from '../src/filing/index.ts';

/* ------------------------------------------------------------------ */
/* 测试夹具                                                            */
/* ------------------------------------------------------------------ */

const ID = 'VAT-2024-01-001';

const LAW: LawBasis = {
  id: 'vat-temporary-regulations',
  title: '中华人民共和国增值税暂行条例',
  article: '第二条',
  excerpt: '纳税人销售货物、劳务、服务、无形资产、不动产，应纳税额为当期销项税额抵扣当期进项税额后的余额。',
  level: 'administrative-regulation',
};

/** 按应纳税额生成一套自洽的申报行（含「应纳税额」行，供勾稽校验）。 */
function makeLines(payable: number): TaxLine[] {
  return [
    { code: '1', label: '按适用税率计税销售额', amount: 10000000, note: '销项不含税销售额' },
    {
      code: '11',
      label: '销项税额',
      amount: 1300000,
      rate: 0.13,
      note: '10,000,000 × 13%',
      basis: [LAW],
    },
    { code: '12', label: '进项税额', amount: 500000, note: '已认证抵扣' },
    { code: 'PAYABLE', label: '本期应纳税额', amount: payable, note: '销项税额 - 进项税额' },
  ];
}

function makeReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: ID,
    period: '2024-01',
    taxType: 'vat',
    taxpayerId: '91310000MA1FL0XXXX',
    standard: 'cas',
    status: 'draft',
    version: 1,
    lines: makeLines(800000),
    adjustments: [],
    payable: 800000,
    prepaid: 100000,
    due: 700000,
    benefits: [],
    reviewId: 'RV-2024-01-001',
    blockingIssues: 0,
    signatures: [],
    events: [],
    payloadHash: '',
    createdAt: '2024-02-01T09:00:00+08:00',
    updatedAt: '2024-02-01T09:00:00+08:00',
    ...overrides,
  };
}

/** 递增的假时钟：每调用一次前进一秒，保证事件时间单调。 */
function makeClock(): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    const minute = 10 + Math.floor(tick / 60);
    const second = tick % 60;
    return `2024-02-01T${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}:00+08:00`;
  };
}

function sig(role: SignRole, actor: string): Omit<Signature, 'payloadHash'> {
  return { role, actor, at: '2024-02-01T09:30:00+08:00', method: 'manual' };
}

function newWorkflow(): FilingWorkflow {
  return new FilingWorkflow({
    guards: { isReviewPassed: () => true, blockingCount: () => 0 },
    now: makeClock(),
  });
}

const MANUAL_RECORD = {
  channel: 'etax-manual' as const,
  receiptNo: '31012024020001234',
  filedAt: '2024-02-15T10:20:00+08:00',
  actor: '张会计',
  paidAmount: 700000,
  note: '电子税务局网页端申报，税库银协议扣款',
};

/* ------------------------------------------------------------------ */
/* 一、迁移表本身                                                      */
/* ------------------------------------------------------------------ */

describe('申报状态机迁移表', () => {
  it('calculated 到 filed 不是合法迁移（结构性不可能）', () => {
    assert.equal(canTransition('calculated', 'filed'), false);
    assert.equal(TRANSITIONS.calculated.includes('filed'), false);
    assert.equal(TRANSITIONS.void.length, 0, '作废是终态，不能再迁出');
  });

  it('契约里承诺的迁移都在表内', () => {
    assert.equal(canTransition('draft', 'calculated'), true);
    assert.equal(canTransition('calculated', 'reviewed'), true);
    assert.equal(canTransition('reviewed', 'approved'), true);
    assert.equal(canTransition('approved', 'filed'), true);
    assert.equal(canTransition('rejected', 'draft'), true);
    assert.equal(canTransition('approved', 'approved'), true, '导出需要自迁移留痕');
    assert.equal(canTransition('void', 'draft'), false);
  });
});

/* ------------------------------------------------------------------ */
/* 二、完整 happy path                                                 */
/* ------------------------------------------------------------------ */

describe('完整链路：草稿 → 计算 → 复核 → 审批 → 导出 → 人工申报回填', () => {
  it('每一步的状态、版本、事件与签署都正确', () => {
    const wf = newWorkflow();

    const draft = wf.registerDraft(makeReturn());
    assert.equal(draft.status, 'draft');
    assert.equal(draft.events.length, 0, '登记草稿不是状态迁移，不产生事件');
    assert.equal(draft.payloadHash.length, 64, '登记时即计算指纹');
    assert.equal(draft.due, draft.payable - draft.prepaid);

    const calculated = wf.calculate(ID, '张会计');
    assert.equal(calculated.status, 'calculated');
    assert.equal(calculated.version, 2, '重算即新版本');
    assert.equal(calculated.events.length, 1);
    assert.equal(calculated.events[0]?.from, 'draft');
    assert.equal(calculated.events[0]?.to, 'calculated');
    assert.equal(calculated.events[0]?.humanInitiated, true);
    assert.notEqual(calculated.payloadHash, draft.payloadHash, '版本变化必须改变指纹');
    assert.equal(calculated.signatures.length, 1);
    assert.equal(calculated.signatures[0]?.role, 'preparer');
    assert.equal(calculated.signatures[0]?.actor, '张会计');
    assert.equal(
      calculated.signatures[0]?.payloadHash,
      calculated.payloadHash,
      '签署指纹必须等于签署当时的内容指纹',
    );

    const reviewed = wf.review(ID, sig('reviewer', '李主管'));
    assert.equal(reviewed.status, 'reviewed');
    assert.equal(reviewed.events.length, 2);
    assert.equal(reviewed.events[1]?.from, 'calculated');
    assert.equal(reviewed.events[1]?.to, 'reviewed');
    assert.equal(reviewed.signatures.length, 2);
    assert.equal(reviewed.signatures[1]?.role, 'reviewer');
    assert.equal(reviewed.signatures[1]?.payloadHash, reviewed.payloadHash);

    const approved = wf.approve(ID, sig('approver', '王总'));
    assert.equal(approved.status, 'approved');
    assert.equal(approved.events.length, 3);
    assert.equal(approved.events[2]?.to, 'approved');
    assert.equal(approved.signatures.length, 3);
    assert.equal(approved.signatures[2]?.role, 'approver');

    const exported = wf.exportForFiling(ID, '王总');
    assert.equal(exported.status, 'approved', '导出不改变状态，只留痕');
    assert.equal(exported.events.length, 4);
    assert.equal(exported.events[3]?.from, 'approved');
    assert.equal(exported.events[3]?.to, 'approved');
    assert.match(exported.events[3]?.reason ?? '', /未向任何税务机关提交/);

    const filed = wf.reportManualFiling(ID, MANUAL_RECORD);
    assert.equal(filed.status, 'filed');
    assert.equal(filed.manualFiling?.receiptNo, MANUAL_RECORD.receiptNo);
    assert.equal(filed.manualFiling?.paidAmount, 700000);
    assert.equal(filed.events.length, 5);
    assert.equal(filed.events[4]?.from, 'approved');
    assert.equal(filed.events[4]?.to, 'filed');
    assert.match(filed.events[4]?.reason ?? '', /回执号/);
    assert.equal(wf.pendingActions().length, 0, '已申报后没有待办');
  });
});

/* ------------------------------------------------------------------ */
/* 三、硬闸门                                                          */
/* ------------------------------------------------------------------ */

describe('硬闸门：绕不过去的几条线', () => {
  it('calculated 直接迁移到 filed 抛 IllegalTransitionError', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    wf.calculate(ID, '张会计');

    assert.throws(
      () => wf.reportManualFiling(ID, MANUAL_RECORD),
      (err: unknown) => {
        assert.ok(err instanceof IllegalTransitionError, '必须是 IllegalTransitionError');
        assert.equal(err.from, 'calculated');
        assert.equal(err.to, 'filed');
        assert.match(err.message, /非法状态迁移/);
        return true;
      },
    );
    assert.equal(wf.get(ID).status, 'calculated', '失败的迁移不能改变状态');
  });

  it('未审批不能导出申报底稿', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    wf.calculate(ID, '张会计');
    assert.throws(() => wf.exportForFiling(ID, '王总'), ExportNotAllowedError);
  });

  it('自我复核被拒（复核人 = 制单人）', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    wf.calculate(ID, '张会计');
    assert.throws(() => wf.review(ID, sig('reviewer', '张会计')), SelfReviewForbidden);
    assert.equal(wf.get(ID).status, 'calculated');
  });

  it('审批人 = 复核人被拒（四眼原则）', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    wf.calculate(ID, '张会计');
    wf.review(ID, sig('reviewer', '李主管'));
    assert.throws(() => wf.approve(ID, sig('approver', '李主管')), FourEyesViolation);
    assert.equal(wf.get(ID).status, 'reviewed');
  });

  it('签署角色写错被拒', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    wf.calculate(ID, '张会计');
    assert.throws(() => wf.review(ID, sig('approver', '李主管')), FilingGuardError);
  });

  it('重算后旧签署失效（StaleSignatureError）', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    const first = wf.calculate(ID, '张会计');
    wf.review(ID, sig('reviewer', '李主管'));
    wf.reject(ID, '李主管', '进项税额与认证结果不一致');
    wf.revise(ID, '张会计', { lines: makeLines(810000), payable: 810000 });
    wf.calculate(ID, '张会计');
    wf.review(ID, sig('reviewer', '李主管'));

    const stale = { ...sig('approver', '王总'), payloadHash: first.payloadHash };
    assert.throws(
      () => wf.approve(ID, stale as unknown as Omit<Signature, 'payloadHash'>),
      StaleSignatureError,
    );
    assert.equal(wf.get(ID).status, 'reviewed', '被拒的审批不能改变状态');
  });

  it('未带 receiptNo 的人工申报回填被拒', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    wf.calculate(ID, '张会计');
    wf.review(ID, sig('reviewer', '李主管'));
    wf.approve(ID, sig('approver', '王总'));

    assert.throws(
      () => wf.reportManualFiling(ID, { ...MANUAL_RECORD, receiptNo: '   ' }),
      FilingGuardError,
    );
    assert.equal(wf.get(ID).status, 'approved', '没有回执号就不能标记已申报');
  });

  it('submitToTaxBureau 恒抛 AutoSubmissionForbidden', () => {
    assert.throws(() => submitToTaxBureau(), AutoSubmissionForbidden);
    assert.throws(() => submitToTaxBureau({ id: ID }), AutoSubmissionForbidden);
  });
});

/* ------------------------------------------------------------------ */
/* 四、退回 / 修订 / 作废                                              */
/* ------------------------------------------------------------------ */

describe('退回、修订与作废', () => {
  it('退回 → 修订 → 重算：版本递增、指纹变化、旧签署保留', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    const v2 = wf.calculate(ID, '张会计');
    wf.review(ID, sig('reviewer', '李主管'));

    const rejected = wf.reject(ID, '李主管', '进项税额与认证结果不一致');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.version, v2.version, '退回不改内容，不升版本');
    assert.equal(rejected.events.at(-1)?.to, 'rejected');

    const draft = wf.revise(ID, '张会计', { lines: makeLines(810000), payable: 810000 });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.version, v2.version + 1, '修订必须升版本');
    assert.notEqual(draft.payloadHash, v2.payloadHash);
    assert.equal(draft.signatures.length, 2, '旧签署只能追加，不能删除');
    assert.equal(draft.signatures[0]?.payloadHash, v2.payloadHash, '旧签署仍指向旧指纹');

    const recalculated = wf.calculate(ID, '张会计');
    assert.equal(recalculated.version, draft.version + 1);
    assert.equal(recalculated.signatures.length, 3);
    assert.equal(recalculated.due, 810000 - 100000);
  });

  it('已申报后补录回执：原回执保留在事件流里，不覆盖历史', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    wf.calculate(ID, '张会计');
    wf.review(ID, sig('reviewer', '李主管'));
    wf.approve(ID, sig('approver', '王总'));
    wf.reportManualFiling(ID, MANUAL_RECORD);

    const refiled = wf.reportManualFiling(ID, {
      ...MANUAL_RECORD,
      receiptNo: '31012024020009999',
      note: '原回执号录入有误，补录更正',
    });
    assert.equal(refiled.status, 'filed');
    assert.equal(refiled.manualFiling?.receiptNo, '31012024020009999');
    assert.equal(refiled.events.at(-1)?.from, 'filed');
    assert.equal(refiled.events.at(-1)?.to, 'filed');
    assert.match(
      refiled.events.at(-1)?.reason ?? '',
      /原回执号 31012024020001234/,
      '旧回执号必须留在事件流里，禁止物理覆盖',
    );
  });

  it('修订必须真的改动内容', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    wf.calculate(ID, '张会计');
    wf.reject(ID, '李主管', '口径需要复核');
    assert.throws(() => wf.revise(ID, '张会计', {}), FilingGuardError);
  });

  it('作废需要理由，作废后不能再计算', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    wf.calculate(ID, '张会计');
    assert.throws(() => wf.void(ID, '王总', '短'), FilingGuardError);

    const voided = wf.void(ID, '王总', '开票数据整体作废，本期重新出具');
    assert.equal(voided.status, 'void');
    assert.equal(voided.events.at(-1)?.to, 'void');
    assert.match(voided.events.at(-1)?.reason ?? '', /作废/);
    assert.throws(() => wf.calculate(ID, '张会计'), IllegalTransitionError);
  });
});

/* ------------------------------------------------------------------ */
/* 五、登记与查询                                                      */
/* ------------------------------------------------------------------ */

describe('登记、查询与隔离', () => {
  it('重复登记与非草稿登记被拒', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    assert.throws(() => wf.registerDraft(makeReturn()), FilingWorkflowError);
    assert.throws(
      () => wf.registerDraft(makeReturn({ id: 'X-1', status: 'approved' })),
      FilingWorkflowError,
    );
  });

  it('空申报行与应纳税额不自洽不能计算', () => {
    const empty = newWorkflow();
    empty.registerDraft(makeReturn({ lines: [] }));
    assert.throws(() => empty.calculate(ID, '张会计'), FilingGuardError);

    const mismatch = newWorkflow();
    mismatch.registerDraft(makeReturn({ payable: 900000 }));
    assert.throws(() => mismatch.calculate(ID, '张会计'), FilingGuardError);
  });

  it('同时含「应补(退)税额」行时不影响应纳税额勾稽', () => {
    const wf = newWorkflow();
    const ret = makeReturn();
    ret.lines = [
      ...makeLines(800000),
      { code: 'DUE', label: '应补(退)税额', amount: 700000, note: '应纳税额 - 已预缴' },
    ];
    wf.registerDraft(ret);
    const calculated = wf.calculate(ID, '张会计');
    assert.equal(calculated.status, 'calculated');
    assert.equal(calculated.due, 700000, '应补(退)税额行不参与应纳税额勾稽');
  });

  it('get() 返回深拷贝，外部改动不会污染内部记录', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    const copy = wf.get(ID);
    copy.payable = 1;
    copy.signatures.push({
      role: 'approver',
      actor: '伪造者',
      at: '2024-02-01T00:00:00+08:00',
      method: 'manual',
      payloadHash: 'x',
    });
    const fresh = wf.get(ID);
    assert.equal(fresh.payable, 800000);
    assert.equal(fresh.signatures.length, 0);
  });

  it('list() 支持按期间 / 状态 / 税种筛选，pendingActions 给出下一步与责任人', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    wf.registerDraft(makeReturn({ id: 'CIT-2024-01-001', taxType: 'cit' }));

    assert.equal(wf.list().length, 2);
    assert.equal(wf.list({ taxType: 'cit' }).length, 1);
    assert.equal(wf.list({ status: 'draft' }).length, 2);
    assert.equal(wf.list({ period: '2024-03' }).length, 0);

    const pending = wf.pendingActions();
    assert.equal(pending.length, 2);
    assert.equal(pending[0]?.assigneeRole, 'preparer');
    assert.match(pending[0]?.action ?? '', /计算/);

    wf.calculate(ID, '张会计');
    const afterCalc = wf.pendingActions().find((item) => item.id === ID);
    assert.equal(afterCalc?.assigneeRole, 'reviewer');
    assert.equal(afterCalc?.status, 'calculated');
  });

  it('未登记的申报表给出明确错误', () => {
    const wf = newWorkflow();
    assert.throws(() => wf.get('NOT-EXISTS'), FilingWorkflowError);
  });

  it('时钟可注入：事件与签署使用同一时钟', () => {
    const wf = newWorkflow();
    wf.registerDraft(makeReturn());
    const calculated = wf.calculate(ID, '张会计');
    assert.match(calculated.events[0]?.at ?? '', /^2024-02-01T10:/);
    assert.equal(calculated.signatures[0]?.at, calculated.events[0]?.at);
  });
});

/* ------------------------------------------------------------------ */
/* 六、配置与指纹                                                      */
/* ------------------------------------------------------------------ */

describe('流程配置与内容指纹', () => {
  it('config/filing.yaml 能加载，且默认口径是最保守的', () => {
    const config = loadFilingConfig();
    assert.equal(config.fourEyes, true);
    assert.equal(config.allowSelfReview, false);
    assert.equal(config.requireReviewReport, true);
    assert.equal(config.requirePreparerSignature, true);
    assert.equal(config.roles.reviewer.role, 'reviewer');
    assert.ok(config.requiredMaterials.length >= 3, '必备材料清单不能为空');
    assert.ok(
      config.requiredMaterials.every((item) => item.basis.length > 0),
      '每条必备材料都必须带法规依据',
    );
    assert.match(config.exportDeclaration, /不代为提交/);
  });

  it('指纹对字段顺序不敏感，对内容敏感', () => {
    const a = makeReturn();
    const b = makeReturn({ payable: 800001 });
    assert.equal(hashFilingPayload(a), hashFilingPayload(makeReturn()));
    assert.notEqual(hashFilingPayload(a), hashFilingPayload(b));

    const reordered = { ...makeReturn() };
    reordered.lines = makeLines(800000);
    assert.equal(hashFilingPayload(reordered), hashFilingPayload(makeReturn()));
  });
});
