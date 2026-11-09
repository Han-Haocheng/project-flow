// T-20261108 · D2：描述模型 `lib/desc.mjs` 的行为守护。
//
// 被测模块是描述台账的纯逻辑层（编码 / 最小 glob / 只读扫描 / 记录播种 /
// 对账 / 模块边 / 补丁 / 漂移检查 / 计划物化 / 渲染）。D3 的 core 在锁内只负责
// 把这里算出的记录写盘。它一旦「静默返回空数组 / 全部通过」，下游的阶段门与
// `flow check description` 都会变成假绿，所以本文件的每个用例都**先断言正例**
// （确实建出了记录、确实没有失败项），再断言否定（该报的 kind 确实报了）。
//
// 覆盖的坑：
//   - `**` 匹配零段（`**/*.mjs` 命中根目录文件）、`*` 不跨段、`?` 单字符；
//   - 路径编码往返（中文/空格/`*`/`.json` 结尾）；
//   - 种子模块：JS 段注释（重复段名 → `-2`、首个标记前的声明归 `top`、
//     空段不建模块）、无标记单模块、Python 每 class 一模块 + `top-level`；
//   - reconcile 只同步结构字段、保留 semantics/modules、无变化不写盘；
//   - 模块边排序 / why 截断 / 自环排除；
//   - checkProject 覆盖 spec §6 的每个项目级 kind（正例 → 反例）；
//   - checkPlan 的落地/未落地/未计划改动（临时 git 仓库）/测试证据时间窗；
//   - 渲染确定性（两次逐字节相等、含两张 mermaid、无墙钟时间）。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  applyFilePatch,
  applyPlanToRecords,
  checkPlan,
  checkProject,
  createRecord,
  decodePath,
  deriveModuleEdges,
  encodePath,
  gitChangedFiles,
  gitProbe,
  globMatcher,
  listSourceFiles,
  normalizePlanInput,
  normalizeSourcePath,
  planRealization,
  readSource,
  reconcileRecord,
  renderMarkdown,
  scanSourceAt,
  summarize,
  validateFilePatch,
} from '../lib/desc.mjs'
import { FlowError } from '../lib/util.mjs'

const NOW = '2026-11-08T10:00:00+08:00'
const LATER = '2026-11-08T11:00:00+08:00'
const LATER_STILL = '2026-11-08T11:30:00+08:00'
const PROJECT_SEMANTICS = '项目语义：描述台账的读写与漂移检查。'

const CONTRACT = {
  description: {
    include: ['**/*.mjs', '**/*.py'],
    exclude: ['**/node_modules/**', '**/.git/**', 'test/**'],
    maxFiles: 100,
    maxScanBytes: 1024 * 1024,
    minSemanticsChars: 10,
    gitCheck: false,
    testGate: 'tests',
    render: '',
  },
}

const roots = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function writeFile(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  return absolute
}

/** 一次性临时工程：`{相对路径: 文本}`。 */
function tempRoot(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-desc-'))
  roots.push(root)
  for (const [relative, content] of Object.entries(files)) writeFile(root, relative, content)
  return root
}

function scanMapOf(root, paths) {
  const map = new Map()
  for (const relative of paths) map.set(relative, scanSourceAt(root, relative))
  return map
}

/** 只取「阻断项」：warn 项按契约不算 failed。 */
function failsOf(items) {
  return items.filter((item) => item.level === 'fail')
}

function failedKindsOf(items) {
  return [...new Set(failsOf(items).map((item) => item.kind))].sort()
}

function assertInvalid(fn, pattern) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof FlowError, `应抛 FlowError，实际 ${error?.name}`)
      assert.equal(error.code, 'invalid', `应是 invalid，实际 ${error.code}：${error.message}`)
      if (pattern !== undefined) assert.match(error.message, pattern)
      return true
    }
  )
}

function assertSkips(result, reason) {
  assert.equal(result.skipped, reason, `应跳过（${reason}），实际 ${JSON.stringify(result)}`)
}

function applyPatch(record, patch, scanned, now = NOW) {
  return applyFilePatch(record, patch, scanned, { now })
}

// ------------------------------------------------------------------- git

