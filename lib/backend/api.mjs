// lib/backend/api.mjs — 后端单一 API 层（T-20261112154526 / 软加载 T-20261113125709）。
//
// 纪律：
// - adapter（lib/cli/**、lib/tools/**、lib/mcp/**、index.js、lib/host/**）只 import 本文件；
//   本文件是这些 adapter 在 lib/ 下唯一 import lib/core.mjs 的入口。
// - 只做「按命名空间转发」：签名与 core 相同（root, contract, ...），返回 core 的原始
//   记录/投影，错误原样抛（FlowError 的 code 决定 bin 的退出码映射），不做 DTO/信封/缓存。
// - 一次调用 = 一次锁：锁与校验仍在 core 各函数内部；本层绝不跨调用持有锁
//   （withLock 不可重入，包事务会死锁或把 gate 执行时间算进锁）。
// - warnings 单通道：drainWarnings 直接转发 core，不自建缓冲（否则 warning 会丢/重复）。
//
// 软加载（T-20261113125709）：core.mjs 用**字面量动态 import**（顶层 await）加载——
// 正常安装下与原来的静态 import 完全等价（成员仍是 core 的原函数引用）；core 缺失或
// 加载失败时本模块仍可被 import，命名空间成员退化为 throwing stub，调用时抛出与
// lib/state-snapshot.mjs 同一条文案的可读错误，而不是让整个插件在 import 阶段崩掉。
// 降级语义（测试锁定）：
//   - 读常量/诊断不抛：TASK_TYPES=[]、DESCRIPTION_ENFORCE_MODES=[]、drainWarnings()=[]、
//     noteWarning()=no-op、initialized()=false；
//   - 其余成员（含 FlowError 兜底类）调用即抛 `code:'io'` 的 FlowError 形状错误。
// 两个 core 加载器（本文件与 state-snapshot 的 CORE_URL）并存是已知取舍：同一模块实例，
// 失败时文案保持一致。core 没有 re-export 的域函数仍直接从域模块取（最小补口）。
import { acceptancePlan, recordTaskVerification, verificationStateOf } from '../tasks/records.mjs'
import { listIntents, recoverIntents } from '../tasks/intents.mjs'

let core = null
let coreFailure = ''
try {
  core = await import('../core.mjs')
} catch (error) {
  coreFailure = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
}
const CORE_AVAILABLE = core !== null && typeof core === 'object'

/** 与旧 state-snapshot.requireCore 逐字一致；同一条链上只此一套文案。 */
const CORE_UNAVAILABLE_MESSAGE =
  'project flow core is not installed (lib/core.mjs could not be loaded); reinstall the project-flow plugin or use the CLI: node bin/flow.mjs'

class CoreUnavailableFlowError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FlowError'
    this.code = code
  }
}

/** 与 core 同一个 FlowError 类（adapter 的 `instanceof` 判定不能换成副本）；缺失时用兜底类。 */
export const FlowError = CORE_AVAILABLE ? core.FlowError : CoreUnavailableFlowError

function coreUnavailable() {
  const error = new FlowError('io', CORE_UNAVAILABLE_MESSAGE)
  if (coreFailure !== '') error.cause = coreFailure
  return error
}

/** core 原函数引用；缺失时返回调用即抛的 stub（同一成员表驱动，不手写）。 */
function member(name) {
  if (CORE_AVAILABLE && typeof core[name] === 'function') return core[name]
  return () => {
    throw coreUnavailable()
  }
}

function members(names) {
  return Object.fromEntries(names.map((name) => [name, member(name)]))
}

function unavailableWarningsDrain() {
  return []
}

function noopNoteWarning() {}

/** 降级可读常量：空表（只读路径可安全遍历；写入口不会因此静默成功，它们会先抛）。 */
const TASK_TYPES_VALUE = CORE_AVAILABLE ? core.TASK_TYPES : Object.freeze([])
const DESCRIPTION_ENFORCE_MODES_VALUE = CORE_AVAILABLE ? core.DESCRIPTION_ENFORCE_MODES : Object.freeze([])

/**
 * 台账是否已初始化：判据与 core.assertInitialized 完全一致（契约文件存在），
 * 只是把 `usage` 错误折叠成布尔值供只读命令做分支；其它错误照原样抛。
 * 降级（core 缺失）直接返回 false——这是可读的状态而不是又一个错误。
 * @param {string} root
 * @returns {boolean}
 */
export function initialized(root) {
  if (CORE_AVAILABLE === false) return false
  try {
    core.assertInitialized(root)
    return true
  } catch (error) {
    if (error instanceof FlowError && error.code === 'usage') return false
    throw error
  }
}

