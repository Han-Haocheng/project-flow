/**
 * project-flow core (schema 2).
 *
 * The single writer for a project's flow store: contract, atomic writes, a
 * short-lived lock, experiment/task/gate CRUD, gate execution and migration of
 * legacy data. Only node built-ins are used, so the CLI, the agent tools and the
 * read-only panel all share this one module.
 *
 * Layout (root-relative, fixed unless the contract says otherwise):
 *   .dsh/flow/flow.json
 *   .dsh/flow/experiments/<id>.json
 *   .dsh/flow/tasks/<id>.json
 *   .dsh/flow/gates/<id>.json
 *   .dsh/flow/logs/<gateId>/<timestamp>.json
 *   .dsh/flow/.lock   (temporary, never committed or displayed)
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const SCHEMA_VERSION = 2

const STORE_REL = '.dsh/flow'
const CONTRACT_REL = '.dsh/flow/flow.json'
const LOCK_FILE = '.lock'
const LOCK_STALE_MS = 30_000

const EXP_ID_RE = /^[A-Z]+-\d{8}-\d{2}$/
/** Legacy ids from `exp.py` / older task ledgers (`H1-baseline`, `T-20261028-52`, …). */
const LEGACY_ID_RE = /^[A-Za-z][A-Za-z0-9_.-]{1,60}$/
const GATE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

const EXPERIMENT_STATUS = ['open', 'confirmed', 'refuted', 'abandoned']
const TASK_STATUS = ['draft', 'active', 'done', 'archived']
const GATE_PHASES = ['commit', 'release', 'manual']

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
}

const TASK_DEFAULTS = {
  status: 'draft',
  owner: '',
  goal: '',
  scope: { allow: [], deny: [] },
  acceptance: [],
  checkpoints: [],
  commits: [],
  notes: '',
}

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

function isAbsolutePath(value) {
  return typeof value === 'string' && isAbsolute(value)
}

// ------------------------------------------------------------- warnings

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
      groupBy: 'factor',
      fallbackTrailers: true,
    },
    tasks: { source: 'json', dir: '.dsh/flow/tasks', current: null, recentLimit: 6 },
    gates: { dir: '.dsh/flow/gates', logs: '.dsh/flow/logs' },
    gate: { log: null },
    heartbeats: { source: 'md', dir: '.agents/heartbeat', max: 20 },
    runs: {
      dirs: ['.agents/tmp', 'build/agent-*'],
      maxDepth: 3,
      maxAgeMinutes: 15,
      max: 4,
      tailLines: 15,
      maxBytes: 2_000_000,
      extensions: ['.txt', '.log', '.out', '.json', '.csv'],
    },
  }
}

function mergeContract(target, defaults) {
  for (const [key, fallback] of Object.entries(defaults)) {
    if (target[key] === undefined || target[key] === null) {
      target[key] = deepClone(fallback)
      continue
    }
    if (isPlainObject(fallback) && isPlainObject(target[key])) mergeContract(target[key], fallback)
  }
  return target
}

