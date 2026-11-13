// T-20261107 · task-57/58：core 降级路径 + 降级/健康 payload 形状一致性。
//
// 背景：`lib/state-snapshot.mjs:61-67` 用 `try { core = await import(CORE_URL) }
// catch { coreFailure = … }` 把 core 做成**可选依赖**——core 坏掉时插件不该整个
// 加载失败，面板应拿到一份带可读原因的合法空 payload。这条路径此前零覆盖：
// `requireCore` 改坏、`emptyStoreState` 返回错形状，都不会有测试红。
//
// task-58 又发现「零覆盖」的后果：降级 payload 曾悄悄缩水（缺 `heartbeatsHidden`
// 与 `experiments.counts` 的 `inconclusive`/`pivoted`/`unreadable`），而当时的
// 测试把 12 个顶层键的字面量钉死了——**等于把 bug 固化成契约**。现在改成
// 「降级键集合 == 健康键集合」：任一侧加/减字段而另一侧忘了，测试会红。
//
// 测试手法（无注入 seam：core/coreFailure/CORE_URL 都是模块级私有 + 顶层 await）：
//   1. 把**真实的** lib/state-snapshot.mjs 逐字节复制到临时目录（先断言 sha256
//      一致，否则测的是副本不是真源码）；
//   2. 副本目录里不放 core.mjs（该文件只 import node 内建 + 动态 core，单文件可跑）；
//   3. 用子进程 import 副本，把 coreAvailable()/coreUnavailableMessage()/
//      requireCore()/buildSnapshot() 的行为打到 stdout，父进程断言。
// 不在真实树里 mv/删 lib/core.mjs（那是中间态残留，也会和并发队员打架）。
//
// 正例先行：健康参考 payload 必须来自**真正的 buildStoreState**（临时 root 里
// 写一个 `.agents/flow/flow.json`），不能落到 `emptyStoreState` 兜底——否则两边同源，
// 形状对比会完美假绿。

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
  // P2.5 made state-snapshot import lib/stage.mjs (a pure data module), so the
  // copy needs that dependency too — otherwise the probe dies with
  // ERR_MODULE_NOT_FOUND instead of exercising the degradation path it targets.
  // Only this one module is copied on purpose: `core.mjs` stays ABSENT, because
  // a missing core is exactly what these probes are meant to simulate.
  for (const dep of ['util.mjs', 'stage.mjs']) {
    const depCopy = path.join(lib, dep)
    fs.copyFileSync(path.join(REPO, 'lib', dep), depCopy)
    assert.equal(sha256(depCopy), sha256(path.join(REPO, 'lib', dep)), `copied ${dep} differs from lib/${dep}`)
  }
  const project = path.join(dir, 'project')
  fs.mkdirSync(project, { recursive: true })
  return { dir, lib, copy, project }
}

/** 一个**初始化过**的 store：有 .agents/flow/flow.json（加一份夹具模块图），所以 buildStoreState 不会走兜底。 */
function healthyStoreRoot(label) {
  const root = tempDir(`healthy-${label}`)
  fs.mkdirSync(path.join(root, '.agents', 'flow'), { recursive: true })
  fs.writeFileSync(
    path.join(root, '.agents', 'flow', 'flow.json'),
    `${JSON.stringify({ schema: 2, name: `degradation-${label}` })}\n`,
    'utf8'
  )
  writeFrameworkFixture(root)
  return root
}


/**
 * 健康参考 payload（模块内缓存一次）。
 * 它必须由 `buildStoreState` 生成——测试里显式断言它带 `heartbeatsHidden` 与
 * 8 键的 `experiments.counts`，否则就是退回到了 emptyStoreState。
 */
