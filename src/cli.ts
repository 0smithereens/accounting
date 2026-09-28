#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 常用：
 *   node src/cli.ts 银行流水.xlsx 发票台账.xlsx            # 自动识别并生成凭证
 *   node src/cli.ts ./单据目录 --out out/凭证.xlsx          # 处理整个目录
 *   node src/cli.ts --kind bank --period 2024-01 流水.csv   # 显式指定类型与期间
 *   node src/cli.ts check                                   # 校验配置文件
 *   node src/cli.ts rules                                   # 列出全部记账规则
 *   node src/cli.ts explain 银行流水.xlsx                   # 诊断识别过程
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { parseArgs } from 'node:util';

import type { RuleCondition, SourceKind } from './core/types.ts';
import { SOURCE_KIND_LABEL } from './core/types.ts';
import { loadConfig, ConfigError, PROJECT_ROOT, type AppConfig } from './core/config.ts';
import { formatYuanGrouped, formatYuan } from './core/money.ts';
import { explainRules } from './core/rules.ts';
import { run, processFile, detectKind } from './pipeline.ts';
import { exportToExcel } from './export/voucher-excel.ts';
import { readWorkbook } from './io/excel-reader.ts';
import { readWord } from './io/word-reader.ts';
import { summarizeVouchers } from './ledger/voucher.ts';

const SUPPORTED_EXT = new Set(['.xlsx', '.xlsm', '.xls', '.csv', '.tsv', '.txt', '.docx', '.docm', '.doc']);

/* ------------------------------------------------------------------ */
/* 终端着色                                                            */
/* ------------------------------------------------------------------ */

const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const c = {
  red: (s: string): string => (useColor ? `\u001b[31m${s}\u001b[0m` : s),
  green: (s: string): string => (useColor ? `\u001b[32m${s}\u001b[0m` : s),
  yellow: (s: string): string => (useColor ? `\u001b[33m${s}\u001b[0m` : s),
  blue: (s: string): string => (useColor ? `\u001b[34m${s}\u001b[0m` : s),
  gray: (s: string): string => (useColor ? `\u001b[90m${s}\u001b[0m` : s),
  bold: (s: string): string => (useColor ? `\u001b[1m${s}\u001b[0m` : s),
};

function line(char = '─', width = 78): string {
  return c.gray(char.repeat(width));
}

/** 本地时间戳 YYYY-MM-DD-HHMMSS，用于默认输出文件名（用本地时间，符合使用直觉）。 */
function localTimestamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

interface CliOptions {
  command: 'run' | 'check' | 'rules' | 'explain' | 'help';
  inputs: string[];
  out: string;
  kind: SourceKind | undefined;
  period: string | undefined;
  autoBalance: boolean;
  dedup: boolean;
  quiet: boolean;
  recursive: boolean;
}

const USAGE = `${c.bold('会计自动化记账系统')}

用法：
  node src/cli.ts <文件或目录...> [选项]
  node src/cli.ts check | rules | explain <文件>

选项：
  --out, -o <路径>      输出 Excel 路径（默认 out/记账凭证-<时间戳>.xlsx）
  --kind, -k <类型>     强制指定单据类型：bank | invoice | expense | payroll | contract
  --period, -p <期间>   缺省会计期间，格式 YYYY-MM（用于日期缺失的单据，如工资表）
  --no-balance          关闭自动配平（借贷不平时只告警，不挂待处理科目）
  --no-dedup            关闭跨单据重复业务去重（默认开启，防止银行流水与工资表重复记账）
  --recursive, -r       输入为目录时递归查找子目录
  --quiet, -q           只输出最终结果，不显示逐文件进度
  --help, -h            显示本帮助

示例：
  node src/cli.ts samples                                  # 处理 samples 目录下的全部样例
  node src/cli.ts samples --period 2024-01                 # 指定会计期间
  node src/cli.ts 银行流水.xlsx 发票台账.xlsx --period 2024-01
  node src/cli.ts ./单据 -r --out out/2024-01凭证.xlsx      # 递归处理目录并指定输出
  node src/cli.ts --kind payroll --period 2024-01 工资表.xlsx
  node src/cli.ts explain 银行流水.xlsx                     # 诊断识别过程
`;

