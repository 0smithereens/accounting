/**
 * 税务层检查。
 *
 * 审核对象是 TaxReturn（申报表草稿/已计算/已复核/已审批/已申报）。
 * 铁律：系统绝不自动向税务局提交申报。本层检查的是「草稿是否算对、流程是否走完、回执是否回填」，
 * 不是「替企业申报」。
 *
 * ── 与其他模块的数据约定（重要，税务模块集成时按此产出 TaxLine）──
 *  销项税额   code ∈ output_tax / vat_output / 销项税额，或 label 含「销项税额」；amount = 税额（分），rate = 税率
 *  销售额     code ∈ sales_amount / taxable_sales / revenue / 销售额，或 label 含「销售额/销售收入」；amount = 不含税销售额（分）
 *  进项税额   code ∈ input_tax / vat_input / 进项税额，或 label 含「进项税额」；amount = 税额（分）
 *  期末留抵   code ∈ credit_carryforward / ending_credit / 期末留抵税额，或 label 含「留抵」；amount = 留抵税额（分）
 *  计税依据   code ∈ tax_base / surcharge_base / 计税依据，或 label 含「计税依据」；amount = 附加税计税依据（分）
 *  所得税税率 code 或 label 含「税率 / rate」，rate = 税率（0.25 表示 25%）
 *  应纳税所得额 code ∈ taxable_income / 应纳税所得额，或 label 含「应纳税所得额」；amount = 应纳税所得额（分）
 *  减免税额   code ∈ tax_reduction / benefit / 减免税额，或 label 含「减免」；amount = 减免税额（分）
 * 约定之外的字段一律跳过，不猜测：审核宁可少报，也不能基于猜测误报。
 */

import type {
  BenefitMatch,
  Cents,
  FilingStatus,
  LawBasis,
  Period,
  ReviewContext,
  ReviewFinding,
  ReviewInput,
  ReviewTarget,
  TaxLine,
  TaxReturn,
} from '../../core/contracts.ts';
import { FILING_STATUS_LABEL, TAX_TYPE_LABEL } from '../../core/contracts.ts';
import { formatYuan, sumCents } from '../../core/money.ts';
import {
  LAW_ARCHIVES_13,
  LAW_CIT_LAW_4,
  LAW_CIT_LAW_28,
  LAW_TAX_COLLECTION_25,
  LAW_TAX_COLLECTION_64,
  LAW_URBAN_MAINTENANCE_TAX_2,
  LAW_VAT_REGULATION_4,
  LAW_VAT_REGULATION_5,
} from '../legal.ts';
import type { CheckDefinition } from '../engine.ts';

/* ================================================================== */
/* 一、规则 id                                                         */
/* ================================================================== */

export const TAX_RULE_IDS = {
  draft: 'TAX-DRAFT-001',
  noFiled: 'TAX-NOFILED-001',
  vatMismatch: 'TAX-VAT-MISMATCH-001',
  inputCredit: 'TAX-INPUT-001',
  surcharge: 'TAX-SURCHARGE-001',
  citRate: 'TAX-CIT-RATE-001',
  benefit: 'TAX-BENEFIT-001',
} as const;

/* ================================================================== */
/* 二、工具                                                            */
/* ================================================================== */

function makeFinding(
  ctx: ReviewContext,
  ruleId: string,
  target: ReviewTarget,
  title: string,
  detail: string,
  suggestion: string,
  basis: LawBasis[],
  evidence?: Record<string, unknown>,
): ReviewFinding {
  const finding: ReviewFinding = {
    id: ctx.nextId(),
    ruleId,
    severity: 'warning',
    category: 'tax_law',
    title,
    detail,
    suggestion,
    basis,
    target,
    blocking: false,
  };
  if (evidence !== undefined) finding.evidence = evidence;
  return finding;
}

function taxTarget(record: TaxReturn): ReviewTarget {
  return {
    kind: 'tax_return',
    id: record.id,
    label: `${TAX_TYPE_LABEL[record.taxType]} ${record.period}`,
  };
}

