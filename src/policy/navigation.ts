/**
 * 税种导航：税种 → 中央/地方政策数量 → 申报表与征管路径。
 *
 * 为什么这样设计：
 *  1. 导航不是「把政策按税种分组」那么简单，用户真正需要的是
 *     「这个税种归谁管、填哪张表、多久申报一次、有哪些在建政策」。
 *     所以每个税种都挂了一张固定的「申报画像」（forms / filingCycle / keyPoints），
 *     政策数量与最新文件则从政策库实时统计，保证数字永远和数据一致。
 *  2. 税种目录固定为 19 个现行税种（含附加税费），不跟随数据文件变化：
 *     某个税种暂时没有入库政策，也要在导航里出现并显示 0，
 *     否则用户会以为「系统不支持这个税种」。
 *  3. 契约 TaxType 只有 9 个税种（计税引擎需要的那 9 个），
 *     导航必须覆盖 18 个税种，因此这里用 PolicyTaxCode 超集；
 *     9 个契约税种的编码完全一致，可以安全地当作 TaxType 使用。
 *
 * 申报周期说明：FilingCycle 只有月度/季度/年度三档，
 * 「按次申报」的税种（车辆购置税、契税、耕地占用税等）统一记为 monthly，
 * 并在 keyPoints 中明确写「按次」，避免把按次申报误当成按月申报。
 */

import type { FilingCycle, PolicyNode, TaxType } from '../core/contracts.ts';
import type { PolicyLibrary, PolicyTaxCode, PolicyRecord } from './library.ts';
import { POLICY_TAX_CODES, POLICY_TAX_CODE_LABEL } from './library.ts';

/** 单个税种的导航项。 */
export interface TaxTypeNavigation {
  /** 税种编码；9 个契约税种可原样作为 TaxType 使用 */
  taxType: PolicyTaxCode;
  label: string;
  centralCount: number;
  localCount: number;
  /** 该税种下最新的一份现行有效政策（没有则为 null） */
  latestPolicy: PolicyNode | null;
  /** 申报表名称（主表在前） */
  forms: string[];
  filingCycle: FilingCycle;
  /** 征管要点（含「按次申报」等特殊说明） */
  keyPoints: string[];
}

interface NavProfile {
  forms: string[];
  filingCycle: FilingCycle;
  keyPoints: string[];
}

/**
 * 19 个税种的申报画像。
 *
 * 这些内容变化很慢（申报表换版才会改），因此写在代码里而不是 YAML 里：
 * 写进代码可以在类型层面保证每个税种都有画像，漏一个就编译不过。
 */
