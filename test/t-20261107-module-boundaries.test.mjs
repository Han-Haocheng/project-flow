// T-20261107 · task-54：把模块边界纪律变成可执行断言。
//
// 背景：三条纪律此前只写在注释里，`test/` 里零守护——
//   1. `lib/checks.mjs` 不 import `lib/core.mjs`（只读检查层不碰 store）；
//   2. `lib/*.mjs` 依赖单向无环；`util.mjs` 是叶子；
//   3. `lib/proc.mjs` 不 import core/checks（task-52 抽出的进程层）。
// 第 1 条已经腐化出真重复：checks 不能 import core，就把「进程树杀灭」重新
// 实现了一遍（与 core 逐字节相同）。本文件用四组断言把边界钉住，并给重复
// 实现上锁（`spawnSync('taskkill'` 全 lib 只能有 1 处，在 proc.mjs）。
//
// 两个刻意的做法（本会话踩过 4 次的坑）：
//   - 只解析真正的 `import` / `export ... from` 语句：先剥注释、再跳过字符串。
//     直接 grep 整个文件会把 `lib/checks.mjs` 注释里那句「不导入 lib/core.mjs」
//     当成违规。
//   - 每组先断言正例（解析出语句 / 图里确实有边），再断言否定。否则解析器
//     坏掉返回空集合时，`assert.equal(violations.length, 0)` 会完美假绿。
//
// `lib/proc.mjs` 在 task-52 落地前不存在：② 与 ④ 用 `t.skip()` 显式跳过并写明
// 原因（不是静默通过），文件出现后自动生效。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const LIB = path.join(REPO, 'lib')
const PROC = path.join(LIB, 'proc.mjs')

const readLib = (name) => fs.readFileSync(path.join(LIB, name), 'utf8')

/** lib/ 下的顶层模块文件（不含 lib/plugin、lib/tools 子目录）。 */
function libFiles() {
  return fs
    .readdirSync(LIB)
    .filter((name) => name.endsWith('.mjs') && fs.statSync(path.join(LIB, name)).isFile())
    .sort()
}

/** `./util.mjs` → `util.mjs`；非同级相对导入（`node:*`、`../x`）→ null。 */
function libTarget(specifier) {
  const match = /^\.\/([^/]+)\.mjs$/.exec(specifier)
  return match ? match[1] + '.mjs' : null
}

// ------------------------------------------------------------- 语法扫描
const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$]/
const isIdentStart = (ch) => ch !== undefined && IDENT_START.test(ch)
const isIdentPart = (ch) => ch !== undefined && IDENT_PART.test(ch)

/** 从开引号位置跳到匹配的闭引号之后；模板串按同规则近似处理（不展开 ${}）。 */
function skipString(src, start) {
  const quote = src[start]
  let i = start + 1
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2
      continue
    }
    if (src[i] === quote) return i + 1
    i++
  }
  return i
}

function skipSpace(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++
  return i
}

function readWord(src, i) {
  let j = i
  while (j < src.length && isIdentPart(src[j])) j++
  return { word: src.slice(i, j), end: j }
}

/**
 * 把注释替换为等长空白，**保留字符串原样**。这样后续语句扫描既不会被注释
 * 里的 `import` 误导，也不会破坏字面量里的内容。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < src.length) {
        out += '  '
        i += 2
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(src, i)
      out += src.slice(i, end)
      i = end
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 解析一个声明（`import` / `export ... from`），返回 {kind, specifier, end} 或 null。 */
function readDeclaration(src, afterKeyword, kind) {
  let i = skipSpace(src, afterKeyword)

  if (kind === 'import') {
    if (src[i] === '(' || src[i] === '.') return null // 动态 import() / import.meta
    if (src[i] === '"' || src[i] === "'") {
      const end = skipString(src, i) // 副作用 import：import './x.mjs'
      return { kind, specifier: src.slice(i + 1, end - 1), end }
    }
    let depth = 0
    const limit = Math.min(src.length, afterKeyword + 4000)
    for (let k = i; k < limit; k++) {
      const ch = src[k]
      if (ch === '"' || ch === "'" || ch === '`') {
        k = skipString(src, k) - 1
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') depth = Math.max(0, depth - 1)
      else if (ch === ';' && depth === 0) return null
      else if (depth === 0 && isIdentStart(ch)) {
        const token = readWord(src, k)
        if (token.word === 'from') {
          const at = skipSpace(src, token.end)
          if (src[at] !== '"' && src[at] !== "'") return null
          const end = skipString(src, at)
          return { kind, specifier: src.slice(at + 1, end - 1), end }
        }
        k = token.end - 1
      }
    }
    return null
  }

  // export：
  if (src[i] === '{') {
    let depth = 0
    let k = i
    for (; k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}') {
        depth--
        if (depth === 0) {
          k++
          break
        }
      }
    }
    i = skipSpace(src, k)
  } else if (src[i] === '*') {
    i = skipSpace(src, i + 1)
    if (src.startsWith('as', i) && !isIdentPart(src[i + 2])) {
      const alias = readWord(src, skipSpace(src, i + 2))
      i = skipSpace(src, alias.end)
    }
  } else {
    return null // export const / export default / export function ...
  }
  if (!src.startsWith('from', i) || isIdentPart(src[i + 4])) return null
  const at = skipSpace(src, i + 4)
  if (src[at] !== '"' && src[at] !== "'") return null
  const end = skipString(src, at)
  return { kind: 'export', specifier: src.slice(at + 1, end - 1), end }
}

