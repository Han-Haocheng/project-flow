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
import { NEXT_TERMINAL_STAGES, STAGE_ZH } from './stage.mjs'

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

/**
 * 父任务的「汇总轮」标记（`flow_subtask` 聚合时写进父任务 `dispatchRound`，
 * T-20261111170544）。
 *
 * 它解决的是「汇总轮派不出来」这个死结，而不是角色问题：汇总轮仍是分析者。
 * 派工的幂等回执只认 `from`，首轮分析者已经留下 `from: 'queued-analysis'` 的回执，
 * 父任务被聚合回 queued-analysis 后最后一次派工若还按同一个 `from` 记账，就会被判成
 * `reused` —— 汇总轮永远起不来（修复前的实际卡点）。带这个标记的派工因此改走
 * `queued-analysis → analyzing` 的 `normalizeTask` 边、回执记 `from: AGGREGATE_ROUND`，
 * 两轮在台账里天然分开。
 */
export const AGGREGATE_ROUND = 'aggregate'


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
  /* 汇总轮（T-20261111170544）：同样是 queued-analysis → 分析者，但走
     `normalizeTask` 直接落到 `analyzing`（插件边，见 lib/stage.mjs），不再经过
     `queued-analysis → analyzing` 那条 session 边。 */
  if (role === 'analyzer' && isAggregateRound(task)) {
    return { ok: true, role, workingStage: 'analyzing', via: 'normalizeTask', round: AGGREGATE_ROUND }
  }
  /* 2026-11-11 用户流程：子任务由分析者拆分后**各自派工**（实现者/审查者分别起），
     不再「跟随父任务」。父任务是协调者，子任务完成由父子聚合回收到父任务。
     写域互斥靠任务的 `scope`（分析者拆任务时必须写清），见 dispatchPrompt 的写域段。 */
  return { ok: true, role, workingStage: WORKING_STAGE[stage] }
}

