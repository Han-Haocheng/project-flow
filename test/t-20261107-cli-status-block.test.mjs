// task-67：§9 状态块接进 CLI（`flow status` / `flow heartbeat start|update`）。
//
// 核心约束：**不许造第二真源**。块由 `lib/capture.mjs` 的 `buildStatusBlock` 装配，
// 本文件的每个断言都拿 CLI 的输出与**直接调用它**的结果比对——CLI 若另写一套，
// 这里立刻红。
//
// 三个必须同时成立的方向（只看一个方向时"读不到"与"很干净"无法区分）：
//   有任务 → 块正确、栈超过上限会折叠；
//   零任务 → 未完成 0，不崩；
//   未初始化 → **不给零值块**（`data.status` 缺席），且既有行为照旧。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildStatusBlock } from '../lib/capture.mjs'
import { STAGE_IDS } from '../lib/stage.mjs'
import { initProject, listTasks, loadContract } from '../lib/core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-clistatus-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  return root
}

function emptyRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-clistatus-${label}-`))
  TEMP_ROOTS.push(root)
  return root
}

/** CLI runner tuned for the main-session-only heartbeat commands. */
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

function addTasks(root, count, { stage } = {}) {
  const ids = []
  for (let index = 1; index <= count; index += 1) {
    const args = ['task', 'add', '--type', 'feat', '--title', `任务 ${index}`, '--json']
    if (stage !== undefined) args.push('--stage', stage)
    const created = runCli(root, args)
    assert.equal(created.code, 0, created.stdout + created.stderr)
    ids.push(created.json.data.id)
  }
  return ids
}

/** The same block, assembled directly — the single-source oracle. */
function oracleBlock(root) {
  const { contract } = loadContract(root)
  return buildStatusBlock({ listTasks }, root, contract)
}

const BLOCK_KEYS = ['stack', 'counts', 'team', 'unfinished', 'recentCaptured']

// ---------------------------------------------------------------- 有任务：形状与真源

test('有任务：flow status 的 data.status 与工具侧同构，且与 buildStatusBlock 完全一致', () => {
  const root = freshProject('status-json')
  addTasks(root, 3, { stage: 'implementing' })

  const result = runCli(root, ['status', '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const block = result.json.data.status
  assert.ok(block, 'data.status 必须存在（store 已初始化）')
  assert.deepEqual(Object.keys(block), BLOCK_KEYS, '字段名与工具侧完全一致')
  assert.deepEqual(Object.keys(block.counts), [...STAGE_IDS], 'counts 的九个键来自 STAGE_IDS，不是手写的四 status')
  assert.equal(block.counts.implementing, 3)
  assert.equal(block.unfinished, 3)
  assert.deepEqual(block.team, { members: 0, tasks: 0 })

  // 单点真源：CLI 的结果必须与直接调用 capture.mjs 的结果逐字相同。
  assert.deepEqual(block, oracleBlock(root), 'CLI 不得实现第二套装配逻辑')

  // --json 时 stdout 只有 JSON（人类输出不得混入）
  assert.ok(result.stdout.trimStart().startsWith('{'), 'JSON 模式下 stdout 必须是纯 JSON')
  assert.equal(result.stdout.trim().split('\n').length, 1, 'JSON 模式下不得有多余文本行')
})

// ------------------------------------------------------------ 有任务：栈上限与截断

test('有任务：start 的栈上限 8（超出折叠），update 只显示前 5 且 unfinised 不被截断', () => {
  const root = freshProject('stack-cap')
  addTasks(root, 9)

  const oracle = oracleBlock(root)
  assert.equal(oracle.unfinished, 9)
  assert.equal(oracle.stack.length, 8, 'capture.mjs 的栈上限是 8')

  const started = runCli(root, ['heartbeat', 'start', '--session', 'cli-status', '--goal', '状态块', '--json'])
  assert.equal(started.code, 0, started.stdout + started.stderr)
  assert.equal(started.json.data.stack.length, 8, 'start 显示上限 8')
  assert.equal(started.json.data.unfinished, 9, 'unfinished 是真实条数，不随显示截断')
  assert.deepEqual(started.json.data.stack, oracle.stack, 'start 的栈与真源逐项一致（顺序即契约）')
  assert.equal(started.json.data.status, 'working', '心跳自身的 status 仍保留（块是平铺的五个键）')

  const updated = runCli(root, ['heartbeat', 'update', '--session', 'cli-status', '--note', '第二轮', '--json'])
  assert.equal(updated.code, 0, updated.stdout + updated.stderr)
  assert.equal(updated.json.data.stack.length, 5, 'update 只显示前 5 条')
  assert.equal(updated.json.data.unfinished, 9, 'update 也不许把 unfinished 截成 5')
  assert.deepEqual(updated.json.data.stack, oracle.stack.slice(0, 5), 'update 是同一排序的前缀，不是重新排序')
})

test('有任务：人类输出带状态块（标题、折叠提示、九阶段计数）', () => {
  const root = freshProject('stack-human')
  addTasks(root, 9)

  const human = runCli(root, ['heartbeat', 'start', '--session', 'cli-human', '--goal', '状态块'])
  assert.equal(human.code, 0, human.stdout + human.stderr)
  assert.match(human.stdout, /项目状态 {2}未完成 9/)
  assert.match(human.stdout, /栈 {2}8 条（共 9 条，其余折叠）/)
  assert.match(human.stdout, /\[已创建\]/, '行里显示中文阶段名（来自 capture/stage，不是 CLI 自造）')
  assert.match(human.stdout, /任务 9/, '栈顶是最新的一条')

  const updateHuman = runCli(root, ['heartbeat', 'update', '--session', 'cli-human', '--note', 'n'])
  assert.equal(updateHuman.code, 0, updateHuman.stdout + updateHuman.stderr)
  assert.match(updateHuman.stdout, /栈 {2}5 条（本轮只显示前 5 条，共 9 条）/)
})

// --------------------------------------------------------------------- 零任务台账

test('零任务台账：未完成 0、九个键全 0、不崩不报错', () => {
  const root = freshProject('empty')

  const result = runCli(root, ['status', '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const block = result.json.data.status
  assert.equal(block.unfinished, 0)
  assert.deepEqual(block.stack, [])
  assert.deepEqual(block.recentCaptured, [])
  for (const stage of STAGE_IDS) assert.equal(block.counts[stage], 0, `${stage} 应为 0`)
  assert.deepEqual(block, oracleBlock(root), '空台账也必须与真源一致')

  const human = runCli(root, ['status'])
  assert.equal(human.code, 0, human.stdout + human.stderr)
  assert.match(human.stdout, /项目状态 {2}未完成 0/)
  assert.match(human.stdout, /栈 {2}空（没有未完成的任务）/)
})

// ------------------------------------------------------------- 未初始化：不给零值块

test('未初始化：既有行为照旧（exit 0 + init 提示），且**不给零值状态块**', () => {
  const root = emptyRoot('uninitialized')
  assert.equal(fs.existsSync(path.join(root, '.dsh')), false)

  const result = runCli(root, ['status', '--json'])
  assert.equal(result.code, 0, '未初始化的 status 照旧 exit 0（行为不变）')
  assert.equal(result.json.data.initialized, false)
  assert.equal(Object.hasOwn(result.json.data, 'status'), false,
    '读不到时不得给 status——"未初始化"必须与"零任务"可区分')

  const human = runCli(root, ['status'])
  assert.equal(human.code, 0)
  assert.match(human.stdout, /未初始化/)
  assert.doesNotMatch(human.stdout, /未完成 0/, '未初始化不得显示"未完成 0"')

  // 心跳写命令在没有 store 时仍然失败（与拆前一致），不会伪造一个块
  const beat = runCli(root, ['heartbeat', 'start', '--session', 'x', '--json'])
  assert.equal(beat.code, 1, beat.stdout + beat.stderr)
  assert.equal(beat.json?.error?.code, 'usage')
})

// ------------------------------------------------- 阶段计数来自阶段表（不是四 status）

test('counts 按九阶段统计：六个流水线阶段各计各的，done/archived 单独计', () => {
  const root = freshProject('counts')
  addTasks(root, 1, { stage: 'queued-analysis' })
  addTasks(root, 2, { stage: 'analyzing' })
  addTasks(root, 1, { stage: 'done' })
  addTasks(root, 1, { stage: 'archived' })

  const block = runCli(root, ['status', '--json']).json.data.status
  assert.equal(block.counts['queued-analysis'], 1)
  assert.equal(block.counts.analyzing, 2)
  assert.equal(block.counts.done, 1)
  assert.equal(block.counts.archived, 1)
  assert.equal(block.counts.created, 0)
  // 未完成 = 不在 done/archived 的阶段
  assert.equal(block.unfinished, 3, 'done/archived 不计入未完成')
  assert.deepEqual(block.counts, oracleBlock(root).counts)
})

// ------------------------------------------------------ 状态块不改变既有 JSON 形状

test('回归：心跳命令的既有 data 字段一个不少（只新增五个键）', () => {
  const root = freshProject('json-compat')
  addTasks(root, 1)

  const started = runCli(root, ['heartbeat', 'start', '--session', 'cli-compat', '--goal', '兼容', '--json'])
  assert.equal(started.code, 0, started.stdout + started.stderr)
  for (const key of ['session', 'status', 'goal', 'task', 'claims', 'turn', 'started_at', 'stats']) {
    assert.ok(Object.hasOwn(started.json.data, key), `心跳记录字段 ${key} 不得消失`)
  }
  for (const key of BLOCK_KEYS) {
    assert.ok(Object.hasOwn(started.json.data, key), `状态块字段 ${key} 应平铺在 data 上`)
  }
})
