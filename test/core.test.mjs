// project-flow core + CLI 回归测试。
//
// 只使用 os.tmpdir() 下的一次性目录（测试结束统一删除），绝不触碰任何真实项目。
// 需要 git 的迁移用例在同一临时目录里 `git init`，测试结束随目录一起删除。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FlowError,
  HEARTBEAT_STALE_SECONDS,
  SCHEMA_VERSION,
  addExperiment,
  addGate,
  addTask,
  drainWarnings,
  experimentTree,
  getExperiment,
  getGate,
  getTask,
  initProject,
  listExperiments,
  listGateRuns,
  listGates,
  listTasks,
  loadContract,
  migrateLegacyTasks,
  migrateTrailers,
  readHeartbeats,
  readStoreState,
  removeExperiment,
  removeGate,
  removeTask,
  runGate,
  saveContract,
  storePaths,
  updateExperiment,
  updateGate,
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
      // 清理失败不影响测试结论
    }
  }
})

// ------------------------------------------------------------------ helpers

function tempRoot(label = 'case') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `project-flow-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function freshProject(label = 'project') {
  const root = tempRoot(label)
  initProject(root, { name: label })
  const { contract } = loadContract(root)
  return { root, contract }
}

/** 本地时区的 YYYYMMDD（id 生成用同日历日，避免跨日 flake）。 */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function expectFlowError(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FlowError, `expected FlowError, got ${error?.name}: ${error?.message}`)
    assert.equal(error.code, code)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function commitWithMessage(root, file, message) {
  const full = path.join(root, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, `${message}\n`, 'utf8')
  git(root, ['add', '--', file])
  git(root, [
    '-c', 'user.name=Flow Test',
    '-c', 'user.email=flow-test@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '--no-verify', '-m', message,
  ])
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

// ------------------------------------------------------------- 契约与初始化

test('initProject 创建 schema 2 布局、契约与默认目录', () => {
  const root = tempRoot('init')
  const result = initProject(root, { name: 'demo' })

  assert.equal(result.root, path.resolve(root))
  assert.deepEqual(result.created, ['.dsh/flow/flow.json'])
  assert.deepEqual(result.imported, { trailers: 0, tasks: 0 })
  assert.deepEqual(result.warnings, [])

  const contract = readJson(path.join(root, '.dsh/flow/flow.json'))
  assert.equal(contract.schema, SCHEMA_VERSION)
  assert.equal(contract.schema, 2)
  assert.equal(contract.name, 'demo')
  assert.equal(contract.store.root, '.dsh/flow')
  assert.equal(contract.experiments.source, 'store')
  assert.equal(contract.tasks.source, 'json')
  assert.equal(contract.gates.logs, '.dsh/flow/logs')

  for (const rel of ['.dsh/flow/experiments', '.dsh/flow/tasks', '.dsh/flow/gates', '.dsh/flow/logs']) {
    assert.ok(fs.statSync(path.join(root, rel)).isDirectory(), `${rel} 应存在`)
  }

  const loaded = loadContract(root)
  assert.equal(loaded.source, '.dsh/flow/flow.json')
  assert.deepEqual(loaded.warnings, [])
})

test('initProject 幂等：重复初始化不覆盖，force 才重写；未初始化时 load 走 defaults', () => {
  const root = tempRoot('idempotent')
  const before = loadContract(root)
  assert.equal(before.source, 'defaults')
  assert.equal(before.contract.schema, 2)
  assert.equal(before.contract.name, path.basename(path.resolve(root)))

  initProject(root, { name: 'alpha' })
  const fresh = loadContract(root).contract
  assert.equal(Object.prototype.hasOwnProperty.call(fresh.experiments, 'groupBy'), false)
  const second = initProject(root, { name: 'beta' })
  assert.deepEqual(second.created, [])
  assert.ok(second.warnings.some((item) => item.startsWith('already-initialized')))
  assert.equal(loadContract(root).contract.name, 'alpha')

  initProject(root, { name: 'gamma', force: true })
  assert.equal(loadContract(root).contract.name, 'gamma')
})

test('saveContract 原子落盘并补齐默认值，未知字段保留', () => {
  const root = tempRoot('contract')
  const saved = saveContract(root, { name: 'custom', experiments: { dir: 'custom/experiments' }, extra: { keep: true } })

  assert.equal(saved.schema, 2)
  assert.equal(saved.experiments.dir, 'custom/experiments')
  /* `groupBy` 已从 schema 2 移除：默认值不再生成它。 */
  assert.equal(Object.prototype.hasOwnProperty.call(saved.experiments, 'groupBy'), false)
  assert.deepEqual(saved.extra, { keep: true })
  const loaded = loadContract(root)
  assert.equal(loaded.source, '.dsh/flow/flow.json')
  assert.equal(loaded.contract.name, 'custom')
  assert.equal(loaded.contract.tasks.recentLimit, 6)
  expectFlowError(() => saveContract(root, null), 'invalid', /contract must be an object/)
})

test('storePaths 支持自定义 store 根并重定向默认子目录', () => {
  const root = tempRoot('paths')
  initProject(root)
  const { contract } = loadContract(root)
  const defaults = storePaths(root, contract)
  assert.equal(defaults.store, path.join(path.resolve(root), '.dsh/flow'))
  assert.equal(defaults.experiments, path.join(path.resolve(root), '.dsh/flow/experiments'))
  assert.equal(defaults.gates, path.join(path.resolve(root), '.dsh/flow/gates'))
  assert.equal(defaults.logs, path.join(path.resolve(root), '.dsh/flow/logs'))

  const custom = storePaths(root, {
    ...contract,
    store: { root: '.flowstore' },
  })
  assert.equal(custom.store, path.join(path.resolve(root), '.flowstore'))
  assert.equal(custom.experiments, path.join(path.resolve(root), '.flowstore/experiments'))
  assert.equal(custom.tasks, path.join(path.resolve(root), '.flowstore/tasks'))
})

// ---------------------------------------------------------------- experiments

test('experiment CRUD：自动 id、默认值、更新刷新 updated_at、删除后 not-found', () => {
  const { root, contract } = freshProject('exp-crud')
  const created = addExperiment(root, contract, { title: 'baseline', factor: 'focus/normalize' })

  assert.equal(created.schema, 1)
  assert.equal(created.id, `E-${stamp()}-01`)
  assert.equal(created.status, 'open')
  assert.equal(created.parent, null)
  assert.deepEqual(created.metrics, {})
  assert.deepEqual(created.commits, [])
  assert.equal(created.title, 'baseline')
  assert.match(created.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)

  const second = addExperiment(root, contract, { title: 'second' })
  assert.equal(second.id, `E-${stamp()}-02`)

  const listed = listExperiments(root, contract)
  assert.equal(listed.length, 2)
  assert.equal(listed[0].id, second.id, '列表按 updated_at 倒序（并列时 id 倒序）')

  const fetched = getExperiment(root, contract, created.id)
  assert.equal(fetched.title, 'baseline')

  const updated = updateExperiment(root, contract, created.id, { status: 'confirmed', measured: 'tie=0.4' })
  assert.equal(updated.id, created.id)
  assert.equal(updated.schema, 1)
  assert.equal(updated.created_at, created.created_at)
  assert.equal(updated.status, 'confirmed')
  assert.equal(updated.measured, 'tie=0.4')

  for (const patch of [{ id: 'E-1' }, { schema: 9 }, { created_at: 'x' }]) {
    expectFlowError(() => updateExperiment(root, contract, created.id, patch), 'invalid', /cannot be changed/)
  }
  expectFlowError(() => updateExperiment(root, contract, created.id, { status: 'bogus' }), 'invalid', /status must be one of/)
  expectFlowError(() => updateExperiment(root, contract, created.id, { title: '   ' }), 'invalid', /title/)
  expectFlowError(() => updateExperiment(root, contract, created.id, { metrics: [] }), 'invalid', /metrics/)

  assert.deepEqual(removeExperiment(root, contract, created.id), { id: created.id, removed: true })
  expectFlowError(() => getExperiment(root, contract, created.id), 'not-found')
  expectFlowError(() => removeExperiment(root, contract, created.id), 'not-found')
})

test('experiment id：显式指定、格式校验、重复冲突、非法路径段', () => {
  const { root, contract } = freshProject('exp-id')
  const explicit = addExperiment(root, contract, { id: `E-${stamp()}-07`, title: 'explicit' })
  assert.equal(explicit.id, `E-${stamp()}-07`)

  expectFlowError(() => addExperiment(root, contract, { id: `E-${stamp()}-07`, title: 'dup' }), 'conflict', /already exists/)
  expectFlowError(() => addExperiment(root, contract, { id: 'E-2026-01', title: 'bad' }), 'invalid', /invalid format/)
  expectFlowError(() => addExperiment(root, contract, { id: '../escape', title: 'bad' }), 'invalid')

  // 自动 id 跳过已占用的号段
  const next = addExperiment(root, contract, { title: 'next' })
  assert.equal(next.id, `E-${stamp()}-08`)

  expectFlowError(() => getExperiment(root, contract, '../flow'), 'invalid', /not a safe path segment/)
})

test('experiment parent：必须指向已存在实验，禁止自引用', () => {
  const { root, contract } = freshProject('exp-parent')
  const parent = addExperiment(root, contract, { title: 'root' })
  const child = addExperiment(root, contract, { title: 'child', parent: parent.id })
  assert.equal(child.parent, parent.id)

  expectFlowError(
    () => addExperiment(root, contract, { title: 'orphan', parent: 'E-20000101-01' }),
    'invalid',
    /parent experiment does not exist/,
  )
  expectFlowError(
    () => addExperiment(root, contract, { id: `E-${stamp()}-03`, title: 'self', parent: `E-${stamp()}-03` }),
    'invalid',
    /parent cannot reference itself/,
  )
  // 旧台账 id（如 H1-baseline）允许作为 parent，但必须存在；格式非法的仍拒绝。
  expectFlowError(() => addExperiment(root, contract, { title: 'bad', parent: 'not-an-id' }), 'invalid', /parent experiment does not exist/)
  expectFlowError(() => addExperiment(root, contract, { title: 'bad', parent: 'bad id!' }), 'invalid', /not a valid experiment id/)
})

test('experimentTree：按 parent 嵌套，未知 parent 与成环数据降级为根', () => {
  const records = [
    { id: 'A', parent: 'B' },
    { id: 'B', parent: 'A' },
    { id: 'C', parent: 'missing' },
    { id: 'D', parent: null },
    { id: 'E', parent: 'E' },
    { id: 'F', parent: 'D' },
    { id: 'G', parent: 'F' },
    { id: 'H' },
  ]
  const tree = experimentTree(records)
  const roots = tree.map((node) => node.id).sort()
  assert.deepEqual(roots, ['A', 'B', 'C', 'D', 'E', 'H'])

  const d = tree.find((node) => node.id === 'D')
  assert.deepEqual(d.children.map((node) => node.id), ['F'])
  assert.deepEqual(d.children[0].children.map((node) => node.id), ['G'])
  assert.deepEqual(records[0], { id: 'A', parent: 'B' }, '输入记录不应被就地修改')

  assert.deepEqual(experimentTree(null), [])
  assert.deepEqual(experimentTree([]), [])
})

// -------------------------------------------------------------------- 原子写

test('原子写：目标为目录时抛 io 且不残留临时文件，修复后同一 id 可重试', () => {
  const { root, contract } = freshProject('atomic')
  const first = addExperiment(root, contract, { title: 'first' })
  const expDir = path.join(root, '.dsh/flow/experiments')
  assert.ok(fs.existsSync(path.join(expDir, `${first.id}.json`)))

  const blockedId = `E-${stamp()}-02`
  const blockedPath = path.join(expDir, `${blockedId}.json`)
  fs.mkdirSync(blockedPath)

  expectFlowError(() => addExperiment(root, contract, { title: 'blocked' }), 'io', /cannot write/)

  const leftovers = fs.readdirSync(expDir).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '失败后不应残留 .tmp- 临时文件')
  assert.ok(fs.statSync(blockedPath).isDirectory(), '失败不应替换目标')

  fs.rmdirSync(blockedPath)
  const retried = addExperiment(root, contract, { title: 'retried' })
  assert.equal(retried.id, blockedId)
  assert.deepEqual(readJson(path.join(expDir, `${blockedId}.json`)).title, 'retried')
})

// ---------------------------------------------------------------------- 锁

test('写锁：新鲜锁拒绝写入，过期锁接管并记 warning', () => {
  const { root, contract } = freshProject('lock')
  const lockPath = path.join(root, '.dsh/flow/.lock')

  fs.writeFileSync(lockPath, JSON.stringify({ pid: 123456, at: new Date().toISOString() }))
  expectFlowError(() => addExperiment(root, contract, { title: 'blocked' }), 'conflict', /locked by another writer/)
  assert.ok(fs.existsSync(lockPath), '冲突时不应擅自删掉他人锁')

  fs.writeFileSync(lockPath, JSON.stringify({ pid: 123456, at: new Date(Date.now() - 60_000).toISOString() }))
  drainWarnings()
  const created = addExperiment(root, contract, { title: 'taken over' })
  assert.equal(created.title, 'taken over')
  assert.ok(drainWarnings().some((item) => item.startsWith('lock-stale:')), '接管过期锁应留下 warning')
  assert.equal(fs.existsSync(lockPath), false, '写操作结束应释放锁')
})

test('未初始化时写操作抛 usage，读操作返回空列表', () => {
  const root = tempRoot('usage')
  const { contract } = loadContract(root)
  expectFlowError(() => addExperiment(root, contract, { title: 'x' }), 'usage', /run flow init first/)
  expectFlowError(() => addTask(root, contract, { title: 'x' }), 'usage', /run flow init first/)
  expectFlowError(() => addGate(root, contract, { id: 'g1', title: 'x', phase: 'manual' }), 'usage')
  assert.deepEqual(listExperiments(root, contract), [])
  assert.deepEqual(listTasks(root, contract), [])
  assert.deepEqual(listGates(root, contract), [])
})

// ---------------------------------------------------------------------- tasks

test('task CRUD：状态流转、scope 合并、不可变字段与 not-found', () => {
  const { root, contract } = freshProject('task-crud')
  const created = addTask(root, contract, { title: 'wire CLI', owner: 'agent-a' })
  assert.equal(created.id, `T-${stamp()}-01`)
  assert.equal(created.status, 'draft')
  assert.deepEqual(created.scope, { allow: [], deny: [] })
  assert.deepEqual(created.acceptance, [])
  assert.deepEqual(created.checkpoints, [])

  const active = updateTask(root, contract, created.id, { status: 'active', scope: { allow: ['lib/'] } })
  assert.equal(active.status, 'active')
  assert.deepEqual(active.scope, { allow: ['lib/'], deny: [] }, 'scope 应逐键合并')
  assert.equal(active.created_at, created.created_at)

  expectFlowError(() => updateTask(root, contract, created.id, { status: 'bogus' }), 'invalid', /status must be one of/)
  expectFlowError(() => updateTask(root, contract, created.id, { id: 'T-x' }), 'invalid', /cannot be changed/)
  expectFlowError(() => updateTask(root, contract, created.id, { acceptance: [1] }), 'invalid', /string or an object/)
  expectFlowError(() => addTask(root, contract, { id: `T-${stamp()}-09`, title: '   ' }), 'invalid', /title/)

  assert.deepEqual(removeTask(root, contract, created.id), { id: created.id, removed: true })
  expectFlowError(() => getTask(root, contract, created.id), 'not-found')
  expectFlowError(() => removeTask(root, contract, created.id), 'not-found')
})

// ---------------------------------------------------------------------- gates

test('gate CRUD：slug 推导、重复 id/步骤校验、启用开关与默认 expect', () => {
  const { root, contract } = freshProject('gate-crud')
  const gate = addGate(root, contract, {
    id: 'precommit',
    title: '提交前检查',
    phase: 'commit',
    steps: [{ id: 'tests', run: 'true' }],
  })
  assert.equal(gate.id, 'precommit')
  assert.equal(gate.enabled, true)
  // 未给 expect 时统一落盘为 'exit 0'（CLI 与 core 一致）。
  assert.equal(gate.steps[0].expect, 'exit 0')
  assert.equal(gate.steps[0].timeoutSeconds, 600)

  expectFlowError(
    () => addGate(root, contract, { id: 'precommit', title: 'dup', phase: 'commit' }),
    'conflict',
    /already exists/,
  )
  expectFlowError(() => addGate(root, contract, { id: 'Bad_ID', title: 'x', phase: 'commit' }), 'invalid', /invalid format/)
  expectFlowError(() => addGate(root, contract, { id: 'phase-bad', title: 'x', phase: 'bogus' }), 'invalid', /phase must be one of/)
  expectFlowError(
    () => addGate(root, contract, { id: 'steps-dup', title: 'x', phase: 'manual', steps: [{ id: 'a', run: 'true' }, { id: 'a', run: 'true' }] }),
    'invalid',
    /duplicate step id/,
  )
  expectFlowError(
    () => addGate(root, contract, { id: 'step-run', title: 'x', phase: 'manual', steps: [{ id: 'a', run: '  ' }] }),
    'invalid',
    /run/,
  )

  const derived = addGate(root, contract, { title: 'Release Check', phase: 'release' })
  assert.equal(derived.id, 'release-check')

  const disabled = updateGate(root, contract, 'precommit', { enabled: false, steps: [{ id: 'smoke', run: 'echo hi', expect: 'contains:hi' }] })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.steps.length, 1)
  expectFlowError(() => updateGate(root, contract, 'precommit', { id: 'other' }), 'invalid', /cannot be changed/)

  assert.deepEqual(removeGate(root, contract, 'release-check'), { id: 'release-check', removed: true })
  expectFlowError(() => getGate(root, contract, 'release-check'), 'not-found')
  expectFlowError(() => removeGate(root, contract, 'release-check'), 'not-found')
})

// ---------------------------------------------------------------- runGate

test('runGate 成功：逐步执行、tail 截取、日志落盘', async () => {
  const { root, contract } = freshProject('gate-ok')
  addGate(root, contract, {
    id: 'ok-gate',
    title: '通过门禁',
    phase: 'commit',
    steps: [
      { id: 'echo', run: 'echo gate-ok', expect: 'contains:gate-ok' },
      { id: 'exit', run: 'true', expect: 'exit 0' },
    ],
  })

  const record = await runGate(root, contract, 'ok-gate')
  assert.equal(record.gate, 'ok-gate')
  assert.equal(record.title, '通过门禁')
  assert.equal(record.ok, true)
  assert.equal(record.steps.length, 2)
  assert.equal(record.steps[0].exit, 0)
  assert.match(record.steps[0].tail, /gate-ok/)
  assert.ok(Number.isFinite(record.durationMs))
  assert.match(record.started_at, /^\d{4}-\d{2}-\d{2}T/)

  const logFile = path.join(root, '.dsh/flow/logs/ok-gate', `${record.started_at.replace(/:/g, '-')}.json`)
  assert.ok(fs.existsSync(logFile), `日志应写入 ${logFile}`)
  assert.deepEqual(readJson(logFile).steps.length, 2)

  const runs = listGateRuns(root, contract, 'ok-gate')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].ok, true)
  assert.deepEqual(listGateRuns(root, contract, 'ok-gate', 0), [])
})

test('runGate 失败：首个失败即停，失败步骤 tail 保留输出', async () => {
  const { root, contract } = freshProject('gate-fail')
  addGate(root, contract, {
    id: 'fail-gate',
    title: '失败门禁',
    phase: 'manual',
    steps: [
      { id: 'bad', run: 'echo boom >&2; exit 3', expect: 'exit 0' },
      { id: 'never', run: 'echo never', expect: 'exit 0' },
    ],
  })

  const record = await runGate(root, contract, 'fail-gate')
  assert.equal(record.ok, false)
  assert.equal(record.steps.length, 1, '首个步骤失败后不再执行后续步骤')
  assert.equal(record.steps[0].id, 'bad')
  assert.equal(record.steps[0].exit, 3)
  assert.equal(record.steps[0].ok, false)
  assert.match(record.steps[0].tail, /boom/)

  const runs = listGateRuns(root, contract, 'fail-gate', 1)
  assert.equal(runs[0].ok, false)
})

test('runGate 超时：按 timeoutMs 终止并把步骤记为失败', async () => {
  const { root, contract } = freshProject('gate-timeout')
  addGate(root, contract, {
    id: 'slow-gate',
    title: '慢门禁',
    phase: 'manual',
    steps: [{ id: 'sleep', run: 'sleep 5', expect: 'exit 0', timeoutSeconds: 600 }],
  })

  const started = Date.now()
  const record = await runGate(root, contract, 'slow-gate', { timeoutMs: 250 })
  const elapsed = Date.now() - started
  assert.equal(record.ok, false)
  assert.equal(record.steps.length, 1)
  assert.equal(record.steps[0].ok, false)
  assert.ok(elapsed < 4000, `超时应在约 250ms 后终止，实际 ${elapsed}ms`)
})

test('runGate 未知 expect 记 warning 并按 exit 0 处理', async () => {
  const { root, contract } = freshProject('gate-expect')
  addGate(root, contract, {
    id: 'odd-expect',
    title: '怪 expect',
    phase: 'manual',
    steps: [{ id: 'odd', run: 'true', expect: 'whatever' }],
  })
  drainWarnings()
  const record = await runGate(root, contract, 'odd-expect')
  assert.equal(record.ok, true)
  assert.ok(drainWarnings().some((item) => item.startsWith('gate-expect-unknown:')))
})

test('listGateRuns 新→旧排序并可 limit；readStoreState 附 lastRun 与计数', async () => {
  const { root, contract } = freshProject('state')
  addExperiment(root, contract, { title: 'e1' })
  addExperiment(root, contract, { title: 'e2', status: 'confirmed' })
  addTask(root, contract, { title: 't1', status: 'active' })
  addGate(root, contract, { id: 'state-gate', title: 'state gate', phase: 'manual', steps: [{ id: 'ok', run: 'true' }] })
  await runGate(root, contract, 'state-gate')

  const logsDir = path.join(root, '.dsh/flow/logs/state-gate')
  const older = {
    gate: 'state-gate',
    title: 'state gate',
    started_at: '2020-01-01T00:00:00+08:00',
    finished_at: '2020-01-01T00:00:01+08:00',
    durationMs: 1000,
    ok: false,
    steps: [{ id: 'ok', run: 'true', expect: 'exit 0', exit: 1, ok: false, durationMs: 1, tail: '' }],
  }
  fs.writeFileSync(path.join(logsDir, '2020-01-01T00-00-00+08-00.json'), JSON.stringify(older))

  const runs = listGateRuns(root, contract, 'state-gate', 5)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].ok, true, '最新记录在前')
  assert.equal(runs[1].started_at, '2020-01-01T00:00:00+08:00')

  const state = readStoreState(root, contract)
  assert.equal(state.experiments.source, 'store')
  assert.equal(state.experiments.counts.total, 2)
  assert.equal(state.experiments.counts.open, 1)
  assert.equal(state.experiments.counts.confirmed, 1)
  assert.equal(state.tasks.counts.active, 1)
  assert.equal(state.gates.counts.total, 1)
  assert.equal(state.gates.counts.enabled, 1)
  assert.equal(state.gates.items[0].lastRun.ok, true)
  assert.equal(state.gates.items[0].lastRun.steps.length, 1)
})

// -------------------------------------------------------------------- 心跳

/** 写一个心跳文件并把 mtime 固定到 ageSeconds 秒前。 */
function writeHeartbeat(root, name, body, ageSeconds = 0) {
  const dir = path.join(root, '.agents/heartbeat')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  const stamp = new Date(Date.now() - ageSeconds * 1000)
  fs.utimesSync(file, stamp, stamp)
  return file
}

test('readStoreState 心跳：目录缺失为空集且不产生 warning', () => {
  const { root, contract } = freshProject('heartbeat-missing')
  drainWarnings()
  const state = readStoreState(root, contract)
  assert.equal(state.heartbeats.dir, '.agents/heartbeat')
  assert.deepEqual(state.heartbeats.items, [])
  assert.deepEqual(state.heartbeats.counts, { total: 0, stale: 0 })
  assert.deepEqual(drainWarnings(), [])
})

test('心跳 md：优先「状态」行去掉列表前缀，否则取第一条非空非标题行', () => {
  const { root, contract } = freshProject('heartbeat-md')
  writeHeartbeat(root, 'alpha.md', '# alpha 标题\n\n- 状态：运行中（等待）\n- 更新：x\n', 30)
  writeHeartbeat(root, 'beta.md', '# beta 标题\n\n## 小节\n\n正文摘要\n', 60)

  const items = readHeartbeats(root, contract)
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((item) => item.file), ['alpha.md', 'beta.md'], '按 mtime 新→旧')
  assert.equal(items[0].title, 'alpha 标题')
  assert.equal(items[0].statusLine, '状态：运行中（等待）')
  assert.equal(items[1].title, 'beta 标题')
  assert.equal(items[1].statusLine, '正文摘要')
  assert.ok(items[0].ageSeconds >= 30 && items[0].ageSeconds < 120)
})

test('心跳 json：status + last_action 拼接，updated_at 解析失败回退 mtime', () => {
  const { root, contract } = freshProject('heartbeat-json')
  writeHeartbeat(root, 'worker.json', JSON.stringify({
    status: 'running',
    last_action: 'node --test test/',
    updated_at: new Date(Date.now() - 120 * 1000).toISOString(),
  }), 10)
  writeHeartbeat(root, 'broken-stamp.json', JSON.stringify({
    status: 'blocked',
    last_action: 'waiting',
    updated_at: 'not-a-date',
  }), 7200)

  const byFile = Object.fromEntries(readHeartbeats(root, contract).map((item) => [item.file, item]))
  assert.equal(byFile['worker.json'].statusLine, 'running · node --test test/')
  assert.equal(byFile['worker.json'].title, 'worker')
  assert.ok(byFile['worker.json'].ageSeconds >= 100 && byFile['worker.json'].ageSeconds < 180, '用 updated_at 计算年龄')
  assert.equal(byFile['broken-stamp.json'].statusLine, 'blocked · waiting')
  assert.ok(byFile['broken-stamp.json'].ageSeconds >= 7100, 'updated_at 非法时回退 mtime')
})

test('心跳按 mtime 倒序并按 contract.heartbeats.max 截断', () => {
  const { root, contract } = freshProject('heartbeat-max')
  for (let index = 0; index < 4; index++) {
    writeHeartbeat(root, `beat-${index}.md`, `# beat ${index}\n\n- 状态：第 ${index} 条\n`, (index + 1) * 60)
  }
  const limited = { ...contract, heartbeats: { ...contract.heartbeats, max: 2 } }
  const items = readHeartbeats(root, limited)
  assert.deepEqual(items.map((item) => item.file), ['beat-0.md', 'beat-1.md'])
  assert.equal(items[0].statusLine, '状态：第 0 条')

  const state = readStoreState(root, limited)
  assert.equal(state.heartbeats.counts.total, 2)
  assert.equal(state.heartbeats.counts.stale, 0)
})

