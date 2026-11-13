// project-flow — 任务域（tasks 模块，2026-11-11 Phase 1 拆分）。
//
// 任务记录、九阶段投影、父/owner 校验、归档与清扫。依赖方向：tasks → store
// （records/contract）+ heartbeats（只读状态）+ util，**不 import core**。
//
// 与描述域的唯一耦合（updateTask 的语义门）通过 configureTasks({ descriptionGate })
// 注入：core 在装配时传入 assertDescriptionGate，避免 tasks ↔ description 成环。
// 实验辅助 createsCycle / warnTaskExperiment 也在这里定义：它们本来就是任务
// 父引用校验的一部分，实验域反过来从这里 import（实验本来就依赖任务）。

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { pathMemoOf } from '../paths.mjs'

import { writeJsonAtomic } from '../atomic.mjs'
import { FlowError, deepClone, formatIso, invalid, isPlainObject, noteWarning, toPosix } from '../util.mjs'
import { DAY_MS, TASK_ARCHIVE_MAX_DAYS, assertInitialized, normalizeContract, storePaths, withLock } from '../store/contract.mjs'
import {
  DECISION_ID_RE,
  REF_ID_RE,
  assertPattern, assertSafeId, assertTargetFree, nextTaskId, optionalBoolean, optionalEnum, optionalInt,
  optionalText, readCollection, readRecord, requireText, sortByCreatedAsc, sortByUpdatedDesc, stringArray, unreadableCollector,
} from '../store/records.mjs'
import { heartbeatStatus } from '../heartbeats/records.mjs'
import { STAGE_IDS, assertTransition, legacyStageFromStatus, stageToStatus } from '../stage.mjs'

/** 由 core 注入的跨域能力（描述门）。 */
/** Task ids: legacy `T-YYYYMMDD-NN` or the timestamp form `T-YYYYMMDDHHMMSS[-NN]` (T-08 B1). */
const TASK_ID_RE = /^T-(?:\d{8}-\d{2}|\d{14}(?:-\d{2})?)$/
/** Id shape accepted for cross-record references (`parent`). */

/** Conventional-commit task types; `addTask` requires one (T-15). */
export const TASK_TYPES = Object.freeze([
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci',
])

export const TASK_STATUS = ['draft', 'active', 'done', 'archived', 'cancelled']

const TASK_DEFAULTS = {
  /** Required on add; nullable only for legacy records read from disk. */
  type: null,
  status: 'draft',
  /** Optional parent task id (`TASK parent`); null = root (T-13). */
  parent: null,
  owner: '',
  scope: { allow: [], deny: [] },
  acceptance: [],
  checkpoints: [],
  commits: [],
  notes: '',
  /** 撤销原因（T-20261113163505）：非空才允许进入 cancelled。 */
  cancelReason: '',
  cancelled_at: null,
  /** 合并去向（源卡撤销时指向目标卡）；预留字段，不在普通 update 白名单。 */
  mergedInto: null,
}

/**
 * Keys `addTask` accepts. `goal` is **not** one of them: it was merged into
 * `title`, so an unknown key is rejected instead of silently dropped (that
 * would swallow data). Legacy records still carry a `goal` key on disk — the
 * read path returns it untouched and `normalizeTaskFormat()` migrates it.
 */
const TASK_CREATE_KEYS = Object.freeze([
  'id', 'title', 'type', 'status', 'owner', 'notes', 'commits', 'scope',
  'acceptance', 'checkpoints', 'experiment', 'parent', 'stage', 'source', 'team',
  'veto', 'decision', 'created_at', 'updated_at', 'done_at', 'archived_at',
  'cancelReason', 'cancelled_at', 'mergedInto', 'mount',
])

/**
 * Task identity: a patch may not change these. `id`/`schema`/`created_at` are
 * the record's key (the ledger, `parent` links, `decisions.blocks` and the
 * heartbeat `task` field all reference them); `title`/`type` were added once
 * `type` became a required enum — a task's title *is* its identity, and a
 * history whose `type` can drift makes per-type totals meaningless.
 *
 * The one and only exception is `normalizeTaskFormat()` (internal, below),
 * which migrates legacy records; `updateTask` has no exceptions.
 */
const TASK_IMMUTABLE_KEYS = Object.freeze(['id', 'schema', 'created_at', 'title', 'type'])

/**
 * Explicit updatable whitelist. `applyTaskPatch` is the single interception
 * point: the CLI and the `flow_*` tools pass `title`/`type` through so both ends
 * report the same `invalid: task <key> cannot be changed`, never two shapes.
 */
const TASK_UPDATABLE_KEYS = Object.freeze([
  'status', 'stage', 'owner', 'notes', 'commits', 'scope', 'acceptance', 'experiment', 'parent', 'mount',
  /* P4: `decision` is set when a main task is vetoed and cleared by the user's
     answer; `veto` may be recorded after creation (`flow_veto`), but is never
     cleared — the veto history survives `modify`. */
  'veto', 'decision',
  /* 汇总轮标记（`'aggregate'`，T-20261111170544）：`flow_subtask` 的父子聚合把它和
     `stage: 'queued-analysis'` 一起写进父任务，派工器据此走 `normalizeTask` 边。
     它是一次普通的台账写，所以留在 updatable 白名单；工具层字段白名单
     （`lib/plugin/shared.mjs`）里没有它，会话不能手写"我在汇总轮"。父任务被推进到
     done/archived 时由 `finishAggregateRound` 清除。 */
  'dispatchRound',
  /* P3b (task-83): the Team-board link is writable **only** through
     `lib/team-sync.mjs`'s `linkTask`/`unlinkTask` (CLI `task link|unlink`).
     It is on this list because the core patch path is the single writer; it is
     NOT on the tool whitelist, so a session cannot rewrite the link. */
  'team',
])

/**
 * System-maintained keys: accepted on a patch because the write path owns them
 * (`updated_at` is refreshed by every patch, `done_at`/`archived_at` by
 * `stampTaskTimes`). `checkpoints` stays writable for backward compatibility —
 * this card does not tighten it (see CONTRACT §3.2).
 */
const TASK_SYSTEM_KEYS = Object.freeze([
  'updated_at', 'done_at', 'archived_at', 'checkpoints',
  /* 撤销/合并（T-20261113163505）：系统维护，普通 update 没有这些参数。 */
  'cancelReason', 'cancelled_at', 'mergedInto',
  /* 派工工单（T-20261113155234）：只由 dispatch-* 命令写，普通 update 不可见。 */
  'dispatch',
  /* 验收回执（`flow task verify`）：最近一次机器验证的结论摘要。系统维护——
     `lib/tools/*.mjs` 的字段白名单里没有它，会话只能通过 `flow task verify`
     （或这里导出的 `recordTaskVerification`）写入，避免手写一份"我验过了"。 */
  'verification',
  /* 交接产物（flow task art put / release --file）：只存指针与摘要，正文落
     .agents/reports/<task-id>/。系统键——普通 task update 没有该参数。 */
  'artifacts',
])


let HOOKS = { descriptionGate: null, experimentIds: null }

export function configureTasks(hooks) {
  const input = isPlainObject(hooks) ? hooks : {}
  if (typeof input.descriptionGate === 'function') HOOKS.descriptionGate = input.descriptionGate
  if (typeof input.experimentIds === 'function') HOOKS.experimentIds = input.experimentIds
}

export function createsCycle(node, parentId, byId) {
  const seen = new Set([node.id])
  let cursor = parentId
  while (typeof cursor === 'string' && cursor !== '') {
    if (seen.has(cursor)) return true
    seen.add(cursor)
    const parent = byId.get(cursor)
    if (parent === undefined) return false
    cursor = parent.parent
  }
  return false
}

export function warnTaskExperiment(record, paths) {
  if (typeof record.experiment !== 'string' || record.experiment === '') return
  try {
    if (HOOKS.experimentIds(paths).has(record.experiment) === false) {
      noteWarning(`task-experiment-missing: ${record.id}: ${record.experiment}`)
    }
  } catch {
    // The link check is advisory; a read failure must not fail the write.
  }
}

// --------------------------------------------------- 可执行验收与验证回执
//
// `task.acceptance` 历史上只有自由文本（人读的验收标准）。本卡让它也能被**机器执行**，
// 因为用户的目标是「怎么验证」由机器直接给出、而不是让模型读散文后自己推理。
//
// 两种规范形态（字符串前缀，CLI/工具都能一眼写对）：
//   "cmd:<shell 命令>"   → 跑一条 shell（退出码 0 通过）
//   "gate:<gateId>"      → 跑一个门禁（`lib/gates` 的 runGate；ok=true 通过）
//
// 另有两种**兼容形态**（对象；面板/`state-snapshot` 早已识别 `{cmd, expect}` 这种
// 旧记录形状，这里顺势把它们也当可执行，避免老台账要重写一遍）：
//   {cmd: "…", expect?: "exit 0"|"contains: TEXT", timeoutSeconds?: N}
//   {gate: "gateId"}
//
// 其余条目（自由文本）**永远不算可执行**：既有台账有大量中文验收句子，把它们当
// 「执行失败的验收」会让阶段门当场炸掉。可执行条目为 0 时的策略见
// {@link acceptancePolicyOf}（默认只警告）。
//
// 回执写在任务的 `verification` 字段（不是 `checkpoints`）：
// `checkpoints` 已被 `state-snapshot.lastCheckpointGate()`、派工回执与面板共用，
// 往里追加验证条目会静默改变"最后一条 checkpoint 的 gate 徽标"这一投影。新增
// `verification` 字段对老记录零影响（没跑过 verify 就没有这个键）。

/** 规范形态的两个字符串前缀（只认小写，正文里的 "CMD:" 不算命令）。 */
export const ACCEPTANCE_CMD_PREFIX = 'cmd:'
export const ACCEPTANCE_GATE_PREFIX = 'gate:'

/** 进入这两个阶段前必须有通过的验收（`reviewing`/`done` 是 judgement 边）。 */
export const ACCEPTANCE_GATE_STAGES = Object.freeze(['reviewing', 'done'])

/**
 * 派工回执（claim）协议：角色、结局与角色对应的工作阶段。
 *
 * 回执写在任务 `checkpoints` 里（与 `lib/dispatch.mjs` 的派工回执同一处）：
 * - `kind: 'claim'`：`flow task claim` 写的 **open** 回执，必须由 `flow task release`
 *   显式关闭（写 `closedAt` + `outcome`）；
 * - `kind: 'dispatch'`：插件派工写的回执（`lib/dispatch.mjs`）；它没有 agent 字段，
 *   所以在对应推进边（实现收口/审查收口）由本模块**自动收口**（补 `closedAt` /
 *   `outcome:'ok'`），不需要另一个域先改派工器。
 *
 * 阶段门只把「没有显式 claim 历史」的老卡当 legacy：写一条 warning 后放行一次；
 * 一旦卡上有 `kind:'claim'`，后续每条边都必须按下面的硬校验闭合。
 */
export const CLAIM_ROLES = Object.freeze(['analyzer', 'implementer', 'reviewer'])
export const CLAIM_OUTCOMES = Object.freeze(['ok', 'aborted'])
/** 派工工单（T-20261113155234 阶段 1）：结局、attempt 上限、默认租约。 */
export const DISPATCH_ORDER_OUTCOMES = Object.freeze(['ok', 'failed', 'expired'])
export const DISPATCH_ATTEMPT_MAX = 3
export const DISPATCH_TTL_SECONDS = 600
export const DISPATCH_TTL_MAX_SECONDS = 3600
/**
 * claim 协议切换点：**在这个时间点之前创建的卡**才视为 legacy。
 *
 * 首次通过派工门时写一条 {kind:'legacy-bypass'} 回执，之后该卡永远按硬门处理。
 * 不用「checkpoints 为空」判 legacy——新建卡也是空 checkpoints，那会让门禁对
 * 所有新卡永远只警告（评审必修 1）。
 *
 * 改这个常量 = 改历史迁移口径，必须同步 CONTRACT §3.2 与测试里的 backdate 夹具。
 */
export const LEGACY_CUTOFF_AT = '2026-11-13T17:00:00+08:00'
/** `LEGACY_CUTOFF_AT` 的毫秒投影：比较用，二者是同一时间点。 */
const LEGACY_CUTOFF_MS = Date.parse(LEGACY_CUTOFF_AT)
/** 旧名，保留给已经 build 过的描述台账成员表；等价于 LEGACY_CUTOFF_MS。 */
const CLAIM_PROTOCOL_SINCE = LEGACY_CUTOFF_MS
const LEGACY_BYPASS_KIND = 'legacy-bypass'
/** 角色 claim 的目标阶段（与 `lib/stage.mjs` 的 working 阶段一致）。 */
const CLAIM_WORKING_STAGE = Object.freeze({
  analyzer: 'analyzing',
  implementer: 'implementing',
  reviewer: 'reviewing',
})
/** 需要派工回执的三条阶段边（目标阶段）。 */
const DISPATCH_GATE_STAGES = Object.freeze(['implementing', 'queued-review', 'done'])

/**
 * 汇总轮（`analyzing → done`，T-20261111170544）的出发阶段。
 *
 * `source: 'aggregate'` 在**描述门**里直接豁免（汇总不产生新的语义变更，没有计划可
 * 看），在**验收门**里**没有任何降级**：父任务能收口到 done，就是它被判为完成，判据
 * 必须和 `reviewing → done` 完全一样——有可执行验收（`cmd:`/`gate:`）就要求
 * `verificationStateOf().passed`，否则抛 `invalid` 并给出 `flow task verify <id>`；
 * 没有可执行验收项时按 `tasks.requireAcceptance`（默认 warn）放行并留一条 warning。
 * 换句话说，「汇总轮」只换掉那条边，不放宽这道门。常量保留在这里是为了让两份门
 * 的豁免边界有同一个名字可引用。
 */
export const AGGREGATE_ENTRY_STAGE = 'analyzing'

/** 回执里步骤摘要的上限（条数 / 单条 tail 字符），防止一条长命令把记录撑爆。 */
const VERIFICATION_STEPS_MAX = 50
const VERIFICATION_TAIL_MAX = 400
/** 没有可执行验收项时的默认策略（contract 的 `tasks.requireAcceptance` 可覆盖）。 */
const ACCEPTANCE_POLICY_DEFAULT = 'warn'

/** 一个 acceptance 条目的可执行投影；不可执行返回 null（自由文本原样忽略）。 */
function parseAcceptanceEntry(entry) {
  if (typeof entry === 'string') {
    const text = entry.trim()
    if (text.startsWith(ACCEPTANCE_CMD_PREFIX)) {
      const run = text.slice(ACCEPTANCE_CMD_PREFIX.length).trim()
      return run === '' ? null : { kind: 'cmd', target: run, expect: 'exit 0', timeoutSeconds: null }
    }
    if (text.startsWith(ACCEPTANCE_GATE_PREFIX)) {
      const id = text.slice(ACCEPTANCE_GATE_PREFIX.length).trim()
      return id === '' ? null : { kind: 'gate', target: id, expect: '', timeoutSeconds: null }
    }
    return null
  }
  if (isPlainObject(entry) === false) return null
  const cmd = typeof entry.cmd === 'string' ? entry.cmd.trim() : ''
  if (cmd !== '') {
    return {
      kind: 'cmd',
      target: cmd,
      expect: typeof entry.expect === 'string' && entry.expect.trim() !== '' ? entry.expect.trim() : 'exit 0',
      timeoutSeconds: Number.isInteger(entry.timeoutSeconds) && entry.timeoutSeconds > 0 ? entry.timeoutSeconds : null,
    }
  }
  const gate = typeof entry.gate === 'string' ? entry.gate.trim() : ''
  if (gate !== '') return { kind: 'gate', target: gate, expect: '', timeoutSeconds: null }
  return null
}

/**
 * acceptance 的**执行计划**：按记录顺序列出可执行条目 + 当前清单的签名。
 *
 * 签名（16 位 sha256 前缀）是「验证记录还算不算数」的唯一判据：verification 里
 * 存的是验证那一刻的签名，阶段门把它和**当前** acceptance 重算的签名比对，不一致
 * = 验收被改过 = 记录过期。它只覆盖可执行条目（自由文本改动不影响验证有效性）。
 *
 * @returns {{steps: Array<{index:number,kind:'cmd'|'gate',target:string,
 *   expect:string,timeoutSeconds:number|null}>, signature: string, total: number}}
 */
export function acceptancePlan(task) {
  const list = isPlainObject(task) && Array.isArray(task.acceptance) ? task.acceptance : []
  const steps = []
  for (let index = 0; index < list.length; index += 1) {
    const parsed = parseAcceptanceEntry(list[index])
    if (parsed !== null) steps.push({ index, ...parsed })
  }
  return { steps, signature: acceptanceSignature(steps), total: list.length }
}

