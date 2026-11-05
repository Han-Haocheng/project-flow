/**
 * project-flow core (schema 2).
 *
 * The single writer for a project's flow store: contract, atomic writes, a
 * short-lived lock, experiment/task/gate CRUD and gate execution. Only node
 * built-ins are used, so the CLI, the agent tools and the read-only panel
 * all share this one module.
 *
 * Layout (root-relative, fixed unless the contract says otherwise):
 *   .dsh/flow/flow.json
 *   .dsh/flow/experiments/<id>.json
 *   .dsh/flow/tasks/<id>.json
 *   .dsh/flow/gates/<id>.json
 *   .dsh/flow/decisions/<id>.json
 *   .dsh/flow/logs/<gateId>/<timestamp>.json
 *   .dsh/flow/.lock   (temporary, never committed or displayed)
 */

import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_VERSION = 2

const STORE_REL = '.dsh/flow'
const CONTRACT_REL = '.dsh/flow/flow.json'
const LOCK_FILE = '.lock'
/** Positive integer from the environment (invalid values are ignored). */
function envPositiveInt(name, fallback) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * A lock younger than this is respected even when its owner looks dead: the
 * owner may still be writing between `open` and its first heartbeat of work.
 * `FLOW_LOCK_STALE_MS` overrides it for experiments; invalid values are ignored.
 */
const LOCK_STALE_MS = envPositiveInt('FLOW_LOCK_STALE_MS', 30_000)
/** Foreign-host / unknown-owner locks get extra grace before being taken over. */
const FOREIGN_STALE_MS = 60_000
/** `open(wx)`/takeover attempts before giving up with conflict. */
const MAX_LOCK_ATTEMPTS = 4
/** Backoff for transient rename failures (AV scanners, Windows sharing). */
const RENAME_RETRY_DELAYS_MS = [10, 50, 150]
/** Temp files and takeover leftovers older than this may be swept. */
const STALE_TMP_MS = 600_000
const TMP_NAME_RE = /\.tmp-\d+-\d+$/
const LOCK_TAKEOVER_RE = /\.lock\.takeover-\d+-[0-9a-f]{6,}$/

const EXP_ID_RE = /^[A-Z]+-\d{8}-\d{2}$/
/** Id shape accepted for cross-record references (`parent`). */
const REF_ID_RE = /^[A-Za-z][A-Za-z0-9_.-]{1,60}$/
const GATE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

/** Experiment record schema written by `addExperiment`; anything else is read-only legacy. */
export const EXPERIMENT_SCHEMA = 2
const EXPERIMENT_STATUS = ['open', 'confirmed', 'refuted', 'abandoned', 'inconclusive', 'pivoted']
/** `schema !== 2` records predate schema2 and only ever used these four states. */
const EXPERIMENT_LEGACY_STATUS = ['open', 'confirmed', 'refuted', 'abandoned']
/** Seven judging fields a schema-2 hypothesis must carry on creation. */
const EXPERIMENT_REQUIRED_FIELDS = ['direction', 'expected', 'primaryMetric', 'guardrails', 'falsify', 'windowDays', 'stopLoss']
/** Fields only the dedicated writers may touch (`cleanupExperiment` / `productizeExperiment`). */
const EXPERIMENT_SYSTEM_FIELDS = ['cleanup', 'cleanupAt', 'productizedAt', 'productizeGate']
const EXPERIMENT_DIRECTION_MAX = 120
const EXPERIMENT_CLEANUP_MAX = 20
/** Accepted ceiling for `windowDays` (ten years, same order as the archive window). */
const EXPERIMENT_WINDOW_MAX_DAYS = 3650
const TASK_STATUS = ['draft', 'active', 'done', 'archived']
const GATE_PHASES = ['commit', 'release', 'manual']

// ---------------------------------------------------------------- decisions
//
// A `D-` record is a question that needs the user to decide. Storage is the
// same independent family as experiments/tasks/gates: schema 1, the store lock,
// atomic writes and `PREFIX-YYYYMMDD-NN` ids. `fingerprint` dedupes one question
// (kind + normalized text) across time; terminal states never mutate again —
// re-deciding creates a new record that supersedes the old one.

/** Decision record schema; independent of the store schema. */
export const DECISION_SCHEMA = 1
/** Every accepted status; only `open` is actionable. */
export const DECISION_STATUS = Object.freeze(['open', 'answered', 'withdrawn', 'superseded'])
/** Decision kinds. `approval` and `input` options are fixed by core. */
export const DECISION_KINDS = Object.freeze(['choice', 'approval', 'input'])
/** Escalation: pending this many turns in the asking session, or this many hours overall. */
export const DECISION_ESCALATE_TURNS = 3
export const DECISION_ESCALATE_HOURS = 24
/** `flow decision gc` keeps closed records this many days by default. */
export const DECISION_GC_DAYS = 90
/** Host reminder/panel detail cap (consumed by B/C waves). */
export const DECISION_REMIND_MAX = 3

const DECISION_ID_RE = /^[A-Z]+-\d{8}-\d{2}$/
const DECISION_OPTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/
const DECISION_QUESTION_MAX = 200
const DECISION_RATIONALE_MAX = 300
const DECISION_BY = ['user', 'agent']
const DECISION_APPROVAL_OPTIONS = Object.freeze([
  Object.freeze({ id: 'approve', label: '同意', impact: '批准该动作，可以继续执行' }),
  Object.freeze({ id: 'reject', label: '拒绝', impact: '拒绝该动作，停止推进' }),
])

/** A heartbeat older than six hours is flagged as possibly stopped (same rule as the panel). */
export const HEARTBEAT_STALE_SECONDS = 6 * 60 * 60

/** Heartbeat file schema; independent of the store schema. */
export const HEARTBEAT_SCHEMA = 1
/** Every accepted `status` value; only working/idle count as active. */
const HEARTBEAT_STATUS = ['working', 'idle', 'done', 'missed']
const HEARTBEAT_ACTIVE_STATUS = ['working', 'idle']
/** `updateHeartbeat` may only touch these keys. */
const HEARTBEAT_PATCH_KEYS = ['status', 'last_action', 'goal', 'task', 'claims', 'turn']
const HEARTBEAT_SESSION_MAX = 80
const HEARTBEAT_CLAIM_MAX = 200

/**
 * Absolute path of this package's CLI. Seeded gates run with the *project* root
 * as cwd, so a project-local `bin/flow.mjs` cannot be assumed.
 */
const PLUGIN_BIN = fileURLToPath(new URL('../bin/flow.mjs', import.meta.url))

const EXPERIMENT_DEFAULTS = {
  hypothesis: '',
  factor: '',
  parent: null,
  expected: '',
  scale: '',
  status: 'open',
  measured: '',
  metrics: {},
  commits: [],
  notes: '',
  // schema2 judging shape (camelCase per CONTRACT §3.1); empty here so reads of
  // older records stay shaped like today, while `addExperiment` rejects empties.
  direction: '',
  primaryMetric: '',
  guardrails: [],
  falsify: '',
  windowDays: null,
  stopLoss: '',
  learned: '',
  cleanup: { flags: [], code: [], data: [] },
  cleanupAt: null,
  productizedAt: null,
  productizeGate: null,
}

const TASK_DEFAULTS = {
  status: 'draft',
  /** Optional parent task id (`TASK parent`); null = root (T-13). */
  parent: null,
  owner: '',
  goal: '',
  scope: { allow: [], deny: [] },
  acceptance: [],
  checkpoints: [],
  commits: [],
  notes: '',
}

/**
 * Default for `tasks.archiveAfterDays`: `flow task archive` (and the seeded
 * `tasks-archive` precommit step) archives a `done` task whose `updated_at` is
 * at least this many days old. 0 disables the sweep.
 *
 * This constant is the single place the default changes: `defaultContract()`
 * carries it into a fresh manifest and `contractShapes()` falls back to it when
 * the key is missing, so a confirmed 0 = disabled decision is a one-line edit.
 */
export const TASK_ARCHIVE_AFTER_DAYS = 7

/** Ten years: the accepted ceiling for a configured or overridden archive window. */
const TASK_ARCHIVE_MAX_DAYS = 3650

/** One day in milliseconds (archive-window arithmetic). */
const DAY_MS = 86_400_000

// ------------------------------------------------------------------ errors

/** Stable error type; `code` is one of invalid|not-found|conflict|io|usage. */
export class FlowError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FlowError'
    this.code = code
  }
}

function invalid(message) {
  return new FlowError('invalid', message)
}

// ------------------------------------------------------------ tiny helpers

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = deepClone(item)
    return out
  }
  return value
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

/** Local time as `YYYY-MM-DDTHH:mm:ss+HH:MM` (no dependency on Intl). */
function formatIso(date = new Date()) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

function dateStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function timeValue(value) {
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function toPosix(value) {
  return String(value).split('\\').join('/')
}

const warningLog = []
const WARNING_CAP = 200

function noteWarning(message) {
  if (warningLog.length < WARNING_CAP) warningLog.push(String(message))
}

/**
 * Diagnostics collected by the last operations (stale-lock takeover, unknown
 * `expect` syntax, unreadable files). Not part of the public contract; the CLI
 * may surface it on stderr.
 */
export function drainWarnings() {
  return warningLog.splice(0, warningLog.length)
}

// ------------------------------------------------------- path containment
//
// Every path declared by the manifest (`store.root`, `experiments.dir`,
// `tasks.dir`, `gates.dir`, `gates.logs`, `tasks.current`, `heartbeats.dir`)
// must stay inside the project root. `resolve()`
// alone is not enough: an absolute value or `..` escapes lexically, and a
// symlink inside the root can point anywhere. Unsafe values never throw here;
// the caller degrades to its default and a warning names the key and raw value.

const UNSAFE_PATH_PREVIEW_MAX = 200

/** One-line, bounded preview of a rejected manifest value (never file content). */
function unsafePathPreview(value) {
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, UNSAFE_PATH_PREVIEW_MAX)
}

function noteUnsafeManifestPath(label, value, reason) {
  noteWarning(`manifest-path-rejected: ${label}: ${unsafePathPreview(value)}: ${reason}`)
}

/** `child` equals `parent` or sits below it, on the platform's case convention. */
function pathWithin(parent, child) {
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = fold(parent)
  const target = fold(child)
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * `realpathSync` through a request-scoped memo.
 *
 * The memo is a plain `Map` the caller creates for one request (HTTP handler,
 * TUI read) and passes down explicitly; it is deliberately never a module-level
 * cache, because a mount can appear or disappear between requests and a process
 * wide cache would answer with a stale location.
 *
 * The memo also remembers a failed resolution (the error, rethrown per lookup)
 * for the rest of that request: one read request must not re-walk the same
 * missing/absent ancestor — that is exactly the lost-mount cost this memo exists
 * to avoid. Only read-only request paths pass a memo, so nothing can create the
 * directory between two lookups of the same request.
 *
 * @param {string} path absolute path to resolve
 * @param {Map<string,string|Error>|undefined} memo request-scoped memo, or undefined
 * @returns {string} the real path
 */
function memoizedRealpath(path, memo) {
  if (memo === undefined) return realpathSync(path)
  const cached = memo.get(path)
  if (cached instanceof Error) throw cached
  if (cached !== undefined) return cached
  try {
    const real = realpathSync(path)
    memo.set(path, real)
    return real
  } catch (error) {
    const stored = error instanceof Error ? error : Object.assign(new Error(String(error)), { code: error?.code })
    memo.set(path, stored)
    throw stored
  }
}

/** The request-scoped realpath memo carried by an optional options bag. */
function pathMemoOf(options) {
  if (options === null || typeof options !== 'object') return undefined
  return options.pathMemo instanceof Map ? options.pathMemo : undefined
}

/**
 * Resolve every symlink on `target` and prove the final location is inside
 * `absRoot`. A target that does not exist yet is checked through its nearest
 * existing ancestor, so `link -> /etc` is rejected before anything is written
 * through it. A dangling symlink is treated as unsafe (a write would create the
 * file at its target).
 *
 * `memo` (optional) is the caller's per-request realpath memo: the same root and
 * the same target are then resolved at most once per request instead of once per
 * containment check.
 */
function realPathStaysInside(absRoot, target, memo) {
  let realRoot
  try {
    realRoot = memoizedRealpath(absRoot, memo)
  } catch {
    // The project root does not exist yet: only the lexical check is meaningful.
    return pathWithin(absRoot, target)
  }
  let current = target
  for (;;) {
    try {
      return pathWithin(realRoot, memoizedRealpath(current, memo))
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
 * Resolve one manifest-declared path and require it to stay inside `root`.
 *
 * Rules: a non-empty string is required; absolute input is rejected unless
 * `options.allowAbsolute` is set (only `store.root` may opt in, and only when
 * the real location is still inside the root); `..` escapes are rejected; an
 * existing target, or its nearest existing ancestor, is re-checked through
 * `realpath` so a symlink cannot lead outside.
 *
 * @param {string} root project root
 * @param {unknown} value raw manifest value
 * @param {string} label manifest key, used in the warning
 * @param {{allowAbsolute?: boolean, pathMemo?: Map<string,string|Error>}} [options]
 *   `pathMemo` is the caller's per-request realpath memo (see
 *   {@link memoizedRealpath}); omitted, every check calls `realpathSync` as before.
 * @returns {string|undefined} absolute in-root path, or undefined when unsafe
 */
export function containedPath(root, value, label, options = {}) {
  const absRoot = resolve(root)
  const name = typeof label === 'string' && label.trim() !== '' ? label.trim() : 'path'
  const allowAbsolute = options !== null && typeof options === 'object' && options.allowAbsolute === true
  const memo = pathMemoOf(options)
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const raw = value.trim()
  const target = isAbsolute(raw) ? resolve(raw) : resolve(absRoot, raw)
  if (isAbsolute(raw) && allowAbsolute !== true) {
    noteUnsafeManifestPath(name, raw, 'absolute paths are not allowed')
    return undefined
  }
  // Relative values are always lexical children; absolute `store.root` values
  // may still reach the root through its real path, so let realpath decide.
  if (pathWithin(absRoot, target) !== true && realPathStaysInside(absRoot, target, memo) !== true) {
    noteUnsafeManifestPath(name, raw, 'escapes the project root')
    return undefined
  }
  if (realPathStaysInside(absRoot, target, memo) !== true) {
    noteUnsafeManifestPath(name, raw, 'a symlink resolves outside the project root')
    return undefined
  }
  return target
}

/** Contained directory or the given in-root fallback when the value is absent/unsafe. */
function containedDir(absRoot, value, label, fallback, memo) {
  const contained = containedPath(absRoot, value, label, memo === undefined ? {} : { pathMemo: memo })
  return contained === undefined ? fallback : contained
}

// ------------------------------------------------------------- contract

/** Fresh schema-2 contract with every default filled in. */
function defaultContract(root) {
  return {
    schema: SCHEMA_VERSION,
    name: basename(resolve(root)),
    store: { root: STORE_REL },
    experiments: {
      source: 'store',
      dir: '.dsh/flow/experiments',
      /** Panel switch only (T-12): default closed; writes/checks keep working. */
      enabled: false,
    },
    tasks: {
      source: 'json',
      dir: '.dsh/flow/tasks',
      current: null,
      recentLimit: 6,
      archiveAfterDays: TASK_ARCHIVE_AFTER_DAYS,
    },
    gates: { dir: '.dsh/flow/gates', logs: '.dsh/flow/logs' },
    heartbeats: { source: 'json', dir: '.agents/heartbeat', max: 20 },
    decisions: { dir: '.dsh/flow/decisions' },
  }
}

/** JSON type name for `manifest-invalid` diagnostics (`array`/`null` included). */
function valueType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Section/member shapes: `[section, [[member, kind, fallback], …]]`; unknown keys pass through. */
function contractShapes(defaults) {
  return [
    ['store', [['root', 'string', defaults.store.root]]],
    ['experiments', [
      ['source', 'string', defaults.experiments.source],
      ['dir', 'string', defaults.experiments.dir],
      ['enabled', 'boolean', defaults.experiments.enabled],
    ]],
    ['tasks', [
      ['source', 'string', defaults.tasks.source],
      ['dir', 'string', defaults.tasks.dir],
      ['current', 'string|null', defaults.tasks.current],
      ['recentLimit', 'number', defaults.tasks.recentLimit],
      ['archiveAfterDays', 'number', defaults.tasks.archiveAfterDays],
    ]],
    ['gates', [
      ['dir', 'string', defaults.gates.dir],
      ['logs', 'string', defaults.gates.logs],
    ]],
    ['heartbeats', [
      ['source', 'string', defaults.heartbeats.source],
      ['dir', 'string', defaults.heartbeats.dir],
      ['max', 'number', defaults.heartbeats.max],
    ]],
    ['decisions', [['dir', 'string', defaults.decisions.dir]]],
  ]
}

function matchesContractKind(value, kind) {
  if (kind === 'string') return typeof value === 'string'
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (kind === 'boolean') return typeof value === 'boolean'
  if (kind === 'string|null') return value === null || typeof value === 'string'
  return false
}

/**
 * Type-check a contract and repair every invalid member with the schema-2
 * default. Idempotent and **never throws**: a malformed manifest must degrade to
 * a working store instead of taking the CLI down with a `TypeError`.
 *
 * The returned `issues` use the `manifest-invalid: <key>: expected <type>, got
 * <type>` shape, but nothing is recorded here: every store API normalizes its
 * contract on each call, so warning here would duplicate forever (and break the
 * `drainWarnings() === []` assertions). `loadContract` is the only warning
 * producer.
 *
 * Unknown keys — including the retired `runs` section — are preserved untouched
 * and never reported: forward compatibility beats strictness.
 *
 * @returns {{contract:object, issues:string[]}}
 */
function sanitizeContract(root, raw) {
  const absRoot = resolve(root)
  const defaults = defaultContract(absRoot)
  const issues = []
  if (!isPlainObject(raw)) return { contract: defaults, issues }

  const contract = deepClone(raw)
  const issue = (key, expected, value) => {
    issues.push(`manifest-invalid: ${key}: expected ${expected}, got ${valueType(value)}`)
  }

  if (contract.name !== undefined && (typeof contract.name !== 'string' || contract.name.trim() === '')) {
    issue('name', 'non-empty string', contract.name)
  }
  if (typeof contract.name !== 'string' || contract.name.trim() === '') contract.name = defaults.name

  for (const [section, fields] of contractShapes(defaults)) {
    const value = contract[section]
    // A missing/null section is a normal partial manifest: fill it silently.
    if (value === undefined || value === null) {
      contract[section] = deepClone(defaults[section])
      continue
    }
    if (!isPlainObject(value)) {
      issue(section, 'object', value)
      contract[section] = deepClone(defaults[section])
      continue
    }
    for (const [member, kind, fallback] of fields) {
      if (value[member] === undefined) {
        value[member] = deepClone(fallback)
        continue
      }
      if (matchesContractKind(value[member], kind)) continue
      issue(`${section}.${member}`, kind, value[member])
      value[member] = deepClone(fallback)
    }
  }

  // Empty path strings were always treated as "use the default" downstream;
  // normalize them here so the returned contract is self-consistent.
  if (typeof contract.store.root !== 'string' || contract.store.root.trim() === '') contract.store.root = STORE_REL
  contract.schema = SCHEMA_VERSION
  return { contract, issues }
}

/**
 * Fill defaults and repair invalid members into a (possibly partial) contract.
 * Silent by design — see {@link sanitizeContract} for the warning contract.
 */
function normalizeContract(root, contract) {
  return sanitizeContract(root, contract).contract
}

/**
 * Read `<root>/.dsh/flow/flow.json`.
 * @returns {{contract:object, source:string, warnings:string[]}}
 */
export function loadContract(root) {
  const absRoot = resolve(root)
  const warnings = []
  const file = join(absRoot, CONTRACT_REL)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { contract: defaultContract(absRoot), source: 'defaults', warnings }
    }
    warnings.push(`manifest-invalid: ${CONTRACT_REL}: ${error.message}`)
    return { contract: defaultContract(absRoot), source: 'defaults', warnings }
  }
  if (!isPlainObject(raw)) {
    warnings.push(`manifest-invalid: ${CONTRACT_REL}: not a JSON object`)
    return { contract: defaultContract(absRoot), source: 'defaults', warnings }
  }
  // Sanitize first (type repairs), then keep the historical `schema:` text as-is.
  const { contract, issues } = sanitizeContract(absRoot, raw)
  for (const issue of issues) warnings.push(issue)
  if (raw.schema !== undefined && raw.schema !== SCHEMA_VERSION) {
    warnings.push(`schema: ${raw.schema} (expected ${SCHEMA_VERSION})`)
  }
  return { contract, source: CONTRACT_REL, warnings }
}

/** Atomically write the contract (always schema 2, defaults filled in). */
export function saveContract(root, contract) {
  const absRoot = resolve(root)
  if (!isPlainObject(contract)) throw invalid('contract must be an object')
  const merged = normalizeContract(absRoot, contract)
  merged.schema = SCHEMA_VERSION
  withLock(absRoot, merged, () => writeJsonAtomic(join(absRoot, CONTRACT_REL), merged))
  return merged
}

function resolveDir(absRoot, value, label, fallbackName, store, memo) {
  const fallback = join(store, fallbackName)
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const resolved = containedDir(absRoot, value, label, fallback, memo)
  // A stock section dir follows a custom store root instead of pinning the old path.
  const stock = resolve(absRoot, STORE_REL, fallbackName)
  const customStore = resolve(absRoot, STORE_REL) !== store
  if (customStore && resolved === stock) return join(store, fallbackName)
  return resolved
}

/**
 * Absolute store directories for one contract.
 *
 * @param {string} root project root
 * @param {object} contract flow contract
 * @param {{pathMemo?: Map<string,string|Error>}} [options] per-request realpath memo;
 *   omitted, the containment checks resolve every path again (CLI/tool behavior).
 */
export function storePaths(root, contract, options = {}) {
  const absRoot = resolve(root)
  const memo = pathMemoOf(options)
  const c = normalizeContract(absRoot, contract)
  const storeValue = c.store && typeof c.store.root === 'string' && c.store.root.trim() !== '' ? c.store.root : STORE_REL
  const storeFallback = join(absRoot, STORE_REL)
  // Absolute `store.root` is tolerated only while it still resolves inside the
  // project root; anything else (including `..` and symlink escapes) falls back.
  const store = containedPath(absRoot, storeValue, 'store.root', { allowAbsolute: true, pathMemo: memo }) ?? storeFallback
  return {
    store,
    experiments: resolveDir(absRoot, c.experiments && c.experiments.dir, 'experiments.dir', 'experiments', store, memo),
    tasks: resolveDir(absRoot, c.tasks && c.tasks.dir, 'tasks.dir', 'tasks', store, memo),
    gates: resolveDir(absRoot, c.gates && c.gates.dir, 'gates.dir', 'gates', store, memo),
    logs: resolveDir(absRoot, c.gates && c.gates.logs, 'gates.logs', 'logs', store, memo),
    decisions: resolveDir(absRoot, c.decisions && c.decisions.dir, 'decisions.dir', 'decisions', store, memo),
  }
}

function assertInitialized(root) {
  const absRoot = resolve(root)
  if (!existsSync(join(absRoot, CONTRACT_REL))) {
    throw new FlowError('usage', 'run flow init first (.dsh/flow/flow.json is missing)')
  }
}

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw new FlowError('io', `cannot create ${toPosix(dir)}: ${error.message}`)
  }
}

