/**
 * 税务计算统一编排：一次算出全部税种。
 *
 * 为什么要有编排层，而不是让调用方逐个税种调用：
 *  税种之间有强依赖 —— 附加税费的计税依据是「实际缴纳的增值税」，企业所得税的
 *  收入基数来自账簿，优惠匹配要用到增值税应纳税额，风险扫描要拿所有申报表做对比。
 *  如果让调用方自己串，任何一处顺序错了都会算出错税。编排层把这些依赖固化成一条流水线。
 *
 * 铁律（在类型和实现两层保证）：
 *  1. 本模块产出的 TaxReturn 状态恒为 'calculated'，没有任何代码路径能置为 'filed'；
 *     filed 只能由人工在电子税务局完成申报后，通过申报模块回填事实。
 *  2. 所有金额为「分」整数；比例四舍五入到分，并在 note 里写明算式。
 *  3. 每个税种都带法规依据，没有依据的结论不进入申报表。
 */

import { createHash } from 'node:crypto';

import type {
  AccountingStandardId,
  BenefitMatch,
  Cents,
  FilingEvent,
  IsoDateTime,
  LedgerSnapshot,
  Period,
  TaxAdjustment,
  TaxLine,
  TaxReturn,
  TaxType,
  Voucher,
} from '../core/contracts.ts';
import { ENGINE_VERSION, TAX_TYPE_LABEL } from '../core/contracts.ts';
import { formatYuanGrouped } from '../core/money.ts';
import { CONFIG_DIR } from '../core/config.ts';

import type { TaxpayerProfile, TaxRates, VatCategory } from './rates.ts';
import {
  VAT_CATEGORY_LIST,
  VAT_RATE_BY_CATEGORY,
  defaultTaxRates,
  formatRate,
  isProductionOrLivingServiceIndustry,
  loadTaxRates,
} from './rates.ts';
import type { VatSalesItem } from './vat.ts';
import { computeVat, inferVatRate } from './vat.ts';
import { computeSurcharge } from './surcharge.ts';
import { computeCit } from './cit.ts';
import { computeIitCumulative, projectCumulativeByAverage } from './iit.ts';
import type { StampContractItem } from './stamp.ts';
import { computeStampDuty } from './stamp.ts';
import type { BenefitPolicyDef } from './benefits.ts';
import { loadBenefitPolicies, matchBenefits } from './benefits.ts';
import type { TaxBaseAggregate, TaxRiskItem } from './risk.ts';
import { aggregateTaxBase, scanTaxRisks } from './risk.ts';

function yuan(cents: Cents): string {
  return formatYuanGrouped(cents);
}

/* ================================================================== */
/* 一、公共输入输出                                                    */
/* ================================================================== */

/** 税务计算输入（跨模块契约，字段名不可随意改动）。 */
export interface TaxComputeInput {
  /** 会计期间 YYYY-MM */
  period: Period;
  /** 会计准则，影响报表口径（税务计算本身不区分准则，但需写入申报表以便追溯） */
  standard: AccountingStandardId;
  /** 纳税人画像 */
  taxpayer: TaxpayerProfile;
  /** 账簿快照 */
  ledger: LedgerSnapshot;
  /** 本期凭证 */
  vouchers: readonly Voucher[];
  /** 跨期结转数据 */
  carryforward?: {
    /** 期初留抵税额（分） */
    vatCreditCarryforward?: Cents;
    /** 本年累计已预扣个人所得税（分） */
    iitWithheldYtd?: Cents;
    /** 本年累计已预缴企业所得税（分） */
    citPrepaidYtd?: Cents;
    /** 本年累计营业收入（分），用于判断小微资格与税负率 */
    revenueYtd?: Cents;
  };
  /** 配置目录，缺省为项目 config/ */
  configDir?: string;
}

/** 税务计算输出。 */
export interface TaxComputeResult {
  /** 各税种申报表草稿，状态恒为 calculated */
  returns: TaxReturn[];
  /** 风险提示 */
  risks: TaxRiskItem[];
  /** 优惠匹配结果 */
  benefits: BenefitMatch[];
  /** 计算过程说明（含所有税种的复核算式与假设） */
  notes: string[];
}

