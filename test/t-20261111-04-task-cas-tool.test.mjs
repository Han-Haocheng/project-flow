// 2026-11-11（T-20261111183642）：`flow_task` 的工具层 CAS。
//
// records 域的 `updateTask` 已经支持 `expectedRevision`（整条记录签名），但工具层
// 既没有把令牌接进来，也没有把当前 revision 暴露出去——调用方无处可取，CAS 在
// 模型可用的入口上等于不存在。这组用例锁住四件事：
//   ① show/list/update 都返回 revision，且它就是 updateTask 用的那份磁盘签名；
//   ② 旧 revision 的写入被拒（conflict），磁盘保持不变；
//   ③ 不传 expectedRevision 时行为与旧版一致；
//   ④ 形状不对的令牌（非 16 位小写 hex）是 invalid，不会被静默忽略。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { addTask, getTask, initProject, listTasks, loadContract } from '../lib/core.mjs'
import { taskRevisionOf } from '../lib/tasks/records.mjs'
import { apply as applyTasks } from '../tasks.js'

const TEMP_ROOTS = []

after(() => {
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t04-cas-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t04-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

/** 记录每次派工的假 subagents 服务：CAS 用例里 stage 推进触发的自动派工不能真起子代理。 */
function fakeSubagents() {
  const calls = []
  return {
    calls,
    async startActivation(spec) {
      calls.push({ label: spec.label })
      return { childId: `child-${calls.length}` }
    },
  }
}

/** 与 `lib/host/tools.mjs` 的挂载形状一致的最小宿主。 */
function makeHost(root, { subagents = fakeSubagents() } = {}) {
  const registered = new Map()
  const tools = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    guard() {
      return () => {}
    },
    restrict() {
      return () => {}
    },
    get(name) {
      return registered.has(name) ? { name } : undefined
    },
  }
  const ctx = {
    get(name) {
      if (name === 'tools') return tools
      if (name === 'subagents') return subagents
      if (name === 'workingDirectory') return { get: () => root }
      if (name === 'agents') return { get: () => undefined, list: () => [], roots: () => [] }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // 卸载失败不影响断言
        }
      }
    },
    on() {
      return () => {}
    },
    logger: { warn() {} },
  }
  applyTasks(ctx, {})
  const tool = registered.get('flow_task')
  assert.ok(tool, 'flow_task must be registered')
  const exec = { agent: { id: 'session-cas', session: { cwd: root, header: { origin: 'main', delegationDepth: 0 } } } }
  return { tool, exec, subagents }
}

/** 建一张位于 implementing 的任务：该阶段允许改 notes，也不会触发派工。 */
function seedTask(root, contract, extra = {}) {
  return addTask(root, contract, { type: 'fix', title: 'CAS 任务', stage: 'implementing', ...extra })
}

function diskRecord(root, contract, id) {
  return JSON.parse(fs.readFileSync(path.join(root, contract.tasks.dir, `${id}.json`), 'utf8'))
}

// ------------------------------------------------------------------ schema

test('schema：update 暴露 expectedRevision，描述写明「先 show 取 revision 再带回来」', () => {
  const { root } = freshProject('schema')
  const { tool } = makeHost(root)
  const prop = tool.parameters.properties.expectedRevision
  assert.ok(prop, 'schema must expose expectedRevision')
  assert.equal(prop.type, 'string')
  assert.match(prop.description, /show/)
  assert.match(prop.description, /revision/)
  assert.deepEqual(tool.parameters.required, ['action'], 'expectedRevision 必须是可选的')
  assert.match(tool.description, /expectedRevision/)
})

// --------------------------------------------------------------- 暴露 revision

test('show：返回的 revision 就是磁盘签名（与 updateTask 的 CAS 同源），读投影本身不变', async () => {
  const { root, contract } = freshProject('show')
  const { tool, exec } = makeHost(root)
  const task = seedTask(root, contract, { notes: '原备注' })

  const shown = await tool.execute({ action: 'show', id: task.id }, exec)
  assert.equal(typeof shown.task.revision, 'string')
  assert.equal(shown.task.revision.length, 16)
  assert.equal(shown.task.revision, taskRevisionOf(root, contract, task.id), 'show 的 revision 必须等于任务域读出的磁盘签名')
  assert.equal(getTask(root, contract, task.id).revision, undefined, '不得改 getTask 读投影')
  assert.equal(shown.task.notes, '原备注')
})

test('list：每条任务都带自己的 revision（逐条读磁盘签名）', async () => {
  const { root, contract } = freshProject('list')
  const { tool, exec } = makeHost(root)
  const a = seedTask(root, contract, { title: 'A' })
  const b = seedTask(root, contract, { title: 'B' })

  const listed = await tool.execute({ action: 'list' }, exec)
  const byId = new Map(listed.items.map((task) => [task.id, task]))
  assert.equal(byId.get(a.id).revision, taskRevisionOf(root, contract, a.id))
  assert.equal(byId.get(b.id).revision, taskRevisionOf(root, contract, b.id))
  assert.notEqual(byId.get(a.id).revision, byId.get(b.id).revision, '不同记录必须得到不同签名')
  assert.equal(listTasks(root, contract).find((task) => task.id === a.id).revision, undefined, '核心列投影不含 revision')
})

