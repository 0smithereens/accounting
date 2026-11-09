/**
 * 税收优惠智能匹配（优惠智配）。
 *
 * 为什么叫「智配」而不是「自动享受」：
 *  税收优惠几乎都带「资格条件 + 备案/留存备查资料」两道门槛，
 *  系统能算的是「按你的数据看，你可能符合」，不能算的是
 *  「你是否真的满足全部条件、资料是否齐备」。
 *  因此每条匹配结果都分三块：eligible（系统判定）、reasons（判定依据或不符合原因）、
 *  manualChecks（必须由人确认的事项）。系统绝不替企业拍板享受优惠。
 *
 * 估算口径：
 *  estimatedBenefit 是「与不享受优惠相比少缴的税额」，单位分。
 *  它用于排序与预算参考，不能直接当作申报数据 —— 申报仍以各税种计算模块为准。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { BenefitMatch, Cents, LawBasis, Period, TaxType } from '../core/contracts.ts';
import { formatYuanGrouped } from '../core/money.ts';
import { CONFIG_DIR } from '../core/config.ts';

import type { PolicyWindow, TaxpayerProfile } from './rates.ts';
import {
  LAW_BASIS,
  TaxConfigError,
  defaultTaxRates,
  formatRate,
  isPolicyEffective,
  isProductionOrLivingServiceIndustry,
  roundRate,
} from './rates.ts';
import { decideCitRate } from './cit.ts';

function yuan(cents: Cents): string {
  return formatYuanGrouped(cents);
}

/* ================================================================== */
/* 一、政策库结构                                                      */
/* ================================================================== */

/** 一条优惠政策的元数据（不含企业数据）。 */
export interface BenefitPolicyDef {
  id: string;
  name: string;
  /** 主要涉及税种 */
  taxType: TaxType;
  /** 政策适用窗口 */
  window: PolicyWindow;
  /** 优惠内容摘要 */
  content: string;
  /** 法规依据 */
  basis: LawBasis[];
  /** 需要人工确认的事项 */
  manualChecks: string[];
}

/**
 * 内置政策库。
 *
 * 与 config/tax/benefits.yaml 的关系：代码内置一份「不会因为配置丢失而消失」的
 * 最小政策集，YAML 用于补充文号、地方叠加政策与人工确认清单。
 * 加载时以 YAML 为准逐条覆盖，YAML 里没有的仍用内置定义。
 */
