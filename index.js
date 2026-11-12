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

import { execFile, fork } from 'node:child_process'
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
// 入口不再声明静态 `inject`：所有服务都经 `provide` / `ctx.inject` 可选装配，
// 没有 `webServer` 的宿主（TUI/headless）同样能注册工具/技能/守卫（2026-11-09）。

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
import { autoDispatchEnabled, dispatchProvider } from './lib/dispatch.mjs'
import { allowMainDispatchOf } from './lib/host/enforce.mjs'
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
  backupReminderEnabled,
  captureEnabled,
  claimsGateEnabled,
  heartbeatGateEnabled,
  heartbeatGuardReason,
  heartbeatRootOf,
  registerAgentCreated,
  autoSweepHoursOf,
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
import { applyTeamBoard, rememberTeamCaller, teamStatusFor } from './lib/host/team.mjs'
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

// -------------------------------------- 前端读路径：CLI 契约 + 只读降级（T-20261112154725）
//
// 前端（Web 面板与 TUI）不再由宿主进程直接读 `.agents/`。主读路径是：
//
//     node bin/flow.mjs state --json --root <dir>
//
// 后端 CLI 是唯一真源，前端只解析 `--json` 信封；进程内的 `panelStateReader`
// （fork worker + core）降级为**兜底**：CLI 起不来 / 超时 / 信封坏了时，前端退回
// 只读直连，并在 payload 上标 `degraded:true` + `degradedReason`，界面显式显示
// 「降级模式」，绝不白屏。
//
// 宿主侧富化（agent 存活标注 / 团队板摘要 / 心跳可见性）仍留在本进程：它们需要
// 宿主服务而不是 store，CLI 进程拿不到。这三项不读台账，不算「直连」。
const CLI_STATE_TIMEOUT_MS = 5000
const CLI_STATE_MAX_BYTES = 2 * 1024 * 1024

/** The CLI entry this package ships (same package root as the `bin` map). */
function cliStateEntry() {
  return join(PACKAGE_ROOT, 'bin', 'flow.mjs')
}

/**
 * Run `flow state --json` and return its payload.
 *
 * `run` is injectable for tests only: the degradation path (CLI missing or
 * failing) has to be exercised without breaking the real bin. Production always
 * spawns `process.execPath`, so the plugin needs neither a shell nor a PATH.
 */
function runCliState(root, deadlineMs = CLI_STATE_TIMEOUT_MS) {
  const timeout = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Math.floor(deadlineMs) : CLI_STATE_TIMEOUT_MS
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      [cliStateEntry(), 'state', '--json', '--root', root],
      { cwd: PACKAGE_ROOT, timeout, maxBuffer: CLI_STATE_MAX_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null && error !== undefined) {
          const detail = String(stderr || '').trim() || brief(error)
          rejectPromise(new Error(`flow state failed: ${detail}`))
          return
        }
        let envelope
        try {
          envelope = JSON.parse(String(stdout))
        } catch (parseError) {
          rejectPromise(new Error(`flow state returned non-JSON: ${brief(parseError)}`))
          return
        }
        if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true || envelope.data === null || typeof envelope.data !== 'object') {
          rejectPromise(new Error(`flow state returned an error envelope: ${brief(envelope && envelope.error)}`))
          return
        }
        resolvePromise(envelope.data)
      },
    )
  })
}

/** Host-side enrichment the CLI cannot compute (needs host services, not the store). */
async function enrichHostState(ctx, payload) {
  if (payload === null || typeof payload !== 'object') return payload
  try {
    applyAgentLiveness(ctx, payload)
  } catch {
    // Enrichment must never fail a read.
  }
  try {
    await applyTeamBoard(ctx, payload)
  } catch {
    // Idem.
  }
  try {
    applyHeartbeatVisibility(payload)
  } catch {
    // Idem.
  }
  return payload
}

/** CLI payload + host enrichment; throws when the CLI is unavailable. */
export async function readStateViaCliEnriched(ctx, root, run = runCliState) {
  const payload = await run(root)
  // A runner that answers with a non-object is as unusable as a failed spawn:
  // the caller must fall back to the in-process read instead of handing the
  // panel an empty payload.
  if (payload === null || typeof payload !== 'object') {
    throw new Error('flow state returned a non-object payload')
  }
  payload.readPath = 'cli'
  return await enrichHostState(ctx, payload)
}

/** Mark one in-process payload as the degraded path (never mutates a null). */
export function markDegraded(payload, error) {
  if (payload === null || typeof payload !== 'object') return payload
  payload.readPath = 'direct'
  payload.degraded = true
  payload.degradedReason = `cli-unavailable: ${brief(error)}`.slice(0, 300)
  return payload
}

/**
 * The TUI panel's read path: CLI contract first, in-process read-only fallback.
 *
 * A CLI failure is not an error for the panel — it is a *degraded* state the
 * panel labels. Only when the fallback fails too does the legacy error shape
 * come back, still flagged `degraded` so the panel can say `直连失败`.
 */
export function cliPanelStateReader(ctx, options = {}) {
  const run = typeof options.runCliState === 'function' ? options.runCliState : runCliState
  return async function readPanelState(cwd) {
    let root
    try {
      root = await canonicalRoot(typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd())
      return await readStateViaCliEnriched(ctx, root, run)
    } catch (cliError) {
      try {
        return markDegraded(await panelStateReader(ctx)(cwd), cliError)
      } catch (fallbackError) {
        return {
          ok: false,
          error: brief(fallbackError),
          readPath: 'direct',
          degraded: true,
          degradedReason: `cli-unavailable: ${brief(cliError)}`.slice(0, 300),
        }
      }
    }
  }
}


