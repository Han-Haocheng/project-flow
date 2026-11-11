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
import { unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
import { STAGE_IDS, legacyStageFromStatus, stageToStatus } from '../stage.mjs'

/** 由 core 注入的跨域能力（描述门）。 */
/** Task ids: legacy `T-YYYYMMDD-NN` or the timestamp form `T-YYYYMMDDHHMMSS[-NN]` (T-08 B1). */
const TASK_ID_RE = /^T-(?:\d{8}-\d{2}|\d{14}(?:-\d{2})?)$/
/** Id shape accepted for cross-record references (`parent`). */

/** Conventional-commit task types; `addTask` requires one (T-15). */
export const TASK_TYPES = Object.freeze([
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci',
])

export const TASK_STATUS = ['draft', 'active', 'done', 'archived']

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
  'status', 'stage', 'owner', 'notes', 'commits', 'scope', 'acceptance', 'experiment', 'parent',
  /* P4: `decision` is set when a main task is vetoed and cleared by the user's
     answer; `veto` may be recorded after creation (`flow_veto`), but is never
     cleared — the veto history survives `modify`. */
  'veto', 'decision',
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
  /* 验收回执（`flow task verify`）：最近一次机器验证的结论摘要。系统维护——
     `lib/tools/*.mjs` 的字段白名单里没有它，会话只能通过 `flow task verify`
     （或这里导出的 `recordTaskVerification`）写入，避免手写一份"我验过了"。 */
  'verification',
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
    const created = projectTaskStage(record)
    if (created.stage === 'done' || created.stage === 'archived') {
      stampTaskTimes(null, record, formatIso())
    }
    if (created.stage === 'reviewing' || created.stage === 'done') {
      assertAcceptanceGate(c, created, { source: 'session', from: '', to: created.stage })
    }
    writeJsonAtomic(join(paths.tasks, `${record.id}.json`), record)
    return record
  })
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
 * @param {{source?: string}} [options] write-path options (never written to disk)
 */
export function updateTask(root, contract, id, patch, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  /* Owner is the task's **session** field (D-20261108-05 = extend-owner): the
     caller may write `''`/`none`/`null` to release it back to "unassigned". The
     normalization happens here, once, so CLI/tool/tests cannot drift. */
  const normalizedPatch =
    isPlainObject(patch) && Object.hasOwn(patch, 'owner') ? { ...patch, owner: normalizeOwnerInput(patch.owner) } : patch
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.tasks, id, 'task')
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
    if (typeof to === 'string' && to !== from) {
      const source =
        isPlainObject(options) && typeof options.source === 'string' && options.source !== ''
          ? options.source
          : 'session'
      if (typeof HOOKS.descriptionGate !== 'function') {
        throw new FlowError('invalid', 'tasks 域未装配 descriptionGate —— 请经由 lib/core.mjs 调用（直接 import 域模块需先 configureTasks）')
      }
      HOOKS.descriptionGate(root, c, next, { source, from, to })
      // 验收门：与描述门同一点、同一次「阶段确实在变」判定。`source: 'internal'`
      // 的插件收口（sweep/veto/迁移）同样豁免——它们不是语义完成，只是收口。
      assertAcceptanceGate(c, next, { source, from, to })
    }
    writeJsonAtomic(join(paths.tasks, `${next.id}.json`), next)
    // Same read shape as getTask: legacy rows keep `type: null` and gain `stage`.
    return projectTaskStage(projectTaskType(next))
  })
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
 * 消息卡收口（2026-11-09，任务模块）：把「只是某句话、从没被领取」的捕获卡自动
 * 完成，避免每句聊天都永久占着未完成计数。
 *
 * 只收严格合格的卡，任一条件不满足都留给人：
 * - `source.kind === 'utterance'`（capture 建的卡；手写任务不动）；
 * - `stage === 'queued-analysis'`（从没进入分析；一旦被领取/推进过就不动）；
 * - `notes`/`commits`/`acceptance`/`checkpoints` 全空（有进展证据的卡不动）；
 * - 不是子任务、没有子任务（子任务随父任务走）；
 * - `owner === ''`（别的会话/活会话拥有的卡不动——那是它的待办）；
 * - 年龄超过 `olderThanHours`（默认 24 小时）。
 *
 * 关闭 = `stage: 'done'`（`stageToStatus` 派生 done，`stampTaskTimes` 写 done_at），
 * `source: 'internal'` 绕过描述门——这不是语义变更完成，是消息卡收口。之后由既有的
 * 归档 sweep（`tasks.archiveAfterDays`）接手。
 *
 * @param options `{olderThanHours?: number, now?: number, dryRun?: boolean}`
 * @returns `{olderThanHours, scanned, closed:[{id,title,ageHours}], skipped, dryRun}`
 */
