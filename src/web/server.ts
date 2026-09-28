#!/usr/bin/env node
/**
 * Web 界面服务。
 *
 *   node src/web/server.ts [--port 8787] [--host 127.0.0.1]
 *
 * 设计取舍：
 *  - 用 Node 原生 http，不引入 Express/Fastify，减少依赖与安装体积。
 *  - 上传用「前端读文件 → base64 → JSON POST」，不手写 multipart 解析。
 *    财务文件的常规大小（几 MB）完全够用，代码也更容易审计。
 *  - 默认只监听 127.0.0.1：这是处理真实账务数据的工具，不应该默认对外暴露。
 *  - 生成的凭证文件保存在 out/ 目录，通过 runId 下载，重启服务后失效（需重新生成）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve, normalize } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

import type { SourceKind } from '../core/types.ts';
import { SOURCE_KIND_LABEL } from '../core/types.ts';
import { PROJECT_ROOT, loadConfig, ConfigError, type AppConfig } from '../core/config.ts';
import { formatYuan, formatYuanGrouped } from '../core/money.ts';
import { run } from '../pipeline.ts';
import { exportToExcel } from '../export/voucher-excel.ts';
import { summarizeVouchers } from '../ledger/voucher.ts';

const PUBLIC_DIR = join(PROJECT_ROOT, 'src', 'web', 'public');
const WORK_DIR = join(PROJECT_ROOT, 'out', 'web-runs');
const MAX_BODY_BYTES = 60 * 1024 * 1024; // 60MB，base64 后约对应 45MB 原始文件

/* ------------------------------------------------------------------ */
/* 运行的记账任务                                                      */
/* ------------------------------------------------------------------ */

interface WebRun {
  id: string;
  createdAt: number;
  outputPath: string;
  files: string[];
  stats: Record<string, unknown>;
  issues: Array<{ level: string; message: string; file: string; row?: number }>;
  vouchers: Array<{
    word: string;
    date: string;
    lines: Array<{
      summary: string;
      accountCode: string;
      accountName: string;
      debit: number | null;
      credit: number | null;
      auxiliary: string;
    }>;
  }>;
  documents: Array<{
    kind: string;
    date: string;
    summary: string;
    counterparty: string;
    amount: string;
    direction: string;
    file: string;
    row: number | null;
  }>;
  trialBalance: Array<{
    accountCode: string;
    accountName: string;
    debit: string;
    credit: string;
    balance: string;
  }>;
}

const runs = new Map<string, WebRun>();

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过上限 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 安全的静态文件读取：禁止路径穿越。 */
async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    json(res, 403, { error: '禁止访问' });
    return true;
  }
  if (!existsSync(target)) return false;

  const data = await readFile(target);
  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': data.length,
  });
  res.end(data);
  return true;
}

/** 去掉文件名的路径部分与危险字符，避免写入越界。 */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
}

/* ------------------------------------------------------------------ */
/* 接口实现                                                            */
/* ------------------------------------------------------------------ */

interface ProcessRequestBody {
  files: Array<{ name: string; data: string }>;
  period?: string;
  kind?: string;
  autoBalance?: boolean;
  dedup?: boolean;
}

