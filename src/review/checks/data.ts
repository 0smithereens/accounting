/**
 * 数据质量与内控检查。
 *
 * 这一层不直接看金额，而是看「账是怎么做出来的」：
 *  - 单据要素是否齐全（缺日期/缺金额）；
 *  - 单据是否真的进了账（未匹配规则 = 账外业务）；
 *  - 关键岗位是否分离（同一人既编制又复核 = 内控失效）；
 *  - 是否存在物理删除痕迹（凭证断号、删除告警）。
 *
 * 其中「人工签署」检查（IC-SIGNATURE-001）是产品监管硬约束的落地点：
 * AI 生成的税务计算必须经过「草稿 → 复核 → 审批」的人工签署，
 * 只有状态没有签署记录，等于流程被绕过。
 */

import type {
  DocumentRecord,
  LawBasis,
  ReviewContext,
  ReviewFinding,
  ReviewInput,
  ReviewTarget,
  SignRole,
  Voucher,
} from '../../core/contracts.ts';
import { SOURCE_KIND_LABEL } from '../../core/types.ts';
import { formatYuan } from '../../core/money.ts';
import {
  LAW_ACCOUNTING_BASIS_48,
  LAW_ACCOUNTING_BASIS_50,
  LAW_ACCOUNTING_BASIS_52,
  LAW_ACCOUNTING_LAW_14,
  LAW_ACCOUNTING_LAW_27,
  LAW_ACCOUNTING_LAW_44,
  LAW_ACCOUNTING_LAW_9,
  LAW_ARCHIVES_13,
  LAW_INTERNAL_CONTROL_29,
  LAW_TAX_COLLECTION_25,
} from '../legal.ts';
import { latestTaxReturns } from './tax.ts';
import type { CheckDefinition } from '../engine.ts';

/* ================================================================== */
/* 一、规则 id                                                         */
/* ================================================================== */

export const DATA_RULE_IDS = {
  missing: 'DATA-MISSING-001',
  unmatched: 'DATA-UNMATCHED-001',
  segregation: 'IC-SEGREGATION-001',
  signature: 'IC-SIGNATURE-001',
  softDelete: 'IC-SOFTDELETE-001',
} as const;

/* ================================================================== */
/* 二、工具                                                            */
/* ================================================================== */

function makeFinding(
  ctx: ReviewContext,
  ruleId: string,
  target: ReviewTarget,
  title: string,
  detail: string,
  suggestion: string,
  basis: LawBasis[],
  evidence?: Record<string, unknown>,
): ReviewFinding {
  const finding: ReviewFinding = {
    id: ctx.nextId(),
    ruleId,
    severity: 'warning',
    category: 'data_quality',
    title,
    detail,
    suggestion,
    basis,
    target,
    blocking: false,
  };
  if (evidence !== undefined) finding.evidence = evidence;
  return finding;
}

function documentTarget(document: DocumentRecord): ReviewTarget {
  return {
    kind: 'document',
    id: document.id,
    label: `${SOURCE_KIND_LABEL[document.kind]}：${document.summary}`,
  };
}

function sourceKey(file: string, sheet: string | undefined, row: number): string {
  return `${file}|${sheet ?? ''}|${row}`;
}

const ROLE_LABEL: Record<SignRole, string> = {
  preparer: '编制',
  reviewer: '复核',
  approver: '审批',
};

/* ================================================================== */
/* 三、检查项                                                          */
/* ================================================================== */

/** DATA-MISSING-001：单据缺日期/金额。 */
function checkMissingFields(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const document of input.documents) {
    const problems: string[] = [];
    if (document.date === null) problems.push('缺少业务日期');
    if (document.amount === 0) problems.push('金额为 0');
    if (document.amount < 0) problems.push(`金额为负数（${formatYuan(document.amount)} 元）`);
    if (problems.length === 0) continue;

    findings.push(
      makeFinding(
        ctx,
        DATA_RULE_IDS.missing,
        documentTarget(document),
        '单据缺少必要要素',
        `单据「${document.summary}」（${SOURCE_KIND_LABEL[document.kind]}，来源 ${document.source.file}` +
          `${document.source.row === undefined ? '' : ` 第 ${document.source.row} 行`}）：${problems.join('；')}。` +
          '原始凭证必须包含日期、经济业务内容与金额等要素，否则无法据以填制记账凭证。',
        '补充业务日期与金额后重新识别；若原始单据确实缺失，应要求经办人补开或提供替代证明，' +
          '并在凭证摘要中注明原因。不得用缺省日期或 0 金额直接入账。',
        [LAW_ACCOUNTING_BASIS_48, LAW_ACCOUNTING_LAW_14],
        {
          documentId: document.id,
          kind: document.kind,
          date: document.date,
          amount: document.amount,
          file: document.source.file,
          row: document.source.row ?? null,
          problems,
        },
      ),
    );
  }

  return findings;
}

