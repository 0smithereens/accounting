/**
 * 申报工作流：草稿 → 计算 → 复核 → 审批 → 导出底稿 → 人工申报回填。
 *
 * 设计要点（为什么这么写）：
 *   1. **状态只能由本类推进**。所有迁移都走 state-machine 的 applyTransition()，
 *      业务代码里没有任何一处直接给 status 赋值的语句（见单测的源码扫描）。
 *   2. **签署时间是服务器时间**。调用方传进来的 at 会被工作流时钟覆盖，
 *      否则客户端时钟回拨就能造出「审批早于复核」的时间线，审计时无法解释。
 *   3. **对外只返回深拷贝**。get()/list()/各方法返回的都是 structuredClone，
 *      调用方改返回值不会污染内部记录，也就不存在「绕过闸门改字段」。
 *   4. **内存态**。持久化交给 audit 模块（它负责历史版本表与哈希链），
 *      本模块只保证「在内存里也不可能出现非法状态」。
 */

import type {
  FilingStatus,
  IsoDateTime,
  ManualFilingRecord,
  Period,
  Signature,
  SignRole,
  TaxReturn,
  TaxType,
} from '../core/contracts.ts';
import { FILING_STATUS_LABEL } from '../core/contracts.ts';
import { isValidPeriod } from '../core/datetime.ts';
import { formatYuan } from '../core/money.ts';
import {
  assertExportable,
  assertFourEyes,
  isPayableLine,
  assertLinesConsistent,
  assertManualFilingRecord,
  assertNoAutoSubmission,
  assertReturnIntegrity,
  assertReviewPassed,
  assertReviewerEligible,
  assertSignaturesFresh,
  defaultFilingConfig,
  loadFilingConfig,
  normalizeActor,
  normalizeReason,
  recordFilingGuardAudit,
  StaleSignatureError,
  MissingSignatureError,
  FilingGuardError,
} from './guard.ts';
import type { FilingConfig, FilingGuards } from './guard.ts';
import {
  appendSignature,
  applyTransition,
  assertCanTransition,
  bumpVersion,
  hashFilingPayload,
  latestSignature,
  nowIso,
} from './state-machine.ts';

/** 工作流层的错误（找不到申报表、重复登记、参数非法等），与「闸门拒绝」区分开。 */
export class FilingWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilingWorkflowError';
  }
}

export interface FilingWorkflowOptions {
  /** 配置文件目录，缺省为 <项目根>/config */
  configDir?: string;
  /** 审核报告回调（避免依赖 review 模块） */
  guards?: FilingGuards;
  /** 时钟注入，便于测试确定性 */
  now?: () => IsoDateTime;
}

/** 待办动作。 */
export interface FilingPendingAction {
  id: string;
  taxType: TaxType;
  period: Period;
  status: FilingStatus;
  action: string;
  assigneeRole: SignRole;
}

interface NextAction {
  action: string;
  role: SignRole;
}

/**
 * 每个状态的「下一步该谁做什么」。
 *
 * filed / void 没有下一步：前者已经由人工在税务局完成，后者已经作废。
 */
function nextActionOf(status: FilingStatus): NextAction | null {
  switch (status) {
    case 'draft':
      return { action: '计算税额', role: 'preparer' };
    case 'calculated':
      return { action: '复核', role: 'reviewer' };
    case 'reviewed':
      return { action: '审批', role: 'approver' };
    case 'approved':
      return { action: '导出申报底稿并人工申报', role: 'approver' };
    case 'rejected':
      return { action: '修订后重新计算', role: 'preparer' };
    case 'filed':
    case 'void':
      return null;
    default:
      return null;
  }
}

export class FilingWorkflow {
  private readonly records = new Map<string, TaxReturn>();
  private readonly config: FilingConfig;
  private readonly guards: FilingGuards;
  private readonly clock: () => IsoDateTime;

  constructor(options: FilingWorkflowOptions = {}) {
    this.config = options.configDir === undefined
      ? loadFilingConfig()
      : loadFilingConfig(options.configDir);
    this.guards = options.guards ?? {};
    this.clock = options.now ?? nowIso;
  }

  /** 当前生效的流程配置（深拷贝，防止外部改动影响已登记的申报表）。 */
  getConfig(): FilingConfig {
    return structuredClone(this.config);
  }

