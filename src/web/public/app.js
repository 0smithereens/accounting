/* ==========================================================================
   账有律 · 会计合规工作台 — 前端逻辑
   纯原生 ES2022，无框架、无构建步骤。所有金额字符串均由服务端格式化。
   说明：本文件使用 hash 路由（#/workbench …），所有动态文本经 esc() 转义。
   ========================================================================== */

'use strict';

/* ============================ 常量 ============================ */

const PAGES = {
  workbench: { title: '工作台', subtitle: '上传单据，完成月结、审核、报表与申报草稿' },
  bookkeeping: { title: '记账', subtitle: '凭证、单据与处理问题总览' },
  review: { title: '审核', subtitle: '六层合规检查、整改建议与法规依据' },
  statements: { title: '报表', subtitle: '四张财务报表的勾稽校验与财务分析' },
  tax: { title: '报税', subtitle: '申报草稿、税种导航与税会智链（不向税务机关提交）' },
  policy: { title: '政策库', subtitle: '政策检索、关联关系与版本族' },
  audit: { title: '审计', subtitle: '哈希链完整性验证与操作留痕' },
};

const SEVERITY = {
  error: { label: '错误', cls: 'danger' },
  warning: { label: '警告', cls: 'warning' },
  info: { label: '提示', cls: 'info' },
};

const RATING = {
  good: { label: '良好', cls: 'good' },
  watch: { label: '关注', cls: 'watch' },
  bad: { label: '异常', cls: 'bad' },
  unknown: { label: '暂无', cls: 'unknown' },
};

const RATIO_GROUPS = {
  solvency: '偿债能力',
  operation: '营运能力',
  profitability: '盈利能力',
  growth: '成长能力',
  cashflow: '现金流',
  quality: '质量',
};

const LIFECYCLE = {
  effective: { label: '现行有效', cls: 'success' },
  amended: { label: '已修订', cls: 'info' },
  superseded: { label: '已被替代', cls: 'warning' },
  repealed: { label: '已废止', cls: 'muted' },
  draft: { label: '草案', cls: 'muted' },
};

const RELATION_TYPES = {
  amends: '修改',
  supersedes: '替代',
  repeals: '废止',
  based_on: '制定依据',
  implements: '贯彻落实',
  parallel: '关联平行',
};

const LEVEL_LABEL = { central: '中央', local: '地方' };

const FILING_CYCLE = { monthly: '按月', quarterly: '按季', annual: '按年' };

const TAXPAYER_KIND = { small_scale: '小规模纳税人', general: '一般纳税人' };

const TAX_FALLBACK = {
  vat: '增值税', consumption: '消费税', cit: '企业所得税', iit: '个人所得税',
  surcharge: '附加税费', stamp: '印花税', property: '房产税', urban_land: '城镇土地使用税',
  land_vat: '土地增值税', deed: '契税', vehicle_purchase: '车辆购置税',
  vehicle_vessel: '车船税', resource: '资源税', environmental: '环境保护税',
  urban_construction: '城市维护建设税', tariff: '关税', farmland: '耕地占用税',
  tobacco: '烟叶税', tonnage: '船舶吨税',
};

const ACCEPT_EXT = ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'txt', 'docx', 'docm'];
const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;
const MAX_FILES = 30;
const CLOSE_STEPS = ['读取单据文件', '识别单据类型', '生成记账凭证', '编制财务报表', '计算申报草稿', '执行合规审核'];

/* ============================ 工具 ============================ */

const $ = function (id) { return document.getElementById(id); };

/** 转义所有动态文本，禁止未转义数据进入 innerHTML。 */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}

function isPeriod(value) {
  if (typeof value !== 'string' || value.length !== 7 || value.charAt(4) !== '-') return false;
  const head = value.slice(0, 4);
  const tail = value.slice(5);
  for (let i = 0; i < 4; i++) if (head.charAt(i) < '0' || head.charAt(i) > '9') return false;
  for (let i = 0; i < 2; i++) if (tail.charAt(i) < '0' || tail.charAt(i) > '9') return false;
  return true;
}

function currentPeriod() {
  const d = new Date();
  return String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return String(d.getFullYear()) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function scoreMeta(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return { cls: 'is-watch', grade: '暂无评分' };
  if (n >= 85) return { cls: 'is-good', grade: '优秀' };
  if (n >= 70) return { cls: 'is-accent', grade: '良好' };
  if (n >= 60) return { cls: 'is-watch', grade: '及格' };
  return { cls: 'is-danger', grade: '需整改' };
}

function badge(text, cls) {
  return '<span class="badge ' + (cls || 'badge-soft') + '">' + esc(text) + '</span>';
}

function severityBadge(severity) {
  const s = SEVERITY[severity] || SEVERITY.info;
  return badge(s.label, 'badge-' + s.cls);
}

function rating(rate) {
  return RATING[rate] || RATING.unknown;
}

function taxLabel(code) {
  if (!code) return '—';
  const list = state.taxNav || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].taxType === code) return list[i].label;
  }
  return TAX_FALLBACK[code] || String(code);
}

function relationLabel(type) {
  return RELATION_TYPES[type] || String(type || '关联');
}

function lifecycleBadge(code) {
  const l = LIFECYCLE[code] || { label: code || '未知', cls: 'muted' };
  return badge(l.label, 'badge-' + l.cls);
}

function scoreRingHtml(value) {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  const meta = scoreMeta(n);
  const r = 54;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - n / 100);
  return '<div class="score-ring ' + meta.cls + '" role="img" aria-label="合规得分 ' + esc(fmtScore(n)) + ' 分">' +
    '<svg viewBox="0 0 120 120" aria-hidden="true">' +
      '<circle class="ring-bg" cx="60" cy="60" r="' + r + '"></circle>' +
      '<circle class="ring-fg" cx="60" cy="60" r="' + r + '" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '"></circle>' +
    '</svg>' +
    '<div class="score-text"><span class="score-num">' + esc(fmtScore(n)) + '</span><span class="score-unit">/ 100 分</span><span class="score-grade">' + esc(meta.grade) + '</span></div>' +
  '</div>';
}

function readFileAsDataUrl(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result)); };
    reader.onerror = function () { reject(new Error('读取文件「' + file.name + '」失败，请确认文件未被其他程序占用')); };
    reader.readAsDataURL(file);
  });
}

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
}

function extOf(name) {
  const idx = String(name).lastIndexOf('.');
  if (idx < 0) return '';
  return String(name).slice(idx + 1).toLowerCase();
}

function emptyState(title, text, actionLabel, action) {
  const button = actionLabel && action
    ? '<div class="state-actions"><button type="button" class="btn btn-primary" data-action="' + esc(action) + '">' + esc(actionLabel) + '</button></div>'
    : '';
  return '<div class="state-card"><div class="state-icon" aria-hidden="true">◎</div><div class="state-title">' + esc(title) + '</div>' +
    '<p class="state-text">' + esc(text) + '</p>' + button + '</div>';
}

function errorState(message, retryAction) {
  return '<div class="error-card"><div class="error-title"><span aria-hidden="true">!</span>加载失败</div>' +
    '<p class="error-text">' + esc(message || '未知错误') + '</p>' +
    (retryAction ? '<button type="button" class="btn btn-ghost btn-sm" data-action="' + esc(retryAction) + '">重新加载</button>' : '') +
  '</div>';
}

function loadingState(text) {
  return '<div class="loading-inline"><span class="spinner" aria-hidden="true"></span><span>' + esc(text || '正在加载…') + '</span></div>';
}

function skeletonCard(lines) {
  let html = '<div class="skeleton-card">';
  for (let i = 0; i < (lines || 4); i++) {
    html += '<div class="skeleton-line ' + (i === 0 ? 'w40' : i === 1 ? 'w80' : 'w60') + '"></div>';
  }
  return html + '</div>';
}

function highlight(text, query) {
  const raw = String(text === null || text === undefined ? '' : text);
  const q = String(query || '').trim();
  if (q === '') return esc(raw);
  const lower = raw.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx < 0) return esc(raw);
  return esc(raw.slice(0, idx)) + '<mark>' + esc(raw.slice(idx, idx + q.length)) + '</mark>' + esc(raw.slice(idx + q.length));
}

/* ============================ 状态 ============================ */

const state = {
  page: 'workbench',
  meta: null,
  metaStatus: 'idle',
  metaError: '',
  period: currentPeriod(),
  standard: 'cas',
  files: [],
  close: null,
  closeStatus: 'idle',
  closeError: '',
  closeStep: 0,
  closeReadText: '',
  closeStartedAt: 0,
  closeTimer: null,
  voucherQuery: '',
  reviewFilter: { severity: 'all', category: 'all', blockingOnly: false },
  statementTab: null,
  taxTab: 'returns',
  taxNav: null,
  taxNavStatus: 'idle',
  taxNavError: '',
  chainGroups: null,
  chainStatus: 'idle',
  chainError: '',
  chainEventId: '',
  chainEvent: null,
  chainPolicies: [],
  chainEventStatus: 'idle',
  chainEventError: '',
  policyTab: 'search',
  policyQuery: '',
  policyHits: [],
  policyTotal: 0,
  policyStats: null,
  policyStatus: 'idle',
  policyError: '',
  policyReq: 0,
  graph: null,
  graphStatus: 'idle',
  graphError: '',
  policyTitles: {},
  detailId: '',
  detail: null,
  detailStatus: 'idle',
  detailError: '',
  detailReq: 0,
  audit: null,
  auditStatus: 'idle',
  auditError: '',
  toastTimer: null,
  drawerOpen: false,
  lastFocus: null,
};

let fileSeq = 0;
let policySearchTimer = null;

/* ============================ API ============================ */

function friendlyError(message) {
  const text = String(message === null || message === undefined ? '' : message);
  if (text === '') return '未知错误';
  if (text.indexOf('EPERM') >= 0 || text.indexOf('operation not permitted') >= 0) {
    return '服务端写入失败（权限不足）。请确认输出目录可写后重试。技术信息：' + text;
  }
  if (text.indexOf('ENOENT') >= 0) {
    return '服务端找不到所需文件或目录。技术信息：' + text;
  }
  if (text.indexOf('ENOSPC') >= 0) {
    return '磁盘空间不足，无法写入结果。技术信息：' + text;
  }
  return text;
}

const api = {
  async request(path, options) {
    let response;
    try {
      response = await fetch(path, options);
    } catch (err) {
      throw new Error('无法连接本地记账服务（' + (location.host || '127.0.0.1:8791') + '），请确认服务已启动');
    }
    let text = '';
    try {
      text = await response.text();
    } catch (err) {
      throw new Error('读取服务响应失败，请稍后重试');
    }
    let data = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new Error('服务返回了无法解析的内容（HTTP ' + response.status + '）');
      }
    }
    if (!response.ok) {
      const message = data && data.error ? String(data.error) : '请求失败（HTTP ' + response.status + '）';
      throw new Error(friendlyError(message));
    }
    return data;
  },

  get(path) {
    return this.request(path);
  },

  post(path, body) {
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  meta() { return this.get('/api/meta'); },

  close(payload) { return this.post('/api/close', payload); },

  searchPolicies(q, limit) {
    const size = limit || 200;
    return this.get('/api/policy/search?q=' + encodeURIComponent(q || '') + '&limit=' + encodeURIComponent(String(size)));
  },

  policyGraph() { return this.get('/api/policy/graph'); },

  policy(id) { return this.get('/api/policy/' + encodeURIComponent(id)); },

  taxNavigation() { return this.get('/api/tax/navigation'); },

  chainEvents() { return this.get('/api/tax-chain/events'); },

  chainEvent(id) { return this.get('/api/tax-chain/event?id=' + encodeURIComponent(id)); },

  auditIntegrity() { return this.get('/api/audit/integrity'); },
};

/* ============================ 全局提示 ============================ */

function showError(message) {
  const bar = $('errorBar');
  if (!bar) return;
  const text = $('errorBarText');
  if (text) text.textContent = String(message || '发生未知错误');
  bar.hidden = false;
}

function clearErrorBar() {
  const bar = $('errorBar');
  if (bar) bar.hidden = true;
}

function showToast(message, type) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = String(message || '');
  toast.hidden = false;
  toast.classList.toggle('is-error', type === 'error');
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(function () { toast.hidden = true; }, 4200);
}

/* ============================ 顶栏与元信息 ============================ */

function updateHeader() {
  const meta = state.meta;
  const periodChip = $('periodChip');
  if (periodChip) periodChip.textContent = state.period || '—';

  const standardChip = $('standardChip');
  let label = state.standard === 'small' ? '小企业会计准则' : '企业会计准则';
  if (meta && Array.isArray(meta.standards)) {
    for (let i = 0; i < meta.standards.length; i++) {
      if (meta.standards[i].id === state.standard) { label = meta.standards[i].label; break; }
    }
  }
  if (standardChip) { standardChip.textContent = label; standardChip.title = '当前会计准则：' + label; }

  const companyName = meta && meta.company && meta.company.name ? meta.company.name : '—';
  const companyChip = $('companyChip');
  if (companyChip) { companyChip.textContent = companyName; companyChip.title = companyName; }
  const uploadCompany = $('uploadCompany');
  if (uploadCompany) uploadCompany.textContent = companyName;

  const sideConfig = $('sideConfig');
  if (sideConfig && meta && meta.config) {
    sideConfig.textContent = '科目 ' + meta.config.accountCount + ' · 规则 ' + meta.config.ruleCount;
  }
}

function populateStandards(standards) {
  const select = $('standardSelect');
  if (!select) return;
  select.innerHTML = standards.map(function (s) {
    return '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>';
  }).join('');
  let exists = false;
  for (let i = 0; i < standards.length; i++) if (standards[i].id === state.standard) exists = true;
  if (!exists && standards.length > 0) state.standard = standards[0].id;
  select.value = state.standard;
}

async function loadMeta(force) {
  if (state.metaStatus === 'loading' && !force) return;
  state.metaStatus = 'loading';
  state.metaError = '';
  if (state.page === 'workbench') renderMeta();
  try {
    const data = await api.meta();
    state.meta = data;
    state.metaStatus = 'ready';
    if (!state.standard && data.activeStandard) state.standard = data.activeStandard;
    if (Array.isArray(data.standards) && data.standards.length > 0) {
      populateStandards(data.standards);
      let hasActive = false;
      for (let i = 0; i < data.standards.length; i++) {
        if (data.standards[i].id === (data.activeStandard || '')) hasActive = true;
      }
      if (hasActive && state.close === null && force !== true) state.standard = data.activeStandard;
      const select = $('standardSelect');
      if (select) select.value = state.standard;
    }
    updateHeader();
    if (state.page === 'workbench') renderMeta();
    schedulePrefetch();
  } catch (err) {
    state.metaStatus = 'error';
    state.metaError = err.message || '未知错误';
    showError('读取系统配置失败：' + state.metaError);
    if (state.page === 'workbench') renderMeta();
  }
}

