// project-flow — MCP workflow orchestrator.
//
// The DSH plugin dispatches role subagents through the host `subagents` service.
// A standalone MCP server has no such service, so the MCP workflow owns a local
// agent runner instead: reserve a queued task, spawn one runner process with a
// self-contained role prompt, and let the worker update the same ledger through
// the MCP write tools. The loop is deliberately ledger-driven: a runner crash
// cannot corrupt the queue, and the next tick can still reconcile parents.
//
// Default runner: `codex exec --json --ephemeral -C <root>
// --sandbox workspace-write --approve-for-me -`, with the prompt on stdin.
// Tests and users with another runtime can inject `runner.command` /
// `runner.args`; no shell interpolation is ever used.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  AGGREGATE_ROUND,
  dispatchPlan,
  dispatchPrompt,
  priorDispatch,
} from '../dispatch.mjs'

const DEFAULT_INTERVAL_MS = 1_500
const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_RUNNER_TIMEOUT_MS = 30 * 60 * 1000
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
const TERMINAL_STAGES = new Set(['done', 'archived', 'cancelled'])

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function errorText(error) {
  return error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error)
}

function clip(value, limit = 4_000) {
  const body = String(value ?? '')
  return body.length <= limit ? body : `${body.slice(0, limit - 1)}…`
}

function roleLabel(role) {
  if (role === 'analyzer') return '分析'
  if (role === 'implementer') return '实现'
  if (role === 'reviewer') return '审查'
  return role || '未知'
}

function defaultRunner(root) {
  return {
    command: process.env.PROJECT_FLOW_RUNNER_COMMAND || 'codex',
    args: [
      'exec',
      '--json',
      '--ephemeral',
      '-C', root,
      '--sandbox', 'workspace-write',
      '--approve-for-me',
      '-',
    ],
    timeoutMs: DEFAULT_RUNNER_TIMEOUT_MS,
  }
}

function normalizeRunner(input, root) {
  if (input !== null && typeof input === 'object' && typeof input.command === 'string' && input.command.trim() !== '') {
    return {
      command: input.command.trim(),
      args: Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : [],
      timeoutMs: Number.isInteger(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_RUNNER_TIMEOUT_MS,
    }
  }
  return defaultRunner(root)
}

function workerPrompt(task, root, plan) {
  const base = dispatchPrompt(task, { root })
  const aggregate = plan.round === AGGREGATE_ROUND
  return `${base}

## MCP 自动执行补充

- 你是由 project-flow MCP 自动派工的 headless worker。不要调用 flow_orchestrate。
- 通过 project-flow MCP 的 flow_task / flow_subtask / flow_gate / flow_desc / flow_decision 工具读写台账；不要手改 .agents 下的 JSON。
- 除本任务明确要求外，不要创建新的主任务或启动新的编排器。
- 工作完成且台账已推进后直接退出；最终消息只写结论、证据和遗留问题。
${aggregate ? '- 这是汇总轮：只核对子任务证据、写汇总，并把父任务推进到 done；不要新建子任务。' : ''}`
}

function parseJsonLines(stdout) {
  const events = []
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // Non-JSON output is still useful in diagnostics; keep the raw tail separately.
    }
  }
  return events
}

function spawnRunner(runner, prompt, { root, env }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(runner.command, runner.args, {
        cwd: root,
        env: {
          ...process.env,
          ...env,
          PROJECT_FLOW_WORKER: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, code: null, signal: null, stdout: '', stderr: errorText(error), pid: null, timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const append = (target, chunk) => {
      const next = target + chunk
      return next.length <= MAX_CAPTURE_BYTES ? next : next.slice(0, MAX_CAPTURE_BYTES)
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, 2_000).unref?.()
    }, runner.timeoutMs)
    timer.unref?.()

    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, signal: null, stdout, stderr: `${stderr}${errorText(error)}`, pid: child.pid ?? null, timedOut })
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && timedOut === false, code, signal, stdout, stderr, pid: child.pid ?? null, timedOut })
    })

    try {
      child.stdin.end(prompt)
    } catch (error) {
      stderr = `${stderr}\n${errorText(error)}`
    }
  })
}

