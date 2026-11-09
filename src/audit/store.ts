/**
 * 审计库：版本表（History Table）+ 审计事件流（Append-only Event Log）。
 *
 * 为什么不用数据库：
 *   这套系统要能在客户财务的普通办公电脑上跑起来，装不了 SQL Server/MySQL。
 *   JSONL 是「一行一条记录」的纯文本：可以用记事本打开、可以用 Excel 打开、
 *   可以拷进 U 盘归档，出问题时人工也能核对。代价是要自己保证原子性与顺序。
 *
 * 为什么是「只追加」：
 *   《会计法》第九条、第十四条要求会计资料真实完整；《会计档案管理办法》
 *   （财政部 国家档案局令第79号）第十四条要求会计凭证、账簿保存 30 年。
 *   只要代码里存在一条「原地覆盖」的路径，就等于给篡改留了后门——
 *   而且事后无法证明「这份数据没被改过」。因此本模块的所有写入都是：
 *   以 'a' 模式打开文件 → 写一整行 JSON → fsync → 关闭。
 *   没有任何 unlink / 截断 / 覆盖写的代码路径（tests/audit.store.test.ts 会做源码级断言）。
 *
 * 为什么版本号存在但 validTo 不在落盘行里固化：
 *   「更新时把旧版本的 validTo 置为当前时间」本质上是修改一条历史记录，与只追加冲突。
 *   本实现把 validTo 定义为「下一条版本的 validFrom」，读取时物化（materialize）。
 *   这样落盘的每一行永远不变，而对外看到的 VersionRecord 依然带完整的生效区间，
 *   getAt 时点查询、diff 版本对比都不受影响。
 *
 * 为什么软删除也要追加一个新版本：
 *   软删除 = 「在第 N 版之后，声明第 N+1 版是已删除状态」。这样删除动作本身也进了历史，
 *   恢复（restore）再追加第 N+2 版。任何时刻都能回答「谁在什么时候删了它、理由是什么」。
 *
 * 为什么同一 dataDir 只建议单进程写入：
 *   哈希链要求「上一条的 hash」必须是最新的。两个进程同时追加会读到同一个 prevHash，
 *   产生分叉，链条立刻断裂。JSONL 的单行追加在操作系统层面是原子的（不会写坏），
 *   但顺序与哈希链需要串行化。生产部署请让 CLI / Web 共用一个进程内的 AuditStore 实例；
 *   本模块的读缓存会按文件大小自动失效，所以「先关再开」的多实例顺序使用是安全的。
 *
 * 损坏处理策略（重要，经过权衡）：
 *   审计库可能因为宕机被截断，也可能被人手工篡改。读取时一律「跳过无法解析的行、绝不修改它」，
 *   理由有三：
 *     ① 残缺的字节本身也是证据，抹掉就再也说不清当时发生了什么；
 *     ② 哈希链能发现「少了一条」（seq 断档）与「改了一条」（hash 不符），
 *        跳过损坏行不会让篡改蒙混过关；
 *     ③ 一次掉电就让整个系统打不开，对小企业是灾难，会计反而无法继续做账。
 *   所以：日常读写照常进行；verifyIntegrity() 把每一处损坏列进 orphans 并返回 ok=false；
 *   assertStorageHealthy() 在生成报表 / 纳税申报草稿 / 对外报告之前强制拦截——
 *   在损坏的账套上算出来的数字，签了字也是错的。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type {
  AuditEvent,
  EntityKind,
  IsoDateTime,
  LawBasis,
  Period,
  SoftDeleteRequest,
  VersionRecord,
  Voucher,
} from '../core/contracts.ts';
import { CONFIG_DIR } from '../core/config.ts';
import { isValidPeriod, periodOf } from '../core/datetime.ts';
import { ZERO_HASH, canonicalJson, computeEventHash } from './hash.ts';
import {
  PeriodCloseError,
  PeriodLockedError,
  closePeriod as closePeriodIn,
  isPeriodLocked as isPeriodLockedIn,
  reopenPeriod as reopenPeriodIn,
} from './period-close.ts';
import type {
  CloseValidator,
  PeriodCloseOutcome,
  PeriodCloseRecord,
  PeriodCloseStore,
  PeriodStateWrite,
  ReopenReport,
} from './period-close.ts';
import { VERSION_MUTATION_ACTIONS, verifyIntegrityOf } from './verify.ts';
import type { IntegrityReport } from './verify.ts';

/* ================================================================== */
/* 一、实体类型与常量                                                  */
/* ================================================================== */

/**
 * 受版本控制的实体类型（运行时列表）。
 *
 * 类型定义在 core/contracts.ts（EntityKind），这里只是它的运行时镜像，
 * 用于校验来自 JS / 配置文件 / HTTP 入参的字符串。
 */
export const ENTITY_KINDS: readonly EntityKind[] = [
  'voucher',
  'voucher_line',
  'document',
  'account',
  'tax_return',
  'statement',
  'policy',
  'settings',
  'user',
  'period_close',
];

const ENTITY_KIND_SET: ReadonlySet<string> = new Set<string>(ENTITY_KINDS);

/** 事件文件名（所有实体共用一条链，保证全局顺序）。 */
export const AUDIT_EVENTS_FILE = 'audit.events.jsonl';

/** 机器身份：以这个身份发起的结账会被拒绝（AI 不得代替人签署）。 */
export const SYSTEM_ACTOR = '系统';

/** 版本表文件名：<entity>.versions.jsonl */
export function versionFileName(entity: EntityKind): string {
  return `${entity}.versions.jsonl`;
}

/* ================================================================== */
/* 二、配置                                                            */
/* ================================================================== */

export interface AuditStorageConfig {
  /** 审计库根目录（相对路径以项目根为基准；实际使用哪个目录由 AuditStoreOptions.dataDir 决定） */
  dataDir: string;
  /** 哈希算法，固定 sha256：换算法会让已有链条无法校验 */
  hashAlgorithm: 'sha256';
  /** 每次追加后是否 fsync。生产必须为 true */
  fsync: boolean;
}

export interface AuditRetentionConfig {
  /** 会计档案最低保存年限 */
  years: number;
  /** 保存年限的法规依据，随配置一起展示 */
  basis: LawBasis[];
}

export interface AuditLockConfig {
  /** 是否启用期间锁账。仅数据迁移时可临时关闭，生产必须为 true */
  enabled: boolean;
  /**
   * 结账是否必须由人工签署。
   *
   * 打开时，以「系统」身份结账会被拒绝：AI 只能生成结账建议与草稿，
   * 让机器代替人签署结账，等于把《会计法》要求的会计责任主体架空了。
   * （反结账必须填写理由是代码里的硬约束，不提供关闭开关。）
   */
  requireHumanSignature: boolean;
  /** 结账前必须清零的兜底科目编码 */
  suspenseAccounts: string[];
}

