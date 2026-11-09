/**
 * Web 层的数据传输对象（DTO）。
 *
 * 为什么不让前端直接吃 CloseRunOutput：
 *  1. 里面有 Symbol / 循环引用风险，JSON.stringify 会炸；
 *  2. 凭证明细动辄上千行，一次性塞给浏览器会卡死；
 *  3. 前端需要的是「已格式化的金额字符串」而不是分为单位的整数，
 *     在服务端格式化一次，避免每个页面各写一套除以 100 的逻辑。
 */

import type { CloseRunOutput } from "../app/close-run.ts";
import {
  ACCOUNTING_STANDARD_LABEL,
  FILING_STATUS_LABEL,
  REVIEW_CATEGORY_LABEL,
  STATEMENT_KIND_LABEL,
  TAX_TYPE_LABEL,
  type ReviewCategory,
  type Severity,
} from "../core/contracts.ts";

/** 金额格式化：分 → 带千分位的两位小数元。 */
export function fmtYuan(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const s = (abs / 100).toFixed(2);
  const parts = s.split(".");
  const intPart = (parts[0] ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + intPart + "." + (parts[1] ?? "00");
}

export interface FindingDto {
  id: string;
  ruleId: string;
  severity: Severity;
  category: ReviewCategory;
  categoryLabel: string;
  title: string;
  detail: string;
  suggestion: string;
  blocking: boolean;
  waived: boolean;
  targetKind: string;
  targetLabel: string;
  /** 法规依据，已拼成「法规名 第X条」 */
  basis: string[];
}

export interface VoucherRowDto {
  word: string; date: string; summary: string;
  accountCode: string; accountName: string;
  debit: string; credit: string;
  auxiliary: string;
}

export interface CloseRunDto {
  runId: string;
  period: string;
  standard: string;
  standardLabel: string;
  startedAt: string;
  finishedAt: string;
  stats: {
    vouchers: number;
    unbalanced: number;
    documents: number;
    issues: number;
    totalDebit: string;
    score: number;
    blockers: number;
    errors: number;
    warnings: number;
  };
  findings: FindingDto[];
  vouchers: VoucherRowDto[];
  statements: Array<{
    kind: string; kindLabel: string; passed: boolean;
    lines: Array<{ code: string; label: string; level: number; amount: string | null; isTotal: boolean }>;
    checks: Array<{ label: string; passed: boolean; detail: string }>;
  }>;
  analysis: {
    ratios: Array<{ code: string; name: string; group: string; value: string; unit: string; formula: string; rating: string; comment: string }>;
    dupont: { roe: string; netProfitMargin: string; assetTurnover: string; equityMultiplier: string };
    alerts: Array<{ level: string; title: string; detail: string; action: string }>;
    narratives: Array<{ title: string; body: string }>;
    dataNotes: string[];
  };
  taxReturns: Array<{
    id: string; taxType: string; taxTypeLabel: string; period: string;
    status: string; statusLabel: string; payable: string; due: string;
    blockingIssues: number;
    lines: Array<{ code: string; label: string; amount: string; note: string | null }>;
  }>;
  issues: Array<{ level: string; message: string; file: string; row: number | null }>;
  blockers: string[];
  degradations: string[];
  markdown: { monthly: string; review: string; analysis: string };
}

function ratioText(v: number | null, unit: string): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (unit === "%") return (v * 100).toFixed(2) + "%";
  if (unit === "倍" || unit === "次") return v.toFixed(2);
  return v.toFixed(4);
}

