// T-20261108 · D1：源码扫描器 `lib/source-scan.mjs` 的行为守护。
//
// 扫描器是描述台账（D2 `lib/desc.mjs`）的地基：模块成员归属、模块边都从它
// 的 `imports` / `declarations.identifiers` 推导。它一旦「静默返回空数组」，
// 下游所有否定断言都会假绿，所以本文件的每个用例都**先断言正例**（确实解析
// 出 >0 条 import / 声明），再断言不该出现的条目。
//
// 覆盖的坑（都是词法近似扫描器的经典陷阱）：
//   - 注释里的假 import、字符串里的假 import、转义字符串；
//   - 模板串（含 `${}` 插值里的花括号与假 import）；
//   - 多行 / 超长（> 4000 字符）导入子句、TS `import type`、`export { x } from`、
//     `export * as ns from`；
//   - `import('./x')` 与 `import.meta`、`obj.import(…)` 的区分；
//   - 本地 export 列表（`export { a, b as c }`）对 exported 的标记；
//   - CRLF 行号、非字符串 text 抛 FlowError；
//   - 顶层判定（嵌套函数、`for (const …)`、函数表达式里的名字都不算声明）；
//   - 声明区间（到下一个顶层声明为止）与 identifiers（剔除属性访问与自身名）；
//   - Python 的 def / async def / class / 顶层赋值与三种 import 语句；
//   - 其它语言落成 `unknown`；唯一 lib 依赖是 `./util.mjs` 的 FlowError。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { languageOf, scanSource } from '../lib/source-scan.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SELF = path.join(REPO, 'lib', 'source-scan.mjs')

const specsOf = (scan) => scan.imports.map((entry) => entry.specifier)
const namesOf = (scan) => scan.declarations.map((entry) => entry.name)

// ------------------------------------------------------------ languageOf

test('languageOf：js 家族 / python / 其它语言为 null', () => {
  for (const ext of ['mjs', 'js', 'cjs', 'ts', 'tsx', 'jsx']) {
    assert.equal(languageOf(`lib/x.${ext}`), 'js', `.${ext} 应归 js`)
  }
  assert.equal(languageOf('scripts/tool.py'), 'python')
  assert.equal(languageOf('lib/x.MJS'), 'js', '扩展名应大小写不敏感')

  for (const other of ['README.md', 'lib/x.json', 'Makefile', '.gitignore', 'lib/x.pyc', '']) {
    assert.equal(languageOf(other), null, `${other || '<空>'} 不应被判成可扫描语言`)
  }
  // 点文件与无扩展名不能被当成「有扩展名」。
  assert.equal(languageOf('.mjs'), null)
  assert.equal(languageOf('a/b.c/d'), null)
})

// -------------------------------------------------------------- JS import

test('JS import：注释与字符串里的假 import 不误伤（先证正例）', () => {
  const src = [
    "import './side-effect.mjs'",
    "import def, { named } from './named.mjs'",
    "import * as ns from './star.mjs'",
    '// import fake from "./line-comment.mjs"',
    '/* import fake2 from "./block-comment.mjs" */',
    'const text = "import fake3 from \'./string.mjs\'"',
    "const multi = 'line1\\n// import fake4 from \"./escaped.mjs\"'",
  ].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)

  assert.equal(scan.language, 'js')
  // 正例：三条真语句必须都在（否则下面的否定断言是空集合假绿）。
  assert.ok(scan.imports.length >= 3, `真 import 一条都没解析出来：${scan.imports.length}`)
  assert.deepEqual(specsOf(scan), ['./side-effect.mjs', './named.mjs', './star.mjs'])
  assert.deepEqual(
    scan.imports.map((entry) => entry.kind),
    ['side-effect', 'static', 'static'],
    'import kind 判定错误'
  )
  // 否定：注释/字符串里的 specifier 一个都不许出现。
  for (const fake of ['./line-comment.mjs', './block-comment.mjs', './string.mjs', './escaped.mjs']) {
    assert.ok(!specsOf(scan).includes(fake), `注释/字符串里的假 import 被当真：${fake}`)
  }
  // offset 必须单调递增（文档序），下游按它排序/取样。
  const offsets = scan.imports.map((entry) => entry.offset)
  assert.deepEqual([...offsets].sort((left, right) => left - right), offsets, 'import offset 不是文档序')
  assert.equal(offsets[0], 0, '首条 import 的 offset 应为 0')
})

