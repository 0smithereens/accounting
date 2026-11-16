/**
 * 固定资产与摊销台账加载。
 *
 * 为什么台账放 YAML 而不是数据库：
 *  中小企业的固定资产通常几十项，YAML 可被人直接审阅、可进 Git 版本控制，
 *  每一次变更都有 commit 记录——这本身就是一种审计留痕。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { Cents } from "../core/contracts.ts";
import { CONFIG_DIR, ConfigError } from "../core/config.ts";
import type { FixedAsset, AmortizationItem } from "./closing.ts";

export interface AssetLedger {
  assets: FixedAsset[];
  amortization: AmortizationItem[];
  warnings: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function yuan(v: unknown): Cents {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function text(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;
}

/** 读取 config/fixed-assets.yaml。文件不存在时返回空台账（不报错，很多企业没有固资）。 */
export function loadAssetLedger(configDir = CONFIG_DIR): AssetLedger {
  const path = join(configDir, "fixed-assets.yaml");
  if (!existsSync(path)) return { assets: [], amortization: [], warnings: [] };

  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError("fixed-assets.yaml 解析失败：" + (err as Error).message);
  }
  if (!isRecord(doc)) return { assets: [], amortization: [], warnings: [] };

  const warnings: string[] = [];
  const assets: FixedAsset[] = [];
  const rawAssets = Array.isArray(doc["assets"]) ? doc["assets"] : [];
  rawAssets.forEach((item, i) => {
    if (!isRecord(item)) return;
    const id = text(item["id"], "FA-" + String(i + 1).padStart(3, "0"));
    const cost = yuan(item["originalCost"]);
    const months = Number(item["usefulLifeMonths"] ?? 0);
    if (cost <= 0) { warnings.push(id + " 原值为 0，已跳过"); return; }
    if (months <= 0) { warnings.push(id + " 使用月数非正，已跳过"); return; }
    const asset: FixedAsset = {
      id,
      name: text(item["name"], id),
      originalCost: cost,
      usefulLifeMonths: months,
      salvageRate: Number(item["salvageRate"] ?? 0.05),
      startPeriod: text(item["startPeriod"], "2024-01"),
    };
    const dept = text(item["department"]);
    if (dept !== "") asset.department = dept;
    const monthsDep = item["monthsDepreciated"];
    if (typeof monthsDep === "number") asset.monthsDepreciated = monthsDep;
    const aa = text(item["assetAccount"]);
    if (aa !== "") asset.assetAccount = aa;
    const da = text(item["depreciationAccount"]);
    if (da !== "") asset.depreciationAccount = da;
    const ea = text(item["expenseAccount"]);
    if (ea !== "") asset.expenseAccount = ea;
    assets.push(asset);
  });

  const amortization: AmortizationItem[] = [];
  const rawAm = Array.isArray(doc["amortization"]) ? doc["amortization"] : [];
  rawAm.forEach((item, i) => {
    if (!isRecord(item)) return;
    const id = text(item["id"], "AM-" + String(i + 1).padStart(3, "0"));
    const cost = yuan(item["originalCost"]);
    const months = Number(item["months"] ?? 0);
    if (cost <= 0 || months <= 0) { warnings.push(id + " 金额或月数非法，已跳过"); return; }
    const entry: AmortizationItem = {
      id,
      name: text(item["name"], id),
      originalCost: cost,
      months,
      startPeriod: text(item["startPeriod"], "2024-01"),
      assetAccount: text(item["assetAccount"], "1801"),
      expenseAccount: text(item["expenseAccount"], "6602.11"),
    };
    const dept = text(item["department"]);
    if (dept !== "") entry.department = dept;
    const done = item["monthsAmortized"];
    if (typeof done === "number") entry.monthsAmortized = done;
    amortization.push(entry);
  });

  return { assets, amortization, warnings };
}
