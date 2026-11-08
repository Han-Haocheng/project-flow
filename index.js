// project-flow — Host half.
//
// Registers three JSON endpoints, all same-origin gated: one read endpoint,
// /api/project-flow/state, and two write endpoints, /api/project-flow/init
// (create the store of the requested workspace) and /api/project-flow/gate
// (toggle one gate's `enabled` flag). The read endpoint reports the store of
// exactly one workspace: the directory the panel passes as `?root=<dir>` (the
// current session workspace), or the process working directory when the
// parameter is omitted. A workspace with no `.agents/flow` store is reported as a
// "not initialized" empty state — the endpoint never substitutes, scans or
// lists another project, and there is no legacy ledger mode.
// Neither write endpoint touches the store directly: after the same root
// scoping they hand the directory to lib/core.mjs, the one writer shared with
// the CLI, so the same validation and atomic write apply. Three agent tools
// (flow_status / flow_heartbeat / flow_decision) plus three skills expose the
// store to the model; the module tools flow_exp / flow_task / flow_gate live in
// their own mountable entries (experiments.js / tasks.js / gates.js) over the
// same lib/core.mjs writer and the same shared plumbing (lib/plugin/). A
// system-prompt section, a per-turn pre-step reminder and an optional edit/write
// guard keep the heartbeat discipline visible. The heartbeat discipline serves
// *main* sessions only:
// subagent sessions neither create heartbeats nor face the reminder or the write
// guard, and the ledger lives in the project's main worktree so linked-worktree
// sessions share one ledger. Root resolution happens per request; there are no
// watchers and no dependencies beyond node built-ins.
//
// Only the root the caller names is touched on disk. Registered workspace rows
// are normalized with pure path arithmetic (`resolve` plus separator handling),
// never with a filesystem call: a registered workspace on a missing mount must
// not cost a request anything. Root resolution in this module is asynchronous
// (`realpath`/`stat`/`readFile` from node:fs/promises), so a slow root blocks
// its own request rather than the host event loop.
//
// The store read itself — core's synchronous readers, the git subprocess and the
// `containedPath` realpath guard — runs in a forked worker (lib/state-snapshot.mjs)
// with an 1800ms deadline, so even a root parked in a syscall only costs that one
// request. The host assembles no payload and performs no store filesystem call.

import { fork } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brief,
  buildSnapshot,
  clip,
  coreAvailable,
  coreModule,
  coreUnavailableMessage,
  decisionCountsOf,
  decisionRemindMax,
  emptyDecisionCounts,
  heartbeatRowVisible,
  isPlainObject,
  isoLocal,
  readManifestName,
  requireCore,
  storeContractPath,
  takeCoreWarnings,
  timeValue,
  toPosix,
} from './lib/state-snapshot.mjs'
export const inject = ['webServer']

