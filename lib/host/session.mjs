// project-flow — Host session surface: heartbeat lifecycle, per-turn reminder,
// capture pipeline hooks and the agent/created|disposed wiring. Split out of
// index.js so the session seam has its own write region (docs/module-boundaries.md).

import { dispatchProvider, dispatchTaskRecord, hasSubagentService } from '../dispatch.mjs'
import { fork } from 'node:child_process'
import { backupHealthWarning } from '../backup.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brief,
  buildSnapshot,
  clip,
  coreAvailable,
  coreModule,
  coreUnavailableMessage,
  decisionCountsOf,
  decisionRemindMax,
  emptyDecisionCounts,
  heartbeatRowVisible,
  isPlainObject,
  isoLocal,
  readManifestName,
  requireCore,
  storeContractPath,
  takeCoreWarnings,
  timeValue,
  toPosix,
} from '../state-snapshot.mjs'
import {
  EMPTY_STORE_NOTE,
  hasStore,
  makeToolRoot,
  MAX_TOOL_ITEMS,
  pickFields,
  requireId,
  requireStore,
  ROOT_PROPERTY,
  toolOutput,
  WRITE_TIMEOUT_MS,
} from '../plugin/shared.mjs'
// The one mount implementation: service lookup, ctx.effect registration, the
// core-warning wrapper and the mount-warning channel are shared with the three
// module sub-plugins (tasks.js / gates.js / experiments.js).
import { STAGE_ZH, actorForEdge, edgeOf, nextStages } from '../stage.mjs'
import { readTeamBoard, reconcileLinks, teamStatusOf } from '../team-sync.mjs'
import { buildDefinition as buildSubtaskDefinition } from '../tools/subtasks.mjs'
import { answerDecisionAndApply, applyVetoAnswer, vetoSubtask, vetoTask } from '../veto.mjs'
import { commandNameOf, parseCommand } from '../commands.mjs'
import {
  buildStatusBlock,
  createCaptureState,
  flushCapture,
  noteCaptureGate,
  recordPreStep,
  stackTop,
  textOfContent,
} from '../capture.mjs'
import {
  mountWarnings,
  provide,
  registerToolDefinitions,
  service,
  toolDeps,
  warnMount,
} from '../plugin/mount.mjs'
import {
  GATE_ROUTE_PATH,
  HEARTBEAT_GATE_TOOLS,
  HEARTBEAT_SESSION_MAX,
  HEARTBEAT_SESSION_PATTERN,
  INIT_ROUTE_PATH,
  MAX_INIT_BODY_BYTES,
  MAX_INIT_CREATED,
  MAX_INIT_WARNINGS,
  PACKAGE_ROOT,
  ROUTE_PATH,
  SUBAGENT_ORIGIN,
  canonicalRoot,
  hasStoreAsync,
  isDirectory,
  listWorkspaces,
  originAllowed,
  readBody,
  rootAccepted,
  rootName,
  sendError,
  sendJson,
  toolRoot,
} from './shared.mjs'

// --------------------------------------------------------------- heartbeats
//
// A heartbeat is the per-session registration that tells the panel and the
// other sessions what this agent is doing and which files it owns. The tool
// writes through lib/core.mjs; the two hooks below only *read* it, and every
// failure degrades to "unknown" instead of blocking the host.

/** The session id of one tool run: the agent id, then `DSH_SESSION_ID`. */
export function sessionIdOf(exec) {
  let id
  try {
    id = exec !== null && exec !== undefined && exec.agent !== undefined ? exec.agent.id : undefined
  } catch {
    id = undefined
  }
  if (typeof id === 'string' && id.trim().length > 0) return id.trim()
  const env = typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID.trim() : ''
  return env.length > 0 ? env : undefined
}

/**
 * A session id that can safely name a heartbeat file. Core validates its own
 * input; this pre-check only keeps a hostile or empty id out of the hooks (a
 * hook cannot report a usage error to anyone).
 */
export function usableSessionId(value) {
  if (typeof value !== 'string') return ''
  const session = value.trim()
  if (session.length === 0 || session.length > HEARTBEAT_SESSION_MAX) return ''
  if (session.includes('..') || session.includes('/') || session.includes('\\')) return ''
  return HEARTBEAT_SESSION_PATTERN.test(session) ? session : ''
}

/** Session id for a tool call, or an actionable error. */
export function requireSession(exec) {
  const session = sessionIdOf(exec)
  if (session === undefined) {
    throw new Error(
      'flow_heartbeat needs a session: this run exposes no agent id and DSH_SESSION_ID is unset (pass the tool from a live agent session)',
    )
  }
  return session
}

/**
 * Session ids the optional host `agents` service reports as live: roots plus
 * every live agent. `null` when the host does not expose the service, so callers
 * can tell "no evidence" from "evidence says nobody is live".
 */
export function liveSessionIds(ctx) {
  const agents = service(ctx, 'agents')
  if (agents === undefined || agents === null) return null
  const ids = new Set()
  const add = (value) => {
    const id = usableSessionId(isPlainObject(value) ? value.id : value)
    if (id !== '') ids.add(id)
  }
  for (const method of ['roots', 'list']) {
    try {
      if (typeof agents[method] !== 'function') continue
      const value = agents[method]()
      if (Array.isArray(value)) {
        for (const agent of value) add(agent)
      }
    } catch {
      // An unavailable registry is "no evidence", never a hard failure.
    }
  }
  return ids
}

/** Whether the host agent registry reports this session as live right now. */
export function sessionIsLive(ctx, session) {
  const id = usableSessionId(session)
  if (id === '') return false
  const agents = service(ctx, 'agents')
  if (agents === undefined || agents === null) return false
  try {
    if (typeof agents.get === 'function' && agents.get(id) !== undefined && agents.get(id) !== null) return true
  } catch {
    // Fall through to the list projection.
  }
  const ids = liveSessionIds(ctx)
  return ids !== null && ids.has(id)
}

/**
 * Apply the host's positive evidence to the state payload's heartbeat rows: a
 * session the `agents` service reports live becomes `liveness: 'live'` /
 * `reason: 'agent-live'` — a busy session that has not refreshed its heartbeat
 * for >6 h is alive, not dead. A row the core judged `dead` is never overwritten
 * (pid evidence is stronger). The state payload projects heartbeats as a plain
 * row array (the panel derives its own counts), so only rows are touched.
 */
export function applyAgentLiveness(ctx, payload) {
  if (isPlainObject(payload) === false || Array.isArray(payload.heartbeats) === false) return payload
  const live = liveSessionIds(ctx)
  if (live === null) return payload
  for (const item of payload.heartbeats) {
    if (isPlainObject(item) === false || item.liveness === 'dead') continue
    const session = usableSessionId(item.session)
    if (session === '' || live.has(session) === false) continue
    item.liveness = 'live'
    item.reason = 'agent-live'
  }
  return payload
}

/**
 * Final heartbeat visibility on the host side: `heartbeats` stays a row array
 * (old clients keep working), hidden rows are dropped, and the count is exposed
 * as the optional `heartbeatsHidden` field. Pure in-memory filtering — the read
 * path never writes or deletes heartbeat files.
 */
export function applyHeartbeatVisibility(payload) {
  if (isPlainObject(payload) === false || Array.isArray(payload.heartbeats) === false) return payload
  const rows = payload.heartbeats
  const kept = rows.filter((item) => heartbeatRowVisible(item))
  payload.heartbeats = kept
  payload.heartbeatsHidden = rows.length - kept.length
  return payload
}

/** Project root of one live agent, using the same resolution as the tools. */
export function agentRoot(ctx, agent) {
  try {
    return toolRoot(ctx, {}, { agent })
  } catch {
    return undefined
  }
}

/**
 * Whether the session's heartbeat file exists and is still **open**
 * (`working`/`idle`/`waiting`) — the precondition for closing it on `agent/disposed`.
 *
 * Separate from {@link heartbeatWorking} on purpose: that one answers "is the
 * session actively working" (a `working` record + liveness evidence) and is used
 * by the auto-start skip rule; closing must also cover an `idle` session. Every
 * failure answers `false` (do not touch what we cannot prove is open); the
 * caller never throws.
 */
export function heartbeatOpen(root, session) {
  if (typeof root !== 'string' || root.length === 0) return false
  if (hasStore(root) === false) return false
  const c = coreModule()
  if (c === null || typeof c.heartbeatStatus !== 'function') return false
  const id = usableSessionId(session)
  if (id === '') return false
  try {
    const loaded = c.loadContract(root)
    const status = c.heartbeatStatus(root, loaded.contract, id)
    const record = status !== null && typeof status === 'object' ? status.record : null
    if (record === null || typeof record !== 'object') return false
    return record.status === 'working' || record.status === 'idle' || record.status === 'waiting'
  } catch {
    return false
  }
}

/**
 * Whether the session's heartbeat is `working`: `true` / `false`, or `null`
 * when it cannot be decided (no store, no core, unsafe session id, broken
 * record). Hooks treat `null` as "do not interfere".
 *
 * `live` is the host `agents` positive evidence: a live session whose heartbeat
 * is merely stale (>6 h without a refresh) still counts as working — core's
 * `heartbeatStatus(..., {live:true})` applies that override. A record core judges
 * `dead` is never revived.
 */
export function heartbeatWorking(root, session, live) {
  if (typeof root !== 'string' || root.length === 0) return null
  if (hasStore(root) === false) return null
  const c = coreModule()
  if (c === null || typeof c.heartbeatStatus !== 'function') return null
  const id = usableSessionId(session)
  if (id === '') return null
  try {
    const loaded = c.loadContract(root)
    const status = c.heartbeatStatus(root, loaded.contract, id)
    if (status === null || typeof status !== 'object') return null
    const working = status.record?.status === 'working'
    if (working !== true) return false
    if (status.active === true) return true
    if (live === true && status.liveness !== 'dead') {
      const revived = c.heartbeatStatus(root, loaded.contract, id, { live: true })
      return revived !== null && typeof revived === 'object' && revived.active === true
    }
    return false
  } catch {
    return null
  }
}


/**
 * Whether a heartbeat **file** exists for this session: `true` / `false`, or
 * `null` when it cannot be decided (no store, no core, unsafe session id, broken
 * ledger). Different from {@link heartbeatWorking} on purpose: the late-mount
 * backfill must not care about `working`/`stale`/liveness — any existing record
 * (even one already closed) means "this session was registered", so the record
 * must be left completely untouched.
 */
export function heartbeatRecordExists(root, session) {
  if (typeof root !== 'string' || root.length === 0) return null
  if (hasStore(root) === false) return false
  const c = coreModule()
  if (c === null || typeof c.heartbeatStatus !== 'function') return null
  const id = usableSessionId(session)
  if (id === '') return null
  try {
    const loaded = c.loadContract(root)
    const status = c.heartbeatStatus(root, loaded.contract, id)
    if (status === null || typeof status !== 'object') return null
    return status.record !== null && typeof status.record === 'object'
  } catch {
    return null
  }
}

