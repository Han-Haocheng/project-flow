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
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  addTask,
  assertDescriptionGate,
  buildDescription,
  listDescriptionFiles,
  drainWarnings,
  getTask,
  initProject,
  loadContract,
  updateTask,
} from '../lib/core.mjs'
import {
  STAGE_EDGE_DOCTRINE,
  STAGE_MACHINE,
  actorForEdge,
  assertTransition,
  canTransition,
  edgeOf,
  nextStages,
  stageNextStep,
} from '../lib/stage.mjs'
import { apply as applyTasks } from '../tasks.js'
import * as core from '../lib/core.mjs'
import {
  DEFAULT_DISPATCH_MODEL,
  DISPATCH_ROLES,
  WORKING_STAGE,
  autoDispatchEnabled,
  autoDispatchTask,
  dispatchCheckpoint,
  dispatchEnabled,
  dispatchModel,
  dispatchModelExplicit,
  dispatchModelRequired,
  dispatchPlan,
  dispatchPrompt,
  dispatchProvider,
  dispatchRoleModel,
  closeDispatchedChild,
  dispatchTaskRecord,
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

/**
 * 最小宿主：tools 注册面 + workingDirectory + 可选 subagents。
 * `capabilities` 是 hosts 的真实形状：dsh-subagent 的 backend 能力声明**挂在服务
 * 对象上**（`service.capabilities`），而 `ctx.get('subagents')` 按 API 约定只给
 * Service API（startActivation 等）。所以这里把声明的能力并到 get 返回的对象上，
 * 与真实宿主一致。
 */
function lastDispatchReceipt(task) {
  const list = task !== null && task !== undefined && Array.isArray(task.checkpoints) ? task.checkpoints : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index] !== null && list[index] !== undefined && list[index].kind === 'dispatch') return list[index]
  }
  return null
}

function finishRound(root, contract, id) {
  const task = getTask(root, contract, id)
  if (task === null || task === undefined) return
  const order = task.dispatch
  if (order === null || order === undefined || order.closedAt) return
  core.closeDispatch(root, contract, id, { outcome: 'ok' })
}

function makeHost(root, { subagents, team, config, capabilities, autoDefault = true } = {}) {
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
      if (name === 'agentTeams') return team
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
  /* T-20261113160505：插件自动派工默认关。本文件的用例验证的是自动派工链路，
     所以夹具默认把它打开；显式传入的 config 里没有 dispatch 段时补 auto:true；要断言
     「默认就是关」的用例传 `autoDefault: false`。 */
  const resolved =
    config === undefined
      ? autoDefault === true
        ? { dispatch: { auto: true } }
        : {}
      : config.dispatch === undefined
        ? { ...config, dispatch: { auto: true } }
        : config
  applyTasks(ctx, resolved)
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
  assert.equal(dispatchPlan({ id: 'T-2', stage: 'queued-analysis', parent: 'T-1' }).ok, true, '子任务各自派工（2026-11-11 流程）')
})

test('配置：dispatch 默认开（显式动作），auto 默认关，provider 空值回落 spawn', () => {
  assert.equal(dispatchEnabled(undefined), true)
  assert.equal(dispatchEnabled({}), true)
  assert.equal(dispatchEnabled({ dispatch: { enabled: false } }), false)
  assert.equal(dispatchEnabled({ dispatch: false }), false)
  assert.equal(dispatchProvider(undefined), 'spawn')
  assert.equal(dispatchProvider({ dispatch: { provider: '  ' } }), 'spawn')
  assert.equal(dispatchProvider({ dispatch: { provider: ' fork ' } }), 'fork')
  /* T-20261113160505：自动派工默认关——缺失/空/非 true 一律 false，只有显式 true 才开。 */
  assert.equal(autoDispatchEnabled(undefined), false, '缺 config → 自动派工关')
  assert.equal(autoDispatchEnabled(null), false, 'null → 自动派工关')
  assert.equal(autoDispatchEnabled({}), false, '空 config → 自动派工关')
  assert.equal(autoDispatchEnabled({ dispatch: {} }), false, 'dispatch 段没有 auto → 自动派工关')
  assert.equal(autoDispatchEnabled({ dispatch: { auto: false } }), false, '显式 false 仍关')
  assert.equal(autoDispatchEnabled({ dispatch: { auto: 'yes' } }), false, '非布尔 true 不算开')
  assert.equal(autoDispatchEnabled({ dispatch: { auto: true } }), true, '显式 true 才开')
  assert.equal(
    autoDispatchEnabled({ dispatch: { enabled: false, auto: true } }),
    false,
    'enabled:false 连自动一起关（与语义）',
  )
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
  assert.match(analyzer, /开工前先 flow_task show 复核 stage/, '提示词要求开工前复核阶段（防 spawn 后卡被完成的窗口）')
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
  assert.equal(checkpoints.length, 2, 'dispatch（已闭合）+ claim（执行权）两条回执')
  assert.equal(checkpoints[0].kind, 'dispatch', '插件回执在前且已闭合')
  assert.equal(checkpoints[0].role, 'analyzer')
  assert.equal(checkpoints[0].childId, 'child-1')
  assert.equal(typeof checkpoints[0].closedAt, 'string')
  assert.equal(checkpoints[1].kind, 'claim', 'ack 的 open claim 必须是最后一条本角色回执')
  assert.equal(checkpoints[1].role, 'analyzer')
  assert.equal(checkpoints[1].agent, `analyzer:${task.id}`, 'agent 唯一化：role:taskId')
  assert.equal(checkpoints[1].session, 'child-1', 'ack 的执行权落在子会话上')
  assert.match(String(result.dispatch.order), /-r\d+-a\d+$/, '结果回报 round/attempt 工单号')
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
  assert.equal(result.task.owner, 'child-1', 'ack 取执行权：owner 指向子会话')
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
  assert.equal(lastDispatchReceipt(result.task).kind, 'dispatch')
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

  /* T-20261113160505：不传 dispatch.auto 时（生产默认）也不自动派工。 */
  const plainSubagents = fakeSubagents()
  const plain = makeHost(root, { subagents: plainSubagents, autoDefault: false })
  const plainTask = addTask(root, contract, { type: 'fix', title: '默认不派工', stage: 'created' })
  const plainResult = await plain.tool.execute(
    { action: 'update', id: plainTask.id, stage: 'queued-analysis', root },
    plain.exec,
  )
  assert.equal(plainSubagents.calls.length, 0, '默认配置下不自动派工')
  assert.equal(plainResult.dispatch, undefined)
  assert.equal(plainResult.task.stage, 'queued-analysis', '不派工就不替调用方推进阶段')
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
  updateTask(root, contract, task.id, { checkpoints: [{ kind: 'dispatch', role: 'implementer', childId: 'fixture-impl', provider: 'test', from: 'queued-implementation', to: 'implementing', at: '2026-11-13T16:00:00+08:00' }] }, { source: 'internal' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents })
  const result = await tool.execute({ action: 'update', id: task.id, stage: 'queued-review', root }, exec)
  assert.equal(subagents.calls.length, 1)
  assert.equal(result.dispatch.role, 'reviewer')
  assert.equal(result.task.stage, 'reviewing')
  assert.equal(result.task.checkpoints.filter((item) => item.kind === 'dispatch' && item.role === 'reviewer').length, 1)
})

// ------------------------------------------ P3b 第二批：团队板自动挂载（默认 off）

function fakeTeam({ failCreate = false } = {}) {
  const calls = { create: [], update: [] }
  const rows = new Map()
  let seq = 0
  return {
    calls,
    rows,
    listMembers: () => [{ id: 'm1', name: 'lead', role: 'lead', status: 'idle' }],
    listTasks: () =>
      [...rows.values()].map((row) => ({ ...row, subject: 'x', blockedBy: [], writeScopes: [], ownerName: 'lead' })),
    async createTask(caller, request) {
      calls.create.push({ caller, request })
      if (failCreate) throw new Error('team create exploded')
      const id = `task-${++seq}`
      const row = { id, revision: 1, status: 'pending' }
      rows.set(id, row)
      return { ...row, subject: request.subject }
    },
    async updateTask(caller, request) {
      calls.update.push({ caller, request })
      const row = rows.get(request.taskId)
      if (row === undefined) throw new Error('team task not found')
      if (row.revision !== request.expectedRevision) throw new Error('stale revision')
      if (request.action === 'claim') row.status = 'in_progress'
      else if (request.action === 'complete') row.status = 'completed'
      row.revision += 1
      return { ...row }
    },
  }
}

test('团队板挂载：派工时建一次 + 领取一次，链接写回台账（config.team.mount=true）', async () => {
  const { root, contract } = freshProject('team-mount')
  const task = addTask(root, contract, {
    type: 'feat',
    title: '挂到团队板',
    stage: 'created',
    scope: { allow: ['lib/x.mjs'], deny: [] },
  })
  const subagents = fakeSubagents()
  const team = fakeTeam()
  const { tool, exec } = makeHost(root, { subagents, team, config: { team: { mount: true } } })
  const result = await tool.execute({ action: 'update', id: task.id, stage: 'queued-analysis', root }, exec)
  assert.equal(team.calls.create.length, 1, '建且只建一次板卡')
  assert.equal(team.calls.create[0].request.subject, '挂到团队板')
  assert.deepEqual(team.calls.create[0].request.writeScopes, ['lib/x.mjs'])
  assert.equal(team.calls.update.length, 1, '建后领取一次')
  assert.equal(team.calls.update[0].request.action, 'claim')
  assert.equal(result.dispatch.team.mounted, true)
  assert.equal(result.dispatch.team.taskId, 'task-1')
  assert.equal(result.task.team.taskId, 'task-1', '链接写回台账 team 字段')
  assert.equal(result.task.team.revision, 2, 'claim 后的 revision 落账')
})

