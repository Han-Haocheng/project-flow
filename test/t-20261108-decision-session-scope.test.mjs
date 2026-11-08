// 决策按会话隔离 + 会话归档自动移除（2026-11-08 用户要求）。
//
// 规则：
//   - 一条 `D-` 只属于提问的会话（`asked_session`）。agent 侧读面（每轮提醒、
//     `flow_decision` 列表/计数）只返回本会话的记录；面板/人工 CLI 仍是全局视图。
//   - `asked_session` 为空的旧记录不属于任何会话，因此对任何会话都不可见。
//   - 会话被归档后（Host workspace registry 的 `archivedSessionIds`），它在
//     台账里的决策全部删除（open 与已关闭都删），并清空指向它们的任务
//     `decision` 指针——不遗留。
//
// 这些用例守的是失败方向：串会话泄漏提醒、归档后留下幽灵决策、以及清理把
// 别人的记录一并删掉。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import {
  addDecision,
  addTask,
  answerDecision,
  initProject,
  listDecisions,
  loadContract,
  purgeArchivedDecisions,
  storePaths,
  summarizeDecisions,
  updateTask,
} from '../lib/core.mjs'
import { composeTurnReminder } from '../lib/host/session.mjs'
import { vetoTask } from '../lib/veto.mjs'

const TEMP_ROOTS = []
const harness = makeHarness()

before(() => {
  apply(harness.ctx, {})
  assert.equal(harness.preStepHandlers().length, 1, 'apply must register exactly one agent/pre-step listener')
})

