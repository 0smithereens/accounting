/**
 * 审核报告渲染。
 *
 * 为什么报告层要独立：审核引擎产出的是结构化数据（ReviewFinding[]），
 * 而用户最终看到的是「一份能拿去开会、能附在凭证后面、能给审计看的报告」。
 * 两者关注点不同：引擎关注判定，报告关注可读性与可追溯性。
 *
 * 渲染约定：
 *  - 每条结论必须展示：严重度、规则 id、定位、说明、整改建议、法规依据、证据；
 *  - 已豁免的结论保留在报告中并注明豁免人/时间/理由（豁免不是删除，仍要留痕）；
 *  - 报告末尾固定输出免责声明与检查项清单，证明「检查了什么、没检查什么」；
 *  - Markdown 与纯文本使用同一套数据，避免两种输出口径不一致。
 */

import type {
  LawBasis,
  ReviewFinding,
  ReviewReport,
  ReviewTarget,
  Severity,
} from '../core/contracts.ts';
import { ACCOUNTING_STANDARD_LABEL, REVIEW_CATEGORY_LABEL } from '../core/contracts.ts';
import { REVIEW_DISCLAIMER } from './legal.ts';

/* ================================================================== */
/* 一、展示常量                                                        */
/* ================================================================== */

const SEVERITY_LABEL: Record<Severity, string> = {
  error: '严重',
  warning: '警告',
  info: '提示',
};

const TARGET_KIND_LABEL: Record<ReviewTarget['kind'], string> = {
  voucher: '凭证',
  voucher_line: '分录行',
  document: '单据',
  tax_return: '申报表',
  statement: '财务报表',
  ledger: '账簿',
  policy: '政策',
  run: '运行',
};

function formatBasis(basis: LawBasis): string {
  const article = basis.article === undefined || basis.article === '' ? '' : basis.article;
  const effective =
    basis.effectiveFrom === undefined || basis.effectiveFrom === ''
      ? ''
      : `（${basis.effectiveFrom} 施行）`;
  const excerpt = basis.excerpt === undefined || basis.excerpt === '' ? '' : `：${basis.excerpt}`;
  return `《${basis.title}》${article}${effective}${excerpt}`;
}

function targetText(target: ReviewTarget): string {
  const label = target.label ?? target.id;
  return `${label}（${TARGET_KIND_LABEL[target.kind]}）`;
}

function verdictText(report: ReviewReport): string {
  return report.summary.passed ? '通过' : '未通过';
}

function verdictNote(report: ReviewReport): string {
  if (report.summary.passed) {
    return '未发现阻断项，可进入下一环节；报告内容仍须由会计人员复核确认。';
  }
  return (
    `存在 ${report.summary.blocking} 项阻断项、${report.summary.error} 项严重问题，` +
    '未整改不得进入下一环节。'
  );
}

function summaryLine(report: ReviewReport): string {
  const s = report.summary;
  return (
    `本次审核共执行 ${report.checksRun.length} 项检查，发现问题 ${s.total} 项` +
    `（严重 ${s.error} / 警告 ${s.warning} / 提示 ${s.info}），` +
    `其中阻断项 ${s.blocking} 项、已豁免 ${s.waived} 项，合规得分 ${s.score} 分。`
  );
}

/* ================================================================== */
/* 二、Markdown 渲染                                                   */
/* ================================================================== */

/**
 * 渲染为 Markdown。
 * 适合：Web 端展示、导出 PDF/Word、贴进邮件与工单。
 */
