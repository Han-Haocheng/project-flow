// T-13 A1 缺口补齐：CLI（task add|update --parent）与 flow_task 工具的 parent 三态。
// core 的字段/校验由 task-137 覆盖；这里只钉入口、退出码与消息。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import { initProject, loadContract } from '../lib/core.mjs'
// `flow_task` is mounted by its own module entry since the plugin split.
import { apply as applyTasks } from '../tasks.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
const ROOT = path.resolve(HERE, '..')
const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结论
    }
  }
})

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-parent-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  return root
}

function runCli(cwd, args) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env })
  let json = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = null
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

function taskFile(root, id) {
  return path.join(root, '.dsh/flow/tasks', `${id}.json`)
}

// ------------------------------------------------------------------ CLI

test('CLI task add --parent：合法父落盘，show/文件均可读', () => {
  const root = freshProject('add')
  const parent = runCli(root, ['task', 'add', '--type', 'feat', '--title', '父任务', '--json'])
  assert.equal(parent.code, 0, parent.stderr)
  const child = runCli(root, ['task', 'add', '--type', 'feat', '--title', '子任务', '--parent', parent.json.data.id, '--json'])
  assert.equal(child.code, 0, child.stderr)
  assert.equal(child.json.data.parent, parent.json.data.id)

  const shown = runCli(root, ['task', 'show', child.json.data.id, '--json'])
  assert.equal(shown.code, 0)
  assert.equal(shown.json.data.parent, parent.json.data.id)
  assert.equal(JSON.parse(fs.readFileSync(taskFile(root, child.json.data.id), 'utf8')).parent, parent.json.data.id)
})

test("CLI task --parent ''/none/null：清空为根（add 与 update，大小写不敏感）", () => {
  const root = freshProject('clear')
  const parent = runCli(root, ['task', 'add', '--type', 'feat', '--title', '父', '--json']).json.data.id
  const child = runCli(root, ['task', 'add', '--type', 'feat', '--title', '子', '--parent', parent, '--json']).json.data.id
  for (const value of ['', 'none', 'null', 'NULL', 'NONE']) {
    const cleared = runCli(root, ['task', 'update', child, '--parent', value, '--json'])
    assert.equal(cleared.code, 0, `${value}: ${cleared.stderr}`)
    assert.equal(cleared.json.data.parent, null, `--parent ${JSON.stringify(value)} 应清空`)
    // 重新挂上，供下一种写法使用。
    assert.equal(runCli(root, ['task', 'update', child, '--parent', parent, '--json']).json.data.parent, parent)
  }
  for (const value of ['', 'none', 'NULL', 'NONE']) {
    const emptyAdd = runCli(root, ['task', 'add', '--type', 'feat', '--title', `根-${value || 'empty'}`, '--parent', value, '--json'])
    assert.equal(emptyAdd.code, 0, `${value}: ${emptyAdd.stderr}`)
    assert.equal(emptyAdd.json.data.parent, null, `task add --parent ${JSON.stringify(value)} 应为根`)
  }
})

test('CLI task update（不带 --parent）：父关系保持，不被清空', () => {
  const root = freshProject('keep')
  const parent = runCli(root, ['task', 'add', '--type', 'feat', '--title', '父', '--json']).json.data.id
  const child = runCli(root, ['task', 'add', '--type', 'feat', '--title', '子', '--parent', parent, '--json']).json.data.id

  const statusOnly = runCli(root, ['task', 'update', child, '--status', 'active', '--json'])
  assert.equal(statusOnly.code, 0, statusOnly.stderr)
  assert.equal(statusOnly.json.data.parent, parent, '只改 status 不得清空 parent')
  const goalOnly = runCli(root, ['task', 'update', child, '--goal', '新目标', '--json'])
  assert.equal(goalOnly.code, 0, goalOnly.stderr)
  assert.equal(goalOnly.json.data.parent, parent, '只改 goal 不得清空 parent')
  assert.equal(runCli(root, ['task', 'show', child, '--json']).json.data.parent, parent)
})

test('CLI task --parent：不存在 → 2 parent-not-found；自指 → 2；环 → 2 parent-cycle', () => {
  const root = freshProject('errors')
  const missing = runCli(root, ['task', 'add', '--type', 'feat', '--title', '孤儿', '--parent', 'T-20000101-01', '--json'])
  assert.equal(missing.code, 2)
  assert.equal(missing.json.error.code, 'invalid')
  assert.match(missing.json.error.message, /parent-not-found/)

  const a = runCli(root, ['task', 'add', '--type', 'feat', '--title', 'A', '--json']).json.data.id
  const self = runCli(root, ['task', 'update', a, '--parent', a, '--json'])
  assert.equal(self.code, 2)
  assert.equal(self.json.error.code, 'invalid')
  assert.match(self.json.error.message, /cannot reference itself/)

  const b = runCli(root, ['task', 'add', '--type', 'feat', '--title', 'B', '--parent', a, '--json'])
  assert.equal(b.code, 0)
  const cycle = runCli(root, ['task', 'update', a, '--parent', b.json.data.id, '--json'])
  assert.equal(cycle.code, 2)
  assert.equal(cycle.json.error.code, 'invalid')
  assert.match(cycle.json.error.message, /parent-cycle/)
  assert.equal(runCli(root, ['task', 'show', a, '--json']).json.data.parent, null, '失败的 update 不写坏 A')
})