/** Fill defaults into a (possibly partial) contract without mutating it. */
function normalizeContract(root, contract) {
  const absRoot = resolve(root)
  if (!isPlainObject(contract)) return defaultContract(absRoot)
  const merged = mergeContract(deepClone(contract), defaultContract(absRoot))
  merged.schema = SCHEMA_VERSION
  if (typeof merged.name !== 'string' || merged.name.trim() === '') merged.name = basename(absRoot)
  if (typeof merged.store.root !== 'string' || merged.store.root.trim() === '') merged.store.root = STORE_REL
  return merged
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
  if (raw.schema !== undefined && raw.schema !== SCHEMA_VERSION) {
    warnings.push(`schema: ${raw.schema} (expected ${SCHEMA_VERSION})`)
  }
  return { contract: normalizeContract(absRoot, raw), source: CONTRACT_REL, warnings }
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

function resolveDir(absRoot, value, fallbackName, store) {
  if (isAbsolutePath(value)) return resolve(value)
  if (typeof value !== 'string' || value.trim() === '') return join(store, fallbackName)
  const resolved = resolve(absRoot, value)
  // A stock section dir follows a custom store root instead of pinning the old path.
  const stock = resolve(absRoot, STORE_REL, fallbackName)
  const customStore = resolve(absRoot, STORE_REL) !== store
  if (customStore && resolved === stock) return join(store, fallbackName)
  return resolved
}

/** Absolute store directories for one contract. */
export function storePaths(root, contract) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const store = isAbsolutePath(c.store.root) ? resolve(c.store.root) : resolve(absRoot, c.store.root)
  return {
    store,
    experiments: resolveDir(absRoot, c.experiments && c.experiments.dir, 'experiments', store),
    tasks: resolveDir(absRoot, c.tasks && c.tasks.dir, 'tasks', store),
    gates: resolveDir(absRoot, c.gates && c.gates.dir, 'gates', store),
    logs: resolveDir(absRoot, c.gates && c.gates.logs, 'logs', store),
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

/** Create the store layout and contract; optionally import legacy data. */
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
  for (const dir of [paths.experiments, paths.tasks, paths.gates, paths.logs]) ensureDir(dir)

  const imported = { trailers: 0, tasks: 0 }
  const modes = Array.isArray(options.migrate) ? options.migrate : []
  for (const mode of modes) {
    if (mode === 'trailers' || mode === 'all') {
      const result = migrateTrailers(absRoot, contract)
      imported.trailers += result.imported
      for (const id of result.ids) created.push(`.dsh/flow/experiments/${id}.json`)
      warnings.push(...result.warnings)
    }
    if (mode === 'tasks' || mode === 'all') {
      const result = migrateLegacyTasks(absRoot, contract, options.taskSourceDir)
      imported.tasks += result.imported
      for (const id of result.ids) created.push(`.dsh/flow/tasks/${id}.json`)
      warnings.push(...result.warnings)
    }
  }

  return { root: absRoot, created, imported, warnings }
}

// -------------------------------------------------- atomic write and lock

let tempSeq = 0

/** write temp file + rename; on failure remove the temp file and raise io. */
function writeJsonAtomic(file, data) {
  ensureDir(dirname(file))
  const temp = join(dirname(file), `${basename(file)}.tmp-${process.pid}-${tempSeq++}`)
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' })
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // nothing to clean up
    }
    if (error instanceof FlowError) throw error
    throw new FlowError('io', `cannot write ${toPosix(file)}: ${error.message}`)
  }
}

function lockAgeMs(lockPath) {
  try {
    const text = readFileSync(lockPath, 'utf8')
    const parsed = JSON.parse(text)
    if (isPlainObject(parsed) && typeof parsed.at === 'string') {
      const at = Date.parse(parsed.at)
      if (Number.isFinite(at)) return Date.now() - at
    }
  } catch {
    // fall through to mtime
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs
  } catch {
    return 0
  }
}

function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      } finally {
        closeSync(fd)
      }
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw new FlowError('io', `cannot create ${toPosix(lockPath)}: ${error.message}`)
      const age = lockAgeMs(lockPath)
      if (age <= LOCK_STALE_MS) {
        throw new FlowError('conflict', `store is locked by another writer (${toPosix(lockPath)}); retry later`)
      }
      noteWarning(`lock-stale: took over ${toPosix(lockPath)} after ${Math.round(age / 1000)}s`)
      try {
        unlinkSync(lockPath)
      } catch {
        // another writer may have removed it; the next open decides
      }
    }
  }
  throw new FlowError('conflict', `cannot acquire store lock (${toPosix(lockPath)})`)
}

function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath)
  } catch {
    // already gone
  }
}

/** Run `fn(paths)` while holding `<store>/.lock`. */
function withLock(root, contract, fn) {
  const paths = storePaths(root, contract)
  ensureDir(paths.store)
  const lockPath = join(paths.store, LOCK_FILE)
  acquireLock(lockPath)
  try {
    return fn(paths)
  } finally {
    releaseLock(lockPath)
  }
}

// ------------------------------------------------------- storage helpers

