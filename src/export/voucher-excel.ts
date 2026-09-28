/**
 * 凭证导出为 Excel。
 *
 * 输出的工作簿包含 6 张表：
 *   1. 记账凭证      凭证分录明细（含辅助核算与溯源列）
 *   2. 科目汇总表    按科目汇总借贷发生额与余额
 *   3. 单据台账      识别出的原始单据（合同台账也在这里）
 *   4. 问题与待办    需要人工处理的告警与错误
 *   5. 导入模板      贴近金蝶/用友凭证引入格式的精简表
 *   6. 处理说明      本次运行的参数、统计与配置指纹
 *
 * 金额一律写成数值（两位小数格式），不用文本，便于财务软件直接导入。
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import ExcelJS from 'exceljs';

import type { DocumentRecord, ProcessingIssue, Voucher } from '../core/types.ts';
import { SOURCE_KIND_LABEL } from '../core/types.ts';
import type { AppConfig } from '../core/config.ts';
import { formatYuan } from '../core/money.ts';
import { buildTrialBalance, summarizeVouchers } from '../ledger/voucher.ts';

export interface ExportInput {
  vouchers: readonly Voucher[];
  documents: readonly DocumentRecord[];
  issues: readonly ProcessingIssue[];
  config: AppConfig;
  /** 本次处理的文件清单 */
  files: readonly string[];
  /** 本次运行的附加说明（命令行参数等） */
  notes?: string[];
}

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1F4E78' },
};
const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: 'FFFFFFFF' },
  size: 10,
  name: '微软雅黑',
};
const BODY_FONT: Partial<ExcelJS.Font> = { size: 10, name: '微软雅黑' };
const MONEY_FORMAT = '#,##0.00';
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  right: { style: 'thin', color: { argb: 'FFBFBFBF' } },
};

interface ColumnDef {
  header: string;
  width: number;
  /** 金额列用数值格式 */
  money?: boolean;
}

function writeHeader(sheet: ExcelJS.Worksheet, columns: readonly ColumnDef[]): void {
  sheet.columns = columns.map((c) => ({ header: c.header, width: c.width }));
  const row = sheet.getRow(1);
  row.height = 22;
  row.eachCell((cell, colNumber) => {
    const def = columns[colNumber - 1];
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = THIN_BORDER;
    if (def?.money === true) cell.numFmt = MONEY_FORMAT;
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (sheet.autoFilter !== undefined) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };
  }
}

function styleBody(sheet: ExcelJS.Worksheet, columns: readonly ColumnDef[], moneyColumns: Set<number>): void {
  const lastRow = sheet.rowCount;
  for (let r = 2; r <= lastRow; r += 1) {
    const row = sheet.getRow(r);
    row.font = BODY_FONT;
    for (let c = 1; c <= columns.length; c += 1) {
      const cell = row.getCell(c);
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle', wrapText: false };
      if (moneyColumns.has(c)) {
        cell.numFmt = MONEY_FORMAT;
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
      }
    }
  }
}

function moneyColumnsOf(columns: readonly ColumnDef[]): Set<number> {
  const set = new Set<number>();
  columns.forEach((c, i) => {
    if (c.money === true) set.add(i + 1);
  });
  return set;
}

/* ------------------------------------------------------------------ */
/* 表1：记账凭证                                                       */
/* ------------------------------------------------------------------ */

const VOUCHER_COLUMNS: ColumnDef[] = [
  { header: '凭证字号', width: 12 },
  { header: '记账日期', width: 12 },
  { header: '会计期间', width: 10 },
  { header: '摘要', width: 38 },
  { header: '科目编码', width: 14 },
  { header: '科目名称', width: 26 },
  { header: '借方金额', width: 15, money: true },
  { header: '贷方金额', width: 15, money: true },
  { header: '部门', width: 12 },
  { header: '客户', width: 24 },
  { header: '供应商', width: 24 },
  { header: '员工', width: 12 },
  { header: '项目', width: 16 },
  { header: '附单据数', width: 9 },
  { header: '来源文件', width: 30 },
  { header: '工作表', width: 14 },
  { header: '源行号', width: 8 },
  { header: '命中规则', width: 26 },
  { header: '备注', width: 40 },
];

