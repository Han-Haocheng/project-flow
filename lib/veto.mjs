// task-74 P4 第 2 组 — 分析期否决（纯本地台账，不碰团队板）。
//
// 两条路径，刻意不对称：
//   - 子任务否决：会话自决，不上报。子任务 done + notes [removed] + veto；父任务
//     notes 记一行。**不建决策**。
//   - 主任务否决：必须上交决策（复用既有 flow_decision），任务停在 analyzing，
//     `decision` 指向该 D 记录；用户答 modify / delete 后由 applyVetoAnswer 执行。
//
// `veto` 是历史：任何答案都不清它；`decision` 是待办指针：答完清空。

import { addDecision, answerDecision, getDecision, getTask, listTasks, updateTask } from './core.mjs'
import { invalid, isPlainObject } from './util.mjs'

/** The only two answers a veto decision accepts (CONTRACT §7). */
export const VETO_CHOICES = Object.freeze(['modify', 'delete'])

const VETO_OPTIONS = Object.freeze([
  {
    id: 'modify',
    label: '修改后重新入栈',
    impact: '清空 decision，阶段回到 queued-analysis 重新排队；veto 历史保留。',
  },
  {
    id: 'delete',
    label: '自动移到已完成',
    impact: '阶段置为 done（done_at 落盘），交给既有 7 天归档规则；veto 历史保留。',
  },
])

function stamp(at) {
  return typeof at === 'string' && at.trim() !== '' ? at.trim() : new Date().toISOString()
}

function requireText(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw invalid(`${label} is required`)
  return text
}

function appendNote(notes, line) {
  const current = typeof notes === 'string' ? notes.trimEnd() : ''
  return current === '' ? line : `${current}\n${line}`
}

function taskOf(root, contract, id, label) {
  const taskId = requireText(id, 'id')
  const task = getTask(root, contract, taskId)
  if (task === null || task === undefined) throw invalid(`${label} not found: ${taskId}`)
  return task
}

/**
 * Veto a **subtask**: the session decides on its own, no decision is created.
 * The child is completed (never physically deleted) and the parent's notes gain
 * one line, so the rejection is visible in the ordinary task view.
 */
export function vetoSubtask(root, contract, input = {}) {
  const reason = requireText(input.reason, 'reason')
  const at = stamp(input.at)
  const child = taskOf(root, contract, input.taskId, 'subtask')
  const parentId = typeof child.parent === 'string' ? child.parent : ''
  if (parentId === '') throw invalid(`task ${child.id} is not a subtask (no parent)`)

  const vetoed = updateTask(root, contract, child.id, {
    stage: 'done',
    notes: appendNote(child.notes, `[removed] ${reason}`),
    veto: { by: 'analysis', reason, at },
  })

  const parent = getTask(root, contract, parentId)
  let updatedParent = parent
  if (parent !== null && parent !== undefined) {
    updatedParent = updateTask(root, contract, parentId, {
      notes: appendNote(parent.notes, `[veto] 子任务 ${child.id} 已否决：${reason}`),
    })
  }
  return { task: vetoed, parent: updatedParent }
}

/**
 * Veto a **main task**: stays in `analyzing`, gets a `flow_decision` of
 * `kind:'choice'` with exactly `modify` / `delete`, and `decision` points at it.
 * The caller (session) must surface the decision id to the user.
 */
export function vetoTask(root, contract, input = {}) {
  const reason = requireText(input.reason, 'reason')
  const at = stamp(input.at)
  const task = taskOf(root, contract, input.taskId, 'task')
  if (task.stage !== 'analyzing') {
    throw invalid(`task ${task.id} is in stage ${task.stage}; a main-task veto is only allowed in analyzing`)
  }
  const created = addDecision(root, contract, {
    kind: 'choice',
    question: `任务 ${task.id}「${task.title}」在分析阶段被否决：${reason}。要修改后重新入栈，还是自动移到已完成？`,
    options: VETO_OPTIONS.map((option) => ({ ...option })),
    recommendation: 'modify',
    rationale: `分析期否决（${at}）：modify 保留任务并重新分析；delete 移到已完成并交给 7 天归档。`,
  })
  const decisionId = created.decision.id
  const vetoed = updateTask(root, contract, task.id, {
    decision: decisionId,
    veto: { by: 'analysis', reason, at },
  })
  return { task: vetoed, decision: created.decision, created: created.created }
}