/**
 * Seam-shaped reader for the HTTP route: `(request, {deadlineMs}) => Promise<result>`,
 * where `result` is the `{ok:true,payload}` | `{ok:false,code,message}` union
 * `collectPanelState` already understands.
 *
 * **Prepared, not wired yet.** The route still calls
 * `mountJsonRoute(ctx, ROUTE_PATH, 'state route', handleState)`. Switching it needs the
 * injectable read seam in lib/host/state.mjs (owner: concurrency, T-20261112202457).
 * Once that lands the mount line becomes:
 *
 *   mountJsonRoute(ctx, ROUTE_PATH, 'state route', (scope, request, response) =>
 *     handleState(scope, request, response, {
 *       readSnapshot: cliStateSnapshotReader(scope, {
 *         fallbackSnapshot: (req, ctx) => stateSnapshot(scope, req, ctx),
 *       }),
 *       deadlineMs: CLI_STATE_TIMEOUT_MS,
 *     }))
 *
 * Budget: the CLI gets at most 45% of `deadlineMs` (capped at 900 ms); the fallback
 * gets the remaining budget, so the route's total stays inside the 1800 ms contract.
 * Without an injected `fallbackSnapshot` the fallback is the legacy in-process
 * `panelStateReader` (its own worker deadline applies); production wiring must pass
 * `stateSnapshot` so the fallback honours the remaining budget.
 */
export function cliStateSnapshotReader(ctx, options = {}) {
  const run = typeof options.runCliState === 'function' ? options.runCliState : runCliState
  const fallbackSnapshot = typeof options.fallbackSnapshot === 'function'
    ? options.fallbackSnapshot
    : async (request) => {
        const direct = await panelStateReader(ctx)(request.root)
        if (direct === null || typeof direct !== 'object') return null
        return { ok: true, payload: direct }
      }
  return async function readSnapshot(request, context = {}) {
    const root = request !== null && typeof request === 'object' && typeof request.root === 'string' ? request.root : ''
    const deadlineMs =
      Number.isFinite(context.deadlineMs) && context.deadlineMs > 0 ? context.deadlineMs : CLI_STATE_TIMEOUT_MS
    const started = Date.now()
    const cliBudget = Math.max(250, Math.min(900, Math.floor(deadlineMs * 0.45)))
    try {
      const payload = await run(root, cliBudget)
      if (payload === null || typeof payload !== 'object') {
        throw new Error('flow state returned a non-object payload')
      }
      payload.readPath = 'cli'
      return { ok: true, payload }
    } catch (error) {
      const remaining = Math.max(200, deadlineMs - (Date.now() - started))
      const fallback = await fallbackSnapshot(request, { deadlineMs: remaining })
      if (fallback === null || typeof fallback !== 'object') {
        return { ok: false, code: 'state-cli-unavailable', message: `cli-unavailable: ${brief(error)}` }
      }
      if (fallback.ok === true && fallback.payload !== null && typeof fallback.payload === 'object') {
        markDegraded(fallback.payload, error)
      }
      return fallback
    }
  }
}
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

  /* Routes mount through the optional-service plumbing, not a static entry
     dependency: the web/desktop host provides `webServer`, the TUI host never
     does. Before 2026-11-09 this file declared `inject = ['webServer']`, so the
     whole entry (tools, skills, guards, capture, heartbeat) was dead in the
     TUI. `provide` defers until the service appears and stays a no-op when it
     never does — the two hosts now share one entry with one behaviour. */
  provide(ctx, 'webServer', label, (scoped) => {
    const webServer = service(scoped, 'webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return () => {}
    const dispose = webServer.register(route)
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // Disposal must never throw into the host.
      }
    }
  })
}

export function apply(ctx, config) {
  // `apply` may run again in a long-lived host: drop diagnostics from the
  // previous mount so a successful re-apply never reports stale failures. A
  // still-broken core re-adds its message every time.
  mountWarnings.length = 0
  if (coreAvailable() === false) warnMount(coreUnavailableMessage(), ctx)
  // 2026-11-11 用户口径：**取消"每句话都是任务"**。捕获改为显式 opt-in
  // （`config.capture: true` 才开），默认不建卡、不做捕获——任务由主会话分析后
  // 用 flow_task add 主动创建，插件只负责派工与流转。
  const captureEnabled = isPlainObject(config) === true && config.capture === true
  const settings = {
    heartbeatGate: heartbeatGateEnabled(config),
    claims: claimsGateEnabled(config),
    backupReminder: backupReminderEnabled(config),
    // 消息卡自动收口窗口（小时；0=关闭）：config.tasks.autoSweepHours
    autoSweepHours: autoSweepHoursOf(config),
    capture: captureEnabled,
    enforce: enforceEnabled(config),
    // `single` today (one role); P3 flips the default to `team` once the plugin
    // actually dispatches analyzer/implementer/reviewer work.
    actorMode: resolveActorMode(config, ctx),
    boardMode: resolveBoardMode(config, ctx),
    // 捕获即派工（2026-11-11）：默认跟随 config.dispatch.auto；宿主没有 subagents 服务时自动跳过。
    allowMainDispatch: allowMainDispatchOf(config),
    autoDispatch: autoDispatchEnabled(config),
    dispatchProvider: dispatchProvider(config),
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
    registerHeartbeatKeepalive(ctx, captureState, settings)
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
