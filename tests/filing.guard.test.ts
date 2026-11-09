/**
 * 申报闸门单测：提交禁令、导出门禁、前置条件、源码级「不可能外发」证明。
 *
 * 最狠的一条是最后那个源码扫描：它不是测「函数返回什么」，而是测
 * 「整个 src/filing 目录里根本不存在能把数据发出去的代码」。
 * 监管要求「绝不自动提交」，靠的不是自觉，而是这段断言。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

import { ConfigError, PROJECT_ROOT } from '../src/core/config.ts';
import type { LawBasis, ManualFilingRecord, TaxLine, TaxReturn } from '../src/core/contracts.ts';
import {
  AutoSubmissionForbidden,
  ExportNotAllowedError,
  FILING_DECLARATION,
  FilingGuardError,
  MissingSignatureError,
  StaleSignatureError,
  assertExportable,
  assertFilingReadyForManualSubmission,
  assertLinesConsistent,
  assertManualFilingRecord,
  assertNoAutoSubmission,
  assertReturnIntegrity,
  assertReviewPassed,
  assertSignaturesComplete,
  assertSignaturesFresh,
  defaultFilingConfig,
  exportFilingPackage,
  getFilingGuardAuditTrail,
  hashFilingPayload,
  loadFilingConfig,
  submitToTaxBureau,
} from '../src/filing/index.ts';

/* ------------------------------------------------------------------ */
/* 测试夹具                                                            */
/* ------------------------------------------------------------------ */

const LAW: LawBasis = {
  id: 'vat-temporary-regulations',
  title: '中华人民共和国增值税暂行条例',
  article: '第二条',
  level: 'administrative-regulation',
};

function makeLines(payable: number): TaxLine[] {
  return [
    { code: '1', label: '按适用税率计税销售额', amount: 10000000, note: '销项不含税销售额' },
    { code: '11', label: '销项税额', amount: 1300000, rate: 0.13, note: '10,000,000 × 13%', basis: [LAW] },
    { code: '12', label: '进项税额', amount: 500000, note: '已认证抵扣' },
    { code: 'PAYABLE', label: '本期应纳税额', amount: payable, note: '销项税额 - 进项税额' },
  ];
}

function makeReturn(): TaxReturn {
  return {
    id: 'VAT-2024-01-001',
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
    benefits: [
      {
        policyId: 'small-profit-2023-12',
        policyName: '小型微利企业所得税优惠',
        eligible: false,
        reasons: ['本期为增值税申报，不涉及企业所得税'],
        estimatedBenefit: 0,
        basis: [LAW],
        manualChecks: ['需人工确认从业人数与资产总额'],
      },
    ],
    reviewId: 'RV-2024-01-001',
    blockingIssues: 0,
    signatures: [],
    events: [],
    payloadHash: '',
    createdAt: '2024-02-01T09:00:00+08:00',
    updatedAt: '2024-02-01T09:00:00+08:00',
  };
}

/** 构造一张「已审批且签署齐备」的申报表。 */
function makeApproved(): TaxReturn {
  const ret = makeReturn();
  ret.status = 'approved';
  ret.version = 2;
  ret.due = ret.payable - ret.prepaid;
  ret.payloadHash = hashFilingPayload(ret);
  ret.signatures = [
    { role: 'preparer', actor: '张会计', at: '2024-02-01T10:00:00+08:00', method: 'manual', payloadHash: ret.payloadHash },
    { role: 'reviewer', actor: '李主管', at: '2024-02-01T11:00:00+08:00', method: 'manual', payloadHash: ret.payloadHash },
    { role: 'approver', actor: '王总', at: '2024-02-01T12:00:00+08:00', method: 'manual', payloadHash: ret.payloadHash },
  ];
  return ret;
}

const MANUAL_RECORD: ManualFilingRecord = {
  channel: 'etax-manual',
  receiptNo: '31012024020001234',
  filedAt: '2024-02-15T10:20:00+08:00',
  actor: '张会计',
  paidAmount: 700000,
};

function sheetText(sheet: ExcelJS.Worksheet): string {
  const parts: string[] = [];
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      if (cell.value !== null && cell.value !== undefined) parts.push(String(cell.value));
    });
  });
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* 一、提交禁令                                                        */
/* ------------------------------------------------------------------ */