/** Create the store layout and contract. */
export function initProject(root, options = {}) {
  const absRoot = resolve(root)
  const warnings = []
  const created = []
  ensureDir(absRoot)

  const contractFile = join(absRoot, CONTRACT_REL)
  const alreadyExists = existsSync(contractFile)
  const requestedName = typeof options.name === 'string' && options.name.trim() !== '' ? options.name.trim() : null

  let contract
  if (alreadyExists && options.force !== true) {
    contract = loadContract(absRoot).contract
    warnings.push(`already-initialized: ${CONTRACT_REL} (use force to rewrite)`)
  } else {
    contract = defaultContract(absRoot)
    if (requestedName !== null) contract.name = requestedName
    ensureDir(dirname(contractFile))
    writeJsonAtomic(contractFile, contract)
    created.push(CONTRACT_REL)
  }

  const paths = storePaths(absRoot, contract)
  for (const dir of [paths.experiments, paths.tasks, paths.gates, paths.logs, paths.decisions]) ensureDir(dir)

  // Bootstrap gates only help an empty gates directory; seeding is best-effort
  // and never fails the init itself (every failure becomes a warning).
  let seededGates = []
  if (options.noGates !== true) {
    try {
      seededGates = seedDefaultGates(absRoot, contract, warnings)
    } catch (error) {
      warnings.push(`default-gate-failed: seed: ${error?.message ?? String(error)}`)
    }
  }


  return { root: absRoot, created, warnings, seededGates }
}

// ------------------------------------------------------ default gate seeds

/**
 * The gates `flow init` seeds into an empty gates directory. Steps that call
 * this plugin use the runtime-resolved absolute CLI path because a gate runs
 * with the project root as cwd (which need not contain `bin/flow.mjs`).
 */
function defaultGateSeeds() {
  const cli = `"${PLUGIN_BIN}"`
  return [
    {
      id: 'session-open',
      title: '会话心跳检查',
      phase: 'manual',
      enabled: true,
      steps: [{ id: 'heartbeat', run: `${cli} heartbeat status --require-active`, expect: 'exit 0' }],
    },
    {
      id: 'precommit',
      title: '提交前暂存区检查',
      phase: 'commit',
      enabled: true,
      steps: [
        { id: 'whitespace', run: 'git diff --cached --check', expect: 'exit 0' },
        { id: 'decisions', run: `${cli} check decisions`, expect: 'exit 0' },
        // Explicit sweep, not a read-path side effect: a commit is the natural
        // point to retire finished tasks. `--json` is for programmatic callers.
        { id: 'tasks-archive', run: `${cli} task archive`, expect: 'exit 0' },
      ],
    },
    {
      id: 'tests',
      title: '单元测试（默认关闭，按项目自填命令）',
      phase: 'commit',
      enabled: false,
      steps: [{ id: 'unit', run: 'node --test test/', expect: 'exit 0' }],
    },
    {
      id: 'staged-files',
      title: '暂存文件归属检查（占位，需项目自填 --allow 路径）',
      phase: 'commit',
      enabled: false,
      steps: [{ id: 'staged', run: `${cli} check staged --allow src`, expect: 'exit 0' }],
    },
    {
      id: 'release',
      title: '发布基线检查（占位，需项目自填 --marker）',
      phase: 'release',
      enabled: false,
      steps: [
        { id: 'baseline', run: `${cli} check release-baseline --marker RELEASE`, expect: 'exit 0' },
        { id: 'experiments', run: `${cli} check experiments`, expect: 'exit 0' },
      ],
    },
  ]
}

/**
 * Seed the default gates when the gates directory holds no gate yet.
 * Idempotent: any existing gate skips seeding entirely. Every failure only
 * appends a warning, so `flow init` never fails because of a seed.
 */
function seedDefaultGates(absRoot, contract, warnings) {
  const paths = storePaths(absRoot, contract)
  let names
  try {
    names = readdirSync(paths.gates)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new FlowError('io', `cannot read ${toPosix(paths.gates)}: ${error.message}`)
  }
  // "empty" means no gate file at all, readable or not.
  if (names.some((name) => name.toLowerCase().endsWith('.json'))) return []
  const existing = gateIds(paths)
  const seeded = []
  for (const input of defaultGateSeeds()) {
    try {
      const record = buildGate(input, { existingIds: existing })
      writeJsonAtomic(join(paths.gates, `${record.id}.json`), record)
      existing.add(record.id)
      seeded.push(record.id)
    } catch (error) {
      warnings.push(`default-gate-failed: ${input.id ?? '?'}: ${error?.message ?? String(error)}`)
    }
  }
  return seeded
}

// -------------------------------------------------- atomic write and lock

let tempSeq = 0

/** Block the current thread without spinning (`Atomics.wait` is the zero-dep sleep). */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms)
}

/**
 * rename with a bounded backoff for the transient codes a file share lock or an
 * AV scanner produces on Windows (`EPERM`/`EBUSY`/`EACCES`). Every other error
 * (ENOTDIR, EXDEV, …) fails on the first attempt. Exhausted retries raise
 * `FlowError('io')` carrying the historical `cannot write <to>` prefix.
 *
 * Non-contract API: exported only so tests can inject `{renameImpl, sleepImpl,
 * delays}`; `writeJsonAtomic` is the single production caller.
 */
export function renameWithRetrySync(from, to, options = {}) {
  const renameImpl = typeof options.renameImpl === 'function' ? options.renameImpl : renameSync
  const sleepImpl = typeof options.sleepImpl === 'function' ? options.sleepImpl : sleepSync
  const delays = Array.isArray(options.delays) && options.delays.length > 0 ? options.delays : RENAME_RETRY_DELAYS_MS
  const attempts = delays.length + 1
  let last
  for (let index = 0; index < attempts; index += 1) {
    try {
      renameImpl(from, to)
      return
    } catch (error) {
      last = error
      const code = error !== null && error !== undefined ? error.code : undefined
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      if (index === attempts - 1) break
      sleepImpl(delays[Math.min(index, delays.length - 1)])
    }
  }
  throw new FlowError('io', `cannot write ${toPosix(to)}: ${last?.message ?? String(last)}`)
}

/**
 * fsync the parent directory so the rename itself is durable. Best effort only:
 * `/mnt/d` (ntfs3/DrvFs) rejects directory fsync with `EINVAL`, and a failed
 * directory sync must never fail a write that already succeeded.
 */