export function renderReviewMarkdown(report: ReviewReport): string {
  const lines: string[] = [];
  const s = report.summary;

  lines.push('# 合规审核报告');
  lines.push('');
  lines.push(`- **报告编号**：${report.id}`);
  lines.push(`- **审核期间**：${report.period}`);
  lines.push(`- **会计准则**：${ACCOUNTING_STANDARD_LABEL[report.standard]}`);
  lines.push(`- **审核时间**：${report.checkedAt}`);
  lines.push(`- **引擎版本**：${report.engineVersion}`);
  lines.push(`- **合规得分**：**${s.score} / 100**`);
  lines.push(`- **审核结论**：**${verdictText(report)}**`);
  lines.push('');

  lines.push('## 一、总体结论');
  lines.push('');
  lines.push(summaryLine(report));
  lines.push('');
  lines.push(`> ${verdictNote(report)}`);
  lines.push('');

  lines.push('## 二、问题清单');
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('本次审核未发现问题。');
    lines.push('');
  } else {
    report.findings.forEach((finding, index) => {
      lines.push(`### ${index + 1}. [${finding.severity}] ${finding.title}`);
      lines.push('');
      lines.push(`- **规则**：\`${finding.ruleId}\``);
      lines.push(`- **维度**：${REVIEW_CATEGORY_LABEL[finding.category]}`);
      lines.push(`- **定位**：${targetText(finding.target)}`);
      lines.push(`- **严重度**：${SEVERITY_LABEL[finding.severity]}${finding.blocking ? '（阻断项）' : ''}`);
      lines.push(`- **说明**：${finding.detail}`);
      lines.push(`- **整改建议**：${finding.suggestion}`);

      if (finding.basis.length > 0) {
        lines.push('- **法规依据**：');
        for (const basis of finding.basis) {
          lines.push(`  - ${formatBasis(basis)}`);
        }
      }

      if (finding.evidence !== undefined) {
        lines.push('- **证据**：');
        lines.push('');
        lines.push('  \`\`\`json');
        lines.push(`  ${JSON.stringify(finding.evidence)}`);
        lines.push('  \`\`\`');
      }

      if (finding.waived !== undefined) {
        lines.push(
          `- **已豁免**：${finding.waived.actor} 于 ${finding.waived.at} 豁免（${finding.waived.reason}）`,
        );
      }

      lines.push('');
    });
  }

  lines.push('## 三、检查项执行清单');
  lines.push('');
  lines.push('| # | 检查项 | 名称 | 维度 | 严重度 |');
  lines.push('| --- | --- | --- | --- | --- |');
  report.checksRun.forEach((check, index) => {
    lines.push(
      `| ${index + 1} | \`${check.id}\` | ${check.title} | ${REVIEW_CATEGORY_LABEL[check.category]} | ${check.severity} |`,
    );
  });
  lines.push('');

  lines.push('## 四、免责声明');
  lines.push('');
  lines.push(REVIEW_DISCLAIMER);
  lines.push('');

  return lines.join('\n');
}

/* ================================================================== */
/* 三、纯文本渲染                                                      */
/* ================================================================== */

const TEXT_SEPARATOR = '='.repeat(78);
const TEXT_SUB_SEPARATOR = '-'.repeat(78);

/**
 * 渲染为纯文本。
 * 适合：控制台输出、日志归档、邮件正文、写入审计底稿的 .txt 附件。
 * 不使用任何 Markdown 标记，保证在等宽字体与纯文本查看器里都不会出现「*」「#」噪声。
 */
export function renderReviewText(report: ReviewReport): string {
  const lines: string[] = [];
  const s = report.summary;

  lines.push(TEXT_SEPARATOR);
  lines.push('合  规  审  核  报  告');
  lines.push(TEXT_SEPARATOR);
  lines.push(`报告编号：${report.id}`);
  lines.push(`审核期间：${report.period}`);
  lines.push(`会计准则：${ACCOUNTING_STANDARD_LABEL[report.standard]}`);
  lines.push(`审核时间：${report.checkedAt}`);
  lines.push(`引擎版本：${report.engineVersion}`);
  lines.push(`合规得分：${s.score} / 100`);
  lines.push(`审核结论：${verdictText(report)}`);
  lines.push('');

  lines.push('【一、总体结论】');
  lines.push(summaryLine(report));
  lines.push(verdictNote(report));
  lines.push('');

  lines.push('【二、问题清单】');
  if (report.findings.length === 0) {
    lines.push('本次审核未发现问题。');
  } else {
    report.findings.forEach((finding, index) => {
      lines.push(TEXT_SUB_SEPARATOR);
      lines.push(
        `${index + 1}. [${SEVERITY_LABEL[finding.severity]}] ${finding.title}${finding.blocking ? '（阻断项）' : ''}`,
      );
      lines.push(`   规则：${finding.ruleId}`);
      lines.push(`   维度：${REVIEW_CATEGORY_LABEL[finding.category]}`);
      lines.push(`   定位：${targetText(finding.target)}`);
      lines.push(`   说明：${finding.detail}`);
      lines.push(`   整改建议：${finding.suggestion}`);
      if (finding.basis.length > 0) {
        lines.push('   法规依据：');
        for (const basis of finding.basis) {
          lines.push(`     - ${formatBasis(basis)}`);
        }
      }
      if (finding.evidence !== undefined) {
        const json = JSON.stringify(finding.evidence);
        lines.push(`   证据：${json.length > 400 ? `${json.slice(0, 400)}……` : json}`);
      }
      if (finding.waived !== undefined) {
        lines.push(
          `   已豁免：${finding.waived.actor} 于 ${finding.waived.at} 豁免（${finding.waived.reason}）`,
        );
      }
    });
  }
  lines.push('');

  lines.push('【三、检查项执行清单】');
  report.checksRun.forEach((check, index) => {
    lines.push(
      `  ${String(index + 1).padStart(2, '0')}. ${check.id.padEnd(26)} ${check.title}` +
        `（${REVIEW_CATEGORY_LABEL[check.category]} / ${check.severity}）`,
    );
  });
  lines.push('');

  lines.push('【四、免责声明】');
  lines.push(REVIEW_DISCLAIMER);
  lines.push('');
  lines.push(TEXT_SEPARATOR);

  return lines.join('\n');
}
