/**
 * 附加税费：城市维护建设税 + 教育费附加 + 地方教育附加。
 *
 * 三个容易算错的地方，本模块逐一钉死：
 *  1. 计税依据是「实际缴纳的增值税、消费税」，不是「应纳税额」。
 *     当期形成留抵、没有实际缴税，就不得计提附加税费 —— 否则企业会白交一笔。
 *  2. 六税两费减半（财政部 税务总局公告2023年第12号）只适用于
 *     小规模纳税人、小型微利企业和个体工商户；一般纳税人即使规模很小，
 *     只要不是小型微利企业也不能减半。
 *  3. 月销售额 10 万元（季度 30 万元）以下免征的是教育费附加与地方教育附加
 *     （财税〔2016〕12号），城市维护建设税不在免征范围内。
 */

import type { Cents, Period, TaxLine } from '../core/contracts.ts';
import { formatYuanGrouped } from '../core/money.ts';

import type { TaxRates } from './rates.ts';
import {
  LAW_BASIS,
  defaultTaxRates,
  formatRate,
  halfCents,
  isPolicyKeyEffective,
  roundRate,
} from './rates.ts';

function yuan(cents: Cents): string {
  return formatYuanGrouped(cents);
}

/** 附加税费计算输入。 */
export interface SurchargeComputeInput {
  period: Period;
  /** 城建税税率：0.07（市区）/ 0.05（县城、镇）/ 0.01（其他） */
  cityTaxRate: number;
  /** 是否增值税小规模纳税人 */
  smallScale: boolean;
  /** 是否小型微利企业 */
  smallLowProfit: boolean;
  /** 本期实际缴纳的增值税（分）。留抵未缴请传 0 */
  vatPaid: Cents;
  /** 本期实际缴纳的消费税（分） */
  consumptionTaxPaid?: Cents;
  /** 本期不含税销售额（分），用于判断教育费附加免征 */
  salesAmount?: Cents;
  /** 是否按季申报 */
  quarterly?: boolean;
  /** 是否享受六税两费减半；不传则按纳税人身份自动判定 */
  halfReduction?: boolean;
  /** 本期已预缴（分） */
  prepaid?: Cents;
}

/** 附加税费计算结果。 */
export interface SurchargeComputeResult {
  lines: TaxLine[];
  /** 计税依据 = 实缴增值税 + 实缴消费税（分） */
  base: Cents;
  cityTax: Cents;
  educationSurcharge: Cents;
  localEducationSurcharge: Cents;
  total: Cents;
  halfReduction: boolean;
  /** 是否因月销售额未达门槛而免征教育费附加、地方教育附加 */
  educationExempt: boolean;
  prepaid: Cents;
  due: Cents;
  notes: string[];
}

/**
 * 判断是否属于「六税两费」减半范围。
 *
 * 个体工商户在本系统的纳税人档案里没有独立身份，按小规模纳税人处理；
 * 若将来引入 'individual_business' 身份，只需在这里增加一个分支。
 */
export function isSixTaxesHalfEligible(smallScale: boolean, smallLowProfit: boolean): boolean {
  return smallScale || smallLowProfit;
}

/**
 * 计算附加税费。
 *
 * @param input 实缴增值税、消费税与纳税人身份
 * @param rates 税率表
 */
