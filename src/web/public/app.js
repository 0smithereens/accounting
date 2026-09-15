/* ==========================================================================
   会计自动化记账 Web 界面 — 前端逻辑
   无框架、无构建步骤：直接读文件 → base64 → POST /api/process → 渲染结果。
   所有渲染都用 DOM API + textContent，不使用 innerHTML 拼接数据，避免 XSS。
   ========================================================================== */

'use strict';

const state = {
  files: [],          // { file: File, id: string }
  run: null,          // 最近一次成功的结果
  issueFilters: { error: true, warning: true, info: false },
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 创建元素并设置文本（安全，不解析 HTML）。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function showError(message) {
  const box = $('errorBox');
  box.textContent = message;
  box.classList.remove('hidden');
}

function clearError() {
  $('errorBox').classList.add('hidden');
  $('errorBox').textContent = '';
}

function setProgress(visible) {
  $('progress').classList.toggle('hidden', !visible);
  $('runBtn').disabled = visible || state.files.length === 0;
}

/* ------------------------------------------------------------------ */
/* 配置信息                                                            */
/* ------------------------------------------------------------------ */

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (!res.ok) throw new Error(cfg.error || '配置读取失败');

    $('configLine').textContent =
      `科目 ${cfg.accountCount} 个 · 记账规则 ${cfg.ruleCount} 条 · 凭证字「${cfg.voucherWord}」 · 本位币 ${cfg.currency}`;

    if (cfg.warning) {
      const badge = $('configWarn');
      badge.textContent = `⚠ ${cfg.warning}`;
      badge.classList.remove('hidden');
    }
  } catch (err) {
    $('configLine').textContent = '配置读取失败';
    showError(`无法读取服务端配置：${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 文件选择                                                            */
/* ------------------------------------------------------------------ */

const ACCEPTED = ['.xlsx', '.xlsm', '.xls', '.csv', '.tsv', '.txt', '.docx', '.docm'];

function isAccepted(name) {
  const lower = name.toLowerCase();
  return ACCEPTED.some((ext) => lower.endsWith(ext));
}

function addFiles(fileList) {
  clearError();
  const rejected = [];

  for (const file of fileList) {
    if (!isAccepted(file.name)) {
      rejected.push(file.name);
      continue;
    }
    const duplicate = state.files.some(
      (f) => f.file.name === file.name && f.file.size === file.size,
    );
    if (duplicate) continue;

    state.files.push({ file, id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}` });
  }

  if (rejected.length > 0) {
    showError(`以下文件类型不支持，已忽略：\n${rejected.join('\n')}\n\n支持：${ACCEPTED.join(' ')}`);
  }

  renderFileList();
}

function removeFile(id) {
  state.files = state.files.filter((f) => f.id !== id);
  renderFileList();
}

function renderFileList() {
  const list = $('fileList');
  list.replaceChildren();

  for (const entry of state.files) {
    const li = el('li');
    li.append(el('span', 'fname', entry.file.name));
    li.append(el('span', 'fsize', formatBytes(entry.file.size)));

    const removeBtn = el('button', null, '✕');
    removeBtn.type = 'button';
    removeBtn.title = '移除';
    removeBtn.setAttribute('aria-label', `移除 ${entry.file.name}`);
    removeBtn.addEventListener('click', () => removeFile(entry.id));
    li.append(removeBtn);

    list.append(li);
  }

  $('runBtn').disabled = state.files.length === 0;
  $('clearBtn').disabled = state.files.length === 0;
}

/* ------------------------------------------------------------------ */
/* 提交处理                                                            */
/* ------------------------------------------------------------------ */

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('文件读取结果异常'));
        return;
      }
      // data:...;base64,XXXX → 取逗号后面的部分
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function runAccounting() {
  if (state.files.length === 0) return;

  clearError();
  setProgress(true);
  $('resultSection').classList.add('hidden');

  const started = performance.now();

  try {
    const files = await Promise.all(
      state.files.map(async (entry) => ({
        name: entry.file.name,
        data: await fileToBase64(entry.file),
      })),
    );

    const payload = {
      files,
      kind: $('kind').value,
      dedup: $('dedup').checked,
      autoBalance: $('autoBalance').checked,
    };
    const period = $('period').value;
    if (period) payload.period = period;

    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `服务返回 ${res.status}`);

    state.run = data;
    renderResult(data, Math.round(performance.now() - started));
  } catch (err) {
    showError(`记账失败：${err.message}`);
  } finally {
    setProgress(false);
  }
}

