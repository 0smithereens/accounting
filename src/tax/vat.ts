/**
 * 增值税计算（一般纳税人 / 小规模纳税人）。
 *
 * 为什么把「计算」和「取数」分开：
 *  本文件是纯函数，只接受已经按业务分类拆好的销售额与进项税额，
 *  不碰账簿、不读文件。这样每一档税率、每一次留抵结转都可以被单测精确覆盖，
 *  而「从凭证里认出哪笔是 13%、哪笔是 6%」这类脏活放在 compute.ts。
 *  一旦算错，责任边界清晰：是分类错了，还是公式错了。
 *
 * 监管约束：
 *  本模块只产出 TaxLine（申报表栏次草稿），不产出任何 filed 状态，
 *  也不调用任何税务接口。所有栏次都带 note 复述算式，可被复核人逐行验算。
 */

import type { Cents, LawBasis, Period, TaxLine, TaxpayerKind } from '../core/contracts.ts';
import { formatYuanGrouped, sumCents } from '../core/money.ts';

import type { TaxRates, VatCategory } from './rates.ts';
import {
  LAW_BASIS,
  VAT_CATEGORY_LABEL,
  VAT_STANDARD_RATES,
  defaultTaxRates,
  formatRate,
  isPolicyKeyEffective,
  roundRate,
} from './rates.ts';

/** 分 → 带千分位的元，用于计算说明。 */
function yuan(cents: Cents): string {
  return formatYuanGrouped(cents);
}

/* ================================================================== */
/* 一、输入输出结构                                                    */
/* ================================================================== */

/** 一笔（或一类）销项业务。 */
export interface VatSalesItem {
  /** 应税项目分类，决定默认税率 */
  category: VatCategory;
  /** 不含税销售额（分）。小规模纳税人请传价税分离后的不含税金额 */
  netAmount: Cents;
  /**
   * 覆盖默认税率。
   * 仅用于确实存在特殊口径的场景（如简易计税 5%），
   * 不传则按 category 查表，避免调用方随手写一个税率。
   */
  rate?: number;
  /** 业务说明，如客户名、合同号，会出现在栏次说明里便于核对 */
  label?: string;
}

/** 一笔（或一类）进项业务。 */
export interface VatPurchaseItem {
  /** 可抵扣进项税额（分） */
  inputTax: Cents;
  category?: VatCategory;
  label?: string;
  /** 是否已认证并用于本期抵扣，默认 true */
  deductible?: boolean;
}

/** 增值税计算输入。 */
export interface VatComputeInput {
  period: Period;
  /** 纳税人身份：一般纳税人 / 小规模纳税人 */
  kind: TaxpayerKind;
  /** 销项明细（必须按业务分类拆分，禁止一刀切） */
  sales: readonly VatSalesItem[];
  /** 进项明细（小规模纳税人不参与抵扣，传了也会被忽略并给出说明） */
  purchases?: readonly VatPurchaseItem[];
  /** 期初留抵税额（分，正数） */
  creditCarryforward?: Cents;
  /** 小规模纳税人是否按季申报（决定 30 万门槛） */
  quarterly?: boolean;
  /**
   * 小规模纳税人的含税销售额合计（分）。
   * 仅当 sales 为空、或需要按含税口径反算不含税销售额时使用。
   */
  grossSales?: Cents;
  /**
   * 加计抵减率（0 表示不享受），缺省 0。
   *
   * 加计抵减是「资格型优惠」：只有生产性/生活性服务业纳税人（四项服务销售额
   * 占比超过 50%）才适用。因此必须由调用方判断资格后显式传入，
   * 绝不能因为配置文件里写了 5% 就默认所有一般纳税人一起享受 —— 那是多抵税。
   */
  additionalDeductionRate?: number;
  /** 进项税额转出（分，正数） */
  inputTransferOut?: Cents;
  /** 本期已预缴税额（分） */
  prepaid?: Cents;
}

/** 同一税率档的销项汇总。 */
export interface VatRateGroup {
  category: VatCategory;
  label: string;
  rate: number;
  /** 不含税销售额（分） */
  netAmount: Cents;
  /** 销项税额（分） */
  outputTax: Cents;
}

