// CONTRACT §1.1「代码模块职责」的防漂移守卫。
//
// 为什么需要它：§1.1 是一张**手写模块表**，而手写清单必然漂移——新增一个 lib 模块
// 却忘了写进表里，下一个人读 CONTRACT 就会以为它不存在。本会话已经因为"手写数字/
// 清单过期"栽过三次（README 用例数 389→394→402→411、check list 五项、`--root` 位置）。
// 所以这张表也要有可执行的真值来源：`lib/*.mjs` 的实际文件列表。
//
// 只断言"表覆盖了实际文件"和"表里没有幽灵行"，**不**断言每行的措辞——描述文字会被
// 人改写，那是正常的；文件名不会。

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** §1.1 小节正文：从 `### 1.1` 到下一个同级或更高级标题。 */
function moduleSection() {
  const text = readFileSync(path.join(REPO, 'CONTRACT.md'), 'utf8')
  const start = text.indexOf('### 1.1 ')
  assert.ok(start > 0, 'CONTRACT 找不到 `### 1.1 代码模块职责`')
  const rest = text.slice(start)
  const end = rest.search(/\n## (?!#)/)
  return end === -1 ? rest : rest.slice(0, end)
}

/** `lib/` 顶层的实际模块文件名（不含子目录，子目录在表里用通配行表示）。 */
function actualLibModules() {
  return readdirSync(path.join(REPO, 'lib'))
    .filter((name) => name.endsWith('.mjs'))
    .sort()
}

test('§1.1 模块表覆盖 lib/ 下的每一个模块文件', () => {
  const section = moduleSection()
  const actual = actualLibModules()
  // 正例守护：先证明真的读到了文件列表，否则下面的 `filter` 会完美假绿。
  assert.ok(actual.length >= 8, `lib/*.mjs 只读到 ${actual.length} 个，路径或过滤条件坏了`)
  assert.ok(actual.includes('core.mjs'), 'lib/core.mjs 必须在列表里（正例）')

  const missing = actual.filter((name) => section.includes(`lib/${name}`) === false)
  assert.deepEqual(missing, [], `§1.1 模块表漏了这些模块：${missing.join(', ')}`)
})

test('§1.1 模块表不列幽灵模块（写了但 lib/ 下不存在）', () => {
  const section = moduleSection()
  const actual = new Set(actualLibModules())
  // 只抓 `lib/<name>.mjs` 这种确切文件名；`lib/tools/*.mjs` 由模板的 `*` 行覆盖。
  const named = [...section.matchAll(/lib\/([a-z0-9-]+)\.mjs/g)].map((m) => m[1])
  assert.ok(named.length >= 8, `§1.1 只解析出 ${named.length} 个模块名，解析器坏了`)
  const ghosts = [...new Set(named)].filter((name) => actual.has(`${name}.mjs`) === false)
  assert.deepEqual(ghosts, [], `§1.1 列了不存在的模块：${ghosts.join(', ')}`)
})

test('§1.1 记录了三条由测试守着的结构纪律与已知结构债', () => {
  const section = moduleSection()
  // 这三条纪律和那条债是本文件的"为什么存在"；被删掉说明有人以为它们过时了。
  for (const needle of [
    '不得 import `lib/core.mjs`',
    '全 lib 恰好一处',
    '已知结构债',
  ]) {
    assert.ok(section.includes(needle), `§1.1 缺「${needle}」——它是这一节的主要产出之一`)
  }
})
