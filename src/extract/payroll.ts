/**
 * 工资表 / 社保公积金 提取器。
 *
 * 工资的会计处理是「三段式」，因此一个工资表文件会产出三类单据：
 *   1. 计提（stage=accrual）    ：逐人 → 借 费用，贷 应付职工薪酬-工资
 *   2. 发放（stage=payment）    ：汇总 → 借 应付职工薪酬-工资，贷 银行存款/个税/社保/公积金
 *   3. 单位承担社保（stage=employer-contribution）：汇总 → 借 费用，贷 应付职工薪酬-社保
 *
 * 拆分依据是「应发 = 实发 + 个税 + 个人社保 + 个人公积金 + 其他扣款」这一恒等式，
 * 提取时会做校验并把差额写入 warnings。
 */

import type { CellValue, Cents, DocumentRecord, RawSheet } from '../core/types.ts';
import { formatYuan, sumCents } from '../core/money.ts';
import { parseDate } from '../core/datetime.ts';
import { isBlank, normalizeText } from '../core/text.ts';
import { pickBestSheet, textOf, valueOf, type ColumnMapping } from '../io/table-detect.ts';
import { PAYROLL_COLUMNS } from './schemas.ts';
import { amountOf, buildDocument, detectDepartment, isSummaryRow, makeSummary } from './common.ts';

export interface PayrollExtraction {
  documents: DocumentRecord[];
  warnings: string[];
  mapping: ColumnMapping | null;
  sheetName: string | null;
}

export interface PayrollExtractOptions {
  departments?: readonly string[];
  /** 工资所属期间的兜底值（YYYY-MM），表内没有月份列时使用 */
  defaultPeriod?: string;
}

/** 单个员工的工资构成。 */
interface EmployeePayroll {
  name: string;
  employeeNo: string;
  department: string;
  idNo: string;
  gross: Cents;
  base: Cents;
  bonus: Cents;
  allowance: Cents;
  overtime: Cents;
  socialInsurance: Cents;
  housingFund: Cents;
  tax: Cents;
  otherDeduction: Cents;
  net: Cents;
  employerSocialInsurance: Cents;
  employerHousingFund: Cents;
  rowNumber: number;
  warnings: string[];
}

const ZERO = 0;

function centsOrZero(value: CellValue): Cents {
  const c = amountOf(value);
  return c === null ? ZERO : Math.abs(c);
}

/**
 * 补全一个员工的工资构成。
 *
 * 缺失值的推断顺序：
 *  - 应发缺失 → 实发 + 各项扣款
 *  - 实发缺失 → 应发 - 各项扣款
 *  - 两者都缺 → 用 基本工资+奖金+补贴+加班费
 */
function completePayroll(e: EmployeePayroll): void {
  const deductions = e.socialInsurance + e.housingFund + e.tax + e.otherDeduction;
  const components = e.base + e.bonus + e.allowance + e.overtime;

  if (e.gross === 0 && e.net > 0) {
    e.gross = e.net + deductions;
    e.warnings.push(`应发工资缺失，按实发 ${formatYuan(e.net)} + 扣款 ${formatYuan(deductions)} 推算`);
  } else if (e.gross === 0 && components > 0) {
    e.gross = components;
    e.warnings.push('应发工资缺失，按工资构成项合计推算');
  }

  if (e.net === 0 && e.gross > 0) {
    const computed = e.gross - deductions;
    if (computed >= 0) {
      e.net = computed;
      e.warnings.push(`实发工资缺失，按应发 ${formatYuan(e.gross)} - 扣款 ${formatYuan(deductions)} 推算`);
    } else {
      e.net = e.gross;
      e.warnings.push('扣款合计大于应发工资，实发工资已按应发工资处理，请人工核对');
    }
  }

  // 恒等式校验
  const check = e.net + deductions;
  if (e.gross > 0 && Math.abs(check - e.gross) > 1) {
    const diff = e.gross - check;
    if (Math.abs(diff) > 1) {
      e.warnings.push(
        `工资勾稽差异 ${formatYuan(diff)}：应发 ${formatYuan(e.gross)} ≠ 实发 ${formatYuan(e.net)} + ` +
          `个税 ${formatYuan(e.tax)} + 社保 ${formatYuan(e.socialInsurance)} + ` +
          `公积金 ${formatYuan(e.housingFund)} + 其他扣款 ${formatYuan(e.otherDeduction)}`,
      );
    }
  }
}