function readCollection(dir) {
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
    }
  }
  return items
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
  if (!LEGACY_ID_RE.test(parent)) throw invalid(`parent is not a valid experiment id: ${JSON.stringify(value)}`)
  if (selfId !== undefined && parent === selfId) throw invalid('parent cannot reference itself')
  if (!existingIds.has(parent)) throw invalid(`parent experiment does not exist: ${parent}`)
  return parent
}

function validateExperimentFields(record, ctx) {
  record.title = requireText(record.title, 'title')
  record.hypothesis = optionalText(record.hypothesis, 'hypothesis', '')
  record.factor = optionalText(record.factor, 'factor', '')
  record.expected = optionalText(record.expected, 'expected', '')
  record.scale = optionalText(record.scale, 'scale', '')
  record.measured = optionalText(record.measured, 'measured', '')
  record.notes = optionalText(record.notes, 'notes', '')
  record.status = optionalEnum(record.status, 'status', EXPERIMENT_STATUS, 'open')
  record.parent = normalizeParent(record.parent, ctx.existingIds, record.id)
  if (record.metrics === undefined || record.metrics === null) record.metrics = {}
  if (!isPlainObject(record.metrics)) throw invalid('metrics must be an object')
  record.commits = stringArray(record.commits, 'commits')
  return record
}

function buildExperiment(input, ctx) {
  if (!isPlainObject(input)) throw invalid('experiment must be an object')
  const record = deepClone(input)
  record.schema = 1
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
  for (const key of ['id', 'schema', 'created_at']) {
    if (Object.hasOwn(patch, key)) throw invalid(`experiment ${key} cannot be changed`)
  }
  const next = { ...record }
  for (const [key, value] of Object.entries(deepClone(patch))) next[key] = value
  next.id = record.id
  next.schema = 1
  next.created_at = record.created_at
  validateExperimentFields(next, ctx)
  next.updated_at = formatIso()
  return next
}

function experimentIds(paths) {
  return new Set(readCollection(paths.experiments).map((item) => item.record.id).filter((id) => typeof id === 'string'))
}

export function listExperiments(root, contract) {
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c)
  return sortByUpdatedDesc(readCollection(paths.experiments).map((item) => item.record))
}

export function getExperiment(root, contract, id) {
  const c = normalizeContract(root, contract)
  return readRecord(storePaths(root, c).experiments, id, 'experiment')
}

export function addExperiment(root, contract, input) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const record = buildExperiment(input, { existingIds: experimentIds(paths) })
    writeJsonAtomic(join(paths.experiments, `${record.id}.json`), record)
    return record
  })
}

export function updateExperiment(root, contract, id, patch) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.experiments, id, 'experiment')
    const next = applyExperimentPatch(current, patch, { existingIds: experimentIds(paths) })
    writeJsonAtomic(join(paths.experiments, `${next.id}.json`), next)
    return next
  })
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

export function listTasks(root, contract) {
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c)
  return sortByUpdatedDesc(readCollection(paths.tasks).map((item) => item.record))
}

export function getTask(root, contract, id) {
  const c = normalizeContract(root, contract)
  return readRecord(storePaths(root, c).tasks, id, 'task')
}

export function addTask(root, contract, input) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const record = buildTask(input, { existingIds: taskIds(paths) })
    writeJsonAtomic(join(paths.tasks, `${record.id}.json`), record)
    return record
  })
}

export function updateTask(root, contract, id, patch) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.tasks, id, 'task')
    const next = applyTaskPatch(current, patch)
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

