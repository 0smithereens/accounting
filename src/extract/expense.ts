/**
 * 报销单 / 费用明细提取器。
 *
 * 报销单的特点是「费用类别」列直接对应会计科目：
 *   差旅费 → 管理费用/差旅费
 *   业务招待费 → 管理费用/业务招待费
 * 因此这里把费用类别规范化后放进 fields.category，交给规则表映射到科目。
 *
 * 另外，报销单常常一张单子多个明细行（同一报销人、同一单号），
 * 需要按单号聚合，避免把一份报销拆成多张凭证。
 */

import type { Cents, DocumentRecord, RawSheet } from '../core/types.ts';
import { formatYuan, sumCents } from '../core/money.ts';
import { parseDate } from '../core/datetime.ts';
import { compactText, isBlank, normalizeText } from '../core/text.ts';
import { pickBestSheet, textOf, valueOf, type ColumnMapping } from '../io/table-detect.ts';
import { EXPENSE_COLUMNS } from './schemas.ts';
import { amountOf, buildDocument, detectDepartment, isSummaryRow, makeSummary } from './common.ts';

export interface ExpenseExtraction {
  documents: DocumentRecord[];
  warnings: string[];
  mapping: ColumnMapping | null;
  sheetName: string | null;
}

export interface ExpenseExtractOptions {
  /** 已知部门，用于识别部门辅助核算 */
  departments?: readonly string[];
  /** 是否按「报销单号 + 报销人」聚合明细行，默认 true */
  groupByVoucher?: boolean;
  /**
   * 贷方科目编码。来自 settings.expenseCreditAccount：
   *  - 2241.04 先挂账（同时处理银行流水时用，避免银行存款重复记账）
   *  - 1002 视为直接付款
   */
  creditAccount?: string;
}

/**
 * 费用类别规范化：把各种口语化写法统一成标准类别名。
 * 这个规范名会作为 field.category 参与规则匹配。
 */
export function normalizeExpenseCategory(raw: string): string {
  const s = compactText(raw);
  if (s === '') return '其他';

  const table: Array<[RegExp, string]> = [
    [/差旅|出差|机票|火车票|住宿|酒店|车费|路费|行程|高铁|打车|市内交通/, '差旅费'],
    [/招待|宴请|餐费|餐饮|业务招待|酒水|客户用餐/, '业务招待费'],
    [/办公|文具|耗材|打印|复印|纸张|办公用品/, '办公费'],
    [/水电|电费|水费|燃气|取暖|物业|暖气/, '水电费'],
    [/房租|租金|租赁|房屋|场地/, '租赁费'],
    [/通讯|话费|电话|宽带|网络|手机|座机/, '通讯费'],
    [/邮费|快递|邮寄|运费|物流|货运|运输/, '运输费'],
    [/交通|油费|加油|过路|停车|车辆|维修|保养|保险.*车|年检/, '车辆使用费'],
    [/会议|会务|培训|学习|考察/, '会议费'],
    [/广告|宣传|推广|市场|营销|展览|展会/, '广告宣传费'],
    [/咨询|顾问|服务费|中介|审计|律师|代理|鉴证/, '咨询顾问费'],
    [/研发|技术|试验|检测|专利|软件/, '研发费用'],
    [/工资|薪|劳务|报酬|奖金|社保|公积金|福利|体检|团建/, '职工薪酬及福利'],
    [/折旧|摊销|租赁摊/, '折旧摊销'],
    [/利息|手续费|汇兑|银行|融资/, '财务费用'],
    [/修理|维护|装修|改造/, '修理费'],
    [/其他|杂费|零星/, '其他'],
  ];

  for (const [re, name] of table) {
    if (re.test(s)) return name;
  }
  return normalizeText(raw);
}