function addVoucherSheet(wb: ExcelJS.Workbook, vouchers: readonly Voucher[]): void {
  const sheet = wb.addWorksheet('记账凭证');
  writeHeader(sheet, VOUCHER_COLUMNS);

  for (const voucher of vouchers) {
    const voucherNote = voucher.warnings.join('；');
    voucher.lines.forEach((line, lineIndex) => {
      sheet.addRow([
        voucher.word,
        voucher.date,
        voucher.period,
        line.summary,
        line.accountCode,
        line.accountName,
        line.debit === 0 ? null : Number(formatYuan(line.debit)),
        line.credit === 0 ? null : Number(formatYuan(line.credit)),
        line.auxiliary?.department ?? '',
        line.auxiliary?.customer ?? '',
        line.auxiliary?.supplier ?? '',
        line.auxiliary?.employee ?? '',
        line.auxiliary?.project ?? '',
        lineIndex === 0 ? voucher.attachments : null,
        line.source.file,
        line.source.sheet ?? '',
        line.source.row ?? '',
        line.source.ruleId ?? '',
        lineIndex === 0 ? voucherNote : '',
      ]);
    });

    // 每张凭证后加一行小计，便于人工核对借贷平衡
    const subtotal = sheet.addRow([
      '',
      '',
      '',
      `本凭证合计（${voucher.balanced ? '借贷平衡' : '★借贷不平★'}）`,
      '',
      '',
      Number(formatYuan(voucher.totalDebit)),
      Number(formatYuan(voucher.totalCredit)),
    ]);
    subtotal.font = { ...BODY_FONT, bold: true, color: { argb: voucher.balanced ? 'FF006100' : 'FF9C0006' } };
    subtotal.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: voucher.balanced ? 'FFEAF1DD' : 'FFFFC7CE' },
    };
  }

  styleBody(sheet, VOUCHER_COLUMNS, moneyColumnsOf(VOUCHER_COLUMNS));
}

/* ------------------------------------------------------------------ */
/* 表2：科目汇总表（试算平衡）                                          */
/* ------------------------------------------------------------------ */

const SUMMARY_COLUMNS: ColumnDef[] = [
  { header: '科目编码', width: 16 },
  { header: '科目名称', width: 30 },
  { header: '科目类别', width: 12 },
  { header: '借方发生额', width: 16, money: true },
  { header: '贷方发生额', width: 16, money: true },
  { header: '余额（借正贷负）', width: 18, money: true },
  { header: '余额方向', width: 10 },
];

function addSummarySheet(
  wb: ExcelJS.Workbook,
  vouchers: readonly Voucher[],
  config: AppConfig,
): void {
  const sheet = wb.addWorksheet('科目汇总表');
  writeHeader(sheet, SUMMARY_COLUMNS);

  const rows = buildTrialBalance(vouchers, config);
  for (const row of rows) {
    sheet.addRow([
      row.accountCode,
      row.accountName,
      row.category === 'asset' ? '资产'
        : row.category === 'liability' ? '负债'
          : row.category === 'equity' ? '所有者权益'
            : row.category === 'cost' ? '成本'
              : row.category === 'profit' ? '损益' : '未知',
      Number(formatYuan(row.debitTotal)),
      Number(formatYuan(row.creditTotal)),
      Number(formatYuan(row.balance)),
      row.balance > 0 ? '借' : row.balance < 0 ? '贷' : '平',
    ]);
  }

  const summary = summarizeVouchers(vouchers);
  const total = sheet.addRow([
    '合计', '', '',
    Number(formatYuan(summary.totalDebit)),
    Number(formatYuan(summary.totalCredit)),
    Number(formatYuan(summary.totalDebit - summary.totalCredit)),
    summary.totalDebit === summary.totalCredit ? '试算平衡' : '★不平衡★',
  ]);
  total.font = {
    ...BODY_FONT,
    bold: true,
    color: { argb: summary.totalDebit === summary.totalCredit ? 'FF006100' : 'FF9C0006' },
  };
  total.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: summary.totalDebit === summary.totalCredit ? 'FFEAF1DD' : 'FFFFC7CE' },
  };

  styleBody(sheet, SUMMARY_COLUMNS, moneyColumnsOf(SUMMARY_COLUMNS));
}

/* ------------------------------------------------------------------ */
/* 表3：单据台账                                                       */
/* ------------------------------------------------------------------ */

