// T-20261113213016：打开 dispatch.auto 后的端到端真实链（临时仓库，跑完删除）。
// 覆盖：① 同角色两卡并行；② analyzer 拆卡(mount+noDispatch) → 校验 → settle 派实现者 → 审查 approve → done；
// ③ reject 回退 → 再派实现者 → 连续 3 次 needs-human。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as core from '../lib/core.mjs'
import { addTask, closeDispatch, getTask, initProject, loadContract } from '../lib/core.mjs'
import { apply as applyTasks } from '../tasks.js'
import { buildDefinition as buildSubtaskDefinition } from '../lib/tools/subtasks.mjs'
import { closeDispatchedChild, settleDispatchAfterClose } from '../lib/dispatch.mjs'

const TEMP_ROOTS = []
after(() => {
  for (const root of TEMP_ROOTS) {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-auto-e2e-' + label + '-'))
  TEMP_ROOTS.push(root)
  initProject(root, { name: 'auto-' + label, noGates: true })
  return { root, contract: loadContract(root).contract }
}

function fakeSubagents() {
  const calls = []
  return {
    calls,
    async startActivation(spec) {
      calls.push(spec)
      return { childId: 'child-' + calls.length }
    },
  }
}

function makeHost(root, subagents) {
  const registered = new Map()
  const tools = {
    register(def) { registered.set(def.name, def); return () => registered.delete(def.name) },
    guard() { return () => {} },
    get(name) { return registered.has(name) ? { name } : undefined },
  }
  const mainAgent = { id: 'session-main', session: { cwd: root, header: { origin: 'main', delegationDepth: 0 } } }
  const ctx = {
    get(name) {
      if (name === 'tools') return tools
      if (name === 'subagents') return subagents
      if (name === 'agents') return { get: (id) => (id === mainAgent.id ? mainAgent : undefined), list: () => [mainAgent], roots: () => [mainAgent] }
      if (name === 'workingDirectory') return { get: () => root }
      return undefined
    },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    logger: { warn() {} },
  }
  applyTasks(ctx, { dispatch: { auto: true } })
  const subtask = buildSubtaskDefinition({ ctx, toolRoot: () => root }, { autoDispatch: true })
  registered.set('flow_subtask', subtask)
  const exec = { agent: mainAgent }
  return { tools: registered, exec, ctx }
}

/** 模拟子代理完成当前工作：释放执行权 → 推进阶段（合法边）→ 收口工单。 */
function finishStage(root, contract, host, id, role, nextStage) {
  const task = getTask(root, contract, id)
  const agent = role + ':' + id
  try { releaseTask(root, contract, id, { agent, outcome: 'ok' }) } catch { /* already released */ }
  updateTask(root, contract, id, { stage: nextStage }, { source: 'internal' })
  return closeDispatchedChild(host.ctx, task.dispatch?.ackedAt ? undefined : undefined)
}

test('auto 端到端：同角色并行 + analyzer 拆卡→settle 实现者→approve done（reject 链缺口见尾注）', async (t) => {
  const { root, contract } = freshProject('chain')
  const subagents = fakeSubagents()
  const host = makeHost(root, subagents)
  const taskTool = host.tools.get('flow_task')
  const subtaskTool = host.tools.get('flow_subtask')
  const exec = host.exec

  // ① 同角色两张卡同时自动派工，互不串行。
  const a = await taskTool.execute({ action: 'add', title: '卡A', type: 'feat', root, stage: 'queued-analysis' }, exec)
  const b = await taskTool.execute({ action: 'add', title: '卡B', type: 'feat', root, stage: 'queued-analysis' }, exec)
  assert.equal(subagents.calls.length, 2, '同角色两张卡必须各起一个 analyzer')
  assert.equal(getTask(root, contract, a.task.id).stage, 'analyzing')
  assert.equal(getTask(root, contract, b.task.id).stage, 'analyzing')
  const openA = getTask(root, contract, a.task.id).checkpoints.some((x) => x.kind === 'claim' && !x.closedAt)
  const openB = getTask(root, contract, b.task.id).checkpoints.some((x) => x.kind === 'claim' && !x.closedAt)
  assert.equal(openA && openB, true, '两张卡各自持有 open claim')

  // 收口 B 的 analyzer，清出场。
  const bTask = getTask(root, contract, b.task.id)
  core.updateTask(root, contract, b.task.id, { stage: 'done' }, { source: 'internal' })
  closeDispatchedChild(host.ctx, 'child-2')

  // ② analyzer 拆一张合格子卡（mount + noDispatch），close 后由 settle 派实现者。
  const child = await subtaskTool.execute(
    {
      action: 'add', parent: a.task.id, title: '子卡', type: 'feat',
      mountKind: 'module', mount: 'dispatch', scope: { allow: ['lib/dispatch.mjs'] }, noDispatch: true,
    },
    exec,
  )
  assert.equal(child.task.stage, 'queued-implementation')
  assert.equal(subagents.calls.length, 2, 'noDispatch 不得立即派实现者')
  const analyzerClosed = closeDispatchedChild(host.ctx, 'child-1')
  assert.equal(analyzerClosed.outcome, 'ok')
  const settled = await settleDispatchAfterClose({
    ctx: host.ctx, root, contract, task: getTask(root, contract, a.task.id), result: analyzerClosed, config: { dispatch: { auto: true } },
  })
  assert.equal(subagents.calls.length, 3, 'settle 必须派子卡实现者')
  assert.equal(settled.length, 1)

  // 实现者完成 → queued-review（自动派 reviewer）。
  const impl = getTask(root, contract, child.task.id)
  // 实现者收口（同批释放 claim）后才推进 queued-review，插件才能派 reviewer。
  closeDispatch(root, contract, child.task.id, { outcome: 'ok', reason: '实现完成' })
  await taskTool.execute({ action: 'update', id: child.task.id, root, stage: 'queued-review' }, exec)
  const reviewing = getTask(root, contract, child.task.id)
  assert.equal(reviewing.stage, 'reviewing', '实现完成必须自动派 reviewer（实际：' + reviewing.stage + '，calls=' + subagents.calls.length + '）')
  // 审查通过 → done。
  const reviewerSession = reviewing.checkpoints.filter((x) => x.kind === 'claim' && !x.closedAt).at(-1)?.session
  core.releaseTask(root, contract, child.task.id, { agent: 'reviewer:' + child.task.id, outcome: 'ok' })
  await taskTool.execute({ action: 'update', id: child.task.id, root, stage: 'done' }, exec)
  const reviewClosed = closeDispatchedChild(host.ctx, reviewerSession)
  assert.equal(reviewClosed.outcome, 'ok')
  assert.equal(getTask(root, contract, child.task.id).stage, 'done')

  // ③ 真实链路缺口（T-20261113213016 实测，不伪造绿）：
  // 首轮 reject close + settle 能派实现者；第 2 轮在实现者 close 后 queue/ack reviewer 再 close，
  // settle 未再产生实现者工单，下一轮 closeDispatch 直接报“没有工单”。单测逐次 closeDispatchedChild 是通过的，
  // 差异在 auto/settle 的重复派工交互；按卡要求只记录，不改断言、不改 lib。
  t.diagnostic('③ reject 自动回退：settle 在第 2 轮未产生新工单（真实链路缺口，已上报）')
})