/* ================================================================== */
/* 二、内容哈希                                                        */
/* ================================================================== */

/**
 * 规范化 JSON：对象键按字典序递归排序，数组保持顺序，undefined 字段直接丢弃。
 *
 * 为什么需要它：JSON.stringify 的键顺序取决于对象构造顺序，同一份数据两次序列化
 * 可能得到不同字符串，哈希就不稳定，签署指纹也就失去意义。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  const type = typeof value;
  if (type === 'number') {
    const n = value as number;
    return Number.isFinite(n) ? String(n + 0) : 'null';
  }
  if (type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue;
      parts.push(JSON.stringify(key) + ':' + canonicalJson(v));
    }
    return '{' + parts.join(',') + '}';
  }
  return 'null';
}

/** 对任意数据计算 sha256 指纹（十六进制小写）。 */
export function computePayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * 申报表指纹的取数范围。
 *
 * 只覆盖「金额与口径」，不含 createdAt/events/signatures ——
 * 否则重新计算一次时间戳变了，指纹就变，签署校验永远对不上。
 */
function hashReturn(ret: Omit<TaxReturn, 'payloadHash'>): string {
  return computePayloadHash({
    id: ret.id,
    period: ret.period,
    taxType: ret.taxType,
    taxpayerId: ret.taxpayerId,
    standard: ret.standard,
    status: ret.status,
    version: ret.version,
    lines: ret.lines,
    adjustments: ret.adjustments,
    payable: ret.payable,
    prepaid: ret.prepaid,
    due: ret.due,
  });
}

/** 当前时间，ISO-8601 带本地时区偏移。 */
export function nowIso(): IsoDateTime {
  const d = new Date();
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, '0');
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
  );
}

/* ================================================================== */
/* 三、申报表草稿                                                      */
/* ================================================================== */

/**
 * 每个税种「应纳税额」所在栏次编码。
 *
 * 为什么用编码而不是「取最后一行」：申报表的最后一行通常是「应补(退)税额」，
 * 而 payable 应该是「应纳税额」（未扣预缴）。两者混用会让 due 算错。
 * 这里把每个税种的应纳税额栏次显式登记，createDraftReturn 只认登记过的编码。
 */
export const PAYABLE_LINE_CODES: Record<TaxType, readonly string[]> = {
  vat: ['19'],
  cit: ['A27', 'Q14'],
  iit: ['IIT-13'],
  surcharge: ['SUR-TOTAL'],
  stamp: ['STAMP-TOTAL'],
  property: ['PROPERTY-PAYABLE'],
  consumption: ['CONSUMPTION-PAYABLE'],
  resource: ['RESOURCE-PAYABLE'],
  vehicle_purchase: ['VEHICLE-PURCHASE-PAYABLE'],
};

/** 从申报表栏次里解析出应纳税额。 */
export function resolvePayable(taxType: TaxType, lines: readonly TaxLine[]): Cents {
  for (const code of PAYABLE_LINE_CODES[taxType]) {
    for (const line of lines) {
      if (line.code === code) return line.amount;
    }
  }
  // 兜底：集成方传入自定义栏次时，按标签找「应纳税额 / 应补」，避免直接返回 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.label.includes('应纳税额') || line.label.includes('应补')) return line.amount;
  }
  return 0;
}

function returnId(taxType: TaxType, period: Period, taxpayerId: string): string {
  const safe = taxpayerId.replace(/[^0-9A-Za-z]/g, '').slice(0, 20);
  return 'TAX-' + taxType.toUpperCase() + '-' + period + '-' + (safe === '' ? 'NOID' : safe);
}