/** 同一纳税人、同一期间、同一税种只保留版本号最高的一张，作废的不参与。 */
export function latestTaxReturns(returns: readonly TaxReturn[]): TaxReturn[] {
  const byKey = new Map<string, TaxReturn>();
  for (const item of returns) {
    if (item.status === 'void') continue;
    const key = `${item.taxpayerId}|${item.period}|${item.taxType}`;
    const existing = byKey.get(key);
    if (existing === undefined || item.version > existing.version) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.period !== b.period) return a.period < b.period ? -1 : 1;
    if (a.taxType !== b.taxType) return a.taxType < b.taxType ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 按「先 code 精确、再 label 关键字」的顺序找申报表行。
 * exclude 用于排除「免税销售额」「进项税额转出」这类同名不同义的栏次。
 */
export function findTaxLine(
  lines: readonly TaxLine[],
  codes: readonly string[],
  keywords: readonly string[],
  excludeKeywords: readonly string[] = [],
): TaxLine | undefined {
  for (const line of lines) {
    if (codes.includes(line.code)) return line;
  }
  for (const line of lines) {
    const text = `${line.code} ${line.label}`;
    if (excludeKeywords.some((word) => text.includes(word))) continue;
    if (keywords.some((word) => text.includes(word))) return line;
  }
  return undefined;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

function nextPeriod(period: Period): Period {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const total = year * 12 + (month - 1) + 1;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

function isNextPeriod(previous: Period, current: Period): boolean {
  return nextPeriod(previous) === current;
}

function sameTaxpayerPeriod(record: TaxReturn, other: TaxReturn): boolean {
  return record.taxpayerId === other.taxpayerId && record.period === other.period;
}

const OUTPUT_TAX_CODES = ['output_tax', 'vat_output', '销项税额'];
const OUTPUT_TAX_KEYWORDS = ['销项税额'];
const SALES_CODES = ['sales_amount', 'taxable_sales', 'revenue', '销售额'];
const SALES_KEYWORDS = ['销售额', '销售收入'];
const SALES_EXCLUDES = ['免税', '不征税', '零税率'];
const INPUT_TAX_CODES = ['input_tax', 'vat_input', '进项税额'];
const INPUT_TAX_KEYWORDS = ['进项税额'];
const INPUT_TAX_EXCLUDES = ['转出'];
const CARRY_CODES = ['credit_carryforward', 'ending_credit', '期末留抵税额', '留抵税额'];
const CARRY_KEYWORDS = ['留抵'];
const SURCHARGE_BASE_CODES = ['tax_base', 'surcharge_base', '计税依据'];
const SURCHARGE_BASE_KEYWORDS = ['计税依据'];
const REDUCTION_CODES = ['tax_reduction', 'benefit', '减免税额'];
const REDUCTION_KEYWORDS = ['减免'];
const TAXABLE_INCOME_CODES = ['taxable_income', '应纳税所得额'];
const TAXABLE_INCOME_KEYWORDS = ['应纳税所得额'];

/** 企业所得税法定/优惠税率白名单。 */
const ALLOWED_CIT_RATES = [0.25, 0.2, 0.15, 0.1, 0.05, 0.025];

function outputTaxOf(record: TaxReturn): Cents | undefined {
  return findTaxLine(record.lines, OUTPUT_TAX_CODES, OUTPUT_TAX_KEYWORDS)?.amount;
}

function inputTaxOf(record: TaxReturn): Cents | undefined {
  return findTaxLine(record.lines, INPUT_TAX_CODES, INPUT_TAX_KEYWORDS, INPUT_TAX_EXCLUDES)?.amount;
}

/** 期末留抵税额：优先取明示栏次，其次按「进项 − 销项」推算，最后看 payable 是否为负。 */
function creditCarryforwardOf(record: TaxReturn): Cents {
  const explicit = findTaxLine(record.lines, CARRY_CODES, CARRY_KEYWORDS);
  if (explicit !== undefined) return Math.max(0, explicit.amount);

  const input = inputTaxOf(record);
  const output = outputTaxOf(record);
  if (input !== undefined && output !== undefined) return Math.max(0, input - output);
  return record.payable < 0 ? -record.payable : 0;
}

/* ================================================================== */
/* 三、检查项                                                          */
/* ================================================================== */

const PENDING_STATUSES: readonly FilingStatus[] = ['draft', 'calculated', 'rejected'];

/** TAX-DRAFT-001：存在未完成复核的申报草稿。 */
function checkDraft(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const record of latestTaxReturns(input.taxReturns ?? [])) {
    if (!PENDING_STATUSES.includes(record.status)) continue;

    findings.push(
      makeFinding(
        ctx,
        TAX_RULE_IDS.draft,
        taxTarget(record),
        '存在未完成复核的申报草稿',
        `${TAX_TYPE_LABEL[record.taxType]}申报表（${record.period}）当前状态为「${FILING_STATUS_LABEL[record.status]}」，` +
          '尚未完成「草稿 → 已计算 → 已复核 → 已审批」的人工签署流程。' +
          '系统只能产出草稿，正式申报必须由人工在电子税务局完成；未复核的草稿不得作为申报依据。',
        '按流程完成复核与审批：复核人核对计算口径与取数来源并签署，审批人确认后签署。' +
          '签署后由人工在电子税务局申报，再回填申报回执（回执号、申报时间、实缴金额）。',
        [LAW_TAX_COLLECTION_25, LAW_TAX_COLLECTION_64],
        {
          taxReturnId: record.id,
          taxType: record.taxType,
          period: record.period,
          status: record.status,
          version: record.version,
          signatures: record.signatures.map((item) => ({ role: item.role, actor: item.actor, at: item.at })),
        },
      ),
    );
  }

  return findings;
}

/** TAX-NOFILED-001：状态 filed 但缺人工回执。 */
function checkNoManualFiling(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const record of latestTaxReturns(input.taxReturns ?? [])) {
    if (record.status !== 'filed') continue;

    const problems: string[] = [];
    const manual = record.manualFiling;
    if (manual === undefined) {
      problems.push('未回填人工申报回执（manualFiling 为空）');
    } else {
      if (manual.receiptNo.trim() === '') problems.push('税务局受理回执号为空');
      if (manual.actor.trim() === '') problems.push('回填人为空');
      if (manual.filedAt.trim() === '') problems.push('申报时间为空');
      if (manual.paidAmount < 0) problems.push('实缴金额为负数');
    }

    if (problems.length === 0) continue;

    findings.push(
      makeFinding(
        ctx,
        TAX_RULE_IDS.noFiled,
        taxTarget(record),
        '已申报状态缺少人工回执',
        `${TAX_TYPE_LABEL[record.taxType]}申报表（${record.period}）状态为「已申报」，但${problems.join('；')}。` +
          '「已申报」只能由人工在电子税务局完成申报后回填事实，系统没有任何代码路径可以直接把状态置为已申报。' +
          '缺少回执意味着这次申报无法被审计追溯，也无法证明企业已履行申报义务。',
        '请申报经办人补录电子税务局受理回执号、申报时间、实缴金额与回填人；' +
          '若实际尚未申报，应将状态退回「已审批」，待人工完成申报后再回填。',
        [LAW_TAX_COLLECTION_25, LAW_ARCHIVES_13],
        {
          taxReturnId: record.id,
          taxType: record.taxType,
          period: record.period,
          problems,
          manualFiling: manual ?? null,
        },
      ),
    );
  }

  return findings;
}

/** TAX-VAT-MISMATCH-001：销项税额与「销售额 × 税率」不符（容差 1 元）。 */
function checkVatOutputTax(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const tolerance: Cents = 100; // 1 元，吸收分位四舍五入差异

  for (const record of latestTaxReturns(input.taxReturns ?? [])) {
    if (record.taxType !== 'vat') continue;

    const output = findTaxLine(record.lines, OUTPUT_TAX_CODES, OUTPUT_TAX_KEYWORDS);
    const revenue = findTaxLine(record.lines, SALES_CODES, SALES_KEYWORDS, SALES_EXCLUDES);
    if (output === undefined || revenue === undefined) continue;

    // 销项税额行未写税率时退回销售额行的税率；两行都写 0 视为「无税率信息」而不是 0%。
    const rate = [output.rate, revenue.rate].find(
      (item): item is number => typeof item === 'number' && item > 0,
    );
    if (rate === undefined) continue;

    const expected = Math.round(revenue.amount * rate);
    const diff = output.amount - expected;
    if (Math.abs(diff) <= tolerance) continue;

    findings.push(
      makeFinding(
        ctx,
        TAX_RULE_IDS.vatMismatch,
        taxTarget(record),
        '销项税额与销售额×税率不符',
        `${TAX_TYPE_LABEL[record.taxType]}申报表（${record.period}）：销售额 ${formatYuan(revenue.amount)} 元 × 税率 ${formatRate(rate)} ` +
          `= 期望销项税额 ${formatYuan(expected)} 元，但申报表销项税额为 ${formatYuan(output.amount)} 元，` +
          `相差 ${formatYuan(diff)} 元（容差 1 元）。销项税额计算错误会直接导致少缴或多缴增值税。`,
        '核对开票收入、未开票收入、价外费用与适用税率；检查是否存在混合销售、差额征税、' +
          '免税收入误计入应税销售额、或税率适用错误。更正申报须由人工在电子税务局完成，系统只生成更正草稿。',
        [LAW_VAT_REGULATION_5, LAW_TAX_COLLECTION_25],
        {
          taxReturnId: record.id,
          period: record.period,
          revenue: revenue.amount,
          rate,
          expected,
          actual: output.amount,
          diff,
          tolerance,
        },
      ),
    );
  }

  return findings;
}

/** TAX-INPUT-001：连续 3 期留抵。 */
function checkConsecutiveInputCredit(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  const vatReturns = latestTaxReturns(input.taxReturns ?? [])
    .filter((record) => record.taxType === 'vat' && record.period <= ctx.period)
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));

  let run: TaxReturn[] = [];

  const flush = (records: TaxReturn[]): void => {
    if (records.length < 3) return;
    const last = records[records.length - 1];
    if (last === undefined) return;

    const credits = records.map((record) => creditCarryforwardOf(record));
    const total = sumCents(credits);
    const periods = records.map((record) => record.period).join('、');

    findings.push(
      makeFinding(
        ctx,
        TAX_RULE_IDS.inputCredit,
        taxTarget(last),
        '连续多期增值税留抵',
        `增值税自 ${periods} 起连续 ${records.length} 期期末留抵税额均为正数，` +
          `各期分别为 ${records.map((record, index) => `${record.period}：${formatYuan(credits[index] ?? 0)} 元`).join('；')}，` +
          `累计留抵 ${formatYuan(total)} 元。长期留抵可能意味着长期零申报/负申报、进项与业务不匹配，` +
          '或应转出的进项税额未转出。',
        '核查进项发票是否与实际采购匹配、是否存在存货长期积压或虚假采购；' +
          '符合条件的可依规申请留抵退税，但不得虚增进项或隐瞒销项。留抵退税申请须由人工在电子税务局办理。',
        [LAW_VAT_REGULATION_4, LAW_TAX_COLLECTION_25],
        {
          periods: records.map((record) => record.period),
          credits,
          total,
          taxReturnId: last.id,
        },
      ),
    );
  };

  for (const record of vatReturns) {
    if (creditCarryforwardOf(record) > 0) {
      const previous = run[run.length - 1];
      if (previous !== undefined && isNextPeriod(previous.period, record.period)) {
        run.push(record);
      } else {
        flush(run);
        run = [record];
      }
    } else {
      flush(run);
      run = [];
    }
  }
  flush(run);

  return findings;
}