/**
 * One in-process orchestrator per project root. The MCP server keeps these
 * across tool calls; `start` is asynchronous and `status` polls in-flight work.
 */
export class WorkflowOrchestrator {
  constructor({ root, core, contract, runner, intervalMs = DEFAULT_INTERVAL_MS, maxConcurrent = DEFAULT_MAX_CONCURRENT, logger = null }) {
    this.root = path.resolve(root)
    this.core = core
    this.contract = contract
    this.runner = normalizeRunner(runner, this.root)
    this.intervalMs = Number.isInteger(intervalMs) && intervalMs >= 250 ? intervalMs : DEFAULT_INTERVAL_MS
    this.maxConcurrent = Number.isInteger(maxConcurrent) && maxConcurrent >= 1 ? Math.min(maxConcurrent, 8) : DEFAULT_MAX_CONCURRENT
    this.logger = logger
    this.running = false
    this.timer = null
    this.lastTickAt = null
    this.startedAt = null
    this.inFlight = new Map()
    this.history = []
    this.lastError = null
  }

  async start(options = {}) {
    if (process.env.PROJECT_FLOW_WORKER === '1') {
      throw new Error('nested orchestration is disabled inside a workflow worker')
    }
    if (options.taskId !== undefined || options.title !== undefined) {
      await this.ensureTask(options)
    }
    this.running = true
    this.startedAt = this.startedAt || new Date().toISOString()
    if (this.timer === null) {
      this.timer = setInterval(() => {
        this.tick().catch((error) => {
          this.lastError = errorText(error)
          this.logger?.warn?.(`project-flow orchestrator tick failed: ${this.lastError}`)
        })
      }, this.intervalMs)
      this.timer.unref?.()
    }
    await this.tick()
    return this.status()
  }

  async ensureTask(options) {
    if (typeof options.taskId === 'string' && options.taskId.trim() !== '') {
      const task = await this.core.getTask(this.root, this.contract, options.taskId.trim())
      if (!task) throw new Error(`task not found: ${options.taskId}`)
      return task
    }
    const title = text(options.title).trim()
    const type = text(options.type).trim() || 'chore'
    if (title === '') throw new Error('flow_orchestrate start requires taskId or title')
    const input = { title, type, stage: 'queued-analysis' }
    if (text(options.notes).trim() !== '') input.notes = options.notes.trim()
    if (options.scope !== undefined) input.scope = options.scope
    if (options.acceptance !== undefined) input.acceptance = options.acceptance
    return this.core.addTask(this.root, this.contract, input)
  }

  status() {
    return {
      root: this.root,
      running: this.running,
      startedAt: this.startedAt,
      intervalMs: this.intervalMs,
      maxConcurrent: this.maxConcurrent,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      inFlight: [...this.inFlight.values()].map((entry) => ({
        taskId: entry.taskId,
        title: entry.title,
        role: entry.role,
        pid: entry.pid,
        startedAt: entry.startedAt,
      })),
      history: this.history.slice(-20),
      runner: { command: this.runner.command, args: this.runner.args },
    }
  }

  async stop() {
    this.running = false
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    return this.status()
  }

  /** One ledger scan. Safe to call manually; `start` calls it on a timer. */
  async tick() {
    this.lastTickAt = new Date().toISOString()
    const tasks = await this.core.listTasks(this.root, this.contract)
    await this.reconcileParents(tasks)

    const fresh = await this.core.listTasks(this.root, this.contract)
    const available = this.maxConcurrent - this.inFlight.size
    if (available <= 0) return this.status()

    const queued = fresh
      .filter((task) => task && typeof task.id === 'string' && TERMINAL_STAGES.has(task.stage) === false)
      .filter((task) => this.inFlight.has(task.id) === false)
      .filter((task) => dispatchPlan(task).ok === true)

    for (const task of queued.slice(0, available)) {
      try {
        await this.dispatchTask(task)
      } catch (error) {
        this.lastError = errorText(error)
        this.logger?.warn?.(`project-flow orchestrator dispatch ${task.id} failed: ${this.lastError}`)
      }
    }
    return this.status()
  }

