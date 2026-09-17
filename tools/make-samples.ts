#!/usr/bin/env node
/**
 * 生成样例单据，用于测试与演示。
 *
 *   node tools/make-samples.ts
 *
 * 生成的样例刻意包含真实世界里的「脏数据」：
 * 银行对账单的标题行、合并单元格、合计行；发票的普票/专票混排；
 * 报销单的税额列空值；工资表的勾稽关系等。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

import { PROJECT_ROOT } from '../src/core/config.ts';

const OUT_DIR = join(PROJECT_ROOT, 'samples');
const COMPANY = '示例科技有限公司';
const COMPANY_TAX_NO = '91310000MA1FL2XXXX';

/* ------------------------------------------------------------------ */
/* 样式                                                                */
/* ------------------------------------------------------------------ */

const TITLE_FONT: Partial<ExcelJS.Font> = { bold: true, size: 14, name: '微软雅黑' };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, size: 10, name: '微软雅黑', color: { argb: 'FF000000' } };
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
const BODY_FONT: Partial<ExcelJS.Font> = { size: 10, name: '微软雅黑' };
const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' }, left: { style: 'thin' },
  bottom: { style: 'thin' }, right: { style: 'thin' },
};

function styleHeaderRow(sheet: ExcelJS.Worksheet, rowNumber: number, columnCount: number): void {
  const row = sheet.getRow(rowNumber);
  for (let c = 1; c <= columnCount; c += 1) {
    const cell = row.getCell(c);
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.border = BORDER;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  row.height = 20;
}

function styleBody(sheet: ExcelJS.Worksheet, fromRow: number, columnCount: number, moneyColumns: number[] = []): void {
  for (let r = fromRow; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= columnCount; c += 1) {
      const cell = row.getCell(c);
      cell.font = BODY_FONT;
      cell.border = BORDER;
      if (moneyColumns.includes(c)) {
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      }
    }
  }
}

/* ================================================================== */
/* 1. 银行流水 / 对账单                                                */
/* ================================================================== */

interface BankTx {
  date: string;
  time: string;
  summary: string;
  counterparty: string;
  counterpartyAccount: string;
  debit: number | null;
  credit: number | null;
}

const BANK_TXS: BankTx[] = [
  { date: '2024-01-03', time: '10:22:15', summary: '收到货款', counterparty: '深圳华强电子有限公司', counterpartyAccount: '6222021001122334455', debit: null, credit: 158000.00 },
  { date: '2024-01-05', time: '14:08:33', summary: '支付货款', counterparty: '东莞精密制造有限公司', counterpartyAccount: '6222021002233445566', debit: 96000.00, credit: null },
  { date: '2024-01-05', time: '14:09:02', summary: '跨行转账手续费', counterparty: '', counterpartyAccount: '', debit: 25.00, credit: null },
  { date: '2024-01-08', time: '09:30:00', summary: '代发工资', counterparty: '代发工资户', counterpartyAccount: '', debit: 150190.00, credit: null },
  { date: '2024-01-10', time: '11:15:47', summary: '缴纳社保费', counterparty: '上海市税务局', counterpartyAccount: '3100000000000000001', debit: 58224.00, credit: null },
  { date: '2024-01-10', time: '11:18:20', summary: '缴纳住房公积金', counterparty: '上海公积金管理中心', counterpartyAccount: '3100000000000000002', debit: 31538.00, credit: null },
  { date: '2024-01-12', time: '00:05:00', summary: '活期结息', counterparty: '', counterpartyAccount: '', debit: null, credit: 1862.35 },
  { date: '2024-01-15', time: '10:42:11', summary: '缴纳增值税', counterparty: '上海市税务局', counterpartyAccount: '3100000000000000001', debit: 42350.80, credit: null },
  { date: '2024-01-15', time: '10:43:55', summary: '缴纳城市维护建设税及教育费附加', counterparty: '上海市税务局', counterpartyAccount: '3100000000000000001', debit: 2964.56, credit: null },
  { date: '2024-01-18', time: '15:20:08', summary: '备用金提现', counterparty: '', counterpartyAccount: '', debit: 20000.00, credit: null },
  { date: '2024-01-20', time: '16:05:41', summary: '报销款', counterparty: '张伟', counterpartyAccount: '6222021003344556677', debit: 12860.40, credit: null },
  { date: '2024-01-22', time: '09:12:00', summary: '收到预收款', counterparty: '广州南方贸易有限公司', counterpartyAccount: '6222021004455667788', debit: null, credit: 80000.00 },
  { date: '2024-01-25', time: '13:30:00', summary: '理财申购', counterparty: '工银理财', counterpartyAccount: '', debit: 500000.00, credit: null },
  { date: '2024-01-28', time: '10:00:00', summary: '支付电费', counterparty: '国网上海市电力公司', counterpartyAccount: '3100000000000000003', debit: 8432.60, credit: null },
  { date: '2024-01-30', time: '11:45:30', summary: '收到货款', counterparty: '上海远景科技有限公司', counterpartyAccount: '6222021005566778899', debit: null, credit: 234000.00 },
  { date: '2024-01-31', time: '09:00:00', summary: '缴纳个人所得税', counterparty: '上海市税务局', counterpartyAccount: '3100000000000000001', debit: 18355.00, credit: null },
  { date: '2024-01-31', time: '17:00:00', summary: '账户管理费', counterparty: '', counterpartyAccount: '', debit: 180.00, credit: null },
];

