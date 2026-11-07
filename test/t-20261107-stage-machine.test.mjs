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
  assertTransition,
  canTransition,
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
  return path.join(root, '.dsh', 'flow', 'tasks', `${id}.json`)
}

function readTaskFile(root, id) {
  return JSON.parse(fs.readFileSync(taskFile(root, id), 'utf8'))
}

/** byte+size+mtime fingerprint of the task store — proves a read path wrote nothing. */
function storeFingerprint(root) {
  const dir = path.join(root, '.dsh', 'flow', 'tasks')
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
  assert.deepEqual([...STAGE_MACHINE.created.next], ['queued-analysis'])
  assert.deepEqual([...STAGE_MACHINE['queued-analysis'].next], ['analyzing'])
  assert.deepEqual([...STAGE_MACHINE.analyzing.next], ['queued-implementation'])
  assert.deepEqual([...STAGE_MACHINE['queued-implementation'].next], ['implementing'])
  assert.deepEqual([...STAGE_MACHINE.implementing.next], ['queued-review'])
  assert.deepEqual([...STAGE_MACHINE['queued-review'].next], ['reviewing'])
  assert.deepEqual([...STAGE_MACHINE.reviewing.next], ['done', 'queued-implementation'])
  assert.deepEqual([...STAGE_MACHINE.done.next], ['archived'])
  assert.deepEqual([...STAGE_MACHINE.archived.next], [])
  assert.equal(STAGE_MACHINE.created.actor, 'plugin')
  assert.equal(STAGE_MACHINE.analyzing.actor, 'session')
  assert.equal(STAGE_MACHINE.implementing.actor, 'session')
  assert.equal(STAGE_MACHINE.reviewing.actor, 'reviewer')
  assert.equal(STAGE_MACHINE.archived.terminal, true)

  // from 是 next 的逆向声明：两侧必须完全一致（防表漂移）
  for (const id of STAGE_IDS) {
    for (const nextId of STAGE_MACHINE[id].next) {
      assert.ok(STAGE_MACHINE[nextId].from.includes(id), `${nextId}.from 缺少前驱 ${id}`)
    }
    for (const fromId of STAGE_MACHINE[id].from) {
      assert.ok(STAGE_MACHINE[fromId].next.includes(id), `${fromId}.next 缺少后继 ${id}`)
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
    for (const nextId of STAGE_MACHINE[id].next) {
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
    for (const nextId of STAGE_MACHINE[id].next) {
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

  // 只写 status 仍然可用（既有调用方：归档 sweep / 心跳认领），stage 原样不动
  const statusOnly = updateTask(root, contract, other.id, { status: 'done' })
  assert.equal(statusOnly.status, 'done')
  assert.equal(statusOnly.stage, DEFAULT_STAGE, '只写 status 不得改动 stage')
  assert.equal(Object.hasOwn(readTaskFile(root, other.id), 'stage'), false, '只写 status 也不得补写 stage 键')
})

// ------------------- 6. 存量无 stage：读投影补 created 且磁盘指纹不变（零写盘）

test('⑥ 存量无 stage 的记录：读投影补 created，磁盘 bytes+size+mtime 一个字节都不动', () => {
  const { root, contract } = freshProject('legacy')
  writeLegacyTask(root, 'T-20260101-01', { status: 'draft' })
  writeLegacyTask(root, 'T-20260101-02', { status: 'active' })

  const before = storeFingerprint(root)
  const one = getTask(root, contract, 'T-20260101-01')
  const all = listTasks(root, contract)
  assert.equal(one.stage, 'created', '缺 stage 的读投影必须是 DEFAULT_STAGE')
  assert.equal(one.status, 'draft', '读投影不得改写 status')
  assert.deepEqual(all.map((record) => record.stage).sort(), ['created', 'created'])
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
