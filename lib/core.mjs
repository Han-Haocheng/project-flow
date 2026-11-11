/**
 * project-flow core (schema 2).
 *
 * The single writer for a project's flow store: contract, atomic writes, a
 * short-lived lock, experiment/task/gate CRUD and gate execution. Only node
 * built-ins are used, so the CLI, the agent tools and the read-only panel
 * all share this one module.
 *
 * Layout (root-relative, fixed unless the contract says otherwise):
 *   .agents/flow/flow.json
 *   .agents/experiments/<id>.json
 *   .agents/tasks/<id>.json
 *   .agents/gates/<id>.json
 *   .agents/decisions/<id>.json
 *   .agents/flow/logs/<gateId>/<timestamp>.json
 *   .agents/flow/.lock   (temporary, never committed or displayed)
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Split modules (task-49 / task-52). The store's low-level layers live in their
// own files; the names they contribute are re-exported below, so every existing
// import path and export name is unchanged.
import { FlowError, dateStamp, deepClone, formatIso, invalid, isPlainObject, nextTempSuffix, noteWarning, pad, timeStamp, timeValue, toPosix } from './util.mjs'
import { containedDir, containedPath, pathMemoOf } from './paths.mjs'
import {
  TASK_STATUS,
  addTask,
  applyTaskPatch,
  archiveTasks,
  buildTask,
  configureTasks,
  createsCycle,
  getTask,
  listTasks,
  normalizeParentInput,
  normalizeOwnerInput,
  normalizeTaskFormat,
  projectTaskStage,
  releaseDeadSessionTasks,
  removeTask,
  stampTaskTimes,
  sweepUtteranceTasks,
  taskIds,
  updateTask,
  warnTaskExperiment,
} from './tasks/records.mjs'
import {
  HEARTBEAT_SCHEMA,
  HEARTBEAT_STALE_SECONDS,
  LEGACY_SUBAGENT_AGENT,
  MAX_HEARTBEAT_CLIP,
  configureHeartbeats,
  endHeartbeat,
  gcLegacyHeartbeats,
  gitBranchOf,
  heartbeatStatus,
  livenessOf,
  readHeartbeatSection,
  readHeartbeats,
  removeHeartbeat,
  resolveHeartbeatWorkspace,
  startHeartbeat,
  updateHeartbeat,
} from './heartbeats/records.mjs'
import {
  addGate, buildGate, gateIds, getGate, listGateRuns, listGates, removeGate, runGate, runGatesByPhase, updateGate,
} from './gates/records.mjs'
import {
  CONTRACT_REL,
  DAY_MS,
  RECORD_ROOT,
  STORE_REL,
  TASK_ARCHIVE_AFTER_DAYS,
  TASK_ARCHIVE_MAX_DAYS,
  assertInitialized,
  defaultContract,
  initLockContract,
  loadContract,
  normalizeContract,
  saveContract,
  storePaths,
  withLock,
} from './store/contract.mjs'
import { gitMainWorktree, gitProbe, resolveProjectRoot } from './store/git-root.mjs'
import {
  DECISION_ID_RE,
  REF_ID_RE,
  assertPattern,
  assertSafeId,
  assertTargetFree,
  nextId,
  nextTaskId,
  optionalBoolean,
  optionalEnum,
  optionalInt,
  optionalText,
  readCollection,
  readRecord,
  requireText,
  sortByCreatedAsc,
  sortByUpdatedDesc,
  statusCounts,
  stringArray,
  unreadableCollector,
} from './store/records.mjs'
import { ensureDir, fsyncDirBestEffort, renameWithRetrySync, writeJsonAtomic } from './atomic.mjs'
import { LOCK_FILE, acquireLock, hostTag, releaseLock, sweepStaleTemps } from './lock.mjs'
import { expectSyntaxKnown, runStep } from './runner.mjs'
import { STAGE_IDS, legacyStageFromStatus, stageToStatus } from './stage.mjs'
// Direction is fixed `core → desc → source-scan / util` (spec §11): `lib/desc.mjs`
// must never import this module, and `lib/source-scan.mjs` imports nothing.
import * as desc from './desc.mjs'

export { drainWarnings, FlowError, noteWarning } from './util.mjs'
export { containedPath } from './paths.mjs'
export { renameWithRetrySync, writeJsonAtomic } from './atomic.mjs'
export { releaseTakeoverClaim } from './lock.mjs'
export { killProcessTree } from './proc.mjs'
export { runStep } from './runner.mjs'

export { resolveProjectRoot } from './store/git-root.mjs'
export {
  TASK_STATUS,
  TASK_TYPES,
  addTask,
  archiveTasks,
  getTask,
  listTasks,
  normalizeOwnerInput,
  normalizeParentInput,
  normalizeTaskFormat,
  releaseDeadSessionTasks,
  removeTask,
  sweepUtteranceTasks,
  updateTask,
} from './tasks/records.mjs'
export {
  HEARTBEAT_SCHEMA,
  HEARTBEAT_STALE_SECONDS,
  MAX_HEARTBEAT_CLIP,
  endHeartbeat,
  gcLegacyHeartbeats,
  gitBranchOf,
  heartbeatStatus,
  livenessOf,
  readHeartbeatSection,
  readHeartbeats,
  removeHeartbeat,
  resolveHeartbeatWorkspace,
  startHeartbeat,
  updateHeartbeat,
} from './heartbeats/records.mjs'
export {
  addGate, getGate, listGateRuns, listGates, removeGate, runGate, runGatesByPhase, updateGate,
} from './gates/records.mjs'
export {
  SCHEMA_VERSION,
  TASK_ARCHIVE_AFTER_DAYS,
  assertInitialized,
  loadContract,
  saveContract,
  storePaths,
  withLock,
} from './store/contract.mjs'

/** Root of the per-plugin record dirs (tasks/decisions/gates/experiments/description). */

const EXP_ID_RE = /^[A-Z]+-\d{8}-\d{2}$/

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

const DECISION_OPTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/
const DECISION_QUESTION_MAX = 200
const DECISION_RATIONALE_MAX = 300
const DECISION_BY = ['user', 'agent']
const DECISION_APPROVAL_OPTIONS = Object.freeze([
  Object.freeze({ id: 'approve', label: '同意', impact: '批准该动作，可以继续执行' }),
  Object.freeze({ id: 'reject', label: '拒绝', impact: '拒绝该动作，停止推进' }),
])

/** A heartbeat older than six hours is flagged as possibly stopped (same rule as the panel). */

/** Heartbeat file schema; independent of the store schema. */
/**
 * Every accepted `status` value. `waiting` is a live main session whose turn is
 * closed but which still has running subagent children ("等待子会话"); it is an
 * active status like working/idle — the session exists, it is just not the one
 * producing tokens right now.
 */
/** `updateHeartbeat` may only touch these keys. */
/** Bound on the stored session title (display-only, so a clip is enough). */
/**

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






/** Fresh schema-2 contract with every default filled in. */

/** JSON type name for `manifest-invalid` diagnostics (`array`/`null` included). */

/** Section/member shapes: `[section, [[member, kind, fallback], …]]`; unknown keys pass through. */

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

/**
 * Fill defaults and repair invalid members into a (possibly partial) contract.
 * Silent by design — see {@link sanitizeContract} for the warning contract.
 */