function fsyncDirBestEffort(dir) {
  let fd
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // Unsupported on this filesystem (or a racing rmdir): durability only.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

/**
 * write temp file + fsync + rename; on failure remove the temp file and raise io.
 * The fsync happens before the rename, so a crash exposes either the old file or
 * a complete new one — never a half-written record.
 */
function writeJsonAtomic(file, data) {
  ensureDir(dirname(file))
  const temp = join(dirname(file), `${basename(file)}.tmp-${process.pid}-${tempSeq++}`)
  let fd
  try {
    fd = openSync(temp, 'wx')
    writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`)
    fsyncSync(fd)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore: the write already failed
      }
    }
    try {
      unlinkSync(temp)
    } catch {
      // nothing to clean up
    }
    if (error instanceof FlowError) throw error
    throw new FlowError('io', `cannot write ${toPosix(file)}: ${error.message}`)
  }
  try {
    closeSync(fd)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // nothing to clean up
    }
    throw new FlowError('io', `cannot write ${toPosix(file)}: ${error.message}`)
  }
  try {
    renameWithRetrySync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // nothing to clean up
    }
    if (error instanceof FlowError) throw error
    throw new FlowError('io', `cannot write ${toPosix(file)}: ${error.message}`)
  }
  fsyncDirBestEffort(dirname(file))
}

// ---------------------------------------------------------------- lock

/**
 * `host` tag for the lock: hostname alone is not enough, WSL and Windows share a
 * hostname but not a PID namespace (`kill(pid, 0)` would test the wrong table).
 */
function hostTag() {
  return `${hostname()}|${process.platform}`
}

/**
 * Read the lock as it is *now*: `{text, parsed, mtimeMs}` where `parsed` is null
 * for garbage, or `null` when the file is gone. An unreadable lock (EACCES) is
 * reported with `text: null` and the stat mtime so callers age it but never
 * mistake it for their own.
 */
function readLockSnapshot(lockPath) {
  let text
  try {
    text = readFileSync(lockPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    let mtimeMs
    try {
      mtimeMs = statSync(lockPath).mtimeMs
    } catch {
      mtimeMs = Date.now()
    }
    return { text: null, parsed: null, mtimeMs, unreadable: true }
  }
  let parsed = null
  try {
    const value = JSON.parse(text)
    if (isPlainObject(value)) parsed = value
  } catch {
    // garbage is a valid observation: it simply has no owner fields
  }
  let mtimeMs
  try {
    mtimeMs = statSync(lockPath).mtimeMs
  } catch {
    mtimeMs = Date.now()
  }
  return { text, parsed, mtimeMs, unreadable: false }
}

/** Age of a lock: the owner-declared `at` wins, mtime is the fallback. */
function lockAgeMs(snapshot, now = Date.now()) {
  if (snapshot === null) return 0
  const parsed = snapshot.parsed
  if (isPlainObject(parsed) && typeof parsed.at === 'string') {
    const at = Date.parse(parsed.at)
    if (Number.isFinite(at)) return now - at
  }
  return now - snapshot.mtimeMs
}

const LOCK_ALIVE = 'alive'
const LOCK_DEAD = 'dead'
const LOCK_FOREIGN = 'foreign'
const LOCK_UNKNOWN = 'unknown'

/**
 * Liveness matrix for a lock snapshot.
 * - different `host` → FOREIGN and `process.kill` is **not** called (another PID namespace);
 * - usable pid: `kill(pid, 0)` returns → ALIVE; EPERM → ALIVE (exists, no rights);
 *   ESRCH → DEAD; any other errno → ALIVE (conservative: never steal on doubt);
 * - missing host (old lock shape) is treated as the same machine, so the pid decides;
 * - missing/invalid pid → UNKNOWN (age decides, with the foreign grace window).
 */
function lockLiveness(snapshot) {
  const parsed = snapshot?.parsed
  if (!isPlainObject(parsed)) return { state: LOCK_UNKNOWN, pid: null, host: null }
  const pid = Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null
  const host = typeof parsed.host === 'string' && parsed.host.trim() !== '' ? parsed.host : null
  if (host !== null && host !== hostTag()) return { state: LOCK_FOREIGN, pid, host }
  if (pid === null) return { state: LOCK_UNKNOWN, pid: null, host }
  try {
    process.kill(pid, 0)
    return { state: LOCK_ALIVE, pid, host }
  } catch (error) {
    if (error?.code === 'ESRCH') return { state: LOCK_DEAD, pid, host }
    return { state: LOCK_ALIVE, pid, host }
  }
}

/** One `conflict` error shape: who holds it, since when, and how to resolve it by hand. */
function lockConflict(shownPath, snapshot, age) {
  const parsed = snapshot?.parsed ?? {}
  const pid = Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : 'unknown'
  const host = typeof parsed.host === 'string' && parsed.host.trim() !== '' ? parsed.host : 'unknown host'
  const since =
    typeof parsed.at === 'string' && Number.isFinite(Date.parse(parsed.at))
      ? parsed.at
      : new Date(snapshot?.mtimeMs ?? Date.now()).toISOString()
  return new FlowError(
    'conflict',
    `store is locked by another writer (${shownPath}): pid ${pid} on ${host} since ${since} (age ${Math.round(age / 1000)}s); ` +
      `if that process is gone, remove ${shownPath}`,
  )
}

/**
 * Put a lock we moved aside back at `targetPath` **without clobbering** whatever
 * is there now. `link()` is the atomic no-clobber primitive: `rename()` would
 * silently overwrite a third party's brand-new lock. If the target reappeared we
 * leave both files alone and warn; the sweeper removes the leftover later.
 */
function restoreMovedLock(movedPath, targetPath, label = 'lock-restore') {
  const shownTarget = toPosix(targetPath)
  const shownMoved = toPosix(movedPath)
  if (existsSync(targetPath)) {
    noteWarning(`${label}-skipped: ${shownTarget} was recreated by another writer; left ${shownMoved}`)
    return
  }
  try {
    linkSync(movedPath, targetPath)
  } catch (error) {
    noteWarning(`${label}-skipped: cannot link ${shownMoved} back to ${shownTarget}: ${error.message}`)
    return
  }
  try {
    unlinkSync(movedPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') noteWarning(`${label}-failed: ${shownMoved}: ${error.message}`)
  }
}

/** `open(wx)` the lock and write our ownership record. Returns false when it already exists. */
function createLockFile(lockPath, me) {
  let fd
  try {
    fd = openSync(lockPath, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw new FlowError('io', `cannot create ${toPosix(lockPath)}: ${error.message}`)
  }
  try {
    writeFileSync(fd, JSON.stringify(me))
    closeSync(fd)
    return true
  } catch (error) {
    try {
      closeSync(fd)
    } catch {
      // ignore: the write already failed
    }
    // A zero-byte lock would block everyone for a full stale window: remove ours.
    try {
      unlinkSync(lockPath)
    } catch {
      // someone already replaced it
    }
    throw new FlowError('io', `cannot create ${toPosix(lockPath)}: ${error.message}`)
  }
}

/**
 * The takeover claim: a second, short-lived `open(wx)` mutex that serializes
 * *stale-lock takeover decisions only*. Without it two takers can both decide
 * from the same stale snapshot and one of them moves the other's brand-new lock
 * aside — opening a window where a third process creates a lock and two writers
 * enter the critical section together (observed as duplicate ids). The claim is
 * held for a few filesystem calls (microseconds) and never for user work.
 */
const TAKEOVER_CLAIM_SUFFIX = '.takeover-claim'
const TAKEOVER_CLAIM_ATTEMPTS = 50
const TAKEOVER_CLAIM_SLEEP_MS = 1

function takeoverClaimPath(lockPath) {
  return `${lockPath}${TAKEOVER_CLAIM_SUFFIX}`
}

/**
 * Remove a claim we believe is dead (or a zombie) with a CAS, mirroring the
 * stale-lock takeover: rename it aside, prove the moved bytes are the bytes we
 * inspected, then unlink. If a newer claim appeared in the window, put the moved
 * copy back with `link()` (atomic no-clobber) — never delete another taker's
 * fresh claim. The moved copy is named `…takeover-claim.tmp-<pid>-<seq>`, which
 * the stale-temp sweeper cleans if this process dies mid-recovery.
 *
 * @returns {boolean} true when this process removed the claim
 */
function recoverTakeoverClaim(claimPath, snapshot, age, zombie) {
  const shownClaim = toPosix(claimPath)
  const recoveredPath = `${claimPath}.tmp-${process.pid}-${tempSeq++}`
  try {
    renameSync(claimPath, recoveredPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return false // another taker recovered/removed it
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EBUSY') {
      sleepSync(RENAME_RETRY_DELAYS_MS[0])
      return false
    }
    noteWarning(`lock-claim-recovery-failed: ${shownClaim}: ${error.message}`)
    return false
  }
  const moved = readLockSnapshot(recoveredPath)
  const sameInodeContent =
    moved !== null && (moved.text !== null ? moved.text === snapshot.text : moved.mtimeMs === snapshot.mtimeMs)
  if (!sameInodeContent) {
    // A newer claim replaced the dead one in the window: restore it no-clobber.
    restoreMovedLock(recoveredPath, claimPath, 'lock-claim-restore')
    return false
  }
  try {
    unlinkSync(recoveredPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      noteWarning(`lock-claim-recovery-failed: ${toPosix(recoveredPath)}: ${error.message}`)
    }
  }
  if (zombie === true) {
    noteWarning(`lock-claim-stale: recovered ${shownClaim} after ${Math.round(age / 1000)}s`)
  }
  return true
}

/**
 * The takeover-claim conflict message: who holds it, since when, and how to
 * clear a zombie by hand (a reused pid must not block every writer forever).
 */
function claimConflict(claimPath) {
  const shownClaim = toPosix(claimPath)
  const snapshot = readLockSnapshot(claimPath)
  if (snapshot === null) {
    return new FlowError('conflict', `store takeover is already in progress (${shownClaim}); retry later`)
  }
  const parsed = snapshot.parsed ?? {}
  const pid = Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : 'unknown'
  const host = typeof parsed.host === 'string' && parsed.host.trim() !== '' ? parsed.host : 'unknown host'
  const since =
    typeof parsed.at === 'string' && Number.isFinite(Date.parse(parsed.at))
      ? parsed.at
      : new Date(snapshot.mtimeMs).toISOString()
  return new FlowError(
    'conflict',
    `store takeover is already in progress (${shownClaim}): pid ${pid} on ${host} since ${since} (age ${Math.round(lockAgeMs(snapshot) / 1000)}s); ` +
      `retry later, or if no takeover is running, remove ${shownClaim}`,
  )
}

/**
 * Win the takeover mutex. Returns true when this process may inspect-and-remove
 * the stale lock. A claim whose owner is provably dead is recovered (a crashed
 * taker must not brick the store); a claim that still looks alive after ten
 * minutes is treated as a zombie (the critical section lasts microseconds, so
 * this is a SIGSTOPped process or a reused pid) and recovered as well. Every
 * recovery goes through the CAS in {@link recoverTakeoverClaim}.
 */
function acquireTakeoverClaim(claimPath) {
  const me = { schema: 1, pid: process.pid, host: hostTag(), at: new Date().toISOString(), token: randomUUID() }
  for (let attempt = 0; attempt < TAKEOVER_CLAIM_ATTEMPTS; attempt += 1) {
    let created = false
    try {
      const fd = openSync(claimPath, 'wx')
      created = true
      try {
        writeFileSync(fd, JSON.stringify(me))
      } finally {
        closeSync(fd)
      }
      return me.token
    } catch (error) {
      if (created) {
        // A half-written claim would block every other taker: remove ours.
        try {
          unlinkSync(claimPath)
        } catch {
          // someone already replaced it
        }
        throw new FlowError('io', `cannot create ${toPosix(claimPath)}: ${error.message}`)
      }
      if (error?.code !== 'EEXIST') throw new FlowError('io', `cannot create ${toPosix(claimPath)}: ${error.message}`)
    }
    const snapshot = readLockSnapshot(claimPath)
    if (snapshot === null) continue // released between our open and read: try again
    const live = lockLiveness(snapshot)
    const age = lockAgeMs(snapshot)
    const crashed = live.state === LOCK_DEAD || (live.state === LOCK_UNKNOWN && age > FOREIGN_STALE_MS)
    const zombie = (live.state === LOCK_ALIVE || live.state === LOCK_FOREIGN) && age > STALE_TMP_MS
    if (crashed || zombie) {
      recoverTakeoverClaim(claimPath, snapshot, age, zombie)
      continue
    }
    sleepSync(TAKEOVER_CLAIM_SLEEP_MS)
  }
  return null
}

/**
 * Release a claim only when this process still owns it (token + pid match).
 * Never throws: it runs from `finally`.
 *
 * This is the same invariant as {@link releaseLock}: a taker that was SIGSTOPped
 * inside the claim window can have its claim recovered as a zombie and replaced
 * by another taker before it resumes. Deleting that new claim would leave two
 * claim holders and break takeover serialization.
 *
 * Non-contract API: exported so tests can drive the ownership check directly.
 */
export function releaseTakeoverClaim(claimPath, token) {
  const shownClaim = toPosix(claimPath)
  try {
    const snapshot = readLockSnapshot(claimPath)
    if (snapshot === null) return
    const owner = snapshot.parsed
    if (!isPlainObject(owner) || owner.token !== token || owner.pid !== process.pid) {
      noteWarning(
        `lock-claim-release-skipped: ${shownClaim} is held by pid ${owner?.pid ?? '?'} (this process is ${process.pid}); left in place`,
      )
      return
    }
    try {
      unlinkSync(claimPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') noteWarning(`lock-claim-release-failed: ${shownClaim}: ${error.message}`)
    }
  } catch (error) {
    noteWarning(`lock-claim-release-skipped: ${shownClaim}: ${error?.message ?? String(error)}`)
  }
}

/**
 * Acquire `<store>/.lock` and return our ownership token.
 *
 * The lock JSON is `{schema, pid, host, at, token}`. A stale lock is only taken
 * over while holding the short-lived takeover claim, and the decision is
 * re-validated after winning it: rename the stale file aside, prove the moved
 * bytes are the bytes we inspected, re-check liveness, then create our lock
 * *before* deleting the moved copy. The final entry into the critical section is
 * always an exclusive `open(wx)`, so at most one writer gets in — even when
 * several processes race to take over the same stale lock.
 */
function acquireLock(lockPath) {
  const me = {
    schema: 1,
    pid: process.pid,
    host: hostTag(),
    at: new Date().toISOString(),
    token: randomUUID(),
  }
  const shownPath = toPosix(lockPath)
  const claimPath = takeoverClaimPath(lockPath)
  for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt += 1) {
    if (createLockFile(lockPath, me)) return me.token

    // Cheap pre-check without the claim: fresh locks and live owners conflict immediately.
    const quick = readLockSnapshot(lockPath)
    // Released between our failed open and the read: retry the exclusive create.
    if (quick === null) continue
    const quickAge = lockAgeMs(quick)
    if (quickAge <= LOCK_STALE_MS) throw lockConflict(shownPath, quick, quickAge)
    const quickLive = lockLiveness(quick)
    if (quickLive.state === LOCK_ALIVE) throw lockConflict(shownPath, quick, quickAge)
    if ((quickLive.state === LOCK_FOREIGN || quickLive.state === LOCK_UNKNOWN) && quickAge < FOREIGN_STALE_MS) {
      throw lockConflict(shownPath, quick, quickAge)
    }

    const claimToken = acquireTakeoverClaim(claimPath)
    if (claimToken === null) throw claimConflict(claimPath)
    try {
      // Re-validate under the claim: the snapshot above may be another taker's
      // race loser, and acting on it could move a live writer's new lock.
      const snapshot = readLockSnapshot(lockPath)
      if (snapshot === null) continue
      const age = lockAgeMs(snapshot)
      if (age <= LOCK_STALE_MS) throw lockConflict(shownPath, snapshot, age)
      const live = lockLiveness(snapshot)
      if (live.state === LOCK_ALIVE) throw lockConflict(shownPath, snapshot, age)
      if ((live.state === LOCK_FOREIGN || live.state === LOCK_UNKNOWN) && age < FOREIGN_STALE_MS) {
        throw lockConflict(shownPath, snapshot, age)
      }

      // F10: the claim may have been recovered as a zombie while this process
      // was suspended between re-validation and the destructive rename. Prove we
      // still own it one syscall before the move; if not, abandon (the finally
      // release will see the other taker's token and refuse to delete it).
      const heldClaim = readLockSnapshot(claimPath)
      if (
        heldClaim === null ||
        isPlainObject(heldClaim.parsed) === false ||
        heldClaim.parsed.token !== claimToken ||
        heldClaim.parsed.pid !== process.pid
      ) {
        continue
      }

      const takeoverPath = `${lockPath}.takeover-${process.pid}-${randomUUID().replace(/-/g, '').slice(0, 6)}`
      try {
        renameSync(lockPath, takeoverPath)
      } catch (error) {
        if (error?.code === 'ENOENT') continue // released while we held the claim
        if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EBUSY') {
          sleepSync(RENAME_RETRY_DELAYS_MS[Math.min(attempt - 1, RENAME_RETRY_DELAYS_MS.length - 1)])
          continue
        }
        throw new FlowError('io', `cannot move stale lock ${shownPath}: ${error.message}`)
      }

      const moved = readLockSnapshot(takeoverPath)
      // Same bytes (mtime proves it for unreadable locks) or somebody replaced the
      // lock between our read and the rename: then never touch it again.
      const sameInodeContent =
        moved !== null && (moved.text !== null ? moved.text === snapshot.text : moved.mtimeMs === snapshot.mtimeMs)
      if (!sameInodeContent) {
        // Defense in depth: with the takeover claim held, no same-machine taker
        // can replace the lock between our read and this rename, so this branch
        // is unreachable for an all-new-core fleet. It still guards a foreign
        // host or an old-core writer that ignores the claim: put the moved lock
        // back no-clobber instead of deleting a newer owner's lock.
        restoreMovedLock(takeoverPath, lockPath)
        noteWarning(`lock-cas-raced: ${shownPath} changed while taking over; moved a newer lock and restored it`)
        continue
      }
      if (lockLiveness(moved).state === LOCK_ALIVE) {
        restoreMovedLock(takeoverPath, lockPath)
        throw lockConflict(shownPath, moved, lockAgeMs(moved))
      }
      noteWarning(
        `lock-stale: took over ${shownPath} after ${Math.round(age / 1000)}s (pid ${live.pid ?? '?'}, host ${live.host ?? 'unknown'})`,
      )
      // Install our lock while the moved copy still documents the takeover window;
      // a direct creator may still win the exclusive create, in which case we lose.
      if (!createLockFile(lockPath, me)) {
        try {
          unlinkSync(takeoverPath)
        } catch {
          // swept later
        }
        continue
      }
      try {
        unlinkSync(takeoverPath)
      } catch (error) {
        if (error?.code !== 'ENOENT') noteWarning(`lock-takeover-cleanup-failed: ${toPosix(takeoverPath)}: ${error.message}`)
      }
      return me.token
    } finally {
      releaseTakeoverClaim(claimPath, claimToken)
    }
  }
  throw new FlowError('conflict', `cannot acquire store lock (${shownPath})`)
}

/**
 * Release only a lock this very process created (token + pid match). Never
 * throws: it runs from `finally`, where a throw would mask the real error.
 */
function releaseLock(lockPath, token) {
  const shownPath = toPosix(lockPath)
  try {
    const snapshot = readLockSnapshot(lockPath)
    if (snapshot === null) return
    const owner = snapshot.parsed
    if (!isPlainObject(owner)) {
      noteWarning(`lock-release-skipped: ${shownPath} is unreadable; left in place`)
      return
    }
    if (owner.token !== token || owner.pid !== process.pid) {
      noteWarning(
        `lock-release-skipped: ${shownPath} is held by pid ${owner.pid ?? '?'} (this process is ${process.pid}); left in place`,
      )
      return
    }
    try {
      unlinkSync(lockPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') noteWarning(`lock-release-failed: ${shownPath}: ${error.message}`)
    }
  } catch (error) {
    noteWarning(`lock-release-skipped: ${shownPath}: ${error?.message ?? String(error)}`)
  }
}

/**
 * Remove temp/takeover leftovers older than {@link STALE_TMP_MS}. Only files
 * whose name matches our internal patterns are touched — never a `.json`, the
 * `.lock` or an unknown name — and every unlink failure is swallowed per file.
 * Throttled per store root so a busy CLI does not rescan on every write.
 */
const lastSweepAt = new Map()

function sweepStaleTemps(paths) {
  const now = Date.now()
  const key = paths.store
  if (now - (lastSweepAt.get(key) ?? 0) < STALE_TMP_MS) return
  lastSweepAt.set(key, now)
  let removed = 0
  for (const dir of new Set([paths.store, paths.experiments, paths.tasks, paths.gates, paths.logs, paths.decisions])) {
    if (typeof dir === 'string' && dir !== '') removed += sweepStaleTempsIn(dir, now, 0)
  }
  if (removed > 0) noteWarning(`stale-temp-cleaned: ${removed}`)
}

function sweepStaleTempsIn(dir, now, depth) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0 // unreadable/absent directory: nothing to clean
  }
  let removed = 0
  for (const entry of entries) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth === 0) removed += sweepStaleTempsIn(file, now, 1)
      continue
    }
    if (!TMP_NAME_RE.test(entry.name) && !LOCK_TAKEOVER_RE.test(entry.name)) continue
    try {
      const stat = lstatSync(file)
      if (stat.isDirectory()) continue
      if (now - stat.mtimeMs < STALE_TMP_MS) continue
      unlinkSync(file)
      removed += 1
    } catch {
      // best effort: a file we cannot remove is retried on the next sweep
    }
  }
  return removed
}

/**
 * Run `fn(paths)` while holding `<store>/.lock`.
 *
 * `fn` must be synchronous: the lock is an advisory file lock, not a
 * re-entrant mutex, and every store operation in this module is synchronous.
 *
 * Non-contract API: exported so tests can drive the lock protocol directly.
 */
export function withLock(root, contract, fn) {
  const paths = storePaths(root, contract)
  ensureDir(paths.store)
  const lockPath = join(paths.store, LOCK_FILE)
  const token = acquireLock(lockPath)
  try {
    sweepStaleTemps(paths)
    return fn(paths)
  } finally {
    releaseLock(lockPath, token)
  }
}

// ------------------------------------------------------- storage helpers

/**
 * Read every `<id>.json` record under `dir`. Unreadable records are skipped and
 * reported once as `unreadable:`. Pass `issues` (an array) to also collect their
 * absolute paths, so callers can count them instead of letting a broken file
 * silently disappear from the totals.
 */
function readCollection(dir, issues) {
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new FlowError('io', `cannot read ${toPosix(dir)}: ${error.message}`)
  }
  const items = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!isPlainObject(parsed)) throw new Error('record is not a JSON object')
      items.push({ file, name, record: parsed })
    } catch (error) {
      noteWarning(`unreadable: ${toPosix(file)}: ${error.message}`)
      if (Array.isArray(issues)) issues.push(file)
    }
  }
  return items
}

/** `options.unreadable` collector from an optional list-call argument. */
function unreadableCollector(options) {
  return isPlainObject(options) && Array.isArray(options.unreadable) ? options.unreadable : undefined
}

/**
 * Refuse to write a record whose target file already exists. The file may be a
 * record we could not parse (hand-edited or truncated); overwriting it would
 * destroy the only copy and silently reuse its id. `nextId` skips readable ids,
 * so this guard fires for unreadable/foreign files and explicit `--id` requests.
 *
 * A directory at the target path is deliberately *not* a conflict: it cannot be
 * a record, and the atomic write already fails it with `io`/`cannot write`.
 */
function assertTargetFree(dir, id) {
  const file = join(dir, `${id}.json`)
  let occupiedByDirectory = false
  try {
    occupiedByDirectory = lstatSync(file).isDirectory()
  } catch (error) {
    if (error?.code === 'ENOENT') return
    // Unreadable metadata: treat it as occupied rather than clobbering a file.
  }
  if (occupiedByDirectory) return
  throw new FlowError(
    'conflict',
    `record id ${id} is already occupied by ${toPosix(resolve(file))} (possibly unreadable); fix or remove that file, then retry`,
  )
}

function assertSafeId(id, label = 'id') {
  if (typeof id !== 'string' || id.length === 0) throw invalid(`${label} must be a non-empty string`)
  if (id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw invalid(`${label} is not a safe path segment: ${id}`)
  }
  return id
}

function readRecord(dir, id, kind) {
  assertSafeId(id)
  const file = join(dir, `${id}.json`)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new FlowError('not-found', `${kind} ${id} not found`)
    throw new FlowError('io', `cannot read ${toPosix(file)}: ${error.message}`)
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) throw new Error('record is not a JSON object')
    return parsed
  } catch (error) {
    throw new FlowError('io', `invalid ${kind} record ${toPosix(file)}: ${error.message}`)
  }
}

function sortByUpdatedDesc(records) {
  return records.sort((left, right) => {
    const delta = timeValue(right.updated_at) - timeValue(left.updated_at)
    if (delta !== 0) return delta
    return String(right.id ?? '').localeCompare(String(left.id ?? ''))
  })
}

/**
 * Oldest-created first (FIFO queue / claim order). A record whose `created_at`
 * is missing or unparseable sorts last — an unknown age must not jump the queue —
 * and the id orders ties deterministically.
 */
function sortByCreatedAsc(records) {
  const createdAt = (record) => {
    const parsed = Date.parse(isPlainObject(record) && typeof record.created_at === 'string' ? record.created_at : '')
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

function nextId(prefix, existingIds, date = new Date()) {
  const stamp = dateStamp(date)
  const pattern = new RegExp(`^${prefix}-${stamp}-(\\d{2})$`)
  let max = 0
  for (const id of existingIds) {
    if (typeof id !== 'string') continue
    const match = pattern.exec(id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  for (let index = max + 1; index <= 99; index += 1) {
    const candidate = `${prefix}-${stamp}-${pad(index)}`
    if (!existingIds.has(candidate)) return candidate
  }
  throw new FlowError('conflict', `no free ${prefix} id left for ${stamp}`)
}

function assertPattern(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw invalid(`${label} has an invalid format: ${JSON.stringify(value)}`)
  }
  return value
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalText(value, label, fallback = '') {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw invalid(`${label} must be a string`)
  return value
}

function optionalBoolean(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw invalid(`${label} must be a boolean`)
  return value
}

function optionalEnum(value, label, allowed, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(`${label} must be one of ${allowed.join(', ')}`)
  }
  return value
}

function optionalInt(value, label, fallback, min) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw invalid(`${label} must be an integer >= ${min}`)
  }
  return value
}

function stringArray(value, label, fallback = []) {
  if (value === undefined || value === null) return fallback
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalid(`${label} must be an array of strings`)
  }
  return value.slice()
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  if (!GATE_ID_RE.test(slug)) throw invalid(`cannot derive a gate id from ${JSON.stringify(value)}; pass an explicit id`)
  return slug
}

function statusCounts(items, statuses) {
  const counts = { total: items.length }
  for (const status of statuses) counts[status] = 0
  for (const item of items) {
    if (typeof item.status === 'string' && Object.hasOwn(counts, item.status)) counts[item.status] += 1
  }
  return counts
}

// ---------------------------------------------------------- experiments

function normalizeParent(value, existingIds, selfId) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalid('parent must be an experiment id or null')
  const parent = value.trim()
  if (!REF_ID_RE.test(parent)) throw invalid(`parent is not a valid experiment id: ${JSON.stringify(value)}`)
  if (selfId !== undefined && parent === selfId) throw invalid('parent cannot reference itself')
  if (!existingIds.has(parent)) throw invalid(`parent experiment does not exist: ${parent}`)
  return parent
}

/** Legacy = anything not written by the schema2 writer (missing schema included). */
export function isLegacyExperiment(record) {
  return !isPlainObject(record) || record.schema !== EXPERIMENT_SCHEMA
}

/** One problem per schema2 judging rule; empty when the record is complete. */
function schema2FieldProblems(record) {
  const problems = []
  const text = (key, label, max) => {
    const value = typeof record[key] === 'string' ? record[key].trim() : ''
    if (value === '') {
      problems.push({ field: key, message: `${label} is required for schema-2 experiments (${key})` })
      return
    }
    if (Number.isInteger(max) && value.length > max) {
      problems.push({ field: key, message: `${key} must be at most ${max} characters` })
    }
  }
  text('direction', 'direction', EXPERIMENT_DIRECTION_MAX)
  text('expected', 'a judging expectation')
  text('primaryMetric', 'a primary metric')
  text('falsify', 'a falsification condition')
  text('stopLoss', 'a stop-loss line')
  const guardrails = record.guardrails
  if (!Array.isArray(guardrails)) {
    problems.push({ field: 'guardrails', message: 'guardrails must be an array of metric names' })
  } else {
    if (guardrails.length === 0) {
      problems.push({ field: 'guardrails', message: 'guardrails must name at least one metric' })
    }
    guardrails.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        problems.push({ field: 'guardrails', message: `guardrails[${index}] must be a non-empty string` })
      }
    })
  }
  if (!Number.isInteger(record.windowDays) || record.windowDays <= 0 || record.windowDays > EXPERIMENT_WINDOW_MAX_DAYS) {
    problems.push({
      field: 'windowDays',
      message: `windowDays must be a positive integer (days, at most ${EXPERIMENT_WINDOW_MAX_DAYS})`,
    })
  }
  return problems
}

/** Normalize the seven schema2 fields in place; throws the first real problem. */
function normalizeSchema2Fields(record) {
  for (const key of ['direction', 'expected', 'primaryMetric', 'falsify', 'stopLoss']) {
    record[key] = typeof record[key] === 'string' ? record[key].trim() : record[key]
  }
  if (Array.isArray(record.guardrails)) {
    record.guardrails = record.guardrails.map((entry) => (typeof entry === 'string' ? entry.trim() : entry))
  }
  record.learned = optionalText(record.learned, 'learned', '')
  record.cleanupAt = record.cleanupAt === undefined || record.cleanupAt === null || record.cleanupAt === ''
    ? null
    : optionalText(record.cleanupAt, 'cleanupAt', '')
  record.productizedAt = record.productizedAt === undefined || record.productizedAt === null || record.productizedAt === ''
    ? null
    : optionalText(record.productizedAt, 'productizedAt', '')
  if (record.productizeGate !== undefined && record.productizeGate !== null && !isPlainObject(record.productizeGate)) {
    throw invalid('productizeGate must be an object or null')
  }
  if (record.productizeGate === undefined) record.productizeGate = null
  record.cleanup = normalizeCleanup(record.cleanup)
  const problems = schema2FieldProblems(record)
  if (problems.length > 0) throw invalid(problems[0].message)
}

/** `{flags, code, data}` cleanup object with each list capped at 20 entries. */
function normalizeCleanup(value) {
  const source = isPlainObject(value) ? value : {}
  const list = (entries, label) => {
    if (entries === undefined || entries === null) return []
    if (!Array.isArray(entries)) throw invalid(`cleanup.${label} must be an array`)
    if (entries.length > EXPERIMENT_CLEANUP_MAX) {
      throw invalid(`cleanup.${label} accepts at most ${EXPERIMENT_CLEANUP_MAX} entries`)
    }
    return entries.map((entry, index) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw invalid(`cleanup.${label}[${index}] must be a non-empty string`)
      }
      return entry.trim()
    })
  }
  return {
    flags: list(source.flags, 'flags'),
    code: list(source.code, 'code'),
    data: list(source.data, 'data'),
  }
}

/** Write-path soft warnings for the two async-closed terminal states. */
function warnTerminalGaps(record) {
  if (!isPlainObject(record) || isLegacyExperiment(record)) return
  const learned = typeof record.learned === 'string' ? record.learned.trim() : ''
  if (record.status === 'inconclusive' && learned === '') {
    noteWarning(`experiment-inconclusive-no-learned: ${record.id}: learned is suggested but not required`)
  }
  if (record.status === 'refuted') {
    if (learned === '') noteWarning(`experiment-refuted-no-learned: ${record.id}: learned is required by check experiments`)
    if (typeof record.cleanupAt !== 'string' || record.cleanupAt.trim() === '') {
      noteWarning(`experiment-refuted-no-cleanup: ${record.id}: cleanup is async; check experiments requires cleanupAt`)
    }
  }
}

/** Terminal-state supplements (only checked for schema2 records). */
function validateExperimentTerminal(record, ctx) {
  const learned = typeof record.learned === 'string' ? record.learned.trim() : ''
  if (record.status === 'confirmed') {
    if (typeof record.measured !== 'string' || record.measured.trim() === '') {
      throw invalid('confirmed experiment requires measured (the observed result)')
    }
    if (!isPlainObject(record.metrics) || Object.keys(record.metrics).length === 0) {
      throw invalid('confirmed experiment requires metrics (at least one metric)')
    }
  }
  // `inconclusive` / `refuted` are intentionally soft on the write path: a
  // verdict is recorded first, and `flow exp cleanup` + `check experiments`
  // close the loop (cleanup is async). Only `confirmed` / `pivoted` hard-fail.
  if (record.status === 'pivoted') {
    if (learned === '') throw invalid('pivoted experiment requires learned (what was learned)')
    if (typeof ctx.hasSuccessor !== 'function' || ctx.hasSuccessor(record.id) !== true) {
      throw invalid('pivoted experiment requires a successor experiment whose parent points at it')
    }
  }
}

function validateExperimentFields(record, ctx = {}) {
  record.title = requireText(record.title, 'title')
  record.hypothesis = optionalText(record.hypothesis, 'hypothesis', '')
  record.factor = optionalText(record.factor, 'factor', '')
  record.expected = optionalText(record.expected, 'expected', '')
  record.scale = optionalText(record.scale, 'scale', '')
  record.measured = optionalText(record.measured, 'measured', '')
  record.notes = optionalText(record.notes, 'notes', '')
  const schema2 = record.schema === EXPERIMENT_SCHEMA
  record.status = optionalEnum(record.status, 'status', schema2 ? EXPERIMENT_STATUS : EXPERIMENT_LEGACY_STATUS, 'open')
  record.parent = normalizeParent(record.parent, ctx.existingIds ?? new Set(), record.id)
  if (record.metrics === undefined || record.metrics === null) record.metrics = {}
  if (!isPlainObject(record.metrics)) throw invalid('metrics must be an object')
  record.commits = stringArray(record.commits, 'commits')
  if (schema2) {
    normalizeSchema2Fields(record)
    validateExperimentTerminal(record, ctx)
  }
  return record
}

function buildExperiment(input, ctx) {
  if (!isPlainObject(input)) throw invalid('experiment must be an object')
  const record = deepClone(input)
  record.schema = EXPERIMENT_SCHEMA
  if (input.id === undefined) {
    record.id = nextId('E', ctx.existingIds)
  } else {
    assertPattern(input.id, EXP_ID_RE, 'experiment id')
    if (ctx.existingIds.has(input.id)) throw new FlowError('conflict', `experiment ${input.id} already exists`)
    record.id = input.id
  }
  for (const [key, fallback] of Object.entries(EXPERIMENT_DEFAULTS)) {
    if (record[key] === undefined) record[key] = deepClone(fallback)
  }
  validateExperimentFields(record, ctx)
  const now = formatIso()
  record.created_at = typeof input.created_at === 'string' ? input.created_at : now
  record.updated_at = typeof input.updated_at === 'string' ? input.updated_at : now
  return record
}

function applyExperimentPatch(record, patch, ctx) {
  if (!isPlainObject(patch)) throw invalid('experiment patch must be an object')
  if (isLegacyExperiment(record)) {
    throw invalid(
      'experiment is schema1/legacy and read-only; create a schema-2 experiment and point its parent at this one',
    )
  }
  for (const key of ['id', 'schema', 'created_at']) {
    if (Object.hasOwn(patch, key)) throw invalid(`experiment ${key} cannot be changed`)
  }
  for (const key of EXPERIMENT_SYSTEM_FIELDS) {
    if (Object.hasOwn(patch, key)) throw invalid(`experiment ${key} cannot be changed (system field)`)
  }
  const next = { ...record }
  for (const [key, value] of Object.entries(deepClone(patch))) next[key] = value
  next.id = record.id
  next.schema = record.schema
  next.created_at = record.created_at
  validateExperimentFields(next, ctx)
  next.updated_at = formatIso()
  return next
}

function experimentIds(paths) {
  return new Set(readCollection(paths.experiments).map((item) => item.record.id).filter((id) => typeof id === 'string'))
}

/** A missing experiment link is a warning, never a write failure (T-12). */
function warnTaskExperiment(record, paths) {
  if (typeof record.experiment !== 'string' || record.experiment === '') return
  try {
    if (experimentIds(paths).has(record.experiment) === false) {
      noteWarning(`task-experiment-missing: ${record.id}: ${record.experiment}`)
    }
  } catch {
    // The link check is advisory; a read failure must not fail the write.
  }
}

/** Validation context: known ids plus "does any other record point at me". */
function experimentContext(paths) {
  const records = readCollection(paths.experiments).map((item) => item.record).filter((item) => isPlainObject(item))
  return {
    existingIds: new Set(records.filter((record) => typeof record.id === 'string').map((record) => record.id)),
    hasSuccessor: (id) => records.some((record) => record.id !== id && record.parent === id),
  }
}

export function listExperiments(root, contract, options = {}) {
  const memo = pathMemoOf(options)
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c, { pathMemo: memo })
  return sortByUpdatedDesc(
    readCollection(paths.experiments, unreadableCollector(options)).map((item) => item.record),
  )
}

export function getExperiment(root, contract, id) {
  const c = normalizeContract(root, contract)
  return readRecord(storePaths(root, c).experiments, id, 'experiment')
}

export function addExperiment(root, contract, input) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const record = buildExperiment(input, experimentContext(paths))
    warnTerminalGaps(record)
    assertTargetFree(paths.experiments, record.id)
    writeJsonAtomic(join(paths.experiments, `${record.id}.json`), record)
    return record
  })
}

export function updateExperiment(root, contract, id, patch) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.experiments, id, 'experiment')
    const next = applyExperimentPatch(current, patch, experimentContext(paths))
    warnTerminalGaps(next)
    writeJsonAtomic(join(paths.experiments, `${next.id}.json`), next)
    return next
  })
}

/**
 * Minimal system-field writer for `refuted` cleanup: replaces the named cleanup
 * lists (each ≤20 entries) and stamps `cleanupAt`. Only schema2 records are
 * writable; legacy records stay read-only.
 */
export function cleanupExperiment(root, contract, id, options = {}) {
  const input = isPlainObject(options) ? options : {}
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.experiments, id, 'experiment')
    if (isLegacyExperiment(current)) {
      throw invalid('experiment is schema1/legacy and read-only; create a schema-2 experiment instead')
    }
    const previous = normalizeCleanup(current.cleanup)
    const cleanup = {
      flags: Object.hasOwn(input, 'flags') ? normalizeCleanup({ flags: input.flags }).flags : previous.flags,
      code: Object.hasOwn(input, 'code') ? normalizeCleanup({ code: input.code }).code : previous.code,
      data: Object.hasOwn(input, 'data') ? normalizeCleanup({ data: input.data }).data : previous.data,
    }
    const cleanupAt =
      typeof input.cleanupAt === 'string' && input.cleanupAt.trim() !== '' ? input.cleanupAt.trim() : formatIso()
    const unchanged =
      JSON.stringify(previous) === JSON.stringify(cleanup) &&
      typeof current.cleanupAt === 'string' &&
      current.cleanupAt !== ''
    if (unchanged) {
      return { id: current.id, cleanup, cleanupAt: current.cleanupAt, changed: false }
    }
    const next = { ...current, cleanup, cleanupAt, updated_at: formatIso() }
    writeJsonAtomic(join(paths.experiments, `${next.id}.json`), next)
    return { id: next.id, cleanup, cleanupAt, changed: true }
  })
}

/**
 * Mark a `confirmed` experiment as productized after a passing release gate run
 * that finished at/after the record's confirmation (`updated_at`). Only the
 * dedicated writer may set `productizedAt` / `productizeGate`.
 */
export function productizeExperiment(root, contract, id, options = {}) {
  const input = isPlainObject(options) ? options : {}
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.experiments, id, 'experiment')
    if (isLegacyExperiment(current)) {
      throw invalid('experiment is schema1/legacy and read-only; create a schema-2 experiment instead')
    }
    if (current.status !== 'confirmed') {
      throw invalid(`only a confirmed experiment can be productized (current status: ${current.status})`)
    }
    if (typeof current.productizedAt === 'string' && current.productizedAt !== '') {
      return {
        id: current.id,
        productizedAt: current.productizedAt,
        productizeGate: isPlainObject(current.productizeGate) ? current.productizeGate : null,
        already: true,
      }
    }
    const gateId = typeof input.gateId === 'string' && input.gateId.trim() !== '' ? input.gateId.trim() : 'release'
    assertSafeId(gateId, 'gate id')
    const judgedAt = Date.parse(current.updated_at)
    const runs = readCollection(join(paths.logs, gateId)).map((item) => item.record)
    const passing = runs
      .filter((run) => {
        if (isPlainObject(run) === false || run.ok !== true) return false
        const finished = Date.parse(run.finished_at)
        return Number.isFinite(finished) && finished >= (Number.isFinite(judgedAt) ? judgedAt : 0)
      })
      .sort((left, right) => Date.parse(right.finished_at) - Date.parse(left.finished_at))
    const run = passing[0]
    if (run === undefined) {
      throw invalid(
        `gate ${gateId} has no passing run finished at/after the experiment was confirmed (${current.updated_at})`,
      )
    }
    const productizedAt = formatIso()
    const productizeGate = {
      id: gateId,
      runAt: run.finished_at,
      log: typeof run.log === 'string' ? run.log : typeof run.logFile === 'string' ? run.logFile : '',
    }
    const next = { ...current, productizedAt, productizeGate, updated_at: formatIso() }
    writeJsonAtomic(join(paths.experiments, `${next.id}.json`), next)
    return { id: next.id, productizedAt, productizeGate, already: false }
  })
}

/** status → review branch (`success|uncertain|failure|pivot`, CONTRACT §5.1). */
const REVIEW_BRANCH = Object.freeze({
  confirmed: 'success',
  refuted: 'failure',
  pivoted: 'pivot',
  open: 'uncertain',
  inconclusive: 'uncertain',
  abandoned: 'uncertain',
})

/**
 * Read-only review verdict for one experiment: the same rules
 * `checkExperiments` enforces (schema2 completeness + per-status closure),
 * expressed as `missing`. Pure: never reads or writes the store, so the CLI
 * (`flow exp review`) and the `flow_exp review` tool share this one
 * implementation and can never drift apart.
 *
 * @param {object} record experiment record
 * @param {{hasSuccessor?: (id: string) => boolean}} [options]
 * @returns {{id: string|null, verdict: 'complete'|'incomplete',
 *            branch: 'success'|'uncertain'|'failure'|'pivot', missing: string[]}}
 */
export function reviewExperimentRecord(record, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const hasSuccessor = typeof input.hasSuccessor === 'function' ? input.hasSuccessor : () => false
  if (isLegacyExperiment(record)) {
    return {
      id: isPlainObject(record) && typeof record.id === 'string' ? record.id : null,
      verdict: 'incomplete',
      branch: 'uncertain',
      missing: ['schema2 (legacy record is read-only)'],
    }
  }
  // `schema2FieldProblems` is the complete judging rule set: the five text
  // fields, non-empty guardrail entries, and windowDays 1..EXPERIMENT_WINDOW_MAX_DAYS.
  const missing = [...new Set(schema2FieldProblems(record).map((problem) => problem.field))]
  const learned = typeof record.learned === 'string' ? record.learned.trim() : ''
  if (record.status === 'confirmed' && (typeof record.productizedAt !== 'string' || record.productizedAt === '')) {
    missing.push('productizedAt')
  }
  if (record.status === 'refuted') {
    if (learned === '') missing.push('learned')
    if (typeof record.cleanupAt !== 'string' || record.cleanupAt === '') missing.push('cleanupAt')
  }
  if (record.status === 'pivoted') {
    if (learned === '') missing.push('learned')
    if (hasSuccessor(record.id) !== true) missing.push('successor')
  }
  return {
    id: record.id,
    verdict: missing.length === 0 ? 'complete' : 'incomplete',
    branch: REVIEW_BRANCH[record.status] ?? 'uncertain',
    missing,
  }
}

/**
 * `flow check experiments` (read-only, never locks or writes). `enabled` only
 * gates this check and the panel projection; writes keep working either way.
 * Verdict shape mirrors `checkDecisions`: `{ok, checked, legacy, failed[],
 * warnings[]}` with one `{id, rule, message}` per failure.
 */
export function checkExperiments(root, contract, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  if (c.experiments.enabled !== true) {
    return { ok: true, checked: 0, legacy: 0, failed: [], warnings: [] }
  }
  const paths = storePaths(root, c)
  const records = readCollection(paths.experiments).map((item) => item.record).filter((item) => isPlainObject(item))
  const byId = new Map(records.filter((record) => typeof record.id === 'string').map((record) => [record.id, record]))
  const hasSuccessor = (id) => records.some((record) => record.id !== id && record.parent === id)
  const failed = []
  const warnings = []
  let checked = 0
  let legacy = 0
  for (const record of records) {
    if (isLegacyExperiment(record)) {
      legacy += 1
      continue
    }
    checked += 1
    for (const problem of schema2FieldProblems(record)) {
      failed.push({ id: record.id, rule: 'experiment-fields', message: problem.message })
    }
    const learned = typeof record.learned === 'string' ? record.learned.trim() : ''
    if (record.status === 'confirmed' && (typeof record.productizedAt !== 'string' || record.productizedAt === '')) {
      failed.push({ id: record.id, rule: 'experiment-productize', message: 'confirmed experiment is not productized' })
    }
    if (record.status === 'refuted') {
      if (learned === '') {
        failed.push({ id: record.id, rule: 'experiment-learned', message: 'refuted experiment has no learned' })
      }
      if (typeof record.cleanupAt !== 'string' || record.cleanupAt === '') {
        failed.push({ id: record.id, rule: 'experiment-cleanup', message: 'refuted experiment has no cleanupAt' })
      }
    }
    if (record.status === 'pivoted') {
      if (learned === '') {
        failed.push({ id: record.id, rule: 'experiment-learned', message: 'pivoted experiment has no learned' })
      }
      if (hasSuccessor(record.id) !== true) {
        failed.push({ id: record.id, rule: 'experiment-successor', message: 'pivoted experiment has no successor' })
      }
    }
    if (record.status === 'inconclusive' && learned === '') {
      warnings.push({
        id: record.id,
        rule: 'experiment-inconclusive-no-learned',
        message: 'inconclusive experiment has no learned (suggested, not blocking)',
      })
    }
    if (record.status === 'open') {
      const created = Date.parse(record.created_at)
      if (Number.isInteger(record.windowDays) && Number.isFinite(created) && now > created + record.windowDays * DAY_MS) {
        warnings.push({
          id: record.id,
          rule: 'experiment-window-elapsed',
          message: `observation window of ${record.windowDays} day(s) has elapsed`,
        })
      }
    }
    if (record.status === 'abandoned' && learned === '') {
      warnings.push({ id: record.id, rule: 'experiment-abandoned-no-learned', message: 'abandoned experiment has no learned' })
    }
  }
  try {
    for (const task of listTasks(root, c)) {
      if (typeof task.experiment === 'string' && task.experiment !== '' && byId.has(task.experiment) === false) {
        warnings.push({
          id: task.id,
          rule: 'task-experiment-missing',
          message: `task references missing experiment ${task.experiment}`,
        })
      }
    }
  } catch {
    // A task-read failure must not turn the experiment verdict into ok:false.
  }
  return { ok: failed.length === 0, checked, legacy, failed, warnings }
}

export function removeExperiment(root, contract, id) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const file = join(paths.experiments, `${assertSafeId(id)}.json`)
    try {
      unlinkSync(file)
    } catch (error) {
      if (error.code === 'ENOENT') throw new FlowError('not-found', `experiment ${id} not found`)
      throw new FlowError('io', `cannot remove ${toPosix(file)}: ${error.message}`)
    }
    return { id, removed: true }
  })
}

function createsCycle(node, parentId, byId) {
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

/** Nest records by `parent`; unknown parents and cycles become roots. */
export function experimentTree(records) {
  const list = Array.isArray(records) ? records : []
  const nodes = []
  const byId = new Map()
  for (const record of list) {
    if (!isPlainObject(record)) continue
    const node = { ...deepClone(record), children: [] }
    nodes.push(node)
    if (typeof node.id === 'string' && !byId.has(node.id)) byId.set(node.id, node)
  }
  const roots = []
  for (const node of nodes) {
    const parentId = node.parent
    const parent = typeof parentId === 'string' ? byId.get(parentId) : undefined
    if (parent === undefined || parent === node || createsCycle(node, parentId, byId)) {
      roots.push(node)
      continue
    }
    parent.children.push(node)
  }
  return roots
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
  record.status = optionalEnum(record.status, 'status', TASK_STATUS, 'draft')
  record.owner = optionalText(record.owner, 'owner', '')
  record.goal = optionalText(record.goal, 'goal', '')
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
  record.commits = stringArray(record.commits, 'commits')
  return record
}

function buildTask(input, ctx) {
  if (!isPlainObject(input)) throw invalid('task must be an object')
  const record = deepClone(input)
  record.schema = 1
  if (input.id === undefined) {
    record.id = nextId('T', ctx.existingIds)
  } else {
    assertPattern(input.id, EXP_ID_RE, 'task id')
    if (ctx.existingIds.has(input.id)) throw new FlowError('conflict', `task ${input.id} already exists`)
    record.id = input.id
  }
  for (const [key, fallback] of Object.entries(TASK_DEFAULTS)) {
    if (record[key] === undefined) record[key] = deepClone(fallback)
  }
  validateTaskFields(record)
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
function stampTaskTimes(previous, next, nowIso) {
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
  let doneAt = record.done_at
  let archivedAt = record.archived_at
  let changed = false
  if (!isStamp(doneAt) && (record.status === 'done' || record.status === 'archived')) {
    doneAt = updated
    changed = true
  }
  if (!isStamp(archivedAt) && record.status === 'archived') {
    archivedAt = updated
    changed = true
  }
  if (changed === false) return record
  return { ...record, done_at: doneAt, archived_at: archivedAt }
}

function applyTaskPatch(record, patch) {
  if (!isPlainObject(patch)) throw invalid('task patch must be an object')
  for (const key of ['id', 'schema', 'created_at']) {
    if (Object.hasOwn(patch, key)) throw invalid(`task ${key} cannot be changed`)
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
  validateTaskFields(next)
  next.updated_at = formatIso()
  return next
}

function taskIds(paths) {
  return new Set(readCollection(paths.tasks).map((item) => item.record.id).filter((id) => typeof id === 'string'))
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

/** One task row: time fallbacks (T-09) then parent fallbacks (T-13). */
function projectTaskRecord(record, byId) {
  return projectTaskParent(projectTaskTimes(record), byId)
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

export function addTask(root, contract, input) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const record = buildTask(input, { existingIds: taskIds(paths) })
    assertTaskParent(record, paths)
    warnTaskExperiment(record, paths)
    assertTargetFree(paths.tasks, record.id)
    writeJsonAtomic(join(paths.tasks, `${record.id}.json`), record)
    return record
  })
}

export function updateTask(root, contract, id, patch) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.tasks, id, 'task')
    const next = stampTaskTimes(current, applyTaskPatch(current, patch), formatIso())
    assertTaskParent(next, paths)
    warnTaskExperiment(next, paths)
    writeJsonAtomic(join(paths.tasks, `${next.id}.json`), next)
    return next
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

// ---------------------------------------------------------------- gates

function buildStep(step, index, seen) {
  const label = `steps[${index}]`
  if (!isPlainObject(step)) throw invalid(`${label} must be an object`)
  const id = step.id === undefined ? `step-${index + 1}` : requireText(step.id, `${label}.id`)
  if (seen.has(id)) throw invalid(`duplicate step id: ${id}`)
  seen.add(id)
  const run = requireText(step.run, `${label}.run`)
  const rawExpect = optionalText(step.expect, `${label}.expect`, 'exit 0')
  const expect = rawExpect.trim() === '' ? 'exit 0' : rawExpect
  // Surface a typo when the gate is defined, not only when it eventually runs.
  if (expectSyntaxKnown(expect) === false) {
    noteWarning(`gate-expect-unknown: ${JSON.stringify(expect)} treated as "exit 0"`)
  }
  const timeoutSeconds = optionalInt(step.timeoutSeconds, `${label}.timeoutSeconds`, 600, 1)
  return { ...deepClone(step), id, run, expect: expect.trim(), timeoutSeconds }
}

function validateGateFields(record) {
  assertPattern(record.id, GATE_ID_RE, 'gate id')
  record.title = requireText(record.title, 'title')
  record.phase = optionalEnum(record.phase, 'phase', GATE_PHASES, 'manual')
  record.enabled = optionalBoolean(record.enabled, 'enabled', true)
  if (!Array.isArray(record.steps)) throw invalid('steps must be an array')
  const seen = new Set()
  record.steps = record.steps.map((step, index) => buildStep(step, index, seen))
  return record
}

function buildGate(input, ctx) {
  if (!isPlainObject(input)) throw invalid('gate must be an object')
  const record = deepClone(input)
  record.schema = 1
  if (input.id === undefined) {
    record.id = slugify(requireText(input.title, 'title'))
  } else {
    assertPattern(input.id, GATE_ID_RE, 'gate id')
    record.id = input.id
  }
  if (ctx.existingIds.has(record.id)) throw new FlowError('conflict', `gate ${record.id} already exists`)
  if (record.steps === undefined) record.steps = []
  validateGateFields(record)
  const now = formatIso()
  record.created_at = typeof input.created_at === 'string' ? input.created_at : now
  record.updated_at = typeof input.updated_at === 'string' ? input.updated_at : now
  return record
}

function applyGatePatch(record, patch) {
  if (!isPlainObject(patch)) throw invalid('gate patch must be an object')
  for (const key of ['id', 'schema', 'created_at']) {
    if (Object.hasOwn(patch, key)) throw invalid(`gate ${key} cannot be changed`)
  }
  const next = { ...record }
  for (const [key, value] of Object.entries(deepClone(patch))) next[key] = value
  next.id = record.id
  next.schema = 1
  next.created_at = record.created_at
  validateGateFields(next)
  next.updated_at = formatIso()
  return next
}

function gateIds(paths) {
  const ids = new Set()
  for (const item of readCollection(paths.gates)) {
    ids.add(typeof item.record.id === 'string' ? item.record.id : item.name.slice(0, -5))
  }
  return ids
}

export function listGates(root, contract, options = {}) {
  const memo = pathMemoOf(options)
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c, { pathMemo: memo })
  return sortByUpdatedDesc(readCollection(paths.gates, unreadableCollector(options)).map((item) => item.record))
}

export function getGate(root, contract, id) {
  const c = normalizeContract(root, contract)
  return readRecord(storePaths(root, c).gates, id, 'gate')
}

export function addGate(root, contract, input) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const record = buildGate(input, { existingIds: gateIds(paths) })
    assertTargetFree(paths.gates, record.id)
    writeJsonAtomic(join(paths.gates, `${record.id}.json`), record)
    return record
  })
}

export function updateGate(root, contract, id, patch) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.gates, id, 'gate')
    const next = applyGatePatch(current, patch)
    writeJsonAtomic(join(paths.gates, `${next.id}.json`), next)
    return next
  })
}

export function removeGate(root, contract, id) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const file = join(paths.gates, `${assertSafeId(id)}.json`)
    try {
      unlinkSync(file)
    } catch (error) {
      if (error.code === 'ENOENT') throw new FlowError('not-found', `gate ${id} not found`)
      throw new FlowError('io', `cannot remove ${toPosix(file)}: ${error.message}`)
    }
    return { id, removed: true }
  })
}

// ------------------------------------------------------------- decisions

function codePointLength(value) {
  return [...String(value)].length
}

/**
 * Dedupe fingerprint: sha256(kind + "\n" + normalize(question)) first 16 hex.
 * `normalize` = NFKC, then drop every whitespace and punctuation, then lowercase.
 * Core alone computes it; callers never pass one in.
 */
function decisionFingerprint(kind, question) {
  const normalized = String(question)
    .normalize('NFKC')
    .replace(/[\s\p{P}]+/gu, '')
    .toLowerCase()
  return createHash('sha256').update(`${kind}\n${normalized}`, 'utf8').digest('hex').slice(0, 16)
}

/** Repo-relative POSIX path/prefix: `\` -> `/`, drop `./` and trailing `/`, reject absolute/`..`. */
function normalizeDecisionAffect(value) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid('affects entries must be non-empty strings')
  const raw = value.trim().replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw invalid(`affects entries must be repository-relative paths: ${JSON.stringify(value)}`)
  }
  const segments = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw invalid(`affects entry escapes the repository root: ${JSON.stringify(value)}`)
    segments.push(segment)
  }
  if (segments.length === 0) throw invalid(`affects entry must name a path: ${JSON.stringify(value)}`)
  return segments.join('/')
}

function normalizeDecisionAffects(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid('affects must be an array of strings')
  const affects = []
  for (const item of value) {
    const path = normalizeDecisionAffect(item)
    if (!affects.includes(path)) affects.push(path)
  }
  return affects
}

function normalizeDecisionBlocks(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw invalid('blocks must be an array of task ids')
  }
  const blocks = []
  for (const item of value) {
    const id = item.trim()
    if (!blocks.includes(id)) blocks.push(id)
  }
  return blocks
}

function buildDecisionOptions(kind, input) {
  if (kind === 'approval') {
    if (Array.isArray(input.options) && input.options.length > 0) {
      throw invalid('approval decisions use the fixed options approve|reject; do not pass options')
    }
    return DECISION_APPROVAL_OPTIONS.map((option) => ({ ...option }))
  }
  if (kind === 'input') {
    if (Array.isArray(input.options) && input.options.length > 0) throw invalid('input decisions take no options')
    return []
  }
  if (!Array.isArray(input.options) || input.options.length < 2) {
    throw invalid('choice decisions need at least two options')
  }
  const seen = new Set()
  return input.options.map((option, index) => {
    const label = `options[${index}]`
    if (!isPlainObject(option)) throw invalid(`${label} must be an object`)
    const id = assertPattern(option.id, DECISION_OPTION_ID_RE, `${label}.id`)
    if (seen.has(id)) throw invalid(`duplicate option id: ${id}`)
    seen.add(id)
    return {
      ...deepClone(option),
      id,
      label: requireText(option.label, `${label}.label`),
      impact: requireText(option.impact, `${label}.impact`),
    }
  })
}

function decisionOptionId(options, value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${label} is required`)
  const choice = value.trim()
  if (!options.some((option) => option.id === choice)) {
    throw invalid(`${label} must be one of ${options.map((option) => option.id).join(', ')}`)
  }
  return choice
}

function normalizeDecisionSupersedes(value, ctx) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalid('supersedes must be a decision id or null')
  const id = value.trim()
  assertPattern(id, DECISION_ID_RE, 'supersedes')
  const target = ctx.byId.get(id)
  if (target === undefined) throw invalid(`supersedes references a decision that does not exist: ${id}`)
  if (target.status === 'superseded') throw invalid(`superseded decision cannot be superseded again: ${id}`)
  return id
}

