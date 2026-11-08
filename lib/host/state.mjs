// project-flow — Host state read path: the forked state worker pool, the
// request-scoped snapshot call, the HTTP state route, the panel-state assembly
// and the TUI reader. Split out of index.js so the read seam has its own write
// region (docs/module-boundaries.md).

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
} from '../state-snapshot.mjs'
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
} from '../plugin/shared.mjs'
// The one mount implementation: service lookup, ctx.effect registration, the
// core-warning wrapper and the mount-warning channel are shared with the three
// module sub-plugins (tasks.js / gates.js / experiments.js).
import { STAGE_ZH, actorForEdge, edgeOf, nextStages } from '../stage.mjs'
import { readTeamBoard, reconcileLinks, teamStatusOf } from '../team-sync.mjs'
import { buildDefinition as buildSubtaskDefinition } from '../tools/subtasks.mjs'
import { answerDecisionAndApply, applyVetoAnswer, vetoSubtask, vetoTask } from '../veto.mjs'
import { commandNameOf, parseCommand } from '../commands.mjs'
import {
  buildStatusBlock,
  createCaptureState,
  flushCapture,
  noteCaptureGate,
  recordPreStep,
  stackTop,
  textOfContent,
} from '../capture.mjs'
import {
  mountWarnings,
  provide,
  registerToolDefinitions,
  service,
  toolDeps,
  warnMount,
} from '../plugin/mount.mjs'
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
} from './shared.mjs'
import {
  agentRoot,
  applyAgentLiveness,
  applyHeartbeatVisibility,
  captureEnabled,
  heartbeatGateEnabled,
  heartbeatGuardReason,
  heartbeatRootOf,
  registerAgentCreated,
  registerAgentDisposed,
  registerDisciplineSection,
  registerHeartbeatKeepalive,
  registerTurnReminder,
  requireSession,
  rootSessionVerdict,
  sessionIdOf,
  usableSessionId,
  ROOT_SESSION_DECISION_ONLY,
  ROOT_SESSION_HEARTBEAT_ONLY,
} from './session.mjs'
import { handleGate, handleInit } from '../host/routes.mjs'
import { applyTeamBoard } from './team.mjs'

// ------------------------------------------------------- state read isolation
//
// The blocking part of a state request is the store read: core's readers are
// synchronous, `resolveHeartbeatWorkspace` shells out to git, and a root on a hung
// mount can park a thread in a syscall for seconds. That work therefore runs in a
// forked child, never on the host event loop.
//
// `child_process.fork` (not `worker_threads`): a worker's `terminate()` cannot
// interrupt a blocked syscall (measured >3s on a FIFO), while fork + SIGKILL
// reclaims the process in ~3ms. The deadline is the host's only hard guarantee.
//
// The pool is per `apply()` (a WeakMap keyed by ctx), so a re-apply disposes the
// previous children instead of leaking them. A child is referenced only while a
// fork is warming or a request is in flight (so the host stays alive until the
// answer lands) and unref'd while idle (so an idle pool never keeps a test
// process alive). Children exit on IPC disconnect and never write to
// stdout/stderr (stdio: ignore).

const STATE_DEADLINE_MS = 1800
const STATE_READY_MS = 4000
const STATE_MAX_IDLE = 1
const STATE_MAX_CHILDREN = 8

/**
 * Test seam: lowering the child cap requires an explicit opt-in pair, so a
 * production host can never be pushed below its real capacity by a stray env
 * var (`PF_STATE_MAX_CHILDREN` alone is ignored).
 */
export function stateMaxChildren() {
  if (process.env.PF_STATE_MAX_CHILDREN_ALLOW !== '1') return STATE_MAX_CHILDREN
  const raw = Number(process.env.PF_STATE_MAX_CHILDREN)
  return Number.isInteger(raw) && raw > 0 ? raw : STATE_MAX_CHILDREN
}

const STATE_WORKER_DEFAULT_SCRIPT = fileURLToPath(new URL('../state-snapshot.mjs', import.meta.url))

/**
 * Test seam: pointing the pool at another worker script requires an explicit
 * opt-in env pair, so a production host can never be redirected by a stray
 * `PF_STATE_WORKER_SCRIPT` in its environment.
 */
export function stateWorkerScript() {
  const allowed = process.env.PF_STATE_WORKER_SCRIPT_ALLOW === '1'
  const override =
    allowed && typeof process.env.PF_STATE_WORKER_SCRIPT === 'string' ? process.env.PF_STATE_WORKER_SCRIPT.trim() : ''
  return override === '' ? STATE_WORKER_DEFAULT_SCRIPT : override
}