test('心跳 stale 计数以 6 小时为界', () => {
  const { root, contract } = freshProject('heartbeat-stale')
  writeHeartbeat(root, 'fresh.md', '# fresh\n\n- 状态：在跑\n', 60)
  writeHeartbeat(root, 'old.md', '# old\n\n- 状态：停在 10 小时前\n', 10 * 3600)
  writeHeartbeat(root, 'edge.md', '# edge\n\n- 状态：刚好过 6 小时\n', HEARTBEAT_STALE_SECONDS + 5)

  const state = readStoreState(root, contract)
  assert.equal(state.heartbeats.counts.total, 3)
  assert.equal(state.heartbeats.counts.stale, 2)
  const fresh = state.heartbeats.items.find((item) => item.file === 'fresh.md')
  assert.ok(fresh.ageSeconds < 300)
})

test('心跳坏文件：非法 JSON 与非对象只记 warning 并跳过', () => {
  const { root, contract } = freshProject('heartbeat-bad')
  writeHeartbeat(root, 'bad.json', '{ not json', 10)
  writeHeartbeat(root, 'array.json', '[]', 20)
  writeHeartbeat(root, 'ok.md', '# ok\n\n- 状态：ok\n', 30)
  drainWarnings()
  const state = readStoreState(root, contract)
  assert.equal(state.heartbeats.counts.total, 1)
  const warnings = drainWarnings()
  assert.ok(warnings.some((item) => item.startsWith('heartbeat-invalid: bad.json')), warnings.join('\n'))
  assert.ok(warnings.some((item) => item.startsWith('heartbeat-invalid: array.json')), warnings.join('\n'))
})