function parseCliArgs(argv: readonly string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string', short: 'o' },
      kind: { type: 'string', short: 'k' },
      period: { type: 'string', short: 'p' },
      'no-balance': { type: 'boolean' },
      'no-dedup': { type: 'boolean' },
      recursive: { type: 'boolean', short: 'r' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  const positionalsList = [...positionals];
  let command: CliOptions['command'] = 'run';

  const first = positionalsList[0];
  if (first === 'check' || first === 'rules' || first === 'explain') {
    command = first;
    positionalsList.shift();
  } else if (first === 'help') {
    command = 'help';
    positionalsList.shift();
  }

  if (values.help === true) command = 'help';

  let kind: SourceKind | undefined;
  if (values.kind !== undefined) {
    const valid: SourceKind[] = ['bank', 'invoice', 'expense', 'payroll', 'contract', 'unknown'];
    if (!valid.includes(values.kind as SourceKind)) {
      throw new Error(`--kind 取值必须是 ${valid.join(' | ')}，实际为「${values.kind}」`);
    }
    kind = values.kind as SourceKind;
  }

  const period = values.period;
  if (period !== undefined && !/^\d{4}-\d{2}$/.test(period)) {
    throw new Error(`--period 格式应为 YYYY-MM，实际为「${period}」`);
  }

  const options: CliOptions = {
    command,
    inputs: positionalsList,
    out: values.out ?? '',
    kind,
    period,
    autoBalance: values['no-balance'] !== true,
    dedup: values['no-dedup'] !== true,
    quiet: values.quiet === true,
    recursive: values.recursive === true,
  };
  if (kind === undefined) delete options.kind;
  if (period === undefined) delete options.period;
  return options;
}

/* ------------------------------------------------------------------ */
/* 输入收集                                                            */
/* ------------------------------------------------------------------ */

async function collectInputs(inputs: readonly string[], recursive: boolean): Promise<string[]> {
  const files: string[] = [];

  for (const input of inputs) {
    const full = resolve(input);
    if (!existsSync(full)) {
      throw new Error(`路径不存在：${input}`);
    }
    const info = await stat(full);
    if (info.isDirectory()) {
      const entries = await readdir(full, { withFileTypes: true });
      for (const entry of entries) {
        const child = join(full, entry.name);
        if (entry.isDirectory()) {
          if (recursive) files.push(...(await collectInputs([child], recursive)));
          continue;
        }
        if (entry.name.startsWith('~$') || entry.name.startsWith('.')) continue;
        if (SUPPORTED_EXT.has(extname(entry.name).toLowerCase())) files.push(child);
      }
    } else {
      if (!SUPPORTED_EXT.has(extname(full).toLowerCase())) {
        throw new Error(
          `不支持的文件类型：${basename(full)}（支持 ${[...SUPPORTED_EXT].join('/')}）`,
        );
      }
      files.push(full);
    }
  }

  return [...new Set(files)].sort();
}

/* ------------------------------------------------------------------ */
/* 子命令：check                                                       */
/* ------------------------------------------------------------------ */

function cmdCheck(): number {
  console.log(c.bold('配置文件校验'));
  console.log(line());

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.log(c.red(`✗ 配置错误：${err.message}`));
      return 1;
    }
    throw err;
  }

  console.log(`${c.green('✓')} 会计科目表：${config.accounts.accounts.length} 个科目`);
  console.log(`${c.green('✓')} 记账规则：${config.rules.rules.length} 条（来自 ${config.rules.files.join('、')}）`);
  console.log(`${c.green('✓')} 全局设置：凭证字「${config.settings.voucherWord}」，兜底科目 ${config.settings.suspenseAccount}`);

  // 校验规则引用的科目是否存在
  let problems = 0;
  const referenced = new Map<string, string[]>();
  for (const rule of config.rules.rules) {
    for (const entry of rule.then.entries) {
      const code = entry.account;
      if (code.includes('{')) continue; // 动态科目，运行时才能确定
      const list = referenced.get(code) ?? [];
      list.push(rule.id);
      referenced.set(code, list);
    }
  }

  for (const [code, ruleIds] of referenced) {
    const resolved = config.accounts.resolve(code);
    if (resolved.problem !== undefined) {
      console.log(c.red(`✗ ${resolved.problem}`));
      console.log(c.gray(`    被以下规则引用：${ruleIds.join('、')}`));
      problems += 1;
    } else if (resolved.changed) {
      console.log(
        `${c.green('✓')} 科目 ${code} 有下级明细，将自动下钻到 ${resolved.code} ${resolved.name}`,
      );
    }
  }

  // 企业名称检查
  if (config.settings.companyNames.length === 0) {
    console.log(c.yellow('! 未配置 companyNames（本企业名称），发票无法判断进项/销项，合同无法判断甲乙方'));
    problems += 1;
  } else {
    console.log(`${c.green('✓')} 本企业名称：${config.settings.companyNames.join('、')}`);
  }

  // 兜底科目检查
  if (config.accounts.get(config.settings.suspenseAccount) === undefined) {
    console.log(c.red(`✗ 兜底科目 ${config.settings.suspenseAccount} 不存在`));
    problems += 1;
  }

  console.log(line());
  if (problems === 0) {
    console.log(c.green('配置校验通过，可以开始记账。'));
    return 0;
  }
  console.log(c.yellow(`配置校验发现 ${problems} 处问题，建议先修正再生成凭证。`));
  return 1;
}

