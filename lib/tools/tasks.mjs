// project-flow — the `flow_task` tool definition.
//
// Moved verbatim out of index.js (buildToolDefinitions) so the shared
// `project-flow` plugin and the `@local/project-flow/tasks` sub-plugin register
// the same object. Only the mount context and its root resolver arrive through
// `deps`; every rule (store probe, core accessor, field whitelists, caps) is
// imported from the single shared implementation.

import { requireCore, taskCountsOf } from '../state-snapshot.mjs'
import {
  assertOnlyFields,
  EMPTY_STORE_NOTE,
  hasStore,
  ID_PROPERTY,
  MAX_TOOL_ITEMS,
  normalizeTaskParent,
  pickFields,
  requireId,
  requireStore,
  ROOT_PROPERTY,
  TASK_ACTION_FIELDS,
  TASK_ADD_FIELDS,
  TASK_UPDATE_FIELDS,
  toolOutput,
  WRITE_TIMEOUT_MS,
} from '../plugin/shared.mjs'

/** The calling session id of one tool run, or '' when the run has no live agent. */
function sessionOfExec(exec) {
  try {
    const agent = exec !== null && exec !== undefined ? exec.agent : undefined
    const id = agent !== null && agent !== undefined ? agent.id : undefined
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : ''
  } catch {
    return ''
  }
}

/**
 * `owner === live session` evidence for the session-ownership guard
 * (D-20261108-05 = extend-owner), taken from the optional host `agents` service.
 * `undefined` = no evidence (a host without the service must not start refusing
 * everything); `false` = the registry says the session is gone.
 */
function sessionLiveProbe(ctx) {
  let agents
  try {
    agents = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  } catch {
    agents = undefined
  }
  if (agents === null || agents === undefined) return undefined
  let live = null
  return (session) => {
    if (typeof session !== 'string' || session.trim() === '') return false
    try {
      if (typeof agents.get === 'function' && agents.get(session) !== undefined && agents.get(session) !== null) return true
    } catch {
      // Fall through to the list projection.
    }
    if (live === null) {
      const ids = new Set()
      for (const method of ['roots', 'list']) {
        try {
          if (typeof agents[method] !== 'function') continue
          const value = agents[method]()
          if (Array.isArray(value)) {
            for (const agent of value) {
              const id = agent !== null && agent !== undefined && typeof agent.id === 'string' ? agent.id.trim() : ''
              if (id !== '') ids.add(id)
            }
          }
        } catch {
          // An unavailable registry is "no evidence", never a hard failure.
        }
      }
      live = ids
    }
    return live.has(session)
  }
}

/**
 * The moved literal is written against `toolRoot(ctx, args, exec)` and uses `ctx`
 * verbatim, so a mount hands it exactly those two: the scoped context and the
 * root resolver bound to that context.
 *
 * @param {{ctx: unknown, toolRoot: (ctx: unknown, args: unknown, exec: unknown) => string}} deps
 */
export function buildDefinition(deps) {
  const { ctx, toolRoot } = deps
  return {
    name: 'flow_task',
    description:
      'List, inspect, add, update or remove project-flow tasks (title, type, status, owner, notes, parent tree, scope, acceptance, commits). `title` carries both the heading and the goal — `goal` was merged into `title` (legacy `goal` keys on disk are migrated by the format gate, not accepted here). All actions require the .agents/flow store. `type` is required on add and is one of feat/fix/docs/style/refactor/perf/test/chore/build/ci (conventional commit kinds). `title` and `type` cannot be changed by update. `parent` links a subtask to an existing task (the parent must exist; self-reference and cycles are invalid; empty string/none/null makes it a root).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'add', 'update', 'remove'] },
        root: ROOT_PROPERTY,
        id: ID_PROPERTY,
        title: {
          type: 'string',
          description: 'Heading and goal of the task; required on add and cannot be changed by update.',
        },
        type: {
          type: 'string',
          enum: ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci'],
          description: 'Conventional commit type; required on add and cannot be changed by update.',
        },
        status: { type: 'string', enum: ['draft', 'active', 'done', 'archived'] },
        stage: {
          type: 'string',
          enum: ['created', 'queued-analysis', 'analyzing', 'queued-implementation', 'implementing', 'queued-review', 'reviewing', 'done', 'archived'],
          description:
            'update only: 九阶段之一。写它会派生 status（created→draft，done→done，archived→archived，其余→active），不要同时给矛盾的 status。会话只能推进 actor=session 的边；其余边由插件/审查者推进（P2 guard）。',
        },
        owner: { type: 'string' },
        notes: { type: 'string' },
        experiment: {
          type: 'string',
          description: 'Linked experiment id (optional; an unknown id only warns, a malformed one is invalid).',
        },
        parent: {
          type: 'string',
          description: '父任务 id（可选；空串/none/null = 根）。父须存在，禁自指/禁环。',
        },
        commits: { type: 'array', items: { type: 'string' }, description: 'Short commit shas.' },
        scope: {
          type: 'object',
          properties: {
            allow: { type: 'array', items: { type: 'string' } },
            deny: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        acceptance: { type: 'array', items: { type: 'string' } },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: toolOutput(),
    isConcurrencySafe: false,
    timeoutMs: WRITE_TIMEOUT_MS,
    async execute(args, exec) {
      const root = toolRoot(ctx, args, exec)
      const action = args.action
      assertOnlyFields('flow_task', action, args, TASK_ACTION_FIELDS[action])
      if (action !== 'list') requireStore(root)

      const c = requireCore()
      const { contract } = c.loadContract(root)
      if (action === 'list' && hasStore(root) === false) {
        return {
          root,
          store: false,
          source: 'store',
          total: 0,
          counts: { draft: 0, active: 0, done: 0, archived: 0, other: 0 },
          current: null,
          items: [],
          note: EMPTY_STORE_NOTE,
        }
      }
      if (action === 'list') {
        const records = c.listTasks(root, contract)
        return {
          root,
          store: true,
          source: 'store',
          total: records.length,
          counts: taskCountsOf(records),
          current: typeof contract.tasks.current === 'string' ? contract.tasks.current : null,
          items: records.slice(0, MAX_TOOL_ITEMS),
          ...(records.length > MAX_TOOL_ITEMS ? { truncated: true } : {}),
        }
      }
      if (action === 'show') {
        return { root, task: c.getTask(root, contract, requireId('flow_task', action, args.id)) }
      }
      if (action === 'add') {
        const input = pickFields(args, TASK_ADD_FIELDS)
        return { root, task: c.addTask(root, contract, normalizeTaskParent(c, input)) }
      }
      if (action === 'update') {
        const id = requireId('flow_task', action, args.id)
        const patch = pickFields(args, TASK_UPDATE_FIELDS)
        if (Object.keys(patch).length === 0) throw new Error('flow_task update requires at least one field to change')
        if (Object.hasOwn(patch, 'owner')) patch.owner = c.normalizeOwnerInput(patch.owner)
        const ownerOptions = {}
        const actorSession = sessionOfExec(exec)
        if (actorSession !== '') ownerOptions.actorSession = actorSession
        const isSessionLive = sessionLiveProbe(ctx)
        if (isSessionLive !== undefined) ownerOptions.isSessionLive = isSessionLive
        return { root, task: c.updateTask(root, contract, id, normalizeTaskParent(c, patch), ownerOptions) }
      }
      if (action === 'remove') {
        const id = requireId('flow_task', action, args.id)
        return { root, ...c.removeTask(root, contract, id) }
      }
      throw new Error(`unknown flow_task action: ${String(action)}`)
    },
  }
}
