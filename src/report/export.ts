/**
 * 报表与分析报告的导出。
 *
 * 三种形态，对应三类使用者：
 *   1. renderStatementText —— 纯文本，给 CLI 与日志看，等宽对齐（中文按 2 列宽计算）。
 *   2. renderAnalysisMarkdown —— Markdown，给 Web 预览、飞书/企微推送与归档。
 *   3. exportStatementsExcel —— Excel，给会计复核与对外报送前的人工签批。
 *
 * 金额在 Excel 中一律写数值（元，两位小数），不写文本，便于直接做透视与二次计算。
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import ExcelJS from 'exceljs';

import type {
  AnalysisAlert,
  FinancialAnalysis,
  FinancialRatio,
  FinancialStatement,
  StatementCheck,
  TrendPoint,
} from '../core/contracts.ts';
import { ACCOUNTING_STANDARD_LABEL, STATEMENT_KIND_LABEL } from '../core/contracts.ts';
import { formatYuan, formatYuanGrouped } from '../core/money.ts';
import { groupRatios } from './analysis.ts';
import { describeStructure } from './narrative.ts';
import { loadRatioConfig } from './mapping.ts';

/* ================================================================== */
/* 一、文本报表                                                        */
/* ================================================================== */

/** 中文按 2 列宽计算，保证等宽字体下对齐。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += code >= 0x1100 && (
      code <= 0x115f ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) ? 2 : 1;
  }
  return width;
}

function padEndDisplay(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : text + ' '.repeat(width - w);
}

function padStartDisplay(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : ' '.repeat(width - w) + text;
}

function amountText(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '';
  return formatYuanGrouped(amount);
}

/** 报表列名：利润表/现金流量表说「本期金额」，权益变动表说「本年金额」。 */
function columnLabels(kind: FinancialStatement['kind']): { current: string; prior: string } {
  switch (kind) {
    case 'balance_sheet':
      return { current: '期末余额', prior: '上期期末余额' };
    case 'equity_change':
      return { current: '本年金额', prior: '上年金额' };
    default:
      return { current: '本期金额', prior: '上期金额' };
  }
}

function checkStatus(check: StatementCheck): string {
  if (check.passed) return '通过';
  return `差异 ${formatYuan(check.diff)} 元`;
}

/**
 * 把一张报表渲染成等宽文本。
 *
 * 之所以自己算列宽而不依赖 `String.prototype.padEnd`：中文字符在等宽字体下占两列，
 * 直接用 JS 的 length 对齐会让表头与数字错位，打印出来没法看。
 */
export function renderStatementText(statement: FinancialStatement): string {
  const lines: string[] = [];
  const title = STATEMENT_KIND_LABEL[statement.kind];
  const hasPrior = statement.lines.some((l) => l.priorAmount !== null && l.priorAmount !== undefined);

  lines.push(title);
  lines.push(
    `会计期间：${statement.period}    会计准则：${ACCOUNTING_STANDARD_LABEL[statement.standard]}    单位：元`,
  );
  const labels = columnLabels(statement.kind);
  lines.push(
    padEndDisplay('行次', 6) +
      padEndDisplay('项目', 42) +
      padStartDisplay(labels.current, 18) +
      (hasPrior ? padStartDisplay(labels.prior, 18) : ''),
  );
  lines.push('-'.repeat(hasPrior ? 84 : 66));

  for (const line of statement.lines) {
    const isHeader = line.level === 0 && line.amount === null && !line.isTotal;
    const indent = ' '.repeat(Math.max(0, line.level) * 2);
    if (isHeader) {
      lines.push(line.label);
      continue;
    }
    const code = line.amount === null && line.level === 0 ? '' : line.code;
    const label = `${indent}${line.label}`;
    // 非合计行金额为 0 时留空：正式报表的惯例，也避免几十行「0.00」淹没真正的数字
    const isZero = line.amount === 0 && line.isTotal !== true;
    const amount = line.amount === null || isZero ? '' : amountText(line.amount);
    let row =
      padEndDisplay(code, 6) +
      padEndDisplay(label, 42) +
      padStartDisplay(amount, 18);
    if (hasPrior) row += padStartDisplay(amountText(line.priorAmount), 18);
    lines.push(row);
  }

  lines.push('-'.repeat(hasPrior ? 84 : 66));
  lines.push('注：非合计行空白表示本期无余额（0.00 元）。');
  lines.push('');
  lines.push('勾稽校验：');
  for (const check of statement.checks) {
    lines.push(`  [${checkStatus(check)}] ${check.label}`);
    if (!check.passed) lines.push(`      ${check.detail}`);
  }
  lines.push(
    `  报表整体勾稽：${statement.passed ? '通过' : '存在差异，须复核后方可使用'}`,
  );

  return lines.join('\n');
}

