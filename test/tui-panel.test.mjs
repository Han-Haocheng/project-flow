// project-flow TUI side panel: pure model + registration surface.
//
// No host, no React: the fixture is a trimmed copy of the /api/project-flow/state
// shape so the assertions stay readable and do not pin the whole payload.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { panelModel, registerProjectFlowPanel } from '../tui-panel.js'

const NOW = Date.parse('2026-10-31T18:30:00+08:00')

function fixture() {
  return {
    ok: true,
    generatedAt: '2026-10-31T18:28:26+08:00',
    contract: { source: '.dsh/flow/flow.json', schema: 2, name: 'project-flow' },
    root: '/mnt/d/Project/project-flow',
    head: { sha: '7bb0fe0', branch: 'main', dirty: 0 },
    experiments: {
      total: 1,
      counts: { total: 1, open: 1, confirmed: 0, refuted: 0, abandoned: 0 },
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
