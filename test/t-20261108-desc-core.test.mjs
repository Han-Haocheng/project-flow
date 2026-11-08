// T-20261108 · D3：描述台账接入 core 的存储层守护（契约 + build/set/plan/apply + check）。
//
// 被测对象是 `lib/core.mjs` 的 description 区：它把 `lib/desc.mjs` 算出的记录
// **在锁内写盘**，并把 §6 的检查接到 CLI/阶段门。这里每个用例都先断言正例
// （记录真的建出来了、检查真的过了），再断言否定（该报的 kind 真的报了）——
// 一个「永远返回空数组」的实现能让所有拒绝路径看起来都「通过」。
//
// 覆盖的坑（题面 A–D）：
//   - `defaultContract`/`contractShapes` 必须同时加 description 节，否则
//     `storePaths` 每次 normalize 都 `TypeError`（整条 CLI 全挂）；
//   - `string[]` 是**整条校验**：一半合法一半违规也回退默认，不做部分接收；
//   - `storePaths` 走 `resolveDir` containment + custom `store.root` 跟随；
//   - build 保留 `project.semantics`、无变化零写盘、`--dry-run` 零写盘、剪枝；
//   - `set` 的成员是整体替换、记录必须已存在、未知成员 invalid；
//   - `plan` 的 xor 校验 / 阶段窗口 / apply 后冻结 / git 脏工作树拒绝；
//   - `apply` 幂等（首次 `implemented_at` 不变）、`--dry-run` 零写盘；
//   - `check` 的 enforce 三态、`enabled:false`、strict 升级与每个 kind。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DESCRIPTION_ENFORCE_MODES,
  DESCRIPTION_SCHEMA,
  FlowError,
  addTask,
  applyDescriptionPlan,
  buildDescription,
  checkDescription,
  descriptionStatus,
  drainWarnings,
  getDescriptionFile,
  getDescriptionPlan,
  initProject,
  listDescriptionFiles,
  loadContract,
  readDescriptionProject,
  renderDescription,
  saveContract,
  setDescriptionFile,
  setDescriptionPlan,
  setDescriptionProject,
  storePaths,
  updateTask,
} from '../lib/core.mjs'
import { encodePath } from '../lib/desc.mjs'

// spec §1 的默认 include/exclude（契约回退必须逐字回到这里）。
const DEFAULT_INCLUDE = ['**/*.mjs', '**/*.js', '**/*.cjs', '**/*.ts', '**/*.tsx', '**/*.jsx', '**/*.py']
const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '.dsh/**',
  'test/**',
  '**/*.test.mjs',
  '**/*.spec.mjs',
  '.selftest/**',
  '.agents/**',
  'docs/**',
]

/** ≥ minSemanticsChars（10）且不会因为空白折叠掉长度。 */
const SEMANTICS = '这一段语义说明足够长并且描述真实职责。'
const PROJECT_SEMANTICS = '项目语义：描述台账的存储层与漂移检查。'
const LATER_SEMANTICS = '这一段更新后的语义说明也足够长。'
const NOW = '2026-11-08T10:00:00+08:00'
const LATER = '2026-11-08T12:00:00+08:00'
const EARLIER = '2026-11-08T09:00:00+08:00'

const TEMP_ROOTS = []
after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

// ------------------------------------------------------------------ helpers

function tempRoot(label = 'desc-core') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `project-flow-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function writeFile(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  return absolute
}

/** 一次性工程：`flow init`（不种门禁）+ 写入给定的源文件。 */
function projectWith(label, files = {}) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true })
  for (const [relative, content] of Object.entries(files)) writeFile(root, relative, content)
  return { root, contract: loadContract(root).contract }
}

function reload(root) {
  return loadContract(root).contract
}

function descDir(root) {
  return path.join(root, '.agents', 'description')
}

function recordFile(root, sourcePath) {
  return path.join(descDir(root), 'files', `${encodePath(sourcePath)}.json`)
}

function readRecord(root, sourcePath) {
  return JSON.parse(fs.readFileSync(recordFile(root, sourcePath), 'utf8'))
}

function writeRecord(root, sourcePath, record) {
  fs.mkdirSync(path.dirname(recordFile(root, sourcePath)), { recursive: true })
  fs.writeFileSync(recordFile(root, sourcePath), `${JSON.stringify(record, null, 2)}\n`)
}

function mutateRecord(root, sourcePath, mutate) {
  const record = readRecord(root, sourcePath)
  mutate(record)
  writeRecord(root, sourcePath, record)
  return record
}

function projectFile(root) {
  return path.join(descDir(root), 'project.json')
}

function setProjectSemantics(root, text = PROJECT_SEMANTICS) {
  const project = JSON.parse(fs.readFileSync(projectFile(root), 'utf8'))
  project.semantics = text
  fs.writeFileSync(projectFile(root), `${JSON.stringify(project, null, 2)}\n`)
}

function writeFlowJson(root, value) {
  writeFile(root, '.agents/flow/flow.json', `${JSON.stringify(value, null, 2)}\n`)
}

/** 目录树快照（相对路径 + 大小 + mtime），用来证明「零写盘」。 */
function snapshotTree(dir) {
  const out = []
  const walk = (absolute, prefix) => {
    let entries
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const child = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const childAbsolute = path.join(absolute, entry.name)
      if (entry.isDirectory()) {
        out.push(`${child}/`)
        walk(childAbsolute, child)
        continue
      }
      const stat = fs.statSync(childAbsolute)
      out.push(`${child}:${stat.size}:${stat.mtimeMs}`)
    }
  }
  walk(dir, '')
  return out
}

function expectFlowError(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FlowError, `应抛 FlowError，实际 ${error?.name}: ${error?.message}`)
    assert.equal(error.code, code, `错误码应为 ${code}，实际 ${error.code}：${error.message}`)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

/** 给每条记录补文件 + 模块语义（check 全绿的前置）。 */
function describeAll(root, contract) {
  const patches = []
  for (const record of listDescriptionFiles(root, contract)) {
    patches.push({
      path: record.path,
      semantics: `文件语义：${record.path} 在工程中的职责说明。`,
      modules: (Array.isArray(record.modules) ? record.modules : []).map((module) => ({
        id: module.id,
        semantics: `模块语义：${module.id} 的职责说明。`,
      })),
    })
  }
  if (patches.length > 0) setDescriptionFile(root, contract, patches)
  setProjectSemantics(root)
}

function failedKinds(result) {
  return [...new Set(result.failed.map((item) => item.kind))].sort()
}

function warningKinds(result) {
  return [...new Set(result.warnings.map((item) => item.kind))].sort()
}

// ------------------------------------------------------------------- git

function hasGit() {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' })
  return probe.status === 0
}

function gitRun(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'flow',
      GIT_AUTHOR_EMAIL: 'flow@example.com',
      GIT_COMMITTER_NAME: 'flow',
      GIT_COMMITTER_EMAIL: 'flow@example.com',
    },
  })
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败：${result.stderr}`)
  return String(result.stdout ?? '').trim()
}

