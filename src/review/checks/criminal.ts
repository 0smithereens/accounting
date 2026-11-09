/**
 * 刑事红线检查。
 *
 * 这一层最重，也最容易写坏：把「风险提示」写成「定罪结论」会误导用户，
 * 把「金额算错」写成「逃税」会制造恐慌。因此本模块遵守三条自我约束：
 *  1. 只做**形式要件**测算（金额、比例、时限、单据链），不判断主观故意；
 *  2. 每条结论都附固定免责声明，明确「不构成法律意见，是否构成犯罪由司法机关认定」；
 *  3. 数据不足时宁可不出结论：例如没有已申报记录，就不做「少缴税款」测算，
 *     因为未申报属于程序违法（由 TAX-DRAFT-001 处理），不能直接推定逃税故意。
 *
 * 逃税测算口径（与税务模块的约定）：
 *  - 应纳税额 = 各税种申报表 payable 之和（取同一期间同一税种的最高版本）；
 *  - 少缴税额 = 申报表明示的「少缴税额」行；否则取「已申报（filed）」记录的
 *    max(0, payable − 实缴金额)，实缴金额优先取人工回执的 paidAmount，缺失时取 prepaid；
 *  - 比例 = 少缴税额 ÷ 应纳税额；
 *  - 未申报、草稿状态的记录不计入少缴，避免把「还没报」误判为「逃」。
 *
 * 阈值说明：本系统采用 5 万元 / 10% 的**预警口径**，严于《法释〔2024〕4 号》
 * 10 万元「数额较大」的入罪标准。理由是企业内部自查应当比司法机关更早、更严地报警，
 * 但报告中必须写明这一差异，不能让用户误以为 5 万元就构成犯罪。
 */

import type {
  Cents,
  DocumentRecord,
  LawBasis,
  Period,
  ReviewContext,
  ReviewFinding,
  ReviewInput,
  ReviewTarget,
  TaxReturn,
  TaxType,
} from '../../core/contracts.ts';
import { formatYuan, sumCents } from '../../core/money.ts';
import { addDays } from '../../core/datetime.ts';
import { normalizeOrgName } from '../../core/text.ts';
import {
  CRIMINAL_DISCLAIMER,
  LAW_ACCOUNTING_LAW_9,
  LAW_CRIMINAL_201,
  LAW_CRIMINAL_205,
  LAW_CRIMINAL_205_1,
  LAW_CRIMINAL_211,
  LAW_INVOICE_MEASURES_21,
  LAW_JUDICIAL_2024_4,
  LAW_TAX_COLLECTION_63,
} from '../legal.ts';
import { findTaxLine, latestTaxReturns } from './tax.ts';
import type { CheckDefinition } from '../engine.ts';

/* ================================================================== */
/* 一、规则 id 与阈值                                                  */
/* ================================================================== */

export const CRIMINAL_RULE_IDS = {
  taxEvasion: 'CRIM-TAX-001',
  taxEvasionSevere: 'CRIM-TAX-002',
  invoiceRisk: 'CRIM-INVOICE-001',
  threeFlows: 'CRIM-INVOICE-002',
} as const;

/**
 * 刑事风险阈值（单位：分）。
 * 5 万元 / 50 万元来自《法释〔2024〕4 号》的 10 万元 / 50 万元标准下调一档作为预警线，
 * 其中 5 万元为更保守的自查线（历史上 2010 年司法解释的「数额较大」标准也是 5 万元）。
 */
export const CRIMINAL_THRESHOLDS = {
  /** 预警线：少缴税额 5 万元 */
  evadedTaxCents: 5_000_000,
  /** 数额巨大：50 万元 */
  evadedTaxHugeCents: 50_000_000,
  /** 立案比例：10% */
  ratioMin: 0.1,
  /** 加重比例：30% */
  ratioSevere: 0.3,
} as const;

/** 大额进项预警线：单供应商 30 天内累计 100 万元。 */
const LARGE_INPUT_CENTS = 100_000_000;
const LARGE_INPUT_WINDOW_DAYS = 30;

/** 三流一致性比对参数。 */
const FLOW_WINDOW_DAYS = 90;
const FLOW_MIN_TOLERANCE_CENTS = 10_000; // 100 元
const FLOW_TOLERANCE_RATE = 0.05;
const CONTRACT_TOLERANCE_RATE = 0.2;

