// T-20261106 · P2-2：面板任务行形状（CONTRACT §9.1.4）的机器断言。
//
// 背景：§9.1.4 定稿 15 键并声称「panelTaskRow / host2-tools.taskRowOk / 本节三处逐字一致」，
// 但只有前两处有断言，文档侧没有——改文档、或改其中一处而漏另一处，都没人发现。
// 本文件把「顺序即契约」锁成四个来源的两两一致。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const LIB_DIR = path.join(REPO, 'lib')

/**
 * 全部 `lib/**` 源码按**固定顺序**拼接成的文本（task-56，与 task-51 同一形态）。
 *
 * 这条断言要保护的是「`panelTaskRow` 的返回键序 = §9.1.4 的 15 键」，而**不是**
 * 「它必须住在 `lib/state-snapshot.mjs`」。函数搬去哪个文件是**实现细节**，不是契约；
 * 钉死单文件会让面板投影的任何拆分都必须先改测试，那是把位置当契约。
 *
 * 拼接顺序固定（`core.mjs` 最后），保证同样的实现总得到同样的文本，结论不随
 * 文件系统枚举顺序漂移。
 */
function readLibSource() {
  const files = fs
    .readdirSync(LIB_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .sort()
  const ordered = [...files.filter((name) => name !== 'core.mjs'), ...files.filter((name) => name === 'core.mjs')]
  return ordered.map((name) => fs.readFileSync(path.join(LIB_DIR, name), 'utf8')).join('\n')
}

/** §9.1.4 定稿顺序（也是 `panelTaskRow` 的返回顺序）。 */
const ROW_KEYS = [
  'id', 'type', 'title', 'status', 'owner', 'notes', 'scope',
  'acceptance', 'commits', 'created_at', 'updated_at', 'parent', 'depth', 'stage', 'branch',
]

/** §9.1.5：有工单时追加的第 16 键（dispatch 11 键，顺序即契约）。 */
const DISPATCH_KEYS = ['id', 'round', 'attempt', 'agent', 'role', 'status', 'expiresAt', 'stale', 'orphan', 'outcome', 'closedAt']

/** 从 selftest 源码里按常量名解析 `const NAME = [...]` 的字符串键数组。 */
function readSelftestKeys(src, name) {
  const marker = `const ${name} = [`
  const start = src.indexOf(marker)
  assert.ok(start >= 0, `.selftest/host2-tools.mjs 找不到 ${name} 常量（源码形状变了？）`)
  const end = src.indexOf(']', start)
  assert.ok(end > start, `${name} 常量没有闭合方括号`)
  const keys = [...src.slice(start, end).matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((match) => match[1])
  assert.ok(keys.length > 0, `${name} 常量解析为空（源码形状变了？）`)
  return keys
}

test('P2-2 A1：CONTRACT §9.1.4 逐字写出 15 键且顺序一致', () => {
  const text = fs.readFileSync(path.join(REPO, 'CONTRACT.md'), 'utf8')
  const start = text.indexOf('#### 9.1.4')
  assert.ok(start > 0, 'CONTRACT 找不到 §9.1.4')
  const end = text.indexOf('\n### 9.2', start)
  assert.ok(end > start, '§9.1.4 到 §9.2 之间找不到边界')
  const section = text.slice(start, end)
  // 文档里的键序串跨越换行，先把空白折叠成单空格再比。
  const flat = section.replace(/\s+/g, ' ')
  const expected = ROW_KEYS.join(', ')
  assert.ok(flat.includes(expected), `§9.1.4 未按顺序写出 15 键；期望含：${expected}`)
  // 防回退：定位串出现在 §9.1.4 正文（不是别处），且 recentDone 提及 gate。
  assert.ok(/recentDone/.test(section) && /追加\s*.?gate/.test(section), '§9.1.4 应说明 recentDone 行尾追加 gate')
  assert.ok(/`type` 取记录字段的裁剪值/.test(section), '§9.1.4 应说明 type 是裁剪值')
  assert.ok(/缺失或非字符串一律投影为\s*`''`/.test(flat), "§9.1.4 应写明缺失/非字符串 → ''")
})

test('P2-2 A2：panelTaskRow 的源码键序与 §9.1.4 一致', () => {
  // task-56：读整个 `lib/**` 而不是只读 state-snapshot.mjs —— 位置无关，语义不变。
  const src = readLibSource()
  const start = src.indexOf('function panelTaskRow(')
  assert.ok(start > 0, 'lib 下找不到 panelTaskRow')
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

test('P2-2 A4：host2-tools 的 15 键 + 工单 11 键与 §9.1.5 一致', () => {
  const src = fs.readFileSync(path.join(REPO, '.selftest', 'host2-tools.mjs'), 'utf8')
  const taskKeys = readSelftestKeys(src, 'TASK_ROW_KEYS')
  assert.deepEqual(taskKeys, ROW_KEYS, `TASK_ROW_KEYS 必须与 §9.1.5 的 15 键逐字一致，实际：${taskKeys.join(', ')}`)
  const dispatchKeys = readSelftestKeys(src, 'DISPATCH_ROW_KEYS')
  assert.deepEqual(
    dispatchKeys,
    DISPATCH_KEYS,
    `DISPATCH_ROW_KEYS 必须与 §9.1.5 的 11 键逐字一致，实际：${dispatchKeys.join(', ')}`,
  )

  // taskRowOk 的组装顺序：15 键 → dispatch（有工单才 push）→ gate（recentDone 才 push）。
  const start = src.indexOf('function taskRowOk(')
  assert.ok(start > 0, '.selftest/host2-tools.mjs 找不到 taskRowOk')
  const body = src.slice(start, src.indexOf('\n}', start))
  const steps = [
    'const keys = [...TASK_ROW_KEYS]',
    "if (hasDispatch) keys.push('dispatch')",
    "if (gate) keys.push('gate')",
  ]
  let cursor = -1
  for (const step of steps) {
    const at = body.indexOf(step)
    assert.ok(at > cursor, `taskRowOk 必须按「15 键 → dispatch → gate」组装；缺失或错序：${step}`)
    cursor = at
  }
  assert.ok(
    /JSON\.stringify\(Object\.keys\(row\)\) !== JSON\.stringify\(keys\)/.test(body),
    'taskRowOk 必须比较完整键序（不能只查前缀/至少 15 键）',
  )

  // 文档侧：§9.1.5 必须同时写出 15 键与 dispatch 11 键，并明确 gate 在 dispatch 之后。
  const text = fs.readFileSync(path.join(REPO, 'CONTRACT.md'), 'utf8')
  const docStart = text.indexOf('#### 9.1.5')
  assert.ok(docStart > 0, 'CONTRACT 找不到 §9.1.5')
  const docEnd = text.indexOf('\n### 9.2', docStart)
  assert.ok(docEnd > docStart, '§9.1.5 到 §9.2 之间找不到边界')
  const flat = text.slice(docStart, docEnd).replace(/\s+/g, ' ')
  const rowText = ROW_KEYS.join(', ')
  assert.ok(flat.includes(rowText), `§9.1.5 未按顺序写出 15 键；期望含：${rowText}`)
  const dispatchText = DISPATCH_KEYS.join(', ')
  assert.ok(flat.includes(dispatchText), `§9.1.5 未按顺序写出 dispatch 11 键；期望含：${dispatchText}`)
  assert.ok(/有工单时追加第 16 键\s*`dispatch`/.test(flat), '§9.1.5 应写明「有工单时追加第 16 键 dispatch」')
  assert.ok(/`gate` 在 `dispatch` 之后/.test(flat), '§9.1.5 应写明 recentDone 的 gate 在 dispatch 之后')
})

test('P2-2 A5：行里不许再出现 goal（§3.2 已合并进 title）', () => {
  // 只查「键序串」本身，天然不误伤心跳的 --goal 与 §3.2 的迁移说明。
  const text = fs.readFileSync(path.join(REPO, 'CONTRACT.md'), 'utf8')
  const start = text.indexOf('#### 9.1.4')
  const section = text.slice(start, text.indexOf('\n### 9.2', start))
  const keyLine = section.match(/15 键[\s\S]{0,240}/)?.[0] ?? ''
  assert.ok(keyLine.length > 0, '§9.1.4 找不到「15 键」引导句')
  assert.ok(!/goal/.test(keyLine), `15 键串里不许有 goal：${keyLine}`)
  // 源码侧：panelTaskRow 的键列表里也不许出现 goal。
  const src = fs.readFileSync(path.join(REPO, 'lib', 'state-snapshot.mjs'), 'utf8')
  const body = src.slice(src.indexOf('function panelTaskRow('))
  assert.ok(!/^ {4}goal:/m.test(body.slice(0, 900)), 'panelTaskRow 不许再返回 goal')
})
