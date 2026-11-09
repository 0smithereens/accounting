/**
 * 税务风险扫描。
 *
 * 为什么风险指标要从账簿现算、而不是只看申报表：
 *  申报表是「结果」，账簿是「过程」。税负率异常、进销项倒挂、社保与工资不匹配
 *  这类问题，只有把「收入、成本、工资、社保、进项、销项」放在同一张表上对比
 *  才看得出来。因此本模块先从账簿汇总出一套统一口径的取数（aggregateTaxBase），
 *  再基于它和申报表草稿算指标。
 *
 * 重要：本模块只提示风险，不做定性结论。
 *  每一条都给出 level / detail / suggestion / basis，由会计判断是否需要调整。
 *  系统不会因为「税负率低」就认定企业偷税 —— 那既不负责任，也可能构成误导。
 */

import type {
  Cents,
  LawBasis,
  LedgerSnapshot,
  Period,
  Severity,
  TaxReturn,
  Voucher,
} from '../core/contracts.ts';
import { formatYuanGrouped } from '../core/money.ts';

import type { TaxpayerProfile } from './rates.ts';
import { LAW_BASIS, formatRate } from './rates.ts';
import type { TaxComputeInput } from './compute.ts';

function yuan(cents: Cents): string {
  return formatYuanGrouped(cents);
}

/** 百分比展示（保留两位小数）。 */
function pct(ratio: number): string {
  return (ratio * 100).toFixed(2) + '%';
}

/* ================================================================== */
/* 一、账簿取数                                                        */
/* ================================================================== */

/** 单个科目的借贷发生额。 */
export interface TaxAccountTotal {
  code: string;
  name: string;
  debit: Cents;
  credit: Cents;
}

/**
 * 税务计算所需的账簿汇总口径。
 *
 * 这是「税务口径」而不是「会计口径」：例如工资取应付职工薪酬-工资的贷方发生额
 * （计提数），而不是管理费用里的工资（那只是分摊到费用的一部分）。
 * 所有下游模块共用这一套数字，保证申报表、风险指标、优惠测算说的是同一件事。
 */
export interface TaxBaseAggregate {
  /** 营业收入（主营业务收入 + 其他业务收入） */
  revenue: Cents;
  /** 营业成本 */
  cost: Cents;
  /** 税金及附加 */
  taxesAndSurcharges: Cents;
  sellingExpense: Cents;
  adminExpense: Cents;
  financeExpense: Cents;
  investmentIncome: Cents;
  nonOperatingIncome: Cents;
  nonOperatingExpense: Cents;
  /** 按利润表口径推算的会计利润总额 */
  accountingProfit: Cents;
  /** 工资薪金总额（应付职工薪酬-工资贷方发生额） */
  wages: Cents;
  /** 单位承担的社会保险费 */
  socialInsurance: Cents;
  /** 单位承担的住房公积金 */
  housingFund: Cents;
  /** 个人承担的社会保险费（专项扣除） */
  socialInsurancePersonal: Cents;
  /** 个人承担的住房公积金（专项扣除） */
  housingFundPersonal: Cents;
  /** 销项税额 */
  vatOutputTax: Cents;
  /** 进项税额 */
  vatInputTax: Cents;
  /** 进项税额转出 */
  vatInputTransferOut: Cents;
  /** 已交税金 */
  vatPaid: Cents;
  businessEntertainment: Cents;
  advertising: Cents;
  welfare: Cents;
  educationFund: Cents;
  unionFee: Cents;
  donation: Cents;
  fines: Cents;
  interestExpense: Cents;
  rdExpense: Cents;
  /** 银行存款借方发生额（资金流入） */
  bankInflow: Cents;
  /** 银行存款贷方发生额（资金流出） */
  bankOutflow: Cents;
  /** 实收资本期末余额 */
  paidInCapital: Cents;
  /** 资本公积期末余额 */
  capitalReserve: Cents;
  shortTermLoan: Cents;
  longTermLoan: Cents;
  fixedAssetPurchase: Cents;
  intangiblePurchase: Cents;
  leaseExpense: Cents;
  /** 采购额（材料采购、在途物资、原材料、库存商品借方净额） */
  purchaseAmount: Cents;
  /** 明细科目发生额，便于追溯 */
  accounts: TaxAccountTotal[];
  /** 取数说明 */
  notes: string[];
}

