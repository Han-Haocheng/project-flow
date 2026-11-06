// ② 合并 `title` 与 `goal`（T-20261105225848）：goal 不再是任务字段。
//
// 口径（brief §2.3）：`goal` 从写路径（defaults/校验/白名单/schema/CLI）与读投影里删除；
// 旧记录磁盘上的 `goal` 键**原样保留**，由格式门禁走 `normalizeTaskFormat()` 迁移。
//
// 覆盖验收：A1（新记录不写 goal）/ A2（goal 不是 add 入参：core+工具+CLI）/
// A3（旧记录残留原样、读路径不拼）/ A6（update 不能复活 goal）/
// A8（CLI 与工具的不可改文案一字不差）/ A9+A10（迁移函数只读/合并/补 type/幂等）/
// A12（CONTRACT 文本同步）。A4/A5/A7 见 test/core.test.mjs，A11 见 task-type 测试。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FlowError,
  addTask,
  getTask,
  initProject,
  listTasks,
  loadContract,
  normalizeTaskFormat,
  updateTask,
} from '../lib/core.mjs'
import { apply } from '../index.js'
// `flow_task` is mounted by its own module entry since the plugin split.
import { apply as applyTasks } from '../tasks.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const BIN = path.join(REPO_ROOT, 'bin', 'flow.mjs')
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-goal-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  const { contract } = loadContract(root)
  return { root, contract }
}

function tasksDir(root) {
  return path.join(root, '.dsh', 'flow', 'tasks')
}

function taskFile(root, id) {
  return path.join(tasksDir(root), `${id}.json`)
}

function readTaskFile(root, id) {
  return JSON.parse(fs.readFileSync(taskFile(root, id), 'utf8'))
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

function expectFlowError(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FlowError, `expected FlowError, got ${error?.name}: ${error?.message}`)
    assert.equal(error.code, code)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

/** Legacy record: written straight to disk (pre-② shape: has `goal`, may lack `type`). */
function writeLegacy(root, id, overrides = {}) {
  const record = {
    schema: 1,
    id,
    title: '旧标题',
    status: 'draft',
    owner: '',
    // pre-② shape: every record written before the merge carried `goal: ""`.
    goal: '',
    parent: null,
    scope: { allow: [], deny: [] },
    acceptance: [],
    checkpoints: [],
    commits: [],
    notes: '',
    created_at: '2026-01-01T09:00:00+08:00',
    updated_at: '2026-01-02T09:00:00+08:00',
    ...overrides,
  }
  fs.writeFileSync(taskFile(root, id), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

function pluginCtx({ root }) {
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
    logger: { warn() {} },
  }
  return { ctx, registeredTools }
}

/** byte+size+mtime snapshot of the task store — proves a read path wrote nothing. */
function snapshotStore(root) {
  const dir = tasksDir(root)
  const out = {}
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name)
    const stat = fs.statSync(file)
    out[name] = `${stat.size}:${stat.mtimeMs}:${fs.readFileSync(file, 'utf8')}`
  }
  return out
}

// --------------------------------------------------------------------- A1

test('A1：新记录不写 goal 键（磁盘、返回值、读投影一致）', () => {
  const { root, contract } = freshProject('a1')
  const created = addTask(root, contract, { type: 'feat', title: '新任务' })
  assert.equal(Object.hasOwn(created, 'goal'), false, 'addTask 返回对象不得有 goal')
  const onDisk = readTaskFile(root, created.id)
  assert.equal(Object.hasOwn(onDisk, 'goal'), false, '落盘 JSON 不得有 goal 键')
  assert.equal(getTask(root, contract, created.id).goal, undefined, '读投影不得凭空造 goal')
  assert.equal(listTasks(root, contract)[0].goal, undefined)
})

// --------------------------------------------------------------------- A2

test('A2：goal 不是 add 入参 —— core 层 invalid，且失败不落盘', () => {
  const { root, contract } = freshProject('a2-core')
  expectInvalid(() => addTask(root, contract, { type: 'feat', title: 't', goal: 'x' }), /goal/)
  assert.deepEqual(fs.readdirSync(tasksDir(root)), [], 'invalid 的 add 不得写记录')
  // 白名单外的自造键同样拒绝（不静默吞掉）。
  expectInvalid(() => addTask(root, contract, { type: 'feat', title: 't', bogus: 1 }), /not a supported field/)
})

