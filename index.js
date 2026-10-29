// project-flow — Host half.
//
// Registers two JSON endpoints, both same-origin gated: one read endpoint,
// /api/project-flow/state, and ONE init write endpoint,
// /api/project-flow/init. The read endpoint reports the ledger of exactly one
// workspace: the directory the panel passes as `?root=<dir>` (the current
// session workspace), or the process working directory when the parameter is
// omitted. A workspace with no `.dsh/flow` store is reported as a legacy ledger
// (git trailers, `.agents` markers) or as a "not initialized" empty state — the
// endpoint never substitutes or lists another project. The write endpoint is
// the only write on the HTTP surface: it creates the ledger of that same
// workspace by reusing lib/core.mjs, the one writer shared with the CLI, so the
// same validation and atomic write apply. Four agent tools plus two skills
// expose the store to the model. Root resolution happens per request; there are
// no watchers and no dependencies beyond node built-ins.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const inject = ['webServer']

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const ROUTE_PATH = '/api/project-flow/state'
const INIT_ROUTE_PATH = '/api/project-flow/init'
const MAX_INIT_BODY_BYTES = 8 * 1024
const MAX_INIT_CREATED = 50
const MAX_INIT_WARNINGS = 20
const GIT_TIMEOUT_MS = 4000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const MAX_STRING = 400
const MAX_PAYLOAD_BYTES = 900 * 1000
const MAX_STORE_ITEMS = 400
const MAX_TOOL_ITEMS = 200
const WRITE_TIMEOUT_MS = 30_000
const STORE_CONTRACT = join('.dsh', 'flow', 'flow.json')
const MANIFESTS = ['flow.json', join('.flow', 'flow.json'), join('.agents', 'flow.json')]
const DEFAULT_MARKERS = [
  join('.agents', 'tasks'),
  join('.agents', 'gate-observe.log'),
  join('.agents', 'scripts', 'exp.py'),
]

// --------------------------------------------------------------- core module
//
// The store writer lives in lib/core.mjs and is shared with bin/flow.mjs. It is
// optional: a broken or absent module degrades the plugin to read-only legacy
// ledgers and makes the tools report an actionable error instead of failing the
// whole plugin load.

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

const EXP_TRAILER_KEYS = ['id', 'hypothesis', 'expected', 'measured', 'verdict', 'scale', 'factor']
const TASK_COUNTS = ['draft', 'active', 'done', 'archived', 'other']
const SOURCE_EXPERIMENTS = new Set(['git-trailers', 'none'])
const SOURCE_TASKS = new Set(['json', 'markdown', 'none'])
const SOURCE_HEARTBEATS = new Set(['md', 'json', 'none'])
const SAFE_TRAILER_KEY = /^[A-Za-z0-9_.-]+$/

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

function defaultContract() {
  return {
    schema: 1,
    name: '',
    experiments: {
      source: 'git-trailers',
      ungroupedLabel: '未分组',
      limit: 400,
      keys: {
        id: 'Exp-Id',
        hypothesis: 'Hypothesis',
        factor: 'Factor',
        scale: 'Scale',
        expected: 'Expected',
        measured: 'Measured',
        verdict: 'Verdict',
      },
    },
    tasks: {
      source: 'json',
      dir: '.agents/tasks',
      current: '.agents/.current',
      recentLimit: 6,
      fields: {
        id: 'id',
        title: 'title',
        status: 'status',
        owner: 'owner',
        goal: 'goal',
        updatedAt: 'updated_at',
        commits: 'commits',
      },
    },
    gate: { log: '.agents/gate-observe.log', lines: 40 },
    heartbeats: { source: 'md', dir: '.agents/heartbeat', max: 20 },
    runs: {
      dirs: ['.agents/tmp', 'build/agent-*'],
      maxDepth: 3,
      maxAgeMinutes: 15,
      max: 4,
      tailLines: 15,
      maxBytes: 2000000,
      extensions: ['.txt', '.log', '.out', '.json', '.csv'],
    },
  }
}

function pickString(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function pickNonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function pickInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || Number.isFinite(value) === false) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function pickStringArray(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const out = value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
  return out
}