/**
 * Environment one read worker needs: git resolution, the temp directory, the
 * locale and the clock. Nothing else is inherited — the child only reads the
 * store and has no use for the host's credentials or session variables.
 */
export function stateWorkerEnv() {
  const env = { PF_STATE_WORKER: '1' }
  const passthrough = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'SystemRoot',
    'SYSTEMROOT',
    'APPDATA',
    'LOCALAPPDATA',
  ]
  for (const name of passthrough) {
    const value = process.env[name]
    if (typeof value === 'string' && value !== '') env[name] = value
  }
  return env
}

export const STATE_POOLS = new WeakMap()

/** The pool of the ctx that ran `apply`; undefined for a bare test double. */
export function statePoolOf(ctx) {
  try {
    return STATE_POOLS.get(ctx)
  } catch {
    return undefined
  }
}

/**
 * One fork()ed read worker: JSON in, JSON out over the IPC channel.
 *
 * A slot is `{ child, ready, busy }`; a request owns exactly one child until it
 * settles (reply, deadline, crash), so two requests never interleave inside one
 * child and a hung read cannot poison its neighbour.
 */
export class StateWorkerPool {
  constructor() {
    this.children = new Set()
    this.pending = new Map()
    this.seq = 0
    this.disposed = false
    /** Child cap for this pool (production 8; the test seam may lower it). */
    this.maxChildren = stateMaxChildren()
    /** In-flight warm-up fork; a second request must await it instead of forking again. */
    this.starting = undefined
  }

  /** How many children are ready and unclaimed. */
  idleCount() {
    let count = 0
    for (const slot of this.children) {
      if (slot.ready === true && slot.busy === false) count += 1
    }
    return count
  }

  /**
   * Claim one ready, idle child atomically: it is marked busy (and referenced)
   * before it is handed out, so two concurrent requests can never share a child.
   */
  takeIdle() {
    for (const slot of this.children) {
      if (slot.ready === true && slot.busy === false) {
        slot.busy = true
        this.refSlot(slot)
        return slot
      }
    }
    return undefined
  }

  /**
   * Obtain a slot for one request.
   *
   * `snapshot()` calls this for every read, so a cold burst (N requests in the
   * same tick) must get N children, up to the cap — never just the keep-warm
   * spare. An idle child is claimed atomically. When the pool is cold, the warm-up in
   * flight is awaited and its result is claimed — never handed out blind: a
   * second concurrent request that loses the race spawns its own child instead
   * of reusing the first request's busy one (the bug where a hung read took a
   * normal read down with it). At the child cap the request is refused rather
   * than forking a K-th ~59MB child.
   *
   * @returns {Promise<object|undefined>} a claimed slot, or undefined
   */
  async acquire() {
    if (this.disposed) return undefined
    const claimed = this.takeIdle()
    if (claimed !== undefined) return claimed
    for (let guard = 0; guard < this.maxChildren * 2; guard += 1) {
      if (this.disposed) return undefined
      // Real saturation: every child the cap allows is already in flight.
      if (this.children.size >= this.maxChildren) return undefined
      if (this.starting !== undefined) {
        const starting = this.starting
        try {
          await starting
        } catch {
          return undefined
        }
        const slot = this.takeIdle()
        if (slot !== undefined) return slot
        continue
      }
      // Cold pool / burst: fork one child for this request and claim it. Routing
      // this through `ensureWarm` would stop at the keep-warm spare (ONE idle
      // child), so a third concurrent request would be refused while the pool was
      // nowhere near `STATE_MAX_CHILDREN`.
      try {
        await this.spawn()
      } catch {
        return undefined
      }
      const slot = this.takeIdle()
      if (slot !== undefined) return slot
    }
    return undefined
  }

  /** Keep one spare warm so the next poll does not pay the fork cost. */
  ensureWarm() {
    if (this.disposed) return
    if (this.idleCount() >= STATE_MAX_IDLE) return
    if (this.starting !== undefined) return
    if (this.children.size >= this.maxChildren) return
    const starting = this.spawn()
    this.starting = starting
    starting.then(
      () => {
        if (this.starting === starting) this.starting = undefined
      },
      () => {
        if (this.starting === starting) this.starting = undefined
      },
    )
  }