function gitProject(label, files) {
  const root = tempRoot(label)
  gitRun(root, ['init', '-q'])
  gitRun(root, ['config', 'user.name', 'flow'])
  gitRun(root, ['config', 'user.email', 'flow@example.com'])
  for (const [relative, content] of Object.entries(files)) writeFile(root, relative, content)
  gitRun(root, ['add', '-A'])
  gitRun(root, ['commit', '-qm', 'init'])
  return root
}

// ================================================================== 契约

test('契约：description 节十一个成员齐备，include/exclude 是数组、enforce=auto、testGate=tests', () => {
  const root = tempRoot('contract-defaults')
  initProject(root, { name: 'contract', noGates: true })
  const { contract, warnings } = loadContract(root)
  assert.deepEqual(warnings, [])
  assert.deepEqual(
    Object.keys(contract.description).sort(),
    [
      'dir',
      'enabled',
      'enforce',
      'testGate',
      'include',
      'exclude',
      'render',
      'minSemanticsChars',
      'maxFiles',
      'maxScanBytes',
      'gitCheck',
    ].sort()
  )
  assert.equal(contract.description.dir, '.agents/description')
  assert.equal(contract.description.enabled, true)
  assert.equal(contract.description.enforce, 'auto')
  assert.equal(contract.description.testGate, 'tests')
  assert.deepEqual(contract.description.include, DEFAULT_INCLUDE)
  assert.deepEqual(contract.description.exclude, DEFAULT_EXCLUDE)
  assert.equal(contract.description.render, '')
  assert.equal(contract.description.minSemanticsChars, 10)
  assert.equal(contract.description.maxFiles, 2000)
  assert.equal(contract.description.maxScanBytes, 1048576)
  assert.equal(contract.description.gitCheck, true)
  // 落盘的就是这十一个成员（不是只在内存里补的）。
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.agents/flow/flow.json'), 'utf8'))
  assert.deepEqual(onDisk.description, contract.description)
  assert.deepEqual(DESCRIPTION_ENFORCE_MODES, ['auto', 'on', 'off'])
  assert.equal(DESCRIPTION_SCHEMA, 1)
})

test('契约错型：description.include 写成字符串 → 整条回退默认数组并记 manifest-invalid', () => {
  const root = tempRoot('contract-include-string')
  initProject(root, { name: 'contract', noGates: true })
  writeFlowJson(root, { schema: 2, name: 'contract', description: { include: '**/*.mjs' } })
  const { contract, warnings } = loadContract(root)
  assert.ok(
    warnings.includes('manifest-invalid: description.include: expected string[], got string'),
    warnings.join('\n')
  )
  // 回退到**默认数组**，不是 `[]` —— 空范围会让所有检查变成假绿。
  assert.deepEqual(contract.description.include, DEFAULT_INCLUDE)
})

test('契约错型：include 数组里混一个数字 → 整条回退（不做部分接收）', () => {
  const root = tempRoot('contract-include-mixed')
  initProject(root, { name: 'contract', noGates: true })
  writeFlowJson(root, { schema: 2, name: 'contract', description: { include: ['**/*.mjs', 7] } })
  const { contract, warnings } = loadContract(root)
  assert.ok(
    warnings.includes('manifest-invalid: description.include: expected string[], got array'),
    warnings.join('\n')
  )
  assert.deepEqual(contract.description.include, DEFAULT_INCLUDE)
  // 另一半合法也不能被单独留下。
  assert.ok(!contract.description.include.includes(7))
})

test('契约：exclude 错型同样回退；空数组是合法的 string[]（不触发 manifest-invalid）', () => {
  const root = tempRoot('contract-exclude')
  initProject(root, { name: 'contract', noGates: true })
  writeFlowJson(root, { schema: 2, name: 'contract', description: { exclude: {} } })
  const first = loadContract(root)
  assert.ok(
    first.warnings.includes('manifest-invalid: description.exclude: expected string[], got object'),
    first.warnings.join('\n')
  )
  assert.deepEqual(first.contract.description.exclude, DEFAULT_EXCLUDE)

  writeFlowJson(root, { schema: 2, name: 'contract', description: { include: [] } })
  const second = loadContract(root)
  assert.deepEqual(second.warnings, [])
  assert.deepEqual(second.contract.description.include, [])
})

test('契约缺节：flow.json 没有 description → 静默补默认，warnings 为空', () => {
  const root = tempRoot('contract-missing-section')
  initProject(root, { name: 'contract', noGates: true })
  writeFlowJson(root, { schema: 2, name: 'contract', tasks: { dir: '.agents/tasks' } })
  const { contract, warnings } = loadContract(root)
  assert.deepEqual(warnings, [], '缺节是正常的部分清单，不该报警')
  assert.deepEqual(contract.description.include, DEFAULT_INCLUDE)
  assert.equal(contract.description.enforce, 'auto')
})

test('storePaths：description 默认落在 .agents/description，custom store.root 不改变它', () => {
  const root = tempRoot('store-paths')
  initProject(root, { name: 'paths', noGates: true })
  const contract = reload(root)
  assert.equal(storePaths(root, contract).description, path.join(root, '.agents/description'))

  // 自定义 store 根：只改 store 自身；记录目录按契约显式路径（.agents/）不跟随。
  fs.mkdirSync(path.join(root, '.flowstore'), { recursive: true })
  const customStore = { ...contract, store: { root: '.flowstore' } }
  assert.equal(storePaths(root, customStore).description, path.join(root, '.agents/description'))

  // 自定义 dir：直接采用（仍走 containment）。
  const customDir = { ...contract, description: { ...contract.description, dir: '.meta/desc' } }
  fs.mkdirSync(path.join(root, '.meta'), { recursive: true })
  assert.equal(storePaths(root, customDir).description, path.join(root, '.meta/desc'))
})

test('storePaths containment：description.dir 逃出根 → 回退默认 + manifest-path-rejected', () => {
  const root = tempRoot('store-containment')
  initProject(root, { name: 'paths', noGates: true })
  const contract = reload(root)
  drainWarnings()
  const escaped = storePaths(root, { ...contract, description: { ...contract.description, dir: '../outside' } })
  assert.equal(escaped.description, path.join(root, '.agents/description'))
  assert.match(drainWarnings().join('\n'), /manifest-path-rejected: description\.dir/)
})

