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
  containedPath,
  drainWarnings,
  endHeartbeat,
  experimentTree,
  getExperiment,
  getGate,
  getTask,
  gcLegacyHeartbeats,
  heartbeatStatus,
  initProject,
  listExperiments,
  listGateRuns,
  listGates,
  listTasks,
  loadContract,
  migrateLegacyTasks,
  migrateTrailers,
  readHeartbeatSection,
  readHeartbeats,
  readStoreState,
  resolveHeartbeatWorkspace,
  removeExperiment,
  removeGate,
  removeTask,
  runGate,
  runGatesByPhase,
  saveContract,
  startHeartbeat,
  storePaths,
  updateExperiment,
  updateGate,
  updateHeartbeat,
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

/**
 * Isolated project for core/CLI CRUD tests. `noGates` keeps the fixture free of
 * the default gate seeds (`flow init` seeds an empty gates dir); seeding itself
 * is covered by its own tests further below.
 */
function freshProject(label = 'project') {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true })
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

function runCli(cwd, args, env) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: env === undefined ? process.env : { ...process.env, ...env },
  })
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

// --------------------------------------------------- manifest 路径 containment
//
// 契约里的每个路径都必须是项目根内的相对路径。以下用例全部在 os.tmpdir()
// 的临时项目里构造“根外哨兵文件”，只断言任何读取结果里都不出现哨兵内容。

test('manifest containment：绝对 gate.log 被拒绝、warning 带原值且不回显内容', () => {
  const root = tempRoot('contain-gate-abs')
  const secretDir = tempRoot('contain-gate-secret')
  const secret = path.join(secretDir, 'gate.log')
  fs.writeFileSync(secret, 'TOP-SECRET-GATE\n')

  drainWarnings()
  assert.equal(containedPath(root, secret, 'gate.log'), undefined)
  const warnings = drainWarnings()
  assert.ok(
    warnings.some((item) => item.startsWith('manifest-path-rejected: gate.log:')),
    warnings.join('\n'),
  )
  assert.ok(warnings.some((item) => item.includes(secret)), 'warning 应保留原值，便于定位')
  assert.equal(warnings.join('\n').includes('TOP-SECRET-GATE'), false, 'warning 不应回显文件内容')
})

test('manifest containment：根外绝对 store.root 回退 .dsh/flow 并 warning', () => {
  const root = tempRoot('contain-store-abs')
  initProject(root, { name: 'contain-store-abs', noGates: true })
  const outside = tempRoot('contain-store-outside')
  const { contract } = loadContract(root)

  drainWarnings()
  const paths = storePaths(root, { ...contract, store: { root: outside } })
  const defaults = storePaths(root, contract)
  assert.equal(paths.store, defaults.store)
  assert.equal(paths.experiments, defaults.experiments)
  assert.equal(paths.tasks, defaults.tasks)
  const warnings = drainWarnings()
  assert.ok(
    warnings.some((item) => item.startsWith('manifest-path-rejected: store.root:')),
    warnings.join('\n'),
  )
  assert.ok(warnings.some((item) => item.includes(outside)))

  // 根还不存在时只有词法判定可信：根外绝对 store.root 仍必须被拒绝。
  const ghostRoot = path.join(tempRoot('contain-store-ghost'), 'missing-project')
  drainWarnings()
  const ghost = storePaths(ghostRoot, { ...contract, store: { root: outside } })
  assert.equal(ghost.store, path.join(path.resolve(ghostRoot), '.dsh/flow'))
  assert.ok(
    drainWarnings().some((item) => item.startsWith('manifest-path-rejected: store.root:')),
    '不存在的根也要拒绝根外绝对路径',
  )
})

test('manifest containment：experiments.dir 的 .. 逃逸回退默认目录并 warning', () => {
  const root = tempRoot('contain-exp-dotdot')
  initProject(root, { name: 'contain-exp-dotdot', noGates: true })
  const { contract } = loadContract(root)

  drainWarnings()
  const paths = storePaths(root, { ...contract, experiments: { ...contract.experiments, dir: '../x' } })
  assert.equal(paths.experiments, path.join(path.resolve(root), '.dsh/flow/experiments'))
  const warnings = drainWarnings()
  assert.ok(
    warnings.some((item) => item.startsWith('manifest-path-rejected: experiments.dir: ../x:')),
    warnings.join('\n'),
  )
})

test('manifest containment：根内符号链接指向根外时 tasks.dir 回退默认目录', (t) => {
  const root = tempRoot('contain-symlink')
  initProject(root, { name: 'contain-symlink', noGates: true })
  const outside = tempRoot('contain-symlink-outside')
  fs.writeFileSync(
    path.join(outside, 'T-20261030-99.json'),
    JSON.stringify({
      schema: 1,
      id: 'T-20261030-99',
      title: 'TOP-SECRET-TASK',
      status: 'active',
      updated_at: '2026-10-30T10:00:00+08:00',
    }),
  )
  try {
    fs.symlinkSync(outside, path.join(root, 'task-link'), 'dir')
  } catch (error) {
    t.skip(`symlink unavailable on this platform: ${error.code}`)
    return
  }
  const { contract } = loadContract(root)
  const malicious = { ...contract, tasks: { ...contract.tasks, dir: 'task-link' } }

  drainWarnings()
  const paths = storePaths(root, malicious)
  assert.equal(paths.tasks, path.join(path.resolve(root), '.dsh/flow/tasks'))
  const warnings = drainWarnings()
  assert.ok(
    warnings.some((item) => item.startsWith('manifest-path-rejected: tasks.dir: task-link:')),
    warnings.join('\n'),
  )
  assert.equal(JSON.stringify(listTasks(root, malicious)).includes('TOP-SECRET-TASK'), false)
})

