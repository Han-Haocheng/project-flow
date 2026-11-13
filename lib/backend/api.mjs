// lib/backend/api.mjs — 后端单一 API 层（T-20261112154526）。
//
// 纪律（迁移期必须守）：
// - adapter（lib/cli/**、lib/tools/**、lib/mcp/**、index.js、lib/host/**）只 import 本文件；
//   本文件是这些 adapter 在 lib/ 下唯一 import lib/core.mjs 的入口。
// - 只做「按命名空间转发」：签名与 core 相同（root, contract, ...），返回 core 的原始
//   记录/投影，错误原样抛（FlowError 的 code 决定 bin:511 的退出码映射），
//   不做 DTO/信封/缓存/日志。
// - 一次调用 = 一次锁：锁与校验仍在 core 各函数内部；本层绝不跨调用持有锁
//   （withLock 不可重入，包事务会死锁或把 gate 执行时间算进锁）。
// - warnings 单通道：drainWarnings 直接转发 core，不自建缓冲（否则 warning 会丢/重复）。
//
// 两个域模块 import 是「core 没有 re-export」的最小补口（验收投影 / intent 恢复），
// 迁移完成后如果 core 补了导出，应改回 core 并删掉这两行。
import * as core from '../core.mjs'
import { acceptancePlan, recordTaskVerification, verificationStateOf } from '../tasks/records.mjs'
import { listIntents, recoverIntents } from '../tasks/intents.mjs'

/**
 * 台账是否已初始化：判据与 core.assertInitialized 完全一致（契约文件存在），
 * 只是把 `usage` 错误折叠成布尔值供只读命令做分支；其它错误照原样抛。
 * @param {string} root
 * @returns {boolean}
 */
/** 与 core 同一个 FlowError 类（adapter 的 `instanceof` 判定不能换成副本）。 */
export const FlowError = core.FlowError

export function initialized(root) {
  try {
    core.assertInitialized(root)
    return true
  } catch (error) {
    if (error instanceof core.FlowError && error.code === 'usage') return false
    throw error
  }
}

/** 契约、初始化与只读聚合。 */
export const contract = Object.freeze({
  loadContract: core.loadContract,
  assertInitialized: core.assertInitialized,
  initialized,
  storePaths: core.storePaths,
  initProject: core.initProject,
  resolveProjectRoot: core.resolveProjectRoot,
  readStoreState: core.readStoreState,
})

/** 诊断通道：与 core 同一个收集器，只转发不缓存。 */
export const warnings = Object.freeze({
  drainWarnings: core.drainWarnings,
  noteWarning: core.noteWarning,
})

/** 任务域：读投影 + 写入口（写函数的锁在 core 内）。 */
export const tasks = Object.freeze({
  listTasks: core.listTasks,
  getTask: core.getTask,
  addTask: core.addTask,
  updateTask: core.updateTask,
  removeTask: core.removeTask,
  archiveTasks: core.archiveTasks,
  sweepUtteranceTasks: core.sweepUtteranceTasks,
  normalizeTaskFormat: core.normalizeTaskFormat,
  normalizeOwnerInput: core.normalizeOwnerInput,
  normalizeParentInput: core.normalizeParentInput,
  taskRevisionOf: core.taskRevisionOf,
  acceptancePlan,
  verificationStateOf,
  recordTaskVerification,
  TASK_TYPES: core.TASK_TYPES,
})

/** 多步写 saga 的补偿扫描（只由写子命令入口调用，不进 updateTask）。 */
export const intents = Object.freeze({
  recoverIntents,
  listIntents,
})

/** 门禁域：定义/运行/日志（runGate 的步骤执行在锁外，只有日志写取锁）。 */
export const gates = Object.freeze({
  listGates: core.listGates,
  getGate: core.getGate,
  listGateRuns: core.listGateRuns,
  addGate: core.addGate,
  updateGate: core.updateGate,
  removeGate: core.removeGate,
  runGate: core.runGate,
  runGatesByPhase: core.runGatesByPhase,
})

/** 实验域。 */
export const experiments = Object.freeze({
  listExperiments: core.listExperiments,
  getExperiment: core.getExperiment,
  experimentTree: core.experimentTree,
  reviewExperimentRecord: core.reviewExperimentRecord,
  addExperiment: core.addExperiment,
  updateExperiment: core.updateExperiment,
  removeExperiment: core.removeExperiment,
  productizeExperiment: core.productizeExperiment,
  cleanupExperiment: core.cleanupExperiment,
})

/** 决策域。 */
export const decisions = Object.freeze({
  listDecisions: core.listDecisions,
  getDecision: core.getDecision,
  summarizeDecisions: core.summarizeDecisions,
  addDecision: core.addDecision,
  answerDecision: core.answerDecision,
  withdrawDecision: core.withdrawDecision,
  gcDecisions: core.gcDecisions,
})

/** 心跳域（存活判定与读写同一口径）。 */
export const heartbeats = Object.freeze({
  heartbeatStatus: core.heartbeatStatus,
  resolveHeartbeatWorkspace: core.resolveHeartbeatWorkspace,
  readHeartbeatSection: core.readHeartbeatSection,
  startHeartbeat: core.startHeartbeat,
  updateHeartbeat: core.updateHeartbeat,
  endHeartbeat: core.endHeartbeat,
  removeHeartbeat: core.removeHeartbeat,
  gcLegacyHeartbeats: core.gcLegacyHeartbeats,
})

/** 描述台账域。 */
export const description = Object.freeze({
  getDescriptionFile: core.getDescriptionFile,
  readDescriptionProject: core.readDescriptionProject,
  descriptionStatus: core.descriptionStatus,
  buildDescription: core.buildDescription,
  renderDescription: core.renderDescription,
  listDescriptionFiles: core.listDescriptionFiles,
  setDescriptionProject: core.setDescriptionProject,
  setDescriptionFile: core.setDescriptionFile,
  getDescriptionPlan: core.getDescriptionPlan,
  setDescriptionPlan: core.setDescriptionPlan,
  applyDescriptionPlan: core.applyDescriptionPlan,
})

/** `flow check` 的内置只读检查（路由到 core 的检查实现）。 */
export const checks = Object.freeze({
  checkDecisions: core.checkDecisions,
  checkExperiments: core.checkExperiments,
  checkDescription: core.checkDescription,
})

/** 门禁步骤执行（verify 的 cmd 步骤）。 */
export const runner = Object.freeze({
  runStep: core.runStep,
})

/** 描述台账的 enforce 模式清单（desc status 展示用，与 core 同一数组）。 */
export const DESCRIPTION_ENFORCE_MODES = core.DESCRIPTION_ENFORCE_MODES

/** 任务类型清单（bin 的 coreRef 注入在切片 3 收掉前，CLI 直接取这里）。 */
export const TASK_TYPES = core.TASK_TYPES

/** 合并视图：命名空间与本地变量重名的文件（如 misc 的 `let tasks`）用 `api.tasks.x` 访问。 */
export const api = Object.freeze({ contract, warnings, tasks, intents, gates, experiments, decisions, heartbeats, description, checks, runner })
