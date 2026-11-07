// project-flow — Host half.
//
// Registers three JSON endpoints, all same-origin gated: one read endpoint,
// /api/project-flow/state, and two write endpoints, /api/project-flow/init
// (create the store of the requested workspace) and /api/project-flow/gate
// (toggle one gate's `enabled` flag). The read endpoint reports the store of
// exactly one workspace: the directory the panel passes as `?root=<dir>` (the
// current session workspace), or the process working directory when the
// parameter is omitted. A workspace with no `.dsh/flow` store is reported as a
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
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
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
import {
  buildStatusBlock,
  createCaptureState,
  flushCapture,
  recordPreStep,
  stackTop,
} from './lib/capture.mjs'
import {
  mountWarnings,
  provide,
  registerToolDefinitions,
  service,
  toolDeps,
  warnMount,
} from './lib/plugin/mount.mjs'
// Root resolver for the heartbeat/decision hooks, which only ever hold a ctx:
// the same factory the tool definitions are mounted with, bound once here.
const toolRoot = makeToolRoot({ service })
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const ROUTE_PATH = '/api/project-flow/state'
const INIT_ROUTE_PATH = '/api/project-flow/init'
const GATE_ROUTE_PATH = '/api/project-flow/gate'
const MAX_INIT_BODY_BYTES = 8 * 1024
const MAX_INIT_CREATED = 50
const MAX_INIT_WARNINGS = 20
const HEARTBEAT_GATE_TOOLS = new Set(['edit', 'write'])
const HEARTBEAT_SESSION_MAX = 80
const HEARTBEAT_SESSION_PATTERN = /^[A-Za-z0-9._:-]+$/


const SUBAGENT_ORIGIN = 'subagent'


// ------------------------------------------------------- workspace inspection


/** Async `hasStore` for the HTTP/panel request path. */
async function hasStoreAsync(root) {
  try {
    return (await stat(storeContractPath(root))).isFile()
  } catch {
    return false
  }
}


// ------------------------------------------------------------ workspace scope
//
// The panel is scoped to one workspace. There is no global candidate list any
// more: a requested root is canonicalized, validated against the registered
// workspaces (or its own manifest) and then read in isolation.
//
// Canonicalization is reserved for the root the caller names. Registered rows
// are compared lexically: a workspace on an unmounted disk must not turn every
// poll into a stat storm on the host event loop.

/** Canonical form of one path: resolved, then realpath when the path exists. */
async function canonicalRoot(path) {
  let resolved
  try {
    resolved = resolve(path)
  } catch {
    resolved = String(path)
  }
  try {
    return await realpath(resolved)
  } catch {
    return resolved
  }
}

/** Whether one path is an existing directory (async: request path only). */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory() === true
  } catch {
    return false
  }
}

/**
 * Pure-path form of one registered workspace row: `resolve` folds `..`, `.` and
 * a trailing separator without touching the filesystem. A filesystem root keeps
 * its separator.
 */
function workspacePath(value) {
  let resolved
  try {
    resolved = resolve(value)
  } catch {
    return String(value)
  }
  if (resolved.length > 1 && resolved.endsWith(sep) && dirname(resolved) !== resolved) {
    return resolved.slice(0, -sep.length)
  }
  return resolved
}

/**
 * The registered workspaces as `{ path, title }` rows. Paths are normalized by
 * pure path arithmetic, never by realpath/stat: an unavailable mount among the
 * registered rows costs this request nothing. An unavailable or broken registry
 * projection yields an empty list rather than an error: the endpoint then
 * accepts only roots with their own manifest.
 */
function listWorkspaces(ctx) {
  const workspaces = []
  let registry
  try {
    registry = ctx.get('workspaceRegistry')
  } catch {
    registry = undefined
  }
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return workspaces

  let rows
  try {
    rows = registry.list()
  } catch {
    return workspaces
  }
  for (const workspace of Array.isArray(rows) ? rows : []) {
    if (workspace === null || workspace === undefined) continue
    let path
    let title
    try {
      path = workspace.path
      title = workspace.title
    } catch {
      continue
    }
    if (typeof path !== 'string' || path.length === 0) continue
    workspaces.push({
      path: workspacePath(path),
      title: typeof title === 'string' ? title.trim() : '',
    })
  }
  return workspaces
}

/** Whether `root` is `base` itself or lives below it. */
function rootWithin(root, base) {
  if (root === base) return true
  const prefix = base.endsWith(sep) ? base : base + sep
  return root.startsWith(prefix)
}

/** Whether a root is a registered workspace, inside one, or declares its own flow store. */
async function rootAccepted(root, workspaces) {
  for (const workspace of workspaces) {
    if (rootWithin(root, workspace.path)) return true
  }
  return hasStoreAsync(root)
}

/**
 * Display name: the manifest name, else the title of the innermost registered
 * workspace containing the root (workspaces may nest, e.g. /Project and
 * /Project/app), else the folder name.
 */
async function rootName(root, workspaces) {
  if (await hasStoreAsync(root)) return await readManifestName(root)
  let owner
  for (const workspace of workspaces) {
    if (rootWithin(root, workspace.path) === false) continue
    if (owner === undefined || workspace.path.length > owner.path.length) owner = workspace
  }
  if (owner !== undefined) return owner.title.length > 0 ? owner.title : basename(root)
  return basename(root)
}


// ----------------------------------------------------------------------- HTTP

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sendError(response, status, code, message) {
  const error = { code }
  if (typeof message === 'string' && message.length > 0) error.message = message
  sendJson(response, status, { ok: false, error })
}

function originAllowed(ctx, request) {
  let origin
  try {
    origin = request.headers.origin
  } catch {
    origin = undefined
  }
  if (typeof origin !== 'string' || origin.length === 0) return true
  const webServer = service(ctx, 'webServer')
  let expected
  try {
    expected = webServer !== undefined && typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : undefined
  } catch {
    expected = undefined
  }
  if (typeof expected !== 'string' || expected.length === 0) return false
  return origin === expected
}

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
function stateMaxChildren() {
  if (process.env.PF_STATE_MAX_CHILDREN_ALLOW !== '1') return STATE_MAX_CHILDREN
  const raw = Number(process.env.PF_STATE_MAX_CHILDREN)
  return Number.isInteger(raw) && raw > 0 ? raw : STATE_MAX_CHILDREN
}

const STATE_WORKER_DEFAULT_SCRIPT = fileURLToPath(new URL('./lib/state-snapshot.mjs', import.meta.url))

/**
 * Test seam: pointing the pool at another worker script requires an explicit
 * opt-in env pair, so a production host can never be redirected by a stray
 * `PF_STATE_WORKER_SCRIPT` in its environment.
 */
