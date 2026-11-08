// task-64 P1 捕获流水线（§6/§8/§9）。
//
// 关键路径纪律：`agent/pre-step` 只做内存记录（过滤 → 集合差 → 队列），
// `agent/turn-stopping`（serial，宿主 await）才落盘；`agent/created` 从栈顶任务
// 自动开心跳（task-81 ③ 起空栈也开：占位 goal + task:null，绝不凭空造任务）。
// 三条排除规则各有一条独立用例——综合用例无法说明是哪条规则失效，而三条里的
// 任何一条失效都会让插件自己给自己造任务。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { addTask, listTasks, loadContract, initProject, startHeartbeat } from '../lib/core.mjs'
import {
  PEER_MESSAGE_PREFIXES,
  SOURCE_TEXT_MAX,
  exclusionReasonOf,
  buildStatusBlock,
  captureSummary,
  compareStack,
  createCaptureState,
  noteCaptureGate,
  recordPreStep,
  utteranceKey,
} from '../lib/capture.mjs'

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
/** Message timestamps must sit inside the mount grace window (defect 2). */
const recentStamp = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()
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
  const at = recentStamp(-5000)
  const text = '把 P1 捕获流水线做完'

  await preStep(harness, agent, [userMessage(text, at)])
  assert.equal(tasksOf(root, contract).length, 0, 'pre-step must stay memory-only (no task before turn-stopping)')

  await turnStopping(harness, agent)
  const tasks = tasksOf(root, contract)
  assert.equal(tasks.length, 1, `expected exactly one task, got ${tasks.length}`)
  const task = tasks[0]
  assert.equal(task.title, text)
  assert.deepEqual(task.source, { kind: 'utterance', key: utteranceKey(at, text), at, text }, 'source.text keeps the full sentence')
  assert.equal(task.stage, 'queued-analysis', 'created is advanced to queued-analysis immediately')
  assert.equal(task.status, 'active', 'status is the compatibility view of queued-analysis')
  assert.equal(task.type, 'chore', 'P1 does not infer a conventional type')
})

// ------------------------------------------------------- 2 幂等（最重要）