// -------------------------------------------------------------------- 迁移

test('migrateTrailers：从临时 git 仓库的 trailer 导入、verdict 映射、重复运行跳过', () => {
  const root = tempRoot('trailers')
  initProject(root, { name: 'trailer-proj' })
  const { contract } = loadContract(root)
  git(root, ['init', '-q'])

  commitWithMessage(root, 'a.txt', [
    'exp: normalize focus',
    '',
    'Exp-Id: E-20261001-01',
    'Hypothesis: normalize keeps tie under 1',
    'Factor: focus/normalize',
    'Scale: small',
    'Expected: tie_mean<=1.0',
    'Measured: tie_mean=0.4',
    'Verdict: confirmed',
  ].join('\n'))
  commitWithMessage(root, 'b.txt', [
    'exp: normalize focus retest',
    '',
    'Exp-Id: E-20261001-01',
    'Hypothesis: normalize keeps tie under 1',
    'Factor: focus/normalize',
    'Measured: tie_mean=1.6',
    'Verdict: refuted',
  ].join('\n'))
  commitWithMessage(root, 'c.txt', [
    'exp: bad id',
    '',
    'Exp-Id: bad id!',
    'Hypothesis: should be skipped',
    'Verdict: confirmed',
  ].join('\n'))

  const result = migrateTrailers(root, contract)
  assert.equal(result.imported, 1)
  assert.deepEqual(result.ids, ['E-20261001-01'])
  assert.ok(result.warnings.some((item) => item.startsWith('exp-id-invalid:')), '非法 Exp-Id 应记 warning')

  const record = getExperiment(root, contract, 'E-20261001-01')
  assert.equal(record.hypothesis, 'normalize keeps tie under 1')
  assert.equal(record.factor, 'focus/normalize')
  assert.equal(record.scale, 'small')
  assert.equal(record.expected, 'tie_mean<=1.0')
  assert.equal(record.measured, 'tie_mean=1.6', '同一 Exp-Id 的后续提交应更新 measured')
  assert.equal(record.status, 'refuted', 'Verdict 映射到 status，最新提交生效')
  assert.equal(record.commits.length, 2)
  for (const sha of record.commits) assert.match(sha, /^[0-9a-f]{7}$/)
  assert.match(record.created_at, /^\d{4}-\d{2}-\d{2}T/)

  const again = migrateTrailers(root, contract)
  assert.equal(again.imported, 0)
  // skipped 按“已存在的 Exp-Id 在提交中出现次数”计数：同一 id 出现在 2 个提交里。
  assert.equal(again.skipped, 2)
  assert.deepEqual(again.ids, [])
  assert.equal(listExperiments(root, contract).length, 1)
})