export interface AuditEntitiesConfig {
  /** 必须纳入版本管理的实体 */
  tracked: EntityKind[];
  /** 更新这些实体时必须填写变更摘要，否则拒绝写入 */
  requireSummary: EntityKind[];
}

export interface AuditConfig {
  version: number;
  storage: AuditStorageConfig;
  retention: AuditRetentionConfig;
  lock: AuditLockConfig;
  entities: AuditEntitiesConfig;
}

const LAW_LEVELS: ReadonlySet<string> = new Set([
  'law',
  'administrative-regulation',
  'departmental-rule',
  'normative-document',
  'standard',
]);

/** 缺省配置：与 config/audit.yaml 保持一致，配置文件缺失时退回这里。 */
export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  version: 1,
  storage: { dataDir: 'data/audit', hashAlgorithm: 'sha256', fsync: true },
  retention: {
    years: 30,
    basis: [
      {
        id: 'accounting-archives-79',
        title: '会计档案管理办法',
        article: '第十四条',
        excerpt: '会计凭证、会计账簿等会计档案的保管期限为 30 年',
        level: 'departmental-rule',
      },
      {
        id: 'accounting-law',
        title: '中华人民共和国会计法',
        article: '第九条',
        excerpt: '各单位必须根据实际发生的经济业务事项进行会计核算，不得以虚假的经济业务事项或者资料进行会计核算',
        level: 'law',
      },
    ],
  },
  lock: {
    enabled: true,
    requireHumanSignature: true,
    suspenseAccounts: ['1901'],
  },
  entities: {
    tracked: [...ENTITY_KINDS],
    requireSummary: ['tax_return', 'statement'],
  },
};

/**
 * 读取 config/audit.yaml。
 *
 * 严格校验未知字段：配置写错（比如把 suspenseAccounts 拼成 suspenseAccount）时，
 * 如果静默忽略，兜底科目检查就会悄悄失效，结账时把未查明的差错带进报表。
 * 这类错误必须当场报出来。
 */
export function loadAuditConfig(configDir: string = CONFIG_DIR): AuditConfig {
  const defaults = cloneJson(DEFAULT_AUDIT_CONFIG);
  const path = join(configDir, 'audit.yaml');
  if (!existsSync(path)) return defaults;

  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new AuditValidationError(`audit.yaml 解析失败：${(error as Error).message}`);
  }
  if (doc === null || doc === undefined) return defaults;
  if (!isRecord(doc)) throw new AuditValidationError('audit.yaml 顶层必须是对象');

  assertKnownKeys(doc, ['version', 'storage', 'retention', 'lock', 'entities'], 'audit.yaml');

  if (doc['version'] !== undefined) {
    defaults.version = requireNumber(doc['version'], 'audit.yaml version');
  }

  const storage = doc['storage'];
  if (storage !== undefined) {
    if (!isRecord(storage)) throw new AuditValidationError('audit.yaml storage 必须是对象');
    assertKnownKeys(storage, ['dataDir', 'hashAlgorithm', 'fsync'], 'audit.yaml storage');
    const dataDir = optionalString(storage['dataDir']);
    if (dataDir !== undefined) defaults.storage.dataDir = dataDir;
    const algorithm = optionalString(storage['hashAlgorithm']);
    if (algorithm !== undefined) {
      if (algorithm !== 'sha256') {
        throw new AuditValidationError(
          `audit.yaml storage.hashAlgorithm 只能是 sha256（更换算法会使已有哈希链无法校验），实际为「${algorithm}」`,
        );
      }
      defaults.storage.hashAlgorithm = 'sha256';
    }
    if (storage['fsync'] !== undefined) defaults.storage.fsync = Boolean(storage['fsync']);
  }

  const retention = doc['retention'];
  if (retention !== undefined) {
    if (!isRecord(retention)) throw new AuditValidationError('audit.yaml retention 必须是对象');
    assertKnownKeys(retention, ['years', 'basis'], 'audit.yaml retention');
    if (retention['years'] !== undefined) {
      const years = requireNumber(retention['years'], 'audit.yaml retention.years');
      if (years < 1) throw new AuditValidationError('audit.yaml retention.years 必须 ≥ 1');
      defaults.retention.years = years;
    }
    const basis = parseLawBasisList(retention['basis'], 'audit.yaml retention.basis');
    if (basis !== undefined) defaults.retention.basis = basis;
  }

  const lock = doc['lock'];
  if (lock !== undefined) {
    if (!isRecord(lock)) throw new AuditValidationError('audit.yaml lock 必须是对象');
    assertKnownKeys(
      lock,
      ['enabled', 'requireHumanSignature', 'suspenseAccounts'],
      'audit.yaml lock',
    );
    if (lock['enabled'] !== undefined) defaults.lock.enabled = Boolean(lock['enabled']);
    if (lock['requireHumanSignature'] !== undefined) {
      defaults.lock.requireHumanSignature = Boolean(lock['requireHumanSignature']);
    }
    const accounts = optionalStringArray(lock['suspenseAccounts'], 'audit.yaml lock.suspenseAccounts');
    if (accounts !== undefined) defaults.lock.suspenseAccounts = accounts;
  }

  const entities = doc['entities'];
  if (entities !== undefined) {
    if (!isRecord(entities)) throw new AuditValidationError('audit.yaml entities 必须是对象');
    assertKnownKeys(entities, ['tracked', 'requireSummary'], 'audit.yaml entities');
    const tracked = optionalStringArray(entities['tracked'], 'audit.yaml entities.tracked');
    if (tracked !== undefined) {
      defaults.entities.tracked = tracked.map((item) => toEntityKind(item, 'audit.yaml entities.tracked'));
    }
    const requireSummary = optionalStringArray(
      entities['requireSummary'],
      'audit.yaml entities.requireSummary',
    );
    if (requireSummary !== undefined) {
      defaults.entities.requireSummary = requireSummary.map((item) =>
        toEntityKind(item, 'audit.yaml entities.requireSummary'),
      );
    }
  }

  return defaults;
}

/* ================================================================== */
/* 三、错误类型                                                        */
/* ================================================================== */

/** 入参不合法（空 id、空数据、未知实体等）。 */
export class AuditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditValidationError';
  }
}

/** 实体不存在。 */
export class EntityNotFoundError extends Error {
  readonly entity: EntityKind;
  readonly entityId: string;

  constructor(entity: EntityKind, entityId: string) {
    super(`审计库中不存在实体 ${entity}/${entityId}`);
    this.name = 'EntityNotFoundError';
    this.entity = entity;
    this.entityId = entityId;
  }
}

/** 实体已被软删除：必须先 restore 才能继续写入，禁止直接覆盖。 */
export class EntitySoftDeletedError extends Error {
  readonly entity: EntityKind;
  readonly entityId: string;
  readonly deletedReason: string | undefined;

