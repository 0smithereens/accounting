/**
 * 导出「申报底稿」Excel。
 *
 * 这不是提交接口，而是**打印件**：给会计人员拿去电子税务局照着填。
 * 因此每一张工作表的第一行都是同一句声明——「本文件为申报底稿，需由人工在电子税务局核对后
 * 自行申报，系统不代为提交」。为什么要重复三遍？因为底稿会被拆开、截图、转发，
 * 任何一页单独流出去时都必须带着这句话。
 *
 * 三张表的分工：
 *   1. 申报表主表          对着税表栏次照抄用（栏次 / 项目 / 金额 / 税率 / 说明）
 *   2. 计算过程与法规依据  复核人用来证明「这个数是怎么来的、依据哪一条」
 *   3. 签署与留痕          谁算的、谁复核的、谁批的、什么时候导出的、回执号是多少
 *
 * 金额一律写数值（两位小数格式）而不是文本，方便会计直接复制进电子税务局。
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import ExcelJS from 'exceljs';

import type {
  LawBasis,
  ManualFilingRecord,
  Signature,
  TaxLine,
  TaxReturn,
} from '../core/contracts.ts';
import {
  ACCOUNTING_STANDARD_LABEL,
  FILING_STATUS_LABEL,
  TAX_TYPE_LABEL,
} from '../core/contracts.ts';
import { formatYuan } from '../core/money.ts';
import {
  assertExportable,
  FILING_DECLARATION,
  loadFilingConfig,
  SIGN_ROLE_LABEL,
} from './guard.ts';
import type { FilingConfig } from './guard.ts';

/* ------------------------------------------------------------------ */
/* 样式常量                                                            */
/* ------------------------------------------------------------------ */

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
const WARN_FILL = 'FFFFEB9C';
const OK_FILL = 'FFEAF1DD';

const CHANNEL_LABEL: Record<ManualFilingRecord['channel'], string> = {
  'etax-manual': '电子税务局（网页端）',
  'etax-client': '电子税务局（客户端）',
  'offline-window': '办税服务厅窗口',
};

const METHOD_LABEL: Record<Signature['method'], string> = {
  manual: '手工确认',
  totp: '动态口令',
  certificate: '数字证书',
};

/* ------------------------------------------------------------------ */
/* 通用写入                                                            */
/* ------------------------------------------------------------------ */

function setWidths(sheet: ExcelJS.Worksheet, widths: readonly number[]): void {
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
}

/** 表头声明：三张表都要有，且必须是第一行。 */
function addBanner(sheet: ExcelJS.Worksheet, columnCount: number): void {
  const row = sheet.addRow([FILING_DECLARATION]);
  sheet.mergeCells(row.number, 1, row.number, columnCount);
  const cell = sheet.getCell(row.number, 1);
  cell.value = FILING_DECLARATION;
  cell.font = { bold: true, size: 11, color: { argb: 'FF9C0006' }, name: '微软雅黑' };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARN_FILL } };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  cell.border = THIN_BORDER;
  row.height = 38;
}

function addTitle(sheet: ExcelJS.Worksheet, text: string, columnCount: number): void {
  const row = sheet.addRow([text]);
  sheet.mergeCells(row.number, 1, row.number, columnCount);
  const cell = sheet.getCell(row.number, 1);
  cell.value = text;
  cell.font = { bold: true, size: 14, name: '微软雅黑' };
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 26;
}

function addSection(sheet: ExcelJS.Worksheet, text: string, columnCount: number): void {
  const row = sheet.addRow([text]);
  sheet.mergeCells(row.number, 1, row.number, columnCount);
  const cell = sheet.getCell(row.number, 1);
  cell.value = text;
  cell.font = { bold: true, size: 11, name: '微软雅黑', color: { argb: 'FF1F4E78' } };
  cell.alignment = { vertical: 'middle' };
  row.height = 22;
}