/* ================================================================== */
/* 二、工具                                                            */
/* ================================================================== */

function makeFinding(
  ctx: ReviewContext,
  ruleId: string,
  target: ReviewTarget,
  title: string,
  detail: string,
  suggestion: string,
  basis: LawBasis[],
  evidence?: Record<string, unknown>,
): ReviewFinding {
  const finding: ReviewFinding = {
    id: ctx.nextId(),
    ruleId,
    severity: 'error',
    category: 'criminal_law',
    title,
    detail,
    suggestion,
    basis,
    target,
    blocking: false,
  };
  if (evidence !== undefined) finding.evidence = evidence;
  return finding;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

function fieldText(document: DocumentRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = document.fields[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

const LOGISTICS_FIELDS = [
  'logisticsNo',
  'waybillNo',
  'trackingNo',
  'expressNo',
  'transportNo',
  'deliveryNo',
  '验收单号',
  '物流单号',
];

function sameOrg(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  const left = normalizeOrgName(a);
  const right = normalizeOrgName(b);
  if (left === right) return true;
  return left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left));
}

function isInputInvoice(document: DocumentRecord): boolean {
  const side = document.fields['invoiceSide'];
  if (side === 'input') return true;
  if (side === 'output') return false;
  return document.direction === 'out';
}

interface DatedDocument extends DocumentRecord {
  date: string;
}

function isDated(document: DocumentRecord): document is DatedDocument {
  return document.date !== null;
}

/* ================================================================== */
/* 三、逃税测算                                                        */
/* ================================================================== */

export interface TaxExposureDetail {
  returnId: string;
  taxType: TaxType;
  period: Period;
  evaded: Cents;
  reason: string;
}

export interface TaxExposure {
  /** 应纳税额合计（分） */
  totalTax: Cents;
  /** 测算少缴税额（分） */
  evaded: Cents;
  /** 少缴比例（0-1） */
  ratio: number;
  details: TaxExposureDetail[];
}

const EVADED_CODES = ['evaded_tax', 'tax_evaded', '少缴税额', '逃避缴纳税款'];
const EVADED_KEYWORDS = ['逃避缴纳税款', '少缴税款', '少缴税额'];

/**
 * 测算逃税风险敞口。
 *
 * 只统计「已申报但少缴」与「申报表明示少缴」，不统计未申报/草稿：
 * 未申报是程序问题（TAX-DRAFT-001 阻断），不等于刑法意义上的逃税。
 */
export function measureTaxExposure(returns: readonly TaxReturn[]): TaxExposure {
  const latest = latestTaxReturns(returns);
  let totalTax = 0;
  let evaded = 0;
  const details: TaxExposureDetail[] = [];

  for (const record of latest) {
    totalTax += Math.max(0, record.payable);

    const explicit = findTaxLine(record.lines, EVADED_CODES, EVADED_KEYWORDS);
    if (explicit !== undefined && explicit.amount > 0) {
      evaded += explicit.amount;
      details.push({
        returnId: record.id,
        taxType: record.taxType,
        period: record.period,
        evaded: explicit.amount,
        reason: '申报表明示少缴税额',
      });
      continue;
    }

    if (record.status !== 'filed') continue;

    const paid = record.manualFiling !== undefined ? record.manualFiling.paidAmount : record.prepaid;
    const shortfall = Math.max(0, record.payable - paid);
    if (shortfall === 0) continue;

    evaded += shortfall;
    details.push({
      returnId: record.id,
      taxType: record.taxType,
      period: record.period,
      evaded: shortfall,
      reason:
        record.manualFiling !== undefined
          ? '已申报但实缴金额小于应纳税额'
          : '已申报但缺少回执，按已预缴金额测算',
    });
  }

  return {
    totalTax,
    evaded,
    ratio: totalTax > 0 ? evaded / totalTax : 0,
    details,
  };
}

function exposureTarget(exposure: TaxExposure, period: Period): ReviewTarget {
  const largest = [...exposure.details].sort((a, b) => b.evaded - a.evaded)[0];
  if (largest === undefined) {
    return { kind: 'run', id: `tax-exposure:${period}`, label: `税款风险测算 ${period}` };
  }
  return {
    kind: 'tax_return',
    id: largest.returnId,
    label: `税款风险测算 ${period}`,
  };
}

/* ================================================================== */
/* 四、检查项                                                          */
/* ================================================================== */

/** CRIM-TAX-001：比例 ≥ 10% 且数额 ≥ 5 万元。 */
function checkTaxEvasion(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const exposure = measureTaxExposure(input.taxReturns ?? []);
  const { evadedTaxCents, ratioMin } = CRIMINAL_THRESHOLDS;

  if (exposure.evaded < evadedTaxCents || exposure.ratio < ratioMin) return [];

  const detailList = exposure.details
    .map(
      (item) =>
        `${item.taxType} ${item.period}：少缴 ${formatYuan(item.evaded)} 元（${item.reason}）`,
    )
    .join('；');

  return [
    makeFinding(
      ctx,
      CRIMINAL_RULE_IDS.taxEvasion,
      exposureTarget(exposure, ctx.period),
      '逃避缴纳税款风险达到刑事立案形式要件',
      `按本期可获取的申报数据测算：应纳税额合计 ${formatYuan(exposure.totalTax)} 元，` +
        `少缴税额 ${formatYuan(exposure.evaded)} 元，占应纳税额 ${formatPercent(exposure.ratio)}。` +
        `明细：${detailList}。` +
        `该情形已达到《刑法》第二百零一条第一款「逃避缴纳税款数额较大并且占应纳税额百分之十以上」的形式要件。` +
        `（口径说明：本系统采用 ${formatYuan(evadedTaxCents)} 元 / ${formatPercent(ratioMin)} 的预警口径，` +
        '严于《最高人民法院、最高人民检察院关于办理危害税收征管刑事案件适用法律若干问题的解释》' +
        '（法释〔2024〕4 号）十万元的「数额较大」入罪标准；本提示不代表已构成犯罪。）' +
        `补救提示：首次实施该行为，经税务机关依法下达追缴通知后，补缴应纳税款、缴纳滞纳金并已受行政处罚的，` +
        `不予追究刑事责任（《刑法》第二百零一条第四款）；但五年内因逃避缴纳税款受过刑事处罚` +
        `或者被税务机关给予二次以上行政处罚的除外。${CRIMINAL_DISCLAIMER}`,
      '立即启动自查：核对各税种申报收入与账簿收入、进项抵扣与发票流、成本费用扣除凭证；' +
        '在税务机关下达追缴通知前主动补缴税款与滞纳金，并保留完整的补缴凭证与内部审批记录。' +
        '建议由税务师或律师出具专业意见后再与税务机关沟通。系统不会、也不得代替企业向税务机关提交任何材料。',
      [LAW_CRIMINAL_201, LAW_JUDICIAL_2024_4, LAW_TAX_COLLECTION_63],
      {
        totalTax: exposure.totalTax,
        evaded: exposure.evaded,
        ratio: exposure.ratio,
        thresholds: CRIMINAL_THRESHOLDS,
        details: exposure.details,
      },
    ),
  ];
}

/** CRIM-TAX-002：比例 ≥ 30% 且数额巨大（50 万元以上）。 */
function checkTaxEvasionSevere(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const exposure = measureTaxExposure(input.taxReturns ?? []);
  const { evadedTaxHugeCents, ratioSevere } = CRIMINAL_THRESHOLDS;

  if (exposure.evaded < evadedTaxHugeCents || exposure.ratio < ratioSevere) return [];

  return [
    makeFinding(
      ctx,
      CRIMINAL_RULE_IDS.taxEvasionSevere,
      exposureTarget(exposure, ctx.period),
      '逃避缴纳税款达到「数额巨大且比例 30% 以上」加重档',
      `按本期可获取的申报数据测算：应纳税额合计 ${formatYuan(exposure.totalTax)} 元，` +
        `少缴税额 ${formatYuan(exposure.evaded)} 元，占应纳税额 ${formatPercent(exposure.ratio)}，` +
        `已达到「数额巨大（${formatYuan(evadedTaxHugeCents)} 元以上）且占应纳税额 30% 以上」的加重情形。` +
        '对应《刑法》第二百零一条第一款后段的量刑区间：三年以上七年以下有期徒刑，并处罚金。' +
        '单位犯罪的，对单位判处罚金，并对其直接负责的主管人员和其他直接责任人员依照上述规定处罚（《刑法》第二百一十一条）。' +
        `本提示为风险测算，不构成量刑意见，最终由司法机关依法裁判。${CRIMINAL_DISCLAIMER}`,
      '在专业律师指导下立即停止相关行为、保存全部账簿与申报资料（不得销毁、篡改），' +
        '评估主动补缴与合规整改方案；不得以任何方式干扰税务稽查或转移资产。',
      [LAW_CRIMINAL_201, LAW_CRIMINAL_211, LAW_JUDICIAL_2024_4, LAW_TAX_COLLECTION_63],
      {
        totalTax: exposure.totalTax,
        evaded: exposure.evaded,
        ratio: exposure.ratio,
        thresholds: CRIMINAL_THRESHOLDS,
        details: exposure.details,
        sentencing: '三年以上七年以下有期徒刑，并处罚金',
      },
    ),
  ];
}

/** CRIM-INVOICE-001：同一供应商短期大额进项，无合同/无物流。 */
function checkInvoiceRisk(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const documents = input.documents ?? [];
  const invoices = documents.filter((item) => item.kind === 'invoice' && isInputInvoice(item));
  if (invoices.length === 0) return [];

  const groups = new Map<string, DocumentRecord[]>();
  for (const invoice of invoices) {
    const name = (invoice.counterparty ?? '').trim();
    const key = name === '' ? '__unknown__' : normalizeOrgName(name);
    const bucket = groups.get(key) ?? [];
    bucket.push(invoice);
    groups.set(key, bucket);
  }

  const contracts = documents.filter((item) => item.kind === 'contract');
  const findings: ReviewFinding[] = [];

  for (const list of groups.values()) {
    const dated = list.filter(isDated);
    if (dated.length === 0) continue;

    let best: { total: Cents; from: string; to: string; items: DatedDocument[] } = {
      total: 0,
      from: '',
      to: '',
      items: [],
    };

    for (const anchor of dated) {
      const from = addDays(anchor.date, -LARGE_INPUT_WINDOW_DAYS);
      const windowItems = dated.filter((item) => item.date >= from && item.date <= anchor.date);
      const total = sumCents(windowItems.map((item) => item.amount));
      if (total > best.total) {
        best = { total, from, to: anchor.date, items: windowItems };
      }
    }

    if (best.total < LARGE_INPUT_CENTS) continue;

    const supplierName = best.items[0]?.counterparty ?? list[0]?.counterparty ?? '未知供应商';
    const hasContract = contracts.some((contract) => sameOrg(contract.counterparty ?? '', supplierName));
    const hasLogistics = best.items.some((invoice) => fieldText(invoice, LOGISTICS_FIELDS) !== '');
    // 只有合同与物流「同时缺失」才报：服务类发票天然没有运单，
    // 单凭「无物流」就报虚开会制造大量误报，反而让真正的风险被淹没。
    if (hasContract || hasLogistics) continue;

    const missing: string[] = [];
    if (!hasContract) missing.push('未见与该供应商对应的合同');
    if (!hasLogistics) missing.push('发票台账未提供物流/验收单据信息');

    const anchor = [...best.items].sort((a, b) => b.amount - a.amount)[0] ?? best.items[0];
    if (anchor === undefined) continue;

    findings.push(
      makeFinding(
        ctx,
        CRIMINAL_RULE_IDS.invoiceRisk,
        { kind: 'document', id: anchor.id, label: `供应商 ${supplierName}` },
        '大额进项缺乏合同流与货物流支撑（虚开风险）',
        `供应商「${supplierName}」在 ${best.from} 至 ${best.to} 的 ${LARGE_INPUT_WINDOW_DAYS} 天内，` +
          `系统识别到 ${best.items.length} 张进项发票，价税合计 ${formatYuan(best.total)} 元；${missing.join('，')}。` +
          '大额进项缺乏合同与物流支撑，是虚开增值税专用发票或接受虚开发票的典型特征之一；' +
          '一旦被认定为虚开，除补税、滞纳金、罚款外，还可能触及《刑法》第二百零五条（虚开增值税专用发票罪）' +
          '或第二百零五条之一（虚开其他发票罪）。' +
          `本提示基于单据链完整性，不代表已认定虚开。${CRIMINAL_DISCLAIMER}`,
        '补充并留存合同、订单、入库单/验收单、物流单据、银行付款凭证，确保合同流、货物流、资金流、发票流一致；' +
          '无法提供上述资料的，应作进项税额转出，并主动向主管税务机关说明情况。' +
          '在事实查清前，不得继续抵扣或对外开具相关发票。',
        [LAW_INVOICE_MEASURES_21, LAW_CRIMINAL_205, LAW_CRIMINAL_205_1, LAW_TAX_COLLECTION_63],
        {
          supplier: supplierName,
          from: best.from,
          to: best.to,
          windowDays: LARGE_INPUT_WINDOW_DAYS,
          invoiceCount: best.items.length,
          total: best.total,
          hasContract,
          hasLogistics,
          invoiceIds: best.items.map((item) => item.id),
          threshold: LARGE_INPUT_CENTS,
        },
      ),
    );
  }

  return findings;
}

interface FlowGroup {
  supplier: string;
  side: 'input' | 'output';
  invoices: DocumentRecord[];
}

function groupInvoicesForFlow(invoices: readonly DocumentRecord[]): FlowGroup[] {
  const map = new Map<string, FlowGroup>();
  for (const invoice of invoices) {
    const name = (invoice.counterparty ?? '').trim();
    if (name === '') continue;
    const side: 'input' | 'output' = isInputInvoice(invoice) ? 'input' : 'output';
    const key = `${normalizeOrgName(name)}|${side}`;
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, { supplier: name, side, invoices: [invoice] });
    } else {
      existing.invoices.push(invoice);
    }
  }
  return [...map.values()];
}

