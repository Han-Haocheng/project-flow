// project-flow — Host half.
//
// Registers one read-only JSON endpoint, /api/project-flow/state, that reports
// whatever ledger layout a project declares in its flow contract: experiment
// trailers, tasks, gate log, subagent heartbeats and recently written run
// output. Discovery happens per request; there are no watchers, no writes and
// no dependencies beyond node built-ins.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

export const inject = ['webServer']

const ROUTE_PATH = '/api/project-flow/state'
const GIT_TIMEOUT_MS = 4000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const MAX_STRING = 400
const MAX_PAYLOAD_BYTES = 900 * 1000
const MANIFESTS = ['flow.json', join('.flow', 'flow.json'), join('.agents', 'flow.json')]
const DEFAULT_MARKERS = [
  join('.agents', 'tasks'),
  join('.agents', 'gate-observe.log'),
  join('.agents', 'scripts', 'exp.py'),
]
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
      groupBy: 'Factor',
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
    target.groupBy = pickNonEmpty(section.groupBy, target.groupBy)
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

// ---------------------------------------------------------------- candidates

function readManifestName(root) {
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

/** Whether one root carries an explicit flow manifest (any of the discovered names). */
function hasManifest(root) {
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

/** A root is a candidate when it carries a manifest or one of the default markers. */
function hasContract(root) {
  if (hasManifest(root)) return true
  return hasDefaultLayout(root)
}

/**
 * Every registered workspace that opted in with a flow contract. Falls back to
 * the process working directory when the registry service is unavailable.
 */
function listCandidates(ctx) {
  const candidates = []
  const seen = new Set()
  const add = (path) => {
    if (typeof path !== 'string' || path.length === 0) return
    let canonical
    try {
      canonical = resolve(path)
    } catch {
      return
    }
    if (seen.has(canonical)) return
    seen.add(canonical)
    if (!hasContract(canonical)) return
    candidates.push({ path: canonical, name: readManifestName(canonical) })
  }

  let registry
  try {
    registry = ctx.get('workspaceRegistry')
  } catch {
    registry = undefined
  }
  if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list()) {
        if (workspace === null || workspace === undefined) continue
        let path
        try {
          path = workspace.path
        } catch {
          path = undefined
        }
        add(path)
      }
    } catch {
      // A broken registry projection must not kill the endpoint.
    }
  }
  if (candidates.length === 0) add(process.cwd())
  return candidates
}

function tasksDirMtime(root) {
  try {
    return statSync(join(root, '.agents', 'tasks')).mtimeMs
  } catch {
    return Number.NEGATIVE_INFINITY
  }
}

function pickRoot(candidates) {
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  let best = candidates[0]
  let bestMtime = tasksDirMtime(best.path)
  for (const candidate of candidates.slice(1)) {
    const mtime = tasksDirMtime(candidate.path)
    if (mtime > bestMtime) {
      best = candidate
      bestMtime = mtime
    }
  }
  return best
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
      // `groupBy` names an actual git trailer key, which may be any mapped key.
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
    const rawFactor = row.byKey.get(experiments.groupBy) ?? ''
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

/** Keep the response well under 1 MB without throwing: drop the least important tail first. */
function capPayload(payload) {
  let body = JSON.stringify(payload)
  if (Buffer.byteLength(body) <= MAX_PAYLOAD_BYTES) return body

  payload.warnings.push('payload-truncated')

  const groups = payload.experiments.groups
  for (;;) {
    let biggest = null
    for (const group of groups) {
      if (group.items.length === 0) continue
      if (biggest === null || group.items.length > biggest.items.length) biggest = group
    }
    if (biggest === null) break
    biggest.items.pop()
    body = JSON.stringify(payload)
    if (Buffer.byteLength(body) <= MAX_PAYLOAD_BYTES) return body
  }

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

async function buildState(root, candidate, now) {
  const warnings = []
  const { contract, source } = loadContract(root, warnings)
  candidate.name = contract.name

  const [head, experiments] = await Promise.all([
    readHead(root, warnings),
    readExperiments(root, contract, warnings),
  ])

  const tasks = readTasks(root, contract, warnings)
  const gate = readGate(root, contract, warnings)
  const heartbeats = readHeartbeats(root, contract, now, warnings)
  const runs = readRuns(root, contract, now, warnings)

  return {
    ok: true,
    generatedAt: isoLocal(new Date(now)),
    contract: { source, schema: contract.schema, name: contract.name },
    roots: [],
    root,
    head,
    experiments,
    tasks,
    gate,
    heartbeats,
    runs,
    warnings,
  }
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

  let candidates
  try {
    candidates = listCandidates(ctx)
  } catch (error) {
    sendError(response, 500, 'internal', brief(error))
    return
  }

  const requested = url.searchParams.get('root')
  let chosen
  if (requested !== null) {
    let canonical
    try {
      canonical = resolve(requested)
    } catch (error) {
      sendError(response, 400, 'bad-root', brief(error))
      return
    }
    chosen = candidates.find((candidate) => candidate.path === canonical)
    if (chosen === undefined) {
      // An explicit root is also accepted when it opts in with its own flow
      // manifest, even if no workspace registry row points at it yet.
      if (hasManifest(canonical)) {
        chosen = { path: canonical, name: readManifestName(canonical) }
        candidates.push(chosen)
      } else {
        sendError(response, 400, 'unknown-root', 'root is neither a registered workspace nor a directory with a flow manifest')
        return
      }
    }
  } else {
    chosen = pickRoot(candidates)
  }

  const now = Date.now()
  if (chosen === undefined) {
    sendJson(response, 200, {
      ok: false,
      generatedAt: isoLocal(new Date(now)),
      roots: [],
      root: null,
      error: { code: 'no-project', message: 'no workspace declares a flow contract or a default ledger layout' },
    })
    return
  }

  try {
    const payload = await buildState(chosen.path, chosen, now)
    payload.roots = candidates.map((candidate) => ({ path: candidate.path, name: candidate.name }))
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
      roots: candidates.map((candidate) => ({ path: candidate.path, name: candidate.name })),
      root: chosen.path,
      error: { code: 'internal', message: brief(error, 400) },
    })
  }
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
}