export const DEFAULT_BENEFIT_POLICIES: readonly BenefitPolicyDef[] = [
  {
    id: 'cit-small-low-profit',
    name: '小型微利企业所得税优惠（实际税负 5%）',
    taxType: 'cit',
    window: { from: '2023-01-01', to: '2027-12-31' },
    content: '年应纳税所得额不超过 300 万元的部分，减按 25% 计入应纳税所得额，按 20% 的税率缴纳企业所得税。',
    basis: [LAW_BASIS.sixTaxesHalf12, LAW_BASIS.citSmallLowProfit13],
    manualChecks: [
      '确认从事国家非限制和禁止行业',
      '确认从业人数不超过 300 人',
      '确认资产总额不超过 5000 万元',
      '留存备查：从业人数、资产总额计算表',
    ],
  },
  {
    id: 'vat-small-scale-reduction',
    name: '小规模纳税人增值税减免（3% 减按 1%、月 10 万免征）',
    taxType: 'vat',
    window: { from: '2023-01-01', to: '2027-12-31' },
    content: '月销售额 10 万元以下（含本数）免征增值税；适用 3% 征收率的应税销售收入减按 1% 征收。',
    basis: [LAW_BASIS.vatSmallScale19],
    manualChecks: [
      '确认未超过小规模纳税人标准（年应税销售额 500 万元）',
      '确认销售额为不含税销售额',
      '确认未开具增值税专用发票（专票部分不得免税）',
    ],
  },
  {
    id: 'surcharge-six-taxes-half',
    name: '六税两费减半征收',
    taxType: 'surcharge',
    window: { from: '2023-01-01', to: '2027-12-31' },
    content: '对增值税小规模纳税人、小型微利企业和个体工商户减半征收城建税、教育费附加、地方教育附加、印花税（不含证券交易印花税）等六税两费。',
    basis: [LAW_BASIS.sixTaxesHalf12],
    manualChecks: [
      '确认纳税人身份属于小规模纳税人、小型微利企业或个体工商户之一',
      '确认地方是否有叠加优惠（部分地区另有减免）',
    ],
  },
  {
    id: 'cit-rd-super-deduction',
    name: '研发费用加计扣除 100%',
    taxType: 'cit',
    window: { from: '2023-01-01' },
    content: '未形成无形资产计入当期损益的研发费用，在据实扣除基础上再按实际发生额的 100% 加计扣除。',
    basis: [LAW_BASIS.citRdSuperDeduction7],
    manualChecks: [
      '确认研发项目已按科技部门要求立项并辅助账归集',
      '确认不属于烟草制造、住宿餐饮、批发零售、房地产、租赁商务服务、娱乐业等负面清单行业',
      '剔除不适用加计扣除的费用（如其他相关费用超限额部分）',
    ],
  },
  {
    id: 'cit-high-tech',
    name: '高新技术企业 15% 优惠税率',
    taxType: 'cit',
    window: { from: '2008-01-01' },
    content: '国家需要重点扶持的高新技术企业，减按 15% 的税率征收企业所得税。',
    basis: [LAW_BASIS.citLaw, LAW_BASIS.citHighTech32],
    manualChecks: [
      '确认高新技术企业证书在有效期内（三年）',
      '确认科技人员占职工总数比例不低于 10%',
      '确认研发费用占销售收入比例达到对应档位要求',
      '确认高新技术产品（服务）收入占比不低于 60%',
    ],
  },
  {
    id: 'cit-disabled-wage',
    name: '安置残疾人员工资加计扣除',
    taxType: 'cit',
    window: { from: '2008-01-01' },
    content: '安置残疾人员的，在据实扣除残疾职工工资的基础上，按支付给残疾职工工资的 100% 加计扣除。',
    basis: [LAW_BASIS.citDisabled70],
    manualChecks: [
      '确认已与残疾职工签订 1 年以上劳动合同并实际安置',
      '确认已为残疾职工足额缴纳社会保险',
      '确认通过银行等金融机构支付工资且不低于当地最低工资标准',
      '留存备查：残疾证、劳动合同、社保缴纳证明、工资支付凭证',
    ],
  },
  {
    id: 'cit-equipment-depreciation',
    name: '设备器具一次性税前扣除（单价 500 万元以内）',
    taxType: 'cit',
    window: { from: '2024-01-01', to: '2027-12-31' },
    content: '新购进的设备、器具，单位价值不超过 500 万元的，允许一次性计入当期成本费用在税前扣除。',
    basis: [LAW_BASIS.citEquipment37],
    manualChecks: [
      '确认设备器具为 2024-01-01 之后新购进并已投入使用',
      '确认单位价值不超过 500 万元',
      '注意：一次性扣除只是时间性差异，不减少全周期税负',
    ],
  },
  {
    id: 'vat-additional-deduction',
    name: '生产性/生活性服务业增值税加计抵减',
    taxType: 'vat',
    window: { from: '2023-01-01', to: '2027-12-31' },
    content: '生产性服务业纳税人按当期可抵扣进项税额加计 5% 抵减应纳税额；生活性服务业加计 10%。',
    basis: [LAW_BASIS.vatAdditionalDeduction],
    manualChecks: [
      '确认四项服务销售额占全部销售额比重超过 50%',
      '确认加计抵减额未重复计入留抵税额',
      '确认上期未抵减完的加计抵减额已结转',
    ],
  },
];

/* ================================================================== */
/* 二、政策库加载                                                      */
/* ================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function strArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const out = value.map((v) => String(v)).filter((v) => v.trim() !== '');
  return out.length > 0 ? out : [...fallback];
}

/**
 * 加载优惠政策库。
 *
 * 文件缺失 → 返回内置政策库（不报错）：优惠匹配是「锦上添花」的功能，
 *   不能因为少一个配置文件就让整个月结失败。
 * 文件存在但某条政策结构非法 → 抛 TaxConfigError：
 *   文号写错、依据缺失的优惠结论会直接进入对客户的报告，必须当场拦下。
 */