test('manifest containment：绝对 heartbeats.dir 回退 .agents/heartbeat 且内容不泄漏', () => {
  const root = tempRoot('contain-heartbeat')
  initProject(root, { name: 'contain-heartbeat', noGates: true })
  const outside = tempRoot('contain-heartbeat-outside')
  fs.writeFileSync(
    path.join(outside, 'evil.json'),
    JSON.stringify({ schema: 1, status: 'working', last_action: 'TOP-SECRET-HEARTBEAT' }),
  )
  const { contract } = loadContract(root)

  drainWarnings()
  const section = readHeartbeatSection(root, {
    ...contract,
    heartbeats: { ...contract.heartbeats, dir: outside },
  })
  assert.deepEqual(section.items, [])
  assert.equal(section.dir, '.agents/heartbeat', '报告实际读取的默认目录，而不是被拒绝的路径')
  assert.equal(JSON.stringify(section).includes('TOP-SECRET-HEARTBEAT'), false)
  const warnings = drainWarnings()
  assert.ok(
    warnings.some((item) => item.startsWith('manifest-path-rejected: heartbeats.dir:')),
    warnings.join('\n'),
  )
})

test('manifest containment：合法相对路径与根内绝对 store.root 行为不变', () => {
  const root = tempRoot('contain-legal')
  initProject(root, { name: 'contain-legal', noGates: true })
  const { contract } = loadContract(root)
  const custom = {
    ...contract,
    store: { root: path.join(path.resolve(root), '.dsh/flow') },
    experiments: { ...contract.experiments, dir: 'data/experiments' },
  }

  drainWarnings()
  const paths = storePaths(root, custom)
  assert.equal(paths.store, path.join(path.resolve(root), '.dsh/flow'))
  assert.equal(paths.experiments, path.join(path.resolve(root), 'data/experiments'))
  assert.equal(paths.tasks, path.join(path.resolve(root), '.dsh/flow/tasks'))

  const created = addExperiment(root, custom, { title: 'still works' })
  assert.equal(created.title, 'still works')
  const listed = listExperiments(root, custom)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, created.id)
  assert.deepEqual(drainWarnings(), [], '合法路径不产生 containment warning')
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
  assert.deepEqual(state.heartbeats.counts, { total: 0, active: 0, stale: 0, hidden: 0 })
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

  const init = runCli(root, ['init', '--name', 'cli-proj', '--no-gates', '--json'])
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

// ============================================================ 心跳写入 API
//
// 以下是「心跳写入 + 门禁开关 + 默认门禁种子」新增用例。全部在临时目录里跑，
// 不触碰任何真实项目台账。

const SESSION = 'session-79c1c4e6-ecf5-40a9-98c2-fd7a373a2a85'
const HEARTBEAT_KEYS = [
  'file', 'session', 'agent', 'legacy', 'hidden', 'goal', 'task', 'claims', 'status',
  'last_action', 'started_at', 'updated_at', 'ended_at', 'ageSeconds', 'stale', 'turn',
  'stats', 'mtime',
]

function heartbeatPath(root, session = SESSION) {
  return path.join(root, '.agents/heartbeat', `${session}.json`)
}

test('heartbeat start：显式任务下标 goal 取任务标题、claims 取 scope.allow', () => {
  const { root, contract } = freshProject('hb-start')
  const task = addTask(root, contract, {
    id: `T-${stamp()}-01`,
    title: '任务甲',
    status: 'active',
    owner: SESSION,
    scope: { allow: ['lib/core.mjs', 'bin/flow.mjs'] },
  })

  const record = startHeartbeat(root, contract, { session: SESSION })
  assert.equal(record.schema, 1)
  assert.equal(record.session, SESSION)
  assert.equal(record.task, task.id)
  assert.equal(record.task, `T-${stamp()}-01`)
  assert.equal(record.goal, '任务甲')
  assert.deepEqual(record.claims, ['lib/core.mjs', 'bin/flow.mjs'])
  assert.equal(record.status, 'working')
  assert.equal(record.turn, 1)
  assert.deepEqual(record.stats, { turns: 1, missed: 0 })
  assert.equal(record.ended_at, null)
  assert.match(record.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  assert.equal(record.createdTask, null, '已有任务时不应新建')

  const stored = readJson(heartbeatPath(root))
  assert.equal(stored.schema, 1)
  assert.equal(stored.task, task.id)
  assert.equal(stored.createdTask, undefined, 'createdTask 只是 API 附加信息，不落盘')
  assert.deepEqual(new Set(Object.keys(stored)), new Set([
    'schema', 'session', 'agent', 'goal', 'task', 'claims', 'status', 'turn',
    'last_action', 'started_at', 'updated_at', 'ended_at', 'stats',
  ]))
})

test('heartbeat start：没有任务时自动建 draft 任务并回填 task；createTask:false 不建', () => {
  const { root, contract } = freshProject('hb-create')
  const started = startHeartbeat(root, contract, { session: SESSION, goal: '自动建任务' })

  assert.ok(started.createdTask, '应返回新建任务 id')
  assert.equal(started.task, started.createdTask)
  assert.equal(started.goal, '自动建任务')
  const tasks = listTasks(root, contract)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].id, started.createdTask)
  assert.equal(tasks[0].title, '自动建任务')
  assert.equal(tasks[0].status, 'draft')
  assert.equal(tasks[0].owner, SESSION)

  // 无任务 + 无 goal → 标题用默认「未命名任务」
  // 新会话会复用全库最新的 active/draft 任务，所以「完全没有任务可复用」要用干净项目。
  const empty = freshProject('hb-create-unnamed')
  const unnamed = startHeartbeat(empty.root, empty.contract, { session: 'session-unnamed' })
  assert.equal(unnamed.goal, '未命名任务')
  assert.equal(getTask(empty.root, empty.contract, unnamed.task).title, '未命名任务')
  assert.equal(listTasks(empty.root, empty.contract).length, 1)

  // createTask:false → 心跳照写，但不建任务（同样用干净项目，避免复用他人 draft）
  const bare = freshProject('hb-create-guarded')
  const guarded = startHeartbeat(bare.root, bare.contract, {
    session: 'session-guarded',
    goal: '不建任务',
    createTask: false,
  })
  assert.equal(guarded.task, null)
  assert.equal(guarded.createdTask, null)
  assert.equal(listTasks(bare.root, bare.contract).length, 0)
})

