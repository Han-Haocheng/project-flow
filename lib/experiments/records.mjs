// project-flow — 实验域（experiments 模块，2026-11-11 Phase 1 拆分）。
//
// 实验记录（schema2 七字段）、状态终局校验、清理/产品化系统写入、审查判定、
// `flow check experiments` 与实验树投影。依赖方向：experiments → store
// （records/contract）+ util + atomic + paths + tasks，**不 import core**。
//
// 实验本来就依赖任务：`experimentTree` 的父引用环判定用任务侧的 `createsCycle`，
// `checkExperiments` 要读任务上的 `experiment` 引用做缺失告警。方向固定
// experiments → tasks，tasks 不 import 本模块，因此不成环（tasks 模块头注释里也
// 写明了这条约定）。
//
// 常量（`EXP_ID_RE` / `EXPERIMENT_*` / `EXPERIMENT_DEFAULTS`）随实现留在本模块：
// `EXPERIMENT_SCHEMA` 是公共 API（core re-export）；`EXPERIMENT_STATUS` 只额外导出给
// core 的只读聚合 `readStoreState` 计数用，不经 core 对外 re-export。

import { unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from '../atomic.mjs'
import { pathMemoOf } from '../paths.mjs'
import { FlowError, deepClone, formatIso, invalid, isPlainObject, noteWarning, toPosix } from '../util.mjs'
import { DAY_MS, assertInitialized, normalizeContract, storePaths, withLock } from '../store/contract.mjs'
import {
  REF_ID_RE,
  assertPattern,
  assertSafeId,
  assertTargetFree,
  nextId,
  optionalEnum,
  optionalText,
  readCollection,
  readRecord,
  requireText,
  sortByUpdatedDesc,
  stringArray,
  unreadableCollector,
} from '../store/records.mjs'
import { createsCycle, listTasks } from '../tasks/records.mjs'

const EXP_ID_RE = /^[A-Z]+-\d{8}-\d{2}$/

/** Experiment record schema written by `addExperiment`; anything else is read-only legacy. */
export const EXPERIMENT_SCHEMA = 2
export const EXPERIMENT_STATUS = ['open', 'confirmed', 'refuted', 'abandoned', 'inconclusive', 'pivoted']
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

/** 已知实验 id 集；core 装配时注入给任务域校验 `experiment` 引用（`configureTasks`）。 */
export function experimentIds(paths) {
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