/** Validate + apply only the task-side half of a veto answer (no decision write). */
function applyVetoPatch(root, contract, task, choice) {
  if (VETO_CHOICES.includes(choice) === false) {
    throw invalid(`choice must be one of ${VETO_CHOICES.join(', ')}`)
  }
  const patch = choice === 'modify'
    ? { decision: null, stage: 'queued-analysis' }
    : { decision: null, stage: 'done' }
  // 内部写：否决的 delete 分支无条件收口到 done，不承担本任务的语义/测试证据
  // （spec §7 豁免二）。这是 `source:'internal'` 的唯一生产调用点。
  return updateTask(root, contract, task.id, patch, { source: 'internal' })
}

/**
 * Execute the user's answer manually (`flow_veto answer`).
 *
 * Idempotent: a task that was vetoed and already has `decision === null` is
 * returned unchanged (`applied:false`) instead of throwing — a retry after the
 * automatic path already ran must not advance the stage twice.
 */
export function applyVetoAnswer(root, contract, input = {}) {
  const choice = requireText(input.choice, 'choice')
  if (VETO_CHOICES.includes(choice) === false) {
    throw invalid(`choice must be one of ${VETO_CHOICES.join(', ')}`)
  }
  const task = taskOf(root, contract, input.taskId, 'task')
  if (task.veto === undefined || task.veto === null) throw invalid(`task ${task.id} was not vetoed`)
  const decisionId = typeof task.decision === 'string' ? task.decision.trim() : ''
  if (decisionId === '') return { task, decision: null, applied: false }
  const answered = answerDecision(root, contract, decisionId, { choice, by: 'user' })
  return { task: applyVetoPatch(root, contract, task, choice), decision: answered, applied: true }
}

/**
 * The automatic half of the veto flow: after a decision is answered, find the
 * ledger task that points at it (`task.decision === decisionId`) and apply the
 * answered choice. This is the **single discriminator** — never the option ids.
 *
 * @returns `{ applied:true, task }`, or `null` when nothing matches (a normal
 *   decision, an already-applied veto, or a pointer without a veto record).
 */
export function applyVetoForDecision(root, contract, decisionId) {
  const id = typeof decisionId === 'string' ? decisionId.trim() : ''
  if (id === '') return null
  const tasks = listTasks(root, contract)
  const task = tasks.find((record) => isPlainObject(record) && typeof record.decision === 'string' && record.decision.trim() === id)
  if (task === undefined) return null
  if (isPlainObject(task.veto) === false) return null
  const decision = getDecision(root, contract, id)
  if (isPlainObject(decision) === false) return null
  const choice = isPlainObject(decision.answer) && typeof decision.answer.choice === 'string' ? decision.answer.choice.trim() : ''
  if (choice === '') return null
  return { applied: true, task: applyVetoPatch(root, contract, task, choice) }
}

/**
 * `flow_decision answer` orchestration shared by the tool and the CLI.
 *
 * Order is a hard requirement: **record the answer first**, then try to apply it.
 * If applying fails, the answer stays recorded and the caller reports
 * `vetoApplied:false` + `vetoWarning`; the user can retry with `flow_veto answer`.
 */
export function answerDecisionAndApply(root, contract, id, patch = {}) {
  const decision = answerDecision(root, contract, id, patch)
  try {
    const applied = applyVetoForDecision(root, contract, id)
    if (applied === null) return { decision, vetoApplied: false }
    return { decision, vetoApplied: true, task: applied.task }
  } catch (error) {
    const message = error !== null && error !== undefined && typeof error.message === 'string' && error.message !== ''
      ? error.message
      : String(error)
    return { decision, vetoApplied: false, vetoWarning: message }
  }
}
