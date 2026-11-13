// task-74 P4 第 1 组：`flow_subtask` 工具 —— 让 P2 的守卫规则 5 从死代码变成活代码。
//
// 规则 5 在 P2 已写好并测过，但工具当时不存在，所以它从未被真正触发。这里既测工具
// 的行为（add/update/remove），也测「父任务不在实现阶段 → guard 拒绝且文案含阶段中文」，
// 后者是规则 5 可达的唯一证据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { addTask, getTask, initProject, loadContract } from '../lib/core.mjs'

const TEMP_ROOTS = []
const HARNESSES = []

const HOST_TOOLS = ['flow_task', 'flow_subtask', 'flow_status', 'flow_heartbeat', 'flow_decision', 'spawn_teammate']

function makeHarness(root) {
  const registered = new Map()
  const guards = []
  const restrictions = []
  const effects = []
  const handlers = new Map()
  const toolsService = {
    register: (definition) => {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    guard: (check) => {
      guards.push(check)
      return () => {}
    },
    restrict: (filter) => {
      restrictions.push(filter)
      return () => {}
    },
    get: (name) => (HOST_TOOLS.includes(name) ? { name } : undefined),
  }
  const main = { id: 'session-main', session: { cwd: root, header: { origin: 'main' } }, ctx: { get: (name) => (name === 'tools' ? toolsService : undefined) } }
  const agents = { roots: () => [main], list: () => [main], get: () => undefined }
  const ctx = {
    get(name) {
      if (name === 'tools') return toolsService
      if (name === 'agents') return agents
      if (name === 'workingDirectory') return { get: () => root }
      if (name === 'webServer') return { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:0' }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    on(name, handler) {
      const set = handlers.get(name) ?? new Set()
      set.add(handler)
      handlers.set(name, set)
      return () => set.delete(handler)
    },
    logger: { warn() {} },
  }
  apply(ctx, {})
  const harness = {
    registered,
    main,
    guard: (execution) => guards[0](execution),
    tool: (name) => registered.get(name),
    dispose: () => effects.splice(0).forEach((dispose) => { try { dispose() } catch {} }),
  }
  HARNESSES.push(harness)
  return harness
}

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t74-subtask-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t74-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

test.after(() => {
  for (const harness of HARNESSES) harness.dispose()
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})

const SUBTASK_ARGS = { action: 'add', parent: '', type: 'feat', title: '子任务一' }

function addParent(root, contract, stage) {
  return addTask(root, contract, { type: 'feat', title: `父任务 ${stage}`, stage })
}

// ------------------------------------------------------------- add + 规则 5

test('add：父任务在 implementing → guard 放行，子任务默认落到 queued-implementation 且 parent 正确', async () => {
  const { root, contract } = freshProject('add-ok')
  const harness = makeHarness(root)
  const parent = addParent(root, contract, 'implementing')
  const tool = harness.tool('flow_subtask')
  assert.ok(tool, 'flow_subtask must be registered')
  const args = { ...SUBTASK_ARGS, parent: parent.id }
  assert.equal(harness.guard({ name: 'flow_subtask', arguments: args, agent: harness.main }), undefined, 'rule 5 allows an implementing parent')
  const result = await tool.execute(args, { agent: harness.main })
  assert.equal(result.task.parent, parent.id)
  assert.equal(result.task.stage, 'queued-implementation', '分析者拆出的子任务是实现单元，默认直接进实现队列')
  assert.equal(result.task.status, 'active', 'queued-implementation derives active')
  assert.equal(result.task.title, '子任务一')
})

test('add：父任务在 queued-implementation → 同样放行（另一个实现阶段）', () => {
  const { root, contract } = freshProject('add-queued')
  const harness = makeHarness(root)
  const parent = addParent(root, contract, 'queued-implementation')
  assert.equal(
    harness.guard({ name: 'flow_subtask', arguments: { ...SUBTASK_ARGS, parent: parent.id }, agent: harness.main }),
    undefined
  )
})

test('规则 5 可达：父任务在 queued-analysis → guard 拒绝，文案含当前阶段中文「待分析」（analyzing 放行）', () => {
  const { root, contract } = freshProject('rule5')
  const harness = makeHarness(root)
  const parent = addParent(root, contract, 'queued-analysis')
  const reason = harness.guard({ name: 'flow_subtask', arguments: { ...SUBTASK_ARGS, parent: parent.id }, agent: harness.main })
  assert.equal(typeof reason, 'string', 'rule 5 must now fire: the tool exists')
  assert.ok(reason.includes('待分析'), `the rejection must name the current stage in Chinese: ${reason}`)
})

test('add：父任务不存在 → core 拒绝（不产生孤儿）', async () => {
  const { root } = freshProject('add-missing-parent')
  const harness = makeHarness(root)
  await assert.rejects(() => harness.tool('flow_subtask').execute({ ...SUBTASK_ARGS, parent: 'T-NOPE' }, { agent: harness.main }))
})

// ------------------------------------------------------------------- update

test('update：只允许 notes/stage；合法边可写，非法边抛 invalid 并列出合法后继', async () => {
  const { root, contract } = freshProject('update')
  const harness = makeHarness(root)
  const parent = addParent(root, contract, 'implementing')
  const tool = harness.tool('flow_subtask')
  const added = await tool.execute({ ...SUBTASK_ARGS, parent: parent.id }, { agent: harness.main })
  const { task } = added
  /* T-20261113160505：自动派工默认关——建子卡不再自动派实现者（dispatch 字段不出现）。 */
  assert.equal(added.dispatch, undefined, 'flow_subtask add 默认不派工')

  const noted = await tool.execute({ action: 'update', id: task.id, notes: '补充说明' }, { agent: harness.main })
  assert.equal(noted.task.notes, '补充说明')

  // queued-implementation → implementing is a legal edge。
  const advanced = await tool.execute({ action: 'update', id: task.id, stage: 'implementing' }, { agent: harness.main })
  assert.equal(advanced.task.stage, 'implementing')

  await assert.rejects(
    () => tool.execute({ action: 'update', id: task.id, stage: 'done' }, { agent: harness.main }),
    (error) => error.code === 'invalid' && /implementing/.test(error.message) && /queued-review/.test(error.message),
    'an illegal jump must name the legal successors'
  )
  // Any field outside notes/stage is refused instead of silently dropped.
  await assert.rejects(
    () => tool.execute({ action: 'update', id: task.id, owner: 'x' }, { agent: harness.main }),
    /does not accept "owner"/
  )
})

// ------------------------------------------------------------------- remove

test('remove：不物理删除 —— 记录仍在、stage=done、done_at 有值、notes 含 [removed] 原因', async () => {
  const { root, contract } = freshProject('remove')
  const harness = makeHarness(root)
  const parent = addParent(root, contract, 'implementing')
  const tool = harness.tool('flow_subtask')
  const { task } = await tool.execute({ ...SUBTASK_ARGS, parent: parent.id, notes: '原有备注' }, { agent: harness.main })

  const removed = await tool.execute({ action: 'remove', id: task.id, reason: '方向不对' }, { agent: harness.main })
  assert.equal(removed.task.stage, 'done')
  assert.equal(removed.task.status, 'done')
  assert.equal(typeof removed.task.done_at, 'string')
  assert.ok(removed.task.done_at.length > 0, 'done_at must be stamped')
  assert.ok(removed.task.notes.includes('原有备注'), 'existing notes are kept')
  assert.ok(removed.task.notes.includes('[removed] 方向不对'), 'the reason is appended as a notes line')

  const read = getTask(root, contract, task.id)
  assert.ok(read, 'the record must still exist (no physical delete)')
  assert.equal(read.stage, 'done')
  assert.ok(read.notes.includes('[removed] 方向不对'))
})

test('remove：reason 必填', async () => {
  const { root, contract } = freshProject('remove-reason')
  const harness = makeHarness(root)
  const parent = addParent(root, contract, 'implementing')
  const tool = harness.tool('flow_subtask')
  const { task } = await tool.execute({ ...SUBTASK_ARGS, parent: parent.id }, { agent: harness.main })
  await assert.rejects(() => tool.execute({ action: 'remove', id: task.id }, { agent: harness.main }), /requires a reason/)
})