async function makeBankFile(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('交易明细');

  // 标题行（真实银行文件都有，用于测试表头探测）
  sheet.getCell('A1').value = '中国工商银行上海市分行  客户存款对账单';
  sheet.getCell('A1').font = TITLE_FONT;
  sheet.mergeCells('A1:J1');
  sheet.getCell('A1').alignment = { horizontal: 'center' };

  sheet.getCell('A2').value = `账户名称：${COMPANY}`;
  sheet.getCell('F2').value = '账号：1001 2345 6789 0123 456';
  sheet.getCell('A2').font = BODY_FONT;
  sheet.getCell('F2').font = BODY_FONT;
  sheet.mergeCells('A2:E2');
  sheet.mergeCells('F2:J2');

  sheet.getCell('A3').value = '统计期间：2024-01-01 至 2024-01-31';
  sheet.getCell('A3').font = BODY_FONT;
  sheet.mergeCells('A3:J3');

  const headers = ['交易日期', '交易时间', '摘要', '对方户名', '对方账号', '借方发生额', '贷方发生额', '余额', '本方账号', '币种'];
  const headerRow = sheet.getRow(4);
  headers.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h;
  });
  styleHeaderRow(sheet, 4, headers.length);

  let balance = 1_200_000.00;
  let rowNumber = 5;

  for (const tx of BANK_TXS) {
    balance = balance - (tx.debit ?? 0) + (tx.credit ?? 0);
    const row = sheet.getRow(rowNumber);
    row.getCell(1).value = tx.date;
    row.getCell(2).value = tx.time;
    row.getCell(3).value = tx.summary;
    row.getCell(4).value = tx.counterparty;
    row.getCell(5).value = tx.counterpartyAccount;
    row.getCell(6).value = tx.debit;
    row.getCell(7).value = tx.credit;
    row.getCell(8).value = Number(balance.toFixed(2));
    row.getCell(9).value = '1001234567890123456';
    row.getCell(10).value = '人民币';
    rowNumber += 1;
  }

  // 合计行（测试是否被正确跳过）
  const totalRow = sheet.getRow(rowNumber);
  totalRow.getCell(3).value = '合计';
  totalRow.getCell(6).value = BANK_TXS.reduce((s, t) => s + (t.debit ?? 0), 0);
  totalRow.getCell(7).value = BANK_TXS.reduce((s, t) => s + (t.credit ?? 0), 0);
  totalRow.font = { ...BODY_FONT, bold: true };

  styleBody(sheet, 5, headers.length, [6, 7, 8]);

  sheet.columns.forEach((col, i) => {
    const widths = [13, 11, 30, 26, 24, 15, 15, 16, 22, 10];
    col.width = widths[i] ?? 14;
  });

  const path = join(OUT_DIR, '01-银行流水-工商银行.xlsx');
  await wb.xlsx.writeFile(path);
  return path;
}

