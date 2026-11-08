// project-flow — Host model-facing tools: the status/heartbeat/decision tool
// definitions and their registration (the same mount plumbing the module
// sub-plugins use). Split out of index.js so the tool surface has its own write
// region (docs/module-boundaries.md).

import { fork } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
export const inject = ['webServer']

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
import {
  agentRoot,
  applyAgentLiveness,
  applyHeartbeatVisibility,
  captureEnabled,
  claimsGuardReason,
  heartbeatGateEnabled,
  heartbeatGuardReason,
  heartbeatRootOf,
  registerAgentCreated,
  registerAgentDisposed,
  registerDisciplineSection,
  registerHeartbeatKeepalive,
  registerTurnReminder,
  requireSession,
  rootSessionVerdict,
  sessionIdOf,
  usableSessionId,
  ROOT_SESSION_DECISION_ONLY,
  ROOT_SESSION_HEARTBEAT_ONLY,
} from './session.mjs'
import { handleGate, handleInit } from './routes.mjs'
import { rememberTeamCaller, teamStatusFor } from './team.mjs'
import {
  DISPATCH_TOOL_DENY,
  TEAM_TOOL_DENY,
  enforceEnabled,
  enforceGuardReason,
  resolveActorMode,
  resolveBoardMode,
  restrictMainSessionTools,
} from './enforce.mjs'
import {
  STATE_POOLS,
  StateWorkerPool,
  handleState,
  panelStateReader,
  statePoolOf,
} from './state.mjs'


// ---------------------------------------------------------------- decisions
//
// One decision record stays `open` until the user answers it. The tool below is
// the model-side writer; bin/flow.mjs drives the same lib/core.mjs API, and the
// per-turn reminder only reads it.


/** The turn of this session's heartbeat record; `null` when it cannot be read. */
export function decisionTurnOf(c, root, contract, session) {
  if (typeof session !== 'string' || session === '') return null
  try {
    if (typeof c.heartbeatStatus !== 'function') return null
    const status = c.heartbeatStatus(root, contract, session)
    const record = isPlainObject(status) ? status.record : null
    return isPlainObject(record) && Number.isInteger(record.turn) ? record.turn : null
  } catch {
    return null
  }
}

/** One `choice` option, restricted to the three fields the tool schema accepts. */
export function decisionOptionInput(option) {
  if (isPlainObject(option) === false) throw new Error('flow_decision ask: every option needs id, label and impact')
  if (typeof option.id !== 'string' || typeof option.label !== 'string' || typeof option.impact !== 'string') {
    throw new Error('flow_decision ask: every option needs id, label and impact')
  }
  return { id: option.id, label: option.label, impact: option.impact }
}

/**
 * The lib/core.mjs `addDecision` input of one ask. `asked_session` (this session)
 * and `asked_turn` (its heartbeat turn) are the ledger's provenance: they let the
 * reminder say how many turns an item has been waiting. The turn is written only
 * when it is a real integer; the session is written regardless.
 */
export function decisionAskInput(args, c, root, contract, session) {
  const kind = typeof args.kind === 'string' ? args.kind.trim() : ''
  if (kind === '') throw new Error('flow_decision ask requires kind: choice, approval or input')
  if (typeof args.rationale !== 'string' || args.rationale.trim() === '') {
    throw new Error('flow_decision ask requires rationale: say why the user must decide now')
  }
  const input = { question: args.question, kind, rationale: args.rationale }
  if (Array.isArray(args.options)) input.options = args.options.map(decisionOptionInput)
  const recommendation =
    typeof args.recommendation === 'string' && args.recommendation.trim() !== '' ? args.recommendation.trim() : ''
  if (recommendation !== '') input.recommendation = recommendation
  // An approval asked without a recommendation recommends approve; a session that
  // wants the user to reject passes recommendation: 'reject' explicitly.
  else if (kind === 'approval') input.recommendation = 'approve'
  if (args.default !== undefined && args.default !== null) input.default = args.default
  for (const name of ['blocks', 'affects']) {
    if (Array.isArray(args[name])) input[name] = args[name]
  }
  if (typeof args.supersedes === 'string' && args.supersedes.trim() !== '') input.supersedes = args.supersedes.trim()
  input.asked_session = session
  const turn = decisionTurnOf(c, root, contract, session)
  if (turn !== null) input.asked_turn = turn
  return input
}