function matchesPrefix(code: string, prefixes: readonly string[]): boolean {
  for (const p of prefixes) {
    if (code === p || code.startsWith(p + '.')) return true;
  }
  return false;
}

function netBy(
  totals: Map<string, TaxAccountTotal>,
  predicate: (t: TaxAccountTotal) => boolean,
  direction: 1 | -1,
): Cents {
  let sum = 0;
  for (const t of totals.values()) {
    if (!predicate(t)) continue;
    sum += direction * (t.debit - t.credit);
  }
  return sum;
}

function netByPrefix(
  totals: Map<string, TaxAccountTotal>,
  prefixes: readonly string[],
  direction: 1 | -1,
): Cents {
  return netBy(totals, (t) => matchesPrefix(t.code, prefixes), direction);
}

function netByName(
  totals: Map<string, TaxAccountTotal>,
  keywords: readonly string[],
  direction: 1 | -1,
): Cents {
  return netBy(
    totals,
    (t) => keywords.some((k) => t.name.includes(k)),
    direction,
  );
}

/**
 * 从账簿快照（优先）或凭证（兜底）汇总税务取数。
 *
 * 为什么优先用 LedgerSnapshot.balances：
 *  余额表已经做过科目汇总，口径与报表一致；而凭证逐行汇总在存在红字冲销、
 *  跨期调整时容易与报表对不上。只有账簿没有余额时才退回凭证汇总，并在 notes 里说明。
 */