test('幂等：同一 pre-step payload 连发 3 次仍只有 1 条任务；换进程重放也不再建', async () => {
  const { root, contract } = freshProject('idempotent')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-capture-idempotent')
  const at = recentStamp(-5000)
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
  const at = recentStamp(-4000)
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
  const at = recentStamp(-3000)
  const plain = '前缀规则之外的真实请求'

  await preStep(harness, agent, [
    // 只验「【project-flow】前缀被排除」这一条；不抄心跳模块的引导语——它归另一个模块，
    // 抄进来就会在那边改文案时变成一条悄悄过期的副本（旧口径残留）。
    userMessage('【project-flow】本轮还没有 working 心跳。', at),
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
  const at = recentStamp(-2000)
  const first = userMessage('第一句', at)
  const batchA = [first]
  const second = userMessage('第二句', recentStamp(-1000))
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
    userMessage('自动任务甲', recentStamp(-4000)),
    userMessage('自动任务乙', recentStamp(-3000)),
  ])
  await turnStopping(harness, agent)
  await preStep(harness, agent, [
    userMessage('自动任务丙', recentStamp(-2000)),
    userMessage('自动任务丁', recentStamp(-1000)),
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
  assert.deepEqual(
    status.team,
    { available: false, members: 0, tasks: 0, linked: 0, missing: 0, orphaned: 0 },
    'no Team service: available:false with zero counts (never a fake 0 without the flag)'
  )
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

test('开关与心跳：capture:false 只停捕获不停心跳；空台账也由插件开心跳（占位 goal、不建任务）；有栈顶取栈顶', async () => {
  // 7a capture:false —— pre-step/turn-stopping 不建任务；心跳生命周期与开关无关（task-81 ③）。
  const off = freshProject('switch-off')
  const offHarness = makeHarness(off.root, { capture: false })
  const offAgent = offHarness.addAgent('session-capture-off')
  // 放一条未完成任务在栈上：心跳应指向它，但捕获仍不得建任何新任务。
  const offTask = addTask(off.root, off.contract, { type: 'feat', title: '栈顶任务', scope: { allow: ['lib/capture.mjs'] } })
  await agentCreated(offHarness, offAgent)
  await preStep(offHarness, offAgent, [userMessage('开关关闭时不该建任务', recentStamp(-500))])
  await turnStopping(offHarness, offAgent)
  assert.equal(offHarness.handler('agent/created').length, 1, 'created 钩子仍在（心跳职责），只停捕获/权限职责')
  assert.equal(tasksOf(off.root, off.contract).length, 1, 'capture:false must not create tasks')
  const offFile = heartbeatFile(off.root, offAgent.id)
  assert.equal(fs.existsSync(offFile), true, 'capture:false must still auto-start the heartbeat (lifecycle is unconditional)')
  const offBeat = JSON.parse(fs.readFileSync(offFile, 'utf8'))
  assert.equal(offBeat.status, 'working')
  assert.equal(offBeat.task, offTask.id, 'a stack top exists, so the heartbeat points at it')
  const offStatus = await flowStatus(offHarness, offAgent, off.root)
  assert.equal(Object.hasOwn(offStatus, 'stack'), false, 'capture:false keeps the P0 flow_status shape')

  // 7b capture 开 + 空台账 —— 不是死路：插件开一条占位心跳，绝不造任务。
  const empty = freshProject('switch-empty')
  const emptyHarness = makeHarness(empty.root)
  const emptyAgent = emptyHarness.addAgent('session-capture-empty')
  await agentCreated(emptyHarness, emptyAgent)
  const emptyFile = heartbeatFile(empty.root, emptyAgent.id)
  assert.equal(fs.existsSync(emptyFile), true, 'an empty stack must still open a heartbeat (otherwise the session is stuck)')
  const emptyBeat = JSON.parse(fs.readFileSync(emptyFile, 'utf8'))
  assert.equal(emptyBeat.task, null, 'the placeholder heartbeat must not invent a task')
  assert.equal(emptyBeat.goal, '（台账暂无未完成任务）')
  assert.equal(tasksOf(empty.root, empty.contract).length, 0, 'opening a heartbeat must not create a task')
  assert.equal(
    emptyHarness.warns.some((line) => line.includes('auto-start skipped')),
    false,
    `empty stack is no longer a "skip", got ${JSON.stringify(emptyHarness.warns)}`,
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

// ------------------------------------------------ 缺陷 1：整句原文必须可回溯

test('缺陷 1：source.text 保存整句原文（title 仍截 120）；超 4000 显式标截断而不是静默丢', async () => {
  const { root, contract } = freshProject('full-text')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-capture-fulltext')
  const long = '长'.repeat(4500)
  const longAt = recentStamp(-1000)

  await preStep(harness, agent, [userMessage(long, longAt)])
  await turnStopping(harness, agent)
  const longTask = tasksOf(root, contract).find((task) => task.source && task.source.key === utteranceKey(longAt, long))
  assert.ok(longTask, 'the long sentence must become a task')
  assert.equal(longTask.title.length, 120, 'the title stays panel-sized')
  assert.ok(longTask.title.endsWith('…'), 'the title is explicitly clipped for display')
  assert.equal(longTask.source.text.length, SOURCE_TEXT_MAX + '…[truncated 500 chars]'.length)
  assert.ok(longTask.source.text.startsWith('长'.repeat(SOURCE_TEXT_MAX)), 'the first 4000 chars are kept verbatim')
  assert.ok(longTask.source.text.endsWith('…[truncated 500 chars]'), 'the overflow is marked explicitly, never dropped silently')

  const short = '短句逐字保留'
  const shortAt = recentStamp(-500)
  await preStep(harness, agent, [userMessage(short, shortAt)])
  await turnStopping(harness, agent)
  const shortTask = tasksOf(root, contract).find((task) => task.title === short)
  assert.ok(shortTask, 'the short sentence must become a task')
  assert.equal(shortTask.source.text, short, 'a short sentence is stored verbatim with no marker')
  assert.equal(shortTask.source.key, utteranceKey(shortAt, short))
})

// ---------------------------------------- 缺陷 2：恢复会话不得把历史当新任务

const historyStamp = () => new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
const historyMessage = () => userMessage('三天前的旧历史', historyStamp())

test('缺陷 2（①）：恢复会话重放的纯历史批不建任务', async () => {
  const { root, contract } = freshProject('history-only')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-capture-history')
  await preStep(harness, agent, [historyMessage()])
  await turnStopping(harness, agent)
  assert.equal(tasksOf(root, contract).length, 0, 'a batch made only of replayed history must create nothing')
})

test('缺陷 2（③）：历史不占栈顶——历史+新句只收新句，纯历史时栈为空', async () => {
  // 历史 + 新句：只建新句。
  const mixed = freshProject('history-mixed')
  const mixedHarness = makeHarness(mixed.root)
  const mixedAgent = mixedHarness.addAgent('session-capture-history')
  await preStep(mixedHarness, mixedAgent, [historyMessage(), userMessage('现在的新要求', recentStamp(-1000))])
  await turnStopping(mixedHarness, mixedAgent)
  const tasks = tasksOf(mixed.root, mixed.contract)
  assert.deepEqual(tasks.map((task) => task.title), ['现在的新要求'], 'only the fresh sentence becomes a task')
  assert.equal(tasks[0].source.text, '现在的新要求')
  const mixedStatus = await flowStatus(mixedHarness, mixedAgent, mixed.root)
  assert.equal(mixedStatus.stack[0].title, '现在的新要求', 'the stack top must be the newest real request, never replayed history')

  // 纯历史：栈必须是空的（历史连队列都不该进）。
  const only = freshProject('history-stack')
  const onlyHarness = makeHarness(only.root)
  const onlyAgent = onlyHarness.addAgent('session-capture-history')
  await preStep(onlyHarness, onlyAgent, [historyMessage()])
  await turnStopping(onlyHarness, onlyAgent)
  const onlyStatus = await flowStatus(onlyHarness, onlyAgent, only.root)
  assert.equal(onlyStatus.stack.length, 0, 'history must never occupy the task stack (and therefore never the stack top)')
})

// ------------------------------------------- 6 诊断：capture 不能把"没有"当"失败"

test('诊断①：payload.messages 为空数组 → skipped "no-messages"（不是 nothing-pending）', async () => {
  const { root } = freshProject('diag-no-messages')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-diag-nomsg')
  await preStep(harness, agent, [])
  await turnStopping(harness, agent)
  const status = await flowStatus(harness, agent, root)
  assert.equal(status.capture.skipped, 'no-messages')
  assert.equal(status.capture.messages, 0)
  assert.equal(status.capture.created, 0)
  assert.equal(status.capture.error, null)
})

test('诊断②：messages > 0 但全被排除 → skipped "filtered-out"', async () => {
  const { root } = freshProject('diag-filtered')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-diag-filtered')
  await preStep(harness, agent, [userMessage('【project-flow】这是插件自己注入的噪音', recentStamp(-3000))])
  await turnStopping(harness, agent)
  const status = await flowStatus(harness, agent, root)
  assert.equal(status.capture.messages, 1, 'the payload was seen')
  assert.equal(status.capture.created, 0)
  assert.equal(status.capture.skipped, 'filtered-out', 'all messages excluded is not "nothing to capture"')
})

test('诊断③：正常捕获 → skipped "ok"、created>0、lastAt 有值，心跳 last_action 带条数', async () => {
  const { root, contract } = freshProject('diag-ok')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-diag-ok')
  startHeartbeat(root, contract, { session: agent.id, goal: '观察捕获' })
  await preStep(harness, agent, [userMessage('这条应该被捕获', recentStamp(-2000))])
  await turnStopping(harness, agent)
  const status = await flowStatus(harness, agent, root)
  assert.equal(status.capture.skipped, 'ok')
  assert.equal(status.capture.created, 1)
  assert.equal(status.capture.messages, 1)
  assert.equal(typeof status.capture.lastAt, 'string')
  assert.equal(status.capture.error, null)
  const beat = JSON.parse(fs.readFileSync(heartbeatFile(root, agent.id), 'utf8'))
  assert.ok(String(beat.last_action).includes('本轮捕获 1 条'), `last_action: ${beat.last_action}`)
})

test('诊断④：空队列 flush → skipped "nothing-pending"', async () => {
  const { root } = freshProject('diag-empty')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-diag-empty')
  await turnStopping(harness, agent)
  const status = await flowStatus(harness, agent, root)
  assert.equal(status.capture.skipped, 'nothing-pending')
  assert.equal(status.capture.created, 0)
})

test('诊断⑤：flush 抛错 → skipped "flush-failed" + error 带函数名 + warn 一条', async () => {
  const { root } = freshProject('diag-fail')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-diag-fail')
  await preStep(harness, agent, [userMessage('会失败的一句', recentStamp(-1000))])
  // Removing the store makes the write fail for real (not a fake stub).
  fs.rmSync(path.join(root, '.dsh'), { recursive: true, force: true })
  await turnStopping(harness, agent)
  const state = createCaptureState() // unused sanity
  assert.ok(state)
  const status = await flowStatus(harness, agent, root)
  assert.equal(status.capture.skipped, 'flush-failed')
  assert.equal(typeof status.capture.error, 'string')
  assert.ok(status.capture.error.includes('captureTurnStop:') || status.capture.error.includes('flushCapture:'), status.capture.error)
  assert.ok(
    harness.warns.some((line) => line.includes('captureTurnStop:')),
    `expected a captureTurnStop warning, got ${JSON.stringify(harness.warns)}`
  )
})

test('诊断⑥：五道门/三条 pre-step 原因都能落进 skipped（表驱动）', () => {
  const gates = ['no-target', 'no-core', 'no-contract', 'nothing-pending', 'flush-failed', 'ok']
  for (const gate of gates) {
    const state = createCaptureState()
    noteCaptureGate(state, gate)
    assert.equal(captureSummary(state).skipped, gate, `gate ${gate}`)
  }
  const state = createCaptureState()
  assert.equal(captureSummary(state).skipped, null, 'a fresh state has no reason yet')
  const onError = []
  state.buckets.get = () => {
    throw new Error('boom')
  }
  const queued = recordPreStep(
    state,
    { root: '/x', session: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: recentStamp() }] },
    (error) => onError.push(String(error && error.message))
  )
  assert.equal(queued, 0)
  assert.equal(onError.length, 1, 'the warning callback must fire (never a silent 0)')
  assert.equal(captureSummary(state).skipped, 'pre-step-failed')
  assert.ok(captureSummary(state).error.includes('recordPreStep:'))
})

test('诊断⑦：capture 关闭时状态块 capture 为 null（不是 0）', () => {
  const block = buildStatusBlock({ listTasks }, '/tmp/none', {})
  assert.equal(block.capture, null)
  const state = createCaptureState()
  noteCaptureGate(state, 'ok', { created: 2 })
  const withState = buildStatusBlock({ listTasks }, '/tmp/none', {}, undefined, state)
  assert.deepEqual(withState.capture, {
    lastAt: captureSummary(state).lastAt,
    created: 2,
    pending: 0,
    messages: 0,
    skipped: 'ok',
    excludedBy: null,
    error: null,
  })
})

// --------------------------------------- 7 第四类排除：Agent Teams 队友消息（task-76）

test('排除 ④：content 以 "Team message from " 开头 → 不建任务，excludedBy="peer"', async () => {
  const { root, contract } = freshProject('rule-peer')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-rule-peer')
  const peer = 'Team message from exec-panel:\n**回归 2 完成**（两组都绿了）'
  await preStep(harness, agent, [userMessage(peer, recentStamp(-4000))])
  await turnStopping(harness, agent)
  assert.equal(tasksOf(root, contract).length, 0, 'a teammate report must not become a task')
  const status = await flowStatus(harness, agent, root)
  assert.equal(status.capture.excludedBy, 'peer')
  assert.equal(status.capture.skipped, 'filtered-out')
})

test('排除 ④边界："Team message fromX"（缺少前缀末尾空格）→ 仍捕获（不许过宽）', async () => {
  const { root, contract } = freshProject('rule-peer-tight')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-rule-peer-tight')
  const userText = 'Team message fromX 是用户自己写的一句话'
  await preStep(harness, agent, [userMessage(userText, recentStamp(-3000))])
  await turnStopping(harness, agent)
  const tasks = tasksOf(root, contract)
  assert.equal(tasks.length, 1, 'only the exact "Team message from " prefix is excluded')
  assert.equal(tasks[0].title, userText)
})

test('排除 ④不影响正常用户消息：普通一句仍捕获，excludedBy 为 null', async () => {
  const { root, contract } = freshProject('rule-peer-normal')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-rule-peer-normal')
  await preStep(harness, agent, [userMessage('把第四类排除规则加上', recentStamp(-2000))])
  await turnStopping(harness, agent)
  assert.equal(tasksOf(root, contract).length, 1)
  const status = await flowStatus(harness, agent, root)
  assert.equal(status.capture.excludedBy, null)
})

test('诊断 excludedBy：五类原因各自可取到（表驱动：sentinel/prefix/peer/stale/dup）', async () => {
  // 前三类由纯函数分类（消息本身决定）
  assert.equal(exclusionReasonOf('<flow-context>ctx</flow-context>'), 'sentinel')
  assert.equal(exclusionReasonOf('【project-flow】注入'), 'prefix')
  assert.equal(exclusionReasonOf('Team message from teammate: hi'), 'peer')
  assert.equal(exclusionReasonOf('普通用户消息'), null)
  assert.deepEqual([...PEER_MESSAGE_PREFIXES], ['Team message from '])

  // stale / dup 需要上一 step 的集合与挂载窗口，走 recordPreStep
  const { root } = freshProject('rule-excludedby-table')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-excludedby-table')
  // stale：时间戳早于挂载宽限窗口
  await preStep(harness, agent, [userMessage('很久以前的历史', recentStamp(-10 * 60 * 1000))])
  let status = await flowStatus(harness, agent, root)
  assert.equal(status.capture.excludedBy, 'stale')
  // dup：同一句在下一个 step 重放（上一 step 已记录 key）
  const again = userMessage('重复的一句', recentStamp(-1000))
  await preStep(harness, agent, [again])
  await preStep(harness, agent, [again])
  status = await flowStatus(harness, agent, root)
  assert.equal(status.capture.excludedBy, 'dup')
})