function addMeta(
  sheet: ExcelJS.Worksheet,
  label: string,
  value: string,
  columnCount: number,
): void {
  const row = sheet.addRow([label, value]);
  if (columnCount > 2) sheet.mergeCells(row.number, 2, row.number, columnCount);
  const labelCell = sheet.getCell(row.number, 1);
  labelCell.value = label;
  labelCell.font = { ...BODY_FONT, bold: true };
  labelCell.alignment = { vertical: 'middle' };
  labelCell.border = THIN_BORDER;
  const valueCell = sheet.getCell(row.number, 2);
  valueCell.value = value;
  valueCell.font = BODY_FONT;
  valueCell.alignment = { vertical: 'middle', wrapText: true };
  valueCell.border = THIN_BORDER;
}

function addHeaderRow(
  sheet: ExcelJS.Worksheet,
  headers: readonly string[],
  moneyColumns: readonly number[] = [],
): void {
  const row = sheet.addRow(headers as string[]);
  row.height = 24;
  headers.forEach((_, index) => {
    const cell = row.getCell(index + 1);
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = THIN_BORDER;
    if (moneyColumns.includes(index + 1)) cell.numFmt = MONEY_FORMAT;
  });
}

interface RowStyle {
  moneyColumns?: readonly number[];
  bold?: boolean;
  fill?: string;
  wrap?: boolean;
  color?: string;
}

function addDataRow(
  sheet: ExcelJS.Worksheet,
  values: ReadonlyArray<string | number | null>,
  columnCount: number,
  style: RowStyle = {},
): void {
  const row = sheet.addRow(values as Array<string | number | null>);
  const font: Partial<ExcelJS.Font> = { ...BODY_FONT };
  if (style.bold === true) font.bold = true;
  if (style.color !== undefined) font.color = { argb: style.color };
  row.font = font;
  if (style.fill !== undefined) {
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill } };
  }
  for (let column = 1; column <= columnCount; column += 1) {
    const cell = row.getCell(column);
    cell.border = THIN_BORDER;
    cell.alignment = { vertical: 'middle', wrapText: style.wrap === true };
    if (style.moneyColumns !== undefined && style.moneyColumns.includes(column)) {
      cell.numFmt = MONEY_FORMAT;
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
    }
  }
}

/** 税率显示：0.13 → 13%，0.015 → 1.50%。 */
function formatRate(rate: number): string {
  const percent = rate * 100;
  const text = Number.isInteger(percent) ? String(percent) : percent.toFixed(2);
  return `${text}%`;
}

function yuan(cents: number): number {
  return Number(formatYuan(cents));
}

function basisOf(line: TaxLine): LawBasis[] {
  return line.basis === undefined ? [] : [...line.basis];
}

/* ------------------------------------------------------------------ */
/* 表1：申报表主表                                                     */
/* ------------------------------------------------------------------ */