  constructor(entity: EntityKind, entityId: string, version: number, reason?: string) {
    super(
      `${entity}/${entityId} 已被软删除（当前版本 v${version}，原因：${reason ?? '未填写'}）。` +
        '已删除的数据不允许直接覆盖，请先调用 restore() 恢复并留下恢复痕迹',
    );
    this.name = 'EntitySoftDeletedError';
    this.entity = entity;
    this.entityId = entityId;
    this.deletedReason = reason;
  }
}

/** 乐观并发冲突：调用方拿的版本号已经不是最新版本。 */
export class VersionConflictError extends Error {
  readonly entity: EntityKind;
  readonly entityId: string;
  readonly expected: number | null;
  readonly actual: number | null;

  constructor(entity: EntityKind, entityId: string, expected: number | null, actual: number | null) {
    super(
      `并发冲突：${entity}/${entityId} 期望版本 ${expected === null ? '（新建）' : `v${expected}`}，` +
        `实际为 ${actual === null ? '（不存在）' : `v${actual}`}。` +
        '请重新读取最新版本后再提交——系统不会静默覆盖他人已保存的修改',
    );
    this.name = 'VersionConflictError';
    this.entity = entity;
    this.entityId = entityId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** 指定版本不存在。 */
export class VersionNotFoundError extends Error {
  readonly entity: EntityKind;
  readonly entityId: string;
  readonly version: number;

  constructor(entity: EntityKind, entityId: string, version: number) {
    super(`${entity}/${entityId} 不存在版本 v${version}`);
    this.name = 'VersionNotFoundError';
    this.entity = entity;
    this.entityId = entityId;
    this.version = version;
  }
}

/** 日志文件损坏：审计库拒绝在损坏的日志上继续追加。 */
export class AuditLogCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditLogCorruptError';
  }
}

/* ================================================================== */
/* 四、公共类型                                                        */
/* ================================================================== */

export interface AuditStoreOptions {
  /** 审计库目录，不存在会自动创建（mkdirSync recursive） */
  dataDir: string;
  /** 默认操作人；未显式传 actor 时使用 */
  actor?: string;
  /** 配置目录（默认项目 config/），用于读取 audit.yaml */
  configDir?: string;
}

export interface SaveOptions {
  /** 操作人 */
  actor?: string;
  /** 变更摘要，写进版本记录与审计事件 */
  summary?: string;
}

/** 字段级差异（diff 的返回值）。 */
export interface FieldDiff {
  /** 字段路径，嵌套用点号、数组用下标，如 lines[0].debit */
  field: string;
  before: unknown;
  after: unknown;
  kind: 'added' | 'removed' | 'changed';
}

/** 事件查询过滤条件。 */
export interface AuditEventFilter {
  entity?: EntityKind;
  entityId?: string;
  from?: IsoDateTime;
  to?: IsoDateTime;
  actor?: string;
}

/* ================================================================== */
/* 五、内部结构                                                        */
/* ================================================================== */

interface ReadProblem {
  line: number;
  message: string;
  /** 末行且文件没有以换行结尾：视为宕机造成的截断，读取时跳过，校验时报告 */
  tornTail: boolean;
}

interface VersionCacheEntry {
  size: number;
  records: VersionRecord[];
  index: Map<string, VersionRecord[]>;
  problems: ReadProblem[];
}

interface EventCacheEntry {
  size: number;
  events: AuditEvent[];
  problems: ReadProblem[];
}

interface AppendResult {
  bytes: number;
  sizeBefore: number;
}

/* ================================================================== */
/* 六、审计库                                                          */
/* ================================================================== */

export class AuditStore implements PeriodCloseStore {
  /** 审计库根目录（绝对路径） */
  readonly dataDir: string;
  /** 未显式指定 actor 时使用的默认操作人 */
  readonly defaultActor: string;
  /** 生效的审计配置 */
  readonly config: AuditConfig;

  private readonly eventsPath: string;
  private readonly fsyncEnabled: boolean;
  private readonly versionCache = new Map<EntityKind, VersionCacheEntry>();
  private eventCache: EventCacheEntry | null = null;
  private lastStampMs = 0;
  private closeValidator: CloseValidator | null = null;
  private lastReport: IntegrityReport | null = null;

  constructor(options: AuditStoreOptions) {
    if (options === null || typeof options !== 'object') {
      throw new AuditValidationError('AuditStore 需要一个配置对象，至少包含 dataDir');
    }
    const rawDir = typeof options.dataDir === 'string' ? options.dataDir.trim() : '';
    if (rawDir === '') {
      throw new AuditValidationError('AuditStore 的 dataDir 不能为空：审计库必须有独立的落盘目录');
    }

    this.dataDir = resolve(rawDir);
    try {
      mkdirSync(this.dataDir, { recursive: true });
    } catch (error) {
      throw new AuditValidationError(
        `无法创建审计库目录 ${this.dataDir}：${(error as Error).message}`,
      );
    }

    this.eventsPath = join(this.dataDir, AUDIT_EVENTS_FILE);
    this.config = loadAuditConfig(options.configDir ?? CONFIG_DIR);
    this.fsyncEnabled = this.config.storage.fsync;

    const actor = typeof options.actor === 'string' ? options.actor.trim() : '';
    this.defaultActor = actor === '' ? SYSTEM_ACTOR : actor;

    // 重启后时间戳必须继续单调：否则时钟回拨会让新版本的 validFrom 早于旧版本，
    // getAt 时点查询就会给出错误的「当时生效版本」。
    const events = this.readEvents();
    const last = events.events[events.events.length - 1];
    if (last !== undefined) {
      const stamp = toEpoch(last.at);
      if (Number.isFinite(stamp)) this.lastStampMs = Math.max(this.lastStampMs, stamp);
    }
  }

  /* ------------------------------ 写入 ------------------------------ */

  /**
   * 保存实体快照（新建或更新）。
   *
   * 更新不会修改任何一行历史记录：它追加一条新版本，旧版本的 validTo 由读取时推导。
   */
  save(entity: EntityKind, id: string, data: unknown, opts: SaveOptions = {}): VersionRecord {
    return this.persist(entity, id, data, undefined, opts);
  }

  /**
   * 带版本号的保存（乐观并发）。
   *
   * expectedVersion 为 null 表示「我期望这是新建」。调用方拿到的版本号过期时抛
   * VersionConflictError，避免两个人的修改互相覆盖——会计数据上的静默覆盖是最难查的错。
   */
  saveVersioned(
    entity: EntityKind,
    id: string,
    data: unknown,
    expectedVersion: number | null,
    opts: SaveOptions = {},
  ): VersionRecord {
    return this.persist(entity, id, data, expectedVersion, opts);
  }