/* ------------------------------------------------------------------ */
/* 子命令：rules                                                       */
/* ------------------------------------------------------------------ */

function cmdRules(): number {
  const config = loadConfig();
  console.log(c.bold(`记账规则共 ${config.rules.rules.length} 条（按优先级从高到低）`));
  console.log(line());

  for (const rule of config.rules.rules) {
    const kinds = rule.kinds === undefined || rule.kinds.length === 0
      ? '全部'
      : rule.kinds.map((k) => SOURCE_KIND_LABEL[k]).join('/');
    const conditions = describeCondition(rule.when);
    const entries = rule.then.entries
      .map((e) => `${e.side === 'debit' ? '借' : '贷'} ${e.account}(${e.amount ?? 'total'})`)
      .join('  ');

    console.log(`${c.bold(rule.id)}  ${c.gray(`优先级 ${rule.priority} · 适用 ${kinds}`)}`);
    if (rule.desc !== undefined) console.log(`  说明：${rule.desc}`);
    console.log(`  条件：${conditions}`);
    console.log(`  分录：${entries}`);
    if (rule.warn !== undefined) console.log(c.yellow(`  提示：${rule.warn}`));
    console.log();
  }
  return 0;
}

function describeCondition(cond: RuleCondition): string {
  const parts: string[] = [];
  const source = cond as unknown as Record<string, unknown>;
  const push = (label: string, value: unknown): void => {
    if (value === undefined) return;
    if (Array.isArray(value)) parts.push(`${label}[${value.join(',')}]`);
    else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value)) parts.push(`${label}.${k}=${JSON.stringify(v)}`);
    } else parts.push(`${label}=${String(value)}`);
  };

  push('摘要含', source['summary']);
  push('摘要全含', source['summaryAll']);
  push('摘要正则', source['summaryRegex']);
  push('摘要排除', source['summaryNot']);
  push('方向', source['direction']);
  push('往来单位', source['counterparty']);
  push('金额≥', source['amountMin']);
  push('金额≤', source['amountMax']);
  push('字段', source['fields']);
  push('字段含', source['fieldContains']);
  if (Array.isArray(source['anyOf'])) parts.push(`任一(${source['anyOf'].length}条子条件)`);
  if (source['not'] !== undefined) parts.push('取反条件');

  return parts.length === 0 ? c.gray('（无条件，匹配所有单据）') : parts.join(' 且 ');
}

/* ------------------------------------------------------------------ */
/* 子命令：explain                                                     */
/* ------------------------------------------------------------------ */