/** 增值税计算结果。 */
export interface VatComputeResult {
  lines: TaxLine[];
  /** 销项税额合计（分） */
  outputTax: Cents;
  /** 进项税额合计（分） */
  inputTax: Cents;
  /** 进项税额转出（分） */
  inputTransferOut: Cents;
  /** 期初留抵（分） */
  creditCarryforwardOpening: Cents;
  /** 期末留抵（分），可结转下期 */
  creditCarryforwardClosing: Cents;
  /** 加计抵减额（分，实际抵减的部分） */
  additionalDeduction: Cents;
  /** 本期应纳税额（分） */
  payable: Cents;
  /** 本期已预缴（分） */
  prepaid: Cents;
  /** 本期应补(退)税额（分） */
  due: Cents;
  /** 是否享受小规模免税 */
  exempt: boolean;
  /** 不含税销售额合计（分） */
  taxExclusiveSales: Cents;
  /** 按税率档汇总的销项 */
  byRate: VatRateGroup[];
  /** 计算说明，逐条可复核 */
  notes: string[];
}

/* ================================================================== */
/* 二、工具函数                                                        */
/* ================================================================== */

/** 取分类对应的默认税率（一般纳税人）。 */
export function vatRateForCategory(category: VatCategory, rates: TaxRates = defaultTaxRates()): number {
  return rates.vat.standard[category];
}

/** 税率 → 栏次编码后缀，如 0.13 → "13"、0 → "0"。 */
function rateCode(rate: number): string {
  return String(Math.round(rate * 1000) / 10).replace('.', '_');
}

/**
 * 把「实算税率」吸附到法定档位。
 *
 * 账簿里的销项税额常常带几分钱尾差（如 129,999.97 / 999,999.99），
 * 直接反算会得到 0.130000003 这种数，不能拿去判断档位。
 * 这里用 0.5 个百分点容差吸附，超出容差返回 null，由调用方决定是否人工处理，
 * 绝不「猜一个最接近的税率」蒙混过关。
 */
export function inferVatRate(netAmount: Cents, taxAmount: Cents): number | null {
  if (netAmount <= 0) return null;
  const implied = taxAmount / netAmount;
  let best: number | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const rate of VAT_STANDARD_RATES) {
    const diff = Math.abs(implied - rate);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = rate;
    }
  }
  return best !== null && bestDiff <= 0.005 ? best : null;
}

/** 按 (分类, 税率) 归并销项，输出顺序固定为税率从高到低，便于与申报表核对。 */
export function groupSalesByRate(
  sales: readonly VatSalesItem[],
  rates: TaxRates = defaultTaxRates(),
): VatRateGroup[] {
  const buckets = new Map<string, VatRateGroup>();
  for (const item of sales) {
    const rate = item.rate === undefined ? rates.vat.standard[item.category] : item.rate;
    const key = item.category + '@' + rate;
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, {
        category: item.category,
        label: VAT_CATEGORY_LABEL[item.category],
        rate,
        netAmount: item.netAmount,
        outputTax: roundRate(item.netAmount, rate),
      });
    } else {
      existing.netAmount += item.netAmount;
      existing.outputTax += roundRate(item.netAmount, rate);
    }
  }
  const groups = [...buckets.values()];
  groups.sort((a, b) => (b.rate - a.rate) || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return groups;
}

/* ================================================================== */
/* 三、一般纳税人                                                      */
/* ================================================================== */