test('heartbeat 重复 start：started_at 保留、turn/stats 递增、ended_at 清空、status 回 working', () => {
  const { root, contract } = freshProject('hb-repeat')
  const first = startHeartbeat(root, contract, { session: SESSION, goal: '任务', claims: ['lib/a.mjs'] })
  const ended = endHeartbeat(root, contract, { session: SESSION })
  assert.ok(ended.ended_at)

  const second = startHeartbeat(root, contract, { session: SESSION, last_action: '第二轮' })
  assert.equal(second.started_at, first.started_at, 'started_at 保留首次值')
  assert.equal(second.turn, 2)
  assert.deepEqual(second.stats, { turns: 2, missed: 0 })
  assert.equal(second.ended_at, null)
  assert.equal(second.status, 'working')
  assert.equal(second.goal, '任务')
  assert.deepEqual(second.claims, ['lib/a.mjs'])
  assert.equal(second.last_action, '第二轮')

  const third = startHeartbeat(root, contract, { session: SESSION, turn: 7 })
  assert.equal(third.turn, 7, '显式 turn 优先')
  assert.equal(third.stats.turns, 3, 'stats.turns 仍然递增')
})

test('heartbeat update：白名单字段、刷新 updated_at；end 后 active=false 且文件保留', () => {
  const { root, contract } = freshProject('hb-update')
  startHeartbeat(root, contract, { session: SESSION, goal: '旧目标' })
  const file = heartbeatPath(root)
  assert.equal(heartbeatStatus(root, contract, SESSION).active, true)

  const seeded = readJson(file)
  fs.writeFileSync(file, JSON.stringify({ ...seeded, updated_at: '2000-01-01T00:00:00+08:00' }))
  const updated = updateHeartbeat(root, contract, SESSION, {
    status: 'idle',
    goal: '新目标',
    claims: ['x', 'y'],
    turn: 4,
    task: null,
    last_action: '记一笔',
  })
  assert.equal(updated.status, 'idle')
  assert.equal(updated.goal, '新目标')
  assert.deepEqual(updated.claims, ['x', 'y'])
  assert.equal(updated.turn, 4)
  assert.equal(updated.task, null)
  assert.equal(updated.last_action, '记一笔')
  assert.ok(Date.parse(updated.updated_at) > Date.parse('2000-01-01T00:00:00+08:00'), 'update 应刷新 updated_at')
  assert.equal(heartbeatStatus(root, contract, SESSION).active, true, 'idle 仍算 active')

  for (const [patch, pattern] of [
    [{ schema: 2 }, /cannot be changed/],
    [{ session: 'other' }, /cannot be changed/],
    [{ status: 'bogus' }, /status must be one of/],
    [{ turn: 'x' }, /turn/],
    [{ claims: [1] }, /array of strings/],
  ]) {
    expectFlowError(() => updateHeartbeat(root, contract, SESSION, patch), 'invalid', pattern)
  }
  expectFlowError(() => updateHeartbeat(root, contract, 'session-missing', { status: 'idle' }), 'not-found')

  const ended = endHeartbeat(root, contract, { session: SESSION, note: '收尾' })
  assert.equal(ended.status, 'done')
  assert.equal(ended.last_action, '记一笔 · 收尾', 'note 并入 last_action')
  assert.ok(ended.ended_at)
  assert.equal(heartbeatStatus(root, contract, SESSION).active, false)
  assert.ok(fs.existsSync(file), 'end 后文件必须保留')

  const section = readHeartbeatSection(root, contract)
  assert.equal(section.counts.total, 1)
  assert.equal(section.counts.active, 0)
  assert.equal(section.items[0].status, 'done')
  assert.ok(section.items[0].ended_at)
})

test('readHeartbeatSection：md 与 json 同时可读，source 的 md/json 只是遗留值，none 才关闭', () => {
  const { root, contract } = freshProject('hb-section')
  startHeartbeat(root, contract, { session: SESSION, goal: '联合视图', claims: ['lib/a.mjs'], agent: 'lead', last_action: '跑测试' })
  writeHeartbeat(root, 'legacy.md', '# legacy\n\n- 状态：在跑\n', 10)

  for (const source of ['md', 'json', 'store', 'both']) {
    const section = readHeartbeatSection(root, { ...contract, heartbeats: { ...contract.heartbeats, source } })
    assert.equal(section.items.length, 2, `source=${source} 应同时读 md+json`)
    assert.equal(section.counts.total, 2)
    assert.equal(section.counts.active, 1)
    assert.equal(section.counts.stale, 0)
    assert.equal(section.dir, '.agents/heartbeat')

    const json = section.items.find((item) => item.file === `${SESSION}.json`)
    for (const key of HEARTBEAT_KEYS) assert.ok(Object.hasOwn(json, key), `缺字段 ${key}`)
    assert.equal(json.session, SESSION)
    assert.equal(json.agent, 'lead')
    assert.equal(json.goal, '联合视图')
    assert.match(json.task, /^T-\d{8}-\d{2}$/)
    assert.deepEqual(json.claims, ['lib/a.mjs'])
    assert.equal(json.status, 'working')
    assert.equal(json.last_action, '跑测试')
    assert.equal(json.turn, 1)
    assert.deepEqual(json.stats, { turns: 1, missed: 0 })
    assert.equal(json.ended_at, null)
    assert.equal(json.stale, false)
    assert.ok(json.ageSeconds < 300)

    const md = section.items.find((item) => item.file === 'legacy.md')
    assert.equal(md.session, 'legacy')
    assert.equal(md.status, '')
    assert.equal(md.last_action, '状态：在跑')
    assert.equal(md.task, null)
  }

  // 旧形状保持
  const legacyItems = readHeartbeats(root, contract)
  assert.deepEqual(Object.keys(legacyItems[0]).sort(), ['ageSeconds', 'file', 'mtime', 'statusLine', 'title'])

  // JSON 心跳按 updated_at 计算 stale（不看 mtime）
  const file = heartbeatPath(root)
  const raw = readJson(file)
  fs.writeFileSync(file, JSON.stringify({
    ...raw,
    updated_at: new Date(Date.now() - (HEARTBEAT_STALE_SECONDS + 60) * 1000).toISOString(),
  }))
  const stale = readHeartbeatSection(root, contract)
  assert.equal(stale.items.find((item) => item.file === `${SESSION}.json`).stale, true)
  assert.equal(stale.counts.stale, 1)
  assert.equal(stale.counts.active, 1, 'stale 也算 active')

  // source:none 关闭整个小节
  const none = readHeartbeatSection(root, { ...contract, heartbeats: { ...contract.heartbeats, source: 'none' } })
  assert.deepEqual(none.items, [])
  assert.deepEqual(none.counts, { total: 0, active: 0, stale: 0, hidden: 0 })
  assert.deepEqual(readHeartbeats(root, { ...contract, heartbeats: { ...contract.heartbeats, source: 'none' } }), [])
})