  /** Fork one child and resolve the slot once it reports ready. */
  spawn() {
    if (this.disposed) return Promise.reject(new Error('state worker pool is disposed'))
    let child
    try {
      child = fork(stateWorkerScript(), [], {
        cwd: PACKAGE_ROOT,
        // No pipes to drain: stdout/stderr are discarded, only IPC remains.
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json',
        env: stateWorkerEnv(),
        execArgv: [],
      })
    } catch (error) {
      return Promise.reject(error)
    }
    const slot = { child, ready: false, busy: false }
    this.children.add(slot)
    // Referenced until ready (an awaiting request must keep the host alive), then
    // unreferenced for the idle life of the pool.
    this.refSlot(slot)
    const ready = new Promise((settle, fail) => {
      const timer = setTimeout(() => {
        this.kill(slot)
        fail(new Error(`state worker did not report ready within ${STATE_READY_MS}ms`))
      }, STATE_READY_MS)
      if (typeof timer.unref === 'function') timer.unref()
      slot.onReady = () => {
        clearTimeout(timer)
        settle(slot)
      }
      slot.onStartFail = (error) => {
        clearTimeout(timer)
        fail(error)
      }
    })
    child.on('message', (message) => this.onMessage(slot, message))
    child.on('error', (error) => this.onChildFailure(slot, error))
    child.on('exit', (code, signal) => this.onChildExit(slot, code, signal))
    return ready
  }

  /** A pending request must keep the host alive; an idle pool must never do so. */
  refSlot(slot) {
    try {
      if (typeof slot.child.ref === 'function') slot.child.ref()
      if (slot.child.channel !== null && slot.child.channel !== undefined && typeof slot.child.channel.ref === 'function') {
        slot.child.channel.ref()
      }
    } catch {
      // ignore
    }
  }

  unrefSlot(slot) {
    try {
      if (typeof slot.child.unref === 'function') slot.child.unref()
      if (slot.child.channel !== null && slot.child.channel !== undefined && typeof slot.child.channel.unref === 'function') {
        slot.child.channel.unref()
      }
    } catch {
      // ignore
    }
  }

  onMessage(slot, message) {
    if (message === null || typeof message !== 'object') return
    if (message.type === 'ready') {
      slot.ready = true
      this.unrefSlot(slot)
      const onReady = slot.onReady
      slot.onReady = null
      if (typeof onReady === 'function') onReady()
      return
    }
    const pending = this.pending.get(message.id)
    if (pending === undefined || pending.slot !== slot) return
    if (message.ok === true) {
      pending.finish({ ok: true, payload: message.payload })
      return
    }
    const error = message.error !== null && typeof message.error === 'object' ? message.error : {}
    pending.finish({
      ok: false,
      code: typeof error.code === 'string' && error.code !== '' ? error.code : 'state-internal',
      message: typeof error.message === 'string' && error.message !== '' ? error.message : 'state snapshot failed',
    })
  }

  onChildFailure(slot, error) {
    const onStartFail = slot.onStartFail
    slot.onStartFail = null
    if (typeof onStartFail === 'function') onStartFail(error)
    this.retire(slot, { ok: false, code: 'state-worker-crashed', message: brief(error, 300) })
  }

  onChildExit(slot, code, signal) {
    const onStartFail = slot.onStartFail
    slot.onStartFail = null
    if (typeof onStartFail === 'function') {
      onStartFail(new Error(`state worker exited before ready (code ${String(code)}, signal ${String(signal)})`))
    }
    this.retire(slot, {
      ok: false,
      code: 'state-worker-crashed',
      message: `state worker exited (code ${String(code)}, signal ${String(signal)})`,
    })
  }

  /** Drop one slot and settle everything that still waited on it. */
  retire(slot, failure) {
    const wasReady = slot.ready === true
    slot.ready = false
    this.children.delete(slot)
    for (const [id, pending] of this.pending) {
      if (pending.slot !== slot) continue
      this.pending.delete(id)
      pending.finish(failure)
    }
    // A crashed worker must not take the endpoint down: the next request rebuilds.
    if (this.disposed === false && wasReady === true) this.ensureWarm()
  }

  kill(slot) {
    slot.ready = false
    try {
      slot.child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }

  /** Drain one snapshot request with the deadline as the only hard stop. */
  call(slot, request) {
    return new Promise((resolve) => {
      const id = ++this.seq
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(id)
        slot.busy = false
        this.unrefSlot(slot)
        if (this.disposed === false) this.ensureWarm()
        resolve(value)
      }
      const timer = setTimeout(() => {
        this.kill(slot)
        finish({
          ok: false,
          code: 'state-timeout',
          message: `store read exceeded ${STATE_DEADLINE_MS}ms`,
        })
      }, STATE_DEADLINE_MS)
      this.pending.set(id, { slot, finish })
      try {
        slot.child.send({ id, type: 'snapshot', ...request }, (error) => {
          if (error === null || error === undefined) return
          finish({ ok: false, code: 'state-worker-crashed', message: brief(error, 300) })
        })
      } catch (error) {
        finish({ ok: false, code: 'state-worker-crashed', message: brief(error, 300) })
      }
    })
  }

