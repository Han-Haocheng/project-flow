// task-77 · D-20261108-01 = degrade：控制词记录但降级。
//
// 安全方向是这张卡的全部：真需求被误判成 control 时记录仍在（只是不进栈），
// 而控制词被误判成 utterance 只是多一条噪音。**唯一不可接受的是把消息丢掉**，
// 所以分类默认 utterance，且只做整串相等匹配（绝不做包含匹配）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addTask, initProject, listTasks, loadContract } from '../lib/core.mjs'
import { buildSnapshot } from '../lib/state-snapshot.mjs'
import { buildStatusBlock } from '../lib/capture.mjs'
import {
  CONTROL_WORDS,
  classifyUtterance,
  createCaptureState,
  flushCapture,
  recordPreStep,
} from '../lib/capture.mjs'

const TEMP_ROOTS = []

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t77-control-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t77-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

test.after(() => {
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})

const message = (text) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  timestamp: new Date().toISOString(),
})

/** Run the real capture path for one sentence and return the created record. */
function captureOne(root, contract, text) {
  const state = createCaptureState()
  recordPreStep(state, { root, session: 's', messages: [message(text)] })
  const result = flushCapture(state, { core: { addTask, listTasks, updateTask: updateTaskOf() }, root, contract, session: 's' })
  return { task: result.created[0], state }
}

function updateTaskOf() {
  // The real core updater (imported lazily to keep this helper next to its use).
  return coreUpdateTask
}
let coreUpdateTask = null
const coreReady = import('../lib/core.mjs').then((core) => {
  coreUpdateTask = core.updateTask
})
await coreReady

// ---------------------------------------------------------------- 分类本身

test('① 控制词：整串（含标点/全角/大小写）→ control', () => {
  for (const text of ['继续', '  继续。 ', '继续！', 'OK', 'ok', '好的', '嗯', '收到', '可以', '暂停', '停']) {
    assert.equal(classifyUtterance(text), 'control', `expected control for ${JSON.stringify(text)}`)
  }
})

test('② 包含控制词的真句子 → utterance（本卡最关键的反向约束）', () => {
  for (const text of [
    '继续修 P3b',
    '好，那就按这个方案',
    '暂停一下，先看这个',
    '可以把这个改成降级吗',
    '收到，请继续',
    '好的我们开始',
  ]) {
    assert.equal(classifyUtterance(text), 'utterance', `a real request must stay utterance: ${JSON.stringify(text)}`)
  }
  // 白名单保持小：每多一个词，多一分误降级风险。
  assert.ok(CONTROL_WORDS.length <= 12, `CONTROL_WORDS grew to ${CONTROL_WORDS.length}; keep it small`)
  assert.ok(CONTROL_WORDS.every((word) => word === word.trim().toLowerCase()), 'entries are normalized lowercase')
})

// ---------------------------------------------------------------- 捕获落盘

test('③ 捕获「继续」→ source.kind=control，且 unfinished/stack 都不含它', async () => {
  const { root, contract } = freshProject('control')
  const { task } = captureOne(root, contract, '继续')
  assert.ok(task, 'the control capture is recorded (never dropped)')
  const stored = listTasks(root, contract).find((entry) => entry.id === task.id)
  assert.equal(stored.source.kind, 'control')
  const block = buildStatusBlock({ listTasks }, root, contract)
  assert.equal(block.unfinished, 0, 'a control word must not count as unfinished')
  assert.equal(block.stack.length, 0, 'a control word must not occupy the stack')
})

test('④ 捕获「帮我修 P3b」→ source.kind=utterance，在 unfinished/stack 里', async () => {
  const { root, contract } = freshProject('utterance')
  const { task } = captureOne(root, contract, '帮我修 P3b')
  const stored = listTasks(root, contract).find((entry) => entry.id === task.id)
  assert.equal(stored.source.kind, 'utterance')
  const block = buildStatusBlock({ listTasks }, root, contract)
  assert.equal(block.unfinished, 1)
  assert.ok(block.stack.some((row) => row.id === task.id))
})

test('⑤ source.kind 非法值 → invalid，文案列出两个合法值', () => {
  const { root, contract } = freshProject('invalid-kind')
  assert.throws(
    () =>
      addTask(root, contract, {
        type: 'chore',
        title: 'x',
        source: { kind: 'noise', key: 'k', at: '2026-11-08T09:00:00+08:00', text: 'x' },
      }),
    (error) =>
      error.code === 'invalid' &&
      error.message.includes("'utterance'") &&
      error.message.includes("'control'")
  )
})

// ------------------------------------------------- 面板投影：control 单独成行

test('⑥ tasks.control 计数/ids 完整，且守恒：阶段桶 + control == 总数', async () => {
  const { root, contract } = freshProject('projection')
  addTask(root, contract, { type: 'chore', title: '继续', source: { kind: 'control', key: 'k1', at: '2026-11-08T09:00:00+08:00', text: '继续' } })
  addTask(root, contract, { type: 'chore', title: '好的', source: { kind: 'control', key: 'k2', at: '2026-11-08T09:01:00+08:00', text: '好的' } })
  const real = addTask(root, contract, { type: 'feat', title: '帮我修 P3b', stage: 'queued-analysis' })

  const snap = await buildSnapshot({ root, realRoot: root, entry: { path: root, name: path.basename(root) }, hostWarnings: [] })
  const tasks = snap.tasks
  assert.equal(tasks.control.count, 2)
  assert.equal(tasks.control.ids.length, 2)
  assert.equal(tasks.stages.created.length, 0, 'control tasks are not in the created bucket')
  assert.equal(tasks.stages['queued-analysis'].length, 1)
  assert.equal(tasks.stages['queued-analysis'][0].id, real.id)
  const bucketSum = Object.values(tasks.stageCounts).reduce((total, value) => total + value, 0)
  assert.equal(bucketSum + tasks.control.count, tasks.total, 'stage buckets + control must conserve the total')
  assert.equal(tasks.control.ids.includes(real.id), false)
})