/**
 * Read `<root>/.agents/flow/flow.json`.
 * @returns {{contract:object, source:string, warnings:string[]}}
 */

/** Atomically write the contract (always schema 2, defaults filled in). */

/**
 * Absolute store directories for one contract.
 *
 * @param {string} root project root
 * @param {object} contract flow contract
 * @param {{pathMemo?: Map<string,string|Error>}} [options] per-request realpath memo;
 *   omitted, the containment checks resolve every path again (CLI/tool behavior).
 */

/**
 * Throw `usage` (exit 2) when `root` has no `.agents/flow/flow.json`. Exported for the
 * bin-side read-only checks: `normalizeTaskFormat({fix:false})` returns
 * `{ok:true, issues:[]}` for a missing store, so a check that did not gate on this
 * would report "no legacy records" instead of "not initialised" (CONTRACT §6.2).
 */

/** Create the store layout and contract. */
/** Read-only manifest snapshot used to find the real lock location before locking. */

export function initProject(root, options = {}) {
  // 在 worktree 里 init 也必须落在项目主工作区：台账是项目级的，不是检出版的。
  const absRoot = resolveProjectRoot(root)
  const created = []
  ensureDir(absRoot)
  const requestedName = typeof options.name === 'string' && options.name.trim() !== '' ? options.name.trim() : null

  // The whole bootstrap is one critical section: members and the seeded gates
  // must not race `task add` / `gate update` / another init. The lock lives in
  // the store declared by the *current* manifest (`store.root` may be custom),
  // so read the manifest first, lock there, and re-validate under the lock: if
  // another writer changed `store.root` while we were acquiring, release and
  // retry boundedly instead of writing through the wrong lock.
  const MAX_INIT_LOCK_ROUNDS = 5
  for (let round = 1; round <= MAX_INIT_LOCK_ROUNDS; round += 1) {
    const lockContract = initLockContract(absRoot)
    const lockStore = storePaths(absRoot, lockContract).store
    let retry = false
    const result = withLock(absRoot, lockContract, () => {
      const live = initLockContract(absRoot)
      if (storePaths(absRoot, live).store !== lockStore) {
        retry = true
        return null
      }
      const warnings = []
      let contract = null
      let seededGates = []
      // Recompute under the lock: another init may have won the race.
      const contractFile = join(absRoot, CONTRACT_REL)
      const alreadyExists = existsSync(contractFile)
      if (alreadyExists && options.force !== true) {
        contract = loadContract(absRoot).contract
        warnings.push(`already-initialized: ${CONTRACT_REL} (use force to rewrite)`)
      } else {
        // A fresh write and `--force` both build from the schema defaults plus
        // `--name`; records and other on-disk state are left untouched.
        contract = defaultContract(absRoot)
        if (requestedName !== null) contract.name = requestedName
        ensureDir(dirname(contractFile))
        writeJsonAtomic(contractFile, contract)
        created.push(CONTRACT_REL)
      }

      // Missing directories of a pre-existing (possibly partial) ledger are
      // repaired under the same lock. A forced rewrite does NOT keep the loaded
      // (old) config: it writes defaults above; existing record dirs stay as-is.
      const paths = storePaths(absRoot, contract)
      for (const dir of [paths.experiments, paths.tasks, paths.gates, paths.logs, paths.decisions, paths.description]) ensureDir(dir)

      // Bootstrap gates only help an empty gates directory; seeding is best-effort
      // and never fails the init itself (every failure becomes a warning). It runs
      // inside this lock, so reading the gate directory and writing the seeds are
      // one critical section with respect to `gate run/update` (N3 documented:
      // moving the seed out of the lock would need a second lock round and is not
      // worth the write-path risk).
      if (options.noGates !== true) {
        try {
          seededGates = seedDefaultGates(absRoot, contract, warnings)
        } catch (error) {
          warnings.push(`default-gate-failed: seed: ${error?.message ?? String(error)}`)
        }
      }
      return { root: absRoot, created, warnings, seededGates }
    }, { sweep: false })
    if (retry === false) return result
  }
  throw new FlowError('conflict', 'init: store.root kept changing while acquiring the lock; retry')
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
        // Description-ledger drift (spec §9). Appended last on purpose: a dirty
        // stage or a blocking decision still fails first, and the earlier step
        // indices (`steps[1]`/`steps[2]`) stay put for existing assertions. It is
        // read-only, and `enforce: auto` keeps it green on a project that has not
        // built a description yet — otherwise every old store would start red.
        { id: 'description', run: `${cli} check description`, expect: 'exit 0' },
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
        // Release keeps the strict form: `undescribed-file` graduates from warning
        // to failure, so a release cannot ship files nobody described.
        { id: 'description-strict', run: `${cli} check description --strict`, expect: 'exit 0' },
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

/**
 * Run `fn(paths)` while holding `<store>/.lock`.
 *
 * `fn` must be synchronous: the lock is an advisory file lock, not a
 * re-entrant mutex, and every store operation in this module is synchronous.
 *
 * Non-contract API: exported so tests can drive the lock protocol directly.
 */

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
/**
 * Session ownership of one decision: a record belongs to the session that asked
 * it. A record without `asked_session` (legacy / CLI without DSH_SESSION_ID) is
 * owned by nobody, so it never shows up in a session-scoped read.
 */
function decisionOwnedBy(record, session) {
  const owner = typeof record.asked_session === 'string' ? record.asked_session.trim() : ''
  return owner !== '' && owner === session
}

/**
 * The session filter shared by `listDecisions` / `summarizeDecisions`: an empty
 * `session` keeps the global view (panel / human CLI), a non-empty one keeps
 * only that session's records (agent-facing reminder / flow_decision tool).
 */
function decisionSessionOf(options) {
  return typeof options.session === 'string' ? options.session.trim() : ''
}

export function listDecisions(root, contract, options = {}) {
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const session = decisionSessionOf(input)
  const annotated = decisionRecords(storePaths(root, c))
    .map((record) => annotateDecision(record, input))
    .filter((record) => session === '' || decisionOwnedBy(record, session))
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

/** Clear `task.decision` pointers that named a decision removed with its session. */
function clearDecisionPointers(root, contract, removedIds) {
  const wanted = new Set(removedIds)
  const cleared = []
  let tasks
  try {
    tasks = listTasks(root, contract)
  } catch (error) {
    noteWarning(`decision-archive-pointer-scan-failed: ${error.message}`)
    return cleared
  }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const pointer = typeof task.decision === 'string' ? task.decision.trim() : ''
    if (pointer === '' || wanted.has(pointer) === false) continue
    try {
      // A decision that left with its session can never be answered: clear the
      // dangling veto pointer so the task does not keep a promise nobody can keep.
      updateTask(root, contract, task.id, { decision: null }, { source: 'internal' })
      cleared.push(task.id)
    } catch (error) {
      noteWarning(`decision-archive-pointer-failed: ${task.id}: ${error.message}`)
    }
  }
  cleared.sort()
  return cleared
}

/**
 * Remove every decision owned by an archived session (open and closed alike):
 * a decision belongs to the conversation that asked it and must not outlive it.
 * The durable archive set comes from the Host (`workspaceRegistry.archivedSessionIds`);
 * this function only applies it. Records without `asked_session` are never
 * touched (nobody archived them), and the call is idempotent.
 *
 * Veto decisions also leave a `decision` pointer on their task; clearing it is
 * part of "no leftovers" and is reported in `clearedTasks`.
 *
 * @param {string[]} archivedSessionIds session ids the Host reports as archived
 * @param {{dryRun?:boolean}} [options]
 * @returns {{removed:string[], clearedTasks:string[], dryRun:boolean, archived:number}}
 */
export function purgeArchivedDecisions(root, contract, archivedSessionIds, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  if (!Array.isArray(archivedSessionIds)) throw invalid('archivedSessionIds must be an array of session ids')
  const archived = new Set(
    archivedSessionIds
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item !== ''),
  )
  const input = isPlainObject(options) ? options : {}
  const dryRun = input.dryRun === true
  const removed = withLock(root, c, (paths) => {
    const out = []
    for (const item of readCollection(paths.decisions)) {
      const record = item.record
      const owner = typeof record.asked_session === 'string' ? record.asked_session.trim() : ''
      if (owner === '' || archived.has(owner) === false) continue
      out.push(typeof record.id === 'string' ? record.id : item.name.slice(0, -5))
      if (dryRun === true) continue
      try {
        unlinkSync(item.file)
      } catch (error) {
        noteWarning(`decision-archive-purge-failed: ${item.name}: ${error.message}`)
      }
    }
    out.sort()
    return out
  })
  const clearedTasks = dryRun === true || removed.length === 0 ? [] : clearDecisionPointers(root, c, removed)
  return { removed, clearedTasks, dryRun, archived: archived.size }
}

