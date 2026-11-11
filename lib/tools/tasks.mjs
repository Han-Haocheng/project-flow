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
  dispatchEnabled,
  dispatchPlan,
  dispatchProvider,
  dispatchTaskRecord,
} from '../dispatch.mjs'
// 并发签名直接从任务域读（core 的 re-export 由并行卡补）：这里只读磁盘记录，
// 不碰 getTask 的读投影——修订号必须与 updateTask 的 CAS 用同一份字节。
import { taskRevisionOf } from '../tasks/records.mjs'
import { completeBoardTask, mountTaskOnBoard, teamMountEnabled } from '../team-sync.mjs'
import { FlowError, isPlainObject } from '../util.mjs'
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
 * `update` 的入参白名单：在核心字段之外单独放行 `expectedRevision`。
 *
 * 为什么不在 `lib/plugin/shared.mjs` 改 `TASK_UPDATE_FIELDS`：那份白名单同时是
 * `pickFields()` 的取值清单，而 `expectedRevision` 是**写路径选项**不是记录字段
 * （core 的 `updateTask` 从 `options` 读，永不落盘）。两用一张表会把并发令牌写进
 * 记录，进而污染 revision 本身。所以这里只给 `assertOnlyFields` 一张本地表。
 */
const TASK_UPDATE_ARG_FIELDS = Object.freeze([...TASK_UPDATE_FIELDS, 'expectedRevision'])
const TASK_ACTION_ARG_FIELDS = Object.freeze({ ...TASK_ACTION_FIELDS, update: TASK_UPDATE_ARG_FIELDS })

/** CAS 令牌形状：`taskRevisionOf()` 的 16 位小写十六进制签名。 */
const TASK_REVISION_RE = /^[0-9a-f]{16}$/

/**
 * 校验并归一 `expectedRevision`：缺省表示「不带 CAS」，与旧调用完全兼容；
 * 给了（含空串/纯空白）但不是 16 位小写 hex 就是调用方手误，必须拒绝——
 * 静默忽略会让 CAS 形同虚设。
 *
 * @returns {string} 归一后的令牌，或 `''`（不启用 CAS）
 */
function requireExpectedRevision(value) {
  if (value === undefined) return ''
  if (typeof value !== 'string') {
    throw new FlowError('invalid', 'flow_task update 的 expectedRevision 必须是字符串（16 位小写十六进制）；做法：先 flow_task show 取 revision，再原样带回')
  }
  const token = value.trim()
  if (TASK_REVISION_RE.test(token) === false) {
    throw new FlowError(
      'invalid',
      `flow_task update 的 expectedRevision 必须是 16 位小写十六进制（当前 ${JSON.stringify(value)}）；做法：先 flow_task show 取 revision，再原样带回`,
    )
  }
  return token
}

/**
 * 给工具输出补当前磁盘 revision。读不出来（记录被删/损坏）就省略——列表是尽力
 * 而为的投影，不能因为一条坏记录让整页失败；show/update 的记录刚刚读过，正常路径
 * 一定拿得到。
 */
function taskWithRevision(root, contract, task) {
  if (task === null || task === undefined || typeof task !== 'object') return task
  try {
    const revision = taskRevisionOf(root, contract, task.id)
    return typeof revision === 'string' && revision !== '' ? { ...task, revision } : task
  } catch {
    return task
  }
}

/**
 * 派工一次：起子代理 → 写回执 → 走 plugin 边到 working 阶段。
 * 显式 `dispatch` 动作与「阶段入口自动派工」共用这一条实现，避免两套语义。
 */
