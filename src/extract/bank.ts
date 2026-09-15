/**
 * 银行流水 / 对账单 提取器。
 *
 * 银行文件的三种典型记法都要支持：
 *  A. 借贷两列：借方发生额 / 贷方发生额
 *  B. 金额 + 方向列：交易金额 + 借贷标志
 *  C. 单列带符号金额：金额为负表示支出
 *
 * 额外做两件事：
 *  - 用「余额」列做勾稽校验（上一行余额 ± 本行金额 = 本行余额）
 *  - 识别内部划转、利息、手续费等无需往来的特殊流水
 */

import type { Cents, Direction, DocumentRecord, RawSheet } from '../core/types.ts';
import { formatYuan } from '../core/money.ts';
import { parseDate } from '../core/datetime.ts';
import { isBlank, normalizeText } from '../core/text.ts';
import { mapColumns, pickBestSheet, textOf, valueOf, type ColumnMapping } from '../io/table-detect.ts';
import { BANK_COLUMNS } from './schemas.ts';
import {
  amountOf,
  buildDocument,
  isSummaryRow,
  makeDocId,
  makeSummary,
  parseDirectionFlag,
} from './common.ts';

export interface BankExtraction {
  documents: DocumentRecord[];
  warnings: string[];
  /** 使用的表头映射，用于诊断 */
  mapping: ColumnMapping | null;
  sheetName: string | null;
}

/** 单行解析出的金额与方向。 */
interface AmountDirection {
  amount: Cents | null;
  direction: Direction;
  warnings: string[];
}

function resolveAmountAndDirection(
  row: Parameters<typeof valueOf>[0],
  mapping: ColumnMapping,
): AmountDirection {
  const warnings: string[] = [];

  const debit = amountOf(valueOf(row, mapping, 'debit'));
  const credit = amountOf(valueOf(row, mapping, 'credit'));

  // 记法 A：借贷分列
  if (debit !== null || credit !== null) {
    if (debit !== null && credit !== null) {
      warnings.push(`借贷两列同时有金额(${formatYuan(debit)}/${formatYuan(credit)})，已按借方处理`);
      return { amount: Math.abs(debit), direction: 'out', warnings };
    }
    if (debit !== null) return { amount: Math.abs(debit), direction: 'out', warnings };
    return { amount: Math.abs(credit as Cents), direction: 'in', warnings };
  }

  // 记法 B / C：单列金额
  const rawAmount = valueOf(row, mapping, 'amount');
  const amount = amountOf(rawAmount);
  if (amount === null) return { amount: null, direction: 'none', warnings };

  const flag = parseDirectionFlag(valueOf(row, mapping, 'directionFlag'));
  if (flag !== null) {
    return { amount: Math.abs(amount), direction: flag, warnings };
  }

  // 没有方向列：按符号判断
  if (amount < 0) {
    return { amount: Math.abs(amount), direction: 'out', warnings };
  }

  // 全为正数又没有方向列 —— 无法判断收付，需要人工确认
  warnings.push('未能判断资金方向（无借贷分列、无方向标志、金额为正），暂按「收入」处理，请人工复核');
  return { amount, direction: 'in', warnings };
}

/** 从摘要里判断是否属于常见的「非往来」业务，供规则匹配使用。 */
function classifySummary(summary: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const s = summary;

  if (/手续费|服务费|工本费|账户管理费|年费|电子汇划费|结算费|跨行费/.test(s)) {
    fields['category'] = '手续费';
  } else if (/利息|结息/.test(s)) {
    fields['category'] = '利息';
  } else if (/工资|薪|代发/.test(s)) {
    fields['category'] = '工资';
  } else if (/税|税款|扣缴/.test(s)) {
    fields['category'] = '税款';
  } else if (/社保|医保|养老|失业|工伤|生育/.test(s)) {
    fields['category'] = '社保';
  } else if (/公积金/.test(s)) {
    fields['category'] = '公积金';
  } else if (/差旅|报销/.test(s)) {
    fields['category'] = '报销';
  } else if (/货款|采购|材料|设备/.test(s)) {
    fields['category'] = '采购';
  } else if (/租金|房租|物业/.test(s)) {
    fields['category'] = '租金';
  } else if (/电费|水费|燃气|通讯|话费/.test(s)) {
    fields['category'] = '公用事业';
  } else if (/转账|划转|转存|理财|定期|通知存款/.test(s)) {
    fields['category'] = '内部划转';
  } else if (/退款|退回|退货/.test(s)) {
    fields['category'] = '退款';
  }

  return fields;
}

/** 识别内部划转：本方账号之间、理财申购赎回等，不产生损益。 */
function detectInternalTransfer(
  summary: string,
  counterparty: string,
  ownNames: readonly string[],
): boolean {
  const s = `${summary} ${counterparty}`;
  if (/理财|定期|通知存款|结构性存款|大额存单|国债逆回购|基金申购|基金赎回/.test(s)) return true;
  if (/内部划转|自有资金划转|账户互转|归集|上存|下拨/.test(s)) return true;
  const cp = normalizeText(counterparty);
  if (cp !== '' && ownNames.some((n) => n !== '' && (cp.includes(n) || n.includes(cp)))) return true;
  return false;
}

