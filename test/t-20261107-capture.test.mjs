// task-64 P1 捕获流水线（§6/§8/§9）。
//
// 关键路径纪律：`agent/pre-step` 只做内存记录（过滤 → 集合差 → 队列），
// `agent/turn-stopping`（serial，宿主 await）才落盘；`agent/created` 从栈顶任务
// 自动开心跳（无栈顶绝不开）。三条排除规则各有一条独立用例——综合用例无法说明
// 是哪条规则失效，而三条里的任何一条失效都会让插件自己给自己造任务。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { addTask, listTasks, loadContract, initProject, startHeartbeat } from '../lib/core.mjs'
import { compareStack, utteranceKey } from '../lib/capture.mjs'

const TEMP_ROOTS = []
const HARNESSES = []

// ---------------------------------------------------------------- fake host

function makeHarness(root, config = {}) {
  const handlers = new Map()
  const effects = []
  const live = new Map()
  const rootIds = new Set()
  const warns = []
  const tools = new Map()
  const agents = {
    list: () => [...live.values()],
    roots: () => [...live.entries()].filter(([id]) => rootIds.has(id)).map(([, agent]) => agent),
    get: (id) => live.get(id),
  }
  const webServer = {
    register() {
      return () => {}
    },
    getOrigin() {
      return 'http://127.0.0.1:0'
    },
  }
  const toolsService = {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    guard() {
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'agents') return agents
      if (name === 'tools') return toolsService
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
  apply(ctx, config)
  const harness = {
    ctx,
    handlers,
    warns,
    tools,
    addAgent(id) {
      const agent = { id, session: { cwd: root, header: { origin: 'main' } } }
      live.set(id, agent)
      rootIds.add(id)
      return agent
    },
    handler(name) {
      const set = handlers.get(name)
      return set === undefined ? [] : [...set]
    },
    dispose() {
      for (const dispose of effects.splice(0)) {
        try {
          dispose()
        } catch {
          // test cleanup is best effort
        }
      }
    },
  }
  HARNESSES.push(harness)
  return harness
}

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t64-capture-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t64-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

const userMessage = (text, timestamp) => ({ role: 'user', content: [{ type: 'text', text }], timestamp })
const tasksOf = (root, contract) => listTasks(root, contract)
const heartbeatFile = (root, session) => path.join(root, '.agents', 'heartbeat', `${session}.json`)

// ------------------------------------------------------------- event dispatch

/** `agent/pre-step` is a waterfall: call the plugin hook with an `enter` next(). */
async function preStep(harness, agent, messages) {
  const listener = harness.handler('agent/pre-step')[0]
  assert.ok(listener, 'the plugin must register one agent/pre-step hook')
  return listener(
    { agent, messages, turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }),
  )
}

/** `agent/turn-stopping` is serial: the plugin registers exactly one hook. */
async function turnStopping(harness, agent) {
  const listeners = harness.handler('agent/turn-stopping')
  assert.equal(listeners.length, 1, `expected one turn-stopping hook, got ${listeners.length}`)
  await listeners[0]({ agent, turn: 1, signal: { aborted: false } })
}

async function agentCreated(harness, agent) {
  const listeners = harness.handler('agent/created')
  assert.equal(listeners.length, 1, `expected one agent/created hook, got ${listeners.length}`)
  await listeners[0]({ agent, source: 'startup', signal: { aborted: false } })
}

async function flowStatus(harness, agent, root) {
  const tool = harness.tools.get('flow_status')
  assert.ok(tool, 'flow_status must be registered')
  return tool.execute({ root }, { agent })
}

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

test('捕获正例：一条用户消息 → 恰好 1 条任务，source/stage 正确，且 pre-step 本身不落盘', async () => {
  const { root, contract } = freshProject('basic')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-capture-basic')
  const at = '2026-11-07T10:00:00+08:00'
  const text = '把 P1 捕获流水线做完'

  await preStep(harness, agent, [userMessage(text, at)])
  assert.equal(tasksOf(root, contract).length, 0, 'pre-step must stay memory-only (no task before turn-stopping)')

  await turnStopping(harness, agent)
  const tasks = tasksOf(root, contract)
  assert.equal(tasks.length, 1, `expected exactly one task, got ${tasks.length}`)
  const task = tasks[0]
  assert.equal(task.title, text)
  assert.deepEqual(task.source, { kind: 'utterance', key: utteranceKey(at, text), at })
  assert.equal(task.stage, 'queued-analysis', 'created is advanced to queued-analysis immediately')
  assert.equal(task.status, 'active', 'status is the compatibility view of queued-analysis')
  assert.equal(task.type, 'chore', 'P1 does not infer a conventional type')
})

// ------------------------------------------------------- 2 幂等（最重要）