  /** The public one-request call: claim a child, then enforce the deadline. */
  async snapshot(request) {
    if (this.disposed) return { ok: false, code: 'state-worker-unavailable', message: 'state worker pool is disposed' }
    this.ensureWarm()
    const slot = await this.acquire()
    if (slot === undefined) {
      return {
        ok: false,
        code: 'state-worker-unavailable',
        message: this.disposed
          ? 'state worker pool is disposed'
          : `state worker pool saturated (max ${this.maxChildren} read children); retry`,
      }
    }
    return await this.call(slot, request)
  }

  /** Kill every child and settle pending requests (apply disposal). */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.finish({ ok: false, code: 'state-worker-unavailable', message: 'state worker pool disposed' })
    }
    for (const slot of this.children) {
      this.kill(slot)
      try {
        if (typeof slot.child.disconnect === 'function') slot.child.disconnect()
      } catch {
        // ignore
      }
    }
    this.children.clear()
  }
}

/**
 * One snapshot for the requested root: through the ctx's worker pool when the
 * host ran `apply`, in-process otherwise (a bare unit-test double).
 */
async function requestStateSnapshot(ctx, request) {
  const pool = statePoolOf(ctx)
  if (pool !== undefined) return await pool.snapshot(request)
  try {
    return { ok: true, payload: await buildSnapshot(request) }
  } catch (error) {
    return { ok: false, code: 'state-worker-unavailable', message: brief(error, 300) }
  }
}

export async function handleState(host, request, response) {
  let url
  try {
    url = new URL(String(request.url ?? ROUTE_PATH), 'http://localhost')
  } catch (error) {
    sendError(response, 400, 'bad-request', brief(error))
    return
  }

  const method = String(request.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    try {
      response.setHeader('allow', 'GET')
    } catch {
      // ignore
    }
    sendError(response, 405, 'method-not-allowed')
    return
  }

  if (!originAllowed(host, request)) {
    sendError(response, 403, 'forbidden')
    return
  }

  const now = Date.now()

  // One registry enumeration per request: the projection below receives these
  // rows instead of listing the registry again.
  let workspaces
  try {
    workspaces = listWorkspaces(host)
  } catch (error) {
    sendError(response, 500, 'internal', brief(error))
    return
  }

  // Exactly one root: the workspace the panel asks for. There is no fallback to
  // another project — an uninitialized workspace reports its empty state.
  const requested = url.searchParams.get('root')
  let root
  if (requested !== null) {
    if (requested.trim().length === 0) {
      sendError(response, 400, 'bad-root', 'root must name the workspace directory')
      return
    }
    root = await canonicalRoot(requested)
    if ((await isDirectory(root)) === false) {
      sendError(response, 400, 'bad-root', `root is not an existing directory: ${root}`)
      return
    }
    if ((await rootAccepted(root, workspaces)) === false) {
      sendError(
        response,
        400,
        'unknown-root',
        'root is neither a registered workspace, inside one, nor a directory with a flow store',
      )
      return
    }
  } else {
    root = await canonicalRoot(process.cwd())
    // Without an explicit root there is no chosen workspace: it must both be
    // accepted and actually carry a ledger, otherwise nothing is scoped.
    if ((await rootAccepted(root, workspaces)) === false || (await hasStoreAsync(root)) === false) {
      sendJson(response, 200, {
        ok: false,
        generatedAt: isoLocal(new Date(now)),
        roots: [],
        root: null,
        error: { code: 'no-project', message: 'no workspace declares a flow store' },
      })
      return
    }
  }

  sendJson(response, 200, await collectPanelState(host, root, workspaces))
}

/**
 * The read-only payload for exactly one workspace: the `/api/project-flow/state`
 * response body and the TUI panel's read path are this one object.
 *
 * `workspaces` is required: the caller enumerates the registry exactly once and
 * passes the rows in, so no projection ever re-reads the registry inside the
 * same request. `ctx` is accepted for symmetry with the other handlers and is
 * not consulted for workspace discovery.
 *
 * The store read itself runs in the ctx's forked worker (`requestStateSnapshot`).
 * The host only resolves the root asynchronously, computes the display name and
 * applies the deadline, so a slow or hung root costs this request alone. A timed
 * out / crashed / unavailable worker becomes `ok:false` with a stable error code;
 * the endpoint still answers 200, exactly like `not-initialized`.
 */
