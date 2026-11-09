import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
const mapDoc: any = parseYaml(readFileSync("config/standard/small/account-map.yaml", "utf8"));
const map = new Map<string, string | null>();
for (const e of mapDoc.map) map.set(String(e.from), e.to === null ? null : String(e.to));
const chart: any = parseYaml(readFileSync("config/standard/small/chart-of-accounts.yaml", "utf8"));
const exists = new Set<string>(chart.accounts.map((a: any) => String(a.code)));
function lookup(code: string): string | null {
  let probe = code;
  while (true) {
    if (map.has(probe)) return map.get(probe) ?? null;
    const dot = probe.lastIndexOf(".");
    if (dot < 0) return code;
    probe = probe.slice(0, dot);
  }
}
let text = readFileSync("config/report/statements-small.yaml", "utf8");
const claimed = new Set<string>();
let added = 0, skipped = 0;
text = text.replace(/codes:\s*\[([^\]]+)\]/g, (whole: string, inner: string) => {
  const codes = inner.split(",").map((s: string) => s.replace(/["'\s]/g, "")).filter(Boolean);
  const out = [...codes];
  for (const c of codes) {
    if (exists.has(c)) { claimed.add(c); continue; }
    const to = lookup(c);
    if (to === null || !exists.has(to)) { skipped++; continue; }
    if (claimed.has(to) || out.includes(to)) continue;
    claimed.add(to); out.push(to); added++;
  }
  return "codes: [" + out.map((c) => JSON.stringify(c)).join(", ") + "]";
});
writeFileSync("out5/statements-small.new.yaml", text);
console.log("added", added, "skipped", skipped, "claimed", claimed.size);
