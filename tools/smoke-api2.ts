import { readFileSync } from "node:fs";
const files = ["01-银行流水-工商银行.xlsx","02-发票台账-2024年1月.xlsx","03-费用报销明细-2024年1月.xlsx","04-工资表-2024年1月.xlsx"];
const payload = { period: "2024-01", files: files.map((f) => ({ name: f, dataUrl: "data:application/octet-stream;base64," + readFileSync("samples/" + f).toString("base64") })) };
const res = await fetch("http://127.0.0.1:8793/api/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
const dto: any = await res.json();
console.log("close:", res.status, dto.error ?? JSON.stringify(dto.stats));
for (const p of ["/api/meta","/api/tax/navigation","/api/tax-chain/events","/api/policy/graph","/api/audit/integrity","/api/policy/search?q=%E5%A2%9E%E5%80%BC%E7%A8%8E"]) {
  const r = await fetch("http://127.0.0.1:8793" + p);
  const body: any = await r.json();
  console.log(p, r.status, Object.keys(body).join(","));
}