/** DATA-UNMATCHED-001：单据未匹配到记账规则。 */
function checkUnmatchedDocuments(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const exact = new Set<string>();
  const summariesByFile = new Map<string, Set<string>>();

  for (const voucher of input.vouchers) {
    for (const line of voucher.lines) {
      const source = line.source;
      if (source.row !== undefined) {
        exact.add(sourceKey(source.file, source.sheet, source.row));
      }
      if (source.rawSummary !== undefined && source.rawSummary !== '') {
        const set = summariesByFile.get(source.file) ?? new Set<string>();
        set.add(source.rawSummary);
        summariesByFile.set(source.file, set);
      }
    }
  }

  const findings: ReviewFinding[] = [];

  for (const document of input.documents) {
    // 合同本身不是会计事项：金额为 0 且未收付的合同只登记台账，不生成凭证是正常的。
    if (document.kind === 'contract' && document.amount === 0) continue;

    let matched = false;
    if (document.source.row !== undefined) {
      matched = exact.has(sourceKey(document.source.file, document.source.sheet, document.source.row));
    }
    if (!matched) {
      const summaries = summariesByFile.get(document.source.file);
      if (summaries !== undefined) {
        matched =
          summaries.has(document.source.rawSummary ?? document.summary) ||
          summaries.has(document.summary);
      }
    }
    if (matched) continue;

    findings.push(
      makeFinding(
        ctx,
        DATA_RULE_IDS.unmatched,
        documentTarget(document),
        '单据未匹配到记账规则',
        `单据「${document.summary}」（${SOURCE_KIND_LABEL[document.kind]}，金额 ${formatYuan(document.amount)} 元，` +
          `来源 ${document.source.file}${document.source.row === undefined ? '' : ` 第 ${document.source.row} 行`}）` +
          '未能匹配到任何记账规则，也没有找到由它生成的凭证分录。' +
          '这意味着该笔业务没有进入账簿，会造成账实不符、少计收入或漏记成本。',
        '在 config/mappings 下补充覆盖该业务的规则，或由会计人工编制凭证；' +
          '同时检查规则条件是否过窄（摘要关键字、方向、金额区间）。未入账的业务必须在结账前处理完毕。',
        [LAW_ACCOUNTING_LAW_9, LAW_ACCOUNTING_BASIS_50],
        {
          documentId: document.id,
          kind: document.kind,
          amount: document.amount,
          date: document.date,
          counterparty: document.counterparty,
          file: document.source.file,
          sheet: document.source.sheet ?? null,
          row: document.source.row ?? null,
        },
      ),
    );
  }

  return findings;
}

/** IC-SEGREGATION-001：同一人既编制又复核（或审批）。 */
function checkSegregation(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const record of latestTaxReturns(input.taxReturns ?? [])) {
    const rolesByActor = new Map<string, Set<SignRole>>();
    for (const signature of record.signatures) {
      const actor = signature.actor.trim();
      if (actor === '') continue;
      const set = rolesByActor.get(actor) ?? new Set<SignRole>();
      set.add(signature.role);
      rolesByActor.set(actor, set);
    }

    const conflicts = [...rolesByActor.entries()].filter(([, roles]) => roles.size > 1);
    if (conflicts.length === 0) continue;

    const detailList = conflicts
      .map(([actor, roles]) => `${actor} 同时担任 ${[...roles].map((role) => ROLE_LABEL[role]).join('、')}`)
      .join('；');

    findings.push(
      makeFinding(
        ctx,
        DATA_RULE_IDS.segregation,
        {
          kind: 'tax_return',
          id: record.id,
          label: `申报表 ${record.period} ${record.taxType}`,
        },
        '不相容职务未分离',
        `申报表 ${record.id}（${record.period}）的签署记录显示：${detailList}。` +
          '编制、复核、审批三岗合一，等于没有复核，内控失效；一旦申报出错，也无法界定责任。',
        '由不同人员分别完成编制、复核与审批，并在系统中留痕（签署人、时间、计算指纹）；' +
          '人员确实不足的小微企业，至少应做到「编制人 ≠ 复核人」，并由负责人对审批环节书面确认。',
        [LAW_INTERNAL_CONTROL_29, LAW_ACCOUNTING_LAW_27],
        {
          taxReturnId: record.id,
          period: record.period,
          conflicts: conflicts.map(([actor, roles]) => ({ actor, roles: [...roles] })),
          signatures: record.signatures.map((item) => ({ role: item.role, actor: item.actor, at: item.at })),
        },
      ),
    );
  }

  return findings;
}

