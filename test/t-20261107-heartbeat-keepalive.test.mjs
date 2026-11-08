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
import { heartbeatStatus, initProject, loadContract, startHeartbeat } from '../lib/core.mjs'

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
    turnStopping() {
      const set = handlers.get('agent/turn-stopping')
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
  const lockPath = path.join(root, '.dsh', 'flow', '.lock')
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