/* ------------------------------------------------------------------ */
/* 结果渲染                                                            */
/* ------------------------------------------------------------------ */

function statCard(label, value, unit, tone) {
  const card = el('div', `stat${tone ? ` ${tone}` : ''}`);
  card.append(el('div', 'k', label));
  const v = el('div', 'v', value);
  if (unit) v.append(el('span', 'u', unit));
  card.append(v);
  return card;
}

function renderResult(run, clientMs) {
  const s = run.stats;
  const errors = run.issues.filter((i) => i.level === 'error').length;
  const warnings = run.issues.filter((i) => i.level === 'warning').length;
  const infos = run.issues.filter((i) => i.level === 'info').length;

  const grid = $('statsGrid');
  grid.replaceChildren();

  grid.append(statCard('识别单据', s.documents, '条'));
  grid.append(statCard('生成凭证', s.vouchers, '张'));
  grid.append(
    statCard('借贷平衡', `${s.balanced}/${s.vouchers}`, '', s.balanced === s.vouchers ? 'ok' : 'bad'),
  );
  grid.append(
    statCard('试算平衡', s.trialBalanced ? '平衡' : '不平衡', '', s.trialBalanced ? 'ok' : 'bad'),
  );
  grid.append(statCard('借方发生额', s.totalDebitGrouped, '元'));
  grid.append(statCard('贷方发生额', s.totalCreditGrouped, '元'));

  if (s.duplicates > 0) grid.append(statCard('去重跳过', s.duplicates, '条', 'info'));
  if (errors > 0) grid.append(statCard('错误', errors, '条', 'bad'));
  if (warnings > 0) grid.append(statCard('警告', warnings, '条', 'warn'));

  grid.append(statCard('耗时', `${s.elapsedMs} ms`, `（含上传 ${clientMs} ms）`, 'info'));

  // 文件识别结果
  if (Array.isArray(s.fileResults) && s.fileResults.length > 0) {
    const card = el('div', 'stat info');
    card.style.gridColumn = '1 / -1';
    card.append(el('div', 'k', '文件识别结果'));
    const lines = s.fileResults.map(
      (f) => `${f.file} → ${f.kind}${f.sheet ? `（工作表「${f.sheet}」）` : ''}，${f.documents} 条`,
    );
    const box = el('div', 'small-cell');
    box.style.marginTop = '4px';
    box.style.whiteSpace = 'pre-wrap';
    box.textContent = lines.join('\n');
    card.append(box);
    grid.append(card);
  }

  renderVouchers(run.vouchers);
  renderDocuments(run.documents);
  renderTrial(run.trialBalance);
  renderIssues(run.issues);

  const pill = $('issueCount');
  pill.textContent = String(run.issues.length);
  pill.className = `pill${errors > 0 ? ' has-error' : warnings > 0 ? ' has-warn' : ''}`;

  $('resultSection').classList.remove('hidden');
  $('downloadBtn').onclick = () => {
    window.location.href = `/api/download?runId=${encodeURIComponent(run.runId)}`;
  };
  $('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function tableHeader(columns) {
  const thead = el('thead');
  const tr = el('tr');
  for (const col of columns) {
    const th = el('th', col.num ? 'num' : null, col.label);
    tr.append(th);
  }
  thead.append(tr);
  return thead;
}

function emptyRow(colspan, message) {
  const tr = el('tr', 'empty-row');
  const td = el('td', null, message);
  td.colSpan = colspan;
  tr.append(td);
  return tr;
}

/* ---------------------------- 记账凭证 ---------------------------- */

function renderVouchers(vouchers) {
  const table = $('voucherTable');
  const columns = [
    { label: '凭证字号' }, { label: '日期' }, { label: '摘要' },
    { label: '科目编码' }, { label: '科目名称' },
    { label: '借方金额', num: true }, { label: '贷方金额', num: true },
    { label: '辅助核算' }, { label: '来源' },
  ];

  table.replaceChildren(tableHeader(columns));
  const tbody = el('tbody');

  if (vouchers.length === 0) {
    tbody.append(emptyRow(columns.length, '没有生成任何凭证，请查看「问题与待办」'));
  }

  for (const [vIndex, voucher] of vouchers.entries()) {
    let debitTotal = 0;
    let creditTotal = 0;

    voucher.lines.forEach((line, lIndex) => {
      debitTotal += line.debit || 0;
      creditTotal += line.credit || 0;

      const tr = el('tr');
      if (lIndex === 0 && vIndex > 0) tr.classList.add('voucher-start');

      tr.append(el('td', 'mono', lIndex === 0 ? voucher.word : ''));
      tr.append(el('td', 'mono', lIndex === 0 ? voucher.date : ''));
      tr.append(el('td', null, line.summary));
      tr.append(el('td', 'mono', line.accountCode));
      tr.append(el('td', null, line.accountName));
      tr.append(el('td', 'num debit', line.debit !== null ? line.debit.toFixed(2) : ''));
      tr.append(el('td', 'num credit', line.credit !== null ? line.credit.toFixed(2) : ''));
      tr.append(el('td', 'small-cell dim', line.auxiliary || ''));
      tr.append(el('td', 'small-cell dim', lIndex === 0 ? voucher.lines.length + ' 行' : ''));

      tbody.append(tr);
    });

    const balanced = Math.abs(debitTotal - creditTotal) < 0.005;
    const sub = el('tr', `voucher-subtotal${balanced ? '' : ' unbalanced'}`);
    sub.append(el('td'));
    sub.append(el('td'));
    sub.append(el('td', null, `本凭证合计（${balanced ? '借贷平衡' : '★借贷不平★'}）`));
    sub.append(el('td'));
    sub.append(el('td'));
    sub.append(el('td', 'num', debitTotal.toFixed(2)));
    sub.append(el('td', 'num', creditTotal.toFixed(2)));
    sub.append(el('td'));
    sub.append(el('td'));
    tbody.append(sub);
  }

  table.append(tbody);
  applyVoucherFilter();
}

function applyVoucherFilter() {
  const keyword = $('voucherFilter').value.trim().toLowerCase();
  const onlyIssue = $('onlyIssue').checked;
  const rows = [...$('voucherTable').querySelectorAll('tbody tr')];

  // 先按当前筛选条件重建「可见的凭证块」
  let visible = true;
  for (const row of rows) {
    if (row.classList.contains('voucher-subtotal')) {
      row.classList.toggle('hidden', !visible);
      continue;
    }
    if (row.classList.contains('voucher-start') || row === rows[0]) visible = true;

    const text = row.textContent.toLowerCase();
    let match = keyword === '' || text.includes(keyword);
    if (match && onlyIssue) {
      // 只看有警示的凭证：保留含「系统配平」或「★」的行
      match = row.textContent.includes('★') || row.textContent.includes('系统配平');
    }
    row.classList.toggle('hidden', !match);
    if (!match) visible = false;
  }
}

/* ---------------------------- 单据台账 ---------------------------- */

function renderDocuments(documents) {
  const table = $('docTable');
  const columns = [
    { label: '单据类型' }, { label: '日期' }, { label: '摘要' }, { label: '往来单位' },
    { label: '金额', num: true }, { label: '方向' }, { label: '来源文件' }, { label: '行号', num: true },
  ];

  table.replaceChildren(tableHeader(columns));
  const tbody = el('tbody');

  if (documents.length === 0) {
    tbody.append(emptyRow(columns.length, '没有识别到任何单据'));
  }

  for (const doc of documents) {
    const tr = el('tr');
    tr.append(el('td', null, doc.kind));
    tr.append(el('td', 'mono', doc.date));
    tr.append(el('td', null, doc.summary));
    tr.append(el('td', null, doc.counterparty));
    tr.append(el('td', 'num', Number(doc.amount).toFixed(2)));
    const dirCell = el('td', null, doc.direction);
    if (doc.direction === '收') dirCell.style.color = 'var(--ok)';
    if (doc.direction === '付') dirCell.style.color = 'var(--danger)';
    tr.append(dirCell);
    tr.append(el('td', 'small-cell dim', doc.file));
    tr.append(el('td', 'num dim', doc.row === null ? '' : doc.row));
    tbody.append(tr);
  }

  table.append(tbody);
  applyDocFilter();
}

function applyDocFilter() {
  const keyword = $('docFilter').value.trim().toLowerCase();
  const rows = [...$('docTable').querySelectorAll('tbody tr')];
  for (const row of rows) {
    const match = keyword === '' || row.textContent.toLowerCase().includes(keyword);
    row.classList.toggle('hidden', !match);
  }
}

/* ---------------------------- 科目汇总表 ---------------------------- */

function renderTrial(rows) {
  const table = $('trialTable');
  const columns = [
    { label: '科目编码' }, { label: '科目名称' },
    { label: '借方发生额', num: true }, { label: '贷方发生额', num: true },
    { label: '余额（借正贷负）', num: true }, { label: '方向' },
  ];

  table.replaceChildren(tableHeader(columns));
  const tbody = el('tbody');

  let totalDebit = 0;
  let totalCredit = 0;

  if (rows.length === 0) {
    tbody.append(emptyRow(columns.length, '暂无科目发生额'));
  }

  for (const row of rows) {
    const debit = Number(row.debit);
    const credit = Number(row.credit);
    const balance = Number(row.balance);
    totalDebit += debit;
    totalCredit += credit;

    const tr = el('tr');
    tr.append(el('td', 'mono', row.accountCode));
    tr.append(el('td', null, row.accountName));
    tr.append(el('td', 'num debit', debit === 0 ? '' : debit.toFixed(2)));
    tr.append(el('td', 'num credit', credit === 0 ? '' : credit.toFixed(2)));
    tr.append(el('td', 'num', balance.toFixed(2)));
    tr.append(el('td', null, balance > 0 ? '借' : balance < 0 ? '贷' : '平'));
    tbody.append(tr);
  }

  if (rows.length > 0) {
    const balanced = Math.abs(totalDebit - totalCredit) < 0.005;
    const tr = el('tr', `voucher-subtotal${balanced ? '' : ' unbalanced'}`);
    tr.append(el('td', null, '合计'));
    tr.append(el('td'));
    tr.append(el('td', 'num', totalDebit.toFixed(2)));
    tr.append(el('td', 'num', totalCredit.toFixed(2)));
    tr.append(el('td', 'num', (totalDebit - totalCredit).toFixed(2)));
    tr.append(el('td', null, balanced ? '试算平衡' : '★不平衡★'));
    tbody.append(tr);
  }

  table.append(tbody);
}

/* ---------------------------- 问题与待办 ---------------------------- */

const LEVEL_LABEL = { error: '错误', warning: '警告', info: '提示' };

function renderIssues(issues) {
  const table = $('issueTable');
  const columns = [
    { label: '级别' }, { label: '说明' }, { label: '来源文件' }, { label: '行号', num: true },
  ];

  table.replaceChildren(tableHeader(columns));
  const tbody = el('tbody');

  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort(
    (a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9) || a.file.localeCompare(b.file),
  );

  if (sorted.length === 0) {
    tbody.append(emptyRow(columns.length, '没有需要处理的问题 🎉'));
  }

  for (const issue of sorted) {
    const tr = el('tr', `level-${issue.level}`);
    tr.dataset.level = issue.level;
    tr.append(el('td', `level-tag ${issue.level}`, LEVEL_LABEL[issue.level] ?? issue.level));
    tr.append(el('td', null, issue.message));
    tr.append(el('td', 'small-cell dim', issue.file));
    tr.append(el('td', 'num dim', issue.row === undefined ? '' : issue.row));
    tbody.append(tr);
  }

  table.append(tbody);
  applyIssueFilter();
}

function applyIssueFilter() {
  const rows = [...$('issueTable').querySelectorAll('tbody tr[data-level]')];
  for (const row of rows) {
    const level = row.dataset.level;
    row.classList.toggle('hidden', !state.issueFilters[level]);
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  const dropzone = $('dropzone');
  const input = $('fileInput');

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });

  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';   // 允许再次选择同名文件
  });

  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  }
  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) addFiles(files);
  });

  // 阻止把文件拖到页面其它地方时浏览器直接打开它
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('runBtn').addEventListener('click', runAccounting);
  $('clearBtn').addEventListener('click', () => {
    state.files = [];
    state.run = null;
    renderFileList();
    $('resultSection').classList.add('hidden');
    clearError();
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
      for (const p of document.querySelectorAll('.tab-panel')) p.classList.remove('active');
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  }

  $('voucherFilter').addEventListener('input', applyVoucherFilter);
  $('onlyIssue').addEventListener('change', applyVoucherFilter);
  $('docFilter').addEventListener('input', applyDocFilter);

  for (const [level, id] of [
    ['error', 'issueLevelError'],
    ['warning', 'issueLevelWarning'],
    ['info', 'issueLevelInfo'],
  ]) {
    $(id).addEventListener('change', (e) => {
      state.issueFilters[level] = e.target.checked;
      applyIssueFilter();
    });
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

bindEvents();
renderFileList();
void loadConfig();