test('storePaths containment：符号链接逃逸同样回退默认', (t) => {
  const root = tempRoot('store-symlink')
  const outside = tempRoot('store-symlink-outside')
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'dir')
  } catch {
    t.skip('当前平台不允许创建目录符号链接')
    return
  }
  initProject(root, { name: 'paths', noGates: true })
  const contract = reload(root)
  drainWarnings()
  const escaped = storePaths(root, { ...contract, description: { ...contract.description, dir: 'escape' } })
  assert.equal(escaped.description, path.join(root, '.agents/description'))
  assert.match(drainWarnings().join('\n'), /manifest-path-rejected: description\.dir/)
})

test('initProject：description 目录被创建，且不进 created 清单、warnings 仍为空', () => {
  const root = tempRoot('init-dirs')
  const result = initProject(root, { name: 'init', noGates: true })
  assert.deepEqual(result.created, ['.agents/flow/flow.json'])
  assert.deepEqual(result.warnings, [])
  assert.ok(fs.statSync(descDir(root)).isDirectory(), 'description 目录必须建出来')
})

// ============================================================ 读路径 / status

test('setDescriptionFile/getDescriptionFile/listDescriptionFiles：落盘、not-found、按 path 排序', () => {
  const { root, contract } = projectWith('set-get', {
    'lib/b.mjs': 'export function beta() {}\n',
    'lib/a.mjs': 'export function alpha() {}\n',
  })
  buildDescription(root, contract)
  assert.deepEqual(listDescriptionFiles(root, contract).map((record) => record.path), ['lib/a.mjs', 'lib/b.mjs'])

  const result = setDescriptionFile(root, contract, [
    { path: 'lib/b.mjs', semantics: SEMANTICS },
    { path: 'lib/a.mjs', semantics: SEMANTICS },
  ])
  assert.equal(result.changed, true)
  assert.deepEqual(result.records.map((record) => record.path), ['lib/b.mjs', 'lib/a.mjs'], '保持补丁顺序')

  const record = getDescriptionFile(root, contract, 'lib/a.mjs')
  assert.equal(record.path, 'lib/a.mjs')
  assert.equal(record.semantics, SEMANTICS)
  // 文件按 spec §3 的编码落盘（可逆、单段安全）。
  assert.ok(fs.existsSync(recordFile(root, 'lib/a.mjs')), '记录文件名必须是 encodePath')
  assert.ok(!fs.existsSync(path.join(descDir(root), 'files', 'lib', 'a.mjs.json')), '目录结构不得镜像源码树')

  expectFlowError(() => getDescriptionFile(root, contract, 'lib/nope.mjs'), 'not-found', /lib\/nope\.mjs/)
  expectFlowError(() => getDescriptionFile(root, contract, '../escape.mjs'), 'invalid')
  assert.equal(getDescriptionPlan(root, contract, 'T-20260101000000'), null)
})

