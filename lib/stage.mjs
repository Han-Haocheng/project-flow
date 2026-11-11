/**
 * Task stage machine — the nine stages a task moves through, and nothing else.
 *
 * Scope (P0, task-60): **data only**. This module declares the stages, the legal
 * edges, who is expected to advance a task and how a stage maps onto the legacy
 * `status` view. It does not capture, guard, dispatch or write anything; the
 * plugin's behaviour is unchanged until a later card opts in.
 *
 * `status` (draft/active/done/archived) stays the compatibility view: it feeds
 * the panel queues, the archive sweep and the heartbeat claim rules. `stage` is
 * the behaviour layer. A task carries at most one `stage`; legacy records that
 * do not have one are projected as {@link DEFAULT_STAGE} **without a disk write**
 * (the ledger backfill is a separate, explicit CLI step).
 *
 * Single source of truth: every caller (`lib/tasks/records.mjs` 的投影与门禁、
 * `bin/flow.mjs` 的 next/help) imports the ids/derivation from here; nothing else
 * in the repo may restate this table.
 */
import { invalid } from './util.mjs'

/** Stage a task is in when its record predates the field. */
export const DEFAULT_STAGE = 'created'

/**
 * The nine stage ids, in workflow order. English ids (stable, code-facing);
 * the Chinese display names live in {@link STAGE_ZH}.
 */
export const STAGE_IDS = Object.freeze([
  'created',
  'queued-analysis',
  'analyzing',
  'queued-implementation',
  'implementing',
  'queued-review',
  'reviewing',
  'done',
  'archived',
])

/** Display names, keyed by stage id (single copy; no second table elsewhere). */
export const STAGE_ZH = Object.freeze({
  created: '已创建',
  'queued-analysis': '待分析',
  analyzing: '分析中',
  'queued-implementation': '待实现',
  implementing: '实现中',
  'queued-review': '待审查',
  reviewing: '审查中',
  done: '已完成',
  archived: '已归档',
})

/**
 * Who is expected to advance a task **out of** the stage (declared, not enforced
 * in P0): `plugin` = the plugin itself, `session` = the working agent session,
 * `reviewer` = the independent reviewer.
 */

/**
 * The machine. `from` lists the predecessor stages (derived from `next`, kept
 * explicit so a reader sees the back edge); `next` lists the legal edges, each
 * with **its own actor**; `terminal` marks a stage with no outgoing edge.
 *
 * Two actor levels, on purpose:
 * - `STAGE_MACHINE[x].actor` — the stage's **default** advancer: who is
 *   expected to move a task out of `x`;
 * - `edge.actor` — who may walk **this specific edge**. They are equal today
 *   (a test enforces it), but the edge level exists because a judgement edge
 *   and an "undo" edge out of the same stage may not share a caller. Giving a
 *   single edge a different actor is an explicit decision (`actorOverride`),
 *   so the invariant test tells you when the stage-level actor must follow.
 *
 * The **only** backward edge in the workflow is `reviewing → queued-implementation`
 * (review sends the work back for changes) and it is the only edge marked
 * `back: true`. `reviewing → done` is the approval path; the two successors of
 * `reviewing` look alike in the stage table but differ here.
 */
