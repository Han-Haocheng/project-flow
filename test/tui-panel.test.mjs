// project-flow TUI side panel: pure model + registration surface.
//
// No host, no React: the fixture is a trimmed copy of the /api/project-flow/state
// shape so the assertions stay readable and do not pin the whole payload.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { panelModel, registerProjectFlowPanel } from '../tui-panel.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const NOW = Date.parse('2026-10-31T18:30:00+08:00')

function fixture() {
  return {
    ok: true,
    generatedAt: '2026-10-31T18:28:26+08:00',
    contract: { source: '.dsh/flow/flow.json', schema: 2, name: 'project-flow' },
    root: '/mnt/d/Project/project-flow',
    head: { sha: '7bb0fe0', branch: 'main', dirty: 0 },
    experiments: {
      enabled: true,
      total: 1,
      counts: { total: 1, open: 1, confirmed: 0, refuted: 0, abandoned: 0, inconclusive: 0, pivoted: 0 },
      items: [{ id: 'E-20261030-01', title: '队列延迟与吞吐', status: 'open' }],
      tree: [],
      groups: [],
    },
    tasks: {
      total: 3,
      counts: { draft: 1, active: 1, done: 1, archived: 0, other: 0 },
      current: null,
      active: [{ id: 'T-20261030-23', title: '实现：决策台账核心', status: 'active' }],
      recentDone: [{ id: 'T-20261030-22', title: '冻结决策契约', status: 'done', gate: 'pass' }],
      draft: [{ id: 'T-20261030-15', title: '实现侧栏面板的视图层与宽度截断边界', status: 'draft' }],
    },
    gates: [{
      id: 'precommit',
      title: '提交前暂存区检查',
      phase: 'commit',
      enabled: true,
      lastRun: { ok: true, started_at: '2026-10-31T11:59:32+08:00', durationMs: 59 },
    }],
    heartbeats: [
      { session: 'abc', title: '实现面板', goal: '让侧栏显示台账', status: 'working', stale: false, ageSeconds: 12 },
    ],
    decisions: {
      items: [{
        id: 'D-20261031-01',
        kind: 'choice',
        status: 'open',
        question: '面板是否隐藏空闲决策段？',
        blocks: ['T-20261030-23'],
        escalated: false,
        ageSeconds: 60,
      }],
      counts: { open: 1, blocking: 1, escalated: 0, answered: 0, withdrawn: 0, superseded: 0, total: 1 },
    },
    warnings: [],
  }
}

function allLines(model) {
  const lines = [model.header, model.meta, ...model.counters]
  for (const section of model.sections) {
    lines.push(section.title)
    for (const entry of section.rows) lines.push(entry.text)
  }
  lines.push(...model.footer.split('\n'))
  return lines.filter((line) => line !== '')
}

test('uninitialized payloads name the root and render no sections', () => {
  const shapes = [
    {},
    { ok: false, root: '/tmp/ws', error: { code: 'not-initialized', message: 'no flow store' } },
    { ok: true, root: '/tmp/ws', contract: null, tasks: null },
  ]
  for (const payload of shapes) {
    const model = panelModel(payload, { width: 60, height: 20, now: NOW })
    assert.match(model.header, /未初始化/)
    assert.deepEqual(model.sections, [])
    assert.deepEqual(model.counters, [])
    assert.match(model.footer, /flow init/)
  }
  const model = panelModel(shapes[1], { width: 60, height: 20, now: NOW })
  assert.match(model.footer, /未初始化：\/tmp\/ws/)
})

test('a read failure keeps the header and reports the error in the footer', () => {
  const model = panelModel({ ok: false, error: 'boom' }, { width: 60, height: 20, now: NOW })
  assert.equal(model.header, '项目流程 · project-flow')
  assert.deepEqual(model.sections, [])
  assert.match(model.footer, /读取失败：boom/)
})