/** IC-SIGNATURE-001：已复核/已审批/已申报的申报表缺少人工签署。 */
function checkHumanSignatures(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const record of latestTaxReturns(input.taxReturns ?? [])) {
    const required: SignRole[] = [];
    if (record.status === 'reviewed') required.push('reviewer');
    if (record.status === 'approved' || record.status === 'filed') required.push('reviewer', 'approver');
    if (required.length === 0) continue;

    const present = new Set<SignRole>();
    for (const signature of record.signatures) {
      if (signature.actor.trim() !== '' && signature.at.trim() !== '') present.add(signature.role);
    }
    const missing = required.filter((role) => !present.has(role));
    if (missing.length === 0) continue;

    findings.push(
      makeFinding(
        ctx,
        DATA_RULE_IDS.signature,
        {
          kind: 'tax_return',
          id: record.id,
          label: `申报表 ${record.period} ${record.taxType}`,
        },
        '申报流程缺少人工签署',
        `申报表 ${record.id}（${record.period}）当前状态为「${record.status}」，` +
          `按流程应具备 ${required.map((role) => ROLE_LABEL[role]).join('、')} 签署，` +
          `但缺少 ${missing.map((role) => ROLE_LABEL[role]).join('、')} 的有效签署记录。` +
          'AI 生成的税务计算必须经人工复核与审批后才能作为申报依据，只有状态没有签署等于流程被绕过。',
        '由具备权限的人员在系统中完成缺失环节的签署（签署时需确认计算摘要指纹，防止「签的不是算的那份」）；' +
          '若状态被错误推进，应退回上一环节重新走流程，并保留状态迁移事件。',
        [LAW_INTERNAL_CONTROL_29, LAW_ACCOUNTING_LAW_27, LAW_TAX_COLLECTION_25],
        {
          taxReturnId: record.id,
          period: record.period,
          status: record.status,
          required,
          missing,
          signatures: record.signatures.map((item) => ({ role: item.role, actor: item.actor, at: item.at })),
        },
      ),
    );
  }

  return findings;
}

