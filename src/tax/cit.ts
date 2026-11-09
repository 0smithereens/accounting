/**
 * 企业所得税：季度预缴 + 年度汇算纳税调整。
 *
 * 为什么预缴与汇算放在同一个文件：
 *  两者的「应纳税所得额」口径不同（预缴按会计实际利润额，汇算按税法调整后所得），
 *  但税率判定、小微资格、减免税额的计算规则完全一致。放在一起可以保证
 *  「预缴时按小微 5%，汇算时却按 25%」这种口径漂移不会发生。
 *
 * 监管约束：
 *  每一个纳税调整项都带 basis（法规名称 + 条款）与可复算的 reason，
 *  复核人可以逐项验算「为什么调增这么多」。系统不替企业做职业判断，
 *  只把「按限额算出来的差额」摆出来，最终由人签署。
 */

import type { Cents, LawBasis, Period, TaxAdjustment, TaxLine } from '../core/contracts.ts';
import { formatYuanGrouped } from '../core/money.ts';

import type { TaxRates } from './rates.ts';
import {
  LAW_BASIS,
  defaultTaxRates,
  formatRate,
  isPolicyKeyEffective,
  roundRate,
} from './rates.ts';

function yuan(cents: Cents): string {
  return formatYuanGrouped(cents);
}

/* ================================================================== */
/* 一、输入输出结构                                                    */
/* ================================================================== */

/**
 * 汇算清缴需要的费用明细。
 *
 * 为什么不让调用方直接传「调增金额」：
 *  限额类调整（招待费、广告费、福利费）的答案取决于「发生额 + 基数」两个数，
 *  由系统按法条算出来，才能保证换一个会计、换一个月重算结果一致。
 *  调用方只负责提供事实（发生了多少），不负责提供结论（该调多少）。
 */
export interface CitExpenseDetail {
  /** 业务招待费发生额（分） */
  businessEntertainment?: Cents;
  /** 广告费和业务宣传费发生额（分） */
  advertising?: Cents;
  /** 工资薪金总额（分），作为福利费/教育经费/工会经费的计算基数 */
  wages?: Cents;
  /** 职工福利费发生额（分） */
  welfare?: Cents;
  /** 职工教育经费发生额（分） */
  education?: Cents;
  /** 工会经费发生额（分） */
  unionFee?: Cents;
  /** 公益性捐赠发生额（分） */
  donation?: Cents;
  /** 罚款、罚金、税收滞纳金（分），全额不得扣除 */
  fines?: Cents;
  /** 利息支出实际发生额（分） */
  interestExpense?: Cents;
  /** 按金融企业同期同类贷款利率计算的允许扣除额（分） */
  interestAllowed?: Cents;
  /** 研发费用发生额（分） */
  rdExpense?: Cents;
  /** 以前年度结转的广告费（分） */
  advertisingCarryforward?: Cents;
}

/** 企业所得税计算输入。 */
export interface CitComputeInput {
  period: Period;
  /** 会计利润总额（分） */
  accountingProfit: Cents;
  /** 营业收入（分），作为招待费与广告费的限额基数 */
  revenue: Cents;
  /** 营业成本（分），仅用于申报表列示 */
  cost?: Cents;
  /** 是否小型微利企业（纳税人自行判定后传入，系统再做资格复核） */
  isSmallLowProfit: boolean;
  /** 是否高新技术企业 */
  isHighTech: boolean;
  /** 从业人数，用于复核小微资格 */
  employees?: number;
  /** 资产总额（分），用于复核小微资格 */
  totalAssets?: Cents;
  /** 研发费用（分），优先于 expenseDetail.rdExpense */
  rdExpense?: Cents;
  /** 费用明细 */
  expenseDetail?: CitExpenseDetail;
  /** 手工补充的调整项（不征税收入、资产减值准备等系统无法自动判断的项目） */
  manualAdjustments?: readonly TaxAdjustment[];
  /** 本年累计已预缴企业所得税（分） */
  prepaidYtd?: Cents;
  /** 是否年度汇算清缴；false 表示季度预缴 */
  annual: boolean;
  /** 以前年度可弥补亏损（分，正数） */
  lossCarryforward?: Cents;
}

