/**
 * 个人所得税：工资薪金累计预扣法。
 *
 * 为什么必须用「累计预扣法」而不是「按月单独算」：
 *  工资薪金属于综合所得，年度内各月收入合并适用超额累进税率。
 *  如果按月单独套税率表，1 月发了年终奖就会直接跳到 45% 档，
 *  而全年算下来可能只有 20% —— 多扣的钱要等到次年汇算才退得回来。
 *  累计预扣法把「累计应纳税所得额」当作计税基础，再用「累计应纳税额 -
 *  已预扣」倒推本月应扣，保证全年预扣总额与汇算结果基本一致。
 *
 * 公式（国家税务总局公告2018年第61号第六条）：
 *   累计预扣预缴应纳税所得额
 *     = 累计收入 - 累计免税收入 - 累计减除费用 - 累计专项扣除
 *       - 累计专项附加扣除 - 累计依法确定的其他扣除
 *   本期应预扣预缴税额
 *     = (累计应纳税所得额 × 预扣率 - 速算扣除数) - 累计减免税额
 *       - 累计已预扣预缴税额
 */

import type { Cents, Period, TaxLine } from '../core/contracts.ts';
import { formatYuanGrouped } from '../core/money.ts';

import type { IitBracket, TaxRates } from './rates.ts';
import {
  LAW_BASIS,
  defaultTaxRates,
  formatRate,
  iitBracketOf,
  roundRate,
} from './rates.ts';

function yuan(cents: Cents): string {
  return formatYuanGrouped(cents);
}

/** 个人所得税累计预扣输入。 */
export interface IitCumulativeInput {
  /** 会计期间 YYYY-MM，用于校验月份数与申报期一致 */
  period?: Period;
  /** 累计收入额（分），即截至本月的工资薪金收入合计 */
  cumulativeIncome: Cents;
  /** 累计免税收入（分），如独生子女补贴、托儿补助费等 */
  cumulativeTaxFreeIncome?: Cents;
  /** 累计专项扣除（分），即三险一金个人承担部分 */
  cumulativeSpecialDeduction?: Cents;
  /** 累计专项附加扣除（分），子女教育、赡养老人等七项 */
  cumulativeAdditionalDeduction?: Cents;
  /** 累计依法确定的其他扣除（分），如企业年金、商业健康险 */
  cumulativeOtherDeduction?: Cents;
  /** 累计减免税额（分），如残疾人员工减征 */
  cumulativeTaxRelief?: Cents;
  /** 累计已预扣预缴税额（分） */
  taxWithheldYtd?: Cents;
  /** 已计税月份数（1-12），减除费用 = 5000 × 月数 */
  monthsElapsed: number;
}

/** 个人所得税累计预扣结果。 */
export interface IitComputeResult {
  lines: TaxLine[];
  /** 已计税月份数 */
  monthsElapsed: number;
  /** 累计减除费用（分） */
  cumulativeBasicDeduction: Cents;
  /** 累计扣除项目合计（分） */
  cumulativeDeductionTotal: Cents;
  /** 累计预扣预缴应纳税所得额（分） */
  cumulativeTaxableIncome: Cents;
  /** 适用预扣率级距 */
  bracket: IitBracket;
  /** 累计应预扣预缴税额（分，未扣减减免税额） */
  cumulativeTax: Cents;
  /** 累计减免税额（分） */
  cumulativeTaxRelief: Cents;
  /** 累计已预扣预缴税额（分） */
  taxWithheldYtd: Cents;
  /** 本期应预扣预缴税额（分） */
  currentWithholding: Cents;
  /** 实际税负（本期应预扣 / 累计收入） */
  effectiveRate: number;
  notes: string[];
}

/** 累计减除费用 = 5000 元 × 已计税月份数。 */
export function monthlyBasicDeduction(monthsElapsed: number, rates: TaxRates = defaultTaxRates()): Cents {
  const months = clampMonths(monthsElapsed);
  return rates.iit.basicDeductionMonthly * months;
}

function clampMonths(monthsElapsed: number): number {
  if (!Number.isFinite(monthsElapsed)) return 1;
  const n = Math.trunc(monthsElapsed);
  if (n < 1) return 1;
  if (n > 12) return 12;
  return n;
}

