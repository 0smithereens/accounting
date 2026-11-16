/** 调试用：打印某张申报表的各行，标出哪一行被识别为「应纳税额」。 */
import { AuditStore } from "../src/audit/index.ts";
import { isPayableLine, selectFinalPayableLines } from "../src/filing/index.ts";
import type { TaxReturn } from "../src/core/contracts.ts";

const store = new AuditStore({ dataDir: "data/audit", actor: "debug" });
const ret = store.current<TaxReturn>("tax_return", "TAX-VAT-2024-01-91310000MA1FL0000X");
if (ret === null) { console.log("未找到申报表"); } else {
  const final = new Set(selectFinalPayableLines(ret.lines).map((l) => l.code));
  console.log("payable", ret.payable);
  for (const l of ret.lines) {
    const mark = final.has(l.code) ? "  [最终应纳税额] " : isPayableLine(l) ? "  (宽松命中)" : "             ";
    console.log(mark + l.code.padEnd(20) + l.label + " = " + l.amount);
  }
}
