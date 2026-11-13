// project-flow — 心跳域（heartbeats 模块，2026-11-11 Phase 1 拆分）。
//
// 心跳是"主会话的存活登记簿"：工作区根解析、存活证据（host/boot_id/pid）、
// 读写 API、GC 与面板投影。依赖方向：heartbeats → store（records/contract/
// git-root）+ util + atomic + lock，**不 import core**。
//
// 唯一的外部依赖是"没有任务时建卡"：`startHeartbeat` 需要 task 记录才能建卡，
// core 在装配时通过 `configureHeartbeats({ buildTask, taskIds })` 注入，避免
// heartbeats ↔ tasks 的循环依赖。

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { writeJsonAtomic } from '../atomic.mjs'
import { containedDir, pathMemoOf } from '../paths.mjs'
import { hostTag } from '../lock.mjs'
import { FlowError, deepClone, formatIso, invalid, isPlainObject, noteWarning, toPosix } from '../util.mjs'
import { CONTRACT_REL, assertInitialized, normalizeContract, storePaths, withLock } from '../store/contract.mjs'
import { assertTargetFree, optionalInt, optionalText, readCollection, requireText, sortByCreatedAsc, stringArray } from '../store/records.mjs'
import { gitMainWorktree, gitProbe, resolveProjectRoot } from '../store/git-root.mjs'
import { STAGE_IDS, STAGE_ZH, legacyStageFromStatus } from '../stage.mjs'

/** 由 core 注入的任务能力（唯一避免循环依赖的接缝）。 */
let HOOKS = { buildTask: null, taskIds: null }

/** 注册任务侧能力；core 在模块加载后调用一次。 */
export function configureHeartbeats(hooks) {
  const input = isPlainObject(hooks) ? hooks : {}
  if (typeof input.buildTask === 'function') HOOKS.buildTask = input.buildTask
  if (typeof input.taskIds === 'function') HOOKS.taskIds = input.taskIds
}

export const HEARTBEAT_STALE_SECONDS = 6 * 60 * 60
export const HEARTBEAT_SCHEMA = 1
const HEARTBEAT_STATUS = ['working', 'idle', 'waiting', 'done', 'missed']
const HEARTBEAT_ACTIVE_STATUS = ['working', 'idle', 'waiting']
const HEARTBEAT_PATCH_KEYS = ['status', 'last_action', 'goal', 'task', 'claims', 'turn', 'title']
const HEARTBEAT_TITLE_MAX = 160
const HEARTBEAT_SESSION_MAX = 80
const HEARTBEAT_CLAIM_MAX = 200

/**
 * Windows reserves these device names in every directory, case-insensitively,
 * and with any extension (`CON`, `con.txt`, `nul.tar.gz` → unusable file). The
 * stem before the first dot is what Windows matches, so that is what we test.
 */
const WINDOWS_RESERVED_SESSION_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
])
/** Characters Windows rejects in a file name; `:` also covers NTFS ADS (`name:stream`). */
const WINDOWS_UNSAFE_SESSION_CHARS_RE = /[<>:"|?*]/

export const MAX_HEARTBEAT_CLIP = 400

/** `agent` value old automation wrote for a subagent run; read-side legacy marker. */
export const LEGACY_SUBAGENT_AGENT = 'subagent'

// --------------------------------------------------- heartbeat workspace root
//
// A heartbeat belongs to the *project*, not to one checkout: every main session
// of the same project — including one whose cwd is a linked git worktree — must
// see and update the same ledger. The work root is therefore the project's main
// worktree, resolved with git; when git cannot answer the given cwd is used and
// a warning is recorded.

const MAIN_WORKSPACE_CACHE = new Map()

/** Trimmed stdout of one git probe; `undefined` on any failure (missing git included). */

/**
 * Current branch of `dir` (`git branch --show-current`), or `null` outside a git
 * repo, on a detached HEAD, or when git is unavailable. Never throws.
 *
 * 2026-11-09（审计项 11）：心跳从 startHeartbeat 起就记 `branch`，任务卡也要记
 * 「这句话是在哪个分支上说的」，面板才能在多分支并行时区分来源。探针逻辑只有这
 * 一处，capture 与心跳共用。
 */
export function gitBranchOf(dir) {
  try {
    const branch = gitProbe(resolve(dir), ['branch', '--show-current'])
    return typeof branch === 'string' && branch !== '' ? branch : null
  } catch {
    return null
  }
}

/** Absolute path of the repo's main worktree, or `undefined` when unresolvable. */

/**
 * The directory whose ledger a path belongs to: the project's **main worktree**.
 *
 * The ledger is per project, not per checkout: a session (or CLI call) whose cwd
 * is a linked git worktree must read and write the same store as the main
 * worktree — otherwise every worktree grows its own diverging copy (measured
 * 2026-11-09: 108 / 100 / 96 / 99 / 2 task files across four worktrees while
 * heartbeats all landed in the main worktree). The heartbeat ledger already
 * applied this rule (`resolveHeartbeatWorkspace`); this is the same rule for the
 * store itself.
 *
 * Deliberately conservative:
 * - a directory without a `.git` entry is its own root (no git subprocess);
 * - an ordinary nested directory keeps its own scope (only a real worktree/repo
 *   root is redirected), so reading a subdirectory never inherits a parent repo;
 * - git cannot answer → the given root, unchanged.
 *
 * @param {string} root any directory
 * @returns {string} absolute path of the ledger root
 */

/**
 * Resolve the work root of the heartbeat ledger: the project's main worktree.
 *
 * - no `.git` entry → the directory is not a repo; it is its own root (silent);
 * - main worktree resolved and initialized → that root, so every session writes
 *   the same ledger even from a linked worktree;
 * - git fails or the main worktree has no store → degrade to `root` with a
 *   warning (`heartbeat-root-degraded`).
 *
 * @returns {{root:string, degraded:boolean, reason:string}}
 */
export function resolveHeartbeatWorkspace(root) {
  const absRoot = resolve(root)
  const cached = MAIN_WORKSPACE_CACHE.get(absRoot)
  if (cached !== undefined) return cached

  let entry
  if (existsSync(join(absRoot, '.git')) === false) {
    entry = { root: absRoot, degraded: false, reason: '' }
  } else {
    const main = gitMainWorktree(absRoot)
    if (main === undefined) {
      entry = { root: absRoot, degraded: true, reason: 'git worktree lookup failed' }
    } else if (main === absRoot) {
      entry = { root: absRoot, degraded: false, reason: '' }
    } else if (existsSync(join(main, CONTRACT_REL)) === false) {
      entry = {
        root: absRoot,
        degraded: true,
        reason: `main worktree ${toPosix(main)} has no flow store`,
      }
    } else {
      entry = { root: main, degraded: false, reason: '' }
    }
  }
  MAIN_WORKSPACE_CACHE.set(absRoot, entry)
  return entry
}

/** {@link resolveHeartbeatWorkspace}, recording the degraded case as a diagnostic. */
export function heartbeatWorkspace(root) {
  const resolved = resolveHeartbeatWorkspace(root)
  if (resolved.degraded === true) {
    noteWarning(`heartbeat-root-degraded: ${toPosix(resolve(root))}: ${resolved.reason}`)
  }
  return resolved
}

function clipText(value, max = MAX_HEARTBEAT_CLIP) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Parse a heartbeat stamp. Loose "YYYY-MM-DD HH:MM[:SS]" values are read as
 * local time (host behaviour); anything else goes through Date.parse.
 */
function parseHeartbeatStamp(value) {
  if (typeof value !== 'string') return Number.NaN
  const text = value.trim()
  if (text.length === 0) return Number.NaN
  const loose = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (loose !== null) {
    return new Date(
      Number(loose[1]),
      Number(loose[2]) - 1,
      Number(loose[3]),
      Number(loose[4]),
      Number(loose[5]),
      loose[6] === undefined ? 0 : Number(loose[6]),
    ).getTime()
  }
  return Date.parse(text)
}

// --------------------------------------------------- heartbeat liveness
//
// A heartbeat file alone cannot prove its session still exists; these helpers
// add machine/boot/pid evidence so a finished session stops looking active.
// The evidence is written by the *host* process only: a one-shot CLI process
// must not record its own pid (it dies immediately and would mark a healthy
// session dead), so the CLI path writes `host` and nothing else.

const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id'
let cachedBootId = null

/** Boot id of this machine (`''` when the platform does not expose one). */
function currentBootId() {
  if (cachedBootId !== null) return cachedBootId
  try {
    cachedBootId = readFileSync(BOOT_ID_FILE, 'utf8').trim()
  } catch {
    cachedBootId = ''
  }
  return cachedBootId
}

/**
 * Whether this process is the one-shot CLI (`bin/flow.mjs`). The CLI must not
 * write pid evidence; the plugin host (the DSH process) does.
 */
function isFlowCliEntrypoint() {
  const entry = typeof process.argv[1] === 'string' ? process.argv[1].replace(/\\/g, '/') : ''
  return /(^|\/)bin\/flow\.mjs$/.test(entry)
}

/** `/proc/<pid>` start time (field 22), or null where `/proc` is unavailable. */
function pidStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  let text
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return null
  }
  // comm may contain spaces/parens: split after the last ')'.
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const fields = text.slice(close + 1).trim().split(/\s+/)
  const start = Number(fields[19])
  return Number.isFinite(start) ? start : null
}