const DOC_COLUMNS: ColumnDef[] = [
  { header: '单据类型', width: 16 },
  { header: '业务日期', width: 12 },
  { header: '摘要', width: 40 },
  { header: '往来单位', width: 26 },
  { header: '金额', width: 15, money: true },
  { header: '不含税金额', width: 15, money: true },
  { header: '税额', width: 13, money: true },
  { header: '收付方向', width: 10 },
  { header: '关键字段', width: 50 },
  { header: '来源文件', width: 30 },
  { header: '工作表', width: 14 },
  { header: '源行号', width: 8 },
  { header: '提示', width: 50 },
];

function addDocumentSheet(wb: ExcelJS.Workbook, documents: readonly DocumentRecord[]): void {
  const sheet = wb.addWorksheet('单据台账');
  writeHeader(sheet, DOC_COLUMNS);

  for (const doc of documents) {
    const fieldText = Object.entries(doc.fields)
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '' && String(v) !== 'false')
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('; ');

    sheet.addRow([
      SOURCE_KIND_LABEL[doc.kind],
      doc.date ?? '',
      doc.summary,
      doc.counterparty ?? '',
      Number(formatYuan(doc.amount)),
      doc.netAmount === null ? null : Number(formatYuan(doc.netAmount)),
      doc.taxAmount === null ? null : Number(formatYuan(doc.taxAmount)),
      doc.direction === 'in' ? '收' : doc.direction === 'out' ? '付' : '—',
      fieldText,
      doc.source.file,
      doc.source.sheet ?? '',
      doc.source.row ?? '',
      doc.warnings.join('；'),
    ]);
  }

  styleBody(sheet, DOC_COLUMNS, moneyColumnsOf(DOC_COLUMNS));
}

/* ------------------------------------------------------------------ */
/* 表4：问题与待办                                                     */
/* ------------------------------------------------------------------ */

const ISSUE_COLUMNS: ColumnDef[] = [
  { header: '级别', width: 10 },
  { header: '说明', width: 90 },
  { header: '来源文件', width: 32 },
  { header: '工作表', width: 14 },
  { header: '源行号', width: 8 },
  { header: '命中规则', width: 24 },
];

function addIssueSheet(wb: ExcelJS.Workbook, issues: readonly ProcessingIssue[]): void {
  const sheet = wb.addWorksheet('问题与待办');
  writeHeader(sheet, ISSUE_COLUMNS);

  const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));

  for (const issue of sorted) {
    const row = sheet.addRow([
      issue.level === 'error' ? '错误' : issue.level === 'warning' ? '警告' : '提示',
      issue.message,
      issue.source.file,
      issue.source.sheet ?? '',
      issue.source.row ?? '',
      issue.source.ruleId ?? '',
    ]);
    if (issue.level === 'error') {
      row.font = { ...BODY_FONT, color: { argb: 'FF9C0006' } };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
    } else if (issue.level === 'warning') {
      row.font = { ...BODY_FONT, color: { argb: 'FF9C6500' } };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' } };
    }
  }

  styleBody(sheet, ISSUE_COLUMNS, new Set<number>());
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const cell = sheet.getRow(r).getCell(2);
    cell.alignment = { vertical: 'middle', wrapText: true };
  }
}

/* ------------------------------------------------------------------ */
/* 表5：财务软件导入模板                                                */
/* ------------------------------------------------------------------ */

const IMPORT_COLUMNS: ColumnDef[] = [
  { header: '凭证字', width: 8 },
  { header: '凭证号', width: 10 },
  { header: '记账日期', width: 12 },
  { header: '附单据数', width: 9 },
  { header: '摘要', width: 38 },
  { header: '科目代码', width: 16 },
  { header: '借方金额', width: 15, money: true },
  { header: '贷方金额', width: 15, money: true },
  { header: '部门', width: 12 },
  { header: '客户', width: 24 },
  { header: '供应商', width: 24 },
  { header: '个人', width: 12 },
  { header: '项目', width: 16 },
];

