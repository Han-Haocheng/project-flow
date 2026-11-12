// project-flow — Shared tool plumbing.
//
// This module is the single home of everything the `flow_*` tools share: the
// registry-ready output contract, root/id resolution, the store probe, the per-
// action field whitelists, the list caps/timeouts and the "known field on the
// wrong action" guard. Both the shared `project-flow` plugin (index.js) and the
// per-module sub-plugins (`tasks.js`, `gates.js`, `experiments.js`) import from
// here, so a sub-plugin can never drift from the shared rules.
//
// Two helpers need host services that only a plugin's `apply` sees
// (`workingDirectory`, and this module's own `hasStore` probe): they are
// exported as factories so each caller binds its own context while the
// validation logic stays in one place.
//
// Mounting (service lookup, ctx.effect registration, the core-warning wrapper)
// lives in the sibling module ./mount.mjs for the same reason.

import { statSync } from 'node:fs'
import { resolve } from 'node:path'

import { storeContractPath } from '../state-snapshot.mjs'
import { isPlainObject } from '../util.mjs'

export const ROOT_PROPERTY = {
  type: 'string',
  description: 'Project root (absolute or relative). Defaults to the session working directory.',
}
export const ID_PROPERTY = { type: 'string', description: 'Record id, e.g. E-20261028-01 or T-20261028-01.' }
export const EMPTY_STORE_NOTE = 'no flow store in this workspace; run: node bin/flow.mjs init'

/** List caps and write timeouts the `flow_*` tools share (one source, no drift). */
export const MAX_TOOL_ITEMS = 200
export const WRITE_TIMEOUT_MS = 30_000

export function requireDirectory(candidate) {
  let stats
  try {
    stats = statSync(candidate)
  } catch {
    throw new Error(`root does not exist: ${candidate}`)
  }
  if (stats.isDirectory() !== true) throw new Error(`root is not a directory: ${candidate}`)
  return candidate
}