/** 把月结结果转成前端 DTO。voucherLimit 控制返回的凭证行数，避免一次拉爆浏览器。 */
export function toCloseRunDto(out: CloseRunOutput, monthlyMarkdown: string, voucherLimit = 400): CloseRunDto {
  const findings: FindingDto[] = out.review.findings.map((f) => ({
    id: f.id,
    ruleId: f.ruleId,
    severity: f.severity,
    category: f.category,
    categoryLabel: REVIEW_CATEGORY_LABEL[f.category],
    title: f.title,
    detail: f.detail,
    suggestion: f.suggestion,
    blocking: f.blocking,
    waived: f.waived !== undefined,
    targetKind: f.target.kind,
    targetLabel: f.target.label ?? f.target.id,
    basis: f.basis.map((b) => b.title + (b.article === undefined ? "" : " " + b.article)),
  }));

  const vouchers: VoucherRowDto[] = [];
  for (const v of out.vouchers) {
    for (const line of v.lines) {
      if (vouchers.length >= voucherLimit) break;
      vouchers.push({
        word: v.word, date: v.date, summary: line.summary,
        accountCode: line.accountCode, accountName: line.accountName,
        debit: line.debit === 0 ? "" : fmtYuan(line.debit),
        credit: line.credit === 0 ? "" : fmtYuan(line.credit),
        auxiliary: [
          line.auxiliary?.department, line.auxiliary?.customer,
          line.auxiliary?.supplier, line.auxiliary?.employee,
        ].filter((x): x is string => x !== undefined && x !== "").join(" / "),
      });
    }
    if (vouchers.length >= voucherLimit) break;
  }

  const unbalanced = out.vouchers.filter((v) => !v.balanced).length;
  const totalDebit = out.vouchers.reduce((s, v) => s + v.totalDebit, 0);

  return {
    runId: out.runId,
    period: out.period,
    standard: out.standard,
    standardLabel: ACCOUNTING_STANDARD_LABEL[out.standard],
    startedAt: out.startedAt,
    finishedAt: out.finishedAt,
    stats: {
      vouchers: out.vouchers.length,
      unbalanced,
      documents: out.documents.length,
      issues: out.issues.length,
      totalDebit: fmtYuan(totalDebit),
      score: out.review.summary.score,
      blockers: out.blockers.length,
      errors: out.review.summary.error,
      warnings: out.review.summary.warning,
    },
    findings,
    vouchers,
    statements: out.statements.map((st) => ({
      kind: st.kind,
      kindLabel: STATEMENT_KIND_LABEL[st.kind],
      passed: st.passed,
      lines: st.lines.map((l) => ({
        code: l.code, label: l.label, level: l.level,
        amount: l.amount === null ? null : fmtYuan(l.amount),
        isTotal: l.isTotal === true,
      })),
      checks: st.checks.map((c) => ({ label: c.label, passed: c.passed, detail: c.detail })),
    })),
    analysis: {
      ratios: out.analysis.ratios.map((r) => ({
        code: r.code, name: r.name, group: r.group,
        value: ratioText(r.value, r.unit), unit: r.unit,
        formula: r.formula, rating: r.rating, comment: r.comment,
      })),
      dupont: {
        roe: ratioText(out.analysis.dupont.roe, "%"),
        netProfitMargin: ratioText(out.analysis.dupont.netProfitMargin, "%"),
        assetTurnover: ratioText(out.analysis.dupont.assetTurnover, "次"),
        equityMultiplier: ratioText(out.analysis.dupont.equityMultiplier, "倍"),
      },
      alerts: out.analysis.alerts.map((a) => ({ level: a.level, title: a.title, detail: a.detail, action: a.action })),
      narratives: out.analysis.narratives.map((n) => ({ title: n.title, body: n.body })),
      dataNotes: out.analysis.dataNotes,
    },
    taxReturns: out.taxReturns.map((t) => ({
      id: t.id, taxType: t.taxType, taxTypeLabel: TAX_TYPE_LABEL[t.taxType],
      period: t.period, status: t.status, statusLabel: FILING_STATUS_LABEL[t.status],
      payable: fmtYuan(t.payable), due: fmtYuan(t.due),
      blockingIssues: t.blockingIssues,
      lines: t.lines.map((l) => ({ code: l.code, label: l.label, amount: fmtYuan(l.amount), note: l.note ?? null })),
    })),
    issues: out.issues.slice(0, 300).map((i) => ({
      level: i.level, message: i.message,
      file: i.source.file, row: i.source.row ?? null,
    })),
    blockers: out.blockers,
    degradations: out.degradations,
    markdown: { monthly: monthlyMarkdown, review: out.reviewMarkdown, analysis: out.analysisMarkdown },
  };
}