/**
 * 解析模块源码里所有静态 import / export-from 的 specifier。
 * 只认真正的语句：注释被剥离，字符串被跳过，`import()` / `import.meta` 不算。
 */
function parseModuleSpecifiers(rawSource) {
  const src = stripComments(rawSource)
  const specs = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(src, i)
      continue
    }
    if (!isIdentStart(ch)) {
      i++
      continue
    }
    const token = readWord(src, i)
    if (token.word === 'import' || token.word === 'export') {
      const found = readDeclaration(src, token.end, token.word)
      if (found) {
        specs.push(found)
        i = found.end
        continue
      }
    }
    i = token.end
  }
  return specs
}

/** 依赖图找环；有环返回 [a, b, ..., a]，无环返回 null。 */
function findCycle(graph) {
  const state = new Map() // 1 = 在栈上，2 = 已完成
  const stack = []
  let cycle = null
  const visit = (node) => {
    state.set(node, 1)
    stack.push(node)
    for (const next of graph.get(node) || []) {
      if (state.get(next) === 1) {
        cycle = [...stack.slice(stack.indexOf(next)), next]
        break
      }
      if (!state.has(next) && graph.has(next)) visit(next)
      if (cycle) break
    }
    stack.pop()
    state.set(node, 2)
  }
  for (const node of graph.keys()) {
    if (!state.has(node)) visit(node)
    if (cycle) break
  }
  return cycle
}

/** task-52 未落地时显式跳过 ② / ④（而不是写死会红或静默通过）。 */
function procPending(t) {
  if (fs.existsSync(PROC)) return false
  t.skip('lib/proc.mjs 尚未落地（task-52）；本断言在文件出现后自动生效')
  return true
}

// ------------------------------------------------------------------ ⓪
test('解析器自检：只认真正的 import/export ... from，注释与字符串不误伤', () => {
  const fixture = [
    "import './side-effect.mjs'",
    "import def, { named } from './named.mjs'",
    "import * as ns from './star.mjs'",
    "export { a } from './reexport.mjs'",
    "export { localOnly }",
    "const lazy = import('./dynamic.mjs')",
    "const meta = import.meta.url",
    "// import fake from './line-comment.mjs'",
    "/* import fake2 from './block-comment.mjs' */",
    "const text = \"import fake3 from './string.mjs'\"",
    'const multi = "line1\\n// import fake4 from \'./escaped.mjs\'"',
  ].join('\n')
  assert.deepEqual(
    parseModuleSpecifiers(fixture).map((entry) => entry.specifier),
    ['./side-effect.mjs', './named.mjs', './star.mjs', './reexport.mjs'],
    '解析器没有精确识别静态 import/export-from（注释、字符串、动态 import 都不应计入）'
  )
  // 多行 import 子句也必须解析出 specifier。
  const multiline = "import {\n  alpha,\n  beta as gamma,\n} from './multiline.mjs'\n"
  assert.deepEqual(parseModuleSpecifiers(multiline).map((entry) => entry.specifier), ['./multiline.mjs'])
  // 反向对照：真正的语句必须被抓到（防止解析器恒返回空数组）。
  assert.equal(parseModuleSpecifiers("import fake from './real.mjs'").length, 1)
})

