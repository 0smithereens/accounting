/**
 * 企业主体档案加载。
 *
 * 为什么单独一个文件而不是塞进 settings.yaml：
 *  settings 是「怎么记账」的技术参数，company 是「按谁的身份算税」的法定身份，
 *  两者的变更频率、审批人、审计要求都不同（改身份要走税务变更登记），
 *  混在一起会让审计追踪失去意义。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { Cents, TaxpayerId, TaxpayerKind } from '../core/contracts.ts';
import { CONFIG_DIR, ConfigError } from '../core/config.ts';

/** 企业档案（含税务口径与经营画像）。 */
export interface CompanyProfile {
  name: string;
  taxId: TaxpayerId;
  kind: TaxpayerKind;
  /** 城建税税率：7% / 5% / 1% */
  cityTaxRate: 0.07 | 0.05 | 0.01;
  industry: string;
  employees: number;
  /** 资产总额（分） */
  totalAssets: Cents;
  isHighTech: boolean;
  isSmallLowProfit: boolean;
  /** 研发费用（分） */
  rdExpense: Cents;
  region: string;
  fiscalYearEnd: string;
  vatMethod: 'general' | 'simple';
}

const DEFAULT_COMPANY: CompanyProfile = {
  name: '示例科技有限公司',
  taxId: '',
  kind: 'small_scale',
  cityTaxRate: 0.07,
  industry: '',
  employees: 0,
  totalAssets: 0,
  isHighTech: false,
  isSmallLowProfit: true,
  rdExpense: 0,
  region: '',
  fiscalYearEnd: '12-31',
  vatMethod: 'general',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 元 → 分。企业档案里人写的是元，内部一律用分。 */
function yuanToCents(v: unknown): Cents {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

/**
 * 读取 config/company.yaml。
 * 文件缺失时返回安全的默认档案（并保持 isSmallLowProfit=true），
 * 因为中小企业是绝大多数场景，且照此算税偏保守（不会多缴）。
 */
export function loadCompanyProfile(configDir = CONFIG_DIR): CompanyProfile {
  const path = join(configDir, 'company.yaml');
  if (!existsSync(path)) return { ...DEFAULT_COMPANY };

  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`company.yaml 解析失败：${(err as Error).message}`);
  }
  if (!isRecord(doc) || !isRecord(doc['company'])) return { ...DEFAULT_COMPANY };
  const raw = doc['company'];

  const kindRaw = str(raw['kind'], 'small_scale');
  if (kindRaw !== 'general' && kindRaw !== 'small_scale') {
    throw new ConfigError(`company.kind 只能是 general（一般纳税人）或 small_scale（小规模纳税人），实际为「${kindRaw}」`);
  }

  const cityRaw = Number(raw['cityTaxRate'] ?? 0.07);
  if (cityRaw !== 0.07 && cityRaw !== 0.05 && cityRaw !== 0.01) {
    throw new ConfigError(
      `company.cityTaxRate 只能是 0.07（市区）、0.05（县城/镇）或 0.01（其他），实际为 ${cityRaw}`,
    );
  }

  const vatRaw = str(raw['vatMethod'], 'general');
  if (vatRaw !== 'general' && vatRaw !== 'simple') {
    throw new ConfigError(`company.vatMethod 只能是 general 或 simple，实际为「${vatRaw}」`);
  }

  return {
    name: str(raw['name'], DEFAULT_COMPANY.name),
    taxId: str(raw['taxId'], ''),
    kind: kindRaw,
    cityTaxRate: cityRaw,
    industry: str(raw['industry'], ''),
    employees: Number(raw['employees'] ?? 0) || 0,
    totalAssets: yuanToCents(raw['totalAssets']),
    isHighTech: Boolean(raw['isHighTech']),
    isSmallLowProfit: raw['isSmallLowProfit'] === undefined ? true : Boolean(raw['isSmallLowProfit']),
    rdExpense: yuanToCents(raw['rdExpense']),
    region: str(raw['region'], ''),
    fiscalYearEnd: str(raw['fiscalYearEnd'], '12-31'),
    vatMethod: vatRaw,
  };
}
