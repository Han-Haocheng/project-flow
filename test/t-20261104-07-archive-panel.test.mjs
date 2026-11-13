// T-20261104-07 面板侧验收：归档是「状态位」，面板代码零改动就应该正确反映
//   1. `/state` 的 `tasks.counts` 同时给出 archived 与 done：归档后 done 减 1、
//      archived 加 1，而 `tasks.total` 不变（记录仍在，只是不再渲染成行）；
//   2. archived 记录不进 active / draft / recentDone 三个行数组（面板不渲染已归档行，
//      archived 只以「计数」形态出现在页脚/状态行里）；
//   3. 行对象字段与 `client.js` 现有投影一致（`index.js:784-960` 的
//      panelTaskRow / activeTasksOf / draftTasksOf / recentDoneOf）；
//   4. **读路径不归档**：sweep 之后才到期的 done 任务，连续两次 `/state` 仍是 done，
//      且 `.agents/flow` 下文件内容与 mtime 一个字节都不变 —— 归档只由显式命令
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
import { fileURLToPath } from 'node:url'
import { addTask as addTaskCore, archiveTasks, getTask, initProject, loadContract } from '../lib/core.mjs'

/** T-15: `addTask` now requires `type`; fixtures default to feat (use addTaskCore to test the missing-type error). */
function addTask(root, contract, input = {}, options) {
  return addTaskCore(root, contract, { type: 'feat', ...input }, options)
}
import { cliPanelStateReader, cliStateSnapshotReader, panelStateReader, readAspectSection } from '../index.js'

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
  'stage',
  'branch',
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
 * `.agents/flow` 下每个文件的「内容 + mtime」快照：读路径若写盘（归档、刷新 updated_at、
 * 重建流文件），内容或 mtime 必然变化，因此这组断言能证明读端点零写入。
 */
function snapshotStore(root) {
  const dir = path.join(root, '.agents', 'flow')
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
  assert.deepEqual(before.tasks.counts, { draft: 0, active: 1, done: 2, archived: 0, cancelled: 0, other: 0 })
  assert.deepEqual(ids(before.tasks.recentDone), [freshDone.id, oldDone.id], 'sweep 前两条 done 都应在 recentDone')

  const swept = archiveTasks(root, contract, { days: 30, now })
  assert.deepEqual(swept.archived, [oldDone.id], 'sweep 只应归档 30 天前那条 done')

  const after = await readState(root)
  assert.equal(after.ok, true, `归档后读取失败：${JSON.stringify(after).slice(0, 400)}`)
  assert.deepEqual(after.tasks.counts, { draft: 0, active: 1, done: 1, archived: 1, cancelled: 0, other: 0 })
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
  const tasksDir = path.join(root, '.agents', 'tasks')
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
// --------------------------- 前端读路径：CLI 契约优先 + 只读降级（T-20261112154725）
//
// 前端不再由宿主进程直接读 `.agents/`：默认 spawn `flow state --json`（readPath=cli）；
// CLI 不可用时退回进程内只读直连（readPath=direct）并标 degraded + 原因，界面显式
// 显示「降级模式」。这两条把「主路径真的走了 CLI」和「降级真的被标注」钉住。

test('cliPanelStateReader：默认走后端 CLI 契约（readPath=cli），payload 可用', async () => {
  const { root, contract } = freshProject('cli-first')
  addTask(root, contract, { title: 'CLI 契约任务', status: 'active' })
  const payload = await cliPanelStateReader(fixtureCtx())(root)
  assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 400))
  assert.equal(payload.readPath, 'cli', '默认必须走 CLI，而不是进程内读')
  assert.equal(payload.degraded, undefined, 'CLI 正常时不得标降级')
  assert.equal(payload.root, root)
  assert.equal(payload.tasks.total, 1)
  assert.equal(payload.contract.name, 'cli-first')
})