/**
 * 生成一张申报表草稿。
 *
 * 状态恒为 'calculated'：系统只负责「算」，不负责「报」。
 * 从 calculated 到 filed 必须经过 reviewed → approved → 人工在电子税务局申报 → 回填事实，
 * 这条链路不在本模块，也不允许在本模块出现。
 *
 * @param taxType 税种
 * @param period 会计期间
 * @param taxpayer 纳税人画像
 * @param standard 会计准则
 * @param lines 申报表栏次
 * @param adjustments 纳税调整项（企业所得税汇算用）
 */
export function createDraftReturn(
  taxType: TaxType,
  period: Period,
  taxpayer: TaxpayerProfile,
  standard: AccountingStandardId,
  lines: TaxLine[],
  adjustments: TaxAdjustment[] = [],
): TaxReturn {
  const payable = resolvePayable(taxType, lines);
  const now = nowIso();
  const event: FilingEvent = {
    at: now,
    from: 'draft',
    to: 'calculated',
    actor: 'system',
    reason: '系统按账簿数据自动计算生成草稿；未经复核、审批不得申报，系统不会自动向税务机关提交',
    humanInitiated: false,
  };

  const base: Omit<TaxReturn, 'payloadHash'> = {
    id: returnId(taxType, period, taxpayer.id),
    period,
    taxType,
    taxpayerId: taxpayer.id,
    standard,
    status: 'calculated',
    version: 1,
    lines,
    adjustments,
    payable,
    prepaid: 0,
    due: payable,
    benefits: [],
    reviewId: null,
    blockingIssues: 0,
    signatures: [],
    events: [event],
    createdAt: now,
    updatedAt: now,
  };

  return { ...base, payloadHash: hashReturn(base) };
}

/** 设置已预缴税额，重算应补(退)并刷新指纹（返回新对象，不修改入参）。 */
export function withPrepayment(ret: TaxReturn, prepaid: Cents): TaxReturn {
  const p = Math.max(0, prepaid);
  const { payloadHash: _ignored, ...rest } = ret;
  const updated: Omit<TaxReturn, 'payloadHash'> = {
    ...rest,
    prepaid: p,
    due: ret.payable - p,
    updatedAt: nowIso(),
  };
  return { ...updated, payloadHash: hashReturn(updated) };
}

/** 挂载优惠匹配结果（不改变税额，因此不刷新指纹）。 */
export function withBenefits(ret: TaxReturn, benefits: BenefitMatch[]): TaxReturn {
  return { ...ret, benefits };
}

/* ================================================================== */
/* 四、从账簿推导增值税销项                                            */
/* ================================================================== */

function isPrefix(code: string, prefixes: readonly string[]): boolean {
  for (const p of prefixes) {
    if (code === p || code.startsWith(p + '.')) return true;
  }
  return false;
}

/** 按科目名称粗判应税项目分类。 */
function categoryOfAccount(name: string, code: string): VatCategory {
  if (name.includes('建筑')) return 'construction';
  if (name.includes('运输') || name.includes('物流')) return 'transport';
  if (name.includes('租赁')) return 'tangible_lease';
  if (name.includes('服务')) return 'modern_service';
  if (name.includes('商品') || name.includes('货物')) return 'goods';
  if (code.startsWith('6001.02')) return 'modern_service';
  if (code.startsWith('6001.01')) return 'goods';
  return 'goods';
}

/** 把实算税率映射回一个用于栏次标签的分类。 */
function categoryForRate(rate: number, hint: VatCategory | null): VatCategory {
  if (hint !== null && VAT_RATE_BY_CATEGORY[hint] === rate) return hint;
  for (const category of VAT_CATEGORY_LIST) {
    if (category === 'small_scale_1' || category === 'small_scale_3') continue;
    if (VAT_RATE_BY_CATEGORY[category] === rate) return category;
  }
  return 'goods';
}

/**
 * 从凭证推导销项明细。
 *
 * 做法：逐张凭证把「收入类科目贷方净额」与「销项税额贷方净额」配对，
 * 反算这张凭证适用的税率。这样即使一张凭证里同时有 13% 货物和 6% 服务，
 * 也会被拆成两条销项，而不是被平均成一个不存在的税率 —— 这是兼营多税率的关键。
 */
