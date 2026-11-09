/**
 * 申报服务：把内存态的 FilingWorkflow 接到持久化的审计库上。
 *
 * 为什么需要这一层：
 *  FilingWorkflow 是纯内存的（这样它才可被单测到毫秒级确定性），
 *  但真实使用里「制单人今天复核、审批人明天签」必然跨进程。
 *  于是这里负责：从审计库读出申报表 → 装配进工作流 → 执行动作 → 写回新版本。
 *
 * 一条不可动摇的底线：
 *  本文件不提供任何「提交」方法。system 侧能做到的极限是 approved + 导出底稿，
 *  filed 状态只能由 reportManual() 依据人在电子税务局拿到的回执号写入。
 */

import { resolve } from "node:path";

import type { IsoDateTime, ManualFilingRecord, Period, SignRole, Signature, TaxReturn } from "../core/contracts.ts";
import { FILING_STATUS_LABEL, TAX_TYPE_LABEL } from "../core/contracts.ts";
import { AuditStore } from "../audit/index.ts";
import {
  FilingWorkflow,
  exportFilingPackage,
  TRANSITIONS,
  type FilingPendingAction,
} from "../filing/index.ts";

export interface FilingServiceOptions {
  dataDir: string;
  configDir?: string;
  /** 注入时钟，便于测试 */
  now?: () => IsoDateTime;
}

function nowIso(): IsoDateTime {
  return new Date().toISOString();
}

/** 一条申报动作的结果，供 CLI / Web 直接展示。 */
export interface FilingActionResult {
  return: TaxReturn;
  /** 动作之后还能做什么 */
  next: string[];
}

export class FilingService {
  private readonly store: AuditStore;
  private readonly options: FilingServiceOptions;

  constructor(options: FilingServiceOptions) {
    this.options = options;
    this.store = new AuditStore({
      dataDir: options.dataDir,
      actor: "system:filings",
      ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
    });
  }

  /** 从审计库取出一张申报表的最新版本。 */
  get(id: string): TaxReturn | null {
    return this.store.current<TaxReturn>("tax_return", id);
  }

  /** 列出申报表（默认只列未作废的）。 */
  list(filter: { period?: Period; status?: TaxReturn["status"] } = {}): TaxReturn[] {
    const ids = this.store.list("tax_return");
    const out: TaxReturn[] = [];
    for (const id of ids) {
      const ret = this.store.current<TaxReturn>("tax_return", id);
      if (ret === null) continue;
      if (ret.status === "void") continue;
      if (filter.period !== undefined && ret.period !== filter.period) continue;
      if (filter.status !== undefined && ret.status !== filter.status) continue;
      out.push(ret);
    }
    out.sort((a, b) => (a.period === b.period ? a.taxType.localeCompare(b.taxType) : b.period.localeCompare(a.period)));
    return out;
  }

  /** 待人工处理的清单：每个申报表下一步该谁做什么。 */
  pending(period?: Period): FilingPendingAction[] {
    const out: FilingPendingAction[] = [];
    for (const ret of this.list(period === undefined ? {} : { period })) {
      const next = nextSteps(ret);
      if (next.length === 0) continue;
      out.push({
        id: ret.id,
        taxType: ret.taxType,
        period: ret.period,
        status: ret.status,
        action: next[0] ?? "",
        assigneeRole: ret.status === "calculated" ? "reviewer" : ret.status === "reviewed" ? "approver" : "preparer",
      });
    }
    return out;
  }