test('cliPanelStateReader：CLI 失败时退回只读直连，并标 degraded + 原因', async () => {
  const { root, contract } = freshProject('cli-degraded')
  addTask(root, contract, { title: '降级仍在', status: 'active' })
  const readState = cliPanelStateReader(fixtureCtx(), {
    runCliState: async () => {
      throw new Error('spawn ENOENT flow')
    },
  })
  const payload = await readState(root)
  assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 400))
  assert.equal(payload.degraded, true, '降级必须被标注（否则界面看起来像正常）')
  assert.equal(payload.readPath, 'direct')
  assert.match(payload.degradedReason, /cli-unavailable/)
  assert.match(payload.degradedReason, /spawn ENOENT/, '降级原因要能看出是 CLI 起不来')
  assert.equal(payload.tasks.total, 1, '降级路径仍是只读直连，数据不能丢')
})

test('cliPanelStateReader：CLI 返回非对象信封同样降级，不把空 payload 交给面板', async () => {
  const { root } = freshProject('cli-junk')
  const payload = await cliPanelStateReader(fixtureCtx(), {
    runCliState: async () => 'not-an-envelope',
  })(root)
  assert.equal(payload.degraded, true)
  assert.equal(payload.readPath, 'direct')
  assert.match(payload.degradedReason, /non-object payload/)
})
// 前端包路径：本测试文件在 <repo>/test/ 下。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('前端包结构：四个前端文件没有直读 .agents 的 store 调用，主路径是 flow state --json', () => {
  const frontEnd = ['client.js', 'index.js', 'tui-panel.js', 'tui-host.js']
  const readCall = /\b(?:readFileSync|readFile|readdirSync|readdir)\s*\(/
  const offenders = []
  for (const name of frontEnd) {
    const source = fs.readFileSync(path.join(REPO, name), 'utf8')
    for (const line of source.split('\n')) {
      if (readCall.test(line) && (line.includes('.agents') || line.includes('flow.json'))) {
        offenders.push(name + ': ' + line.trim())
      }
    }
  }
  assert.deepEqual(offenders, [], '前端不得再有未标注降级的台账直读（改成走 CLI 契约）')

  // 主路径确实是后端 CLI 的 --json 契约，降级路径确实被标注。
  const index = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')
  assert.ok(index.includes("join(PACKAGE_ROOT, 'bin', 'flow.mjs')"), '必须 spawn 本包自带的 bin/flow.mjs')
  assert.ok(index.includes("'state', '--json'"), '主路径 must be flow state --json')
  assert.ok(index.includes('degraded = true'), '降级结果必须标 degraded')
  assert.ok(index.includes('cli-unavailable'), '降级原因必须写明是 CLI 不可用')

  // Web 侧的降级状态标记：页头 pill 的 key + 样式类都必须真的存在（不是只加 payload 字段）。
  const client = fs.readFileSync(path.join(REPO, 'client.js'), 'utf8')
  assert.ok(client.includes("'top.degraded'"), 'client 必须有降级文案 key')
  assert.ok(client.includes('project-flow-degraded'), 'client 必须渲染降级 pill 类名')
  assert.ok(client.includes('.project-flow-degraded{'), '降级 pill 必须有样式，不能裸 span')

  // T-20261112211817：aspect 锁卡的数据来自宿主富化段（不是浏览器直读），
  // 无锁/键缺席时整卡不挂载；样式只用主题 token。
  assert.ok(client.includes('function normalizeAspects'), 'client 必须归一宿主富化的 aspects 段')
  assert.ok(client.includes('aspects: normalizeAspects(src.aspects)'), 'aspects 必须在 normalize 里接入')
  assert.ok(client.includes('function AspectCard'), 'client 必须有 aspect 锁卡组件')
  assert.ok(client.includes("view.aspects\n              ? foldCard('aspects'"), 'aspect 卡只在有段且非空时挂载')
  for (const rule of ['.project-flow-aspects{', '.project-flow-aspectRow{', '.project-flow-aspectWaiters{']) {
    assert.ok(client.includes(rule), 'aspect 锁卡缺样式：' + rule)
  }
  const aspectCss = client
    .split('T-20261112211817')
    .filter((part) => part.includes('.project-flow-aspects{'))
    .join('\n')
    .split('.project-flow-aspectWaiters{')[1]
    .split('}')[0]
  assert.equal(/#[0-9a-fA-F]{3,8}|rgb\(/.test(aspectCss), false, 'aspect 卡样式只准用 --dsw-alias-* token（不许硬编码颜色）')
})
// ------------------- seam 形状的路由读（准备好、尚未接线）：CLI 优先 + 进程内兜底
//
// lib/host/state.mjs 的可注入读 seam 由 concurrency 在 T-20261112202457 落地；本文件先
// 钉住「将来要注入的那个 reader」的行为契约：result 是 {ok:true,payload}|{ok:false,…}，
// 不 throw；CLI 成功 readPath=cli；CLI 失败/坏载荷 → 进程内兜底并标 degraded。