/**
 * Read-only projection for the Host reminder, panel and `flow status`:
 * `{items, counts}` where items are the open decisions in the canonical order
 * and counts cover `{open, blocking, escalated, answered, withdrawn, superseded,
 * total}`. `limit` truncates `items` (counts stay session-scoped with the filter);
 * a non-empty `session` restricts both items and counts to that session's
 * records — the agent-facing reminder/tool view. No `session` = global view
 * (panel, human CLI).
 * @param {{limit?:number, session?:string, turn?:number|null, now?:number}} [options]
 */
export function summarizeDecisions(root, contract, options = {}) {
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const session = decisionSessionOf(input)
  const annotated = decisionRecords(storePaths(root, c, { pathMemo: pathMemoOf(options) }))
    .map((record) => annotateDecision(record, input))
    .filter((record) => session === '' || decisionOwnedBy(record, session))
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

/**
 * Run one gate: steps execute in order, the first failure stops the run, and
 * the merged output is written to `.agents/flow/logs/<gateId>/<timestamp>.json`.
 */

/**
 * Run every enabled gate of one phase, in ascending id order. Disabled gates
 * are skipped instead of failing, and one failing/throwing gate never stops
 * the remaining ones: the caller gets the whole summary at the end.
 * @returns {Promise<{phase:string, runs:object[], skipped:{id:string,reason:string}[]}>}
 */

/**
 * Most recent run records for a gate, newest first.
 *
 * @param {string} root project root
 * @param {object} contract flow contract
 * @param {string} gateId gate id
 * @param {number} [limit] newest records to keep
 * @param {{pathMemo?: Map<string,string|Error>}} [options] per-request realpath memo
 */

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

// ------------------------------------------------------------ description
//
// The description ledger (CONTRACT §3.7). Everything computable without
// touching the store lives in `lib/desc.mjs`; this section owns the three things
// the model layer must not do:
//   1. lock-scoped orchestration of the write paths (`withLock` + `writeJsonAtomic`);
//   2. contract/section normalization (paths, enforce mode, thresholds);
//   3. the stage-gate adapter `updateTask` calls.
// Every read path — `readDescriptionProject`, `listDescriptionFiles`,
// `getDescriptionFile`, `getDescriptionPlan`, `descriptionStatus`,
// `checkDescription`, `renderDescription` — is lock-free and writes nothing. A read
// that grabbed the write lock would turn a transient `archive-locked` conflict
// into a false red, and `check description` runs inside a seeded precommit gate.

export const DESCRIPTION_SCHEMA = 1
export const DESCRIPTION_ENFORCE_MODES = Object.freeze(['auto', 'on', 'off'])

const DESCRIPTION_MIN_SEMANTICS = 10
const DESCRIPTION_MAX_SCAN_BYTES = 1024 * 1024

/** Stages whose transition runs the description gate (spec §7 table). */
const DESCRIPTION_GATE_STAGES = Object.freeze(['queued-implementation', 'queued-review', 'done'])
/** Stages that may create or amend a semantic-change plan (spec §2.3). */
const DESCRIPTION_PLAN_STAGES = Object.freeze(['queued-analysis', 'analyzing', 'implementing'])

/** The `description` section, tolerating either a whole contract or just the section. */
function descriptionConfigOf(contract) {
  if (!isPlainObject(contract)) return {}
  return isPlainObject(contract.description) ? contract.description : contract
}

/** `minSemanticsChars`, repaired to the schema default when unusable. */
function descriptionMinSemantics(config) {
  const number = Number(config.minSemanticsChars)
  return Number.isInteger(number) && number > 0 ? number : DESCRIPTION_MIN_SEMANTICS
}

/** `maxScanBytes`, repaired to the schema default when unusable. */
function descriptionMaxScanBytes(config) {
  const number = Number(config.maxScanBytes)
  return Number.isInteger(number) && number > 0 ? number : DESCRIPTION_MAX_SCAN_BYTES
}

/**
 * `enforce` normalized to one of the three modes. An unknown value degrades to
 * `auto` with a warning instead of failing: `enforce` is deliberately typed
 * `string` at the contract layer (spec §1), so a typo must not take the ledger
 * down.
 */
function descriptionEnforce(config) {
  const value = typeof config.enforce === 'string' ? config.enforce.trim() : ''
  if (DESCRIPTION_ENFORCE_MODES.includes(value)) return value
  if (value !== '') {
    noteWarning(`description-enforce-invalid: ${value} (expected ${DESCRIPTION_ENFORCE_MODES.join('|')}); using auto`)
  }
  return 'auto'
}

/** Relative POSIX path or `null`; never throws (records may carry junk). */
function safeRelativePath(value) {
  try {
    return desc.normalizeSourcePath(value)
  } catch {
    return null
  }
}

/** `now` option of the write paths: `Date` / ISO / epoch → local ISO seconds. */
function descriptionNow(value) {
  if (value === undefined || value === null) return formatIso()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? formatIso(date) : formatIso()
}

/** Absolute layout of the ledger under an already-resolved store directory. */
function descriptionLayoutOf(dir) {
  return { dir, project: join(dir, 'project.json'), files: join(dir, 'files'), tasks: join(dir, 'tasks') }
}

/** Same layout, resolved from the contract (read paths take no lock). */
function descriptionPaths(root, contract, options = {}) {
  return descriptionLayoutOf(storePaths(root, contract, options).description)
}

/** One JSON record: `null` when absent or damaged (a damaged file is a warning). */
function readJsonRecord(file, label) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    noteWarning(`unreadable: ${toPosix(file)}: ${error.message}`)
    return null
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) throw new Error('record is not a JSON object')
    return parsed
  } catch (error) {
    noteWarning(`unreadable: ${toPosix(file)}: ${error.message} (${label})`)
    return null
  }
}

