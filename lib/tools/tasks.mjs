// project-flow — the `flow_task` tool definition.
//
// Moved verbatim out of index.js (buildToolDefinitions) so the shared
// `project-flow` plugin and the `@local/project-flow/tasks` sub-plugin register
// the same object. Only the mount context and its root resolver arrive through
// `deps`; every rule (store probe, core accessor, field whitelists, caps) is
// imported from the single shared implementation.

import { isAbsolute, relative, resolve, sep } from 'node:path'

import { taskCountsOf } from '../state-snapshot.mjs'
import { contract as backendContract, tasks } from '../backend/api.mjs'
import {
  autoDispatchEnabled,
  autoDispatchTask,
  AGGREGATE_ROUND,
  dispatchEnabled,
  dispatchModelExplicit,
  dispatchModelRequired,
  dispatchPlan,
  dispatchProvider,
  dispatchRoleModel,
  dispatchTaskRecord,
} from '../dispatch.mjs'
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
  TASK_PLAN_FIELDS,
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
 * 校验并归一 `expectedRevision`：缺省/空串表示「不带 CAS」，与旧调用完全兼容；
 * 给了但不是 16 位小写 hex 就是调用方手误，必须拒绝——静默忽略会让 CAS 形同虚设。
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
    const revision = tasks.taskRevisionOf(root, contract, task.id)
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
  /* 派工模型（2026-11-12 任务书【B 派工模型】）：只有 config.dispatch 显式声明了
     model/models 才按角色取模型透传；没声明时传空串，请求里不出现 agentOptions
     （与今天逐字节一致）。 */
  const plan = dispatchPlan(task)
  const result = await dispatchTaskRecord({
    c,
    ctx,
    agent,
    root,
    contract,
    task,
    provider: dispatchProvider(config),
    model: dispatchModelExplicit(config) && plan.ok ? dispatchRoleModel(config, plan.role) : '',
    requireModel: dispatchModelRequired(config),
    // aspect 排队预算从插件配置读（config.aspectLock.waitMs，缺省 1500）。
    config,
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
  const agent = exec !== null && exec !== undefined ? exec.agent : undefined
  /* 与 add/update/plan 共用 `lib/dispatch.mjs` 的 `autoDispatchTask`：它自己把
     「起子代理失败」折成 `dispatch.ok:false`，所以这里不再重复一层 try/catch。 */
  const result = await autoDispatchTask({
    c,
    ctx,
    agent,
    root,
    contract,
    task,
    config,
    signal: exec !== null && exec !== undefined ? exec.signal : undefined,
  })
  if (result === null) return null
  /* 团队板旁路（默认 off）：派工即开工，建一次板卡并领取。失败只回报，不影响派工。 */
  let team
  let finalTask = result.task
  if (result.dispatch.ok !== false && teamMountEnabled(config) === true) {
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
 * 子任务完成后的父任务聚合（2026-11-11 用户口径）：某个子任务进入终态时，若同一
 * 父任务的所有子任务都已终态，就把父任务推进到 queued-review 并自动派审查者。
 * 主会话不参与子任务流转，只在最后看审查结论。
 */
async function settleParentAfterChild({ c, ctx, exec, root, contract, task, config }) {
  try {
    if (task === null || typeof task !== 'object') return null
    if (typeof task.parent !== 'string' || task.parent === '') return null
    if (task.stage !== 'done' && task.stage !== 'archived') return null
    const all = c.listTasks(root, contract)
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
    /* 汇总轮标记（T-20261111170544）：把父任务记为 `汇总轮`，派工器认这个标记就直接走
       `analyzing`（normalizeTask），而不是 queued-analysis→analyzing 那次插件边。
       为什么必须绕开：派工闸 2 的幂等只认 `from`，首轮分析者的 `from: 'queued-analysis'`
       回执会让汇总轮的派工被判成"已派过"（reused），汇总轮根本起不来——修复前整条
       流水线就卡在这里。标记因此进 patch 的**同一次写入**，CAS 之后不会被别人覆盖。 */
    // 标记值只在本模块定义一次（派工器认的是同一个 'aggregate' 字符串）。
    const dispatchRound = AGGREGATE_ROUND
    const updated = c.updateTask(
      root,
      contract,
      parent.id,
      { stage: 'queued-analysis', notes, dispatchRound },
      { source: 'internal' },
    )
    const dispatched = await autoDispatchAfterUpdate({ c: tasks, ctx, exec, root, contract, task: updated, config })
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

// ---------------------------------------------------------------- plan 接入（2026-11-11）
//
// 用户口径：「lead 专门负责分析我说的话，分析的结果变成任务进行处理」。lead 不再
// 逐张 `flow_task add`，而是交一份**结构化计划**；插件校验、建卡、复用自动派工。
// 旧「每句话自动建卡」（capture）保持默认关闭，这里只做显式工具入口。

/** 一份计划最多几张卡：防止一次把整个项目摊成几十个无人看的任务。 */
const MAX_PLAN_TASKS = 8

/** 计划单条允许的字段。`parent` 故意不在：主任务由插件建，lead 不能指定父子。 */
const PLAN_ITEM_FIELDS = Object.freeze(['type', 'title', 'scope', 'acceptance', 'notes', 'priority'])

/** 与 core `TASK_TYPES` 同值的十枚举（schema 也用它，两处必须一致）。 */
const PLAN_TYPE_ENUM = Object.freeze(['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci'])

/** 校验失败一律抛可执行的 FlowError：点名字段 + 做法，绝不静默跳过。 */
function planInvalid(field, problem, fix) {
  return new FlowError('invalid', `flow_task plan 校验失败：${field} ${problem}；做法：${fix}`)
}

/**
 * 把一条写域路径归一到项目根内的 POSIX 相对路径；空串/越界/根外绝对路径返回
 * null。绝对路径只有在根内时才允许（归一后仍存相对路径，便于重复判定）。
 */
function planScopePath(root, raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return null
  const absRoot = resolve(root)
  const target = isAbsolute(text) ? resolve(text) : resolve(absRoot, text)
  const rel = relative(absRoot, target)
  if (rel === '') return '.'
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  return rel.split(sep).join('/')
}

/** 标题归一：去首尾空白、折叠内部空白、统一小写（只用于**重复判定**，不改标题）。 */
function normalizedPlanTitle(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : ''
}

/**
 * 一组写域路径的归一视图（用于与既有任务的 `scope.allow` 比较）。既有记录里可能
 * 是 `./lib/x`、`lib/x`、反斜杠或根内绝对路径，先归一到同一个相对形式再比。
 */
function normalizedScopeAllow(root, scope) {
  if (isPlainObject(scope) === false || Array.isArray(scope.allow) === false) return []
  return scope.allow.map((entry) => {
    if (typeof entry !== 'string') return ''
    const path = planScopePath(root, entry)
    return path === null ? entry.trim() : path
  })
}

/** 顺序敏感的全等比较：写域是声明，不是集合；顺序不同就不是「完全相同」。 */
function scopeAllowEqual(root, plannedAllow, existingScope) {
  const existing = normalizedScopeAllow(root, existingScope)
  if (existing.length === 0 || plannedAllow.length !== existing.length) return false
  return plannedAllow.every((entry, index) => entry === existing[index])
}

/**
 * 校验一份计划并返回归一后的条目。全部通过前**不写盘**。
 *
 * @returns {{items: Array<object>, rationale: string}}
 */
function validateTaskPlan(root, args) {
  if (args.rationale !== undefined && typeof args.rationale !== 'string') {
    throw planInvalid('rationale', '必须是字符串', '写一段为什么这样拆的说明，或删掉该字段')
  }
  const raw = args.tasks
  if (Array.isArray(raw) === false) {
    throw planInvalid('tasks', '必须是数组', `传 tasks:[{type,title,scope:{allow:[...]},acceptance:[...]}]，1..${MAX_PLAN_TASKS} 条`)
  }
  if (raw.length === 0 || raw.length > MAX_PLAN_TASKS) {
    throw planInvalid(
      'tasks',
      `必须是 1..${MAX_PLAN_TASKS} 条（当前 ${raw.length} 条）`,
      `把计划拆成 1..${MAX_PLAN_TASKS} 条主任务后重试`,
    )
  }
  const items = []
  for (const [index, item] of raw.entries()) {
    const at = `plan.tasks[${index}]`
    if (isPlainObject(item) === false) {
      throw planInvalid(at, '必须是对象', '每条写成 {type,title,scope:{allow:[...]},acceptance:[...]}')
    }
    for (const key of Object.keys(item)) {
      if (PLAN_ITEM_FIELDS.includes(key)) continue
      throw planInvalid(
        `${at}.${key}`,
        '不是 plan 支持的字段',
        `删掉 ${key}；每条只允许 ${PLAN_ITEM_FIELDS.join('/')}（parent 由插件统一置空）`,
      )
    }
    const type = typeof item.type === 'string' ? item.type.trim() : ''
    if (type === '' || PLAN_TYPE_ENUM.includes(type) === false) {
      throw planInvalid(
        `${at}.type`,
        `必须是 ${PLAN_TYPE_ENUM.join('|')} 之一（当前 ${JSON.stringify(item.type)}）`,
        '改成十种 conventional commit 类型之一',
      )
    }
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    if (title === '') throw planInvalid(`${at}.title`, '必须是非空字符串', '用一句能当标题也可当目标的话')
    if (isPlainObject(item.scope) === false) {
      throw planInvalid(`${at}.scope`, '必须是对象', '传 scope:{allow:["lib/x.mjs"]}（写域不能为空）')
    }
    for (const key of Object.keys(item.scope)) {
      if (key === 'allow' || key === 'deny') continue
      throw planInvalid(`${at}.scope.${key}`, '不是 plan 支持的字段', 'scope 只允许 allow/deny')
    }
    const allowRaw = item.scope.allow
    if (Array.isArray(allowRaw) === false || allowRaw.length === 0) {
      throw planInvalid(
        `${at}.scope.allow`,
        '必须是非空的字符串数组（写域不能为空）',
        '至少列出一条项目根内的相对路径，例如 lib/tools/tasks.mjs',
      )
    }
    const allow = []
    for (const [pathIndex, entry] of allowRaw.entries()) {
      const atPath = `${at}.scope.allow[${pathIndex}]`
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw planInvalid(atPath, '必须是非空字符串', '写成项目根内的相对路径')
      }
      const normalized = planScopePath(root, entry)
      if (normalized === null) {
        throw planInvalid(
          atPath,
          `“${entry}” 不在项目根 ${root} 内`,
          '改成项目根内的相对路径，不要用 .. 或根外绝对路径',
        )
      }
      allow.push(normalized)
    }
    const deny = []
    if (item.scope.deny !== undefined) {
      if (Array.isArray(item.scope.deny) === false) {
        throw planInvalid(`${at}.scope.deny`, '必须是字符串数组', '删掉 deny 或写成 ["path"]')
      }
      for (const [denyIndex, entry] of item.scope.deny.entries()) {
        const atPath = `${at}.scope.deny[${denyIndex}]`
        if (typeof entry !== 'string' || entry.trim() === '') {
          throw planInvalid(atPath, '必须是非空字符串', '写成项目根内的相对路径')
        }
        const normalized = planScopePath(root, entry)
        if (normalized === null) {
          throw planInvalid(atPath, `“${entry}” 不在项目根 ${root} 内`, '改成项目根内的相对路径')
        }
        deny.push(normalized)
      }
    }
    const acceptanceRaw = item.acceptance
    if (Array.isArray(acceptanceRaw) === false || acceptanceRaw.length === 0) {
      throw planInvalid(
        `${at}.acceptance`,
        '至少需要一条验收项',
        '写 cmd:<shell 命令> 或 gate:<gateId>（至少一条可执行项）',
      )
    }
    const acceptance = []
    let executable = 0
    for (const [acceptIndex, entry] of acceptanceRaw.entries()) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw planInvalid(`${at}.acceptance[${acceptIndex}]`, '必须是非空字符串', '每条验收写成字符串')
      }
      const text = entry.trim()
      if (text.startsWith('cmd:') || text.startsWith('gate:')) executable += 1
      acceptance.push(text)
    }
    if (executable === 0) {
      throw planInvalid(
        `${at}.acceptance`,
        '没有可执行项（至少一条以 cmd: 或 gate: 开头）',
        '把验收写成 cmd:<shell 命令> 或 gate:<gateId>',
      )
    }
    if (item.notes !== undefined && typeof item.notes !== 'string') {
      throw planInvalid(`${at}.notes`, '必须是字符串', '把任务书要点写成一段文字，或删掉该字段')
    }
    if (item.priority !== undefined && (typeof item.priority !== 'string' || item.priority.trim() === '')) {
      throw planInvalid(`${at}.priority`, '必须是非空字符串', '写 high/normal/low 之类的排序提示，或删掉该字段')
    }
    items.push({
      type,
      title,
      allow,
      deny,
      acceptance,
      notes: item.notes === undefined ? '' : item.notes.trim(),
      priority: item.priority === undefined ? undefined : item.priority.trim(),
    })
  }
  return { items, rationale: typeof args.rationale === 'string' ? args.rationale.trim() : '' }
}

/**
 * 重复判定：只与**未完成任务**（stage 不是 done/archived）比，规则只有两条，满
 * 足任一条即冲突：
 *   1. 标题归一后完全相同；
 *   2. `scope.allow` 归一后完全相同（顺序敏感的全等）。
 *
 * 为什么不用相似度（编辑距离/词向量）：相似度阈值不是事实，同一份计划在不同
 * 模型/不同措辞下会时过时不过；误判会挡住合法任务，漏判会建出两张同义卡，两者
 * 都无法解释。这两条规则是确定性的：同一输入永远得到同一结论，冲突能指出具体
 * 任务 id 与规则，测试也能白盒覆盖。
 *
 * @returns {Array<{id: string, rule: string, title: string}>} 去重后的冲突列表
 */
function openTaskConflicts(tasks, root, contract, items) {
  const records = tasks.listTasks(root, contract)
  const open = records.filter(
    (task) => isPlainObject(task) && task.stage !== 'done' && task.stage !== 'archived',
  )
  const conflicts = []
  const seen = new Set()
  for (const item of items) {
    const title = normalizedPlanTitle(item.title)
    for (const task of open) {
      const id = typeof task.id === 'string' ? task.id : ''
      const existingTitle = normalizedPlanTitle(task.title)
      const rules = []
      if (title !== '' && existingTitle === title) rules.push('标题相同')
      if (scopeAllowEqual(root, item.allow, task.scope)) rules.push('scope.allow 相同')
      for (const rule of rules) {
        const key = `${id}:${rule}`
        if (seen.has(key)) continue
        seen.add(key)
        conflicts.push({ id, rule, title: typeof task.title === 'string' ? task.title : '' })
      }
    }
  }
  return conflicts
}

/** `priority` 不是 core 的任务字段：落进 notes 第一行，信息不丢。 */
function planNotes(notes, priority) {
  const base = typeof notes === 'string' ? notes.trim() : ''
  if (priority === undefined) return base
  const tag = `优先级：${priority}`
  return base === '' ? tag : `${tag}\n${base}`
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
    output: toolOutput('flow_task'),
    isConcurrencySafe: false,
    timeoutMs: WRITE_TIMEOUT_MS,
    async execute(args, exec) {
      const root = toolRoot(ctx, args, exec)
      const action = args.action
      assertOnlyFields('flow_task', action, args, TASK_ACTION_ARG_FIELDS[action])
      if (action !== 'list') requireStore(root)

        const { contract } = backendContract.loadContract(root)
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
        const records = tasks.listTasks(root, contract)
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
        const task = tasks.getTask(root, contract, requireId('flow_task', action, args.id))
        /* `revision` 是**磁盘记录的签名**，与 update 的 CAS 同源；读投影本身不带它
           （getTask 不动），所以在这里补。调用方拿它做 CAS 时不必再猜。 */
        return { root, task: taskWithRevision(root, contract, task) }
      }
      if (action === 'add') {
        const input = pickFields(args, TASK_ADD_FIELDS)
        const task = tasks.addTask(root, contract, normalizeTaskParent(tasks, input))
        // 主会话建好主任务即派分析者（阶段入口不在 queued-* 时不派）。
        const dispatched = await autoDispatchAfterUpdate({ c: tasks, ctx, exec, root, contract, task, config })
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
        if (Object.hasOwn(patch, 'owner')) patch.owner = tasks.normalizeOwnerInput(patch.owner)
        const ownerOptions = {}
        const actorSession = sessionOfExec(exec)
        if (actorSession !== '') ownerOptions.actorSession = actorSession
        const isSessionLive = sessionLiveProbe(ctx)
        if (isSessionLive !== undefined) ownerOptions.isSessionLive = isSessionLive
        /* `conflict` 从这里原样上抛（code=conflict，消息已带「重新 show」指引）：
           工具层不重试、不覆盖——那正是本卡要堵的竞态。 */
        const writeOptions = expectedRevision === '' ? ownerOptions : { ...ownerOptions, expectedRevision }
        const before = tasks.getTask(root, contract, id)
        const updated = tasks.updateTask(root, contract, id, normalizeTaskParent(tasks, patch), writeOptions)
        /* 只有「这次 update 真的把 stage 换成了 queued-*」才自动派工：对已经停在
           queued-analysis 的任务改 notes/owner 不能又起一个 worker（否则一个 update 重试
           就多派一次）。显式 dispatch 动作不受这条限制。 */
        const stageEntered = updated.stage !== before.stage && typeof patch.stage === 'string'
        const automatic = stageEntered
          ? await autoDispatchAfterUpdate({ c: tasks, ctx, exec, root, contract, task: updated, config })
          : null
        const finalTask = automatic === null ? updated : automatic.task
        /* 子任务刚进入终态：若父任务的子任务已全部完成，聚合到 queued-review 并派审查者。 */
        if (automatic === null && (finalTask.stage === 'done' || finalTask.stage === 'archived')) {
          const settled = await settleParentAfterChild({ c: tasks, ctx, exec, root, contract, task: finalTask, config })
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
        return { root, ...tasks.removeTask(root, contract, id) }
      }
      /* P3b（D-20261109-01）：主会话不直接调度，改为让插件派角色子代理。
         顺序：先起子代理拿 childId，再写回执并走 plugin 边到 working 阶段——
         写台账失败时子代理已经在跑，所以错误文案必须带上 childId 与补救步骤。 */
      if (action === 'dispatch') {
        const id = requireId('flow_task', action, args.id)
        if (dispatchEnabled(config) === false) {
          throw new Error('flow_task dispatch 已被禁用（config.dispatch.enabled=false）；请人工处理该任务')
        }
        const task = tasks.getTask(root, contract, id)
        const result = await dispatchOnce({ c: tasks, ctx, exec, root, contract, task, config })
        return { root, task: result.task, dispatch: result.dispatch }
      }
      throw new Error(`unknown flow_task action: ${String(action)}`)
    },
  }
}
