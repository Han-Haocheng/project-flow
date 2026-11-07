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
 * explicit so a reader sees the back edge), `next` lists the legal successors,
 * `terminal` marks a stage with no outgoing edge.
 *
 * The **only** backward edge in the workflow is `reviewing → queued-implementation`
 * (review sends the work back for changes). `reviewing → done` is the approval
 * path, so `reviewing` has two successors and one of them looks "backwards".
 */
export const STAGE_MACHINE = Object.freeze({
  created: Object.freeze({
    zh: STAGE_ZH.created,
    from: Object.freeze([]),
    next: Object.freeze(['queued-analysis']),
    actor: 'plugin',
  }),
  'queued-analysis': Object.freeze({
    zh: STAGE_ZH['queued-analysis'],
    from: Object.freeze(['created']),
    next: Object.freeze(['analyzing']),
    actor: 'plugin',
  }),
  analyzing: Object.freeze({
    zh: STAGE_ZH.analyzing,
    from: Object.freeze(['queued-analysis']),
    next: Object.freeze(['queued-implementation']),
    actor: 'session',
  }),
  'queued-implementation': Object.freeze({
    zh: STAGE_ZH['queued-implementation'],
    from: Object.freeze(['analyzing', 'reviewing']),
    next: Object.freeze(['implementing']),
    actor: 'plugin',
  }),
  implementing: Object.freeze({
    zh: STAGE_ZH.implementing,
    from: Object.freeze(['queued-implementation']),
    next: Object.freeze(['queued-review']),
    actor: 'session',
  }),
  'queued-review': Object.freeze({
    zh: STAGE_ZH['queued-review'],
    from: Object.freeze(['implementing']),
    next: Object.freeze(['reviewing']),
    actor: 'plugin',
  }),
  reviewing: Object.freeze({
    zh: STAGE_ZH.reviewing,
    from: Object.freeze(['queued-review']),
    // Judgement ("approved" → done) or "send it back" (→ queued-implementation).
    next: Object.freeze(['done', 'queued-implementation']),
    actor: 'reviewer',
  }),
  done: Object.freeze({
    zh: STAGE_ZH.done,
    from: Object.freeze(['reviewing']),
    next: Object.freeze(['archived']),
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
  const node = STAGE_MACHINE[from]
  return node !== undefined && node.next.includes(to)
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
  throw invalid(`stage ${from} cannot move to ${JSON.stringify(to)}; allowed next: ${node.next.join(', ')}`)
}