function stateWorkerScript() {
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
function stateWorkerEnv() {
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

const STATE_POOLS = new WeakMap()

/** The pool of the ctx that ran `apply`; undefined for a bare test double. */
function statePoolOf(ctx) {
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
class StateWorkerPool {
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

async function handleState(host, request, response) {
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
async function collectPanelState(ctx, root, workspaces) {
  if (!Array.isArray(workspaces)) {
    throw new TypeError('collectPanelState requires the caller to enumerate the workspace registry')
  }
  const now = Date.now()
  const entry = { path: root, name: await rootName(root, workspaces) }

  if ((await hasStoreAsync(root)) === false) {
    return {
      ok: false,
      generatedAt: isoLocal(new Date(now)),
      root,
      roots: [entry],
      error: { code: 'not-initialized', message: `no flow store in ${root}; run: node bin/flow.mjs init` },
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

// ------------------------------------------------------------------ init HTTP
//
// One of the two writes on the HTTP surface. It never touches the store
// directly: after the same root scoping as the read endpoint it hands the
// directory to lib/core.mjs, so validation, locking and the atomic write stay
// in one place.

/**
 * Read the request body as UTF-8 text, bounded by `limit` bytes. Oversized
 * bodies resolve immediately with `{ tooLarge: true }` and are drained in the
 * background, so the caller can answer 400 without waiting for — or stalling on
 * — the rest of the stream. A request without a readable stream yields ''.
 */
function readBody(request, limit = MAX_INIT_BODY_BYTES) {
  return new Promise((settle) => {
    if (request === null || request === undefined || typeof request.on !== 'function') {
      settle({ text: '', tooLarge: false })
      return
    }
    const chunks = []
    let size = 0
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      settle(result)
    }
    request.on('data', (chunk) => {
      if (done) return
      let buffer
      try {
        buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      } catch {
        return
      }
      size += buffer.length
      if (size > limit) {
        finish({ text: '', tooLarge: true })
        // Keep consuming (and ignoring) the rest instead of leaving the socket
        // paused: the response is already on its way.
        try {
          if (typeof request.resume === 'function') request.resume()
        } catch {
          // ignore
        }
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => finish({ text: Buffer.concat(chunks).toString('utf8'), tooLarge: false }))
    request.on('error', () => finish({ text: '', tooLarge: false }))
  })
}

async function handleInit(ctx, request, response) {
  const method = String(request.method ?? 'POST').toUpperCase()
  if (method !== 'POST') {
    try {
      response.setHeader('allow', 'POST')
    } catch {
      // ignore
    }
    sendError(response, 405, 'method-not-allowed')
    return
  }

  if (!originAllowed(ctx, request)) {
    sendError(response, 403, 'forbidden')
    return
  }

  const body = await readBody(request)
  if (body.tooLarge) {
    sendError(response, 400, 'bad-request', `request body exceeds ${MAX_INIT_BODY_BYTES} bytes`)
    return
  }

  let parsed
  try {
    parsed = JSON.parse(body.text)
  } catch (error) {
    sendError(response, 400, 'bad-request', brief(error))
    return
  }
  if (!isPlainObject(parsed)) {
    sendError(response, 400, 'bad-request', 'request body must be a JSON object')
    return
  }

  const requested = parsed.root
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    sendError(response, 400, 'bad-root', 'root must name the workspace directory')
    return
  }
  const root = await canonicalRoot(requested)
  if ((await isDirectory(root)) === false) {
    sendError(response, 400, 'bad-root', `root is not an existing directory: ${root}`)
    return
  }

  let workspaces
  try {
    workspaces = listWorkspaces(ctx)
  } catch (error) {
    sendError(response, 500, 'internal', brief(error))
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

  const name = await rootName(root, workspaces)

  let result
  try {
    // The shared writer: requireCore() reports an unavailable lib/core.mjs in a
    // readable message instead of taking the plugin down.
    const c = requireCore()
    result = c.initProject(root, { name })
  } catch (error) {
    const conflict = error !== null && error !== undefined && typeof error === 'object' && error.code === 'conflict'
    sendError(response, conflict ? 409 : 500, 'init-failed', brief(error, 300))
    return
  }

  const created = Array.isArray(result?.created)
    ? result.created.filter((item) => typeof item === 'string').slice(0, MAX_INIT_CREATED)
    : []
  const warnings = Array.isArray(result?.warnings)
    ? result.warnings.filter((item) => typeof item === 'string').slice(0, MAX_INIT_WARNINGS)
    : []
  // Nothing created + the writer's own "already-initialized" warning means the
  // store was there before this call.
  const alreadyInitialized = created.length === 0 && warnings.some((line) => line.startsWith('already-initialized:'))

  sendJson(response, 200, {
    ok: true,
    root,
    name,
    alreadyInitialized,
    created,
    warnings,
  })
}

// ------------------------------------------------------------------ gate HTTP
//
// The second write on the HTTP surface: toggle one gate's `enabled` flag. Root
// scoping, body limits and same-origin gating are identical to the init
// endpoint; the store is only reached through lib/core.mjs (`updateGate`).

async function handleGate(ctx, request, response) {
  const method = String(request.method ?? 'POST').toUpperCase()
  if (method !== 'POST') {
    try {
      response.setHeader('allow', 'POST')
    } catch {
      // ignore
    }
    sendError(response, 405, 'method-not-allowed')
    return
  }

  if (!originAllowed(ctx, request)) {
    sendError(response, 403, 'forbidden')
    return
  }

  const body = await readBody(request)
  if (body.tooLarge) {
    sendError(response, 400, 'bad-request', `request body exceeds ${MAX_INIT_BODY_BYTES} bytes`)
    return
  }

  let parsed
  try {
    parsed = JSON.parse(body.text)
  } catch (error) {
    sendError(response, 400, 'bad-request', brief(error))
    return
  }
  if (!isPlainObject(parsed)) {
    sendError(response, 400, 'bad-request', 'request body must be a JSON object')
    return
  }

  const requested = parsed.root
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    sendError(response, 400, 'bad-root', 'root must name the workspace directory')
    return
  }
  const root = await canonicalRoot(requested)
  if ((await isDirectory(root)) === false) {
    sendError(response, 400, 'bad-root', `root is not an existing directory: ${root}`)
    return
  }

  let workspaces
  try {
    workspaces = listWorkspaces(ctx)
  } catch (error) {
    sendError(response, 500, 'internal', brief(error))
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

  const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
  if (id.length === 0) {
    sendError(response, 400, 'bad-request', 'id must name a gate')
    return
  }
  if (typeof parsed.enabled !== 'boolean') {
    sendError(response, 400, 'bad-request', 'enabled must be a boolean')
    return
  }
  if ((await hasStoreAsync(root)) === false) {
    sendError(response, 400, 'bad-request', `no flow store in ${root}; run: node bin/flow.mjs init`)
    return
  }

  let gate
  try {
    const c = requireCore()
    const loaded = c.loadContract(root)
    gate = c.updateGate(root, loaded.contract, id, { enabled: parsed.enabled })
  } catch (error) {
    sendError(response, 500, 'internal', brief(error, 300))
    return
  }

  sendJson(response, 200, {
    ok: true,
    root,
    gate: {
      id: isPlainObject(gate) && typeof gate.id === 'string' ? gate.id : id,
      enabled: isPlainObject(gate) && typeof gate.enabled === 'boolean' ? gate.enabled : parsed.enabled,
    },
  })
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

// --------------------------------------------------------------- heartbeats
//
// A heartbeat is the per-session registration that tells the panel and the
// other sessions what this agent is doing and which files it owns. The tool
// writes through lib/core.mjs; the two hooks below only *read* it, and every
// failure degrades to "unknown" instead of blocking the host.

/** The session id of one tool run: the agent id, then `DSH_SESSION_ID`. */
function sessionIdOf(exec) {
  let id
  try {
    id = exec !== null && exec !== undefined && exec.agent !== undefined ? exec.agent.id : undefined
  } catch {
    id = undefined
  }
  if (typeof id === 'string' && id.trim().length > 0) return id.trim()
  const env = typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID.trim() : ''
  return env.length > 0 ? env : undefined
}

/**
 * A session id that can safely name a heartbeat file. Core validates its own
 * input; this pre-check only keeps a hostile or empty id out of the hooks (a
 * hook cannot report a usage error to anyone).
 */
function usableSessionId(value) {
  if (typeof value !== 'string') return ''
  const session = value.trim()
  if (session.length === 0 || session.length > HEARTBEAT_SESSION_MAX) return ''
  if (session.includes('..') || session.includes('/') || session.includes('\\')) return ''
  return HEARTBEAT_SESSION_PATTERN.test(session) ? session : ''
}

/** Session id for a tool call, or an actionable error. */
function requireSession(exec) {
  const session = sessionIdOf(exec)
  if (session === undefined) {
    throw new Error(
      'flow_heartbeat needs a session: this run exposes no agent id and DSH_SESSION_ID is unset (pass the tool from a live agent session)',
    )
  }
  return session
}

/**
 * Session ids the optional host `agents` service reports as live: roots plus
 * every live agent. `null` when the host does not expose the service, so callers
 * can tell "no evidence" from "evidence says nobody is live".
 */
function liveSessionIds(ctx) {
  const agents = service(ctx, 'agents')
  if (agents === undefined || agents === null) return null
  const ids = new Set()
  const add = (value) => {
    const id = usableSessionId(isPlainObject(value) ? value.id : value)
    if (id !== '') ids.add(id)
  }
  for (const method of ['roots', 'list']) {
    try {
      if (typeof agents[method] !== 'function') continue
      const value = agents[method]()
      if (Array.isArray(value)) {
        for (const agent of value) add(agent)
      }
    } catch {
      // An unavailable registry is "no evidence", never a hard failure.
    }
  }
  return ids
}

/** Whether the host agent registry reports this session as live right now. */
function sessionIsLive(ctx, session) {
  const id = usableSessionId(session)
  if (id === '') return false
  const agents = service(ctx, 'agents')
  if (agents === undefined || agents === null) return false
  try {
    if (typeof agents.get === 'function' && agents.get(id) !== undefined && agents.get(id) !== null) return true
  } catch {
    // Fall through to the list projection.
  }
  const ids = liveSessionIds(ctx)
  return ids !== null && ids.has(id)
}

/**
 * Apply the host's positive evidence to the state payload's heartbeat rows: a
 * session the `agents` service reports live becomes `liveness: 'live'` /
 * `reason: 'agent-live'` — a busy session that has not refreshed its heartbeat
 * for >6 h is alive, not dead. A row the core judged `dead` is never overwritten
 * (pid evidence is stronger). The state payload projects heartbeats as a plain
 * row array (the panel derives its own counts), so only rows are touched.
 */
function applyAgentLiveness(ctx, payload) {
  if (isPlainObject(payload) === false || Array.isArray(payload.heartbeats) === false) return payload
  const live = liveSessionIds(ctx)
  if (live === null) return payload
  for (const item of payload.heartbeats) {
    if (isPlainObject(item) === false || item.liveness === 'dead') continue
    const session = usableSessionId(item.session)
    if (session === '' || live.has(session) === false) continue
    item.liveness = 'live'
    item.reason = 'agent-live'
  }
  return payload
}

/**
 * Final heartbeat visibility on the host side: `heartbeats` stays a row array
 * (old clients keep working), hidden rows are dropped, and the count is exposed
 * as the optional `heartbeatsHidden` field. Pure in-memory filtering — the read
 * path never writes or deletes heartbeat files.
 */
function applyHeartbeatVisibility(payload) {
  if (isPlainObject(payload) === false || Array.isArray(payload.heartbeats) === false) return payload
  const rows = payload.heartbeats
  const kept = rows.filter((item) => heartbeatRowVisible(item))
  payload.heartbeats = kept
  payload.heartbeatsHidden = rows.length - kept.length
  return payload
}

/** Project root of one live agent, using the same resolution as the tools. */
function agentRoot(ctx, agent) {
  try {
    return toolRoot(ctx, {}, { agent })
  } catch {
    return undefined
  }
}

/**
 * Whether the session's heartbeat is `working`: `true` / `false`, or `null`
 * when it cannot be decided (no store, no core, unsafe session id, broken
 * record). Hooks treat `null` as "do not interfere".
 *
 * `live` is the host `agents` positive evidence: a live session whose heartbeat
 * is merely stale (>6 h without a refresh) still counts as working — core's
 * `heartbeatStatus(..., {live:true})` applies that override. A record core judges
 * `dead` is never revived.
 */
function heartbeatWorking(root, session, live) {
  if (typeof root !== 'string' || root.length === 0) return null
  if (hasStore(root) === false) return null
  const c = coreModule()
  if (c === null || typeof c.heartbeatStatus !== 'function') return null
  const id = usableSessionId(session)
  if (id === '') return null
  try {
    const loaded = c.loadContract(root)
    const status = c.heartbeatStatus(root, loaded.contract, id)
    if (status === null || typeof status !== 'object') return null
    const working = status.record?.status === 'working'
    if (working !== true) return false
    if (status.active === true) return true
    if (live === true && status.liveness !== 'dead') {
      const revived = c.heartbeatStatus(root, loaded.contract, id, { live: true })
      return revived !== null && typeof revived === 'object' && revived.active === true
    }
    return false
  } catch {
    return null
  }
}


/**
 * Whether one live agent is a *root* (main) session: `true`, `false`, or `null`
 * when it cannot be decided.
 *
 * The host registry is authoritative (see `@deepseek-ai/dsh-agent`): `roots()`
 * returns the live top-level agents — those entered without an owner — and
 * `get(id)` returns any live agent, so a live agent missing from `roots()` is a
 * subagent. Identity is checked first; the id fallback tolerates a tool call
 * receiving a detached agent record. Sessions whose runtime relation is not
 * visible fall back to the durable session header: `origin === 'subagent'` (or
 * `delegationDepth > 0`) marks a delegated child, while a fork stays a root.
 */
function rootSessionVerdict(ctx, agent) {
  if (agent === null || agent === undefined || typeof agent !== 'object') return null
  let id = ''
  try {
    if (typeof agent.id === 'string') id = agent.id.trim()
  } catch {
    id = ''
  }
  try {
    const agents = service(ctx, 'agents')
    if (agents !== undefined) {
      if (typeof agents.roots === 'function') {
        const roots = agents.roots()
        if (Array.isArray(roots)) {
          if (roots.includes(agent)) return true
          if (id !== '' && roots.some((root) => root !== null && typeof root === 'object' && root.id === id)) return true
        }
      }
      if (id !== '' && typeof agents.get === 'function') {
        const live = agents.get(id)
        // A live agent that is not a root is a subagent; an unknown id proves
        // nothing (test doubles, detached exec records) and falls through.
        if (live !== undefined && live !== null) return false
      }
    }
  } catch {
    // Fall through to the durable header.
  }
  let header
  try {
    header = agent.session !== null && agent.session !== undefined ? agent.session.header : undefined
  } catch {
    header = undefined
  }
  if (isPlainObject(header)) {
    if (header.origin === SUBAGENT_ORIGIN) return false
    if (Number.isInteger(header.delegationDepth) && header.delegationDepth > 0) return false
    return true
  }
  return null
}

/** Human-readable refusal for a heartbeat write attempted from a subagent. */
const ROOT_SESSION_HEARTBEAT_ONLY =
  'flow_heartbeat start/update/end only serve main sessions: this call runs in a subagent session, which does not keep a heartbeat. Report progress in the child final message; only the parent (main) session registers and closes a heartbeat.'

/**
 * Human-readable refusal for a decision write attempted from a subagent. The
 * decision ledger is the main session's conversation with the user: a subagent
 * cannot see the answer, so it reports the pending item in its final message and
 * the main session opens or closes the D record.
 */
const ROOT_SESSION_DECISION_ONLY =
  'flow_decision ask/answer/withdraw/gc only serve main sessions: this call runs in a subagent session, which cannot open or close a decision record. Report the pending decision in the child final message; only the parent (main) session creates and closes a D record.'

/** Resolve the heartbeat ledger root (the project main worktree); degrade to the workspace root. */
function heartbeatRootOf(root) {
  try {
    const c = coreModule()
    if (c !== null && typeof c.resolveHeartbeatWorkspace === 'function') {
      const resolved = c.resolveHeartbeatWorkspace(root)
      if (isPlainObject(resolved) && typeof resolved.root === 'string' && resolved.root.length > 0) {
        return {
          root: resolved.root,
          degraded: resolved.degraded === true,
          reason: typeof resolved.reason === 'string' ? resolved.reason : '',
        }
      }
    }
  } catch {
    // Fall through to the workspace root.
  }
  return { root, degraded: false, reason: '' }
}

/** The task a session currently works on: its newest active, else newest draft. */
function currentTaskOf(records, session) {
  const open = records.filter(
    (record) => isPlainObject(record) && (record.status === 'active' || record.status === 'draft'),
  )
  if (open.length === 0) return null
  const owned = open.filter((record) => typeof record.owner === 'string' && record.owner === session)
  const pool = owned.length > 0 ? owned : open
  const active = pool.filter((record) => record.status === 'active')
  const ranked = (active.length > 0 ? active : pool).slice().sort((a, b) => timeValue(b.updated_at) - timeValue(a.updated_at))
  return ranked.length > 0 ? ranked[0] : null
}

/**
 * The standing discipline section. It is evaluated per prompt assembly, so it
 * always names the live root, task and heartbeat state — one short paragraph,
 * never an accumulating log.
 */
function disciplineText(ctx, context) {
  try {
    const agent = context !== null && context !== undefined ? context.agent : undefined
    if (agent === undefined || agent === null || coreAvailable() === false) return ''
    // Delegated child sessions are not asked to keep a heartbeat.
    if (rootSessionVerdict(ctx, agent) === false) return ''
    const root = agentRoot(ctx, agent)
    if (root === undefined || hasStore(root) === false) return ''
    const c = requireCore()
    if (typeof c.listTasks !== 'function' || typeof c.heartbeatStatus !== 'function') return ''
    const loaded = c.loadContract(root)
    const session = usableSessionId(agent.id)
    const listed = c.listTasks(root, loaded.contract)
    const task = currentTaskOf(Array.isArray(listed) ? listed : [], session)
    let status = '未登记'
    if (session !== '') {
      const beat = c.heartbeatStatus(root, loaded.contract, session)
      if (beat !== null && typeof beat === 'object' && beat.record !== null && beat.record !== undefined) {
        status = typeof beat.record.status === 'string' && beat.record.status !== '' ? beat.record.status : '未知'
      }
    }
    const taskText = task === null ? '当前任务: 无' : `当前任务: ${clip(task.id, 40)} ${clip(task.title, 48)}`
    const text =
      `project-flow 纪律 · 根 ${root} · ${taskText} · 本会话心跳: ${status}。` +
      '每轮开始先用 flow_heartbeat start 登记 goal/task/claims（claims 写本会话独占写入的文件域，供其他会话避让）；结束前调用 flow_heartbeat end。'
    return clip(text, 380)
  } catch {
    return ''
  }
}

/** Register the standing discipline section when a system-prompt service exists. */
function registerDisciplineSection(ctx) {
  provide(ctx, 'systemPrompt', 'system prompt', (scoped) => {
    const systemPrompt = service(scoped, 'systemPrompt')
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return () => {}
    let dispose
    try {
      dispose = systemPrompt.section({
        name: 'project-flow:heartbeat-discipline',
        order: 9500,
        text: (context) => disciplineText(scoped, context),
      })
    } catch (error) {
      warnMount(`system prompt: discipline section not registered: ${brief(error)}`, scoped)
      return () => {}
    }
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // A section disposer must never break plugin unload.
      }
    }
  })
}

const HEARTBEAT_REMINDER_TEXT =
  '【project-flow】本轮还没有 working 心跳。先调用 flow_heartbeat start 登记 goal/task/claims（claims 写本会话独占写入的文件域），结束前调用 flow_heartbeat end。'

/** Reminder budget: one bounded message, one text block. */
const DECISION_QUESTION_CLIP = 60
const DECISION_REMINDER_CLIP = 800

/** One user-role reminder message; the fields match `MessageBase` + `role`. */
function reminderMessage(session, turn, step, text) {
  return {
    id: `project-flow:${session}:${turn}:${step}:${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}


/** The store contract of one root, or null when it cannot be loaded. */
function decisionContractOf(root) {
  try {
    const c = requireCore()
    if (typeof c.loadContract !== 'function') return null
    const loaded = c.loadContract(root)
    return isPlainObject(loaded) ? loaded.contract : null
  } catch {
    return null
  }
}

/**
 * 挂起 display of one open decision: the turns it has waited for the session that
 * asked it, else the age since `asked_at`. Same rule as `decisionSuspended` in
 * bin/flow.mjs — two copies, because the Host and the CLI share no code. Only the
 * 3600 / 86400 thresholds are allowed; a change here must be mirrored there.
 */
function decisionSuspendedText(item) {
  const turnAge = isPlainObject(item) && Number.isInteger(item.turnAge) ? item.turnAge : null
  if (turnAge !== null) return `${turnAge} 轮`
  const age = isPlainObject(item) ? item.ageSeconds : null
  if (typeof age !== 'number' || Number.isFinite(age) === false) return '-'
  if (age < 3600) return `${Math.max(1, Math.round(age / 60))} 分钟`
  if (age < 86400) return `${Math.round(age / 3600)} 小时`
  return `${Math.round(age / 86400)} 天`
}

/** One reminder row: `- ⚠ D-… [kind] question  阻塞 T-…；挂起 3 轮`. */
function decisionReminderLine(item) {
  const blocks = Array.isArray(item.blocks)
    ? item.blocks.filter((id) => typeof id === 'string' && id !== '').map((id) => clip(id, 40))
    : []
  const blocked = blocks.length > 0 ? `阻塞 ${blocks.join('、')}；` : ''
  const head =
    `${item.escalated === true ? '⚠ ' : ''}${clip(item.id, 40)} [${clip(item.kind, 20)}] ` +
    clip(item.question, DECISION_QUESTION_CLIP)
  return `- ${head}  ${blocked}挂起 ${decisionSuspendedText(item)}`
}

/**
 * The decision section of the per-turn reminder, or '' when nothing is open. The
 * first turn of a session lists the whole ledger; later turns cap the detail at
 * DECISION_REMIND_MAX rows and count the rest. Row order is core's and is never
 * re-sorted here.
 */
function decisionReminderText(root, contract, session, turn) {
  try {
    if (hasStore(root) === false) return ''
    if (isPlainObject(contract) === false) return ''
    const c = requireCore()
    if (typeof c.summarizeDecisions !== 'function') return ''
    const firstTurn = Number.isInteger(turn) && turn === 1
    const info = { session, turn: Number.isInteger(turn) ? turn : null }
    if (firstTurn === false) info.limit = decisionRemindMax()
    const summary = c.summarizeDecisions(root, contract, info)
    const items = isPlainObject(summary) && Array.isArray(summary.items) ? summary.items : []
    const counts = isPlainObject(summary) ? summary.counts : null
    const open = isPlainObject(counts) && typeof counts.open === 'number' ? counts.open : 0
    if (open === 0 || items.length === 0) return ''
    const blocking = isPlainObject(counts) && typeof counts.blocking === 'number' ? counts.blocking : 0
    const lines = [`【project-flow】有 ${open} 个待用户拍板的决策（阻塞 ${blocking}）：`]
    for (const item of items) {
      if (isPlainObject(item)) lines.push(decisionReminderLine(item))
    }
    const remaining = open - items.length
    if (remaining > 0) lines.push(`还有 ${remaining} 条，运行 flow decision list --open 查看全部`)
    lines.push('回答后当轮调用 flow_decision answer <id> --choice <选项 id>；不要按推荐自行决定。')
    if (firstTurn) lines.push('新会话第一步：运行 flow decision list --open 查看完整清单')
    return clip(lines.join('\n'), DECISION_REMINDER_CLIP)
  } catch {
    return ''
  }
}

/**
 * Per-turn fallback: on the first step of a turn, append ONE user reminder that
 * merges two independently gated sections — the open decisions (whatever the
 * heartbeat state is) and the missing `working` heartbeat. Both empty means no
 * message at all; otherwise a single message with a single text block carries
 * both, decision section first. `step` is 1-based in the loop; `0` is accepted
 * too so the hook survives a loop that counts differently.
 *
 * `captureState` is the P1 capture queue (null when `config.capture === false`).
 * The pre-step listener owns the in-memory record call because the host may only
 * accept one waterfall listener per plugin in older environments (host2-tools
 * asserts exactly one `agent/pre-step` hook); it stays memory-only.
 */
function registerHeartbeatReminder(ctx, captureState, settings) {
  try {
    if (typeof ctx.on !== 'function') return
    ctx.effect(() => {
      const dispose = ctx.on('agent/pre-step', async (payload, next) => {
        // `next()` 抛错**故意不兜底**：waterfall 必须交出合法的 PreStepDecision
        // （封闭联合，无 null），而 next() 已经 reject、拿不到原 decision；兜底只能
        // 返回空 enter，那会静默丢弃 payload.messages（用户本轮输入）——比报错更隐蔽。
        // 方向相反是刻意的：下面 handler 抛错必须 catch 吞掉（最多少一条提醒），
        // 而 next()（宿主链）抛错必须传播。见 CONTRACT §9.2.1。
        const decision = await next()
        try {
          if (decision === null || decision === undefined || decision.kind !== 'enter') return decision
          const step = payload !== null && payload !== undefined ? payload.step : undefined
          if (step !== 0 && step !== 1) return decision
          const agent = payload.agent
          if (agent === undefined || agent === null) return decision
          // Only main sessions are reminded; a subagent gets neither section.
          if (rootSessionVerdict(ctx, agent) !== true) return decision
          const session = usableSessionId(agent.id)
          if (session === '') return decision
          const root = agentRoot(ctx, agent)
          if (root === undefined) return decision
          // P2 §5.2 ①: hide the team tools from a main session's scope. Applied
          // here as well as on `agent/created` so a session that predates the
          // plugin mount (or one created while capture is off) is still covered.
          if (settings !== null && typeof settings === 'object' && settings.enforce === true) {
            restrictMainSessionTools(ctx, agent, settings.restrictedAgents)
          }
          // P1 capture: memory only (filter → diff → queue). The write happens on
          // `agent/turn-stopping`, never on this per-step critical path.
          if (captureState !== null) recordPreStep(captureState, { root, session, messages: payload.messages })
          const turn = Number.isInteger(payload.turn) ? payload.turn : null
          const decisionsText = decisionReminderText(root, decisionContractOf(root), session, turn)
          const heartbeatText =
            heartbeatWorking(root, session, sessionIsLive(ctx, session)) === false ? HEARTBEAT_REMINDER_TEXT : ''
          const text = [decisionsText, heartbeatText].filter((part) => part !== '').join('\n')
          if (text === '') return decision
          const messages = Array.isArray(decision.messages) ? decision.messages.slice() : []
          messages.push(reminderMessage(session, payload.turn, step, text))
          return { ...decision, messages }
        } catch {
          return decision
        }
      })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // A listener disposer must never break plugin unload.
        }
      }
    }, 'project-flow: heartbeat reminder')
  } catch (error) {
    warnMount(`heartbeat reminder unavailable: ${brief(error)}`, ctx)
  }
}

/**
 * `agent/turn-stopping` (serial, awaited before the turn boundary commits):
 * refresh `updated_at` on this session's **existing working** heartbeat. Without
 * it a long turn lets `updated_at` age past the 6 h freshness window, so
 * `heartbeatStatus` reports stale/dead and {@link heartbeatGuardReason} wrongly
 * denies `edit`/`write`.
 *
 * One derivable fact only: no heartbeat is created, no semantic field is
 * written, `agent.steer()` is never called (that would keep the turn open) and
 * every failure is swallowed — a serial listener that throws reaches the host.
 * Existence and ownership reuse {@link heartbeatWorking}, the same verdict the
 * write gate uses, so only this session's beat can be refreshed; a lock conflict
 * becomes one mount warning and is never retried.
 */
function heartbeatKeepalive(ctx, payload) {
  try {
    if (payload === null || typeof payload !== 'object') return
    const signal = payload.signal
    if (signal !== null && signal !== undefined && signal.aborted === true) return
    const agent = payload.agent
    if (agent === undefined || agent === null) return
    // Heartbeats are a main-session discipline; a subagent must never be kept
    // alive (it does not register one, and a legacy record must not be revived).
    if (rootSessionVerdict(ctx, agent) !== true) return
    const session = usableSessionId(agent.id)
    if (session === '') return
    const root = agentRoot(ctx, agent)
    if (root === undefined) return
    // The record is resolved by THIS session id and must already be working:
    // `heartbeatWorking` is the gate's own existence/ownership/liveness verdict,
    // so another session's file is structurally out of reach.
    if (heartbeatWorking(root, session, sessionIsLive(ctx, session)) !== true) return
    const c = coreModule()
    if (c === null || typeof c.updateHeartbeat !== 'function') return
    const loaded = c.loadContract(root)
    if (loaded === null || typeof loaded !== 'object') return
    // Empty patch: core only refreshes `updated_at` (plus its host evidence) and
    // keeps `status`/`goal`/`task`/`claims`/`turn`/`stats` untouched.
    c.updateHeartbeat(root, loaded.contract, session, {})
  } catch (error) {
    // A dropped keepalive is harmless; a throw on the serial path is not.
    warnMount(`heartbeat keepalive skipped: ${brief(error)}`, ctx)
  }
}

/**
 * Register the turn-stopping listener through `ctx.effect` so unload disposes it.
 * A host without the event API is a no-op, never an error.
 *
 * One listener serves both P1 duties on purpose: host2-tools asserts that the
 * plugin registers exactly one `agent/turn-stopping` hook, and the host awaits
 * every listener on this serial event anyway. Keepalive refreshes the heartbeat;
 * capture drains the queue and writes the captured tasks. Either failure is
 * swallowed independently so one duty can never take the other down.
 */
function registerHeartbeatKeepalive(ctx, captureState) {
  try {
    if (typeof ctx.on !== 'function') return
    ctx.effect(() => {
      const dispose = ctx.on('agent/turn-stopping', (payload) => {
        try {
          heartbeatKeepalive(ctx, payload)
        } catch {
          // Defence in depth: heartbeatKeepalive already swallows everything.
        }
        if (captureState !== null) {
          try {
            captureTurnStop(ctx, captureState, payload)
          } catch (error) {
            // A serial listener must never throw: a failed flush is one warning.
            warnMount(`capture flush skipped: ${brief(error)}`, ctx)
          }
        }
      })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // A listener disposer must never break plugin unload.
        }
      }
    }, 'project-flow: heartbeat keepalive')
  } catch (error) {
    warnMount(`heartbeat keepalive unavailable: ${brief(error)}`, ctx)
  }
}

/**
 * Resolve `{root, session}` for one capture event: only a live main session with
 * a valid id and a workspace root may capture. Every failure is `null`, never a
 * throw (this runs on hook paths that cannot report an error to anyone).
 */
function captureTarget(ctx, payload) {
  try {
    if (payload === null || payload === undefined || typeof payload !== 'object') return null
    const signal = payload.signal
    if (signal !== null && signal !== undefined && signal.aborted === true) return null
    const agent = payload.agent
    if (agent === undefined || agent === null) return null
    if (rootSessionVerdict(ctx, agent) !== true) return null
    const session = usableSessionId(agent.id)
    if (session === '') return null
    const root = agentRoot(ctx, agent)
    if (root === undefined) return null
    return { root, session }
  } catch {
    return null
  }
}

/** `scope.allow` of one task as heartbeat claims (strings only, never a throw). */
function captureClaims(top) {
  try {
    const scope = isPlainObject(top) ? top.scope : null
    if (isPlainObject(scope) === false || Array.isArray(scope.allow) === false) return []
    return scope.allow.filter((entry) => typeof entry === 'string')
  } catch {
    return []
  }
}

/**
 * Serial `agent/turn-stopping` duty: drain the in-memory queue into the ledger.
 *
 * The write itself lives in `lib/capture.mjs` (one place for key/mapping/stage);
 * this wrapper only resolves the session/root, loads the contract, and refreshes
 * an **existing** heartbeat's goal/task/claims from the new stack top per §6 —
 * capture never creates a heartbeat (that is `agent/created`'s job, and only
 * with a stack top).
 */
function captureTurnStop(ctx, state, payload) {
  const target = captureTarget(ctx, payload)
  if (target === null) return
  const c = coreModule()
  if (c === null || typeof c.loadContract !== 'function') return
  const loaded = c.loadContract(target.root)
  if (isPlainObject(loaded) === false) return
  const result = flushCapture(state, {
    core: c,
    root: target.root,
    contract: loaded.contract,
    session: target.session,
  })
  if (result.created.length === 0) return
  if (typeof c.heartbeatStatus !== 'function' || typeof c.updateHeartbeat !== 'function') return
  const status = c.heartbeatStatus(target.root, loaded.contract, target.session)
  if (isPlainObject(status) === false || isPlainObject(status.record) === false) return
  const top = stackTop(c, target.root, loaded.contract)
  if (top === null) return
  c.updateHeartbeat(target.root, loaded.contract, target.session, {
    goal: typeof top.title === 'string' ? top.title : '',
    task: typeof top.id === 'string' ? top.id : '',
    claims: captureClaims(top),
  })
}

/**
 * Serial `agent/created` duty: open this session's heartbeat from the **stack
 * top** so it is never an empty shell (an empty heartbeat would defeat the write
 * gate). No unfinished task means no heartbeat at all — one mount warning, no
 * fallback, no invented goal.
 */
function captureAutoStart(ctx, payload) {
  const target = captureTarget(ctx, payload)
  if (target === null) return
  const c = coreModule()
  if (c === null || typeof c.loadContract !== 'function' || typeof c.startHeartbeat !== 'function') return
  const loaded = c.loadContract(target.root)
  if (isPlainObject(loaded) === false) return
  const top = stackTop(c, target.root, loaded.contract)
  if (top === null) {
    warnMount(
      'heartbeat auto-start skipped: the task stack is empty (no unfinished task), so no heartbeat was opened — create a task first',
      ctx,
    )
    return
  }
  // `agent/created` can fire more than once for one session (resume/clear); an
  // already-working heartbeat is left alone instead of having its turn bumped.
  if (heartbeatWorking(target.root, target.session, sessionIsLive(ctx, target.session)) === true) return
  c.startHeartbeat(target.root, loaded.contract, {
    session: target.session,
    goal: typeof top.title === 'string' ? top.title : '',
    task: typeof top.id === 'string' ? top.id : '',
    claims: captureClaims(top),
  })
}

/** Register the `agent/created` auto-start through `ctx.effect` (no-op without the event API). */
function registerAgentCreated(ctx, captureState, settings) {
  const enforce = settings !== null && typeof settings === 'object' && settings.enforce === true
  // Capture owns this hook; with `capture:false` the listener is not registered
  // at all (P1 rollback shape) and §5.2 ① falls back to the pre-step hook.
  if (captureState === null) return
  try {
    if (typeof ctx.on !== 'function') return
    ctx.effect(() => {
      const dispose = ctx.on('agent/created', (payload) => {
        // One hook for two independent duties: each has its own try/catch, and
        // `agent/created` is serial (a throw would fail session creation).
        if (captureState !== null) {
          try {
            captureAutoStart(ctx, payload)
          } catch (error) {
            warnMount(`capture heartbeat auto-start skipped: ${brief(error)}`, ctx)
          }
        }
        if (enforce) {
          try {
            restrictMainSessionTools(ctx, payload === null || payload === undefined ? undefined : payload.agent, settings.restrictedAgents)
          } catch (error) {
            warnMount(`enforce: restrict skipped: ${brief(error)}`, ctx)
          }
        }
      })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // A listener disposer must never break plugin unload.
        }
      }
    }, 'project-flow: agent created hooks')
  } catch (error) {
    warnMount(`capture/enforce: registration failed: ${brief(error)}`, ctx)
  }
}

// ------------------------------------------------------- P2 permission surface
//
// Plan §5.2: a main session may do four things — advance a stage it owns, manage
// subtasks in the implementation stages, read status and update its heartbeat.
// Everything else is denied, and every denial says how to proceed correctly.
//
// `restrict` (per-agent scope, applied on agent creation) hides the team tools;
// `guard` denies them again if a call bypasses the visible surface (PTC / nested
// scheduling). Subagents are exempt from rules 1-2: they exist to dispatch work
// and to create tasks.

/** Tools a main session must not see (plan §5.2 ①). Unknown names are filtered. */
const TEAM_TOOL_NAMES = Object.freeze([
  'spawn_teammate',
  'team_task_create',
  'team_task_update',
  'team_task_list',
  'team_task_get',
  'team_task_delete',
  'subagent',
  'subagent_fork',
])

const TEAM_TOOL_DENY = new Set(TEAM_TOOL_NAMES)

const MAIN_SESSION_TEAM_DENY =
  '项目流：主会话不得直接调度团队。用 flow_task_update（即 flow_task 的 update 动作）推进阶段，插件会派工。'

const MAIN_SESSION_TASK_ADD_DENY =
  '项目流：任务由插件按你的每句话自动创建，不需要也不允许手动建。若要补记一条，说明理由后由插件建。'

/** Stages in which subtasks may be added/removed (plan §5.1). */
const SUBTASK_STAGES = Object.freeze(['queued-implementation', 'implementing'])

/** The stage record of one task, or `null` when it cannot be read (then allow). */
function guardTaskOf(ctx, agent, id) {
  try {
    if (typeof id !== 'string' || id.trim() === '') return null
    const root = agentRoot(ctx, agent)
    if (root === undefined) return null
    const c = coreModule()
    if (c === null || typeof c.getTask !== 'function') return null
    const loaded = c.loadContract(root)
    return c.getTask(root, loaded.contract, id.trim())
  } catch {
    return null
  }
}

/**
 * Rules 3 and 4: a `flow_task update` that names a stage must walk a real edge,
 * and that edge must belong to the session. Both facts come from `lib/stage.mjs`
 * (`edgeOf` / `actorForEdge` / `nextStages`) — a second stage table here would
 * drift from the machine.
 */
function stageGuardReason(ctx, agent, args, actorMode) {
  const to = typeof args.stage === 'string' ? args.stage.trim() : ''
  if (to === '') return undefined
  const task = guardTaskOf(ctx, agent, args.id)
  if (task === null) return undefined
  const from = typeof task.stage === 'string' ? task.stage.trim() : ''
  if (from === '') return undefined
  if (from === to) return undefined // idempotent rewrite, same semantics as canTransition
  const edge = edgeOf(from, to)
  if (edge === null) {
    const legal = nextStages(from)
    return `项目流：${from} 只能到 ${legal.length === 0 ? '（无后继）' : legal.join('、')}，你给了 ${to}。`
  }
  // Rule 4 is the `team`-mode implementation. `single` (the default today) still
  // enforces the structure (rule 3 above) but not the role split: there is one
  // role, so "who may walk this edge" would deadlock the pipeline until P3.
  if (actorMode === 'team' && edge.actor !== 'session') {
    const mine = nextStages(from).filter((next) => actorForEdge(from, next) === 'session')
    return `项目流：${from} → ${to} 由 ${String(edge.actor)} 推进，不是你。你只能推进：${mine.length === 0 ? '（无）' : mine.join('、')}。`
  }
  return undefined
}

/** Rule 5: subtasks may only be touched in the implementation stages. */
function subtaskGuardReason(ctx, agent, args) {
  const action = typeof args.action === 'string' ? args.action : ''
  if (action !== 'add' && action !== 'remove') return undefined
  let parentId = typeof args.parent === 'string' ? args.parent.trim() : ''
  if (parentId === '' && typeof args.parentId === 'string') parentId = args.parentId.trim()
  let parent = parentId === '' ? null : guardTaskOf(ctx, agent, parentId)
  if (parent === null && action === 'remove') {
    const record = guardTaskOf(ctx, agent, args.id)
    if (record !== null && typeof record.parent === 'string' && record.parent.trim() !== '') {
      parent = guardTaskOf(ctx, agent, record.parent.trim())
    }
  }
  if (parent === null) return undefined
  const stage = typeof parent.stage === 'string' ? parent.stage.trim() : ''
  if (SUBTASK_STAGES.includes(stage)) return undefined
  return `项目流：只有实现阶段可以改子任务（当前 ${STAGE_ZH[stage] ?? stage}）。`
}

/**
 * The P2 guard predicate: `undefined` allows, a string denies. It never throws
 * (a guard failure must not turn into a denied tool call) and it only inspects
 * the tool names/shapes it knows; everything else is the normal tool layer.
 */
function enforceGuardReason(ctx, execution, actorMode) {
  try {
    if (execution === null || execution === undefined) return undefined
    const name = typeof execution.name === 'string' ? execution.name : ''
    if (name === '') return undefined
    const args = isPlainObject(execution.arguments) ? execution.arguments : {}
    const agent = execution.agent
    const main = rootSessionVerdict(ctx, agent) === true
    if (main && TEAM_TOOL_DENY.has(name)) return MAIN_SESSION_TEAM_DENY
    if (name === 'flow_task') {
      const action = typeof args.action === 'string' ? args.action : ''
      if (action === 'add') return main ? MAIN_SESSION_TASK_ADD_DENY : undefined
      if (action === 'update') return stageGuardReason(ctx, agent, args, actorMode)
      return undefined
    }
    if (name === 'flow_subtask') return subtaskGuardReason(ctx, agent, args)
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Rule ① of §5.2: hide the team tools from a main session's scope. `restrict`
 * refuses a context-global filter, so it is applied per agent on creation and
 * only to main sessions; names the host does not provide are dropped first
 * (`restrict` throws on unknown names).
 */
function restrictMainSessionTools(ctx, agent, restrictedAgents) {
  try {
    if (rootSessionVerdict(ctx, agent) !== true) return
    if (isPlainObject(agent) === false) return
    // One restriction per agent per mount: the pre-step fallback runs on every
    // step, and stacking identical restrictions would accumulate layers.
    const restricted = restrictedAgents instanceof WeakSet ? restrictedAgents : null
    if (restricted !== null && restricted.has(agent)) return
    const scope = agent.ctx
    if (scope === undefined || scope === null) return
    const tools = service(scope, 'tools')
    if (tools === undefined || tools === null || typeof tools.restrict !== 'function') return
    if (restricted !== null) restricted.add(agent)
    let deny = TEAM_TOOL_NAMES.slice()
    if (typeof tools.get === 'function') {
      deny = deny.filter((name) => {
        try {
          return tools.get(name) !== undefined
        } catch {
          return false
        }
      })
    }
    if (deny.length === 0) return
    tools.restrict({ deny })
  } catch (error) {
    warnMount(`enforce: restrict failed: ${brief(error)}`, ctx)
  }
}

/** Whether the P2 permission surface is on (`config.enforce !== false`). */
function enforceEnabled(config) {
  return isPlainObject(config) === false || config.enforce !== false
}

/**
 * `enforce.actorMode`: `single` (default) or `team`.
 *
 * `single` = one role does everything today: rule 4 (actor) is off, rule 3
 * (structure) stays on, so skipping stages is still denied. `team` = the target
 * design once P3 dispatches work and the analyzer/implementer/reviewer split
 * exists. An invalid value is `single` plus one mount warning (never a crash).
 */
function resolveActorMode(config, ctx) {
  const enforce = isPlainObject(config) ? config.enforce : undefined
  if (isPlainObject(enforce) === false) return 'single'
  const requested = enforce.actorMode
  if (requested === undefined || requested === null) return 'single'
  const mode = typeof requested === 'string' ? requested.trim() : ''
  if (mode === 'single' || mode === 'team') return mode
  warnMount(
    `enforce.actorMode 非法（${JSON.stringify(requested)}）：按 single 处理（可选 single|team）`,
    ctx,
  )
  return 'single'
}

/** Whether the P1 capture/status behaviour is on (`config.capture !== false`). */
function captureEnabled(settings) {
  return isPlainObject(settings) === false || settings.capture !== false
}

/** Default-on hard gate; disable with `config.heartbeatGate: false` or `PROJECT_FLOW_HEARTBEAT_GATE=off`. */
function heartbeatGateEnabled(config) {
  if (config !== null && typeof config === 'object') {
    if (config.heartbeatGate === false || config.enforceHeartbeat === false) return false
    if (config.heartbeatGate === true || config.enforceHeartbeat === true) return true
  }
  const env =
    typeof process.env.PROJECT_FLOW_HEARTBEAT_GATE === 'string'
      ? process.env.PROJECT_FLOW_HEARTBEAT_GATE.trim().toLowerCase()
      : ''
  if (env === '0' || env === 'off' || env === 'false' || env === 'no') return false
  return true
}

/** Deny `edit` / `write` for a session without a `working` heartbeat; everything else passes. */
function heartbeatGuardReason(ctx, execution) {
  try {
    if (execution === null || execution === undefined) return undefined
    if (HEARTBEAT_GATE_TOOLS.has(execution.name) === false) return undefined
    const agent = execution.agent
    if (agent === undefined || agent === null) return undefined
    // The hard gate exists for the main-session discipline only.
    if (rootSessionVerdict(ctx, agent) !== true) return undefined
    const session = usableSessionId(agent.id)
    if (session === '') return undefined
    const root = agentRoot(ctx, agent)
    if (root === undefined) return undefined
    if (heartbeatWorking(root, session, sessionIsLive(ctx, session)) !== false) return undefined
    return '先调用 flow_heartbeat start 登记本轮目标与独占文件域'
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- decisions
//
// One decision record stays `open` until the user answers it. The tool below is
// the model-side writer; bin/flow.mjs drives the same lib/core.mjs API, and the
// per-turn reminder only reads it.


/** The turn of this session's heartbeat record; `null` when it cannot be read. */
function decisionTurnOf(c, root, contract, session) {
  if (typeof session !== 'string' || session === '') return null
  try {
    if (typeof c.heartbeatStatus !== 'function') return null
    const status = c.heartbeatStatus(root, contract, session)
    const record = isPlainObject(status) ? status.record : null
    return isPlainObject(record) && Number.isInteger(record.turn) ? record.turn : null
  } catch {
    return null
  }
}

/** One `choice` option, restricted to the three fields the tool schema accepts. */
function decisionOptionInput(option) {
  if (isPlainObject(option) === false) throw new Error('flow_decision ask: every option needs id, label and impact')
  if (typeof option.id !== 'string' || typeof option.label !== 'string' || typeof option.impact !== 'string') {
    throw new Error('flow_decision ask: every option needs id, label and impact')
  }
  return { id: option.id, label: option.label, impact: option.impact }
}

/**
 * The lib/core.mjs `addDecision` input of one ask. `asked_session` (this session)
 * and `asked_turn` (its heartbeat turn) are the ledger's provenance: they let the
 * reminder say how many turns an item has been waiting. The turn is written only
 * when it is a real integer; the session is written regardless.
 */
function decisionAskInput(args, c, root, contract, session) {
  const kind = typeof args.kind === 'string' ? args.kind.trim() : ''
  if (kind === '') throw new Error('flow_decision ask requires kind: choice, approval or input')
  if (typeof args.rationale !== 'string' || args.rationale.trim() === '') {
    throw new Error('flow_decision ask requires rationale: say why the user must decide now')
  }
  const input = { question: args.question, kind, rationale: args.rationale }
  if (Array.isArray(args.options)) input.options = args.options.map(decisionOptionInput)
  const recommendation =
    typeof args.recommendation === 'string' && args.recommendation.trim() !== '' ? args.recommendation.trim() : ''
  if (recommendation !== '') input.recommendation = recommendation
  // An approval asked without a recommendation recommends approve; a session that
  // wants the user to reject passes recommendation: 'reject' explicitly.
  else if (kind === 'approval') input.recommendation = 'approve'
  if (args.default !== undefined && args.default !== null) input.default = args.default
  for (const name of ['blocks', 'affects']) {
    if (Array.isArray(args[name])) input[name] = args[name]
  }
  if (typeof args.supersedes === 'string' && args.supersedes.trim() !== '') input.supersedes = args.supersedes.trim()
  input.asked_session = session
  const turn = decisionTurnOf(c, root, contract, session)
  if (turn !== null) input.asked_turn = turn
  return input
}

function buildToolDefinitions(deps, settings) {
  const { ctx, toolRoot } = deps
  return [
    {
      name: 'flow_status',
      description:
        'Report the project flow ledger: contract source, experiment and task totals, and gate definitions with their last result. Read-only. Works with the .dsh/flow store; an uninitialized workspace reports empty totals.',
      parameters: { type: 'object', properties: { root: ROOT_PROPERTY }, required: [], additionalProperties: false },
      output: toolOutput(),
      isConcurrencySafe: true,
      timeoutMs: 15_000,
      async execute(args, exec) {
        const root = toolRoot(ctx, args, exec)
        const c = requireCore()
        const loaded = c.loadContract(root)
        const state = c.readStoreState(root, loaded.contract)
        const experiments = state.experiments
        const tasks = state.tasks
        const result = {
          root,
          store: hasStore(root),
          contract: { source: loaded.source, schema: loaded.contract.schema, name: loaded.contract.name },
          experiments: { total: experiments.counts.total, counts: experiments.counts },
          tasks: { total: tasks.counts.total, counts: tasks.counts },
          gates: (Array.isArray(state.gates.items) ? state.gates.items : []).map((gate) => ({
            id: gate.id,
            ok: gate.lastRun === null || gate.lastRun === undefined ? null : gate.lastRun.ok === true,
            at: gate.lastRun === null || gate.lastRun === undefined ? null : gate.lastRun.started_at,
          })),
        }
        // §9 status block (P1). Same shape the CLI `--json` envelope carries:
        // stack / counts / team / unfinished + the §6.3 recentCaptured escape hatch.
        if (captureEnabled(settings)) {
          try {
            Object.assign(result, buildStatusBlock(c, root, loaded.contract))
          } catch (error) {
            warnMount(`status block unavailable: ${brief(error)}`, ctx)
          }
        }
        return result
      },
    },
    {
      name: 'flow_heartbeat',
      description:
        'Main-session work heartbeat (start/update/end/list/status) for the project ledger; a subagent session must not call the write actions. Every turn: call start BEFORE replying — goal defaults to the current task title, claims lists the files this session exclusively writes so other main sessions avoid them — and call end before finishing. update refreshes status/last_action; list and status read the section. The ledger lives in the project main worktree, even when the current session runs in a linked worktree. Writes require a .dsh/flow store.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'update', 'end', 'list', 'status'] },
          root: ROOT_PROPERTY,
          goal: { type: 'string', description: 'What this turn works on. start defaults it to the current task title.' },
          task: {
            type: 'string',
            description: 'Task id this session works on; defaults to the session active/draft task.',
          },
          claims: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files or directories this session writes exclusively; other sessions stay out of them.',
          },
          last_action: { type: 'string', description: 'Latest action, shown on the panel heartbeat line.' },
          note: { type: 'string', description: 'Free note; folded into last_action on start/end.' },
          status: {
            type: 'string',
            enum: ['working', 'idle'],
            description: 'update only: working keeps the turn open, idle parks the heartbeat.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: toolOutput(),
      isConcurrencySafe: false,
      timeoutMs: WRITE_TIMEOUT_MS,
      async execute(args, exec) {
        const workspace = toolRoot(ctx, args, exec)
        const action = args.action
        // The heartbeat ledger belongs to the project's main worktree, so a
        // session running in a linked worktree reads and writes the same files.
        const heartbeat = heartbeatRootOf(workspace)
        const root = heartbeat.root

        if (action === 'list') {
          const warnings = []
          if (heartbeat.degraded === true) {
            warnings.push(`heartbeat-root-degraded: ${heartbeat.reason || root}`)
          }
          const store = hasStore(root)
          if (coreAvailable() === false || store === false) {
            if (coreAvailable() === false) warnings.push(`core-unavailable: ${coreFailure || 'unknown error'}`)
            return {
              root,
              workspace,
              store,
              dir: '.agents/heartbeat',
              items: [],
              counts: { total: 0, active: 0, stale: 0, hidden: 0 },
              warnings,
            }
          }
          const c = requireCore()
          const { contract } = c.loadContract(root)
          const section = c.readHeartbeatSection(root, contract)
          const items = isPlainObject(section) && Array.isArray(section.items) ? section.items : []
          const counts = isPlainObject(section) && isPlainObject(section.counts)
            ? section.counts
            : { total: items.length, active: 0, stale: 0, hidden: 0 }
          return {
            root,
            workspace,
            store,
            dir: isPlainObject(section) && typeof section.dir === 'string' ? section.dir : '.agents/heartbeat',
            items: items.slice(0, MAX_TOOL_ITEMS),
            counts,
            ...(items.length > MAX_TOOL_ITEMS ? { truncated: true } : {}),
            warnings,
          }
        }

        if (action === 'status') {
          const session = requireSession(exec)
          const c = requireCore()
          if (typeof c.heartbeatStatus !== 'function') {
            throw new Error('flow_heartbeat status needs a newer lib/core.mjs: heartbeat support is missing')
          }
          const warnings = []
          const { contract } = c.loadContract(root)
          const result = c.heartbeatStatus(root, contract, session)
          return {
            root,
            workspace,
            store: hasStore(root),
            session,
            active: isPlainObject(result) && result.active === true,
            record: isPlainObject(result) && isPlainObject(result.record) ? result.record : null,
            warnings,
          }
        }

        const session = requireSession(exec)
        // Delegated child sessions never keep a heartbeat: refuse loudly with an
        // actionable hint instead of silently writing a hidden ledger file.
        if (rootSessionVerdict(ctx, exec.agent) === false) {
          throw new Error(ROOT_SESSION_HEARTBEAT_ONLY)
        }
        requireStore(root)
        const c = requireCore()
        const { contract } = c.loadContract(root)

        if (action === 'start') {
          if (typeof c.startHeartbeat !== 'function') {
            throw new Error('flow_heartbeat start needs a newer lib/core.mjs: heartbeat support is missing')
          }
          const input = pickFields(args, ['goal', 'task', 'claims', 'last_action'])
          if (input.last_action === undefined && typeof args.note === 'string' && args.note.trim().length > 0) {
            input.last_action = args.note.trim()
          }
          return {
            root,
            workspace,
            store: true,
            session,
            heartbeat: c.startHeartbeat(root, contract, { session, ...input }),
          }
        }
        if (action === 'update') {
          if (typeof c.updateHeartbeat !== 'function') {
            throw new Error('flow_heartbeat update needs a newer lib/core.mjs: heartbeat support is missing')
          }
          const patch = pickFields(args, ['status', 'last_action', 'goal', 'task', 'claims'])
          if (Object.keys(patch).length === 0) throw new Error('flow_heartbeat update requires at least one field to change')
          const heartbeat = c.updateHeartbeat(root, contract, session, patch)
          const result = { root, workspace, store: true, session, heartbeat }
          if (captureEnabled(settings)) {
            try {
              Object.assign(result, buildStatusBlock(c, root, contract))
            } catch (error) {
              warnMount(`status block unavailable: ${brief(error)}`, ctx)
            }
          }
          return result
        }
        if (action === 'end') {
          if (typeof c.endHeartbeat !== 'function') {
            throw new Error('flow_heartbeat end needs a newer lib/core.mjs: heartbeat support is missing')
          }
          const options = { session }
          if (typeof args.note === 'string' && args.note.trim().length > 0) options.note = args.note.trim()
          return { root, workspace, store: true, session, heartbeat: c.endHeartbeat(root, contract, options) }
        }
        throw new Error(`unknown flow_heartbeat action: ${String(action)}`)
      },
    },
    {
      name: 'flow_decision',
      description:
        'Decision ledger for questions only the user can settle: `ask` records one open item (choice/approval/input), `list` and `show` read it, `answer` closes it with the user\'s choice, `withdraw` drops it with a reason, `gc` removes closed records past the retention window. R1: call ask BEFORE you pose the question, then put the returned id in the question text as [D-<id>]. R2: in the same turn the user answers, call answer with their choice. R5: recommendation and default are proposals, not the answer - never adopt one on the user\'s behalf. An approval asked without a recommendation recommends approve (pass recommendation reject to recommend rejection). Write actions serve main sessions only: a subagent reports the pending decision in its final message, and only the parent (main) session creates and closes a D record. list/show work in any session; writes require a .dsh/flow store.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['ask', 'list', 'show', 'answer', 'withdraw', 'gc'],
            description: 'ask creates, list/show read, answer/withdraw close one, gc prunes closed records.',
          },
          root: ROOT_PROPERTY,
          id: { type: 'string', description: 'Decision id, e.g. D-20261031-01.' },
          question: { type: 'string', description: 'ask: the one-sentence question the user must settle.' },
          kind: {
            type: 'string',
            enum: ['choice', 'approval', 'input'],
            description: 'ask: choice needs 2+ options, approval uses the fixed approve|reject pair, input takes free text.',
          },
          options: {
            type: 'array',
            description: 'ask + kind=choice: the mutually exclusive options.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Short option id the answer names, e.g. adopt.' },
                label: { type: 'string', description: 'What the user picks.' },
                impact: { type: 'string', description: 'What changes when this option is chosen.' },
              },
              required: ['id', 'label', 'impact'],
              additionalProperties: false,
            },
          },
          default: { type: 'string', description: 'ask: option id used when the user never answers; not an answer.' },
          recommendation: {
            type: 'string',
            description: 'ask: option id this session proposes; not an answer. Omitted on kind=approval means approve.',
          },
          rationale: { type: 'string', description: 'ask: why the user must decide now; required.' },
          blocks: {
            type: 'array',
            items: { type: 'string' },
            description: 'ask: task ids that cannot proceed until the user answers.',
          },
          affects: {
            type: 'array',
            items: { type: 'string' },
            description: 'ask: repo-relative files or directories the answer changes.',
          },
          supersedes: {
            type: 'string',
            description: 'ask: closed decision id this one replaces; required to re-ask the same question.',
          },
          choice: { type: 'string', description: 'answer: the option id (kind=input: free text) the user picked.' },
          note: { type: 'string', description: 'answer: the user\'s wording or a short note.' },
          by: { type: 'string', enum: ['user', 'agent'], description: 'Who confirmed it; defaults to user.' },
          reason: { type: 'string', description: 'withdraw: why the question no longer applies; required.' },
          days: { type: 'integer', description: 'gc: closed-record retention window in days (default 90).' },
          dryRun: { type: 'boolean', description: 'gc: report what would be removed without deleting it.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: toolOutput(),
      isConcurrencySafe: false,
      timeoutMs: WRITE_TIMEOUT_MS,
      async execute(args, exec) {
        const root = toolRoot(ctx, args, exec)
        const c = requireCore()
        const action = args.action

        // Read actions are open to every session: a subagent may want to know
        // which decision already blocks its task.
        if (action === 'list') {
          if (hasStore(root) === false) {
            return { root, items: [], counts: emptyDecisionCounts(), note: EMPTY_STORE_NOTE }
          }
          if (typeof c.summarizeDecisions !== 'function' || typeof c.listDecisions !== 'function') {
            throw new Error('flow_decision list needs a newer lib/core.mjs: decision support is missing')
          }
          const { contract } = c.loadContract(root)
          const session = usableSessionId(sessionIdOf(exec) ?? '')
          const turn = decisionTurnOf(c, root, contract, session)
          const info = { session, turn }
          const summary = c.summarizeDecisions(root, contract, info)
          return { root, items: c.listDecisions(root, contract, info), counts: decisionCountsOf(summary.counts) }
        }

        if (action === 'show') {
          if (typeof c.getDecision !== 'function') {
            throw new Error('flow_decision show needs a newer lib/core.mjs: decision support is missing')
          }
          const id = requireId('flow_decision', action, args.id)
          const { contract } = c.loadContract(root)
          return { root, decision: c.getDecision(root, contract, id) }
        }

        // Writes: the decision ledger belongs to the main session's conversation
        // with the user. Refuse loudly instead of writing an answer nobody asked.
        if (rootSessionVerdict(ctx, exec.agent) === false) {
          throw new Error(ROOT_SESSION_DECISION_ONLY)
        }
        requireStore(root)
        const { contract } = c.loadContract(root)

        if (action === 'ask') {
          if (typeof c.addDecision !== 'function') {
            throw new Error('flow_decision ask needs a newer lib/core.mjs: decision support is missing')
          }
          const session = requireSession(exec)
          const result = c.addDecision(root, contract, decisionAskInput(args, c, root, contract, session))
          return { root, decision: result.decision, created: result.created === true }
        }
        if (action === 'answer') {
          if (typeof c.answerDecision !== 'function') {
            throw new Error('flow_decision answer needs a newer lib/core.mjs: decision support is missing')
          }
          const id = requireId('flow_decision', action, args.id)
          return { root, decision: c.answerDecision(root, contract, id, pickFields(args, ['choice', 'note', 'by'])) }
        }
        if (action === 'withdraw') {
          if (typeof c.withdrawDecision !== 'function') {
            throw new Error('flow_decision withdraw needs a newer lib/core.mjs: decision support is missing')
          }
          const id = requireId('flow_decision', action, args.id)
          return { root, decision: c.withdrawDecision(root, contract, id, pickFields(args, ['reason', 'by'])) }
        }
        if (action === 'gc') {
          if (typeof c.gcDecisions !== 'function') {
            throw new Error('flow_decision gc needs a newer lib/core.mjs: decision support is missing')
          }
          const options = {}
          if (args.days !== undefined) options.days = args.days
          if (args.dryRun !== undefined) options.dryRun = args.dryRun === true
          const result = c.gcDecisions(root, contract, options)
          return { root, removed: result.removed, kept: result.kept, dryRun: result.dryRun }
        }
        throw new Error(`unknown flow_decision action: ${String(action)}`)
      },
    },
  ]
}

/**
 * Mount this plugin's three tools. The registration semantics (optional
 * service, one effect, core-warning wrapper, unload) are the shared ones in
 * lib/plugin/mount.mjs, so the sub-plugins mount theirs the same way.
 */
function registerTools(ctx, settings) {
  const heartbeatGate = settings !== null && typeof settings === 'object' && settings.heartbeatGate === true
  const enforce = settings !== null && typeof settings === 'object' && settings.enforce === true
  const actorMode = settings !== null && typeof settings === 'object' && settings.actorMode === 'team' ? 'team' : 'single'
  // Two independent guards, one predicate: the heartbeat write gate (a session
  // without a working heartbeat may not edit/write) and the P2 permission
  // surface (plan §5.2). Each failure inside a guard allows the call.
  const guard =
    heartbeatGate === false && enforce === false
      ? undefined
      : (scoped) => (execution) => {
          if (heartbeatGate) {
            const reason = heartbeatGuardReason(scoped, execution)
            if (reason !== undefined) return reason
          }
          if (enforce) {
            const reason = enforceGuardReason(scoped, execution, actorMode)
            if (reason !== undefined) return reason
          }
          return undefined
        }
  registerToolDefinitions(ctx, {
    label: 'tools',
    build: (scoped) => buildToolDefinitions(toolDeps(scoped), settings),
    guard,
  })
}

// ------------------------------------------------------------------- skills

const SKILL_META = [
  /* Every skill carries its own metadata in its file frontmatter (flat
     `skills/<name>.md`, or directory `skills/<name>/SKILL.md`); `name` is the
     only field here. Keeping description/whenToUse here too would be a second
     source of truth that silently loses to the frontmatter. */
  { name: 'project-flow-init' },
  { name: 'project-flow-usage' },
  /* Directory layout: skills/<name>/SKILL.md plus references/, assets/, scripts/. */
  { name: 'ai-collaborative-dev-workflow' },
]

/**
 * Read the simple frontmatter of a skill file: the top-level `description` and
 * `when-to-use` inside the `metadata:` block.
 *
 * This is a deliberately minimal YAML subset, NOT a YAML parser, and it fails
 * SILENTLY in two ways that cost a whole debugging session each:
 *  - the key must be exactly `metadata.when-to-use`; a camelCase `whenToUse`
 *    parses to `''` with no error;
 *  - only single-line `key: value` scalars are read. A value wrapped onto
 *    continuation lines keeps its FIRST line and drops the rest, so a nicely
 *    formatted multi-line `description:` silently becomes a truncated one.
 *
 * Every skill, flat or directory, now carries its metadata in its own file, so
 * there is NO SKILL_META fallback left: a frontmatter value missed here reaches
 * the model as `undefined`, not as a default. Keep every value on ONE line.
 */
function readSkillFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content)
  if (match === null) return { description: '', whenToUse: '' }
  const seen = {}
  let block = ''
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const pair = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line.trim())
    if (pair === null) continue
    if (/^[ \t]/.test(line)) {
      if (block === 'metadata') seen[`metadata.${pair[1]}`] = pair[2].trim()
    } else {
      block = pair[1]
      seen[block] = pair[2].trim()
    }
  }
  const unquote = (value) => (typeof value === 'string' ? value.replace(/^["']|["']$/g, '').trim() : '')
  return {
    description: unquote(seen.description),
    whenToUse: unquote(seen['metadata.when-to-use']),
  }
}

function registerSkills(ctx) {
  provide(ctx, 'skills', 'skills', (scoped) => {
    const skills = service(scoped, 'skills')
    if (skills === undefined || typeof skills.register !== 'function') return () => {}
    const disposers = []
    for (const meta of SKILL_META) {
      // Two layouts: a directory skill (skills/<name>/SKILL.md) may carry
      // references/, assets/ and scripts/, a flat skill (skills/<name>.md) is
      // the instruction file alone. The directory wins when both exist.
      const dir = join(PACKAGE_ROOT, 'skills', meta.name)
      const dirRelative = join('skills', meta.name, 'SKILL.md')
      const flatRelative = join('skills', `${meta.name}.md`)
      const directory = existsSync(join(dir, 'SKILL.md'))
      const relativePath = directory ? dirRelative : flatRelative
      const file = directory ? join(dir, 'SKILL.md') : join(PACKAGE_ROOT, flatRelative)
      let content
      try {
        content = readFileSync(file, 'utf8')
      } catch (error) {
        warnMount(`skills: ${toPosix(relativePath)} not found; ${meta.name} was not registered (${brief(error, 120)})`, scoped)
        continue
      }
      if (typeof content !== 'string' || content.trim().length === 0) {
        warnMount(`skills: ${toPosix(relativePath)} is empty; ${meta.name} was not registered`, scoped)
        continue
      }
      try {
        /* A directory skill is a file the package author can edit: its own
           frontmatter wins over the SKILL_META fallback. */
        const front = readSkillFrontmatter(content)
        const dispose = skills.register({
          name: meta.name,
          description: front.description.length > 0 ? front.description : meta.description,
          whenToUse: front.whenToUse.length > 0 ? front.whenToUse : meta.whenToUse,
          /* SkillSummary requires a string source; these ship with the bundle. */
          source: 'bundled',
          /* The filesystem provider strips the frontmatter from a loaded body;
             do the same, or the model sees the metadata block twice. */
          content: content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trimStart(),
          /* A directory skill renders "Base directory for this skill: <path>" and
             the model resolves relative references against it; the flat layout
             has no resources, so it carries no resourceBase. */
          ...(directory ? { resourceBase: { kind: 'directory', path: dir } } : {}),
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        warnMount(`skills: cannot register ${meta.name}: ${brief(error)}`, scoped)
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A skill disposer must never break plugin unload.
        }
      }
    }
  })
}

/**
 * Mount one JSON endpoint behind the shared wrapper: the handler never rejects
 * into the host, and an already-sent response is torn down instead of answered.
 * Each route is its own effect, so unload unregisters it.
 */
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
    capture: captureEnabled,
    enforce: enforceEnabled(config),
    // `single` today (one role); P3 flips the default to `team` once the plugin
    // actually dispatches analyzer/implementer/reviewer work.
    actorMode: resolveActorMode(config, ctx),
    // Per-mount dedupe for §5.2 ① (a re-apply restores the team tools until the
    // new mount restricts again; a module-level set would skip that).
    restrictedAgents: new WeakSet(),
  }
  const captureState = captureEnabled ? createCaptureState() : null

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
    registerHeartbeatReminder(ctx, captureState, settings)
  } catch (error) {
    warnMount(`heartbeat reminder: registration failed: ${brief(error)}`, ctx)
  }
  try {
    registerHeartbeatKeepalive(ctx, captureState)
  } catch (error) {
    warnMount(`heartbeat keepalive: registration failed: ${brief(error)}`, ctx)
  }
  try {
    registerAgentCreated(ctx, captureState, settings)
  } catch (error) {
    warnMount(`capture/enforce: registration failed: ${brief(error)}`, ctx)
  }
}