import {
  EMPTY_STORE_NOTE,
  hasStore,
  makeToolRoot,
  MAX_TOOL_ITEMS,
  pickFields,
  requireId,
  requireStore,
  ROOT_PROPERTY,
  toolOutput,
  WRITE_TIMEOUT_MS,
} from './lib/plugin/shared.mjs'
// The one mount implementation: service lookup, ctx.effect registration, the
// core-warning wrapper and the mount-warning channel are shared with the three
// module sub-plugins (tasks.js / gates.js / experiments.js).
import { STAGE_ZH, actorForEdge, edgeOf, nextStages } from './lib/stage.mjs'
import { readTeamBoard, reconcileLinks, teamStatusOf } from './lib/team-sync.mjs'
import { buildDefinition as buildSubtaskDefinition } from './lib/tools/subtasks.mjs'
import { answerDecisionAndApply, applyVetoAnswer, vetoSubtask, vetoTask } from './lib/veto.mjs'
import { commandNameOf, parseCommand } from './lib/commands.mjs'
import {
  buildStatusBlock,
  createCaptureState,
  flushCapture,
  noteCaptureGate,
  recordPreStep,
  stackTop,
  textOfContent,
} from './lib/capture.mjs'
import {
  mountWarnings,
  provide,
  registerToolDefinitions,
  service,
  toolDeps,
  warnMount,
} from './lib/plugin/mount.mjs'
import {
  GATE_ROUTE_PATH,
  HEARTBEAT_GATE_TOOLS,
  HEARTBEAT_SESSION_MAX,
  HEARTBEAT_SESSION_PATTERN,
  INIT_ROUTE_PATH,
  MAX_INIT_BODY_BYTES,
  MAX_INIT_CREATED,
  MAX_INIT_WARNINGS,
  PACKAGE_ROOT,
  ROUTE_PATH,
  SUBAGENT_ORIGIN,
  canonicalRoot,
  hasStoreAsync,
  isDirectory,
  listWorkspaces,
  originAllowed,
  readBody,
  rootAccepted,
  rootName,
  sendError,
  sendJson,
  toolRoot,
} from './lib/host/shared.mjs'
import {
  agentRoot,
  applyAgentLiveness,
  applyHeartbeatVisibility,
  captureEnabled,
  claimsGateEnabled,
  heartbeatGateEnabled,
  heartbeatGuardReason,
  heartbeatRootOf,
  registerAgentCreated,
  registerAgentDisposed,
  registerDisciplineSection,
  registerHeartbeatKeepalive,
  registerHeartbeatSessionHooks,
  registerTurnReminder,
  requireSession,
  rootSessionVerdict,
  sessionIdOf,
  usableSessionId,
  ROOT_SESSION_DECISION_ONLY,
  ROOT_SESSION_HEARTBEAT_ONLY,
} from './lib/host/session.mjs'
import { handleGate, handleInit } from './lib/host/routes.mjs'
import { rememberTeamCaller, teamStatusFor } from './lib/host/team.mjs'
import {
  DISPATCH_TOOL_DENY,
  TEAM_TOOL_DENY,
  enforceEnabled,
  enforceGuardReason,
  resolveActorMode,
  resolveBoardMode,
  restrictMainSessionTools,
} from './lib/host/enforce.mjs'
import { registerTools } from './lib/host/tools.mjs'
import { registerSkills } from './lib/host/skills.mjs'
import {
  STATE_POOLS,
  StateWorkerPool,
  handleState,
  panelStateReader,
  statePoolOf,
} from './lib/host/state.mjs'

export { panelStateReader }


// ------------------------------------------------------------------- tools
//
// Three model-facing tools over the same lib/core.mjs writer the CLI uses. They
// are declared as plain objects (this package has no node_modules resolution
// for @deepseek-ai/dsh-tools); the registry accepts
// {name, description, parameters:<JSON Schema>, output:{schema, render},
//  isConcurrencySafe, timeoutMs, execute}. Root resolution is shared with the
// endpoint: explicit arg, then the session working directory, then session.cwd.
//
// The module tools (flow_exp / flow_task / flow_gate) are defined once — in
// lib/tools/{experiments,tasks,gates}.mjs — and mounted by the sub-plugin
// entries (experiments.js / tasks.js / gates.js), so this file neither imports
// nor redefines them.

// Tool plumbing lives in lib/plugin/shared.mjs (root/id resolution, the store
// probe, field whitelists, caps and timeouts) and lib/plugin/mount.mjs (service
// lookup, effect registration, core-warning wrapper); the sub-plugins import
// the same two modules, so the rules exist once.

function mountJsonRoute(ctx, path, label, handler) {
  const route = {
    kind: 'exact',
    path,
    handler: (request, response) => {
      Promise.resolve()
        .then(() => handler(ctx, request, response))
        .catch((error) => {
          try {
            if (response.headersSent) {
              response.destroy()
              return
            }
            sendError(response, 500, 'internal', brief(error))
          } catch {
            // The socket is already gone; nothing left to report to.
          }
        })
    },
  }

  try {
    ctx.effect(() => {
      const webServer = service(ctx, 'webServer')
      if (webServer === undefined || typeof webServer.register !== 'function') return () => {}
      const dispose = webServer.register(route)
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // Disposal must never throw into the host.
        }
      }
    }, `project-flow: ${label}`)
  } catch (error) {
    warnMount(`${label}: registration failed: ${brief(error)}`, ctx)
  }
}

