/**
 * Word 合同 / 凭证文档 提取器。
 *
 * 合同不是会计事项本身，它的价值在于「登记台账」与「为后续收付款提供依据」。
 * 因此这里的目标是把合同要素抽干净：
 *   合同编号、合同名称、甲方、乙方、金额（小写+大写交叉校验）、
 *   签订日期、税率、结算方式、付款节点、履约期限
 *
 * 大小写金额不一致是最常见的合同风险点，这里会显式比对并给出警告。
 */

import type { Cents, DocumentRecord } from '../core/types.ts';
import { formatYuan, parseAmount, parseChineseAmount } from '../core/money.ts';
import { extractDateFromText, parseDate } from '../core/datetime.ts';
import { compactText, normalizeOrgName, normalizeText } from '../core/text.ts';
import type { WordDocument } from '../io/word-reader.ts';
import { buildDocument, makeSummary } from './common.ts';

export interface ContractExtraction {
  documents: DocumentRecord[];
  warnings: string[];
}

export interface ContractExtractOptions {
  companyNames?: readonly string[];
  /** 单据日期兜底（YYYY-MM-DD） */
  fallbackDate?: string;
}

/* ------------------------------------------------------------------ */
/* 字段抽取正则                                                        */
/* ------------------------------------------------------------------ */

/** 甲方/乙方这类主体栏位，冒号前可能夹带「（全称）」「（以下简称甲方）」等说明。 */
const PARTY_KEYWORDS = {
  partyA: ['甲方', '甲　方', '出租方', '发包人', '委托方', '采购方', '买方', '需方', '定作人', '用人单位'],
  partyB: ['乙方', '乙　方', '承租方', '承包人', '受托方', '供应方', '卖方', '供方', '承揽人', '劳动者'],
} as const;

function extractParty(text: string, keywords: readonly string[]): string | null {
  for (const kw of keywords) {
    const re = new RegExp(
      `${escapeRegExp(kw)}[^：:\\n]{0,16}[：:]\\s*([^\\n，,；;、]{2,60})`,
    );
    const m = re.exec(text);
    if (m?.[1] === undefined) continue;
    let value = normalizeText(m[1]).trim();
    // 去掉常见的尾巴标签
    value = value.replace(/[（(](以下[^)）]*|盖章|签章)[)）]/g, '').trim();
    // 排除把字段名当值的情况
    if (/^(名称|全称|地址|电话|联系人|法定代表人|统一社会信用代码)$/.test(value)) continue;
    if (value.length >= 2) return value;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 抽取金额小写。 */
export function extractContractAmount(text: string): { amount: Cents | null; matched: string | null } {
  const patterns = [
    /(?:合同)?(?:总)?(?:金额|价款|总价|价格|报酬|费用|服务费|合同额)[^：:\n]{0,24}[：:]\s*(?:人民币|RMB|￥|¥)?\s*[(（]?小写[)）]?\s*[：:]?\s*(?:人民币|RMB|￥|¥)?\s*([\d,]+(?:\.\d{1,2})?)/,
    /[(（]小写[)）]\s*[：:]?\s*(?:人民币|RMB|￥|¥)?\s*([\d,]+(?:\.\d{1,2})?)/,
    /(?:合同)?(?:总)?(?:金额|价款|总价|价格|报酬|费用)[^：:\n]{0,24}[：:]\s*(?:人民币|RMB|￥|¥)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:元|万元)?/,
    /(?:人民币|RMB|￥|¥)\s*([\d,]+(?:\.\d{1,2})?)/,
  ];

  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1] === undefined) continue;
    // 排除明显不是金额的编号类数字（纯整数且位数 > 12）
    const digits = m[1].replace(/[^\d]/g, '');
    if (digits.length > 12) continue;
    const cents = parseAmount(m[1]);
    if (cents !== null && cents > 0) {
      // 若匹配处提到「万元」，需要 ×10000
      const context = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 10);
      if (/万元/.test(context) && !/[¥￥]|人民币/.test(context)) {
        return { amount: cents * 10000, matched: m[0].trim() };
      }
      return { amount: cents, matched: m[0].trim() };
    }
  }
  return { amount: null, matched: null };
}

