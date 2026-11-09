/**
 * 税种导航元数据。
 *
 * 为什么需要「导航」而不是让前端自己拼菜单：
 *  中国税制的申报周期、申报表名称、申报期限、必需资料因税种而异，
 *  且会随政策调整（如小规模纳税人按季申报的适用范围变化）。
 *  把这些元数据集中在一处，前端只负责渲染，政策一变只改这里，
 *  不会出现「界面写着月报、实际却按季申报」这种口径错位。
 *
 * 同时它也是「这个税种系统能不能自动算」的能力声明：
 *  supported=false 的税种会明确告诉用户「需要手工填报」，
 *  而不是悄悄给出一张全 0 的表让人误以为算过了。
 */

import type { FilingCycle, LawBasis, TaxType } from '../core/contracts.ts';
import { TAX_TYPE_LABEL } from '../core/contracts.ts';

import { LAW_BASIS } from './rates.ts';

/** 单个税种的导航条目。 */
export interface TaxNavItem {
  taxType: TaxType;
  label: string;
  /** 申报周期 */
  cycle: FilingCycle;
  /** 申报期限说明（人话） */
  deadline: string;
  /** 申报表名称 */
  formName: string;
  /** 申报表关键栏次 */
  keyLines: Array<{ code: string; label: string }>;
  /** 计算所需数据 */
  requiredData: string[];
  /** 主要法规依据 */
  basis: LawBasis[];
  /** 系统是否支持自动计算 */
  supported: boolean;
  /** 操作提示 */
  tips: string[];
}

