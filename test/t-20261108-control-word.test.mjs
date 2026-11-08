// task-77/78 · D-20261108-02 = command：聊天=任务，`/命令`=非任务。
//
// 判据是结构信号（以 `/` 开头，`trimStart()` 之后），不是词表。D-01 的 `degrade` 已被
// D-02 取代：`control` 只作为**遗留值**留在 core 校验与面板折叠里，不再产生新记录。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addTask, initProject, listTasks, loadContract, updateTask } from '../lib/core.mjs'
import { buildSnapshot } from '../lib/state-snapshot.mjs'
import { buildStatusBlock } from '../lib/capture.mjs'
import { COMMANDS, commandNameOf, parseCommand } from '../lib/commands.mjs'
import { apply } from '../index.js'
import {
  COMMAND_PREFIX,
  createCaptureState,
  flushCapture,
  recordPreStep,
  textOfContent,
} from '../lib/capture.mjs'

const TEMP_ROOTS = []

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t78-command-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t78-${label}`, noGates: true })
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

/** Run the real capture path for one sentence and return the created record (if any). */
function captureOne(root, contract, text) {
  const state = createCaptureState()
  recordPreStep(state, { root, session: 's', messages: [message(text)] })
  const result = flushCapture(state, { core: { addTask, listTasks, updateTask }, root, contract, session: 's' })
  return { task: result.created[0] ?? null, state }
}

// ------------------------------------------------------- ① `/` 命令不捕获

test('①「/建议 …」不产生任务，excludedBy="command"', () => {
  const { root, contract } = freshProject('advice')
  const { task, state } = captureOne(root, contract, '/建议 这样做更好')
  assert.equal(task, null, 'a command must never become a task')
  assert.equal(listTasks(root, contract).length, 0)
  assert.equal(state.lastExcludedBy, 'command')
})

test('② 六类已知命令都不产生任务（/继续 /暂停 /开始 /决策 /状态 /建议）', () => {
  const { root, contract } = freshProject('commands')
  for (const text of ['/继续', '/暂停', '/开始', '/决策 D-1 modify', '/状态', '/建议 先做 A']) {
    const { task } = captureOne(root, contract, text)
    assert.equal(task, null, `command must not become a task: ${text}`)
  }
  assert.equal(listTasks(root, contract).length, 0)
})

test('③ `"/"` 不在开头 → 仍是任务（防误伤）', () => {
  const { root, contract } = freshProject('no-false-positive')
  const { task } = captureOne(root, contract, '这条以 / 开头？')
  assert.ok(task, 'only a leading slash makes it a command')
  assert.equal(listTasks(root, contract)[0].title, '这条以 / 开头？')
})

test('④ `" /建议"`（前导空格）→ 仍不产生任务（trimStart 之后再判）', () => {
  const { root, contract } = freshProject('leading-space')
  const { task } = captureOne(root, contract, ' /建议 前导空格')
  assert.equal(task, null)
  assert.equal(listTasks(root, contract).length, 0)
})

test('⑤ `"继续"`（纯聊天，无 /）→ 产生任务且 kind="utterance"（聊天都是任务）', () => {
  const { root, contract } = freshProject('chat-word')
  const { task } = captureOne(root, contract, '继续')
  assert.ok(task, 'D-02: plain chat stays a task')
  const stored = listTasks(root, contract)[0]
  assert.equal(stored.source.kind, 'utterance')
  const block = buildStatusBlock({ listTasks }, root, contract)
  assert.equal(block.unfinished, 1)
  assert.ok(block.stack.some((row) => row.id === task.id))
})

test('⑥ 遗留兼容：存量 kind="control" 仍能过校验，仍被阶段桶跳过并计入 tasks.control', async () => {
  const { root, contract } = freshProject('legacy-control')
  addTask(root, contract, {
    type: 'chore',
    title: '继续',
    source: { kind: 'control', key: 'legacy-1', at: '2026-11-08T09:00:00+08:00', text: '继续' },
  })
  const real = addTask(root, contract, { type: 'feat', title: '帮我修 P3b', stage: 'queued-analysis' })
  const snap = await buildSnapshot({ root, realRoot: root, entry: { path: root, name: path.basename(root) }, hostWarnings: [] })
  const tasks = snap.tasks
  assert.equal(tasks.control.count, 1, 'a legacy control record still folds')
  assert.equal(tasks.stages.created.length, 0, 'legacy control records stay out of the buckets')
  assert.equal(tasks.stages['queued-analysis'][0].id, real.id)
  const bucketSum = Object.values(tasks.stageCounts).reduce((total, value) => total + value, 0)
  assert.equal(bucketSum + tasks.control.count, tasks.total)
  assert.equal(buildStatusBlock({ listTasks }, root, contract).unfinished, 1, 'only the real task counts')
})

test('⑦ source.kind 非法值 → invalid；control 仍是合法遗留值', () => {
  const { root, contract } = freshProject('kind-validation')
  assert.throws(
    () =>
      addTask(root, contract, {
        type: 'chore',
        title: 'x',
        source: { kind: 'noise', key: 'k', at: '2026-11-08T09:00:00+08:00', text: 'x' },
      }),
    (error) => error.code === 'invalid' && error.message.includes("'utterance'") && error.message.includes("'control'")
  )
  assert.equal(COMMAND_PREFIX, '/')
})

// -------------------------------------------- ⑧ 命令解析（只识别，不执行）

test('⑧ parseCommand 表驱动：六个已知命令 → {name,rest}；未知/无前缀/null；前导空格可识别', () => {
  assert.deepEqual([...COMMANDS], ['建议', '继续', '暂停', '开始', '决策', '状态'])
  assert.deepEqual(parseCommand('/建议 这样做更好'), { name: '建议', rest: '这样做更好' })
  assert.deepEqual(parseCommand('/继续'), { name: '继续', rest: '' })
  assert.deepEqual(parseCommand(' /决策 D-1 modify'), { name: '决策', rest: 'D-1 modify' })
  assert.deepEqual(parseCommand('/状态'), { name: '状态', rest: '' })
  assert.equal(parseCommand('/foo'), null, 'unknown command is not parsed')
  assert.equal(parseCommand('/'), null)
  assert.equal(parseCommand('这条以 / 开头？'), null)
  assert.equal(parseCommand(''), null)
  assert.equal(commandNameOf('/foo bar'), 'foo')
  assert.equal(commandNameOf('no slash'), '')
})

test('⑨ reminder 注入命令行（不写台账）；未知命令 warn 一次且不重复', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-t78-reminder-'))
  TEMP_ROOTS.push(root)
  initProject(root, { name: 't78-reminder', noGates: true })
  const contract = loadContract(root).contract

  const handlers = new Map()
  const warns = []
  const effects = []
  const tools = { register: () => () => {}, guard: () => () => {}, restrict: () => () => {}, get: () => undefined }
  const main = { id: 'session-cmd', session: { cwd: root, header: { origin: 'main' } }, ctx: { get: () => tools } }
  const ctx = {
    get(name) {
      if (name === 'tools') return tools
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
    on(name, handler) {
      const set = handlers.get(name) ?? new Set()
      set.add(handler)
      handlers.set(name, set)
      return () => set.delete(handler)
    },
    logger: { warn: (line) => warns.push(String(line)) },
  }
  apply(ctx, {})
  const preStep = async (text, step = 0) => {
    const listener = [...(handlers.get('agent/pre-step') ?? [])][0]
    assert.ok(listener, 'the reminder hook must be registered')
    return listener(
      { agent: main, messages: [message(text)], turn: 1, step, signal: { aborted: false } },
      async () => ({ kind: 'enter', messages: [] }),
    )
  }

  // 已知命令 → 提醒里出现一行，但台账零写入。
  const decision = await preStep('/建议 这样做更好')
  const reminder = (decision.messages || []).map((entry) => textOfContent(entry.content)).join('\n')
  assert.ok(reminder.includes('【project-flow】收到命令 /建议：这样做更好'), reminder)
  assert.equal(listTasks(root, contract).length, 0, 'a command never writes the ledger')

  // 未知命令 → 不注入、warn 一次；重复 step 不重复 warn。
  const unknown = await preStep('/foo bar')
  const unknownText = (unknown.messages || []).map((entry) => textOfContent(entry.content)).join('\n')
  assert.ok(!unknownText.includes('收到命令'), 'an unknown command gets no reminder line')
  assert.equal(warns.filter((line) => line.includes('unknown command /foo')).length, 1)
  await preStep('/foo again')
  assert.equal(warns.filter((line) => line.includes('unknown command /foo')).length, 1, 'warn once per mount')
})