export const STAGE_MACHINE = Object.freeze({
  created: Object.freeze({
    zh: STAGE_ZH.created,
    from: Object.freeze([]),
    next: Object.freeze([
      Object.freeze({ to: 'queued-analysis', actor: 'plugin' }),
    ]),
    actor: 'plugin',
  }),
  'queued-analysis': Object.freeze({
    zh: STAGE_ZH['queued-analysis'],
    from: Object.freeze(['created']),
    /* 两条出边。`normalizeTask` 是**汇总轮**入口（T-20261111170544）：子任务全部完成后
       父任务被聚合回待分析，分析者直接从待分析落到分析中，靠一个显式 marker 而不是
       「queued-analysis → analyzing 的那条 session 边」进入汇总轮——派工的幂等回执认
       `from`，复用同一条边会让汇总轮被判成"已派过"。同一目标的两条边因此必须靠
       `key` 区分，actor 同为插件（这一步是插件的阶段规整，不是人的判定）。 */
    next: Object.freeze([
      Object.freeze({ to: 'analyzing', actor: 'plugin' }),
      Object.freeze({ to: 'analyzing', actor: 'plugin', key: 'normalizeTask' }),
    ]),
    actor: 'plugin',
  }),
  analyzing: Object.freeze({
    zh: STAGE_ZH.analyzing,
    from: Object.freeze(['queued-analysis']),
    /* 两条出边：拆任务（→ queued-implementation，主推荐）与**汇总收口**
       （→ done，T-20261111170544）。汇总轮的判定者是分析者本人，与拆任务同一个
       调用者（session），因此边级 actor 与阶段默认 actor 一致，不需要 actorOverride。 */
    next: Object.freeze([
      Object.freeze({ to: 'queued-implementation', actor: 'session' }),
      Object.freeze({ to: 'done', actor: 'session' }),
    ]),
    actor: 'session',
  }),
  'queued-implementation': Object.freeze({
    zh: STAGE_ZH['queued-implementation'],
    from: Object.freeze(['analyzing', 'reviewing']),
    next: Object.freeze([
      Object.freeze({ to: 'implementing', actor: 'plugin' }),
    ]),
    actor: 'plugin',
  }),
  implementing: Object.freeze({
    zh: STAGE_ZH.implementing,
    from: Object.freeze(['queued-implementation']),
    next: Object.freeze([
      Object.freeze({ to: 'queued-review', actor: 'session' }),
    ]),
    actor: 'session',
  }),
  'queued-review': Object.freeze({
    zh: STAGE_ZH['queued-review'],
    from: Object.freeze(['implementing']),
    next: Object.freeze([
      Object.freeze({ to: 'reviewing', actor: 'plugin' }),
    ]),
    actor: 'plugin',
  }),
  reviewing: Object.freeze({
    zh: STAGE_ZH.reviewing,
    from: Object.freeze(['queued-review']),
    // Judgement ("approved" → done) or "send it back" (→ queued-implementation).
    // Both are the reviewer's call today; `back` is what tells them apart.
    next: Object.freeze([
      Object.freeze({ to: 'done', actor: 'reviewer' }),
      Object.freeze({ to: 'queued-implementation', actor: 'reviewer', back: true }),
    ]),
    actor: 'reviewer',
  }),
  done: Object.freeze({
    zh: STAGE_ZH.done,
    from: Object.freeze(['reviewing', 'analyzing']),
    next: Object.freeze([
      Object.freeze({ to: 'archived', actor: 'plugin' }),
    ]),
    actor: 'plugin',
  }),
  archived: Object.freeze({
    zh: STAGE_ZH.archived,
    from: Object.freeze(['done']),
    next: Object.freeze([]),
    actor: null,
    terminal: true,
  }),
})

/**
 * The successor **stage ids** of `stage`, projected from the edge table.
 *
 * `STAGE_MACHINE[x].next` is the single source; this is a view, never a second
 * array. Unknown stages answer `[]` (callers such as {@link canTransition} must
 * treat "unknown" as "no edge", not as an error).
 */
export function nextStages(stage) {
  const node = Object.hasOwn(STAGE_MACHINE, stage) ? STAGE_MACHINE[stage] : undefined
  return node === undefined ? [] : node.next.map((edge) => edge.to)
}

/** The edge `from → to` (with its actor and `back` marker), or `null`. */
export function edgeOf(from, to) {
  const node = Object.hasOwn(STAGE_MACHINE, from) ? STAGE_MACHINE[from] : undefined
  if (node === undefined) return null
  return node.next.find((edge) => edge.to === to) ?? null
}

/** The actor that may walk `from → to`, or `null` when the edge does not exist. */
export function actorForEdge(from, to) {
  const edge = edgeOf(from, to)
  return edge === null ? null : edge.actor
}

/**
 * Legacy `status` derived from a stage — the compatibility view.
 *
 * `created` maps to `draft` so a backfilled record keeps the status it had
 * before the field existed; everything in the pipeline is `active`; the last two
 * stages are the existing `done`/`archived`.
 */
const STATUS_BY_STAGE = Object.freeze({
  created: 'draft',
  'queued-analysis': 'active',
  analyzing: 'active',
  'queued-implementation': 'active',
  implementing: 'active',
  'queued-review': 'active',
  reviewing: 'active',
  done: 'done',
  archived: 'archived',
})

/** The `status` a stage implies; unknown stages are rejected with the nine values. */
export function stageToStatus(stage) {
  const status = STATUS_BY_STAGE[stage]
  if (status === undefined) throw invalid(`stage must be one of ${STAGE_IDS.join(', ')}`)
  return status
}

/**
 * The stage a **legacy record** (one written before `stage` existed) should be
 * projected as, derived from its `status`.
 *
 * `done`/`archived` are exact. `active` can only mean "somewhere in the pipeline"
 * — the six pipeline stages are indistinguishable from `status` alone, so the
 * earliest one is used as a conservative "in the pipeline" marker (a backfill may
 * refine it). Anything else is a task that has not started.
 *
 * Single source: `lib/tasks/records.mjs` 的读投影 calls this and must never
 * restate the mapping. Getting it wrong is not cosmetic — the §9 status block
 * treats every projected stage as unfinished-or-not, so a `done` record projected
 * as `created` lands on the pending stack and inflates the counts (task-68).
 */
