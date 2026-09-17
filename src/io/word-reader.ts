/**
 * Word 文档读取。
 *
 * 合同类的 Word 文档有两处关键信息：
 *  1. 正文段落里的要素（合同编号、金额、日期、双方、结算方式）
 *  2. 表格里的明细（价款、税率、付款节点）
 * 因此这里同时输出纯文本与表格结构。
 *
 * 依赖 mammoth：只支持 .docx。老式 .doc 需先另存为 .docx。
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import mammoth from 'mammoth';

import type { RawText } from '../core/types.ts';
import { ReadError } from './errors.ts';

export { ReadError };

export interface WordTable {
  /** 第几张表（1 基） */
  index: number;
  rows: string[][];
}

export interface WordDocument {
  /** 纯文本正文，段落之间用换行分隔 */
  text: string;
  /** 段落列表 */
  paragraphs: string[];
  /** 文档中的表格 */
  tables: WordTable[];
  paragraphCount: number;
}

/** HTML 实体还原。mammoth 输出里常见 &amp; &lt; &gt; &quot; &nbsp; */
function decodeEntities(html: string): string {
  return html
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      // 单元格/段落/换行边界转成空格或换行，避免文字粘连
      .replace(/<\/t[dh]>/gi, ' ')
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u00A0]+/g, ' ')
    .trim();
}

/** 从 mammoth 的 HTML 输出中抽取表格。 */
export function extractTablesFromHtml(html: string): WordTable[] {
  const tables: WordTable[] = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tableMatch: RegExpExecArray | null;
  let tableIndex = 0;

  while ((tableMatch = tableRe.exec(html)) !== null) {
    tableIndex += 1;
    const tableHtml = tableMatch[0];
    const rows: string[][] = [];
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[0];
      const cells: string[] = [];
      const cellRe = /<t[dh][\s\S]*?<\/t[dh]>/gi;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
        cells.push(stripTags(cellMatch[0]));
      }
      // 合并单元格会产生空串，保留结构以便后续按列对齐
      if (cells.length > 0) rows.push(cells);
    }

    if (rows.length > 0) tables.push({ index: tableIndex, rows });
  }

  return tables;
}

/** HTML → 纯文本（保留段落换行）。 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t\u00A0]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * 读取 .docx 文档。
 * 返回正文文本、段落与表格，供合同要素抽取使用。
 */
export async function readWord(filePath: string): Promise<WordDocument> {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.doc') {
    throw new ReadError(
      `不支持老式 .doc 格式: ${filePath}\n请在 Word 中另存为 .docx 后再处理。`,
    );
  }
  if (ext !== '.docx' && ext !== '.docm') {
    throw new ReadError(`不是 Word 文档: ${filePath}（扩展名 ${ext}）`);
  }

  const buffer = await readFile(filePath);

  let html: string;
  try {
    const result = await mammoth.convertToHtml({ buffer });
    html = result.value;
  } catch (err) {
    throw new ReadError(`读取 Word 失败 ${filePath}: ${(err as Error).message}`);
  }

  const text = htmlToText(html);
  const paragraphs = text.split('\n').filter((p) => p.trim() !== '');
  const tables = extractTablesFromHtml(html);

  return {
    text,
    paragraphs,
    tables,
    paragraphCount: paragraphs.length,
  };
}

/** 兼容统一接口：仅需要纯文本时使用。 */
export async function readWordText(filePath: string): Promise<RawText> {
  const doc = await readWord(filePath);
  return { text: doc.text, paragraphCount: doc.paragraphCount };
}