// ------------------------------------------- 心跳作用域（主会话 / 主工作区）

/** 建一个含 store、已提交的临时 git 仓库，返回主工作区路径。 */
function gitProject(label) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true })
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/\n', 'utf8')
  git(root, ['init', '-q'])
  git(root, ['add', '-A'])
  git(root, [
    '-c', 'user.name=Flow Test',
    '-c', 'user.email=flow-test@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '--no-verify', '-m', 'init',
  ])
  return root
}

test('心跳根：worktree 会话读写主工作区心跳，读侧同源', () => {
  const main = gitProject('hb-worktree-main')
  const checkout = path.join(tempRoot('hb-worktree-dir'), 'checkout')
  git(main, ['worktree', 'add', '-q', checkout, '-b', 'hb-wt'])
  const { contract } = loadContract(checkout)
  const session = 'session-worktree'

  assert.deepEqual(resolveHeartbeatWorkspace(checkout), { root: main, degraded: false, reason: '' })
  const record = startHeartbeat(checkout, contract, { session, goal: 'worktree 心跳', createTask: false })
  assert.equal(record.session, session)
  assert.ok(fs.existsSync(path.join(main, '.agents/heartbeat', `${session}.json`)), '写主工作区')
  assert.ok(!fs.existsSync(path.join(checkout, '.agents/heartbeat', `${session}.json`)), '不写 worktree')

  assert.equal(heartbeatStatus(checkout, contract, session).active, true, 'status 也读主工作区')
  const section = readHeartbeatSection(checkout, contract)
  assert.equal(section.root, main)
  assert.equal(section.items.length, 1)
  assert.equal(readHeartbeats(checkout, contract).length, 1)
  assert.equal(updateHeartbeat(checkout, contract, session, { status: 'idle' }).status, 'idle')
  endHeartbeat(checkout, contract, { session })
  drainWarnings()
})

test('心跳根：git 解析失败降级到当前目录并记 warning', () => {
  const root = tempRoot('hb-root-degraded')
  initProject(root, { name: 'degraded', noGates: true })
  fs.mkdirSync(path.join(root, '.git')) // 坏仓库：git 命令会失败
  const { contract } = loadContract(root)
  const resolved = resolveHeartbeatWorkspace(root)
  assert.equal(resolved.root, root)
  assert.equal(resolved.degraded, true)
  assert.match(resolved.reason, /git worktree lookup failed/)

  drainWarnings()
  startHeartbeat(root, contract, { session: 'session-degraded', createTask: false })
  assert.ok(fs.existsSync(path.join(root, '.agents/heartbeat/session-degraded.json')))
  assert.ok(
    drainWarnings().some((item) => item.startsWith('heartbeat-root-degraded:')),
    '降级必须留 warning',
  )
})

