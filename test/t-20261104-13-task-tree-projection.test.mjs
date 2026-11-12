// T-20261104-13 卡A A2：任务树投影（parent/depth + 队列头取根）。
//
// 投影只把树信息放在行上：active/draft 仍 created_at 升序 FIFO、recentDone
// 仍 updated_at 倒序；`depth` 沿 parent 链计算并截断到 3，父失效/成环按根 0；
// `tasks.current`（manifest 未声明时）取「最老的 active 根」，无根才退回 active[0]。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  addTask as addTaskCore,
  initProject,
  loadContract,
  removeTask,
  saveContract,
  updateTask,
} from '../lib/core.mjs'

/** T-15: `addTask` now requires `type`; fixtures default to feat (use addTaskCore to test the missing-type error). */
function addTask(root, contract, input = {}, options) {
  return addTaskCore(root, contract, { type: 'feat', ...input }, options)
}
import { buildSnapshot } from '../lib/state-snapshot.mjs'

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-tree-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  const { contract } = loadContract(root)
  return { root, contract }
}

const AT = (day, hour = 9) => `2026-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`

function task(root, contract, id, title, status, created, parent = null, updated = created) {
  return addTask(root, contract, {
    id,
    title,
    status,
    parent,
    created_at: created,
    updated_at: updated,
  })
}

async function snapshotOf(root) {
  return await buildSnapshot({
    root,
    realRoot: root,
    entry: { path: root, name: path.basename(root) },
    hostWarnings: [],
  })
}

const ids = (rows) => rows.map((row) => row.id)
const depths = (rows) => rows.map((row) => row.depth)
const parents = (rows) => rows.map((row) => row.parent)

test('任务树投影：三行链 depth 0/1/2，parent 正确且数组保持 FIFO', async () => {
  const { root, contract } = freshProject('chain')
  task(root, contract, 'T-20260101-01', 'A 根', 'active', AT(1))
  task(root, contract, 'T-20260101-02', 'B 子', 'active', AT(2), 'T-20260101-01')
  task(root, contract, 'T-20260101-03', 'C 孙', 'active', AT(3), 'T-20260101-02')

  const payload = await snapshotOf(root)
  assert.deepEqual(ids(payload.tasks.active), ['T-20260101-01', 'T-20260101-02', 'T-20260101-03'])
  assert.deepEqual(parents(payload.tasks.active), [null, 'T-20260101-01', 'T-20260101-02'])
  assert.deepEqual(depths(payload.tasks.active), [0, 1, 2])
  assert.equal(payload.tasks.current, 'T-20260101-01', '队列头取最老 active 根')
})

test('任务树投影：深层链截断到 3，不因超深抛错', async () => {
  const { root, contract } = freshProject('deep')
  task(root, contract, 'T-20260101-11', 'L0', 'active', AT(1))
  task(root, contract, 'T-20260101-12', 'L1', 'active', AT(2), 'T-20260101-11')
  task(root, contract, 'T-20260101-13', 'L2', 'active', AT(3), 'T-20260101-12')
  task(root, contract, 'T-20260101-14', 'L3', 'active', AT(4), 'T-20260101-13')
  task(root, contract, 'T-20260101-15', 'L4', 'active', AT(5), 'T-20260101-14')

  const payload = await snapshotOf(root)
  assert.deepEqual(ids(payload.tasks.active), [
    'T-20260101-11',
    'T-20260101-12',
    'T-20260101-13',
    'T-20260101-14',
    'T-20260101-15',
  ])
  assert.deepEqual(depths(payload.tasks.active), [0, 1, 2, 3, 3], 'depth 截断到 3')
})

test('任务树投影：父失效按根（depth 0）且不抛', async () => {
  const { root, contract } = freshProject('gone')
  task(root, contract, 'T-20260101-21', '父', 'active', AT(1))
  task(root, contract, 'T-20260101-22', '孤儿子', 'active', AT(2), 'T-20260101-21')
  removeTask(root, contract, 'T-20260101-21')

  const payload = await snapshotOf(root)
  assert.deepEqual(ids(payload.tasks.active), ['T-20260101-22'])
  assert.equal(payload.tasks.active[0].parent, null, '读路径把失效父按根投影')
  assert.equal(payload.tasks.active[0].depth, 0)
})