/** True when the pid exists (EPERM still means a live process). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error !== null && error !== undefined && error.code === 'EPERM'
  }
}

/**
 * The liveness evidence already stored in a record. Used to carry proof across
 * CLI writes instead of replacing it with the one-shot CLI process's identity.
 */
function heartbeatEvidenceOf(record) {
  const evidence = {}
  if (!isPlainObject(record)) return evidence
  if (typeof record.host === 'string' && record.host.trim() !== '') evidence.host = record.host.trim()
  if (typeof record.boot_id === 'string' && record.boot_id.trim() !== '') evidence.boot_id = record.boot_id.trim()
  if (Number.isInteger(record.pid) && record.pid > 0) evidence.pid = record.pid
  if (Number.isFinite(record.pid_start) && record.pid_start > 0) evidence.pid_start = record.pid_start
  return evidence
}

/** `writer: 'cli'` lets the CLI declare its one-shot nature explicitly; argv is the fallback. */
function isCliWriter(writer) {
  if (writer === 'cli') return true
  if (writer === 'host') return false
  return isFlowCliEntrypoint()
}

/**
 * Liveness evidence written into a heartbeat record by the current process.
 * Host: `{host, boot_id, pid, pid_start}` (fresh proof).
 * CLI: **never overwrites existing proof** — it keeps `host`/`boot_id`/`pid`/
 * `pid_start` already in the record and only fills `host` when the record has
 * none. A one-shot CLI process must not turn a live session (or a record written
 * on another machine) into a dead one.
 */
function heartbeatWriterEvidence(existing, writer) {
  if (isCliWriter(writer)) {
    const evidence = heartbeatEvidenceOf(existing)
    if (evidence.host === undefined) evidence.host = hostTag()
    return evidence
  }
  const evidence = { host: hostTag() }
  const bootId = currentBootId()
  if (bootId !== '') evidence.boot_id = bootId
  evidence.pid = process.pid
  const start = pidStartTime(process.pid)
  if (start !== null) evidence.pid_start = start
  return evidence
}

/** Age of one heartbeat record in seconds (`updated_at`, else record/file mtime). */
function heartbeatAgeOf(record, now, fallbackMtime) {
  if (!isPlainObject(record)) return Number.POSITIVE_INFINITY
  const stamp = parseHeartbeatStamp(record.updated_at)
  const reference = Number.isFinite(stamp)
    ? stamp
    : Number.isFinite(record.mtime)
      ? record.mtime
      : Number.isFinite(fallbackMtime)
        ? fallbackMtime
        : Number.NaN
  if (!Number.isFinite(reference)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor((now - reference) / 1000))
}

/**
 * Pure liveness verdict for one heartbeat record (no writes, no warnings).
 *
 * Evidence order (T-20261112184401 changed steps 2 and 5):
 * 1. a different `host` is `foreign` — another machine's session is not this
 *    machine's to judge (and never occupies a domain here);
 * 2. `registryLive` is the **host session registry** verdict and it is
 *    authoritative: `true` proves the session is alive even when the shared host
 *    pid is the only other evidence, `false` proves the session is GONE (the host
 *    process still runs but the session stopped) and releases its claims
 *    immediately — before the pid/TTL fallbacks. In particular a *fresh* record
 *    is still dead when the registry says the session is gone (registry beats
 *    TTL). The caller supplies `false` only when the record provably belongs to
 *    its own process; another DSH process's registry must not kill its sessions;
 * 3. a different `boot_id` on the same machine is `dead` (host restarted);
 * 4. a recorded pid that is gone, or whose `/proc` start time no longer matches
 *    (`pid_start`), is `dead`; otherwise the pid proves `live`. The pid is the
 *    **host** pid shared by every session of that process, so it only answers
 *    "the host is still running", never "this session is still running";
 * 5. records without any liveness evidence (legacy files, or a CLI-written
 *    `host`-only record) fall back to the **TTL lease**: fresh → `unknown`,
 *    older than `HEARTBEAT_STALE_SECONDS` → `stale`. A session that stops
 *    renewing (`updated_at`) therefore releases its claims when the lease
 *    expires. Age uses `updated_at`; when that is unparseable it falls back to
 *    the record's `mtime` or the caller-supplied file mtime.
 *
 * `evidence` names the rung that produced the verdict (`host` / `registry` /
 * `boot` / `pid` / `ttl`), so a reader without a registry can label the whole
 * read `ttl-only` and show that its reliability is one notch lower.
 *
 * @param {object} record heartbeat JSON record
 * @param {{now?:number, host?:string, bootId?:string, mtime?:number, registryLive?:boolean}} [options] injectable clock/identity plus the host registry verdict
 * @returns {{liveness:'live'|'dead'|'stale'|'foreign'|'unknown', reason:string, ageSeconds:number, evidence:string}}
 */
export function livenessOf(record, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const host = typeof input.host === 'string' && input.host !== '' ? input.host : hostTag()
  const bootId = typeof input.bootId === 'string' ? input.bootId : currentBootId()
  const ageSeconds = heartbeatAgeOf(record, now, Number.isFinite(input.mtime) ? input.mtime : undefined)
  if (!isPlainObject(record)) return { liveness: 'unknown', reason: 'no-record', ageSeconds, evidence: 'none' }

  const recordHost = typeof record.host === 'string' ? record.host.trim() : ''
  const recordBoot = typeof record.boot_id === 'string' ? record.boot_id.trim() : ''
  const pid = Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null
  const pidStart = Number.isFinite(record.pid_start) && record.pid_start > 0 ? record.pid_start : null

  if (recordHost !== '' && recordHost !== host) {
    return { liveness: 'foreign', reason: 'other-host', ageSeconds, evidence: 'host' }
  }
  // The registry answers the question the pid cannot: is *this session* alive?
  if (input.registryLive === true) {
    return { liveness: 'live', reason: 'agent-live', ageSeconds, evidence: 'registry' }
  }
  if (input.registryLive === false) {
    return { liveness: 'dead', reason: 'session-gone', ageSeconds, evidence: 'registry' }
  }
  if (recordBoot !== '' && bootId !== '' && recordBoot !== bootId) {
    return { liveness: 'dead', reason: 'boot-changed', ageSeconds, evidence: 'boot' }
  }
  if (pid !== null) {
    if (pidAlive(pid) !== true) return { liveness: 'dead', reason: 'pid-gone', ageSeconds, evidence: 'pid' }
    const actualStart = pidStartTime(pid)
    if (pidStart !== null && actualStart !== null && actualStart !== pidStart) {
      return { liveness: 'dead', reason: 'pid-reused', ageSeconds, evidence: 'pid' }
    }
    return { liveness: 'live', reason: 'pid-alive', ageSeconds, evidence: 'pid' }
  }
  if (ageSeconds > HEARTBEAT_STALE_SECONDS) {
    return { liveness: 'stale', reason: 'no-liveness-evidence', ageSeconds, evidence: 'ttl' }
  }
  return { liveness: 'unknown', reason: 'no-liveness-evidence', ageSeconds, evidence: 'ttl' }
}

