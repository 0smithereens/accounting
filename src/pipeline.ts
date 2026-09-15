/**
 * 端到端处理管线。
 *
 *   文件 → 读取 → 识别单据类型 → 提取业务单据 → 规则匹配 → 生成凭证 → 校验
 *
 * 单据类型识别优先用「表头结构打分」自动判断，也支持调用方显式指定。
 */

import { extname } from 'node:path';

import type {
  DocumentRecord,
  ProcessResult,
  ProcessingIssue,
  RawSheet,
  SourceKind,
} from './core/types.ts';
import { SOURCE_KIND_LABEL } from './core/types.ts';
import { loadConfig, type AppConfig } from './core/config.ts';
import { readWorkbook } from './io/excel-reader.ts';
import { readWord } from './io/word-reader.ts';
import { ReadError } from './io/errors.ts';
import { scoreSheet } from './io/table-detect.ts';
import { BANK_COLUMNS, EXPENSE_COLUMNS, INVOICE_COLUMNS, PAYROLL_COLUMNS } from './extract/schemas.ts';
import { extractBank } from './extract/bank.ts';
import { extractInvoice } from './extract/invoice.ts';
import { extractExpense } from './extract/expense.ts';
import { extractPayroll } from './extract/payroll.ts';
import { extractContract } from './extract/contract.ts';
import { buildVouchers } from './ledger/voucher.ts';
import { deduplicate } from './core/dedup.ts';
import { inferPeriod } from './core/datetime.ts';

export interface ProcessOptions {
  /** 显式指定单据类型，不指定则自动识别 */
  kind?: SourceKind;
  /** 缺省会计期间 YYYY-MM，用于日期缺失的单据 */
  period?: string;
  /** 是否自动配平（借贷不平时挂待处理科目） */
  autoBalance?: boolean;
  /** 已加载的配置，复用可避免重复读盘 */
  config?: AppConfig;
}

export interface FileProcessResult {
  file: string;
  kind: SourceKind;
  sheetName: string | null;
  documents: DocumentRecord[];
  issues: ProcessingIssue[];
  /** 各类型表头打分，用于诊断「为什么识别成了这一类」 */
  kindScores: Array<{ kind: SourceKind; score: number; sheet: string }>;
}

/* ------------------------------------------------------------------ */
/* 单据类型识别                                                        */
/* ------------------------------------------------------------------ */

const SCHEMA_BY_KIND: Array<{ kind: SourceKind; columns: typeof BANK_COLUMNS }> = [
  { kind: 'bank', columns: BANK_COLUMNS },
  { kind: 'invoice', columns: INVOICE_COLUMNS },
  { kind: 'expense', columns: EXPENSE_COLUMNS },
  { kind: 'payroll', columns: PAYROLL_COLUMNS },
];

/**
 * 按表头结构给每类单据打分，返回排序后的候选。
 */
