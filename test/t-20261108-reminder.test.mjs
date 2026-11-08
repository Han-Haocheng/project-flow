// task-82：每轮 `【project-flow】` 提醒改版。
//
// 用户 2026-11-08 的要求：把「会话前」的提醒内容改成「当前任务状态 + 待决策」，
// 没有决策时提示**如何正确提交决策**。心跳提示段随之删除——task-81 已把心跳
// 生命周期收归插件（`agent/created` 自动开、`agent/disposed` 自动关），会话不再
// 需要被提醒去 start。
//
// 这里的每个用例都指向一个具体的失败方向：
// - 没有 C 段 → 模型又会「在对话里直接问」，这正是本卡要修的病；
// - 阶段手写英文 → 改名后提醒静默失配（单源证明）；
// - 恢复心跳提示 → 会话重新开始自造心跳；
// - 整体尾巴 clip → 被截掉的恰好是「怎么答」那句，而消息看起来仍然完整。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import {
  addDecision,
  addTask,
  initProject,
  loadContract,
  updateTask,
} from '../lib/core.mjs'
import {
  captureSummary,
  createCaptureState,
  pendingUtterances,
  recordPreStep,
} from '../lib/capture.mjs'

const TEMP_ROOTS = []

// ---------------------------------------------------------------- fake host

/**
 * One host double: an `agents` registry (so `rootSessionVerdict` sees a live
 * root), a `webServer` for the routes, and an event bus that records the
 * `agent/pre-step` listener the plugin registers.
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
  const addAgent = (id, root, { root: isRoot = true } = {}) => {
    const agent = {
      id,
      session: { cwd: root, header: { origin: isRoot ? 'main' : 'subagent' } },
    }
    live.set(id, agent)
    if (isRoot) rootIds.add(id)
    return agent
  }
  return {
    ctx,
    handlers,
    warns,
    addRoot: (id, root) => addAgent(id, root, { root: true }),
    addChild: (id, root) => addAgent(id, root, { root: false }),
    preStepHandlers: () => {
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

const harness = makeHarness()

before(() => {
  apply(harness.ctx, {})
  assert.equal(harness.preStepHandlers().length, 1, 'apply must register exactly one agent/pre-step listener')
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

// --------------------------------------------------------------- fixtures

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t82-reminder-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t82-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

/** Create a task already at `stage` by walking the legal chain from `created`. */
function seedTask(root, contract, { title = '提醒测试任务', stage = 'queued-analysis' } = {}) {
  const task = addTask(root, contract, { type: 'feat', title })
  const chain = ['queued-analysis', 'analyzing', 'queued-implementation', 'implementing']
  const target = chain.indexOf(stage)
  for (const next of chain.slice(0, target + 1)) {
    updateTask(root, contract, task.id, { stage: next })
  }
  return task
}

/** One open decision with a distinct question (dedupe is per fingerprint). */
function seedDecision(root, contract, question, extra = {}) {
  return addDecision(root, contract, {
    kind: 'choice',
    question,
    rationale: '提醒测试',
    recommendation: 'a',
    options: [
      { id: 'a', label: 'A', impact: '选 A' },
      { id: 'b', label: 'B', impact: '选 B' },
    ],
    ...extra,
  }).decision
}

/** Drive the registered pre-step hook with a synthetic enter decision. */
async function runPreStep(agent, { turn = 1, step = 1, messages = [] } = {}) {
  const listeners = harness.preStepHandlers()
  assert.equal(listeners.length, 1, 'expected exactly one pre-step listener')
  const baseline = { kind: 'enter', messages: [] }
  const result = await listeners[0]({ agent, turn, step, messages }, async () => baseline)
  return result
}

/** The single reminder text a result carries ('' when none was added). */
function reminderText(result) {
  const messages = Array.isArray(result?.messages) ? result.messages : []
  if (messages.length === 0) return ''
  assert.equal(messages.length, 1, 'the reminder is ONE message')
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content.length, 1, 'the reminder is ONE text block')
  return messages[0].content[0].text
}

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
}

// ------------------------------------------------------------------ tests