  async dispatchTask(task) {
    const plan = dispatchPlan(task)
    if (plan.ok !== true) throw new Error(plan.reason)
    const from = plan.round === AGGREGATE_ROUND ? AGGREGATE_ROUND : task.stage
    if (priorDispatch(task, from) !== null && plan.round !== AGGREGATE_ROUND) return null

    const childId = `mcp-${randomUUID()}`
    const expectedRevision = this.core.taskRevisionOf(this.root, this.contract, task.id)
    const checkpoint = {
      kind: 'dispatch',
      role: plan.role,
      childId,
      provider: 'mcp-runner',
      from,
      to: plan.workingStage,
      at: new Date().toISOString(),
    }
    const checkpoints = Array.isArray(task.checkpoints) ? task.checkpoints.slice() : []
    // Reserve the task before spawning. A slow or failed runner must never leave
    // the task in a queued stage where the next tick would spawn a duplicate.
    const reserved = this.core.updateTask(
      this.root,
      this.contract,
      task.id,
      { stage: plan.workingStage, checkpoints: [...checkpoints, checkpoint] },
      { expectedRevision },
    )
    const prompt = workerPrompt(reserved, this.root, plan)
    const entry = {
      taskId: reserved.id,
      title: reserved.title,
      role: plan.role,
      childId,
      pid: null,
      startedAt: new Date().toISOString(),
    }
    this.inFlight.set(reserved.id, entry)

    spawnRunner(this.runner, prompt, { root: this.root, env: { PROJECT_FLOW_ROOT: this.root } })
      .then((result) => {
        const finishedAt = new Date().toISOString()
        const record = {
          taskId: reserved.id,
          title: reserved.title,
          role: plan.role,
          childId,
          startedAt: entry.startedAt,
          finishedAt,
          ok: result.ok,
          code: result.code,
          signal: result.signal,
          timedOut: result.timedOut,
          events: parseJsonLines(result.stdout).length,
          stdoutTail: clip(result.stdout, 2_000),
          stderrTail: clip(result.stderr, 2_000),
        }
        this.history.push(record)
        this.inFlight.delete(reserved.id)
        if (result.ok === false) {
          this.lastError = `runner ${childId} failed for ${reserved.id}: ${clip(result.stderr || result.stdout, 500)}`
          this.logger?.warn?.(`project-flow orchestrator ${this.lastError}`)
        }
        this.tick().catch((error) => {
          this.lastError = errorText(error)
        })
      })
      .catch((error) => {
        this.inFlight.delete(reserved.id)
        this.lastError = errorText(error)
      })

    return this.status()
  }

  /** Aggregate finished children back to their analyzer summary round. */
  async reconcileParents(tasks) {
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const childrenByParent = new Map()
    for (const task of tasks) {
      if (typeof task.parent !== 'string' || task.parent === '') continue
      if (!childrenByParent.has(task.parent)) childrenByParent.set(task.parent, [])
      childrenByParent.get(task.parent).push(task)
    }
    for (const [parentId, children] of childrenByParent.entries()) {
      if (children.length === 0) continue
      if (children.some((child) => TERMINAL_STAGES.has(child.stage) === false)) continue
      const parent = byId.get(parentId)
      if (!parent || (parent.stage !== 'analyzing' && parent.stage !== 'implementing')) continue
      if (parent.dispatchRound === AGGREGATE_ROUND) continue
      const notes = `${text(parent.notes)}${text(parent.notes).trim() === '' ? '' : '\n'}[auto] 子任务 ${children.length} 条全部完成，汇总并回报 lead`
      try {
        await this.core.updateTask(
          this.root,
          this.contract,
          parent.id,
          { stage: 'queued-analysis', notes, dispatchRound: AGGREGATE_ROUND },
          { source: 'internal' },
        )
      } catch (error) {
        this.logger?.warn?.(`project-flow orchestrator aggregate ${parent.id} failed: ${errorText(error)}`)
      }
    }
  }
}

export function createOrchestrator(options) {
  return new WorkflowOrchestrator(options)
}

export { defaultRunner, workerPrompt }