test('A2：goal 不是 add 入参 —— flow_task 工具侧 assertOnlyFields 拒绝', async () => {
  const { root } = freshProject('a2-tool')
  const { ctx, registeredTools } = pluginCtx({ root })
  apply(ctx)
  applyTasks(ctx)
  const taskTool = registeredTools.get('flow_task')
  assert.ok(taskTool, 'flow_task 应注册')
  const exec = { agent: { session: { cwd: root } } }
  await assert.rejects(
    taskTool.execute({ action: 'add', type: 'feat', title: 't', goal: 'x' }, exec),
    (error) => error?.message === 'invalid: flow_task add does not accept "goal"',
    '工具侧由白名单拒绝，文案点名 goal',
  )
  assert.deepEqual(fs.readdirSync(tasksDir(root)), [], '被拒的 add 不得写记录')
  // 不带 goal 的同名调用仍然成功（证明拒绝的是参数，不是 add 本身）。
  const created = await taskTool.execute({ action: 'add', type: 'feat', title: 't' }, exec)
  assert.equal(created.task.goal, undefined)
})

test('A2：goal 不是 add 入参 —— CLI 是未声明参数（exit 1 usage），早于任何读写', () => {
  const { root } = freshProject('a2-cli')
  const manifest = path.join(root, '.dsh', 'flow', 'flow.json')
  const before = fs.readFileSync(manifest, 'utf8')
  const result = runCli(root, ['task', 'add', '--type', 'feat', '--title', 't', '--goal', 'x', '--json'])
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.equal(result.json?.error?.code, 'usage')
  assert.match(result.json?.error?.message ?? '', /flow task add 不支持 --goal/)
  assert.equal(fs.readFileSync(manifest, 'utf8'), before, 'usage 失败不得改写 manifest')
  assert.deepEqual(fs.readdirSync(tasksDir(root)), [], 'usage 失败不得写记录')
})

// --------------------------------------------------------------------- A3

test('A3：旧记录 goal 原样保留、读路径不拼进 title、不补写 type', () => {
  const { root, contract } = freshProject('a3')
  writeLegacy(root, 'T-20260101-01', { title: '旧标题', goal: '旧目标' })

  const read = getTask(root, contract, 'T-20260101-01')
  assert.equal(read.title, '旧标题', '读路径不拼 goal')
  assert.equal(read.goal, '旧目标', '残留 goal 原样可读（门禁素材）')
  assert.equal(Object.hasOwn(read, 'goal'), true)
  assert.equal(read.type, null, '缺 type 的读投影为 null')
  const listed = listTasks(root, contract).find((record) => record.id === 'T-20260101-01')
  assert.equal(listed.title, '旧标题')
  assert.equal(listed.goal, '旧目标')

  // update 其它字段：不删、不搬、不补。
  updateTask(root, contract, 'T-20260101-01', { notes: '只改备注' })
  const onDisk = readTaskFile(root, 'T-20260101-01')
  assert.equal(onDisk.goal, '旧目标', 'goal 字节原样保留')
  assert.equal(onDisk.title, '旧标题', 'title 不被 goal 污染')
  assert.equal(onDisk.notes, '只改备注')
  assert.equal(Object.hasOwn(onDisk, 'type'), false, '写路径不迁移、不补写 type')
})

// --------------------------------------------------------------------- A6

test('A6：goal 不能经 update 复活（invalid，磁盘字节不变）', () => {
  const { root, contract } = freshProject('a6')
  writeLegacy(root, 'T-20260101-01', { title: '旧标题', goal: '旧目标' })
  const before = fs.readFileSync(taskFile(root, 'T-20260101-01'), 'utf8')
  expectFlowError(() => updateTask(root, contract, 'T-20260101-01', { goal: '再写回来' }), 'invalid', /goal/)
  assert.equal(fs.readFileSync(taskFile(root, 'T-20260101-01'), 'utf8'), before, '被拒的 patch 不写盘')
  // 白名单之外的自造键同样是同一条文案。
  expectFlowError(() => updateTask(root, contract, 'T-20260101-01', { whatever: 1 }), 'invalid', /task whatever cannot be changed/)
})

