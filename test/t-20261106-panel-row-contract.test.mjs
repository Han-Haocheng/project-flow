// T-20261106 · P2-2：面板任务行形状（CONTRACT §9.1.4）的机器断言。
//
// 背景：§9.1.4 定稿 13 键并声称「panelTaskRow / host2-tools.taskRowOk / 本节三处逐字一致」，
// 但只有前两处有断言，文档侧没有——改文档、或改其中一处而漏另一处，都没人发现。
// 本文件把「顺序即契约」锁成四个来源的两两一致。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

/** §9.1.4 定稿顺序（也是 `panelTaskRow` 的返回顺序）。 */
const ROW_KEYS = [
  'id', 'type', 'title', 'status', 'owner', 'notes', 'scope',
  'acceptance', 'commits', 'created_at', 'updated_at', 'parent', 'depth',
]

test('P2-2 A1：CONTRACT §9.1.4 逐字写出 13 键且顺序一致', () => {
  const text = fs.readFileSync(path.join(REPO, 'CONTRACT.md'), 'utf8')
  const start = text.indexOf('#### 9.1.4')
  assert.ok(start > 0, 'CONTRACT 找不到 §9.1.4')
  const end = text.indexOf('\n### 9.2', start)
  assert.ok(end > start, '§9.1.4 到 §9.2 之间找不到边界')
  const section = text.slice(start, end)
  // 文档里的键序串跨越换行，先把空白折叠成单空格再比。
  const flat = section.replace(/\s+/g, ' ')
  const expected = ROW_KEYS.join(', ')
  assert.ok(flat.includes(expected), `§9.1.4 未按顺序写出 13 键；期望含：${expected}`)
  // 防回退：定位串出现在 §9.1.4 正文（不是别处），且 recentDone 提及 gate。
  assert.ok(/recentDone/.test(section) && /追加\s*.?gate/.test(section), '§9.1.4 应说明 recentDone 行尾追加 gate')
  assert.ok(/`type` 取记录字段的裁剪值/.test(section), '§9.1.4 应说明 type 是裁剪值')
  assert.ok(/缺失或非字符串一律投影为\s*`''`/.test(flat), "§9.1.4 应写明缺失/非字符串 → ''")
})

test('P2-2 A2：panelTaskRow 的源码键序与 §9.1.4 一致', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'state-snapshot.mjs'), 'utf8')
  const start = src.indexOf('function panelTaskRow(')
  assert.ok(start > 0, 'state-snapshot 找不到 panelTaskRow')
  const body = src.slice(start, src.indexOf('\n}', start))
  const inner = body.slice(body.indexOf('return {'))
  // 抓返回对象里的顶层键：`    key: expr,` 或 `    key,`（`status` 是简写，没有冒号——
  // 只写 /(\w+):/ 会漏掉它，实测过）。
  const keys = [...inner.matchAll(/^ {4}(\w+)(?::|,)/gm)].map((m) => m[1])
  assert.deepEqual(keys, ROW_KEYS, 'panelTaskRow 的键序漂移了（顺序即契约）')
})

test('P2-2 A3：test 侧 ROW_KEYS 与 §9.1.4 一致（防三处之一漏改）', () => {
  const src = fs.readFileSync(path.join(REPO, 'test', 't-20261104-07-archive-panel.test.mjs'), 'utf8')
  const start = src.indexOf('const ROW_KEYS = [')
  const body = src.slice(start, src.indexOf(']', start))
  const keys = [...body.matchAll(/'(\w+)'/g)].map((m) => m[1])
  assert.deepEqual(keys, ROW_KEYS, 'archive-panel 的 ROW_KEYS 与 §9.1.4 不一致')
})

test('P2-2 A4：host2-tools.taskRowOk 的键序与 §9.1.4 一致', () => {
  const src = fs.readFileSync(path.join(REPO, '.selftest', 'host2-tools.mjs'), 'utf8')
  const start = src.indexOf('function taskRowOk(')
  const body = src.slice(start, src.indexOf('if (gate) keys.push', start))
  const keys = [...body.matchAll(/^ {4}'(\w+)',/gm)].map((m) => m[1])
  assert.deepEqual(keys, ROW_KEYS, 'taskRowOk 的键序与 §9.1.4 不一致')
})

test('P2-2 A5：行里不许再出现 goal（§3.2 已合并进 title）', () => {
  // 只查「键序串」本身，天然不误伤心跳的 --goal 与 §3.2 的迁移说明。
  const text = fs.readFileSync(path.join(REPO, 'CONTRACT.md'), 'utf8')
  const start = text.indexOf('#### 9.1.4')
  const section = text.slice(start, text.indexOf('\n### 9.2', start))
  const keyLine = section.match(/13 键[\s\S]{0,200}/)?.[0] ?? ''
  assert.ok(keyLine.length > 0, '§9.1.4 找不到「13 键」引导句')
  assert.ok(!/goal/.test(keyLine), `13 键串里不许有 goal：${keyLine}`)
  // 源码侧：panelTaskRow 的键列表里也不许出现 goal。
  const src = fs.readFileSync(path.join(REPO, 'lib', 'state-snapshot.mjs'), 'utf8')
  const body = src.slice(src.indexOf('function panelTaskRow('))
  assert.ok(!/^ {4}goal:/m.test(body.slice(0, 900)), 'panelTaskRow 不许再返回 goal')
})
