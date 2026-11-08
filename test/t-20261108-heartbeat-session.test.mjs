// 2026-11-08 心跳会话化：一条主会话一条心跳，标题用宿主会话标题，状态自动
// 维护（工作中 / 空闲 / 等待子会话），会话归档时删除记录。
//
// 判据分两层：
// - core：`title` 可写可投影，`waiting` 是合法状态，`removeHeartbeat` 幂等；
// - host：`agent/created` 用真实状态开记录，`agent/status`、`subagent/start|end`
//   推动状态，`session/event` 的 `session/title` 刷新标题，归档事件删除记录。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'
import {
  addTask,
  heartbeatStatus,
  initProject,
  loadContract,
  readHeartbeatSection,
  removeHeartbeat,
  startHeartbeat,
  updateHeartbeat,
} from '../lib/core.mjs'

const TEMP_ROOTS = []
const HARNESSES = []

after(() => {
  for (const harness of HARNESSES) {
    try {
      harness.dispose()
    } catch {
      // best effort
    }
  }
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

// ---------------------------------------------------------------- fake host

/**
 * A minimal Cordis host: the services this feature reads (`sessions`,
 * `sessionTitle`, `agents`, `workspaceRegistry`) plus the event bus. Every other
 * service lookup returns undefined, which the plugin must treat as "not
 * available" rather than an error.
 */
function makeHarness(root, options = {}) {
  const handlers = new Map()
  const effects = []
  const live = new Map()
  const rootIds = new Set()
  const sessions = new Map()
  const titles = new Map()
  const openTurns = new Set()
  const warns = []
  const tools = new Map()
  const agents = {
    list: () => [...live.values()],
    roots: () => [...live.entries()].filter(([id]) => rootIds.has(id)).map(([, agent]) => agent),
    get: (id) => live.get(id),
    turnBoundaryOf: (session) => {
      const id = session !== null && session !== undefined && typeof session.id === 'string' ? session.id : ''
      return {
        openTurnStartSeq: openTurns.has(id) ? 1 : null,
        lastStepStartSeq: null,
        lastStepBoundary: null,
        lastTurn: 0,
      }
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
      if (name === 'webServer') {
        return { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:0' }
      }
      if (name === 'agents') return agents
      if (name === 'tools') return toolsService
      if (name === 'workingDirectory') return { get: () => root }
      if (name === 'sessions') {
        return { get: (id) => sessions.get(id), list: () => [...sessions.values()] }
      }
      if (name === 'sessionTitle') {
        return {
          get: (session) => {
            const id = session !== null && session !== undefined ? session.id : undefined
            const title = typeof id === 'string' ? titles.get(id) : undefined
            return title === undefined ? undefined : { title }
          },
        }
      }
      if (name === 'workspaceRegistry') return { list: () => [{ path: root, title: 'test' }] }
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
  apply(ctx, options.config ?? {})
  const harness = {
    ctx,
    warns,
    tools,
    sessions,
    titles,
    openTurns,
    addAgent(id) {
      const session = { id, cwd: root, header: { origin: 'main' } }
      const agent = { id, session }
      live.set(id, agent)
      rootIds.add(id)
      sessions.set(id, session)
      return agent
    },
    /** A delegated child: live and stored, but never a root agent. */
    addChildAgent(childId, parentId) {
      const session = { id: childId, cwd: root, header: { origin: 'subagent', parentSession: parentId } }
      const agent = { id: childId, session }
      live.set(childId, agent)
      sessions.set(childId, session)
      return agent
    },
    setTitle(id, title) {
      titles.set(id, title)
    },
    setTurnOpen(id, open) {
      if (open) openTurns.add(id)
      else openTurns.delete(id)
    },
    removeLive(id) {
      live.delete(id)
      sessions.delete(id)
    },
    handler(name) {
      const set = handlers.get(name)
      return set === undefined ? [] : [...set]
    },
    emit(name, ...args) {
      for (const handler of harness.handler(name)) handler(...args)
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t81-session-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t81-session-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

const heartbeatFile = (root, session) => path.join(root, '.agents', 'heartbeat', `${session}.json`)
const readBeat = (root, session) => JSON.parse(fs.readFileSync(heartbeatFile(root, session), 'utf8'))

/** One recorded event payload: `agent/created` and `agent/disposed` take `{ agent }`. */
function created(harness, agent) {
  const listeners = harness.handler('agent/created')
  assert.equal(listeners.length, 1, `expected one agent/created hook, got ${listeners.length}`)
  return listeners[0]({ agent })
}

// ------------------------------------------------------------------- core

test('core：标题写读一致，waiting 是合法状态，空标题清除', () => {
  const { root, contract } = freshProject('core-title')
  const started = startHeartbeat(root, contract, {
    session: 'session-core-title',
    title: '会话标题 A',
    status: 'idle',
    createTask: false,
  })
  assert.equal(started.title, '会话标题 A')
  assert.equal(started.status, 'idle', 'host 可以指定开场状态，不再硬编码 working')

  const updated = updateHeartbeat(root, contract, 'session-core-title', { title: '会话标题 B' })
  assert.equal(updated.title, '会话标题 B')

  const status = heartbeatStatus(root, contract, 'session-core-title')
  assert.equal(status.record.title, '会话标题 B')
  assert.equal(status.active, true, 'idle 必须是 active 状态')

  const section = readHeartbeatSection(root, contract, { visibility: 'all' })
  const row = section.items.find((item) => item.session === 'session-core-title')
  assert.ok(row !== undefined, '记录必须在 readHeartbeatSection 里')
  assert.equal(row.title, '会话标题 B', '投影必须带出会话标题')

  // waiting 是合法状态，且同样算 active
  const waiting = updateHeartbeat(root, contract, 'session-core-title', { status: 'waiting' })
  assert.equal(waiting.status, 'waiting')
  assert.equal(heartbeatStatus(root, contract, 'session-core-title').active, true)

  // 空标题 = 清除，投影回退为空串（面板再用 goal/session 兜底）
  const cleared = updateHeartbeat(root, contract, 'session-core-title', { title: '' })
  assert.equal(Object.hasOwn(cleared, 'title'), false, '清空后不保留空字段')
  const after = readHeartbeatSection(root, contract, { visibility: 'all' })
  assert.equal(after.items.find((item) => item.session === 'session-core-title').title, '')

  // 非法状态被拒绝
  assert.throws(
    () => updateHeartbeat(root, contract, 'session-core-title', { status: 'archived' }),
    /status must be one of/,
  )
})

test('core：removeHeartbeat 删除记录且幂等（缺文件不报错）', () => {
  const { root, contract } = freshProject('core-remove')
  startHeartbeat(root, contract, { session: 'session-core-rm', createTask: false })
  assert.equal(fs.existsSync(heartbeatFile(root, 'session-core-rm')), true)

  const first = removeHeartbeat(root, contract, 'session-core-rm')
  assert.deepEqual(first, { session: 'session-core-rm', removed: true })
  assert.equal(fs.existsSync(heartbeatFile(root, 'session-core-rm')), false)

  const second = removeHeartbeat(root, contract, 'session-core-rm')
  assert.deepEqual(second, { session: 'session-core-rm', removed: false }, '第二次删除必须是 no-op')
})

// ------------------------------------------------------------------- host

test('host：agent/created 用宿主标题与真实状态开记录（idle / working）', () => {
  const { root } = freshProject('created')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-created')
  harness.setTitle('session-t81-created', '宿主给的标题')

  created(harness, agent)
  const beat = readBeat(root, 'session-t81-created')
  assert.equal(beat.title, '宿主给的标题', '标题来自 ctx.sessionTitle')
  assert.equal(beat.status, 'idle', '没有开着的 turn 就是空闲')

  // 另一条会话在 turn 中创建：working
  const busy = harness.addAgent('session-t81-created-busy')
  harness.setTurnOpen('session-t81-created-busy', true)
  created(harness, busy)
  assert.equal(readBeat(root, 'session-t81-created-busy').status, 'working')
})

test('host：agent/status 推动 working ⇄ idle，子会话在跑时是 waiting', () => {
  const { root } = freshProject('status')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-status')
  created(harness, agent)
  assert.equal(readBeat(root, 'session-t81-status').status, 'idle')

  harness.setTurnOpen('session-t81-status', true)
  harness.emit('agent/status', { agent, status: 'running' })
  assert.equal(readBeat(root, 'session-t81-status').status, 'working')

  // turn 关了，但有一个子会话在跑 → 等待子会话
  harness.setTurnOpen('session-t81-status', false)
  harness.addChildAgent('session-t81-child', 'session-t81-status')
  harness.emit('agent/status', { agent, status: 'idle' })
  assert.equal(readBeat(root, 'session-t81-status').status, 'waiting')

  // 子会话结束 → 回到空闲
  harness.removeLive('session-t81-child')
  harness.emit('agent/status', { agent, status: 'idle' })
  assert.equal(readBeat(root, 'session-t81-status').status, 'idle')
  assert.deepEqual(harness.warns, [])
})

test('host：subagent/start 与 subagent/end 让父会话等待/恢复', () => {
  const { root } = freshProject('subagent')
  const harness = makeHarness(root)
  const parent = harness.addAgent('session-t81-parent')
  created(harness, parent)
  assert.equal(readBeat(root, 'session-t81-parent').status, 'idle')

  const child = harness.addChildAgent('session-t81-run-child', 'session-t81-parent')
  harness.emit('subagent/start', { runId: 'run-1', provider: 'local', id: child.id, local: true })
  assert.equal(readBeat(root, 'session-t81-parent').status, 'waiting', '子会话运行中，父会话在等待')

  // 父会话自己也进了 turn：工作中优先于等待（它正在产出）
  harness.setTurnOpen('session-t81-parent', true)
  harness.emit('agent/status', { agent: parent, status: 'running' })
  assert.equal(readBeat(root, 'session-t81-parent').status, 'working')

  harness.setTurnOpen('session-t81-parent', false)
  harness.emit('agent/status', { agent: parent, status: 'idle' })
  assert.equal(readBeat(root, 'session-t81-parent').status, 'waiting')

  // 子会话结束（宿主先销毁子会话再发 end）：父会话回到空闲
  harness.removeLive(child.id)
  harness.emit('subagent/end', { runId: 'run-1', provider: 'local', id: child.id, local: true, stopReason: 'completed' })
  assert.equal(readBeat(root, 'session-t81-parent').status, 'idle')
  assert.deepEqual(harness.warns, [])
})

test('host：session/title 事件刷新心跳标题', () => {
  const { root } = freshProject('title-event')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-title')
  created(harness, agent)
  assert.equal(Object.hasOwn(readBeat(root, 'session-t81-title'), 'title'), false)

  harness.emit('session/event', agent.session, {
    type: 'session/title',
    data: { title: '生成的会话标题', messageSeqs: [], source: { kind: 'fallback' } },
  })
  assert.equal(readBeat(root, 'session-t81-title').title, '生成的会话标题')

  // 其它事件不得改动标题
  harness.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 } })
  assert.equal(readBeat(root, 'session-t81-title').title, '生成的会话标题')
  assert.deepEqual(harness.warns, [])
})

test('host：归档（domain/changed 与 workspace/session-stop）删除心跳记录', () => {
  const { root } = freshProject('archive')
  const harness = makeHarness(root)

  // 1) 空闲会话被归档：workspace 域的全局写入带 archivedSessionIds
  const idleAgent = harness.addAgent('session-t81-archived-idle')
  created(harness, idleAgent)
  assert.equal(fs.existsSync(heartbeatFile(root, 'session-t81-archived-idle')), true)

  harness.emit('domain/changed', {
    domain: 'workspace',
    table: '',
    key: '',
    operation: 'put',
    value: { archivedSessionIds: ['session-t81-archived-idle'] },
  })
  assert.equal(fs.existsSync(heartbeatFile(root, 'session-t81-archived-idle')), false, '归档必须删除心跳')

  // 重复的全局写入（同一归档集合）不得报错、不得重复处理
  harness.emit('domain/changed', {
    domain: 'workspace',
    table: '',
    key: '',
    operation: 'put',
    value: { archivedSessionIds: ['session-t81-archived-idle'] },
  })

  // 2) 运行中归档：workspace/session-stop 直接点名会话
  const running = harness.addAgent('session-t81-archived-running')
  created(harness, running)
  harness.emit('workspace/session-stop', { sessionId: 'session-t81-archived-running' })
  assert.equal(fs.existsSync(heartbeatFile(root, 'session-t81-archived-running')), false)

  // 3) agent 已经不在了：靠 workspace 注册表回退仍能定位并删除
  const gone = harness.addAgent('session-t81-archived-gone')
  created(harness, gone)
  harness.removeLive('session-t81-archived-gone')
  harness.emit('workspace/session-stop', { sessionId: 'session-t81-archived-gone' })
  assert.equal(fs.existsSync(heartbeatFile(root, 'session-t81-archived-gone')), false)

  assert.deepEqual(harness.warns, [])
})

test('host：子会话永远不建心跳（一一对应只针对主会话）', () => {
  const { root } = freshProject('child-only')
  const harness = makeHarness(root)
  const parent = harness.addAgent('session-t81-root')
  const child = harness.addChildAgent('session-t81-leaf', parent.id)

  const listeners = harness.handler('agent/created')
  assert.equal(listeners.length, 1)
  listeners[0]({ agent: child })

  assert.equal(fs.existsSync(heartbeatFile(root, 'session-t81-leaf')), false, '子会话不建心跳')
  assert.equal(fs.existsSync(heartbeatFile(root, 'session-t81-root')), false, '也不得顺手给父会话建')
  assert.deepEqual(harness.warns, [])
})

test('host：状态刷新不改 goal/task/claims，也不创建缺失的记录', () => {
  const { root, contract } = freshProject('preserve')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-preserve')
  addTask(root, contract, { type: 'feat', title: '栈顶任务：保留字段' })
  created(harness, agent)
  const before = readBeat(root, 'session-t81-preserve')

  harness.setTurnOpen('session-t81-preserve', true)
  harness.emit('agent/status', { agent, status: 'running' })
  const after = readBeat(root, 'session-t81-preserve')
  assert.equal(after.goal, before.goal)
  assert.equal(after.task, before.task)
  assert.deepEqual(after.claims, before.claims)
  assert.equal(after.started_at, before.started_at)

  // 没有记录的主会话：状态事件不得凭空创建
  const bare = harness.addAgent('session-t81-no-beat')
  harness.emit('agent/status', { agent: bare, status: 'running' })
  assert.equal(fs.existsSync(heartbeatFile(root, 'session-t81-no-beat')), false)
})

// -------------------------------------------------------------------- CLI

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')

/** Real-subprocess CLI run with an explicit project root. */
function runCli(root, args) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  const result = spawnSync(process.execPath, [BIN, '--root', root, ...args], { encoding: 'utf8', env })
  let json = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = null
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

test('CLI：heartbeat rm 删除记录，缺失时幂等退出 0', () => {
  const { root } = freshProject('cli-rm')
  startHeartbeat(root, loadContract(root).contract, { session: 'session-cli-rm', createTask: false })

  const removed = runCli(root, ['heartbeat', 'rm', 'session-cli-rm'])
  assert.equal(removed.code, 0, removed.stderr)
  assert.match(removed.stdout, /已移除心跳/)
  assert.equal(fs.existsSync(heartbeatFile(root, 'session-cli-rm')), false)

  const second = runCli(root, ['heartbeat', 'rm', 'session-cli-rm'])
  assert.equal(second.code, 0, second.stderr)
  assert.match(second.stdout, /没有心跳记录可移除/)
})

test('CLI：heartbeat update --status waiting 被接受并落盘', () => {
  const { root, contract } = freshProject('cli-waiting')
  startHeartbeat(root, contract, { session: 'session-cli-waiting', createTask: false })

  const updated = runCli(root, ['heartbeat', 'update', '--session', 'session-cli-waiting', '--status', 'waiting', '--note', '等子会话'])
  assert.equal(updated.code, 0, updated.stderr)
  assert.equal(readBeat(root, 'session-cli-waiting').status, 'waiting')
  assert.match(updated.stdout, /title\s+-/, '人类摘要必须带 title 行')
})
