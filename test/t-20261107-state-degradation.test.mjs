// T-20261107 · task-57：core 降级路径的机器断言。
//
// 背景：`lib/state-snapshot.mjs:61-67` 用 `try { core = await import(CORE_URL) }
// catch { coreFailure = … }` 把 core 做成**可选依赖**——core 坏掉时插件不该整个
// 加载失败，面板应拿到一份带可读原因的合法空 payload。但这条路径此前零覆盖：
// `requireCore` 改坏、`emptyStoreState` 返回错形状，都不会有测试红，用户只会
// 看到"面板没数据"。
//
// 测试手法（无注入 seam：core/coreFailure/CORE_URL 都是模块级私有 + 顶层 await）：
//   1. 把**真实的** lib/state-snapshot.mjs 逐字节复制到临时目录（先断言 sha256
//      一致，否则测的是副本不是真源码）；
//   2. 副本目录里不放 core.mjs（该文件只 import node 内建 + 动态 core，单文件可跑）；
//   3. 用子进程 import 副本，把 coreAvailable()/coreUnavailableMessage()/
//      requireCore()/buildSnapshot() 的行为打到 stdout，父进程断言。
// 不在真实树里 mv/删 lib/core.mjs（那是中间态残留，也会和并发队员打架）。
//
// 正例先行：先断言"真树的 core 正常时不走降级"，再断言降级路径——否则一个
// "永远返回降级"的错误实现也能让否定断言全绿。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as snapshots from '../lib/state-snapshot.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SNAPSHOT_SRC = path.join(REPO, 'lib', 'state-snapshot.mjs')

const TEMP_DIRS = []
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pf-degrade-${label}-`))
  TEMP_DIRS.push(dir)
  return dir
}
after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** 把真实快照模块复制到临时目录；返回副本与一个空的"项目根"。 */
function stageSnapshotCopy(label) {
  const dir = tempDir(label)
  const lib = path.join(dir, 'lib')
  fs.mkdirSync(lib, { recursive: true })
  const copy = path.join(lib, 'state-snapshot.mjs')
  fs.copyFileSync(SNAPSHOT_SRC, copy)
  // 先证明复制的是真源码：否则下面的断言只是在测一个可能被篡改的副本。
  assert.equal(sha256(copy), sha256(SNAPSHOT_SRC), 'copied state-snapshot.mjs differs from lib/state-snapshot.mjs')
  const project = path.join(dir, 'project')
  fs.mkdirSync(project, { recursive: true })
  return { dir, lib, copy, project }
}

/** 子进程探针：加载副本并输出可 JSON 化的行为快照。 */
const PROBE = [
  "import process from 'node:process'",
  'const mod = await import(process.env.PF_PROBE_SNAPSHOT)',
  'const root = process.env.PF_PROBE_ROOT',
  'let requireError = null',
  'try { mod.requireCore() } catch (error) { requireError = String((error && error.message) || error) }',
  "const payload = await mod.buildSnapshot({ root, realRoot: root, entry: { path: root, name: '' }, hostWarnings: ['host-warning: probe'] })",
  'process.stdout.write(JSON.stringify({ coreAvailable: mod.coreAvailable(), coreMessage: mod.coreUnavailableMessage(), requireError, payload }))',
].join('\n')

function runProbe(copy, root) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, PF_PROBE_SNAPSHOT: pathToFileURL(copy).href, PF_PROBE_ROOT: root },
  })
  // 顶层 awaiting import 或 buildSnapshot 抛错都会让这里非 0；这本身就是断言。
  assert.equal(result.status, 0, `degraded probe crashed: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout)
}

/**
 * 降级载荷的**合法形状**。
 *
 * 断言的是"消费端必需且降级路径也必须给"的键；注意当前 `emptyStoreState`
 * 与正常 `buildStoreState` 有两处已知差异（另立卡跟进，不在本测试里锁死）：
 *   1. 缺 `heartbeatsHidden`（client.js 用 `asNumber(x, 0)` 兜底，不会崩）；
 *   2. `experiments.counts` 缺 `inconclusive`/`pivoted`（client.js 同样有兜底）。
 * 这里只断言两份 payload 都**必须**有的部分，将来修好差异不会误红。
 */