/** Validate and normalize one new record; `ctx` carries existing ids, records and task ids. */
function normalizeDecisionFields(record, ctx) {
  record.question = requireText(record.question, 'question')
  if (codePointLength(record.question) > DECISION_QUESTION_MAX) {
    throw invalid(`question is longer than ${DECISION_QUESTION_MAX} characters`)
  }
  if (!DECISION_KINDS.includes(record.kind)) throw invalid(`kind must be one of ${DECISION_KINDS.join(', ')}`)
  record.options = buildDecisionOptions(record.kind, record)
  if (record.kind === 'choice' || record.kind === 'approval') {
    // `approval` 省略 `recommendation` 时固定推荐 `approve`（想推荐拒绝必须显式传
    // `reject`）；`choice` 仍必填（D02）。显式给值一律按 option 校验。
    const omitted =
      record.recommendation === undefined || record.recommendation === null || record.recommendation === ''
    record.recommendation =
      record.kind === 'approval' && omitted
        ? 'approve'
        : decisionOptionId(record.options, record.recommendation, 'recommendation')
    record.default =
      record.default === undefined || record.default === null || record.default === ''
        ? null
        : decisionOptionId(record.options, record.default, 'default')
  } else {
    record.recommendation =
      typeof record.recommendation === 'string' && record.recommendation.trim() !== ''
        ? record.recommendation.trim()
        : null
    record.default =
      typeof record.default === 'string' && record.default.trim() !== '' ? record.default.trim() : null
  }
  record.rationale = requireText(record.rationale, 'rationale')
  if (codePointLength(record.rationale) > DECISION_RATIONALE_MAX) {
    throw invalid(`rationale is longer than ${DECISION_RATIONALE_MAX} characters`)
  }
  if (record.status !== undefined && record.status !== 'open') throw invalid('a new decision is always open')
  record.status = 'open'
  record.blocks = normalizeDecisionBlocks(record.blocks)
  for (const id of record.blocks) {
    if (ctx.taskIds.has(id) === false) throw invalid(`blocks references a task that does not exist: ${id}`)
  }
  record.affects = normalizeDecisionAffects(record.affects)
  if (record.blocks.length > 0 && record.affects.length === 0) {
    throw invalid('a blocking decision must declare at least one affects entry')
  }
  record.supersedes = normalizeDecisionSupersedes(record.supersedes, ctx)
  record.answer = null
  record.answered_at = null
  record.withdraw = null
  record.superseded_by = null
  record.fingerprint = decisionFingerprint(record.kind, record.question)
  return record
}

