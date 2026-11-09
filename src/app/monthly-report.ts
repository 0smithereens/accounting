/**
 * 月结报告渲染：把一次月结的全部产出汇成一份可直接给人看的文档。
 *
 * 为什么不用 Excel 做这件事：
 *  审核结论、税务口径、法规依据都是长文本，塞进单元格既难读也难归档。
 *  Markdown 可以被 Git 版本化、可以直接贴进邮件、可以转 PDF，
 *  而 Excel 留给「凭证」和「申报底稿」这两种需要被导入的场景。
 */

import type { CloseRunOutput } from "./close-run.ts";
import { ACCOUNTING_STANDARD_LABEL, STATEMENT_KIND_LABEL, TAX_TYPE_LABEL, FILING_STATUS_LABEL } from "../core/contracts.ts";

function yuan(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const s = (abs / 100).toFixed(2);
  const parts = s.split(".");
  const intPart = (parts[0] ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + intPart + "." + (parts[1] ?? "00");
}

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return (v * 100).toFixed(2) + "%";
}

/** 渲染完整月结报告（Markdown）。 */
export function renderMonthlyReport(out: CloseRunOutput): string {
  const lines: string[] = [];
  const push = (s = ""): void => { lines.push(s); };

  push("# " + out.period + " 月结报告");
  push();
  push("| 项目 | 内容 |");
  push("| --- | --- |");
  push("| 会计期间 | " + out.period + " |");
  push("| 会计准则 | " + ACCOUNTING_STANDARD_LABEL[out.standard] + " |");
  push("| 运行编号 | " + out.runId + " |");
  push("| 开始 / 结束 | " + out.startedAt + " → " + out.finishedAt + " |");
  push("| 合规得分 | " + out.review.summary.score + " / 100 |");
  push("| 阻断项 | " + out.blockers.length + " 条 |");
  push();

  /* 一、总体结论 */
  push("## 一、总体结论");
  push();
  if (out.blockers.length === 0) {
    push("本期账务未发现阻断性问题，可以进入人工复核环节。");
    push("**注意：系统不会、也不能自动向税务机关提交申报**，申报必须由人工在电子税务局完成。");
  } else {
    push("本期存在 **" + out.blockers.length + "** 项阻断问题，**不得结账、不得导出申报底稿**：");
    push();
    out.blockers.forEach((b, i) => push((i + 1) + ". " + b));
  }
  push();

  /* 二、关键数字 */
  push("## 二、关键数字");
  push();
  const totalDebit = out.vouchers.reduce((s, v) => s + v.totalDebit, 0);
  const unbalanced = out.vouchers.filter((v) => !v.balanced);
  push("| 指标 | 数值 |");
  push("| --- | --- |");
  push("| 生成凭证 | " + out.vouchers.length + " 张 |");
  push("| 借方发生额合计 | " + yuan(totalDebit) + " |");
  push("| 借贷不平衡凭证 | " + unbalanced.length + " 张 |");
  push("| 识别单据 | " + out.documents.length + " 条 |");
  push("| 待处理问题 | " + out.issues.length + " 条 |");
  push("| 申报草稿 | " + out.taxReturns.length + " 张 |");
  push();

  if (unbalanced.length > 0) {
    push("> ⚠ 存在借贷不平衡的凭证，这是最严重的问题，必须先修复规则配置再结账。");
    push();
  }

  /* 三、审核结论 */
  push("## 三、合规审核结论");
  push();
  push(out.reviewMarkdown);
  push();

  /* 四、税务 */
  push("## 四、税务草稿（未申报）");
  push();
  if (out.taxReturns.length === 0) {
    push("本期未生成申报草稿。");
  } else {
    push("| 税种 | 期间 | 状态 | 应纳税额 | 应补(退) | 审核阻断 |");
    push("| --- | --- | --- | --- | --- | --- |");
    for (const t of out.taxReturns) {
      push(
        "| " + TAX_TYPE_LABEL[t.taxType] + " | " + t.period + " | " + FILING_STATUS_LABEL[t.status] +
        " | " + yuan(t.payable) + " | " + yuan(t.due) + " | " + t.blockingIssues + " |",
      );
    }
    push();
    push("> 以上均为**草稿**。系统不存在任何向税务局提交的通道，");
    push("> 必须由复核人、审批人依次签署后导出底稿，再由人工在电子税务局申报，回填受理回执号。");
  }
  push();

  /* 五、报表 */
  push("## 五、财务报表");
  push();
  if (out.statements.length === 0) {
    push("本期未生成报表。");
  } else {
    for (const st of out.statements) {
      push("### " + STATEMENT_KIND_LABEL[st.kind]);
      push();
      push("| 项目 | 本期金额 |");
      push("| --- | --- |");
      for (const l of st.lines) {
        if (l.amount === null) continue;
        const indent = "&nbsp;".repeat(l.level * 2);
        const label = l.isTotal === true ? "**" + l.label + "**" : l.label;
        push("| " + indent + label + " | " + yuan(l.amount) + " |");
      }
      push();
      const failed = st.checks.filter((c) => !c.passed);
      if (failed.length > 0) {
        push("勾稽未通过：");
        for (const f of failed) push("- " + f.label + "：" + f.detail);
      } else {
        push("勾稽校验：全部通过（" + st.checks.length + " 项）。");
      }
      push();
    }
  }

  /* 六、财务分析 */
  push("## 六、财务分析");
  push();
  push(out.analysisMarkdown);
  push();

  /* 七、待办 */
  push("## 七、待人工处理");
  push();
  const todos: string[] = [];
  for (const f of out.review.findings) {
    if (f.severity !== "error") continue;
    todos.push("[" + f.ruleId + "] " + f.title + " —— " + f.suggestion);
  }
  for (const t of out.taxReturns) {
    todos.push("申报草稿 " + TAX_TYPE_LABEL[t.taxType] + "（" + t.period + "）待复核人签署");
  }
  if (todos.length === 0) push("暂无待办。");
  else todos.forEach((t, i) => push((i + 1) + ". " + t));
  push();

  if (out.degradations.length > 0) {
    push("## 附：运行降级说明");
    push();
    for (const d of out.degradations) push("- " + d);
    push();
  }

  push("---");
  push();
  push("本报告由系统自动生成，所有金额以「分」为单位精确计算，报表勾稽与合规检查结果可复算。");
  push("税务处理以主管税务机关认定为准；本报告不构成法律或税务意见。");

  return lines.join("\n");
}

/** 渲染一行式摘要，用于 CLI 结尾提示。 */
export function summarizeRun(out: CloseRunOutput): string {
  const parts = [
    "期间 " + out.period,
    "凭证 " + out.vouchers.length,
    "得分 " + out.review.summary.score,
    "阻断 " + out.blockers.length,
    "申报草稿 " + out.taxReturns.length,
  ];
  return parts.join(" | ");
}
