// project-flow — Shared tool plumbing.
//
// This module is the single home of everything the `flow_*` tools share: the
// registry-ready output contract, root/id resolution, the store probe, the per-
// action field whitelists, the list caps/timeouts and the "known field on the
// wrong action" guard. Both the shared `project-flow` plugin (index.js) and the
// per-module sub-plugins (`tasks.js`, `gates.js`, `experiments.js`) import from
// here, so a sub-plugin can never drift from the shared rules.
//
// Two helpers need host services that only a plugin's `apply` sees
// (`workingDirectory`, and this module's own `hasStore` probe): they are
// exported as factories so each caller binds its own context while the
// validation logic stays in one place.
//
// Mounting (service lookup, ctx.effect registration, the core-warning wrapper)
// lives in the sibling module ./mount.mjs for the same reason.

import { statSync } from 'node:fs'
import { resolve } from 'node:path'

import { storeContractPath } from '../state-snapshot.mjs'

// Local copy: `isPlainObject` is not exported by lib/core.mjs or
// lib/state-snapshot.mjs, and this module must not grow a dependency on either
// module's internals.
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

export const ROOT_PROPERTY = {
  type: 'string',
  description: 'Project root (absolute or relative). Defaults to the session working directory.',
}
export const ID_PROPERTY = { type: 'string', description: 'Record id, e.g. E-20261028-01 or T-20261028-01.' }
export const EMPTY_STORE_NOTE = 'no flow store in this workspace; run: node bin/flow.mjs init'

/** List caps and write timeouts the `flow_*` tools share (one source, no drift). */
export const MAX_TOOL_ITEMS = 200
export const WRITE_TIMEOUT_MS = 30_000

