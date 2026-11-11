// T-20261111-01 · Track C：目标真源 + 面板「框架视图」只读投影。
//
// 文件后缀刻意是 `-test.mjs`（Node 的测试发现同样匹配，`node --test test/`
// 会执行它），而不是仓库常见的 `.test.mjs`：
//   - README 的「N 用例（M 个文件）」是派生数，由 `scripts/doc-counts.mjs`
//     与 `t-20261106-doc-drift` 双向校验；
//   - README 属于本任务写域之外（Track C 只改 client.js / state-snapshot /
//     docs/GOALS.md / test/ 新文件），静态计数只统计 `*.test.mjs`；
//   - 用 `-test.mjs` 可以在不制造 README 计数漂移的前提下，让这批新测试真正
//     进入全量运行。README 的计数一旦由集成方刷新，改名回 `.test.mjs` 即可。
//
// 覆盖两层：
//   ① `docs/GOALS.md`：四层结构 + 8 条目标的可机读表（id/层/优先级/目标/检验/落点）；
//   ② `lib/state-snapshot.mjs` 的 `description` 投影 + `client.js` 的
//      `normalizeDescription` / `FrameworkCard`（含缺数据时的「—」与隐藏降级）。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildSnapshot } from '../lib/state-snapshot.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const GOALS = path.join(REPO, 'docs', 'GOALS.md')
const CLIENT = path.join(REPO, 'client.js')