test('团队板挂载：默认 off 不碰服务；create 失败不拖垮派工', async () => {
  const { root, contract } = freshProject('team-off')
  const task = addTask(root, contract, { type: 'fix', title: '不挂板', stage: 'created' })
  const off = makeHost(root, { subagents: fakeSubagents(), team: fakeTeam() })
  const result = await off.tool.execute({ action: 'update', id: task.id, stage: 'queued-analysis', root }, off.exec)
  assert.equal(off.tool && result.task.stage, 'analyzing', '派工照常')
  assert.equal(result.dispatch.team, undefined, '默认 off 不回报团队字段')

  const { root: root2, contract: contract2 } = freshProject('team-fail')
  const task2 = addTask(root2, contract2, { type: 'fix', title: '建板失败', stage: 'created' })
  const failing = makeHost(root2, { subagents: fakeSubagents(), team: fakeTeam({ failCreate: true }), config: { team: { mount: true } } })
  const failed = await failing.tool.execute({ action: 'update', id: task2.id, stage: 'queued-analysis', root: root2 }, failing.exec)
  assert.equal(failed.task.stage, 'analyzing', '建板失败不影响派工与阶段推进')
  assert.equal(failed.dispatch.team.mounted, false)
  assert.equal(failed.dispatch.team.reason, 'create-failed')
  assert.equal(getTask(root2, contract2, task2.id).team, undefined, '失败时不写链接')
})

test('团队板终态同步：任务到 done 时 complete 一次，未挂载/非 in_progress 不动', async () => {
  const { root, contract } = freshProject('team-complete')
  const task = addTask(root, contract, { type: 'docs', title: '完成后结板', stage: 'created' })
  const team = fakeTeam()
  const { tool, exec } = makeHost(root, { subagents: fakeSubagents(), team, config: { team: { mount: true } } })
  await tool.execute({ action: 'update', id: task.id, stage: 'queued-analysis', root }, exec)
  const done = await tool.execute({ action: 'update', id: task.id, stage: 'done', root }, exec)
  const completes = team.calls.update.filter((call) => call.request.action === 'complete')
  assert.equal(completes.length, 1, 'done 时 complete 一次')
  assert.equal(done.team.completed, true)
  assert.equal(team.rows.get('task-1').status, 'completed')
  // 幂等：再来一次不会重复 complete（板上已是 completed）
  const again = await tool.execute({ action: 'update', id: task.id, stage: 'done', root }, exec)
  assert.equal(again.team.completed, true)
  assert.equal(again.team.already, true)
  assert.equal(team.calls.update.filter((call) => call.request.action === 'complete').length, 1)
})

test('阶段入口自动派工：任务已停在 queued-analysis 时改 notes/owner 不再派第二个 worker', async () => {
  const { root, contract } = freshProject('auto-retry')
  const task = addTask(root, contract, { type: 'fix', title: '重试不派工', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents })
  const notes = await tool.execute({ action: 'update', id: task.id, notes: '补一条备注', root }, exec)
  assert.equal(subagents.calls.length, 0, '同一阶段的 notes 更新不得触发派工')
  assert.equal(notes.dispatch, undefined)
  assert.equal(notes.task.notes, '补一条备注')
  // 显式 dispatch 仍然可用（人工重试入口）
  const explicit = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(subagents.calls.length, 1)
  assert.equal(explicit.task.stage, 'analyzing')
})

// ------------------------------------------- T-20261111182128：派工不校验终态（竞态）
//
// 缺陷：`dispatchTaskRecord` 只对调用方手里那一份快照跑 `dispatchPlan`。快照与真正
// `startActivation` 之间隔了几轮异步（实测窗口约 3 秒），别人在这期间把卡推到 `done`
// 时插件照样起一个 reviewer/implementer。下面四条用例把三道闸钉死：
// ① 派工前重读、② 写回执前 CAS、③ 回到入口即新一轮（不做台账级复用）、④ 正常路径不受影响。

/** 直接调 `dispatchTaskRecord`（不走工具层），用于注入"派工途中改台账"的竞态。 */
function recordDeps(root, contract, subagents, task) {
  const host = makeHost(root, { subagents })
  return {
    deps: {
      c: core,
      ctx: { get: (name) => (name === 'subagents' ? subagents : undefined) },
      agent: host.exec.agent,
      root,
      contract,
      task,
      provider: 'spawn',
    },
  }
}

/** 一个会在 `startActivation` 里先改台账、再返回 childId 的假服务（模拟另一个会话）。 */
function racingSubagents(mutate) {
  const calls = []
  return {
    calls,
    async startActivation(spec) {
      calls.push(spec)
      mutate(calls.length)
      return { childId: `child-race-${calls.length}` }
    },
  }
}

test('派工不校验终态 ①：手里是旧快照、台账已到 done → 不起子代理，返回 conflict 与「已被推进到」', async () => {
  const { root, contract } = freshProject('race-done')
  const task = addTask(root, contract, { type: 'docs', title: '已完成的卡', stage: 'queued-review' })
  /* 旧快照：仍是 queued-review（子进程/另一会话刚把它推到 done 之前读的）。 */
  const stale = { ...task }
  updateTask(root, contract, task.id, { stage: 'done' }, { source: 'internal' })
  assert.equal(getTask(root, contract, task.id).stage, 'done')

  const subagents = fakeSubagents()
  const { deps } = recordDeps(root, contract, subagents, stale)
  const error = await dispatchTaskRecord(deps).then(() => null, (caught) => caught)
  assert.ok(error, '旧快照派工必须被拒')
  assert.equal(error.code, 'conflict', '与仓库既有错误码一致（并发修改 = conflict）')
  assert.match(error.message, /派工放弃/)
  assert.match(error.message, /已被推进到「已完成」/)
  assert.equal(subagents.calls.length, 0, '不得起子代理')

  const after = getTask(root, contract, task.id)
  assert.equal(after.stage, 'done', '阶段不得被改回 reviewing')
  assert.deepEqual(after.checkpoints, [], '不得写回执')

  /* 工具层的自动派工把同一原因折成 ok:false，调用方看得见。 */
  const { tool, exec } = makeHost(root, { subagents })
  const result = await autoDispatchTask({
    c: core, ctx: { get: (name) => (name === 'subagents' ? subagents : undefined) },
    agent: exec.agent, root, contract, task: stale, config: { dispatch: { auto: true } },
  })
  assert.equal(result.dispatch.ok, false)
  assert.equal(result.dispatch.code, 'conflict')
  assert.match(result.dispatch.error, /已被推进到「已完成」/)
  assert.equal(subagents.calls.length, 0)
  assert.ok(tool, 'flow_task 仍注册（host 末破）')
})

test('派工不校验终态 ②：派工途中被别人推到 done → 写回执检测到冲突，不覆盖他人写入', async () => {
  const { root, contract } = freshProject('race-mid')
  const task = addTask(root, contract, { type: 'docs', title: '派工途中完成', stage: 'queued-review' })
  const subagents = racingSubagents(() => {
    /* 子代理刚起来邻人就把它推到了 done（真实路径：审查者/另一会话）。 */
    updateTask(root, contract, task.id, { stage: 'done', notes: '他人写入的审查结论' }, { source: 'internal' })
  })
  const { deps } = recordDeps(root, contract, subagents, getTask(root, contract, task.id))
  const error = await dispatchTaskRecord(deps).then(() => null, (caught) => caught)
  assert.ok(error, '派工途中的台账改动必须被 CAS 拦住')
  assert.equal(error.code, 'conflict')
  assert.match(error.message, /任务已被推进到「已完成」/)
  assert.match(error.message, /放弃本次派工的台账写入/)
  assert.equal(subagents.calls.length, 1, '子代理已经起了（这一步不可回滚）')

  const after = getTask(root, contract, task.id)
  assert.equal(after.stage, 'done', '不得被盖回 reviewing')
  assert.equal(after.notes, '他人写入的审查结论', '他人的 notes 不得被覆盖')
  assert.deepEqual(after.checkpoints.filter((item) => item.kind === 'dispatch'), [], '冲突时不得留下派工回执')
  assert.equal(after.checkpoints.some((item) => item.kind === 'claim' && !item.closedAt), false, '失败路径不得留下 open claim')
})