/**
 * Registry evidence for one raw heartbeat record, or `undefined` when the
 * registry cannot speak for it.
 *
 * The host passes `context.sessionLive(session)` → `true` / `false` /
 * `undefined` (its `agents` service). Rules:
 * - no probe → `undefined` (callers fall back to pid + TTL, labelled `ttl-only`);
 * - a record written on another `host` → `undefined` (the local registry does not
 *   know other machines' sessions);
 * - `true` is positive proof for any same-host record;
 * - `false` only applies to a record written by **this process**
 *   (`pid === process.pid`): another DSH process's sessions are absent from our
 *   registry but alive, and must not be judged dead.
 */
export function registryVerdictOf(record, context) {
  const probe = isPlainObject(context) && typeof context.sessionLive === 'function' ? context.sessionLive : null
  if (probe === null || isPlainObject(record) === false) return undefined
  const session = typeof record.session === 'string' ? record.session.trim() : ''
  if (session === '') return undefined
  const recordHost = typeof record.host === 'string' ? record.host.trim() : ''
  const host = typeof context.host === 'string' && context.host !== '' ? context.host : hostTag()
  if (recordHost !== '' && recordHost !== host) return undefined
  let live
  try {
    live = probe(session)
  } catch {
    live = undefined
  }
  if (live === true) return true
  if (live !== false) return undefined
  const pid = Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null
  // `context.ownerPid`：宿主进程 pid。fork 出的 state worker 里 process.pid 是 worker
  // 自己的，必须由宿主把真实 pid 传进来，否则"本进程写的记录"永远判不成立。
  const ownerPid = Number.isInteger(context.ownerPid) && context.ownerPid > 0 ? context.ownerPid : process.pid
  return pid !== null && pid === ownerPid ? false : undefined
}

/**
 * 在**已经投影好的心跳行**上应用同一套注册表证据（T-20261112202457）。
 *
 * 用处：state worker 是 fork 出来的，CLI 的 `flow state --json` 更是另一个进程，
 * 它们都拿不到宿主注册表。宿主拿到 payload 后用这个函数补上注册表判据——与 claims
 * 门禁共用 `registryVerdictOf` + `livenessOf` 的口径（同一函数、同一优先级），
 * 不再有"面板一套、门禁一套"的第二份逻辑。
 *
 * 规则与投影完全一致：
 * - 注册表说活 → `live` / `agent-live`（即使 pid 证据不够）；
 * - 注册表说死 → `dead` / `session-gone`，但**只对 `row.pid === ownerPid` 的行**生效
 *   （别的 DSH 进程写的记录不在本进程注册表里，不能替它判死）；
 * - 跨机器行（`liveness === 'foreign'`）不动：本机注册表不替别的机器说话。
 *
 * @param {object[]} items 投影行（会被就地改写）
 * @param {{sessionLive?:(s:string)=>boolean|undefined, ownerPid?:number, host?:string}} [options]
 */
export function applyRegistryLiveness(items, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const probe = typeof input.sessionLive === 'function' ? input.sessionLive : null
  if (probe === null || Array.isArray(items) === false) return items
  const host = typeof input.host === 'string' && input.host !== '' ? input.host : hostTag()
  const ownerPid = Number.isInteger(input.ownerPid) && input.ownerPid > 0 ? input.ownerPid : process.pid
  for (const item of items) {
    if (isPlainObject(item) === false) continue
    const session = typeof item.session === 'string' ? item.session : ''
    if (session === '') continue
    // 行里没有 host 字段（投影只把结论给出去），所以跨机器行靠 liveness==='foreign' 排除。
    if (item.liveness === 'foreign') continue
    const evidence = { session, pid: Number.isInteger(item.pid) ? item.pid : undefined, host }
    const registry = registryVerdictOf(evidence, { sessionLive: probe, host, ownerPid })
    if (registry === true) {
      item.liveness = 'live'
      item.reason = 'agent-live'
      item.livenessEvidence = 'registry'
    } else if (registry === false) {
      item.liveness = 'dead'
      item.reason = 'session-gone'
      item.livenessEvidence = 'registry'
    }
  }
  return items
}

/** ISO instant at which the TTL lease of one record expires (`null` when unparsable). */
function heartbeatLeaseExpiresAt(record, fallbackMtime) {
  const stamp = isPlainObject(record) ? parseHeartbeatStamp(record.updated_at) : Number.NaN
  const reference = Number.isFinite(stamp) ? stamp : Number.isFinite(fallbackMtime) ? fallbackMtime : Number.NaN
  if (!Number.isFinite(reference)) return null
  return new Date(reference + HEARTBEAT_STALE_SECONDS * 1000).toISOString()
}

/**
 * Whether a heartbeat counts as active.
 *
 * `live` is exempt from the 6 h freshness fallback: a matching pid proves the
 * session still exists even if it stopped updating its heartbeat (the host may
 * be busy). `unknown` still needs to be fresh, and `dead`/`foreign`/`stale` are
 * never active.
 */
function heartbeatIsActive(activeStatus, liveness, ageSeconds) {
  if (activeStatus !== true) return false
  if (liveness === 'live') return true
  if (liveness === 'dead' || liveness === 'foreign' || liveness === 'stale') return false
  return ageSeconds <= HEARTBEAT_STALE_SECONDS
}

/** JSON heartbeat files under the heartbeat dir; a missing dir is silent. */
function heartbeatFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // A missing heartbeat directory is a normal, silent empty section.
    if (error.code === 'ENOENT') return []
    noteWarning(`heartbeat-dir-unreadable: ${toPosix(dir)}: ${error.message}`)
    return []
  }
  const files = []
  for (const entry of entries) {
    if (entry.isFile() !== true) continue
    if (!entry.name.toLowerCase().endsWith('.json')) continue
    files.push({ name: entry.name, path: join(dir, entry.name) })
  }
  return files
}

export function readHeartbeatJson(file, now) {
  let stats
  let raw
  try {
    stats = statSync(file.path)
    raw = readFileSync(file.path, 'utf8')
  } catch (error) {
    noteWarning(`heartbeat-unreadable: ${file.name}: ${error.message}`)
    return null
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    noteWarning(`heartbeat-invalid: ${file.name}: ${error.message}`)
    return null
  }
  if (!isPlainObject(value)) {
    noteWarning(`heartbeat-invalid: ${file.name}: not a JSON object`)
    return null
  }
  // Old automation registered one heartbeat per subagent run; those records are
  // legacy data now and stay hidden from every read (a main-session ledger).
  if (value.agent === LEGACY_SUBAGENT_AGENT) return null
  const parts = []
  if (typeof value.status === 'string' && value.status.trim() !== '') parts.push(value.status.trim())
  if (typeof value.last_action === 'string' && value.last_action.trim() !== '') {
    parts.push(value.last_action.trim())
  }
  const statusLine = clipText(parts.join(' · '), 200)
  const stamp = parseHeartbeatStamp(value.updated_at)
  const reference = Number.isFinite(stamp) ? stamp : stats.mtimeMs
  return {
    file: file.name,
    title: clipText(file.name.replace(/\.[^.]+$/, '')),
    statusLine,
    ageSeconds: Math.max(0, Math.floor((now - reference) / 1000)),
    mtime: Math.round(stats.mtimeMs),
  }
}

/**
 * Heartbeats under `contract.heartbeats.dir` (`*.json`), newest first and
 * truncated to `contract.heartbeats.max`. Only `source: 'none'` disables the
 * section. The ledger root is the project's main worktree, so a session in a
 * linked worktree reads the same section. Records whose `agent` is `subagent`
 * are legacy automation and stay hidden.
 * Item shape kept for existing callers:
 * `{ file, title, statusLine, ageSeconds, mtime }` — the richer projection is
 * `readHeartbeatSection`.
 */