test('migrateLegacyTasks：导入旧 .agents/tasks、id 冲突跳过、坏文件只警告', () => {
  const { root, contract } = freshProject('legacy-tasks')
  const legacyDir = path.join(root, '.agents/tasks')
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'T-20260101-01.json'), JSON.stringify({
    id: 'T-20260101-01',
    title: '旧任务一',
    status: 'active',
    scope: { allow: ['src/'], deny: [] },
    acceptance: ['测试全绿'],
    created_at: '2026-01-01T10:00:00+08:00',
  }))
  fs.writeFileSync(path.join(legacyDir, 'T-20260101-02.json'), JSON.stringify({
    id: 'T-20260101-02',
    title: '冲突任务',
    status: 'done',
  }))
  fs.writeFileSync(path.join(legacyDir, 'bad.json'), JSON.stringify({ id: 'not-an-id', title: 'bad' }))
  fs.writeFileSync(path.join(legacyDir, 'broken.json'), '{ not json')

  // 预置冲突 id，验证跳过而非覆盖
  addTask(root, contract, { id: 'T-20260101-02', title: 'store 里已有' })

  const result = migrateLegacyTasks(root, contract, '.agents/tasks')
  assert.equal(result.imported, 1)
  assert.equal(result.skipped, 1)
  assert.deepEqual(result.ids, ['T-20260101-01'])
  assert.ok(result.warnings.some((item) => item.startsWith('legacy-task-invalid:')))
  assert.ok(result.warnings.some((item) => item.startsWith('legacy-task-unreadable:')))

  const imported = getTask(root, contract, 'T-20260101-01')
  assert.equal(imported.title, '旧任务一')
  assert.equal(imported.status, 'active')
  assert.deepEqual(imported.acceptance, ['测试全绿'])
  assert.equal(imported.created_at, '2026-01-01T10:00:00+08:00')
  assert.match(imported.updated_at, /^\d{4}-\d{2}-\d{2}T/, '缺 updated_at 时按 mtime 补齐')
  assert.equal(getTask(root, contract, 'T-20260101-02').title, 'store 里已有')
})