  /** 把一张申报表装配进工作流（只装这一张，动作结束后再写回）。 */
  private withWorkflow<T>(ret: TaxReturn, fn: (wf: FilingWorkflow) => T): { result: T; updated: TaxReturn } {
    const wf = new FilingWorkflow({
      ...(this.options.configDir === undefined ? {} : { configDir: this.options.configDir }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      guards: {
        isReviewPassed: (r) => r.reviewId !== null && r.blockingIssues === 0,
        blockingCount: (r) => r.blockingIssues,
      },
    });
    // 直接「接着办」：把审计库里的历史状态原样装回工作流，
    // 之后的每一步迁移仍要过状态机与闸门，这里不放宽任何规则。
    wf.adopt(ret);
    const result = fn(wf);
    return { result, updated: wf.get(ret.id) };
  }

  private persist(ret: TaxReturn, actor: string, summary: string): TaxReturn {
    this.store.save("tax_return", ret.id, ret, { actor, summary });
    return ret;
  }

  /** 复核签署（复核人）。 */
  review(id: string, actor: string, note?: string): FilingActionResult {
    const ret = this.require(id);
    const sig: Omit<Signature, "payloadHash"> = {
      role: "reviewer",
      actor,
      at: (this.options.now ?? nowIso)(),
      method: "manual",
      ...(note === undefined ? {} : { note }),
    };
    const { updated } = this.withWorkflow(ret, (wf) => wf.review(id, sig));
    return { return: this.persist(updated, actor, "复核签署"), next: nextSteps(updated) };
  }

  /** 审批签署（审批人，必须与复核人不同）。 */
  approve(id: string, actor: string, note?: string): FilingActionResult {
    const ret = this.require(id);
    const sig: Omit<Signature, "payloadHash"> = {
      role: "approver",
      actor,
      at: (this.options.now ?? nowIso)(),
      method: "manual",
      ...(note === undefined ? {} : { note }),
    };
    const { updated } = this.withWorkflow(ret, (wf) => wf.approve(id, sig));
    return { return: this.persist(updated, actor, "审批签署"), next: nextSteps(updated) };
  }

  /** 退回重做。 */
  reject(id: string, actor: string, reason: string): FilingActionResult {
    const ret = this.require(id);
    const { updated } = this.withWorkflow(ret, (wf) => wf.reject(id, actor, reason));
    return { return: this.persist(updated, actor, "退回：" + reason), next: nextSteps(updated) };
  }

  /**
   * 导出申报底稿。**这是系统能力的极限**——产出的是给人照抄的 Excel，
   * 不是报文，也没有任何发送动作。
   */
  async exportPackage(id: string, actor: string, outPath: string): Promise<FilingActionResult> {
    const ret = this.require(id);
    const { updated } = this.withWorkflow(ret, (wf) => wf.exportForFiling(id, actor));
    const persisted = this.persist(updated, actor, "导出申报底稿");
    await exportFilingPackage(persisted, resolve(outPath));
    return { return: persisted, next: nextSteps(persisted) };
  }

  /** 回填人工在电子税务局完成申报的事实。 */
  reportManual(id: string, record: ManualFilingRecord): FilingActionResult {
    const ret = this.require(id);
    const { updated } = this.withWorkflow(ret, (wf) => wf.reportManualFiling(id, record));
    return { return: this.persist(updated, record.actor, "回填申报回执 " + record.receiptNo), next: nextSteps(updated) };
  }

  /** 作废。 */
  void(id: string, actor: string, reason: string): FilingActionResult {
    const ret = this.require(id);
    const { updated } = this.withWorkflow(ret, (wf) => wf.void(id, actor, reason));
    return { return: this.persist(updated, actor, "作废：" + reason), next: [] };
  }

  /** 该状态允许的下一步状态（供 UI 画按钮，供 CLI 校验）。 */
  allowedTransitions(id: string): readonly string[] {
    const ret = this.require(id);
    return TRANSITIONS[ret.status];
  }

  private require(id: string): TaxReturn {
    const ret = this.get(id);
    if (ret === null) throw new Error("申报表不存在或已作废：" + id);
    return ret;
  }
}

/** 人话的下一步提示。 */
export function nextSteps(ret: TaxReturn): string[] {
  switch (ret.status) {
    case "draft":
      return ["完成计算（calculate）"];
    case "calculated":
      return ["等待复核人签署（review）"];
    case "reviewed":
      return ["等待审批人签署（approve）——审批人必须与复核人不同"];
    case "approved":
      return ["导出申报底稿", "由人工在电子税务局申报后回填回执（reportManual）"];
    case "filed":
      return [];
    case "rejected":
      return ["修改后重新计算（revise）"];
    case "void":
      return [];
    default:
      return [];
  }
}

/** 角色的人话名。 */
export const SIGN_ROLE_TEXT: Record<SignRole, string> = {
  preparer: "制单人",
  reviewer: "复核人",
  approver: "审批人",
};

/** 一行式摘要，CLI 列表用。 */
export function summarizeReturn(ret: TaxReturn): string {
  return [
    ret.period,
    TAX_TYPE_LABEL[ret.taxType],
    FILING_STATUS_LABEL[ret.status],
    "应纳 " + (ret.payable / 100).toFixed(2),
    "应补(退) " + (ret.due / 100).toFixed(2),
    "v" + String(ret.version),
  ].join(" | ");
}