test('JS import：多行 import 子句也能解析出 specifier', () => {
  const src = [
    'import {',
    '  alpha,',
    '  beta as gamma,',
    '} from "./multiline.mjs"',
    'import tail from "./after.mjs"',
  ].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)

  assert.ok(scan.imports.length > 0, '多行 import 一条都没解析出来')
  assert.deepEqual(specsOf(scan), ['./multiline.mjs', './after.mjs'])
  assert.deepEqual(scan.imports.map((entry) => entry.kind), ['static', 'static'])
})

test('JS import：超长具名导入子句（> 4000 字符）不丢边，也不吃掉后续语句', () => {
  const names = []
  for (let index = 0; index < 500; index += 1) names.push(`member${index}`)
  const clause = `import { ${names.join(', ')} } from './big.mjs'`
  assert.ok(clause.length > 4000, `用例本身必须超过旧的 4000 字符上限：${clause.length}`)

  const src = [clause, "import tail from './tail.mjs'", 'const after = 1'].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)

  // 正例：长列表本身必须成边（旧实现的 4000 字符栅栏在这里静默返回 null）。
  assert.deepEqual(specsOf(scan), ['./big.mjs', './tail.mjs'], '超长导入子句被静默丢弃')
  assert.deepEqual(scan.imports.map((entry) => entry.kind), ['static', 'static'])
  assert.deepEqual(namesOf(scan), ['after'], '长 import 子句之后的声明没被继续扫描')
})

test('JS import：export { x } from / export * as ns / export * 记成 reexport', () => {
  const src = [
    "export { a } from './reexport.mjs'",
    "export * as ns from './star.mjs'",
    "export * from './all.mjs'",
    'export { localOnly }',
    'export const inline = 1',
  ].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)

  assert.ok(scan.imports.length >= 3, `export-from 一条都没解析出来：${scan.imports.length}`)
  assert.deepEqual(specsOf(scan), ['./reexport.mjs', './star.mjs', './all.mjs'])
  assert.deepEqual(
    scan.imports.map((entry) => entry.kind),
    ['reexport', 'reexport', 'reexport']
  )
  // 本地 re-export 与内联 export const 不是模块边。
  assert.ok(!specsOf(scan).includes('localOnly'), 'export { localOnly } 不是 import 边')
  assert.deepEqual(namesOf(scan), ['inline'], 'export const 应同时产生一条声明')
  assert.equal(scan.declarations[0].exported, true)
})

test('TS：import type / import type from / export type { … } from 仍然算边', () => {
  const src = [
    "import type { Alpha, Beta as Gamma } from './types.mjs'",
    "import type Delta from './delta.mjs'",
    "import type from './shadow.mjs'",
    "export type { Epsilon } from './epsilon.mjs'",
    'export type { Local }',
    'interface Local {}',
  ].join('\n')
  const scan = scanSource('lib/fixture.ts', src)

  assert.equal(scan.language, 'js', 'TS 家族统一归 js')
  // 正例：四条 import 语句都必须解析出来（否则否定断言是空集合假绿）。
  assert.ok(scan.imports.length >= 4, `TS import 一条都没解析出来：${scan.imports.length}`)
  assert.deepEqual(specsOf(scan), ['./types.mjs', './delta.mjs', './shadow.mjs', './epsilon.mjs'])
  assert.deepEqual(
    scan.imports.map((entry) => entry.kind),
    ['static', 'static', 'static', 'reexport'],
    '`import type from` 是默认导入（static）；export … from 才是 reexport'
  )
  // `export type { Epsilon } from` 是 reexport：远端名字不该变成本地声明。
  assert.ok(!namesOf(scan).includes('Epsilon'), 'reexport 的远端名字被当成声明')
  assert.ok(!namesOf(scan).includes('Local'), 'export type / interface 不是 JS 声明')
})