function addImportSheet(wb: ExcelJS.Workbook, vouchers: readonly Voucher[], voucherWord: string): void {
  const sheet = wb.addWorksheet('导入模板');
  writeHeader(sheet, IMPORT_COLUMNS);

  for (const voucher of vouchers) {
    const seq = voucher.word.split('-')[1] ?? voucher.word;
    voucher.lines.forEach((line, index) => {
      sheet.addRow([
        voucherWord,
        seq,
        voucher.date,
        index === 0 ? voucher.attachments : null,
        line.summary,
        line.accountCode,
        line.debit === 0 ? null : Number(formatYuan(line.debit)),
        line.credit === 0 ? null : Number(formatYuan(line.credit)),
        line.auxiliary?.department ?? '',
        line.auxiliary?.customer ?? '',
        line.auxiliary?.supplier ?? '',
        line.auxiliary?.employee ?? '',
        line.auxiliary?.project ?? '',
      ]);
    });
  }

  styleBody(sheet, IMPORT_COLUMNS, moneyColumnsOf(IMPORT_COLUMNS));

  const note = sheet.addRow([]);
  note.getCell(1).value =
    '说明：本表为通用凭证引入格式。金蝶/用友各版本的引入模板列名略有差异，' +
    '请按你所用软件的模板调整列顺序与列名后导入；科目代码需与软件中已存在的科目一致。';
  note.getCell(1).font = { ...BODY_FONT, italic: true, color: { argb: 'FF808080' } };
}

/* ------------------------------------------------------------------ */
/* 表6：处理说明                                                       */
/* ------------------------------------------------------------------ */

function addNotesSheet(wb: ExcelJS.Workbook, input: ExportInput): void {
  const sheet = wb.addWorksheet('处理说明');
  sheet.columns = [
    { header: '项目', width: 26 },
    { header: '内容', width: 100 },
  ];
  writeHeader(sheet, [{ header: '项目', width: 26 }, { header: '内容', width: 100 }]);

  const summary = summarizeVouchers(input.vouchers);
  const add = (key: string, value: string | number): void => {
    const row = sheet.addRow([key, value]);
    row.font = BODY_FONT;
    row.getCell(2).alignment = { vertical: 'middle', wrapText: true };
  };

  add('生成时间', new Date().toLocaleString('zh-CN'));
  add('本位币', input.config.settings.currency);
  add('凭证字', input.config.settings.voucherWord);
  add('规则文件', input.config.rules.files.join('、'));
  add('规则总数', input.config.rules.rules.length);
  add('会计科目总数', input.config.accounts.accounts.length);
  add('本企业名称', input.config.settings.companyNames.join('、') || '（未配置！发票与合同无法判断方向）');
  add('待处理科目', input.config.settings.suspenseAccount);
  add('已应用自动配平', '是（借贷不平时差额挂待处理科目，并在问题与待办中列出）');
  add('', '');
  add('处理文件数', input.files.length);
  add('识别单据数', input.documents.length);
  add('生成凭证数', input.vouchers.length);
  add('借贷平衡凭证数', `${input.vouchers.filter((v) => v.balanced).length} / ${input.vouchers.length}`);
  add('借方发生额合计', formatYuan(summary.totalDebit));
  add('贷方发生额合计', formatYuan(summary.totalCredit));
  add('试算平衡', summary.totalDebit === summary.totalCredit ? '平衡' : '★不平衡，请检查★');
  add('', '');

  const errors = input.issues.filter((i) => i.level === 'error').length;
  const warnings = input.issues.filter((i) => i.level === 'warning').length;
  add('错误数', errors);
  add('警告数', warnings);
  add('', '');

  if (input.notes !== undefined && input.notes.length > 0) {
    add('本次运行参数', input.notes.join('\n'));
  }
  add('处理文件清单', input.files.join('\n'));

  styleBody(sheet, [{ header: '项目', width: 26 }, { header: '内容', width: 100 }], new Set<number>());
  sheet.getColumn(1).font = { ...BODY_FONT, bold: true };
}

/* ------------------------------------------------------------------ */
/* 导出入口                                                            */
/* ------------------------------------------------------------------ */

/** 生成凭证工作簿并写入磁盘。 */
export async function exportToExcel(outputPath: string, input: ExportInput): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '会计自动化记账系统';
  wb.created = new Date();

  addVoucherSheet(wb, input.vouchers);
  addSummarySheet(wb, input.vouchers, input.config);
  addDocumentSheet(wb, input.documents);
  addIssueSheet(wb, input.issues);
  addImportSheet(wb, input.vouchers, input.config.settings.voucherWord);
  addNotesSheet(wb, input);

  await mkdir(dirname(outputPath), { recursive: true });
  await wb.xlsx.writeFile(outputPath);
  return outputPath;
}