/* ================================================================== */
/* 2. 发票台账                                                         */
/* ================================================================== */

interface InvoiceRow {
  no: string;
  code: string;
  date: string;
  type: string;
  buyer: string;
  buyerTax: string;
  seller: string;
  sellerTax: string;
  goods: string;
  amount: number; // 不含税
  rate: number;
  tax: number;
  total: number;
}

function inv(
  no: string, code: string, date: string, type: string,
  buyer: string, buyerTax: string, seller: string, sellerTax: string,
  goods: string, amount: number, rate: number,
): InvoiceRow {
  const tax = Math.round(amount * rate * 100) / 100;
  return { no, code, date, type, buyer, buyerTax, seller, sellerTax, goods, amount, rate, tax, total: Math.round((amount + tax) * 100) / 100 };
}

const INVOICES: InvoiceRow[] = [
  // ---- 进项（购方是本企业） ----
  inv('24011201', '031002400111', '2024-01-04', '增值税专用发票', COMPANY, COMPANY_TAX_NO, '东莞精密制造有限公司', '91441900MA4WXXXXXX', '电子元器件', 100000.00, 0.13),
  inv('24011202', '031002400111', '2024-01-06', '增值税专用发票', COMPANY, COMPANY_TAX_NO, '深圳顺捷物流有限公司', '91440300MA5FXXXXXX', '运输服务', 20000.00, 0.09),
  inv('24011203', '031002400111', '2024-01-09', '增值税专用发票', COMPANY, COMPANY_TAX_NO, '广州云智软件有限公司', '91440100MA5GXXXXXX', '技术服务费', 50000.00, 0.06),
  inv('24011204', '031002400111', '2024-01-11', '增值税普通发票', COMPANY, COMPANY_TAX_NO, '京东办公用品旗舰店', '91110108MA0XXXXXXX', '办公用品', 10000.00, 0.13),
  inv('24011205', '031002400111', '2024-01-16', '增值税专用发票', COMPANY, COMPANY_TAX_NO, '江苏精工机械有限公司', '91320100MA1MXXXXXX', '数控机床设备', 800000.00, 0.13),
  inv('24011206', '031002400111', '2024-01-19', '增值税专用发票', COMPANY, COMPANY_TAX_NO, '上海锦江国际酒店', '91310101MA1FXXXXXX', '住宿服务', 12000.00, 0.06),
  inv('24011207', '031002400111', '2024-01-24', '增值税专用发票', COMPANY, COMPANY_TAX_NO, '国网上海市电力公司', '91310101MA1KXXXXXX', '电力', 8432.60, 0.13),
  inv('24011208', '031002400111', '2024-01-29', '增值税普通发票', COMPANY, COMPANY_TAX_NO, '上海联合律师事务所', '91310101MA1LXXXXXX', '法律服务', 30000.00, 0.06),
  // ---- 销项（销方是本企业） ----
  inv('24011301', '031002400222', '2024-01-05', '增值税专用发票', '上海远景科技有限公司', '91310115MA1HXXXXXX', COMPANY, COMPANY_TAX_NO, '智能控制器', 300000.00, 0.13),
  inv('24011302', '031002400222', '2024-01-12', '增值税专用发票', '北京华信集团有限公司', '91110105MA0XXXXXXX', COMPANY, COMPANY_TAX_NO, '技术服务', 120000.00, 0.06),
  inv('24011303', '031002400222', '2024-01-22', '增值税专用发票', '广州南方贸易有限公司', '91440101MA5HXXXXXX', COMPANY, COMPANY_TAX_NO, '智能控制器', 80000.00, 0.13),
  inv('24011304', '031002400222', '2024-01-30', '增值税普通发票', '深圳华强电子有限公司', '91440300MA5GXXXXXX', COMPANY, COMPANY_TAX_NO, '技术服务', 55000.00, 0.06),
];