function compareByPath(left, right) {
  const a = typeof left.path === 'string' ? left.path : ''
  const b = typeof right.path === 'string' ? right.path : ''
  return a < b ? -1 : a > b ? 1 : 0
}

/** File records of the ledger, sorted by `path` (spec §8 returns record arrays). */
function descriptionFilesAt(dpaths, unreadable) {
  const issues = Array.isArray(unreadable) ? unreadable : undefined
  return readCollection(dpaths.files, issues).map((item) => item.record).sort(compareByPath)
}

/**
 * Stable content revision of the ledger: every record minus its timestamps, sorted
 * by `path`. Deterministic, so two builds over the same content produce the same
 * `revision`, while **any** semantic or structural change bumps it. Timestamps are
 * excluded on purpose: they only move when a record already changed, and keeping
 * them would make the value churn on a rewrite of identical content.
 */
function descriptionRevisionOf(records) {
  const material = records
    .map((record) => {
      const { created_at: _createdAt, updated_at: _updatedAt, ...rest } = record
      return { ...rest, path: typeof rest.path === 'string' ? rest.path : '' }
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return `sha256:${createHash('sha256').update(JSON.stringify(material)).digest('hex')}`
}

/** Count the plan files of the ledger (`tasks/<T-id>.json`). */
function descriptionPlanCount(dpaths) {
  let names
  try {
    names = readdirSync(dpaths.tasks)
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw new FlowError('io', `cannot read ${toPosix(dpaths.tasks)}: ${error.message}`)
  }
  return names.filter((name) => name.toLowerCase().endsWith('.json')).length
}

/**
 * Rewrite `project.json` from the current record set, preserving `semantics` and
 * `name` (the two hand-written facts) and recomputing `revision`/`counts`/stamps.
 * A no-op when the computed record is byte-identical, so `set` on an unchanged
 * ledger does not churn the file.
 */
function writeDescriptionProject(dpaths, contract, absRoot, records, now) {
  const previous = readJsonRecord(dpaths.project, 'description project')
  const summary = desc.summarize(records, { minSemanticsChars: descriptionMinSemantics(descriptionConfigOf(contract)) })
  const next = {
    schema: DESCRIPTION_SCHEMA,
    name:
      previous !== null && typeof previous.name === 'string' && previous.name.trim() !== ''
        ? previous.name.trim()
        : typeof contract.name === 'string' && contract.name.trim() !== ''
          ? contract.name.trim()
          : basename(absRoot),
    semantics: previous !== null && typeof previous.semantics === 'string' ? previous.semantics : '',
    revision: descriptionRevisionOf(records),
    generated_at: now,
    updated_at: now,
    counts: {
      files: summary.files,
      modules: summary.modules,
      described: summary.described,
      missingSemantics: summary.missingSemantics,
    },
  }
  if (previous !== null && JSON.stringify(previous) === JSON.stringify(next)) return next
  writeJsonAtomic(dpaths.project, next)
  return next
}

/**
 * `flow.json` 的 `description` 节（spec §8）。
 * @returns {object|null} `project.json`，不存在或损坏时 `null`（损坏另记 warning）
 */
export function readDescriptionProject(root, contract) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  return readJsonRecord(descriptionPaths(absRoot, c).project, 'description project')
}

/**
 * 文件记录数组，按 `path` 升序。
 * @param {{unreadable?: string[], pathMemo?: Map<string,string|Error>}} [options]
 *   `unreadable` 收集读不出来的绝对路径（计数用），不传则只记 warning
 */
export function listDescriptionFiles(root, contract, options = {}) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const opts = isPlainObject(options) ? options : {}
  const dpaths = descriptionPaths(absRoot, c, { pathMemo: pathMemoOf(opts) })
  return descriptionFilesAt(dpaths, opts.unreadable)
}

/**
 * 一条文件记录（读不到 → `not-found`）。
 * @param {string} value 仓库相对路径
 */
export function getDescriptionFile(root, contract, value) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const relative = desc.normalizeSourcePath(value)
  const dpaths = descriptionPaths(absRoot, c)
  const record = readJsonRecord(join(dpaths.files, `${desc.encodePath(relative)}.json`), 'description file')
  if (record === null) {
    throw new FlowError('not-found', `description file ${relative} not found (run flow desc build first)`)
  }
  return record
}

/**
 * 任务的语义变更计划（spec §2.3），没有则 `null`。
 * @param {string} taskId 任务 id（同时是文件名，需通过安全段校验）
 */
export function getDescriptionPlan(root, contract, taskId) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  assertSafeId(taskId, 'task id')
  const dpaths = descriptionPaths(absRoot, c)
  return readJsonRecord(join(dpaths.tasks, `${taskId}.json`), 'description plan')
}

/**
 * 展示用计数（spec §8）：`{files, modules, missingSemantics, plans, described}`。
 * `missingSemantics` 按**待填单元**计（文件 1 + 每个模块 1），口径与
 * `project.json` 的 `counts` 缓存一致（`desc.summarize` 是唯一实现）。
 */
export function descriptionStatus(root, contract) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const dpaths = descriptionPaths(absRoot, c)
  const min = descriptionMinSemantics(descriptionConfigOf(c))
  const summary = desc.summarize(descriptionFilesAt(dpaths), { minSemanticsChars: min })
  return {
    files: summary.files,
    modules: summary.modules,
    missingSemantics: summary.missingSemantics,
    plans: descriptionPlanCount(dpaths),
    described: summary.described,
  }
}

/**
 * 确定性 Markdown（spec §10）；台账为空（无 project.json 且无记录）时返回 `null`，
 * 让调用方能区分「还没建描述」与「渲染出空文档」。
 * @returns {string|null}
 */
export function renderDescription(root, contract) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const project = readDescriptionProject(absRoot, c)
  const records = descriptionFilesAt(descriptionPaths(absRoot, c))
  if (project === null && records.length === 0) return null
  const view = project ?? { schema: DESCRIPTION_SCHEMA, name: c.name, semantics: '' }
  return desc.renderMarkdown(view, records)
}

/** 检查项 / 跳过提示的统一形状（`failed` 与 `warnings` 同构）。 */
function descriptionIssue(kind, path, detail, hint, options = {}) {
  const item = {
    kind,
    path: typeof path === 'string' && path !== '' ? path : '.',
    detail: String(detail ?? ''),
    hint: String(hint ?? ''),
    level: options.level === 'fail' ? 'fail' : 'warn',
  }
  if (typeof options.module === 'string' && options.module !== '') item.module = options.module
  return item
}

/**
 * 描述台账漂移检查（spec §6，只读）。
 *
 * `enforce` 决定「没建描述」算不算失败：`auto`（默认）在 store 里已有 ≥1 条文件
 * 记录时才生效，因此所有老项目第一次跑 precommit 的 `description` 步都是绿的；
 * `on` 无条件生效；`off` 与 `description.enabled: false` 一律跳过（`ok:true` +
 * 一条说明性 warning）。跳过不是假绿：`mode` 与 warning 的 `kind` 都写进返回值。
 *
 * @param {{taskId?: string, strict?: boolean, requireTests?: boolean, stage?: string}} [options]
 *   `taskId` 追加 §7 的计划项；`stage` 只用于 `requireTests` 的默认值
 *   （`reviewing` 默认要求测试证据，`done` 由阶段门显式传 `requireTests:true`）
 * @returns {{ok: boolean, mode: string, counts: object, failed: object[], warnings: object[]}}
 */