function assertPayloadShape(payload, root) {
  assert.ok(payload !== null && typeof payload === 'object' && Array.isArray(payload) === false, 'payload must be an object')
  for (const key of [
    'ok',
    'generatedAt',
    'contract',
    'roots',
    'root',
    'head',
    'experiments',
    'tasks',
    'gates',
    'heartbeats',
    'decisions',
    'warnings',
  ]) {
    assert.ok(Object.hasOwn(payload, key), `payload missing key: ${key}`)
  }
  assert.equal(payload.ok, true)
  assert.equal(typeof payload.generatedAt, 'string')
  assert.equal(payload.root, root)
  assert.deepEqual(payload.roots, [])
  assert.equal(payload.contract.schema, 2)
  assert.equal(typeof payload.contract.name, 'string')
  assert.deepEqual(Object.keys(payload.head).sort(), ['branch', 'dirty', 'sha', 'subject'])

  assert.equal(typeof payload.tasks.total, 'number')
  for (const key of ['draft', 'active', 'done', 'archived', 'other']) {
    assert.equal(typeof payload.tasks.counts[key], 'number', `tasks.counts.${key} must be a number`)
  }
  for (const key of ['active', 'recentDone', 'draft']) {
    assert.ok(Array.isArray(payload.tasks[key]), `tasks.${key} must be an array`)
  }
  assert.equal(payload.tasks.current, null)

  assert.equal(typeof payload.experiments.total, 'number')
  for (const key of ['total', 'open', 'confirmed', 'refuted', 'abandoned']) {
    assert.equal(typeof payload.experiments.counts[key], 'number', `experiments.counts.${key} must be a number`)
  }
  assert.ok(Array.isArray(payload.gates))
  assert.ok(Array.isArray(payload.heartbeats))

  assert.ok(Array.isArray(payload.decisions.items))
  for (const key of ['open', 'blocking', 'escalated', 'answered', 'withdrawn', 'superseded', 'total']) {
    assert.equal(typeof payload.decisions.counts[key], 'number', `decisions.counts.${key} must be a number`)
  }
  assert.ok(Array.isArray(payload.warnings))
}

// ------------------------------------------------------------------ 正例
test('正例：core 正常时 buildSnapshot 不走降级，也不带 core-unavailable 原因', async () => {
  assert.equal(snapshots.coreAvailable(), true, 'real tree must load lib/core.mjs')
  const core = snapshots.coreModule()
  assert.ok(core !== null && typeof core === 'object', 'coreModule() must expose the loaded module')
  assert.equal(typeof core.loadContract, 'function', 'coreModule() must be a real core (loadContract is a function)')
  assert.equal(snapshots.requireCore(), core, 'requireCore() returns the same loaded module')

  const root = tempDir('healthy')
  const payload = await snapshots.buildSnapshot({
    root,
    realRoot: root,
    entry: { path: root, name: 'healthy' },
    hostWarnings: [],
  })
  assertPayloadShape(payload, root)
  assert.equal(
    payload.warnings.some((line) => typeof line === 'string' && line.startsWith('core-unavailable:')),
    false,
    'a healthy core must not produce the degradation warning'
  )
})

// ------------------------------------------------------ 降级 ①：core 不存在
test('降级（core.mjs 缺失）：buildSnapshot 仍返回合法形状，且带可读原因', () => {
  const { copy, lib, project } = stageSnapshotCopy('missing')
  assert.equal(fs.existsSync(path.join(lib, 'core.mjs')), false, 'the copy dir must not contain core.mjs')

  const probe = runProbe(copy, project)

  // 降级分支确实被走到（否定断言的前置）。
  assert.equal(probe.coreAvailable, false, 'missing core.mjs must make coreAvailable() false')
  assert.match(
    probe.coreMessage,
    /^core-unavailable: lib\/core\.mjs could not be loaded \(.+\); the store, flow_\* tools and skills are unavailable$/,
    'coreUnavailableMessage() must carry the failure detail and the actionable tail, not just a label'
  )
  assert.match(probe.requireError, /is not installed/, 'requireCore() must throw the actionable CLI hint')
  assert.match(probe.requireError, /core\.mjs could not be loaded/, 'requireCore() must name the missing module')

  // 载荷合法且**带原因**，不是静默空对象。
  assertPayloadShape(probe.payload, project)
  const reasons = probe.payload.warnings.filter(
    (line) => typeof line === 'string' && line.startsWith('core-unavailable: ')
  )
  assert.equal(reasons.length, 1, `expected exactly one core-unavailable reason, got ${reasons.length}`)
  assert.equal(reasons[0], probe.coreMessage, 'the payload must carry coreUnavailableMessage() verbatim')
  assert.ok(
    probe.payload.warnings.includes('host-warning: probe'),
    'host warnings must survive the degraded path'
  )
})

// -------------------------------------------------- 降级 ②：core 形状坏掉
test('降级（core.mjs 可加载但形状坏）：读 store 失败也降级为空 payload 并给原因', () => {
  const { lib, copy, project } = stageSnapshotCopy('malformed')
  fs.writeFileSync(path.join(lib, 'core.mjs'), 'export const loadContract = 42\n', 'utf8')

  const probe = runProbe(copy, project)

  // 可加载的坏 core 不算"缺失"，走的是 buildStoreState 的读失败兜底。
  assert.equal(probe.coreAvailable, true, 'a loadable but malformed core.mjs must not be treated as missing')
  assertPayloadShape(probe.payload, project)
  assert.ok(
    probe.payload.warnings.some((line) => typeof line === 'string' && line.startsWith('store contract unreadable: ')),
    `expected a readable store-contract failure, got warnings: ${JSON.stringify(probe.payload.warnings)}`
  )
})
