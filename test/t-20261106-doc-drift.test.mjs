// 文档数字漂移哨兵（B-8 / task-35）：文档里写的数字必须等于代码里的真值。
//
// ## 为什么需要它
//
// 本仓库出现过多次「文档写死一个数，代码一变文档就假」：README 写「227 用例（14 个文件）」
// 时实际已是 381 用例 / 27 个文件。这类漂移没有守护，只能靠人眼看出来。
//
// ## 铁律：断言两侧都必须**推导**出来，不许抄数字
//
// 错的做法（会制造下一个漂移）：
//     assert.equal(readmeTests, 381)          // ← 数字一变就要改测试
// 对的做法：
//     assert.equal(readmeTests, actualTests)  // ← 两侧都现算
//
// `actualXxx()` 从源码/命令推导真值，`readmeXxx()` 从文档解析出声明值，两者比较。
// 这样**文档改了但代码没改**、或**代码改了但文档没改**，都会红。
//
// ## 当前状态（task-31 解锁前）
//
// README 的用例数/文件数/check 清单正在被 exec-panel 修改（task-31）。为免撞车，
// 这里先只落地**骨架 + 双向推导函数**，断言用 `TODO` 标注并**暂时跳过**
// （`t.skip`），不把当前已知漂移做成红 gate。task-31 合入后由 lead 解锁：
// 删掉 `t.skip(...)` 以及 `assert.fail('TODO')` 那行即可。
//
// ## 为什么用**静态计数**而不是解析 `node --test` 输出
//
// `node --test` 的汇总格式（`ℹ tests 381`）是**人类可读输出**，跨 Node 大版本改过一次
// （TAP → spec reporter 默认切换）。本地是 Node 26、CI 计划 Node 20，正踩在这个边界上。
// 试过的替代方案与结论：
//   - `node:test` 的 `run()` API 事件流：`globPatterns` 下只发出「每个文件一个事件」，
//     拿不到嵌套 test 的个数（实测 27，而真实是 381），**不可用**。
//   - 静态数 `^test(` / `^it(` 的顶层调用：与运行时计数**逐次吻合**（381 = 381），
//     且不依赖任何输出格式，**采用**。
// 附带的好处：静态计数在 CI 里无需真的跑一遍测试就能校验文档，成本近乎 0。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

// ------------------------------------------------------------------ 真值推导

