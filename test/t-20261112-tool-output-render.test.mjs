// T-20261112152355 [S1] 工具输出渲染：renderToolText / toolOutput(name)。
//
// 这一层只钉**渲染器本身**（纯函数、可单测）：空态 / 列表 / 单条 / ok:false /
// 未登记形状兜底 / 超 MAX_TOOL_ITEMS 截断 / 渲染不修改入参。跨模块的端到端由
// test/t-20261112-tool-output-e2e.test.mjs 负责，这里不重复。
//
// 断言口径（为什么这么写）：
// - 不钉死整段文案（S1 迭代措辞时用例不该红），只钉**结构性的那几件事**：
//   首行有中文摘要、列表每项一行、空态有中文、失败是 ✖ + 下一步、未登记形状回落 JSON；
// - 「不含裸 JSON」用 /^\{\s*"/m 探测：兜底 JSON 的首字符就是 { 加引号，正常渲染没有；
// - 「不修改入参」用深冻结 + 前后深比较：渲染器一旦写入冻结对象会直接抛。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_TOOL_ITEMS, renderToolText, toolOutput } from '../lib/plugin/shared.mjs'

/** 深冻结（顺带证明渲染器只读入参：任何写入都会在严格模式抛错）。 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/** 文本里是否出现「裸露的 JSON 起始」——`{` 后面紧跟引号。 */
const BARE_JSON = /^\s*\{\s*"/m

/** 文本里是否有中文（摘要是中文可读报告的最低门槛）。 */
const HAS_CJK = /[\u4e00-\u9fff]/


// ---------------------------------------------------------------- 兜底与契约

test('未登记的工具线名：回落 JSON，且不是异常', () => {
  const value = { hello: 'world', n: 1 }
  const text = renderToolText('flow_not_a_tool', value)
  assert.equal(text, JSON.stringify(value, null, 2))
})

test('已登记工具但未登记的返回形状：回落 JSON（永不丢信息）', () => {
  const value = { somethingNew: [1, 2, 3] }
  const text = renderToolText('flow_task', value, 'add')
  assert.equal(text, JSON.stringify(value, null, 2), '未登记形状必须逐字节等于 JSON 兜底')
})

test('渲染器自身出错（环形对象）也不抛：回落字符串而不是异常', () => {
  const cyclic = { ok: false, code: 'boom', error: '循环' }
  cyclic.self = cyclic
  const text = renderToolText('flow_task', cyclic, 'update')
  assert.equal(typeof text, 'string')
  assert.match(text, HAS_CJK, '失败形状本身仍要渲染成中文报告')
  assert.doesNotThrow(() => renderToolText('flow_task', undefined, 'list'))
})

test('toolOutput(name)：schema 不动，render 产出单个 text 块', () => {
  const output = toolOutput('flow_task')
  assert.deepEqual(output.schema, { type: 'object' }, 'schema 一个字段都不许动')
  const blocks = output.render({ action: 'list' }, { root: '/r', total: 0, items: [], counts: { active: 0 } })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.equal(typeof blocks[0].text, 'string')
})

test('toolOutput() 无参兼容：走兜底 JSON，不抛', () => {
  const blocks = toolOutput().render({}, { a: 1 })
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[0].text, JSON.stringify({ a: 1 }, null, 2))
})


// ---------------------------------------------------------------- 空态

test('空态：列表为空时给中文空态，不是空文本也不是裸 JSON', () => {
  const text = renderToolText(
    'flow_task',
    { root: '/r', store: true, total: 0, counts: { draft: 0, active: 0 }, current: null, items: [] },
    'list',
  )
  assert.doesNotMatch(text, BARE_JSON, '空态不能是一坨 JSON')
  assert.match(text, HAS_CJK)
  assert.match(text, /没有任务/, '空态要说明「没有」并且给出下一步')
})

test('空态：store 缺失时把 note 原样带出来（指向 init）', () => {
  const note = 'no flow store in this workspace; run: node bin/flow.mjs init'
  const text = renderToolText(
    'flow_task',
    { root: '/r', store: false, total: 0, counts: {}, current: null, items: [], note },
    'list',
  )
  assert.match(text, /node bin\/flow\.mjs init/, 'note 里的补救命令不能丢')
})