function acceptanceSignature(steps) {
  if (steps.length === 0) return ''
  const material = steps
    .map((step) => `${step.kind}\u0000${step.target}\u0000${step.expect}\u0000${step.timeoutSeconds ?? ''}`)
    .join('\u0001')
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/**
 * 任务当前的验收状态（纯读投影，不写盘）：多少个可执行项、最近一次验证的结论，
 * 以及那份结论**对当前 acceptance 是否还有效**（`fresh`）。
 *
 * `passed` 是阶段门唯一认的字段：`fresh && ok`。没有验证记录、验收为空、验收在
 * 验证之后被改过、上一次没过——四种情况都是 `passed: false`。
 */
export function verificationStateOf(task) {
  const plan = acceptancePlan(task)
  const raw = isPlainObject(task) && isPlainObject(task.verification) ? task.verification : null
  const counts = { cmd: 0, gate: 0 }
  for (const step of plan.steps) counts[step.kind] += 1
  const base = {
    executable: plan.steps.length,
    cmd: counts.cmd,
    gate: counts.gate,
    signature: plan.signature,
    at: null,
    ok: null,
    stage: null,
    fresh: false,
    passed: false,
    steps: [],
  }
  if (raw === null) return base
  const fresh =
    plan.steps.length > 0 && typeof raw.signature === 'string' && raw.signature !== '' && raw.signature === plan.signature
  return {
    ...base,
    at: typeof raw.at === 'string' ? raw.at : null,
    ok: raw.ok === true,
    stage: typeof raw.stage === 'string' ? raw.stage : null,
    fresh,
    passed: fresh && raw.ok === true,
    steps: Array.isArray(raw.steps) ? raw.steps : [],
  }
}

/**
 * 没有可执行验收项时的策略（contract 的 `tasks.requireAcceptance`）：
 *
 * - `'warn'`（默认；键缺省/取值非法都落到这里）：只记一条 warning，放行推进；
 * - `'strict'`：拒绝推进，要求先把验收写成 `cmd:` / `gate:`；
 * - `'off'`：不警告也不拦截（老项目整体迁移期用）。
 *
 * 它是一等契约键（2026-11-11 集成时加入 `defaultContract()`/`contractShapes()`），
 * `flow init` 会写出 `warn` 默认值；`sanitizeContract` 对非法值回退 `warn`。
 * 本函数仍对缺键兜底，读旧契约（没有该键）不会炸。
 */
export function acceptancePolicyOf(contract) {
  const raw = isPlainObject(contract) && isPlainObject(contract.tasks) ? contract.tasks.requireAcceptance : undefined
  if (raw === 'strict' || raw === 'off') return raw
  return ACCEPTANCE_POLICY_DEFAULT
}

/**
 * 验收门（`updateTask` 的唯一挂载点）：进入 `reviewing`/`done` 前必须有**通过的**
 * 机器验证。
 *
 * 语义顺序即豁免顺序：内部写（`source: 'internal'` 的插件收口/迁移）→ 非目标阶段 →
 * 幂等重写（`from === to`）→ 没有可执行验收项时按 {@link acceptancePolicyOf} 处理 →
 * 有可执行项则要求 `verificationStateOf().passed`。
 *
 * `source` 的语义（互不重叠，任何一种都不改变验收门的结构判定）：
 * - `'internal'`（插件的收口/迁移）：整体豁免，它不是语义完成；
 * - `'plugin'`（派工推进到 reviewing）：无可执行项照常按策略，未通过降级为警告；
 * - `'aggregate'`（汇总轮 `analyzing → done`）：**与 `'session'` 同档**，不放宽——
 *   父任务收口到 done 就是判它完成，探针必须一致（见 {@link AGGREGATE_ENTRY_STAGE}）；
 * - 其余（`'session'`/缺省）：严格判定，未通过即拒绝。
 *
 * 拒绝文案永远带下一步：`flow task verify <id>`。这是用户目标的核心——机器直接给
 * 命令，不让模型自己推断怎么补救。
 *
 * @param {object} contract flow contract（读 `tasks.requireAcceptance`）
 * @param {object} task 写入后的任务记录（内存对象；被拒时磁盘零残留）
 * @param {{source?: string, from?: string, to?: string}} [options]
 * @throws {FlowError} code=`invalid`
 */
export function assertAcceptanceGate(contract, task, options = {}) {
  const bag = isPlainObject(options) ? options : {}
  if (bag.source === 'internal') return
  const to = typeof bag.to === 'string' ? bag.to : ''
  if (ACCEPTANCE_GATE_STAGES.includes(to) === false) return
  const from = typeof bag.from === 'string' ? bag.from : ''
  if (from === to) return
  if (isPlainObject(task) === false || typeof task.id !== 'string' || task.id === '') return

  const state = verificationStateOf(task)
  const policy = acceptancePolicyOf(contract)
  if (state.executable === 0) {
    if (policy === 'off') return
    if (policy === 'strict') {
      throw invalid(
        `acceptance gate: ${to}: task ${task.id} 没有可执行验收项 — 把验收写成 cmd:<命令> 或 gate:<gateId> 后再推进` +
          `（或把 tasks.requireAcceptance 设为 warn/off）`,
      )
    }
    noteWarning(
      `task-acceptance-none: ${task.id}: 进入 ${to} 但没有可执行验收项（cmd:/gate:），这次推进没有机器验证`,
    )
    return
  }
  if (state.passed === true) return
  const why =
    state.at === null
      ? '还没有跑过验收'
      : state.fresh === false
        ? '验收记录已过期（acceptance 在验证之后被改过）'
        : '最近一次验收没有通过'
  // 插件派工（source=plugin）要把任务推进 reviewing 才能起审查者；此时硬拦会让
  // 带可执行验收项的任务卡在 queued-review（派工器不会自己跑 verify）。真正的
  // 判定点仍是 reviewing→done：那里必须已有通过记录。派工路径在这里只警告。
  if (bag.source === 'plugin' && to === 'reviewing') {
    noteWarning(`task-acceptance-unverified: ${task.id}: 派工进入 reviewing 时 ${why}；审查前建议先跑 flow task verify ${task.id}`)
    return
  }
  throw invalid(`acceptance gate: ${to}: task ${task.id} ${why} — 先运行 flow task verify ${task.id}`)
}

/** 回执 tail 的归一：只保留尾部（与 runner 的 tail 语义一致），统一换行。 */
function normalizeVerificationTail(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\r\n/g, '\n')
  return text.length > VERIFICATION_TAIL_MAX ? text.slice(-VERIFICATION_TAIL_MAX) : text
}

/**
 * `verification` 字段的写校验/归一。形状固定成
 * `{ok, at, stage, signature, steps[]}`，全部短字段，便于面板/CLI 直接展示。
 * 未知成员被丢弃（回执是机器事实，不是自由扩展点）。
 */
function validateVerificationField(record) {
  if (record.verification === undefined) return
  if (record.verification === null) {
    record.verification = null
    return
  }
  const raw = record.verification
  if (isPlainObject(raw) === false) throw invalid('verification must be an object or null')
  if (typeof raw.ok !== 'boolean') throw invalid('verification.ok must be a boolean')
  if (isStamp(raw.at) === false) throw invalid('verification.at must be a non-empty timestamp string')
  if (typeof raw.signature !== 'string' || raw.signature.trim() === '') {
    throw invalid('verification.signature must be a non-empty string')
  }
  const stage = raw.stage === undefined || raw.stage === null ? null : raw.stage
  if (stage !== null && (typeof stage !== 'string' || STAGE_IDS.includes(stage.trim()) === false)) {
    throw invalid(`verification.stage must be one of ${STAGE_IDS.join(', ')} or null`)
  }
  const steps = raw.steps === undefined || raw.steps === null ? [] : raw.steps
  if (Array.isArray(steps) === false) throw invalid('verification.steps must be an array')
  if (steps.length > VERIFICATION_STEPS_MAX) {
    throw invalid(`verification.steps must have at most ${VERIFICATION_STEPS_MAX} entries`)
  }
  record.verification = {
    ok: raw.ok,
    at: raw.at.trim(),
    stage: stage === null ? null : stage.trim(),
    signature: raw.signature.trim(),
    steps: steps.map((step, index) => {
      const label = `verification.steps[${index}]`
      if (isPlainObject(step) === false) throw invalid(`${label} must be an object`)
      if (step.kind !== 'cmd' && step.kind !== 'gate') throw invalid(`${label}.kind must be one of 'cmd', 'gate'`)
      const target = typeof step.target === 'string' ? step.target.trim() : ''
      if (target === '') throw invalid(`${label}.target must be a non-empty string`)
      if (typeof step.ok !== 'boolean') throw invalid(`${label}.ok must be a boolean`)
      const position = Number.isInteger(step.index) && step.index >= 0 ? step.index : index
      const entry = {
        index: position,
        kind: step.kind,
        target,
        ok: step.ok,
        exit: Number.isInteger(step.exit) ? step.exit : null,
        durationMs: Number.isFinite(step.durationMs) && step.durationMs >= 0 ? Math.round(step.durationMs) : 0,
      }
      const tail = normalizeVerificationTail(step.tail)
      if (tail !== '') entry.tail = tail
      return entry
    }),
  }
}

/**
 * 回填一次验证结果（`flow task verify` 的唯一写入口）。
 *
 * 签名由**调用方**给：它必须是被执行的那份 acceptance 的签名。这里若改成自己重算，
 * 验收在「读 → 跑」之间被改动时会写进一个与旧结果匹配的新签名——那会让阶段门把
 * 「跑的是旧清单」当成通过，是假绿。走调用方的签名，过期记录就天然对不上。
 *
 * @param {string} root project root
 * @param {object} contract flow contract
 * @param {string} id task id
 * @param {{ok: boolean, signature: string, steps?: object[]}} input 本次执行结果
 * @returns {object} 写入后的任务记录（读投影）
 */
export function recordTaskVerification(root, contract, id, input) {
  const value = isPlainObject(input) ? input : {}
  const signature = typeof value.signature === 'string' ? value.signature.trim() : ''
  if (signature === '') {
    throw invalid(`task ${id} 没有可执行验收项（acceptance 里没有 cmd:/gate:），不需要写验证回执`)
  }
  const current = getTask(root, contract, id)
  const record = {
    ok: value.ok === true,
    at: formatIso(),
    stage: typeof current.stage === 'string' ? current.stage : null,
    signature,
    steps: Array.isArray(value.steps) ? value.steps : [],
  }
  return updateTask(root, contract, id, { verification: record })
}

// ------------------------------------------------- task mount (2026-11-13 T-20261113165239)

/** 任务挂载的两种切片：module（模块）与 aspect（跨模块切片）。 */
export const TASK_MOUNT_KINDS = Object.freeze(['module', 'aspect'])

/** 挂载投影：缺省/畸形一律 null（畸形由写校验拦截）。 */
export function taskMountOf(task) {
  return isPlainObject(task) && isPlainObject(task.mount) ? task.mount : null
}

/** 主卡 = 没有 parent 的任务；只有主卡受「无 mount 不能实现」约束。 */
export function isRootTask(task) {
  return isPlainObject(task) && (task.parent === undefined || task.parent === null || task.parent === '')
}

function normalizeMountField(value) {
  if (isPlainObject(value) === false) throw invalid('mount must be an object {kind, id} or null')
  const keys = Object.keys(value)
  for (const key of keys) {
    if (key === 'kind' || key === 'id') continue
    throw invalid('mount only supports kind/id (single value; no multi-slice mount)')
  }
  const kind = typeof value.kind === 'string' ? value.kind.trim() : ''
  if (TASK_MOUNT_KINDS.includes(kind) === false) {
    throw invalid('mount.kind must be one of ' + TASK_MOUNT_KINDS.join(', '))
  }
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (id === '' || REF_ID_RE.test(id) === false) throw invalid('mount.id must be a non-empty slice/module id')
  return { kind, id }
}

/** 只读解析 docs/module-domain.json：区分 missing（降级）与 corrupt（显眼失败）。 */
function readModuleDomainState(root) {
  let text
  try {
    text = readFileSync(join(root, 'docs', 'module-domain.json'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', domain: null, error: null }
    return { status: 'corrupt', domain: null, error: error.message }
  }
  try {
    const parsed = JSON.parse(text)
    if (isPlainObject(parsed) === false) return { status: 'corrupt', domain: null, error: 'not a JSON object' }
    return { status: 'ok', domain: parsed, error: null }
  } catch (error) {
    return { status: 'corrupt', domain: null, error: error.message }
  }
}

/**
 * @deprecated 保留的旧名别名，**无运行时调用**：已 build 的描述台账成员表里登记了
 * `readModuleDomain`，而 reconcile 只增不删；删掉会让 `flow check description` 报
 * unknown-member。等价于 readModuleDomainState。
 */
function readModuleDomain(root) {
  return readModuleDomainState(root)
}

function mountMapErrorMessage(record, mount, state) {
  const prefix =
    state.status === 'corrupt'
      ? '先修 docs/module-domain.json（JSON 无法解析：' + state.error + '）'
      : '先修 docs/module-domain.json（缺少对应条目）'
  return 'task ' + record.id + ' 的挂载校验失败：' + prefix +
    '；mount ' + mount.kind + ':' + mount.id + '。' +
    '如模块已改名/删除，请用 flow task update ' + record.id + ' --mount-kind module|aspect --mount <新id> 重新挂载，' +
    '或 flow task update ' + record.id + ' --mount none 清空挂载'
}

/**
 * 挂载写校验（T-20261113165239）：
 * - 形状：单值 {kind:'module'|'aspect', id}（多值/双挂由 normalizeMountField 拒绝）；
 * - 责任冲突：id 在 docs/module-domain.json 的 modules/aspects 里不存在 → invalid；
 * - files 与 owns 的一致性本轮只 **warning**（观察期，避免存量卡被一刀切）。
 */
function assertTaskMountTarget(root, record) {
  const mount = taskMountOf(record)
  if (mount === null) return
  const state = readModuleDomainState(root)
  if (state.status === 'missing') {
    noteWarning('task-mount-unverifiable: ' + record.id + ': 找不到 docs/module-domain.json，无法校验 mount ' + mount.kind + ':' + mount.id)
    return
  }
  if (state.status === 'corrupt') {
    throw invalid(mountMapErrorMessage(record, mount, state))
  }
  const domain = state.domain
  const table = mount.kind === 'module' ? domain.modules : domain.aspects
  if (isPlainObject(table) === false || Object.hasOwn(table, mount.id) === false) {
    throw invalid(mountMapErrorMessage(record, mount, state))
  }
  if (mount.kind !== 'module') return
  const moduleDef = table[mount.id]
  const owns = [
    ...(Array.isArray(moduleDef.owns) ? moduleDef.owns : []),
    ...(Array.isArray(moduleDef.shared) ? moduleDef.shared : []),
  ].filter((entry) => typeof entry === 'string' && entry !== '')
  const allow = isPlainObject(record.scope) && Array.isArray(record.scope.allow) ? record.scope.allow : []
  const outside = allow.filter((file) => {
    const path = typeof file === 'string' ? file.trim() : ''
    if (path === '') return false
    return owns.some((own) => (own.endsWith('/') ? path.startsWith(own) : path === own)) === false
  })
  if (outside.length > 0) {
    noteWarning(
      'task-mount-files-outside: ' + record.id + ': scope.allow 不在模块 ' + mount.id + ' owns 内：' +
        outside.join(', ') + '（观察期只警告，不阻断）',
    )
  }
}

/**
 * 「无 mount 的主卡不能直接处理」：主卡没 mount 时拒绝 → implementing。
 * 子卡（有 parent）不受这条约束（子卡的 mount 由父卡拆分时给出）。
 */
export function assertMountProcessingGate(task, options = {}, root = null, contract = null) {
  const bag = isPlainObject(options) ? options : {}
  if (bag.source === 'internal') return
  if (bag.to !== 'implementing') return
  if (isPlainObject(task) === false || isRootTask(task) === false) return
  if (taskMountOf(task) !== null) return
  const mode = resolveClaimGateMode(contract, bag).mode
  if (mode === 'off') return
  const warnOrReject = (message) => {
    if (mode === 'warn') {
      noteWarning('task-mount-required: ' + message + '（claims.enforce=warn 降级）')
      return true
    }
    throw invalid(message)
  }
  const state = root === null ? { status: 'missing', domain: null, error: null } : readModuleDomainState(root)
  if (state.status === 'corrupt') {
    return warnOrReject(
      '主卡 ' + task.id + ' 的挂载门无法执行：先修 docs/module-domain.json（JSON 无法解析：' + state.error + '）',
    )
  }
  /* 无图项目：既不能挂载也不能校验，硬拦会让刚 init 的项目进不了 implementing → 观察期降级 warning。 */
  if (state.status === 'missing') {
    noteWarning('task-mount-required: ' + task.id + ': 项目没有 docs/module-domain.json（无法校验挂载目标），无 mount 主卡的 implementing 门降级为警告')
    return
  }
  const from = typeof bag.from === 'string' ? bag.from : ''
  const at = formatIso()
  if (mountLegacyAllowed(task, 'implementing')) {
    if (mode === 'hard') markMountLegacy(task, 'implementing', from, 'implementing', at)
    noteWarning(
      'task-mount-legacy: ' + task.id + ': 切换点前创建的主卡没有 mount，本次 →implementing 按 legacy 放行' +
        (mode === 'hard'
          ? '并写入 mount-legacy-implementing 标记；之后必须显式挂载或拆子卡'
          : '（warn 模式只警告、不写标记）'),
    )
    return
  }
  warnOrReject(
    '主卡 ' + task.id + ' 没有 mount，不能直接推进到 implementing：' +
      '先拆子卡（flow_subtask add），或显式给挂载：flow task update ' + task.id +
      " --mount-kind module|aspect --mount <id>，并在 notes 写明理由",
  )
}

// ------------------------------------------- dispatch work orders (2026-11-13 T-20261113155234)

/** 工单上的可选字段（单条，每卡最多 1 条未关闭）。 */
const DISPATCH_ORDER_KEYS = Object.freeze([
  'id', 'createdAt', 'expiresAt', 'requester', 'agent', 'role', 'attempt',
  'ackedAt', 'closedAt', 'outcome', 'reason',
])

function isTimestampString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** 校验/归一任务顶层 dispatch 字段（缺省 = 没有工单）。 */
function validateDispatchOrderField(record) {
  if (record.dispatch === undefined || record.dispatch === null) return
  const order = record.dispatch
  if (isPlainObject(order) === false) throw invalid('dispatch must be an object or null')
  for (const key of Object.keys(order)) {
    if (DISPATCH_ORDER_KEYS.includes(key)) continue
    throw invalid('dispatch does not support field ' + key)
  }
  if (typeof order.id !== 'string' || order.id.trim() === '') throw invalid('dispatch.id must be a non-empty string')
  for (const key of ['createdAt', 'expiresAt']) {
    if (isTimestampString(order[key]) === false) throw invalid('dispatch.' + key + ' must be a timestamp string')
  }
  if (typeof order.agent !== 'string' || order.agent.trim() === '') throw invalid('dispatch.agent must be a non-empty string')
  if (CLAIM_ROLES.includes(order.role) === false) throw invalid('dispatch.role must be one of ' + CLAIM_ROLES.join(', '))
  if (Number.isInteger(order.attempt) === false || order.attempt < 1 || order.attempt > DISPATCH_ATTEMPT_MAX) {
    throw invalid('dispatch.attempt must be 1..' + DISPATCH_ATTEMPT_MAX)
  }
  for (const key of ['ackedAt', 'closedAt']) {
    if (order[key] !== undefined && order[key] !== null && isTimestampString(order[key]) === false) {
      throw invalid('dispatch.' + key + ' must be a timestamp string or null')
    }
  }
  if (order.outcome !== undefined && order.outcome !== null && DISPATCH_ORDER_OUTCOMES.includes(order.outcome) === false) {
    throw invalid('dispatch.outcome must be one of ' + DISPATCH_ORDER_OUTCOMES.join(', '))
  }
  if (order.reason !== undefined && order.reason !== null && typeof order.reason !== 'string') {
    throw invalid('dispatch.reason must be a string')
  }
  record.dispatch = {
    id: order.id.trim(),
    createdAt: order.createdAt.trim(),
    expiresAt: order.expiresAt.trim(),
    requester: typeof order.requester === 'string' ? order.requester : '',
    agent: order.agent.trim(),
    role: order.role,
    attempt: order.attempt,
    ...(isTimestampString(order.ackedAt) ? { ackedAt: order.ackedAt.trim() } : {}),
    ...(isTimestampString(order.closedAt) ? { closedAt: order.closedAt.trim() } : {}),
    ...(order.outcome === undefined || order.outcome === null ? {} : { outcome: order.outcome }),
    ...(typeof order.reason === 'string' && order.reason !== '' ? { reason: order.reason } : {}),
  }
}

/** 当前工单投影（没有则 null）。 */
export function dispatchOrderOf(task) {
  return isPlainObject(task) && isPlainObject(task.dispatch) ? task.dispatch : null
}

function isOpenDispatchOrder(order) {
  return isPlainObject(order) && isTimestampString(order.closedAt) === false
}

/**
 * 工单 + 执行权的读投影：status = pending|acked|ok|failed|expired；另给 orphan/stale。
 * orphan = 已 ack 但**没有 open claim**，或 open claim 的 session 心跳判死不活。
 */
export function dispatchStateOf(task, options = {}) {
  const order = dispatchOrderOf(task)
  if (order === null) return null
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now()
  const closed = isTimestampString(order.closedAt)
  /* 手改记录/坏时间戳不能让工单「永不过期」：非法 expiresAt 一律视为 stale。 */
  const expiresMs = Date.parse(order.expiresAt)
  const stale = closed === false && (Number.isFinite(expiresMs) === false || expiresMs <= nowMs)
  let status = closed ? (order.outcome || 'ok') : order.ackedAt ? 'acked' : 'pending'
  let orphan = false
  if (closed === false && order.ackedAt) {
    const claim = openClaimOf(task)
    if (claim === null) orphan = true
    else {
      const session = typeof claim.session === 'string' ? claim.session.trim() : ''
      if (session !== '' && typeof options.isSessionLive === 'function') {
        try {
          orphan = options.isSessionLive(session) !== true
        } catch {
          orphan = false
        }
      }
    }
  }
  return { ...order, status, orphan, stale }
}

/**
 * 下单：写一条工单（不 spawn、不推进阶段）。
 * 同卡已有未关闭工单 → invalid 并点名持有者；attempt 上限 3。
 */
export function queueDispatch(root, contract, id, input) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const value = isPlainObject(input) ? input : {}
  const agent = typeof value.agent === 'string' ? value.agent.trim() : ''
  if (agent === '') throw invalid('dispatch-queue agent must be a non-empty string (--agent <name>)')
  const role = typeof value.role === 'string' ? value.role.trim() : ''
  if (CLAIM_ROLES.includes(role) === false) throw invalid('dispatch-queue role must be one of ' + CLAIM_ROLES.join(', '))
  const ttl = Number.isInteger(value.ttl) && value.ttl > 0 ? value.ttl : DISPATCH_TTL_SECONDS
  if (ttl > DISPATCH_TTL_MAX_SECONDS) {
    throw invalid('dispatch-queue --ttl 不能超过 ' + DISPATCH_TTL_MAX_SECONDS + ' 秒')
  }
  const requester = typeof value.requester === 'string' ? value.requester.trim() : ''
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.tasks, id, 'task')
    const currentStage = projectTaskStage(current).stage
    if (['done', 'archived', 'cancelled'].includes(currentStage)) {
      throw invalid('task ' + id + ' 已处于终态 ' + currentStage + '，不能下单')
    }
    const previous = dispatchOrderOf(current)
    if (previous !== null && isOpenDispatchOrder(previous)) {
      throw invalid(
        'task ' + id + ' 已有未关闭工单 ' + previous.id + '（agent=' + previous.agent +
          ', role=' + previous.role + '，createdAt=' + previous.createdAt + '）；先 dispatch-close 或等待其关闭',
      )
    }
    const attempt = previous === null ? 1 : Number(previous.attempt || 0) + 1
    if (attempt > DISPATCH_ATTEMPT_MAX) {
      throw invalid('task ' + id + ' 的工单 attempt 已达上限 ' + DISPATCH_ATTEMPT_MAX + '；请人工处理或新建任务')
    }
    const now = new Date()
    const at = formatIso(now)
    const order = {
      id: 'D-' + id + '-' + attempt,
      createdAt: at,
      expiresAt: formatIso(new Date(now.getTime() + ttl * 1000)),
      requester,
      agent,
      role,
      attempt,
    }
    const next = stampTaskTimes(current, applyTaskPatch(current, { dispatch: order }), at)
    writeJsonAtomic(join(paths.tasks, next.id + '.json'), next)
    return projectTaskStage(projectTaskType(next))
  })
}

