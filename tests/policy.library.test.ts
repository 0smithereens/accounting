/**
 * 政策库数据完整性 + 检索行为测试。
 *
 * 这一组测试的定位是「数据守门员」：政策库里写错一个日期、漏一个税种、
 * 文号写法不一致，都会在这里被拦下。因为政策库是纯数据，
 * 没有测试的话错误会一路传导到申报口径上。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { PROJECT_ROOT } from '../src/core/config.ts';
import {
  POLICY_TAX_CODES,
  POLICY_TAX_CODE_LABEL,
  PolicyDataError,
  canonicalDocumentNo,
  citationOf,
  loadPolicyLibrary,
  searchPolicies,
  toTaxTypes,
} from '../src/policy/index.ts';

const lib = loadPolicyLibrary();
const CONTRACT_TAX_TYPES = [
  'vat',
  'cit',
  'iit',
  'surcharge',
  'stamp',
  'property',
  'consumption',
  'resource',
  'vehicle_purchase',
];

describe('政策库数据完整性', () => {
  it('政策数量满足最低要求（≥45 条）', () => {
    assert.ok(lib.count() >= 45, `政策数量不足: ${lib.count()}`);
  });

  it('每条政策的必填字段齐全且非空', () => {
    for (const policy of lib.all()) {
      assert.ok(policy.id.length > 0, 'id 为空');
      assert.ok(policy.documentNo.trim().length > 0, `${policy.id} 缺少文号`);
      assert.ok(policy.title.trim().length > 0, `${policy.id} 缺少标题`);
      assert.ok(policy.issuer.trim().length > 0, `${policy.id} 缺少发文机关`);
      assert.match(policy.issuedAt, /^\d{4}-\d{2}-\d{2}$/, `${policy.id} 发布日期格式非法`);
      assert.match(policy.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/, `${policy.id} 施行日期格式非法`);
      assert.ok(policy.summary.trim().length >= 10, `${policy.id} 摘要过短`);
      assert.ok(policy.keyPoints.length >= 2, `${policy.id} 要点少于 2 条`);
      assert.ok(policy.tags.length >= 1, `${policy.id} 缺少标签`);
      assert.ok(
        ['effective', 'amended', 'superseded', 'repealed', 'draft'].includes(policy.lifecycle),
        `${policy.id} 生命周期非法`,
      );
      assert.ok(['central', 'local'].includes(policy.level), `${policy.id} 层级非法`);
      if (policy.level === 'local') {
        assert.ok(policy.region !== undefined, `${policy.id} 是地方政策但缺少 region`);
      }
      if (policy.effectiveTo !== undefined) {
        assert.ok(policy.effectiveTo >= policy.effectiveFrom, `${policy.id} 失效日期早于施行日期`);
      }
    }
  });

  it('税种编码合法，且 taxTypes 是契约税种的子集', () => {
    for (const policy of lib.all()) {
      for (const code of policy.taxCodes) {
        assert.ok(POLICY_TAX_CODES.includes(code), `${policy.id} 含未知税种 ${code}`);
      }
      for (const taxType of policy.taxTypes) {
        assert.ok(CONTRACT_TAX_TYPES.includes(taxType), `${policy.id} 的 taxTypes 含非契约税种`);
      }
    }
  });

  it('id 与规范文号都唯一', () => {
    const ids = new Set<string>();
    const docNos = new Set<string>();
    for (const policy of lib.all()) {
      assert.ok(!ids.has(policy.id), `id 重复: ${policy.id}`);
      ids.add(policy.id);
      const key = canonicalDocumentNo(policy.documentNo);
      assert.ok(!docNos.has(key), `文号重复: ${policy.documentNo}`);
      docNos.add(key);
    }
  });

  it('十九条税种目录覆盖契约税种，且都有中文名', () => {
    assert.equal(POLICY_TAX_CODES.length, 19);
    for (const code of CONTRACT_TAX_TYPES) {
      assert.ok((POLICY_TAX_CODES as readonly string[]).includes(code), `缺少契约税种 ${code}`);
    }
    for (const code of POLICY_TAX_CODES) {
      assert.ok(POLICY_TAX_CODE_LABEL[code].length > 0, `${code} 缺少中文名`);
    }
  });

  it('税种投影：城市维护建设税并入附加税费', () => {
    assert.deepEqual(toTaxTypes(['urban_construction']), ['surcharge']);
    assert.deepEqual(toTaxTypes(['deed', 'vat']), ['vat']);
  });

  it('关系边 ≥60 条，且两端 id 都存在', () => {
    const relations = lib.relations();
    assert.ok(relations.length >= 60, `关系边不足: ${relations.length}`);
    const ids = new Set<string>();
    for (const relation of relations) {
      assert.ok(!ids.has(relation.id), `关系 id 重复: ${relation.id}`);
      ids.add(relation.id);
      assert.ok(lib.get(relation.from) !== undefined, `关系 ${relation.id} 起点不存在`);
      assert.ok(lib.get(relation.to) !== undefined, `关系 ${relation.id} 终点不存在`);
      assert.notEqual(relation.from, relation.to, `关系 ${relation.id} 是自环`);
    }
  });

  it('版本族 ≥8 组，成员都存在且不少于 2 个', () => {
    const families = lib.families();
    assert.ok(families.length >= 8, `版本族不足: ${families.length}`);
    for (const family of families) {
      assert.ok(family.members.length >= 2, `${family.id} 成员少于 2 个`);
      for (const member of family.members) {
        assert.ok(lib.get(member) !== undefined, `${family.id} 引用了不存在的成员 ${member}`);
      }
    }
  });

  it('加载默认数据不应产生任何警告', () => {
    assert.deepEqual(lib.warnings(), []);
  });
});

describe('时点查询与索引', () => {
  it('effectiveAt("2022-07-01") 包含印花税法、排除已废止的暂行条例', () => {
    const ids = lib.effectiveAt('2022-07-01').map((policy) => policy.id);
    assert.ok(ids.includes('stamp-law'), '缺印花税法');
    assert.ok(!ids.includes('stamp-interim'), '印花税暂行条例此时已废止');
    assert.ok(ids.includes('vat-interim-regulation'), '2022年增值税暂行条例仍有效');
    assert.ok(ids.includes('cit-law'), '缺企业所得税法');
  });

  it('effectiveAt 排除尚未施行的政策', () => {
    const ids = lib.effectiveAt('2025-12-31').map((policy) => policy.id);
    assert.ok(!ids.includes('vat-law-2024'), '增值税法2026年才施行');
  });

  it('upcoming 能检出增值税法 2026-01-01 施行', () => {
    const hits = lib.upcoming('2025-12-01', 60);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, 'vat-law-2024');
    assert.equal(hits[0]?.effectiveFrom, '2026-01-01');
  });

  it('upcoming 的时间窗是闭区间且以 asOf 为界', () => {
    assert.equal(lib.upcoming('2025-12-01', 30).length, 0, '2026-01-01 距 2025-12-01 共 31 天，窗口不够');
    assert.equal(lib.upcoming('2025-12-01', 31).length, 1, '第 31 天恰好落在闭区间端点');
    assert.equal(lib.upcoming('2025-12-02', 30).length, 1);
    assert.equal(lib.upcoming('2026-01-01', 30).length, 0, '已施行的不算 upcoming');
  });

  it('expiring 能检出增值税暂行条例 2025-12-31 失效', () => {
    const hits = lib.expiring('2025-10-01', 120);
    assert.ok(hits.some((policy) => policy.id === 'vat-interim-regulation'));
    assert.equal(hits.find((policy) => policy.id === 'vat-interim-regulation')?.effectiveTo, '2025-12-31');
    assert.equal(lib.expiring('2025-10-01', 30).length, 0, '30 天窗口内没有到期文件');
  });

  it('byDocumentNo 兼容四种文号写法', () => {
    for (const written of ['财税〔2016〕36号', '财税[2016]36号', '财税（2016）36号', '财税 2016 36 号']) {
      assert.equal(lib.byDocumentNo(written)?.id, 'caishui-2016-36', `写法不支持: ${written}`);
    }
  });

  it('byDocumentNo 找不到时返回 undefined，可按政策全称兜底', () => {
    assert.equal(lib.byDocumentNo('不存在的文号〔1999〕1号'), undefined);
    assert.equal(lib.byDocumentNo('中华人民共和国印花税法')?.id, 'stamp-law');
  });

  it('byTaxType 按税种检索，含契约外税种与投影税种', () => {
    const vat = lib.byTaxType('vat');
    assert.ok(vat.length >= 8);
    assert.ok(vat.every((policy) => policy.taxCodes.includes('vat')));
    assert.ok(lib.byTaxType('land_vat').some((policy) => policy.id === 'land-vat-interim'));
    assert.ok(
      lib.byTaxType('surcharge').some((policy) => policy.id === 'urban-construction-law'),
      '城建税法应能按附加税费检索到',
    );
  });

  it('byLifecycle / byLevel 过滤正确', () => {
    const superseded = lib.byLifecycle('superseded');
    assert.ok(superseded.some((policy) => policy.id === 'stamp-interim'));
    assert.ok(superseded.every((policy) => policy.lifecycle === 'superseded'));
    const local = lib.byLevel('local');
    assert.equal(local.length, 2);
    assert.ok(local.every((policy) => policy.region !== undefined));
  });

  it('citationOf 生成可写进报告的法规引用', () => {
    const policy = lib.get('vat-law-2024');
    assert.ok(policy !== undefined);
    const citation = citationOf(policy);
    assert.ok(citation.includes('《中华人民共和国增值税法》'));
    assert.ok(citation.includes('主席令第四十一号'));
    assert.ok(citationOf(policy, '第三十八条').endsWith('第三十八条'));
  });

  it('get 不存在返回 undefined', () => {
    assert.equal(lib.get('no-such-policy'), undefined);
    assert.equal(lib.get('vat-law-2024')?.title, '中华人民共和国增值税法');
  });

  it('数据目录不存在时抛出 PolicyDataError', () => {
    assert.throws(
      () => loadPolicyLibrary(join(PROJECT_ROOT, '.no-such-policy-dir')),
      (error: unknown) => error instanceof PolicyDataError && /不存在/.test((error as Error).message),
    );
  });
});

describe('政策检索打分', () => {
  it('无关键词时按过滤器返回全部，得分为 0', () => {
    const hits = searchPolicies(lib, { limit: 5 });
    assert.equal(hits.length, 5);
    assert.ok(hits.every((hit) => hit.score === 0));
    assert.ok(hits.every((hit) => hit.snippet.length > 0));
  });

  it('标题命中优先于摘要命中', () => {
    const hits = searchPolicies(lib, { text: '印花税', limit: 10 });
    assert.ok(hits.length > 0);
    const top = hits[0];
    assert.ok(top?.matchedFields.includes('标题'), '首位命中应包含标题');
    // 标题命中 10 分；仅摘要/要点命中的得分必须低于它
    const summaryOnly = hits.find(
      (hit) => !hit.matchedFields.includes('标题') && hit.matchedFields.includes('摘要'),
    );
    if (summaryOnly !== undefined) {
      assert.ok(summaryOnly.score < (top?.score ?? 0));
    }
  });

  it('得分按降序排列，且标题命中不低于 10 分', () => {
    const hits = searchPolicies(lib, { text: '研发费用', limit: 10 });
    assert.ok(hits.length >= 3);
    for (let i = 1; i < hits.length; i += 1) {
      const previous = hits[i - 1]?.score ?? 0;
      const current = hits[i]?.score ?? 0;
      assert.ok(previous >= current, '得分未按降序排列');
    }
    const titled = hits.find((hit) => hit.matchedFields.includes('标题'));
    assert.ok(titled !== undefined && titled.score >= 10);
  });

  it('文号命中权重为 8 分', () => {
    const hits = searchPolicies(lib, { text: '2023年第7号', limit: 10 });
    const hit = hits.find((item) => item.policy.id === 'ann-2023-7');
    assert.ok(hit !== undefined, '未命中2023年第7号');
    assert.ok(hit.score >= 8);
    assert.ok(hit.matchedFields.includes('文号'));
  });

  it('多关键词取交集（AND）', () => {
    const hits = searchPolicies(lib, { text: '增值税 小规模', limit: 20 });
    assert.ok(hits.length > 0);
    for (const hit of hits) {
      const text = `${hit.policy.title}${hit.policy.summary}${hit.policy.tags.join('')}${hit.policy.keyPoints.join('')}${hit.policy.documentNo}`;
      assert.ok(text.includes('增值税'), `${hit.policy.id} 未包含首个关键词`);
      assert.ok(text.includes('小规模'), `${hit.policy.id} 未包含第二个关键词`);
    }
  });

  it('中文 2-gram 降级：整串命中失败时仍能召回', () => {
    const hits = searchPolicies(lib, { text: '研发费用加计扣除政策', limit: 10 });
    assert.ok(hits.length > 0, '2-gram 降级未召回任何结果');
    assert.ok(hits.some((hit) => hit.policy.id === 'ann-2023-7'));
  });

  it('税种与层级过滤生效', () => {
    const hits = searchPolicies(lib, { text: '房产税', taxTypes: ['property'], limit: 20 });
    assert.ok(hits.length > 0);
    assert.ok(hits.every((hit) => hit.policy.taxCodes.includes('property')));
    const local = searchPolicies(lib, { text: '房产税', level: 'local', limit: 20 });
    assert.ok(local.length > 0);
    assert.ok(local.every((hit) => hit.policy.level === 'local'));
  });

  it('施行期间过滤按区间交集计算', () => {
    const hits = searchPolicies(lib, { from: '2022-01-01', to: '2022-12-31', limit: 100 });
    assert.ok(hits.length > 0);
    for (const hit of hits) {
      assert.ok(hit.policy.effectiveFrom <= '2022-12-31');
      assert.ok(hit.policy.effectiveTo === undefined || hit.policy.effectiveTo >= '2022-01-01');
    }
  });

  it('limit 生效且不超过上限', () => {
    assert.equal(searchPolicies(lib, { limit: 3 }).length, 3);
    assert.equal(searchPolicies(lib, { limit: 0 }).length, 1, 'limit 至少为 1');
    assert.ok(searchPolicies(lib, { limit: 1000 }).length <= 200);
  });

  it('标签与生命周期过滤生效', () => {
    const hits = searchPolicies(lib, { lifecycle: ['superseded'], limit: 100 });
    assert.ok(hits.length > 0);
    assert.ok(hits.every((hit) => hit.policy.lifecycle === 'superseded'));
    const tagged = searchPolicies(lib, { tags: ['研发费用'], limit: 100 });
    assert.ok(tagged.length > 0);
    assert.ok(tagged.every((hit) => hit.policy.tags.includes('研发费用')));
  });
});
