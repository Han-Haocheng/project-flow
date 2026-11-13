// task-47：`agent/turn-stopping`（serial）心跳保活。
//
// 故障：长 turn 里心跳 `updated_at` 不再新鲜 → `heartbeatStatus` 判 stale/dead →
// `heartbeatGuardReason` 误拦 `edit`/`write`。保活只刷新**已存在且属于本会话的
// working 心跳**的 `updated_at`：不新建、不写语义字段、绝不 steer、异常全吞。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { addTask, heartbeatStatus, initProject, listTasks, loadContract, startHeartbeat, updateHeartbeat } from '../lib/core.mjs'
import {
  bootstrapHeartbeatSupply,
  captureLateMountStart,
  describeHeartbeatSupply,
  heartbeatGuardReason,
  heartbeatTarget,
} from '../lib/host/session.mjs'
import { processHeartbeatSession } from '../lib/heartbeats/records.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const TEMP_ROOTS = []

// ---------------------------------------------------------------- fake host

/**
 * One host double: the `agents` registry (so `rootSessionVerdict` /
 * `sessionIsLive` see a live root), a `webServer` for the three routes, and an
 * event bus that records every `ctx.on(name, handler)` + `ctx.effect` disposer.
 */
function makeHarness() {
  const handlers = new Map()
  const effects = []
  const live = new Map()
  const rootIds = new Set()
  const warns = []
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
  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'agents') return agents
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
  return {
    ctx,
    handlers,
    warns,
    live,
    rootIds,
    addAgent(id, root) {
      const agent = {
        id,
        session: { cwd: root, header: { origin: 'main' } },
        steerCalls: 0,
        steer() {
          this.steerCalls += 1
        },
      }
      live.set(id, agent)
      rootIds.add(id)
      return agent
    },
    /** A live agent the registry does **not** list as a root: a real subagent. */
    addSubAgent(id, root) {
      const agent = { id, session: { cwd: root, header: { origin: 'subagent' } } }
      live.set(id, agent)
      return agent
    },
    turnStopping() {
      const set = handlers.get('agent/turn-stopping')
      return set === undefined ? [] : [...set]
    },
    preStep() {
      const set = handlers.get('agent/pre-step')
      return set === undefined ? [] : [...set]
    },
    disposeAll() {
      for (const dispose of effects.splice(0)) {
        try {
          dispose()
        } catch {
          // test cleanup is best effort
        }
      }
    },
  }
}

async function dispatch(harness, payload) {
  const listeners = harness.turnStopping()
  assert.equal(listeners.length, 1, `expected exactly one turn-stopping listener, got ${listeners.length}`)
  // `doesNotReject` is the contract: a serial listener must never reject into the host.
  await assert.doesNotReject(async () => listeners[0](payload))
}

// --------------------------------------------------------------- fixtures

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t47-keepalive-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t47-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

