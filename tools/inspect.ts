/**
 * 输出文件检查工具（开发调试用）。
 *
 *   node tools/inspect.ts out/演示凭证.xlsx [工作表名] [最大行数]
 *
 * 直接把导出的 Excel 打印成对齐的文本表，便于肉眼核对分录。
 */

import ExcelJS from 'exceljs';

async function main(): Promise<void> {
  const file = process.argv[2] ?? 'out/演示凭证.xlsx';
  const sheetFilter = process.argv[3];
  const maxRows = Number(process.argv[4] ?? 60);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  console.log(`文件：${file}`);
  console.log(`工作表：${wb.worksheets.map((w) => w.name).join(' | ')}`);
  console.log();

  wb.eachSheet((sheet) => {
    if (sheetFilter !== undefined && sheet.name !== sheetFilter) return;

    console.log('═'.repeat(120));
    console.log(`【${sheet.name}】${sheet.rowCount} 行 × ${sheet.columnCount} 列`);
    console.log('═'.repeat(120));

    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        if (v === null || v === undefined) cells.push('');
        else if (typeof v === 'object' && v !== null && 'result' in v) cells.push(String((v as { result: unknown }).result ?? ''));
        else if (v instanceof Date) cells.push(v.toISOString().slice(0, 10));
        else cells.push(String(v));
      });
      rows.push(cells);
    });

    if (rows.length === 0) {
      console.log('（空表）');
      return;
    }

    const width = (rows[0] ?? []).length;
    const widths = new Array<number>(width).fill(0);
    for (const row of rows) {
      for (let i = 0; i < width; i += 1) {
        const len = visualWidth(row[i] ?? '');
        if (len > (widths[i] ?? 0)) widths[i] = len;
      }
    }

    const shown = rows.slice(0, maxRows);
    for (const [index, row] of shown.entries()) {
      const line = row
        .slice(0, width)
        .map((cell, i) => pad(cell, widths[i] ?? 0))
        .join(' │ ');
      console.log(line.trimEnd());
      if (index === 0) {
        console.log(widths.map((w) => '─'.repeat(w)).join('─┼─'));
      }
    }
    if (rows.length > maxRows) {
      console.log(`… 另有 ${rows.length - maxRows} 行未显示`);
    }
    console.log();
  });
}

/** 中文按 2 个字符宽度计算，保证终端列对齐。 */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 0x2e80 && code < 0xffef ? 2 : 1;
  }
  return w;
}

function pad(s: string, width: number): string {
  const diff = width - visualWidth(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