/** 记录是否处于汇总轮（`dispatchRound === AGGREGATE_ROUND`）。 */
export function isAggregateRound(task) {
  return isPlainObject(task) && typeof task.dispatchRound === 'string' && task.dispatchRound.trim() === AGGREGATE_ROUND
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
    '把手上的工作拆成可独立实现的子任务：每个子任务用 flow_subtask add 创建（parent=当前任务 id、',
    'stage=queued-implementation、标题/acceptance/写域写清）。插件会自动为每个子任务派实现者。',
    '不要自己改代码、不要把主任务推进到 implementing：子任务全部完成后插件会聚合父任务',
    '并重新派你进来做「汇总轮」。',
    '首轮完成后 send_message 报告：任务书摘要 + 拆出的子任务 id 列表。',
    '',
    '汇总轮（先判断，再动手）：如果任务 notes 里有 `[auto] 子任务 N 条全部完成` 标记，或',
    'flow_subtask list 显示子任务已全部 done/archived，**不要新建子任务、不要拆任务**：',
    '1) 逐个核对子任务的审查结论与证据（flow_task show 每个子任务：notes 里的审查结论、',
    '   verification 回执、commits；证据缺失或结论存疑就把它写进汇总并说明，不要替它判定通过）；',
    '2) 把汇总写进父任务 notes（子任务清单 + 各自证据 + 遗留问题/后续卡）；',
    '3) 把父任务 stage 推进到 done：flow_task update {id, stage: "done"}。这一步有两道门——',
    '   描述门对汇总轮豁免；验收门**照常**判定：父任务有可执行验收（cmd:/gate:）却没跑过',
    '   或没通过时会被拒（tasks.requireAcceptance=warn 时只留一条 warning 放行），',
    '   被拒时先跑 flow task verify <父任务id> 再重试；',
    '4) send_message 给 lead（父会话）报告：完成情况 + 子任务清单 + 证据 + 遗留问题。',
    '汇总轮以 done 收口是**正常终点**：不要为了"看起来有下一步"而再拆出子任务。',
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

/** 阶段的中文名（没有条目时原样回显，不产生 `undefined` 文案）。 */
function stageZh(stage) {
  const key = typeof stage === 'string' ? stage.trim() : ''
  if (key === '') return '未知'
  return STAGE_ZH[key] ?? key
}

/**
 * 派工前/写回执前的**重读**（2026-11-11 T-20261111182128）：把调用方手里那份快照
 * 换成台账上的最新记录。
 *
 * 为什么必须重读：`dispatchPlan` 只看手里的 `task.stage`，而快照从 `listTasks`/
 * 上一次 update 到这里已经隔了几轮异步（`startActivation` 不是同步的）。这中间
 * 子进程或另一个会话完全可能把卡片推进到 `done`——实测窗口约 3 秒——拿旧快照派工
 * 就会给已完成的卡再起一个 reviewer/implementer。
 *
 * @returns 最新记录；core 没提供 `getTask` 时返回 `null`（调用方回落旧快照）
 */
function rereadTask(c, root, contract, id) {
  if (c === null || c === undefined || typeof c.getTask !== 'function') return null
  return c.getTask(root, contract, id)
}

/**
 * 读当前 revision（`updateTask` 的 CAS 参数）。没有 CAS 能力时返回 `''`，表示
 * 「不启用 CAS」——退化为只比对阶段，不因缺能力而拒绝派工。
 *
 * 能力探测：`c.taskRevisionOf`（正确签名：整条磁盘记录）→ `c.taskRevision(c.getTask(...))`
 * （读投影签名，仅用于「我读过之后有没有人改过」的比对，同样能识别并发写）→ `''`。
 */
function revisionOf(c, root, contract, id) {
  if (c === null || c === undefined) return ''
  try {
    if (typeof c.taskRevisionOf === 'function') {
      const value = c.taskRevisionOf(root, contract, id)
      return typeof value === 'string' ? value : ''
    }
    if (typeof c.taskRevision === 'function' && typeof c.getTask === 'function') {
      const value = c.taskRevision(c.getTask(root, contract, id))
      return typeof value === 'string' ? value : ''
    }
  } catch {
    return ''
  }
  return ''
}

/**
 * 写回执前再校验一次（T-20261111182128 闸 3a）：最新记录的 stage 必须仍是指望的
 * 入口阶段。不满足就抛 `conflict`（与仓库既有并发冲突语义一致），并说明推进到了哪里。
 */
function revalidateStage(c, root, contract, id, expectedStage) {
  const latest = rereadTask(c, root, contract, id)
  if (latest === null || latest === undefined) return
  const now = typeof latest.stage === 'string' ? latest.stage : ''
  if (now === expectedStage) return
  throw new FlowError(
    'conflict',
    `放弃本次派工的台账写入：任务 ${id} 的 stage 已从 ${expectedStage === '' ? '?' : expectedStage}` +
      ` 变为 ${now === '' ? '未知' : now}（并发推进），不回滚他人的写入`,
  )
}

/**
 * 同一入口阶段的既有派工回执（幂等去重用）：`checkpoints` 里 `kind:'dispatch'`、
 * `from` 等于该入口阶段、且没有 `failed` 标记的那一条。
 *
 * 只认 `from`：回执里的 `from` 是**入口阶段**而不是角色；退回（`reviewing →
 * queued-implementation`）换来的是另一个 `from`，所以「同 from 已有回执」可以安全地
 * 当成「这个入口已经派过了」。`failed: true` 是「这次没派成」的显式标记，带上它才
 * 允许重派。
 */
export function priorDispatch(task, from) {
  const stage = typeof from === 'string' ? from : ''
  if (isPlainObject(task) === false || Array.isArray(task.checkpoints) === false) return null
  for (let index = task.checkpoints.length - 1; index >= 0; index -= 1) {
    const item = task.checkpoints[index]
    if (isPlainObject(item) === false) continue
    if (item.kind !== 'dispatch') continue
    if ((typeof item.from === 'string' ? item.from : '') !== stage) continue
    if (item.failed === true) continue
    return item
  }
  return null
}

/**
 * 派工一条任务记录（可复用的完整写回路径，2026-11-11）：起子代理 → 追加 checkpoint
 * → 用 plugin 边把任务推进到 working 阶段。`lib/tools/tasks.mjs` 的 `dispatchOnce`
 * 与宿主侧的"捕获即派工"共用这一条，避免两套语义。
 *
 * 竞态窗口（T-20261111182128）在这里收口，三道闸顺序执行：
 * 1. **派工前重读**：用 `c.getTask` 拿最新记录，按最新 `stage` 重新 `dispatchPlan`；
 *    最新阶段已不是排队入口（例如已被别人推到 `done`）→ `conflict`，不起子代理；
 * 2. **幂等**：最新 `checkpoints` 里同一 `from` 已有未失败的回执 → 直接返回它，
 *    不再起第二个子代理（汇总轮的 `from` 是 `AGGREGATE_ROUND`，与首轮分开计）；
 * 3. **写回执前 CAS**：`updateTask` 带 `expectedRevision`（起子代理前读到的记录签名），
 *    任何人在这中间改过记录都会在锁内被拒——别人的写入不被覆盖。
 */
export async function dispatchTaskRecord({ c, ctx, agent, root, contract, task, provider, signal }) {
  const snapshot = dispatchPlan(task)
  if (snapshot.ok === false) throw new FlowError('usage', snapshot.reason)
  const id = task.id
  const entryStage = typeof task.stage === 'string' ? task.stage.trim() : ''

  /* 闸 1：派工前重读。手里的是旧快照，台账才是真源。 */
  const fresh = rereadTask(c, root, contract, id)
  const plan = dispatchPlan(fresh !== null && fresh !== undefined ? fresh : task)
  if (plan.ok === false) {
    const now = fresh !== null && fresh !== undefined && typeof fresh.stage === 'string' ? fresh.stage : task.stage
    throw new FlowError(
      'conflict',
      `派工放弃：任务 ${id} 已被推进到「${stageZh(now)}」，不再是待派工入口（期望入口「${stageZh(entryStage)}」）；` +
        `不再起${ROLE_ZH[snapshot.role] ?? snapshot.role}子代理，用 flow_task show ${id} 核对最新状态`,
    )
  }
  /* 重读后阶段换了入口（例如退回成另一个 queued-*）：角色随最新阶段走，不按旧快照派错人。 */
  const record = fresh !== null && fresh !== undefined ? fresh : task
  const from = typeof record.stage === 'string' ? record.stage.trim() : entryStage
  const role = plan.role
  const workingStage = plan.workingStage

  /* 闸 2：同一入口阶段已有未失败的回执 → 已经派过，直接返还，不再起子代理。
     汇总轮例外（T-20261111170544）：首轮分析者留下的 `from: 'queued-analysis'` 回执
     属于**上一轮**，汇总轮必须照样派一次；它自己的幂等改由 `from: 'aggregate'` 认
     （见下），所以这里只认汇总轮自己的账。 */
  const round = plan.round === AGGREGATE_ROUND ? AGGREGATE_ROUND : ''
  const existing = priorDispatch(record, round === AGGREGATE_ROUND ? AGGREGATE_ROUND : from)
  if (existing !== null) {
    return { task: record, dispatch: { ...existing, role, reused: true }, reused: true }
  }

  /* 起子代理之前先把 revision 固定下来：这是闸 3 的 CAS 基准。 */
  const expectedRevision = revisionOf(c, root, contract, id)

  const started = await dispatchTask({ ctx, agent, task: record, root, provider, signal })
  const checkpoints = Array.isArray(record.checkpoints) ? record.checkpoints.slice() : []
  checkpoints.push(
    dispatchCheckpoint({
      childId: started.childId,
      role,
      provider: started.provider,
      // 汇总轮回执记 `from: 'aggregate'`：走的是 queued-analysis→analyzing 的
      // `normalizeTask` 边（plugin actor），与首轮那条 `from: 'queued-analysis'` 的回执
      // 天然分开，闸 2 的两轮幂等互不干扰。
      from: round === AGGREGATE_ROUND ? AGGREGATE_ROUND : from,
      to: workingStage,
    }),
  )
  let updated
  try {
    /* 闸 3：写回执前再校验。先按最新记录确认 stage 仍是入口阶段；若已不是，
       直接拒绝——不覆盖他人写入。 */
    if (round !== AGGREGATE_ROUND) revalidateStage(c, root, contract, id, from)
    /* `expectedRevision` 在 store 锁内比对整条记录签名（CAS）：起子代理期间任何人
       改过记录（notes/checkpoints/stage）都会被拒。两项任一失败都抛 conflict。 */
    updated = c.updateTask(
      root,
      contract,
      id,
      { checkpoints, stage: workingStage },
      {
        source: 'plugin',
        ...(expectedRevision === '' ? {} : { expectedRevision }),
      },
    )
  } catch (error) {
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
    let current = null
    try {
      current = rereadTask(c, root, contract, id)
    } catch {
      current = null
    }
    const now = current !== null && current !== undefined && typeof current.stage === 'string' ? current.stage : ''
    const advance = now === '' || now === from ? '' : `任务已被推进到「${stageZh(now)}」，`
    throw new FlowError(
      'conflict',
      `派工冲突：子代理 ${started.childId} 已启动，但${advance}放弃本次派工的台账写入，未覆盖他人的改动` +
        `（${message}）；用 flow_task show ${id} 核对最新状态`,
    )
  }
  return {
    task: updated,
    dispatch: {
      childId: started.childId,
      role,
      provider: started.provider,
      from,
      to: workingStage,
    },
  }
}

/**
 * 阶段入口自动派工（共享实现，2026-11-11）：任务处于 queued-* 时按角色起子代理，
 * 失败返回 `{dispatch:{ok:false,error}}` 而不是抛出（台账已写成功，调用方决定重试）。
 *
 * T-20261111182128：派工前重读发现任务已不在入口阶段时，结果里带 `ok:false` +
 * `code:'conflict'` + 原因（「已被推进到 X」），调用方/日志能看出「这张卡没派」，
 * 而不是把它当成派过了。
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
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
    return { task, dispatch: { auto: true, ok: false, code, error: message } }
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