test('initProject 的 migrate 选项导入并回填 created 清单', () => {
  const root = tempRoot('init-migrate')
  const legacyDir = path.join(root, '.agents/tasks')
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'T-20260202-01.json'), JSON.stringify({
    id: 'T-20260202-01',
    title: 'init 迁移任务',
    status: 'draft',
    created_at: '2026-02-02T10:00:00+08:00',
    updated_at: '2026-02-02T10:00:00+08:00',
  }))

  const result = initProject(root, { name: 'migrated', migrate: ['tasks'] })
  assert.equal(result.imported.tasks, 1)
  assert.ok(result.created.includes('.dsh/flow/tasks/T-20260202-01.json'))
  assert.equal(listTasks(root, loadContract(root).contract).length, 1)
})

test('坏记录只警告不阻塞列表读取', () => {
  const { root, contract } = freshProject('bad-record')
  addExperiment(root, contract, { title: 'good' })
  fs.writeFileSync(path.join(root, '.dsh/flow/experiments/E-20260101-01.json'), '{ broken')
  drainWarnings()
  const items = listExperiments(root, contract)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'good')
  assert.ok(drainWarnings().some((item) => item.startsWith('unreadable:')))
})

// ---------------------------------------------------------------------- CLI

test('CLI --help 退出 0 且列出全部命令', () => {
  const { root } = freshProject('cli-help')
  const result = runCli(root, ['--help'])
  assert.equal(result.code, 0)
  for (const line of ['init', 'status', 'exp list', 'exp update', 'task add', 'gate run', 'gate logs', '--json']) {
    assert.ok(result.stdout.includes(line), `帮助缺少 "${line}"`)
  }
})

