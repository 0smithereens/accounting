/**
 * 发票台账提取器。
 *
 * 关键判断：这张发票是「进项」（我们采购，可抵扣）还是「销项」（我们销售，应缴税）。
 * 判定依据是购方/销方名称与本企业名称的比对。
 *
 * 另一个重点是价税分离：台账常常只给「价税合计」和「税率」，
 * 需要自己算出不含税金额与税额，且必须保证 net + tax === total。
 */

import type { Cents, Direction, DocumentRecord, RawSheet } from '../core/types.ts';
import { formatYuan, parseAmount, splitTax } from '../core/money.ts';
import { parseDate } from '../core/datetime.ts';
import { compactText, isBlank, normalizeOrgName, normalizeText } from '../core/text.ts';
import { pickBestSheet, textOf, valueOf, type ColumnMapping } from '../io/table-detect.ts';
import { INVOICE_COLUMNS } from './schemas.ts';
import { amountOf, buildDocument, isSummaryRow, makeSummary } from './common.ts';

export interface InvoiceExtraction {
  documents: DocumentRecord[];
  warnings: string[];
  mapping: ColumnMapping | null;
  sheetName: string | null;
}

export interface InvoiceExtractOptions {
  /** 本企业名称列表，用于判断进项/销项 */
  companyNames?: readonly string[];
  /** 未识别税率时的默认税率 */
  defaultTaxRate?: number;
}

/* ------------------------------------------------------------------ */
/* 税率推断                                                            */
/* ------------------------------------------------------------------ */

/** 按货物/服务名称推断增值税税率（一般纳税人常用档位）。 */
export function inferTaxRate(goodsName: string, invoiceType = ''): { rate: number; reason: string } {
  const s = compactText(`${goodsName} ${invoiceType}`);

  // 小规模纳税人征收率
  if (/小规模/.test(s)) return { rate: 0.03, reason: '小规模纳税人征收率 3%' };

  // 9%：交通运输、建筑、不动产租赁、农产品、邮政、基础电信
  if (/运输|货运|物流|搬运|建筑|工程|安装|施工|装饰|装修|不动产|房屋租赁|场地租赁|土地使用权|农产品|粮食|食用植物油|自来水|暖气|冷气|煤气|石油液化气|天然气|居民用煤炭|图书|报纸|杂志|邮政|电信|基础电信/.test(s)) {
    return { rate: 0.09, reason: '适用 9% 税率（交通运输/建筑/不动产/农产品等）' };
  }

  // 6%：现代服务、生活服务、金融、鉴证咨询、信息技术、文化创意、租赁（动产以外）
  if (/服务|咨询|顾问|技术服务|信息技术|软件开发|软件服务|维护|设计|广告|会议|展览|住宿|餐饮|旅游|娱乐|文化|教育|医疗|金融|保险|手续费|佣金|代理|中介|鉴证|审计|法律|会计|税务|人力资源|劳务派遣|物业管理|仓储|租赁|系统集成|数据处理|知识产权/.test(s)) {
    return { rate: 0.06, reason: '适用 6% 税率（现代服务/生活服务等）' };
  }

  // 13%：销售货物、有形动产租赁、加工修理修配
  if (/货物|材料|原材料|设备|机器|机械|钢材|水泥|电子|电脑|计算机|办公用品|耗材|配件|零件|商品|产品|件|台|个|套|箱|吨|千克|kg|米|销售|加工|修理|修配|柴油|汽油|煤炭|化工|五金|家具|电器|服装|食品|饮料|日用品/.test(s)) {
    return { rate: 0.13, reason: '适用 13% 税率（销售货物/加工修理修配）' };
  }

  return { rate: 0, reason: '' };
}

/** 规范化税率：支持 0.13 / 13 / "13%" 三种写法。 */
export function normalizeTaxRate(value: unknown): number | null {
  if (isBlank(value)) return null;
  if (typeof value === 'number') return value > 1 ? value / 100 : value;
  const s = normalizeText(value).replace('%', '').trim();
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? n / 100 : n;
}

/* ------------------------------------------------------------------ */
/* 进项 / 销项 判定                                                     */
/* ------------------------------------------------------------------ */

/**
 * 判断发票是否可抵扣进项税额。
 *  - 专用发票（含数电专票、机动车销售统一发票）→ 可抵扣
 *  - 普通发票（含电子普通发票）→ 不可抵扣
 *  - 台账未写票种时：默认按可抵扣处理（这类台账通常是抵扣台账）
 */
export function isDeductibleInvoice(invoiceType: string): boolean {
  const s = compactText(invoiceType);
  if (s === '') return true;
  if (/专用发票|专票|增值税专用|机动车销售统一发票|收费公路通行费电子发票|海关进口增值税专用缴款书/.test(s)) {
    return true;
  }
  if (/普通发票|普票|通用机打|定额发票|电子普通发票|卷票/.test(s)) {
    return false;
  }
  // 数电票（全电发票）既可能是专票也可能是普票，票面会标注，标注不清时按可抵扣处理
  return true;
}

