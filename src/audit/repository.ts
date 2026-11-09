/**
 * 面向实体的仓储（Repository）。
 *
 * 为什么在 AuditStore 之上再加一层：
 *   AuditStore 的 API 是「泛型 + 实体类型字符串」，业务代码写
 *   store.current<Voucher>('voucher', id) 既啰嗦又容易把实体名拼错。
 *   仓储把「实体类型」固化成对象的属性，业务侧只写 vouchers.get(id)，
 *   类型、实体名、默认操作人都在一处定义，改的时候不会漏。
 *
 * 为什么 update 要基于版本号：
 *   两个人同时打开同一张凭证，A 改了摘要、B 改了金额，后保存的人如果不做版本检查，
 *   就会把前一个人的修改整份覆盖掉——账务数据上的静默覆盖是最难查的错。
 *   update() 先读当前版本，再以该版本号做乐观并发写入，冲突时抛 VersionConflictError。
 */

import type {
  AuditEvent,
  DocumentRecord,
  EntityKind,
  FinancialStatement,
  IsoDateTime,
  Period,
  PolicyNode,
  TaxReturn,
  VersionRecord,
  Voucher,
} from '../core/contracts.ts';
import { EntityNotFoundError } from './store.ts';
import type { AuditEventFilter, AuditStore, FieldDiff, SaveOptions } from './store.ts';

/** 通用实体仓储。 */
export class EntityRepository<T = unknown> {
  /** 底层审计库 */
  readonly store: AuditStore;
  /** 本仓储管理的实体类型 */
  readonly entity: EntityKind;

  constructor(store: AuditStore, entity: EntityKind) {
    this.store = store;
    this.entity = entity;
  }

  /** 当前数据（已软删除的返回 null）。 */
  get(id: string): T | null {
    return this.store.current<T>(this.entity, id);
  }

  /** 时点查询：at 时刻生效的数据。 */
  getAt(id: string, at: IsoDateTime): T | null {
    return this.store.getAt<T>(this.entity, id, at);
  }

  /** 当前版本记录（含删除状态）。 */
  currentRecord(id: string): VersionRecord | null {
    return this.store.currentRecord(this.entity, id);
  }

  /** 指定版本记录。 */
  version(id: string, version: number): VersionRecord | null {
    return this.store.version(this.entity, id, version);
  }

  /** 全版本（升序）。 */
  history(id: string): VersionRecord[] {
    return this.store.history(this.entity, id);
  }

  /** id 列表。 */
  list(opts: { includeDeleted?: boolean } = {}): string[] {
    return this.store.list(this.entity, opts);
  }

  /** 数量。 */
  count(opts: { includeDeleted?: boolean } = {}): number {
    return this.store.count(this.entity, opts);
  }

  /** 是否存在且未被软删除。 */
  exists(id: string): boolean {
    const record = this.store.currentRecord(this.entity, id);
    return record !== null && !record.deleted;
  }

  /** 新建或更新。 */
  save(id: string, data: T, opts: SaveOptions = {}): VersionRecord {
    return this.store.save(this.entity, id, data, opts);
  }

  /** 语义化的 save：不存在则建、存在则更。 */
  upsert(id: string, data: T, opts: SaveOptions = {}): VersionRecord {
    return this.store.save(this.entity, id, data, opts);
  }

  /**
   * 读-改-写：以当前版本号做乐观并发控制。
   *
   * mutator 收到的是当前数据的深拷贝，直接改并返回即可；
   * 若在读取与写入之间有人改过，抛 VersionConflictError 而不是覆盖。
   */
  update(id: string, mutator: (current: T) => T, opts: SaveOptions = {}): VersionRecord {
    const record = this.store.currentRecord(this.entity, id);
    if (record === null) throw new EntityNotFoundError(this.entity, id);
    const next = mutator(record.data as T);
    return this.store.saveVersioned(this.entity, id, next, record.version, opts);
  }

  /** 软删除（不传 version 则用当前版本）。 */
  remove(id: string, actor: string, reason: string, version?: number): VersionRecord {
    const record = this.store.currentRecord(this.entity, id);
    if (record === null) throw new EntityNotFoundError(this.entity, id);
    return this.store.softDelete({
      entity: this.entity,
      entityId: id,
      actor,
      reason,
      version: version ?? record.version,
    });
  }

  /** 恢复被软删除的数据。 */
  restore(id: string, actor: string, reason: string): VersionRecord {
    return this.store.restore(this.entity, id, actor, reason);
  }

  /** 版本对比。 */
  diff(id: string, v1: number, v2: number): FieldDiff[] {
    return this.store.diff(this.entity, id, v1, v2);
  }

  /** 本实体的审计事件。 */
  events(filter: Omit<AuditEventFilter, 'entity'> = {}): AuditEvent[] {
    return this.store.events({ ...filter, entity: this.entity });
  }
}

/** 凭证仓储：增加按期间取数的常用能力。 */
export class VoucherRepository extends EntityRepository<Voucher> {
  constructor(store: AuditStore) {
    super(store, 'voucher');
  }

  /** 某期间的全部凭证（按日期、凭证字号排序）。 */
  listByPeriod(period: Period): Voucher[] {
    const result: Voucher[] = [];
    for (const id of this.list()) {
      const voucher = this.get(id);
      if (voucher === null) continue;
      if (voucher.period !== period) continue;
      result.push(voucher);
    }
    return result.sort((a, b) => {
      const byDate = a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      if (byDate !== 0) return byDate;
      return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
    });
  }
}

/** 全部仓储集合，业务层一次拿齐。 */
export interface AuditRepositories {
  vouchers: VoucherRepository;
  documents: EntityRepository<DocumentRecord>;
  taxReturns: EntityRepository<TaxReturn>;
  statements: EntityRepository<FinancialStatement>;
  accounts: EntityRepository<Record<string, unknown>>;
  policies: EntityRepository<PolicyNode>;
  settings: EntityRepository<Record<string, unknown>>;
  users: EntityRepository<Record<string, unknown>>;
}

/** 为同一个审计库创建全套仓储。 */
export function createRepositories(store: AuditStore): AuditRepositories {
  return {
    vouchers: new VoucherRepository(store),
    documents: new EntityRepository<DocumentRecord>(store, 'document'),
    taxReturns: new EntityRepository<TaxReturn>(store, 'tax_return'),
    statements: new EntityRepository<FinancialStatement>(store, 'statement'),
    accounts: new EntityRepository<Record<string, unknown>>(store, 'account'),
    policies: new EntityRepository<PolicyNode>(store, 'policy'),
    settings: new EntityRepository<Record<string, unknown>>(store, 'settings'),
    users: new EntityRepository<Record<string, unknown>>(store, 'user'),
  };
}
