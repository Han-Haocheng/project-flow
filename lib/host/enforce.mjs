// project-flow — Host P2 permission surface: the tool restriction applied on
// agent creation and the guards that deny a call which bypasses the visible
// surface. Split out of index.js so the permission seam has its own write region
// (docs/module-boundaries.md). Stage facts come from lib/stage.mjs only.

import { brief, coreModule, isPlainObject } from '../state-snapshot.mjs'
import { service, warnMount } from '../plugin/mount.mjs'
import { STAGE_ZH, actorForEdge, edgeOf, nextStages } from '../stage.mjs'
import { agentRoot, rootSessionVerdict } from './session.mjs'

// ------------------------------------------------------- P2 permission surface
//
// Plan §5.2: a main session may do four things — advance a stage it owns, manage
// subtasks in the implementation stages, read status and update its heartbeat.
// Everything else is denied, and every denial says how to proceed correctly.
//
// `restrict` (per-agent scope, applied on agent creation) hides the team tools;
// `guard` denies them again if a call bypasses the visible surface (PTC / nested
// scheduling). Subagents are exempt from rules 1-2: they exist to dispatch work
// and to create tasks.

/**
 * The team surface has two different meanings, and conflating them froze the
 * board in the real Host (regression 1, handoff 2026-11-07):
 *
 * - **dispatch** = spawning/deriving agents (`spawn_teammate` / `subagent*`).
 *   The user's rule "a session must not dispatch the team" is about this.
 * - **bookkeeping** = maintaining the shared task board (`team_task_*`).
 *   Marking a card done or creating one is bookkeeping, not dispatch; blocking
 *   it while P3b does not exist means nobody can run the team at all.
 *
 * `boardMode` decides the bookkeeping half: `lead` (default) lets the main
 * session keep the board; `plugin` hides it too (P3b flips the default).
 * Unknown names are filtered before `restrict`.
 */
const DISPATCH_TOOL_NAMES = Object.freeze(['spawn_teammate', 'subagent', 'subagent_fork'])

const BOARD_TOOL_NAMES = Object.freeze([
  'team_task_create',
  'team_task_update',
  'team_task_list',
  'team_task_get',
  'team_task_delete',
])

const TEAM_TOOL_NAMES = Object.freeze([...DISPATCH_TOOL_NAMES, ...BOARD_TOOL_NAMES])

export const DISPATCH_TOOL_DENY = new Set(DISPATCH_TOOL_NAMES)
export const TEAM_TOOL_DENY = new Set(TEAM_TOOL_NAMES)

const MAIN_SESSION_TEAM_DENY =
  '项目流：主会话不得直接调度团队。用 flow_task_update（即 flow_task 的 update 动作）推进阶段，插件会派工。'

const MAIN_SESSION_TASK_ADD_DENY =
  '项目流：任务由插件按你的每句话自动创建，不需要也不允许手动建。若要补记一条，说明理由后由插件建。'

/** Stages in which subtasks may be added/removed (plan §5.1). */
const SUBTASK_STAGES = Object.freeze(['queued-implementation', 'implementing'])

/** The stage record of one task, or `null` when it cannot be read (then allow). */
export function guardTaskOf(ctx, agent, id) {
  try {
    if (typeof id !== 'string' || id.trim() === '') return null
    const root = agentRoot(ctx, agent)
    if (root === undefined) return null
    const c = coreModule()
    if (c === null || typeof c.getTask !== 'function') return null
    const loaded = c.loadContract(root)
    return c.getTask(root, loaded.contract, id.trim())
  } catch {
    return null
  }
}

/**
 * Rules 3 and 4: a `flow_task update` that names a stage must walk a real edge,
 * and that edge must belong to the session. Both facts come from `lib/stage.mjs`
 * (`edgeOf` / `actorForEdge` / `nextStages`) — a second stage table here would
 * drift from the machine.
 */
export function stageGuardReason(ctx, agent, args, actorMode) {
  const to = typeof args.stage === 'string' ? args.stage.trim() : ''
  if (to === '') return undefined
  const task = guardTaskOf(ctx, agent, args.id)
  if (task === null) return undefined
  const from = typeof task.stage === 'string' ? task.stage.trim() : ''
  if (from === '') return undefined
  if (from === to) return undefined // idempotent rewrite, same semantics as canTransition
  const edge = edgeOf(from, to)
  if (edge === null) {
    const legal = nextStages(from)
    return `项目流：${from} 只能到 ${legal.length === 0 ? '（无后继）' : legal.join('、')}，你给了 ${to}。`
  }
  // Rule 4 is the `team`-mode implementation. `single` (the default today) still
  // enforces the structure (rule 3 above) but not the role split: there is one
  // role, so "who may walk this edge" would deadlock the pipeline until P3.
  if (actorMode === 'team' && edge.actor !== 'session') {
    const mine = nextStages(from).filter((next) => actorForEdge(from, next) === 'session')
    return `项目流：${from} → ${to} 由 ${String(edge.actor)} 推进，不是你。你只能推进：${mine.length === 0 ? '（无）' : mine.join('、')}。`
  }
  return undefined
}