test('幂等：同一 pre-step payload 连发 3 次仍只有 1 条任务；换进程重放也不再建', async () => {
  const { root, contract } = freshProject('idempotent')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-capture-idempotent')
  const at = '2026-11-07T10:01:00+08:00'
  const batch = [userMessage('同一句话不要建三次', at)]

  for (let round = 1; round <= 3; round += 1) {
    await preStep(harness, agent, batch)
  }
  await turnStopping(harness, agent)
  assert.equal(tasksOf(root, contract).length, 1, 'the same step batch must produce exactly one task')

  // 跨进程：新 mount = 新内存状态，重放同一批 messages；去重必须靠落盘的 source.key。
  const fresh = makeHarness(root)
  const freshAgent = fresh.addAgent('session-capture-idempotent')
  await preStep(fresh, freshAgent, batch)
  await turnStopping(fresh, freshAgent)
  const tasks = tasksOf(root, contract)
  assert.equal(tasks.length, 1, 'a restarted plugin must dedupe against the persisted source.key')
  assert.equal(tasks[0].source.key, utteranceKey(at, '同一句话不要建三次'))
})

// ------------------------------------------------ 3 排除规则 ①：插件注入 context

test('排除 ①：带 <flow-context> 哨兵的注入 context 不建任务（含数组 content）', async () => {
  const { root, contract } = freshProject('rule-sentinel')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-capture-sentinel')
  const at = '2026-11-07T10:02:00+08:00'
  const plain = '这是真正的用户指令'

  await preStep(harness, agent, [
    userMessage(`<flow-context>当前任务 T-20261107-01 · 阶段 分析中</flow-context>`, at),
    { role: 'user', content: [{ type: 'text', text: '<flow-context>第二段注入</flow-context>' }], timestamp: at },
    userMessage(plain, at),
  ])
  await turnStopping(harness, agent)

  const tasks = tasksOf(root, contract)
  assert.deepEqual(tasks.map((task) => task.title), [plain], 'only the plain user sentence may become a task')
})

// ------------------------------------------------- 4 排除规则 ②：系统前缀

test('排除 ②：以 【project-flow】 / <system-reminder> / [WIP] 开头的 content 不建任务', async () => {
  const { root, contract } = freshProject('rule-prefix')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-capture-prefix')
  const at = '2026-11-07T10:03:00+08:00'
  const plain = '前缀规则之外的真实请求'

  await preStep(harness, agent, [
    userMessage('【project-flow】本轮还没有 working 心跳。先调用 flow_heartbeat start。', at),
    userMessage('<system-reminder>Read the rules before acting.</system-reminder>', at),
    userMessage('[WIP] 上一条任务的草稿提示', at),
    userMessage(plain, at),
  ])
  await turnStopping(harness, agent)

  const tasks = tasksOf(root, contract)
  assert.deepEqual(tasks.map((task) => task.title), [plain], 'known system prefixes must never become tasks')
})

// ---------------------------------------- 5 排除规则 ③：step 集合差（重放）

test('排除 ③：两个 step 重放同一批 messages 不重复建任务；新进入的那条才建', async () => {
  const { root, contract } = freshProject('rule-diff')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-capture-diff')
  const at = '2026-11-07T10:04:00+08:00'
  const first = userMessage('第一句', at)
  const batchA = [first]
  const second = userMessage('第二句', '2026-11-07T10:05:00+08:00')
  const batchAB = [first, second]

  await preStep(harness, agent, batchA)
  await preStep(harness, agent, batchA) // 同一 step 的 replay：集合差为空
  await preStep(harness, agent, batchAB) // 本轮新进入第二句
  await turnStopping(harness, agent)

  const titles = tasksOf(root, contract).map((task) => task.title).sort()
  assert.deepEqual(titles, ['第一句', '第二句'].sort(), 'the replayed batch must not duplicate "第一句"')
})

// ------------------------------------------------------- 6 状态块 / 逃生门

