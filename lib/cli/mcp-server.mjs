// project-flow — MCP server (stdio, workflow-capable).
//
// Read-only ledger inspection remains the default surface, but the full task
// workflow needs writes and autonomous dispatch. The server therefore has three
// execution paths:
//   1. `cli`: a closed tool->CLI mapping for domains that already have a mature
//      CLI contract (experiments, gates, decisions, heartbeat, desc, check, ...);
//   2. `task` / `subtask`: direct core writes for the task lifecycle, because the
//      workflow needs fields the CLI deliberately does not expose (scope,
//      acceptance, commits, CAS revisions);
//   3. `orchestrate`: a ledger-driven local runner that claims queued tasks and
//      spawns role workers (analyzer / implementer / reviewer).
//
// Security boundary: callers cannot pass arbitrary commands or flags. Every
// forwarded flag comes from the closed table below; task writes use core's
// validation and lock; arbitrary shell execution exists only inside the
// operator-configured agent runner.

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

import { createOrchestrator } from '../mcp/orchestrator.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = path.resolve(HERE, '../../bin/flow.mjs')
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

export const SERVER_INFO = Object.freeze({ name: 'project-flow', version: '0.2.0' })

const ROOT_PROPERTY = Object.freeze({
  type: 'string',
  description: 'Project root (absolute or relative to the server cwd). Defaults to --root, then $FLOW_ROOT, then the server cwd.',
})
const ACTION_PROPERTY = (values, description = 'Which operation to run.') => ({
  type: 'string', enum: [...values], description,
})
const ID_PROPERTY = { type: 'string', description: 'Record id.' }

const TASK_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci']
const STAGES = ['created', 'queued-analysis', 'analyzing', 'queued-implementation', 'implementing', 'queued-review', 'reviewing', 'done', 'archived']
const TASK_STATUS = ['draft', 'active', 'done', 'archived']
const EXPERIMENT_STATUS = ['open', 'confirmed', 'refuted', 'abandoned', 'inconclusive', 'pivoted']

const P = Object.freeze({
  title: { type: 'string' },
  type: { type: 'string', enum: TASK_TYPES },
  stage: { type: 'string', enum: STAGES },
  status: { type: 'string' },
  owner: { type: 'string' },
  notes: { type: 'string' },
  experiment: { type: 'string' },
  parent: { type: 'string' },
  scope: { type: 'object', additionalProperties: true },
  acceptance: { type: 'array', items: { type: 'string' } },
  commits: { type: 'array', items: { type: 'string' } },
  expectedRevision: { type: 'string' },
  yes: { type: 'boolean' },
  timeout: { type: 'integer', minimum: 1 },
  id: ID_PROPERTY,
  hypothesis: { type: 'string' },
  factor: { type: 'string' },
  scale: { type: 'string' },
  direction: { type: 'string' },
  expected: { type: 'string' },
  primaryMetric: { type: 'string' },
  guardrails: { type: 'array', items: { type: 'string' } },
  falsify: { type: 'string' },
  windowDays: { type: 'integer', minimum: 1 },
  stopLoss: { type: 'string' },
  measured: { type: 'string' },
  metrics: { type: 'object', additionalProperties: true },
  learned: { type: 'string' },
  phase: { type: 'string', enum: ['commit', 'release', 'manual'] },
  step: { type: 'array', items: { type: 'string' } },
  enabled: { type: 'boolean' },
  force: { type: 'boolean' },
  limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
  question: { type: 'string' },
  kind: { type: 'string' },
  option: { type: 'array', items: { type: 'string' } },
  default: { type: 'string' },
  recommendation: { type: 'string' },
  rationale: { type: 'string' },
  blocks: { type: 'array', items: { type: 'string' } },
  affects: { type: 'array', items: { type: 'string' } },
  supersedes: { type: 'string' },
  choice: { type: 'string' },
  note: { type: 'string' },
  by: { type: 'string' },
  reason: { type: 'string' },
  goal: { type: 'string' },
  task: { type: 'string' },
  session: { type: 'string' },
  agent: { type: 'string' },
  claim: { type: 'array', items: { type: 'string' } },
  all: { type: 'boolean' },
  requireActive: { type: 'boolean' },
  dryRun: { type: 'boolean' },
  olderThanHours: { type: 'integer', minimum: 1 },
  olderThan: { type: 'integer', minimum: 1 },
  days: { type: 'integer', minimum: 1 },
  path: { type: 'string' },
  graph: { type: 'string', enum: ['tree', 'mermaid'] },
  input: { anyOf: [{ type: 'object' }, { type: 'string' }] },
  projectSemantics: { type: 'string' },
  template: { type: 'string' },
  show: { type: 'boolean' },
  rebase: { type: 'boolean' },
  noSemanticChange: { type: 'boolean' },
  out: { type: 'string' },
  check: { type: 'boolean' },
  allow: { type: 'array', items: { type: 'string' } },
  marker: { type: 'string' },
  threshold: { type: 'integer', minimum: 1 },
  file: { type: 'string' },
  strict: { type: 'boolean' },
  typeMap: { type: 'string' },
  name: { type: 'string' },
  noGates: { type: 'boolean' },
  keep: { type: 'integer', minimum: 1 },
  staleHours: { type: 'number', minimum: 0 },
  taskId: { type: 'string' },
  maxConcurrent: { type: 'integer', minimum: 1, maximum: 8 },
  intervalMs: { type: 'integer', minimum: 250 },
  runnerCommand: { type: 'string' },
  runnerArgs: { type: 'array', items: { type: 'string' } },
  runnerTimeoutMs: { type: 'integer', minimum: 1 },
})

