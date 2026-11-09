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
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { apply } from '../index.js'
import { buildDefinition as buildTaskTool } from '../lib/tools/tasks.mjs'
import {
  addTask,
  endHeartbeat,
  getTask,
  listTasks,
  loadContract,
  initProject,
  releaseDeadSessionTasks,
  startHeartbeat,
  updateTask,
} from '../lib/core.mjs'
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
  utteranceKeyOf,
  attachmentsOfContent,
  attachmentTitle,
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
  assert.equal(task.owner, agent.id, 'capture attributes the task to its session (D-20261108-05)')
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
  fs.rmSync(path.join(root, '.agents'), { recursive: true, force: true })
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
  // 后台任务完成通知不是用户请求（真实台账里 5 张这种噪声卡）：按前缀排除。
  assert.equal(exclusionReasonOf('background job workflow-abc finished [status: completed]'), 'prefix')
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


// ------------------------- 8 捕获保真：附件落账与稳定消息身份（任务模块，2026-11-08）
//
// 真实宿主 `UserMessage` 是 `{id, role, content, source}`——有稳定 id、**没有**
// timestamp（见 @deepseek-ai/dsh-llm 的 message typings）。旧实现按
// `sha256(timestamp + '\0' + text)` 去重，在真实宿主里退化成"按文本去重"，
// 且把 screenshot 的消息压成纯文字。本节把这三件事各钉一条用例。

const HOST_IMAGE_1 = {
  attachmentId: 'sha256:2f0577569e309fce81e222d8ac7176efd6897df4cdbf77e2c3a71179801fcdea',
  mediaType: 'image/jpeg',
  bytes: 190348,
  width: 1265,
  height: 1769,
  name: '图片.png',
}
const HOST_IMAGE_2 = {
  attachmentId: 'sha256:1c976ac8fa5447361b63176781b5700fe4b7ac2a1077de2c26ca78a6d1bde4eb',
  mediaType: 'image/jpeg',
  bytes: 184989,
  width: 1257,
  height: 1657,
  name: '图片.png',
}

/** A real Host user message: stable `id`, no `timestamp`. */
const hostMessage = (id, content) => ({ id, role: 'user', content })
const imageBlock = (ref = {}, extra = {}) => ({ type: 'image', attachment: { ...HOST_IMAGE_1, ...ref }, ...extra })
const fileBlock = (ref = {}) => ({
  type: 'file',
  attachment: { attachmentId: 'sha256:5e6f7a8b9c0d1e2f', name: 'report.pdf', bytes: 1024, ...ref },
})
const sha256Of = (material) => createHash('sha256').update(material, 'utf8').digest('hex')

test('捕获保真①：图+文消息把附件引用写进 source.attachments，文字与 key 均按真实宿主形状', async () => {
  const { root, contract } = freshProject('attach-image-text')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-attach-image-text')
  const message = hostMessage('msg-host-1', [imageBlock(), imageBlock(HOST_IMAGE_2, { offloaded: true }), { type: 'text', text: '当前状态' }])

  await preStep(harness, agent, [message])
  await turnStopping(harness, agent)

  const tasks = tasksOf(root, contract)
  assert.equal(tasks.length, 1, 'a screenshot + caption is one task')
  const task = tasks[0]
  assert.equal(task.title, '当前状态')
  assert.equal(task.source.text, '当前状态', 'the caption is still stored verbatim')
  assert.deepEqual(
    task.source.attachments,
    [
      { kind: 'image', attachmentId: HOST_IMAGE_1.attachmentId, mediaType: 'image/jpeg', bytes: 190348, width: 1265, height: 1769, name: '图片.png' },
      { kind: 'image', attachmentId: HOST_IMAGE_2.attachmentId, mediaType: 'image/jpeg', bytes: 184989, width: 1257, height: 1657, name: '图片.png', offloaded: true },
    ],
    'source.attachments keeps the durable refs (never the bytes) and the offloaded marker',
  )
  // 独立重算期望 key：身份必须以稳定 id 为主料（不是真实宿主不存在的 timestamp）。
  assert.equal(
    task.source.key,
    sha256Of(['id', 'msg-host-1', '当前状态', HOST_IMAGE_1.attachmentId, HOST_IMAGE_2.attachmentId].join('\0')),
    'the key is derived from the message id + text + attachment ids',
  )
  assert.notEqual(task.source.key, utteranceKey('', '当前状态'), 'the legacy text-only key must not be used when an id exists')
})

