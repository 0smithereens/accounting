/**
 * 中文文本规范化与模糊匹配。
 *
 * 银行流水、发票、报销单的摘要文本充满噪声：
 *  - 全角/半角混用：「手续费（电汇）」
 *  - 多余空白与不可见字符
 *  - 同义表述：「服务费」/「服务费用」/「服务 费」
 * 规则引擎需要一个归一化的文本域来做关键字匹配。
 */

/** 全角 → 半角，压缩空白，统一括号，去掉不可见字符。 */
export function normalizeText(input: unknown): string {
  if (input === null || input === undefined) return '';
  let s = String(input);

  // 全角 ASCII → 半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  // 全角空格、不换行空格
  s = s.replace(/[\u3000\u00A0\u2007\u202F]/g, ' ');
  // 零宽字符与 BOM
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  // 统一括号
  s = s.replace(/[（【〔〖]/g, '(').replace(/[）】〕〗]/g, ')');
  // 统一冒号
  s = s.replace(/[：]/g, ':');
  // 连续空白压缩为单个空格
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

/** 规范化并去除所有空白，用于需要「紧密匹配」的场景。 */
export function compactText(input: unknown): string {
  return normalizeText(input).replace(/\s+/g, '');
}

/** 只保留数字，用于提取账号、发票号、税号等。 */
export function digitsOnly(input: unknown): string {
  return normalizeText(input).replace(/\D/g, '');
}

/** 去除非中英文数字字符，用于公司名比对。 */
export function normalizeOrgName(input: unknown): string {
  let s = compactText(input);
  s = s.replace(/[()（）]/g, '');
  // 「有限公司」/「有限责任公司」统一
  s = s.replace(/有限责任公司/g, '有限公司');
  // 去掉常见城市前缀差异
  s = s.replace(/^(中国|中华人民共和国)/, '');
  return s;
}

/**
 * 关键字匹配：返回命中的关键字；未命中返回 null。
 * 匹配在规范化后的文本上进行，因此「服务 费」也能命中「服务费」。
 */
export function matchAnyKeyword(text: string, keywords: readonly string[]): string | null {
  if (keywords.length === 0) return null;
  const haystack = compactText(text);
  for (const kw of keywords) {
    const needle = compactText(kw);
    if (needle === '') continue;
    if (haystack.includes(needle)) return kw;
  }
  return null;
}

/**
 * 关键字匹配（区分语义边界）：所有关键字都必须出现。
 */
export function matchAllKeywords(text: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true;
  const haystack = compactText(text);
  for (const kw of keywords) {
    const needle = compactText(kw);
    if (needle === '' ) continue;
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** 安全的正则构造，非法正则返回 null 而不是抛异常。 */
export function safeRegex(pattern: string, flags = 'i'): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 相似度                                                              */
/* ------------------------------------------------------------------ */

/** 归一化编辑距离（0~1，1 表示完全相同）。 */
export function similarity(a: string, b: string): number {
  const s1 = compactText(a).toLowerCase();
  const s2 = compactText(b).toLowerCase();
  if (s1 === s2) return 1;
  if (s1 === '' || s2 === '') return 0;

  const len1 = s1.length;
  const len2 = s2.length;
  // 只在较短字符串上做滚动数组，控制内存
  let prev = new Array<number>(len2 + 1);
  let curr = new Array<number>(len2 + 1);
  for (let j = 0; j <= len2; j += 1) prev[j] = j;

  for (let i = 1; i <= len1; i += 1) {
    curr[0] = i;
    const c1 = s1.charCodeAt(i - 1);
    for (let j = 1; j <= len2; j += 1) {
      const cost = c1 === s2.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const distance = prev[len2] ?? Math.max(len1, len2);
  return 1 - distance / Math.max(len1, len2);
}

/**
 * 表头模糊匹配：在候选同义词中找最贴近的一个。
 * 返回最佳候选及其得分。
 */
export function bestMatch(
  header: string,
  candidates: readonly string[],
): { candidate: string; score: number } | null {
  const h = compactText(header).toLowerCase();
  if (h === '') return null;

  let best: { candidate: string; score: number } | null = null;
  for (const c of candidates) {
    const cn = compactText(c).toLowerCase();
    let score = similarity(h, cn);
    // 包含关系给予加成：「借方发生额」包含「借方」
    if (h === cn) score = 1;
    else if (h.includes(cn) || cn.includes(h)) {
      score = Math.max(score, 0.75 + (Math.min(h.length, cn.length) / Math.max(h.length, cn.length)) * 0.2);
    }
    if (best === null || score > best.score) best = { candidate: c, score };
  }
  return best;
}

/**
 * 摘要精简：截断过长摘要，用于生成凭证摘要。
 * 会计凭证摘要一般不超过 60 个字符。
 */
export function truncateSummary(text: string, maxLength = 60): string {
  const s = normalizeText(text);
  if (s.length <= maxLength) return s;
  return `${s.slice(0, maxLength - 1)}…`;
}

/** 判断单元格文本是否像「合计/小计」这类需要跳过的汇总行。 */
export function isTotalRow(text: string): boolean {
  const s = compactText(text);
  if (s === '') return false;
  return /^(合计|小计|总计|累计|本页合计|合\s*计|总\s*计|以上合计)$/.test(s);
}

/** 判断是否为空值单元格。 */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

/**
 * 从文本中提取「部门」「项目」等辅助核算线索。
 * 例如摘要「市场部-差旅费报销」→ 部门「市场部」。
 */
export function extractDepartment(text: string, knownDepartments: readonly string[]): string | null {
  const s = compactText(text);
  for (const dept of knownDepartments) {
    if (s.includes(compactText(dept))) return dept;
  }
  const m = /([\u4e00-\u9fa5]{2,8}(?:部|中心|分公司|事业部|车间|科室|处|组))/.exec(s);
  return m?.[1] ?? null;
}