export function requireId(tool, action, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${tool} ${action} requires id`)
  }
  return value.trim()
}

/**
 * `flow_task.parent` shares the CLI's clearing rule (`''`/`none`/`null`,
 * case-insensitive → null) through core.normalizeParentInput, so the tool and
 * `task --parent` can never diverge on what "root" means.
 */
export function normalizeTaskParent(c, input) {
  if (isPlainObject(input) && Object.hasOwn(input, 'parent')) {
    input.parent = c.normalizeParentInput(input.parent)
  }
  return input
}

export function pickFields(args, names) {
  const picked = {}
  for (const name of names) {
    if (Object.hasOwn(args, name) && args[name] !== undefined) picked[name] = args[name]
  }
  return picked
}

/**
 * Resolve the project root for one tool call: an explicit `root` argument wins,
 * then the session's working directory service, then the session header cwd.
 * Bound to the host `workingDirectory` service by the plugin that owns the call.
 */
export function makeToolRoot({ service }) {
  return function toolRoot(ctx, args, exec) {
    const explicit = args !== null && typeof args === 'object' ? args.root : undefined
    if (typeof explicit === 'string' && explicit.trim().length > 0) {
      return requireDirectory(resolve(explicit))
    }

    const session = exec !== null && exec !== undefined && exec.agent !== undefined ? exec.agent.session : undefined
    const workingDirectory = service(ctx, 'workingDirectory')
    if (workingDirectory !== undefined && typeof workingDirectory.get === 'function' && session !== undefined) {
      try {
        const value = workingDirectory.get(session)
        if (typeof value === 'string' && value.trim().length > 0) return requireDirectory(resolve(value))
      } catch {
        // Fall through to the session header cwd.
      }
    }
    let cwd
    try {
      cwd = session === undefined || session === null ? undefined : session.cwd
    } catch {
      cwd = undefined
    }
    if (typeof cwd === 'string' && cwd.trim().length > 0) return requireDirectory(resolve(cwd))
    throw new Error('no project root: pass root, or call this tool inside a workspace session')
  }
}

/** Fail fast with the init hint when the workspace has no store yet. */
export function makeRequireStore({ hasStore }) {
  return function requireStore(root) {
    if (hasStore(root) === false) {
      throw new Error(`project flow store not found in ${root}; run: node bin/flow.mjs init`)
    }
  }
}

/**
 * Whether the root owns a `.agents/flow/flow.json` store contract. Every flow_*
 * tool and the shared plugin's heartbeat/decision helpers probe the store
 * through this one function, so "initialized" can never mean two things.
 */
export function hasStore(root) {
  try {
    return statSync(storeContractPath(root)).isFile()
  } catch {
    return false
  }
}

/** `requireStore` bound to the shared `hasStore`: the one store guard. */
export const requireStore = makeRequireStore({ hasStore })

export const EXP_ADD_FIELDS = Object.freeze([
  'id',
  'title',
  'hypothesis',
  'factor',
  'parent',
  'expected',
  'scale',
  'status',
  'measured',
  'metrics',
  'commits',
  'notes',
  'direction',
  'primaryMetric',
  'guardrails',
  'falsify',
  'windowDays',
  'stopLoss',
  'learned',
])
export const EXP_UPDATE_FIELDS = Object.freeze([
  'title',
  'hypothesis',
  'factor',
  'parent',
  'expected',
  'scale',
  'status',
  'measured',
  'metrics',
  'commits',
  'notes',
  'direction',
  'primaryMetric',
  'guardrails',
  'falsify',
  'windowDays',
  'stopLoss',
  'learned',
])
// `title` and `type` stay listed here on purpose: core `applyTaskPatch` is the
// single interception point for "cannot be changed", so the CLI and the tools
// report the same `invalid: task <key> cannot be changed`. Blocking them here
// would produce a second error shape (`assertOnlyFields` throws a plain Error).
// `goal` is gone: it was merged into `title` (legacy `goal` keys are migrated by
// core `normalizeTaskFormat`, not by a tool).
export const TASK_ADD_FIELDS = Object.freeze([
  'id',
  'title',
  'type',
  'status',
  'owner',
  'notes',
  'commits',
  'scope',
  'acceptance',
  'experiment',
  'parent',
  /* 2026-11-11：主会话建主任务时可直接给 stage=queued-analysis，插件随即派分析者。 */
  'stage',
])
export const TASK_UPDATE_FIELDS = Object.freeze([
  'title',
  'type',
  'status',
  'stage',
  'owner',
  'notes',
  'commits',
  'scope',
  'acceptance',
  'experiment',
  'parent',
])
/**
 * `flow_task plan`（2026-11-11 对话接入）：lead 交一份结构化计划，插件校验后建卡
 * 并自动派分析者。`priority` 是计划内的排序提示，core 的任务记录没有该字段，
 * 由 plan 落进 notes（见 lib/tools/tasks.mjs 的 notesOf）。
 */
export const TASK_PLAN_FIELDS = Object.freeze(['tasks', 'rationale'])

export const GATE_ADD_FIELDS = Object.freeze([
  'id',
  'title',
  'phase',
  'enabled',
  'steps',
])
export const GATE_UPDATE_FIELDS = Object.freeze([
  'title',
  'phase',
  'enabled',
  'steps',
])

/**
 * Per-action field whitelist for the flow_* tools (T-20261030-15). The JSON
 * schema already rejects unknown properties; this rejects a **known** field
 * passed to the wrong action (it used to be dropped silently). `root`, `action`
 * and `id` are structural for every action. Throws before any core call.
 */
export const STRUCTURAL_FIELDS = Object.freeze(['root', 'action', 'id'])

export function assertOnlyFields(name, action, args, allowed) {
  const permitted = new Set([...STRUCTURAL_FIELDS, ...(Array.isArray(allowed) ? allowed : [])])
  for (const key of Object.keys(args)) {
    if (permitted.has(key)) continue
    throw new Error(`invalid: ${name} ${String(action)} does not accept "${key}"`)
  }
}

export const EXP_ACTION_FIELDS = Object.freeze({
  list: [], show: [], tree: [],
  add: EXP_ADD_FIELDS, update: EXP_UPDATE_FIELDS,
  review: [], productize: ['gate'], cleanup: ['flags', 'code', 'data'], remove: [],
})
export const TASK_ACTION_FIELDS = Object.freeze({
  list: [], show: [], add: TASK_ADD_FIELDS, update: TASK_UPDATE_FIELDS, remove: [], dispatch: ['id'],
  plan: TASK_PLAN_FIELDS,
})
export const GATE_ACTION_FIELDS = Object.freeze({
  list: [], show: [],
  add: GATE_ADD_FIELDS, update: GATE_UPDATE_FIELDS,
  remove: [], run: [], logs: ['limit'],
})

const BULLET = '- '
/** 单条记录里「逐行展开」的数组字段：每项一行，而不是折成一行 JSON。 */
const LIST_FIELDS = new Set(['acceptance', 'allow', 'deny', 'commits', 'guardrails', 'flags', 'code', 'data', 'blocks', 'affects', 'missing', 'warnings', 'skipped', 'cleared'])
/** 单条记录里「多行文本」的字段：首行随字段，其余行按同宽缩进。 */
const TEXT_FIELDS = new Set(['notes', 'learned', 'rationale', 'question', 'hypothesis', 'falsify', 'expected', 'direction', 'stopLoss', 'measured', 'primaryMetric', 'scale'])
/** 单条记录的固定字段顺序；不在此列但存在的字段排在后面（按原键序）。 */
const RECORD_ORDER = [
  'id', 'title', 'type', 'status', 'stage', 'stageZh', 'owner', 'parent', 'experiment', 'decision',
  'revision', 'enabled', 'phase', 'created_at', 'updated_at', 'done_at', 'archived_at',
]
/** 列表行里的阶段/状态字段（第二个优先级）；其余状态类字段按序补在后面。 */
const ROW_STATE_FIELDS = ['stageZh', 'stage', 'status', 'phase', 'verdict', 'branch', 'liveness']

const STAGE_LABELS = Object.freeze({
  created: '已创建',
  'queued-analysis': '待分析',
  analyzing: '分析中',
  'queued-implementation': '待实现',
  implementing: '实现中',
  'queued-review': '待审查',
  reviewing: '审查中',
  done: '已完成',
  archived: '已归档',
})

const STATUS_LABELS = Object.freeze({
  draft: '草稿',
  active: '进行中',
  done: '已完成',
  archived: '已归档',
  open: '进行中',
  confirmed: '已确认',
  refuted: '已否定',
  abandoned: '已放弃',
  inconclusive: '无定论',
  pivoted: '已转向',
  answered: '已回答',
  withdrawn: '已撤回',
  superseded: '已被取代',
  working: '工作中',
  idle: '空闲',
  waiting: '等待中',
})

const TASK_STATE_LABELS = Object.freeze({
  draft: '草稿',
  active: '进行中',
  done: '已完成',
  archived: '已归档',
  other: '其它',
  created: '已创建',
  'queued-analysis': '待分析',
  analyzing: '分析中',
  'queued-implementation': '待实现',
  implementing: '实现中',
  'queued-review': '待审查',
  reviewing: '审查中',
})

const EXP_STATE_LABELS = Object.freeze({
  open: '进行中',
  confirmed: '已确认',
  refuted: '已否定',
  abandoned: '已放弃',
  inconclusive: '无定论',
  pivoted: '已转向',
  total: '合计',
})

/** `ok:false` 的形状（`{ok:false, code, error|message}`）→ 一行中文失败报告。 */
function failureLine(value) {
  if (isPlainObject(value) === false || value.ok !== false) return ''
  const code = typeof value.code === 'string' && value.code !== '' ? value.code : 'error'
  const message = typeof value.error === 'string' && value.error !== '' ? value.error : typeof value.message === 'string' ? value.message : ''
  return `✖ ${code}：${message === '' ? '（没有给出原因）' : message}`
}

/** 失败结果的后续一行：`下一步：<nextAction>`（没有就不写）。 */
function failureHint(value) {
  if (isPlainObject(value) === false) return ''
  const next = typeof value.nextAction === 'string' && value.nextAction !== '' ? value.nextAction : ''
  return next === '' ? '' : `下一步：${next}`
}

/**
 * 渲染入口的失败壳。每个 `flow_*` 工具都是 `{root, ...}`；`ok:false` 时先给一行
 * `✖ <code>：<message>`，再给 `下一步：…`，然后才是它带的记录/计数。
 *
 * @returns {string[]|null} 失败报告的行；不是失败形状时返回 null（继续按主形状渲染）
 */
function renderFailure(name, value, action) {
  const line = failureLine(value)
  if (line === '') return null
  const lines = [`${name}${action === '' ? '' : ` ${action}`} 失败：`, `  ${line}`]
  const hint = failureHint(value)
  if (hint !== '') lines.push(`  ${hint}`)
  const record = pickRecord(value)
  if (record !== null) lines.push(...renderRecord({ ...record, emptyMark: true }, '  '))
  return lines
}

/** 失败结果里可能同行的记录：`task` / `decision` / …（只取第一个）。 */
function pickRecord(value) {
  for (const key of ['task', 'decision', 'experiment', 'gate', 'record', 'heartbeat']) {
    const candidate = value[key]
    if (isPlainObject(candidate)) return { key, record: candidate }
  }
  return null
}

/** 空态：列表没有内容时的中文说明（`note` 优先，其次按类别给默认提示）。 */
function emptyLine(note, fallback) {
  const text = typeof note === 'string' && note.trim() !== '' ? note.trim() : ''
  return text === '' ? fallback : text
}

/** 一个值压成一行短文本（数组用「、」连接；对象给一层键值摘要，不展开成 JSON）。 */
function cellText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map((item) => cellText(item))
      .filter((item) => item !== '')
      .join('、')
  }
  if (isPlainObject(value)) {
    const parts = []
    for (const [key, item] of Object.entries(value)) {
      const text = cellText(item)
      if (text !== '') parts.push(`${key}=${text}`)
    }
    return parts.join(' ')
  }
  return String(value)
}

/**
 * `{total: 3, open: 1, …}` → `合计 3 · 进行中 1`——**只列非零项**。
 *
 * 为什么不列 0：一张台账的计数表有 5..7 个键，全列出来每行都是「已归档 0 · 其它 0」，
 * 0 不提供任何信息却把真正要看的那几个挤没了。合计单独看：一个 0 也是结论。
 */
function countsText(counts, labels) {
  if (isPlainObject(counts) === false) return ''
  const parts = []
  for (const [key, item] of Object.entries(counts)) {
    if (typeof item !== 'number') continue
    if (item === 0 && key !== 'total') continue
    const label = labels !== null && Object.hasOwn(labels, key) ? labels[key] : key
    parts.push(`${label} ${item}`)
  }
  return parts.join(' · ')
}

/** 一个字段值的「显示文本」：阶段/状态查中文名，布尔显示是/否，数组用「、」。 */
function displayOf(key, value) {
  if (key === 'stage' || key === 'stageZh') {
    const zh = STAGE_LABELS[value]
    if (typeof zh === 'string') return zh
  } else if (key === 'status') {
    const zh = STATUS_LABELS[value]
    if (typeof zh === 'string') return zh
  } else if (key === 'enabled' && typeof value === 'boolean') {
    return value ? '已启用' : '已禁用'
  } else if (key === 'ok' && typeof value === 'boolean') {
    return value ? '通过' : '失败'
  }
  return cellText(value)
}

/** 该字段值在渲染时「值不值得出现」：空串/空数组/空对象/null 一律不出现。 */
function hasValue(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (isPlainObject(value)) return Object.keys(value).length > 0
  return true
}

/**
 * 一个记录压成一行：`<id>  <标题>  <阶段/状态>`，之后才是别的短字段。
 * 空字段整段跳过（不留 `-` 或 `undefined`）；阶段只显示一次中文名，不再重复原始 id。
 */
function rowText(item) {
  const bits = []
  const id = cellText(item.id)
  if (id !== '') bits.push(id)
  const title = cellText(item.title)
  if (title !== '') bits.push(title)
  const used = new Set(['id', 'title'])
  let staged = false
  for (const key of ROW_STATE_FIELDS) {
    if (Object.hasOwn(item, key) === false) continue
    // stageZh 与 stage 是同一件事：给了中文名就不再补原始 id。
    if ((key === 'stage' && Object.hasOwn(item, 'stageZh')) || (key === 'stageZh' && Object.hasOwn(item, 'stage'))) {
      if (key === 'stage') continue
    }
    // 阶段已经表达了状态：同一行不再画蛇添足地写「进行中 / 已完成」。
    if (key === 'status' && staged) continue
    const text = displayOf(key, item[key])
    if (text === '') continue
    bits.push(text)
    used.add(key)
    if (key === 'stageZh' || key === 'stage') {
      staged = true
      used.add('status')
    }
  }
  for (const [key, item2] of Object.entries(item)) {
    if (bits.length >= 6) break
    if (used.has(key)) continue
    if (typeof item2 === 'string' || typeof item2 === 'number' || typeof item2 === 'boolean') {
      const text = displayOf(key, item2)
      if (text === '') continue
      bits.push(`${key}=${text}`)
    }
  }
  return bits.join('  ')
}

/**
 * 有上限的列表。超过 `MAX_TOOL_ITEMS` 的条目**不渲染**（工具的 execute 已经截过一遍，
 * 这里兜第二道），并在末尾写清还有多少条、怎么缩小范围。
 */
function listLines(items, { name, action, truncated }) {
  const all = Array.isArray(items) ? items : []
  const shown = all.slice(0, MAX_TOOL_ITEMS)
  const lines = []
  for (const item of shown) {
    if (isPlainObject(item)) {
      const row = rowText(item)
      if (row !== '') lines.push(`${BULLET}${row}`)
      else lines.push(`${BULLET}${cellText(item)}`)
      continue
    }
    const text = cellText(item)
    if (text !== '') lines.push(`${BULLET}${text}`)
  }
  const rest = all.length - shown.length
  if (rest > 0 || truncated === true) {
    lines.push(`…还有 ${rest > 0 ? rest : '更多'} 条，用 ${name} ${action} 缩小范围`)
  }
  return lines
}

/** 缩进续行：首行跟字段名，其余行与首行对齐（notes/scope 的每条各自一行）。 */
function fieldLines(label, value, indent) {
  const pad = ' '.repeat(indent.length)
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${label}：（无）`]
    const lines = [`${indent}${label}：`]
    for (const item of value) lines.push(`${pad}  - ${cellText(item)}`)
    return lines
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return [`${indent}${label}：（无）`]
    const lines = [`${indent}${label}：`]
    for (const [key, item] of entries) {
      if (Array.isArray(item)) {
        lines.push(`${pad}  ${key}：`)
        for (const entry of item) lines.push(`${pad}    - ${cellText(entry)}`)
      } else {
        lines.push(`${pad}  ${key}：${cellText(item)}`)
      }
    }
    return lines
  }
  const text = cellText(value)
  if (text === '') return [`${indent}${label}：（空）`]
  const chunks = text.split('\n')
  const lines = [`${indent}${label}：${chunks[0]}`]
  for (const chunk of chunks.slice(1)) lines.push(`${pad}  ${chunk}`)
  return lines
}