  /**
   * 软删除：追加一条 deleted=true 的新版本，历史数据完整保留。
   *
   * 不提供物理删除，也没有任何 unlink / 截断路径。
   */
  softDelete(req: SoftDeleteRequest): VersionRecord {
    if (req === null || typeof req !== 'object') {
      throw new AuditValidationError('softDelete 需要一个 SoftDeleteRequest 对象');
    }
    assertEntityKind(req.entity);
    assertEntityId(req.entityId);

    const actor = this.resolveActor(req.actor);
    const reason = normalizeReason(req.reason, '软删除必须填写原因：删除账务数据是审计重点，没有理由的删除记录事后无法解释');
    const expectedVersion = typeof req.version === 'number' ? req.version : null;

    const entry = this.readVersions(req.entity);
    const existing = entry.index.get(req.entityId) ?? [];
    const current = existing[existing.length - 1];
    if (current === undefined) {
      throw new EntityNotFoundError(req.entity, req.entityId);
    }
    if (current.deleted) {
      throw new EntitySoftDeletedError(req.entity, req.entityId, current.version, current.deletedReason);
    }
    if (expectedVersion !== current.version) {
      throw new VersionConflictError(req.entity, req.entityId, expectedVersion, current.version);
    }
    this.assertNotLocked(req.entity, req.entityId, current.data, current.data);

    const now = this.clockNow();
    const version = current.version + 1;
    const snapshot = cloneJson(current.data);
    const record: VersionRecord = {
      versionId: versionIdOf(req.entity, req.entityId, version),
      entity: req.entity,
      entityId: req.entityId,
      version,
      data: snapshot,
      validFrom: now,
      validTo: null,
      deleted: true,
      deletedAt: now,
      deletedBy: actor,
      deletedReason: reason,
      createdBy: actor,
      createdAt: now,
      changeSummary: `软删除：${reason}`,
    };

    this.appendVersion(req.entity, record);
    this.appendEvent({
      actor,
      action: 'soft_delete',
      entity: req.entity,
      entityId: req.entityId,
      before: cloneJson(current.data),
      after: cloneJson(snapshot),
      reason,
    });
    return this.materializeOne(record, null);
  }

  /**
   * 恢复被软删除的实体：追加一条 deleted=false 的新版本。
   *
   * 恢复不是「撤销删除」，而是在历史上再记一笔「某人以某理由恢复」。
   */
  restore(entity: EntityKind, id: string, actor: string, reason: string): VersionRecord {
    assertEntityKind(entity);
    assertEntityId(id);
    const actorName = this.resolveActor(actor);
    const why = normalizeReason(reason, '恢复必须填写理由：恢复已删除的账务数据同样需要说明依据');

    const entry = this.readVersions(entity);
    const existing = entry.index.get(id) ?? [];
    const current = existing[existing.length - 1];
    if (current === undefined) {
      throw new EntityNotFoundError(entity, id);
    }
    if (!current.deleted) {
      throw new AuditValidationError(
        `${entity}/${id} 当前未被软删除（v${current.version}），无需恢复`,
      );
    }
    this.assertNotLocked(entity, id, current.data, current.data);

    const now = this.clockNow();
    const version = current.version + 1;
    const snapshot = cloneJson(current.data);
    const record: VersionRecord = {
      versionId: versionIdOf(entity, id, version),
      entity,
      entityId: id,
      version,
      data: snapshot,
      validFrom: now,
      validTo: null,
      deleted: false,
      createdBy: actorName,
      createdAt: now,
      changeSummary: `恢复：${why}`,
    };

    this.appendVersion(entity, record);
    this.appendEvent({
      actor: actorName,
      action: 'restore',
      entity,
      entityId: id,
      before: cloneJson(current.data),
      after: cloneJson(snapshot),
      reason: why,
    });
    return this.materializeOne(record, null);
  }

  /* ------------------------------ 读取 ------------------------------ */

  /** 当前数据；实体不存在或已软删除时返回 null。 */
  current<T = unknown>(entity: EntityKind, id: string): T | null {
    const record = this.currentRecord(entity, id);
    if (record === null || record.deleted) return null;
    return record.data as T;
  }

  /** 时点查询：返回 at 时刻生效的数据；该时刻无版本或当时已删除时返回 null。 */
  getAt<T = unknown>(entity: EntityKind, id: string, at: IsoDateTime): T | null {
    const record = this.versionAt(entity, id, at);
    if (record === null || record.deleted) return null;
    return record.data as T;
  }

  /**
   * 时点查询（版本记录版）：即使当时该实体处于软删除状态也返回记录。
   * 审计追溯时需要的正是「那时候到底是什么状态」，所以这里不做 deleted 过滤。
   */
  versionAt(entity: EntityKind, id: string, at: IsoDateTime): VersionRecord | null {
    assertEntityKind(entity);
    assertEntityId(id);
    const target = parseInstant(at, 'getAt 的时点');
    const list = this.history(entity, id);

    let best: VersionRecord | null = null;
    let bestStamp = Number.NEGATIVE_INFINITY;
    for (const record of list) {
      const stamp = toEpoch(record.validFrom);
      if (!Number.isFinite(stamp)) continue;
      if (stamp <= target && stamp >= bestStamp) {
        best = record;
        bestStamp = stamp;
      }
    }
    return best;
  }

  /** 当前版本记录（含 deleted 状态），不存在返回 null。 */
  currentRecord(entity: EntityKind, id: string): VersionRecord | null {
    const list = this.history(entity, id);
    const last = list[list.length - 1];
    return last ?? null;
  }

  /** 指定版本号的版本记录。 */
  version(entity: EntityKind, id: string, version: number): VersionRecord | null {
    const list = this.history(entity, id);
    return list.find((record) => record.version === version) ?? null;
  }

  /** 全版本，按 version 升序；validTo 已按「下一条版本的 validFrom」物化。 */
  history(entity: EntityKind, id: string): VersionRecord[] {
    assertEntityKind(entity);
    assertEntityId(id);
    const entry = this.readVersions(entity);
    const list = entry.index.get(id);
    if (list === undefined) return [];
    return materialize(list);
  }

  /** 实体 id 列表（默认排除已软删除的）。 */
  list(entity: EntityKind, opts: { includeDeleted?: boolean } = {}): string[] {
    assertEntityKind(entity);
    const entry = this.readVersions(entity);
    const includeDeleted = opts.includeDeleted === true;
    const ids: string[] = [];
    for (const [id, records] of entry.index) {
      const last = records[records.length - 1];
      if (last === undefined) continue;
      if (last.deleted && !includeDeleted) continue;
      ids.push(id);
    }
    return ids.sort(compareText);
  }

  /** 实体数量（默认排除已软删除的）。 */
  count(entity: EntityKind, opts: { includeDeleted?: boolean } = {}): number {
    return this.list(entity, opts).length;
  }

  /**
   * 字段级差异：回答「谁改了哪一笔、改了哪个字段」。
   *
   * 对象按键名递归、数组按下标递归，所以凭证第 2 行金额变化会定位到 lines[1].debit，
   * 而不是笼统地报「lines 变了」。
   */
  diff(entity: EntityKind, id: string, v1: number, v2: number): FieldDiff[] {
    const list = this.history(entity, id);
    const before = list.find((record) => record.version === v1);
    const after = list.find((record) => record.version === v2);
    if (before === undefined) throw new VersionNotFoundError(entity, id, v1);
    if (after === undefined) throw new VersionNotFoundError(entity, id, v2);
    return diffJson(before.data, after.data);
  }