const CONTRACT_MEMBERS = ['loadContract', 'assertInitialized', 'storePaths', 'initProject', 'resolveProjectRoot', 'readStoreState', 'gitBranchOf']
const TASK_MEMBERS = [
  'listTasks', 'getTask', 'addTask', 'updateTask', 'removeTask',
  'archiveTasks', 'sweepUtteranceTasks', 'releaseDeadSessionTasks',
  'normalizeTaskFormat', 'normalizeOwnerInput', 'normalizeParentInput', 'taskRevisionOf',
]
const GATE_MEMBERS = ['listGates', 'getGate', 'listGateRuns', 'addGate', 'updateGate', 'removeGate', 'runGate', 'runGatesByPhase']
const EXPERIMENT_MEMBERS = [
  'listExperiments', 'getExperiment', 'experimentTree', 'reviewExperimentRecord',
  'addExperiment', 'updateExperiment', 'removeExperiment', 'productizeExperiment', 'cleanupExperiment',
]
const DECISION_MEMBERS = ['listDecisions', 'getDecision', 'summarizeDecisions', 'addDecision', 'answerDecision', 'withdrawDecision', 'gcDecisions', 'purgeArchivedDecisions']
const HEARTBEAT_MEMBERS = [
  'heartbeatStatus', 'resolveHeartbeatWorkspace', 'readHeartbeatSection',
  'startHeartbeat', 'updateHeartbeat', 'endHeartbeat', 'removeHeartbeat', 'gcLegacyHeartbeats',
]
const DESCRIPTION_MEMBERS = [
  'getDescriptionFile', 'readDescriptionProject', 'descriptionStatus', 'buildDescription', 'renderDescription',
  'listDescriptionFiles', 'setDescriptionProject', 'setDescriptionFile',
  'getDescriptionPlan', 'setDescriptionPlan', 'applyDescriptionPlan',
]
const CHECK_MEMBERS = ['checkDecisions', 'checkExperiments', 'checkDescription']
const RUNNER_MEMBERS = ['runStep']

/** 契约、初始化与只读聚合。 */
export const contract = Object.freeze({ ...members(CONTRACT_MEMBERS), initialized })

/** 诊断通道：与 core 同一个收集器，只转发不缓存；降级时不抛（见头注释策略）。 */
export const warnings = Object.freeze({
  drainWarnings: CORE_AVAILABLE && typeof core.drainWarnings === 'function' ? core.drainWarnings : unavailableWarningsDrain,
  noteWarning: CORE_AVAILABLE && typeof core.noteWarning === 'function' ? core.noteWarning : noopNoteWarning,
})

/** 任务域：读投影 + 写入口（写函数的锁在 core 内）；降级时写入口调用即抛。 */
export const tasks = Object.freeze({
  ...members(TASK_MEMBERS),
  acceptancePlan,
  verificationStateOf,
  recordTaskVerification,
  TASK_TYPES: TASK_TYPES_VALUE,
})

/** 多步写 saga 的补偿扫描（域模块自带，不依赖 core 加载）。 */
export const intents = Object.freeze({ recoverIntents, listIntents })

/** 门禁域：定义/运行/日志（runGate 的步骤执行在锁外，只有日志写取锁）。 */
export const gates = Object.freeze(members(GATE_MEMBERS))

/** 实验域。 */
export const experiments = Object.freeze(members(EXPERIMENT_MEMBERS))

/** 决策域。 */
export const decisions = Object.freeze(members(DECISION_MEMBERS))

/** 心跳域（存活判定与读写同一口径）。 */
export const heartbeats = Object.freeze(members(HEARTBEAT_MEMBERS))

/** 描述台账域。 */
export const description = Object.freeze(members(DESCRIPTION_MEMBERS))

/** `flow check` 的内置只读检查（路由到 core 的检查实现）。 */
export const checks = Object.freeze(members(CHECK_MEMBERS))

/** 门禁步骤执行（verify 的 cmd 步骤）。 */
export const runner = Object.freeze(members(RUNNER_MEMBERS))

/** 描述台账的 enforce 模式清单（与 core 同一数组；降级为空表）。 */
export const DESCRIPTION_ENFORCE_MODES = DESCRIPTION_ENFORCE_MODES_VALUE

/** 任务类型清单（与 core 同一数组；降级为空表）。 */
export const TASK_TYPES = TASK_TYPES_VALUE

/** 合并视图：命名空间与本地变量重名的文件（如 misc 的 `let tasks`）用 `api.tasks.x` 访问。 */
export const api = Object.freeze({ contract, warnings, tasks, intents, gates, experiments, decisions, heartbeats, description, checks, runner })