export function extractExpenseFromSheet(
  sheet: RawSheet,
  mapping: ColumnMapping,
  filePath: string,
  options: ExpenseExtractOptions = {},
): ExpenseExtraction {
  const documents: DocumentRecord[] = [];
  const warnings: string[] = [];
  const departments = options.departments ?? [];
  const groupByVoucher = options.groupByVoucher ?? true;

  interface Aggregated {
    date: string | null;
    employee: string;
    department: string;
    category: string;
    project: string;
    summaryParts: string[];
    amount: Cents;
    taxAmount: Cents;
    hasTax: boolean;
    invoiceCount: number;
    rowNumbers: number[];
    warnings: string[];
    rawSummaries: string[];
  }

  const groups = new Map<string, Aggregated>();
  const order: string[] = [];

  for (const row of sheet.rows) {
    if (isSummaryRow(row, mapping)) continue;

    const amount = amountOf(valueOf(row, mapping, 'amount'));
    if (amount === null) continue;

    const date = parseDate(valueOf(row, mapping, 'date'));
    const employee = textOf(row, mapping, 'employee');
    const rawCategory = textOf(row, mapping, 'category');
    const category = normalizeExpenseCategory(rawCategory);
    const summaryText = textOf(row, mapping, 'summary');
    const project = textOf(row, mapping, 'project');
    const invoiceCountText = textOf(row, mapping, 'invoiceCount');
    const invoiceCount = Number(invoiceCountText.replace(/\D/g, '')) || 0;

    let department = textOf(row, mapping, 'department');
    if (department === '') department = detectDepartment(`${summaryText} ${rawCategory}`, departments) ?? '';

    const taxRaw = amountOf(valueOf(row, mapping, 'taxAmount'));

    const rowWarnings: string[] = [];
    if (date === null) rowWarnings.push('报销日期无法识别');

    const key = groupByVoucher
      ? `${date ?? ''}|${employee}|${category}|${department}|${project}`
      : `${date ?? ''}|${employee}|${category}|${department}|${project}|${row.rowNumber}`;

    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.amount += Math.abs(amount);
      if (taxRaw !== null) {
        existing.taxAmount += Math.abs(taxRaw);
        existing.hasTax = true;
      }
      existing.invoiceCount += invoiceCount;
      existing.rowNumbers.push(row.rowNumber);
      if (summaryText !== '' && !existing.summaryParts.includes(summaryText)) {
        existing.summaryParts.push(summaryText);
      }
      existing.warnings.push(...rowWarnings);
    } else {
      groups.set(key, {
        date,
        employee,
        department,
        category,
        project,
        summaryParts: summaryText === '' ? [] : [summaryText],
        amount: Math.abs(amount),
        taxAmount: taxRaw === null ? 0 : Math.abs(taxRaw),
        hasTax: taxRaw !== null,
        invoiceCount,
        rowNumbers: [row.rowNumber],
        warnings: rowWarnings,
        rawSummaries: summaryText === '' ? [] : [summaryText],
      });
      order.push(key);
    }
  }

  for (const key of order) {
    const g = groups.get(key);
    if (g === undefined) continue;

    const mergedFrom = g.rowNumbers.length > 1;
    const summaryText = g.summaryParts.join('；');

    // 报销金额通常是价税合计；若表里给了可抵扣税额，则拆出不含税金额
    const hasTax = g.hasTax && g.taxAmount > 0 && g.taxAmount < g.amount;
    const netAmount: Cents | null = hasTax ? g.amount - g.taxAmount : null;
    const taxAmount: Cents | null = hasTax ? g.taxAmount : null;

    const fields: Record<string, string | number | boolean | null> = {
      category: g.category,
      department: g.department,
      employee: g.employee,
      project: g.project,
      hasTax,
      taxAmount: hasTax ? formatYuan(g.taxAmount) : '',
      netAmount: hasTax ? formatYuan(g.amount - g.taxAmount) : formatYuan(g.amount),
      invoiceCount: g.invoiceCount,
      rowCount: g.rowNumbers.length,
      filledBy: g.employee,
      creditAccount: options.creditAccount ?? '2241.04',
    };

    const warnings = [...g.warnings];
    if (mergedFrom) {
      warnings.push(
        `已合并 ${g.rowNumbers.length} 行明细（行 ${g.rowNumbers.join(',')}）为一张报销单`,
      );
    }

    documents.push(
      buildDocument({
        kind: 'expense',
        file: filePath,
        sheet: sheet.sheetName,
        row: g.rowNumbers[0] ?? 0,
        date: g.date,
        summary:
          makeSummary(g.category, g.employee, summaryText) ||
          makeSummary('费用报销', g.employee) ||
          '费用报销',
        amount: g.amount,
        direction: 'out',
        counterparty: g.employee === '' ? null : g.employee,
        netAmount,
        taxAmount,
        fields,
        rawSummary: summaryText,
        warnings,
      }),
    );
  }

  if (documents.length === 0) {
    warnings.push(`工作表「${sheet.sheetName}」未提取到任何有效报销记录`);
  }

  const totalAmount = sumCents(documents.map((d) => d.amount));
  if (totalAmount === 0 && documents.length > 0) {
    warnings.push('所有报销单金额合计为 0，请检查「报销金额」列是否识别正确');
  }

  return { documents, warnings, mapping, sheetName: sheet.sheetName };
}

export function extractExpense(
  sheets: readonly RawSheet[],
  filePath: string,
  options: ExpenseExtractOptions = {},
): ExpenseExtraction {
  const best = pickBestSheet(sheets, EXPENSE_COLUMNS);
  if (best === null) {
    return {
      documents: [],
      warnings: [`${filePath}: 未找到可识别的报销单表头`],
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
  return extractExpenseFromSheet(best.sheet, best.mapping, filePath, options);
}

export { isBlank };
