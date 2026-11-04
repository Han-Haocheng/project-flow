// T-20261104-07 卡 B：CLI `flow task archive` + precommit 种子步的回归测试。
//
// 只使用 os.tmpdir() 下的一次性目录；用真实 CLI（spawnSync bin/flow.mjs）验证
// 参数、退出码、文本/JSON 输出与落盘结果。core 级 sweep 的单元测试在
// test/core.test.mjs（卡 A），这里只覆盖 CLI 面与初始化种子。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { addTask, initProject, loadContract } from '../lib/core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
const DAY_MS = 86_400_000
const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结论
    }
  }
})

// ------------------------------------------------------------------ helpers

function tempRoot(label = 'case') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flow-archive-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

/** 已初始化项目。`noGates: false` 时保留默认门禁种子（用于 precommit 步断言）。 */
function initRoot(label, { gates = false } = {}) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: gates === false })
  const { contract } = loadContract(root)
  return { root, contract }
}

function runCli(cwd, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' })
  let json = null
  const text = result.stdout.trim()
  if (text.startsWith('{')) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function taskFile(root, id) {
  return path.join(root, '.dsh', 'flow', 'tasks', `${id}.json`)
}

/** 造一条指定状态的旧任务：`updated_at` 回填到 `days` 天前（buildTask 允许）。 */
function seedTask(root, contract, { title, status = 'done', days = 0 }) {
  return addTask(root, contract, {
    title,
    status,
    updated_at: new Date(Date.now() - days * DAY_MS).toISOString(),
  })
}

/** 当前契约的归档窗口；断言年龄都用它推导（默认值另有 7 天/6-7-8 边界用例钉住）。 */
function archiveWindow(contract) {
  const value = contract?.tasks?.archiveAfterDays
  assert.ok(Number.isInteger(value) && value > 0, `契约 tasks.archiveAfterDays 应为正整数，实际 ${value}`)
  return value
}

function writeContractKey(root, mutate) {
  const file = path.join(root, '.dsh', 'flow', 'flow.json')
  const contract = readJson(file)
  mutate(contract)
  fs.writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
  return contract
}

// --------------------------------------------------------------------- CLI

test('task archive --json：归档到期 done 任务，形状/退出码/落盘状态', () => {
  const { root, contract } = initRoot('json')
  const window = archiveWindow(contract)
  const oldDone = seedTask(root, contract, { title: '旧完成', status: 'done', days: window + 1 })
  const freshDone = seedTask(root, contract, { title: '新完成', status: 'done', days: window - 1 })
  const oldActive = seedTask(root, contract, { title: '旧进行中', status: 'active', days: window + 1 })

  const result = runCli(root, ['task', 'archive', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.json.ok, true, result.stdout)
  const data = result.json.data
  assert.deepEqual(data.archived, [oldDone.id])
  assert.equal(data.candidates, 1)
  assert.equal(data.days, window)
  assert.equal(typeof data.cutoff, 'string')
  assert.equal(data.dryRun, false)
  assert.equal(data.locked, false)
  assert.ok(Array.isArray(result.json.warnings), 'warnings 恒为数组')

  assert.equal(readJson(taskFile(root, oldDone.id)).status, 'archived')
  assert.equal(readJson(taskFile(root, freshDone.id)).status, 'done')
  assert.equal(readJson(taskFile(root, oldActive.id)).status, 'active')
})

test('默认窗口 7 天（19:32 拍板）：6/7/8 天边界，恰 7 天归档', () => {
  const { root, contract } = initRoot('boundary')
  assert.equal(contract.tasks.archiveAfterDays, 7, '默认值应由 Lead 19:32 拍板为 7 天')

  const sixDays = seedTask(root, contract, { title: '六天前完成', status: 'done', days: 6 })
  const sevenDays = seedTask(root, contract, { title: '恰七天前完成', status: 'done', days: 7 })
  const eightDays = seedTask(root, contract, { title: '八天前完成', status: 'done', days: 8 })

  const result = runCli(root, ['task', 'archive', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.json.data.days, 7)
  assert.deepEqual([...result.json.data.archived].sort(), [sevenDays.id, eightDays.id].sort())

  assert.equal(readJson(taskFile(root, sixDays.id)).status, 'done', '6 天未到期，不动')
  assert.equal(readJson(taskFile(root, sevenDays.id)).status, 'archived', '恰 7 天按 >= 归档')
  assert.equal(readJson(taskFile(root, eightDays.id)).status, 'archived')
})

test('task archive 文本模式：输出归档数量与 ids', () => {
  const { root, contract } = initRoot('text')
  const window = archiveWindow(contract)
  const oldDone = seedTask(root, contract, { title: '文本归档', status: 'done', days: window + 2 })

  const result = runCli(root, ['task', 'archive'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /已归档 1 个任务/)
  assert.ok(result.stdout.includes(oldDone.id), result.stdout)
  assert.equal(readJson(taskFile(root, oldDone.id)).status, 'archived')
})

test('--dry-run 只预览不写盘，且不改 updated_at', () => {
  const { root, contract } = initRoot('dry-run')
  const window = archiveWindow(contract)
  const oldDone = seedTask(root, contract, { title: '预览归档', status: 'done', days: window + 1 })
  const before = fs.readFileSync(taskFile(root, oldDone.id), 'utf8')

  const result = runCli(root, ['task', 'archive', '--dry-run', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.json.data.dryRun, true)
  assert.ok(result.json.data.candidates >= 1, result.stdout)
  assert.equal(fs.readFileSync(taskFile(root, oldDone.id), 'utf8'), before, 'dry-run 不得写盘')
  assert.equal(readJson(taskFile(root, oldDone.id)).status, 'done')
})

test('--older-than 覆盖配置窗口；0/非整数按用法错误', () => {
  const { root, contract } = initRoot('older-than')
  const window = archiveWindow(contract)
  const sixDaysOld = seedTask(root, contract, { title: '六天前完成', status: 'done', days: window - 1 })

  // 默认窗口下不到期：不归档。
  const skipped = runCli(root, ['task', 'archive', '--json'])
  assert.equal(skipped.code, 0, skipped.stderr)
  assert.deepEqual(skipped.json.data.archived, [])
  assert.equal(readJson(taskFile(root, sixDaysOld.id)).status, 'done')

  // 更短的显式窗口覆盖：归档。
  const override = Math.max(1, window - 2)
  const forced = runCli(root, ['task', 'archive', '--older-than', String(override), '--json'])
  assert.equal(forced.code, 0, forced.stderr)
  assert.deepEqual(forced.json.data.archived, [sixDaysOld.id])
  assert.equal(forced.json.data.days, override)
  assert.equal(readJson(taskFile(root, sixDaysOld.id)).status, 'archived')

  for (const bad of ['0', '-1', 'abc']) {
    const invalid = runCli(root, ['task', 'archive', '--older-than', bad, '--json'])
    assert.equal(invalid.code, 1, `--older-than ${bad} 应退出 1：${invalid.stdout}`)
    assert.equal(invalid.json.ok, false)
    assert.equal(invalid.json.error.code, 'usage')
  }
})

test('archiveAfterDays=0：关闭态输出已关闭、exit 0、不写盘；--older-than 仍可显式归档', () => {
  const { root, contract } = initRoot('closed')
  const window = archiveWindow(contract)
  const oldDone = seedTask(root, contract, { title: '关闭态', status: 'done', days: window + 1 })
  const before = fs.readFileSync(taskFile(root, oldDone.id), 'utf8')
  writeContractKey(root, (current) => {
    current.tasks.archiveAfterDays = 0
  })

  const closed = runCli(root, ['task', 'archive', '--json'])
  assert.equal(closed.code, 0, closed.stderr)
  assert.equal(closed.json.ok, true)
  assert.equal(closed.json.data.closed, true)
  assert.deepEqual(closed.json.data.archived, [])
  assert.equal(closed.json.data.days, 0)
  assert.equal(fs.readFileSync(taskFile(root, oldDone.id), 'utf8'), before, '关闭态不得写盘')

  const text = runCli(root, ['task', 'archive'])
  assert.equal(text.code, 0, text.stderr)
  assert.match(text.stdout, /任务归档已关闭/)

  const forced = runCli(root, ['task', 'archive', '--older-than', '1', '--json'])
  assert.equal(forced.code, 0, forced.stderr)
  assert.deepEqual(forced.json.data.archived, [oldDone.id], '显式 --older-than 应覆盖关闭态')
})

test('未初始化：task archive 退出 1 并给出 flow init 提示', () => {
  const root = tempRoot('uninitialized')
  const result = runCli(root, ['task', 'archive', '--json'])
  assert.equal(result.code, 1, result.stdout)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'usage')
  assert.match(result.json.error.message, /未初始化/)
  assert.match(result.json.error.message, /flow init/)
})

test('幂等：二次 archive 归档 0 个且不改写文件', () => {
  const { root, contract } = initRoot('idempotent')
  const window = archiveWindow(contract)
  const oldDone = seedTask(root, contract, { title: '幂等', status: 'done', days: window + 1 })

  const first = runCli(root, ['task', 'archive', '--json'])
  assert.equal(first.code, 0, first.stderr)
  assert.deepEqual(first.json.data.archived, [oldDone.id])
  const afterFirst = fs.readFileSync(taskFile(root, oldDone.id), 'utf8')

  const second = runCli(root, ['task', 'archive', '--json'])
  assert.equal(second.code, 0, second.stderr)
  assert.deepEqual(second.json.data.archived, [])
  assert.equal(second.json.data.candidates, 0)
  assert.equal(fs.readFileSync(taskFile(root, oldDone.id), 'utf8'), afterFirst, '二次 sweep 不得改写文件')
})

test('归档后 status --json：total 不变、done 减 1、archived 加 1', () => {
  const { root, contract } = initRoot('status-counts')
  const window = archiveWindow(contract)
  seedTask(root, contract, { title: '计数旧完成', status: 'done', days: window + 1 })
  seedTask(root, contract, { title: '计数活跃', status: 'active', days: 0 })

  const before = runCli(root, ['status', '--json'])
  assert.equal(before.code, 0, before.stderr)
  const beforeCounts = before.json.data.counts.tasks
  assert.equal(beforeCounts.done, 1)
  assert.equal(beforeCounts.archived, 0)
  assert.equal(beforeCounts.total, 2)

  const archived = runCli(root, ['task', 'archive', '--json'])
  assert.equal(archived.code, 0, archived.stderr)

  const after = runCli(root, ['status', '--json'])
  assert.equal(after.code, 0, after.stderr)
  const afterCounts = after.json.data.counts.tasks
  assert.equal(afterCounts.total, beforeCounts.total, 'total 不变')
  assert.equal(afterCounts.done, 0)
  assert.equal(afterCounts.archived, 1)
})

test('flow init 种入的 precommit 保留原两步并追加 tasks-archive（archiveAfterDays 默认写进契约）', () => {
  const root = tempRoot('seed-gates')
  const created = initProject(root, { name: 'seed-gates' })
  assert.ok(created.seededGates.includes('precommit'))

  const gate = readJson(path.join(root, '.dsh', 'flow', 'gates', 'precommit.json'))
  assert.equal(gate.steps.length, 3, JSON.stringify(gate.steps))
  assert.equal(gate.steps[0].id, 'whitespace')
  assert.equal(gate.steps[0].run, 'git diff --cached --check')
  assert.equal(gate.steps[1].id, 'decisions')
  assert.match(gate.steps[1].run, /check decisions/)
  assert.equal(gate.steps[2].id, 'tasks-archive')
  assert.match(gate.steps[2].run, /task archive$/)
  assert.equal(gate.steps[2].expect, 'exit 0')

  const contract = readJson(path.join(root, '.dsh', 'flow', 'flow.json'))
  assert.ok(Number.isInteger(contract.tasks.archiveAfterDays), JSON.stringify(contract.tasks))
  assert.ok(contract.tasks.archiveAfterDays >= 0)
})
