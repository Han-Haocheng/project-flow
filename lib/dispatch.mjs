// project-flow — P3b 派工核心：任务阶段 → 角色子代理 → 回执。
//
// 背景（2026-11-09 用户裁决 D-20261109-01 = implement-p3b）：
// P2 权限面对主会话禁用 spawn_teammate / subagent / subagent_fork，拒绝文案写
// 「插件会派工」——但派工器一直不存在，于是拦住主会话之后没人接住。本模块就是
// 那个接住的地方：主会话不再直接调度，改为显式请求插件派工（`flow_task` 的
// `dispatch` 动作），由插件用宿主 `subagents` 服务起一个角色子代理。
//
// 分工（单一真源是 `lib/stage.mjs` 的边表，这里只做映射，不再抄一份阶段规则）：
// - 插件推进 queued-* → working（plugin 边）；
// - 子代理以「会话/审查者」身份做实际工作并推进 working → 下一个 queued 阶段；
// - 回执写进任务的 `checkpoints`（`{kind:'dispatch', role, childId, ...}`），
//   面板/CLI 读同一份台账，不需要第二个登记处。
//
// 本模块只做「决定派谁 + 拼提示词 + 取服务」，真正的 startActivation 调用集中在
// `dispatchTask` 一处，纯函数（plan/prompt/checkpoint）可以单测；宿主服务缺失是
// 一种可报告的状态，不是崩溃。

import { FlowError, isPlainObject } from './util.mjs'
import { STAGE_ZH } from './stage.mjs'

/** 宿主子代理服务名（`@deepseek-ai/dsh-subagent` 注册的 Service）。 */
export const SUBAGENT_SERVICE = 'subagents'

/** 默认 provider：`@deepseek-ai/dsh-subagent-spawn-in-process` 注册的 `spawn`。 */
export const DEFAULT_PROVIDER = 'spawn'

/**
 * 可派工阶段 → 角色。只列 queued-*（插件边进入 working 的入口）；working 阶段
 * 由子代理自己推进，再派一次会产生第二个 worker。
 */
export const DISPATCH_ROLES = Object.freeze({
  'queued-analysis': 'analyzer',
  'queued-implementation': 'implementer',
  'queued-review': 'reviewer',
})

/** 派工后插件走的那条边（queued-* → working），与 `lib/stage.mjs` 的边表同值。 */
export const WORKING_STAGE = Object.freeze({
  'queued-analysis': 'analyzing',
  'queued-implementation': 'implementing',
  'queued-review': 'reviewing',
})

/** 角色的中文名（提示词与回执共用，避免两处措辞）。 */
export const ROLE_ZH = Object.freeze({
  analyzer: '分析',
  implementer: '实现',
  reviewer: '审查',
})

/** 一个任务能否/该不该派工：`{ok, reason?, role?, workingStage?}`。 */
export function dispatchPlan(task) {
  if (isPlainObject(task) === false) return { ok: false, reason: '任务记录不可读' }
  const id = typeof task.id === 'string' ? task.id.trim() : ''
  if (id === '') return { ok: false, reason: '任务没有 id' }
  const stage = typeof task.stage === 'string' ? task.stage.trim() : ''
  const role = DISPATCH_ROLES[stage]
  if (role === undefined) {
    const zh = STAGE_ZH[stage] ?? stage ?? '未知'
    return { ok: false, reason: `任务 ${id} 当前阶段是「${zh}」；只有待分析/待实现/待审查可以派工` }
  }
  /* 2026-11-11 用户流程：子任务由分析者拆分后**各自派工**（实现者/审查者分别起），
     不再「跟随父任务」。父任务是协调者，子任务完成由父子聚合回收到父任务。
     写域互斥靠任务的 `scope`（分析者拆任务时必须写清），见 dispatchPrompt 的写域段。 */
  return { ok: true, role, workingStage: WORKING_STAGE[stage] }
}

/** 该阶段是否是派工入口（面板/CLI 判断用）。 */
export function isDispatchStage(stage) {
  return typeof stage === 'string' && Object.hasOwn(DISPATCH_ROLES, stage)
}