test('A+C：有栈顶任务、无待决策 → 当前任务 + 无待决策 + 如何提交（C 段不许省）', async () => {
  const { root, contract } = freshProject('task-no-decision')
  const task = seedTask(root, contract, { title: '实现提醒拼装', stage: 'implementing' })
  const agent = harness.addRoot('session-t82-c', root)

  const text = reminderText(await runPreStep(agent))

  assert.ok(text.startsWith('【project-flow】'), text)
  assert.ok(text.includes(`当前任务：${task.id} [实现中]`), text)
  assert.ok(text.includes('未完成 1 条 ｜ 栈顶 1 条'), text)
  // C 段：用户本次要求的核心。删掉它，模型就又会直接问。
  assert.ok(text.includes('无待决策'), text)
  assert.ok(text.includes('flow_decision ask'), text)
  assert.ok(text.includes('flow_decision answer'), text)
  assert.ok(text.includes('不要在对话里直接问'), text)
  // 心跳提示必须走——生命周期已归插件。
  assert.equal(text.includes('flow_heartbeat start'), false, text)
  assert.equal(text.includes('working 心跳'), false, text)
})

test('A+B：有栈顶任务 + 待决策 → 待决策段、回答指引、段序、单一前缀', async () => {
  const { root, contract } = freshProject('task-decision')
  const task = seedTask(root, contract, { title: '处理决策模块', stage: 'implementing' })
  const decision = seedDecision(root, contract, '是否开启提醒改版？')
  const agent = harness.addRoot('session-t82-b', root)

  const text = reminderText(await runPreStep(agent))

  assert.ok(text.includes('当前任务：' + task.id), text)
  assert.ok(text.includes(`待决策 1 条`), text)
  assert.ok(text.includes(decision.id), text)
  assert.ok(text.includes('回答后当轮调用 flow_decision answer'), text)
  assert.ok(text.includes('不要按推荐自行决定'), text)
  // 段序：当前任务必须在待决策之前；整条只有一个前缀。
  assert.ok(text.indexOf('当前任务') < text.indexOf('待决策'), text)
  assert.equal(text.split('【project-flow】').length - 1, 1, text)
  assert.equal(/\n.*【project-flow】/.test(text), false, text)
})

test('D：无未完成任务 → 明确说「当前无未完成任务」，且不写「请先建任务」', async () => {
  const { root } = freshProject('no-task')
  const agent = harness.addRoot('session-t82-d', root)

  const text = reminderText(await runPreStep(agent))

  assert.ok(text.includes('当前无未完成任务'), text)
  assert.ok(text.includes('用户新说的每句话会自动成为任务'), text)
  assert.equal(text.includes('请先建任务'), false, text)
  // 没有任务也仍要给出「怎么提交决策」——这正是无决策时的常驻引导。
  assert.ok(text.includes('无待决策'), text)
  assert.ok(text.includes('flow_decision ask'), text)
})

test('D+B：没有未完成任务但有 open 决策时，待决策段仍然出现', async () => {
  const { root, contract } = freshProject('no-task-decision')
  const decision = seedDecision(root, contract, '空栈时是否仍提醒决策？')
  const agent = harness.addRoot('session-t82-db', root)

  const text = reminderText(await runPreStep(agent))

  assert.ok(text.includes('当前无未完成任务'), text)
  assert.ok(text.includes(`待决策 1 条`), text)
  assert.ok(text.includes(decision.id), text)
  assert.equal(text.includes('无待决策'), false, text)
})

test('命令行：有 / 命令时放最前，且前缀只出现一次', async () => {
  const { root, contract } = freshProject('command')
  seedTask(root, contract, { title: '带命令的一轮' })
  const agent = harness.addRoot('session-t82-cmd', root)

  const text = reminderText(
    await runPreStep(agent, { messages: [userMessage('/建议 这样做更好')] }),
  )

  assert.ok(text.startsWith('【project-flow】收到命令 /建议：这样做更好'), text)
  assert.ok(text.includes('当前任务：'), text)
  assert.ok(text.indexOf('收到命令') < text.indexOf('当前任务'), text)
  assert.equal(text.split('【project-flow】').length - 1, 1, text)
})