  /**
   * 登记一张草稿申报表。
   *
   * 为什么草稿也要校验？因为草稿是后续一切计算的输入。
   * 一张期间写错（2024-1）、金额是浮点元的草稿，后面所有签署都会建立在错误数据上。
   * 登记时会重算指纹并把 due 归位，保证「进入流程的那一刻起，内容与指纹就是一致的」。
   */
  /**
   * 从审计库「接着办」：登记一张已经算过、甚至已经签过字的申报表。
   *
   * 为什么需要它：registerDraft 只收草稿，而真实流程是跨进程的——
   * 昨天月结算出「已计算」，今天复核人签署，明天审批人签署。
   * 每次动作都要先把历史状态装回来，否则状态机无从判断下一步该不该放行。
   *
   * 它**不产生任何事件**：历史已经在审计库里了，重放会造假。
   * 它也不放宽任何规则：之后每次迁移仍然要过 TRANSITIONS 与各道闸门。
   */
  adopt(ret: TaxReturn): TaxReturn {
    if (ret === null || typeof ret !== 'object') {
      throw new FilingWorkflowError('恢复申报表需要传入完整对象');
    }
    const id = typeof ret.id === 'string' ? ret.id.trim() : '';
    if (id === '') throw new FilingWorkflowError('申报表 id 不能为空');
    if (this.records.has(id)) {
      throw new FilingWorkflowError(
        `申报表「${id}」已登记，不能重复恢复。同一流程内请直接操作原对象。`,
      );
    }
    if (!isValidPeriod(ret.period)) {
      throw new FilingWorkflowError(`会计期间格式非法：${String(ret.period)}（应为 YYYY-MM）`);
    }
    const stored = structuredClone(ret);
    stored.id = id;
    this.records.set(id, stored);
    return this.get(id);
  }

  registerDraft(ret: TaxReturn): TaxReturn {
    if (ret === null || typeof ret !== 'object') {
      throw new FilingWorkflowError('登记草稿需要传入完整的 TaxReturn 对象');
    }
    const id = typeof ret.id === 'string' ? ret.id.trim() : '';
    if (id === '') throw new FilingWorkflowError('申报表 id 不能为空');
    if (this.records.has(id)) {
      throw new FilingWorkflowError(
        `申报表「${id}」已登记，不能重复登记。如需重新出具，请先作废原申报表（作废不删除数据）。`,
      );
    }
    if (ret.status !== 'draft') {
      throw new FilingWorkflowError(
        `只能登记「草稿」状态的申报表，实际为「${FILING_STATUS_LABEL[ret.status]}」。` +
          '已计算的申报表必须由 calculate() 产生，不能跳过计算直接登记。',
      );
    }
    if (!isValidPeriod(ret.period)) {
      throw new FilingWorkflowError(`会计期间格式非法：${String(ret.period)}（应为 YYYY-MM）`);
    }
    if (typeof ret.taxpayerId !== 'string' || ret.taxpayerId.trim() === '') {
      throw new FilingWorkflowError('纳税人识别号（taxpayerId）不能为空');
    }
    if (ret.manualFiling !== undefined && ret.manualFiling !== null) {
      throw new FilingWorkflowError(
        '草稿不能携带人工申报回填记录：只有经审批并实际申报后才允许回填，否则等于伪造申报事实。',
      );
    }

    const stored = structuredClone(ret);
    stored.id = id;
    stored.version = Math.max(1, Math.trunc(stored.version) || 1);
    stored.due = stored.payable - stored.prepaid;
    stored.payloadHash = hashFilingPayload(stored);
    stored.updatedAt = this.clock();
    if (typeof stored.createdAt !== 'string' || stored.createdAt.trim() === '') {
      stored.createdAt = stored.updatedAt;
    }
    this.records.set(id, stored);
    return structuredClone(stored);
  }

  /**
   * 计算税额：校验申报行与应纳税额自洽，升版本、重算指纹、记录制单人签署。
   *
   * 每算一次就是新版本（即使内容没变）：计算口径被重新确认这件事本身要留痕，
   * 而且新版本号会让旧签署立刻失效，防止「签的是上一版、报的是这一版」。
   */
  calculate(id: string, actor: string): TaxReturn {
    const ret = this.mustGet(id);
    const who = normalizeActor(actor, '制单人');
    assertCanTransition(ret.status, 'calculated');
    assertLinesConsistent(ret);

    const at = this.clock();
    ret.due = ret.payable - ret.prepaid;
    const version = bumpVersion(ret, at);
    ret.payloadHash = hashFilingPayload(ret);

    // 认不出「应纳税额」行时勾稽会被跳过，这必须写进事件流，
    // 否则复核人无从知道「系统这次其实没校验应纳税额」。
    const payableCheckSkipped = !ret.lines.some((line) => isPayableLine(line));

    if (this.config.requirePreparerSignature) {
      appendSignature(ret, {
        role: 'preparer',
        actor: who,
        at,
        method: 'manual',
        payloadHash: ret.payloadHash,
        note: `第 ${version} 版计算`,
      });
    }

    applyTransition(ret, 'calculated', {
      actor: who,
      at,
      reason:
        `完成第 ${version} 版税额计算，计算指纹 ${ret.payloadHash.slice(0, 12)}…` +
        (payableCheckSkipped
          ? '；未识别到「应纳税额」行，已跳过与申报行的勾稽校验，请复核人手工核对'
          : ''),
    });
    return structuredClone(ret);
  }

