// task-68：状态块把已完成任务算成未完成（**真 bug**，Lead 跑命令发现，不是测试发现）。
//
// 根因：core 的读投影对"存量无 stage"的记录一律补 `created`，无视 `status`——
// 36 条 done + 18 条 archived 全被判成未完成，done 任务还进了待办栈顶。
//
// 为什么 task-67 的测试没抓到：它断言 `deepEqual(CLI 结果, buildStatusBlock(...))`，
// **自洽性检查只证明"两边用同一个函数"，证明不了"那个函数是对的"**。两个都错时它照样绿。
// 所以本文件的重点不是"两处一致"，而是"投影结果与 status 的真值一致"。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildStatusBlock } from '../lib/capture.mjs'
import { legacyStageFromStatus, STAGE_IDS } from '../lib/stage.mjs'
import { getTask, initProject, listTasks, loadContract } from '../lib/core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const BIN = path.join(REPO, 'bin', 'flow.mjs')
const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-status-acc-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  return root
}

/** A pre-`stage` record written straight to disk (the exact shape the bug fed on). */
function writeLegacyTask(root, id, fields) {
  const record = {
    schema: 1,
    id,
    title: `存量 ${id}`,
    type: 'feat',
    owner: '',
    parent: null,
    scope: { allow: [], deny: [] },
    acceptance: [],
    checkpoints: [],
    commits: [],
    notes: '',
    created_at: fields.created_at ?? '2026-01-01T09:00:00+08:00',
    updated_at: '2026-01-02T09:00:00+08:00',
    ...fields,
  }
  fs.writeFileSync(
    path.join(root, '.dsh', 'flow', 'tasks', `${id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  return record
}

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

function blockOf(root) {
  const { contract } = loadContract(root)
  return buildStatusBlock({ listTasks }, root, contract)
}

// ---------------------------------------- 1. 存量 done：不进栈，计入 counts.done

test('存量 done（无 stage）不进栈、计入 counts.done；active 才是未完成', () => {
  const root = freshProject('legacy-done')
  writeLegacyTask(root, 'T-20260101-01', { status: 'done', created_at: '2026-01-01T09:00:00+08:00' })
  writeLegacyTask(root, 'T-20260101-02', { status: 'active', created_at: '2026-01-02T09:00:00+08:00' })

  const block = blockOf(root)
  assert.equal(block.unfinished, 1, 'done 不算未完成，active 算——真值只有 1 条')
  assert.equal(block.counts.done, 1, 'done 记录要计入 counts.done，不是 created')
  assert.equal(block.counts['queued-analysis'], 1, 'active 无 stage 反推为流水线最早阶段')
  assert.equal(block.counts.created, 0)
  assert.equal(block.stack.length, 1)
  assert.equal(block.stack[0].id, 'T-20260101-02', '栈里只能是那条 active 的')
  assert.equal(block.stack[0].stageZh, '待分析')
})

// ------------------------------------- 2. 存量 archived：同样不进栈

test('存量 archived（无 stage）不进栈、计入 counts.archived', () => {
  const root = freshProject('legacy-archived')
  writeLegacyTask(root, 'T-20260101-11', { status: 'archived' })
  writeLegacyTask(root, 'T-20260101-12', { status: 'done' })
  writeLegacyTask(root, 'T-20260101-13', { status: 'draft' })

  const block = blockOf(root)
  assert.equal(block.counts.archived, 1)
  assert.equal(block.counts.done, 1)
  assert.equal(block.counts.created, 1)
  assert.equal(block.unfinished, 1, '只有 draft 那条算未完成')
  assert.deepEqual(block.stack.map((item) => item.id), ['T-20260101-13'])
})

// -------------------------------- 3. CLI 端到端（bug 就藏在 core 投影这一层）

test('CLI 端到端：2 条 done + 1 条 active（无 stage）→ unfinished 1 / done 2 / 栈 1', () => {
  const root = freshProject('cli-e2e')
  writeLegacyTask(root, 'T-20260101-21', { status: 'done', created_at: '2026-01-01T09:00:00+08:00' })
  writeLegacyTask(root, 'T-20260101-22', { status: 'done', created_at: '2026-01-02T09:00:00+08:00' })
  writeLegacyTask(root, 'T-20260101-23', { status: 'active', created_at: '2026-01-03T09:00:00+08:00' })

  const result = runCli(root, ['status', '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const block = result.json.data.status
  assert.equal(block.unfinished, 1)
  assert.equal(block.counts.done, 2)
  assert.equal(block.counts['queued-analysis'], 1)
  assert.equal(block.stack.length, 1)
  assert.equal(block.stack[0].id, 'T-20260101-23')

  // 人类输出：**只看状态块那一段**（「最近任务」本来就会列 done 的记录，不算违规）
  const human = runCli(root, ['status'])
  assert.equal(human.code, 0)
  const statusSection = human.stdout.slice(human.stdout.indexOf('项目状态'))
  assert.ok(statusSection.length > 0, human.stdout)
  assert.match(statusSection, /未完成 1/)
  assert.doesNotMatch(statusSection, /T-20260101-21/, 'done 的记录不得出现在栈里')
  assert.doesNotMatch(statusSection, /T-20260101-22/, 'done 的记录不得出现在栈里')
  assert.match(statusSection, /T-20260101-23/, '栈里应当是那条 active 的')
})

// ------------------------- 4. 真值回归（真实台账，只读；不写死数字）

test('真值回归：本仓库真实台账的未完成数远小于总数，done/archived 才是大头', (t) => {
  // 本会话 2026-11-07 的真值快照：unfinished 6（created 4 · queued-implementation 2），
  // counts: done 36 · archived 18。台账在动，所以**只守不等式与比例**，不写死 6。
  const tasksDir = path.join(REPO, '.dsh', 'flow', 'tasks')
  if (fs.existsSync(tasksDir) === false) {
    t.skip('真实台账不存在（干净 checkout）')
    return
  }
  const files = fs.readdirSync(tasksDir).filter((name) => name.endsWith('.json'))
  if (files.length < 20) {
    t.skip(`真实台账只有 ${files.length} 条，不足以下真值断言`)
    return
  }
  const { contract } = loadContract(REPO)
  const block = buildStatusBlock({ listTasks }, REPO, contract)

  assert.ok(block.unfinished < 10, `未完成应远小于总数（实际 ${block.unfinished} / ${files.length} 条）`)
  assert.ok(block.counts.done > 30, `done 应是大头（实际 ${block.counts.done}）`)
  assert.ok(block.counts.archived > 10, `archived 应是大头（实际 ${block.counts.archived}）`)
  assert.ok(
    block.counts.done + block.counts.archived > block.unfinished * 5,
    `已完成/已归档应远多于未完成（done ${block.counts.done} + archived ${block.counts.archived} vs 未完成 ${block.unfinished}）`,
  )
  // 九键齐全，且总数守恒（每条的 stage 都必须落进某一个键）
  assert.deepEqual(Object.keys(block.counts), [...STAGE_IDS])
  const total = Object.values(block.counts).reduce((sum, count) => sum + count, 0)
  assert.equal(total, files.length, 'counts 总和必须等于台账条数（不许有被丢弃的记录）')
})

// --------------------------- 5. 反向：显式 stage 优先于 status 反推

test('显式 stage 优先：{status:active, stage:done} 不进栈', () => {
  const root = freshProject('explicit-wins')
  writeLegacyTask(root, 'T-20260101-31', { status: 'active', stage: 'done' })
  writeLegacyTask(root, 'T-20260101-32', { status: 'done' })

  const block = blockOf(root)
  assert.equal(block.counts.done, 2, '显式 stage=done 与存量 status=done 都计入 done')
  assert.equal(block.unfinished, 0, '两条都不是未完成')
  assert.equal(getTask(root, loadContract(root).contract, 'T-20260101-31').stage, 'done', '读投影不得覆盖显式 stage')
})

// ------------- 6. 纵深防御：调用方传**未投影**的原始记录时 counts 也不能错
//
// 这条让 capture.mjs 里 counts 走 `effectiveStage` 的那一行**可观测**——否则它只是
// "看起来防御"的死代码（task-68 的教训就是死代码兜底）。

test('纵深防御：未投影的原始记录（无 stage）喂给 buildStatusBlock，counts 仍按 status 记', () => {
  const raw = [
    { id: 'T-20260101-41', status: 'done', title: 'a', created_at: '2026-01-01T09:00:00+08:00' },
    { id: 'T-20260101-42', status: 'archived', title: 'b', created_at: '2026-01-02T09:00:00+08:00' },
    { id: 'T-20260101-43', status: 'active', title: 'c', created_at: '2026-01-03T09:00:00+08:00' },
  ]
  const block = buildStatusBlock({ listTasks: () => raw }, REPO, loadContract(REPO).contract)
  assert.equal(block.counts.done, 1)
  assert.equal(block.counts.archived, 1)
  assert.equal(block.unfinished, 1, '只有那条 active 未完成')
  assert.deepEqual(block.stack.map((item) => item.id), ['T-20260101-43'])
})

// ----------------------------- 7. 单点真源：映射只许有一处

test('legacyStageFromStatus 是唯一映射点：四个 status 的映射逐项固定', () => {
  assert.equal(legacyStageFromStatus('archived'), 'archived')
  assert.equal(legacyStageFromStatus('done'), 'done')
  assert.equal(legacyStageFromStatus('active'), 'queued-analysis')
  assert.equal(legacyStageFromStatus('draft'), 'created')
  assert.equal(legacyStageFromStatus(undefined), 'created', '缺失 status 落到 DEFAULT_STAGE')
  // 映射结果必须是合法阶段 id
  for (const status of ['archived', 'done', 'active', 'draft', undefined, 'nonsense']) {
    assert.ok(STAGE_IDS.includes(legacyStageFromStatus(status)), `${status} 映射出了非法阶段`)
  }
})

// ----------------------------- 8. 两处口径合并：effectiveStage 必须走同一映射

test('effectiveStage 的 status 回退必须与 legacyStageFromStatus 逐项一致', async () => {
  const { effectiveStage } = await import('../lib/capture.mjs')
  // 回归 task-68 报告里指出的第二处口径：capture.mjs 曾把无 stage 的 active
  // 映射成 'created'，而 stage.mjs 映射成 'queued-analysis'。经 core 的路径看不到
  // （core 先投影），但任何直接把**未投影记录**喂给 capture 的调用方会看到两个答案，
  // 于是同一条记录在"系统读"与"组件读"下被判成不同阶段。
  for (const status of ['archived', 'done', 'active', 'draft', undefined, 'nonsense']) {
    assert.equal(
      effectiveStage({ status }),
      legacyStageFromStatus(status),
      `status=${status} 时 effectiveStage 与唯一映射点分叉了`,
    )
  }
  // 显式 stage 永远优先于 status 反推（两个函数都必须如此）
  assert.equal(effectiveStage({ status: 'active', stage: 'reviewing' }), 'reviewing')
  assert.equal(effectiveStage({ status: 'active', stage: 'bogus' }), 'queued-analysis', '非法 stage 当作缺失，回退到 status 反推')
  assert.equal(effectiveStage({ status: 'done', stage: 'implementing' }), 'implementing', 'explicit stage wins even over done')
})