// ---------------------------------------------------------------- 列表 / 单条 / 截断

test('列表：每项一行（id + 标题 + 阶段中文名），首行是摘要，不含裸 JSON', () => {
  const value = {
    root: '/r',
    store: true,
    total: 2,
    counts: { draft: 0, active: 1, done: 1, archived: 0, other: 0 },
    current: null,
    items: [
      { id: 'T-1', title: '修渲染', type: 'fix', stage: 'implementing', status: 'active' },
      { id: 'T-2', title: '写文档', type: 'docs', stage: 'done', status: 'done' },
    ],
  }
  const text = renderToolText('flow_task', value, 'list')
  assert.doesNotMatch(text, BARE_JSON)
  const lines = text.split('\n')
  assert.match(lines[0], /flow_task list/, '首行标明是哪个工具的哪个动作')
  assert.match(lines[0], /2/, '首行要带总数')
  const rows = lines.filter((line) => line.startsWith('- '))
  assert.equal(rows.length, 2, '每条记录一行')
  assert.match(rows[0], /T-1/)
  assert.match(rows[0], /修渲染/)
  assert.match(rows[0], /实现中/, '阶段显示中文名，不是裸 id')
  assert.match(rows[1], /已完成/)
  assert.equal(lines.filter((line) => line.includes('T-1')).length, 1, '一条记录只出现在一行里')
})

test('列表：计数只列非零项（0 不占版面，合计单独看）', () => {
  const text = renderToolText(
    'flow_task',
    {
      root: '/r',
      total: 1,
      counts: { draft: 0, active: 1, done: 0, archived: 0, other: 0 },
      current: null,
      items: [{ id: 'T-1', title: 'a', stage: 'analyzing' }],
    },
    'list',
  )
  assert.match(text, /进行中 1/)
  assert.doesNotMatch(text, /已归档 0/, '零值不占版面')
})

test('列表：超过 MAX_TOOL_ITEMS 时截断，并提示缩小范围', () => {
  const value = {
    root: '/r',
    total: MAX_TOOL_ITEMS + 5,
    counts: { active: MAX_TOOL_ITEMS + 5 },
    current: null,
    items: Array.from({ length: MAX_TOOL_ITEMS + 5 }, (_, i) => ({ id: `T-${i}`, title: 't', stage: 'done' })),
  }
  const text = renderToolText('flow_task', value, 'list')
  const rows = text.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(rows.length, MAX_TOOL_ITEMS, '最多渲染 MAX_TOOL_ITEMS 条')
  const tail = text.split('\n').at(-1)
  assert.match(tail, /还有 5 条/, '要说清还剩多少条')
  assert.match(tail, /flow_task list/, '要给出缩小范围的具体命令')
})

test('列表：truncated 标记为真时，即使条数没超上限也提示', () => {
  const text = renderToolText(
    'flow_task',
    { root: '/r', total: 3, counts: { active: 3 }, current: null, items: [{ id: 'T-1', title: 'a', stage: 'done' }], truncated: true },
    'list',
  )
  assert.match(text.split('\n').at(-1), /缩小范围/)
})