/** CRIM-INVOICE-002：发票流、资金流、合同流不一致。 */
function checkThreeFlows(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const documents = input.documents ?? [];
  const invoices = documents.filter((item) => item.kind === 'invoice');
  if (invoices.length === 0) return [];

  const banks = documents.filter((item) => item.kind === 'bank');
  const contracts = documents.filter((item) => item.kind === 'contract');
  const findings: ReviewFinding[] = [];

  for (const group of groupInvoicesForFlow(invoices)) {
    const invoiceTotal = sumCents(group.invoices.map((item) => item.amount));
    if (invoiceTotal <= 0) continue;

    const dated = group.invoices.filter(isDated);
    const dates = dated.map((item) => item.date).sort();
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];

    let bankTotal = 0;
    let bankCount = 0;
    if (firstDate !== undefined && lastDate !== undefined) {
      const from = addDays(firstDate, -FLOW_WINDOW_DAYS);
      const to = addDays(lastDate, FLOW_WINDOW_DAYS);
      const expectedDirection = group.side === 'input' ? 'out' : 'in';
      const matchedBanks = banks.filter((bank) => {
        if (bank.date === null || bank.date < from || bank.date > to) return false;
        if (bank.direction !== expectedDirection) return false;
        return sameOrg(bank.counterparty ?? '', group.supplier);
      });
      bankTotal = sumCents(matchedBanks.map((item) => item.amount));
      bankCount = matchedBanks.length;
    }

    const matchedContracts = contracts.filter((contract) =>
      sameOrg(contract.counterparty ?? '', group.supplier),
    );
    const contractTotal = sumCents(matchedContracts.map((item) => item.amount));

    const mismatches: string[] = [];

    const bankTolerance = Math.max(FLOW_MIN_TOLERANCE_CENTS, Math.round(invoiceTotal * FLOW_TOLERANCE_RATE));
    if (bankTotal > 0 && Math.abs(bankTotal - invoiceTotal) > bankTolerance) {
      mismatches.push(
        `资金流 ${formatYuan(bankTotal)} 元与发票流 ${formatYuan(invoiceTotal)} 元相差 ` +
          `${formatYuan(bankTotal - invoiceTotal)} 元（容差 ${formatYuan(bankTolerance)} 元）`,
      );
    }

    const contractTolerance = Math.max(
      FLOW_MIN_TOLERANCE_CENTS,
      Math.round(invoiceTotal * CONTRACT_TOLERANCE_RATE),
    );
    if (contractTotal > 0 && Math.abs(contractTotal - invoiceTotal) > contractTolerance) {
      mismatches.push(
        `合同流 ${formatYuan(contractTotal)} 元与发票流 ${formatYuan(invoiceTotal)} 元相差 ` +
          `${formatYuan(contractTotal - invoiceTotal)} 元（容差 ${formatYuan(contractTolerance)} 元）`,
      );
    }

    if (mismatches.length === 0) continue;

    const hasLogistics = group.invoices.some((invoice) => fieldText(invoice, LOGISTICS_FIELDS) !== '');
    const logisticsNote = hasLogistics ? '' : '；发票台账亦未提供物流/验收单据信息，货物流无法验证';

    const anchor = [...group.invoices].sort((a, b) => b.amount - a.amount)[0];
    if (anchor === undefined) continue;

    findings.push(
      makeFinding(
        ctx,
        CRIMINAL_RULE_IDS.threeFlows,
        { kind: 'document', id: anchor.id, label: `${group.side === 'input' ? '供应商' : '客户'} ${group.supplier}` },
        '发票流、资金流、合同流不一致',
        `${group.side === 'input' ? '供应商' : '客户'}「${group.supplier}」：发票 ${group.invoices.length} 张、` +
          `价税合计 ${formatYuan(invoiceTotal)} 元；${mismatches.join('；')}` +
          `（同期匹配资金流水 ${bankCount} 笔、合同 ${matchedContracts.length} 份）${logisticsNote}。` +
          '三流不一致是税务稽查重点：可能被认定为虚开、接受虚开或未按规定确认收入。' +
          '若差异源于分期付款、预付款、框架合同或跨期结算，应补充说明与佐证材料。' +
          `本提示基于金额比对，不代表已认定违法。${CRIMINAL_DISCLAIMER}`,
        '逐笔核对合同、发票、银行回单与出入库单：差异属于分期/预付的，补充付款计划与对账单；' +
          '属于开票错误的，作废重开（保留痕迹）；属于虚构业务的，立即停止并作进项转出/冲减收入。' +
          '确保三流（合同流、资金流、发票流、货物流）在业务实质与金额上能够相互印证。',
        [LAW_INVOICE_MEASURES_21, LAW_CRIMINAL_205, LAW_TAX_COLLECTION_63, LAW_ACCOUNTING_LAW_9],
        {
          counterparty: group.supplier,
          side: group.side,
          invoiceCount: group.invoices.length,
          invoiceTotal,
          bankCount,
          bankTotal,
          contractCount: matchedContracts.length,
          contractTotal,
          hasLogistics,
          mismatches,
          windowDays: FLOW_WINDOW_DAYS,
          invoiceIds: group.invoices.map((item) => item.id),
        },
      ),
    );
  }

  return findings;
}