/**
 * 领单 + ack：复用 claimTask 的**同一次写入**写 open claim，并把工单标为 acked。
 * 不另造第二套回执（工单只记 ackedAt，执行权仍是 checkpoints 里的 claim）。
 */
export function ackDispatch(root, contract, id, input) {
  const value = isPlainObject(input) ? input : {}
  const agent = typeof value.agent === 'string' ? value.agent.trim() : ''
  if (agent === '') throw invalid('dispatch-ack agent must be a non-empty string (--agent <name>)')
  const task = getTask(root, contract, id)
  const order = dispatchOrderOf(task)
  if (order === null) throw invalid('task ' + id + ' 没有可 ack 的工单（先 dispatch-queue）')
  if (isOpenDispatchOrder(order) === false) throw invalid('task ' + id + ' 的工单 ' + order.id + ' 已关闭，不能 ack')
  if (order.ackedAt) throw invalid('task ' + id + ' 的工单 ' + order.id + ' 已被 ack（agent=' + order.agent + '）')
  return claimTask(root, contract, id, {
    agent,
    role: order.role,
    ...(typeof value.session === 'string' && value.session.trim() !== '' ? { session: value.session.trim() } : {}),
    ...(typeof value.reason === 'string' && value.reason.trim() !== '' ? { reason: value.reason.trim() } : {}),
  }, {
    ...(isPlainObject(value.options) ? value.options : {}),
    dispatchAck: true,
    ...(typeof value.requester === 'string' ? { ackRequester: value.requester.trim() } : {}),
  })
}

/** 关闭工单：写 closedAt/outcome/reason（不动物理执行权）。 */
export function closeDispatch(root, contract, id, input) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const value = isPlainObject(input) ? input : {}
  const outcome = typeof value.outcome === 'string' ? value.outcome.trim() : ''
  if (DISPATCH_ORDER_OUTCOMES.includes(outcome) === false) {
    throw invalid('dispatch-close outcome must be one of ' + DISPATCH_ORDER_OUTCOMES.join(', '))
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.tasks, id, 'task')
    const order = dispatchOrderOf(current)
    if (order === null) throw invalid('task ' + id + ' 没有工单')
    if (isOpenDispatchOrder(order) === false) throw invalid('task ' + id + ' 的工单 ' + order.id + ' 已关闭')
    /* ok 只允许已 ack；pending 只能以 failed/expired 收尾（否则可以凭空成功）。 */
    if (outcome === 'ok' && !order.ackedAt) {
      throw invalid('task ' + id + ' 的工单 ' + order.id + ' 还未 ack，不能以 ok 关闭；pending 只能 failed|expired')
    }
    const at = formatIso()
    let checkpoints = checkpointListOf(current)
    /* failed/expired 必须同一次写入释放匹配的 open claim，否则 attempt 2/3 的 ack 会撞 open claim。
       非本工单 agent 的 claim 需要 --force（并写审计 note）。 */
    {
      const open = openClaimOf(current)
      if (open !== null) {
        const holder = typeof open.agent === 'string' ? open.agent.trim() : ''
        if (holder !== order.agent && value.force !== true) {
          throw invalid(
            'task ' + id + ' 的 open claim 属于 ' + (holder || '?') + '，与工单 agent ' + order.agent +
              ' 不一致；确认要释放请加 --force',
          )
        }
        let index = -1
        for (let cursor = checkpoints.length - 1; cursor >= 0; cursor -= 1) {
          const item = checkpoints[cursor]
          if (isClaimEntry(item) && isOpenClaimEntry(item)) {
            index = cursor
            break
          }
        }
        if (index !== -1) {
          const forced = holder !== order.agent && value.force === true
          const released = {
            ...checkpoints[index],
            closedAt: at,
            outcome: outcome === 'ok' ? 'ok' : 'aborted',
            note: 'dispatch-close:' + outcome + (forced ? '（--force 释放非本工单 agent 的 claim）' : ''),
          }
          checkpoints = [...checkpoints.slice(0, index), released, ...checkpoints.slice(index + 1)]
        }
      }
    }
    const closed = { ...order, closedAt: at, outcome, ...(reason === '' ? {} : { reason }) }
    const patch = checkpoints === checkpointListOf(current) ? { dispatch: closed } : { dispatch: closed, checkpoints }
    const next = stampTaskTimes(current, applyTaskPatch(current, patch), at)
    writeJsonAtomic(join(paths.tasks, next.id + '.json'), next)
    return projectTaskStage(projectTaskType(next))
  })
}

/** 工单列表（跨卡）。--stale 只保留过期或孤儿。 */
export function listDispatches(root, contract, options = {}) {
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c)
  const input = isPlainObject(options) ? options : {}
  const sessionFilter = typeof input.session === 'string' ? input.session.trim() : ''
  const rows = []
  for (const item of readCollection(paths.tasks)) {
    const record = item.record
    if (isPlainObject(record) === false) continue
    const state = dispatchStateOf(record, input)
    if (state === null) continue
    /* 执行权投影（T-20261113193143）：最新一条本工单角色的 claim（open 或 closed）；插件重启后
       按子会话找回工单时读这一组字段。 */
    const claimEntry = latestRoleEntry(record, state.role)
    const claim = claimEntry === null
      ? null
      : {
          agent: typeof claimEntry.agent === 'string' ? claimEntry.agent : '',
          session: typeof claimEntry.session === 'string' ? claimEntry.session : '',
          at: typeof claimEntry.at === 'string' ? claimEntry.at : '',
          closedAt: typeof claimEntry.closedAt === 'string' ? claimEntry.closedAt : null,
          outcome: typeof claimEntry.outcome === 'string' ? claimEntry.outcome : null,
        }
    const row = {
      task: record.id,
      taskId: record.id,
      ...state,
      claim,
      /* 「重启后仍 open 且已过期」分类：open + 过期；ack 与否用 status 区分。 */
      restartExpired: state.stale === true,
    }
    if (input.stale === true && (state.stale !== true && state.orphan !== true)) continue
    if (input.orphan === true && state.orphan !== true) continue
    if (sessionFilter !== '') {
      const claimSession = claim === null ? '' : claim.session
      if (claimSession !== sessionFilter && (typeof row.requester !== 'string' || row.requester !== sessionFilter)) continue
    }
    rows.push(row)
  }
  rows.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
  return rows
}

// ------------------------------------------------- dispatch claims (2026-11-13)

/** checkpoint 数组（缺省/非数组 -> 空：读老记录永远不炸）。 */
function checkpointListOf(task) {
  return isPlainObject(task) && Array.isArray(task.checkpoints) ? task.checkpoints : []
}

function isClaimEntry(item) {
  return isPlainObject(item) && item.kind === 'claim'
}

function isDispatchEntry(item) {
  return isPlainObject(item) && item.kind === 'dispatch'
}

/** open 回执：claim 或 dispatch，且没有 closedAt/outcome。 */
function isOpenClaimEntry(item) {
  if (isClaimEntry(item) === false && isDispatchEntry(item) === false) return false
  if (typeof item.closedAt === 'string' && item.closedAt.trim() !== '') return false
  return item.outcome === undefined || item.outcome === null
}

/** 最后一条 open 回执（claim/dispatch 共用投影；没有就 null）。 */
export function openClaimOf(task) {
  const list = checkpointListOf(task)
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (isOpenClaimEntry(list[index])) return list[index]
  }
  return null
}

/** 卡上是否已有显式 claim 历史（有 = 不再享受 legacy 放行）。 */
export function hasClaimHistory(task) {
  return checkpointListOf(task).some(isClaimEntry)
}

/**
 * 读投影：当前 open 回执 + 孤儿标记。
 *
 * 只有回执带 session、且 liveness 判死/判不清时 orphan 才为 true（liveness 由
 * 调用方注入，flow task list 用心跳台账；本模块不做 IO）。没有 session 的回执
 * 无法判活，不算孤儿。
 */
export function claimStateOf(task, options = {}) {
  const open = openClaimOf(task)
  if (open === null) return null
  const session = typeof open.session === 'string' ? open.session.trim() : ''
  const agent =
    typeof open.agent === 'string' && open.agent.trim() !== ''
      ? open.agent.trim()
      : typeof open.childId === 'string'
        ? open.childId.trim()
        : ''
  let orphan = false
  if (session !== '' && isPlainObject(options) && typeof options.isSessionLive === 'function') {
    try {
      orphan = options.isSessionLive(session) !== true
    } catch {
      orphan = false
    }
  }
  return {
    kind: String(open.kind),
    role: typeof open.role === 'string' ? open.role : '',
    agent,
    ...(session === '' ? {} : { session }),
    at: typeof open.at === 'string' ? open.at : '',
    orphan,
  }
}

/** 校验显式 claim 条目（只校验 kind:'claim'；老记录的自由形状不动）。 */
function validateClaimCheckpoints(record) {
  for (const item of checkpointListOf(record)) {
    if (isClaimEntry(item) === false) continue
    if (CLAIM_ROLES.includes(item.role) === false) {
      throw invalid('claim.role must be one of ' + CLAIM_ROLES.join(', '))
    }
    if (typeof item.agent !== 'string' || item.agent.trim() === '') {
      throw invalid('claim.agent must be a non-empty string')
    }
    if (typeof item.at !== 'string' || item.at.trim() === '') {
      throw invalid('claim.at must be a non-empty timestamp string')
    }
    if (item.outcome !== undefined && item.outcome !== null && CLAIM_OUTCOMES.includes(item.outcome) === false) {
      throw invalid('claim.outcome must be one of ' + CLAIM_OUTCOMES.join(', '))
    }
  }
}

/**
 * 领取一张卡（flow task claim 的唯一写入口）。
 *
 * 写一条 open 回执 {kind:'claim', role, agent, session?, from, to, at}，有 session
 * 时把 owner 设为该 session。互斥在同一把写锁内判定：
 * - 同一 agent 全局只能有 1 条 open claim（跨卡扫描，冲突文案点名对方 id）；
 * - 同一卡只能有 1 条 open claim（冲突文案点名 agent 与持有者）。
 */
export function claimTask(root, contract, id, input, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const value = isPlainObject(input) ? input : {}
  const role = typeof value.role === 'string' ? value.role.trim() : ''
  if (CLAIM_ROLES.includes(role) === false) {
    throw invalid('claim role must be one of ' + CLAIM_ROLES.join(', ') + '（收到 ' + JSON.stringify(value.role) + '）')
  }
  const agent = typeof value.agent === 'string' ? value.agent.trim() : ''
  if (agent === '') throw invalid('claim agent must be a non-empty string (--agent <name>)')
  const session = typeof value.session === 'string' ? value.session.trim() : ''
  const probeOptions = isPlainObject(options) ? options : {}
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.tasks, id, 'task')
    /* 主卡没有 mount 时不允许领取实现角色；与 →implementing 同一口径（mode/legacy/无图降级）。 */
    if (role === 'implementer' && isRootTask(current) && taskMountOf(current) === null) {
      const mode = resolveClaimGateMode(c, probeOptions).mode
      const claimMessage =
        '主卡 ' + id + ' 没有 mount，不能 claim implementer：先拆子卡（flow_subtask add），' +
        '或显式给挂载：flow task update ' + id + ' --mount-kind module|aspect --mount <id>，并在 notes 写明理由'
      if (mode !== 'off') {
        const state = readModuleDomainState(root)
        if (state.status === 'corrupt') {
          if (mode === 'warn') {
            noteWarning('task-mount-required: ' + claimMessage + '（claims.enforce=warn 降级；module-domain 无法解析）')
          } else {
            throw invalid('主卡 ' + id + ' 的挂载门无法执行：先修 docs/module-domain.json（JSON 无法解析：' + state.error + '）')
          }
        } else if (state.status === 'missing') {
          noteWarning('task-mount-required: ' + id + ': 项目没有 docs/module-domain.json（无法校验挂载目标），无 mount 主卡的 claim 门降级为警告')
        } else if (mountLegacyAllowed(current, 'claim')) {
          if (mode === 'hard') markMountLegacy(current, 'claim', projectTaskStage(current).stage, 'claim', formatIso())
          noteWarning(
            'task-mount-legacy: ' + id + ': 切换点前创建的主卡没有 mount，本次 claim 按 legacy 放行' +
              (mode === 'hard'
                ? '并写入 mount-legacy-claim 标记；之后必须显式挂载或拆子卡'
                : '（warn 模式只警告、不写标记）'),
          )
        } else if (mode === 'warn') {
          noteWarning('task-mount-required: ' + claimMessage + '（claims.enforce=warn 降级）')
        } else {
          throw invalid(claimMessage)
        }
      }
    }
    /* 领单（T-20261113155234）：ack 与 open claim 同一次写入；工单只记 ackedAt。 */
    let dispatchAcked = null
    if (probeOptions.dispatchAck === true) {
      const order = dispatchOrderOf(current)
      if (order === null) throw invalid('task ' + id + ' 没有可 ack 的工单（先 dispatch-queue）')
      if (isOpenDispatchOrder(order) === false) throw invalid('task ' + id + ' 的工单 ' + order.id + ' 已关闭，不能 ack')
      if (order.ackedAt) throw invalid('task ' + id + ' 的工单 ' + order.id + ' 已被 ack（agent=' + order.agent + '）')
      if (order.agent !== agent) {
        throw invalid('dispatch-ack agent 不匹配：工单指定 agent=' + order.agent + '，收到 ' + agent)
      }
      if (order.role !== role) {
        throw invalid('dispatch-ack role 不匹配：工单 role=' + order.role + '，收到 ' + role)
      }
      const expiresMs = Date.parse(order.expiresAt)
      if (Number.isFinite(expiresMs) === false || expiresMs <= Date.now()) {
        throw invalid('task ' + id + ' 的工单 ' + order.id + ' 已过期或 expiresAt 非法（expiresAt=' + order.expiresAt + '），不能 ack')
      }
      const ackRequester = typeof probeOptions.ackRequester === 'string' ? probeOptions.ackRequester.trim() : ''
      dispatchAcked = {
        ...order,
        ackedAt: formatIso(),
        ...(ackRequester === '' ? {} : { requester: ackRequester }),
      }
    }
    const openHere = checkpointListOf(current).filter(isOpenClaimEntry)
    if (openHere.length > 0) {
      const holder = openHere[openHere.length - 1]
      const label =
        typeof holder.agent === 'string' && holder.agent.trim() !== ''
          ? holder.agent.trim()
          : typeof holder.childId === 'string'
            ? holder.childId.trim()
            : '?'
      throw invalid(
        'task ' + id + ' already has an open claim (agent=' + label + ', role=' + String(holder.role ?? '?') + '); ' +
          'release it first: flow task release ' + id + ' --agent ' + label + ' --outcome ok|aborted',
      )
    }
    const conflicts = readCollection(paths.tasks)
      .map((item) => item.record)
      .filter((record) => isPlainObject(record) && record.id !== id)
      .filter((record) => {
        const open = openClaimOf(record)
        if (open === null) return false
        const holder = typeof open.agent === 'string' ? open.agent.trim() : ''
        return holder === agent
      })
    if (conflicts.length > 0) {
      const other = conflicts[0]
      throw invalid(
        'agent ' + agent + ' already has an open claim on task ' + other.id + '; ' +
          'release it first: flow task release ' + other.id + ' --agent ' + agent + ' --outcome ok|aborted',
      )
    }
    /* owner 是会话归属：有 session 才写；旧 owner 是别的活会话时拒绝抢占
       （与 updateTask 的会话归属守卫同一口径，probe 由 CLI 用心跳台账注入）。 */
    const ownerBefore = typeof current.owner === 'string' ? current.owner.trim() : ''
    if (session !== '' && ownerBefore !== '' && ownerBefore !== session) {
      const isLive = typeof probeOptions.isSessionLive === 'function' ? probeOptions.isSessionLive : null
      let live = undefined
      if (isLive !== null) {
        try {
          live = isLive(ownerBefore)
        } catch {
          live = undefined
        }
      }
      if (live === true) {
        throw invalid('task ' + id + ' is owned by active session ' + ownerBefore + '; only that session can move or release it')
      }
    }
    const at = formatIso()
    const note = typeof value.reason === 'string' ? value.reason.trim() : ''
    const record = {
      kind: 'claim',
      role,
      agent,
      ...(session === '' ? {} : { session }),
      ...(note === '' ? {} : { note }),
      from: projectTaskStage(current).stage,
      to: CLAIM_WORKING_STAGE[role],
      at,
    }
    const patch = { checkpoints: [...checkpointListOf(current), record] }
    if (session !== '') patch.owner = session
    if (dispatchAcked !== null) patch.dispatch = dispatchAcked
    const next = stampTaskTimes(current, applyTaskPatch(current, patch), at)
    writeJsonAtomic(join(paths.tasks, next.id + '.json'), next)
    return projectTaskStage(projectTaskType(next))
  })
}

