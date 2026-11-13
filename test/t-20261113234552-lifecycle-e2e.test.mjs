// T-20261113234552：E2E 生命周期加固——fake 服务发真实 subagent/end，走插件真实挂载点。
// 断言看台账事实（工单/checkpoint/阶段），不看内部函数调用次数。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { apply as applyTasks } from '../tasks.js'
import { getTask, initProject, listTasks, loadContract } from '../lib/core.mjs'

const ROOTS = []
after(() => { for (const root of ROOTS) { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ } } })

function makeHarness(root) {
  const handlers = new Map()
  const registered = new Map()
  const calls = []
  const service = {
    calls,
    async startActivation(spec) {
      calls.push(spec)
      return { childId: 'child-' + calls.length }
    },
  }
  const tools = { register(def) { registered.set(def.name, def); return () => registered.delete(def.name) }, guard() { return () => {} }, get(name) { return registered.has(name) ? { name } : undefined } }
  const mainAgent = { id: 'session-main', session: { cwd: root, header: { origin: 'main', delegationDepth: 0 } } }
  const agents = { get: (id) => (id === mainAgent.id ? mainAgent : undefined), list: () => [mainAgent], roots: () => [mainAgent] }
  const ctx = {
    get(name) {
      if (name === 'tools') return tools
      if (name === 'subagents') return service
      if (name === 'agents') return agents
      if (name === 'sessions') return { get: () => undefined, list: () => [] }
      if (name === 'workingDirectory') return { get: () => root }
      if (name === 'webServer') return { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:0' }
      return undefined
    },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    on(name, handler) { const set = handlers.get(name) ?? new Set(); set.add(handler); handlers.set(name, set); return () => set.delete(handler) },
    logger: { warn() {} },
  }
  apply(ctx, { dispatch: { auto: true } })
  applyTasks(ctx, { dispatch: { auto: true } })
  const exec = { agent: mainAgent }
  const emit = (name, payload) => { for (const handler of handlers.get(name) ?? []) handler(payload) }
  return { registered, ctx, exec, service, emit, handlers }
}

function fresh(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-life-' + label + '-'))
  ROOTS.push(root)
  initProject(root, { name: 'life-' + label, noGates: true })
  return { root, contract: loadContract(root).contract }
}

test('生命周期：真实 subagent/end → close(ok)；异常结束 → close(failed) → attempt+1', async (t) => {
  const { root, contract } = fresh('cycle')
  const host = makeHarness(root)
  const taskTool = host.registered.get('flow_task')
  assert.ok(taskTool, '注册工具：' + [...host.registered.keys()].join(','))
  const subtaskTool = host.registered.get('flow_subtask')

  const main = await taskTool.execute({ action: 'add', title: '父卡', type: 'feat', root, stage: 'queued-analysis' }, host.exec)
  const parentId = main.task.id
  // analyzer 拆一张合格子卡（noDispatch），然后发真实 subagent/end。
  await subtaskTool.execute({
    action: 'add', parent: parentId, title: '子卡', type: 'feat',
    mountKind: 'module', mount: 'dispatch', scope: { allow: ['lib/dispatch.mjs'] }, noDispatch: true,
  }, host.exec)
  const childId = getTask(root, contract, parentId).checkpoints.filter((x) => x.kind === 'claim' && !x.closedAt).at(-1)?.session
  assert.equal(typeof childId, 'string', 'analyzer 必须有真实 claim session')
  host.emit('subagent/end', { local: true, id: childId, provider: 'spawn', stopReason: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const after = getTask(root, contract, parentId)
  assert.equal(after.stage, 'analyzing', '父卡仍在分析中（不新增回退边）')
  const children = listTasks(root, contract).filter((t) => t.parent === parentId)
  assert.equal(children.length, 1)
  const child = getTask(root, contract, children[0].id)
  // 真实 subagent/end 已走 closeDispatchedChild：工单 ok、claim 关闭。
  assert.equal(after.dispatch?.outcome, 'ok', 'analyzer 工单必须由真实 end 收口为 ok')
  assert.equal(after.checkpoints.some((x) => x.kind === 'claim' && !x.closedAt), false, 'analyzer claim 必须释放')
  // T-20261114000100：settle 复用派工回执里的 auto 决议，真实 end 必须派实现者。
  assert.equal(child.stage, 'implementing', '真实 end → settle 必须派实现者')
  assert.equal(typeof child.dispatch?.id, 'string', '实现者工单必须落台账')

  // 异常结束：reviewer 子会话在没有推进阶段时结束 → close(failed) + claim 释放 + attempt+1。
  const reviewTask = await taskTool.execute({ action: 'add', title: '审查卡', type: 'feat', root, stage: 'queued-review' }, host.exec)
  const reviewId = reviewTask.task.id
  const reviewSession = getTask(root, contract, reviewId).checkpoints.filter((x) => x.kind === 'claim' && !x.closedAt).at(-1)?.session
  host.emit('subagent/end', { local: true, id: reviewSession, provider: 'spawn', stopReason: 'aborted' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const failed = getTask(root, contract, reviewId)
  assert.equal(failed.dispatch.outcome, 'failed', '异常结束必须 close(failed)')
  assert.equal(failed.dispatch.attempt, 1)
  assert.equal(failed.checkpoints.some((x) => x.kind === 'claim' && !x.closedAt), false, 'claim 必须释放')
  assert.equal(failed.stage, 'reviewing', '阶段停在 working，等下一轮')
})

test('子会话心跳双证据（E2E 侧限制记录）', { skip: 'fake agents 注册表不提供 live child sessions（sessions.get 恒 undefined），真实 subagent/start 心跳注册路径无法在本夹具触发；双证据已由 test/t-20261108-heartbeat-session.test.mjs 覆盖，不伪造绿。' }, () => {})