/**
 * 一条记录：固定字段顺序，逐行展开的长字段，其余短字段收成一行 `键=值` 列表。
 * 未知键不丢——排在已知键之后；空值不出现（否则输出里全是 `（无）`）。
 * `emptyMark:true` 时，空的数组/对象字段显示成一行 `（无）`：单条记录里「确实没有」
 * 本身是信息，列表行里则不该出现。
 */
function renderRecord(entry, indent) {
  const { record, emptyMark } = entry
  const lines = []
  const done = new Set()
  const expired = (value) => {
    if (isPlainObject(value)) return Object.keys(value).length === 0
    return Array.isArray(value) && value.length === 0
  }
  const push = (key, force) => {
    if (done.has(key) || Object.hasOwn(record, key) === false) return
    const value = record[key]
    if (value === undefined) return
    done.add(key)
    const expandable = LIST_FIELDS.has(key) || TEXT_FIELDS.has(key) || isPlainObject(value)
    if (expandable) {
      if (expired(value) && emptyMark !== true) return
      lines.push(...fieldLines(key, value, indent))
      return
    }
    if (hasValue(value) === false && force !== true) return
    const text = displayOf(key, value)
    if (text === '') return
    lines.push(`${indent}${key}：${text}`)
  }
  for (const key of RECORD_ORDER) push(key, key === 'id' || key === 'title')
  // `stage` 与 `stageZh` 同义：已经显示过中文名就不再重复原始 id。
  if (done.has('stage') && done.has('stageZh') === false) done.add('stageZh')
  if (done.has('stageZh') && done.has('stage') === false) done.add('stage')
  const short = []
  for (const [key, value] of Object.entries(record)) {
    if (done.has(key) || value === undefined) continue
    if (LIST_FIELDS.has(key) || TEXT_FIELDS.has(key) || isPlainObject(value) || Array.isArray(value)) {
      if (expired(value) && emptyMark !== true) continue
      lines.push(...fieldLines(key, value, indent))
      continue
    }
    if (hasValue(value) === false) continue
    const text = displayOf(key, value)
    if (text !== '') short.push(`${key}=${text}`)
  }
  if (short.length > 0) lines.push(`${indent}${short.join(' · ')}`)
  return lines
}