async function makeInvoiceFile(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('发票台账');

  sheet.getCell('A1').value = `${COMPANY} — 2024年1月 发票台账`;
  sheet.getCell('A1').font = TITLE_FONT;
  sheet.mergeCells('A1:M1');
  sheet.getCell('A1').alignment = { horizontal: 'center' };

  const headers = ['发票号码', '发票代码', '开票日期', '发票种类', '购方名称', '购方税号', '销方名称', '销方税号', '货物或应税劳务名称', '金额', '税率', '税额', '价税合计'];
  const headerRow = sheet.getRow(2);
  headers.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h;
  });
  styleHeaderRow(sheet, 2, headers.length);

  INVOICES.forEach((invRow, index) => {
    const row = sheet.getRow(index + 3);
    row.getCell(1).value = invRow.no;
    row.getCell(2).value = invRow.code;
    row.getCell(3).value = invRow.date;
    row.getCell(4).value = invRow.type;
    row.getCell(5).value = invRow.buyer;
    row.getCell(6).value = invRow.buyerTax;
    row.getCell(7).value = invRow.seller;
    row.getCell(8).value = invRow.sellerTax;
    row.getCell(9).value = invRow.goods;
    row.getCell(10).value = invRow.amount;
    row.getCell(11).value = invRow.rate;
    row.getCell(12).value = invRow.tax;
    row.getCell(13).value = invRow.total;
  });

  styleBody(sheet, 3, headers.length, [10, 12, 13]);
  for (let r = 3; r <= sheet.rowCount; r += 1) {
    sheet.getRow(r).getCell(11).numFmt = '0%';
  }

  sheet.columns.forEach((col, i) => {
    const widths = [12, 15, 12, 18, 24, 22, 24, 22, 22, 13, 8, 12, 14];
    col.width = widths[i] ?? 14;
  });

  const path = join(OUT_DIR, '02-发票台账-2024年1月.xlsx');
  await wb.xlsx.writeFile(path);
  return path;
}

/* ================================================================== */
/* 3. 费用报销明细                                                     */
/* ================================================================== */

interface ExpenseRow {
  date: string;
  employee: string;
  department: string;
  category: string;
  reason: string;
  amount: number;
  tax: number | null;
  invoiceCount: number;
}

const EXPENSES: ExpenseRow[] = [
  { date: '2024-01-08', employee: '张伟', department: '销售部', category: '差旅费', reason: '上海客户拜访差旅（机票+住宿）', amount: 3680.50, tax: 208.33, invoiceCount: 4 },
  { date: '2024-01-09', employee: '李娜', department: '市场部', category: '业务招待费', reason: '重点客户业务招待餐费', amount: 2860.00, tax: 161.89, invoiceCount: 2 },
  { date: '2024-01-11', employee: '王强', department: '技术部', category: '办公费', reason: '采购打印耗材及办公用品', amount: 1245.80, tax: 143.34, invoiceCount: 1 },
  { date: '2024-01-15', employee: '赵敏', department: '行政部', category: '水电费', reason: '2023年12月办公场所水电费', amount: 4832.60, tax: null, invoiceCount: 2 },
  { date: '2024-01-18', employee: '刘洋', department: '销售部', category: '业务招待费', reason: '客户考察团接待费用', amount: 5600.00, tax: null, invoiceCount: 3 },
  { date: '2024-01-22', employee: '陈静', department: '财务部', category: '咨询顾问费', reason: '2023年度财务审计费', amount: 30000.00, tax: 1698.11, invoiceCount: 1 },
  { date: '2024-01-25', employee: '张伟', department: '销售部', category: '差旅费', reason: '广州出差住宿费', amount: 2150.00, tax: 121.70, invoiceCount: 2 },
  { date: '2024-01-28', employee: '孙磊', department: '研发部', category: '研发费用', reason: '新产品试验材料采购', amount: 18600.00, tax: 2139.82, invoiceCount: 5 },
  { date: '2024-01-29', employee: '赵敏', department: '行政部', category: '通讯费', reason: '公司固定电话及宽带费', amount: 1680.00, tax: null, invoiceCount: 1 },
  { date: '2024-01-31', employee: '刘洋', department: '销售部', category: '车辆使用费', reason: '业务用车加油及过路费', amount: 2340.00, tax: null, invoiceCount: 6 },
];

