// T-20261104-07 面板侧验收：归档是「状态位」，面板代码零改动就应该正确反映
//   1. `/state` 的 `tasks.counts` 同时给出 archived 与 done：归档后 done 减 1、
//      archived 加 1，而 `tasks.total` 不变（记录仍在，只是不再渲染成行）；
//   2. archived 记录不进 active / draft / recentDone 三个行数组（面板不渲染已归档行，
//      archived 只以「计数」形态出现在页脚/状态行里）；
//   3. 行对象字段与 `client.js` 现有投影一致（`index.js:784-960` 的
//      panelTaskRow / activeTasksOf / draftTasksOf / recentDoneOf）；
//   4. **读路径不归档**：sweep 之后才到期的 done 任务，连续两次 `/state` 仍是 done，
//      且 `.dsh/flow` 下文件内容与 mtime 一个字节都不变 —— 归档只由显式命令
//      （`flow task archive`）与门禁步触发，读端点保持只读（§9.1、brief §2 方案 A 被否）。
//
// fixture：`os.tmpdir()` + `core.initProject`；归档走 `core.archiveTasks`
// （卡 A 已落地，`lib/core.mjs:1961`），因此不需要手写 archived 记录——被 sweep 的
// 那条 done 就是「archived fixture」。面板侧用 `index.js` 的 `panelStateReader(ctx)`，
// 它是 HTTP `/api/project-flow/state` 与 TUI 面板共用的同一个投影函数，所以本文件
// 断言的就是真实客户端拿到的 payload。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addTask as addTaskCore, archiveTasks, getTask, initProject, loadContract } from '../lib/core.mjs'

/** T-15: `addTask` now requires `type`; fixtures default to feat (use addTaskCore to test the missing-type error). */
function addTask(root, contract, input = {}, options) {
  return addTaskCore(root, contract, { type: 'feat', ...input }, options)
}
import { panelStateReader } from '../index.js'

const DAY = 86_400_000
/** 面板行对象字段（`lib/state-snapshot.mjs:panelTaskRow` 的投影面，顺序即契约）。 */
const ROW_KEYS = [
  'id',
  'type',
  'title',
  'status',
  'owner',
  'notes',
  'scope',
  'acceptance',
  'commits',
  'created_at',
  'updated_at',
  'parent',
  'depth',
]

