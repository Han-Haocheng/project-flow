// project-flow — the `flow_subtask` tool definition (P4).
//
// Before this file the P2 guard rule 5 (`flow_subtask` only in the
// implementation stages) was tested but unreachable: no such tool existed. This
// makes the rule live.
//
// Writes go through the shared core API (`addTask` / `updateTask`) — the tool
// never writes store files itself. `remove` is deliberately not a delete: core
// has no physical delete, and a veto's history has to stay auditable.

import { requireCore } from '../state-snapshot.mjs'
import { assertTransition } from '../stage.mjs'
import { assertOnlyFields, pickFields, requireId, requireStore, ROOT_PROPERTY, toolOutput, WRITE_TIMEOUT_MS } from '../plugin/shared.mjs'

/** Only these fields may be patched through `flow_subtask update`. */
const SUBTASK_UPDATE_FIELDS = Object.freeze(['notes', 'stage'])

/** `add` forwards these to `addTask` (parent + stage are set by the tool). */
const SUBTASK_ADD_FIELDS = Object.freeze(['type', 'title', 'notes', 'scope', 'acceptance'])

const TASK_TYPE_ENUM = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci']

/** The line `remove` appends so the reason survives in the ordinary notes view. */
export function removedNote(notes, reason) {
  const line = `[removed] ${reason}`
  const current = typeof notes === 'string' ? notes.trimEnd() : ''
  return current === '' ? line : `${current}\n${line}`
}

/**
 * @param {{ctx: unknown, toolRoot: (ctx: unknown, args: unknown, exec: unknown) => string}} deps
 */
export function buildDefinition(deps) {
  const { ctx, toolRoot } = deps
  return {
    name: 'flow_subtask',
    description:
      'Manage subtasks of one parent task (add/update/remove). Only available while the parent is in the implementation stages (queued-implementation / implementing). `add` places the child directly in queued-analysis. `update` may change only notes and stage (the stage must be a legal transition of the state machine). `remove` does not delete: it completes the child (stage=done) and appends `[removed] <reason>` to its notes — the record and its history stay in the ledger.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove'] },
        root: ROOT_PROPERTY,
        parent: { type: 'string', description: 'add: the parent task id (must exist and be in an implementation stage).' },
        id: { type: 'string', description: 'update/remove: the subtask id.' },
        type: {
          type: 'string',
          enum: TASK_TYPE_ENUM,
          description: 'add: conventional commit type (required).',
        },
        title: { type: 'string', description: 'add: the subtask heading (required).' },
        notes: { type: 'string', description: 'add/update: notes; update may replace them.' },
        scope: {
          type: 'object',
          description: 'add: advisory write scope `{allow?, deny?}`.',
          properties: {
            allow: { type: 'array', items: { type: 'string' } },
            deny: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        acceptance: { type: 'array', items: { type: 'string' }, description: 'add: acceptance lines.' },
        stage: {
          type: 'string',
          enum: ['created', 'queued-analysis', 'analyzing', 'queued-implementation', 'implementing', 'queued-review', 'reviewing', 'done', 'archived'],
          description: 'update: the next stage; must be a legal transition (same state machine as flow_task).',
        },
        reason: { type: 'string', description: 'remove: why the subtask is being removed (required, kept in notes).' },
      },
      required: ['action'],
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

      if (action === 'add') {
        const parent = requireId('flow_subtask', 'add', args.parent)
        const input = pickFields(args, SUBTASK_ADD_FIELDS)
        /* Parent existence + no cycles stay in core (`addTask` validates parent);
           the stage is fixed by the tool: a child of an implementing parent
           starts its own analysis now. */
        const task = c.addTask(root, contract, {
          ...input,
          parent,
          stage: 'queued-analysis',
        })
        return { root, task }
      }

      if (action === 'update') {
        const id = requireId('flow_subtask', 'update', args.id)
        assertOnlyFields('flow_subtask', action, args, SUBTASK_UPDATE_FIELDS)
        const patch = pickFields(args, SUBTASK_UPDATE_FIELDS)
        if (Object.keys(patch).length === 0) throw new Error('flow_subtask update requires at least one field to change')
        if (patch.stage !== undefined) {
          /* Same single source as every other stage write: the machine in
             lib/stage.mjs, never a second table here. */
          const current = c.getTask(root, contract, id)
          assertTransition(current.stage, patch.stage)
        }
        return { root, task: c.updateTask(root, contract, id, patch) }
      }

      if (action === 'remove') {
        const id = requireId('flow_subtask', 'remove', args.id)
        const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
        if (reason === '') throw new Error('flow_subtask remove requires a reason')
        const current = c.getTask(root, contract, id)
        const task = c.updateTask(root, contract, id, {
          stage: 'done',
          notes: removedNote(current.notes, reason),
        })
        return { root, task }
      }

      throw new Error(`unknown flow_subtask action: ${String(action)}`)
    },
  }
}