test('派工不校验终态 ③：回到入口阶段即新一轮——同一入口不再台账级复用，必须重派', async () => {
  const { root, contract } = freshProject('race-dup')
  const task = addTask(root, contract, { type: 'feat', title: '幂等派工', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  const dispatchNow = () =>
    dispatchTaskRecord(recordDeps(root, contract, subagents, getTask(root, contract, task.id)).deps)
  const first = await dispatchNow()
  assert.equal(subagents.calls.length, 1)
  assert.equal(first.task.stage, 'analyzing')

  /* T-20261112151319（Lead 裁决，**反转**原断言）：这条用例原来断言「紧接重复必须
     复用 child-1」。裁决把语义反转成「重派」，原因必须留在测试里，否则后人会把下面
     的断言当成回归改回去：
     - 派工回执只在「起子代理 + 写台账都成功」时才产生；「卡回到入口阶段」由审查打回、
       实现完成、CLI/直连 core 改 stage、派工失败等写入造成，它们**不产生回执**；
     - 仅凭 `{checkpoints, stage}` 区分不了本轮与上一轮：trace A（派工成功后有人把
       stage 手改回入口）与 trace B（派工后经另一入口回同入口、中间那轮没落回执）
       落盘状态逐字节相同，任何只读这两个字段的判据必然同判；
     - 旧判据于是把上一轮同入口回执当成本轮，审查轮永远起不来（T-20261111191429
       实测：spawns 不增长、台账停在入口阶段，只能人工代审）。
     现在按「回到入口阶段即新一轮」处理：紧接重复的防护只在**进程内**（在途表，见
     后面的并发用例），不再有台账级复用——所以这里应当真的再起一个 worker。 */
  finishRound(root, contract, task.id)
  updateTask(root, contract, task.id, { stage: 'queued-analysis' }, { source: 'internal' })
  const second = await dispatchNow()
  assert.equal(subagents.calls.length, 2, '回到入口即新一轮：必须起第二个 worker')
  assert.equal(second.reused, undefined, '不得复用上一轮回执')
  assert.equal(second.dispatch.childId, 'child-2')
  assert.equal(second.task.stage, 'analyzing')

  /* 走完一轮（实现 → 审查）再回到同一入口：更早的回执属于上一轮，同样必须重派。 */
  finishRound(root, contract, task.id)
  updateTask(root, contract, task.id, { stage: 'queued-implementation' }, { source: 'internal' })
  const implemented = await dispatchNow()
  assert.equal(implemented.dispatch.childId, 'child-3')
  finishRound(root, contract, task.id)
  updateTask(root, contract, task.id, { stage: 'queued-review' }, { source: 'internal' })
  const reviewed = await dispatchNow()
  assert.equal(reviewed.dispatch.childId, 'child-4')
  finishRound(root, contract, task.id)
  updateTask(root, contract, task.id, { stage: 'queued-analysis' }, { source: 'internal' })
  const again = await dispatchNow()
  assert.equal(subagents.calls.length, 5, '中间轮次之后回同一入口必须起新子代理')
  assert.equal(again.reused, undefined, '不得复用上一轮回执')
  assert.equal(again.dispatch.childId, 'child-5')
  assert.equal(again.task.stage, 'analyzing')

  /* `failed: true` 的重派语义保持不变（任务书要求不动）：最后一条回执带失败标记后
     仍可重派。新语义下无论如何都会重派，这条锁的是「标记没把行为改坏」。 */
  finishRound(root, contract, task.id)
  updateTask(root, contract, task.id, { stage: 'queued-analysis' }, { source: 'internal' })
  const beforeRetry = getTask(root, contract, task.id)
  const checkpoints = beforeRetry.checkpoints.map((item, index) =>
    index === beforeRetry.checkpoints.length - 1 ? { ...item, failed: true } : item,
  )
  updateTask(root, contract, task.id, { checkpoints }, { source: 'internal' })
  const retried = await dispatchNow()
  assert.equal(subagents.calls.length, 6, '最后一条回执带失败标记后可重派')
  assert.equal(retried.dispatch.childId, 'child-6')
  assert.equal(retried.task.stage, 'analyzing')
})

test('审查轮重派 ①：审查打回、修复者完成后回到 queued-review，必须起第二任审查者（自动派工）', async () => {
  const { root, contract } = freshProject('review-round2-auto')
  const task = addTask(root, contract, { type: 'fix', title: '第二轮审查', stage: 'queued-implementation', mount: { kind: 'module', id: 'dispatch' } })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents })

  const first = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(first.dispatch.childId, 'child-1')
  finishRound(root, contract, task.id)
  const queuedReview = await tool.execute({ action: 'update', id: task.id, stage: 'queued-review', root }, exec)
  assert.equal(queuedReview.dispatch.role, 'reviewer')
  assert.equal(queuedReview.dispatch.childId, 'child-2')
  finishRound(root, contract, task.id)
  /* 审查不通过 → 打回实现；插件自动派修复者（reviewing → queued-implementation）。 */
  const bounced = await tool.execute(
    { action: 'update', id: task.id, stage: 'queued-implementation', root, notes: '审查不通过' },
    exec,
  )
  assert.equal(bounced.dispatch.role, 'implementer')
  assert.equal(bounced.dispatch.childId, 'child-3')
  finishRound(root, contract, task.id)
  /* 修复者完成 → 回到 queued-review：缺陷现场。上一轮审查者的回执 from=queued-review
     仍是最后一条，旧实现判 reused、spawns 停在 3，第二轮审查永远起不来
     （T-20261111191429 实测症状）。必须起第二任审查者。 */
  const secondReview = await tool.execute(
    { action: 'update', id: task.id, stage: 'queued-review', root, notes: '修复完成' },
    exec,
  )
  assert.equal(subagents.calls.length, 4, '第二轮审查必须起新审查者')
  assert.equal(secondReview.task.stage, 'reviewing')
  assert.equal(secondReview.dispatch.role, 'reviewer')
  assert.equal(secondReview.dispatch.reused, undefined, '不得复用上一轮审查者回执')
  assert.equal(secondReview.dispatch.childId, 'child-4')
  assert.notEqual(secondReview.dispatch.childId, queuedReview.dispatch.childId)
  const froms = secondReview.task.checkpoints.filter((item) => item.kind === 'dispatch').map((item) => item.from)
  assert.deepEqual(froms, ['queued-implementation', 'queued-review', 'queued-implementation', 'queued-review'])
})

test('审查轮重派 ②：手动把 stage 置回 queued-review（没派工、没新回执）后，显式 dispatch 必须重派', async () => {
  const { root, contract } = freshProject('review-manual')
  const task = addTask(root, contract, { type: 'fix', title: '手动置回', stage: 'queued-review' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents })

  const first = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(first.task.stage, 'reviewing')
  assert.equal(first.dispatch.childId, 'child-1')
  finishRound(root, contract, task.id)

  /* 手动置回入口（CLI/直连 core 的一条写入；这一轮没有派工，所以没有新回执）。
     旧判据看到最后一条回执 from=queued-review 就判成本轮已派过；新语义必须重派。 */
  updateTask(root, contract, task.id, { stage: 'queued-review' }, { source: 'internal' })
  const again = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(subagents.calls.length, 2, '手动置回入口后必须起新审查者')
  assert.equal(again.task.stage, 'reviewing')
  assert.equal(again.dispatch.role, 'reviewer')
  assert.equal(again.dispatch.reused, undefined)
  assert.equal(again.dispatch.childId, 'child-2')
  finishRound(root, contract, task.id)

  /* 再置回一次（模拟审查被打断后重试）仍然重派，不会被上一轮回执吸住。 */
  updateTask(root, contract, task.id, { stage: 'queued-review' }, { source: 'internal' })
  const third = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(subagents.calls.length, 3)
  assert.equal(third.dispatch.childId, 'child-3')
})

test('在途派工去重：同一任务同一入口并发两次，只起一个 worker，第二次复用其结果', async () => {
  const { root, contract } = freshProject('inflight')
  const task = addTask(root, contract, { type: 'feat', title: '并发派工', stage: 'queued-review' })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const calls = []
  const subagents = {
    calls,
    async startActivation(spec) {
      calls.push(spec)
      await gate
      return { childId: `child-${calls.length}` }
    },
  }
  const deps = recordDeps(root, contract, subagents, getTask(root, contract, task.id)).deps
  /* 第一个调用停在 startActivation 里；第二个调用命中进程内在途表。
     注意：这张表只在进程内——CLI 与插件是两个进程时仍然只靠闸 3 的 CAS，
     跨进程双派工的风险已知并接受（T-20261112151319 的已知限制，别把这条当跨进程保证）。 */
  const firstPromise = dispatchTaskRecord(deps)
  const secondPromise = dispatchTaskRecord({ ...deps, task: getTask(root, contract, task.id) })
  await new Promise((resolve) => setTimeout(resolve, 10))
  release()
  const [first, second] = await Promise.all([firstPromise, secondPromise])
  assert.equal(calls.length, 1, '并发派工只能起一个子代理')
  assert.equal(first.dispatch.childId, 'child-1')
  assert.equal(second.reused, true, '第二个调用复用第一个在途派工')
  assert.equal(second.dispatch.childId, 'child-1')
  assert.equal(second.task.stage, 'reviewing', '复用结果带第一个调用落盘的状态')
  const onDisk = getTask(root, contract, task.id)
  assert.equal(onDisk.checkpoints.filter((item) => item.kind === 'dispatch').length, 1, '不得写两条回执')
})