test('descriptionStatus：计数口径（待填单元）与 plans 数量', () => {
  const { root, contract } = projectWith('status-counts', {
    'lib/a.mjs': 'export function alpha() {}\n',
    'lib/b.mjs': 'export function beta() {}\n',
    'lib/c.mjs': 'export function gamma() {}\n',
  })
  // 还没建描述：全 0，不抛。
  assert.deepEqual(descriptionStatus(root, contract), {
    files: 0,
    modules: 0,
    missingSemantics: 0,
    plans: 0,
    described: 0,
  })

  buildDescription(root, contract)
  // a 全填；b 一个字都没填（文件 + 模块）；c 只填文件语义（模块还缺）。
  // → described = 2（a、c 的文件语义达标），missingSemantics = b 的 2 + c 的 1 = 3。
  const a = readRecord(root, 'lib/a.mjs')
  setDescriptionFile(root, contract, [
    { path: 'lib/a.mjs', semantics: SEMANTICS, modules: a.modules.map((m) => ({ id: m.id, semantics: SEMANTICS })) },
    { path: 'lib/c.mjs', semantics: SEMANTICS },
  ])
  const status = descriptionStatus(root, contract)
  assert.equal(status.files, 3)
  assert.equal(status.modules, 3)
  assert.equal(status.described, 2, 'described 只数通过语义下限的文件')
  assert.equal(status.missingSemantics, 3, '缺文件语义 1 个（b）+ 缺模块语义 2 个（b、c）')
  assert.equal(status.plans, 0)

  const task = addTask(root, contract, { title: '计划计数', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, { files: [{ path: 'lib/a.mjs', op: 'change', semantics: LATER_SEMANTICS }] })
  assert.equal(descriptionStatus(root, contract).plans, 1)
})

test('renderDescription：无记录返回 null；有记录时确定性（两次逐字相同、无墙钟时间）', () => {
  const { root, contract } = projectWith('render', {
    'lib/a.mjs': 'export function alpha() {}\n',
  })
  assert.equal(renderDescription(root, contract), null)

  buildDescription(root, contract, { now: NOW })
  describeAll(root, contract)
  const first = renderDescription(root, contract)
  assert.equal(typeof first, 'string')
  const second = renderDescription(root, contract)
  assert.equal(first, second, '渲染必须确定性')
  assert.match(first, /^# 项目描述：/m)
  assert.match(first, /## 1 项目语义/)
  assert.match(first, /### 3\.1 lib\/a\.mjs/)
  // 墙钟时间不进渲染：`generated_at` 每次 build 都变，写进去必然 stale。
  assert.ok(!first.includes(NOW), '不得把 build 时间写进渲染')
})

// ==================================================================== build

test('buildDescription：新建 / 保留 project.semantics / 无变化零写盘', () => {
  const { root, contract } = projectWith('build-basic', {
    'lib/a.mjs': '// ---- 契约\nexport function alpha() {}\n',
    'lib/b.mjs': "import { alpha } from './a.mjs'\nexport function beta() { return alpha() }\n",
  })
  const first = buildDescription(root, contract, { now: NOW })
  assert.deepEqual(first, { created: 2, updated: 0, unchanged: 0, pruned: 0, warnings: [] })
  assert.equal(listDescriptionFiles(root, contract).length, 2)

  const project = readDescriptionProject(root, contract)
  assert.equal(project.schema, DESCRIPTION_SCHEMA)
  assert.equal(project.counts.files, 2)
  assert.equal(project.counts.modules, 2)
  assert.ok(typeof project.revision === 'string' && project.revision.startsWith('sha256:'))
  assert.equal(project.generated_at, NOW)

  // 语义是手写的：build 只保留，不许清空。
  setProjectSemantics(root)
  const before = snapshotTree(descDir(root))
  const second = buildDescription(root, contract, { now: LATER })
  assert.deepEqual(second, { created: 0, updated: 0, unchanged: 2, pruned: 0, warnings: [] })
  assert.equal(readDescriptionProject(root, contract).semantics, PROJECT_SEMANTICS)
  assert.deepEqual(snapshotTree(descDir(root)), before, '无变化必须零写盘（含 project.json）')
})

test('buildDescription：更新结构但保留 semantics/modules；源文件删除 → 剪枝', () => {
  const { root, contract } = projectWith('build-prune', {
    'lib/a.mjs': 'export function alpha() {}\n',
    'lib/gone.mjs': 'export function gone() {}\n',
  })
  buildDescription(root, contract, { now: NOW })
  const record = readRecord(root, 'lib/a.mjs')
  setDescriptionFile(root, contract, [
    { path: 'lib/a.mjs', semantics: SEMANTICS, modules: [{ id: record.modules[0].id, semantics: SEMANTICS, members: ['alpha'] }] },
  ])
  const withSemantics = getDescriptionFile(root, contract, 'lib/a.mjs')
  assert.equal(withSemantics.semantics, SEMANTICS)

  // 改代码但不改语义 → build 只同步结构。
  writeFile(root, 'lib/a.mjs', 'export function alpha() {}\nexport function alpha2() {}\n')
  const updated = buildDescription(root, contract, { now: LATER })
  assert.equal(updated.updated, 1)
  assert.equal(updated.created, 0)
  const afterUpdate = getDescriptionFile(root, contract, 'lib/a.mjs')
  assert.equal(afterUpdate.semantics, SEMANTICS, 'build 必须保留已填的文件语义')
  assert.notEqual(afterUpdate.hash, withSemantics.hash)

  // 删源文件 → 记录被剪枝。
  fs.rmSync(path.join(root, 'lib', 'gone.mjs'))
  const pruned = buildDescription(root, contract, { now: LATER })
  assert.equal(pruned.pruned, 1)
  assert.deepEqual(listDescriptionFiles(root, contract).map((item) => item.path), ['lib/a.mjs'])
  assert.ok(!fs.existsSync(recordFile(root, 'lib/gone.mjs')))
})

test('buildDescription：dryRun 零写盘，但仍报告将要建几条记录', () => {
  const { root, contract } = projectWith('build-dry', { 'lib/a.mjs': 'export function alpha() {}\n' })
  const before = snapshotTree(descDir(root))
  const preview = buildDescription(root, contract, { dryRun: true, now: NOW })
  assert.equal(preview.created, 1)
  assert.equal(preview.updated, 0)
  assert.deepEqual(snapshotTree(descDir(root)), before, 'dryRun 一次盘都不能写')
  assert.equal(readDescriptionProject(root, contract), null)
  assert.equal(listDescriptionFiles(root, contract).length, 0)

  // 有记录之后 dryRun 同样零写盘。
  buildDescription(root, contract, { now: NOW })
  const withRecords = snapshotTree(descDir(root))
  writeFile(root, 'lib/b.mjs', 'export function beta() {}\n')
  const preview2 = buildDescription(root, contract, { dryRun: true, now: LATER })
  assert.equal(preview2.created, 1)
  assert.deepEqual(snapshotTree(descDir(root)), withRecords, 'dryRun 不得写新记录，也不得刷新 project.json')
})

// ====================================================================== set

test('setDescriptionFile：模块成员整体替换；未知成员 invalid；记录不存在 invalid', () => {
  const { root, contract } = projectWith('set-members', {
    'lib/a.mjs': 'export function alpha() {}\nexport function beta() {}\n',
  })
  buildDescription(root, contract)
  const moduleId = getDescriptionFile(root, contract, 'lib/a.mjs').modules[0].id
  assert.deepEqual(getDescriptionFile(root, contract, 'lib/a.mjs').modules[0].members, ['alpha', 'beta'])

  // 整体替换：给一个成员就是只剩一个（不是增量）。
  setDescriptionFile(root, contract, [
    { path: 'lib/a.mjs', semantics: SEMANTICS, modules: [{ id: moduleId, semantics: SEMANTICS, members: ['alpha'] }] },
  ])
  assert.deepEqual(getDescriptionFile(root, contract, 'lib/a.mjs').modules[0].members, ['alpha'])

  // 未知成员：扫描声明里没有 → invalid（不能凭空写。
  expectFlowError(
    () => setDescriptionFile(root, contract, [{ path: 'lib/a.mjs', modules: [{ id: moduleId, members: ['nope'] }] }]),
    'invalid',
    /成员不在扫描声明中：nope/
  )

  // 记录必须已存在：build 之后新加的文件没有记录。
  writeFile(root, 'lib/late.mjs', 'export function late() {}\n')
  expectFlowError(
    () => setDescriptionFile(root, contract, [{ path: 'lib/late.mjs', semantics: SEMANTICS }]),
    'invalid',
    /记录不存在.*flow desc build/
  )

  // 空数组是 no-op（不是错误）。
  const empty = setDescriptionFile(root, contract, [])
  assert.deepEqual(empty, { records: [], changed: false })
})

test('setDescriptionFile：更新 project 计数缓存与 revision', () => {
  const { root, contract } = projectWith('set-counts', {
    'lib/a.mjs': 'export function alpha() {}\n',
    'lib/b.mjs': 'export function beta() {}\n',
  })
  buildDescription(root, contract, { now: NOW })
  const before = readDescriptionProject(root, contract)
  const moduleId = getDescriptionFile(root, contract, 'lib/a.mjs').modules[0].id
  setDescriptionFile(root, contract, [
    { path: 'lib/a.mjs', semantics: SEMANTICS, modules: [{ id: moduleId, semantics: SEMANTICS }] },
  ])
  const after = readDescriptionProject(root, contract)
  assert.equal(after.counts.files, 2)
  assert.equal(after.counts.described, 1)
  assert.equal(after.counts.missingSemantics, 2, '缺文件语义 b（1）+ 缺模块语义 b（1）')
  assert.notEqual(after.revision, before.revision, '说出的话变了，revision 必须变')
})

test('setDescriptionProject：project.json 必须先由 build 建立；语义必须是非空字符串', () => {
  const { root, contract } = projectWith('set-project-missing', { 'lib/a.mjs': 'export function alpha() {}\n' })

  // 台账还没 build：set 不替 build 建 project.json（与 setDescriptionFile 同一条纪律）。
  expectFlowError(
    () => setDescriptionProject(root, contract, { semantics: PROJECT_SEMANTICS }),
    'invalid',
    /flow desc build/
  )

  assert.equal(buildDescription(root, contract).created, 1)
  for (const semantics of ['', '   \n  ', 42, null]) {
    expectFlowError(
      () => setDescriptionProject(root, contract, { semantics }),
      'invalid',
      /不能为空/
    )
  }
})

test('setDescriptionProject：只写 semantics+updated_at，其它字段（含未知字段）原样保留', () => {
  const { root, contract } = projectWith('set-project-write', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescription(root, contract, { now: NOW })
  const before = readDescriptionProject(root, contract)

  // 未知字段也要留下：set 是「改一个字段」，不是重建 project.json。
  const onDisk = JSON.parse(fs.readFileSync(projectFile(root), 'utf8'))
  onDisk.extra = { keep: true }
  fs.writeFileSync(projectFile(root), `${JSON.stringify(onDisk, null, 2)}\n`)

  const next = setDescriptionProject(root, contract, { semantics: `  ${PROJECT_SEMANTICS}  `, now: LATER })
  assert.equal(next.semantics, PROJECT_SEMANTICS, '语义要 trim 后落盘')
  assert.equal(next.updated_at, LATER, 'updated_at 必须重算')
  assert.equal(next.generated_at, before.generated_at, 'generated_at 是 build 的事实，不改')
  assert.equal(next.revision, before.revision, '语义不是记录内容，revision 不动')
  assert.equal(next.name, before.name)
  assert.deepEqual(next.counts, before.counts)
  assert.deepEqual(next.extra, { keep: true })
  assert.deepEqual(readDescriptionProject(root, contract), next, '返回值必须与盘上一致')
})

// ====================================================================== plan

test('setDescriptionPlan：files 与 noSemanticChange 的 xor 校验', () => {
  const { root, contract } = projectWith('plan-xor', { 'lib/a.mjs': 'export function alpha() {}\n' })
  const task = addTask(root, contract, { title: '计划形状', type: 'feat', stage: 'analyzing' })

  expectFlowError(() => setDescriptionPlan(root, contract, task.id, {}), 'invalid', /必须给出 files/)
  expectFlowError(
    () => setDescriptionPlan(root, contract, task.id, { noSemanticChange: true }),
    'invalid',
    /必须给出非空 reason/
  )
  expectFlowError(
    () => setDescriptionPlan(root, contract, task.id, { noSemanticChange: true, reason: '只改文档', files: [{ path: 'lib/a.mjs', op: 'change' }] }),
    'invalid',
    /不能同时给出/
  )

  const noChange = setDescriptionPlan(root, contract, task.id, { noSemanticChange: true, reason: '只改注释' })
  assert.equal(noChange.plan.noSemanticChange, true)
  assert.equal(noChange.plan.reason, '只改注释')
  assert.deepEqual(noChange.plan.files, [])
  assert.equal(noChange.amended, false)

  const withFiles = setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: LATER_SEMANTICS }],
  })
  assert.equal(withFiles.amended, true, '已有计划再写一次 = 修订')
  assert.equal(withFiles.plan.history.length, 2, '每次修订追加一条 history')
  assert.equal(withFiles.plan.noSemanticChange, false, '切回 files 时旧标记要被清掉')
})

test('setDescriptionPlan：阶段窗口（queued-analysis/analyzing/implementing 之外拒绝）', () => {
  const { root, contract } = projectWith('plan-stage', { 'lib/a.mjs': 'export function alpha() {}\n' })
  const task = addTask(root, contract, { title: '阶段窗口', type: 'feat' })
  const body = { files: [{ path: 'lib/a.mjs', op: 'change', semantics: LATER_SEMANTICS }] }

  // created：太早。
  expectFlowError(() => setDescriptionPlan(root, contract, task.id, body), 'invalid', /只允许 queued-analysis \/ analyzing \/ implementing/)

  for (const stage of ['queued-analysis', 'analyzing', 'implementing']) {
    updateTask(root, contract, task.id, { stage })
    const result = setDescriptionPlan(root, contract, task.id, body)
    assert.equal(result.plan.task, task.id)
    assert.equal(result.plan.status, 'planned')
  }

  // done：太晚。
  updateTask(root, contract, task.id, { stage: 'queued-review' })
  updateTask(root, contract, task.id, { stage: 'reviewing' })
  updateTask(root, contract, task.id, { stage: 'done' })
  expectFlowError(() => setDescriptionPlan(root, contract, task.id, body), 'invalid', /只允许/)
})

test('setDescriptionPlan：apply 之后冻结（implemented 不许再改）', () => {
  const { root, contract } = projectWith('plan-freeze', { 'lib/a.mjs': 'export function alpha() {}\n' })
  assert.equal(buildDescription(root, contract).created, 1)
  describeAll(root, contract)
  const task = addTask(root, contract, { title: '冻结', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, { files: [{ path: 'lib/a.mjs', op: 'change', semantics: LATER_SEMANTICS }] })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })
  applyDescriptionPlan(root, contract, task.id)

  expectFlowError(
    () => setDescriptionPlan(root, contract, task.id, { files: [{ path: 'lib/a.mjs', op: 'change', semantics: SEMANTICS }] }),
    'invalid',
    /已 implemented/
  )
})