  /** 审计事件查询（按 seq 升序，时间区间为闭区间）。 */
  events(filter: AuditEventFilter = {}): AuditEvent[] {
    const all = this.loadEvents();
    const from = filter.from === undefined ? null : parseInstant(filter.from, 'events 过滤的 from');
    const to = filter.to === undefined ? null : parseInstant(filter.to, 'events 过滤的 to');
    const result: AuditEvent[] = [];
    for (const event of all) {
      if (filter.entity !== undefined && event.entity !== filter.entity) continue;
      if (filter.entityId !== undefined && event.entityId !== filter.entityId) continue;
      if (filter.actor !== undefined && event.actor !== filter.actor) continue;
      if (from !== null || to !== null) {
        const stamp = toEpoch(event.at);
        if (!Number.isFinite(stamp)) continue;
        if (from !== null && stamp < from) continue;
        if (to !== null && stamp > to) continue;
      }
      result.push({ ...event, before: cloneJson(event.before), after: cloneJson(event.after) });
    }
    return result;
  }

  /**
   * 追加一条「只进事件流、不产生版本记录」的审计事件。
   *
   * 适用场景：登录、导出报表、人工签署、审批、配置变更。这些动作不改变账务数据本身，
   * 但同样是审计必须回答的问题——「谁在什么时候把报表导出去了」「谁签的字」。
   *
   * 变更类动作（create / update / soft_delete / restore / close_period / reopen_period）
   * 必须走 save / softDelete / restore / closePeriod，因为它们必须同时写一条版本记录。
   * 用这个方法写变更事件会让版本表与事件流对不上，完整性校验会立刻报错，所以这里直接拒绝。
   */
  recordEvent(input: {
    action: AuditEvent['action'];
    entity: EntityKind;
    entityId: string;
    actor?: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
  }): AuditEvent {
    if (input === null || typeof input !== 'object') {
      throw new AuditValidationError('recordEvent 需要一个事件对象');
    }
    if (VERSION_MUTATION_ACTIONS.has(input.action)) {
      throw new AuditValidationError(
        `动作「${input.action}」会改变账务数据，必须通过 save / softDelete / restore / closePeriod 写入：` +
          '这些方法会同时追加版本记录，只写事件会让版本表与事件流对不上',
      );
    }
    assertEntityKind(input.entity);
    assertEntityId(input.entityId);
    const actor = this.resolveActor(input.actor);
    return this.appendEvent({
      actor,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      before: input.before === undefined ? null : cloneJson(input.before),
      after: input.after === undefined ? null : cloneJson(input.after),
      reason: normalizeSummary(input.reason),
    });
  }

  /** 全部实体的全部版本记录（用于完整性校验与归档导出）。 */
  allVersionRecords(force = false): VersionRecord[] {
    const all: VersionRecord[] = [];
    for (const entity of ENTITY_KINDS) {
      const entry = this.readVersions(entity, force);
      all.push(...entry.records);
    }
    return all;
  }

  /* --------------------------- 完整性校验 --------------------------- */

  /**
   * 完整性校验：重算哈希链 + 检查版本表断档/孤立。
   *
   * 每次调用都强制从磁盘重读，绕过读缓存——否则「有人手工改了文件再校验」
   * 会拿到缓存里的旧数据，校验就变成了自欺欺人。
   */
  verifyIntegrity(): IntegrityReport {
    const eventEntry = this.readEvents(true);
    const problems: string[] = [];
    for (const item of eventEntry.problems) {
      problems.push(`${AUDIT_EVENTS_FILE} 第 ${item.line} 行：${item.message}`);
    }

    const versions: VersionRecord[] = [];
    for (const entity of ENTITY_KINDS) {
      const entry = this.readVersions(entity, true);
      versions.push(...entry.records);
      for (const item of entry.problems) {
        problems.push(`${versionFileName(entity)} 第 ${item.line} 行：${item.message}`);
      }
    }

    const report = verifyIntegrityOf({
      events: eventEntry.events,
      versions,
      problems,
      checkedAt: this.plainNow(),
    });
    this.lastReport = report;
    return report;
  }

  /** 最近一次完整性校验结果（未校验过为 null）。 */
  lastIntegrityReport(): IntegrityReport | null {
    return this.lastReport;
  }

  /* ---------------------------- 期间锁账 ---------------------------- */

  /**
   * 结账（对外签名保持 void，明细见 closePeriodDetailed）。
   *
   * 结账前会跑：凭证借贷平衡、兜底科目清零、以及注入的校验器（审核引擎等）。
   */
  closePeriod(period: Period, actor: string, note?: string): void {
    this.closePeriodDetailed(period, actor, note);
  }

  /** 结账并返回完整结果（凭证数、检查项、写入的版本与事件）。 */
  closePeriodDetailed(period: Period, actor: string, note?: string): PeriodCloseOutcome {
    if (this.config.lock.requireHumanSignature) {
      const requested = typeof actor === 'string' ? actor.trim() : '';
      const effective = requested === '' ? this.defaultActor : requested;
      if (effective === SYSTEM_ACTOR) {
        throw new PeriodCloseError(
          'invalid_actor',
          '结账必须由人工签署：AI 只能生成结账建议与草稿，不能以「系统」身份代替会计人员签署结账',
        );
      }
    }
    return closePeriodIn(this, period, actor, {
      note,
      validators: this.closeValidator === null ? [] : [this.closeValidator],
      suspenseAccounts: this.config.lock.suspenseAccounts,
    });
  }

  /** 反结账（对外签名保持 void，明细见 reopenPeriodDetailed）。 */
  reopenPeriod(period: Period, actor: string, reason: string): void {
    this.reopenPeriodDetailed(period, actor, reason);
  }

  /** 反结账并返回被解锁的凭证清单。 */
  reopenPeriodDetailed(period: Period, actor: string, reason: string): ReopenReport {
    return reopenPeriodIn(this, period, actor, reason);
  }

  /** 期间是否已结账锁定。 */
  isPeriodLocked(period: Period): boolean {
    return isPeriodLockedIn(this, period);
  }

  /** 注入审核引擎的结账校验器（传 null 取消注入）。 */
  setCloseValidator(validator: CloseValidator | null): void {
    this.closeValidator = typeof validator === 'function' ? validator : null;
  }

  /** 当前注入的结账校验器。 */
  getCloseValidator(): CloseValidator | null {
    return this.closeValidator;
  }

  /* ------------------------ PeriodCloseStore 实现 ------------------------ */

  /** 由审计库统一发号，保证 validFrom / at 单调递增。 */
  clockNow(): IsoDateTime {
    let stamp = Date.now();
    if (stamp <= this.lastStampMs) stamp = this.lastStampMs + 1;
    this.lastStampMs = stamp;
    return formatIso(stamp);
  }