function pickSource(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

/**
 * Merge one manifest object onto the defaults: objects shallow-merge per section,
 * arrays replace wholesale, unknown keys are ignored. Never throws.
 */
function mergeContract(raw, root) {
  const contract = defaultContract()
  contract.name = basename(root)

  if (!isPlainObject(raw)) return contract

  contract.schema = pickInteger(raw.schema, 1, 0, 1_000_000)
  contract.name = pickNonEmpty(raw.name, basename(root))

  if (isPlainObject(raw.experiments)) {
    const section = raw.experiments
    const target = contract.experiments
    target.source = pickSource(section.source, SOURCE_EXPERIMENTS, target.source)
    target.ungroupedLabel = pickString(section.ungroupedLabel, target.ungroupedLabel)
    target.limit = pickInteger(section.limit, target.limit, 1, 10_000)
    if (isPlainObject(section.keys)) {
      for (const name of Object.keys(target.keys)) {
        const key = section.keys[name]
        if (typeof key === 'string' && SAFE_TRAILER_KEY.test(key)) target.keys[name] = key
      }
    }
  }

  if (isPlainObject(raw.tasks)) {
    const section = raw.tasks
    const target = contract.tasks
    target.source = pickSource(section.source, SOURCE_TASKS, target.source)
    target.dir = pickNonEmpty(section.dir, target.dir)
    target.current = typeof section.current === 'string' ? section.current.trim() : target.current
    target.recentLimit = pickInteger(section.recentLimit, target.recentLimit, 0, 500)
    if (isPlainObject(section.fields)) {
      for (const name of Object.keys(target.fields)) {
        const field = section.fields[name]
        if (typeof field === 'string' && field.length > 0) target.fields[name] = field
      }
    }
  }

  if (isPlainObject(raw.gate)) {
    const section = raw.gate
    const target = contract.gate
    if (section.log === null || section.log === 'none') target.log = null
    else if (typeof section.log === 'string' && section.log.trim().length > 0) target.log = section.log.trim()
    target.lines = pickInteger(section.lines, target.lines, 0, 5000)
  }

  if (isPlainObject(raw.heartbeats)) {
    const section = raw.heartbeats
    const target = contract.heartbeats
    target.source = pickSource(section.source, SOURCE_HEARTBEATS, target.source)
    target.dir = pickNonEmpty(section.dir, target.dir)
    target.max = pickInteger(section.max, target.max, 0, 1000)
  }

  if (isPlainObject(raw.runs)) {
    const section = raw.runs
    const target = contract.runs
    const dirs = pickStringArray(section.dirs, target.dirs)
    target.dirs = dirs.length > 0 ? dirs : target.dirs
    target.maxDepth = pickInteger(section.maxDepth, target.maxDepth, 0, 20)
    target.maxAgeMinutes = pickInteger(section.maxAgeMinutes, target.maxAgeMinutes, 0, 60 * 24 * 365)
    target.max = pickInteger(section.max, target.max, 0, 200)
    target.tailLines = pickInteger(section.tailLines, target.tailLines, 0, 5000)
    target.maxBytes = pickInteger(section.maxBytes, target.maxBytes, 1, 64 * 1024 * 1024)
    const extensions = pickStringArray(section.extensions, null)
    if (extensions !== null) {
      target.extensions = extensions.map((extension) =>
        extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`,
      )
    }
  }

  return contract
}

/**
 * Read the manifest of one root. Returns `{ contract, source, invalid }` where
 * source is the root-relative manifest path or the literal "defaults".
 */
function loadContract(root, warnings) {
  for (const manifest of MANIFESTS) {
    const path = join(root, manifest)
    let text
    try {
      const stats = statSync(path)
      if (stats.isFile() !== true) continue
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(text)
      if (!isPlainObject(parsed)) throw new Error('manifest is not a JSON object')
      return { contract: mergeContract(parsed, root), source: toPosix(manifest), invalid: false }
    } catch (error) {
      warnings.push(`manifest-invalid: ${toPosix(manifest)}: ${brief(error)}`)
      return { contract: mergeContract(undefined, root), source: 'defaults', invalid: true }
    }
  }
  return { contract: mergeContract(undefined, root), source: 'defaults', invalid: false }
}

// ------------------------------------------------------- workspace inspection

function readManifestName(root) {
  if (hasStore(root)) {
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
  for (const manifest of MANIFESTS) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, manifest), 'utf8'))
      if (isPlainObject(parsed) && typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
        return parsed.name.trim()
      }
      return basename(root)
    } catch {
      continue
    }
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

function hasDefaultLayout(root) {
  for (const marker of DEFAULT_MARKERS) {
    try {
      if (existsSync(join(root, marker))) return true
    } catch {
      // Unreadable path: not a marker for us.
    }
  }
  return false
}

/** Whether one root carries an explicit flow manifest (store contract or legacy name). */
function hasManifest(root) {
  if (hasStore(root)) return true
  for (const manifest of MANIFESTS) {
    try {
      const stats = statSync(join(root, manifest))
      if (stats.isFile()) return true
    } catch {
      // keep looking
    }
  }
  return false
}

/** A root owns a ledger when it carries a manifest or one of the default markers. */
function hasContract(root) {
  if (hasManifest(root)) return true
  return hasDefaultLayout(root)
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

/** Whether a root is a registered workspace, inside one, or declares its own flow manifest. */
function rootAccepted(root, workspaces) {
  for (const workspace of workspaces) {
    if (rootWithin(root, workspace.path)) return true
  }
  return hasManifest(root)
}

/**
 * Display name: the manifest name, else the title of the innermost registered
 * workspace containing the root (workspaces may nest, e.g. /Project and
 * /Project/app), else the folder name.
 */
function rootName(root, workspaces) {
  if (hasManifest(root)) return readManifestName(root)
  let owner
  for (const workspace of workspaces) {
    if (rootWithin(root, workspace.path) === false) continue
    if (owner === undefined || workspace.path.length > owner.path.length) owner = workspace
  }
  if (owner !== undefined) return owner.title.length > 0 ? owner.title : basename(root)
  return basename(root)
}

// ---------------------------------------------------------------- experiments

function expFormat(keys) {
  const parts = ['%H', '%ad', '%s']
  for (const name of EXP_TRAILER_KEYS) {
    const key = SAFE_TRAILER_KEY.test(keys[name]) ? keys[name] : defaultContract().experiments.keys[name]
    parts.push(`%(trailers:key=${key},valueonly)`)
  }
  return parts.join('%x1f') + '%x1e'
}

function emptyExperiments() {
  return { total: 0, confirmed: 0, refuted: 0, open: 0, groups: [] }
}

function parseExpLog(raw, keys) {
  const rows = []
  for (const chunk of String(raw).split('\x1e')) {
    const record = chunk.replace(/^\n+/, '')
    if (record.trim().length === 0) continue
    const parts = record.split('\x1f')
    if (parts.length < 3 + EXP_TRAILER_KEYS.length) continue
    const values = parts.map((value) => (typeof value === 'string' ? value.trim() : ''))
    const sha = values[0]
    const date = values[1]
    const subject = values[2]
    const byKey = new Map()
    for (let index = 0; index < EXP_TRAILER_KEYS.length; index += 1) {
      const name = EXP_TRAILER_KEYS[index]
      byKey.set(keys[name], values[3 + index])
    }
    const get = (name) => byKey.get(keys[name]) ?? ''
    const id = get('id')
    if (id.length === 0) continue
    const verdict = get('verdict')
    rows.push({
      id,
      verdict: verdict === 'confirmed' || verdict === 'refuted' ? verdict : null,
      date,
      sha: sha.slice(0, 8),
      subject,
      hypothesis: clip(get('hypothesis')),
      expected: clip(get('expected')),
      measured: clip(get('measured')),
      scale: get('scale'),
      // Raw trailer values keyed by the configured trailer key; grouping reads `keys.factor`.
      byKey,
    })
  }
  return rows
}

function buildExperiments(rows, experiments) {
  let confirmed = 0
  let refuted = 0
  const grouped = new Map()
  for (const row of rows) {
    if (row.verdict === 'confirmed') confirmed += 1
    else if (row.verdict === 'refuted') refuted += 1
    const rawFactor = row.byKey.get(experiments.keys.factor) ?? ''
    const key = rawFactor.length > 0 ? rawFactor : experiments.ungroupedLabel
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push({
      id: row.id,
      verdict: row.verdict,
      date: row.date,
      sha: row.sha,
      subject: row.subject,
      hypothesis: row.hypothesis,
      expected: row.expected,
      measured: row.measured,
      scale: row.scale,
    })
  }
  const factors = [...grouped.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    total: rows.length,
    confirmed,
    refuted,
    open: rows.length - confirmed - refuted,
    groups: factors.map((factor) => ({ factor, items: grouped.get(factor) })),
  }
}

async function readExperiments(root, contract, warnings) {
  const experiments = contract.experiments
  if (experiments.source === 'none') return emptyExperiments()

  const format = expFormat(experiments.keys)
  const log = await git(root, [
    'log',
    '--date=short',
    `-n`,
    String(experiments.limit),
    `--pretty=format:${format}`,
  ])
  if (!log.ok) {
    warnings.push(`git log (experiments) failed: ${brief(log.error)}`)
    return emptyExperiments()
  }
  try {
    return buildExperiments(parseExpLog(log.stdout, experiments.keys), experiments)
  } catch (error) {
    warnings.push(`experiment trailers unparsable: ${brief(error)}`)
    return emptyExperiments()
  }
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

function emptyTasks() {
  return {
    total: 0,
    counts: { draft: 0, active: 0, done: 0, archived: 0, other: 0 },
    current: null,
    active: [],
    recentDone: [],
  }
}

function readCurrent(root, contract, warnings) {
  const relativePath = contract.tasks.current
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null
  try {
    const text = readFileSync(resolve(root, relativePath), 'utf8')
    const trimmed = text.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch (error) {
    const code = error !== null && error !== undefined ? error.code : undefined
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      warnings.push(`current task unreadable: ${brief(error)}`)
    }
    return null
  }
}

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

function listDirFiles(dir, extension) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  const files = []
  for (const entry of entries) {
    if (entry.isFile() !== true) continue
    if (extension !== undefined && entry.name.toLowerCase().endsWith(extension) === false) continue
    files.push({ name: entry.name, path: join(dir, entry.name) })
  }
  return files
}

function readTasksJson(root, contract, warnings) {
  const tasks = emptyTasks()
  tasks.current = readCurrent(root, contract, warnings)

  const dir = resolve(root, contract.tasks.dir)
  const files = listDirFiles(dir, '.json')
  if (files === undefined) {
    warnings.push(`tasks dir unreadable: ${toPosix(contract.tasks.dir)}`)
    return tasks
  }

  const fields = contract.tasks.fields
  const read = (task, name) => task[fields[name]]
  const parsed = []
  for (const file of files) {
    let raw
    try {
      raw = readFileSync(file.path, 'utf8')
    } catch (error) {
      warnings.push(`task ${file.name} unreadable: ${brief(error)}`)
      continue
    }
    let value
    try {
      value = JSON.parse(raw)
    } catch (error) {
      warnings.push(`task ${file.name} not JSON: ${brief(error)}`)
      continue
    }
    if (!isPlainObject(value)) {
      warnings.push(`task ${file.name} is not an object`)
      continue
    }
    parsed.push(value)
  }

  tasks.total = parsed.length
  const done = []
  for (const task of parsed) {
    const status = typeof read(task, 'status') === 'string' ? read(task, 'status') : ''
    if (TASK_COUNTS.includes(status) && status !== 'other') tasks.counts[status] += 1
    else tasks.counts.other += 1

    if (status === 'active') {
      tasks.active.push({
        id: clip(read(task, 'id')),
        title: clip(read(task, 'title')),
        status,
        owner: clip(read(task, 'owner')),
        updated_at: clip(read(task, 'updatedAt')),
        goal: clip(read(task, 'goal')),
      })
    }
    if (status === 'done') done.push(task)
  }

  done.sort((a, b) => timeValue(read(b, 'updatedAt')) - timeValue(read(a, 'updatedAt')))
  tasks.recentDone = done.slice(0, contract.tasks.recentLimit).map((task) => {
    const commits = read(task, 'commits')
    return {
      id: clip(read(task, 'id')),
      title: clip(read(task, 'title')),
      updated_at: clip(read(task, 'updatedAt')),
      commits: Array.isArray(commits) ? commits.filter((sha) => typeof sha === 'string').map((sha) => clip(sha)) : [],
      gate: lastCheckpointGate(task),
    }
  })

  tasks.active.sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
  return tasks
}

function markdownTitle(lines) {
  for (const line of lines) {
    if (line.startsWith('# ')) return line.slice(2).trim().slice(0, 200)
  }
  return ''
}

function frontMatterStatus(text) {
  if (!text.startsWith('---')) return undefined
  const lines = text.split('\n')
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '---') return undefined
    const match = /^status\s*:\s*(.+)$/.exec(line.trim())
    if (match !== null) {
      const value = match[1].trim().replace(/^["']|["']$/g, '')
      if (value.length > 0) return value
    }
  }
  return undefined
}

function readTasksMarkdown(root, contract, warnings) {
  const tasks = emptyTasks()
  tasks.current = readCurrent(root, contract, warnings)

  const dir = resolve(root, contract.tasks.dir)
  const files = listDirFiles(dir, '.md')
  if (files === undefined) {
    warnings.push(`tasks dir unreadable: ${toPosix(contract.tasks.dir)}`)
    return tasks
  }

  for (const file of files) {
    let text
    try {
      text = readFileSync(file.path, 'utf8')
    } catch (error) {
      warnings.push(`task ${file.name} unreadable: ${brief(error)}`)
      continue
    }
    let stats
    try {
      stats = statSync(file.path)
    } catch {
      stats = undefined
    }
    const status = frontMatterStatus(text) ?? 'unknown'
    tasks.total += 1
    if (TASK_COUNTS.includes(status) && status !== 'other') tasks.counts[status] += 1
    else tasks.counts.other += 1
    const updatedAt = stats !== undefined ? isoLocal(new Date(stats.mtimeMs)) : ''
    if (status === 'active') {
      tasks.active.push({
        id: clip(file.name.replace(/\.[^.]+$/, '')),
        title: clip(markdownTitle(splitLines(text))),
        status,
        owner: '',
        updated_at: updatedAt,
        goal: '',
      })
    }
    if (status === 'done') {
      tasks.recentDone.push({
        id: clip(file.name.replace(/\.[^.]+$/, '')),
        title: clip(markdownTitle(splitLines(text))),
        updated_at: updatedAt,
        commits: [],
        gate: null,
      })
    }
  }

  tasks.recentDone.sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
  tasks.recentDone = tasks.recentDone.slice(0, contract.tasks.recentLimit)
  tasks.active.sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
  return tasks
}

function readTasks(root, contract, warnings) {
  if (contract.tasks.source === 'none') return emptyTasks()
  if (contract.tasks.source === 'markdown') return readTasksMarkdown(root, contract, warnings)
  return readTasksJson(root, contract, warnings)
}

// ----------------------------------------------------------------------- gate

function readGate(root, contract, warnings) {
  if (contract.gate.log === null) return null
  const path = resolve(root, contract.gate.log)
  let stats
  try {
    stats = statSync(path)
  } catch (error) {
    const code = error !== null && error !== undefined ? error.code : undefined
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      warnings.push(`gate log unreadable: ${brief(error)}`)
    } else {
      warnings.push(`gate log missing: ${toPosix(contract.gate.log)}`)
    }
    return { lines: [], mtime: null, size: 0 }
  }
  if (stats.isFile() !== true) return { lines: [], mtime: null, size: 0 }
  try {
    const text = readFileSync(path, 'utf8')
    return {
      lines: splitLines(text)
        .slice(-contract.gate.lines)
        .map((line) => clip(line)),
      mtime: Math.round(stats.mtimeMs),
      size: stats.size,
    }
  } catch (error) {
    warnings.push(`gate log unreadable: ${brief(error)}`)
    return { lines: [], mtime: null, size: 0 }
  }
}

// ----------------------------------------------------------------- heartbeats

/** Drop a leading list marker so "- 状态：..." becomes "状态：...". */
function stripMarker(line) {
  const trimmed = line.trim()
  const stripped = trimmed.replace(/^[-*+]\s+/, '')
  return stripped.length > 0 ? stripped : trimmed
}

function readHeartbeatsMd(root, contract, now, warnings) {
  const dir = resolve(root, contract.heartbeats.dir)
  const files = listDirFiles(dir, '.md')
  if (files === undefined) {
    // A missing heartbeat directory is a normal, silent empty section.
    if (existsSync(dir)) warnings.push(`heartbeat dir unreadable: ${toPosix(contract.heartbeats.dir)}`)
    return []
  }

  const heartbeats = []
  for (const file of files) {
    let stats
    let text
    try {
      stats = statSync(file.path)
      text = readFileSync(file.path, 'utf8')
    } catch (error) {
      warnings.push(`heartbeat ${file.name} unreadable: ${brief(error)}`)
      continue
    }
    const lines = splitLines(text)
    let statusLine = ''
    for (const line of lines) {
      if (line.includes('状态')) {
        statusLine = stripMarker(line)
        break
      }
    }
    if (statusLine.length === 0) {
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0 || trimmed.startsWith('#')) continue
        statusLine = trimmed
        break
      }
    }
    heartbeats.push({
      file: file.name,
      title: clip(markdownTitle(lines)),
      statusLine: clip(statusLine),
      ageSeconds: Math.max(0, Math.floor((now - stats.mtimeMs) / 1000)),
      mtime: Math.round(stats.mtimeMs),
    })
  }

  heartbeats.sort((a, b) => b.mtime - a.mtime)
  return heartbeats.slice(0, contract.heartbeats.max)
}

function parseStamp(value) {
  if (typeof value !== 'string') return Number.NaN
  const text = value.trim()
  if (text.length === 0) return Number.NaN
  const loose = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (loose !== null) {
    const date = new Date(
      Number(loose[1]),
      Number(loose[2]) - 1,
      Number(loose[3]),
      Number(loose[4]),
      Number(loose[5]),
      loose[6] === undefined ? 0 : Number(loose[6]),
    )
    return date.getTime()
  }
  return Date.parse(text)
}

function readHeartbeatsJson(root, contract, now, warnings) {
  const dir = resolve(root, contract.heartbeats.dir)
  const files = listDirFiles(dir, '.json')
  if (files === undefined) {
    if (existsSync(dir)) warnings.push(`heartbeat dir unreadable: ${toPosix(contract.heartbeats.dir)}`)
    return []
  }

  const heartbeats = []
  for (const file of files) {
    let stats
    let raw
    try {
      stats = statSync(file.path)
      raw = readFileSync(file.path, 'utf8')
    } catch (error) {
      warnings.push(`heartbeat ${file.name} unreadable: ${brief(error)}`)
      continue
    }
    let value
    try {
      value = JSON.parse(raw)
    } catch (error) {
      warnings.push(`heartbeat ${file.name} not JSON: ${brief(error)}`)
      continue
    }
    if (!isPlainObject(value)) {
      warnings.push(`heartbeat ${file.name} is not an object`)
      continue
    }
    const parts = []
    if (typeof value.status === 'string' && value.status.trim().length > 0) parts.push(value.status.trim())
    if (typeof value.last_action === 'string' && value.last_action.trim().length > 0) parts.push(value.last_action.trim())
    const statusLine = clip(parts.join(' · '), 200)
    const stamp = parseStamp(value.updated_at)
    const reference = Number.isFinite(stamp) ? stamp : stats.mtimeMs
    heartbeats.push({
      file: file.name,
      title: clip(file.name.replace(/\.[^.]+$/, '')),
      statusLine,
      ageSeconds: Math.max(0, Math.floor((now - reference) / 1000)),
      mtime: Math.round(stats.mtimeMs),
    })
  }

  heartbeats.sort((a, b) => b.mtime - a.mtime)
  return heartbeats.slice(0, contract.heartbeats.max)
}

function readHeartbeats(root, contract, now, warnings) {
  if (contract.heartbeats.source === 'none') return []
  if (contract.heartbeats.source === 'json') return readHeartbeatsJson(root, contract, now, warnings)
  return readHeartbeatsMd(root, contract, now, warnings)
}

// ----------------------------------------------------------------------- runs

function expandRunDirs(root, patterns) {
  const dirs = []
  for (const pattern of patterns) {
    let full
    try {
      full = resolve(root, pattern)
    } catch {
      continue
    }
    const name = basename(full)
    if (!name.includes('*')) {
      dirs.push(full)
      continue
    }
    const parent = dirname(full)
    const star = name.indexOf('*')
    const prefix = name.slice(0, star)
    const suffix = name.slice(star + 1)
    let entries
    try {
      entries = readdirSync(parent, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() !== true) continue
      if (!entry.name.startsWith(prefix)) continue
      if (suffix.length > 0 && !entry.name.endsWith(suffix)) continue
      dirs.push(join(parent, entry.name))
    }
  }
  return dirs
}

function collectRunFiles(dir, depth, now, runs, out) {
  if (depth > runs.maxDepth) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectRunFiles(path, depth + 1, now, runs, out)
      continue
    }
    if (entry.isFile() !== true) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot < 0) continue
    const extension = entry.name.slice(dot).toLowerCase()
    if (runs.extensions.includes(extension) === false) continue
    let stats
    try {
      stats = statSync(path)
    } catch {
      continue
    }
    if (Number.isFinite(now - stats.mtimeMs) === false) continue
    if (now - stats.mtimeMs > runs.maxAgeMinutes * 60_000) continue
    if (stats.size < 1 || stats.size > runs.maxBytes) continue
    out.push({ path, mtime: stats.mtimeMs, size: stats.size })
  }
}

function readRuns(root, contract, now, warnings) {
  const runs = contract.runs
  if (runs.max === 0 || runs.dirs.length === 0) return []
  const found = []
  for (const dir of expandRunDirs(root, runs.dirs)) collectRunFiles(dir, 0, now, runs, found)

  const seen = new Set()
  const unique = []
  for (const item of found) {
    if (seen.has(item.path)) continue
    seen.add(item.path)
    unique.push(item)
  }
  unique.sort((a, b) => b.mtime - a.mtime)

  const output = []
  for (const item of unique.slice(0, runs.max)) {
    let text
    try {
      text = readFileSync(item.path, 'utf8')
    } catch (error) {
      warnings.push(`run output unreadable: ${brief(error)}`)
      continue
    }
    output.push({
      path: toPosix(relative(root, item.path)),
      ageSeconds: Math.max(0, Math.floor((now - item.mtime) / 1000)),
      size: item.size,
      lines: splitLines(text)
        .slice(-runs.tailLines)
        .map((line) => clip(line)),
    })
  }
  return output
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

  let truncated = false
  if (payload.experiments.source === 'store') {
    const items = Array.isArray(payload.experiments.items) ? payload.experiments.items : []
    while (items.length > 0) {
      items.pop()
      truncated = true
      const ids = new Set(items.map((item) => (isPlainObject(item) ? item.id : undefined)))
      payload.experiments.tree = pruneTree(payload.experiments.tree, ids)
      body = JSON.stringify(payload)
      if (Buffer.byteLength(body) <= MAX_PAYLOAD_BYTES) return body
    }
  } else {
    const groups = payload.experiments.groups
    for (;;) {
      let biggest = null
      for (const group of groups) {
        if (group.items.length === 0) continue
        if (biggest === null || group.items.length > biggest.items.length) biggest = group
      }
      if (biggest === null) break
      biggest.items.pop()
      truncated = true
      body = JSON.stringify(payload)
      if (Buffer.byteLength(body) <= MAX_PAYLOAD_BYTES) return body
    }
  }
  if (truncated) payload.warnings.push('items-truncated')

  while (payload.runs.length > 0) {
    payload.runs.pop()
    body = JSON.stringify(payload)
    if (Buffer.byteLength(body) <= MAX_PAYLOAD_BYTES) return body
  }

  payload.gate = { lines: [], mtime: null, size: 0 }
  payload.warnings = payload.warnings.slice(0, 20)
  body = JSON.stringify(payload)
  return body
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

function activeTasksOf(records) {
  return records
    .filter((record) => isPlainObject(record) && record.status === 'active')
    .sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
    .map((record) => ({
      id: clip(record.id),
      title: clip(record.title),
      status: 'active',
      owner: clip(record.owner),
      updated_at: clip(record.updated_at),
      goal: clip(record.goal),
    }))
}

function recentDoneOf(records, limit) {
  return records
    .filter((record) => isPlainObject(record) && record.status === 'done')
    .sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
    .slice(0, limit)
    .map((record) => ({
      id: clip(record.id),
      title: clip(record.title),
      updated_at: clip(record.updated_at),
      commits: Array.isArray(record.commits)
        ? record.commits.filter((sha) => typeof sha === 'string').map((sha) => clip(sha))
        : [],
      gate: lastCheckpointGate(record),
    }))
}

/** Store-mode payload: contract + collections read through lib/core.mjs. */
async function buildStoreState(root, entry, now, warnings) {
  const c = requireCore()
  let loaded
  try {
    loaded = c.loadContract(root)
  } catch (error) {
    warnings.push(`store contract unreadable: ${brief(error)}`)
    return buildLegacyState(root, entry, now, warnings)
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
    return buildLegacyState(root, entry, now, warnings)
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
  const tasks = {
    total: taskRecords.length,
    counts: taskCounts,
    current: typeof state.tasks.current === 'string' ? state.tasks.current : null,
    active: activeTasksOf(taskRecords),
    recentDone: recentDoneOf(taskRecords, recentLimit),
  }

  const gates = (Array.isArray(state.gates.items) ? state.gates.items : []).map((gate) => ({
    ...gate,
    lastRun: gate.lastRun === undefined ? null : gate.lastRun,
  }))

  const gateSection = isPlainObject(contract.gate) ? contract.gate : {}
  const gateContract = {
    gate: {
      log: gateSection.log === undefined ? null : gateSection.log,
      lines: pickInteger(gateSection.lines, 40, 0, 5000),
    },
  }
  const gate = readGate(root, gateContract, warnings)

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
    gate,
    heartbeats: readHeartbeats(root, contract, now, warnings),
    runs: readRuns(root, contract, now, warnings),
    warnings,
  }
}

/** Legacy payload: experiment trailers, `.agents` ledgers and the observation log. */
async function buildLegacyState(root, entry, now, warnings) {
  const { contract, source } = loadContract(root, warnings)
  entry.name = contract.name

  const [head, legacyExperiments] = await Promise.all([
    readHead(root, warnings),
    readExperiments(root, contract, warnings),
  ])

  const tasks = readTasks(root, contract, warnings)
  const gate = readGate(root, contract, warnings)
  const heartbeats = readHeartbeats(root, contract, now, warnings)
  const runs = readRuns(root, contract, now, warnings)

  const experiments = {
    ...legacyExperiments,
    source: 'git-trailers',
    items: [],
    tree: [],
  }

  return {
    ok: true,
    generatedAt: isoLocal(new Date(now)),
    contract: { source, schema: contract.schema, name: contract.name },
    roots: [],
    root,
    head,
    experiments,
    tasks,
    gates: [],
    gate,
    heartbeats,
    runs,
    warnings,
  }
}

async function buildState(root, entry, now) {
  const warnings = mountWarnings.slice()
  let payload
  if (coreAvailable() && hasStore(root)) {
    payload = await buildStoreState(root, entry, now, warnings)
  } else {
    payload = await buildLegacyState(root, entry, now, warnings)
    if (hasStore(root)) {
      warnings.push(`store present but lib/core.mjs is unavailable: ${coreFailure || 'unknown error'}`)
    }
  }
  return payload
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
        'root is neither a registered workspace, inside one, nor a directory with a flow manifest',
      )
      return
    }
  } else {
    root = canonicalRoot(process.cwd())
    // Without an explicit root there is no chosen workspace: it must both be
    // accepted and actually carry a ledger, otherwise nothing is scoped.
    if (rootAccepted(root, workspaces) === false || hasContract(root) === false) {
      sendJson(response, 200, {
        ok: false,
        generatedAt: isoLocal(new Date(now)),
        roots: [],
        root: null,
        error: { code: 'no-project', message: 'no workspace declares a flow contract or a default ledger layout' },
      })
      return
    }
  }

  const entry = { path: root, name: rootName(root, workspaces) }

  if (hasContract(root) === false) {
    sendJson(response, 200, {
      ok: false,
      generatedAt: isoLocal(new Date(now)),
      root,
      roots: [entry],
      error: { code: 'not-initialized', message: `no flow ledger in ${root}; run: node bin/flow.mjs init` },
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
// The only write on the HTTP surface. It never touches the store directly: after
// the same root scoping as the read endpoint it hands the directory to
// lib/core.mjs, so validation, locking and the atomic write stay in one place.

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
      'root is neither a registered workspace, inside one, nor a directory with a flow manifest',
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
    imported: isPlainObject(result?.imported) ? result.imported : { trailers: 0, tasks: 0 },
    warnings,
  })
}

// ------------------------------------------------------------------- tools
//
// Four model-facing tools over the same lib/core.mjs writer the CLI uses. They
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

function legacyExperimentItems(payload) {
  const items = []
  for (const group of Array.isArray(payload.groups) ? payload.groups : []) {
    for (const item of Array.isArray(group.items) ? group.items : []) {
      items.push({
        id: item.id,
        title: item.subject,
        status: item.verdict ?? 'open',
        verdict: item.verdict,
        factor: group.factor,
        hypothesis: item.hypothesis,
        expected: item.expected,
        measured: item.measured,
        scale: item.scale,
        sha: item.sha,
        date: item.date,
      })
    }
  }
  return items
}

async function legacyExpList(root) {
  const warnings = []
  const { contract } = loadContract(root, warnings)
  const payload = await readExperiments(root, contract, warnings)
  const items = legacyExperimentItems(payload).slice(0, MAX_TOOL_ITEMS)
  return {
    root,
    store: false,
    source: 'git-trailers',
    total: payload.total,
    counts: { total: payload.total, open: payload.open, confirmed: payload.confirmed, refuted: payload.refuted, abandoned: 0 },
    items,
    ...(items.length < payload.total ? { truncated: true } : {}),
    warnings,
  }
}

function legacyTaskList(root) {
  const warnings = []
  const { contract } = loadContract(root, warnings)
  const payload = readTasks(root, contract, warnings)
  const items = [...payload.active, ...payload.recentDone].slice(0, MAX_TOOL_ITEMS)
  return {
    root,
    store: false,
    source: contract.tasks.source,
    total: payload.total,
    counts: payload.counts,
    current: payload.current,
    items,
    ...(items.length < payload.total ? { truncated: true } : {}),
    warnings,
  }
}

function buildToolDefinitions(ctx) {
  return [
    {
      name: 'flow_status',
      description:
        'Report the project flow ledger: contract source, experiment and task totals, and gate definitions with their last result. Read-only. Works with the .dsh/flow store or a legacy ledger (.agents/ + git trailers).',
      parameters: { type: 'object', properties: { root: ROOT_PROPERTY }, required: [], additionalProperties: false },
      output: toolOutput(),
      isConcurrencySafe: true,
      timeoutMs: 15_000,
      async execute(args, exec) {
        const root = toolRoot(ctx, args, exec)
        if (coreAvailable() && hasStore(root)) {
          const c = requireCore()
          const loaded = c.loadContract(root)
          const state = c.readStoreState(root, loaded.contract)
          const experiments = state.experiments
          const tasks = state.tasks
          return {
            root,
            store: true,
            contract: { source: loaded.source, schema: loaded.contract.schema, name: loaded.contract.name },
            experiments: { total: experiments.counts.total, counts: experiments.counts },
            tasks: { total: tasks.counts.total, counts: tasks.counts },
            gates: (Array.isArray(state.gates.items) ? state.gates.items : []).map((gate) => ({
              id: gate.id,
              ok: gate.lastRun === null || gate.lastRun === undefined ? null : gate.lastRun.ok === true,
              at: gate.lastRun === null || gate.lastRun === undefined ? null : gate.lastRun.started_at,
            })),
          }
        }
        const warnings = []
        const { contract, source } = loadContract(root, warnings)
        const experiments = await readExperiments(root, contract, warnings)
        const tasks = readTasks(root, contract, warnings)
        return {
          root,
          store: false,
          contract: { source, schema: contract.schema, name: contract.name },
          experiments: {
            total: experiments.total,
            counts: { open: experiments.open, confirmed: experiments.confirmed, refuted: experiments.refuted, abandoned: 0 },
          },
          tasks: { total: tasks.total, counts: tasks.counts },
          gates: [],
          warnings,
        }
      },
    },
    {
      name: 'flow_exp',
      description:
        'List, inspect, add, update or remove project-flow experiments (id, hypothesis, factor, expected, measured, status, parent lineage). Writes require a .dsh/flow store; list also reads legacy git trailers. `tree` returns the parent/child forest.',
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
        if (action === 'list' && hasStore(root) === false) return legacyExpList(root)
        if (action !== 'list' && action !== 'show' && action !== 'tree') requireStore(root)
        if (action === 'show' || action === 'tree') requireStore(root)

        const c = requireCore()
        const { contract } = c.loadContract(root)
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
        'List, inspect, add, update or remove project-flow tasks (title, status, owner, goal, scope, acceptance, commits). Writes require a .dsh/flow store; list also reads legacy .agents task ledgers.',
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
        if (action === 'list' && hasStore(root) === false) return legacyTaskList(root)
        if (action !== 'list') requireStore(root)

        const c = requireCore()
        const { contract } = c.loadContract(root)
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

function registerTools(ctx) {
  provide(ctx, 'tools', 'tools', (scoped) => {
    const tools = service(scoped, 'tools')
    if (tools === undefined || typeof tools.register !== 'function') return () => {}
    const disposers = []
    for (const definition of buildToolDefinitions(ctx)) {
      try {
        const dispose = tools.register(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        warnMount(`tools: cannot register ${definition.name}: ${brief(error)}`, scoped)
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
    description: 'Initialize or migrate a project to the .dsh/flow store (schema 2) and inspect the resulting layout.',
    whenToUse:
      'Use when the project has no .dsh/flow/flow.json, when the user asks to set up or migrate project flow, or when flow tools report a missing store.',
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

export function apply(ctx) {
  const route = {
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (request, response) => {
      Promise.resolve()
        .then(() => handleState(ctx, request, response))
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
  }, 'project-flow: state route')

  const initRoute = {
    kind: 'exact',
    path: INIT_ROUTE_PATH,
    handler: (request, response) => {
      Promise.resolve()
        .then(() => handleInit(ctx, request, response))
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

  ctx.effect(() => {
    const webServer = service(ctx, 'webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return () => {}
    const dispose = webServer.register(initRoute)
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // Disposal must never throw into the host.
      }
    }
  }, 'project-flow: init route')

  // Optional services: a host without tools/skills (or a plain test double)
  // must still get the endpoint. Never let one of these take the plugin down.
  try {
    registerTools(ctx)
  } catch (error) {
    warnMount(`tools: registration failed: ${brief(error)}`, ctx)
  }
  try {
    registerSkills(ctx)
  } catch (error) {
    warnMount(`skills: registration failed: ${brief(error)}`, ctx)
  }
}
