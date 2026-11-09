import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
const cas: any = parseYaml(readFileSync("config/standard/cas/chart-of-accounts.yaml", "utf8"));
const small: any = parseYaml(readFileSync("config/standard/small/chart-of-accounts.yaml", "utf8"));
const casCodes = new Set<string>(cas.accounts.map((a: any) => String(a.code)));
const smallOnly = new Set<string>();
for (const a of small.accounts) { const c = String(a.code); if (!casCodes.has(c)) smallOnly.add(c); }
console.log("小企业准则独有编码:", [...smallOnly].join(","));
let text = readFileSync("config/report/statements-small.yaml", "utf8");
let removed = 0;
text = text.replace(/codes:\s*\[([^\]]+)\]/g, (whole: string, inner: string) => {
  const codes = inner.split(",").map((s: string) => s.replace(/["'\s]/g, "")).filter(Boolean);
  const kept = codes.filter((c: string) => { if (smallOnly.has(c)) { removed++; return false; } return true; });
  return "codes: [" + kept.map((c: string) => JSON.stringify(c)).join(", ") + "]";
});
writeFileSync("out5/statements-small.revert.yaml", text);
console.log("移除", removed, "个编码");
