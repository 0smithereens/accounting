/**
 * Web API 层。
 *
 * 与 src/web/server.ts 的分工：
 *  server.ts 只负责 HTTP 细节（读请求体、写响应头、静态文件）；
 *  这里负责「业务语义」——每个端点对应一个可被 CLI 复用的领域动作。
 *  这样加一个端点不用动路由主干，也方便单测直接调函数。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { AccountingStandardId, Period } from "../core/contracts.ts";
import { ACCOUNTING_STANDARD_LABEL } from "../core/contracts.ts";
import { loadConfig, ConfigError } from "../core/config.ts";
import { loadCompanyProfile } from "../app/company.ts";
import { runClose } from "../app/close-run.ts";
import { renderMonthlyReport } from "../app/monthly-report.ts";
import { loadStandardRegistry, describeFeatureDiff } from "../core/standard/index.ts";
import { toCloseRunDto, fmtYuan } from "./dto.ts";
import { AuditStore } from "../audit/index.ts";
import {
  loadPolicyKnowledgeBase,
  searchPolicies,
  policyDossier,
  groupBusinessEvents,
  locateByReturnLine,
  buildNavigation,
  POLICY_COMPLIANCE_NOTICE,
} from "../policy/index.ts";
import { PAYABLE_LINE_CODES } from "../tax/index.ts";

const MAX_BODY_BYTES = 80 * 1024 * 1024;

export interface ApiDeps {
  workDir: string;
  auditDir: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 解析 base64 data URL，返回 Buffer。 */
function decodeDataUrl(input: string): Buffer {
  const comma = input.indexOf(",");
  const raw = comma >= 0 ? input.slice(comma + 1) : input;
  return Buffer.from(raw, "base64");
}

interface UploadFile { name: string; dataUrl: string }