function computeGeneral(
  input: VatComputeInput,
  rates: TaxRates,
  notes: string[],
): VatComputeResult {
  const groups = groupSalesByRate(input.sales, rates);
  const outputTax = sumCents(groups.map((g) => g.outputTax));
  const taxExclusiveSales = sumCents(groups.map((g) => g.netAmount));

  let inputTax = 0;
  for (const item of input.purchases ?? []) {
    if (item.deductible === false) continue;
    if (item.inputTax < 0) {
      notes.push('进项明细「' + (item.label ?? '未命名') + '」金额为负数，已按 0 处理，请人工核对');
      continue;
    }
    inputTax += item.inputTax;
  }

  const inputTransferOut = Math.max(0, input.inputTransferOut ?? 0);
  const openingCredit = Math.max(0, input.creditCarryforward ?? 0);
  const prepaid = Math.max(0, input.prepaid ?? 0);

  // 应抵扣税额合计 = 进项税额 - 进项税额转出 + 上期留抵
  const deductibleTotal = inputTax - inputTransferOut;
  const creditAvailable = Math.max(0, openingCredit + deductibleTotal);
  const actualDeducted = Math.min(creditAvailable, outputTax);
  const payableBeforeAdditional = outputTax - actualDeducted;
  const closingCredit = creditAvailable - actualDeducted;

  // 加计抵减：只抵减应纳税额，不得增加留抵。未显式传入视为不享受（资格型优惠）
  let additionalDeduction = 0;
  const additionalRate = input.additionalDeductionRate ?? 0;
  if (additionalRate > 0 && isPolicyKeyEffective(input.period, 'vatAdditionalDeduction')) {
    const provision = roundRate(Math.max(0, deductibleTotal), additionalRate);
    const applied = Math.min(provision, payableBeforeAdditional);
    additionalDeduction = applied;
    if (provision > applied) {
      notes.push(
        '本期计提加计抵减额 ' + yuan(provision) + ' 元，应纳税额不足抵减，实际抵减 ' +
          yuan(applied) + ' 元，未抵减的 ' + yuan(provision - applied) + ' 元结转下期继续抵减',
      );
    }
  }
  const payable = payableBeforeAdditional - additionalDeduction;

  const lines: TaxLine[] = [];

  for (const group of groups) {
    lines.push({
      code: '1-' + rateCode(group.rate),
      label: '按' + formatRate(group.rate) + '税率计税销售额（' + group.label + '）',
      amount: group.netAmount,
      rate: group.rate,
      note: '不含税销售额 ' + yuan(group.netAmount) + ' 元，适用税率 ' + formatRate(group.rate),
      basis: [LAW_BASIS.vatLaw],
    });
  }

  // 合计销售额单独一栏：审核层按「销售额 × 税率 = 销项税额」勾稽时，
  // 兼营企业必须拿到合计口径，否则只会拿第一档销售额去比总销项，必然误报。
  const singleRate = groups.length === 1 ? groups[0]?.rate : undefined;
  lines.push({
    code: 'sales_amount',
    label: '按适用税率计税销售额合计',
    amount: taxExclusiveSales,
    rate: singleRate,
    note:
      '按适用税率计税销售额合计 = ' +
      (groups.length === 0 ? '0' : groups.map((g) => yuan(g.netAmount)).join(' + ')) +
      ' = ' + yuan(taxExclusiveSales) + ' 元' +
      (groups.length > 1 ? '（兼营多税率，合计栏不单独适用某一税率）' : ''),
    basis: [LAW_BASIS.vatLaw],
  });

  lines.push({
    code: '11',
    label: '销项税额',
    amount: outputTax,
    note:
      '销项税额 = Σ(不含税销售额 × 税率)：' +
      (groups.length === 0
        ? '本期无应税销售'
        : groups
            .map((g) => formatRate(g.rate) + ' 档 ' + yuan(g.netAmount) + ' × ' + formatRate(g.rate) + ' = ' + yuan(g.outputTax))
            .join('；')) +
      '；合计 ' + yuan(outputTax) + ' 元（逐档四舍五入到分后相加）',
    basis: [LAW_BASIS.vatLaw],
  });

  lines.push({
    code: '12',
    label: '进项税额',
    amount: inputTax,
    note: '进项税额 = Σ(已认证抵扣的进项税额) = ' + yuan(inputTax) + ' 元',
    basis: [LAW_BASIS.vatLaw],
  });

  lines.push({
    code: '13',
    label: '进项税额转出',
    amount: inputTransferOut,
    note: '进项税额转出 ' + yuan(inputTransferOut) + ' 元（用于非应税项目、免税项目、集体福利等不得抵扣情形）',
    basis: [LAW_BASIS.vatLaw],
  });

  lines.push({
    code: '17',
    label: '应抵扣税额合计',
    amount: creditAvailable,
    note:
      '应抵扣税额合计 = 进项税额 ' + yuan(inputTax) + ' - 进项税额转出 ' + yuan(inputTransferOut) +
      ' + 期初留抵 ' + yuan(openingCredit) + ' = ' + yuan(creditAvailable) + ' 元',
    basis: [LAW_BASIS.vatLaw],
  });

  lines.push({
    code: '18',
    label: '实际抵扣税额',
    amount: actualDeducted,
    note:
      '实际抵扣税额 = min(应抵扣税额合计 ' + yuan(creditAvailable) + ', 销项税额 ' + yuan(outputTax) +
      ') = ' + yuan(actualDeducted) + ' 元',
    basis: [LAW_BASIS.vatLaw],
  });

  if (additionalDeduction > 0) {
    lines.push({
      code: '19-D',
      label: '加计抵减额',
      amount: additionalDeduction,
      rate: additionalRate,
      note:
        '加计抵减额 = 当期可抵扣进项税额 ' + yuan(Math.max(0, deductibleTotal)) + ' × ' +
        formatRate(additionalRate) + ' = ' + yuan(roundRate(Math.max(0, deductibleTotal), additionalRate)) +
        ' 元，本期实际抵减 ' + yuan(additionalDeduction) + ' 元（不得抵减留抵）',
      basis: [LAW_BASIS.vatAdditionalDeduction],
    });
  }

  lines.push({
    code: '19',
    label: '应纳税额',
    amount: payable,
    note:
      '应纳税额 = 销项税额 ' + yuan(outputTax) + ' - 实际抵扣税额 ' + yuan(actualDeducted) +
      (additionalDeduction > 0 ? ' - 加计抵减额 ' + yuan(additionalDeduction) : '') +
      ' = ' + yuan(payable) + ' 元',
    basis: [LAW_BASIS.vatLaw],
  });

  if (additionalDeduction > 0) {
    lines.push({
      code: 'tax_reduction',
      label: '减免税额（增值税加计抵减）',
      amount: additionalDeduction,
      note:
        '本表因加计抵减优惠少缴增值税 ' + yuan(additionalDeduction) + ' 元；' +
        '该金额已体现在应纳税额栏，此处单独列示以便审核层与优惠台账核对',
      basis: [LAW_BASIS.vatAdditionalDeduction],
    });
  }

  lines.push({
    code: '20',
    label: '期末留抵税额',
    amount: closingCredit,
    note:
      '期末留抵税额 = 应抵扣税额合计 ' + yuan(creditAvailable) + ' - 实际抵扣税额 ' +
      yuan(actualDeducted) + ' = ' + yuan(closingCredit) + ' 元，结转下期继续抵扣',
    basis: [LAW_BASIS.vatLaw],
  });

  lines.push({
    code: '24',
    label: '应纳税额合计',
    amount: payable,
    note: '应纳税额合计 = 一般计税方法应纳税额 ' + yuan(payable) + ' 元',
    basis: [LAW_BASIS.vatLaw],
  });

  lines.push({
    code: '25',
    label: '本期应补(退)税额',
    amount: payable - prepaid,
    note:
      '本期应补(退)税额 = 应纳税额合计 ' + yuan(payable) + ' - 本期已预缴 ' + yuan(prepaid) +
      ' = ' + yuan(payable - prepaid) + ' 元',
    basis: [LAW_BASIS.taxCollectionLaw],
  });

  if (closingCredit > 0) {
    notes.push('本期形成期末留抵 ' + yuan(closingCredit) + ' 元，未实际缴税，附加税费不得据此计提');
  }
  if (outputTax === 0 && inputTax === 0) {
    notes.push('本期无销项、无进项，属零申报，请确认是否确实无经营业务');
  }

  return {
    lines,
    outputTax,
    inputTax,
    inputTransferOut,
    creditCarryforwardOpening: openingCredit,
    creditCarryforwardClosing: closingCredit,
    additionalDeduction,
    payable,
    prepaid,
    due: payable - prepaid,
    exempt: false,
    taxExclusiveSales,
    byRate: groups,
    notes,
  };
}