/** TAX-SURCHARGE-001：附加税计税依据 ≠ 实缴增值税（+ 消费税）。 */
function checkSurchargeBase(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const tolerance: Cents = 100;
  const returns = latestTaxReturns(input.taxReturns ?? []);

  for (const record of returns) {
    if (record.taxType !== 'surcharge') continue;

    const baseLine = findTaxLine(record.lines, SURCHARGE_BASE_CODES, SURCHARGE_BASE_KEYWORDS);
    if (baseLine === undefined) continue;

    const vat = returns.find((item) => item.taxType === 'vat' && sameTaxpayerPeriod(record, item));
    const consumption = returns.find((item) => item.taxType === 'consumption' && sameTaxpayerPeriod(record, item));
    if (vat === undefined && consumption === undefined) continue;

    const vatActual = vat === undefined
      ? 0
      : vat.manualFiling !== undefined
        ? Math.max(0, vat.manualFiling.paidAmount)
        : Math.max(0, vat.payable);
    const consumptionActual = consumption === undefined ? 0 : Math.max(0, consumption.payable);
    const expected = vatActual + consumptionActual;
    const diff = baseLine.amount - expected;
    if (Math.abs(diff) <= tolerance) continue;

    findings.push(
      makeFinding(
        ctx,
        TAX_RULE_IDS.surcharge,
        taxTarget(record),
        '附加税计税依据与实缴增值税不符',
        `${TAX_TYPE_LABEL[record.taxType]}申报表（${record.period}）计税依据为 ${formatYuan(baseLine.amount)} 元，` +
          `但同期实缴增值税 ${formatYuan(vatActual)} 元、消费税 ${formatYuan(consumptionActual)} 元，` +
          `计税依据应为 ${formatYuan(expected)} 元，相差 ${formatYuan(diff)} 元。` +
          '城市维护建设税、教育费附加、地方教育附加均以实际缴纳的增值税、消费税为计税依据。',
        '按完税凭证核对同期实际缴纳的增值税与消费税，更正附加税计税依据；' +
          '若增值税存在更正申报，附加税应同步更正。更正申报须由人工在电子税务局完成。',
        [LAW_URBAN_MAINTENANCE_TAX_2, LAW_TAX_COLLECTION_25],
        {
          taxReturnId: record.id,
          period: record.period,
          base: baseLine.amount,
          vatActual,
          consumptionActual,
          expected,
          diff,
          tolerance,
        },
      ),
    );
  }

  return findings;
}