test('ready payload counters, section order and task rows follow the web panel', () => {
  const model = panelModel(fixture(), { width: 60, height: 40, now: NOW })
  assert.match(model.meta, /main · 7bb0fe0 · 干净/)

  const counters = model.counters.join('\n')
  assert.match(counters, /任务 3（草稿 1 \/ 进行 1 \/ 完成 1）/)
  assert.match(counters, /实验 1/)
  assert.match(counters, /门禁 1/)

  assert.deepEqual(model.sections.map((section) => section.title), ['任务', '实验', '门禁', '心跳', '决策'])

  const taskRows = model.sections[0].rows
  assert.ok(taskRows.some((entry) => entry.text.includes('实现：决策台账核心')))
  assert.ok(taskRows.some((entry) => entry.text.includes('冻结决策契约')))
  assert.equal(taskRows.find((entry) => entry.text.includes('冻结决策契约')).text, '✓ 冻结决策契约')
  for (const entry of taskRows) {
    assert.ok(!entry.text.startsWith('T-'), 'task rows must not lead with the raw id: ' + entry.text)
    assert.ok(!entry.text.includes('T-20261030-23'), 'task ids stay out of the compact row: ' + entry.text)
  }

  const gateRow = model.sections[2].rows[0]
  assert.match(gateRow.text, /提交前暂存区检查/)
  assert.equal(gateRow.tone, 'success')
})

test('心跳计数行用「活跃」，dead 判据同时认 liveness 与布尔 dead:true', () => {
  const payload = fixture();
  payload.heartbeats = [
    { session: 'a', goal: '还活着', status: 'working' },
    { session: 'b', goal: '只有布尔标记', status: 'working', dead: true },
    { session: 'c', goal: '有 liveness', status: 'working', liveness: 'dead' },
  ];
  const model = panelModel(payload, { width: 80, height: 40, now: NOW });
  const heartbeat = model.sections.find((section) => section.title === '心跳');
  assert.ok(heartbeat, 'heartbeat section missing');
  const header = heartbeat.rows[0].text;
  assert.equal(header, '活跃 1 · 已结束 2 / 共 3', 'the count line must use the web panel wording');
  assert.ok(!header.includes('working'), 'the count line must not mix English: ' + header);
  assert.equal(heartbeat.rows.filter((entry) => entry.text.startsWith('×')).length, 2, 'dead rows need the × glyph');
  assert.equal(heartbeat.rows.filter((entry) => entry.text.startsWith('▶')).length, 1, 'only the live beat is working');
  assert.ok(
    heartbeat.rows.some((entry) => entry.text.includes('只有布尔标记') && entry.text.includes('已结束')),
    'a beat with only `dead: true` must render as ended, not working'
  );
});

test('实验区可选：enabled 非 strict-true 时无「实验」计数与区段，六态 tone 兜底', () => {
  for (const experiments of [undefined, { enabled: false, counts: {} }, { counts: {} }]) {
    const payload = fixture();
    if (experiments === undefined) delete payload.experiments;
    else payload.experiments = experiments;
    const model = panelModel(payload, { width: 80, height: 40, now: NOW });
    assert.ok(!model.counters.join(' ').includes('实验'), 'a closed area must drop the experiment counter');
    assert.ok(!model.sections.some((section) => section.title === '实验'), 'a closed area must drop the experiment section');
    assert.deepEqual(model.sections.map((section) => section.title), ['任务', '门禁', '心跳', '决策']);
  }

  const payload = fixture();
  payload.experiments = {
    enabled: true,
    total: 2,
    counts: { total: 2, open: 0, confirmed: 0, refuted: 0, abandoned: 0, inconclusive: 1, pivoted: 1 },
    items: [
      { id: 'E-1', title: '未定论实验', status: 'inconclusive' },
      { id: 'E-2', title: '转向实验', status: 'pivoted' },
    ],
    tree: [],
  };
  const model = panelModel(payload, { width: 80, height: 40, now: NOW });
  const section = model.sections.find((entry) => entry.title === '实验');
  assert.ok(section, 'an open area must render the experiment section');
  const rows = section.rows.filter((entry) => entry.text.includes('未定论实验') || entry.text.includes('转向实验'));
  assert.equal(rows.length, 2, 'both six-state rows must render');
  for (const entry of rows) assert.equal(entry.tone, 'accent', 'inconclusive/pivoted must fall back to the accent tone');
});

test('心跳计数行恒带「已结束 D」：dead=0 时也输出 已结束 0（与 web 文案对齐）', () => {
  const model = panelModel(fixture(), { width: 80, height: 40, now: NOW });
  const heartbeat = model.sections.find((section) => section.title === '心跳');
  assert.equal(heartbeat.rows[0].text, '活跃 1 · 已结束 0 / 共 1');
});

