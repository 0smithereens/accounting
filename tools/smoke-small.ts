import { loadConfig } from "../src/core/config.ts";
import { runClose } from "../src/app/close-run.ts";
const out = await runClose({ period: "2024-01", files: ["samples/01-银行流水-工商银行.xlsx","samples/02-发票台账-2024年1月.xlsx","samples/03-费用报销明细-2024年1月.xlsx","samples/04-工资表-2024年1月.xlsx"], standard: "small", includePeriodEnd: true });
for (const st of out.statements) {
  const bad = st.checks.filter((c) => !c.passed);
  if (bad.length === 0) continue;
  console.log("报表", st.kind);
  for (const c of bad) console.log("  [x]", c.label, "diff", c.diff, "|", c.detail.slice(0, 120));
}
const codes = out.snapshot.balances.filter((b) => b.closing !== 0).map((b) => b.accountCode);
const unmapped = codes.filter((c) => c.startsWith("6") || c.startsWith("4") || c.startsWith("5"));
console.log("受影响科目样例:", unmapped.slice(0, 12).join(", "));
