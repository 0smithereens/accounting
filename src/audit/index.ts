/**
 * 审计留痕与版本库（门面）。
 *
 * 对外只暴露这个入口：业务代码 import { AuditStore } from '../audit/index.ts'，
 * 不直接引用内部文件名。这样将来拆分/替换存储实现（比如换成 SQLite）时，
 * 只需要改这里，不必全项目搜 import 路径。
 *
 * 模块能力一览：
 *   - hash.ts          规范化 JSON、sha256 哈希链、链校验
 *   - store.ts         版本表 + 审计事件流（追加式 JSONL）、软删除、期间锁
 *   - repository.ts    面向实体的仓储（类型安全、乐观并发）
 *   - period-close.ts  结账 / 反结账与可注入的结账校验器
 *   - verify.ts        完整性报告
 *
 * 监管约束在本模块的落点：
 *   - 没有任何物理删除路径：Delete 一律软删除，Update 一律追加新版本；
 *   - 每一次变更都写审计事件并进入哈希链，事后无法悄悄改；
 *   - 已结账期间冻结，反结账必须书面说明理由；
 *   - 结账前必须通过借贷平衡、兜底科目清零与注入的审核校验。
 */

export * from './hash.ts';
export * from './store.ts';
export * from './repository.ts';
export * from './period-close.ts';
export * from './verify.ts';

import { AuditStore } from './store.ts';
import type { AuditStoreOptions } from './store.ts';
import { createRepositories } from './repository.ts';
import type { AuditRepositories } from './repository.ts';

/** 创建审计库（语义化别名，便于在 CLI / Web 装配层统一入口）。 */
export function createAuditStore(options: AuditStoreOptions): AuditStore {
  return new AuditStore(options);
}

/** 一次创建「审计库 + 全套仓储」。 */
export function createAuditRepositories(options: AuditStoreOptions): {
  store: AuditStore;
  repositories: AuditRepositories;
} {
  const store = new AuditStore(options);
  return { store, repositories: createRepositories(store) };
}