/**
 * Whether one live agent is a *root* (main) session: `true`, `false`, or `null`
 * when it cannot be decided.
 *
 * The host registry is authoritative (see `@deepseek-ai/dsh-agent`): `roots()`
 * returns the live top-level agents — those entered without an owner — and
 * `get(id)` returns any live agent, so a live agent missing from `roots()` is a
 * subagent. Identity is checked first; the id fallback tolerates a tool call
 * receiving a detached agent record. Sessions whose runtime relation is not
 * visible fall back to the durable session header: `origin === 'subagent'` (or
 * `delegationDepth > 0`) marks a delegated child, while a fork stays a root.
 */
export function rootSessionVerdict(ctx, agent) {
  if (agent === null || agent === undefined || typeof agent !== 'object') return null
  let id = ''
  try {
    if (typeof agent.id === 'string') id = agent.id.trim()
  } catch {
    id = ''
  }
  try {
    const agents = service(ctx, 'agents')
    if (agents !== undefined) {
      if (typeof agents.roots === 'function') {
        const roots = agents.roots()
        if (Array.isArray(roots)) {
          if (roots.includes(agent)) return true
          if (id !== '' && roots.some((root) => root !== null && typeof root === 'object' && root.id === id)) return true
        }
      }
      if (id !== '' && typeof agents.get === 'function') {
        const live = agents.get(id)
        // A live agent that is not a root is a subagent; an unknown id proves
        // nothing (test doubles, detached exec records) and falls through.
        if (live !== undefined && live !== null) return false
      }
    }
  } catch {
    // Fall through to the durable header.
  }
  let header
  try {
    header = agent.session !== null && agent.session !== undefined ? agent.session.header : undefined
  } catch {
    header = undefined
  }
  if (isPlainObject(header)) {
    if (header.origin === SUBAGENT_ORIGIN) return false
    if (Number.isInteger(header.delegationDepth) && header.delegationDepth > 0) return false
    return true
  }
  return null
}

/** Human-readable refusal for a heartbeat write attempted from a subagent. */
export const ROOT_SESSION_HEARTBEAT_ONLY =
  'flow_heartbeat update/list/status only serve main sessions: this call runs in a subagent session, which does not keep a heartbeat. Report progress in the child final message; the plugin opens and closes the main session heartbeat automatically.'

/**
 * Human-readable refusal for a decision write attempted from a subagent. The
 * decision ledger is the main session's conversation with the user: a subagent
 * cannot see the answer, so it reports the pending item in its final message and
 * the main session opens or closes the D record.
 */
export const ROOT_SESSION_DECISION_ONLY =
  'flow_decision ask/answer/withdraw/gc only serve main sessions: this call runs in a subagent session, which cannot open or close a decision record. Report the pending decision in the child final message; only the parent (main) session creates and closes a D record.'

/** Resolve the heartbeat ledger root (the project main worktree); degrade to the workspace root. */
export function heartbeatRootOf(root) {
  try {
    const c = coreModule()
    if (c !== null && typeof c.resolveHeartbeatWorkspace === 'function') {
      const resolved = c.resolveHeartbeatWorkspace(root)
      if (isPlainObject(resolved) && typeof resolved.root === 'string' && resolved.root.length > 0) {
        return {
          root: resolved.root,
          degraded: resolved.degraded === true,
          reason: typeof resolved.reason === 'string' ? resolved.reason : '',
        }
      }
    }
  } catch {
    // Fall through to the workspace root.
  }
  return { root, degraded: false, reason: '' }
}

/** The task a session currently works on: its newest active, else newest draft. */
export function currentTaskOf(records, session) {
  const open = records.filter(
    (record) => isPlainObject(record) && (record.status === 'active' || record.status === 'draft'),
  )
  if (open.length === 0) return null
  const owned = open.filter((record) => typeof record.owner === 'string' && record.owner === session)
  const pool = owned.length > 0 ? owned : open
  const active = pool.filter((record) => record.status === 'active')
  const ranked = (active.length > 0 ? active : pool).slice().sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
  return ranked.length > 0 ? ranked[0] : null
}

/**
 * The standing discipline section. It is evaluated per prompt assembly, so it
 * always names the live root, task and heartbeat state — one short paragraph,
 * never an accumulating log.
 */
// ------------------------------------------------------------------- reminder

export function disciplineText(ctx, context) {
  try {
    const agent = context !== null && context !== undefined ? context.agent : undefined
    if (agent === undefined || agent === null || coreAvailable() === false) return ''
    // Delegated child sessions are not asked to keep a heartbeat.
    if (rootSessionVerdict(ctx, agent) === false) return ''
    const root = agentRoot(ctx, agent)
    if (root === undefined || hasStore(root) === false) return ''
    const c = requireCore()
    if (typeof c.listTasks !== 'function' || typeof c.heartbeatStatus !== 'function') return ''
    const loaded = c.loadContract(root)
    const session = usableSessionId(agent.id)
    const listed = c.listTasks(root, loaded.contract)
    const task = currentTaskOf(Array.isArray(listed) ? listed : [], session)
    let status = '未登记'
    if (session !== '') {
      const beat = c.heartbeatStatus(root, loaded.contract, session)
      if (beat !== null && typeof beat === 'object' && beat.record !== null && beat.record !== undefined) {
        status = typeof beat.record.status === 'string' && beat.record.status !== '' ? beat.record.status : '未知'
      }
    }
    const taskText = task === null ? '当前任务: 无' : `当前任务: ${clip(task.id, 40)} ${clip(task.title, 48)}`
    const text =
      `project-flow 纪律 · 根 ${root} · ${taskText} · 本会话心跳: ${status}。` +
      '心跳由插件在会话创建时自动开启（goal/task/claims 取自任务栈顶），结束时自动关闭，会话不需要也不能手动开或关；每轮用 flow_heartbeat update 登记 goal/task/claims（claims 写本会话独占写入的文件域，供其他会话避让）。'
    return clip(text, 380)
  } catch {
    return ''
  }
}

/** Register the standing discipline section when a system-prompt service exists. */
export function registerDisciplineSection(ctx) {
  provide(ctx, 'systemPrompt', 'system prompt', (scoped) => {
    const systemPrompt = service(scoped, 'systemPrompt')
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return () => {}
    let dispose
    try {
      dispose = systemPrompt.section({
        name: 'project-flow:heartbeat-discipline',
        order: 9500,
        text: (context) => disciplineText(scoped, context),
      })
    } catch (error) {
      warnMount(`system prompt: discipline section not registered: ${brief(error)}`, scoped)
      return () => {}
    }
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // A section disposer must never break plugin unload.
      }
    }
  })
}

/**
 * One bounded reminder message per turn: the WHOLE text shares one budget, so
 * the sections cannot each spend 800 and add up to 2400.
 */
const REMINDER_LIMIT = 800
/**
 * The reminder renders the stack TOP only; the count it prints and the slice it
 * takes use this one constant, so "栈顶 1 条" can never disagree with the rows.
 */
const REMINDER_STACK_ROWS = 1
/** A command echo is bounded so a long `/建议 …` cannot eat the whole budget. */
const COMMAND_ECHO_CLIP = 200
const DECISION_QUESTION_CLIP = 60

/** The one sentence every decision-bearing reminder carries: how to answer. */
const ANSWER_DECISION_HINT =
  '回答后当轮调用 flow_decision answer <id> --choice <选项 id>；不要按推荐自行决定。'

/**
 * 无待决策时这一段**必须**出现（用户 2026-11-08 的明确要求）：把「决策必须落
 * 台账」从模型的记忆里搬进每轮提醒。它的读者是模型，所以判据是「读了之后会
 * 不会做对——先 ask 建档、再提问、答后 answer」，不是「人读着舒服」。
 * 它不参与截断：预算先扣掉它，再分配给可牺牲的明细。
 */
const SUBMIT_DECISION_HINT =
  '无待决策。需要用户裁决时：先 flow_decision ask（kind=choice|approval|input，问题里带 [D-xxx] 编号），用户答后再 flow_decision answer <id> --choice <选项>；不要在对话里直接问。'

/** First turn (including fork/resume) tells the model where the full list lives. */
const FIRST_TURN_HINT = '新会话第一步：运行 flow decision list --open 查看完整清单'

/** Rows hidden by the row cap or by budget pressure are counted, never silently dropped. */
export function hiddenDecisionsHint(count) {
  return `另有 ${count} 条决策，运行 flow decision list --open 查看全部`
}

