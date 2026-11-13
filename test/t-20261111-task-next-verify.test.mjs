// 2026-11-11（task-2）：「下一步由机器给出」+「验收可执行」。
//
// 用户目标：减少模型推理——`flow task next` 只查表就给出目标阶段/actor/动作/验证
// 命令，`flow task verify` 按 acceptance 里的 cmd:/gate: 真跑并回填结论，阶段门在
// 进入 reviewing/done 前强制要求"验证通过"。
//
// 本文件守四层：
//   ① doctrine 与边表一一对应（少一条边/多一条幽灵键都红）；
//   ② `flow task next` 的输出与退出码（终态/未知 id 必须非 0）；
//   ③ `flow task verify` 的执行/回填/退出码（纯 node 子进程，无新增依赖）；
//   ④ 阶段门 + 向后兼容（纯文本验收只警告；老记录没有 verification 键也照常读）。
//
// 只写 os.tmpdir() 下的一次性项目；每个用例自带 root，互不共享状态。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  addTask,
  drainWarnings,
  getTask,
  initProject,
  loadContract,
  updateTask,
} from '../lib/core.mjs'
import { STAGE_EDGE_DOCTRINE, STAGE_IDS, STAGE_MACHINE, actorForEdge, edgeDoctrineKey, edgeOf, stageNextStep } from '../lib/stage.mjs'

/* claim 协议切换点后新建的卡不再享受 legacy：测试夹具种上已闭合回执（内部写，不跑门）。 */
const CLAIM_FIXTURE_AT = '2026-11-13T16:00:00+08:00'
function seedClaims(root, contract, id) {
  updateTask(root, contract, id, {
    checkpoints: [
      { kind: 'dispatch', role: 'implementer', childId: 'fixture-impl', provider: 'test', from: 'queued-implementation', to: 'implementing', at: CLAIM_FIXTURE_AT },
      { kind: 'dispatch', role: 'reviewer', childId: 'fixture-review', provider: 'test', from: 'queued-review', to: 'reviewing', at: CLAIM_FIXTURE_AT },
    ],
  }, { source: 'internal' })
}

import { acceptancePlan, recordTaskVerification, verificationStateOf } from '../lib/tasks/records.mjs'
import { vetoSubtask } from '../lib/veto.mjs'

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

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flow-next-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function freshProject(label) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true })
  return { root, contract: loadContract(root).contract }
}

function runCli(cwd, args) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env, timeout: 60000 })
  let json = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = null
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

/** 写 acceptance 只能走记录写入路径（CLI 没有 --acceptance），这里用 core 直写。 */
function setAcceptance(root, contract, id, acceptance) {
  return updateTask(root, contract, id, { acceptance }, { source: 'internal' })
}

function readTaskOnDisk(root, id) {
  return JSON.parse(fs.readFileSync(path.join(root, '.agents', 'tasks', `${id}.json`), 'utf8'))
}