export function readHeartbeats(root, contract) {
  const absRoot = heartbeatWorkspace(root).root
  const c = normalizeContract(absRoot, contract)
  if (c.heartbeats.source === 'none') return []
  const dir = heartbeatDirPath(absRoot, c)
  const now = Date.now()
  const items = []
  for (const file of heartbeatFiles(dir)) {
    const item = readHeartbeatJson(file, now)
    if (item !== null) items.push(item)
  }
  items.sort((left, right) => right.mtime - left.mtime || String(left.file).localeCompare(String(right.file)))
  return items.slice(0, heartbeatMax(c))
}

/** Absolute heartbeat directory for one contract (always inside the project root). */
function heartbeatDirPath(absRoot, c, memo) {
  const configured = c.heartbeats && typeof c.heartbeats.dir === 'string' ? c.heartbeats.dir.trim() : ''
  const fallback = join(absRoot, '.agents/heartbeat')
  return containedDir(absRoot, configured, 'heartbeats.dir', fallback, memo)
}

function heartbeatMax(c) {
  const requested = Number(c.heartbeats.max)
  return Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 20
}

/** Rich projection of one JSON heartbeat (`schema: 1`); optional liveness context. */
function richHeartbeatJson(file, now, context) {
  let stats
  let raw
  try {
    stats = statSync(file.path)
    raw = readFileSync(file.path, 'utf8')
  } catch (error) {
    noteWarning(`heartbeat-unreadable: ${file.name}: ${error.message}`)
    return null
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    noteWarning(`heartbeat-invalid: ${file.name}: ${error.message}`)
    return null
  }
  if (!isPlainObject(value)) {
    noteWarning(`heartbeat-invalid: ${file.name}: not a JSON object`)
    return null
  }
  const stamp = parseHeartbeatStamp(value.updated_at)
  const reference = Number.isFinite(stamp) ? stamp : stats.mtimeMs
  const ageSeconds = Math.max(0, Math.floor((now - reference) / 1000))
  const status = typeof value.status === 'string' ? value.status.trim() : ''
  const stem = file.name.replace(/\.[^.]+$/, '')
  const agent = typeof value.agent === 'string' ? value.agent : ''
  // Read-side marker for records written by the removed subagent automation:
  // projected but never rendered, and removed by `gcLegacyHeartbeats`.
  const legacy = agent === LEGACY_SUBAGENT_AGENT
  const item = {
    file: file.name,
    session: typeof value.session === 'string' && value.session.trim() !== '' ? value.session.trim() : stem,
    agent,
    legacy,
    hidden: legacy,
    goal: typeof value.goal === 'string' ? value.goal : '',
    // Host-assigned session title (display-only; panel rows show it as the name).
    title: typeof value.title === 'string' ? value.title.trim() : '',
    task: typeof value.task === 'string' && value.task !== '' ? value.task : null,
    claims: Array.isArray(value.claims) ? value.claims.filter((entry) => typeof entry === 'string') : [],
    status,
    last_action: typeof value.last_action === 'string' ? value.last_action : '',
    started_at: typeof value.started_at === 'string' ? value.started_at : null,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : null,
    ended_at: typeof value.ended_at === 'string' ? value.ended_at : null,
    // Optional branch provenance (§3.5, written by startHeartbeat since
    // 2026-11-08): projected only when present so older records keep the exact
    // row shape, and the panel can badge the session's branch/worktree.
    ...(typeof value.branch === 'string' && value.branch.trim() !== '' ? { branch: value.branch.trim() } : {}),
    ...(typeof value.worktree === 'string' && value.worktree.trim() !== '' ? { worktree: value.worktree.trim() } : {}),
    // Supply provenance (2026-11-13): projected only when present, exactly like
    // branch/worktree, so older record rows keep their shape.
    ...(HEARTBEAT_PROVENANCE.includes(value.provenance) ? { provenance: value.provenance } : {}),
    ageSeconds,
    stale: ageSeconds > HEARTBEAT_STALE_SECONDS,
    /* 记录里的宿主 pid（T-20261112202457）：只是**证据线索**，不是存活结论。宿主侧富化
       要用它区分"本进程写的记录"（可以否证）与"别的 DSH 进程写的记录"（不能否证）。
       旧记录没有该字段 → null。 */
    pid: Number.isInteger(value.pid) && value.pid > 0 ? value.pid : null,
    turn: Number.isInteger(value.turn) ? value.turn : null,
    stats: isPlainObject(value.stats) ? deepClone(value.stats) : null,
    mtime: Math.round(stats.mtimeMs),
  }
  // Liveness is judged from the raw record (host/boot_id/pid/pid_start) plus the
  // host session registry when the caller has one (T-20261112184401), and only
  // the verdict is projected: the evidence itself stays in the file.
  if (context !== undefined && context !== null) {
    const mtime = Math.round(stats.mtimeMs)
    const verdict = livenessOf(value, {
      now,
      host: typeof context.host === 'string' ? context.host : undefined,
      bootId: typeof context.bootId === 'string' ? context.bootId : undefined,
      // F2: an unparseable `updated_at` still gets a real age from the file mtime.
      mtime,
      registryLive: registryVerdictOf(value, context),
    })
    item.liveness = verdict.liveness
    item.reason = verdict.reason
    // Which evidence produced the verdict; `ttl` means "pid had nothing to say
    // and only the lease age decided" — the caller labels the whole read
    // `ttl-only` when it has no registry at all.
    item.livenessEvidence = verdict.evidence
    item.leaseExpiresAt = heartbeatLeaseExpiresAt(value, mtime)
  }
  return item
}

/**
 * Aggregate heartbeat section reused by `readStoreState` and the CLI.
 * Items carry the full heartbeat fields plus `ageSeconds` / `stale` / `mtime`;
 * counts are `{ total, active, stale, hidden }` where active means working|idle
 * and hidden counts legacy subagent records excluded from `items`.
 * `root` is the resolved ledger root (the project's main worktree).
 *
 * @param {string} root project root
 * @param {object} contract flow contract
 * @param {{pathMemo?: Map<string,string|Error>}} [options] per-request realpath memo
 */