test('JS import：动态 import 与 import.meta 区分开', () => {
  const src = [
    "const lazy = import('./dynamic.mjs')",
    'const meta = import.meta.url',
    'const computed = import(`./tpl-${name}.mjs`)',
    'const runtime = import(someName)',
  ].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)

  // 正例：字面量动态 import 必须被抓到。
  assert.ok(scan.imports.length >= 1, '动态 import 一条都没解析出来')
  assert.deepEqual(
    scan.imports.map((entry) => [entry.kind, entry.specifier]),
    [['dynamic', './dynamic.mjs']],
    'import()/import.meta 判定错误（非字面量与 import.meta 都不算边）'
  )
  assert.ok(!specsOf(scan).some((specifier) => specifier.includes('meta')), 'import.meta 被当成模块边')
})

test('JS import：obj.import() / 方法名 import 不产生 dynamic 边（真 import() 仍收）', () => {
  const src = [
    "const direct = import('./direct.mjs')",
    "const viaMember = registry.import('./member.mjs')",
    "const viaOptional = registry?.import('./optional.mjs')",
    'class Loader { import(target) { return target } }',
    "const asProperty = { import: './property.mjs' }",
    'const bare = registry.import',
  ].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)

  // 正例：语句/表达式位置的动态 import 必须还在（否则否定断言是空集合假绿）。
  assert.ok(scan.imports.length >= 1, '动态 import 一条都没解析出来')
  assert.deepEqual(
    scan.imports.map((entry) => [entry.kind, entry.specifier]),
    [['dynamic', './direct.mjs']],
    '属性名/方法名 import 被当成了模块边'
  )
  for (const fake of ['./member.mjs', './optional.mjs', './property.mjs']) {
    assert.ok(!specsOf(scan).includes(fake), `属性名 import 被当成边：${fake}`)
  }
  assert.ok(namesOf(scan).includes('Loader'), 'class Loader 应被解析出来')
})

test('JS import：模板串与转义不误伤，且不遮挡后续真 import', () => {
  const src = [
    'const tpl = `',
    "import fake from './tpl.mjs'",
    '${ { a: 1 }.a }',
    '`',
    "import real from './real.mjs'",
  ].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)

  assert.ok(scan.imports.length >= 1, '模板串之后的真 import 没被解析出来')
  assert.deepEqual(specsOf(scan), ['./real.mjs'], '模板串内容被当成了 import')
  assert.ok(namesOf(scan).includes('tpl'), '模板串声明没被解析出来')
})

// --------------------------------------------------------------- JS 声明

test('JS 声明：只收顶层（嵌套函数 / for-const / 函数表达式名都不算）', () => {
  const src = [
    'const top = 1',
    'function outer() {',
    '  function inner() {}',
    '  return inner',
    '}',
    'for (const loop of items) { }',
    'const expr = function hidden() {}',
    'export class Widget { method() {} }',
    'export default function named() {}',
  ].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)

  // 正例：顶层声明必须解析出来。
  assert.ok(scan.declarations.length >= 5, `顶层声明没解析出来：${scan.declarations.length}`)
  assert.deepEqual(namesOf(scan), ['top', 'outer', 'expr', 'Widget', 'named'])
  assert.deepEqual(
    scan.declarations.map((entry) => entry.kind),
    ['const', 'function', 'const', 'class', 'function']
  )
  assert.deepEqual(
    scan.declarations.map((entry) => entry.exported),
    [false, false, false, true, true],
    'export / export default 的 exported 判定错误'
  )
  for (const nested of ['inner', 'loop', 'hidden', 'method']) {
    assert.ok(!namesOf(scan).includes(nested), `非顶层名字被当成声明：${nested}`)
  }
})

test('JS 声明：区间 = 起点到下一个顶层声明起点（endLine 不含尾部空行）', () => {
  const src = [
    'function alpha() {', // 1
    '  return 1', // 2
    '}', // 3
    '', // 4
    'const BETA = 2', // 5
    '', // 6
    'export function gamma() {', // 7
    '  return 3', // 8
    '}', // 9
  ].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)

  assert.ok(scan.declarations.length >= 3, `声明没解析出来：${scan.declarations.length}`)
  assert.deepEqual(
    scan.declarations.map((entry) => [entry.name, entry.startLine, entry.endLine]),
    [
      ['alpha', 1, 3],
      ['BETA', 5, 5],
      ['gamma', 7, 9],
    ]
  )
  // 区间必须单调、不重叠，且落在文件行范围内。
  const lines = src.split('\n').length
  for (let index = 0; index < scan.declarations.length; index += 1) {
    const current = scan.declarations[index]
    assert.ok(current.startLine <= current.endLine, `${current.name} 的区间反了`)
    assert.ok(current.endLine <= lines, `${current.name} 的 endLine 越界`)
    if (index > 0) {
      assert.ok(
        scan.declarations[index - 1].endLine < current.startLine,
        '相邻声明的区间重叠了'
      )
    }
  }
})

