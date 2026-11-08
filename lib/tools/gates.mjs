// project-flow — the `flow_gate` tool definition.
//
// Moved verbatim out of index.js (buildToolDefinitions) so the shared
// `project-flow` plugin and the `@local/project-flow/gates` sub-plugin register
// the same object. Only the mount context and its root resolver arrive through
// `deps`; every rule (store probe, core accessor, field whitelists, caps) is
// imported from the single shared implementation.

import { pickInteger, requireCore } from '../state-snapshot.mjs'
import {
  assertOnlyFields,
  GATE_ACTION_FIELDS,
  GATE_ADD_FIELDS,
  GATE_UPDATE_FIELDS,
  hasStore,
  pickFields,
  requireId,
  requireStore,
  ROOT_PROPERTY,
  toolOutput,
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
    name: 'flow_gate',
    description:
      'List, inspect, add, update, remove, run or read logs of project-flow gates (ordered shell steps with expect rules). All actions except list require a .agents/flow store. `run` executes the steps in the project root; a non-zero step stops the run.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'add', 'update', 'remove', 'run', 'logs'] },
        root: ROOT_PROPERTY,
        id: { type: 'string', description: 'Gate id, e.g. precommit.' },
        title: { type: 'string' },
        phase: { type: 'string', enum: ['commit', 'release', 'manual'] },
        enabled: { type: 'boolean' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              run: { type: 'string', description: 'Shell command, executed with the project root as cwd.' },
              expect: { type: 'string', description: 'exit N (default exit 0) or contains: TEXT.' },
              timeoutSeconds: { type: 'integer', description: 'Per-step timeout in seconds (default 600).' },
            },
            required: ['run'],
            additionalProperties: false,
          },
        },
        limit: { type: 'integer', description: 'Maximum run records to return (default 5, capped at 50).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: toolOutput(),
    isConcurrencySafe: false,
    async execute(args, exec) {
      const root = toolRoot(ctx, args, exec)
      const action = args.action
      assertOnlyFields('flow_gate', action, args, GATE_ACTION_FIELDS[action])
      if (action === 'list' && hasStore(root) === false) {

        return {
          root,
          store: false,
          gates: [],
          note: 'gate definitions live in the .agents/flow store; run: node bin/flow.mjs init',
        }
      }
      requireStore(root)
      const c = requireCore()
      const { contract } = c.loadContract(root)
      if (action === 'list') {
        const gates = c.listGates(root, contract).map((gate) => {
          const runs = c.listGateRuns(root, contract, gate.id, 1)
          return { ...gate, lastRun: runs.length > 0 ? runs[0] : null }
        })
        return { root, store: true, gates }
      }
      if (action === 'show') {
        const id = requireId('flow_gate', action, args.id)
        const runs = c.listGateRuns(root, contract, id, 1)
        return { root, gate: c.getGate(root, contract, id), lastRun: runs.length > 0 ? runs[0] : null }
      }
      if (action === 'add') {
        if (typeof args.id !== 'string' || args.id.trim() === '') {
          throw new Error('invalid: flow_gate add requires id (the gate slug)')
        }
        const input = pickFields(args, GATE_ADD_FIELDS)
        return { root, gate: c.addGate(root, contract, input) }
      }
      if (action === 'update') {
        const id = requireId('flow_gate', action, args.id)
        const patch = pickFields(args, GATE_UPDATE_FIELDS)
        if (Object.keys(patch).length === 0) throw new Error('flow_gate update requires at least one field to change')
        return { root, gate: c.updateGate(root, contract, id, patch) }
      }
      if (action === 'remove') {
        const id = requireId('flow_gate', action, args.id)
        return { root, ...c.removeGate(root, contract, id) }
      }
      if (action === 'run') {
        const id = requireId('flow_gate', action, args.id)
        return { root, run: await c.runGate(root, contract, id, {}) }
      }
      if (action === 'logs') {
        const id = requireId('flow_gate', action, args.id)
        const limit = pickInteger(args.limit, 5, 1, 50)
        return { root, gate: id, runs: c.listGateRuns(root, contract, id, limit) }
      }
      throw new Error(`unknown flow_gate action: ${String(action)}`)
    },
  }
}