test('setDescriptionPlan：implemented 计划 --rebase 只刷新 base（语义/状态/implemented_at 不变）', (t) => {
  if (!hasGit()) {
    t.skip('未安装 git')
    return
  }
  const root = gitProject('plan-rebase', { 'lib/a.mjs': 'export function alpha() {}\n' })
  initProject(root, { name: 'rebase', noGates: true })
  const contract = reload(root)
  buildDescription(root, contract)
  describeAll(root, contract)
  const task = addTask(root, contract, { title: 'rebase', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: LATER_SEMANTICS }],
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })
  const applied = applyDescriptionPlan(root, contract, task.id)
  const frozen = getDescriptionPlan(root, contract, task.id)
  assert.equal(applied.plan.status, 'implemented')

  // 冻结后再产生一个提交（不在描述 include 范围，记录不会因为提交而漂）。
  writeFile(root, 'docs/note.md', '# note\n')
  gitRun(root, ['add', '-A'])
  gitRun(root, ['commit', '-qm', 'next'])
  const head = gitRun(root, ['rev-parse', 'HEAD'])
  assert.notEqual(head, frozen.base.commit, '新提交必须让旧 base 过期')

  const rebased = setDescriptionPlan(root, contract, task.id, {}, { rebase: true })
  assert.equal(rebased.rebased, true)
  assert.equal(rebased.amended, true)
  assert.equal(rebased.plan.status, 'implemented', 'rebase 不得把状态打回 planned')
  assert.equal(rebased.plan.implemented_at, frozen.implemented_at, 'implemented_at 必须原样保留')
  assert.equal(rebased.plan.created_at, frozen.created_at)
  assert.deepEqual(rebased.plan.files, frozen.files, 'files 不得被重写')
  assert.equal(rebased.plan.noSemanticChange, frozen.noSemanticChange)
  assert.equal(rebased.plan.reason, frozen.reason)
  assert.equal(rebased.plan.base.commit, head)
  assert.equal(rebased.plan.base.clean, true)
  assert.equal(rebased.plan.history.length, frozen.history.length + 1)
  assert.match(rebased.plan.history.at(-1).note, /rebase/)
  assert.match(rebased.plan.history.at(-1).note, new RegExp(head.slice(0, 7)))
  // 只刷新比较基准：文件记录的语义仍是 apply 落下的那一版。
  assert.equal(getDescriptionFile(root, contract, 'lib/a.mjs').semantics, LATER_SEMANTICS)
  assert.equal(getDescriptionPlan(root, contract, task.id).base.commit, head)
})

