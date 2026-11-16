/**
 * 税率表与征管口径常量（带生效日期）。
 *
 * 为什么法定税率写在代码里、再用 YAML 覆盖，而不是全部放 YAML
 * ---------------------------------------------------------
 * 税率是「算错一分钱就要更正申报」的参数，必须与代码同评审、同发布、同回滚，
 * 并且每一条都要能追到法条原文。若全部交给 YAML，运维把 0.13 改成 0.3 既没有
 * 编译期保护，也没有代码评审记录。因此本文件承载「默认口径 + 法规依据」，
 * config/tax/rates.yaml 只承载「同一政策在不同地区、不同企业的差异参数」
 * （如城建税 7%/5%/1%）以及政策切换期的临时覆盖。加载时逐项校验取值区间，
 * 校验失败直接抛 TaxConfigError，绝不静默使用一个可疑的税率。
 *
 * 金额单位：一律为「分」(Cents) 整数；比例一律为 0-1 的小数（0.13 而不是 13）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type {
  Cents,
  IsoDate,
  LawBasis,
  Period,
  TaxpayerId,
  TaxpayerKind,
} from '../core/contracts.ts';
import { CONFIG_DIR } from '../core/config.ts';

/** 税率配置错误。宁可让整个计算失败，也不带着错误的税率往下算。 */
export class TaxConfigError extends Error {}

/* ================================================================== */
/* 一、法规依据登记表                                                  */
/* ================================================================== */

/**
 * 全部法规依据的唯一来源。
 *
 * 为什么要集中登记而不是在计算函数里随手写字符串：
 *  1. 同一条法规会被多个税种引用（如「财政部 税务总局公告2023年第12号」
 *     同时支撑小微企业所得税 5% 与六税两费减半），集中登记保证引用一致；
 *  2. 法规更替时只改一处，不会出现「A 文件已更新、B 文件还是旧文号」；
 *  3. 申报表草稿里每条税额都要挂 basis，登记表让「没有依据的结论」无法产生。
 */
