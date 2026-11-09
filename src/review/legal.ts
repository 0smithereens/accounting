/**
 * 法规库（Legal Basis Library）。
 *
 * 为什么单独建一个文件而不是把法条散落在各检查项里：
 *  1. 同一条法规会被多个检查项引用（例如会计法第九条同时支撑凭证、科目、数据质量三层），
 *     集中维护才能保证「同一条文、同一表述」，避免不同检查项引用出不同版本。
 *  2. 法规会修订。修订时只改这里一处，所有报告自动跟随，不会出现「报告里还写着旧法」的情况。
 *  3. 监管要求「所有合规结论必须带法规依据（法条名称 + 条款号）」，
 *     因此每条依据都带 id / title / article / excerpt / effectiveFrom / level 六个字段，
 *     报告层可以直接渲染，不需要再回查外部资料。
 *
 * 收录口径：
 *  - 只收录与本系统业务（记账、准则、报税、报表、内控、档案）直接相关的条文；
 *  - excerpt 是「条文要点」，为便于在报告中阅读做了压缩，但保留规范表述与关键限定词，
 *    不断章取义；正式引用请以官方公布文本为准；
 *  - effectiveFrom 取当前有效版本的施行日期，而不是最初发布日。
 */

import type { LawBasis } from '../core/contracts.ts';

/* ================================================================== */
/* 一、法规条目                                                        */
/* ================================================================== */