// --------------------------------------------------------------------- A8

test('A8：CLI 与工具对 title/type 的不可改文案一字不差', async () => {
  const { root } = freshProject('a8')
  const { contract } = loadContract(root)
  const created = addTask(root, contract, { type: 'feat', title: '原标题' })

  const cliTitle = runCli(root, ['task', 'update', created.id, '--title', '丙', '--json'])
  assert.equal(cliTitle.code, 2, cliTitle.stdout + cliTitle.stderr)
  assert.equal(cliTitle.json?.error?.code, 'invalid')
  assert.equal(cliTitle.json?.error?.message, 'task title cannot be changed')
  const cliType = runCli(root, ['task', 'update', created.id, '--type', 'fix', '--json'])
  assert.equal(cliType.code, 2)
  assert.equal(cliType.json?.error?.message, 'task type cannot be changed')

  const { ctx, registeredTools } = pluginCtx({ root })
  apply(ctx)
  applyTasks(ctx)
  const taskTool = registeredTools.get('flow_task')
  const exec = { agent: { session: { cwd: root } } }
  await assert.rejects(
    taskTool.execute({ action: 'update', id: created.id, title: '丙' }, exec),
    (error) => error instanceof FlowError && error.code === 'invalid' && error.message === cliTitle.json.error.message,
    '工具与 CLI 同一句文案（core 单点拦截）',
  )
  await assert.rejects(
    taskTool.execute({ action: 'update', id: created.id, type: 'fix' }, exec),
    (error) => error instanceof FlowError && error.code === 'invalid' && error.message === cliType.json.error.message,
  )

  // 记录本身没被任何一次失败改写。
  const onDisk = readTaskFile(root, created.id)
  assert.equal(onDisk.title, '原标题')
  assert.equal(onDisk.type, 'feat')
})

// --------------------------------------------------------------------- A9

test('A9：normalizeTaskFormat 只读零写盘；fix 合并 goal 并幂等', () => {
  const { root, contract } = freshProject('a9')
  writeLegacy(root, 'T-20260101-01', { title: '旧标题', goal: '旧目标', type: 'feat' })

  // fix:false —— 只读：bytes + mtime 全等，且不留下锁文件。
  const before = snapshotStore(root)
  const readOnly = normalizeTaskFormat(root, contract, {})
  assert.equal(readOnly.ok, false)
  assert.deepEqual(readOnly.fixed, [])
  const goalIssue = readOnly.issues.find((issue) => issue.id === 'T-20260101-01')
  assert.equal(goalIssue?.kind, 'legacy-goal')
  assert.equal(goalIssue?.goal, '旧目标')
  assert.match(goalIssue?.suggestion ?? '', /旧标题 — 旧目标/)
  assert.deepEqual(snapshotStore(root), before, 'fix:false 必须零写盘（bytes/mtime 不变）')
  assert.deepEqual(fs.readdirSync(path.join(root, '.dsh', 'flow')).filter((name) => name.endsWith('.lock')), [])

  // fix:true —— 合并成一行，删 goal 键，且不刷新 updated_at。
  const fixed = normalizeTaskFormat(root, contract, { fix: true })
  assert.deepEqual(fixed.fixed, ['T-20260101-01'])
  assert.equal(fixed.ok, true)
  const onDisk = readTaskFile(root, 'T-20260101-01')
  assert.equal(onDisk.title, '旧标题 — 旧目标')
  assert.equal(Object.hasOwn(onDisk, 'goal'), false, '迁移后 goal 键消失')
  assert.equal(onDisk.type, 'feat', '已有 type 不动')
  assert.equal(onDisk.updated_at, '2026-01-02T09:00:00+08:00', '迁移不刷新 updated_at')

  // 幂等：再读 issues=[]，再 fix 写 0 字节。
  const afterFix = normalizeTaskFormat(root, contract, {})
  assert.deepEqual(afterFix.issues, [])
  assert.equal(afterFix.ok, true)
  const afterFixSnapshot = snapshotStore(root)
  const secondFix = normalizeTaskFormat(root, contract, { fix: true })
  assert.deepEqual(secondFix.fixed, [])
  assert.deepEqual(secondFix.issues, [])
  assert.deepEqual(snapshotStore(root), afterFixSnapshot, '第二遍 fix 不得改写任何字节')
})