/** 企业所得税计算结果。 */
export interface CitComputeResult {
  lines: TaxLine[];
  adjustments: TaxAdjustment[];
  /** 纳税调整增加额合计（分） */
  increaseTotal: Cents;
  /** 纳税调整减少额合计（分，不含研发加计） */
  decreaseTotal: Cents;
  /** 研发费用加计扣除额（分） */
  superDeduction: Cents;
  /** 应纳税所得额（分） */
  taxableIncome: Cents;
  /** 实际适用税率 */
  effectiveRate: number;
  /** 按法定税率 25% 计算的税额（分） */
  statutoryTax: Cents;
  /** 减免所得税额（分） */
  taxRelief: Cents;
  /** 实际应纳税额（分） */
  taxPayable: Cents;
  /** 已预缴（分） */
  prepaid: Cents;
  /** 应补(退)税额（分） */
  due: Cents;
  /** 广告费结转以后年度扣除额（分） */
  advertisingCarryforwardClosing: Cents;
  /** 是否实际按小型微利企业口径计税 */
  smallLowProfitApplied: boolean;
  notes: string[];
}

/** 纳税调整计算结果。 */
export interface CitAdjustmentResult {
  adjustments: TaxAdjustment[];
  increaseTotal: Cents;
  decreaseTotal: Cents;
  superDeduction: Cents;
  advertisingCarryforwardClosing: Cents;
  notes: string[];
}

/* ================================================================== */
/* 二、纳税调整                                                        */
/* ================================================================== */

/**
 * 按税法限额逐项计算纳税调整。
 *
 * 调整项覆盖：业务招待费、广告费和业务宣传费、职工福利费、职工教育经费、
 * 工会经费、公益性捐赠、罚款滞纳金、超标利息、研发费用加计扣除。
 * 每一项都写清「发生额 → 限额 → 差额」的三步算式。
 *
 * @param detail 费用发生额明细
 * @param revenue 营业收入（分）
 * @param accountingProfit 会计利润总额（分），作为公益性捐赠限额基数
 * @param period 会计期间，用于判断研发加计政策是否生效
 * @param rates 税率表
 */
