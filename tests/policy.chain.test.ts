/**
 * 税会智链 + 税种导航测试。
 *
 * 这一层的错误最致命：栏次指错，会计就填错表；
 * 差异漏一条，账上就对不上。所以这里对「事项 → 栏次 → 差异 → 政策」
 * 的每一跳都做断言，并且强制校验跨文件的政策引用完整性。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUSINESS_EVENT_GROUPS,
  BusinessEventError,
  allTaxDifferences,
  buildNavigation,
  chainForEvent,
  chainForPolicy,
  contractTaxNavigations,
  explainTaxDifference,
  groupBusinessEvents,
  loadBusinessEvents,
  loadPolicyLibrary,
  locateByReturnLine,
  validateEventPolicyRefs,
} from '../src/policy/index.ts';

const lib = loadPolicyLibrary();
const events = loadBusinessEvents();
const navigation = buildNavigation(lib);

const REQUIRED_TAXES = [
  'vat',
  'cit',
  'iit',
  'consumption',
  'property',
  'stamp',
  'land_vat',
  'deed',
  'vehicle_vessel',
  'vehicle_purchase',
  'resource',
  'environmental',
  'urban_land',
  'urban_construction',
  'tariff',
  'farmland',
  'tobacco',
  'tonnage',
];

describe('业务事项数据完整性', () => {
  it('事项数量 ≥36，12 个分组全部有内容', () => {
    assert.ok(events.length >= 36, `业务事项不足: ${events.length}`);
    const groups = new Set(events.map((event) => event.group));
    assert.equal(groups.size, 12);
    for (const group of BUSINESS_EVENT_GROUPS) {
      assert.ok(groups.has(group), `分组「${group}」没有业务事项`);
    }
  });

  it('每个事项的四要素齐全', () => {
    for (const event of events) {
      assert.ok(event.id.length > 0);
      assert.ok(event.name.trim().length > 0, `${event.id} 缺少名称`);
      assert.ok(event.taxTypes.length >= 1, `${event.id} 未标注税种`);
      assert.ok(event.differences.length >= 1, `${event.id} 没有税会差异`);
      assert.ok(event.returnLines.length >= 1, `${event.id} 没有申报表栏次`);
      assert.ok(event.accountingGuide.length >= 2, `${event.id} 会计指引过少`);
      assert.ok(event.policyIds.length >= 2, `${event.id} 关联政策过少`);
      for (const line of event.returnLines) {
        assert.ok(line.form.trim().length > 0, `${event.id} 栏次缺少表名`);
        assert.ok(line.lineCode.trim().length > 0, `${event.id} 栏次缺少编号`);
        assert.ok(line.lineLabel.trim().length > 0, `${event.id} 栏次缺少名称`);
      }
      for (const difference of event.differences) {
        assert.ok(difference.description.length >= 20, `${difference.code} 说明过于简略`);
        assert.ok(difference.policyIds.length >= 1, `${difference.code} 没有法规依据`);
      }
    }
  });

  it('差异编码全库唯一（按差异反查的前提）', () => {
    const codes = events.flatMap((event) => event.differences.map((difference) => difference.code));
    assert.equal(new Set(codes).size, codes.length);
  });

  it('所有引用的政策 id 都存在于政策库', () => {
    assert.deepEqual(validateEventPolicyRefs(events, lib), []);
  });

  it('事件声明的税种都在契约税种范围内', () => {
    const contractTaxes = new Set([
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
    for (const event of events) {
      for (const taxType of event.taxTypes) {
        assert.ok(contractTaxes.has(taxType), `${event.id} 含非契约税种 ${taxType}`);
      }
    }
  });
});

describe('智链查询', () => {
  it('chainForEvent 返回政策、关联事项与缺失清单', () => {
    const chain = chainForEvent(events, 'evt-goods-sale');
    assert.equal(chain.event.id, 'evt-goods-sale');
    assert.ok(chain.policies.length >= 3);
    assert.deepEqual(chain.missingPolicyIds, []);
    assert.ok(chain.relatedEvents.length > 0 && chain.relatedEvents.length <= 6);
    assert.ok(chain.relatedEvents.every((event) => event.id !== 'evt-goods-sale'));
    for (const policy of chain.policies) {
      assert.ok(lib.get(policy.id) !== undefined);
    }
  });

  it('chainForEvent 的政策列表包含事项级与差异级引用', () => {
    const chain = chainForEvent(events, 'evt-rd-expense');
    const ids = chain.policies.map((policy) => policy.id);
    assert.ok(ids.includes('ann-2023-7'), '缺少研发加计扣除主文件');
    assert.ok(ids.includes('ann-2023-44'), '缺少差异级引用的行业特别规定');
    assert.ok(chain.policies.length >= new Set(ids).size);
  });

  it('chainForEvent 未知事项抛 BusinessEventError', () => {
    assert.throws(
      () => chainForEvent(events, 'evt-not-exist'),
      (error: unknown) => error instanceof BusinessEventError,
    );
  });

  it('locateByReturnLine 按「增值税第1栏」反查到销售收入类事项', () => {
    const hits = locateByReturnLine(events, 'vat', '第1栏');
    assert.ok(hits.some((event) => event.id === 'evt-goods-sale'));
    assert.ok(hits.every((event) => event.returnLines.some((line) => line.taxType === 'vat')));
  });

  it('栏次写法归一：第1栏 / 1 视为同一栏', () => {
    const withPrefix = locateByReturnLine(events, 'vat', '第1栏');
    const bare = locateByReturnLine(events, 'vat', '1');
    assert.deepEqual(
      withPrefix.map((event) => event.id).sort(),
      bare.map((event) => event.id).sort(),
    );
  });

  it('locateByReturnLine 支持企业所得税明细表号', () => {
    const hits = locateByReturnLine(events, 'cit', 'A105050');
    assert.ok(hits.some((event) => event.id === 'evt-salary-payment'));
  });

  it('空栏次不会误命中', () => {
    assert.deepEqual(locateByReturnLine(events, 'vat', '   '), []);
  });

  it('explainTaxDifference 返回差异与示例事项', () => {
    const result = explainTaxDifference('diff-rd-super-deduction', events);
    assert.ok(result !== null);
    assert.equal(result?.difference.code, 'diff-rd-super-deduction');
    assert.ok(result?.examples.includes('研发费用加计扣除'));
  });

  it('explainTaxDifference 对未知编码返回 null', () => {
    assert.equal(explainTaxDifference('diff-not-exist', events), null);
  });

  it('allTaxDifferences 按编码升序且不重复', () => {
    const list = allTaxDifferences(events);
    const codes = list.map((entry) => entry.difference.code);
    assert.equal(new Set(codes).size, codes.length);
    assert.deepEqual(codes, [...codes].sort());
    for (const entry of list) {
      assert.ok(entry.eventIds.length >= 1);
      assert.ok(entry.taxTypes.length >= 1);
    }
  });

  it('groupBusinessEvents 不丢事项且按固定分组顺序', () => {
    const grouped = groupBusinessEvents(events);
    const total = grouped.reduce((sum, bucket) => sum + bucket.events.length, 0);
    assert.equal(total, events.length);
    assert.deepEqual(
      grouped.map((bucket) => bucket.group),
      BUSINESS_EVENT_GROUPS.filter((group) => grouped.some((bucket) => bucket.group === group)),
    );
  });

  it('chainForPolicy 可按政策反查业务事项', () => {
    const hits = chainForPolicy(events, 'ann-2023-7');
    assert.ok(hits.some((event) => event.id === 'evt-rd-expense'));
    assert.ok(hits.some((event) => event.id === 'evt-rd-ledger'));
  });
});

describe('税种导航', () => {
  it('覆盖 19 个税种，包含要求的 18 个', () => {
    assert.equal(navigation.length, 19);
    const codes = navigation.map((item) => item.taxType);
    for (const taxType of REQUIRED_TAXES) {
      assert.ok((codes as string[]).includes(taxType), `导航缺少税种 ${taxType}`);
    }
  });

  it('每个税种都有申报表、申报周期和征管要点', () => {
    for (const item of navigation) {
      assert.ok(item.label.trim().length > 0, `${item.taxType} 缺少中文名`);
      assert.ok(item.forms.length >= 1, `${item.taxType} 缺少申报表`);
      assert.ok(item.keyPoints.length >= 3, `${item.taxType} 征管要点不足`);
      assert.ok(
        ['monthly', 'quarterly', 'annual'].includes(item.filingCycle),
        `${item.taxType} 申报周期非法`,
      );
    }
  });

  it('中央/地方政策数量与政策库一致', () => {
    for (const item of navigation) {
      const policies = lib.byTaxType(item.taxType);
      assert.equal(item.centralCount + item.localCount, policies.length, `${item.taxType} 统计不一致`);
      assert.equal(item.centralCount, policies.filter((policy) => policy.level === 'central').length);
    }
  });

  it('增值税导航指向 2026 年施行的增值税法', () => {
    const vat = navigation.find((item) => item.taxType === 'vat');
    assert.equal(vat?.latestPolicy?.id, 'vat-law-2024');
    assert.equal(vat?.latestPolicy?.effectiveFrom, '2026-01-01');
  });

  it('房产税导航能体现地方试点（地方 2 条，中央含「六税两费」文件）', () => {
    const property = navigation.find((item) => item.taxType === 'property');
    assert.equal(property?.localCount, 2);
    assert.equal(property?.centralCount, 2);
    assert.equal(
      property?.centralCount + (property?.localCount ?? 0),
      lib.byTaxType('property').length,
    );
  });

  it('每个税种都至少关联一条政策', () => {
    for (const item of navigation) {
      assert.ok(
        item.centralCount + item.localCount >= 1,
        `${item.taxType} 没有任何政策`,
      );
      assert.ok(item.latestPolicy !== null, `${item.taxType} 没有最新政策`);
    }
  });

  it('9 个契约税种可以安全地当作 TaxType 使用', () => {
    const contract = contractTaxNavigations(navigation);
    assert.equal(contract.length, 9);
    assert.deepEqual(contract.map((item) => item.taxType).sort(), [
      'cit',
      'consumption',
      'iit',
      'property',
      'resource',
      'stamp',
      'surcharge',
      'vat',
      'vehicle_purchase',
    ]);
  });
});