test('every line is clipped to the requested width (CJK counted as one)', () => {
  const model = panelModel(fixture(), { width: 20, height: 40, now: NOW })
  const lines = allLines(model)
  for (const line of lines) {
    assert.ok(Array.from(line).length <= 20, 'line overflows width 20: ' + JSON.stringify(line))
  }
  assert.ok(lines.some((line) => line.endsWith('…')), 'expected at least one ellipsized row')
})

test('panelModel tolerates missing and malformed fields', () => {
  const payloads = [
    null,
    'nope',
    { ok: true, contract: { name: 'x' }, tasks: {} },
    { ok: true, contract: { name: 'x' }, tasks: { counts: null, active: 'no', draft: [null], recentDone: [{}] } },
    {
      ok: true,
      contract: { name: 'x' },
      tasks: {},
      experiments: null,
      gates: 'no',
      heartbeats: [null],
      decisions: { counts: null },
      warnings: 'no',
    },
  ]
  for (const payload of payloads) {
    let model
    assert.doesNotThrow(() => {
      model = panelModel(payload, { width: 28, height: 20, now: NOW })
    })
    assert.equal(typeof model.header, 'string')
    assert.ok(Array.isArray(model.sections))
  }
})

test('registerProjectFlowPanel registers the fixed descriptor', () => {
  let captured = null
  const dispose = () => {}
  const ctx = {
    get(name) {
      assert.equal(name, 'tuiPanels')
      return {
        register(descriptor) {
          captured = descriptor
          return dispose
        },
      }
    },
  }
  const result = registerProjectFlowPanel(ctx, { readState: async () => ({ ok: false, error: 'x' }) })
  assert.equal(result, dispose)
  assert.equal(captured.apiVersion, 1)
  assert.equal(captured.id, 'flow')
  assert.equal(captured.title, '项目流程')
  assert.equal(Array.from(captured.icon).length, 1)
  assert.equal(captured.order, 40)
  assert.equal(captured.minColumns, 28)
  assert.equal(typeof captured.component, 'function')
})

test('registration degrades to undefined when the service is absent or rejects', () => {
  assert.equal(registerProjectFlowPanel({ get() { return undefined } }, {}), undefined)
  assert.equal(registerProjectFlowPanel({ get() { return {} } }, {}), undefined)
  assert.equal(registerProjectFlowPanel({ get() { throw new Error('no service') } }, {}), undefined)
  assert.equal(registerProjectFlowPanel({ get() { return { register() { throw new Error('denied') } } } }, {}), undefined)
  assert.equal(registerProjectFlowPanel({}, {}), undefined)
})

// ------------------------------------------- last-good / stale（T-20261104-05）
//
// 组件本身要靠宿主 React 才能跑；这里用最小 hook 模拟器驱动真实的读链
// （useState/useRef/useEffect），断言「失败保留 last-good、只加一行 stale」。

/** 最小 React：按 hook 顺序保存槽位，state setter 标脏后重渲染。 */
function fakeReact() {
  const slots = []
  let cursor = 0
  let dirty = false
  const React = {
    useState(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[index]
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next
          dirty = true
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { ref: { current: initial } }
      return slots[index].ref
    },
    useEffect(fn, deps) {
      const index = cursor++
      const slot = slots[index] || (slots[index] = {})
      const nextDeps = Array.isArray(deps) ? deps : []
      slot.fn = fn
      slot.nextDeps = nextDeps
      slot.changed =
        slot.deps === undefined ||
        nextDeps.length !== slot.deps.length ||
        nextDeps.some((dep, position) => !Object.is(dep, slot.deps[position]))
    },
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
    },
  }
  return {
    React,
    render(component, props) {
      cursor = 0
      dirty = false
      return component(props)
    },
    runEffects() {
      for (const slot of slots) {
        if (!slot || typeof slot.fn !== 'function' || slot.changed !== true) continue
        if (typeof slot.cleanup === 'function') slot.cleanup()
        const cleanup = slot.fn()
        slot.cleanup = typeof cleanup === 'function' ? cleanup : null
        slot.deps = slot.nextDeps
        slot.changed = false
      }
    },
    isDirty: () => dirty === true,
  }
}