/* ================================================================== */
/* 二、Markdown 分析报告                                               */
/* ================================================================== */

function mdEscape(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function ratingText(rating: FinancialRatio['rating']): string {
  switch (rating) {
    case 'good':
      return '良好';
    case 'watch':
      return '关注';
    case 'bad':
      return '偏弱';
    default:
      return '数据不足';
  }
}

function alertLevelText(level: AnalysisAlert['level']): string {
  return level === 'error' ? '高风险' : level === 'warning' ? '关注' : '提示';
}

/** 趋势序列键 → 中文名称；配置缺失时退回行键，保证导出不会因为读不到配置而失败。 */
let trendLabels: Map<string, string> | null = null;

function trendLabel(key: string): string {
  if (trendLabels === null) {
    trendLabels = new Map<string, string>();
    try {
      for (const def of loadRatioConfig().trends) trendLabels.set(def.key, def.label);
    } catch {
      // 配置不可用时只显示行键，不影响导出
    }
  }
  const suffix = key.endsWith('_yoy') ? '（同比）' : key.endsWith('_mom') ? '（环比）' : '';
  const base = key.replace(/_(yoy|mom)$/, '');
  return `${trendLabels.get(base) ?? base}${suffix}`;
}

function trendTable(trends: Record<string, TrendPoint[]>, title: string): string[] {
  const entries = Object.entries(trends).filter(([, points]) => points.length > 0);
  if (entries.length === 0) return [];

  const periods = [...new Set(entries.flatMap(([, points]) => points.map((p) => p.period)))].sort();
  const lines: string[] = [];
  lines.push(`### ${title}`, '');
  lines.push(`| 指标 | ${periods.join(' | ')} |`);
  lines.push(`| --- | ${periods.map(() => '---').join(' | ')} |`);
  for (const [key, points] of entries) {
    const byPeriod = new Map(points.map((p) => [p.period, p.value]));
    const cells = periods.map((period) => {
      const value = byPeriod.get(period);
      if (value === undefined) return '—';
      if (typeof value !== 'number') return '—';
      return key.endsWith('_yoy') || key.endsWith('_mom')
        ? `${value.toFixed(2)}%`
        : formatYuanGrouped(Math.round(value));
    });
    lines.push(`| ${mdEscape(trendLabel(key))} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines;
}

/**
 * 渲染完整的 Markdown 分析报告。
 *
 * 顺序刻意做成「结论 → 明细」：老板只看前两屏，会计复核时往下翻。
 */
export function renderAnalysisMarkdown(analysis: FinancialAnalysis): string {
  const lines: string[] = [];

  lines.push(`# ${analysis.period} 财务分析报告（${ACCOUNTING_STANDARD_LABEL[analysis.standard]}）`);
  lines.push('');
  lines.push(`> 生成时间：${analysis.generatedAt}；报告编号：${analysis.id}。`);
  lines.push('> 本报告由系统依据账簿快照自动生成，所有结论均可按下列数字复算；');
  lines.push('> 涉及行业判断、资产减值、或有事项等需人工复核，不构成审计意见或税务申报结论。');
  lines.push('');

  /* -------- 结论段落 -------- */
  lines.push('## 分析结论');
  lines.push('');
  for (const section of analysis.narratives) {
    lines.push(`### ${section.title}`);
    lines.push('');
    lines.push(section.body);
    lines.push('');
    if (section.evidence.length > 0) {
      lines.push('| 关键数字 | 数值 |');
      lines.push('| --- | --- |');
      for (const item of section.evidence) {
        lines.push(`| ${mdEscape(item.label)} | ${mdEscape(item.value)} |`);
      }
      lines.push('');
    }
  }

  /* -------- 指标 -------- */
  lines.push('## 财务指标');
  lines.push('');
  for (const group of groupRatios(analysis.ratios)) {
    if (group.ratios.length === 0) continue;
    lines.push(`### ${group.label}`);
    lines.push('');
    lines.push('| 指标 | 数值 | 评级 | 行业参考区间 | 计算公式 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const ratio of group.ratios) {
      const value = ratio.value === null
        ? '无法计算'
        : ratio.unit === '%'
          ? `${ratio.value.toFixed(2)}%`
          : `${ratio.value.toFixed(4)} ${ratio.unit}`;
      const bench = ratio.benchmark === null || ratio.benchmark === undefined
        ? '—'
        : `${ratio.benchmark[0]}~${ratio.benchmark[1]}`;
      lines.push(
        `| ${mdEscape(ratio.name)} | ${value} | ${ratingText(ratio.rating)} | ${bench} | ${mdEscape(ratio.formula)} |`,
      );
    }
    lines.push('');
  }

  /* -------- 杜邦 -------- */
  const d = analysis.dupont;
  lines.push('## 杜邦分析');
  lines.push('');
  lines.push('ROE = 净利率 × 总资产周转率 × 权益乘数');
  lines.push('');
  lines.push('| 因子 | 数值 | 说明 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 净资产收益率（ROE） | ${d.roe === null ? '—' : `${d.roe.toFixed(2)}%`} | 三因子乘积 |`);
  lines.push(`| 净利率 | ${d.netProfitMargin === null ? '—' : `${d.netProfitMargin.toFixed(2)}%`} | 净利润 ÷ 营业收入 |`);
  lines.push(`| 总资产周转率 | ${d.assetTurnover === null ? '—' : `${d.assetTurnover.toFixed(4)} 次`} | 营业收入 ÷ 平均资产总额 |`);
  lines.push(`| 权益乘数 | ${d.equityMultiplier === null ? '—' : `${d.equityMultiplier.toFixed(4)} 倍`} | 平均资产总额 ÷ 平均所有者权益 |`);
  lines.push('');
  if (d.contributions !== undefined) {
    const c = d.contributions;
    lines.push('与上期相比各因子对 ROE 变动的贡献（百分点）：');
    lines.push('');
    lines.push('| 因子 | 贡献 |');
    lines.push('| --- | --- |');
    lines.push(`| 净利率 | ${(c['netProfitMargin'] ?? 0).toFixed(2)} |`);
    lines.push(`| 总资产周转率 | ${(c['assetTurnover'] ?? 0).toFixed(2)} |`);
    lines.push(`| 权益乘数 | ${(c['equityMultiplier'] ?? 0).toFixed(2)} |`);
    lines.push('');
  }

  /* -------- 趋势 -------- */
  lines.push('## 趋势分析');
  lines.push('');
  const trendLines = trendTable(analysis.trends, '多期趋势（金额单位：元；同比/环比单位：%）');
  if (trendLines.length === 0) {
    lines.push('未提供多期历史快照，本期无法生成趋势。');
    lines.push('');
  } else {
    lines.push(...trendLines);
  }

  /* -------- 结构 -------- */
  lines.push('## 结构分析');
  lines.push('');
  const structureText = describeStructure(analysis.structure);
  lines.push(structureText === '' ? '本期收入、成本、费用均无发生额，结构分析为空。' : structureText);
  lines.push('');
  for (const [title, items] of [
    ['收入构成', analysis.structure.revenueByCategory],
    ['成本构成', analysis.structure.costByCategory],
    ['费用构成', analysis.structure.expenseByCategory],
  ] as const) {
    if (items.length === 0) continue;
    lines.push(`### ${title}`);
    lines.push('');
    lines.push('| 项目 | 金额（元） | 占比 |');
    lines.push('| --- | --- | --- |');
    for (const item of items) {
      lines.push(
        `| ${mdEscape(item.label)} | ${formatYuanGrouped(item.amount)} | ${(item.share * 100).toFixed(2)}% |`,
      );
    }
    lines.push('');
  }

  /* -------- 预警 -------- */
  lines.push('## 风险预警');
  lines.push('');
  if (analysis.alerts.length === 0) {
    lines.push('本期未触发预设的风险预警阈值。阈值判定只覆盖报告列示的指标，不代表不存在其他风险。');
  } else {
    lines.push('| 级别 | 预警 | 说明 | 建议动作 |');
    lines.push('| --- | --- | --- | --- |');
    for (const alert of analysis.alerts) {
      lines.push(
        `| ${alertLevelText(alert.level)} | ${mdEscape(alert.title)} | ${mdEscape(alert.detail)} | ${mdEscape(alert.action)} |`,
      );
    }
  }
  lines.push('');

  /* -------- 数据说明 -------- */
  lines.push('## 数据说明');
  lines.push('');
  if (analysis.dataNotes.length === 0) {
    lines.push('本期数据完整，无需特别说明。');
  } else {
    for (const note of analysis.dataNotes) lines.push(`- ${note}`);
  }
  lines.push('');

  return lines.join('\n');
}

/* ================================================================== */
/* 三、Excel 导出                                                      */
/* ================================================================== */

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

function styleHeaderRow(sheet: ExcelJS.Worksheet, columns: readonly number[]): void {
  const row = sheet.getRow(1);
  row.height = 22;
  for (const col of columns) {
    const cell = row.getCell(col);
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = THIN_BORDER;
  }
}

function addStatementSheet(wb: ExcelJS.Workbook, statement: FinancialStatement): void {
  const sheet = wb.addWorksheet(STATEMENT_KIND_LABEL[statement.kind]);
  const hasPrior = statement.lines.some((l) => l.priorAmount !== null && l.priorAmount !== undefined);
  const columnCount = hasPrior ? 4 : 3;
  sheet.columns = [
    { width: 8 },
    { width: 46 },
    { width: 18 },
    ...(hasPrior ? [{ width: 18 }] : []),
  ];

  const titleRow = sheet.addRow([STATEMENT_KIND_LABEL[statement.kind]]);
  titleRow.font = { ...BODY_FONT, bold: true, size: 14 };
  sheet.mergeCells(titleRow.number, 1, titleRow.number, columnCount);
  titleRow.alignment = { horizontal: 'center' };

  const metaRow = sheet.addRow([
    `会计期间：${statement.period}`,
    `会计准则：${ACCOUNTING_STANDARD_LABEL[statement.standard]}`,
    '单位：元',
  ]);
  metaRow.font = { ...BODY_FONT, color: { argb: 'FF808080' } };
  sheet.mergeCells(metaRow.number, 1, metaRow.number, columnCount);

  const labels = columnLabels(statement.kind);
  const headerRow = sheet.addRow(
    hasPrior ? ['行次', '项目', labels.current, labels.prior] : ['行次', '项目', labels.current],
  );
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = THIN_BORDER;
  });

  for (const line of statement.lines) {
    const isHeader = line.level === 0 && line.amount === null && !line.isTotal;
    if (isHeader) {
      const row = sheet.addRow(['', line.label]);
      row.font = { ...BODY_FONT, bold: true };
      sheet.mergeCells(row.number, 2, row.number, columnCount);
      continue;
    }
    const indent = '    '.repeat(Math.max(0, line.level - 1));
    const values: Array<string | number | null> = [
      line.amount === null && line.level === 0 ? '' : line.code,
      `${indent}${line.label}`,
      line.amount === null ? null : Number(formatYuan(line.amount)),
    ];
    if (hasPrior) {
      values.push(line.priorAmount === null || line.priorAmount === undefined ? null : Number(formatYuan(line.priorAmount)));
    }
    const row = sheet.addRow(values);
    row.font = line.isTotal ? { ...BODY_FONT, bold: true } : BODY_FONT;
    for (let c = 1; c <= columnCount; c += 1) {
      const cell = row.getCell(c);
      cell.border = THIN_BORDER;
      if (c >= 3) {
        cell.numFmt = MONEY_FORMAT;
        cell.alignment = { horizontal: 'right' };
      }
    }
    if (line.formula !== undefined && line.formula !== '') {
      const cell = row.getCell(2);
      cell.note = line.formula;
    }
  }

  sheet.addRow([]);
  const checkTitle = sheet.addRow(['勾稽校验']);
  checkTitle.font = { ...BODY_FONT, bold: true };
  for (const check of statement.checks) {
    const row = sheet.addRow(['', check.label, check.passed ? '通过' : `差异 ${formatYuan(check.diff)} 元`]);
    row.font = check.passed ? BODY_FONT : { ...BODY_FONT, color: { argb: 'FF9C0006' } };
    if (!check.passed) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
      const detail = sheet.addRow(['', `　${check.detail}`]);
      detail.font = { ...BODY_FONT, italic: true, color: { argb: 'FF9C0006' } };
    }
  }

  sheet.views = [{ state: 'frozen', ySplit: 3 }];
}

function addRatioSheet(wb: ExcelJS.Workbook, analysis: FinancialAnalysis): void {
  const sheet = wb.addWorksheet('财务指标');
  sheet.columns = [
    { header: '分组', width: 12 },
    { header: '指标', width: 22 },
    { header: '数值', width: 14 },
    { header: '单位', width: 8 },
    { header: '评级', width: 10 },
    { header: '行业参考下限', width: 14 },
    { header: '行业参考上限', width: 14 },
    { header: '计算公式', width: 46 },
    { header: '解读', width: 70 },
  ];
  styleHeaderRow(sheet, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  for (const group of groupRatios(analysis.ratios)) {
    for (const ratio of group.ratios) {
      const row = sheet.addRow([
        group.label,
        ratio.name,
        ratio.value,
        ratio.unit,
        ratingText(ratio.rating),
        ratio.benchmark === null || ratio.benchmark === undefined ? null : ratio.benchmark[0],
        ratio.benchmark === null || ratio.benchmark === undefined ? null : ratio.benchmark[1],
        ratio.formula,
        ratio.comment,
      ]);
      row.font = BODY_FONT;
      row.eachCell((cell) => {
        cell.border = THIN_BORDER;
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
      if (ratio.rating === 'bad') {
        row.getCell(5).font = { ...BODY_FONT, bold: true, color: { argb: 'FF9C0006' } };
      } else if (ratio.rating === 'good') {
        row.getCell(5).font = { ...BODY_FONT, bold: true, color: { argb: 'FF006100' } };
      }
    }
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function addDupontSheet(wb: ExcelJS.Workbook, analysis: FinancialAnalysis): void {
  const sheet = wb.addWorksheet('杜邦分析');
  sheet.columns = [
    { header: '项目', width: 28 },
    { header: '数值', width: 18 },
    { header: '计算口径', width: 46 },
  ];
  styleHeaderRow(sheet, [1, 2, 3]);

  const d = analysis.dupont;
  const rows: Array<[string, number | null, string]> = [
    ['净资产收益率（ROE）', d.roe, '净利率 × 总资产周转率 × 权益乘数'],
    ['净利率（%）', d.netProfitMargin, '净利润 ÷ 营业收入 × 100'],
    ['总资产周转率（次）', d.assetTurnover, '营业收入 ÷ 平均资产总额'],
    ['权益乘数（倍）', d.equityMultiplier, '平均资产总额 ÷ 平均所有者权益'],
  ];
  for (const [label, value, note] of rows) {
    const row = sheet.addRow([label, value, note]);
    row.font = BODY_FONT;
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
    });
    row.getCell(2).numFmt = '0.0000';
  }

  if (d.contributions !== undefined) {
    sheet.addRow([]);
    const titleRow = sheet.addRow(['与上期相比的贡献（百分点）']);
    titleRow.font = { ...BODY_FONT, bold: true };
    const c = d.contributions;
    for (const [label, value] of [
      ['净利率贡献', c['netProfitMargin'] ?? 0],
      ['总资产周转率贡献', c['assetTurnover'] ?? 0],
      ['权益乘数贡献', c['equityMultiplier'] ?? 0],
    ] as const) {
      const row = sheet.addRow([label, value]);
      row.font = BODY_FONT;
      row.getCell(2).numFmt = '0.0000';
    }
  }
}

function addTrendSheet(wb: ExcelJS.Workbook, analysis: FinancialAnalysis): void {
  const sheet = wb.addWorksheet('趋势分析');
  const entries = Object.entries(analysis.trends).filter(([, points]) => points.length > 0);
  const periods = [...new Set(entries.flatMap(([, points]) => points.map((p) => p.period)))].sort();

  sheet.columns = [
    { header: '指标', width: 30 },
    ...periods.map((period) => ({ header: period, width: 16 })),
  ];
  styleHeaderRow(sheet, [1, ...periods.map((_, i) => i + 2)]);

  for (const [key, points] of entries) {
    const byPeriod = new Map(points.map((p) => [p.period, p.value]));
    const values: Array<string | number | null> = [trendLabel(key)];
    for (const period of periods) {
      const value = byPeriod.get(period);
      values.push(typeof value === 'number' ? value : null);
    }
    const row = sheet.addRow(values);
    row.font = BODY_FONT;
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
    });
    if (!key.endsWith('_yoy') && !key.endsWith('_mom')) {
      for (let i = 2; i <= periods.length + 1; i += 1) {
        row.getCell(i).numFmt = MONEY_FORMAT;
      }
    }
  }

  sheet.addRow([]);
  const note = sheet.addRow([
    '说明：金额类指标单位为元；以 _yoy 结尾为同比（%），以 _mom 结尾为环比（%）。',
  ]);
  note.font = { ...BODY_FONT, italic: true, color: { argb: 'FF808080' } };
}

function addStructureSheet(wb: ExcelJS.Workbook, analysis: FinancialAnalysis): void {
  const sheet = wb.addWorksheet('结构分析');
  sheet.columns = [
    { header: '类别', width: 12 },
    { header: '项目', width: 28 },
    { header: '金额（元）', width: 18 },
    { header: '占比', width: 12 },
  ];
  styleHeaderRow(sheet, [1, 2, 3, 4]);

  const blocks: Array<[string, FinancialAnalysis['structure']['revenueByCategory']]> = [
    ['收入', analysis.structure.revenueByCategory],
    ['成本', analysis.structure.costByCategory],
    ['费用', analysis.structure.expenseByCategory],
  ];
  for (const [label, items] of blocks) {
    for (const item of items) {
      const row = sheet.addRow([label, item.label, Number(formatYuan(item.amount)), item.share]);
      row.font = BODY_FONT;
      row.eachCell((cell) => {
        cell.border = THIN_BORDER;
      });
      row.getCell(3).numFmt = MONEY_FORMAT;
      row.getCell(4).numFmt = '0.00%';
    }
  }
}

function addAlertSheet(wb: ExcelJS.Workbook, analysis: FinancialAnalysis): void {
  const sheet = wb.addWorksheet('风险预警');
  sheet.columns = [
    { header: '级别', width: 10 },
    { header: '预警', width: 34 },
    { header: '说明', width: 60 },
    { header: '建议动作', width: 60 },
  ];
  styleHeaderRow(sheet, [1, 2, 3, 4]);

  for (const alert of analysis.alerts) {
    const row = sheet.addRow([alertLevelText(alert.level), alert.title, alert.detail, alert.action]);
    row.font = BODY_FONT;
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    if (alert.level === 'error') {
      row.getCell(1).font = { ...BODY_FONT, bold: true, color: { argb: 'FF9C0006' } };
    }
  }

  if (analysis.alerts.length === 0) {
    sheet.addRow(['', '本期未触发预设预警阈值', '', '']).font = BODY_FONT;
  }
}

function addNarrativeSheet(wb: ExcelJS.Workbook, analysis: FinancialAnalysis): void {
  const sheet = wb.addWorksheet('分析结论');
  sheet.columns = [
    { header: '段落', width: 24 },
    { header: '正文', width: 100 },
    { header: '关键数字', width: 50 },
  ];
  styleHeaderRow(sheet, [1, 2, 3]);

  for (const section of analysis.narratives) {
    const evidence = section.evidence.map((e) => `${e.label}：${e.value}`).join('；');
    const row = sheet.addRow([section.title, section.body, evidence]);
    row.font = BODY_FONT;
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'top', wrapText: true };
    });
    row.height = 90;
  }

  if (analysis.dataNotes.length > 0) {
    sheet.addRow([]);
    const noteTitle = sheet.addRow(['数据说明', analysis.dataNotes.join('\n'), '']);
    noteTitle.font = { ...BODY_FONT, italic: true };
    noteTitle.getCell(2).alignment = { vertical: 'top', wrapText: true };
  }
}