/**
 * 处理 /api/** 请求。返回 true 表示已处理。
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ApiDeps,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/")) return false;
  const method = req.method ?? "GET";

  try {
    /* ---------------- 元信息 ---------------- */
    if (method === "GET" && path === "/api/meta") {
      const config = loadConfig();
      const registry = loadStandardRegistry();
      const company = loadCompanyProfile();
      send(res, 200, {
        standards: registry.all().map((p) => ({
          id: p.id, label: p.label, summary: p.summary,
          features: p.features,
          forbiddenCount: p.forbiddenAccounts.length,
        })),
        featureDiff: describeFeatureDiff(),
        activeStandard: config.settings.accountingStandard,
        activeStandardLabel: ACCOUNTING_STANDARD_LABEL[config.settings.accountingStandard],
        company: { name: company.name, kind: company.kind, industry: company.industry, cityTaxRate: company.cityTaxRate },
        config: {
          accountCount: config.accounts.accounts.length,
          ruleCount: config.rules.rules.length,
          remapDropped: config.remap?.dropped.length ?? 0,
          companyNames: config.settings.companyNames,
        },
        notice: POLICY_COMPLIANCE_NOTICE,
      });
      return true;
    }

    /* ---------------- 月结 ---------------- */
    if (method === "POST" && path === "/api/close") {
      const body = JSON.parse(await readBody(req)) as {
        period: string; standard?: AccountingStandardId; files: UploadFile[];
      };
      const period = body.period;
      if (!/^\d{4}-\d{2}$/.test(period ?? "")) {
        send(res, 400, { error: "period 必须为 YYYY-MM" });
        return true;
      }
      // 文件落盘到 workDir/<runId>/，供记账管线读取
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const runId = "web-" + Date.now().toString(36);
      const dir = join(deps.workDir, runId);
      await mkdir(dir, { recursive: true });
      const paths: string[] = [];
      for (const [i, f] of (body.files ?? []).entries()) {
        const safe = String(i) + "-" + f.name.replace(/[\\/:*?"<>|]/g, "_");
        const p = join(dir, safe);
        await writeFile(p, decodeDataUrl(f.dataUrl));
        paths.push(p);
      }
      const output = await runClose({
        period: period as Period,
        files: paths,
        standard: body.standard,
      });
      const monthly = renderMonthlyReport(output);
      send(res, 200, toCloseRunDto(output, monthly));
      return true;
    }

    /* ---------------- 政策库 ---------------- */
    if (method === "GET" && path === "/api/policy/search") {
      const kb = loadPolicyKnowledgeBase();
      const q = url.searchParams.get("q") ?? "";
      const tax = url.searchParams.get("tax") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const hits = searchPolicies(kb.library, {
        text: q === "" ? undefined : q,
        limit: Number.isFinite(limit) ? limit : 20,
      });
      send(res, 200, {
        total: kb.library.count(),
        hits: hits.map((h) => ({
          id: h.policy.id, documentNo: h.policy.documentNo, title: h.policy.title,
          issuer: h.policy.issuer, effectiveFrom: h.policy.effectiveFrom,
          lifecycle: h.policy.lifecycle, level: h.policy.level,
          summary: h.policy.summary, score: h.score, snippet: h.snippet,
        })),
        stats: kb.graph.stats(),
      });
      return true;
    }

    if (method === "GET" && path === "/api/policy/graph") {
      const kb = loadPolicyKnowledgeBase();
      const stats = kb.graph.stats();
      send(res, 200, {
        stats,
        edges: kb.graph.edges().slice(0, 400),
        families: kb.families.map((f) => ({ id: f.id, name: f.name, size: f.members.length })),
        hubs: stats.keyHubs.slice(0, 12),
      });
      return true;
    }

    if (method === "GET" && path.startsWith("/api/policy/")) {
      const id = decodeURIComponent(path.slice("/api/policy/".length));
      const kb = loadPolicyKnowledgeBase();
      const dossier = policyDossier(kb, id);
      if (dossier === null) { send(res, 404, { error: "政策不存在：" + id }); return true; }
      send(res, 200, {
        policy: dossier.policy,
        outRelations: dossier.outRelations,
        inRelations: dossier.inRelations,
        family: dossier.family,
        events: dossier.events.map((e) => ({ id: e.id, name: e.name, group: e.group })),
        notice: POLICY_COMPLIANCE_NOTICE,
      });
      return true;
    }

    /* ---------------- 税种导航与税会智链 ---------------- */
    if (method === "GET" && path === "/api/tax/navigation") {
      const kb = loadPolicyKnowledgeBase();
      send(res, 200, { navigation: buildNavigation(kb.library) });
      return true;
    }

    if (method === "GET" && path === "/api/tax-chain/events") {
      const kb = loadPolicyKnowledgeBase();
      send(res, 200, {
        groups: groupBusinessEvents(kb.events).map((g) => ({
          group: g.group,
          events: g.events.map((e) => ({
            id: e.id, name: e.name,
            taxTypes: e.taxTypes,
            differenceCount: e.differences.length,
            returnLineCount: e.returnLines.length,
          })),
        })),
      });
      return true;
    }

    if (method === "GET" && path === "/api/tax-chain/event") {
      const kb = loadPolicyKnowledgeBase();
      const id = url.searchParams.get("id") ?? "";
      const ev = kb.events.find((e) => e.id === id);
      if (ev === undefined) { send(res, 404, { error: "业务事项不存在" }); return true; }
      const policies = ev.policyIds
        .map((pid) => kb.library.get(pid))
        .filter((p): p is NonNullable<typeof p> => p !== undefined)
        .map((p) => ({ id: p.id, documentNo: p.documentNo, title: p.title }));
      send(res, 200, { event: ev, policies });
      return true;
    }

    if (method === "GET" && path === "/api/tax-chain/locate") {
      const kb = loadPolicyKnowledgeBase();
      const tax = url.searchParams.get("tax") ?? "";
      const line = url.searchParams.get("line") ?? "";
      const hits = locateByReturnLine(
        kb.events,
        tax as never,
        line,
      );
      send(res, 200, { hits: hits.map((e) => ({ id: e.id, name: e.name, group: e.group })) });
      return true;
    }

    /* ---------------- 审计 ---------------- */
    if (method === "GET" && path === "/api/audit/integrity") {
      const store = new AuditStore({ dataDir: deps.auditDir, actor: "web:audit" });
      const report = store.verifyIntegrity();
      const events = store.events().slice(-50).reverse();
      send(res, 200, {
        report,
        recent: events.map((e) => ({
          seq: e.seq, at: e.at, actor: e.actor, action: e.action,
          entity: e.entity, entityId: e.entityId, reason: e.reason ?? null,
        })),
      });
      return true;
    }

    if (method === "GET" && path === "/api/tax/payable-codes") {
      send(res, 200, { codes: PAYABLE_LINE_CODES, note: fmtYuan(0) });
      return true;
    }

    send(res, 404, { error: "未知接口：" + method + " " + path });
    return true;
  } catch (err) {
    const message = err instanceof ConfigError || err instanceof Error ? (err as Error).message : String(err);
    send(res, 500, { error: message });
    return true;
  }
}
