import { runClose } from "../src/app/close-run.ts";
const out = await runClose({ period: "2024-01", files: ["samples/01-银行流水-工商银行.xlsx","samples/02-发票台账-2024年1月.xlsx","samples/03-费用报销明细-2024年1月.xlsx","samples/04-工资表-2024年1月.xlsx","samples/05-采购合同-数控设备.docx"] });
const by = new Map();
for (const f of out.review.findings) {
  const k = f.ruleId + " | " + f.severity + (f.blocking ? " | BLOCK" : "");
  by.set(k, (by.get(k) ?? 0) + 1);
}
console.log("按规则统计：");
for (const [k, v] of [...by.entries()].sort()) console.log("  " + String(v).padStart(3) + "  " + k);
console.log("");
console.log("前 6 条明细：");
for (const f of out.review.findings.slice(0, 6)) {
  console.log("[" + f.ruleId + "] " + f.title);
  console.log("   " + f.detail.slice(0, 160));
  console.log("   依据: " + f.basis.map((b) => b.title).join(" / ").slice(0, 100));
}