export const LAW_BASIS = {
  /* ------------------------------ 增值税 ------------------------------ */
  vatLaw: {
    id: 'vat-law-2026',
    title: '中华人民共和国增值税法',
    article: '第十条',
    excerpt:
      '增值税税率：销售货物、加工修理修配服务、有形动产租赁服务、进口货物，税率为13%；' +
      '销售交通运输、邮政、基础电信、建筑、不动产租赁服务，销售不动产，转让土地使用权，' +
      '销售或者进口农产品等货物，税率为9%；销售服务、无形资产，税率为6%；出口货物，税率为零。',
    effectiveFrom: '2026-01-01',
    level: 'law',
  },
  vatGeneralRules: {
    id: 'vat-general-rules',
    title: '财政部 国家税务总局关于全面推开营业税改征增值税试点的通知（财税〔2016〕36号）',
    article: '附件1 第十五条',
    excerpt:
      '增值税税率：提供交通运输、邮政、基础电信、建筑、不动产租赁服务，销售不动产，' +
      '转让土地使用权，税率为11%（后经调整）；提供现代服务、金融服务、生活服务、' +
      '销售无形资产，税率为6%。兼营不同税率的项目，应当分别核算不同税率项目的销售额。',
    effectiveFrom: '2016-05-01',
    level: 'normative-document',
  },
  vatSmallScale19: {
    id: 'mof-tax-2023-19',
    title: '财政部 税务总局关于增值税小规模纳税人减免增值税政策的公告（财政部 税务总局公告2023年第19号）',
    article: '第一条、第二条、第三条',
    excerpt:
      '一、对月销售额10万元以下（含本数）的增值税小规模纳税人，免征增值税。' +
      '二、增值税小规模纳税人适用3%征收率的应税销售收入，减按1%征收率征收增值税。' +
      '三、本公告执行至2027年12月31日。',
    effectiveFrom: '2023-01-01',
    level: 'normative-document',
  },
  vatAdditionalDeduction: {
    id: 'mof-tax-2023-1',
    title: '财政部 税务总局关于明确增值税小规模纳税人减免增值税等政策的公告（财政部 税务总局公告2023年第1号）',
    article: '第三条',
    excerpt:
      '自2023年1月1日至2023年12月31日，生产性服务业纳税人按照当期可抵扣进项税额加计5%抵减应纳税额；' +
      '生活性服务业纳税人按照当期可抵扣进项税额加计10%抵减应纳税额。加计抵减额不参与留抵税额计算。',
    effectiveFrom: '2023-01-01',
    level: 'normative-document',
  },
  vatSmallScaleRegistration: {
    id: 'sta-order-43',
    title: '增值税一般纳税人登记管理办法（国家税务总局令第43号）',
    article: '第二条',
    excerpt: '增值税纳税人年应税销售额超过财政部、国家税务总局规定的小规模纳税人标准（500万元）的，应当向主管税务机关办理一般纳税人登记。',
    effectiveFrom: '2018-02-01',
    level: 'departmental-rule',
  },

  /* ---------------------------- 附加税费 ---------------------------- */
  cityTaxLaw: {
    id: 'city-tax-law',
    title: '中华人民共和国城市维护建设税法',
    article: '第四条',
    excerpt:
      '城市维护建设税税率：纳税人所在地在市区的，税率为7%；在县城、镇的，税率为5%；' +
      '不在市区、县城或者镇的，税率为1%。计税依据为纳税人实际缴纳的增值税、消费税税额。',
    effectiveFrom: '2021-09-01',
    level: 'law',
  },
  educationSurchargeRule: {
    id: 'education-surcharge-rule',
    title: '征收教育费附加的暂行规定（国发〔1986〕50号，2011年修订）',
    article: '第三条',
    excerpt: '教育费附加，以各单位和个人实际缴纳的增值税、消费税的税额为计征依据，教育费附加率为3%，分别与增值税、消费税同时缴纳。',
    effectiveFrom: '1986-07-01',
    level: 'administrative-regulation',
  },
  localEducationRule: {
    id: 'local-education-2010-98',
    title: '财政部关于统一地方教育附加政策有关问题的通知（财综〔2010〕98号）',
    article: '第二条',
    excerpt: '统一地方教育附加政策，征收标准统一为单位和个人实际缴纳的增值税、消费税税额的2%。',
    effectiveFrom: '2010-12-01',
    level: 'normative-document',
  },
  educationExempt12: {
    id: 'mof-tax-2016-12',
    title: '财政部 国家税务总局关于扩大有关政府性基金免征范围的通知（财税〔2016〕12号）',
    article: '第一条',
    excerpt:
      '将免征教育费附加、地方教育附加、水利建设基金的范围，扩大到按月纳税的月销售额或营业额' +
      '不超过10万元（按季度纳税的季度销售额或营业额不超过30万元）的缴纳义务人。',
    effectiveFrom: '2016-02-01',
    level: 'normative-document',
  },
  sixTaxesHalf12: {
    id: 'mof-tax-2023-12',
    title: '财政部 税务总局关于进一步支持小微企业和个体工商户发展有关税费政策的公告（财政部 税务总局公告2023年第12号）',
    article: '第二条、第三条',
    excerpt:
      '二、自2023年1月1日至2027年12月31日，对增值税小规模纳税人、小型微利企业和个体工商户' +
      '减半征收资源税（不含水资源税）、城市维护建设税、房产税、城镇土地使用税、' +
      '印花税（不含证券交易印花税）、耕地占用税和教育费附加、地方教育附加。' +
      '三、对小型微利企业减按25%计算应纳税所得额，按20%的税率缴纳企业所得税政策，延续执行至2027年12月31日。',
    effectiveFrom: '2023-01-01',
    level: 'normative-document',
  },

  /* --------------------------- 企业所得税 --------------------------- */
  citLaw: {
    id: 'cit-law',
    title: '中华人民共和国企业所得税法',
    article: '第八条、第九条、第十条、第二十八条',
    excerpt:
      '第八条 企业实际发生的与取得收入有关的、合理的支出，准予在计算应纳税所得额时扣除。' +
      '第九条 公益性捐赠支出在年度利润总额12%以内的部分准予扣除，超过部分准予结转以后三年扣除。' +
      '第十条 税收滞纳金、罚金、罚款和被没收财物的损失不得扣除。' +
      '第二十八条 国家需要重点扶持的高新技术企业，减按15%的税率征收企业所得税。',
    effectiveFrom: '2008-01-01',
    level: 'law',
  },
  citRegulation: {
    id: 'cit-regulation',
    title: '中华人民共和国企业所得税法实施条例（国务院令第512号）',
    article: '第三十八条、第四十条、第四十一条、第四十二条、第四十三条、第四十四条',
    excerpt:
      '第三十八条 非金融企业向非金融企业借款的利息支出，不超过按照金融企业同期同类贷款利率计算的数额的部分准予扣除。' +
      '第四十条 职工福利费不超过工资薪金总额14%的部分准予扣除。' +
      '第四十一条 工会经费不超过工资薪金总额2%的部分准予扣除。' +
      '第四十三条 业务招待费按发生额的60%扣除，但最高不得超过当年销售（营业）收入的5‰。' +
      '第四十四条 广告费和业务宣传费不超过当年销售（营业）收入15%的部分准予扣除，超过部分准予结转以后年度扣除。',
    effectiveFrom: '2008-01-01',
    level: 'administrative-regulation',
  },
  citEducation51: {
    id: 'mof-tax-2018-51',
    title: '财政部 税务总局关于企业职工教育经费税前扣除政策的通知（财税〔2018〕51号）',
    article: '第一条',
    excerpt: '自2018年1月1日起，企业发生的职工教育经费支出，不超过工资薪金总额8%的部分，准予在计算企业所得税应纳税所得额时扣除；超过部分，准予在以后纳税年度结转扣除。',
    effectiveFrom: '2018-01-01',
    level: 'normative-document',
  },
  citSmallLowProfit13: {
    id: 'mof-tax-2019-13',
    title: '财政部 税务总局关于实施小微企业普惠性税收减免政策的通知（财税〔2019〕13号）',
    article: '第二条',
    excerpt: '小型微利企业是指从事国家非限制和禁止行业，且同时符合年度应纳税所得额不超过300万元、从业人数不超过300人、资产总额不超过5000万元等三个条件的企业。',
    effectiveFrom: '2019-01-01',
    level: 'normative-document',
  },
  citRdSuperDeduction7: {
    id: 'mof-tax-2023-7',
    title: '财政部 税务总局关于进一步完善研发费用税前加计扣除政策的公告（财政部 税务总局公告2023年第7号）',
    article: '第一条',
    excerpt:
      '企业开展研发活动中实际发生的研发费用，未形成无形资产计入当期损益的，在按规定据实扣除的基础上，' +
      '自2023年1月1日起，再按照实际发生额的100%在税前加计扣除；形成无形资产的，' +
      '自2023年1月1日起，按照无形资产成本的200%在税前摊销。',
    effectiveFrom: '2023-01-01',
    level: 'normative-document',
  },
  citHighTech32: {
    id: 'high-tech-2016-32',
    title: '高新技术企业认定管理办法（国科发火〔2016〕32号）',
    article: '第十一条',
    excerpt: '认定为高新技术企业须同时满足：注册成立一年以上、拥有核心自主知识产权、技术领域属于国家重点支持的高新技术领域、科技人员占比不低于10%、研发费用占销售收入比例达标、高新技术产品收入占比不低于60%等条件。',
    effectiveFrom: '2016-01-01',
    level: 'departmental-rule',
  },
  citDisabled70: {
    id: 'mof-tax-2009-70',
    title: '财政部 国家税务总局关于安置残疾人员就业有关企业所得税优惠政策问题的通知（财税〔2009〕70号）',
    article: '第一条',
    excerpt: '企业安置残疾人员的，在按照支付给残疾职工工资据实扣除的基础上，可以在计算应纳税所得额时按照支付给残疾职工工资的100%加计扣除。',
    effectiveFrom: '2008-01-01',
    level: 'normative-document',
  },
  citEquipment37: {
    id: 'mof-tax-2023-37',
    title: '财政部 税务总局关于设备、器具扣除有关企业所得税政策的公告（财政部 税务总局公告2023年第37号）',
    article: '第一条',
    excerpt: '企业在2024年1月1日至2027年12月31日期间新购进的设备、器具，单位价值不超过500万元的，允许一次性计入当期成本费用在计算应纳税所得额时扣除，不再分年度计算折旧。',
    effectiveFrom: '2024-01-01',
    level: 'normative-document',
  },

  /* --------------------------- 个人所得税 --------------------------- */
  iitLaw: {
    id: 'iit-law',
    title: '中华人民共和国个人所得税法',
    article: '第六条',
    excerpt:
      '居民个人的综合所得，以每一纳税年度的收入额减除费用六万元以及专项扣除、' +
      '专项附加扣除和依法确定的其他扣除后的余额，为应纳税所得额；' +
      '综合所得适用3%至45%的超额累进税率。',
    effectiveFrom: '2019-01-01',
    level: 'law',
  },
  iitWithholding61: {
    id: 'sta-2018-61',
    title: '个人所得税扣缴申报管理办法（试行）（国家税务总局公告2018年第61号）',
    article: '第六条',
    excerpt:
      '扣缴义务人向居民个人支付工资、薪金所得时，应当按照累计预扣法计算预扣税款，并按月办理扣缴申报。' +
      '以纳税人截至当前月份工资、薪金所得累计收入减除累计免税收入、累计减除费用、累计专项扣除、' +
      '累计专项附加扣除和累计依法确定的其他扣除后的余额为累计预扣预缴应纳税所得额，' +
      '适用个人所得税预扣率表一，计算累计应预扣预缴税额，再减除累计已预扣预缴税额，' +
      '其余额为本期应预扣预缴税额。',
    effectiveFrom: '2019-01-01',
    level: 'departmental-rule',
  },
  iitSpecialAdditional: {
    id: 'guofa-2018-41',
    title: '国务院关于印发个人所得税专项附加扣除暂行办法的通知（国发〔2018〕41号）',
    article: '第二条至第二十条',
    excerpt:
      '专项附加扣除包括子女教育、继续教育、大病医疗、住房贷款利息、住房租金、赡养老人、' +
      '3岁以下婴幼儿照护七项，按规定的标准和方式在计算应纳税所得额时扣除。',
    effectiveFrom: '2019-01-01',
    level: 'administrative-regulation',
  },

  /* ----------------------------- 印花税 ----------------------------- */
  stampLaw: {
    id: 'stamp-tax-law',
    title: '中华人民共和国印花税法',
    article: '第五条及附件《印花税税目税率表》',
    excerpt:
      '买卖合同价款的万分之三；借款合同借款金额的万分之零点五；租赁合同租金的千分之一；' +
      '产权转移书据（土地使用权、房屋等建筑物和构筑物所有权、股权转让）价款的万分之五；' +
      '营业账簿按实收资本（股本）、资本公积合计金额的万分之二点五；证券交易成交金额的千分之一。',
    effectiveFrom: '2022-07-01',
    level: 'law',
  },
  stampPolicy22: {
    id: 'mof-tax-2022-22',
    title: '财政部 税务总局关于印花税若干事项政策执行口径的公告（财政部 税务总局公告2022年第22号）',
    article: '第三条',
    excerpt:
      '印花税的计税依据不包括列明的增值税税款；应税合同未列明金额的，按照实际结算金额确定；' +
      '同一应税凭证载有两个以上税目事项并分别列明金额的，按照各自适用的税目税率分别计算应纳税额。',
    effectiveFrom: '2022-07-01',
    level: 'normative-document',
  },

  /* ------------------------- 征管与风险扫描 ------------------------- */
  taxCollectionLaw: {
    id: 'tax-collection-law',
    title: '中华人民共和国税收征收管理法',
    article: '第三十二条、第六十三条',
    excerpt:
      '第三十二条 纳税人未按照规定期限缴纳税款的，税务机关除责令限期缴纳外，' +
      '从滞纳税款之日起，按日加收滞纳税款万分之五的滞纳金。' +
      '第六十三条 纳税人进行虚假的纳税申报，不缴或者少缴应纳税款的，是偷税。',
    effectiveFrom: '2001-05-01',
    level: 'law',
  },
  invoiceMeasures: {
    id: 'invoice-measures',
    title: '中华人民共和国发票管理办法（国务院令第764号修订）',
    article: '第二十一条',
    excerpt: '任何单位和个人不得虚开发票，不得介绍他人虚开发票。开具发票应当按照规定的时限、顺序、栏目，全部联次一次性如实开具。',
    effectiveFrom: '2023-07-20',
    level: 'administrative-regulation',
  },
} satisfies Record<string, LawBasis>;