test('JS 声明：identifiers 剔除属性访问、自身名字、注释与字符串内容', () => {
  const src = [
    '// fakeName in comment',
    'function load(state) {',
    "  const label = 'hiddenName'",
    '  return read(state.items) + helper(state) + state.value',
    '}',
  ].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)
  const declaration = scan.declarations.find((entry) => entry.name === 'load')

  assert.ok(declaration, '声明 load 没被解析出来')
  // 正例：区间内确实收到了标识符。
  assert.ok(declaration.identifiers.length > 0, 'identifiers 一条都没收到')
  for (const expected of ['read', 'helper', 'state', 'label']) {
    assert.ok(declaration.identifiers.includes(expected), `漏了区间内标识符：${expected}`)
  }
  for (const excluded of ['load', 'items', 'value', 'hiddenName', 'fakeName', 'return', 'function']) {
    assert.ok(!declaration.identifiers.includes(excluded), `identifiers 不该包含：${excluded}`)
  }
  // 去重 + 稳定排序（默认码元序）。
  assert.deepEqual([...new Set(declaration.identifiers)], declaration.identifiers, 'identifiers 有重复')
  assert.deepEqual([...declaration.identifiers].sort(), declaration.identifiers, 'identifiers 未排序')
})

test('JS 声明：本地 export 列表（export { a, b as c }）把本地声明标成 exported', () => {
  const src = [
    'function alpha() {}',
    'const beta = 1',
    'class Gamma {}',
    'function internal() {}',
    'export { alpha, beta as renamed }',
    'export { Gamma }',
    "export { remote as imported } from './remote.mjs'",
    "export * as namespace from './ns.mjs'",
  ].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)

  assert.ok(scan.declarations.length >= 4, `声明没解析出来：${scan.declarations.length}`)
  assert.deepEqual(namesOf(scan), ['alpha', 'beta', 'Gamma', 'internal'])
  assert.deepEqual(
    scan.declarations.map((entry) => entry.exported),
    [true, true, true, false],
    '`b as c` 标记本地名 b；`export … from` 是 reexport，不改本地标志'
  )
  // reexport 仍是模块边，但不产生本地声明、也不标记远端名/别名。
  assert.deepEqual(specsOf(scan), ['./remote.mjs', './ns.mjs'])
  assert.ok(!namesOf(scan).includes('remote'), 'reexport 的远端名字被当成声明')
  assert.ok(!namesOf(scan).includes('renamed'), 'export 别名不是本地声明')

  // 顺序无关：export 列表写在声明之前也要能标记。
  const forward = scanSource('lib/forward.mjs', ['export { later }', 'const later = 2'].join('\n'))
  assert.deepEqual(namesOf(forward), ['later'])
  assert.equal(forward.declarations[0].exported, true, '本地 export 列表应顺序无关')
})

test('JS：正则字面量里的引号/花括号不破坏后续扫描', () => {
  const src = [
    'const UNSAFE_RE = /[<>:"|?*]/g',
    'const PAIR_RE = /a{2}/',
    'function after() { return UNSAFE_RE }',
  ].join('\n')
  const scan = scanSource('lib/fixture.mjs', src)

  // 正例：正则之后的声明必须还在（正则里的引号曾把后面整个文件吞掉）。
  assert.deepEqual(namesOf(scan), ['UNSAFE_RE', 'PAIR_RE', 'after'])
  assert.deepEqual(scan.imports, [], '正则字面量里不该产生 import')
})