/**
 * 计算工资薪金本期应预扣预缴税额。
 *
 * 边界处理（都是实务里真会遇到的）：
 *  - 累计应纳税所得额 ≤ 0：不预扣，且不能出现负数税额；
 *  - 本期算出来是负数（前期多扣了）：本月按 0 预扣，多扣部分留待年度汇算退税，
 *    系统绝不自动「倒扣」工资；
 *  - 月份数超过 12 或小于 1：夹取到 1-12，避免把 13 个月的减除费用算进去。
 *
 * @param input 累计口径的六项扣除与已预扣税额
 * @param rates 税率表
 */
export function computeIitCumulative(
  input: IitCumulativeInput,
  rates: TaxRates = defaultTaxRates(),
): IitComputeResult {
  const notes: string[] = [];
  const months = clampMonths(input.monthsElapsed);
  if (months !== input.monthsElapsed) {
    notes.push('已计税月份数 ' + input.monthsElapsed + ' 不在 1-12 范围内，已按 ' + months + ' 个月计算');
  }
  if (input.period !== undefined && /^\d{4}-\d{2}$/.test(input.period)) {
    const periodMonth = Number(input.period.slice(5, 7));
    if (periodMonth !== months) {
      notes.push(
        '会计期间 ' + input.period + ' 对应第 ' + periodMonth + ' 个月，但传入的已计税月份数为 ' +
          months + '，请确认累计数口径是否正确',
      );
    }
  }

  const income = Math.max(0, input.cumulativeIncome);
  const taxFree = Math.max(0, input.cumulativeTaxFreeIncome ?? 0);
  const special = Math.max(0, input.cumulativeSpecialDeduction ?? 0);
  const additional = Math.max(0, input.cumulativeAdditionalDeduction ?? 0);
  const other = Math.max(0, input.cumulativeOtherDeduction ?? 0);
  const relief = Math.max(0, input.cumulativeTaxRelief ?? 0);
  const withheld = Math.max(0, input.taxWithheldYtd ?? 0);

  const basic = monthlyBasicDeduction(months, rates);
  const deductionTotal = taxFree + basic + special + additional + other;
  const taxable = Math.max(0, income - deductionTotal);

  const bracket = iitBracketOf(taxable);
  let cumulativeTax = 0;
  if (taxable > 0) {
    cumulativeTax = roundRate(taxable, bracket.rate) - bracket.quickDeduction;
    if (cumulativeTax < 0) cumulativeTax = 0;
  }

  const cumulativeAfterRelief = Math.max(0, cumulativeTax - relief);
  let current = cumulativeAfterRelief - withheld;
  if (current < 0) {
    notes.push(
      '按累计预扣法计算本期应预扣 ' + yuan(current) + ' 元（负数），本月按 0 预扣，' +
        '多预扣的 ' + yuan(-current) + ' 元由纳税人在次年办理综合所得汇算清缴时申请退税',
    );
    current = 0;
  }
  if (taxable <= 0) {
    notes.push('累计预扣预缴应纳税所得额为 0，本期不预扣个人所得税');
  }

  const lines: TaxLine[] = [
    {
      code: 'IIT-1',
      label: '累计收入额',
      amount: income,
      note: '截至本月工资薪金累计收入 ' + yuan(income) + ' 元',
      basis: [LAW_BASIS.iitWithholding61],
    },
    {
      code: 'IIT-2',
      label: '累计免税收入',
      amount: taxFree,
      note: '累计免税收入 ' + yuan(taxFree) + ' 元',
      basis: [LAW_BASIS.iitLaw],
    },
    {
      code: 'IIT-3',
      label: '累计减除费用',
      amount: basic,
      note:
        '累计减除费用 = 每月 ' + yuan(rates.iit.basicDeductionMonthly) + ' 元 × ' + months +
        ' 个月 = ' + yuan(basic) + ' 元',
      basis: [LAW_BASIS.iitLaw, LAW_BASIS.iitWithholding61],
    },
    {
      code: 'IIT-4',
      label: '累计专项扣除',
      amount: special,
      note: '累计专项扣除（三险一金个人部分）' + yuan(special) + ' 元',
      basis: [LAW_BASIS.iitLaw],
    },
    {
      code: 'IIT-5',
      label: '累计专项附加扣除',
      amount: additional,
      note: '累计专项附加扣除 ' + yuan(additional) + ' 元（子女教育、继续教育、大病医疗、住房贷款利息、住房租金、赡养老人、婴幼儿照护）',
      basis: [LAW_BASIS.iitSpecialAdditional],
    },
    {
      code: 'IIT-6',
      label: '累计依法确定的其他扣除',
      amount: other,
      note: '累计其他扣除 ' + yuan(other) + ' 元（企业年金、商业健康保险、个人养老金等）',
      basis: [LAW_BASIS.iitLaw],
    },
    {
      code: 'IIT-7',
      label: '累计预扣预缴应纳税所得额',
      amount: taxable,
      note:
        '累计应纳税所得额 = 累计收入 ' + yuan(income) + ' - 累计免税收入 ' + yuan(taxFree) +
        ' - 累计减除费用 ' + yuan(basic) + ' - 累计专项扣除 ' + yuan(special) +
        ' - 累计专项附加扣除 ' + yuan(additional) + ' - 累计其他扣除 ' + yuan(other) +
        ' = ' + yuan(taxable) + ' 元（负数按 0 处理）',
      basis: [LAW_BASIS.iitWithholding61],
    },
    {
      code: 'IIT-8',
      label: '预扣率',
      amount: taxable,
      rate: bracket.rate,
      note:
        '累计应纳税所得额 ' + yuan(taxable) + ' 元落在第 ' + bracket.level + ' 级，适用预扣率 ' +
        formatRate(bracket.rate) + '，速算扣除数 ' + yuan(bracket.quickDeduction) + ' 元',
      basis: [LAW_BASIS.iitLaw],
    },
    {
      code: 'IIT-9',
      label: '速算扣除数',
      amount: bracket.quickDeduction,
      note: '第 ' + bracket.level + ' 级速算扣除数 ' + yuan(bracket.quickDeduction) + ' 元',
      basis: [LAW_BASIS.iitLaw],
    },
    {
      code: 'IIT-10',
      label: '累计应预扣预缴税额',
      amount: cumulativeTax,
      note:
        '累计应预扣预缴税额 = 累计应纳税所得额 ' + yuan(taxable) + ' × ' + formatRate(bracket.rate) +
        ' - 速算扣除数 ' + yuan(bracket.quickDeduction) + ' = ' + yuan(cumulativeTax) + ' 元',
      basis: [LAW_BASIS.iitWithholding61],
    },
    {
      code: 'IIT-11',
      label: '累计减免税额',
      amount: relief,
      note: '累计减免税额 ' + yuan(relief) + ' 元',
      basis: [LAW_BASIS.iitLaw],
    },
    {
      code: 'IIT-12',
      label: '累计已预扣预缴税额',
      amount: withheld,
      note: '截至上月累计已预扣预缴 ' + yuan(withheld) + ' 元',
      basis: [LAW_BASIS.iitWithholding61],
    },
    {
      code: 'IIT-13',
      label: '本期应预扣预缴税额',
      amount: current,
      note:
        '本期应预扣预缴税额 = 累计应预扣预缴税额 ' + yuan(cumulativeTax) + ' - 累计减免税额 ' +
        yuan(relief) + ' - 累计已预扣预缴税额 ' + yuan(withheld) + ' = ' + yuan(current) + ' 元',
      basis: [LAW_BASIS.iitWithholding61, LAW_BASIS.taxCollectionLaw],
    },
  ];

  const effectiveRate = income > 0 ? current / income : 0;

  return {
    lines,
    monthsElapsed: months,
    cumulativeBasicDeduction: basic,
    cumulativeDeductionTotal: deductionTotal,
    cumulativeTaxableIncome: taxable,
    bracket,
    cumulativeTax,
    cumulativeTaxRelief: relief,
    taxWithheldYtd: withheld,
    currentWithholding: current,
    effectiveRate,
    notes,
  };
}

/**
 * 按「月均推算」把单月工资扩展为累计口径。
 *
 * 为什么需要它：账簿里只有本月工资总额，而累计预扣法需要「年初至今累计数」。
 * 在拿不到逐月工资台账时，按月均推算是最不坏的近似；但必须把假设写进 note，
 * 并要求复核人用个税扣缴客户端的累计数覆盖，否则算出来的税额只能作参考。
 */
export function projectCumulativeByAverage(
  monthlyIncome: Cents,
  monthlySpecialDeduction: Cents,
  monthsElapsed: number,
): { cumulativeIncome: Cents; cumulativeSpecialDeduction: Cents } {
  const months = clampMonths(monthsElapsed);
  return {
    cumulativeIncome: monthlyIncome * months,
    cumulativeSpecialDeduction: monthlySpecialDeduction * months,
  };
}