/** 法规依据的键名类型，便于调用方按名取用。 */
export type LawBasisKey = keyof typeof LAW_BASIS;

/* ================================================================== */
/* 二、增值税                                                          */
/* ================================================================== */

/**
 * 增值税应税项目分类。
 *
 * 为什么按「业务分类」而不是直接给一个税率字段：
 *  兼营是增值税最常见的错算来源。同一家企业可能同时有 13% 的货物销售、
 *  9% 的建筑服务、6% 的技术服务。若允许调用方只传一个税率，就必然出现
 *  「一刀切按最高税率」或「全部按 6%」的错误申报。强制按分类申报，
 *  每个分类各自带税率，销项税额分行计算后再汇总，申报表栏次才能对得上。
 */
export type VatCategory =
  | 'goods'
  | 'processing'
  | 'tangible_lease'
  | 'transport'
  | 'postal'
  | 'basic_telecom'
  | 'construction'
  | 'real_estate'
  | 'agriculture'
  | 'modern_service'
  | 'finance'
  | 'living_service'
  | 'intangible'
  | 'export'
  | 'small_scale_3'
  | 'small_scale_1';

export const VAT_CATEGORY_LABEL: Record<VatCategory, string> = {
  goods: '销售货物',
  processing: '加工修理修配劳务',
  tangible_lease: '有形动产租赁',
  transport: '交通运输服务',
  postal: '邮政服务',
  basic_telecom: '基础电信服务',
  construction: '建筑服务',
  real_estate: '不动产租赁与销售',
  agriculture: '农产品',
  modern_service: '现代服务',
  finance: '金融服务',
  living_service: '生活服务',
  intangible: '无形资产',
  export: '出口货物及跨境应税行为',
  small_scale_3: '小规模纳税人 3% 征收率',
  small_scale_1: '小规模纳税人 1% 征收率（减征）',
};