function schedulePrefetch() {
  setTimeout(function () {
    if (state.policyStatus === 'idle') loadPolicySearch('', true);
    if (state.graphStatus === 'idle') loadPolicyGraph();
    if (state.taxNavStatus === 'idle') loadTaxNav();
    if (state.chainStatus === 'idle') loadChainEvents();
  }, 500);
}

/* ============================ 工作台：上传 ============================ */

function fileBadge(name) {
  const ext = extOf(name).toUpperCase();
  return esc(ext.slice(0, 4) || '文件');
}

function renderFileList() {
  const list = $('fileList');
  if (!list) return;
  if (state.files.length === 0) {
    list.innerHTML = '<li class="file-empty">尚未选择文件。建议一次上传同一期间的银行流水、发票台账、报销单与工资表。</li>';
    return;
  }
  list.innerHTML = state.files.map(function (item) {
    return '<li class="file-item">' +
      '<span class="file-badge" aria-hidden="true">' + fileBadge(item.name) + '</span>' +
      '<span class="file-name" title="' + esc(item.name) + '">' + esc(item.name) + '</span>' +
      '<span class="file-size">' + esc(fmtBytes(item.size)) + '</span>' +
      '<button type="button" class="file-remove" data-action="remove-file" data-id="' + esc(item.id) + '" aria-label="移除 ' + esc(item.name) + '">×</button>' +
    '</li>';
  }).join('');
}

function updateUploadControls() {
  const running = state.closeStatus === 'running';
  const start = $('startBtn');
  const clear = $('clearBtn');
  const hint = $('uploadHint');
  if (start) {
    start.disabled = running || state.files.length === 0;
    start.textContent = running ? '月结进行中…' : '开始月结';
  }
  if (clear) clear.disabled = running || state.files.length === 0;
  const periodInput = $('periodInput');
  if (periodInput) periodInput.disabled = running;
  const standardSelect = $('standardSelect');
  if (standardSelect) standardSelect.disabled = running;
  const fileInput = $('fileInput');
  if (fileInput) fileInput.disabled = running;
  const zone = $('dropzone');
  if (zone) zone.classList.toggle('is-busy', running);
  if (hint) {
    if (running) hint.textContent = '正在处理，请稍候…';
    else if (state.files.length === 0) hint.textContent = '请先选择至少一个单据文件';
    else {
      let total = 0;
      for (let i = 0; i < state.files.length; i++) total += state.files[i].size;
      hint.textContent = '已选择 ' + state.files.length + ' 个文件，合计 ' + fmtBytes(total);
    }
  }
}

function addFiles(fileList) {
  if (state.closeStatus === 'running') {
    showToast('月结进行中，请稍候再调整文件', 'error');
    return;
  }
  const incoming = Array.prototype.slice.call(fileList || []);
  if (incoming.length === 0) return;
  const rejected = [];
  const tooBig = [];
  let added = 0;
  for (let i = 0; i < incoming.length; i++) {
    const file = incoming[i];
    if (ACCEPT_EXT.indexOf(extOf(file.name)) < 0) { rejected.push(file.name); continue; }
    if (file.size > MAX_UPLOAD_BYTES) { tooBig.push(file.name); continue; }
    let duplicate = false;
    for (let j = 0; j < state.files.length; j++) {
      const f = state.files[j];
      if (f.name === file.name && f.size === file.size && f.lastModified === file.lastModified) { duplicate = true; break; }
    }
    if (duplicate) continue;
    if (state.files.length >= MAX_FILES) { showToast('一次最多选择 ' + MAX_FILES + ' 个文件，多余文件已忽略', 'error'); break; }
    fileSeq += 1;
    state.files.push({ id: 'f' + fileSeq, name: file.name, size: file.size, lastModified: file.lastModified, file: file });
    added += 1;
  }
  renderFileList();
  updateUploadControls();
  if (added > 0) {
    state.closeError = '';
    renderCloseError();
  }
  if (rejected.length > 0) {
    showToast('已忽略格式不支持的文件：' + rejected.slice(0, 3).join('、') + (rejected.length > 3 ? ' 等' : ''), 'error');
  }
  if (tooBig.length > 0) {
    showToast('以下文件超过 45 MB，无法上传：' + tooBig.slice(0, 2).join('、'), 'error');
  }
}

function removeFile(id) {
  if (state.closeStatus === 'running') {
    showToast('月结进行中，请稍候再调整文件', 'error');
    return;
  }
  state.files = state.files.filter(function (item) { return item.id !== id; });
  renderFileList();
  updateUploadControls();
}

function clearFiles() {
  if (state.closeStatus === 'running') {
    showToast('月结进行中，请稍候再调整文件', 'error');
    return;
  }
  state.files = [];
  const input = $('fileInput');
  if (input) input.value = '';
  renderFileList();
  updateUploadControls();
}

function renderCloseError() {
  const box = $('closeError');
  if (!box) return;
  if (!state.closeError) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<strong>月结未能完成</strong><p>' + esc(state.closeError) + '</p>' +
    '<div class="btn-row" style="margin-top:8px"><button type="button" class="btn btn-danger btn-sm" data-action="start-close">重试月结</button></div>';
}

function renderCloseProgress() {
  const text = $('closeProgressText');
  const steps = $('closeSteps');
  if (text) {
    const label = state.closeReadText || CLOSE_STEPS[state.closeStep] || '处理中';
    text.textContent = state.closeStatus === 'running' ? '正在' + label + '…' : '处理完成';
  }
  if (steps) {
    steps.innerHTML = CLOSE_STEPS.map(function (label, i) {
      let cls = '';
      if (i < state.closeStep) cls = 'done';
      else if (i === state.closeStep) cls = 'active';
      return '<span class="progress-step ' + cls + '">' + esc(label) + '</span>';
    }).join('');
  }
}

function tickClose() {
  const elapsed = Math.floor((Date.now() - state.closeStartedAt) / 1000);
  const el = $('closeElapsed');
  if (el) el.textContent = elapsed + ' 秒';
  if (state.closeReadText !== '') return;
  const target = Math.min(CLOSE_STEPS.length - 1, Math.floor(elapsed / 2));
  if (target > state.closeStep) {
    state.closeStep = target;
    renderCloseProgress();
  }
}

function stopCloseTicker() {
  if (state.closeTimer) {
    clearInterval(state.closeTimer);
    state.closeTimer = null;
  }
}

async function runMonthClose() {
  if (state.closeStatus === 'running') return;
  if (state.files.length === 0) {
    showError('请先选择至少一个单据文件，再开始月结。');
    return;
  }
  if (!isPeriod(state.period)) {
    showError('请选择有效的会计期间（格式 YYYY-MM）。');
    return;
  }
  let total = 0;
  for (let i = 0; i < state.files.length; i++) total += state.files[i].size;
  if (total > MAX_UPLOAD_BYTES) {
    showError('所选文件合计 ' + fmtBytes(total) + '，超过 45 MB 上限，请拆分成更小的批次。');
    return;
  }

  state.closeStatus = 'running';
  state.closeError = '';
  state.closeStep = 0;
  state.closeReadText = '';
  state.closeStartedAt = Date.now();
  clearErrorBar();
  const progress = $('closeProgress');
  if (progress) progress.hidden = false;
  const elapsedLabel = $('closeElapsed');
  if (elapsedLabel) elapsedLabel.textContent = '0 秒';
  const errorBox = $('closeError');
  if (errorBox) { errorBox.hidden = true; errorBox.innerHTML = ''; }
  renderCloseProgress();
  updateUploadControls();
  if (state.closeTimer) clearInterval(state.closeTimer);
  state.closeTimer = setInterval(tickClose, 450);

  try {
    const payloadFiles = [];
    for (let i = 0; i < state.files.length; i++) {
      state.closeReadText = '读取并编码文件 ' + (i + 1) + ' / ' + state.files.length;
      renderCloseProgress();
      const dataUrl = await readFileAsDataUrl(state.files[i].file);
      payloadFiles.push({ name: state.files[i].name, dataUrl: dataUrl });
    }
    state.closeReadText = '';
    state.closeStep = Math.max(state.closeStep, 1);
    renderCloseProgress();

    const dto = await api.close({
      period: state.period,
      standard: state.standard,
      files: payloadFiles,
    });

    state.close = dto;
    state.closeStatus = 'done';
    state.closeError = '';
    if (dto.period && isPeriod(dto.period)) state.period = dto.period;
    if (dto.standard) state.standard = dto.standard;
    const periodInput = $('periodInput');
    if (periodInput) periodInput.value = state.period;
    const select = $('standardSelect');
    if (select && dto.standard) select.value = dto.standard;
    if (dto.statements && dto.statements.length > 0) state.statementTab = dto.statements[0].kind;
    else state.statementTab = null;
    state.reviewFilter = { severity: 'all', category: 'all', blockingOnly: false };
    state.voucherQuery = '';
    updateHeader();
    renderWorkbenchResult();
    if (state.page === 'workbench') renderMeta();
    const count = dto.stats ? dto.stats.vouchers : 0;
    const taxCount = dto.taxReturns ? dto.taxReturns.length : 0;
    showToast('月结完成：' + count + ' 张凭证、' + taxCount + ' 份申报草稿');
  } catch (err) {
    state.closeStatus = 'error';
    state.closeError = err && err.message ? err.message : '未知错误';
    renderCloseError();
    showError('月结失败：' + state.closeError);
  } finally {
    stopCloseTicker();
    state.closeReadText = '';
    if (progress) progress.hidden = true;
    updateUploadControls();
  }
}

/* ============================ 工作台：结果 ============================ */

function renderWorkbenchResult() {
  const box = $('wbResult');
  if (!box) return;
  const dto = state.close;
  if (!dto) { box.innerHTML = ''; return; }
  const stats = dto.stats || {};
  const findings = dto.findings || [];
  const taxReturns = dto.taxReturns || [];
  const blockers = dto.blockers || [];
  const degradations = dto.degradations || [];
  const score = Number(stats.score);

  let errors = 0, warnings = 0, infos = 0;
  for (let i = 0; i < findings.length; i++) {
    if (findings[i].severity === 'error') errors += 1;
    else if (findings[i].severity === 'warning') warnings += 1;
    else infos += 1;
  }

  const blockerHtml = blockers.length > 0
    ? '<div class="card blocker-card"><div class="blocker-head"><span class="blocker-count">' + blockers.length + '</span><h2>阻断项</h2><span class="hint">未处理完不得结账</span></div>' +
      '<ul class="blocker-list">' + blockers.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul></div>'
    : '<div class="card"><div class="ok-panel"><span class="ok-panel-icon" aria-hidden="true">✓</span><div><strong>无阻断项</strong><p>本次月结可以进入人工复核；仍建议逐条处理警告与提示。</p></div></div></div>';

  const degradationHtml = degradations.length > 0
    ? '<div class="card"><div class="warn-panel"><strong>运行降级（' + degradations.length + ' 项）</strong><ul>' +
      degradations.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul></div></div>'
    : '';

  box.innerHTML =
    '<div class="card result-card">' +
      '<div class="result-head">' +
        '<div><div class="result-title"><span class="dot dot-ok" aria-hidden="true"></span>月结完成</div>' +
          '<p class="result-sub">' + esc(dto.period) + ' · ' + esc(dto.standardLabel || '') + ' · 完成于 ' + esc(fmtDateTime(dto.finishedAt)) + '</p>' +
        '</div>' +
        '<div class="result-actions">' +
          '<button type="button" class="btn btn-primary" data-action="export-monthly">导出月结报告（Markdown）</button>' +
          '<a class="btn btn-ghost" href="#/review">查看审核结论</a>' +
        '</div>' +
      '</div>' +
      '<div class="result-hero">' +
        '<div>' + scoreRingHtml(score) + '</div>' +
        '<div class="kpi-grid">' +
          '<div class="kpi"><div class="kpi-label">凭证数</div><div class="kpi-value">' + esc(stats.vouchers) + '<small>张</small></div><div class="kpi-sub">单据 ' + esc(stats.documents) + ' 张</div></div>' +
          '<div class="kpi"><div class="kpi-label">借方合计</div><div class="kpi-value">' + esc(stats.totalDebit || '0.00') + '<small>元</small></div><div class="kpi-sub">本期全部凭证</div></div>' +
          '<div class="kpi"><div class="kpi-label">阻断项</div><div class="kpi-value ' + (blockers.length > 0 ? 'danger' : 'success') + '">' + blockers.length + '<small>项</small></div><div class="kpi-sub">错误 ' + errors + ' · 警告 ' + warnings + '</div></div>' +
          '<div class="kpi"><div class="kpi-label">申报草稿</div><div class="kpi-value">' + taxReturns.length + '<small>份</small></div><div class="kpi-sub">待人工复核申报</div></div>' +
          '<div class="kpi"><div class="kpi-label">审核结论</div><div class="kpi-value">' + findings.length + '<small>条</small></div><div class="kpi-sub">提示 ' + infos + ' 条</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="result-links">' +
        '<a class="btn btn-soft btn-sm" href="#/bookkeeping">查看凭证</a>' +
        '<a class="btn btn-soft btn-sm" href="#/statements">查看四张报表</a>' +
        '<a class="btn btn-soft btn-sm" href="#/tax">查看申报草稿</a>' +
        '<a class="btn btn-ghost btn-sm" href="#/policy">检索政策依据</a>' +
        '<span class="hint" style="margin-left:auto">运行编号 ' + esc(String(dto.runId || '').slice(0, 8)) + '</span>' +
      '</div>' +
    '</div>' +
    blockerHtml +
    degradationHtml;
}

/* ============================ 工作台：元信息 ============================ */