export function checkDescription(root, contract, options = {}) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const opts = isPlainObject(options) ? options : {}
  const config = descriptionConfigOf(c)
  const min = descriptionMinSemantics(config)
  const maxScanBytes = descriptionMaxScanBytes(config)
  const strict = opts.strict === true
  const mode = descriptionEnforce(config)
  const dpaths = descriptionPaths(absRoot, c)
  const records = descriptionFilesAt(dpaths)
  const summary = desc.summarize(records, { minSemanticsChars: min })

  const finish = (failed, warnings) => ({
    ok: failed.length === 0,
    mode,
    counts: {
      files: summary.files,
      modules: summary.modules,
      missingSemantics: summary.missingSemantics,
      plans: descriptionPlanCount(dpaths),
      described: summary.described,
      failed: failed.length,
      warnings: warnings.length,
    },
    failed,
    warnings,
  })

  // §6 末条：`enforce=auto` 且台账里一条记录都没有 → 跳过（老项目的默认态）。
  if (config.enabled === false) {
    return finish([], [descriptionIssue('description-disabled', '.', 'description.enabled=false，跳过描述检查', '')])
  }
  if (mode === 'auto' && records.length === 0) {
    return finish([], [descriptionIssue('description-skipped', '.', '未建立描述，跳过', 'flow desc build')])
  }

  // 全 include 范围都要扫：`undescribed-file` 靠 scannedMap 的键集合，只扫记录会
  // 让「新加的文件从没被描述」永远报不出来。
  const listed = desc.listSourceFiles(absRoot, c)
  const warnings = []
  for (const warning of listed.warnings) {
    warnings.push(descriptionIssue('scan-warning', '.', warning, '检查 description.include/exclude'))
  }
  const scannedMap = new Map()
  for (const file of listed.files) {
    const scanned = desc.scanSourceAt(absRoot, file.path, { maxScanBytes })
    if (typeof scanned.skipped === 'string') {
      warnings.push(descriptionIssue('scan-skipped', file.path, `扫描跳过：${scanned.skipped}`, 'flow desc build'))
      continue
    }
    scannedMap.set(file.path, scanned)
  }

  const project = readDescriptionProject(absRoot, c)
  const items = desc.checkProject({ project, records, scannedMap }, c, {
    strict,
    root: absRoot,
    minSemanticsChars: min,
  })

  const taskId = typeof opts.taskId === 'string' && opts.taskId !== '' ? opts.taskId : null
  if (taskId !== null) {
    // 不存在的任务按**用法**错报（exit 2）：调用方传错了 id，不能渲染成「检查通过」。
    try {
      getTask(absRoot, c, taskId)
    } catch (error) {
      if (error instanceof FlowError && error.code === 'not-found') {
        throw new FlowError('usage', `task ${taskId} not found (cannot check its description plan)`)
      }
      throw error
    }
    const plan = readJsonRecord(join(dpaths.tasks, `${taskId}.json`), 'description plan')
    const testGate = typeof config.testGate === 'string' ? config.testGate.trim() : ''
    let gateRuns = []
    if (testGate !== '') {
      try {
        gateRuns = listGateRuns(absRoot, c, testGate, 5)
      } catch (error) {
        if (!(error instanceof FlowError)) throw error
        warnings.push(descriptionIssue('test-gate-invalid', '.', `testGate 不可用（${testGate}）：${error.message}`, '修正 description.testGate'))
      }
    }
    const requireTests = opts.requireTests !== undefined ? opts.requireTests === true : opts.stage === 'reviewing'
    items.push(
      ...desc.checkPlan(plan, {
        root: absRoot,
        contract: c,
        records,
        scannedMap,
        project,
        gateRuns,
        requireTests,
        minSemanticsChars: min,
      })
    )
  }

  const failed = []
  for (const item of items) {
    if (item.level === 'warn') warnings.push(item)
    else failed.push(item)
  }
  return finish(failed, warnings)
}

/**
 * `flow desc build`（spec §5）：`listSourceFiles` → `scanSourceAt` → 建/对账记录 →
 * 剪枝 → 重算 `project.json`。`dryRun` 走**完全不加锁**的预演路径，一次盘都不写。
 *
 * @param {{dryRun?: boolean, now?: Date|string|number}} [options]
 * @returns {{created:number, updated:number, unchanged:number, pruned:number, warnings:string[]}}
 */
export function buildDescription(root, contract, options = {}) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const opts = isPlainObject(options) ? options : {}
  const dryRun = opts.dryRun === true
  const now = descriptionNow(opts.now)

  const run = (dpaths) => {
    const config = descriptionConfigOf(c)
    const min = descriptionMinSemantics(config)
    const maxScanBytes = descriptionMaxScanBytes(config)
    const listed = desc.listSourceFiles(absRoot, c)
    const warnings = [...listed.warnings]

    const indexed = new Map()
    for (const record of descriptionFilesAt(dpaths)) {
      const relative = safeRelativePath(record.path)
      if (relative === null) {
        warnings.push(`invalid-record: ${JSON.stringify(record.path)}（path 不合法，已忽略）`)
        continue
      }
      if (!indexed.has(relative)) indexed.set(relative, record)
    }

    let created = 0
    let updated = 0
    let unchanged = 0
    const writes = []
    const keep = new Set()
    for (const file of listed.files) {
      // `keep` before the skip check: a file the scanner refuses (too big, …) must
      // not lose the record that already describes it.
      keep.add(file.path)
      const scanned = desc.scanSourceAt(absRoot, file.path, { maxScanBytes })
      if (typeof scanned.skipped === 'string') {
        warnings.push(`skipped: ${file.path}（${scanned.skipped}）`)
        continue
      }
      const existing = indexed.get(file.path)
      if (existing === undefined) {
        const record = desc.createRecord(scanned, { now })
        indexed.set(file.path, record)
        writes.push(record)
        created += 1
        continue
      }
      const result = desc.reconcileRecord(existing, scanned, { now })
      if (!result.changed) {
        unchanged += 1
        continue
      }
      indexed.set(file.path, result.record)
      writes.push(result.record)
      updated += 1
    }

    const deletes = []
    for (const relative of [...indexed.keys()]) {
      if (keep.has(relative)) continue
      indexed.delete(relative)
      deletes.push(relative)
    }
    const pruned = deletes.length

    const finalRecords = [...indexed.values()].sort(compareByPath)
    const previousProject = readJsonRecord(dpaths.project, 'description project')
    const touched = created + updated + pruned
    const stamp = touched > 0 || previousProject === null
      ? now
      : (typeof previousProject.generated_at === 'string' && previousProject.generated_at !== '' ? previousProject.generated_at : now)
    const updatedAt = touched > 0 || previousProject === null
      ? now
      : (typeof previousProject.updated_at === 'string' && previousProject.updated_at !== '' ? previousProject.updated_at : now)
    const summary = desc.summarize(finalRecords, { minSemanticsChars: min })
    const nextProject = {
      schema: DESCRIPTION_SCHEMA,
      name:
        previousProject !== null && typeof previousProject.name === 'string' && previousProject.name.trim() !== ''
          ? previousProject.name.trim()
          : typeof c.name === 'string' && c.name.trim() !== ''
            ? c.name.trim()
            : basename(absRoot),
      // `semantics` is hand-written; build only ever preserves it.
      semantics: previousProject !== null && typeof previousProject.semantics === 'string' ? previousProject.semantics : '',
      revision: descriptionRevisionOf(finalRecords),
      generated_at: stamp,
      updated_at: updatedAt,
      counts: {
        files: summary.files,
        modules: summary.modules,
        described: summary.described,
        missingSemantics: summary.missingSemantics,
      },
    }

    if (!dryRun) {
      for (const record of writes) {
        writeJsonAtomic(join(dpaths.files, `${desc.encodePath(record.path)}.json`), record)
      }
      for (const relative of deletes) {
        try {
          unlinkSync(join(dpaths.files, `${desc.encodePath(relative)}.json`))
        } catch (error) {
          if (error.code !== 'ENOENT') throw new FlowError('io', `cannot remove ${toPosix(relative)} record: ${error.message}`)
        }
      }
      // "No change, no write": identical project.json keeps its stamps, otherwise
      // every build would dirty the file (and `render --check` would chase it).
      if (previousProject === null || JSON.stringify(previousProject) !== JSON.stringify(nextProject)) {
        writeJsonAtomic(dpaths.project, nextProject)
      }
    }

    return { created, updated, unchanged, pruned, warnings }
  }

  if (dryRun) return run(descriptionPaths(absRoot, c))
  return withLock(absRoot, c, (paths) => run(descriptionLayoutOf(paths.description)))
}

