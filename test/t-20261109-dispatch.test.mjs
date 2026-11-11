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
  DISPATCH_ROLES,
  WORKING_STAGE,
  autoDispatchTask,
  dispatchCheckpoint,
  dispatchEnabled,
  dispatchPlan,
  dispatchPrompt,
  dispatchProvider,
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

/** 最小宿主：tools 注册面 + workingDirectory + 可选 subagents。 */
function makeHost(root, { subagents, team, config } = {}) {
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
  assert.equal(dispatchPlan({ id: 'T-2', stage: 'queued-analysis', parent: 'T-1' }).ok, true, '子任务各自派工（2026-11-11 流程）')
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
// ① 派工前重读、② 写回执前 CAS、③ 同 from 不重复派、④ 正常路径不受影响。

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
    agent: exec.agent, root, contract, task: stale, config: undefined,
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
  assert.deepEqual(after.checkpoints, [], '冲突时不得留下派工回执')
})

test('派工不校验终态 ③：同一 from 阶段重复调用 dispatch 不重复起子代理', async () => {
  const { root, contract } = freshProject('race-dup')
  const task = addTask(root, contract, { type: 'feat', title: '幂等派工', stage: 'queued-analysis' })
  const subagents = fakeSubagents()
  const first = await dispatchTaskRecord(recordDeps(root, contract, subagents, getTask(root, contract, task.id)).deps)
  assert.equal(subagents.calls.length, 1)
  assert.equal(first.task.stage, 'analyzing')

  /* 阶段被人退回 queued-analysis（同一条入口）：不得再起第二个 worker，
     直接返回已有回执。 */
  updateTask(root, contract, task.id, { stage: 'queued-analysis' }, { source: 'internal' })
  const second = await dispatchTaskRecord(recordDeps(root, contract, subagents, getTask(root, contract, task.id)).deps)
  assert.equal(subagents.calls.length, 1, '不得重复起子代理')
  assert.equal(second.reused, true)
  assert.equal(second.dispatch.childId, 'child-1', '返回的是已有回执')
  assert.equal(second.task.stage, 'queued-analysis', '复用时不改台账')

  /* `failed: true` 是显式「这次没派成」的标记：允许重派。 */
  const checkpoints = getTask(root, contract, task.id).checkpoints.map((item) => ({ ...item, failed: true }))
  updateTask(root, contract, task.id, { checkpoints }, { source: 'internal' })
  const third = await dispatchTaskRecord(recordDeps(root, contract, subagents, getTask(root, contract, task.id)).deps)
  assert.equal(subagents.calls.length, 2, '失败标记后可重派')
  assert.equal(third.task.stage, 'analyzing')
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
  assert.equal(result.task.checkpoints.length, 1)
  assert.equal(result.task.checkpoints[0].childId, 'child-1')
  /* 工具层仍会拒绝在 working 阶段的第二次派工（不破坏既有语义）。 */
  const { tool, exec } = makeHost(root, { subagents })
  await assert.rejects(() => tool.execute({ action: 'dispatch', id: task.id, root }, exec), /只有待分析\/待实现\/待审查可以派工/)
  assert.equal(subagents.calls.length, 1)
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

  const main = await taskTool.execute({ action: 'add', title: '父任务', type: 'feat', root, stage: 'queued-analysis' }, host.exec)
  const parentId = main.task.id
  /* 首轮分析者：拆任务（flow_subtask add）后从 analyzing 推到 queued-implementation。 */
  const subtaskTool = host.tool
  const child = await subtaskTool.execute({ action: 'add', parent: parentId, title: '子任务一', type: 'feat' }, host.exec)
  await taskTool.execute({ action: 'update', id: parentId, root, stage: 'queued-implementation' }, host.exec)
  /* 子任务实现/审查完成 → 父任务被聚合回待分析并重新派分析者（汇总轮）。 */
  for (const stage of ['queued-review', 'done']) {
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
  assert.deepEqual(step.alternatives.map((row) => row.stage), ['done'])
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
