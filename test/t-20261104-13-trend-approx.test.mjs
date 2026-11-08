// T-20261104-13（task-162）：趋势 `≈` 近似标记必须活到 payload。
//
// 旧任务的 done_at/archived_at 由 `projectTaskTimes()` 在读投影里用 updated_at
// 物化；若没有标记，`deriveTrend` 会把「近似」当「精确」，estimatedFrom 恒 null。
// 三层验证：core 投影带标记且零写盘；deriveTrend 消费标记；GET state 集成非 null。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  getTask,
  initProject,
  listTasks,
  loadContract,
  readStoreState,
} from '../lib/core.mjs'
import { buildSnapshot, deriveTrend } from '../lib/state-snapshot.mjs'

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-trend-approx-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  return { root, contract: loadContract(root).contract }
}

/** Local calendar day key (`YYYY-MM-DD`) of one timestamp, matching deriveTrend. */
function localDayKey(iso) {
  const date = new Date(Date.parse(iso))
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Legacy (T-09 之前) task record: no done_at/archived_at, only updated_at. */
function legacyTask(id, status, extra = {}) {
  return {
    schema: 1,
    id,
    title: `旧任务 ${id}`,
    status,
    owner: '',
    goal: '',
    scope: { allow: [], deny: [] },
    acceptance: [],
    commits: [],
    notes: '',
    created_at: '2026-10-20T09:00:00+08:00',
    updated_at: '2026-10-31T09:00:00+08:00',
    ...extra,
  }
}

function writeTask(root, record) {
  const file = path.join(root, '.agents', 'tasks', `${record.id}.json`)
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return file
}

test('core 投影：旧 done/archived 记录带估计标记，且文件字节零写入', () => {
  const { root, contract } = freshProject('projection')
  const doneFile = writeTask(root, legacyTask('T-20261031-01', 'done'))
  const archivedFile = writeTask(root, legacyTask('T-20261031-02', 'archived'))
  const doneBytes = fs.readFileSync(doneFile, 'utf8')
  const archivedBytes = fs.readFileSync(archivedFile, 'utf8')

  const listed = listTasks(root, contract)
  const done = listed.find((item) => item.id === 'T-20261031-01')
  assert.equal(done.done_at, done.updated_at, '投影用 updated_at 回填 done_at（既有行为）')
  assert.equal(done.doneAtEstimated, true, '回填必须带 doneAtEstimated 标记')
  assert.equal(done.archivedAtEstimated, false)

  const archived = listed.find((item) => item.id === 'T-20261031-02')
  assert.equal(archived.doneAtEstimated, true, 'archived 也回填 done_at')
  assert.equal(archived.archivedAtEstimated, true, 'archived_at 同样标记为近似')

  const one = getTask(root, contract, 'T-20261031-01')
  assert.equal(one.doneAtEstimated, true)

  const state = readStoreState(root, contract)
  const fromState = state.tasks.items.find((item) => item.id === 'T-20261031-01')
  assert.equal(fromState.doneAtEstimated, true, 'readStoreState（面板/工具共用）同样带标记')

  assert.equal(fs.readFileSync(doneFile, 'utf8'), doneBytes, '读路径不得写回标记')
  assert.equal(fs.readFileSync(archivedFile, 'utf8'), archivedBytes)

  // 显式 done_at 的精确记录不出现任何估计标记。
  const exact = writeTask(root, legacyTask('T-20261031-03', 'done', { done_at: '2026-10-30T09:00:00+08:00' }))
  assert.equal(getTask(root, contract, 'T-20261031-03').doneAtEstimated, undefined)
  assert.equal(fs.readFileSync(exact, 'utf8').includes('Estimated'), false)
})

test('deriveTrend：投影标记让 estimatedFrom 指向最早近似日（精确记录仍 null）', () => {
  const { root, contract } = freshProject('derive')
  writeTask(root, legacyTask('T-20261031-01', 'done'))
  writeTask(root, legacyTask('T-20261031-02', 'archived', { updated_at: '2026-11-02T09:00:00+08:00' }))
  const projected = listTasks(root, contract)

  const trend = deriveTrend(projected, { now: Date.parse('2026-11-05T12:00:00+08:00'), days: 14 })
  assert.equal(trend.estimatedFrom, localDayKey('2026-10-31T09:00:00+08:00'), '最早近似日 = 旧 done 的 updated_at 日')
  const doneIndex = trend.done.findIndex((count) => count === 1)
  assert.ok(doneIndex >= 0, JSON.stringify(trend.done))
  assert.equal(trend.archived.reduce((sum, count) => sum + count, 0), 1)
  assert.ok(trend.archived.some((count) => count === 1), '旧 archived 记录进入 archived 桶')

  // 全部精确：estimatedFrom 必须为 null。
  const exact = [
    { ...legacyTask('T-20261031-04', 'done'), done_at: '2026-10-30T09:00:00+08:00' },
    { ...legacyTask('T-20261031-05', 'archived'), archived_at: '2026-11-01T09:00:00+08:00', done_at: '2026-10-30T09:00:00+08:00' },
  ]
  assert.equal(deriveTrend(exact, { now: Date.parse('2026-11-05T12:00:00+08:00') }).estimatedFrom, null)

  // 未投影的原始记录（无标记）走原有回退逻辑，仍标近似——不回退旧行为。
  const raw = [legacyTask('T-20261031-06', 'done')]
  assert.equal(
    deriveTrend(raw, { now: Date.parse('2026-11-05T12:00:00+08:00') }).estimatedFrom,
    localDayKey('2026-10-31T09:00:00+08:00'),
  )
})

test('GET state 集成：buildSnapshot 的 tasks.trend.estimatedFrom 不再是 null', async () => {
  const { root } = freshProject('payload')
  writeTask(root, legacyTask('T-20261031-01', 'done'))
  writeTask(root, legacyTask('T-20261031-02', 'archived'))
  writeTask(root, {
    ...legacyTask('T-20261101-01', 'active'),
    created_at: '2026-11-01T09:00:00+08:00',
    updated_at: '2026-11-01T09:00:00+08:00',
  })

  const payload = await buildSnapshot({
    root,
    realRoot: root,
    entry: { path: root, name: 'payload' },
    hostWarnings: [],
  })
  assert.equal(payload.ok, true, JSON.stringify(payload.error ?? payload.warnings ?? null))
  assert.equal(payload.tasks.trend.estimatedFrom, localDayKey('2026-10-31T09:00:00+08:00'))
  assert.equal(payload.tasks.trend.done.reduce((sum, count) => sum + count, 0), 1)
  assert.equal(payload.tasks.trend.archived.reduce((sum, count) => sum + count, 0), 1)
  assert.equal(payload.tasks.active[0].id, 'T-20261101-01')
})