function schemaProperties(spec) {
  const properties = { root: ROOT_PROPERTY, ...(spec.properties || {}) }
  if (spec.actions) properties.action = ACTION_PROPERTY(spec.actions, spec.actionDescription)
  if (spec.actions && spec.idActions) properties.id = ID_PROPERTY
  return properties
}

export const TOOL_SPECS = Object.freeze([
  Object.freeze({
    name: 'flow_status', kind: 'cli', command: ['status'],
    description: 'Read the project ledger summary. Read-only.',
    properties: {},
  }),
  Object.freeze({
    name: 'flow_task', kind: 'task',
    description: 'Full task workflow: list/show/next/add/update/verify/dispatch/rm. Updates use core validation, locks, stage machine, acceptance gate and optional expectedRevision CAS. Use stage, not status, for workflow transitions.',
    actions: ['list', 'show', 'next', 'add', 'update', 'verify', 'dispatch', 'rm'],
    idActions: ['show', 'next', 'update', 'verify', 'dispatch', 'rm'],
    properties: { title: P.title, type: P.type, stage: P.stage, status: P.status, owner: P.owner, notes: P.notes, experiment: P.experiment, parent: P.parent, scope: P.scope, acceptance: P.acceptance, commits: P.commits, expectedRevision: P.expectedRevision, timeout: P.timeout, yes: P.yes },
  }),
  Object.freeze({
    name: 'flow_subtask', kind: 'subtask',
    description: 'Manage a parent task\'s implementation subtasks. add defaults to stage queued-implementation; update accepts notes/stage; remove completes the child and preserves its history. list returns children.',
    actions: ['list', 'add', 'update', 'remove'],
    idActions: ['update', 'remove'],
    properties: { parent: P.parent, title: P.title, type: P.type, notes: P.notes, scope: P.scope, acceptance: P.acceptance, stage: P.stage, expectedRevision: P.expectedRevision, reason: P.reason },
  }),
  Object.freeze({
    name: 'flow_exp', kind: 'cli', command: ['exp'],
    description: 'Experiment lifecycle and lineage: list/show/tree/add/update/review/productize/cleanup/rm. add requires the schema-2 seven judging fields.',
    actions: ['list', 'show', 'tree', 'add', 'update', 'review', 'productize', 'cleanup', 'rm'],
    idActions: ['show', 'update', 'review', 'productize', 'cleanup', 'rm'],
    properties: { title: P.title, hypothesis: P.hypothesis, factor: P.factor, parent: P.parent, scale: P.scale, notes: P.notes, direction: P.direction, expected: P.expected, primaryMetric: P.primaryMetric, guardrails: P.guardrails, falsify: P.falsify, windowDays: P.windowDays, stopLoss: P.stopLoss, status: { type: 'string', enum: EXPERIMENT_STATUS }, measured: P.measured, metrics: P.metrics, commits: P.commits, learned: P.learned, gate: P.id, flag: { type: 'array', items: { type: 'string' } }, code: { type: 'array', items: { type: 'string' } }, data: { type: 'array', items: { type: 'string' } }, yes: P.yes },
  }),
  Object.freeze({
    name: 'flow_gate', kind: 'cli', command: ['gate'],
    description: 'Gate definitions and runs: list/show/logs/run/enable/disable/add/update/rm. run executes shell steps and writes a run log.',
    actions: ['list', 'show', 'logs', 'run', 'enable', 'disable', 'add', 'update', 'rm'],
    idActions: ['show', 'logs', 'run', 'enable', 'disable', 'update', 'rm'],
    properties: { title: P.title, phase: P.phase, step: P.step, enabled: P.enabled, force: P.force, timeout: P.timeout, limit: P.limit, yes: P.yes },
  }),
  Object.freeze({
    name: 'flow_decision', kind: 'cli', command: ['decision'],
    description: 'Decision records: list/show/ask/answer/withdraw. Use ask before asking the user; answer when they reply.',
    actions: ['list', 'show', 'ask', 'answer', 'withdraw'],
    idActions: ['show', 'answer', 'withdraw'],
    properties: { question: P.question, kind: P.kind, option: P.option, default: P.default, recommendation: P.recommendation, rationale: P.rationale, blocks: P.blocks, affects: P.affects, supersedes: P.supersedes, choice: P.choice, note: P.note, by: P.by, reason: P.reason, open: { type: 'boolean' }, all: P.all },
  }),
  Object.freeze({
    name: 'flow_heartbeat', kind: 'cli', command: ['heartbeat'],
    description: 'Session heartbeat operations: list/status/start/update/end/rm/gc. Workers normally leave heartbeat management to the main session.',
    actions: ['list', 'status', 'start', 'update', 'end', 'rm', 'gc'],
    idActions: ['rm'],
    properties: { goal: P.goal, task: P.task, claim: P.claim, agent: P.agent, session: P.session, note: P.note, status: { type: 'string' }, all: P.all, requireActive: P.requireActive, dryRun: P.dryRun, olderThanHours: P.olderThanHours, yes: P.yes },
  }),
  Object.freeze({
    name: 'flow_desc', kind: 'cli', command: ['desc'],
    description: 'Description ledger: status/build/show/set/plan/apply/render. Semantic plan input may be an object or a file path.',
    actions: ['status', 'build', 'show', 'set', 'plan', 'apply', 'render'],
    idActions: ['plan', 'apply'],
    properties: { path: P.path, graph: P.graph, input: P.input, projectSemantics: P.projectSemantics, template: P.template, show: P.show, rebase: P.rebase, noSemanticChange: P.noSemanticChange, reason: P.reason, dryRun: P.dryRun, out: P.out, check: P.check },
  }),
  Object.freeze({
    name: 'flow_check', kind: 'cli', command: ['check'],
    description: 'Read-only mechanical checks: list/staged/release-baseline/decisions/experiments/tasks/description/state/doc.',
    actions: ['list', 'staged', 'release-baseline', 'decisions', 'experiments', 'tasks', 'description', 'state', 'doc'],
    properties: { allow: P.allow, marker: P.marker, threshold: P.threshold, timeout: P.timeout, file: P.file, type: { type: 'string', enum: ['task', 'design', 'incident', 'release'] }, task: P.task, strict: P.strict, typeMap: P.typeMap },
  }),
  Object.freeze({
    name: 'flow_doctor', kind: 'cli', command: ['doctor'],
    description: 'Read-only ledger health check.', properties: { staleHours: P.staleHours },
  }),
  Object.freeze({
    name: 'flow_backup', kind: 'cli', command: ['backup'],
    description: 'Create a local .agents snapshot.', properties: { keep: P.keep },
  }),
  Object.freeze({
    name: 'flow_init', kind: 'cli', command: ['init'],
    description: 'Initialize a project ledger. Seeds default gates unless noGates=true.', properties: { name: P.name, force: P.force, noGates: P.noGates },
  }),
  Object.freeze({
    name: 'flow_orchestrate', kind: 'orchestrate',
    description: 'Autonomous workflow orchestration. start creates or adopts a main task, then a background loop dispatches queued analyzer/implementer/reviewer workers and aggregates finished children. status/tick/stop inspect or control it.',
    actions: ['start', 'tick', 'status', 'stop'],
    properties: { taskId: P.taskId, title: P.title, type: P.type, notes: P.notes, scope: P.scope, acceptance: P.acceptance, maxConcurrent: P.maxConcurrent, intervalMs: P.intervalMs, runnerCommand: P.runnerCommand, runnerArgs: P.runnerArgs, runnerTimeoutMs: P.runnerTimeoutMs },
  }),
])