function sameOrg(a: string, b: string): boolean {  if (a === '' || b === '') return false;
  const na = normalizeOrgName(a);
  const nb = normalizeOrgName(b);
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}

export interface InvoiceSide {
  side: 'input' | 'output' | 'unknown';
  reason: string;
}

export function determineInvoiceSide(
  buyer: string,
  seller: string,
  companyNames: readonly string[],
): InvoiceSide {
  if (companyNames.length === 0) {
    return { side: 'unknown', reason: '未配置本企业名称，无法自动判断进项/销项' };
  }
  const buyerIsUs = companyNames.some((n) => sameOrg(buyer, n));
  const sellerIsUs = companyNames.some((n) => sameOrg(seller, n));

  if (buyerIsUs && !sellerIsUs) {
    return { side: 'input', reason: `购方「${buyer}」为本企业 → 进项发票` };
  }
  if (sellerIsUs && !buyerIsUs) {
    return { side: 'output', reason: `销方「${seller}」为本企业 → 销项发票` };
  }
  if (buyerIsUs && sellerIsUs) {
    return { side: 'unknown', reason: '购方与销方均为本企业，请人工判断' };
  }
  return {
    side: 'unknown',
    reason: `购方「${buyer}」与销方「${seller}」均非本企业，请检查企业名称配置`,
  };
}

/* ------------------------------------------------------------------ */
/* 提取                                                                */
/* ------------------------------------------------------------------ */