export function readHeartbeatSection(root, contract, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const memo = pathMemoOf(options)
  const workspace = heartbeatWorkspace(root)
  const absRoot = workspace.root
  const c = normalizeContract(absRoot, contract)
  const base = {
    root: toPosix(absRoot),
    ...(workspace.degraded === true ? { degraded: true, reason: workspace.reason } : {}),
  }
  if (c.heartbeats.source === 'none') {
    const configured = typeof c.heartbeats.dir === 'string' ? c.heartbeats.dir.trim() : ''
    return {
      ...base,
      dir: configured === '' ? '.agents/heartbeat' : toPosix(configured),
      items: [],
      counts: { total: 0, active: 0, stale: 0, dead: 0, hidden: 0 },
      hiddenByVisibility: 0,
      livenessEvidence: typeof input.sessionLive === 'function' ? 'registry' : 'ttl-only',
      leaseSeconds: HEARTBEAT_STALE_SECONDS,
    }
  }
  const dir = heartbeatDirPath(absRoot, c, memo)
  // Report the directory actually read, so a rejected manifest value is not
  // echoed back as if it had been used.
  const dirLabel = toPosix(relative(absRoot, dir)) || '.'
  const now = Date.now()
  // The host's session registry (T-20261112184401) answers "is this session
  // still alive" — the pid only answers "is the host process alive". Callers
  // without the service (CLI, forked snapshot) omit it and the read is labelled
  // `ttl-only` below.
  const sessionLive = typeof input.sessionLive === 'function' ? input.sessionLive : undefined
  const context = {
    host: hostTag(),
    bootId: currentBootId(),
    sessionLive,
    // 宿主进程 pid：worker 里 process.pid 不是宿主 pid（见 registryVerdictOf）。
    ownerPid: Number.isInteger(input.ownerPid) && input.ownerPid > 0 ? input.ownerPid : undefined,
  }
  const items = []
  let hidden = 0
  for (const file of heartbeatFiles(dir)) {
    const item = richHeartbeatJson(file, now, context)
    if (item === null) continue
    if (item.hidden === true) {
      hidden += 1
      continue
    }
    items.push(item)
  }
  items.sort((left, right) => right.mtime - left.mtime || String(left.file).localeCompare(String(right.file)))
  const limited = items.slice(0, heartbeatMax(c))
  // A heartbeat is active only when its status says so AND its session is not
  // provably dead/foreign AND the 6 h freshness fallback still holds. A stale
  // record therefore no longer counts as active (the user-visible bug fix).
  const isActive = (item) =>
    heartbeatIsActive(HEARTBEAT_ACTIVE_STATUS.includes(item.status), item.liveness, item.ageSeconds)
  // 任务阶段（2026-11-11）：心跳只存 task id，阶段要 join 任务卡。旧记录没有 task
  // 时字段显式为 null，面板/CLI 不用区分 undefined 与「阶段未知」。
  const taskStages = limited.some((item) => item.task !== null)
    ? taskStagesById(absRoot, c, input.taskRecords)
    : new Map()
  for (const item of limited) attachTaskStage(item, taskStages)
  // Visibility (T-13): by default the panel/CLI only show heartbeats that still
  // look alive — `live`, or `unknown`/`foreign` within the 6 h fallback. `dead`
  // and `stale` rows disappear from `items` (files stay; the read path never
  // writes) and are reported through `hiddenByVisibility`. `visibility:'all'`
  // (or the equivalent `includeEnded:true`, used by `--all`) keeps every row.
  const visibility = input.visibility === 'all' || input.includeEnded === true ? 'all' : 'active'
  const visible = (item) => {
    if (item.liveness === 'live') return true
    if (item.liveness === 'dead' || item.liveness === 'stale') return false
    if (Number.isFinite(item.ageSeconds) === false) return false
    return item.ageSeconds <= HEARTBEAT_STALE_SECONDS
  }
  const visibleItems = visibility === 'all' ? limited : limited.filter(visible)
  return {
    ...base,
    dir: dirLabel,
    items: visibleItems,
    counts: {
      total: limited.length,
      active: limited.filter(isActive).length,
      stale: limited.filter((item) => item.stale === true).length,
      dead: limited.filter((item) => item.liveness === 'dead').length,
      hidden,
    },
    hiddenByVisibility: limited.length - visibleItems.length,
    /* Which evidence could be used at all: `registry` = the host session
       registry was consulted (per-row `livenessEvidence` still says which rung
       decided); `ttl-only` = no registry capability here (CLI, forked snapshot),
       so reliability is one notch lower and the TTL lease is the only backstop. */
    livenessEvidence: sessionLive === undefined ? 'ttl-only' : 'registry',
    leaseSeconds: HEARTBEAT_STALE_SECONDS,
  }
}

// --------------------------------------------------- heartbeat write API

/**
 * Windows device names are matched on the stem before the first dot, so
 * `con.txt` / `nul.tar.gz` are as unusable as `CON` / `NUL`.
 */
function windowsReservedSessionName(session) {
  const stem = session.split('.')[0].trim().toUpperCase()
  return WINDOWS_RESERVED_SESSION_NAMES.has(stem)
}

/**
 * Validate a session id that doubles as a file name: no separators, no `..`,
 * no control characters, at most 80 characters, and nothing Windows would
 * reject or silently rewrite (reserved device names, `[<>:"|?*]`, trailing dot
 * or space). The invalid payload is one shape so callers/tests can rely on it.
 */
function assertSessionName(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FlowError('usage', 'heartbeat session is required (pass --session or set DSH_SESSION_ID)')
  }
  const shown = JSON.stringify(value)
  // Windows strips a trailing dot/space, so `a.` / `a ` would collide with `a`
  // on disk. Inspect the raw value: the trim below would hide the problem.
  if (/[. ]$/.test(value)) {
    throw invalid(`heartbeat session is not a safe file name: ${shown} (trailing dot or space)`)
  }
  const session = value.trim()
  if (session.length > HEARTBEAT_SESSION_MAX) {
    throw invalid(`heartbeat session is too long (max ${HEARTBEAT_SESSION_MAX}): ${session.length}`)
  }
  if (session.includes('..') || session.includes('/') || session.includes('\\') || /[\u0000-\u001f\u007f]/.test(session)) {
    throw invalid(`heartbeat session is not a safe file name: ${shown}`)
  }
  if (WINDOWS_UNSAFE_SESSION_CHARS_RE.test(session)) {
    throw invalid(`heartbeat session is not a safe file name: ${shown} (Windows reserves < > : " | ? *)`)
  }
  if (windowsReservedSessionName(session)) {
    throw invalid(`heartbeat session is not a safe file name: ${shown} (Windows reserved device name)`)
  }
  return session
}

/**
 * Where a heartbeat record came from (2026-11-13, optional field):
 * - `host-session`: written by the plugin for a host agent session (agent id).
 * - `env-session`: written from `DSH_SESSION_ID` (a process that knows its session).
 * - `cli-process`: written by a one-shot CLI process with no session context.
 * Older records omit the field; the read side treats absence as "unknown".
 */
export const HEARTBEAT_PROVENANCE = Object.freeze(['host-session', 'env-session', 'cli-process'])

/**
 * A stable, file-safe session id for a process that has neither a host agent id
 * nor `DSH_SESSION_ID`. Liveness is still judged by {@link livenessOf} from the
 * writer evidence (host/boot_id/pid/pid_start) — this id only names the record.
 */
export function processHeartbeatSession() {
  // Host prefix matters: WSL and Windows can share the same project directory
  // over /mnt/d, where two processes with the same pid would otherwise overwrite
  // each other's record (the host evidence then judges it foreign and the real
  // writer gets blocked). Keep it file-safe and bounded.
  const machine = typeof hostTag === 'function' ? String(hostTag()).split('|')[0] : ''
  const host = machine
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return `cli-${host === '' ? 'host' : host}-${process.pid}`
}

/** Normalize an optional provenance value; `''` means "not recorded". */
function normalizeProvenance(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw invalid(`provenance must be one of ${HEARTBEAT_PROVENANCE.join(', ')}`)
  }
  const text = value.trim()
  if (text === '') return ''
  if (HEARTBEAT_PROVENANCE.includes(text) === false) {
    throw invalid(`provenance must be one of ${HEARTBEAT_PROVENANCE.join(', ')}`)
  }
  return text
}

/**
 * Sessions with a heartbeat that is not provably gone (dead/foreign are
 * excluded), newest visibility order. Used to answer "which session is this CLI
 * running for" when neither `--session` nor `DSH_SESSION_ID` is available.
 */
export function activeHeartbeatSessions(root, contract, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const section = readHeartbeatSection(root, contract, { ...input, visibility: 'all' })
  return section.items
    .filter(
      (item) =>
        HEARTBEAT_ACTIVE_STATUS.includes(item.status) &&
        item.liveness !== 'dead' &&
        item.liveness !== 'foreign',
    )
    .map((item) => item.session)
}

/** Explicit session wins, then `DSH_SESSION_ID`; nothing means usage error. */
function resolveHeartbeatSession(value) {
  // Keep the raw value when it is non-empty: assertSessionName must see a
  // trailing dot/space instead of the trim normalizing it away. A blank value
  // still reaches it (and reports `usage`) instead of silently falling back to
  // the environment: only a truly empty explicit value loses to DSH_SESSION_ID.
  const explicit = typeof value === 'string' ? value : ''
  const fromEnv = typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID : ''
  return assertSessionName(explicit !== '' ? explicit : fromEnv)
}

/** Trimmed, bounded claims; empty entries are dropped. */
function normalizeClaims(value, label = 'claims') {
  const list = stringArray(value, label)
  const claims = []
  for (const item of list) {
    const claim = item.trim()
    if (claim === '') continue
    if (claim.length > HEARTBEAT_CLAIM_MAX) throw invalid(`${label} entry is too long (max ${HEARTBEAT_CLAIM_MAX})`)
    claims.push(claim)
  }
  return claims
}

/** Read one heartbeat file; `null` when it does not exist, `io` when unreadable. */
function readHeartbeatRecord(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new FlowError('io', `cannot read ${toPosix(file)}: ${error.message}`)
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) throw new Error('record is not a JSON object')
    return parsed
  } catch (error) {
    throw new FlowError('io', `invalid heartbeat record ${toPosix(file)}: ${error.message}`)
  }
}

