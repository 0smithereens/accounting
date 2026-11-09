/**
 * 科目编码重映射：让同一套业务规则跑在两套会计准则上。
 *
 * 问题：
 *  企业会计准则与《小企业会计准则》的科目编码体系不同，且存在「同号不同义」——
 *    4001 企业准则=实收资本，小企业准则=生产成本
 *    5001 企业准则=生产成本，小企业准则=主营业务收入
 *    5301 企业准则=研发支出，小企业准则=营业外收入
 *  如果只按编码取科目，小企业准则下会把「实收资本」记成「生产成本」。
 *
 * 方案：
 *  业务规则只维护企业会计准则一套（config/mappings/*.yaml），
 *  切到小企业准则时，按 config/standard/small/account-map.yaml 把编码改写过去；
 *  目标准则下确实不存在的业务（如递延所得税），整条规则停用并给出原因，
 *  而不是硬塞到一个不存在的科目里糊弄过去。
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import type { EntryTemplate, Rule } from "./types.ts";
import type { AccountTable } from "./config.ts";
import { ConfigError } from "./config.ts";

export interface AccountMapEntry {
  from: string;
  /** null 表示该准则下没有对应业务，相关规则应停用 */
  to: string | null;
  note?: string;
}

export interface AccountRemapTable {
  entries: AccountMapEntry[];
  byCode: Map<string, AccountMapEntry>;
  /** 最长前缀匹配：6602.10 会命中 6602 的映射 */
  lookup(code: string): AccountMapEntry | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 读取映射表。文件不存在时返回空表（等价于不映射）。 */
export function loadAccountMap(path: string): AccountRemapTable {
  const entries: AccountMapEntry[] = [];
  if (existsSync(path)) {
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(path, "utf8"));
    } catch (err) {
      throw new ConfigError("科目映射表解析失败 " + path + "：" + (err as Error).message);
    }
    const list = isRecord(doc) && Array.isArray(doc["map"]) ? doc["map"] : [];
    for (const item of list) {
      if (!isRecord(item)) continue;
      const from = typeof item["from"] === "string" ? item["from"].trim() : "";
      if (from === "") continue;
      const rawTo = item["to"];
      const to = rawTo === null || rawTo === undefined ? null : String(rawTo).trim();
      const entry: AccountMapEntry = { from, to: to === "" ? null : to };
      const note = typeof item["note"] === "string" ? item["note"] : undefined;
      if (note !== undefined) entry.note = note;
      entries.push(entry);
    }
  }

  const byCode = new Map<string, AccountMapEntry>();
  for (const e of entries) byCode.set(e.from, e);

  return {
    entries,
    byCode,
    lookup(code: string): AccountMapEntry | null {
      // 从最长前缀开始试：6602.10 → 6602.10 → 6602
      let probe = code;
      while (true) {
        const hit = byCode.get(probe);
        if (hit !== undefined) return hit;
        const dot = probe.lastIndexOf(".");
        if (dot < 0) return null;
        probe = probe.slice(0, dot);
      }
    },
  };
}

export interface AccountResolution {
  /** 最终使用的编码；无法解析时为 null */
  code: string | null;
  /** 是否发生了改写 */
  changed: boolean;
  /** 停用原因（code 为 null 时必有） */
  reason?: string;
}

/**
 * 把一个企业会计准则编码解析到目标准则的科目表。
 *
 * 解析顺序：
 *  1. 映射表最长前缀命中：to 为 null → 停用；否则用 to，并在目标表里校准（必要时向上找父级）
 *  2. 目标表直接有该编码 → 原样使用
 *  3. 逐级去掉末段找上级
 *  4. 都不行 → 停用
 */
export function resolveForStandard(
  code: string,
  target: AccountTable,
  map: AccountRemapTable | null,
): AccountResolution {
  const mapped = map?.lookup(code) ?? null;

  if (mapped !== null) {
    if (mapped.to === null) {
      return { code: null, changed: true, reason: mapped.note ?? "该准则下无对应科目" };
    }
    const candidates = ascend(mapped.to);
    for (const c of candidates) {
      if (target.get(c) !== undefined) {
        return { code: c, changed: c !== code, reason: mapped.note };
      }
    }
    return { code: null, changed: true, reason: "映射目标 " + mapped.to + " 不在目标科目表中" };
  }

  for (const c of ascend(code)) {
    if (target.get(c) !== undefined) return { code: c, changed: c !== code };
  }
  return { code: null, changed: true, reason: "目标科目表中不存在该科目" };
}

/** 生成「自身 + 各级父级」的候选序列。 */
function ascend(code: string): string[] {
  const out: string[] = [];
  let probe = code;
  while (true) {
    out.push(probe);
    const dot = probe.lastIndexOf(".");
    if (dot < 0) break;
    probe = probe.slice(0, dot);
  }
  return out;
}

export interface RuleRemapOutcome {
  rules: Rule[];
  byId: Map<string, Rule>;
  /** 被改写的科目 */
  rewrites: Array<{ ruleId: string; from: string; to: string }>;
  /** 因准则差异被停用的规则 */
  dropped: Array<{ ruleId: string; desc: string; account: string; reason: string }>;
}

/**
 * 批量改写规则里的科目编码。
 *
 * 一条规则只要有一个分录科目在目标准则下不存在，整条规则停用——
 * 因为残缺的分录一定借贷不平，与其生成错账不如明确告诉用户「这条业务在小企业准则下不适用」。
 */
export function remapRules(
  rules: readonly Rule[],
  target: AccountTable,
  map: AccountRemapTable | null,
): RuleRemapOutcome {
  const out: Rule[] = [];
  const rewrites: RuleRemapOutcome["rewrites"] = [];
  const dropped: RuleRemapOutcome["dropped"] = [];

  for (const rule of rules) {
    const entries: EntryTemplate[] = [];
    let dead = false;

    for (const entry of rule.then.entries) {
      // 占位符科目（{field.xxx}）在运行时才确定，跳过映射
      if (entry.account.includes("{")) { entries.push(entry); continue; }
      const res = resolveForStandard(entry.account, target, map);
      if (res.code === null) {
        dead = true;
        dropped.push({
          ruleId: rule.id,
          desc: rule.desc ?? "",
          account: entry.account,
          reason: res.reason ?? "目标准则下无对应科目",
        });
        break;
      }
      if (res.code !== entry.account) {
        rewrites.push({ ruleId: rule.id, from: entry.account, to: res.code });
      }
      entries.push({ ...entry, account: res.code });
    }

    if (dead) continue;
    out.push({ ...rule, then: { entries } });
  }

  const byId = new Map<string, Rule>();
  for (const r of out) byId.set(r.id, r);
  return { rules: out, byId, rewrites, dropped };
}