test('cliStateSnapshotReader（seam 形状）：CLI 成功 → {ok:true,payload,readPath:cli}，预算 ≤900ms', async () => {
  const { root } = freshProject('seam-cli')
  const seen = []
  const reader = cliStateSnapshotReader(fixtureCtx(), {
    runCliState: async (requestedRoot, deadlineMs) => {
      seen.push({ requestedRoot, deadlineMs })
      return { ok: true, generatedAt: 'now', root: requestedRoot, tasks: { total: 0 } }
    },
  })
  const result = await reader({ root }, { deadlineMs: 1800 })
  assert.equal(result.ok, true)
  assert.equal(result.payload.readPath, 'cli')
  assert.equal(result.payload.root, root)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].requestedRoot, root)
  assert.ok(seen[0].deadlineMs >= 250 && seen[0].deadlineMs <= 900, 'CLI 只准拿 45% 预算（上限 900ms）')
})

test('cliStateSnapshotReader（seam 形状）：CLI 抛错 → 进程内兜底，标 degraded 且不 throw', async () => {
  const { root, contract } = freshProject('seam-degraded')
  addTask(root, contract, { title: '兜底数据', status: 'active' })
  const reader = cliStateSnapshotReader(fixtureCtx(), {
    runCliState: async () => {
      throw new Error('spawn ENOENT')
    },
  })
  const result = await reader({ root }, { deadlineMs: 1800 })
  assert.equal(result.ok, true)
  assert.equal(result.payload.degraded, true)
  assert.equal(result.payload.readPath, 'direct')
  assert.match(result.payload.degradedReason, /cli-unavailable/)
  assert.equal(result.payload.tasks.total, 1, '兜底仍返回真实只读数据')
})

test('cliStateSnapshotReader（seam 形状）：CLI 给非对象载荷 → 同样走兜底而不是把坏对象交出去', async () => {
  const { root } = freshProject('seam-junk')
  const reader = cliStateSnapshotReader(fixtureCtx(), { runCliState: async () => null })
  const result = await reader({ root }, { deadlineMs: 1800 })
  assert.equal(result.ok, true)
  assert.equal(result.payload.degraded, true)
  assert.match(result.payload.degradedReason, /non-object payload/)
})
// ----------------------------------- aspect 锁段富化（T-20261112211817）
//
// 数据只能来自 `flow aspect list --json`（不直读 .agents/aspect-locks/），宿主富化一次、
// web 与 TUI 共用；CLI 不可用时**不写 aspects 键**（面板据此整块隐藏）。

