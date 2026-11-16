import { readFileSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";
const files = ["D:/Project/accounting/release/.github/workflows/ci.yml"];
for (const f of files) {
  try {
    const doc: any = parseYaml(readFileSync(f, "utf8"));
    console.log("YAML 解析成功:", f.split("/").pop(), "| jobs:", Object.keys(doc.jobs ?? {}).join(", "));
    for (const [name, job] of Object.entries(doc.jobs ?? {})) {
      const steps = (job as any).steps ?? [];
      console.log("  " + name + ": " + steps.length + " 步 — " + steps.map((s: any) => s.name ?? s.uses ?? "run").join(" / ").slice(0, 120));
    }
  } catch (e) { console.log("解析失败", f, (e as Error).message.slice(0, 200)); }
}
console.log("\n.github 内容:", readdirSync("D:/Project/accounting/release/.github", { recursive: true }).join(", "));