test('旧子会话心跳：hidden/legacy、不进面板与 readHeartbeats，gc 只清这些文件', () => {
  const { root, contract } = freshProject('hb-legacy-sub')
  startHeartbeat(root, contract, { session: 'session-legacy-sub', agent: 'subagent', createTask: false })
  startHeartbeat(root, contract, { session: 'session-main', goal: '主会话', createTask: false })

  const section = readHeartbeatSection(root, contract)
  assert.equal(section.counts.total, 1)
  assert.equal(section.counts.hidden, 1)
  assert.deepEqual(section.items.map((item) => item.session), ['session-main'])
  assert.deepEqual(readHeartbeats(root, contract).map((item) => item.file), ['session-main.json'])

  const legacyFile = heartbeatPath(root, 'session-legacy-sub')
  assert.ok(fs.existsSync(legacyFile), '旧文件存在')

  const dry = gcLegacyHeartbeats(root, contract, { dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.removed.length, 1)
  assert.equal(dry.removed[0].file, 'session-legacy-sub.json')
  assert.equal(dry.kept, 1)
  assert.ok(fs.existsSync(legacyFile), 'dry-run 不删除')

  const real = gcLegacyHeartbeats(root, contract)
  assert.equal(real.removed.length, 1)
  assert.ok(!fs.existsSync(legacyFile), 'gc 删除旧子会话心跳')
  assert.ok(fs.existsSync(heartbeatPath(root, 'session-main')), '普通心跳保留')
  assert.equal(readHeartbeatSection(root, contract).counts.hidden, 0)
})

test('心跳 session 安全校验：空、过长、路径穿越、控制字符都拒绝；缺省回落 DSH_SESSION_ID', () => {
  const { root, contract } = freshProject('hb-session')
  const saved = process.env.DSH_SESSION_ID
  delete process.env.DSH_SESSION_ID
  try {
    expectFlowError(() => startHeartbeat(root, contract, {}), 'usage', /session is required/)
    expectFlowError(() => startHeartbeat(root, contract, { session: '   ' }), 'usage', /session is required/)
    expectFlowError(() => startHeartbeat(root, contract, { session: 's'.repeat(81) }), 'invalid', /too long/)
    for (const bad of ['../evil', 'a/b', 'a\\b', '..', 'a\u0000b', 'a\nb']) {
      expectFlowError(() => startHeartbeat(root, contract, { session: bad }), 'invalid', /not a safe file name/)
    }
    expectFlowError(() => updateHeartbeat(root, contract, '../x', { status: 'idle' }), 'invalid', /not a safe file name/)
    expectFlowError(() => heartbeatStatus(root, contract, 'a/b'), 'invalid', /not a safe file name/)

    process.env.DSH_SESSION_ID = 'session-from-env'
    const record = startHeartbeat(root, contract, {})
    assert.equal(record.session, 'session-from-env')
    assert.equal(heartbeatStatus(root, contract).active, true, 'status 也吃环境变量')
    assert.ok(fs.existsSync(heartbeatPath(root, 'session-from-env')))
  } finally {
    if (saved === undefined) delete process.env.DSH_SESSION_ID
    else process.env.DSH_SESSION_ID = saved
  }
})

test('heartbeat 未 init：写入抛 usage，读取不抛', () => {
  const root = tempRoot('hb-uninitialized')
  const { contract } = loadContract(root)
  expectFlowError(() => startHeartbeat(root, contract, { session: SESSION }), 'usage', /run flow init first/)
  expectFlowError(() => updateHeartbeat(root, contract, SESSION, { status: 'idle' }), 'usage')
  expectFlowError(() => endHeartbeat(root, contract, { session: SESSION }), 'usage')
  assert.equal(heartbeatStatus(root, contract, SESSION).active, false)
  assert.deepEqual(readHeartbeatSection(root, contract).counts, { total: 0, active: 0, stale: 0, hidden: 0 })
})

// ------------------------------------------------------------ 门禁开关生效

test('runGate：disabled 门禁拒绝运行，force:true 才可跑', async () => {
  const { root, contract } = freshProject('gate-disabled')
  addGate(root, contract, {
    id: 'off-gate',
    title: '关闭的门禁',
    phase: 'manual',
    enabled: false,
    steps: [{ id: 'ok', run: 'true' }],
  })

  await assert.rejects(
    runGate(root, contract, 'off-gate'),
    (error) => error instanceof FlowError && error.code === 'usage' && /gate off-gate is disabled/.test(error.message),
  )
  const forced = await runGate(root, contract, 'off-gate', { force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.steps.length, 1)

  updateGate(root, contract, 'off-gate', { enabled: true })
  assert.equal((await runGate(root, contract, 'off-gate')).ok, true, '重新启用后无需 force')
})

test('runGatesByPhase：跳过 disabled、失败不中断、id 升序、force 不唤醒 disabled、非法 phase 拒绝', async () => {
  const { root, contract } = freshProject('gate-phase')
  addGate(root, contract, { id: 'a-fail', title: '甲失败', phase: 'commit', steps: [{ id: 'bad', run: 'exit 3' }] })
  addGate(root, contract, { id: 'b-ok', title: '乙通过', phase: 'commit', steps: [{ id: 'ok', run: 'true' }] })
  addGate(root, contract, { id: 'c-off', title: '丙关闭', phase: 'commit', enabled: false, steps: [{ id: 'ok', run: 'true' }] })
  addGate(root, contract, { id: 'd-manual', title: '丁手工', phase: 'manual', steps: [{ id: 'ok', run: 'true' }] })

  const summary = await runGatesByPhase(root, contract, 'commit')
  assert.equal(summary.phase, 'commit')
  assert.deepEqual(summary.runs.map((run) => run.gate), ['a-fail', 'b-ok'], '按 id 升序且失败不中断')
  assert.deepEqual(summary.runs.map((run) => run.ok), [false, true])
  assert.deepEqual(summary.skipped, [{ id: 'c-off', reason: 'disabled' }])
  assert.equal(listGateRuns(root, contract, 'a-fail').length, 1, '失败的运行也写日志')
  assert.equal(listGateRuns(root, contract, 'c-off').length, 0, '跳过的不写日志')

  const forced = await runGatesByPhase(root, contract, 'commit', { force: true })
  assert.deepEqual(forced.skipped, [{ id: 'c-off', reason: 'disabled' }], '批量运行不因 force 唤醒 disabled')
  assert.deepEqual(forced.runs.map((run) => run.gate), ['a-fail', 'b-ok'])

  const release = await runGatesByPhase(root, contract, 'release')
  assert.deepEqual(release.runs, [])
  assert.deepEqual(release.skipped, [])

  const manual = await runGatesByPhase(root, contract, 'manual')
  assert.deepEqual(manual.runs.map((run) => run.gate), ['d-manual'])
  assert.equal(manual.runs[0].ok, true)

  for (const phase of ['bogus', 'commit ', 'Commit', '']) {
    await assert.rejects(
      runGatesByPhase(root, contract, phase),
      (error) => error instanceof FlowError && error.code === 'invalid' && /phase must be one of/.test(error.message),
    )
  }
})

test('runGatesByPhase：单条门禁出错时汇总成失败记录，不影响后续', async () => {
  const { root, contract } = freshProject('gate-phase-error')
  addGate(root, contract, { id: 'a-missing', title: '甲缺步骤', phase: 'release', steps: [{ id: 's', run: 'true' }] })
  addGate(root, contract, { id: 'b-ok', title: '乙通过', phase: 'release', steps: [{ id: 'ok', run: 'true' }] })
  // 删除 a 的门禁文件，制造「运行期读不到记录」的错误路径
  fs.rmSync(path.join(root, '.dsh/flow/gates/a-missing.json'))

  const summary = await runGatesByPhase(root, contract, 'release')
  assert.deepEqual(summary.runs.map((run) => run.gate), ['b-ok'])
  assert.deepEqual(summary.skipped, [])
})

// ------------------------------------------------------ flow init 默认门禁

test('initProject 种子门禁：5 条默认清单、幂等、已有门禁不种、noGates 跳过', () => {
  const root = tempRoot('seed-gates')
  const first = initProject(root, { name: 'seed' })
  assert.deepEqual(first.seededGates, ['session-open', 'precommit', 'tests', 'staged-files', 'release'])
  assert.deepEqual(first.warnings, [])
  assert.deepEqual(first.created, ['.dsh/flow/flow.json'], '种子门禁不混进 created 清单')

  const { contract } = loadContract(root)
  const gates = listGates(root, contract)
  assert.equal(gates.length, 5)
  const byId = Object.fromEntries(gates.map((gate) => [gate.id, gate]))
  assert.deepEqual(Object.keys(byId).sort(), ['precommit', 'release', 'session-open', 'staged-files', 'tests'])

  assert.equal(byId['session-open'].phase, 'manual')
  assert.equal(byId['session-open'].enabled, true)
  assert.equal(byId.precommit.phase, 'commit')
  assert.equal(byId.precommit.enabled, true)
  assert.equal(byId.tests.phase, 'commit')
  assert.equal(byId.tests.enabled, false)
  assert.equal(byId['staged-files'].phase, 'commit')
  assert.equal(byId['staged-files'].enabled, false)
  assert.equal(byId.release.phase, 'release')
  assert.equal(byId.release.enabled, false)

  for (const gate of gates) {
    assert.ok(gate.title.trim().length > 0, `${gate.id} 需要中文标题`)
    for (const step of gate.steps) assert.equal(step.expect, 'exit 0')
  }

  // 本插件 CLI 用运行时解析出的包内绝对路径（门禁 cwd 是项目根）
  const expectedBin = path.resolve(HERE, '..', 'bin', 'flow.mjs')
  assert.ok(byId['session-open'].steps[0].run.includes(expectedBin), byId['session-open'].steps[0].run)
  assert.match(byId['session-open'].steps[0].run, /heartbeat status --require-active/)
  assert.ok(byId['staged-files'].steps[0].run.includes(expectedBin))
  assert.match(byId['staged-files'].steps[0].run, /check staged --allow src/)
  assert.match(byId.release.steps[0].run, /check release-baseline --marker RELEASE/)
  assert.equal(byId.precommit.steps[0].run, 'git diff --cached --check')
  assert.equal(byId.tests.steps[0].run, 'node --test test/')

  // 幂等：再 init 一条都不加
  const second = initProject(root, { name: 'seed' })
  assert.deepEqual(second.seededGates, [])
  assert.equal(listGates(root, contract).length, 5)

  // 已有一条自定义门禁 → 不种
  const custom = tempRoot('seed-custom')
  initProject(custom, { name: 'custom', noGates: true })
  const customContract = loadContract(custom).contract
  addGate(custom, customContract, { id: 'only-one', title: '唯一门禁', phase: 'commit' })
  const again = initProject(custom, { name: 'custom' })
  assert.deepEqual(again.seededGates, [])
  assert.deepEqual(listGates(custom, customContract).map((gate) => gate.id), ['only-one'])

  // noGates 完全不种
  const bare = tempRoot('seed-none')
  const bareResult = initProject(bare, { name: 'bare', noGates: true })
  assert.deepEqual(bareResult.seededGates, [])
  assert.deepEqual(listGates(bare, loadContract(bare).contract), [])

  // gates 目录里只要有 .json（哪怕坏的）就不算空，不再种
  const broken = tempRoot('seed-broken')
  initProject(broken, { name: 'broken', noGates: true })
  fs.writeFileSync(path.join(broken, '.dsh/flow/gates/zz-broken.json'), '{ not json')
  drainWarnings()
  const brokenAgain = initProject(broken, { name: 'broken' })
  assert.deepEqual(brokenAgain.seededGates, [])
  assert.deepEqual(fs.readdirSync(path.join(broken, '.dsh/flow/gates')), ['zz-broken.json'])
})

test('CLI init：默认种门禁，--no-gates 不种，人类输出提示', () => {
  const seeded = tempRoot('cli-init-seed')
  const init = runCli(seeded, ['init', '--name', 'seeded', '--json'])
  assert.equal(init.code, 0)
  assert.deepEqual(init.json.data.seededGates, ['session-open', 'precommit', 'tests', 'staged-files', 'release'])
  assert.equal(runCli(seeded, ['gate', 'list', '--json']).json.data.length, 5)

  const human = tempRoot('cli-init-human')
  const humanRun = runCli(human, ['init', '--name', 'human'])
  assert.equal(humanRun.code, 0)
  assert.ok(humanRun.stdout.includes('种入默认门禁 5 条'), humanRun.stdout)

  const bare = tempRoot('cli-init-bare')
  const bareRun = runCli(bare, ['init', '--name', 'bare', '--no-gates', '--json'])
  assert.equal(bareRun.code, 0)
  assert.deepEqual(bareRun.json.data.seededGates, [])
  assert.deepEqual(runCli(bare, ['gate', 'list', '--json']).json.data, [])
})

// ------------------------------------------------------------------ CLI 心跳

test('CLI heartbeat：start 自动建任务、status --require-active 退出码、update/end/list', () => {
  const root = tempRoot('cli-heartbeat')
  runCli(root, ['init', '--name', 'hb-cli', '--no-gates'])
  const session = 'session-cli-e2e'
  const saved = process.env.DSH_SESSION_ID
  delete process.env.DSH_SESSION_ID

  try {
    const started = runCli(root, [
      'heartbeat', 'start', '--session', session, '--goal', 'CLI 心跳',
      '--claim', 'lib/core.mjs', '--claim', 'bin/flow.mjs', '--agent', 'lead', '--json',
    ])
    assert.equal(started.code, 0)
    const startedData = started.json.data
    assert.equal(startedData.session, session)
    assert.equal(startedData.goal, 'CLI 心跳')
    assert.match(startedData.task, /^T-\d{8}-\d{2}$/)
    assert.equal(startedData.createdTask, startedData.task, '自动建任务并回填')
    assert.deepEqual(startedData.claims, ['lib/core.mjs', 'bin/flow.mjs'])
    assert.equal(startedData.status, 'working')
    assert.equal(listTasks(root, loadContract(root).contract).length, 1)

    /* `--task` 曾从 CLI 的 VALUE_FLAGS 白名单里漏掉（帮助有、解析报未知参数），回归锁定。 */
    const explicit = addTask(root, loadContract(root).contract, {
      id: `T-${stamp()}-09`,
      title: '显式指定任务',
      status: 'active',
      owner: 'lead',
    })
    const pinned = runCli(root, ['heartbeat', 'start', '--session', session, '--task', explicit.id, '--json'])
    assert.equal(pinned.code, 0, pinned.stderr)
    assert.equal(pinned.json.data.task, explicit.id)
    assert.equal(pinned.json.data.goal, '显式指定任务', 'goal 缺省取指定任务标题')
    assert.equal(pinned.json.data.createdTask, null)

    const human = runCli(root, ['heartbeat', 'start', '--session', session, '--note', '第二轮'])
    assert.equal(human.code, 0)
    assert.ok(human.stdout.includes('第二轮'), human.stdout)
    assert.ok(human.stdout.includes('working'), human.stdout)
    assert.ok(human.stdout.includes('lib/core.mjs, bin/flow.mjs'), human.stdout)

    const active = runCli(root, ['heartbeat', 'status', '--session', session, '--require-active'])
    assert.equal(active.code, 0)

    const updated = runCli(root, [
      'heartbeat', 'update', '--session', session, '--status', 'idle', '--goal', '改目标', '--json',
    ])
    assert.equal(updated.code, 0)
    assert.equal(updated.json.data.status, 'idle')
    assert.equal(updated.json.data.goal, '改目标')
    assert.equal(runCli(root, ['heartbeat', 'status', '--session', session, '--require-active']).code, 0, 'idle 仍 active')

    const badStatus = runCli(root, ['heartbeat', 'update', '--session', session, '--status', 'done', '--json'])
    assert.equal(badStatus.code, 1)
    assert.equal(badStatus.json.error.code, 'usage')
    const emptyUpdate = runCli(root, ['heartbeat', 'update', '--session', session, '--json'])
    assert.equal(emptyUpdate.code, 1)

    const list = runCli(root, ['heartbeat', 'list', '--json'])
    assert.equal(list.code, 0)
    assert.equal(list.json.data.counts.total, 1)
    assert.equal(list.json.data.counts.active, 1)
    assert.equal(list.json.data.items[0].task, startedData.task)
    const listText = runCli(root, ['heartbeat', 'list'])
    assert.equal(listText.code, 0)
    assert.ok(listText.stdout.includes('改目标'), listText.stdout)
    assert.ok(listText.stdout.includes('lib/core.mjs, bin/flow.mjs'), listText.stdout)
    assert.ok(listText.stdout.includes('active 1'), listText.stdout)

    const ended = runCli(root, ['heartbeat', 'end', '--session', session, '--note', '收尾', '--json'])
    assert.equal(ended.code, 0)
    assert.equal(ended.json.data.status, 'done')
    assert.ok(ended.json.data.ended_at)
    assert.ok(ended.json.data.last_action.includes('收尾'))
    assert.ok(fs.existsSync(path.join(root, '.agents/heartbeat', `${session}.json`)), 'end 后文件保留')

    const inactive = runCli(root, ['heartbeat', 'status', '--session', session, '--require-active'])
    assert.equal(inactive.code, 1, '无 active 心跳时退出 1')
    const inactiveJson = runCli(root, ['heartbeat', 'status', '--session', session, '--require-active', '--json'])
    assert.equal(inactiveJson.code, 1)
    assert.equal(inactiveJson.json.ok, false)

    const neverStarted = runCli(root, ['heartbeat', 'status', '--session', 'session-never', '--require-active'])
    assert.equal(neverStarted.code, 1, '没有心跳文件时 --require-active 也退出 1')

    const noSession = runCli(root, ['heartbeat', 'status', '--json'])
    assert.equal(noSession.code, 1)
    assert.equal(noSession.json.error.code, 'usage')
    const badSub = runCli(root, ['heartbeat', 'bogus', '--json'])
    assert.equal(badSub.code, 1)
  } finally {
    if (saved === undefined) delete process.env.DSH_SESSION_ID
    else process.env.DSH_SESSION_ID = saved
  }
})

// ---------------------------------------------- CLI 心跳作用域（子会话拒绝）

/** 在临时 DSH_HOME 里写一条会话日志 header（CLI 据此判定主会话/子会话）。 */
function writeSessionHeader(home, session, header) {
  const dir = path.join(home, 'sessions', '--tmp-project--', session)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'session.v4.jsonl'),
    `${JSON.stringify({ type: 'session', version: 4, createdAt: 0, isSeeded: false, ...header, id: session })}\n`,
    'utf8',
  )
}