/**
 * `flow desc set`（spec §9）：把单文件补丁（或补丁数组）落进**已存在**的记录。
 *
 * 记录必须已存在——`set` 只写语义与成员归属，不负责发现新文件（那是 build 的
 * 活），所以缺失时报 `invalid` 并提示先 build，而不是悄悄建一条半截记录。
 * 补丁的 `members` 是**整体替换**（`desc.applyFilePatch` 的语义）。
 *
 * @param {object|object[]} patchOrPatches 单补丁或补丁数组（空数组 = no-op）
 * @returns {{records: object[], changed: boolean}} `records` 是**实际写盘**的记录
 */
export function setDescriptionFile(root, contract, patchOrPatches) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const patches = Array.isArray(patchOrPatches) ? patchOrPatches : [patchOrPatches]
  if (patches.length === 0) return { records: [], changed: false }
  const config = descriptionConfigOf(c)
  const min = descriptionMinSemantics(config)
  const maxScanBytes = descriptionMaxScanBytes(config)

  return withLock(absRoot, c, (paths) => {
    const dpaths = descriptionLayoutOf(paths.description)
    const now = formatIso()
    const indexed = new Map()
    for (const record of descriptionFilesAt(dpaths)) {
      const relative = safeRelativePath(record.path)
      if (relative !== null && !indexed.has(relative)) indexed.set(relative, record)
    }

    const written = []
    for (const patch of patches) {
      const normalized = desc.validateFilePatch(patch, { minSemanticsChars: min })
      const relative = normalized.path
      const existing = indexed.get(relative)
      if (existing === undefined) {
        throw invalid(`${relative}: 记录不存在（先跑 flow desc build 建记录，再 flow desc set）`)
      }
      const scanned = desc.scanSourceAt(absRoot, relative, { maxScanBytes })
      if (typeof scanned.skipped === 'string') {
        throw invalid(`${relative}: 无法扫描（${scanned.skipped}），不能写语义`)
      }
      const result = desc.applyFilePatch(existing, normalized, scanned, { now, minSemanticsChars: min })
      if (!result.changed) continue
      indexed.set(relative, result.record)
      written.push(result.record)
    }

    for (const record of written) {
      writeJsonAtomic(join(dpaths.files, `${desc.encodePath(record.path)}.json`), record)
    }
    if (written.length > 0) {
      writeDescriptionProject(dpaths, c, absRoot, [...indexed.values()].sort(compareByPath), now)
    }
    return { records: written, changed: written.length > 0 }
  })
}

/**
 * `flow desc set --project-semantics`（spec §9）：只写 `project.json` 的手写事实
 * `semantics`，其余字段（`name`/`revision`/`counts`/`generated_at`）原样保留，
 * 只把 `updated_at` 刷新到本次写入（`now` 与其它写路径同源，测试可显式注入）。
 *
 * `project.json` 必须已存在：`set` 不负责建台账，那是 `build` 的活——与
 * `setDescriptionFile` 同一条纪律（缺失时报 `invalid` 并提示先 build，而不是
 * 悄悄造一个只有语义、没有记录的 project.json）。
 *
 * @param {{semantics: string, now?: Date|string|number}} input
 * @returns {object} 写盘后的 `project.json`
 */
export function setDescriptionProject(root, contract, input = {}) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const opts = isPlainObject(input) ? input : {}
  const semantics = typeof opts.semantics === 'string' ? opts.semantics.trim() : ''
  if (semantics === '') {
    throw invalid('project semantics 不能为空（flow desc set --project-semantics <text>）')
  }
  const now = descriptionNow(opts.now)
  return withLock(absRoot, c, (paths) => {
    const dpaths = descriptionLayoutOf(paths.description)
    const project = readJsonRecord(dpaths.project, 'description project')
    if (project === null) {
      throw invalid(`description project.json 不存在（先跑 flow desc build 建台账）`)
    }
    const next = { ...project, semantics, updated_at: now }
    writeJsonAtomic(dpaths.project, next)
    return next
  })
}

/**
 * 把已有计划与本次输入合并成 `normalizePlanInput` 的入参。
 * 已有计划的 `history` 被带上（归一器每次追加一条），`files`/`noSemanticChange`
 * 的一处切换会自动清掉对侧，避免「改成 noSemanticChange 却被旧 files 卡住」。
 */
function mergePlanInput(existing, input) {
  const fresh = isPlainObject(input) ? input : {}
  const merged = isPlainObject(existing) ? { ...existing, ...fresh } : { ...fresh }
  if (isPlainObject(existing)) {
    merged.created_at = typeof existing.created_at === 'string' ? existing.created_at : merged.created_at
    merged.history = Array.isArray(existing.history) ? existing.history : []
    // 冻结的 implemented 计划已在调用点拒绝；重写一律回到 planned。
    merged.status = 'planned'
    merged.implemented_at = null
  }
  if (merged.noSemanticChange === true && fresh.files === undefined) delete merged.files
  if (fresh.files !== undefined && fresh.noSemanticChange === undefined) delete merged.noSemanticChange
  return merged
}

/** include ∧ ¬exclude 的匹配器（计划 base 的 git 干净性检查用）。 */
function descriptionScopeMatcher(contract) {
  const config = descriptionConfigOf(contract)
  const include = desc.globMatcher(Array.isArray(config.include) ? config.include : [])
  const exclude = desc.globMatcher(Array.isArray(config.exclude) ? config.exclude : [])
  return (value) => typeof value === 'string' && value !== '' && include(value) && !exclude(value)
}

/**
 * 计划的 `base`（spec §2.3/§7）：git 可用时要求 include 范围的工作树干净，
 * 并记下当时的 HEAD；脏工作树直接拒绝，否则 `unplanned-change` 事后无法归因。
 * git 不可用 / `gitCheck:false` → `commit:null` + warning（不阻断）。
 */