async function makeExpenseFile(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('费用明细');

  sheet.getCell('A1').value = '2024年1月 费用报销明细表';
  sheet.getCell('A1').font = TITLE_FONT;
  sheet.mergeCells('A1:H1');
  sheet.getCell('A1').alignment = { horizontal: 'center' };

  const headers = ['报销日期', '报销人', '部门', '费用类别', '事由', '金额', '税额', '发票张数'];
  const headerRow = sheet.getRow(3);
  headers.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h;
  });
  styleHeaderRow(sheet, 3, headers.length);

  EXPENSES.forEach((e, index) => {
    const row = sheet.getRow(index + 4);
    row.getCell(1).value = e.date;
    row.getCell(2).value = e.employee;
    row.getCell(3).value = e.department;
    row.getCell(4).value = e.category;
    row.getCell(5).value = e.reason;
    row.getCell(6).value = e.amount;
    row.getCell(7).value = e.tax;
    row.getCell(8).value = e.invoiceCount;
  });

  const totalRowIndex = EXPENSES.length + 4;
  const totalRow = sheet.getRow(totalRowIndex);
  totalRow.getCell(5).value = '合计';
  totalRow.getCell(6).value = EXPENSES.reduce((s, e) => s + e.amount, 0);
  totalRow.font = { ...BODY_FONT, bold: true };

  styleBody(sheet, 4, headers.length, [6, 7]);

  sheet.columns.forEach((col, i) => {
    const widths = [13, 10, 12, 14, 36, 13, 12, 10];
    col.width = widths[i] ?? 14;
  });

  const path = join(OUT_DIR, '03-费用报销明细-2024年1月.xlsx');
  await wb.xlsx.writeFile(path);
  return path;
}

/* ================================================================== */
/* 4. 工资表                                                           */
/* ================================================================== */

interface Employee {
  no: string;
  name: string;
  department: string;
  base: number;
  bonus: number;
  allowance: number;
  social: number;
  fund: number;
  tax: number;
}

const EMPLOYEES: Employee[] = [
  { no: 'E001', name: '张伟', department: '销售部', base: 12000, bonus: 15000, allowance: 2000, social: 2520.00, fund: 1680.00, tax: 2890.00 },
  { no: 'E002', name: '李娜', department: '市场部', base: 11000, bonus: 8000, allowance: 1500, social: 2310.00, fund: 1540.00, tax: 1370.00 },
  { no: 'E003', name: '王强', department: '技术部', base: 18000, bonus: 10000, allowance: 2000, social: 3780.00, fund: 2520.00, tax: 3980.00 },
  { no: 'E004', name: '赵敏', department: '行政部', base: 9000, bonus: 3000, allowance: 1000, social: 1890.00, fund: 1260.00, tax: 385.00 },
  { no: 'E005', name: '刘洋', department: '销售部', base: 13000, bonus: 12000, allowance: 2000, social: 2730.00, fund: 1820.00, tax: 2680.00 },
  { no: 'E006', name: '陈静', department: '财务部', base: 14000, bonus: 5000, allowance: 1500, social: 2940.00, fund: 1960.00, tax: 1235.00 },
  { no: 'E007', name: '孙磊', department: '研发部', base: 20000, bonus: 12000, allowance: 2500, social: 4200.00, fund: 2800.00, tax: 5180.00 },
  { no: 'E008', name: '周涛', department: '生产部', base: 8500, bonus: 3500, allowance: 1200, social: 1785.00, fund: 1190.00, tax: 310.00 },
  { no: 'E009', name: '吴敏', department: '生产部', base: 7800, bonus: 2800, allowance: 1200, social: 1638.00, fund: 1092.00, tax: 180.00 },
  { no: 'E010', name: '郑凯', department: '物流部', base: 8000, bonus: 2500, allowance: 1000, social: 1680.00, fund: 1120.00, tax: 145.00 },
];