export class McpRequestError extends Error {
  constructor(message) { super(message); this.name = 'McpRequestError' }
}

export function mcpToolList() {
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties: schemaProperties(spec),
      required: spec.actions ? ['action'] : [],
      additionalProperties: false,
    },
  }))
}

function specOf(name) {
  return TOOL_SPECS.find((entry) => entry.name === name)
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new McpRequestError(`${label} must be an object`)
}

function validateToolArgs(spec, args) {
  const input = args === undefined ? {} : args
  assertObject(input, `${spec.name} arguments`)
  const allowed = new Set(['root', 'action', 'id', ...(Object.keys(spec.properties || {}))])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new McpRequestError(`${spec.name} does not accept argument "${key}"`)
  }
  if (spec.actions) {
    if (typeof input.action !== 'string' || spec.actions.includes(input.action) === false) {
      throw new McpRequestError(`${spec.name}.action must be one of: ${spec.actions.join(', ')}`)
    }
  }
  if (spec.idActions && spec.idActions.includes(input.action)) {
    const phaseOnlyRun = spec.name === 'flow_gate' && input.action === 'run' && typeof input.phase === 'string' && input.phase.trim() !== ''
    const flagIdAdd = spec.name === 'flow_gate' && input.action === 'add'
    if (!phaseOnlyRun && !flagIdAdd && (typeof input.id !== 'string' || input.id.trim() === '')) throw new McpRequestError(`${spec.name} action "${input.action}" requires a non-empty id`)
  }
  return input
}

