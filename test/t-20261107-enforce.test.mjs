// task-70 P2 权限面：restrict（隐藏）+ guard（拦截）+ 拒绝文案可执行 + 回滚开关。
//
// 重点不是"拦得住"，而是"没有拦过头"：正例先行，且反向变异要求
// 「主会话一律拒绝所有 flow_*」必须让第 1/10 条红。子代理本就负责派工/建任务，
// 规则 1/2 只作用于主会话；规则 3/4/5 是任务状态机纪律，对任何会话一致。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { apply as applyTasks } from '../tasks.js'
import { addTask, getTask, initProject, loadContract } from '../lib/core.mjs'

const TEMP_ROOTS = []
const HARNESSES = []

// --------------------------------------------------------------- fake host

/** Global tool names the fake host "provides" (team_task_delete deliberately absent). */
const HOST_TOOLS = [
  'spawn_teammate',
  'team_task_create',
  'team_task_update',
  'team_task_list',
  'team_task_get',
  'subagent',
  'subagent_fork',
  'flow_task',
  'flow_subtask',
  'flow_status',
  'flow_heartbeat',
  'flow_decision',
  'edit',
  'write',
]

function makeHarness(root, config = {}) {
  const registered = new Map()
  const guards = []
  const restrictions = []
  const effects = []
  const disposers = []
  const handlers = new Map()
  const live = new Map()
  const roots = new Set()
  const warns = []
  const hostTools = new Set(HOST_TOOLS)
  const toolsService = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    guard(check) {
      guards.push(check)
      return () => {}
    },
    restrict(filter) {
      restrictions.push(filter)
      return () => {}
    },
    get(name) {
      return hostTools.has(name) ? { name } : undefined
    },
  }
  const agents = {
    list: () => [...live.values()],
    roots: () => [...live.entries()].filter(([id]) => roots.has(id)).map(([, agent]) => agent),
    get: (id) => live.get(id),
  }
  const webServer = { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:0' }
  const ctx = {
    get(name) {
      if (name === 'tools') return toolsService
      if (name === 'agents') return agents
      if (name === 'webServer') return webServer
      if (name === 'workingDirectory') return { get: () => root }
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
      return () => {
        set.delete(handler)
      }
    },
    logger: {
      warn(message) {
        warns.push(String(message))
      },
    },
  }
  const harness = {
    ctx,
    registered,
    guards,
    restrictions,
    warns,
    addAgent(id, { root: isRoot = true } = {}) {
      const scope = {
        get(name) {
          return name === 'tools' ? toolsService : undefined
        },
      }
      const agent = { id, session: { cwd: root, header: { origin: 'main' } }, ctx: scope }
      live.set(id, agent)
      if (isRoot) roots.add(id)
      return agent
    },
    created(payload) {
      const listeners = harness.handler('agent/created')
      assert.equal(listeners.length, 1, `expected one agent/created hook, got ${listeners.length}`)
      listeners[0](payload)
    },
    handler(name) {
      const set = handlers.get(name)
      return set === undefined ? [] : [...set]
    },
    guardOf() {
      assert.equal(guards.length, 1, `expected one host guard, got ${guards.length}`)
      return guards[0]
    },
    dispose() {
      for (const dispose of effects.splice(0)) {
        try {
          dispose()
        } catch {
          // best effort
        }
      }
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // best effort
        }
      }
    },
  }
  HARNESSES.push(harness)
  apply(ctx, config)
  // `flow_task` lives in the separately mountable tasks sub-plugin.
  applyTasks(ctx)
  return harness
}

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t70-enforce-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t70-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

const call = (name, args, agent) => ({ name, arguments: args, agent })

