// T-20261106 · task-15：CONTRACT 的 `check tasks` 文档机器断言。
//
// 背景：`flow check tasks` 是本轮新增的第 7 个检查（只读内置项，bin 特判路由
// core）。文档侧四处没有机器断言——§6.1.3 专节、§5.1 命令树、§6 内置项 JSON
// 清单、以及「`check list` 共七项」的表述；改文档不会红，回退成「六项」也
// 不会红。本文件把四处锁成 includes 正/否定断言（形态照
// test/t-20261105-task-goal-merge.test.mjs 的 A12 与 test/core.test.mjs:2453）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const CONTRACT = path.join(REPO, 'CONTRACT.md')

/** 按标题切片：从 heading 到下一个 boundary（任一缺失即断言失败）。 */
function slice(text, heading, boundary) {
  const start = text.indexOf(heading)
  assert.ok(start >= 0, `CONTRACT 找不到 ${heading}`)
  const end = text.indexOf(boundary, start)
  assert.ok(end > start, `${heading} 到 ${boundary} 之间找不到边界`)
  return text.slice(start, end)
}

test('task-15 A1：§6.1.3 `check tasks` 专节存在且写明只读入口', () => {
  const text = fs.readFileSync(CONTRACT, 'utf8')
  const section = slice(text, '### 6.1.3 `check tasks`（任务格式门禁）', '### 6.2 ')
  assert.ok(
    section.includes('normalizeTaskFormat({fix:false})'),
    '§6.1.3 未写明只读入口 normalizeTaskFormat({fix:false})'
  )
})

test('task-15 A2：§5.1 命令树含 `flow check tasks [--type-map <file.json>]`', () => {
  const text = fs.readFileSync(CONTRACT, 'utf8')
  const tree = slice(text, '### 5.1 命令', '### 5.2 退出码')
  assert.ok(
    tree.includes('flow check tasks [--type-map <file.json>]'),
    '§5.1 命令树缺 flow check tasks [--type-map <file.json>]'
  )
})

test('task-15 A3：`check list` 共七项，且不许残留「共六项」', () => {
  const text = fs.readFileSync(CONTRACT, 'utf8')
  assert.ok(text.includes('`check list` 共七项'), 'CONTRACT 缺「check list 共七项」表述')
  assert.equal(text.includes('共六项'), false, 'CONTRACT 不许残留「共六项」')
})

test('task-15 A4：§6 内置项 JSON 清单含 tasks → lib/core.mjs#normalizeTaskFormat', () => {
  const text = fs.readFileSync(CONTRACT, 'utf8')
  const block = slice(text, '## 6 机械检查', '## 7 core API')
  assert.ok(
    block.includes('{"name":"tasks","interpreter":"core","script":"lib/core.mjs#normalizeTaskFormat"'),
    '§6 内置项清单缺 tasks（interpreter core → lib/core.mjs#normalizeTaskFormat）'
  )
})