/** 标题行：`<工具> <动作>` + 一行摘要（记录 id/标题 或 计数）。 */
function headLine(name, action, summary) {
  const label = action === '' ? name : `${name} ${action}`
  return summary === '' ? label : `${label} — ${summary}`
}

function actionHint(action) {
  return typeof action === 'string' && action.trim() !== '' ? action.trim() : ''
}

/** `args.action`（宿主给的 render 入参）→ 摘要行用的动作名；没有就是空串。 */
function toolAction(args) {
  return isPlainObject(args) ? actionHint(args.action) : ''
}

// ------------------------------------------------------ per-tool shape renderers
//
// 每个工具一个分支，逐条对照 lib/host/tools.mjs 与 lib/tools/*.mjs 里 action 的
// **真实返回形状**写；没有再往下猜。新增 action 时这里不登记就走兜底 JSON。

function renderFlowTask(name, value, hint) {
  const action = actionHint(hint)
  const failed = renderFailure(name, value, action)
  if (failed !== null) return failed.join('\n')
  if (isPlainObject(value.task)) {
    const task = value.task
    const stage = STAGE_LABELS[task.stage] ?? cellText(task.stage)
    const lines = [headLine(name, action, `${cellText(task.id)} ${cellText(task.title)} · ${stage || '阶段未知'}`)]
    lines.push(...renderRecord({ key: 'task', record: task, emptyMark: true }, ''))
    if (isPlainObject(value.dispatch)) lines.push(...dispatchLines(value.dispatch))
    return lines.join('\n')
  }
  if (value.removed === true) return headLine(name, action, `已删除任务 ${cellText(value.id)}`)
  if (Array.isArray(value.items)) {
    const counts = countsText(value.counts, TASK_STATE_LABELS)
    const total = Number.isInteger(value.total) ? value.total : value.items.length
    const lines = [headLine(name, action, `${total} 个任务${counts === '' ? '' : `（${counts}）`}`)]
    if (value.items.length === 0) {
      lines.push(emptyLine(value.note, '台账里没有任务：用 flow_task add 建一张。'))
    } else {
      lines.push(...listLines(value.items, { name, action, truncated: value.truncated === true }))
      if (typeof value.note === 'string' && value.note !== '') lines.push(value.note)
    }
    if (typeof value.current === 'string' && value.current !== '') lines.push(`当前指针 tasks.current：${value.current}`)
    return lines.join('\n')
  }
  return null
}