export function deriveVatSales(
  vouchers: readonly Voucher[],
  base: TaxBaseAggregate,
  notes: string[],
): VatSalesItem[] {
  const sales: VatSalesItem[] = [];
  let zeroTaxRevenue = 0;

  for (const voucher of vouchers) {
    let net = 0;
    let tax = 0;
    let hint: VatCategory | null = null;
    for (const line of voucher.lines) {
      if (isPrefix(line.accountCode, ['6001', '6051'])) {
        net += line.credit - line.debit;
        if (hint === null) hint = categoryOfAccount(line.accountName, line.accountCode);
      }
      if (isPrefix(line.accountCode, ['2221.01.02'])) {
        tax += line.credit - line.debit;
      }
    }
    if (net <= 0) continue;

    if (tax === 0) zeroTaxRevenue += net;

    const rate = inferVatRate(net, tax);
    if (rate === null) {
      notes.push(
        '凭证 ' + voucher.word + '：收入 ' + yuan(net) + ' 元与销项税额 ' + yuan(tax) +
        ' 元无法匹配到法定税率档位，已按科目推断分类「' + (hint ?? 'goods') + '」并按该分类税率计算，请人工复核',
      );
      sales.push({ category: hint ?? 'goods', netAmount: net, label: voucher.word });
      continue;
    }
    sales.push({ category: categoryForRate(rate, hint), netAmount: net, rate, label: voucher.word });
  }

  if (sales.length === 0 && base.revenue > 0) {
    const rate = inferVatRate(base.revenue, base.vatOutputTax);
    const hint = categoryOfAccount('主营业务收入', '6001');
    if (rate === null) {
      notes.push(
        '账簿收入 ' + yuan(base.revenue) + ' 元与销项税额 ' + yuan(base.vatOutputTax) +
        ' 元无法匹配法定税率，已按科目推断分类计算，请人工复核',
      );
      sales.push({ category: hint, netAmount: base.revenue, label: '账簿汇总' });
    } else {
      sales.push({ category: categoryForRate(rate, hint), netAmount: base.revenue, rate, label: '账簿汇总' });
      notes.push(
        '未从凭证推导出销项明细，已按账簿收入 ' + yuan(base.revenue) + ' 元与销项税额 ' +
        yuan(base.vatOutputTax) + ' 元反算平均税率 ' + formatRate(rate) + '，兼营企业请拆分后重算',
      );
    }
  }

  if (zeroTaxRevenue > 0) {
    notes.push(
      '有 ' + yuan(zeroTaxRevenue) + ' 元收入未计提销项税额，已按 0% 税率处理；' +
      '若属免税项目，请改按免税销售额填报，并确认对应进项税额已转出',
    );
  }

  return sales;
}

/* ================================================================== */
/* 五、编排                                                            */
/* ================================================================== */

function loadRatesSafe(configDir: string | undefined, notes: string[]): TaxRates {
  try {
    const rates = loadTaxRates(configDir ?? CONFIG_DIR);
    for (const w of rates.warnings) notes.push(w);
    return rates;
  } catch (err) {
    notes.push(
      '税率配置加载失败，已回退到代码内置默认税率表（' + (err as Error).message +
      '）；请修正 config/tax/rates.yaml 后重新计算',
    );
    return defaultTaxRates();
  }
}

/** 取某个税种对应的优惠政策（按政策 id 前缀归属）。 */
function benefitsOf(taxType: TaxType, benefits: readonly BenefitMatch[]): BenefitMatch[] {
  const prefix = taxType + '-';
  return benefits.filter((b) => b.policyId.startsWith(prefix));
}

/** 按科目前缀汇总贷方净额（用于营业账簿印花税的「本年增加额」）。 */
function creditNetOf(base: TaxBaseAggregate, prefixes: readonly string[]): Cents {
  let sum = 0;
  for (const account of base.accounts) {
    if (!isPrefix(account.code, prefixes)) continue;
    sum += account.credit - account.debit;
  }
  return sum;
}