test('汇总轮台账复用（回归）：dispatchRound=aggregate 且最后一条回执 from=aggregate 时复用，不再起第二个分析者', async () => {
  const { root, contract } = freshProject('aggregate-reuse')
  const task = addTask(root, contract, { type: 'feat', title: '汇总轮复用', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  updateTask(root, contract, task.id, { dispatchRound: 'aggregate' }, { source: 'internal' })

  const first = await dispatchTaskRecord(recordDeps(root, contract, subagents, getTask(root, contract, task.id)).deps)
  assert.equal(subagents.calls.length, 1)
  /* 回执写的是汇总轮标记（checkpoint.from=aggregate）；返回体上的 dispatch.from 是
     入口阶段，两者在既有实现里就不同，这里只锁台账里的那条回执。 */
  const firstReceipts = first.task.checkpoints.filter((item) => item.kind === 'dispatch')
  assert.equal(firstReceipts.length, 1)
  assert.equal(firstReceipts[0].from, 'aggregate')
  assert.equal(first.task.stage, 'analyzing')

  /* 聚合被再次触发（父任务又被写回 queued-analysis、dispatchRound 仍在）：台账里
     最后一条 from=aggregate 未失败 → 复用。这是唯一保留的台账级复用；删掉它汇总轮
     会被重复触发、起两个分析者（T-20261111170544）。 */
  updateTask(root, contract, task.id, { stage: 'queued-analysis', dispatchRound: 'aggregate' }, { source: 'internal' })
  const second = await dispatchTaskRecord(recordDeps(root, contract, subagents, getTask(root, contract, task.id)).deps)
  assert.equal(subagents.calls.length, 1, '汇总轮复用不得起第二个子代理')
  assert.equal(second.reused, true)
  assert.equal(second.dispatch.childId, 'child-1')
  assert.equal(second.task.stage, 'queued-analysis', '复用时不改台账')
})

test('审查打回回归：reviewing → queued-implementation 后必须起新实现者，不复用上一轮回执', async () => {
  const { root, contract } = freshProject('review-bounce')
  const task = addTask(root, contract, { type: 'fix', title: '审查打回返工', stage: 'queued-implementation', mount: { kind: 'module', id: 'dispatch' } })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents })

  /* 第一轮实现者：queued-implementation → implementing。 */
  const first = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(subagents.calls.length, 1)
  assert.equal(first.task.stage, 'implementing')
  assert.equal(first.dispatch.childId, 'child-1')
  finishRound(root, contract, task.id)

  /* 实现完成 → queued-review，插件自动派审查者。 */
  const queuedReview = await tool.execute({ action: 'update', id: task.id, stage: 'queued-review', root }, exec)
  assert.equal(subagents.calls.length, 2)
  assert.equal(queuedReview.task.stage, 'reviewing')
  assert.equal(queuedReview.dispatch.role, 'reviewer')
  assert.equal(queuedReview.dispatch.childId, 'child-2')
  finishRound(root, contract, task.id)

  /* 审查不通过：reviewing → queued-implementation（唯一后退边），必须派**新的**实现者。
     旧实现拿第一轮 from=queued-implementation 的回执判 reused，spawns 停在 2。 */
  const bounced = await tool.execute(
    { action: 'update', id: task.id, stage: 'queued-implementation', root, notes: '审查不通过，退回修改' },
    exec,
  )
  assert.equal(subagents.calls.length, 3, '打回后必须起第二个实现者')
  assert.equal(bounced.task.stage, 'implementing')
  assert.equal(bounced.dispatch.role, 'implementer')
  assert.equal(bounced.dispatch.reused, undefined)
  assert.notEqual(bounced.dispatch.childId, first.dispatch.childId)
  assert.equal(bounced.dispatch.from, 'queued-implementation')
  const froms = bounced.task.checkpoints.filter((item) => item.kind === 'dispatch').map((item) => item.from)
  assert.deepEqual(froms, ['queued-implementation', 'queued-review', 'queued-implementation'])

  /* working 阶段仍然拒绝再派（放宽幂等不得产生第二个 worker）。 */
  await assert.rejects(
    () => tool.execute({ action: 'dispatch', id: task.id, root }, exec),
    /只有待分析\/待实现\/待审查可以派工/,
  )
  assert.equal(subagents.calls.length, 3)
})

test('派工不校验终态 ④：正常路径不受影响（单次派工 + 回执 from/to 正确）', async () => {
  const { root, contract } = freshProject('race-ok')
  const task = addTask(root, contract, { type: 'docs', title: '正常派工', stage: 'queued-review' })
  const subagents = fakeSubagents()
  const result = await dispatchTaskRecord(recordDeps(root, contract, subagents, getTask(root, contract, task.id)).deps)
  assert.equal(subagents.calls.length, 1)
  assert.equal(result.reused, undefined, '首次派工不是复用')
  assert.equal(result.task.stage, 'reviewing')
  assert.equal(result.dispatch.role, 'reviewer')
  assert.equal(result.dispatch.from, 'queued-review')
  assert.equal(result.dispatch.to, 'reviewing')
  assert.equal(result.task.checkpoints.length, 2, 'dispatch + claim 两条回执')
  assert.equal(result.task.checkpoints[0].kind, 'dispatch')
  assert.equal(result.task.checkpoints[1].kind, 'claim')
  assert.equal(result.task.checkpoints[1].session, 'child-1')
  /* 工具层仍会拒绝在 working 阶段的第二次派工（不破坏既有语义）。 */
  const { tool, exec } = makeHost(root, { subagents })
  await assert.rejects(() => tool.execute({ action: 'dispatch', id: task.id, root }, exec), /只有待分析\/待实现\/待审查可以派工/)
  assert.equal(subagents.calls.length, 1)
})

// ======================== 阶段 2：插件派工走台账工单队列（T-20261113155234）

test('工单队列全链路：queue → spawn → ack → close(ok)，下一轮 round+1/attempt=1', async () => {
  const { root, contract } = freshProject('queue-chain')
  const task = addTask(root, contract, { type: 'feat', title: '队列全链路', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents })
  const first = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(subagents.calls.length, 1, '成功下单才 spawn 一次')
  const queued = core.listDispatches(root, contract).find((row) => row.taskId === task.id)
  assert.equal(queued.status, 'acked', 'ack 取执行权')
  assert.equal(queued.claim.session, 'child-1')
  assert.equal(queued.round, 1)
  assert.equal(queued.attempt, 1)
  assert.match(String(first.dispatch.order), /-r1-a1$/)

  // 子任务完成后先推进阶段（正常收口），再关单才是 ok。
  updateTask(root, contract, task.id, { stage: 'queued-implementation' }, { source: 'internal' })
  const closed = closeDispatchedChild(null, 'child-1')
  assert.equal(closed.outcome, 'ok')
  const done = core.listDispatches(root, contract).find((row) => row.taskId === task.id)
  assert.equal(done.status, 'ok')
  assert.equal(done.claim.outcome, 'ok', 'close(ok) 同一次写入释放 claim')
  const after = getTask(root, contract, task.id)
  assert.equal(after.checkpoints.some((item) => item.kind === 'claim' && !item.closedAt), false, '不得留下 open claim')

  // 回到入口（正常新一轮）：round+1、attempt 归 1，不被上一单挡住。
  const second = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(subagents.calls.length, 2, '上一单 ok 后允许新一轮')
  assert.match(String(second.dispatch.order), /-r2-a1$/)
})

test('同卡已有未关闭工单：跳过 spawn、留 warning、阶段不动', async () => {
  const { root, contract } = freshProject('queue-open')
  const task = addTask(root, contract, { type: 'fix', title: '已有工单', stage: 'queued-review' })
  core.queueDispatch(root, contract, task.id, { agent: 'reviewer', role: 'reviewer' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents })
  drainWarnings()
  const result = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(result.dispatch.skipped, true)
  assert.equal(subagents.calls.length, 0, '未关闭工单存在时不得 spawn')
  assert.equal(getTask(root, contract, task.id).stage, 'queued-review', '卡留原阶段')
  assert.ok(JSON.stringify(result).includes('dispatch-queue skipped'), '必须留一条 warning')
})

test('同一轮 attempt 上限：3 次失败后第 4 次跳过并留在原阶段', async () => {
  const { root, contract } = freshProject('queue-attempt')
  const task = addTask(root, contract, { type: 'chore', title: 'attempt 上限', stage: 'queued-analysis' })
  for (let index = 1; index <= 3; index += 1) {
    core.queueDispatch(root, contract, task.id, { agent: 'analyzer', role: 'analyzer' })
    core.ackDispatch(root, contract, task.id, { agent: 'analyzer', session: 'failed-child-' + index })
    core.closeDispatch(root, contract, task.id, { outcome: 'failed', reason: '失败重试' })
  }
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents })
  const result = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(result.dispatch.skipped, true)
  assert.equal(subagents.calls.length, 0, 'attempt 超限不得 spawn')
  assert.equal(getTask(root, contract, task.id).stage, 'queued-analysis', '卡留原阶段')
  const rows = core.listDispatches(root, contract).filter((row) => row.taskId === task.id)
  assert.equal(rows[0].round, 1)
  assert.equal(rows[0].attempt, 3)
})

// ======================== T-20261111170544：汇总轮收口父任务（analyzing → done）
//
// 缺陷：分析者提示词要求汇总轮「把 stage 推进到 done」，但边表里 `analyzing` 只有
// `→ queued-implementation`，汇总轮一执行就抛 `stage analyzing cannot move to "done"`，
// 流水线永久卡在汇总。这组用例钉四件事：
// ① 端到端：子任务全 done → 汇总轮把父任务推到 done（真走 `flow_task update`）；
// ② 边本身：存在、actor 正确、doctrine 有条目；
// ③ 验收门没放水：父任务有可执行验收未验证 → 照旧拒绝；
// ④ 无可执行验收 → 按 warn 放行且留 warning。
// 外加回归：汇总轮真的能派出来（首轮回执不会把第二轮的派工判成 reused）。