test('CLI usage：task add/update 列出 --parent 且说明父存在/禁自指/禁环', () => {
  const help = runCli(ROOT, ['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /task add --title T[\s\S]*?--parent T-id/)
  assert.match(help.stdout, /task update <id>[\s\S]*?--parent T-id/)
  assert.match(help.stdout, /父任务须存在、禁自指\/禁环/)
})

// ------------------------------------------------------------- flow_task tool

let pluginPromise = null
function plugin() {
  if (pluginPromise === null) pluginPromise = import('../index.js')
  return pluginPromise
}

async function toolHarness(root) {
  const mod = await plugin()
  const tools = new Map()
  const services = new Map([
    ['webServer', { getOrigin: () => 'http://127.0.0.1:3080', register: () => () => {} }],
    ['workspaceRegistry', { list: () => [] }],
    ['workingDirectory', { get: () => root }],
    ['tools', {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      guard: () => () => {},
    }],
  ])
  const ctx = {
    get: (name) => services.get(name),
    effect: (callback) => {
      callback()
      return () => {}
    },
    logger: { warn() {} },
  }
  mod.apply(ctx, {})
  applyTasks(ctx, {})
  const exec = { agent: { session: { cwd: root } } }
  return { tool: tools.get('flow_task'), exec }
}

test('flow_task 工具 parent 三态：add 生效 / update 清空 / 缺失与环 invalid', async () => {
  const root = freshProject('tool')
  const { tool, exec } = await toolHarness(root)
  const parent = await tool.execute({ action: 'add', type: 'feat', title: '工具父' }, exec)
  const child = await tool.execute({ action: 'add', type: 'feat', title: '工具子', parent: parent.task.id }, exec)
  assert.equal(child.task.parent, parent.task.id, 'add 带 parent 生效')

  const cleared = await tool.execute({ action: 'update', id: child.task.id, parent: '' }, exec)
  assert.equal(cleared.task.parent, null, 'update parent:"" 清空')
  const reattached = await tool.execute({ action: 'update', id: child.task.id, parent: parent.task.id }, exec)
  assert.equal(reattached.task.parent, parent.task.id)

  await assert.rejects(
    () => tool.execute({ action: 'add', type: 'feat', title: '孤儿', parent: 'T-20000101-01' }, exec),
    (error) => error.code === 'invalid' && /parent-not-found/.test(error.message),
  )
  await assert.rejects(
    () => tool.execute({ action: 'update', id: parent.task.id, parent: child.task.id }, exec),
    (error) => error.code === 'invalid' && /parent-cycle/.test(error.message),
  )
  const after = await tool.execute({ action: 'show', id: parent.task.id }, exec)
  assert.equal(after.task.parent, null)
})


test('flow_task parent 归一：add/update 的 none/null/NONE/NULL 都清空为根', async () => {
  const root = freshProject('tool-normalize')
  const { tool, exec } = await toolHarness(root)

  // add：四种写法都应是根（core 本身只认 null/''，归一在这里发生）。
  for (const value of ['none', 'null', 'NONE', 'NULL']) {
    const created = await tool.execute({ action: 'add', type: 'feat', title: `根-${value}`, parent: value }, exec)
    assert.equal(created.task.parent, null, `add parent=${value} 应为根`)
  }

  // update：挂上父之后用四种写法清空，逐一验证并复原。
  const parent = await tool.execute({ action: 'add', type: 'feat', title: '工具父' }, exec)
  const child = await tool.execute({ action: 'add', type: 'feat', title: '工具子', parent: parent.task.id }, exec)
  assert.equal(child.task.parent, parent.task.id)
  for (const value of ['none', 'null', 'NONE', 'NULL']) {
    const cleared = await tool.execute({ action: 'update', id: child.task.id, parent: value }, exec)
    assert.equal(cleared.task.parent, null, `update parent=${value} 应为根`)
    const attached = await tool.execute({ action: 'update', id: child.task.id, parent: parent.task.id }, exec)
    assert.equal(attached.task.parent, parent.task.id)
  }
})

test('flow_task update（不带 parent）：父关系保持，不被清空', async () => {
  const root = freshProject('tool-keep')
  const { tool, exec } = await toolHarness(root)
  const parent = await tool.execute({ action: 'add', type: 'feat', title: '父' }, exec)
  const child = await tool.execute({ action: 'add', type: 'feat', title: '子', parent: parent.task.id }, exec)
  assert.equal(child.task.parent, parent.task.id)

  const updated = await tool.execute({ action: 'update', id: child.task.id, goal: '只改目标' }, exec)
  assert.equal(updated.task.parent, parent.task.id, '工具 update 不带 parent 不得清空')
  const shown = await tool.execute({ action: 'show', id: child.task.id }, exec)
  assert.equal(shown.task.parent, parent.task.id)
})