test('CLI 主流程：init/exp/task/gate/status 与 --json 输出', () => {
  const root = tempRoot('cli-flow')

  const init = runCli(root, ['init', '--name', 'cli-proj', '--json'])
  assert.equal(init.code, 0)
  assert.equal(init.json.ok, true)
  assert.ok(init.json.data.created.includes('.dsh/flow/flow.json'))

  const added = runCli(root, ['exp', 'add', '--title', 'CLI 实验', '--factor', 'cli', '--json'])
  assert.equal(added.code, 0)
  const expId = added.json.data.id
  assert.match(expId, /^E-\d{8}-\d{2}$/)

  const updated = runCli(root, ['exp', 'update', expId, '--status', 'confirmed', '--measured', 'ok', '--json'])
  assert.equal(updated.code, 0)
  assert.equal(updated.json.data.status, 'confirmed')

  const list = runCli(root, ['exp', 'list', '--json'])
  assert.equal(list.code, 0)
  assert.equal(list.json.data.length, 1)

  const tree = runCli(root, ['exp', 'tree', '--json'])
  assert.equal(tree.code, 0)
  assert.equal(tree.json.data.length, 1)
  assert.equal(tree.json.data[0].children.length, 0)

  const gate = runCli(root, [
    'gate', 'add', '--id', 'cli-gate', '--title', 'CLI 门禁', '--phase', 'manual',
    '--step', 'ok=echo cli-ok>>contains:cli-ok', '--json',
  ])
  assert.equal(gate.code, 0)
  assert.equal(gate.json.data.steps[0].expect, 'contains:cli-ok')

  const run = runCli(root, ['gate', 'run', 'cli-gate', '--json'])
  assert.equal(run.code, 0, '门禁通过时退出 0')
  assert.equal(run.json.data.ok, true)
  assert.equal(run.json.data.steps.length, 1)

  const logs = runCli(root, ['gate', 'logs', 'cli-gate', '--limit', '1', '--json'])
  assert.equal(logs.code, 0)
  assert.equal(logs.json.data.length, 1)

  const task = runCli(root, ['task', 'add', '--title', 'CLI 任务', '--owner', 'agent-a', '--json'])
  assert.equal(task.code, 0)
  assert.match(task.json.data.id, /^T-\d{8}-\d{2}$/)
  const taskUpdated = runCli(root, ['task', 'update', task.json.data.id, '--status', 'active', '--json'])
  assert.equal(taskUpdated.code, 0)
  assert.equal(taskUpdated.json.data.status, 'active')

  const status = runCli(root, ['status', '--json'])
  assert.equal(status.code, 0)
  assert.equal(status.json.data.initialized, true)
  assert.equal(status.json.data.name, 'cli-proj')
  assert.equal(status.json.data.contractSource, '.dsh/flow/flow.json')
  assert.equal(status.json.data.counts.experiments.total, 1)
  assert.equal(status.json.data.counts.tasks.total, 1)
  assert.equal(status.json.data.counts.gates.total, 1)
})