export function sweepUtteranceTasks(root, contract, options = {}) {
  assertInitialized(root)
  const input = isPlainObject(options) ? options : {}
  const olderThanHours =
    Number.isFinite(input.olderThanHours) && input.olderThanHours >= 0 ? input.olderThanHours : 24
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const dryRun = input.dryRun === true
  const c = normalizeContract(root, contract)
  const records = listTasks(root, c)
  const parents = new Set(
    records
      .map((task) => (typeof task.parent === 'string' && task.parent.trim() !== '' ? task.parent.trim() : ''))
      .filter((id) => id !== ''),
  )
  const gate = { now, olderThanHours, parents }
  const closed = []
  const skipped = {}
  for (const task of records) {
    const reason = utteranceCardSkipReason(task, gate)
    if (reason !== null) {
      skipped[reason] = (skipped[reason] ?? 0) + 1
      continue
    }
    const ageHours = utteranceCardAgeHours(task, now)
    if (!dryRun) {
      updateTask(
        root,
        c,
        task.id,
        { stage: 'done', notes: `[auto-close] 消息卡收口（超过 ${olderThanHours} 小时未领取，且无 notes/commits/派工回执）：flow task sweep 自动完成。` },
        { source: 'internal' },
      )
    }
    closed.push({ id: task.id, title: typeof task.title === 'string' ? task.title : '', ageHours: Math.round(ageHours * 10) / 10 })
  }
  return { olderThanHours, scanned: records.length, closed, skipped, dryRun }
}

/** 消息卡的年龄（小时）：优先 `source.at`（用户说话的时刻），退化到 `created_at`。 */
function utteranceCardAgeHours(task, now) {
  if (isPlainObject(task) === false) return 0
  const source = isPlainObject(task.source) ? task.source : null
  const at = source !== null && typeof source.at === 'string' ? source.at : ''
  const stamp = at !== '' ? Date.parse(at) : Date.parse(typeof task.created_at === 'string' ? task.created_at : '')
  if (!Number.isFinite(stamp)) return 0
  return (now - stamp) / 3_600_000
}

/** `null` = 该消息卡可以收口；否则返回跳过原因（统计口径见 CONTRACT §3.2）。 */
function utteranceCardSkipReason(task, gate) {
  if (isPlainObject(task) === false) return 'unreadable'
  const source = isPlainObject(task.source) ? task.source : null
  if (source === null || source.kind !== 'utterance') return 'not-utterance'
  if (task.stage !== 'queued-analysis') return 'stage'
  if (typeof task.notes === 'string' && task.notes.trim() !== '') return 'notes'
  if (Array.isArray(task.commits) && task.commits.length > 0) return 'commits'
  if (Array.isArray(task.checkpoints) && task.checkpoints.length > 0) return 'checkpoints'
  if (Array.isArray(task.acceptance) && task.acceptance.length > 0) return 'acceptance'
  if (typeof task.parent === 'string' && task.parent.trim() !== '') return 'subtask'
  if (gate.parents.has(task.id)) return 'has-children'
  if (typeof task.owner === 'string' && task.owner.trim() !== '') return 'owned'
  const ageHours = utteranceCardAgeHours(task, gate.now)
  if (ageHours < gate.olderThanHours) return 'young'
  return null
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

export function removeTask(root, contract, id) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const file = join(paths.tasks, `${assertSafeId(id)}.json`)
    try {
      unlinkSync(file)
    } catch (error) {
      if (error.code === 'ENOENT') throw new FlowError('not-found', `task ${id} not found`)
      throw new FlowError('io', `cannot remove ${toPosix(file)}: ${error.message}`)
    }
    return { id, removed: true }
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
    if (record.status !== 'done') return false
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