const FLAG_NAMES = Object.freeze({
  primaryMetric: 'primary-metric', windowDays: 'window-days', stopLoss: 'stop-loss', guardrails: 'guardrail',
  requireActive: 'require-active', olderThanHours: 'older-than-hours', olderThan: 'older-than',
  typeMap: 'type-map', dryRun: 'dry-run', noSemanticChange: 'no-semantic-change',
  projectSemantics: 'project-semantics', noGates: 'no-gates', staleHours: 'stale-hours',
})
const BOOL_FLAGS = new Set(['force', 'yes', 'dryRun', 'open', 'all', 'strict', 'show', 'rebase', 'noSemanticChange', 'check', 'noGates', 'requireActive', 'allow-unknown-expect'])
const REPEAT_FLAGS = new Set(['guardrails', 'step', 'allow', 'option', 'blocks', 'affects', 'claim', 'flag', 'code', 'data'])
const VALUE_BOOL_FLAGS = new Set(['enabled'])

function flagName(key) {
  return FLAG_NAMES[key] || key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function mappedValue(key, value) {
  if (key === 'metrics' || key === 'scope' || key === 'acceptance') return JSON.stringify(value)
  if (key === 'commits') return Array.isArray(value) ? value.join(',') : String(value)
  if (key === 'option') {
    const one = (entry) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object') {
        const id = String(entry.id || '')
        const label = String(entry.label || id)
        const impact = entry.impact === undefined ? '' : `>>${String(entry.impact)}`
        return `${id}=${label}${impact}`
      }
      return String(entry)
    }
    return Array.isArray(value) ? value.map(one) : one(value)
  }
  return String(value)
}

function appendFlags(argv, spec, input) {
  for (const [key, value] of Object.entries(input)) {
    if (key === 'root' || key === 'action' || key === 'id' || value === undefined) continue
    if (!(spec.properties && Object.hasOwn(spec.properties, key))) continue
    const flag = flagName(key)
    if (REPEAT_FLAGS.has(key)) {
      const values = Array.isArray(value) ? value : [value]
      for (const item of values) {
        if (item === undefined || item === null) continue
        const mapped = mappedValue(key, item)
        if (Array.isArray(mapped)) {
          for (const entry of mapped) argv.push(`--${flag}`, entry)
        } else {
          argv.push(`--${flag}`, mapped)
        }
      }
      continue
    }
    if (BOOL_FLAGS.has(key) || BOOL_FLAGS.has(flag)) {
      if (value === true) argv.push(`--${flag}`)
      continue
    }
    if (VALUE_BOOL_FLAGS.has(key) || VALUE_BOOL_FLAGS.has(flag)) {
      argv.push(`--${flag}`, value === true ? 'true' : 'false')
      continue
    }
    const mapped = mappedValue(key, value)
    if (Array.isArray(mapped)) for (const entry of mapped) argv.push(`--${flag}`, entry)
    else argv.push(`--${flag}`, mapped)
  }
}

export function cliArgsFor(name, args = {}) {
  const spec = specOf(name)
  if (!spec) throw new McpRequestError(`unknown tool: ${String(name)}`)
  const input = validateToolArgs(spec, args)
  if (spec.kind === 'task') {
    if (!['list', 'show', 'next', 'verify'].includes(input.action)) throw new McpRequestError(`${name} ${input.action} is handled by core, not the CLI adapter`)
    const argv = ['task', input.action]
    if (input.id !== undefined) argv.push(input.id.trim())
    if (input.action === 'verify' && input.timeout !== undefined) argv.push('--timeout', String(input.timeout))
    return argv
  }
  if (spec.kind !== 'cli') throw new McpRequestError(`${name} is not a CLI-backed tool`)
  const argv = [...spec.command]
  if (spec.actions) argv.push(input.action)
  if (spec.idActions && spec.idActions.includes(input.action) && input.id !== undefined) argv.push(input.id.trim())
  appendFlags(argv, spec, input)
  if (name === 'flow_gate' && input.action === 'add') {
    if (typeof input.id !== 'string' || input.id.trim() === '') throw new McpRequestError('flow_gate action "add" requires a non-empty id')
    argv.push('--id', input.id.trim())
  }
  if (name === 'flow_exp' && input.action === 'add' && typeof input.id === 'string' && input.id.trim() !== '') argv.push('--id', input.id.trim())
  if (name === 'flow_gate' && input.action === 'logs' && input.limit === undefined) argv.push('--limit', String(DEFAULT_LIMIT))
  return argv
}

export function parseEnvelope(stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') throw new McpRequestError('flow CLI produced no output')
  let payload
  try { payload = JSON.parse(text) } catch { throw new McpRequestError(`flow CLI output is not JSON: ${text.slice(0, 500)}`) }
  if (payload === null || typeof payload !== 'object' || typeof payload.ok !== 'boolean') {
    throw new McpRequestError('flow CLI output is not a flow envelope')
  }
  return payload
}