const NAV_PROFILES: Record<PolicyTaxCode, NavProfile> = {
  vat: {
    forms: [
      '增值税及附加税费申报表（一般纳税人适用）',
      '增值税及附加税费申报表（小规模纳税人适用）',
      '增值税预缴税款表',
    ],
    filingCycle: 'monthly',
    keyPoints: [
      '一般纳税人按月申报，小规模纳税人可选择按季申报。',
      '2026年1月1日起以《增值税法》为依据，暂行条例同时废止。',
      '小规模纳税人月销售额10万元以下免征、3%征收率减按1%（执行至2027年底）。',
      '留抵退税需符合条件并单独申请，退税额与申报表第20栏勾稽。',
    ],
  },
  consumption: {
    forms: ['消费税及附加税费申报表'],
    filingCycle: 'monthly',
    keyPoints: [
      '在应税消费品的生产、委托加工和进口环节征收。',
      '进口环节消费税由海关代征，随报关单一并缴纳。',
      '计税方式分为从价定率、从量定额和复合计税三种。',
    ],
  },
  cit: {
    forms: [
      '企业所得税月（季）度预缴纳税申报表（A类）',
      '企业所得税年度纳税申报表（A类）',
      '中华人民共和国扣缴企业所得税报告表',
    ],
    filingCycle: 'quarterly',
    keyPoints: [
      '按月（季）预缴，年度终了后五个月内完成汇算清缴。',
      '小型微利企业实际税负5%，高新技术企业适用15%优惠税率。',
      '研发费用加计扣除100%，需按项目设置辅助账并留存备查。',
      '税前扣除凭证、资产损失、关联交易均需专项资料支撑。',
    ],
  },
  iit: {
    forms: [
      '个人所得税扣缴申报表',
      '个人所得税年度自行申报表',
      '个人所得税经营所得纳税申报表（A表）',
    ],
    filingCycle: 'monthly',
    keyPoints: [
      '工资薪金按累计预扣法预扣预缴，次月十五日内申报。',
      '综合所得年度汇算期为次年3月1日至6月30日。',
      '专项附加扣除由纳税人自行申报，扣缴义务人据以计算。',
      '全年一次性奖金可选择单独计税，一个纳税年度只能用一次。',
    ],
  },
  surcharge: {
    forms: ['增值税及附加税费申报表（附列资料五）', '财产和行为税纳税申报表'],
    filingCycle: 'monthly',
    keyPoints: [
      '以实际缴纳的增值税、消费税税额为计税依据。',
      '城建税按地区适用7%、5%、1%，教育费附加3%，地方教育附加2%。',
      '「六税两费」减半政策执行至2027年12月31日。',
      '进口环节不征城建税，出口不退。',
    ],
  },
  stamp: {
    forms: ['财产和行为税纳税申报表（印花税税源明细表）'],
    filingCycle: 'quarterly',
    keyPoints: [
      '按季、按年或按次计征，具体方式由主管税务机关确定。',
      '买卖合同的税率为价款的万分之三，借款合同为万分之零点五。',
      '计税依据不包括合同列明的增值税税款。',
      '营业账簿按实收资本与资本公积合计的万分之二点五计税。',
    ],
  },
  property: {
    forms: ['财产和行为税纳税申报表（房产税税源明细表）'],
    filingCycle: 'quarterly',
    keyPoints: [
      '自用房产按余值从价计征，税率1.2%；出租房产按租金从租计征，税率12%。',
      '房产原值一次减除10%至30%后的余值为计税依据。',
      '个人所有非营业用的房产免征。',
      '上海、重庆对部分个人住房开展试点征收。',
    ],
  },
  urban_land: {
    forms: ['财产和行为税纳税申报表（城镇土地使用税税源明细表）'],
    filingCycle: 'quarterly',
    keyPoints: [
      '以实际占用的土地面积为计税依据，按年计算、分期缴纳。',
      '单位税额按城市规模分档，具体标准由省级人民政府确定。',
      '与房产税通常在同一张财产和行为税申报表中合并申报。',
    ],
  },
  land_vat: {
    forms: [
      '土地增值税纳税申报表（一）（从事房地产开发的纳税人预征适用）',
      '土地增值税纳税申报表（二）（非从事房地产开发的纳税人适用）',
      '土地增值税清算申报表',
    ],
    filingCycle: 'monthly',
    keyPoints: [
      '实行30%、40%、50%、60%四级超率累进税率。',
      '房地产开发企业通常先预征、后清算。',
      '纳税人建造普通标准住宅出售，增值率未超过20%的免征。',
      '扣除项目包括土地价款、开发成本、开发费用及加计20%扣除。',
    ],
  },
  deed: {
    forms: ['契税纳税申报表'],
    filingCycle: 'monthly',
    keyPoints: [
      '在土地、房屋权属转移时向承受方征收，税率为3%至5%。',
      '具体适用税率由省级人民政府在规定幅度内提出。',
      '一般在办理权属登记前缴纳，按次申报。',
      '婚姻关系存续期间夫妻之间变更权属等情形免征。',
    ],
  },
  vehicle_purchase: {
    forms: ['车辆购置税纳税申报表'],
    filingCycle: 'monthly',
    keyPoints: [
      '税率10%，在车辆登记注册前一次性缴纳，按次申报。',
      '计税价格为支付给销售者的全部价款，不含增值税。',
      '新能源汽车减免按现行有效规定执行。',
    ],
  },
  vehicle_vessel: {
    forms: ['车船税纳税申报表', '车船税代收代缴报告表'],
    filingCycle: 'annual',
    keyPoints: [
      '按年申报缴纳，通常由保险机构在收取交强险时代收代缴。',
      '乘用车按发动机排气量分档确定年基准税额。',
      '节约能源、使用新能源的车船可减征或免征。',
    ],
  },
  resource: {
    forms: ['财产和行为税纳税申报表（资源税税源明细表）'],
    filingCycle: 'monthly',
    keyPoints: [
      '对开发应税资源的单位和个人征收，实行比例税率或定额税率。',
      '按月或按季申报，具体由主管税务机关确定。',
      '部分情形（如开采原油过程中用于加热修井的原油）免征。',
    ],
  },
  environmental: {
    forms: ['环境保护税纳税申报表（A类）', '环境保护税纳税申报表（B类）'],
    filingCycle: 'quarterly',
    keyPoints: [
      '按季申报缴纳，以污染当量数、排放量或超标分贝数为计税依据。',
      '直接向环境排放应税污染物的企业事业单位为纳税人。',
      '依法设立的污水、生活垃圾集中处理场所达标排放的暂予免征。',
    ],
  },
  urban_construction: {
    forms: ['增值税及附加税费申报表（附列资料五）'],
    filingCycle: 'monthly',
    keyPoints: [
      '以实际缴纳的增值税、消费税税额为计税依据。',
      '纳税人所在地在市区的适用7%，在县城、镇的适用5%，其他地点适用1%。',
      '随增值税、消费税同时申报缴纳。',
      '进口货物或境外单位向境内销售劳务、服务、无形资产的，不征收城建税。',
    ],
  },
  tariff: {
    forms: ['海关进出口货物报关单', '海关进口增值税专用缴款书'],
    filingCycle: 'monthly',
    keyPoints: [
      '由海关负责征收，随进出口报关单向海关申报。',
      '进口关税设置最惠国税率、协定税率、特惠税率、普通税率等。',
      '完税价格以成交价格为基础确定。',
      '进口环节增值税、消费税由海关一并代征。',
    ],
  },
  farmland: {
    forms: ['耕地占用税纳税申报表'],
    filingCycle: 'monthly',
    keyPoints: [
      '按实际占用的耕地面积一次性征收，按次申报。',
      '占用基本农田的，适用税额应当在规定基础上提高。',
      '与用地审批、土地出让环节衔接，通常在办理用地手续前缴纳。',
    ],
  },
  tobacco: {
    forms: ['烟叶税纳税申报表'],
    filingCycle: 'monthly',
    keyPoints: [
      '在收购烟叶环节由收购单位缴纳，税率为20%。',
      '计税依据为收购烟叶实际支付的价款总额。',
      '由收购地税务机关负责征收。',
    ],
  },
  tonnage: {
    forms: ['船舶吨税申报单', '船舶吨税执照'],
    filingCycle: 'monthly',
    keyPoints: [
      '对自境外港口进入境内港口的船舶征收，由海关负责征收。',
      '按净吨位与吨税执照期限适用不同税额标准。',
      '执照期限分为1年、90天、30天，按次申报。',
    ],
  },
};