export function aggregateTaxBase(
  ledger: LedgerSnapshot,
  vouchers: readonly Voucher[],
): TaxBaseAggregate {
  const notes: string[] = [];
  const totals = new Map<string, TaxAccountTotal>();

  if (ledger.balances.length > 0) {
    for (const b of ledger.balances) {
      const existing = totals.get(b.accountCode);
      if (existing === undefined) {
        totals.set(b.accountCode, {
          code: b.accountCode,
          name: b.accountName,
          debit: b.debitTotal,
          credit: b.creditTotal,
        });
      } else {
        existing.debit += b.debitTotal;
        existing.credit += b.creditTotal;
      }
    }
  } else {
    notes.push('账簿快照没有科目余额，已改用凭证逐行汇总；口径可能与报表存在差异，请复核');
    for (const v of vouchers) {
      for (const line of v.lines) {
        const existing = totals.get(line.accountCode);
        if (existing === undefined) {
          totals.set(line.accountCode, {
            code: line.accountCode,
            name: line.accountName,
            debit: line.debit,
            credit: line.credit,
          });
        } else {
          existing.debit += line.debit;
          existing.credit += line.credit;
        }
      }
    }
  }

  const revenue = netByPrefix(totals, ['6001', '6051'], -1);
  const cost = netByPrefix(totals, ['6401', '6402'], 1);
  const taxesAndSurcharges = netByPrefix(totals, ['6403'], 1);
  const sellingExpense = netByPrefix(totals, ['6601'], 1);
  const adminExpense = netByPrefix(totals, ['6602'], 1);
  const financeExpense = netByPrefix(totals, ['6603'], 1);
  const investmentIncome = netByPrefix(totals, ['6111'], -1);
  const nonOperatingIncome = netByPrefix(totals, ['6301'], -1);
  const nonOperatingExpense = netByPrefix(totals, ['6711'], 1);

  const accountingProfit =
    revenue -
    cost -
    taxesAndSurcharges -
    sellingExpense -
    adminExpense -
    financeExpense +
    investmentIncome +
    nonOperatingIncome -
    nonOperatingExpense;

  // 研发费用：优先取「管理费用-研发费用」，没有再退回「研发支出-费用化支出」
  let rdExpense = netBy(
    totals,
    (t) => t.code === '6602.18' || (t.code.startsWith('6602') && t.name.includes('研发')),
    1,
  );
  if (rdExpense === 0) {
    rdExpense = netBy(totals, (t) => t.code === '5301.01' || t.code === '5301', 1);
  }

  const closingOf = (prefixes: readonly string[]): Cents => {
    let sum = 0;
    for (const b of ledger.balances) {
      if (matchesPrefix(b.accountCode, prefixes)) sum += b.closing;
    }
    return sum;
  };
  // 负债/权益类科目期末余额在贷方，closing 为负数，取反得到正数金额
  const paidInCapital = ledger.balances.length > 0 ? -closingOf(['4001']) : netByPrefix(totals, ['4001'], -1);
  const capitalReserve = ledger.balances.length > 0 ? -closingOf(['4002']) : netByPrefix(totals, ['4002'], -1);

  const accounts = [...totals.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const aggregate: TaxBaseAggregate = {
    revenue,
    cost,
    taxesAndSurcharges,
    sellingExpense,
    adminExpense,
    financeExpense,
    investmentIncome,
    nonOperatingIncome,
    nonOperatingExpense,
    accountingProfit,
    wages: netByPrefix(totals, ['2211.01'], -1),
    socialInsurance: netByPrefix(totals, ['2211.02'], -1),
    housingFund: netByPrefix(totals, ['2211.03'], -1),
    socialInsurancePersonal: netByPrefix(totals, ['2241.01'], -1),
    housingFundPersonal: netByPrefix(totals, ['2241.02'], -1),
    vatOutputTax: netByPrefix(totals, ['2221.01.02'], -1),
    vatInputTax: netByPrefix(totals, ['2221.01.01'], 1),
    vatInputTransferOut: netByPrefix(totals, ['2221.01.05'], -1),
    vatPaid: netByPrefix(totals, ['2221.01.03'], 1),
    businessEntertainment: netByName(totals, ['业务招待费'], 1),
    advertising: netByName(totals, ['广告', '宣传'], 1),
    welfare: netBy(
      totals,
      (t) => t.code === '2211.04' || t.name.includes('职工福利费') || t.name.includes('福利费'),
      1,
    ),
    educationFund: netBy(
      totals,
      (t) => t.code === '2211.06' || t.name.includes('职工教育经费') || t.name.includes('培训费'),
      1,
    ),
    unionFee: netBy(totals, (t) => t.code === '2211.05' || t.name.includes('工会经费'), 1),
    donation: netByName(totals, ['捐赠'], 1),
    fines: netByName(totals, ['罚款', '滞纳金', '罚金'], 1),
    interestExpense: netBy(totals, (t) => t.code === '6603.01' || t.name.includes('利息支出'), 1),
    rdExpense,
    bankInflow: netByPrefix(totals, ['1002'], 1),
    bankOutflow: netByPrefix(totals, ['1002'], -1),
    paidInCapital,
    capitalReserve,
    shortTermLoan: netByPrefix(totals, ['2001'], -1),
    longTermLoan: netByPrefix(totals, ['2501'], -1),
    fixedAssetPurchase: netByPrefix(totals, ['1601'], 1),
    intangiblePurchase: netByPrefix(totals, ['1701'], 1),
    leaseExpense: netByPrefix(totals, ['6602.06', '6601.09'], 1),
    purchaseAmount: netByPrefix(totals, ['1401', '1402', '1403', '1405'], 1),
    accounts,
    notes,
  };

  if (revenue < 0) {
    notes.push('营业收入为负数（' + yuan(revenue) + ' 元），可能存在红字冲销或科目方向记反，请复核');
  }
  if (aggregate.vatOutputTax > 0 && revenue > 0) {
    const impliedRate = aggregate.vatOutputTax / revenue;
    if (impliedRate < 0.005) {
      notes.push('销项税额占营业收入仅 ' + pct(impliedRate) + '，可能存在未计提销项税或存在免税收入');
    }
  }

  return aggregate;
}

/* ================================================================== */
/* 二、风险项                                                          */
/* ================================================================== */

/** 一条税务风险提示。 */
export interface TaxRiskItem {
  /** 稳定编码，如 TAX-RISK-VAT-BURDEN */
  code: string;
  level: Severity;
  title: string;
  detail: string;
  suggestion: string;
  basis: LawBasis[];
  /** 机器可读的指标，便于前端画图与二次核验 */
  metrics?: Record<string, number>;
}

/** 行业增值税税负率参考区间（仅用于异常提示，不是税务局的预警线）。 */
export const INDUSTRY_VAT_BURDEN: ReadonlyArray<{ keyword: string; low: number; high: number }> = [
  { keyword: '制造', low: 0.02, high: 0.08 },
  { keyword: '批发', low: 0.005, high: 0.03 },
  { keyword: '零售', low: 0.005, high: 0.03 },
  { keyword: '建筑', low: 0.02, high: 0.06 },
  { keyword: '交通', low: 0.01, high: 0.05 },
  { keyword: '运输', low: 0.01, high: 0.05 },
  { keyword: '信息技术', low: 0.01, high: 0.06 },
  { keyword: '软件', low: 0.01, high: 0.06 },
  { keyword: '房地产', low: 0.02, high: 0.08 },
  { keyword: '服务', low: 0.01, high: 0.06 },
];

/** 未匹配到行业时的默认参考区间。 */
export const DEFAULT_VAT_BURDEN = { low: 0.01, high: 0.08 };

/** 发票顶额开具的常见版面限额（分）：十万元版、百万元版、千万元版。 */
export const INVOICE_CEILINGS: readonly Cents[] = [9_999_999, 99_999_999, 999_999_999];

function benchmarkOf(industry: string | undefined): { low: number; high: number } {
  if (industry === undefined || industry === '') return DEFAULT_VAT_BURDEN;
  for (const item of INDUSTRY_VAT_BURDEN) {
    if (industry.includes(item.keyword)) return { low: item.low, high: item.high };
  }
  return DEFAULT_VAT_BURDEN;
}

function findReturn(returns: readonly TaxReturn[], taxType: string): TaxReturn | undefined {
  for (const r of returns) {
    if (r.taxType === taxType) return r;
  }
  return undefined;
}

function lineAmount(ret: TaxReturn | undefined, code: string): Cents {
  if (ret === undefined) return 0;
  for (const line of ret.lines) {
    if (line.code === code) return line.amount;
  }
  return 0;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * 扫描税务风险。
 *
 * @param input 与 computeTaxes 相同的输入（复用账簿与纳税人画像）
 * @param returns 已计算出的申报表草稿，用于取税负率、留抵等指标
 */
export function scanTaxRisks(
  input: TaxComputeInput,
  returns: readonly TaxReturn[],
): TaxRiskItem[] {
  const base = aggregateTaxBase(input.ledger, input.vouchers);
  const taxpayer: TaxpayerProfile = input.taxpayer;
  const period: Period = input.period;
  const risks: TaxRiskItem[] = [];

  const vatReturn = findReturn(returns, 'vat');
  const vatPayable = vatReturn === undefined ? 0 : vatReturn.payable;
  const revenue = Math.max(0, base.revenue);

  /* ---------------- 1. 增值税税负率异常 ---------------- */
  if (revenue > 0) {
    const burden = vatPayable / revenue;
    const bench = benchmarkOf(taxpayer.industry);
    const tooLow = burden < bench.low * 0.5;
    const tooHigh = burden > bench.high * 2;
    if (tooLow || tooHigh) {
      risks.push({
        code: 'TAX-RISK-VAT-BURDEN',
        level: 'warning',
        title: '增值税税负率' + (tooLow ? '明显偏低' : '明显偏高'),
        detail:
          period + ' 增值税税负率 ' + pct(burden) + '（应纳增值税 ' + yuan(vatPayable) +
          ' 元 ÷ 营业收入 ' + yuan(revenue) + ' 元），' +
          (taxpayer.industry === undefined || taxpayer.industry === ''
            ? '行业未填写，按通用参考区间 '
            : '行业「' + taxpayer.industry + '」参考区间 ') +
          pct(bench.low) + ' ~ ' + pct(bench.high) + '。',
        suggestion: tooLow
          ? '核查是否存在未开票收入未申报、视同销售未计提销项、进项抵扣凭证不合规等问题；若确因留抵或免税政策导致，请留存说明备查'
          : '核查是否误将不应抵扣的进项计入、或收入确认滞后导致税负虚高；如属正常经营波动，请留存同期对比说明',
        basis: [LAW_BASIS.vatLaw, LAW_BASIS.taxCollectionLaw],
        metrics: {
          revenue,
          vatPayable,
          vatBurden: burden,
          benchmarkLow: bench.low,
          benchmarkHigh: bench.high,
        },
      });
    }
  }

  /* ---------------- 2. 进销项税率倒挂 ---------------- */
  const purchaseBase = base.purchaseAmount > 0 ? base.purchaseAmount : base.cost;
  const outputRate = revenue > 0 ? base.vatOutputTax / revenue : 0;
  const inputRate = purchaseBase > 0 ? base.vatInputTax / purchaseBase : 0;
  if (outputRate > 0 && inputRate > 0 && inputRate > outputRate + 0.02) {
    risks.push({
      code: 'TAX-RISK-VAT-RATE-INVERSION',
      level: 'warning',
      title: '进项税率高于销项税率（倒挂）',
      detail:
        '销项税额 ' + yuan(base.vatOutputTax) + ' 元 ÷ 营业收入 ' + yuan(revenue) + ' 元 = 平均销项税率 ' +
        pct(outputRate) + '；进项税额 ' + yuan(base.vatInputTax) + ' 元 ÷ 采购额 ' +
        yuan(purchaseBase) + ' 元 = 平均进项税率 ' + pct(inputRate) + '，高于销项 ' +
        pct(inputRate - outputRate) + '。',
      suggestion:
        '核查是否存在高税率采购、低税率销售的业务实质（如将 13% 货物按 6% 服务开票），' +
        '或采购额归集不全导致比率失真；税率适用错误会被认定为申报不实',
      basis: [LAW_BASIS.vatLaw, LAW_BASIS.vatGeneralRules],
      metrics: {
        outputTax: base.vatOutputTax,
        inputTax: base.vatInputTax,
        revenue,
        purchaseBase,
        outputRate,
        inputRate,
      },
    });
  }

  /* ---------------- 3. 长期留抵 ---------------- */
  const closingCredit = lineAmount(vatReturn, '20');
  if (closingCredit > 0) {
    const openingCredit = Math.max(0, input.carryforward?.vatCreditCarryforward ?? 0);
    const ratio = revenue > 0 ? closingCredit / revenue : 1;
    const persistent = openingCredit > 0 && closingCredit >= openingCredit;
    const level: Severity = persistent || ratio > 0.2 ? 'warning' : 'info';
    risks.push({
      code: 'TAX-RISK-VAT-CREDIT-STUCK',
      level,
      title: persistent ? '留抵税额持续挂账未消化' : '期末留抵税额较大',
      detail:
        period + ' 期末留抵税额 ' + yuan(closingCredit) + ' 元' +
        (openingCredit > 0 ? '，期初留抵 ' + yuan(openingCredit) + ' 元' : '') +
        (revenue > 0 ? '，占本期营业收入 ' + pct(ratio) : '') +
        '。留抵税额长期挂账会占用企业资金，也可能引起税务机关对进项真实性的关注。',
      suggestion:
        '核查是否存在应转出未转出的进项（如用于集体福利、免税项目）、' +
        '是否存在长期无销售只有采购的情形；符合条件的可申请留抵退税，' +
        '但需满足纳税信用等级、无骗取留抵退税记录等条件',
      basis: [LAW_BASIS.vatLaw, LAW_BASIS.taxCollectionLaw],
      metrics: { closingCredit, openingCredit, revenue, creditToRevenue: ratio },
    });
  }

  /* ---------------- 4. 发票顶额开具 ---------------- */
  const ceilingHits: number[] = [];
  const amountCounter = new Map<number, number>();
  for (const voucher of input.vouchers) {
    for (const line of voucher.lines) {
      const amount = Math.max(line.debit, line.credit);
      if (amount < 9_999_999) continue;
      amountCounter.set(amount, (amountCounter.get(amount) ?? 0) + 1);
      for (const ceiling of INVOICE_CEILINGS) {
        if (Math.abs(amount - ceiling) <= 100) {
          ceilingHits.push(amount);
          break;
        }
      }
    }
  }
  let repeatedAmount = 0;
  let repeatedCount = 0;
  for (const [amount, count] of amountCounter) {
    if (count >= 3 && count > repeatedCount) {
      repeatedAmount = amount;
      repeatedCount = count;
    }
  }
  if (ceilingHits.length >= 2 || repeatedCount >= 3) {
    risks.push({
      code: 'TAX-RISK-INVOICE-CEILING',
      level: 'warning',
      title: '发票顶额开具或大额整数重复开具',
      detail:
        (ceilingHits.length >= 2
          ? '本期有 ' + ceilingHits.length + ' 笔分录金额紧贴发票版面限额（如十万元版 99,999.99 元、百万元版 999,999.99 元）；'
          : '') +
        (repeatedCount >= 3
          ? '同一金额 ' + yuan(repeatedAmount) + ' 元重复出现 ' + repeatedCount + ' 次；'
          : '') +
        '顶额、整数、同额重复开票是虚开风险的典型特征，也容易被稽查系统标记。',
      suggestion:
        '核查对应的合同、出入库单、验收单与资金流是否三流一致；' +
        '确认交易真实、金额确为合同约定，而非为凑额度拆分或合并开票；' +
        '留存完整的业务证据链备查',
      basis: [LAW_BASIS.invoiceMeasures, LAW_BASIS.taxCollectionLaw],
      metrics: {
        ceilingHitCount: ceilingHits.length,
        repeatedAmount,
        repeatedCount,
      },
    });
  }

  /* ---------------- 5. 收入与成本匹配异常 ---------------- */
  if (revenue > 0) {
    const grossMargin = (revenue - base.cost) / revenue;
    if (grossMargin < -0.2 || grossMargin > 0.95) {
      risks.push({
        code: 'TAX-RISK-REVENUE-COST-MISMATCH',
        level: 'warning',
        title: grossMargin < -0.2 ? '收入成本倒挂（毛利率为负）' : '毛利率异常偏高',
        detail:
          '营业收入 ' + yuan(revenue) + ' 元，营业成本 ' + yuan(base.cost) + ' 元，毛利率 ' +
          pct(grossMargin) + '。' +
          (grossMargin < -0.2
            ? '成本明显高于收入，可能存在成本多结转、收入少确认或存货计价错误。'
            : '成本占比过低，可能存在成本未及时结转、收入跨期确认或存货账实不符。'),
        suggestion:
          '核对存货收发存台账与成本结转凭证，确认收入确认时点符合会计准则；' +
          '若属行业特殊性（如软件企业），请在附注中说明',
        basis: [LAW_BASIS.citLaw, LAW_BASIS.taxCollectionLaw],
        metrics: { revenue, cost: base.cost, grossMargin },
      });
    }
  }

  /* ---------------- 6. 社保与工资不匹配 ---------------- */
  if (base.wages > 0) {
    const socialTotal = base.socialInsurance + base.housingFund;
    const ratio = socialTotal / base.wages;
    if (ratio < 0.1 || ratio > 0.6) {
      risks.push({
        code: 'TAX-RISK-PAYROLL-SOCIAL',
        level: 'warning',
        title: ratio < 0.1 ? '社保公积金缴纳与工资总额明显不匹配' : '社保公积金占工资比例异常偏高',
        detail:
          '工资薪金总额 ' + yuan(base.wages) + ' 元，单位承担社保 ' + yuan(base.socialInsurance) +
          ' 元、公积金 ' + yuan(base.housingFund) + ' 元，合计占比 ' + pct(ratio) + '。' +
          (ratio < 0.1
            ? '正常企业单位社保公积金负担一般在工资总额的 25%~40%，占比过低通常意味着未足额参保或工资未通过应付职工薪酬核算。'
            : '占比明显偏高，可能存在将其他费用计入社保，或工资总额归集不全。'),
        suggestion:
          '核对社保申报基数与工资表是否一致，确认是否存在按最低基数缴纳、' +
          '劳务派遣/外包人员混入工资表等情形；社保入税后，工资、个税、社保三表比对是常规检查项',
        basis: [LAW_BASIS.taxCollectionLaw, LAW_BASIS.citRegulation],
        metrics: {
          wages: base.wages,
          socialInsurance: base.socialInsurance,
          housingFund: base.housingFund,
          ratio,
        },
      });
    }
  }

  /* ---------------- 7. 零申报但有大额流水 ---------------- */
  if (vatPayable === 0 && base.bankInflow >= 100_000_000) {
    risks.push({
      code: 'TAX-RISK-ZERO-FILING',
      level: 'warning',
      title: '增值税零申报但银行流水较大',
      detail:
        period + ' 应纳增值税为 0，但银行存款借方发生额（资金流入）达 ' + yuan(base.bankInflow) +
        ' 元，营业收入 ' + yuan(revenue) + ' 元。零申报与资金流规模不匹配，是税务系统重点比对项。',
      suggestion:
        '区分资金性质：往来借款、股东投入、代收代付不属于应税收入，应保留合同与流水说明；' +
        '若存在未开票收入，需按规定补做未开票收入申报；' +
        '零申报连续超过 6 个月可能被认定为非正常户',
      basis: [LAW_BASIS.taxCollectionLaw, LAW_BASIS.vatLaw],
      metrics: { vatPayable, bankInflow: base.bankInflow, revenue },
    });
  }

  /* ---------------- 8. 有工资无个税 ---------------- */
  const iitReturn = findReturn(returns, 'iit');
  const iitPayable = iitReturn === undefined ? 0 : iitReturn.payable;
  if (base.wages > 0 && iitPayable === 0) {
    const employees = taxpayer.employees ?? 0;
    const averageWage = employees > 0 ? Math.round(base.wages / employees) : base.wages;
    if (averageWage > 500_000) {
      risks.push({
        code: 'TAX-RISK-IIT-MISSING',
        level: 'info',
        title: '工资总额较大但本期未预扣个人所得税',
        detail:
          '工资薪金总额 ' + yuan(base.wages) + ' 元' +
          (employees > 0 ? '，从业人数 ' + employees + ' 人，人均 ' + yuan(averageWage) + ' 元' : '') +
          '，但本期个人所得税预扣预缴税额为 0。人均工资已超过 5000 元/月的基本减除费用标准。',
        suggestion:
          '核对工资表是否已全员全额扣缴申报；若因专项附加扣除、免税收入导致确实无需预扣，' +
          '请保留扣除凭证；未按规定扣缴个税，扣缴义务人将被处应扣未扣税款 50%~3 倍罚款',
        basis: [LAW_BASIS.iitWithholding61, LAW_BASIS.taxCollectionLaw],
        metrics: { wages: base.wages, employees, averageWage, iitPayable },
      });
    }
  }

  risks.sort((a, b) => SEVERITY_ORDER[a.level] - SEVERITY_ORDER[b.level]);
  return risks;
}

/** 风险汇总：按严重程度计数。 */
export function summarizeRisks(risks: readonly TaxRiskItem[]): Record<Severity, number> {
  const summary: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const r of risks) summary[r.level] += 1;
  return summary;
}

/** 是否有阻断级风险。 */
export function hasBlockingRisk(risks: readonly TaxRiskItem[]): boolean {
  return risks.some((r) => r.level === 'error');
}
