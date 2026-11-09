/**
 * 月结编排：一次跑完「记账 → 账簿快照 → 报表 → 税务 → 审核 → 留痕」。
 *
 * 设计原则：
 *  1. **任何一环失败都不吞掉其它环的成果**。报表算出来了、税务挂了，
 *     仍然要把报表和阻断原因一起交回去，让人知道进展到哪一步。
 *  2. **顺序不可调换**。审核必须在报表与税务之后，因为它要检查报表勾稽
 *     与申报草稿；先跑审核等于没审核。
 *  3. **不产生任何「已申报」状态**。这里最多造出 status=calculated 的申报草稿，
 *     剩下的必须由人走 src/filing 的状态机。
 */

import { randomUUID } from "node:crypto";

import type {
  AccountingStandardId,
  CloseRunResult,
  DocumentRecord,
  FinancialAnalysis,
  FinancialStatement,
  IsoDateTime,
  LedgerSnapshot,
  Period,
  ProcessingIssue,
  ReviewReport,
  TaxReturn,
  Voucher,
} from "../core/contracts.ts";
import { ENGINE_VERSION } from "../core/contracts.ts";
import { loadConfig, resolveAccountCode, type AppConfig } from "../core/config.ts";
import { run } from "../pipeline.ts";
import { loadStandardRegistry } from "../core/standard/index.ts";
import { hashFilingPayload } from "../filing/index.ts";
import { AuditStore } from "../audit/index.ts";
import { generateStatements, generateAnalysis, renderAnalysisMarkdown } from "../report/index.ts";
import { computeTaxes } from "../tax/index.ts";
import { runReview, renderReviewMarkdown } from "../review/index.ts";
import { buildLedgerSnapshot, applyVirtualClosing } from "./ledger.ts";
import { loadCompanyProfile, type CompanyProfile } from "./company.ts";
import { loadAssetLedger } from "../ledger/assets.ts";
import {
  depreciationForPeriod,
  buildDepreciationVoucher,
  amortizationForPeriod,
  buildAmortizationVoucher,
  buildProfitCarryForward,
} from "../ledger/closing.ts";

export interface CloseRunInput {
  /** 会计期间 YYYY-MM */
  period: Period;
  /** 原始单据文件；与 vouchers 二选一 */
  files?: readonly string[];
  /** 已生成的凭证（Web 端复用、或测试直接注入） */
  vouchers?: readonly Voucher[];
  documents?: readonly DocumentRecord[];
  issues?: readonly ProcessingIssue[];
  /** 会计准则；缺省取 settings.yaml 的 accountingStandard */
  standard?: AccountingStandardId;
  company?: CompanyProfile;
  /** 审计库目录；提供时才落盘留痕 */
  dataDir?: string;
  configDir?: string;
  /** 上期快照，用于报表对比列 */
  priorLedger?: LedgerSnapshot;
  /** 多期历史，用于趋势分析 */
  history?: Parameters<typeof generateAnalysis>[0]["history"];
  /**
   * 是否自动做期末结转（折旧、摊销、损益结转）。默认 true。
   * 关掉它只适用于「我已在别处结转过」的场景，否则报表会缺损益。
   */
  includePeriodEnd?: boolean;
  onProgress?: (message: string) => void;
  /**
   * 制单人（真实姓名或工号）。
   *
   * 为什么必须由人给：申报表上的「制单人」是法律责任主体。
   * 让系统自称制单人，等于 AI 给自己签字，整条 Human-in-the-loop 就断了。
   */
  preparer?: string;
}

export interface CloseRunOutput extends CloseRunResult {
  config: AppConfig;
  snapshot: LedgerSnapshot;
  reviewMarkdown: string;
  analysisMarkdown: string;
  /** 本次运行中降级/失败的环节说明，便于排查 */
  degradations: string[];
}

/**
 * 月结阶段对两条检查项的严重度下调。
 *
 * 为什么不是「放宽合规」而是「换了个阶段」：
 *  TAX-DRAFT-001（申报草稿未复核）与 IC-SIGNATURE-001（申报表缺签署）
 *  检查的是**申报环节**的状态。月结这一步刚刚生成草稿，它们必然是未签署的，
 *  于是每次月结都必然被自己产出的东西阻断——这在逻辑上是循环的。
 *  真正的闸门在 src/filing：状态机不允许 calculated 直接跳到 filed，
 *  导出底稿强制要求 reviewer + approver 签署。那里才是该拦的地方。
 *
 * 下调为 info 不代表放过：它们仍会出现在报告里，仍会出现在待办清单里。
 */