test('单条：固定字段顺序，长字段逐行展开，字段名不折成 JSON', () => {
  const value = {
    root: '/r',
    task: {
      id: 'T-9',
      title: '示例任务',
      type: 'fix',
      status: 'active',
      stage: 'implementing',
      owner: 'sess-1',
      notes: '第一行\n第二行',
      scope: { allow: ['lib/x.mjs'], deny: ['lib/mcp/'] },
      acceptance: ['cmd:node --test test/'],
      revision: 'abcdef0123456789',
    },
  }
  const text = renderToolText('flow_task', value, 'show')
  assert.doesNotMatch(text, BARE_JSON)
  const lines = text.split('\n')
  assert.match(lines[0], /T-9/)
  assert.match(lines[0], /示例任务/)
  // 固定字段顺序：id 在 title 之前，stage 在 notes 之前
  const idAt = text.indexOf('id：')
  const titleAt = text.indexOf('title：')
  const stageAt = text.indexOf('stage：')
  const notesAt = text.indexOf('notes：')
  assert.ok(idAt >= 0 && titleAt > idAt, 'id 在 title 之前')
  assert.ok(stageAt > titleAt, 'stage 在 title 之后')
  assert.ok(notesAt > stageAt, 'notes 在 stage 之后')
  assert.match(text, /第一行/, 'notes 首行要出现')
  assert.match(text, /第二行/, 'notes 后续行不丢')
  assert.match(text, /lib\/x\.mjs/, 'scope.allow 的每条要出现')
  assert.match(text, /cmd:node --test test\//, 'acceptance 的每条要出现')
  assert.match(text, /待实现|实现中/, 'stage 显示中文名')
})

test('单条：stage 中文名与原始 id 不重复显示两次', () => {
  const text = renderToolText('flow_task', { root: '/r', task: { id: 'T-1', title: 'a', stage: 'implementing' } }, 'show')
  const occurrences = text.split('implementing').length - 1
  assert.equal(occurrences, 0, '原始 stage id 不该再出现一次（已显示「实现中」）')
  assert.match(text, /实现中/)
})

// ---------------------------------------------------------------- 失败 / 纯函数

test('ok:false：✖ <code>：<message> 加一行「下一步」，不是 JSON', () => {
  const text = renderToolText(
    'flow_task',
    { ok: false, code: 'conflict', error: 'revision 已过期', nextAction: '重新 show 后重试' },
    'update',
  )
  assert.doesNotMatch(text, BARE_JSON)
  assert.match(text, /✖ conflict：revision 已过期/, '失败第一行是 ✖ code：message')
  assert.match(text, /下一步：重新 show 后重试/, '必须给出下一步')
})

test('ok:false：message 缺省时给出中文占位，而不是 undefined', () => {
  const text = renderToolText('flow_gate', { ok: false, code: 'io' }, 'run')
  assert.match(text, /✖ io：/)
  assert.doesNotMatch(text, /undefined/)
})

test('渲染不修改入参：深冻结的值也能渲染，且前后深相等', () => {
  const list = deepFreeze({
    root: '/r',
    store: true,
    total: 2,
    counts: { active: 2 },
    current: null,
    items: [
      { id: 'T-1', title: 'a', stage: 'implementing', notes: 'x\ny', acceptance: ['cmd:true'] },
      { id: 'T-2', title: 'b', stage: 'done', scope: { allow: ['lib/'] } },
    ],
  })
  const before = JSON.stringify(list)
  assert.doesNotThrow(() => renderToolText('flow_task', list, 'list'), '写入冻结对象会抛，这里不许抛')
  assert.equal(JSON.stringify(list), before, '渲染器必须只读入参')
})

test('渲染是确定性的：同一输入两次得到同一文本', () => {
  const value = { root: '/r', task: { id: 'T-1', title: 'a', stage: 'reviewing', notes: 'n' } }
  assert.equal(renderToolText('flow_task', value, 'show'), renderToolText('flow_task', value, 'show'))
})


// ---------------------------------------------------------------- 其余工具线各一笔

test('flow_status：首行摘要 + 计数 + 门禁结论，不含裸 JSON', () => {
  const text = renderToolText(
    'flow_status',
    {
      root: '/r',
      store: true,
      contract: { source: 'store', schema: 2, name: 'demo' },
      experiments: { total: 0, counts: { total: 0 } },
      tasks: { total: 3, counts: { draft: 1, active: 2 } },
      gates: [{ id: 'precommit', ok: true, at: '2026-11-12T10:00:00+08:00' }],
    },
    '',
  )
  assert.doesNotMatch(text, BARE_JSON)
  assert.match(text, HAS_CJK)
  assert.match(text, /flow_status/)
  assert.match(text, /precommit/)
  assert.match(text, /通过/, '门禁结论要中文')
})

test('flow_exp：列表走同一套列表渲染', () => {
  const text = renderToolText(
    'flow_exp',
    { root: '/r', total: 1, counts: { total: 1, open: 1 }, items: [{ id: 'E-1', title: '实验', status: 'open' }] },
    'list',
  )
  assert.doesNotMatch(text, BARE_JSON)
  assert.match(text, /E-1/)
  assert.match(text, /进行中/, '实验状态显示中文名')
})

test('flow_decision：空态与列表都走中文渲染', () => {
  const empty = renderToolText('flow_decision', { root: '/r', items: [], counts: { open: 0, total: 0 } }, 'list')
  assert.doesNotMatch(empty, BARE_JSON)
  assert.match(empty, HAS_CJK)
  const list = renderToolText(
    'flow_decision',
    { root: '/r', items: [{ id: 'D-1', kind: 'choice', status: 'open', question: '要不要继续？' }], counts: { open: 1, total: 1 } },
    'list',
  )
  assert.match(list, /D-1/)
  assert.match(list, /要不要继续/)
})

test('flow_gate：运行结果一跑一行，失败步带 ✖', () => {
  const text = renderToolText(
    'flow_gate',
    {
      root: '/r',
      run: {
        gate: 'precommit',
        ok: false,
        durationMs: 1200,
        started_at: '2026-11-12T10:00:00+08:00',
        finished_at: '2026-11-12T10:00:01+08:00',
        steps: [{ id: 'tests', expect: 'exit 0', ok: false, expectActual: 'exit 1', durationMs: 900 }],
      },
    },
    'run',
  )
  assert.doesNotMatch(text, BARE_JSON)
  assert.match(text, /precommit/)
  assert.match(text, /失败/)
  assert.match(text, /✖ tests/)
  assert.match(text, /exit 1/, '实际退出码要出现')
})

test('flow_heartbeat：心跳列表与单条状态都走中文', () => {
  const list = renderToolText(
    'flow_heartbeat',
    { root: '/r', workspace: '/r', store: true, dir: '.agents/heartbeat', items: [{ session: 's1', status: 'working', task: 'T-1' }], counts: { total: 1, active: 1, stale: 0, hidden: 0 }, warnings: [] },
    'list',
  )
  assert.doesNotMatch(list, BARE_JSON)
  assert.match(list, /s1/)
  const status = renderToolText(
    'flow_heartbeat',
    { root: '/r', store: true, session: 's1', active: true, record: { status: 'working', goal: '修渲染' }, warnings: [] },
    'status',
  )
  assert.doesNotMatch(status, BARE_JSON)
  assert.match(status, /活跃/)
})

test('BARE_JSON 探测器自检：JSON.stringify 的输出必须被判定为裸 JSON', () => {
  const json = JSON.stringify({ root: '/r', items: [] }, null, 2)
  assert.match(json, BARE_JSON, '探测器命中不了 JSON 的话，本文件的「不落兜底 JSON」断言都是恒真')
})

test('flow_subtask：子任务单条走中文摘要与字段渲染，不落兜底 JSON', () => {
  const text = renderToolText(
    'flow_subtask',
    {
      root: '/r',
      task: {
        id: 'T-20261112152355-01',
        title: '子任务渲染',
        type: 'fix',
        status: 'active',
        stage: 'implementing',
        parent: 'T-20261112151914',
        acceptance: ['cmd:node --test test/'],
      },
    },
    'show',
  )
  assert.doesNotMatch(text, BARE_JSON, '已登记形状不许落兜底 JSON')
  assert.match(text, HAS_CJK)
  assert.match(text, /T-20261112152355-01/)
  assert.match(text, /实现中/, '阶段显示中文名')
  assert.match(text, /cmd:node --test test\//, 'acceptance 每条要出现')
})

test('flow_veto：否决结果给出任务与决定，不落兜底 JSON', () => {
  const text = renderToolText(
    'flow_veto',
    {
      root: '/r',
      task: { id: 'T-20261112152356', title: '被否决的任务', stage: 'analyzing' },
      decision: { id: 'D-20261112120000', kind: 'choice', status: 'open' },
      created: true,
    },
    'veto',
  )
  assert.doesNotMatch(text, BARE_JSON, '已登记形状不许落兜底 JSON')
  assert.match(text, HAS_CJK)
  assert.match(text, /否决决定：D-20261112120000/, '决定 id 必须出现')
  assert.match(text, /（新建）/, 'created=true 要标出来')
})