/** 派工回执（`{ok, role, childId, from, to, reused, auto, code, error}`）。 */
function dispatchLines(dispatch) {
  const lines = []
  const ok = dispatch.ok !== false
  const role = cellText(dispatch.role)
  const child = cellText(dispatch.childId)
  const from = STAGE_LABELS[dispatch.from] ?? cellText(dispatch.from)
  const to = STAGE_LABELS[dispatch.to] ?? cellText(dispatch.to)
  const edges = from === '' && to === '' ? '' : ` ${from} → ${to}`
  if (ok) {
    const verb = dispatch.reused === true ? '复用已有派工' : dispatch.auto === true ? '已自动派工' : '已派工'
    lines.push(`  ${verb}：${role === '' ? '角色未知' : role}${child === '' ? '' : `（${child}）`}${edges}`)
  } else {
    const code = cellText(dispatch.code) || 'error'
    const message = cellText(dispatch.error) || '（没有给出原因）'
    lines.push(`  ✖ 派工失败：${code}：${message}`)
  }
  return lines
}

function renderFlowSubtask(name, value, hint) {
  const action = actionHint(hint)
  const failed = renderFailure(name, value, action)
  if (failed !== null) return failed.join('\n')
  if (isPlainObject(value.task)) {
    const task = value.task
    const stage = STAGE_LABELS[task.stage] ?? cellText(task.stage)
    const lines = [headLine(name, action, `${cellText(task.id)} ${cellText(task.title)} · ${stage || '阶段未知'}`)]
    lines.push(...renderRecord({ key: 'task', record: task, emptyMark: true }, ''))
    if (isPlainObject(value.dispatch)) lines.push(...dispatchLines(value.dispatch))
    return lines.join('\n')
  }
  return null
}

function renderFlowVeto(name, value, hint) {
  const action = actionHint(hint)
  const failed = renderFailure(name, value, action)
  if (failed !== null) return failed.join('\n')
  const lines = []
  if (isPlainObject(value.task)) {
    const task = value.task
    const stage = STAGE_LABELS[task.stage] ?? cellText(task.stage)
    lines.push(headLine(name, action, `${cellText(task.id)} ${cellText(task.title)} · ${stage || '阶段未知'}`))
    lines.push(...renderRecord({ key: 'task', record: task, emptyMark: true }, ''))
  }
  if (isPlainObject(value.decision)) {
    lines.push(`  否决决定：${cellText(value.decision.id)}${value.created === true ? '（新建）' : ''}`)
  }
  if (value.applied === true) lines.push('  已按用户的选择处理（applied）')
  if (value.applied === false) lines.push('  无需处理（applied=false）')
  if (isPlainObject(value.parent)) lines.push(`  父任务：${cellText(value.parent.id)} ${cellText(value.parent.title)}`)
  return lines.length > 1 ? lines.join('\n') : null
}