test('CRLF：行号只按 \\n 计数（\\r 不额外换行），offset 是原始字符偏移', () => {
  const src = [
    'const first = 1', // 1
    'function second() {', // 2
    '  return first', // 3
    '}', // 4
    'export function third() {}', // 5
  ].join('\r\n')
  const scan = scanSource('lib/crlf.mjs', src)

  assert.ok(scan.declarations.length >= 3, `CRLF 声明没解析出来：${scan.declarations.length}`)
  assert.deepEqual(
    scan.declarations.map((entry) => [entry.name, entry.startLine, entry.endLine]),
    [
      ['first', 1, 1],
      ['second', 2, 4],
      ['third', 5, 5],
    ],
    'CRLF 下的行号/区间判定错误'
  )
  assert.equal(scan.declarations[2].exported, true)

  const firstLine = "import a from './a.mjs'"
  const secondLine = "import b from './b.mjs'"
  const imports = scanSource('lib/crlf-imports.mjs', [firstLine, secondLine].join('\r\n'))
  assert.deepEqual(specsOf(imports), ['./a.mjs', './b.mjs'])
  assert.deepEqual(
    imports.imports.map((entry) => entry.offset),
    [0, firstLine.length + 2],
    'offset 不该把 \\r 当换行而漂移'
  )
})

// ------------------------------------------------------------------ Python

test('Python：def / async def / class / 顶层赋值与三种 import 语句', () => {
  const src = [
    'import os',
    'import sys as system, json',
    'from .pkg import thing',
    'from .. import other',
    'from . import sibling',
    '',
    'CONST = 1',
    '',
    'def plain(a):',
    '    return a',
    '',
    'async def coro(b):',
    '    return b',
    '',
    'class Widget(Base):',
    '    pass',
    '',
  ].join('\n')
  const scan = scanSource('scripts/fixture.py', src)

  assert.equal(scan.language, 'python')
  // 正例：import 与声明都必须非空。
  assert.ok(scan.imports.length >= 5, `Python import 没解析出来：${scan.imports.length}`)
  assert.deepEqual(specsOf(scan), ['os', 'sys', 'json', '.pkg', '..', '.'])
  assert.deepEqual(
    scan.imports.map((entry) => entry.kind),
    ['static', 'static', 'static', 'static', 'static', 'static']
  )
  assert.ok(scan.declarations.length >= 4, `Python 声明没解析出来：${scan.declarations.length}`)
  assert.deepEqual(namesOf(scan), ['CONST', 'plain', 'coro', 'Widget'])
  assert.deepEqual(
    scan.declarations.map((entry) => entry.kind),
    ['const', 'function', 'function', 'class']
  )
  assert.deepEqual(
    scan.declarations.map((entry) => entry.exported),
    [true, true, true, true],
    'Python 没有导出语法：公开名（不以 _ 开头）记 exported'
  )
})

test('Python：注释与 docstring 里的假 import 不误伤；identifiers 与缩进块区间', () => {
  const src = [
    '"""Module docstring.', // 1
    '', // 2
    'import fake_module', // 3
    '"""', // 4
    '# import fake_comment', // 5
    'def handler(a, b=2):', // 6
    '    """doc"""', // 7
    '    obj.field = a', // 8
    '    return helper(b)', // 9
    '', // 10
    'class Thing(Base):', // 11
    '    attr = 1', // 12
    '', // 13
    '    def method(self):', // 14
    '        self.other = 2', // 15
    '        return self.attr', // 16
    '',
  ].join('\n')
  const scan = scanSource('scripts/fixture.py', src)

  // 正例：真声明要解析出来（否则否定断言是空集合假绿）。
  assert.ok(scan.declarations.length >= 2, `Python 声明没解析出来：${scan.declarations.length}`)
  assert.deepEqual(namesOf(scan), ['handler', 'Thing'])
  assert.deepEqual(scan.imports, [], 'docstring / 注释里的 import 被当真')

  const handler = scan.declarations[0]
  assert.deepEqual([handler.startLine, handler.endLine], [6, 9], 'def 块区间按缩进判定')
  for (const expected of ['a', 'b', 'obj', 'helper']) {
    assert.ok(handler.identifiers.includes(expected), `漏了块内标识符：${expected}`)
  }
  assert.ok(!handler.identifiers.includes('field'), '属性访问 .field 不该进 identifiers')
  assert.ok(!handler.identifiers.includes('handler'), '声明自身名字不该进 identifiers')

  const thing = scan.declarations[1]
  assert.ok(thing.identifiers.includes('method'), 'class 块内的 def 名应在 identifiers 里')
  assert.ok(thing.identifiers.includes('attr'), 'class 体的赋值名应在 identifiers 里')
  assert.ok(!thing.identifiers.includes('self'), 'self 是噪声词，不该进 identifiers')
  assert.ok(!thing.identifiers.includes('other'), 'self.other 是属性访问，不该进 identifiers')
})