async function cmdExplain(file: string): Promise<number> {
  const config = loadConfig();
  const full = resolve(file);
  console.log(c.bold(`识别诊断：${basename(full)}`));
  console.log(line());

  const result = await processFile(full, { config });

  console.log(`识别类型：${c.bold(SOURCE_KIND_LABEL[result.kind])}`);
  if (result.sheetName !== null) console.log(`使用工作表：${result.sheetName}`);

  if (result.kindScores.length > 0) {
    console.log();
    console.log(c.bold('表头结构打分：'));
    for (const score of result.kindScores) {
      const bar = '█'.repeat(Math.max(0, Math.round(score.score * 30)));
      console.log(`  ${SOURCE_KIND_LABEL[score.kind].padEnd(18)} ${score.score.toFixed(3)} ${c.blue(bar)} ${c.gray(score.sheet)}`);
    }
  }

  const ext = extname(full).toLowerCase();
  if (ext === '.docx' || ext === '.docm') {
    const word = await readWord(full);
    console.log();
    console.log(c.bold('正文前 800 字：'));
    console.log(c.gray(word.text.slice(0, 800)));
    console.log();
    console.log(`段落数 ${word.paragraphCount}，表格数 ${word.tables.length}`);
  } else {
    const sheets = await readWorkbook(full);
    for (const sheet of sheets) {
      console.log();
      console.log(c.bold(`工作表「${sheet.sheetName}」`));
      console.log(`  表头行：第 ${sheet.headerRowIndex + 1} 行`);
      console.log(`  表头：${sheet.headers.join(' | ')}`);
      console.log(`  数据行数：${sheet.rows.length}`);
      const sample = sheet.rows.slice(0, 3);
      for (const row of sample) {
        console.log(c.gray(`    行${row.rowNumber}: ${row.cells.map((x) => (x === null ? '' : String(x))).join(' | ')}`));
      }
    }
  }

  console.log();
  console.log(c.bold(`提取到 ${result.documents.length} 条单据：`));
  for (const doc of result.documents.slice(0, 10)) {
    console.log(
      `  ${c.gray(doc.date ?? '无日期')} ${doc.summary.slice(0, 40).padEnd(42)} ` +
        `${formatYuan(doc.amount).padStart(14)} ${doc.direction === 'in' ? c.green('收') : doc.direction === 'out' ? c.red('付') : '—'}`,
    );
  }
  if (result.documents.length > 10) console.log(c.gray(`  ...另有 ${result.documents.length - 10} 条`));

  const firstDoc = result.documents[0];
  if (firstDoc !== undefined) {
    console.log();
    console.log(c.bold('首条单据的规则匹配明细：'));
    const explanations = explainRules(config.rules.rules, firstDoc);
    const matched = explanations.filter((e) => e.matched);
    if (matched.length > 0) {
      console.log(c.green(`  ✓ 命中规则：${matched[0]?.ruleId}`));
      for (const reason of matched[0]?.reasons ?? []) console.log(c.gray(`      · ${reason}`));
    } else {
      console.log(c.yellow('  ✗ 没有规则命中该单据'));
      for (const e of explanations.slice(0, 5)) {
        console.log(c.gray(`      ${e.ruleId}: 未通过 ${e.failed.join('；')}`));
      }
    }
  }

  if (result.issues.length > 0) {
    console.log();
    console.log(c.bold('识别过程提示：'));
    for (const issue of result.issues) {
      const prefix = issue.level === 'error' ? c.red('✗') : issue.level === 'warning' ? c.yellow('!') : c.blue('i');
      console.log(`  ${prefix} ${issue.message}`);
    }
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/* 主命令：run                                                         */
/* ------------------------------------------------------------------ */

async function cmdRun(options: CliOptions): Promise<number> {
  if (options.inputs.length === 0) {
    console.log(USAGE);
    return 1;
  }

  const files = await collectInputs(options.inputs, options.recursive);
  if (files.length === 0) {
    console.log(c.yellow('没有找到可处理的文件。'));
    return 1;
  }

  console.log(c.bold(`会计自动化记账 — 共 ${files.length} 个文件`));
  console.log(line());

  const runOptions: import('./pipeline.ts').RunOptions = {
    autoBalance: options.autoBalance,
    noDedup: !options.dedup,
  };
  if (options.kind !== undefined) runOptions.kind = options.kind;
  if (options.period !== undefined) runOptions.period = options.period;
  if (!options.quiet) runOptions.onProgress = (message) => console.log(c.gray(`  ${message}`));

  const result = await run(files, runOptions);

  console.log(line());
  console.log(c.bold('处理结果'));
  console.log(`  识别单据：${result.stats.documents} 条`);
  for (const [kind, count] of Object.entries(result.stats.byKind)) {
    console.log(`    ${SOURCE_KIND_LABEL[kind as SourceKind] ?? kind}：${count} 条`);
  }
  console.log(`  生成凭证：${result.stats.vouchers} 张（借贷平衡 ${result.stats.balanced} 张）`);
  if (result.stats.duplicates > 0) {
    console.log(`  ${c.blue(`去重跳过：${result.stats.duplicates} 条重复业务单据`)}`);
  }
  console.log(`  借方发生额：${formatYuanGrouped(result.stats.totalDebit)}`);
  console.log(`  贷方发生额：${formatYuanGrouped(result.stats.totalCredit)}`);

  const summary = summarizeVouchers(result.vouchers);
  if (summary.totalDebit === summary.totalCredit) {
    console.log(`  ${c.green('✓ 全部凭证试算平衡')}`);
  } else {
    console.log(`  ${c.red(`✗ 试算不平衡，差额 ${formatYuan(summary.totalDebit - summary.totalCredit)}`)}`);
  }

  const errors = result.issues.filter((i) => i.level === 'error');
  const warnings = result.issues.filter((i) => i.level === 'warning');
  const infos = result.issues.filter((i) => i.level === 'info');

  if (errors.length > 0) {
    console.log();
    console.log(c.red(`✗ 错误 ${errors.length} 条：`));
    for (const issue of errors.slice(0, 20)) console.log(c.red(`  · ${issue.message}`));
    if (errors.length > 20) console.log(c.gray(`  ...另有 ${errors.length - 20} 条，详见导出的「问题与待办」表`));
  }

  if (warnings.length > 0) {
    console.log();
    console.log(c.yellow(`! 警告 ${warnings.length} 条：`));
    for (const issue of warnings.slice(0, 15)) console.log(c.yellow(`  · ${issue.message}`));
    if (warnings.length > 15) console.log(c.gray(`  ...另有 ${warnings.length - 15} 条，详见导出的「问题与待办」表`));
  }

  if (errors.length === 0 && warnings.length === 0 && infos.length > 0) {
    console.log();
    console.log(c.blue(`i 提示 ${infos.length} 条（如自动识别结果、合同仅登记台账等）`));
  }

  // 导出
  const outPath = options.out !== ''
    ? resolve(options.out)
    : join(PROJECT_ROOT, 'out', `记账凭证-${localTimestamp()}.xlsx`);

  const notes: string[] = [];
  if (options.kind !== undefined) notes.push(`强制单据类型：${SOURCE_KIND_LABEL[options.kind]}`);
  if (options.period !== undefined) notes.push(`缺省会计期间：${options.period}`);
  notes.push(`自动配平：${options.autoBalance ? '启用' : '关闭'}`);
  notes.push(`跨单据去重：${options.dedup ? '启用' : '关闭'}`);

  await exportToExcel(outPath, {
    vouchers: result.vouchers,
    documents: result.documents,
    issues: result.issues,
    config: result.config,
    files,
    notes,
  });

  console.log();
  console.log(line());
  console.log(`${c.green('✓')} 已导出：${c.bold(outPath)}`);
  console.log(c.gray('  包含 6 张表：记账凭证 / 科目汇总表 / 单据台账 / 问题与待办 / 导入模板 / 处理说明'));

  return errors.length > 0 ? 2 : 0;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(c.red(`参数错误：${(err as Error).message}`));
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  switch (options.command) {
    case 'help':
      console.log(USAGE);
      return;
    case 'check':
      process.exitCode = cmdCheck();
      return;
    case 'rules':
      process.exitCode = cmdRules();
      return;
    case 'explain': {
      const file = options.inputs[0];
      if (file === undefined) {
        console.error(c.red('用法：node src/cli.ts explain <文件>'));
        process.exitCode = 1;
        return;
      }
      process.exitCode = await cmdExplain(file);
      return;
    }
    case 'run':
    default:
      process.exitCode = await cmdRun(options);
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(c.red(`配置错误：${err.message}`));
  } else {
    console.error(c.red(`运行失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`));
  }
  process.exitCode = 1;
});