function runCli({ root, argv, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, '--root', root, '--json', ...argv],
      { cwd: root, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, env: process.env },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code === 'string') {
          reject(new McpRequestError(`cannot start flow CLI: ${error.message}`))
          return
        }
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout, stderr, timedOut: error?.killed === true })
      },
    )
  })
}

const LIST_FIELDS = Object.freeze({
  flow_task: Object.freeze(['id', 'type', 'status', 'stage', 'parent', 'owner', 'title', 'updated_at']),
  flow_exp: Object.freeze(['id', 'status', 'factor', 'parent', 'title', 'updated_at']),
  flow_decision: Object.freeze(['id', 'question', 'kind', 'status', 'created_at', 'answered_at']),
})

function projectData(name, argv, data) {
  const isList = argv[1] === 'list'
  const fields = LIST_FIELDS[name]
  if (isList === false || fields === undefined || Array.isArray(data) === false) return data
  return data.map((record) => {
    if (record === null || typeof record !== 'object') return record
    const row = {}
    for (const field of fields) if (record[field] !== undefined) row[field] = record[field]
    return row
  })
}

function toToolResult(envelope, stderr, name, argv) {
  const warnings = Array.isArray(envelope.warnings) ? envelope.warnings : []
  if (envelope.ok === true) {
    const content = [{ type: 'text', text: JSON.stringify(projectData(name, argv, envelope.data ?? null), null, 2) }]
    if (warnings.length > 0) content.push({ type: 'text', text: `warnings:\n${JSON.stringify(warnings, null, 2)}` })
    return { content, isError: false }
  }
  const error = envelope.error !== null && typeof envelope.error === 'object' ? envelope.error : {}
  const code = typeof error.code === 'string' ? error.code : 'error'
  const message = typeof error.message === 'string' ? error.message : JSON.stringify(error)
  const extras = Object.fromEntries(Object.entries(error).filter(([key]) => key !== 'code' && key !== 'message'))
  let text = `${code}: ${message}`
  if (Object.keys(extras).length > 0) text += `\n${JSON.stringify(extras, null, 2)}`
  if (warnings.length > 0) text += `\nwarnings:\n${JSON.stringify(warnings, null, 2)}`
  const tail = String(stderr ?? '').trim()
  if (tail !== '') text += `\nstderr:\n${tail.slice(0, 2000)}`
  return { content: [{ type: 'text', text }], isError: true }
}

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false }
}

function failure(error) {
  const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'error'
  return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true }
}

export function resolveRoot(value, fallback) {
  const candidate = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  const absolute = path.resolve(candidate)
  let stats
  try { stats = statSync(absolute) } catch { throw new McpRequestError(`root does not exist: ${absolute}`) }
  if (stats.isDirectory() !== true) throw new McpRequestError(`root is not a directory: ${absolute}`)
  return absolute
}

let corePromise = null
function loadCore() {
  corePromise ||= import('../core.mjs')
  return corePromise
}

function withRevision(core, root, contract, task) {
  if (!task || typeof task !== 'object') return task
  try {
    const revision = core.taskRevisionOf(root, contract, task.id)
    return typeof revision === 'string' && revision !== '' ? { ...task, revision } : task
  } catch { return task }
}

const TASK_INPUT_FIELDS = Object.freeze(['id', 'title', 'type', 'status', 'stage', 'owner', 'notes', 'experiment', 'scope', 'acceptance', 'commits'])
const TASK_PATCH_FIELDS = Object.freeze(['status', 'stage', 'owner', 'notes', 'experiment', 'scope', 'acceptance', 'commits'])

function taskInput(core, input) {
  const output = {}
  for (const key of TASK_INPUT_FIELDS) {
    if (input[key] !== undefined) output[key] = input[key]
  }
  if (input.parent !== undefined) output.parent = core.normalizeParentInput(input.parent)
  return output
}

function taskPatch(core, input) {
  const output = {}
  for (const key of TASK_PATCH_FIELDS) {
    if (input[key] !== undefined) output[key] = input[key]
  }
  if (input.parent !== undefined) output.parent = core.normalizeParentInput(input.parent)
  return output
}