test('捕获保真②：只有附件没有文字也建卡——source.text 保持空，title 说明附件', async () => {
  const { root, contract } = freshProject('attach-only')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-attach-only')
  const message = hostMessage('msg-host-2', [imageBlock()])

  await preStep(harness, agent, [message])
  await turnStopping(harness, agent)

  const tasks = tasksOf(root, contract)
  assert.equal(tasks.length, 1, 'an attachment-only message is still a user request')
  const task = tasks[0]
  assert.equal(task.source.text, '')
  assert.equal(task.title, '[附件] 图片 ×1')
  assert.equal(task.source.attachments.length, 1)
})

test('捕获保真③：图片+文件混合的消息 title 兜底分别计数', async () => {
  const { root, contract } = freshProject('attach-mixed')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-attach-mixed')
  const message = hostMessage('msg-host-3', [imageBlock(), imageBlock(HOST_IMAGE_2), fileBlock()])

  await preStep(harness, agent, [message])
  await turnStopping(harness, agent)

  const tasks = tasksOf(root, contract)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].title, '[附件] 图片 ×2、文件 ×1')
  assert.deepEqual(
    tasks[0].source.attachments.map((entry) => entry.kind),
    ['image', 'image', 'file'],
  )
  assert.deepEqual(tasks[0].source.attachments[2], {
    kind: 'file',
    attachmentId: 'sha256:5e6f7a8b9c0d1e2f',
    name: 'report.pdf',
    bytes: 1024,
  })
})

test('捕获保真④：同文不同消息（不同 id）是两条任务；旧实现按文本去重会吞掉一条', async () => {
  const { root, contract } = freshProject('attach-same-text')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-attach-same-text')

  await preStep(harness, agent, [
    hostMessage('msg-a', [{ type: 'text', text: '继续' }]),
    hostMessage('msg-b', [{ type: 'text', text: '继续' }]),
  ])
  await turnStopping(harness, agent)

  const tasks = tasksOf(root, contract)
  assert.equal(tasks.length, 2, 'two distinct messages with the same text must be two tasks')
  assert.deepEqual(
    tasks.map((task) => task.source.key).sort(),
    [sha256Of(['id', 'msg-a', '继续'].join('\0')), sha256Of(['id', 'msg-b', '继续'].join('\0'))].sort(),
  )
})

test('捕获保真⑤：同一条消息（同 id）重放不会重复建卡', async () => {
  const { root, contract } = freshProject('attach-replay')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-attach-replay')
  const message = hostMessage('msg-same', [{ type: 'text', text: '同一条消息' }])

  await preStep(harness, agent, [message])
  await turnStopping(harness, agent)
  assert.equal(tasksOf(root, contract).length, 1)

  await preStep(harness, agent, [message])
  await turnStopping(harness, agent)
  const status = await flowStatus(harness, agent, root)
  assert.equal(tasksOf(root, contract).length, 1, 'a replayed message keeps its identity')
  assert.equal(status.capture.excludedBy, 'dup')
})