export function computeCitAdjustments(
  detail: CitExpenseDetail,
  revenue: Cents,
  accountingProfit: Cents,
  period: Period,
  rates: TaxRates = defaultTaxRates(),
): CitAdjustmentResult {
  const adjustments: TaxAdjustment[] = [];
  const notes: string[] = [];
  const limits = rates.cit.limits;
  const salesBase = Math.max(0, revenue);

  /* ---------------- 1. 业务招待费：发生额 60% 与收入 5‰ 孰低 ---------------- */
  const entertainment = Math.max(0, detail.businessEntertainment ?? 0);
  if (entertainment > 0) {
    const byActual = roundRate(entertainment, limits.businessEntertainment);
    const byRevenue = roundRate(salesBase, limits.businessEntertainmentRevenue);
    const allowed = Math.min(byActual, byRevenue);
    const addBack = entertainment - allowed;
    if (addBack > 0) {
      adjustments.push({
        code: 'CIT-ADJ-ENTERTAIN',
        label: '业务招待费超标准调增',
        amount: addBack,
        reason:
          '发生额 ' + yuan(entertainment) + ' × 60% = ' + yuan(byActual) + ' 元；' +
          '销售（营业）收入 ' + yuan(salesBase) + ' × 5‰ = ' + yuan(byRevenue) + ' 元；' +
          '孰低可扣除 ' + yuan(allowed) + ' 元，调增 ' + yuan(addBack) + ' 元（四舍五入到分）',
        basis: [LAW_BASIS.citRegulation],
        source: '销售费用/管理费用-业务招待费',
      });
    }
  }

  /* ------------- 2. 广告费和业务宣传费：收入 15%，超支结转以后年度 ------------- */
  const advertising = Math.max(0, detail.advertising ?? 0);
  const advertisingCarry = Math.max(0, detail.advertisingCarryforward ?? 0);
  const advertisingLimit = roundRate(salesBase, limits.advertising);
  let advertisingCarryClosing = 0;
  if (advertising > advertisingLimit) {
    const addBack = advertising - advertisingLimit;
    advertisingCarryClosing = addBack + advertisingCarry;
    adjustments.push({
      code: 'CIT-ADJ-ADVERTISING',
      label: '广告费和业务宣传费超标准调增',
      amount: addBack,
      reason:
        '发生额 ' + yuan(advertising) + ' 超过销售（营业）收入 ' + yuan(salesBase) + ' × 15% = ' +
        yuan(advertisingLimit) + ' 元的限额，调增 ' + yuan(addBack) +
        ' 元，准予结转以后纳税年度扣除；加上以前年度结转 ' + yuan(advertisingCarry) +
        ' 元，期末结转 ' + yuan(advertisingCarryClosing) + ' 元',
      basis: [LAW_BASIS.citRegulation],
      source: '销售费用-广告宣传费',
    });
  } else if (advertisingCarry > 0) {
    const room = advertisingLimit - advertising;
    const deductedFromCarry = Math.min(advertisingCarry, room);
    advertisingCarryClosing = advertisingCarry - deductedFromCarry;
    if (deductedFromCarry > 0) {
      adjustments.push({
        code: 'CIT-ADJ-ADVERTISING-CARRY',
        label: '以前年度广告费结转扣除',
        amount: -deductedFromCarry,
        reason:
          '本期发生额 ' + yuan(advertising) + ' 元未用尽限额 ' + yuan(advertisingLimit) +
          ' 元，剩余限额 ' + yuan(room) + ' 元，扣除以前年度结转 ' + yuan(deductedFromCarry) +
          ' 元，期末尚可结转 ' + yuan(advertisingCarryClosing) + ' 元',
        basis: [LAW_BASIS.citRegulation],
        source: '以前年度结转的广告费和业务宣传费',
      });
    }
  }

  /* -------------------------- 3. 职工福利费 14% -------------------------- */
  const wages = Math.max(0, detail.wages ?? 0);
  const welfare = Math.max(0, detail.welfare ?? 0);
  if (welfare > 0) {
    const limit = roundRate(wages, limits.welfare);
    const addBack = welfare - limit;
    if (addBack > 0) {
      adjustments.push({
        code: 'CIT-ADJ-WELFARE',
        label: '职工福利费超标准调增',
        amount: addBack,
        reason:
          '发生额 ' + yuan(welfare) + ' 超过工资薪金总额 ' + yuan(wages) + ' × 14% = ' +
          yuan(limit) + ' 元的限额，调增 ' + yuan(addBack) + ' 元（超支部分不得结转）',
        basis: [LAW_BASIS.citRegulation],
        source: '应付职工薪酬-职工福利费',
      });
    }
  }

  /* ------------------------- 4. 职工教育经费 8% ------------------------- */
  const education = Math.max(0, detail.education ?? 0);
  if (education > 0) {
    const limit = roundRate(wages, limits.education);
    const addBack = education - limit;
    if (addBack > 0) {
      adjustments.push({
        code: 'CIT-ADJ-EDUCATION',
        label: '职工教育经费超标准调增',
        amount: addBack,
        reason:
          '发生额 ' + yuan(education) + ' 超过工资薪金总额 ' + yuan(wages) + ' × 8% = ' +
          yuan(limit) + ' 元的限额，调增 ' + yuan(addBack) + ' 元，超过部分准予结转以后纳税年度扣除',
        basis: [LAW_BASIS.citEducation51],
        source: '应付职工薪酬-职工教育经费',
      });
    }
  }

  /* --------------------------- 5. 工会经费 2% --------------------------- */
  const unionFee = Math.max(0, detail.unionFee ?? 0);
  if (unionFee > 0) {
    const limit = roundRate(wages, limits.union);
    const addBack = unionFee - limit;
    if (addBack > 0) {
      adjustments.push({
        code: 'CIT-ADJ-UNION',
        label: '工会经费超标准调增',
        amount: addBack,
        reason:
          '发生额 ' + yuan(unionFee) + ' 超过工资薪金总额 ' + yuan(wages) + ' × 2% = ' +
          yuan(limit) + ' 元的限额，调增 ' + yuan(addBack) + ' 元（须取得工会经费收入专用收据方可扣除）',
        basis: [LAW_BASIS.citRegulation],
        source: '应付职工薪酬-工会经费',
      });
    }
  }

  /* ------------------------ 6. 公益性捐赠 12% ------------------------ */
  const donation = Math.max(0, detail.donation ?? 0);
  if (donation > 0) {
    const limit = roundRate(Math.max(0, accountingProfit), limits.donation);
    const addBack = donation - limit;
    if (addBack > 0) {
      adjustments.push({
        code: 'CIT-ADJ-DONATION',
        label: '公益性捐赠超标准调增',
        amount: addBack,
        reason:
          '发生额 ' + yuan(donation) + ' 超过年度利润总额 ' + yuan(Math.max(0, accountingProfit)) +
          ' × 12% = ' + yuan(limit) + ' 元的限额，调增 ' + yuan(addBack) +
          ' 元，超过部分准予结转以后三年内在计算应纳税所得额时扣除',
        basis: [LAW_BASIS.citLaw],
        source: '营业外支出-公益性捐赠',
      });
    }
  }

  /* --------------------- 7. 罚款、罚金、滞纳金不得扣除 --------------------- */
  const fines = Math.max(0, detail.fines ?? 0);
  if (fines > 0) {
    adjustments.push({
      code: 'CIT-ADJ-FINES',
      label: '罚款、罚金及税收滞纳金调增',
      amount: fines,
      reason:
        '本期发生罚款、罚金及税收滞纳金 ' + yuan(fines) + ' 元，属于企业所得税法第十条列举的不得扣除支出，全额调增',
      basis: [LAW_BASIS.citLaw],
      source: '营业外支出-罚款/滞纳金',
    });
  }

  /* --------------------------- 8. 超标利息 --------------------------- */
  const interestExpense = Math.max(0, detail.interestExpense ?? 0);
  if (interestExpense > 0 && detail.interestAllowed !== undefined) {
    const allowed = Math.max(0, detail.interestAllowed);
    const addBack = interestExpense - allowed;
    if (addBack > 0) {
      adjustments.push({
        code: 'CIT-ADJ-INTEREST',
        label: '超标利息支出调增',
        amount: addBack,
        reason:
          '实际利息支出 ' + yuan(interestExpense) + ' 元，超过按金融企业同期同类贷款利率计算的 ' +
          yuan(allowed) + ' 元，调增 ' + yuan(addBack) + ' 元',
        basis: [LAW_BASIS.citRegulation],
        source: '财务费用-利息支出',
      });
    }
  }

  /* ------------------------ 9. 研发费用加计扣除 ------------------------ */
  const rdExpense = Math.max(0, detail.rdExpense ?? 0);
  let superDeduction = 0;
  if (rdExpense > 0) {
    if (isPolicyKeyEffective(period, 'rdSuperDeduction')) {
      superDeduction = roundRate(rdExpense, limits.rdSuperDeduction);
      adjustments.push({
        code: 'CIT-ADJ-RD',
        label: '研发费用加计扣除',
        amount: -superDeduction,
        reason:
          '研发费用发生额 ' + yuan(rdExpense) + ' × 加计比例 ' + formatRate(limits.rdSuperDeduction) +
          ' = ' + yuan(superDeduction) + ' 元，在据实扣除基础上加计扣除（调减应纳税所得额）',
        basis: [LAW_BASIS.citRdSuperDeduction7],
        source: '管理费用-研发费用/研发支出-费用化支出',
      });
    } else {
      notes.push('本期不在研发费用加计扣除政策窗口内，未计算加计扣除额');
    }
  }

  let increaseTotal = 0;
  let decreaseTotal = 0;
  for (const adj of adjustments) {
    if (adj.code === 'CIT-ADJ-RD') continue;
    if (adj.amount > 0) increaseTotal += adj.amount;
    else decreaseTotal += -adj.amount;
  }

  return {
    adjustments,
    increaseTotal,
    decreaseTotal,
    superDeduction,
    advertisingCarryforwardClosing: advertisingCarryClosing,
    notes,
  };
}