test('状态块：flow_status 与 flow_heartbeat update 都带 stack/counts/team/unfinished 与最近 3 条自动建', async () => {
  const { root, contract } = freshProject('status')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-capture-status')

  // 两批共 4 条自动任务（batch1 先落，batch2 后落）。
  await preStep(harness, agent, [
    userMessage('自动任务甲', '2026-11-07T10:06:00+08:00'),
    userMessage('自动任务乙', '2026-11-07T10:07:00+08:00'),
  ])
  await turnStopping(harness, agent)
  await preStep(harness, agent, [
    userMessage('自动任务丙', '2026-11-07T10:08:00+08:00'),
    userMessage('自动任务丁', '2026-11-07T10:09:00+08:00'),
  ])
  await turnStopping(harness, agent)

  const all = tasksOf(root, contract)
  assert.equal(all.length, 4)
  const status = await flowStatus(harness, agent, root)
  assert.ok(Array.isArray(status.stack), 'flow_status must carry data.stack[]')
  assert.equal(status.stack.length, 4, 'all four unfinished tasks are on the stack')
  assert.equal(typeof status.unfinished, 'number')
  assert.equal(status.unfinished, 4)
  assert.deepEqual(Object.keys(status.counts).sort(), [
    'analyzing', 'archived', 'created', 'done', 'implementing', 'queued-analysis',
    'queued-implementation', 'queued-review', 'reviewing',
  ])
  assert.equal(status.counts['queued-analysis'], 4)
  assert.deepEqual(status.team, { members: 0, tasks: 0 }, 'team counts stay zero until P2/P3')
  assert.ok(Array.isArray(status.recentCaptured), 'the §6.3 escape hatch must be present')
  assert.equal(status.recentCaptured.length, 3, 'exactly the newest three auto-created tasks')
  // §11 LIFO：created_at 倒序、同秒回退 id 倒序。四条的 created_at 可能落在同一秒
  // （两批 flush 相邻），所以期望值必须用同一条契约算，不能假定消息顺序。
  const newestThree = all.slice().sort(compareStack).slice(0, 3).map((task) => task.id)
  assert.deepEqual(status.recentCaptured.map((row) => row.id), newestThree, 'recentCaptured is newest-first and bounded to 3')
  const oldest = all.slice().sort(compareStack).at(-1)
  assert.ok(
    status.recentCaptured.every((row) => row.id !== oldest.id),
    'the oldest auto-created task must fall off the escape hatch',
  )
  for (const row of status.recentCaptured) {
    assert.ok(all.some((task) => task.id === row.id), `recentCaptured id ${row.id} must be a real task`)
    assert.equal(typeof row.at, 'string')
  }

  // flow_heartbeat update 带同一个块（§8/§9）。
  const heartbeatTool = harness.tools.get('flow_heartbeat')
  assert.ok(heartbeatTool, 'flow_heartbeat must be registered')
  startHeartbeat(root, contract, { session: agent.id, goal: '状态块', createTask: false })
  const updated = await heartbeatTool.execute({ action: 'update', last_action: '推进阶段' }, { agent })
  assert.equal(updated.heartbeat.status, 'working')
  assert.ok(Array.isArray(updated.stack) && updated.stack.length === 4, 'flow_heartbeat update must carry the same stack')
  assert.equal(updated.unfinished, 4)
  assert.equal(updated.recentCaptured.length, 3)
})

// ------------------------------------------------- 7 回滚开关 / 心跳自动开

test('开关与心跳：capture:false 全停（回到 P0）；空台账绝不开空壳心跳；有栈顶才开', async () => {
  // 7a capture:false —— pre-step/turn-stopping 不建任务，agent/created 不开心跳。
  const off = freshProject('switch-off')
  const offHarness = makeHarness(off.root, { capture: false })
  const offAgent = offHarness.addAgent('session-capture-off')
  // 放一条未完成任务在栈上：若自动开心跳未被开关关掉，它就会开出来。
  addTask(off.root, off.contract, { type: 'feat', title: '栈顶任务', scope: { allow: ['lib/capture.mjs'] } })
  await preStep(offHarness, offAgent, [userMessage('开关关闭时不该建任务', '2026-11-07T10:10:00+08:00')])
  await turnStopping(offHarness, offAgent)
  assert.equal(offHarness.handler('agent/created').length, 0, 'capture:false must not register the created hook at all')
  assert.equal(tasksOf(off.root, off.contract).length, 1, 'capture:false must not create tasks')
  assert.equal(fs.existsSync(heartbeatFile(off.root, offAgent.id)), false, 'capture:false must not auto-start a heartbeat')
  const offStatus = await flowStatus(offHarness, offAgent, off.root)
  assert.equal(Object.hasOwn(offStatus, 'stack'), false, 'capture:false keeps the P0 flow_status shape')

  // 7b capture 开 + 空台账 —— 取不到栈顶，绝不开心跳，只 warn 一行。
  const empty = freshProject('switch-empty')
  const emptyHarness = makeHarness(empty.root)
  const emptyAgent = emptyHarness.addAgent('session-capture-empty')
  await agentCreated(emptyHarness, emptyAgent)
  assert.equal(fs.existsSync(heartbeatFile(empty.root, emptyAgent.id)), false, 'an empty stack must never open an empty heartbeat')
  assert.ok(
    emptyHarness.warns.some((line) => line.includes('auto-start skipped')),
    `expected one auto-start-skipped warning, got ${JSON.stringify(emptyHarness.warns)}`,
  )

  // 7c capture 开 + 有栈顶 —— goal/task/claims 全部来自栈顶，不是空壳。
  const open = freshProject('switch-open')
  const openHarness = makeHarness(open.root)
  const openAgent = openHarness.addAgent('session-capture-open')
  addTask(open.root, open.contract, {
    type: 'feat',
    title: '栈顶：捕获流水线',
    scope: { allow: ['lib/capture.mjs', 'index.js'] },
  })
  await agentCreated(openHarness, openAgent)
  const file = heartbeatFile(open.root, openAgent.id)
  assert.equal(fs.existsSync(file), true, 'agent/created must open the heartbeat when a stack top exists')
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(record.status, 'working')
  assert.equal(record.goal, '栈顶：捕获流水线')
  assert.equal(typeof record.task, 'string', 'the heartbeat must point at the stack-top task')
  assert.deepEqual(record.claims, ['lib/capture.mjs', 'index.js'])
})