/** 抽取金额大写。冒号后可能还跟着「人民币」字样，需要一并跳过。 */
export function extractContractChineseAmount(text: string): Cents | null {
  const patterns = [
    /(?:人民币)?(?:大写|大写金额)[^：:\n]{0,12}[：:]\s*(?:人民币|RMB|￥|¥)?\s*([零〇壹贰叁肆伍陆柒捌玖拾佰仟万亿元圆角分整正]{2,40})/,
    /(?:人民币)?(?:大写|大写金额)[（(]?[^)）\n]{0,6}[)）]?\s*(?:为|是)?\s*[：:]?\s*(?:人民币)?\s*([零〇壹贰叁肆伍陆柒捌玖拾佰仟万亿元圆角分整正]{2,40})/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1] === undefined) continue;
    const cents = parseChineseAmount(m[1]);
    if (cents !== null && cents > 0) return cents;
  }
  return null;
}

/**
 * 抽取税率。
 *
 * 注意分隔符字符类必须排除数字与百分号：
 * 若写成 [^：:\n]{0,12}，正则在贪婪匹配后回溯时会吃掉数字的一部分，
 * 把「增值税税率 13%」误读成「3%」。这是很隐蔽但很危险的错误。
 */
export function extractTaxRate(text: string): number | null {
  const patterns = [
    /(?:增值税)?(?:税率|征收率|税点)[^：:\d%\n]{0,16}[：:]?\s*(\d{1,3}(?:\.\d{1,2})?)\s*[%％]/,
    /(?:增值税)?(?:税率|征收率|税点)\s*(?:为|是)[^：:\d%\n]{0,8}(\d{1,3}(?:\.\d{1,2})?)\s*[%％]/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1] === undefined) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0 || n > 100) continue;
    return n / 100;
  }
  return null;
}

/** 抽取结算方式。 */
export function extractSettlement(text: string): string | null {
  const re = /(?:结算|付款|支付|结账)方式[^：:\n]{0,10}[：:]\s*([^\n]{2,50})/;
  const m = re.exec(text);
  if (m?.[1] !== undefined) return normalizeText(m[1]);
  if (/银行转账|电汇|网银转账|转账支付/.test(text)) return '银行转账';
  if (/银行承兑汇票|商业承兑汇票|承兑汇票/.test(text)) return '承兑汇票';
  if (/支票/.test(text)) return '支票';
  if (/现金/.test(text)) return '现金';
  return null;
}

/** 抽取付款节点（预付款、进度款、尾款/质保金）。 */
export function extractPaymentMilestones(
  text: string,
): Array<{ name: string; ratio: number | null; amountCents: Cents | null; raw: string }> {
  const results: Array<{ name: string; ratio: number | null; amountCents: Cents | null; raw: string }> = [];
  const keywords: Array<[string, RegExp]> = [
    ['预付款', /预付款|预付|首付款|首期款|定金/],
    ['进度款', /进度款|进度支付|中期款|分期款/],
    ['尾款', /尾款|余款|结清款|末期款/],
    ['质保金', /质保金|质量保证金|保修金|保证金/],
  ];

  // 按句子切分，避免跨句误匹配
  const sentences = text.split(/[。；;\n]/).map((s) => s.trim()).filter((s) => s !== '');

  for (const [name, re] of keywords) {
    for (const sentence of sentences) {
      if (!re.test(sentence)) continue;
      const ratioMatch = /(\d{1,3}(?:\.\d{1,2})?)\s*%/.exec(sentence);
      const amountMatch = /(?:人民币|RMB|￥|¥)?\s*([\d,]+(?:\.\d{1,2})?)\s*元/.exec(sentence);
      results.push({
        name,
        ratio: ratioMatch?.[1] === undefined ? null : Number(ratioMatch[1]) / 100,
        amountCents: amountMatch?.[1] === undefined ? null : parseAmount(amountMatch[1]),
        raw: normalizeText(sentence).slice(0, 80),
      });
      break;
    }
  }
  return results;
}

