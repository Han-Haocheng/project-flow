// T-15（task-187）：任务必填字段 `type`（conventional 10 值）。
//
// 只使用 os.tmpdir() 下的一次性项目；覆盖 core 校验/读投影、CLI 退出码矩阵、
// flow_task 工具 schema 与 SPEC↔handler 一致性。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FlowError,
  TASK_TYPES,
  addTask as addTaskCore,
  getTask,
  initProject,
  listTasks,
  loadContract,
  updateTask,
} from '../lib/core.mjs'
import { apply } from '../index.js'
// `flow_task` is mounted by its own module entry since the plugin split.
import { apply as applyTasks } from '../tasks.js'
import { TASK_ADD_FIELDS, TASK_UPDATE_FIELDS } from '../lib/plugin/shared.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
const BIN_SOURCE = fs.readFileSync(BIN, 'utf8')
const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-type-${label}-`))
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

function expectInvalid(fn, pattern) {
  assert.throws(
    fn,
    (error) => error instanceof FlowError && error.code === 'invalid' && pattern.test(error.message),
  )
}

function pluginCtx({ root, logger }) {
  const registeredTools = new Map()
  const routes = []
  const services = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
      getOrigin() {
        return 'http://127.0.0.1:4021'
      },
    },
    tools: {
      register(definition) {
        registeredTools.set(definition.name, definition)
        return () => registeredTools.delete(definition.name)
      },
    },
    skills: { register() { return () => {} } },
    workingDirectory: { get() { return root } },
    workspaceRegistry: { list() { return [{ path: root, title: path.basename(root) }] } },
  }
  const ctx = {
    get(name) { return services[name] },
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    on() { return () => {} },
    logger: logger ?? { warn() {} },
  }
  return { ctx, registeredTools }
}

test('type：add 缺 type / 空串 / 非法值 / 旧 revert 都 invalid', () => {
  const { contract } = loadContract(freshProject('missing'))
  expectInvalid(() => addTaskCore(freshProject('missing2'), contract, { title: '缺 type' }), /type is required/)
  expectInvalid(() => addTaskCore(freshProject('empty'), contract, { type: '', title: '空' }), /type is required/)
  expectInvalid(() => addTaskCore(freshProject('bogus'), contract, { type: 'bogus', title: '坏' }), /type must be one of/)
  expectInvalid(() => addTaskCore(freshProject('revert'), contract, { type: 'revert', title: '旧枚举' }), /type must be one of/)
})

test('type：10 个合法值逐一可建，且读回一致', () => {
  const root = freshProject('valid')
  const { contract } = loadContract(root)
  assert.deepEqual(TASK_TYPES, ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci'])
  for (const type of TASK_TYPES) {
    const task = addTaskCore(root, contract, { type, title: `${type} 任务` })
    assert.equal(task.type, type)
    assert.equal(getTask(root, contract, task.id).type, type)
  }
  assert.equal(listTasks(root, contract).length, TASK_TYPES.length)
})

test('type：update 一律拒绝（④ 不可改），非法值也让位同一条不可改文案', () => {
  const root = freshProject('update')
  const { contract } = loadContract(root)
  const task = addTaskCore(root, contract, { type: 'feat', title: '改类型' })
  // ④：type 参与统计，改了历史就漂移；core 单点拦截，文案与 id/schema/created_at 同句式。
  expectInvalid(() => updateTask(root, contract, task.id, { type: 'fix' }), /task type cannot be changed/)
  expectInvalid(() => updateTask(root, contract, task.id, { type: 'bogus' }), /task type cannot be changed/)
  assert.equal(updateTask(root, contract, task.id, { status: 'active' }).type, 'feat', '未给 type 保留原值')
})

test('type：旧记录（无 type）读投影为 null、不迁移；update 其它字段不补写 type', () => {
  const root = freshProject('legacy')
  const { contract } = loadContract(root)
  const legacy = {
    schema: 1,
    id: 'T-20261105-01',
    title: '旧任务',
    status: 'draft',
    owner: '',
    goal: '',
    parent: null,
    scope: { allow: [], deny: [] },
    acceptance: [],
    checkpoints: [],
    commits: [],
    notes: '',
    created_at: '2026-11-05T10:00:00+08:00',
    updated_at: '2026-11-05T10:00:00+08:00',
  }
  const file = path.join(root, '.dsh/flow/tasks', 'T-20261105-01.json')
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2) + '\n')

  assert.equal(getTask(root, contract, legacy.id).type, null)
  assert.equal(listTasks(root, contract)[0].type, null)

  const updated = updateTask(root, contract, legacy.id, { status: 'active' })
  assert.equal(updated.type, null)
  assert.equal(Object.hasOwn(updated, 'type'), true, '读投影有 type:null')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(Object.hasOwn(onDisk, 'type'), false, '写路径不迁移、不补写 type')
  assert.equal(onDisk.status, 'active')
})

test('type：CLI 退出码矩阵（缺 type / 非法 / 合法 / update）', () => {
  const root = freshProject('cli')
  const missing = runCli(root, ['task', 'add', '--title', '缺 type', '--json'])
  assert.equal(missing.code, 2, missing.stdout + missing.stderr)
  assert.equal(missing.json?.error?.code, 'invalid')
  assert.match(missing.json?.error?.message ?? '', /type is required/)

  const bogus = runCli(root, ['task', 'add', '--title', '坏类型', '--type', 'bogus', '--json'])
  assert.equal(bogus.code, 2)
  assert.match(bogus.json?.error?.message ?? '', /type must be one of feat, fix, docs/)

  const ok = runCli(root, ['task', 'add', '--title', '合法', '--type', 'feat', '--json'])
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(ok.json?.data?.type, 'feat')

  // ④：--type 仍声明（走 core 的统一文案），但 update 一律 exit 2 invalid。
  const updated = runCli(root, ['task', 'update', ok.json.data.id, '--type', 'fix', '--json'])
  assert.equal(updated.code, 2, updated.stdout + updated.stderr)
  assert.equal(updated.json?.error?.code, 'invalid')
  assert.equal(updated.json?.error?.message, 'task type cannot be changed')

  const badUpdate = runCli(root, ['task', 'update', ok.json.data.id, '--type', 'nope', '--json'])
  assert.equal(badUpdate.code, 2)
  assert.equal(badUpdate.json?.error?.code, 'invalid')
  assert.equal(badUpdate.json?.error?.message, 'task type cannot be changed', '不可改拦截先于枚举校验')

  const help = runCli(root, ['task', 'add', '--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /--type/)
  assert.match(help.stdout, /feat\|fix\|docs\|style\|refactor\|perf\|test\|chore\|build\|ci/)
  assert.equal(/revert/.test(help.stdout), false)
})

test('type：flow_task schema enum/必填 + SPEC↔handler 白名单含 type', async () => {
  const root = freshProject('tool')
  const { ctx, registeredTools } = pluginCtx({ root })
  apply(ctx)
  applyTasks(ctx)
  const taskTool = registeredTools.get('flow_task')
  assert.ok(taskTool, 'flow_task 应注册（由 tasks.js 模块入口注册）')
  const typeSchema = taskTool.parameters.properties.type
  assert.equal(typeSchema.type, 'string')
  assert.deepEqual(typeSchema.enum, ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci'])
  assert.match(taskTool.description, /type.*required on add.*feat\/fix/i)

  const exec = { agent: { session: { cwd: root } } }
  await assert.rejects(
    taskTool.execute({ action: 'add', title: '工具缺 type' }, exec),
    (error) => error instanceof FlowError && error.code === 'invalid' && /type is required/.test(error.message),
  )
  const created = await taskTool.execute({ action: 'add', type: 'feat', title: '工具建' }, exec)
  assert.equal(created.task.type, 'feat')
  await assert.rejects(
    taskTool.execute({ action: 'update', id: created.task.id, type: 'chore' }, exec),
    (error) => error instanceof FlowError && error.code === 'invalid' && error.message === 'task type cannot be changed',
    '工具侧与 core 同一句文案（白名单放行 type，由 core 拦）',
  )

  // SPEC 与 handler 同步：task add/update 都声明了 type，help/用法列出 10 值。
  assert.match(BIN_SOURCE, /add: \{ flags: \['id', 'title', 'type'/)
  assert.match(BIN_SOURCE, /update: \{ flags: \['id', 'title', 'type'/)
  assert.match(BIN_SOURCE, /feat\|fix\|docs\|style\|refactor\|perf\|test\|chore\|build\|ci/)

  // A11：`goal` 已从工具 schema/白名单里删除（②），只在"已合并"说明里出现。
  assert.equal(taskTool.parameters.properties.goal, undefined, 'flow_task 不再暴露 goal 参数')
  assert.equal(taskTool.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(taskTool.parameters.properties).includes('goal'), false)
  assert.match(taskTool.description, /`goal` was merged into `title`/)
  assert.deepEqual(TASK_ADD_FIELDS.includes('goal'), false)
  assert.deepEqual(TASK_UPDATE_FIELDS.includes('goal'), false)
  // ④：title/type 仍透传给 core（白名单不另造第二种错误形态）。
  assert.equal(TASK_UPDATE_FIELDS.includes('title'), true)
  assert.equal(TASK_UPDATE_FIELDS.includes('type'), true)
  assert.match(BIN_SOURCE, /update: \{ flags: \['id', 'title', 'type', 'status', 'owner', 'notes'/)
})