async function dispatchOnce({ c, ctx, exec, root, contract, task, config }) {
  const agent = exec !== null && exec !== undefined ? exec.agent : undefined
  const result = await dispatchTaskRecord({
    c,
    ctx,
    agent,
    root,
    contract,
    task,
    provider: dispatchProvider(config),
    signal: exec !== null && exec !== undefined ? exec.signal : undefined,
  })
  /* 团队板旁路（默认 off）：派工即开工，建一次板卡并领取。失败只回报，不影响派工。 */
  let team
  let finalTask = result.task
  if (teamMountEnabled(config) === true) {
    const mounted = await mountTaskOnBoard(ctx, agent, result.task, root, contract)
    if (isPlainObject(mounted) === true) {
      if (isPlainObject(mounted.record)) finalTask = mounted.record
      const { record: _record, ...status } = mounted
      team = status
    }
  }
  return {
    task: finalTask,
    dispatch: { ...result.dispatch, ...(team === undefined ? {} : { team }) },
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

/**
 * 子任务完成后的父任务聚合（2026-11-11 用户口径）：某个子任务进入终态时，若同一
 * 父任务的所有子任务都已终态，就把父任务推进到 queued-review 并自动派审查者。
 * 主会话不参与子任务流转，只在最后看审查结论。
 */
async function settleParentAfterChild({ c, ctx, exec, root, contract, task, config }) {
  try {
    if (task === null || typeof task !== 'object') return null
    if (typeof task.parent !== 'string' || task.parent === '') return null
    if (task.stage !== 'done' && task.stage !== 'archived') return null
    const all = typeof c.listTasks === 'function' ? c.listTasks(root, contract) : []
    const siblings = all.filter((item) => item !== null && typeof item === 'object' && item.parent === task.parent)
    if (siblings.length === 0) return null
    const unfinished = siblings.filter((item) => item.stage !== 'done' && item.stage !== 'archived')
    if (unfinished.length > 0) return null
    const parent = c.getTask(root, contract, task.parent)
    if (parent === null || typeof parent !== 'object') return null
    if (parent.stage !== 'analyzing' && parent.stage !== 'implementing') return null
    // 用户口径（2026-11-11）：子任务全部审查通过后，由**分析者**汇总并回报 lead，
    // 而不是再派一个父任务审查者。父任务回到 queued-analysis → 插件重新派分析者，
    // 分析者进入"汇总轮"（见 dispatchPrompt 的聚合指令）。
    const notes = `${parent.notes === '' ? '' : `${parent.notes}\n`}[auto] 子任务 ${siblings.length} 条全部完成，汇总并回报 lead`
    const updated = c.updateTask(root, contract, parent.id, { stage: 'queued-analysis', notes }, { source: 'internal' })
    const dispatched = await autoDispatchAfterUpdate({ c, ctx, exec, root, contract, task: updated, config })
    return {
      task: dispatched !== null ? dispatched.task : updated,
      dispatch: dispatched !== null ? dispatched.dispatch : undefined,
    }
  } catch (error) {
    try {
      ctx?.logger?.warn?.(`project-flow: settle parent ${task !== null && typeof task === 'object' ? task.parent : '?'}: ${error.message}`)
    } catch {
      // observer only
    }
    return null
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
      'List, inspect, add, update, remove or dispatch project-flow tasks (title, type, status, owner, notes, parent tree, scope, acceptance, commits). `title` carries both the heading and the goal — `goal` was merged into `title` (legacy `goal` keys on disk are migrated by the format gate, not accepted here). All actions require the .agents/flow store. `type` is required on add and is one of feat/fix/docs/style/refactor/perf/test/chore/build/ci (conventional commit kinds). `title` and `type` cannot be changed by update. `parent` links a subtask to an existing task (the parent must exist; self-reference and cycles are invalid; empty string/none/null makes it a root). `update` supports optimistic concurrency: call `show` first to read the task `revision`, then pass it back as `expectedRevision` (16 lowercase hex); a stale revision fails with `conflict` and nothing is written — re-`show` and retry with the new revision. `dispatch` asks the plugin (not the main session) to start the role subagent of a queued task: analyzer for 待分析, implementer for 待实现, reviewer for 待审查; the plugin starts the child, walks the plugin edge to the working stage and records a dispatch checkpoint.',
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
        expectedRevision: {
          type: 'string',
          description:
            'update only: 并发写保护。先 show 取 revision，再带 revision update（16 位小写十六进制）；记录在你读取后被人改过就抛 conflict 且不写入，重新 show 后用新 revision 重试。不传 = 不加 CAS（旧行为）。',
        },
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
      assertOnlyFields('flow_task', action, args, TASK_ACTION_ARG_FIELDS[action])
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
          items: records.slice(0, MAX_TOOL_ITEMS).map((task) => taskWithRevision(root, contract, task)),
          ...(records.length > MAX_TOOL_ITEMS ? { truncated: true } : {}),
        }
      }
      if (action === 'show') {
        const task = c.getTask(root, contract, requireId('flow_task', action, args.id))
        /* `revision` 是**磁盘记录的签名**，与 update 的 CAS 同源；读投影本身不带它
           （getTask 不动），所以在这里补。调用方拿它做 CAS 时不必再猜。 */
        return { root, task: taskWithRevision(root, contract, task) }
      }
      if (action === 'add') {
        const input = pickFields(args, TASK_ADD_FIELDS)
        const task = c.addTask(root, contract, normalizeTaskParent(c, input))
        // 主会话建好主任务即派分析者（阶段入口不在 queued-* 时不派）。
        const dispatched = await autoDispatchAfterUpdate({ c, ctx, exec, root, contract, task, config })
        if (dispatched === null) return { root, task }
        return { root, task: dispatched.task, dispatch: dispatched.dispatch }
      }
      if (action === 'update') {
        const id = requireId('flow_task', action, args.id)
        const patch = pickFields(args, TASK_UPDATE_FIELDS)
        if (Object.keys(patch).length === 0) throw new Error('flow_task update requires at least one field to change')
        /* CAS 令牌只进 options，不进 patch 也不进记录：它描述「我基于哪一版写」，
           不是任务字段。旧调用不带它，行为不变。 */
        const expectedRevision = requireExpectedRevision(args.expectedRevision)
        if (Object.hasOwn(patch, 'owner')) patch.owner = c.normalizeOwnerInput(patch.owner)
        const ownerOptions = {}
        const actorSession = sessionOfExec(exec)
        if (actorSession !== '') ownerOptions.actorSession = actorSession
        const isSessionLive = sessionLiveProbe(ctx)
        if (isSessionLive !== undefined) ownerOptions.isSessionLive = isSessionLive
        /* `conflict` 从这里原样上抛（code=conflict，消息已带「重新 show」指引）：
           工具层不重试、不覆盖——那正是本卡要堵的竞态。 */
        const writeOptions = expectedRevision === '' ? ownerOptions : { ...ownerOptions, expectedRevision }
        const before = c.getTask(root, contract, id)
        const updated = c.updateTask(root, contract, id, normalizeTaskParent(c, patch), writeOptions)
        /* 只有「这次 update 真的把 stage 换成了 queued-*」才自动派工：对已经停在
           queued-analysis 的任务改 notes/owner 不能又起一个 worker（否则一个 update 重试
           就多派一次）。显式 dispatch 动作不受这条限制。 */
        const stageEntered = updated.stage !== before.stage && typeof patch.stage === 'string'
        const automatic = stageEntered
          ? await autoDispatchAfterUpdate({ c, ctx, exec, root, contract, task: updated, config })
          : null
        const finalTask = automatic === null ? updated : automatic.task
        /* 子任务刚进入终态：若父任务的子任务已全部完成，聚合到 queued-review 并派审查者。 */
        if (automatic === null && (finalTask.stage === 'done' || finalTask.stage === 'archived')) {
          const settled = await settleParentAfterChild({ c, ctx, exec, root, contract, task: finalTask, config })
          if (settled !== null) {
            return {
              root,
              task: taskWithRevision(root, contract, settled.task),
              ...(settled.dispatch === undefined ? {} : { dispatch: settled.dispatch }),
            }
          }
        }
        /* 终态同步（默认 off）：只认 stage=done，别的阶段不动板卡状态。 */
        let team
        if (teamMountEnabled(config) === true && finalTask.stage === 'done') {
          team = await completeBoardTask(ctx, exec !== null && exec !== undefined ? exec.agent : undefined, finalTask)
        }
        return {
          root,
          task: taskWithRevision(root, contract, finalTask),
          ...(automatic === null ? {} : { dispatch: automatic.dispatch }),
          ...(team === undefined ? {} : { team }),
        }
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