test('CLI heartbeat：子会话拒绝写心跳，主会话放行；旧子会话心跳隐藏并被 gc 清理', () => {
  const { root } = freshProject('cli-hb-scope')
  const home = tempRoot('cli-dsh-home')
  const subSession = 'session-sub-cli'
  const mainSession = 'session-main-cli'
  writeSessionHeader(home, subSession, { origin: 'subagent', delegationDepth: 1, parentSession: mainSession })
  writeSessionHeader(home, mainSession, {})

  const subEnv = { DSH_HOME: home, DSH_SESSION_ID: subSession }
  for (const args of [
    ['heartbeat', 'start', '--session', subSession, '--goal', 'x', '--json'],
    ['heartbeat', 'update', '--session', subSession, '--status', 'idle', '--json'],
    ['heartbeat', 'end', '--session', subSession, '--json'],
  ]) {
    const denied = runCli(root, args, subEnv)
    assert.equal(denied.code, 1, `${args.join(' ')} 必须拒绝`)
    assert.equal(denied.json.error.code, 'usage')
    assert.match(denied.json.error.message, /只面向主会话/)
  }
  assert.ok(!fs.existsSync(path.join(root, '.agents/heartbeat', `${subSession}.json`)), '拒绝时不写文件')
  assert.equal(runCli(root, ['heartbeat', 'list', '--json'], subEnv).code, 0, 'list 只读放行')

  const mainEnv = { DSH_HOME: home, DSH_SESSION_ID: mainSession }
  const mainStarted = runCli(root, ['heartbeat', 'start', '--session', mainSession, '--goal', '主会话', '--json'], mainEnv)
  assert.equal(mainStarted.code, 0, mainStarted.stderr)
  assert.equal(mainStarted.json.data.session, mainSession)

  const contract = loadContract(root).contract
  startHeartbeat(root, contract, { session: 'session-old-sub', agent: 'subagent', createTask: false })
  const cleanEnv = { DSH_HOME: home, DSH_SESSION_ID: '' }
  const hiddenList = runCli(root, ['heartbeat', 'list', '--json'], cleanEnv)
  assert.equal(hiddenList.code, 0)
  assert.equal(hiddenList.json.data.counts.hidden, 1)
  assert.deepEqual(hiddenList.json.data.items.map((item) => item.session), [mainSession])
  const listText = runCli(root, ['heartbeat', 'list'], cleanEnv)
  assert.ok(listText.stdout.includes('旧子会话隐藏 1'), listText.stdout)
  assert.ok(listText.stdout.includes('flow heartbeat gc'), listText.stdout)

  const dryRun = runCli(root, ['heartbeat', 'gc', '--dry-run', '--json'], cleanEnv)
  assert.equal(dryRun.code, 0)
  assert.equal(dryRun.json.data.dryRun, true)
  assert.equal(dryRun.json.data.removed.length, 1)
  assert.ok(fs.existsSync(path.join(root, '.agents/heartbeat', 'session-old-sub.json')), 'dry-run 不删除')

  const cleaned = runCli(root, ['heartbeat', 'gc', '--json'], cleanEnv)
  assert.equal(cleaned.code, 0)
  assert.equal(cleaned.json.data.removed[0].file, 'session-old-sub.json')
  assert.ok(!fs.existsSync(path.join(root, '.agents/heartbeat', 'session-old-sub.json')))
  const humanGc = runCli(root, ['heartbeat', 'gc'], cleanEnv)
  assert.equal(humanGc.code, 0)
  assert.ok(humanGc.stdout.includes('已清理旧子会话心跳 0 条'), humanGc.stdout)
})

