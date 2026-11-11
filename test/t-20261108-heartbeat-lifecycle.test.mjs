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

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
const heartbeatFile = (root, session) => path.join(root, '.agents', 'heartbeat', `${session}.json`)

/** Real-subprocess CLI run (phase ② must keep the human escape hatch working). */
function runCli(cwd, args) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env })
  let json = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = null
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}
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

test('⑦ 开与关的钩子都与 capture 开关无关：capture:false 时仍注册（否则回滚形态漏成幽灵/死路）', () => {
  const { root } = freshProject('flag-off')
  const onHarness = makeHarness(root, {})
  assert.equal(onHarness.handler('agent/disposed').length, 1, '默认配置必须注册 dispose 钩子')

  const offHarness = makeHarness(root, { capture: false })
  assert.equal(offHarness.handler('agent/created').length, 1,
    'capture:false 仍注册 created——心跳生命周期不归 capture 管（捕获/权限职责在钩子内部按开关停用）')
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

// ============================================ task-81 ②：会话面只剩 update/list/status

test('⑨ 工具面枚举 === [update, list, status]（start/end 已收回，list/status 必须还在）', () => {
  const { root } = freshProject('surface')
  const harness = makeHarness(root)
  const tool = harness.tools.get('flow_heartbeat')
  assert.ok(tool, 'flow_heartbeat 必须仍然注册')
  assert.deepEqual(
    tool.parameters.properties.action.enum,
    ['update', 'list', 'status'],
    '会话面只能是 update/list/status——收多了（连 list/status 一起收）就是另一种越界',
  )
  // 拒绝文案必须可执行：给出路，而不是只说"不行"
  const description = String(tool.description)
  assert.match(description, /CLI/, '描述必须提到人的逃生口')
  assert.doesNotMatch(description, /call start BEFORE replying/, '不得再教模型调用已被收回的 start')
})

test('⑩ start / end 被拒：文案含 CLI 与 update，且不写盘', async () => {
  const { root, contract } = freshProject('refuse')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-refuse')
  addTask(root, contract, { type: 'feat', title: '拒绝用例' })
  const tool = harness.tools.get('flow_heartbeat')
  const exec = { agent }

  for (const action of ['start', 'end']) {
    await assert.rejects(
      () => tool.execute({ action }, exec),
      (error) => {
        const message = String(error?.message ?? error)
        assert.match(message, /CLI/, `${action}: 必须指出哪有逃生口`)
        assert.match(message, /update/, `${action}: 必须指出会话能做什么`)
        assert.match(message, new RegExp(`flow heartbeat ${action}`), `${action}: 必须给出确切的 CLI 命令`)
        return true
      },
      `${action} 必须被拒`,
    )
  }
  assert.equal(fs.existsSync(heartbeatFile(root, 'session-t81-refuse')), false, '被拒的调用不得写盘')
})

test('⑪ update 仍正常（会话唯一能写的心跳动作）', async () => {
  const { root, contract } = freshProject('update-ok')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-update')
  addTask(root, contract, { type: 'feat', title: '更新用例' })
  // 心跳由插件（此处等价地由 core）先开好
  const core = await import('../lib/core.mjs')
  core.startHeartbeat(root, contract, { session: agent.id, goal: '初始目标' })

  const tool = harness.tools.get('flow_heartbeat')
  const updated = await tool.execute({ action: 'update', last_action: '本轮做了什么', status: 'idle' }, { agent })
  assert.equal(updated.heartbeat.status, 'idle')
  assert.equal(updated.heartbeat.last_action, '本轮做了什么')
  assert.equal(readBeat(root, agent.id).status, 'idle', '必须真的落盘')

  // list / status 仍可读
  const list = await tool.execute({ action: 'list' }, { agent })
  assert.equal(list.items.length, 1)
  const status = await tool.execute({ action: 'status' }, { agent })
  assert.equal(status.record.status, 'idle')
})

test('⑫ 联合断言：入口收回 **且** 能力仍在（两条同时成立才算对）', async () => {
  const core = await import('../lib/core.mjs')
  const { root } = freshProject('joint')
  const harness = makeHarness(root)
  const enumValues = harness.tools.get('flow_heartbeat').parameters.properties.action.enum
  // 只测枚举 → 能力被删也能绿；只测能力 → 入口没收回也能绿。必须同时断言。
  assert.deepEqual(enumValues, ['update', 'list', 'status'])
  assert.equal(typeof core.startHeartbeat, 'function', 'startHeartbeat 能力必须还在（插件与 CLI 都用它）')
  assert.equal(typeof core.endHeartbeat, 'function', 'endHeartbeat 能力必须还在（插件在 agent/disposed 用它）')
  assert.equal(typeof core.updateHeartbeat, 'function')
})

test('⑬ CLI 的 heartbeat start/end 仍是人的逃生口（真实子进程，不是 fake）', () => {
  const { root } = freshProject('cli-escape')
  const session = 'cli-t81-escape'

  const started = runCli(root, ['heartbeat', 'start', '--session', session, '--goal', '人手动补开', '--json'])
  assert.equal(started.code, 0, started.stdout + started.stderr)
  assert.equal(started.json.data.status, 'working')
  assert.equal(readBeat(root, session).goal, '人手动补开')

  const ended = runCli(root, ['heartbeat', 'end', '--session', session, '--json'])
  assert.equal(ended.code, 0, ended.stdout + ended.stderr)
  assert.equal(ended.json.data.status, 'done')
  assert.match(String(readBeat(root, session).ended_at), /^\d{4}-\d{2}-\d{2}T/)

  // 工具面仍然拒绝，CLI 仍然成功：这正是"人的逃生口"与"会话能力"的分界
  assert.deepEqual(
    (() => {
      const harness = makeHarness(root)
      return harness.tools.get('flow_heartbeat').parameters.properties.action.enum
    })(),
    ['update', 'list', 'status'],
  )
})

// ================================== task-81 ③：创建必须无条件（空台账 / capture 关闭）
//
// 判据：会话面收回 start 之后，「跳过一次创建」等于死路——写门禁拒绝编辑，
// 而 update 对缺失记录抛 not-found，提醒给出的出路根本不存在。所以创建与关闭
// 一样必须无条件、与 capture 无关；空栈用占位 goal + task:null，绝不凭空造任务。

/** Placeholder goal when the ledger has no unfinished task (must match index.js). */
const EMPTY_STACK_GOAL = '（台账暂无未完成任务）'

test('⑭ 空台账：agent/created 也开心跳（占位 goal + task:null），不建任务，update 可用', async () => {
  const { root } = freshProject('empty-stack')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-empty')
  assert.equal(listTasks(root).length, 0, '夹具前提：台账真的是空的')

  await openThrougCreated(harness, agent)

  const file = heartbeatFile(root, 'session-t81-empty')
  assert.equal(fs.existsSync(file), true, '空台账也必须由插件开心跳——否则会话没有任何恢复路径')
  const record = readBeat(root, 'session-t81-empty')
  assert.equal(record.status, 'working')
  assert.equal(record.task, null, '空栈不得凭空指向一条任务')
  assert.equal(record.goal, EMPTY_STACK_GOAL)
  assert.equal(listTasks(root).length, 0, '开心跳不得顺手造一条任务')
  assert.equal(harness.warns.some((line) => String(line).includes('auto-start skipped')), false,
    '空栈不再是「跳过」——它现在是正常路径')

  // 死路的另一半：会话唯一的写动作必须真的可用（而不是 not-found）。
  const tool = harness.tools.get('flow_heartbeat')
  const updated = await tool.execute({ action: 'update', last_action: '空台账也能登记' }, { agent })
  assert.equal(updated.heartbeat.last_action, '空台账也能登记')
  assert.equal(updated.heartbeat.task, null, 'update 不得顺手补一条任务')
  assert.equal(readBeat(root, 'session-t81-empty').last_action, '空台账也能登记', '必须真的落盘')
})

test('⑮ capture:false：心跳仍自动开、仍自动关（与 capture 无关），捕获职责仍全停', async () => {
  const { root } = freshProject('lifecycle-nocap')
  const harness = makeHarness(root, { capture: false })
  const agent = harness.addAgent('session-t81-nocap')

  await openThrougCreated(harness, agent)
  const file = heartbeatFile(root, 'session-t81-nocap')
  assert.equal(fs.existsSync(file), true, 'capture:false 不得连心跳生命周期一起停掉')
  const record = readBeat(root, 'session-t81-nocap')
  assert.equal(record.status, 'working')
  assert.equal(record.task, null)
  assert.equal(listTasks(root).length, 0, 'capture:false 仍然不捕获任何任务')

  const disposed = eventOf(harness, 'agent/disposed')
  disposed(agent)
  const closed = readBeat(root, 'session-t81-nocap')
  assert.equal(closed.status, 'done', '开与关必须对称（关的那半组已由 a5ee68e 无条件化）')
  assert.match(String(closed.last_action), /会话结束（插件自动关闭）/)
})

test('⑯ 有栈顶：goal/task/claims 仍取栈顶（无条件化不改变正常路径）', async () => {
  const { root, contract } = freshProject('stack-top')
  const task = addTask(root, contract, { type: 'feat', title: '栈顶：无条件创建', scope: { allow: ['index.js'] } })
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-stack')
  await openThrougCreated(harness, agent)

  const record = readBeat(root, 'session-t81-stack')
  assert.equal(record.goal, '栈顶：无条件创建')
  assert.equal(record.task, task.id, 'task 必须来自栈顶')
  assert.deepEqual(record.claims, ['index.js'])
  assert.equal(listTasks(root).length, 1, '有栈顶时不得多造任务')
})

test('⑰ 重复 agent/created（resume/clear）：不重复 start，turn 不涨、stats 不变', async () => {
  const { root } = freshProject('resume')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-t81-resume')
  await openThrougCreated(harness, agent)
  const first = readBeat(root, 'session-t81-resume')
  assert.equal(first.turn, 1)

  await openThrougCreated(harness, agent)
  const second = readBeat(root, 'session-t81-resume')
  assert.equal(second.turn, 1, '重复 created 不得把 turn 当成又一次 start')
  assert.equal(second.stats.turns, 1)
  assert.equal(second.started_at, first.started_at, 'started_at 不得被重复 created 改写')
})

// ------------------------------------------- ⑱ 后台任务会话：不建 + 遗留可回收

test('⑱ 后台任务会话前缀不建心跳；遗留文件 GC 一次清掉且 reason=synthetic', async () => {
  const { root, contract } = freshProject('synthetic')
  const harness = makeHarness(root)
  const core = await import('../lib/core.mjs')

  // 1) 三种前缀都不建心跳（它们的会话照样能让 rootSessionVerdict 判成根）
  for (const id of ['mnemon-task-abc', 'bg-task-abc', 'task-subagent-abc']) {
    const agent = harness.addAgent(id)
    await openThrougCreated(harness, agent)
    assert.equal(fs.existsSync(heartbeatFile(root, id)), false, `${id} 不得建心跳（否则每来一个后台任务多一个文件）`)
  }
  assert.deepEqual(harness.warns, [])

  // 2) 旧代码/别的路径留下的文件：GC 不看年龄，原因必须可解释为 synthetic
  core.startHeartbeat(root, contract, {
    session: 'mnemon-task-legacy',
    goal: '后台任务遗留文件',
    createTask: false,
  })
  const legacyFile = heartbeatFile(root, 'mnemon-task-legacy')
  assert.equal(fs.existsSync(legacyFile), true, '夹具前提：文件确实存在')

  const dry = core.gcLegacyHeartbeats(root, contract, { dryRun: true })
  assert.deepEqual(dry.removed.map((item) => item.file), ['mnemon-task-legacy.json'])
  assert.equal(dry.removed[0].reason, 'synthetic', '回收原因必须可解释（不是「已结束」）')
  assert.equal(fs.existsSync(legacyFile), true, 'dry-run 不删')

  core.gcLegacyHeartbeats(root, contract)
  assert.equal(fs.existsSync(legacyFile), false, '后台任务会话的遗留心跳被回收')
  assert.equal(core.readHeartbeatSection(root, contract, { visibility: 'all' }).counts.total, 0)
  assert.deepEqual(harness.warns, [])
})
