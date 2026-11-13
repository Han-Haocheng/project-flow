// 2026-11-11（用户流程）：lead 建主任务 → 分析者拆子任务 → 实现者 → 审查者
// 全部由插件派工，子任务流转不经过主会话；子任务全部终态后父任务回待分析，
// 分析者做汇总轮并推进 done。
//
// 这组用例端到端跑一条"无人执手"的流水线（假宿主 subagents 服务记录每次派工），
// 锁住四个观察点：① add 即派分析者；② 子任务建卡即派实现者；③ 阶段推进派审查者；
// ④ 子任务全完成后父任务聚合 + 再派分析者（汇总轮）。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getTask, initProject, listTasks, loadContract } from '../lib/core.mjs'
import { apply as applyTasks } from '../tasks.js'
import { buildDefinition as buildSubtaskDefinition } from '../lib/tools/subtasks.mjs'

const TEMP_ROOTS = []

after(() => {
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-pipe-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `pipe-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

/** 记录每次派工的假 subagents 服务。 */
function fakeSubagents() {
  const calls = []
  return {
    calls,
    async startActivation(spec) {
      calls.push({ label: spec.label, prompt: spec.request.prompt[0].text, provider: spec.provider })
      return { childId: `child-${calls.length}` }
    },
  }
}

function makeHost(root, { subagents } = {}) {
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
  // T-20261113160505：插件自动派工默认关，本用例验证自动流水线，夹具显式打开。
  applyTasks(ctx, { dispatch: { auto: true } })
  // 子任务工具走宿主装配路径（lib/host/tools.mjs 的 deps 形状）：这里直接构造同形 deps。
  const subtask = buildSubtaskDefinition({ ctx, toolRoot: () => root }, { autoDispatch: true })
  registered.set('flow_subtask', subtask)
  const exec = {
    agent: { id: 'session-main', session: { cwd: root, header: { origin: 'main', delegationDepth: 0 } } },
  }
  return { tools: registered, exec }
}

test('流水线：add 即派分析者，子任务自动派实现者/审查者，全完成后父任务回待分析再派分析者', async () => {
  const { root, contract } = freshProject('walk')
  const subagents = fakeSubagents()
  const host = makeHost(root, { subagents })

  // ① lead 建主任务（直接进待分析）→ 插件派分析者
  const main = await host.tools
    .get('flow_task')
    .execute({ action: 'add', title: '主任务', type: 'feat', root, stage: 'queued-analysis' }, host.exec)
  assert.equal(main.task.stage, 'analyzing', '建主任务即进入分析中')
  assert.equal(main.dispatch.auto, true)
  assert.equal(main.dispatch.role, 'analyzer')
  assert.equal(subagents.calls.length, 1)

  // ② 分析者拆子任务（默认待实现）→ 插件派实现者
  const child = await host.tools
    .get('flow_subtask')
    .execute({ action: 'add', parent: main.task.id, title: '子任务一', type: 'feat' }, host.exec)
  assert.equal(child.task.stage, 'implementing', '子任务建卡即派实现者并进入实现中')
  assert.equal(child.task.parent, main.task.id)
  assert.equal(child.dispatch.role, 'implementer')
  assert.equal(subagents.calls.length, 2)

  // ③ 实现者推进到待审查 → 插件派审查者
  const review = await host.tools
    .get('flow_task')
    .execute({ action: 'update', id: child.task.id, root, stage: 'queued-review' }, host.exec)
  assert.equal(review.task.stage, 'reviewing')
  assert.equal(review.dispatch.role, 'reviewer')
  assert.equal(subagents.calls.length, 3)

  // ④ 审查通过 → 子任务 done → 父任务聚合回待分析，再派分析者做汇总轮
  const done = await host.tools
    .get('flow_task')
    .execute({ action: 'update', id: child.task.id, root, stage: 'done' }, host.exec)
  assert.equal(getTask(root, contract, child.task.id).stage, 'done', '子任务落到 done')
  const parent = getTask(root, contract, main.task.id)
  assert.equal(parent.stage, 'analyzing', '父任务被聚合回待分析后再派工，落到分析中')
  assert.match(String(parent.notes), /\[auto\]/, '聚合说明写进父任务 notes')
  assert.equal(subagents.calls.length, 4, '汇总轮再派一次分析者')
  assert.equal(subagents.calls[3].label.includes('分析'), true, '第四次派工是分析者')
  assert.equal(done.task.id, main.task.id, '返回值里的任务就是聚合后的父任务')
})

test('流水线：子任务没全部完成时父任务不聚合（第二个子任务仍待实现）', async () => {
  const { root, contract } = freshProject('partial')
  const subagents = fakeSubagents()
  const host = makeHost(root, { subagents })
  const main = await host.tools
    .get('flow_task')
    .execute({ action: 'add', title: '主任务', type: 'feat', root, stage: 'queued-analysis' }, host.exec)
  const a = await host.tools
    .get('flow_subtask')
    .execute({ action: 'add', parent: main.task.id, title: 'A', type: 'feat' }, host.exec)
  const b = await host.tools
    .get('flow_subtask')
    .execute({ action: 'add', parent: main.task.id, title: 'B', type: 'feat' }, host.exec)

  await host.tools
    .get('flow_task')
    .execute({ action: 'update', id: a.task.id, root, stage: 'queued-review' }, host.exec)
  await host.tools.get('flow_task').execute({ action: 'update', id: a.task.id, root, stage: 'done' }, host.exec)

  const parent = getTask(root, contract, main.task.id)
  assert.equal(parent.stage, 'analyzing', '还有一个子任务未完成，父任务保持分析中')
  assert.equal(
    listTasks(root, contract).filter((task) => task.parent === main.task.id && task.stage !== 'done').length,
    1,
    'B 仍待完成',
  )
  assert.equal(b.task.parent, main.task.id)
})

test('幂等：非阶段字段的 update 不重复派工', async () => {
  const { root } = freshProject('idempotent')
  const subagents = fakeSubagents()
  const host = makeHost(root, { subagents })
  const added = await host.tools
    .get('flow_task')
    .execute({ action: 'add', title: '主任务', type: 'feat', root, stage: 'queued-analysis' }, host.exec)
  assert.equal(subagents.calls.length, 1)
  const noted = await host.tools
    .get('flow_task')
    .execute({ action: 'update', id: added.task.id, root, notes: '补充说明' }, host.exec)
  assert.equal(noted.dispatch, undefined, '只改 notes 不派工')
  assert.equal(subagents.calls.length, 1)
})
