/**
 * 印花税。
 *
 * 为什么按「税目 × 计税金额」而不是直接收一个总额：
 *  印花税法按税目分别适用比例税率（买卖合同万分之三、借款合同万分之零点五、
 *  租赁合同千分之一……），不同税目的税率相差 20 倍。把合同混在一起按一个
 *  税率算，必然要么少缴要么多缴。因此本模块强制按税目传入金额，
 *  逐税目计算后再合计，申报表也能逐行对上。
 *
 * 两个容易漏的点：
 *  1. 计税依据不含列明的增值税税款（财政部 税务总局公告2022年第22号）；
 *  2. 证券交易印花税不参与「六税两费」减半（财政部 税务总局公告2023年第12号）。
 */

import type { Cents, Period, TaxLine } from '../core/contracts.ts';
import { formatYuanGrouped } from '../core/money.ts';

import type { StampContractType, TaxRates } from './rates.ts';
import {
  LAW_BASIS,
  STAMP_ITEM_LIST,
  STAMP_ITEM_META,
  defaultTaxRates,
  formatRate,
  halfCents,
  isPolicyKeyEffective,
  roundRate,
} from './rates.ts';

function yuan(cents: Cents): string {
  return formatYuanGrouped(cents);
}

/** 一笔应税凭证。 */
export interface StampContractItem {
  type: StampContractType;
  /** 计税金额（分，不含列明的增值税） */
  amount: Cents;
  /** 合同号/对方单位，写入栏次说明便于核对 */
  label?: string;
}

/** 印花税计算输入。 */
export interface StampComputeInput {
  period: Period;
  items: readonly StampContractItem[];
  /** 是否增值税小规模纳税人 */
  smallScale?: boolean;
  /** 是否小型微利企业 */
  smallLowProfit?: boolean;
  /** 是否享受六税两费减半；不传则按身份自动判定 */
  halfReduction?: boolean;
  /** 本期已预缴（分） */
  prepaid?: Cents;
}

/** 单个税目的计算结果。 */
export interface StampTypeResult {
  type: StampContractType;
  label: string;
  rate: number;
  amount: Cents;
  /** 减半前税额（分） */
  fullTax: Cents;
  /** 实际税额（分） */
  tax: Cents;
  halved: boolean;
}

/** 印花税计算结果。 */
export interface StampComputeResult {
  lines: TaxLine[];
  byType: StampTypeResult[];
  /** 应纳印花税合计（分） */
  total: Cents;
  halfReduction: boolean;
  prepaid: Cents;
  due: Cents;
  notes: string[];
}

/**
 * 计算印花税。
 *
 * @param input 按税目拆分的应税凭证金额
 * @param rates 税率表
 */
export function computeStampDuty(
  input: StampComputeInput,
  rates: TaxRates = defaultTaxRates(),
): StampComputeResult {
  const notes: string[] = [];
  const policyActive = isPolicyKeyEffective(input.period, 'sixTaxesHalf');
  const eligible = input.smallScale === true || input.smallLowProfit === true;
  const halfReduction = policyActive && (input.halfReduction ?? eligible);

  // 按税目归并，保持税目表顺序，便于与申报表逐行核对
  const amountByType = new Map<StampContractType, Cents>();
  for (const item of input.items) {
    if (item.amount === 0) continue;
    if (item.amount < 0) {
      notes.push('税目「' + STAMP_ITEM_META[item.type].label + '」出现负数金额，已按 0 处理，请核对红字合同');
      continue;
    }
    amountByType.set(item.type, (amountByType.get(item.type) ?? 0) + item.amount);
  }

  const byType: StampTypeResult[] = [];
  for (const type of STAMP_ITEM_LIST) {
    const amount = amountByType.get(type);
    if (amount === undefined || amount === 0) continue;
    const meta = STAMP_ITEM_META[type];
    const rate = rates.stamp.rates[type];
    const fullTax = roundRate(amount, rate);
    const halved = halfReduction && meta.halfEligible;
    const tax = halved ? halfCents(fullTax) : fullTax;
    byType.push({ type, label: meta.label, rate, amount, fullTax, tax, halved });
  }

  const total = byType.reduce((sum, item) => sum + item.tax, 0);
  const fullTotal = byType.reduce((sum, item) => sum + item.fullTax, 0);
  const reductionAmount = fullTotal - total;
  const prepaid = Math.max(0, input.prepaid ?? 0);
  const due = total - prepaid;

  const lines: TaxLine[] = [];
  for (const item of byType) {
    lines.push({
      code: 'STAMP-' + item.type.toUpperCase(),
      label: item.label,
      amount: item.tax,
      rate: item.rate,
      note:
        item.label + ' = 计税金额 ' + yuan(item.amount) + ' × ' + formatRate(item.rate) +
        ' = ' + yuan(item.fullTax) + ' 元' +
        (item.halved ? '，六税两费减半后 ' + yuan(item.tax) + ' 元' : '') +
        '（计税依据：' + STAMP_ITEM_META[item.type].taxableBase + '，四舍五入到分）',
      basis: [STAMP_ITEM_META[item.type].basis, LAW_BASIS.stampPolicy22],
    });
  }

  if (byType.length === 0) {
    lines.push({
      code: 'STAMP-NONE',
      label: '本期无应税凭证',
      amount: 0,
      note: '未识别到本期应税合同或应税凭证，印花税为 0；如实际签订合同请补录后再申报',
      basis: [LAW_BASIS.stampLaw],
    });
  }

  if (reductionAmount > 0) {
    lines.push({
      code: 'tax_reduction',
      label: '六税两费减免税额',
      amount: reductionAmount,
      note:
        '六税两费减半共减免印花税 ' + yuan(reductionAmount) + ' 元（减半前 ' + yuan(fullTotal) +
        ' 元 - 减半后 ' + yuan(total) + ' 元），证券交易印花税不参与减半',
      basis: [LAW_BASIS.sixTaxesHalf12],
    });
  }

  lines.push({
    code: 'STAMP-TOTAL',
    label: '印花税合计',
    amount: total,
    note:
      '印花税合计 = ' +
      (byType.length === 0
        ? '无应税凭证，合计 0 元'
        : byType.map((i) => i.label + ' ' + yuan(i.tax)).join(' + ') + ' = ' + yuan(total) + ' 元'),
    basis: [LAW_BASIS.stampLaw],
  });

  lines.push({
    code: 'STAMP-DUE',
    label: '本期应补(退)税额',
    amount: due,
    note: '本期应补(退)税额 = 合计 ' + yuan(total) + ' - 已预缴 ' + yuan(prepaid) + ' = ' + yuan(due) + ' 元',
    basis: [LAW_BASIS.taxCollectionLaw],
  });

  if (halfReduction) {
    const ineligible = byType.filter((i) => !i.halved && STAMP_ITEM_META[i.type].halfEligible === false);
    if (ineligible.length > 0) {
      notes.push('证券交易印花税不适用六税两费减半，已按全额计算');
    }
  } else if (eligible && !policyActive) {
    notes.push('当前期间不在六税两费减半政策窗口（2023-01-01 至 2027-12-31）内，按全额计算');
  }

  return { lines, byType, total, halfReduction, prepaid, due, notes };
}