/**
 * 关闭一张卡的 open claim（flow task release 的唯一写入口）。
 *
 * 只关闭 kind:'claim' 且 agent 匹配的最后一条 open 回执；派工回执
 * （kind:'dispatch'）属于插件，由阶段门自动收口。写 closedAt 与 outcome
 * （ok|aborted），可选 note 记原因。
 */
export function releaseTask(root, contract, id, input) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const value = isPlainObject(input) ? input : {}
  const agent = typeof value.agent === 'string' ? value.agent.trim() : ''
  if (agent === '') throw invalid('release agent must be a non-empty string (--agent <name>)')
  const outcome = typeof value.outcome === 'string' ? value.outcome.trim() : ''
  if (CLAIM_OUTCOMES.includes(outcome) === false) {
    throw invalid('release outcome must be one of ' + CLAIM_OUTCOMES.join(', ') + '（收到 ' + JSON.stringify(value.outcome) + '）')
  }
  const note = typeof value.reason === 'string' ? value.reason.trim() : ''
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.tasks, id, 'task')
    const list = checkpointListOf(current)
    let index = -1
    for (let cursor = list.length - 1; cursor >= 0; cursor -= 1) {
      const item = list[cursor]
      if (isClaimEntry(item) === false || isOpenClaimEntry(item) === false) continue
      const holder = typeof item.agent === 'string' ? item.agent.trim() : ''
      if (holder === agent) {
        index = cursor
        break
      }
    }
    if (index === -1) {
      const open = openClaimOf(current)
      const label =
        open === null
          ? '（没有 open 回执）'
          : '（当前 open 回执 agent=' + String(open.agent ?? '?') + ', role=' + String(open.role ?? '?') + '）'
      throw invalid('task ' + id + ' has no open claim for agent ' + agent + ' ' + label)
    }
    const at = formatIso()
    /* release 可携带交接产物（T-20261113170144）：不另造回执，指针既进
       task.artifacts，也挂在被关闭的 claim 上（role 默认取该 claim 的角色）。 */
    const artifactFile = typeof value.file === 'string' ? value.file.trim() : ''
    let artifactPointer = null
    let artifacts = artifactsListOf(current)
    if (artifactFile !== '') {
      const claimRole = typeof list[index].role === 'string' ? list[index].role : ''
      const requestedRole = typeof value.role === 'string' ? value.role.trim() : ''
      if (requestedRole !== '' && requestedRole !== claimRole) {
        throw invalid('release --role ' + requestedRole + ' 与 claim 角色 ' + claimRole + ' 不一致')
      }
      artifactPointer = buildArtifact(root, current, {
        role: claimRole,
        summary: value.summary,
        file: artifactFile,
        agent,
      })
      artifacts = pruneArtifacts([...artifacts, artifactPointer])
    }
    const closed = {
      ...list[index],
      closedAt: at,
      outcome,
      ...(note === '' ? {} : { note }),
      ...(artifactPointer === null ? {} : { artifact: artifactPointer }),
    }
    const checkpoints = [...list.slice(0, index), closed, ...list.slice(index + 1)]
    const patch = artifactPointer === null ? { checkpoints } : { checkpoints, artifacts }
    const next = stampTaskTimes(current, applyTaskPatch(current, patch), at)
    writeJsonAtomic(join(paths.tasks, next.id + '.json'), next)
    return projectTaskStage(projectTaskType(next))
  })
}

/** 把指定角色的 open 派工回执（kind:'dispatch'）自动收口为 outcome ok。 */
function closeDispatchReceipts(record, role, at) {
  const list = checkpointListOf(record)
  let closed = 0
  const next = list.map((item) => {
    if (isDispatchEntry(item) === false || isOpenClaimEntry(item) === false) return item
    if (typeof item.role !== 'string' || item.role !== role) return item
    closed += 1
    return { ...item, closedAt: at, outcome: 'ok' }
  })
  if (closed > 0) record.checkpoints = next
  return closed
}

/** 指定角色的**最后一条** claim/dispatch 回执（轮次判定的唯一入口）。 */
function latestRoleEntry(record, role) {
  const list = checkpointListOf(record)
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index]
    if (isPlainObject(item) === false) continue
    if (isClaimEntry(item) === false && isDispatchEntry(item) === false) continue
    if (item.role === role) return item
  }
  return null
}

/**
 * 本轮回执是否已闭合 ok（评审必修 2）。
 *
 * 只认**最后一条**该角色回执：审查打回后新建的 open claim/派工回执会成为最后一条，
 * 上一轮 closed ok 不会被复用；这与派工片的轮次复用判据同向。
 */
function hasClosedClaim(record, role) {
  return latestClaimClosedOk(record, role)
}

function latestClaimClosedOk(record, role) {
  const latest = latestRoleEntry(record, role)
  return latest !== null && latest.outcome === 'ok' && typeof latest.closedAt === 'string' && latest.closedAt !== ''
}

/** mount 门的 legacy 口径：按创建时间切换点 + 本门自己的标记（与 claim/dispatch 门互不占用）。 */
function mountLegacyAllowed(task, gate) {
  const list = checkpointListOf(task)
  if (list.some((item) => isPlainObject(item) && item.kind === 'mount-legacy-' + gate)) return false
  const created = Date.parse(typeof task.created_at === 'string' ? task.created_at : '')
  if (!Number.isFinite(created)) return true
  return created < LEGACY_CUTOFF_MS
}

function markMountLegacy(task, gate, from, to, at) {
  task.checkpoints = [...checkpointListOf(task), { kind: 'mount-legacy-' + gate, stage: to, from, at }]
}

/** 该卡是否还能享受一次 legacy 放行（按创建时间切换点 + 已写标记）。 */
function legacyBypassAllowed(task) {
  const list = checkpointListOf(task)
  if (list.some((item) => isPlainObject(item) && item.kind === LEGACY_BYPASS_KIND)) return false
  if (list.some(isClaimEntry)) return false
  const created = Date.parse(typeof task.created_at === 'string' ? task.created_at : '')
  if (!Number.isFinite(created)) return true
  return created < LEGACY_CUTOFF_MS
}

/** 写一次性 legacy 放行标记：下一次同一张卡不再享受 legacy。 */
function markLegacyBypass(task, from, to, at) {
  task.checkpoints = [...checkpointListOf(task), { kind: LEGACY_BYPASS_KIND, stage: to, from, at }]
}

/** 派工门强制模式（CONTRACT §3.2）：hard 拒绝 / warn 只警告 / off 不检查。 */
export const CLAIM_GATE_MODES = Object.freeze(['hard', 'warn', 'off'])

/** 从项目契约读 claims.enforce（缺省/非法一律 hard）。 */
export function claimGateModeOf(contract) {
  const raw = isPlainObject(contract) && isPlainObject(contract.claims) ? contract.claims.enforce : undefined
  const mode = typeof raw === 'string' ? raw.trim() : ''
  return CLAIM_GATE_MODES.includes(mode) ? mode : 'hard'
}

/**
 * 模式优先级：显式 options.claimGate > 环境变量 PROJECT_FLOW_CLAIM_GATE > 契约 claims.enforce > hard。
 * 环境变量给历史测试入口用（进程级降级，不改命令行面、不改断言语义）。
 */
function resolveClaimGateMode(contract, options) {
  const bag = isPlainObject(options) ? options : {}
  if (CLAIM_GATE_MODES.includes(bag.claimGate)) {
    return { mode: bag.claimGate, source: '由调用方 claimGate 选项降级' }
  }
  const env = typeof process !== 'undefined' && process.env ? process.env.PROJECT_FLOW_CLAIM_GATE : ''
  const fromEnv = typeof env === 'string' ? env.trim() : ''
  if (CLAIM_GATE_MODES.includes(fromEnv)) {
    return { mode: fromEnv, source: '由 PROJECT_FLOW_CLAIM_GATE 环境变量降级（测试/排障专用）' }
  }
  return { mode: claimGateModeOf(contract), source: '由 claims.enforce 配置降级' }
}

/**
 * 派工回执阶段门（updateTask 的挂载点）。
 *
 * 三条硬校验（source==='internal' 豁免；from===to 是幂等补丁）：
 * - → implementing：必须存在与目标角色 implementer 匹配的 open claim；
 * - → queued-review：必须存在已关闭 outcome=ok 的 implementer claim；
 * - → done（仅 reviewing → done 审查判定边）：必须存在已关闭 outcome=ok 的
 *   reviewer claim，或用 --no-dispatch --reason 显式覆盖（写 kind:'no-dispatch'
 *   回执 + warning）。analyzing → done 是汇总轮收口，审查证据在子任务上，
 *   不要求父卡自己的 reviewer claim。
 *
 * legacy（无显式 claim、无 checkpoints、无 owner）只写 warning 放行一次；
 * 一旦写过 claim 就必须按上面的硬校验闭合。
 */
export function assertDispatchGate(contract, task, options = {}) {
  const bag = isPlainObject(options) ? options : {}
  if (bag.source === 'internal') return
  const to = typeof bag.to === 'string' ? bag.to : ''
  if (DISPATCH_GATE_STAGES.includes(to) === false) return
  const from = typeof bag.from === 'string' ? bag.from : ''
  if (from === to) return
  if (isPlainObject(task) === false || typeof task.id !== 'string' || task.id === '') return

  const id = task.id
  const resolvedMode = resolveClaimGateMode(contract, bag)
  const mode = resolvedMode.mode
  /* 非 hard 必须显眼：进程级 env 能降级三道门，静默就等于把「凭自觉」换个形式。 */
  if (mode !== 'hard') {
    noteWarning('claim-gate-bypassed: mode=' + mode + '（' + resolvedMode.source + '）')
  }
  if (mode === 'off') return
  const at = formatIso()
  const legacy = legacyBypassAllowed(task)
  const reject = (message) => {
    if (mode === 'warn') {
      noteWarning('task-dispatch-warn: ' + message)
      return
    }
    throw invalid(message)
  }
  /* 一次性 legacy 放行：hard 模式写标记后这张卡后续必须走硬门（评审必修 1）；
     warn 模式只警告、不改台账（降级就是降级，不能偷偷写标记）。 */
  const legacyPass = (edge) => {
    if (legacy === false) return false
    if (mode === 'hard') markLegacyBypass(task, from, edge, at)
    noteWarning(
      'task-dispatch-legacy: ' + id + ': 切换点前创建的卡没有 claim 回执，本次 →' + edge +
        (mode === 'hard'
          ? ' 按 legacy 放行并写入 ' + LEGACY_BYPASS_KIND + ' 标记；之后必须 claim/release 走硬门'
          : ' 在 warn 模式下只警告放行（未写标记）'),
    )
    return true
  }

  if (to === 'implementing') {
    const latest = latestRoleEntry(task, 'implementer')
    if (latest !== null && isOpenClaimEntry(latest)) return
    if (legacyPass('implementing')) return
    return reject(
      'dispatch gate: implementing: task ' + id + ' 缺少与目标角色 implementer 匹配的 open claim — ' +
        '先领取：flow task claim ' + id + ' --agent <name> --role implementer [--session <会话id>]，' +
        '完成/放弃时 flow task release ' + id + ' --agent <name> --outcome ok|aborted，再推进',
    )
  }

  if (to === 'queued-review') {
    /* 派工回执由这一步自动收口：派工器不在本卡写域，正常流水线的实现者回执必须能
       在推进时闭合，否则实现者完成后永远进不了待审查。warn 模式不改台账。 */
    if (mode === 'hard') closeDispatchReceipts(task, 'implementer', at)
    if (hasClosedClaim(task, 'implementer')) return
    if (legacyPass('queued-review')) return
    return reject(
      'dispatch gate: queued-review: task ' + id + ' 本轮的 implementer 回执尚未闭合或不是 outcome=ok — ' +
        '实现完成后先 flow task release ' + id + ' --agent <name> --outcome ok，再推进到待审查；' +
        '若这张卡从未 claim 过：先 flow task claim ' + id + ' --agent <name> --role implementer 再 release',
    )
  }

  /* done：只有审查判定边（reviewing → done）需要 reviewer 回执；汇总轮
     analyzing → done 的审查证据在子任务上。 */
  if (from !== 'reviewing') return
  if (mode === 'hard') closeDispatchReceipts(task, 'reviewer', at)
  if (hasClosedClaim(task, 'reviewer')) return
  if (bag.noDispatch === true) {
    const reason = typeof bag.dispatchReason === 'string' ? bag.dispatchReason.trim() : ''
    if (reason === '') {
      throw invalid('dispatch gate: done: task ' + id + ' 用 --no-dispatch 覆盖审查回执时必须给 --reason <原因>')
    }
    task.checkpoints = [...checkpointListOf(task), { kind: 'no-dispatch', stage: 'done', from, reason, at }]
    noteWarning('task-dispatch-override: ' + id + ': done 没有 reviewer 回执，--no-dispatch 覆盖：' + reason)
    return
  }
  if (legacyPass('done')) return
  return reject(
    'dispatch gate: done: task ' + id + ' 本轮的 reviewer 回执尚未闭合或不是 outcome=ok — ' +
      '先 flow task claim ' + id + ' --agent <name> --role reviewer，再 flow task release ' + id +
      ' --agent <name> --outcome ok；确需无独立审查收口时用 flow task update ' + id +
      " --stage done --no-dispatch --reason '<原因>'",
  )
}

// ------------------------------------------- task artifacts (2026-11-13 T-20261113170144)

/** 交接产物只存指针：正文落 .agents/reports/<task-id>/，任务记录里留摘要 + sha256。 */
export const ARTIFACT_MAX_PER_ROLE = 3
const ARTIFACTS_DIR = '.agents/reports'
const SHA256_HEX_RE = /^[a-f0-9]{64}$/

function artifactsListOf(task) {
  return isPlainObject(task) && Array.isArray(task.artifacts) ? task.artifacts : []
}

/** 每角色只保留最近 N 条（按追加顺序；剪枝只删指针，不删报告文件）。 */
function pruneArtifacts(list) {
  const kept = []
  const totals = new Map()
  for (const item of list) {
    if (isPlainObject(item) === false) continue
    totals.set(item.role, (totals.get(item.role) ?? 0) + 1)
  }
  const seen = new Map()
  for (const item of list) {
    if (isPlainObject(item) === false) continue
    const role = item.role
    seen.set(role, (seen.get(role) ?? 0) + 1)
    const total = totals.get(role) ?? 0
    if (total - seen.get(role) < ARTIFACT_MAX_PER_ROLE) kept.push(item)
  }
  return kept
}

/** 校验/归一 artifacts 字段（只保留已知键；老记录没有该键时不补）。 */
function validateArtifactsField(record) {
  if (record.artifacts === undefined) return
  if (record.artifacts === null) {
    record.artifacts = []
    return
  }
  if (Array.isArray(record.artifacts) === false) throw invalid('artifacts must be an array')
  record.artifacts = record.artifacts.map((item, index) => {
    const at = 'artifacts[' + index + ']'
    if (isPlainObject(item) === false) throw invalid(at + ' must be an object')
    if (CLAIM_ROLES.includes(item.role) === false) {
      throw invalid(at + '.role must be one of ' + CLAIM_ROLES.join(', '))
    }
    if (typeof item.stage !== 'string' || STAGE_IDS.includes(item.stage) === false) {
      throw invalid(at + '.stage must be one of ' + STAGE_IDS.join(', '))
    }
    const path = typeof item.path === 'string' ? item.path.trim() : ''
    const taskSegment = typeof record.id === 'string' && record.id !== '' ? ARTIFACTS_DIR + '/' + record.id + '/' : ''
    if (
      path === '' ||
      path.includes('..') ||
      taskSegment === '' ||
      path.startsWith(taskSegment) === false
    ) {
      throw invalid(at + '.path must be under ' + (taskSegment === '' ? ARTIFACTS_DIR + '/<task-id>/' : taskSegment))
    }
    if (typeof item.sha256 !== 'string' || SHA256_HEX_RE.test(item.sha256) === false) {
      throw invalid(at + '.sha256 must be 64 lowercase hex characters')
    }
    if (typeof item.at !== 'string' || item.at.trim() === '') throw invalid(at + '.at must be a timestamp')
    return {
      role: item.role,
      stage: item.stage,
      summary: typeof item.summary === 'string' ? item.summary : '',
      path,
      sha256: item.sha256,
      agent: typeof item.agent === 'string' ? item.agent : '',
      at: item.at.trim(),
    }
  })
}

