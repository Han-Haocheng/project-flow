// task-74 P4 第 2 组：分析期否决与决策移交（纯本地台账）。
//
// 不对称是设计：子任务否决会话自决、不建决策；主任务否决必须上交决策，
// 任务停在 analyzing，用户答 modify/delete 后由 applyVetoAnswer 执行。
// `veto` 是历史（不清），`decision` 是待办指针（答完清空）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { addDecision, addTask, getDecision, getTask, initProject, listDecisions, loadContract } from '../lib/core.mjs'
import { VETO_CHOICES, applyVetoAnswer, vetoSubtask, vetoTask } from '../lib/veto.mjs'

const TEMP_ROOTS = []
const HARNESSES = []

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t74-veto-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t74v-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

function makeHarness(root) {
  const registered = new Map()
  const effects = []
  const toolsService = {
    register: (definition) => {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    guard: () => () => {},
    restrict: () => () => {},
    get: (name) => (['flow_veto', 'flow_subtask', 'flow_task'].includes(name) ? { name } : undefined),
  }
  const main = { id: 'session-main', session: { cwd: root, header: { origin: 'main' } }, ctx: { get: () => toolsService } }
  const ctx = {
    get(name) {
      if (name === 'tools') return toolsService
      if (name === 'agents') return { roots: () => [main], list: () => [main], get: () => undefined }
      if (name === 'workingDirectory') return { get: () => root }
      if (name === 'webServer') return { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:0' }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    on: () => () => {},
    logger: { warn() {} },
  }
  apply(ctx, {})
  const harness = { registered, main, tool: (name) => registered.get(name), dispose: () => effects.splice(0).forEach((dispose) => { try { dispose() } catch {} }) }
  HARNESSES.push(harness)
  return harness
}

test.after(() => {
  for (const harness of HARNESSES) harness.dispose()
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})

function analyzing(root, contract, title = '被否决的任务') {
  return addTask(root, contract, { type: 'feat', title, stage: 'analyzing' })
}

// ------------------------------------------------------------- 主任务否决

test('主任务否决：建 D 决策（只有 modify/delete）、任务停在 analyzing、decision 指向它', () => {
  const { root, contract } = freshProject('veto-task')
  const task = analyzing(root, contract)
  const result = vetoTask(root, contract, { taskId: task.id, reason: '方案不成立', at: '2026-11-07T21:00:00+08:00' })

  assert.match(result.decision.id, /^D-\d{8}-\d{2}$/)
  assert.equal(result.decision.status, 'open')
  assert.equal(result.decision.kind, 'choice')
  assert.deepEqual(result.decision.options.map((option) => option.id), ['modify', 'delete'])
  assert.equal(result.decision.recommendation, 'modify')

  const stored = getTask(root, contract, task.id)
  assert.equal(stored.stage, 'analyzing', 'a veto does not advance the stage')
  assert.equal(stored.decision, result.decision.id)
  assert.deepEqual(stored.veto, { by: 'analysis', reason: '方案不成立', at: '2026-11-07T21:00:00+08:00' })
})

test('主任务否决：只允许在 analyzing；其它阶段 invalid（带当前阶段提示）', () => {
  const { root, contract } = freshProject('veto-stage')
  const task = addTask(root, contract, { type: 'feat', title: '分析后', stage: 'queued-implementation' })
  assert.throws(
    () => vetoTask(root, contract, { taskId: task.id, reason: 'x' }),
    (error) => error.code === 'invalid' && /only allowed in analyzing/.test(error.message)
  )
})

test('主任务否决：reason 必填、任务必须存在', () => {
  const { root, contract } = freshProject('veto-args')
  const task = analyzing(root, contract)
  assert.throws(() => vetoTask(root, contract, { taskId: task.id }), /reason is required/)
  assert.throws(() => vetoTask(root, contract, { taskId: 'T-NOPE', reason: 'x' }), /not found/)
})

// --------------------------------------------------------------- 答案

test('答 modify：阶段回 queued-analysis、decision 清空、veto 历史保留', () => {
  const { root, contract } = freshProject('answer-modify')
  const task = analyzing(root, contract)
  const vetoed = vetoTask(root, contract, { taskId: task.id, reason: '需要改' })
  const result = applyVetoAnswer(root, contract, { taskId: task.id, choice: 'modify' })

  assert.equal(result.task.stage, 'queued-analysis')
  assert.equal(result.task.status, 'active')
  assert.equal(result.task.decision, null, 'the pending pointer is cleared')
  assert.deepEqual(result.task.veto, vetoed.task.veto, 'the veto history survives modify')
  assert.equal(result.decision.status, 'answered')
  assert.equal(result.decision.answer.choice, 'modify')
  assert.equal(listDecisions(root, contract, { all: true }).length, 1, 'the answered record stays in the ledger (all views)')
})

test('答 delete：阶段 done、done_at 落盘、decision 清空、veto 历史保留', () => {
  const { root, contract } = freshProject('answer-delete')
  const task = analyzing(root, contract)
  const vetoed = vetoTask(root, contract, { taskId: task.id, reason: '直接删' })
  const result = applyVetoAnswer(root, contract, { taskId: task.id, choice: 'delete' })

  assert.equal(result.task.stage, 'done')
  assert.equal(result.task.status, 'done', 'delete means done, not archived')
  assert.equal(typeof result.task.done_at, 'string')
  assert.ok(result.task.done_at.length > 0)
  assert.equal(result.task.decision, null)
  assert.deepEqual(result.task.veto, vetoed.task.veto, 'the veto history survives delete')
})

test('答案校验：choice 只有 modify/delete；无 pending decision / 未 vetoed → invalid', () => {
  const { root, contract } = freshProject('answer-invalid')
  const task = analyzing(root, contract)
  vetoTask(root, contract, { taskId: task.id, reason: 'x' })
  assert.throws(() => applyVetoAnswer(root, contract, { taskId: task.id, choice: 'archive' }), /choice must be one of/)
  assert.deepEqual(VETO_CHOICES, ['modify', 'delete'])
  const plain = addTask(root, contract, { type: 'fix', title: '普通任务', stage: 'analyzing' })
  assert.throws(() => applyVetoAnswer(root, contract, { taskId: plain.id, choice: 'modify' }), /was not vetoed/)
})

// ------------------------------------------------------------- 子任务否决

test('子任务否决：不建决策、子任务 done + [removed]、父任务 notes 记一行、veto 落盘', () => {
  const { root, contract } = freshProject('veto-subtask')
  const parent = addTask(root, contract, { type: 'feat', title: '父', stage: 'implementing' })
  const child = addTask(root, contract, { type: 'fix', title: '子', stage: 'analyzing', parent: parent.id, notes: '原备注' })
  const decisionsBefore = listDecisions(root, contract).length
  const result = vetoSubtask(root, contract, { taskId: child.id, reason: '不需要了' })

  assert.equal(listDecisions(root, contract).length, decisionsBefore, 'a subtask veto must not create a decision')
  assert.equal(result.task.stage, 'done')
  assert.equal(typeof result.task.done_at, 'string')
  assert.ok(result.task.notes.includes('原备注'))
  assert.ok(result.task.notes.includes('[removed] 不需要了'))
  assert.deepEqual(result.task.veto.by, 'analysis')
  assert.equal(result.task.veto.reason, '不需要了')
  assert.ok(result.parent.notes.includes(`[veto] 子任务 ${child.id} 已否决：不需要了`))
})

test('子任务否决：根任务（无 parent）→ invalid', () => {
  const { root, contract } = freshProject('veto-subtask-root')
  const task = analyzing(root, contract)
  assert.throws(() => vetoSubtask(root, contract, { taskId: task.id, reason: 'x' }), /not a subtask/)
})

// ------------------------------------------------------------- 工具端到端

test('flow_veto 工具：target 路由（task/subtask）与 answer 动作端到端', async () => {
  const { root, contract } = freshProject('tool')
  const harness = makeHarness(root)
  const tool = harness.tool('flow_veto')
  assert.ok(tool, 'flow_veto must be registered')

  const parent = addTask(root, contract, { type: 'feat', title: '父', stage: 'implementing' })
  const child = addTask(root, contract, { type: 'fix', title: '子', stage: 'analyzing', parent: parent.id })
  const childVeto = await tool.execute({ action: 'veto', target: 'subtask', id: child.id, reason: '子不要' }, { agent: harness.main })
  assert.equal(childVeto.task.stage, 'done')
  assert.equal(listDecisions(root, contract).length, 0, 'subtask veto creates no decision')

  const main = analyzing(root, contract, '主任务')
  const vetoed = await tool.execute({ action: 'veto', id: main.id, reason: '主不要' }, { agent: harness.main })
  assert.match(vetoed.decision.id, /^D-/)
  const answered = await tool.execute({ action: 'answer', id: main.id, choice: 'modify' }, { agent: harness.main })
  assert.equal(answered.task.stage, 'queued-analysis')
  assert.equal(answered.task.decision, null)
})

// ------------------------------------------- task-75：answer 自动应用（两入口）

/** `flow_decision` tool of a mounted harness. */
function decisionTool(harness) {
  const tool = harness.tool('flow_decision')
  assert.ok(tool, 'flow_decision must be registered')
  return tool
}

async function vetoedTask(root, contract, title = '待否决') {
  const task = addTask(root, contract, { type: 'feat', title, stage: 'analyzing' })
  const result = vetoTask(root, contract, { taskId: task.id, reason: '方案不成立' })
  return { task, decisionId: result.decision.id }
}

test('自动应用①工具路径：答 modify 后任务自动回 queued-analysis（无需再调 flow_veto answer）', async () => {
  const { root, contract } = freshProject('auto-tool-modify')
  const harness = makeHarness(root)
  const { task, decisionId } = await vetoedTask(root, contract)
  const result = await decisionTool(harness).execute({ action: 'answer', id: decisionId, choice: 'modify' }, { agent: harness.main })
  assert.equal(result.vetoApplied, true)
  assert.equal(result.task.stage, 'queued-analysis')
  assert.equal(getTask(root, contract, task.id).decision, null, 'the pending pointer is cleared automatically')
  assert.deepEqual(getTask(root, contract, task.id).veto, { by: 'analysis', reason: '方案不成立', at: getTask(root, contract, task.id).veto.at })
})

test('自动应用②工具路径：答 delete 后任务自动 done + done_at', async () => {
  const { root, contract } = freshProject('auto-tool-delete')
  const harness = makeHarness(root)
  const { task, decisionId } = await vetoedTask(root, contract)
  const result = await decisionTool(harness).execute({ action: 'answer', id: decisionId, choice: 'delete' }, { agent: harness.main })
  assert.equal(result.vetoApplied, true)
  assert.equal(result.task.stage, 'done')
  assert.equal(typeof result.task.done_at, 'string')
  assert.equal(result.task.decision, null)
})

test('自动应用③ CLI 路径同样自动，且与工具路径结果一致', async () => {
  const { spawnSync } = await import('node:child_process')
  const cli = path.resolve('bin/flow.mjs')
  const run = (root, args) => spawnSync(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8' })
  const make = (label) => {
    const proj = freshProject(label)
    const task = addTask(proj.root, proj.contract, { type: 'feat', title: 'CLI 否决', stage: 'analyzing' })
    const vetoed = vetoTask(proj.root, proj.contract, { taskId: task.id, reason: 'x' })
    return { ...proj, task, decisionId: vetoed.decision.id }
  }
  const viaCli = make('cli-path')
  const cliRun = run(viaCli.root, ['decision', 'answer', viaCli.decisionId, '--choice', 'modify', '--json'])
  assert.equal(cliRun.status, 0, cliRun.stdout + cliRun.stderr)
  const cliTask = getTask(viaCli.root, viaCli.contract, viaCli.task.id)
  assert.equal(cliTask.stage, 'queued-analysis', 'the CLI answer must apply the veto too')
  assert.equal(cliTask.decision, null)

  const viaTool = make('tool-path')
  const harness = makeHarness(viaTool.root)
  await decisionTool(harness).execute({ action: 'answer', id: viaTool.decisionId, choice: 'modify' }, { agent: harness.main })
  const toolTask = getTask(viaTool.root, viaTool.contract, viaTool.task.id)
  assert.equal(toolTask.stage, cliTask.stage, 'both entry points must land on the same stage')
  assert.equal(toolTask.status, cliTask.status)
  assert.equal(toolTask.decision, cliTask.decision)
  assert.equal(toolTask.veto.by, cliTask.veto.by)
  assert.equal(toolTask.veto.reason, cliTask.veto.reason)
})

test('自动应用④非否决型决策：答完任务不动（判据是 task.decision 指针，不是选项 id）', async () => {
  const { root, contract } = freshProject('non-veto')
  const harness = makeHarness(root)
  const task = addTask(root, contract, { type: 'fix', title: '普通任务', stage: 'analyzing' })
  // A normal decision that happens to use the SAME option ids — the trap mutation.
  const asked = addDecision(root, contract, {
    kind: 'choice',
    question: '这条普通决策只是恰好用了 modify/delete 两个 id，任务不该动。',
    options: [
      { id: 'modify', label: '改', impact: '不动任务' },
      { id: 'delete', label: '删', impact: '不动任务' },
    ],
    recommendation: 'modify',
    rationale: '验证判据不是选项 id。',
  })
  /* Another task IS vetoed, but it points at its OWN decision. Answering the
     normal decision must not touch it — the discriminator is the pointer, not
     "some vetoed task exists" and not the option ids. */
  const other = addTask(root, contract, { type: 'fix', title: '另一个被否决的任务', stage: 'analyzing' })
  const otherVeto = vetoTask(root, contract, { taskId: other.id, reason: '它自己的否决' })

  const result = await decisionTool(harness).execute({ action: 'answer', id: asked.decision.id, choice: 'modify' }, { agent: harness.main })
  assert.equal(result.vetoApplied, false)
  const stored = getTask(root, contract, task.id)
  assert.equal(stored.stage, 'analyzing', 'a non-veto decision must not move a task')
  assert.equal(Object.hasOwn(stored, 'decision'), false)
  const untouched = getTask(root, contract, other.id)
  assert.equal(untouched.stage, 'analyzing', 'answering another decision must not apply someone else`s veto')
  assert.equal(untouched.decision, otherVeto.decision.id, 'the other veto stays pending')
})

test('自动应用⑤应用失败不影响答案：决策仍 answered、结果带 vetoWarning、任务不动、不崩', async () => {
  const { root, contract } = freshProject('apply-failure')
  const harness = makeHarness(root)
  const { task, decisionId } = await vetoedTask(root, contract)
  // Corrupt the task record so the task patch fails validation (owner must be a string).
  const file = path.join(root, '.dsh', 'flow', 'tasks', `${task.id}.json`)
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  record.owner = 42
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n')

  const result = await decisionTool(harness).execute({ action: 'answer', id: decisionId, choice: 'modify' }, { agent: harness.main })
  assert.equal(result.decision.status, 'answered', 'the answer must stay recorded')
  assert.equal(result.vetoApplied, false)
  assert.equal(typeof result.vetoWarning, 'string')
  assert.ok(result.vetoWarning.length > 0)
  assert.equal(getTask(root, contract, task.id).stage, 'analyzing', 'a failed apply must not move the task')
})

test('自动应用⑥幂等：自动应用后再调 flow_veto answer 不报错、不二次推进', async () => {
  const { root, contract } = freshProject('idempotent')
  const harness = makeHarness(root)
  const { task, decisionId } = await vetoedTask(root, contract)
  await decisionTool(harness).execute({ action: 'answer', id: decisionId, choice: 'modify' }, { agent: harness.main })
  const before = getTask(root, contract, task.id)
  const again = await harness.tool('flow_veto').execute({ action: 'answer', id: task.id, choice: 'modify' }, { agent: harness.main })
  assert.equal(again.applied, false)
  const after = getTask(root, contract, task.id)
  assert.equal(after.stage, before.stage, 'a retry must not advance the stage twice')
})

test('自动应用顺序：非法 choice 被拒时任务不动（先记答案、再应用）', async () => {
  const { root, contract } = freshProject('order')
  const harness = makeHarness(root)
  const { task, decisionId } = await vetoedTask(root, contract)
  await assert.rejects(
    () => decisionTool(harness).execute({ action: 'answer', id: decisionId, choice: 'archive' }, { agent: harness.main }),
    /choice/
  )
  assert.equal(getTask(root, contract, task.id).stage, 'analyzing', 'a rejected answer must not move the task')
  assert.equal(getDecision(root, contract, decisionId).status, 'open', 'a rejected answer is not recorded')
})