/**
 * The task a session currently works on, by descending priority:
 * 1. owned by this session; 2. owned by the session's agent — real owners are
 * usually role names (`lead`, `agent-a`) rather than session ids, so an exact
 * session match alone misses in-flight cards; 3. the oldest **unowned** `active`
 * task and 4. the oldest **unowned** `draft` task. The queue is FIFO: candidates
 * are ordered by `created_at` ascending (missing/unparseable `created_at` sorts
 * last), so a patched card keeps its place instead of jumping to the front;
 * `updated_at` is no longer a claim ordering key.
 *
 * Rules 3 and 4 skip tasks that name another owner: a parallel session or a
 * subagent must not attach its heartbeat — or its exclusive `claims` — to a card
 * somebody else is working on. Falls back to `null`, and the caller then decides
 * whether to create a task.
 */
function pickSessionTask(records, { session = '', agent = '' } = {}) {
  const candidates = records.filter((record) => typeof record.id === 'string')
  const oldest = (predicate) => {
    const hits = candidates.filter(predicate)
    return hits.length === 0 ? null : sortByCreatedAsc(hits)[0]
  }
  const unowned = (record) => (typeof record.owner === 'string' ? record.owner.trim() === '' : true)
  return oldest((record) => record.owner === session)
    ?? oldest((record) => agent !== '' && record.owner === agent)
    ?? oldest((record) => unowned(record) && record.status === 'active')
    ?? oldest((record) => unowned(record) && record.status === 'draft')
    ?? null
}

function heartbeatTaskClaims(task) {
  return task !== null && isPlainObject(task.scope) && Array.isArray(task.scope.allow)
    ? task.scope.allow.filter((item) => typeof item === 'string')
    : []
}

/**
 * 任务阶段投影（2026-11-11）：心跳只存 `task`（id），阶段要 join 任务卡才有。
 * 现代记录直接读 `stage`；旧记录按 `status` 经 `lib/stage.mjs` 派生——与任务读投影
 * （`projectTaskStage`）和面板（`taskStageOf`）同一张表，这里不另建阶段表。
 * 非法/缺失记录返回 `null`（调用方投影成「阶段未知」）。
 */
function stageOfTaskRecord(record) {
  if (isPlainObject(record) === false) return null
  const stage = typeof record.stage === 'string' ? record.stage.trim() : ''
  return STAGE_IDS.includes(stage) ? stage : legacyStageFromStatus(record.status)
}

/**
 * `Map<taskId, stage>`，供心跳 → 任务 join。**best effort**：任务库读不出来只丢
 * 阶段标注，绝不让心跳小节整段消失。`provided` 让面板直接交回它已读到的任务行，
 * 避免一次重复扫描。
 */
function taskStagesById(absRoot, c, provided) {
  const stages = new Map()
  let records = Array.isArray(provided) ? provided : null
  if (records === null) {
    try {
      records = readCollection(storePaths(absRoot, c).tasks).map((item) => item.record)
    } catch {
      records = []
    }
  }
  for (const record of records) {
    if (isPlainObject(record) === false || typeof record.id !== 'string' || record.id === '') continue
    const stage = stageOfTaskRecord(record)
    if (stage !== null) stages.set(record.id, stage)
  }
  return stages
}

/** 给一条心跳行挂上 `taskStage` / `taskStageZh`；无任务或任务不存在时为 `null`。 */
function attachTaskStage(item, stages) {
  const stage = item.task === null ? null : stages.get(item.task) ?? null
  item.taskStage = stage
  item.taskStageZh = stage === null ? null : STAGE_ZH[stage] ?? null
}

/**
 * Open (or refresh) this session's heartbeat. A repeated start keeps the first
 * `started_at`, increments `turn` / `stats.turns`, clears `ended_at` and resets
 * `status` to `working`. When no task is given it reuses the task picked by
 * `pickSessionTask` (session owner, then agent owner, then oldest active, then
 * oldest draft — FIFO by `created_at`) and — unless `createTask: false` — creates a draft task owned
 * by the session only when none matched, so the returned id can be written
 * back. An explicit `task` wins and must exist.
 *
 * @returns heartbeat record plus `createdTask` (new task id or `null`).
 */
export function startHeartbeat(root, contract, options = {}) {
  const sessionRoot = resolve(root)
  const workspace = heartbeatWorkspace(sessionRoot)
  const absRoot = workspace.root
  // Branch provenance: the ledger is shared by every worktree of the project,
  // so a heartbeat records which branch/worktree the session actually runs on.
  const branch = gitBranchOf(sessionRoot)
  const worktree = absRoot === sessionRoot ? null : toPosix(relative(absRoot, sessionRoot))
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const input = isPlainObject(options) ? options : {}
  const session = resolveHeartbeatSession(input.session)
  const goalInput = typeof input.goal === 'string' && input.goal.trim() !== '' ? input.goal.trim() : null
  const claimsInput = input.claims === undefined || input.claims === null ? null : normalizeClaims(input.claims)
  const titleInput = input.title === undefined || input.title === null ? null : optionalText(input.title, 'title', '')
  const requestedTask = input.task === undefined || input.task === null ? '' : String(input.task).trim()
  const file = join(heartbeatDirPath(absRoot, c), `${session}.json`)

  return withLock(absRoot, c, (paths) => {
    const records = readCollection(paths.tasks).map((item) => item.record)
    const previous = readHeartbeatRecord(file)
    /* Resolved before task selection: the effective agent (`--agent`, else the
       previous heartbeat's) takes part in picking the task to reuse. */
    const agent = input.agent === undefined || input.agent === null
      ? (previous !== null && typeof previous.agent === 'string' ? previous.agent : '')
      : optionalText(input.agent, 'agent', '')
    let task = null
    if (requestedTask !== '') {
      task = records.find((record) => record.id === requestedTask) ?? null
      if (task === null) throw new FlowError('not-found', `task ${requestedTask} not found`)
    } else {
      task = pickSessionTask(records, { session, agent })
    }

    const goal = goalInput ?? (task !== null && typeof task.title === 'string' ? task.title : '未命名任务')
    let createdTask = null
    if (task === null && input.createTask !== false) {
      if (typeof HOOKS.buildTask !== 'function' || typeof HOOKS.taskIds !== 'function') {
        throw new FlowError(
          'invalid',
          'heartbeats 域未装配任务建卡能力 —— 请经由 lib/core.mjs 调用（直接 import 域模块需先 configureHeartbeats）',
        )
      }
      createdTask = HOOKS.buildTask(
        { type: 'chore', title: goal, status: 'draft', owner: session, scope: { allow: claimsInput ?? [] } },
        { existingIds: HOOKS.taskIds(paths) },
      )
      assertTargetFree(paths.tasks, createdTask.id)
      writeJsonAtomic(join(paths.tasks, `${createdTask.id}.json`), createdTask)
      task = createdTask
    }

    const claims = claimsInput ?? heartbeatTaskClaims(task)
    // Session title (the host's `ctx.sessionTitle` snapshot): display-only and
    // bounded. An explicit title wins; a repeated start keeps the previous one.
    const previousTitle = previous !== null && typeof previous.title === 'string' ? previous.title.trim() : ''
    const title = titleInput === null
      ? clipText(previousTitle, HEARTBEAT_TITLE_MAX)
      : clipText(titleInput.trim(), HEARTBEAT_TITLE_MAX)
    // The host may open the record as `idle`/`waiting` when the session is not
    // actually inside a turn; explicit CLI `start` keeps the historical
    // `working` default.
    const statusInput = input.status === undefined || input.status === null ? 'working' : input.status
    if (typeof statusInput !== 'string' || !HEARTBEAT_STATUS.includes(statusInput)) {
      throw invalid(`status must be one of ${HEARTBEAT_STATUS.join(', ')}`)
    }

    let turn
    if (input.turn !== undefined && input.turn !== null) {
      turn = optionalInt(input.turn, 'turn', 1, 1)
    } else if (previous !== null && Number.isInteger(previous.turn) && previous.turn >= 0) {
      turn = previous.turn + 1
    } else {
      turn = 1
    }

    const previousStats = previous !== null && isPlainObject(previous.stats) ? previous.stats : null
    const previousTurns = previousStats !== null && Number.isInteger(previousStats.turns) && previousStats.turns >= 0
      ? previousStats.turns
      : null
    const missed = previousStats !== null && Number.isInteger(previousStats.missed) && previousStats.missed >= 0
      ? previousStats.missed
      : 0

    const previousAction = previous !== null && typeof previous.last_action === 'string' ? previous.last_action : ''
    const lastAction = input.last_action === undefined || input.last_action === null
      ? previousAction
      : optionalText(input.last_action, 'last_action', '')
    const startedAt = previous !== null && typeof previous.started_at === 'string' && previous.started_at.trim() !== ''
      ? previous.started_at
      : formatIso()
    // Provenance is optional and sticky: a repeated start keeps the previous
    // value unless the caller states a new source explicitly.
    const previousProvenance =
      previous !== null && typeof previous.provenance === 'string'
        ? normalizeProvenance(previous.provenance)
        : ''
    const provenance = input.provenance === undefined
      ? previousProvenance
      : normalizeProvenance(input.provenance)

    const record = {
      schema: HEARTBEAT_SCHEMA,
      session,
      agent,
      goal,
      task: task !== null && typeof task.id === 'string' ? task.id : null,
      claims,
      status: statusInput,
      turn,
      last_action: lastAction,
      started_at: startedAt,
      updated_at: formatIso(),
      ended_at: null,
      // Display-only session title; omitted when unknown so older records keep
      // their exact shape.
      ...(title !== '' ? { title } : {}),
      // Optional supply provenance (2026-11-13); omitted for records that do not
      // know where they came from so the historical shape is unchanged.
      ...(provenance !== '' ? { provenance } : {}),
      // CLI writers keep prior machine/pid proof; host writers refresh it (F1).
      ...heartbeatWriterEvidence(previous, input.writer),
      ...(branch !== null ? { branch } : {}),
      ...(worktree !== null && worktree !== '' ? { worktree } : {}),
      stats: { turns: previous === null ? turn : (previousTurns === null ? 1 : previousTurns + 1), missed },
    }
    writeJsonAtomic(file, record)
    return { ...record, createdTask: createdTask === null ? null : createdTask.id }
  })
}

