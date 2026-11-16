import { readFileSync } from "node:fs";
const files = ["01-银行流水-工商银行.xlsx","02-发票台账-2024年1月.xlsx","03-费用报销明细-2024年1月.xlsx","04-工资表-2024年1月.xlsx"];
const payload = {
  period: "2024-01",
  files: files.map((f) => ({ name: f, dataUrl: "data:application/octet-stream;base64," + readFileSync("samples/" + f).toString("base64") })),
};
const res = await fetch("http://127.0.0.1:8792/api/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
const dto: any = await res.json();
console.log("status", res.status);
if (dto.error) { console.log("ERROR", dto.error); process.exit(0); }
console.log("stats", JSON.stringify(dto.stats));
console.log("statements", dto.statements.length, "taxReturns", dto.taxReturns.length, "vouchers", dto.vouchers.length);