/* ================================================================== */
/* 四、小规模纳税人                                                    */
/* ================================================================== */

function computeSmallScale(
  input: VatComputeInput,
  rates: TaxRates,
  notes: string[],
): VatComputeResult {
  const quarterly = input.quarterly === true;
  const threshold = quarterly ? rates.vat.exemptQuarterlyThreshold : rates.vat.exemptMonthlyThreshold;
  const reduced = isPolicyKeyEffective(input.period, 'smallScaleReduction');
  const levyRate = reduced ? rates.vat.smallScaleReduced : rates.vat.smallScale;
  const fullRate = rates.vat.smallScale;

  // 不含税销售额：优先用明细，其次用含税总额按征收率反算
  let taxExclusiveSales = sumCents(input.sales.map((s) => s.netAmount));
  if (taxExclusiveSales === 0 && (input.grossSales ?? 0) > 0) {
    const gross = input.grossSales ?? 0;
    taxExclusiveSales = Math.round(gross / (1 + levyRate));
    notes.push(
      '含税销售额 ' + yuan(gross) + ' 元按征收率 ' + formatRate(levyRate) + ' 反算：' +
        yuan(gross) + ' ÷ (1 + ' + formatRate(levyRate) + ') = ' + yuan(taxExclusiveSales) + ' 元（四舍五入到分）',
    );
  }
  if (input.grossSales !== undefined && input.grossSales > 0 && input.sales.length > 0) {
    notes.push('已提供销项明细，grossSales 仅作参考，未参与计算');
  }
  if ((input.purchases ?? []).length > 0) {
    notes.push('小规模纳税人不得抵扣进项税额，已忽略传入的进项明细');
  }

  const exempt = taxExclusiveSales > 0 && taxExclusiveSales <= threshold;
  const lines: TaxLine[] = [];

  lines.push({
    code: '1',
    label: '应征增值税不含税销售额（' + formatRate(levyRate) + '征收率）',
    amount: taxExclusiveSales,
    rate: levyRate,
    note:
      '不含税销售额 ' + yuan(taxExclusiveSales) + ' 元；' +
      (quarterly ? '按季申报，免征门槛 ' : '按月申报，免征门槛 ') + yuan(threshold) + ' 元',
    basis: [LAW_BASIS.vatSmallScale19],
  });

  if (exempt) {
    lines.push({
      code: '9',
      label: '免税销售额',
      amount: taxExclusiveSales,
      note:
        '不含税销售额 ' + yuan(taxExclusiveSales) + ' 元 ≤ 免征门槛 ' + yuan(threshold) +
        ' 元，符合财政部 税务总局公告2023年第19号第一条，免征增值税',
      basis: [LAW_BASIS.vatSmallScale19],
    });
  }

  const fullTax = exempt ? 0 : roundRate(taxExclusiveSales, fullRate);
  const reducedTax = exempt ? 0 : roundRate(taxExclusiveSales, levyRate);
  const reduction = exempt ? 0 : fullTax - reducedTax;

  lines.push({
    code: '15',
    label: '本期应纳税额',
    amount: fullTax,
    rate: fullRate,
    note: exempt
      ? '免税，本期应纳税额为 0'
      : '本期应纳税额 = 不含税销售额 ' + yuan(taxExclusiveSales) + ' × ' + formatRate(fullRate) +
        ' = ' + yuan(fullTax) + ' 元',
    basis: [LAW_BASIS.vatSmallScale19],
  });

  if (!exempt && reduction !== 0) {
    lines.push({
      code: '16',
      label: '本期应纳税额减征额',
      amount: reduction,
      rate: fullRate - levyRate,
      note:
        '本期应纳税额减征额 = 按 ' + formatRate(fullRate) + ' 计算 ' + yuan(fullTax) +
        ' - 按 ' + formatRate(levyRate) + ' 计算 ' + yuan(reducedTax) + ' = ' + yuan(reduction) +
        ' 元（财政部 税务总局公告2023年第19号第二条，减按' + formatRate(levyRate) + '征收）',
      basis: [LAW_BASIS.vatSmallScale19],
    });
  }

  const payable = exempt ? 0 : reducedTax;
  const prepaid = Math.max(0, input.prepaid ?? 0);

  if (!exempt && reduction !== 0) {
    lines.push({
      code: 'tax_reduction',
      label: '减免税额（小规模减按' + formatRate(levyRate) + '征收率）',
      amount: reduction,
      note:
        '本表因小规模纳税人减按征收率优惠少缴增值税 ' + yuan(reduction) +
        ' 元（按 ' + formatRate(fullRate) + ' 应纳 ' + yuan(fullTax) + ' 元 - 按 ' +
        formatRate(levyRate) + ' 应纳 ' + yuan(reducedTax) + ' 元），已体现在应纳税额栏',
      basis: [LAW_BASIS.vatSmallScale19],
    });
  }

  lines.push({
    code: '19',
    label: '应纳税额',
    amount: payable,
    rate: levyRate,
    note: exempt
      ? '免税，应纳税额为 0'
      : '应纳税额 = 本期应纳税额 ' + yuan(fullTax) + ' - 减征额 ' + yuan(reduction) + ' = ' +
        yuan(payable) + ' 元（等价于 ' + yuan(taxExclusiveSales) + ' × ' + formatRate(levyRate) + '）',
    basis: [LAW_BASIS.vatSmallScale19],
  });

  lines.push({
    code: '20',
    label: '期末留抵税额',
    amount: 0,
    note: '小规模纳税人不适用进项税额抵扣，期末留抵税额恒为 0',
    basis: [LAW_BASIS.vatLaw],
  });

  lines.push({
    code: '25',
    label: '本期应补(退)税额',
    amount: payable - prepaid,
    note:
      '本期应补(退)税额 = 应纳税额 ' + yuan(payable) + ' - 本期已预缴 ' + yuan(prepaid) +
      ' = ' + yuan(payable - prepaid) + ' 元',
    basis: [LAW_BASIS.taxCollectionLaw],
  });

  if (exempt) {
    notes.push(
      '本期销售额 ' + yuan(taxExclusiveSales) + ' 元未超过免征门槛 ' + yuan(threshold) +
        ' 元，免征增值税；对应附加税费的计征依据为 0',
    );
  }
  if (!reduced) {
    notes.push('当前期间不在小规模纳税人减按1%征收率政策窗口（2023-01-01 至 2027-12-31）内，按法定征收率 3% 计算');
  }

  const byRate: VatRateGroup[] = exempt || taxExclusiveSales === 0
    ? []
    : [
        {
          category: reduced ? 'small_scale_1' : 'small_scale_3',
          label: reduced ? VAT_CATEGORY_LABEL.small_scale_1 : VAT_CATEGORY_LABEL.small_scale_3,
          rate: levyRate,
          netAmount: taxExclusiveSales,
          outputTax: payable,
        },
      ];

  return {
    lines,
    outputTax: payable,
    inputTax: 0,
    inputTransferOut: 0,
    creditCarryforwardOpening: 0,
    creditCarryforwardClosing: 0,
    additionalDeduction: 0,
    payable,
    prepaid,
    due: payable - prepaid,
    exempt,
    taxExclusiveSales,
    byRate,
    notes,
  };
}

