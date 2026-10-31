// project-flow — Host half.
//
// Registers three JSON endpoints, all same-origin gated: one read endpoint,
// /api/project-flow/state, and two write endpoints, /api/project-flow/init
// (create the store of the requested workspace) and /api/project-flow/gate
// (toggle one gate's `enabled` flag). The read endpoint reports the store of
// exactly one workspace: the directory the panel passes as `?root=<dir>` (the
// current session workspace), or the process working directory when the
// parameter is omitted. A workspace with no `.dsh/flow` store is reported as a
// "not initialized" empty state — the endpoint never substitutes, scans or
// lists another project, and there is no legacy ledger mode.
// Neither write endpoint touches the store directly: after the same root
// scoping they hand the directory to lib/core.mjs, the one writer shared with
// the CLI, so the same validation and atomic write apply. Five agent tools plus
// three skills expose the store to the model; a system-prompt section, a
// per-turn pre-step reminder and an optional edit/write guard keep the heartbeat
// discipline visible. The heartbeat discipline serves *main* sessions only:
// subagent sessions neither create heartbeats nor face the reminder or the write
// guard, and the ledger lives in the project's main worktree so linked-worktree
// sessions share one ledger. Root resolution happens per request; there are no
// watchers and no dependencies beyond node built-ins.

import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const inject = ['webServer']

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const ROUTE_PATH = '/api/project-flow/state'
const INIT_ROUTE_PATH = '/api/project-flow/init'
const GATE_ROUTE_PATH = '/api/project-flow/gate'
const MAX_INIT_BODY_BYTES = 8 * 1024
const MAX_INIT_CREATED = 50
const MAX_INIT_WARNINGS = 20
const HEARTBEAT_GATE_TOOLS = new Set(['edit', 'write'])
const HEARTBEAT_SESSION_MAX = 80
const HEARTBEAT_SESSION_PATTERN = /^[A-Za-z0-9._:-]+$/
const GIT_TIMEOUT_MS = 4000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const MAX_STRING = 400
const MAX_PAYLOAD_BYTES = 900 * 1000
const MAX_STORE_ITEMS = 400
const MAX_DRAFT_TASKS = 50
/** Task rows per panel group; the panel itself renders at most 25 per list. */
const MAX_TASK_ROWS = 50
/** One bounded detail entry (file claim, acceptance command, commit sha). */
const MAX_TASK_ITEM = 200
/** Detail list length per task (`scope.allow`/`scope.deny`/`acceptance`/`commits`). */
const MAX_TASK_LIST = 10
const MAX_TOOL_ITEMS = 200
const WRITE_TIMEOUT_MS = 30_000
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
  core = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'core.mjs')).href)
} catch (error) {
  coreFailure = brief(error, 200)
}

/** Non-fatal problems detected while mounting; surfaced in every payload's warnings. */
const mountWarnings = []

/** One warning per distinct mount problem: apply may run more than once per process. */
function warnMount(message, ctx) {
  if (typeof message !== 'string' || message.length === 0) return
  if (mountWarnings.includes(message) === false) mountWarnings.push(message)
  try {
    if (ctx !== undefined && ctx !== null && ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(`project-flow: ${message}`)
    }
  } catch {
    // Logging is best-effort only.
  }
}

