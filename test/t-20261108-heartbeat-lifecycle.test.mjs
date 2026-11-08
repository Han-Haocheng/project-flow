// task-81 ①：心跳的生命周期收归插件——`agent/disposed` 自动关闭。
//
// 判据：创建/关闭是**生命周期事实**（只有插件知道：它持有 `agent/created` /
// `agent/disposed`），修改是**工作内容**（只有会话知道）。所以会话工具将要只剩
// `update`，而插件负责开与关。
//
// 本文件只验 ①（插件自动关闭）。②（移除工具 start/end）在 Lead 确认后另做。
//
// 在补上这个监听之前，`agent/created` 开的心跳**永不关闭**，而 `live` 状态豁免
// 6 小时陈旧规则 ⇒ 每条会话留一条永不消失的"活跃"心跳（登记过的 ghost 缺陷，
// 当时靠人手动 end 掩盖）。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { addTask, initProject, listTasks, loadContract } from '../lib/core.mjs'

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

function makeHarness(root, config = {}, options = {}) {
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
      // options.workingDirectory === false 模拟"项目根解析不出来"
      if (name === 'workingDirectory') {
        return options.workingDirectory === false ? undefined : { get: () => root }
      }
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
    warns,
    tools,
    addAgent(id, extra = {}) {
      const agent = { id, session: { cwd: root, header: { origin: 'main' }, ...extra } }
      live.set(id, agent)
      rootIds.add(id)
      return agent
    },
    /** An agent whose root cannot be resolved (no cwd, no workingDirectory service). */
    addRootlessAgent(id) {
      const agent = { id, session: { header: { origin: 'main' } } }
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t81-lifecycle-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t81-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

const heartbeatFile = (root, session) => path.join(root, '.agents', 'heartbeat', `${session}.json`)
const readBeat = (root, session) => JSON.parse(fs.readFileSync(heartbeatFile(root, session), 'utf8'))

/** `agent/created` and `agent/disposed` both deliver `{ agent }` (host carrier shape). */
function eventOf(harness, name) {
  const listeners = harness.handler(name)
  assert.equal(listeners.length, 1, `expected exactly one ${name} hook, got ${listeners.length}`)
  return (agent) => listeners[0]({ agent })
}

async function openThrougCreated(harness, agent) {
  await eventOf(harness, 'agent/created')(agent)
}

// --------------------------------------------------- ① 关闭：核心用例

test('① agent/disposed 把心跳关闭：status=done、有 ended_at、note 可追溯', async () => {
  const { root, contract } = freshProject('close')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-close')
  addTask(root, contract, { type: 'feat', title: '栈顶任务：生命周期' })

  await openThrougCreated(harness, agent)
  const before = readBeat(root, 'session-t81-close')
  assert.equal(before.status, 'working', 'agent/created 必须先开起来（否则本用例没有意义）')
  assert.equal(before.ended_at, null)

  const disposed = eventOf(harness, 'agent/disposed')
  disposed(agent)

  const afterBeat = readBeat(root, 'session-t81-close')
  assert.equal(afterBeat.status, 'done', 'dispose 后心跳必须是 done')
  assert.match(String(afterBeat.ended_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    '结束时刻必须落盘——否则它仍是"活跃"的幽灵')
  assert.ok(String(afterBeat.last_action).includes('会话结束（插件自动关闭）'), afterBeat.last_action)
  assert.deepEqual(harness.warns, [], '关闭是正常路径，不得 warn')
})

// --------------------------------------------------- ②③ 静默：不抛、不 warn

test('② dispose 时没有心跳 → 静默返回（不抛、不 warn）', () => {
  const { root } = freshProject('missing')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-missing')

  assert.equal(fs.existsSync(heartbeatFile(root, 'session-t81-missing')), false)
  const disposed = eventOf(harness, 'agent/disposed')
  assert.doesNotThrow(() => disposed(agent), '没有心跳时 dispose 不得抛')
  assert.deepEqual(harness.warns, [], '没有心跳是正常情形，不得 warn')
  assert.equal(fs.existsSync(heartbeatFile(root, 'session-t81-missing')), false, 'dispose 不得凭空创建心跳')
})

test('③ 根解析失败 / 没有 store → 静默跳过，宿主退出不受影响', () => {
  const { root } = freshProject('noroot-rooted')
  const harness = makeHarness(root, {}, { workingDirectory: false })
  const rootless = harness.addRootlessAgent('session-t81-rootless')
  const disposed = eventOf(harness, 'agent/disposed')

  assert.doesNotThrow(() => disposed(rootless), '根解析不出来时 dispose 不得抛')

  // 有根但那个根没有 store：同样静默
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-t81-bare-'))
  TEMP_ROOTS.push(bare)
  const harness2 = makeHarness(bare)
  const agent2 = harness2.addAgent('session-t81-bare')
  const disposed2 = eventOf(harness2, 'agent/disposed')
  assert.doesNotThrow(() => disposed2(agent2))
  assert.deepEqual(harness.warns, [])
  assert.deepEqual(harness2.warns, [])
})

// ------------------------------------------------------------- ④ 幂等

test('④ 重复 dispose（resume/clear 会多次触发）→ 幂等：ended_at 不变、note 不重复', async () => {
  const { root, contract } = freshProject('idempotent')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-idem')
  addTask(root, contract, { type: 'feat', title: '幂等' })

  await openThrougCreated(harness, agent)
  const disposed = eventOf(harness, 'agent/disposed')
  disposed(agent)
  const first = readBeat(root, 'session-t81-idem')
  const firstEndedAt = first.ended_at
  const firstAction = first.last_action

  // 再触发两次
  disposed(agent)
  disposed(agent)
  const second = readBeat(root, 'session-t81-idem')
  assert.equal(second.status, 'done')
  assert.equal(second.ended_at, firstEndedAt, '已关闭的心跳不得被重写结束时刻')
  assert.equal(second.last_action, firstAction, '关闭说明不得重复追加')
  assert.equal(String(second.last_action).split('会话结束（插件自动关闭）').length - 1, 1,
    '关闭说明只应出现一次')
})

// ------------------------------------------------- ⑤ 子代理不碰主会话心跳

test('⑤ 子代理 dispose → 不碰任何心跳（captureTarget 只认主会话）', async () => {
  const { root, contract } = freshProject('subagent')
  const harness = makeHarness(root)
  const main = harness.addAgent('session-t81-main')
  addTask(root, contract, { type: 'feat', title: '主会话任务' })
  await openThrougCreated(harness, main)
  const before = readBeat(root, 'session-t81-main')

  const sub = harness.addAgent('session-t81-sub', { header: { origin: 'subagent' } })
  eventOf(harness, 'agent/disposed')(sub)

  const afterBeat = readBeat(root, 'session-t81-main')
  assert.deepEqual(afterBeat, before, '子代理 dispose 不得动主会话的心跳')
  assert.deepEqual(harness.warns, [])
})

// ------------------------------------------------- ⑥ 坏文件也不许抛

test('⑥ 心跳文件损坏 → dispose 不抛、不 warn、不改写坏文件', async () => {
  const { root, contract } = freshProject('broken')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-broken')
  addTask(root, contract, { type: 'feat', title: '坏文件' })
  await openThrougCreated(harness, agent)

  const file = heartbeatFile(root, 'session-t81-broken')
  const corrupt = '{"schema":1,"session":'
  fs.writeFileSync(file, corrupt)

  const disposed = eventOf(harness, 'agent/disposed')
  assert.doesNotThrow(() => disposed(agent), '坏文件时 dispose 不得抛')
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt, '坏文件不得被 dispose 改写')
  assert.deepEqual(harness.warns, [], 'dispose 不得往宿主日志写 warning')
})

// --------------------------------------- ⑦ 注册与 capture 开关无关

test('⑦ dispose 钩子与 capture 开关无关：capture:false 时仍注册（否则回滚形态漏成幽灵）', () => {
  const { root } = freshProject('flag-off')
  const onHarness = makeHarness(root, {})
  assert.equal(onHarness.handler('agent/disposed').length, 1, '默认配置必须注册 dispose 钩子')

  const offHarness = makeHarness(root, { capture: false })
  assert.equal(offHarness.handler('agent/created').length, 0, 'capture:false 不注册 created（既有行为）')
  assert.equal(offHarness.handler('agent/disposed').length, 1,
    'capture:false 也必须关闭已存在的心跳——否则文件从未关闭，回滚形态直接漏成幽灵')
})

// --------------------------------- ⑧ 能力仍在：core 的 start/end 不许删

test('⑧ 收回入口不是删能力：core 仍导出 startHeartbeat / endHeartbeat', async () => {
  const core = await import('../lib/core.mjs')
  assert.equal(typeof core.startHeartbeat, 'function')
  assert.equal(typeof core.endHeartbeat, 'function')
  assert.ok(listTasks !== undefined)
})