function latestByEffective(policies: PolicyRecord[]): PolicyRecord | null {
  if (policies.length === 0) return null;
  const sorted = [...policies].sort((a, b) => {
    if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
    if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
  return sorted[0] ?? null;
}

/**
 * 构建税种导航。
 *
 * latestPolicy 优先取「现行有效（effective/amended）」中施行日期最新的一份：
 * 已经废止的文件不应当出现在导航的「最新政策」位置，
 * 否则用户会照着失效口径做账。
 */
export function buildNavigation(lib: PolicyLibrary): TaxTypeNavigation[] {
  return POLICY_TAX_CODES.map((taxType) => {
    const profile = NAV_PROFILES[taxType];
    const policies = lib.byTaxType(taxType);
    const active = policies.filter(
      (policy) => policy.lifecycle === 'effective' || policy.lifecycle === 'amended',
    );
    const latestPolicy = latestByEffective(active) ?? latestByEffective(policies);

    return {
      taxType,
      label: POLICY_TAX_CODE_LABEL[taxType],
      centralCount: policies.filter((policy) => policy.level === 'central').length,
      localCount: policies.filter((policy) => policy.level === 'local').length,
      latestPolicy,
      forms: profile.forms.slice(),
      filingCycle: profile.filingCycle,
      keyPoints: profile.keyPoints.slice(),
    };
  });
}

/** 税种导航里「属于契约税种」的那些项（供计税引擎直接消费）。 */
export function contractTaxNavigations(
  navigation: TaxTypeNavigation[],
): Array<TaxTypeNavigation & { taxType: TaxType }> {
  const contractTaxes = new Set<string>([
    'vat',
    'cit',
    'iit',
    'surcharge',
    'stamp',
    'property',
    'consumption',
    'resource',
    'vehicle_purchase',
  ]);
  return navigation.filter(
    (item): item is TaxTypeNavigation & { taxType: TaxType } => contractTaxes.has(item.taxType),
  );
}