export const LAW_LIBRARY = {
  /* ---------------- 中华人民共和国会计法（2024 年修正） ---------------- */
  accountingLaw9: {
    id: 'accounting-law-9',
    title: '中华人民共和国会计法',
    article: '第九条',
    excerpt:
      '各单位必须根据实际发生的经济业务事项进行会计核算，填制会计凭证，登记会计账簿，编制财务会计报告。任何单位不得以虚假的经济业务事项或者资料进行会计核算。',
    effectiveFrom: '2024-07-01',
    level: 'law',
  },
  accountingLaw13: {
    id: 'accounting-law-13',
    title: '中华人民共和国会计法',
    article: '第十三条',
    excerpt:
      '会计凭证、会计账簿、财务会计报告和其他会计资料必须符合国家统一的会计制度的规定。任何单位和个人不得伪造、变造会计凭证、会计账簿及其他会计资料，不得提供虚假的财务会计报告。',
    effectiveFrom: '2024-07-01',
    level: 'law',
  },
  accountingLaw14: {
    id: 'accounting-law-14',
    title: '中华人民共和国会计法',
    article: '第十四条',
    excerpt:
      '会计凭证包括原始凭证和记账凭证。办理经济业务事项必须填制或者取得原始凭证并及时送交会计机构。会计机构、会计人员必须按照国家统一的会计制度的规定对原始凭证进行审核，对不真实、不合法的原始凭证有权不予接受。记账凭证应当根据经过审核的原始凭证及有关资料编制。',
    effectiveFrom: '2024-07-01',
    level: 'law',
  },
  accountingLaw20: {
    id: 'accounting-law-20',
    title: '中华人民共和国会计法',
    article: '第二十条',
    excerpt:
      '财务会计报告应当根据经过审核的会计账簿记录和有关资料编制，并符合本法和国家统一的会计制度关于财务会计报告的编制要求、提供对象和提供期限的规定。向不同的会计资料使用者提供的财务会计报告，其编制依据应当一致。',
    effectiveFrom: '2024-07-01',
    level: 'law',
  },
  accountingLaw27: {
    id: 'accounting-law-27',
    title: '中华人民共和国会计法',
    article: '第二十七条',
    excerpt:
      '各单位应当建立、健全本单位内部会计监督制度。记账人员与经济业务事项和会计事项的审批人员、经办人员、财物保管人员的职责权限应当明确，并相互分离、相互制约；重大对外投资、资产处置、资金调度和其他重要经济业务事项的决策和执行的相互监督、相互制约程序应当明确。',
    effectiveFrom: '2024-07-01',
    level: 'law',
  },
  accountingLaw37: {
    id: 'accounting-law-37',
    title: '中华人民共和国会计法',
    article: '第三十七条',
    excerpt:
      '会计机构内部应当建立稽核制度。出纳人员不得兼任稽核、会计档案保管和收入、支出、费用、债权债务账目的登记工作。',
    effectiveFrom: '2024-07-01',
    level: 'law',
  },
  accountingLaw43: {
    id: 'accounting-law-43',
    title: '中华人民共和国会计法',
    article: '第四十三条',
    excerpt:
      '伪造、变造会计凭证、会计账簿，编制虚假财务会计报告，构成犯罪的，依法追究刑事责任；尚不构成犯罪的，由县级以上人民政府财政部门予以通报并处罚款，对直接负责的主管人员和其他直接责任人员处罚款，其中的会计人员五年内不得从事会计工作。',
    effectiveFrom: '2024-07-01',
    level: 'law',
  },
  accountingLaw44: {
    id: 'accounting-law-44',
    title: '中华人民共和国会计法',
    article: '第四十四条',
    excerpt:
      '隐匿或者故意销毁依法应当保存的会计凭证、会计账簿、财务会计报告，构成犯罪的，依法追究刑事责任；尚不构成犯罪的，由县级以上人民政府财政部门予以通报并处罚款，对直接负责的主管人员和其他直接责任人员处罚款，其中的会计人员五年内不得从事会计工作。',
    effectiveFrom: '2024-07-01',
    level: 'law',
  },

  /* ---------------- 会计基础工作规范（财会字〔1996〕19 号，2019 修订） ---------------- */
  accountingBasis48: {
    id: 'accounting-basis-48',
    title: '会计基础工作规范',
    article: '第四十八条',
    excerpt:
      '原始凭证的内容必须具备：凭证的名称；填制凭证的日期；填制凭证单位名称或者填制人姓名；经办人员的签名或者盖章；接受凭证单位名称；经济业务内容；数量、单价和金额。',
    effectiveFrom: '2019-03-14',
    level: 'normative-document',
  },
  accountingBasis50: {
    id: 'accounting-basis-50',
    title: '会计基础工作规范',
    article: '第五十条',
    excerpt: '会计机构、会计人员要根据审核无误的原始凭证填制记账凭证。',
    effectiveFrom: '2019-03-14',
    level: 'normative-document',
  },
  accountingBasis51: {
    id: 'accounting-basis-51',
    title: '会计基础工作规范',
    article: '第五十一条',
    excerpt:
      '记账凭证的内容必须具备：填制凭证的日期；凭证编号；经济业务摘要；会计科目；金额；所附原始凭证张数；填制凭证人员、稽核人员、记账人员、会计机构负责人、会计主管人员签名或者盖章。收款和付款记账凭证还应当由出纳人员签名或者盖章。',
    effectiveFrom: '2019-03-14',
    level: 'normative-document',
  },
  accountingBasis52: {
    id: 'accounting-basis-52',
    title: '会计基础工作规范',
    article: '第五十二条',
    excerpt:
      '记账凭证应当连续编号。一笔经济业务需要填制两张以上记账凭证的，可以采用分数编号法编号。',
    effectiveFrom: '2019-03-14',
    level: 'normative-document',
  },
  accountingBasis60: {
    id: 'accounting-basis-60',
    title: '会计基础工作规范',
    article: '第六十条',
    excerpt:
      '各单位应当定期对会计账簿记录的有关数字与库存实物、货币资金、有价证券、往来单位或者个人等进行相互核对，保证账证相符、账账相符、账实相符。对账工作每年至少进行一次。',
    effectiveFrom: '2019-03-14',
    level: 'normative-document',
  },
  accountingBasis79: {
    id: 'accounting-basis-79',
    title: '会计基础工作规范',
    article: '第七十九条',
    excerpt:
      '会计机构、会计人员应当对财务收支进行监督：对审批手续不全的财务收支，应当退回要求补充、更正；对违反规定不纳入单位统一会计核算的财务收支，应当制止和纠正；对违反国家统一的财政、财务、会计制度规定的财务收支，不予办理。',
    effectiveFrom: '2019-03-14',
    level: 'normative-document',
  },

  /* ---------------- 企业会计制度（财会〔2000〕25 号） ---------------- */
  enterpriseSystem11: {
    id: 'enterprise-accounting-system-11',
    title: '企业会计制度',
    article: '第十一条',
    excerpt:
      '企业在会计核算时应当遵循以下基本原则：会计核算应当以实际发生的交易或事项为依据，如实反映企业的财务状况、经营成果和现金流量；应当按照交易或事项的经济实质进行会计核算，而不应当仅仅按照它们的法律形式作为依据；应当以权责发生制为基础；应当遵循谨慎性原则的要求，不得多计资产或收益、少计负债或费用。',
    effectiveFrom: '2001-01-01',
    level: 'departmental-rule',
  },

  /* ---------------- 小企业会计准则（财会〔2011〕17 号） ---------------- */
  smallStandard3: {
    id: 'small-enterprise-standard-3',
    title: '小企业会计准则',
    article: '第三条',
    excerpt:
      '本准则适用于在中华人民共和国境内依法设立的、符合《中小企业划型标准规定》所规定的小型企业标准的企业。下列三类小企业除外：股票或债券在市场上公开交易的小企业；金融机构或其他具有金融性质的小企业；企业集团内的母公司和子公司。',
    effectiveFrom: '2013-01-01',
    level: 'departmental-rule',
  },
  smallStandard5: {
    id: 'small-enterprise-standard-5',
    title: '小企业会计准则',
    article: '第五条',
    excerpt:
      '小企业应当以实际发生的交易或者事项为依据进行会计确认、计量和报告，如实反映符合确认和计量要求的各项会计要素及其他相关信息，保证会计信息真实可靠、内容完整。',
    effectiveFrom: '2013-01-01',
    level: 'departmental-rule',
  },

  /* ---------------- 企业会计准则——基本准则（财政部令第 33 号） ---------------- */
  casBasic9: {
    id: 'cas-basic-standard-9',
    title: '企业会计准则——基本准则',
    article: '第九条',
    excerpt: '企业应当以权责发生制为基础进行会计确认、计量和报告。',
    effectiveFrom: '2007-01-01',
    level: 'departmental-rule',
  },
  casBasic12: {
    id: 'cas-basic-standard-12',
    title: '企业会计准则——基本准则',
    article: '第十二条',
    excerpt:
      '企业应当以实际发生的交易或者事项为依据进行会计确认、计量和报告，如实反映符合确认和计量要求的各项会计要素及其他相关信息，保证会计信息真实可靠、内容完整。',
    effectiveFrom: '2007-01-01',
    level: 'departmental-rule',
  },
  casBasic16: {
    id: 'cas-basic-standard-16',
    title: '企业会计准则——基本准则',
    article: '第十六条',
    excerpt:
      '企业应当按照交易或者事项的经济实质进行会计确认、计量和报告，不应仅以交易或者事项的法律形式为依据。',
    effectiveFrom: '2007-01-01',
    level: 'departmental-rule',
  },

  /* ---------------- 税收征收管理法 ---------------- */
  taxCollection25: {
    id: 'tax-collection-law-25',
    title: '中华人民共和国税收征收管理法',
    article: '第二十五条',
    excerpt:
      '纳税人必须依照法律、行政法规规定或者税务机关依照法律、行政法规的规定确定的申报期限、申报内容如实办理纳税申报，报送纳税申报表、财务会计报表以及税务机关根据实际需要要求纳税人报送的其他纳税资料。',
    effectiveFrom: '2015-04-24',
    level: 'law',
  },
  taxCollection32: {
    id: 'tax-collection-law-32',
    title: '中华人民共和国税收征收管理法',
    article: '第三十二条',
    excerpt:
      '纳税人未按照规定期限缴纳税款的，扣缴义务人未按照规定期限解缴税款的，税务机关除责令限期缴纳外，从滞纳税款之日起，按日加收滞纳税款万分之五的滞纳金。',
    effectiveFrom: '2015-04-24',
    level: 'law',
  },
  taxCollection63: {
    id: 'tax-collection-law-63',
    title: '中华人民共和国税收征收管理法',
    article: '第六十三条',
    excerpt:
      '纳税人伪造、变造、隐匿、擅自销毁账簿、记账凭证，或者在账簿上多列支出或者不列、少列收入，或者经税务机关通知申报而拒不申报或者进行虚假的纳税申报，不缴或者少缴应纳税款的，是偷税。对纳税人偷税的，由税务机关追缴其不缴或者少缴的税款、滞纳金，并处不缴或者少缴的税款百分之五十以上五倍以下的罚款；构成犯罪的，依法追究刑事责任。',
    effectiveFrom: '2015-04-24',
    level: 'law',
  },
  taxCollection64: {
    id: 'tax-collection-law-64',
    title: '中华人民共和国税收征收管理法',
    article: '第六十四条',
    excerpt:
      '纳税人、扣缴义务人编造虚假计税依据的，由税务机关责令限期改正，并处五万元以下的罚款。纳税人不进行纳税申报，不缴或者少缴应纳税款的，由税务机关追缴其不缴或者少缴的税款、滞纳金，并处不缴或者少缴的税款百分之五十以上五倍以下的罚款。',
    effectiveFrom: '2015-04-24',
    level: 'law',
  },

  /* ---------------- 刑法 ---------------- */
  criminal201: {
    id: 'criminal-law-201',
    title: '中华人民共和国刑法',
    article: '第二百零一条',
    excerpt:
      '纳税人采取欺骗、隐瞒手段进行虚假纳税申报或者不申报，逃避缴纳税款数额较大并且占应纳税额百分之十以上的，处三年以下有期徒刑或者拘役，并处罚金；数额巨大并且占应纳税额百分之三十以上的，处三年以上七年以下有期徒刑，并处罚金。有第一款行为，经税务机关依法下达追缴通知后，补缴应纳税款，缴纳滞纳金，已受行政处罚的，不予追究刑事责任；但是，五年内因逃避缴纳税款受过刑事处罚或者被税务机关给予二次以上行政处罚的除外。',
    effectiveFrom: '2024-03-01',
    level: 'law',
  },
  criminal205: {
    id: 'criminal-law-205',
    title: '中华人民共和国刑法',
    article: '第二百零五条',
    excerpt:
      '虚开增值税专用发票或者虚开用于骗取出口退税、抵扣税款的其他发票的，处三年以下有期徒刑或者拘役，并处二万元以上二十万元以下罚金；虚开的税款数额较大或者有其他严重情节的，处三年以上十年以下有期徒刑，并处五万元以上五十万元以下罚金；虚开的税款数额巨大或者有其他特别严重情节的，处十年以上有期徒刑或者无期徒刑，并处五万元以上五十万元以下罚金或者没收财产。',
    effectiveFrom: '2024-03-01',
    level: 'law',
  },
  criminal205_1: {
    id: 'criminal-law-205-1',
    title: '中华人民共和国刑法',
    article: '第二百零五条之一',
    excerpt:
      '虚开本法第二百零五条规定以外的其他发票，情节严重的，处二年以下有期徒刑、拘役或者管制，并处罚金；情节特别严重的，处二年以上七年以下有期徒刑，并处罚金。',
    effectiveFrom: '2024-03-01',
    level: 'law',
  },
  criminal211: {
    id: 'criminal-law-211',
    title: '中华人民共和国刑法',
    article: '第二百一十一条',
    excerpt:
      '单位犯本节第二百零一条、第二百零三条、第二百零四条、第二百零七条、第二百零八条、第二百零九条规定之罪的，对单位判处罚金，并对其直接负责的主管人员和其他直接责任人员，依照各该条的规定处罚。',
    effectiveFrom: '2024-03-01',
    level: 'law',
  },
  judicial2024_4: {
    id: 'judicial-interpretation-2024-4',
    title: '最高人民法院、最高人民检察院关于办理危害税收征管刑事案件适用法律若干问题的解释',
    article: '法释〔2024〕4 号 第一条',
    excerpt:
      '纳税人逃避缴纳税款十万元以上、五十万元以上的，应当分别认定为刑法第二百零一条第一款规定的「数额较大」「数额巨大」。',
    effectiveFrom: '2024-03-20',
    level: 'normative-document',
  },

  /* ---------------- 发票管理办法 ---------------- */
  invoiceMeasures21: {
    id: 'invoice-measures-21',
    title: '中华人民共和国发票管理办法',
    article: '第二十一条',
    excerpt:
      '开具发票应当按照规定的时限、顺序、栏目，全部联次一次性如实开具，并加盖发票专用章。任何单位和个人不得有下列虚开发票行为：为他人、为自己开具与实际经营业务情况不符的发票；让他人为自己开具与实际经营业务情况不符的发票；介绍他人开具与实际经营业务情况不符的发票。',
    effectiveFrom: '2023-07-20',
    level: 'administrative-regulation',
  },

  /* ---------------- 会计档案管理办法 ---------------- */
  archives13: {
    id: 'accounting-archives-13',
    title: '会计档案管理办法',
    article: '第十三条',
    excerpt:
      '单位应当严格按照相关制度利用会计档案，在进行会计档案查阅、复制、借出时履行登记手续，严禁篡改和损坏。',
    effectiveFrom: '2016-01-01',
    level: 'departmental-rule',
  },

  /* ---------------- 企业内部控制基本规范 ---------------- */
  internalControl29: {
    id: 'internal-control-29',
    title: '企业内部控制基本规范',
    article: '第二十九条',
    excerpt:
      '不相容职务分离控制要求企业全面系统地分析、梳理业务流程中所涉及的不相容职务，实施相应的分离措施，形成各司其职、各负其责、相互制约的工作机制。',
    effectiveFrom: '2009-07-01',
    level: 'normative-document',
  },

  /* ---------------- 增值税暂行条例 ---------------- */
  vatRegulation4: {
    id: 'vat-regulation-4',
    title: '中华人民共和国增值税暂行条例',
    article: '第四条',
    excerpt:
      '纳税人销售货物、劳务、服务、无形资产、不动产，应纳税额为当期销项税额抵扣当期进项税额后的余额。应纳税额计算公式：应纳税额＝当期销项税额－当期进项税额。当期销项税额小于当期进项税额不足抵扣时，其不足部分可以结转下期继续抵扣。',
    effectiveFrom: '2017-11-19',
    level: 'administrative-regulation',
  },
  vatRegulation5: {
    id: 'vat-regulation-5',
    title: '中华人民共和国增值税暂行条例',
    article: '第五条',
    excerpt:
      '纳税人发生应税销售行为，按照销售额和本条例第二条规定的税率计算收取的增值税额，为销项税额。销项税额计算公式：销项税额＝销售额×税率。',
    effectiveFrom: '2017-11-19',
    level: 'administrative-regulation',
  },

  /* ---------------- 企业所得税法 ---------------- */
  citLaw4: {
    id: 'enterprise-income-tax-law-4',
    title: '中华人民共和国企业所得税法',
    article: '第四条',
    excerpt: '企业所得税的税率为 25%。非居民企业取得本法第三条第三款规定的所得，适用税率为 20%。',
    effectiveFrom: '2018-12-29',
    level: 'law',
  },
  citLaw28: {
    id: 'enterprise-income-tax-law-28',
    title: '中华人民共和国企业所得税法',
    article: '第二十八条',
    excerpt:
      '符合条件的小型微利企业，减按 20% 的税率征收企业所得税。国家需要重点扶持的高新技术企业，减按 15% 的税率征收企业所得税。',
    effectiveFrom: '2018-12-29',
    level: 'law',
  },

  /* ---------------- 城市维护建设税法 ---------------- */
  urbanMaintenanceTax2: {
    id: 'urban-maintenance-tax-law-2',
    title: '中华人民共和国城市维护建设税法',
    article: '第二条',
    excerpt: '城市维护建设税以纳税人依法实际缴纳的增值税、消费税税额为计税依据。',
    effectiveFrom: '2021-09-01',
    level: 'law',
  },
} as const satisfies Record<string, LawBasis>;