function buildDecision(input, ctx) {
  if (!isPlainObject(input)) throw invalid('decision must be an object')
  for (const key of ['schema', 'fingerprint', 'superseded_by', 'answered_at', 'answer', 'withdraw']) {
    if (Object.hasOwn(input, key)) throw invalid(`decision ${key} is maintained by core and cannot be passed`)
  }
  const record = deepClone(input)
  record.schema = DECISION_SCHEMA
  if (input.id === undefined) {
    record.id = nextId('D', ctx.existingIds)
  } else {
    assertPattern(input.id, DECISION_ID_RE, 'decision id')
    if (ctx.existingIds.has(input.id)) throw new FlowError('conflict', `decision ${input.id} already exists`)
    record.id = input.id
  }
  normalizeDecisionFields(record, ctx)
  let askedAt = formatIso()
  if (input.asked_at !== undefined) {
    if (typeof input.asked_at !== 'string' || Number.isNaN(Date.parse(input.asked_at))) {
      throw invalid('asked_at must be an ISO 8601 timestamp')
    }
    askedAt = input.asked_at
  }
  record.asked_at = askedAt
  record.created_at = askedAt
  record.updated_at = askedAt
  record.asked_session =
    typeof input.asked_session === 'string' && input.asked_session.trim() !== '' ? input.asked_session.trim() : null
  record.asked_turn = Number.isInteger(input.asked_turn) ? input.asked_turn : null
  return record
}

function decisionRecords(paths) {
  return readCollection(paths.decisions).map((item) => item.record)
}

function decisionIds(paths) {
  const ids = new Set()
  for (const item of readCollection(paths.decisions)) {
    ids.add(typeof item.record.id === 'string' ? item.record.id : item.name.slice(0, -5))
  }
  return ids
}

function decisionSortedNewest(records) {
  return records
    .slice()
    .sort((left, right) => timeValue(right.updated_at) - timeValue(left.updated_at))
}

/**
 * One decision with display annotations: `escalated`, `turnAge` (only for the
 * asking session) and `ageSeconds` (from `asked_at`). Escalation is `⚠` when the
 * asking session is this many turns ahead or the record is this many hours old.
 */