// ------------------------------------------------------------------- CAS

test('CAS：旧 revision 只改 notes（阶段已被别人改）→ conflict，磁盘 stage/notes 都不变', async () => {
  const { root, contract } = freshProject('stale')
  const { tool, exec } = makeHost(root)
  const task = seedTask(root, contract, { notes: '审查前的备注' })

  const stale = taskRevisionOf(root, contract, task.id)
  // 另一个会话先把阶段推到待审查（自动派工用假 subagents 吃掉）。
  const advanced = await tool.execute({ action: 'update', id: task.id, stage: 'queued-review' }, exec)
  assert.equal(advanced.task.stage, 'reviewing', '阶段真的被第三方改了')
  const before = getTask(root, contract, task.id)
  const beforeRevision = taskRevisionOf(root, contract, task.id)
  assert.notEqual(beforeRevision, stale, '第三方写入必须换签名')

  await assert.rejects(
    () => tool.execute({ action: 'update', id: task.id, notes: '基于旧版本写的结论', expectedRevision: stale }, exec),
    (error) => error.code === 'conflict' && /flow task show/.test(error.message),
    '旧令牌必须是 conflict，且消息带重新 show 的指引',
  )

  const after = getTask(root, contract, task.id)
  assert.equal(after.stage, before.stage, '冲突写入不得改动阶段')
  assert.equal(after.notes, before.notes, '冲突写入不得改动 notes')
  assert.equal(taskRevisionOf(root, contract, task.id), beforeRevision, '冲突写入不得改动磁盘签名')
  assert.equal(diskRecord(root, contract, task.id).notes, '审查前的备注')
})

test('CAS：当前 revision 可写，返回值带新 revision（且不等于旧值）', async () => {
  const { root, contract } = freshProject('fresh')
  const { tool, exec } = makeHost(root)
  const task = seedTask(root, contract, { notes: '旧备注' })
  const current = taskRevisionOf(root, contract, task.id)

  const updated = await tool.execute(
    { action: 'update', id: task.id, notes: '新备注', expectedRevision: current },
    exec,
  )
  assert.equal(updated.task.notes, '新备注')
  assert.equal(typeof updated.task.revision, 'string')
  assert.equal(updated.task.revision.length, 16)
  assert.notEqual(updated.task.revision, current, '写入后必须换签名')
  assert.equal(updated.task.revision, taskRevisionOf(root, contract, task.id), '返回的 revision 必须与磁盘一致')
  assert.equal(getTask(root, contract, task.id).notes, '新备注')

  const raw = diskRecord(root, contract, task.id)
  assert.ok(!Object.hasOwn(raw, 'revision'), 'revision 是读时输出，不得落盘')
  assert.ok(!Object.hasOwn(raw, 'expectedRevision'), 'CAS 令牌是写路径选项，不得落盘')
})

test('兼容：不传 expectedRevision 时 update 行为与旧版一致（仍然写入并返回 revision）', async () => {
  const { root, contract } = freshProject('compat')
  const { tool, exec } = makeHost(root)
  const task = seedTask(root, contract, { notes: '旧备注' })

  const updated = await tool.execute({ action: 'update', id: task.id, notes: '不带令牌也能写' }, exec)
  assert.equal(updated.task.notes, '不带令牌也能写')
  assert.equal(updated.task.revision, taskRevisionOf(root, contract, task.id))
  assert.equal(getTask(root, contract, task.id).notes, '不带令牌也能写')
})

test('边界：expectedRevision 只属于 update，其余动作被白名单拒绝', async () => {
  const { root, contract } = freshProject('only-update')
  const { tool, exec } = makeHost(root)
  const task = seedTask(root, contract)

  await assert.rejects(
    () => tool.execute({ action: 'show', id: task.id, expectedRevision: taskRevisionOf(root, contract, task.id) }, exec),
    /does not accept "expectedRevision"/,
    'show 不接受 CAS 令牌：它只读，令牌只能跟着一次写入走',
  )
})

test('校验：非 16 位小写 hex 的 expectedRevision 一律 invalid（不静默忽略）', async () => {
  const { root, contract } = freshProject('invalid')
  const { tool, exec } = makeHost(root)
  const task = seedTask(root, contract, { notes: '原备注' })
  const current = taskRevisionOf(root, contract, task.id)

  const bad = [
    'ABC', // 太短
    current.toUpperCase(), // 大写不算
    current.slice(0, 15), // 15 位
    `${current}0`, // 17 位
    'z'.repeat(16), // 非 hex
    '', // 空串不能当作「不加锁」
    '   ', // 纯空白同理
    123, // 非字符串
    null, // 显式 null 不是「没传」
  ]
  for (const expectedRevision of bad) {
    await assert.rejects(
      () => tool.execute({ action: 'update', id: task.id, notes: '不该写入', expectedRevision }, exec),
      (error) => error.code === 'invalid' && /16 位小写十六进制/.test(error.message),
      `expectedRevision=${JSON.stringify(expectedRevision)} 必须被拒`,
    )
  }
  assert.equal(getTask(root, contract, task.id).notes, '原备注', '非法令牌不得产生任何写入')
  assert.equal(taskRevisionOf(root, contract, task.id), current)
})