/** 跑一个应抛错的同步调用，返回错误对象（`assert.throws` 不返回它）。 */
function captureError(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

test('汇总轮 ①：子任务全部 done → 父任务经 flow_task update 推进到 done（端到端）', async () => {
  const { root, contract } = freshProject('aggregate-done')
  const subagents = fakeSubagents()
  const host = makeHost(root, { subagents })
  const taskTool = host.tool

  /* 父任务直接建在 analyzing：本用例从「分析者已进来」开始（created → analyzing 不是合约边）。 */
  const main = await taskTool.execute({ action: 'add', title: '父任务', type: 'feat', root, stage: 'analyzing' }, host.exec)
  const parentId = main.task.id
  /* 首轮分析者：拆任务（flow_subtask add）后从 analyzing 推到 queued-implementation。 */
  const subtaskTool = host.tool
  /* 子任务建在 queued-implementation（与 flow_subtask add 的默认起点一致）：
     阶段边接管后 created → queued-review 不再可写。 */
  const child = await subtaskTool.execute(
    { action: 'add', parent: parentId, title: '子任务一', type: 'feat', stage: 'queued-implementation' },
    host.exec,
  )
  finishRound(root, contract, child.task.id)
  core.updateTask(root, contract, parentId, { mount: { kind: 'module', id: 'dispatch' } }, { source: 'internal' })
  await taskTool.execute({ action: 'update', id: parentId, root, stage: 'queued-implementation' }, host.exec)
  finishRound(root, contract, parentId)
  /* 子任务实现/审查完成 → 父任务被聚合回待分析并重新派分析者（汇总轮）。 */
  for (const stage of ['queued-review', 'done']) {
    finishRound(root, contract, child.task.id)
    await taskTool.execute({ action: 'update', id: child.task.id, root, stage }, host.exec)
  }

  // 聚合：父任务回到待分析、带 [auto] 标记与汇总轮标记，并被派到分析中（汇总轮）。
  const queued = getTask(root, contract, parentId)
  assert.equal(queued.stage, 'analyzing', '聚合后汇总轮分析者应已进来（旧缺陷：被判 reused，父任务永远停在待分析）')
  assert.match(String(queued.notes), /\[auto\] 子任务 1 条全部完成/)
  assert.equal(queued.dispatchRound, 'aggregate', '汇总轮标记写在父任务上')
  const aggregateDispatch = queued.checkpoints.filter((item) => item.from === 'aggregate')
  assert.ok(Array.isArray(queued.checkpoints), 'checkpoints 必须是数组')
  assert.equal(aggregateDispatch.length, 1, '汇总轮的派工回执单列一条（from=aggregate），不被首轮回执吞掉')

  // 汇总轮收口：flow_task update → done。这是缺陷的直接复现点。
  const settled = await taskTool.execute(
    { action: 'update', id: parentId, root, stage: 'done', notes: '汇总：2 条子任务证据齐全' },
    host.exec,
  )
  assert.equal(settled.task.stage, 'done', '父任务必须能收口到 done（修复前抛 invalid: analyzing cannot move to "done"）')
  assert.equal(settled.task.status, 'done', 'status 由 stage 派生')
  const onDisk = getTask(root, contract, parentId)
  assert.equal(onDisk.stage, 'done')
  assert.equal(onDisk.dispatchRound, undefined, '收口后汇总轮标记必须被清掉（一次性的）')
  assert.equal(onDisk.notes, '汇总：2 条子任务证据齐全')
  // 收口不得把父任务当子任务再聚合一次
  assert.equal(settled.dispatch, undefined, '收口到 done 不触发新派工')
})

test('汇总轮 ②：analyzing → done 边存在、actor=session、doctrine 有条目', () => {
  const edge = edgeOf('analyzing', 'done')
  assert.ok(edge, 'analyzing → done 边必须存在')
  assert.equal(edge.actor, 'session', '汇总轮由分析者（会话）推进')
  assert.equal(edge.back, undefined, '汇总收口不是回退边')
  assert.equal(actorForEdge('analyzing', 'done'), 'session')
  assert.equal(canTransition('analyzing', 'done'), true)
  assert.ok(nextStages('analyzing').includes('done'))
  assert.ok(STAGE_MACHINE.done.from.includes('analyzing'), 'done.from 必须声明前驱 analyzing')
  assert.doesNotThrow(() => assertTransition('analyzing', 'done'))

  const doctrine = STAGE_EDGE_DOCTRINE['analyzing>done']
  assert.ok(doctrine, 'doctrine 必须为这条边给出动作与验证命令')
  assert.match(doctrine.action, /子任务全部完成/)
  assert.match(doctrine.action, /汇总/)
  assert.match(doctrine.action, /回报 lead/)
  assert.equal(doctrine.verify, 'flow task verify {id}')

  // 既有边行为不变：reviewing → done 仍是 reviewer；analyzing → queued-implementation 仍是 session。
  assert.equal(actorForEdge('reviewing', 'done'), 'reviewer')
  assert.equal(actorForEdge('analyzing', 'queued-implementation'), 'session')
  // 主推荐仍是拆任务边：分析者首轮的下一步不是"直接收口"。
  const step = stageNextStep('analyzing')
  assert.equal(step.primary.stage, 'queued-implementation')
  assert.deepEqual(step.alternatives.map((row) => row.stage), ['done', 'cancelled'])
  // `flow task next` 看到的验证命令是真实可跑的那条。
  assert.equal(step.alternatives[0].verify, 'flow task verify {id}')
})

test('汇总轮 ③：父任务有可执行验收未验证 → 汇总轮仍被拒，文案含 flow task verify（没放水）', () => {
  const { root, contract } = freshProject('aggregate-gate')
  const parent = addTask(root, contract, {
    type: 'feat',
    title: '带可执行验收的父任务',
    stage: 'analyzing',
    acceptance: ['cmd:node -e "process.exit(0)"'],
  })
  const error = captureError(() => updateTask(root, contract, parent.id, { stage: 'done' }, { source: 'aggregate' }))
  assert.ok(error, '有可执行验收却没验证过时，汇总轮必须被拒')
  assert.equal(error.code, 'invalid')
  assert.match(error.message, /^acceptance gate: done: /)
  assert.match(error.message, new RegExp(`flow task verify ${parent.id}`), '拒绝文案必须给出可直接执行的补救命令')
  assert.equal(getTask(root, contract, parent.id).stage, 'analyzing', '被拒的写入不得落盘')

  /* 同一张卡不传 source（普通会话收口）也一样拒绝：证明 aggregate 不是"随便就能绕过"。 */
  assert.throws(() => updateTask(root, contract, parent.id, { stage: 'done' }), /acceptance gate/)
  /* strict 策略下即使带 aggregate 也硬拦：策略显式要求时不降级。 */
  const strict = { ...contract, tasks: { ...(contract.tasks ?? {}), requireAcceptance: 'strict' } }
  assert.throws(
    () => updateTask(root, strict, parent.id, { stage: 'done' }, { source: 'aggregate' }),
    /acceptance gate/,
  )
})

test('汇总轮 ④：无可执行验收的父任务按 warn 放行，并留一条 warning', () => {
  const { root, contract } = freshProject('aggregate-warn')
  const parent = addTask(root, contract, { type: 'feat', title: '无验收父任务', stage: 'analyzing', acceptance: ['人工验收'] })
  drainWarnings()
  const done = updateTask(root, contract, parent.id, { stage: 'done' }, { source: 'aggregate' })
  assert.equal(done.stage, 'done')
  const warnings = drainWarnings().filter((item) => item.includes(parent.id))
  assert.equal(warnings.length, 1, `必须留恰好一条 warning，实际：${JSON.stringify(warnings)}`)
  assert.match(warnings[0], /task-acceptance-none/)

  /* strict 下没有可执行验收项仍然拒绝（策略是一等契约键，汇总轮不能改它）。 */
  const other = addTask(root, contract, { type: 'feat', title: '再来一张', stage: 'analyzing' })
  const strict = { ...contract, tasks: { ...(contract.tasks ?? {}), requireAcceptance: 'strict' } }
  assert.throws(
    () => updateTask(root, strict, other.id, { stage: 'done' }, { source: 'aggregate' }),
    /没有可执行验收项/,
  )
})

test('汇总轮 ⑤：描述门豁免只对 aggregate 生效，internal/plugin/session 三条语义不变', () => {
  const { root, contract } = freshProject('aggregate-desc')
  // 描述门店条件：台账里有记录（enforce=auto 才会真的检查）。build 出一份未填语义的
  // 台账，于是 done 阶段门必然有 missing-semantics 失败项——正好用来区分"谁被豁免"。
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'lib', 'a.mjs'), '// ---- 契约\nexport function alpha() {}\n')
  buildDescription(root, contract)
  assert.ok(listDescriptionFiles(root, contract).length > 0, '夹具必须真的建出描述台账')

  const task = addTask(root, contract, { type: 'feat', title: '汇总门', stage: 'analyzing' })
  const target = getTask(root, contract, task.id)
  const gateOptions = (source) => ({ ...(source === undefined ? {} : { source }), from: 'analyzing', to: 'done' })
  // 三条既有语义不变：缺省 / session / plugin 都被描述门拦住（done 需要测试证据与语义）。
  for (const source of [undefined, 'session', 'plugin']) {
    const error = captureError(() => assertDescriptionGate(root, contract, target, gateOptions(source)))
    assert.ok(error, `${source ?? '缺省'} 来源不得被 aggregate 豁免带走`)
    assert.equal(error.code, 'invalid')
    assert.match(error.message, /^description gate: done: /)
  }
  // 汇总轮豁免描述门（不产生新的语义变更，没有计划可看）；internal 照旧豁免。
  assert.equal(assertDescriptionGate(root, contract, target, gateOptions('aggregate')), undefined)
  assert.equal(assertDescriptionGate(root, contract, target, gateOptions('internal')), undefined)
  /* 豁免只作用于描述门这一道：同一张卡、同一次汇总收口，验收门照样判定
     （父任务有可执行验收却没验证过 → 拒绝）。这一格是"两道门分开处理"的证据。 */
  const gated = addTask(root, contract, {
    type: 'feat',
    title: '带验收的父任务',
    stage: 'analyzing',
    acceptance: ['cmd:node -e "process.exit(0)"'],
  })
  const acceptError = captureError(() => updateTask(root, contract, gated.id, { stage: 'done' }, { source: 'aggregate' }))
  assert.ok(acceptError, 'aggregate 豁免描述门，但不得豁免验收门')
  assert.match(acceptError.message, /^acceptance gate: done: /)
})

