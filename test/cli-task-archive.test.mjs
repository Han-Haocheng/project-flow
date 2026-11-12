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

import { addTask as addTaskCore, endHeartbeat, getTask, initProject, loadContract, startHeartbeat, updateTask } from '../lib/core.mjs'
import { archiveNoiseTasks } from '../lib/tasks/records.mjs'
import { listTitle } from '../lib/cli/tasks.mjs'
import { textWidth } from '../lib/cli/shared.mjs'

/** T-15: `addTask` now requires `type`; fixtures default to feat (use addTaskCore to test the missing-type error). */
function addTask(root, contract, input = {}, options) {
  return addTaskCore(root, contract, { type: 'feat', ...input }, options)
}

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
  return path.join(root, '.agents', 'tasks', `${id}.json`)
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
  const file = path.join(root, '.agents', 'flow', 'flow.json')
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

  const gate = readJson(path.join(root, '.agents', 'gates', 'precommit.json'))
  // T-20261108 D3：描述漂移步再追加一条，前四步的顺序与语义都不动。
  assert.equal(gate.steps.length, 4, JSON.stringify(gate.steps))
  assert.equal(gate.steps[0].id, 'whitespace')
  assert.equal(gate.steps[0].run, 'git diff --cached --check')
  assert.equal(gate.steps[1].id, 'decisions')
  assert.match(gate.steps[1].run, /check decisions/)
  assert.equal(gate.steps[2].id, 'tasks-archive')
  assert.match(gate.steps[2].run, /task archive$/)
  assert.equal(gate.steps[2].expect, 'exit 0')
  assert.equal(gate.steps[3].id, 'description')
  assert.match(gate.steps[3].run, /check description$/)
  assert.equal(gate.steps[3].expect, 'exit 0')

  const contract = readJson(path.join(root, '.agents', 'flow', 'flow.json'))
  assert.ok(Number.isInteger(contract.tasks.archiveAfterDays), JSON.stringify(contract.tasks))
  assert.ok(contract.tasks.archiveAfterDays >= 0)
})


// --------------------------------------- 会话归属 owner（D-20261108-05 extend-owner）