/** 抽取合同编号。 */
export function extractContractNo(text: string): string | null {
  const re = /(?:合同|协议|契约)?\s*(?:编号|号码|文号|序号)[^：:\n]{0,8}[：:]\s*([A-Za-z0-9\u4e00-\u9fa5\-_/()（）]{3,40})/;
  const m = re.exec(text);
  return m?.[1] === undefined ? null : normalizeText(m[1]);
}

/** 抽取合同名称：优先书名号，其次首行。 */
export function extractContractName(text: string, paragraphs: readonly string[]): string | null {
  const m = /《([^》]{2,60})》/.exec(text);
  if (m?.[1] !== undefined) return m[1].trim();
  for (const p of paragraphs.slice(0, 5)) {
    const s = normalizeText(p);
    if (/合同|协议|契约/.test(s) && s.length >= 4 && s.length <= 60) return s;
  }
  return null;
}

/** 抽取履约期限。 */
export function extractTerm(text: string): string | null {
  const re = /(?:合同)?(?:期限|有效期|履约期限|服务期限|工期)[^：:\n]{0,10}[：:]\s*([^\n]{2,60})/;
  const m = re.exec(text);
  if (m?.[1] !== undefined) return normalizeText(m[1]);
  const m2 = /(?:自|从)\s*(\d{4}\s*[年\-/.]\s*\d{1,2}\s*[月\-/.]\s*\d{1,2}\s*日?)\s*(?:起|至)\s*(\d{4}\s*[年\-/.]\s*\d{1,2}\s*[月\-/.]\s*\d{1,2}\s*日?)\s*(?:止|结束)?/.exec(text);
  if (m2?.[1] !== undefined && m2[2] !== undefined) {
    return `${normalizeText(m2[1])} 至 ${normalizeText(m2[2])}`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function sameOrg(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  const na = normalizeOrgName(a);
  const nb = normalizeOrgName(b);
  if (na === nb) return true;
  return na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na));
}

/**
 * 从 Word 文档中抽取合同要素，生成一条 contract 类型的单据。
 */