// ---------------------------------------------------------------------------
// 派工模型（T-20261112152355-02，2026-11-12 任务书【B 派工模型】）
//
// 这组用例锁三件事：
// 1. **零回归**：`config.dispatch` 没写 `model`/`models` 时，startActivation 收到的
//    request 里一个 `agentOptions` 键都不能有（与改动前逐字节一致）；
// 2. 显式声明时按角色解析模型（`models[role]` → `model` → 默认），provider 仍走顶层；
// 3. 服务没有 `capabilities.agentOptions` 时**降级不失败**（回执 model 为空），
//    只有 `config.dispatch.requireModel === true` 才报错。
// ---------------------------------------------------------------------------

/** 声明了 `capabilities.agentOptions` 的宿主：子代理服务真能按模型起。 */
const MODEL_CAPABLE = { agentOptions: true }

test('派工模型：配置纯函数——默认值 / provider-model 取末段 / 角色覆盖 / 显式判定', () => {
  assert.equal(DEFAULT_DISPATCH_MODEL, 'iceman-contributor-free')

  /* 没配置：一律回落默认模型，但不是「显式」——是否透传由 dispatchModelExplicit 决定。 */
  assert.equal(dispatchModel(undefined), DEFAULT_DISPATCH_MODEL)
  assert.equal(dispatchModel({}), DEFAULT_DISPATCH_MODEL)
  assert.equal(dispatchModel({ dispatch: {} }), DEFAULT_DISPATCH_MODEL)
  assert.equal(dispatchModelExplicit(undefined), false)
  assert.equal(dispatchModelExplicit({}), false)
  assert.equal(dispatchModelExplicit({ dispatch: { enabled: true, provider: 'spawn' } }), false, '老配置不算显式')
  assert.equal(dispatchModelRequired(undefined), false)
  assert.equal(dispatchModelRequired({ dispatch: {} }), false)

  /* 显式声明：裸模型名 / provider 前缀（取末段，provider 不进 agentOptions）/ 非法回落。 */
  assert.equal(dispatchModel({ dispatch: { model: 'longcat-2.5-free' } }), 'longcat-2.5-free')
  assert.equal(dispatchModel({ dispatch: { model: 'opencode-go/longcat-2.5-free' } }), 'longcat-2.5-free')
  assert.equal(dispatchModel({ dispatch: { model: '  ' } }), DEFAULT_DISPATCH_MODEL, '空串回落默认')
  assert.equal(dispatchModel({ dispatch: { model: 42 } }), DEFAULT_DISPATCH_MODEL, '非字符串回落默认')
  assert.equal(dispatchModelExplicit({ dispatch: { model: 'x' } }), true)
  assert.equal(dispatchModelExplicit({ dispatch: { models: {} } }), true, '只写 models 也算显式')
  assert.equal(dispatchModelRequired({ dispatch: { requireModel: true } }), true)
  assert.equal(dispatchModelRequired({ dispatch: { requireModel: 'yes' } }), false, '只认严格 true')

  /* 角色解析：models[role] 优先，其次 model，再次默认。 */
  const both = { dispatch: { model: 'longcat-2.5-free', models: { reviewer: 'iceman-contributor-free' } } }
  assert.equal(dispatchRoleModel(both, 'reviewer'), 'iceman-contributor-free', 'models[role] 覆盖 model')
  assert.equal(dispatchRoleModel(both, 'implementer'), 'longcat-2.5-free', '未覆盖的角色回落 model')
  assert.equal(dispatchRoleModel(both, 'analyzer'), 'longcat-2.5-free')
  assert.equal(dispatchRoleModel({}, 'reviewer'), DEFAULT_DISPATCH_MODEL, '都没配回落默认')
  assert.equal(dispatchRoleModel({ dispatch: { model: 'a/b/c' } }, 'reviewer'), 'c', '多段取末段')
  assert.equal(
    dispatchRoleModel({ dispatch: { model: 'x', models: { reviewer: '  ' } } }, 'reviewer'),
    'x',
    '角色值写空 → 回落 model（不是回落默认）',
  )
  assert.equal(
    dispatchRoleModel({ dispatch: { models: { unknownRole: 'x' } } }, 'unknownRole'),
    DEFAULT_DISPATCH_MODEL,
    '非三角色键不认',
  )

  /* 回执：model 非空才写，空串不写键（老回执形状不变）。 */
  assert.equal(Object.hasOwn(dispatchCheckpoint({ childId: 'c1', role: 'analyzer' }), 'model'), false)
  assert.equal(Object.hasOwn(dispatchCheckpoint({ childId: 'c1', role: 'analyzer', model: '' }), 'model'), false)
  assert.equal(dispatchCheckpoint({ childId: 'c1', role: 'analyzer', model: 'longcat-2.5-free' }).model, 'longcat-2.5-free')
})

