/**
 * The store lock: exclusive `open(wx)` plus an ownership token, stale-lock
 * detection, the short-lived takeover claim that serializes stale takeover, and
 * the temp-leftover sweeper.
 *
 * Split out of `lib/core.mjs` (task-49) as a pure move; `lib/core.mjs` keeps
 * `withLock` (it needs `storePaths`) and re-exports the public name.
 */

import { closeSync, existsSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { FlowError, isPlainObject, nextTempSuffix, noteWarning, toPosix } from './util.mjs'
import { RENAME_RETRY_DELAYS_MS, sleepSync } from './atomic.mjs'

const LOCK_FILE = '.lock'

/** Positive integer from the environment (invalid values are ignored). */
function envPositiveInt(name, fallback) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * A lock younger than this is respected even when its owner looks dead: the
 * owner may still be writing between `open` and its first heartbeat of work.
 * `FLOW_LOCK_STALE_MS` overrides it for experiments; invalid values are ignored.
 */
const LOCK_STALE_MS = envPositiveInt('FLOW_LOCK_STALE_MS', 30_000)

/** Foreign-host / unknown-owner locks get extra grace before being taken over. */
const FOREIGN_STALE_MS = 60_000

/** `open(wx)`/takeover attempts before giving up with conflict. */
const MAX_LOCK_ATTEMPTS = 4

/** Temp files and takeover leftovers older than this may be swept. */
const STALE_TMP_MS = 600_000
const TMP_NAME_RE = /\.tmp-\d+-\d+$/
const LOCK_TAKEOVER_RE = /\.lock\.takeover-\d+-[0-9a-f]{6,}$/

/**
 * `host` tag for the lock: hostname alone is not enough, WSL and Windows share a
 * hostname but not a PID namespace (`kill(pid, 0)` would test the wrong table).
 */
function hostTag() {
  return `${hostname()}|${process.platform}`
}

/**
 * Read the lock as it is *now*: `{text, parsed, mtimeMs}` where `parsed` is null
 * for garbage, or `null` when the file is gone. An unreadable lock (EACCES) is
 * reported with `text: null` and the stat mtime so callers age it but never
 * mistake it for their own.
 */
function readLockSnapshot(lockPath) {
  let text
  try {
    text = readFileSync(lockPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    let mtimeMs
    try {
      mtimeMs = statSync(lockPath).mtimeMs
    } catch {
      mtimeMs = Date.now()
    }
    return { text: null, parsed: null, mtimeMs, unreadable: true }
  }
  let parsed = null
  try {
    const value = JSON.parse(text)
    if (isPlainObject(value)) parsed = value
  } catch {
    // garbage is a valid observation: it simply has no owner fields
  }
  let mtimeMs
  try {
    mtimeMs = statSync(lockPath).mtimeMs
  } catch {
    mtimeMs = Date.now()
  }
  return { text, parsed, mtimeMs, unreadable: false }
}

/** Age of a lock: the owner-declared `at` wins, mtime is the fallback. */
function lockAgeMs(snapshot, now = Date.now()) {
  if (snapshot === null) return 0
  const parsed = snapshot.parsed
  if (isPlainObject(parsed) && typeof parsed.at === 'string') {
    const at = Date.parse(parsed.at)
    if (Number.isFinite(at)) return now - at
  }
  return now - snapshot.mtimeMs
}

const LOCK_ALIVE = 'alive'
const LOCK_DEAD = 'dead'
const LOCK_FOREIGN = 'foreign'
const LOCK_UNKNOWN = 'unknown'

/**
 * Liveness matrix for a lock snapshot.
 * - different `host` → FOREIGN and `process.kill` is **not** called (another PID namespace);
 * - usable pid: `kill(pid, 0)` returns → ALIVE; EPERM → ALIVE (exists, no rights);
 *   ESRCH → DEAD; any other errno → ALIVE (conservative: never steal on doubt);
 * - missing host (old lock shape) is treated as the same machine, so the pid decides;
 * - missing/invalid pid → UNKNOWN (age decides, with the foreign grace window).
 */
function lockLiveness(snapshot) {
  const parsed = snapshot?.parsed
  if (!isPlainObject(parsed)) return { state: LOCK_UNKNOWN, pid: null, host: null }
  const pid = Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null
  const host = typeof parsed.host === 'string' && parsed.host.trim() !== '' ? parsed.host : null
  if (host !== null && host !== hostTag()) return { state: LOCK_FOREIGN, pid, host }
  if (pid === null) return { state: LOCK_UNKNOWN, pid: null, host }
  try {
    process.kill(pid, 0)
    return { state: LOCK_ALIVE, pid, host }
  } catch (error) {
    if (error?.code === 'ESRCH') return { state: LOCK_DEAD, pid, host }
    return { state: LOCK_ALIVE, pid, host }
  }
}

/** One `conflict` error shape: who holds it, since when, and how to resolve it by hand. */
function lockConflict(shownPath, snapshot, age) {
  const parsed = snapshot?.parsed ?? {}
  const pid = Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : 'unknown'
  const host = typeof parsed.host === 'string' && parsed.host.trim() !== '' ? parsed.host : 'unknown host'
  const since =
    typeof parsed.at === 'string' && Number.isFinite(Date.parse(parsed.at))
      ? parsed.at
      : new Date(snapshot?.mtimeMs ?? Date.now()).toISOString()
  return new FlowError(
    'conflict',
    `store is locked by another writer (${shownPath}): pid ${pid} on ${host} since ${since} (age ${Math.round(age / 1000)}s); ` +
      `if that process is gone, remove ${shownPath}`,
  )
}

/**
 * Put a lock we moved aside back at `targetPath` **without clobbering** whatever
 * is there now. `link()` is the atomic no-clobber primitive: `rename()` would
 * silently overwrite a third party's brand-new lock. If the target reappeared we
 * leave both files alone and warn; the sweeper removes the leftover later.
 */
function restoreMovedLock(movedPath, targetPath, label = 'lock-restore') {
  const shownTarget = toPosix(targetPath)
  const shownMoved = toPosix(movedPath)
  if (existsSync(targetPath)) {
    noteWarning(`${label}-skipped: ${shownTarget} was recreated by another writer; left ${shownMoved}`)
    return
  }
  try {
    linkSync(movedPath, targetPath)
  } catch (error) {
    noteWarning(`${label}-skipped: cannot link ${shownMoved} back to ${shownTarget}: ${error.message}`)
    return
  }
  try {
    unlinkSync(movedPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') noteWarning(`${label}-failed: ${shownMoved}: ${error.message}`)
  }
}

/** `open(wx)` the lock and write our ownership record. Returns false when it already exists. */
function createLockFile(lockPath, me) {
  let fd
  try {
    fd = openSync(lockPath, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw new FlowError('io', `cannot create ${toPosix(lockPath)}: ${error.message}`)
  }
  try {
    writeFileSync(fd, JSON.stringify(me))
    closeSync(fd)
    return true
  } catch (error) {
    try {
      closeSync(fd)
    } catch {
      // ignore: the write already failed
    }
    // A zero-byte lock would block everyone for a full stale window: remove ours.
    try {
      unlinkSync(lockPath)
    } catch {
      // someone already replaced it
    }
    throw new FlowError('io', `cannot create ${toPosix(lockPath)}: ${error.message}`)
  }
}

/**
 * The takeover claim: a second, short-lived `open(wx)` mutex that serializes
 * *stale-lock takeover decisions only*. Without it two takers can both decide
 * from the same stale snapshot and one of them moves the other's brand-new lock
 * aside — opening a window where a third process creates a lock and two writers
 * enter the critical section together (observed as duplicate ids). The claim is
 * held for a few filesystem calls (microseconds) and never for user work.
 */
const TAKEOVER_CLAIM_SUFFIX = '.takeover-claim'
const TAKEOVER_CLAIM_ATTEMPTS = 50
const TAKEOVER_CLAIM_SLEEP_MS = 1

function takeoverClaimPath(lockPath) {
  return `${lockPath}${TAKEOVER_CLAIM_SUFFIX}`
}

/**
 * Remove a claim we believe is dead (or a zombie) with a CAS, mirroring the
 * stale-lock takeover: rename it aside, prove the moved bytes are the bytes we
 * inspected, then unlink. If a newer claim appeared in the window, put the moved
 * copy back with `link()` (atomic no-clobber) — never delete another taker's
 * fresh claim. The moved copy is named `…takeover-claim.tmp-<pid>-<seq>`, which
 * the stale-temp sweeper cleans if this process dies mid-recovery.
 *
 * @returns {boolean} true when this process removed the claim
 */
function recoverTakeoverClaim(claimPath, snapshot, age, zombie) {
  const shownClaim = toPosix(claimPath)
  const recoveredPath = `${claimPath}.tmp-${nextTempSuffix()}`
  try {
    renameSync(claimPath, recoveredPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return false // another taker recovered/removed it
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EBUSY') {
      sleepSync(RENAME_RETRY_DELAYS_MS[0])
      return false
    }
    noteWarning(`lock-claim-recovery-failed: ${shownClaim}: ${error.message}`)
    return false
  }
  const moved = readLockSnapshot(recoveredPath)
  const sameInodeContent =
    moved !== null && (moved.text !== null ? moved.text === snapshot.text : moved.mtimeMs === snapshot.mtimeMs)
  if (!sameInodeContent) {
    // A newer claim replaced the dead one in the window: restore it no-clobber.
    restoreMovedLock(recoveredPath, claimPath, 'lock-claim-restore')
    return false
  }
  try {
    unlinkSync(recoveredPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      noteWarning(`lock-claim-recovery-failed: ${toPosix(recoveredPath)}: ${error.message}`)
    }
  }
  if (zombie === true) {
    noteWarning(`lock-claim-stale: recovered ${shownClaim} after ${Math.round(age / 1000)}s`)
  }
  return true
}

/**
 * The takeover-claim conflict message: who holds it, since when, and how to
 * clear a zombie by hand (a reused pid must not block every writer forever).
 */
function claimConflict(claimPath) {
  const shownClaim = toPosix(claimPath)
  const snapshot = readLockSnapshot(claimPath)
  if (snapshot === null) {
    return new FlowError('conflict', `store takeover is already in progress (${shownClaim}); retry later`)
  }
  const parsed = snapshot.parsed ?? {}
  const pid = Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : 'unknown'
  const host = typeof parsed.host === 'string' && parsed.host.trim() !== '' ? parsed.host : 'unknown host'
  const since =
    typeof parsed.at === 'string' && Number.isFinite(Date.parse(parsed.at))
      ? parsed.at
      : new Date(snapshot.mtimeMs).toISOString()
  return new FlowError(
    'conflict',
    `store takeover is already in progress (${shownClaim}): pid ${pid} on ${host} since ${since} (age ${Math.round(lockAgeMs(snapshot) / 1000)}s); ` +
      `retry later, or if no takeover is running, remove ${shownClaim}`,
  )
}

/**
 * Win the takeover mutex. Returns true when this process may inspect-and-remove
 * the stale lock. A claim whose owner is provably dead is recovered (a crashed
 * taker must not brick the store); a claim that still looks alive after ten
 * minutes is treated as a zombie (the critical section lasts microseconds, so
 * this is a SIGSTOPped process or a reused pid) and recovered as well. Every
 * recovery goes through the CAS in {@link recoverTakeoverClaim}.
 */
function acquireTakeoverClaim(claimPath) {
  const me = { schema: 1, pid: process.pid, host: hostTag(), at: new Date().toISOString(), token: randomUUID() }
  for (let attempt = 0; attempt < TAKEOVER_CLAIM_ATTEMPTS; attempt += 1) {
    let created = false
    try {
      const fd = openSync(claimPath, 'wx')
      created = true
      try {
        writeFileSync(fd, JSON.stringify(me))
      } finally {
        closeSync(fd)
      }
      return me.token
    } catch (error) {
      if (created) {
        // A half-written claim would block every other taker: remove ours.
        try {
          unlinkSync(claimPath)
        } catch {
          // someone already replaced it
        }
        throw new FlowError('io', `cannot create ${toPosix(claimPath)}: ${error.message}`)
      }
      if (error?.code !== 'EEXIST') throw new FlowError('io', `cannot create ${toPosix(claimPath)}: ${error.message}`)
    }
    const snapshot = readLockSnapshot(claimPath)
    if (snapshot === null) continue // released between our open and read: try again
    const live = lockLiveness(snapshot)
    const age = lockAgeMs(snapshot)
    const crashed = live.state === LOCK_DEAD || (live.state === LOCK_UNKNOWN && age > FOREIGN_STALE_MS)
    const zombie = (live.state === LOCK_ALIVE || live.state === LOCK_FOREIGN) && age > STALE_TMP_MS
    if (crashed || zombie) {
      recoverTakeoverClaim(claimPath, snapshot, age, zombie)
      continue
    }
    sleepSync(TAKEOVER_CLAIM_SLEEP_MS)
  }
  return null
}

/**
 * Release a claim only when this process still owns it (token + pid match).
 * Never throws: it runs from `finally`.
 *
 * This is the same invariant as {@link releaseLock}: a taker that was SIGSTOPped
 * inside the claim window can have its claim recovered as a zombie and replaced
 * by another taker before it resumes. Deleting that new claim would leave two
 * claim holders and break takeover serialization.
 *
 * Non-contract API: exported so tests can drive the ownership check directly.
 */
export function releaseTakeoverClaim(claimPath, token) {
  const shownClaim = toPosix(claimPath)
  try {
    const snapshot = readLockSnapshot(claimPath)
    if (snapshot === null) return
    const owner = snapshot.parsed
    if (!isPlainObject(owner) || owner.token !== token || owner.pid !== process.pid) {
      noteWarning(
        `lock-claim-release-skipped: ${shownClaim} is held by pid ${owner?.pid ?? '?'} (this process is ${process.pid}); left in place`,
      )
      return
    }
    try {
      unlinkSync(claimPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') noteWarning(`lock-claim-release-failed: ${shownClaim}: ${error.message}`)
    }
  } catch (error) {
    noteWarning(`lock-claim-release-skipped: ${shownClaim}: ${error?.message ?? String(error)}`)
  }
}

/**
 * Acquire `<store>/.lock` and return our ownership token.
 *
 * The lock JSON is `{schema, pid, host, at, token}`. A stale lock is only taken
 * over while holding the short-lived takeover claim, and the decision is
 * re-validated after winning it: rename the stale file aside, prove the moved
 * bytes are the bytes we inspected, re-check liveness, then create our lock
 * *before* deleting the moved copy. The final entry into the critical section is
 * always an exclusive `open(wx)`, so at most one writer gets in — even when
 * several processes race to take over the same stale lock.
 */
function acquireLock(lockPath) {
  const me = {
    schema: 1,
    pid: process.pid,
    host: hostTag(),
    at: new Date().toISOString(),
    token: randomUUID(),
  }
  const shownPath = toPosix(lockPath)
  const claimPath = takeoverClaimPath(lockPath)
  for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt += 1) {
    if (createLockFile(lockPath, me)) return me.token

    // Cheap pre-check without the claim: fresh locks and live owners conflict immediately.
    const quick = readLockSnapshot(lockPath)
    // Released between our failed open and the read: retry the exclusive create.
    if (quick === null) continue
    const quickAge = lockAgeMs(quick)
    if (quickAge <= LOCK_STALE_MS) throw lockConflict(shownPath, quick, quickAge)
    const quickLive = lockLiveness(quick)
    if (quickLive.state === LOCK_ALIVE) throw lockConflict(shownPath, quick, quickAge)
    if ((quickLive.state === LOCK_FOREIGN || quickLive.state === LOCK_UNKNOWN) && quickAge < FOREIGN_STALE_MS) {
      throw lockConflict(shownPath, quick, quickAge)
    }

    const claimToken = acquireTakeoverClaim(claimPath)
    if (claimToken === null) throw claimConflict(claimPath)
    try {
      // Re-validate under the claim: the snapshot above may be another taker's
      // race loser, and acting on it could move a live writer's new lock.
      const snapshot = readLockSnapshot(lockPath)
      if (snapshot === null) continue
      const age = lockAgeMs(snapshot)
      if (age <= LOCK_STALE_MS) throw lockConflict(shownPath, snapshot, age)
      const live = lockLiveness(snapshot)
      if (live.state === LOCK_ALIVE) throw lockConflict(shownPath, snapshot, age)
      if ((live.state === LOCK_FOREIGN || live.state === LOCK_UNKNOWN) && age < FOREIGN_STALE_MS) {
        throw lockConflict(shownPath, snapshot, age)
      }

      // F10: the claim may have been recovered as a zombie while this process
      // was suspended between re-validation and the destructive rename. Prove we
      // still own it one syscall before the move; if not, abandon (the finally
      // release will see the other taker's token and refuse to delete it).
      const heldClaim = readLockSnapshot(claimPath)
      if (
        heldClaim === null ||
        isPlainObject(heldClaim.parsed) === false ||
        heldClaim.parsed.token !== claimToken ||
        heldClaim.parsed.pid !== process.pid
      ) {
        continue
      }

      const takeoverPath = `${lockPath}.takeover-${process.pid}-${randomUUID().replace(/-/g, '').slice(0, 6)}`
      try {
        renameSync(lockPath, takeoverPath)
      } catch (error) {
        if (error?.code === 'ENOENT') continue // released while we held the claim
        if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EBUSY') {
          sleepSync(RENAME_RETRY_DELAYS_MS[Math.min(attempt - 1, RENAME_RETRY_DELAYS_MS.length - 1)])
          continue
        }
        throw new FlowError('io', `cannot move stale lock ${shownPath}: ${error.message}`)
      }

      const moved = readLockSnapshot(takeoverPath)
      // Same bytes (mtime proves it for unreadable locks) or somebody replaced the
      // lock between our read and the rename: then never touch it again.
      const sameInodeContent =
        moved !== null && (moved.text !== null ? moved.text === snapshot.text : moved.mtimeMs === snapshot.mtimeMs)
      if (!sameInodeContent) {
        // Defense in depth: with the takeover claim held, no same-machine taker
        // can replace the lock between our read and this rename, so this branch
        // is unreachable for an all-new-core fleet. It still guards a foreign
        // host or an old-core writer that ignores the claim: put the moved lock
        // back no-clobber instead of deleting a newer owner's lock.
        restoreMovedLock(takeoverPath, lockPath)
        noteWarning(`lock-cas-raced: ${shownPath} changed while taking over; moved a newer lock and restored it`)
        continue
      }
      if (lockLiveness(moved).state === LOCK_ALIVE) {
        restoreMovedLock(takeoverPath, lockPath)
        throw lockConflict(shownPath, moved, lockAgeMs(moved))
      }
      noteWarning(
        `lock-stale: took over ${shownPath} after ${Math.round(age / 1000)}s (pid ${live.pid ?? '?'}, host ${live.host ?? 'unknown'})`,
      )
      // Install our lock while the moved copy still documents the takeover window;
      // a direct creator may still win the exclusive create, in which case we lose.
      if (!createLockFile(lockPath, me)) {
        try {
          unlinkSync(takeoverPath)
        } catch {
          // swept later
        }
        continue
      }
      try {
        unlinkSync(takeoverPath)
      } catch (error) {
        if (error?.code !== 'ENOENT') noteWarning(`lock-takeover-cleanup-failed: ${toPosix(takeoverPath)}: ${error.message}`)
      }
      return me.token
    } finally {
      releaseTakeoverClaim(claimPath, claimToken)
    }
  }
  throw new FlowError('conflict', `cannot acquire store lock (${shownPath})`)
}

/**
 * Release only a lock this very process created (token + pid match). Never
 * throws: it runs from `finally`, where a throw would mask the real error.
 */
function releaseLock(lockPath, token) {
  const shownPath = toPosix(lockPath)
  try {
    const snapshot = readLockSnapshot(lockPath)
    if (snapshot === null) return
    const owner = snapshot.parsed
    if (!isPlainObject(owner)) {
      noteWarning(`lock-release-skipped: ${shownPath} is unreadable; left in place`)
      return
    }
    if (owner.token !== token || owner.pid !== process.pid) {
      noteWarning(
        `lock-release-skipped: ${shownPath} is held by pid ${owner.pid ?? '?'} (this process is ${process.pid}); left in place`,
      )
      return
    }
    try {
      unlinkSync(lockPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') noteWarning(`lock-release-failed: ${shownPath}: ${error.message}`)
    }
  } catch (error) {
    noteWarning(`lock-release-skipped: ${shownPath}: ${error?.message ?? String(error)}`)
  }
}

/**
 * Remove temp/takeover leftovers older than {@link STALE_TMP_MS}. Only files
 * whose name matches our internal patterns are touched — never a `.json`, the
 * `.lock` or an unknown name — and every unlink failure is swallowed per file.
 * Throttled per store root so a busy CLI does not rescan on every write.
 */
const lastSweepAt = new Map()

function sweepStaleTemps(paths) {
  const now = Date.now()
  const key = paths.store
  if (now - (lastSweepAt.get(key) ?? 0) < STALE_TMP_MS) return
  lastSweepAt.set(key, now)
  let removed = 0
  for (const dir of new Set([paths.store, paths.experiments, paths.tasks, paths.gates, paths.logs, paths.decisions])) {
    if (typeof dir === 'string' && dir !== '') removed += sweepStaleTempsIn(dir, now, 0)
  }
  if (removed > 0) noteWarning(`stale-temp-cleaned: ${removed}`)
}

function sweepStaleTempsIn(dir, now, depth) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0 // unreadable/absent directory: nothing to clean
  }
  let removed = 0
  for (const entry of entries) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth === 0) removed += sweepStaleTempsIn(file, now, 1)
      continue
    }
    if (!TMP_NAME_RE.test(entry.name) && !LOCK_TAKEOVER_RE.test(entry.name)) continue
    try {
      const stat = lstatSync(file)
      if (stat.isDirectory()) continue
      if (now - stat.mtimeMs < STALE_TMP_MS) continue
      unlinkSync(file)
      removed += 1
    } catch {
      // best effort: a file we cannot remove is retried on the next sweep
    }
  }
  return removed
}

export { acquireLock, hostTag, LOCK_FILE, releaseLock, sweepStaleTemps }