/**
 * Top-level directory of the git worktree containing `root`, or '' when git
 * cannot answer. Async on purpose: the request path never blocks the host loop.
 */
function gitTopLevel(root) {
  return new Promise((settle) => {
    try {
      execFile(
        'git',
        ['-C', root, 'rev-parse', '--show-toplevel'],
        { timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => settle(error ? '' : String(stdout ?? '').trim()),
      )
    } catch {
      settle('')
    }
  })
}

/**
 * The directory whose ledger answers this request. A request coming from a
 * linked git worktree is redirected to the project's main worktree (the same
 * rule the heartbeat ledger uses); an ordinary folder keeps its own scope — a
 * nested folder must not silently inherit the parent repo's ledger.
 */
async function resolveLedgerRoot(root) {
  try {
    if (await hasStoreAsync(root)) return root
    const c = requireCore()
    if (c === null || typeof c.resolveHeartbeatWorkspace !== 'function') return root
    const resolved = c.resolveHeartbeatWorkspace(root)
    if (resolved === null || typeof resolved !== 'object') return root
    const ledger = typeof resolved.root === 'string' ? resolved.root : ''
    if (ledger === '' || ledger === root) return root
    const top = await gitTopLevel(root)
    if (top === '') return root
    if ((await canonicalRoot(top)) !== root) return root
    if ((await hasStoreAsync(ledger)) === false) return root
    return ledger
  } catch {
    return root
  }
}

export async function collectPanelState(ctx, root, workspaces) {
  if (!Array.isArray(workspaces)) {
    throw new TypeError('collectPanelState requires the caller to enumerate the workspace registry')
  }
  const now = Date.now()
  const entry = { path: root, name: await rootName(root, workspaces) }
  // The ledger may live in the project's main worktree while this panel was
  // asked for a linked worktree; resolve it before answering, so a worktree
  // session reads the shared ledger instead of an empty store.
  const ledgerRoot = await resolveLedgerRoot(root)
  if ((await hasStoreAsync(ledgerRoot)) === false) {
    return {
      ok: false,
      generatedAt: isoLocal(new Date(now)),
      root,
      roots: [entry],
      error: { code: 'not-initialized', message: `no flow store in ${ledgerRoot}; run: node bin/flow.mjs init` },
    }
  }

  // Warning channel across the fork boundary: the child's own core warnings travel
  // inside the payload (built from its core instance), while this process's core
  // warning buffer is drained and dropped — a 2.5s poll must never leave
  // diagnostics behind for the next tool call to copy into its result, which is
  // exactly the contract the in-process projection used to provide.
  takeCoreWarnings()
  const result = await requestStateSnapshot(ctx, {
    root,
    realRoot: root,
    ledgerRoot,
    entry: { path: entry.path, name: entry.name },
    hostWarnings: mountWarnings.slice(),
    now,
  })
  if (result.ok === true && result.payload !== null && typeof result.payload === 'object') {
    const payload = result.payload
    payload.root = root
    payload.roots = [{ path: entry.path, name: entry.name }]
    // Host agents 正向证据：live 会话打 liveness:'live'/reason:'agent-live'（dead 不覆盖）。
    // 顺序是「全量行 → agents 标注 → 宿主过滤」：快照层不做最终过滤，否则 stale 行
    // 在 agents 看到之前就消失了（task-143 修的语义缺口）。
    applyAgentLiveness(ctx, payload)
    // P3a: read-only team-board summary for the panel's team line. A missing
    // caller/service yields available:false (the client then hides the line).
    await applyTeamBoard(ctx, payload)
    return applyHeartbeatVisibility(payload)
  }
  return {
    ok: false,
    generatedAt: isoLocal(new Date(now)),
    root,
    roots: [{ path: entry.path, name: entry.name }],
    warnings: mountWarnings.slice(),
    error: {
      code: typeof result.code === 'string' && result.code !== '' ? result.code : 'state-worker-unavailable',
      message: typeof result.message === 'string' && result.message !== '' ? result.message : 'state read failed',
    },
  }
}

/**
 * The TUI panel's read path: resolve the workspace, reuse the HTTP projection,
 * and never throw into the panel host.
 */
export function panelStateReader(ctx) {
  return async function readPanelState(cwd) {
    try {
      // The panel reads the registry once, like the HTTP route does.
      const workspaces = listWorkspaces(ctx)
      const root = await canonicalRoot(typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd())
      return await collectPanelState(ctx, root, workspaces)
    } catch (error) {
      return { ok: false, error: brief(error) }
    }
  }
}