  /** 读取期间结账状态。 */
  readPeriodState(period: Period): PeriodCloseRecord | null {
    if (!isValidPeriod(period)) return null;
    const raw = this.current<unknown>('period_close', period);
    if (!isRecord(raw)) return null;
    return raw as unknown as PeriodCloseRecord;
  }

  /** 列出全部期间结账状态（升序）。 */
  listPeriodStates(): PeriodCloseRecord[] {
    const result: PeriodCloseRecord[] = [];
    for (const id of this.list('period_close')) {
      const state = this.readPeriodState(id);
      if (state !== null) result.push(state);
    }
    return result.sort((a, b) => compareText(a.period, b.period));
  }

  /** 取某期间当前生效的凭证（已排除软删除）。 */
  vouchersOf(period: Period): Voucher[] {
    if (!isValidPeriod(period)) return [];
    const result: Voucher[] = [];
    for (const id of this.list('voucher')) {
      const data = this.current<unknown>('voucher', id);
      if (!isRecord(data)) continue;
      if (data['period'] !== period) continue;
      result.push(data as unknown as Voucher);
    }
    return result.sort((a, b) => compareText(a.id, b.id));
  }

  /**
   * 写入一次期间状态变更（结账/反结账专用）。
   *
   * 刻意绕过期间锁检查：这条路径写的就是「锁」本身，如果也受锁约束，
   * 反结账就永远无法执行。
   */
  writePeriodState(input: PeriodStateWrite): { version: VersionRecord; event: AuditEvent } {
    const period = input.period;
    if (!isValidPeriod(period)) {
      throw new AuditValidationError(`会计期间格式应为 YYYY-MM，实际为「${period}」`);
    }
    if (input.record.period !== period) {
      throw new AuditValidationError(
        `期间状态记录的 period（${input.record.period}）与写入目标期间（${period}）不一致`,
      );
    }
    const actor = this.resolveActor(input.actor);

    const entry = this.readVersions('period_close');
    const existing = entry.index.get(period) ?? [];
    const current = existing[existing.length - 1];

    const now = this.clockNow();
    const version = (current?.version ?? 0) + 1;
    const snapshot = cloneJson(input.record);
    const record: VersionRecord = {
      versionId: versionIdOf('period_close', period, version),
      entity: 'period_close',
      entityId: period,
      version,
      data: snapshot,
      validFrom: now,
      validTo: null,
      deleted: false,
      createdBy: actor,
      createdAt: now,
      changeSummary: input.action === 'close_period' ? `结账 ${period}` : `反结账 ${period}`,
    };

    this.appendVersion('period_close', record);
    const event = this.appendEvent({
      actor,
      action: input.action,
      entity: 'period_close',
      entityId: period,
      before: current === undefined ? null : cloneJson(current.data),
      after: cloneJson(snapshot),
      reason: input.reason,
    });
    return { version: this.materializeOne(record, null), event };
  }

  /* ------------------------------ 内部写入 ------------------------------ */

  private persist(
    entity: EntityKind,
    id: string,
    data: unknown,
    expectedVersion: number | null | undefined,
    opts: SaveOptions,
  ): VersionRecord {
    assertEntityKind(entity);
    assertEntityId(id);
    assertData(data);

    const actor = this.resolveActor(opts.actor);
    const summary = normalizeSummary(opts.summary);
    this.assertSummaryRequirement(entity, summary);
    const snapshot = cloneJson(data);

    const entry = this.readVersions(entity);
    const existing = entry.index.get(id) ?? [];
    const current = existing[existing.length - 1];

    if (current !== undefined && current.deleted) {
      throw new EntitySoftDeletedError(entity, id, current.version, current.deletedReason);
    }
    if (expectedVersion !== undefined) {
      const actual = current === undefined ? null : current.version;
      if (actual !== expectedVersion) {
        throw new VersionConflictError(entity, id, expectedVersion, actual);
      }
    }
    this.assertNotLocked(entity, id, current === undefined ? null : current.data, snapshot);

    const now = this.clockNow();
    const version = (current?.version ?? 0) + 1;
    const record: VersionRecord = {
      versionId: versionIdOf(entity, id, version),
      entity,
      entityId: id,
      version,
      data: snapshot,
      validFrom: now,
      validTo: null,
      deleted: false,
      createdBy: actor,
      createdAt: now,
      changeSummary: summary,
    };

    this.appendVersion(entity, record);
    this.appendEvent({
      actor,
      action: current === undefined ? 'create' : 'update',
      entity,
      entityId: id,
      before: current === undefined ? null : cloneJson(current.data),
      after: cloneJson(snapshot),
      reason: summary,
    });
    return this.materializeOne(record, null);
  }

  private appendVersion(entity: EntityKind, record: VersionRecord): void {
    const path = this.versionPath(entity);
    const cache = this.versionCache.get(entity);
    const result = this.appendJsonLine(path, record);
    if (cache !== undefined && cache.size === result.sizeBefore) {
      cache.records.push(record);
      cache.size = result.sizeBefore + result.bytes;
      const list = cache.index.get(record.entityId);
      if (list === undefined) cache.index.set(record.entityId, [record]);
      else list.push(record);
    } else {
      // 缓存与磁盘不同步（其它进程写过 / 刚启动），直接失效，下次读时重建
      this.versionCache.delete(entity);
    }
  }

  private appendEvent(input: {
    actor: string;
    action: AuditEvent['action'];
    entity: EntityKind;
    entityId: string;
    before: unknown;
    after: unknown;
    reason?: string;
  }): AuditEvent {
    const entry = this.readEvents();

    const last = entry.events[entry.events.length - 1];
    const seq = last === undefined ? 1 : last.seq + 1;
    const at = this.clockNow();
    const event: AuditEvent = {
      seq,
      id: `evt-${String(seq).padStart(6, '0')}-${at.replace(/[^0-9]/g, '').slice(0, 17)}`,
      at,
      actor: input.actor,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      before: input.before,
      after: input.after,
      reason: input.reason,
      prevHash: last === undefined ? ZERO_HASH : last.hash,
      hash: '',
    };
    event.hash = computeEventHash(event);

    const result = this.appendJsonLine(this.eventsPath, event);
    if (this.eventCache !== null && this.eventCache.size === result.sizeBefore) {
      this.eventCache.events.push(event);
      this.eventCache.size = result.sizeBefore + result.bytes;
    } else {
      this.eventCache = null;
    }
    return event;
  }