test('CLI gate：disabled 拒绝、--force 可跑、enable/disable 糖、run --phase 汇总', () => {
  const root = tempRoot('cli-gate-phase')
  runCli(root, ['init', '--name', 'gates-cli', '--no-gates'])
  runCli(root, ['gate', 'add', '--id', 'a-ok', '--title', '甲通过', '--phase', 'commit', '--step', 'ok=true'])
  runCli(root, ['gate', 'add', '--id', 'b-fail', '--title', '乙失败', '--phase', 'commit', '--step', 'bad=exit 3'])
  runCli(root, ['gate', 'add', '--id', 'c-off', '--title', '丙关闭', '--phase', 'commit', '--step', 'ok=true'])

  const disabled = runCli(root, ['gate', 'disable', 'c-off', '--json'])
  assert.equal(disabled.code, 0)
  assert.equal(disabled.json.data.enabled, false)

  const rejected = runCli(root, ['gate', 'run', 'c-off', '--json'])
  assert.equal(rejected.code, 1)
  assert.equal(rejected.json.error.code, 'usage')
  assert.match(rejected.json.error.message, /disabled/)

  const forced = runCli(root, ['gate', 'run', 'c-off', '--force', '--json'])
  assert.equal(forced.code, 0)
  assert.equal(forced.json.data.ok, true)

  const enabled = runCli(root, ['gate', 'enable', 'c-off', '--json'])
  assert.equal(enabled.code, 0)
  assert.equal(enabled.json.data.enabled, true)
  assert.equal(runCli(root, ['gate', 'disable', 'c-off', '--json']).code, 0)

  const phase = runCli(root, ['gate', 'run', '--phase', 'commit', '--json'])
  assert.equal(phase.code, 0)
  assert.deepEqual(phase.json.data.runs.map((run) => run.gate), ['a-ok', 'b-fail'])
  assert.deepEqual(phase.json.data.runs.map((run) => run.ok), [true, false])
  assert.deepEqual(phase.json.data.skipped, [{ id: 'c-off', reason: 'disabled' }])

  const text = runCli(root, ['gate', 'run', '--phase', 'commit'])
  assert.equal(text.code, 0, '批量运行门禁失败仍退出 0，用汇总表达')
  assert.ok(text.stdout.includes('运行 2 条'), text.stdout)
  assert.ok(text.stdout.includes('通过 1'), text.stdout)
  assert.ok(text.stdout.includes('失败 1 条'), text.stdout)
  assert.ok(text.stdout.includes('c-off 跳过（disabled）'), text.stdout)

  const badPhase = runCli(root, ['gate', 'run', '--phase', 'bogus', '--json'])
  assert.equal(badPhase.code, 2)
  assert.equal(badPhase.json.error.code, 'invalid')

  const both = runCli(root, ['gate', 'run', 'a-ok', '--phase', 'commit'])
  assert.equal(both.code, 1, 'id 与 --phase 不能同时给')
})