/** 全部增值税分类（顺序即申报表列示顺序，从高税率到低税率）。 */
export const VAT_CATEGORY_LIST: readonly VatCategory[] = [
  'goods',
  'processing',
  'tangible_lease',
  'transport',
  'postal',
  'basic_telecom',
  'construction',
  'real_estate',
  'agriculture',
  'modern_service',
  'finance',
  'living_service',
  'intangible',
  'export',
  'small_scale_3',
  'small_scale_1',
];

/** 分类 → 税率（一般纳税人）。小规模分类的值为征收率。 */
export const VAT_RATE_BY_CATEGORY: Record<VatCategory, number> = {
  goods: 0.13,
  processing: 0.13,
  tangible_lease: 0.13,
  transport: 0.09,
  postal: 0.09,
  basic_telecom: 0.09,
  construction: 0.09,
  real_estate: 0.09,
  agriculture: 0.09,
  modern_service: 0.06,
  finance: 0.06,
  living_service: 0.06,
  intangible: 0.06,
  export: 0,
  small_scale_3: 0.03,
  small_scale_1: 0.01,
};

/** 一般纳税人的法定税率档位，用于把「实算税率」吸附到法定档位。 */
export const VAT_STANDARD_RATES: readonly number[] = [0.13, 0.09, 0.06, 0];

/** 小规模纳税人法定征收率。 */
export const VAT_SMALL_SCALE_RATE = 0.03;
/** 小规模纳税人减按征收率（2023-2027）。 */
export const VAT_SMALL_SCALE_REDUCED_RATE = 0.01;
/** 小规模月销售额免征上限：10 万元 = 10,000,000 分。 */
export const VAT_EXEMPT_MONTHLY_THRESHOLD: Cents = 10_000_000;
/** 小规模季度销售额免征上限：30 万元 = 30,000,000 分。 */
export const VAT_EXEMPT_QUARTERLY_THRESHOLD: Cents = 30_000_000;
/** 生产/生活性服务业加计抵减率（生活性服务业可按 0.10 覆盖）。 */
export const VAT_ADDITIONAL_DEDUCTION_RATE = 0.05;

/**
 * 判断行业是否属于生产性/生活性服务业（增值税加计抵减的资格前提）。
 *
 * 为什么必须显式判定而不是默认享受：加计抵减是「资格型优惠」，
 * 只有四项服务销售额占全部销售额比重超过 50% 的纳税人才适用。
 * 若代码默认给所有一般纳税人加计 5%，等于凭空多抵一笔税，
 * 属于虚假申报。因此这里只做行业粗筛，真正的比重判定仍由人工确认。
 */
export function isProductionOrLivingServiceIndustry(industry: string): boolean {
  if (industry === '') return false;
  const keywords = [
    '服务', '研发', '信息技术', '软件', '咨询', '鉴证', '文化', '物流', '广告',
    '旅游', '娱乐', '餐饮', '住宿', '教育', '医疗', '设计', '租赁', '商务',
  ];
  return keywords.some((k) => industry.includes(k));
}

/* ================================================================== */
/* 三、附加税费                                                        */
/* ================================================================== */

/** 城建税税率分档（按纳税人所在地）。 */
export const CITY_TAX_RATE_BY_LOCATION = {
  /** 市区 */
  city: 0.07,
  /** 县城、镇 */
  county: 0.05,
  /** 不在市区、县城或镇 */
  other: 0.01,
} as const;

export type CityTaxLocation = keyof typeof CITY_TAX_RATE_BY_LOCATION;

/** 教育费附加率 3%。 */
export const EDUCATION_SURCHARGE_RATE = 0.03;
/** 地方教育附加率 2%。 */
export const LOCAL_EDUCATION_SURCHARGE_RATE = 0.02;
/** 六税两费减半比例：减半征收即按 50% 计算。 */
export const SIX_TAXES_HALF_RATE = 0.5;

/* ================================================================== */
/* 四、企业所得税                                                      */
/* ================================================================== */

/** 企业所得税法定税率 25%。 */
export const CIT_STANDARD_RATE = 0.25;
/** 高新技术企业优惠税率 15%。 */
export const CIT_HIGH_TECH_RATE = 0.15;
/** 小型微利企业：减按 25% 计入应纳税所得额。 */
export const CIT_SMALL_LOW_PROFIT_INCLUSION_RATE = 0.25;
/** 小型微利企业：按 20% 税率缴纳。 */
export const CIT_SMALL_LOW_PROFIT_RATE = 0.2;
/** 小型微利企业实际税负 5% = 25% × 20%。 */
export const CIT_SMALL_LOW_PROFIT_EFFECTIVE_RATE = 0.05;
/** 小型微利企业年应纳税所得额上限：300 万元 = 300,000,000 分。 */
export const CIT_SMALL_LOW_PROFIT_MAX_INCOME: Cents = 300_000_000;
/** 小型微利企业从业人数上限 300 人。 */
export const CIT_SMALL_LOW_PROFIT_MAX_EMPLOYEES = 300;
/** 小型微利企业资产总额上限：5000 万元 = 5,000,000,000 分。 */
export const CIT_SMALL_LOW_PROFIT_MAX_ASSETS: Cents = 5_000_000_000;

/**
 * 企业所得税税前扣除限额。
 *
 * 全部以「比例」表达，具体限额 = 基数 × 比例，在 cit.ts 里用整数分计算并四舍五入。
 * 这样限额口径只在此处定义一次，汇算清缴与预缴共用同一套数字。
 */
export const CIT_DEDUCTION_LIMITS = {
  /** 业务招待费：按发生额的 60% 扣除 */
  businessEntertainment: 0.6,
  /** 业务招待费：最高不超过当年销售（营业）收入的 5‰ */
  businessEntertainmentRevenue: 0.005,
  /** 广告费和业务宣传费：销售（营业）收入的 15% */
  advertising: 0.15,
  /** 职工福利费：工资薪金总额的 14% */
  welfare: 0.14,
  /** 职工教育经费：工资薪金总额的 8% */
  education: 0.08,
  /** 工会经费：工资薪金总额的 2% */
  union: 0.02,
  /** 公益性捐赠：年度利润总额的 12% */
  donation: 0.12,
  /** 研发费用加计扣除比例：100% */
  rdSuperDeduction: 1.0,
} as const;

/* ================================================================== */
/* 五、个人所得税                                                      */
/* ================================================================== */