/* ================================================================== */
/* 三、税率与资格判定                                                  */
/* ================================================================== */

/** 小微资格判定结果。 */
export interface SmallLowProfitCheck {
  qualified: boolean;
  /** 不满足的具体条件，逐条列出，便于复核 */
  reasons: string[];
}

/**
 * 复核小型微利企业资格。
 *
 * 为什么系统还要复核一遍「纳税人自己声明的 isSmallLowProfit」：
 *  小微资格是「年应纳税所得额 ≤ 300 万 + 从业人数 ≤ 300 人 + 资产总额 ≤ 5000 万」
 *  三个条件同时满足。企业常常只记得第一条，结果多享受优惠、被追缴加滞纳金。
 *  系统按三个条件逐一核对，任一条不满足就退回法定税率，并说明原因。
 */
export function checkSmallLowProfit(
  declared: boolean,
  taxableIncome: Cents,
  employees: number | undefined,
  totalAssets: Cents | undefined,
  rates: TaxRates = defaultTaxRates(),
): SmallLowProfitCheck {
  const rule = rates.cit.smallLowProfit;
  const reasons: string[] = [];

  if (!declared) reasons.push('纳税人档案未标记为小型微利企业');
  if (taxableIncome > rule.maxTaxableIncome) {
    reasons.push(
      '年应纳税所得额 ' + yuan(taxableIncome) + ' 元超过 ' + yuan(rule.maxTaxableIncome) + ' 元上限',
    );
  }
  if (employees !== undefined && employees > rule.maxEmployees) {
    reasons.push('从业人数 ' + employees + ' 人超过 ' + rule.maxEmployees + ' 人上限');
  }
  if (totalAssets !== undefined && totalAssets > rule.maxAssets) {
    reasons.push('资产总额 ' + yuan(totalAssets) + ' 元超过 ' + yuan(rule.maxAssets) + ' 元上限');
  }
  return { qualified: reasons.length === 0, reasons };
}

