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
 * Single source of truth: `lib/core.mjs` imports the ids/derivation from here and
 * nothing else in the repo may restate this table.
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
    next: Object.freeze([
      Object.freeze({ to: 'analyzing', actor: 'plugin' }),
    ]),
    actor: 'plugin',
  }),
  analyzing: Object.freeze({
    zh: STAGE_ZH.analyzing,
    from: Object.freeze(['queued-analysis']),
    next: Object.freeze([
      Object.freeze({ to: 'queued-implementation', actor: 'session' }),
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
    from: Object.freeze(['reviewing']),
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
 * Single source: `lib/core.mjs`'s read projection calls this and must never
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