function annotateDecision(record, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const session = typeof options.session === 'string' ? options.session : ''
  const turn = Number.isInteger(options.turn) ? options.turn : null
  const asked = Date.parse(typeof record.asked_at === 'string' ? record.asked_at : '')
  const ageSeconds = Number.isFinite(asked) ? Math.max(0, Math.floor((now - asked) / 1000)) : null
  const turnAge =
    session !== '' && record.asked_session === session && turn !== null && Number.isInteger(record.asked_turn)
      ? turn - record.asked_turn
      : null
  const escalated =
    (turnAge !== null && turnAge >= DECISION_ESCALATE_TURNS) ||
    (ageSeconds !== null && ageSeconds >= DECISION_ESCALATE_HOURS * 60 * 60)
  return { ...record, escalated, turnAge, ageSeconds }
}

/** Open records: escalated first, then oldest `asked_at` first, then id. */
function decisionOpenOrder(left, right) {
  const delta = Number(right.escalated === true) - Number(left.escalated === true)
  if (delta !== 0) return delta
  const leftAt = Date.parse(typeof left.asked_at === 'string' ? left.asked_at : '')
  const rightAt = Date.parse(typeof right.asked_at === 'string' ? right.asked_at : '')
  const leftStamp = Number.isFinite(leftAt) ? leftAt : Number.POSITIVE_INFINITY
  const rightStamp = Number.isFinite(rightAt) ? rightAt : Number.POSITIVE_INFINITY
  if (leftStamp !== rightStamp) return leftStamp - rightStamp
  return String(left.id ?? '').localeCompare(String(right.id ?? ''))
}

/**
 * Decision list. Default: open only (escalated first, oldest first). `all: true`
 * appends the closed records, newest `updated_at` first.
 * @param {{all?:boolean, session?:string, turn?:number|null, now?:number}} [options]
 */
export function listDecisions(root, contract, options = {}) {
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const annotated = decisionRecords(storePaths(root, c)).map((record) => annotateDecision(record, input))
  const open = annotated.filter((record) => record.status === 'open').sort(decisionOpenOrder)
  if (input.all !== true) return open
  const closed = annotated
    .filter((record) => record.status !== 'open')
    .sort((left, right) => {
      const delta = timeValue(right.updated_at) - timeValue(left.updated_at)
      return delta !== 0 ? delta : String(right.id ?? '').localeCompare(String(left.id ?? ''))
    })
  return [...open, ...closed]
}

export function getDecision(root, contract, id) {
  const c = normalizeContract(root, contract)
  return readRecord(storePaths(root, c).decisions, id, 'decision')
}

/** Closed-record hint for the conflict message that blocks re-asking the same question. */
function decisionClosedHint(record) {
  if (record.status === 'answered' && isPlainObject(record.answer)) {
    return `${record.id} is answered (choice ${record.answer.choice})`
  }
  if (record.status === 'withdrawn' && isPlainObject(record.withdraw)) {
    return `${record.id} is withdrawn (${record.withdraw.reason})`
  }
  return `${record.id} is ${String(record.status)}`
}

/**
 * Ask one decision. Fingerprint dedupe (§4.5 of the design):
 * 1. same fingerprint has an open record → reuse it (`created: false`);
 * 2. same fingerprint has a closed record → `conflict` unless `supersedes` names
 *    exactly that record; the old record becomes `superseded` and keeps its
 *    answer/withdraw for audit;
 * 3. otherwise create.
 * @returns {{decision:object, created:boolean}}
 */
export function addDecision(root, contract, input) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const records = decisionRecords(paths)
    const byId = new Map(records.filter((record) => typeof record.id === 'string').map((record) => [record.id, record]))
    const taskIds = new Set(
      readCollection(paths.tasks)
        .map((item) => item.record.id)
        .filter((id) => typeof id === 'string'),
    )
    const candidate = buildDecision(input, { existingIds: decisionIds(paths), byId, taskIds })
    const same = records.filter((record) => record.fingerprint === candidate.fingerprint)
    const openSame = decisionSortedNewest(same.filter((record) => record.status === 'open'))[0]
    if (openSame !== undefined) return { decision: openSame, created: false }
    const closedSame = decisionSortedNewest(same.filter((record) => record.status !== 'open'))[0]
    let target = null
    if (closedSame !== undefined) {
      if (candidate.supersedes !== closedSame.id) {
        throw new FlowError(
          'conflict',
          `decision already closed: ${decisionClosedHint(closedSame)}; re-ask the same question with supersedes=${closedSame.id}`,
        )
      }
      target = closedSame
    } else if (candidate.supersedes !== null) {
      target = byId.get(candidate.supersedes) ?? null
    }
    assertTargetFree(paths.decisions, candidate.id)
    writeJsonAtomic(join(paths.decisions, `${candidate.id}.json`), candidate)
    if (target !== null) {
      const next = {
        ...deepClone(target),
        status: 'superseded',
        superseded_by: candidate.id,
        updated_at: formatIso(),
      }
      writeJsonAtomic(join(paths.decisions, `${next.id}.json`), next)
    }
    return { decision: candidate, created: true }
  })
}

function requireOpenDecision(record, action) {
  if (record.status === 'open') return record
  throw new FlowError('conflict', `decision ${record.id} is ${String(record.status)}; terminal records cannot be ${action}`)
}

/**
 * Close an open decision with the user's choice. `choice` must name an option
 * id (`input` decisions take free text); `by` records who confirmed it.
 */
export function answerDecision(root, contract, id, input = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const patch = isPlainObject(input) ? input : {}
  return withLock(root, c, (paths) => {
    const current = requireOpenDecision(readRecord(paths.decisions, id, 'decision'), 'answered')
    const by = optionalEnum(patch.by, 'by', DECISION_BY, 'user')
    let choice
    if (current.kind === 'input') {
      choice = requireText(patch.choice, 'choice')
    } else {
      const options = Array.isArray(current.options) ? current.options : []
      choice = decisionOptionId(options, patch.choice, 'choice')
    }
    const note = optionalText(patch.note, 'note', '')
    const at = formatIso()
    const next = { ...current, status: 'answered', answer: { choice, note, at, by }, answered_at: at, updated_at: at }
    writeJsonAtomic(join(paths.decisions, `${next.id}.json`), next)
    return next
  })
}

/** Close an open decision without answering it; a reason is required. */
export function withdrawDecision(root, contract, id, input = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const patch = isPlainObject(input) ? input : {}
  return withLock(root, c, (paths) => {
    const current = requireOpenDecision(readRecord(paths.decisions, id, 'decision'), 'withdrawn')
    const reason = requireText(patch.reason, 'reason')
    const by = optionalEnum(patch.by, 'by', DECISION_BY, 'user')
    const at = formatIso()
    const next = { ...current, status: 'withdrawn', withdraw: { reason, at, by }, updated_at: at }
    writeJsonAtomic(join(paths.decisions, `${next.id}.json`), next)
    return next
  })
}

/**
 * Remove closed decisions whose last write is older than the retention window.
 * Open records are never removed; `dryRun` only reports.
 * @returns {{removed:string[], kept:number, dryRun:boolean}}
 */
export function gcDecisions(root, contract, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const days = input.days === undefined || input.days === null ? DECISION_GC_DAYS : input.days
  if (!Number.isInteger(days) || days < 1) throw invalid('days must be an integer >= 1')
  const dryRun = input.dryRun === true
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const cutoff = days * 24 * 60 * 60 * 1000
  return withLock(root, c, (paths) => {
    const result = { removed: [], kept: 0, dryRun }
    for (const item of readCollection(paths.decisions)) {
      const record = item.record
      if (record.status === 'open') {
        result.kept += 1
        continue
      }
      const stamp = timeValue(record.updated_at)
      // A broken timestamp cannot prove the record is old: keep it.
      if (Number.isFinite(stamp) === false || now - stamp <= cutoff) {
        result.kept += 1
        continue
      }
      result.removed.push(typeof record.id === 'string' ? record.id : item.name.slice(0, -5))
      if (dryRun === true) continue
      try {
        unlinkSync(item.file)
      } catch (error) {
        noteWarning(`decision-gc-failed: ${item.name}: ${error.message}`)
      }
    }
    result.removed.sort()
    return result
  })
}

/**
 * Read-only projection for the Host reminder, panel and `flow status`:
 * `{items, counts}` where items are the open decisions in the canonical order
 * and counts cover `{open, blocking, escalated, answered, withdrawn, superseded,
 * total}`. `limit` truncates `items` (counts stay global).
 * @param {{limit?:number, session?:string, turn?:number|null, now?:number}} [options]
 */
export function summarizeDecisions(root, contract, options = {}) {
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const annotated = decisionRecords(storePaths(root, c, { pathMemo: pathMemoOf(options) })).map((record) =>
    annotateDecision(record, input),
  )
  const open = annotated.filter((record) => record.status === 'open').sort(decisionOpenOrder)
  const counts = {
    open: open.length,
    blocking: open.filter(
      (record) => Array.isArray(record.blocks) && record.blocks.length > 0 && Array.isArray(record.affects) && record.affects.length > 0,
    ).length,
    escalated: open.filter((record) => record.escalated === true).length,
    answered: annotated.filter((record) => record.status === 'answered').length,
    withdrawn: annotated.filter((record) => record.status === 'withdrawn').length,
    superseded: annotated.filter((record) => record.status === 'superseded').length,
    total: annotated.length,
  }
  const limit = Number.isInteger(input.limit) && input.limit >= 0 ? input.limit : null
  return { items: limit === null ? open : open.slice(0, limit), counts }
}

/** One staged file against one decision's affects entries (file === prefix or below it). */
function decisionAffectsMatch(affects, stagedPath) {
  for (const entry of affects) {
    if (stagedPath === entry) return true
    if (stagedPath.startsWith(`${entry}/`)) return true
  }
  return false
}

/** Staged paths for `check decisions`: the explicit override, else `git diff --cached`. */
function decisionStagedFiles(root, options) {
  if (Array.isArray(options.staged)) {
    return options.staged
      .map((item) => String(item ?? '').trim().replace(/\\/g, '/'))
      .filter((item) => item !== '')
  }
  const result = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error !== undefined && result.error !== null) {
    throw new FlowError('io', `git diff --cached failed: ${result.error.message}`)
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const detail = String(result.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''
    throw new FlowError('io', `git diff --cached failed${detail === '' ? '' : `: ${detail}`}`)
  }
  return String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * The blocking-decision gate (`flow check decisions`, read-only, never writes):
 * fails when an open decision with a non-empty `blocks` declares an `affects`
 * prefix that matches one of the staged files.
 * @param {{staged?:string[]}} [options] `staged` overrides git (tests/callers)
 * @returns {{open:number, blocking:number, staged:string[], failed:object[]}}
 */
export function checkDecisions(root, contract, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const open = decisionRecords(storePaths(root, c)).filter((record) => record.status === 'open')
  const blocking = open.filter(
    (record) => Array.isArray(record.blocks) && record.blocks.length > 0 && Array.isArray(record.affects) && record.affects.length > 0,
  )
  const staged = decisionStagedFiles(root, input)
  const failed = []
  for (const record of blocking) {
    const matched = staged.filter((file) => decisionAffectsMatch(record.affects, file))
    if (matched.length === 0) continue
    failed.push({
      id: record.id,
      question: record.question,
      blocks: record.blocks,
      affects: record.affects,
      matched,
    })
  }
  return { open: open.length, blocking: blocking.length, staged, failed }
}

const TAIL_LINE_MAX = 400
const OUTPUT_CAP = 512 * 1024

function tailText(output, lines) {
  const all = output.split(/\r?\n/)
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  return all
    .slice(Math.max(0, all.length - lines))
    .map((line) => (line.length > TAIL_LINE_MAX ? line.slice(0, TAIL_LINE_MAX) : line))
    .join('\n')
}

const EXPECT_EXIT_RE = /^exit\s+(-?\d+)$/i
const EXPECT_CONTAINS_RE = /^contains\s*[:：]\s*([\s\S]*)$/i

/** True for the two documented `expect` forms (`exit N`, `contains: TEXT`) and the empty default. */
function expectSyntaxKnown(expect) {
  const text = typeof expect === 'string' ? expect.trim() : ''
  return text === '' || EXPECT_EXIT_RE.test(text) || EXPECT_CONTAINS_RE.test(text)
}

function evaluateExpect(expect, exit, output, timedOut) {
  const text = typeof expect === 'string' ? expect.trim() : ''
  if (timedOut) return false
  const exitMatch = EXPECT_EXIT_RE.exec(text)
  if (exitMatch !== null) return exit === Number(exitMatch[1])
  const containsMatch = EXPECT_CONTAINS_RE.exec(text)
  if (containsMatch !== null) return output.includes(containsMatch[1])
  if (text === '') return exit === 0
  noteWarning(`gate-expect-unknown: ${JSON.stringify(expect)} treated as "exit 0"`)
  return exit === 0
}

function killTree(child) {
  try {
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      process.kill(-child.pid, 'SIGKILL')
      return
    }
  } catch {
    // fall back to the direct child
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
}

function runStep(root, step, timeoutMs, tailLines) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    let output = ''
    let timedOut = false
    let settled = false
    const append = (chunk) => {
      output += String(chunk)
      if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP)
    }
    let child
    try {
      child = spawn(step.run, { shell: true, cwd: root, detached: process.platform !== 'win32' })
    } catch (error) {
      append(error.message)
      resolvePromise({
        id: step.id,
        run: step.run,
        expect: step.expect,
        exit: null,
        ok: false,
        durationMs: Date.now() - started,
        tail: tailText(output, tailLines),
      })
      return
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const exit = typeof code === 'number' ? code : null
      resolvePromise({
        id: step.id,
        run: step.run,
        expect: step.expect,
        exit,
        ok: evaluateExpect(step.expect, exit, output, timedOut),
        durationMs: Date.now() - started,
        tail: tailText(output, tailLines),
      })
    }
    child.on('error', (error) => {
      append(`\n${error.message}`)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

function isoFileStamp(date) {
  return formatIso(date).replace(/:/g, '-').replace(/\./g, '-')
}

/**
 * Run one gate: steps execute in order, the first failure stops the run, and
 * the merged output is written to `.dsh/flow/logs/<gateId>/<timestamp>.json`.
 */
export async function runGate(root, contract, id, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c)
  const gate = readRecord(paths.gates, id, 'gate')
  if (gate.enabled === false && options.force !== true) {
    throw new FlowError('usage', `gate ${id} is disabled; pass --force to run it`)
  }
  const steps = Array.isArray(gate.steps) ? gate.steps : []
  const tailLines = Number.isFinite(options.tailLines) && options.tailLines > 0 ? Math.floor(options.tailLines) : 40
  const override = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : null
  const startedAt = new Date()
  const results = []
  let ok = true
  for (const step of steps) {
    const perStep = Number.isInteger(step.timeoutSeconds) && step.timeoutSeconds > 0 ? step.timeoutSeconds : 600
    const timeoutMs = override !== null ? override : perStep * 1000
    const result = await runStep(root, step, timeoutMs, tailLines)
    results.push(result)
    if (result.ok !== true) {
      ok = false
      break
    }
  }
  const finishedAt = new Date()
  const record = {
    gate: gate.id,
    title: gate.title,
    started_at: formatIso(startedAt),
    finished_at: formatIso(finishedAt),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok,
    steps: results,
  }
  const logDir = join(paths.logs, gate.id)
  withLock(root, c, () => writeJsonAtomic(join(logDir, `${isoFileStamp(startedAt)}.json`), record))
  return record
}

/**
 * Run every enabled gate of one phase, in ascending id order. Disabled gates
 * are skipped instead of failing, and one failing/throwing gate never stops
 * the remaining ones: the caller gets the whole summary at the end.
 * @returns {Promise<{phase:string, runs:object[], skipped:{id:string,reason:string}[]}>}
 */
export async function runGatesByPhase(root, contract, phase, options = {}) {
  if (!GATE_PHASES.includes(phase)) throw invalid(`phase must be one of ${GATE_PHASES.join(', ')}`)
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const opts = isPlainObject(options) ? options : {}
  const force = opts.force === true
  const passThrough = { force }
  if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) passThrough.timeoutMs = Math.floor(opts.timeoutMs)
  if (Number.isFinite(opts.tailLines) && opts.tailLines > 0) passThrough.tailLines = Math.floor(opts.tailLines)

  const gates = listGates(root, c)
    .filter((gate) => gate.phase === phase)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))

  const runs = []
  const skipped = []
  for (const gate of gates) {
    // A disabled gate is skipped even with force: batch runs follow the switch.
    if (gate.enabled === false) {
      skipped.push({ id: gate.id, reason: 'disabled' })
      continue
    }
    try {
      runs.push(await runGate(root, c, gate.id, passThrough))
    } catch (error) {
      if (!(error instanceof FlowError)) throw error
      runs.push({
        gate: gate.id,
        title: gate.title,
        ok: false,
        steps: [],
        error: { code: error.code, message: error.message },
      })
    }
  }
  return { phase, runs, skipped }
}

/**
 * Most recent run records for a gate, newest first.
 *
 * @param {string} root project root
 * @param {object} contract flow contract
 * @param {string} gateId gate id
 * @param {number} [limit] newest records to keep
 * @param {{pathMemo?: Map<string,string|Error>}} [options] per-request realpath memo
 */
export function listGateRuns(root, contract, gateId, limit = 5, options = {}) {
  const memo = pathMemoOf(options)
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c, { pathMemo: memo })
  assertSafeId(gateId, 'gate id')
  const items = readCollection(join(paths.logs, gateId))
  items.sort((left, right) => timeValue(right.record.started_at) - timeValue(left.record.started_at))
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 5
  return items.slice(0, size).map((item) => item.record)
}

// ------------------------------------------------------------- heartbeats

const MAX_HEARTBEAT_CLIP = 400

/** `agent` value old automation wrote for a subagent run; read-side legacy marker. */
const LEGACY_SUBAGENT_AGENT = 'subagent'

// --------------------------------------------------- heartbeat workspace root
//
// A heartbeat belongs to the *project*, not to one checkout: every main session
// of the same project — including one whose cwd is a linked git worktree — must
// see and update the same ledger. The work root is therefore the project's main
// worktree, resolved with git; when git cannot answer the given cwd is used and
// a warning is recorded.

const MAIN_WORKSPACE_CACHE = new Map()
const GIT_PROBE_TIMEOUT_MS = 4000
const GIT_PROBE_MAX_BUFFER = 4 * 1024 * 1024

/** Trimmed stdout of one git probe; `undefined` on any failure (missing git included). */
function gitProbe(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: GIT_PROBE_TIMEOUT_MS,
    maxBuffer: GIT_PROBE_MAX_BUFFER,
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) return undefined
  return typeof result.stdout === 'string' ? result.stdout.trim() : undefined
}

