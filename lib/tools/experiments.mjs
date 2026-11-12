// project-flow — the `flow_exp` tool definition.
//
// Moved verbatim out of index.js (buildToolDefinitions) so the shared
// `project-flow` plugin and the `@local/project-flow/experiments` sub-plugin
// register the same object. Only the mount context and its root resolver arrive
// through `deps`; every rule (store probe, core accessor, field whitelists,
// caps) is imported from the single shared implementation.

import { requireCore } from '../state-snapshot.mjs'
import {
  assertOnlyFields,
  EMPTY_STORE_NOTE,
  EXP_ACTION_FIELDS,
  EXP_ADD_FIELDS,
  EXP_UPDATE_FIELDS,
  hasStore,
  ID_PROPERTY,
  MAX_TOOL_ITEMS,
  pickFields,
  requireId,
  requireStore,
  ROOT_PROPERTY,
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
    name: 'flow_exp',
    description:
      'List, inspect, add, update, review, productize, clean up or remove project-flow experiments. New experiments are schema 2 and require the seven judging fields (direction, expected, primaryMetric, guardrails, falsify, windowDays, stopLoss). `review` is a read-only self-check returning verdict/branch/missing; `productize` marks a confirmed experiment after a passing release gate run; `cleanup` records the flags/code/data removed for a refuted one. `tree` returns the parent/child forest.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'show', 'tree', 'add', 'update', 'review', 'productize', 'cleanup', 'remove'],
        },
        root: ROOT_PROPERTY,
        id: ID_PROPERTY,
        title: { type: 'string' },
        hypothesis: { type: 'string' },
        factor: { type: 'string' },
        parent: { type: 'string', description: 'Parent experiment id, or empty for a root experiment.' },
        expected: { type: 'string' },
        scale: { type: 'string' },
        status: {
          type: 'string',
          enum: ['open', 'confirmed', 'refuted', 'abandoned', 'inconclusive', 'pivoted'],
        },
        direction: { type: 'string', description: 'Direction of the change (free text, at most 120 characters).' },
        primaryMetric: { type: 'string', description: 'The single primary metric the hypothesis is judged on.' },
        guardrails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Guardrail metric names (at least one).',
        },
        falsify: { type: 'string', description: 'Falsification condition: the hypothesis is refuted when it holds.' },
        windowDays: { type: 'integer', description: 'Observation window in days (positive integer; core validates).' },
        stopLoss: { type: 'string', description: 'Stop-loss line; crossing it ends the experiment.' },
        learned: { type: 'string', description: 'What was learned (required to close refuted/pivoted).' },
        gate: { type: 'string', description: 'Gate id used by `productize` (default "release").' },
        flags: { type: 'array', items: { type: 'string' }, description: 'Cleanup: feature flags removed by `cleanup`.' },
        code: { type: 'array', items: { type: 'string' }, description: 'Cleanup: code paths removed by `cleanup`.' },
        data: { type: 'array', items: { type: 'string' }, description: 'Cleanup: data artifacts removed by `cleanup`.' },
        measured: { type: 'string' },
        metrics: { type: 'object', description: 'Free-form measured metrics.' },
        commits: { type: 'array', items: { type: 'string' }, description: 'Short commit shas.' },
        notes: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: toolOutput('flow_exp'),
    isConcurrencySafe: false,
    timeoutMs: WRITE_TIMEOUT_MS,
    async execute(args, exec) {
      const root = toolRoot(ctx, args, exec)
      const action = args.action
      assertOnlyFields('flow_exp', action, args, EXP_ACTION_FIELDS[action])
      if (action !== 'list') requireStore(root)

      const c = requireCore()
      const { contract } = c.loadContract(root)
      if (action === 'list' && hasStore(root) === false) {
        return {
          root,
          store: false,
          source: 'store',
          total: 0,
          counts: {
            total: 0,
            open: 0,
            confirmed: 0,
            refuted: 0,
            abandoned: 0,
            inconclusive: 0,
            pivoted: 0,
          },
          items: [],
          note: EMPTY_STORE_NOTE,
        }
      }
      if (action === 'list') {
        // Counts come from the same aggregate the CLI/panel use (`readStoreState`),
        // so the six experiment states (open/confirmed/refuted/abandoned/
        // inconclusive/pivoted) can never drift apart again.
        const state = c.readStoreState(root, contract)
        const records = Array.isArray(state.experiments.items) ? state.experiments.items : []
        const aggregate = state.experiments.counts ?? {}
        const counts = {
          total: Number.isInteger(aggregate.total) ? aggregate.total : records.length,
          open: aggregate.open ?? 0,
          confirmed: aggregate.confirmed ?? 0,
          refuted: aggregate.refuted ?? 0,
          abandoned: aggregate.abandoned ?? 0,
          inconclusive: aggregate.inconclusive ?? 0,
          pivoted: aggregate.pivoted ?? 0,
        }
        const items = records.slice(0, MAX_TOOL_ITEMS)
        return { root, store: true, source: 'store', total: counts.total, counts, items, ...(items.length < records.length ? { truncated: true } : {}) }
      }
      if (action === 'show') {
        return { root, experiment: c.getExperiment(root, contract, requireId('flow_exp', action, args.id)) }
      }
      if (action === 'tree') {
        return { root, tree: c.experimentTree(c.listExperiments(root, contract)) }
      }
      if (action === 'add') {
        const input = pickFields(args, EXP_ADD_FIELDS)
        return { root, experiment: c.addExperiment(root, contract, input) }
      }
      if (action === 'update') {
        const id = requireId('flow_exp', action, args.id)
        const patch = pickFields(args, EXP_UPDATE_FIELDS)
        if (Object.keys(patch).length === 0) throw new Error('flow_exp update requires at least one field to change')
        return { root, experiment: c.updateExperiment(root, contract, id, patch) }
      }
      if (action === 'review') {
        const id = requireId('flow_exp', action, args.id)
        const record = c.getExperiment(root, contract, id)
        const records = c.listExperiments(root, contract)
        const hasSuccessor = (experimentId) =>
          records.some((item) => item.id !== experimentId && item.parent === experimentId)
        return { root, review: c.reviewExperimentRecord(record, { hasSuccessor }) }
      }
      if (action === 'productize') {
        const id = requireId('flow_exp', action, args.id)
        const options = typeof args.gate === 'string' && args.gate.trim() !== '' ? { gateId: args.gate.trim() } : {}
        return { root, ...c.productizeExperiment(root, contract, id, options) }
      }
      if (action === 'cleanup') {
        const id = requireId('flow_exp', action, args.id)
        const list = (value) =>
          Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.trim() !== '') : []
        return {
          root,
          ...c.cleanupExperiment(root, contract, id, {
            flags: list(args.flags),
            code: list(args.code),
            data: list(args.data),
          }),
        }
      }
      if (action === 'remove') {
        const id = requireId('flow_exp', action, args.id)
        return { root, ...c.removeExperiment(root, contract, id) }
      }
      throw new Error(`unknown flow_exp action: ${String(action)}`)
    },
  }
}