/** `config.dispatch` 开关：默认开（只有显式 dispatch 动作才会真派）。 */
export function dispatchEnabled(config) {
  if (isPlainObject(config) === false) return true
  const section = config.dispatch
  if (isPlainObject(section) && section.enabled === false) return false
  if (section === false) return false
  return true
}

/**
 * `config.dispatch.auto`：阶段入口自动派工（2026-11-09 第二批）。
 * 默认开；`false` 时只有显式 `flow_task dispatch` 才派。与 `enabled` 的关系是
 * 与：`enabled:false` 连显式派工都关，`auto:false` 只关自动那半。
 */
export function autoDispatchEnabled(config) {
  if (dispatchEnabled(config) === false) return false
  if (isPlainObject(config) === false) return true
  const section = config.dispatch
  if (isPlainObject(section) && section.auto === false) return false
  return true
}

/** `config.dispatch.provider`，只接受非空字符串，否则回落 `spawn`。 */
export function dispatchProvider(config) {
  if (isPlainObject(config) === false) return DEFAULT_PROVIDER
  const section = config.dispatch
  if (isPlainObject(section) === false) return DEFAULT_PROVIDER
  const value = typeof section.provider === 'string' ? section.provider.trim() : ''
  return value === '' ? DEFAULT_PROVIDER : value
}

/** 一段文本的短摘要（`notes` 可能几千字，提示词只带开头）。 */
function clip(value, limit) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** 数组字段 → 逐行；非数组/空数组返回空串。 */
function linesOf(value) {
  if (Array.isArray(value) === false) return ''
  const items = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  return items.map((item) => `- ${item}`).join('\n')
}

const ROLE_DUTIES = Object.freeze({
  analyzer: [
    '读相关源码与台账，产出任务书：目标 / 方案 / 分步计划 / 风险 / 验收标准 / 写域，写进任务 notes。',
    '把任务拆成可独立实现的子任务：每个子任务用 flow_subtask add 创建（parent=当前任务 id、',
    'stage=queued-implementation、标题/acceptance/写域写清）。插件会自动为每个子任务派实现者。',
    '不要自己改代码、不要把主任务推进到 implementing：子任务全部完成后插件会聚合父任务',
    '到 queued-review 并自动派审查者。',
    '完成后 send_message 报告：任务书摘要 + 拆出的子任务 id 列表。',
    '汇总轮：如果本任务已有子任务且全部终态（notes 里会有 [auto] 标记），不要新建子任务；',
    '核对每个子任务的审查结论与证据，把汇总写进 notes，把 stage 推进到 done，并',
    'send_message 给 lead（父会话）报告：完成情况 + 子任务清单 + 证据。',
  ].join('\n'),
  implementer: [
    '按任务书实现改动，只动任务写域内的文件；提交用 pathspec，保持每笔提交单一模块。',
    '跑相关测试与 node bin/flow.mjs gate run precommit，把真实输出留作证据。',
    '完成后把 stage 推进到 queued-review，并把提交 sha 写回任务的 commits 字段。',
  ].join('\n'),
  reviewer: [
    '独立审查：正确性 / 边界条件 / 测试覆盖 / 文档同步 / 模块边界五条清单。',
    '通过：把 stage 推进到 done，并在 notes 写审查结论。',
    '不通过：把 stage 退回 queued-implementation，在 notes 写清必须改什么（不要直接改代码）。',
  ].join('\n'),
})

/**
 * 拼一个角色子代理的提示词。
 *
 * 提示词是「可独立看懂」的交接书：子代理没有父会话上下文（spawn provider 是零
 * 上下文），仓库路径、任务阶段、写域、纪律都必须自带。
 */