test('readAspectSection：正常数据归一（title 回填、ttl-only 段级标记、waiters 透传）', async () => {
  const data = {
    source: 'docs/module-domain.json',
    aspects: [{ id: 'semantics', title: '语义层', files: ['lib/stage.mjs'], ownerRole: 'semantics' }],
    locks: [{
      aspect: 'semantics',
      state: 'held',
      releasable: false,
      evidence: 'ttl-only',
      reason: 'ttl-fresh',
      leaseExpiresAt: '2026-11-12T21:40:00+08:00',
      ttlSeconds: 900,
      owner: { session: 'sess-1', pid: 42, acquired_at: '2026-11-12T21:25:00+08:00', renewed_at: '2026-11-12T21:30:00+08:00' },
      waiters: [{ session: 'sess-2', since: '2026-11-12T21:26:00+08:00' }],
      files: ['lib/stage.mjs'],
    }],
    counts: { total: 1, held: 1, releasable: 0, aspects: 1 },
  }
  const section = await readAspectSection('/tmp/does-not-matter', async () => data)
  assert.equal(section.available, true)
  assert.equal(section.livenessEvidence, 'ttl-only')
  assert.equal(section.source, 'docs/module-domain.json')
  assert.deepEqual(section.counts, { total: 1, held: 1, releasable: 0, aspects: 1 })
  const lock = section.items[0]
  assert.equal(lock.aspect, 'semantics')
  assert.equal(lock.title, '语义层', 'definitions 的 title 按 id 回填到行')
  assert.equal(lock.owner.session, 'sess-1')
  assert.equal(lock.evidence, 'ttl-only')
  assert.equal(lock.reason, 'ttl-fresh')
  assert.equal(lock.waiters.length, 1)
  assert.equal(lock.waiters[0].session, 'sess-2')
})

test('readAspectSection：CLI 不可用 / 坏载荷 → undefined（调用方不写 aspects 键）', async () => {
  const thrower = async () => {
    throw new Error('spawn ENOENT')
  }
  assert.equal(await readAspectSection('/tmp/x', thrower), undefined)
  assert.equal(await readAspectSection('/tmp/x', async () => null), undefined)
})

test('cliStateSnapshotReader：CLI state 成功时附带 aspects 段；aspect CLI 失败时整键缺席', async () => {
  const { root } = freshProject('aspect-enrich')
  const runCliState = async () => ({ ok: true, generatedAt: 'now', root, tasks: { total: 0 } })
  const withAspect = cliStateSnapshotReader(fixtureCtx(), {
    runCliState,
    runAspectList: async () => ({ locks: [], counts: { total: 0, held: 0, releasable: 0, aspects: 0 }, aspects: [] }),
  })
  const enriched = await withAspect({ root }, { deadlineMs: 1800 })
  assert.equal(enriched.ok, true)
  assert.equal(enriched.payload.aspects.available, true)
  assert.equal(enriched.payload.aspects.items.length, 0)

  const withoutAspect = cliStateSnapshotReader(fixtureCtx(), {
    runCliState,
    runAspectList: async () => { throw new Error('aspect cli down') },
  })
  const bare = await withoutAspect({ root }, { deadlineMs: 1800 })
  assert.equal(bare.ok, true)
  assert.equal(Object.hasOwn(bare.payload, 'aspects'), false, '族化失败必须整键缺席，不是 available:false')
})

// ---------------------------- aspect 判活：宿主注册表纠正 CLI 的 ttl-only（T-20261112211817）

test('aspect 判活：宿主注册表可用时，活 owner 从 ttl-only/dead 纠正为 registry/held', async () => {
  const { root } = freshProject('aspect-live')
  const ctx = {
    get(id) {
      if (id === 'workspaceRegistry') return { list: () => [] }
      if (id === 'agents') return { list: () => [{ id: 'sess-live' }] }
      return undefined
    },
  }
  const lease = new Date(Date.now() + 5 * 60_000).toISOString()
  const runAspectList = async () => ({
    aspects: [],
    locks: [{
      aspect: 'semantics',
      state: 'dead',
      releasable: true,
      evidence: 'ttl-only',
      leaseExpiresAt: lease,
      owner: { session: 'sess-live', pid: 999 },
      waiters: [],
      files: [],
    }],
    counts: { total: 1, held: 0, releasable: 1, aspects: 0 },
  })
  const read = cliStateSnapshotReader(ctx, {
    runCliState: async () => ({ ok: true, root, tasks: { total: 0 } }),
    runAspectList,
  })
  const payload = (await read({ root }, { deadlineMs: 1800 })).payload
  const item = payload.aspects.items[0]
  assert.equal(item.evidence, 'registry', '活会话的 evidence 必须升级为 registry')
  assert.equal(item.state, 'held', 'CLI 看到的 pid 已死是 CLI 进程，宿主注册表证明会话活着')
  assert.equal(item.releasable, false)
  assert.equal(payload.aspects.livenessEvidence, 'registry')
})

