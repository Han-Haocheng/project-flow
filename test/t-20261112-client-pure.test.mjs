// client.js 前四段纯逻辑的 Node 侧单测（2026-11-12，T-20261112200533 第一步）。
//
// 为什么这样测：client.js 被宿主当**经典脚本**原样下发给浏览器（无 type=module、不打包），
// 所以文件里不能写静态 import，宿主也不会加载第二个 client 文件；同一份代码无法既是
// 运行时脚本又是 ESM 模块。这里用「按 #region 锚点抽取区间 → 写进 os.tmpdir 的临时 .mjs
// （补 export 与少量依赖 stub）→ import」的方式，让这四段第一次有真正的 Node 单测：
//   - locale dictionaries   zh/en 键集合与插值占位符必须一一对应；
//   - defensive helpers     asArray/asText/asNumber/relativeFromSeconds/... 的边界；
//   - state normalization   gate/heartbeat/task/tree 的容错与深度钳制；
//   - icon                  用 React stub 验证 createElement 结构与默认 size。
//
// 运行时零改动、不引入构建步骤、不复制业务代码：抽取失败（锚点丢了/区间变了）测试直接红。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(REPO, 'client.js')
const SOURCE = fs.readFileSync(CLIENT, 'utf8')
const LINES = SOURCE.split('\n')
const TEMP_DIRS = []
const MODULES = new Map()

after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

/** 一个 #region 的区间（0 基，含 region/endregion 两行）。 */
function regionRange(name) {
  const marker = '// #region ' + name
  const start = LINES.findIndex((line) => line.trim() === marker)
  if (start === -1) throw new Error('client.js 找不到 #region ' + name)
  let end = start + 1
  while (end < LINES.length && LINES[end].trim() !== '// #endregion') end += 1
  if (end >= LINES.length) throw new Error('#region ' + name + ' 没有 #endregion')
  return { start, end }
}

function regionText(name) {
  const range = regionRange(name)
  return LINES.slice(range.start + 1, range.end).join('\n')
}

/** 整条 const 声明（支持多行对象字面量）。 */
function constSource(name) {
  const pattern = new RegExp('^    const ' + name + '\\b')
  const start = LINES.findIndex((line) => pattern.test(line))
  if (start === -1) throw new Error('client.js 找不到常量 ' + name)
  let end = start
  while (end < LINES.length && LINES[end].trimEnd().endsWith(';') === false) end += 1
  return LINES.slice(start, end + 1).join('\n')
}

/** 平台无关地写出临时模块并 import。 */
async function loadModule(label, regionNames, prelude) {
  if (MODULES.has(label)) return MODULES.get(label)
  const names = []
  const chunks = [prelude ?? '']
  for (const name of regionNames) {
    const text = regionText(name)
    for (const line of text.split('\n')) {
      const match =
        line.match(/^    (?:async )?function ([A-Za-z0-9_$]+)/) || line.match(/^    (?:const|let|var) ([A-Za-z0-9_$]+)/)
      if (match !== null) names.push(match[1])
    }
    chunks.push('// ---- #region ' + name + '\n' + text)
  }
  const unique = [...new Set(names)]
  chunks.push('export { ' + unique.join(', ') + ' }')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-client-pure-'))
  TEMP_DIRS.push(dir)
  const file = path.join(dir, label + '.mjs')
  fs.writeFileSync(file, chunks.join('\n\n'))
  const loaded = await import(pathToFileURL(file).href)
  MODULES.set(label, loaded)
  return loaded
}

/** 除 locale 区段外，归一化函数依赖的几个模块级常量（原样从 client.js 抽，不再手抄数值）。 */
function commonPrelude() {
  return [
    constSource('MAX_TREE_DEPTH'),
    constSource('TREND_DAY_MS'),
    constSource('STALE_AFTER_SECONDS'),
    constSource('DECISION_COUNT_KEYS'),
    constSource('STAGE_LABEL_KEYS'),
    constSource('TASK_STAGE_GROUPS'),
  ].join('\n')
}

const helpers = () => loadModule('helpers', ['defensive helpers', 'state normalization'], commonPrelude())

test('locale 字典：zh / en 的键集合完全相同，且没有空值', async () => {
  const { zh, en } = await loadModule('locale', ['locale dictionaries'])
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh / en 键集合必须一一对应（双语平衡）')
  assert.ok(zhKeys.length > 100, '字典规模异常：' + zhKeys.length)
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', 'zh.' + key + ' 必须是字符串')
    assert.equal(typeof en[key], 'string', 'en.' + key + ' 必须是字符串')
    assert.notEqual(zh[key].trim(), '', 'zh.' + key + ' 不能为空')
    assert.notEqual(en[key].trim(), '', 'en.' + key + ' 不能为空')
  }
})

test('locale 字典：同一键的插值占位符两侧一致（{n} 之类不能只加在一侧）', async () => {
  const { zh, en } = await loadModule('locale', ['locale dictionaries'])
  const placeholders = (text) => [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort()
  for (const key of Object.keys(zh)) {
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), '占位符不一致：' + key)
  }
})

test('defensive helpers：asArray / asObject / asText / asNumber 的边界', async () => {
  const m = await helpers()
  assert.deepEqual(m.asArray(null), [])
  assert.deepEqual(m.asArray(['a']), ['a'])
  assert.deepEqual(m.asObject(null), {})
  assert.deepEqual(m.asObject([]), {})
  assert.equal(m.asText(null), '')
  assert.equal(m.asText(2), '2')
  assert.equal(m.asText({ a: 1 }), '{"a":1}')
  assert.equal(m.asNumber('3', 0), 3)
  assert.equal(m.asNumber('', 7), 7)
  assert.equal(m.asNumber(Number.NaN, 9), 9)
})