  /**
   * 追加一行 JSON。
   *
   * 以 'a'（append）模式打开：操作系统保证每次 write 都落在文件末尾，
   * 不存在「覆盖已有字节」的可能。写完立刻 fsync，掉电时最多丢这一次尚未落盘的写入，
   * 已确认的审计记录不会因为系统崩溃而消失。
   */
  private appendJsonLine(path: string, payload: unknown): AppendResult {
    const line = `${JSON.stringify(payload)}\n`;
    const buffer = Buffer.from(line, 'utf8');
    const sizeBefore = fileSize(path);
    let bytes = 0;

    const fd = openSync(path, 'a');
    try {
      if (sizeBefore > 0 && !endsWithNewline(path, sizeBefore)) {
        // 上一次写入被掉电截断：先补一个换行，让残缺行独立成行。
        // 绝不删除它——残缺的字节本身也是「当时发生过什么」的证据。
        const repair = Buffer.from('\n', 'utf8');
        writeSync(fd, repair, 0, repair.length);
        bytes += repair.length;
      }
      writeSync(fd, buffer, 0, buffer.length);
      bytes += buffer.length;
      if (this.fsyncEnabled) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { bytes, sizeBefore };
  }

  /* ------------------------------ 内部读取 ------------------------------ */

  private versionPath(entity: EntityKind): string {
    return join(this.dataDir, versionFileName(entity));
  }

  private readVersions(entity: EntityKind, force = false): VersionCacheEntry {
    const path = this.versionPath(entity);
    const size = fileSize(path);
    const cached = this.versionCache.get(entity);
    if (!force && cached !== undefined && cached.size === size) return cached;

    const read = readJsonLines<VersionRecord>(path, versionFileName(entity));
    const entry: VersionCacheEntry = {
      size: read.size,
      records: read.items,
      index: buildVersionIndex(read.items),
      problems: read.problems,
    };
    this.versionCache.set(entity, entry);
    return entry;
  }

  private readEvents(force = false): EventCacheEntry {
    const size = fileSize(this.eventsPath);
    if (!force && this.eventCache !== null && this.eventCache.size === size) {
      return this.eventCache;
    }
    const read = readJsonLines<AuditEvent>(this.eventsPath, AUDIT_EVENTS_FILE);
    const entry: EventCacheEntry = { size: read.size, events: read.items, problems: read.problems };
    this.eventCache = entry;
    return entry;
  }

  private loadEvents(): AuditEvent[] {
    return this.readEvents().events;
  }

  /**
   * 当前读到的损坏行（人类可读），没有损坏返回空数组。
   *
   * 读取路径对损坏行采取「跳过但不修改」的策略，原因见文件头「损坏处理策略」。
   * CLI / Web 可以在首页用这个方法给出一条黄色横幅，提示运维尽快核查。
   */
  storageProblems(force = false): string[] {
    const problems: string[] = [];
    const describe = (item: ReadProblem): string =>
      `${item.message}${item.tornTail ? '（末行截断，疑似宕机残留）' : '（非末行损坏，疑似人为改动）'}`;
    for (const item of this.readEvents(force).problems) {
      problems.push(`${AUDIT_EVENTS_FILE} 第 ${item.line} 行：${describe(item)}`);
    }
    for (const entity of ENTITY_KINDS) {
      for (const item of this.readVersions(entity, force).problems) {
        problems.push(`${versionFileName(entity)} 第 ${item.line} 行：${describe(item)}`);
      }
    }
    return problems;
  }

  /**
   * 断言审计库没有损坏行，否则抛 AuditLogCorruptError。
   *
   * 生成财务报表、纳税申报草稿、对外报告之前必须先过这一关：
   * 在损坏的账套上算出来的数字，签了字也是错的。日常浏览历史则不必调用，
   * 否则一次宕机就会让整个系统无法打开。
   */
  assertStorageHealthy(): void {
    const problems = this.storageProblems(true);
    if (problems.length === 0) return;
    throw new AuditLogCorruptError(
      `审计库存在 ${problems.length} 处损坏记录，已拒绝继续：\n- ${problems.join('\n- ')}\n` +
        '请从备份恢复或由审计人员人工核查。系统不提供任何物理删除或截断命令，历史记录必须保留',
    );
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  private materializeOne(record: VersionRecord, validTo: IsoDateTime | null): VersionRecord {
    return { ...record, data: cloneJson(record.data), validTo };
  }

  private resolveActor(actor?: string): string {
    const name = typeof actor === 'string' ? actor.trim() : '';
    return name === '' ? this.defaultActor : name;
  }

  private assertSummaryRequirement(entity: EntityKind, summary: string | undefined): void {
    if (!this.config.entities.requireSummary.includes(entity)) return;
    if (summary === undefined) {
      throw new AuditValidationError(
        `保存 ${entity} 时必须填写变更摘要（summary）：这类数据会进入对外报表/申报，` +
          '没有摘要的历史版本事后无法说明「为什么改」',
      );
    }
  }

  private assertNotLocked(
    entity: EntityKind,
    entityId: string,
    before: unknown,
    after: unknown,
  ): void {
    if (!this.config.lock.enabled) return;
    // period_close 本身就是锁状态，不能自己锁自己
    if (entity === 'period_close') return;

    const periods = new Set<Period>();
    for (const payload of [before, after]) {
      const period = periodOfPayload(entity, entityId, payload);
      if (period !== null) periods.add(period);
    }
    for (const period of periods) {
      if (this.isPeriodLocked(period)) {
        throw new PeriodLockedError(period, `${entity}/${entityId} 的写入被拒绝`);
      }
    }
  }

  private plainNow(): IsoDateTime {
    return formatIso(Date.now());
  }
}

/* ================================================================== */
/* 七、工具函数                                                        */
/* ================================================================== */

/** 深拷贝 JSON 数据；非对象原样返回。 */
export function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 字段级差异。
 *
 * 数组按下标递归而不是整体比较：凭证改了一行金额时，需要精确指出是第几行，
 * 否则复核人还得自己一行行找。
 */
export function diffJson(before: unknown, after: unknown): FieldDiff[] {
  const left = new Map<string, unknown>();
  const right = new Map<string, unknown>();
  flattenValue(before, '', left, 0);
  flattenValue(after, '', right, 0);

  const fields = new Set<string>([...left.keys(), ...right.keys()]);
  const result: FieldDiff[] = [];
  for (const field of [...fields].sort(compareText)) {
    const hasLeft = left.has(field);
    const hasRight = right.has(field);
    if (hasLeft && !hasRight) {
      result.push({ field, before: left.get(field), after: undefined, kind: 'removed' });
      continue;
    }
    if (!hasLeft && hasRight) {
      result.push({ field, before: undefined, after: right.get(field), kind: 'added' });
      continue;
    }
    const leftValue = left.get(field);
    const rightValue = right.get(field);
    if (canonicalJson(leftValue) !== canonicalJson(rightValue)) {
      result.push({ field, before: leftValue, after: rightValue, kind: 'changed' });
    }
  }
  return result;
}

function flattenValue(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
  depth: number,
): void {
  const key = prefix === '' ? '$' : prefix;
  if (depth > 32) {
    out.set(key, value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(key, value);
      return;
    }
    for (let index = 0; index < value.length; index += 1) {
      // 与 JSON 一致：数组里的 undefined 落盘后会变成 null，比较时按 null 处理
      const item = value[index];
      flattenValue(item === undefined ? null : item, `${prefix}[${index}]`, out, depth + 1);
    }
    return;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.set(key, value);
      return;
    }
    for (const childKey of keys) {
      const child = value[childKey];
      // 与 JSON 一致：值为 undefined 的属性落盘后会消失，不参与比较
      if (child === undefined) continue;
      flattenValue(child, prefix === '' ? childKey : `${prefix}.${childKey}`, out, depth + 1);
    }
    return;
  }
  out.set(key, value);
}

function materialize(records: readonly VersionRecord[]): VersionRecord[] {
  const result: VersionRecord[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    const next = records[index + 1];
    result.push({
      ...record,
      data: cloneJson(record.data),
      validTo: next === undefined ? null : next.validFrom,
    });
  }
  return result;
}

function buildVersionIndex(records: readonly VersionRecord[]): Map<string, VersionRecord[]> {
  const index = new Map<string, VersionRecord[]>();
  for (const record of records) {
    const list = index.get(record.entityId);
    if (list === undefined) index.set(record.entityId, [record]);
    else list.push(record);
  }
  for (const list of index.values()) {
    list.sort((a, b) => a.version - b.version);
  }
  return index;
}

function versionIdOf(entity: EntityKind, entityId: string, version: number): string {
  return `${entity}:${entityId}:v${version}`;
}

function periodOfPayload(entity: EntityKind, entityId: string, payload: unknown): Period | null {
  if (entity === 'period_close') return isValidPeriod(entityId) ? entityId : null;
  if (!isRecord(payload)) return null;

  const period = payload['period'];
  if (typeof period === 'string' && isValidPeriod(period)) return period;

  const date = payload['date'];
  if (typeof date === 'string' && date.length >= 7) {
    const derived = periodOf(date);
    if (isValidPeriod(derived)) return derived;
  }
  return null;
}

function readJsonLines<T>(
  path: string,
  label: string,
): { size: number; items: T[]; problems: ReadProblem[] } {
  if (!existsSync(path)) return { size: 0, items: [], problems: [] };
  const size = statSync(path).size;
  if (size === 0) return { size: 0, items: [], problems: [] };

  // Windows 记事本保存的 UTF-8 可能带 BOM；不剥掉会让第一行 JSON 解析失败
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  const items: T[] = [];
  const problems: ReadProblem[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.trim() === '') continue;
    const isLast = index === lines.length - 1;
    const tornTail = isLast && !endsWithNewline;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        problems.push({ line: index + 1, message: `${label} 第 ${index + 1} 行不是 JSON 对象`, tornTail });
        continue;
      }
      items.push(parsed as T);
    } catch {
      problems.push({
        line: index + 1,
        message: `${label} 第 ${index + 1} 行不是合法 JSON（可能被截断或手工篡改）`,
        tornTail,
      });
    }
  }
  return { size, items, problems };
}