// ------------------------------------------- 心跳任务选择（owner 为角色/代理名）

test('heartbeat start：复用 owner 为 agent 角色的 active 任务，不重复建卡', () => {
  const { root, contract } = freshProject('hb-reuse-agent')
  const task = addTask(root, contract, {
    id: `T-${stamp()}-01`,
    title: '角色任务',
    status: 'active',
    owner: 'lead',
  })

  const record = startHeartbeat(root, contract, { session: 'session-abc', agent: 'lead' })
  assert.equal(record.createdTask, null, '已有 active 任务时不应新建')
  assert.equal(record.task, task.id)
  assert.equal(record.goal, '角色任务')
  assert.equal(listTasks(root, contract).length, 1, '任务总数不变')
})

test('heartbeat start：owner 为空时复用全库唯一 active 任务', () => {
  const { root, contract } = freshProject('hb-reuse-global')
  const task = addTask(root, contract, {
    id: `T-${stamp()}-01`,
    title: '无主任务',
    status: 'active',
    owner: '',
  })

  const record = startHeartbeat(root, contract, { session: 'session-xyz', agent: 'lead' })
  assert.equal(record.createdTask, null, '无主 active 任务应被复用')
  assert.equal(record.task, task.id)
  assert.equal(record.goal, '无主任务')
  assert.equal(listTasks(root, contract).length, 1, '任务总数不变')
})

test('heartbeat start：他人名下的 active 任务不被抢占，改为新建', () => {
  const { root, contract } = freshProject('hb-no-steal')
  const other = addTask(root, contract, {
    id: `T-${stamp()}-01`,
    title: '别人的任务',
    status: 'active',
    owner: 'someone-else',
  })

  const record = startHeartbeat(root, contract, { session: 'session-xyz', agent: 'lead' })
  assert.notEqual(record.createdTask, null, '不能把心跳挂到他人任务上，应新建')
  assert.notEqual(record.task, other.id)
  assert.equal(listTasks(root, contract).length, 2, '原任务保留 + 新建一张')
})

test('heartbeat start：多条 active 时取 updated_at 最新的一条', () => {
  const { root, contract } = freshProject('hb-reuse-newest')
  addTask(root, contract, {
    id: `T-${stamp()}-01`,
    title: '旧任务',
    status: 'active',
    owner: '',
    updated_at: '2026-01-01T09:00:00+08:00',
  })
  const newer = addTask(root, contract, {
    id: `T-${stamp()}-02`,
    title: '新任务',
    status: 'active',
    owner: '',
    updated_at: '2026-02-01T09:00:00+08:00',
  })

  const record = startHeartbeat(root, contract, { session: 'session-pick', agent: 'lead' })
  assert.equal(record.createdTask, null, '多条 active 也只复用，不新建')
  assert.equal(record.task, newer.id, '取 updated_at 最新的一条')
  assert.equal(record.goal, '新任务')
  assert.equal(listTasks(root, contract).length, 2)
})