function reportFileName(dir, role, at) {
  const stamp = at.replace(/[^0-9]/g, '').slice(0, 14)
  let name = role + '-' + stamp + '.md'
  let suffix = 2
  while (existsSync(join(dir, name))) {
    name = role + '-' + stamp + '-' + suffix + '.md'
    suffix += 1
  }
  return name
}

/** 拷贝正文到 .agents/reports 并生成指针（调用方持锁）。 */
function buildArtifact(root, task, input) {
  const role = typeof input.role === 'string' ? input.role.trim() : ''
  if (CLAIM_ROLES.includes(role) === false) {
    throw invalid('artifact role must be one of ' + CLAIM_ROLES.join(', '))
  }
  const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
  if (summary === '') throw invalid('artifact summary must be a non-empty string (--summary)')
  const file = typeof input.file === 'string' ? input.file.trim() : ''
  if (file === '') throw invalid('artifact file must be a non-empty path (--file)')
  const source = resolve(root, file)
  let sourceStat
  try {
    sourceStat = lstatSync(source)
  } catch {
    throw invalid('artifact source file not found: ' + file)
  }
  /* 只接受项目根内的**普通文件**：软链一律拒绝（readFileSync 会跟随软链，能读仓外），
     绝对路径/../ 逃逸再用 realpath 复核一次。 */
  if (sourceStat.isFile() === false) {
    throw invalid('artifact source must be a regular file inside the project (symlinks are rejected): ' + file)
  }
  const realSource = realpathSync(source)
  const realRoot = realpathSync(root)
  if (realSource !== realRoot && realSource.startsWith(realRoot + sep) === false) {
    throw invalid('artifact source must be inside the project root: ' + file)
  }
  const bytes = readFileSync(realSource)
  const at = formatIso()
  const dir = join(root, ARTIFACTS_DIR, task.id)
  mkdirSync(dir, { recursive: true })
  const name = reportFileName(dir, role, at)
  writeFileSync(join(dir, name), bytes)
  return {
    role,
    stage: projectTaskStage(task).stage,
    summary,
    path: toPosix(join(ARTIFACTS_DIR, task.id, name)),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    agent: typeof input.agent === 'string' ? input.agent.trim() : '',
    at,
  }
}

/** flow task art put：登记一条交接产物指针（正文拷贝进 .agents/reports）。 */
export function putArtifact(root, contract, id, input) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const value = isPlainObject(input) ? input : {}
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.tasks, id, 'task')
    const pointer = buildArtifact(root, current, value)
    const artifacts = pruneArtifacts([...artifactsListOf(current), pointer])
    const next = stampTaskTimes(current, applyTaskPatch(current, { artifacts }), pointer.at)
    writeJsonAtomic(join(paths.tasks, next.id + '.json'), next)
    return projectTaskStage(projectTaskType(next))
  })
}

/** flow task art list：某张卡的产物指针（可按 role 过滤），按追加顺序。 */
export function listArtifacts(root, contract, id, options = {}) {
  const record = getTask(root, contract, id)
  const role = isPlainObject(options) && typeof options.role === 'string' ? options.role.trim() : ''
  const list = artifactsListOf(record)
  return role === '' ? list : list.filter((item) => item.role === role)
}

/** flow task art show：某角色最近一条产物 + 正文（正文缺失时 content 为 ''）。 */
export function readArtifact(root, contract, id, options = {}) {
  const role = isPlainObject(options) && typeof options.role === 'string' ? options.role.trim() : ''
  if (CLAIM_ROLES.includes(role) === false) {
    throw invalid('artifact role must be one of ' + CLAIM_ROLES.join(', '))
  }
  const record = getTask(root, contract, id)
  const list = artifactsListOf(record).filter((item) => item.role === role)
  if (list.length === 0) {
    throw new FlowError('not-found', 'task ' + id + ' has no artifact for role ' + role)
  }
  const artifact = list[list.length - 1]
  let content = ''
  try {
    content = readFileSync(join(root, artifact.path), 'utf8')
  } catch {
    content = ''
  }
  return { task: id, role, artifact, content }
}

/** 阶段交接警告（不阻断）：缺对应角色产物时给 task-artifact-missing。 */
export function assertArtifactHandoff(task, options = {}) {
  const bag = isPlainObject(options) ? options : {}
  if (bag.source === 'internal') return
  const from = typeof bag.from === 'string' ? bag.from : ''
  const to = typeof bag.to === 'string' ? bag.to : ''
  const role = ARTIFACT_HANDOFF_ROLES[from + '>' + to]
  if (role === undefined) return
  if (isPlainObject(task) === false || typeof task.id !== 'string' || task.id === '') return
  if (artifactsListOf(task).some((item) => isPlainObject(item) && item.role === role)) return
  noteWarning(
    'task-artifact-missing: ' + task.id + ': →' + to + ' 前没有 ' + role + ' 交接产物；' +
      '建议 flow task art put ' + task.id + ' --role ' + role + ' --summary <摘要> --file <报告文件>',
  )
}

/** 阶段交接需要的产物角色（single source，与 CONTRACT §3.2 一致）。 */
const ARTIFACT_HANDOFF_ROLES = Object.freeze({
  'analyzing>queued-implementation': 'analyzer',
  'implementing>queued-review': 'implementer',
  'reviewing>done': 'reviewer',
})

// ---------------------------------------------------------------- tasks

/** Array whose elements are strings or plain objects (legacy acceptance entries). */
function arrayOfStringsOrObjects(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`)
  return value.map((entry, index) => {
    if (typeof entry === 'string') return entry
    if (isPlainObject(entry)) return deepClone(entry)
    throw invalid(`${label}[${index}] must be a string or an object`)
  })
}

function validateTaskFields(record) {
  record.title = requireText(record.title, 'title')
  // `type` is required on add (checked by buildTask) and optional on update:
  // legacy records may omit the key entirely, and their read projection is null.
  if (record.type !== undefined) {
    if (record.type === null || record.type === '') throw invalid(`type must be one of ${TASK_TYPES.join(', ')}`)
    if (typeof record.type !== 'string') throw invalid(`type must be one of ${TASK_TYPES.join(', ')}`)
    const type = record.type.trim()
    if (!TASK_TYPES.includes(type)) throw invalid(`type must be one of ${TASK_TYPES.join(', ')}`)
    record.type = type
  }
  // `stage` (task-60) is optional: legacy records omit it and the read projection
  // derives one from `status` (lib/stage.mjs). When present it must be one of the nine ids.
  if (record.stage !== undefined) {
    if (typeof record.stage !== 'string' || STAGE_IDS.includes(record.stage.trim()) === false) {
      throw invalid(`stage must be one of ${STAGE_IDS.join(', ')}`)
    }
    record.stage = record.stage.trim()
  }
  // `source` (task-64 P1) records the creation-time origin of an auto-captured
  // task: `{kind:'utterance', key, at}`. It is a **create-only** fact — the key is
  // the dedupe material, so rewriting it would let one sentence become two tasks
  // (or two become one). `applyTaskPatch` therefore rejects it like any unknown
  // key: it is deliberately absent from `TASK_UPDATABLE_KEYS`.
  if (record.source !== undefined) {
    if (isPlainObject(record.source) === false) throw invalid('source must be an object')
    /* Capture classification (D-20261108-01 = degrade): `control` marks a
       control-word sentence that stays in the ledger but never enters the stack. */
    if (record.source.kind !== 'utterance' && record.source.kind !== 'control') {
      throw invalid("source.kind must be one of 'utterance', 'control'")
    }
    const sourceKey = typeof record.source.key === 'string' ? record.source.key.trim() : ''
    if (sourceKey === '') throw invalid('source.key must be a non-empty string')
    const sourceAt = typeof record.source.at === 'string' ? record.source.at.trim() : ''
    if (sourceAt === '') throw invalid('source.at must be a non-empty timestamp string')
    /* `source.branch`（2026-11-09 审计项 11）：捕获时所在 git 分支，面板任务行
       的分支徽标读它。与 `source.key` 同级是 create-only 事实（不迁就 update），
       非 git 仓库/分离 HEAD 时不存在该键（不是 null 占位）。 */
    if (record.source.branch !== undefined && record.source.branch !== null) {
      if (typeof record.source.branch !== 'string') throw invalid('source.branch must be a string')
      const branch = record.source.branch.trim()
      if (branch === '') throw invalid('source.branch must be a non-empty string')
      record.source.branch = branch
    }
    record.source = { ...record.source, key: sourceKey, at: sourceAt }
    /* `source.attachments` (capture fidelity): durable refs carried by the
       message, normalized by `lib/capture.mjs` to
       `{kind:'image'|'file', attachmentId, …}`. It is a create-only fact on the
       same footing as `source.key` — never on `TASK_UPDATABLE_KEYS` — and is
       validated strictly here because a malformed projection would otherwise be
       silently written to disk. */
    if (record.source.attachments !== undefined) {
      if (Array.isArray(record.source.attachments) === false) throw invalid('source.attachments must be an array')
      record.source.attachments = record.source.attachments.map((entry, index) => {
        const at = `source.attachments[${index}]`
        if (isPlainObject(entry) === false) throw invalid(`${at} must be an object`)
        if (entry.kind !== 'image' && entry.kind !== 'file') throw invalid(`${at}.kind must be one of 'image', 'file'`)
        const attachmentId = typeof entry.attachmentId === 'string' ? entry.attachmentId.trim() : ''
        if (attachmentId === '') throw invalid(`${at}.attachmentId must be a non-empty string`)
        if (entry.kind === 'image') {
          const mediaType = typeof entry.mediaType === 'string' ? entry.mediaType.trim() : ''
          if (mediaType === '') throw invalid(`${at}.mediaType must be a non-empty string`)
          if (Number.isInteger(entry.bytes) === false || entry.bytes < 0) throw invalid(`${at}.bytes must be a non-negative integer`)
          if (Number.isInteger(entry.width) === false || entry.width <= 0) throw invalid(`${at}.width must be a positive integer`)
          if (Number.isInteger(entry.height) === false || entry.height <= 0) throw invalid(`${at}.height must be a positive integer`)
          if (entry.name !== undefined && typeof entry.name !== 'string') throw invalid(`${at}.name must be a string`)
          if (entry.offloaded !== undefined && entry.offloaded !== true) throw invalid(`${at}.offloaded must be true when present`)
          const image = {
            kind: 'image',
            attachmentId,
            mediaType,
            bytes: entry.bytes,
            width: entry.width,
            height: entry.height,
          }
          if (entry.name !== undefined) image.name = entry.name
          if (entry.offloaded === true) image.offloaded = true
          return image
        }
        const name = typeof entry.name === 'string' ? entry.name.trim() : ''
        if (name === '') throw invalid(`${at}.name must be a non-empty string`)
        if (Number.isInteger(entry.bytes) === false || entry.bytes < 0) throw invalid(`${at}.bytes must be a non-negative integer`)
        return { kind: 'file', attachmentId, name, bytes: entry.bytes }
      })
    }
  }
  // `team` (task-73 P3a / task-83 P3b) links a ledger task to the external Team
  // board: `{taskId, revision, owner, syncedAt}`, or `null` when unlinked.
  // Writable from `TASK_UPDATABLE_KEYS` (task-83) but only reached by the
  // dedicated entries `linkTask`/`unlinkTask`: the tool whitelist does not carry
  // it and the CLI has no `--team` flag on `task update`, so no session can
  // rewrite a link by patching. Optional on every existing record.
  if (record.team !== undefined && record.team !== null) {
    if (isPlainObject(record.team) === false) throw invalid('team must be an object')
    const team = record.team
    const taskId = typeof team.taskId === 'string' ? team.taskId.trim() : ''
    if (taskId === '') throw invalid('team.taskId must be a non-empty string')
    if (Number.isInteger(team.revision) === false || team.revision < 0) {
      throw invalid('team.revision must be a non-negative integer')
    }
    if (team.owner !== null && team.owner !== undefined && typeof team.owner !== 'string') {
      throw invalid('team.owner must be a string or null')
    }
    if (isStamp(team.syncedAt) === false) throw invalid('team.syncedAt must be a non-empty timestamp string')
    record.team = {
      taskId,
      revision: team.revision,
      owner: team.owner === undefined ? null : team.owner,
      syncedAt: team.syncedAt.trim(),
    }
  } else if (record.team === null) {
    record.team = null
  }
  // `veto` (P4) records an analysis rejection: `{by:'analysis', reason, at}`.
  // Updatable because a task created before the rejection gets it later; the
  // field is never cleared by an answer (the history must survive `modify`).
  if (record.veto !== undefined) {
    if (isPlainObject(record.veto) === false) throw invalid('veto must be an object')
    if (record.veto.by !== 'analysis') throw invalid("veto.by must be 'analysis'")
    const reason = typeof record.veto.reason === 'string' ? record.veto.reason.trim() : ''
    if (reason === '') throw invalid('veto.reason must be a non-empty string')
    if (isStamp(record.veto.at) === false) throw invalid('veto.at must be a non-empty timestamp string')
    record.veto = { by: 'analysis', reason, at: record.veto.at.trim() }
  }
  // `decision` (P4) points at the open `flow_decision` a main-task veto created;
  // the user's answer clears it. `null` means "no pending veto decision".
  if (record.decision !== undefined) {
    if (record.decision === null) {
      record.decision = null
    } else if (typeof record.decision === 'string' && DECISION_ID_RE.test(record.decision.trim())) {
      record.decision = record.decision.trim()
    } else {
      throw invalid('decision must be a decision id or null')
    }
  }
  record.status = optionalEnum(record.status, 'status', TASK_STATUS, 'draft')
  record.cancelReason = optionalText(record.cancelReason, 'cancelReason', '')
  if (record.cancelled_at !== undefined && record.cancelled_at !== null && isStamp(record.cancelled_at) === false) {
    throw invalid('cancelled_at must be a timestamp string or null')
  }
  if (record.mergedInto !== undefined && record.mergedInto !== null) {
    if (typeof record.mergedInto !== 'string' || REF_ID_RE.test(record.mergedInto.trim()) === false) {
      throw invalid('mergedInto must be a task id string or null')
    }
    if (record.id !== undefined && record.mergedInto.trim() === record.id) throw invalid('task cannot merge into itself')
    record.mergedInto = record.mergedInto.trim()
  }
  if (record.mount !== undefined && record.mount !== null) {
    record.mount = normalizeMountField(record.mount)
  } else if (record.mount === null) {
    record.mount = null
  }
  validateDispatchOrderField(record)
  record.owner = optionalText(record.owner, 'owner', '')
  record.notes = optionalText(record.notes, 'notes', '')
  // Optional parent task (`T-13`): format only here; existence/cycles need the
  // ledger and are checked by the write paths under the lock.
  if (record.parent === undefined) {
    record.parent = null
  } else if (record.parent === null || record.parent === '') {
    record.parent = null
  } else if (typeof record.parent !== 'string') {
    throw invalid('task parent must be a task id string or null')
  } else {
    const parent = record.parent.trim()
    if (parent === '') record.parent = null
    else if (!REF_ID_RE.test(parent)) throw invalid(`parent is not a valid task id: ${JSON.stringify(record.parent)}`)
    else if (record.id !== undefined && parent === record.id) throw invalid('task parent cannot reference itself')
    else record.parent = parent
  }
  // Optional experiment link (T-12): format only here; whether the experiment
  // exists is checked by the write paths (they hold the store paths) as a warning.
  if (record.experiment !== undefined) {
    if (record.experiment === null || record.experiment === '') {
      record.experiment = null
    } else if (typeof record.experiment !== 'string') {
      throw invalid('experiment must be an experiment id string or null')
    } else {
      const experiment = record.experiment.trim()
      if (experiment === '') record.experiment = null
      else if (!REF_ID_RE.test(experiment)) {
        throw invalid(`experiment is not a valid experiment id: ${JSON.stringify(record.experiment)}`)
      } else record.experiment = experiment
    }
  }
  if (record.scope === undefined || record.scope === null) record.scope = { allow: [], deny: [] }
  if (!isPlainObject(record.scope)) throw invalid('scope must be an object with allow/deny arrays')
  record.scope = {
    ...record.scope,
    allow: stringArray(record.scope.allow, 'scope.allow'),
    deny: stringArray(record.scope.deny, 'scope.deny'),
  }
  record.acceptance = arrayOfStringsOrObjects(record.acceptance, 'acceptance')
  if (record.checkpoints === undefined || record.checkpoints === null) record.checkpoints = []
  if (!Array.isArray(record.checkpoints)) throw invalid('checkpoints must be an array')
  for (const checkpoint of record.checkpoints) {
    if (!isPlainObject(checkpoint) && typeof checkpoint !== 'string') {
      throw invalid('checkpoints must contain objects or strings')
    }
  }
  validateClaimCheckpoints(record)
  validateArtifactsField(record)
  // 验收回执（`flow task verify`）：系统键，形状在这里统一校验/归一。
  validateVerificationField(record)
  record.commits = stringArray(record.commits, 'commits')
  return record
}

/**
 * `stage` → `status` derivation (task-60). `stage` is the behaviour layer and
 * `status` the compatibility view, so a write that names a stage also decides the
 * status; naming **both** is allowed only when they agree.
 *
 * Only an explicit `stage` in the input triggers this: a status-only patch keeps
 * working exactly as before (the archive sweep and the heartbeat claim both write
 * `status`), and a legacy record without a stage is left untouched.
 */
function deriveTaskStatus(record, source) {
  if (isPlainObject(source) === false || Object.hasOwn(source, 'stage') === false) return record
  const derived = stageToStatus(record.stage)
  if (Object.hasOwn(source, 'status') && record.status !== derived) {
    throw invalid(
      `stage ${record.stage} implies status ${derived}, but status ${JSON.stringify(source.status)} was also given`,
    )
  }
  record.status = derived
  return record
}

export function buildTask(input, ctx) {
  if (!isPlainObject(input)) throw invalid('task must be an object')
  // Reject unknown keys instead of silently dropping them: `goal` in particular
  // is gone (merged into `title`), and a dropped write is a swallowed write.
  for (const key of Object.keys(input)) {
    if (TASK_CREATE_KEYS.includes(key)) continue
    throw invalid(
      `task ${key} is not a supported field${key === 'goal' ? ' (goal was merged into title)' : ''}`,
    )
  }
  const requestedType = input.type
  if (requestedType === undefined || requestedType === null || (typeof requestedType === 'string' && requestedType.trim() === '')) {
    throw invalid(`type is required (one of ${TASK_TYPES.join(', ')})`)
  }
  const record = deepClone(input)
  record.schema = 1
  if (input.id === undefined) {
    record.id = nextTaskId(ctx.existingIds, ctx.date ?? new Date())
  } else {
    assertPattern(input.id, TASK_ID_RE, 'task id')
    if (ctx.existingIds.has(input.id)) throw new FlowError('conflict', `task ${input.id} already exists`)
    record.id = input.id
  }
  for (const [key, fallback] of Object.entries(TASK_DEFAULTS)) {
    if (record[key] === undefined) record[key] = deepClone(fallback)
  }
  validateTaskFields(record)
  deriveTaskStatus(record, input)
  const now = formatIso()
  record.created_at = typeof input.created_at === 'string' ? input.created_at : now
  record.updated_at = typeof input.updated_at === 'string' ? input.updated_at : now
  return record
}

/** ISO-looking timestamp (shape only; read/write never trusts the value beyond that). */
function isStamp(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Stamp the completion/archive moments on one task transition (T-09).
 *
 * - entering `done` → `done_at = now`; staying `done` keeps the first moment;
 * - entering `archived` → `archived_at = now` and the existing `done_at` is kept
 *   (T-07 used to overwrite `updated_at` with the archive day, losing the real
 *   completion day);
 * - leaving done/archived → both fields are cleared.
 *
 * A timestamp failure is a warning only: the task write itself must still land.
 */
export function stampTaskTimes(previous, next, nowIso) {
  try {
    const before = isPlainObject(previous) ? previous : {}
    const previousStatus = typeof before.status === 'string' ? before.status : ''
    const nextStatus = typeof next.status === 'string' ? next.status : ''
    if (nextStatus === 'done') {
      next.done_at = previousStatus === 'done' && isStamp(before.done_at) ? before.done_at : nowIso
      next.archived_at = null
    } else if (nextStatus === 'archived') {
      next.done_at = isStamp(before.done_at) ? before.done_at : isStamp(next.done_at) ? next.done_at : null
      next.archived_at = previousStatus === 'archived' && isStamp(before.archived_at) ? before.archived_at : nowIso
    } else {
      next.done_at = null
      next.archived_at = null
    }
  } catch (error) {
    noteWarning(`task-time-stamp: ${isPlainObject(next) && typeof next.id === 'string' ? next.id : '?'}: ${error.message}`)
  }
  return next
}

/**
 * Read projection for the two optional moments: a record predating T-09 falls
 * back to `updated_at` (approximate, documented in CONTRACT §3.2). Nothing is
 * written and the original object is returned untouched when no fallback applies.
 */
function projectTaskTimes(record) {
  if (!isPlainObject(record)) return record
  const updated = isStamp(record.updated_at) ? record.updated_at : null
  // Both fields are projected as `null`, never as an own `undefined` value.
  // `JSON.stringify` drops an own key holding `undefined`, so such a copy is
  // "lossy JSON": the host tool layer refuses it (`snapshotJsonValue`), and the
  // in-process tool output silently loses a field the CLI/HTTP output keeps.
  // That was the real cause of `flow_task list` failing on any store holding a
  // pre-T-09 `done` record.
  let doneAt = isStamp(record.done_at) ? record.done_at : null
  let archivedAt = isStamp(record.archived_at) ? record.archived_at : null
  let doneAtEstimated = false
  let archivedAtEstimated = false
  let changed = false
  if (doneAt === null && (record.status === 'done' || record.status === 'archived')) {
    doneAt = updated
    doneAtEstimated = true
    changed = true
  }
  if (archivedAt === null && record.status === 'archived') {
    archivedAt = updated
    archivedAtEstimated = true
    changed = true
  }
  if (changed === false) return record
  // Projection-only approximation markers: a record predating T-09 has no
  // `done_at`/`archived_at`, so the moment shown here is `updated_at`. The
  // markers let `deriveTrend` keep marking that history with `≈`; they exist
  // only on this read copy and are never written back to the store file.
  return {
    ...record,
    done_at: doneAt,
    archived_at: archivedAt,
    doneAtEstimated,
    archivedAtEstimated,
  }
}

export function applyTaskPatch(record, patch) {
  if (!isPlainObject(patch)) throw invalid('task patch must be an object')
  for (const key of TASK_IMMUTABLE_KEYS) {
    if (Object.hasOwn(patch, key)) throw invalid(`task ${key} cannot be changed`)
  }
  // Everything else must be on the explicit whitelist; unknown keys (a revived
  // `goal`, a typo) are rejected rather than written. The message is the same
  // "cannot be changed" sentence so both ends stay one wording (CONTRACT §3.2).
  for (const key of Object.keys(patch)) {
    if (TASK_UPDATABLE_KEYS.includes(key) || TASK_SYSTEM_KEYS.includes(key)) continue
    throw invalid(`task ${key} cannot be changed`)
  }
  const next = { ...record }
  for (const [key, value] of Object.entries(deepClone(patch))) {
    if (key === 'scope' && isPlainObject(value) && isPlainObject(record.scope)) {
      next.scope = { ...record.scope, ...value }
    } else {
      next[key] = value
    }
  }
  next.id = record.id
  next.schema = 1
  next.created_at = record.created_at
  // A legacy record may carry a hand-written `type: null` / `''`: that is *missing*,
  // not invalid (CONTRACT §3.2), and it must not block patches to every other field.
  // Relax it for **this path only** — `validateTaskFields` is shared with `buildTask`
  // (new records must name a type) and `normalizeTaskFormat` (a missing type keeps the
  // whole record unwritten so a legacy `goal` is never dropped). Hiding the key for the
  // check keeps the record un-migrated: the projection still reads `null` and
  // `normalizeTaskFormat({fix:true})` stays the only filler. A non-empty string outside
  // the ten values (`"nope"`) still throws.
  const legacyType = next.type === null || next.type === ''
  if (legacyType) delete next.type
  validateTaskFields(next)
  if (legacyType) next.type = record.type
  deriveTaskStatus(next, patch)
  next.updated_at = formatIso()
  return next
}

export function taskIds(paths) {
  return new Set(readCollection(paths.tasks).map((item) => item.record.id).filter((id) => typeof id === 'string'))
}

/**
 * Normalize a user-supplied parent argument (`task --parent` / `flow_task.parent`):
 * trim; `''`, `none`, `null` (case-insensitive) mean "root" → null. Anything
 * else is returned trimmed and still goes through REF_ID_RE + relation checks.
 * Shared by `bin/flow.mjs` and `index.js` so both entry points cannot drift.
 */
export function normalizeParentInput(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return value
  const parent = value.trim()
  return parent === '' || /^(none|null)$/i.test(parent) ? null : parent
}

/**
 * Normalize a user-supplied owner argument (`task update --owner` / `flow_task.owner`).
 * `''`, `none`, `null` (case-insensitive) mean "unassigned session" → `''`;
 * anything else is trimmed and kept. Absent (`undefined`) stays `undefined` so
 * the patch does not touch the field. The session-ownership rules in
 * {@link updateTask} treat `''` as the only "free" value.
 */
export function normalizeOwnerInput(value) {
  if (value === undefined) return undefined
  if (value === null) return ''
  if (typeof value !== 'string') return value
  const owner = value.trim()
  return /^(none|null)$/i.test(owner) ? '' : owner
}

/** Tasks by id, excluding `selfId` (a parent cannot be the record itself). */
function taskRecordMap(paths, selfId) {
  return new Map(
    readCollection(paths.tasks)
      .map((item) => item.record)
      .filter((record) => isPlainObject(record) && typeof record.id === 'string' && record.id !== selfId)
      .map((record) => [record.id, record]),
  )
}

/** Write-path guard: the parent must exist and the parent chain must not cycle. */
function assertTaskParent(record, paths) {
  if (typeof record.parent !== 'string' || record.parent === '') return
  const byId = taskRecordMap(paths, record.id)
  if (byId.has(record.parent) === false) {
    throw invalid(`task parent does not exist: ${record.parent} (parent-not-found)`)
  }
  if (createsCycle({ id: record.id }, record.parent, byId) === true) {
    throw invalid(`task parent cycle detected: ${record.id} -> … -> ${record.parent} (parent-cycle)`)
  }
}

/**
 * Read projection for `parent`: a missing/unknown parent or a cycle is treated
 * as a root (`parent: null`) and never throws — deleting a parent turns its
 * children into roots without rewriting them (CONTRACT §3.2, no migration).
 */
function projectTaskParent(record, byId) {
  if (!isPlainObject(record) || typeof record.parent !== 'string' || record.parent === '') return record
  if (byId.has(record.parent) === false || createsCycle({ id: record.id }, record.parent, byId) === true) {
    return { ...record, parent: null }
  }
  return record
}

/** Legacy tasks predate the required `type`; the read projection exposes null. */
function projectTaskType(record) {
  if (!isPlainObject(record)) return record
  if (Object.hasOwn(record, 'type')) return record
  return { ...record, type: null }
}

/**
 * Legacy tasks predate `stage`; the read projection derives it from `status`
 * (single source: `lib/stage.mjs`) and never writes it back.
 *
 * Deriving `DEFAULT_STAGE` unconditionally was a real bug (task-68): a `done`
 * record then looked unfinished, so it landed on the capture stack and inflated
 * the §9 counts.
 */
export function projectTaskStage(record) {
  if (!isPlainObject(record)) return record
  if (Object.hasOwn(record, 'stage')) return record
  return { ...record, stage: legacyStageFromStatus(record.status) }
}

/** One task row: time (T-09) → parent (T-13) → type (T-15) → stage (task-60). */
function projectTaskRecord(record, byId) {
  return projectTaskStage(projectTaskType(projectTaskParent(projectTaskTimes(record), byId)))
}

/**
 * Canonical JSON for hashing (object keys sorted, recursively). Records are
 * plain JSON (no `undefined`/cycles), so a stable string is always available —
 * both the write path and `taskRevision()` must agree byte for byte.
 */
function canonicalTaskJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalTaskJson(item)).join(',')}]`
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalTaskJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * 一条任务记录的**并发签名**（2026-11-11 T-20261111155622-02）。
 *
 * 为什么不是 `updated_at`：时间戳只到秒（T-09 同秒批量写是常态），两个会话在
 * 同一秒内先后改一条记录时无法区分——「审查结论落到别人改过阶段的记录上」正是
 * 这种碰撞。这里对**整条记录**做确定性哈希（键序无关），任何字段变化（阶段、
 * notes、owner、checkpoints…）都会换签名。
 *
 * @param {object} record 磁盘形状的任务记录（不是读投影）
 * @returns {string} 16 位十六进制签名；非法输入返回 `''`
 */
export function taskRevision(record) {
  try {
    if (isPlainObject(record) === false) return ''
    return createHash('sha256').update(canonicalTaskJson(record)).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

/**
 * 读一条任务的当前 revision（给工具/CLI 提供「读→带 revision 写」的入口）。
 * 未找到时按 store 语义抛 `not-found`。
 */
export function taskRevisionOf(root, contract, id) {
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c)
  const record = readRecord(paths.tasks, id, 'task')
  return taskRevision(record)
}

export function listTasks(root, contract, options = {}) {
  const memo = pathMemoOf(options)
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c, { pathMemo: memo })
  const records = readCollection(paths.tasks, unreadableCollector(options)).map((item) => item.record)
  const byId = new Map(
    records.filter((record) => isPlainObject(record) && typeof record.id === 'string').map((record) => [record.id, record]),
  )
  return sortByUpdatedDesc(records.map((record) => projectTaskRecord(record, byId)))
}

export function getTask(root, contract, id) {
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c)
  const byId = new Map(
    readCollection(paths.tasks)
      .map((item) => item.record)
      .filter((record) => isPlainObject(record) && typeof record.id === 'string')
      .map((record) => [record.id, record]),
  )
  return projectTaskRecord(readRecord(paths.tasks, id, 'task'), byId)
}

