/**
 * Excel / CSV 读取。
 *
 * 处理真实世界里银行和财务系统导出的脏数据：
 *  - 标题行、空行、合并单元格
 *  - 公式单元格、富文本单元格
 *  - CSV 的 GBK / UTF-8 BOM 编码差异
 *  - 「借方发生额/贷方发生额」与「金额+方向」两种记法
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import ExcelJS from 'exceljs';

import type { CellValue, RawRow, RawSheet } from '../core/types.ts';
import { isBlank, normalizeText } from '../core/text.ts';
import { ReadError } from './errors.ts';

export { ReadError };

/* ------------------------------------------------------------------ */
/* 单元格值归一化                                                      */
/* ------------------------------------------------------------------ */

/** 把 ExcelJS 的各种单元格值形态压平成基础类型。 */
function normalizeCellValue(value: ExcelJS.CellValue): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value;

  if (typeof value === 'object') {
    // 公式单元格：取计算结果
    if ('result' in value) {
      const result = (value as ExcelJS.CellFormulaValue).result;
      if (result === undefined || result === null) return null;
      if (result instanceof Date) return result;
      if (typeof result === 'object') {
        // 公式结果是错误值，如 #REF!
        if ('error' in result) return String((result as { error: string }).error);
        return null;
      }
      return result as CellValue;
    }
    // 富文本单元格：拼接各段文本
    if ('richText' in value) {
      const parts = (value as ExcelJS.CellRichTextValue).richText;
      return parts.map((p) => p.text).join('');
    }
    // 超链接单元格
    if ('text' in value) {
      return String((value as ExcelJS.CellHyperlinkValue).text ?? '');
    }
    if ('error' in value) {
      return String((value as ExcelJS.CellErrorValue).error);
    }
  }

  return String(value);
}

/* ------------------------------------------------------------------ */
/* 表头行探测                                                          */
/* ------------------------------------------------------------------ */

export interface HeaderDetection {
  rowIndex: number;
  headers: string[];
  /** 置信度 0~1 */
  score: number;
}

/**
 * 在数据区前若干行中寻找最像表头的一行。
 *
 * 评分依据：
 *  - 非空文本单元格数量（表头都是文本）
 *  - 该行应该几乎不含数字与日期
 *  - 紧随其后的行应该有数据
 */
export function detectHeaderRow(
  rows: readonly RawRow[],
  searchLimit = 15,
): HeaderDetection | null {
  let best: HeaderDetection | null = null;
  const limit = Math.min(rows.length, searchLimit);

  for (let i = 0; i < limit; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;

    let textCells = 0;
    let numericCells = 0;
    let nonEmpty = 0;
    const seen = new Set<string>();

    for (const cell of row.cells) {
      if (isBlank(cell)) continue;
      nonEmpty += 1;
      if (typeof cell === 'number' || cell instanceof Date) {
        numericCells += 1;
      } else {
        const text = normalizeText(cell);
        if (text !== '') {
          textCells += 1;
          seen.add(text);
        }
      }
    }

    if (nonEmpty < 2) continue;
    if (textCells < 2) continue;

    // 表头不应有太多重复（重复说明是数据行里的分类列）
    const uniqueness = seen.size / Math.max(1, textCells);

    // 数据密度：表头下面应该跟着数据
    let dataRowsBelow = 0;
    for (let j = i + 1; j < Math.min(rows.length, i + 6); j += 1) {
      const below = rows[j];
      if (below === undefined) continue;
      const filled = below.cells.filter((c) => !isBlank(c)).length;
      if (filled >= Math.max(2, Math.floor(row.cells.length * 0.3))) dataRowsBelow += 1;
    }

    // 标题行（如「XX银行交易明细」）通常只有 1 个单元格
    const spanRatio = nonEmpty / Math.max(1, row.cells.length);

    let score =
      0.35 * Math.min(1, textCells / 6) +
      0.2 * (1 - Math.min(1, numericCells / Math.max(1, nonEmpty))) +
      0.2 * uniqueness +
      0.15 * Math.min(1, dataRowsBelow / 3) +
      0.1 * Math.min(1, spanRatio * 1.5);

    // 越靠前的行略微加分，避免把数据行里的表头误判到后面
    score -= i * 0.005;

    if (best === null || score > best.score) {
      const headers = row.cells.map((c) => (isBlank(c) ? '' : normalizeText(c)));
      // 去掉尾部空列
      while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop();
      if (headers.length >= 2) {
        best = { rowIndex: i, headers, score };
      }
    }
  }

  return best;
}

