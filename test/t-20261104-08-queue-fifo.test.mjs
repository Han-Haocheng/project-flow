// T-20261104-08 卡A+：事实队列 = FIFO。
//
// 用户拍板 D-20261104-09「队列与认领都改 FIFO」：
//   * 面板 active / draft 行按 `created_at` 升序（最老在前），最近完成仍按 `updated_at` 倒序；
//   * `tasks.current` 在 manifest 未声明时派生为「队列头」= active 里 created_at 最老的一条；
//   * `heartbeat start` 省略 --task 时按「最老的无主 active → 最老的无主 draft」认领。
// 关键性质：patch 一条老任务的字段（会刷新 updated_at）不得把它顶到队首。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  addTask as addTaskCore,
  initProject,
  listTasks,
  loadContract,
  saveContract,
  startHeartbeat,
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

// ------------------------------------------------------------------ helpers
function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-fifo-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  const { contract } = loadContract(root)
  return { root, contract }
}

function task(root, contract, id, title, status, createdAt, updatedAt, owner = '') {
  return addTask(root, contract, {
    id,
    title,
    status,
    owner,
    created_at: createdAt,
    updated_at: updatedAt,
  })
}

const AT = (day, hour = 9) => `2026-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`

async function snapshotOf(root) {
  return await buildSnapshot({ root, realRoot: root, entry: { path: root, name: path.basename(root) }, hostWarnings: [] })
}

const ids = (rows) => rows.map((row) => row.id)

// -------------------------------------------------------------------- cases
test('active 队列按 created_at 升序：patch 一条老任务不会把它顶到队首', async () => {
  const { root, contract } = freshProject('active-order')
  task(root, contract, 'T-20260101-01', '最老', 'active', AT(1), AT(2))
  task(root, contract, 'T-20260101-02', '中间', 'active', AT(3), AT(4))
  task(root, contract, 'T-20260101-03', '最新', 'active', AT(5), AT(6))

  const before = await snapshotOf(root)
  assert.deepEqual(ids(before.tasks.active), ['T-20260101-01', 'T-20260101-02', 'T-20260101-03'])

  // patch 最老的任务：updated_at 被刷新到最新，但 created_at 不变 → 队列位次不变。
  // ④ 之后 `title` 不可改，用可写的 `notes` 证明「字段变了但位次没变」。
  updateTask(root, contract, 'T-20260101-01', { notes: '刚改过' })
  const after = await snapshotOf(root)
  assert.deepEqual(ids(after.tasks.active), ['T-20260101-01', 'T-20260101-02', 'T-20260101-03'])
  assert.equal(after.tasks.active[0].notes, '刚改过')
  assert.equal(after.tasks.active[0].title, '最老', '④ 之后 title 不可改，patch 后仍是原标题')
})

test('draft 队列同样按 created_at 升序；最近完成仍按 updated_at 倒序', async () => {
  const { root, contract } = freshProject('draft-order')
  task(root, contract, 'T-20260101-04', '草稿旧', 'draft', AT(2), AT(5))
  task(root, contract, 'T-20260101-05', '草稿新', 'draft', AT(6), AT(3))
  task(root, contract, 'T-20260101-06', '完成旧', 'done', AT(1), AT(2))
  task(root, contract, 'T-20260101-07', '完成新', 'done', AT(1), AT(7))

  const payload = await snapshotOf(root)
  assert.deepEqual(ids(payload.tasks.draft), ['T-20260101-04', 'T-20260101-05'])
  assert.deepEqual(ids(payload.tasks.recentDone), ['T-20260101-07', 'T-20260101-06'], '完成行仍按 updated_at 倒序')
})

test('tasks.current：manifest 未声明时派生为队列头；声明时优先；无 active 时为 null', async () => {
  const { root, contract } = freshProject('current-derive')
  task(root, contract, 'T-20260101-08', '老 active', 'active', AT(1), AT(9))
  task(root, contract, 'T-20260101-09', '新 active', 'active', AT(4), AT(4))
  task(root, contract, 'T-20260101-10', '草稿', 'draft', AT(0), AT(0))

  const derived = await snapshotOf(root)
  assert.equal(derived.tasks.current, 'T-20260101-08', '队列头 = 最老 active 的 id')

  // manifest 显式声明时优先（原样回显，不做队列头派生）。
  saveContract(root, { ...contract, tasks: { ...contract.tasks, current: 'notes/current.md' } })
  const declared = await snapshotOf(root)
  assert.equal(declared.tasks.current, 'notes/current.md')

  // 没有 active 时退化为 null（manifest 未声明）。
  saveContract(root, { ...contract, tasks: { ...contract.tasks, current: null } })
  /* legacy status 视图写入（盘上无 stage）：派生迁移不在边表里，按插件记账口径标 internal。 */
  updateTask(root, contract, 'T-20260101-08', { status: 'done' }, { source: 'internal' })
  updateTask(root, contract, 'T-20260101-09', { status: 'done' }, { source: 'internal' })
  const none = await snapshotOf(root)
  assert.equal(none.tasks.current, null)
})