function addCheckSheet(wb: ExcelJS.Workbook, statements: readonly FinancialStatement[]): void {
  const sheet = wb.addWorksheet('勾稽校验');
  sheet.columns = [
    { header: '报表', width: 20 },
    { header: '检查项', width: 46 },
    { header: '结果', width: 10 },
    { header: '差额（元）', width: 16 },
    { header: '说明', width: 70 },
  ];
  styleHeaderRow(sheet, [1, 2, 3, 4, 5]);

  for (const statement of statements) {
    for (const check of statement.checks) {
      const row = sheet.addRow([
        STATEMENT_KIND_LABEL[statement.kind],
        check.label,
        check.passed ? '通过' : '差异',
        Number(formatYuan(check.diff)),
        check.detail,
      ]);
      row.font = check.passed ? BODY_FONT : { ...BODY_FONT, color: { argb: 'FF9C0006' } };
      row.eachCell((cell) => {
        cell.border = THIN_BORDER;
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
      row.getCell(4).numFmt = MONEY_FORMAT;
    }
  }
}

/**
 * 导出报表与分析到 Excel。
 *
 * 工作簿结构：每张报表一个 sheet + 财务指标 / 杜邦分析 / 趋势分析 / 结构分析 /
 * 风险预警 / 分析结论 / 勾稽校验。所有金额写数值（元），不做字符串拼接。
 */
export async function exportStatementsExcel(
  statements: readonly FinancialStatement[],
  analysis: FinancialAnalysis,
  outPath: string,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '账有律 · 会计自动化系统';
  wb.created = new Date();

  for (const statement of statements) {
    addStatementSheet(wb, statement);
  }
  addRatioSheet(wb, analysis);
  addDupontSheet(wb, analysis);
  addTrendSheet(wb, analysis);
  addStructureSheet(wb, analysis);
  addAlertSheet(wb, analysis);
  addNarrativeSheet(wb, analysis);
  addCheckSheet(wb, statements);

  await mkdir(dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);
}

/** 把若干张报表拼成一份纯文本，便于写入日志或控制台。 */
export function renderStatementsText(statements: readonly FinancialStatement[]): string {
  return statements.map((s) => renderStatementText(s)).join('\n\n' + '='.repeat(84) + '\n\n');
}