/** Absolute path of the repo's main worktree, or `undefined` when unresolvable. */
function gitMainWorktree(dir) {
  // `worktree list --porcelain` prints the main worktree first, with an absolute path.
  const listed = gitProbe(dir, ['worktree', 'list', '--porcelain'])
  if (listed !== undefined) {
    for (const line of listed.split('\n')) {
      if (line.startsWith('worktree ') === false) continue
      const candidate = line.slice('worktree '.length).trim()
      if (candidate !== '') return resolve(candidate)
    }
  }
  // Fallback: the common dir is `<main>/.git` even from a linked worktree.
  const commonDir = gitProbe(dir, ['rev-parse', '--git-common-dir'])
  if (commonDir !== undefined && commonDir !== '') return dirname(resolve(dir, commonDir))
  return undefined
}

/**
 * Resolve the work root of the heartbeat ledger: the project's main worktree.
 *
 * - no `.git` entry → the directory is not a repo; it is its own root (silent);
 * - main worktree resolved and initialized → that root, so every session writes
 *   the same ledger even from a linked worktree;
 * - git fails or the main worktree has no store → degrade to `root` with a
 *   warning (`heartbeat-root-degraded`).
 *
 * @returns {{root:string, degraded:boolean, reason:string}}
 */
export function resolveHeartbeatWorkspace(root) {
  const absRoot = resolve(root)
  const cached = MAIN_WORKSPACE_CACHE.get(absRoot)
  if (cached !== undefined) return cached

  let entry
  if (existsSync(join(absRoot, '.git')) === false) {
    entry = { root: absRoot, degraded: false, reason: '' }
  } else {
    const main = gitMainWorktree(absRoot)
    if (main === undefined) {
      entry = { root: absRoot, degraded: true, reason: 'git worktree lookup failed' }
    } else if (main === absRoot) {
      entry = { root: absRoot, degraded: false, reason: '' }
    } else if (existsSync(join(main, CONTRACT_REL)) === false) {
      entry = {
        root: absRoot,
        degraded: true,
        reason: `main worktree ${toPosix(main)} has no flow store`,
      }
    } else {
      entry = { root: main, degraded: false, reason: '' }
    }
  }
  MAIN_WORKSPACE_CACHE.set(absRoot, entry)
  return entry
}

/** {@link resolveHeartbeatWorkspace}, recording the degraded case as a diagnostic. */
function heartbeatWorkspace(root) {
  const resolved = resolveHeartbeatWorkspace(root)
  if (resolved.degraded === true) {
    noteWarning(`heartbeat-root-degraded: ${toPosix(resolve(root))}: ${resolved.reason}`)
  }
  return resolved
}

function clipText(value, max = MAX_HEARTBEAT_CLIP) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Parse a heartbeat stamp. Loose "YYYY-MM-DD HH:MM[:SS]" values are read as
 * local time (host behaviour); anything else goes through Date.parse.
 */
function parseHeartbeatStamp(value) {
  if (typeof value !== 'string') return Number.NaN
  const text = value.trim()
  if (text.length === 0) return Number.NaN
  const loose = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (loose !== null) {
    return new Date(
      Number(loose[1]),
      Number(loose[2]) - 1,
      Number(loose[3]),
      Number(loose[4]),
      Number(loose[5]),
      loose[6] === undefined ? 0 : Number(loose[6]),
    ).getTime()
  }
  return Date.parse(text)
}

// --------------------------------------------------- heartbeat liveness
//
// A heartbeat file alone cannot prove its session still exists; these helpers
// add machine/boot/pid evidence so a finished session stops looking active.
// The evidence is written by the *host* process only: a one-shot CLI process
// must not record its own pid (it dies immediately and would mark a healthy
// session dead), so the CLI path writes `host` and nothing else.

const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id'
let cachedBootId = null

/** Boot id of this machine (`''` when the platform does not expose one). */
function currentBootId() {
  if (cachedBootId !== null) return cachedBootId
  try {
    cachedBootId = readFileSync(BOOT_ID_FILE, 'utf8').trim()
  } catch {
    cachedBootId = ''
  }
  return cachedBootId
}

/**
 * Whether this process is the one-shot CLI (`bin/flow.mjs`). The CLI must not
 * write pid evidence; the plugin host (the DSH process) does.
 */
function isFlowCliEntrypoint() {
  const entry = typeof process.argv[1] === 'string' ? process.argv[1].replace(/\\/g, '/') : ''
  return /(^|\/)bin\/flow\.mjs$/.test(entry)
}

/** `/proc/<pid>` start time (field 22), or null where `/proc` is unavailable. */
function pidStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  let text
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return null
  }
  // comm may contain spaces/parens: split after the last ')'.
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const fields = text.slice(close + 1).trim().split(/\s+/)
  const start = Number(fields[19])
  return Number.isFinite(start) ? start : null
}

/** True when the pid exists (EPERM still means a live process). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error !== null && error !== undefined && error.code === 'EPERM'
  }
}

/**
 * The liveness evidence already stored in a record. Used to carry proof across
 * CLI writes instead of replacing it with the one-shot CLI process's identity.
 */
function heartbeatEvidenceOf(record) {
  const evidence = {}
  if (!isPlainObject(record)) return evidence
  if (typeof record.host === 'string' && record.host.trim() !== '') evidence.host = record.host.trim()
  if (typeof record.boot_id === 'string' && record.boot_id.trim() !== '') evidence.boot_id = record.boot_id.trim()
  if (Number.isInteger(record.pid) && record.pid > 0) evidence.pid = record.pid
  if (Number.isFinite(record.pid_start) && record.pid_start > 0) evidence.pid_start = record.pid_start
  return evidence
}

/** `writer: 'cli'` lets the CLI declare its one-shot nature explicitly; argv is the fallback. */
function isCliWriter(writer) {
  if (writer === 'cli') return true
  if (writer === 'host') return false
  return isFlowCliEntrypoint()
}

/**
 * Liveness evidence written into a heartbeat record by the current process.
 * Host: `{host, boot_id, pid, pid_start}` (fresh proof).
 * CLI: **never overwrites existing proof** — it keeps `host`/`boot_id`/`pid`/
 * `pid_start` already in the record and only fills `host` when the record has
 * none. A one-shot CLI process must not turn a live session (or a record written
 * on another machine) into a dead one.
 */
function heartbeatWriterEvidence(existing, writer) {
  if (isCliWriter(writer)) {
    const evidence = heartbeatEvidenceOf(existing)
    if (evidence.host === undefined) evidence.host = hostTag()
    return evidence
  }
  const evidence = { host: hostTag() }
  const bootId = currentBootId()
  if (bootId !== '') evidence.boot_id = bootId
  evidence.pid = process.pid
  const start = pidStartTime(process.pid)
  if (start !== null) evidence.pid_start = start
  return evidence
}

/** Age of one heartbeat record in seconds (`updated_at`, else record/file mtime). */
function heartbeatAgeOf(record, now, fallbackMtime) {
  if (!isPlainObject(record)) return Number.POSITIVE_INFINITY
  const stamp = parseHeartbeatStamp(record.updated_at)
  const reference = Number.isFinite(stamp)
    ? stamp
    : Number.isFinite(record.mtime)
      ? record.mtime
      : Number.isFinite(fallbackMtime)
        ? fallbackMtime
        : Number.NaN
  if (!Number.isFinite(reference)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor((now - reference) / 1000))
}

/**
 * Pure liveness verdict for one heartbeat record (no writes, no warnings).
 *
 * Evidence order: a different `host` is `foreign`; a different `boot_id` on the
 * same machine is `dead` (host restarted); a recorded pid that is gone, or whose
 * `/proc` start time no longer matches (`pid_start`), is `dead`; otherwise the
 * pid proves `live`. Records without any liveness evidence (legacy files, or a
 * CLI-written `host`-only record) fall back to the 6 h age rule: fresh →
 * `unknown`, old → `stale`. Age uses `updated_at`; when that is unparseable it
 * falls back to the record's `mtime` or the caller-supplied file mtime.
 *
 * @param {object} record heartbeat JSON record
 * @param {{now?:number, host?:string, bootId?:string, mtime?:number}} [options] injectable clock/identity
 * @returns {{liveness:'live'|'dead'|'stale'|'foreign'|'unknown', reason:string, ageSeconds:number}}
 */
export function livenessOf(record, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const host = typeof input.host === 'string' && input.host !== '' ? input.host : hostTag()
  const bootId = typeof input.bootId === 'string' ? input.bootId : currentBootId()
  const ageSeconds = heartbeatAgeOf(record, now, Number.isFinite(input.mtime) ? input.mtime : undefined)
  if (!isPlainObject(record)) return { liveness: 'unknown', reason: 'no-record', ageSeconds }

  const recordHost = typeof record.host === 'string' ? record.host.trim() : ''
  const recordBoot = typeof record.boot_id === 'string' ? record.boot_id.trim() : ''
  const pid = Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null
  const pidStart = Number.isFinite(record.pid_start) && record.pid_start > 0 ? record.pid_start : null

  if (recordHost !== '' && recordHost !== host) {
    return { liveness: 'foreign', reason: 'other-host', ageSeconds }
  }
  if (recordBoot !== '' && bootId !== '' && recordBoot !== bootId) {
    return { liveness: 'dead', reason: 'boot-changed', ageSeconds }
  }
  if (pid !== null) {
    if (pidAlive(pid) !== true) return { liveness: 'dead', reason: 'pid-gone', ageSeconds }
    const actualStart = pidStartTime(pid)
    if (pidStart !== null && actualStart !== null && actualStart !== pidStart) {
      return { liveness: 'dead', reason: 'pid-reused', ageSeconds }
    }
    return { liveness: 'live', reason: 'pid-alive', ageSeconds }
  }
  if (ageSeconds > HEARTBEAT_STALE_SECONDS) {
    return { liveness: 'stale', reason: 'no-liveness-evidence', ageSeconds }
  }
  return { liveness: 'unknown', reason: 'no-liveness-evidence', ageSeconds }
}

/**
 * Whether a heartbeat counts as active.
 *
 * `live` is exempt from the 6 h freshness fallback: a matching pid proves the
 * session still exists even if it stopped updating its heartbeat (the host may
 * be busy). `unknown` still needs to be fresh, and `dead`/`foreign`/`stale` are
 * never active.
 */
function heartbeatIsActive(activeStatus, liveness, ageSeconds) {
  if (activeStatus !== true) return false
  if (liveness === 'live') return true
  if (liveness === 'dead' || liveness === 'foreign' || liveness === 'stale') return false
  return ageSeconds <= HEARTBEAT_STALE_SECONDS
}

/** JSON heartbeat files under the heartbeat dir; a missing dir is silent. */
function heartbeatFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // A missing heartbeat directory is a normal, silent empty section.
    if (error.code === 'ENOENT') return []
    noteWarning(`heartbeat-dir-unreadable: ${toPosix(dir)}: ${error.message}`)
    return []
  }
  const files = []
  for (const entry of entries) {
    if (entry.isFile() !== true) continue
    if (!entry.name.toLowerCase().endsWith('.json')) continue
    files.push({ name: entry.name, path: join(dir, entry.name) })
  }
  return files
}

function readHeartbeatJson(file, now) {
  let stats
  let raw
  try {
    stats = statSync(file.path)
    raw = readFileSync(file.path, 'utf8')
  } catch (error) {
    noteWarning(`heartbeat-unreadable: ${file.name}: ${error.message}`)
    return null
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    noteWarning(`heartbeat-invalid: ${file.name}: ${error.message}`)
    return null
  }
  if (!isPlainObject(value)) {
    noteWarning(`heartbeat-invalid: ${file.name}: not a JSON object`)
    return null
  }
  // Old automation registered one heartbeat per subagent run; those records are
  // legacy data now and stay hidden from every read (a main-session ledger).
  if (value.agent === LEGACY_SUBAGENT_AGENT) return null
  const parts = []
  if (typeof value.status === 'string' && value.status.trim() !== '') parts.push(value.status.trim())
  if (typeof value.last_action === 'string' && value.last_action.trim() !== '') {
    parts.push(value.last_action.trim())
  }
  const statusLine = clipText(parts.join(' · '), 200)
  const stamp = parseHeartbeatStamp(value.updated_at)
  const reference = Number.isFinite(stamp) ? stamp : stats.mtimeMs
  return {
    file: file.name,
    title: clipText(file.name.replace(/\.[^.]+$/, '')),
    statusLine,
    ageSeconds: Math.max(0, Math.floor((now - reference) / 1000)),
    mtime: Math.round(stats.mtimeMs),
  }
}

/**
 * Heartbeats under `contract.heartbeats.dir` (`*.json`), newest first and
 * truncated to `contract.heartbeats.max`. Only `source: 'none'` disables the
 * section. The ledger root is the project's main worktree, so a session in a
 * linked worktree reads the same section. Records whose `agent` is `subagent`
 * are legacy automation and stay hidden.
 * Item shape kept for existing callers:
 * `{ file, title, statusLine, ageSeconds, mtime }` — the richer projection is
 * `readHeartbeatSection`.
 */
export function readHeartbeats(root, contract) {
  const absRoot = heartbeatWorkspace(root).root
  const c = normalizeContract(absRoot, contract)
  if (c.heartbeats.source === 'none') return []
  const dir = heartbeatDirPath(absRoot, c)
  const now = Date.now()
  const items = []
  for (const file of heartbeatFiles(dir)) {
    const item = readHeartbeatJson(file, now)
    if (item !== null) items.push(item)
  }
  items.sort((left, right) => right.mtime - left.mtime || String(left.file).localeCompare(String(right.file)))
  return items.slice(0, heartbeatMax(c))
}

/** Absolute heartbeat directory for one contract (always inside the project root). */
function heartbeatDirPath(absRoot, c, memo) {
  const configured = c.heartbeats && typeof c.heartbeats.dir === 'string' ? c.heartbeats.dir.trim() : ''
  const fallback = join(absRoot, '.agents/heartbeat')
  return containedDir(absRoot, configured, 'heartbeats.dir', fallback, memo)
}

function heartbeatMax(c) {
  const requested = Number(c.heartbeats.max)
  return Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 20
}

/** Rich projection of one JSON heartbeat (`schema: 1`); optional liveness context. */
function richHeartbeatJson(file, now, context) {
  let stats
  let raw
  try {
    stats = statSync(file.path)
    raw = readFileSync(file.path, 'utf8')
  } catch (error) {
    noteWarning(`heartbeat-unreadable: ${file.name}: ${error.message}`)
    return null
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    noteWarning(`heartbeat-invalid: ${file.name}: ${error.message}`)
    return null
  }
  if (!isPlainObject(value)) {
    noteWarning(`heartbeat-invalid: ${file.name}: not a JSON object`)
    return null
  }
  const stamp = parseHeartbeatStamp(value.updated_at)
  const reference = Number.isFinite(stamp) ? stamp : stats.mtimeMs
  const ageSeconds = Math.max(0, Math.floor((now - reference) / 1000))
  const status = typeof value.status === 'string' ? value.status.trim() : ''
  const stem = file.name.replace(/\.[^.]+$/, '')
  const agent = typeof value.agent === 'string' ? value.agent : ''
  // Read-side marker for records written by the removed subagent automation:
  // projected but never rendered, and removed by `gcLegacyHeartbeats`.
  const legacy = agent === LEGACY_SUBAGENT_AGENT
  const item = {
    file: file.name,
    session: typeof value.session === 'string' && value.session.trim() !== '' ? value.session.trim() : stem,
    agent,
    legacy,
    hidden: legacy,
    goal: typeof value.goal === 'string' ? value.goal : '',
    task: typeof value.task === 'string' && value.task !== '' ? value.task : null,
    claims: Array.isArray(value.claims) ? value.claims.filter((entry) => typeof entry === 'string') : [],
    status,
    last_action: typeof value.last_action === 'string' ? value.last_action : '',
    started_at: typeof value.started_at === 'string' ? value.started_at : null,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : null,
    ended_at: typeof value.ended_at === 'string' ? value.ended_at : null,
    ageSeconds,
    stale: ageSeconds > HEARTBEAT_STALE_SECONDS,
    turn: Number.isInteger(value.turn) ? value.turn : null,
    stats: isPlainObject(value.stats) ? deepClone(value.stats) : null,
    mtime: Math.round(stats.mtimeMs),
  }
  // Liveness is judged from the raw record (host/boot_id/pid/pid_start), and
  // only the verdict is projected: the evidence itself stays in the file.
  if (context !== undefined && context !== null) {
    const verdict = livenessOf(value, {
      now,
      host: typeof context.host === 'string' ? context.host : undefined,
      bootId: typeof context.bootId === 'string' ? context.bootId : undefined,
      // F2: an unparseable `updated_at` still gets a real age from the file mtime.
      mtime: Math.round(stats.mtimeMs),
    })
    item.liveness = verdict.liveness
    item.reason = verdict.reason
  }
  return item
}


/**
 * Aggregate heartbeat section reused by `readStoreState` and the CLI.
 * Items carry the full heartbeat fields plus `ageSeconds` / `stale` / `mtime`;
 * counts are `{ total, active, stale, hidden }` where active means working|idle
 * and hidden counts legacy subagent records excluded from `items`.
 * `root` is the resolved ledger root (the project's main worktree).
 *
 * @param {string} root project root
 * @param {object} contract flow contract
 * @param {{pathMemo?: Map<string,string|Error>}} [options] per-request realpath memo
 */
export function readHeartbeatSection(root, contract, options = {}) {
  const memo = pathMemoOf(options)
  const workspace = heartbeatWorkspace(root)
  const absRoot = workspace.root
  const c = normalizeContract(absRoot, contract)
  const base = {
    root: toPosix(absRoot),
    ...(workspace.degraded === true ? { degraded: true, reason: workspace.reason } : {}),
  }
  if (c.heartbeats.source === 'none') {
    const configured = typeof c.heartbeats.dir === 'string' ? c.heartbeats.dir.trim() : ''
    return {
      ...base,
      dir: configured === '' ? '.agents/heartbeat' : toPosix(configured),
      items: [],
      counts: { total: 0, active: 0, stale: 0, dead: 0, hidden: 0 },
    }
  }
  const dir = heartbeatDirPath(absRoot, c, memo)
  // Report the directory actually read, so a rejected manifest value is not
  // echoed back as if it had been used.
  const dirLabel = toPosix(relative(absRoot, dir)) || '.'
  const now = Date.now()
  const context = { host: hostTag(), bootId: currentBootId() }
  const items = []
  let hidden = 0
  for (const file of heartbeatFiles(dir)) {
    const item = richHeartbeatJson(file, now, context)
    if (item === null) continue
    if (item.hidden === true) {
      hidden += 1
      continue
    }
    items.push(item)
  }
  items.sort((left, right) => right.mtime - left.mtime || String(left.file).localeCompare(String(right.file)))
  const limited = items.slice(0, heartbeatMax(c))
  // A heartbeat is active only when its status says so AND its session is not
  // provably dead/foreign AND the 6 h freshness fallback still holds. A stale
  // record therefore no longer counts as active (the user-visible bug fix).
  const isActive = (item) =>
    heartbeatIsActive(HEARTBEAT_ACTIVE_STATUS.includes(item.status), item.liveness, item.ageSeconds)
  return {
    ...base,
    dir: dirLabel,
    items: limited,
    counts: {
      total: limited.length,
      active: limited.filter(isActive).length,
      stale: limited.filter((item) => item.stale === true).length,
      dead: limited.filter((item) => item.liveness === 'dead').length,
      hidden,
    },
  }
}