/** 税率判定结果。 */
export interface CitRateDecision {
  rate: number;
  statutoryRate: number;
  reason: string;
  smallLowProfitApplied: boolean;
  highTechApplied: boolean;
  smallLowProfitReasons: string[];
}

/**
 * 判定适用税率。
 *
 * 小微 5%（25% × 20%）与高新 15% 可以同时满足条件，此时按税负更低的小微执行；
 * 若年应纳税所得额超过 300 万，小微资格失效，自动回落到高新 15% 或法定 25%。
 */
export function decideCitRate(
  input: Pick<CitComputeInput, 'isSmallLowProfit' | 'isHighTech' | 'employees' | 'totalAssets'>,
  taxableIncome: Cents,
  rates: TaxRates = defaultTaxRates(),
): CitRateDecision {
  const statutoryRate = rates.cit.standard;
  const check = checkSmallLowProfit(
    input.isSmallLowProfit,
    taxableIncome,
    input.employees,
    input.totalAssets,
    rates,
  );

  if (check.qualified) {
    const effective =
      rates.cit.smallLowProfit.inclusionRate * rates.cit.smallLowProfit.rate;
    return {
      rate: effective,
      statutoryRate,
      reason:
        '符合小型微利企业条件（年应纳税所得额 ≤ ' + yuan(rates.cit.smallLowProfit.maxTaxableIncome) +
        ' 元、从业人数 ≤ ' + rates.cit.smallLowProfit.maxEmployees + ' 人、资产总额 ≤ ' +
        yuan(rates.cit.smallLowProfit.maxAssets) + ' 元），减按 ' +
        formatRate(rates.cit.smallLowProfit.inclusionRate) + ' 计入应纳税所得额、按 ' +
        formatRate(rates.cit.smallLowProfit.rate) + ' 税率缴纳，实际税负 ' + formatRate(effective),
      smallLowProfitApplied: true,
      highTechApplied: false,
      smallLowProfitReasons: [],
    };
  }

  if (input.isHighTech) {
    return {
      rate: rates.cit.highTech,
      statutoryRate,
      reason: '高新技术企业，减按 ' + formatRate(rates.cit.highTech) + ' 税率征收（企业所得税法第二十八条）',
      smallLowProfitApplied: false,
      highTechApplied: true,
      smallLowProfitReasons: check.reasons,
    };
  }

  return {
    rate: statutoryRate,
    statutoryRate,
    reason:
      '按法定税率 ' + formatRate(statutoryRate) + ' 计算' +
      (check.reasons.length > 0 ? '（' + check.reasons.join('；') + '）' : ''),
    smallLowProfitApplied: false,
    highTechApplied: false,
    smallLowProfitReasons: check.reasons,
  };
}

/* ================================================================== */
/* 四、主计算                                                          */
/* ================================================================== */