  /**
   * 复核签署。
   *
   * 前置条件（任一不满足即拒绝）：
   *   - 状态为「已计算」；
   *   - 审核报告存在且阻断项为 0；
   *   - 复核人 ≠ 制单人（allowSelfReview = false 时）；
   *   - 签署携带的指纹必须与当前内容一致（防止签的是旧版）。
   */
  review(id: string, signature: Omit<Signature, 'payloadHash'>): TaxReturn {
    const ret = this.mustGet(id);
    assertCanTransition(ret.status, 'reviewed');
    if (signature.role !== 'reviewer') {
      throw new FilingGuardError(
        `复核签署的角色必须是 reviewer，实际为 ${String(signature.role)}。` +
          '角色写错意味着这条签名会在审批时被当成别人签的，必须拒绝。',
      );
    }
    const who = normalizeActor(signature.actor, '复核人');
    assertReturnIntegrity(ret);
    assertReviewPassed(ret, this.guards, this.config);
    assertReviewerEligible(ret, who, this.config);

    const at = this.clock();
    const hash = this.resolveHash(signature, ret, '复核', who);
    appendSignature(ret, {
      role: 'reviewer',
      actor: who,
      at,
      method: signature.method,
      payloadHash: hash,
      note: signature.note,
    });
    applyTransition(ret, 'reviewed', {
      actor: who,
      at,
      reason: `复核通过（计算指纹 ${hash.slice(0, 12)}…）`,
    });
    return structuredClone(ret);
  }

  /**
   * 审批签署。
   *
   * 前置条件：状态为「已复核」、复核人已签、审批人 ≠ 复核人（四眼原则）、
   * 制单人与复核人的签署都必须基于当前版本。
   */
  approve(id: string, signature: Omit<Signature, 'payloadHash'>): TaxReturn {
    const ret = this.mustGet(id);
    assertCanTransition(ret.status, 'approved');
    if (signature.role !== 'approver') {
      throw new FilingGuardError(
        `审批签署的角色必须是 approver，实际为 ${String(signature.role)}。`,
      );
    }
    const who = normalizeActor(signature.actor, '审批人');
    assertReturnIntegrity(ret);
    if (latestSignature(ret, 'reviewer') === undefined) {
      throw new MissingSignatureError(
        `申报表「${ret.id}」缺少复核人签署，不能审批。没有复核就没有审批对象。`,
      );
    }
    assertSignaturesFresh(ret, ['preparer', 'reviewer']);
    assertFourEyes(ret, who, this.config);

    const at = this.clock();
    const hash = this.resolveHash(signature, ret, '审批', who);
    appendSignature(ret, {
      role: 'approver',
      actor: who,
      at,
      method: signature.method,
      payloadHash: hash,
      note: signature.note,
    });
    applyTransition(ret, 'approved', {
      actor: who,
      at,
      reason: `审批通过，允许导出申报底稿（计算指纹 ${hash.slice(0, 12)}…）`,
    });
    return structuredClone(ret);
  }

  /** 退回：复核或审批不通过，退回后必须修订并重新计算。 */
  reject(id: string, actor: string, reason: string): TaxReturn {
    const ret = this.mustGet(id);
    assertCanTransition(ret.status, 'rejected');
    const who = normalizeActor(actor, '退回人');
    const why = normalizeReason(reason, '退回理由', 2);
    const at = this.clock();
    applyTransition(ret, 'rejected', { actor: who, at, reason: why });
    return structuredClone(ret);
  }