export function addTask(root, contract, input, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  // `options.now` is a test seam for same-second/next-second sequences; callers
  // (CLI/tools) omit it and get the real clock.
  const injected = isPlainObject(options) ? options.now : undefined
  const injectedDate = injected === undefined ? null : new Date(injected)
  const date = injectedDate !== null && Number.isFinite(injectedDate.getTime()) ? injectedDate : new Date()
  return withLock(root, c, (paths) => {
    const record = buildTask(input, { existingIds: taskIds(paths), date })
    assertTaskParent(record, paths)
    warnTaskExperiment(record, paths)
    assertTargetFree(paths.tasks, record.id)
    /* 创建即 done/archived 也是「阶段进入终态」：补 done_at/archived_at，并跑
       验收门——否则 `task add --stage done` 就是绕过验收的另一个后门。 */
    assertTaskMountTarget(root, record)
    const created = projectTaskStage(record)
    /* add 也走挂载门：不允许绕过阶段门创建 root+implementing 的无 mount 卡。 */
    assertMountProcessingGate(record, { source: 'session', from: '', to: created.stage }, root, c)
    if (created.stage === 'done' || created.stage === 'archived' || created.stage === 'cancelled') {
      stampTaskTimes(null, record, formatIso())
    }
    /* 创建即撤销也要带原因；合并去向必须在台账里存在。 */
    if (created.stage === 'cancelled') {
      const reason = typeof input.cancelReason === 'string' ? input.cancelReason.trim() : ''
      if (reason === '') {
        throw invalid("task add --stage cancelled 必须带原因：flow task add … --stage cancelled --reason '<原因>'")
      }
      record.cancelReason = reason
      record.cancelled_at = formatIso()
      if (typeof input.mergedInto === 'string' && input.mergedInto.trim() !== '') {
        const target = input.mergedInto.trim()
        if (taskIds(paths).has(target) === false) throw invalid('mergedInto target not found: ' + target)
        record.mergedInto = target
      } else {
        record.mergedInto = null
      }
    }
    if (created.stage === 'reviewing' || created.stage === 'done') {
      assertAcceptanceGate(c, created, { source: 'session', from: '', to: created.stage })
    }
    writeJsonAtomic(join(paths.tasks, `${record.id}.json`), record)
    return record
  })
}

