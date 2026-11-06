// lib/state-snapshot.mjs — 只读快照（宿主 state 读的 fork 隔离单元）。
//
// 这个模块有两种身份，靠 `PF_STATE_WORKER` 区分：
//   1. 被宿主 `child_process.fork()` 起来时，它是 worker：接 IPC 的 snapshot 请求、
//      组装 payload、回一条 JSON reply；stdout/stderr 全为 ignore，不写任何输出。
//   2. 被测试或没有 worker 池的宿主 import 时，它只是纯函数库（`buildSnapshot`）。
//
// 为什么是进程而不是 worker_threads：容器里实测 `worker.terminate()` 对阻塞在
// fs syscall 的线程无效（FIFO 上 >3s 未回收），而 fork + SIGKILL 3ms 回收。宿主
// 因此永远不阻塞：store 的同步读、git 子进程和 realpath 回溯都发生在子进程里。
//
// 快照必须自给自足：core 的读聚合入口、投影辅助函数、per-request realpath memo
// 都在这里创建。memo 绝不跨进程传递（结构化克隆会丢掉 fs Error 的 `code`，而
// 失败回溯依赖 `code === ENOENT/ENOTDIR`），所以每次 buildSnapshot 新建一个 Map。
//
// 宿主（index.js）仍保留：root 解析（async realpath/stat）、注册表枚举、写路径
// （init/gate 在同一进程里 withLock）、工具面。本模块不 import 宿主，也不做写操作。

import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Absolute directory of this module (`lib/`); core sits next to it. */
const LIB_ROOT = dirname(fileURLToPath(import.meta.url))
const CORE_URL = pathToFileURL(join(LIB_ROOT, 'core.mjs')).href

const GIT_TIMEOUT_MS = 4000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const MAX_STRING = 400
const MAX_PAYLOAD_BYTES = 900 * 1000
const MAX_STORE_ITEMS = 400
const MAX_DRAFT_TASKS = 50
/** Task rows per panel group; the panel itself renders at most 25 per list. */
const MAX_TASK_ROWS = 50
/** Visual tree depth cap for task rows (T-13 A2); deeper chains report 3. */
const MAX_TASK_DEPTH = 3
/** One bounded detail entry (file claim, acceptance command, commit sha). */
const MAX_TASK_ITEM = 200
/** Experiment states the panel/TUI project; `counts` carries all six plus total. */
const EXPERIMENT_STATUS_SIX = ['open', 'confirmed', 'refuted', 'abandoned', 'inconclusive', 'pivoted']
/** Trend window cap: 60 local days keeps the payload under ~720 B. */
const MAX_TREND_DAYS = 60
const TREND_DEFAULT_DAYS = 14
const DAY_MS = 86_400_000
/** Roots this worker process already pointed at the opt-in flag (one-shot). */
const LEGACY_EXPERIMENTS_WARNED = new Set()
/** Detail list length per task (`scope.allow`/`scope.deny`/`acceptance`/`commits`). */
const MAX_TASK_LIST = 10

const STORE_CONTRACT = join('.dsh', 'flow', 'flow.json')

// --------------------------------------------------------------- core module
//
// The store writer lives in lib/core.mjs and is shared with bin/flow.mjs. It is
// optional: a broken or absent module makes the state endpoint report an empty
// store payload with a `core-unavailable` warning and the tools report an
// actionable error, instead of failing the whole plugin load.

let core = null
let coreFailure = ''
try {
  core = await import(CORE_URL)
} catch (error) {
  coreFailure = brief(error, 200)
}

/** Drain core's global diagnostic log (never throws; keeps only usable strings). */
function takeCoreWarnings() {
  if (coreAvailable() === false || typeof core.drainWarnings !== 'function') return []
  try {
    const items = core.drainWarnings()
    return Array.isArray(items) ? items.filter((item) => typeof item === 'string' && item !== '') : []
  } catch {
    return []
  }
}

/**
 * The loaded lib/core.mjs module, or null when it could not be loaded.
 *
 * The host half imports this instead of holding its own copy: one module
 * instance serves both the request tools and the snapshot worker (in-process),
 * so warning draining and store state stay single-sourced.
 */
export function coreModule() {
  return core
}

/** The single message for an unloadable core; both `apply` and the payload add it. */
function coreUnavailableMessage() {
  return `core-unavailable: lib/core.mjs could not be loaded (${coreFailure || 'unknown error'}); the store, flow_* tools and skills are unavailable`
}

function coreAvailable() {
  return core !== null && typeof core === 'object'
}

function requireCore() {
  if (coreAvailable() === false) {
    throw new Error(
      'project flow core is not installed (lib/core.mjs could not be loaded); reinstall the project-flow plugin or use the CLI: node bin/flow.mjs',
    )
  }
  return core
}

// ---------------------------------------------------------------- primitives