test('派工模型（零回归）：没配 model/models → request 里没有 agentOptions 键，回执不带 model', async () => {
  const { root, contract } = freshProject('model-none')
  const task = addTask(root, contract, { type: 'feat', title: '不配模型', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  /* 宿主**具备**按模型起的能力（capabilities 已声明），但配置没写 model：
     这种组合最危险——实现里一旦偷懒给个默认模型，本用例就会红。 */
  const { tool, exec } = makeHost(root, {
    subagents,
    capabilities: MODEL_CAPABLE,
    config: { dispatch: { provider: 'spawn' } },
  })
  const result = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(subagents.calls.length, 1)
  assert.equal(
    Object.hasOwn(subagents.calls[0].request, 'agentOptions'),
    false,
    '零回归：没显式声明模型时 request 绝不能出现 agentOptions 键',
  )
  assert.equal(
    Object.hasOwn(subagents.calls[0], 'agentOptions'),
    false,
    'agentOptions 只在 request 里，不在 startActivation 顶层',
  )
  assert.equal(result.dispatch.model, '', '模型为空：实际用的是父模型')
  assert.equal(Object.hasOwn(lastDispatchReceipt(result.task), 'model'), false, '回执不写 model 键')
  assert.equal(result.task.stage, 'analyzing')
})

test('派工模型：dispatch.model 透传 agentOptions.model，provider 仍走顶层', async () => {
  const { root, contract } = freshProject('model-one')
  const task = addTask(root, contract, { type: 'feat', title: '指定模型', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, {
    subagents,
    capabilities: MODEL_CAPABLE,
    config: { dispatch: { provider: 'fork', model: 'longcat-2.5-free' } },
  })
  const result = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  const spec = subagents.calls[0]
  assert.deepEqual(spec.request.agentOptions, { model: 'longcat-2.5-free' }, '模型进 request.agentOptions')
  assert.equal(spec.provider, 'fork', 'provider 仍走顶层字段')
  assert.equal(
    Object.hasOwn(spec.request.agentOptions, 'provider'),
    false,
    'provider 不塞进 agentOptions（单一真源）',
  )
  assert.equal(result.dispatch.model, 'longcat-2.5-free')
  assert.equal(lastDispatchReceipt(result.task).model, 'longcat-2.5-free', '回执记实际用的模型')
  assert.equal(result.task.stage, 'analyzing')
})

test('派工模型：models.reviewer 覆盖、其余角色回落 dispatch.model', async () => {
  const { root, contract } = freshProject('model-role')
  const config = { dispatch: { model: 'longcat-2.5-free', models: { reviewer: 'iceman-contributor-free' } } }

  /* 实现者（queued-implementation）→ 未覆盖的角色回落 dispatch.model。 */
  const impl = addTask(root, contract, { type: 'fix', title: '实现者', stage: 'queued-implementation' })
  const a = fakeSubagents()
  const hostA = makeHost(root, { subagents: a, capabilities: MODEL_CAPABLE, config })
  const ra = await hostA.tool.execute({ action: 'dispatch', id: impl.id, root }, hostA.exec)
  assert.equal(a.calls[0].request.agentOptions.model, 'longcat-2.5-free', '未覆盖的角色回落 dispatch.model')
  assert.equal(ra.dispatch.role, 'implementer')

  /* 审查者（queued-review）→ models.reviewer 优先。 */
  const rev = addTask(root, contract, { type: 'fix', title: '审查者', stage: 'queued-review' })
  const b = fakeSubagents()
  const hostB = makeHost(root, { subagents: b, capabilities: MODEL_CAPABLE, config })
  const rb = await hostB.tool.execute({ action: 'dispatch', id: rev.id, root }, hostB.exec)
  assert.equal(b.calls[0].request.agentOptions.model, 'iceman-contributor-free', 'models[role] 覆盖 dispatch.model')
  assert.equal(rb.dispatch.role, 'reviewer')
  assert.equal(lastDispatchReceipt(rb.task).model, 'iceman-contributor-free')
})

test('派工模型：服务无 agentOptions 能力 → 降级不失败，回执 model 为空并说明降级', async () => {
  /* ① 没声明 capabilities 的宿主（老 backend）：根本不带 agentOptions，按父模型跑。 */
  const { root, contract } = freshProject('model-degrade')
  const task = addTask(root, contract, { type: 'feat', title: '降级', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, { subagents, config: { dispatch: { model: 'longcat-2.5-free' } } })
  const result = await tool.execute({ action: 'dispatch', id: task.id, root }, exec)
  assert.equal(subagents.calls.length, 1, '仍然起子代理（按父会话模型），不是失败')
  assert.equal(Object.hasOwn(subagents.calls[0].request, 'agentOptions'), false, '能力缺失时不带 agentOptions')
  assert.equal(result.task.stage, 'analyzing', '台账照常推进')
  assert.equal(result.dispatch.model, '', '模型为空：实际用的是父模型')
  assert.equal(Object.hasOwn(lastDispatchReceipt(result.task), 'model'), false)
  assert.match(String(result.dispatch.degraded), /agentOptions/, '返回值说明降级原因')

  /* ② 声明了能力却仍然拒绝：运行时降级重试一次（不带模型），不判失败。 */
  const { root: root2, contract: contract2 } = freshProject('model-degrade-runtime')
  const task2 = addTask(root2, contract2, { type: 'feat', title: '运行时拒绝', stage: 'queued-analysis' })
  const calls = []
  const rejects = {
    async startActivation(spec) {
      calls.push(spec)
      if (spec.request.agentOptions !== undefined) throw new Error('this backend does not support agentOptions')
      return { childId: 'child-fallback' }
    },
  }
  const host2 = makeHost(root2, {
    subagents: rejects,
    capabilities: MODEL_CAPABLE,
    config: { dispatch: { model: 'longcat-2.5-free' } },
  })
  const r2 = await host2.tool.execute({ action: 'dispatch', id: task2.id, root: root2 }, host2.exec)
  assert.equal(calls.length, 2, '先带模型试一次，被拒后不带模型重试一次')
  assert.equal(Object.hasOwn(calls[0].request, 'agentOptions'), true)
  assert.equal(Object.hasOwn(calls[1].request, 'agentOptions'), false, '重试请求不带 agentOptions')
  assert.equal(r2.dispatch.childId, 'child-fallback')
  assert.equal(r2.dispatch.model, '')
  assert.match(String(r2.dispatch.degraded), /agentOptions/)
  assert.equal(r2.task.stage, 'analyzing')
})

test('派工模型：requireModel=true 时能力缺失必须报错且台账不动', async () => {
  const { root, contract } = freshProject('model-require')
  const task = addTask(root, contract, { type: 'feat', title: '要求模型', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, {
    subagents,
    config: { dispatch: { model: 'longcat-2.5-free', requireModel: true } },
  })
  await assert.rejects(
    () => tool.execute({ action: 'dispatch', id: task.id, root }, exec),
    /requireModel=true[\s\S]*capabilities\.agentOptions/,
    'requireModel 时不降级，直接报错并给出改配置的办法',
  )
  assert.equal(subagents.calls.length, 0, '没起子代理')
  assert.equal(getTask(root, contract, task.id).stage, 'queued-analysis', '阶段不推进')
  assert.deepEqual(getTask(root, contract, task.id).checkpoints, [], '不写回执')

  /* 能力齐全时 requireModel=true 正常派工并带上模型（不误伤主路径）。 */
  const { root: okRoot, contract: okContract } = freshProject('model-require-ok')
  const okTask = addTask(okRoot, okContract, { type: 'feat', title: '能力齐全', stage: 'queued-analysis' })
  const okSubagents = fakeSubagents()
  const okHost = makeHost(okRoot, {
    subagents: okSubagents,
    capabilities: MODEL_CAPABLE,
    config: { dispatch: { model: 'longcat-2.5-free', requireModel: true } },
  })
  const ok = await okHost.tool.execute({ action: 'dispatch', id: okTask.id, root: okRoot }, okHost.exec)
  assert.equal(okSubagents.calls[0].request.agentOptions.model, 'longcat-2.5-free')
  assert.equal(ok.dispatch.model, 'longcat-2.5-free')
})

test('派工模型：阶段入口自动派工也按角色透传模型（autoDispatchTask 取 config）', async () => {
  const { root, contract } = freshProject('model-auto')
  const task = addTask(root, contract, { type: 'feat', title: '自动派工带模型', stage: 'created' })
  const subagents = fakeSubagents()
  const { tool, exec } = makeHost(root, {
    subagents,
    capabilities: MODEL_CAPABLE,
    config: { dispatch: { auto: true, model: 'opencode-go/longcat-2.5-free' } },
  })
  const result = await tool.execute({ action: 'update', id: task.id, stage: 'queued-analysis', root }, exec)
  assert.equal(subagents.calls.length, 1)
  assert.equal(subagents.calls[0].request.agentOptions.model, 'longcat-2.5-free', 'provider/model 取末段')
  assert.equal(result.dispatch.auto, true)
  assert.equal(result.dispatch.model, 'longcat-2.5-free')
  assert.equal(lastDispatchReceipt(result.task).model, 'longcat-2.5-free')

  /* 自动派工 + requireModel + 能力缺失：折成 dispatch.ok:false，不拖垮 update。 */
  const { root: badRoot, contract: badContract } = freshProject('model-auto-require')
  const badTask = addTask(badRoot, badContract, { type: 'feat', title: '自动派工失败', stage: 'created' })
  const badHost = makeHost(badRoot, {
    subagents: fakeSubagents(),
    config: { dispatch: { auto: true, model: 'longcat-2.5-free', requireModel: true } },
  })
  const bad = await badHost.tool.execute(
    { action: 'update', id: badTask.id, stage: 'queued-analysis', root: badRoot },
    badHost.exec,
  )
  assert.equal(bad.dispatch.ok, false, '自动派工失败只回报，不抛')
  assert.match(String(bad.dispatch.error), /requireModel=true/)
  assert.equal(bad.task.stage, 'queued-analysis', '台账已写成功，阶段停在入口')
})


// ------------------------ 派工 saga intent（T-20261112183138-02，2026-11-12）
//
// 派工两步写：起子代理（spawn）→ 写回执+推进阶段（receipt）。intent 在 spawn 之前落盘，
// 正常路径收口为 done；中途被 CAS 拦住时保持 open（spawn 已打勾），恢复扫描能发现
// 孤儿子代理并留痕——而不是只把 childId 写进抛出的错误消息里。

const { listIntents, readIntent, recoverIntents } = await import('../lib/tasks/intents.mjs')

test('saga intent ①：派工成功 → intent 收口 done 且带 childId/stage', async () => {
  const { root, contract } = freshProject('intent-dispatch-ok')
  const task = addTask(root, contract, { type: 'feat', title: '派工 saga', stage: 'queued-implementation' })
  const subagents = fakeSubagents()
  const { deps } = recordDeps(root, contract, subagents, getTask(root, contract, task.id))
  await dispatchTaskRecord(deps)
  const section = listIntents(root, contract)
  assert.equal(section.counts.open, 0, '正常路径不留 open intent')
  assert.equal(section.counts.done, 1, '派工成功 = intent 收口 done')
  const intent = section.items.find((item) => item.kind === 'dispatch')
  assert.deepEqual(intent.done, ['spawn', 'receipt'])
  assert.equal(intent.data.childId, 'child-1')
  assert.equal(intent.result.stage, 'implementing')
})

test('saga intent ②：spawn 成功后写回执被 CAS 拦住 → intent 留在 open，恢复扫描记孤儿', async () => {
  const { root, contract } = freshProject('intent-dispatch-conflict')
  const task = addTask(root, contract, { type: 'docs', title: '派工冲突', stage: 'queued-review' })
  /* 子代理刚起来就被邻人推到 done：CAS 会让写回执失败，只剩 spawn 打勾。 */
  const subagents = racingSubagents(() => {
    updateTask(root, contract, task.id, { stage: 'done', notes: '他人写入' }, { source: 'internal' })
  })
  const { deps } = recordDeps(root, contract, subagents, getTask(root, contract, task.id))
  const error = await dispatchTaskRecord(deps).then(() => null, (caught) => caught)
  assert.equal(error.code, 'conflict')
  const open = listIntents(root, contract, { state: 'open' }).items
  assert.equal(open.length, 1, '崩在中间的多步写必须留下可恢复线索')
  assert.deepEqual(open[0].done, ['spawn'], 'spawn 已发生、receipt 未写')
  assert.equal(open[0].data.childId, 'child-race-1')
  /* 恢复扫描：补一条孤儿留痕，intent 收口 aborted（不替人推进阶段）。 */
  const recovered = recoverIntents(root, contract)
  assert.equal(recovered.counts.aborted, 1)
  assert.equal(readIntent(root, contract, open[0].id).state, 'aborted')
  const after = getTask(root, contract, task.id)
  assert.match(after.notes, /孤儿派工 child-race-1/)
  assert.match(after.notes, /他人写入/, '恢复不得覆盖他人写入的 notes')
  assert.equal(after.stage, 'done', '恢复不得改阶段')
})

// ------------------------- 派工入口的 aspect 自动串行（T-20261112183138 裁定 6）
//
// 放行 queued-* 时按任务 scope.allow 与 docs/module-domain.json 的 aspects.files 求交集，
// 自动占用相关 aspect；有界排队（config.aspectLock.waitMs，缺省 1500ms）；等不到**不阻断**，
// 结果与 warning 里都能看见 pending（谁在占、等了多久）。

const { acquireAspectLock, listAspectLocks } = await import('../lib/host/aspect-lock.mjs')

function writeAspectDocs(root, aspects) {
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs', 'module-domain.json'), JSON.stringify({ schema: 1, aspects }, null, 2))
}

test('aspect 接入①：任务显式 scope.allow 命中 aspect → 派工时自动占用并串行', async () => {
  const { root, contract } = freshProject('aspect-dispatch-ok')
  writeAspectDocs(root, { 'state-machine': { files: ['lib/stage.mjs'] } })
  const task = addTask(root, contract, {
    type: 'feat',
    title: 'aspect 串行任务',
    stage: 'queued-review',
    scope: { allow: ['lib/stage.mjs'] },
  })
  const subagents = fakeSubagents()
  const { deps } = recordDeps(root, contract, subagents, task)
  const result = await dispatchTaskRecord({ ...deps, config: { aspectLock: { waitMs: 0 } } })
  assert.equal(result.task.stage, 'reviewing')
  assert.ok(result.dispatch.aspect, '派工结果必须带 aspect（additive 字段）')
  assert.deepEqual(result.dispatch.aspect.acquired, ['state-machine'])
  assert.deepEqual(result.dispatch.aspect.pending, [])
  const locks = listAspectLocks(root, contract)
  assert.equal(locks.counts.held, 1)
  assert.equal(locks.items[0].aspect, 'state-machine')
  assert.equal(locks.items[0].owner.session, deps.agent.id)
})

test('aspect 接入②：aspect 被别的活会话占着 → 不阻断派工，pending + warning 可见（空 scope 不占用）', async () => {
  const { root, contract } = freshProject('aspect-dispatch-pending')
  writeAspectDocs(root, { 'state-machine': { files: ['lib/stage.mjs'] } })
  // 另一个活会话先占住 state-machine。
  await acquireAspectLock(root, contract, { aspect: 'state-machine', session: 'session-aspect-holder' })
  const task = addTask(root, contract, {
    type: 'feat',
    title: '撞 aspect 的卡',
    stage: 'queued-review',
    scope: { allow: ['lib/stage.mjs'] },
  })
  const subagents = fakeSubagents()
  const { deps } = recordDeps(root, contract, subagents, task)
  drainWarnings()
  const result = await dispatchTaskRecord({ ...deps, config: { aspectLock: { waitMs: 0 } } })
  assert.equal(result.task.stage, 'reviewing', '裁定 6：等不到锁也放行派工')
  assert.deepEqual(result.dispatch.aspect.acquired, [])
  assert.equal(result.dispatch.aspect.pending.length, 1)
  assert.equal(result.dispatch.aspect.pending[0].aspect, 'state-machine')
  assert.equal(result.dispatch.aspect.pending[0].holder, 'session-aspect-holder')
  assert.ok(
    drainWarnings().some((line) => /aspect-pending: state-machine（占用方 session-aspect-holder）/.test(line)),
    'pending 不能静默：至少一条 warning 让人看见在等谁',
  )
  assert.equal(subagents.calls.length, 1, '子代理照样起——锁是串行提示，不是审批')
})

test('aspect 接入③：空 scope.allow 是 no-op（不占用、不影响派工）', async () => {
  const { root, contract } = freshProject('aspect-dispatch-empty')
  writeAspectDocs(root, { 'state-machine': { files: ['lib/stage.mjs'] } })
  const task = addTask(root, contract, { type: 'docs', title: '没有 scope 的卡', stage: 'queued-review' })
  const subagents = fakeSubagents()
  const { deps } = recordDeps(root, contract, subagents, task)
  const result = await dispatchTaskRecord({ ...deps, config: { aspectLock: { waitMs: 0 } } })
  assert.equal(result.dispatch.aspect.skipped, 'no-aspect-overlap')
  assert.deepEqual(result.dispatch.aspect.acquired, [])
  assert.equal(listAspectLocks(root, contract).counts.total, 0)
  assert.equal(result.task.stage, 'reviewing')
})

// ======================== T-20261113205947：agent 唯一化（同角色并行） ========================

const CLI_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'flow.mjs')

function runDispatchCli(root, args) {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], { cwd: root, encoding: 'utf8' })
  let body = null
  try {
    body = JSON.parse(result.stdout)
  } catch {
    // 下面统一带原始输出断言
  }
  assert.ok(body !== null, 'CLI 没有输出 JSON：' + (result.stdout || result.stderr).slice(0, 400))
  return { code: result.status, body }
}

test('派工 agent 唯一化：同角色两卡可同时 queue+ack，同卡仍拒，close 只收本卡', () => {
  const { root, contract } = freshProject('unique-agent')
  const a = addTask(root, contract, { type: 'feat', title: '同角色 A', stage: 'queued-analysis' })
  const b = addTask(root, contract, { type: 'feat', title: '同角色 B', stage: 'queued-analysis' })
  const agentA = 'analyzer:' + a.id
  const agentB = 'analyzer:' + b.id

  core.queueDispatch(root, contract, a.id, { agent: agentA, role: 'analyzer' })
  core.queueDispatch(root, contract, b.id, { agent: agentB, role: 'analyzer' })
  core.ackDispatch(root, contract, a.id, { agent: agentA, session: 'child-a' })
  // ack 名字必须与工单精确一致，不能被同角色的另一张卡冒领（在 ack 之前验）。
  assert.throws(
    () => core.ackDispatch(root, contract, b.id, { agent: agentA, session: 'child-x' }),
    /agent 不匹配/,
    'ack 必须精确匹配 role:taskId',
  )
  // 关键断言：同角色、不同卡，各自持有 open claim，不因「全局 1 条 open/agent」串行。
  core.ackDispatch(root, contract, b.id, { agent: agentB, session: 'child-b' })

  // 同一张卡的第二个未关闭工单仍被拒绝（互斥落在卡上）。
  assert.throws(
    () => core.queueDispatch(root, contract, a.id, { agent: agentA, role: 'analyzer' }),
    /已有未关闭工单/,
    '同卡并发仍必须拒绝',
  )

  core.closeDispatch(root, contract, a.id, { outcome: 'ok' })
  const rows = core.listDispatches(root, contract)
  const rowA = rows.find((row) => row.taskId === a.id)
  const rowB = rows.find((row) => row.taskId === b.id)
  assert.equal(rowA.status, 'ok', 'closed 工单的 status 直接投影 outcome')
  assert.equal(rowA.claim.outcome, 'ok', 'close(ok) 收口本卡 claim')
  assert.equal(typeof rowA.claim.closedAt, 'string', '本卡 claim 必须被同一次写入关闭')
  assert.equal(rowB.status, 'acked', '另一张卡不受影响')
  assert.equal(rowB.claim.closedAt, null)
  assert.equal(rowB.claim.agent, agentB)
})

test('dispatch-list --agent：精确名 role:taskId 与角色前缀都可用', () => {
  const { root, contract } = freshProject('list-agent')
  const a = addTask(root, contract, { type: 'feat', title: '列表 A', stage: 'queued-analysis' })
  const b = addTask(root, contract, { type: 'fix', title: '列表 B', stage: 'queued-review' })
  const agentA = 'analyzer:' + a.id
  const agentB = 'reviewer:' + b.id
  core.queueDispatch(root, contract, a.id, { agent: agentA, role: 'analyzer' })
  core.ackDispatch(root, contract, a.id, { agent: agentA, session: 'child-a' })
  core.queueDispatch(root, contract, b.id, { agent: agentB, role: 'reviewer' })
  core.ackDispatch(root, contract, b.id, { agent: agentB, session: 'child-b' })

  const exact = runDispatchCli(root, ['task', 'dispatch-list', '--agent', agentA, '--json'])
  assert.equal(exact.code, 0)
  assert.deepEqual(exact.body.data.map((row) => row.taskId), [a.id], '精确名只命中本卡')

  const prefixAnalyzer = runDispatchCli(root, ['task', 'dispatch-list', '--agent', 'analyzer', '--json'])
  assert.equal(prefixAnalyzer.code, 0)
  assert.deepEqual(prefixAnalyzer.body.data.map((row) => row.taskId), [a.id], '角色前缀命中该角色全部卡')

  const prefixReviewer = runDispatchCli(root, ['task', 'dispatch-list', '--agent', 'reviewer', '--json'])
  assert.deepEqual(prefixReviewer.body.data.map((row) => row.taskId), [b.id])

  const wrongExact = runDispatchCli(root, ['task', 'dispatch-list', '--agent', 'reviewer:' + a.id, '--json'])
  assert.deepEqual(wrongExact.body.data, [], '精确名不得被前缀误伤')
})