function heartbeatFile(root, session) {
  return path.join(root, '.agents', 'heartbeat', `${session}.json`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** Minimal host context: a workspace root plus an optional agents registry. */
function supplyCtx(root, agents) {
  return {
    get(name) {
      if (name === 'workingDirectory') return { get: () => root }
      if (name === 'agents') return agents
      return undefined
    },
    logger: { warn() {} },
  }
}

/** Create a working heartbeat, then age it so a refresh is observable. */
function seedHeartbeat(root, contract, session, { status = 'working', ageMs = 2 * 60 * 60 * 1000 } = {}) {
  startHeartbeat(root, contract, { session, goal: '长 turn 保活测试', createTask: false })
  const file = heartbeatFile(root, session)
  const record = readJson(file)
  record.status = status
  record.updated_at = new Date(Date.now() - ageMs).toISOString()
  fs.writeFileSync(file, JSON.stringify(record))
  return file
}

/** Drop the pid evidence so liveness falls back to the 6 h freshness window. */
function hidePidEvidence(file) {
  const record = readJson(file)
  delete record.pid
  delete record.pid_start
  fs.writeFileSync(file, JSON.stringify(record))
  return record
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort()
}

// ---------------------------------------------------------------- one mount

const harness = makeHarness()
before(() => {
  apply(harness.ctx, {})
  assert.equal(harness.turnStopping().length, 1, 'apply must register one agent/turn-stopping listener')
})

after(() => {
  harness.disposeAll()
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

// ------------------------------------------------------------------ tests

test('保活只刷新 updated_at：语义字段一个字节都不变，且绝不 steer', async () => {
  const { root, contract } = freshProject('refresh')
  const session = 'session-keepalive-refresh'
  const file = seedHeartbeat(root, contract, session)
  const agent = harness.addAgent(session, root)
  const before = readJson(file)

  await dispatch(harness, { agent, turn: 3, signal: { aborted: false } })

  const after = readJson(file)
  assert.deepEqual(changedKeys(before, after), ['updated_at'], `only updated_at may change, got ${changedKeys(before, after)}`)
  assert.ok(Date.parse(after.updated_at) > Date.parse(before.updated_at), 'updated_at must move forward')
  // 语义字段逐条钉死（禁止写清单）。
  for (const key of ['status', 'goal', 'task', 'claims', 'turn', 'stats', 'started_at', 'last_action', 'session', 'agent', 'schema']) {
    assert.deepEqual(after[key], before[key], `${key} must stay byte-identical`)
  }
  assert.equal(typeof after.notes, 'undefined', 'a heartbeat record has no notes field to write')
  assert.equal(agent.steerCalls, 0, 'the listener must never call agent.steer()')
  assert.equal(harness.warns.filter((line) => line.includes('heartbeat keepalive')).length, 0, 'a successful keepalive is silent')
})

test('长 turn 的 stale 心跳被宿主 live 证据救活：刷新后 updated_at 新鲜、active 恢复', async () => {
  const { root, contract } = freshProject('stale')
  const session = 'session-keepalive-stale'
  const file = seedHeartbeat(root, contract, session, { ageMs: 7 * DAY_MS })
  hidePidEvidence(file)
  const agent = harness.addAgent(session, root)
  const before = readJson(file)
  assert.equal(heartbeatStatus(root, contract, session).active, false, 'fixture must start stale (no pid evidence, >7 days old)')

  await dispatch(harness, { agent, turn: 4, signal: { aborted: false } })

  const status = heartbeatStatus(root, contract, session)
  const after = readJson(file)
  assert.equal(status.active, true, 'the keepalive must restore an active verdict for a live session')
  assert.ok(status.ageSeconds !== null && status.ageSeconds < 60, `updated_at must be fresh, age=${status.ageSeconds}s`)
  assert.ok(Date.parse(after.updated_at) > Date.parse(before.updated_at))
  for (const key of ['status', 'goal', 'task', 'claims', 'turn', 'stats']) {
    assert.deepEqual(after[key], before[key], `${key} must stay byte-identical`)
  }
})

test('不新建：本会话没有心跳时什么也不写，也不碰别人的心跳', async () => {
  const { root, contract } = freshProject('nocreate')
  const mine = 'session-keepalive-mine'
  const other = 'session-keepalive-other'
  const otherFile = seedHeartbeat(root, contract, other)
  const otherBytes = fs.readFileSync(otherFile)
  const otherMtime = fs.statSync(otherFile).mtimeMs
  const agent = harness.addAgent(mine, root)

  await dispatch(harness, { agent, turn: 1, signal: { aborted: false } })

  assert.equal(fs.existsSync(heartbeatFile(root, mine)), false, 'a missing heartbeat must not be created')
  assert.deepEqual(fs.readFileSync(otherFile), otherBytes, "another session's heartbeat must not be rewritten")
  assert.equal(fs.statSync(otherFile).mtimeMs, otherMtime, "another session's heartbeat must not be touched")
  assert.deepEqual(readJson(otherFile).updated_at, JSON.parse(otherBytes.toString('utf8')).updated_at)
})

test('归属：payload 指向本会话时，只有本会话的心跳被刷新', async () => {
  const { root, contract } = freshProject('ownership')
  const mine = 'session-keepalive-owner'
  const other = 'session-keepalive-bystander'
  const mineFile = seedHeartbeat(root, contract, mine)
  const otherFile = seedHeartbeat(root, contract, other)
  const agent = harness.addAgent(mine, root)
  const otherBefore = readJson(otherFile)
  const mineBefore = readJson(mineFile)

  await dispatch(harness, { agent, turn: 2, signal: { aborted: false } })

  assert.ok(Date.parse(readJson(mineFile).updated_at) > Date.parse(mineBefore.updated_at), 'my heartbeat must be refreshed')
  assert.deepEqual(readJson(otherFile), otherBefore, "the bystander's heartbeat must stay byte-identical")
})

test('只保活 working 心跳：idle / 缺 agent / 不安全 session 都直接返回', async () => {
  const { root, contract } = freshProject('working-only')
  const idleSession = 'session-keepalive-idle'
  const idleFile = seedHeartbeat(root, contract, idleSession, { status: 'idle' })
  const idleBefore = readJson(idleFile)
  const idleAgent = harness.addAgent(idleSession, root)

  await dispatch(harness, { agent: idleAgent, turn: 1, signal: { aborted: false } })
  assert.deepEqual(readJson(idleFile), idleBefore, 'a non-working heartbeat must not be kept alive')

  // No agent / hostile session id: the listener returns silently (never throws)
  // and the heartbeat directory is left exactly as it was.
  const dir = path.join(root, '.agents', 'heartbeat')
  const listing = fs.readdirSync(dir).sort()
  await dispatch(harness, { turn: 1, signal: { aborted: false } })
  await dispatch(harness, { agent: { id: '../escape', session: { cwd: root } }, turn: 1, signal: { aborted: false } })
  assert.deepEqual(fs.readdirSync(dir).sort(), listing, 'no file may be created for a missing/unsafe session')
  assert.deepEqual(readJson(idleFile), idleBefore)
})

test('异常不冒泡：锁冲突只留一条警告、不重试、不改文件；锁清掉后恢复', async () => {
  const { root, contract } = freshProject('lock')
  const session = 'session-keepalive-locked'
  const file = seedHeartbeat(root, contract, session)
  const agent = harness.addAgent(session, root)
  const before = readJson(file)
  const warnCount = harness.warns.length

  // Hold the store lock with this live pid: `withLock` conflicts immediately.
  const lockPath = path.join(root, '.agents', 'flow', '.lock')
  fs.writeFileSync(lockPath, JSON.stringify({ schema: 1, pid: process.pid, at: new Date().toISOString() }))
  try {
    await dispatch(harness, { agent, turn: 5, signal: { aborted: false } })
  } finally {
    fs.unlinkSync(lockPath)
  }

  const keepaliveWarns = harness.warns.slice(warnCount).filter((line) => line.includes('heartbeat keepalive'))
  assert.equal(keepaliveWarns.length, 1, `a lock conflict is one warning (no retry), got ${keepaliveWarns.length}`)
  assert.ok(keepaliveWarns[0].includes('heartbeat keepalive skipped'), `unexpected warning: ${keepaliveWarns[0]}`)
  assert.deepEqual(readJson(file), before, 'a failed keepalive must leave the file untouched')

  // Recovered: the next turn refreshes normally.
  await dispatch(harness, { agent, turn: 6, signal: { aborted: false } })
  assert.ok(Date.parse(readJson(file).updated_at) > Date.parse(before.updated_at), 'the next turn must refresh again')
})

test('已 abort 的 turn 不写盘', async () => {
  const { root, contract } = freshProject('abort')
  const session = 'session-keepalive-abort'
  const file = seedHeartbeat(root, contract, session)
  const agent = harness.addAgent(session, root)
  const before = readJson(file)

  await dispatch(harness, { agent, turn: 7, signal: { aborted: true } })
  assert.deepEqual(readJson(file), before, 'an aborted signal must not write')

  await dispatch(harness, { agent, turn: 7, signal: { aborted: false } })
  assert.ok(Date.parse(readJson(file).updated_at) > Date.parse(before.updated_at), 'a live signal still refreshes')
})

test('用 ctx.effect 注册并可 dispose：卸载后监听器从宿主事件面移除', () => {
  const local = makeHarness()
  local.addAgent('session-keepalive-dispose', freshProject('dispose').root)
  apply(local.ctx, {})
  assert.equal(local.turnStopping().length, 1, 'apply must register the listener')
  local.disposeAll()
  assert.equal(local.turnStopping().length, 0, 'dispose must unregister the listener')
})

test('源码兜底：保活实现里没有 agent.steer( 调用', () => {
  const source = fs.readFileSync(new URL('../lib/host/session.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function heartbeatKeepalive(')
  assert.ok(start > 0, 'heartbeatKeepalive must exist in lib/host/session.mjs')
  const end = source.indexOf('function registerHeartbeatKeepalive(', start)
  assert.ok(end > start, 'registerHeartbeatKeepalive must follow it')
  assert.equal(source.slice(start, end).includes('steer('), false, 'turn-stopping must never steer the agent')
})

// ========== T-20261111155603-02：插件挂载前创建的会话，pre-step 幂等补登记 ==========
//
// 缺陷：会话在插件挂载**之前**创建 → `agent/created` 漏跑 → 没有心跳文件 →
// 写文件被心跳门禁挡住，提示"先 flow_heartbeat update"，而 `flow_heartbeat update`
// 对缺失记录返回 `not-found`；唯一出路是人工跑 `flow heartbeat start`。
//
// 修法：`agent/pre-step`（主会话每轮第一步）幂等补登记——无记录且确认主会话才
// `startHeartbeat`（沿用 `agent/created` 的入参与空栈占位 goal 语义）；已有记录
// 完全跳过（不得重置 turn/stats/started_at）；失败只记 mount warning、不打断本轮。
// 同时 `update` 对缺失记录的文案给出可执行的恢复命令。

/** One `agent/pre-step` waterfall dispatch with a minimal enter decision. */
async function dispatchPreStep(agent, payload = {}, h = harness) {
  const listeners = h.preStep()
  assert.equal(listeners.length, 1, `expected exactly one pre-step listener, got ${listeners.length}`)
  let nextCalls = 0
  const next = async () => {
    nextCalls += 1
    return { kind: 'enter' }
  }
  const decision = await listeners[0](
    { agent, step: 0, turn: 1, messages: [], ...payload },
    next,
  )
  assert.equal(nextCalls, 1, 'waterfall 必须先调用 next()')
  return decision
}

const beatExists = (root, session) => fs.existsSync(heartbeatFile(root, session))

/** Warnings this backfill owns (the shared harness may carry unrelated mount warns). */
const backfillWarns = (since = 0, h = harness) =>
  h.warns.slice(since).filter((line) => String(line).includes('late-mount backfill'))

test('T1111-① 挂载前创建的主会话：一次 pre-step 后自动补登记（栈顶 goal/task）', async () => {
  const { root, contract } = freshProject('late-main')
  const agent = harness.addAgent('session-late-main', root)
  const task = addTask(root, contract, { type: 'feat', title: '挂载后补登记' })
  const warnCount = harness.warns.length

  assert.equal(beatExists(root, 'session-late-main'), false, '夹具前提：创建时插件还没挂载，没有心跳')

  const decision = await dispatchPreStep(agent)
  assert.equal(decision.kind, 'enter', '补登记不得改变 pre-step 的 decision')

  const beat = readJson(heartbeatFile(root, 'session-late-main'))
  assert.equal(beat.session, 'session-late-main')
  assert.equal(beat.status, 'working', '补登记必须落在可写的 working 状态')
  assert.equal(beat.task, task.id, '沿用 captureAutoStart：栈顶任务进心跳')
  assert.equal(beat.goal, '挂载后补登记')
  assert.deepEqual(beat.claims, [], '无 scope 的任务不虚报 claims')
  assert.equal(beat.turn, 1)
  assert.equal(beat.stats.turns, 1)
  assert.match(String(beat.started_at), /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(backfillWarns(warnCount), [], '补登记是正常路径，不得 warn')
})

test('T1111-①b 空台账补登记：占位 goal + task:null，不凭空造任务', async () => {
  const { root, contract } = freshProject('late-empty')
  const agent = harness.addAgent('session-late-empty', root)
  const warnCount = harness.warns.length
  const before = listTasks(root, contract).length

  await dispatchPreStep(agent)
  const beat = readJson(heartbeatFile(root, 'session-late-empty'))
  assert.equal(beat.status, 'working')
  assert.equal(beat.task, null, '空栈不得凭空指向一条任务')
  assert.equal(beat.goal, '（台账暂无未完成任务）')
  assert.equal(listTasks(root, contract).length, before, '补登记不得顺手造任务')
  assert.deepEqual(backfillWarns(warnCount), [])
})

test('T1111-② 已有心跳：pre-step 完全跳过，started_at / turn / stats 一律不变', async () => {
  const { root, contract } = freshProject('late-already')
  const agent = harness.addAgent('session-late-already', root)
  const task = addTask(root, contract, { type: 'feat', title: '已登记任务' })
  const warnCount = harness.warns.length

  // 模拟挂载后已登记、且已跑过若干轮：turn=3、stats.turns=3。
  startHeartbeat(root, contract, {
    session: 'session-late-already',
    goal: '已登记任务',
    task: task.id,
    turn: 3,
    status: 'working',
  })
  const before = readJson(heartbeatFile(root, 'session-late-already'))
  assert.equal(before.turn, 3)
  assert.equal(before.stats.turns, 3)

  await dispatchPreStep(agent)
  await dispatchPreStep(agent, { turn: 2, step: 1 })

  const afterBeat = readJson(heartbeatFile(root, 'session-late-already'))
  assert.deepEqual(afterBeat, before, '已有记录必须完全跳过：补登记不得重置任何字段')
  assert.equal(afterBeat.started_at, before.started_at)
  assert.equal(afterBeat.turn, before.turn)
  assert.deepEqual(afterBeat.stats, before.stats)
  assert.deepEqual(backfillWarns(warnCount), [])
})

test('T1111-②b 已关闭（done）的心跳也跳过：不在 pre-step 里复活它', async () => {
  const { root, contract } = freshProject('late-done')
  const agent = harness.addAgent('session-late-done', root)
  const task = addTask(root, contract, { type: 'chore', title: '已关闭' })
  const warnCount = harness.warns.length

  startHeartbeat(root, contract, { session: 'session-late-done', goal: '已关闭', task: task.id })
  updateHeartbeat(root, contract, 'session-late-done', { status: 'done' })
  const file = heartbeatFile(root, 'session-late-done')
  const rawBefore = fs.readFileSync(file, 'utf8')

  await dispatchPreStep(agent)
  assert.equal(fs.readFileSync(file, 'utf8'), rawBefore, '任何已有记录（含 done）都不得被补登记改写')
  assert.deepEqual(backfillWarns(warnCount), [])
})

test('T1111-③ 子代理与后台任务会话前缀（mnemon-task-/bg-task-/task-subagent-）不补登记', async () => {
  const { root } = freshProject('late-synthetic')
  const warnCount = harness.warns.length

  const sub = harness.addSubAgent('session-late-sub', root)
  const mnemon = harness.addAgent('mnemon-task-late-1', root)
  const bg = harness.addAgent('bg-task-late-1', root)
  const taskSub = harness.addAgent('task-subagent-late-1', root)

  for (const agent of [sub, mnemon, bg, taskSub]) {
    await dispatchPreStep(agent)
  }
  for (const id of ['session-late-sub', 'mnemon-task-late-1', 'bg-task-late-1', 'task-subagent-late-1']) {
    assert.equal(beatExists(root, id), false, `${id} 不得获得心跳（否则面板会多出不存在的行）`)
  }

  // 对照：同一次挂载下的普通主会话仍会补登记——排除只来自判定口径，不是把补登记关了。
  const control = harness.addAgent('session-late-control', root)
  await dispatchPreStep(control)
  assert.equal(beatExists(root, 'session-late-control'), true)
  assert.deepEqual(backfillWarns(warnCount), [])
})

test('T1111-④ 补登记前 write/edit 被门禁挡住；补登记后放行（read 一直放行）', async () => {
  const { root } = freshProject('late-gate')
  const agent = harness.addAgent('session-late-gate', root)
  const warnCount = harness.warns.length

  const deniedBefore = heartbeatGuardReason(harness.ctx, { name: 'write', agent })
  assert.equal(typeof deniedBefore, 'string', '夹具前提：无心跳时写门禁必须真的拦住')
  // 完全没有记录时的文案必须是**活路**：下一轮 pre-step 自动补登记 + CLI start，
  // 而不是指向 `flow_heartbeat update`（它对缺失记录只能报 not-found）。
  assert.match(deniedBefore, /agent\/pre-step/)
  assert.match(deniedBefore, new RegExp(`flow heartbeat start --session session-late-gate`))
  assert.equal(deniedBefore.includes('flow_heartbeat update'), false, '无记录时不得指向 update（死路）')
  assert.equal(typeof heartbeatGuardReason(harness.ctx, { name: 'edit', agent }), 'string')
  assert.equal(heartbeatGuardReason(harness.ctx, { name: 'read', agent }), undefined, '非写工具不受心跳门禁影响')
  assert.equal(beatExists(root, 'session-late-gate'), false, '门禁只报错，不得替会话开记录')

  await dispatchPreStep(agent)

  assert.equal(beatExists(root, 'session-late-gate'), true, 'pre-step 必须先补上心跳')
  assert.equal(heartbeatGuardReason(harness.ctx, { name: 'write', agent }), undefined, '补登记后 write 必须放行')
  assert.equal(heartbeatGuardReason(harness.ctx, { name: 'edit', agent }), undefined, '补登记后 edit 必须放行')
  assert.equal(heartbeatGuardReason(harness.ctx, { name: 'read', agent }), undefined, 'read 一直放行')
  assert.deepEqual(backfillWarns(warnCount), [])
})

test('T1111-④b 有记录但不 working（idle/done）：文案指向 flow_heartbeat update，且照做后门禁放行', async () => {
  const { root, contract } = freshProject('late-gate-idle')
  const session = 'session-late-gate-idle'
  const agent = harness.addAgent(session, root)
  startHeartbeat(root, contract, { session, goal: '已登记但空闲', createTask: false })
  updateHeartbeat(root, contract, session, { status: 'idle' })

  const reason = heartbeatGuardReason(harness.ctx, { name: 'write', agent })
  assert.equal(typeof reason, 'string', 'idle 心跳不得放行写入')
  // 记录存在 ⇒ update 是活路，不能用「没有心跳文件」那套文案。
  assert.match(reason, /flow_heartbeat update/)
  assert.equal(reason.includes('flow heartbeat start --session'), false, '有记录时不该让人从 CLI start 重开')
  assert.equal(reason.includes('没有心跳文件'), false, '文案不得谎称没有记录')

  // 文案可执行：照做 update 之后同一调用必须放行。
  updateHeartbeat(root, contract, session, { status: 'working' })
  assert.equal(heartbeatGuardReason(harness.ctx, { name: 'write', agent }), undefined, '按文案 update 后必须放行')
})

test('T1111-⑤ update 对缺失记录：仍是 not-found，但文案给出 flow heartbeat start --session <id>', () => {
  const { root, contract } = freshProject('late-message')
  const missing = 'session-late-missing'
  assert.throws(
    () => updateHeartbeat(root, contract, missing, { status: 'idle' }),
    (error) =>
      error.code === 'not-found' &&
      String(error.message).includes(`flow heartbeat start --session ${missing}`) &&
      String(error.message).includes('not found'),
  )
})

test('T1111-⑥ 幂等：补登记成功后，后续 pre-step 不重置 started_at / turn / stats', async () => {
  const { root } = freshProject('late-idempotent')
  const agent = harness.addAgent('session-late-idempotent', root)
  const warnCount = harness.warns.length

  await dispatchPreStep(agent)
  const afterFirst = readJson(heartbeatFile(root, 'session-late-idempotent'))
  assert.equal(afterFirst.turn, 1)

  // 模拟这一轮之后跑过若干轮（turn/stats 由 start/keepalive 递增），再让 pre-step
  // 经过一次：补登记若在第二轮被重跑，`turn` 会变成 2、`stats.turns` 会翻倍。
  const file = heartbeatFile(root, 'session-late-idempotent')
  const aged = { ...afterFirst, turn: 3, stats: { ...afterFirst.stats, turns: 3 } }
  fs.writeFileSync(file, JSON.stringify(aged))
  const before = readJson(file)

  await dispatchPreStep(agent, { turn: 2, step: 1 })
  const after = readJson(file)

  assert.equal(after.started_at, before.started_at, 'started_at 一旦写入就不得被重置')
  assert.equal(after.turn, before.turn, 'turn 不得被第二轮补登记推进')
  assert.deepEqual(after.stats, before.stats, 'stats 不得被第二轮补登记改写')
  assert.equal(after.status, 'working')
  assert.deepEqual(backfillWarns(warnCount), [], '幂等跳过是正常路径，不得 warn')
})

test('T1111-⑦ 补登记与捕获解耦：config.capture=false 时仍补登记', async () => {
  const local = makeHarness()
  const { root, contract } = freshProject('late-capture-off')
  const agent = local.addAgent('session-late-capture-off', root)
  // 捕获是显式 opt-in：这里显式关掉，补登记仍必须发生（否则关捕获=关可写）。
  apply(local.ctx, { capture: false })
  try {
    const decision = await dispatchPreStep(agent, {}, local)
    assert.equal(decision.kind, 'enter')
    const beat = readJson(heartbeatFile(root, 'session-late-capture-off'))
    assert.equal(beat.session, 'session-late-capture-off')
    assert.equal(beat.status, 'working', '捕获关闭不得连带关掉心跳补登记')
    assert.equal(listTasks(root, contract).length, 0, '捕获关掉时补登记同样不得造任务卡')
  } finally {
    local.disposeAll()
  }
})

test('T1111-⑧ 锁冲突只 warn 且不改变 decision；锁释放后下一轮重试成功', async () => {
  const { root } = freshProject('late-lock')
  const agent = harness.addAgent('session-late-lock', root)
  const warnCount = harness.warns.length
  const lockPath = path.join(root, '.agents', 'flow', '.lock')
  fs.writeFileSync(lockPath, JSON.stringify({ schema: 1, pid: process.pid, at: new Date().toISOString() }))
  let decision
  try {
    decision = await dispatchPreStep(agent)
  } finally {
    fs.unlinkSync(lockPath)
  }

  assert.equal(decision.kind, 'enter', '补登记失败不得改变本轮的 decision')
  assert.equal(beatExists(root, 'session-late-lock'), false, '拿不到锁时不得写出半截记录')
  const warns = backfillWarns(warnCount)
  assert.equal(warns.length, 1, `锁冲突只留一条 backfill warning，got ${warns.length}`)
  assert.ok(warns[0].includes('late-mount backfill skipped'), `unexpected warning: ${warns[0]}`)

  // 下一轮重试成功（补登记是幂等重试，不需要人工清理）。
  const retry = await dispatchPreStep(agent)
  assert.equal(retry.kind, 'enter')
  assert.equal(beatExists(root, 'session-late-lock'), true, '锁释放后下一轮必须补上心跳')
  assert.equal(readJson(heartbeatFile(root, 'session-late-lock')).status, 'working')
  assert.deepEqual(backfillWarns(warnCount).slice(1), [], '重试成功不再 warn')
})

test('T1111-⑨ 未初始化工作区 / 坏 session id：静默跳过，不写不 warn', async () => {
  // 未初始化：没有 .agents/flow/flow.json，既没有心跳文件也没有可写目标。
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-t47-keepalive-bare-'))
  TEMP_ROOTS.push(bare)
  const bareAgent = harness.addAgent('session-late-bare', bare)
  const bareWarn = harness.warns.length
  assert.doesNotThrow(() => captureLateMountStart(harness.ctx, { agent: bareAgent }))
  assert.equal(fs.existsSync(path.join(bare, '.agents')), false, '未初始化工作区不得被补登记创建目录')
  assert.deepEqual(backfillWarns(bareWarn), [], '未初始化不是异常：不得 warn')

  // 坏 session id：不可写文件名 → captureTarget 直接放弃。
  const { root } = freshProject('late-bad-id')
  const badAgent = harness.addAgent('../escape', root)
  const badWarn = harness.warns.length
  const dir = path.join(root, '.agents', 'heartbeat')
  // 心跳目录是惰性创建的：不存在本身就是"没写"的证据。
  const listing = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
  assert.doesNotThrow(() => captureLateMountStart(harness.ctx, { agent: badAgent }))
  const badDecision = await dispatchPreStep(badAgent)
  assert.equal(badDecision.kind, 'enter', '坏 session id 不得改变 decision')
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [], listing, '坏 session id 不得写出心跳文件')
  assert.deepEqual(backfillWarns(badWarn), [], '坏 session id 是静默跳过')
})

test('T1111-⑩ 环境无关供给：env-session / cli-process / 晚挂载扫描都能登记并被判活', () => {
  const saved = process.env.DSH_SESSION_ID
  try {
    const { root, contract } = freshProject('supply')
    const ctx = supplyCtx(root)

    // ① env-session：宿主 agent 没有 id，但进程知道 DSH_SESSION_ID。
    const envSession = 'session-supply-env'
    process.env.DSH_SESSION_ID = envSession
    const bareAgent = { id: '', session: { cwd: root, header: { origin: 'main' } } }
    const envTarget = heartbeatTarget(ctx, { agent: bareAgent })
    assert.equal(envTarget.session, envSession)
    assert.equal(envTarget.provenance, 'env-session')
    captureLateMountStart(ctx, { agent: bareAgent })
    const envStatus = heartbeatStatus(root, contract, envSession)
    assert.equal(envStatus.active, true, 'env-session 供给必须 active')
    assert.equal(envStatus.record.provenance, 'env-session')
    assert.equal(envStatus.liveness, 'live', '判活仍走 records 的 host/boot/pid 证据')

    // ② cli-process：既没有 agent id 也没有 DSH_SESSION_ID。
    delete process.env.DSH_SESSION_ID
    const processTarget = heartbeatTarget(ctx, {})
    assert.equal(processTarget.session, processHeartbeatSession())
    assert.match(processTarget.session, /^cli-[a-z0-9._-]+-\d+$/, 'cli 会话名必须带 host 段，避免 WSL/Windows 同名互覆')
    assert.equal(processTarget.provenance, 'cli-process')
    captureLateMountStart(ctx, {})
    const processStatus = heartbeatStatus(root, contract, processTarget.session)
    assert.equal(processStatus.active, true, 'cli-process 供给必须 active')
    assert.equal(processStatus.record.provenance, 'cli-process')
    assert.equal(processStatus.liveness, 'live')

    // ②b roots() 若把子代理记录当成"根"返回，也不得写幽灵行（verdict 校验）。
    const ghost = freshProject('supply-ghost')
    const ghostSub = { id: 'session-ghost-sub', session: { cwd: ghost.root, header: { origin: 'subagent', delegationDepth: 1 } } }
    const ghostAgents = { roots: () => [ghostSub], list: () => [ghostSub], get: () => ghostSub }
    bootstrapHeartbeatSupply(supplyCtx(ghost.root, ghostAgents))
    assert.equal(
      fs.existsSync(heartbeatFile(ghost.root, 'session-ghost-sub')),
      false,
      'roots() 返回子代理记录时不得补出心跳（契约禁止幽灵行）',
    )

    // ③ 插件晚于会话创建挂载：agents.roots() 已有会话但还没有记录 → 挂载扫描补开。
    const late = freshProject('supply-late')
    const lateAgent = { id: 'session-supply-late', session: { cwd: late.root, header: { origin: 'main' } } }
    const agents = {
      roots: () => [lateAgent],
      list: () => [lateAgent],
      get: (id) => (id === lateAgent.id ? lateAgent : undefined),
    }
    const lateCtx = supplyCtx(late.root, agents)
    assert.equal(heartbeatTarget(lateCtx, { agent: lateAgent }).provenance, 'host-session')
    bootstrapHeartbeatSupply(lateCtx)
    const lateStatus = heartbeatStatus(late.root, late.contract, lateAgent.id)
    assert.equal(lateStatus.active, true, '插件晚挂载也必须补出可判活心跳')
    assert.equal(lateStatus.record.provenance, 'host-session')

    const supply = describeHeartbeatSupply(lateCtx)
    assert.equal(supply.reason, 'active-heartbeats-present')
    assert.ok(supply.hostSessions.includes(lateAgent.id))
    assert.equal(supply.envSession, null)
    assert.equal(supply.active, 1)
  } finally {
    if (saved === undefined) delete process.env.DSH_SESSION_ID
    else process.env.DSH_SESSION_ID = saved
  }
})

test('T-20261113164820 guard 覆盖 env-session：无 agent id 也拦，补登记后放行', () => {
  const saved = process.env.DSH_SESSION_ID
  try {
    const { root, contract } = freshProject('guard-env')
    const envSession = 'session-guard-env'
    process.env.DSH_SESSION_ID = envSession
    const agent = { id: '', session: { cwd: root, header: { origin: 'main' } } }
    const agents = {
      roots: () => [agent],
      list: () => [agent],
      get: () => agent,
    }
    const ctx = supplyCtx(root, agents)

    // 旧实现：agent.id 为空 → 直接 return undefined（门禁形同虚设）。修复后按 env 会话拦。
    const reason = heartbeatGuardReason(ctx, { name: 'edit', agent })
    assert.equal(typeof reason, 'string', '有 DSH_SESSION_ID 的主会话必须被心跳门禁覆盖')
    assert.match(reason, /agent\/pre-step/)
    assert.match(reason, new RegExp('flow heartbeat start --session ' + envSession))
    assert.equal(heartbeatGuardReason(ctx, { name: 'read', agent }), undefined, '只读工具不拦')

    // 供给后同一调用放行（证明门禁与供给用的是同一个 env 会话）。
    captureLateMountStart(ctx, { agent })
    assert.equal(heartbeatStatus(root, contract, envSession).active, true)
    assert.equal(heartbeatGuardReason(ctx, { name: 'write', agent }), undefined, '补登记后必须放行')

    // execution.agent 完全缺失（PTC 形状）时，也必须按 DSH_SESSION_ID 拦。
    const bare = freshProject('guard-env-bare')
    process.env.DSH_SESSION_ID = 'session-guard-env-bare'
    const bareCtx = supplyCtx(bare.root)
    assert.equal(
      typeof heartbeatGuardReason(bareCtx, { name: 'edit' }),
      'string',
      'agent 缺失的主会话同样必须被心跳门禁覆盖',
    )
    captureLateMountStart(bareCtx, {})
    assert.equal(heartbeatStatus(bare.root, bare.contract, 'session-guard-env-bare').active, true)
    assert.equal(heartbeatGuardReason(bareCtx, { name: 'edit' }), undefined)

    // 端到端：默认 mount config 下 guard 必须真的注册并执行到 env 会话（不是只测纯函数）。
    let registeredGuard = null
    const toolsService = {
      register() {
        return () => {}
      },
      guard(check) {
        registeredGuard = check
        return () => {}
      },
    }
    const mountCtx = {
      get(name) {
        if (name === 'tools') return toolsService
        if (name === 'agents') return agents
        if (name === 'workingDirectory') return { get: () => root }
        return undefined
      },
      effect(fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      on() {
        return () => {}
      },
      logger: { warn() {} },
    }
    apply(mountCtx, {})
    assert.equal(typeof registeredGuard, 'function', '默认 config 必须注册 host guard')
    const mountAgent = { id: '', session: { cwd: root, header: { origin: 'main' } } }
    // 挂载扫描已按 DSH_SESSION_ID 补出可判活心跳 → 注册后的 guard 对同一会话放行。
    assert.equal(heartbeatStatus(root, contract, process.env.DSH_SESSION_ID).active, true, '挂载供给必须落到该 workspace')
    assert.equal(registeredGuard({ name: 'edit', agent: mountAgent }), undefined, '供给后 guard 必须放行 env-session')
  } finally {
    if (saved === undefined) delete process.env.DSH_SESSION_ID
    else process.env.DSH_SESSION_ID = saved
  }
})

test('T-20261113164820 挂载扫描：agents.roots() 只有无 id 会话时，env-session 仍被补开', () => {
  const saved = process.env.DSH_SESSION_ID
  try {
    const { root, contract } = freshProject('supply-env-late')
    const envSession = 'session-supply-env-late'
    process.env.DSH_SESSION_ID = envSession
    const agent = { id: '', session: { cwd: root, header: { origin: 'main' } } }
    const agents = { roots: () => [agent], list: () => [agent], get: () => agent }
    bootstrapHeartbeatSupply(supplyCtx(root, agents))
    const status = heartbeatStatus(root, contract, envSession)
    assert.equal(status.active, true, '有 DSH_SESSION_ID 就必须补出可判活心跳')
    assert.equal(status.record.provenance, 'env-session')
    assert.equal(status.liveness, 'live')
  } finally {
    if (saved === undefined) delete process.env.DSH_SESSION_ID
    else process.env.DSH_SESSION_ID = saved
  }
})