/* ================================================================== */
/* 五、注册                                                            */
/* ================================================================== */

export const criminalChecks: readonly CheckDefinition[] = [
  {
    id: CRIMINAL_RULE_IDS.taxEvasion,
    title: '逃税刑事立案风险（10% / 5 万元）',
    category: 'criminal_law',
    severity: 'error',
    blocking: true,
    configurable: false,
    basis: [LAW_CRIMINAL_201, LAW_JUDICIAL_2024_4],
    run: checkTaxEvasion,
  },
  {
    id: CRIMINAL_RULE_IDS.taxEvasionSevere,
    title: '逃税加重档风险（30% / 50 万元）',
    category: 'criminal_law',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_CRIMINAL_201, LAW_CRIMINAL_211],
    run: checkTaxEvasionSevere,
  },
  {
    id: CRIMINAL_RULE_IDS.invoiceRisk,
    title: '大额进项无合同/无物流（虚开风险）',
    category: 'criminal_law',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_INVOICE_MEASURES_21, LAW_CRIMINAL_205],
    run: checkInvoiceRisk,
  },
  {
    id: CRIMINAL_RULE_IDS.threeFlows,
    title: '三流一致性（发票/资金/合同/货物）',
    category: 'criminal_law',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_INVOICE_MEASURES_21, LAW_TAX_COLLECTION_63],
    run: checkThreeFlows,
  },
];