test('FIFO 与 updated_at 解耦：claim 取 created 最老（即使它的 updated_at 最旧）', () => {
  const { root, contract } = freshProject('claim-created-wins')
  // A = created 最老 + updated 最旧；B = created 较新 + updated 最新。若排序键退回
  // updated_at 倒序会误领 B，因此这条夹具能杀死该变异。
  const a = task(root, contract, 'T-20260101-16', 'A 最老', 'active', AT(1), AT(1))
  task(root, contract, 'T-20260101-17', 'B 较新', 'active', AT(2), AT(9))

  const record = startHeartbeat(root, contract, { session: 'session-i', agent: 'lead' })
  assert.equal(record.createdTask, null)
  assert.equal(record.task, a.id, 'created 最老者优先，updated_at 不参与认领排序')
})

test('tasks.current 派生与 updated_at 解耦：created 最老但 updated 最旧仍是队首', async () => {
  const { root, contract } = freshProject('current-created-wins')
  const a = task(root, contract, 'T-20260101-18', 'A 最老', 'active', AT(1), AT(1))
  task(root, contract, 'T-20260101-19', 'B 较新', 'active', AT(2), AT(9))

  const payload = await snapshotOf(root)
  assert.equal(payload.tasks.current, a.id, '队列头按 created_at，而不是 updated_at')
  assert.deepEqual(ids(payload.tasks.active), [a.id, 'T-20260101-19'])
})

test('draft FIFO 与 updated_at 解耦：created 最老但 updated 最旧者排第一', async () => {
  const { root, contract } = freshProject('draft-created-wins')
  // A = created 最老 + updated 最旧；B = created 较新 + updated 最新：updated_at 倒序
  // 会先排 B，与 FIFO 期望相反。
  const a = task(root, contract, 'T-20260101-20', '草稿 A', 'draft', AT(1), AT(1))
  task(root, contract, 'T-20260101-21', '草稿 B', 'draft', AT(2), AT(9))

  const payload = await snapshotOf(root)
  assert.deepEqual(ids(payload.tasks.draft), [a.id, 'T-20260101-21'])
})

test('heartbeat start：认领最老的无主 active（FIFO），不抢他人名下的任务', () => {
  const { root, contract } = freshProject('claim-fifo')
  task(root, contract, 'T-20260101-11', '最老 active', 'active', AT(1), AT(8))
  task(root, contract, 'T-20260101-12', '中间 active', 'active', AT(3), AT(3))
  task(root, contract, 'T-20260101-13', '最新 active', 'active', AT(5), AT(1))

  const first = startHeartbeat(root, contract, { session: 'session-a', agent: 'lead' })
  assert.equal(first.createdTask, null)
  assert.equal(first.task, 'T-20260101-11', '最老的无主 active 先被认领')
  assert.equal(first.goal, '最老 active')

  // 队首被别人持有后，下一个会话领到「第二老」，而不是最新那条。
  updateTask(root, contract, 'T-20260101-11', { owner: 'session-b' })
  const second = startHeartbeat(root, contract, { session: 'session-c', agent: 'lead' })
  assert.equal(second.createdTask, null)
  assert.equal(second.task, 'T-20260101-12')

  // 三条 active 都被他人持有 → 不抢，改为新建自己的 draft；createTask:false 时返回 null。
  updateTask(root, contract, 'T-20260101-12', { owner: 'session-d' })
  updateTask(root, contract, 'T-20260101-13', { owner: 'session-e' })
  const created = startHeartbeat(root, contract, { session: 'session-f', agent: 'lead' })
  assert.equal(created.task, created.createdTask, '没有可认领时才新建')
  assert.notEqual(created.createdTask, null)
  assert.equal(listTasks(root, contract).find((record) => record.id === created.createdTask)?.owner, 'session-f')

  const noCreate = startHeartbeat(root, contract, {
    session: 'session-g',
    agent: 'lead',
    createTask: false,
  })
  assert.equal(noCreate.createdTask, null)
  assert.equal(noCreate.task, null, '无主 active 都被占用且不允许新建时不抢')
})

test('heartbeat start：有最老的无主 draft 时优先无主 active（active 队列先出）', () => {
  const { root, contract } = freshProject('claim-active-first')
  task(root, contract, 'T-20260101-14', '草稿更老', 'draft', AT(1), AT(1))
  task(root, contract, 'T-20260101-15', 'active 较新', 'active', AT(5), AT(5))

  const record = startHeartbeat(root, contract, { session: 'session-h', agent: 'lead' })
  assert.equal(record.task, 'T-20260101-15', '先认领无主 active，再退到无主 draft')
})