export function extractContract(
  doc: WordDocument,
  filePath: string,
  options: ContractExtractOptions = {},
): ContractExtraction {
  const warnings: string[] = [];
  const text = doc.text;

  if (compactText(text).length === 0) {
    return {
      documents: [],
      warnings: [`${filePath}: Word 文档内容为空，无法抽取`],
    };
  }

  const contractNo = extractContractNo(text);
  const contractName = extractContractName(text, doc.paragraphs);
  const partyA = extractParty(text, PARTY_KEYWORDS.partyA);
  const partyB = extractParty(text, PARTY_KEYWORDS.partyB);

  const { amount: smallAmount, matched: amountRaw } = extractContractAmount(text);
  const upperAmount = extractContractChineseAmount(text);

  // 大小写金额交叉校验
  let amount = smallAmount;
  if (smallAmount !== null && upperAmount !== null && Math.abs(smallAmount - upperAmount) > 1) {
    warnings.push(
      `合同大小写金额不一致：小写 ${formatYuan(smallAmount)}，大写折算 ${formatYuan(upperAmount)}。` +
        '按合同惯例以大写为准，已采用大写金额，请务必人工复核',
    );
    amount = upperAmount;
  } else if (smallAmount === null && upperAmount !== null) {
    amount = upperAmount;
    warnings.push('合同只找到大写金额，已按大写金额入账');
  } else if (smallAmount !== null && upperAmount === null) {
    warnings.push('合同只有小写金额，未找到大写金额，建议核对');
  } else if (smallAmount === null && upperAmount === null) {
    warnings.push('未能从合同中抽取到合同金额，请人工确认');
  }

  const signDate =
    parseDate(text.match(/(?:签订|签署|订立|签约)(?:日期|时间|于)?[^：:\n]{0,8}[：:]?\s*(\d{4}\s*[年\-/.]\s*\d{1,2}\s*[月\-/.]\s*\d{1,2}\s*日?)/)?.[1]) ??
    extractDateFromText(text) ??
    (options.fallbackDate === undefined ? null : options.fallbackDate);

  const taxRate = extractTaxRate(text);
  const settlement = extractSettlement(text);
  const milestones = extractPaymentMilestones(text);
  const term = extractTerm(text);

  if (signDate === null) warnings.push('未能识别合同签订日期');
  if (partyA === null && partyB === null) warnings.push('未能识别合同甲乙双方名称');

  // 判断我方在合同中的角色 → 收入类还是成本类
  const companyNames = options.companyNames ?? [];
  const weAreA = partyA !== null && companyNames.some((n) => sameOrg(partyA, n));
  const weAreB = partyB !== null && companyNames.some((n) => sameOrg(partyB, n));

  let role = 'unknown';
  let counterparty: string | null = partyA ?? partyB;
  if (weAreA && !weAreB) {
    role = 'purchaser';
    counterparty = partyB;
  } else if (weAreB && !weAreA) {
    role = 'supplier';
    counterparty = partyA;
  } else if (companyNames.length === 0) {
    warnings.push('未配置本企业名称（config/settings.yaml 的 companyNames），无法判断合同收付方向');
  } else {
    warnings.push('无法确定本企业在合同中的角色，请检查企业名称配置与合同甲乙方名称');
  }

  // 从表格里补充金额明细（有些合同把价款放在表格里）
  const tableText = doc.tables
    .flatMap((t) => t.rows.flat())
    .join(' ');
  if (amount === null && tableText !== '') {
    const fromTable = extractContractAmount(tableText);
    if (fromTable.amount !== null) {
      amount = fromTable.amount;
      warnings.push('合同金额取自文档表格');
    }
  }

  const fields: Record<string, string | number | boolean | null> = {
    contractNo,
    contractName,
    partyA,
    partyB,
    role,
    taxRate: taxRate ?? '',
    settlement,
    term,
    amountRaw,
    chineseAmount: upperAmount === null ? '' : formatYuan(upperAmount),
    milestoneCount: milestones.length,
    milestones: milestones.map((m) => `${m.name}${m.ratio === null ? '' : ` ${(m.ratio * 100).toFixed(0)}%`}`).join('；'),
    prepaymentRatio: milestones.find((m) => m.name === '预付款')?.ratio ?? '',
    retentionRatio: milestones.find((m) => m.name === '质保金')?.ratio ?? '',
    tableCount: doc.tables.length,
    paragraphCount: doc.paragraphCount,
  };

  // 若合同明确写了「已收款/已付款」，说明是已发生的会计事项，direction 才有意义
  const settled = /已(?:经)?(?:收|付)(?:到|款|讫)|款项已(?:结清|支付)|已开具发票/.test(text);
  fields['settled'] = settled;

  if (settled) {
    warnings.push('合同正文提及款项已收付，将按已发生业务生成分录；若与实际不符请删除对应凭证');
  }

  const document = buildDocument({
    kind: 'contract',
    file: filePath,
    date: signDate,
    summary:
      makeSummary(contractName ?? '合同', contractNo, counterparty) ||
      `合同 ${contractNo ?? ''}`.trim(),
    amount: amount ?? 0,
    direction: settled ? (role === 'supplier' ? 'in' : 'out') : 'none',
    counterparty,
    netAmount: null,
    taxAmount: null,
    fields,
    rawSummary: contractName ?? undefined,
    warnings,
  });

  return { documents: [document], warnings };
}