export function extractInvoiceFromSheet(
  sheet: RawSheet,
  mapping: ColumnMapping,
  filePath: string,
  options: InvoiceExtractOptions = {},
): InvoiceExtraction {
  const documents: DocumentRecord[] = [];
  const warnings: string[] = [];
  const companyNames = options.companyNames ?? [];
  const defaultTaxRate = options.defaultTaxRate ?? 0;

  let missingSide = 0;

  for (const row of sheet.rows) {
    if (isSummaryRow(row, mapping)) continue;

    const totalRaw = valueOf(row, mapping, 'amount');
    let total = amountOf(totalRaw);
    if (total === null) {
      // 只有「金额」列时，把不含税金额 + 税额 当作价税合计
      const netOnly = amountOf(valueOf(row, mapping, 'netAmount'));
      const taxOnly = amountOf(valueOf(row, mapping, 'taxAmount'));
      if (netOnly === null && taxOnly === null) continue;
      total = Math.abs((netOnly ?? 0) + (taxOnly ?? 0));
    }
    if (total === 0) continue;
    total = Math.abs(total);

    const rowWarnings: string[] = [];

    const seller = textOf(row, mapping, 'seller');
    const buyer = textOf(row, mapping, 'buyer');
    const goodsName = textOf(row, mapping, 'goodsName');
    const invoiceType = textOf(row, mapping, 'invoiceType');
    const invoiceNo = textOf(row, mapping, 'invoiceNo');
    const invoiceCode = textOf(row, mapping, 'invoiceCode');
    const sellerTaxNo = textOf(row, mapping, 'sellerTaxNo');
    const buyerTaxNo = textOf(row, mapping, 'buyerTaxNo');
    const quantity = textOf(row, mapping, 'quantity');
    const unitPrice = textOf(row, mapping, 'unitPrice');
    const date = parseDate(valueOf(row, mapping, 'date'));

    // ---- 价税分离 ----
    const explicitNet = amountOf(valueOf(row, mapping, 'netAmount'));
    const explicitTax = amountOf(valueOf(row, mapping, 'taxAmount'));
    let rate = normalizeTaxRate(valueOf(row, mapping, 'taxRate'));

    let net: Cents;
    let tax: Cents;
    let rateReason = '';

    if (explicitNet !== null && explicitTax !== null) {
      // 台账直接给了不含税金额与税额，优先采用，但校验是否等于价税合计
      net = Math.abs(explicitNet);
      tax = Math.abs(explicitTax);
      const sum = net + tax;
      if (Math.abs(sum - total) > 1) {
        rowWarnings.push(
          `不含税金额 ${formatYuan(net)} + 税额 ${formatYuan(tax)} = ${formatYuan(sum)}，` +
            `与价税合计 ${formatYuan(total)} 不符（差 ${formatYuan(total - sum)}），已以价税合计为准重算`,
        );
        if (rate === null) {
          net = total - tax > 0 ? total - tax : total;
          if (net + tax !== total) {
            const s = splitTax(total, inferTaxRate(goodsName, invoiceType).rate || defaultTaxRate);
            net = s.net;
            tax = s.tax;
          }
        } else {
          const s = splitTax(total, rate);
          net = s.net;
          tax = s.tax;
        }
      } else if (rate === null && net > 0) {
        rate = Math.round((tax / net) * 10000) / 10000;
      }
    } else if (explicitTax !== null) {
      tax = Math.abs(explicitTax);
      net = total - tax;
      if (net < 0) {
        rowWarnings.push('税额大于价税合计，已按不含税金额为 0 处理');
        net = 0;
        tax = total;
      }
      if (rate === null && net > 0) rate = Math.round((tax / net) * 10000) / 10000;
    } else if (rate !== null && rate > 0) {
      const s = splitTax(total, rate);
      net = s.net;
      tax = s.tax;
    } else {
      const inferred = inferTaxRate(goodsName, invoiceType);
      const useRate = inferred.rate > 0 ? inferred.rate : defaultTaxRate;
      if (useRate > 0) {
        const s = splitTax(total, useRate);
        net = s.net;
        tax = s.tax;
        rate = useRate;
        rateReason = inferred.reason !== '' ? inferred.reason : `使用默认税率 ${(useRate * 100).toFixed(0)}%`;
        rowWarnings.push(`台账未给税率，按「${goodsName || '未知品名'}」推断税率 ${(useRate * 100).toFixed(0)}%`);
      } else {
        net = total;
        tax = 0;
        rowWarnings.push('无法确定税率，已按不含税金额全额入账（税额 0），请人工确认是否需要抵扣');
      }
    }

    // 免税/不征税/普票不可抵扣的特殊情形提示
    const isExempt = /免税|不征税|零税率/.test(`${invoiceType}${goodsName}`);
    if (isExempt) {
      tax = 0;
      net = total;
      rate = 0;
      rowWarnings.push('免税/不征税发票，已按全额计入成本费用，不确认进项税额');
    }

    // 是否可抵扣进项税：专用发票（含数电专票）可抵扣；普通发票不可抵扣
    const deductible = !isExempt && isDeductibleInvoice(invoiceType);

    // ---- 进项 / 销项 ----
    const sideInfo = determineInvoiceSide(buyer, seller, companyNames);
    if (sideInfo.side === 'unknown') {
      missingSide += 1;
    }
    const direction: Direction = sideInfo.side === 'output' ? 'in' : 'out';

    const counterparty = sideInfo.side === 'output' ? buyer : seller;
    const summary = makeSummary(
      sideInfo.side === 'output' ? '销项开票' : sideInfo.side === 'input' ? '进项收票' : '发票',
      counterparty,
      goodsName,
    ) || '发票';

    const fields: Record<string, string | number | boolean | null> = {
      invoiceNo,
      invoiceCode,
      invoiceType,
      invoiceSide: sideInfo.side,
      seller,
      buyer,
      sellerTaxNo,
      buyerTaxNo,
      goodsName,
      taxRate: rate ?? 0,
      netAmount: formatYuan(net),
      taxAmount: formatYuan(tax),
      deductible: deductible ? 'yes' : 'no',
      quantity,
      unitPrice,
    };

    if (sideInfo.side === 'unknown') {
      rowWarnings.push(sideInfo.reason);
    }
    if (rateReason !== '') fields['taxRateReason'] = rateReason;

    documents.push(
      buildDocument({
        kind: 'invoice',
        file: filePath,
        sheet: sheet.sheetName,
        row: row.rowNumber,
        date,
        summary,
        amount: total,
        direction,
        counterparty: counterparty === '' ? null : counterparty,
        netAmount: net,
        taxAmount: tax,
        fields,
        rawSummary: makeSummary(invoiceNo, goodsName),
        warnings: rowWarnings,
      }),
    );
  }

  if (missingSide > 0) {
    warnings.push(
      `有 ${missingSide} 张发票无法判断进项/销项，请在 config/settings.yaml 中配置 companyNames（本企业名称）`,
    );
  }
  if (documents.length === 0) {
    warnings.push(`工作表「${sheet.sheetName}」未提取到任何有效发票记录`);
  }

  return { documents, warnings, mapping, sheetName: sheet.sheetName };
}

export function extractInvoice(
  sheets: readonly RawSheet[],
  filePath: string,
  options: InvoiceExtractOptions = {},
): InvoiceExtraction {
  const best = pickBestSheet(sheets, INVOICE_COLUMNS);
  if (best === null) {
    return {
      documents: [],
      warnings: [`${filePath}: 未找到可识别的发票台账表头`],
      mapping: null,
      sheetName: null,
    };
  }
  if (best.mapping.missingRequired.length > 0) {
    return {
      documents: [],
      warnings: [
        `${filePath}: 工作表「${best.sheet.sheetName}」缺少必需列：${best.mapping.missingRequired.join('、')}；` +
          `已识别表头：${best.sheet.headers.join(' | ')}`,
      ],
      mapping: best.mapping,
      sheetName: best.sheet.sheetName,
    };
  }
  return extractInvoiceFromSheet(best.sheet, best.mapping, filePath, options);
}

export { parseAmount };
