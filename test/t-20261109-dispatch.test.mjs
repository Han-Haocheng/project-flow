// P3b 派工器（D-20261109-01 = implement-p3b）：阶段 → 角色子代理 → 回执。
//
// 这组用例锁三件事：
// 1. 纯函数（plan/prompt/checkpoint）按 `lib/stage.mjs` 的 queued-* 入口映射；
// 2. `flow_task dispatch` 真的调用宿主 `subagents.startActivation`，并把任务推进到
//    working 阶段、把 childId 写进 `checkpoints`（主会话自己从不碰 spawn 工具）；
// 3. 服务缺失/配置关闭/宿主报错都不会留下半截状态。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { addTask, getTask, initProject, loadContract } from '../lib/core.mjs'
import { apply as applyTasks } from '../tasks.js'
import {
  DISPATCH_ROLES,
  WORKING_STAGE,
  dispatchCheckpoint,
  dispatchEnabled,
  dispatchPlan,
  dispatchPrompt,
  dispatchProvider,
} from '../lib/dispatch.mjs'

const TEMP_ROOTS = []

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-dispatch-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `dispatch-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

/** 会记录每次 startActivation 的假宿主服务；默认返回递增 childId。 */
function fakeSubagents(fail = false) {
  const calls = []
  return {
    calls,
    async startActivation(spec) {
      calls.push(spec)
      if (fail) throw new Error('provider exploded')
      return { childId: `child-${calls.length}` }
    },
  }
}

/** 最小宿主：tools 注册面 + workingDirectory + 可选 subagents。 */
function makeHost(root, { subagents, config } = {}) {
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
      if (name === 'subagents') return subagents
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
  applyTasks(ctx, config)
  const tool = registered.get('flow_task')
  assert.ok(tool, 'flow_task 应注册')
  const exec = { agent: { id: 'session-main', session: { cwd: root, header: { origin: 'main', delegationDepth: 0 } } } }
  return { tool, exec }
}

test('派工映射：只有 queued-* 可派，角色/working 阶段与 stage 表一致', () => {
  assert.deepEqual(DISPATCH_ROLES, {
    'queued-analysis': 'analyzer',
    'queued-implementation': 'implementer',
    'queued-review': 'reviewer',
  })
  for (const [stage, role] of Object.entries(DISPATCH_ROLES)) {
    const plan = dispatchPlan({ id: 'T-1', stage, title: 'x', type: 'feat' })
    assert.equal(plan.ok, true)
    assert.equal(plan.role, role)
    assert.equal(plan.workingStage, WORKING_STAGE[stage])
  }
  for (const stage of ['created', 'analyzing', 'implementing', 'reviewing', 'done', 'archived']) {
    const plan = dispatchPlan({ id: 'T-1', stage, title: 'x' })
    assert.equal(plan.ok, false, `${stage} 不该可派工`)
    assert.match(plan.reason, /只有待分析\/待实现\/待审查可以派工/)
  }
  assert.equal(dispatchPlan({ id: 'T-2', stage: 'queued-analysis', parent: 'T-1' }).ok, false, '子任务跟随父任务')
})

test('配置：dispatch 默认开，false 关闭，provider 空值回落 spawn', () => {
  assert.equal(dispatchEnabled(undefined), true)
  assert.equal(dispatchEnabled({}), true)
  assert.equal(dispatchEnabled({ dispatch: { enabled: false } }), false)
  assert.equal(dispatchEnabled({ dispatch: false }), false)
  assert.equal(dispatchProvider(undefined), 'spawn')
  assert.equal(dispatchProvider({ dispatch: { provider: '  ' } }), 'spawn')
  assert.equal(dispatchProvider({ dispatch: { provider: ' fork ' } }), 'fork')
})

test('提示词：带仓库/任务/验收/职责/纪律，子代理零上下文也能独立开工', () => {
  const analyzer = dispatchPrompt(
    { id: 'T-1', title: '加个派工器', type: 'feat', stage: 'queued-analysis', notes: '背景说明', acceptance: ['测试全绿'], scope: { allow: ['lib/dispatch.mjs'] } },
    { root: '/repo' },
  )
  assert.match(analyzer, /分析子代理/)
  assert.match(analyzer, /T-1/)
  assert.match(analyzer, /加个派工器/)
  assert.match(analyzer, /仓库根：\/repo/)
  assert.match(analyzer, /测试全绿/)
  assert.match(analyzer, /lib\/dispatch\.mjs/)
  assert.match(analyzer, /任务书/)
  assert.match(analyzer, /不要 git push/)
  const reviewer = dispatchPrompt({ id: 'T-2', title: 'x', stage: 'queued-review' })
  assert.match(reviewer, /审查子代理/)
  assert.match(reviewer, /五条清单/)
  assert.equal(dispatchCheckpoint({ childId: 'c1', role: 'analyzer' }).kind, 'dispatch')
  assert.throws(() => dispatchCheckpoint({ role: 'analyzer' }), /缺少 childId/)
})

test('flow_task dispatch：起子代理 + 走 plugin 边到 working + 写回执', async () => {
  const { root, contract } = freshProject('ok')
  const task = addTask(root, contract, { type: 'feat', title: '派工测试', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents })
  const result = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(subagents.calls.length, 1, '恰好起一个子代理')
  const spec = subagents.calls[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.request.parent, exec.agent, '父会话是调用者本人')
  assert.equal(spec.request.cwd, root)
  assert.match(spec.request.prompt[0].text, /派工测试/)
  assert.match(spec.label, new RegExp(task.id))
  assert.equal(result.task.stage, 'analyzing', '插件走 queued-analysis → analyzing')
  assert.equal(result.dispatch.childId, 'child-1')
  const checkpoints = result.task.checkpoints
  assert.equal(checkpoints.length, 1)
  assert.equal(checkpoints[0].kind, 'dispatch')
  assert.equal(checkpoints[0].role, 'analyzer')
  assert.equal(checkpoints[0].childId, 'child-1')
  // 已在 working 阶段：再派一次要被拒绝，避免第二个 worker
  await assert.rejects(() => tool.execute({ action: 'dispatch', id: task.id, root }, exec), /只有待分析\/待实现\/待审查可以派工/)
})

test('flow_task dispatch：宿主没有 subagents 服务 / 关闭配置 / provider 失败都拒绝且台账不动', async () => {
  const { root, contract } = freshProject('reject')
  const task = addTask(root, contract, { type: 'feat', title: '不可派', stage: 'queued-analysis' })

  const noService = makeHost(root, {})
  await assert.rejects(() => noService.tool.execute({ action: 'dispatch', id: task.id, root }, noService.exec), /没有 subagents 服务/)

  const disabled = makeHost(root, { subagents: fakeSubagents(), config: { dispatch: { enabled: false } } })
  await assert.rejects(() => disabled.tool.execute({ action: 'dispatch', id: task.id, root }, disabled.exec), /已被禁用/)

  const failing = makeHost(root, { subagents: fakeSubagents(true) })
  await assert.rejects(() => failing.tool.execute({ action: 'dispatch', id: task.id, root }, failing.exec), /派工失败（provider=spawn）：provider exploded/)

  assert.equal(getTask(root, contract, task.id).stage, 'queued-analysis', '失败时阶段不得被推进')
  assert.deepEqual(getTask(root, contract, task.id).checkpoints, [], '失败时不得写回执')
})

test('flow_task dispatch：provider/配置透传，dispatch 不碰其它字段', async () => {
  const { root, contract } = freshProject('provider')
  const task = addTask(root, contract, { type: 'fix', title: '指定 provider', stage: 'queued-review' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents, config: { dispatch: { provider: 'fork' } } })
  const result = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(subagents.calls[0].provider, 'fork')
  assert.equal(result.task.stage, 'reviewing')
  assert.equal(result.dispatch.role, 'reviewer')
  assert.equal(result.task.title, '指定 provider', '派工不改标题')
  assert.equal(result.task.owner, '', '派工不改 owner')
})

test('阶段入口自动派工：update 推进到 queued-* 时插件直接起角色子代理', async () => {
  const { root, contract } = freshProject('auto')
  const task = addTask(root, contract, { type: 'feat', title: '自动派工', stage: 'created' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents })
  const result = await tool.execute({ action: 'update', id: task.id, stage: 'queued-analysis', root }, exec)
  assert.equal(subagents.calls.length, 1, '推进到 queued-analysis 应自动派一个分析子代理')
  assert.equal(subagents.calls[0].provider, 'spawn')
  assert.match(subagents.calls[0].request.prompt[0].text, /自动派工/)
  assert.equal(result.task.stage, 'analyzing', '插件随即走 plugin 边到 working 阶段')
  assert.equal(result.dispatch.auto, true)
  assert.equal(result.dispatch.role, 'analyzer')
  assert.equal(result.task.checkpoints.at(-1).kind, 'dispatch')
})

test('阶段入口自动派工：只改 notes / 建卡不触发；auto=false 关闭自动只留显式 dispatch', async () => {
  const { root, contract } = freshProject('auto-off')
  const task = addTask(root, contract, { type: 'fix', title: '只改备注', stage: 'created' })
  const subagents = fakeSubagents()
  const host = makeHost(root, { subagents })
  const noStage = await host.tool.execute({ action: 'update', id: task.id, notes: '只改备注', root }, host.exec)
  assert.equal(subagents.calls.length, 0, '只改 notes 不派工')
  assert.equal(noStage.dispatch, undefined, '没有 dispatch 字段')
  assert.equal(noStage.task.stage, 'created')

  const off = makeHost(root, { subagents: fakeSubagents(), config: { dispatch: { auto: false } } })
  const queued = await off.tool.execute({ action: 'update', id: task.id, stage: 'queued-analysis', root }, off.exec)
  assert.equal(queued.task.stage, 'queued-analysis', 'auto=false 时不替调用方推进阶段')
  assert.equal(queued.dispatch, undefined)
})

test('阶段入口自动派工：宿主派工失败不拖垮 update，结果里带 ok:false 与原因', async () => {
  const { root, contract } = freshProject('auto-fail')
  const task = addTask(root, contract, { type: 'fix', title: '失败不拖垮', stage: 'created' })
  const failing = fakeSubagents(true)
  const { tool, exec } = makeHost(root, { subagents: failing })
  const result = await tool.execute({ action: 'update', id: task.id, stage: 'queued-analysis', root }, exec)
  assert.equal(result.task.stage, 'queued-analysis', '派工失败时阶段保持 queued-analysis')
  assert.equal(result.dispatch.auto, true)
  assert.equal(result.dispatch.ok, false)
  assert.match(result.dispatch.error, /派工失败（provider=spawn）/ )
  assert.equal(getTask(root, contract, task.id).stage, 'queued-analysis')
})

test('阶段入口自动派工：queued-review 起 reviewer，派工成功才写回执', async () => {
  const { root, contract } = freshProject('auto-review')
  const task = addTask(root, contract, { type: 'docs', title: '待审', stage: 'implementing' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents })
  const result = await tool.execute({ action: 'update', id: task.id, stage: 'queued-review', root }, exec)
  assert.equal(subagents.calls.length, 1)
  assert.equal(result.dispatch.role, 'reviewer')
  assert.equal(result.task.stage, 'reviewing')
  assert.equal(result.task.checkpoints.length, 1)
})