test('CLI status 输出心跳小节，--json 带 heartbeats 段', () => {
  const { root } = freshProject('cli-heartbeats')
  for (let index = 0; index < 6; index++) {
    writeHeartbeat(root, `hb-${index}.md`, `# hb ${index}\n\n- 状态：运行中 ${index}\n`, (index + 1) * 8 * 3600)
  }

  const text = runCli(root, ['status'])
  assert.equal(text.code, 0)
  assert.match(text.stdout, /心跳\s+6（可能已停 6）/)
  assert.ok(text.stdout.includes('hb-0.md'))
  assert.ok(text.stdout.includes('状态：运行中 0'))
  assert.ok(!text.stdout.includes('hb-5.md'), '只逐条展示前 5 条')
  assert.ok(text.stdout.includes('其余 1 条（共 6 条）'))

  const json = runCli(root, ['status', '--json'])
  assert.equal(json.code, 0)
  assert.equal(json.json.data.heartbeats.dir, '.agents/heartbeat')
  assert.equal(json.json.data.heartbeats.counts.total, 6)
  assert.equal(json.json.data.heartbeats.counts.stale, 6)
  assert.equal(json.json.data.heartbeats.items.length, 6)
  assert.equal(json.json.data.heartbeats.items[0].file, 'hb-0.md')
})