/**
 * Patch one heartbeat record. Only `status` / `last_action` / `goal` / `task` /
 * `claims` / `turn` are accepted; anything else is `invalid` and `updated_at`
 * refreshes automatically.
 *
 * `options.writer: 'cli'` marks a one-shot CLI write: it never replaces the
 * record's liveness evidence (host/boot_id/pid/pid_start), only fills a missing
 * `host`. Host writers refresh all four fields.
 */
export function updateHeartbeat(root, contract, session, patch, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const writer = input.writer
  const absRoot = heartbeatWorkspace(root).root
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const name = resolveHeartbeatSession(session)
  if (!isPlainObject(patch)) throw invalid('heartbeat patch must be an object')
  for (const key of Object.keys(patch)) {
    if (!HEARTBEAT_PATCH_KEYS.includes(key)) throw invalid(`heartbeat ${key} cannot be changed`)
  }
  const file = join(heartbeatDirPath(absRoot, c), `${name}.json`)

  return withLock(absRoot, c, () => {
    const current = readHeartbeatRecord(file)
    if (current === null) {
      // 死路自查：会话面只有 update，而 update 对缺失记录只能报 not-found。
      // 所以文案必须给出**可执行**的恢复命令（人的逃生口是 CLI start），
      // 不能只说 "not found" 让会话无从下手。
      throw new FlowError(
        'not-found',
        `heartbeat ${name} not found（本会话没有心跳文件；插件只在会话创建时自动开启，` +
          `插件挂载前创建的会话会漏掉）。恢复命令: flow heartbeat start --session ${name}（或等待下一轮 agent/pre-step 自动补登记）`,
      )
    }
    const next = { ...current, schema: HEARTBEAT_SCHEMA, session: name }
    if (Object.hasOwn(patch, 'status')) {
      if (typeof patch.status !== 'string' || !HEARTBEAT_STATUS.includes(patch.status)) {
        throw invalid(`status must be one of ${HEARTBEAT_STATUS.join(', ')}`)
      }
      next.status = patch.status
    }
    if (Object.hasOwn(patch, 'last_action')) next.last_action = optionalText(patch.last_action, 'last_action', '')
    if (Object.hasOwn(patch, 'goal')) next.goal = optionalText(patch.goal, 'goal', '')
    if (Object.hasOwn(patch, 'task')) next.task = patch.task === null ? null : requireText(patch.task, 'task')
    if (Object.hasOwn(patch, 'claims')) next.claims = normalizeClaims(patch.claims)
    if (Object.hasOwn(patch, 'turn')) next.turn = optionalInt(patch.turn, 'turn', 1, 1)
    if (Object.hasOwn(patch, 'title')) {
      // Empty clears the display title (the projection then falls back); any
      // other value is trimmed and bounded.
      const title = optionalText(patch.title, 'title', '').trim()
      if (title === '') delete next.title
      else next.title = clipText(title, HEARTBEAT_TITLE_MAX)
    }
    next.updated_at = formatIso()
    // Refresh host evidence (a CLI process contributes only `host`; existing
    // pid evidence is kept so a CLI edit does not erase a live host's proof).
    Object.assign(next, heartbeatWriterEvidence(current, writer))
    writeJsonAtomic(file, next)
    return next
  })
}

/**
 * Close one heartbeat: default `status: 'done'`, stamp `ended_at` and fold a
 * non-empty `note` into `last_action`. The file stays on disk (the panel keeps
 * listing it).
 */
export function endHeartbeat(root, contract, options = {}) {
  const absRoot = heartbeatWorkspace(root).root
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const input = isPlainObject(options) ? options : {}
  const session = resolveHeartbeatSession(input.session)
  const status = input.status === undefined || input.status === null ? 'done' : input.status
  if (typeof status !== 'string' || !HEARTBEAT_STATUS.includes(status)) {
    throw invalid(`status must be one of ${HEARTBEAT_STATUS.join(', ')}`)
  }
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  const file = join(heartbeatDirPath(absRoot, c), `${session}.json`)

  return withLock(absRoot, c, () => {
    const current = readHeartbeatRecord(file)
    if (current === null) throw new FlowError('not-found', `heartbeat ${session} not found`)
    const previousAction = typeof current.last_action === 'string' ? current.last_action.trim() : ''
    const now = formatIso()
    const next = {
      ...current,
      schema: HEARTBEAT_SCHEMA,
      session,
      status,
      last_action: note === '' ? previousAction : (previousAction === '' ? note : `${previousAction} · ${note}`),
      updated_at: now,
      ended_at: now,
      // CLI writers keep prior machine/pid proof; host writers refresh it (F1).
      ...heartbeatWriterEvidence(current, input.writer),
    }
    writeJsonAtomic(file, next)
    return next
  })
}

/**
 * Remove one heartbeat file. This is the archive path: an archived session no
 * longer exists on the heartbeat surface, so its record is deleted instead of
 * being closed (a `done` record would still render as a row). Missing files are
 * not an error — removal is idempotent, which the archive event needs.
 *
 * @param {string} root project root (a linked worktree resolves to the main one)
 * @param {object} contract flow contract
 * @param {string} session exact session id to remove
 * @returns {{session:string, removed:boolean}}
 */
export function removeHeartbeat(root, contract, session) {
  const absRoot = heartbeatWorkspace(root).root
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const name = resolveHeartbeatSession(session)
  const file = join(heartbeatDirPath(absRoot, c), `${name}.json`)
  return withLock(absRoot, c, () => {
    try {
      unlinkSync(file)
    } catch (error) {
      if (error.code === 'ENOENT') return { session: name, removed: false }
      throw new FlowError('io', `cannot remove ${toPosix(file)}: ${error.message}`)
    }
    return { session: name, removed: true }
  })
}