function addTaskCli(root, args) {
  const result = runCli(root, ['task', 'add', ...args, '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  return result.json.data
}

// ================================================================= ① 边表 ↔ 说明

test('doctrine：每条合法边都有动作/验证说明，且没有幽灵键', () => {
  const edges = []
  for (const [stage, node] of Object.entries(STAGE_MACHINE)) {
    // 同目标边靠 `key` 区分（queued-analysis → analyzing 的汇总轮入口），键因此带后缀。
    for (const edge of node.next) edges.push(edgeDoctrineKey(stage, edge))
  }
  // 正例守护：边表真的读到了，否则下面的集合比较会假绿。
  assert.equal(
    edges.length,
    19,
    `边表应有 19 条边（含汇总收口/汇总回边与 7 条撤销边），实际 ${edges.length}`,
  )
  const declared = Object.keys(STAGE_EDGE_DOCTRINE)
  assert.deepEqual(
    [...declared].sort(),
    [...edges].sort(),
    'doctrine 与边表必须一一对应（少一条边说明会漏提示，多一条说明边被删了却没删说明）',
  )
  for (const key of edges) {
    const doctrine = STAGE_EDGE_DOCTRINE[key]
    assert.equal(typeof doctrine.action, 'string')
    assert.ok(doctrine.action.trim() !== '', `${key} 缺少必做动作说明`)
    assert.ok(doctrine.verify === null || typeof doctrine.verify === 'string', `${key} 的 verify 只能是 null/string`)
  }
})

test('stageNextStep：单出边直给；reviewing 的两条边分主推荐/回退边', () => {
  const implementing = stageNextStep('implementing')
  assert.equal(implementing.terminal, false)
  assert.equal(implementing.primary.stage, 'queued-review')
  assert.equal(implementing.primary.actor, 'session')
  assert.equal(implementing.primary.back, false)
  // T-20261112151356：主推荐仍是实现收口；汇总回边作为备选（插件推进）出现。
  assert.deepEqual(
    implementing.alternatives.map((row) => ({ stage: row.stage, actor: row.actor, back: row.back, key: row.key })),
    [
      { stage: 'queued-analysis', actor: 'plugin', back: false, key: 'aggregateRound' },
      { stage: 'cancelled', actor: 'session', back: false, key: undefined },
    ],
  )
  assert.match(implementing.alternatives[0].action, /汇总/)
  assert.match(implementing.alternatives[0].action, /done\/archived/)
  assert.equal(implementing.alternatives[0].verify, null, '汇总回边由插件推进，没有人的验证命令')
  assert.match(implementing.primary.command, /flow task update \{id\} --stage queued-review/)
  assert.match(implementing.primary.verify, /flow task verify \{id\}/)

  const reviewing = stageNextStep('reviewing')
  assert.equal(reviewing.primary.stage, 'done', '主推荐必须是非回退边')
  assert.equal(reviewing.primary.actor, 'reviewer')
  assert.equal(reviewing.alternatives.length, 2)
  assert.equal(reviewing.alternatives[0].stage, 'queued-implementation')
  assert.equal(reviewing.alternatives[0].back, true, '回退边必须由边表的 back 标记识别，不能靠猜')
  assert.equal(reviewing.alternatives[1].stage, 'cancelled', '撤销是备选边（非主推荐）')

  const archived = stageNextStep('archived')
  assert.equal(archived.terminal, true)
  assert.equal(archived.primary, null)
  assert.deepEqual(archived.alternatives, [])
})

test('汇总回边：边/actor/doctrine 齐备，且它不是打回边', () => {
  // T-20261112151356：声明的是写入层早已在走的边（implementing → queued-analysis）。
  const edge = edgeOf('implementing', 'queued-analysis')
  assert.ok(edge !== null, '汇总回边必须存在')
  assert.equal(edge.key, 'aggregateRound')
  assert.equal(edge.actorOverride, true, '阶段默认 actor 是 session，汇总回边必须显式覆盖')
  assert.equal(edge.back, undefined, '汇总回边不是审查打回边')
  assert.equal(actorForEdge('implementing', 'queued-analysis'), 'plugin')
  assert.ok(STAGE_MACHINE['queued-analysis'].from.includes('implementing'), '逆向声明必须同步')
  // doctrine：谁推 + 条件 + 未满足时的行为，必须写清（verify 为 null = 插件自动推进）
  const doctrine = STAGE_EDGE_DOCTRINE['implementing>queued-analysis:aggregateRound']
  assert.equal(typeof doctrine, 'object')
  assert.match(doctrine.action, /插件/, '必须写明谁推')
  assert.match(doctrine.action, /汇总/)
  assert.match(doctrine.action, /done\/archived|未终态/)
  assert.equal(doctrine.verify, null)
})

test('task next：implementing 的备选行是汇总回边（插件/汇总轮），主推荐不变', () => {
  const { root, contract } = freshProject('next-aggregate')
  const task = addTask(root, contract, { type: 'feat', title: '实现中', stage: 'implementing' })
  const result = runCli(root, ['task', 'next', task.id])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /下一步  → 待审查（queued-review）  session/, '主推荐仍是实现收口')
  assert.match(result.stdout, /备选    → 待分析（queued-analysis）  plugin/)
  assert.match(result.stdout, /汇总/)
})

test('stageNextStep：未知阶段抛 invalid 并列出九个 id', () => {
  assert.throws(
    () => stageNextStep('nope'),
    (error) => error.code === 'invalid' && STAGE_IDS.every((id) => error.message.includes(id)),
  )
})

// =============================================================== ② task next CLI

test('task next：implementing → 固定的一段"下一步"（含 actor/动作/命令/验证）', () => {
  const { root, contract } = freshProject('next-human')
  const task = addTask(root, contract, { type: 'feat', title: '下一步', stage: 'implementing' })
  const result = runCli(root, ['task', 'next', task.id])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /实现中（implementing）/)
  assert.match(result.stdout, /下一步  → 待审查（queued-review）  session/)
  assert.match(result.stdout, /动作    实现收口/)
  assert.match(result.stdout, new RegExp(`命令    flow task update ${task.id} --stage queued-review`))
  assert.match(result.stdout, new RegExp(`验证    flow task verify ${task.id}`))
})