function buildMainSheet(wb: ExcelJS.Workbook, ret: TaxReturn): void {
  const sheet = wb.addWorksheet('申报表主表');
  setWidths(sheet, [12, 40, 18, 10, 58]);
  addBanner(sheet, 5);
  addTitle(sheet, `${TAX_TYPE_LABEL[ret.taxType]}申报底稿 · ${ret.period}`, 5);

  addMeta(sheet, '纳税人识别号', ret.taxpayerId, 5);
  addMeta(sheet, '所属期间', ret.period, 5);
  addMeta(sheet, '税种', TAX_TYPE_LABEL[ret.taxType], 5);
  addMeta(sheet, '会计准则', ACCOUNTING_STANDARD_LABEL[ret.standard], 5);
  addMeta(sheet, '申报状态', FILING_STATUS_LABEL[ret.status], 5);
  addMeta(sheet, '版本号', `第 ${ret.version} 版`, 5);
  addMeta(sheet, '计算指纹', ret.payloadHash, 5);
  addMeta(
    sheet,
    '审核报告',
    ret.reviewId === null
      ? '（无审核报告）'
      : `${ret.reviewId}（阻断项 ${ret.blockingIssues} 个）`,
    5,
  );
  addMeta(sheet, '申报方式', '人工在电子税务局申报（本系统不代为提交）', 5);

  addHeaderRow(sheet, ['栏次', '项目', '金额（元）', '税率', '计算说明'], [3]);

  for (const line of ret.lines) {
    addDataRow(
      sheet,
      [
        line.code,
        line.label,
        yuan(line.amount),
        line.rate === undefined ? '' : formatRate(line.rate),
        line.note ?? '',
      ],
      5,
      { moneyColumns: [3], wrap: true },
    );
  }

  addDataRow(sheet, ['', '本期应纳税额', yuan(ret.payable), '', '申报表「应纳税额」行合计'], 5, {
    moneyColumns: [3],
    bold: true,
    fill: OK_FILL,
  });
  addDataRow(sheet, ['', '本期已预缴税额', yuan(ret.prepaid), '', '已缴税款（完税凭证）'], 5, {
    moneyColumns: [3],
    bold: true,
  });
  addDataRow(
    sheet,
    ['', '应补(退)税额', yuan(ret.due), '', '应纳税额 - 已预缴；正数补税、负数退税'],
    5,
    { moneyColumns: [3], bold: true, fill: OK_FILL },
  );

  addDataRow(sheet, [], 5);
  addDataRow(
    sheet,
    [
      '说明：本表金额单位为元，系统内部以「分」为整数计算，不存在浮点误差；' +
        '栏次编码由税务引擎按官方申报表映射生成，如与当地电子税务局栏次不一致，请以电子税务局为准。',
    ],
    5,
    { wrap: true, color: 'FF808080' },
  );
}

/* ------------------------------------------------------------------ */
/* 表2：计算过程与法规依据                                             */
/* ------------------------------------------------------------------ */

const BASIS_COLUMNS = 10;

function pushBasisRows(
  sheet: ExcelJS.Worksheet,
  kind: string,
  code: string,
  label: string,
  amount: number,
  rate: string,
  note: string,
  basis: readonly LawBasis[],
): void {
  if (basis.length === 0) {
    addDataRow(
      sheet,
      [kind, code, label, amount, rate, note, '（未附法规依据，需复核人补充）', '', '', ''],
      BASIS_COLUMNS,
      { moneyColumns: [4], wrap: true, color: 'FF9C0006' },
    );
    return;
  }
  for (const item of basis) {
    addDataRow(
      sheet,
      [
        kind,
        code,
        label,
        amount,
        rate,
        note,
        item.title,
        item.article ?? '',
        item.excerpt ?? '',
        item.url ?? '',
      ],
      BASIS_COLUMNS,
      { moneyColumns: [4], wrap: true },
    );
  }
}