/** IC-SOFTDELETE-001：物理删除痕迹（凭证断号/重号/删除告警）。 */
function checkSoftDelete(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  const groups = new Map<string, Array<{ voucher: Voucher; number: number }>>();
  for (const voucher of input.vouchers) {
    const match = /^(.*?)[-－]?(\d+)$/.exec(voucher.word);
    if (match === null) continue;
    const prefix = (match[1] ?? '').replace(/[-－]$/, '');
    const number = Number(match[2]);
    if (!Number.isFinite(number)) continue;
    const bucket = groups.get(prefix) ?? [];
    bucket.push({ voucher, number });
    groups.set(prefix, bucket);
  }

  for (const [prefix, items] of groups) {
    const sorted = [...items].sort((a, b) => a.number - b.number);
    const byNumber = new Map<number, Voucher>();
    const duplicates: number[] = [];
    for (const item of sorted) {
      if (byNumber.has(item.number)) {
        duplicates.push(item.number);
      } else {
        byNumber.set(item.number, item.voucher);
      }
    }

    const numbers = [...byNumber.keys()].sort((a, b) => a - b);
    const first = numbers[0];
    const last = numbers[numbers.length - 1];
    if (first === undefined || last === undefined) continue;

    const missing: number[] = [];
    for (let n = first; n <= last; n += 1) {
      if (!byNumber.has(n)) missing.push(n);
    }
    if (missing.length === 0 && duplicates.length === 0) continue;

    const parts: string[] = [];
    if (missing.length > 0) {
      const preview = missing.slice(0, 20).map((n) => String(n).padStart(4, '0')).join('、');
      parts.push(
        `缺少 ${missing.length} 个凭证号：${preview}${missing.length > 20 ? '……' : ''}`,
      );
    }
    if (duplicates.length > 0) {
      parts.push(`重复使用 ${duplicates.length} 个凭证号：${[...new Set(duplicates)].join('、')}`);
    }

    findings.push(
      makeFinding(
        ctx,
        DATA_RULE_IDS.softDelete,
        { kind: 'run', id: `voucher-sequence:${prefix}`, label: `凭证字号「${prefix}」连续性` },
        '凭证号不连续，疑似存在物理删除',
        `凭证字号「${prefix}」${parts.join('；')}。会计凭证应当连续编号；` +
          '断号或重号可能意味着凭证被物理删除、绕过系统作废，或编号规则被破坏。' +
          '物理删除会让审计无法还原业务全貌，也是会计法明令禁止的行为。',
        '核对断号区间的原始凭证与作废记录：作废凭证应保留在册并标注「作废」，不得删除；' +
          '重号凭证应查明来源并重新编号（保留变更痕迹）。系统层面应只允许软删除，并写入历史版本表。',
        [LAW_ACCOUNTING_BASIS_52, LAW_ARCHIVES_13, LAW_ACCOUNTING_LAW_44],
        {
          prefix,
          first,
          last,
          missing,
          duplicates: [...new Set(duplicates)],
          voucherIds: sorted.map((item) => item.voucher.id),
        },
      ),
    );
  }

  const traces: string[] = [];
  for (const voucher of input.vouchers) {
    for (const warning of voucher.warnings) {
      if (/物理删除|已删除|删除凭证|彻底删除/.test(warning)) {
        traces.push(`${voucher.word}：${warning}`);
      }
    }
  }

  if (traces.length > 0) {
    findings.push(
      makeFinding(
        ctx,
        DATA_RULE_IDS.softDelete,
        { kind: 'run', id: 'voucher-delete-traces', label: '凭证删除痕迹' },
        '发现物理删除痕迹',
        `凭证告警中出现 ${traces.length} 条与删除相关的记录：${traces.slice(0, 5).join('；')}` +
          `${traces.length > 5 ? '；……' : ''}。会计凭证与账簿不得物理删除，只能软删除并保留历史版本。`,
        '立即停止物理删除操作，改用软删除（deleted 标记 + 历史版本表 + 审计事件）；' +
          '从备份恢复被删除的数据，并评估对已出具报表与申报的影响。',
        [LAW_ACCOUNTING_LAW_44, LAW_ARCHIVES_13, LAW_ACCOUNTING_BASIS_52],
        { traces },
      ),
    );
  }

  return findings;
}

/* ================================================================== */
/* 四、注册                                                            */
/* ================================================================== */

export const dataChecks: readonly CheckDefinition[] = [
  {
    id: DATA_RULE_IDS.missing,
    title: '单据要素完整（日期/金额）',
    category: 'data_quality',
    severity: 'warning',
    blocking: false,
    configurable: true,
    basis: [LAW_ACCOUNTING_BASIS_48, LAW_ACCOUNTING_LAW_14],
    run: checkMissingFields,
  },
  {
    id: DATA_RULE_IDS.unmatched,
    title: '单据均已匹配记账规则',
    category: 'data_quality',
    severity: 'warning',
    blocking: false,
    configurable: true,
    basis: [LAW_ACCOUNTING_LAW_9, LAW_ACCOUNTING_BASIS_50],
    run: checkUnmatchedDocuments,
  },
  {
    id: DATA_RULE_IDS.segregation,
    title: '不相容职务分离（编制/复核/审批）',
    category: 'internal_control',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_INTERNAL_CONTROL_29, LAW_ACCOUNTING_LAW_27],
    run: checkSegregation,
  },
  {
    id: DATA_RULE_IDS.signature,
    title: '申报流程具备人工签署（HITL）',
    category: 'internal_control',
    severity: 'error',
    blocking: true,
    configurable: false,
    basis: [LAW_INTERNAL_CONTROL_29, LAW_ACCOUNTING_LAW_27],
    run: checkHumanSignatures,
  },
  {
    id: DATA_RULE_IDS.softDelete,
    title: '无物理删除痕迹（凭证连续编号）',
    category: 'internal_control',
    severity: 'error',
    blocking: true,
    configurable: false,
    basis: [LAW_ACCOUNTING_BASIS_52, LAW_ARCHIVES_13, LAW_ACCOUNTING_LAW_44],
    run: checkSoftDelete,
  },
];