/** Human-readable type for the `expectedRevision` rejection message. */
function describeRevisionInput(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${typeof value} ${String(value)}`
  }
  return typeof value
}

/**
 * `expectedRevision` 的入参校验（T-20261111183641）。
 *
 * 「没传」与「传了但不合法」必须分开：早先实现只认字符串，number/null/对象会被
 * 静默当成「没传」——调用方以为开了 CAS，实际是无条件覆盖，比不传更危险。只要
 * `options` 上存在这个键，它就必须是非空字符串；空串/空白同样拒绝（它不是任何记录
 * 的签名，静默忽略等于绕过）。只有省略该键才表示「不启用 CAS」。
 *
 * @returns {string} 已 trim 的 revision；空串表示调用方没有要求 CAS
 * @throws {FlowError} `invalid`：键存在但不是非空字符串
 */
function normalizeExpectedRevision(options, id) {
  if (isPlainObject(options) === false || Object.hasOwn(options, 'expectedRevision') === false) return ''
  const raw = options.expectedRevision
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  throw new FlowError(
    'invalid',
    `task ${id} expectedRevision 必须是非空字符串（收到 ${describeRevisionInput(raw)}）；` +
      `不启用 CAS 请省略该选项，不能用空值/非字符串绕过校验`,
  )
}

/**
 * Patch one task record under the store lock.
 *
 * `options.source = 'internal'` exempts this write from the description stage
 * gate (spec §7): only the plugin's own bookkeeping writes pass it (`lib/veto.mjs`
 * closes a vetoed task by moving it to `done`), and it is a **call argument, not a
 * record field** — persisting an exemption level onto the record would make a
 * one-off write permanent, and `source` on a task is the create-time capture fact.
 *
 * @param {string} root project root
 * @param {object} contract flow contract
 * @param {string} id task id
 * @param {object} patch task patch
 * @param {{source?: string, expectedRevision?: string}} [options] write-path options (never written to disk)
 */
export function updateTask(root, contract, id, patch, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  /* Owner is the task's **session** field (D-20261108-05 = extend-owner): the
     caller may write `''`/`none`/`null` to release it back to "unassigned". The
     normalization happens here, once, so CLI/tool/tests cannot drift. */
  const normalizedPatch =
    isPlainObject(patch) && Object.hasOwn(patch, 'owner') ? { ...patch, owner: normalizeOwnerInput(patch.owner) } : patch
  /* CAS 参数在取锁前校验：非法入参既不取锁也不读盘，天然零写入。 */
  const expectedRevision = normalizeExpectedRevision(options, id)
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.tasks, id, 'task')
    /* CAS（2026-11-11 T-20261111155622-02）：调用方可以传 `expectedRevision`
       （`taskRevision()` 的签名），只有记录自它读取后没被别人改过才写入。
       没有它时行为完全不变（不破坏既有调用方）。冲突是**读取后再写**的竞态，
       所以不能静默覆盖——审查结论落到被父会话改过的记录上会让 phase 与 notes
       自相矛盾，且看不出发生过。 */
    if (expectedRevision !== '') {
      const actual = taskRevision(current)
      if (expectedRevision !== actual) {
        const stage = projectTaskStage(current).stage
        throw new FlowError(
          'conflict',
          `task ${id} revision mismatch: expected ${expectedRevision}, current ${actual}` +
            `（stage=${stage ?? '?'}, updated_at=${typeof current.updated_at === 'string' ? current.updated_at : '?'}）；` +
            `记录在你读取后已被并发修改，请重新读取（flow task show ${id}）并用当前 revision 重试`,
        )
      }
    }
    /* Session-ownership guard (CONTRACT §3.2.1 owner). Rules, in order:
       - only a live session may keep others out: a task owned by a session the
         caller proves live cannot be moved to someone else or released, except
         by that session itself;
       - acquiring is self-service: with a caller session, a non-empty owner may
         only be the caller (`''` = release is always allowed when the first rule
         passes).
       `isSessionLive` is injected by the host/tool (agents registry) or CLI
       (heartbeat liveness). A missing callback degrades to "cannot prove live"
       so old callers keep working. */
    if (isPlainObject(normalizedPatch) && Object.hasOwn(normalizedPatch, 'owner')) {
      const before = typeof current.owner === 'string' ? current.owner.trim() : ''
      const after = typeof normalizedPatch.owner === 'string' ? normalizedPatch.owner.trim() : ''
      if (after !== before) {
        const actor =
          isPlainObject(options) && typeof options.actorSession === 'string' ? options.actorSession.trim() : ''
        const isLive =
          isPlainObject(options) && typeof options.isSessionLive === 'function' ? options.isSessionLive : null
        let live = undefined
        if (before !== '' && isLive !== null) {
          try {
            live = isLive(before)
          } catch {
            live = undefined
          }
        }
        if (before !== '' && live === true && actor !== before) {
          throw invalid(
            `task ${id} is owned by active session ${before}; only that session can move or release it`,
          )
        }
        if (after !== '' && actor !== '' && after !== actor) {
          throw invalid(`task ${id} owner can only be the calling session (${actor}) or unassigned`)
        }
      }
    }
    const next = stampTaskTimes(current, applyTaskPatch(current, normalizedPatch), formatIso())
    /* 汇总轮标记是一次性的：父任务一旦落到 done/archived，这轮就结束了。不清除会让
       它留在记录里，将来有人把它退回待分析时又被当成汇总轮（跳过计划门）。
       与阶段派生在同一次内存改写里完成，所以被门禁拒绝时磁盘零残留。 */
    finishAggregateRound(next)
    assertTaskMountTarget(root, next)
    assertTaskParent(next, paths)
    warnTaskExperiment(next, paths)
    // The description gate runs after every patch-level validation and **before**
    // the write: `next` is still a memory object, so a rejected stage change
    // leaves zero residue on disk. `from` must come from the read projection
    // (`projectTaskStage`), never from `current.stage` — legacy records have no
    // `stage` on disk, and `undefined → done` would skip every gate.
    /* 门禁按「投影阶段」判定，而不是只认 patch 里有没有 `stage` 键：
       `status: 'done'` 也会让读投影落到 done（legacy 记录根本没有 stage 字段），
       只认 patch.stage 会让 `--status done` 成为验收门的后门。from/to 都取
       projectTaskStage 的结果，与面板/CLI 看到的阶段完全一致。 */
    const from = projectTaskStage(current).stage
    const to = projectTaskStage(next).stage
    /* 写入来源（决定阶段边与两道门的豁免档位）：`aggregate` 是汇总轮（T-20261111170544）——
       描述门豁免（汇总不产生新语义），验收门与 `session` 同档、不放宽。 */
    const source =
      isPlainObject(options) && typeof options.source === 'string' && options.source !== ''
        ? options.source
        : 'session'
    /* 撤销是终态但不是「完成」：status-only 写 cancelled 会绕过阶段边与原因校验，直接拒绝。 */
    if (
      source !== 'internal' &&
      isPlainObject(normalizedPatch) &&
      normalizedPatch.status === 'cancelled' &&
      Object.hasOwn(normalizedPatch, 'stage') === false
    ) {
      throw invalid(
        'task ' + id + ' status=cancelled 必须与 stage=cancelled 同批写入，并给 --reason <原因>',
      )
    }
    if (typeof to === 'string' && to !== from) {
      /* 阶段边校验（T-20261112151328 S1）：`from → to` 由 lib/stage.mjs 的唯一边表判定，
         拒绝文案直接列出合法后继。挂在这里的理由：`updateTask` 是**唯一的阶段写入口**，
         CLI（lib/cli/tasks.mjs 的 --stage）、flow_task/flow_subtask 走 core、插件收口共用它；
         此前 assertTransition 只存在于 MCP 那一条调用链，CLI/core 可以任意跨级写阶段。
         `source === 'internal'` 豁免：那是插件自身记账（sweep 自动收口、veto delete、
         子任务 remove 等），不是工作流判定；把四条 off-table 内部写登记成显式边属于
         后续卡（S2），本卡只堵「任意调用方都能跨级写」。同阶段重写（from === to）根本不
         进这个分支，只改 notes/owner 的幂等补丁不受影响。 */
      /* 撤销（T-20261113163505）：任意非终态 → cancelled 必须带非空原因；合并时记 mergedInto。
         原因写进记录（cancelReason + cancelled_at），禁止用 notes 之外的方式冒充撤销。 */
      if (to === 'cancelled') {
        const rawReason =
          isPlainObject(options) && typeof options.cancelReason === 'string'
            ? options.cancelReason
            : typeof next.cancelReason === 'string'
              ? next.cancelReason
              : ''
        const reason = rawReason.trim()
        if (reason === '' && source !== 'internal') {
          throw invalid(
            'task ' + id + ' → cancelled 必须带原因：flow task update ' + id +
              " --stage cancelled --reason '<原因>'",
          )
        }
        next.cancelReason = reason === '' ? 'internal cancellation' : reason
        next.cancelled_at = formatIso()
        const rawMerged =
          isPlainObject(options) && typeof options.mergedInto === 'string'
            ? options.mergedInto.trim()
            : typeof next.mergedInto === 'string'
              ? next.mergedInto.trim()
              : ''
        if (rawMerged !== '') {
          const ids = new Set(readCollection(paths.tasks).map((item) => item.record.id))
          if (ids.has(rawMerged) === false) throw invalid('mergedInto target not found: ' + rawMerged)
          if (rawMerged === id) throw invalid('task cannot merge into itself')
          next.mergedInto = rawMerged
        } else {
          next.mergedInto = null
        }
      }
      if (source !== 'internal') assertTransition(from, to)
      if (typeof HOOKS.descriptionGate !== 'function') {
        throw new FlowError('invalid', 'tasks 域未装配 descriptionGate —— 请经由 lib/core.mjs 调用（直接 import 域模块需先 configureTasks）')
      }
      HOOKS.descriptionGate(root, c, next, { source, from, to })
      // 验收门：与描述门同一点、同一次「阶段确实在变」判定。`source: 'internal'`
      // 的插件收口（sweep/veto/迁移）同样豁免——它们不是语义完成，只是收口。
      // `source: 'aggregate'`（汇总轮）**不**随描述门一起豁免：父任务判为完成这件事
      // 必须有验收证据，判据与 `reviewing → done` 完全一样。
      assertAcceptanceGate(c, next, { source, from, to })
      /* 挂载语义（T-20261113165239）：无 mount 的主卡不能直接进入 implementing。 */
      assertMountProcessingGate(next, { source, from, to }, root, c)
      /* 派工回执硬校验（T-20261113163323）：写在验收门之后，被拒时同样零磁盘残留。
         --no-dispatch / --reason 是 CLI 入口的覆盖通道，只对 reviewing→done 生效。 */
      assertDispatchGate(c, next, {
        source,
        from,
        to,
        ...(isPlainObject(options) && options.noDispatch === true
          ? { noDispatch: true, dispatchReason: typeof options.dispatchReason === 'string' ? options.dispatchReason : '' }
          : {}),
      })
      /* 交接产物只警告（T-20261113170144）：观察期不做硬门，存量卡不被一刀切。
         放在派工门之后：被硬门拒掉的这次 update 不该再夹带 artifact 噪声。 */
      assertArtifactHandoff(next, { source, from, to })
    }
    writeJsonAtomic(join(paths.tasks, `${next.id}.json`), next)
    /* 父卡进入终态时，在同一把写锁内收口它的空子卡（T-20261112151422 / M3）。
       不能递归调 updateTask/archiveNoiseTasks：withLock 不可重入（store/contract.mjs
       的 acquireLock 直接取锁），递归会把自己锁死成 conflict。所以这里直接读集合、
       直接写盘，与自动归档共用判据与写盘函数；这等价于 `source: 'internal'` 的
       插件记账写——不跑描述门/验收门，归档痕迹写进子卡 notes。只在**本次确实进入**
       终态时触发（from === to 的重复补丁不再重扫）。 */
    if ((to === 'done' || to === 'archived') && to !== from) {
      archiveNoiseChildren(paths, next.id, formatIso())
    }
    // Same read shape as getTask: legacy rows keep `type: null` and gain `stage`.
    return projectTaskStage(projectTaskType(next))
  })
}

/**
 * 汇总轮标记的收口（T-20261111170544）：任务进入 `done`/`archived` 时清掉
 * `dispatchRound`，让「这一轮汇总已经结束」写在记录里，而不是靠调用方记得清。
 *
 * 只在内存对象上改；`updateTask` 的门禁判定与磁盘写入都在这一步之后，所以一次被拒
 * 的推进不会留下半截标记。
 */
function finishAggregateRound(record) {
  if (isPlainObject(record) === false) return record
  if (record.dispatchRound === undefined) return record
  const stage = projectTaskStage(record).stage
  if (stage === 'done' || stage === 'archived' || stage === 'cancelled') delete record.dispatchRound
  return record
}

/**
 * Release tasks whose owning session is **provably dead** back to "unassigned".
 *
 * The user's rule (D-20261108-05 = extend-owner): an archived/finished session's
 * tasks must not stay locked to a session that no longer exists — they become
 * `owner: ''` so another session can acquire them through a normal update.
 *
 * Safety rails, both deliberate:
 * - a task is only released when its owner has a **heartbeat record** (role
 *   names and hand-written owners are not sessions and stay untouched);
 * - `isSessionLive` (host agents registry / heartbeat liveness) must report
 *   `false`; `foreign` heartbeat rows are kept because another host may still be
 *   running that session. Unknown/missing evidence never releases.
 *
 * @param options `{isSessionLive?: (session:string)=>boolean|undefined, dryRun?}`
 * @returns `{released:[{id,owner}], kept:[id], dryRun}`
 */
export function releaseDeadSessionTasks(root, contract, options = {}) {
  assertInitialized(root)
  const input = isPlainObject(options) ? options : {}
  const isLive = typeof input.isSessionLive === 'function' ? input.isSessionLive : null
  const dryRun = input.dryRun === true
  const c = normalizeContract(root, contract)
  const released = []
  const kept = []
  for (const task of listTasks(root, c)) {
    const owner = typeof task.owner === 'string' ? task.owner.trim() : ''
    if (owner === '') continue
    let status
    try {
      status = heartbeatStatus(root, c, owner)
    } catch {
      kept.push(task.id)
      continue
    }
    if (status.record === null || status.liveness === 'foreign') {
      kept.push(task.id)
      continue
    }
    /* "Provably dead" has three independent proofs, in order: the session
       closed its heartbeat (`endHeartbeat` → status done); its pid/boot is gone;
       or the host registry says it is not live **and** the heartbeat carries no
       live-pid evidence (a session owned by another DSH process must not be
       reaped by this process's registry). */
    let dead = false
    const closed = typeof status.record.status === 'string' && status.record.status.trim() === 'done'
    if (closed || status.liveness === 'dead') {
      dead = true
    } else if (isLive !== null) {
      let live
      try {
        live = isLive(owner)
      } catch {
        live = undefined
      }
      if (live === false && status.liveness !== 'live') dead = true
    }
    if (!dead) {
      kept.push(task.id)
      continue
    }
    released.push({ id: task.id, owner })
    if (!dryRun) updateTask(root, c, task.id, { owner: '' }, { source: 'internal' })
  }
  return { released, kept, dryRun }
}

/**
 * 噪声卡（捕获空卡）的统一判据（T-20261112151422 / M1）。
 *
 * `null` = 可以自动归档；否则返回跳过原因（`skipped` 的统计口径）。判据只看
 * **卡片结构**，绝不按标题关键字过滤：
 * - 阶段还在队列最前端（`queued-analysis` / `analyzing`）——被领取或推进过就不是噪声；
 * - `notes`/`commits`/`checkpoints`/`acceptance` 全空（有进展证据的卡不动）；
 * - 没有子任务（`gate.parents`），`owner === ''`（别人的待办不动）；
 * - 年龄达到 `gate.olderThanHours`（从 `source.at`，退化到 `created_at` 起算）。
 *
 * 根卡（`parent` 为空）还要求 `source.kind === 'utterance'`：**手写空卡是人的意图**
 * （占位、先建卡后补内容），只有 capture 自动落盘的卡才是捕获噪声，误伤手写卡比漏收
 * 一张噪声卡更糟。子卡由父卡的级联收口（`gate.cascade`）豁免这条来源判据，但全局
 * sweep 不动子卡（`subtask`）——子任务随父任务走，不单独判噪声。
 */
function noiseTaskSkipReason(task, gate) {
  if (isPlainObject(task) === false) return 'unreadable'
  const stage = projectTaskStage(task).stage
  if (stage !== 'queued-analysis' && stage !== 'analyzing') return 'stage'
  if (typeof task.notes === 'string' && task.notes.trim() !== '') return 'notes'
  if (Array.isArray(task.commits) && task.commits.length > 0) return 'commits'
  if (Array.isArray(task.checkpoints) && task.checkpoints.length > 0) return 'checkpoints'
  if (Array.isArray(task.acceptance) && task.acceptance.length > 0) return 'acceptance'
  if (gate.parents.has(task.id)) return 'has-children'
  if (typeof task.owner === 'string' && task.owner.trim() !== '') return 'owned'
  const hasParent = typeof task.parent === 'string' && task.parent.trim() !== ''
  if (hasParent) {
    if (gate.cascade !== true) return 'subtask'
  } else {
    const source = isPlainObject(task.source) ? task.source : null
    if (source === null || source.kind !== 'utterance') return 'not-utterance'
  }
  const ageHours = noiseCardAgeHours(task, gate.now)
  if (ageHours < gate.olderThanHours) return 'young'
  return null
}

/** 噪声卡的年龄（小时）：优先 `source.at`（用户说话的时刻），退化到 `created_at`。 */
function noiseCardAgeHours(task, now) {
  if (isPlainObject(task) === false) return 0
  const source = isPlainObject(task.source) ? task.source : null
  const at = source !== null && typeof source.at === 'string' ? source.at : ''
  const stamp = at !== '' ? Date.parse(at) : Date.parse(typeof task.created_at === 'string' ? task.created_at : '')
  if (!Number.isFinite(stamp)) return 0
  return (now - stamp) / 3_600_000
}

/** 自动归档的 notes 标记：归档必须可追溯，不能静默消失。 */
const NOISE_ARCHIVE_MARK = '[auto-archive]'

/** 级联归档的最低年龄（小时）：父卡同回合刚建的空子卡不能当场收掉（U6）。 */
const NOISE_CASCADE_MIN_AGE_HOURS = 1

/** 一份 id → 记录 的父集合：`has(task.id)` = 这张卡有子任务。 */
function parentsOf(records) {
  const parents = new Set()
  for (const record of records) {
    if (isPlainObject(record) === false) continue
    if (typeof record.parent === 'string' && record.parent.trim() !== '') parents.add(record.parent.trim())
  }
  return parents
}

/** 噪声卡的读投影摘要（dry-run / 返回值用，绝不写盘）。 */
function noiseSummary(record, gate) {
  return {
    id: typeof record.id === 'string' ? record.id : '',
    title: typeof record.title === 'string' ? record.title : '',
    ageHours: Math.round(noiseCardAgeHours(record, gate.now) * 10) / 10,
  }
}

/**
 * 一张噪声卡的归档写入（**调用方必须已持有写锁**）。
 *
 * 与 `archiveTasks` 同构：patch + `stampTaskTimes` + 原子写，**不跑**描述门/验收门
 * ——这是内部记账（`source: 'internal'` 档的语义），不是语义完成。同时写
 * `stage: 'archived'` 与 `status: 'archived'`：只写 status 时读投影仍按盘上的
 * `stage` 显示 `queued-analysis`，卡会继续占着未完成队列，归档就没有实际效果；
 * 两者一致，所以 `deriveTaskStatus` 不会拒绝。
 */
function writeNoiseArchive(item, gate, nowIso, trigger) {
  const record = item.record
  const note =
    `${NOISE_ARCHIVE_MARK} 捕获噪声卡自动归档：阶段 ${projectTaskStage(record).stage}，` +
    `无 notes/commits/checkpoints/acceptance、无子任务、未领取，已超过 ${gate.olderThanHours} 小时（触发：${trigger}）。`
  const next = stampTaskTimes(
    record,
    applyTaskPatch(record, { stage: 'archived', status: 'archived', notes: note }),
    nowIso,
  )
  writeJsonAtomic(item.file, next)
  return { id: next.id, title: typeof record.title === 'string' ? record.title : '', ageHours: Math.round(noiseCardAgeHours(record, gate.now) * 10) / 10 }
}

/** 在一份读集合上跑判据：返回命中的磁盘行与跳过统计（`parentId` 限定其直接子卡）。 */
function noiseScan(items, parentId, gate) {
  const matched = []
  const skipped = {}
  for (const item of items) {
    const record = item.record
    let reason
    if (parentId === '') {
      reason = noiseTaskSkipReason(record, gate)
    } else if (isPlainObject(record) === false || typeof record.parent !== 'string' || record.parent.trim() !== parentId) {
      reason = 'not-child'
    } else {
      reason = noiseTaskSkipReason(record, gate)
    }
    if (reason !== null) {
      skipped[reason] = (skipped[reason] ?? 0) + 1
      continue
    }
    matched.push({ item, summary: noiseSummary(record, gate) })
  }
  return { matched, skipped }
}

/**
 * 自动归档「捕获噪声卡」（T-20261112151422 / M2）。
 *
 * 与 `archiveTasks` 的分工：后者按 `tasks.archiveAfterDays` 归档**已完成**的卡；
 * 本函数收的是**从没被领取过的空卡**（判据见 {@link noiseTaskSkipReason}），
 * 结果直接是 `archived`，不再走 done → 7 天窗口。
 *
 * 锁纪律：先不加锁预扫，没有候选就既不取锁也不写盘；有候选才在写锁内重读重判
 * （两次读之间被改过的卡跳过）。写盘用 {@link writeNoiseArchive}，**不递归调用
 * `updateTask`**——`withLock` 不可重入，递归会自己撞成 conflict。另一个写者持锁
 * 不是错误：`locked: true` + 一条 `archive-locked` warning，门禁步骤仍然 exit 0。
 * 幂等：归档后的卡 notes 非空、阶段已是 archived，第二次扫描不再命中。
 *
 * @param options `{olderThanHours?: number, now?: number, dryRun?: boolean, parentId?: string}`
 *   `olderThanHours` 默认 24（全局 sweep）/ 1（`parentId` 级联模式）；
 *   `parentId` 限定只收该父卡（进入终态时）的直接子卡；子卡豁免
 *   `source.kind === 'utterance'`（父卡命中即收）。
 * @returns `{archived:[{id,title,ageHours}], scanned, skipped, olderThanHours, dryRun, locked}`
 */
export function archiveNoiseTasks(root, contract, options = {}) {
  assertInitialized(root)
  const input = isPlainObject(options) ? options : {}
  const parentId = typeof input.parentId === 'string' ? input.parentId.trim() : ''
  /* 年龄默认值按模式取：全局 sweep 是 24 小时（与沿用至今的 `autoSweepHours` 一致）；
     父卡级联是 1 小时（{@link NOISE_CASCADE_MIN_AGE_HOURS}，保护同回合新建的子卡）。 */
  const defaultHours = parentId === '' ? 24 : NOISE_CASCADE_MIN_AGE_HOURS
  const olderThanHours =
    Number.isFinite(input.olderThanHours) && input.olderThanHours >= 0 ? input.olderThanHours : defaultHours
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const dryRun = input.dryRun === true
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c)
  const report = { olderThanHours, dryRun, scanned: 0, skipped: {}, locked: false }
  const gateFor = (items) => ({
    now,
    olderThanHours,
    parents: parentsOf(items.map((item) => item.record)),
    cascade: parentId !== '',
  })
  const preItems = readCollection(paths.tasks)
  const pre = noiseScan(preItems, parentId, gateFor(preItems))
  if (pre.matched.length === 0 || dryRun) {
    return { ...report, scanned: preItems.length, skipped: pre.skipped, archived: pre.matched.map((row) => row.summary) }
  }
  try {
    return withLock(root, c, (lockedPaths) => {
      const items = readCollection(lockedPaths.tasks)
      const gate = gateFor(items)
      const scan = noiseScan(items, parentId, gate)
      const trigger = parentId === '' ? 'flow task sweep' : `父卡 ${parentId} 进入终态`
      const archived = []
      const nowIso = formatIso()
      for (const row of scan.matched) {
        try {
          archived.push(writeNoiseArchive(row.item, gate, nowIso, trigger))
        } catch (error) {
          // 手改坏的记录不能中止整次归档（或把门禁步骤卡红）：跳过并说一次原因。
          noteWarning(`task-archive-skipped: ${row.item.name}: ${error.message}`)
        }
      }
      return { ...report, scanned: items.length, skipped: scan.skipped, archived }
    })
  } catch (error) {
    if (error instanceof FlowError && error.code === 'conflict') {
      noteWarning(`archive-locked: ${error.message}`)
      return { ...report, scanned: preItems.length, skipped: pre.skipped, archived: [], locked: true }
    }
    throw error
  }
}

/**
 * 消息卡收口（2026-11-09，任务模块；2026-11-12 M4）：把「只是某句话、从没被领取」
 * 的捕获卡自动**归档**，避免每句聊天都永久占着未完成计数。
 *
 * 结果语义（Lead 2026-11-12 裁决 M4）：归档 = `stage/status: archived`，不再先落
 * done 再等 7 天窗口——噪声卡本来就不该进入「完成」统计。留痕仍写在 notes
 * （`[auto-archive]`）。`closed` 字段名保留给既有 CLI/调用方，内容就是本次归档的卡。
 *
 * @param options `{olderThanHours?: number, now?: number, dryRun?: boolean}`
 * @returns `{olderThanHours, scanned, closed:[{id,title,ageHours}], skipped, dryRun, locked}`
 */
export function sweepUtteranceTasks(root, contract, options = {}) {
  const result = archiveNoiseTasks(root, contract, options)
  return {
    olderThanHours: result.olderThanHours,
    scanned: result.scanned,
    closed: result.archived,
    skipped: result.skipped,
    dryRun: result.dryRun,
    locked: result.locked,
  }
}

/**
 * 父卡进入终态时的子卡级联收口（T-20261112151422 / M3）。
 *
 * **必须**在 `updateTask` 已持有的写锁内调用（`withLock` 不可重入，所以这里直接
 * 读集合、直接写盘，不走 `updateTask`/`archiveNoiseTasks`）。判据与全局 sweep
 * 共用 {@link noiseTaskSkipReason}，区别只有两处：只认 `parent === parentId` 的直接
 * 子卡，且子卡豁免 `source.kind === 'utterance'`（父卡命中即收）。年龄阈值取
 * {@link NOISE_CASCADE_MIN_AGE_HOURS}，保护与父卡同回合新建的子卡。
 */
function archiveNoiseChildren(paths, parentId, nowIso) {
  const items = readCollection(paths.tasks)
  const gate = {
    now: Date.parse(nowIso),
    olderThanHours: NOISE_CASCADE_MIN_AGE_HOURS,
    parents: parentsOf(items.map((item) => item.record)),
    cascade: true,
  }
  for (const item of items) {
    const record = item.record
    if (isPlainObject(record) === false) continue
    if (typeof record.parent !== 'string' || record.parent.trim() !== parentId) continue
    if (noiseTaskSkipReason(record, gate) !== null) continue
    try {
      writeNoiseArchive(item, gate, nowIso, `父卡 ${parentId} 进入终态`)
    } catch (error) {
      noteWarning(`task-archive-skipped: ${item.name}: ${error.message}`)
    }
  }
}

/** `goal` merge separator for legacy records (CONTRACT §3.2). */
const TASK_GOAL_SEPARATOR = ' — '

/** A `type` value the migration may backfill: exactly one of the ten enum members. */
function migrationType(value) {
  if (typeof value !== 'string') return null
  const type = value.trim()
  return TASK_TYPES.includes(type) ? type : null
}

/**
 * `type` predating the required enum: absent key, a hand-written `null`/`''`, or
 * a non-string / non-enum **string** on disk (P2-3). The last case matters: a
 * record carrying `type: "nope"` used to pass `check tasks` (`ok: true`) while
 * every `updateTask` rejected it — a read-only zombie the gate declared healthy.
 * Folding it into "missing" lets the migration write the mapped value; rule 3
 * ("never rewrite an existing type") only ever protected a **legal** type.
 */
function taskTypeMissing(record) {
  if (Object.hasOwn(record, 'type') === false) return true
  if (record.type === null || record.type === '') return true
  return migrationType(record.type) === null
}

/**
 * Merged title for a legacy record, or null when the goal is only dropped:
 * empty goal, or `goal === title`. When the title is empty the goal **becomes**
 * the title (P2-2): dropping the goal and leaving an empty title would make
 * `validateTaskFields` reject the record forever, so the issue could never be
 * fixed. NOTE the empty-`goal` case is checked first on purpose — a blank goal
 * must stay "drop the key only", never "use it as the title".
 */
function mergedTaskTitle(record) {
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const goal = typeof record.goal === 'string' ? record.goal.trim() : ''
  if (goal === '') return null
  if (title === '') return goal
  if (goal === title) return null
  return `${title}${TASK_GOAL_SEPARATOR}${goal}`
}

/** What a legacy record still needs: `goal` key removal/merge, then `type` backfill. */
function taskFormatIssues(record, typeById) {
  if (!isPlainObject(record)) return []
  const id = typeof record.id === 'string' ? record.id : ''
  const title = typeof record.title === 'string' ? record.title : null
  const goal = typeof record.goal === 'string' ? record.goal : null
  const issues = []
  if (Object.hasOwn(record, 'goal')) {
    const merged = mergedTaskTitle(record)
    issues.push({
      id,
      kind: 'legacy-goal',
      title,
      goal,
      // P2-1: a non-string goal is never touched by the migration, so say that
      // instead of claiming the key is "empty or same as title" (it is neither).
      suggestion: typeof record.goal !== 'string'
        ? 'goal is not a string; the migration never deletes it — fix the record by hand'
        : merged === null
          ? 'drop the legacy goal key (empty or same as title)'
          : `title = ${JSON.stringify(merged)}`,
    })
  }
  if (taskTypeMissing(record)) {
    const type = migrationType(typeById[id])
    // Distinguish "no usable type" from "a type that is present but illegal" so
    // an operator knows a value is on disk that must be replaced (P2-3).
    const illegal = Object.hasOwn(record, 'type') && record.type !== null && record.type !== ''
    issues.push({
      id,
      kind: 'missing-type',
      title,
      goal,
      suggestion: type === null
        ? illegal
          ? `type = ${JSON.stringify(record.type)} is not one of the ten values; supply the correct value via typeById`
          : 'supply type for this id via typeById (one of the ten enum values)'
        : `type = ${JSON.stringify(type)}`,
    })
  }
  return issues
}

/**
 * The migrated copy of one legacy record, or null when nothing would change.
 * Only structural repair: `goal` is dropped (merged into `title` when both are
 * non-empty and differ) and a **missing** `type` is filled from `typeById`.
 * `title`/`type` are never rewritten otherwise, and `updated_at` is preserved.
 */
function normalizeTaskRecord(record, typeById) {
  const next = deepClone(record)
  let changed = false
  if (Object.hasOwn(next, 'goal')) {
    // P2-1: a non-string goal is not migrated at all — deleting the key would
    // silently destroy its value, and the issue keeps it visible instead.
    if (typeof next.goal !== 'string') return null
    const merged = mergedTaskTitle(next)
    if (merged !== null) next.title = merged
    delete next.goal
    changed = true
  }
  if (taskTypeMissing(next)) {
    const type = migrationType(typeById[typeof next.id === 'string' ? next.id : ''])
    if (type !== null) {
      next.type = type
      changed = true
    }
  }
  return changed === true ? next : null
}

/**
 * Legacy task-format migration — the only path allowed to rewrite `title` and
 * `type`; `updateTask` rejects both without exception (CONTRACT §3.2).
 *
 * Legacy shapes reported (and, with `fix: true`, repaired):
 * - `legacy-goal`: the record still carries a `goal` key. A non-empty goal that
 *   differs from the title is merged as `title = "<old title> — <old goal>"`; an
 *   empty goal, or one equal to the title, is only dropped.
 * - `missing-type`: a record predating the required enum. Filled **only** from
 *   `typeById[id]` and only when that value is one of {@link TASK_TYPES}; a
 *   record that already has a type is never touched.
 *
 * `fix: false` (default) is a pure read — no lock, no write, nothing renamed on
 * disk — and returns the issue list for the format gate (`flow check tasks`).
 * `fix: true` migrates under the store lock, one atomic write per changed
 * record, and is idempotent: a second run reports no issue and writes nothing.
 *
 * @returns {{ ok: boolean, issues: Array<{ id: string, kind: string, title: string|null,
 *   goal: string|null, suggestion: string }>, fixed: string[] }}
 *   `issues` is what the run found (on `fix: true`: what it acted on); `ok` is
 *   true when nothing is left to migrate.
 */
export function normalizeTaskFormat(root, contract, options = {}) {
  const settings = isPlainObject(options) ? options : {}
  const fix = settings.fix === true
  const typeById = isPlainObject(settings.typeById) ? settings.typeById : {}
  const c = normalizeContract(root, contract)
  if (fix === false) {
    const paths = storePaths(root, c)
    const issues = []
    for (const item of readCollection(paths.tasks)) issues.push(...taskFormatIssues(item.record, typeById))
    return { ok: issues.length === 0, issues, fixed: [] }
  }
  assertInitialized(root)
  return withLock(root, c, (paths) => {
    const issues = []
    const fixed = []
    // What a repaired record still needs afterwards: an issue that cannot be
    // resolved here (a missing `type` with no valid `typeById`) keeps `ok:false`.
    const remaining = []
    for (const item of readCollection(paths.tasks)) {
      const found = taskFormatIssues(item.record, typeById)
      if (found.length === 0) continue
      issues.push(...found)
      let next
      try {
        next = normalizeTaskRecord(item.record, typeById)
        // Nothing repairable here (an `missing-type` without a `typeById` entry):
        // report it and leave the file byte-identical.
        if (next === null) {
          remaining.push(...found)
          continue
        }
        validateTaskFields(next)
      } catch (error) {
        // A hand-broken record must not abort the whole migration (or block the
        // gate): skip it and say why once, like `archiveTasks` does.
        noteWarning(`task-normalize-skipped: ${item.name}: ${error.message}`)
        remaining.push(...found)
        continue
      }
      writeJsonAtomic(item.file, next)
      fixed.push(next.id)
      remaining.push(...taskFormatIssues(next, typeById))
    }
    return { ok: remaining.length === 0, issues, fixed }
  })
}

/**
 * 移除 = **撤销**（T-20261113163505）：禁止物理删除，进入 cancelled 并保留原因。
 *
 * 物理删除只允许显式 `options.purge: true`，且在删前写审计记录
 * （`<logs>/task-purge/<id>-<ts>.json`，含原因/时间/操作者）。
 * 返回 `{id, removed, cancelled?, purged?, stage?}`；`removed:true` 只表示物理删除。
 */
export function removeTask(root, contract, id, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason === '') {
    throw invalid("task rm 必须给 --reason <原因>（撤销也要留痕；物理删除仅限 --purge）")
  }
  const purge = input.purge === true
  const actor = typeof input.agent === 'string' ? input.agent.trim() : ''
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.tasks, assertSafeId(id), 'task')
    const at = formatIso()
    const file = join(paths.tasks, current.id + '.json')
    if (purge) {
      const auditDir = join(paths.logs, 'task-purge')
      mkdirSync(auditDir, { recursive: true })
      const stamp = at.replace(/[^0-9]/g, '').slice(0, 14)
      writeJsonAtomic(join(auditDir, current.id + '-' + stamp + '.json'), {
        schema: 1,
        id: current.id,
        title: typeof current.title === 'string' ? current.title : '',
        stage: projectTaskStage(current).stage,
        reason,
        agent: actor,
        at,
        source: 'flow task rm --purge',
      })
      unlinkSync(file)
      noteWarning('task-purged: ' + current.id + ' 已物理删除（--purge 显式；审计 ' + toPosix(auditDir) + '）')
      return { id: current.id, removed: true, cancelled: false, purged: true }
    }
    const notes = (typeof current.notes === 'string' && current.notes !== '' ? current.notes + '\n' : '') +
      '[cancelled] ' + reason
    const next = stampTaskTimes(
      current,
      applyTaskPatch(current, {
        stage: 'cancelled',
        status: 'cancelled',
        cancelReason: reason,
        cancelled_at: at,
        notes,
      }),
      at,
    )
    writeJsonAtomic(file, next)
    return { id: current.id, removed: false, cancelled: true, stage: 'cancelled' }
  })
}

/**
 * Effective archive window in whole days.
 *
 * Out-of-range values degrade instead of throwing (the sweep must stay exit 0
 * for a gate step): a non-finite window disables archiving (0), a negative one is
 * treated as 0, and anything above {@link TASK_ARCHIVE_MAX_DAYS} is clamped. Each
 * degradation is announced once through a `tasks-archive-days-invalid` warning.
 *
 * @param {object} contract normalized contract (its `tasks.archiveAfterDays`)
 * @param {number|undefined} override explicit `--older-than`-style override
 * @returns {number} whole days, 0 meaning "disabled"
 */
function archiveWindowDays(contract, override) {
  const configured = override === undefined ? contract?.tasks?.archiveAfterDays : override
  if (typeof configured !== 'number' || Number.isFinite(configured) === false) {
    noteWarning(`tasks-archive-days-invalid: ${String(configured)} is not a finite number; archive disabled (0)`)
    return 0
  }
  const days = Math.floor(configured)
  if (days < 0) {
    noteWarning(`tasks-archive-days-invalid: ${configured} is negative; archive disabled (0)`)
    return 0
  }
  if (days > TASK_ARCHIVE_MAX_DAYS) {
    noteWarning(
      `tasks-archive-days-invalid: ${configured} exceeds ${TASK_ARCHIVE_MAX_DAYS}; clamped to ${TASK_ARCHIVE_MAX_DAYS}`,
    )
    return TASK_ARCHIVE_MAX_DAYS
  }
  return days
}

/**
 * Task files eligible for archiving: still `done`, with a parseable `updated_at`
 * at or before `cutoffMs`. A missing or unparseable `updated_at` is left alone —
 * a guess is worse than a stale task. The `readCollection` rows are returned so
 * the sweep rewrites the very file it read instead of rebuilding a name from the
 * record id.
 */
function archivableTaskFiles(tasksDir, cutoffMs) {
  return readCollection(tasksDir).filter((item) => {
    const record = item.record
    if (isPlainObject(record) === false) return false
    if (typeof record.id !== 'string' || record.id === '') return false
    /* 归档只表示「完成退役」：只从 done 归档；cancelled（撤销）永不被清扫。 */
    if (record.status !== 'done') return false
    if (typeof record.stage === 'string' && record.stage !== 'done') return false
    if (typeof record.updated_at !== 'string') return false
    const updated = Date.parse(record.updated_at)
    return Number.isFinite(updated) && updated <= cutoffMs
  })
}

/**
 * Archive `done` tasks whose `updated_at` is at least `days` old.
 *
 * This is an explicit sweep, never a read-path side effect. The store is read
 * without the lock first: with no candidate nothing is locked and nothing is
 * written. With candidates the sweep takes the store lock, re-reads and re-checks
 * under it (a task another writer finished or archived between the two reads is
 * skipped), then rewrites each archived record through the ordinary task patch.
 *
 * A lock held by another writer is not an error: the sweep archives nothing,
 * reports `locked: true` and records one `archive-locked` warning, so a gate step
 * stays exit 0. Idempotent: an archived task no longer matches, so a second sweep
 * at the same `now` writes no file.
 *
 * @param {string} root project root
 * @param {object} contract flow contract
 * @param {{days?:number, now?:number, dryRun?:boolean}} [options] `days` overrides
 *   `tasks.archiveAfterDays`; `now` (ms) is the reference time; `dryRun` reports
 *   the would-be ids without locking or writing.
 * @returns {{archived:string[], candidates:number, days:number, cutoff:string|null, dryRun:boolean, locked:boolean}}
 *   `candidates` is the unlocked pre-scan count, `archived` the ids actually
 *   written (a dry run lists what it would write), `cutoff` the ISO local
 *   threshold (null when disabled).
 */
export function archiveTasks(root, contract, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const absRoot = resolve(root)
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const days = archiveWindowDays(c, input.days)
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const dryRun = input.dryRun === true
  const cutoffMs = now - days * DAY_MS
  const cutoff = days === 0 ? null : formatIso(new Date(cutoffMs))
  const report = { candidates: 0, days, cutoff, dryRun, locked: false }
  if (days === 0) return { archived: [], ...report }

  const paths = storePaths(absRoot, c)
  const preScan = archivableTaskFiles(paths.tasks, cutoffMs)
  if (preScan.length === 0) return { archived: [], ...report }
  const preScanIds = preScan.map((item) => item.record.id)
  if (dryRun) return { archived: preScanIds, ...report, candidates: preScanIds.length }

  let archived
  try {
    archived = withLock(absRoot, c, (lockedPaths) => {
      const written = []
      // Re-read under the lock: the pre-scan ran without it.
      for (const item of archivableTaskFiles(lockedPaths.tasks, cutoffMs)) {
        let next
        try {
          next = stampTaskTimes(item.record, applyTaskPatch(item.record, { status: 'archived' }), formatIso())
        } catch (error) {
          // A hand-broken record must not abort the whole sweep (or block a
          // commit through the gate step): skip it and say why once.
          noteWarning(`task-archive-skipped: ${item.name}: ${error.message}`)
          continue
        }
        writeJsonAtomic(item.file, next)
        written.push(next.id)
      }
      return written
    })
  } catch (error) {
    if (error instanceof FlowError && error.code === 'conflict') {
      noteWarning(`archive-locked: ${error.message}`)
      return { archived: [], ...report, candidates: preScanIds.length, locked: true }
    }
    throw error
  }
  return { archived, ...report, candidates: preScanIds.length }
}