/** 表头为空列生成占位名（列A、列B…），保证后续按名取值不丢列。 */
export function fillBlankHeaders(headers: readonly string[]): string[] {
  const result: string[] = [];
  const used = new Set<string>();
  for (const [index, raw] of headers.entries()) {
    let name = raw.trim();
    if (name === '') name = `列${columnLetter(index)}`;
    // 同名表头加后缀，避免互相覆盖
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name}_${n}`)) n += 1;
      name = `${name}_${n}`;
    }
    used.add(name);
    result.push(name);
  }
  return result;
}

function columnLetter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/* ------------------------------------------------------------------ */
/* 工作表 → RawSheet                                                   */
/* ------------------------------------------------------------------ */

function sheetToRows(worksheet: ExcelJS.Worksheet, maxRows: number): RawRow[] {
  const rows: RawRow[] = [];
  let maxColumns = 0;

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: CellValue[] = [];
    const columnCount = worksheet.columnCount;
    for (let c = 1; c <= columnCount; c += 1) {
      cells.push(normalizeCellValue(row.getCell(c).value));
    }
    if (cells.length > maxColumns) maxColumns = cells.length;
    rows.push({ rowNumber: row.number, cells });
    if (rows.length >= maxRows) return;
  });

  // 补齐所有行的列数，避免下标越界
  for (const row of rows) {
    while (row.cells.length < maxColumns) row.cells.push(null);
  }

  return rows;
}

/**
 * 用合并单元格的主单元格值填充被合并掉的空单元格。
 * 银行流水的「账号」「户名」经常是纵向合并的，不填充会导致大量空值。
 */
function fillMergedValues(worksheet: ExcelJS.Worksheet, rows: RawRow[], headerRowIndex: number): void {
  const headerRow = rows[headerRowIndex];
  if (headerRow === undefined) return;

  // 只填充表头之后的列，且只在被合并的区域内
  for (const row of rows.slice(headerRowIndex)) {
    for (let c = 0; c < row.cells.length; c += 1) {
      if (!isBlank(row.cells[c])) continue;
      const cell = worksheet.getCell(row.rowNumber, c + 1);
      if (!cell.isMerged) continue;
      const master = cell.master;
      if (master === undefined || master === cell) continue;
      const masterValue = normalizeCellValue(master.value);
      if (!isBlank(masterValue)) {
        row.cells[c] = masterValue;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 解码 CSV 缓冲区。
 * 中文银行导出的 CSV 常见 GBK 编码，UTF-8 解码失败时回退 GBK。
 */
export function decodeTextBuffer(buffer: Buffer): string {
  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  // UTF-16 LE BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }

  const utf8 = buffer.toString('utf8');
  // UTF-8 解码后出现替换字符，基本可以断定不是 UTF-8
  if (!utf8.includes('\uFFFD')) return utf8;

  for (const encoding of ['gbk', 'gb18030', 'big5'] as const) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: false }).decode(buffer);
      if (!decoded.includes('\uFFFD')) return decoded;
    } catch {
      // 该编码在当前 Node 构建中不可用，继续尝试下一个
    }
  }
  return utf8;
}

/** 极简 CSV 解析：支持引号包裹、字段内逗号与换行、双引号转义。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) pushRow();

  // 去掉完全空白的行
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** 自动嗅探分隔符（逗号 / 制表符 / 分号）。 */
export function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  const counts: Array<[string, number]> = [
    [',', (sample.match(/,/g) ?? []).length],
    ['\t', (sample.match(/\t/g) ?? []).length],
    [';', (sample.match(/;/g) ?? []).length],
    ['|', (sample.match(/\|/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const top = counts[0];
  return top !== undefined && top[1] > 0 ? top[0] : ',';
}

/** 字符串矩阵 → RawRow[]，数字型文本转成 number 便于后续金额解析。 */
function matrixToRows(matrix: readonly (readonly string[])[]): RawRow[] {
  return matrix.map((cells, index) => ({
    rowNumber: index + 1,
    cells: cells.map((c) => {
      const trimmed = c.trim();
      if (trimmed === '') return null;
      // 纯数字（含千分位、负数、小数）转成 number；保留长数字串为字符串
      if (/^-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(trimmed) && trimmed.replace(/[^\d]/g, '').length <= 15) {
        const n = Number(trimmed.replace(/,/g, ''));
        if (Number.isFinite(n)) return n;
      }
      return trimmed;
    }),
  }));
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export interface ReadWorkbookOptions {
  /** 每个工作表最多读取的行数，防止内存爆掉 */
  maxRows?: number;
  /** 只读取指定名称的工作表 */
  sheets?: string[];
  /** 跳过完全为空的工作表 */
  skipEmptySheets?: boolean;
}

/**
 * 读取 Excel(.xlsx) 或 CSV 文件，返回规整后的工作表列表。
 *
 * 注意：老式 .xls 二进制格式 ExcelJS 不支持，需先另存为 .xlsx，
 * 或用 tools/convert-xls.ps1 通过本机 Excel 批量转换。
 */
export async function readWorkbook(
  filePath: string,
  options: ReadWorkbookOptions = {},
): Promise<RawSheet[]> {
  const maxRows = options.maxRows ?? 20_000;
  const ext = extname(filePath).toLowerCase();

  if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
    return [await readCsvSheet(filePath, maxRows)];
  }

  if (ext === '.xls') {
    throw new ReadError(
      `不支持老式 .xls 格式: ${filePath}\n` +
        '请在 Excel 中另存为 .xlsx，或运行以下命令批量转换（需本机安装 Excel）：\n' +
        '  powershell -ExecutionPolicy Bypass -File tools/convert-xls.ps1 -Path <文件或目录>',
    );
  }

  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
  } catch (err) {
    throw new ReadError(`读取 Excel 失败 ${filePath}: ${(err as Error).message}`);
  }

  const sheets: RawSheet[] = [];

  workbook.eachSheet((worksheet) => {
    if (options.sheets !== undefined && !options.sheets.includes(worksheet.name)) return;

    const rows = sheetToRows(worksheet, maxRows);
    if (rows.length === 0) {
      if (options.skipEmptySheets === false) {
        sheets.push({ sheetName: worksheet.name, headerRowIndex: 0, headers: [], rows: [] });
      }
      return;
    }

    const detection = detectHeaderRow(rows);
    const headerRowIndex = detection?.rowIndex ?? 0;
    const headers = fillBlankHeaders(detection?.headers ?? []);

    fillMergedValues(worksheet, rows, headerRowIndex);

    const dataRows = rows.slice(headerRowIndex + 1).filter((r) => r.cells.some((c) => !isBlank(c)));

    sheets.push({
      sheetName: worksheet.name,
      headerRowIndex,
      headers,
      rows: dataRows,
    });
  });

  return sheets;
}

async function readCsvSheet(filePath: string, maxRows: number): Promise<RawSheet> {
  const buffer = await readFile(filePath);
  const text = decodeTextBuffer(buffer);
  const delimiter = sniffDelimiter(text);

  let matrix: string[][];
  if (delimiter === ',') {
    matrix = parseCsv(text);
  } else {
    matrix = text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => splitByDelimiter(line, delimiter));
  }

  matrix = matrix.slice(0, maxRows);
  const rows = matrixToRows(matrix);
  const detection = detectHeaderRow(rows);
  const headerRowIndex = detection?.rowIndex ?? 0;
  const headers = fillBlankHeaders(detection?.headers ?? []);

  return {
    sheetName: 'CSV',
    headerRowIndex,
    headers,
    rows: rows.slice(headerRowIndex + 1),
  };
}

function splitByDelimiter(line: string, delimiter: string): string[] {
  if (delimiter === '\t') return line.split('\t');
  const result: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        field += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      result.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  result.push(field);
  return result;
}