/* ================================================================== */
/* 五、入口                                                            */
/* ================================================================== */

/**
 * 计算增值税。
 *
 * 一般纳税人：应纳税额 = 销项税额 - 实际抵扣税额（含期初留抵），
 *   结果为正才是应纳税额，为负则形成期末留抵结转下期。
 * 小规模纳税人：按征收率计算，月/季销售额未达门槛免征。
 *
 * @param input 已按业务分类拆好的销项、进项数据
 * @param rates 税率表，缺省用代码内置默认值
 */
export function computeVat(input: VatComputeInput, rates: TaxRates = defaultTaxRates()): VatComputeResult {
  const notes: string[] = [];
  if (input.kind === 'small_scale') {
    return computeSmallScale(input, rates, notes);
  }
  return computeGeneral(input, rates, notes);
}

/** 判断一组销项是否全部适用零税率（用于风险扫描识别「有收入无销项」）。 */
export function isZeroRatedSales(
  sales: readonly VatSalesItem[],
  rates: TaxRates = defaultTaxRates(),
): boolean {
  if (sales.length === 0) return false;
  return sales.every((s) => (s.rate ?? rates.vat.standard[s.category]) === 0);
}

/** 增值税结果的法规依据汇总，供申报表整体引用。 */
export function vatBasis(): LawBasis[] {
  return [LAW_BASIS.vatLaw, LAW_BASIS.vatSmallScale19];
}