test('首轮列全部、次轮按上限折叠：首轮 4 条全列，次轮 3 条 + 「另有 1 条决策」', async () => {
  const { root, contract } = freshProject('cap')
  seedTask(root, contract, { title: '决策折叠' })
  const ids = []
  for (let index = 0; index < 4; index += 1) {
    ids.push(seedDecision(root, contract, `第 ${index + 1} 条待决问题`).id)
  }
  const agent = harness.addRoot('session-t82-cap', root)

  const firstTurn = reminderText(await runPreStep(agent, { turn: 1 }))
  for (const id of ids) assert.ok(firstTurn.includes(id), `first turn must list ${id}\n${firstTurn}`)
  assert.ok(firstTurn.includes('新会话第一步'), firstTurn)

  const laterTurn = reminderText(await runPreStep(agent, { turn: 2 }))
  assert.equal(ids.filter((id) => laterTurn.includes(id)).length, 3, laterTurn)
  assert.ok(laterTurn.includes('另有 1 条决策'), laterTurn)
  assert.ok(laterTurn.includes('flow decision list --open'), laterTurn)
})

test('预算：超长标题 + 8 条决策 + 长命令 → ≤800，且「怎么答」逐字完整、明细整行舍弃并计数', async () => {
  const { root, contract } = freshProject('budget')
  seedTask(root, contract, { title: '超长标题'.repeat(60), stage: 'implementing' })
  const ids = []
  for (let index = 0; index < 8; index += 1) {
    ids.push(seedDecision(root, contract, `预算压力下的第 ${index + 1} 条问题：${'细节'.repeat(20)}`).id)
  }
  const agent = harness.addRoot('session-t82-budget', root)
  const longCommand = `/建议 ${'这是一段很长的命令正文'.repeat(40)}`

  const text = reminderText(
    await runPreStep(agent, { turn: 1, messages: [userMessage(longCommand)] }),
  )

  assert.ok(text.length <= 800, `reminder must stay within 800 chars, got ${text.length}\n${text}`)
  // 不可牺牲句必须逐字完整（不是被截一半）。
  assert.ok(text.includes('回答后当轮调用 flow_decision answer <id> --choice <选项 id>；不要按推荐自行决定。'), text)
  // 明细整行丢弃后必须计数，且末行是「另有 N 条决策…」而不是被切掉的尾巴。
  assert.ok(text.includes('另有 ') && text.includes('条决策'), text)
  assert.ok(text.includes('flow decision list --open'), text)
  assert.equal(ids.every((id) => text.includes(id)), false, 'budget pressure must drop whole rows')
  // 命令行被保留但自身有界（不会因为一条超长命令撑爆整条提醒）。
  assert.ok(text.startsWith('【project-flow】收到命令 /建议：'), text)
})

test('阶段中文是单源：来自 STAGE_ZH，不出现英文阶段 id', async () => {
  const { root, contract } = freshProject('stage-zh')
  seedTask(root, contract, { title: '阶段中文', stage: 'implementing' })
  const agent = harness.addRoot('session-t82-zh', root)

  const text = reminderText(await runPreStep(agent))

  assert.ok(text.includes('[实现中]'), text)
  assert.equal(text.includes('implementing'), false, text)
  // 反向证明：同一 stage 的显示名不可能从别处硬编码出另一个中文串。
  assert.equal(text.includes('[待实现]'), false, text)
})

test('capture 不把提醒当天任务：以 【project-flow】 开头即被结构排除', async () => {
  const { root, contract } = freshProject('capture-prefix')
  seedTask(root, contract, { title: '提醒不落账' })
  const agent = harness.addRoot('session-t82-capture', root)
  const text = reminderText(await runPreStep(agent))

  const state = createCaptureState()
  const queued = recordPreStep(state, {
    root,
    session: agent.id,
    messages: [userMessage(text)],
  })

  assert.equal(queued, 0, 'the reminder text must never queue as an utterance')
  assert.equal(captureSummary(state).excludedBy, 'prefix')
  assert.equal(pendingUtterances(state, root, agent.id).length, 0)
})

test('门控：子代理不提醒；同一 turn 的 step 2 不提醒；step 0 仍提醒', async () => {
  const { root, contract } = freshProject('gates')
  seedTask(root, contract, { title: '门控测试' })
  const rootAgent = harness.addRoot('session-t82-gate', root)
  const childAgent = harness.addChild('session-t82-sub', root)

  const child = await runPreStep(childAgent)
  assert.equal(reminderText(child), '', 'a subagent gets no reminder')

  const later = await runPreStep(rootAgent, { step: 2 })
  assert.equal(reminderText(later), '', 'only the first step of a turn reminds')

  const zero = await runPreStep(rootAgent, { step: 0 })
  assert.ok(reminderText(zero).includes('当前任务：'), 'step 0 is accepted too')
})