/**
 * 一次算出全部税种。
 *
 * 计算顺序（不可调换）：
 *   账簿取数 → 增值税 → 附加税费（依赖实缴增值税）→ 企业所得税 → 个人所得税 → 印花税
 *   → 优惠匹配（依赖增值税应纳税额与利润）→ 风险扫描（依赖全部申报表）
 *
 * @param input 账簿、纳税人画像与结转数据
 */
export function computeTaxes(input: TaxComputeInput): TaxComputeResult {
  const notes: string[] = [];
  const rates = loadRatesSafe(input.configDir, notes);
  const base = aggregateTaxBase(input.ledger, input.vouchers);
  for (const n of base.notes) notes.push(n);

  const taxpayer = input.taxpayer;
  const period = input.period;
  const standard = input.standard;
  const returns: TaxReturn[] = [];

  /* ------------------------------ 1. 增值税 ------------------------------ */
  let vatResult;
  if (taxpayer.kind === 'small_scale') {
    const sales: VatSalesItem[] = base.revenue > 0
      ? [{ category: 'small_scale_1', netAmount: base.revenue, label: '账簿营业收入' }]
      : [];
    vatResult = computeVat(
      {
        period,
        kind: 'small_scale',
        sales,
        quarterly: period.endsWith('-03') || period.endsWith('-06') || period.endsWith('-09') || period.endsWith('-12'),
        prepaid: 0,
      },
      rates,
    );
  } else {
    const sales = deriveVatSales(input.vouchers, base, notes);
    // 加计抵减是资格型优惠：只有行业粗筛通过才计提，且仍需人工确认四项服务占比
    const industry = taxpayer.industry ?? '';
    const qualifiesAdditional = isProductionOrLivingServiceIndustry(industry);
    if (qualifiesAdditional) {
      notes.push(
        '所属行业「' + industry + '」可能属于生产性/生活性服务业，已按 ' +
        formatRate(rates.vat.additionalDeductionRate) +
        ' 计提加计抵减；请人工确认四项服务销售额占全部销售额比重是否超过 50%',
      );
    }
    vatResult = computeVat(
      {
        period,
        kind: 'general',
        sales,
        purchases: base.vatInputTax > 0
          ? [{ inputTax: base.vatInputTax, label: '账簿进项税额' }]
          : [],
        creditCarryforward: input.carryforward?.vatCreditCarryforward ?? 0,
        inputTransferOut: base.vatInputTransferOut,
        additionalDeductionRate: qualifiesAdditional ? rates.vat.additionalDeductionRate : 0,
        prepaid: 0,
      },
      rates,
    );
  }
  for (const n of vatResult.notes) notes.push(n);

  const vatReturn = withPrepayment(
    createDraftReturn('vat', period, taxpayer, standard, vatResult.lines),
    vatResult.prepaid,
  );
  returns.push(vatReturn);

  /* ---------------------------- 2. 附加税费 ---------------------------- */
  const surchargeResult = computeSurcharge(
    {
      period,
      cityTaxRate: taxpayer.cityTaxRate,
      smallScale: taxpayer.kind === 'small_scale',
      smallLowProfit: taxpayer.isSmallLowProfit === true,
      vatPaid: vatResult.payable,
      consumptionTaxPaid: 0,
      salesAmount: base.revenue,
      quarterly: period.endsWith('-03') || period.endsWith('-06') || period.endsWith('-09') || period.endsWith('-12'),
      prepaid: 0,
    },
    rates,
  );
  for (const n of surchargeResult.notes) notes.push(n);

  const surchargeReturn = withPrepayment(
    createDraftReturn('surcharge', period, taxpayer, standard, surchargeResult.lines),
    surchargeResult.prepaid,
  );
  returns.push(surchargeReturn);

  /* --------------------------- 3. 企业所得税 --------------------------- */
  const isAnnual = period.endsWith('-12');
  const rdExpense = taxpayer.rdExpense ?? base.rdExpense;
  // 年度汇算的招待费、广告费限额基数是「全年销售收入」，而账簿快照只覆盖单期。
  // 调用方若提供 revenueYtd（本年累计营业收入），以它为准，否则退回本期数并提示。
  const revenueYtd = input.carryforward?.revenueYtd;
  const citRevenue = isAnnual && revenueYtd !== undefined && revenueYtd > 0 ? revenueYtd : base.revenue;
  if (isAnnual && citRevenue !== base.revenue) {
    notes.push(
      '年度汇算的销售（营业）收入基数采用本年累计数 ' + yuan(citRevenue) + ' 元（本期账簿收入 ' +
      yuan(base.revenue) + ' 元），用于业务招待费与广告费的限额测算',
    );
  }
  const citResult = computeCit(
    {
      period,
      accountingProfit: base.accountingProfit,
      revenue: citRevenue,
      cost: base.cost,
      isSmallLowProfit: taxpayer.isSmallLowProfit === true,
      isHighTech: taxpayer.isHighTech === true,
      employees: taxpayer.employees,
      totalAssets: taxpayer.totalAssets,
      rdExpense,
      expenseDetail: {
        businessEntertainment: base.businessEntertainment,
        advertising: base.advertising,
        wages: base.wages,
        welfare: base.welfare,
        education: base.educationFund,
        unionFee: base.unionFee,
        donation: base.donation,
        fines: base.fines,
        interestExpense: base.interestExpense,
        rdExpense,
      },
      prepaidYtd: input.carryforward?.citPrepaidYtd ?? 0,
      annual: isAnnual,
    },
    rates,
  );
  for (const n of citResult.notes) notes.push(n);

  const citReturn = withPrepayment(
    createDraftReturn('cit', period, taxpayer, standard, citResult.lines, citResult.adjustments),
    citResult.prepaid,
  );
  returns.push(citReturn);

  /* --------------------------- 4. 个人所得税 --------------------------- */
  const monthsElapsed = Number(period.slice(5, 7));
  const monthlySpecial = base.socialInsurancePersonal + base.housingFundPersonal;
  const projected = projectCumulativeByAverage(base.wages, monthlySpecial, monthsElapsed);
  if (base.wages > 0) {
    notes.push(
      '个人所得税累计数按本月工资 ' + yuan(base.wages) + ' 元、三险一金 ' + yuan(monthlySpecial) +
      ' 元月均推算（×' + monthsElapsed + ' 个月），专项附加扣除未取数；' +
      '正式申报请以自然人电子税务局扣缴客户端导出的累计数覆盖本表',
    );
  }
  const iitResult = computeIitCumulative(
    {
      period,
      cumulativeIncome: projected.cumulativeIncome,
      cumulativeSpecialDeduction: projected.cumulativeSpecialDeduction,
      cumulativeAdditionalDeduction: 0,
      taxWithheldYtd: input.carryforward?.iitWithheldYtd ?? 0,
      monthsElapsed,
    },
    rates,
  );
  for (const n of iitResult.notes) notes.push(n);

  const iitReturn = createDraftReturn('iit', period, taxpayer, standard, iitResult.lines);
  returns.push(iitReturn);

  /* ----------------------------- 5. 印花税 ----------------------------- */
  const stampItems: StampContractItem[] = [];
  if (base.purchaseAmount > 0) {
    stampItems.push({ type: 'sale', amount: base.purchaseAmount, label: '采购合同（按采购额）' });
  }
  if (base.revenue > 0) {
    stampItems.push({ type: 'sale', amount: base.revenue, label: '销售合同（按营业收入）' });
  }
  const loanAmount = base.shortTermLoan + base.longTermLoan;
  if (loanAmount > 0) {
    stampItems.push({ type: 'loan', amount: loanAmount, label: '借款合同（按借款增加额）' });
  }
  if (base.leaseExpense > 0) {
    stampItems.push({ type: 'lease', amount: base.leaseExpense, label: '租赁合同（按租赁费）' });
  }
  const transferAmount = base.fixedAssetPurchase + base.intangiblePurchase;
  if (transferAmount > 0) {
    stampItems.push({ type: 'property_transfer', amount: transferAmount, label: '产权转移书据（按购置额）' });
  }
  const bookIncrease = creditNetOf(base, ['4001', '4002']);
  if (bookIncrease > 0) {
    stampItems.push({ type: 'account_book', amount: bookIncrease, label: '营业账簿（按实收资本与资本公积增加额）' });
  }

  const stampResult = computeStampDuty(
    {
      period,
      items: stampItems,
      smallScale: taxpayer.kind === 'small_scale',
      smallLowProfit: taxpayer.isSmallLowProfit === true,
      prepaid: 0,
    },
    rates,
  );
  for (const n of stampResult.notes) notes.push(n);

  const stampReturn = withPrepayment(
    createDraftReturn('stamp', period, taxpayer, standard, stampResult.lines),
    stampResult.prepaid,
  );
  returns.push(stampReturn);

  /* ----------------------------- 6. 优惠匹配 ----------------------------- */
  let policies: readonly BenefitPolicyDef[] = [];
  try {
    policies = loadBenefitPolicies(input.configDir ?? CONFIG_DIR);
  } catch (err) {
    notes.push('优惠政策库加载失败，已使用内置政策库：' + (err as Error).message);
  }
  const benefits = matchBenefits(
    taxpayer,
    {
      revenue: base.revenue,
      profit: base.accountingProfit,
      rdExpense,
      vatPayable: vatResult.payable,
    },
    {
      period,
      ...(policies.length > 0 ? { policies } : {}),
      equipmentPurchase: base.fixedAssetPurchase,
    },
  );

  const withBenefitReturns = returns.map((ret) => withBenefits(ret, benefitsOf(ret.taxType, benefits)));

  /* ----------------------------- 7. 风险扫描 ----------------------------- */
  const risks = scanTaxRisks(input, withBenefitReturns);

  /* ------------------------------ 8. 说明 ------------------------------ */
  notes.push(
    '本次共生成 ' + withBenefitReturns.length + ' 张申报表草稿，状态均为「已计算」，' +
    '须经复核人、审批人签署后方可导出；系统不会、也不允许自动向税务机关提交申报',
  );
  const eligibleCount = benefits.filter((b) => b.eligible).length;
  if (eligibleCount > 0) {
    notes.push('共匹配到 ' + eligibleCount + ' 项可享受的税收优惠，均需人工确认备查资料后方可适用');
  }
  if (risks.length > 0) {
    notes.push('风险扫描发现 ' + risks.length + ' 条提示，请逐条核实；系统不对风险作定性结论');
  }

  return { returns: withBenefitReturns, risks, benefits, notes };
}