const CLOSE_PHASE_OVERRIDES: Record<string, "error" | "warning" | "info"> = {
  "TAX-DRAFT-001": "info",
  "IC-SIGNATURE-001": "info",
};

function nowIso(): IsoDateTime {
  return new Date().toISOString();
}

/**
 * 执行一次完整月结。
 *
 * 返回的 blockers 是**阻断结账**的问题（审核 error + 税务未定），
 * 调用方（CLI / Web）必须把它们显式展示给用户，不能当作 warning 轻描淡写。
 */
export async function runClose(input: CloseRunInput): Promise<CloseRunOutput> {
  const log = input.onProgress ?? ((): void => {});
  const startedAt = nowIso();
  const runId = randomUUID();
  let config: AppConfig = loadConfig(input.configDir);
  const standard: AccountingStandardId = input.standard ?? config.settings.accountingStandard;
  // 显式指定准则时（CLI --standard / Web 切换），配置必须按该准则重新加载：
  // 否则科目表、规则编码、报表格式都还是默认准则那套，
  // 会出现「用企业准则记账、拿小企业准则审核」的全量报错。
  if (config.settings.accountingStandard !== standard) {
    config = loadConfig(input.configDir, standard);
  }
  const company = input.company ?? loadCompanyProfile(input.configDir);
  const degradations: string[] = [];

  // 准则存在性先校验：准则写错时后面全部白算，必须第一时间失败
  const registry = loadStandardRegistry(input.configDir);
  const profile = registry.get(standard);
  log("会计准则：" + profile.label);

  /* ---------------- 1. 记账 ---------------- */
  let vouchers: Voucher[] = input.vouchers === undefined ? [] : [...input.vouchers];
  let documents: DocumentRecord[] = input.documents === undefined ? [] : [...input.documents];
  const issues: ProcessingIssue[] = input.issues === undefined ? [] : [...input.issues];

  if (input.files !== undefined && input.files.length > 0) {
    log("读取 " + input.files.length + " 个单据文件…");
    try {
      const result = await run(input.files, { period: input.period, config, onProgress: log });
      vouchers = result.vouchers;
      documents = result.documents;
      issues.push(...result.issues);
    } catch (err) {
      const msg = "记账环节失败：" + (err as Error).message;
      degradations.push(msg);
      issues.push({ level: "error", message: msg, source: { file: input.files.join(",") } });
    }
  }
  /**
   * 系统生成的凭证同样要过科目下钻。
   * 折旧/摊销用的是台账里写的人话科目（1801、6602.09），
   * 可能有下级明细；不解析就会挂到上级科目上，明细账与总账对不上。
   */
  const resolveSystemVoucher = (v: Voucher | null): Voucher | null => {
    if (v === null) return null;
    const lines = v.lines.map((line) => {
      // 系统凭证里的科目是写死在代码/台账里的企业准则编码，
      // 切到小企业准则时必须先按映射表改写（6602.09 → 5602），再下钻
      const resolved = resolveAccountCode(config, line.accountCode);
      if (resolved.reason !== undefined) {
        issues.push({ level: "warning", message: resolved.reason, source: line.source });
      }
      return {
        ...line,
        accountCode: resolved.code,
        accountName: config.accounts.fullName(resolved.code),
      };
    });
    return { ...v, lines };
  };

  /* ---------------- 1.5 期末计提（折旧、摊销） ---------------- */
  // 必须排在快照之前：折旧是本期真实发生额，晚算一步报表就是错的
  const includePeriodEnd = input.includePeriodEnd !== false;
  if (includePeriodEnd) {
    try {
      const ledgerAssets = loadAssetLedger(input.configDir);
      for (const w of ledgerAssets.warnings) issues.push({ level: "warning", message: "固定资产台账：" + w, source: { file: "config/fixed-assets.yaml" } });

      const dep = depreciationForPeriod(ledgerAssets.assets, input.period);
      const depVoucher = resolveSystemVoucher(buildDepreciationVoucher(dep, input.period, config.settings.voucherWord));
      if (depVoucher !== null) {
        vouchers.push(depVoucher);
        log("计提折旧 " + dep.length + " 项，合计 " + (depVoucher.totalDebit / 100).toFixed(2) + " 元");
      }

      const am = amortizationForPeriod(ledgerAssets.amortization, input.period);
      const amVoucher = resolveSystemVoucher(buildAmortizationVoucher(am, input.period));
      if (amVoucher !== null) {
        vouchers.push(amVoucher);
        log("摊销 " + am.length + " 项，合计 " + (amVoucher.totalDebit / 100).toFixed(2) + " 元");
      }
    } catch (err) {
      const msg = "期末计提失败：" + (err as Error).message;
      degradations.push(msg);
      issues.push({ level: "error", message: msg, source: { file: "config/fixed-assets.yaml" } });
    }
  }

  log("凭证 " + vouchers.length + " 张，单据 " + documents.length + " 条");

  /* ---------------- 2. 账簿快照 ---------------- */
  const snapshot = buildLedgerSnapshot({
    period: input.period,
    standard,
    vouchers,
    accountName: (code) => config.accounts.fullName(code),
    opening: input.priorLedger === undefined ? undefined : closingMapOf(input.priorLedger),
  });
  /* ---------------- 2.5 结转损益 ---------------- */
  // 真做了结转凭证就用真凭证；否则报表靠虚拟结转，结果一致但不可审计
  let carriedForward = false;
  if (includePeriodEnd) {
    try {
      // 损益类按科目表的 category 判定，不靠编码前缀——小企业准则是 5 开头，
      // 而 5 开头在企业准则里是成本类，混淆会结错账。
      const isProfit = (code: string): boolean => config.accounts.get(code)?.category === "profit";
      const carry = buildProfitCarryForward(snapshot.balances, input.period, "4103", isProfit);
      const carryVoucher = resolveSystemVoucher(carry.voucher);
      if (carryVoucher !== null) {
        vouchers.push(carryVoucher);
        carriedForward = true;
        log("结转损益，本期" + (carry.profit >= 0 ? "利润 " : "亏损 ") + (Math.abs(carry.profit) / 100).toFixed(2) + " 元");
      }
    } catch (err) {
      const msg = "结转损益失败：" + (err as Error).message;
      degradations.push(msg);
      issues.push({ level: "error", message: msg, source: { file: "(结转)" } });
    }
  }

  // 结转后要重算快照：报表必须建立在「已结转」的账上
  const finalSnapshot = carriedForward
    ? buildLedgerSnapshot({
        period: input.period,
        standard,
        vouchers,
        accountName: (code) => config.accounts.fullName(code),
        opening: input.priorLedger === undefined ? undefined : closingMapOf(input.priorLedger),
      })
    : snapshot;

  // 报表要看到本期损益，否则资产 ≠ 负债 + 权益
  const reportLedger = carriedForward
    ? finalSnapshot
    : applyVirtualClosing(finalSnapshot, "4103", (code) => config.accounts.get(code)?.category === "profit");

  /* ---------------- 3. 报表 ---------------- */
  let statements: FinancialStatement[] = [];
  let analysis: FinancialAnalysis = emptyAnalysis(input.period, standard);
  try {
    const reportInput = {
      standard,
      period: input.period,
      ledger: reportLedger,
      priorLedger: input.priorLedger,
      history: input.history,
      configDir: input.configDir,
    };
    const generated = generateStatements(reportInput);
    statements = generated.statements;
    issues.push(...generated.issues);
    analysis = generateAnalysis({ ...reportInput, statements });
    log("报表 " + statements.length + " 张，指标 " + analysis.ratios.length + " 个");
  } catch (err) {
    const msg = "报表环节失败：" + (err as Error).message;
    degradations.push(msg);
    issues.push({ level: "error", message: msg, source: { file: "(报表)" } });
  }

  /* ---------------- 4. 税务 ---------------- */
  let taxReturns: TaxReturn[] = [];
  try {
    const taxResult = computeTaxes({
      period: input.period,
      standard,
      taxpayer: {
        id: company.taxId,
        name: company.name,
        kind: company.kind,
        cityTaxRate: company.cityTaxRate,
        industry: company.industry,
        employees: company.employees,
        totalAssets: company.totalAssets,
        isHighTech: company.isHighTech,
        isSmallLowProfit: company.isSmallLowProfit,
        rdExpense: company.rdExpense,
        region: company.region,
      },
      ledger: snapshot,
      vouchers,
      configDir: input.configDir,
    });
    taxReturns = taxResult.returns;
    log("税务 " + taxReturns.length + " 张草稿，风险 " + taxResult.risks.length + " 条");
  } catch (err) {
    const msg = "税务环节失败：" + (err as Error).message;
    degradations.push(msg);
    issues.push({ level: "error", message: msg, source: { file: "(税务)" } });
  }

  /* ---------------- 5. 审核（必须在报表与税务之后） ---------------- */
  let review: ReviewReport;
  try {
    review = runReview(
      { period: input.period, standard, vouchers, documents, taxReturns, statements, ledger: snapshot, issues },
      { configDir: input.configDir, severityOverrides: CLOSE_PHASE_OVERRIDES },
    );
    log("审核：error " + review.summary.error + " / warning " + review.summary.warning + "，得分 " + review.summary.score);
  } catch (err) {
    const msg = "审核环节失败：" + (err as Error).message;
    degradations.push(msg);
    review = {
      id: "REVIEW-FAILED",
      period: input.period,
      standard,
      checkedAt: nowIso(),
      engineVersion: ENGINE_VERSION,
      findings: [],
      summary: { total: 0, error: 1, warning: 0, info: 0, blocking: 1, waived: 0, score: 0, passed: false, byCategory: {} },
      checksRun: [],
    };
  }

  /**
   * 把审核结论回写到申报表。
   * 不做这一步，申报流程的 review 闸门会因为 reviewId 为空而永远拒绝放行——
   * 而那正是它该拒绝的信号：没经过审核的报表不能签。
   */
  for (const ret of taxReturns) {
    ret.reviewId = review.id;
    ret.blockingIssues = review.findings.filter(
      (f) => f.blocking && f.waived === undefined && f.target.kind === "tax_return" && f.target.id === ret.id,
    ).length;
  }

  // 统一计算指纹口径：申报模块的签名校验用的是它自己的 hashFilingPayload，
  // 税务引擎算的那份是「计算过程指纹」，两者字段集不同。
  // 落库前统一成申报口径，否则复核时会报「内容被改动但没有重新计算」。
  const preparer = input.preparer?.trim();
  for (const ret of taxReturns) {
    ret.payloadHash = hashFilingPayload(ret);
    // 制单人签署：记录「这份表是谁在什么时候算出来的」
    if (preparer !== undefined && preparer !== "" && !ret.signatures.some((s) => s.role === "preparer")) {
      ret.signatures.push({
        role: "preparer",
        actor: preparer,
        at: nowIso(),
        method: "manual",
        payloadHash: ret.payloadHash,
        note: "月结生成申报草稿",
      });
    }
  }

  /* ---------------- 6. 留痕 ---------------- */
  if (input.dataDir !== undefined) {
    try {
      const store = new AuditStore({ dataDir: input.dataDir, actor: "system:close-run", configDir: input.configDir });
      for (const v of vouchers) {
        store.save("voucher", v.id, v, { actor: "system:close-run", summary: "月结生成凭证 " + v.word });
      }
      for (const t of taxReturns) {
        store.save("tax_return", t.id, t, { actor: "system:close-run", summary: "生成申报草稿 " + t.id });
      }
      log("已写入审计库 " + input.dataDir);
    } catch (err) {
      const msg = "审计留痕失败：" + (err as Error).message;
      degradations.push(msg);
    }
  }

  /* ---------------- 7. 汇总阻断项 ---------------- */
  const blockers: string[] = [];
  for (const f of review.findings) {
    if (f.blocking && f.waived === undefined) blockers.push("[" + f.ruleId + "] " + f.title);
  }
  if (degradations.length > 0) blockers.push("运行降级：" + degradations.join("；"));

  return {
    runId,
    period: input.period,
    standard,
    startedAt,
    finishedAt: nowIso(),
    vouchers,
    documents,
    issues,
    review,
    statements,
    analysis,
    taxReturns,
    requiresHumanReview: true, // 永远需要人工复核——这是设计约束，不是开关
    blockers,
    config,
    snapshot,
    reviewMarkdown: renderReviewMarkdown(review),
    analysisMarkdown: renderAnalysisMarkdown(analysis),
    degradations,
  };
}

function closingMapOf(prior: LedgerSnapshot): Record<string, number> {
  const map: Record<string, number> = {};
  for (const b of prior.balances) {
    if (b.closing !== 0) map[b.accountCode] = b.closing;
  }
  return map;
}

function emptyAnalysis(period: Period, standard: AccountingStandardId): FinancialAnalysis {
  return {
    id: "ANALYSIS-EMPTY",
    period,
    standard,
    generatedAt: nowIso(),
    ratios: [],
    dupont: { roe: null, netProfitMargin: null, assetTurnover: null, equityMultiplier: null },
    trends: {},
    structure: { revenueByCategory: [], costByCategory: [], expenseByCategory: [] },
    narratives: [],
    alerts: [],
    dataNotes: ["报表环节未成功执行，本分析为空"],
  };
}