async function makePayrollFile(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('工资表');

  sheet.getCell('A1').value = `${COMPANY} — 2024年1月 工资表`;
  sheet.getCell('A1').font = TITLE_FONT;
  sheet.mergeCells('A1:M1');
  sheet.getCell('A1').alignment = { horizontal: 'center' };

  const headers = ['工号', '姓名', '部门', '基本工资', '绩效奖金', '岗位津贴', '应发合计', '个人社保', '个人公积金', '个人所得税', '实发合计', '单位社保', '单位公积金'];
  const headerRow = sheet.getRow(2);
  headers.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h;
  });
  styleHeaderRow(sheet, 2, headers.length);

  EMPLOYEES.forEach((e, index) => {
    const gross = e.base + e.bonus + e.allowance;
    const net = Math.round((gross - e.social - e.fund - e.tax) * 100) / 100;
    // 单位承担部分按常规比例：社保约 27%，公积金 12%
    const employerSocial = Math.round(e.base * 0.27 * 100) / 100;
    const employerFund = Math.round(e.base * 0.12 * 100) / 100;

    const row = sheet.getRow(index + 3);
    row.getCell(1).value = e.no;
    row.getCell(2).value = e.name;
    row.getCell(3).value = e.department;
    row.getCell(4).value = e.base;
    row.getCell(5).value = e.bonus;
    row.getCell(6).value = e.allowance;
    row.getCell(7).value = gross;
    row.getCell(8).value = e.social;
    row.getCell(9).value = e.fund;
    row.getCell(10).value = e.tax;
    row.getCell(11).value = net;
    row.getCell(12).value = employerSocial;
    row.getCell(13).value = employerFund;
  });

  const totalRowIndex = EMPLOYEES.length + 3;
  const totalRow = sheet.getRow(totalRowIndex);
  totalRow.getCell(3).value = '合计';
  for (const col of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
    const letter = String.fromCharCode(64 + col);
    totalRow.getCell(col).value = EMPLOYEES.reduce((sum, e) => {
      const gross = e.base + e.bonus + e.allowance;
      switch (col) {
        case 4: return sum + e.base;
        case 5: return sum + e.bonus;
        case 6: return sum + e.allowance;
        case 7: return sum + gross;
        case 8: return sum + e.social;
        case 9: return sum + e.fund;
        case 10: return sum + e.tax;
        case 11: return sum + Math.round((gross - e.social - e.fund - e.tax) * 100) / 100;
        case 12: return sum + Math.round(e.base * 0.27 * 100) / 100;
        case 13: return sum + Math.round(e.base * 0.12 * 100) / 100;
        default: return sum;
      }
    }, 0);
    void letter;
  }
  totalRow.font = { ...BODY_FONT, bold: true };

  styleBody(sheet, 3, headers.length, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

  sheet.columns.forEach((col, i) => {
    const widths = [9, 9, 11, 12, 12, 12, 13, 12, 13, 12, 13, 12, 13];
    col.width = widths[i] ?? 12;
  });

  const path = join(OUT_DIR, '04-工资表-2024年1月.xlsx');
  await wb.xlsx.writeFile(path);
  return path;
}