test('setDescriptionPlan：implemented 计划 --rebase 仍要求描述范围干净；非 rebase 仍冻结', (t) => {
  if (!hasGit()) {
    t.skip('未安装 git')
    return
  }
  const root = gitProject('plan-rebase-dirty', { 'lib/a.mjs': 'export function alpha() {}\n' })
  initProject(root, { name: 'rebase-dirty', noGates: true })
  const contract = reload(root)
  buildDescription(root, contract)
  describeAll(root, contract)
  const task = addTask(root, contract, { title: 'rebase dirty', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: LATER_SEMANTICS }],
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })
  applyDescriptionPlan(root, contract, task.id)

  // 不带 rebase：冻结错误仍在，并给出 --rebase 出口。
  let frozen = null
  try {
    setDescriptionPlan(root, contract, task.id, { files: [{ path: 'lib/a.mjs', op: 'change' }] })
  } catch (error) {
    frozen = error
  }
  assert.ok(frozen instanceof FlowError, `应抛 FlowError，实际 ${frozen?.name}: ${frozen?.message}`)
  assert.equal(frozen.code, 'invalid')
  assert.match(frozen.message, /已 implemented/)
  assert.match(frozen.message, /--rebase/)

  // 描述范围脏 → --rebase 仍拒绝（base 不能记在一个不可归因的工作树上）。
  writeFile(root, 'lib/a.mjs', 'export function alpha() { return 1 }\n')
  expectFlowError(
    () => setDescriptionPlan(root, contract, task.id, {}, { rebase: true }),
    'invalid',
    /未提交改动.*lib\/a\.mjs/
  )
})

test('setDescriptionPlan：git 工作树脏 → 拒绝并提示先提交；干净时记 base.commit', (t) => {
  if (!hasGit()) {
    t.skip('未安装 git')
    return
  }
  const root = gitProject('plan-git', { 'lib/a.mjs': 'export function alpha() {}\n' })
  initProject(root, { name: 'git', noGates: true })
  const contract = reload(root)
  buildDescription(root, contract)
  const task = addTask(root, contract, { title: 'git base', type: 'feat', stage: 'analyzing' })
  const body = { files: [{ path: 'lib/a.mjs', op: 'change', semantics: LATER_SEMANTICS }] }

  const plan = setDescriptionPlan(root, contract, task.id, body)
  const head = gitRun(root, ['rev-parse', 'HEAD'])
  assert.equal(plan.plan.base.commit, head, 'base.commit 必须是当时的 HEAD')
  assert.equal(plan.plan.base.clean, true)

  // 另一个修好的计划分支：改一个描述范围内的文件 → 工作树脏 → 拒绝。
  writeFile(root, 'lib/a.mjs', 'export function alpha() { return 1 }\n')
  expectFlowError(
    () => setDescriptionPlan(root, contract, task.id, body),
    'invalid',
    /未提交改动.*lib\/a\.mjs/
  )
})

// ===================================================================== apply

test('applyDescriptionPlan：落语义、冻结计划、幂等（保留首次 implemented_at）', () => {
  const { root, contract } = projectWith('apply-idempotent', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescription(root, contract)
  describeAll(root, contract)
  const task = addTask(root, contract, { title: 'apply', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: 'apply 写进来的新语义足够长。' }],
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  // 计划尚未落地：这里 apply 还不行（阶段不对），先把阶段推到位。
  updateTask(root, contract, task.id, { stage: 'implementing' })

  const first = applyDescriptionPlan(root, contract, task.id, { now: NOW })
  assert.equal(first.applied, true)
  assert.equal(first.plan.status, 'implemented')
  assert.equal(first.plan.implemented_at, NOW)
  assert.equal(getDescriptionFile(root, contract, 'lib/a.mjs').semantics, 'apply 写进来的新语义足够长。')

  const second = applyDescriptionPlan(root, contract, task.id, { now: LATER })
  assert.equal(second.applied, false, '重复 apply 必须幂等')
  assert.equal(second.plan.implemented_at, NOW, 'implemented_at 保留首次时间')
  assert.equal(getDescriptionPlan(root, contract, task.id).updated_at, NOW, '幂等路径不写盘')
})

test('applyDescriptionPlan：stage 不是 implementing → invalid 提示回实现阶段', () => {
  const { root, contract } = projectWith('apply-stage', { 'lib/a.mjs': 'export function alpha() {}\n' })
  const task = addTask(root, contract, { title: 'apply 阶段', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, { files: [{ path: 'lib/a.mjs', op: 'change' }] })
  expectFlowError(() => applyDescriptionPlan(root, contract, task.id), 'invalid', /先把任务推进到 implementing|不能 apply/)
})

test('applyDescriptionPlan：计划里的成员不存在 → invalid', () => {
  const { root, contract } = projectWith('apply-member', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescription(root, contract)
  describeAll(root, contract)
  const task = addTask(root, contract, { title: 'apply 成员', type: 'feat', stage: 'analyzing' })
  const moduleId = getDescriptionFile(root, contract, 'lib/a.mjs').modules[0].id
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', modules: [{ id: moduleId, members: ['ghost'] }] }],
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })
  expectFlowError(() => applyDescriptionPlan(root, contract, task.id), 'invalid', /成员不在扫描声明中：ghost/)
  // 抛错时计划没有被冻结（记录先写、计划后冻结）。
  assert.equal(getDescriptionPlan(root, contract, task.id).status, 'planned')
})

test('applyDescriptionPlan：dryRun 零写盘（记录与计划都不变）', () => {
  const { root, contract } = projectWith('apply-dry', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescription(root, contract)
  describeAll(root, contract)
  const task = addTask(root, contract, { title: 'apply dry', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: 'dry-run 不该写进来的语义。' }],
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })
  const before = snapshotTree(descDir(root))
  const preview = applyDescriptionPlan(root, contract, task.id, { dryRun: true, now: NOW })
  assert.equal(preview.applied, true)
  assert.equal(preview.plan.status, 'implemented')
  assert.deepEqual(snapshotTree(descDir(root)), before, 'dryRun 一次盘都不能写')
  assert.equal(getDescriptionPlan(root, contract, task.id).status, 'planned')
  assert.notEqual(getDescriptionFile(root, contract, 'lib/a.mjs').semantics, 'dry-run 不该写进来的语义。')
})