async function callTaskTool(root, input, options) {
  const core = await loadCore()
  const { contract } = core.loadContract(root)
  if (input.action === 'list') {
    const fields = ['id', 'type', 'status', 'stage', 'parent', 'owner', 'title', 'updated_at']
    return core.listTasks(root, contract).map((task) => {
      const row = {}
      for (const field of fields) if (task[field] !== undefined) row[field] = task[field]
      return row
    })
  }
  if (input.action === 'show') return withRevision(core, root, contract, core.getTask(root, contract, input.id))
  if (input.action === 'next') {
    const argv = ['task', 'next', input.id.trim()]
    const run = await runCli({ root, argv, timeoutMs: options.timeoutMs })
    const envelope = parseEnvelope(run.stdout)
    if (envelope.ok !== true) throw new Error(`${envelope.error?.code || 'error'}: ${envelope.error?.message || 'task next failed'}`)
    return envelope.data
  }
  if (input.action === 'add') {
    const task = core.addTask(root, contract, taskInput(core, input))
    return withRevision(core, root, contract, task)
  }
  if (input.action === 'update') {
    const patch = taskPatch(core, input)
    if (Object.keys(patch).length === 0) throw new McpRequestError('flow_task update requires at least one field')
    const writeOptions = {}
    if (typeof input.expectedRevision === 'string' && input.expectedRevision.trim() !== '') writeOptions.expectedRevision = input.expectedRevision.trim()
    return withRevision(core, root, contract, core.updateTask(root, contract, input.id, patch, writeOptions))
  }
  if (input.action === 'rm') {
    if (input.yes !== true) throw new McpRequestError('flow_task rm requires yes=true')
    return core.removeTask(root, contract, input.id)
  }
  if (input.action === 'verify') {
    const argv = ['task', 'verify', input.id.trim()]
    if (input.timeout !== undefined) argv.push('--timeout', String(input.timeout))
    const run = await runCli({ root, argv, timeoutMs: options.timeoutMs })
    const envelope = parseEnvelope(run.stdout)
    if (envelope.ok !== true) throw new Error(`${envelope.error?.code || 'error'}: ${envelope.error?.message || 'task verify failed'}`)
    return envelope.data
  }
  if (input.action === 'dispatch') {
    const orchestrator = orchestratorFor(root, options)
    orchestrator.core = core
    orchestrator.contract = contract
    const task = core.getTask(root, contract, input.id)
    await orchestrator.dispatchTask(task)
    return orchestrator.status()
  }
  throw new McpRequestError(`unknown flow_task action: ${input.action}`)
}

async function callSubtaskTool(root, input) {
  const core = await loadCore()
  const { contract } = core.loadContract(root)
  const action = input.action
  if (action === 'list') {
    const parent = typeof input.parent === 'string' ? input.parent.trim() : ''
    if (parent === '') throw new McpRequestError('flow_subtask list requires parent')
    return core.listTasks(root, contract).filter((task) => task.parent === parent)
  }
  if (action === 'add') {
    const parentId = typeof input.parent === 'string' ? input.parent.trim() : ''
    if (parentId === '') throw new McpRequestError('flow_subtask add requires parent')
    const parent = core.getTask(root, contract, parentId)
    if (!['analyzing', 'queued-implementation', 'implementing'].includes(parent.stage)) {
      throw new McpRequestError(`parent ${parentId} is in stage ${parent.stage}; subtasks are only allowed in analyzing/queued-implementation/implementing`)
    }
    const child = {}
    for (const key of ['id', 'type', 'title', 'notes', 'scope', 'acceptance']) if (input[key] !== undefined) child[key] = input[key]
    child.parent = parentId
    child.stage = typeof input.stage === 'string' ? input.stage : 'queued-implementation'
    return withRevision(core, root, contract, core.addTask(root, contract, child))
  }
  if (action === 'update') {
    const patch = {}
    for (const key of ['notes', 'stage']) if (input[key] !== undefined) patch[key] = input[key]
    if (patch.stage !== undefined) {
      const stage = await import('../stage.mjs')
      const current = core.getTask(root, contract, input.id)
      stage.assertTransition(current.stage, patch.stage)
    }
    const writeOptions = {}
    if (typeof input.expectedRevision === 'string' && input.expectedRevision.trim() !== '') writeOptions.expectedRevision = input.expectedRevision.trim()
    return withRevision(core, root, contract, core.updateTask(root, contract, input.id, patch, writeOptions))
  }
  if (action === 'remove') {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (reason === '') throw new McpRequestError('flow_subtask remove requires reason')
    const current = core.getTask(root, contract, input.id)
    const line = `[removed] ${reason}`
    const notes = typeof current.notes === 'string' && current.notes.trimEnd() !== '' ? `${current.notes.trimEnd()}\n${line}` : line
    return withRevision(core, root, contract, core.updateTask(root, contract, input.id, { stage: 'done', notes }, { source: 'internal' }))
  }
  throw new McpRequestError(`unknown flow_subtask action: ${action}`)
}

function orchestratorFor(root, options = {}) {
  const orchestrators = options.orchestrators
  if (!(orchestrators instanceof Map)) throw new McpRequestError('orchestrator registry is unavailable')
  const existing = orchestrators.get(root)
  if (existing) return existing
  const workflow = options.workflow || {}
  const runner = {
    command: workflow.runnerCommand || 'codex',
    args: Array.isArray(workflow.runnerArgs) && workflow.runnerArgs.length > 0
      ? workflow.runnerArgs
      : ['exec', '--json', '--ephemeral', '-C', root, '--sandbox', 'workspace-write', '--approve-for-me', '-'],
    timeoutMs: workflow.runnerTimeoutMs || undefined,
  }
  const created = createOrchestrator({
    root,
    core: null,
    contract: null,
    runner,
    intervalMs: workflow.intervalMs,
    maxConcurrent: workflow.maxConcurrent,
    logger: console,
  })
  orchestrators.set(root, created)
  return created
}