function renderMeta() {
  const box = $('wbMeta');
  if (!box) return;
  if (state.metaStatus === 'loading' || state.metaStatus === 'idle') {
    box.innerHTML = '<div class="section-head"><div><h2>准则与主体信息</h2><p>正在读取系统配置…</p></div></div>' +
      '<div class="wb-meta-grid">' + skeletonCard(5) + skeletonCard(4) + '</div>';
    return;
  }
  if (state.metaStatus === 'error') {
    box.innerHTML = '<div class="section-head"><div><h2>准则与主体信息</h2><p>读取失败，请检查服务状态</p></div></div>' +
      '<div class="card">' + errorState(state.metaError, 'retry-meta') + '</div>';
    return;
  }
  const meta = state.meta;
  if (!meta) { box.innerHTML = ''; return; }
  const diffs = Array.isArray(meta.featureDiff) ? meta.featureDiff : [];
  const standards = Array.isArray(meta.standards) ? meta.standards : [];
  const company = meta.company || {};
  const config = meta.config || {};

  const diffRows = diffs.map(function (f) {
    return '<tr><td><strong>' + esc(f.label) + '</strong></td><td>' + esc(f.cas) + '</td><td>' + esc(f.small) + '</td></tr>';
  }).join('');

  const standardCards = standards.map(function (s) {
    const active = s.id === state.standard;
    return '<div class="standard-card' + (active ? ' is-active' : '') + '">' +
      '<div class="standard-card-head"><strong>' + esc(s.label) + '</strong>' +
        (active ? badge('当前选择', 'badge-primary') : badge('备选', 'badge-muted')) +
      '</div>' +
      '<p>' + esc(s.summary) + '</p>' +
      '<div class="standard-card-foot"><span>禁用科目 ' + esc(s.forbiddenCount) + ' 项</span><span>' + (s.features ? Object.keys(s.features).length : 0) + ' 项特征</span></div>' +
    '</div>';
  }).join('');

  const companyRows = [
    ['企业名称', company.name || '—'],
    ['纳税人身份', TAXPAYER_KIND[company.kind] || company.kind || '—'],
    ['所属行业', company.industry || '—'],
    ['城建税税率', company.cityTaxRate !== undefined ? (Number(company.cityTaxRate) * 100).toFixed(0) + '%' : '—'],
    ['会计科目', (config.accountCount || 0) + ' 个'],
    ['记账规则', (config.ruleCount || 0) + ' 条'],
  ].map(function (row) {
    return '<div class="detail-term">' + esc(row[0]) + '</div><div class="detail-value">' + esc(row[1]) + '</div>';
  }).join('');

  let notice = '';
  if (meta.notice) notice = '<div class="notice-box">' + esc(meta.notice) + '</div>';

  box.innerHTML =
    '<div class="section-head"><div><h2>准则与主体信息</h2><p>上传前先确认适用准则与企业信息；月结将按所选准则生成科目、报表与申报草稿。</p></div>' +
      (diffs.length > 0 ? badge(diffs.length + ' 项准则差异', 'badge-soft') : '') +
    '</div>' +
    '<div class="wb-meta-grid">' +
      '<div class="card">' +
        '<div class="card-head"><div><h2>企业会计准则 vs 小企业会计准则</h2><p class="card-sub">两套准则在确认、计量与报表列报上的关键差异。</p></div>' + badge('企业准则 / 小企业准则', 'badge-soft') + '</div>' +
        '<div class="table-wrap short"><table class="data-table meta-table"><thead><tr><th style="width:130px">维度</th><th>企业会计准则（cas）</th><th>小企业会计准则（small）</th></tr></thead>' +
        '<tbody>' + (diffRows || '<tr><td colspan="3" class="table-empty">暂无准则差异数据</td></tr>') + '</tbody></table></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-head"><div><h2>本企业与系统配置</h2><p class="card-sub">用于判断进项/销项、税率与申报口径。</p></div></div>' +
        '<div class="detail-grid company-grid">' + companyRows + '</div>' +
        '<div class="standard-list">' + standardCards + '</div>' +
        notice +
      '</div>' +
    '</div>';
}

/* ============================ 工作台总渲染 ============================ */

function renderWorkbench() {
  const periodInput = $('periodInput');
  if (periodInput && periodInput.value !== state.period) periodInput.value = state.period;
  const select = $('standardSelect');
  if (select && select.value !== state.standard) select.value = state.standard;
  renderFileList();
  updateUploadControls();
  renderCloseError();
  renderWorkbenchResult();
  renderMeta();
}


/* ============================ 记账页 ============================ */

function shortFile(name) {
  const s = String(name === null || name === undefined ? '' : name);
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf(String.fromCharCode(92)));
  return slash >= 0 ? s.slice(slash + 1) : s;
}

function issueLevel(level) {
  if (level === 'error' || level === 'warning') return level;
  return 'info';
}

function issueListHtml(issues) {
  if (!issues || issues.length === 0) {
    return '<div class="ok-panel"><span class="ok-panel-icon" aria-hidden="true">✓</span><div><strong>没有处理问题</strong><p>本次月结未记录单据解析或记账问题。</p></div></div>';
  }
  let error = 0, warning = 0, info = 0;
  for (let i = 0; i < issues.length; i++) {
    if (issues[i].level === 'error') error += 1;
    else if (issues[i].level === 'warning') warning += 1;
    else info += 1;
  }
  const summary = '<div class="issue-summary">' +
    badge('错误 ' + error, 'badge-danger') +
    badge('警告 ' + warning, 'badge-warning') +
    badge('提示 ' + info, 'badge-info') +
    '<span class="hint">问题定位到文件与行号，便于回查原始单据。</span></div>';
  const items = issues.map(function (issue) {
    const level = issueLevel(issue.level);
    const sev = SEVERITY[level];
    const meta = shortFile(issue.file) + (issue.row === null || issue.row === undefined ? '' : ' · 第 ' + issue.row + ' 行');
    return '<li class="issue-item is-' + level + '">' +
      '<span class="issue-level">' + badge(sev.label, 'badge-' + sev.cls) + '</span>' +
      '<div class="issue-body"><div class="issue-msg">' + esc(issue.message) + '</div>' +
        '<div class="issue-meta">' + esc(meta) + '</div></div>' +
    '</li>';
  }).join('');
  return summary + '<ul class="issue-list">' + items + '</ul>';
}

function filteredVouchers() {
  const rows = state.close && state.close.vouchers ? state.close.vouchers : [];
  const q = String(state.voucherQuery || '').trim().toLowerCase();
  if (q === '') return rows;
  return rows.filter(function (v) {
    const fields = [v.word, v.date, v.summary, v.accountCode, v.accountName, v.auxiliary];
    for (let i = 0; i < fields.length; i++) {
      if (String(fields[i] === null || fields[i] === undefined ? '' : fields[i]).toLowerCase().indexOf(q) >= 0) return true;
    }
    return false;
  });
}

function voucherRowsHtml() {
  const rows = filteredVouchers();
  if (rows.length === 0) {
    return '<tr><td colspan="7" class="table-empty">' + (state.voucherQuery ? '没有匹配的凭证。试试更短的关键词，或清空筛选。' : '本次月结没有生成凭证。') + '</td></tr>';
  }
  let prevWord = '';
  return rows.map(function (v) {
    const group = v.word !== prevWord;
    prevWord = v.word;
    const wordCell = group ? '<span class="voucher-word">' + esc(v.word) + '</span>' : '';
    return '<tr class="' + (group ? 'group-start' : '') + '">' +
      '<td class="nowrap">' + wordCell + '</td>' +
      '<td class="nowrap">' + esc(v.date) + '</td>' +
      '<td>' + esc(v.summary) + '</td>' +
      '<td><span class="mono">' + esc(v.accountCode) + '</span><br><span class="account-name">' + esc(v.accountName) + '</span></td>' +
      '<td class="num">' + (v.debit ? esc(v.debit) : '—') + '</td>' +
      '<td class="num">' + (v.credit ? esc(v.credit) : '—') + '</td>' +
      '<td>' + (v.auxiliary ? esc(v.auxiliary) : '—') + '</td>' +
    '</tr>';
  }).join('');
}

function renderVoucherCount() {
  const el = $('voucherCount');
  if (!el) return;
  const all = state.close && state.close.vouchers ? state.close.vouchers.length : 0;
  const shown = filteredVouchers().length;
  el.textContent = state.voucherQuery
    ? '匹配 ' + shown + ' 行 / 共 ' + all + ' 行'
    : '共 ' + all + ' 行明细';
}

function renderVoucherRows() {
  const body = $('voucherRows');
  if (!body) return;
  body.innerHTML = voucherRowsHtml();
  renderVoucherCount();
}

function renderBookkeeping() {
  const root = $('bkRoot');
  if (!root) return;
  const dto = state.close;
  if (!dto) {
    root.innerHTML = '<div class="page-block">' +
      emptyState('还没有月结数据', '记账页展示最近一次月结生成的凭证、单据与处理问题。请先在工作台上传单据并开始月结。', '前往工作台', 'goto-workbench') +
    '</div>';
    return;
  }
  const stats = dto.stats || {};
  const issues = dto.issues || [];
  const vouchers = dto.vouchers || [];
  const unbalanced = Number(stats.unbalanced) || 0;
  const issueCount = Number(stats.issues) || issues.length;

  root.innerHTML = '<div class="page-block">' +
    '<div class="stat-grid">' +
      '<div class="stat-card"><span class="stat-icon navy" aria-hidden="true">凭</span><div class="stat-body"><div class="stat-value">' + esc(stats.vouchers) + '<small>张</small></div><div class="stat-label">记账凭证</div><div class="stat-sub">按凭证字号分组展示</div></div></div>' +
      '<div class="stat-card"><span class="stat-icon" aria-hidden="true">单</span><div class="stat-body"><div class="stat-value">' + esc(stats.documents) + '<small>张</small></div><div class="stat-label">识别单据</div><div class="stat-sub">银行流水、发票、报销、工资等</div></div></div>' +
      '<div class="stat-card"><span class="stat-icon ' + (unbalanced > 0 ? 'red' : 'green') + '" aria-hidden="true">平</span><div class="stat-body"><div class="stat-value ' + (unbalanced > 0 ? 'text-danger' : '') + '">' + unbalanced + '<small>张</small></div><div class="stat-label">借贷不平衡</div><div class="stat-sub">' + (unbalanced > 0 ? '需要逐张核对' : '全部凭证借贷相等') + '</div></div></div>' +
      '<div class="stat-card"><span class="stat-icon amber" aria-hidden="true">问</span><div class="stat-body"><div class="stat-value">' + issueCount + '<small>条</small></div><div class="stat-label">待处理问题</div><div class="stat-sub">含错误、警告与提示</div></div></div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-head"><div><h2>记账凭证</h2><p class="card-sub">共 ' + vouchers.length + ' 行明细（最多展示 400 行）。借贷金额已按元格式化，空值表示该方向无金额。</p></div>' +
        '<span class="badge badge-soft">' + esc(dto.period) + ' · ' + esc(dto.standardLabel || '') + '</span></div>' +
      '<div class="toolbar">' +
        '<input id="voucherFilter" class="search-input filter-search" type="search" placeholder="按凭证字号、日期、摘要、科目或辅助核算筛选…" value="' + esc(state.voucherQuery) + '" autocomplete="off" spellcheck="false" aria-label="筛选凭证">' +
        '<span id="voucherCount" class="count-note"></span>' +
        '<span class="spacer"></span>' +
        '<span class="hint">金额单位：元</span>' +
      '</div>' +
      '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th style="width:92px">凭证字号</th><th style="width:96px">日期</th><th>摘要</th><th style="width:200px">科目</th>' +
        '<th style="width:116px;text-align:right">借方</th><th style="width:116px;text-align:right">贷方</th><th style="width:140px">辅助核算</th>' +
      '</tr></thead><tbody id="voucherRows">' + voucherRowsHtml() + '</tbody></table></div>' +
      (vouchers.length >= 400 ? '<div class="table-note"><span>服务端最多返回 400 行凭证明细，超出部分请在服务端导出完整凭证。</span></div>' : '') +
    '</div>' +
    '<div class="card">' +
      '<div class="card-head"><div><h2>处理问题</h2><p class="card-sub">按月结管线的原始顺序展示，错误与警告需要优先处理。</p></div>' +
        '<span class="badge badge-soft">' + issues.length + ' 条</span></div>' +
      '<div id="bkIssues">' + issueListHtml(issues) + '</div>' +
    '</div>' +
  '</div>';
  renderVoucherCount();
}

/* ============================ 审核页 ============================ */

function findingSevClass(severity) {
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warning';
  return 'info';
}

function findingCardHtml(f) {
  const sev = SEVERITY[f.severity] || SEVERITY.info;
  const sevClass = findingSevClass(f.severity);
  const tags = [];
  if (f.blocking) tags.push(badge('阻断', 'badge-danger'));
  if (f.waived) tags.push(badge('已豁免', 'badge-muted'));
  const basis = f.basis && f.basis.length > 0
    ? '<div class="basis"><span>法规依据</span>' + f.basis.map(function (b) { return '<span class="basis-tag">' + esc(b) + '</span>'; }).join('') + '</div>'
    : '';
  return '<article class="finding-card is-' + sevClass + '">' +
    '<div class="finding-head">' + severityBadge(f.severity) + '<h3>' + esc(f.title) + '</h3>' +
      (tags.length > 0 ? '<span class="finding-tags">' + tags.join('') + '</span>' : '') + '</div>' +
    '<div class="finding-meta"><span>' + badge(f.categoryLabel || '未分类', 'badge-soft') + '</span>' +
      '<span>定位：' + esc(f.targetLabel || '—') + '</span>' +
      '<span class="rule">' + esc(f.ruleId || '') + '</span></div>' +
    '<p class="finding-detail">' + esc(f.detail) + '</p>' +
    (f.suggestion ? '<div class="finding-suggest"><strong>整改建议</strong><p>' + esc(f.suggestion) + '</p></div>' : '') +
    basis +
  '</article>';
}

function reviewCategories() {
  const list = state.close && state.close.findings ? state.close.findings : [];
  const seen = {};
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const code = list[i].category || 'other';
    if (!seen[code]) {
      seen[code] = true;
      out.push({ code: code, label: list[i].categoryLabel || code });
    }
  }
  return out;
}

function currentFindings() {
  const all = state.close && state.close.findings ? state.close.findings : [];
  const f = state.reviewFilter;
  return all.filter(function (item) {
    if (f.severity !== 'all' && item.severity !== f.severity) return false;
    if (f.category !== 'all' && item.category !== f.category) return false;
    if (f.blockingOnly && !item.blocking) return false;
    return true;
  });
}