/* ================================================================== */
/* 六、便捷查询                                                        */
/* ================================================================== */

/** 按税种取申报表草稿。 */
export function findReturn(returns: readonly TaxReturn[], taxType: TaxType): TaxReturn | undefined {
  for (const ret of returns) {
    if (ret.taxType === taxType) return ret;
  }
  return undefined;
}

/** 全部申报表应纳税额合计（分）。 */
export function totalPayable(returns: readonly TaxReturn[]): Cents {
  return returns.reduce((sum, ret) => sum + ret.payable, 0);
}

/** 全部申报表应补(退)税额合计（分）。 */
export function totalDue(returns: readonly TaxReturn[]): Cents {
  return returns.reduce((sum, ret) => sum + ret.due, 0);
}

/** 申报表摘要文本，用于日志与界面标题。 */
export function summarizeReturns(returns: readonly TaxReturn[]): string {
  if (returns.length === 0) return '本期无申报表草稿';
  return returns
    .map((ret) => TAX_TYPE_LABEL[ret.taxType] + ' 应纳 ' + yuan(ret.payable) + ' 元 / 应补(退) ' + yuan(ret.due) + ' 元')
    .join('；');
}

/** 引擎版本，写入导出文件的元数据。 */
export const TAX_ENGINE_VERSION = ENGINE_VERSION;