/** TAX-CIT-RATE-001：所得税税率与法定税率/已享受优惠身份不符。 */
function checkCitRate(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const record of latestTaxReturns(input.taxReturns ?? [])) {
    if (record.taxType !== 'cit') continue;

    const rateLine = record.lines.find(
      (line) =>
        typeof line.rate === 'number' &&
        line.rate > 0 &&
        /税率|rate/i.test(`${line.code} ${line.label}`),
    );

    let rate: number | undefined = rateLine?.rate;
    if (rate === undefined) {
      const income = findTaxLine(record.lines, TAXABLE_INCOME_CODES, TAXABLE_INCOME_KEYWORDS);
      if (income !== undefined && income.amount > 0) rate = record.payable / income.amount;
    }
    if (rate === undefined) continue;

    const rounded = Math.round(rate * 10000) / 10000;
    const problems: string[] = [];

    if (!ALLOWED_CIT_RATES.some((item) => Math.abs(item - rounded) < 1e-6)) {
      problems.push(
        `税率 ${formatRate(rounded)} 不属于法定税率（25%）或现行优惠税率（20%/15%/10%/5%/2.5%）`,
      );
    }

    for (const benefit of record.benefits) {
      if (!benefit.eligible) continue;
      if (/小型微利/.test(benefit.policyName) && !(Math.abs(rounded - 0.05) < 1e-6 || Math.abs(rounded - 0.2) < 1e-6)) {
        problems.push(
          `已匹配「${benefit.policyName}」优惠（小型微利企业减按 20% 征收、应纳税所得额减按 25% 计入，实际税负 5%），` +
            `但申报表使用 ${formatRate(rounded)}，与优惠身份不符`,
        );
      }
      if (/高新技术/.test(benefit.policyName) && Math.abs(rounded - 0.15) >= 1e-6) {
        problems.push(
          `已匹配「${benefit.policyName}」优惠（高新技术企业减按 15%），但申报表使用 ${formatRate(rounded)}`,
        );
      }
    }

    if (problems.length === 0) continue;

    findings.push(
      makeFinding(
        ctx,
        TAX_RULE_IDS.citRate,
        taxTarget(record),
        '企业所得税税率与纳税人身份不符',
        `企业所得税申报表（${record.period}）：${problems.join('；')}。` +
          '税率适用错误会直接导致少缴或多缴企业所得税，并可能触发补税、滞纳金与罚款。',
        '核对纳税人身份与优惠资格：小型微利企业需同时满足应纳税所得额、从业人数、资产总额条件；' +
          '高新技术企业需持有有效期内的高新技术企业证书。按正确税率重算并留存备查资料。',
        [LAW_CIT_LAW_4, LAW_CIT_LAW_28],
        {
          taxReturnId: record.id,
          period: record.period,
          rate: rounded,
          problems,
          benefits: record.benefits.map((item) => ({ policyId: item.policyId, eligible: item.eligible })),
        },
      ),
    );
  }

  return findings;
}