export function dispatchPrompt(task, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const plan = dispatchPlan(task)
  const role = plan.ok ? plan.role : ''
  const root = typeof input.root === 'string' ? input.root : ''
  const id = task !== null && typeof task.id === 'string' ? task.id : '?'
  const title = task !== null && typeof task.title === 'string' ? task.title : ''
  const type = task !== null && typeof task.type === 'string' ? task.type : '未标注'
  const stage = task !== null && typeof task.stage === 'string' ? task.stage : ''
  const scope = task !== null && isPlainObject(task.scope) ? task.scope : {}
  const allow = linesOf(scope.allow)
  const deny = linesOf(scope.deny)
  const acceptance = linesOf(task !== null ? task.acceptance : '')
  const notes = clip(task !== null ? task.notes : '', 1200)
  const nextStageZh = STAGE_ZH[plan.workingStage] ?? plan.workingStage ?? '下一阶段'

  const header = role === ''
    ? `项目流台账任务 ${id}（${title}）当前不可派工：${plan.reason}`
    : `你是项目流插件派出的${ROLE_ZH[role]}子代理，负责台账任务 ${id}「${title}」。`

  const body = [
    header,
    '',
    `仓库根：${root === '' ? '（未提供，按当前工作目录）' : root}`,
    `当前阶段：${STAGE_ZH[stage] ?? stage}（由你推进到 ${nextStageZh} 之后的下一个阶段）`,
    `任务类型：${type}`,
    '',
    '验收标准：',
    acceptance === '' ? '- 任务没写验收标准；按标题、notes 与仓库既有约定自行判定，并把判定写进 notes。' : acceptance,
    allow === '' ? '\n写域：任务未限定（默认只改与本任务直接相关的文件）' : `\n写域：\n${allow}`,
    deny === '' ? '' : `\n禁区：\n${deny}`,
    notes === '' ? '' : `\n任务 notes 摘要：\n${notes}`,
    '',
    `职责（${ROLE_ZH[role] ?? '派工'}）：`,
    role === '' ? '- 无法派工，请把原因报告给父会话。' : ROLE_DUTIES[role],
    '',
    '纪律：',
    '- 用 flow_task 的 update 动作推进 stage；你是子代理，不受主会话团队工具限制。',
    '- 只做本地提交，不要 git push；共享构建（pnpm/产物）由父会话统一跑。',
    '- 卡住不要硬闯：把阻塞原因写进任务 notes 并报告。',
    '- 完成后用 send_message 向父会话报告：任务 id、结果、证据（测试/门禁原始输出摘要）、下一步。',
  ]
  return body.filter((line) => line !== '').join('\n')
}

/**
 * 一条派工回执（写进任务 `checkpoints`；`checkpoints` 是 core 的系统键，
 * 只允许对象/字符串，这里全部是短字段）。
 */
export function dispatchCheckpoint(input) {
  const value = isPlainObject(input) ? input : {}
  const childId = typeof value.childId === 'string' ? value.childId.trim() : ''
  if (childId === '') throw invalidDispatch('派工回执缺少 childId')
  const role = typeof value.role === 'string' ? value.role.trim() : ''
  if (role === '') throw invalidDispatch('派工回执缺少 role')
  return {
    kind: 'dispatch',
    role,
    childId,
    provider: typeof value.provider === 'string' ? value.provider : '',
    from: typeof value.from === 'string' ? value.from : '',
    to: typeof value.to === 'string' ? value.to : '',
    at: typeof value.at === 'string' && value.at.trim() !== '' ? value.at.trim() : new Date().toISOString(),
  }
}

function invalidDispatch(message) {
  return new FlowError('invalid', message)
}

/** 宿主是否具备派工所需的 subagents 服务（没有就静默跳过自动派工）。 */
export function hasSubagentService(ctx) {
  try {
    return typeof subagentServiceOf(ctx)?.startActivation === 'function'
  } catch {
    return false
  }
}

/**
 * 派工一条任务记录（可复用的完整写回路径，2026-11-11）：起子代理 → 追加 checkpoint
 * → 用 plugin 边把任务推进到 working 阶段。`lib/tools/tasks.mjs` 的 `dispatchOnce`
 * 与宿主侧的"捕获即派工"共用这一条，避免两套语义。
 */
