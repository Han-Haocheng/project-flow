// task-71 P2.5：面板九阶段视图（行 stage 投影 + 阶段桶 + 守恒断言）。
//
// 这一层保护的是「用户看得见」：行带第 14 键 `stage`，payload 带九个阶段桶与
// 计数，且九键求和 == 任务总数——分组改造最容易丢记录（某条记录落不进任何桶，
// 界面看起来正常，但任务消失了）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addTask, initProject, loadContract } from '../lib/core.mjs'
import { buildSnapshot } from '../lib/state-snapshot.mjs'
import { STAGE_IDS, legacyStageFromStatus } from '../lib/stage.mjs'

const ROW_KEYS = [
  'id', 'type', 'title', 'status', 'owner', 'notes', 'scope',
  'acceptance', 'commits', 'created_at', 'updated_at', 'parent', 'depth', 'stage', 'branch',
]

const TEMP_ROOTS = []

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t71-stage-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t71-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

function snapshotOf(root) {
  return buildSnapshot({ root, realRoot: root, entry: { path: root, name: path.basename(root) }, hostWarnings: [], now: new Date('2026-11-07T10:00:00+08:00') })
}

/** Strip `stage` from a persisted task record: the pre-P2.5 legacy shape. */
function stripStage(root, id) {
  const file = path.join(root, '.agents', 'tasks', `${id}.json`)
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete record.stage
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
}

test('行形状：stage 与 branch 是两个投影键，现代记录原样保留', async () => {
  const { root, contract } = freshProject('row')
  const task = addTask(root, contract, { type: 'feat', title: '实现中', stage: 'implementing' })
  const { tasks } = await snapshotOf(root)
  const row = tasks.stages.implementing.find((entry) => entry.id === task.id)
  assert.ok(row, 'the implementing bucket must hold the row')
  assert.deepEqual(Object.keys(row), ROW_KEYS, 'the panel row is the 15-key contract, order included')
  assert.equal(row.stage, 'implementing')
  assert.equal(row.branch, null, '手写任务没有捕获分支 → null（面板不渲染徽标）')
  assert.equal(row.status, 'active')
  // 四态 counts 保留，阶段计数单独成字段（done/archived 与阶段 id 同名）。
  for (const key of ['draft', 'active', 'done', 'archived', 'cancelled', 'other']) {
    assert.equal(typeof tasks.counts[key], 'number', `four-state counts.${key} must stay`)
  }
  assert.equal(tasks.counts.active, 1)
})

test('十阶段桶：每条记录恰好落进一个桶，十键计数 == 任务总数', async () => {
  const { root, contract } = freshProject('conservation')
  for (const stage of STAGE_IDS) {
    const input = { type: 'feat', title: `stage ${stage}`, stage }
    /* cancelled 是撤销终态：创建即撤销必须带原因（不放宽契约）。 */
    if (stage === 'cancelled') input.cancelReason = '面板桶测试撤销'
    addTask(root, contract, input)
  }
  const { tasks } = await snapshotOf(root)
  assert.equal(tasks.total, STAGE_IDS.length)

  // 键由 STAGE_IDS 生成（不是手写字面量）且顺序稳定。
  assert.deepEqual(Object.keys(tasks.stageCounts), [...STAGE_IDS])
  assert.deepEqual(Object.keys(tasks.stages), [...STAGE_IDS])
  for (const stage of STAGE_IDS) {
    assert.equal(tasks.stageCounts[stage], 1, `stageCounts.${stage} must be 1`)
    assert.equal(tasks.stages[stage].length, 1, `stages.${stage} must hold the row`)
    assert.equal(tasks.stages[stage][0].stage, stage)
    assert.equal(tasks.stages[stage][0].id, tasks.stages[stage][0].id.trim())
  }
  // 守恒：任何一条记录落不进桶，这个求和就会小于 total。
  const sum = Object.values(tasks.stageCounts).reduce((total, value) => total + value, 0)
  assert.equal(sum, tasks.total, 'stageCounts must conserve the task total')
  // 四态计数不参与阶段计数（避免 done/archived 同名互相覆盖）。
  assert.equal(tasks.counts.done, 1)
  assert.equal(tasks.stageCounts.done, 1)
  assert.equal(tasks.counts.active, 6, 'queued-analysis..reviewing are the six active stages')
  assert.equal(tasks.counts.cancelled, 1, 'cancelled 单列，不混入 done')
  assert.equal(tasks.counts.done, 1)
})

test('旧记录（无 stage）：按 legacyStageFromStatus 投影，done 不会落进待办桶', async () => {
  const { root, contract } = freshProject('legacy')
  const legacyDone = addTask(root, contract, { type: 'feat', title: '旧的已完成', stage: 'done' })
  stripStage(root, legacyDone.id)
  const legacyActive = addTask(root, contract, { type: 'feat', title: '旧的进行中', stage: 'analyzing' })
  stripStage(root, legacyActive.id)

  const { tasks } = await snapshotOf(root)
  const doneRow = tasks.stages.done.find((row) => row.id === legacyDone.id)
  assert.ok(doneRow, 'a legacy done record must land in the done bucket')
  assert.equal(doneRow.stage, 'done', 'the row stage is the legacy projection, stored nowhere')
  assert.equal(tasks.stages.created.some((row) => row.id === legacyDone.id), false, 'done must not leak into 待办')
  const activeRow = tasks.stages[legacyStageFromStatus('active')].find((row) => row.id === legacyActive.id)
  assert.ok(activeRow, 'a legacy active record projects to legacyStageFromStatus(active)')
  assert.equal(activeRow.stage, legacyStageFromStatus('active'))
  // 守恒仍然成立（含旧记录）。
  const sum = Object.values(tasks.stageCounts).reduce((total, value) => total + value, 0)
  assert.equal(sum, tasks.total)
  assert.equal(tasks.stageCounts.done, 1)
})

test('零任务：九个桶为空、九键为 0，不崩', async () => {
  const { root } = freshProject('empty')
  const { tasks } = await snapshotOf(root)
  assert.equal(tasks.total, 0)
  assert.deepEqual(Object.keys(tasks.stageCounts), [...STAGE_IDS])
  for (const stage of STAGE_IDS) {
    assert.equal(tasks.stageCounts[stage], 0)
    assert.deepEqual(tasks.stages[stage], [])
  }
  assert.equal(0, Object.values(tasks.stageCounts).reduce((total, value) => total + value, 0))
})

test('行形状：捕获卡的 source.branch 投影到第 15 键，非法/缺失一律 null', async () => {
  const { root, contract } = freshProject('row-branch')
  const tagged = addTask(root, contract, {
    type: 'chore',
    title: '分支上的卡片',
    stage: 'queued-analysis',
    source: { kind: 'utterance', key: 'k-branch', at: '2026-11-09T10:00:00+08:00', text: 'x', branch: 'feat/panel-badge' },
  })
  const { tasks } = await snapshotOf(root)
  const row = tasks.stages['queued-analysis'].find((entry) => entry.id === tagged.id)
  assert.ok(row)
  assert.equal(row.branch, 'feat/panel-badge')
  assert.equal(Object.keys(row).at(-1), 'branch', 'branch 是第 15 键')

  // 手工把记录里的 branch 改成非字符串：投影仍须是 null，不能把对象丢给面板。
  const file = path.join(root, '.agents', 'tasks', `${tagged.id}.json`)
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  record.source.branch = 42
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
  const again = await snapshotOf(root)
  const broken = again.tasks.stages['queued-analysis'].find((entry) => entry.id === tagged.id)
  assert.equal(broken.branch, null, '非字符串 branch 投影为 null')
})