/** TAX-BENEFIT-001：满足优惠条件但申报表未体现减免。 */
function checkUnclaimedBenefit(input: ReviewInput, ctx: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const record of latestTaxReturns(input.taxReturns ?? [])) {
    const eligible = record.benefits.filter((item: BenefitMatch) => item.eligible && item.estimatedBenefit > 0);
    if (eligible.length === 0) continue;

    const reduction = findTaxLine(record.lines, REDUCTION_CODES, REDUCTION_KEYWORDS);
    if (reduction !== undefined && reduction.amount > 0) continue;

    const totalBenefit = sumCents(eligible.map((item) => item.estimatedBenefit));
    const detailList = eligible
      .map((item) => `「${item.policyName}」（${item.policyId}）测算减免 ${formatYuan(item.estimatedBenefit)} 元`)
      .join('；');

    const basis: LawBasis[] = [];
    const seen = new Set<string>();
    for (const item of eligible) {
      for (const entry of item.basis) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        basis.push(entry);
      }
    }
    if (basis.length === 0) basis.push(LAW_CIT_LAW_28);

    findings.push(
      makeFinding(
        ctx,
        TAX_RULE_IDS.benefit,
        taxTarget(record),
        '符合优惠条件但未在申报表中体现',
        `${TAX_TYPE_LABEL[record.taxType]}申报表（${record.period}）匹配到 ${eligible.length} 项可享受优惠：${detailList}，` +
          `合计测算减免 ${formatYuan(totalBenefit)} 元，但申报表中未发现减免税额栏次。` +
          '未享受优惠不会导致违法，但会让企业多缴税款，也说明申报表与政策匹配结果不一致。',
        '逐项核对优惠条件（行业、规模、从业人数、资产总额、应纳税所得额、证书有效期），' +
          '确认后由人工在申报表中填报减免并留存备查资料；若经评估决定不享受，应留存书面说明，避免后续被质疑申报不实。' +
          `测算减免额仅供参考，实际减免以税务机关认定为准。`,
        basis,
        {
          taxReturnId: record.id,
          period: record.period,
          benefits: eligible.map((item) => ({
            policyId: item.policyId,
            policyName: item.policyName,
            estimatedBenefit: item.estimatedBenefit,
          })),
          totalBenefit,
          reductionLine: reduction ?? null,
        },
      ),
    );
  }

  return findings;
}