function renderFlowStatus(name, value, hint) {
  if (isPlainObject(value) === false) return null
  const failed = renderFailure(name, value, '')
  if (failed !== null) return failed.join('\n')
  const contract = isPlainObject(value.contract) ? value.contract : {}
  const exp = isPlainObject(value.experiments) ? value.experiments : {}
  const tasks = isPlainObject(value.tasks) ? value.tasks : {}
  const gates = Array.isArray(value.gates) ? value.gates : []
  const lines = [
    headLine(
      name,
      '',
      `实验 ${Number.isInteger(exp.total) ? exp.total : 0} · 任务 ${Number.isInteger(tasks.total) ? tasks.total : 0} · 门禁 ${gates.length}`,
    ),
  ]
  lines.push(`  root：${cellText(value.root)}`)
  lines.push(`  store：${value.store === true ? '已初始化' : '缺失（先 node bin/flow.mjs init）'}`)
  const source = cellText(contract.source)
  if (source !== '') {
    const bits = [source]
    if (contract.name !== undefined && contract.name !== null) bits.push(`name=${cellText(contract.name)}`)
    if (Number.isInteger(contract.schema)) bits.push(`schema=${contract.schema}`)
    lines.push(`  contract：${bits.join(' · ')}`)
  }
  const taskCounts = countsText(tasks.counts, TASK_STATE_LABELS)
  if (taskCounts !== '') lines.push(`  任务：${taskCounts}`)
  const expCounts = countsText(exp.counts, EXP_STATE_LABELS)
  if (expCounts !== '') lines.push(`  实验：${expCounts}`)
  if (gates.length > 0) {
    lines.push('  门禁：')
    for (const gate of gates) {
      const last = gate.ok === true ? '通过' : gate.ok === false ? '失败' : '未运行'
      const at = cellText(gate.at)
      lines.push(`    - ${cellText(gate.id)}  ${last}${at === '' ? '' : `  ${at}`}`)
    }
  }
  if (Number.isInteger(value.unfinished)) lines.push(`  未完成任务：${value.unfinished}`)
  if (Array.isArray(value.stack) && value.stack.length > 0) {
    lines.push('  任务栈顶：')
    for (const item of value.stack.slice(0, 10)) {
      if (isPlainObject(item) === false) continue
      const bits = [cellText(item.id), cellText(item.title), cellText(item.stageZh) || cellText(item.stage)]
      lines.push(`    ${BULLET}${bits.filter((bit) => bit !== '').join('  ')}`)
    }
  }
  if (Array.isArray(value.recentCaptured) && value.recentCaptured.length > 0) {
    lines.push('  最近捕获：')
    for (const item of value.recentCaptured.slice(0, 5)) {
      if (isPlainObject(item) === false) continue
      lines.push(`    ${BULLET}${[cellText(item.id), cellText(item.title), cellText(item.at)].filter((bit) => bit !== '').join('  ')}`)
    }
  }
  if (isPlainObject(value.team) && value.team.available === true) {
    lines.push(`  团队：成员 ${cellText(value.team.members)} · 卡 ${cellText(value.team.tasks)} · 已关联 ${cellText(value.team.linked)} · 缺失 ${cellText(value.team.missing)} · 孤儿 ${cellText(value.team.orphaned)}`)
  }
  return lines.join('\n')
}

function renderFlowHeartbeat(name, value, hint) {
  const action = actionHint(hint)
  const failed = renderFailure(name, value, action)
  if (failed !== null) return failed.join('\n')
  if (Array.isArray(value.items) && isPlainObject(value.counts)) {
    const counts = countsText(value.counts, { total: '合计', active: '活跃', stale: '陈旧', hidden: '隐藏', dead: '已死' })
    const lines = [headLine(name, action, `${value.items.length} 条心跳${counts === '' ? '' : `（${counts}）`}`)]
    if (value.items.length === 0) lines.push(emptyLine('', '没有可见的心跳记录。'))
    else lines.push(...listLines(value.items, { name, action, truncated: value.truncated === true }))
    if (Array.isArray(value.warnings)) {
      for (const warning of value.warnings) lines.push(`  ! ${cellText(warning)}`)
    }
    return lines.join('\n')
  }
  const record = isPlainObject(value.record) ? value.record : null
  if (value.active !== undefined || record !== null) {
    const state = value.active === true ? '活跃' : '不活跃'
    const session = cellText(value.session)
    const lines = [headLine(name, action, `${session === '' ? '本会话' : session} · ${state}`)]
    if (isPlainObject(value.heartbeat)) {
      lines.push(...renderRecord({ key: 'heartbeat', record: value.heartbeat, emptyMark: true }, '  '))
    } else if (record === null) {
      lines.push('  没有心跳记录。')
    } else {
      lines.push(...renderRecord({ key: 'record', record, emptyMark: true }, '  '))
    }
    const liveness = cellText(value.liveness)
    if (liveness !== '') lines.push(`  存活性：${liveness}${Number.isFinite(value.ageSeconds) ? `（${value.ageSeconds}s 前）` : ''}`)
    if (Array.isArray(value.warnings)) {
      for (const warning of value.warnings) lines.push(`  ! ${cellText(warning)}`)
    }
    return lines.join('\n')
  }
  return null
}

function renderFlowDecision(name, value, hint) {
  const action = actionHint(hint)
  const failed = renderFailure(name, value, action)
  if (failed !== null) return failed.join('\n')
  if (isPlainObject(value.decision)) {
    const decision = value.decision
    const status = STATUS_LABELS[decision.status] ?? cellText(decision.status)
    const suffix = value.created === true ? '（新建）' : value.created === false ? '（复用已有）' : ''
    const lines = [headLine(name, action, `${cellText(decision.id)} ${status}${suffix}`)]
    lines.push(...renderRecord({ key: 'decision', record: decision, emptyMark: true }, ''))
    if (value.vetoApplied === true) lines.push('  否决已自动应用到任务（vetoApplied）')
    if (value.vetoApplied === false && typeof value.vetoWarning === 'string' && value.vetoWarning !== '') {
      lines.push(`  ! 否决未应用：${value.vetoWarning}`)
    }
    if (isPlainObject(value.task)) lines.push(...renderRecord({ key: 'task', record: value.task }, '  '))
    return lines.join('\n')
  }
  if (Array.isArray(value.items)) {
    const counts = countsText(value.counts, { open: '待决', blocking: '阻塞', escalated: '升级', answered: '已答', withdrawn: '已撤', superseded: '已取代', total: '合计' })
    const lines = [headLine(name, action, `${value.items.length} 条决定${counts === '' ? '' : `（${counts}）`}`)]
    if (value.items.length === 0) lines.push(emptyLine(value.note, '没有待决问题。'))
    else lines.push(...listLines(value.items, { name, action, truncated: value.truncated === true }))
    return lines.join('\n')
  }
  if (Array.isArray(value.removed) && value.kept !== undefined) {
    const lines = [headLine(name, action, `${value.dryRun === true ? '预演' : '已清理'} ${value.removed.length} 条 · 保留 ${cellText(value.kept)} 条`)]
    if (value.removed.length === 0) lines.push('  没有到期可清理的决定。')
    else lines.push(...listLines(value.removed, { name, action, truncated: false }))
    return lines.join('\n')
  }
  return null
}