async function callOrchestrateTool(root, input, options) {
  const orchestrator = orchestratorFor(root, options)
  if (orchestrator.contract === null) orchestrator.contract = (await loadCore()).loadContract(root).contract
  // The orchestrator's core shim is async; bind the contract once and replace
  // the shim methods with the real synchronous API for each call.
  const core = await loadCore()
  orchestrator.core = {
    getTask: (a, b, c) => core.getTask(a, b, c),
    addTask: (a, b, c) => core.addTask(a, b, c),
    updateTask: (a, b, c, d) => core.updateTask(a, b, c, d),
    listTasks: (a, b) => core.listTasks(a, b),
    taskRevisionOf: (a, b, c) => core.taskRevisionOf(a, b, c),
  }
  if (input.action === 'status') return orchestrator.status()
  if (input.action === 'tick') return orchestrator.tick()
  if (input.action === 'stop') return orchestrator.stop()
  if (input.action === 'start') {
    if (input.runnerCommand) orchestrator.runner.command = input.runnerCommand
    if (Array.isArray(input.runnerArgs) && input.runnerArgs.length > 0) orchestrator.runner.args = input.runnerArgs
    if (Number.isInteger(input.runnerTimeoutMs) && input.runnerTimeoutMs > 0) orchestrator.runner.timeoutMs = input.runnerTimeoutMs
    if (Number.isInteger(input.maxConcurrent)) orchestrator.maxConcurrent = Math.min(Math.max(input.maxConcurrent, 1), 8)
    if (Number.isInteger(input.intervalMs)) orchestrator.intervalMs = Math.max(input.intervalMs, 250)
    return orchestrator.start(input)
  }
  throw new McpRequestError(`unknown flow_orchestrate action: ${input.action}`)
}

async function materializeJsonInput(root, input) {
  if (input.input === undefined || typeof input.input !== 'object' || input.input === null) return input
  const dir = mkdtempSync(path.join(os.tmpdir(), 'project-flow-mcp-'))
  const file = path.join(dir, 'input.json')
  writeFileSync(file, JSON.stringify(input.input))
  return { ...input, input: file, __cleanupDir: dir }
}

export async function callTool(name, args, options = {}) {
  const spec = specOf(name)
  if (!spec) return failure(new McpRequestError(`unknown tool: ${String(name)}`))
  let input
  let root
  try {
    input = validateToolArgs(spec, args ?? {})
    root = resolveRoot(input.root, options.defaultRoot || process.cwd())
    if (input.parent !== undefined && typeof input.parent === 'string' && input.parent.trim() === '') input.parent = ''
    if (spec.kind === 'task') return result(await callTaskTool(root, input, options))
    if (spec.kind === 'subtask') return result(await callSubtaskTool(root, input))
    if (spec.kind === 'orchestrate') return result(await callOrchestrateTool(root, input, options))
    const materialized = await materializeJsonInput(root, input)
    const argv = cliArgsFor(name, materialized)
    let run
    try {
      run = await runCli({ root, argv, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS })
    } finally {
      if (materialized.__cleanupDir) rmSync(materialized.__cleanupDir, { recursive: true, force: true })
    }
    if (run.timedOut === true) {
      return { content: [{ type: 'text', text: `flow CLI timed out after ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms: ${argv.join(' ')}` }], isError: true }
    }
    return toToolResult(parseEnvelope(run.stdout), run.stderr, name, argv)
  } catch (error) {
    return failure(error)
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

export async function handleMessage(message, options = {}) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, -32600, 'invalid request: expected a JSON object')
  if (message.jsonrpc !== '2.0') return rpcError(message.id, -32600, 'invalid request: jsonrpc must be "2.0"')
  const isNotification = message.id === undefined || message.id === null
  const method = typeof message.method === 'string' ? message.method : ''
  if (method === '') return isNotification ? null : rpcError(message.id, -32600, 'invalid request: missing method')
  const params = message.params !== null && typeof message.params === 'object' ? message.params : {}
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
    return {
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: requested === '' ? DEFAULT_PROTOCOL_VERSION : requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'project-flow exposes both read-only ledger tools and a complete task workflow. Use flow_status first. Use flow_orchestrate start for autonomous task splitting and role dispatch; use flow_decision ask before asking the user to choose.',
      },
    }
  }
  if (isNotification) return null
  if (method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} }
  if (method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools: mcpToolList() } }
  if (method === 'tools/call') {
    if (typeof params.name !== 'string' || params.name === '') return rpcError(message.id, -32602, 'invalid params: name is required')
    return { jsonrpc: '2.0', id: message.id, result: await callTool(params.name, params.arguments ?? {}, options) }
  }
  return rpcError(message.id, -32601, `method not found: ${method}`)
}