export function loadBenefitPolicies(configDir: string = CONFIG_DIR): BenefitPolicyDef[] {
  const path = join(configDir, 'tax', 'benefits.yaml');
  const defaults = DEFAULT_BENEFIT_POLICIES.map((p) => ({
    ...p,
    basis: [...p.basis],
    manualChecks: [...p.manualChecks],
  }));
  if (!existsSync(path)) return defaults;

  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new TaxConfigError('优惠配置 ' + path + ' 解析失败：' + (err as Error).message);
  }
  if (!isRecord(doc)) throw new TaxConfigError('优惠配置 ' + path + ' 顶层应为对象');

  const listRaw = doc['policies'];
  if (listRaw === undefined) return defaults;
  if (!Array.isArray(listRaw)) throw new TaxConfigError('优惠配置 ' + path + ' 的 policies 应为数组');

  const byId = new Map<string, BenefitPolicyDef>(defaults.map((p) => [p.id, p]));
  const order: string[] = [];

  for (const [index, item] of listRaw.entries()) {
    if (!isRecord(item)) throw new TaxConfigError('benefits.yaml policies[' + index + '] 应为对象');
    const id = str(item['id'], '');
    if (id === '') throw new TaxConfigError('benefits.yaml policies[' + index + '].id 不能为空');
    const base = byId.get(id);
    if (base === undefined) {
      throw new TaxConfigError(
        'benefits.yaml 出现未知政策 id「' + id + '」。新增政策必须同时在 benefits.ts 里实现判定逻辑',
      );
    }
    const taxTypeRaw = str(item['taxType'], base.taxType);
    const validTaxTypes: TaxType[] = [
      'vat', 'cit', 'iit', 'surcharge', 'stamp', 'property', 'consumption', 'resource', 'vehicle_purchase',
    ];
    if (!validTaxTypes.includes(taxTypeRaw as TaxType)) {
      throw new TaxConfigError('benefits.yaml 政策「' + id + '」的 taxType 非法：' + taxTypeRaw);
    }
    const from = str(item['effectiveFrom'], base.window.from);
    const toRaw = item['effectiveTo'];
    const to = typeof toRaw === 'string' && toRaw.trim() !== '' ? toRaw.trim() : base.window.to;

    byId.set(id, {
      id,
      name: str(item['name'], base.name),
      taxType: taxTypeRaw as TaxType,
      window: to === undefined ? { from } : { from, to },
      content: str(item['content'], base.content),
      basis: base.basis,
      manualChecks: strArray(item['manualChecks'], base.manualChecks),
    });
    order.push(id);
  }

  // YAML 中出现的政策按 YAML 顺序在前，其余内置政策保持原顺序追加在后
  const result: BenefitPolicyDef[] = [];
  for (const id of order) {
    const p = byId.get(id);
    if (p !== undefined) result.push(p);
  }
  for (const p of defaults) {
    if (!order.includes(p.id)) result.push(p);
  }
  return result;
}

/* ================================================================== */
/* 三、匹配                                                           */
/* ================================================================== */

/** 匹配所需的财务数据（单位：分）。 */
export interface BenefitFinancials {
  revenue: Cents;
  profit: Cents;
  rdExpense: Cents;
  vatPayable: Cents;
}

/** 匹配的可选项。 */
export interface BenefitMatchOptions {
  /** 政策库，缺省用内置政策库 */
  policies?: readonly BenefitPolicyDef[];
  /** 会计期间，缺省用系统当前月份，用于判断政策窗口 */
  period?: Period;
  /** 残疾职工工资总额（分），用于安置残疾人加计扣除测算 */
  disabledWage?: Cents;
  /** 当年新购进设备器具金额（分），用于一次性扣除测算 */
  equipmentPurchase?: Cents;
}