/**
 * Read one session heartbeat. `active` means the file exists, its status is
 * `working`/`idle`, its liveness is not provably dead/foreign, and either the
 * pid proves it live (`liveness: 'live'` is exempt from the age fallback) or the
 * 6 h freshness fallback still holds. A broken file is reported as inactive with
 * a warning. The verdict fields (`liveness`/`reason`/`ageSeconds`) are the same
 * ones `readHeartbeatSection` projects.
 *
 * `options.sessionLive` is the host's session registry probe
 * (`(session) => true|false|undefined`, T-20261112184401): a positive answer
 * overrides the (shared host) pid, and a negative answer — only for a record
 * this process wrote — proves the session stopped, releasing its claims at once
 * even when the record is fresh. `options.live: true` is the older positive-only
 * spelling kept for existing callers and is equivalent to a positive answer.
 * This never fabricates a heartbeat: a missing record stays inactive.
 */
export function heartbeatStatus(root, contract, session, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const absRoot = heartbeatWorkspace(root).root
  const c = normalizeContract(absRoot, contract)
  const name = resolveHeartbeatSession(session)
  const file = join(heartbeatDirPath(absRoot, c), `${name}.json`)
  let record = null
  try {
    record = readHeartbeatRecord(file)
  } catch (error) {
    noteWarning(`heartbeat-invalid: ${name}.json: ${error.message}`)
  }
  let mtime
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    mtime = undefined
  }
  let verdict = livenessOf(record, {
    mtime,
    registryLive: registryVerdictOf(record, {
      sessionLive: input.sessionLive,
      host: hostTag(),
      ownerPid: Number.isInteger(input.ownerPid) && input.ownerPid > 0 ? input.ownerPid : undefined,
    }),
  })
  if (input.live === true && record !== null) {
    verdict = { ...verdict, liveness: 'live', reason: 'agent-live', evidence: 'registry' }
  }
  const statusActive =
    record !== null && typeof record.status === 'string' && HEARTBEAT_ACTIVE_STATUS.includes(record.status)
  const active = heartbeatIsActive(statusActive, verdict.liveness, verdict.ageSeconds)
  // 任务阶段（2026-11-11）：status 是单会话摘要，记录里只有 task id；按与
  // readHeartbeatSection 行同形的字段 join 任务卡（未挂任务 → null）。只是读投影，
  // 不写回记录。
  const taskId = record !== null && typeof record.task === 'string' && record.task !== '' ? record.task : ''
  const taskStage = taskId === '' ? null : taskStagesById(absRoot, c).get(taskId) ?? null
  return {
    active,
    liveness: verdict.liveness,
    reason: verdict.reason,
    ageSeconds: Number.isFinite(verdict.ageSeconds) ? verdict.ageSeconds : null,
    livenessEvidence: typeof verdict.evidence === 'string' && verdict.evidence !== '' ? verdict.evidence : 'ttl',
    leaseExpiresAt: heartbeatLeaseExpiresAt(record, mtime),
    provenance:
      record !== null && typeof record === 'object' && HEARTBEAT_PROVENANCE.includes(record.provenance)
        ? record.provenance
        : null,
    record,
    taskStage,
    taskStageZh: taskStage === null ? null : STAGE_ZH[taskStage] ?? null,
  }
}

/** 文件 mtime（毫秒），读不到时 undefined——liveness 会退回 updated_at。 */
function heartbeatFileMtime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Remove heartbeat files written by the removed subagent automation
 * (`agent: 'subagent'`). Those records are legacy: the read side already hides
 * them, and this is the explicit cleanup. The whole heartbeat dir is scanned.
 *
 * @param {string} root project root (a linked worktree resolves to the main one)
 * @param {object} contract flow contract
 * @param {{dryRun?:boolean}} [options] `dryRun: true` reports without deleting
 * @returns {{root:string, dir:string, removed:object[], kept:number, dryRun:boolean}}
 */
/**
 * 其他插件生成的后台任务会话（mnemon 的任务包装、后台 job 等）不是"用户会话"：
 * 它们一次性创建、用完即弃，给它们建心跳会让 `.agents/heartbeat/` 每来一个任务就
 * 多一个文件（面板上也多一行）。这里集中一份前缀表，读写两侧共用。
 */
export const SYNTHETIC_SESSION_PREFIXES = Object.freeze(['mnemon-task-', 'bg-task-', 'task-subagent-'])

/** 该 session 是否属于外部插件生成的后台任务会话（心跳/捕获都不该为它建记录）。 */
export function isSyntheticSession(session) {
  const id = typeof session === 'string' ? session.trim() : ''
  if (id === '') return true
  for (const prefix of SYNTHETIC_SESSION_PREFIXES) {
    if (id.startsWith(prefix)) return true
  }
  return false
}

export function gcLegacyHeartbeats(root, contract, options = {}) {
  const absRoot = heartbeatWorkspace(root).root
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const input = isPlainObject(options) ? options : {}
  const dryRun = input.dryRun === true
  /* 2026-11-09（审计项）：除了 `agent=subagent` 的旧文件，再给一条「已结束且够旧」的回收
     口径。只认**自己声明结束**（status=done 且有 ended_at）的记录——idle/working 的会话
     心跳可能还活着（另一进程/另一台机器），删掉会让心跳存活判定失去证据；foreign 保留。 */
  const olderThanHours = Number.isFinite(input.olderThanHours) && input.olderThanHours >= 0 ? input.olderThanHours : null
  const cutoff = olderThanHours === null ? null : Date.now() - olderThanHours * 3_600_000
  const dir = heartbeatDirPath(absRoot, c)
  const result = {
    root: toPosix(absRoot),
    dir: toPosix(relative(absRoot, dir)) || '.',
    removed: [],
    kept: 0,
    dryRun,
    olderThanHours,
  }
  if (c.heartbeats.source === 'none') return result
  return withLock(absRoot, c, () => {
    for (const file of heartbeatFiles(dir)) {
      let record = null
      try {
        record = readHeartbeatRecord(file.path)
      } catch {
        // A broken record cannot be proven legacy; keep it and its warning.
        result.kept += 1
        continue
      }
      const legacy = record !== null && record.agent === LEGACY_SUBAGENT_AGENT
      /* 2026-11-11：后台任务会话的心跳不是"用户会话状态"，一律回收（不看年龄），
         否则每来一个后台任务就多一个文件、面板就多一行幽灵。 */
      const sessionOf = record !== null && typeof record.session === 'string' && record.session.trim() !== ''
        ? record.session.trim()
        : file.name.replace(/\.json$/, '')
      const synthetic = isSyntheticSession(sessionOf)
      const status = record !== null && typeof record.status === 'string' ? record.status : ''
      const endedAt = record !== null && typeof record.ended_at === 'string' ? record.ended_at : ''
      /* 「够旧」用 liveness 的年龄口径（pid/boot/updated_at），两种可回收：
         ① 自己声明结束（status=done 且有 ended_at）；② 判死（boot 变了 / pid 没了）。
         idle/working 且 pid 还活着、或者 foreign（另一台机器可能在跑）一律保留。 */
      let verdict = { liveness: 'unknown', ageSeconds: null }
      try {
        verdict = record === null ? verdict : livenessOf(record, { mtime: heartbeatFileMtime(file.path) })
      } catch {
        // 判活失败按「没证据」处理，不删。
      }
      const oldEnough = verdict.ageSeconds !== null && verdict.ageSeconds >= olderThanHours * 3_600
      const expired =
        cutoff !== null && oldEnough && (verdict.liveness === 'dead' || (status === 'done' && endedAt !== ''))
      if (legacy === false && synthetic === false && expired === false) {
        result.kept += 1
        continue
      }
      result.removed.push({
        file: file.name,
        session: typeof record.session === 'string' ? record.session : file.name.replace(/\.[^.]+$/, ''),
        status,
        // 「为什么被回收」必须可解释：后台任务会话的心跳不是「已结束」，单独给
        // synthetic（否则 CLI 会把它误报成 ended）。
        reason: legacy ? 'subagent' : synthetic ? 'synthetic' : verdict.liveness === 'dead' ? 'dead' : 'ended',
      })
      if (dryRun === true) continue
      try {
        unlinkSync(file.path)
      } catch (error) {
        noteWarning(`heartbeat-gc-failed: ${file.name}: ${error.message}`)
      }
    }
    return result
  })
}