function planBaseOf(absRoot, contract, now) {
  const config = descriptionConfigOf(contract)
  if (config.gitCheck === false) return { commit: null, clean: true, recorded_at: now }
  const probe = desc.gitProbe(absRoot)
  if (!probe.ok) {
    noteWarning(`description git: 不可用（${probe.reason ?? 'unknown'}），base.commit 记 null`)
    return { commit: null, clean: true, recorded_at: now }
  }
  const changed = desc.gitChangedFiles(absRoot, probe.head, descriptionScopeMatcher(contract))
  if (!changed.ok) {
    noteWarning(`description git: 无法比对工作树（${changed.reason ?? 'unknown'}），base.commit 记 ${probe.head}`)
    return { commit: probe.head, clean: false, recorded_at: now }
  }
  if (changed.files.length > 0) {
    const preview = changed.files.slice(0, 5).map((file) => `${file.path}（${file.status}）`).join('、')
    const more = changed.files.length > 5 ? ` 等 ${changed.files.length} 项` : ''
    throw invalid(`描述范围内有未提交改动，先提交再建计划：${preview}${more}`)
  }
  return { commit: probe.head, clean: true, recorded_at: now }
}

/**
 * `flow desc plan`（spec §2.3/§9）：建/改一个任务的语义变更计划。
 *
 * - 任务必须存在，且 `stage ∈ {queued-analysis, analyzing, implementing}`；
 * - `implemented` 的计划已冻结（apply 之后不能再改，否则代码与语义会漂）；
 * - 冻结的唯一例外：`options.rebase === true` 时只刷新 `base` 与 `updated_at` 并追加一条
 *   `history`，`status` / `implemented_at` / `files` / 语义字段一律不动（`--rebase` 出口）；
 * - 已有计划再次写入 = 修订：追加一条 `history`，`amended:true`。
 *
 * @param {string} taskId 任务 id
 * @param {object} input 计划输入（`files` / `noSemanticChange` / `reason` / …）
 * @param {{rebase?: boolean}} [options] 写路径选项：`rebase` 只对 implemented 计划生效（只刷新 base）
 * @returns {{plan: object, amended: boolean, rebased?: boolean}}
 */
export function setDescriptionPlan(root, contract, taskId, input, options = {}) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  assertSafeId(taskId, 'task id')
  const min = descriptionMinSemantics(descriptionConfigOf(c))

  return withLock(absRoot, c, (paths) => {
    const dpaths = descriptionLayoutOf(paths.description)
    const now = formatIso()
    // 不存在的任务由 getTask 抛 not-found（写入路径的既有契约）。
    const task = getTask(absRoot, c, taskId)
    const stage = projectTaskStage(task).stage
    if (!DESCRIPTION_PLAN_STAGES.includes(stage)) {
      throw invalid(
        `task ${taskId} 在阶段 ${stage} 不能写语义变更计划（只允许 ${DESCRIPTION_PLAN_STAGES.join(' / ')}）`
      )
    }
    const existing = readJsonRecord(join(dpaths.tasks, `${taskId}.json`), 'description plan')
    const opts = isPlainObject(options) ? options : {}
    if (existing !== null && existing.status === 'implemented') {
      if (opts.rebase !== true) {
        throw invalid(
          `计划 ${taskId} 已 implemented（apply 之后冻结）；要改语义请新开任务；只刷新 base 用 flow desc plan ${taskId} --rebase`
        )
      }
      // 冻结例外（CONTRACT §3.7）：base-only 刷新。只动 base/updated_at/history，
      // 语义、status、implemented_at、files 一律保持原样；planBaseOf 的干净性要求不变。
      const base = planBaseOf(absRoot, c, now)
      const previous = isPlainObject(existing.base) && typeof existing.base.commit === 'string' ? existing.base.commit : '(none)'
      const next = typeof base.commit === 'string' ? base.commit : '(none)'
      const plan = {
        ...existing,
        schema: DESCRIPTION_SCHEMA,
        base,
        updated_at: now,
        history: [
          ...(Array.isArray(existing.history) ? existing.history : []),
          { at: now, stage, note: `rebase：base ${previous} → ${next}（只刷新比较基准；语义、状态、implemented_at 不变）` },
        ],
      }
      writeJsonAtomic(join(dpaths.tasks, `${taskId}.json`), plan)
      return { plan, amended: true, rebased: true }
    }
    const base = planBaseOf(absRoot, c, now)
    const plan = desc.normalizePlanInput(mergePlanInput(existing, input), {
      task: taskId,
      now,
      stage,
      base,
      minSemanticsChars: min,
    })
    writeJsonAtomic(join(dpaths.tasks, `${taskId}.json`), plan)
    return { plan, amended: existing !== null }
  })
}

/**
 * `flow desc apply`（spec §7）：把计划语义落进文件记录，然后冻结计划。
 *
 * - 只允许在 `implementing` 阶段（其它阶段报 `invalid`，提示先回实现阶段）；
 * - 记录先写、计划**后**冻结：反过来会让 `checkPlan` 看到 implemented 却读不到
 *   语义，把一个失败变成两个；
 * - 幂等：计划已是 `implemented` 时直接返回 `applied:false`，`implemented_at`
 *   保留首次时间。
 *
 * @param {string} taskId 任务 id
 * @param {{dryRun?: boolean, now?: Date|string|number}} [options]
 * @returns {{plan: object, applied: boolean, warnings: string[]}}
 */
export function applyDescriptionPlan(root, contract, taskId, options = {}) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  assertSafeId(taskId, 'task id')
  const opts = isPlainObject(options) ? options : {}
  const dryRun = opts.dryRun === true
  const config = descriptionConfigOf(c)
  const min = descriptionMinSemantics(config)
  const maxScanBytes = descriptionMaxScanBytes(config)
  const now = descriptionNow(opts.now)

  const run = (dpaths) => {
    const task = getTask(absRoot, c, taskId)
    const stage = projectTaskStage(task).stage
    if (stage !== 'implementing') {
      throw invalid(`task ${taskId} 在阶段 ${stage} 不能 apply 描述计划（先把任务推进到 implementing）`)
    }
    const plan = readJsonRecord(join(dpaths.tasks, `${taskId}.json`), 'description plan')
    if (plan === null) {
      throw invalid(`task ${taskId} 没有语义变更计划（先 flow desc plan ${taskId} --input <json>）`)
    }
    if (plan.status === 'implemented') return { plan, applied: false, warnings: [] }

    const records = descriptionFilesAt(dpaths)
    const scannedMap = new Map()
    for (const entry of Array.isArray(plan.files) ? plan.files : []) {
      if (!isPlainObject(entry) || entry.op === 'remove') continue
      const relative = safeRelativePath(entry.path)
      if (relative === null) continue
      const scanned = desc.scanSourceAt(absRoot, relative, { maxScanBytes })
      if (typeof scanned.skipped === 'string') throw invalid(`${relative}: 无法扫描（${scanned.skipped}），不能 apply`)
      scannedMap.set(relative, scanned)
    }

    const result = desc.applyPlanToRecords(plan, records, scannedMap, { now, minSemanticsChars: min })
    const nextPlan = {
      ...plan,
      schema: DESCRIPTION_SCHEMA,
      status: 'implemented',
      // 首次 apply 的时间一旦写上就不再改：测试证据的起点依赖它（spec §2.3）。
      implemented_at:
        typeof plan.implemented_at === 'string' && plan.implemented_at !== '' ? plan.implemented_at : now,
      updated_at: now,
      history: Array.isArray(plan.history) ? plan.history : [],
    }

    if (!dryRun) {
      const before = new Map()
      for (const record of records) {
        const relative = safeRelativePath(record.path)
        if (relative !== null) before.set(relative, record)
      }
      const after = new Map()
      for (const record of result.records) {
        const relative = safeRelativePath(record.path)
        if (relative !== null) after.set(relative, record)
      }
      for (const [relative, record] of after) {
        const previous = before.get(relative)
        if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(record)) continue
        writeJsonAtomic(join(dpaths.files, `${desc.encodePath(relative)}.json`), record)
      }
      // 计划里的 `op:remove` 会从记录集里消失：记录文件也要跟着删，否则 build
      // 之前 `getDescriptionFile` 还能读到一条幽灵记录。
      for (const relative of before.keys()) {
        if (after.has(relative)) continue
        try {
          unlinkSync(join(dpaths.files, `${desc.encodePath(relative)}.json`))
        } catch (error) {
          if (error.code !== 'ENOENT') throw new FlowError('io', `cannot remove ${toPosix(relative)} record: ${error.message}`)
        }
      }
      writeJsonAtomic(join(dpaths.tasks, `${taskId}.json`), nextPlan)
      writeDescriptionProject(dpaths, c, absRoot, result.records, now)
    }
    return { plan: nextPlan, applied: true, warnings: [] }
  }

  if (dryRun) return run(descriptionPaths(absRoot, c))
  return withLock(absRoot, c, (paths) => run(descriptionLayoutOf(paths.description)))
}