/** 工资薪金累计预扣预缴的一个税率级距。 */
export interface IitBracket {
  /** 级数 1-7 */
  level: number;
  /** 累计预扣预缴应纳税所得额上限（分，含本数） */
  upperBound: Cents;
  /** 预扣率 */
  rate: number;
  /** 速算扣除数（分） */
  quickDeduction: Cents;
}

/**
 * 个人所得税预扣率表一（居民个人工资、薪金所得预扣预缴适用）。
 *
 * 用「累计应纳税所得额 × 税率 - 速算扣除数」的速算法而不是逐级累加，
 * 是为了与国家税务总局扣缴客户端的结果逐分一致；逐级累加在跨档月份
 * 容易因为边界处理差 1 分钱，而对账单上差 1 分钱就是「申报错误」。
 */
export const IIT_BRACKETS: readonly IitBracket[] = [
  { level: 1, upperBound: 3_600_000, rate: 0.03, quickDeduction: 0 },
  { level: 2, upperBound: 14_400_000, rate: 0.1, quickDeduction: 252_000 },
  { level: 3, upperBound: 30_000_000, rate: 0.2, quickDeduction: 1_692_000 },
  { level: 4, upperBound: 42_000_000, rate: 0.25, quickDeduction: 3_192_000 },
  { level: 5, upperBound: 66_000_000, rate: 0.3, quickDeduction: 5_292_000 },
  { level: 6, upperBound: 96_000_000, rate: 0.35, quickDeduction: 8_592_000 },
  { level: 7, upperBound: Number.MAX_SAFE_INTEGER, rate: 0.45, quickDeduction: 18_192_000 },
];

/** 工资薪金每月基本减除费用：5000 元 = 500,000 分。 */
export const IIT_MONTHLY_BASIC_DEDUCTION: Cents = 500_000;

/** 按累计应纳税所得额查税率级距。非正数时返回第一级（税率 3%，速算扣除数 0）。 */
export function iitBracketOf(cumulativeTaxableIncome: Cents): IitBracket {
  for (const bracket of IIT_BRACKETS) {
    if (cumulativeTaxableIncome <= bracket.upperBound) return bracket;
  }
  // noUncheckedIndexedAccess 下数组下标可能为 undefined，这里给出确定性的兜底
  return IIT_BRACKETS[IIT_BRACKETS.length - 1] ?? {
    level: 7,
    upperBound: Number.MAX_SAFE_INTEGER,
    rate: 0.45,
    quickDeduction: 18_192_000,
  };
}

/* ================================================================== */
/* 六、印花税                                                          */
/* ================================================================== */

/** 印花税税目。 */
export type StampContractType =
  | 'sale'
  | 'loan'
  | 'lease'
  | 'property_transfer'
  | 'account_book'
  | 'securities'
  | 'construction'
  | 'transport'
  | 'technology'
  | 'insurance';

export interface StampItemMeta {
  label: string;
  /** 比例税率（0-1） */
  rate: number;
  /** 计税依据说明 */
  taxableBase: string;
  /** 是否属于「六税两费」减半范围（证券交易印花税不参与减半） */
  halfEligible: boolean;
  basis: LawBasis;
}

/** 印花税税目表。税率为比例税率，证券交易按成交金额计征。 */
export const STAMP_ITEM_META: Record<StampContractType, StampItemMeta> = {
  sale: {
    label: '买卖合同',
    rate: 0.0003,
    taxableBase: '合同列明的价款（不含增值税）',
    halfEligible: true,
    basis: LAW_BASIS.stampLaw,
  },
  loan: {
    label: '借款合同',
    rate: 0.00005,
    taxableBase: '合同列明的借款金额',
    halfEligible: true,
    basis: LAW_BASIS.stampLaw,
  },
  lease: {
    label: '租赁合同',
    rate: 0.001,
    taxableBase: '合同列明的租金',
    halfEligible: true,
    basis: LAW_BASIS.stampLaw,
  },
  property_transfer: {
    label: '产权转移书据',
    rate: 0.0005,
    taxableBase: '产权转移书据列明的价款（不含增值税）',
    halfEligible: true,
    basis: LAW_BASIS.stampLaw,
  },
  account_book: {
    label: '营业账簿',
    rate: 0.00025,
    taxableBase: '实收资本（股本）与资本公积合计金额',
    halfEligible: true,
    basis: LAW_BASIS.stampLaw,
  },
  securities: {
    label: '证券交易',
    rate: 0.001,
    taxableBase: '证券成交金额',
    halfEligible: false,
    basis: LAW_BASIS.stampLaw,
  },
  construction: {
    label: '建设工程合同',
    rate: 0.0003,
    taxableBase: '合同列明的价款',
    halfEligible: true,
    basis: LAW_BASIS.stampLaw,
  },
  transport: {
    label: '运输合同',
    rate: 0.0003,
    taxableBase: '合同列明的运输费用',
    halfEligible: true,
    basis: LAW_BASIS.stampLaw,
  },
  technology: {
    label: '技术合同',
    rate: 0.0003,
    taxableBase: '合同列明的价款、报酬或使用费',
    halfEligible: true,
    basis: LAW_BASIS.stampLaw,
  },
  insurance: {
    label: '财产保险合同',
    rate: 0.001,
    taxableBase: '合同列明的保险费',
    halfEligible: true,
    basis: LAW_BASIS.stampLaw,
  },
};

/** 印花税税目顺序（申报表列示顺序）。 */
export const STAMP_ITEM_LIST: readonly StampContractType[] = [
  'sale',
  'loan',
  'lease',
  'property_transfer',
  'account_book',
  'construction',
  'transport',
  'technology',
  'insurance',
  'securities',
];

/* ================================================================== */
/* 七、政策有效期                                                      */
/* ================================================================== */

/** 一项优惠政策的适用窗口。to 缺省表示长期有效。 */
export interface PolicyWindow {
  from: IsoDate;
  to?: IsoDate;
}

/**
 * 政策窗口表。
 *
 * 为什么单独列出来而不是散落在各计算函数里：
 *  跨期计算（如 2027 年 12 月的季度预缴、2028 年 1 月的补申报）必须能回答
 *  「这个期间适用哪一版政策」。集中登记后，政策到期只需改一处，
 *  各税种自动跟随，不会出现「增值税按新政策、附加税还按旧政策」的错配。
 */