// 与 test/core.test.mjs 同一约定：用例结束清掉 tmpdir fixture。
const TEMP_ROOTS = []
after(() => {
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t07-panel-${label}-`))
  TEMP_ROOTS.push(root)
  return root
}

/** 最小已初始化项目（noGates 关掉默认门禁种子，只留 store 骨架）。 */
function freshProject(label) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true })
  return { root, contract: loadContract(root).contract }
}

/** `panelStateReader` 只需要一个能给出 workspaceRegistry 的 ctx（本 fixture 不注册任何行）。 */
function fixtureCtx() {
  return {
    get(id) {
      if (id === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
  }
}

const doneAt = (now, daysAgo) => new Date(now - daysAgo * DAY).toISOString()
const ids = (rows) => rows.map((row) => row.id)

/**
 * `.dsh/flow` 下每个文件的「内容 + mtime」快照：读路径若写盘（归档、刷新 updated_at、
 * 重建流文件），内容或 mtime 必然变化，因此这组断言能证明读端点零写入。
 */
function snapshotStore(root) {
  const dir = path.join(root, '.dsh', 'flow')
  const out = {}
  for (const relative of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, relative)
    const stat = fs.statSync(file)
    if (!stat.isFile()) continue
    out[relative.split(path.sep).join('/')] = {
      bytes: fs.readFileSync(file, 'utf8'),
      mtimeMs: stat.mtimeMs,
    }
  }
  return out
}

// ------------------------------------------------------- counts: done → archived

test('归档后 /state 计数：archived 计入、done 减少、total 不变', async () => {
  const { root, contract } = freshProject('counts')
  const now = Date.now()
  const active = addTask(root, contract, { title: 'still active', status: 'active' })
  const oldDone = addTask(root, contract, {
    title: 'old done (31d)',
    status: 'done',
    updated_at: doneAt(now, 31),
  })
  const freshDone = addTask(root, contract, {
    title: 'fresh done (2d)',
    status: 'done',
    updated_at: doneAt(now, 2),
  })

  const readState = panelStateReader(fixtureCtx())
  const before = await readState(root)
  assert.equal(before.ok, true, `fixture 读取失败：${JSON.stringify(before).slice(0, 400)}`)
  assert.equal(before.tasks.total, 3)
  assert.deepEqual(before.tasks.counts, { draft: 0, active: 1, done: 2, archived: 0, other: 0 })
  assert.deepEqual(ids(before.tasks.recentDone), [freshDone.id, oldDone.id], 'sweep 前两条 done 都应在 recentDone')

  const swept = archiveTasks(root, contract, { days: 30, now })
  assert.deepEqual(swept.archived, [oldDone.id], 'sweep 只应归档 30 天前那条 done')

  const after = await readState(root)
  assert.equal(after.ok, true, `归档后读取失败：${JSON.stringify(after).slice(0, 400)}`)
  assert.deepEqual(after.tasks.counts, { draft: 0, active: 1, done: 1, archived: 1, other: 0 })
  assert.equal(after.tasks.total, before.tasks.total, '归档不得改变 total（归档是状态位，不是删除）')
  assert.equal(after.tasks.counts.done, before.tasks.counts.done - 1, 'done 应减 1')
  assert.equal(after.tasks.counts.archived, before.tasks.counts.archived + 1, 'archived 应加 1')
  assert.equal(after.tasks.counts.other, 0, '不该出现 other 计数')
  assert.deepEqual(ids(after.tasks.recentDone), [freshDone.id], '归档后 recentDone 只应剩未归档的 done')
  assert.deepEqual(ids(after.tasks.active), [active.id], 'active 行不受归档影响')
})

// ------------------------------------------------- rows: archived 不渲染 + 形状

test('archived 不进 active/draft/recentDone，行形状与 client 期望一致', async () => {
  const { root, contract } = freshProject('rows')
  const now = Date.now()
  const active = addTask(root, contract, { title: 'active row', status: 'active' })
  const oldDone = addTask(root, contract, {
    title: 'archived row',
    status: 'done',
    updated_at: doneAt(now, 45),
  })
  const freshDone = addTask(root, contract, {
    title: 'fresh done row',
    status: 'done',
    updated_at: doneAt(now, 1),
  })
  assert.deepEqual(archiveTasks(root, contract, { days: 30, now }).archived, [oldDone.id])
  // 归档是状态位：记录本身还在，只是不再投影成面板行。
  assert.equal(getTask(root, contract, oldDone.id).status, 'archived')

  const payload = await panelStateReader(fixtureCtx())(root)
  assert.equal(payload.ok, true, `读取失败：${JSON.stringify(payload).slice(0, 400)}`)

  const rendered = [...payload.tasks.active, ...payload.tasks.draft, ...payload.tasks.recentDone]
  assert.ok(!ids(rendered).includes(oldDone.id), 'archived 记录出现在面板行数组里')
  assert.equal(payload.tasks.counts.archived, 1, 'archived 应以计数形态出现')
  assert.deepEqual(payload.tasks.draft, [], '本 fixture 没有 draft')
  assert.deepEqual(ids(payload.tasks.active), [active.id])
  assert.deepEqual(ids(payload.tasks.recentDone), [freshDone.id])

  // 行形状：client.js 读取的每个字段都在、键序逐字一致，且 status 与所在数组一致。
  // 顺序即契约，改一处必改三处（面板行 / host2-tools.taskRowOk / CONTRACT §9.1.4）。
  for (const row of payload.tasks.active) {
    assert.deepEqual(Object.keys(row), ROW_KEYS, `行键序/字段不符：${JSON.stringify(row)}`)
    assert.equal(typeof row.id, 'string')
    assert.equal(typeof row.type, 'string')
    // P2-1：type 必须是**记录自己的 type**，不是别的字符串字段——M1 = `clip(record.title)`
    // 曾让四个门禁（含本文件的 typeof 断言）全绿逃逸。夹具由 addTask({type:'feat'}) 建，
    // 且 title 与 'feat' 不同值，才有杀伤力（type===title 时 M1 假绿）。
    assert.equal(row.type, 'feat', `active 行 type 必须是记录 type（got ${JSON.stringify(row.type)}）`)
    assert.notEqual(row.type, row.title, 'type 与 title 必须可区分，否则取值断言无杀伤力')
    assert.equal(typeof row.title, 'string')
  }
  for (const row of payload.tasks.recentDone) {
    // recentDone 行尾再追加 gate（§784-960 投影）。
    assert.deepEqual(Object.keys(row), [...ROW_KEYS, 'gate'], `recentDone 行键序/字段不符：${JSON.stringify(row)}`)
    assert.equal(typeof row.id, 'string')
    assert.equal(typeof row.type, 'string')
    assert.equal(row.type, 'feat', `recentDone 行 type 必须是记录 type（got ${JSON.stringify(row.type)}）`)
    assert.notEqual(row.type, row.title, 'type 与 title 必须可区分，否则取值断言无杀伤力')
    assert.equal(typeof row.title, 'string')
  }
  assert.equal(payload.tasks.active[0].status, 'active')
  assert.equal(payload.tasks.recentDone[0].status, 'done')
  assert.ok(Object.hasOwn(payload.tasks.recentDone[0], 'gate'), 'recentDone 行应带 gate 字段（§784-960 投影）')

  // 其余 section 不因归档而消失/变空态：顶部信息与计数仍完整。
  assert.equal(typeof payload.generatedAt, 'string')
  assert.equal(payload.root, fs.realpathSync(root), 'payload.root 应是 canonical root')
  assert.equal(payload.roots[0].path, payload.root)
  // T-20261104-08 A+（D-20261104-09）：manifest 未声明 current 时由面板投影派生为
  // 队列头（最老 active 的 id），不再恒为 null。
  assert.equal(payload.tasks.current, active.id)
  assert.ok(Array.isArray(payload.gates), 'gates 应是数组')
  assert.ok(payload.decisions !== undefined, 'decisions section 应存在')
  assert.ok(payload.heartbeats !== undefined, 'heartbeats section 应存在')
})

// --------------------------------------------------- read path never archives

test('读路径不归档：sweep 后新到期的 done 两次 /state 仍是 done，且文件零写入', async () => {
  const { root, contract } = freshProject('readonly')
  const now = Date.now()
  addTask(root, contract, { title: 'active', status: 'active' })
  const oldDone = addTask(root, contract, {
    title: 'old done (40d)',
    status: 'done',
    updated_at: doneAt(now, 40),
  })
  addTask(root, contract, {
    title: 'fresh done (2d)',
    status: 'done',
    updated_at: doneAt(now, 2),
  })
  assert.deepEqual(archiveTasks(root, contract, { days: 30, now }).archived, [oldDone.id])

  // sweep 之后才出现的「到期」done：只有显式 sweep 能归档它，读路径必须原样保留。
  const late = addTask(root, contract, {
    title: 'late old done (45d, never swept)',
    status: 'done',
    updated_at: doneAt(now, 45),
  })
  assert.equal(getTask(root, contract, late.id).status, 'done')

  const before = snapshotStore(root)
  const readState = panelStateReader(fixtureCtx())
  const first = await readState(root)
  const second = await readState(root)
  const after = snapshotStore(root)

  assert.deepEqual(after, before, '读路径写了盘：存在归档或其他副作用')
  assert.deepEqual(second.tasks, first.tasks, '两次 /state 的 tasks 投影不稳定')
  assert.equal(first.ok, true, `读取失败：${JSON.stringify(first).slice(0, 400)}`)
  assert.equal(first.tasks.counts.archived, 1, '读路径不得自己再归档')
  assert.equal(first.tasks.counts.done, 2, '读路径把到期的 done 归档了（读端点必须只读）')
  assert.equal(first.tasks.total, 4, '读路径改变了 total')
  assert.equal(getTask(root, contract, late.id).status, 'done', '读路径改动了记录状态')
  assert.ok(!ids([...first.tasks.active, ...first.tasks.recentDone]).includes(oldDone.id), 'archived 仍出现在行数组里')
  // 迟到的到期记录在 sweep 之后才到期，因此计数里仍是 done，不是 archived。
  assert.ok(ids(first.tasks.recentDone).includes(late.id), '未 sweep 的到期 done 应仍作为 done 行出现')
})

// ------------------------------------------------- P2-1: 行 type 的取值契约

/**
 * P2-1：`row.type` 的**取值**断言（不只 `typeof`）。
 *
 * 背景（brief-p2-assertions §1）：M1 = `type: clip(record.title)` 曾让四个门禁全绿逃逸——
 * `typeof row.type === 'string'` 对 `title`/`notes`/`status` 同样成立，任何一次"投影到别的
 * 字符串字段"都能满足它。取值等值才是语义。本用例刻意造四种形态，分别钉死：
 *   1. 两种**不同** type（feat/fix）→ 杀掉"恒返回某个常量"的变异；
 *   2. 旧记录**无 type 键** → `''`（CONTRACT「缺失 → ''」）；
 *   3. `type: 42`（非字符串）→ `''`（CONTRACT「非字符串 → ''」）。
 * `addTask` 已强制 type（T-15），所以 2/3 两类只能手写记录文件（brief §2.3）。
 */
test('P2-1 行 type 取值：按记录投影，两种 type 可区分，缺失/非字符串降级为 ""', async () => {
  const { root, contract } = freshProject('type-values')
  const stamp = new Date().toISOString()
  // 1) 两种不同 type，均走真实写路径；title 与 type 不同值（否则 M1 假绿）。
  const featTask = addTask(root, contract, { type: 'feat', title: '甲：功能', status: 'active' })
  const fixTask = addTask(root, contract, { type: 'fix', title: '乙：修复', status: 'active' })
  assert.notEqual(featTask.type, featTask.title)
  assert.notEqual(fixTask.type, fixTask.title)
  assert.notEqual(featTask.type, fixTask.type, '夹具必须是两种不同 type，才能杀常量变异')

  // 2)/3) 手写记录：无 type 键、type 为非字符串。字段齐全以满足读路径。
  const tasksDir = path.join(root, '.dsh', 'flow', 'tasks')
  const legacy = { id: 'T-20200101-01', title: '旧记录无 type', status: 'active', created_at: stamp, updated_at: stamp, schema: 1 }
  const numeric = { id: 'T-20200101-02', title: 'type 是数字', type: 42, status: 'active', created_at: stamp, updated_at: stamp, schema: 1 }
  fs.writeFileSync(path.join(tasksDir, `${legacy.id}.json`), `${JSON.stringify(legacy, null, 2)}\n`)
  fs.writeFileSync(path.join(tasksDir, `${numeric.id}.json`), `${JSON.stringify(numeric, null, 2)}\n`)

  const payload = await panelStateReader(fixtureCtx())(root)
  assert.equal(payload.ok, true, `读取失败：${JSON.stringify(payload).slice(0, 400)}`)

  const rowOf = (id) => payload.tasks.active.find((row) => row.id === id)
  const featRow = rowOf(featTask.id)
  const fixRow = rowOf(fixTask.id)
  const legacyRow = rowOf(legacy.id)
  const numericRow = rowOf(numeric.id)
  assert.ok(featRow && fixRow && legacyRow && numericRow, '四个夹具都要出现在 active 行里')

  // 1) 取值等值：行上就是记录自己的 type，两种 type 各自可辨（恒常量变异会红在这里）。
  assert.equal(featRow.type, 'feat', `feat 行 type 错（got ${JSON.stringify(featRow.type)}）`)
  assert.equal(fixRow.type, 'fix', `fix 行 type 错（got ${JSON.stringify(fixRow.type)}）`)
  // 反 M1/M2：type 绝不能是 title / status / notes / id 里的任何一个。
  for (const [row, record] of [[featRow, featTask], [fixRow, fixTask]]) {
    for (const field of ['title', 'status', 'notes', 'id']) {
      const other = field === 'id' ? record.id : record[field]
      if (typeof other !== 'string' || other === '') continue
      assert.notEqual(row.type, other, `行 type 落到了记录的 ${field} 上（M1/M2 型回归）`)
    }
  }
  // 2)/3) 降级契约：缺失或非字符串一律投影为 ''（不是 null、不是 '42'、不是 undefined）。
  assert.equal(legacyRow.type, '', `无 type 键的记录必须投影为 ''（got ${JSON.stringify(legacyRow.type)}）`)
  assert.equal(numericRow.type, '', `type:42 必须投影为 ''（got ${JSON.stringify(numericRow.type)}）`)
})