test('applyDescriptionPlan：计划 op=remove 同时删掉记录文件', () => {
  const { root, contract } = projectWith('apply-remove', {
    'lib/a.mjs': 'export function alpha() {}\n',
    'lib/b.mjs': 'export function beta() {}\n',
  })
  buildDescription(root, contract)
  describeAll(root, contract)
  const task = addTask(root, contract, { title: 'apply 删除', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, { files: [{ path: 'lib/b.mjs', op: 'remove' }] })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })
  applyDescriptionPlan(root, contract, task.id)
  assert.deepEqual(listDescriptionFiles(root, contract).map((item) => item.path), ['lib/a.mjs'])
  assert.ok(!fs.existsSync(recordFile(root, 'lib/b.mjs')))
})

// ===================================================================== check

test('checkDescription：enforce=auto 且台账为空 → 跳过（ok + 说明性 warning）', () => {
  const { root, contract } = projectWith('check-skip-auto', { 'lib/a.mjs': 'export function alpha() {}\n' })
  const result = checkDescription(root, contract)
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'auto')
  assert.deepEqual(result.failed, [])
  assert.deepEqual(warningKinds(result), ['description-skipped'])
  assert.match(result.warnings[0].detail, /未建立描述，跳过/)
})

test('checkDescription：enforce=on 时台账为空也照常跑（undescribed 只 warn）；enforce=off 与 enabled=false 一律跳过', () => {
  const { root, contract } = projectWith('check-modes', { 'lib/a.mjs': 'export function alpha() {}\n' })
  const on = saveContract(root, { ...contract, description: { ...contract.description, enforce: 'on' } })
  const onResult = checkDescription(root, on)
  assert.equal(onResult.mode, 'on')
  assert.equal(onResult.ok, true, '空台账 + on 仍该是通过（只是不跳过）')
  assert.deepEqual(failedKinds(onResult), [])
  assert.deepEqual(warningKinds(onResult), ['undescribed-file'])

  const off = saveContract(root, { ...contract, description: { ...contract.description, enforce: 'off' } })
  const offResult = checkDescription(root, off)
  assert.equal(offResult.mode, 'off')

  const disabled = saveContract(root, { ...contract, description: { ...contract.description, enabled: false, enforce: 'on' } })
  const disabledResult = checkDescription(root, disabled)
  assert.equal(disabledResult.ok, true)
  assert.deepEqual(failedKinds(disabledResult), [])
  assert.deepEqual(warningKinds(disabledResult), ['description-disabled'])
})

test('checkDescription：未知 enforce 值降级 auto 并记 warning', () => {
  const { root, contract } = projectWith('check-enforce-typo', { 'lib/a.mjs': 'export function alpha() {}\n' })
  const typo = saveContract(root, { ...contract, description: { ...contract.description, enforce: 'loud' } })
  drainWarnings()
  const result = checkDescription(root, typo)
  assert.equal(result.mode, 'auto')
  assert.match(drainWarnings().join('\n'), /description-enforce-invalid: loud/)
})

