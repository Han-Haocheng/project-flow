// project-flow MCP 服务回归：协议形状、完整任务工作流、CLI 映射与自动编排。
//
// 覆盖四类风险：
//   1) 协议：initialize / tools/list / tools/call 的 JSON-RPC 形状与通知静默；
//   2) 工具面：任务/子任务写路径走 core，实验/门禁/决策等走封闭 CLI 映射；
//   3) 数据：list 精简、show 完整、坏 id 走 isError；
//   4) 编排：queued 任务被 runner 领取并推进到 working 阶段。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { addTask, initProject, loadContract } from '../lib/core.mjs'
import {
  TOOL_SPECS,
  cliArgsFor,
  handleMessage,
  mcpToolList,
  parseServerArgs,
  resolveRoot,
} from '../lib/cli/mcp-server.mjs'
import { createOrchestrator } from '../lib/mcp/orchestrator.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'mcp.mjs')
const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-mcp-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  return root
}

function options(root) {
  return { defaultRoot: root, timeoutMs: 30_000, workflow: {}, orchestrators: new Map() }
}

function textOf(response) {
  return response.result.content.map((block) => block.text).join('\n')
}

function dataOf(response) {
  return JSON.parse(textOf(response))
}

async function call(root, name, args, opts = options(root)) {
  return handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    opts,
  )
}

// ------------------------------------------------------------------ 协议面
test('MCP tools/list：覆盖完整工作流，且 schema 关闭额外属性', () => {
  const tools = mcpToolList()
  assert.deepEqual(tools.map((tool) => tool.name), [
    'flow_status', 'flow_task', 'flow_subtask', 'flow_exp', 'flow_gate', 'flow_decision',
    'flow_heartbeat', 'flow_desc', 'flow_check', 'flow_doctor', 'flow_backup', 'flow_init',
    'flow_orchestrate',
  ])
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.ok(tool.inputSchema.properties.root)
  }
  const names = new Set(TOOL_SPECS.map((spec) => spec.name))
  assert.equal(names.size, TOOL_SPECS.length, '工具名必须唯一')
})

test('MCP 协议：initialize / ping / tools/list / 通知 / 未知方法', async () => {
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(init.id, 1)
  assert.equal(typeof init.result.protocolVersion, 'string')
  assert.equal(init.result.serverInfo.name, 'project-flow')
  assert.equal(init.result.capabilities.tools.listChanged, false)

  const echo = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.equal(echo.result.protocolVersion, '2025-06-18')

  assert.deepEqual(await handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }), { jsonrpc: '2.0', id: 3, result: {} })
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  const missing = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' })
  assert.equal(missing.error.code, -32601)
  const bad = await handleMessage({ jsonrpc: '1.0', id: 5, method: 'ping' })
  assert.equal(bad.error.code, -32600)
})

// ------------------------------------------------------------ CLI 映射
test('MCP CLI 映射：动作与重复参数变成固定的 CLI argv', () => {
  assert.deepEqual(cliArgsFor('flow_status', {}), ['status'])
  assert.deepEqual(cliArgsFor('flow_task', { action: 'next', id: ' T-1 ' }), ['task', 'next', 'T-1'])
  assert.deepEqual(cliArgsFor('flow_exp', {
    action: 'add', title: 'x', primaryMetric: 'm', windowDays: 7, guardrails: ['a', 'b'],
  }), ['exp', 'add', '--title', 'x', '--primary-metric', 'm', '--window-days', '7', '--guardrail', 'a', '--guardrail', 'b'])
  assert.deepEqual(cliArgsFor('flow_gate', { action: 'logs', id: 'precommit' }), ['gate', 'logs', 'precommit', '--limit', '10'])
  assert.deepEqual(cliArgsFor('flow_gate', { action: 'run', phase: 'commit', timeout: 5 }), ['gate', 'run', '--phase', 'commit', '--timeout', '5'])
  assert.deepEqual(cliArgsFor('flow_decision', { action: 'list', open: true }), ['decision', 'list', '--open'])
})

test('MCP 参数边界：未知字段/缺 id/非法 action 在进入写路径前失败', async () => {
  const root = freshProject('args')
  for (const [name, args, pattern] of [
    ['flow_task', { action: 'show' }, /requires a non-empty id/],
    ['flow_gate', { action: 'run' }, /requires a non-empty id/],
    ['flow_status', { command: 'init' }, /does not accept argument/],
    ['nope', {}, /unknown tool/],
    ['flow_exp', { action: 'launch' }, /must be one of/],
  ]) {
    const response = await call(root, name, args)
    assert.equal(response.result.isError, true)
    assert.match(textOf(response), pattern)
  }
})

