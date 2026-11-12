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
 * `add`/`update` 的**选项**（不是门禁记录字段）：透传给 core 的
 * `options.allowUnknownExpect`。它不进 `pickFields`，因此不会写成
 * `gate.allowUnknownExpect`（per-step 标记由 core 归一）。
 */
const ALLOW_UNKNOWN_EXPECT = 'allowUnknownExpect'

function acceptedFields(action) {
  const fields = GATE_ACTION_FIELDS[action] ?? []
  return action === 'add' || action === 'update' ? [...fields, ALLOW_UNKNOWN_EXPECT] : fields
}

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
      'List, inspect, add, update, remove, run or read logs of project-flow gates (ordered shell steps with expect rules). All actions except list require a .agents/flow store. `run` executes the steps in the project root; by default it keeps running the remaining steps after a failure (segmented), and `failFast` restores first-failure stop.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'add', 'update', 'remove', 'run', 'logs'] },
        root: ROOT_PROPERTY,
        id: { type: 'string', description: 'Gate id, e.g. precommit.' },
        title: { type: 'string' },
        phase: { type: 'string', enum: ['commit', 'release', 'manual'] },
        enabled: { type: 'boolean' },
        kind: {
          type: 'string',
          enum: ['structure', 'behavior'],
          description:
            'add/update: gate classification. structure gates may mount at layer|module|feature|aspect; behavior gates only at feature. Default behavior.',
        },
        mount: {
          type: 'object',
          description:
            'add/update: mount point {level, target?}. level is layer|module|feature|aspect (default feature); target is required for module/aspect and must match ^[a-z0-9][a-z0-9-]{1,40}$.',
          properties: {
            level: { type: 'string', enum: ['layer', 'module', 'feature', 'aspect'] },
            target: { type: 'string' },
          },
          additionalProperties: false,
        },
        failFast: {
          type: 'boolean',
          description:
            'add/update: persist the gate-level strategy (default false = segmented: after a failing step the remaining steps still run). run: override for this run only.',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              run: { type: 'string', description: 'Shell command, executed with the project root as cwd.' },
              expect: {
                type: 'string',
                description: 'exit N (default exit 0) or contains: TEXT. An unrecognized form is rejected at definition time unless allowUnknownExpect is true.',
              },
              timeoutSeconds: { type: 'integer', description: 'Per-step timeout in seconds (default 600).' },
            },
            required: ['run'],
            additionalProperties: false,
          },
        },
        allowUnknownExpect: {
          type: 'boolean',
          description:
            'add/update only: deliberately accept an unrecognized step expect instead of rejecting the definition (persisted as step.allowUnknownExpect; run then treats it as exit 0 and keeps a warning). Default false = reject at definition time.',
        },
        limit: { type: 'integer', description: 'Maximum run records to return (default 5, capped at 50).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: toolOutput('flow_gate'),
    isConcurrencySafe: false,
    async execute(args, exec) {
      const root = toolRoot(ctx, args, exec)
      const action = args.action
      assertOnlyFields('flow_gate', action, args, acceptedFields(action))
      const allowUnknownExpect = args.allowUnknownExpect === true
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
        return { root, gate: c.addGate(root, contract, input, { allowUnknownExpect }) }
      }
      if (action === 'update') {
        const id = requireId('flow_gate', action, args.id)
        const patch = pickFields(args, GATE_UPDATE_FIELDS)
        if (Object.keys(patch).length === 0) throw new Error('flow_gate update requires at least one field to change')
        return { root, gate: c.updateGate(root, contract, id, patch, { allowUnknownExpect }) }
      }
      if (action === 'remove') {
        const id = requireId('flow_gate', action, args.id)
        return { root, ...c.removeGate(root, contract, id) }
      }
      if (action === 'run') {
        const id = requireId('flow_gate', action, args.id)
        // failFast 只覆盖**这一次**运行，不回写门禁记录（记录里的策略由 add/update 决定）。
        const options = typeof args.failFast === 'boolean' ? { failFast: args.failFast } : {}
        return { root, run: await c.runGate(root, contract, id, options) }
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