after(() => {
  harness.disposeAll()
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

// ---------------------------------------------------------------- fixtures

/** Minimal host double: agents + webServer + a workspace registry archive set. */
function makeHarness() {
  const handlers = new Map()
  const effects = []
  const live = new Map()
  const rootIds = new Set()
  const archived = { ids: [] }
  const agents = {
    list: () => [...live.values()],
    roots: () => [...live.entries()].filter(([id]) => rootIds.has(id)).map(([, agent]) => agent),
    get: (id) => live.get(id),
  }
  const webServer = {
    register() {
      return () => {}
    },
    getOrigin() {
      return 'http://127.0.0.1:0'
    },
  }
  const workspaceRegistry = {
    get archivedSessionIds() {
      return archived.ids
    },
  }
  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'agents') return agents
      if (name === 'workspaceRegistry') return workspaceRegistry
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    on(name, handler) {
      const set = handlers.get(name) ?? new Set()
      set.add(handler)
      handlers.set(name, set)
      return () => {
        set.delete(handler)
      }
    },
    logger: {
      warn() {},
    },
  }
  return {
    ctx,
    archived,
    addRoot(id, root) {
      const agent = { id, session: { cwd: root, header: { origin: 'main' } } }
      live.set(id, agent)
      rootIds.add(id)
      return agent
    },
    preStepHandlers: () => {
      const set = handlers.get('agent/pre-step')
      return set === undefined ? [] : [...set]
    },
    disposeAll() {
      for (const dispose of effects.splice(0)) {
        try {
          dispose()
        } catch {
          // best effort
        }
      }
    },
  }
}

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-decision-scope-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `scope-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

function seedDecision(root, contract, question, extra = {}) {
  return addDecision(root, contract, {
    kind: 'input',
    question,
    rationale: '会话隔离测试',
    ...extra,
  }).decision
}

/** Records on disk, so "removed" is checked against the store, not a projection. */
function decisionFiles(root, contract) {
  const dir = storePaths(root, contract).decisions
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : []
}

function seedUnfinishedTask(root, contract, title = '待处理任务') {
  const task = addTask(root, contract, { type: 'feat', title })
  return updateTask(root, contract, task.id, { stage: 'implementing' })
}

// ---------------------------------------------------------------- core read model

test('读模型按会话过滤：全局视图不变，本会话视图只含自己的记录', () => {
  const { root, contract } = freshProject('filter')
  const own = seedDecision(root, contract, 'A 的问题', { asked_session: 'session-A' })
  const other = seedDecision(root, contract, 'B 的问题', { asked_session: 'session-B' })
  const orphan = seedDecision(root, contract, '没有会话的旧问题')

  assert.deepEqual(
    listDecisions(root, contract).map((item) => item.id),
    [own.id, other.id, orphan.id].sort(),
    'no session keeps the global view',
  )
  assert.deepEqual(listDecisions(root, contract, { session: 'session-A' }).map((item) => item.id), [own.id])
  assert.deepEqual(
    listDecisions(root, contract, { session: 'session-A', all: true }).map((item) => item.id),
    [own.id],
    '--all must not widen a session view',
  )
  assert.equal(listDecisions(root, contract, { session: '' }).length, 3, 'empty session is the global view')

  const scoped = summarizeDecisions(root, contract, { session: 'session-A' })
  assert.equal(scoped.counts.open, 1)
  assert.equal(scoped.counts.total, 1)
  assert.equal(summarizeDecisions(root, contract).counts.total, 3)
  assert.equal(summarizeDecisions(root, contract).counts.open, 3)
  assert.equal(summarizeDecisions(root, contract, { session: 'session-Z' }).counts.open, 0)
})

// ---------------------------------------------------------------- archive purge

test('归档清理：只删归档会话的记录（含已关闭），幂等，dry-run 不写盘', () => {
  const { root, contract } = freshProject('purge')
  const aOpen = seedDecision(root, contract, 'A 的 open', { asked_session: 'session-A' })
  const aClosed = seedDecision(root, contract, 'A 的已答', { asked_session: 'session-A' })
  answerDecision(root, contract, aClosed.id, { choice: '好' })
  const bOpen = seedDecision(root, contract, 'B 的 open', { asked_session: 'session-B' })
  const orphan = seedDecision(root, contract, '没有会话的旧问题')
  assert.equal(decisionFiles(root, contract).length, 4)

  const dry = purgeArchivedDecisions(root, contract, ['session-A'], { dryRun: true })
  assert.deepEqual(dry.removed, [aOpen.id, aClosed.id].sort())
  assert.equal(decisionFiles(root, contract).length, 4, 'dry-run must not delete')

  const real = purgeArchivedDecisions(root, contract, ['session-A'])
  assert.deepEqual(real.removed, [aOpen.id, aClosed.id].sort())
  assert.deepEqual(decisionFiles(root, contract), [`${bOpen.id}.json`, `${orphan.id}.json`].sort())
  assert.deepEqual(purgeArchivedDecisions(root, contract, ['session-A']).removed, [], 'second purge is a no-op')
  assert.deepEqual(purgeArchivedDecisions(root, contract, ['session-unknown']).removed, [])
})

test('归档清理清空指向被删决策的任务指针（否决不遗留）', () => {
  const { root, contract } = freshProject('veto-pointer')
  const task = addTask(root, contract, { type: 'feat', title: '被否决的任务' })
  updateTask(root, contract, task.id, { stage: 'analyzing' })
  const veto = vetoTask(root, contract, {
    taskId: task.id,
    reason: '方案不成立',
    asked_session: 'session-veto',
  })
  assert.equal(veto.decision.asked_session, 'session-veto', 'veto decisions carry the session too')
  assert.equal(updateTask(root, contract, task.id, {}).decision, veto.decision.id)

  const purged = purgeArchivedDecisions(root, contract, ['session-veto'])
  assert.deepEqual(purged.removed, [veto.decision.id])
  assert.deepEqual(purged.clearedTasks, [task.id])
  assert.equal(updateTask(root, contract, task.id, {}).decision, null, 'dangling pointer is cleared')
})

// ---------------------------------------------------------------- reminder surface

test('提醒只显示本会话的决策：别的会话与无主记录既不显示也不计数', () => {
  const { root, contract } = freshProject('reminder')
  seedUnfinishedTask(root, contract)
  const own = seedDecision(root, contract, '我自己的问题', { asked_session: 'session-own' })
  seedDecision(root, contract, '别的会话的问题', { asked_session: 'session-other' })
  seedDecision(root, contract, '没有会话的旧问题')

  const mine = composeTurnReminder(root, contract, 'session-own', 2, '')
  assert.ok(mine.includes(own.id), mine)
  assert.ok(mine.includes('我自己的问题'), mine)
  assert.equal(mine.includes('别的会话的问题'), false, mine)
  assert.equal(mine.includes('没有会话的旧问题'), false, mine)
  assert.ok(mine.includes('待决策 1 条'), mine)

  const none = composeTurnReminder(root, contract, 'session-nobody', 2, '')
  assert.ok(none.includes('无待决策'), none)
  assert.equal(none.includes('别的会话的问题'), false, none)
})

test('pre-step：会话归档后，它的决策在提醒生成前被移除', async () => {
  const { root, contract } = freshProject('pre-step')
  const agent = harness.addRoot('session-scope-root', root)
  seedUnfinishedTask(root, contract)
  const mine = seedDecision(root, contract, '我的问题', { asked_session: agent.id })
  const stale = seedDecision(root, contract, '已归档会话的问题', { asked_session: 'session-archived' })
  harness.archived.ids = ['session-archived']

  const listeners = harness.preStepHandlers()
  assert.equal(listeners.length, 1)
  const result = await listeners[0]({ agent, turn: 1, step: 1, messages: [] }, async () => ({
    kind: 'enter',
    messages: [],
  }))
  const text = result.messages[0].content[0].text
  assert.equal(decisionFiles(root, contract).includes(`${stale.id}.json`), false, 'archived decision is gone')
  assert.ok(decisionFiles(root, contract).includes(`${mine.id}.json`), 'own decision stays')
  assert.ok(text.includes(mine.id), text)
  assert.equal(text.includes('已归档会话的问题'), false, text)
})