function renderReviewFindings() {
  const box = $('reviewFindings');
  if (!box) return;
  const rows = currentFindings();
  const all = state.close && state.close.findings ? state.close.findings : [];
  if (rows.length === 0) {
    box.innerHTML = '<div class="state-card" style="padding:36px 20px"><div class="state-icon" aria-hidden="true">✓</div><div class="state-title">没有符合条件的审核结论</div><p class="state-text">调整严重度、维度或阻断筛选后再看；如果全部清空，说明本次审核没有发现该类问题。</p><div class="state-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="reset-review">重置筛选</button></div></div>';
  } else {
    box.innerHTML = rows.map(findingCardHtml).join('');
  }
  const count = $('reviewFilterCount');
  if (count) count.textContent = '显示 ' + rows.length + ' / ' + all.length + ' 条';
  const buttons = document.querySelectorAll('[data-action="review-severity"]');
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle('active', buttons[i].getAttribute('data-sev') === state.reviewFilter.severity);
  }
}

function reviewTone(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return '';
  if (n >= 85) return 'text-success';
  if (n >= 70) return 'text-accent';
  if (n >= 60) return 'text-warning';
  return 'text-danger';
}

function renderReview() {
  const root = $('reviewRoot');
  if (!root) return;
  const dto = state.close;
  if (!dto) {
    root.innerHTML = '<div class="page-block">' +
      emptyState('还没有审核结论', '审核页展示最近一次月结的六层合规检查结论、整改建议与法规依据。请先完成一次月结。', '前往工作台', 'goto-workbench') +
    '</div>';
    return;
  }
  const findings = dto.findings || [];
  const stats = dto.stats || {};
  let errors = 0, warnings = 0, infos = 0;
  for (let i = 0; i < findings.length; i++) {
    if (findings[i].severity === 'error') errors += 1;
    else if (findings[i].severity === 'warning') warnings += 1;
    else infos += 1;
  }
  const blocking = (dto.blockers || []).length;
  const grade = scoreMeta(stats.score).grade;
  const categories = reviewCategories();
  const categoryOptions = '<option value="all">全部维度</option>' + categories.map(function (c) {
    return '<option value="' + esc(c.code) + '"' + (state.reviewFilter.category === c.code ? ' selected' : '') + '>' + esc(c.label) + '</option>';
  }).join('');

  root.innerHTML = '<div class="page-block">' +
    '<div class="card">' +
      '<div class="review-top">' +
        '<div class="review-score">' +
          '<div class="review-score-num ' + reviewTone(stats.score) + '">' + esc(fmtScore(stats.score)) + '</div>' +
          '<div class="review-score-label">合规得分 / 100</div>' +
          '<span class="review-score-grade">' + esc(grade) + '</span>' +
        '</div>' +
        '<div class="review-counts">' +
          '<div class="count-pill is-error"><div class="count-label">错误</div><div class="count-value">' + errors + '</div></div>' +
          '<div class="count-pill is-warning"><div class="count-label">警告</div><div class="count-value">' + warnings + '</div></div>' +
          '<div class="count-pill is-info"><div class="count-label">提示</div><div class="count-value">' + infos + '</div></div>' +
          '<div class="count-pill is-blocking"><div class="count-label">阻断项</div><div class="count-value">' + blocking + '</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="result-links"><span class="hint">审核引擎覆盖凭证、科目、税务、刑事、报表、内控六层；所有结论均需人工复核，系统不代替会计师判断。</span>' +
        '<a class="btn btn-soft btn-sm" href="#/workbench">返回工作台</a></div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-head"><div><h2>审核结论</h2><p class="card-sub">每条结论包含定位、详情、整改建议与法规依据；阻断项未处理不得结账。</p></div>' +
        '<span class="badge badge-soft">共 ' + findings.length + ' 条</span></div>' +
      '<div class="toolbar">' +
        '<div class="chip-group" role="group" aria-label="按严重度筛选">' +
          '<button type="button" class="chip-btn' + (state.reviewFilter.severity === 'all' ? ' active' : '') + '" data-action="review-severity" data-sev="all">全部<span class="count">' + findings.length + '</span></button>' +
          '<button type="button" class="chip-btn' + (state.reviewFilter.severity === 'error' ? ' active' : '') + '" data-action="review-severity" data-sev="error">错误<span class="count">' + errors + '</span></button>' +
          '<button type="button" class="chip-btn' + (state.reviewFilter.severity === 'warning' ? ' active' : '') + '" data-action="review-severity" data-sev="warning">警告<span class="count">' + warnings + '</span></button>' +
          '<button type="button" class="chip-btn' + (state.reviewFilter.severity === 'info' ? ' active' : '') + '" data-action="review-severity" data-sev="info">提示<span class="count">' + infos + '</span></button>' +
        '</div>' +
        '<select id="reviewCategory" class="select-input" aria-label="按审核维度筛选">' + categoryOptions + '</select>' +
        '<label class="checkbox"><input id="reviewBlocking" type="checkbox"' + (state.reviewFilter.blockingOnly ? ' checked' : '') + '>只看阻断项</label>' +
        '<span class="spacer"></span>' +
        '<span id="reviewFilterCount" class="count-note"></span>' +
        '<button type="button" class="link-btn" data-action="reset-review">重置筛选</button>' +
      '</div>' +
      '<div id="reviewFindings" class="finding-list">' + currentFindings().map(findingCardHtml).join('') + '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-head"><div><h2>本次检查了什么</h2><p class="card-sub">审核不是只看借贷平衡，而是沿业务链条逐层追问。</p></div>' + badge('六层覆盖', 'badge-primary') + '</div>' +
      '<div class="coverage-grid">' +
        '<div class="coverage-card"><span class="coverage-num">01</span><div><h4>凭证层</h4><p>借贷平衡、摘要完整、附件与日期、凭证字号连续性。</p></div></div>' +
        '<div class="coverage-card"><span class="coverage-num">02</span><div><h4>科目层</h4><p>科目存在性、明细下钻、余额方向与备抵科目判断。</p></div></div>' +
        '<div class="coverage-card"><span class="coverage-num">03</span><div><h4>税务层</h4><p>税会差异、税率适用、申报表勾稽与税款计算。</p></div></div>' +
        '<div class="coverage-card"><span class="coverage-num">04</span><div><h4>刑事层</h4><p>虚开发票、逃税风险与资金回流等红线预警。</p></div></div>' +
        '<div class="coverage-card"><span class="coverage-num">05</span><div><h4>报表层</h4><p>四表勾稽、期初期末衔接、报表与账簿一致性。</p></div></div>' +
        '<div class="coverage-card"><span class="coverage-num">06</span><div><h4>内控层</h4><p>职责分离、审批留痕、签署完整性与申报前复核。</p></div></div>' +
      '</div>' +
    '</div>' +
  '</div>';
  renderReviewFindings();
}

/* ============================ 报表页 ============================ */

function statementPanelHtml(statement) {
  const lines = statement.lines || [];
  const checks = statement.checks || [];
  const rows = lines.length === 0
    ? '<tr><td colspan="2" class="table-empty">本表没有可展示的行。</td></tr>'
    : lines.map(function (line) {
        const level = Math.max(0, Math.min(3, Number(line.level) || 0));
        const indent = level > 0 ? ' depth-' + level : '';
        const total = line.isTotal ? ' is-total' : '';
        return '<tr class="' + (line.isTotal ? 'total-row' : '') + '">' +
          '<td class="line-label' + indent + total + '">' + esc(line.label) + '</td>' +
          '<td class="amount' + total + '">' + (line.amount === null || line.amount === undefined || line.amount === '' ? '—' : esc(line.amount)) + '</td>' +
        '</tr>';
      }).join('');
  const checkRows = checks.length === 0
    ? '<p class="hint">本表暂无勾稽校验项。</p>'
    : checks.map(function (c) {
        return '<div class="check-item' + (c.passed ? '' : ' fail') + '">' +
          '<span class="check-icon" aria-hidden="true">' + (c.passed ? '✓' : '!') + '</span>' +
          '<div class="check-text"><strong>' + esc(c.label) + '</strong><span>' + esc(c.detail) + '</span></div>' +
        '</div>';
      }).join('');
  return '<div class="statement-head">' +
      '<div><h3>' + esc(statement.kindLabel) + '</h3><p>' + esc(state.close ? state.close.period : '') + ' · 金额单位：元</p></div>' +
      (statement.passed ? badge('勾稽通过', 'badge-success') : badge('存在差异', 'badge-danger')) +
    '</div>' +
    '<div class="table-wrap short"><table class="data-table statement-table"><thead><tr><th>项目</th><th style="text-align:right;width:180px">金额（元）</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div class="checks"><h4>勾稽校验 · ' + (statement.passed ? '全部通过' : '存在差异') + '</h4>' + checkRows + '</div>';
}

function groupedRatios(ratios) {
  const order = [];
  const map = {};
  for (let i = 0; i < ratios.length; i++) {
    const key = ratios[i].group || 'other';
    if (!map[key]) { map[key] = []; order.push(key); }
    map[key].push(ratios[i]);
  }
  return order.map(function (key) {
    return { key: key, label: RATIO_GROUPS[key] || key, items: map[key] };
  });
}

function ratioRowHtml(item) {
  const r = rating(item.rating);
  const hasValue = item.value !== null && item.value !== undefined && item.value !== '' && item.value !== '—';
  return '<div class="ratio-row" title="' + esc(item.formula || '') + '">' +
    '<div class="ratio-name"><strong>' + esc(item.name) + '</strong><span class="ratio-formula">' + esc(item.formula || '') + '</span></div>' +
    '<div class="ratio-value">' + esc(item.value === null || item.value === undefined || item.value === '' ? '—' : item.value) +
      (hasValue && item.unit ? '<small> ' + esc(item.unit) + '</small>' : '') + '</div>' +
    '<span class="ratio-rating rating-' + r.cls + '">' + esc(r.label) + '</span>' +
    '<div class="ratio-comment">' + esc(item.comment || '') + '</div>' +
  '</div>';
}

function analysisHtml(analysis) {
  if (!analysis) return '';
  const ratios = analysis.ratios || [];
  const groups = groupedRatios(ratios);
  const dupont = analysis.dupont || {};
  const alerts = analysis.alerts || [];
  const narratives = analysis.narratives || [];
  const notes = analysis.dataNotes || [];
  const alertLevels = {
    error: { label: '高风险', cls: 'danger' },
    warning: { label: '关注', cls: 'warning' },
    info: { label: '提示', cls: 'info' },
  };

  const ratioHtml = groups.length === 0
    ? '<p class="hint">报表环节未生成财务比率。</p>'
    : groups.map(function (group) {
        return '<section class="ratio-group"><div class="ratio-group-head"><h4>' + esc(group.label) + '</h4><span>' + group.items.length + ' 项</span></div>' +
          group.items.map(ratioRowHtml).join('') + '</section>';
      }).join('');

  const dupontHtml = [
    ['净资产收益率（ROE）', dupont.roe, ''],
    ['销售净利率', dupont.netProfitMargin, ''],
    ['总资产周转率', dupont.assetTurnover, '次'],
    ['权益乘数', dupont.equityMultiplier, '倍'],
  ].map(function (row) {
    const value = row[1] === null || row[1] === undefined || row[1] === '' ? '—' : row[1];
    const suffix = value === '—' ? '' : row[2];
    return '<div class="dupont-item"><div class="dupont-label">' + esc(row[0]) + '</div><div class="dupont-value">' + esc(value) + (suffix ? '<small> ' + esc(suffix) + '</small>' : '') + '</div></div>';
  }).join('');

  const alertHtml = alerts.length === 0
    ? '<div class="ok-panel"><span class="ok-panel-icon" aria-hidden="true">✓</span><div><strong>暂无风险预警</strong><p>本期指标未触发预设预警阈值，仍建议结合业务实质复核。</p></div></div>'
    : '<div class="alert-list">' + alerts.map(function (alert) {
        const lv = alertLevels[alert.level] || alertLevels.info;
        return '<div class="alert-card is-' + (alert.level === 'error' ? 'error' : alert.level === 'warning' ? 'warning' : 'info') + '">' +
          '<div class="alert-head">' + badge(lv.label, 'badge-' + lv.cls) + '<strong>' + esc(alert.title) + '</strong></div>' +
          '<p class="alert-detail">' + esc(alert.detail) + '</p>' +
          '<p class="alert-action"><strong>建议：</strong>' + esc(alert.action) + '</p>' +
        '</div>';
      }).join('') + '</div>';

  const narrativeHtml = narratives.length === 0
    ? '<p class="hint">报表环节未生成文字结论。</p>'
    : '<div class="narrative-list">' + narratives.map(function (n) {
        return '<div class="narrative-item"><h4>' + esc(n.title) + '</h4><p>' + esc(n.body) + '</p></div>';
      }).join('') + '</div>';

  const notesHtml = notes.length === 0
    ? '<p class="hint">无数据说明。</p>'
    : '<ul>' + notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';

  const badCount = ratios.filter(function (r) { return r.rating === 'bad'; }).length;
  const watchCount = ratios.filter(function (r) { return r.rating === 'watch'; }).length;

  return '<div class="section-head"><div><h2>财务分析</h2><p>' + ratios.length + ' 项指标，按能力分组；异常 ' + badCount + ' 项、关注 ' + watchCount + ' 项。</p></div>' +
      badge('杜邦分解 · 风险预警', 'badge-soft') + '</div>' +
    '<div class="analysis-wrap">' +
      '<div class="analysis-grid">' +
        '<div class="card">' +
          '<div class="card-head"><div><h2>财务比率</h2><p class="card-sub">比率来自本期报表；无数据时显示「—」，不参与评级。</p></div>' + badge(ratios.length + ' 项', 'badge-soft') + '</div>' +
          '<div class="ratio-groups">' + ratioHtml + '</div>' +
        '</div>' +
        '<div class="analysis-side">' +
          '<div class="card"><div class="card-head"><h2>杜邦分析</h2></div><div class="dupont-grid">' + dupontHtml + '</div>' +
            '<p class="hint" style="margin-top:10px">ROE = 销售净利率 × 总资产周转率 × 权益乘数</p></div>' +
          '<div class="card"><div class="card-head"><div><h2>风险预警</h2><p class="card-sub">按阈值触发的经营与财务风险。</p></div>' + badge(alerts.length + ' 条', alerts.length > 0 ? 'badge-warning' : 'badge-success') + '</div>' + alertHtml + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="card"><div class="card-head"><div><h2>文字结论</h2><p class="card-sub">自动生成的经营分析，供人工复核时参考。</p></div></div>' + narrativeHtml + '</div>' +
      '<div class="card data-notes"><div class="card-head"><h2>数据说明</h2></div>' + notesHtml + '</div>' +
    '</div>';
}

