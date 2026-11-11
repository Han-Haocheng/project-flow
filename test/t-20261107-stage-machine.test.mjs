// task-60（P0）：九阶段状态机——**数据层**验收。
//
// 本卡只交付数据（阶段表 + 边 + status 派生 + 读投影默认），不捕获、不 guard、
// 不派工：插件行为与拆前完全一致。因此这里的断言只碰 `lib/stage.mjs` 与
// `lib/core.mjs` 的**投影/写入规则**，不假设任何流程自动化。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_STAGE,
  STAGE_IDS,
  STAGE_MACHINE,
  STAGE_ZH,
  actorForEdge,
  assertTransition,
  canTransition,
  edgeOf,
  nextStages,
  stageToStatus,
} from '../lib/stage.mjs'
import {
  FlowError,
  addTask,
  getTask,
  initProject,
  listTasks,
  loadContract,
  updateTask,
} from '../lib/core.mjs'

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-stage-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  const { contract } = loadContract(root)
  return { root, contract }
}

function taskFile(root, id) {
  return path.join(root, '.agents', 'tasks', `${id}.json`)
}

function readTaskFile(root, id) {
  return JSON.parse(fs.readFileSync(taskFile(root, id), 'utf8'))
}

/** byte+size+mtime fingerprint of the task store — proves a read path wrote nothing. */
function storeFingerprint(root) {
  const dir = path.join(root, '.agents', 'tasks')
  const out = {}
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name)
    const stat = fs.statSync(file)
    out[name] = `${stat.size}:${stat.mtimeMs}:${fs.readFileSync(file, 'utf8')}`
  }
  return out
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

function expectInvalid(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FlowError, `expected FlowError, got ${error?.name}: ${error?.message}`)
    assert.equal(error.code, 'invalid')
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