export function extractPayrollFromSheet(
  sheet: RawSheet,
  mapping: ColumnMapping,
  filePath: string,
  options: PayrollExtractOptions = {},
): PayrollExtraction {
  const documents: DocumentRecord[] = [];
  const warnings: string[] = [];
  const departments = options.departments ?? [];
  const employees: EmployeePayroll[] = [];

  let detectedPeriod: string | null = null;

  for (const row of sheet.rows) {
    if (isSummaryRow(row, mapping)) continue;

    const name = textOf(row, mapping, 'employee');
    const gross = centsOrZero(valueOf(row, mapping, 'grossPay'));
    const net = centsOrZero(valueOf(row, mapping, 'netPay'));

    // 既没名字又没金额的行直接跳过（表尾说明、空行等）
    if (name === '' && gross === 0 && net === 0) continue;
    if (name === '' && gross === 0) continue;

    const periodText = textOf(row, mapping, 'period');
    if (periodText !== '' && detectedPeriod === null) {
      const parsed = parseDate(periodText);
      if (parsed !== null) detectedPeriod = parsed.slice(0, 7);
    }

    let department = textOf(row, mapping, 'department');
    if (department === '') {
      department = detectDepartment(name, departments) ?? '';
    }

    const employee: EmployeePayroll = {
      name: name === '' ? '未知员工' : name,
      employeeNo: textOf(row, mapping, 'employeeNo'),
      department,
      idNo: textOf(row, mapping, 'idNo'),
      gross,
      base: centsOrZero(valueOf(row, mapping, 'baseSalary')),
      bonus: centsOrZero(valueOf(row, mapping, 'bonus')),
      allowance: centsOrZero(valueOf(row, mapping, 'allowance')),
      overtime: centsOrZero(valueOf(row, mapping, 'overtime')),
      socialInsurance: centsOrZero(valueOf(row, mapping, 'socialInsurance')),
      housingFund: centsOrZero(valueOf(row, mapping, 'housingFund')),
      tax: centsOrZero(valueOf(row, mapping, 'tax')),
      otherDeduction: centsOrZero(valueOf(row, mapping, 'otherDeduction')),
      net,
      employerSocialInsurance: centsOrZero(valueOf(row, mapping, 'employerSocialInsurance')),
      employerHousingFund: centsOrZero(valueOf(row, mapping, 'employerHousingFund')),
      rowNumber: row.rowNumber,
      warnings: [],
    };

    completePayroll(employee);
    if (employee.gross > 0 || employee.net > 0) employees.push(employee);
  }

  if (employees.length === 0) {
    return {
      documents: [],
      warnings: [`工作表「${sheet.sheetName}」未提取到任何有效工资记录`],
      mapping,
      sheetName: sheet.sheetName,
    };
  }

  const period = detectedPeriod ?? options.defaultPeriod ?? null;
  const payrollDate = period === null ? null : `${period}-01`;

  /* ---------------- 1. 逐人计提 ---------------- */
  for (const e of employees) {
    const fields: Record<string, string | number | boolean | null> = {
      stage: 'accrual',
      employee: e.name,
      employeeNo: e.employeeNo,
      department: e.department,
      idNo: e.idNo,
      period: period ?? '',
      grossPay: formatYuan(e.gross),
      netPay: formatYuan(e.net),
      socialInsurance: formatYuan(e.socialInsurance),
      housingFund: formatYuan(e.housingFund),
      tax: formatYuan(e.tax),
      otherDeduction: formatYuan(e.otherDeduction),
      employerSocialInsurance: formatYuan(e.employerSocialInsurance),
      employerHousingFund: formatYuan(e.employerHousingFund),
    };

    documents.push(
      buildDocument({
        kind: 'payroll',
        file: filePath,
        sheet: sheet.sheetName,
        row: e.rowNumber,
        date: payrollDate,
        summary: makeSummary(period === null ? '工资计提' : `${period} 工资计提`, e.department, e.name),
        amount: e.gross,
        direction: 'none',
        counterparty: e.name,
        fields,
        rawSummary: `${e.name} 应发 ${formatYuan(e.gross)}`,
        warnings: [...e.warnings],
      }),
    );
  }

  /* ---------------- 2. 汇总发放 ---------------- */
  const totalGross = sumCents(employees.map((e) => e.gross));
  const totalNet = sumCents(employees.map((e) => e.net));
  const totalTax = sumCents(employees.map((e) => e.tax));
  const totalSi = sumCents(employees.map((e) => e.socialInsurance));
  const totalHf = sumCents(employees.map((e) => e.housingFund));
  const totalOther = sumCents(employees.map((e) => e.otherDeduction));

  const paymentWarnings: string[] = [];
  const paymentCheck = totalNet + totalTax + totalSi + totalHf + totalOther;
  if (Math.abs(paymentCheck - totalGross) > 1) {
    paymentWarnings.push(
      `发放汇总勾稽差异 ${formatYuan(totalGross - paymentCheck)}：应发合计 ${formatYuan(totalGross)} ≠ ` +
        `实发 ${formatYuan(totalNet)} + 个税 ${formatYuan(totalTax)} + 社保 ${formatYuan(totalSi)} + ` +
        `公积金 ${formatYuan(totalHf)} + 其他扣款 ${formatYuan(totalOther)}`,
    );
  }

  documents.push(
    buildDocument({
      kind: 'payroll',
      file: filePath,
      sheet: sheet.sheetName,
      row: employees[0]?.rowNumber ?? 0,
      date: payrollDate,
      summary: makeSummary(period === null ? '工资发放' : `${period} 工资发放`, `共 ${employees.length} 人`),
      amount: totalGross,
      direction: 'out',
      counterparty: null,
      fields: {
        stage: 'payment',
        period: period ?? '',
        headcount: employees.length,
        grossPay: formatYuan(totalGross),
        netPay: formatYuan(totalNet),
        socialInsurance: formatYuan(totalSi),
        housingFund: formatYuan(totalHf),
        tax: formatYuan(totalTax),
        otherDeduction: formatYuan(totalOther),
      },
      rawSummary: `实发合计 ${formatYuan(totalNet)}`,
      warnings: paymentWarnings,
    }),
  );

  /* ---------------- 3. 单位承担社保公积金 ---------------- */
  const totalEmployerSi = sumCents(employees.map((e) => e.employerSocialInsurance));
  const totalEmployerHf = sumCents(employees.map((e) => e.employerHousingFund));

  if (totalEmployerSi + totalEmployerHf > 0) {
    const byDepartment = new Map<string, { si: Cents; hf: Cents; count: number }>();
    for (const e of employees) {
      const dept = e.department === '' ? '未分配' : e.department;
      const bucket = byDepartment.get(dept) ?? { si: 0, hf: 0, count: 0 };
      bucket.si += e.employerSocialInsurance;
      bucket.hf += e.employerHousingFund;
      bucket.count += 1;
      byDepartment.set(dept, bucket);
    }

    for (const [dept, bucket] of byDepartment) {
      if (bucket.si + bucket.hf === 0) continue;
      documents.push(
        buildDocument({
          kind: 'payroll',
          file: filePath,
          sheet: sheet.sheetName,
          row: employees[0]?.rowNumber ?? 0,
          date: payrollDate,
          summary: makeSummary(
            period === null ? '单位社保公积金' : `${period} 单位承担社保公积金`,
            dept,
          ),
          amount: bucket.si + bucket.hf,
          direction: 'none',
          counterparty: null,
          fields: {
            stage: 'employer-contribution',
            period: period ?? '',
            department: dept,
            headcount: bucket.count,
            employerSocialInsurance: formatYuan(bucket.si),
            employerHousingFund: formatYuan(bucket.hf),
            socialInsurance: formatYuan(bucket.si),
            housingFund: formatYuan(bucket.hf),
          },
          rawSummary: `单位社保 ${formatYuan(bucket.si)} 公积金 ${formatYuan(bucket.hf)}`,
          warnings: [],
        }),
      );
    }
  }

  if (period === null) {
    warnings.push(
      '工资表未包含可识别的月份信息，生成凭证时需手工指定会计期间（可用 --period 参数，或在表中增加「工资月份」列）',
    );
  }

  const incomplete = employees.filter((e) => e.warnings.length > 0).length;
  if (incomplete > 0) {
    warnings.push(`有 ${incomplete} 名员工的工资数据存在勾稽差异或缺失项，已逐条标注`);
  }

  return { documents, warnings, mapping, sheetName: sheet.sheetName };
}

export function extractPayroll(
  sheets: readonly RawSheet[],
  filePath: string,
  options: PayrollExtractOptions = {},
): PayrollExtraction {
  const best = pickBestSheet(sheets, PAYROLL_COLUMNS);
  if (best === null) {
    return {
      documents: [],
      warnings: [`${filePath}: 未找到可识别的工资表表头`],
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
  return extractPayrollFromSheet(best.sheet, best.mapping, filePath, options);
}

export { isBlank, normalizeText };