async function handleProcess(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: ProcessRequestBody;
  try {
    body = JSON.parse(await readBody(req)) as ProcessRequestBody;
  } catch (err) {
    json(res, 400, { error: `请求解析失败：${(err as Error).message}` });
    return;
  }

  if (!Array.isArray(body.files) || body.files.length === 0) {
    json(res, 400, { error: '请至少上传一个文件' });
    return;
  }

  const runId = randomUUID();
  const runDir = join(WORK_DIR, runId);
  await mkdir(runDir, { recursive: true });

  const savedFiles: string[] = [];
  try {
    for (const file of body.files) {
      const name = safeFileName(file.name);
      const data = Buffer.from(file.data, 'base64');
      if (data.length === 0) {
        json(res, 400, { error: `文件「${name}」内容为空` });
        return;
      }
      const target = join(runDir, name);
      await writeFile(target, data);
      savedFiles.push(target);
    }

    let config: AppConfig;
    try {
      config = loadConfig();
    } catch (err) {
      json(res, 500, {
        error: err instanceof ConfigError ? `配置错误：${err.message}` : `配置加载失败：${(err as Error).message}`,
      });
      return;
    }

    const runOptions: Parameters<typeof run>[1] = {
      config,
      autoBalance: body.autoBalance !== false,
      noDedup: body.dedup === false,
    };
    if (body.period !== undefined && /^\d{4}-\d{2}$/.test(body.period)) runOptions.period = body.period;
    if (body.kind !== undefined && body.kind !== '' && body.kind !== 'auto') {
      runOptions.kind = body.kind as SourceKind;
    }

    const result = await run(savedFiles, runOptions);
    const summary = summarizeVouchers(result.vouchers);

    const outputPath = join(PROJECT_ROOT, 'out', `记账凭证-${new Date().toISOString().slice(0, 10)}-${runId.slice(0, 8)}.xlsx`);
    const notes = [
      `提交方式：Web 界面`,
      `缺省会计期间：${body.period ?? '（自动推断）'}`,
      `自动配平：${body.autoBalance !== false ? '启用' : '关闭'}`,
      `跨单据去重：${body.dedup !== false ? '启用' : '关闭'}`,
    ];
    await exportToExcel(outputPath, {
      vouchers: result.vouchers,
      documents: result.documents,
      issues: result.issues,
      config: result.config,
      files: savedFiles.map((f) => f.replace(/^.*web-runs[\\/]/, '')),
      notes,
    });

    const trial = new Map<string, { name: string; debit: number; credit: number }>();
    for (const v of result.vouchers) {
      for (const line of v.lines) {
        const bucket = trial.get(line.accountCode) ?? { name: line.accountName, debit: 0, credit: 0 };
        bucket.debit += line.debit;
        bucket.credit += line.credit;
        trial.set(line.accountCode, bucket);
      }
    }

    const webRun: WebRun = {
      id: runId,
      createdAt: Date.now(),
      outputPath,
      files: savedFiles.map((f) => f.replace(/^.*web-runs[\\/]/, '')),
      stats: {
        files: result.stats.files,
        documents: result.stats.documents,
        vouchers: result.stats.vouchers,
        balanced: result.stats.balanced,
        duplicates: result.stats.duplicates,
        unmatched: result.stats.unmatched,
        totalDebit: formatYuan(result.stats.totalDebit),
        totalCredit: formatYuan(result.stats.totalCredit),
        totalDebitGrouped: formatYuanGrouped(result.stats.totalDebit),
        totalCreditGrouped: formatYuanGrouped(result.stats.totalCredit),
        elapsedMs: result.stats.elapsedMs,
        trialBalanced: summary.totalDebit === summary.totalCredit,
        byKind: Object.fromEntries(
          Object.entries(result.stats.byKind).map(([k, v]) => [SOURCE_KIND_LABEL[k as SourceKind] ?? k, v]),
        ),
        fileResults: result.fileResults.map((f) => ({
          file: f.file.replace(/^.*web-runs[\\/]/, ''),
          kind: SOURCE_KIND_LABEL[f.kind],
          sheet: f.sheetName,
          documents: f.documents.length,
        })),
      },
      issues: result.issues.map((i) => ({
        level: i.level,
        message: i.message,
        file: i.source.file.replace(/^.*web-runs[\\/]/, ''),
        ...(i.source.row === undefined ? {} : { row: i.source.row }),
      })),
      vouchers: result.vouchers.map((v) => ({
        word: v.word,
        date: v.date,
        lines: v.lines.map((l) => ({
          summary: l.summary,
          accountCode: l.accountCode,
          accountName: l.accountName,
          debit: l.debit === 0 ? null : Number(formatYuan(l.debit)),
          credit: l.credit === 0 ? null : Number(formatYuan(l.credit)),
          auxiliary: [
            l.auxiliary?.department,
            l.auxiliary?.customer,
            l.auxiliary?.supplier,
            l.auxiliary?.employee,
          ].filter((x) => x !== undefined && x !== '').join(' / '),
        })),
      })),
      documents: result.documents.map((d) => ({
        kind: SOURCE_KIND_LABEL[d.kind],
        date: d.date ?? '',
        summary: d.summary,
        counterparty: d.counterparty ?? '',
        amount: formatYuan(d.amount),
        direction: d.direction === 'in' ? '收' : d.direction === 'out' ? '付' : '—',
        file: d.source.file.replace(/^.*web-runs[\\/]/, ''),
        row: d.source.row ?? null,
      })),
      trialBalance: [...trial.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([code, b]) => ({
          accountCode: code,
          accountName: b.name,
          debit: formatYuan(b.debit),
          credit: formatYuan(b.credit),
          balance: formatYuan(b.debit - b.credit),
        })),
    };

    runs.set(runId, webRun);
    // 只保留最近 20 次运行，避免内存无限增长
    if (runs.size > 20) {
      const oldest = [...runs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest !== undefined) runs.delete(oldest.id);
    }

    json(res, 200, { runId, ...webRun, outputPath: undefined });
  } catch (err) {
    json(res, 500, { error: `处理失败：${(err as Error).message}` });
  }
}