/** Truncate an echo without pretending the tail is not missing. */
export function clipEcho(text, max) {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/** One user-role reminder message; the fields match `MessageBase` + `role`. */
export function reminderMessage(session, turn, step, text) {
  return {
    id: `project-flow:${session}:${turn}:${step}:${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}


/** The store contract of one root, or null when it cannot be loaded. */
export function decisionContractOf(root) {
  try {
    const c = requireCore()
    if (typeof c.loadContract !== 'function') return null
    const loaded = c.loadContract(root)
    return isPlainObject(loaded) ? loaded.contract : null
  } catch {
    return null
  }
}

/**
 * 挂起 display of one open decision: the turns it has waited for the session that
 * asked it, else the age since `asked_at`. Same rule as `decisionSuspended` in
 * bin/flow.mjs — two copies, because the Host and the CLI share no code. Only the
 * 3600 / 86400 thresholds are allowed; a change here must be mirrored there.
 */
export function decisionSuspendedText(item) {
  const turnAge = isPlainObject(item) && Number.isInteger(item.turnAge) ? item.turnAge : null
  if (turnAge !== null) return `${turnAge} 轮`
  const age = isPlainObject(item) ? item.ageSeconds : null
  if (typeof age !== 'number' || Number.isFinite(age) === false) return '-'
  if (age < 3600) return `${Math.max(1, Math.round(age / 60))} 分钟`
  if (age < 86400) return `${Math.round(age / 3600)} 小时`
  return `${Math.round(age / 86400)} 天`
}

/** One reminder row: `- ⚠ D-… [kind] question  阻塞 T-…；挂起 3 轮`. */
export function decisionReminderLine(item) {
  const blocks = Array.isArray(item.blocks)
    ? item.blocks.filter((id) => typeof id === 'string' && id !== '').map((id) => clip(id, 40))
    : []
  const blocked = blocks.length > 0 ? `阻塞 ${blocks.join('、')}；` : ''
  const head =
    `${item.escalated === true ? '⚠ ' : ''}${clip(item.id, 40)} [${clip(item.kind, 20)}] ` +
    clip(item.question, DECISION_QUESTION_CLIP)
  return `- ${head}  ${blocked}挂起 ${decisionSuspendedText(item)}`
}

/**
 * The current-task section (A/D) of the per-turn reminder, or null when the
 * ledger cannot be read — then the whole reminder is skipped, because a
 * fabricated "no unfinished tasks" would be worse than silence.
 *
 * `stageZh` comes from `buildStatusBlock`, whose only Chinese stage table is
 * `lib/capture.mjs` → `lib/stage.mjs`'s STAGE_ZH. The reminder must never keep a
 * second mapping: a renamed stage would silently stop matching.
 */
export function taskReminderSection(root, contract) {
  try {
    if (hasStore(root) === false) return null
    const c = requireCore()
    if (typeof c.listTasks !== 'function') return null
    const block = buildStatusBlock(c, root, contract)
    if (block.unfinished === 0 || block.stack.length === 0) {
      return { lines: ['当前无未完成任务 ｜ 由你分析用户诉求后 flow_task add 建主任务（插件负责派工）'], extra: '' }
    }
    const top = block.stack[0]
    const lines = [
      `当前任务：${top.id} [${top.stageZh}] ${clip(top.title, 48)}`,
      `未完成 ${block.unfinished} 条 ｜ 栈顶 ${REMINDER_STACK_ROWS} 条`,
    ]
    const extra =
      block.unfinished > REMINDER_STACK_ROWS
        ? `（另有 ${block.unfinished - REMINDER_STACK_ROWS} 条待处理）`
        : ''
    return { lines, extra }
  } catch {
    return null
  }
}

/**
 * The decision section (B), or null when nothing is open. Returns ROWS instead
 * of text so the assembler can drop whole rows under budget pressure while
 * always keeping the "how to answer" sentence. Row order is core's and is never
 * re-sorted here. The first turn of a session lists the whole ledger; later
 * turns cap the detail at DECISION_REMIND_MAX rows and count the rest.
 */
export function decisionReminderSection(root, contract, session, turn) {
  try {
    if (hasStore(root) === false) return null
    if (isPlainObject(contract) === false) return null
    const c = requireCore()
    if (typeof c.summarizeDecisions !== 'function') return null
    const firstTurn = Number.isInteger(turn) && turn === 1
    const info = { session, turn: Number.isInteger(turn) ? turn : null }
    if (firstTurn === false) info.limit = decisionRemindMax()
    const summary = c.summarizeDecisions(root, contract, info)
    const items = isPlainObject(summary) && Array.isArray(summary.items) ? summary.items : []
    const counts = isPlainObject(summary) ? summary.counts : null
    const open = isPlainObject(counts) && typeof counts.open === 'number' ? counts.open : 0
    if (open === 0 || items.length === 0) return null
    const blocking = isPlainObject(counts) && typeof counts.blocking === 'number' ? counts.blocking : 0
    const rows = items.filter((item) => isPlainObject(item)).map((item) => decisionReminderLine(item))
    if (rows.length === 0) return null
    return { open, blocking, rows, firstTurn }
  } catch {
    return null
  }
}

/**
 * Drop decisions owned by archived sessions before this turn is reminded.
 *
 * The durable archive set is the Host workspace registry's
 * `archivedSessionIds` (the same set the Host's archived-session gate reads);
 * without that service (CLI/TUI/older hosts, tests) this is a no-op. A decision
 * belongs to the conversation that asked it and must not outlive it; silently
 * dropping the reminder is the failure direction, so any error only warns.
 *
 * @returns the core purge result, or null when nothing could be checked.
 */
export function purgeArchivedSessionDecisions(ctx, root, contract) {
  try {
    if (isPlainObject(contract) === false) return null
    const registry = service(ctx, 'workspaceRegistry')
    const archived =
      registry !== null && registry !== undefined && Array.isArray(registry.archivedSessionIds)
        ? registry.archivedSessionIds
        : null
    if (archived === null || archived.length === 0) return null
    const c = coreModule()
    if (c === null || typeof c.purgeArchivedDecisions !== 'function') return null
    const result = c.purgeArchivedDecisions(root, contract, archived)
    return isPlainObject(result) ? result : null
  } catch (error) {
    warnMount(`decision archive purge failed: ${brief(error)}`, ctx)
    return null
  }
}

/**
 * Assemble the single per-turn reminder (task-82; design agreed with exec-panel
 * on 2026-11-08).
 *
 * Rule — **reserve first, never blind-clip the tail**:
 * 1. the non-sacrificable parts are the command echo, the "how to answer /
 *    how to submit" sentence and the "more decisions" pointer;
 * 2. the rest is spent in priority order: A section (current task) → A's
 *    "还有 N 条" line → B rows one by one;
 * 3. under pressure, whole B rows are dropped from the END and counted in the
 *    pointer, then A's extra line, then the whole A block. The text is never
 *    sliced, because cutting the tail is exactly how the sentence the model
 *    needs disappears while the message still looks complete.
 *
 * Assembly order is fixed: command echo (when any) → A → B. Exactly one
 * `【project-flow】` prefix; when the command echo leads it already carries it.
 */
export function composeTurnReminder(root, contract, session, turn, commandText) {
  const command = typeof commandText === 'string' && commandText !== '' ? clipEcho(commandText, COMMAND_ECHO_CLIP) : ''
  const tasks = taskReminderSection(root, contract)
  const decisions = decisionReminderSection(root, contract, session, turn)
  if (tasks === null && decisions === null) return ''
  const answerHint = decisions === null ? SUBMIT_DECISION_HINT : ANSWER_DECISION_HINT
  const taskLines = tasks === null ? [] : tasks.lines.slice()
  let taskExtra = tasks === null ? '' : tasks.extra
  const rows = decisions === null ? [] : decisions.rows.slice()
  const cappedHidden = decisions === null ? 0 : decisions.open - decisions.rows.length
  let firstTurnHint = decisions !== null && decisions.firstTurn === true ? FIRST_TURN_HINT : ''

  const render = () => {
    const body = []
    body.push(...taskLines)
    if (taskExtra !== '') body.push(taskExtra)
    if (decisions !== null) {
      const hidden = cappedHidden + (decisions.rows.length - rows.length)
      body.push(`待决策 ${decisions.open} 条${decisions.blocking > 0 ? `（阻塞 ${decisions.blocking}）` : ''}：`)
      body.push(...rows)
      body.push(answerHint)
      if (firstTurnHint !== '') body.push(firstTurnHint)
      if (hidden > 0) body.push(hiddenDecisionsHint(hidden))
    } else {
      body.push(answerHint)
    }
    if (body.length === 0) return command
    const head = command === '' ? `【project-flow】${body[0]}` : command
    const rest = command === '' ? body.slice(1) : body
    return [head, ...rest].join('\n')
  }

  let text = render()
  // Optional content is dropped in the documented order; the mandatory tail
  // (answer/submit hint + pointer) is never touched.
  while (text.length > REMINDER_LIMIT) {
    if (rows.length > 0) {
      rows.pop()
    } else if (taskExtra !== '') {
      taskExtra = ''
    } else if (firstTurnHint !== '') {
      firstTurnHint = ''
    } else if (taskLines.length > 0) {
      taskLines.length = 0
    } else {
      break
    }
    text = render()
  }
  return text
}

/**
 * One reminder line for the newest `/command` in this step's messages
 * (D-20261108-02). **Recognize only — never execute, never write the ledger.**
 * An unknown `/foo` is reported once per mount and produces no line.
 */
export function commandReminderLine(ctx, warned, messages) {
  try {
    const list = Array.isArray(messages) ? messages : []
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      const text = textOfContent(message === null || message === undefined ? undefined : message.content)
      if (text.trimStart().startsWith('/') === false) continue
      const parsed = parseCommand(text)
      if (parsed === null) {
        const name = commandNameOf(text)
        if (name !== '' && warned.has(name) === false) {
          warned.add(name)
          warnMount(`commands: unknown command /${name}（识别到但未执行；已知：建议/继续/暂停/开始/决策/状态）`, ctx)
        }
        return ''
      }
      return `【project-flow】收到命令 /${parsed.name}：${parsed.rest === '' ? '（无参数）' : parsed.rest}`
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Per-turn reminder (task-82): on the first step of a turn, append ONE user
 * message whose content is the live current-task status plus the decision
 * section — or, when no decision is open, the "how to submit one" sentence.
 *
 * The heartbeat section is gone on purpose: task-81 moved the heartbeat
 * lifecycle into the plugin (`agent/created` / `agent/disposed`), so a session
 * no longer has to be told to start or keep one. This hook now answers the two
 * questions a session actually has to get right each turn: *what am I working
 * on* and *what is waiting on the user*.
 *
 * `captureState` is the P1 capture queue (null when `config.capture === false`).
 * The pre-step listener owns the in-memory record call because the host may only
 * accept one waterfall listener per plugin in older environments (host2-tools
 * asserts exactly one `agent/pre-step` hook); it stays memory-only.
 */
export function registerTurnReminder(ctx, captureState, settings, hooks) {
  const callHook = sessionHookCaller(hooks)
  try {
    if (typeof ctx.on !== 'function') return
    // Unknown `/commands` warn once per mount (a typo must not spam every step).
    const warnedCommands = new Set()
    ctx.effect(() => {
      const dispose = ctx.on('agent/pre-step', async (payload, next) => {
        // `next()` 抛错**故意不兜底**：waterfall 必须交出合法的 PreStepDecision
        // （封闭联合，无 null），而 next() 已经 reject、拿不到原 decision；兜底只能
        // 返回空 enter，那会静默丢弃 payload.messages（用户本轮输入）——比报错更隐蔽。
        // 方向相反是刻意的：下面 handler 抛错必须 catch 吞掉（最多少一条提醒），
        // 而 next()（宿主链）抛错必须传播。见 CONTRACT §9.2.1。
        const decision = await next()
        try {
          if (decision === null || decision === undefined || decision.kind !== 'enter') return decision
          const step = payload !== null && payload !== undefined ? payload.step : undefined
          if (step !== 0 && step !== 1) return decision
          const agent = payload.agent
          if (agent === undefined || agent === null) return decision
          // Only main sessions are reminded; a subagent gets neither section.
          if (rootSessionVerdict(ctx, agent) !== true) return decision
          // T-20261111155603-02：会话在插件挂载之前创建时 `agent/created` 漏跑，
          // 该会话没有心跳文件 → 写门禁挡住 edit/write，而 `flow_heartbeat update`
          // 对缺失记录仍是 not-found。这里幂等补一次登记（已有记录则完全跳过，
          // 绝不重置 turn/stats/started_at），失败只记 mount warning、不打断本轮。
          captureLateMountStart(ctx, payload)
          const session = usableSessionId(agent.id)
          if (session === '') return decision
          const root = agentRoot(ctx, agent)
          if (root === undefined) return decision
          // P2 §5.2 ①: hide the team tools from a main session's scope. Applied
          // here as well as on `agent/created` so a session that predates the
          // plugin mount (or one created while capture is off) is still covered.
          if (settings !== null && typeof settings === 'object' && settings.enforce === true) {
            callHook('restrict', ctx, agent, settings.restrictedAgents, settings.boardMode, settings.allowMainDispatch === true)
          }
          callHook('rememberCaller', ctx, agent)
          // P1 capture: memory only (filter → diff → queue). The write happens on
          // `agent/turn-stopping`, never on this per-step critical path.
          if (captureState !== null) {
            recordPreStep(
              captureState,
              { root, session, messages: payload.messages },
              (error) => warnMount(`recordPreStep: ${brief(error)}`, ctx),
            )
            // 2026-11-11：捕获不再等到 turn-stopping 才落盘——用户说一句话就该立刻
            // 出现任务卡（被打断的回合、长回合都不会再丢卡），顺带把心跳置 working。
            captureTurnStart(ctx, captureState, { root, session, agent }, settings)
          }
          // A replay after a host restart carries the previous process's pid in
          // the durable heartbeat record; without a refresh the write gate would
          // deny this live session's edits. Only a non-live record is rewritten.
          try {
            heartbeatEvidenceRefresh(ctx, payload)
          } catch {
            // Advisory refresh only: never disturb the step path.
          }
          const turn = Number.isInteger(payload.turn) ? payload.turn : null
          const commandText = commandReminderLine(ctx, warnedCommands, payload.messages)
          const contract = decisionContractOf(root)
          // Session-scoped decisions: records whose asking session is archived
          // leave with it (and clear their veto pointers) before this turn reads.
          purgeArchivedSessionDecisions(ctx, root, contract)
          const text = composeTurnReminder(root, contract, session, turn, commandText)
          if (text === '') return decision
          const messages = Array.isArray(decision.messages) ? decision.messages.slice() : []
          messages.push(reminderMessage(session, payload.turn, step, text))
          return { ...decision, messages }
        } catch {
          return decision
        }
      })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // A listener disposer must never break plugin unload.
        }
      }
    }, 'project-flow: turn reminder')
  } catch (error) {
    warnMount(`turn reminder unavailable: ${brief(error)}`, ctx)
  }
}

/**
 * `agent/turn-stopping` (serial, awaited before the turn boundary commits):
 * refresh `updated_at` on this session's **existing working** heartbeat. Without
 * it a long turn lets `updated_at` age past the 6 h freshness window, so
 * `heartbeatStatus` reports stale/dead and {@link heartbeatGuardReason} wrongly
 * denies `edit`/`write`.
 *
 * One derivable fact only: no heartbeat is created, no semantic field is
 * written, `agent.steer()` is never called (that would keep the turn open) and
 * every failure is swallowed — a serial listener that throws reaches the host.
 * Existence and ownership reuse {@link heartbeatWorking}, the same verdict the
 * write gate uses, so only this session's beat can be refreshed; a lock conflict
 * becomes one mount warning and is never retried.
 */
export function heartbeatKeepalive(ctx, payload) {
  try {
    if (payload === null || typeof payload !== 'object') return
    const signal = payload.signal
    if (signal !== null && signal !== undefined && signal.aborted === true) return
    const agent = payload.agent
    if (agent === undefined || agent === null) return
    // Heartbeats are a main-session discipline; a subagent must never be kept
    // alive (it does not register one, and a legacy record must not be revived).
    if (rootSessionVerdict(ctx, agent) !== true) return
    const session = usableSessionId(agent.id)
    if (session === '') return
    const root = agentRoot(ctx, agent)
    if (root === undefined) return
    // The record is resolved by THIS session id and must already be working:
    // `heartbeatWorking` is the gate's own existence/ownership/liveness verdict,
    // so another session's file is structurally out of reach.
    if (heartbeatWorking(root, session, sessionIsLive(ctx, session)) !== true) return
    const c = coreModule()
    if (c === null || typeof c.updateHeartbeat !== 'function') return
    const loaded = c.loadContract(root)
    if (loaded === null || typeof loaded !== 'object') return
    // Empty patch: core only refreshes `updated_at` (plus its host evidence) and
    // keeps `status`/`goal`/`task`/`claims`/`turn`/`stats` untouched.
    c.updateHeartbeat(root, loaded.contract, session, {})
  } catch (error) {
    // A dropped keepalive is harmless; a throw on the serial path is not.
    warnMount(`heartbeat keepalive skipped: ${brief(error)}`, ctx)
  }
}

/**
 * Register the turn-stopping listener through `ctx.effect` so unload disposes it.
 * A host without the event API is a no-op, never an error.
 *
 * One listener serves both P1 duties on purpose: host2-tools asserts that the
 * plugin registers exactly one `agent/turn-stopping` hook, and the host awaits
 * every listener on this serial event anyway. Keepalive refreshes the heartbeat;
 * capture drains the queue and writes the captured tasks. Either failure is
 * swallowed independently so one duty can never take the other down.
 */
export function registerHeartbeatKeepalive(ctx, captureState, options) {
  try {
    if (typeof ctx.on !== 'function') return
    ctx.effect(() => {
      const dispose = ctx.on('agent/turn-stopping', (payload) => {
        try {
          heartbeatKeepalive(ctx, payload)
        } catch {
          // Defence in depth: heartbeatKeepalive already swallows everything.
        }
        if (captureState !== null) {
          try {
            captureTurnStop(ctx, captureState, payload, options)
          } catch (error) {
            // A serial listener must never throw: a failed flush is one warning.
            warnMount(`capture flush skipped: ${brief(error)}`, ctx)
          }
        }
      })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // A listener disposer must never break plugin unload.
        }
      }
    }, 'project-flow: heartbeat keepalive')
  } catch (error) {
    warnMount(`heartbeat keepalive unavailable: ${brief(error)}`, ctx)
  }
}

/**
 * Resolve `{root, session}` for one capture event: only a live main session with
 * a valid id and a workspace root may capture. Every failure is `null`, never a
 * throw (this runs on hook paths that cannot report an error to anyone).
 */
// -------------------------------------------------------------------- capture

/* 后台任务会话（mnemon 的任务包装、后台 job 等）不是"用户会话"：它们同样能被
   rootSessionVerdict 判成根会话，会给它们开心跳、做捕获，面板上就多出幽灵行。
   前缀表与判定函数只有一份实现（heartbeats 模块）：这里既 import 本地使用，
   也 re-export 给外部调用方（re-export 本身不产生本地绑定）。 */
import { isSyntheticSession } from '../heartbeats/records.mjs'

export { SYNTHETIC_SESSION_PREFIXES } from '../heartbeats/records.mjs'

/** 每次挂载只跑一次心跳 GC：清旧代码留下的 subagent 记录与后台会话幽灵文件。 */
let HEARTBEAT_GC_DONE = false

export function captureTarget(ctx, payload) {
  try {
    if (payload === null || payload === undefined || typeof payload !== 'object') return null
    const signal = payload.signal
    if (signal !== null && signal !== undefined && signal.aborted === true) return null
    const agent = payload.agent
    if (agent === undefined || agent === null) return null
    if (rootSessionVerdict(ctx, agent) !== true) return null
    const session = usableSessionId(agent.id)
    if (session === '') return null
    // 后台任务会话不参与心跳/捕获（否则面板会多出不存在于会话列表的行）。
    if (isSyntheticSession(session) === true) return null
    const root = agentRoot(ctx, agent)
    if (root === undefined) return null
    return { root, session }
  } catch {
    return null
  }
}

/** 消息卡自动收口的默认窗口（小时）；`config.tasks.autoSweepHours` 覆盖。 */
export const DEFAULT_AUTO_SWEEP_HOURS = 24

/**
 * `config.tasks.autoSweepHours` 归一（2026-11-09 任务模块）：
 * - 缺省 24 小时；
 * - `0` / `false` / 负数 = 关闭自动收口（CLI `flow task sweep` 仍可手动跑）；
 * - 非法值回落默认值，不崩。
 */
export function autoSweepHoursOf(config) {
  if (isPlainObject(config) === false) return DEFAULT_AUTO_SWEEP_HOURS
  const tasks = config.tasks
  if (isPlainObject(tasks) === false) return DEFAULT_AUTO_SWEEP_HOURS
  if (tasks.autoSweep === false) return 0
  const hours = tasks.autoSweepHours
  if (hours === undefined || hours === null) return DEFAULT_AUTO_SWEEP_HOURS
  if (typeof hours === 'boolean') return hours === false ? 0 : DEFAULT_AUTO_SWEEP_HOURS
  return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_AUTO_SWEEP_HOURS
}

/** 捕获落盘后顺手收口过期消息卡；任何失败都只记一条 mount warning。 */
function autoSweepUtteranceCards(ctx, c, root, contract, options) {
  try {
    const hours =
      isPlainObject(options) && Number.isFinite(options.autoSweepHours) ? options.autoSweepHours : DEFAULT_AUTO_SWEEP_HOURS
    if (!(hours > 0)) return
    if (typeof c.sweepUtteranceTasks !== 'function') return
    c.sweepUtteranceTasks(root, contract, { olderThanHours: hours })
  } catch (error) {
    warnMount(`消息卡收口失败：${brief(error)}`, ctx)
  }
}

/** `scope.allow` of one task as heartbeat claims (strings only, never a throw). */
export function captureClaims(top) {
  try {
    const scope = isPlainObject(top) ? top.scope : null
    if (isPlainObject(scope) === false || Array.isArray(scope.allow) === false) return []
    return scope.allow.filter((entry) => typeof entry === 'string')
  } catch {
    return []
  }
}

/**
 * Serial `agent/turn-stopping` duty: drain the in-memory queue into the ledger.
 *
 * The write itself lives in `lib/capture.mjs` (one place for key/mapping/stage);
 * this wrapper only resolves the session/root, loads the contract, and refreshes
 * an **existing** heartbeat's goal/task/claims from the new stack top per §6 —
 * capture never creates a heartbeat (that is `agent/created`'s job, and only
 * with a stack top).
 */
/**
 * `agent/pre-step` duty: 把本轮刚捕获的消息**立刻**落盘成任务卡，并把心跳置 working。
 *
 * 为什么不再等 `turn-stopping`：回合被打断（用户连发、工具中断、会话关闭）时
 * 停止事件不会触发，队列里的句子就永远不落盘——这正是"我说了一句话却没生成任务"
 * 的根因。turn-stopping 的 flush 保留为兜底（pending 为空时是零成本 no-op）。
 */
export function captureTurnStart(ctx, state, target, config) {
  try {
    if (state === null || typeof state !== 'object') return
    if (isPlainObject(target) === false) {
      noteCaptureGate(state, 'no-target')
      return
    }
    const c = coreModule()
    if (c === null || typeof c.loadContract !== 'function') {
      noteCaptureGate(state, 'no-core')
      return
    }
    let loaded
    try {
      loaded = c.loadContract(target.root)
    } catch (error) {
      noteCaptureGate(state, 'no-contract', { error: `captureTurnStart: ${brief(error)}` })
      warnMount(`captureTurnStart: ${brief(error)}`, ctx)
      return
    }
    if (isPlainObject(loaded) === false) {
      noteCaptureGate(state, 'no-contract')
      return
    }
    let result
    try {
      result = flushCapture(state, {
        core: c,
        root: target.root,
        contract: loaded.contract,
        session: target.session,
      })
    } catch (error) {
      noteCaptureGate(state, 'flush-failed', { error: `captureTurnStart: ${brief(error)}` })
      warnMount(`captureTurnStart: ${brief(error)}`, ctx)
      return
    }
    if (isPlainObject(result) === false || Array.isArray(result.created) === false) return
    if (result.created.length === 0) {
      noteCaptureGate(state, 'nothing-pending')
      return
    }
    noteCaptureGate(state, 'ok', { created: result.created.length })
    // 捕获即派工（2026-11-11）：一轮消息落成卡后，插件自己起对应角色子代理，
    // 不需要模型再调用 flow_task dispatch。失败只记 warn，绝不阻塞本轮对话。
    autoDispatchCaptured(ctx, c, target, loaded.contract, result.created, config)
    // 新卡落盘后顺手收掉过期未领取的旧卡（与 turn-stopping 同一规则）。
    autoSweepUtteranceCards(ctx, c, target.root, loaded.contract, config)
    if (typeof c.heartbeatStatus !== 'function' || typeof c.updateHeartbeat !== 'function') return
    const status = c.heartbeatStatus(target.root, loaded.contract, target.session)
    if (status === null || typeof status !== 'object' || status.record === null) return
    const top = stackTop(c, target.root, loaded.contract)
    const patch = { status: 'working', last_action: `本轮捕获 ${result.created.length} 条` }
    if (top !== null) {
      patch.goal = typeof top.title === 'string' ? top.title : ''
      patch.task = typeof top.id === 'string' ? top.id : ''
      patch.claims = captureClaims(top)
    }
    c.updateHeartbeat(target.root, loaded.contract, target.session, patch)
  } catch (error) {
    warnMount(`captureTurnStart: ${brief(error)}`, ctx)
  }
}

/**
 * 捕获完成后的自动派工：只对 `queued-analysis` 这类派工入口阶段生效，
 * 由插件直接起角色子代理（`dispatchTaskRecord`），把任务推进到 working。
 * 失败只 warn，不抛给 pre-step。
 */
function autoDispatchCaptured(ctx, c, target, contract, created, config) {
  try {
    if (config === null || config === undefined || config.autoDispatch !== true) return
    if (isPlainObject(target) !== true || target.agent === null || target.agent === undefined) return
    if (hasSubagentService(ctx) !== true) return
    for (const entry of created) {
      if (isPlainObject(entry) !== true || typeof entry.id !== 'string') continue
      let task = null
      try {
        task = typeof c.getTask === 'function' ? c.getTask(target.root, contract, entry.id) : null
      } catch {
        task = null
      }
      if (task === null || typeof task !== 'object') continue
      const provider = dispatchProvider(config)
      void dispatchTaskRecord({
        c,
        ctx,
        agent: target.agent,
        root: target.root,
        contract,
        task,
        provider,
      }).catch((error) => warnMount(`auto dispatch ${entry.id}: ${brief(error)}`, ctx))
    }
  } catch (error) {
    warnMount(`auto dispatch: ${brief(error)}`, ctx)
  }
}

export function captureTurnStop(ctx, state, payload, options) {
  /* Five exits, each one leaves a trace in `capture.skipped` (regression 2):
     "nothing to capture" must never look like "it failed". */
  const target = captureTarget(ctx, payload)
  if (target === null) {
    noteCaptureGate(state, 'no-target')
    return
  }
  const c = coreModule()
  if (c === null || typeof c.loadContract !== 'function') {
    noteCaptureGate(state, 'no-core')
    return
  }
  let loaded
  try {
    loaded = c.loadContract(target.root)
  } catch (error) {
    noteCaptureGate(state, 'no-contract', { error: `captureTurnStop: ${brief(error)}` })
    warnMount(`captureTurnStop: ${brief(error)}`, ctx)
    return
  }
  if (isPlainObject(loaded) === false) {
    noteCaptureGate(state, 'no-contract')
    return
  }
  let result
  try {
    result = flushCapture(state, {
      core: c,
      root: target.root,
      contract: loaded.contract,
      session: target.session,
    })
  } catch (error) {
    // flushCapture already recorded `flush-failed`; the warning names the path.
    warnMount(`captureTurnStop: ${brief(error)}`, ctx)
    return
  }
  if (result.created.length === 0) {
    noteCaptureGate(state, 'nothing-pending')
    return
  }
  noteCaptureGate(state, 'ok', { created: result.created.length })
  /* 消息卡收口：新卡落盘后顺手把「过期且从没被领取」的旧卡收掉。放在心跳刷新之前，
     是因为它有自己的一条 config 开关，且不该被心跳不可用（无 record/无 stack top）
     连带跳过。失败只记一条 mount warning，绝不影响捕获。 */
  autoSweepUtteranceCards(ctx, c, target.root, loaded.contract, options)
  if (typeof c.heartbeatStatus !== 'function' || typeof c.updateHeartbeat !== 'function') return
  const status = c.heartbeatStatus(target.root, loaded.contract, target.session)
  if (isPlainObject(status) === false || isPlainObject(status.record) === false) return
  const top = stackTop(c, target.root, loaded.contract)
  if (top === null) return
  const title = sessionTitleOf(ctx, target.session)
  c.updateHeartbeat(target.root, loaded.contract, target.session, {
    goal: typeof top.title === 'string' ? top.title : '',
    task: typeof top.id === 'string' ? top.id : '',
    claims: captureClaims(top),
    // The title may have landed since `agent/created`; keep it current.
    ...(title !== '' ? { title } : {}),
    // N > 0 only: a zero capture adds no line and would be pure noise.
    last_action: `本轮捕获 ${result.created.length} 条`,
  })
}

/** Honest placeholder goal for a heartbeat opened on an empty task stack. */
const EMPTY_STACK_GOAL = '（台账暂无未完成任务）'

/**
 * Serial `agent/created` duty: open this session's heartbeat. The lifecycle is
 * the plugin's (a session cannot start one), so creation must be **total**: the
 * stack top supplies goal/task/claims when it exists, and an empty stack opens a
 * heartbeat with a placeholder goal and `task: null` — a heartbeat that never
 * opens is a dead end for the session (see the comment inside), not a warning.
 */
export function captureAutoStart(ctx, payload) {
  const target = captureTarget(ctx, payload)
  if (target === null) return
  const c = coreModule()
  if (c === null || typeof c.loadContract !== 'function' || typeof c.startHeartbeat !== 'function') return
  const loaded = c.loadContract(target.root)
  if (isPlainObject(loaded) === false) return
  // `agent/created` can fire more than once for one session (resume/clear); an
  // already-working heartbeat is left alone instead of having its turn bumped.
  if (heartbeatWorking(target.root, target.session, sessionIsLive(ctx, target.session)) === true) return
  startSessionHeartbeat(ctx, c, target, loaded)
}

/**
 * Open one session heartbeat with the **creation** semantics: the stack top
 * supplies goal/task/claims when it exists, and an empty stack opens a heartbeat
 * with an honest placeholder goal and `task: null` — never an invented task.
 *
 * Creation is unconditional. Since the session surface lost `start` (the plugin
 * owns the lifecycle), a skipped auto-start has **no recovery path**: the write
 * gate denies edits, and `update` throws `not-found` on a missing record — the
 * reminder's advice would point at a dead end. That is why both `agent/created`
 * and the late-mount backfill below call this one implementation.
 */
function startSessionHeartbeat(ctx, c, target, loaded) {
  const top = stackTop(c, target.root, loaded.contract)
  const input = { session: target.session, createTask: false }
  if (top !== null) {
    input.goal = typeof top.title === 'string' ? top.title : ''
    input.task = typeof top.id === 'string' ? top.id : ''
    input.claims = captureClaims(top)
  } else {
    input.goal = EMPTY_STACK_GOAL
  }
  // Session identity + live status: the display title is the host's current
  // title snapshot (empty until the first prompt is titled), and the status is
  // derived from the turn/children state so a restored session does not open as
  // `working` while it owns no open turn.
  const title = sessionTitleOf(ctx, target.session)
  if (title !== '') input.title = title
  const status = liveHeartbeatStatus(ctx, target.session)
  if (status !== null) input.status = status
  rememberHeartbeatRoot(target.session, target.root)
  c.startHeartbeat(target.root, loaded.contract, input)
}

/**
 * `agent/pre-step` 幂等补登记：插件挂载**之前**创建的会话漏跑了
 * `agent/created`，于是没有心跳文件——写门禁拒绝 `edit`/`write`，而
 * `flow_heartbeat update` 对缺失记录只能报 `not-found`，唯一出路是人工跑
 * `flow heartbeat start`。每轮第一步补一次登记，把这条死路补上。
 *
 * 与 `captureAutoStart` 同口径：判定走 `captureTarget`（内含
 * `rootSessionVerdict`，并显式排除 `mnemon-task-` / `bg-task-` /
 * `task-subagent-` 后台任务会话与子代理），入参同源（栈顶 goal/task/claims，
 * 空栈用占位 goal 且 `createTask: false`）。
 *
 * 已有记录（**任何**状态，含已关闭）则完全跳过：补登记绝不能重置
 * turn/stats/started_at。失败只记一条 mount warning，绝不打断该轮的 pre-step；
 * 未初始化的工作区与不可用的 session id 静默返回（不写、不 warn）。
 */
export function captureLateMountStart(ctx, payload) {
  try {
    const target = captureTarget(ctx, payload)
    if (target === null) return
    // 没有台账的工作区既没有心跳文件也没有可写目标：静默跳过，别把「没 init」
    // 变成每一轮一条 mount warning（`loadContract` 会抛，那才是噪声来源）。
    if (hasStore(target.root) === false) return
    const c = coreModule()
    if (c === null || typeof c.loadContract !== 'function' || typeof c.startHeartbeat !== 'function') return
    const loaded = c.loadContract(target.root)
    if (isPlainObject(loaded) === false) return
    // 只问"文件是否存在"，不问 working/stale：已有记录一律不碰。
    if (heartbeatRecordExists(target.root, target.session) !== false) return
    startSessionHeartbeat(ctx, c, target, loaded)
  } catch (error) {
    warnMount(`heartbeat late-mount backfill skipped: ${brief(error)}`, ctx)
  }
}

/**
 * `agent/disposed` duty: close this session's heartbeat.
 *
 * Lifecycle belongs to the plugin: only it sees `agent/created` (open) and
 * `agent/disposed` (close). A session that could close its own heartbeat could
 * also close one that is still alive — so the session-facing tool keeps only
 * `update`, while the CLI keeps `start`/`end` as the **human** escape hatch.
 *
 * This runs on a teardown path, so it must never throw and must never warn:
 * a heartbeat that is missing, already `done`, whose root cannot be resolved or
 * whose ledger is locked is **silently skipped**. Turning session disposal into
 * a failure — or into log noise nobody can act on — is worse than a stale
 * record (the 6 h staleness rule still reaps it).
 */
export function captureAutoEnd(ctx, payload) {
  try {
    const target = captureTarget(ctx, payload)
    if (target === null) return
    const c = coreModule()
    if (c === null || typeof c.loadContract !== 'function' || typeof c.endHeartbeat !== 'function') return
    const loaded = c.loadContract(target.root)
    if (isPlainObject(loaded) === false) return
    // Idempotent: only an open heartbeat is closed. `endHeartbeat` throws
    // `not-found` for a missing file, and would rewrite `ended_at` + append the
    // note again for an already-closed one (resume/clear can dispose twice).
    if (heartbeatOpen(target.root, target.session) !== true) return
    c.endHeartbeat(target.root, loaded.contract, {
      session: target.session,
      status: 'done',
      note: '会话结束（插件自动关闭）',
    })
  } catch {
    // See the doc comment: disposal has no recipient for an error.
  }
}

// ---------------------------------------------- heartbeat ↔ session identity
//
// One live main session owns one heartbeat record: its display title is the
// host's session title, its status follows the turn/children state, and
// archiving the session removes the record. Everything below is **observe-only
// and total** — a missing service or a broken record degrades to "no update",
// never to a host error, and never creates a heartbeat (that is
// `agent/created`'s job alone; see `captureAutoStart`).

/** Bound on the in-memory session→root / child→parent maps (oldest evicted). */
const HEARTBEAT_TRACK_LIMIT = 500

/** Project root last resolved for a session (survives a child's disposal). */
const heartbeatRoots = new Map()
/** Child session → delegating parent session, filled at `subagent/start`. */
const subagentParents = new Map()
/** Archived sessions already handled, so one archive set diff removes once. */
let knownArchived = new Set()

/** Remember one session's project root, evicting the oldest entry beyond the bound. */
function rememberHeartbeatRoot(session, root) {
  if (typeof session !== 'string' || session === '') return
  if (typeof root !== 'string' || root === '') return
  heartbeatRoots.delete(session)
  heartbeatRoots.set(session, root)
  while (heartbeatRoots.size > HEARTBEAT_TRACK_LIMIT) {
    const oldest = heartbeatRoots.keys().next()
    if (oldest.done === true) break
    heartbeatRoots.delete(oldest.value)
  }
}

/** Remember one child's parent run, bounded like {@link heartbeatRoots}. */
function rememberSubagentParent(child, parent) {
  if (typeof child !== 'string' || child === '') return
  if (typeof parent !== 'string' || parent === '') return
  subagentParents.delete(child)
  subagentParents.set(child, parent)
  while (subagentParents.size > HEARTBEAT_TRACK_LIMIT) {
    const oldest = subagentParents.keys().next()
    if (oldest.done === true) break
    subagentParents.delete(oldest.value)
  }
}

/** Live `Session` object for one id (`ctx.sessions.get`), or undefined. */
function liveSessionOf(ctx, id) {
  try {
    const sessions = service(ctx, 'sessions')
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined
    const session = sessions.get(id)
    return session === null ? undefined : session
  } catch {
    return undefined
  }
}

/** Latest host session title for one session id ('' when unavailable). */
export function sessionTitleOf(ctx, sessionId) {
  try {
    const session = liveSessionOf(ctx, sessionId)
    if (session === undefined) return ''
    const titles = service(ctx, 'sessionTitle')
    if (titles === undefined || titles === null || typeof titles.get !== 'function') return ''
    const snapshot = titles.get(session)
    if (isPlainObject(snapshot) === false) return ''
    return typeof snapshot.title === 'string' ? snapshot.title.trim() : ''
  } catch {
    return ''
  }
}

/** Whether the session's turn is currently open (source: `agents.turnBoundaryOf`). */
function turnOpenOf(ctx, sessionId) {
  try {
    const session = liveSessionOf(ctx, sessionId)
    if (session === undefined) return false
    const agents = service(ctx, 'agents')
    if (agents === undefined || agents === null || typeof agents.turnBoundaryOf !== 'function') return false
    const boundary = agents.turnBoundaryOf(session)
    if (isPlainObject(boundary) === false) return false
    return boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined
  } catch {
    return false
  }
}

/** Live subagent child sessions whose durable header names `parentId`. */
function liveChildSessions(ctx, parentId) {
  const children = []
  try {
    const sessions = service(ctx, 'sessions')
    if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return children
    const agents = service(ctx, 'agents')
    for (const session of sessions.list()) {
      if (session === null || session === undefined) continue
      const header = session.header
      if (isPlainObject(header) === false) continue
      if (header.origin !== SUBAGENT_ORIGIN) continue
      if (header.parentSession !== parentId) continue
      const id = typeof session.id === 'string' ? session.id : ''
      if (id === '') continue
      // A child session stays in the store while its agent runs; a header-only
      // leftover (agent already gone) must not hold the parent in `waiting`.
      if (agents !== undefined && agents !== null && typeof agents.get === 'function' && agents.get(id) === undefined) continue
      children.push(id)
    }
  } catch {
    return []
  }
  return children
}

/**
 * The status a live main session should carry right now: `working` while its
 * turn is open, `waiting` while it owns running subagent children with the turn
 * closed, `idle` otherwise. `null` when the session is not live or the host has
 * no session store — callers then leave the record untouched.
 */
export function liveHeartbeatStatus(ctx, sessionId) {
  if (liveSessionOf(ctx, sessionId) === undefined) return null
  if (turnOpenOf(ctx, sessionId)) return 'working'
  return liveChildSessions(ctx, sessionId).length > 0 ? 'waiting' : 'idle'
}

/** Project root for one session: remembered first, then resolved from its live agent. */
function heartbeatRootFor(ctx, sessionId) {
  const known = heartbeatRoots.get(sessionId)
  if (typeof known === 'string' && known !== '') return known
  const agents = service(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
  const agent = agents.get(sessionId)
  if (agent === undefined || agent === null) return undefined
  const root = agentRoot(ctx, agent)
  if (typeof root !== 'string' || root === '') return undefined
  rememberHeartbeatRoot(sessionId, root)
  return root
}

/** Update one existing heartbeat; a missing record or unavailable core is a no-op. */
function patchHeartbeat(ctx, sessionId, patch) {
  try {
    if (isPlainObject(patch) === false || Object.keys(patch).length === 0) return
    const root = heartbeatRootFor(ctx, sessionId)
    if (root === undefined || hasStore(root) === false) return
    const c = coreModule()
    if (c === null || typeof c.updateHeartbeat !== 'function') return
    const loaded = c.loadContract(root)
    if (isPlainObject(loaded) === false) return
    c.updateHeartbeat(root, loaded.contract, sessionId, patch)
  } catch {
    // Observe-only: a refresh must never disturb the host path that emitted it.
  }
}

/** Refresh one session's status (and title when available) from live evidence. */
function refreshHeartbeat(ctx, sessionId) {
  const status = liveHeartbeatStatus(ctx, sessionId)
  if (status === null) return
  const title = sessionTitleOf(ctx, sessionId)
  patchHeartbeat(ctx, sessionId, title === '' ? { status } : { status, title })
}

/** Remove one session's heartbeat everywhere it can live (archive path). */
function removeHeartbeatEverywhere(ctx, sessionId) {
  const roots = new Set()
  const known = heartbeatRoots.get(sessionId)
  if (typeof known === 'string' && known !== '') roots.add(known)
  const agents = service(ctx, 'agents')
  if (agents !== undefined && agents !== null && typeof agents.get === 'function') {
    const agent = agents.get(sessionId)
    if (agent !== undefined && agent !== null) {
      const root = agentRoot(ctx, agent)
      if (typeof root === 'string' && root !== '') roots.add(root)
    }
  }
  // A session whose agent is already gone: the archive event names no root, so
  // fall back to scanning the known workspaces (removal is idempotent).
  if (roots.size === 0) {
    for (const workspace of listWorkspaces(ctx)) {
      if (typeof workspace.path === 'string' && workspace.path !== '') roots.add(workspace.path)
    }
  }
  for (const root of roots) {
    try {
      if (hasStore(root) === false) continue
      const c = coreModule()
      if (c === null || typeof c.removeHeartbeat !== 'function') continue
      const loaded = c.loadContract(root)
      if (isPlainObject(loaded) === false) continue
      c.removeHeartbeat(root, loaded.contract, sessionId)
    } catch {
      // Never throw from an archive notification; the 6 h rule still reaps it.
    }
  }
  heartbeatRoots.delete(sessionId)
}

/**
 * Refresh one existing heartbeat's writer evidence (host/boot_id/pid) without
 * touching any semantic field. A host restart leaves durable records carrying
 * the old process's pid; the write gate would then deny `edit`/`write` for a
 * live session whose record merely replayed. Runs on `agent/pre-step` and only
 * writes when the current evidence is not already `live`.
 */
export function heartbeatEvidenceRefresh(ctx, payload) {
  try {
    if (payload === null || payload === undefined) return
    const agent = payload.agent
    if (agent === undefined || agent === null) return
    if (rootSessionVerdict(ctx, agent) !== true) return
    const session = usableSessionId(agent.id)
    if (session === '') return
    const root = agentRoot(ctx, agent)
    if (typeof root !== 'string' || root === '') return
    rememberHeartbeatRoot(session, root)
    if (hasStore(root) === false) return
    const c = coreModule()
    if (c === null || typeof c.heartbeatStatus !== 'function' || typeof c.updateHeartbeat !== 'function') return
    const loaded = c.loadContract(root)
    if (isPlainObject(loaded) === false) return
    // Only a stale-evidence record is rewritten; a live one needs no write.
    const status = c.heartbeatStatus(root, loaded.contract, session)
    if (isPlainObject(status) === false) return
    if (isPlainObject(status.record) === false && status.record !== null) return
    if (status.record === null || status.record === undefined) return
    if (status.liveness === 'live') return
    c.updateHeartbeat(root, loaded.contract, session, {})
  } catch {
    // Advisory refresh only; never disturb the step path.
  }
}

/**
 * Register the session-identity listeners: agent status, subagent runs, title
 * events and the workspace archive set. All five are independent observe-only
 * registrations under one effect (a failing registration only warns).
 */
/**
 * 挂载后跑一次心跳 GC（每进程一次）：删自己声明结束/判死的旧记录，以及后台任务会话
 * 的心跳文件。失败只记 warning——清理不是关键路径，绝不能拖垮挂载。
 */
function gcHeartbeatJunkOnce(ctx) {
  if (HEARTBEAT_GC_DONE) return
  HEARTBEAT_GC_DONE = true
  try {
    const c = coreModule()
    if (c === null || typeof c.gcLegacyHeartbeats !== 'function') return
    const root = ctxRootForGc(ctx)
    if (root === undefined) return
    const loaded = c.loadContract(root)
    if (isPlainObject(loaded) === false) return
    const result = c.gcLegacyHeartbeats(root, loaded.contract, { olderThanHours: 24 })
    if (isPlainObject(result) && Array.isArray(result.removed) && result.removed.length > 0) {
      ctx?.logger?.info?.(`project-flow: heartbeat gc removed ${result.removed.length} record(s)`)
    }
  } catch (error) {
    warnMount(`heartbeat gc skipped: ${brief(error)}`, ctx)
  }
}

/** GC 的根：优先工作区服务，其次当前进程 cwd；拿不到就不清理。 */
function ctxRootForGc(ctx) {
  try {
    const ws = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    const root = ws !== null && ws !== undefined && typeof ws.get === 'function' ? ws.get() : undefined
    if (typeof root === 'string' && root.trim() !== '') return root
  } catch {
    // fall through
  }
  return undefined
}

export function registerHeartbeatSessionHooks(ctx) {
  try {
    if (typeof ctx.on !== 'function') return
    ctx.effect(() => {
      gcHeartbeatJunkOnce(ctx)
      const disposers = []
      const register = (event, label, handler) => {
        try {
          const dispose = ctx.on(event, (...args) => {
            try {
              handler(...args)
            } catch {
              // Contained per event: an observer must never break the host.
            }
          })
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (error) {
          warnMount(`${label}: registration failed: ${brief(error)}`, ctx)
        }
      }

      // The main session entered or left a turn: running ⇄ idle (or waiting).
      register('agent/status', 'heartbeat status', (payload) => {
        if (isPlainObject(payload) === false) return
        const agent = payload.agent
        if (agent === undefined || agent === null) return
        if (rootSessionVerdict(ctx, agent) !== true) return
        const session = usableSessionId(agent.id)
        if (session === '') return
        const root = agentRoot(ctx, agent)
        if (typeof root === 'string' && root !== '') rememberHeartbeatRoot(session, root)
        refreshHeartbeat(ctx, session)
      })

      // A child run started: the parent may now be waiting on it.
      register('subagent/start', 'heartbeat subagent start', (info) => {
        if (isPlainObject(info) === false || info.local !== true) return
        const child = usableSessionId(info.id)
        if (child === '') return
        const childSession = liveSessionOf(ctx, child)
        const header = childSession !== undefined ? childSession.header : undefined
        if (isPlainObject(header) === false) return
        const parent = usableSessionId(header.parentSession)
        if (parent === '') return
        rememberSubagentParent(child, parent)
        refreshHeartbeat(ctx, parent)
      })

      // A child run settled: recompute the parent from what is still running.
      register('subagent/end', 'heartbeat subagent end', (info) => {
        if (isPlainObject(info) === false) return
        const child = usableSessionId(info.id)
        if (child === '') return
        const parent = subagentParents.get(child)
        subagentParents.delete(child)
        if (typeof parent !== 'string' || parent === '') return
        refreshHeartbeat(ctx, parent)
      })

      // The host titled the session (usually after its first prompt).
      register('session/event', 'heartbeat title', (session, event) => {
        if (isPlainObject(event) === false || event.type !== 'session/title') return
        const id = session !== null && session !== undefined && typeof session.id === 'string' ? usableSessionId(session.id) : ''
        if (id === '') return
        const data = isPlainObject(event.data) ? event.data : null
        const title = data !== null && typeof data.title === 'string' ? data.title.trim() : ''
        if (title === '') return
        // Only a session that already owns a heartbeat is patched; subagent
        // titles have no record and stay silent.
        if (heartbeatRootFor(ctx, id) === undefined) return
        patchHeartbeat(ctx, id, { title })
      })

      // Archiving writes the registry-global archive set; every newly archived
      // session loses its heartbeat record (one-to-one with live sessions only).
      register('domain/changed', 'heartbeat archive', (change) => {
        if (isPlainObject(change) === false) return
        if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
        const state = isPlainObject(change.value) ? change.value : null
        if (state === null || Array.isArray(state.archivedSessionIds) === false) return
        const archived = new Set()
        for (const entry of state.archivedSessionIds) {
          const session = usableSessionId(entry)
          if (session !== '') archived.add(session)
        }
        for (const session of archived) {
          if (knownArchived.has(session)) continue
          removeHeartbeatEverywhere(ctx, session)
        }
        knownArchived = archived
      })

      // Archive-with-stop names the session directly; the archive is already
      // durable when this dispatches, so removal is simply idempotent.
      register('workspace/session-stop', 'heartbeat archive stop', (request) => {
        if (isPlainObject(request) === false) return
        const session = usableSessionId(request.sessionId)
        if (session === '') return
        removeHeartbeatEverywhere(ctx, session)
      })

      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            // A listener disposer must never break plugin unload.
          }
        }
      }
    }, 'project-flow: heartbeat session hooks')
  } catch (error) {
    warnMount(`heartbeat session hooks: registration failed: ${brief(error)}`, ctx)
  }
}

/**
 * Register the `agent/created` hooks through `ctx.effect` (no-op without the
 * event API).
 *
 * The hook stays registered even with `capture:false`: heartbeat creation is the
 * plugin's lifecycle duty and must not depend on the capture flag (the close
 * hook is unconditional for the same reason). The capture/enforce duties inside
 * it keep the old gate — with `capture:false` they do not run, and §5.2 ① still
 * falls back to the pre-step hook.
 */
/**
 * Release tasks held by sessions that are provably gone
 * (D-20261108-05 = extend-owner). Runs on `agent/created` — starting a session is
 * the natural sweep point — and never throws: a failed sweep leaks an owner, it
 * must not fail session creation. The host registry is passed as positive
 * evidence; core still refuses to touch foreign-host or live-pid owners.
 */
function releaseDeadOwners(ctx, payload) {
  try {
    const target = captureTarget(ctx, payload)
    if (target === null) return
    const c = coreModule()
    if (c === null || typeof c.loadContract !== 'function' || typeof c.releaseDeadSessionTasks !== 'function') return
    const loaded = c.loadContract(target.root)
    if (isPlainObject(loaded) === false) return
    const live = liveSessionIds(ctx)
    const options = live === null ? {} : { isSessionLive: (session) => live.has(session) }
    const result = c.releaseDeadSessionTasks(target.root, loaded.contract, options)
    if (result !== null && result !== undefined && Array.isArray(result.released) && result.released.length > 0) {
      warnMount(`released ${result.released.length} task(s) from ended sessions`, ctx)
    }
  } catch (error) {
    warnMount(`owner sweep skipped: ${brief(error)}`, ctx)
  }
}

/** Roots already warned about a stale ledger snapshot (one nag per project per mount). */
const BACKUP_WARNED = new Set()

/** Whether the mount-time stale-snapshot reminder is on (`config.backupReminder`). Off by default. */
export function backupReminderEnabled(config) {
  if (config !== null && typeof config === 'object' && config.backupReminder === true) return true
  const env =
    typeof process.env.PROJECT_FLOW_BACKUP_REMINDER === 'string'
      ? process.env.PROJECT_FLOW_BACKUP_REMINDER.trim().toLowerCase()
      : ''
  return env === '1' || env === 'on' || env === 'true' || env === 'yes'
}

/**
 * Warn once per project when the newest `.agents` snapshot is stale.
 *
 * `.agents` is git-ignored, so a checkout/reset can delete it (2026-11-09); the
 * only recovery source is a snapshot. Off by default (`config.backupReminder`):
 * a normal session creation must not warn (lifecycle tests and discipline rely
 * on it), while `.agents`-heavy projects can opt into the nudge. `flow doctor`
 * is the always-available surface either way.
 */
function warnStaleBackup(ctx, payload, settings) {
  try {
    const agent = payload === null || payload === undefined ? undefined : payload.agent
    if (agent === undefined || agent === null) return
    const root = agentRoot(ctx, agent)
    if (root === undefined || root === '') return
    if (BACKUP_WARNED.has(root)) return
    if (settings !== null && typeof settings === 'object' && settings.backupReminder !== true) return
    const message = backupHealthWarning(root)
    if (message === undefined || message === '') return
    BACKUP_WARNED.add(root)
    warnMount(message, ctx)
  } catch {
    // a reminder must never break session creation
  }
}

export function registerAgentCreated(ctx, captureState, settings, hooks) {
  const callHook = sessionHookCaller(hooks)
  const enforce = settings !== null && typeof settings === 'object' && settings.enforce === true
  try {
    if (typeof ctx.on !== 'function') return
    ctx.effect(() => {
      const dispose = ctx.on('agent/created', (payload) => {
        // One hook for three duties: each has its own try/catch, and
        // `agent/created` is serial (a throw would fail session creation).
        try {
          captureAutoStart(ctx, payload)
        } catch (error) {
          warnMount(`heartbeat auto-start skipped: ${brief(error)}`, ctx)
        }
        warnStaleBackup(ctx, payload, settings)
        releaseDeadOwners(ctx, payload)
        // 2026-11-11：捕获默认关，但 P2 权限面（restrict）与 rememberCaller 是
        // 守卫职责、与"要不要捕获"无关——不能因为 capture 关了就把团队工具放开。
        if (enforce) {
          try {
            callHook('restrict', ctx, payload === null || payload === undefined ? undefined : payload.agent, settings.restrictedAgents, settings.boardMode, settings.allowMainDispatch === true)
          } catch (error) {
            warnMount(`enforce: restrict skipped: ${brief(error)}`, ctx)
          }
        }
        callHook('rememberCaller', ctx, payload === null || payload === undefined ? undefined : payload.agent)
      })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // A listener disposer must never break plugin unload.
        }
      }
    }, 'project-flow: agent created hooks')
  } catch (error) {
    warnMount(`capture/enforce: registration failed: ${brief(error)}`, ctx)
  }
}

/**
 * Register the `agent/disposed` auto-close through `ctx.effect`.
 *
 * Registered **independently of `capture`**: the flag governs utterance capture,
 * not ledger hygiene. Gating the close on it would re-open the ghost defect in
 * the rollback shape (a heartbeat opened before the flag flipped would never be
 * closed). Subagents are excluded by `captureTarget` — they never get a heartbeat.
 */
export function registerAgentDisposed(ctx) {
  try {
    if (typeof ctx.on !== 'function') return
    ctx.effect(() => {
      const dispose = ctx.on('agent/disposed', (payload) => {
        // Teardown path: the handler is total (captureAutoEnd never throws), and
        // even a defect in it must not reach the host's disposal sequence.
        try {
          captureAutoEnd(ctx, payload)
        } catch {
          // contained by design
        }
      })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // A listener disposer must never break plugin unload.
        }
      }
    }, 'project-flow: agent disposed hook')
  } catch (error) {
    // A missing hook is the ghost-heartbeat leak: say so once at mount time.
    warnMount(`capture heartbeat auto-end: registration failed: ${brief(error)}`, ctx)
  }
}

/**
 * Session hooks injected by the plugin entry (`apply`): the session surface must
 * not import the permission/team modules (that would close an import cycle), so
 * `restrict` (P2 tool restriction) and `rememberCaller` (Team board caller cache)
 * arrive as plain functions. A missing hook degrades to a no-op — the session
 * surface still works in hosts without the enforce/team halves.
 */
// -------------------------------------------------------- session switches

function sessionHookCaller(hooks) {
  const source = hooks !== null && typeof hooks === 'object' ? hooks : {}
  return (name, ...args) => {
    const fn = source[name]
    if (typeof fn !== 'function') return undefined
    try {
      return fn(...args)
    } catch {
      // A hook failure must never break the turn.
      return undefined
    }
  }
}

export function captureEnabled(settings) {
  return isPlainObject(settings) === false || settings.capture !== false
}

/** Default-on hard gate; disable with `config.heartbeatGate: false` or `PROJECT_FLOW_HEARTBEAT_GATE=off`. */
export function heartbeatGateEnabled(config) {
  if (config !== null && typeof config === 'object') {
    if (config.heartbeatGate === false || config.enforceHeartbeat === false) return false
    if (config.heartbeatGate === true || config.enforceHeartbeat === true) return true
  }
  const env =
    typeof process.env.PROJECT_FLOW_HEARTBEAT_GATE === 'string'
      ? process.env.PROJECT_FLOW_HEARTBEAT_GATE.trim().toLowerCase()
      : ''
  if (env === '0' || env === 'off' || env === 'false' || env === 'no') return false
  return true
}

/**
 * Deny `edit` / `write` and the structured `ops_*` write tools for a session
 * without a `working` heartbeat; everything else passes.
 *
 * `bash` / `terminal_send` are deliberately not in the gate set: their command
 * text can name arbitrary paths, so no target can be extracted reliably. See
 * the gate-set comment in lib/host/shared.mjs.
 *
 * The refusal is split by evidence, because the two situations have different
 * recovery paths: **no record at all** (a session created before the plugin was
 * mounted) can only be opened by the plugin's `agent/pre-step` backfill or the
 * human escape hatch `flow heartbeat start`, while **a record that is not
 * working** (idle / waiting / done / judged dead) is reachable by
 * `flow_heartbeat update`. Pointing the first case at `update` was the dead end
 * this split removes.
 */
export function heartbeatGuardReason(ctx, execution) {
  try {
    if (execution === null || execution === undefined) return undefined
    if (HEARTBEAT_GATE_TOOLS.has(execution.name) === false) return undefined
    const agent = execution.agent
    if (agent === undefined || agent === null) return undefined
    // The hard gate exists for the main-session discipline only.
    if (rootSessionVerdict(ctx, agent) !== true) return undefined
    const session = usableSessionId(agent.id)
    if (session === '') return undefined
    const root = agentRoot(ctx, agent)
    if (root === undefined) return undefined
    if (heartbeatWorking(root, session, sessionIsLive(ctx, session)) !== false) return undefined
    // T-20261111155603-02：文案必须分场景，否则「完全没有记录」会被指向死路——
    // 没有记录时 `flow_heartbeat update` 只能报 not-found。这里给出两条**真实**
    // 可执行的恢复路径（下一轮 pre-step 自动补登记；仍失败用 CLI start 逃生口）。
    if (heartbeatRecordExists(root, session) === false) {
      return (
        `心跳未登记：本会话没有心跳文件（插件只在会话创建时自动开启，创建早于插件挂载的会话会漏掉）。` +
        `下一步 agent/pre-step 会自动补登记；若仍被拦，跑 flow heartbeat start --session ${session}`
      )
    }
    // 有记录但不是 working（idle / waiting / done / 已判死）：记录在，update 是活路。
    return '心跳未登记：本会话心跳不是 working（idle/waiting/done 都算未登记）。先 flow_heartbeat update 重新登记本轮目标与独占文件域'
  } catch {
    return undefined
  }
}

/**
 * Targets of one gated tool call, each as `{ field, value }`.
 *
 * - built-in `edit` / `write`: `file_path` (with `path` / `filePath` fallbacks)
 * - ops_write_file / ops_edit_file / ops_replace / ops_remove: `path`
 * - ops_move / ops_copy: BOTH the source (`path`) and the destination (`to`);
 *   either target leaves the domain, the call is refused.
 *
 * The read-only ops tools (ops_read_files, ops_grep, ops_glob, ops_stat,
 * ops_diff, ops_inspect_local_file) are not gated and therefore never reach
 * this helper.
 */
function claimTargetsOf(name, args) {
  const input = isPlainObject(args) ? args : {}
  const fields = name === 'ops_move' || name === 'ops_copy' ? ['path', 'to'] : ['file_path', 'path', 'filePath']
  const targets = []
  for (const field of fields) {
    const value = typeof input[field] === 'string' ? input[field].trim() : ''
    // First present field only: the built-in tools accept one path spelling and
    // duplicates would just repeat the same check.
    if (value !== '') targets.push({ field, value })
    if (targets.length === 1 && (name === 'edit' || name === 'write')) break
  }
  return targets
}

/** One claim covers itself and everything below it (a trailing `/` is optional). */
function claimMatches(target, claims) {
  const path = toPosix(target)
  for (const raw of claims) {
    if (typeof raw !== 'string') continue
    let claim = toPosix(raw.trim())
    if (claim === '') continue
    if (claim.startsWith('./')) claim = claim.slice(2)
    if (claim === '.') return true
    if (claim.endsWith('/')) {
      if (path === claim.slice(0, -1) || path.startsWith(claim)) return true
      continue
    }
    if (path === claim || path.startsWith(`${claim}/`)) return true
  }
  return false
}

/** The session's claim list from its heartbeat record, or `null` when it has none. */
function heartbeatClaimsOf(root, session) {
  try {
    const c = coreModule()
    if (c === null || typeof c.readHeartbeatSection !== 'function' || typeof c.loadContract !== 'function') return null
    const loaded = c.loadContract(root)
    const section = c.readHeartbeatSection(root, loaded.contract)
    const records = isPlainObject(section) && Array.isArray(section.items) ? section.items : []
    const record = records.find((item) => isPlainObject(item) && item.session === session)
    if (record === undefined) return null
    const claims = Array.isArray(record.claims) ? record.claims.filter((item) => typeof item === 'string' && item.trim() !== '') : []
    return { claims, items: records }
  } catch {
    return null
  }
}

/**
 * 跨会话文件域冲突（2026-11-11）：另一个**活着的**主会话心跳是否已经占住了 rel。
 *
 * claims 门禁原来只验"我改的文件在我自己的域里"，两个人各自 claim 同一个文件时
 * 两边都放行——这就是并行冲突的入口。这里补上反向检查：命中别人的域就拒绝并点名
 * 是哪个会话，让调用方去协商/收窄，而不是等提交时才发现。
 */
export function foreignClaimOwner(items, session, rel) {
  try {
    if (Array.isArray(items) === false) return null
    for (const item of items) {
      if (isPlainObject(item) === false) continue
      const other = typeof item.session === 'string' ? item.session : ''
      if (other === '' || other === session) continue
      // 只认"还活着"的心跳：dead/stale/legacy 的会话不该继续占着文件域。
      if (item.legacy === true) continue
      const status = typeof item.status === 'string' ? item.status : ''
      if (status !== 'working' && status !== 'idle' && status !== 'waiting') continue
      if (item.stale === true) continue
      const claims = Array.isArray(item.claims) ? item.claims : []
      // 双向包含：ops_replace / ops_remove 的目标可能是目录根，别人 claim 的
      // 文件落在该目录里时同样会被这批操作改写；只查"目标在对方域内"会漏掉。
      const overlaps = (claim) =>
        typeof claim === 'string' && (claimMatches(rel, [claim]) || claimMatches(claim, [rel]))
      if (claims.some(overlaps)) {
        return { session: other, claims: claims.filter((claim) => typeof claim === 'string') }
      }
    }
    return null
  } catch {
    return null
  }
}

/** Whether the claims write gate is on (`config.claims !== false`, env off switch). */
export function claimsGateEnabled(config) {
  if (config !== null && typeof config === 'object') {
    if (config.claims === false || config.enforceClaims === false) return false
    if (config.claims === true || config.enforceClaims === true) return true
  }
  const env =
    typeof process.env.PROJECT_FLOW_CLAIMS_GATE === 'string'
      ? process.env.PROJECT_FLOW_CLAIMS_GATE.trim().toLowerCase()
      : ''
  if (env === '0' || env === 'off' || env === 'false' || env === 'no') return false
  return true
}

/**
 * Default-on: `edit` / `write` and the structured `ops_*` write tools may only
 * touch the session's own heartbeat claims (the write domain published by
 * `flow_heartbeat update --claim`). A session without a heartbeat or with an
 * empty claim list may not write anything — the claim list IS the
 * authorization, so "no domain registered" is a refusal, not
 * a pass. Subagents are exempt (they never open a heartbeat; the parent session
 * owns the domain). Disable with `config.claims: false` or
 * `PROJECT_FLOW_CLAIMS_GATE=off`.
 *
 * Every target of a multi-path tool (ops_move / ops_copy) is checked: one
 * out-of-domain source or destination is enough to refuse the call.
 */
export function claimsGuardReason(ctx, execution) {
  try {
    if (execution === null || execution === undefined) return undefined
    if (HEARTBEAT_GATE_TOOLS.has(execution.name) === false) return undefined
    const agent = execution.agent
    if (agent === undefined || agent === null) return undefined
    // Subagents carry no heartbeat; the parent session owns the write domain.
    if (rootSessionVerdict(ctx, agent) !== true) return undefined
    const session = usableSessionId(agent.id)
    if (session === '') return undefined
    const root = agentRoot(ctx, agent)
    if (root === undefined) return undefined
    const targets = claimTargetsOf(execution.name, execution.arguments)
    if (targets.length === 0) return undefined
    const resolved = []
    for (const target of targets) {
      const absolute = resolve(root, target.value)
      const rel = toPosix(relative(root, absolute))
      if (rel === '' || rel.startsWith('..')) {
        const label = target.field === 'to' ? `目标路径 ${target.value}` : target.value
        return `项目流：${label} 不在项目根内，本会话的文件域无法覆盖。`
      }
      resolved.push(rel)
    }
    const record = heartbeatClaimsOf(root, session)
    if (record === null) {
      return '心跳未登记：先 flow_heartbeat update --claim <路径> 登记本轮独占文件域（插件只在会话创建时自动开启）'
    }
    const claims = record.claims
    if (claims.length === 0) {
      const rel = resolved[0]
      return `本会话心跳没有登记文件域；改 ${rel} 前先 flow_heartbeat update --claim ${rel}（或登记所属目录）。`
    }
    for (const rel of resolved) {
      if (claimMatches(rel, claims) === false) {
        return `本会话的文件域是 ${claims.join('、')}；${rel} 不在其中。先 flow_heartbeat update --claim ${rel}，或去掉越界的 claim 再改。`
      }
      // 本会话有域还不够：另一个活着的会话可能正占着同一个文件（并行冲突入口）。
      const foreign = foreignClaimOwner(record.items, session, rel)
      if (foreign !== null) {
        return `项目流：${rel} 已被会话 ${foreign.session} 登记为它的文件域（${foreign.claims.join('、')}）；并行改写会冲突，先让对方释放或改用别的文件。`
      }
    }
    return undefined
  } catch {
    return undefined
  }
}