// --------------------------------------------------- heartbeat write API

/**
 * Validate a session id that doubles as a file name: no separators, no `..`,
 * no control characters, at most 80 characters.
 */
function assertSessionName(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FlowError('usage', 'heartbeat session is required (pass --session or set DSH_SESSION_ID)')
  }
  const session = value.trim()
  if (session.length > HEARTBEAT_SESSION_MAX) {
    throw invalid(`heartbeat session is too long (max ${HEARTBEAT_SESSION_MAX}): ${session.length}`)
  }
  if (session.includes('..') || session.includes('/') || session.includes('\\') || /[\u0000-\u001f\u007f]/.test(session)) {
    throw invalid(`heartbeat session is not a safe file name: ${JSON.stringify(session)}`)
  }
  return session
}

/** Explicit session wins, then `DSH_SESSION_ID`; nothing means usage error. */
function resolveHeartbeatSession(value) {
  const explicit = typeof value === 'string' ? value.trim() : ''
  const fromEnv = typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID.trim() : ''
  return assertSessionName(explicit !== '' ? explicit : fromEnv)
}

/** Trimmed, bounded claims; empty entries are dropped. */
function normalizeClaims(value, label = 'claims') {
  const list = stringArray(value, label)
  const claims = []
  for (const item of list) {
    const claim = item.trim()
    if (claim === '') continue
    if (claim.length > HEARTBEAT_CLAIM_MAX) throw invalid(`${label} entry is too long (max ${HEARTBEAT_CLAIM_MAX})`)
    claims.push(claim)
  }
  return claims
}

/** Read one heartbeat file; `null` when it does not exist, `io` when unreadable. */
function readHeartbeatRecord(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new FlowError('io', `cannot read ${toPosix(file)}: ${error.message}`)
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) throw new Error('record is not a JSON object')
    return parsed
  } catch (error) {
    throw new FlowError('io', `invalid heartbeat record ${toPosix(file)}: ${error.message}`)
  }
}

/**
 * The task a session currently works on, by descending priority:
 * 1. owned by this session; 2. owned by the session's agent — real owners are
 * usually role names (`lead`, `agent-a`) rather than session ids, so an exact
 * session match alone misses in-flight cards; 3. the oldest **unowned** `active`
 * task and 4. the oldest **unowned** `draft` task. The queue is FIFO: candidates
 * are ordered by `created_at` ascending (missing/unparseable `created_at` sorts
 * last), so a patched card keeps its place instead of jumping to the front;
 * `updated_at` is no longer a claim ordering key.
 *
 * Rules 3 and 4 skip tasks that name another owner: a parallel session or a
 * subagent must not attach its heartbeat — or its exclusive `claims` — to a card
 * somebody else is working on. Falls back to `null`, and the caller then decides
 * whether to create a task.
 */
function pickSessionTask(records, { session = '', agent = '' } = {}) {
  const candidates = records.filter((record) => typeof record.id === 'string')
  const oldest = (predicate) => {
    const hits = candidates.filter(predicate)
    return hits.length === 0 ? null : sortByCreatedAsc(hits)[0]
  }
  const unowned = (record) => (typeof record.owner === 'string' ? record.owner.trim() === '' : true)
  return oldest((record) => record.owner === session)
    ?? oldest((record) => agent !== '' && record.owner === agent)
    ?? oldest((record) => unowned(record) && record.status === 'active')
    ?? oldest((record) => unowned(record) && record.status === 'draft')
    ?? null
}

function heartbeatTaskClaims(task) {
  return task !== null && isPlainObject(task.scope) && Array.isArray(task.scope.allow)
    ? task.scope.allow.filter((item) => typeof item === 'string')
    : []
}

/**
 * Open (or refresh) this session's heartbeat. A repeated start keeps the first
 * `started_at`, increments `turn` / `stats.turns`, clears `ended_at` and resets
 * `status` to `working`. When no task is given it reuses the task picked by
 * `pickSessionTask` (session owner, then agent owner, then oldest active, then
 * oldest draft — FIFO by `created_at`) and — unless `createTask: false` — creates a draft task owned
 * by the session only when none matched, so the returned id can be written
 * back. An explicit `task` wins and must exist.
 *
 * @returns heartbeat record plus `createdTask` (new task id or `null`).
 */
export function startHeartbeat(root, contract, options = {}) {
  const absRoot = heartbeatWorkspace(root).root
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const input = isPlainObject(options) ? options : {}
  const session = resolveHeartbeatSession(input.session)
  const goalInput = typeof input.goal === 'string' && input.goal.trim() !== '' ? input.goal.trim() : null
  const claimsInput = input.claims === undefined || input.claims === null ? null : normalizeClaims(input.claims)
  const requestedTask = input.task === undefined || input.task === null ? '' : String(input.task).trim()
  const file = join(heartbeatDirPath(absRoot, c), `${session}.json`)

  return withLock(absRoot, c, (paths) => {
    const records = readCollection(paths.tasks).map((item) => item.record)
    const previous = readHeartbeatRecord(file)
    /* Resolved before task selection: the effective agent (`--agent`, else the
       previous heartbeat's) takes part in picking the task to reuse. */
    const agent = input.agent === undefined || input.agent === null
      ? (previous !== null && typeof previous.agent === 'string' ? previous.agent : '')
      : optionalText(input.agent, 'agent', '')
    let task = null
    if (requestedTask !== '') {
      task = records.find((record) => record.id === requestedTask) ?? null
      if (task === null) throw new FlowError('not-found', `task ${requestedTask} not found`)
    } else {
      task = pickSessionTask(records, { session, agent })
    }

    const goal = goalInput ?? (task !== null && typeof task.title === 'string' ? task.title : '未命名任务')
    let createdTask = null
    if (task === null && input.createTask !== false) {
      createdTask = buildTask(
        { title: goal, status: 'draft', owner: session, scope: { allow: claimsInput ?? [] } },
        { existingIds: taskIds(paths) },
      )
      assertTargetFree(paths.tasks, createdTask.id)
      writeJsonAtomic(join(paths.tasks, `${createdTask.id}.json`), createdTask)
      task = createdTask
    }

    const claims = claimsInput ?? heartbeatTaskClaims(task)

    let turn
    if (input.turn !== undefined && input.turn !== null) {
      turn = optionalInt(input.turn, 'turn', 1, 1)
    } else if (previous !== null && Number.isInteger(previous.turn) && previous.turn >= 0) {
      turn = previous.turn + 1
    } else {
      turn = 1
    }

    const previousStats = previous !== null && isPlainObject(previous.stats) ? previous.stats : null
    const previousTurns = previousStats !== null && Number.isInteger(previousStats.turns) && previousStats.turns >= 0
      ? previousStats.turns
      : null
    const missed = previousStats !== null && Number.isInteger(previousStats.missed) && previousStats.missed >= 0
      ? previousStats.missed
      : 0

    const previousAction = previous !== null && typeof previous.last_action === 'string' ? previous.last_action : ''
    const lastAction = input.last_action === undefined || input.last_action === null
      ? previousAction
      : optionalText(input.last_action, 'last_action', '')
    const startedAt = previous !== null && typeof previous.started_at === 'string' && previous.started_at.trim() !== ''
      ? previous.started_at
      : formatIso()

    const record = {
      schema: HEARTBEAT_SCHEMA,
      session,
      agent,
      goal,
      task: task !== null && typeof task.id === 'string' ? task.id : null,
      claims,
      status: 'working',
      turn,
      last_action: lastAction,
      started_at: startedAt,
      updated_at: formatIso(),
      ended_at: null,
      // CLI writers keep prior machine/pid proof; host writers refresh it (F1).
      ...heartbeatWriterEvidence(previous, input.writer),
      stats: { turns: previous === null ? turn : (previousTurns === null ? 1 : previousTurns + 1), missed },
    }
    writeJsonAtomic(file, record)
    return { ...record, createdTask: createdTask === null ? null : createdTask.id }
  })
}

/**
 * Patch one heartbeat record. Only `status` / `last_action` / `goal` / `task` /
 * `claims` / `turn` are accepted; anything else is `invalid` and `updated_at`
 * refreshes automatically.
 *
 * `options.writer: 'cli'` marks a one-shot CLI write: it never replaces the
 * record's liveness evidence (host/boot_id/pid/pid_start), only fills a missing
 * `host`. Host writers refresh all four fields.
 */
export function updateHeartbeat(root, contract, session, patch, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const writer = input.writer
  const absRoot = heartbeatWorkspace(root).root
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const name = resolveHeartbeatSession(session)
  if (!isPlainObject(patch)) throw invalid('heartbeat patch must be an object')
  for (const key of Object.keys(patch)) {
    if (!HEARTBEAT_PATCH_KEYS.includes(key)) throw invalid(`heartbeat ${key} cannot be changed`)
  }
  const file = join(heartbeatDirPath(absRoot, c), `${name}.json`)

  return withLock(absRoot, c, () => {
    const current = readHeartbeatRecord(file)
    if (current === null) throw new FlowError('not-found', `heartbeat ${name} not found`)
    const next = { ...current, schema: HEARTBEAT_SCHEMA, session: name }
    if (Object.hasOwn(patch, 'status')) {
      if (typeof patch.status !== 'string' || !HEARTBEAT_STATUS.includes(patch.status)) {
        throw invalid(`status must be one of ${HEARTBEAT_STATUS.join(', ')}`)
      }
      next.status = patch.status
    }
    if (Object.hasOwn(patch, 'last_action')) next.last_action = optionalText(patch.last_action, 'last_action', '')
    if (Object.hasOwn(patch, 'goal')) next.goal = optionalText(patch.goal, 'goal', '')
    if (Object.hasOwn(patch, 'task')) next.task = patch.task === null ? null : requireText(patch.task, 'task')
    if (Object.hasOwn(patch, 'claims')) next.claims = normalizeClaims(patch.claims)
    if (Object.hasOwn(patch, 'turn')) next.turn = optionalInt(patch.turn, 'turn', 1, 1)
    next.updated_at = formatIso()
    // Refresh host evidence (a CLI process contributes only `host`; existing
    // pid evidence is kept so a CLI edit does not erase a live host's proof).
    Object.assign(next, heartbeatWriterEvidence(current, writer))
    writeJsonAtomic(file, next)
    return next
  })
}

/**
 * Close one heartbeat: default `status: 'done'`, stamp `ended_at` and fold a
 * non-empty `note` into `last_action`. The file stays on disk (the panel keeps
 * listing it).
 */
export function endHeartbeat(root, contract, options = {}) {
  const absRoot = heartbeatWorkspace(root).root
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const input = isPlainObject(options) ? options : {}
  const session = resolveHeartbeatSession(input.session)
  const status = input.status === undefined || input.status === null ? 'done' : input.status
  if (typeof status !== 'string' || !HEARTBEAT_STATUS.includes(status)) {
    throw invalid(`status must be one of ${HEARTBEAT_STATUS.join(', ')}`)
  }
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  const file = join(heartbeatDirPath(absRoot, c), `${session}.json`)

  return withLock(absRoot, c, () => {
    const current = readHeartbeatRecord(file)
    if (current === null) throw new FlowError('not-found', `heartbeat ${session} not found`)
    const previousAction = typeof current.last_action === 'string' ? current.last_action.trim() : ''
    const now = formatIso()
    const next = {
      ...current,
      schema: HEARTBEAT_SCHEMA,
      session,
      status,
      last_action: note === '' ? previousAction : (previousAction === '' ? note : `${previousAction} · ${note}`),
      updated_at: now,
      ended_at: now,
      // CLI writers keep prior machine/pid proof; host writers refresh it (F1).
      ...heartbeatWriterEvidence(current, input.writer),
    }
    writeJsonAtomic(file, next)
    return next
  })
}

/**
 * Read one session heartbeat. `active` means the file exists, its status is
 * `working`/`idle`, its liveness is not provably dead/foreign, and either the
 * pid proves it live (`liveness: 'live'` is exempt from the age fallback) or the
 * 6 h freshness fallback still holds. A broken file is reported as inactive with
 * a warning. The verdict fields (`liveness`/`reason`/`ageSeconds`) are the same
 * ones `readHeartbeatSection` projects.
 *
 * `options.live: true` is the host's positive evidence (the `agents` service says
 * this session is alive): the verdict is overridden to `live`/`agent-live`, so a
 * busy session that has not refreshed its heartbeat for >6 h is still active.
 * This never fabricates a heartbeat: a missing record stays inactive.
 */
export function heartbeatStatus(root, contract, session, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const absRoot = heartbeatWorkspace(root).root
  const c = normalizeContract(absRoot, contract)
  const name = resolveHeartbeatSession(session)
  const file = join(heartbeatDirPath(absRoot, c), `${name}.json`)
  let record = null
  try {
    record = readHeartbeatRecord(file)
  } catch (error) {
    noteWarning(`heartbeat-invalid: ${name}.json: ${error.message}`)
  }
  let mtime
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    mtime = undefined
  }
  let verdict = livenessOf(record, { mtime })
  if (input.live === true && record !== null) {
    verdict = { ...verdict, liveness: 'live', reason: 'agent-live' }
  }
  const statusActive =
    record !== null && typeof record.status === 'string' && HEARTBEAT_ACTIVE_STATUS.includes(record.status)
  const active = heartbeatIsActive(statusActive, verdict.liveness, verdict.ageSeconds)
  return {
    active,
    liveness: verdict.liveness,
    reason: verdict.reason,
    ageSeconds: Number.isFinite(verdict.ageSeconds) ? verdict.ageSeconds : null,
    record,
  }
}

/**
 * Remove heartbeat files written by the removed subagent automation
 * (`agent: 'subagent'`). Those records are legacy: the read side already hides
 * them, and this is the explicit cleanup. The whole heartbeat dir is scanned.
 *
 * @param {string} root project root (a linked worktree resolves to the main one)
 * @param {object} contract flow contract
 * @param {{dryRun?:boolean}} [options] `dryRun: true` reports without deleting
 * @returns {{root:string, dir:string, removed:object[], kept:number, dryRun:boolean}}
 */
export function gcLegacyHeartbeats(root, contract, options = {}) {
  const absRoot = heartbeatWorkspace(root).root
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const input = isPlainObject(options) ? options : {}
  const dryRun = input.dryRun === true
  const dir = heartbeatDirPath(absRoot, c)
  const result = {
    root: toPosix(absRoot),
    dir: toPosix(relative(absRoot, dir)) || '.',
    removed: [],
    kept: 0,
    dryRun,
  }
  if (c.heartbeats.source === 'none') return result
  return withLock(absRoot, c, () => {
    for (const file of heartbeatFiles(dir)) {
      let record = null
      try {
        record = readHeartbeatRecord(file.path)
      } catch {
        // A broken record cannot be proven legacy; keep it and its warning.
        result.kept += 1
        continue
      }
      if (record === null || record.agent !== LEGACY_SUBAGENT_AGENT) {
        result.kept += 1
        continue
      }
      result.removed.push({
        file: file.name,
        session: typeof record.session === 'string' ? record.session : file.name.replace(/\.[^.]+$/, ''),
        status: typeof record.status === 'string' ? record.status : '',
      })
      if (dryRun === true) continue
      try {
        unlinkSync(file.path)
      } catch (error) {
        noteWarning(`heartbeat-gc-failed: ${file.name}: ${error.message}`)
      }
    }
    return result
  })
}


// ------------------------------------------------------------- aggregate

function summarizeRun(record) {
  const steps = Array.isArray(record.steps) ? record.steps : []
  return {
    gate: record.gate,
    title: record.title,
    started_at: record.started_at,
    finished_at: record.finished_at,
    durationMs: record.durationMs,
    ok: record.ok === true,
    steps: steps.map((step) => ({
      id: step.id,
      run: step.run,
      expect: step.expect,
      exit: typeof step.exit === 'number' ? step.exit : null,
      ok: step.ok === true,
      durationMs: step.durationMs,
    })),
  }
}

/**
 * Read-only aggregate for the panel: experiments/tasks/gates, the heartbeat
 * section and the decision projection. Never touches git or run output.
 *
 * @param {string} root project root
 * @param {object} contract flow contract
 * @param {{pathMemo?: Map<string,string|Error>}} [options] per-request realpath memo:
 *   one HTTP request / one TUI read shares it, so the same root or manifest path
 *   is resolved once instead of once per section. Omitted (CLI, tools), every
 *   containment check resolves again, exactly as before.
 */
export function readStoreState(root, contract, options = {}) {
  const memo = pathMemoOf(options)
  const c = normalizeContract(root, contract)
  const currentTask = typeof c.tasks.current === 'string' ? c.tasks.current : null
  // `tasks.current` names a file; an unsafe value is hidden from API consumers
  // just like an unreadable one (the Host validates it again for its payload).
  const current =
    currentTask !== null && containedPath(root, currentTask, 'tasks.current', { pathMemo: memo }) !== undefined
      ? currentTask
      : null
  // Broken records never vanish from the counts: they are skipped from `items`
  // (panel rows must stay valid) but reported next to the status counts.
  const unreadable = { experiments: [], tasks: [], gates: [] }
  const experiments = listExperiments(root, c, { unreadable: unreadable.experiments, pathMemo: memo })
  const tasks = listTasks(root, c, { unreadable: unreadable.tasks, pathMemo: memo })
  const gates = listGates(root, c, { unreadable: unreadable.gates, pathMemo: memo }).map((gate) => {
    const runs = listGateRuns(root, c, gate.id, 1, { pathMemo: memo })
    const last = runs.length > 0 ? runs[0] : null
    return { ...gate, lastRun: last === null ? null : summarizeRun(last) }
  })
  return {
    experiments: {
      source: c.experiments.source,
      items: experiments,
      counts: { ...statusCounts(experiments, EXPERIMENT_STATUS), unreadable: unreadable.experiments.length },
    },
    tasks: {
      source: c.tasks.source,
      current,
      items: tasks,
      counts: { ...statusCounts(tasks, TASK_STATUS), unreadable: unreadable.tasks.length },
    },
    gates: {
      items: gates,
      counts: {
        total: gates.length,
        enabled: gates.filter((gate) => gate.enabled !== false).length,
        unreadable: unreadable.gates.length,
      },
    },
    heartbeats: readHeartbeatSection(root, c, { pathMemo: memo }),
    // 决策投影与提醒/`flow status`/面板共用同一个 summarizeDecisions（同一排序、
    // 同一截断上限）；这里不带 session/turn，所以 turnAge 恒为 null，升级只看 24 小时。
    decisions: summarizeDecisions(root, c, { limit: DECISION_REMIND_MAX, pathMemo: memo }),
  }
}

