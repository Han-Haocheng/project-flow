// lib/backend/api.mjs — 后端单一 API 层（T-20261112154526 切片 1）。
//
// 纪律（迁移期必须守，切片 2/3 只加接口不改规则）：
// - adapter（lib/cli/**、lib/tools/**、lib/mcp/**、index.js、lib/host/**）只 import 本文件；
//   本文件是这些 adapter 在 lib/ 下唯一 import lib/core.mjs 的入口。
// - 本层只做「按命名空间转发」：签名与 core 相同（root, contract, ...），返回 core 的原始
//   记录/投影，错误原样抛（FlowError 的 code 决定 bin:511 的退出码映射），
//   不做 DTO/信封/缓存/日志。
// - 一次调用 = 一次锁：锁与校验仍在 core 各函数内部；本层绝不跨调用持有锁
//   （withLock 不可重入，包事务会死锁或把 gate 执行时间算进锁）。
// - warnings 单通道：drainWarnings 直接转发 core，不自建缓冲（否则 warning 会丢/重复）。
//
// 本片只暴露 lib/cli/check.mjs 与 lib/cli/state.mjs 实际用到的接口，外加
// TASK_TYPES / drainWarnings / assertInitialized / initialized / storePaths / loadContract。
// gates / experiments / heartbeats / description / runner 等命名空间在首次出现调用点的
// 切片里再加，不预埋空壳。
import * as core from '../core.mjs'

/**
 * 台账是否已初始化：判据与 core.assertInitialized 完全一致（契约文件存在），
 * 只是把 `usage` 错误折叠成布尔值供只读命令做分支；其它错误照原样抛。
 * @param {string} root
 * @returns {boolean}
 */
export function initialized(root) {
  try {
    core.assertInitialized(root)
    return true
  } catch (error) {
    if (error instanceof core.FlowError && error.code === 'usage') return false
    throw error
  }
}

/** 契约与初始化（loadContract 原样带回 warnings；initialized 是本层唯一的组合判断）。 */
export const contract = Object.freeze({
  loadContract: core.loadContract,
  assertInitialized: core.assertInitialized,
  storePaths: core.storePaths,
  initialized,
})

/** 诊断通道：与 core 同一个收集器，只转发不缓存。 */
export const warnings = Object.freeze({
  drainWarnings: core.drainWarnings,
  noteWarning: core.noteWarning,
})

/** 任务域读面（写函数在切片 2 迁入）。 */
export const tasks = Object.freeze({
  listTasks: core.listTasks,
  normalizeTaskFormat: core.normalizeTaskFormat,
})

/** 决策域读面（check decisions 的修复提示要读记录）。 */
export const decisions = Object.freeze({
  getDecision: core.getDecision,
})

/** `flow check` 的内置只读检查（路由到 core 的检查实现）。 */
export const checks = Object.freeze({
  checkDecisions: core.checkDecisions,
  checkExperiments: core.checkExperiments,
  checkDescription: core.checkDescription,
})

/** 任务类型清单（cli/tasks.mjs 目前从 coreRef 取，切片 2 改走这里）。 */
export const TASK_TYPES = core.TASK_TYPES