/** Rule 5: subtasks may only be touched in the implementation stages. */
export function subtaskGuardReason(ctx, agent, args) {
  const action = typeof args.action === 'string' ? args.action : ''
  if (action !== 'add' && action !== 'remove') return undefined
  let parentId = typeof args.parent === 'string' ? args.parent.trim() : ''
  if (parentId === '' && typeof args.parentId === 'string') parentId = args.parentId.trim()
  let parent = parentId === '' ? null : guardTaskOf(ctx, agent, parentId)
  if (parent === null && action === 'remove') {
    const record = guardTaskOf(ctx, agent, args.id)
    if (record !== null && typeof record.parent === 'string' && record.parent.trim() !== '') {
      parent = guardTaskOf(ctx, agent, record.parent.trim())
    }
  }
  if (parent === null) return undefined
  const stage = typeof parent.stage === 'string' ? parent.stage.trim() : ''
  if (SUBTASK_STAGES.includes(stage)) return undefined
  return `项目流：只有实现阶段可以改子任务（当前 ${STAGE_ZH[stage] ?? stage}）。`
}

/**
 * The P2 guard predicate: `undefined` allows, a string denies. It never throws
 * (a guard failure must not turn into a denied tool call) and it only inspects
 * the tool names/shapes it knows; everything else is the normal tool layer.
 */
export function enforceGuardReason(ctx, execution, actorMode, deniedTools) {
  try {
    if (execution === null || execution === undefined) return undefined
    const name = typeof execution.name === 'string' ? execution.name : ''
    if (name === '') return undefined
    const args = isPlainObject(execution.arguments) ? execution.arguments : {}
    const agent = execution.agent
    const main = rootSessionVerdict(ctx, agent) === true
    if (main && deniedTools instanceof Set && deniedTools.has(name)) return MAIN_SESSION_TEAM_DENY
    if (name === 'flow_task') {
      const action = typeof args.action === 'string' ? args.action : ''
      if (action === 'add') return main ? MAIN_SESSION_TASK_ADD_DENY : undefined
      if (action === 'update') return stageGuardReason(ctx, agent, args, actorMode)
      return undefined
    }
    if (name === 'flow_subtask') return subtaskGuardReason(ctx, agent, args)
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Rule ① of §5.2: hide the team tools from a main session's scope. `restrict`
 * refuses a context-global filter, so it is applied per agent on creation and
 * only to main sessions; names the host does not provide are dropped first
 * (`restrict` throws on unknown names).
 */
export function restrictMainSessionTools(ctx, agent, restrictedAgents, boardMode) {
  try {
    if (rootSessionVerdict(ctx, agent) !== true) return
    if (isPlainObject(agent) === false) return
    // One restriction per agent per mount: the pre-step fallback runs on every
    // step, and stacking identical restrictions would accumulate layers.
    const restricted = restrictedAgents instanceof WeakSet ? restrictedAgents : null
    if (restricted !== null && restricted.has(agent)) return
    const scope = agent.ctx
    if (scope === undefined || scope === null) return
    const tools = service(scope, 'tools')
    if (tools === undefined || tools === null || typeof tools.restrict !== 'function') return
    if (restricted !== null) restricted.add(agent)
    let deny = (boardMode === 'plugin' ? TEAM_TOOL_NAMES : DISPATCH_TOOL_NAMES).slice()
    if (typeof tools.get === 'function') {
      deny = deny.filter((name) => {
        try {
          return tools.get(name) !== undefined
        } catch {
          return false
        }
      })
    }
    if (deny.length === 0) return
    tools.restrict({ deny })
  } catch (error) {
    warnMount(`enforce: restrict failed: ${brief(error)}`, ctx)
  }
}

/** Whether the P2 permission surface is on (`config.enforce !== false`). */
export function enforceEnabled(config) {
  return isPlainObject(config) === false || config.enforce !== false
}

/**
 * `enforce.actorMode`: `single` (default) or `team`.
 *
 * `single` = one role does everything today: rule 4 (actor) is off, rule 3
 * (structure) stays on, so skipping stages is still denied. `team` = the target
 * design once P3 dispatches work and the analyzer/implementer/reviewer split
 * exists. An invalid value is `single` plus one mount warning (never a crash).
 */
export function resolveActorMode(config, ctx) {
  const enforce = isPlainObject(config) ? config.enforce : undefined
  if (isPlainObject(enforce) === false) return 'single'
  const requested = enforce.actorMode
  if (requested === undefined || requested === null) return 'single'
  const mode = typeof requested === 'string' ? requested.trim() : ''
  if (mode === 'single' || mode === 'team') return mode
  warnMount(
    `enforce.actorMode 非法（${JSON.stringify(requested)}）：按 single 处理（可选 single|team）`,
    ctx,
  )
  return 'single'
}

/**
 * `enforce.boardMode`: `lead` (default) or `plugin`.
 *
 * `lead` = the main session keeps the shared task board (`team_task_*` allowed)
 * but still may not dispatch (`spawn_teammate` / `subagent*` denied). `plugin`
 * hides the whole team surface (P3b, once the plugin maintains the board).
 * Invalid values are `lead` + one mount warning.
 */
export function resolveBoardMode(config, ctx) {
  const enforce = isPlainObject(config) ? config.enforce : undefined
  if (isPlainObject(enforce) === false) return 'lead'
  const requested = enforce.boardMode
  if (requested === undefined || requested === null) return 'lead'
  const mode = typeof requested === 'string' ? requested.trim() : ''
  if (mode === 'lead' || mode === 'plugin') return mode
  warnMount(`enforce.boardMode 非法（${JSON.stringify(requested)}）：按 lead 处理（可选 lead|plugin）`, ctx)
  return 'lead'
}

/** Whether the P1 capture/status behaviour is on (`config.capture !== false`). */