function renderFlowExp(name, value, hint) {
  const action = actionHint(hint)
  const failed = renderFailure(name, value, action)
  if (failed !== null) return failed.join('\n')
  if (isPlainObject(value.experiment)) {
    const experiment = value.experiment
    const status = STATUS_LABELS[experiment.status] ?? cellText(experiment.status)
    const lines = [headLine(name, action, `${cellText(experiment.id)} ${cellText(experiment.title)} · ${status || '状态未知'}`)]
    lines.push(...renderRecord({ key: 'experiment', record: experiment, emptyMark: true }, ''))
    return lines.join('\n')
  }
  if (Array.isArray(value.items)) {
    const counts = countsText(value.counts, EXP_STATE_LABELS)
    const total = Number.isInteger(value.total) ? value.total : value.items.length
    const lines = [headLine(name, action, `${total} 个实验${counts === '' ? '' : `（${counts}）`}`)]
    if (value.items.length === 0) lines.push(emptyLine(value.note, '台账里没有实验：用 flow_exp add 建一个。'))
    else lines.push(...listLines(value.items, { name, action, truncated: value.truncated === true }))
    return lines.join('\n')
  }
  if (Array.isArray(value.tree)) {
    const lines = [headLine(name, action, `${value.tree.length} 棵根`)]
    if (value.tree.length === 0) lines.push('台账里没有实验。')
    else lines.push(...treeLines(value.tree, 1))
    return lines.join('\n')
  }
  if (isPlainObject(value.review)) {
    const review = value.review
    const verdict = review.verdict === 'complete' ? '完整' : '不完整'
    const lines = [headLine(name, action, `${cellText(review.id)} · ${verdict} · 分支 ${cellText(review.branch)}`)]
    lines.push(...renderRecord({ key: 'review', record: review, emptyMark: true }, '  '))
    return lines.join('\n')
  }
  if (isPlainObject(value.cleanup) || value.cleanupAt !== undefined) {
    const lines = [headLine(name, action, `${cellText(value.id)} · ${value.changed === true ? '已记录清理' : '没有变化'}`)]
    if (isPlainObject(value.cleanup)) lines.push(...renderRecord({ key: 'cleanup', record: value.cleanup, emptyMark: true }, '  '))
    if (value.cleanupAt !== undefined) lines.push(`  cleanupAt：${cellText(value.cleanupAt)}`)
    return lines.join('\n')
  }
  if (value.productizeGate !== undefined || value.productizedAt !== undefined) {
    const lines = [headLine(name, action, `${cellText(value.id)} · ${value.already === true ? '已产品化' : '已标记产品化'}`)]
    if (isPlainObject(value.productizeGate)) lines.push(...renderRecord({ key: 'productizeGate', record: value.productizeGate, emptyMark: true }, '  '))
    if (value.productizedAt !== undefined) lines.push(`  productizedAt：${cellText(value.productizedAt)}`)
    return lines.join('\n')
  }
  if (value.removed === true) return headLine(name, action, `已删除实验 ${cellText(value.id)}`)
  return null
}

/** 实验树：每层一条 `- id 标题 状态`，子节点缩进（深度无上限，树本身有界）。 */
function treeLines(nodes, depth) {
  const lines = []
  const indent = '  '.repeat(depth)
  for (const node of nodes) {
    if (isPlainObject(node) === false) continue
    const status = STATUS_LABELS[node.status] ?? cellText(node.status)
    lines.push(`${indent}${BULLET}${[cellText(node.id), cellText(node.title), status].filter((bit) => bit !== '').join('  ')}`)
    if (Array.isArray(node.children) && node.children.length > 0) lines.push(...treeLines(node.children, depth + 1))
  }
  return lines
}