/**
 * 计算企业所得税。
 *
 * 季度预缴：实际利润额（可弥补以前年度亏损）× 适用税率。
 * 年度汇算：会计利润总额 + 纳税调整增加额 - 纳税调整减少额 - 加计扣除
 *          - 弥补以前年度亏损 = 应纳税所得额，再乘适用税率。
 *
 * @param input 计算输入
 * @param rates 税率表
 */
export function computeCit(input: CitComputeInput, rates: TaxRates = defaultTaxRates()): CitComputeResult {
  const notes: string[] = [];
  const prepaid = Math.max(0, input.prepaidYtd ?? 0);
  const lossCarryforward = Math.max(0, input.lossCarryforward ?? 0);
  const accountingProfit = input.accountingProfit;
  const revenue = Math.max(0, input.revenue);
  const cost = Math.max(0, input.cost ?? 0);

  const detail: CitExpenseDetail = { ...(input.expenseDetail ?? {}) };
  const rd = input.rdExpense ?? detail.rdExpense ?? 0;
  if (rd > 0) detail.rdExpense = rd;

  let adjustments: TaxAdjustment[] = [];
  let increaseTotal = 0;
  let decreaseTotal = 0;
  let superDeduction = 0;
  let advertisingClosing = 0;

  if (input.annual) {
    const computed = computeCitAdjustments(detail, revenue, accountingProfit, input.period, rates);
    adjustments = computed.adjustments;
    increaseTotal = computed.increaseTotal;
    decreaseTotal = computed.decreaseTotal;
    superDeduction = computed.superDeduction;
    advertisingClosing = computed.advertisingCarryforwardClosing;
    notes.push(...computed.notes);
  } else if (rd > 0) {
    notes.push('季度预缴按会计实际利润额计算，研发费用加计扣除在年度汇算清缴时统一享受，预缴阶段不调减');
  }

  if (input.manualAdjustments !== undefined && input.manualAdjustments.length > 0) {
    for (const adj of input.manualAdjustments) {
      adjustments.push(adj);
      if (adj.amount > 0) increaseTotal += adj.amount;
      else decreaseTotal += -adj.amount;
    }
    notes.push('已合并 ' + input.manualAdjustments.length + ' 项人工指定的纳税调整，请复核其法规依据是否完整');
  }

  // 预缴阶段不应用纳税调整，只用会计实际利润额
  const preAdjustIncome = input.annual
    ? accountingProfit + increaseTotal - decreaseTotal - superDeduction
    : accountingProfit;

  const taxableBeforeLoss = Math.max(0, preAdjustIncome);
  const lossUsed = Math.min(lossCarryforward, taxableBeforeLoss);
  const taxableIncome = taxableBeforeLoss - lossUsed;

  if (taxableBeforeLoss > 0 && lossCarryforward > 0) {
    notes.push(
      '弥补以前年度亏损：可弥补 ' + yuan(lossCarryforward) + ' 元，本期实际弥补 ' + yuan(lossUsed) +
        ' 元，剩余可结转 ' + yuan(lossCarryforward - lossUsed) + ' 元',
    );
  }

  const decision = decideCitRate(input, taxableIncome, rates);
  const statutoryTax = roundRate(taxableIncome, decision.statutoryRate);
  const taxPayable = roundRate(taxableIncome, decision.rate);
  const taxRelief = statutoryTax - taxPayable;
  const due = taxPayable - prepaid;

  const lines: TaxLine[] = [];
  const rateBasis: LawBasis[] = decision.highTechApplied
    ? [LAW_BASIS.citLaw, LAW_BASIS.citHighTech32]
    : decision.smallLowProfitApplied
      ? [LAW_BASIS.citLaw, LAW_BASIS.citSmallLowProfit13, LAW_BASIS.sixTaxesHalf12]
      : [LAW_BASIS.citLaw];

  if (input.annual) {
    lines.push({
      code: 'A13',
      label: '利润总额',
      amount: accountingProfit,
      note: '取自利润表「利润总额」，本期 ' + yuan(accountingProfit) + ' 元',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'A15',
      label: '纳税调整增加额',
      amount: increaseTotal,
      note:
        '纳税调整增加额 = Σ 调增项目 = ' + yuan(increaseTotal) + ' 元；明细见 adjustments 字段（' +
        adjustments.filter((a) => a.amount > 0).length + ' 项）',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'A16',
      label: '纳税调整减少额',
      amount: decreaseTotal,
      note: '纳税调整减少额 = Σ 调减项目 = ' + yuan(decreaseTotal) + ' 元',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'A17',
      label: '免税、减计收入及加计扣除',
      amount: superDeduction,
      note:
        '研发费用加计扣除 ' + yuan(superDeduction) + ' 元（加计比例 ' +
        formatRate(rates.cit.limits.rdSuperDeduction) + '）',
      basis: [LAW_BASIS.citRdSuperDeduction7],
    });
    lines.push({
      code: 'A19',
      label: '纳税调整后所得',
      amount: preAdjustIncome,
      note:
        '纳税调整后所得 = 利润总额 ' + yuan(accountingProfit) + ' + 调增 ' + yuan(increaseTotal) +
        ' - 调减 ' + yuan(decreaseTotal) + ' - 加计扣除 ' + yuan(superDeduction) + ' = ' +
        yuan(preAdjustIncome) + ' 元',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'A21',
      label: '弥补以前年度亏损',
      amount: lossUsed,
      note: '本期弥补以前年度亏损 ' + yuan(lossUsed) + ' 元',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'A22',
      label: '应纳税所得额',
      amount: taxableIncome,
      note:
        '应纳税所得额 = 纳税调整后所得 ' + yuan(preAdjustIncome) + ' - 弥补亏损 ' + yuan(lossUsed) +
        ' = ' + yuan(taxableIncome) + ' 元（负数按 0 处理）',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'A23',
      label: '适用税率',
      amount: taxableIncome,
      rate: decision.rate,
      note: decision.reason,
      basis: rateBasis,
    });
    lines.push({
      code: 'A24',
      label: '应纳所得税额',
      amount: statutoryTax,
      rate: decision.statutoryRate,
      note:
        '应纳所得税额（按法定税率）= 应纳税所得额 ' + yuan(taxableIncome) + ' × ' +
        formatRate(decision.statutoryRate) + ' = ' + yuan(statutoryTax) + ' 元',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'A25',
      label: '减免所得税额',
      amount: taxRelief,
      rate: decision.rate,
      note:
        '减免所得税额 = 法定税额 ' + yuan(statutoryTax) + ' - 实际税额 ' + yuan(taxPayable) +
        ' = ' + yuan(taxRelief) + ' 元（' + decision.reason + '）',
      basis: rateBasis,
    });
    if (superDeduction > 0) {
      const rdTaxEffect = roundRate(superDeduction, decision.rate);
      lines.push({
        code: 'tax_reduction',
        label: '减免税额（研发费用加计扣除折算）',
        amount: rdTaxEffect,
        note:
          '研发费用加计扣除 ' + yuan(superDeduction) + ' 元 × 适用税率 ' + formatRate(decision.rate) +
          ' = 少缴企业所得税 ' + yuan(rdTaxEffect) +
          ' 元；该影响已体现在「纳税调整后所得」中，此处单独列示便于审核层与优惠台账核对',
        basis: [LAW_BASIS.citRdSuperDeduction7],
      });
    }

    lines.push({
      code: 'A27',
      label: '应纳税额',
      amount: taxPayable,
      rate: decision.rate,
      note:
        '应纳税额 = 应纳税所得额 ' + yuan(taxableIncome) + ' × ' + formatRate(decision.rate) +
        ' = ' + yuan(taxPayable) + ' 元',
      basis: rateBasis,
    });
    lines.push({
      code: 'A31',
      label: '本年累计实际已预缴的所得税额',
      amount: prepaid,
      note: '本年累计已预缴企业所得税 ' + yuan(prepaid) + ' 元',
      basis: [LAW_BASIS.taxCollectionLaw],
    });
    lines.push({
      code: 'A32',
      label: '本年应补(退)所得税额',
      amount: due,
      note:
        '本年应补(退)所得税额 = 应纳税额 ' + yuan(taxPayable) + ' - 已预缴 ' + yuan(prepaid) +
        ' = ' + yuan(due) + ' 元',
      basis: [LAW_BASIS.taxCollectionLaw],
    });
  } else {
    lines.push({
      code: 'Q2',
      label: '营业收入',
      amount: revenue,
      note: '本期营业收入 ' + yuan(revenue) + ' 元（用于业务招待费、广告费限额测算，预缴阶段不调整）',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'Q3',
      label: '营业成本',
      amount: cost,
      note: '本期营业成本 ' + yuan(cost) + ' 元',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'Q4',
      label: '利润总额',
      amount: accountingProfit,
      note: '本期会计利润总额 ' + yuan(accountingProfit) + ' 元',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'Q9',
      label: '弥补以前年度亏损',
      amount: lossUsed,
      note: '本期弥补以前年度亏损 ' + yuan(lossUsed) + ' 元',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'Q10',
      label: '实际利润额',
      amount: taxableIncome,
      note:
        '实际利润额 = 利润总额 ' + yuan(accountingProfit) + ' - 弥补以前年度亏损 ' + yuan(lossUsed) +
        ' = ' + yuan(taxableIncome) + ' 元（负数按 0 处理）',
      basis: [LAW_BASIS.citLaw],
    });
    // 「适用税率」与「法定税率」分两栏：
    //   审核层按「税率 × 应纳税所得额」勾稽时读的是适用税率（优惠后），
    //   而申报表本身仍要列示法定 25% 以便核对减免税额的来路。
    lines.push({
      code: 'cit_rate',
      label: '适用税率',
      amount: taxableIncome,
      rate: decision.rate,
      note: '本期实际适用税率 ' + formatRate(decision.rate) + '。' + decision.reason,
      basis: rateBasis,
    });
    lines.push({
      code: 'Q11',
      label: '法定税率',
      amount: taxableIncome,
      rate: decision.statutoryRate,
      note: '法定税率 ' + formatRate(decision.statutoryRate),
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'Q12',
      label: '应纳所得税额',
      amount: statutoryTax,
      rate: decision.statutoryRate,
      note:
        '应纳所得税额 = 实际利润额 ' + yuan(taxableIncome) + ' × ' + formatRate(decision.statutoryRate) +
        ' = ' + yuan(statutoryTax) + ' 元',
      basis: [LAW_BASIS.citLaw],
    });
    lines.push({
      code: 'Q13',
      label: '减免所得税额',
      amount: taxRelief,
      rate: decision.rate,
      note:
        '减免所得税额 = 法定税额 ' + yuan(statutoryTax) + ' - 实际税额 ' + yuan(taxPayable) +
        ' = ' + yuan(taxRelief) + ' 元（' + decision.reason + '）',
      basis: rateBasis,
    });
    lines.push({
      code: 'Q14',
      label: '实际应纳所得税额',
      amount: taxPayable,
      rate: decision.rate,
      note:
        '实际应纳所得税额 = 实际利润额 ' + yuan(taxableIncome) + ' × ' + formatRate(decision.rate) +
        ' = ' + yuan(taxPayable) + ' 元',
      basis: rateBasis,
    });
    lines.push({
      code: 'Q15',
      label: '本期应补(退)所得税额',
      amount: due,
      note:
        '本期应补(退)所得税额 = 实际应纳所得税额 ' + yuan(taxPayable) + ' - 已预缴 ' + yuan(prepaid) +
        ' = ' + yuan(due) + ' 元',
      basis: [LAW_BASIS.taxCollectionLaw],
    });
  }

  if (taxableIncome === 0) {
    notes.push('本期应纳税所得额为 0 或负数，应纳企业所得税为 0，请确认亏损原因并保留亏损结转台账');
  }
  if (!decision.smallLowProfitApplied && input.isSmallLowProfit && decision.smallLowProfitReasons.length > 0) {
    notes.push('纳税人声明为小型微利企业，但资格复核未通过：' + decision.smallLowProfitReasons.join('；'));
  }
  if (input.annual) {
    notes.push('年度汇算清缴须在次年 5 月 31 日前完成，本表为系统自动生成的草稿，须经复核与审批后方可申报');
  } else {
    notes.push('季度预缴须在季度终了后 15 日内完成，本表为系统自动生成的草稿，须经复核与审批后方可申报');
  }

  return {
    lines,
    adjustments,
    increaseTotal,
    decreaseTotal,
    superDeduction,
    taxableIncome,
    effectiveRate: decision.rate,
    statutoryTax,
    taxRelief,
    taxPayable,
    prepaid,
    due,
    advertisingCarryforwardClosing: advertisingClosing,
    smallLowProfitApplied: decision.smallLowProfitApplied,
    notes,
  };
}
