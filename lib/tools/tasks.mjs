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
      'List, inspect, add, update or remove project-flow tasks (title, type, status, owner, notes, parent tree, scope, acceptance, commits). `title` carries both the heading and the goal — `goal` was merged into `title` (legacy `goal` keys on disk are migrated by the format gate, not accepted here). All actions require the .dsh/flow store. `type` is required on add and is one of feat/fix/docs/style/refactor/perf/test/chore/build/ci (conventional commit kinds). `title` and `type` cannot be changed by update. `parent` links a subtask to an existing task (the parent must exist; self-reference and cycles are invalid; empty string/none/null makes it a root).',
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
        return { root, task: c.updateTask(root, contract, id, normalizeTaskParent(c, patch)) }
      }
      if (action === 'remove') {
        const id = requireId('flow_task', action, args.id)
        return { root, ...c.removeTask(root, contract, id) }
      }
      throw new Error(`unknown flow_task action: ${String(action)}`)
    },
  }
}