function mountPanel(options = {}) {
  const hostState = { cwd: options.cwd || '/ws/one' }
  let tick = 0
  const ui = {
    useAnimationTime: () => tick,
    Box: function Box() {},
    Text: function Text() {},
    Divider: function Divider() {},
  }
  const engine = fakeReact()
  let descriptor = null
  const ctx = {
    get() {
      return {
        register(value) {
          descriptor = value
          return () => {}
        },
      }
    },
  }
  registerProjectFlowPanel(ctx, {
    readState: options.readState,
    refreshMs: options.refreshMs === undefined ? 3000 : options.refreshMs,
    log: options.log,
  })
  const props = {
    React: engine.React,
    ui,
    host: { snapshot: () => ({ cwd: hostState.cwd }) },
    visible: true,
    focused: false,
    width: 60,
    height: 40,
  }
  let tree = null
  async function settle() {
    for (let round = 0; round < 20; round += 1) {
      tree = engine.render(descriptor.component, props)
      engine.runEffects()
      // 让 readState 的 promise 链落地；setState 会再次标脏。
      await new Promise((resolve) => setImmediate(resolve))
      if (engine.isDirty() === false) break
    }
    return tree
  }
  return {
    descriptor,
    settle,
    async tick(steps = 1) {
      tick += steps
      return settle()
    },
    setCwd(next) {
      hostState.cwd = next
    },
    tree: () => tree,
  }
}

/** 依次返回值；数组用尽后重复最后一项。Error 实例按 reject 处理。 */
function sequenceReader(sequence) {
  const calls = []
  return {
    calls,
    async readState(dir) {
      calls.push(dir)
      const value = sequence[Math.min(calls.length - 1, sequence.length - 1)]
      if (value instanceof Error) throw value
      if (typeof value === 'function') return value(dir)
      return value
    },
  }
}

function panelTexts(tree) {
  const found = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node !== 'object') return
    if (typeof node.type === 'function' && node.type.name === 'Text') {
      const children = node.props.children
      found.push({ text: typeof children === 'string' ? children : String(children ?? ''), color: node.props.color })
      return
    }
    if (typeof node.type === 'function' && node.type.name === 'Divider') return
    walk(node.props.children)
  }
  walk(tree)
  return found
}

const TIMEOUT = { ok: false, error: { code: 'state-timeout', message: 'state read timed out after 1800ms' } }
const NO_LEDGER = {
  ok: false,
  root: '/tmp/plain',
  error: { code: 'not-initialized', message: 'no flow store in /tmp/plain' },
}

function staleLines(lines) {
  return lines.filter((line) => line.text.startsWith('数据过期：'))
}

test('TUI last-good：ok:false 超时保留 good，只在 meta 后加一行 stale', async () => {
  const reader = sequenceReader([fixture(), TIMEOUT])
  const panel = mountPanel({ readState: reader.readState })
  await panel.settle()
  let lines = panelTexts(panel.tree())
  assert.ok(lines.some((line) => line.text.includes('任务 3')), '首读应显示 good 数据')
  assert.equal(staleLines(lines).length, 0)

  await panel.tick()
  lines = panelTexts(panel.tree())
  const stale = staleLines(lines)
  assert.equal(stale.length, 1, 'stale 必须只有一行：' + lines.map((line) => line.text).join(' | '))
  assert.match(stale[0].text, /^数据过期：state read timed out after 1800ms（上次成功 /)
  assert.equal(stale[0].color, 'yellow', 'stale 行 tone 必须是 warning')
  assert.ok(lines.some((line) => line.text.includes('任务 3')), 'last-good 数据仍在')
  assert.equal(lines.filter((line) => line.text.startsWith('读取失败：')).length, 0, '有 good 时不得显示错误卡')
  const texts = lines.map((line) => line.text)
  const metaIndex = texts.findIndex((text) => text.startsWith('main ·'))
  const staleIndex = texts.findIndex((text) => text.startsWith('数据过期：'))
  assert.equal(staleIndex, metaIndex + 1, 'stale 行紧跟 meta')
  assert.equal(reader.calls.length, 2)
})