export const POLICY_WINDOWS = {
  /** 小规模纳税人 3% 减按 1%、月 10 万免征 */
  smallScaleReduction: { from: '2023-01-01', to: '2027-12-31' },
  /** 六税两费减半 */
  sixTaxesHalf: { from: '2023-01-01', to: '2027-12-31' },
  /** 小型微利企业所得税优惠（实际税负 5%） */
  smallLowProfit: { from: '2023-01-01', to: '2027-12-31' },
  /** 研发费用 100% 加计扣除（长期执行） */
  rdSuperDeduction: { from: '2023-01-01' },
  /** 设备器具一次性扣除 */
  equipmentOneTimeDepreciation: { from: '2024-01-01', to: '2027-12-31' },
  /** 生产/生活性服务业加计抵减 */
  vatAdditionalDeduction: { from: '2023-01-01', to: '2027-12-31' },
} as const satisfies Record<string, PolicyWindow>;

export type PolicyKey = keyof typeof POLICY_WINDOWS;

/**
 * 判断会计期间是否落在政策窗口内（按「月」比较，含端点月份）。
 * 期间非法或政策未生效时返回 false —— 宁可不享受优惠，也不能错享。
 */
export function isPolicyEffective(period: Period, window: PolicyWindow): boolean {
  if (!/^\d{4}-\d{2}$/.test(period)) return false;
  const fromMonth = window.from.slice(0, 7);
  if (period < fromMonth) return false;
  if (window.to !== undefined && period > window.to.slice(0, 7)) return false;
  return true;
}

/** 便捷判断：按政策键名判断期间是否适用。 */
export function isPolicyKeyEffective(period: Period, key: PolicyKey): boolean {
  return isPolicyEffective(period, POLICY_WINDOWS[key]);
}

/* ================================================================== */
/* 八、整数分上的比例运算                                              */
/* ================================================================== */

/**
 * 按比例计算金额，四舍五入到分。
 *
 * 为什么统一走这个函数而不是就地 Math.round(a * b)：
 *  1. 全项目只有一种舍入口径（四舍五入，.5 向正无穷），复核时不会出现
 *     「这一栏四舍五入、那一栏截尾」导致合计差 1 分；
 *  2. 负数的处理被固定下来（Math.round(-0.5) === -0），避免留抵税额出现 -0；
 *  3. 未来若要改成「银行家舍入」只需改这一处。
 */
export function roundRate(base: Cents, rate: number): Cents {
  if (!Number.isFinite(base) || !Number.isFinite(rate)) return 0;
  const raw = base * rate;
  // +0 用于把 -0 归一成 0，避免 JSON 里出现 -0
  return Math.round(raw) + 0;
}

/** 把金额按比例减半（用于六税两费减半），同样四舍五入到分。 */
export function halfCents(amount: Cents): Cents {
  return Math.round(amount * SIX_TAXES_HALF_RATE) + 0;
}

/**
 * 把 0-1 的税率格式化成「13%」这样的展示文本。
 *
 * 为什么统一格式化：申报表、计算说明、错误提示里都会出现税率，
 * 若各处自行拼接，就会出现「13.00%」「13 %」「0.13」混用，
 * 复核人员一眼看不出哪一栏用了哪个税率。
 */
export function formatRate(rate: number): string {
  const percent = rate * 100;
  if (Number.isInteger(percent)) return String(percent) + '%';
  return String(Number(percent.toFixed(4))) + '%';
}

/* ================================================================== */
/* 九、纳税人画像                                                      */
/* ================================================================== */

/**
 * 纳税人画像。
 *
 * 为什么定义在 rates.ts 而不是 compute.ts：
 *  benefits.ts（优惠智配）、risk.ts（风险扫描）、compute.ts（统一编排）三个模块
 *  都要用它。若定义在 compute.ts，另外两个模块就必须反向 import 编排层，
 *  形成循环依赖；而它描述的是「谁在适用这套税率」，与税率表同属征管口径层，
 *  放在这里层次上是自洽的。
 */
export interface TaxpayerProfile {
  id: TaxpayerId;
  name: string;
  kind: TaxpayerKind;
  /** 城建税税率：0.07 市区 / 0.05 县城、镇 / 0.01 其他 */
  cityTaxRate: 0.07 | 0.05 | 0.01;
  /** 所属行业，用于行业税负率基准与优惠匹配 */
  industry?: string;
  /** 从业人数，用于小型微利企业资格复核 */
  employees?: number;
  /** 资产总额（分），用于小型微利企业资格复核 */
  totalAssets?: Cents;
  /** 是否高新技术企业 */
  isHighTech?: boolean;
  /** 是否小型微利企业（企业自行判定，系统会再复核） */
  isSmallLowProfit?: boolean;
  /** 研发费用（分） */
  rdExpense?: Cents;
  /** 所在地区（省级），用于地方性政策匹配 */
  region?: string;
}

/* ================================================================== */
/* 十、税率配置加载                                                    */
/* ================================================================== */

/** 增值税税率表。 */
export interface VatRateTable {
  standard: Record<VatCategory, number>;
  smallScale: number;
  smallScaleReduced: number;
  /** 小规模月销售额免征上限（分） */
  exemptMonthlyThreshold: Cents;
  /** 小规模季度销售额免征上限（分） */
  exemptQuarterlyThreshold: Cents;
  /** 生产/生活性服务业加计抵减率 */
  additionalDeductionRate: number;
}

/** 附加税费率表。 */
export interface SurchargeRateTable {
  city: { city: number; county: number; other: number };
  education: number;
  localEducation: number;
  /** 六税两费减半比例 */
  halfRate: number;
  /** 教育费附加/地方教育附加免征的月销售额上限（分） */
  educationExemptMonthlyThreshold: Cents;
  educationExemptQuarterlyThreshold: Cents;
}

/** 小型微利企业判定参数。 */
export interface SmallLowProfitRule {
  inclusionRate: number;
  rate: number;
  maxTaxableIncome: Cents;
  maxEmployees: number;
  maxAssets: Cents;
}

/** 企业所得税率表。 */
export interface CitRateTable {
  standard: number;
  highTech: number;
  smallLowProfit: SmallLowProfitRule;
  limits: {
    businessEntertainment: number;
    businessEntertainmentRevenue: number;
    advertising: number;
    welfare: number;
    education: number;
    union: number;
    donation: number;
    rdSuperDeduction: number;
  };
}

