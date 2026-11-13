// T-20261112152356 [S3] 端到端收口：工具输出渲染 + 派工模型。
//
// 这一层**不重复** S1/S2 的单模块断言（它们已各自覆盖渲染分支与 dispatchTaskRecord
// 的 agentOptions 形状）。本文件只钉「跨模块」的那一层：
//
// 1. 八条 flow_* 工具线在**真实注册面上**（tasks.js / gates.js / experiments.js /
//    index.js 的 apply）各自的 `output.render` 必须产出 text 块、首行是中文摘要，
//    且 `render` **不修改**传入的 value（宿主契约：规范值属于执行侧，render 只产人看的文本）。
//    依据：`grep "toolOutput('" lib` 命中 8 处（lib/host/tools.mjs 4 处 +
//    lib/tools/{tasks,experiments,gates,subtasks}.mjs 各 1 处）= 8 条工具线 8 个调用点；
//    MCP 包装器（flow_desc/check/doctor/backup/init/orchestrate，见 lib/cli/mcp-server.mjs）
//    是 CLI 的壳，不共用 toolOutput，不在本文件的断言范围。
// 2. 派工模型从 `config` 一路走到宿主 `subagents.startActivation` 的 request：
//    显式配置 model 时 agentOptions.model 必须正确；未配置时 request 里**一个
//    agentOptions 键都不能有**（零回归），且台账回执带上实际用的 model。
//
// 断言用「反向探测」写：不写死具体文案，只要求「有中文、不是 JSON、render 前后深度相等」，
// 这样 S1 迭代文案时用例不会因措辞变化而红，但行为被人为改回 JSON 时会立刻红。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { addTask, initProject, loadContract } from '../lib/core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const TEMP_ROOTS = []

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-e2e-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `e2e-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

after(async () => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言
    }
  }
})

/** 会记录每次 startActivation 的假宿主服务；默认返回递增 childId。 */
function fakeSubagents() {
  const calls = []
  return {
    calls,
    async startActivation(spec) {
      calls.push(spec)
      return { childId: `child-${calls.length}` }
    },
  }
}

/**
 * 最小宿主：只提供 toolOutput 渲染与派工要用的服务。
 *
 * `capabilities` 按真实形状并入：dsh-subagent 把 backend 能力声明挂在
 * **服务对象上**（`service.capabilities`），`ctx.get('subagents')` 返回的是
 * Service API，所以这里把声明并到 get 的返回值上。
 */
function makeHost(root, { subagents, config, capabilities } = {}) {
  const registered = new Map()
  const tools = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    guard() {
      return () => {}
    },
    get(name) {
      return registered.has(name) ? { name } : undefined
    },
  }
  const ctx = {
    get(name) {
      if (name === 'tools') return tools
      if (name === 'subagents') {
        if (subagents === null || subagents === undefined) return subagents
        return capabilities === undefined ? subagents : { ...subagents, capabilities }
      }
      if (name === 'workingDirectory') return { get: () => root }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // 卸载失败不影响断言
        }
      }
    },
    logger: { warn() {} },
  }
  const exec = { agent: { id: 'session-main', session: { cwd: root, header: { origin: 'main', delegationDepth: 0 } } } }
  return { ctx, exec, registered, tools }
}

/** 依次 apply 四个入口（与 index.js / tasks.js 的真实装配一致）。 */
async function mountAll(ctx, config) {
  const { apply } = await import('../index.js')
  const { apply: applyTasks } = await import('../tasks.js')
  const { apply: applyGates } = await import('../gates.js')
  const { apply: applyExperiments } = await import('../experiments.js')
  apply(ctx, config)
  applyTasks(ctx, config)
  applyGates(ctx, config)
  applyExperiments(ctx, config)
}

/**
 * 八条 flow_* 工具线（MCP 包装器不在内：它是 CLI 的壳，不共用 toolOutput）。
 *
 * 数量的真源是注册面本身：`grep "toolOutput('" lib` 命中 8 处，对应 8 条工具线、
 * 8 个调用点（早前写「九个」是笔误）。第 9 条工具若出现，下面的注册面自证用例会红，
 * 而不是静默漏测。
 */
const FLOW_TOOL_LINES = [
  'flow_status',
  'flow_task',
  'flow_subtask',
  'flow_gate',
  'flow_exp',
  'flow_decision',
  'flow_heartbeat',
  'flow_veto',
]

/* ------------------------------------------------------------------ 渲染层 */

/** 递归深拷贝：用来证明 render 没改动传入的 value。 */
function deepFreezeClone(value) {
  return structuredClone(value)
}

/**
 * 这批用例的最小契约：
 * - render 返回 ContentBlock[]，且含至少一个 `{type:'text', text}`；
 * - 文本**不是**整段 JSON（首字符不是 `{`/`[` 且不是 JSON.parse 得通的串）；
 * - 首行是中文摘要（含中日韩统一表意文字，且不是「{"...」这类键名行）；
 * - render 前后 value 深度相等（不许就地改写），且 render 可重入（同值两次同文本）。
 */
function assertReadableReport(name, definition, value, action) {
  assert.equal(typeof definition.output?.render, 'function', `${name} 必须有 output.render`)
  const before = deepFreezeClone(value)
  const blocks = definition.output.render({ action }, value)

  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} render 必须返回非空 ContentBlock[]`)
  const textBlock = blocks.find((block) => block !== null && typeof block === 'object' && block.type === 'text')
  assert.ok(textBlock, `${name} render 必须产出 {type:'text'} 块`)
  assert.equal(typeof textBlock.text, 'string')
  assert.ok(textBlock.text.length > 0, `${name} 渲染文本不能为空`)

  const firstLine = textBlock.text.split('\n')[0]
  assert.match(firstLine, /[\u4e00-\u9fff]/, `${name} 首行必须是中文摘要，实际：${firstLine}`)

  // 首行不能是 JSON 键值行（`{ "root": ...}` 这类）。
  assert.doesNotMatch(firstLine.trim(), /^[{[]/, `${name} 首行不应是 JSON，实际：${firstLine}`)

  // 整段也不应是「可直接 parse 的 JSON」——兜底 JSON 只允许出现在落不到登记形状时，
  // 这批用例给的都是**已登记形状**，所以不允许走兜底。
  assert.throws(
    () => JSON.parse(textBlock.text),
    `${name} 对已登记形状不应回落整段 JSON，实际首行：${firstLine}`,
  )

  // render 不得修改传入的 value（宿主契约：规范值归执行侧）。
  assert.deepEqual(value, before, `${name} render 不得修改传入的 value`)

  // 可重入：同输入同输出（纯函数，不读时间/随机数）。
  const again = definition.output.render({ action }, value)
  assert.equal(again.find((block) => block.type === 'text').text, textBlock.text, `${name} render 必须可重入`)
  return textBlock.text
}

test('渲染端到端：八条 flow_* 工具都在真实注册面上，且都用带名字的 output.render', async () => {
  const { root } = freshProject('render-register')
  const { ctx, registered } = makeHost(root, { subagents: fakeSubagents() })
  await mountAll(ctx, {})

  for (const name of FLOW_TOOL_LINES) {
    const definition = registered.get(name)
    assert.ok(definition, `插件应注册 ${name}`)
    assert.equal(typeof definition.output?.render, 'function', `${name} 必须有 output.render`)
    assert.deepEqual(definition.output.schema, { type: 'object' }, `${name} schema 不许改（机器可读性靠它）`)
  }
})

/**
 * 注册面自证：工具线数量不靠人记，靠注册面枚举。
 *
 * 插件侧 flow_* 必须**恰好**是期望的八条：多一条（新人加了工具却没接 render/没进本文件）
 * 或少一条（注册丢失）都会红。MCP 包装器是独立的 CLI 壳（lib/cli/mcp-server.mjs），
 * 不挂在这个注册面上，显式排除并断言它们没有混进来。
 */
const MCP_WRAPPER_ONLY = ['flow_desc', 'flow_check', 'flow_doctor', 'flow_backup', 'flow_init', 'flow_orchestrate']

test('渲染端到端：注册面自证 flow_* 恰好八条（多一条或少一条都红）', async () => {
  const { root } = freshProject('render-registry')
  const { ctx, registered } = makeHost(root, { subagents: fakeSubagents() })
  await mountAll(ctx, {})

  const pluginFlowLines = [...registered.keys()].filter((name) => name.startsWith('flow_')).sort()
  assert.deepEqual(
    pluginFlowLines.filter((name) => MCP_WRAPPER_ONLY.includes(name)),
    [],
    'MCP 包装器是 CLI 的壳，不该出现在插件工具注册面上',
  )
  assert.deepEqual(
    pluginFlowLines,
    [...FLOW_TOOL_LINES].sort(),
    '插件侧 flow_* 工具线必须恰好八条：新增工具要同步接 render 并加入 FLOW_TOOL_LINES',
  )
})

test('渲染端到端：空态与列表形状都产出中文可读报告，且不改 value', async () => {
  const { root } = freshProject('render-shapes')
  const { ctx, registered } = makeHost(root, { subagents: fakeSubagents() })
  await mountAll(ctx, {})

  // 空态：清单为空 → 中文空态文案，不是 `[]` / `{"items":[]}`。
  const emptyShapes = {
    flow_task: { root, action: 'list', ok: true, total: 0, counts: { total: 0 }, items: [] },
    flow_gate: { root, store: true, ok: true, gates: [] },
    flow_exp: { root, store: true, ok: true, total: 0, counts: { total: 0, open: 0 }, items: [] },
    flow_decision: { root, store: true, ok: true, items: [], counts: { open: 0, total: 0 } },
  }
  for (const [name, value] of Object.entries(emptyShapes)) {
    const definition = registered.get(name)
    const text = assertReadableReport(name, definition, value, 'list')
    assert.match(text, /[\u4e00-\u9fff]/, `${name} 空态要是中文`)
  }

  // 列表形状：两条记录 → 每项有 id，且首行是计数摘要。
  const listValue = {
    root,
    action: 'list',
    ok: true,
    total: 2,
    counts: { total: 2, active: 2 },
    items: [
      { id: 'T-20261112000001', title: '第一个任务', type: 'feat', status: 'active', stage: 'analyzing' },
      { id: 'T-20261112000002', title: '第二个任务', type: 'fix', status: 'active', stage: 'implementing' },
    ],
  }
  const text = assertReadableReport('flow_task', registered.get('flow_task'), listValue, 'list')
  assert.match(text, /T-20261112000001/, '列表项必须带 id')
  assert.match(text, /T-20261112000002/)
})

/**
 * 剩余四条工具线的真实登记形状。
 *
 * flow_subtask / flow_veto 的渲染分支有早退（`lines.length > 1` / `isPlainObject(value.task)`），
 * 形状稍偏就会落回兜底 JSON——所以这里必须给真实值并断言「首行中文、不是 JSON 开头」
 * （assertReadableReport 内的 JSON.parse 必须抛 就是这条底线）。
 */
test('渲染端到端：status / heartbeat / subtask / veto 四条工具线的真实形状都是中文报告', async () => {
  const { root } = freshProject('render-rest')
  const { ctx, registered } = makeHost(root, { subagents: fakeSubagents() })
  await mountAll(ctx, {})

  const shapes = {
    flow_status: {
      root,
      store: true,
      contract: { source: 'store', schema: 2, name: 'demo' },
      experiments: { total: 0, counts: { total: 0 } },
      tasks: { total: 1, counts: { active: 1 } },
      gates: [{ id: 'precommit', ok: true, at: '2026-11-12T10:00:00+08:00' }],
    },
    flow_heartbeat: {
      root,
      workspace: root,
      store: true,
      dir: '.agents/heartbeat',
      items: [{ session: 's1', status: 'working', task: 'T-1' }],
      counts: { total: 1, active: 1, stale: 0, hidden: 0 },
      warnings: [],
    },
    flow_subtask: {
      root,
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
    flow_veto: {
      root,
      task: { id: 'T-20261112152356', title: '被否决的任务', stage: 'analyzing' },
      decision: { id: 'D-20261112120000', kind: 'choice', status: 'open' },
      created: true,
    },
  }

  const actions = { flow_status: '', flow_heartbeat: 'list', flow_subtask: 'show', flow_veto: 'veto' }
  const markers = {
    flow_status: /flow_status/,
    flow_heartbeat: /s1/,
    flow_subtask: /T-20261112152355-01/,
    flow_veto: /否决决定：D-20261112120000/,
  }

  const rendered = {}
  for (const [name, value] of Object.entries(shapes)) {
    rendered[name] = assertReadableReport(name, registered.get(name), value, actions[name])
    assert.match(rendered[name], markers[name])
  }
  assert.match(rendered.flow_subtask, /实现中/, 'stage 显示中文名')
  assert.match(rendered.flow_heartbeat, /条心跳/, '首行要说明心跳条数')
})

test('渲染端到端：失败结果给出 ✖ 摘要 + 下一步，而不是一坨 JSON', async () => {
  const { root } = freshProject('render-error')
  const { ctx, registered } = makeHost(root, { subagents: fakeSubagents() })
  await mountAll(ctx, {})

  const failure = { ok: false, code: 'conflict', error: '任务已被推进到「实现中」，放弃本次写入', nextAction: '用 flow_task show 核对最新状态' }
  const text = assertReadableReport('flow_task', registered.get('flow_task'), failure, 'update')
  assert.match(text, /conflict|冲突/, '失败要暴露错误码')
  assert.match(text, /下一步/, '失败要给下一步')
})

test('渲染端到端：未登记形状回落 JSON（永不丢信息），且不抛错', async () => {
  const { root } = freshProject('render-fallback')
  const { ctx, registered } = makeHost(root, { subagents: fakeSubagents() })
  await mountAll(ctx, {})

  const definition = registered.get('flow_task')
  // 一个绝对不认识的形状：渲染器必须兜底成 JSON，而不是抛错或输出空串。
  const weird = { root, unknownShape: { nested: [1, 2, { deep: true }] } }
  const before = deepFreezeClone(weird)
  const blocks = definition.output.render({ action: 'nope' }, weird)
  const text = blocks.find((block) => block.type === 'text').text
  assert.ok(text.trim().length > 0, '兜底不能是空文本')
  assert.doesNotThrow(() => JSON.parse(text), '未登记形状必须能 JSON.parse（信息不丢）')
  assert.deepEqual(weird, before, '兜底路径同样不许改 value')
})

/* -------------------------------------------------------------- 断言自身的反向自检 */

/**
 * 反向自检：把 render 人为退回 JSON.stringify，assertReadableReport 必须抛。
 *
 * 没有这条，就不可能证明上面那批「首行中文 / 不是 JSON」断言不是恒真。
 */
test('反向自检：render 退回 JSON.stringify 时 assertReadableReport 必须抛（断言不是恒真）', () => {
  const broken = {
    name: 'flow_task',
    output: {
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
  }
  assert.throws(
    () => assertReadableReport('flow_task', broken, { root: '/r', store: true, total: 0, counts: {}, items: [] }, 'list'),
    /首行必须是中文摘要|不应是 JSON|不应回落整段 JSON/,
    '若这句不抛，说明 e2e 的正向断言形同虚设',
  )
})

/* ------------------------------------------------------------------ 派工层 */

const MODEL_CAPABLE = { agentOptions: true }

test('派工端到端：显式配置 dispatch.model → startActivation 收到 agentOptions.model，回执带 model', async () => {
  const { root, contract } = freshProject('e2e-model')
  const task = addTask(root, contract, { type: 'feat', title: '端到端派工', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  const { ctx, exec, registered } = makeHost(root, {
    subagents,
    capabilities: MODEL_CAPABLE,
    config: { dispatch: { model: 'longcat-2.5-free' } },
  })
  await mountAll(ctx, { dispatch: { model: 'longcat-2.5-free' } })

  const result = await registered.get('flow_task').execute({ action: 'dispatch', id: task.id, root }, exec)

  assert.equal(subagents.calls.length, 1, '必须恰好起一个子代理')
  const spec = subagents.calls[0]
  assert.deepEqual(spec.request.agentOptions, { model: 'longcat-2.5-free' }, '模型必须进 request.agentOptions')
  assert.equal(Object.hasOwn(spec.request.agentOptions, 'provider'), false, 'provider 不塞进 agentOptions')
  assert.equal(spec.provider, 'spawn', 'provider 仍走顶层')
  assert.equal(result.dispatch.model, 'longcat-2.5-free', '结果回报实际用的模型')
  const receipt = [...result.task.checkpoints].reverse().find((item) => item.kind === 'dispatch')
  assert.equal(receipt.model, 'longcat-2.5-free', '回执记录实际用的模型')
})

test('派工端到端：不配置 model/models → request 里没有 agentOptions（零回归），回执不带 model', async () => {
  const { root, contract } = freshProject('e2e-no-model')
  const task = addTask(root, contract, { type: 'feat', title: '不配模型派工', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  /* 关键组合：宿主**具备**按模型起的能力，但配置没写 model——
     实现里一旦「贴心地」补个默认模型，本用例立刻红。 */
  const { ctx, exec, registered } = makeHost(root, { subagents, capabilities: MODEL_CAPABLE })
  await mountAll(ctx, {})

  const result = await registered.get('flow_task').execute({ action: 'dispatch', id: task.id, root }, exec)

  assert.equal(subagents.calls.length, 1)
  assert.equal(
    Object.hasOwn(subagents.calls[0].request, 'agentOptions'),
    false,
    '零回归：没声明模型时 request 绝不能出现 agentOptions 键',
  )
  assert.equal(
    Object.hasOwn(subagents.calls[0], 'agentOptions'),
    false,
    'agentOptions 只在 request 里，不在 startActivation 顶层',
  )
  assert.equal(result.dispatch.model, '', '实际用的是父模型')
  const plainReceipt = [...result.task.checkpoints].reverse().find((item) => item.kind === 'dispatch')
  assert.equal(Object.hasOwn(plainReceipt, 'model'), false, '没配模型时回执不写 model 键')
})

test('派工端到端：models 按角色覆盖，reviewer 用覆盖值、实现者回落 model', async () => {
  const { root, contract } = freshProject('e2e-role-model')
  const config = { dispatch: { model: 'iceman-contributor-free', models: { reviewer: 'longcat-2.5-free' } } }
  const subagents = fakeSubagents()
  const { ctx, exec, registered } = makeHost(root, { subagents, capabilities: MODEL_CAPABLE, config })
  await mountAll(ctx, config)

  const impl = addTask(root, contract, { type: 'feat', title: '实现者', stage: 'queued-implementation' })
  await registered.get('flow_task').execute({ action: 'dispatch', id: impl.id, root }, exec)
  assert.equal(subagents.calls.at(-1).request.agentOptions.model, 'iceman-contributor-free', '未覆盖角色回落 dispatch.model')

  const review = addTask(root, contract, { type: 'feat', title: '审查者', stage: 'queued-review' })
  await registered.get('flow_task').execute({ action: 'dispatch', id: review.id, root }, exec)
  assert.equal(subagents.calls.at(-1).request.agentOptions.model, 'longcat-2.5-free', 'models.reviewer 覆盖 dispatch.model')
})

test('派工端到端：宿主不支持 agentOptions → 降级按父模型起，不失败', async () => {
  const { root, contract } = freshProject('e2e-degrade')
  const task = addTask(root, contract, { type: 'feat', title: '降级派工', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  /* 没有 capabilities 声明的老 backend：会**静默忽略** agentOptions，所以实现必须自己探测。 */
  const config = { dispatch: { model: 'longcat-2.5-free' } }
  const { ctx, exec, registered } = makeHost(root, { subagents, config })
  await mountAll(ctx, config)

  const result = await registered.get('flow_task').execute({ action: 'dispatch', id: task.id, root }, exec)

  assert.equal(subagents.calls.length, 1, '能力缺失也要照常派工（降级不失败）')
  assert.equal(Object.hasOwn(subagents.calls[0].request, 'agentOptions'), false, '不支持时不带 agentOptions')
  assert.equal(result.dispatch.model, '', '回执 model 为空 = 实际用父模型')
  assert.match(String(result.dispatch.degraded ?? ''), /agentOptions/, '结果要说明降级原因')
  assert.equal(result.task.stage, 'analyzing', '降级不影响阶段推进')
})
