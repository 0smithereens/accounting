import { loadConfig } from "../src/core/config.ts";
for (const id of ["cas", "small"] as const) {
  const cfg = loadConfig(undefined, id);
  console.log("=====", id, "| 科目数", cfg.accounts.accounts.length, "| 规则数", cfg.rules.rules.length);
  const r = cfg.remap;
  console.log("  改写", r ? r.rewrites.length : 0, "条；停用", r ? r.dropped.length : 0, "条");
  if (r && r.dropped.length > 0) {
    for (const d of r.dropped.slice(0, 5)) console.log("   停用", d.ruleId, "科目", d.account, "原因", d.reason);
  }
  if (r && r.rewrites.length > 0) {
    const uniq = new Map();
    for (const w of r.rewrites) uniq.set(w.from + "->" + w.to, true);
    console.log("  样例:", Array.from(uniq.keys()).slice(0, 8).join(", "));
  }
  console.log("  报销贷方科目:", cfg.settings.expenseCreditAccount, "| 兜底:", cfg.settings.suspenseAccount);
  const rule = cfg.rules.rules.find((x) => x.id === "invoice-output-goods");
  console.log("  invoice-output-goods:", rule === undefined ? "不存在" : rule.then.entries.map((e) => e.side + ":" + e.account).join(" "));
}