export function legacyStageFromStatus(status) {
  if (status === 'archived') return 'archived'
  if (status === 'done') return 'done'
  if (status === 'active') return 'queued-analysis'
  return DEFAULT_STAGE
}

/**
 * Is `from → to` a legal edge?
 *
 * A stage may be re-written to itself (idempotent no-op, so a caller does not
 * have to special-case "no change"); every other pair must be a declared edge.
 * Unknown ids are simply not edges — use {@link assertTransition} for a message
 * that says what *would* be legal.
 */
export function canTransition(from, to) {
  if (from === to) return STAGE_IDS.includes(from)
  return edgeOf(from, to) !== null
}

/**
 * Throw a `FlowError('invalid')` unless `from → to` is legal.
 *
 * The message always names the legal successors (and the nine ids for an unknown
 * stage): a rejection has to tell the caller how to proceed correctly, otherwise
 * the only way forward is guessing.
 */
export function assertTransition(from, to) {
  if (canTransition(from, to)) return
  const node = Object.hasOwn(STAGE_MACHINE, from) ? STAGE_MACHINE[from] : undefined
  if (node === undefined) {
    throw invalid(`unknown stage: ${JSON.stringify(from)} (stage must be one of ${STAGE_IDS.join(', ')})`)
  }
  if (node.terminal === true) {
    throw invalid(`stage ${from} is terminal; it has no successor (attempted: ${JSON.stringify(to)})`)
  }
  throw invalid(`stage ${from} cannot move to ${JSON.stringify(to)}; allowed next: ${nextStages(from).join(', ')}`)
}

// ------------------------------------------------------- next-step doctrine

/**
 * 每条合法边的「必做动作 / 验证命令」——`flow task next` 的唯一真源。
 *
 * 为什么和 {@link STAGE_MACHINE} 分开却必须**一一对应**：边表只回答「能不能走」，
 * 用户的目标是「下一步做什么、怎么验证」由机器直接给出，而不是让模型推理。动作与
 * 验证命令是**边的语义**（`reviewing → done` 与 `reviewing → queued-implementation`
 * 的下一步完全不同），所以键是 `from>to`，不是 stage。
 *
 * 约定：
 * - 值是模板，占位符 `{id}` 由调用方（CLI）代入任务 id；本模块不认识记录、不做渲染。
 * - `verify: null` = 该边由插件自动推进（或没有可机器执行的验证），没有人要跑的命令。
 * - `command` 缺省时由 {@link stageNextStep} 按 `flow task update {id} --stage <to>`
 *   合成；需要额外 flag（例如退回边要写原因）的边才显式给。
 *
 * 覆盖完整性由 `test/t-20261111-task-next-verify.test.mjs` 断言：少一条边会红，
 * 多一条幽灵键也会红（否则「说明写了但边删了」会静默腐烂）。
 */
export const STAGE_EDGE_DOCTRINE = Object.freeze({
  'created>queued-analysis': Object.freeze({
    action: '插件把任务排入分析队列',
    verify: null,
  }),
  'queued-analysis>analyzing': Object.freeze({
    action: '插件领取任务并开始分析',
    verify: null,
  }),
  'queued-analysis>analyzing:normalizeTask': Object.freeze({
    action: '汇总轮：插件把聚合回来的父任务直接交给分析者收口（子任务已全部完成）',
    verify: null,
  }),
  'analyzing>queued-implementation': Object.freeze({
    action: '分析收口：写下语义变更计划（flow desc plan {id} --input <json> 或 --template <src>）',
    verify: 'flow desc plan {id} --show',
  }),
  /* 汇总轮（T-20261111170544）：子任务全部完成后，分析者不再拆任务，而是核对每个
     子任务的审查结论与证据、把汇总写进 notes 并收口父任务。这是一条**判定边**，
     所以主推荐/备选的分法（`back` 标记）不变——它和拆任务边都不是回退边。 */
  'analyzing>done': Object.freeze({
    action: '子任务全部完成：核对每个子任务的审查结论与证据，把汇总写进 notes，回报 lead',
    verify: 'flow task verify {id}',
  }),
  'queued-implementation>implementing': Object.freeze({
    action: '插件把任务排入实现队列',
    verify: null,
  }),
  'implementing>queued-review': Object.freeze({
    action: '实现收口：写 notes/commits，跑验收命令到全绿',
    verify: 'flow task verify {id}',
  }),
  'queued-review>reviewing': Object.freeze({
    action: '插件把任务交给审查者（进入 reviewing 前验收必须已通过）',
    verify: 'flow task verify {id}',
  }),
  'reviewing>done': Object.freeze({
    action: '审查通过：确认验收证据与测试全绿后收口',
    verify: 'flow task verify {id}',
  }),
  'reviewing>queued-implementation': Object.freeze({
    action: '审查退回：把不通过的原因写进 notes，任务回到待实现',
    verify: null,
    command: "flow task update {id} --stage queued-implementation --notes '<退回原因>'",
  }),
  'done>archived': Object.freeze({
    action: '插件归档已完成任务（flow task archive 或面板）',
    verify: null,
  }),
})