test('连续多次超时：stale 不堆叠、画面不抖动，恢复成功后 stale 消失并刷新数据', async () => {
  const recovered = fixture()
  recovered.contract.name = 'recovered'
  recovered.tasks.total = 5
  recovered.tasks.counts = { draft: 0, active: 0, done: 5, archived: 0, other: 0 }
  recovered.tasks.active = []
  recovered.tasks.draft = []
  const reader = sequenceReader([fixture(), TIMEOUT, TIMEOUT, TIMEOUT, recovered])
  const panel = mountPanel({ readState: reader.readState })
  await panel.settle()
  const goodTexts = panelTexts(panel.tree()).map((line) => line.text)
  assert.equal(staleLines(panelTexts(panel.tree())).length, 0)

  await panel.tick()
  const firstStale = panelTexts(panel.tree())
  const snapshot = firstStale.map((line) => line.text)
  assert.equal(staleLines(firstStale).length, 1)
  await panel.tick()
  await panel.tick()
  const lines = panelTexts(panel.tree())
  assert.equal(staleLines(lines).length, 1, '连续超时只保留一行 stale')
  assert.deepEqual(lines.map((line) => line.text), snapshot, '连续超时不得堆叠或抖动')
  assert.deepEqual(
    snapshot.filter((text) => !text.startsWith('数据过期：')),
    goodTexts,
    '数据行保持首读快照',
  )

  await panel.tick()
  const afterRecovery = panelTexts(panel.tree())
  assert.equal(staleLines(afterRecovery).length, 0, '恢复成功后 stale 必须消失')
  assert.ok(
    afterRecovery.some((line) => line.text.includes('任务 5')),
    '恢复后应显示新数据：' + afterRecovery.map((line) => line.text).join(' | '),
  )
})

test('抛异常与 ok:false 同一条路径：都保留 good、只记一次日志', async () => {
  for (const failure of [TIMEOUT, new Error('state read timed out after 1800ms')]) {
    const logs = []
    const reader = sequenceReader([fixture(), failure])
    const panel = mountPanel({ readState: reader.readState, log: (message) => logs.push(message) })
    await panel.settle()
    await panel.tick()
    const lines = panelTexts(panel.tree())
    assert.ok(lines.some((line) => line.text.includes('任务 3')), '两种失败都必须保留 last-good')
    assert.equal(staleLines(lines).length, 1, '两种失败都必须只加一行 stale')
    assert.equal(lines.filter((line) => line.text.startsWith('读取失败：')).length, 0, '有 good 时不显示错误卡')
    await panel.tick()
    assert.equal(logs.length, 1, '同一失败只 log 一次，不随每次轮询重复')
    assert.match(logs[0], /^panel read failed: state read timed out after 1800ms$/)
  }
})

test('cwd 切换清空 last-good 与 stale：新工作区首读失败只显示错误卡', async () => {
  const calls = []
  let aReads = 0
  const readState = async (dir) => {
    calls.push(dir)
    if (dir === '/ws/a') {
      aReads += 1
      return aReads === 1 ? fixture() : TIMEOUT
    }
    return TIMEOUT
  }
  const panel = mountPanel({ cwd: '/ws/a', readState })
  await panel.settle()
  assert.ok(panelTexts(panel.tree()).some((line) => line.text.includes('任务 3')))
  await panel.tick()
  assert.equal(staleLines(panelTexts(panel.tree())).length, 1, '同一工作区超时应标 stale')

  panel.setCwd('/ws/b')
  await panel.tick()
  const lines = panelTexts(panel.tree())
  assert.deepEqual(calls, ['/ws/a', '/ws/a', '/ws/b'])
  assert.equal(staleLines(lines).length, 0, '不得把 /ws/a 的 stale 带到 /ws/b')
  assert.equal(lines.filter((line) => line.text.includes('任务 3')).length, 0, '不得显示 /ws/a 的 last-good')
  assert.ok(
    lines.some((line) => line.text.startsWith('读取失败：')),
    '/ws/b 首读失败应显示错误卡：' + lines.map((line) => line.text).join(' | '),
  )
})

test('首读失败才显示错误卡；not-initialized 仍是正常空态（不标 stale）', async () => {
  const timeoutFirst = mountPanel({ readState: sequenceReader([TIMEOUT]).readState })
  await timeoutFirst.settle()
  let lines = panelTexts(timeoutFirst.tree())
  assert.ok(lines.some((line) => line.text.startsWith('读取失败：')))
  assert.equal(staleLines(lines).length, 0)

  const throwFirst = mountPanel({ readState: sequenceReader([new Error('宿主张量失败')]).readState })
  await throwFirst.settle()
  lines = panelTexts(throwFirst.tree())
  assert.ok(lines.some((line) => line.text.startsWith('读取失败：宿主张量失败')))

  const uninitialized = mountPanel({ readState: sequenceReader([NO_LEDGER]).readState })
  await uninitialized.settle()
  lines = panelTexts(uninitialized.tree())
  assert.ok(lines.some((line) => line.text.includes('未初始化')), 'not-initialized 应渲染空态卡')
  assert.equal(lines.filter((line) => line.text.startsWith('读取失败：')).length, 0)
  assert.equal(staleLines(lines).length, 0)
})