export function buildToolDefinitions(deps, settings) {
  const { ctx, toolRoot } = deps
  return [
    /* P4: the subtask tool lives in lib/tools/subtasks.mjs (same definition
       shape as the sub-plugin tools) and is mounted with this entry so guard
       rule 5 (parent in an implementation stage) becomes reachable. */
    buildSubtaskDefinition(deps),
    {
      name: 'flow_veto',
      description:
        'Record an analysis-phase veto. `action:"veto"` + `target:"task"` (default) keeps the task in analyzing but creates a flow_decision with exactly two choices — modify (re-queue to queued-analysis) or delete (complete it, then the normal 7-day archive rule applies) — and points the task\'s `decision` at it. `target:"subtask"` is self-decided by the session: the child is completed (never deleted), `[removed] <reason>` is appended to its notes, and the parent gets one notes line. `action:"answer"` applies the user\'s `choice` (modify|delete), closes the decision, and keeps the veto history.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['veto', 'answer'] },
          target: { type: 'string', enum: ['task', 'subtask'], description: 'veto: which kind of task is vetoed (default task).' },
          root: ROOT_PROPERTY,
          id: { type: 'string', description: 'The task id (main task or subtask).' },
          reason: { type: 'string', description: 'veto: why analysis rejects it (required).' },
          choice: { type: 'string', enum: ['modify', 'delete'], description: 'answer: the user\'s choice.' },
        },
        required: ['action', 'id'],
        additionalProperties: false,
      },
      output: toolOutput(),
      isConcurrencySafe: false,
      timeoutMs: WRITE_TIMEOUT_MS,
      async execute(args, exec) {
        const root = toolRoot(ctx, args, exec)
        requireStore(root)
        const c = requireCore()
        const { contract } = c.loadContract(root)
        const action = typeof args.action === 'string' ? args.action : ''
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id === '') throw new Error('flow_veto requires id')
        if (action === 'veto') {
          const target = typeof args.target === 'string' ? args.target : 'task'
          if (target === 'subtask') return { root, ...vetoSubtask(root, contract, { taskId: id, reason: args.reason }) }
          return { root, ...vetoTask(root, contract, { taskId: id, reason: args.reason }) }
        }
        if (action === 'answer') return { root, ...applyVetoAnswer(root, contract, { taskId: id, choice: args.choice }) }
        throw new Error(`unknown flow_veto action: ${String(action)}`)
      },
    },
    {
      name: 'flow_status',
      description:
        'Report the project flow ledger: contract source, experiment and task totals, and gate definitions with their last result. Read-only. Works with the .agents/flow store; an uninitialized workspace reports empty totals.',
      parameters: { type: 'object', properties: { root: ROOT_PROPERTY }, required: [], additionalProperties: false },
      output: toolOutput(),
      isConcurrencySafe: true,
      timeoutMs: 15_000,
      async execute(args, exec) {
        const root = toolRoot(ctx, args, exec)
        const c = requireCore()
        const loaded = c.loadContract(root)
        const state = c.readStoreState(root, loaded.contract)
        const experiments = state.experiments
        const tasks = state.tasks
        const result = {
          root,
          store: hasStore(root),
          contract: { source: loaded.source, schema: loaded.contract.schema, name: loaded.contract.name },
          experiments: { total: experiments.counts.total, counts: experiments.counts },
          tasks: { total: tasks.counts.total, counts: tasks.counts },
          gates: (Array.isArray(state.gates.items) ? state.gates.items : []).map((gate) => ({
            id: gate.id,
            ok: gate.lastRun === null || gate.lastRun === undefined ? null : gate.lastRun.ok === true,
            at: gate.lastRun === null || gate.lastRun === undefined ? null : gate.lastRun.started_at,
          })),
        }
        // §9 status block (P1). Same shape the CLI `--json` envelope carries:
        // stack / counts / team / unfinished + the §6.3 recentCaptured escape hatch.
        if (captureEnabled(settings)) {
          try {
            const team = await teamStatusFor(ctx, exec.agent, root)
            Object.assign(result, buildStatusBlock(c, root, loaded.contract, team, settings.captureState))
          } catch (error) {
            warnMount(`status block unavailable: ${brief(error)}`, ctx)
          }
        }
        return result
      },
    },
    {
      name: 'flow_heartbeat',
      description:
        'Main-session work heartbeat for the project ledger. The plugin owns the lifecycle: it opens the heartbeat automatically on `agent/created` (goal/default task/claims come from the task stack top) and closes it on `agent/disposed`, so a session cannot start or end one. A session only refreshes what it knows: update goal/task/claims/last_action/status. list and status read the section. A human can still open or close one by hand with the CLI (`flow heartbeat start|end`) as an escape hatch. The ledger lives in the project main worktree, even when the current session runs in a linked worktree. Writes require a .agents/flow store.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['update', 'list', 'status'],
            description: 'update refreshes this session\'s heartbeat; list/status read the section. The lifecycle (start/end) belongs to the plugin.',
          },
          root: ROOT_PROPERTY,
          goal: { type: 'string', description: 'What this turn works on. start defaults it to the current task title.' },
          task: {
            type: 'string',
            description: 'Task id this session works on; defaults to the session active/draft task.',
          },
          claims: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files or directories this session writes exclusively; other sessions stay out of them.',
          },
          last_action: { type: 'string', description: 'Latest action, shown on the panel heartbeat line.' },
          note: { type: 'string', description: 'Free note; folded into last_action on start/end.' },
          status: {
            type: 'string',
            enum: ['working', 'idle', 'waiting'],
            description: 'update only: working keeps the turn open, idle parks the heartbeat, waiting marks a turn-closed session whose subagents still run.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: toolOutput(),
      isConcurrencySafe: false,
      timeoutMs: WRITE_TIMEOUT_MS,
      async execute(args, exec) {
        const workspace = toolRoot(ctx, args, exec)
        const action = args.action
        // The heartbeat ledger belongs to the project's main worktree, so a
        // session running in a linked worktree reads and writes the same files.
        const heartbeat = heartbeatRootOf(workspace)
        const root = heartbeat.root

        if (action === 'list') {
          const warnings = []
          if (heartbeat.degraded === true) {
            warnings.push(`heartbeat-root-degraded: ${heartbeat.reason || root}`)
          }
          const store = hasStore(root)
          if (coreAvailable() === false || store === false) {
            if (coreAvailable() === false) warnings.push(`core-unavailable: ${coreFailure || 'unknown error'}`)
            return {
              root,
              workspace,
              store,
              dir: '.agents/heartbeat',
              items: [],
              counts: { total: 0, active: 0, stale: 0, hidden: 0 },
              warnings,
            }
          }
          const c = requireCore()
          const { contract } = c.loadContract(root)
          const section = c.readHeartbeatSection(root, contract)
          const items = isPlainObject(section) && Array.isArray(section.items) ? section.items : []
          const counts = isPlainObject(section) && isPlainObject(section.counts)
            ? section.counts
            : { total: items.length, active: 0, stale: 0, hidden: 0 }
          return {
            root,
            workspace,
            store,
            dir: isPlainObject(section) && typeof section.dir === 'string' ? section.dir : '.agents/heartbeat',
            items: items.slice(0, MAX_TOOL_ITEMS),
            counts,
            ...(items.length > MAX_TOOL_ITEMS ? { truncated: true } : {}),
            warnings,
          }
        }

        if (action === 'status') {
          const session = requireSession(exec)
          const c = requireCore()
          if (typeof c.heartbeatStatus !== 'function') {
            throw new Error('flow_heartbeat status needs a newer lib/core.mjs: heartbeat support is missing')
          }
          const warnings = []
          const { contract } = c.loadContract(root)
          const result = c.heartbeatStatus(root, contract, session)
          return {
            root,
            workspace,
            store: hasStore(root),
            session,
            active: isPlainObject(result) && result.active === true,
            record: isPlainObject(result) && isPlainObject(result.record) ? result.record : null,
            warnings,
          }
        }

        // Lifecycle is the plugin's: it is the only party that sees
        // `agent/created` / `agent/disposed`. A session that could start one
        // could fabricate a heartbeat, and one that could end one could close a
        // heartbeat that is still alive. The message must give a way forward.
        if (action === 'start' || action === 'end') {
          throw new Error(
            `flow_heartbeat ${action} is not a session action: the plugin opens the heartbeat on session creation and closes it on disposal, so this call was refused. Session scope is update (goal/task/claims/last_action/status) plus list/status. If you really need to ${action === 'start' ? 'open' : 'close'} one by hand, use the CLI: flow heartbeat ${action}`,
          )
        }

        const session = requireSession(exec)
        // Delegated child sessions never keep a heartbeat: refuse loudly with an
        // actionable hint instead of silently writing a hidden ledger file.
        if (rootSessionVerdict(ctx, exec.agent) === false) {
          throw new Error(ROOT_SESSION_HEARTBEAT_ONLY)
        }
        requireStore(root)
        const c = requireCore()
        const { contract } = c.loadContract(root)

        if (action === 'update') {
          if (typeof c.updateHeartbeat !== 'function') {
            throw new Error('flow_heartbeat update needs a newer lib/core.mjs: heartbeat support is missing')
          }
          const patch = pickFields(args, ['status', 'last_action', 'goal', 'task', 'claims'])
          if (Object.keys(patch).length === 0) throw new Error('flow_heartbeat update requires at least one field to change')
          const heartbeat = c.updateHeartbeat(root, contract, session, patch)
          const result = { root, workspace, store: true, session, heartbeat }
          if (captureEnabled(settings)) {
            try {
              const team = await teamStatusFor(ctx, exec.agent, root)
              Object.assign(result, buildStatusBlock(c, root, contract, team, settings.captureState))
            } catch (error) {
              warnMount(`status block unavailable: ${brief(error)}`, ctx)
            }
          }
          return result
        }
        throw new Error(`unknown flow_heartbeat action: ${String(action)}`)
      },
    },
    {
      name: 'flow_decision',
      description:
        'Decision ledger for questions only the user can settle: `ask` records one open item (choice/approval/input), `list` and `show` read it, `answer` closes it with the user\'s choice, `withdraw` drops it with a reason, `gc` removes closed records past the retention window. R1: call ask BEFORE you pose the question, then put the returned id in the question text as [D-<id>]. R2: in the same turn the user answers, call answer with their choice. R5: recommendation and default are proposals, not the answer - never adopt one on the user\'s behalf. An approval asked without a recommendation recommends approve (pass recommendation reject to recommend rejection). Write actions serve main sessions only: a subagent reports the pending decision in its final message, and only the parent (main) session creates and closes a D record. list/show work in any session; writes require a .agents/flow store.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['ask', 'list', 'show', 'answer', 'withdraw', 'gc'],
            description: 'ask creates, list/show read, answer/withdraw close one, gc prunes closed records.',
          },
          root: ROOT_PROPERTY,
          id: { type: 'string', description: 'Decision id, e.g. D-20261031-01.' },
          question: { type: 'string', description: 'ask: the one-sentence question the user must settle.' },
          kind: {
            type: 'string',
            enum: ['choice', 'approval', 'input'],
            description: 'ask: choice needs 2+ options, approval uses the fixed approve|reject pair, input takes free text.',
          },
          options: {
            type: 'array',
            description: 'ask + kind=choice: the mutually exclusive options.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Short option id the answer names, e.g. adopt.' },
                label: { type: 'string', description: 'What the user picks.' },
                impact: { type: 'string', description: 'What changes when this option is chosen.' },
              },
              required: ['id', 'label', 'impact'],
              additionalProperties: false,
            },
          },
          default: { type: 'string', description: 'ask: option id used when the user never answers; not an answer.' },
          recommendation: {
            type: 'string',
            description: 'ask: option id this session proposes; not an answer. Omitted on kind=approval means approve.',
          },
          rationale: { type: 'string', description: 'ask: why the user must decide now; required.' },
          blocks: {
            type: 'array',
            items: { type: 'string' },
            description: 'ask: task ids that cannot proceed until the user answers.',
          },
          affects: {
            type: 'array',
            items: { type: 'string' },
            description: 'ask: repo-relative files or directories the answer changes.',
          },
          supersedes: {
            type: 'string',
            description: 'ask: closed decision id this one replaces; required to re-ask the same question.',
          },
          choice: { type: 'string', description: 'answer: the option id (kind=input: free text) the user picked.' },
          note: { type: 'string', description: 'answer: the user\'s wording or a short note.' },
          by: { type: 'string', enum: ['user', 'agent'], description: 'Who confirmed it; defaults to user.' },
          reason: { type: 'string', description: 'withdraw: why the question no longer applies; required.' },
          days: { type: 'integer', description: 'gc: closed-record retention window in days (default 90).' },
          dryRun: { type: 'boolean', description: 'gc: report what would be removed without deleting it.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: toolOutput(),
      isConcurrencySafe: false,
      timeoutMs: WRITE_TIMEOUT_MS,
      async execute(args, exec) {
        const root = toolRoot(ctx, args, exec)
        const c = requireCore()
        const action = args.action

        // Read actions are open to every session: a subagent may want to know
        // which decision already blocks its task.
        if (action === 'list') {
          if (hasStore(root) === false) {
            return { root, items: [], counts: emptyDecisionCounts(), note: EMPTY_STORE_NOTE }
          }
          if (typeof c.summarizeDecisions !== 'function' || typeof c.listDecisions !== 'function') {
            throw new Error('flow_decision list needs a newer lib/core.mjs: decision support is missing')
          }
          const { contract } = c.loadContract(root)
          const session = usableSessionId(sessionIdOf(exec) ?? '')
          const turn = decisionTurnOf(c, root, contract, session)
          const info = { session, turn }
          const summary = c.summarizeDecisions(root, contract, info)
          return { root, items: c.listDecisions(root, contract, info), counts: decisionCountsOf(summary.counts) }
        }

        if (action === 'show') {
          if (typeof c.getDecision !== 'function') {
            throw new Error('flow_decision show needs a newer lib/core.mjs: decision support is missing')
          }
          const id = requireId('flow_decision', action, args.id)
          const { contract } = c.loadContract(root)
          return { root, decision: c.getDecision(root, contract, id) }
        }

        // Writes: the decision ledger belongs to the main session's conversation
        // with the user. Refuse loudly instead of writing an answer nobody asked.
        if (rootSessionVerdict(ctx, exec.agent) === false) {
          throw new Error(ROOT_SESSION_DECISION_ONLY)
        }
        requireStore(root)
        const { contract } = c.loadContract(root)

        if (action === 'ask') {
          if (typeof c.addDecision !== 'function') {
            throw new Error('flow_decision ask needs a newer lib/core.mjs: decision support is missing')
          }
          const session = requireSession(exec)
          const result = c.addDecision(root, contract, decisionAskInput(args, c, root, contract, session))
          return { root, decision: result.decision, created: result.created === true }
        }
        if (action === 'answer') {
          if (typeof c.answerDecision !== 'function') {
            throw new Error('flow_decision answer needs a newer lib/core.mjs: decision support is missing')
          }
          const id = requireId('flow_decision', action, args.id)
          /* Record the answer first, then try to apply a veto automatically. The
             helper guarantees the order and turns an apply failure into
             `vetoApplied:false` + `vetoWarning` instead of failing the answer. */
          const applied = answerDecisionAndApply(root, contract, id, pickFields(args, ['choice', 'note', 'by']))
          return { root, ...applied }
        }
        if (action === 'withdraw') {
          if (typeof c.withdrawDecision !== 'function') {
            throw new Error('flow_decision withdraw needs a newer lib/core.mjs: decision support is missing')
          }
          const id = requireId('flow_decision', action, args.id)
          return { root, decision: c.withdrawDecision(root, contract, id, pickFields(args, ['reason', 'by'])) }
        }
        if (action === 'gc') {
          if (typeof c.gcDecisions !== 'function') {
            throw new Error('flow_decision gc needs a newer lib/core.mjs: decision support is missing')
          }
          const options = {}
          if (args.days !== undefined) options.days = args.days
          if (args.dryRun !== undefined) options.dryRun = args.dryRun === true
          const result = c.gcDecisions(root, contract, options)
          return { root, removed: result.removed, kept: result.kept, dryRun: result.dryRun }
        }
        throw new Error(`unknown flow_decision action: ${String(action)}`)
      },
    },
  ]
}

