import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
const cas: any = parseYaml(readFileSync("config/standard/cas/chart-of-accounts.yaml", "utf8"));
const small: any = parseYaml(readFileSync("config/standard/small/chart-of-accounts.yaml", "utf8"));
const mapDoc: any = parseYaml(readFileSync("config/standard/small/account-map.yaml", "utf8"));
const casCodes = new Set<string>(cas.accounts.map((a: any) => String(a.code)));
const smallCodes = new Set<string>(small.accounts.map((a: any) => String(a.code)));
const fromTo = new Map<string, string | null>();
for (const e of mapDoc.map) fromTo.set(String(e.from), e.to === null ? null : String(e.to));
let text = readFileSync("config/report/statements-small.yaml", "utf8");
let removed = 0;
text = text.replace(/codes:\s*\[([^\]]+)\]/g, (whole: string, inner: string) => {
  const codes = inner.split(",").map((s: string) => s.replace(/["'\s]/g, "")).filter(Boolean);
  const kept: string[] = [];
  for (const c of codes) {
    // 该编码是否可能是当初被追加进来的映射目标？
    let appended = false;
    for (const [from, to] of fromTo) {
      if (to !== c) continue;
      if (smallCodes.has(from)) continue;           // 原始编码就在小企业表里，不可能是映射来源
      if (!codes.includes(from)) continue;          // 同一行里没有来源编码，说明不是追加的
      if (from === c) continue;
      appended = true; break;
    }
    if (appended && kept.length > 0) { removed++; continue; }
    kept.push(c);
  }
  return "codes: [" + kept.map((c: string) => JSON.stringify(c)).join(", ") + "]";
});
writeFileSync("out5/statements-small.revert2.yaml", text);
console.log("再次移除", removed);