  /**
   * 修订：把退回的申报表改回草稿，版本 +1、指纹重算。
   *
   * 注意：不清理旧签署与旧审核报告 id。
   * 旧签名必须留在 signatures 里作为「当时签的是什么」的证据，
   * 它们会因为指纹变化而在后续校验中自然失效（StaleSignatureError），这比删掉更安全。
   */
  revise(
    id: string,
    actor: string,
    patch: Partial<Pick<TaxReturn, 'lines' | 'adjustments' | 'payable'>>,
  ): TaxReturn {
    const ret = this.mustGet(id);
    assertCanTransition(ret.status, 'draft');
    const who = normalizeActor(actor, '修订人');

    const changed: string[] = [];
    if (patch.lines !== undefined) {
      if (!Array.isArray(patch.lines) || patch.lines.length === 0) {
        throw new FilingGuardError('修订后的申报行不能为空：没有申报行就无法计算税额。');
      }
      ret.lines = patch.lines.map((line) => ({ ...line }));
      changed.push('申报行');
    }
    if (patch.adjustments !== undefined) {
      if (!Array.isArray(patch.adjustments)) {
        throw new FilingGuardError('修订后的纳税调整项必须是数组。');
      }
      ret.adjustments = patch.adjustments.map((adjustment) => ({ ...adjustment }));
      changed.push('纳税调整项');
    }
    if (patch.payable !== undefined) {
      if (!Number.isSafeInteger(patch.payable)) {
        throw new FilingGuardError(
          `修订后的应纳税额必须是整数「分」，实际为 ${String(patch.payable)}。`,
        );
      }
      ret.payable = patch.payable;
      changed.push('应纳税额');
    }
    if (changed.length === 0) {
      throw new FilingGuardError(
        '修订至少要改动 申报行 / 纳税调整项 / 应纳税额 之一；若只是重新计算，请先退回再修订。',
      );
    }

    const at = this.clock();
    ret.due = ret.payable - ret.prepaid;
    const version = bumpVersion(ret, at);
    ret.payloadHash = hashFilingPayload(ret);
    applyTransition(ret, 'draft', {
      actor: who,
      at,
      reason: `修订${changed.join('、')}（第 ${version} 版，需重新计算与复核）`,
    });
    return structuredClone(ret);
  }

  /**
   * 导出申报底稿前的状态推进（approved → approved，留痕）。
   *
   * 这里只改状态与事件，真正的 Excel 由 export.ts 的 exportFilingPackage() 生成。
   * 拆成两步是为了让「导出过」这件事进入事件流，而不是只在文件系统里留个文件。
   */
  exportForFiling(id: string, actor: string): TaxReturn {
    const ret = this.mustGet(id);
    const who = normalizeActor(actor, '导出人');
    assertNoAutoSubmission();
    assertExportable(ret, this.config);

    const at = this.clock();
    applyTransition(ret, 'approved', {
      actor: who,
      at,
      reason: '导出申报底稿：仅供人工在电子税务局照填，系统未向任何税务机关提交数据',
    });
    recordFilingGuardAudit('export_allowed', `申报表 ${ret.id} 已允许生成申报底稿`, who);
    return structuredClone(ret);
  }

  /**
   * 回填「人工已申报」这一外部事实。
   *
   * 这是 filed 状态的**唯一**入口：
   *   - 状态必须是「已审批」或「已申报」（后者为补录/更正）；
   *   - 必须带税务局受理回执号与实缴金额；
   *   - 事件里如实记录实缴与应补(退)的差异，不做任何「抹平」。
   */
  reportManualFiling(id: string, record: ManualFilingRecord): TaxReturn {
    const ret = this.mustGet(id);
    // 先查迁移：calculated → filed 在这里就会抛 IllegalTransitionError
    assertCanTransition(ret.status, 'filed');
    const clean = assertManualFilingRecord(record);
    assertNoAutoSubmission();

    const at = this.clock();
    const previous = ret.manualFiling;
    let reason: string;
    if (ret.status === 'filed' && previous !== undefined) {
      reason =
        `人工申报回填（补录/更正）：原回执号 ${previous.receiptNo}，` +
        `原缴款 ${formatYuan(previous.paidAmount)} 元，原回填人 ${previous.actor}`;
    } else {
      reason =
        `人工已在电子税务局完成申报，回填受理回执号 ${clean.receiptNo}，` +
        `实缴 ${formatYuan(clean.paidAmount)} 元`;
    }
    if (clean.paidAmount !== ret.due) {
      reason +=
        `；实缴与应补(退)税额 ${formatYuan(ret.due)} 元相差 ${formatYuan(clean.paidAmount - ret.due)} 元，已如实记录`;
    }

    ret.manualFiling = clean;
    applyTransition(ret, 'filed', { actor: clean.actor, at, reason });
    return structuredClone(ret);
  }