/* ================================================================== */
/* 5. Word 采购合同                                                    */
/* ================================================================== */

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function para(text: string, opts: { bold?: boolean; align?: 'center'; size?: number } = {}): string {
  const rPr =
    (opts.bold === true ? '<w:b/>' : '') +
    (opts.size === undefined ? '' : `<w:sz w:val="${opts.size * 2}"/>`);
  const pPr = opts.align === 'center' ? '<w:pPr><w:jc w:val="center"/></w:pPr>' : '';
  return `<w:p>${pPr}<w:r>${rPr === '' ? '' : `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function table(rows: readonly (readonly string[])[]): string {
  const trs = rows
    .map((cells) => {
      const tcs = cells
        .map(
          (cell) =>
            `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${para(cell)}</w:tc>`,
        )
        .join('');
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${trs}</w:tbl>`;
}

async function makeContractFile(): Promise<string> {
  const body: string[] = [
    para('设备采购合同', { bold: true, align: 'center', size: 16 }),
    para(''),
    para(`合同编号：HT-2024-0116`),
    para(`甲方（采购方）：${COMPANY}`),
    para('乙方（供应方）：江苏精工机械有限公司'),
    para(''),
    para('根据《中华人民共和国民法典》及相关法律法规的规定，甲乙双方本着平等自愿、诚实信用的原则，就甲方向乙方采购生产设备事宜达成如下协议：'),
    para(''),
    para('第一条  标的物', { bold: true }),
    para('乙方向甲方供应下列设备：'),
    table([
      ['序号', '设备名称', '规格型号', '数量', '单价（元）', '金额（元）'],
      ['1', '数控加工中心', 'VMC-850', '2', '320,000.00', '640,000.00'],
      ['2', '精密磨床', 'MK1320', '2', '120,000.00', '240,000.00'],
      ['3', '辅助工装夹具', '通用', '1', '24,000.00', '24,000.00'],
      ['合计', '', '', '', '', '904,000.00'],
    ]),
    para(''),
    para('第二条  合同金额', { bold: true }),
    para('合同总金额（含税）：人民币 904,000.00 元。'),
    para('大写：人民币玖拾万零肆仟元整。'),
    para('上述金额为含税总价，增值税税率 13%，已包含设备价款、包装费、运输费及安装调试费。'),
    para(''),
    para('第三条  结算方式', { bold: true }),
    para('结算方式：银行转账。'),
    para('付款方式：合同签订后五个工作日内，甲方向乙方支付预付款 30%，即人民币 271,200.00 元；'),
    para('设备到货并验收合格后十五个工作日内，甲方支付进度款 60%，即人民币 542,400.00 元；'),
    para('剩余 10% 作为质保金，即人民币 90,400.00 元，于质保期满且无质量问题后支付。'),
    para(''),
    para('第四条  交付与验收', { bold: true }),
    para('乙方应于收到预付款之日起六十日内将全部设备运抵甲方指定地点，并完成安装调试。'),
    para('甲方应在设备安装调试完成后十个工作日内组织验收，验收合格后出具验收单。'),
    para(''),
    para('第五条  履约期限', { bold: true }),
    para('合同期限：自2024年1月16日起至2024年12月31日止。'),
    para('质保期：自验收合格之日起十二个月。'),
    para(''),
    para('第六条  违约责任', { bold: true }),
    para('任何一方未按本合同约定履行义务的，应向守约方支付合同总金额 5% 的违约金，并赔偿由此造成的实际损失。'),
    para(''),
    para('第七条  争议解决', { bold: true }),
    para('因本合同引起的争议，双方应友好协商解决；协商不成的，提交合同签订地人民法院诉讼解决。'),
    para(''),
    para('第八条  其他', { bold: true }),
    para('本合同一式肆份，甲乙双方各执贰份，自双方签字盖章之日起生效。'),
    para(''),
    para(''),
    para(`甲方（盖章）：${COMPANY}`),
    para('法定代表人（签字）：________________'),
    para('签订日期：2024年01月16日'),
    para(''),
    para('乙方（盖章）：江苏精工机械有限公司'),
    para('法定代表人（签字）：________________'),
    para('签订日期：2024年01月16日'),
  ];

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body.join('\n')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.folder('_rels')?.file('.rels', rels);
  zip.folder('word')?.file('document.xml', documentXml);

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const path = join(OUT_DIR, '05-采购合同-数控设备.docx');
  await writeFile(path, buffer);
  return path;
}

/* ================================================================== */

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const files = [
    await makeBankFile(),
    await makeInvoiceFile(),
    await makeExpenseFile(),
    await makePayrollFile(),
    await makeContractFile(),
  ];

  console.log('已生成样例文件：');
  for (const f of files) {
    console.log(`  ${f}`);
  }
  console.log();
  console.log('试运行：');
  console.log('  node src/cli.ts samples --period 2024-01');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