function renderFlowGate(name, value, hint) {
  const action = actionHint(hint)
  const failed = renderFailure(name, value, action)
  if (failed !== null) return failed.join('\n')
  if (isPlainObject(value.run)) return renderGateRun(name, action, value.run).join('\n')
  if (isPlainObject(value.gate)) {
    const gate = value.gate
    const lines = [headLine(name, action, `${cellText(gate.id)} ${cellText(gate.title)} · ${gate.enabled === false ? '已禁用' : '已启用'}`)]
    lines.push(...renderRecord({ key: 'gate', record: gate, emptyMark: true }, ''))
    if (isPlainObject(value.lastRun)) lines.push(...renderGateRun(name, '上次运行', value.lastRun))
    return lines.join('\n')
  }
  if (Array.isArray(value.runs)) {
    const lines = [headLine(name, action, `${cellText(value.gate)} · ${value.runs.length} 条运行记录`)]
    if (value.runs.length === 0) lines.push('没有运行记录。')
    else lines.push(...listLines(value.runs, { name, action, truncated: false }))
    return lines.join('\n')
  }
  if (Array.isArray(value.gates)) {
    const ok = value.gates.filter((gate) => isPlainObject(gate) && isPlainObject(gate.lastRun) && gate.lastRun.ok === true).length
    const lines = [headLine(name, action, `${value.gates.length} 个门禁 · 最近一次通过 ${ok}`)]
    if (value.gates.length === 0) lines.push(emptyLine(value.note, '没有门禁定义：用 flow_gate add 建一个。'))
    else {
      for (const gate of value.gates) {
        if (isPlainObject(gate) === false) continue
        const last = isPlainObject(gate.lastRun) ? (gate.lastRun.ok === true ? '通过' : '失败') : '未运行'
        const bits = [cellText(gate.id), cellText(gate.title), gate.enabled === false ? '已禁用' : '已启用', last]
        if (isPlainObject(gate.lastRun)) bits.push(cellText(gate.lastRun.finished_at) || cellText(gate.lastRun.started_at))
        lines.push(`  ${BULLET}${bits.filter((bit) => bit !== '').join('  ')}`)
      }
    }
    return lines.join('\n')
  }
  if (value.removed === true) return headLine(name, action, `已删除门禁 ${cellText(value.id)}`)
  return null
}

/** 一次门禁运行：结论一行 + 每步一行（失败步带原因）。 */
function renderGateRun(name, action, run) {
  const ok = run.ok === true
  const steps = Array.isArray(run.steps) ? run.steps : []
  const summary = [cellText(run.gate), ok ? '通过' : '失败', Number.isFinite(run.durationMs) ? `${run.durationMs}ms` : '']
    .filter((bit) => bit !== '')
    .join(' · ')
  const lines = [headLine(name, action === '' ? 'run' : action, summary)]
  if (run.started_at !== undefined) lines.push(`  开始：${cellText(run.started_at)}${run.finished_at !== undefined ? ` · 结束：${cellText(run.finished_at)}` : ''}`)
  for (const step of steps) {
    if (isPlainObject(step) === false) continue
    const mark = step.ok === true ? '✓' : '✖'
    const result = cellText(step.expectActual) || cellText(step.actual)
    const bits = [`${mark} ${cellText(step.id) || 'step'}`]
    if (result !== '') bits.push(` ${cellText(step.expect) || 'exit 0'} → ${result}`)
    else if (cellText(step.expect) !== '') bits.push(` ${cellText(step.expect)}`)
    if (Number.isFinite(step.durationMs)) bits.push(` ${step.durationMs}ms`)
    lines.push(`  ${bits.join('  ')}`)
    const reason = cellText(step.error) || cellText(step.message) || cellText(step.reason)
    if (reason !== '' && step.ok !== true) lines.push(`      原因：${reason}`)
  }
  if (isPlainObject(run.error)) lines.push(`  ✖ ${cellText(run.error.code) || 'error'}：${cellText(run.error.message)}`)
  if (ok === false && steps.length === 0 && isPlainObject(run.error) === false) lines.push('  ✖ 运行失败：没有执行任何步骤')
  return lines
}

/** 兜底渲染：任何未登记形状（含渲染器自身出错）都回落到这份逐字节稳定的 JSON。 */
function jsonFallback(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const TOOL_RENDERERS = Object.freeze({
  flow_task: renderFlowTask,
  flow_subtask: renderFlowSubtask,
  flow_veto: renderFlowVeto,
  flow_status: renderFlowStatus,
  flow_heartbeat: renderFlowHeartbeat,
  flow_decision: renderFlowDecision,
  flow_exp: renderFlowExp,
  flow_gate: renderFlowGate,
})

/**
 * 把一次 `flow_*` 工具调用的结果值渲染成**给人看的中文文本**。
 *
 * 纯函数：不读宿主服务、不改 `value`（只读它）；任何异常都回落到
 * `JSON.stringify(value, null, 2)`，所以一次成功的调用不会因为渲染而失败。
 *
 * @param {string|undefined} name 工具线名（`flow_task` 等）；缺省或未登记时走兜底 JSON
 * @param {unknown} value 工具 `execute` 的返回值（规范值，不在这里改写）
 * @param {string} [action] 本次调用的 action（来自 args），只用于摘要行与空态提示
 * @returns {string} 多行文本
 */
export function renderToolText(name, value, action) {
  try {
    const renderer = typeof name === 'string' && Object.hasOwn(TOOL_RENDERERS, name) ? TOOL_RENDERERS[name] : undefined
    if (renderer === undefined) return jsonFallback(value)
    const text = renderer(name, value, action)
    // 分支返回 null = 未登记的形状：兜底 JSON，永不丢信息。
    return typeof text === 'string' && text !== '' ? text : jsonFallback(value)
  } catch {
    return jsonFallback(value)
  }
}

/**
 * Registry-ready output contract.
 *
 * `schema` 固定为 `{type:'object'}`（机器可读性由 render 之前的规范值保证，这里
 * 不动字段）；`render` 只产出人看的中文报告。`name` 是工具线名（`flow_task` 等），
 * 缺省时不报错——按未登记形状走兜底 JSON（兼容旧的无参调用）。
 *
 * @param {string} [name]
 */
export function toolOutput(name) {
  return {
    schema: { type: 'object' },
    render: (args, value) => [{ type: 'text', text: renderToolText(name, value, toolAction(args)) }],
  }
}