test('Python：顶层赋值排除比较/增强赋值，多行字面量算进块区间', () => {
  const src = [
    'X = [', // 1
    '    1,', // 2
    ']', // 3
    'if X == [1]:', // 4
    '    Y = 2', // 5
    'Z: dict = {}', // 6
    'X += 1', // 7
  ].join('\n')
  const scan = scanSource('scripts/fixture.py', src)

  assert.deepEqual(namesOf(scan), ['X', 'Z'])
  assert.deepEqual(scan.declarations[0].endLine, 3, '多行字面量的闭括号应算进区间')
})

// ------------------------------------------------------------------ 其它

test('未知语言：language 为 unknown，imports/declarations 为空数组', () => {
  const scan = scanSource('docs/notes.md', "import fake from './x.mjs'\ndef fake():\n")
  assert.deepEqual(scan, { language: 'unknown', imports: [], declarations: [] })
  // 空文本同样不抛错。
  assert.deepEqual(scanSource('lib/empty.mjs', ''), { language: 'js', imports: [], declarations: [] })
})

test('scanSource：非字符串 text 抛 FlowError(invalid)，不静默降级为空串', () => {
  const isInvalidStringError = (error) =>
    error.name === 'FlowError' &&
    error.code === 'invalid' &&
    /scanSource expects a string/.test(error.message)

  for (const bad of [null, undefined, 42, {}, [], Buffer.from('x')]) {
    assert.throws(
      () => scanSource('lib/fixture.mjs', bad),
      isInvalidStringError,
      `非字符串 text 未抛 FlowError：${String(bad)}`
    )
  }
  // 语言判定之前就拒绝：未知语言同样不许静默返回空结果。
  assert.throws(() => scanSource('docs/notes.md', null), isInvalidStringError)
  assert.throws(() => scanSource('scripts/fixture.py', 123), isInvalidStringError)
  // 空串仍是合法输入——「没内容」与「类型错」必须分开。
  assert.deepEqual(scanSource('lib/empty.mjs', ''), { language: 'js', imports: [], declarations: [] })
})

test('残缺源码不抛错（未闭合字符串 / 括号 / 注释）', () => {
  const broken = [
    'const x = "unterminated',
    'function f( {',
    '`${',
    '/* open comment',
    'const re = /abc',
  ]
  for (const snippet of broken) {
    assert.doesNotThrow(() => scanSource('lib/broken.mjs', snippet), `JS 残缺源码抛错：${snippet}`)
  }
  for (const snippet of ['def f(:', '"""open', 'from . import (']) {
    assert.doesNotThrow(() => scanSource('scripts/broken.py', snippet), `Python 残缺源码抛错：${snippet}`)
  }
})

test('依赖：只 import ./util.mjs 的 FlowError，自扫描能认出公开接口', () => {
  const text = fs.readFileSync(SELF, 'utf8')
  const scan = scanSource('lib/source-scan.mjs', text)

  // 正例：自扫描必须认出两个公开入口（防止「扫描器对自己返回空」的假绿）。
  assert.ok(scan.declarations.length >= 2, `自扫描没解析出声明：${scan.declarations.length}`)
  for (const name of ['languageOf', 'scanSource']) {
    const declaration = scan.declarations.find((entry) => entry.name === name)
    assert.ok(declaration, `自扫描漏了公开接口：${name}`)
    assert.equal(declaration.kind, 'function')
    assert.equal(declaration.exported, true, `${name} 应标记为 exported`)
  }

  // 唯一依赖：`./util.mjs` 的 FlowError。util 是零依赖叶子且不反向 import，
  // 依赖图 `util ← source-scan ← desc` 仍无环；node: 内置与 re-export 都不许有。
  assert.deepEqual(
    scan.imports.map((entry) => [entry.kind, entry.specifier]),
    [['static', './util.mjs']],
    'source-scan 只应 import ./util.mjs'
  )
  assert.doesNotMatch(text, /^\s*import\s+[^;\n]*\bfrom\s+['"]node:/m, '不应依赖 node: 内置')
  assert.doesNotMatch(text, /^\s*export\s+[^;\n]*\bfrom\b/m, '出现 export … from 语句')
})