test('task update --owner：none 释放为未指定；活跃会话的任务不可被 CLI 改写', () => {
  const { root, contract } = initRoot('owner-cli')
  const live = addTask(root, contract, { title: '活跃会话任务', owner: 'live-session' })
  const ended = addTask(root, contract, { title: '已结束会话任务', owner: 'ended-session' })
  const free = addTask(root, contract, { title: '可领取任务' })

  startHeartbeat(root, contract, { session: 'live-session', goal: '还在工作', createTask: false })
  startHeartbeat(root, contract, { session: 'ended-session', goal: '已结束', createTask: false })
  endHeartbeat(root, contract, { session: 'ended-session', status: 'done', note: '会话结束' })

  // 未指定 → 领取到新会话
  let result = runCli(root, ['task', 'update', free.id, '--owner', 'my-session', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.json.data.owner, 'my-session')

  // 释放回未指定
  result = runCli(root, ['task', 'update', free.id, '--owner', 'none', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.json.data.owner, '')

  // 已结束会话的 owner 可被释放/接管
  result = runCli(root, ['task', 'update', ended.id, '--owner', 'none', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.json.data.owner, '')

  // 活跃会话的任务：CLI 不能释放/改写
  result = runCli(root, ['task', 'update', live.id, '--owner', 'none', '--json'])
  assert.notEqual(result.code, 0, 'a live session\'s task must not be released by the CLI')
  assert.match(`${result.stdout}\n${result.stderr}`, /owned by active session/)
  assert.equal(readJson(taskFile(root, live.id)).owner, 'live-session', 'the live owner is untouched')
})

// ------------------------------------------------- 消息卡收口（2026-11-09）

/** 一张「捕获卡」：`source.at` 决定年龄；其余字段与 capture 建卡同形。 */
function seedUtterance(root, contract, { title, ageHours = 1, owner = '', extra = {} }) {
  const at = new Date(Date.now() - ageHours * 3_600_000).toISOString()
  return addTask(root, contract, {
    title,
    stage: 'queued-analysis',
    owner,
    source: { kind: 'utterance', key: `key-${title}-${ageHours}`, at, text: title },
    ...extra,
  })
}

test('task sweep --dry-run：只列「过期+未领取+无进展」的捕获卡，且不写盘', () => {
  const { root, contract } = initRoot('sweep-dry')
  const old = seedUtterance(root, contract, { title: '旧消息', ageHours: 30 })
  const owned = seedUtterance(root, contract, { title: '别人的待办', ageHours: 30, owner: 'session-x' })
  const noted = seedUtterance(root, contract, { title: '有进展', ageHours: 30, extra: { notes: '已经处理过' } })
  const young = seedUtterance(root, contract, { title: '刚说的', ageHours: 2 })
  const manual = addTask(root, contract, { title: '手写任务', stage: 'queued-analysis' })

  const result = runCli(root, ['task', 'sweep', '--older-than-hours', '24', '--dry-run', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.json.ok, true, result.stdout)
  const closed = result.json.data.closed.map((row) => row.id)
  assert.deepEqual(closed, [old.id], `只该收口 ${old.id}，实际 ${closed.join(',')}`)
  assert.equal(result.json.data.dryRun, true)
  assert.equal(readJson(taskFile(root, old.id)).stage, 'queued-analysis', '--dry-run 不写盘')
  for (const id of [owned.id, noted.id, young.id, manual.id]) {
    assert.equal(readJson(taskFile(root, id)).stage, 'queued-analysis', `${id} 不该被收口`)
  }
})

test('task sweep：真跑把旧捕获卡归档并留 auto-archive 说明，其它卡不动', () => {
  const { root, contract } = initRoot('sweep-run')
  const old = seedUtterance(root, contract, { title: '旧消息', ageHours: 30 })
  const fresh = seedUtterance(root, contract, { title: '刚说的', ageHours: 1 })

  const result = runCli(root, ['task', 'sweep', '--older-than-hours', '24', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(result.json.data.closed.map((row) => row.id), [old.id])

  const stored = readJson(taskFile(root, old.id))
  /* T-20261112151422 / M4（Lead 2026-11-12 批准）：sweep 的收口语义由 done 改为
     archived —— 噪声卡不该进入「完成」统计，归档后直接离开未完成栈，不必再等
     tasks.archiveAfterDays 的 7 天窗口。这里断言的就是这个语义变更。 */
  assert.equal(stored.stage, 'archived', '收口 = 阶段到 archived（status 由 stage 派生）')
  assert.equal(stored.status, 'archived')
  assert.match(stored.notes, /\[auto-archive\]/)
  assert.match(stored.notes, /24 小时/)
  assert.equal(stored.done_at, null, '噪声卡从来没有完成过，不写 done_at')
  assert.match(stored.archived_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(readJson(taskFile(root, fresh.id)).stage, 'queued-analysis', '年轻卡不动')
})

// --------------------------------------- 捕获噪声卡自动归档（T-20261112151422 S1）
//
// 判据：阶段还在队列最前端（queued-analysis / analyzing）、notes/commits/
// checkpoints/acceptance 全空、无子卡、owner 空、达到年龄阈值；**根卡**还要求
// source.kind === 'utterance'（手写空卡是人的意图，不是捕获噪声），子卡走父卡
// 终态时的级联收口（豁免来源判据）。归档写入阶段/状态 archived 并在 notes 留
// [auto-archive] 痕迹；重复 sweep / 重复 update 不重复写盘。

/** 小时前的时间戳（噪声卡年龄由 created_at / source.at 决定）。 */
function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

/** 一张未领取的空卡（手写，无 source——根卡判据应挡住它）。 */
function seedNoiseCard(root, contract, { title, stage = 'queued-analysis', ageHours = 30, ...rest }) {
  return addTask(root, contract, { title, stage, created_at: hoursAgo(ageHours), ...rest })
}

/** 一张 capture 落盘的空卡（source.kind = utterance）。 */
function seedCapturedCard(root, contract, { title, ageHours = 30, ...rest }) {
  const at = hoursAgo(ageHours)
  return addTask(root, contract, {
    title,
    stage: 'queued-analysis',
    created_at: at,
    source: { kind: 'utterance', key: `key-${title}`, at, text: title },
    ...rest,
  })
}

test('噪声归档 · 父卡到 done：同锁级联归档空的直接子卡，有内容/有子卡/刚建的不动', () => {
  const { root, contract } = initRoot('noise-cascade')
  const parent = addTask(root, contract, { title: '父卡', stage: 'analyzing' })
  const emptyQueued = seedNoiseCard(root, contract, { title: '空-待分析', parent: parent.id, ageHours: 2 })
  const emptyAnalyzing = seedNoiseCard(root, contract, { title: '空-分析中', stage: 'analyzing', parent: parent.id, ageHours: 3 })
  const noted = seedNoiseCard(root, contract, { title: '有备注', parent: parent.id, notes: '有进展' })
  const accepted = seedNoiseCard(root, contract, { title: '有验收', parent: parent.id, acceptance: ['人工验收：跑 node --test test/'] })
  const owned = seedNoiseCard(root, contract, { title: '别人的待办', parent: parent.id, owner: 'session-x' })
  const withChild = seedNoiseCard(root, contract, { title: '有子卡', parent: parent.id })
  const grandchild = seedNoiseCard(root, contract, { title: '孙卡', parent: withChild.id })
  // 与父卡同回合新建的空子卡（< 级联阈值 1 小时）不能被当场收掉。
  const young = seedNoiseCard(root, contract, { title: '刚建的空子卡', parent: parent.id, ageHours: 5 / 60 })

  assert.equal(updateTask(root, contract, parent.id, { stage: 'done' }).stage, 'done')

  for (const card of [emptyQueued, emptyAnalyzing]) {
    const stored = readJson(taskFile(root, card.id))
    assert.equal(stored.stage, 'archived', `${card.id} 应被级联归档`)
    assert.equal(stored.status, 'archived')
    assert.match(stored.notes, /\[auto-archive\]/)
    assert.match(stored.archived_at, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(stored.done_at, null, '噪声卡没有完成过，不写 done_at')
  }

  assert.equal(getTask(root, contract, noted.id).stage, 'queued-analysis', '有 notes 的不误伤')
  assert.equal(getTask(root, contract, accepted.id).stage, 'queued-analysis', '有 acceptance 的不误伤')
  assert.equal(getTask(root, contract, owned.id).stage, 'queued-analysis', '有 owner 的不误伤')
  assert.equal(getTask(root, contract, withChild.id).stage, 'queued-analysis', '有子卡的不误伤')
  assert.equal(getTask(root, contract, grandchild.id).stage, 'queued-analysis', '孙卡不随祖父级联')
  assert.equal(getTask(root, contract, young.id).stage, 'queued-analysis', '同回合新建的空子卡不动')
})

test('噪声归档 · 父卡到 archived：同样触发级联；手写子卡不被来源判据挡住', () => {
  const { root, contract } = initRoot('noise-cascade-archived')
  const parent = addTask(root, contract, { title: '父卡', stage: 'done' })
  const manualChild = seedNoiseCard(root, contract, { title: '手写空子卡', parent: parent.id, ageHours: 5 })
  updateTask(root, contract, parent.id, { stage: 'archived' })
  assert.equal(getTask(root, contract, manualChild.id).stage, 'archived', '子卡豁免 source.kind 判据')
})

test('噪声归档 · 判据：根卡必须 source.kind=utterance——手写空卡不动，捕获空卡归档', () => {
  const { root, contract } = initRoot('noise-root-source')
  const manual = seedNoiseCard(root, contract, { title: '手写空卡' })
  const captured = seedCapturedCard(root, contract, { title: '捕获空卡' })
  const noted = seedCapturedCard(root, contract, { title: '捕获但有备注', notes: '已处理' })
  const accepted = seedCapturedCard(root, contract, { title: '捕获但有验收', acceptance: ['人工验收'] })
  const owned = seedCapturedCard(root, contract, { title: '捕获但被领取', owner: 'session-y' })
  const young = seedCapturedCard(root, contract, { title: '捕获但太新', ageHours: 2 })
  const done = addTask(root, contract, { title: '已完成', status: 'done', created_at: hoursAgo(30) })

  const dry = archiveNoiseTasks(root, contract, { olderThanHours: 24, dryRun: true })
  assert.deepEqual(dry.archived.map((row) => row.id), [captured.id], 'dry-run 只列出唯一合格的捕获空卡')
  assert.equal(dry.dryRun, true)
  assert.equal(readJson(taskFile(root, captured.id)).stage, 'queued-analysis', 'dry-run 不写盘')
  assert.ok(dry.skipped['not-utterance'] >= 1, '手写空卡按 not-utterance 跳过')
  assert.ok(dry.skipped.notes >= 1)

  const run = archiveNoiseTasks(root, contract, { olderThanHours: 24 })
  assert.deepEqual(run.archived.map((row) => row.id), [captured.id])
  assert.equal(readJson(taskFile(root, captured.id)).stage, 'archived')
  for (const card of [manual, noted, accepted, owned, young]) {
    assert.notEqual(getTask(root, contract, card.id).stage, 'archived', `${card.id} 不该被归档`)
  }
  assert.equal(getTask(root, contract, done.id).stage, 'done', '已完成卡走 archiveAfterDays，不被本判据直接收')
})

test('噪声归档 · 幂等：重复 sweep 不重复写盘，重复 update 父卡不重复改写子卡', () => {
  const { root, contract } = initRoot('noise-idempotent')
  const old = seedCapturedCard(root, contract, { title: '旧捕获卡' })
  assert.deepEqual(
    archiveNoiseTasks(root, contract, { olderThanHours: 24 }).archived.map((row) => row.id),
    [old.id],
  )
  const bytes = fs.readFileSync(taskFile(root, old.id), 'utf8')

  assert.deepEqual(archiveNoiseTasks(root, contract, { olderThanHours: 24 }).archived, [], 'archived 卡不再命中')
  assert.equal(fs.readFileSync(taskFile(root, old.id), 'utf8'), bytes, '第二次 sweep 不得改写文件')

  const parent = addTask(root, contract, { title: '父卡', stage: 'analyzing' })
  const child = seedNoiseCard(root, contract, { title: '空子卡', parent: parent.id, ageHours: 4 })
  updateTask(root, contract, parent.id, { stage: 'done' })
  const childBytes = fs.readFileSync(taskFile(root, child.id), 'utf8')
  updateTask(root, contract, parent.id, { notes: '父卡备注' })
  assert.equal(fs.readFileSync(taskFile(root, child.id), 'utf8'), childBytes, '重复 update 不改写已归档子卡')
  assert.equal((childBytes.match(/\[auto-archive\]/g) ?? []).length, 1, '标记只写一次')
})

test('噪声归档 · flow task list：未终态的捕获卡标题列带 [capture]，手写卡/已归档卡不带', () => {
  const { root, contract } = initRoot('noise-capture-marker')
  const captured = seedCapturedCard(root, contract, { title: '来自聊天的一句话', ageHours: 2 })
  const manual = addTask(root, contract, { title: '手写任务' })
  const archivedCaptured = seedCapturedCard(root, contract, { title: '已归档的捕获卡', ageHours: 30 })
  archiveNoiseTasks(root, contract, { olderThanHours: 24 })

  const result = runCli(root, ['task', 'list'])
  assert.equal(result.code, 0, result.stderr)
  // 时间戳 id 互为前缀，按首列精确匹配。
  const lineOf = (id) => result.stdout.split('\n').find((line) => line.startsWith(`${id} `)) ?? ''
  assert.match(lineOf(captured.id), /\[capture\]$/, '未终态捕获卡应带标记')
  assert.doesNotMatch(lineOf(manual.id), /\[capture\]/, '手写卡不带标记')
  assert.doesNotMatch(lineOf(archivedCaptured.id), /\[capture\]/, '已归档的捕获卡不带标记（不是待办）')

  const jsonResult = runCli(root, ['task', 'list', '--json'])
  assert.equal(jsonResult.code, 0, jsonResult.stderr)
  const row = jsonResult.json.data.find((item) => item.id === captured.id)
  assert.equal(row.source.kind, 'utterance', 'source 原样保留')
  assert.equal(row.title, '来自聊天的一句话', '标记只在文本列，不写进记录')
  assert.equal(Object.hasOwn(row, 'capture'), false, '--json 不新增键')
})

test('噪声归档 · listTitle：标记占宽后标题列不超过 56 个显示宽度（宽字符）', () => {
  const captured = { title: '中'.repeat(60), stage: 'queued-analysis', source: { kind: 'utterance' } }
  const marked = listTitle(captured, ['done', 'archived'])
  assert.ok(marked.endsWith(' [capture]'))
  assert.ok(textWidth(marked) <= 56 && textWidth(marked) >= 54, `中文标题 + 标记不超列宽（实际 ${textWidth(marked)}）`)
  assert.equal(textWidth(listTitle({ title: 'x'.repeat(100), stage: 'queued-analysis' }, [])), 56)
  assert.doesNotMatch(listTitle({ ...captured, stage: 'archived' }, ['done', 'archived']), /\[capture\]/)
})
