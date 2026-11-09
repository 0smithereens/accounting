/**
 * 会计准则双轨（企业会计准则 / 小企业会计准则）的单元测试。
 *
 * 重点验证「两套准则的实质差异」而不是「两套 YAML 都能读」：
 *  1. 12 项特性开关逐项正确，特别是六项核心差异（递延所得税 / 公允价值 / 减值 /
 *     研发资本化 / 权益法 / 以前年度损益调整）；
 *  2. 禁用科目判定必须「编码 + 名称」双重匹配——两套准则编码体系不同，
 *     5301 在企业准则下是研发支出、在小企业准则下是营业外收入，只比编码会把
 *     合法的营业外收入判成违规；
 *  3. 回归：config/mappings/*.yaml 引用的每个科目编码在新科目表里依然存在、
 *     依然能下钻到明细科目——否则整套记账管线会在切换准则的那一刻崩掉。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { AccountingStandardId, StandardProfile } from '../src/core/contracts.ts';
import type { AccountTable } from '../src/core/config.ts';
import { CONFIG_DIR, PROJECT_ROOT, loadAccounts } from '../src/core/config.ts';
import {
  DEFAULT_STANDARD,
  FEATURE_DIFF,
  STANDARD_FEATURE_LABEL,
  STANDARD_IDS,
  StandardConfigError,
  checkAccountAllowed,
  describeFeatureDiff,
  listForbiddenAccounts,
  loadStandardAccounts,
  loadStandardBundle,
  loadStandardRegistry,
  resolveStandardFile,
} from '../src/core/standard/index.ts';

const registry = loadStandardRegistry();
const cas: StandardProfile = registry.get('cas');
const small: StandardProfile = registry.get('small');

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/** 从 config/mappings/*.yaml 里抠出所有被引用的科目编码。 */
function mappingAccountCodes(): string[] {
  const dir = join(CONFIG_DIR, 'mappings');
  const codes = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    // 规则里的 account 可能是 {field.xxx} 占位符，只抓以数字开头的科目编码
    for (const match of text.matchAll(/account:\s*["']?([0-9][0-9.]*)/g)) {
      const code = match[1];
      if (code !== undefined) codes.add(code);
    }
  }
  return [...codes].sort();
}

/** 直接读 YAML 拿原始科目列表（用于「表里到底有没有这个科目」的黑白名单核对）。 */
function rawAccounts(profile: StandardProfile): Array<{ code: string; name: string }> {
  const path = resolveStandardFile(profile, profile.chartFile);
  const doc = parseYaml(readFileSync(path, 'utf8')) as { accounts?: Array<{ code: string; name: string }> };
  return doc.accounts ?? [];
}

/* ------------------------------------------------------------------ */
/* 一、注册表与档案加载                                                */
/* ------------------------------------------------------------------ */

describe('准则注册表', () => {
  it('两套准则都能加载，且档案字段完整', () => {
    assert.deepEqual(registry.ids, ['cas', 'small']);
    assert.equal(registry.all().length, 2);
    assert.equal(registry.has('cas'), true);
    assert.equal(registry.has('small'), true);
    assert.equal(registry.has('ifrs'), false);
    assert.equal(DEFAULT_STANDARD, 'small');

    for (const profile of registry.all()) {
      assert.ok(profile.label.length > 0, `${profile.id} 缺少 label`);
      assert.ok(profile.summary.length > 0, `${profile.id} 缺少 summary`);
      assert.ok(profile.basis.length >= 3, `${profile.id} 的法规依据太少，合规结论会站不住脚`);
      assert.ok(profile.chartFile.endsWith('chart-of-accounts.yaml'));
      assert.ok(profile.requiredClosingAccounts.length >= 2);
      // 每一条依据都必须有 id 与全称，否则报告里没法引用
      for (const basis of profile.basis) {
        assert.ok(basis.id.length > 0);
        assert.ok(basis.title.length > 0);
      }
    }
  });

  it('未知准则 id 抛 StandardConfigError', () => {
    assert.throws(
      () => registry.get('ifrs' as AccountingStandardId),
      (err: unknown) => err instanceof StandardConfigError && /未知会计准则/.test((err as Error).message),
    );
  });

  it('配置文件缺失时抛 StandardConfigError 而不是静默返回空注册表', () => {
    assert.throws(
      () => loadStandardRegistry(join(PROJECT_ROOT, 'config', '__不存在的配置目录__')),
      (err: unknown) => err instanceof StandardConfigError && /不存在/.test((err as Error).message),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 二、12 项特性开关：实质差异                                          */
/* ------------------------------------------------------------------ */

describe('准则特性开关', () => {
  it('六项核心差异：企业会计准则 true，小企业会计准则 false', () => {
    const core: Array<keyof typeof cas.features> = [
      'deferredTax',
      'fairValueMeasurement',
      'assetImpairment',
      'developmentCapitalization',
      'equityMethod',
      'priorPeriodAdjustment',
    ];
    for (const feature of core) {
      assert.equal(cas.features[feature], true, `企业会计准则的 ${feature} 应为 true`);
      assert.equal(small.features[feature], false, `小企业会计准则的 ${feature} 应为 false`);
    }
  });

  it('十二项特性一个不少，且值都是布尔', () => {
    assert.equal(Object.keys(cas.features).length, 12);
    assert.equal(Object.keys(small.features).length, 12);
    for (const key of Object.keys(cas.features) as Array<keyof typeof cas.features>) {
      assert.equal(typeof cas.features[key], 'boolean');
      assert.equal(typeof small.features[key], 'boolean');
    }
    // 现金流量表与附注：两套准则都强制要求（小企业准则第七十八条）
    assert.equal(cas.features.cashFlowStatement, true);
    assert.equal(small.features.cashFlowStatement, true);
    assert.equal(cas.features.notesRequired, true);
    assert.equal(small.features.notesRequired, true);
    // 所有者权益变动表：只有企业会计准则要求
    assert.equal(cas.features.equityStatement, true);
    assert.equal(small.features.equityStatement, false);
    // 租赁资本化：小企业会计准则不确认使用权资产/租赁负债
    assert.equal(cas.features.leaseCapitalization, true);
    assert.equal(small.features.leaseCapitalization, false);
  });

  it('差异对照表覆盖 12 项特性，每项都有中文 label 与两套准则的人话描述', () => {
    const rows = describeFeatureDiff();
    assert.equal(rows.length, 12);
    assert.deepEqual(
      rows.map((row) => row.feature).sort(),
      [...Object.keys(STANDARD_FEATURE_LABEL)].sort(),
    );
    for (const row of rows) {
      assert.ok(row.label.length > 0, `${row.feature} 缺少中文 label`);
      assert.ok(row.cas.length >= 10, `${row.feature} 的企业准则描述太短`);
      assert.ok(row.small.length >= 10, `${row.feature} 的小企业准则描述太短`);
      assert.notEqual(row.cas, row.small, `${row.feature} 两套准则的描述不应完全相同`);
    }
    // 返回的是副本，调用方排序不会污染模块级常量
    const first = describeFeatureDiff();
    first.pop();
    assert.equal(FEATURE_DIFF.length, 12);
    assert.equal(describeFeatureDiff().length, 12);
  });
});

/* ------------------------------------------------------------------ */
/* 三、禁用科目判定                                                    */
/* ------------------------------------------------------------------ */

describe('科目准入判定', () => {
  it('小企业准则下 1811 递延所得税资产被禁用，理由含准则名与「递延所得税」', () => {
    const allowance = checkAccountAllowed(small, '1811');
    assert.equal(allowance.allowed, false);
    assert.ok(allowance.reason !== undefined);
    assert.match(allowance.reason ?? '', /小企业会计准则/);
    assert.match(allowance.reason ?? '', /递延所得税/);
    assert.ok(allowance.basis.length > 0, '禁用结论必须带法规依据');
    assert.ok(
      allowance.basis.some((item) => item.title.includes('小企业会计准则') || item.title.includes('企业所得税法')),
      '依据里应能看到小企业会计准则或企业所得税法',
    );
  });

  it('企业会计准则下 1811 允许使用', () => {
    const allowance = checkAccountAllowed(cas, '1811');
    assert.equal(allowance.allowed, true);
    assert.ok(allowance.basis.length > 0);
  });

  it('禁用按编码前缀生效：1811.01 这类明细科目一并禁用', () => {
    assert.equal(checkAccountAllowed(small, '1811.01').allowed, false);
    assert.equal(checkAccountAllowed(small, '1811.01', '递延所得税资产/可抵扣暂时性差异').allowed, false);
  });

  it('编码重号按名称区分：5301 研发支出禁用，5301 营业外收入放行', () => {
    // 企业会计准则：5301 是研发支出
    assert.equal(checkAccountAllowed(small, '5301', '研发支出').allowed, false);
    // 小企业会计准则：5301 是营业外收入（合法且常用）
    assert.equal(checkAccountAllowed(small, '5301', '营业外收入').allowed, true);
    // 不传名称时用本准则科目表回填名称，仍然是「营业外收入」
    assert.equal(checkAccountAllowed(small, '5301').allowed, true);
  });

  it('企业自建的明细科目按上级科目判定，不误伤合法的重号科目', () => {
    // 小企业可自行增设明细：5301.01 是营业外收入的下级，不是研发支出
    assert.equal(checkAccountAllowed(small, '5301.01').allowed, true);
    // 反过来，1811 属无条件禁用，其明细同样禁用
    assert.equal(checkAccountAllowed(small, '1811.02').allowed, false);
  });

  it('编码重号按名称区分：1101 交易性金融资产禁用，1101 短期投资放行', () => {
    assert.equal(checkAccountAllowed(small, '1101', '交易性金融资产').allowed, false);
    assert.equal(checkAccountAllowed(small, '1101', '短期投资').allowed, true);
    assert.equal(checkAccountAllowed(small, '1101').allowed, true);
  });

  it('1511 持有至到期投资（旧编码）与 1501 长期债券投资按名称区分', () => {
    assert.equal(checkAccountAllowed(small, '1511', '持有至到期投资').allowed, false);
    assert.equal(checkAccountAllowed(small, '1501', '持有至到期投资').allowed, false);
    assert.equal(checkAccountAllowed(small, '1501', '长期债券投资').allowed, true);
    assert.equal(checkAccountAllowed(small, '1511', '长期股权投资').allowed, true);
  });

  it('任一套准则都允许普通科目；空编码直接报错', () => {
    for (const profile of registry.all()) {
      assert.equal(checkAccountAllowed(profile, '6602.05', '水电费').allowed, true);
      assert.equal(checkAccountAllowed(profile, '1002.01', '基本户').allowed, true);
    }
    assert.throws(() => checkAccountAllowed(small, '   '), StandardConfigError);
  });

  it('禁用清单本身是结构化的：每条都有理由与依据', () => {
    const rules = listForbiddenAccounts(small);
    assert.ok(rules.length >= 20, `小企业准则的禁用清单应覆盖主要企业准则专属科目，实际 ${rules.length} 条`);
    for (const rule of rules) {
      assert.ok(rule.reason.length > 0);
      assert.ok(rule.basis.length > 0, `${rule.code} 的禁用结论没有法规依据`);
    }
    assert.equal(listForbiddenAccounts(cas).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 四、两套科目表                                                      */
/* ------------------------------------------------------------------ */

describe('科目表加载', () => {
  const casTable: AccountTable = loadStandardAccounts(cas);
  const smallTable: AccountTable = loadStandardAccounts(small);

  it('两套科目表都能解析成 AccountTable', () => {
    assert.ok(casTable.accounts.length >= 200, `企业会计准则科目表至少 200 个科目，实际 ${casTable.accounts.length}`);
    assert.equal(smallTable.accounts.length, 66, '小企业会计准则附件的一级科目为 66 个');
    assert.equal(casTable.byCode.size, casTable.accounts.length);
    assert.equal(smallTable.byCode.size, smallTable.accounts.length);
  });

  it('isLeaf 行为正确：有下级的不是明细，明细科目可挂分录', () => {
    // 企业会计准则
    assert.equal(casTable.isLeaf('1001'), true);
    assert.equal(casTable.isLeaf('1002'), false);
    assert.equal(casTable.isLeaf('1002.01'), true);
    assert.equal(casTable.isLeaf('1601'), false);
    assert.equal(casTable.isLeaf('6602'), false);
    assert.equal(casTable.isLeaf('6602.05'), true);
    // 小企业会计准则：一级科目即明细，可直接记账
    assert.equal(smallTable.isLeaf('1001'), true);
    assert.equal(smallTable.isLeaf('1002'), true);
    assert.equal(smallTable.isLeaf('5301'), true);
    // 不存在的一律不是明细
    assert.equal(casTable.isLeaf('9999'), false);
  });

  it('defaultChild 下钻链在综合科目表里全部可用', () => {
    assert.equal(casTable.resolve('1002').code, '1002.01');
    assert.equal(casTable.resolve('1221').code, '1221.03');
    assert.equal(casTable.resolve('6001').code, '6001.01');
    assert.equal(casTable.resolve('1002').changed, true);
    assert.equal(casTable.resolve('1002.01').code, '1002.01');
    // 下钻结果必须真的是明细科目，否则凭证挂错科目
    assert.equal(casTable.isLeaf(casTable.resolve('6001').code), true);
  });

  it('小企业科目表里没有禁用清单中的「无条件禁用」科目', () => {
    const unconditional = listForbiddenAccounts(small).filter((rule) => rule.name === undefined);
    const codes = rawAccounts(small).map((account) => account.code);
    for (const rule of unconditional) {
      const hits = codes.filter((code) => code === rule.code || code.startsWith(`${rule.code}.`));
      assert.deepEqual(hits, [], `小企业科目表不应出现禁用科目 ${rule.code}`);
    }
  });

  it('小企业科目表的每个科目都能通过本准则的准入判定（含重号科目）', () => {
    for (const account of rawAccounts(small)) {
      const allowance = checkAccountAllowed(small, account.code, account.name);
      assert.equal(allowance.allowed, true, `${account.code} ${account.name} 被误判为禁用`);
    }
  });

  it('小企业科目表保留了准则附件的关键科目（编码与名称）', () => {
    const expected: Record<string, string> = {
      '1101': '短期投资',
      '1501': '长期债券投资',
      '1511': '长期股权投资',
      '3103': '本年利润',
      '4001': '生产成本',
      '4301': '研发支出',
      '5001': '主营业务收入',
      '5301': '营业外收入',
      '5602': '管理费用',
      '5801': '所得税费用',
    };
    for (const [code, name] of Object.entries(expected)) {
      assert.equal(smallTable.get(code)?.name, name, `小企业准则 ${code} 的名称应为 ${name}`);
    }
  });

  it('企业会计准则科目表包含任务要求的补齐科目', () => {
    const required: Record<string, string> = {
      '1511': '长期股权投资',
      '1521': '投资性房地产',
      '1531': '长期应收款',
      '1605': '工程物资',
      '1703': '无形资产减值准备',
      '2401': '递延收益',
      '2711': '专项应付款',
      '4002': '资本公积',
      '4101': '盈余公积',
      '4103': '本年利润',
      '4104': '利润分配',
      '5001': '生产成本',
      '5101': '制造费用',
      '5201': '劳务成本',
      '5301': '研发支出',
      '6001': '主营业务收入',
      '6051': '其他业务收入',
      '6111': '投资收益',
      '6301': '营业外收入',
      '6401': '主营业务成本',
      '6601': '销售费用',
      '6602': '管理费用',
      '6603': '财务费用',
      '6701': '资产减值损失',
      '6711': '营业外支出',
      '6801': '所得税费用',
      '6901': '以前年度损益调整',
    };
    for (const [code, name] of Object.entries(required)) {
      assert.equal(casTable.get(code)?.name, name, `企业准则 ${code} 的名称应为 ${name}`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 五、回归：记账规则引用的科目不能断                                    */
/* ------------------------------------------------------------------ */

describe('记账规则回归', () => {
  it('mappings 引用的所有科目编码在 cas 科目表里都存在，且能解析到明细科目', () => {
    const codes = mappingAccountCodes();
    assert.ok(codes.length >= 40, `应能从 mappings 抓到足够多的科目编码，实际 ${codes.length}`);
    const casTable = loadStandardAccounts(cas);
    for (const code of codes) {
      const account = casTable.get(code);
      assert.ok(account !== undefined, `mappings 引用的科目 ${code} 在新科目表里不存在`);
      const resolved = casTable.resolve(code);
      assert.equal(resolved.problem, undefined, `科目 ${code} 无法解析：${resolved.problem ?? ''}`);
      assert.equal(casTable.isLeaf(resolved.code), true, `科目 ${code} 解析后不是明细科目`);
    }
  });

  it('mappings 引用的科目编码，其「是否明细」与旧科目表完全一致', () => {
    const oldTable = loadAccounts(CONFIG_DIR);
    const casTable = loadStandardAccounts(cas);
    for (const code of mappingAccountCodes()) {
      assert.equal(
        casTable.isLeaf(code),
        oldTable.isLeaf(code),
        `科目 ${code} 的明细属性发生了变化，会改变凭证下钻行为`,
      );
    }
  });

  it('旧科目表的每个科目编码在新企业准则科目表中都还在（超集）', () => {
    const oldTable = loadAccounts(CONFIG_DIR);
    const casTable = loadStandardAccounts(cas);
    for (const account of oldTable.accounts) {
      const current = casTable.get(account.code);
      assert.ok(current !== undefined, `旧科目 ${account.code} 在新科目表中丢失`);
      assert.equal(current.name, account.name, `旧科目 ${account.code} 的名称被改动`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 六、路径解析与整包自检                                               */
/* ------------------------------------------------------------------ */

describe('路径解析与整包自检', () => {
  it('resolveStandardFile 支持三种写法，并拦住目录穿越', () => {
    const absolute = join(PROJECT_ROOT, 'config', 'standard', 'cas', 'chart-of-accounts.yaml');
    assert.equal(resolveStandardFile(cas, absolute), absolute);
    assert.equal(
      resolveStandardFile(cas, 'config/standard/cas/chart-of-accounts.yaml'),
      absolute,
    );
    assert.equal(
      resolveStandardFile(cas, 'chart-of-accounts.yaml'),
      join(PROJECT_ROOT, 'config', 'standard', 'cas', 'chart-of-accounts.yaml'),
    );
    assert.throws(
      () => resolveStandardFile(cas, '../../../../etc/passwd'),
      (err: unknown) => err instanceof StandardConfigError && /项目目录之外/.test((err as Error).message),
    );
    assert.throws(() => resolveStandardFile(cas, '   '), StandardConfigError);
  });

  it('loadStandardBundle 能加载两套准则，并报告尚未建立的配套文件', () => {
    const casBundle = loadStandardBundle(cas);
    assert.equal(casBundle.chartLoaded, true);
    assert.equal(casBundle.profile.id, 'cas');

    const smallBundle = loadStandardBundle(small);
    assert.equal(smallBundle.chartLoaded, true);
    // 小企业准则必须使用独立规则目录（编码体系不同，不能复用 config/mappings）
    assert.ok(
      smallBundle.warnings.some((warning) => warning.includes('config/standard/small/mappings')),
      `应提示小企业准则规则目录尚未建立，实际警告：${smallBundle.warnings.join(' | ')}`,
    );
    // 科目表与禁用清单不得自相矛盾（否则 loadStandardBundle 会抛错）
    assert.ok(smallBundle.warnings.every((warning) => typeof warning === 'string'));
  });

  it('requiredClosingAccounts 在各自科目表里真实存在', () => {
    for (const profile of registry.all()) {
      const table = loadStandardAccounts(profile);
      for (const code of profile.requiredClosingAccounts) {
        assert.ok(table.get(code) !== undefined, `${profile.id} 的结转科目 ${code} 不存在`);
      }
    }
    assert.deepEqual(cas.requiredClosingAccounts, ['4103', '4104']);
    assert.deepEqual(small.requiredClosingAccounts, ['3103', '3104']);
  });

  it('配置写错时抛 StandardConfigError（特性缺失 / 特性名拼错）', (t) => {
    let dir: string;
    try {
      dir = mkdtempSync(join(PROJECT_ROOT, '.test-tmp-standard-'));
    } catch {
      t.skip('沙盒环境不允许创建临时目录，跳过配置错误用例');
      return;
    }
    try {
      const standardDir = join(dir, 'standard');
      mkdirSync(standardDir, { recursive: true });

      const base = {
        id: 'small',
        label: '小企业会计准则',
        summary: '测试用最小档案',
        basis: [{ id: 'b1', title: '小企业会计准则' }],
        chartFile: 'config/standard/small/chart-of-accounts.yaml',
        mappingDir: 'config/mappings',
        statementFile: 'config/report/statements-small.yaml',
        requiredClosingAccounts: ['3103'],
      };
      const features = Object.fromEntries(
        Object.keys(STANDARD_FEATURE_LABEL).map((key) => [key, false]),
      );

      const writeStandards = (standard: unknown): void => {
        writeFileSync(
          join(standardDir, 'standards.yaml'),
          JSON.stringify({ standards: [standard] }, null, 2),
          'utf8',
        );
      };

      // 特性拼错：必须报错，绝不静默按默认值处理
      writeStandards({
        ...base,
        features: { ...features, leasingCapitalization: true },
        forbiddenAccounts: [],
      });
      assert.throws(
        () => loadStandardRegistry(dir),
        (err: unknown) =>
          err instanceof StandardConfigError && /未知特性/.test((err as Error).message),
      );

      // 特性缺失：同样必须报错
      const partial = { ...features } as Record<string, boolean>;
      delete partial['deferredTax'];
      writeStandards({ ...base, features: partial, forbiddenAccounts: [] });
      assert.throws(
        () => loadStandardRegistry(dir),
        (err: unknown) =>
          err instanceof StandardConfigError && /deferredTax/.test((err as Error).message),
      );

      // 禁用科目编码重复：会让「哪条理由生效」不可预测，必须报错
      writeStandards({ ...base, features, forbiddenAccounts: ['1811', '1811'] });
      assert.throws(
        () => loadStandardRegistry(dir),
        (err: unknown) =>
          err instanceof StandardConfigError && /重复/.test((err as Error).message),
      );

      // 依据引用不存在：forbiddenAccounts 的 basisRefs 必须能在 basis 里找到
      writeStandards({
        ...base,
        features,
        forbiddenAccounts: [{ code: '1811', basisRefs: ['not-exist'] }],
      });
      assert.throws(
        () => loadStandardRegistry(dir),
        (err: unknown) =>
          err instanceof StandardConfigError && /basisRefs/.test((err as Error).message),
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        t.skip('沙盒环境不允许写临时文件，跳过配置错误用例');
        return;
      }
      throw err;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('配置目录可用时，standards.yaml 与两份科目表都能定位到', () => {
    assert.ok(existsSync(join(CONFIG_DIR, 'standard', 'standards.yaml')));
    for (const profile of registry.all()) {
      assert.ok(existsSync(resolveStandardFile(profile, profile.chartFile)));
    }
    assert.equal(STANDARD_IDS.length, 2);
  });
});