test('任务树投影：成环按根（depth 0）且不抛', async () => {
  const { root, contract } = freshProject('cycle')
  task(root, contract, 'T-20260101-31', '环 A', 'active', AT(1))
  task(root, contract, 'T-20260101-32', '环 B', 'active', AT(2), 'T-20260101-31')

  // 写路径拒绝成环，这里直接改盘模拟历史坏数据。
  const dir = path.join(root, '.agents', 'tasks')
  const aFile = path.join(dir, 'T-20260101-31.json')
  const a = JSON.parse(fs.readFileSync(aFile, 'utf8'))
  fs.writeFileSync(aFile, JSON.stringify({ ...a, parent: 'T-20260101-32' }))

  const payload = await snapshotOf(root)
  assert.deepEqual(ids(payload.tasks.active), ['T-20260101-31', 'T-20260101-32'])
  assert.deepEqual(parents(payload.tasks.active), [null, null], '成环两侧按根投影')
  assert.deepEqual(depths(payload.tasks.active), [0, 0])
})

test('队列头取根：更老的 active 子任务不能抢队首', async () => {
  const { root, contract } = freshProject('root-head')
  // A 先建（parent=null）但 created_at 更晚；B 更早但 parent=A。
  task(root, contract, 'T-20260101-41', '根 A', 'active', AT(5))
  task(root, contract, 'T-20260101-42', '子 B', 'active', AT(1), 'T-20260101-41')

  const payload = await snapshotOf(root)
  assert.deepEqual(ids(payload.tasks.active), ['T-20260101-42', 'T-20260101-41'], '数组仍按 created_at FIFO')
  assert.deepEqual(depths(payload.tasks.active), [1, 0])
  assert.equal(payload.tasks.current, 'T-20260101-41', 'current 取最老 active 根，而不是最老行')
})

test('队列头取根：父不在 active 集合时子任务算根', async () => {
  const { root, contract } = freshProject('cross-group')
  task(root, contract, 'T-20260101-51', '父（稍后完成）', 'active', AT(1))
  task(root, contract, 'T-20260101-52', '子 active', 'active', AT(2), 'T-20260101-51')
  /* legacy status 视图写入（盘上无 stage）：派生迁移不在边表里，按插件记账口径标 internal。 */
  updateTask(root, contract, 'T-20260101-51', { status: 'done' }, { source: 'internal' })

  const payload = await snapshotOf(root)
  const child = payload.tasks.active.find((row) => row.id === 'T-20260101-52')
  assert.ok(child, '子 active 仍在 active 组')
  assert.equal(child.depth, 1, 'depth 仍沿存在的父链计算')
  assert.equal(payload.tasks.current, 'T-20260101-52', '父不在 active 集合 → 子算根')
})

test('树投影不改既有排序：draft FIFO、recentDone updated 倒序、manifest current 优先', async () => {
  const { root, contract } = freshProject('order')
  task(root, contract, 'T-20260101-61', 'draft 旧', 'draft', AT(1))
  task(root, contract, 'T-20260101-62', 'draft 新', 'draft', AT(4), 'T-20260101-61')
  task(root, contract, 'T-20260101-63', 'done 旧', 'done', AT(2), null, AT(2))
  task(root, contract, 'T-20260101-64', 'done 新', 'done', AT(3), null, AT(7))

  const payload = await snapshotOf(root)
  assert.deepEqual(ids(payload.tasks.draft), ['T-20260101-61', 'T-20260101-62'])
  assert.deepEqual(depths(payload.tasks.draft), [0, 1])
  assert.deepEqual(ids(payload.tasks.recentDone), ['T-20260101-64', 'T-20260101-63'], 'recentDone 仍 updated 倒序')

  saveContract(root, { ...contract, tasks: { ...contract.tasks, current: 'notes/current.md' } })
  const declared = await snapshotOf(root)
  assert.equal(declared.tasks.current, 'notes/current.md', 'manifest 声明优先于根派生')
})