function renderStatements() {
  const root = $('statementsRoot');
  if (!root) return;
  const dto = state.close;
  if (!dto) {
    root.innerHTML = '<div class="page-block">' +
      emptyState('还没有报表数据', '报表页展示最近一次月结生成的资产负债表、利润表、现金流量表与所有者权益变动表，以及 30 项财务指标。请先完成月结。', '前往工作台', 'goto-workbench') +
    '</div>';
    return;
  }
  const statements = dto.statements || [];
  if (statements.length === 0) {
    root.innerHTML = '<div class="page-block">' +
      emptyState('报表尚未生成', '本次月结没有返回财务报表。请查看审核结论中的降级原因，或重新运行月结。', '查看审核结论', 'goto-review') +
    '</div>';
    return;
  }
  let active = null;
  for (let i = 0; i < statements.length; i++) {
    if (statements[i].kind === state.statementTab) { active = statements[i]; break; }
  }
  if (!active) active = statements[0];
  state.statementTab = active.kind;
  const tabs = statements.map(function (st) {
    return '<button type="button" class="tab' + (st.kind === active.kind ? ' active' : '') + '" role="tab" aria-selected="' + (st.kind === active.kind ? 'true' : 'false') + '" data-action="statement-tab" data-kind="' + esc(st.kind) + '">' +
      esc(st.kindLabel) + (st.passed ? '' : '<span class="tab-count" style="background:#FDF1F0;color:#D93025">!</span>') + '</button>';
  }).join('');
  root.innerHTML = '<div class="page-block">' +
    '<div class="card statement-card"><div class="tabs statement-tabs" role="tablist" aria-label="财务报表">' + tabs + '</div>' +
      '<div id="statementPanel" class="tab-body" style="padding-top:0">' + statementPanelHtml(active) + '</div>' +
    '</div>' +
    analysisHtml(dto.analysis) +
  '</div>';
}


/* ============================ 报税页 ============================ */

function filingCycleLabel(cycle) {
  return FILING_CYCLE[cycle] || cycle || '—';
}

function taxStatusBadge(item) {
  const map = {
    draft: 'badge-muted',
    calculated: 'badge-info',
    reviewed: 'badge-primary',
    approved: 'badge-primary',
    filed: 'badge-success',
    rejected: 'badge-danger',
    void: 'badge-muted',
  };
  return badge(item.statusLabel || item.status || '未知状态', map[item.status] || 'badge-soft');
}

function chainEventCount() {
  const groups = state.chainGroups || [];
  let total = 0;
  for (let i = 0; i < groups.length; i++) total += (groups[i].events || []).length;
  return total;
}

function updateTaxTabCounts() {
  const setText = function (id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  };
  const returns = state.close && state.close.taxReturns ? state.close.taxReturns.length : 0;
  setText('taxTabReturnsCount', String(returns));
  setText('taxTabNavCount', state.taxNav ? String(state.taxNav.length) : '…');
  setText('taxTabChainCount', state.chainGroups ? String(chainEventCount()) : '…');
}

function taxBannerHtml() {
  return '<div class="tax-banner"><span class="banner-icon" aria-hidden="true">!</span><div>' +
    '<h2>本系统不向税务机关提交任何数据，所有申报表均为草稿</h2>' +
    '<p>申报草稿只用于内部复核与底稿留痕。签署、申报与回执回填必须由人工在电子税务局完成，系统不代为提交、不保存申报回执之外的任何数据。</p>' +
  '</div></div>';
}

function taxTabsHtml() {
  const returns = state.close && state.close.taxReturns ? state.close.taxReturns.length : 0;
  const navCount = state.taxNav ? state.taxNav.length : '…';
  const eventCount = state.chainGroups ? chainEventCount() : '…';
  const tab = function (key, label, countId, count) {
    return '<button type="button" class="tab' + (state.taxTab === key ? ' active' : '') + '" role="tab" aria-selected="' + (state.taxTab === key ? 'true' : 'false') + '" data-action="tax-tab" data-tab="' + key + '">' +
      esc(label) + '<span class="tab-count" id="' + countId + '">' + esc(count) + '</span></button>';
  };
  return '<div class="card tax-tabs-card"><div class="tabs" role="tablist" aria-label="报税功能">' +
    tab('returns', '申报草稿', 'taxTabReturnsCount', returns) +
    tab('nav', '税种导航', 'taxTabNavCount', navCount) +
    tab('chain', '税会智链', 'taxTabChainCount', eventCount) +
  '</div></div>';
}

function returnLinesHtml(taxReturn) {
  const lines = taxReturn.lines || [];
  if (lines.length === 0) {
    return '<div class="table-wrap"><table class="data-table"><tbody><tr><td class="table-empty">本表无明细行。</td></tr></tbody></table></div>';
  }
  return '<div class="table-wrap"><table class="data-table"><thead><tr>' +
    '<th style="width:110px">栏次</th><th>项目</th><th style="width:130px;text-align:right">金额（元）</th><th style="width:36%">计算说明</th>' +
  '</tr></thead><tbody>' + lines.map(function (line) {
    return '<tr><td class="mono">' + esc(line.code) + '</td><td>' + esc(line.label) + '</td>' +
      '<td class="num">' + esc(line.amount) + '</td>' +
      '<td class="hint">' + (line.note ? esc(line.note) : '—') + '</td></tr>';
  }).join('') + '</tbody></table></div>';
}

function returnCardHtml(taxReturn) {
  const lines = taxReturn.lines || [];
  const blocking = Number(taxReturn.blockingIssues) || 0;
  const icon = String(taxReturn.taxTypeLabel || taxReturn.taxType || '税').slice(0, 1);
  return '<details class="return-card">' +
    '<summary class="return-summary">' +
      '<div class="return-main"><span class="tax-icon" aria-hidden="true">' + esc(icon) + '</span>' +
        '<div class="return-title"><h3>' + esc(taxReturn.taxTypeLabel) + taxStatusBadge(taxReturn) + '</h3>' +
          '<p>所属期间 ' + esc(taxReturn.period) + ' · 明细 ' + lines.length + ' 行 · ' + esc(taxReturn.id) + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="return-numbers">' +
        '<div class="return-number"><span>应纳税额</span><strong>' + esc(taxReturn.payable) + '</strong></div>' +
        '<div class="return-number"><span>应补（退）</span><strong>' + esc(taxReturn.due) + '</strong></div>' +
        '<div class="return-number"><span>阻断项</span><strong class="' + (blocking > 0 ? 'danger' : '') + '">' + blocking + '</strong></div>' +
        '<span class="return-chevron" aria-hidden="true">▾</span>' +
      '</div>' +
    '</summary>' +
    '<div class="return-body">' + returnLinesHtml(taxReturn) +
      '<p class="return-note">该表状态为「' + esc(taxReturn.statusLabel) + '」，是系统生成的申报草稿。提交前须完成制单、复核、审批签署，并由人工在电子税务局申报、回填回执号。</p>' +
    '</div>' +
  '</details>';
}

function processHtml() {
  const steps = [
    ['制单人', '编制申报表草稿'],
    ['复核人', '核对税额与勾稽'],
    ['审批人', '签署批准'],
    ['人工申报', '在电子税务局提交'],
    ['回填回执', '登记申报回执号'],
  ];
  return '<div class="card process-card">' +
    '<div class="card-head"><div><h2>申报流程说明</h2><p class="card-sub">系统只负责算税、生成草稿与留痕；申报动作始终由人完成。</p></div>' + badge('线上不可提交', 'badge-danger') + '</div>' +
    '<div class="process-steps">' + steps.map(function (step, i) {
      return '<div class="process-step"><span class="process-num">' + (i + 1) + '</span><strong>' + esc(step[0]) + '</strong><span>' + esc(step[1]) + '</span></div>';
    }).join('') + '</div>' +
    '<div class="process-callout"><strong>线上不可提交：</strong>系统没有、也不会调用任何税务接口。请由持证人员登录电子税务局完成申报后，手工回填回执号；在回执回填前，本页所有申报表都只是草稿。</div>' +
  '</div>';
}

function returnsBodyHtml() {
  const dto = state.close;
  if (!dto) {
    return emptyState('还没有申报草稿', '完成月结后，系统会按增值税、附加税费、企业所得税、个人所得税、印花税等税种生成申报草稿。', '前往工作台', 'goto-workbench') + processHtml();
  }
  const returns = dto.taxReturns || [];
  const list = returns.length === 0
    ? emptyState('本次月结没有生成申报表', '可能是税种不适用，或税务环节发生降级。请查看审核结论中的说明，并在复核后手动处理。', '查看审核结论', 'goto-review')
    : '<div class="returns-grid">' + returns.map(returnCardHtml).join('') + '</div>';
  return list + processHtml();
}

function taxNavCardHtml(item) {
  const forms = item.forms || [];
  const keyPoints = item.keyPoints || [];
  const latest = item.latestPolicy;
  const icon = String(item.label || item.taxType || '税').slice(0, 1);
  return '<article class="tax-card">' +
    '<div class="tax-card-head"><span class="tax-icon" aria-hidden="true">' + esc(icon) + '</span><h3>' + esc(item.label) + '</h3>' + badge(filingCycleLabel(item.filingCycle), 'badge-soft') + '</div>' +
    '<div class="tax-counts"><span>中央政策 ' + esc(item.centralCount) + '</span><span>地方政策 ' + esc(item.localCount) + '</span><span>申报表 ' + forms.length + ' 张</span></div>' +
    '<div><span class="forms-label">申报表</span>' +
      (forms.length > 0 ? '<ul class="forms-list">' + forms.map(function (form) { return '<li>' + esc(form) + '</li>'; }).join('') + '</ul>' : '<p class="hint">暂无申报表信息</p>') +
    '</div>' +
    '<details><summary>申报要点与最新政策</summary><div class="tax-detail">' +
      (keyPoints.length > 0 ? '<h4>申报要点</h4><ul>' + keyPoints.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
      (latest ? '<h4>最新政策</h4><p class="latest-policy">' + esc(latest.title) + '<br>' + esc(latest.documentNo || '') + (latest.effectiveFrom ? ' · 施行 ' + esc(latest.effectiveFrom) : '') + '</p>' : '') +
    '</div></details>' +
  '</article>';
}

function taxNavBodyHtml() {
  if (state.taxNavStatus === 'error' && !state.taxNav) return errorState(state.taxNavError, 'retry-tax-nav');
  if (!state.taxNav) return loadingState('正在读取 19 个税种的政策与申报表信息…');
  const nav = state.taxNav;
  const totalCentral = nav.reduce(function (sum, item) { return sum + (Number(item.centralCount) || 0); }, 0);
  const totalLocal = nav.reduce(function (sum, item) { return sum + (Number(item.localCount) || 0); }, 0);
  return '<div class="section-head"><div><h2>税种导航</h2><p>共 ' + nav.length + ' 个税种，关联中央政策 ' + totalCentral + ' 条、地方政策 ' + totalLocal + ' 条。展开可查看申报要点与最新政策。</p></div>' + badge('政策关联', 'badge-soft') + '</div>' +
    '<div class="tax-grid">' + nav.map(taxNavCardHtml).join('') + '</div>';
}

function chainGroupsHtml() {
  const groups = state.chainGroups || [];
  return groups.map(function (group) {
    const events = group.events || [];
    return '<section class="chain-group"><div class="chain-group-head"><h4>' + esc(group.group) + '</h4><span>' + events.length + ' 个事项</span></div>' +
      '<div class="event-list">' + events.map(function (event) {
        const active = event.id === state.chainEventId;
        return '<button type="button" class="event-btn' + (active ? ' active' : '') + '" data-action="select-event" data-id="' + esc(event.id) + '">' +
          '<span class="event-name">' + esc(event.name) + '</span>' +
          '<span class="event-badges"><em>差异 ' + esc(event.differenceCount) + '</em><em>栏次 ' + esc(event.returnLineCount) + '</em></span>' +
        '</button>';
      }).join('') + '</div></section>';
  }).join('');
}

function chainDetailHtml() {
  if (!state.chainEventId) {
    return '<div class="state-card" style="border:0;background:transparent;padding:56px 16px"><div class="state-icon" aria-hidden="true">链</div>' +
      '<div class="state-title">选择一个业务事项</div><p class="state-text">左侧按 12 个业务分组列出 48 个典型事项；点开后查看涉及税种、申报表栏次、税会差异、记账指引与关联政策。</p></div>';
  }
  if (state.chainEventStatus === 'loading') return loadingState('正在读取业务事项详情…');
  if (state.chainEventStatus === 'error') return errorState(state.chainEventError, 'retry-event');
  const event = state.chainEvent;
  if (!event) return loadingState('正在读取业务事项详情…');
  const differences = event.differences || [];
  const returnLines = event.returnLines || [];
  const guide = event.accountingGuide || [];
  const policies = state.chainPolicies || [];
  const taxTypes = event.taxTypes || [];

  const differenceHtml = differences.length === 0
    ? '<p class="hint">该事项没有登记税会差异。</p>'
    : differences.map(function (diff) {
        const policyCount = (diff.policyIds || []).length;
        return '<div class="detail-item"><strong>' + esc(diff.label) + '</strong><p>' + esc(diff.description) + '</p>' +
          (policyCount > 0 ? '<div class="policy-ref">关联 ' + policyCount + ' 项政策依据</div>' : '') + '</div>';
      }).join('');

  const lineHtml = returnLines.length === 0
    ? '<p class="hint">该事项没有对应的申报表栏次。</p>'
    : '<div class="detail-table-wrap"><table class="detail-table"><thead><tr><th>税种</th><th>申报表</th><th>栏次</th><th>项目</th></tr></thead><tbody>' +
      returnLines.map(function (line) {
        return '<tr><td>' + esc(taxLabel(line.taxType)) + '</td><td>' + esc(line.form) + '</td><td class="nowrap">' + esc(line.lineCode) + '</td><td>' + esc(line.lineLabel) + '</td></tr>';
      }).join('') + '</tbody></table></div>';

  const guideHtml = guide.length === 0
    ? '<p class="hint">暂无记账指引。</p>'
    : '<ul class="detail-list">' + guide.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ul>';

  const policyHtml = policies.length === 0
    ? '<p class="hint">暂无关联政策。</p>'
    : '<div class="policy-chips">' + policies.map(function (p) {
        return '<button type="button" class="policy-chip" data-action="open-policy" data-id="' + esc(p.id) + '">' + esc(p.title) +
          '<span class="chip-meta">' + esc(p.documentNo || '') + '</span></button>';
      }).join('') + '</div>';

  return '<div class="detail-head"><div><h3>' + esc(event.name) + '</h3>' +
      '<p>' + esc(event.group) + ' · 涉及 ' + taxTypes.length + ' 个税种 · ' + differences.length + ' 项税会差异</p>' +
      '<div class="detail-badges">' + taxTypes.map(function (t) { return badge(taxLabel(t), 'badge-primary'); }).join('') + '</div>' +
    '</div>' + badge('税会智链', 'badge-soft') + '</div>' +
    '<div class="detail-section"><h4>税会差异 <span class="badge badge-warning">' + differences.length + '</span></h4>' + differenceHtml + '</div>' +
    '<div class="detail-section"><h4>申报表栏次 <span class="badge badge-info">' + returnLines.length + '</span></h4>' + lineHtml + '</div>' +
    '<div class="detail-section"><h4>记账指引</h4>' + guideHtml + '</div>' +
    '<div class="detail-section"><h4>关联政策 <span class="badge badge-soft">' + policies.length + '</span></h4>' + policyHtml + '</div>';
}

function chainBodyHtml() {
  if (state.chainStatus === 'error' && !state.chainGroups) return errorState(state.chainError, 'retry-chain');
  if (!state.chainGroups) return loadingState('正在读取 12 个业务分组与税会差异…');
  const groups = state.chainGroups;
  const total = chainEventCount();
  return '<div class="section-head"><div><h2>税会智链</h2><p>按 ' + groups.length + ' 个业务分组梳理 ' + total + ' 个典型事项，连接会计处理、税会差异与申报表栏次。</p></div>' + badge('48 项典型业务', 'badge-soft') + '</div>' +
    '<div class="chain-layout">' +
      '<div class="card chain-groups"><div class="card-head"><div><h2>业务事项</h2><p class="card-sub">按业务流程分组，点击查看。</p></div></div>' + chainGroupsHtml() + '</div>' +
      '<div class="card chain-detail" id="chainDetail">' + chainDetailHtml() + '</div>' +
    '</div>';
}

function taxTabBodyHtml() {
  if (state.taxTab === 'nav') return taxNavBodyHtml();
  if (state.taxTab === 'chain') return chainBodyHtml();
  return returnsBodyHtml();
}

function renderTaxTabBody() {
  const body = $('taxTabBody');
  if (!body) return;
  body.innerHTML = taxTabBodyHtml();
  updateTaxTabCounts();
}

function renderTax() {
  const root = $('taxRoot');
  if (!root) return;
  root.innerHTML = '<div class="page-block">' + taxBannerHtml() + taxTabsHtml() + '<div id="taxTabBody" class="tab-body">' + taxTabBodyHtml() + '</div></div>';
  updateTaxTabCounts();
}

function renderChainDetail() {
  const box = $('chainDetail');
  if (!box) return;
  box.innerHTML = chainDetailHtml();
  const buttons = document.querySelectorAll('[data-action="select-event"]');
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle('active', buttons[i].getAttribute('data-id') === state.chainEventId);
  }
}