/**
 * 从一张已映射好的工作表中抽取流水。
 */
export function extractBankFromSheet(
  sheet: RawSheet,
  mapping: ColumnMapping,
  filePath: string,
): BankExtraction {
  const documents: DocumentRecord[] = [];
  const warnings: string[] = [];

  // 本方户名/账号，用于识别内部划转
  const ownNames: string[] = [];
  const ownAccounts: string[] = [];
  for (const row of sheet.rows.slice(0, 50)) {
    const name = textOf(row, mapping, 'accountName');
    const acc = textOf(row, mapping, 'accountNo');
    if (name !== '' && !ownNames.includes(name)) ownNames.push(name);
    if (acc !== '' && !ownAccounts.includes(acc)) ownAccounts.push(acc);
  }

  let lastBalance: Cents | null = null;
  let lastDate: string | null = null;
  let balanceMismatch = 0;
  let skippedRows = 0;

  for (const row of sheet.rows) {
    if (isSummaryRow(row, mapping)) continue;

    const { amount, direction, warnings: rowWarnings } = resolveAmountAndDirection(row, mapping);
    if (amount === null || amount === 0) {
      skippedRows += 1;
      continue;
    }

    // 日期：空值则沿用上一行的日期（银行流水常见合并单元格或留空）
    let date = parseDate(valueOf(row, mapping, 'date'), lastDate === null
      ? {}
      : { defaultYear: Number(lastDate.slice(0, 4)), defaultMonth: Number(lastDate.slice(5, 7)) });
    if (date === null && lastDate !== null) {
      date = lastDate;
      rowWarnings.push('本行无日期，沿用上一行日期');
    }
    if (date !== null) lastDate = date;

    const rawSummary = valueOf(row, mapping, 'summary');
    const summaryText = isBlank(rawSummary) ? '' : normalizeText(rawSummary);
    const counterparty = textOf(row, mapping, 'counterparty');
    const counterpartyAccount = textOf(row, mapping, 'counterpartyAccount');
    const accountNo = textOf(row, mapping, 'accountNo');
    const accountName = textOf(row, mapping, 'accountName');
    const serialNo = textOf(row, mapping, 'serialNo');
    const currency = textOf(row, mapping, 'currency');

    const summary = makeSummary(summaryText, counterparty, counterpartyAccount)
      || (direction === 'in' ? '银行收款' : '银行付款');

    const fields: Record<string, string | number | boolean | null> = {
      ...classifySummary(`${summaryText} ${counterparty}`),
      accountNo,
      accountName,
      counterpartyAccount,
      serialNo,
      currency,
      direction,
      rawAmount: formatYuan(amount),
    };

    const isInternal = detectInternalTransfer(summaryText, counterparty, ownNames);
    fields['internalTransfer'] = isInternal;

    // 余额勾稽
    const balanceRaw = valueOf(row, mapping, 'balance');
    const balance = balanceRaw === null ? null : amountOf(balanceRaw);
    if (balance !== null && lastBalance !== null) {
      const expected = direction === 'in' ? lastBalance + amount : lastBalance - amount;
      if (Math.abs(expected - balance) > 1) {
        balanceMismatch += 1;
        if (balanceMismatch <= 5) {
          rowWarnings.push(
            `余额勾稽不符：上期余额 ${formatYuan(lastBalance)} ${direction === 'in' ? '+' : '-'} ` +
              `${formatYuan(amount)} = ${formatYuan(expected)}，但表内余额为 ${formatYuan(balance)}`,
          );
        }
      }
    }
    if (balance !== null) lastBalance = balance;

    documents.push(
      buildDocument({
        kind: 'bank',
        file: filePath,
        sheet: sheet.sheetName,
        row: row.rowNumber,
        date,
        summary,
        amount,
        direction,
        counterparty: counterparty === '' ? null : counterparty,
        fields,
        rawSummary: summaryText,
        warnings: rowWarnings,
      }),
    );
  }

  if (balanceMismatch > 0) {
    warnings.push(`共 ${balanceMismatch} 行余额勾稽不符，可能是流水不完整或存在多账户混排`);
  }
  if (skippedRows > 0) {
    warnings.push(`跳过 ${skippedRows} 行无有效金额的记录（可能是表头重复行或空行）`);
  }
  if (documents.length === 0) {
    warnings.push(`工作表「${sheet.sheetName}」未提取到任何有效流水`);
  }

  return { documents, warnings, mapping, sheetName: sheet.sheetName };
}

/**
 * 从已读取的工作表集合中提取银行流水。
 * 会自动挑选最像流水表的那张工作表。
 */
export function extractBank(sheets: readonly RawSheet[], filePath: string): BankExtraction {
  const best = pickBestSheet(sheets, BANK_COLUMNS);
  if (best === null) {
    return {
      documents: [],
      warnings: [`${filePath}: 未找到可识别的银行流水表头`],
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

  return extractBankFromSheet(best.sheet, best.mapping, filePath);
}

/** 重新导出，便于外部按需直接使用。 */
export { mapColumns, makeDocId };
