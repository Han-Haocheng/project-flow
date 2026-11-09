// project-flow — the `flow_task` tool definition.
//
// Moved verbatim out of index.js (buildToolDefinitions) so the shared
// `project-flow` plugin and the `@local/project-flow/tasks` sub-plugin register
// the same object. Only the mount context and its root resolver arrive through
// `deps`; every rule (store probe, core accessor, field whitelists, caps) is
// imported from the single shared implementation.

import { requireCore, taskCountsOf } from '../state-snapshot.mjs'
import {
  autoDispatchEnabled,
  dispatchCheckpoint,
  dispatchEnabled,
  dispatchPlan,
  dispatchProvider,
  dispatchTask,
} from '../dispatch.mjs'
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

/**
 * 派工一次：起子代理 → 写回执 → 走 plugin 边到 working 阶段。
 * 显式 `dispatch` 动作与「阶段入口自动派工」共用这一条实现，避免两套语义。
 */
async function dispatchOnce({ c, ctx, exec, root, contract, task, config }) {
  const plan = dispatchPlan(task)
  if (plan.ok === false) throw new Error(plan.reason)
  const agent = exec !== null && exec !== undefined ? exec.agent : undefined
  const started = await dispatchTask({
    ctx,
    agent,
    task,
    root,
    provider: dispatchProvider(config),
    signal: exec !== null && exec !== undefined ? exec.signal : undefined,
  })
  const checkpoints = Array.isArray(task.checkpoints) ? task.checkpoints.slice() : []
  checkpoints.push(
    dispatchCheckpoint({
      childId: started.childId,
      role: plan.role,
      provider: started.provider,
      from: typeof task.stage === 'string' ? task.stage : '',
      to: plan.workingStage,
    }),
  )
  let updated
  try {
    updated = c.updateTask(root, contract, task.id, { checkpoints, stage: plan.workingStage }, { source: 'plugin' })
  } catch (error) {
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
    throw new Error(
      `子代理 ${started.childId} 已启动，但台账推进失败：${message}；用 flow_task show ${task.id} 核对后用 update 补 stage=${plan.workingStage}`,
    )
  }
  return {
    task: updated,
    dispatch: { childId: started.childId, role: plan.role, provider: started.provider, from: task.stage, to: plan.workingStage },
  }
}

/**
 * 阶段入口自动派工（P3b 第二批）：`flow_task update` 把任务推进到 queued-* 之后，
 * 插件直接起对应角色的子代理。捕获建卡走 core（不经这个工具），所以聊天消息不会
 * 触发派工——只有会话「显式把任务排进队列」才派，避免每句话都生一个子代理。
 *
 * 失败不拖垮 update：台账已经写成功，结果里带 `dispatch.ok:false` 和原因，让调用方
 * 决定重试（显式 dispatch）还是人工处理。
 */
async function autoDispatchAfterUpdate({ c, ctx, exec, root, contract, task, config }) {
  if (autoDispatchEnabled(config) === false) return null
  if (dispatchPlan(task).ok === false) return null
  try {
    const result = await dispatchOnce({ c, ctx, exec, root, contract, task, config })
    return { ...result, dispatch: { ...result.dispatch, auto: true } }
  } catch (error) {
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
    return { task, dispatch: { auto: true, ok: false, error: message } }
  }
}

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
 * root resolver bound to that context. `config` is the plugin config of this
 * mount, used only by the `dispatch` action (`config.dispatch`).
 *
 * @param {{ctx: unknown, toolRoot: (ctx: unknown, args: unknown, exec: unknown) => string}} deps
 * @param {unknown} [config]
 */
export function buildDefinition(deps, config) {
  const { ctx, toolRoot } = deps
  return {
    name: 'flow_task',
    description:
      'List, inspect, add, update, remove or dispatch project-flow tasks (title, type, status, owner, notes, parent tree, scope, acceptance, commits). `title` carries both the heading and the goal — `goal` was merged into `title` (legacy `goal` keys on disk are migrated by the format gate, not accepted here). All actions require the .agents/flow store. `type` is required on add and is one of feat/fix/docs/style/refactor/perf/test/chore/build/ci (conventional commit kinds). `title` and `type` cannot be changed by update. `parent` links a subtask to an existing task (the parent must exist; self-reference and cycles are invalid; empty string/none/null makes it a root). `dispatch` asks the plugin (not the main session) to start the role subagent of a queued task: analyzer for 待分析, implementer for 待实现, reviewer for 待审查; the plugin starts the child, walks the plugin edge to the working stage and records a dispatch checkpoint.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'add', 'update', 'remove', 'dispatch'] },
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
        const updated = c.updateTask(root, contract, id, normalizeTaskParent(c, patch), ownerOptions)
        const automatic = await autoDispatchAfterUpdate({ c, ctx, exec, root, contract, task: updated, config })
        if (automatic === null) return { root, task: updated }
        return { root, task: automatic.task, dispatch: automatic.dispatch }
      }
      if (action === 'remove') {
        const id = requireId('flow_task', action, args.id)
        return { root, ...c.removeTask(root, contract, id) }
      }
      /* P3b（D-20261109-01）：主会话不直接调度，改为让插件派角色子代理。
         顺序：先起子代理拿 childId，再写回执并走 plugin 边到 working 阶段——
         写台账失败时子代理已经在跑，所以错误文案必须带上 childId 与补救步骤。 */
      if (action === 'dispatch') {
        const id = requireId('flow_task', action, args.id)
        if (dispatchEnabled(config) === false) {
          throw new Error('flow_task dispatch 已被禁用（config.dispatch.enabled=false）；请人工处理该任务')
        }
        const task = c.getTask(root, contract, id)
        const result = await dispatchOnce({ c, ctx, exec, root, contract, task, config })
        return { root, task: result.task, dispatch: result.dispatch }
      }
      throw new Error(`unknown flow_task action: ${String(action)}`)
    },
  }
}