test('task next --json：形状稳定（next/alternatives/acceptance），机器可直接执行', () => {
  const { root, contract } = freshProject('next-json')
  const task = addTask(root, contract, { type: 'feat', title: 'JSON', stage: 'reviewing' })
  const result = runCli(root, ['task', 'next', task.id, '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const data = result.json.data
  assert.equal(data.id, task.id)
  assert.equal(data.stage, 'reviewing')
  assert.equal(data.terminal, false)
  assert.deepEqual(Object.keys(data.next).sort(), ['action', 'actor', 'back', 'command', 'stage', 'stageZh', 'verify'])
  assert.equal(data.next.stage, 'done')
  assert.equal(data.next.actor, 'reviewer')
  assert.equal(data.next.verify, `flow task verify ${task.id}`)
  assert.equal(data.alternatives.length, 2)
  assert.equal(data.alternatives[0].stage, 'queued-implementation')
  assert.equal(data.alternatives[1].stage, 'cancelled')
  assert.equal(data.acceptance.executable, 0)
  assert.equal(data.acceptance.passed, false)
})

test('task next：终态（done / archived）给明确提示并退非 0', () => {
  const { root, contract } = freshProject('next-terminal')
  const done = addTask(root, contract, { type: 'feat', title: '完成', stage: 'done' })
  const archived = addTask(root, contract, { type: 'feat', title: '归档', stage: 'archived' })

  const a = runCli(root, ['task', 'next', done.id, '--json'])
  assert.equal(a.code, 3, '终态必须退非 0（3）')
  assert.equal(a.json.ok, false)
  assert.equal(a.json.error.code, 'terminal')
  assert.equal(a.json.error.next, null)
  assert.equal(a.json.error.stage, 'done')

  const b = runCli(root, ['task', 'next', archived.id])
  assert.equal(b.code, 3)
  assert.match(b.stderr, /已归档（archived）：终态，没有下一步/)
})

test('task next：未知 id 退 3；不支持 flag 退 1 且点名', () => {
  const { root } = freshProject('next-badid')
  assert.equal(runCli(root, ['task', 'next', 'T-29991231-01']).code, 3)
  const bad = runCli(root, ['task', 'next', 'T-29991231-01', '--owner', 'x'])
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /task next 不支持 --owner/)
})

// ============================================================= ③ task verify CLI

test('task verify：按 acceptance 顺序跑 cmd，通过则 rc0 并把回执写进 verification', () => {
  const { root, contract } = freshProject('verify-pass')
  const marker = path.join(root, 'order.txt')
  const task = addTask(root, contract, { type: 'feat', title: '顺序', stage: 'implementing' })
  setAcceptance(root, contract, task.id, [
    '人工验收（自由文本，不执行）',
    `cmd:node -e "require('fs').appendFileSync('${marker}', 'a')"`,
    `cmd:node -e "require('fs').appendFileSync('${marker}', 'b')"`,
  ])

  const result = runCli(root, ['task', 'verify', task.id, '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.equal(result.json.data.ok, true)
  assert.equal(result.json.data.executed, 2, '自由文本条目不算可执行')
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ab', '必须按 acceptance 里的顺序执行')

  const onDisk = readTaskOnDisk(root, task.id)
  assert.equal(onDisk.verification.ok, true)
  assert.equal(onDisk.verification.stage, 'implementing')
  assert.equal(onDisk.verification.steps.length, 2)
  assert.match(onDisk.verification.signature, /^[0-9a-f]{16}$/)
  // 回执写 verification，不往 checkpoints 里塞（面板/派工共用后者）。
  assert.deepEqual(onDisk.checkpoints, [])
})

test('task verify：失败退出 1，--json 的 error 里带每步明细与回执', () => {
  const { root, contract } = freshProject('verify-fail')
  const task = addTask(root, contract, { type: 'feat', title: '失败', stage: 'implementing' })
  setAcceptance(root, contract, task.id, ['cmd:node -e "console.error(1);process.exit(7)"'])

  const result = runCli(root, ['task', 'verify', task.id, '--json'])
  assert.equal(result.code, 1, '验收失败必须退非 0')
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'check-failed')
  assert.match(result.json.error.message, new RegExp(`flow task verify ${task.id}`))
  const summary = result.json.error.verification
  assert.equal(summary.ok, false)
  assert.equal(summary.steps[0].exit, 7)
  assert.deepEqual(summary.failed, ['cmd:node -e "console.error(1);process.exit(7)"'])
  assert.equal(readTaskOnDisk(root, task.id).verification.ok, false, '失败也要回填（证据不能丢）')
})

test('task verify：gate:<id> 走门禁；通过/失败/不存在都不静默', () => {
  const { root, contract } = freshProject('verify-gate')
  const gate = runCli(root, ['gate', 'add', '--id', 'ok-gate', '--title', '通过', '--phase', 'manual',
    '--step', 'run=node -e "process.exit(0)">>exit 0', '--json'])
  assert.equal(gate.code, 0, gate.stdout + gate.stderr)
  const failGate = runCli(root, ['gate', 'add', '--id', 'bad-gate', '--title', '失败', '--phase', 'manual',
    '--step', 'run=node -e "process.exit(9)">>exit 0', '--json'])
  assert.equal(failGate.code, 0, failGate.stdout + failGate.stderr)

  const task = addTask(root, contract, { type: 'feat', title: '门禁', stage: 'implementing' })
  setAcceptance(root, contract, task.id, ['gate:ok-gate'])
  assert.equal(runCli(root, ['task', 'verify', task.id]).code, 0)

  setAcceptance(root, contract, task.id, ['gate:bad-gate'])
  const failed = runCli(root, ['task', 'verify', task.id])
  assert.equal(failed.code, 1)
  assert.match(failed.stdout, /gate:bad-gate/)
  assert.match(failed.stdout, /门禁可单独查：flow gate run bad-gate/)

  setAcceptance(root, contract, task.id, ['gate:missing-gate'])
  const missing = runCli(root, ['task', 'verify', task.id])
  assert.equal(missing.code, 1, '跑不起来的门禁不能当成证据')
  assert.match(missing.stdout, /gate missing-gate not found/)
})

test('task verify：没有可执行验收项 → rc0、executed=0、不写回执（不假装验过）', () => {
  const { root, contract } = freshProject('verify-empty')
  const task = addTask(root, contract, { type: 'feat', title: '空验收', stage: 'implementing' })
  setAcceptance(root, contract, task.id, ['纯文本验收'])

  const result = runCli(root, ['task', 'verify', task.id, '--json'])
  assert.equal(result.code, 0)
  assert.equal(result.json.data.executed, 0)
  assert.equal(result.json.data.skipped, 'no-executable-acceptance')
  assert.equal(Object.hasOwn(readTaskOnDisk(root, task.id), 'verification'), false)
})

test('task verify：兼容 {cmd, expect} / {gate} 旧对象形态', () => {
  const { root, contract } = freshProject('verify-object')
  const task = addTask(root, contract, { type: 'feat', title: '对象形态', stage: 'implementing' })
  setAcceptance(root, contract, task.id, [
    { cmd: 'node -e "console.log(42)"', expect: 'contains: 42' },
    { cmd: 'node -e "console.log(1)"', expect: 'contains: 42' },
  ])
  const first = runCli(root, ['task', 'verify', task.id, '--json'])
  assert.equal(first.code, 1, 'expect 不满足必须算失败')
  assert.equal(first.json.error.verification.executed, 2)
  assert.equal(first.json.error.verification.passed, 1)
})

// =========================================================== ④ 阶段门与兼容性

test('阶段门：有可执行验收但没验证过 → 拒绝进入 reviewing，提示 flow task verify', () => {
  const { root, contract } = freshProject('gate-block')
  const task = addTask(root, contract, { type: 'feat', title: '门', stage: 'implementing' })
  seedClaims(root, contract, task.id)
  setAcceptance(root, contract, task.id, ['cmd:node -e "process.exit(0)"'])
  /* implementing → reviewing 不是直接边（T-20261112151328）：先过 queued-review。 */
  assert.equal(runCli(root, ['task', 'update', task.id, '--stage', 'queued-review']).code, 0)
  const result = runCli(root, ['task', 'update', task.id, '--stage', 'reviewing'])
  assert.equal(result.code, 2, '应被 acceptance gate 拒绝（invalid → 2）')
  assert.match(result.stderr, /acceptance gate: reviewing/)
  assert.match(result.stderr, new RegExp(`flow task verify ${task.id}`))
  assert.equal(readTaskOnDisk(root, task.id).stage, 'queued-review', '被拒的写入不得落盘')
})

test('阶段门：verify 通过后放行；验收被改动后记录失效（必须重跑）', () => {
  const { root, contract } = freshProject('gate-pass')
  const task = addTask(root, contract, { type: 'feat', title: '放行', stage: 'implementing' })
  seedClaims(root, contract, task.id)
  setAcceptance(root, contract, task.id, ['cmd:node -e "process.exit(0)"'])
  assert.equal(runCli(root, ['task', 'verify', task.id]).code, 0)
  assert.equal(runCli(root, ['task', 'update', task.id, '--stage', 'queued-review']).code, 0)
  assert.equal(runCli(root, ['task', 'update', task.id, '--stage', 'reviewing']).code, 0)

  // 改验收 → 签名变了 → done 被拒（拿旧结果当新证据是假绿）
  setAcceptance(root, contract, task.id, ['cmd:node -e "process.exit(1)"'])
  const stale = runCli(root, ['task', 'update', task.id, '--stage', 'done'])
  assert.equal(stale.code, 2)
  assert.match(stale.stderr, /验收记录已过期/)

  assert.equal(runCli(root, ['task', 'verify', task.id]).code, 1)
  assert.equal(runCli(root, ['task', 'update', task.id, '--stage', 'done']).code, 2)
})

test('阶段门：没有可执行验收项时默认只警告（放行 + 一条 warning）', () => {
  const { root, contract } = freshProject('gate-warn')
  drainWarnings()
  const task = addTask(root, contract, { type: 'feat', title: '纯文本', stage: 'implementing' })
  seedClaims(root, contract, task.id)
  setAcceptance(root, contract, task.id, ['人能看懂的验收标准'])
  updateTask(root, contract, task.id, { stage: 'queued-review' })
  const moved = updateTask(root, contract, task.id, { stage: 'reviewing' })
  assert.equal(moved.stage, 'reviewing', '默认策略是警告放行，不是拒绝')
  assert.match(drainWarnings().join('\n'), /task-acceptance-none: .*: 进入 reviewing 但没有可执行验收项/)
})

test('阶段门：tasks.requireAcceptance=strict 时，没有可执行验收项 → 拒绝', () => {
  const { root } = freshProject('gate-strict')
  const manifestPath = path.join(root, '.agents', 'flow', 'flow.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.tasks = { ...manifest.tasks, requireAcceptance: 'strict' }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const contract = loadContract(root).contract
  const task = addTask(root, contract, { type: 'feat', title: '严格', stage: 'implementing' })
  seedClaims(root, contract, task.id)
  setAcceptance(root, contract, task.id, ['人来判定的验收'])
  updateTask(root, contract, task.id, { stage: 'queued-review' })
  assert.throws(
    () => updateTask(root, contract, task.id, { stage: 'reviewing' }),
    (error) => error.code === 'invalid' && /没有可执行验收项/.test(error.message),
  )
})

test('阶段门：source=internal 的插件收口写豁免（sweep/迁移不该被验收拦住）', () => {
  const { root, contract } = freshProject('gate-internal')
  const task = addTask(root, contract, { type: 'feat', title: '内部写', stage: 'implementing' })
  setAcceptance(root, contract, task.id, ['cmd:node -e "process.exit(0)"'])
  const moved = updateTask(root, contract, task.id, { stage: 'done' }, { source: 'internal' })
  assert.equal(moved.stage, 'done')
})

test('向后兼容：老记录没有 verification 键照常读；verify 不改 acceptance/commits', () => {
  const { root, contract } = freshProject('back-compat')
  const legacy = addTask(root, contract, {
    type: 'fix',
    title: '老记录',
    stage: 'implementing',
    commits: ['abc123'],
  })
  // 模拟"手写记录"：直接落盘一个没有 verification 的旧形状。
  const file = path.join(root, '.agents', 'tasks', `${legacy.id}.json`)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete raw.verification
  raw.acceptance = ['cmd:node -e "process.exit(0)"']
  fs.writeFileSync(file, JSON.stringify(raw, null, 2))

  const read = getTask(root, contract, legacy.id)
  assert.equal(read.verification, undefined)
  const state = verificationStateOf(read)
  assert.equal(state.executable, 1)
  assert.equal(state.passed, false)
  assert.equal(runCli(root, ['task', 'verify', legacy.id]).code, 0)
  const after = readTaskOnDisk(root, legacy.id)
  assert.deepEqual(after.acceptance, raw.acceptance, 'verify 不得改写 acceptance')
  assert.deepEqual(after.commits, ['abc123'])
})

test('verification 字段：坏形状被拒（回执是机器事实，不允许手写成任意值）', () => {
  const { root, contract } = freshProject('verify-shape')
  const task = addTask(root, contract, { type: 'feat', title: '坏回执', stage: 'implementing' })
  const bad = [
    'not-an-object',
    { ok: 'yes', at: 'x', signature: 's', steps: [] },
    { ok: true, at: '', signature: 's', steps: [] },
    { ok: true, at: 'x', signature: '', steps: [] },
    { ok: true, at: 'x', signature: 's', steps: [{ kind: 'shell', target: 'x', ok: true }] },
    { ok: true, at: 'x', signature: 's', steps: [{ kind: 'cmd', target: '', ok: true }] },
  ]
  for (const verification of bad) {
    assert.throws(
      () => updateTask(root, contract, task.id, { verification }),
      (error) => error.code === 'invalid',
      `坏回执应被拒：${JSON.stringify(verification)}`,
    )
  }
})

test('recordTaskVerification：没有可执行验收项时拒绝写回执（签名不能是空的）', () => {
  const { root, contract } = freshProject('verify-empty-write')
  const task = addTask(root, contract, { type: 'feat', title: '空', stage: 'implementing' })
  assert.throws(
    () => recordTaskVerification(root, contract, task.id, { ok: true, signature: '', steps: [] }),
    (error) => error.code === 'invalid',
  )
})

test('acceptancePlan / verificationStateOf：签名只覆盖可执行条目，free-text 改动不影响有效性', () => {
  const { root, contract } = freshProject('plan-signature')
  const task = addTask(root, contract, { type: 'feat', title: '签名', stage: 'implementing' })
  setAcceptance(root, contract, task.id, ['说给人听的话', 'cmd:node -e "process.exit(0)"'])
  const plan = acceptancePlan(getTask(root, contract, task.id))
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.total, 2)

  const written = recordTaskVerification(root, contract, task.id, {
    ok: true,
    signature: plan.signature,
    steps: [{ index: 1, kind: 'cmd', target: 'node -e "process.exit(0)"', ok: true, exit: 0, durationMs: 1 }],
  })
  assert.equal(verificationStateOf(written).passed, true)

  // 只改自由文本：签名不变，验证仍然有效。
  const stillOk = updateTask(root, contract, task.id, { acceptance: ['换了个说法', 'cmd:node -e "process.exit(0)"'] })
  assert.equal(verificationStateOf(stillOk).passed, true)
})

// ================================================= ⑤ 回归：验收门的三个后门

test('回归 P1-1：legacy 记录的 `--status done` 不能绕过验收门（按投影阶段判定）', () => {
  const { root, contract } = freshProject('status-bypass')
  // 老记录（没有 stage 键）：读投影按 status 反推阶段。这正是原先的后门形态。
  const task = addTask(root, contract, { type: 'feat', title: 'status 后门', status: 'active' })
  setAcceptance(root, contract, task.id, ['cmd:node -e "process.exit(1)"'])
  assert.equal(getTask(root, contract, task.id).stage, 'queued-analysis')

  const result = runCli(root, ['task', 'update', task.id, '--status', 'done', '--json'])
  assert.equal(result.code, 2, `--status done 必须被验收门拒绝：${result.stdout}${result.stderr}`)

  const disk = readTaskOnDisk(root, task.id)
  assert.notEqual(disk.status, 'done', '被拒绝的写入不能落盘')
  assert.equal(disk.verification, undefined, '被拒绝的写入不能留下验证回执')
})

test('回归 P1-2：创建即 done 也要过验收门，且补 done_at', () => {
  const { root, contract } = freshProject('add-done')
  assert.throws(
    () =>
      addTask(root, contract, {
        type: 'feat',
        title: '直接完成',
        stage: 'done',
        acceptance: ['cmd:node -e "process.exit(1)"'],
      }),
    (error) => error.code === 'invalid',
    '带可执行验收项、创建即 done 必须被拒绝',
  )

  const plain = addTask(root, contract, { type: 'feat', title: '无验收直接完成', stage: 'done' })
  const disk = readTaskOnDisk(root, plain.id)
  assert.equal(typeof disk.done_at, 'string', '创建即 done 必须写 done_at')
  assert.ok(disk.done_at !== '')
})

test('回归 P1-3：子任务 veto 不被验收门误拦（source=internal）', () => {
  const { root, contract } = freshProject('veto-sub')
  const parent = addTask(root, contract, { type: 'feat', title: '父任务' })
  const child = addTask(root, contract, {
    type: 'feat',
    title: '子任务',
    parent: parent.id,
    acceptance: ['cmd:node -e "process.exit(1)"'],
  })

  vetoSubtask(root, contract, { taskId: child.id, reason: '不做了' })
  assert.equal(getTask(root, contract, child.id).stage, 'done', '子任务否决必须落到 done')
})

test('回归：插件派工进 reviewing 只警告不硬拦；reviewing→done 仍是硬门', () => {
  const { root, contract } = freshProject('plugin-review')
  const task = addTask(root, contract, { type: 'feat', title: '派工豁免', stage: 'implementing' })
  seedClaims(root, contract, task.id)
  setAcceptance(root, contract, task.id, ['cmd:node -e "process.exit(1)"'])
  updateTask(root, contract, task.id, { stage: 'queued-review' })

  const reviewing = updateTask(root, contract, task.id, { stage: 'reviewing' }, { source: 'plugin' })
  assert.equal(reviewing.stage, 'reviewing', '插件派工不能被验收门卡死')

  assert.throws(
    () => updateTask(root, contract, task.id, { stage: 'done' }, { source: 'plugin' }),
    (error) => error.code === 'invalid',
    'reviewing→done 是判定边，插件也不能带未验证的验收项通过',
  )
})