test('CLI 门禁失败退出 0 但 data.ok=false', () => {
  const { root } = freshProject('cli-gate-fail')
  runCli(root, ['gate', 'add', '--id', 'cli-fail', '--title', '失败门禁', '--phase', 'manual',
    '--step', 'bad=false>>exit 0'])
  const run = runCli(root, ['gate', 'run', 'cli-fail', '--json'])
  assert.equal(run.code, 0)
  assert.equal(run.json.ok, true)
  assert.equal(run.json.data.ok, false)
  assert.equal(run.json.data.steps[0].ok, false)
})

test('CLI 退出码与错误 JSON：1 用法 / 2 校验 / 3 未找到', () => {
  const { root } = freshProject('cli-exit')

  const noTitle = runCli(root, ['exp', 'add', '--json'])
  assert.equal(noTitle.code, 1)
  assert.equal(noTitle.json.ok, false)
  assert.equal(noTitle.json.error.code, 'usage')

  const unknown = runCli(root, ['nope', '--json'])
  assert.equal(unknown.code, 1)
  assert.equal(unknown.json.error.code, 'usage')

  const badFlag = runCli(root, ['exp', 'list', '--bogus', '--json'])
  assert.equal(badFlag.code, 1)
  assert.equal(badFlag.json.error.code, 'usage')

  const missing = runCli(root, ['exp', 'show', 'E-20000101-01', '--json'])
  assert.equal(missing.code, 3)
  assert.equal(missing.json.error.code, 'not-found')

  const invalid = runCli(root, ['exp', 'add', '--title', 'parent 校验', '--parent', 'E-20000101-01', '--json'])
  assert.equal(invalid.code, 2)
  assert.equal(invalid.json.error.code, 'invalid')

  // CLI 的 exp add 不接受 --id（自动生成），因此用 update 走校验路径。
  const created = runCli(root, ['exp', 'add', '--title', '待删除', '--json'])
  assert.equal(created.code, 0)
  const createdId = created.json.data.id
  const badStatus = runCli(root, ['exp', 'update', createdId, '--status', 'bogus', '--json'])
  assert.equal(badStatus.code, 2)
  assert.equal(badStatus.json.error.code, 'invalid')

  const noYes = runCli(root, ['exp', 'rm', createdId])
  assert.equal(noYes.code, 1, '非 TTY 且无 --yes 应拒绝删除')
  assert.ok(listExperiments(root, loadContract(root).contract).some((item) => item.id === createdId))

  const removed = runCli(root, ['exp', 'rm', createdId, '--yes', '--json'])
  assert.equal(removed.code, 0)
  assert.equal(removed.json.data.removed, true)
})

test('CLI 未初始化项目上 status 提示 init，写命令退出 1', () => {
  const root = tempRoot('cli-uninitialized')
  const status = runCli(root, ['status', '--json'])
  assert.equal(status.code, 0)
  assert.equal(status.json.data.initialized, false)
  assert.equal(status.json.data.contractSource, 'defaults')

  const add = runCli(root, ['exp', 'add', '--title', 'x', '--json'])
  assert.equal(add.code, 1)
  assert.equal(add.json.error.code, 'usage')
})