function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function endsWithNewline(path: string, size: number): boolean {
  if (size <= 0) return true;
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1);
    const read = readSync(fd, buffer, 0, 1, size - 1);
    return read === 1 && buffer[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

function formatIso(epochMs: number): IsoDateTime {
  const date = new Date(epochMs);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

function toEpoch(value: string): number {
  if (typeof value !== 'string' || value === '') return Number.NaN;
  return Date.parse(value);
}

function parseInstant(value: IsoDateTime, label: string): number {
  const stamp = toEpoch(value);
  if (!Number.isFinite(stamp)) {
    throw new AuditValidationError(`${label}「${value}」不是合法的 ISO-8601 时间`);
  }
  return stamp;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertEntityKind(value: EntityKind): void {
  if (typeof value !== 'string' || !ENTITY_KIND_SET.has(value)) {
    throw new AuditValidationError(
      `未知的实体类型「${String(value)}」，可选：${ENTITY_KINDS.join(' / ')}`,
    );
  }
}

function toEntityKind(value: string, context: string): EntityKind {
  if (!ENTITY_KIND_SET.has(value)) {
    throw new AuditValidationError(
      `${context} 含未知实体「${value}」，可选：${ENTITY_KINDS.join(' / ')}`,
    );
  }
  return value as EntityKind;
}

function assertEntityId(id: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new AuditValidationError('实体 id 不能为空');
  }
  if (/[\u0000-\u001f]/.test(id)) {
    throw new AuditValidationError('实体 id 不能包含控制字符');
  }
  if (id.length > 256) {
    throw new AuditValidationError('实体 id 长度不能超过 256 个字符');
  }
}

function assertData(data: unknown): void {
  if (data === undefined || data === null) {
    throw new AuditValidationError('保存的数据不能为 null/undefined：审计版本必须是完整快照');
  }
  const type = typeof data;
  if (type === 'function' || type === 'symbol') {
    throw new AuditValidationError(`保存的数据类型不支持：${type}`);
  }
}

function normalizeSummary(summary?: string): string | undefined {
  const text = typeof summary === 'string' ? summary.trim() : '';
  return text === '' ? undefined : text;
}

function normalizeReason(reason: string, hint: string): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text === '') throw new AuditValidationError(hint);
  return text;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new AuditValidationError(
        `${context} 含未知字段「${key}」，可用：${known.join(' / ')}`,
      );
    }
  }
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuditValidationError(`${context} 必须是非空字符串，实际为 ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function requireNumber(value: unknown, context: string): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new AuditValidationError(`${context} 必须是数字，实际为 ${JSON.stringify(value)}`);
  }
  return num;
}

function optionalStringArray(value: unknown, context: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new AuditValidationError(`${context} 必须是字符串数组，实际为 ${JSON.stringify(value)}`);
  }
  return value.map((item) => String(item));
}

function parseLawBasisList(value: unknown, context: string): LawBasis[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new AuditValidationError(`${context} 必须是数组`);
  }
  const result: LawBasis[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      throw new AuditValidationError(`${context}[${index}] 必须是对象`);
    }
    assertKnownKeys(
      item,
      ['id', 'title', 'article', 'excerpt', 'effectiveFrom', 'url', 'level'],
      `${context}[${index}]`,
    );
    const basis: LawBasis = {
      id: requireString(item['id'], `${context}[${index}].id`),
      title: requireString(item['title'], `${context}[${index}].title`),
    };
    const article = optionalString(item['article']);
    if (article !== undefined) basis.article = article;
    const excerpt = optionalString(item['excerpt']);
    if (excerpt !== undefined) basis.excerpt = excerpt;
    const effectiveFrom = optionalString(item['effectiveFrom']);
    if (effectiveFrom !== undefined) basis.effectiveFrom = effectiveFrom;
    const url = optionalString(item['url']);
    if (url !== undefined) basis.url = url;
    const level = optionalString(item['level']);
    if (level !== undefined) {
      if (!LAW_LEVELS.has(level)) {
        throw new AuditValidationError(
          `${context}[${index}].level 只能是 law / administrative-regulation / departmental-rule / normative-document / standard，实际为「${level}」`,
        );
      }
      basis.level = level as LawBasis['level'];
    }
    result.push(basis);
  }
  return result;
}
