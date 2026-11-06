/**
 * Durability plumbing for the store: temp-file naming, the zero-dependency
 * sleep, rename with a bounded backoff for the transient Windows codes, the
 * best-effort directory fsync, and `ensureDir`.
 *
 * `writeJsonAtomic` composes them (temp file + fsync + retry rename + directory
 * fsync); it moved here too once the source-level assertion became
 * position-agnostic (task-51), so the whole write path lives in one module.
 * `lib/core.mjs` re-exports the public name.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { FlowError, nextTempSuffix, toPosix } from './util.mjs'

/** Backoff for transient rename failures (AV scanners, Windows sharing). */
const RENAME_RETRY_DELAYS_MS = [10, 50, 150]

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw new FlowError('io', `cannot create ${toPosix(dir)}: ${error.message}`)
  }
}

/** Block the current thread without spinning (`Atomics.wait` is the zero-dep sleep). */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms)
}

/**
 * rename with a bounded backoff for the transient codes a file share lock or an
 * AV scanner produces on Windows (`EPERM`/`EBUSY`/`EACCES`). Every other error
 * (ENOTDIR, EXDEV, …) fails on the first attempt. Exhausted retries raise
 * `FlowError('io')` carrying the historical `cannot write <to>` prefix.
 *
 * Non-contract API: exported only so tests can inject `{renameImpl, sleepImpl,
 * delays}`; `writeJsonAtomic` is the single production caller.
 */
export function renameWithRetrySync(from, to, options = {}) {
  const renameImpl = typeof options.renameImpl === 'function' ? options.renameImpl : renameSync
  const sleepImpl = typeof options.sleepImpl === 'function' ? options.sleepImpl : sleepSync
  const delays = Array.isArray(options.delays) && options.delays.length > 0 ? options.delays : RENAME_RETRY_DELAYS_MS
  const attempts = delays.length + 1
  let last
  for (let index = 0; index < attempts; index += 1) {
    try {
      renameImpl(from, to)
      return
    } catch (error) {
      last = error
      const code = error !== null && error !== undefined ? error.code : undefined
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      if (index === attempts - 1) break
      sleepImpl(delays[Math.min(index, delays.length - 1)])
    }
  }
  throw new FlowError('io', `cannot write ${toPosix(to)}: ${last?.message ?? String(last)}`)
}

/**
 * fsync the parent directory so the rename itself is durable. Best effort only:
 * `/mnt/d` (ntfs3/DrvFs) rejects directory fsync with `EINVAL`, and a failed
 * directory sync must never fail a write that already succeeded.
 */
function fsyncDirBestEffort(dir) {
  let fd
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // Unsupported on this filesystem (or a racing rmdir): durability only.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

/**
 * write temp file + fsync + rename; on failure remove the temp file and raise io.
 * The fsync happens before the rename, so a crash exposes either the old file or
 * a complete new one — never a half-written record.
 *
 * `retryOptions` (`{renameImpl?, sleepImpl?, delays?}`) is threaded into
 * `renameWithRetrySync` for tests that must provoke transient/en-exhausted
 * rename failures against a real directory; production callers omit it.
 * Non-contract API: exported only for that injection.
 */
export function writeJsonAtomic(file, data, retryOptions = {}) {
  ensureDir(dirname(file))
  const temp = join(dirname(file), `${basename(file)}.tmp-${nextTempSuffix()}`)
  let fd
  try {
    fd = openSync(temp, 'wx')
    writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`)
    fsyncSync(fd)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore: the write already failed
      }
    }
    try {
      unlinkSync(temp)
    } catch {
      // nothing to clean up
    }
    if (error instanceof FlowError) throw error
    throw new FlowError('io', `cannot write ${toPosix(file)}: ${error.message}`)
  }
  try {
    closeSync(fd)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // nothing to clean up
    }
    throw new FlowError('io', `cannot write ${toPosix(file)}: ${error.message}`)
  }
  try {
    renameWithRetrySync(temp, file, retryOptions)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // nothing to clean up
    }
    if (error instanceof FlowError) throw error
    throw new FlowError('io', `cannot write ${toPosix(file)}: ${error.message}`)
  }
  fsyncDirBestEffort(dirname(file))
}

export { ensureDir, fsyncDirBestEffort, RENAME_RETRY_DELAYS_MS, sleepSync }