test('panelModel 可选 staleNote：单参逐字节不变，只追加 staleNote 字段', () => {
  const single = panelModel(fixture())
  // 与 T-05 之前（HEAD 版 tui-panel.js）的输出逐字节一致。
  // task-88：心跳计数行由 `working N` 改为与 web 一致的 `活跃 N`（T-10 文案对齐）。
  // task-99（T-12 B3）：心跳计数行恒带「已结束 D」（与 web 的 hb.counts 对齐），
  // 其余字段未变；单参调用仍然不产出 `staleNote`。
  const digest = createHash('sha256').update(JSON.stringify(single)).digest('hex')
  assert.equal(digest, 'd0bd484e2a7add14118e54625e71faccd226b2022875d4c7aafeff5d767eea2c')
  assert.equal(Object.hasOwn(single, 'staleNote'), false)

  const plain = panelModel(fixture(), { width: 60, height: 40, now: NOW })
  const withNote = panelModel(fixture(), {
    width: 60,
    height: 40,
    now: NOW,
    staleNote: { message: 'timed out', at: NOW - 60_000 },
  })
  assert.equal(withNote.staleNote, '数据过期：timed out（上次成功 1m 前）')
  const { staleNote, ...rest } = withNote
  assert.deepEqual(rest, plain, 'staleNote 不得改变其它字段')
  assert.equal(staleNote, '数据过期：timed out（上次成功 1m 前）')

  const clipped = panelModel(fixture(), {
    width: 20,
    height: 40,
    now: NOW,
    staleNote: { message: 'state read timed out after 1800ms', at: NOW },
  })
  assert.ok(Array.from(clipped.staleNote).length <= 20, 'staleNote 也必须按宽度裁剪')
  assert.ok(clipped.staleNote.startsWith('数据过期：'))
})

test('TUI 与 web 用同一 Host fixture 对照：store 与 not-initialized 同形', () => {
  const storeFixture = JSON.parse(fs.readFileSync(path.join(ROOT, '.selftest', 'state-store.json'), 'utf8'))
  const storeModel = panelModel(storeFixture, { width: 80, height: 40, now: NOW })
  assert.match(storeModel.header, new RegExp(storeFixture.contract.name))
  assert.ok(
    storeModel.counters.join(' ').includes('任务 ' + storeFixture.tasks.total),
    'TUI 计数必须与 Host/web 同一 fixture 的 tasks.total 一致',
  )
  const fixtureExpEnabled = storeFixture.experiments && storeFixture.experiments.enabled === true
  assert.deepEqual(
    storeModel.sections.map((section) => section.title).slice(0, 3),
    fixtureExpEnabled ? ['任务', '实验', '门禁'] : ['任务', '门禁', '心跳'],
    'TUI section 顺序与 web 面板一致（实验区是否出现由 fixture 的 enabled 决定）',
  )
  assert.equal(Object.hasOwn(storeModel, 'staleNote'), false)

  const noLedger = JSON.parse(fs.readFileSync(path.join(ROOT, '.selftest', 'state-not-initialized.json'), 'utf8'))
  const noLedgerModel = panelModel(noLedger, { width: 80, height: 40, now: NOW })
  assert.match(noLedgerModel.header, /未初始化/)
  assert.match(noLedgerModel.footer, /flow init/)
  assert.deepEqual(noLedgerModel.sections, [])
})

test('web 零回归：client.js 的 stale/错误面未被 TUI 改动波及', () => {
  const webSource = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  // web 端自己的快照 + stale 机制仍在。
  assert.ok(webSource.includes('setErrorInfo'), 'web 面板仍用 errorInfo 保留快照')
  assert.ok(webSource.includes("'stale.text'"), 'web 的 stale 文案仍在')
  assert.ok(webSource.includes('setLastOkAt'), 'web 仍记录上次成功时间')
  // TUI 的 stale 只在客户端：不得把 TUI 概念/模块塞进 web 源码。
  assert.equal(/tui-panel|staleNote/.test(webSource), false, 'TUI stale 概念不得泄漏到 web client')
})