/** Legacy record written straight to disk: pre-`stage` shape, no `stage` key. */
function writeLegacyTask(root, id, overrides = {}) {
  const record = {
    schema: 1,
    id,
    title: '存量任务',
    type: 'feat',
    status: 'draft',
    owner: '',
    parent: null,
    scope: { allow: [], deny: [] },
    acceptance: [],
    checkpoints: [],
    commits: [],
    notes: '',
    created_at: '2026-01-01T09:00:00+08:00',
    updated_at: '2026-01-02T09:00:00+08:00',
    ...overrides,
  }
  fs.writeFileSync(taskFile(root, id), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

// ---------------------------------------------------------------- 1. 表逐项一致

test('① 阶段表：九个 id、中文名、from/next 互为逆、actor 与终态标记逐项一致', () => {
  assert.deepEqual([...STAGE_IDS], [
    'created', 'queued-analysis', 'analyzing', 'queued-implementation', 'implementing',
    'queued-review', 'reviewing', 'done', 'archived',
  ])
  assert.deepEqual(Object.keys(STAGE_MACHINE).sort(), [...STAGE_IDS].sort())
  assert.deepEqual(Object.keys(STAGE_ZH).sort(), [...STAGE_IDS].sort())
  assert.equal(DEFAULT_STAGE, 'created')

  const actors = new Set(['plugin', 'session', 'reviewer', null])
  for (const id of STAGE_IDS) {
    const node = STAGE_MACHINE[id]
    assert.equal(node.zh, STAGE_ZH[id], `${id} 的中文名必须与 STAGE_ZH 同源`)
    assert.ok(actors.has(node.actor), `${id} 的 actor 非法：${JSON.stringify(node.actor)}`)
    assert.ok(Array.isArray(node.next) && Array.isArray(node.from), `${id} 的 next/from 必须是数组`)
  }
  // 表头行（卡里的定稿）：后继与 actor 逐行一致
  assert.deepEqual(nextStages('created'), ['queued-analysis'])
  // queued-analysis 有两条同目标边：普通领取 + 汇总轮（normalizeTask，T-20261111170544）。
  assert.deepEqual(nextStages('queued-analysis'), ['analyzing', 'analyzing'])
  // T-20261111170544：汇总轮新增 analyzing → done（子任务全部完成后分析者收口）。
  assert.deepEqual(nextStages('analyzing'), ['queued-implementation', 'done'])
  assert.deepEqual(nextStages('queued-implementation'), ['implementing'])
  assert.deepEqual(nextStages('implementing'), ['queued-review'])
  assert.deepEqual(nextStages('queued-review'), ['reviewing'])
  assert.deepEqual(nextStages('reviewing'), ['done', 'queued-implementation'])
  assert.deepEqual(nextStages('done'), ['archived'])
  assert.deepEqual(nextStages('archived'), [])
  assert.equal(STAGE_MACHINE.created.actor, 'plugin')
  assert.equal(STAGE_MACHINE.analyzing.actor, 'session')
  assert.equal(STAGE_MACHINE.implementing.actor, 'session')
  assert.equal(STAGE_MACHINE.reviewing.actor, 'reviewer')
  assert.equal(STAGE_MACHINE.archived.terminal, true)

  // from 是 next 的逆向声明：两侧必须完全一致（防表漂移）
  for (const id of STAGE_IDS) {
    for (const nextId of nextStages(id)) {
      assert.ok(STAGE_MACHINE[nextId].from.includes(id), `${nextId}.from 缺少前驱 ${id}`)
    }
    for (const fromId of STAGE_MACHINE[id].from) {
      assert.ok(nextStages(fromId).includes(id), `${fromId}.next 缺少后继 ${id}`)
    }
  }
  // 除入口 created 外，每个阶段都至少有一个前驱
  assert.deepEqual([...STAGE_MACHINE.created.from], [])
  for (const id of STAGE_IDS.filter((stage) => stage !== 'created')) {
    assert.ok(STAGE_MACHINE[id].from.length > 0, `${id} 必须有前驱`)
  }
})

// ------------------------------------------------- 2. canTransition 正负例

test('② canTransition：相邻边可走，跳级/终态/非法 id 不可走，同阶段重写幂等', () => {
  // 正例：表里声明的每一条边都必须被认可
  for (const id of STAGE_IDS) {
    for (const nextId of nextStages(id)) {
      assert.equal(canTransition(id, nextId), true, `${id} → ${nextId} 应合法`)
    }
  }
  // 负例：跳级（每个阶段的"非后继"都必须被拒）
  assert.equal(canTransition('created', 'implementing'), false)
  assert.equal(canTransition('created', 'done'), false)
  assert.equal(canTransition('queued-analysis', 'implementing'), false, '待分析不能跳到实现')
  assert.equal(canTransition('queued-analysis', 'reviewing'), false, '待分析不能跳到审查')
  assert.equal(canTransition('queued-analysis', 'done'), false, '待分析不能跳到完成')
  assert.equal(canTransition('analyzing', 'reviewing'), false)
  assert.equal(canTransition('analyzing', 'implementing'), false, '分析中不能跳到实现中')
  assert.equal(canTransition('queued-implementation', 'queued-review'), false)
  assert.equal(canTransition('implementing', 'archived'), false)
  assert.equal(canTransition('queued-review', 'done'), false)
  // 负例：终态
  assert.equal(canTransition('archived', 'done'), false)
  assert.equal(canTransition('archived', 'created'), false)
  // 负例：非法 id（两侧都算）
  assert.equal(canTransition('bogus', 'done'), false)
  assert.equal(canTransition('done', 'bogus'), false)
  assert.equal(canTransition('', 'created'), false)
  // 幂等：同阶段重写不算跳转
  for (const id of STAGE_IDS) assert.equal(canTransition(id, id), true, `${id} 自重写应幂等通过`)
  // assertTransition：合法静默、非法抛 invalid 且**列出合法后继**
  assert.doesNotThrow(() => assertTransition('created', 'queued-analysis'))
  assert.doesNotThrow(() => assertTransition('reviewing', 'queued-implementation'))
  assert.throws(
    () => assertTransition('created', 'done'),
    (error) => error instanceof FlowError
      && error.code === 'invalid'
      && /created/.test(error.message)
      && /queued-analysis/.test(error.message),
    '拒绝必须点名合法后继',
  )
  assert.throws(
    () => assertTransition('archived', 'done'),
    (error) => error instanceof FlowError && error.code === 'invalid' && /terminal/.test(error.message),
  )
  assert.throws(
    () => assertTransition('bogus', 'done'),
    (error) => error instanceof FlowError && error.code === 'invalid' && /unknown stage/.test(error.message),
  )
})

// ------------------------------------------- 3. 唯一后退边必须被认可（且唯一）

test('③ reviewing → queued-implementation 是唯一后退边，必须被 canTransition 认可', () => {
  const order = new Map(STAGE_IDS.map((id, index) => [id, index]))
  const forward = []
  const backward = []
  for (const id of STAGE_IDS) {
    for (const nextId of nextStages(id)) {
      ;(order.get(nextId) > order.get(id) ? forward : backward).push(`${id} → ${nextId}`)
    }
  }
  assert.deepEqual(backward, ['reviewing → queued-implementation'], '后退边必须恰好一条')
  assert.ok(forward.length >= 7, `前向边应有 7 条以上，实际 ${forward.length}`)
  // 唯一后退边必须真的可走（打回路径），且仍可前进到 done（通过路径）
  assert.equal(canTransition('reviewing', 'queued-implementation'), true, '审查打回必须被认可')
  assert.equal(canTransition('reviewing', 'done'), true, '审查通过必须被认可')
  // 打回之后能继续实现
  assert.equal(canTransition('queued-implementation', 'implementing'), true)
  assert.doesNotThrow(() => assertTransition('reviewing', 'queued-implementation'))
})

// ---------------------------------------------- 4. stageToStatus 九项逐一

test('④ stageToStatus：九项映射逐一固定（created→draft，流水线→active，末两段同名）', () => {
  const expected = {
    created: 'draft',
    'queued-analysis': 'active',
    analyzing: 'active',
    'queued-implementation': 'active',
    implementing: 'active',
    'queued-review': 'active',
    reviewing: 'active',
    done: 'done',
    archived: 'archived',
  }
  assert.deepEqual(Object.keys(expected).sort(), [...STAGE_IDS].sort(), '映射表必须覆盖九个阶段')
  for (const id of STAGE_IDS) assert.equal(stageToStatus(id), expected[id], `${id} 的 status 派生错了`)
  // 非法 stage：与 core 的校验同一条文案（列九值）
  for (const bad of ['bogus', '', null, undefined, 1]) {
    assert.throws(
      () => stageToStatus(bad),
      (error) => error instanceof FlowError && error.code === 'invalid' && error.message.includes('queued-review'),
    )
  }
})

// --------------------------------------- 5. 写 stage 时 status 被派生并落盘

test('⑤ 写 stage → 同批派生 status 落盘；两者同给矛盾 → invalid；只写 status 仍可用', () => {
  const { root, contract } = freshProject('derive')

  // add 直接带 stage：status 派生并写进磁盘
  const created = addTask(root, contract, { type: 'feat', title: '实现中', stage: 'implementing' })
  assert.equal(created.status, 'active')
  assert.equal(created.stage, 'implementing')
  assert.equal(readTaskFile(root, created.id).status, 'active', '派生结果必须落盘')
  assert.equal(readTaskFile(root, created.id).stage, 'implementing')

  // update 写 stage：status 跟着变
  const queued = updateTask(root, contract, created.id, { stage: 'queued-review' })
  assert.equal(queued.status, 'active')
  assert.equal(readTaskFile(root, created.id).stage, 'queued-review')

  // 进入 done 阶段：status=done，且 done_at 由 stampTaskTimes 正常写入（未被派生逻辑绕过）
  const done = updateTask(root, contract, created.id, { stage: 'done' })
  assert.equal(done.status, 'done')
  assert.match(String(done.done_at), /\d{4}-\d{2}-\d{2}T/)
  assert.equal(readTaskFile(root, created.id).status, 'done')

  // 归档阶段同样派生
  const archived = updateTask(root, contract, created.id, { stage: 'archived' })
  assert.equal(archived.status, 'archived')

  // 两者同给且一致 → 允许
  const consistent = updateTask(root, contract, created.id, { stage: 'implementing', status: 'active' })
  assert.equal(consistent.status, 'active')

  // 两者同给且矛盾 → invalid（文案点明派生值与给定值）
  const other = addTask(root, contract, { type: 'feat', title: '矛盾' })
  expectInvalid(
    () => updateTask(root, contract, other.id, { stage: 'implementing', status: 'done' }),
    /stage implementing implies status active/,
  )
  assert.equal(readTaskFile(root, other.id).status, 'draft', '被拒绝的写入不得落盘')
  assert.equal(Object.hasOwn(readTaskFile(root, other.id), 'stage'), false)

  // 只写 status 仍然可用（既有调用方：归档 sweep / 心跳认领）。
  // 磁盘上不得补写 stage 键；**读投影按 status 反推**（task-68：done → done，
  // 否则 done 任务会被当成未完成、进待办栈顶）。
  const statusOnly = updateTask(root, contract, other.id, { status: 'done' })
  assert.equal(statusOnly.status, 'done')
  assert.equal(statusOnly.stage, 'done', '只写 status 时投影按 status 反推')
  assert.equal(Object.hasOwn(readTaskFile(root, other.id), 'stage'), false, '只写 status 不得在磁盘补 stage 键')
  assert.equal(Object.hasOwn(readTaskFile(root, other.id), 'stage'), false, '只写 status 也不得补写 stage 键')
})

// ------------------- 6. 存量无 stage：读投影补 created 且磁盘指纹不变（零写盘）

test('⑥ 存量无 stage 的记录：读投影按 status 反推（draft→created / active→queued-analysis），磁盘字节不动', () => {
  const { root, contract } = freshProject('legacy')
  writeLegacyTask(root, 'T-20260101-01', { status: 'draft' })
  writeLegacyTask(root, 'T-20260101-02', { status: 'active' })

  const before = storeFingerprint(root)
  const one = getTask(root, contract, 'T-20260101-01')
  const all = listTasks(root, contract)
  assert.equal(one.stage, 'created', 'draft 存量（缺 stage）投影为 DEFAULT_STAGE')
  assert.equal(one.status, 'draft', '读投影不得改写 status')
  assert.deepEqual(
    all.map((record) => record.stage).sort(),
    ['created', 'queued-analysis'],
    'active 存量反推为流水线最早阶段（task-68）',
  )
  assert.deepEqual(storeFingerprint(root), before, '读路径零写盘（bytes/size/mtime 全等）')

  // 改其它字段：既不补写 stage，也不清空 status
  const updated = updateTask(root, contract, 'T-20260101-01', { notes: '只改备注' })
  assert.equal(updated.stage, 'created', 'update 后读投影仍是 created')
  assert.equal(updated.status, 'draft')
  const onDisk = readTaskFile(root, 'T-20260101-01')
  assert.equal(Object.hasOwn(onDisk, 'stage'), false, '未给 stage 的写入不得凭空补键')
  assert.equal(onDisk.notes, '只改备注')

  // 只有显式写 stage 才会落盘
  updateTask(root, contract, 'T-20260101-02', { stage: 'analyzing' })
  const written = readTaskFile(root, 'T-20260101-02')
  assert.equal(written.stage, 'analyzing')
  assert.equal(written.status, 'active', '写 stage 时 status 派生落盘')
})

// --------------------------- 7. 非法 stage → invalid（CLI 侧同一映射 exit 2）

test('⑦ 非法 stage：invalid 且文案列出九值；CLI 的 invalid 映射是 exit 2', () => {
  const { root, contract } = freshProject('invalid')
  const task = addTask(root, contract, { type: 'feat', title: '非法阶段' })
  const nineValues = STAGE_IDS.join(', ')

  // core：add 与 update 两条写路径都拒绝，文案含全部九个值
  for (const bad of ['bogus', 'IN-PROGRESS', 'Analysing', '']) {
    expectInvalid(() => updateTask(root, contract, task.id, { stage: bad }), /stage must be one of/)
    expectInvalid(() => addTask(root, contract, { type: 'feat', title: 'x', stage: bad }), /stage must be one of/)
  }
  // 首尾空白会被 trim 成合法值（与 type/status 同一套归一），不是错误
  assert.equal(updateTask(root, contract, task.id, { stage: ' created ' }).stage, 'created')
  try {
    updateTask(root, contract, task.id, { stage: 'bogus' })
  } catch (error) {
    for (const id of STAGE_IDS) assert.ok(error.message.includes(id), `错误文案必须列出 ${id}`)
    assert.ok(error.message.includes(nineValues), '错误文案必须按顺序列出九值')
  }

  // CLI：stage 还没有 flag（本卡写域禁改 bin/flow.mjs），所以用**同一条 invalid 映射**
  // 验证退出码：status 的非法值走的是同一个 `FlowError('invalid')` 通道 → exit 2。
  const cli = runCli(root, ['task', 'update', task.id, '--status', 'bogus', '--json'])
  assert.equal(cli.code, 2, cli.stdout + cli.stderr)
  assert.equal(cli.json?.error?.code, 'invalid')
  assert.match(cli.json?.error?.message ?? '', /status must be one of/)
})

// ============================================================ task-69：边级 actor
//
// 结构变更、**零行为变更**：`next` 从 `string[]` 升级为带 actor 的边表。
// 行为不变由第 ⑫ 条的 9×9 矩阵锁死——任何"大部分对、个别边悄悄变了"都会红。

/**
 * 全部 11 条边（顺序即方案 §4 的表序；新增两条：
 * `analyzing → done` 汇总收口、`queued-analysis → analyzing{key:normalizeTask}` 汇总轮入口）。
 */
const EDGES = [
  { from: 'created', to: 'queued-analysis', actor: 'plugin', back: undefined },
  { from: 'queued-analysis', to: 'analyzing', actor: 'plugin', back: undefined },
  // T-20261111170544：同一目标的第二条边，靠 `key` 区分（汇总轮派工入口）。
  { from: 'queued-analysis', to: 'analyzing', actor: 'plugin', back: undefined, key: 'normalizeTask' },
  { from: 'analyzing', to: 'queued-implementation', actor: 'session', back: undefined },
  // T-20261111170544：汇总轮（子任务全部完成后分析者把父任务收口）。actor 与拆任务
  // 同为 session（汇总轮就是被重新派进来的分析者），因此不需要 actorOverride。
  { from: 'analyzing', to: 'done', actor: 'session', back: undefined },
  { from: 'queued-implementation', to: 'implementing', actor: 'plugin', back: undefined },
  { from: 'implementing', to: 'queued-review', actor: 'session', back: undefined },
  { from: 'queued-review', to: 'reviewing', actor: 'plugin', back: undefined },
  { from: 'reviewing', to: 'done', actor: 'reviewer', back: undefined },
  { from: 'reviewing', to: 'queued-implementation', actor: 'reviewer', back: true },
  { from: 'done', to: 'archived', actor: 'plugin', back: undefined },
]

test('⑧ 边表逐项：11 条边的 {from, to, actor} 与方案 §4 表一致', () => {
  for (const edge of EDGES) {
    const node = STAGE_MACHINE[edge.from]
    // 同目标边靠 `key` 区分：没有 key 的行必须命中**不带 key** 的那条边。
    const found = node.next.find((item) => item.to === edge.to && (item.key ?? undefined) === edge.key)
    assert.ok(found, `${edge.from} → ${edge.to} 边不见了`)
    assert.equal(found.actor, edge.actor, `${edge.from} → ${edge.to} 的 actor 错了`)
  }
  // 边总数 = 11（没有多出来的边）
  const total = STAGE_IDS.reduce((sum, id) => sum + STAGE_MACHINE[id].next.length, 0)
  assert.equal(total, EDGES.length, '边总数必须恰好 11 条（10 条阶段推进 + done→archived）')
})

test('⑨ back 标记：恰好一条，且就是 reviewing → queued-implementation', () => {
  const backs = []
  for (const id of STAGE_IDS) {
    for (const edge of STAGE_MACHINE[id].next) {
      if (edge.back === true) backs.push(`${id} → ${edge.to}`)
    }
  }
  assert.deepEqual(backs, ['reviewing → queued-implementation'], '后退边必须恰好一条')
  // back 只能是 true 或缺省（不许出现 back:false 这种半吊子写法）
  for (const id of STAGE_IDS) {
    for (const edge of STAGE_MACHINE[id].next) {
      if (Object.hasOwn(edge, 'back')) assert.equal(edge.back, true, `${id} → ${edge.to} 的 back 只能是 true`)
    }
  }
})

test('⑩ nextStages 是边表的投影，不是第二份数组', () => {
  for (const id of STAGE_IDS) {
    assert.deepEqual(
      nextStages(id),
      STAGE_MACHINE[id].next.map((edge) => edge.to),
      `${id}: nextStages 与边表不一致（不许另存一份）`,
    )
  }
  assert.deepEqual(nextStages('bogus'), [], '未知阶段返回空数组，不抛')
  assert.deepEqual(nextStages('archived'), [], '终态没有后继')
})

test('⑪ actorForEdge：11 条边逐条正确；非法边返回 null（不是 undefined、不抛）', () => {
  for (const edge of EDGES) {
    assert.equal(actorForEdge(edge.from, edge.to), edge.actor, `${edge.from} → ${edge.to}`)
  }
  for (const [from, to] of [
    ['created', 'done'], ['archived', 'done'], ['bogus', 'done'], ['created', 'bogus'],
    ['created', 'created'], // 自重写是幂等，不是边
  ]) {
    assert.equal(actorForEdge(from, to), null, `${from} → ${to} 必须是 null`)
  }
  // edgeOf 的对应关系
  assert.equal(edgeOf('reviewing', 'done').back, undefined)
  assert.equal(edgeOf('reviewing', 'queued-implementation').back, true)
  assert.equal(edgeOf('created', 'done'), null)
})

test('⑫ canTransition 零行为变更：9×9 全组合与硬编码真值表逐格相同', () => {
  // 行 = from、列 = to，顺序同 STAGE_IDS。自环一律 true（幂等），其余只认真实边。
  //            created q-ana  analyz q-impl  impl  q-rev  review  done  arch
  const TRUTH = [
    [true,  true,  false, false, false, false, false, false, false], // created
    [false, true,  true,  false, false, false, false, false, false], // queued-analysis
    [false, false, true,  true,  false, false, false, true,  false], // analyzing（拆任务 + 汇总收口）
    [false, false, false, true,  true,  false, false, false, false], // queued-implementation
    [false, false, false, false, true,  true,  false, false, false], // implementing
    [false, false, false, false, false, true,  true,  false, false], // queued-review
    [false, false, false, true,  false, false, true,  true,  false], // reviewing（打回 + 通过）
    [false, false, false, false, false, false, false, true,  true ], // done
    [false, false, false, false, false, false, false, false, true ], // archived
  ]
  assert.equal(TRUTH.length, STAGE_IDS.length)
  for (const row of TRUTH) assert.equal(row.length, STAGE_IDS.length, '真值表必须是 9×9')

  const mismatches = []
  STAGE_IDS.forEach((from, rowIndex) => {
    STAGE_IDS.forEach((to, columnIndex) => {
      const actual = canTransition(from, to)
      if (actual !== TRUTH[rowIndex][columnIndex]) {
        mismatches.push(`${from} → ${to}: 期望 ${TRUTH[rowIndex][columnIndex]}，实际 ${actual}`)
      }
    })
  })
  assert.deepEqual(mismatches, [], `canTransition 行为变了：${mismatches.join('; ')}`)
})

test('⑬ 两个后继可区分（本次改动的存在理由）', () => {
  // 通过 vs 打回：阶段表里它们的 actor 相同，靠 back 区分
  assert.equal(edgeOf('reviewing', 'done').back, undefined, '通过边不得标 back')
  assert.equal(edgeOf('reviewing', 'queued-implementation').back, true, '打回边必须标 back')
  assert.notDeepEqual(edgeOf('reviewing', 'done'), edgeOf('reviewing', 'queued-implementation'))
  // 打回边可继续实现（结构上仍是合法边）
  assert.equal(canTransition('reviewing', 'queued-implementation'), true)
  assert.equal(canTransition('reviewing', 'done'), true)
})

test('⑭ 不变式：每条边的 actor 等于其阶段默认 actor（显式覆盖除外）', () => {
  const offenders = []
  for (const id of STAGE_IDS) {
    for (const edge of STAGE_MACHINE[id].next) {
      // 显式单边特权：标注 actorOverride 的边由改动者自己负责同步阶段级 actor
      if (edge.actorOverride === true) continue
      if (edge.actor !== STAGE_MACHINE[id].actor) {
        offenders.push(`${id} → ${edge.to}: 边 actor=${edge.actor}，阶段 actor=${STAGE_MACHINE[id].actor}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `边的 actor 与阶段默认 actor 不一致：${offenders.join('; ')}。` +
      '若要给某条边单独开特权，请同时决定阶段级 actor 是否同步（或用 actorOverride: true 显式覆盖）。',
  )
  // 今天没有任何边走覆盖：一旦有人加了 actorOverride，这条会提醒去更新上面的不变式
  const overrides = STAGE_IDS.flatMap((id) => STAGE_MACHINE[id].next.filter((edge) => edge.actorOverride === true))
  assert.deepEqual(overrides, [], '今天不应存在 actorOverride（出现了就要把不变式的旁路也一起改）')
})