export function computeSurcharge(
  input: SurchargeComputeInput,
  rates: TaxRates = defaultTaxRates(),
): SurchargeComputeResult {
  const notes: string[] = [];
  const quarterly = input.quarterly === true;

  const vatPaid = Math.max(0, input.vatPaid);
  const consumptionPaid = Math.max(0, input.consumptionTaxPaid ?? 0);
  const base = vatPaid + consumptionPaid;

  const policyActive = isPolicyKeyEffective(input.period, 'sixTaxesHalf');
  const eligible = isSixTaxesHalfEligible(input.smallScale, input.smallLowProfit);
  const halfReduction = policyActive && (input.halfReduction ?? eligible);

  const cityRate = input.cityTaxRate;
  const cityFull = roundRate(base, cityRate);
  const cityTax = halfReduction ? halfCents(cityFull) : cityFull;

  const eduThreshold = quarterly
    ? rates.surcharge.educationExemptQuarterlyThreshold
    : rates.surcharge.educationExemptMonthlyThreshold;
  const salesAmount = Math.max(0, input.salesAmount ?? 0);
  const educationExempt = salesAmount > 0 && salesAmount <= eduThreshold;

  const eduFull = educationExempt ? 0 : roundRate(base, rates.surcharge.education);
  const localFull = educationExempt ? 0 : roundRate(base, rates.surcharge.localEducation);
  const educationSurcharge = halfReduction ? halfCents(eduFull) : eduFull;
  const localEducationSurcharge = halfReduction ? halfCents(localFull) : localFull;

  const total = cityTax + educationSurcharge + localEducationSurcharge;
  const fullTotal = cityFull + eduFull + localFull;
  const reductionAmount = fullTotal - total;
  const prepaid = Math.max(0, input.prepaid ?? 0);
  const due = total - prepaid;

  const lines: TaxLine[] = [
    {
      code: 'SUR-BASE',
      label: '计税依据（实际缴纳的增值税、消费税）',
      amount: base,
      note:
        '计税依据 = 实际缴纳增值税 ' + yuan(vatPaid) + ' + 实际缴纳消费税 ' + yuan(consumptionPaid) +
        ' = ' + yuan(base) + ' 元。留抵未缴的增值税不构成附加税费计税依据',
      basis: [LAW_BASIS.cityTaxLaw, LAW_BASIS.educationSurchargeRule],
    },
    {
      code: 'SUR-CITY',
      label: '城市维护建设税',
      amount: cityTax,
      rate: cityRate,
      note:
        '城市维护建设税 = 计税依据 ' + yuan(base) + ' × ' + formatRate(cityRate) + ' = ' + yuan(cityFull) +
        ' 元' +
        (halfReduction
          ? '，六税两费减半后 ' + yuan(cityFull) + ' × 50% = ' + yuan(cityTax) + ' 元'
          : '') +
        '（四舍五入到分）',
      basis: [LAW_BASIS.cityTaxLaw, LAW_BASIS.sixTaxesHalf12],
    },
    {
      code: 'SUR-EDU',
      label: '教育费附加',
      amount: educationSurcharge,
      rate: rates.surcharge.education,
      note: educationExempt
        ? '本期销售额 ' + yuan(salesAmount) + ' 元未超过 ' + yuan(eduThreshold) +
          ' 元，按财税〔2016〕12号免征教育费附加'
        : '教育费附加 = 计税依据 ' + yuan(base) + ' × ' + formatRate(rates.surcharge.education) +
          ' = ' + yuan(eduFull) + ' 元' +
          (halfReduction ? '，六税两费减半后 ' + yuan(educationSurcharge) + ' 元' : ''),
      basis: [LAW_BASIS.educationSurchargeRule, LAW_BASIS.educationExempt12],
    },
    {
      code: 'SUR-LOCAL',
      label: '地方教育附加',
      amount: localEducationSurcharge,
      rate: rates.surcharge.localEducation,
      note: educationExempt
        ? '本期销售额 ' + yuan(salesAmount) + ' 元未超过 ' + yuan(eduThreshold) +
          ' 元，按财税〔2016〕12号免征地方教育附加'
        : '地方教育附加 = 计税依据 ' + yuan(base) + ' × ' + formatRate(rates.surcharge.localEducation) +
          ' = ' + yuan(localFull) + ' 元' +
          (halfReduction ? '，六税两费减半后 ' + yuan(localEducationSurcharge) + ' 元' : ''),
      basis: [LAW_BASIS.localEducationRule, LAW_BASIS.educationExempt12],
    },
    ...(reductionAmount > 0
      ? [
          {
            code: 'tax_reduction',
            label: '六税两费减免税额',
            amount: reductionAmount,
            note:
              '六税两费减半共减免 ' + yuan(reductionAmount) + ' 元（减半前合计 ' + yuan(fullTotal) +
              ' 元 - 减半后合计 ' + yuan(total) + ' 元），已体现在各税费栏次',
            basis: [LAW_BASIS.sixTaxesHalf12],
          } satisfies TaxLine,
        ]
      : []),
    {
      code: 'SUR-TOTAL',
      label: '附加税费合计',
      amount: total,
      note:
        '合计 = 城建税 ' + yuan(cityTax) + ' + 教育费附加 ' + yuan(educationSurcharge) +
        ' + 地方教育附加 ' + yuan(localEducationSurcharge) + ' = ' + yuan(total) + ' 元',
      basis: [LAW_BASIS.cityTaxLaw],
    },
    {
      code: 'SUR-DUE',
      label: '本期应补(退)税额',
      amount: due,
      note:
        '本期应补(退)税额 = 合计 ' + yuan(total) + ' - 已预缴 ' + yuan(prepaid) + ' = ' + yuan(due) + ' 元',
      basis: [LAW_BASIS.taxCollectionLaw],
    },
  ];

  if (base === 0) {
    notes.push('本期实际缴纳增值税、消费税均为 0，附加税费计税依据为 0，无需计提（留抵不缴则不计提）');
  }
  if (!halfReduction && eligible && !policyActive) {
    notes.push('当前期间不在六税两费减半政策窗口（2023-01-01 至 2027-12-31）内，按全额计算');
  }
  if (!halfReduction && !eligible) {
    notes.push('该纳税人既非小规模纳税人，也非小型微利企业，不适用六税两费减半');
  }
  if (educationExempt && base > 0) {
    notes.push('教育费附加、地方教育附加免征，但城市维护建设税不属免征范围，仍需缴纳 ' + yuan(cityTax) + ' 元');
  }

  return {
    lines,
    base,
    cityTax,
    educationSurcharge,
    localEducationSurcharge,
    total,
    halfReduction,
    educationExempt,
    prepaid,
    due,
    notes,
  };
}

/** 从城建税税率反推纳税人所在地类型，用于申报表说明。 */
export function cityTaxLocationLabel(rate: number): string {
  if (rate === 0.07) return '市区';
  if (rate === 0.05) return '县城、镇';
  if (rate === 0.01) return '市区、县城、镇以外';
  return '非标准税率（' + formatRate(rate) + '）';
}