/**
 * `flow task next` 眼里的终态。
 *
 * 与 {@link STAGE_MACHINE}`.terminal` 的区别是**故意的**：表里只有 `archived` 没有出
 * 边；`done` 还有一条 `done → archived`，但那是插件按归档窗口自动走的边，对「下一步
 * 做什么」没有人的动作。命令层把两者都当终态，是为了让「已完成」给出一句明确结论，
 * 而不是永远有下一条命令可打印（否则完成这件事会被输出稀释）。
 */
export const NEXT_TERMINAL_STAGES = Object.freeze(['done', 'archived'])

/**
 * 边在 doctrine 里的键：`from>to`，带 `key` 标记的边加 `:<key>` 后缀。
 *
 * 为什么需要后缀：`queued-analysis → analyzing` 有两条边（普通领取 / 汇总轮），
 * 目标阶段相同、动作不同，只用 `from>to` 无法一一对应。不带 `key` 的边保持原键，
 * 所以既有 doctrine 的写法与调用方零变更。
 *
 * @param {string} from 出发阶段
 * @param {{to: string, key?: string}} edge 边表里的一条边
 * @returns {string}
 */
export function edgeDoctrineKey(from, edge) {
  const to = edge !== null && typeof edge === 'object' ? edge.to : edge
  const suffix = edge !== null && typeof edge === 'object' && typeof edge.key === 'string' && edge.key !== ''
    ? `:${edge.key}`
    : ''
  return `${from}>${to}${suffix}`
}

/**
 * `flow task next` 的唯一查表入口：给**阶段**，返回这一步的机器可执行说明。
 *
 * 纯查表：不读记录、不写盘、不推理。主推荐 = 非回退边里最靠前的一条（回退边是
 * 「出问题才走」的路，`back: true` 是边表里显式标注的标记，不是猜的）；其余边按
 * 边表顺序进 `alternatives`。**同一目标阶段的重复边只出现一次**（例如
 * `queued-analysis → analyzing` 的普通边与汇总轮边同目标）：主推荐照旧是第一条，
 * 其余目标的边才进 `alternatives`。
 *
 * @param {string} stage one of {@link STAGE_IDS}
 * @returns {{stage: string, zh: string, terminal: boolean, actor: string|null,
 *   primary: object|null, alternatives: object[]}} each edge row is
 *   `{stage, zh, actor, back, action, verify, command}` (templates, `{id}` unrendered)
 */
export function stageNextStep(stage) {
  const node = Object.hasOwn(STAGE_MACHINE, stage) ? STAGE_MACHINE[stage] : undefined
  if (node === undefined) {
    throw invalid(`unknown stage: ${JSON.stringify(stage)} (stage must be one of ${STAGE_IDS.join(', ')})`)
  }
  const primaryEdge = node.next.find((edge) => edge.back !== true) ?? node.next[0] ?? null
  const rowOf = (edge) => {
    const doctrineKey = edgeDoctrineKey(stage, edge)
    const doctrine = Object.hasOwn(STAGE_EDGE_DOCTRINE, doctrineKey) ? STAGE_EDGE_DOCTRINE[doctrineKey] : null
    const doc = doctrine === null ? {} : doctrine
    return {
      stage: edge.to,
      zh: STAGE_ZH[edge.to] ?? edge.to,
      actor: edge.actor,
      back: edge.back === true,
      ...(typeof edge.key === 'string' ? { key: edge.key } : {}),
      action: typeof doc.action === 'string' ? doc.action : '',
      verify: typeof doc.verify === 'string' ? doc.verify : null,
      command: typeof doc.command === 'string' ? doc.command : `flow task update {id} --stage ${edge.to}`,
    }
  }
  const primary = primaryEdge === null ? null : rowOf(primaryEdge)
  const alternatives = node.next
    .filter((edge) => edge !== primaryEdge && (primary === null || edge.to !== primary.stage))
    .map(rowOf)
  return {
    stage,
    zh: STAGE_ZH[stage] ?? stage,
    // 终态 = 显式标记或「没有任何出边」：done 没有出边但没有 terminal 标记，
    // 只认标记会让 CLI（用出边判终态）与 API 给出两个答案（2026-11-11 审查 P2-4）。
    terminal: node.terminal === true || node.next.length === 0,
    actor: typeof node.actor === 'string' ? node.actor : null,
    primary,
    alternatives,
  }
}