/* ================================================================== */
/* 四、注册                                                            */
/* ================================================================== */

export const taxChecks: readonly CheckDefinition[] = [
  {
    id: TAX_RULE_IDS.draft,
    title: '申报草稿已完成人工复核',
    category: 'tax_law',
    severity: 'error',
    blocking: true,
    configurable: false,
    basis: [LAW_TAX_COLLECTION_25, LAW_TAX_COLLECTION_64],
    run: checkDraft,
  },
  {
    id: TAX_RULE_IDS.noFiled,
    title: '已申报状态具备人工回执',
    category: 'tax_law',
    severity: 'error',
    blocking: true,
    configurable: false,
    basis: [LAW_TAX_COLLECTION_25, LAW_ARCHIVES_13],
    run: checkNoManualFiling,
  },
  {
    id: TAX_RULE_IDS.vatMismatch,
    title: '销项税额与销售额×税率一致',
    category: 'tax_law',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_VAT_REGULATION_5, LAW_TAX_COLLECTION_25],
    run: checkVatOutputTax,
  },
  {
    id: TAX_RULE_IDS.inputCredit,
    title: '关注连续多期增值税留抵',
    category: 'tax_law',
    severity: 'warning',
    blocking: false,
    configurable: true,
    basis: [LAW_VAT_REGULATION_4, LAW_TAX_COLLECTION_25],
    run: checkConsecutiveInputCredit,
  },
  {
    id: TAX_RULE_IDS.surcharge,
    title: '附加税计税依据等于实缴增值税',
    category: 'tax_law',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_URBAN_MAINTENANCE_TAX_2, LAW_TAX_COLLECTION_25],
    run: checkSurchargeBase,
  },
  {
    id: TAX_RULE_IDS.citRate,
    title: '企业所得税税率适用正确',
    category: 'tax_law',
    severity: 'error',
    blocking: false,
    configurable: false,
    basis: [LAW_CIT_LAW_28],
    run: checkCitRate,
  },
  {
    id: TAX_RULE_IDS.benefit,
    title: '符合条件的税收优惠已享受',
    category: 'tax_law',
    severity: 'warning',
    blocking: false,
    configurable: true,
    basis: [LAW_CIT_LAW_28],
    run: checkUnclaimedBenefit,
  },
];