function buildCalculationSheet(wb: ExcelJS.Workbook, ret: TaxReturn): void {
  const sheet = wb.addWorksheet('计算过程与法规依据');
  setWidths(sheet, [10, 14, 30, 16, 9, 50, 30, 10, 48, 30]);
  addBanner(sheet, BASIS_COLUMNS);
  addTitle(sheet, '计算过程与法规依据', BASIS_COLUMNS);

  addSection(sheet, '一、申报行计算过程（每一栏次都要能追溯到算法与法条）', BASIS_COLUMNS);
  addHeaderRow(
    sheet,
    ['类型', '栏次', '项目', '金额（元）', '税率', '计算说明', '法规名称', '条款', '条款要点', '来源'],
    [4],
  );
  for (const line of ret.lines) {
    pushBasisRows(
      sheet,
      '申报行',
      line.code,
      line.label,
      yuan(line.amount),
      line.rate === undefined ? '' : formatRate(line.rate),
      line.note ?? '',
      basisOf(line),
    );
  }

  addSection(sheet, '二、纳税调整项（企业所得税汇算的核心，调增为正、调减为负）', BASIS_COLUMNS);
  addHeaderRow(
    sheet,
    ['类型', '编码', '项目', '金额（元）', '调增/调减', '调整理由', '法规名称', '条款', '条款要点', '数据来源'],
    [4],
  );
  if (ret.adjustments.length === 0) {
    addDataRow(sheet, ['纳税调整', '', '（本期无纳税调整项）', null, '', '', '', '', '', ''], BASIS_COLUMNS, {
      moneyColumns: [4],
    });
  }
  for (const adjustment of ret.adjustments) {
    pushBasisRows(
      sheet,
      '纳税调整',
      adjustment.code,
      adjustment.label,
      yuan(adjustment.amount),
      adjustment.amount > 0 ? '调增' : adjustment.amount < 0 ? '调减' : '—',
      adjustment.reason,
      adjustment.basis,
    );
  }

  addSection(sheet, '三、税收优惠匹配（不满足条件的也列出来，说明为什么不能享受）', BASIS_COLUMNS);
  addHeaderRow(
    sheet,
    ['类型', '政策编号', '政策名称', '测算减免（元）', '是否适用', '不适用原因 / 需人工确认', '法规名称', '条款', '条款要点', '来源'],
    [4],
  );
  if (ret.benefits.length === 0) {
    addDataRow(sheet, ['税收优惠', '', '（未匹配到可适用的优惠政策）', null, '', '', '', '', '', ''], BASIS_COLUMNS, {
      moneyColumns: [4],
    });
  }
  for (const benefit of ret.benefits) {
    const reasons = [...benefit.reasons, ...benefit.manualChecks];
    pushBasisRows(
      sheet,
      '税收优惠',
      benefit.policyId,
      benefit.policyName,
      yuan(benefit.estimatedBenefit),
      benefit.eligible ? '适用' : '不适用',
      reasons.length === 0 ? '（无附加条件）' : reasons.join('；'),
      benefit.basis,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 表3：签署与留痕                                                     */
/* ------------------------------------------------------------------ */

const SIGN_COLUMNS = 7;

function buildSignatureSheet(
  wb: ExcelJS.Workbook,
  ret: TaxReturn,
  config: FilingConfig | undefined,
): void {
  const sheet = wb.addWorksheet('签署与留痕');
  setWidths(sheet, [12, 18, 14, 26, 14, 24, 60]);
  addBanner(sheet, SIGN_COLUMNS);
  addTitle(sheet, '签署与留痕', SIGN_COLUMNS);

  addSection(sheet, '一、签署记录（只追加，不可修改、不可删除）', SIGN_COLUMNS);
  addHeaderRow(sheet, ['类别', '角色', '签署人', '签署时间', '签署方式', '签署时计算指纹', '备注']);
  if (ret.signatures.length === 0) {
    addDataRow(sheet, ['签署', '', '（无签署记录）', '', '', '', ''], SIGN_COLUMNS);
  }
  for (const signature of ret.signatures) {
    const stale = signature.payloadHash !== ret.payloadHash;
    addDataRow(
      sheet,
      [
        '签署',
        SIGN_ROLE_LABEL[signature.role],
        signature.actor,
        signature.at,
        METHOD_LABEL[signature.method],
        signature.payloadHash,
        `${signature.note ?? ''}${stale ? '（★该签署基于旧版本，已失效★）' : ''}`,
      ],
      SIGN_COLUMNS,
      stale ? { color: 'FF9C0006' } : {},
    );
  }

  addSection(sheet, '二、状态迁移事件（谁在什么时候把表推到了哪一步）', SIGN_COLUMNS);
  addHeaderRow(sheet, ['类别', '迁移', '操作人', '时间', '是否人工发起', '计算指纹', '原因']);
  for (const event of ret.events) {
    addDataRow(
      sheet,
      [
        '状态迁移',
        `${FILING_STATUS_LABEL[event.from]} → ${FILING_STATUS_LABEL[event.to]}`,
        event.actor,
        event.at,
        event.humanInitiated ? '是' : '否',
        '',
        event.reason ?? '',
      ],
      SIGN_COLUMNS,
      { wrap: true },
    );
  }

  addSection(sheet, '三、人工申报回填（系统不代为申报，此栏由人工在电子税务局办完后填写）', SIGN_COLUMNS);
  addHeaderRow(sheet, ['类别', '申报渠道', '回填人', '实际申报时间', '实缴金额（元）', '税务局受理回执号', '备注']);
  if (ret.manualFiling === undefined) {
    addDataRow(
      sheet,
      ['人工申报', '', '', '', null, '（尚未回填）', '请在电子税务局完成申报后，用回执号回填'],
      SIGN_COLUMNS,
      { moneyColumns: [5], color: 'FF9C0006' },
    );
  } else {
    const record = ret.manualFiling;
    addDataRow(
      sheet,
      [
        '人工申报',
        CHANNEL_LABEL[record.channel],
        record.actor,
        record.filedAt,
        yuan(record.paidAmount),
        record.receiptNo,
        record.note ?? '',
      ],
      SIGN_COLUMNS,
      { moneyColumns: [5], wrap: true },
    );
    if (record.paidAmount !== ret.due) {
      addDataRow(
        sheet,
        [
          '差异说明',
          '',
          '',
          '',
          yuan(record.paidAmount - ret.due),
          '',
          `实缴与应补(退)税额 ${formatYuan(ret.due)} 元不一致，差额已如实保留，不作调整`,
        ],
        SIGN_COLUMNS,
        { moneyColumns: [5], wrap: true, color: 'FF9C0006' },
      );
    }
  }

  addSection(sheet, '四、申报前自查清单（缺必备材料不得申报）', SIGN_COLUMNS);
  addHeaderRow(sheet, ['类别', '材料', '是否必备', '说明', '法规名称', '条款', '条款要点']);
  if (config === undefined) {
    addDataRow(
      sheet,
      ['必备材料', '（未能加载 config/filing.yaml，清单缺失）', '', '请检查配置文件后重新导出', '', '', ''],
      SIGN_COLUMNS,
      { color: 'FF9C0006' },
    );
  } else if (config.requiredMaterials.length === 0) {
    addDataRow(sheet, ['必备材料', '（配置未声明必备材料）', '', '', '', '', ''], SIGN_COLUMNS);
  } else {
    for (const material of config.requiredMaterials) {
      const first = material.basis[0];
      addDataRow(
        sheet,
        [
          '必备材料',
          material.label,
          material.required ? '必备' : '建议',
          material.description,
          first?.title ?? '',
          first?.article ?? '',
          first?.excerpt ?? '',
        ],
        SIGN_COLUMNS,
        { wrap: true },
      );
    }
  }

  addDataRow(sheet, [], SIGN_COLUMNS);
  addDataRow(
    sheet,
    [
      `导出时间：${new Date().toLocaleString('zh-CN')}；` +
        `申报表 ${ret.id}；第 ${ret.version} 版；计算指纹 ${ret.payloadHash}`,
    ],
    SIGN_COLUMNS,
    { wrap: true, color: 'FF808080' },
  );
  addDataRow(sheet, [FILING_DECLARATION], SIGN_COLUMNS, {
    bold: true,
    wrap: true,
    color: 'FF9C0006',
    fill: WARN_FILL,
  });
}

/* ------------------------------------------------------------------ */
/* 导出入口                                                            */
/* ------------------------------------------------------------------ */

function tryLoadConfig(): FilingConfig | undefined {
  try {
    return loadFilingConfig();
  } catch {
    // 配置读不到只影响「必备材料清单」这一栏，不影响底稿本身的合规性校验；
    // 表里会显式标注清单缺失，避免静默降级。
    return undefined;
  }
}

/**
 * 生成申报底稿工作簿。
 *
 * 为什么在这里再校验一次状态？因为这是一个导出到磁盘的函数，可能被 CLI / Web / 脚本
 * 以任意路径调用；把门禁放在函数入口，就不存在「绕过工作流直接调导出」的漏洞。
 */
export async function exportFilingPackage(ret: TaxReturn, outPath: string): Promise<void> {
  assertExportable(ret);
  const config = tryLoadConfig();

  const wb = new ExcelJS.Workbook();
  wb.creator = '账有律 · 会计自动化系统';
  wb.created = new Date();

  buildMainSheet(wb, ret);
  buildCalculationSheet(wb, ret);
  buildSignatureSheet(wb, ret, config);

  await mkdir(dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);
}

export { FILING_DECLARATION };