after(() => {
  for (const harness of HARNESSES) harness.dispose()
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

// ------------------------------------------------------------------- 1 正例

test('正例：会话推进 actor=session 的边被放行（guard 不是一律拒绝）且 stage 通道真的能写', async () => {
  const { root, contract } = freshProject('positive')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-main')
  const task = addTask(root, contract, { type: 'feat', title: '正在分析', stage: 'analyzing', status: 'active' })
  const guard = harness.guardOf()

  assert.equal(guard(call('flow_task', { action: 'update', id: task.id, stage: 'queued-implementation' }, main)), undefined)
  // implementing → queued-review 也是 session 边
  const second = addTask(root, contract, { type: 'feat', title: '正在实现', stage: 'implementing', status: 'active' })
  assert.equal(guard(call('flow_task', { action: 'update', id: second.id, stage: 'queued-review' }, main)), undefined)

  // ③ stage 通道端到端：白名单 + 工具 schema + core 派生 status 都通。
  const tool = harness.registered.get('flow_task')
  assert.ok(tool, 'flow_task must be registered')
  const updated = await tool.execute({ action: 'update', id: task.id, stage: 'queued-implementation' }, { agent: main })
  assert.equal(updated.task.stage, 'queued-implementation')
  assert.equal(updated.task.status, 'active', 'stage derives the compatibility status')
  assert.equal(getTask(root, contract, task.id).stage, 'queued-implementation')
})

// ------------------------------------------------------------- 2 规则 1

test('规则 1：主会话不得「调度」团队（spawn/subagent），但可以维护任务板（默认 lead）', () => {
  const { root } = freshProject('rule1')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-main')
  const guard = harness.guardOf()
  const reason = guard(call('spawn_teammate', { name: 'x' }, main))
  assert.equal(typeof reason, 'string')
  assert.ok(reason.includes('flow_task_update'), reason)
  assert.ok(reason.includes('flow_task'), reason)
  assert.ok(reason.includes('插件会派工'), reason)
  for (const name of ['spawn_teammate', 'subagent', 'subagent_fork']) {
    assert.equal(typeof guard(call(name, {}, main)), 'string', `${name} (dispatch) must be denied for a main session`)
  }
  /* Regression 1 (handoff 2026-11-07): "调度" is dispatching agents, not keeping
     the shared board. Blocking the bookkeeping half froze the board in the real
     Host (nobody could mark a card done or create one). */
  for (const name of ['team_task_create', 'team_task_update', 'team_task_list', 'team_task_get']) {
    assert.equal(guard(call(name, {}, main)), undefined, `${name} (bookkeeping) must stay allowed in lead mode`)
  }
})

test('规则 1b：boardMode=plugin → team_task_* 也被拒绝（P3b 模式）', () => {
  const { root } = freshProject('rule1-plugin')
  const harness = makeHarness(root, { enforce: { boardMode: 'plugin' } })
  const main = harness.addAgent('session-main')
  const guard = harness.guardOf()
  for (const name of ['spawn_teammate', 'subagent', 'subagent_fork', 'team_task_create', 'team_task_update', 'team_task_list']) {
    assert.equal(typeof guard(call(name, {}, main)), 'string', `${name} must be denied in plugin mode`)
  }
  // The dispatch text is unchanged.
  assert.ok(guard(call('spawn_teammate', {}, main)).includes('插件会派工'))
})

test('规则 1c：非法 boardMode → 按 lead 处理并 warn 一条，不崩', () => {
  const { root } = freshProject('rule1-bad')
  const harness = makeHarness(root, { enforce: { boardMode: 'nonsense' } })
  const main = harness.addAgent('session-main')
  assert.ok(
    harness.warns.some((line) => line.includes('boardMode')),
    `expected a boardMode warning, got ${JSON.stringify(harness.warns)}`
  )
  assert.equal(harness.guardOf()(call('team_task_update', {}, main)), undefined, 'an invalid value falls back to lead')
})

// ------------------------------------------------------------- 3 规则 2

test('规则 2：主会话可以建主任务，但不能直接建子任务（子任务归分析者）', () => {
  const { root } = freshProject('rule2')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-main')
  const guard = harness.guardOf()
  assert.equal(guard(call('flow_task', { action: 'add', title: 't', type: 'feat' }, main)), undefined, '主会话建主任务必须放行')
  const reason = guard(call('flow_task', { action: 'add', title: 't', type: 'feat', parent: 'T-20261111120000' }, main))
  assert.equal(typeof reason, 'string', '主会话直接建子任务应被拒')
  assert.ok(reason.includes('分析者'), reason)
})

// ------------------------------------------------------------- 4 规则 3

test('规则 3：跳级（created → done）→ 拒绝并列出合法后继', () => {
  const { root, contract } = freshProject('rule3')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-main')
  const task = addTask(root, contract, { type: 'feat', title: '新任务' })
  assert.equal(getTask(root, contract, task.id).stage, 'created')
  const reason = harness.guardOf()(call('flow_task', { action: 'update', id: task.id, stage: 'done' }, main))
  assert.equal(typeof reason, 'string')
  assert.ok(reason.includes('created'), reason)
  assert.ok(reason.includes('queued-analysis'), reason)
  assert.ok(reason.includes('done'), reason)
})

// ------------------------------------------------------------- 5 规则 4

test('规则 4（team 模式）：边存在但 actor 不是 session → 拒绝并说明由谁推进、你能推什么', () => {
  const { root, contract } = freshProject('rule4')
  const harness = makeHarness(root, { enforce: { actorMode: 'team' } })
  const main = harness.addAgent('session-main')
  const task = addTask(root, contract, { type: 'feat', title: '新任务' })
  const reason = harness.guardOf()(call('flow_task', { action: 'update', id: task.id, stage: 'queued-analysis' }, main))
  assert.equal(typeof reason, 'string')
  assert.ok(reason.includes('plugin'), reason)
  assert.ok(reason.includes('不是你'), reason)
  assert.ok(reason.includes('你只能推进'), reason)
})

// ------------------------------------------------------------- 6 规则 5

test('规则 5：父任务在 queued-analysis 时改子任务 → 拒绝并报当前阶段中文（analyzing 已放行给分析者）', () => {
  const { root, contract } = freshProject('rule5-deny')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-main')
  const parent = addTask(root, contract, { type: 'feat', title: '父任务', stage: 'queued-analysis', status: 'active' })
  const reason = harness.guardOf()(call('flow_subtask', { action: 'add', parent: parent.id, title: '子' }, main))
  assert.equal(typeof reason, 'string')
  assert.ok(reason.includes('待分析'), reason)
})

// ------------------------------------------------------- 7 规则 5 正例

test('规则 5 正例：父任务在 implementing 时改子任务 → 放行', () => {
  const { root, contract } = freshProject('rule5-allow')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-main')
  const parent = addTask(root, contract, { type: 'feat', title: '父任务', stage: 'implementing', status: 'active' })
  assert.equal(harness.guardOf()(call('flow_subtask', { action: 'add', parent: parent.id, title: '子' }, main)), undefined)
})

// --------------------------------------------------------- 8 子代理不受限

test('子代理不受规则 1/2 限制：派工与建任务都放行', () => {
  const { root } = freshProject('subagent')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-main')
  harness.addAgent('session-main') // keep roots stable
  const child = harness.addAgent('session-child', { root: false })
  const guard = harness.guardOf()
  assert.equal(guard(call('spawn_teammate', { name: 'x' }, child)), undefined, 'subagent needs to dispatch')
  assert.equal(guard(call('flow_task', { action: 'add', title: 't', type: 'feat' }, child)), undefined, 'subagent may create tasks')
  assert.equal(typeof guard(call('spawn_teammate', {}, main)), 'string', 'the main session is still denied')
})

// ----------------------------------------------------------- 9 回滚开关

test('enforce:false：restrict 与全部 guard 不注册，主会话回到 P1 行为', () => {
  const { root } = freshProject('rollback')
  const harness = makeHarness(root, { enforce: false })
  const main = harness.addAgent('session-main')
  // 只有心跳门禁的 guard 还在（默认开启），P2 规则全部放行。
  const guard = harness.guardOf()
  assert.equal(guard(call('spawn_teammate', {}, main)), undefined)
  assert.equal(guard(call('team_task_update', {}, main)), undefined, 'enforce:false allows the board too')
  assert.equal(guard(call('flow_task', { action: 'add', title: 't', type: 'feat' }, main)), undefined)
  assert.equal(harness.restrictions.length, 0, 'enforce:false must not restrict')
  harness.created({ agent: main, source: 'startup', signal: { aborted: false } })
  assert.equal(harness.restrictions.length, 0, 'agent/created must not restrict when enforce is off')
})

// ------------------------------------------------- 10 回归：其它 flow 工具不受影响

test('回归：flow_status / flow_heartbeat / flow_decision 完全不受 P2 守卫影响', () => {
  const { root } = freshProject('regression')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-main')
  const guard = harness.guardOf()
  assert.equal(guard(call('flow_status', {}, main)), undefined)
  assert.equal(guard(call('flow_heartbeat', { action: 'update', status: 'working' }, main)), undefined)
  assert.equal(guard(call('flow_decision', { action: 'list' }, main)), undefined)
})

// ------------------------------------------------ 11 restrict（隐藏层）

test('restrict（lead）：主会话只隐藏「调度」工具，任务板保持可见；子代理不隐藏', () => {
  const { root } = freshProject('restrict')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-main')
  const child = harness.addAgent('session-child', { root: false })

  harness.created({ agent: main, source: 'startup', signal: { aborted: false } })
  assert.equal(harness.restrictions.length, 1, 'a main session gets exactly one restriction')
  const deny = harness.restrictions[0].deny
  assert.deepEqual(deny.slice().sort(), ['spawn_teammate', 'subagent', 'subagent_fork'], 'lead mode hides dispatch only')
  assert.equal(deny.includes('team_task_update'), false, 'the board tools must stay visible')

  harness.created({ agent: child, source: 'startup', signal: { aborted: false } })
  assert.equal(harness.restrictions.length, 1, 'a subagent must keep the team tools')
})

test('restrict（plugin）：主会话隐藏全部团队工具，未知名字仍被过滤', () => {
  const { root } = freshProject('restrict-plugin')
  const harness = makeHarness(root, { enforce: { boardMode: 'plugin' } })
  const main = harness.addAgent('session-main')
  harness.created({ agent: main, source: 'startup', signal: { aborted: false } })
  assert.equal(harness.restrictions.length, 1)
  const deny = harness.restrictions[0].deny
  for (const name of ['spawn_teammate', 'team_task_create', 'team_task_update', 'team_task_list', 'team_task_get', 'subagent', 'subagent_fork']) {
    assert.ok(deny.includes(name), `${name} must be hidden in plugin mode`)
  }
  assert.equal(deny.includes('team_task_delete'), false, 'a tool the host does not provide must be filtered out')
})

// ------------------------------------------- 12 capture:false 的 restrict 兜底

test('capture:false 时 created 钩子只留心跳职责，pre-step 仍对主会话做一次 restrict', async () => {
  const { root } = freshProject('fallback')
  const harness = makeHarness(root, { capture: false })
  const main = harness.addAgent('session-main')
  assert.equal(harness.handler('agent/created').length, 1,
    'the created hook stays registered for the heartbeat lifecycle, but its capture/enforce duties stay inert')
  const listener = harness.handler('agent/pre-step')[0]
  assert.ok(listener, 'the reminder pre-step hook must still exist')
  const payload = { agent: main, messages: [], turn: 1, step: 1, signal: { aborted: false } }
  const next = async () => ({ kind: 'enter', messages: [] })
  await listener(payload, next)
  assert.equal(harness.restrictions.length, 1, 'the pre-step fallback must restrict a main session once')
  await listener(payload, next)
  assert.equal(harness.restrictions.length, 1, 'the per-agent WeakSet must prevent a second restriction')
})

// ------------------------------------- 13 actorMode：single（默认）解除死锁

test('actorMode=single（默认）：queued-implementation → implementing 放行——死锁解除', () => {
  const { root, contract } = freshProject('single-deadlock')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-main')
  const task = addTask(root, contract, {
    type: 'feat',
    title: '停在待实现',
    stage: 'queued-implementation',
    status: 'active',
  })
  const reason = harness.guardOf()(call('flow_task', { action: 'update', id: task.id, stage: 'implementing' }, main))
  assert.equal(reason, undefined, 'single mode must let the only role walk a real edge')
})

// --------------------------------- 14 single 仍强制结构：跳级照样拒绝

test('actorMode=single 仍然拦跳级：analyzing → implementing 拒绝（规则 3 与 actorMode 无关）', () => {
  const { root, contract } = freshProject('single-structure')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-main')
  const task = addTask(root, contract, { type: 'feat', title: '分析中', stage: 'analyzing', status: 'active' })
  const reason = harness.guardOf()(call('flow_task', { action: 'update', id: task.id, stage: 'implementing' }, main))
  assert.equal(typeof reason, 'string', 'single mode is not "allow everything": structure still rules')
  assert.ok(reason.includes('analyzing'), reason)
  assert.ok(reason.includes('queued-implementation'), reason)
})

// --------------------------------- 15 team 模式：规则 4 保留并拒绝

test('actorMode=team：queued-implementation → implementing 拒绝（actor=plugin）', () => {
  const { root, contract } = freshProject('team-actor')
  const harness = makeHarness(root, { enforce: { actorMode: 'team' } })
  const main = harness.addAgent('session-main')
  const task = addTask(root, contract, {
    type: 'feat',
    title: '停在待实现',
    stage: 'queued-implementation',
    status: 'active',
  })
  const reason = harness.guardOf()(call('flow_task', { action: 'update', id: task.id, stage: 'implementing' }, main))
  assert.equal(typeof reason, 'string', 'team mode keeps rule 4 (the P3 implementation, not deleted)')
  assert.ok(reason.includes('plugin'), reason)
  assert.ok(reason.includes('不是你'), reason)
})

// --------------------------------- 16 非法 actorMode：按 single 处理并 warn

test('非法 actorMode：按 single 处理并 warn 一条，不崩', () => {
  const { root, contract } = freshProject('bad-mode')
  const harness = makeHarness(root, { enforce: { actorMode: 'bogus' } })
  const main = harness.addAgent('session-main')
  assert.ok(
    harness.warns.some((line) => line.includes('actorMode')),
    `expected one actorMode warning, got ${JSON.stringify(harness.warns)}`,
  )
  const task = addTask(root, contract, {
    type: 'feat',
    title: '停在待实现',
    stage: 'queued-implementation',
    status: 'active',
  })
  assert.equal(
    harness.guardOf()(call('flow_task', { action: 'update', id: task.id, stage: 'implementing' }, main)),
    undefined,
    'an invalid mode falls back to single instead of disabling/over-blocking',
  )
})

// --------------------------- 17 enforce:false 与 actorMode 正交

test('enforce:false 与 actorMode 正交：即使配置了 team，守卫仍不注册', () => {
  const { root, contract } = freshProject('orthogonal')
  const harness = makeHarness(root, { enforce: false })
  const main = harness.addAgent('session-main')
  const task = addTask(root, contract, { type: 'feat', title: '分析中', stage: 'analyzing', status: 'active' })
  const guard = harness.guardOf() // 只剩心跳门禁
  assert.equal(guard(call('flow_task', { action: 'add', title: 't', type: 'feat' }, main)), undefined)
  assert.equal(guard(call('flow_task', { action: 'update', id: task.id, stage: 'done' }, main)), undefined)
})