test('aspect 判活：活会话的租约真过期仍是 expired；注册表不可用时保持 CLI 的 ttl-only', async () => {
  const { root } = freshProject('aspect-live-expired')
  const withAgents = {
    get(id) {
      if (id === 'agents') return { list: () => [{ id: 'sess-live' }] }
      if (id === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
  }
  const expiredLease = new Date(Date.now() - 60_000).toISOString()
  const makeAspect = (lock) => async () => ({
    aspects: [],
    locks: [lock],
    counts: { total: 1, held: 0, releasable: 1, aspects: 0 },
  })
  const expiredLock = {
    aspect: 'cli',
    state: 'held',
    releasable: false,
    evidence: 'ttl-only',
    leaseExpiresAt: expiredLease,
    owner: { session: 'sess-live' },
    waiters: [],
    files: [],
  }
  const read = cliStateSnapshotReader(withAgents, {
    runCliState: async () => ({ ok: true, root, tasks: { total: 0 } }),
    runAspectList: makeAspect(expiredLock),
  })
  const payload = (await read({ root }, { deadlineMs: 1800 })).payload
  assert.equal(payload.aspects.items[0].state, 'expired', '租约到期优先于注册表存活')
  assert.equal(payload.aspects.livenessEvidence, 'registry')

  /* 没有 agents 服务的宿主（fixtureCtx）不得改写 CLI 结论。 */
  const bare = cliStateSnapshotReader(fixtureCtx(), {
    runCliState: async () => ({ ok: true, root, tasks: { total: 0 } }),
    runAspectList: makeAspect({ ...expiredLock, state: 'dead', releasable: true }),
  })
  const barePayload = (await bare({ root }, { deadlineMs: 1800 })).payload
  assert.equal(barePayload.aspects.items[0].evidence, 'ttl-only')
  assert.equal(barePayload.aspects.items[0].state, 'dead', '无注册表时保留 CLI 判活结果')
  assert.equal(barePayload.aspects.livenessEvidence, 'ttl-only')
})
test('aspect 判活：foreign 锁不因本机同名活会话被纠正（跨机器 id 撞车不算证据）', async () => {
  const { root } = freshProject('aspect-foreign')
  const ctx = {
    get(id) {
      if (id === 'agents') return { list: () => [{ id: 'sess-live' }] }
      if (id === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
  }
  const read = cliStateSnapshotReader(ctx, {
    runCliState: async () => ({ ok: true, root, tasks: { total: 0 } }),
    runAspectList: async () => ({
      aspects: [],
      locks: [{
        aspect: 'semantics',
        state: 'foreign',
        releasable: true,
        evidence: 'ttl-only',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        owner: { session: 'sess-live', host: 'other-machine|linux' },
        waiters: [],
        files: [],
      }],
      counts: { total: 1, held: 0, releasable: 1, aspects: 0 },
    }),
  })
  const payload = (await read({ root }, { deadlineMs: 1800 })).payload
  const item = payload.aspects.items[0]
  assert.equal(item.state, 'foreign', '另一台机器的锁不能按本机注册表改判')
  assert.equal(item.evidence, 'ttl-only')
  assert.equal(item.releasable, true)
  assert.equal(payload.aspects.livenessEvidence, 'ttl-only')
})