// ------------------------------------------------- description stage gate

/** `description gate: <to>: <kind> <path>[:<module>] … — <hint>` 的失败清单段。 */
function descriptionGateFailure(failed) {
  const shown = failed
    .slice(0, 3)
    .map((item) => `${item.kind} ${item.path}${item.module === undefined ? '' : `:${item.module}`}`)
    .join(' ')
  return failed.length > 3 ? `${shown} …（共 ${failed.length} 项）` : shown
}

/** 修复命令：按失败 kind 选一条（spec §7 只认这三种入口）。 */
function descriptionGateHint(failed, taskId, config) {
  const kinds = new Set(failed.map((item) => item.kind))
  const testGate = typeof config.testGate === 'string' ? config.testGate.trim() : ''
  if (kinds.has('tests-missing') && testGate !== '') return `flow gate run ${testGate}`
  if (kinds.has('plan-missing') || kinds.has('plan-invalid')) return `flow desc plan ${taskId} --input <json>`
  return `flow desc apply ${taskId}`
}

/** `queued-implementation` 的计划门槛：计划存在且（files 非空 xor noSemanticChange+reason）。 */
function planGateItems(plan, taskId) {
  if (plan === null) {
    return [
      descriptionIssue(
        'plan-missing',
        '.',
        `task ${taskId} 没有语义变更计划`,
        `flow desc plan ${taskId} --input <json>`,
        { level: 'fail' }
      ),
    ]
  }
  const hasFiles = Array.isArray(plan.files) && plan.files.length > 0
  const reason = typeof plan.reason === 'string' ? plan.reason.trim() : ''
  const noChange = plan.noSemanticChange === true && reason !== ''
  if (hasFiles === noChange) {
    return [
      descriptionIssue(
        'plan-invalid',
        '.',
        hasFiles
          ? 'noSemanticChange 与 files 不能同时给出'
          : '计划必须给出 files，或 noSemanticChange:true 加非空 reason',
        `flow desc plan ${taskId} --input <json>`,
        { level: 'fail' }
      ),
    ]
  }
  return []
}

/**
 * 阶段门（spec §7，唯一实现点 `updateTask`）：同步、只读、**绝不取锁**。
 *
 * 豁免顺序即语义：内部写 → 非目标阶段 → 幂等重写 → 子任务 → `enabled:false` →
 * `enforce=off` → `auto` 且台账为空。目标阶段的两档门槛：
 * `queued-implementation` 只看计划形状（不改代码，也就不查漂移）；
 * `queued-review`/`done` 跑完整 `checkDescription`（含计划项 / 未计划改动 /
 * 测试证据），`done` 额外要求测试证据。
 *
 * 两种调用形态都支持：`(root, contract, nextTask, {source, from, to})`（spec §8 +
 * `updateTask` 的实际形状）与 `(root, contract, {task, from, to, source})`。
 *
 * @returns {undefined} 通过时返回 `undefined`
 * @throws {FlowError} code=`invalid`
 */
export function assertDescriptionGate(root, contract, nextTask, options = {}) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  let bag = isPlainObject(options) ? options : {}
  let task = isPlainObject(nextTask) ? nextTask : null
  // 第二形态：第三参本身就是选项包（含 `task` 而不是 `id`）。
  if (
    task !== null &&
    !Object.hasOwn(task, 'id') &&
    !Object.hasOwn(task, 'stage') &&
    (Object.hasOwn(task, 'task') || Object.hasOwn(task, 'to'))
  ) {
    bag = task
    task = isPlainObject(bag.task) ? bag.task : null
  }

  const source = typeof bag.source === 'string' ? bag.source : undefined
  if (source === 'internal') return
  if (task === null || typeof task.id !== 'string' || task.id === '') return

  const to = typeof bag.to === 'string' ? bag.to : (typeof task.stage === 'string' ? task.stage : '')
  if (!DESCRIPTION_GATE_STAGES.includes(to)) return

  const from = typeof bag.from === 'string' ? bag.from : null
  // 同一阶段的重写是合法幂等（`canTransition` 也这么定义）：重试不该先过门。
  if (from !== null && from === to) return

  // 子任务不承担项目级语义（spec §7 豁免一）。`parent: null` / `''` 都是根任务。
  if (typeof task.parent === 'string' && task.parent.trim() !== '') return

  const config = descriptionConfigOf(c)
  if (config.enabled === false) return
  const mode = descriptionEnforce(config)
  if (mode === 'off') return

  const records = descriptionFilesAt(descriptionPaths(absRoot, c))
  // `auto` 只约束「已经有描述的 store」：老项目 / 新项目第一次推阶段不能红。
  if (mode === 'auto' && records.length === 0) return

  let failed
  if (to === 'queued-implementation') {
    const plan = readJsonRecord(join(descriptionPaths(absRoot, c).tasks, `${task.id}.json`), 'description plan')
    failed = planGateItems(plan, task.id)
  } else {
    // `done` 要测试证据；`queued-review` 不要求（apply/回归可能还没跑完）。
    const result = checkDescription(absRoot, c, { taskId: task.id, stage: to, requireTests: to === 'done' })
    failed = result.failed
  }
  if (failed.length === 0) return

  throw invalid(`description gate: ${to}: ${descriptionGateFailure(failed)} — ${descriptionGateHint(failed, task.id, config)}`)
}

// 心跳域需要"没有任务时建卡"的能力：在模块加载完成后把任务侧实现接过去。
configureHeartbeats({ buildTask, taskIds })

// 任务域需要描述门的判定：装配完成后把描述侧实现接过去（避免 tasks ↔ description 成环）。
configureTasks({ descriptionGate: assertDescriptionGate, experimentIds })