/** 个人所得税率表。 */
export interface IitRateTable {
  basicDeductionMonthly: Cents;
  brackets: readonly IitBracket[];
}

/** 印花税税目税率表。 */
export interface StampRateTable {
  rates: Record<StampContractType, number>;
}

/** 一次加载得到的完整税率表。 */
export interface TaxRates {
  vat: VatRateTable;
  surcharge: SurchargeRateTable;
  cit: CitRateTable;
  iit: IitRateTable;
  stamp: StampRateTable;
  /** 配置文件路径；为 null 表示使用代码内置默认值 */
  sourceFile: string | null;
  /** 加载过程中的告警（如文件缺项回退默认值） */
  warnings: string[];
}

/** 代码内置的默认税率表。任何情况下都可直接使用。 */
export function defaultTaxRates(): TaxRates {
  const standard = {} as Record<VatCategory, number>;
  for (const category of VAT_CATEGORY_LIST) {
    standard[category] = VAT_RATE_BY_CATEGORY[category];
  }
  const stampRates = {} as Record<StampContractType, number>;
  for (const item of STAMP_ITEM_LIST) {
    stampRates[item] = STAMP_ITEM_META[item].rate;
  }
  return {
    vat: {
      standard,
      smallScale: VAT_SMALL_SCALE_RATE,
      smallScaleReduced: VAT_SMALL_SCALE_REDUCED_RATE,
      exemptMonthlyThreshold: VAT_EXEMPT_MONTHLY_THRESHOLD,
      exemptQuarterlyThreshold: VAT_EXEMPT_QUARTERLY_THRESHOLD,
      additionalDeductionRate: VAT_ADDITIONAL_DEDUCTION_RATE,
    },
    surcharge: {
      city: { ...CITY_TAX_RATE_BY_LOCATION },
      education: EDUCATION_SURCHARGE_RATE,
      localEducation: LOCAL_EDUCATION_SURCHARGE_RATE,
      halfRate: SIX_TAXES_HALF_RATE,
      educationExemptMonthlyThreshold: VAT_EXEMPT_MONTHLY_THRESHOLD,
      educationExemptQuarterlyThreshold: VAT_EXEMPT_QUARTERLY_THRESHOLD,
    },
    cit: {
      standard: CIT_STANDARD_RATE,
      highTech: CIT_HIGH_TECH_RATE,
      smallLowProfit: {
        inclusionRate: CIT_SMALL_LOW_PROFIT_INCLUSION_RATE,
        rate: CIT_SMALL_LOW_PROFIT_RATE,
        maxTaxableIncome: CIT_SMALL_LOW_PROFIT_MAX_INCOME,
        maxEmployees: CIT_SMALL_LOW_PROFIT_MAX_EMPLOYEES,
        maxAssets: CIT_SMALL_LOW_PROFIT_MAX_ASSETS,
      },
      limits: { ...CIT_DEDUCTION_LIMITS },
    },
    iit: {
      basicDeductionMonthly: IIT_MONTHLY_BASIC_DEDUCTION,
      brackets: IIT_BRACKETS.map((b) => ({ ...b })),
    },
    stamp: { rates: stampRates },
    sourceFile: null,
    warnings: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ratioOf(value: unknown, fallback: number, context: string): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new TaxConfigError(context + ' 必须是数字，实际为 ' + JSON.stringify(value));
  }
  if (n < 0 || n > 1) {
    throw new TaxConfigError(context + ' 必须在 0~1 之间（用 0.13 表示 13%），实际为 ' + n);
  }
  return n;
}

function centsOfYuan(value: unknown, fallback: Cents, context: string): Cents {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new TaxConfigError(context + ' 必须是数字（单位：元），实际为 ' + JSON.stringify(value));
  }
  return Math.round(n * 100);
}

function positiveIntOf(value: unknown, fallback: number, context: string): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new TaxConfigError(context + ' 必须是非负数字，实际为 ' + JSON.stringify(value));
  }
  return Math.round(n);
}

/**
 * 加载税率配置。
 *
 * 文件不存在 → 直接返回内置默认值（不报错）：税必须能算，
 *   缺配置文件不应阻断月结。
 * 文件存在但取值非法 → 抛 TaxConfigError：带着错误税率算出来的申报表
 *   比算不出来危险得多，必须让调用方明确处理。
 */