/** 法规键名，用于 `law('accountingLaw9')` 这类调用。 */
export type LawKey = keyof typeof LAW_LIBRARY;

/** 按 key 取一条法规依据。 */
export function law(key: LawKey): LawBasis {
  return LAW_LIBRARY[key];
}

/** 按 key 批量取法规依据，自动去重（同一 key 只保留一次）。 */
export function laws(...keys: LawKey[]): LawBasis[] {
  const seen = new Set<string>();
  const result: LawBasis[] = [];
  for (const key of keys) {
    const entry = LAW_LIBRARY[key];
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

/* ================================================================== */
/* 二、具名别名（检查项直接引用，避免拼写错误）                        */
/* ================================================================== */

export const LAW_ACCOUNTING_LAW_9: LawBasis = LAW_LIBRARY.accountingLaw9;
export const LAW_ACCOUNTING_LAW_13: LawBasis = LAW_LIBRARY.accountingLaw13;
export const LAW_ACCOUNTING_LAW_14: LawBasis = LAW_LIBRARY.accountingLaw14;
export const LAW_ACCOUNTING_LAW_20: LawBasis = LAW_LIBRARY.accountingLaw20;
export const LAW_ACCOUNTING_LAW_27: LawBasis = LAW_LIBRARY.accountingLaw27;
export const LAW_ACCOUNTING_LAW_37: LawBasis = LAW_LIBRARY.accountingLaw37;
export const LAW_ACCOUNTING_LAW_43: LawBasis = LAW_LIBRARY.accountingLaw43;
export const LAW_ACCOUNTING_LAW_44: LawBasis = LAW_LIBRARY.accountingLaw44;

export const LAW_ACCOUNTING_BASIS_48: LawBasis = LAW_LIBRARY.accountingBasis48;
export const LAW_ACCOUNTING_BASIS_50: LawBasis = LAW_LIBRARY.accountingBasis50;
export const LAW_ACCOUNTING_BASIS_51: LawBasis = LAW_LIBRARY.accountingBasis51;
export const LAW_ACCOUNTING_BASIS_52: LawBasis = LAW_LIBRARY.accountingBasis52;
export const LAW_ACCOUNTING_BASIS_60: LawBasis = LAW_LIBRARY.accountingBasis60;
export const LAW_ACCOUNTING_BASIS_79: LawBasis = LAW_LIBRARY.accountingBasis79;

export const LAW_ENTERPRISE_SYSTEM_11: LawBasis = LAW_LIBRARY.enterpriseSystem11;
export const LAW_SMALL_STANDARD_3: LawBasis = LAW_LIBRARY.smallStandard3;
export const LAW_SMALL_STANDARD_5: LawBasis = LAW_LIBRARY.smallStandard5;
export const LAW_CAS_BASIC_9: LawBasis = LAW_LIBRARY.casBasic9;
export const LAW_CAS_BASIC_12: LawBasis = LAW_LIBRARY.casBasic12;
export const LAW_CAS_BASIC_16: LawBasis = LAW_LIBRARY.casBasic16;

export const LAW_TAX_COLLECTION_25: LawBasis = LAW_LIBRARY.taxCollection25;
export const LAW_TAX_COLLECTION_32: LawBasis = LAW_LIBRARY.taxCollection32;
export const LAW_TAX_COLLECTION_63: LawBasis = LAW_LIBRARY.taxCollection63;
export const LAW_TAX_COLLECTION_64: LawBasis = LAW_LIBRARY.taxCollection64;

export const LAW_CRIMINAL_201: LawBasis = LAW_LIBRARY.criminal201;
export const LAW_CRIMINAL_205: LawBasis = LAW_LIBRARY.criminal205;
export const LAW_CRIMINAL_205_1: LawBasis = LAW_LIBRARY.criminal205_1;
export const LAW_CRIMINAL_211: LawBasis = LAW_LIBRARY.criminal211;
export const LAW_JUDICIAL_2024_4: LawBasis = LAW_LIBRARY.judicial2024_4;

export const LAW_INVOICE_MEASURES_21: LawBasis = LAW_LIBRARY.invoiceMeasures21;
export const LAW_ARCHIVES_13: LawBasis = LAW_LIBRARY.archives13;
export const LAW_INTERNAL_CONTROL_29: LawBasis = LAW_LIBRARY.internalControl29;
export const LAW_VAT_REGULATION_4: LawBasis = LAW_LIBRARY.vatRegulation4;
export const LAW_VAT_REGULATION_5: LawBasis = LAW_LIBRARY.vatRegulation5;
export const LAW_CIT_LAW_4: LawBasis = LAW_LIBRARY.citLaw4;
export const LAW_CIT_LAW_28: LawBasis = LAW_LIBRARY.citLaw28;
export const LAW_URBAN_MAINTENANCE_TAX_2: LawBasis = LAW_LIBRARY.urbanMaintenanceTax2;

/* ================================================================== */
/* 三、免责声明                                                        */
/* ================================================================== */

/**
 * 报告级免责声明。
 *
 * 为什么必须写：审核引擎输出的是「合规风险提示」，不是审计结论、税务鉴证结论，
 * 更不是税务机关的认定。措辞上必须明确边界，否则用户可能把系统提示当作法律意见。
 */
export const REVIEW_DISCLAIMER =
  '本报告由「账有律」会计自动化系统依据公开法律法规自动生成，用于企业内部合规自查与风险预警，' +
  '不构成法律意见、税务鉴证意见、审计意见或税务机关的认定结论。' +
  '法规适用需结合具体事实、地方口径与最新政策，正式申报与法律判断应由具备资质的专业人员作出。' +
  '系统不会、也不能自动向税务机关提交任何申报资料；所有申报均须由人工在电子税务局完成。';

/** 刑事风险条目的固定免责语，逐条附加在 detail 末尾。 */
export const CRIMINAL_DISCLAIMER =
  '免责说明：本条为系统基于现有数据的风险测算与提示，不构成法律意见；是否构成犯罪、是否追究刑事责任，' +
  '由税务机关依法认定、由司法机关依法裁判。';

/** 所有正式结论至少引用一条法规；这是兜底依据，防止出现「无依据结论」。 */
export const FALLBACK_BASIS: LawBasis = LAW_LIBRARY.accountingLaw9;