let healthyReference = null
async function healthyPayload() {
  if (healthyReference === null) {
    const root = healthyStoreRoot('reference')
    healthyReference = await snapshots.buildSnapshot({
      root,
      realRoot: root,
      entry: { path: root, name: 'degradation-reference' },
      hostWarnings: [],
    })
  }
  return healthyReference
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
 * 降级载荷的合法形状（逐项校验保留自 task-57），并在给了 `reference` 时追加
 * **形状一致性**断言：顶层键集合与三个 counts 的键集合必须与健康 payload 相等。
 *
 * 不比较 `experiments` 容器本身：关闭实验区时健康 payload 只给
 * `{enabled,total,counts}`，而降级载荷给 `{source,total,counts,items,tree,groups}`
 * ——这是 CONTRACT §9.1.3 规定的两种模式差异，不是漂移。`tasks.trend` 同理是
 * 文档声明的可选字段。
 */
function assertPayloadShape(payload, root, reference = null) {
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

  if (reference === null) return
  const sortedKeys = (value) => Object.keys(value).sort()
  assert.deepEqual(
    sortedKeys(payload),
    sortedKeys(reference),
    `degraded payload top-level keys drifted from the healthy shape: ${JSON.stringify(sortedKeys(payload))} vs ${JSON.stringify(sortedKeys(reference))}`
  )
  for (const [label, actual, expected] of [
    ['experiments.counts', payload.experiments.counts, reference.experiments.counts],
    ['tasks.counts', payload.tasks.counts, reference.tasks.counts],
    ['decisions.counts', payload.decisions.counts, reference.decisions.counts],
  ]) {
    assert.deepEqual(
      sortedKeys(actual),
      sortedKeys(expected),
      `${label} keys drifted from the healthy shape: ${JSON.stringify(sortedKeys(actual))} vs ${JSON.stringify(sortedKeys(expected))}`
    )
  }
  // 降级态没有数据：计数必须是 0（不是 undefined/NaN），可读原因另行断言。
  assert.equal(payload.heartbeatsHidden, 0, 'heartbeatsHidden must be an explicit 0, not a missing key')
  assert.equal(payload.tasks.total, 0)
  for (const [key, value] of Object.entries(payload.tasks.counts)) {
    assert.equal(value, 0, `tasks.counts.${key} must be 0 in the degraded payload`)
  }
  assert.equal(payload.experiments.total, 0)
  for (const [key, value] of Object.entries(payload.experiments.counts)) {
    assert.equal(value, 0, `experiments.counts.${key} must be 0 in the degraded payload`)
  }
  for (const [key, value] of Object.entries(payload.decisions.counts)) {
    assert.equal(value, 0, `decisions.counts.${key} must be 0 in the degraded payload`)
  }
}

/**
 * framework 结构投影的公共形状断言（T-20261113162857）：两条 payload 路径都会带这一节，
 * 前端按这里校验的字段画「模块层次树 + 横向切片」。
 */
function assertFrameworkShape(framework) {
  assert.ok(framework !== null && typeof framework === 'object', 'framework must be an object')
  assert.equal(typeof framework.degraded, 'boolean')
  assert.deepEqual(
    Object.keys(framework.summary).sort(),
    ['describedModules', 'files', 'graphModules', 'graphRoles', 'graphSlices', 'graphUnmanaged', 'missingSemantics', 'plans'],
    'framework.summary must keep the eight fixed keys, with no name shared by two artifacts'
  )
  for (const [key, value] of Object.entries(framework.summary)) {
    assert.ok(value === null || typeof value === 'number', 'framework.summary.' + key + ' must be a number or null')
  }
  if (framework.degraded === true) {
    assert.deepEqual(Object.keys(framework).sort(), ['degraded', 'summary'], 'a degraded framework section keeps only summary')
    return
  }
  for (const key of ['modulesTruncated', 'slicesTruncated', 'rolesTruncated', 'unmanagedTruncated']) {
    assert.equal(typeof framework[key], 'boolean', 'framework.' + key + ' must be a boolean')
  }
  assert.ok(Array.isArray(framework.modules), 'framework.modules must be an array')
  for (const module of framework.modules) {
    assert.equal(typeof module.name, 'string')
    assert.equal(typeof module.title, 'string')
    assert.equal(typeof module.sectionsTruncated, 'boolean')
    assert.ok(Array.isArray(module.owns), 'module.owns must be an array')
    for (const entry of module.owns) {
      assert.equal(typeof entry.path, 'string')
      assert.ok(entry.kind === 'file' || entry.kind === 'dir', 'module.owns[].kind must be file|dir')
    }
    assert.ok(Array.isArray(module.sections), 'module.sections must be an array')
    for (const section of module.sections) {
      assert.equal(typeof section.key, 'string')
      assert.ok(Array.isArray(section.members), 'module.sections[].members must be an array')
      assert.equal(typeof section.membersTruncated, 'boolean')
    }
    assert.ok(Array.isArray(module.slices), 'module.slices must be an array')
  }
  assert.ok(Array.isArray(framework.slices), 'framework.slices must be an array')
  for (const slice of framework.slices) {
    for (const key of ['id', 'title', 'semantics', 'ownerRole', 'rationale']) {
      assert.equal(typeof slice[key], 'string', 'slice.' + key + ' must be a string')
    }
    assert.ok(Array.isArray(slice.files), 'slice.files must be an array')
    for (const file of slice.files) {
      assert.equal(typeof file.path, 'string')
      assert.ok(file.moduleName === null || typeof file.moduleName === 'string', 'slice.files[].moduleName must be a string or null')
      assert.equal(typeof file.exists, 'boolean')
    }
    assert.ok(Array.isArray(slice.modules), 'slice.modules must be an array')
    assert.ok(Array.isArray(slice.missingFiles), 'slice.missingFiles must be an array')
    assert.equal(typeof slice.filesTruncated, 'boolean')
    assert.equal(typeof slice.missingFilesTruncated, 'boolean')
  }
  assert.ok(Array.isArray(framework.roles), 'framework.roles must be an array')
  for (const role of framework.roles) {
    for (const key of ['id', 'title', 'semantics']) {
      assert.equal(typeof role[key], 'string', 'role.' + key + ' must be a string')
    }
    assert.ok(Array.isArray(role.modules), 'role.modules must be an array')
  }
  assert.ok(Array.isArray(framework.unmanaged), 'framework.unmanaged must be an array')
  for (const row of framework.unmanaged) {
    assert.equal(typeof row.path, 'string')
    assert.equal(typeof row.reason, 'string', 'unmanaged[].reason is an additive echo of the map')
  }
  assert.ok(Array.isArray(framework.warnings), 'framework.warnings must be an array')
  for (const line of framework.warnings) assert.equal(typeof line, 'string')
}

/**
 * 测试夹具自带的模块图：正例只断言**这份夹具**，与仓库里的 docs/module-domain.json
 * 解耦（那份 map 一改就不该让本测试红，也不该掩盖「读错主体」的回归）。
 */
const FRAMEWORK_FIXTURE = {
  modules: {
    alpha: { title: 'Alpha', owns: ['lib/', 'README.md'], sections: { 'lib/a.mjs': ['one', 'two'] } },
    beta: { title: 'Beta', owns: ['docs/'], sections: {} },
  },
  aspects: {
    'slice-one': {
      title: 'Slice one',
      semantics: 'slice semantics',
      ownerRole: 'alpha-owner',
      rationale: 'why the slice exists',
      files: ['lib/a.mjs', 'stray.txt', 'docs/missing.md'],
    },
  },
  roles: { 'alpha-owner': { title: 'Owner', semantics: 'role semantics', modules: ['alpha', 'ghost-module'] } },
  unmanaged: [{ path: 'stray.txt', reason: 'fixture file' }],
}

/** 把夹具 map 写到 <root>/docs，并落下 slice 指向的真实文件。 */
function writeFrameworkFixture(root) {
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8')
  fs.writeFileSync(path.join(root, 'lib', 'a.mjs'), '// fixture\n', 'utf8')
  fs.writeFileSync(path.join(root, 'stray.txt'), 'fixture\n', 'utf8')
  fs.writeFileSync(path.join(root, 'docs', 'module-domain.json'), JSON.stringify(FRAMEWORK_FIXTURE, null, 2) + '\n', 'utf8')
}

// ------------------------------------------------------------------ 正例
// ------------------------------------------------------------------ 正例
test('正例：core 正常时 buildSnapshot 不走降级，且形状含 heartbeatsHidden 与 8 键 counts', async () => {
  assert.equal(snapshots.coreAvailable(), true, 'real tree must load lib/core.mjs')
  const core = snapshots.coreModule()
  assert.ok(core !== null && typeof core === 'object', 'coreModule() must expose the loaded module')
  assert.equal(typeof core.loadContract, 'function', 'coreModule() must be a real core (loadContract is a function)')
  assert.equal(snapshots.requireCore(), core, 'requireCore() returns the same loaded module')

  const payload = await healthyPayload()
  assertPayloadShape(payload, payload.root)
  assert.equal(
    payload.warnings.some((line) => typeof line === 'string' && line.startsWith('core-unavailable:')),
    false,
    'a healthy core must not produce the degradation warning'
  )
  // 健康参考必须来自 buildStoreState（不是 emptyStoreState 兜底），否则形状对比同源假绿。
  assert.equal(Object.hasOwn(payload, 'heartbeatsHidden'), true, 'healthy payload must carry heartbeatsHidden')
  assert.deepEqual(
    Object.keys(payload.experiments.counts).sort(),
    ['abandoned', 'confirmed', 'inconclusive', 'open', 'pivoted', 'refuted', 'total', 'unreadable'],
    'healthy experiments.counts must be the 8-key shape from CONTRACT §9.1.3'
  )

  // 新 framework 结构投影（T-20261113162857）：结构必须来自**被查看 workspace 的**
  // docs/module-domain.json（不是插件安装目录），并且 modules 的两种口径不得同名混用。
  assert.equal(Object.hasOwn(payload, 'framework'), true, 'healthy payload must carry the framework structure section')
  assertFrameworkShape(payload.framework)
  assert.equal(payload.framework.degraded, false, 'a workspace with a module map must project as healthy')
  assert.equal(payload.framework.modules.length, Object.keys(FRAMEWORK_FIXTURE.modules).length, 'every module of the map is projected')
  assert.equal(payload.framework.slices.length, Object.keys(FRAMEWORK_FIXTURE.aspects).length, 'the map aspects are projected as slices')
  assert.equal(payload.framework.roles.length, Object.keys(FRAMEWORK_FIXTURE.roles).length)
  assert.deepEqual(payload.framework.modules.map((module) => module.name), ['alpha', 'beta'])
  const alpha = payload.framework.modules[0]
  assert.deepEqual(alpha.owns.map((entry) => entry.kind), ['dir', 'file'])
  assert.deepEqual(alpha.sections, [{ key: 'lib/a.mjs', members: ['one', 'two'], membersTruncated: false }])
  assert.deepEqual(alpha.slices, ['slice-one'])
  const slice = payload.framework.slices[0]
  assert.deepEqual(slice.modules, ['alpha', 'beta'])
  assert.deepEqual(slice.missingFiles, ['docs/missing.md'])
  assert.deepEqual(
    slice.files.map((file) => [file.path, file.moduleName, file.exists]),
    [
      ['lib/a.mjs', 'alpha', true],
      ['stray.txt', null, true],
      ['docs/missing.md', 'beta', false],
    ]
  )
  assert.ok(
    payload.framework.warnings.includes('role-module-dangling: alpha-owner -> ghost-module'),
    'a role naming an undeclared module must warn instead of projecting a dangling name'
  )
  assert.deepEqual(payload.framework.roles[0].modules, ['alpha'], 'dangling role modules are filtered out')
  // summary 的两种 modules 口径必须分开命名。
  assert.equal(Object.hasOwn(payload.framework.summary, 'modules'), false, 'the ambiguous modules key must be gone')
  assert.equal(payload.framework.summary.describedModules, null, 'no description ledger in the fixture -> null, not a fake 0')
  assert.equal(payload.framework.summary.graphModules, 2)
  assert.equal(payload.framework.summary.graphSlices, 1)
  assert.equal(payload.framework.summary.graphRoles, 1)
  assert.equal(payload.framework.summary.graphUnmanaged, 1)
  assert.equal(payload.framework.modulesTruncated, false)
  assert.equal(payload.framework.slicesTruncated, false)
  assert.equal(payload.framework.rolesTruncated, false)
  assert.equal(payload.framework.unmanagedTruncated, false)
})


// ------------------------------------------------------ 降级 ①：core 不存在
test('降级（core.mjs 缺失）：payload 形状与健康一致，且带可读原因', async () => {
  const reference = await healthyPayload()
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

  // 载荷合法、形状与健康 payload 一致，且**带原因**，不是静默空对象。
  assertPayloadShape(probe.payload, project, reference)
  // 副本目录的包根下没有 docs/module-domain.json：这条真实 payload 路径必须降级成
  // 只回 summary 的 framework 节，而不是抛错或凭空造树。
  assert.equal(probe.payload.framework.degraded, true, 'a probe copy without docs/ has no module map to project')
  assert.deepEqual(Object.keys(probe.payload.framework).sort(), ['degraded', 'summary'])
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

// ------------------------------- framework 结构投影：每个列表都有上限 + truncated
test('framework 结构投影：modules/slices/roles/sections/members/files/unmanaged 全部有界且带标记', async () => {
  const root = tempDir('framework-bounded')
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n', 'utf8')

  const sliceFiles = ['docs/UNOWNED.md', 'README.md']
  for (let index = 0; index < 205; index += 1) sliceFiles.push('lib/file-' + index + '.mjs')

  const bigSections = { 'lib/a.mjs': [] }
  for (let index = 0; index < 51; index += 1) bigSections['lib/a.mjs'].push('member-' + index)
  for (let index = 0; index < 100; index += 1) bigSections['lib/d' + String(index).padStart(3, '0') + '.mjs'] = ['x']

  const modules = { 'big-module': { title: 'Big', owns: ['lib/'], sections: bigSections } }
  for (let index = 0; index < 200; index += 1) {
    modules['d' + String(index).padStart(3, '0')] = { title: 'D', owns: [], sections: {} }
  }
  const roles = {}
  for (let index = 0; index < 201; index += 1) {
    roles['r' + String(index).padStart(3, '0')] = { title: 'R', semantics: 's', modules: ['big-module'] }
  }
  roles.r000.modules.push('ghost-module')
  const slices = {}
  for (let index = 0; index < 201; index += 1) {
    slices['s' + String(index).padStart(3, '0')] = { title: 'S', semantics: 'sem', ownerRole: 'r000', rationale: 'why', files: [] }
  }
  // 只有字典序最前的 slice 带文件：它一定在截断后仍可见，后面的 200 个用来撞上限。
  slices.s000.files = sliceFiles
  const unmanaged = []
  for (let index = 0; index < 250; index += 1) unmanaged.push({ path: '.selftest/u-' + index + '.mjs', reason: 'probe' })

  fs.writeFileSync(
    path.join(root, 'docs', 'module-domain.json'),
    JSON.stringify({ modules, aspects: slices, roles, unmanaged }),
    'utf8'
  )

  const framework = await snapshots.projectFrameworkState(root, { files: 7, modules: 2, missingSemantics: 1, plans: 0 })
  assertFrameworkShape(framework)
  assert.equal(framework.degraded, false)

  assert.equal(framework.modules.length, 200, 'modules are capped at 200')
  assert.equal(framework.modulesTruncated, true)
  const big = framework.modules.find((module) => module.name === 'big-module')
  assert.ok(big !== undefined, 'the alphabetically-first modules survive the cap')
  assert.equal(big.sections.length, 100, 'sections are capped per module')
  assert.equal(big.sectionsTruncated, true)
  assert.equal(big.sections[0].key, 'lib/a.mjs')
  assert.equal(big.sections[0].members.length, 50, 'section members are capped')
  assert.equal(big.sections[0].membersTruncated, true)

  assert.equal(framework.slices.length, 200, 'slices are capped at 200')
  assert.equal(framework.slicesTruncated, true, 'the slice cut must be flagged, never silent')
  assert.equal(framework.slices[0].id, 's000', 'the alphabetically-first slice survives the cap')
  assert.equal(framework.slices[0].files.length, 200, 'one slice keeps at most 200 declared files')
  assert.equal(framework.slices[0].filesTruncated, true)
  assert.equal(framework.slices[0].missingFiles.length, 200, 'missingFiles is bounded by the same cap')
  assert.equal(framework.slices[0].missingFilesTruncated, true)
  assert.equal(framework.slices[0].files[0].path, 'docs/UNOWNED.md')
  assert.equal(framework.slices[0].files[0].moduleName, null, 'a file no module owns must report moduleName:null')
  assert.equal(framework.slices[0].files[1].path, 'README.md')
  assert.equal(framework.slices[0].files[1].exists, true, 'existence is checked against the requested root')

  assert.equal(framework.roles.length, 200, 'roles are capped at 200')
  assert.equal(framework.rolesTruncated, true)
  assert.deepEqual(framework.roles[0].modules, ['big-module'])
  assert.ok(framework.warnings.includes('role-module-dangling: r000 -> ghost-module'))

  assert.equal(framework.unmanaged.length, 200, 'the unmanaged list keeps at most 200 rows')
  assert.equal(framework.unmanagedTruncated, true)
  // summary 计的是真实总数，不是截断后的行数。
  assert.equal(framework.summary.graphModules, 201)
  assert.equal(framework.summary.graphSlices, 201, 'graph counters report the real map total, not the capped rows')
  assert.equal(framework.summary.graphRoles, 201)
  assert.equal(framework.summary.graphUnmanaged, 250)
  assert.equal(framework.summary.files, 7)
  assert.equal(framework.summary.describedModules, 2)
  assert.equal(framework.summary.missingSemantics, 1)
  assert.equal(framework.summary.plans, 0)
})

// -------------------------------- framework 结构投影：模块图缺失 / 解析失败降级
test('framework 结构投影：模块图缺失或解析失败时 degraded=true 且只回 summary', async () => {
  const counts = { files: 9, modules: 3, missingSemantics: 2, plans: 1 }
  const missingRoot = tempDir('framework-degraded-missing')
  const brokenRoot = tempDir('framework-degraded-broken')
  fs.mkdirSync(path.join(brokenRoot, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(brokenRoot, 'docs', 'module-domain.json'), '{ not json', 'utf8')
  for (const root of [missingRoot, brokenRoot]) {
    const framework = await snapshots.projectFrameworkState(root, counts)
    assertFrameworkShape(framework)
    assert.equal(framework.degraded, true)
    assert.deepEqual(Object.keys(framework).sort(), ['degraded', 'summary'], 'a degraded section never falls back to another project map')
    assert.equal(framework.summary.files, 9, 'the description counters survive a broken map')
    assert.equal(framework.summary.describedModules, 3)
    assert.equal(framework.summary.missingSemantics, 2)
    assert.equal(framework.summary.plans, 1)
    for (const key of ['graphModules', 'graphSlices', 'graphRoles', 'graphUnmanaged']) {
      assert.equal(framework.summary[key], null, 'an unreadable map must report ' + key + ' as null (not a fake 0)')
    }
  }
})


// -------------------------------------------------- 降级 ②：core 形状坏掉
test('降级（core.mjs 可加载但形状坏）：读 store 失败也降级为同形状空 payload 并给原因', async () => {
  const reference = await healthyPayload()
  const { lib, copy, project } = stageSnapshotCopy('malformed')
  fs.writeFileSync(path.join(lib, 'core.mjs'), 'export const loadContract = 42\n', 'utf8')

  const probe = runProbe(copy, project)

  // 可加载的坏 core 不算"缺失"，走的是 buildStoreState 的读失败兜底。
  assert.equal(probe.coreAvailable, true, 'a loadable but malformed core.mjs must not be treated as missing')
  assertPayloadShape(probe.payload, project, reference)
  assert.ok(
    probe.payload.warnings.some((line) => typeof line === 'string' && line.startsWith('store contract unreadable: ')),
    `expected a readable store-contract failure, got warnings: ${JSON.stringify(probe.payload.warnings)}`
  )
})