/**
 * Mount this plugin's three tools. The registration semantics (optional
 * service, one effect, core-warning wrapper, unload) are the shared ones in
 * lib/plugin/mount.mjs, so the sub-plugins mount theirs the same way.
 */
export function registerTools(ctx, settings) {
  const heartbeatGate = settings !== null && typeof settings === 'object' && settings.heartbeatGate === true
  const enforce = settings !== null && typeof settings === 'object' && settings.enforce === true
  const claims = settings !== null && typeof settings === 'object' && settings.claims === true
  const actorMode = settings !== null && typeof settings === 'object' && settings.actorMode === 'team' ? 'team' : 'single'
  const boardMode = settings !== null && typeof settings === 'object' && settings.boardMode === 'plugin' ? 'plugin' : 'lead'
  // Dispatch is always denied; bookkeeping only in `plugin` mode.
  const deniedTools = boardMode === 'plugin' ? TEAM_TOOL_DENY : DISPATCH_TOOL_DENY
  // Three independent guards, one predicate: the heartbeat write gate (a session
  // without a working heartbeat may not edit/write), the claims write domain
  // (edit/write must stay inside the session's heartbeat claims) and the P2
  // permission surface (plan §5.2). Each failure inside a guard allows the call.
  const guard =
    heartbeatGate === false && enforce === false && claims === false
      ? undefined
      : (scoped) => (execution) => {
          if (heartbeatGate) {
            const reason = heartbeatGuardReason(scoped, execution)
            if (reason !== undefined) return reason
          }
          if (claims) {
            const reason = claimsGuardReason(scoped, execution)
            if (reason !== undefined) return reason
          }
          if (enforce) {
            const reason = enforceGuardReason(scoped, execution, actorMode, deniedTools)
            if (reason !== undefined) return reason
          }
          return undefined
        }
  registerToolDefinitions(ctx, {
    label: 'tools',
    build: (scoped) => buildToolDefinitions(toolDeps(scoped), settings),
    guard,
  })
}