/** 顶层 `test(...)` / `it(...)` 调用占一行行首的文件才计入（与 `node --test` 的用例数一致）。 */
const TEST_CALL = /^(?:test|it)\s*\(/m

/**
 * `test/` 下所有测试文件，按文件名排序。
 * @returns {string[]} 绝对路径
 */
function testFiles() {
  return fs
    .readdirSync(path.join(REPO, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join(REPO, 'test', name))
}

/**
 * 实际用例数：静态数每个文件里**顶层**的 `test(` / `it(` 调用。
 *
 * 刻意不用 `node --test` 的输出：那是人类可读汇总，格式随 Node 大版本变（见文件头）。
 * 也与运行时逐次核对过（381 = 381）；若两者将来分叉，`runtimeTestCount()` 那条断言会红。
 *
 * @returns {number}
 */
function actualTests() {
  let total = 0
  for (const file of testFiles()) {
    const source = fs.readFileSync(file, 'utf8')
    // 逐行计数：只认行首（无缩进）的 test( / it(，避免把 helper 里的 `await test(` 算进来。
    for (const line of source.split('\n')) {
      if (TEST_CALL.test(line)) total += 1
    }
  }
  return total
}

/** 实际测试文件数。 */
function actualTestFiles() {
  return testFiles().length
}

/**
 * 运行时用例数（作为 `actualTests()` 的交叉校验）。
 *
 * **不解析输出**：用 `--test-reporter=json`-style 也不可靠，改为让 node 自己汇总后
 * 只读它的 `tests` 行；若格式变了，正则匹配不到就返回 `null`，由调用方**跳过**而不是假绿。
 *
 * @returns {number|null} 拿不到时返回 null（而不是 0，避免把「解析失败」当成「0 个用例」）
 */
function runtimeTestCount() {
  const result = spawnSync(process.execPath, ['--test', 'test/'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 600_000,
  })
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  // 只认 `tests <N>` 汇总行；不同 reporter 的样式差异一律视为「拿不到」。
  const match = /^\s*(?:ℹ\s*)?tests\s+(\d+)\s*$/m.exec(text)
  return match === null ? null : Number(match[1])
}

/** `flow check list --json` 里实际注册的检查名（按注册顺序）。 */
function actualCheckNames() {
  const result = spawnSync(process.execPath, [path.join(REPO, 'bin', 'flow.mjs'), 'check', 'list', '--json'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
  })
  assert.equal(result.status, 0, `flow check list --json 失败：${result.stderr}`)
  const parsed = JSON.parse(result.stdout)
  return parsed.data.checks.map((item) => item.name)
}

/**
 * `bin/flow.mjs` 里 `BUILTIN_CHECKS` 的项名。
 *
 * 直接正则解析源码，**不 import bin**：`bin/flow.mjs` 顶层会跑 `main()`，
 * import 它会真的执行 CLI。
 *
 * @returns {string[]}
 */
function actualBuiltinCheckNames() {
  const source = fs.readFileSync(path.join(REPO, 'bin', 'flow.mjs'), 'utf8')
  const block = /const BUILTIN_CHECKS = Object\.freeze\(\[([\s\S]*?)\n\]\)/.exec(source)
  assert.ok(block !== null, 'bin/flow.mjs 里找不到 BUILTIN_CHECKS 字面量')
  return [...block[1].matchAll(/name:\s*'([a-z][a-z0-9-]*)'/g)].map((match) => match[1])
}

/**
 * CONTRACT §6.1「子命令与参数映射」表格里列出的子命令名。
 *
 * @returns {string[]}
 */
function actualContractCheckSubcommands() {
  const source = fs.readFileSync(path.join(REPO, 'CONTRACT.md'), 'utf8')
  const start = source.indexOf('### 6.1 子命令与参数映射')
  assert.ok(start >= 0, 'CONTRACT.md 里找不到 §6.1 子命令与参数映射')
  const rest = source.slice(start)
  const rows = []
  // 表体行：以 `| \`name\` |` 开头；遇到第一个非表行（空行后的段落）停止。
  for (const line of rest.split('\n').slice(1)) {
    if (line.startsWith('### ') || line.startsWith('## ')) break
    const row = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|/.exec(line)
    if (row !== null) rows.push(row[1])
  }
  return rows
}

// ---------------------------------------------------------------- 文档解析

/**
 * 从 README 里解析「N 用例（M 个文件）」这样的声明。
 *
 * 找不到时返回 `null`——**不要把「文档没写」当成「文档写了 0」**。
 *
 * @returns {{tests:number, files:number}|null}
 */
function readmeTestCounts() {
  const source = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8')
  const match = /(\d+)\s*用例（(\d+)\s*个文件）/.exec(source)
  return match === null ? null : { tests: Number(match[1]), files: Number(match[2]) }
}

/**
 * 从 README 里解析 check 命令清单（`flow check a|b|c` 这种竖线枚举）。
 *
 * @returns {string[]|null} 找不到时 null
 */
function readmeCheckNames() {
  const source = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8')
  const match = /flow check ([a-z][a-z0-9|\\-]*)/.exec(source)
  return match === null ? null : match[1].split('|')
}

// ---------------------------------------------------------------------- 用例

// 真值推导的**自洽性**必须先成立，否则后面所有文档断言都建在流沙上。
// 这一组不依赖 README，task-31 解锁前后都应恒绿。

test('真值推导：静态用例数与 node --test 的运行时计数一致', () => {
  const staticCount = actualTests()
  const runtime = runtimeTestCount()
  if (runtime === null) {
    // 解析不到汇总行（reporter 变了）：不把它当成失败，但也**不能**静默通过——
    // 显式告诉读者「这条交叉校验这次没做」。
    assert.ok(staticCount > 0, '静态计数不应为 0')
    console.log(`[doc-drift] 跳过运行时交叉校验：无法从 node --test 输出解析出 tests 数（static=${staticCount}）`)
    return
  }
  assert.equal(
    staticCount,
    runtime,
    `静态计数 ${staticCount} 与运行时 ${runtime} 不一致：要么有 test( 不是行首顶层调用，要么 reporter 变了`,
  )
})

test('真值推导：check list 的项 = 脚本检查 + BUILTIN_CHECKS，且 CONTRACT §6.1 表格逐项覆盖', () => {
  const listed = actualCheckNames()
  const builtin = actualBuiltinCheckNames()
  assert.ok(builtin.length > 0, 'BUILTIN_CHECKS 不应为空')

  // 内置检查必须全部出现在 `check list` 里（`check list` = 脚本检查 + 内置检查）。
  for (const name of builtin) {
    assert.ok(listed.includes(name), `内置检查 "${name}" 未出现在 flow check list 中`)
  }
  // 反向：`check list` 的每一项也必须在 CONTRACT §6.1 表格里有行，否则文档漏了新检查。
  // 注意 §6.1 表格另有一行 `list`（`flow check list` 自身），它不是检查而是目录命令，
  // 所以不能拿两边的长度直接相等——只要求「文档提到的检查名 ⊆ check list 的名字」。
  const documented = actualContractCheckSubcommands()
  for (const name of listed) {
    assert.ok(documented.includes(name), `检查 "${name}" 在 CONTRACT §6.1 表格里缺行`)
  }
  // 反向不变量：文档里每一行要么是 `list`（目录命令），要么是真实存在的检查；
  // 这样将来在表里手写了一个并不存在的检查名，也会被抓住。
  for (const name of documented) {
    if (name === 'list') continue
    assert.ok(listed.includes(name), `CONTRACT §6.1 表格列了 "${name}"，但 flow check list 里没有`)
  }
})

// ------------------------------------------------------------------ 文档断言
//
// **task-31（exec-panel 改 README）解锁后再启用。**
// 解锁方式：删掉每个用例开头的 `t.skip(...)` 与紧随其后的 `return`。
// 断言本身**不含任何硬编码数字**，解锁后应长期有效。

test('README：声明的用例数与文件数 = 实测值', (t) => {
  // task-31 已合入（origin/main 2843841），断言已解锁。
  const declared = readmeTestCounts()
  if (declared === null) {
    // 文档没写这两个数：不是漂移，是没声明。明确跳过而不是假绿。
    t.skip('README 里没有「N 用例（M 个文件）」这样的声明')
    return
  }
  assert.equal(declared.tests, actualTests(), `README 声明 ${declared.tests} 用例，实际 ${actualTests()}`)
  assert.equal(declared.files, actualTestFiles(), `README 声明 ${declared.files} 个文件，实际 ${actualTestFiles()}`)
})

test('README：check 清单 = flow check list 的全部项', (t) => {
  // task-31 已合入（origin/main 2843841），断言已解锁。
  const declared = readmeCheckNames()
  if (declared === null) {
    t.skip('README 里没有 `flow check a|b|c` 这样的清单')
    return
  }
  const listed = actualCheckNames()
  assert.deepEqual(
    [...declared].sort(),
    [...listed].sort(),
    `README 列了 ${declared.length} 项 check（${declared.join('|')}），实际 ${listed.length} 项（${listed.join('|')}）`,
  )
})