/** Registry-ready output contract: render the result value as pretty JSON text. */
export function toolOutput() {
  return {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

export function requireDirectory(candidate) {
  let stats
  try {
    stats = statSync(candidate)
  } catch {
    throw new Error(`root does not exist: ${candidate}`)
  }
  if (stats.isDirectory() !== true) throw new Error(`root is not a directory: ${candidate}`)
  return candidate
}

export function requireId(tool, action, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${tool} ${action} requires id`)
  }
  return value.trim()
}

/**
 * `flow_task.parent` shares the CLI's clearing rule (`''`/`none`/`null`,
 * case-insensitive → null) through core.normalizeParentInput, so the tool and
 * `task --parent` can never diverge on what "root" means.
 */
export function normalizeTaskParent(c, input) {
  if (isPlainObject(input) && Object.hasOwn(input, 'parent')) {
    input.parent = c.normalizeParentInput(input.parent)
  }
  return input
}

export function pickFields(args, names) {
  const picked = {}
  for (const name of names) {
    if (Object.hasOwn(args, name) && args[name] !== undefined) picked[name] = args[name]
  }
  return picked
}

/**
 * Resolve the project root for one tool call: an explicit `root` argument wins,
 * then the session's working directory service, then the session header cwd.
 * Bound to the host `workingDirectory` service by the plugin that owns the call.
 */
export function makeToolRoot({ service }) {
  return function toolRoot(ctx, args, exec) {
    const explicit = args !== null && typeof args === 'object' ? args.root : undefined
    if (typeof explicit === 'string' && explicit.trim().length > 0) {
      return requireDirectory(resolve(explicit))
    }

    const session = exec !== null && exec !== undefined && exec.agent !== undefined ? exec.agent.session : undefined
    const workingDirectory = service(ctx, 'workingDirectory')
    if (workingDirectory !== undefined && typeof workingDirectory.get === 'function' && session !== undefined) {
      try {
        const value = workingDirectory.get(session)
        if (typeof value === 'string' && value.trim().length > 0) return requireDirectory(resolve(value))
      } catch {
        // Fall through to the session header cwd.
      }
    }
    let cwd
    try {
      cwd = session === undefined || session === null ? undefined : session.cwd
    } catch {
      cwd = undefined
    }
    if (typeof cwd === 'string' && cwd.trim().length > 0) return requireDirectory(resolve(cwd))
    throw new Error('no project root: pass root, or call this tool inside a workspace session')
  }
}

/** Fail fast with the init hint when the workspace has no store yet. */
export function makeRequireStore({ hasStore }) {
  return function requireStore(root) {
    if (hasStore(root) === false) {
      throw new Error(`project flow store not found in ${root}; run: node bin/flow.mjs init`)
    }
  }
}

/**
 * Whether the root owns a `.dsh/flow/flow.json` store contract. Every flow_*
 * tool and the shared plugin's heartbeat/decision helpers probe the store
 * through this one function, so "initialized" can never mean two things.
 */
export function hasStore(root) {
  try {
    return statSync(storeContractPath(root)).isFile()
  } catch {
    return false
  }
}

/** `requireStore` bound to the shared `hasStore`: the one store guard. */
export const requireStore = makeRequireStore({ hasStore })

export const EXP_ADD_FIELDS = Object.freeze([
  'id',
  'title',
  'hypothesis',
  'factor',
  'parent',
  'expected',
  'scale',
  'status',
  'measured',
  'metrics',
  'commits',
  'notes',
  'direction',
  'primaryMetric',
  'guardrails',
  'falsify',
  'windowDays',
  'stopLoss',
  'learned',
])
export const EXP_UPDATE_FIELDS = Object.freeze([
  'title',
  'hypothesis',
  'factor',
  'parent',
  'expected',
  'scale',
  'status',
  'measured',
  'metrics',
  'commits',
  'notes',
  'direction',
  'primaryMetric',
  'guardrails',
  'falsify',
  'windowDays',
  'stopLoss',
  'learned',
])
// `title` and `type` stay listed here on purpose: core `applyTaskPatch` is the
// single interception point for "cannot be changed", so the CLI and the tools
// report the same `invalid: task <key> cannot be changed`. Blocking them here
// would produce a second error shape (`assertOnlyFields` throws a plain Error).
// `goal` is gone: it was merged into `title` (legacy `goal` keys are migrated by
// core `normalizeTaskFormat`, not by a tool).
export const TASK_ADD_FIELDS = Object.freeze([
  'id',
  'title',
  'type',
  'status',
  'owner',
  'notes',
  'commits',
  'scope',
  'acceptance',
  'experiment',
  'parent',
])
export const TASK_UPDATE_FIELDS = Object.freeze([
  'title',
  'type',
  'status',
  'owner',
  'notes',
  'commits',
  'scope',
  'acceptance',
  'experiment',
  'parent',
])
export const GATE_ADD_FIELDS = Object.freeze([
  'id',
  'title',
  'phase',
  'enabled',
  'steps',
])
export const GATE_UPDATE_FIELDS = Object.freeze([
  'title',
  'phase',
  'enabled',
  'steps',
])

/**
 * Per-action field whitelist for the flow_* tools (T-20261030-15). The JSON
 * schema already rejects unknown properties; this rejects a **known** field
 * passed to the wrong action (it used to be dropped silently). `root`, `action`
 * and `id` are structural for every action. Throws before any core call.
 */
export const STRUCTURAL_FIELDS = Object.freeze(['root', 'action', 'id'])

export function assertOnlyFields(name, action, args, allowed) {
  const permitted = new Set([...STRUCTURAL_FIELDS, ...(Array.isArray(allowed) ? allowed : [])])
  for (const key of Object.keys(args)) {
    if (permitted.has(key)) continue
    throw new Error(`invalid: ${name} ${String(action)} does not accept "${key}"`)
  }
}

export const EXP_ACTION_FIELDS = Object.freeze({
  list: [], show: [], tree: [],
  add: EXP_ADD_FIELDS, update: EXP_UPDATE_FIELDS,
  review: [], productize: ['gate'], cleanup: ['flags', 'code', 'data'], remove: [],
})
export const TASK_ACTION_FIELDS = Object.freeze({
  list: [], show: [], add: TASK_ADD_FIELDS, update: TASK_UPDATE_FIELDS, remove: [],
})
export const GATE_ACTION_FIELDS = Object.freeze({
  list: [], show: [],
  add: GATE_ADD_FIELDS, update: GATE_UPDATE_FIELDS,
  remove: [], run: [], logs: ['limit'],
})
