/**
 * 新增 CLI 子命令的实现（月结 / 完整性校验 / 申报流程）。
 *
 * 放在这里而不是塞进 cli.ts，是因为 cli.ts 已经承担了参数解析、终端着色、
 * 输入收集三件事；再往里堆业务编排，那个文件会变成谁也读不动的巨石。
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import { PROJECT_ROOT, ConfigError } from "../core/config.ts";
import type { AccountingStandardId, Period } from "../core/contracts.ts";
import { runClose } from "./close-run.ts";
import { renderMonthlyReport } from "./monthly-report.ts";
import { AuditStore } from "../audit/index.ts";

export const AUDIT_DIR = join(PROJECT_ROOT, "data", "audit");

/**
 * 默认制单人：当前操作系统登录用户。
 * 它只是「谁在这台机器上跑了月结」的初步记录，正式签署仍应由人在
 * `filing review/approve` 时显式给出姓名——那两步不接受默认值。
 */
export function defaultPreparer(): string {
  return process.env["USERNAME"] ?? process.env["USER"] ?? "本机用户";
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

export interface CloseCommandOptions {
  inputs: readonly string[];
  period: string;
  out: string;
  standard?: AccountingStandardId;
  quiet: boolean;
  /** 制单人；缺省取当前操作系统用户名 */
  preparer?: string;
}

/**
 * 月结：记账 → 期末结转 → 报表 → 税务 → 审核 → 留痕，并输出一份 Markdown 报告。
 *
 * 退出码约定：
 *   0  无阻断项
 *   2  有阻断项（账做出来了，但按合规要求不得结账）
 *   1  运行失败
 */
export async function cmdClose(options: CloseCommandOptions): Promise<number> {
  if (!/^\d{4}-\d{2}$/.test(options.period)) {
    console.error("✗ --period 必填，格式 YYYY-MM（月结必须明确会计期间）");
    return 1;
  }
  const period = options.period as Period;
  const log = options.quiet ? undefined : (msg: string): void => console.log("  " + msg);

  const output = await runClose({
    period,
    files: options.inputs,
    standard: options.standard,
    dataDir: AUDIT_DIR,
    onProgress: log,
    preparer: options.preparer ?? defaultPreparer(),
  });

  const markdown = renderMonthlyReport(output);
  const outPath =
    options.out !== ""
      ? resolve(options.out)
      : resolve(join(PROJECT_ROOT, "out", "月结报告-" + period + "-" + timestamp() + ".md"));
  const dir = dirname(outPath);
  if (dir !== "" && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, markdown, "utf8");

  // 同时导出一份 Excel：报表 + 指标 + 结论，方便直接发给老板或归档
  const excelPath = join(dir, "报表与财务分析-" + period + ".xlsx");
  let excelNote = "";
  try {
    const { exportStatementsExcel } = await import("../report/index.ts");
    await exportStatementsExcel(output.statements, output.analysis, excelPath);
    excelNote = excelPath;
  } catch (err) {
    excelNote = "（Excel 导出失败：" + (err as Error).message + "）";
  }

  const totalDebit = output.vouchers.reduce((s, v) => s + v.totalDebit, 0);
  console.log("");
  console.log("月结完成：" + period + "（" + output.standard + "）");
  console.log("  凭证 " + output.vouchers.length + " 张，借方合计 " + (totalDebit / 100).toFixed(2) + " 元");
  console.log(
    "  合规得分 " + output.review.summary.score + " / 100（error " + output.review.summary.error +
    "，warning " + output.review.summary.warning + "）",
  );
  console.log(
    "  申报草稿 " + output.taxReturns.length + " 张（状态均为「已计算」，未提交）",
  );
  console.log("  报告已写入：" + outPath);
  if (excelNote !== "") console.log("  报表与财务分析：" + excelNote);

  if (output.blockers.length > 0) {
    console.log("");
    console.log("✗ 存在 " + output.blockers.length + " 项阻断问题，本期不得结账：");
    output.blockers.slice(0, 10).forEach((b, i) => console.log("  " + (i + 1) + ". " + b));
    if (output.blockers.length > 10) {
      console.log("  … 其余 " + (output.blockers.length - 10) + " 项见报告");
    }
    return 2;
  }
  return 0;
}

/** 校验审计库完整性：重算哈希链，找出断链与孤儿记录。 */
export async function cmdVerify(dataDir = AUDIT_DIR): Promise<number> {
  if (!existsSync(dataDir)) {
    console.log("审计库目录不存在：" + dataDir + "（还没有做过月结留痕）");
    return 0;
  }
  const store = new AuditStore({ dataDir, actor: "cli:verify" });
  const report = store.verifyIntegrity();
  console.log("");
  console.log("审计库完整性校验：" + dataDir);
  console.log("  事件数：" + report.events);
  console.log("  版本记录数：" + report.versionRecords);
  if (report.ok) {
    console.log("  ✓ 哈希链完整，未发现篡改痕迹");
    return 0;
  }
  console.log("  ✗ 哈希链在第 " + String(report.brokenAt) + " 条事件处断裂");
  if (report.orphans.length > 0) {
    console.log("  孤儿记录：" + report.orphans.slice(0, 10).join(", "));
  }
  return 1;
}

/** 把可用会计准则列出来（供 --help 与 UI 提示）。 */
export function describeStandards(): string {
  return [
    "  cas    企业会计准则（上市公司/大中型企业）",
    "  small  小企业会计准则（财会〔2011〕17号，中小企业常用）",
  ].join("\n");
}

/** 解析 --standard 参数，非法时抛 ConfigError。 */
export function parseStandard(raw: string | undefined): AccountingStandardId | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = raw.toLowerCase();
  if (v !== "cas" && v !== "small") {
    throw new ConfigError("--standard 只能是 cas 或 small，实际为「" + raw + "」");
  }
  return v as AccountingStandardId;
}