function hasGit() {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' })
  return result.status === 0
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

function gitProject(files) {
  const root = tempRoot(files)
  gitRun(root, ['init', '-q'])
  gitRun(root, ['config', 'user.name', 'flow'])
  gitRun(root, ['config', 'user.email', 'flow@example.com'])
  gitRun(root, ['add', '-A'])
  gitRun(root, ['commit', '-qm', 'base'])
  return { root, base: gitRun(root, ['rev-parse', 'HEAD']) }
}

// ---------------------------------------------------------------- 路径

test('normalizeSourcePath：统一分隔符 / 去 ./ / 折叠空段', () => {
  // 正例：Windows 风格、多余点与空段都被折成同一条仓库相对路径。
  assert.equal(normalizeSourcePath('.\\lib\\a.mjs'), 'lib/a.mjs')
  assert.equal(normalizeSourcePath('lib/./a.mjs'), 'lib/a.mjs')
  assert.equal(normalizeSourcePath('lib//sub///a.mjs'), 'lib/sub/a.mjs')
  assert.equal(normalizeSourcePath('  lib/a.mjs  '), 'lib/a.mjs', '首尾空白应被忽略')
  assert.equal(normalizeSourcePath('lib/'), 'lib', '目录尾斜杠应被去掉')

  // 反例：绝对路径、越界、空、flow store 自身、非字符串。
  assertInvalid(() => normalizeSourcePath('/abs/a.mjs'), /绝对路径/)
  assertInvalid(() => normalizeSourcePath('C:\\proj\\a.mjs'), /绝对路径/)
  assertInvalid(() => normalizeSourcePath('\\\\server\\share\\a.mjs'), /绝对路径/)
  assertInvalid(() => normalizeSourcePath('../a.mjs'), /\.\./)
  assertInvalid(() => normalizeSourcePath('lib/../../a.mjs'), /\.\./)
  assertInvalid(() => normalizeSourcePath('   '), /不能为空/)
  assertInvalid(() => normalizeSourcePath('.agents/flow/project.json'), /flow store/)
  assertInvalid(() => normalizeSourcePath('lib/\0a.mjs'), /控制字符/)
  assertInvalid(() => normalizeSourcePath(42), /字符串/)
})

test('encodePath / decodePath：编码可逆、文件名无分隔符与裸 *', () => {
  const paths = [
    'lib/core.mjs',
    'lib/sub/deep/a.py',
    'lib/中 文/a b.mjs',
    'lib/a*b.mjs',
    'lib/star*and?q.mjs',
    'lib/x.json',
    'a%2Fb.mjs',
    '.hidden/.dotfile',
  ]
  for (const relative of paths) {
    const encoded = encodePath(relative)
    // 正例：编码结果里不能出现 `/` 或裸 `*`，且往返还原原路径。
    assert.ok(!encoded.includes('/'), `${relative} 的编码仍含分隔符：${encoded}`)
    assert.ok(!encoded.includes('*'), `${relative} 的编码仍含裸 *：${encoded}`)
    assert.equal(decodePath(encoded), relative, `${relative} 的往返失败`)
  }
  // 段内 `*` 必须显式转义（encodeURIComponent 不转它）。
  assert.match(encodePath('lib/a*b.mjs'), /%2A/)
  // 反例：空 id、坏转义、越界。
  assertInvalid(() => decodePath(''), /不能为空/)
  assertInvalid(() => decodePath('%E0%A4%A'), /不是合法的路径编码/)
  assertInvalid(() => decodePath('..%2Fa.mjs'), /\.\./)
})

// ---------------------------------------------------------------- glob

test('globMatcher：** 匹配零或多段、* 段内、? 单字符', () => {
  const mjs = globMatcher(['**/*.mjs'])
  // 正例：根目录与任意深度都命中。
  assert.equal(mjs('core.mjs'), true, '**/ 必须能匹配零段')
  assert.equal(mjs('lib/core.mjs'), true)
  assert.equal(mjs('a/b/c/d.mjs'), true)
  // 反例：跨段不命中、扩展名不符不命中。
  assert.equal(mjs('lib/core.js'), false)
  assert.equal(mjs('lib/core.mjs/x'), false)

  const star = globMatcher('lib/*.mjs')
  assert.equal(star('lib/a.mjs'), true)
  assert.equal(star('lib/a/b.mjs'), false, '* 不能跨段')

  const question = globMatcher('lib/?.mjs')
  assert.equal(question('lib/a.mjs'), true)
  assert.equal(question('lib/ab.mjs'), false, '? 只匹配单字符')

  const excluded = globMatcher(['**/node_modules/**'])
  assert.equal(excluded('node_modules/x.js'), true, '**/ 零段 + 结尾 ** 匹配内部任意')
  assert.equal(excluded('lib/node_modules/x.js'), true)
  assert.equal(excluded('lib/node_modulesx/x.js'), false)

  const dir = globMatcher(['test/**'])
  assert.equal(dir('test'), true, '目录自身也被排除')
  assert.equal(dir('test/a/b.mjs'), true)
  assert.equal(dir('tests/a.mjs'), false)

  // 多模式按「或」组合。
  const either = globMatcher(['**/*.mjs', '**/*.py'])
  assert.equal(either('lib/a.mjs'), true)
  assert.equal(either('lib/a.py'), true)
  assert.equal(either('lib/a.txt'), false)

  assertInvalid(() => globMatcher(undefined), /字符串/)
})

// ------------------------------------------------------- 只读文件系统

test('listSourceFiles：include/exclude/排序/maxFiles，跳过符号链接', (t) => {
  const root = tempRoot({
    'lib/a.mjs': 'export const A = 1\n',
    'lib/b.py': 'A = 1\n',
    'lib/note.txt': 'text\n',
    'lib/nested/c.mjs': 'export const C = 1\n',
    'node_modules/pkg/x.mjs': 'export const X = 1\n',
    'test/t.test.mjs': 'export const T = 1\n',
  })

  const listed = listSourceFiles(root, CONTRACT)
  // 正例：命中且按 path 排序；绝对路径可读。
  assert.deepEqual(
    listed.files.map((file) => file.path),
    ['lib/a.mjs', 'lib/b.py', 'lib/nested/c.mjs']
  )
  assert.deepEqual(listed.warnings, [])
  for (const file of listed.files) assert.ok(fs.statSync(file.abs).isFile(), `${file.abs} 应存在`)

  // 反例：exclude 命中的目录与文件都不出现。
  assert.ok(!listed.files.some((file) => file.path.includes('node_modules')))
  assert.ok(!listed.files.some((file) => file.path.startsWith('test/')))

  // maxFiles：截断 + 一条 warning。
  const limited = listSourceFiles(root, { description: { ...CONTRACT.description, maxFiles: 1 } })
  assert.equal(limited.files.length, 1)
  assert.equal(limited.warnings.length, 1)
  assert.match(limited.warnings[0], /max-files: 命中 3 个文件/)
  assert.match(limited.warnings[0], /maxFiles=1/)

  // 符号链接：平台允许就断言被跳过。
  let linked = false
  try {
    fs.symlinkSync(path.join(root, 'lib', 'a.mjs'), path.join(root, 'lib', 'link.mjs'))
    linked = true
  } catch {
    t.diagnostic('当前平台不允许创建符号链接，跳过符号链接断言')
  }
  if (linked) {
    const withLink = listSourceFiles(root, { description: { ...CONTRACT.description, exclude: [] } })
    assert.ok(withLink.files.some((file) => file.path === 'lib/a.mjs'), '正例：普通文件仍在')
    assert.ok(!withLink.files.some((file) => file.path === 'lib/link.mjs'), '符号链接不得进入文件清单')
  }

  assertInvalid(() => listSourceFiles('', CONTRACT), /root/)
  assert.throws(() => listSourceFiles(path.join(root, 'nope'), CONTRACT), (error) => error.code === 'not-found')
})

test('readSource：hash/bytes/lines 与各类跳过原因', () => {
  const root = tempRoot({
    'lib/two.mjs': 'a\nb\n',
    'lib/crlf.mjs': 'a\r\nb',
  })
  fs.writeFileSync(path.join(root, 'lib', 'binary.mjs'), Buffer.from([0x65, 0x00, 0x66]))

  const two = readSource(root, 'lib/two.mjs')
  // 正例：末尾换行不算多一行；hash 是 sha256。
  assert.equal(two.text, 'a\nb\n')
  assert.match(two.hash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(two.bytes, 4)
  assert.equal(two.lines, 2)
  assert.equal(readSource(root, 'lib/crlf.mjs').lines, 2, 'CRLF 也按 \\n 计行')

  // 反例：每一种读不到的情况都给 reason，而不是抛错。
  assertSkips(readSource(root, 'lib/missing.mjs'), 'not-found')
  assertSkips(readSource(root, 'lib/binary.mjs'), 'binary')
  assertSkips(readSource(root, 'lib/two.mjs', { maxBytes: 2 }), 'too-large')
  assertSkips(readSource(root, 'lib'), 'not-regular')
  assertSkips(readSource(root, '../escape.mjs'), 'unsafe-path')
  assertInvalid(() => readSource('', 'lib/two.mjs'), /root/)
})

test('scanSourceAt：import target 解析（相对存在 / 相对缺失留 raw / 包名 null）', () => {
  const root = tempRoot({
    'lib/a.mjs': 'export function alpha() { return 1 }\n',
    'lib/b.mjs': [
      "import { alpha } from './a.mjs'",
      "import gone from './missing.mjs'",
      "import fs from 'node:fs'",
      "import react from 'react'",
      "const lazy = () => import('./a.mjs')",
      'export function beta() { return alpha() }',
      '',
    ].join('\n'),
    'pkg/helper.py': 'def thing():\n    return 1\n',
    'pkg/main.py': 'from .helper import thing\nimport os\n',
  })

  const scanned = scanSourceAt(root, 'lib/b.mjs')
  assert.equal(scanned.language, 'js')
  assert.equal(scanned.imports.length, 5, '正例：五条 import 都要扫出来')
  const staticA = scanned.imports.find((entry) => entry.specifier === './a.mjs' && entry.kind === 'static')
  assert.equal(staticA.target, 'lib/a.mjs', '存在的相对目标应解析成仓库相对路径')
  const dynamicA = scanned.imports.find((entry) => entry.kind === 'dynamic')
  assert.equal(dynamicA.specifier, './a.mjs')
  assert.equal(dynamicA.target, 'lib/a.mjs', '动态 import 也要解析 target')

  const missing = scanned.imports.find((entry) => entry.specifier === './missing.mjs')
  assert.equal(missing.target, null)
  assert.equal(missing.raw, './missing.mjs', '解析不到时保留 raw')
  const builtin = scanned.imports.find((entry) => entry.specifier === 'node:fs')
  assert.equal(builtin.target, null)
  assert.equal(builtin.raw, undefined, '裸包不需要 raw')
  assert.equal(scanned.imports.find((entry) => entry.specifier === 'react').target, null)

  const python = scanSourceAt(root, 'pkg/main.py')
  assert.equal(python.language, 'python')
  assert.equal(python.imports.find((entry) => entry.specifier === '.helper').target, 'pkg/helper.py')
  assert.equal(python.imports.find((entry) => entry.specifier === 'os').target, null)

  // 源码正文不能出现在可枚举字段里（记录 schema 没有正文，不能被顺手序列化）。
  assert.deepEqual(Object.keys(scanned).sort(), [
    'bytes',
    'declarations',
    'hash',
    'imports',
    'language',
    'lines',
    'path',
  ])
  assert.ok(!JSON.stringify(scanned).includes('return alpha()'), '扫描结果不得携带源码正文')

  assertSkips(scanSourceAt(root, 'lib/missing.mjs'), 'not-found')
})

// ------------------------------------------------------ 种子模块 / 记录

test('createRecord：JS 段注释种子（top / 重复段名 -2 / 空段丢弃）', () => {
  const source = [
    'export function before() { return 1 }',
    '// ---- store 存储层',
    'export function loadThing() { return helper() }',
    'export const CONST_A = 1',
    '// ---- store 存储层',
    'export const SECOND = 2',
    '// ---- 空段',
    '// ---- impl',
    'export function helper() { return 3 }',
    '',
  ].join('\n')
  const root = tempRoot({ 'lib/table.mjs': source })
  const scanned = scanSourceAt(root, 'lib/table.mjs')
  assert.equal(scanned.declarations.length, 5, '正例：五条顶层声明')

  const record = createRecord(scanned, { now: NOW })
  assert.equal(record.schema, 1)
  assert.equal(record.path, 'lib/table.mjs')
  assert.equal(record.language, 'js')
  assert.equal(record.semantics, '', '新建记录的文件语义必须是空串')
  assert.equal(record.created_at, NOW)
  assert.equal(record.updated_at, NOW)
  assert.match(record.hash, /^sha256:/)

  // 正例：top + 两个 store（第二个 -2）+ impl；空段不建模块。
  assert.deepEqual(
    record.modules.map((module) => module.id),
    ['top', 'store', 'store-2', 'impl']
  )
  const members = new Map(record.modules.map((module) => [module.id, module.members]))
  assert.deepEqual(members.get('top'), ['before'])
  assert.deepEqual(members.get('store'), ['loadThing', 'CONST_A'])
  assert.deepEqual(members.get('store-2'), ['SECOND'])
  assert.deepEqual(members.get('impl'), ['helper'])
  for (const module of record.modules) assert.equal(module.semantics, '')

  // 模块边按成员引用推导：store 的 loadThing 引用了 impl 的 helper。
  assert.deepEqual(record.moduleEdges, [
    { from: 'store', to: 'impl', count: 1, why: ['loadThing → helper'] },
  ])

  // 段名 slug 成空时回退 section-N，标题保留原文。
  const chineseRoot = tempRoot({
    'lib/cn.mjs': '// ---- 扫描器\nfunction alpha() { return 1 }\n// ---- 台账\nfunction beta() { return 2 }\n',
  })
  const chinese = createRecord(scanSourceAt(chineseRoot, 'lib/cn.mjs'), { now: NOW })
  assert.deepEqual(
    chinese.modules.map((module) => module.id),
    ['section-1', 'section-2']
  )
  assert.deepEqual(
    chinese.modules.map((module) => module.title),
    ['扫描器', '台账']
  )
})

test('createRecord：无段注释单模块、无声明空模块表、Python 按 class 种子', () => {
  // 无标记：单模块 = 文件名去扩展名 slug。
  const jsRoot = tempRoot({
    'lib/my-util.mjs': 'export function alpha() { return 1 }\nexport function beta() { return alpha() }\n',
    'lib/empty.mjs': '// 只有注释\n',
  })
  const single = createRecord(scanSourceAt(jsRoot, 'lib/my-util.mjs'), { now: NOW })
  assert.equal(single.modules.length, 1)
  assert.equal(single.modules[0].id, 'my-util')
  assert.deepEqual(single.modules[0].members, ['alpha', 'beta'])

  const empty = createRecord(scanSourceAt(jsRoot, 'lib/empty.mjs'), { now: NOW })
  assert.deepEqual(empty.modules, [], '没有声明就没有种子模块')
  assert.deepEqual(empty.moduleEdges, [])
  assert.equal(empty.declarations, undefined, '记录里不出现 declarations 字段')

  // Python：每个 class 一个模块，其余归 top-level（顺序 = class 出现序 + 末尾 top-level）。
  const pyRoot = tempRoot({
    'pkg/model.py': [
      'import os',
      '',
      'class Alpha:',
      '    pass',
      '',
      'def helper():',
      '    return 1',
      '',
      'class Beta:',
      '    pass',
      '',
      'CONST_X = 2',
      '',
    ].join('\n'),
  })
  const python = createRecord(scanSourceAt(pyRoot, 'pkg/model.py'), { now: NOW })
  assert.equal(python.language, 'python')
  assert.deepEqual(
    python.modules.map((module) => module.id),
    ['alpha', 'beta', 'top-level']
  )
  assert.deepEqual(
    python.modules.map((module) => module.members),
    [['Alpha'], ['Beta'], ['helper', 'CONST_X']]
  )

  // 反例：跳过的扫描结果不能建记录。
  assertInvalid(() => createRecord({ path: 'x.mjs', skipped: 'binary' }, { now: NOW }), /跳过/)
})

test('reconcileRecord：保留语义/模块、只同步结构、无变化不写盘', () => {
  const root = tempRoot({
    'lib/a.mjs': [
      'export function alpha() { return 1 }',
      'export function beta() { return alpha() }',
      'export function gamma() { return 3 }',
      '',
    ].join('\n'),
  })
  const scanned = scanSourceAt(root, 'lib/a.mjs')
  const record = createRecord(scanned, { now: NOW })
  assert.deepEqual(record.modules[0].members, ['alpha', 'beta', 'gamma'], '正例：种子收了三条声明')

  // 拆成两个模块：a 拿 alpha/beta，legacy 拿 gamma（成员不能跨模块重复）。
  const patched = applyPatch(
    record,
    {
      path: 'lib/a.mjs',
      semantics: '文件 a 的语义：三个函数的说明。',
      modules: [
        { id: 'a', semantics: '模块 a 的语义描述文本。', members: ['alpha', 'beta'] },
        { id: 'legacy', op: 'add', semantics: '历史模块的语义描述文本。', members: ['gamma'] },
      ],
    },
    scanned
  ).record
  assert.equal(patched.semantics, '文件 a 的语义：三个函数的说明。')

  // 无变化：返回同一个记录对象、changed:false。
  const unchanged = reconcileRecord(patched, scanned, { now: LATER })
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.record, patched, '无变化应原样返回，不刷新 updated_at')
  assert.equal(unchanged.record.updated_at, NOW)

  // 变化：改文件后只同步结构字段，semantics/modules 原样保留（含失效成员）。
  writeFile(root, 'lib/a.mjs', [
    'export function alpha() { return 10 }',
    'export function beta() { return alpha() }',
    'export function delta() { return 4 }',
    '',
  ].join('\n'))
  const rescanned = scanSourceAt(root, 'lib/a.mjs')
  const changed = reconcileRecord(patched, rescanned, { now: LATER })
  assert.equal(changed.changed, true, 'hash/bytes/lines 变了就必须算变化')
  assert.notEqual(changed.record.hash, scanned.hash)
  assert.equal(changed.record.bytes, rescanned.bytes)
  assert.equal(changed.record.lines, rescanned.lines)
  assert.equal(changed.record.updated_at, LATER)
  assert.equal(changed.record.created_at, NOW, 'created_at 不随对账改变')
  assert.equal(changed.record.semantics, patched.semantics, '语义必须保留')
  assert.deepEqual(
    changed.record.modules.map((module) => module.id),
    ['a', 'legacy'],
    '模块归属（含失效成员）必须保留，留给 check 报 unknown-member'
  )
  assert.deepEqual(changed.record.modules[1].members, ['gamma'])
  // 反例：跳过的扫描结果不能对账。
  assertInvalid(() => reconcileRecord(patched, { path: 'lib/a.mjs', skipped: 'too-large' }, { now: LATER }), /跳过/)
})

test('reconcileRecord：新增声明按段锚点自动兜底归属（build 不再要求手工 desc set）', () => {
  const root = tempRoot({
    'lib/sec.mjs': [
      '// ---- alpha',
      'export function alphaOne() { return 1 }',
      '// ---- beta',
      'export function betaOne() { return 2 }',
      '',
    ].join('\n'),
  })
  const scanned = scanSourceAt(root, 'lib/sec.mjs')
  const record = createRecord(scanned, { now: NOW })
  // 模拟旧记录/合并后漂移：beta 段的新声明没进成员表（其余结构字段不变）。
  const pruned = {
    ...record,
    modules: record.modules.map((module) =>
      module.id === 'beta' ? { ...module, members: module.members.filter((name) => name !== 'betaOne') } : module,
    ),
  }
  const repaired = reconcileRecord(pruned, scanned, { now: LATER })
  assert.equal(repaired.changed, true, '成员归属变了也算变化（否则 build 不写盘）')
  const beta = repaired.record.modules.find((module) => module.id === 'beta')
  assert.deepEqual(beta.members, ['betaOne'], 'beta 段的声明应归 beta 模块')
  assert.equal(beta.semantics, pruned.modules.find((module) => module.id === 'beta').semantics, '自动归属不动语义')
  // 幂等：再对账一次没有变化。
  assert.equal(reconcileRecord(repaired.record, scanned, { now: LATER }).changed, false)
})

test('reconcileRecord：单模块文件自动补成员，手工拆分的多模块文件不动', () => {
  const root = tempRoot({
    'lib/single.mjs': 'export function one() { return 1 }\nexport function two() { return 2 }\n',
  })
  const scanned = scanSourceAt(root, 'lib/single.mjs')
  const record = createRecord(scanned, { now: NOW })
  assert.deepEqual(record.modules[0].members, ['one', 'two'])

  // 单模块：漏掉的声明按文件（无锚点）补回唯一模块。
  const pruned = { ...record, modules: [{ ...record.modules[0], members: ['one'] }] }
  const repaired = reconcileRecord(pruned, scanned, { now: LATER })
  assert.equal(repaired.changed, true)
  assert.deepEqual(repaired.record.modules[0].members, ['one', 'two'])

  // 多模块（人工拆分、无锚点）：归属不可推断，build 不得挪动。
  const split = {
    ...record,
    modules: [
      { id: 'one', title: 'one', semantics: '模块 one 的语义描述。', members: ['one'] },
      { id: 'two', title: 'two', semantics: '模块 two 的语义描述。', members: ['two'] },
    ],
  }
  const untouched = reconcileRecord(split, scanned, { now: NOW })
  assert.equal(untouched.changed, false)
  assert.deepEqual(untouched.record.modules.map((module) => module.members), [['one'], ['two']])
})

// ------------------------------------------------------------ 模块边

test('deriveModuleEdges：按 (from,to) 排序、count 去重、why 截断到 3、自环排除', () => {
  const modules = [
    { id: 'a', members: ['a1', 'a2'] },
    { id: 'b', members: ['b1', 'b2', 'b3', 'b4'] },
    { id: 'c', members: ['c1'] },
  ]
  const declarations = [
    // a 的成员引用 b 的四个成员 → 4 对，why 只留 3 条。
    { name: 'a1', identifiers: ['b1', 'b2', 'b3', 'b4', 'a2', 'noise'] },
    { name: 'a2', identifiers: ['b1'] },
    // b 的成员引用 a、c 与自身 → 自环（b→b）必须丢弃。
    { name: 'b1', identifiers: ['a1', 'c1', 'b2'] },
    { name: 'c1', identifiers: [] },
  ]

  const edges = deriveModuleEdges(modules, declarations)
  // 正例：双向边都在，且按 (from,to) 升序。
  assert.deepEqual(
    edges.map((edge) => `${edge.from}->${edge.to}`),
    ['a->b', 'b->a', 'b->c']
  )
  const aToB = edges.find((edge) => edge.from === 'a' && edge.to === 'b')
  assert.equal(aToB.count, 5, 'count 是命中对数（a1 的 4 对 + a2 的 1 对）')
  assert.equal(aToB.why.length, 3, 'why 最多 3 对')
  assert.deepEqual(aToB.why, ['a1 → b1', 'a1 → b2', 'a1 → b3'])
  assert.ok(!edges.some((edge) => edge.from === edge.to), '自环不能出现')
  assert.ok(!edges.some((edge) => edge.why.some((why) => why.includes('noise'))), '非成员名不产生边')

  // 确定性：同输入两次、模块顺序打乱后，边集合一致。
  assert.deepEqual(deriveModuleEdges(modules, declarations), edges)
  const shuffled = deriveModuleEdges([modules[2], modules[0], modules[1]], declarations)
  assert.deepEqual(
    shuffled.map((edge) => `${edge.from}->${edge.to}`),
    ['a->b', 'b->a', 'b->c']
  )

  // 反例：没有声明 / 没有模块时是空数组，而不是抛错。
  assert.deepEqual(deriveModuleEdges(modules, []), [])
  assert.deepEqual(deriveModuleEdges([], declarations), [])
})

// ------------------------------------------------------------ 文件补丁

test('validateFilePatch：id 正则 / 成员去重 / 语义长度', () => {
  // 正例：成员去重保序、path 归一、op 保留。
  const normalized = validateFilePatch({
    path: './lib/a.mjs',
    semantics: '文件 a 的语义描述文本。',
    modules: [{ id: 'a', op: 'change', semantics: '模块 a 的语义描述文本。', members: ['alpha', 'alpha', 'beta'] }],
  })
  assert.equal(normalized.path, 'lib/a.mjs')
  assert.deepEqual(normalized.modules[0].members, ['alpha', 'beta'])

  // 反例：id 不合规 / 重复 / 语义为空或过短 / 成员非法 / op 非法。
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', modules: [{ id: 'Store', semantics: '模块语义描述文本说明。', members: ['x'] }] }), /id 非法/)
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', modules: [{ id: '-bad', semantics: '模块语义描述文本说明。', members: ['x'] }] }), /id 非法/)
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', modules: [{ id: 'a'.repeat(42), semantics: '模块语义描述文本说明。', members: ['x'] }] }), /id 非法/)
  assertInvalid(
    () =>
      validateFilePatch({
        path: 'lib/a.mjs',
        modules: [
          { id: 'a', semantics: '模块语义描述文本说明。', members: ['x'] },
          { id: 'a', semantics: '模块语义描述文本说明。', members: ['y'] },
        ],
      }),
    /id 重复/
  )
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', semantics: '   ' }), /不能为空/)
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', semantics: '太短' }), /至少需要 10/)
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', modules: 'nope' }), /modules 必须是数组/)
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', modules: [{ id: 'a', semantics: '模块语义描述文本说明。', members: [1] }] }), /字符串数组/)
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', modules: [{ id: 'a', semantics: '模块语义描述文本说明。', members: [''] }] }), /空字符串/)
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', modules: [{ id: 'a', op: 'drop', semantics: '模块语义描述文本说明。' }] }), /add\|change\|remove/)
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', modules: [{ id: 'a', op: 'add', members: ['x'] }] }), /必须给 semantics/)
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', modules: [{ id: 'a', op: 'add', semantics: '模块语义描述文本说明。', members: [] }] }), /不能为空/)
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', modules: [{ id: 'a', op: 'remove', semantics: '模块语义描述文本说明。' }] }), /只接受 id/)
  assertInvalid(() => validateFilePatch({ path: 'lib/a.mjs', modules: [{ id: 'a' }] }), /至少给出/)
})

test('applyFilePatch：add/change/remove 模块、成员必须存在、幂等', () => {
  const root = tempRoot({
    'lib/a.mjs': 'export function alpha() { return 1 }\nexport function beta() { return alpha() }\n',
  })
  const scanned = scanSourceAt(root, 'lib/a.mjs')
  const record = createRecord(scanned, { now: NOW })
  assert.deepEqual(
    record.modules.map((module) => module.id),
    ['a'],
    '正例：无标记文件只有一个种子模块'
  )

  // change：补文件语义 + 模块语义 + 新增一个模块（成员必须真实存在且不重复归属）。
  const first = applyPatch(
    record,
    {
      path: 'lib/a.mjs',
      semantics: '文件 a 的语义：两个函数。',
      modules: [
        { id: 'a', semantics: '模块 a 的语义描述文本。', members: ['alpha'] },
        { id: 'extra', op: 'add', semantics: '额外模块的语义描述文本。', members: ['beta'] },
      ],
    },
    scanned
  )
  assert.equal(first.changed, true)
  assert.deepEqual(
    first.record.modules.map((module) => module.id),
    ['a', 'extra']
  )
  assert.deepEqual(first.record.modules[0].members, ['alpha'])
  assert.equal(first.record.modules[0].semantics, '模块 a 的语义描述文本。')
  assert.equal(first.record.updated_at, NOW)

  // 幂等：同一补丁再来一次（op 省略 → 自动判定 change）→ changed:false。
  const again = applyPatch(
    first.record,
    {
      path: 'lib/a.mjs',
      semantics: '文件 a 的语义：两个函数。',
      modules: [
        { id: 'a', semantics: '模块 a 的语义描述文本。', members: ['alpha'] },
        { id: 'extra', semantics: '额外模块的语义描述文本。', members: ['beta'] },
      ],
    },
    scanned,
    LATER
  )
  assert.equal(again.changed, false)
  assert.equal(again.record, first.record)

  // remove：删模块；再删一次必须抛 invalid。
  const removed = applyPatch(first.record, { path: 'lib/a.mjs', modules: [{ id: 'extra', op: 'remove' }] }, scanned, LATER)
  assert.equal(removed.changed, true)
  assert.deepEqual(removed.record.modules.map((module) => module.id), ['a'])
  assertInvalid(
    () => applyPatch(removed.record, { path: 'lib/a.mjs', modules: [{ id: 'extra', op: 'remove' }] }, scanned, LATER),
    /模块不存在/
  )

  // 反例：成员不存在 / add 已存在 / change 不存在 / 路径不一致 / 跳过扫描。
  assertInvalid(
    () => applyPatch(removed.record, { path: 'lib/a.mjs', modules: [{ id: 'a', members: ['ghost'] }] }, scanned, LATER),
    /成员不在扫描声明中/
  )
  assertInvalid(
    () => applyPatch(removed.record, { path: 'lib/a.mjs', modules: [{ id: 'a', op: 'add', semantics: '模块语义描述文本说明。', members: ['alpha'] }] }, scanned, LATER),
    /模块已存在/
  )
  assertInvalid(
    () => applyPatch(removed.record, { path: 'lib/a.mjs', modules: [{ id: 'nope', op: 'change', semantics: '模块语义描述文本说明。' }] }, scanned, LATER),
    /模块不存在/
  )
  assertInvalid(
    () => applyPatch(removed.record, { path: 'lib/other.mjs', semantics: '别的文件的语义描述文本。' }, scanned, LATER),
    /路径与记录不一致/
  )
  assertInvalid(
    () => applyPatch(removed.record, { path: 'lib/a.mjs', semantics: '文件语义描述文本说明。' }, { path: 'lib/a.mjs', skipped: 'binary' }, LATER),
    /跳过/
  )

  // 新造出来的跨模块重复必须拒绝（历史脏数据不阻塞修别处）。
  assertInvalid(
    () =>
      applyPatch(
        removed.record,
        {
          path: 'lib/a.mjs',
          modules: [
            { id: 'a', members: ['alpha', 'beta'] },
            { id: 'b', op: 'add', semantics: '第二模块的语义描述文本。', members: ['alpha'] },
          ],
        },
        scanned,
        LATER
      ),
    /成员跨模块重复/
  )
})

// ---------------------------------------------------------- 项目检查

function describedFixture(extraFiles = {}) {
  const root = tempRoot({
    'lib/a.mjs': 'export function alpha() { return 1 }\nexport function beta() { return alpha() }\n',
    'lib/b.mjs': 'export function gamma() { return 1 }\n',
    ...extraFiles,
  })
  const scannedMap = scanMapOf(root, ['lib/a.mjs', 'lib/b.mjs', ...Object.keys(extraFiles)])
  const recordA = applyPatch(
    createRecord(scannedMap.get('lib/a.mjs'), { now: NOW }),
    {
      path: 'lib/a.mjs',
      semantics: '文件 a 的语义描述文本。',
      modules: [{ id: 'a', semantics: '模块 a 的语义描述文本。', members: ['alpha', 'beta'] }],
    },
    scannedMap.get('lib/a.mjs')
  ).record
  const recordB = applyPatch(
    createRecord(scannedMap.get('lib/b.mjs'), { now: NOW }),
    {
      path: 'lib/b.mjs',
      semantics: '文件 b 的语义描述文本。',
      modules: [{ id: 'b', semantics: '模块 b 的语义描述文本。', members: ['gamma'] }],
    },
    scannedMap.get('lib/b.mjs')
  ).record
  const project = { name: 'fixture', semantics: PROJECT_SEMANTICS, generated_at: NOW }
  return { root, scannedMap, records: [recordA, recordB], recordA, recordB, project }
}

test('checkProject：干净工程零失败，结构性 kind 逐条可复现', () => {
  const { scannedMap, records, recordA, project } = describedFixture()

  // 正例：完全描述的工程没有任何失败项（含 warn 项也没有）。
  const clean = checkProject({ project, records, scannedMap }, CONTRACT, { strict: true })
  assert.deepEqual(clean, [], `干净工程不应有失败项：${JSON.stringify(clean)}`)

  const withRecords = (next) => checkProject({ project, records: next, scannedMap }, CONTRACT, { strict: true })
  const recordAWith = (mutate) => {
    const clone = JSON.parse(JSON.stringify(recordA))
    mutate(clone)
    return { ...records[0], ...clone }
  }

  // stale-hash
  const stale = withRecords([recordAWith((clone) => { clone.hash = 'sha256:deadbeef' }), records[1]])
  assert.ok(failedKindsOf(stale).includes('stale-hash'), `应报 stale-hash：${JSON.stringify(stale)}`)

  // modules-missing + unassigned-member（带行号）
  const missing = withRecords([recordAWith((clone) => { clone.modules = []; clone.moduleEdges = [] }), records[1]])
  assert.ok(failedKindsOf(missing).includes('modules-missing'))
  const unassigned = missing.filter((item) => item.kind === 'unassigned-member')
  assert.equal(unassigned.length, 2, '两条声明都未归属')
  assert.match(unassigned[0].detail, /（第 \d+ 行）/, 'unassigned-member 必须带行号')

  // unknown-member
  const unknown = withRecords([
    recordAWith((clone) => { clone.modules[0].members = ['alpha', 'beta', 'ghost'] }),
    records[1],
  ])
  const unknownItem = unknown.find((item) => item.kind === 'unknown-member')
  assert.ok(unknownItem, '应报 unknown-member')
  assert.equal(unknownItem.module, 'a')
  assert.match(unknownItem.detail, /ghost/)

  // duplicate-member
  const duplicate = withRecords([
    recordAWith((clone) => {
      clone.modules[0].members = ['alpha', 'beta']
      clone.modules.push({ id: 'dup', title: 'dup', semantics: '重复模块的语义描述文本。', members: ['beta'] })
      clone.moduleEdges = []
    }),
    records[1],
  ])
  const duplicateItem = duplicate.find((item) => item.kind === 'duplicate-member')
  assert.ok(duplicateItem, '应报 duplicate-member')
  assert.match(duplicateItem.detail, /beta/)

  // empty-module
  const empty = withRecords([
    recordAWith((clone) => {
      clone.modules.push({ id: 'z', title: 'z', semantics: '空模块的语义描述文本。', members: [] })
    }),
    records[1],
  ])
  const emptyItem = empty.find((item) => item.kind === 'empty-module')
  assert.ok(emptyItem, '应报 empty-module')
  assert.equal(emptyItem.module, 'z')
})

test('checkProject：ghost-import / invalid-edge / stale-module-edges', () => {
  const root = tempRoot({
    'lib/a.mjs': "import { gone } from './missing.mjs'\nexport function alpha() { return gone() }\n",
    'lib/b.mjs': 'export function beta() { return 1 }\n',
  })
  const scannedMap = scanMapOf(root, ['lib/a.mjs', 'lib/b.mjs'])
  const recordA = applyPatch(
    createRecord(scannedMap.get('lib/a.mjs'), { now: NOW }),
    {
      path: 'lib/a.mjs',
      semantics: '文件 a 的语义描述文本。',
      modules: [{ id: 'a', semantics: '模块 a 的语义描述文本。', members: ['alpha'] }],
    },
    scannedMap.get('lib/a.mjs')
  ).record
  const recordB = applyPatch(
    createRecord(scannedMap.get('lib/b.mjs'), { now: NOW }),
    {
      path: 'lib/b.mjs',
      semantics: '文件 b 的语义描述文本。',
      modules: [{ id: 'b', semantics: '模块 b 的语义描述文本。', members: ['beta'] }],
    },
    scannedMap.get('lib/b.mjs')
  ).record
  const project = { name: 'p', semantics: PROJECT_SEMANTICS }
  const scanA = scannedMap.get('lib/a.mjs')

  // 正例：扫描确实看到了那条相对 import，且解析结果是 null + raw。
  const ghost = scanA.imports.find((entry) => entry.specifier === './missing.mjs')
  assert.equal(ghost.target, null)
  assert.equal(ghost.raw, './missing.mjs')

  const items = checkProject({ project, records: [recordA, recordB], scannedMap }, CONTRACT, { strict: true })
  const ghostItem = items.find((item) => item.kind === 'ghost-import')
  assert.ok(ghostItem, `应报 ghost-import：${JSON.stringify(items)}`)
  assert.equal(ghostItem.path, 'lib/a.mjs')

  // invalid-edge：指向未知模块 / 自环。
  const invalid = checkProject(
    {
      project,
      records: [
        { ...recordA, moduleEdges: [{ from: 'a', to: 'ghost', count: 1, why: [] }, { from: 'a', to: 'a', count: 1, why: [] }] },
        recordB,
      ],
      scannedMap,
    },
    CONTRACT,
    { strict: true }
  )
  const invalidEdges = invalid.filter((item) => item.kind === 'invalid-edge')
  assert.equal(invalidEdges.length, 2)
  assert.ok(invalidEdges.every((item) => /未知模块|自环/.test(item.detail)))

  // stale-module-edges：边合法但已过期（实际重算为空）。
  const staleEdges = checkProject(
    {
      project,
      records: [
        {
          ...recordA,
          modules: [
            { id: 'a', title: 'a', semantics: '模块 a 的语义描述文本。', members: ['alpha'] },
            { id: 'c', title: 'c', semantics: '模块 c 的语义描述文本。', members: [] },
          ],
          moduleEdges: [{ from: 'a', to: 'c', count: 1, why: ['alpha → x'] }],
        },
        recordB,
      ],
      scannedMap,
    },
    CONTRACT,
    { strict: true }
  )
  assert.ok(failedKindsOf(staleEdges).includes('stale-module-edges'))
})

test('checkProject：missing-semantics（project/file/module）与 undescribed-file 的 warn 升级', () => {
  const { scannedMap, records, recordA, project } = describedFixture({ 'lib/extra.mjs': 'export function delta() { return 1 }\n' })

  // 正例：三个层级的语义都够长 → 没有 missing-semantics。
  const clean = checkProject({ project, records, scannedMap }, CONTRACT, { strict: false })
  assert.equal(clean.some((item) => item.kind === 'missing-semantics'), false)

  // 项目语义空 → 项目级失败（path 用 '.'）。
  const projectMissing = checkProject(
    {
      project: { ...project, semantics: '' },
      records,
      scannedMap: new Map([...scannedMap].filter(([key]) => key !== 'lib/extra.mjs')),
    },
    CONTRACT,
    { strict: false }
  )
  const projectItems = projectMissing.filter((item) => item.kind === 'missing-semantics' && item.path === '.')
  assert.equal(projectItems.length, 1)

  // 文件语义空 / 模块语义空。
  const fileEmpty = checkProject(
    { project, records: [{ ...recordA, semantics: '' }, records[1]], scannedMap },
    CONTRACT,
    { strict: false }
  )
  assert.ok(fileEmpty.some((item) => item.kind === 'missing-semantics' && item.path === 'lib/a.mjs'))
  const moduleEmpty = checkProject(
    {
      project,
      records: [
        { ...recordA, modules: [{ id: 'a', title: 'a', semantics: '', members: ['alpha', 'beta'] }] },
        records[1],
      ],
      scannedMap,
    },
    CONTRACT,
    { strict: false }
  )
  const moduleItem = moduleEmpty.find((item) => item.kind === 'missing-semantics' && item.module === 'a')
  assert.ok(moduleItem, '模块语义空必须报')

  // undescribed-file：非 strict 是 warn（不进 fails），strict 升级为 fail。
  const loose = checkProject({ project, records, scannedMap }, CONTRACT, { strict: false })
  const looseUndescribed = loose.filter((item) => item.kind === 'undescribed-file')
  assert.equal(looseUndescribed.length, 1)
  assert.equal(looseUndescribed[0].path, 'lib/extra.mjs')
  assert.equal(looseUndescribed[0].level, 'warn')
  assert.deepEqual(failsOf(loose), [], 'warn 项不得计入 failed')

  const strict = checkProject({ project, records, scannedMap }, CONTRACT, { strict: true })
  const strictUndescribed = strict.filter((item) => item.kind === 'undescribed-file')
  assert.equal(strictUndescribed[0].level, 'fail')
  assert.ok(failsOf(strict).some((item) => item.kind === 'undescribed-file'))
})

test('checkProject：render-stale（配置了 render 时对比现算内容）', () => {
  const { root, scannedMap, records, project } = describedFixture()
  const contract = { description: { ...CONTRACT.description, render: 'docs/description.md' } }
  const rendered = renderMarkdown(project, records)

  // 正例：文件内容 == 现算内容 → 不报。
  const renderedPath = writeFile(root, 'docs/description.md', rendered)
  assert.ok(fs.statSync(renderedPath).isFile())
  const ok = checkProject({ project, records, scannedMap }, contract, { strict: true, root })
  assert.equal(ok.some((item) => item.kind === 'render-stale'), false, `现算内容应通过：${JSON.stringify(ok)}`)

  // 反例：内容不一致 / 文件不存在。
  fs.writeFileSync(renderedPath, `${rendered}\n多出来的一行\n`)
  const stale = checkProject({ project, records, scannedMap }, contract, { strict: true, root })
  assert.ok(stale.some((item) => item.kind === 'render-stale'), '内容不一致应报 render-stale')

  fs.rmSync(renderedPath)
  const missing = checkProject({ project, records, scannedMap }, contract, { strict: true, root })
  assert.match(missing.find((item) => item.kind === 'render-stale').detail, /不存在/)

  // renderText 通道（调用方已经读过文件时不必再读盘）。
  const byText = checkProject({ project, records, scannedMap }, contract, { strict: true, renderText: rendered })
  assert.equal(byText.some((item) => item.kind === 'render-stale'), false)
  // 没配置 render 时不做这项检查。
  const noRender = checkProject({ project, records, scannedMap }, CONTRACT, { strict: true, root })
  assert.equal(noRender.some((item) => item.kind === 'render-stale'), false)
})

// ---------------------------------------------------------- 计划归一

test('normalizePlanInput：files xor noSemanticChange、默认值、history 追加', () => {
  // 正例：files 计划。
  const plan = normalizePlanInput(
    {
      files: [
        {
          path: 'lib/a.mjs',
          op: 'add',
          semantics: '新增文件的语义描述文本。',
          modules: [{ id: 'a', op: 'add', semantics: '新增模块的语义描述文本。', members: ['alpha'] }],
        },
      ],
    },
    { task: 'T-20261108120000', now: NOW, stage: 'analyzing' }
  )
  assert.equal(plan.schema, 1)
  assert.equal(plan.task, 'T-20261108120000')
  assert.equal(plan.status, 'planned')
  assert.equal(plan.noSemanticChange, false)
  assert.deepEqual(plan.base, { commit: null, clean: true, recorded_at: NOW })
  assert.equal(plan.files.length, 1)
  assert.equal(plan.files[0].op, 'add')
  assert.equal(plan.files[0].modules[0].op, 'add')
  assert.equal(plan.created_at, NOW)
  assert.equal(plan.updated_at, NOW)
  assert.equal(plan.implemented_at, null)
  assert.equal(plan.history.length, 1)
  assert.deepEqual(plan.history[0], { at: NOW, stage: 'analyzing', note: '' })

  // 修订：保留既有 history 并追加一条。
  const amended = normalizePlanInput(
    { ...plan, files: [...plan.files], note: '补充一条模块' },
    { now: LATER, stage: 'implementing' }
  )
  assert.equal(amended.history.length, 2)
  assert.equal(amended.history[0].at, NOW)
  assert.deepEqual(amended.history[1], { at: LATER, stage: 'implementing', note: '补充一条模块' })
  assert.equal(amended.created_at, NOW)
  assert.equal(amended.updated_at, LATER)

  // noSemanticChange：files 为空 + reason 必填。
  const none = normalizePlanInput({ noSemanticChange: true, reason: '只改注释' }, { task: 'T-20261108120001', now: NOW })
  assert.deepEqual(none.files, [])
  assert.equal(none.noSemanticChange, true)
  assert.equal(none.reason, '只改注释')

  // 反例
  assertInvalid(() => normalizePlanInput({}, { task: 'T-20261108120000', now: NOW }), /files/)
  assertInvalid(
    () =>
      normalizePlanInput(
        { files: [{ path: 'lib/a.mjs', op: 'change', semantics: '文件语义描述文本说明。' }], noSemanticChange: true, reason: 'x' },
        { task: 'T-20261108120000', now: NOW }
      ),
    /不能同时给出/
  )
  assertInvalid(() => normalizePlanInput({ noSemanticChange: true }, { task: 'T-20261108120000', now: NOW }), /reason/)
  assertInvalid(() => normalizePlanInput({ files: [] }, { task: 'T-20261108120000', now: NOW }), /files/)
  assertInvalid(
    () => normalizePlanInput({ files: [{ path: 'lib/a.mjs', op: 'add', semantics: '文件语义描述文本说明。' }] }, { task: 'T-20261108120000' }),
    /至少一个模块/
  )
  assertInvalid(
    () => normalizePlanInput({ files: [{ path: 'lib/a.mjs', op: 'add', modules: [{ id: 'a', semantics: '模块语义描述文本说明。', members: ['x'] }] }] }, { task: 'T-20261108120000' }),
    /必须给 semantics/
  )
  assertInvalid(
    () => normalizePlanInput({ files: [{ path: 'lib/a.mjs', op: 'remove', semantics: '文件语义描述文本说明。' }] }, { task: 'T-20261108120000' }),
    /只接受 path/
  )
  assertInvalid(
    () =>
      normalizePlanInput(
        {
          files: [
            { path: 'lib/a.mjs', op: 'change', semantics: '文件语义描述文本说明。' },
            { path: 'lib/a.mjs', op: 'change', semantics: '另一段文件语义描述。' },
          ],
        },
        { task: 'T-20261108120000' }
      ),
    /同一路径/
  )
  assertInvalid(() => normalizePlanInput({ files: [{ path: 'lib/a.mjs', op: 'rename' }] }, { task: 'T-20261108120000' }), /op/)
  assertInvalid(() => normalizePlanInput({ files: [{ path: 'lib/a.mjs', op: 'remove' }] }, { task: '../evil' }), /任务 id/)
  assertInvalid(
    () => normalizePlanInput({ files: [{ path: 'lib/a.mjs', op: 'remove' }] }, { task: 'T-20261108120000', base: { commit: 'ab cd' } }),
    /base\.commit/
  )
})

// -------------------------------------------------------- 计划物化

test('applyPlanToRecords：语义落地、成员并集、幂等、删模块/删文件', () => {
  const root = tempRoot({
    'lib/a.mjs': 'export function alpha() { return 1 }\nexport function beta() { return alpha() }\n',
    'lib/b.mjs': 'export function gamma() { return 1 }\n',
  })
  const scannedMap = scanMapOf(root, ['lib/a.mjs', 'lib/b.mjs'])
  const records = [
    {
      ...createRecord(scannedMap.get('lib/a.mjs'), { now: NOW }),
      modules: [{ id: 'a', title: 'a', semantics: '', members: ['alpha', 'beta'] }],
    },
    {
      ...createRecord(scannedMap.get('lib/b.mjs'), { now: NOW }),
      modules: [{ id: 'b', title: 'b', semantics: '', members: ['gamma'] }],
    },
  ]

  const plan = normalizePlanInput(
    {
      files: [
        {
          path: 'lib/a.mjs',
          op: 'change',
          semantics: '文件 a 的新语义描述文本。',
          modules: [{ id: 'a', op: 'change', semantics: '模块 a 的新语义描述。', members: ['beta'] }],
        },
        { path: 'lib/b.mjs', op: 'change', modules: [{ id: 'b', op: 'change', semantics: '模块 b 的新语义描述。' }] },
      ],
    },
    { task: 'T-20261108120000', now: NOW }
  )

  // 正例：未落地时 planRealization 有项，落地后为空。
  assert.ok(planRealization(plan, records).length > 0)
  const first = applyPlanToRecords(plan, records, scannedMap, { now: LATER })
  assert.equal(first.applied, true)
  assert.deepEqual(planRealization(plan, first.records), [])
  const recordA = first.records.find((record) => record.path === 'lib/a.mjs')
  assert.equal(recordA.semantics, '文件 a 的新语义描述文本。')
  assert.equal(recordA.updated_at, LATER)
  assert.equal(recordA.modules[0].semantics, '模块 a 的新语义描述。')
  // 成员是增量断言：计划只列 beta，alpha 不能被丢掉。
  assert.deepEqual(recordA.modules[0].members, ['alpha', 'beta'])
  // 计划没给文件语义的文件只改模块语义。
  assert.equal(first.records.find((record) => record.path === 'lib/b.mjs').semantics, '')

  // 幂等：第二次零变化。
  const second = applyPlanToRecords(plan, first.records, scannedMap, { now: LATER })
  assert.equal(second.applied, false)
  assert.deepEqual(second.records, first.records)

  // 删模块（幂等：模块已不在时跳过而不是抛错）。
  const removal = normalizePlanInput(
    { files: [{ path: 'lib/a.mjs', op: 'change', modules: [{ id: 'a', op: 'remove' }] }] },
    { task: 'T-20261108120001', now: NOW }
  )
  const afterRemoval = applyPlanToRecords(removal, second.records, scannedMap, { now: LATER })
  assert.equal(afterRemoval.applied, true)
  assert.deepEqual(afterRemoval.records.find((record) => record.path === 'lib/a.mjs').modules, [])
  assert.equal(applyPlanToRecords(removal, afterRemoval.records, scannedMap, { now: LATER }).applied, false)

  // 删文件：记录消失。
  const fileRemoval = normalizePlanInput(
    { files: [{ path: 'lib/b.mjs', op: 'remove' }] },
    { task: 'T-20261108120002', now: NOW }
  )
  const afterFileRemoval = applyPlanToRecords(fileRemoval, afterRemoval.records, scannedMap, { now: LATER })
  assert.equal(afterFileRemoval.applied, true)
  assert.deepEqual(afterFileRemoval.records.map((record) => record.path), ['lib/a.mjs'])

  // 计划新增的文件没有记录时，按扫描结果建记录（正例）。
  const extraRoot = tempRoot({ 'lib/new.mjs': 'export function delta() { return 1 }\n' })
  const extraScan = scanSourceAt(extraRoot, 'lib/new.mjs')
  const addPlan = normalizePlanInput(
    {
      files: [
        {
          path: 'lib/new.mjs',
          op: 'add',
          semantics: '新文件的语义描述文本。',
          modules: [{ id: 'new', op: 'add', semantics: '新模块的语义描述文本。', members: ['delta'] }],
        },
      ],
    },
    { task: 'T-20261108120003', now: NOW }
  )
  const created = applyPlanToRecords(addPlan, [], new Map([['lib/new.mjs', extraScan]]), { now: LATER })
  assert.equal(created.applied, true)
  assert.equal(created.records.length, 1)
  assert.equal(created.records[0].semantics, '新文件的语义描述文本。')
  assert.deepEqual(created.records[0].modules.map((module) => module.id), ['new'])

  // 反例：成员不存在（结构性不可能）与缺失扫描结果都抛 invalid。
  const badMembers = normalizePlanInput(
    { files: [{ path: 'lib/a.mjs', op: 'change', modules: [{ id: 'a', op: 'change', members: ['ghost'] }] }] },
    { task: 'T-20261108120004', now: NOW }
  )
  assertInvalid(() => applyPlanToRecords(badMembers, first.records, scannedMap, { now: LATER }), /成员不在扫描声明中/)
  const missingScan = normalizePlanInput(
    {
      files: [
        {
          path: 'lib/zzz.mjs',
          op: 'add',
          semantics: '缺扫描文件的语义描述。',
          modules: [{ id: 'z', op: 'add', semantics: '模块语义描述文本说明。', members: ['x'] }],
        },
      ],
    },
    { task: 'T-20261108120005', now: NOW }
  )
  assertInvalid(() => applyPlanToRecords(missingScan, first.records, scannedMap, { now: LATER }), /没有可用扫描结果/)
})

// ---------------------------------------------------------- 计划检查

function planFixture() {
  const base = describedFixture()
  const plan = normalizePlanInput(
    {
      files: [
        {
          path: 'lib/a.mjs',
          op: 'change',
          semantics: '文件 a 的语义描述文本。',
          modules: [{ id: 'a', op: 'change', semantics: '模块 a 的语义描述文本。', members: ['alpha'] }],
        },
      ],
    },
    { task: 'T-20261108120000', now: NOW, base: { commit: null } }
  )
  return { ...base, plan }
}

test('checkPlan：未 apply / 语义不一致 / 成员未落地都算 plan-unrealized', () => {
  const { scannedMap, records, plan } = planFixture()
  // 正例：计划语义与记录一致（只差 apply 状态）。
  assert.deepEqual(planRealization(plan, records), [])

  const predicted = checkPlan(plan, { records, scannedMap, contract: CONTRACT })
  const statusItem = predicted.find((item) => item.kind === 'plan-unrealized' && item.path === '.')
  assert.ok(statusItem, `planned 状态应报 plan-unrealized：${JSON.stringify(predicted)}`)
  assert.match(statusItem.detail, /planned/)

  const implemented = { ...plan, status: 'implemented', implemented_at: LATER }
  const realized = checkPlan(implemented, { records, scannedMap, contract: CONTRACT })
  assert.deepEqual(failsOf(realized), [], `落地后不应有失败项：${JSON.stringify(realized)}`)

  // 反例：记录语义被改回去 → 文件与模块两条 plan-unrealized。
  const reverted = records.map((record) =>
    record.path === 'lib/a.mjs'
      ? {
          ...record,
          semantics: '被改回去的旧语义描述。',
          modules: [{ ...record.modules[0], semantics: '被改回去的旧模块语义。' }],
        }
      : record
  )
  const mismatch = checkPlan(implemented, { records: reverted, scannedMap, contract: CONTRACT })
  const unrealized = mismatch.filter((item) => item.kind === 'plan-unrealized')
  assert.equal(unrealized.length, 2, `应报文件+模块两条：${JSON.stringify(mismatch)}`)
  assert.deepEqual(unrealized.map((item) => item.module ?? null).sort(), ['a', null].sort())

  // 反例：成员未落地。
  const missingMember = records.map((record) =>
    record.path === 'lib/a.mjs' ? { ...record, modules: [{ ...record.modules[0], members: ['beta'] }] } : record
  )
  const memberItems = checkPlan(implemented, { records: missingMember, scannedMap, contract: CONTRACT })
  assert.ok(
    memberItems.some((item) => item.kind === 'plan-unrealized' && /成员未落地/.test(item.detail)),
    '成员不在记录里应报 plan-unrealized'
  )

  // 反例：计划内的文件没有记录 → missing-record。
  const noRecord = checkPlan(implemented, { records: [], scannedMap, contract: CONTRACT })
  assert.ok(noRecord.some((item) => item.kind === 'missing-record'))

  // 反例：计划内文件没有被扫描到（已删除）→ plan-unrealized。
  const noScan = checkPlan(implemented, { records, scannedMap: new Map(), contract: CONTRACT })
  assert.ok(noScan.some((item) => item.kind === 'plan-unrealized' && /不存在或不在扫描范围/.test(item.detail)))

  // 计划内文件的项目级检查失败项必须透传（成员漏归属 → unassigned-member）。
  const unassigned = records.map((record) =>
    record.path === 'lib/a.mjs' ? { ...record, modules: [{ ...record.modules[0], members: ['alpha'] }] } : record
  )
  const propagated = checkPlan(implemented, { records: unassigned, scannedMap, contract: CONTRACT })
  assert.ok(
    propagated.some((item) => item.kind === 'unassigned-member' && item.path === 'lib/a.mjs'),
    '计划内文件的项目级失败项必须透传'
  )

  // 项目级语义缺失也要进计划检查（传了 project 才检查）。
  const projectMissing = checkPlan(implemented, {
    records,
    scannedMap,
    contract: CONTRACT,
    project: { name: 'p', semantics: '' },
  })
  assert.ok(projectMissing.some((item) => item.kind === 'missing-semantics' && item.path === '.'))

  // 没有计划 → plan-missing（阶段门的第一道拦截）。
  const noPlan = checkPlan(null, { records, scannedMap, contract: CONTRACT })
  assert.equal(noPlan.length, 1)
  assert.equal(noPlan[0].kind, 'plan-missing')
  assert.equal(noPlan[0].level, 'fail')
})

test('checkPlan：未计划改动（临时 git 仓库）与 op 匹配', (t) => {
  if (!hasGit()) {
    t.skip('环境里没有 git')
    return
  }
  const { root, base } = gitProject({
    'lib/a.mjs': 'export function alpha() { return 1 }\n',
    'lib/b.mjs': 'export function beta() { return 2 }\n',
  })
  const contract = { description: { ...CONTRACT.description, gitCheck: true } }
  const scannedMap = scanMapOf(root, ['lib/a.mjs', 'lib/b.mjs'])
  const created = [
    createRecord(scannedMap.get('lib/a.mjs'), { now: NOW }),
    createRecord(scannedMap.get('lib/b.mjs'), { now: NOW }),
  ]
  const plan = normalizePlanInput(
    {
      files: [
        {
          path: 'lib/a.mjs',
          op: 'change',
          semantics: '文件 a 的新语义描述文本。',
          modules: [{ id: 'a', op: 'change', semantics: '模块 a 的新语义描述。' }],
        },
      ],
    },
    { task: 'T-20261108120000', now: NOW, base: { commit: base, clean: true } }
  )
  // 先把计划落到记录里（否则 planRealization 会先报「未落地」）。
  const records = applyPlanToRecords(plan, created, scannedMap, { now: LATER }).records
  const implemented = { ...plan, status: 'implemented', implemented_at: LATER }

  // 正例：base 之后没有改动 → 干净。
  const clean = checkPlan(implemented, { records, scannedMap, root, contract })
  assert.deepEqual(clean, [], `clean 工作树不应有失败项：${JSON.stringify(clean)}`)

  // 计划内改动（lib/a.mjs）允许，计划外改动（lib/b.mjs）与新增（lib/d.mjs）都报。
  writeFile(root, 'lib/a.mjs', 'export function alpha() { return 11 }\n')
  writeFile(root, 'lib/b.mjs', 'export function beta() { return 22 }\n')
  writeFile(root, 'lib/d.mjs', 'export function delta() { return 3 }\n')
  const dirty = checkPlan(implemented, { records, scannedMap, root, contract })
  const unplanned = dirty.filter((item) => item.kind === 'unplanned-change')
  assert.deepEqual(unplanned.map((item) => item.path).sort(), ['lib/b.mjs', 'lib/d.mjs'])
  assert.match(unplanned.find((item) => item.path === 'lib/d.mjs').detail, /add/)

  // 删除计划内文件但计划写的是 change → op 不匹配。
  const deletionPlan = normalizePlanInput(
    { files: [{ path: 'lib/a.mjs', op: 'change', semantics: '文件 a 的新语义描述文本。' }] },
    { task: 'T-20261108120001', now: NOW, base: { commit: base, clean: true } }
  )
  fs.rmSync(path.join(root, 'lib', 'a.mjs'))
  const deleted = checkPlan(
    { ...deletionPlan, status: 'implemented', implemented_at: LATER },
    { records, scannedMap, root, contract }
  )
  const deletedItems = deleted.filter((item) => item.kind === 'unplanned-change' && item.path === 'lib/a.mjs')
  assert.equal(deletedItems.length, 1)
  assert.match(deletedItems[0].detail, /计划 op=change，实际是 remove/)

  // base 失效 / 没有 base → warning 项，且不产生 fail。
  const badBase = checkPlan(
    { ...implemented, base: { commit: 'deadbeef', clean: true, recorded_at: NOW } },
    { records, scannedMap, root, contract }
  )
  assert.deepEqual(failsOf(badBase), [], `base 失效不得阻断：${JSON.stringify(badBase)}`)
  assert.ok(badBase.some((item) => item.kind === 'git-base-changed' && item.level === 'warn'))
  const noBase = checkPlan(
    { ...implemented, base: { commit: null, clean: true, recorded_at: NOW } },
    { records, scannedMap, root, contract }
  )
  assert.ok(noBase.some((item) => item.kind === 'git-base-changed' && item.level === 'warn'))
  assert.deepEqual(failsOf(noBase), [])

  // 不是 git 仓库 → git-unavailable warning，仍然不阻断。
  const plainRoot = tempRoot({ 'lib/a.mjs': 'export function alpha() { return 1 }\n' })
  const plainScan = scanMapOf(plainRoot, ['lib/a.mjs'])
  const plainRecord = applyPatch(
    createRecord(plainScan.get('lib/a.mjs'), { now: NOW }),
    {
      path: 'lib/a.mjs',
      semantics: '文件 a 的新语义描述文本。',
      modules: [{ id: 'a', semantics: '模块 a 的新语义描述。' }],
    },
    plainScan.get('lib/a.mjs')
  ).record
  const noGit = checkPlan(implemented, { records: [plainRecord], scannedMap: plainScan, root: plainRoot, contract })
  assert.ok(noGit.some((item) => item.kind === 'git-unavailable' && item.level === 'warn'))
  assert.deepEqual(failsOf(noGit), [], `git 不可用不得阻断：${JSON.stringify(noGit)}`)
  assert.equal(gitProbe(plainRoot).ok, false)
  assert.equal(gitChangedFiles(plainRoot, base).ok, false)
})

test('checkPlan：测试证据时间窗 = max(implemented_at, 计划内记录 updated_at)', () => {
  const { root, scannedMap, records, plan } = planFixture()
  // 换一段「还没落地」的文件语义，把计划真正 apply 一次，让记录 updated_at 走到 11:30。
  const later = normalizePlanInput(
    {
      files: [
        {
          path: 'lib/a.mjs',
          op: 'change',
          semantics: '更新后的文件语义描述文本。',
          modules: [{ id: 'a', op: 'change', semantics: '模块 a 的语义描述文本。' }],
        },
      ],
    },
    { task: 'T-20261108120009', now: NOW, base: { commit: null } }
  )
  const applied = applyPlanToRecords(later, records, scannedMap, { now: LATER_STILL })
  assert.equal(applied.applied, true)
  const recordA = applied.records.find((record) => record.path === 'lib/a.mjs')
  assert.equal(recordA.updated_at, LATER_STILL, '计划内记录的 updated_at 必须被刷新')
  const implemented = { ...later, status: 'implemented', implemented_at: '2026-11-08T11:00:00+08:00' }
  const context = { records: applied.records, scannedMap, root, contract: CONTRACT, requireTests: true }

  // 正例：晚于起点（11:30）的通过记录。
  const passed = checkPlan(implemented, {
    ...context,
    gateRuns: [{ gate: 'tests', ok: true, finished_at: '2026-11-08T12:00:00+08:00' }],
  })
  assert.equal(passed.some((item) => item.kind === 'tests-missing'), false, `应通过：${JSON.stringify(passed)}`)

  // 反例：晚于 implemented_at 但早于记录 updated_at（11:15）→ 仍不通过。
  const between = checkPlan(implemented, {
    ...context,
    gateRuns: [{ gate: 'tests', ok: true, finished_at: '2026-11-08T11:15:00+08:00' }],
  })
  assert.ok(
    between.some((item) => item.kind === 'tests-missing' && /早于要求/.test(item.detail)),
    '测试证据必须晚于记录 updated_at'
  )

  // 反例：失败记录不算；别的门禁不算；完全没有记录也算缺失。
  const failedRun = checkPlan(implemented, {
    ...context,
    gateRuns: [{ gate: 'tests', ok: false, finished_at: '2026-11-08T12:00:00+08:00' }],
  })
  assert.ok(failedRun.some((item) => item.kind === 'tests-missing' && /没有 tests/.test(item.detail)))
  const otherGate = checkPlan(implemented, {
    ...context,
    gateRuns: [{ gate: 'precommit', ok: true, finished_at: '2026-11-08T12:00:00+08:00' }],
  })
  assert.ok(otherGate.some((item) => item.kind === 'tests-missing'), '别的门禁的通过记录不能顶替 testGate')
  const noRuns = checkPlan(implemented, { ...context, gateRuns: [] })
  assert.ok(noRuns.some((item) => item.kind === 'tests-missing'))

  // requireTests=false 或 testGate 关掉时不做这项检查。
  const notRequired = checkPlan(implemented, { ...context, requireTests: false, gateRuns: [] })
  assert.equal(notRequired.some((item) => item.kind === 'tests-missing'), false)
  const gateOff = checkPlan(implemented, {
    ...context,
    contract: { description: { ...CONTRACT.description, testGate: '' } },
    gateRuns: [],
  })
  assert.equal(gateOff.some((item) => item.kind === 'tests-missing'), false)
})

// ------------------------------------------------------ 汇总 / 渲染

test('summarize：files/modules/described/missingSemantics 计数', () => {
  const records = [
    {
      path: 'lib/a.mjs',
      semantics: '文件 a 的语义描述文本。',
      modules: [
        { id: 'a', semantics: '模块 a 的语义描述文本。', members: ['x'] },
        { id: 'b', semantics: '', members: ['y'] },
      ],
    },
    { path: 'lib/b.mjs', semantics: '', modules: [] },
    { path: 'lib/c.mjs', semantics: '文件 c 的语义描述文本。', modules: [] },
  ]
  const stats = summarize(records)
  assert.equal(stats.files, 3, '正例：三条记录')
  assert.equal(stats.modules, 2)
  assert.equal(stats.described, 2)
  assert.equal(stats.missingSemantics, 2, '缺语义的单元 = 文件 b（1）+ 模块 b（1）')

  assert.deepEqual(summarize([]), { files: 0, modules: 0, described: 0, missingSemantics: 0 })
  // 语义下限可调：把阈值提到 12，两个原本合格的文件也变缺。
  assert.equal(summarize(records, { minSemanticsChars: 14 }).described, 0)
})

test('renderMarkdown：确定性、含两张 mermaid、无墙钟时间', () => {
  const root = tempRoot({
    'lib/a.mjs': [
      "import './b.mjs'",
      '// ---- store',
      'export function loadThing() { return helper() }',
      '// ---- impl',
      'export function helper() { return 1 }',
      '',
    ].join('\n'),
    'lib/b.mjs': 'export function beta() { return 2 }\n',
  })
  const scannedMap = scanMapOf(root, ['lib/a.mjs', 'lib/b.mjs'])
  const recordA = applyPatch(
    createRecord(scannedMap.get('lib/a.mjs'), { now: NOW }),
    {
      path: 'lib/a.mjs',
      semantics: '文件 a 的语义描述文本。',
      modules: [
        { id: 'store', semantics: '模块 store 的语义描述文本。', members: ['loadThing'] },
        { id: 'impl', semantics: '模块 impl 的语义描述文本。', members: ['helper'] },
      ],
    },
    scannedMap.get('lib/a.mjs')
  ).record
  const recordB = applyPatch(
    createRecord(scannedMap.get('lib/b.mjs'), { now: NOW }),
    {
      path: 'lib/b.mjs',
      semantics: '文件 b 的语义描述文本。',
      modules: [{ id: 'b', semantics: '模块 b 的语义描述文本。', members: ['beta'] }],
    },
    scannedMap.get('lib/b.mjs')
  ).record
  const project = { name: 'render-fixture', semantics: PROJECT_SEMANTICS, generated_at: NOW }

  const first = renderMarkdown(project, [recordA, recordB])
  const second = renderMarkdown(project, [recordA, recordB])
  // 正例：两次逐字节相等；输入顺序打乱也一样。
  assert.equal(first, second)
  assert.equal(renderMarkdown(project, [recordB, recordA]), first)

  // 骨架与两张 mermaid（文件关系图 + 模块图）。
  assert.match(first, /^# 项目描述：render-fixture\n/)
  assert.match(first, /> 文件 2 ｜ 模块 3 ｜ 未描述 0/)
  assert.match(first, /^## 1 项目语义$/m)
  assert.ok(first.includes(PROJECT_SEMANTICS))
  const fences = first.split('```mermaid').length - 1
  assert.ok(fences >= 2, `应至少两张 mermaid，实际 ${fences}`)
  assert.match(first, /^graph LR$/m)
  assert.match(first, /subgraph lib$/m)
  assert.match(first, /n0 --> n1/, '文件关系图应画出 lib/a.mjs → lib/b.mjs')
  // 只验成员资格，不钉顺序（顺序本身不是被保护的性质，见 t-20261107-no-literal-order）。
  assert.match(first, /m0\["store"\]/, '模块图应带 store 模块标签')
  assert.match(first, /m1\["impl"\]/, '模块图应带 impl 模块标签')
  assert.match(first, /-->/, '模块图应画模块之间的边')
  // 表格：模块 / 语义 / 成员（模块按记录顺序）。
  assert.match(first, /^\| 模块 \| 语义 \| 成员 \|$/m)
  assert.match(first, /^\|---\|---\|---\|$/m)
  assert.match(first, /\| store \| 模块 store 的语义描述文本。 \| loadThing \|/)
  // 文件按 path 排序。
  assert.ok(first.indexOf('### 3.1 lib/a.mjs') < first.indexOf('### 3.2 lib/b.mjs'))

  // 反例：渲染里不能出现墙钟时间。
  assert.ok(!/生成时间|当前时间|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(first), '渲染不得包含时间戳')

  // 未描述的项目/文件用占位符，而不是空行。
  const bare = renderMarkdown({ name: 'bare', semantics: '' }, [{ path: 'lib/x.mjs', semantics: '', modules: [] }])
  assert.match(bare, /（未描述）/)
  assert.match(bare, /（无模块）/)
})