function currentPeriod(): Period {
  const now = new Date();
  return String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

/**
 * 匹配税收优惠。
 *
 * @param taxpayer 纳税人画像
 * @param financials 财务数据（分）
 * @param options 政策库、期间与补充数据
 */
export function matchBenefits(
  taxpayer: TaxpayerProfile,
  financials: BenefitFinancials,
  options: BenefitMatchOptions = {},
): BenefitMatch[] {
  const rates = defaultTaxRates();
  const period = options.period ?? currentPeriod();
  const policies = options.policies ?? DEFAULT_BENEFIT_POLICIES;
  const revenue = Math.max(0, financials.revenue);
  const profit = financials.profit;
  const rdExpense = Math.max(0, financials.rdExpense);
  const vatPayable = Math.max(0, financials.vatPayable);

  const citDecision = decideCitRate(
    {
      isSmallLowProfit: taxpayer.isSmallLowProfit === true,
      isHighTech: taxpayer.isHighTech === true,
      employees: taxpayer.employees,
      totalAssets: taxpayer.totalAssets,
    },
    Math.max(0, profit),
    rates,
  );
  const citRate = citDecision.rate;

  const out: BenefitMatch[] = [];

  for (const policy of policies) {
    const active = isPolicyEffective(period, policy.window);
    const reasons: string[] = [];
    let eligible = false;
    let benefit = 0;

    switch (policy.id) {
      case 'cit-small-low-profit': {
        if (!active) {
          reasons.push('当前期间不在政策窗口内（' + policy.window.from + ' 至 ' + (policy.window.to ?? '长期') + '）');
        } else if (profit <= 0) {
          reasons.push('本期利润总额为 ' + yuan(profit) + ' 元，无应纳税所得额，暂不产生减免');
        } else {
          const maxIncome = rates.cit.smallLowProfit.maxTaxableIncome;
          if (profit > maxIncome) {
            reasons.push('年应纳税所得额 ' + yuan(profit) + ' 元超过 ' + yuan(maxIncome) + ' 元上限，不符合小型微利企业条件');
          }
          if (taxpayer.employees !== undefined && taxpayer.employees > rates.cit.smallLowProfit.maxEmployees) {
            reasons.push('从业人数 ' + taxpayer.employees + ' 人超过 ' + rates.cit.smallLowProfit.maxEmployees + ' 人上限');
          }
          if (taxpayer.totalAssets !== undefined && taxpayer.totalAssets > rates.cit.smallLowProfit.maxAssets) {
            reasons.push('资产总额 ' + yuan(taxpayer.totalAssets) + ' 元超过 ' + yuan(rates.cit.smallLowProfit.maxAssets) + ' 元上限');
          }
          if (taxpayer.isSmallLowProfit === false) {
            reasons.push('纳税人档案标记为非小型微利企业');
          }
          eligible = reasons.length === 0;
          if (eligible) {
            const statutory = roundRate(profit, rates.cit.standard);
            const actual = roundRate(profit, rates.cit.smallLowProfit.inclusionRate * rates.cit.smallLowProfit.rate);
            benefit = statutory - actual;
            reasons.push(
              '按应纳税所得额 ' + yuan(profit) + ' 元测算：法定 25% 税额 ' + yuan(statutory) +
              ' 元 - 小微实际税负 5% 税额 ' + yuan(actual) + ' 元 = 预计减免 ' + yuan(benefit) + ' 元',
            );
          }
        }
        break;
      }

      case 'vat-small-scale-reduction': {
        if (!active) {
          reasons.push('当前期间不在政策窗口内（2023-01-01 至 2027-12-31）');
        } else if (taxpayer.kind !== 'small_scale') {
          reasons.push('该企业为一般纳税人，适用销项税额减进项税额的抵扣方法，不适用小规模纳税人减征政策');
        } else if (vatPayable <= 0) {
          eligible = true;
          reasons.push('本期应纳增值税为 0，若因月销售额未超过 10 万元而免征，则已完整享受该政策');
        } else {
          eligible = true;
          benefit = vatPayable * 2;
          reasons.push(
            '按减按 1% 征收率计算的应纳增值税 ' + yuan(vatPayable) + ' 元测算：' +
            '若按法定 3% 征收率应缴 ' + yuan(vatPayable * 3) + ' 元，减征 ' + yuan(benefit) + ' 元',
          );
        }
        break;
      }

      case 'surcharge-six-taxes-half': {
        const identityOk = taxpayer.kind === 'small_scale' || taxpayer.isSmallLowProfit === true;
        if (!active) {
          reasons.push('当前期间不在政策窗口内（2023-01-01 至 2027-12-31）');
        } else if (!identityOk) {
          reasons.push('既非增值税小规模纳税人，也非小型微利企业，不适用六税两费减半');
        } else {
          eligible = true;
          const surchargeRate = taxpayer.cityTaxRate + rates.surcharge.education + rates.surcharge.localEducation;
          const full = roundRate(vatPayable, surchargeRate);
          benefit = Math.round(full * rates.surcharge.halfRate);
          reasons.push(
            '以实缴增值税 ' + yuan(vatPayable) + ' 元为计税依据，附加税费合计费率 ' +
            formatRate(surchargeRate) + '，减半预计减免 ' + yuan(benefit) + ' 元（不含印花税部分）',
          );
        }
        break;
      }

      case 'cit-rd-super-deduction': {
        if (!active) {
          reasons.push('当前期间不在政策窗口内');
        } else if (rdExpense <= 0) {
          reasons.push('未归集到研发费用，或本期无研发投入');
        } else {
          eligible = true;
          const superDeduction = roundRate(rdExpense, rates.cit.limits.rdSuperDeduction);
          benefit = roundRate(superDeduction, citRate);
          reasons.push(
            '研发费用 ' + yuan(rdExpense) + ' 元 × 加计比例 ' + formatRate(rates.cit.limits.rdSuperDeduction) +
            ' = 加计扣除 ' + yuan(superDeduction) + ' 元，按适用税率 ' + formatRate(citRate) +
            ' 折算减免 ' + yuan(benefit) + ' 元',
          );
        }
        break;
      }

      case 'cit-high-tech': {
        if (!active) {
          reasons.push('当前期间不在政策窗口内');
        } else if (taxpayer.isHighTech !== true) {
          reasons.push('纳税人档案未标记为高新技术企业');
        } else if (profit <= 0) {
          reasons.push('本期无应纳税所得额，优惠暂不产生实际减免');
        } else {
          eligible = true;
          benefit = roundRate(profit, rates.cit.standard) - roundRate(profit, rates.cit.highTech);
          reasons.push(
            '按应纳税所得额 ' + yuan(profit) + ' 元测算：25% 税额 ' + yuan(roundRate(profit, rates.cit.standard)) +
            ' 元 - 15% 税额 ' + yuan(roundRate(profit, rates.cit.highTech)) + ' 元 = 预计减免 ' + yuan(benefit) + ' 元',
          );
          if (citDecision.smallLowProfitApplied) {
            reasons.push('注意：该企业同时符合小型微利企业条件，两项优惠不得叠加，小微口径税负更低，建议择优适用');
          }
        }
        break;
      }

      case 'cit-disabled-wage': {
        const wage = Math.max(0, options.disabledWage ?? 0);
        if (!active) {
          reasons.push('当前期间不在政策窗口内');
        } else if (wage <= 0) {
          reasons.push('未提供残疾职工工资总额，系统无法判定是否符合安置残疾人加计扣除条件');
        } else {
          eligible = true;
          benefit = roundRate(roundRate(wage, 1), citRate);
          reasons.push(
            '残疾职工工资 ' + yuan(wage) + ' 元 × 加计比例 100% = 加计扣除 ' + yuan(wage) +
            ' 元，按适用税率 ' + formatRate(citRate) + ' 折算减免 ' + yuan(benefit) + ' 元',
          );
        }
        break;
      }

      case 'cit-equipment-depreciation': {
        const purchase = Math.max(0, options.equipmentPurchase ?? 0);
        if (!active) {
          reasons.push('当前期间不在政策窗口内（2024-01-01 至 2027-12-31）');
        } else if (purchase <= 0) {
          reasons.push('本期未识别到设备器具购置，或购置金额未单独归集');
        } else {
          eligible = true;
          benefit = 0;
          reasons.push(
            '本期购置设备器具 ' + yuan(purchase) + ' 元可一次性税前扣除。' +
            '该政策属于时间性差异，只改变扣除年度、不减少全周期税负，故 estimatedBenefit 记为 0',
          );
        }
        break;
      }

      case 'vat-additional-deduction': {
        const industry = taxpayer.industry ?? '';
        if (!active) {
          reasons.push('当前期间不在政策窗口内（2023-01-01 至 2027-12-31）');
        } else if (taxpayer.kind !== 'general') {
          reasons.push('小规模纳税人不适用加计抵减（其不抵扣进项税额）');
        } else if (!isProductionOrLivingServiceIndustry(industry)) {
          reasons.push('所属行业「' + (industry === '' ? '未填写' : industry) + '」未识别为生产性/生活性服务业');
        } else {
          eligible = true;
          benefit = 0;
          reasons.push(
            '所属行业「' + industry + '」可能属于生产性/生活性服务业，可加计抵减。' +
            '因缺少当期可抵扣进项税额，estimatedBenefit 暂记 0，请按实际进项测算',
          );
        }
        break;
      }

      default: {
        reasons.push('系统未实现该政策的判定逻辑');
        break;
      }
    }

    out.push({
      policyId: policy.id,
      policyName: policy.name,
      eligible,
      reasons,
      estimatedBenefit: eligible ? Math.max(0, benefit) : 0,
      basis: [...policy.basis],
      manualChecks: [...policy.manualChecks],
    });
  }

  // 可享受的排在前面，同等条件下按预计减免额从高到低，便于会计先处理大额优惠
  out.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.estimatedBenefit - a.estimatedBenefit;
  });

  return out;
}

/** 只返回可享受的优惠，按预计减免额降序。 */
export function eligibleBenefits(matches: readonly BenefitMatch[]): BenefitMatch[] {
  return matches.filter((m) => m.eligible).sort((a, b) => b.estimatedBenefit - a.estimatedBenefit);
}

/** 汇总预计减免总额（分）。 */
export function totalEstimatedBenefit(matches: readonly BenefitMatch[]): Cents {
  return matches.reduce((sum, m) => sum + (m.eligible ? m.estimatedBenefit : 0), 0);
}