if (core === null) {
  warnMount(`core-unavailable: lib/core.mjs could not be loaded (${coreFailure || 'unknown error'}); the store, flow_* tools and skills are unavailable`)
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

const SUBAGENT_ORIGIN = 'subagent'

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

function realPathStaysInside(absRoot, target) {
  let realRoot
  try {
    realRoot = realpathSync(absRoot)
  } catch {
    // The project root does not exist yet: only the lexical check is meaningful.
    return pathWithin(absRoot, target)
  }
  let current = target
  for (;;) {
    try {
      return pathWithin(realRoot, realpathSync(current))
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
  if (pathWithin(absRoot, target) !== true && realPathStaysInside(absRoot, target) !== true) {
    rejectManifestPath(warnings, label, raw, 'escapes the project root')
    return undefined
  }
  if (realPathStaysInside(absRoot, target) !== true) {
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


// ------------------------------------------------------- workspace inspection

function readManifestName(root) {
  try {
    const parsed = JSON.parse(readFileSync(storeContractPath(root), 'utf8'))
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

/** Whether the root owns a `.dsh/flow/flow.json` store contract. */
function hasStore(root) {
  try {
    return statSync(storeContractPath(root)).isFile()
  } catch {
    return false
  }
}


// ------------------------------------------------------------ workspace scope
//
// The panel is scoped to one workspace. There is no global candidate list any
// more: a requested root is canonicalized, validated against the registered
// workspaces (or its own manifest) and then read in isolation.

/** Canonical form of one path: resolved, then realpath when the path exists. */
function canonicalRoot(path) {
  let resolved
  try {
    resolved = resolve(path)
  } catch {
    resolved = String(path)
  }
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

/** Whether one path is an existing directory. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory() === true
  } catch {
    return false
  }
}

/**
 * The registered workspaces as `{ path, title }` rows, canonicalized. An
 * unavailable or broken registry projection yields an empty list rather than an
 * error: the endpoint then accepts only roots with their own manifest.
 */
function listWorkspaces(ctx) {
  const workspaces = []
  let registry
  try {
    registry = ctx.get('workspaceRegistry')
  } catch {
    registry = undefined
  }
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return workspaces

  let rows
  try {
    rows = registry.list()
  } catch {
    return workspaces
  }
  for (const workspace of Array.isArray(rows) ? rows : []) {
    if (workspace === null || workspace === undefined) continue
    let path
    let title
    try {
      path = workspace.path
      title = workspace.title
    } catch {
      continue
    }
    if (typeof path !== 'string' || path.length === 0) continue
    workspaces.push({
      path: canonicalRoot(path),
      title: typeof title === 'string' ? title.trim() : '',
    })
  }
  return workspaces
}

/** Whether `root` is `base` itself or lives below it. */
function rootWithin(root, base) {
  if (root === base) return true
  const prefix = base.endsWith(sep) ? base : base + sep
  return root.startsWith(prefix)
}

/** Whether a root is a registered workspace, inside one, or declares its own flow store. */
function rootAccepted(root, workspaces) {
  for (const workspace of workspaces) {
    if (rootWithin(root, workspace.path)) return true
  }
  return hasStore(root)
}

/**
 * Display name: the manifest name, else the title of the innermost registered
 * workspace containing the root (workspaces may nest, e.g. /Project and
 * /Project/app), else the folder name.
 */
function rootName(root, workspaces) {
  if (hasStore(root)) return readManifestName(root)
  let owner
  for (const workspace of workspaces) {
    if (rootWithin(root, workspace.path) === false) continue
    if (owner === undefined || workspace.path.length > owner.path.length) owner = workspace
  }
  if (owner !== undefined) return owner.title.length > 0 ? owner.title : basename(root)
  return basename(root)
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
 * One task row for the panel. Title and goal drive the two visible lines; the
 * remaining fields feed the expanded detail block, so every value stays bounded
 * (single strings clipped, arrays limited) regardless of what the store holds.
 */
function panelTaskRow(record, status) {
  return {
    id: clip(record.id),
    title: clip(record.title),
    status,
    owner: clip(record.owner),
    goal: clip(record.goal),
    notes: clip(record.notes),
    scope: clipTaskScope(record.scope),
    acceptance: clipTaskAcceptance(record.acceptance),
    commits: clipTaskList(record.commits),
    created_at: clip(record.created_at),
    updated_at: clip(record.updated_at),
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

function activeTasksOf(records, limit = MAX_TASK_ROWS) {
  return records
    .filter((record) => isPlainObject(record) && record.status === 'active')
    .sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
    .slice(0, limit)
    .map((record) => panelTaskRow(record, 'active'))
}

/**
 * Newest draft tasks, projected for the panel's 待办 block.
 *
 * A non-array `records` or a non-object record degrades to "no row" rather than
 * throwing, and every projected field is bounded, so an odd `owner`/`updated_at`
 * type becomes an empty string.
 */
function draftTasksOf(records, limit = MAX_DRAFT_TASKS) {
  if (Array.isArray(records) === false) return []
  const drafts = []
  for (const record of records) {
    if (isPlainObject(record) === false) continue
    if (record.status !== 'draft') continue
    drafts.push(record)
  }
  drafts.sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
  return drafts.slice(0, limit).map((record) => panelTaskRow(record, 'draft'))
}

function recentDoneOf(records, limit) {
  return records
    .filter((record) => isPlainObject(record) && record.status === 'done')
    .sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
    .slice(0, limit)
    .map((record) => ({ ...panelTaskRow(record, 'done'), gate: lastCheckpointGate(record) }))
}

/** Panel payload with no readable store: every section empty. */
async function emptyStoreState(root, entry, now, warnings) {
  entry.name = readManifestName(root)
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
    warnings,
  }
}

/** Store payload: contract + collections read through lib/core.mjs. */
async function buildStoreState(root, entry, now, warnings) {
  const c = requireCore()
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
    state = c.readStoreState(root, contract)
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

  const counts = isPlainObject(state.experiments.counts) ? { ...state.experiments.counts } : {}
  counts.total = records.length
  for (const status of ['open', 'confirmed', 'refuted', 'abandoned']) {
    if (typeof counts[status] !== 'number') counts[status] = records.filter((item) => item.status === status).length
  }

  const taskRecords = Array.isArray(state.tasks.items) ? state.tasks.items : []
  const taskCounts = taskCountsOf(taskRecords)
  const recentLimit = pickInteger(contract.tasks && contract.tasks.recentLimit, 6, 0, 500)
  // `tasks.current` is a manifest-declared path even though the store reader
  // only echoes it; an unsafe value is hidden and warned about like everywhere else.
  const currentValue = typeof contract.tasks.current === 'string' ? contract.tasks.current : null
  const currentSafe =
    currentValue !== null && containedPath(root, currentValue, 'tasks.current', warnings) !== undefined
  const tasks = {
    total: taskRecords.length,
    counts: taskCounts,
    current: currentSafe ? currentValue : null,
    active: activeTasksOf(taskRecords),
    recentDone: recentDoneOf(taskRecords, recentLimit),
    draft: draftTasksOf(taskRecords),
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
  try {
    const section = c.readHeartbeatSection(root, contract)
    // The section reads the project main worktree; a degraded resolution names
    // the reason once so the panel shows why the ledger is local to the cwd.
    if (isPlainObject(section) && section.degraded === true) {
      warnings.push(`heartbeat-root-degraded: ${typeof section.reason === 'string' && section.reason !== '' ? section.reason : root}`)
    }
    heartbeats = panelHeartbeats(section)
  } catch (error) {
    warnings.push(`heartbeats unreadable: ${brief(error)}`)
  }

  return {
    ok: true,
    generatedAt: isoLocal(new Date(now)),
    contract: { source: loaded.source, schema: contract.schema, name: contract.name },
    roots: [],
    root,
    head,
    experiments: { source: 'store', total: records.length, counts, items, tree, groups: [] },
    tasks,
    gates,
    heartbeats,
    warnings,
  }
}

async function buildState(root, entry, now) {
  const warnings = mountWarnings.slice()
  if (coreAvailable()) return buildStoreState(root, entry, now, warnings)
  warnings.push(`core-unavailable: ${coreFailure || 'unknown error'}`)
  return emptyStoreState(root, entry, now, warnings)
}

// ----------------------------------------------------------------------- HTTP

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sendError(response, status, code, message) {
  const error = { code }
  if (typeof message === 'string' && message.length > 0) error.message = message
  sendJson(response, status, { ok: false, error })
}

function service(ctx, name) {
  try {
    const value = ctx.get(name)
    if (value !== undefined && value !== null) return value
  } catch {
    // fall through to the property lookup below
  }
  try {
    const value = ctx[name]
    if (value !== undefined && value !== null) return value
  } catch {
    // missing service
  }
  return undefined
}

function originAllowed(ctx, request) {
  let origin
  try {
    origin = request.headers.origin
  } catch {
    origin = undefined
  }
  if (typeof origin !== 'string' || origin.length === 0) return true
  const webServer = service(ctx, 'webServer')
  let expected
  try {
    expected = webServer !== undefined && typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : undefined
  } catch {
    expected = undefined
  }
  if (typeof expected !== 'string' || expected.length === 0) return false
  return origin === expected
}

async function handleState(ctx, request, response) {
  let url
  try {
    url = new URL(String(request.url ?? ROUTE_PATH), 'http://localhost')
  } catch (error) {
    sendError(response, 400, 'bad-request', brief(error))
    return
  }

  const method = String(request.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    try {
      response.setHeader('allow', 'GET')
    } catch {
      // ignore
    }
    sendError(response, 405, 'method-not-allowed')
    return
  }

  if (!originAllowed(ctx, request)) {
    sendError(response, 403, 'forbidden')
    return
  }

  const now = Date.now()

  let workspaces
  try {
    workspaces = listWorkspaces(ctx)
  } catch (error) {
    sendError(response, 500, 'internal', brief(error))
    return
  }

  // Exactly one root: the workspace the panel asks for. There is no fallback to
  // another project — an uninitialized workspace reports its empty state.
  const requested = url.searchParams.get('root')
  let root
  if (requested !== null) {
    if (requested.trim().length === 0) {
      sendError(response, 400, 'bad-root', 'root must name the workspace directory')
      return
    }
    root = canonicalRoot(requested)
    if (isDirectory(root) === false) {
      sendError(response, 400, 'bad-root', `root is not an existing directory: ${root}`)
      return
    }
    if (rootAccepted(root, workspaces) === false) {
      sendError(
        response,
        400,
        'unknown-root',
        'root is neither a registered workspace, inside one, nor a directory with a flow store',
      )
      return
    }
  } else {
    root = canonicalRoot(process.cwd())
    // Without an explicit root there is no chosen workspace: it must both be
    // accepted and actually carry a ledger, otherwise nothing is scoped.
    if (rootAccepted(root, workspaces) === false || hasStore(root) === false) {
      sendJson(response, 200, {
        ok: false,
        generatedAt: isoLocal(new Date(now)),
        roots: [],
        root: null,
        error: { code: 'no-project', message: 'no workspace declares a flow store' },
      })
      return
    }
  }

  const entry = { path: root, name: rootName(root, workspaces) }

  if (hasStore(root) === false) {
    sendJson(response, 200, {
      ok: false,
      generatedAt: isoLocal(new Date(now)),
      root,
      roots: [entry],
      error: { code: 'not-initialized', message: `no flow store in ${root}; run: node bin/flow.mjs init` },
    })
    return
  }

  try {
    const payload = await buildState(root, entry, now)
    payload.root = root
    payload.roots = [{ path: entry.path, name: entry.name }]
    const body = capPayload(payload)
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  } catch (error) {
    sendJson(response, 200, {
      ok: false,
      generatedAt: isoLocal(new Date(now)),
      roots: [{ path: entry.path, name: entry.name }],
      root,
      error: { code: 'internal', message: brief(error, 400) },
    })
  }
}

// ------------------------------------------------------------------ init HTTP
//
// One of the two writes on the HTTP surface. It never touches the store
// directly: after the same root scoping as the read endpoint it hands the
// directory to lib/core.mjs, so validation, locking and the atomic write stay
// in one place.

/**
 * Read the request body as UTF-8 text, bounded by `limit` bytes. Oversized
 * bodies resolve immediately with `{ tooLarge: true }` and are drained in the
 * background, so the caller can answer 400 without waiting for — or stalling on
 * — the rest of the stream. A request without a readable stream yields ''.
 */
function readBody(request, limit = MAX_INIT_BODY_BYTES) {
  return new Promise((settle) => {
    if (request === null || request === undefined || typeof request.on !== 'function') {
      settle({ text: '', tooLarge: false })
      return
    }
    const chunks = []
    let size = 0
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      settle(result)
    }
    request.on('data', (chunk) => {
      if (done) return
      let buffer
      try {
        buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      } catch {
        return
      }
      size += buffer.length
      if (size > limit) {
        finish({ text: '', tooLarge: true })
        // Keep consuming (and ignoring) the rest instead of leaving the socket
        // paused: the response is already on its way.
        try {
          if (typeof request.resume === 'function') request.resume()
        } catch {
          // ignore
        }
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => finish({ text: Buffer.concat(chunks).toString('utf8'), tooLarge: false }))
    request.on('error', () => finish({ text: '', tooLarge: false }))
  })
}

async function handleInit(ctx, request, response) {
  const method = String(request.method ?? 'POST').toUpperCase()
  if (method !== 'POST') {
    try {
      response.setHeader('allow', 'POST')
    } catch {
      // ignore
    }
    sendError(response, 405, 'method-not-allowed')
    return
  }

  if (!originAllowed(ctx, request)) {
    sendError(response, 403, 'forbidden')
    return
  }

  const body = await readBody(request)
  if (body.tooLarge) {
    sendError(response, 400, 'bad-request', `request body exceeds ${MAX_INIT_BODY_BYTES} bytes`)
    return
  }

  let parsed
  try {
    parsed = JSON.parse(body.text)
  } catch (error) {
    sendError(response, 400, 'bad-request', brief(error))
    return
  }
  if (!isPlainObject(parsed)) {
    sendError(response, 400, 'bad-request', 'request body must be a JSON object')
    return
  }

  const requested = parsed.root
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    sendError(response, 400, 'bad-root', 'root must name the workspace directory')
    return
  }
  const root = canonicalRoot(requested)
  if (isDirectory(root) === false) {
    sendError(response, 400, 'bad-root', `root is not an existing directory: ${root}`)
    return
  }

  let workspaces
  try {
    workspaces = listWorkspaces(ctx)
  } catch (error) {
    sendError(response, 500, 'internal', brief(error))
    return
  }
  if (rootAccepted(root, workspaces) === false) {
    sendError(
      response,
      400,
      'unknown-root',
      'root is neither a registered workspace, inside one, nor a directory with a flow store',
    )
    return
  }

  const name = rootName(root, workspaces)

  let result
  try {
    // The shared writer: requireCore() reports an unavailable lib/core.mjs in a
    // readable message instead of taking the plugin down.
    const c = requireCore()
    result = c.initProject(root, { name })
  } catch (error) {
    const conflict = error !== null && error !== undefined && typeof error === 'object' && error.code === 'conflict'
    sendError(response, conflict ? 409 : 500, 'init-failed', brief(error, 300))
    return
  }

  const created = Array.isArray(result?.created)
    ? result.created.filter((item) => typeof item === 'string').slice(0, MAX_INIT_CREATED)
    : []
  const warnings = Array.isArray(result?.warnings)
    ? result.warnings.filter((item) => typeof item === 'string').slice(0, MAX_INIT_WARNINGS)
    : []
  // Nothing created + the writer's own "already-initialized" warning means the
  // store was there before this call.
  const alreadyInitialized = created.length === 0 && warnings.some((line) => line.startsWith('already-initialized:'))

  sendJson(response, 200, {
    ok: true,
    root,
    name,
    alreadyInitialized,
    created,
    warnings,
  })
}

// ------------------------------------------------------------------ gate HTTP
//
// The second write on the HTTP surface: toggle one gate's `enabled` flag. Root
// scoping, body limits and same-origin gating are identical to the init
// endpoint; the store is only reached through lib/core.mjs (`updateGate`).

async function handleGate(ctx, request, response) {
  const method = String(request.method ?? 'POST').toUpperCase()
  if (method !== 'POST') {
    try {
      response.setHeader('allow', 'POST')
    } catch {
      // ignore
    }
    sendError(response, 405, 'method-not-allowed')
    return
  }

  if (!originAllowed(ctx, request)) {
    sendError(response, 403, 'forbidden')
    return
  }

  const body = await readBody(request)
  if (body.tooLarge) {
    sendError(response, 400, 'bad-request', `request body exceeds ${MAX_INIT_BODY_BYTES} bytes`)
    return
  }

  let parsed
  try {
    parsed = JSON.parse(body.text)
  } catch (error) {
    sendError(response, 400, 'bad-request', brief(error))
    return
  }
  if (!isPlainObject(parsed)) {
    sendError(response, 400, 'bad-request', 'request body must be a JSON object')
    return
  }

  const requested = parsed.root
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    sendError(response, 400, 'bad-root', 'root must name the workspace directory')
    return
  }
  const root = canonicalRoot(requested)
  if (isDirectory(root) === false) {
    sendError(response, 400, 'bad-root', `root is not an existing directory: ${root}`)
    return
  }

  let workspaces
  try {
    workspaces = listWorkspaces(ctx)
  } catch (error) {
    sendError(response, 500, 'internal', brief(error))
    return
  }
  if (rootAccepted(root, workspaces) === false) {
    sendError(
      response,
      400,
      'unknown-root',
      'root is neither a registered workspace, inside one, nor a directory with a flow store',
    )
    return
  }

  const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
  if (id.length === 0) {
    sendError(response, 400, 'bad-request', 'id must name a gate')
    return
  }
  if (typeof parsed.enabled !== 'boolean') {
    sendError(response, 400, 'bad-request', 'enabled must be a boolean')
    return
  }
  if (hasStore(root) === false) {
    sendError(response, 400, 'bad-request', `no flow store in ${root}; run: node bin/flow.mjs init`)
    return
  }

  let gate
  try {
    const c = requireCore()
    const loaded = c.loadContract(root)
    gate = c.updateGate(root, loaded.contract, id, { enabled: parsed.enabled })
  } catch (error) {
    sendError(response, 500, 'internal', brief(error, 300))
    return
  }

  sendJson(response, 200, {
    ok: true,
    root,
    gate: {
      id: isPlainObject(gate) && typeof gate.id === 'string' ? gate.id : id,
      enabled: isPlainObject(gate) && typeof gate.enabled === 'boolean' ? gate.enabled : parsed.enabled,
    },
  })
}

// ------------------------------------------------------------------- tools
//
// Six model-facing tools over the same lib/core.mjs writer the CLI uses. They
// are declared as plain objects (this package has no node_modules resolution
// for @deepseek-ai/dsh-tools); the registry accepts
// {name, description, parameters:<JSON Schema>, output:{schema, render},
//  isConcurrencySafe, timeoutMs, execute}. Root resolution is shared with the
// endpoint: explicit arg, then the session working directory, then session.cwd.

const ROOT_PROPERTY = {
  type: 'string',
  description: 'Project root (absolute or relative). Defaults to the session working directory.',
}
const ID_PROPERTY = { type: 'string', description: 'Record id, e.g. E-20261028-01 or T-20261028-01.' }
const EMPTY_STORE_NOTE = 'no flow store in this workspace; run: node bin/flow.mjs init'

/** Registry-ready output contract: render the result value as pretty JSON text. */
function toolOutput() {
  return {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

function toolRoot(ctx, args, exec) {
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

function requireDirectory(candidate) {
  let stats
  try {
    stats = statSync(candidate)
  } catch {
    throw new Error(`root does not exist: ${candidate}`)
  }
  if (stats.isDirectory() !== true) throw new Error(`root is not a directory: ${candidate}`)
  return candidate
}

function requireStore(root) {
  if (hasStore(root) === false) {
    throw new Error(`project flow store not found in ${root}; run: node bin/flow.mjs init`)
  }
}

function requireId(tool, action, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${tool} ${action} requires id`)
  }
  return value.trim()
}

function pickFields(args, names) {
  const picked = {}
  for (const name of names) {
    if (Object.hasOwn(args, name) && args[name] !== undefined) picked[name] = args[name]
  }
  return picked
}

// --------------------------------------------------------------- heartbeats
//
// A heartbeat is the per-session registration that tells the panel and the
// other sessions what this agent is doing and which files it owns. The tool
// writes through lib/core.mjs; the two hooks below only *read* it, and every
// failure degrades to "unknown" instead of blocking the host.

/** The session id of one tool run: the agent id, then `DSH_SESSION_ID`. */
function sessionIdOf(exec) {
  let id
  try {
    id = exec !== null && exec !== undefined && exec.agent !== undefined ? exec.agent.id : undefined
  } catch {
    id = undefined
  }
  if (typeof id === 'string' && id.trim().length > 0) return id.trim()
  const env = typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID.trim() : ''
  return env.length > 0 ? env : undefined
}

/**
 * A session id that can safely name a heartbeat file. Core validates its own
 * input; this pre-check only keeps a hostile or empty id out of the hooks (a
 * hook cannot report a usage error to anyone).
 */
function usableSessionId(value) {
  if (typeof value !== 'string') return ''
  const session = value.trim()
  if (session.length === 0 || session.length > HEARTBEAT_SESSION_MAX) return ''
  if (session.includes('..') || session.includes('/') || session.includes('\\')) return ''
  return HEARTBEAT_SESSION_PATTERN.test(session) ? session : ''
}

/** Session id for a tool call, or an actionable error. */
function requireSession(exec) {
  const session = sessionIdOf(exec)
  if (session === undefined) {
    throw new Error(
      'flow_heartbeat needs a session: this run exposes no agent id and DSH_SESSION_ID is unset (pass the tool from a live agent session)',
    )
  }
  return session
}

/** Project root of one live agent, using the same resolution as the tools. */
function agentRoot(ctx, agent) {
  try {
    return toolRoot(ctx, {}, { agent })
  } catch {
    return undefined
  }
}

/**
 * Whether the session's heartbeat is `working`: `true` / `false`, or `null`
 * when it cannot be decided (no store, no core, unsafe session id, broken
 * record). Hooks treat `null` as "do not interfere".
 */
function heartbeatWorking(root, session) {
  if (typeof root !== 'string' || root.length === 0) return null
  if (hasStore(root) === false) return null
  if (coreAvailable() === false || typeof core.heartbeatStatus !== 'function') return null
  const id = usableSessionId(session)
  if (id === '') return null
  try {
    const loaded = core.loadContract(root)
    const status = core.heartbeatStatus(root, loaded.contract, id)
    return status !== null && typeof status === 'object' && status.active === true && status.record?.status === 'working'
  } catch {
    return null
  }
}


/**
 * Whether one live agent is a *root* (main) session: `true`, `false`, or `null`
 * when it cannot be decided.
 *
 * The host registry is authoritative (see `@deepseek-ai/dsh-agent`): `roots()`
 * returns the live top-level agents — those entered without an owner — and
 * `get(id)` returns any live agent, so a live agent missing from `roots()` is a
 * subagent. Identity is checked first; the id fallback tolerates a tool call
 * receiving a detached agent record. Sessions whose runtime relation is not
 * visible fall back to the durable session header: `origin === 'subagent'` (or
 * `delegationDepth > 0`) marks a delegated child, while a fork stays a root.
 */
function rootSessionVerdict(ctx, agent) {
  if (agent === null || agent === undefined || typeof agent !== 'object') return null
  let id = ''
  try {
    if (typeof agent.id === 'string') id = agent.id.trim()
  } catch {
    id = ''
  }
  try {
    const agents = service(ctx, 'agents')
    if (agents !== undefined) {
      if (typeof agents.roots === 'function') {
        const roots = agents.roots()
        if (Array.isArray(roots)) {
          if (roots.includes(agent)) return true
          if (id !== '' && roots.some((root) => root !== null && typeof root === 'object' && root.id === id)) return true
        }
      }
      if (id !== '' && typeof agents.get === 'function') {
        const live = agents.get(id)
        // A live agent that is not a root is a subagent; an unknown id proves
        // nothing (test doubles, detached exec records) and falls through.
        if (live !== undefined && live !== null) return false
      }
    }
  } catch {
    // Fall through to the durable header.
  }
  let header
  try {
    header = agent.session !== null && agent.session !== undefined ? agent.session.header : undefined
  } catch {
    header = undefined
  }
  if (isPlainObject(header)) {
    if (header.origin === SUBAGENT_ORIGIN) return false
    if (Number.isInteger(header.delegationDepth) && header.delegationDepth > 0) return false
    return true
  }
  return null
}

/** Human-readable refusal for a heartbeat write attempted from a subagent. */
const ROOT_SESSION_HEARTBEAT_ONLY =
  'flow_heartbeat start/update/end only serve main sessions: this call runs in a subagent session, which does not keep a heartbeat. Report progress in the child final message; only the parent (main) session registers and closes a heartbeat.'

/**
 * Human-readable refusal for a decision write attempted from a subagent. The
 * decision ledger is the main session's conversation with the user: a subagent
 * cannot see the answer, so it reports the pending item in its final message and
 * the main session opens or closes the D record.
 */
const ROOT_SESSION_DECISION_ONLY =
  'flow_decision ask/answer/withdraw/gc only serve main sessions: this call runs in a subagent session, which cannot open or close a decision record. Report the pending decision in the child final message; only the parent (main) session creates and closes a D record.'

/** Resolve the heartbeat ledger root (the project main worktree); degrade to the workspace root. */
function heartbeatRootOf(root) {
  try {
    if (coreAvailable() && typeof core.resolveHeartbeatWorkspace === 'function') {
      const resolved = core.resolveHeartbeatWorkspace(root)
      if (isPlainObject(resolved) && typeof resolved.root === 'string' && resolved.root.length > 0) {
        return {
          root: resolved.root,
          degraded: resolved.degraded === true,
          reason: typeof resolved.reason === 'string' ? resolved.reason : '',
        }
      }
    }
  } catch {
    // Fall through to the workspace root.
  }
  return { root, degraded: false, reason: '' }
}

/** The task a session currently works on: its newest active, else newest draft. */
function currentTaskOf(records, session) {
  const open = records.filter(
    (record) => isPlainObject(record) && (record.status === 'active' || record.status === 'draft'),
  )
  if (open.length === 0) return null
  const owned = open.filter((record) => typeof record.owner === 'string' && record.owner === session)
  const pool = owned.length > 0 ? owned : open
  const active = pool.filter((record) => record.status === 'active')
  const ranked = (active.length > 0 ? active : pool).slice().sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
  return ranked.length > 0 ? ranked[0] : null
}

/**
 * The standing discipline section. It is evaluated per prompt assembly, so it
 * always names the live root, task and heartbeat state — one short paragraph,
 * never an accumulating log.
 */
function disciplineText(ctx, context) {
  try {
    const agent = context !== null && context !== undefined ? context.agent : undefined
    if (agent === undefined || agent === null || coreAvailable() === false) return ''
    // Delegated child sessions are not asked to keep a heartbeat.
    if (rootSessionVerdict(ctx, agent) === false) return ''
    const root = agentRoot(ctx, agent)
    if (root === undefined || hasStore(root) === false) return ''
    const c = requireCore()
    if (typeof c.listTasks !== 'function' || typeof c.heartbeatStatus !== 'function') return ''
    const loaded = c.loadContract(root)
    const session = usableSessionId(agent.id)
    const listed = c.listTasks(root, loaded.contract)
    const task = currentTaskOf(Array.isArray(listed) ? listed : [], session)
    let status = '未登记'
    if (session !== '') {
      const beat = c.heartbeatStatus(root, loaded.contract, session)
      if (beat !== null && typeof beat === 'object' && beat.record !== null && beat.record !== undefined) {
        status = typeof beat.record.status === 'string' && beat.record.status !== '' ? beat.record.status : '未知'
      }
    }
    const taskText = task === null ? '当前任务: 无' : `当前任务: ${clip(task.id, 40)} ${clip(task.title, 48)}`
    const text =
      `project-flow 纪律 · 根 ${root} · ${taskText} · 本会话心跳: ${status}。` +
      '每轮开始先用 flow_heartbeat start 登记 goal/task/claims（claims 写本会话独占写入的文件域，供其他会话避让）；结束前调用 flow_heartbeat end。'
    return clip(text, 380)
  } catch {
    return ''
  }
}

/** Register the standing discipline section when a system-prompt service exists. */
function registerDisciplineSection(ctx) {
  provide(ctx, 'systemPrompt', 'system prompt', (scoped) => {
    const systemPrompt = service(scoped, 'systemPrompt')
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return () => {}
    let dispose
    try {
      dispose = systemPrompt.section({
        name: 'project-flow:heartbeat-discipline',
        order: 9500,
        text: (context) => disciplineText(scoped, context),
      })
    } catch (error) {
      warnMount(`system prompt: discipline section not registered: ${brief(error)}`, scoped)
      return () => {}
    }
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // A section disposer must never break plugin unload.
      }
    }
  })
}

const HEARTBEAT_REMINDER_TEXT =
  '【project-flow】本轮还没有 working 心跳。先调用 flow_heartbeat start 登记 goal/task/claims（claims 写本会话独占写入的文件域），结束前调用 flow_heartbeat end。'

/** Reminder budget: one bounded message, one text block. */
const DECISION_QUESTION_CLIP = 60
const DECISION_REMINDER_CLIP = 800

/** One user-role reminder message; the fields match `MessageBase` + `role`. */
function reminderMessage(session, turn, step, text) {
  return {
    id: `project-flow:${session}:${turn}:${step}:${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Open-decision rows the reminder and the panel carry: core's DECISION_REMIND_MAX. */
function decisionRemindMax() {
  const value = coreAvailable() ? core.DECISION_REMIND_MAX : undefined
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 3
}

/** The store contract of one root, or null when it cannot be loaded. */
function decisionContractOf(root) {
  try {
    const c = requireCore()
    if (typeof c.loadContract !== 'function') return null
    const loaded = c.loadContract(root)
    return isPlainObject(loaded) ? loaded.contract : null
  } catch {
    return null
  }
}

/**
 * 挂起 display of one open decision: the turns it has waited for the session that
 * asked it, else the age since `asked_at`. Same rule as `decisionSuspended` in
 * bin/flow.mjs — two copies, because the Host and the CLI share no code. Only the
 * 3600 / 86400 thresholds are allowed; a change here must be mirrored there.
 */
function decisionSuspendedText(item) {
  const turnAge = isPlainObject(item) && Number.isInteger(item.turnAge) ? item.turnAge : null
  if (turnAge !== null) return `${turnAge} 轮`
  const age = isPlainObject(item) ? item.ageSeconds : null
  if (typeof age !== 'number' || Number.isFinite(age) === false) return '-'
  if (age < 3600) return `${Math.max(1, Math.round(age / 60))} 分钟`
  if (age < 86400) return `${Math.round(age / 3600)} 小时`
  return `${Math.round(age / 86400)} 天`
}

/** One reminder row: `- ⚠ D-… [kind] question  阻塞 T-…；挂起 3 轮`. */
function decisionReminderLine(item) {
  const blocks = Array.isArray(item.blocks)
    ? item.blocks.filter((id) => typeof id === 'string' && id !== '').map((id) => clip(id, 40))
    : []
  const blocked = blocks.length > 0 ? `阻塞 ${blocks.join('、')}；` : ''
  const head =
    `${item.escalated === true ? '⚠ ' : ''}${clip(item.id, 40)} [${clip(item.kind, 20)}] ` +
    clip(item.question, DECISION_QUESTION_CLIP)
  return `- ${head}  ${blocked}挂起 ${decisionSuspendedText(item)}`
}

/**
 * The decision section of the per-turn reminder, or '' when nothing is open. The
 * first turn of a session lists the whole ledger; later turns cap the detail at
 * DECISION_REMIND_MAX rows and count the rest. Row order is core's and is never
 * re-sorted here.
 */
function decisionReminderText(root, contract, session, turn) {
  try {
    if (hasStore(root) === false) return ''
    if (isPlainObject(contract) === false) return ''
    const c = requireCore()
    if (typeof c.summarizeDecisions !== 'function') return ''
    const firstTurn = Number.isInteger(turn) && turn === 1
    const info = { session, turn: Number.isInteger(turn) ? turn : null }
    if (firstTurn === false) info.limit = decisionRemindMax()
    const summary = c.summarizeDecisions(root, contract, info)
    const items = isPlainObject(summary) && Array.isArray(summary.items) ? summary.items : []
    const counts = isPlainObject(summary) ? summary.counts : null
    const open = isPlainObject(counts) && typeof counts.open === 'number' ? counts.open : 0
    if (open === 0 || items.length === 0) return ''
    const blocking = isPlainObject(counts) && typeof counts.blocking === 'number' ? counts.blocking : 0
    const lines = [`【project-flow】有 ${open} 个待用户拍板的决策（阻塞 ${blocking}）：`]
    for (const item of items) {
      if (isPlainObject(item)) lines.push(decisionReminderLine(item))
    }
    const remaining = open - items.length
    if (remaining > 0) lines.push(`还有 ${remaining} 条，运行 flow decision list --open 查看全部`)
    lines.push('回答后当轮调用 flow_decision answer <id> --choice <选项 id>；不要按推荐自行决定。')
    if (firstTurn) lines.push('新会话第一步：运行 flow decision list --open 查看完整清单')
    return clip(lines.join('\n'), DECISION_REMINDER_CLIP)
  } catch {
    return ''
  }
}

/**
 * Per-turn fallback: on the first step of a turn, append ONE user reminder that
 * merges two independently gated sections — the open decisions (whatever the
 * heartbeat state is) and the missing `working` heartbeat. Both empty means no
 * message at all; otherwise a single message with a single text block carries
 * both, decision section first. `step` is 1-based in the loop; `0` is accepted
 * too so the hook survives a loop that counts differently.
 */
function registerHeartbeatReminder(ctx) {
  try {
    if (typeof ctx.on !== 'function') return
    ctx.effect(() => {
      const dispose = ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          if (decision === null || decision === undefined || decision.kind !== 'enter') return decision
          const step = payload !== null && payload !== undefined ? payload.step : undefined
          if (step !== 0 && step !== 1) return decision
          const agent = payload.agent
          if (agent === undefined || agent === null) return decision
          // Only main sessions are reminded; a subagent gets neither section.
          if (rootSessionVerdict(ctx, agent) !== true) return decision
          const session = usableSessionId(agent.id)
          if (session === '') return decision
          const root = agentRoot(ctx, agent)
          if (root === undefined) return decision
          const turn = Number.isInteger(payload.turn) ? payload.turn : null
          const decisionsText = decisionReminderText(root, decisionContractOf(root), session, turn)
          const heartbeatText = heartbeatWorking(root, session) === false ? HEARTBEAT_REMINDER_TEXT : ''
          const text = [decisionsText, heartbeatText].filter((part) => part !== '').join('\n')
          if (text === '') return decision
          const messages = Array.isArray(decision.messages) ? decision.messages.slice() : []
          messages.push(reminderMessage(session, payload.turn, step, text))
          return { ...decision, messages }
        } catch {
          return decision
        }
      })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // A listener disposer must never break plugin unload.
        }
      }
    }, 'project-flow: heartbeat reminder')
  } catch (error) {
    warnMount(`heartbeat reminder unavailable: ${brief(error)}`, ctx)
  }
}

/** Default-on hard gate; disable with `config.heartbeatGate: false` or `PROJECT_FLOW_HEARTBEAT_GATE=off`. */
function heartbeatGateEnabled(config) {
  if (config !== null && typeof config === 'object') {
    if (config.heartbeatGate === false || config.enforceHeartbeat === false) return false
    if (config.heartbeatGate === true || config.enforceHeartbeat === true) return true
  }
  const env =
    typeof process.env.PROJECT_FLOW_HEARTBEAT_GATE === 'string'
      ? process.env.PROJECT_FLOW_HEARTBEAT_GATE.trim().toLowerCase()
      : ''
  if (env === '0' || env === 'off' || env === 'false' || env === 'no') return false
  return true
}

/** Deny `edit` / `write` for a session without a `working` heartbeat; everything else passes. */
function heartbeatGuardReason(ctx, execution) {
  try {
    if (execution === null || execution === undefined) return undefined
    if (HEARTBEAT_GATE_TOOLS.has(execution.name) === false) return undefined
    const agent = execution.agent
    if (agent === undefined || agent === null) return undefined
    // The hard gate exists for the main-session discipline only.
    if (rootSessionVerdict(ctx, agent) !== true) return undefined
    const session = usableSessionId(agent.id)
    if (session === '') return undefined
    const root = agentRoot(ctx, agent)
    if (root === undefined) return undefined
    if (heartbeatWorking(root, session) !== false) return undefined
    return '先调用 flow_heartbeat start 登记本轮目标与独占文件域'
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- decisions
//
// One decision record stays `open` until the user answers it. The tool below is
// the model-side writer; bin/flow.mjs drives the same lib/core.mjs API, and the
// per-turn reminder only reads it.

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

/** The turn of this session's heartbeat record; `null` when it cannot be read. */
function decisionTurnOf(c, root, contract, session) {
  if (typeof session !== 'string' || session === '') return null
  try {
    if (typeof c.heartbeatStatus !== 'function') return null
    const status = c.heartbeatStatus(root, contract, session)
    const record = isPlainObject(status) ? status.record : null
    return isPlainObject(record) && Number.isInteger(record.turn) ? record.turn : null
  } catch {
    return null
  }
}

/** One `choice` option, restricted to the three fields the tool schema accepts. */
function decisionOptionInput(option) {
  if (isPlainObject(option) === false) throw new Error('flow_decision ask: every option needs id, label and impact')
  if (typeof option.id !== 'string' || typeof option.label !== 'string' || typeof option.impact !== 'string') {
    throw new Error('flow_decision ask: every option needs id, label and impact')
  }
  return { id: option.id, label: option.label, impact: option.impact }
}

/**
 * The lib/core.mjs `addDecision` input of one ask. `asked_session` (this session)
 * and `asked_turn` (its heartbeat turn) are the ledger's provenance: they let the
 * reminder say how many turns an item has been waiting. The turn is written only
 * when it is a real integer; the session is written regardless.
 */
function decisionAskInput(args, c, root, contract, session) {
  const kind = typeof args.kind === 'string' ? args.kind.trim() : ''
  if (kind === '') throw new Error('flow_decision ask requires kind: choice, approval or input')
  if (typeof args.rationale !== 'string' || args.rationale.trim() === '') {
    throw new Error('flow_decision ask requires rationale: say why the user must decide now')
  }
  const input = { question: args.question, kind, rationale: args.rationale }
  if (Array.isArray(args.options)) input.options = args.options.map(decisionOptionInput)
  const recommendation =
    typeof args.recommendation === 'string' && args.recommendation.trim() !== '' ? args.recommendation.trim() : ''
  if (recommendation !== '') input.recommendation = recommendation
  // An approval asked without a recommendation recommends approve; a session that
  // wants the user to reject passes recommendation: 'reject' explicitly.
  else if (kind === 'approval') input.recommendation = 'approve'
  if (args.default !== undefined && args.default !== null) input.default = args.default
  for (const name of ['blocks', 'affects']) {
    if (Array.isArray(args[name])) input[name] = args[name]
  }
  if (typeof args.supersedes === 'string' && args.supersedes.trim() !== '') input.supersedes = args.supersedes.trim()
  input.asked_session = session
  const turn = decisionTurnOf(c, root, contract, session)
  if (turn !== null) input.asked_turn = turn
  return input
}

function buildToolDefinitions(ctx) {
  return [
    {
      name: 'flow_status',
      description:
        'Report the project flow ledger: contract source, experiment and task totals, and gate definitions with their last result. Read-only. Works with the .dsh/flow store; an uninitialized workspace reports empty totals.',
      parameters: { type: 'object', properties: { root: ROOT_PROPERTY }, required: [], additionalProperties: false },
      output: toolOutput(),
      isConcurrencySafe: true,
      timeoutMs: 15_000,
      async execute(args, exec) {
        const root = toolRoot(ctx, args, exec)
        const c = requireCore()
        const loaded = c.loadContract(root)
        const state = c.readStoreState(root, loaded.contract)
        const experiments = state.experiments
        const tasks = state.tasks
        return {
          root,
          store: hasStore(root),
          contract: { source: loaded.source, schema: loaded.contract.schema, name: loaded.contract.name },
          experiments: { total: experiments.counts.total, counts: experiments.counts },
          tasks: { total: tasks.counts.total, counts: tasks.counts },
          gates: (Array.isArray(state.gates.items) ? state.gates.items : []).map((gate) => ({
            id: gate.id,
            ok: gate.lastRun === null || gate.lastRun === undefined ? null : gate.lastRun.ok === true,
            at: gate.lastRun === null || gate.lastRun === undefined ? null : gate.lastRun.started_at,
          })),
        }
      },
    },
    {
      name: 'flow_exp',
      description:
        'List, inspect, add, update or remove project-flow experiments (id, hypothesis, factor, expected, measured, status, parent lineage). All actions require the .dsh/flow store. `tree` returns the parent/child forest.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'show', 'tree', 'add', 'update', 'remove'] },
          root: ROOT_PROPERTY,
          id: ID_PROPERTY,
          title: { type: 'string' },
          hypothesis: { type: 'string' },
          factor: { type: 'string' },
          parent: { type: 'string', description: 'Parent experiment id, or empty for a root experiment.' },
          expected: { type: 'string' },
          scale: { type: 'string' },
          status: { type: 'string', enum: ['open', 'confirmed', 'refuted', 'abandoned'] },
          measured: { type: 'string' },
          metrics: { type: 'object', description: 'Free-form measured metrics.' },
          commits: { type: 'array', items: { type: 'string' }, description: 'Short commit shas.' },
          notes: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: toolOutput(),
      isConcurrencySafe: false,
      timeoutMs: WRITE_TIMEOUT_MS,
      async execute(args, exec) {
        const root = toolRoot(ctx, args, exec)
        const action = args.action
        if (action !== 'list') requireStore(root)

        const c = requireCore()
        const { contract } = c.loadContract(root)
        if (action === 'list' && hasStore(root) === false) {
          return {
            root,
            store: false,
            source: 'store',
            total: 0,
            counts: { total: 0, open: 0, confirmed: 0, refuted: 0, abandoned: 0 },
            items: [],
            note: EMPTY_STORE_NOTE,
          }
        }
        if (action === 'list') {
          const records = c.listExperiments(root, contract)
          const counts = { total: records.length, open: 0, confirmed: 0, refuted: 0, abandoned: 0 }
          for (const record of records) {
            if (typeof record.status === 'string' && Object.hasOwn(counts, record.status) && record.status !== 'total') {
              counts[record.status] += 1
            }
          }
          const items = records.slice(0, MAX_TOOL_ITEMS)
          return { root, store: true, source: 'store', total: records.length, counts, items, ...(items.length < records.length ? { truncated: true } : {}) }
        }
        if (action === 'show') {
          return { root, experiment: c.getExperiment(root, contract, requireId('flow_exp', action, args.id)) }
        }
        if (action === 'tree') {
          return { root, tree: c.experimentTree(c.listExperiments(root, contract)) }
        }
        if (action === 'add') {
          const input = pickFields(args, [
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
          ])
          return { root, experiment: c.addExperiment(root, contract, input) }
        }
        if (action === 'update') {
          const id = requireId('flow_exp', action, args.id)
          const patch = pickFields(args, [
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
          ])
          if (Object.keys(patch).length === 0) throw new Error('flow_exp update requires at least one field to change')
          return { root, experiment: c.updateExperiment(root, contract, id, patch) }
        }
        if (action === 'remove') {
          const id = requireId('flow_exp', action, args.id)
          return { root, ...c.removeExperiment(root, contract, id) }
        }
        throw new Error(`unknown flow_exp action: ${String(action)}`)
      },
    },
    {
      name: 'flow_task',
      description:
        'List, inspect, add, update or remove project-flow tasks (title, status, owner, goal, scope, acceptance, commits). All actions require the .dsh/flow store.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'show', 'add', 'update', 'remove'] },
          root: ROOT_PROPERTY,
          id: ID_PROPERTY,
          title: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'active', 'done', 'archived'] },
          owner: { type: 'string' },
          goal: { type: 'string' },
          notes: { type: 'string' },
          commits: { type: 'array', items: { type: 'string' }, description: 'Short commit shas.' },
          scope: {
            type: 'object',
            properties: {
              allow: { type: 'array', items: { type: 'string' } },
              deny: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
          acceptance: { type: 'array', items: { type: 'string' } },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: toolOutput(),
      isConcurrencySafe: false,
      timeoutMs: WRITE_TIMEOUT_MS,
      async execute(args, exec) {
        const root = toolRoot(ctx, args, exec)
        const action = args.action
        if (action !== 'list') requireStore(root)

        const c = requireCore()
        const { contract } = c.loadContract(root)
        if (action === 'list' && hasStore(root) === false) {
          return {
            root,
            store: false,
            source: 'store',
            total: 0,
            counts: { draft: 0, active: 0, done: 0, archived: 0, other: 0 },
            current: null,
            items: [],
            note: EMPTY_STORE_NOTE,
          }
        }
        if (action === 'list') {
          const records = c.listTasks(root, contract)
          return {
            root,
            store: true,
            source: 'store',
            total: records.length,
            counts: taskCountsOf(records),
            current: typeof contract.tasks.current === 'string' ? contract.tasks.current : null,
            items: records.slice(0, MAX_TOOL_ITEMS),
            ...(records.length > MAX_TOOL_ITEMS ? { truncated: true } : {}),
          }
        }
        if (action === 'show') {
          return { root, task: c.getTask(root, contract, requireId('flow_task', action, args.id)) }
        }
        if (action === 'add') {
          const input = pickFields(args, ['id', 'title', 'status', 'owner', 'goal', 'notes', 'commits', 'scope', 'acceptance'])
          return { root, task: c.addTask(root, contract, input) }
        }
        if (action === 'update') {
          const id = requireId('flow_task', action, args.id)
          const patch = pickFields(args, ['title', 'status', 'owner', 'goal', 'notes', 'commits', 'scope', 'acceptance'])
          if (Object.keys(patch).length === 0) throw new Error('flow_task update requires at least one field to change')
          return { root, task: c.updateTask(root, contract, id, patch) }
        }
        if (action === 'remove') {
          const id = requireId('flow_task', action, args.id)
          return { root, ...c.removeTask(root, contract, id) }
        }
        throw new Error(`unknown flow_task action: ${String(action)}`)
      },
    },
    {
      name: 'flow_gate',
      description:
        'List, inspect, add, update, remove, run or read logs of project-flow gates (ordered shell steps with expect rules). All actions except list require a .dsh/flow store. `run` executes the steps in the project root; a non-zero step stops the run.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'show', 'add', 'update', 'remove', 'run', 'logs'] },
          root: ROOT_PROPERTY,
          id: { type: 'string', description: 'Gate id, e.g. precommit.' },
          title: { type: 'string' },
          phase: { type: 'string', enum: ['commit', 'release', 'manual'] },
          enabled: { type: 'boolean' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                run: { type: 'string', description: 'Shell command, executed with the project root as cwd.' },
                expect: { type: 'string', description: 'exit N (default exit 0) or contains: TEXT.' },
                timeoutSeconds: { type: 'integer', description: 'Per-step timeout in seconds (default 600).' },
              },
              required: ['run'],
              additionalProperties: false,
            },
          },
          limit: { type: 'integer', description: 'Maximum run records to return (default 5, capped at 50).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: toolOutput(),
      isConcurrencySafe: false,
      async execute(args, exec) {
        const root = toolRoot(ctx, args, exec)
        const action = args.action
        if (action === 'list' && hasStore(root) === false) {
          return {
            root,
            store: false,
            gates: [],
            note: 'gate definitions live in the .dsh/flow store; run: node bin/flow.mjs init',
          }
        }
        requireStore(root)
        const c = requireCore()
        const { contract } = c.loadContract(root)
        if (action === 'list') {
          const gates = c.listGates(root, contract).map((gate) => {
            const runs = c.listGateRuns(root, contract, gate.id, 1)
            return { ...gate, lastRun: runs.length > 0 ? runs[0] : null }
          })
          return { root, store: true, gates }
        }
        if (action === 'show') {
          const id = requireId('flow_gate', action, args.id)
          const runs = c.listGateRuns(root, contract, id, 1)
          return { root, gate: c.getGate(root, contract, id), lastRun: runs.length > 0 ? runs[0] : null }
        }
        if (action === 'add') {
          const input = pickFields(args, ['id', 'title', 'phase', 'enabled', 'steps'])
          return { root, gate: c.addGate(root, contract, input) }
        }
        if (action === 'update') {
          const id = requireId('flow_gate', action, args.id)
          const patch = pickFields(args, ['title', 'phase', 'enabled', 'steps'])
          if (Object.keys(patch).length === 0) throw new Error('flow_gate update requires at least one field to change')
          return { root, gate: c.updateGate(root, contract, id, patch) }
        }
        if (action === 'remove') {
          const id = requireId('flow_gate', action, args.id)
          return { root, ...c.removeGate(root, contract, id) }
        }
        if (action === 'run') {
          const id = requireId('flow_gate', action, args.id)
          return { root, run: await c.runGate(root, contract, id, {}) }
        }
        if (action === 'logs') {
          const id = requireId('flow_gate', action, args.id)
          const limit = pickInteger(args.limit, 5, 1, 50)
          return { root, gate: id, runs: c.listGateRuns(root, contract, id, limit) }
        }
        throw new Error(`unknown flow_gate action: ${String(action)}`)
      },
    },
    {
      name: 'flow_heartbeat',
      description:
        'Main-session work heartbeat (start/update/end/list/status) for the project ledger; a subagent session must not call the write actions. Every turn: call start BEFORE replying — goal defaults to the current task title, claims lists the files this session exclusively writes so other main sessions avoid them — and call end before finishing. update refreshes status/last_action; list and status read the section. The ledger lives in the project main worktree, even when the current session runs in a linked worktree. Writes require a .dsh/flow store.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'update', 'end', 'list', 'status'] },
          root: ROOT_PROPERTY,
          goal: { type: 'string', description: 'What this turn works on. start defaults it to the current task title.' },
          task: {
            type: 'string',
            description: 'Task id this session works on; defaults to the session active/draft task.',
          },
          claims: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files or directories this session writes exclusively; other sessions stay out of them.',
          },
          last_action: { type: 'string', description: 'Latest action, shown on the panel heartbeat line.' },
          note: { type: 'string', description: 'Free note; folded into last_action on start/end.' },
          status: {
            type: 'string',
            enum: ['working', 'idle'],
            description: 'update only: working keeps the turn open, idle parks the heartbeat.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: toolOutput(),
      isConcurrencySafe: false,
      timeoutMs: WRITE_TIMEOUT_MS,
      async execute(args, exec) {
        const workspace = toolRoot(ctx, args, exec)
        const action = args.action
        // The heartbeat ledger belongs to the project's main worktree, so a
        // session running in a linked worktree reads and writes the same files.
        const heartbeat = heartbeatRootOf(workspace)
        const root = heartbeat.root

        if (action === 'list') {
          const warnings = []
          if (heartbeat.degraded === true) {
            warnings.push(`heartbeat-root-degraded: ${heartbeat.reason || root}`)
          }
          const store = hasStore(root)
          if (coreAvailable() === false || store === false) {
            if (coreAvailable() === false) warnings.push(`core-unavailable: ${coreFailure || 'unknown error'}`)
            return {
              root,
              workspace,
              store,
              dir: '.agents/heartbeat',
              items: [],
              counts: { total: 0, active: 0, stale: 0, hidden: 0 },
              warnings,
            }
          }
          const c = requireCore()
          const { contract } = c.loadContract(root)
          const section = c.readHeartbeatSection(root, contract)
          const items = isPlainObject(section) && Array.isArray(section.items) ? section.items : []
          const counts = isPlainObject(section) && isPlainObject(section.counts)
            ? section.counts
            : { total: items.length, active: 0, stale: 0, hidden: 0 }
          return {
            root,
            workspace,
            store,
            dir: isPlainObject(section) && typeof section.dir === 'string' ? section.dir : '.agents/heartbeat',
            items: items.slice(0, MAX_TOOL_ITEMS),
            counts,
            ...(items.length > MAX_TOOL_ITEMS ? { truncated: true } : {}),
            warnings,
          }
        }

        if (action === 'status') {
          const session = requireSession(exec)
          const c = requireCore()
          if (typeof c.heartbeatStatus !== 'function') {
            throw new Error('flow_heartbeat status needs a newer lib/core.mjs: heartbeat support is missing')
          }
          const warnings = []
          const { contract } = c.loadContract(root)
          const result = c.heartbeatStatus(root, contract, session)
          return {
            root,
            workspace,
            store: hasStore(root),
            session,
            active: isPlainObject(result) && result.active === true,
            record: isPlainObject(result) && isPlainObject(result.record) ? result.record : null,
            warnings,
          }
        }

        const session = requireSession(exec)
        // Delegated child sessions never keep a heartbeat: refuse loudly with an
        // actionable hint instead of silently writing a hidden ledger file.
        if (rootSessionVerdict(ctx, exec.agent) === false) {
          throw new Error(ROOT_SESSION_HEARTBEAT_ONLY)
        }
        requireStore(root)
        const c = requireCore()
        const { contract } = c.loadContract(root)

        if (action === 'start') {
          if (typeof c.startHeartbeat !== 'function') {
            throw new Error('flow_heartbeat start needs a newer lib/core.mjs: heartbeat support is missing')
          }
          const input = pickFields(args, ['goal', 'task', 'claims', 'last_action'])
          if (input.last_action === undefined && typeof args.note === 'string' && args.note.trim().length > 0) {
            input.last_action = args.note.trim()
          }
          return {
            root,
            workspace,
            store: true,
            session,
            heartbeat: c.startHeartbeat(root, contract, { session, ...input }),
          }
        }
        if (action === 'update') {
          if (typeof c.updateHeartbeat !== 'function') {
            throw new Error('flow_heartbeat update needs a newer lib/core.mjs: heartbeat support is missing')
          }
          const patch = pickFields(args, ['status', 'last_action', 'goal', 'task', 'claims'])
          if (Object.keys(patch).length === 0) throw new Error('flow_heartbeat update requires at least one field to change')
          return { root, workspace, store: true, session, heartbeat: c.updateHeartbeat(root, contract, session, patch) }
        }
        if (action === 'end') {
          if (typeof c.endHeartbeat !== 'function') {
            throw new Error('flow_heartbeat end needs a newer lib/core.mjs: heartbeat support is missing')
          }
          const options = { session }
          if (typeof args.note === 'string' && args.note.trim().length > 0) options.note = args.note.trim()
          return { root, workspace, store: true, session, heartbeat: c.endHeartbeat(root, contract, options) }
        }
        throw new Error(`unknown flow_heartbeat action: ${String(action)}`)
      },
    },
    {
      name: 'flow_decision',
      description:
        'Decision ledger for questions only the user can settle: `ask` records one open item (choice/approval/input), `list` and `show` read it, `answer` closes it with the user\'s choice, `withdraw` drops it with a reason, `gc` removes closed records past the retention window. R1: call ask BEFORE you pose the question, then put the returned id in the question text as [D-<id>]. R2: in the same turn the user answers, call answer with their choice. R5: recommendation and default are proposals, not the answer - never adopt one on the user\'s behalf. An approval asked without a recommendation recommends approve (pass recommendation reject to recommend rejection). Write actions serve main sessions only: a subagent reports the pending decision in its final message, and only the parent (main) session creates and closes a D record. list/show work in any session; writes require a .dsh/flow store.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['ask', 'list', 'show', 'answer', 'withdraw', 'gc'],
            description: 'ask creates, list/show read, answer/withdraw close one, gc prunes closed records.',
          },
          root: ROOT_PROPERTY,
          id: { type: 'string', description: 'Decision id, e.g. D-20261031-01.' },
          question: { type: 'string', description: 'ask: the one-sentence question the user must settle.' },
          kind: {
            type: 'string',
            enum: ['choice', 'approval', 'input'],
            description: 'ask: choice needs 2+ options, approval uses the fixed approve|reject pair, input takes free text.',
          },
          options: {
            type: 'array',
            description: 'ask + kind=choice: the mutually exclusive options.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Short option id the answer names, e.g. adopt.' },
                label: { type: 'string', description: 'What the user picks.' },
                impact: { type: 'string', description: 'What changes when this option is chosen.' },
              },
              required: ['id', 'label', 'impact'],
              additionalProperties: false,
            },
          },
          default: { type: 'string', description: 'ask: option id used when the user never answers; not an answer.' },
          recommendation: {
            type: 'string',
            description: 'ask: option id this session proposes; not an answer. Omitted on kind=approval means approve.',
          },
          rationale: { type: 'string', description: 'ask: why the user must decide now; required.' },
          blocks: {
            type: 'array',
            items: { type: 'string' },
            description: 'ask: task ids that cannot proceed until the user answers.',
          },
          affects: {
            type: 'array',
            items: { type: 'string' },
            description: 'ask: repo-relative files or directories the answer changes.',
          },
          supersedes: {
            type: 'string',
            description: 'ask: closed decision id this one replaces; required to re-ask the same question.',
          },
          choice: { type: 'string', description: 'answer: the option id (kind=input: free text) the user picked.' },
          note: { type: 'string', description: 'answer: the user\'s wording or a short note.' },
          by: { type: 'string', enum: ['user', 'agent'], description: 'Who confirmed it; defaults to user.' },
          reason: { type: 'string', description: 'withdraw: why the question no longer applies; required.' },
          days: { type: 'integer', description: 'gc: closed-record retention window in days (default 90).' },
          dryRun: { type: 'boolean', description: 'gc: report what would be removed without deleting it.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: toolOutput(),
      isConcurrencySafe: false,
      timeoutMs: WRITE_TIMEOUT_MS,
      async execute(args, exec) {
        const root = toolRoot(ctx, args, exec)
        const c = requireCore()
        const action = args.action

        // Read actions are open to every session: a subagent may want to know
        // which decision already blocks its task.
        if (action === 'list') {
          if (hasStore(root) === false) {
            return { root, items: [], counts: emptyDecisionCounts(), note: EMPTY_STORE_NOTE }
          }
          if (typeof c.summarizeDecisions !== 'function' || typeof c.listDecisions !== 'function') {
            throw new Error('flow_decision list needs a newer lib/core.mjs: decision support is missing')
          }
          const { contract } = c.loadContract(root)
          const session = usableSessionId(sessionIdOf(exec) ?? '')
          const turn = decisionTurnOf(c, root, contract, session)
          const info = { session, turn }
          const summary = c.summarizeDecisions(root, contract, info)
          return { root, items: c.listDecisions(root, contract, info), counts: decisionCountsOf(summary.counts) }
        }

        if (action === 'show') {
          if (typeof c.getDecision !== 'function') {
            throw new Error('flow_decision show needs a newer lib/core.mjs: decision support is missing')
          }
          const id = requireId('flow_decision', action, args.id)
          const { contract } = c.loadContract(root)
          return { root, decision: c.getDecision(root, contract, id) }
        }

        // Writes: the decision ledger belongs to the main session's conversation
        // with the user. Refuse loudly instead of writing an answer nobody asked.
        if (rootSessionVerdict(ctx, exec.agent) === false) {
          throw new Error(ROOT_SESSION_DECISION_ONLY)
        }
        requireStore(root)
        const { contract } = c.loadContract(root)

        if (action === 'ask') {
          if (typeof c.addDecision !== 'function') {
            throw new Error('flow_decision ask needs a newer lib/core.mjs: decision support is missing')
          }
          const session = requireSession(exec)
          const result = c.addDecision(root, contract, decisionAskInput(args, c, root, contract, session))
          return { root, decision: result.decision, created: result.created === true }
        }
        if (action === 'answer') {
          if (typeof c.answerDecision !== 'function') {
            throw new Error('flow_decision answer needs a newer lib/core.mjs: decision support is missing')
          }
          const id = requireId('flow_decision', action, args.id)
          return { root, decision: c.answerDecision(root, contract, id, pickFields(args, ['choice', 'note', 'by'])) }
        }
        if (action === 'withdraw') {
          if (typeof c.withdrawDecision !== 'function') {
            throw new Error('flow_decision withdraw needs a newer lib/core.mjs: decision support is missing')
          }
          const id = requireId('flow_decision', action, args.id)
          return { root, decision: c.withdrawDecision(root, contract, id, pickFields(args, ['reason', 'by'])) }
        }
        if (action === 'gc') {
          if (typeof c.gcDecisions !== 'function') {
            throw new Error('flow_decision gc needs a newer lib/core.mjs: decision support is missing')
          }
          const options = {}
          if (args.days !== undefined) options.days = args.days
          if (args.dryRun !== undefined) options.dryRun = args.dryRun === true
          const result = c.gcDecisions(root, contract, options)
          return { root, removed: result.removed, kept: result.kept, dryRun: result.dryRun }
        }
        throw new Error(`unknown flow_decision action: ${String(action)}`)
      },
    },
  ]
}

/**
 * Register through an optional service. With Cordis, `ctx.inject` defers the
 * callback until the service exists; registration is an effect so unload
 * unregisters everything. Without an injection facility (plain test doubles or
 * an older host) the service is used only when already present.
 */
function provide(ctx, name, label, setup) {
  const install = (scoped) => {
    try {
      scoped.effect(() => setup(scoped), `project-flow: ${label}`)
    } catch (error) {
      warnMount(`${label}: registration failed: ${brief(error)}`, ctx)
    }
  }

  if (typeof ctx.inject !== 'function') {
    if (service(ctx, name) === undefined) return
    try {
      ctx.effect(() => setup(ctx), `project-flow: ${label}`)
    } catch (error) {
      warnMount(`${label}: registration failed: ${brief(error)}`, ctx)
    }
    return
  }

  try {
    ctx.effect(() => {
      const fiber = ctx.inject([name], install)
      return () => {
        try {
          if (fiber !== undefined && fiber !== null && typeof fiber.dispose === 'function') {
            const pending = fiber.dispose()
            if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(() => {})
          }
        } catch {
          // Disposal must never throw into the host.
        }
      }
    }, `project-flow: ${label} inject`)
  } catch (error) {
    warnMount(`${label}: injection failed: ${brief(error)}`, ctx)
  }
}

function registerTools(ctx, settings) {
  provide(ctx, 'tools', 'tools', (scoped) => {
    const tools = service(scoped, 'tools')
    if (tools === undefined || typeof tools.register !== 'function') return () => {}
    const disposers = []
    for (const definition of buildToolDefinitions(scoped)) {
      try {
        const dispose = tools.register(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        warnMount(`tools: cannot register ${definition.name}: ${brief(error)}`, scoped)
      }
    }
    // Hard gate: a session that never registered a `working` heartbeat may not
    // write files. Only edit/write are denied, so read/bash/diagnostics keep
    // working; every failure inside the guard itself allows the call.
    if (settings !== null && typeof settings === 'object' && settings.heartbeatGate === true) {
      try {
        if (typeof tools.guard === 'function') {
          const dispose = tools.guard((execution) => heartbeatGuardReason(scoped, execution))
          if (typeof dispose === 'function') disposers.push(dispose)
        }
      } catch (error) {
        warnMount(`tools: heartbeat guard not registered: ${brief(error)}`, scoped)
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A tool disposer must never break plugin unload.
        }
      }
    }
  })
}

// ------------------------------------------------------------------- skills

const SKILL_META = [
  {
    name: 'project-flow-init',
    description: 'Initialize a project to the .dsh/flow store (schema 2) and inspect the resulting layout.',
    whenToUse:
      'Use when the project has no .dsh/flow/flow.json, when the user asks to set up project flow, or when flow tools report a missing store.',
  },
  {
    name: 'project-flow-usage',
    description: 'Record and inspect experiments, tasks and gates through the flow CLI and the flow_* tools.',
    whenToUse:
      'Use when the user asks about project flow status, experiments, tasks or gates, or wants to record an experiment, task or gate run.',
  },
  {
    /* Directory layout: skills/<name>/SKILL.md plus references/, assets/, scripts/. */
    name: 'ai-collaborative-dev-workflow',
    description:
      'Multi-agent (and single-agent) development workflow: project profiles, command contracts, quality gates, release cadence, session continuity, and collaboration discipline.',
    whenToUse:
      'Use when starting or resuming a development task in a long-maintained project, coordinating several agents or sessions, preparing a commit/release, or recovering after an interrupted session. Read its references only for the section you need.',
  },
]

/**
 * Read the simple frontmatter of a skill file: the top-level `description` and
 * `when-to-use` inside the `metadata:` block. Only `key: value` scalars are
 * supported; folded/quoted multiline values are ignored so the SKILL_META
 * fallback still applies.
 */
function readSkillFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content)
  if (match === null) return { description: '', whenToUse: '' }
  const seen = {}
  let block = ''
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const pair = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line.trim())
    if (pair === null) continue
    if (/^[ \t]/.test(line)) {
      if (block === 'metadata') seen[`metadata.${pair[1]}`] = pair[2].trim()
    } else {
      block = pair[1]
      seen[block] = pair[2].trim()
    }
  }
  const unquote = (value) => (typeof value === 'string' ? value.replace(/^["']|["']$/g, '').trim() : '')
  return {
    description: unquote(seen.description),
    whenToUse: unquote(seen['metadata.when-to-use']),
  }
}

function registerSkills(ctx) {
  provide(ctx, 'skills', 'skills', (scoped) => {
    const skills = service(scoped, 'skills')
    if (skills === undefined || typeof skills.register !== 'function') return () => {}
    const disposers = []
    for (const meta of SKILL_META) {
      // Two layouts: a directory skill (skills/<name>/SKILL.md) may carry
      // references/, assets/ and scripts/, a flat skill (skills/<name>.md) is
      // the instruction file alone. The directory wins when both exist.
      const dir = join(PACKAGE_ROOT, 'skills', meta.name)
      const dirRelative = join('skills', meta.name, 'SKILL.md')
      const flatRelative = join('skills', `${meta.name}.md`)
      const directory = existsSync(join(dir, 'SKILL.md'))
      const relativePath = directory ? dirRelative : flatRelative
      const file = directory ? join(dir, 'SKILL.md') : join(PACKAGE_ROOT, flatRelative)
      let content
      try {
        content = readFileSync(file, 'utf8')
      } catch (error) {
        warnMount(`skills: ${toPosix(relativePath)} not found; ${meta.name} was not registered (${brief(error, 120)})`, scoped)
        continue
      }
      if (typeof content !== 'string' || content.trim().length === 0) {
        warnMount(`skills: ${toPosix(relativePath)} is empty; ${meta.name} was not registered`, scoped)
        continue
      }
      try {
        /* A directory skill is a file the package author can edit: its own
           frontmatter wins over the SKILL_META fallback. */
        const front = readSkillFrontmatter(content)
        const dispose = skills.register({
          name: meta.name,
          description: front.description.length > 0 ? front.description : meta.description,
          whenToUse: front.whenToUse.length > 0 ? front.whenToUse : meta.whenToUse,
          /* SkillSummary requires a string source; these ship with the bundle. */
          source: 'bundled',
          /* The filesystem provider strips the frontmatter from a loaded body;
             do the same, or the model sees the metadata block twice. */
          content: content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trimStart(),
          /* A directory skill renders "Base directory for this skill: <path>" and
             the model resolves relative references against it; the flat layout
             has no resources, so it carries no resourceBase. */
          ...(directory ? { resourceBase: { kind: 'directory', path: dir } } : {}),
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        warnMount(`skills: cannot register ${meta.name}: ${brief(error)}`, scoped)
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A skill disposer must never break plugin unload.
        }
      }
    }
  })
}

/**
 * Mount one JSON endpoint behind the shared wrapper: the handler never rejects
 * into the host, and an already-sent response is torn down instead of answered.
 * Each route is its own effect, so unload unregisters it.
 */
function mountJsonRoute(ctx, path, label, handler) {
  const route = {
    kind: 'exact',
    path,
    handler: (request, response) => {
      Promise.resolve()
        .then(() => handler(ctx, request, response))
        .catch((error) => {
          try {
            if (response.headersSent) {
              response.destroy()
              return
            }
            sendError(response, 500, 'internal', brief(error))
          } catch {
            // The socket is already gone; nothing left to report to.
          }
        })
    },
  }

  try {
    ctx.effect(() => {
      const webServer = service(ctx, 'webServer')
      if (webServer === undefined || typeof webServer.register !== 'function') return () => {}
      const dispose = webServer.register(route)
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // Disposal must never throw into the host.
        }
      }
    }, `project-flow: ${label}`)
  } catch (error) {
    warnMount(`${label}: registration failed: ${brief(error)}`, ctx)
  }
}

export function apply(ctx, config) {
  const settings = { heartbeatGate: heartbeatGateEnabled(config) }

  mountJsonRoute(ctx, ROUTE_PATH, 'state route', handleState)
  mountJsonRoute(ctx, INIT_ROUTE_PATH, 'init route', handleInit)
  mountJsonRoute(ctx, GATE_ROUTE_PATH, 'gate route', handleGate)

  // Optional services: a host without tools/skills/systemPrompt (or a plain
  // test double) must still get the endpoints. Never let one of these take the
  // plugin down.
  try {
    registerTools(ctx, settings)
  } catch (error) {
    warnMount(`tools: registration failed: ${brief(error)}`, ctx)
  }
  try {
    registerSkills(ctx)
  } catch (error) {
    warnMount(`skills: registration failed: ${brief(error)}`, ctx)
  }
  try {
    registerDisciplineSection(ctx)
  } catch (error) {
    warnMount(`system prompt: registration failed: ${brief(error)}`, ctx)
  }
  try {
    registerHeartbeatReminder(ctx)
  } catch (error) {
    warnMount(`heartbeat reminder: registration failed: ${brief(error)}`, ctx)
  }
}