export function listGates(root, contract) {
  const c = normalizeContract(root, contract)
  return sortByUpdatedDesc(readCollection(storePaths(root, c).gates).map((item) => item.record))
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

function evaluateExpect(expect, exit, output, timedOut) {
  const text = typeof expect === 'string' ? expect.trim() : ''
  if (timedOut) return false
  const exitMatch = /^exit\s+(-?\d+)$/i.exec(text)
  if (exitMatch !== null) return exit === Number(exitMatch[1])
  const containsMatch = /^contains\s*[:：]\s*([\s\S]*)$/i.exec(text)
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

/** Most recent run records for a gate, newest first. */
export function listGateRuns(root, contract, gateId, limit = 5) {
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c)
  assertSafeId(gateId, 'gate id')
  const items = readCollection(join(paths.logs, gateId))
  items.sort((left, right) => timeValue(right.record.started_at) - timeValue(left.record.started_at))
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 5
  return items.slice(0, size).map((item) => item.record)
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

/** Read-only aggregate for the panel: never touches git, heartbeats or run output. */
export function readStoreState(root, contract) {
  const c = normalizeContract(root, contract)
  const experiments = listExperiments(root, c)
  const tasks = listTasks(root, c)
  const gates = listGates(root, c).map((gate) => {
    const runs = listGateRuns(root, c, gate.id, 1)
    const last = runs.length > 0 ? runs[0] : null
    return { ...gate, lastRun: last === null ? null : summarizeRun(last) }
  })
  return {
    experiments: {
      source: c.experiments.source,
      items: experiments,
      counts: statusCounts(experiments, EXPERIMENT_STATUS),
    },
    tasks: {
      source: c.tasks.source,
      current: typeof c.tasks.current === 'string' ? c.tasks.current : null,
      items: tasks,
      counts: statusCounts(tasks, TASK_STATUS),
    },
    gates: {
      items: gates,
      counts: {
        total: gates.length,
        enabled: gates.filter((gate) => gate.enabled !== false).length,
      },
    },
  }
}

// ------------------------------------------------------------ migrations

function readExpTrailers(body) {
  const values = new Map()
  for (const line of String(body).split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s?(.*)$/.exec(line.trim())
    if (match === null) continue
    const key = match[1].toLowerCase()
    if (!['exp-id', 'hypothesis', 'factor', 'scale', 'expected', 'measured', 'verdict'].includes(key)) continue
    if (!values.has(key)) values.set(key, [])
    values.get(key).push(match[2].trim())
  }
  return values
}

function trailerValue(values, key) {
  const list = values.get(key)
  if (!Array.isArray(list) || list.length === 0) return ''
  return list.find((item) => item !== '') ?? ''
}

function verdictToStatus(verdict) {
  const value = String(verdict).trim().toLowerCase()
  if (value === 'confirmed' || value === 'confirm') return 'confirmed'
  if (value === 'refuted' || value === 'refute') return 'refuted'
  if (value === 'abandoned' || value === 'abandon') return 'abandoned'
  return 'open'
}

/**
 * Import experiments from git commit trailers (`Exp-Id`, `Hypothesis`,
 * `Factor`, `Scale`, `Expected`, `Measured`, `Verdict`). Existing ids are
 * skipped, not merged. A missing/failing git repository yields warnings only.
 */
export function migrateTrailers(root, contract) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const warnings = []
  const result = spawnSync('git', ['-C', absRoot, 'log', '--format=%H%x1f%aI%x1f%B%x1e'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined && result.error !== null) {
    warnings.push(`git-log-failed: ${result.error.message}`)
    return { imported: 0, skipped: 0, ids: [], warnings }
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const detail = String(result.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''
    warnings.push(`git-log-failed: ${detail}`)
    return { imported: 0, skipped: 0, ids: [], warnings }
  }

  const commits = String(result.stdout ?? '')
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => {
      const parts = chunk.split('\x1f')
      return { sha: parts[0] ?? '', date: parts[1] ?? '', body: parts.slice(2).join('\x1f') }
    })
    .filter((commit) => commit.sha !== '')

  const paths = storePaths(absRoot, c)
  const existing = new Set(readCollection(paths.experiments).map((item) => item.record.id))
  const pending = new Map()
  let skipped = 0

  for (const commit of commits.reverse()) {
    const values = readExpTrailers(commit.body)
    const rawId = trailerValue(values, 'exp-id')
    if (rawId === '') continue
    for (const piece of rawId.split(',').map((item) => item.trim()).filter((item) => item !== '')) {
      if (!LEGACY_ID_RE.test(piece)) {
        warnings.push(`exp-id-invalid: ${piece} (${commit.sha.slice(0, 7)})`)
        continue
      }
      if (existing.has(piece)) {
        skipped += 1
        continue
      }
      const hypothesis = trailerValue(values, 'hypothesis')
      const measured = trailerValue(values, 'measured')
      const verdict = trailerValue(values, 'verdict')
      const prior = pending.get(piece)
      if (prior === undefined) {
        pending.set(piece, {
          schema: 1,
          id: piece,
          title: hypothesis === '' ? `Experiment ${piece}` : hypothesis.slice(0, 80),
          hypothesis,
          factor: trailerValue(values, 'factor'),
          parent: null,
          expected: trailerValue(values, 'expected'),
          scale: trailerValue(values, 'scale'),
          status: verdictToStatus(verdict),
          measured,
          metrics: {},
          commits: [commit.sha.slice(0, 7)],
          notes: '',
          created_at: commit.date === '' ? formatIso() : commit.date,
          updated_at: commit.date === '' ? formatIso() : commit.date,
        })
        continue
      }
      if (!prior.commits.includes(commit.sha.slice(0, 7))) prior.commits.push(commit.sha.slice(0, 7))
      if (hypothesis !== '') {
        prior.hypothesis = hypothesis
        prior.title = hypothesis.slice(0, 80)
      }
      if (measured !== '') prior.measured = measured
      if (verdict !== '') prior.status = verdictToStatus(verdict)
      prior.updated_at = commit.date === '' ? prior.updated_at : commit.date
    }
  }

  const ids = [...pending.keys()].sort()
  if (ids.length === 0) return { imported: 0, skipped, ids: [], warnings }
  withLock(absRoot, c, () => {
    for (const id of ids) writeJsonAtomic(join(paths.experiments, `${id}.json`), pending.get(id))
  })
  return { imported: ids.length, skipped, ids, warnings }
}

/**
 * Import legacy `.agents/tasks/*.json` records verbatim (schema 1, missing
 * timestamps filled from the file mtime). Id collisions are skipped.
 */
export function migrateLegacyTasks(root, contract, sourceDir = '.agents/tasks') {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const warnings = []
  const dir = isAbsolutePath(sourceDir) ? resolve(sourceDir) : resolve(absRoot, String(sourceDir ?? '.agents/tasks'))
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return { imported: 0, skipped: 0, ids: [], warnings }
    throw new FlowError('io', `cannot read ${toPosix(dir)}: ${error.message}`)
  }

  const paths = storePaths(absRoot, c)
  const existing = new Set(readCollection(paths.tasks).map((item) => item.record.id))
  const pending = []
  let skipped = 0

  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    let parsed
    let mtime = new Date()
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
      mtime = statSync(file).mtime
    } catch (error) {
      warnings.push(`legacy-task-unreadable: ${toPosix(file)}: ${error.message}`)
      continue
    }
    if (!isPlainObject(parsed) || typeof parsed.id !== 'string' || !LEGACY_ID_RE.test(parsed.id)) {
      warnings.push(`legacy-task-invalid: ${toPosix(file)}`)
      continue
    }
    if (existing.has(parsed.id)) {
      skipped += 1
      continue
    }
    const fallback = formatIso(mtime)
    let record
    try {
      record = buildTask({ ...parsed, title: parsed.title ?? parsed.id }, { existingIds: new Set([...existing, ...pending.map((item) => item.id)]) })
    } catch (error) {
      if (!(error instanceof FlowError)) throw error
      warnings.push(`legacy-task-invalid: ${toPosix(file)}: ${error.message}`)
      continue
    }
    if (typeof parsed.created_at !== 'string') record.created_at = fallback
    if (typeof parsed.updated_at !== 'string') record.updated_at = record.created_at
    if (!isPlainObject(parsed.scope)) record.scope = { allow: [], deny: [] }
    record.schema = 1
    pending.push(record)
  }

  if (pending.length === 0) return { imported: 0, skipped, ids: [], warnings }
  withLock(absRoot, c, () => {
    for (const record of pending) writeJsonAtomic(join(paths.tasks, `${record.id}.json`), record)
  })
  return { imported: pending.length, skipped, ids: pending.map((record) => record.id), warnings }
}