export function detectKind(
  sheets: readonly RawSheet[],
): Array<{ kind: SourceKind; score: number; sheet: string }> {
  const scores: Array<{ kind: SourceKind; score: number; sheet: string }> = [];

  for (const { kind, columns } of SCHEMA_BY_KIND) {
    let best = { score: -1, sheet: '' };
    for (const sheet of sheets) {
      if (sheet.headers.length === 0) continue;
      const scored = scoreSheet(sheet, columns);
      // 缺少必需列的表直接判负，避免「像但不是」
      const penalty = scored.mapping.missingRequired.length > 0 ? 0.5 : 0;
      const score = scored.score - penalty;
      if (score > best.score) best = { score, sheet: sheet.sheetName };
    }
    if (best.score > -1) scores.push({ kind, score: best.score, sheet: best.sheet });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores;
}

function isWordFile(ext: string): boolean {
  return ext === '.docx' || ext === '.docm' || ext === '.doc';
}

function isSpreadsheet(ext: string): boolean {
  return ext === '.xlsx' || ext === '.xlsm' || ext === '.xls' || ext === '.csv' || ext === '.tsv' || ext === '.txt';
}

/* ------------------------------------------------------------------ */
/* 单文件处理                                                          */
/* ------------------------------------------------------------------ */

export async function processFile(
  filePath: string,
  options: ProcessOptions = {},
): Promise<FileProcessResult> {
  const config = options.config ?? loadConfig();
  const ext = extname(filePath).toLowerCase();
  const issues: ProcessingIssue[] = [];

  /* ---------------- Word 文档 ---------------- */
  if (isWordFile(ext)) {
    if (options.kind !== undefined && options.kind !== 'contract' && options.kind !== 'unknown') {
      issues.push({
        level: 'warning',
        message: `${filePath}: 指定为「${SOURCE_KIND_LABEL[options.kind]}」但文件是 Word 文档，已按合同处理`,
        source: { file: filePath },
      });
    }
    try {
      const word = await readWord(filePath);
      const result = extractContract(word, filePath, {
        companyNames: config.settings.companyNames,
        ...(options.period === undefined ? {} : { fallbackDate: `${options.period}-01` }),
      });
      for (const w of result.warnings) {
        issues.push({ level: 'warning', message: w, source: { file: filePath } });
      }
      return {
        file: filePath,
        kind: 'contract',
        sheetName: null,
        documents: result.documents,
        issues,
        kindScores: [{ kind: 'contract', score: 1, sheet: '' }],
      };
    } catch (err) {
      const message = err instanceof ReadError ? err.message : `${filePath}: ${(err as Error).message}`;
      return {
        file: filePath,
        kind: 'unknown',
        sheetName: null,
        documents: [],
        issues: [{ level: 'error', message, source: { file: filePath } }],
        kindScores: [],
      };
    }
  }

  /* ---------------- Excel / CSV ---------------- */
  if (!isSpreadsheet(ext)) {
    return {
      file: filePath,
      kind: 'unknown',
      sheetName: null,
      documents: [],
      issues: [
        {
          level: 'error',
          message: `${filePath}: 不支持的文件类型「${ext}」，目前支持 .xlsx/.xlsm/.csv 与 .docx`,
          source: { file: filePath },
        },
      ],
      kindScores: [],
    };
  }

  let sheets: RawSheet[];
  try {
    sheets = await readWorkbook(filePath);
  } catch (err) {
    const message = err instanceof ReadError ? err.message : `${filePath}: ${(err as Error).message}`;
    return {
      file: filePath,
      kind: 'unknown',
      sheetName: null,
      documents: [],
      issues: [{ level: 'error', message, source: { file: filePath } }],
      kindScores: [],
    };
  }

  if (sheets.length === 0) {
    return {
      file: filePath,
      kind: 'unknown',
      sheetName: null,
      documents: [],
      issues: [{ level: 'error', message: `${filePath}: 工作簿中没有任何非空工作表`, source: { file: filePath } }],
      kindScores: [],
    };
  }

  const kindScores = detectKind(sheets);
  let kind = options.kind;

  if (kind === undefined || kind === 'unknown') {
    const best = kindScores[0];
    if (best === undefined || best.score <= 0) {
      const detail = kindScores
        .map((s) => `${SOURCE_KIND_LABEL[s.kind]}=${s.score.toFixed(2)}`)
        .join('，');
      return {
        file: filePath,
        kind: 'unknown',
        sheetName: null,
        documents: [],
        issues: [
          {
            level: 'error',
            message:
              `${filePath}: 无法识别单据类型（表头打分：${detail || '无'}）。` +
              `表头为：${sheets[0]?.headers.join(' | ') ?? '空'}\n` +
              '请用 --kind bank|invoice|expense|payroll 显式指定，或调整表头以匹配 config/mappings 中的同义词。',
            source: { file: filePath },
          },
        ],
        kindScores,
      };
    }
    kind = best.kind;
    issues.push({
      level: 'info',
      message: `自动识别为「${SOURCE_KIND_LABEL[kind]}」（工作表「${best.sheet}」，置信度 ${(best.score * 100).toFixed(0)}%）`,
      source: { file: filePath, sheet: best.sheet },
    });
  }

  let documents: DocumentRecord[] = [];
  let sheetName: string | null = null;
  let warnings: string[] = [];

  switch (kind) {
    case 'bank': {
      const r = extractBank(sheets, filePath);
      documents = r.documents;
      warnings = r.warnings;
      sheetName = r.sheetName;
      break;
    }
    case 'invoice': {
      const r = extractInvoice(sheets, filePath, {
        companyNames: config.settings.companyNames,
        defaultTaxRate: config.settings.defaultTaxRate,
      });
      documents = r.documents;
      warnings = r.warnings;
      sheetName = r.sheetName;
      break;
    }
    case 'expense': {
      const r = extractExpense(sheets, filePath, {
        departments: config.settings.departments,
        creditAccount: config.settings.expenseCreditAccount,
      });
      documents = r.documents;
      warnings = r.warnings;
      sheetName = r.sheetName;
      break;
    }
    case 'payroll': {
      const r = extractPayroll(sheets, filePath, {
        departments: config.settings.departments,
        ...(options.period === undefined ? {} : { defaultPeriod: options.period }),
      });
      documents = r.documents;
      warnings = r.warnings;
      sheetName = r.sheetName;
      break;
    }
    default: {
      return {
        file: filePath,
        kind: 'unknown',
        sheetName: null,
        documents: [],
        issues: [
          {
            level: 'error',
            message: `${filePath}: 不支持的单据类型「${kind}」`,
            source: { file: filePath },
          },
        ],
        kindScores,
      };
    }
  }

  for (const w of warnings) {
    issues.push({ level: 'warning', message: w, source: { file: filePath, ...(sheetName === null ? {} : { sheet: sheetName }) } });
  }

  return { file: filePath, kind, sheetName, documents, issues, kindScores };
}

/* ------------------------------------------------------------------ */
/* 批量处理                                                            */
/* ------------------------------------------------------------------ */

export interface RunOptions extends ProcessOptions {
  /** 每个文件的类型覆盖：文件路径 → 类型 */
  kindOverrides?: Record<string, SourceKind>;
  /** 关闭跨单据重复业务去重 */
  noDedup?: boolean;
  onProgress?: (message: string) => void;
}

/** 处理一批文件并生成凭证。 */
export async function run(
  files: readonly string[],
  options: RunOptions = {},
): Promise<ProcessResult & { fileResults: FileProcessResult[]; config: AppConfig }> {
  const started = Date.now();
  const config = options.config ?? loadConfig();
  const log = options.onProgress ?? ((): void => {});

  const fileResults: FileProcessResult[] = [];
  const allIssues: ProcessingIssue[] = [];
  const allDocuments: DocumentRecord[] = [];

  for (const file of files) {
    const override = options.kindOverrides?.[file];
    const fileOptions: ProcessOptions = { config };
    const kind = override ?? options.kind;
    if (kind !== undefined) fileOptions.kind = kind;
    if (options.period !== undefined) fileOptions.period = options.period;
    if (options.autoBalance !== undefined) fileOptions.autoBalance = options.autoBalance;

    log(`读取 ${file}`);
    const result = await processFile(file, fileOptions);
    fileResults.push(result);
    allIssues.push(...result.issues);
    allDocuments.push(...result.documents);
    log(
      `  → ${SOURCE_KIND_LABEL[result.kind]}，提取 ${result.documents.length} 条单据` +
        (result.sheetName === null ? '' : `（工作表「${result.sheetName}」）`),
    );
  }

  // 日期缺失时用众数期间兜底
  let period = options.period;
  if (period === undefined) {
    const dates = allDocuments.map((d) => d.date).filter((d): d is string => d !== null);
    const inferred = inferPeriod(dates);
    if (inferred !== null) period = inferred;
  }

  // 跨单据重复业务去重（银行代发工资 vs 工资表发放等）
  const dedupResult = options.noDedup === true
    ? { documents: allDocuments, dropped: [], issues: [] as ProcessingIssue[] }
    : deduplicate(allDocuments, config.dedup);
  allIssues.push(...dedupResult.issues);
  if (dedupResult.dropped.length > 0) {
    log(`检测到 ${dedupResult.dropped.length} 条重复业务单据，已跳过以避免重复记账`);
  }
  const effectiveDocuments = dedupResult.documents;

  const buildOptions: import('./ledger/voucher.ts').BuildVouchersOptions = {};
  if (period !== undefined) buildOptions.defaultPeriod = period;
  if (options.autoBalance !== undefined) buildOptions.autoBalance = options.autoBalance;

  const { vouchers, issues: voucherIssues, unmatched } = buildVouchers(effectiveDocuments, config, buildOptions);
  allIssues.push(...voucherIssues);

  if (unmatched.length > 0) {
    log(`有 ${unmatched.length} 条单据未能生成凭证`);
  }

  const byKind: Record<string, number> = {};
  for (const doc of effectiveDocuments) {
    byKind[doc.kind] = (byKind[doc.kind] ?? 0) + 1;
  }

  const totalDebit = vouchers.reduce((sum, v) => sum + v.totalDebit, 0);
  const totalCredit = vouchers.reduce((sum, v) => sum + v.totalCredit, 0);

  return {
    vouchers,
    documents: effectiveDocuments,
    issues: allIssues,
    config,
    fileResults,
    stats: {
      files: files.length,
      documents: effectiveDocuments.length,
      vouchers: vouchers.length,
      balanced: vouchers.filter((v) => v.balanced).length,
      totalDebit,
      totalCredit,
      unmatched: unmatched.length,
      duplicates: dedupResult.dropped.length,
      byKind,
      elapsedMs: Date.now() - started,
    },
  };
}