describe('提交禁令：结构性不可能', () => {
  it('submitToTaxBureau 恒抛 AutoSubmissionForbidden 并留下拦截记录', () => {
    const before = getFilingGuardAuditTrail().length;
    assert.throws(() => submitToTaxBureau(), AutoSubmissionForbidden);
    assert.throws(() => submitToTaxBureau({ id: 'VAT-2024-01-001' }, 'force'), AutoSubmissionForbidden);

    const trail = getFilingGuardAuditTrail();
    assert.equal(trail.length, before + 2, '每次调用都必须留痕');
    assert.equal(trail[trail.length - 1]?.action, 'submission_blocked');
  });

  it('assertNoAutoSubmission 恒通过，但会写审计日志', () => {
    const before = getFilingGuardAuditTrail().length;
    assert.equal(assertNoAutoSubmission(), undefined);
    const trail = getFilingGuardAuditTrail();
    assert.equal(trail.length, before + 1);
    assert.equal(trail[trail.length - 1]?.action, 'auto_submission_check');
    assert.match(trail[trail.length - 1]?.detail ?? '', /不包含任何向税务机关自动提交/);
  });

  it('审计流水只追加，序号单调递增', () => {
    const trail = getFilingGuardAuditTrail();
    assert.ok(trail.length >= 2);
    for (let i = 1; i < trail.length; i += 1) {
      const prev = trail[i - 1]?.seq ?? 0;
      const curr = trail[i]?.seq ?? 0;
      assert.ok(curr > prev, `审计序号必须递增：${prev} → ${curr}`);
    }
    // 返回的是副本：外部 push 不会污染内部流水
    (trail as unknown as unknown[]).push({});
    assert.equal(getFilingGuardAuditTrail().length, trail.length - 1);
  });
});

/* ------------------------------------------------------------------ */
/* 二、导出门禁                                                        */
/* ------------------------------------------------------------------ */