/** 全部税种导航（顺序即界面展示顺序）。 */
export const TAX_NAVIGATION: readonly TaxNavItem[] = [
  {
    taxType: 'vat',
    label: TAX_TYPE_LABEL.vat,
    cycle: 'monthly',
    deadline: '月度终了后 15 日内（按季申报的为季度终了后 15 日内）',
    formName: '增值税及附加税费申报表（一般纳税人适用 / 小规模纳税人适用）',
    keyLines: [
      { code: '11', label: '销项税额' },
      { code: '12', label: '进项税额' },
      { code: '19', label: '应纳税额' },
      { code: '20', label: '期末留抵税额' },
      { code: '25', label: '本期应补(退)税额' },
    ],
    requiredData: ['销项发票明细（按税率分类）', '进项发票及认证抵扣明细', '上期留抵税额', '免税/零税率业务清单'],
    basis: [LAW_BASIS.vatLaw, LAW_BASIS.vatSmallScale19, LAW_BASIS.vatAdditionalDeduction],
    supported: true,
    tips: [
      '兼营不同税率业务必须分别核算，未分别核算的从高适用税率',
      '小规模纳税人月销售额 10 万元以下免征，判断口径为不含税销售额',
      '加计抵减额只抵减应纳税额，不得增加留抵',
    ],
  },
  {
    taxType: 'surcharge',
    label: TAX_TYPE_LABEL.surcharge,
    cycle: 'monthly',
    deadline: '与增值税、消费税同时申报缴纳',
    formName: '增值税及附加税费申报表（附列资料五）',
    keyLines: [
      { code: 'SUR-BASE', label: '计税依据（实缴增值税、消费税）' },
      { code: 'SUR-CITY', label: '城市维护建设税' },
      { code: 'SUR-EDU', label: '教育费附加' },
      { code: 'SUR-LOCAL', label: '地方教育附加' },
      { code: 'SUR-TOTAL', label: '附加税费合计' },
    ],
    requiredData: ['实际缴纳的增值税额', '实际缴纳的消费税额', '纳税人所在地（市区/县城镇/其他）', '是否属于六税两费减半范围'],
    basis: [LAW_BASIS.cityTaxLaw, LAW_BASIS.educationSurchargeRule, LAW_BASIS.localEducationRule, LAW_BASIS.sixTaxesHalf12],
    supported: true,
    tips: [
      '计税依据是「实际缴纳」的增值税、消费税，形成留抵未缴税的不计提',
      '月销售额 10 万元以下免征教育费附加、地方教育附加，城建税不免',
      '六税两费减半适用于小规模纳税人、小型微利企业和个体工商户',
    ],
  },
  {
    taxType: 'cit',
    label: TAX_TYPE_LABEL.cit,
    cycle: 'quarterly',
    deadline: '季度终了后 15 日内预缴；年度终了后 5 个月内汇算清缴',
    formName: '中华人民共和国企业所得税月（季）度预缴纳税申报表（A 类）/ 年度纳税申报表（A 类）',
    keyLines: [
      { code: 'A13', label: '利润总额' },
      { code: 'A15', label: '纳税调整增加额' },
      { code: 'A16', label: '纳税调整减少额' },
      { code: 'A22', label: '应纳税所得额' },
      { code: 'A27', label: '应纳税额' },
      { code: 'A32', label: '本年应补(退)所得税额' },
    ],
    requiredData: ['利润表', '业务招待费、广告费、福利费等明细', '工资薪金总额', '研发费用辅助账', '以前年度亏损台账', '已预缴税额'],
    basis: [LAW_BASIS.citLaw, LAW_BASIS.citRegulation, LAW_BASIS.sixTaxesHalf12, LAW_BASIS.citRdSuperDeduction7],
    supported: true,
    tips: [
      '季度预缴按会计实际利润额，纳税调整在年度汇算时统一处理',
      '小型微利企业年应纳税所得额 300 万元以内实际税负 5%',
      '业务招待费按发生额 60% 与收入 5‰ 孰低扣除',
    ],
  },
  {
    taxType: 'iit',
    label: TAX_TYPE_LABEL.iit,
    cycle: 'monthly',
    deadline: '次月 15 日内',
    formName: '个人所得税扣缴申报表',
    keyLines: [
      { code: 'IIT-1', label: '累计收入额' },
      { code: 'IIT-3', label: '累计减除费用' },
      { code: 'IIT-7', label: '累计预扣预缴应纳税所得额' },
      { code: 'IIT-10', label: '累计应预扣预缴税额' },
      { code: 'IIT-13', label: '本期应预扣预缴税额' },
    ],
    requiredData: ['工资表（应发、三险一金、专项附加扣除）', '累计已预扣税额', '免税收入与减免税额'],
    basis: [LAW_BASIS.iitLaw, LAW_BASIS.iitWithholding61, LAW_BASIS.iitSpecialAdditional],
    supported: true,
    tips: [
      '必须使用累计预扣法，不能按月单独套税率表',
      '累计应纳税所得额为负时本期不预扣',
      '多预扣的税额只能通过年度汇算清缴退税，系统不会自动倒扣工资',
    ],
  },
  {
    taxType: 'stamp',
    label: TAX_TYPE_LABEL.stamp,
    cycle: 'quarterly',
    deadline: '季度终了后 15 日内（按次贴花的在书立时缴纳）',
    formName: '财产和行为税纳税申报表（印花税税源明细表）',
    keyLines: [
      { code: 'STAMP-SALE', label: '买卖合同' },
      { code: 'STAMP-LOAN', label: '借款合同' },
      { code: 'STAMP-LEASE', label: '租赁合同' },
      { code: 'STAMP-ACCOUNT_BOOK', label: '营业账簿' },
      { code: 'STAMP-TOTAL', label: '印花税合计' },
    ],
    requiredData: ['本期签订的合同清单（按税目分类）', '合同金额（不含增值税）', '实收资本与资本公积增加额'],
    basis: [LAW_BASIS.stampLaw, LAW_BASIS.stampPolicy22, LAW_BASIS.sixTaxesHalf12],
    supported: true,
    tips: [
      '不同税目税率相差可达 20 倍，必须按税目分别计算',
      '计税依据不含合同列明的增值税税款',
      '证券交易印花税不参与六税两费减半',
    ],
  },
  {
    taxType: 'property',
    label: TAX_TYPE_LABEL.property,
    cycle: 'quarterly',
    deadline: '季度终了后 15 日内（从价计征可按年分期）',
    formName: '财产和行为税纳税申报表（房产税税源明细表）',
    keyLines: [
      { code: 'PROPERTY-PAYABLE', label: '应纳房产税' },
    ],
    requiredData: ['房产原值', '租金收入', '房产所在地', '从价/从租计征方式'],
    basis: [LAW_BASIS.sixTaxesHalf12],
    supported: false,
    tips: [
      '房产税从价计征按房产原值一次减除 10%~30% 后的余值、年税率 1.2%；从租计征按租金收入 12%',
      '本系统尚未实现房产税自动计算，请手工填报后回填事实',
    ],
  },
  {
    taxType: 'consumption',
    label: TAX_TYPE_LABEL.consumption,
    cycle: 'monthly',
    deadline: '月度终了后 15 日内',
    formName: '消费税及附加税费申报表',
    keyLines: [
      { code: 'CONSUMPTION-PAYABLE', label: '应纳消费税' },
    ],
    requiredData: ['应税消费品销售数量与销售额', '适用税目税率', '已纳消费税扣除额'],
    basis: [LAW_BASIS.taxCollectionLaw],
    supported: false,
    tips: [
      '消费税按具体税目适用比例税率、定额税率或复合计税',
      '本系统尚未实现消费税自动计算，请手工填报后回填事实',
    ],
  },
  {
    taxType: 'resource',
    label: TAX_TYPE_LABEL.resource,
    cycle: 'monthly',
    deadline: '月度终了后 15 日内',
    formName: '财产和行为税纳税申报表（资源税税源明细表）',
    keyLines: [
      { code: 'RESOURCE-PAYABLE', label: '应纳资源税' },
    ],
    requiredData: ['应税矿产品销售量', '适用税率', '减免项目'],
    basis: [LAW_BASIS.sixTaxesHalf12],
    supported: false,
    tips: [
      '资源税按矿种适用比例税率或定额税率，各省具体税率不同',
      '本系统尚未实现资源税自动计算，请手工填报后回填事实',
    ],
  },
  {
    taxType: 'vehicle_purchase',
    label: TAX_TYPE_LABEL.vehicle_purchase,
    cycle: 'monthly',
    deadline: '纳税义务发生之日起 60 日内',
    formName: '车辆购置税纳税申报表',
    keyLines: [
      { code: 'VEHICLE-PURCHASE-PAYABLE', label: '应纳车辆购置税' },
    ],
    requiredData: ['车辆计税价格', '是否新能源汽车（免征）', '已缴纳车辆购置税'],
    basis: [LAW_BASIS.taxCollectionLaw],
    supported: false,
    tips: [
      '车辆购置税税率为 10%，按不含增值税的计税价格计算',
      '本系统尚未实现车辆购置税自动计算，请手工填报后回填事实',
    ],
  },
];

/** 按税种取导航条目。 */
export function getTaxNav(taxType: TaxType): TaxNavItem | undefined {
  for (const item of TAX_NAVIGATION) {
    if (item.taxType === taxType) return item;
  }
  return undefined;
}

/** 系统支持自动计算的税种。 */
export function listSupportedTaxTypes(): TaxType[] {
  return TAX_NAVIGATION.filter((item) => item.supported).map((item) => item.taxType);
}

/** 按申报周期筛选税种。 */
export function taxNavForCycle(cycle: FilingCycle): TaxNavItem[] {
  return TAX_NAVIGATION.filter((item) => item.cycle === cycle);
}

/** 申报日历：给出「某期间需要申报哪些税种」。 */
export function filingChecklist(period: string): TaxNavItem[] {
  const month = Number(period.slice(5, 7));
  const isQuarterEnd = month === 3 || month === 6 || month === 9 || month === 12;
  return TAX_NAVIGATION.filter((item) => {
    if (item.cycle === 'monthly') return true;
    if (item.cycle === 'quarterly') return isQuarterEnd;
    return month === 12;
  });
}