async function handleDownload(res: ServerResponse, runId: string): Promise<void> {
  const webRun = runs.get(runId);
  if (webRun === undefined) {
    json(res, 404, { error: '该记账任务不存在或已过期，请重新生成' });
    return;
  }
  const data = await readFile(webRun.outputPath);
  const name = `记账凭证-${new Date(webRun.createdAt).toISOString().slice(0, 10)}.xlsx`;
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': data.length,
    'Content-Disposition': `attachment; filename="vouchers.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  res.end(data);
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'POST' && path === '/api/process') {
    await handleProcess(req, res);
    return;
  }

  if (req.method === 'GET' && path === '/api/download') {
    await handleDownload(res, url.searchParams.get('runId') ?? '');
    return;
  }

  if (req.method === 'GET' && path === '/api/config') {
    try {
      const config = loadConfig();
      json(res, 200, {
        voucherWord: config.settings.voucherWord,
        currency: config.settings.currency,
        companyNames: config.settings.companyNames,
        expenseCreditAccount: config.settings.expenseCreditAccount,
        suspenseAccount: config.settings.suspenseAccount,
        accountCount: config.accounts.accounts.length,
        ruleCount: config.rules.rules.length,
        ruleFiles: config.rules.files,
        dedupEnabled: config.dedup.enabled,
        warning:
          config.settings.companyNames.length === 0
            ? '尚未配置本企业名称（config/settings.yaml 的 companyNames），发票将无法判断进项/销项'
            : null,
      });
    } catch (err) {
      json(res, 500, { error: err instanceof ConfigError ? err.message : String(err) });
    }
    return;
  }

  if (req.method === 'GET') {
    if (await serveStatic(res, path)) return;
  }

  json(res, 404, { error: `未知路径：${req.method ?? 'GET'} ${path}` });
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'h' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help === true) {
    console.log('用法：node src/web/server.ts [--port 8787] [--host 127.0.0.1]');
    return;
  }

  const port = Number(values.port ?? 8787);
  const host = values.host ?? '127.0.0.1';

  await mkdir(WORK_DIR, { recursive: true });

  // 启动时先校验配置，避免用户上传完文件才发现科目表写错了
  try {
    const config = loadConfig();
    console.log(`✓ 会计科目 ${config.accounts.accounts.length} 个，记账规则 ${config.rules.rules.length} 条`);
    if (config.settings.companyNames.length === 0) {
      console.warn('! 尚未配置 companyNames（本企业名称），发票无法判断进项/销项');
    }
  } catch (err) {
    console.error(`✗ 配置校验失败：${err instanceof ConfigError ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      console.error('请求处理异常：', err);
      if (!res.headersSent) json(res, 500, { error: String(err) });
      else res.end();
    });
  });

  server.listen(port, host, () => {
    console.log('');
    console.log(`会计自动化记账 Web 界面已启动：http://${host}:${port}`);
    console.log('按 Ctrl+C 停止服务。');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`✗ 端口 ${port} 已被占用，请用 --port 指定其它端口。`);
    } else {
      console.error(`✗ 服务启动失败：${err.message}`);
    }
    process.exitCode = 1;
  });

  const shutdown = (): void => {
    console.log('\n正在停止服务…');
    server.close(() => {
      void rm(WORK_DIR, { recursive: true, force: true }).then(() => process.exit(0));
    });
    // 兜底：2 秒内没关干净就强制退出
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