test('checkDescription：strict 把 undescribed-file 从 warning 升级为 failed', () => {
  const { root, contract } = projectWith('check-strict', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescription(root, contract)
  describeAll(root, contract)
  // 已经全绿（含项目语义）。
  const clean = checkDescription(root, contract)
  assert.equal(clean.ok, true, JSON.stringify(clean.failed))
  assert.deepEqual(clean.failed, [])

  writeFile(root, 'lib/new.mjs', 'export function fresh() {}\n')
  const lenient = checkDescription(root, contract)
  assert.equal(lenient.ok, true, '非 strict 下「还没描述」不算失败')
  assert.deepEqual(failedKinds(lenient), [])
  assert.deepEqual(warningKinds(lenient), ['undescribed-file'])

  const strict = checkDescription(root, contract, { strict: true })
  assert.equal(strict.ok, false)
  assert.deepEqual(failedKinds(strict), ['undescribed-file'])
})

test('checkDescription：§6 的项目级 kind 全部接出来（warn/fail 分区正确）', () => {
  const { root, contract } = projectWith('check-kinds', {
    'lib/ok.mjs': 'export function alpha() {}\n',
    'lib/stale.mjs': 'export function beta() {}\n',
    'lib/ghost.mjs': "import { thing } from './nope.mjs'\nexport const value = thing\n",
    'lib/nomodules.mjs': 'export function delta() {}\n',
    'lib/unassigned.mjs': 'export function one() {}\nexport function two() {}\n',
    'lib/unknown.mjs': 'export function zeta() {}\n',
    'lib/dup.mjs': 'export function gamma() {}\nexport function omega() {}\n',
    'lib/empty.mjs': 'export function eps() {}\n',
    'lib/invalidedge.mjs': 'export function eta() {}\n',
    'lib/staleedge.mjs': 'export function main() { return helper() }\nexport function helper() {}\n',
    'lib/missingsem.mjs': 'export function theta() {}\n',
  })
  // 配一个渲染产物路径但不建文件 → render-stale。
  const configured = saveContract(root, {
    ...contract,
    description: { ...contract.description, render: 'DESC.md' },
  })
  buildDescription(root, configured)
  // 先给所有记录填语义（避免 missing-semantics 淹没其它 kind），再逐项注入脏数据。
  const patches = listDescriptionFiles(root, configured).map((record) => ({
    path: record.path,
    semantics: SEMANTICS,
    modules: record.modules.map((module) => ({ id: module.id, semantics: SEMANTICS })),
  }))
  setDescriptionFile(root, configured, patches)

  mutateRecord(root, 'lib/stale.mjs', (record) => {
    record.hash = 'sha256:deadbeef'
  })
  mutateRecord(root, 'lib/nomodules.mjs', (record) => {
    record.modules = []
  })
  mutateRecord(root, 'lib/unassigned.mjs', (record) => {
    record.modules[0].members = ['one']
  })
  mutateRecord(root, 'lib/unknown.mjs', (record) => {
    record.modules[0].members.push('ghostMember')
  })
  mutateRecord(root, 'lib/dup.mjs', (record) => {
    record.modules.push({ id: 'second', title: 'second', semantics: SEMANTICS, members: ['gamma'] })
  })
  mutateRecord(root, 'lib/empty.mjs', (record) => {
    record.modules[0].members = []
  })
  mutateRecord(root, 'lib/invalidedge.mjs', (record) => {
    record.moduleEdges = [{ from: record.modules[0].id, to: 'ghost-module', count: 1, why: [] }]
  })
  mutateRecord(root, 'lib/staleedge.mjs', (record) => {
    record.modules = [
      { id: 'runner', title: 'runner', semantics: SEMANTICS, members: ['main'] },
      { id: 'helper', title: 'helper', semantics: SEMANTICS, members: ['helper'] },
    ]
    record.moduleEdges = []
  })
  mutateRecord(root, 'lib/missingsem.mjs', (record) => {
    record.semantics = ''
  })
  // 新增一个源文件但不 build → undescribed-file（warn）。
  writeFile(root, 'lib/undescribed.mjs', 'export function iota() {}\n')
  // 项目语义留空 → 项目级 missing-semantics。
  const result = checkDescription(root, configured)

  const failed = failedKinds(result)
  for (const kind of [
    'stale-hash',
    'ghost-import',
    'modules-missing',
    'unassigned-member',
    'unknown-member',
    'duplicate-member',
    'empty-module',
    'missing-semantics',
    'invalid-edge',
    'stale-module-edges',
    'render-stale',
  ]) {
    assert.ok(failed.includes(kind), `failed 缺少 kind=${kind}：${failed.join(', ')}`)
  }
  assert.equal(result.ok, false)
  // undescribed-file 默认只进 warnings，不进 failed。
  const warnings = warningKinds(result)
  assert.ok(warnings.includes('undescribed-file'), warnings.join(', '))
  assert.ok(!failed.includes('undescribed-file'), '非 strict 下 undescribed-file 不得进 failed')
  // 分区不丢项：每条 failed 都有 level=fail，warnings 都是 warn。
  for (const item of result.failed) {
    assert.equal(item.level, 'fail')
    assert.ok(typeof item.hint === 'string' && item.hint !== '', `failed 项缺 hint：${item.kind}`)
  }
  for (const item of result.warnings) assert.equal(item.level, 'warn')
  assert.equal(result.counts.failed, result.failed.length)
  assert.equal(result.counts.warnings, result.warnings.length)
})

test('checkDescription：--task 的计划项（plan-missing / plan-unrealized / missing-record）', () => {
  const { root, contract } = projectWith('check-plan', {
    'lib/a.mjs': 'export function alpha() {}\n',
    'lib/removed.mjs': 'export function removed() {}\n',
  })
  buildDescription(root, contract)
  describeAll(root, contract)
  const task = addTask(root, contract, { title: '计划项', type: 'feat', stage: 'analyzing' })

  // 没有计划 → plan-missing。
  const missing = checkDescription(root, contract, { taskId: task.id })
  assert.ok(failedKinds(missing).includes('plan-missing'), failedKinds(missing).join(', '))

  // 计划要求新语义但还没 apply → plan-unrealized。
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: '计划里写着但还没落地的新语义。' }],
  })
  const unrealized = checkDescription(root, contract, { taskId: task.id })
  assert.ok(failedKinds(unrealized).includes('plan-unrealized'), failedKinds(unrealized).join(', '))

  // 计划里点名一个没有记录的文件 → missing-record。
  setDescriptionPlan(root, contract, task.id, {
    files: [
      { path: 'lib/a.mjs', op: 'change', semantics: '计划里写着但还没落地的新语义。' },
      { path: 'lib/ghost.mjs', op: 'add', semantics: '计划新增的文件语义说明。', modules: [{ id: 'ghost', semantics: '计划新增模块的语义说明。', members: ['ghostFunc'] }] },
    ],
  })
  const noRecord = checkDescription(root, contract, { taskId: task.id })
  assert.ok(failedKinds(noRecord).includes('missing-record'), failedKinds(noRecord).join(', '))

  // 任务不存在 → usage（传错 id 不能渲染成「检查通过」）。
  expectFlowError(() => checkDescription(root, contract, { taskId: 'T-20260101000000' }), 'usage', /not found/)
})

test('checkDescription：任务路径的测试证据时间窗（requireTests）', () => {
  const { root, contract } = projectWith('check-tests', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescription(root, contract)
  describeAll(root, contract)
  const task = addTask(root, contract, { title: '测试证据', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: '测试证据窗口用的新语义。' }],
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })
  applyDescriptionPlan(root, contract, task.id, { now: NOW })
  // 计划项落地后，不带 requireTests 应当全绿。
  const clean = checkDescription(root, contract, { taskId: task.id })
  assert.equal(clean.ok, true, JSON.stringify(clean.failed))

  const noEvidence = checkDescription(root, contract, { taskId: task.id, requireTests: true })
  assert.deepEqual(failedKinds(noEvidence), ['tests-missing'])

  // 早于 implemented_at 的绿记录不算证据。
  writeGateLog(root, 'tests', EARLIER, true)
  assert.deepEqual(
    failedKinds(checkDescription(root, contract, { taskId: task.id, requireTests: true })),
    ['tests-missing']
  )

  // 晚于 implemented_at 的绿记录才算。
  writeGateLog(root, 'tests', LATER, true)
  const withEvidence = checkDescription(root, contract, { taskId: task.id, requireTests: true })
  assert.deepEqual(failedKinds(withEvidence), [])

  // 失败记录不算证据。
  fs.rmSync(path.join(root, '.agents/flow/logs/tests'), { recursive: true, force: true })
  writeGateLog(root, 'tests', LATER, false)
  assert.deepEqual(
    failedKinds(checkDescription(root, contract, { taskId: task.id, requireTests: true })),
    ['tests-missing']
  )
})

test('checkDescription：stage=reviewing 默认要求测试证据，stage=queued-review 默认不要求', () => {
  const { root, contract } = projectWith('check-tests-default', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescription(root, contract)
  describeAll(root, contract)
  const task = addTask(root, contract, { title: '默认 requireTests', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: '默认 requireTests 用的新语义。' }],
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })
  applyDescriptionPlan(root, contract, task.id, { now: NOW })

  assert.deepEqual(failedKinds(checkDescription(root, contract, { taskId: task.id, stage: 'queued-review' })), [])
  assert.deepEqual(
    failedKinds(checkDescription(root, contract, { taskId: task.id, stage: 'reviewing' })),
    ['tests-missing']
  )
})

/** 写一条门禁运行日志（runGate 的落盘形状）。 */
function writeGateLog(root, gateId, finishedAt, ok) {
  const dir = path.join(root, '.agents/flow/logs', gateId)
  fs.mkdirSync(dir, { recursive: true })
  const name = `run-${finishedAt.replace(/[:+]/g, '-')}.json`
  const record = {
    gate: gateId,
    title: gateId,
    started_at: finishedAt,
    finished_at: finishedAt,
    durationMs: 1,
    ok,
    steps: [],
  }
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(record, null, 2)}\n`)
}