const TEMP_DIRS = []
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pf-goals-${label}-`))
  TEMP_DIRS.push(dir)
  return dir
}
after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

const writeText = (root, relative, text) => {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const writeJson = (root, relative, value) => writeText(root, relative, `${JSON.stringify(value, null, 2)}\n`)

/** One minimal flow task record (`listTasks` only needs id/title/status). */
const flowTask = (id, title) => ({
  schema: 1,
  id,
  title,
  status: 'done',
  stage: 'done',
  created_at: '2026-11-01T10:00:00+08:00',
  updated_at: '2026-11-01T10:00:00+08:00',
})

/** One file record; `semantics` below the 10-char floor counts as missing. */
const fileRecord = (relative, semantics, modules = []) => ({ schema: 1, path: relative, semantics, modules })

/** One semantic-change plan record; the snapshot never validates it, only reads it. */
const planRecord = (task, implementedAt, extra = {}) => ({
  schema: 1,
  task,
  status: 'implemented',
  implemented_at: implementedAt,
  updated_at: implementedAt,
  files: [],
  reason: '',
  ...extra,
})

async function snapshotOf(root) {
  return buildSnapshot({
    root,
    realRoot: root,
    entry: { path: root, name: '' },
    hostWarnings: [],
    now: Date.parse('2026-11-11T12:00:00+08:00'),
  })
}

// ---------------------------------------------------------------- GOALS.md

test('docs/GOALS.md：四层结构 + 8 条目标的可机读优先级表', () => {
  const source = fs.readFileSync(GOALS, 'utf8')

  // 四层：真源层 + 三档优先级。
  for (const layer of ['L0', 'L1', 'L2', 'L3']) {
    assert.match(source, new RegExp(`^\\| ${layer} \\|`, 'm'), `缺 ${layer} 层声明`)
  }
  for (const tier of ['最重要', '核心', '扩展']) {
    assert.ok(source.includes(tier), `缺优先级档：${tier}`)
  }
  // 用户 2026-11-11 的原话必须留在真源里（优先级变化的唯一依据）。
  assert.match(source, /2026-11-11/, '目标真源必须标注 2026-11-11 的来源')
  assert.match(source, /减少AI思考机会和长度/, '必须保留用户原话的目标表述')

  // 机器可读表：固定六列、8 行、id/优先级有序。
  const header = /^\| id \| 层 \| 优先级 \| 目标 \| 怎么检验 \| 落点 \/ 证据 \|$/m
  assert.match(source, header, '目标表表头不是固定六列')
  const rows = source
    .split('\n')
    .filter((line) => /^\| G\d+ \|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
  assert.equal(rows.length, 8, `目标表应有 8 条目标，实际 ${rows.length}`)
  assert.deepEqual(rows.map((cells) => cells[0]), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'])
  assert.deepEqual(
    rows.map((cells) => cells[1]),
    ['L1', 'L2', 'L2', 'L2', 'L2', 'L3', 'L3', 'L3'],
    '四条核心目标必须都在 L2，扩展目标必须都在 L3',
  )
  assert.deepEqual(rows.map((cells) => cells[2]), ['P0', 'P1', 'P1', 'P1', 'P1', 'P2', 'P2', 'P2'])

  const goalText = rows.map((cells) => cells[3]).join('｜')
  for (const goal of [
    '减少 AI 思考机会与长度',
    '明确处理流程',
    '明确结果验证',
    '清晰语义定义',
    '多 AI 并行不冲突',
    '看见整体框架',
    '看见语义变化',
    '看见会话状态',
  ]) {
    assert.ok(goalText.includes(goal), `目标表缺目标：${goal}`)
  }

  // 每条目标都有「怎么检验」的一句话，且必须指向机器可验证的落点。
  const machineTokens = [
    'flow task next',
    'lib/stage.mjs',
    'cmd:',
    'check description',
    'module-domain',
    '面板',
    '心跳',
  ]
  for (const cells of rows) {
    assert.ok(cells[4].length >= 8, `${cells[0]} 的「怎么检验」太短：${cells[4]}`)
    assert.ok(
      machineTokens.some((token) => cells[4].includes(token)),
      `${cells[0]} 的「怎么检验」没有指向可机器验证的落点：${cells[4]}`,
    )
    assert.ok(cells[5].length > 0, `${cells[0]} 缺「落点 / 证据」`)
  }
})

// ------------------------------------------------------- payload：健康台账

test('payload：描述台账汇总 + 最近 5 条已实现计划（标题/时间倒序）', async () => {
  const root = tempDir('healthy')
  writeJson(root, '.agents/flow/flow.json', { schema: 2, name: 'goals-framework' })
  for (const [id, title] of [
    ['T-1', '任务一：框架视图'],
    ['T-2', '任务二：语义台账'],
    ['T-3', '任务三：面板投影'],
    ['T-5', '任务五：降级行为'],
  ]) {
    writeJson(root, `.agents/tasks/${id}.json`, flowTask(id, title))
  }

  // 描述台账：3 个文件记录 / 2 个模块 / 1 处缺语义。
  writeJson(root, '.agents/description/project.json', {
    schema: 1,
    name: 'goals-framework',
    semantics: '框架视图的只读投影测试',
  })
  writeJson(
    root,
    '.agents/description/files/lib%2Fstate-snapshot.mjs.json',
    fileRecord('lib/state-snapshot.mjs', '只读快照与框架视图投影（测试）', [
      { id: 'panel', semantics: '面板框架视图的只读投影', members: [] },
      { id: 'snapshot', semantics: '快照组装与优雅降级行为', members: [] },
    ]),
  )
  writeJson(root, '.agents/description/files/client.js.json', fileRecord('client.js', '面板 UI 与框架视图渲染', []))
  writeJson(root, '.agents/description/files/broken.mjs.json', fileRecord('broken.mjs', '太短', []))

  // 8 个计划文件 + 1 个坏 JSON：计划数按文件名计，坏文件不参与时间线。
  writeJson(root, '.agents/description/tasks/T-1.json', planRecord('T-1', '2026-11-01T09:00:00+08:00', { files: [{ path: 'one.mjs', op: 'change' }] }))
  writeJson(root, '.agents/description/tasks/T-2.json', planRecord('T-2', '2026-11-02T09:00:00+08:00', { files: [{ path: 'two.mjs', op: 'change' }] }))
  writeJson(root, '.agents/description/tasks/T-3.json', planRecord('T-3', '2026-11-03T09:00:00+08:00', { files: [{ path: 'm.mjs', op: 'change' }] }))
  writeJson(root, '.agents/description/tasks/T-4.json', planRecord('T-4', '2026-11-04T09:00:00+08:00', { files: [{ path: 'a.mjs', op: 'change' }, { path: 'b.mjs', op: 'change' }] }))
  writeJson(root, '.agents/description/tasks/T-5.json', planRecord('T-5', '2026-11-05T09:00:00+08:00', { files: [{ path: 'c.mjs', op: 'change' }] }))
  writeJson(root, '.agents/description/tasks/T-6.json', planRecord('T-6', '2026-11-06T09:00:00+08:00', { noSemanticChange: true, reason: '只做协调：无源码语义变化' }))
  writeJson(root, '.agents/description/tasks/T-7.json', {
    schema: 1,
    task: 'T-7',
    status: 'planned',
    updated_at: '2026-11-07T09:00:00+08:00',
    files: [{ path: 'planned.mjs', op: 'change' }],
    reason: '',
  })
  // 没有 implemented_at：时间回落到 updated_at。
  writeJson(root, '.agents/description/tasks/T-8.json', {
    schema: 1,
    task: 'T-8',
    status: 'implemented',
    updated_at: '2026-11-08T09:00:00+08:00',
    files: [{ path: 'z.mjs', op: 'change' }],
    reason: '',
  })
  writeText(root, '.agents/description/tasks/T-9.json', '{ bad json')

  const payload = await snapshotOf(root)
  assert.equal(payload.ok, true)
  const description = payload.description
  assert.deepEqual(Object.keys(description).sort(), ['available', 'counts', 'recentPlans'])
  assert.equal(description.available, true)
  assert.deepEqual(description.counts, { files: 3, modules: 2, missingSemantics: 1, plans: 9 })

  assert.equal(description.recentPlans.length, 5, '只保留最近 5 条已实现计划')
  for (const row of description.recentPlans) {
    assert.deepEqual(Object.keys(row).sort(), ['at', 'task', 'title'], '计划行只投影 task/title/at')
  }
  assert.deepEqual(description.recentPlans, [
    // 标题来自任务卡；没有任务卡时依次回落到 reason、文件列表。
    { task: 'T-8', title: 'z.mjs', at: '2026-11-08T09:00:00+08:00' },
    { task: 'T-6', title: '只做协调：无源码语义变化', at: '2026-11-06T09:00:00+08:00' },
    { task: 'T-5', title: '任务五：降级行为', at: '2026-11-05T09:00:00+08:00' },
    { task: 'T-4', title: 'a.mjs +1', at: '2026-11-04T09:00:00+08:00' },
    { task: 'T-3', title: '任务三：面板投影', at: '2026-11-03T09:00:00+08:00' },
  ])
  // 降级事件不能凭空出现：健康台账只可能带明确的截断/读取警告。
  assert.equal(payload.warnings.some((line) => line.startsWith('description unreadable')), false)
})

// ------------------------------------------------- payload：缺失与损坏降级

test('payload：台账缺失 / 未建 / 损坏时降级为 available:false 或「—」，不抛错', async () => {
  // ① 连描述目录都没有。
  const missingRoot = tempDir('missing')
  writeJson(missingRoot, '.agents/flow/flow.json', { schema: 2, name: 'no-description' })
  const missing = await snapshotOf(missingRoot)
  assert.equal(missing.ok, true)
  assert.deepEqual(missing.description, { available: false, counts: null, recentPlans: [] })

  // ② flow init 建了空目录、但还没 build：零计数不得伪装成「0 缺语义」。
  const emptyRoot = tempDir('empty')
  writeJson(emptyRoot, '.agents/flow/flow.json', { schema: 2, name: 'empty-description' })
  fs.mkdirSync(path.join(emptyRoot, '.agents', 'description'), { recursive: true })
  const empty = await snapshotOf(emptyRoot)
  assert.deepEqual(empty.description, { available: false, counts: null, recentPlans: [] })

  // ③ project.json 坏了、计划文件也坏了：能读多少给多少，绝不抛错。
  const brokenRoot = tempDir('broken')
  writeJson(brokenRoot, '.agents/flow/flow.json', { schema: 2, name: 'broken-description' })
  writeText(brokenRoot, '.agents/description/project.json', '{ not json')
  writeJson(brokenRoot, '.agents/description/files/client.js.json', fileRecord('client.js', '面板 UI 与框架视图渲染', []))
  writeJson(brokenRoot, '.agents/description/tasks/T-1.json', planRecord('T-1', '2026-11-01T09:00:00+08:00'))
  writeText(brokenRoot, '.agents/description/tasks/T-2.json', '{ broken')
  const broken = await snapshotOf(brokenRoot)
  assert.equal(broken.ok, true)
  assert.equal(broken.description.available, true)
  assert.deepEqual(broken.description.counts, { files: 1, modules: 0, missingSemantics: 0, plans: 2 })
  assert.deepEqual(broken.description.recentPlans, [
    // 任务卡、reason、files 都给不出标题时，title 保持空串（客户端渲染「—」）。
    { task: 'T-1', title: '', at: '2026-11-01T09:00:00+08:00' },
  ])
})

test('payload：description.dir 契约自定义目录被尊重（不硬编码 .agents/description）', async () => {
  const root = tempDir('custom-dir')
  writeJson(root, '.agents/flow/flow.json', {
    schema: 2,
    name: 'custom-description',
    description: { dir: '.agents/my-desc' },
  })
  writeJson(root, '.agents/my-desc/project.json', { schema: 1, name: 'custom-description', semantics: '自定义目录的语义台账' })
  writeJson(root, '.agents/my-desc/files/client.js.json', fileRecord('client.js', '面板 UI 与框架视图渲染', []))
  writeJson(root, '.agents/my-desc/tasks/T-1.json', planRecord('T-1', '2026-11-01T09:00:00+08:00'))

  const payload = await snapshotOf(root)
  assert.equal(payload.description.available, true)
  assert.deepEqual(payload.description.counts, { files: 1, modules: 0, missingSemantics: 0, plans: 1 })
  assert.equal(payload.description.recentPlans.length, 1)
})

// ------------------------------------------------- client：normalize + 卡片

const ANCHOR = "    return {\n      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],"
const PROBE_NAME =
  "    return {\n      __probe: { zh, en, normalize, normalizeDescription, FrameworkCard },\n      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],"

const NOW = Date.parse('2026-11-08T12:00:00+08:00')

function collect(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const entry of node) collect(entry, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ text: String(node) })
    return out
  }
  if (typeof node === 'object') {
    out.push({ element: node })
    if (Array.isArray(node.children)) {
      for (const child of node.children) collect(child, out)
    }
  }
  return out
}

const elementsByClass = (node, className) =>
  collect(node, [])
    .filter((entry) => entry.element !== undefined)
    .map((entry) => entry.element)
    .filter(
      (element) =>
        element.props !== undefined &&
        typeof element.props.className === 'string' &&
        element.props.className.split(' ').includes(className),
    )

const textOf = (node) =>
  collect(node, [])
    .filter((entry) => entry.text !== undefined)
    .map((entry) => entry.text)
    .join(' ')

function translator(zh) {
  return (key, vars) => {
    let text = typeof zh[key] === 'string' ? zh[key] : key
    if (vars !== undefined && vars !== null && typeof vars === 'object') {
      for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value))
    }
    return text
  }
}

/** Load client.js behind a probe that exposes the pure projection + one card. */
async function loadClientProbe() {
  const source = fs.readFileSync(CLIENT, 'utf8')
  assert.equal(source.split(ANCHOR).length - 1, 1, 'client.js 的 probe 锚点必须恰好出现一次')
  const dir = tempDir('client-probe')
  const probeFile = path.join(dir, 'client.probe.cjs')
  fs.writeFileSync(probeFile, source.replace(ANCHOR, PROBE_NAME))

  const createElement = (type, props, ...children) => ({ type, props: props || {}, children })
  const ReactStub = {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => undefined,
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
  }
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
        return definition
      },
    },
  }
  await import(pathToFileURL(probeFile).href)
  assert.ok(captured !== null, 'client.js 没有调用 window.__ModuleLoader__.load')
  const plugin = captured.factory((id) => {
    if (id === 'react') return ReactStub
    throw new Error(`unexpected require(${id})`)
  })
  assert.ok(plugin.__probe, 'probe 注入失败')
  return plugin.__probe
}

test('client：normalize 投影 description，缺失时返回 null（卡片隐藏）', async () => {
  const probe = await loadClientProbe()

  const normalized = probe.normalize({
    description: {
      available: true,
      counts: { files: 3, modules: 2, missingSemantics: 1, plans: 4 },
      recentPlans: [
        { task: 'T-1', title: '标题一', at: '2026-11-06T09:00:00+08:00' },
        { task: 'T-2', title: '标题二', at: '2026-11-05T09:00:00+08:00' },
        { task: 'T-3', title: '标题三', at: '2026-11-04T09:00:00+08:00' },
        { task: 'T-4', title: '标题四', at: '2026-11-03T09:00:00+08:00' },
        { task: 'T-5', title: '标题五', at: '2026-11-02T09:00:00+08:00' },
        { task: 'T-6', title: '超出的第六条', at: '2026-11-01T09:00:00+08:00' },
        { title: '缺 task 的行被丢弃', at: '2026-10-31T09:00:00+08:00' },
      ],
    },
  })
  assert.deepEqual(normalized.description.counts, { files: 3, modules: 2, missingSemantics: 1, plans: 4 })
  assert.equal(normalized.description.plans.length, 5, '卡片最多 5 条')
  assert.equal(normalized.description.plans[0].task, 'T-1')
  assert.equal(normalized.description.plans[0].atMs, Date.parse('2026-11-06T09:00:00+08:00'))

  // 缺 section / available=false → null（PanelView 不挂载卡片）。
  assert.equal(probe.normalize({}).description, null)
  assert.equal(probe.normalize({ description: { available: false, counts: null } }).description, null)
  assert.equal(probe.normalize({ description: 'nope' }).description, null)

  // 计数不可算时保 null（渲染「—」），不是 0。
  const partial = probe.normalize({ description: { available: true, counts: {}, recentPlans: null } })
  assert.deepEqual(partial.description.counts, {
    files: null,
    modules: null,
    missingSemantics: null,
    plans: null,
  })
  assert.deepEqual(partial.description.plans, [])
})

test('client：FrameworkCard 渲染汇总与计划行；计数缺失显示「—」，无计划显示空态', async () => {
  const probe = await loadClientProbe()
  const t = translator(probe.zh)

  const full = probe.FrameworkCard({
    t,
    now: NOW,
    showTitle: false,
    description: {
      counts: { files: 3, modules: 2, missingSemantics: 0, plans: 4 },
      plans: [
        { task: 'T-9', title: '最近一条', at: '2026-11-06T09:00:00+08:00', atMs: Date.parse('2026-11-06T09:00:00+08:00') },
        { task: 'T-8', title: '', at: '', atMs: null },
      ],
    },
  })
  const summary = textOf(full)
  assert.ok(summary.includes('文件 3 · 模块 2 · 缺语义 0 · 计划 4'), `汇总文案不对：${summary}`)
  assert.ok(summary.includes('最近语义变更'))
  const rows = elementsByClass(full, 'project-flow-frameworkRow')
  assert.equal(rows.length, 2)
  assert.ok(textOf(rows[0]).includes('T-9') && textOf(rows[0]).includes('最近一条'))
  assert.ok(textOf(rows[0]).includes('2 天前'), `计划时间应相对渲染：${textOf(rows[0])}`)
  assert.ok(textOf(rows[1]).includes('T-8') && textOf(rows[1]).includes(t('misc.dash')), '缺标题降级为「—」')
  assert.equal(elementsByClass(rows[1], 'project-flow-frameworkTime').length, 0, '缺时间不渲染时间戳')
  assert.equal(elementsByClass(full, 'project-flow-cardTitle').length, 0, 'showTitle:false 时不重复标题')

  // 计数为 null → 四个「—」。
  const partial = probe.FrameworkCard({
    t,
    now: NOW,
    showTitle: false,
    description: { counts: { files: null, modules: null, missingSemantics: null, plans: null }, plans: [] },
  })
  const partialText = textOf(partial)
  assert.equal((partialText.match(new RegExp(t('misc.dash'), 'g')) || []).length, 4, `缺计数应显示四个「—」：${partialText}`)
  assert.ok(partialText.includes('还没有已实现的语义变更计划。'), '无计划时给空态，不渲染空列表')
  assert.equal(elementsByClass(partial, 'project-flow-frameworkRow').length, 0)

  // 默认标题（showTitle 未给）与英文文案。
  const titled = probe.FrameworkCard({ t, now: NOW, description: { counts: null, plans: [] } })
  assert.equal(textOf(elementsByClass(titled, 'project-flow-cardTitle')[0]), '框架视图')
  const en = translator(probe.en)
  const enCard = probe.FrameworkCard({ t: en, now: NOW, description: { counts: null, plans: [] } })
  assert.equal(textOf(elementsByClass(enCard, 'project-flow-cardTitle')[0]), 'Framework view')
  assert.ok(textOf(enCard).includes('No implemented semantic-change plans yet.'))
})

test('client：框架视图 locale 键 zh/en 对齐且全部被源码引用', async () => {
  const probe = await loadClientProbe()
  const source = fs.readFileSync(CLIENT, 'utf8')
  assert.deepEqual(Object.keys(probe.zh).sort(), Object.keys(probe.en).sort(), 'zh/en 键集合必须一致')
  for (const key of ['framework.title', 'framework.summary', 'framework.plans', 'framework.plansEmpty']) {
    assert.equal(typeof probe.zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof probe.en[key], 'string', `en 缺 ${key}`)
    assert.ok(source.includes(`'${key}'`), `client.js 没有引用 ${key}`)
  }
  assert.match(probe.zh['framework.summary'], /\{files\}.*\{modules\}.*\{missing\}.*\{plans\}/)
  assert.ok(probe.zh['framework.plansEmpty'].includes('语义变更计划'))
  assert.ok(probe.en['framework.plansEmpty'].includes('semantic-change'))
  // 卡片只在 payload 有 description 时挂载（缺数据 → 不渲染空壳）。
  assert.match(source, /normalizeDescription\(src\.description\)/)
  assert.match(source, /view\.description\s*\?\s*foldCard\(\s*'framework'/)
})