test('A9：goal 为空 / 等于 title 时只删键，不拼 title', () => {
  const { root, contract } = freshProject('a9-branches')
  writeLegacy(root, 'T-20260101-01', { title: '同标题', goal: '同标题', type: 'feat' })
  writeLegacy(root, 'T-20260101-02', { title: '空目标', goal: '   ', type: 'feat' })

  const report = normalizeTaskFormat(root, contract, { fix: true })
  assert.deepEqual([...report.fixed].sort(), ['T-20260101-01', 'T-20260101-02'])
  const same = readTaskFile(root, 'T-20260101-01')
  assert.equal(same.title, '同标题', 'goal === title 时不产生「x — x」')
  assert.equal(Object.hasOwn(same, 'goal'), false)
  const blank = readTaskFile(root, 'T-20260101-02')
  assert.equal(blank.title, '空目标')
  assert.equal(Object.hasOwn(blank, 'goal'), false)
})

// -------------------------------------------------------------------- A10

test('A10：type 仅在缺失时按 typeById 补齐，已有 type 不被穿透', () => {
  const { root, contract } = freshProject('a10')
  writeLegacy(root, 'T-20260101-01', { title: '缺 type' })
  writeLegacy(root, 'T-20260101-02', { title: '有 type', type: 'chore' })

  // 只读：两条都缺 goal（都有 goal 键），第一条还缺 type。
  const readOnly = normalizeTaskFormat(root, contract, { typeById: { 'T-20260101-01': 'feat' } })
  const kinds = readOnly.issues.filter((issue) => issue.id === 'T-20260101-01').map((issue) => issue.kind).sort()
  assert.deepEqual(kinds, ['legacy-goal', 'missing-type'])

  const report = normalizeTaskFormat(root, contract, {
    fix: true,
    typeById: { 'T-20260101-01': 'feat', 'T-20260101-02': 'fix' },
  })
  assert.equal(report.ok, true)
  assert.deepEqual([...report.fixed].sort(), ['T-20260101-01', 'T-20260101-02'])
  assert.equal(readTaskFile(root, 'T-20260101-01').type, 'feat', '缺失的 type 被补齐')
  assert.equal(readTaskFile(root, 'T-20260101-02').type, 'chore', '已有 type 绝不被 typeById 改写')

  // 非 10 枚举之一的 typeById 不被采纳：goal 照修，type 仍缺 → issue 保留、ok=false。
  writeLegacy(root, 'T-20260101-03', { title: '非法映射' })
  const rejected = normalizeTaskFormat(root, contract, { fix: true, typeById: { 'T-20260101-03': 'revert' } })
  assert.equal(rejected.ok, false, '缺 type 且映射非法 → 仍有待迁移项')
  assert.equal(rejected.issues.some((issue) => issue.id === 'T-20260101-03' && issue.kind === 'missing-type'), true)
  const raw = readTaskFile(root, 'T-20260101-03')
  assert.equal(Object.hasOwn(raw, 'goal'), false, 'goal 已删（可修的部分照修）')
  assert.equal(Object.hasOwn(raw, 'type'), false, '非法枚举不得写进 type')
})

// -------------------------------------------------------------------- A12

test('A12：CONTRACT 文本同步（记录块无 goal、命令树无 --goal、§7 有迁移 API）', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'CONTRACT.md'), 'utf8')
  assert.equal(text.includes('"goal": ""'), false, '§3.2 任务记录块不再有 goal 字段')
  assert.equal(text.includes('flow task add    --title T --type <t> [--status draft|active|done|archived]\n                 [--owner O] [--goal G]'), false)
  assert.equal(/flow task (?:add|update)[^\n]*\[--goal G\]/.test(text), false, '任务命令树无 --goal')
  assert.match(text, /flow heartbeat start {2}\[--goal G\]/, '心跳的 --goal 必须保留')
  assert.match(text, /normalizeTaskFormat/, '§7 core API 记录迁移函数')
  assert.match(text, /task <key> cannot be changed/, '不可改字段的统一文案')
  assert.match(text, /legacy-goal/, '迁移 issue 的 kind 命名')
  assert.match(text, /"<旧 title> — <旧 goal>"/, 'goal 合并格式写进契约')
})