/** Locale-shaped ISO-8601 timestamp with the host offset, e.g. 2026-10-28T11:30:00+08:00. */
export function isoLocal(date) {
  const pad = (n) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hours = pad(Math.floor(Math.abs(offset) / 60))
  const minutes = pad(Math.abs(offset) % 60)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${hours}:${minutes}`
  )
}

/** Truncate a value to at most `max` characters without throwing on non-strings. */
function clip(value, max = MAX_STRING) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

function errorText(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/** One-line, bounded error text suitable for a warnings entry. */
function brief(error, max = 200) {
  return clip(errorText(error).replace(/\s+/g, ' ').trim(), max)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Split into lines, dropping only a trailing empty line, keeping indentation. */
function splitLines(text) {
  const lines = String(text).split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

// --------------------------------------------------------- path containment
//
// Local mirror of `containedPath` in lib/core.mjs, used by the state payload to
// re-validate a root-relative path echoed by the store reader (`tasks.current`):
// absolute input is rejected, `..` escapes are rejected, and existing/ancestor
// targets are re-checked through realpath so a symlink cannot lead outside the
// project root. Unsafe values never throw: the caller hides the value and one
// warning names the key and raw value (never file content).

function rejectManifestPath(warnings, label, value, reason) {
  const preview = clip(String(value ?? '').replace(/\s+/g, ' ').trim(), 200)
  warnings.push(`manifest-path-rejected: ${label}: ${preview}: ${reason}`)
}

function pathWithin(parent, child) {
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = fold(parent)
  const target = fold(child)
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * `realpathSync` through an optional per-request memo.
 *
 * The memo is a plain `Map` created by the request entry (`collectPanelState`)
 * and passed down explicitly — never a module-level cache, because a mount can
 * appear or disappear between requests. Failures are memoized too (the error is
 * rethrown): within one read-only request the same missing path is walked once,
 * and only request entries that cannot create directories pass a memo.
 */
function memoizedRealpath(path, pathMemo) {
  if (pathMemo === undefined) return realpathSync(path)
  const cached = pathMemo.get(path)
  if (cached instanceof Error) throw cached
  if (cached !== undefined) return cached
  try {
    const real = realpathSync(path)
    pathMemo.set(path, real)
    return real
  } catch (error) {
    const stored = error instanceof Error ? error : Object.assign(new Error(String(error)), { code: error?.code })
    pathMemo.set(path, stored)
    throw stored
  }
}

/**
 * Containment check for one path. `options.realRoot` is the already-canonical
 * root (`canonicalRoot` output): passing it removes the per-check root realpath,
 * exactly what `realpathSync(absRoot)` would have returned. `options.pathMemo`
 * shares target resolutions across the whole request (and with lib/core.mjs).
 */
function realPathStaysInside(absRoot, target, options = {}) {
  const pathMemo = options !== null && typeof options === 'object' && options.pathMemo instanceof Map ? options.pathMemo : undefined
  const provided = options !== null && typeof options === 'object' ? options.realRoot : undefined
  let realRoot
  if (typeof provided === 'string' && provided.length > 0) {
    realRoot = provided
  } else {
    try {
      realRoot = memoizedRealpath(absRoot, pathMemo)
    } catch {
      // The project root does not exist yet: only the lexical check is meaningful.
      return pathWithin(absRoot, target)
    }
  }
  let current = target
  for (;;) {
    try {
      return pathWithin(realRoot, memoizedRealpath(current, pathMemo))
    } catch (error) {
      const code = error !== null && error !== undefined ? error.code : undefined
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return false
      try {
        if (lstatSync(current).isSymbolicLink()) return false
      } catch {
        // The component is absent: keep walking up toward the root.
      }
      const parent = dirname(current)
      if (parent === current) return false
      current = parent
    }
  }
}

/**
 * Absolute in-root path for one manifest value, or `undefined` after pushing a
 * warning when the value is absolute (unless `options.allowAbsolute`), escapes
 * the root lexically, or resolves outside it through a symlink.
 */
function containedPath(root, value, label, warnings, options = {}) {
  const absRoot = resolve(root)
  const allowAbsolute = options !== null && typeof options === 'object' && options.allowAbsolute === true
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const raw = value.trim()
  const target = isAbsolute(raw) ? resolve(raw) : resolve(absRoot, raw)
  if (isAbsolute(raw) && allowAbsolute !== true) {
    rejectManifestPath(warnings, label, raw, 'absolute paths are not allowed')
    return undefined
  }
  if (pathWithin(absRoot, target) !== true && realPathStaysInside(absRoot, target, options) !== true) {
    rejectManifestPath(warnings, label, raw, 'escapes the project root')
    return undefined
  }
  if (realPathStaysInside(absRoot, target, options) !== true) {
    rejectManifestPath(warnings, label, raw, 'a symlink resolves outside the project root')
    return undefined
  }
  return target
}

/** Run git with a hard timeout. Never rejects: failures are reported in the result. */
function git(cwd, args, timeout = GIT_TIMEOUT_MS) {
  return new Promise((settle) => {
    try {
      execFile(
        'git',
        ['-C', cwd, ...args],
        { timeout, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => {
          if (error) settle({ ok: false, stdout: String(stdout ?? ''), error })
          else settle({ ok: true, stdout: String(stdout ?? '') })
        },
      )
    } catch (error) {
      settle({ ok: false, stdout: '', error })
    }
  })
}

// ------------------------------------------------------------------ contract

function pickInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || Number.isFinite(value) === false) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/** Manifest display name; async so a slow root cannot block the request loop. */
async function readManifestName(root) {
  try {
    const parsed = JSON.parse(await readFile(storeContractPath(root), 'utf8'))
    if (isPlainObject(parsed) && typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
      return parsed.name.trim()
    }
  } catch {
    // Fall through to the directory name.
  }
  return basename(root)
}

function storeContractPath(root) {
  return join(root, STORE_CONTRACT)
}

// ----------------------------------------------------------------------- head

async function readHead(root, warnings) {
  const head = { sha: null, subject: null, branch: null, dirty: null }
  const failures = []

  const sha = await git(root, ['rev-parse', '--short', 'HEAD'])
  if (sha.ok) {
    const value = sha.stdout.trim()
    if (value.length > 0) head.sha = value
  } else {
    failures.push(['rev-parse', sha.error])
  }

  const subject = await git(root, ['log', '-1', '--pretty=%s'])
  if (subject.ok) {
    head.subject = subject.stdout.replace(/\n$/, '')
  } else {
    failures.push(['log -1', subject.error])
  }

  const branch = await git(root, ['branch', '--show-current'])
  if (branch.ok) {
    const value = branch.stdout.trim()
    head.branch = value.length > 0 ? value : null
  } else {
    failures.push(['branch', branch.error])
  }

  const status = await git(root, ['status', '--porcelain=v1'])
  if (status.ok) {
    head.dirty = splitLines(status.stdout).length
  } else {
    failures.push(['status', status.error])
  }

  if (failures.length === 4) {
    // Not a git checkout: expected for non-git projects, reported once.
    warnings.push(`not a git repository: ${brief(failures[0][1])}`)
  } else {
    for (const [command, error] of failures) {
      warnings.push(`git ${command} failed: ${brief(error)}`)
    }
  }
  return head
}

// ---------------------------------------------------------------------- tasks


function timeValue(value) {
  const stamp = Date.parse(typeof value === 'string' ? value : '')
  return Number.isFinite(stamp) ? stamp : Number.NEGATIVE_INFINITY
}

function lastCheckpointGate(task) {
  const checkpoints = Array.isArray(task.checkpoints) ? task.checkpoints : []
  if (checkpoints.length === 0) return null
  const last = checkpoints[checkpoints.length - 1]
  if (!isPlainObject(last)) return null
  return typeof last.gate === 'string' ? last.gate : null
}

/** Bounded string list for one task row: entries are clipped, non-strings dropped. */
function clipTaskList(value, limit = MAX_TASK_LIST) {
  if (Array.isArray(value) === false) return []
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const text = clip(entry, MAX_TASK_ITEM)
    if (text !== '') out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Acceptance entries are strings or legacy `{cmd, expect}` objects. The panel
 * renders one bounded line per entry, so both shapes flatten to text here.
 */
function clipTaskAcceptance(value) {
  if (Array.isArray(value) === false) return []
  const out = []
  for (const entry of value) {
    let text = ''
    if (typeof entry === 'string') text = clip(entry, MAX_TASK_ITEM)
    else if (isPlainObject(entry)) {
      const cmd = typeof entry.cmd === 'string' ? entry.cmd.trim() : ''
      const expect = typeof entry.expect === 'string' ? entry.expect.trim() : ''
      text = clip(cmd !== '' && expect !== '' ? `${cmd} => ${expect}` : cmd || expect, MAX_TASK_ITEM)
    }
    if (text !== '') out.push(text)
    if (out.length >= MAX_TASK_LIST) break
  }
  return out
}

/** `scope` is `{allow, deny}`; both lists are bounded and never carried raw. */
function clipTaskScope(value) {
  const scope = isPlainObject(value) ? value : {}
  return { allow: clipTaskList(scope.allow), deny: clipTaskList(scope.deny) }
}

/**
 * One task row for the panel. `type` + `title` drive the first visible line and
 * `notes` the second; the signature line is the `id`. The remaining fields feed
 * the expanded detail block, so every value stays bounded (single strings
 * clipped, arrays limited) regardless of what the store holds.
 *
 * Key order is the contract: the client, `.selftest/host2-tools.mjs` and
 * `CONTRACT.md` §9.1.4 all list it literally — change one, change all three.
 */
function panelTaskRow(record, status, depthOf) {
  const parent = taskParentOf(record)
  return {
    id: clip(record.id),
    type: clip(record.type),
    title: clip(record.title),
    status,
    owner: clip(record.owner),
    notes: clip(record.notes),
    scope: clipTaskScope(record.scope),
    acceptance: clipTaskAcceptance(record.acceptance),
    commits: clipTaskList(record.commits),
    created_at: clip(record.created_at),
    updated_at: clip(record.updated_at),
    /* T-13 A2: tree information rides on the row only; the arrays keep their
       FIFO / recency order so the client can nest without reordering. */
    parent: parent === '' ? null : clip(parent),
    depth: typeof depthOf === 'function' ? depthOf(record) : 0,
  }
}



// ----------------------------------------------------------------- heartbeats


/**
 * Project one rich heartbeat item (`{file, title?, session, goal, status,
 * last_action, …}`) onto the row the panel renders. The panel reads `title` and
 * `statusLine`; the richer core projection carries `goal` and the unsplit
 * `status` / `last_action`, so those are derived here instead of leaving the row
 * blank. Unknown fields pass through untouched.
 */
function panelHeartbeat(item) {
  if (!isPlainObject(item)) return null
  const file = typeof item.file === 'string' ? item.file : ''
  const status = typeof item.status === 'string' ? item.status.trim() : ''
  const action = typeof item.last_action === 'string' ? item.last_action.trim() : ''
  const statusLine =
    typeof item.statusLine === 'string' && item.statusLine.trim().length > 0
      ? item.statusLine.trim()
      : [status, action].filter((part) => part.length > 0).join(' · ')
  const goal = typeof item.goal === 'string' ? item.goal.trim() : ''
  const session = typeof item.session === 'string' ? item.session.trim() : ''
  const title =
    typeof item.title === 'string' && item.title.trim().length > 0
      ? item.title.trim()
      : goal.length > 0
        ? goal
        : session.length > 0
          ? session
          : file.replace(/\.[^.]+$/, '')
  return { ...item, title: clip(title, 160), statusLine: clip(statusLine, 200) }
}

/** Panel rows from the richer core section; empty when the section is unusable. */
function panelHeartbeats(section) {
  const items = isPlainObject(section) && Array.isArray(section.items) ? section.items : []
  const rows = []
  for (const item of items) {
    const row = panelHeartbeat(item)
    if (row !== null) rows.push(row)
  }
  return rows
}

/**
 * Whether one heartbeat row still belongs to a session that may exist: `live`
 * rows and fresh `unknown`/`foreign` rows are visible; `dead`/`stale` (and rows
 * without a usable age) are hidden.
 *
 * Exported because the host applies the same rule AFTER `applyAgentLiveness`:
 * the forked snapshot cannot know about the host's `agents` service, which is
 * the only thing that may revive a merely-stale row. Never writes anything.
 */
export function heartbeatRowVisible(item) {
  if (isPlainObject(item) === false) return false
  if (item.liveness === 'live') return true
  if (item.liveness === 'dead' || item.liveness === 'stale') return false
  if (Number.isFinite(item.ageSeconds) === false) return false
  return item.ageSeconds <= 6 * 60 * 60
}


// ----------------------------------------------------------------- decisions
//
// The decisions section is shared cross-domain: index.js, client.js and both
// self-tests carry the same literal key list, so the projection below is built
// from it and never grows a field by accident.

/** Key set and order of one panel decision row (cross-domain literal). */
const DECISION_ITEM_KEYS = [
  'id',
  'kind',
  'status',
  'question',
  'blocks',
  'options',
  'recommendation',
  'default',
  'escalated',
  'ageSeconds',
  'asked_at',
]

/** One decision option: only the three display fields, bounded. */
function panelDecisionOption(option) {
  if (isPlainObject(option) === false) return null
  return { id: clip(option.id, 40), label: clip(option.label, 80), impact: clip(option.impact, 120) }
}

/**
 * Project one open decision onto the row the panel renders. The row is built
 * from DECISION_ITEM_KEYS, so fields that must not reach the browser (`turnAge`,
 * `rationale`, `affects`, `fingerprint`) are dropped rather than filtered later.
 */
function panelDecision(item) {
  if (isPlainObject(item) === false) return null
  const options = []
  if (Array.isArray(item.options)) {
    for (const option of item.options) {
      const row = panelDecisionOption(option)
      if (row !== null) options.push(row)
    }
  }
  const blocks = Array.isArray(item.blocks)
    ? item.blocks.filter((id) => typeof id === 'string' && id !== '').map((id) => clip(id, 40))
    : []
  const values = {
    id: clip(item.id, 40),
    kind: clip(item.kind, 20),
    status: clip(item.status, 20),
    question: clip(item.question, 200),
    blocks,
    options,
    recommendation: clip(item.recommendation, 60),
    default: clip(item.default, 60),
    escalated: item.escalated === true,
    ageSeconds:
      typeof item.ageSeconds === 'number' && Number.isFinite(item.ageSeconds)
        ? Math.max(0, Math.trunc(item.ageSeconds))
        : null,
    asked_at: clip(item.asked_at, 64),
  }
  const row = {}
  for (const key of DECISION_ITEM_KEYS) row[key] = values[key]
  return row
}

/**
 * Panel decisions section: bounded rows plus the seven counts. A missing or
 * unusable section degrades to the empty one instead of failing the payload.
 */
function panelDecisions(section, limit = decisionRemindMax()) {
  const items = isPlainObject(section) && Array.isArray(section.items) ? section.items : []
  const rows = []
  for (const item of items) {
    if (rows.length >= limit) break
    const row = panelDecision(item)
    if (row !== null) rows.push(row)
  }
  return { items: rows, counts: decisionCountsOf(isPlainObject(section) ? section.counts : null) }
}

/**
 * The decisions section of one store payload. A newer lib/core.mjs already
 * returns it from `readStoreState`; otherwise the same projection is rebuilt with
 * `summarizeDecisions`, so the payload shape does not depend on which side of the
 * Host/core split landed first.
 */
function decisionSection(state, root, contract) {
  const supplied = isPlainObject(state) ? state.decisions : undefined
  if (isPlainObject(supplied)) return supplied
  const c = requireCore()
  if (typeof c.summarizeDecisions !== 'function') return null
  return c.summarizeDecisions(root, contract, { limit: decisionRemindMax() })
}


// -------------------------------------------------------------------- payload

/** Drop tree nodes whose id is no longer in `items`, recursively. */
function pruneTree(nodes, ids) {
  if (Array.isArray(nodes) === false) return []
  const kept = []
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    if (typeof node.id === 'string' && ids.has(node.id) === false) continue
    kept.push({ ...node, children: pruneTree(node.children, ids) })
  }
  return kept
}

/** Keep the response well under 1 MB without throwing: drop the least important tail first. */
function capPayload(payload) {
  let body = JSON.stringify(payload)
  if (Buffer.byteLength(body) <= MAX_PAYLOAD_BYTES) return body

  payload.warnings.push('payload-truncated')

  const items = Array.isArray(payload.experiments.items) ? payload.experiments.items : []
  let truncated = false
  while (items.length > 0) {
    items.pop()
    truncated = true
    const ids = new Set(items.map((item) => (isPlainObject(item) ? item.id : undefined)))
    payload.experiments.tree = pruneTree(payload.experiments.tree, ids)
    body = JSON.stringify(payload)
    if (Buffer.byteLength(body) <= MAX_PAYLOAD_BYTES) return body
  }
  if (truncated) payload.warnings.push('items-truncated')

  payload.warnings = payload.warnings.slice(0, 20)
  return JSON.stringify(payload)
}

function taskCountsOf(records) {
  const counts = { draft: 0, active: 0, done: 0, archived: 0, other: 0 }
  for (const record of records) {
    const status = isPlainObject(record) && typeof record.status === 'string' ? record.status : ''
    if (Object.hasOwn(counts, status) && status !== 'other') counts[status] += 1
    else counts.other += 1
  }
  return counts
}

/**
 * Oldest-created first: the task queue is FIFO, so a row keeps its place when the
 * task is patched. A record without a parseable `created_at` sorts last (an
 * unknown age must not jump the queue), and the id breaks ties deterministically.
 */
function createdOrder(records) {
  const createdAt = (record) => {
    const raw = isPlainObject(record) && typeof record.created_at === 'string' ? record.created_at : ''
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  return records.sort((left, right) => {
    const a = createdAt(left)
    const b = createdAt(right)
    if (a !== null && b !== null) {
      if (a !== b) return a - b
    } else if (a === null && b !== null) return 1
    else if (a !== null && b === null) return -1
    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
  })
}

/** Parent id stored on a task row; '' means root/absent (T-13). */
function taskParentOf(record) {
  return isPlainObject(record) && typeof record.parent === 'string' ? record.parent.trim() : ''
}

/**
 * Depth of every task along its parent chain, capped at MAX_TASK_DEPTH.
 *
 * A missing/unreadable parent and a cycle both collapse to a root (`0`), so a
 * deleted parent or historical bad data never throws or hides a row (T-13 A2).
 * Core already nulls those parents on the read path; this stays defensive for
 * direct projections and keeps the depth consistent with the visible row.
 */
function taskDepthIndex(records) {
  const list = Array.isArray(records) ? records.filter(isPlainObject) : []
  const byId = new Map()
  for (const record of list) {
    if (typeof record.id === 'string') byId.set(record.id, record)
  }
  return (record) => {
    if (isPlainObject(record) === false) return 0
    let depth = 0
    let cursor = record
    const seen = new Set()
    while (true) {
      const id = typeof cursor.id === 'string' ? cursor.id : ''
      if (id !== '') {
        if (seen.has(id)) return 0
        seen.add(id)
      }
      const parentId = taskParentOf(cursor)
      if (parentId === '') return Math.min(depth, MAX_TASK_DEPTH)
      const parent = byId.get(parentId)
      if (parent === undefined) return Math.min(depth, MAX_TASK_DEPTH)
      depth += 1
      if (depth >= MAX_TASK_DEPTH) return MAX_TASK_DEPTH
      cursor = parent
    }
  }
}

/** The queue head: the oldest **root** active task on the FIFO queue (T-13 A2). */
function queueHeadId(records) {
  if (Array.isArray(records) === false) return null
  const active = records.filter((record) => isPlainObject(record) && record.status === 'active')
  if (active.length === 0) return null
  const activeIds = new Set(active.map((record) => record.id).filter((id) => typeof id === 'string'))
  const roots = active.filter((record) => {
    const parent = taskParentOf(record)
    return parent === '' || activeIds.has(parent) === false
  })
  /* No root means every active row points at another active row (a cycle); the
     read path normalizes those away, but fall back to plain FIFO if it happens. */
  const pool = roots.length > 0 ? roots : active
  const id = createdOrder(pool)[0]?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** Active tasks in FIFO queue order (oldest `created_at` first), panel-projected. */
function activeTasksOf(records, limit = MAX_TASK_ROWS, depthOf) {
  const active = records.filter((record) => isPlainObject(record) && record.status === 'active')
  return createdOrder(active)
    .slice(0, limit)
    .map((record) => panelTaskRow(record, 'active', depthOf))
}

/**
 * Draft tasks in FIFO order (oldest `created_at` first), projected for the panel's
 * 待办 block.
 *
 * A non-array `records` or a non-object record degrades to "no row" rather than
 * throwing, and every projected field is bounded, so an odd `owner`/`updated_at`
 * type becomes an empty string.
 */
function draftTasksOf(records, limit = MAX_DRAFT_TASKS, depthOf) {
  if (Array.isArray(records) === false) return []
  const drafts = []
  for (const record of records) {
    if (isPlainObject(record) === false) continue
    if (record.status !== 'draft') continue
    drafts.push(record)
  }
  return createdOrder(drafts)
    .slice(0, limit)
    .map((record) => panelTaskRow(record, 'draft', depthOf))
}

function recentDoneOf(records, limit, depthOf) {
  return records
    .filter((record) => isPlainObject(record) && record.status === 'done')
    .sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
    .slice(0, limit)
    .map((record) => ({ ...panelTaskRow(record, 'done', depthOf), gate: lastCheckpointGate(record) }))
}

/** Panel payload with no readable store: every section empty. */
async function emptyStoreState(root, entry, now, warnings) {
  entry.name = await readManifestName(root)
  return {
    ok: true,
    generatedAt: isoLocal(new Date(now)),
    contract: { source: 'defaults', schema: 2, name: entry.name },
    roots: [],
    root,
    head: await readHead(root, warnings),
    experiments: {
      source: 'store',
      total: 0,
      counts: { total: 0, open: 0, confirmed: 0, refuted: 0, abandoned: 0 },
      items: [],
      tree: [],
      groups: [],
    },
    tasks: {
      total: 0,
      counts: { draft: 0, active: 0, done: 0, archived: 0, other: 0 },
      current: null,
      active: [],
      recentDone: [],
      draft: [],
    },
    gates: [],
    heartbeats: [],
    decisions: { items: [], counts: emptyDecisionCounts() },
    warnings,
  }
}

/**
 * Store payload: contract + collections read through lib/core.mjs.
 *
 * `options.realRoot` / `options.pathMemo` are the request-scoped containment
 * context built by `collectPanelState`: the root is already canonical and every
 * `realpath` shared with lib/core.mjs is resolved once per request.
 */
async function buildStoreState(root, entry, now, warnings, options = {}) {
  const c = requireCore()
  const pathMemo = options !== null && typeof options === 'object' && options.pathMemo instanceof Map ? options.pathMemo : undefined
  let loaded
  try {
    loaded = c.loadContract(root)
  } catch (error) {
    warnings.push(`store contract unreadable: ${brief(error)}`)
    return emptyStoreState(root, entry, now, warnings)
  }
  for (const warning of Array.isArray(loaded.warnings) ? loaded.warnings : []) {
    warnings.push(`contract: ${warning}`)
  }
  const contract = loaded.contract
  entry.name = contract.name

  let state
  try {
    state = c.readStoreState(root, contract, { pathMemo })
  } catch (error) {
    warnings.push(`store unreadable: ${brief(error)}`)
    return emptyStoreState(root, entry, now, warnings)
  }

  const head = await readHead(root, warnings)

  const records = Array.isArray(state.experiments.items) ? state.experiments.items : []
  let items = records
  if (records.length > MAX_STORE_ITEMS) {
    items = records.slice(0, MAX_STORE_ITEMS)
    warnings.push(`items-truncated: ${records.length - MAX_STORE_ITEMS} experiments beyond ${MAX_STORE_ITEMS}`)
  }
  let tree = []
  try {
    tree = c.experimentTree(items)
  } catch (error) {
    warnings.push(`experiment tree unbuildable: ${brief(error)}`)
  }

  /* Six states unconditionally: the core tally may still be four-wide, so the
     projection owns the full skeleton the panel/TUI read. */
  const counted = experimentCountsOf(records)
  const counts = isPlainObject(state.experiments.counts) ? { ...counted, ...state.experiments.counts } : { ...counted }
  counts.total = records.length
  for (const status of EXPERIMENT_STATUS_SIX) {
    if (typeof counts[status] !== 'number') counts[status] = records.filter((item) => item.status === status).length
  }

  const taskRecords = Array.isArray(state.tasks.items) ? state.tasks.items : []
  const taskCounts = taskCountsOf(taskRecords)
  const recentLimit = pickInteger(contract.tasks && contract.tasks.recentLimit, 6, 0, 500)
  // `tasks.current` is a manifest-declared path even though the store reader
  // only echoes it; an unsafe value is hidden and warned about like everywhere else.
  // When the manifest declares nothing, the payload reports the queue head (oldest
  // active task id) so the panel always has a current card. This is a projection:
  // the manifest stays `null` and nothing is written.
  const currentValue = typeof contract.tasks.current === 'string' ? contract.tasks.current : null
  const currentSafe =
    currentValue !== null &&
    containedPath(root, currentValue, 'tasks.current', warnings, { realRoot: options.realRoot, pathMemo }) !== undefined
  const current = currentSafe ? currentValue : currentValue === null ? queueHeadId(taskRecords) : null
  const taskDepth = taskDepthIndex(taskRecords)
  const tasks = {
    total: taskRecords.length,
    counts: taskCounts,
    current,
    active: activeTasksOf(taskRecords, MAX_TASK_ROWS, taskDepth),
    recentDone: recentDoneOf(taskRecords, recentLimit, taskDepth),
    draft: draftTasksOf(taskRecords, MAX_DRAFT_TASKS, taskDepth),
    /* Optional for readers: the panel draws a sparkline, an older client just
       ignores the key. Derived on demand, nothing is stored. */
    trend: deriveTrend(taskRecords, { now }),
  }
  const activeTotal = taskRecords.filter((record) => isPlainObject(record) && record.status === 'active').length
  if (activeTotal > MAX_TASK_ROWS) {
    warnings.push(`active-tasks-truncated: ${activeTotal - MAX_TASK_ROWS} active tasks beyond ${MAX_TASK_ROWS}`)
  }

  const gates = (Array.isArray(state.gates.items) ? state.gates.items : []).map((gate) => ({
    ...gate,
    lastRun: gate.lastRun === undefined ? null : gate.lastRun,
  }))

  let heartbeats = []
  let heartbeatsHidden = 0
  try {
    // T-13（task-143）：take the FULL row set here and let the host decide what to
    // hide. Only the host has the optional `agents` service, whose positive
    // evidence can turn a stale row live; filtering in this forked snapshot would
    // remove the row before that annotation can happen.
    const section = c.readHeartbeatSection(root, contract, { pathMemo, visibility: 'all' })
    // The section reads the project main worktree; a degraded resolution names
    // the reason once so the panel shows why the ledger is local to the cwd.
    if (isPlainObject(section) && section.degraded === true) {
      warnings.push(`heartbeat-root-degraded: ${typeof section.reason === 'string' && section.reason !== '' ? section.reason : root}`)
    }
    heartbeats = panelHeartbeats(section)
    heartbeatsHidden = heartbeats.filter((row) => heartbeatRowVisible(row) === false).length
  } catch (error) {
    warnings.push(`heartbeats unreadable: ${brief(error)}`)
  }

  let decisions
  try {
    decisions = panelDecisions(decisionSection(state, root, contract))
  } catch (error) {
    warnings.push(`decisions unreadable: ${brief(error)}`)
    decisions = panelDecisions(null)
  }

  if (!experimentsEnabled(contract)) {
    const legacy = legacyExperimentsWarning(contract, records, root)
    if (legacy !== null) warnings.push(legacy)
  }

  return {
    ok: true,
    generatedAt: isoLocal(new Date(now)),
    contract: { source: loaded.source, schema: contract.schema, name: contract.name },
    roots: [],
    root,
    head,
    experiments: experimentsEnabled(contract)
      ? { enabled: true, source: 'store', total: records.length, counts, items, tree, groups: [] }
      /* Keep the top-level `total` even when the area is closed: older readers
         (the memo/worker regression tests included) read `experiments.total`,
         and `counts` already carries the real tallies — reporting `total: 0`
         next to a non-zero `counts.total` would contradict itself. The `enabled`
         flag is the signal; items/tree are what a closed area withholds. */
      : { enabled: false, total: records.length, counts },
    tasks,
    gates,
    heartbeats,
    /* Pre-agents count: rows this snapshot would hide. The host recomputes it
       after `applyAgentLiveness` and writes the final number back. */
    heartbeatsHidden,
    decisions,
    warnings,
  }
}

/**
 * Local calendar day number (DST-safe: derived from the local Y/M/D components,
 * never from elapsed milliseconds, so a 23/25-hour day still maps to one bucket).
 */
function localDayNumber(ms) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return Number.NaN
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

/** Local calendar `YYYY-MM-DD` for a day number produced by {@link localDayNumber}. */
function localDayKey(dayNumber) {
  const date = new Date(dayNumber * DAY_MS)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/**
 * First usable timestamp of a record, and whether it is the exact one.
 * `keys` is ordered: the exact field first (`created_at`, `done_at`,
 * `archived_at`), the fallback last (`updated_at`).
 */
function trendTimestamp(record, keys) {
  for (const key of keys) {
    const raw = record[key]
    if (typeof raw !== 'string' || raw === '') continue
    const ms = Date.parse(raw)
    if (Number.isFinite(ms)) return { ms, exact: key !== 'updated_at' }
  }
  return null
}

/**
 * Daily task-progress series derived from the ledger — no new storage.
 *
 * The ledger only keeps the *current* state, so this is an approximation and
 * says so: `created` is exact (`created_at` never changes), while `done` and
 * `archived` are exact only when the record carries `done_at` / `archived_at`
 * and otherwise fall back to `updated_at` (any later patch resets it). The read
 * projection marks such fallbacks (`doneAtEstimated` / `archivedAtEstimated`);
 * the first day that leaned on one becomes `estimatedFrom`, and the panel marks
 * that segment with `≈`.
 *
 * @param {Array<object>} tasks raw task records (`created_at` / `updated_at` /
 *   optional `done_at` / `archived_at` / `status`)
 * @param {{now?:number, days?:number, estimatedFrom?:string}} [options]
 * @returns {{from:string,to:string,days:number,estimatedFrom:string|null,
 *   created:number[],done:number[],archived:number[]}}
 */
export function deriveTrend(tasks, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const requested = Number.isFinite(input.days) ? Math.floor(input.days) : TREND_DEFAULT_DAYS
  const days = Math.min(MAX_TREND_DAYS, Math.max(1, requested))
  const toDay = localDayNumber(now)
  const fromDay = toDay - (days - 1)
  const created = new Array(days).fill(0)
  const done = new Array(days).fill(0)
  const archived = new Array(days).fill(0)
  const records = Array.isArray(tasks) ? tasks.filter((record) => isPlainObject(record)) : []
  let estimatedDay = null

  const bucketOf = (ms) => {
    const day = localDayNumber(ms)
    if (Number.isFinite(day) === false) return -1
    const index = day - fromDay
    return index < 0 || index >= days ? -1 : index
  }

  for (const record of records) {
    const createdAt = trendTimestamp(record, ['created_at'])
    if (createdAt !== null) {
      const index = bucketOf(createdAt.ms)
      if (index >= 0) created[index] += 1
    }
    if (record.status === 'done') {
      const doneAt = trendTimestamp(record, ['done_at', 'updated_at'])
      if (doneAt !== null) {
        const index = bucketOf(doneAt.ms)
        if (index >= 0) {
          done[index] += 1
          // The read projection materializes `done_at` from `updated_at` for old
          // records; `doneAtEstimated` is the flag that keeps that fact alive.
          const approximated = doneAt.exact === false || record.doneAtEstimated === true
          if (approximated && (estimatedDay === null || index < estimatedDay)) estimatedDay = index
        }
      }
    } else if (record.status === 'archived') {
      const archivedAt = trendTimestamp(record, ['archived_at', 'updated_at'])
      if (archivedAt !== null) {
        const index = bucketOf(archivedAt.ms)
        if (index >= 0) {
          archived[index] += 1
          const approximated = archivedAt.exact === false || record.archivedAtEstimated === true
          if (approximated && (estimatedDay === null || index < estimatedDay)) estimatedDay = index
        }
      }
    }
  }

  /* A caller may already know the approximation starts earlier (a contract-level
     "history before this date is estimated"); keep the earlier of the two. */
  if (typeof input.estimatedFrom === 'string' && input.estimatedFrom !== '') {
    const given = localDayNumber(Date.parse(input.estimatedFrom))
    if (Number.isFinite(given)) {
      const index = given - fromDay
      if (index >= 0 && index < days && (estimatedDay === null || index < estimatedDay)) estimatedDay = index
    }
  }

  return {
    from: localDayKey(fromDay),
    to: localDayKey(toDay),
    days,
    estimatedFrom: estimatedDay === null ? null : localDayKey(fromDay + estimatedDay),
    created,
    done,
    archived,
  }
}

/**
 * Whether the contract opts the experiment area in. Strict `true` on purpose:
 * a missing or malformed flag closes the area (the panel then renders a single
 * column and the TUI drops the section), so older manifests keep the old
 * "experiments are a feature of this project" behaviour only when they say so.
 */
function experimentsEnabled(contract) {
  const section = isPlainObject(contract) && isPlainObject(contract.experiments) ? contract.experiments : null
  return section !== null && section.enabled === true
}

/**
 * Guidance for a manifest that predates `experiments.enabled`: the records stay
 * hidden until the project opts in, and nothing is flipped automatically.
 *
 * Pure on purpose (the selftest pins the contract); `key` scopes the one-shot
 * dedupe below, so a 2.5 s poll never turns this into a warning storm. A `null`
 * means "nothing to report": the area is open, there are no records, or this
 * process already said it for this root.
 */
export function legacyExperimentsWarning(contract, records, key) {
  const count = Array.isArray(records) ? records.length : 0
  if (count === 0) return null
  if (experimentsEnabled(contract)) return null
  const scope = typeof key === 'string' && key !== '' ? key : ''
  if (scope !== '') {
    if (LEGACY_EXPERIMENTS_WARNED.has(scope)) return null
    LEGACY_EXPERIMENTS_WARNED.add(scope)
  }
  return `experiments-disabled-legacy: ${count} experiment(s) are hidden because this project has not enabled the experiment area; set experiments.enabled=true in ${STORE_CONTRACT} to show them (nothing is enabled automatically)`
}

/** Six-state experiment counts plus `total`; unknown statuses stay uncounted. */
function experimentCountsOf(records) {
  const list = Array.isArray(records) ? records : []
  const counts = { open: 0, confirmed: 0, refuted: 0, abandoned: 0, inconclusive: 0, pivoted: 0 }
  for (const record of list) {
    const status = isPlainObject(record) && typeof record.status === 'string' ? record.status : ''
    if (Object.hasOwn(counts, status)) counts[status] += 1
  }
  counts.total = list.length
  return counts
}

async function buildState(root, entry, now, options = {}, hostWarnings = []) {
  // The panel polls every ~2.5s and core's warning log is a module singleton:
  // draining here (and dropping) keeps poll-driven reads from stealing the
  // diagnostics the next tool call should surface. The panel computes its own
  // diagnostics locally, so nothing visible is lost.
  takeCoreWarnings()
  const warnings = hostWarnings.slice()
  if (coreAvailable()) return buildStoreState(root, entry, now, warnings, options)
  const message = coreUnavailableMessage()
  if (warnings.includes(message) === false) warnings.push(message)
  return emptyStoreState(root, entry, now, warnings)
}

/** Open-decision rows the reminder and the panel carry: core's DECISION_REMIND_MAX. */
function decisionRemindMax() {
  const value = coreAvailable() ? core.DECISION_REMIND_MAX : undefined
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 3
}

/** Count keys of one decisions section; the tool, the panel and both self-tests share them. */
const DECISION_COUNT_KEYS = ['open', 'blocking', 'escalated', 'answered', 'withdrawn', 'superseded', 'total']

/** Project arbitrary counts onto the seven fixed keys; missing or broken values become 0. */
function decisionCountsOf(counts) {
  const source = isPlainObject(counts) ? counts : {}
  const out = {}
  for (const key of DECISION_COUNT_KEYS) {
    const value = source[key]
    out[key] = typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  return out
}

/** Every count zero, in the canonical key order. */
function emptyDecisionCounts() {
  return decisionCountsOf(null)
}
// ------------------------------------------------------------- snapshot API

/**
 * One read-only panel snapshot for the requested workspace.
 *
 * @param {{root:string, realRoot?:string, entry?:{path:string,name:string},
 *          hostWarnings?:string[], now?:number}} request
 * @returns {Promise<object>} the capped payload (without `roots`/`root` patches:
 *   the host adds the registry row it already enumerated)
 */
export async function buildSnapshot(request) {
  const input = isPlainObject(request) ? request : {}
  const root = typeof input.root === 'string' ? input.root : ''
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const entry = isPlainObject(input.entry) ? { ...input.entry } : { path: root, name: '' }
  const hostWarnings = Array.isArray(input.hostWarnings)
    ? input.hostWarnings.filter((line) => typeof line === 'string' && line !== '')
    : []
  const realRoot = typeof input.realRoot === 'string' && input.realRoot.length > 0 ? input.realRoot : root
  // Per-request only: created here, dies with this call, never crosses IPC.
  const options = { realRoot, pathMemo: new Map([[root, root]]) }
  const payload = await buildState(root, entry, now, options, hostWarnings)
  // Cap by serializing once, then hand back the exact object the host sends.
  return JSON.parse(capPayload(payload))
}

// --------------------------------------------------------------- worker entry

const IS_WORKER = process.env.PF_STATE_WORKER === '1' && typeof process.send === 'function'

/** IPC reply helper: one JSON message per request; a broken channel ends the worker. */
function workerReply(message) {
  try {
    process.send(message)
  } catch {
    process.exit(1)
  }
}

/** Worker loop: one request at a time (the host marks a child busy until it replies). */
function startWorker() {
  process.on('disconnect', () => process.exit(0))
  process.on('uncaughtException', () => process.exit(1))
  process.on('unhandledRejection', () => process.exit(1))
  process.on('message', (message) => {
    if (isPlainObject(message) === false) return
    if (message.type === 'ping') {
      workerReply({ type: 'pong', id: message.id })
      return
    }
    if (message.type !== 'snapshot') return
    buildSnapshot(message).then(
      (payload) => workerReply({ id: message.id, ok: true, payload }),
      (error) => workerReply({ id: message.id, ok: false, error: { code: 'state-internal', message: brief(error, 300) } }),
    )
  })
  workerReply({ type: 'ready' })
}

if (IS_WORKER) startWorker()

export {
  STORE_CONTRACT,
  brief,
  clip,
  coreAvailable,
  coreUnavailableMessage,
  decisionCountsOf,
  decisionRemindMax,
  emptyDecisionCounts,
  isPlainObject,
  pickInteger,
  readManifestName,
  requireCore,
  splitLines,
  storeContractPath,
  takeCoreWarnings,
  taskCountsOf,
  timeValue,
  toPosix,
}