export function parseServerArgs(argv = process.argv.slice(2)) {
  const options = {
    root: undefined, timeoutMs: DEFAULT_TIMEOUT_MS, help: false, version: false,
    workflow: { runnerCommand: undefined, runnerArgs: [], runnerTimeoutMs: undefined, intervalMs: undefined, maxConcurrent: undefined },
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const takeValue = (prefix) => {
      if (arg === prefix) {
        const value = argv[index + 1]
        if (value === undefined || value.startsWith('--')) throw new McpRequestError(`${prefix} requires a value`)
        index += 1
        return value
      }
      if (arg.startsWith(`${prefix}=`)) return arg.slice(prefix.length + 1)
      return undefined
    }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--version' || arg === '-v') { options.version = true; continue }
    const root = takeValue('--root')
    if (root !== undefined) { options.root = root; continue }
    const timeout = takeValue('--timeout')
    if (timeout !== undefined) {
      const seconds = Number(timeout)
      if (!Number.isFinite(seconds) || seconds <= 0) throw new McpRequestError('--timeout must be a positive number of seconds')
      options.timeoutMs = Math.round(seconds * 1000)
      continue
    }
    const runner = takeValue('--runner-command')
    if (runner !== undefined) { options.workflow.runnerCommand = runner; continue }
    if (arg === '--runner-arg') {
      const value = argv[index + 1]
      if (value === undefined) throw new McpRequestError('--runner-arg requires a value')
      options.workflow.runnerArgs.push(value)
      index += 1
      continue
    }
    if (arg.startsWith('--runner-arg=')) {
      options.workflow.runnerArgs.push(arg.slice('--runner-arg='.length))
      continue
    }
    const runnerTimeout = takeValue('--runner-timeout')
    if (runnerTimeout !== undefined) { options.workflow.runnerTimeoutMs = Math.round(Number(runnerTimeout) * 1000); continue }
    const interval = takeValue('--orchestrate-interval')
    if (interval !== undefined) { options.workflow.intervalMs = Number(interval); continue }
    const maxConcurrent = takeValue('--max-concurrent')
    if (maxConcurrent !== undefined) { options.workflow.maxConcurrent = Number(maxConcurrent); continue }
    throw new McpRequestError(`unknown argument: ${arg}`)
  }
  return options
}

export const USAGE = `project-flow MCP server (workflow-capable)

用法
  node bin/mcp.mjs [--root <dir>] [--timeout <seconds>]
                   [--runner-command <path>] [--runner-arg <arg>]...
                   [--runner-timeout <s>] [--orchestrate-interval <ms>]
                   [--max-concurrent <n>]

协议
  MCP over stdio（换行分隔的 JSON-RPC 2.0）：initialize / tools/list / tools/call。

能力
  查询：flow_status / flow_task / flow_exp / flow_gate / flow_decision / flow_desc / flow_check / flow_doctor / flow_heartbeat
  写入：flow_task / flow_subtask / flow_exp / flow_gate / flow_decision / flow_backup / flow_init
  自动编排：flow_orchestrate start|tick|status|stop
`

export async function serve({ stdin = process.stdin, stdout = process.stdout, defaultRoot, timeoutMs = DEFAULT_TIMEOUT_MS, workflow = {} } = {}) {
  const root = resolveRoot(defaultRoot ?? process.env.FLOW_ROOT ?? process.cwd(), process.cwd())
  const orchestrators = new Map()
  const options = { defaultRoot: root, timeoutMs, workflow, orchestrators }
  const input = readline.createInterface({ input: stdin, crlfDelay: Infinity })
  try {
    for await (const line of input) {
      const text = line.trim()
      if (text === '') continue
      let message
      try { message = JSON.parse(text) } catch { stdout.write(`${JSON.stringify(rpcError(null, -32700, 'parse error'))}\n`); continue }
      let response
      try { response = await handleMessage(message, options) } catch (error) { response = rpcError(message?.id, -32603, `internal error: ${error.message}`) }
      if (response !== null) stdout.write(`${JSON.stringify(response)}\n`)
    }
  } finally {
    for (const orchestrator of orchestrators.values()) {
      try { await orchestrator.stop() } catch { /* best effort */ }
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseServerArgs(argv) } catch (error) { process.stderr.write(`project-flow mcp: ${error.message}\n\n${USAGE}`); return 2 }
  if (options.help) { process.stdout.write(USAGE); return 0 }
  if (options.version) { process.stdout.write(`${SERVER_INFO.name} ${SERVER_INFO.version}\n`); return 0 }
  process.stdout.on('error', (error) => { if (error && error.code === 'EPIPE') process.exit(0) })
  try {
    await serve({ defaultRoot: options.root, timeoutMs: options.timeoutMs, workflow: options.workflow })
    return 0
  } catch (error) {
    process.stderr.write(`project-flow mcp: ${error.message}\n`)
    return 2
  }
}