export function apply(ctx, config) {
  // `apply` may run again in a long-lived host: drop diagnostics from the
  // previous mount so a successful re-apply never reports stale failures. A
  // still-broken core re-adds its message every time.
  mountWarnings.length = 0
  if (coreAvailable() === false) warnMount(coreUnavailableMessage(), ctx)
  // `config.capture === false` is the rollback switch: no pre-step recording, no
  // turn-stopping flush and no heartbeat auto-start — the plugin behaves like P0.
  const captureEnabled = isPlainObject(config) === false || config.capture !== false
  const settings = {
    heartbeatGate: heartbeatGateEnabled(config),
    claims: claimsGateEnabled(config),
    capture: captureEnabled,
    enforce: enforceEnabled(config),
    // `single` today (one role); P3 flips the default to `team` once the plugin
    // actually dispatches analyzer/implementer/reviewer work.
    actorMode: resolveActorMode(config, ctx),
    boardMode: resolveBoardMode(config, ctx),
    // Per-mount dedupe for §5.2 ① (a re-apply restores the team tools until the
    // new mount restricts again; a module-level set would skip that).
    restrictedAgents: new WeakSet(),
  }
  const captureState = captureEnabled ? createCaptureState() : null
  /* The tool handlers need the same state for `capture` diagnostics; null when
     capture is off (the status block then reports capture:null). */
  settings.captureState = captureState

  // The state read pool: one per apply, disposed with the effect that owns it.
  // A re-apply therefore kills the previous children instead of leaking them,
  // and the first poll finds a pre-warmed child (~fork cost off the request).
  const previousPool = statePoolOf(ctx)
  const pool = new StateWorkerPool()
  STATE_POOLS.set(ctx, pool)
  try {
    if (previousPool !== undefined) previousPool.dispose()
  } catch {
    // A broken previous pool must not block the new mount.
  }
  try {
    ctx.effect(() => {
      pool.ensureWarm()
      return () => {
        pool.dispose()
        if (statePoolOf(ctx) === pool) STATE_POOLS.delete(ctx)
      }
    }, 'project-flow: state worker')
  } catch (error) {
    warnMount(`state worker: registration failed: ${brief(error)}`, ctx)
  }

  // Hooks the session surface needs but must not import (cycle-free split):
  // P2 tool restriction and the Team-board caller cache stay in this entry.
  const sessionHooks = { restrict: restrictMainSessionTools, rememberCaller: rememberTeamCaller }
  mountJsonRoute(ctx, ROUTE_PATH, 'state route', handleState)
  mountJsonRoute(ctx, INIT_ROUTE_PATH, 'init route', handleInit)
  mountJsonRoute(ctx, GATE_ROUTE_PATH, 'gate route', handleGate)

  // Optional services: a host without tools/skills/systemPrompt (or a plain
  // test double) must still get the endpoints. Never let one of these take the
  // plugin down.
  try {
    registerTools(ctx, settings)
  } catch (error) {
    warnMount(`tools: registration failed: ${brief(error)}`, ctx)
  }
  try {
    registerSkills(ctx)
  } catch (error) {
    warnMount(`skills: registration failed: ${brief(error)}`, ctx)
  }
  try {
    registerDisciplineSection(ctx)
  } catch (error) {
    warnMount(`system prompt: registration failed: ${brief(error)}`, ctx)
  }
  try {
    registerTurnReminder(ctx, captureState, settings, sessionHooks)
  } catch (error) {
    warnMount(`turn reminder: registration failed: ${brief(error)}`, ctx)
  }
  try {
    registerHeartbeatKeepalive(ctx, captureState)
  } catch (error) {
    warnMount(`heartbeat keepalive: registration failed: ${brief(error)}`, ctx)
  }
  try {
    registerAgentCreated(ctx, captureState, settings, sessionHooks)
  } catch (error) {
    warnMount(`capture/enforce: registration failed: ${brief(error)}`, ctx)
  }
  // Lifecycle close is independent of `capture`: see registerAgentDisposed.
  registerAgentDisposed(ctx)
  // Session identity/status observers (agent status, subagent runs, title
  // events, workspace archive set): independent of `capture` as well.
  try {
    registerHeartbeatSessionHooks(ctx)
  } catch (error) {
    warnMount(`heartbeat session hooks: registration failed: ${brief(error)}`, ctx)
  }
}