test('defensive helpers：shortSha / absoluteDate / relativeFromSeconds 的分桶', async () => {
  const m = await helpers()
  assert.equal(m.shortSha('abcdef1234567'), 'abcdef1')
  assert.equal(m.shortSha(null), '')
  assert.equal(m.absoluteDate(Date.UTC(2026, 0, 2, 12)), '2026-01-02')
  assert.equal(m.absoluteDate('not-a-date'), null)
  const t = (key, params) => (params === undefined ? key : key + JSON.stringify(params))
  assert.equal(m.relativeFromSeconds(2, t), 'time.justNow')
  assert.equal(m.relativeFromSeconds(30, t), 'time.secondsAgo{"n":30}')
  assert.equal(m.relativeFromSeconds(120, t), 'time.minutesAgo{"n":2}')
  assert.equal(m.relativeFromSeconds(7200, t), 'time.hoursAgo{"n":2}')
  assert.equal(m.relativeFromSeconds(2 * 86400, t), 'time.daysAgo{"n":2}')
  assert.equal(m.relativeFromSeconds(8 * 86400, t), null)
  assert.equal(m.relativeFromSeconds(Number.NaN, t), null)
})

test('defensive helpers：relativeMoment 超过一周退回日历日期', async () => {
  const m = await helpers()
  const t = (key, params) => (params === undefined ? key : key + JSON.stringify(params))
  const now = Date.UTC(2026, 1, 10, 12)
  assert.equal(m.relativeMoment(now - 30000, now, t), 'time.secondsAgo{"n":30}')
  assert.equal(m.relativeMoment(now - 8 * 86400000, now, t), '2026-02-02')
  assert.equal(m.relativeMoment(0, now, t), null)
})

test('state normalization：normalizeGate 容错并归一 lastRun / steps', async () => {
  const m = await helpers()
  const gate = m.normalizeGate({
    id: 'precommit',
    title: '提交前',
    phase: 'commit',
    enabled: true,
    lastRun: {
      started_at: '2026-11-12T10:00:00+08:00',
      ok: true,
      durationMs: 1234,
      steps: [{ id: 'tests', exit: 0, ok: true, tail: 'ok' }, null, 'x'],
    },
  })
  assert.equal(gate.id, 'precommit')
  assert.equal(gate.enabled, true)
  assert.equal(gate.lastRun.ok, true)
  assert.equal(gate.lastRun.durationMs, 1234)
  assert.equal(gate.lastRun.steps.length, 1, '非对象 step 必须被丢弃')
  assert.equal(gate.lastRun.steps[0].id, 'tests')
})

test('state normalization：normalizeGate 缺字段时给出安全默认值', async () => {
  const m = await helpers()
  const gate = m.normalizeGate(null)
  assert.equal(gate.id, '')
  // 缺省视为开启：宿主只有显式 enabled:false 才关（面板的开关语义，别改成默认关）
  assert.equal(gate.enabled, true)
  assert.equal(gate.lastRun, null)
  assert.deepEqual(gate.steps, [])
})

test('state normalization：normalizeTreeNode 在 MAX_TREE_DEPTH 处停止递归', async () => {
  const m = await helpers()
  let node = { id: 'leaf' }
  for (let i = 0; i < 30; i += 1) node = { id: 'n' + i, children: [node] }
  let depth = 0
  let cursor = m.normalizeTreeNode(node, 0)
  while (cursor.children.length > 0) {
    cursor = cursor.children[0]
    depth += 1
  }
  assert.equal(depth, 12, 'MAX_TREE_DEPTH 必须钳制递归深度')
})

test('state normalization：normalizeTasks 丢弃非对象行并归一字段', async () => {
  const m = await helpers()
  const rows = m.normalizeTasks([{ id: 'T-1', title: 'x' }, null, 'nope', { id: 7 }])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, 'T-1')
  assert.equal(rows[1].id, '7')
})

test('state normalization：normalizeTaskStages 按阶段桶归一行并丢弃坏行', async () => {
  const m = await helpers()
  const stages = m.normalizeTaskStages({ implementing: [{ id: 'T-1' }, null, 'x'], done: 'nope' })
  assert.deepEqual(Object.keys(stages).sort(), ['done', 'implementing'], '阶段键必须原样保留')
  assert.equal(stages.implementing.length, 1)
  assert.equal(stages.implementing[0].id, 'T-1')
  assert.deepEqual(stages.done, [], '非数组桶按空列表处理')
})

test('state normalization：normalize 对空 payload 不崩并给出安全默认值', async () => {
  const m = await helpers()
  const view = m.normalize({})
  assert.equal(view.ok, undefined)
  assert.equal(typeof view.tasks, 'object')
  assert.deepEqual(view.tasks.active, [])
  assert.deepEqual(view.tasks.draft, [])
  // 缺省 gates 键 = 「隐藏区块」（null），不是空数组——空数组会画出空态
  assert.equal(view.gates, null)
  assert.equal(view.heartbeats.length, 0)
  assert.deepEqual(view.warnings, [])
})

test('icon：PanelIcon / PanelGlyph 用 React stub 验证结构与默认 size', async () => {
  const calls = []
  const prelude =
    'const React = { createElement: (...args) => ({ type: args[0], props: args[1] === undefined ? {} : args[1], children: args.slice(2) }) };'
  const m = await loadModule('icon', ['icon'], prelude)
  const icon = m.PanelIcon({})
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 20)
  assert.equal(icon.children.length, 5, '图标路径数量漂移')
  const big = m.PanelIcon({ size: 26 })
  assert.equal(big.props.width, 26)
  const glyph = m.PanelGlyph({})
  assert.equal(glyph.type, m.PanelIcon)
  assert.equal(glyph.props.size, 16)
  calls.length = 0
})