test('MCP 根目录：缺失/非目录拒绝，存在目录归一为绝对路径', () => {
  const root = freshProject('root')
  assert.equal(resolveRoot(root, process.cwd()), root)
  assert.equal(resolveRoot(undefined, root), root)
  assert.throws(() => resolveRoot(path.join(root, 'missing'), root), /does not exist/)
  assert.throws(() => resolveRoot(BIN, root), /not a directory/)
})

// ------------------------------------------------------------ 完整任务工作流
test('MCP 任务工作流：add/update/subtask/list/show 都写同一份 core 台账', async () => {
  const root = freshProject('workflow')
  const added = await call(root, 'flow_task', {
    action: 'add', title: 'MCP 工作流', type: 'feat', stage: 'queued-analysis',
    scope: { allow: ['lib/'] }, acceptance: ['cmd:true'],
  })
  assert.equal(added.result.isError, false)
  const task = dataOf(added)
  assert.equal(task.stage, 'queued-analysis')
  assert.match(task.revision, /^[0-9a-f]{16}$/)

  const updated = await call(root, 'flow_task', { action: 'update', id: task.id, stage: 'analyzing' })
  assert.equal(dataOf(updated).stage, 'analyzing')

  const child = await call(root, 'flow_subtask', {
    action: 'add', parent: task.id, title: '实现子项', type: 'feat', acceptance: ['cmd:true'],
  })
  assert.equal(child.result.isError, false)
  assert.equal(dataOf(child).stage, 'queued-implementation')

  const children = await call(root, 'flow_subtask', { action: 'list', parent: task.id })
  assert.equal(dataOf(children).length, 1)

  const list = await call(root, 'flow_task', { action: 'list' })
  const rows = dataOf(list)
  assert.equal(rows.length, 2)
  assert.equal(Object.hasOwn(rows[0], 'notes'), false, 'list 必须精简')
  assert.equal(Object.hasOwn(rows[0], 'acceptance'), false, 'list 必须精简')

  const shown = await call(root, 'flow_task', { action: 'show', id: task.id })
  assert.equal(dataOf(shown).title, 'MCP 工作流')
})

test('MCP 未初始化目录：status 报告 initialized=false，不冒充其他项目', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mcp-empty-'))
  TEMP_ROOTS.push(root)
  const response = await call(root, 'flow_status', {})
  assert.equal(response.result.isError, false)
  assert.equal(dataOf(response).initialized, false)
})

// ------------------------------------------------------------ 自动编排
test('MCP 编排：queued 任务被 runner 领取并推进到 working 阶段', async () => {
  const root = freshProject('orchestrate')
  const { contract } = loadContract(root)
  const task = addTask(root, contract, { title: '自动编排', type: 'feat', stage: 'queued-analysis' })
  const orchestrator = createOrchestrator({
    root,
    core: await import('../lib/core.mjs'),
    contract,
    runner: {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'],
      timeoutMs: 5_000,
    },
    intervalMs: 10_000,
    maxConcurrent: 1,
  })
  const started = await orchestrator.start({ taskId: task.id })
  assert.equal(started.running, true)
  assert.equal(started.inFlight.length, 1)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const status = orchestrator.status()
  assert.equal(status.history.length, 1)
  assert.equal(status.history[0].taskId, task.id)
  assert.equal(status.history[0].role, 'analyzer')
  assert.equal((await import('../lib/core.mjs')).getTask(root, contract, task.id).stage, 'analyzing')
  await orchestrator.stop()
})

// ------------------------------------------------------------ 进程入口
test('MCP 入口：bin/mcp.mjs 可收发并随 stdin 关闭退出', async () => {
  const root = freshProject('entry')
  const child = spawn(process.execPath, [BIN, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flow_status', arguments: {} } })}\n`)
  child.stdin.end()
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  assert.equal(code, 0, stderr)
  const lines = stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].result.serverInfo.name, 'project-flow')
  assert.equal(JSON.parse(lines[1].result.content[0].text).initialized, true)
})

test('MCP 启动参数：--root/--timeout/--runner-arg 解析，坏参数报用法', () => {
  const parsed = parseServerArgs(['--root', '/tmp', '--timeout', '5', '--runner-arg', '--json'])
  assert.equal(parsed.root, '/tmp')
  assert.equal(parsed.timeoutMs, 5000)
  assert.deepEqual(parsed.workflow.runnerArgs, ['--json'])
  assert.throws(() => parseServerArgs(['--timeout', '0']), /positive/)
  assert.throws(() => parseServerArgs(['--bogus']), /unknown argument/)
  assert.throws(() => parseServerArgs(['--root']), /requires a value/)
})

test('MCP 帮助/版本：进程直接退出 0', () => {
  for (const flag of ['--help', '--version']) {
    const result = spawnSync(process.execPath, [BIN, flag], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.trim().length > 0)
  }
})