// ------------------------------------------------------------------ ①
test('① lib/checks.mjs 不 import lib/core.mjs（只读检查层不碰 store）', () => {
  const specs = parseModuleSpecifiers(readLib('checks.mjs'))
  // 正例：解析器必须真的读到语句，否则下面的否定断言是空集合假绿。
  assert.ok(specs.length >= 1, `lib/checks.mjs 一条 import 都没解析出来（解析器坏了？）：${specs.length}`)
  const violations = specs.filter((entry) => libTarget(entry.specifier) === 'core.mjs')
  assert.equal(
    violations.length,
    0,
    `lib/checks.mjs 不得 import lib/core.mjs，实际命中：${violations.map((entry) => entry.specifier).join(', ')}`
  )
})

// ------------------------------------------------------------------ ②
test('② lib/proc.mjs 不 import lib/core.mjs / lib/checks.mjs（反向依赖）', (t) => {
  if (procPending(t)) return
  const specs = parseModuleSpecifiers(readLib('proc.mjs'))
  assert.ok(specs.length >= 1, `lib/proc.mjs 一条 import 都没解析出来（解析器坏了？）：${specs.length}`)
  const violations = specs.filter((entry) => ['core.mjs', 'checks.mjs'].includes(libTarget(entry.specifier)))
  assert.equal(
    violations.length,
    0,
    `lib/proc.mjs 不得反向 import core/checks，实际命中：${violations.map((entry) => entry.specifier).join(', ')}`
  )
})

// ------------------------------------------------------------------ ③
test('③ lib/*.mjs 依赖图无环，util.mjs 是叶子', () => {
  const files = libFiles()
  assert.ok(files.length >= 6, `lib/*.mjs 只找到 ${files.length} 个文件，依赖图不完整`)
  for (const required of ['core.mjs', 'checks.mjs', 'util.mjs']) {
    assert.ok(files.includes(required), `lib/${required} 不在扫描结果里`)
  }

  const graph = new Map(files.map((file) => [file, new Set()]))
  let specCount = 0
  for (const file of files) {
    const specs = parseModuleSpecifiers(readLib(file))
    specCount += specs.length
    for (const entry of specs) {
      const target = libTarget(entry.specifier)
      if (target && graph.has(target)) graph.get(file).add(target)
    }
  }

  const edgeCount = [...graph.values()].reduce((total, targets) => total + targets.size, 0)
  // 正例：图必须真的有边、有语句，否则「无环」是空图假绿。
  assert.ok(specCount >= 10, `lib/*.mjs 只解析出 ${specCount} 条模块语句（解析器坏了？）`)
  assert.ok(edgeCount >= 5, `lib 依赖图只解析出 ${edgeCount} 条边（解析器坏了？）`)
  assert.ok(graph.has('util.mjs'), 'util.mjs 不在依赖图里')
  assert.equal(
    graph.get('util.mjs').size,
    0,
    `util.mjs 必须是叶子，实际 import 了：${[...graph.get('util.mjs')].join(', ')}`
  )

  const cycle = findCycle(graph)
  assert.equal(cycle, null, cycle ? `lib 依赖成环：${cycle.join(' -> ')}` : '')
})

// ------------------------------------------------------------------ ④
test("④ 杀灭进程树只有一个定义处（lib/*.mjs 里 spawnSync('taskkill' 恰好 1 处，在 proc.mjs）", (t) => {
  if (procPending(t)) return
  const files = libFiles()
  assert.ok(files.length >= 6, `lib/*.mjs 只找到 ${files.length} 个文件，杀灭实现的扫描不完整`)

  const hits = []
  for (const file of files) {
    const stripped = stripComments(readLib(file))
    const count = stripped.split("spawnSync('taskkill'").length - 1
    for (let i = 0; i < count; i++) hits.push(file)
  }
  assert.equal(
    hits.length,
    1,
    `lib/*.mjs 里 spawnSync('taskkill' 应恰好 1 处（lib/proc.mjs 的唯一实现），实际 ${hits.length} 处：${hits.join(', ')}`
  )
  assert.equal(hits[0], 'proc.mjs', `杀灭实现应落在 lib/proc.mjs，实际落在 ${hits[0]}`)
})