/* ------------------------------------------------------------------ */
/* 申报流程（Human-in-the-loop 的人工侧）                              */
/* ------------------------------------------------------------------ */

export type FilingAction = "list" | "pending" | "review" | "approve" | "export" | "file" | "reject" | "void";

export interface FilingCommandOptions {
  action: FilingAction;
  id?: string;
  period?: string;
  actor: string;
  out?: string;
  receipt?: string;
  paidYuan?: string;
  reason?: string;
}

/**
 * 申报流程的 CLI。
 *
 * 这条命令是整个系统里**唯一**能推动申报状态的地方，而且每一步都要人给名字。
 * 没有任何子命令叫 submit：系统不提供向税务局提交的能力（连 import 都没有）。
 */
export async function cmdFiling(options: FilingCommandOptions): Promise<number> {
  const { FilingService, summarizeReturn } = await import("./filing-service.ts");
  const service = new FilingService({ dataDir: AUDIT_DIR });

  if (options.action === "list" || options.action === "pending") {
    const rows = service.list(options.period === undefined ? {} : { period: options.period });
    if (rows.length === 0) {
      console.log("没有申报记录。先运行一次月结：node src/cli.ts close --period YYYY-MM <文件>");
      return 0;
    }
    console.log("申报记录（" + rows.length + " 张）：");
    for (const r of rows) console.log("  " + r.id + "  " + summarizeReturn(r));
    const pending = service.pending(options.period);
    if (pending.length > 0) {
      console.log("");
      console.log("待办（" + pending.length + " 项）：");
      for (const p of pending) console.log("  [" + p.assigneeRole + "] " + p.id + " → " + p.action);
    }
    return 0;
  }

  const id = options.id;
  if (id === undefined || id === "") {
    console.error("✗ 需要指定申报表 id。可先用：node src/cli.ts filing list");
    return 1;
  }

  try {
    switch (options.action) {
      case "review": {
        const r = service.review(id, options.actor, options.reason);
        console.log("✓ 复核签署完成：" + summarizeReturn(r.return));
        console.log("  下一步：" + r.next.join("；"));
        return 0;
      }
      case "approve": {
        const r = service.approve(id, options.actor, options.reason);
        console.log("✓ 审批签署完成：" + summarizeReturn(r.return));
        console.log("  下一步：" + r.next.join("；"));
        console.log("  提示：系统不会提交，请导出底稿后由人工在电子税务局申报。");
        return 0;
      }
      case "export": {
        const out = options.out ?? join(PROJECT_ROOT, "out", "申报底稿-" + id + ".xlsx");
        const r = await service.exportPackage(id, options.actor, out);
        console.log("✓ 已导出申报底稿：" + out);
        console.log("  " + summarizeReturn(r.return));
        console.log("  ⚠ 这是给人照抄的底稿，不是报文；系统不会也无法提交到税务机关。");
        return 0;
      }
      case "file": {
        if (options.receipt === undefined || options.receipt === "") {
          console.error("✗ 回填申报事实必须提供电子税务局受理回执号：--receipt <回执号>");
          return 1;
        }
        const paid = Math.round(Number(options.paidYuan ?? "0") * 100);
        if (!Number.isFinite(paid)) {
          console.error("✗ --paid 必须是金额数字（元）");
          return 1;
        }
        const r = service.reportManual(id, {
          channel: "etax-manual",
          receiptNo: options.receipt,
          filedAt: new Date().toISOString(),
          actor: options.actor,
          paidAmount: paid,
        });
        console.log("✓ 已回填人工申报事实：" + summarizeReturn(r.return));
        return 0;
      }
      case "reject": {
        if (options.reason === undefined || options.reason === "") {
          console.error("✗ 退回必须说明理由：--reason <理由>");
          return 1;
        }
        const r = service.reject(id, options.actor, options.reason);
        console.log("✓ 已退回：" + summarizeReturn(r.return));
        return 0;
      }
      case "void": {
        if (options.reason === undefined || options.reason === "") {
          console.error("✗ 作废必须说明理由：--reason <理由>");
          return 1;
        }
        const r = service.void(id, options.actor, options.reason);
        console.log("✓ 已作废：" + summarizeReturn(r.return));
        return 0;
      }
      default:
        console.error("未知动作：" + String(options.action));
        return 1;
    }
  } catch (err) {
    console.error("✗ " + (err as Error).message);
    return 1;
  }
}
