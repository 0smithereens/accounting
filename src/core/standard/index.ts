/**
 * 会计准则模块门面（Facade）。
 *
 * 其它模块（记账 / 审核 / 报表 / 税务 / Web）只从这个文件 import，不要直接深入
 * ./profiles.ts。这样以后把准则档案拆成多个文件（如 permitted-accounts.ts、
 * feature-diff.ts）时，调用方不用改代码。
 *
 * 典型用法：
 *   import { loadStandardRegistry, loadStandardAccounts, checkAccountAllowed } from '../core/standard/index.ts';
 *   const registry = loadStandardRegistry();
 *   const profile = registry.get('small');
 *   const accounts = loadStandardAccounts(profile);
 *   const allowance = checkAccountAllowed(profile, '1811', '递延所得税资产');
 *   // allowance.allowed === false，allowance.basis 里是《小企业会计准则》的条款
 */

export {
  DEFAULT_STANDARD,
  FEATURE_DIFF,
  STANDARD_FEATURE_LABEL,
  STANDARD_IDS,
  StandardConfigError,
  checkAccountAllowed,
  clearStandardAccountCache,
  describeFeatureDiff,
  listForbiddenAccounts,
  loadStandardAccounts,
  loadStandardBundle,
  loadStandardRegistry,
  resolveStandardFile,
} from './profiles.ts';

export type {
  AccountAllowance,
  FeatureDiffRow,
  ForbiddenAccountRule,
  StandardRegistry,
} from './profiles.ts';

// 契约类型原样透出，调用方不必同时 import 两个模块
export type {
  AccountingStandardId,
  LawBasis,
  StandardBundle,
  StandardFeatureFlags,
  StandardProfile,
} from '../contracts.ts';