function selectChainEvent(id) {
  if (!id) return;
  state.chainEventId = id;
  state.chainEvent = null;
  state.chainPolicies = [];
  state.chainEventStatus = 'loading';
  state.chainEventError = '';
  renderChainDetail();
  api.chainEvent(id).then(function (data) {
    if (state.chainEventId !== id) return;
    state.chainEvent = data.event || null;
    state.chainPolicies = Array.isArray(data.policies) ? data.policies : [];
    state.chainEventStatus = 'ready';
    renderChainDetail();
    if (window.innerWidth <= 900) {
      const detail = $('chainDetail');
      if (detail) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }).catch(function (err) {
    if (state.chainEventId !== id) return;
    state.chainEventStatus = 'error';
    state.chainEventError = err && err.message ? err.message : '未知错误';
    renderChainDetail();
    showError('读取业务事项详情失败：' + state.chainEventError);
  });
}

async function loadTaxNav(force) {
  if (state.taxNavStatus === 'loading' && !force) return;
  state.taxNavStatus = 'loading';
  state.taxNavError = '';
  if (state.page === 'tax' && state.taxTab === 'nav') renderTaxTabBody();
  try {
    const data = await api.taxNavigation();
    state.taxNav = Array.isArray(data.navigation) ? data.navigation : [];
    state.taxNavStatus = 'ready';
    updateTaxTabCounts();
    if (state.page === 'tax') {
      if (state.taxTab === 'nav') renderTaxTabBody();
      if (state.taxTab === 'chain' && state.chainEvent) renderChainDetail();
    }
  } catch (err) {
    state.taxNavStatus = 'error';
    state.taxNavError = err && err.message ? err.message : '未知错误';
    updateTaxTabCounts();
    if (state.page === 'tax' && state.taxTab === 'nav') renderTaxTabBody();
    showError('读取税种导航失败：' + state.taxNavError);
  }
}

async function loadChainEvents(force) {
  if (state.chainStatus === 'loading' && !force) return;
  state.chainStatus = 'loading';
  state.chainError = '';
  if (state.page === 'tax' && state.taxTab === 'chain') renderTaxTabBody();
  try {
    const data = await api.chainEvents();
    state.chainGroups = Array.isArray(data.groups) ? data.groups : [];
    state.chainStatus = 'ready';
    updateTaxTabCounts();
    if (state.page === 'tax' && state.taxTab === 'chain') renderTaxTabBody();
  } catch (err) {
    state.chainStatus = 'error';
    state.chainError = err && err.message ? err.message : '未知错误';
    updateTaxTabCounts();
    if (state.page === 'tax' && state.taxTab === 'chain') renderTaxTabBody();
    showError('读取税会智链失败：' + state.chainError);
  }
}

function ensureTaxData() {
  if (state.taxNavStatus === 'idle') loadTaxNav();
  if (state.chainStatus === 'idle') loadChainEvents();
}


/* ============================ 政策库 ============================ */

function titleOf(id) {
  return state.policyTitles[id] || id || '—';
}

function safeUrl(url) {
  const s = String(url || '');
  if (s.indexOf('https://') === 0 || s.indexOf('http://') === 0) return s;
  return '';
}

function policyCountDisplay() {
  if (state.policyStatus === 'error' && !state.policyTotal) return '—';
  if (state.policyStatus === 'ready') return String(state.policyTotal);
  if (state.policyStatus === 'loading' && !state.policyTotal) return '…';
  return '—';
}

function graphTotalDisplay() {
  if (state.graph && state.graph.stats) return String(state.graph.stats.total);
  if (state.graphStatus === 'loading') return '…';
  return '—';
}

function familyCountDisplay() {
  if (state.graph && Array.isArray(state.graph.families)) return String(state.graph.families.length);
  if (state.graphStatus === 'loading') return '…';
  return '—';
}

function updatePolicyStats() {
  const setText = function (id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  };
  setText('policyStatCount', policyCountDisplay());
  setText('policyStatRelations', graphTotalDisplay());
  setText('policyStatFamilies', familyCountDisplay());
  setText('policyTabSearchCount', state.policyStatus === 'ready' ? String(state.policyTotal) : '…');
  setText('policyTabGraphCount', state.graph && state.graph.stats ? String(state.graph.stats.total) : '…');
}

function policySearchHintHtml() {
  if (state.policyStatus === 'loading' || state.policyStatus === 'idle') return '<span>正在检索政策库…</span>';
  if (state.policyStatus === 'error') return '<span class="text-danger">检索失败，请查看下方错误提示后重试。</span>';
  const q = String(state.policyQuery || '').trim();
  if (q !== '') {
    return '关键词「<strong>' + esc(q) + '</strong>」命中 <strong>' + state.policyHits.length + '</strong> 条；政策库共 <strong>' + state.policyTotal + '</strong> 条。';
  }
  return '政策库共 <strong>' + state.policyTotal + '</strong> 条政策，当前显示 <strong>' + state.policyHits.length + '</strong> 条。点击任意结果查看要点、引用关系与版本族。';
}

function policyHitHtml(hit) {
  const q = state.policyQuery;
  const level = LEVEL_LABEL[hit.level] || hit.level || '—';
  return '<button type="button" class="policy-hit" data-action="open-policy" data-id="' + esc(hit.id) + '">' +
    '<span class="hit-top"><span class="hit-title">' + highlight(hit.title, q) + '</span><span class="hit-arrow" aria-hidden="true">›</span></span>' +
    '<span class="hit-meta">' +
      '<span class="hit-docno">' + esc(hit.documentNo || '') + '</span>' +
      '<span>' + esc(hit.issuer || '') + '</span>' +
      '<span>施行 ' + esc(hit.effectiveFrom || '—') + '</span>' +
      lifecycleBadge(hit.lifecycle) + badge(level, 'badge-outline') +
    '</span>' +
    '<span class="hit-summary">' + highlight(hit.summary || '', q) + '</span>' +
    (hit.snippet ? '<span class="hit-snippet">' + highlight(hit.snippet, q) + '</span>' : '') +
  '</button>';
}

function policyResultsHtml() {
  if (state.policyStatus === 'loading' || state.policyStatus === 'idle') {
    return skeletonCard(4) + skeletonCard(4) + skeletonCard(4);
  }
  if (state.policyStatus === 'error') {
    return errorState(state.policyError, 'retry-policy');
  }
  if (!state.policyHits || state.policyHits.length === 0) {
    const q = String(state.policyQuery || '').trim();
    return emptyState(
      q === '' ? '政策库暂时没有数据' : '没有找到匹配的政策',
      q === '' ? '请确认 data/policy 下的政策文件已正确加载。' : '试试更短的关键词，或换用文号、发文机关、税种名称检索。',
      q === '' ? '' : '清空搜索',
      q === '' ? '' : 'policy-clear'
    );
  }
  return state.policyHits.map(policyHitHtml).join('');
}

function renderPolicyResults() {
  const box = $('policyResults');
  if (box) box.innerHTML = policyResultsHtml();
  const hint = $('policySearchHint');
  if (hint) hint.innerHTML = policySearchHintHtml();
  updatePolicyStats();
}

function policySearchBodyHtml() {
  return '<div class="card policy-search-card">' +
      '<div class="search-row">' +
        '<input id="policySearch" class="search-input" type="search" value="' + esc(state.policyQuery) + '" placeholder="输入文号、标题、发文机关或关键词…" autocomplete="off" spellcheck="false" aria-label="搜索政策">' +
        '<button type="button" class="btn btn-primary" data-action="policy-search">搜索</button>' +
      '</div>' +
      '<div class="search-hint" id="policySearchHint">' + policySearchHintHtml() + '</div>' +
    '</div>' +
    '<div id="policyResults" class="policy-list">' + policyResultsHtml() + '</div>';
}

function policyTypeRowsHtml(stats) {
  const types = ['amends', 'supersedes', 'repeals', 'based_on', 'implements', 'parallel'];
  const byType = stats.byType || {};
  let max = 1;
  for (let i = 0; i < types.length; i++) max = Math.max(max, Number(byType[types[i]] || 0));
  return types.map(function (type) {
    const count = Number(byType[type] || 0);
    const pct = Math.max(2, Math.round((count / max) * 100));
    return '<div class="type-row"><span class="type-label">' + esc(RELATION_TYPES[type] || type) + '</span>' +
      '<span class="type-bar-track"><span class="type-bar" style="width:' + pct + '%"></span></span>' +
      '<span class="type-count">' + count + '</span></div>';
  }).join('');
}

function policyGraphBodyHtml() {
  if (!state.graph) {
    if (state.graphStatus === 'error') return errorState(state.graphError, 'retry-graph');
    return skeletonCard(3) + '<div class="skeleton-block"></div>' + skeletonCard(4);
  }
  const graph = state.graph;
  const stats = graph.stats || {};
  const hubs = graph.hubs || [];
  const families = graph.families || [];
  const edges = graph.edges || [];
  const shownEdges = edges.slice(0, 50);

  const hubHtml = hubs.map(function (hub, i) {
    return '<li class="hub-item"><span class="hub-rank">' + (i + 1) + '</span>' +
      '<button type="button" class="link-btn hub-title" data-action="open-policy" data-id="' + esc(hub.id) + '">' + esc(hub.title) + '</button>' +
      '<span class="hub-degree">' + esc(hub.degree) + ' 条关系</span></li>';
  }).join('');

  const familyHtml = families.map(function (family) {
    return '<div class="family-item"><span>' + esc(family.name) + '</span><em>' + esc(family.size) + ' 个成员</em></div>';
  }).join('');

  const edgeHtml = shownEdges.map(function (edge) {
    return '<tr><td>' + esc(titleOf(edge.from)) + '</td><td>' + esc(titleOf(edge.to)) + '</td>' +
      '<td class="edge-type">' + badge(relationLabel(edge.type), 'badge-soft') + '</td>' +
      '<td class="hint">' + esc(edge.note || '') + '</td></tr>';
  }).join('');

  return '<div class="graph-top">' +
      '<div class="card"><div class="card-head"><div><h2>关系类型分布</h2><p class="card-sub">修改、替代、废止、制定依据、贯彻落实与关联平行。</p></div>' + badge('共 ' + esc(stats.total) + ' 条', 'badge-soft') + '</div>' +
        '<div class="type-stats">' + policyTypeRowsHtml(stats) + '</div></div>' +
      '<div class="card"><div class="card-head"><div><h2>枢纽政策</h2><p class="card-sub">关系数量最多的政策，通常是制度主干。</p></div>' + badge('前 ' + hubs.length + ' 名', 'badge-soft') + '</div>' +
        '<ul class="hub-list">' + (hubHtml || '<li class="hint">暂无枢纽政策数据</li>') + '</ul></div>' +
    '</div>' +
    '<div class="card"><div class="card-head"><div><h2>版本族</h2><p class="card-sub">同一制度沿革下的政策版本集合。</p></div>' + badge(families.length + ' 个', 'badge-soft') + '</div>' +
      '<div class="family-grid">' + (familyHtml || '<p class="hint">暂无版本族数据</p>') + '</div></div>' +
    '<div class="card"><div class="card-head"><div><h2>关系明细</h2><p class="card-sub">展示前 ' + shownEdges.length + ' 条（共 ' + edges.length + ' 条），点击枢纽政策可查看详情。</p></div></div>' +
      '<div class="table-wrap"><table class="data-table edge-table"><thead><tr><th>起点政策</th><th>指向政策</th><th style="width:96px">关系</th><th style="width:38%">说明</th></tr></thead><tbody>' +
        (edgeHtml || '<tr><td colspan="4" class="table-empty">暂无关系数据</td></tr>') +
      '</tbody></table></div></div>';
}

function policyTabBodyHtml() {
  if (state.policyTab === 'graph') return policyGraphBodyHtml();
  return policySearchBodyHtml();
}

function renderPolicyTabBody() {
  const body = $('policyTabBody');
  if (!body) return;
  body.innerHTML = policyTabBodyHtml();
  updatePolicyStats();
}

function renderPolicy() {
  const root = $('policyRoot');
  if (!root) return;
  root.innerHTML = '<div class="page-block"><div class="policy-stats">' +
      '<div class="policy-stat"><span class="policy-stat-icon" aria-hidden="true">政</span><div><div class="policy-stat-label">政策条数</div><div class="policy-stat-value" id="policyStatCount">' + esc(policyCountDisplay()) + '</div><div class="policy-stat-sub">政策库收录的文件</div></div></div>' +
      '<div class="policy-stat"><span class="policy-stat-icon navy" aria-hidden="true">关</span><div><div class="policy-stat-label">关系条数</div><div class="policy-stat-value" id="policyStatRelations">' + esc(graphTotalDisplay()) + '</div><div class="policy-stat-sub">政策之间的引用与沿革</div></div></div>' +
      '<div class="policy-stat"><span class="policy-stat-icon green" aria-hidden="true">族</span><div><div class="policy-stat-label">版本族</div><div class="policy-stat-value" id="policyStatFamilies">' + esc(familyCountDisplay()) + '</div><div class="policy-stat-sub">同一制度的版本集合</div></div></div>' +
    '</div>' +
    '<div class="card tax-tabs-card"><div class="tabs" role="tablist" aria-label="政策库功能">' +
      '<button type="button" class="tab' + (state.policyTab === 'search' ? ' active' : '') + '" role="tab" aria-selected="' + (state.policyTab === 'search' ? 'true' : 'false') + '" data-action="policy-tab" data-tab="search">政策检索<span class="tab-count" id="policyTabSearchCount">' + esc(state.policyStatus === 'ready' ? String(state.policyTotal) : '…') + '</span></button>' +
      '<button type="button" class="tab' + (state.policyTab === 'graph' ? ' active' : '') + '" role="tab" aria-selected="' + (state.policyTab === 'graph' ? 'true' : 'false') + '" data-action="policy-tab" data-tab="graph">关系总览<span class="tab-count" id="policyTabGraphCount">' + esc(state.graph && state.graph.stats ? String(state.graph.stats.total) : '…') + '</span></button>' +
    '</div></div>' +
    '<div id="policyTabBody" class="tab-body">' + policyTabBodyHtml() + '</div></div>';
  updatePolicyStats();
}

async function loadPolicySearch(query, silent, force) {
  if (!force && state.policyStatus === 'loading') return;
  const q = String(query || '');
  state.policyQuery = q;
  state.policyStatus = 'loading';
  state.policyError = '';
  state.policyReq += 1;
  const req = state.policyReq;
  if (!silent) {
    updatePolicyStats();
    if (state.page === 'policy' && state.policyTab === 'search') renderPolicyResults();
  }
  try {
    const data = await api.searchPolicies(q, 200);
    if (req !== state.policyReq) return;
    state.policyHits = Array.isArray(data.hits) ? data.hits : [];
    state.policyTotal = Number(data.total) || 0;
    state.policyStats = data.stats || null;
    for (let i = 0; i < state.policyHits.length; i++) {
      const hit = state.policyHits[i];
      state.policyTitles[hit.id] = hit.title;
    }
    state.policyStatus = 'ready';
    updatePolicyStats();
    if (state.page === 'policy' && state.policyTab === 'search') renderPolicyResults();
  } catch (err) {
    if (req !== state.policyReq) return;
    state.policyStatus = 'error';
    state.policyError = err && err.message ? err.message : '未知错误';
    updatePolicyStats();
    if (state.page === 'policy' && state.policyTab === 'search') renderPolicyResults();
    showError('政策检索失败：' + state.policyError);
  }
}

async function loadPolicyGraph(force) {
  if (!force && state.graphStatus === 'loading') return;
  state.graphStatus = 'loading';
  state.graphError = '';
  if (state.page === 'policy' && state.policyTab === 'graph') renderPolicyTabBody();
  try {
    const data = await api.policyGraph();
    state.graph = data;
    state.graphStatus = 'ready';
    updatePolicyStats();
    if (state.page === 'policy' && state.policyTab === 'graph') renderPolicyTabBody();
  } catch (err) {
    state.graphStatus = 'error';
    state.graphError = err && err.message ? err.message : '未知错误';
    updatePolicyStats();
    if (state.page === 'policy' && state.policyTab === 'graph') renderPolicyTabBody();
    showError('读取政策关系图谱失败：' + state.graphError);
  }
}

function ensurePolicyData() {
  if (state.policyStatus === 'idle') loadPolicySearch('', true);
  if (state.graphStatus === 'idle') loadPolicyGraph();
}

function relationGroupHtml(title, relations, direction) {
  if (!relations || relations.length === 0) {
    return '<div class="relation-group"><div class="relation-group-head"><strong>' + esc(title) + '</strong></div><p class="hint">暂无此类关系。</p></div>';
  }
  const items = relations.map(function (rel) {
    const otherId = direction === 'out' ? rel.to : rel.from;
    return '<div class="relation-item"><div class="relation-line">' +
        '<span class="relation-type">' + badge(relationLabel(rel.type), 'badge-info') + '</span>' +
        '<button type="button" class="link-btn relation-policy" data-action="open-policy" data-id="' + esc(otherId) + '">' + esc(titleOf(otherId)) + '</button>' +
      '</div>' + (rel.note ? '<p class="relation-note">' + esc(rel.note) + '</p>' : '') + '</div>';
  }).join('');
  return '<div class="relation-group"><div class="relation-group-head"><strong>' + esc(title) + '</strong>' + badge(relations.length + ' 条', 'badge-soft') + '</div>' + items + '</div>';
}

function policyDetailHtml(dossier) {
  const p = dossier.policy || {};
  const outRelations = dossier.outRelations || [];
  const inRelations = dossier.inRelations || [];
  const family = dossier.family || [];
  const events = dossier.events || [];
  const keyPoints = p.keyPoints || [];
  const taxTypes = p.taxTypes || p.taxCodes || [];
  const tags = p.tags || [];
  const level = LEVEL_LABEL[p.level] || p.level || '—';
  const url = safeUrl(p.url);

  const metaRows = [
    ['发文机关', p.issuer || '—'],
    ['文号', p.documentNo || '—'],
    ['发布日期', p.issuedAt || '—'],
    ['施行日期', p.effectiveFrom || '—'],
    ['失效日期', p.effectiveTo || '—'],
    ['效力层级', level],
    ['税种', taxTypes.length > 0 ? taxTypes.map(taxLabel).join('、') : '—'],
  ];
  if (p.region) metaRows.push(['适用地区', p.region]);

  const metaHtml = metaRows.map(function (row) {
    return '<div class="detail-term">' + esc(row[0]) + '</div><div class="detail-value">' + esc(row[1]) + '</div>';
  }).join('');

  const keyPointHtml = keyPoints.length === 0
    ? '<p class="hint">暂无要点提炼。</p>'
    : '<ul class="keypoints">' + keyPoints.map(function (point) { return '<li>' + esc(point) + '</li>'; }).join('') + '</ul>';

  const familyHtml = family.length === 0
    ? '<p class="hint">该政策没有登记版本族。</p>'
    : '<div class="family-chips">' + family.map(function (member) {
        const l = LIFECYCLE[member.lifecycle] || { label: member.lifecycle || '—' };
        return '<button type="button" class="family-chip' + (member.id === p.id ? ' current' : '') + '" data-action="open-policy" data-id="' + esc(member.id) + '">' +
          esc(member.title) + '<span>' + esc(member.documentNo || '') + ' · ' + esc(l.label) + '</span></button>';
      }).join('') + '</div>';

  const eventHtml = events.length === 0
    ? '<p class="hint">该政策没有关联业务事项。</p>'
    : '<div class="event-chips">' + events.map(function (event) {
        return '<span class="event-chip">' + esc(event.name) + '</span>';
      }).join('') + '</div>';

  const tagHtml = tags.length === 0 ? '' : '<div class="detail-badge-row">' + tags.map(function (tag) { return badge(tag, 'badge-muted'); }).join('') + '</div>';

  return '<div class="detail-badge-row">' + lifecycleBadge(p.lifecycle) + badge(level, 'badge-outline') +
      taxTypes.map(function (tax) { return badge(taxLabel(tax), 'badge-soft'); }).join('') + '</div>' +
    '<div class="detail-grid">' + metaHtml + '</div>' +
    (p.summary ? '<div class="detail-section"><h4>政策摘要</h4><p class="hit-summary">' + esc(p.summary) + '</p></div>' : '') +
    '<div class="detail-section"><h4>政策要点</h4>' + keyPointHtml + '</div>' +
    '<div class="detail-section"><h4>引用关系</h4>' +
      relationGroupHtml('本政策影响的其他政策', outRelations, 'out') +
      relationGroupHtml('其他政策对本政策的关系', inRelations, 'in') +
    '</div>' +
    '<div class="detail-section"><h4>版本族</h4>' + familyHtml + '</div>' +
    '<div class="detail-section"><h4>关联业务事项</h4>' + eventHtml + '</div>' +
    (tagHtml ? '<div class="detail-section"><h4>标签</h4>' + tagHtml + '</div>' : '') +
    (url ? '<a class="source-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">查看官方原文 ↗</a>' : '') +
    (dossier.notice ? '<div class="notice-box">' + esc(dossier.notice) + '</div>' : '');
}

function renderDrawer() {
  const body = $('drawerBody');
  if (!body) return;
  if (state.detailStatus === 'loading') {
    body.innerHTML = '<div class="skeleton-card"><div class="skeleton-line w40"></div><div class="skeleton-line"></div><div class="skeleton-line w80"></div><div class="skeleton-line"></div><div class="skeleton-line w60"></div></div><div class="skeleton-block"></div>';
    return;
  }
  if (state.detailStatus === 'error') {
    body.innerHTML = errorState(state.detailError, 'retry-policy-detail');
    return;
  }
  if (!state.detail) {
    body.innerHTML = loadingState('正在读取政策详情…');
    return;
  }
  body.innerHTML = policyDetailHtml(state.detail);
}

function fetchPolicyDetail(id) {
  if (!id) return;
  const req = state.detailReq + 1;
  state.detailReq = req;
  state.detailStatus = 'loading';
  state.detailError = '';
  renderDrawer();
  api.policy(id).then(function (data) {
    if (req !== state.detailReq || state.detailId !== id) return;
    state.detail = data;
    state.detailStatus = 'ready';
    if (data.policy && data.policy.title) {
      state.policyTitles[data.policy.id] = data.policy.title;
      const title = $('drawerTitle');
      if (title) title.textContent = data.policy.title;
    }
    renderDrawer();
  }).catch(function (err) {
    if (req !== state.detailReq || state.detailId !== id) return;
    state.detailStatus = 'error';
    state.detailError = err && err.message ? err.message : '未知错误';
    renderDrawer();
    showError('读取政策详情失败：' + state.detailError);
  });
}

function openPolicy(id) {
  if (!id) return;
  const drawer = $('policyDrawer');
  const overlay = $('drawerOverlay');
  if (!drawer || !overlay) return;
  state.lastFocus = document.activeElement;
  state.detailId = id;
  state.detail = null;
  state.detailStatus = 'loading';
  state.detailError = '';
  state.detailReq += 1;
  drawer.hidden = false;
  overlay.hidden = false;
  const title = $('drawerTitle');
  if (title) title.textContent = '政策详情';
  renderDrawer();
  const drawerBody = $('drawerBody');
  if (drawerBody) drawerBody.scrollTop = 0;
  state.drawerOpen = true;
  document.body.classList.add('drawer-open');
  requestAnimationFrame(function () {
    drawer.classList.add('open');
    overlay.classList.add('open');
  });
  setTimeout(function () {
    const close = document.querySelector('.drawer-close');
    if (close) close.focus();
  }, 60);
  fetchPolicyDetail(id);
}

function closeDrawer(immediate) {
  const drawer = $('policyDrawer');
  const overlay = $('drawerOverlay');
  if (!drawer || !overlay) return;
  const wasOpen = state.drawerOpen;
  state.drawerOpen = false;
  state.detailId = '';
  state.detail = null;
  state.detailReq += 1;
  document.body.classList.remove('drawer-open');
  drawer.classList.remove('open');
  overlay.classList.remove('open');
  if (immediate) {
    drawer.hidden = true;
    overlay.hidden = true;
  } else {
    setTimeout(function () {
      if (!drawer.classList.contains('open')) {
        drawer.hidden = true;
        overlay.hidden = true;
      }
    }, 260);
  }
  if (!immediate && wasOpen && state.lastFocus && typeof state.lastFocus.focus === 'function') {
    try { state.lastFocus.focus(); } catch (err) { /* 忽略失焦元素 */ }
  }
}

/* ============================ 审计页 ============================ */

function auditActionLabel(action) {
  const map = {
    create: '新增', update: '更新', delete: '删除', sign: '签署',
    review: '复核', approve: '审批', waive: '豁免', verify: '校验', filed: '申报',
  };
  return map[action] || action || '—';
}

function auditEntityLabel(entity) {
  const map = {
    voucher: '凭证', tax_return: '申报表', document: '单据', statement: '报表',
    policy: '政策', filing: '申报', account: '科目', review: '审核结论', audit: '审计事件',
  };
  return map[entity] || entity || '—';
}

function auditOrphans(report) {
  const orphans = report && Array.isArray(report.orphans) ? report.orphans : [];
  if (orphans.length === 0) return '';
  const items = orphans.map(function (o) {
    if (typeof o === 'string') return '<li>' + esc(o) + '</li>';
    if (o && typeof o === 'object') return '<li>' + esc(o.id || o.entityId || o.seq || JSON.stringify(o)) + '</li>';
    return '<li>' + esc(String(o)) + '</li>';
  }).join('');
  return '<div class="broken"><strong>孤立版本记录（' + orphans.length + ' 条）</strong><ul>' + items + '</ul></div>';
}

function renderAudit() {
  const root = $('auditRoot');
  if (!root) return;
  if (!state.audit) {
    if (state.auditStatus === 'error') {
      root.innerHTML = '<div class="page-block"><div class="card">' + errorState(state.auditError, 'retry-audit') + '</div></div>';
    } else {
      root.innerHTML = '<div class="page-block"><div class="card"><div class="loading-inline"><span class="spinner" aria-hidden="true"></span><span>正在校验审计哈希链…</span></div></div>' +
        skeletonCard(3) + skeletonCard(5) + '</div>';
    }
    return;
  }
  const report = state.audit.report || {};
  const recent = state.audit.recent || [];
  const ok = report.ok === true;
  const rows = recent.map(function (event) {
    return '<tr>' +
      '<td class="audit-seq">' + esc(event.seq) + '</td>' +
      '<td class="nowrap">' + esc(fmtDateTime(event.at)) + '</td>' +
      '<td>' + esc(event.actor || '—') + '</td>' +
      '<td><span class="action-tag">' + esc(auditActionLabel(event.action)) + '</span></td>' +
      '<td>' + esc(auditEntityLabel(event.entity)) + '</td>' +
      '<td><span class="entity-id" title="' + esc(event.entityId || '') + '">' + esc(event.entityId || '—') + '</span></td>' +
      '<td class="reason">' + esc(event.reason || '—') + '</td>' +
    '</tr>';
  }).join('');

  root.innerHTML = '<div class="page-block">' +
    '<div class="card integrity' + (ok ? '' : ' bad') + '">' +
      '<span class="integrity-icon" aria-hidden="true">' + (ok ? '✓' : '!') + '</span>' +
      '<div class="integrity-body">' +
        '<div class="integrity-title">' + (ok ? '哈希链完整' : '哈希链不完整') + (ok ? badge('校验通过', 'badge-success') : badge('需要排查', 'badge-danger')) + '</div>' +
        '<p class="integrity-text">' + (ok ? '所有审计事件按序号首尾相连，未发现断链、孤立版本记录或校验失败。' : '审计事件链校验失败，请立即停止写入并排查审计库。') + '</p>' +
        (!ok && report.brokenAt !== null && report.brokenAt !== undefined ? '<div class="broken">断链位置：第 ' + esc(report.brokenAt) + ' 条事件</div>' : '') +
        auditOrphans(report) +
        '<div class="integrity-stats">' +
          '<div class="integrity-stat"><span>审计事件</span><strong>' + esc(report.events) + '</strong></div>' +
          '<div class="integrity-stat"><span>版本记录</span><strong>' + esc(report.versionRecords) + '</strong></div>' +
          '<div class="integrity-stat"><span>孤立记录</span><strong>' + (Array.isArray(report.orphans) ? report.orphans.length : 0) + '</strong></div>' +
          '<div class="integrity-stat"><span>校验时间</span><strong>' + esc(fmtDateTime(report.checkedAt)) + '</strong></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-head"><div><h2>最近审计事件</h2><p class="card-sub">最近 50 条操作记录，按时间倒序。所有修改均以追加版本留痕。</p></div>' +
        '<div class="audit-actions"><span class="hint">' + recent.length + ' 条</span><button type="button" class="btn btn-ghost btn-sm" data-action="audit-refresh">刷新</button></div></div>' +
      '<div class="table-wrap"><table class="data-table audit-table"><thead><tr>' +
        '<th style="width:64px">序号</th><th style="width:138px">时间</th><th>操作人</th><th style="width:76px">动作</th><th>实体</th><th>实体 ID</th><th>理由</th>' +
      '</tr></thead><tbody>' + (rows || '<tr><td colspan="7" class="table-empty">暂无审计事件。完成一次月结后会生成留痕记录。</td></tr>') + '</tbody></table></div>' +
    '</div>' +
    '<div class="card"><div class="card-head"><div><h2>审计说明</h2><p class="card-sub">为什么这套留痕不能被悄悄修改。</p></div>' + badge('追加式审计', 'badge-primary') + '</div>' +
      '<div class="explain-list">' +
        '<div class="explain-item"><strong>所有修改都是追加版本</strong><p>每次保存都会写入新的版本记录，旧版本不会被覆盖，可按时间回放。</p></div>' +
        '<div class="explain-item"><strong>删除是软删除</strong><p>删除只标记状态，不物理清除数据；仍可在审计库中追溯原始内容与操作人。</p></div>' +
        '<div class="explain-item"><strong>哈希链保证不可悄悄篡改</strong><p>每条事件包含前一条事件的哈希；任何改动都会导致后续链断裂，被完整性校验发现。</p></div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

async function loadAudit(force) {
  if (state.auditStatus === 'loading' && !force) return;
  state.auditStatus = 'loading';
  state.auditError = '';
  if (state.page === 'audit') renderAudit();
  try {
    const data = await api.auditIntegrity();
    state.audit = data;
    state.auditStatus = 'ready';
    if (state.page === 'audit') renderAudit();
  } catch (err) {
    state.auditStatus = 'error';
    state.auditError = err && err.message ? err.message : '未知错误';
    if (state.page === 'audit') renderAudit();
    showError('读取审计完整性失败：' + state.auditError);
  }
}

function ensureAudit() {
  if (state.auditStatus === 'idle') loadAudit();
}

/* ============================ 路由 ============================ */

function renderPage(name) {
  if (name === 'bookkeeping') renderBookkeeping();
  else if (name === 'review') renderReview();
  else if (name === 'statements') renderStatements();
  else if (name === 'tax') { ensureTaxData(); renderTax(); }
  else if (name === 'policy') { ensurePolicyData(); renderPolicy(); }
  else if (name === 'audit') { ensureAudit(); renderAudit(); }
  else renderWorkbench();
}

function handleRoute() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').split('?')[0].split('/')[0];
  let name = raw;
  if (!PAGES[name]) {
    name = 'workbench';
    history.replaceState(null, '', '#/workbench');
  }
  state.page = name;
  if (state.drawerOpen) closeDrawer(true);
  const sections = document.querySelectorAll('.page');
  for (let i = 0; i < sections.length; i++) {
    sections[i].hidden = sections[i].getAttribute('data-page') !== name;
  }
  const links = document.querySelectorAll('.nav-link');
  for (let i = 0; i < links.length; i++) {
    const active = links[i].getAttribute('data-nav') === name;
    links[i].classList.toggle('active', active);
    if (active) links[i].setAttribute('aria-current', 'page');
    else links[i].removeAttribute('aria-current');
  }
  const page = PAGES[name];
  const title = $('pageTitle');
  const subtitle = $('pageSubtitle');
  if (title) title.textContent = page.title;
  if (subtitle) subtitle.textContent = page.subtitle;
  document.title = '账有律 · ' + page.title;
  renderPage(name);
  window.scrollTo(0, 0);
}

/* ============================ 动作 ============================ */

function exportMonthly() {
  const dto = state.close;
  if (!dto || !dto.markdown || !dto.markdown.monthly) {
    showError('当前没有可导出的月结报告，请先完成一次月结。');
    return;
  }
  downloadText(dto.markdown.monthly, '账有律-月结报告-' + (dto.period || '') + '.md', 'text/markdown;charset=utf-8');
  showToast('月结报告已开始下载');
}

function refreshCurrentPage() {
  if (state.page === 'workbench') {
    loadMeta(true);
    showToast('正在刷新系统配置…');
  } else if (state.page === 'policy') {
    loadPolicySearch(state.policyQuery, false, true);
    loadPolicyGraph(true);
    showToast('正在刷新政策库…');
  } else if (state.page === 'tax') {
    loadTaxNav(true);
    loadChainEvents(true);
    if (state.chainEventId) selectChainEvent(state.chainEventId);
    showToast('正在刷新税种与智链数据…');
  } else if (state.page === 'audit') {
    loadAudit(true);
  } else {
    showToast('当前页数据来自最近一次月结；重新运行月结后会同步更新');
  }
}

function schedulePolicySearch() {
  if (policySearchTimer) clearTimeout(policySearchTimer);
  policySearchTimer = setTimeout(function () {
    policySearchTimer = null;
    loadPolicySearch(state.policyQuery, false, true);
  }, 320);
}

function resetReviewFilter() {
  state.reviewFilter = { severity: 'all', category: 'all', blockingOnly: false };
  renderReview();
}

/* ============================ 事件绑定 ============================ */

function handleClick(event) {
  const target = event.target.closest ? event.target.closest('[data-action]') : null;
  if (!target) return;
  const action = target.getAttribute('data-action');
  if (action === 'skip-main') {
    event.preventDefault();
    const main = $('main');
    if (main) {
      main.setAttribute('tabindex', '-1');
      main.focus();
    }
  } else if (action === 'dismiss-error') clearErrorBar();
  else if (action === 'refresh-page') refreshCurrentPage();
  else if (action === 'goto-workbench') location.hash = '#/workbench';
  else if (action === 'goto-review') location.hash = '#/review';
  else if (action === 'remove-file') removeFile(target.getAttribute('data-id'));
  else if (action === 'start-close') runMonthClose();
  else if (action === 'clear-files') clearFiles();
  else if (action === 'export-monthly') exportMonthly();
  else if (action === 'retry-meta') loadMeta(true);
  else if (action === 'statement-tab') {
    state.statementTab = target.getAttribute('data-kind');
    renderStatements();
  } else if (action === 'review-severity') {
    state.reviewFilter.severity = target.getAttribute('data-sev') || 'all';
    renderReviewFindings();
  } else if (action === 'reset-review') resetReviewFilter();
  else if (action === 'tax-tab') {
    state.taxTab = target.getAttribute('data-tab') || 'returns';
    renderTax();
  } else if (action === 'select-event') selectChainEvent(target.getAttribute('data-id'));
  else if (action === 'retry-tax-nav') loadTaxNav(true);
  else if (action === 'retry-chain') loadChainEvents(true);
  else if (action === 'retry-event') selectChainEvent(state.chainEventId);
  else if (action === 'policy-tab') {
    state.policyTab = target.getAttribute('data-tab') || 'search';
    renderPolicy();
  } else if (action === 'policy-search') {
    if (policySearchTimer) { clearTimeout(policySearchTimer); policySearchTimer = null; }
    loadPolicySearch(state.policyQuery, false, true);
  } else if (action === 'policy-clear') {
    state.policyQuery = '';
    const input = $('policySearch');
    if (input) { input.value = ''; input.focus(); }
    loadPolicySearch('', false, true);
  } else if (action === 'retry-policy') loadPolicySearch(state.policyQuery, false, true);
  else if (action === 'retry-graph') loadPolicyGraph(true);
  else if (action === 'open-policy') openPolicy(target.getAttribute('data-id'));
  else if (action === 'close-drawer') closeDrawer(false);
  else if (action === 'retry-policy-detail') fetchPolicyDetail(state.detailId);
  else if (action === 'retry-audit') loadAudit(true);
  else if (action === 'audit-refresh') loadAudit(true);
}

function handleInput(event) {
  const id = event.target && event.target.id;
  if (id === 'voucherFilter') {
    state.voucherQuery = event.target.value;
    renderVoucherRows();
  } else if (id === 'policySearch') {
    state.policyQuery = event.target.value;
    schedulePolicySearch();
  }
}

function handleChange(event) {
  const id = event.target && event.target.id;
  if (id === 'periodInput') {
    state.period = event.target.value;
    updateHeader();
    if (state.close) showToast('会计期间已切换为 ' + state.period + '；重新月结后结果将更新');
  } else if (id === 'standardSelect') {
    state.standard = event.target.value;
    updateHeader();
    if (state.page === 'workbench') renderMeta();
  } else if (id === 'reviewCategory') {
    state.reviewFilter.category = event.target.value;
    renderReviewFindings();
  } else if (id === 'reviewBlocking') {
    state.reviewFilter.blockingOnly = event.target.checked;
    renderReviewFindings();
  }
}

function handleKeydown(event) {
  if (event.key === 'Enter' && event.target && event.target.id === 'policySearch') {
    event.preventDefault();
    if (policySearchTimer) { clearTimeout(policySearchTimer); policySearchTimer = null; }
    loadPolicySearch(state.policyQuery, false, true);
    return;
  }
  if (event.key === 'Escape' && state.drawerOpen) {
    closeDrawer(false);
  }
}

function bindDropzone() {
  const zone = $('dropzone');
  const input = $('fileInput');
  if (!zone || !input) return;
  zone.addEventListener('click', function (event) {
    if (state.closeStatus === 'running') return;
    if (event.target === input) return;
    input.click();
  });
  zone.addEventListener('keydown', function (event) {
    if (state.closeStatus === 'running') return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  const dragOn = function (event) {
    event.preventDefault();
    zone.classList.add('dragover');
  };
  const dragOff = function (event) {
    event.preventDefault();
    zone.classList.remove('dragover');
  };
  zone.addEventListener('dragenter', dragOn);
  zone.addEventListener('dragover', dragOn);
  zone.addEventListener('dragleave', dragOff);
  zone.addEventListener('drop', function (event) {
    event.preventDefault();
    zone.classList.remove('dragover');
    if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files);
  });
  input.addEventListener('change', function () {
    addFiles(input.files);
    input.value = '';
  });
  document.addEventListener('dragover', function (event) {
    if (event.dataTransfer) event.preventDefault();
  });
  document.addEventListener('drop', function (event) {
    if (event.target && event.target.closest && event.target.closest('#dropzone')) return;
    event.preventDefault();
  });
}

/* ============================ 启动 ============================ */

function init() {
  bindDropzone();
  document.addEventListener('click', handleClick);
  document.addEventListener('input', handleInput);
  document.addEventListener('change', handleChange);
  document.addEventListener('keydown', handleKeydown);
  const overlay = $('drawerOverlay');
  if (overlay) overlay.addEventListener('click', function () { closeDrawer(false); });
  const periodInput = $('periodInput');
  if (periodInput) periodInput.value = state.period;
  const select = $('standardSelect');
  if (select) select.value = state.standard;
  updateHeader();
  handleRoute();
  loadMeta();
  window.addEventListener('hashchange', handleRoute);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}