export function loadTaxRates(configDir: string = CONFIG_DIR): TaxRates {
  const path = join(configDir, 'tax', 'rates.yaml');
  const rates = defaultTaxRates();

  if (!existsSync(path)) {
    rates.warnings.push('未找到 ' + path + '，使用代码内置的默认税率表');
    return rates;
  }

  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new TaxConfigError('税率配置 ' + path + ' 解析失败：' + (err as Error).message);
  }
  if (!isRecord(doc)) {
    throw new TaxConfigError('税率配置 ' + path + ' 顶层应为对象');
  }
  rates.sourceFile = path;

  const vat = isRecord(doc['vat']) ? doc['vat'] : {};
  const standardRaw = isRecord(vat['standard']) ? vat['standard'] : {};
  for (const category of VAT_CATEGORY_LIST) {
    rates.vat.standard[category] = ratioOf(
      standardRaw[category],
      rates.vat.standard[category],
      'vat.standard.' + category,
    );
  }
  rates.vat.smallScale = ratioOf(vat['smallScale'], rates.vat.smallScale, 'vat.smallScale');
  rates.vat.smallScaleReduced = ratioOf(
    vat['smallScaleReduced'],
    rates.vat.smallScaleReduced,
    'vat.smallScaleReduced',
  );
  rates.vat.exemptMonthlyThreshold = centsOfYuan(
    vat['exemptMonthlyThresholdYuan'],
    rates.vat.exemptMonthlyThreshold,
    'vat.exemptMonthlyThresholdYuan',
  );
  rates.vat.exemptQuarterlyThreshold = centsOfYuan(
    vat['exemptQuarterlyThresholdYuan'],
    rates.vat.exemptQuarterlyThreshold,
    'vat.exemptQuarterlyThresholdYuan',
  );
  rates.vat.additionalDeductionRate = ratioOf(
    vat['additionalDeductionRate'],
    rates.vat.additionalDeductionRate,
    'vat.additionalDeductionRate',
  );

  const surcharge = isRecord(doc['surcharge']) ? doc['surcharge'] : {};
  const cityRaw = isRecord(surcharge['city']) ? surcharge['city'] : {};
  rates.surcharge.city.city = ratioOf(cityRaw['city'], rates.surcharge.city.city, 'surcharge.city.city');
  rates.surcharge.city.county = ratioOf(
    cityRaw['county'],
    rates.surcharge.city.county,
    'surcharge.city.county',
  );
  rates.surcharge.city.other = ratioOf(
    cityRaw['other'],
    rates.surcharge.city.other,
    'surcharge.city.other',
  );
  rates.surcharge.education = ratioOf(
    surcharge['education'],
    rates.surcharge.education,
    'surcharge.education',
  );
  rates.surcharge.localEducation = ratioOf(
    surcharge['localEducation'],
    rates.surcharge.localEducation,
    'surcharge.localEducation',
  );
  rates.surcharge.halfRate = ratioOf(surcharge['halfRate'], rates.surcharge.halfRate, 'surcharge.halfRate');
  rates.surcharge.educationExemptMonthlyThreshold = centsOfYuan(
    surcharge['educationExemptMonthlyThresholdYuan'],
    rates.surcharge.educationExemptMonthlyThreshold,
    'surcharge.educationExemptMonthlyThresholdYuan',
  );
  rates.surcharge.educationExemptQuarterlyThreshold = centsOfYuan(
    surcharge['educationExemptQuarterlyThresholdYuan'],
    rates.surcharge.educationExemptQuarterlyThreshold,
    'surcharge.educationExemptQuarterlyThresholdYuan',
  );

  const cit = isRecord(doc['cit']) ? doc['cit'] : {};
  rates.cit.standard = ratioOf(cit['standard'], rates.cit.standard, 'cit.standard');
  rates.cit.highTech = ratioOf(cit['highTech'], rates.cit.highTech, 'cit.highTech');
  const slpRaw = isRecord(cit['smallLowProfit']) ? cit['smallLowProfit'] : {};
  rates.cit.smallLowProfit.inclusionRate = ratioOf(
    slpRaw['inclusionRate'],
    rates.cit.smallLowProfit.inclusionRate,
    'cit.smallLowProfit.inclusionRate',
  );
  rates.cit.smallLowProfit.rate = ratioOf(
    slpRaw['rate'],
    rates.cit.smallLowProfit.rate,
    'cit.smallLowProfit.rate',
  );
  rates.cit.smallLowProfit.maxTaxableIncome = centsOfYuan(
    slpRaw['maxTaxableIncomeYuan'],
    rates.cit.smallLowProfit.maxTaxableIncome,
    'cit.smallLowProfit.maxTaxableIncomeYuan',
  );
  rates.cit.smallLowProfit.maxEmployees = positiveIntOf(
    slpRaw['maxEmployees'],
    rates.cit.smallLowProfit.maxEmployees,
    'cit.smallLowProfit.maxEmployees',
  );
  rates.cit.smallLowProfit.maxAssets = centsOfYuan(
    slpRaw['maxAssetsYuan'],
    rates.cit.smallLowProfit.maxAssets,
    'cit.smallLowProfit.maxAssetsYuan',
  );
  const limitsRaw = isRecord(cit['limits']) ? cit['limits'] : {};
  const limitKeys = [
    'businessEntertainment',
    'businessEntertainmentRevenue',
    'advertising',
    'welfare',
    'education',
    'union',
    'donation',
    'rdSuperDeduction',
  ] as const;
  for (const key of limitKeys) {
    rates.cit.limits[key] = ratioOf(limitsRaw[key], rates.cit.limits[key], 'cit.limits.' + key);
  }

  const iit = isRecord(doc['iit']) ? doc['iit'] : {};
  rates.iit.basicDeductionMonthly = centsOfYuan(
    iit['basicDeductionMonthlyYuan'],
    rates.iit.basicDeductionMonthly,
    'iit.basicDeductionMonthlyYuan',
  );
  const bracketsRaw = Array.isArray(iit['brackets']) ? iit['brackets'] : [];
  if (bracketsRaw.length > 0) {
    if (bracketsRaw.length !== 7) {
      throw new TaxConfigError(
        'iit.brackets 必须是 7 级超额累进税率表，实际有 ' + bracketsRaw.length + ' 级',
      );
    }
    const parsed: IitBracket[] = [];
    for (const [index, item] of bracketsRaw.entries()) {
      if (!isRecord(item)) {
        throw new TaxConfigError('iit.brackets[' + index + '] 应为对象');
      }
      parsed.push({
        level: index + 1,
        upperBound: centsOfYuan(
          item['upperYuan'],
          index === 6 ? Number.MAX_SAFE_INTEGER : 0,
          'iit.brackets[' + index + '].upperYuan',
        ),
        rate: ratioOf(item['rate'], 0, 'iit.brackets[' + index + '].rate'),
        quickDeduction: centsOfYuan(
          item['quickDeductionYuan'],
          0,
          'iit.brackets[' + index + '].quickDeductionYuan',
        ),
      });
    }
    // 校验级距单调递增，防止配置写反导致高收入按低税率计算
    for (let i = 1; i < parsed.length; i += 1) {
      const prev = parsed[i - 1];
      const curr = parsed[i];
      if (prev === undefined || curr === undefined) continue;
      if (curr.upperBound <= prev.upperBound) {
        throw new TaxConfigError('iit.brackets 的级距上限必须严格递增，第 ' + (i + 1) + ' 级不满足');
      }
      if (curr.rate <= prev.rate) {
        throw new TaxConfigError('iit.brackets 的税率必须严格递增，第 ' + (i + 1) + ' 级不满足');
      }
    }
    rates.iit.brackets = parsed;
  }

  const stamp = isRecord(doc['stamp']) ? doc['stamp'] : {};
  const stampRatesRaw = isRecord(stamp['rates']) ? stamp['rates'] : {};
  for (const item of STAMP_ITEM_LIST) {
    rates.stamp.rates[item] = ratioOf(
      stampRatesRaw[item],
      rates.stamp.rates[item],
      'stamp.rates.' + item,
    );
  }

  return rates;
}