export async function dispatchTaskRecord({ c, ctx, agent, root, contract, task, provider, signal }) {
  const plan = dispatchPlan(task)
  if (plan.ok === false) throw new FlowError('usage', plan.reason)
  const started = await dispatchTask({ ctx, agent, task, root, provider, signal })
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
    throw new FlowError(
      'conflict',
      `子代理 ${started.childId} 已启动，但台账推进失败：${message}；用 flow_task show ${task.id} 核对后用 update 补 stage=${plan.workingStage}`,
    )
  }
  return {
    task: updated,
    dispatch: {
      childId: started.childId,
      role: plan.role,
      provider: started.provider,
      from: task.stage,
      to: plan.workingStage,
    },
  }
}

/**
 * 阶段入口自动派工（共享实现，2026-11-11）：任务处于 queued-* 时按角色起子代理，
 * 失败返回 `{dispatch:{ok:false,error}}` 而不是抛出（台账已写成功，调用方决定重试）。
 */
export async function autoDispatchTask({ c, ctx, agent, root, contract, task, config, signal }) {
  if (autoDispatchEnabled(config) === false) return null
  if (dispatchPlan(task).ok === false) return null
  try {
    const result = await dispatchTaskRecord({
      c, ctx, agent, root, contract, task,
      provider: dispatchProvider(config),
      signal,
    })
    return { task: result.task, dispatch: { ...result.dispatch, auto: true } }
  } catch (error) {
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
    return { task, dispatch: { auto: true, ok: false, error: message } }
  }
}

/**
 * 从宿主 ctx 取子代理服务：`ctx.get('subagents')` 或 `ctx.subagents`。
 * 缺失是正常状态（TUI/headless 没有该服务），返回 `null` 由调用方给可执行文案。
 */
export function subagentServiceOf(ctx) {
  if (ctx === null || ctx === undefined) return null
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(SUBAGENT_SERVICE) : undefined
    if (viaGet !== undefined && viaGet !== null) return viaGet
    const direct = ctx[SUBAGENT_SERVICE]
    return direct === undefined || direct === null ? null : direct
  } catch {
    return null
  }
}

/**
 * 真正起一个角色子代理。
 *
 * @param deps `{ctx, agent, task, root, provider?, signal?}`
 * @returns `{childId, provider}`；服务缺失/调用失败都转成带下一步的 FlowError。
 */
export async function dispatchTask(deps) {
  const input = isPlainObject(deps) ? deps : {}
  const task = input.task
  const plan = dispatchPlan(task)
  if (plan.ok === false) throw invalidDispatch(plan.reason)
  const agent = input.agent
  if (agent === null || agent === undefined || typeof agent !== 'object') {
    throw new FlowError('usage', '派工需要活着的调用会话（exec.agent 缺失）：请从主会话的工具调用触发')
  }
  const service = subagentServiceOf(input.ctx)
  if (service === null || typeof service.startActivation !== 'function') {
    throw new FlowError(
      'usage',
      `宿主没有 subagents 服务，无法派工；在缺少该服务的宿主（TUI/headless）里请改为手工处理任务 ${task.id}`,
    )
  }
  const provider = typeof input.provider === 'string' && input.provider.trim() !== '' ? input.provider.trim() : DEFAULT_PROVIDER
  const root = typeof input.root === 'string' ? input.root : ''
  const prompt = dispatchPrompt(task, { root })
  const request = {
    ...(root === '' ? {} : { cwd: root }),
    prompt: [{ type: 'text', text: prompt }],
    parent: agent,
  }
  let activation
  try {
    activation = await service.startActivation({
      provider,
      label: `${task.id} ${ROLE_ZH[plan.role] ?? plan.role}`,
      request,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      delivery: 'parent',
    })
  } catch (error) {
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
    throw new FlowError('conflict', `派工失败（provider=${provider}）：${message}`)
  }
  const childId = activation !== null && typeof activation === 'object' && typeof activation.childId === 'string' ? activation.childId : ''
  if (childId === '') throw new FlowError('conflict', `派工失败（provider=${provider}）：宿主没有返回 childId`)
  return { childId, provider }
}