  /**
   * 作废：任何状态都可以作废，但必须写明理由，且不删除任何数据。
   *
   * 为什么 actor 叫「作废批准人」？因为作废一张已审批的申报表等于推翻一次审批，
   * 必须由有权限的人批准，事件流里要能一眼看出是谁拍的板。
   */
  void(id: string, actor: string, reason: string): TaxReturn {
    const ret = this.mustGet(id);
    const who = normalizeActor(actor, '作废批准人');
    const why = normalizeReason(reason, '作废理由', this.config.minVoidReasonLength);
    if (!this.config.allowVoidAfterFiled && ret.status === 'filed') {
      throw new FilingGuardError(
        '配置禁止对「已申报」的申报表作废（workflow.allowVoidAfterFiled = false）。' +
          '已申报的申报表如需更正，应在电子税务局办理更正申报，而不是在系统里作废。',
      );
    }
    assertCanTransition(ret.status, 'void');
    const at = this.clock();
    applyTransition(ret, 'void', { actor: who, at, reason: why });
    return structuredClone(ret);
  }

  /** 取一张申报表（深拷贝）。 */
  get(id: string): TaxReturn {
    return structuredClone(this.mustGet(id));
  }

  /** 按期间 / 状态 / 税种筛选。 */
  list(filter: { period?: Period; status?: FilingStatus; taxType?: TaxType } = {}): TaxReturn[] {
    const result: TaxReturn[] = [];
    for (const ret of this.records.values()) {
      if (filter.period !== undefined && ret.period !== filter.period) continue;
      if (filter.status !== undefined && ret.status !== filter.status) continue;
      if (filter.taxType !== undefined && ret.taxType !== filter.taxType) continue;
      result.push(structuredClone(ret));
    }
    result.sort((a, b) => {
      if (a.period !== b.period) return a.period.localeCompare(b.period);
      if (a.taxType !== b.taxType) return a.taxType.localeCompare(b.taxType);
      return a.id.localeCompare(b.id);
    });
    return result;
  }

  /** 待办列表：每张未终结的申报表下一步该谁做什么。 */
  pendingActions(): FilingPendingAction[] {
    const result: FilingPendingAction[] = [];
    for (const ret of this.records.values()) {
      const next = nextActionOf(ret.status);
      if (next === null) continue;
      result.push({
        id: ret.id,
        taxType: ret.taxType,
        period: ret.period,
        status: ret.status,
        action: next.action,
        assigneeRole: next.role,
      });
    }
    result.sort((a, b) => {
      if (a.period !== b.period) return a.period.localeCompare(b.period);
      return a.id.localeCompare(b.id);
    });
    return result;
  }

  /* ---------------------------------------------------------------- */

  private mustGet(id: string): TaxReturn {
    const key = typeof id === 'string' ? id.trim() : '';
    if (key === '') throw new FilingWorkflowError('申报表 id 不能为空');
    const found = this.records.get(key);
    if (found === undefined) {
      throw new FilingWorkflowError(`未找到申报表「${key}」。请先用 registerDraft() 登记。`);
    }
    return found;
  }

  /**
   * 校验签署携带的指纹。
   *
   * 为什么签名类型里没有 payloadHash，这里还要查？
   * 因为 UI 往往是「把屏幕上显示的那一版指纹连同签名一起提交」。
   * 如果提交瞬间记录已经变了，服务端必须拒绝——这正是「签的不是算的那份」。
   */
  private resolveHash(
    signature: Omit<Signature, 'payloadHash'>,
    ret: TaxReturn,
    label: string,
    actor: string,
  ): string {
    const claimed = (signature as unknown as Record<string, unknown>)['payloadHash'];
    if (typeof claimed === 'string' && claimed !== ret.payloadHash) {
      recordFilingGuardAudit(
        'signature_rejected',
        `申报表 ${ret.id} 的${label}签署携带旧指纹 ${claimed.slice(0, 12)}…`,
        actor,
      );
      throw new StaleSignatureError(
        `${label}签署携带的计算指纹 ${claimed.slice(0, 12)}… 与当前内容 ${ret.payloadHash.slice(0, 12)}… 不一致：` +
          '你签署的那一版已经被重新计算过了，请刷新后重新核对再签。',
      );
    }
    return ret.payloadHash;
  }
}

/* ------------------------------------------------------------------ */
/* 便捷再导出：让调用方可以从 workflow.ts 一次拿全                      */
/* ------------------------------------------------------------------ */

export { loadFilingConfig, defaultFilingConfig, FILING_DECLARATION } from './guard.ts';
export type { FilingConfig, FilingGuards } from './guard.ts';