test('捕获保真⑥：没有 id 的旧消息回落到 timestamp+text 的旧 key（兼容）', async () => {
  const { root, contract } = freshProject('attach-legacy')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-attach-legacy')
  const at = recentStamp(-500)

  await preStep(harness, agent, [{ role: 'user', content: [{ type: 'text', text: '旧消息' }], timestamp: at }])
  await turnStopping(harness, agent)

  const tasks = tasksOf(root, contract)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].source.key, utteranceKey(at, '旧消息'), 'messages without an id keep the legacy dedupe material')
  assert.equal(utteranceKeyOf({ timestamp: at }, '旧消息', []), utteranceKey(at, '旧消息'))
})

test('捕获保真⑦：畸形附件块被跳过（不抛、不写 0 值假数据），offloaded 保留', () => {
  const malformed = attachmentsOfContent([
    { type: 'image', attachment: { attachmentId: '', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    { type: 'image', attachment: { attachmentId: 'sha256:ok', mediaType: '', bytes: 1, width: 1, height: 1 } },
    { type: 'file', attachment: { attachmentId: 'sha256:f', name: '', bytes: 1 } },
    { type: 'image', attachment: { attachmentId: 'sha256:real', mediaType: 'image/jpeg', bytes: 10, width: 2, height: 2 } },
    { type: 'text', text: 'ignored' },
    { type: 'image' },
    null,
  ])
  assert.deepEqual(malformed, [
    { kind: 'image', attachmentId: 'sha256:real', mediaType: 'image/jpeg', bytes: 10, width: 2, height: 2 },
  ])
  assert.deepEqual(attachmentsOfContent('plain text'), [])
  assert.deepEqual(attachmentsOfContent(undefined), [])
  assert.equal(attachmentTitle([]), '[附件]')
  assert.equal(attachmentTitle([{ kind: 'image' }, { kind: 'image' }]), '[附件] 图片 ×2')
  assert.equal(attachmentTitle([{ kind: 'file' }]), '[附件] 文件 ×1')
})

test('捕获保真⑧：core 拒绝非法的 source.attachments（不静默写盘）', () => {
  const { root, contract } = freshProject('attach-invalid')
  const base = { type: 'chore', title: '非法附件', source: { kind: 'utterance', key: 'k', at: new Date().toISOString(), text: 'x' } }
  assert.throws(
    () => addTask(root, contract, { ...base, source: { ...base.source, attachments: [{ kind: 'image', attachmentId: '', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }] } }),
    /source\.attachments\[0\]\.attachmentId must be a non-empty string/,
  )
  assert.throws(
    () => addTask(root, contract, { ...base, source: { ...base.source, attachments: [{ kind: 'file', attachmentId: 'sha256:x', name: 'a.txt', bytes: -1 }] } }),
    /source\.attachments\[0\]\.bytes must be a non-negative integer/,
  )
  assert.throws(
    () => addTask(root, contract, { ...base, source: { ...base.source, attachments: 'nope' } }),
    /source\.attachments must be an array/,
  )
  // 合法形状可以落盘，并原样读回。
  const task = addTask(root, contract, {
    ...base,
    source: {
      ...base.source,
      attachments: [{ kind: 'file', attachmentId: 'sha256:f1', name: 'notes.txt', bytes: 7 }],
    },
  })
  assert.deepEqual(listTasks(root, contract).find((row) => row.id === task.id).source.attachments, [
    { kind: 'file', attachmentId: 'sha256:f1', name: 'notes.txt', bytes: 7 },
  ])
})


// ------------------------- 9 会话归属：owner 是任务的会话字段（D-20261108-05 extend-owner）
//
// 语义：捕获自动写 owner=会话 id；活跃会话的任务不能被其他会话改写/释放；
// 会话结束后 owner 自动释放为 ''（未指定），其他会话可再领取。

test('会话归属②：活跃会话的任务不能被其他会话领取或释放；本人释放后可被领取', async () => {
  const { root, contract } = freshProject('owner-guard')
  const harness = makeHarness(root)
  const agentA = harness.addAgent('session-owner-a')
  const agentB = harness.addAgent('session-owner-b')

  await preStep(harness, agentA, [userMessage('归属测试的一句话', recentStamp(-1000))])
  await turnStopping(harness, agentA)
  const task = tasksOf(root, contract)[0]
  assert.equal(task.owner, agentA.id, 'capture auto-fills owner with the capturing session')

  // The task tool is mounted by the `tasks` sub-plugin, not by `apply`; build it
  // against the same scoped ctx so the guard wiring (actor + agents probe) is
  // exercised here.
  const tool = buildTaskTool({ ctx: harness.ctx, toolRoot: () => root })
  await assert.rejects(
    () => tool.execute({ action: 'update', id: task.id, owner: agentB.id }, { agent: agentB }),
    /owned by active session/,
    'a live session\'s task must not be acquired by another session',
  )
  await assert.rejects(
    () => tool.execute({ action: 'update', id: task.id, owner: 'none' }, { agent: agentB }),
    /owned by active session/,
    'a live session\'s task must not be released by another session',
  )

  const released = await tool.execute({ action: 'update', id: task.id, owner: 'none' }, { agent: agentA })
  assert.equal(released.task.owner, '', 'the owner session can release its own task to "unassigned"')

  const acquired = await tool.execute({ action: 'update', id: task.id, owner: agentB.id }, { agent: agentB })
  assert.equal(acquired.task.owner, agentB.id, 'an unassigned task can be acquired by another session')
})

test('会话归属③：失效会话的 owner 自动释放为未指定；活跃会话/角色名/外主机保留', () => {
  const { root, contract } = freshProject('owner-sweep')
  const liveTask = addTask(root, contract, { type: 'chore', title: '活跃会话的任务', owner: 'live-session' })
  const endedTask = addTask(root, contract, { type: 'chore', title: '已结束会话的任务', owner: 'ended-session' })
  const roleTask = addTask(root, contract, { type: 'chore', title: '角色名不是会话', owner: 'lead' })

  startHeartbeat(root, contract, { session: 'live-session', goal: '还在工作', createTask: false })
  startHeartbeat(root, contract, { session: 'ended-session', goal: '已经结束', createTask: false })
  endHeartbeat(root, contract, { session: 'ended-session', status: 'done', note: '会话结束' })

  const result = releaseDeadSessionTasks(root, contract, {
    isSessionLive: (session) => session === 'live-session',
  })
  assert.deepEqual(result.released.map((row) => row.id), [endedTask.id], 'only the ended session is released')
  assert.equal(getTask(root, contract, endedTask.id).owner, '', 'the ended task becomes unassigned')
  assert.equal(getTask(root, contract, liveTask.id).owner, 'live-session', 'a live session keeps its task')
  assert.equal(getTask(root, contract, roleTask.id).owner, 'lead', 'a role name is not a session and is kept')

  // dryRun 只报告不写盘
  const again = releaseDeadSessionTasks(root, contract, { dryRun: true })
  assert.deepEqual(again.released, [], 'nothing left to release after the first sweep')
})

test('会话归属④：owner 可更新为未指定（none/null），领取只能落到调用会话', () => {
  const { root, contract } = freshProject('owner-update')
  const task = addTask(root, contract, { type: 'chore', title: '待领取' })

  assert.throws(
    () => updateTask(root, contract, task.id, { owner: 'other-session' }, { actorSession: 'my-session' }),
    /owner can only be the calling session/,
  )
  const acquired = updateTask(root, contract, task.id, { owner: 'my-session' }, { actorSession: 'my-session' })
  assert.equal(acquired.owner, 'my-session')

  const releasedNone = updateTask(root, contract, task.id, { owner: 'none' }, { actorSession: 'my-session' })
  assert.equal(releasedNone.owner, '', '"none" releases to unassigned')
  const acquiredAgain = updateTask(root, contract, task.id, { owner: 'my-session' }, { actorSession: 'my-session' })
  assert.equal(acquiredAgain.owner, 'my-session')
  const releasedNull = updateTask(root, contract, task.id, { owner: null }, {})
  assert.equal(releasedNull.owner, '', '"null" releases to unassigned')

  // 活跃会话保护：证明 live 后别人改不动
  const claimed = updateTask(root, contract, task.id, { owner: 'live-session' }, {})
  assert.equal(claimed.owner, 'live-session')
  assert.throws(
    () =>
      updateTask(root, contract, task.id, { owner: 'my-session' }, {
        actorSession: 'my-session',
        isSessionLive: (session) => session === 'live-session',
      }),
    /owned by active session/,
  )
})

test('消息卡收口：turn-stopping 捕获新卡时，自动完成过期且未领取的旧捕获卡', async () => {
  const { root, contract } = freshProject('utterance-sweep')
  const oldAt = new Date(Date.now() - 30 * 3_600_000).toISOString()
  const old = addTask(root, contract, {
    type: 'chore',
    title: '30 小时前的消息卡',
    stage: 'queued-analysis',
    source: { kind: 'utterance', key: 'old-utterance-key', at: oldAt, text: '30 小时前的消息卡' },
  })
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-utterance-sweep')
  await preStep(harness, agent, [userMessage('新的一句话', recentStamp(-1000))])
  await turnStopping(harness, agent)

  const oldStored = getTask(root, contract, old.id)
  assert.equal(oldStored.stage, 'done', '过期未领取的旧卡应被自动收口')
  assert.match(String(oldStored.notes), /\[auto-close\]/)
  const created = tasksOf(root, contract).filter((task) => task.stage === 'queued-analysis')
  assert.equal(created.length, 1, '新捕获的卡留在待分析（本轮自己的卡不收）')
})

test('消息卡收口：config.tasks.autoSweepHours=0 关闭自动收口', async () => {
  const { root, contract } = freshProject('utterance-sweep-off')
  const oldAt = new Date(Date.now() - 30 * 3_600_000).toISOString()
  const old = addTask(root, contract, {
    type: 'chore',
    title: '旧消息卡（关闭开关）',
    stage: 'queued-analysis',
    source: { kind: 'utterance', key: 'old-utterance-key-off', at: oldAt, text: '旧消息卡（关闭开关）' },
  })
  const harness = makeHarness(root, { tasks: { autoSweepHours: 0 } })
  const agent = harness.addAgent('session-utterance-sweep-off')
  await preStep(harness, agent, [userMessage('另一句话', recentStamp(-1000))])
  await turnStopping(harness, agent)
  assert.equal(getTask(root, contract, old.id).stage, 'queued-analysis', '关闭后不得动旧卡')
})

test('捕获来源记分支：git 仓库里 source.branch = 当前分支，非 git 目录不写该键', async () => {
  const { root: gitRoot, contract: gitContract } = freshProject('branch-source')
  spawnSync('git', ['-C', gitRoot, 'init', '-b', 'capture-branch'], { encoding: 'utf8' })
  const gitHarness = makeHarness(gitRoot)
  const gitAgent = gitHarness.addAgent('session-branch-source')
  await preStep(gitHarness, gitAgent, [userMessage('在分支上说的话', recentStamp(-1000))])
  await turnStopping(gitHarness, gitAgent)
  const captured = tasksOf(gitRoot, gitContract).find((task) => task.source && task.source.kind === 'utterance')
  assert.ok(captured, '应捕获一张卡')
  assert.equal(captured.source.branch, 'capture-branch', 'source.branch 记录捕获时所在分支')

  const { root, contract } = freshProject('branch-source-plain')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-branch-source-plain')
  await preStep(harness, agent, [userMessage('不在 git 仓库里', recentStamp(-1000))])
  await turnStopping(harness, agent)
  const plain = tasksOf(root, contract).find((task) => task.source && task.source.kind === 'utterance')
  assert.ok(plain)
  assert.equal(Object.hasOwn(plain.source, 'branch'), false, '非 git 目录不写 branch 键')
})