describe('导出门禁：只有已审批才能出底稿', () => {
  it('草稿/已计算状态导出直接抛 ExportNotAllowedError', () => {
    const draft = makeReturn();
    assert.throws(() => assertExportable(draft), ExportNotAllowedError);

    const calculated = makeReturn();
    calculated.status = 'calculated';
    assert.throws(() => assertExportable(calculated), ExportNotAllowedError);
    assert.match(
      (() => {
        try {
          assertExportable(draft);
          return '';
        } catch (err) {
          return (err as Error).message;
        }
      })(),
      /只有「已审批」的申报表才能导出/,
    );
  });

  it('缺少审批人签署不能导出', () => {
    const ret = makeApproved();
    ret.signatures = ret.signatures.filter((item) => item.role !== 'approver');
    assert.throws(() => assertExportable(ret), ExportNotAllowedError);
  });

  it('签署基于旧版本时导出抛 StaleSignatureError', () => {
    const ret = makeApproved();
    const reviewer = ret.signatures.find((item) => item.role === 'reviewer');
    assert.ok(reviewer);
    reviewer.payloadHash = 'deadbeef'.repeat(8);
    assert.throws(() => assertExportable(ret), StaleSignatureError);
  });

  it('已申报状态不能再导出底稿', () => {
    const ret = makeApproved();
    ret.status = 'filed';
    ret.manualFiling = MANUAL_RECORD;
    assert.throws(() => assertExportable(ret), ExportNotAllowedError);
  });

  it('审批齐备时可以导出 Excel：三张表 + 每张表头都有禁止提交声明', async () => {
    const dir = mkdtempSync(join(PROJECT_ROOT, '.test-tmp-filing-'));
    try {
      const outPath = join(dir, '申报底稿_增值税_2024-01.xlsx');
      const ret = makeApproved();
      assert.doesNotThrow(() => assertExportable(ret));

      await exportFilingPackage(ret, outPath);
      assert.ok(statSync(outPath).size > 2000, '导出的工作簿不应为空');

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(outPath);
      assert.deepEqual(
        wb.worksheets.map((sheet) => sheet.name),
        ['申报表主表', '计算过程与法规依据', '签署与留痕'],
      );

      for (const sheet of wb.worksheets) {
        assert.equal(
          sheet.getCell(1, 1).value,
          FILING_DECLARATION,
          `${sheet.name} 的第一行必须是禁止提交声明`,
        );
        assert.match(sheetText(sheet), /需由人工在电子税务局核对后自行申报/);
      }

      const main = wb.getWorksheet('申报表主表');
      assert.ok(main);
      const mainText = sheetText(main);
      assert.match(mainText, /已审批/);

      assert.equal(mainText.includes('[object Object]'), false, '单元格不得出现 [object Object]');

      const rows: ExcelJS.Row[] = [];
      main.eachRow((row) => rows.push(row));
      const payableRow = rows.find((row) => row.getCell(2).value === '本期应纳税额');
      assert.ok(payableRow, '主表应包含「本期应纳税额」行');
      assert.equal(payableRow.getCell(3).value, 8000, '800000 分应写成 8000.00 元（数值型，不是文本）');

      const taxRateRow = rows.find((row) => row.getCell(1).value === '11');
      assert.ok(taxRateRow, '主表应包含销项税额行');
      assert.equal(taxRateRow.getCell(4).value, '13%', '税率应显示为百分数而不是 0.13');

      const sign = wb.getWorksheet('签署与留痕');
      assert.ok(sign);
      const signText = sheetText(sign);
      assert.match(signText, /张会计/);
      assert.match(signText, /李主管/);
      assert.match(signText, /王总/);
      assert.match(signText, /尚未回填/, '未申报时回填栏应提示尚未回填');

      const calc = wb.getWorksheet('计算过程与法规依据');
      assert.ok(calc);
      assert.match(sheetText(calc), /中华人民共和国增值税暂行条例/, '计算表必须带法规依据');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* 三、前置条件断言                                                    */
/* ------------------------------------------------------------------ */

describe('前置条件断言', () => {
  it('申报行必须存在且金额是整数分', () => {
    const empty = makeReturn();
    empty.lines = [];
    assert.throws(() => assertLinesConsistent(empty), FilingGuardError);

    const floatPayable = makeReturn();
    floatPayable.payable = 8000.5;
    assert.throws(() => assertLinesConsistent(floatPayable), /整数「分」/);

    const floatLine = makeReturn();
    const line = floatLine.lines[1];
    assert.ok(line);
    line.amount = 1300.5;
    assert.throws(() => assertLinesConsistent(floatLine), FilingGuardError);
  });

  it('应纳税额必须与申报表「应纳税额」行一致', () => {
    const ret = makeReturn();
    ret.payable = 900000;
    assert.throws(() => assertLinesConsistent(ret), /勾稽不符/);
  });

  it('纳税调整项必须带法规依据', () => {
    const ret = makeReturn();
    ret.adjustments = [
      { code: 'A01', label: '业务招待费调增', amount: 12000, reason: '超过扣除限额', basis: [] },
    ];
    assert.throws(() => assertLinesConsistent(ret), /缺少法规依据/);
  });

  it('应补(退)税额与指纹必须自洽', () => {
    const wrongDue = makeReturn();
    wrongDue.due = 999;
    wrongDue.payloadHash = hashFilingPayload(wrongDue);
    assert.throws(() => assertReturnIntegrity(wrongDue), /应补\(退\)税额勾稽不符/);

    const tampered = makeReturn();
    tampered.payloadHash = hashFilingPayload(tampered);
    tampered.payable = 810000;
    tampered.lines = makeLines(810000);
    tampered.due = 710000; // 勾稽关系自洽，只剩指纹对不上
    assert.throws(() => assertReturnIntegrity(tampered), /计算指纹不一致/);

    const consistent = makeReturn();
    consistent.payloadHash = hashFilingPayload(consistent);
    assert.doesNotThrow(() => assertReturnIntegrity(consistent));
  });

  it('人工申报回填记录必须合法', () => {
    assert.throws(() => assertManualFilingRecord({ ...MANUAL_RECORD, receiptNo: '' }), /回执号/);
    assert.throws(() => assertManualFilingRecord({ ...MANUAL_RECORD, paidAmount: -1 }), FilingGuardError);
    assert.throws(
      () => assertManualFilingRecord({ ...MANUAL_RECORD, channel: 'api' as never }),
      /申报渠道非法/,
    );
    assert.throws(() => assertManualFilingRecord({ ...MANUAL_RECORD, actor: '  ' }), /回填人/);

    const cleaned = assertManualFilingRecord({ ...MANUAL_RECORD, receiptNo: '  ABC123  ' });
    assert.equal(cleaned.receiptNo, 'ABC123', '回执号应被清洗空白');
  });

  it('签署齐备性与新鲜度', () => {
    const ret = makeApproved();
    assert.doesNotThrow(() => assertSignaturesComplete(ret, defaultFilingConfig()));

    const noApprover = makeApproved();
    noApprover.signatures = noApprover.signatures.filter((item) => item.role !== 'approver');
    assert.throws(
      () => assertSignaturesComplete(noApprover, defaultFilingConfig()),
      MissingSignatureError,
    );

    const stale = makeApproved();
    const preparer = stale.signatures.find((item) => item.role === 'preparer');
    assert.ok(preparer);
    preparer.payloadHash = 'old-hash';
    assert.throws(() => assertSignaturesFresh(stale), StaleSignatureError);
  });

  it('审核报告未通过或缺失时不能复核', () => {
    const ret = makeReturn();
    assert.throws(
      () => assertReviewPassed(ret, { blockingCount: () => 2 }, defaultFilingConfig()),
      /阻断项/,
    );

    const noReport = makeReturn();
    noReport.reviewId = null;
    assert.throws(() => assertReviewPassed(noReport, {}, defaultFilingConfig()), /缺少审核报告/);

    assert.doesNotThrow(() => assertReviewPassed(ret, {}, defaultFilingConfig()));
    assert.throws(
      () => assertReviewPassed(ret, { isReviewPassed: () => false }, defaultFilingConfig()),
      /未通过/,
    );
  });

  it('提交前总自检：未审批一律拒绝', () => {
    assert.throws(
      () => assertFilingReadyForManualSubmission(makeReturn(), defaultFilingConfig()),
      ExportNotAllowedError,
    );
    const approved = makeApproved();
    assert.doesNotThrow(() => assertFilingReadyForManualSubmission(approved, defaultFilingConfig()));
  });
});

/* ------------------------------------------------------------------ */
/* 四、源码级保证                                                      */
/* ------------------------------------------------------------------ */

describe('源码级保证：申报模块没有能力把数据发出去', () => {
  const FILING_DIR = join(PROJECT_ROOT, 'src', 'filing');

  it('src/filing/*.ts 不含任何 HTTP 客户端 / fetch / socket 调用', () => {
    // 这些字面量故意拼接，避免测试文件本身被误扫
    const forbidden = [
      'fetch' + '(',
      'XMLHttp' + 'Request',
      'axi' + 'os',
      'http' + '.request',
      'https' + '.request',
      'node:' + 'http',
      'node:' + 'https',
      'Web' + 'Socket',
      'net' + '.connect',
      'dns' + '.lookup',
      'undici',
    ];

    const files = readdirSync(FILING_DIR).filter((file) => file.endsWith('.ts'));
    assert.ok(files.length >= 4, `申报模块至少应有 4 个源文件，实际 ${files.length} 个`);

    for (const file of files) {
      const source = readFileSync(join(FILING_DIR, file), 'utf8');
      for (const token of forbidden) {
        assert.equal(
          source.includes(token),
          false,
          `${file} 不应包含外发请求代码「${token}」：申报模块不允许有任何联网能力`,
        );
      }
    }
  });

  it('状态只能由状态机写入：workflow.ts 不直接给 status 赋值', () => {
    const source = readFileSync(join(FILING_DIR, 'workflow.ts'), 'utf8');
    // 只匹配真正的赋值（.status = x），排除 === / == 比较
    const assignments = source.match(/\.status\s*=(?!=)/g) ?? [];
    assert.equal(assignments.length, 0, '工作流不得直接写 status，必须走 applyTransition()');

    const stateMachine = readFileSync(join(FILING_DIR, 'state-machine.ts'), 'utf8');
    const stateAssignments = stateMachine.match(/\.status\s*=(?!=)/g) ?? [];
    assert.equal(stateAssignments.length, 1, '整个模块只允许状态机里唯一一处状态写入');
    assert.ok(stateMachine.includes('ret.status = to'), '唯一的赋值点在 applyTransition 里');
  });

  it('导出门禁与提交禁令都在 guard.ts 里实现', () => {
    const guard = readFileSync(join(FILING_DIR, 'guard.ts'), 'utf8');
    assert.ok(guard.includes('export function submitToTaxBureau'));
    assert.ok(guard.includes('throw new AutoSubmissionForbidden'));
    assert.ok(guard.includes('export function assertNoAutoSubmission'));
  });
});

/* ------------------------------------------------------------------ */
/* 五、配置                                                            */
/* ------------------------------------------------------------------ */

describe('配置加载', () => {
  it('缺少 filing.yaml 时报错而不是静默降级', () => {
    const dir = mkdtempSync(join(PROJECT_ROOT, '.test-tmp-filing-cfg-'));
    try {
      assert.throws(() => loadFilingConfig(dir), ConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未知配置项直接报错，避免拼错的开关被静默忽略', () => {
    const dir = mkdtempSync(join(PROJECT_ROOT, '.test-tmp-filing-cfg-'));
    try {
      writeFileSync(join(dir, 'filing.yaml'), 'version: 1\nbogusSwitch: true\n', 'utf8');
      assert.throws(() => loadFilingConfig(dir), ConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('仓库自带配置可以正常加载', () => {
    const config = loadFilingConfig();
    assert.equal(config.fourEyes, true);
    assert.equal(config.allowSelfReview, false);
    assert.equal(config.exportFilePrefix.length > 0, true);
    assert.ok(config.roles.approver.label.length > 0);
  });
});
