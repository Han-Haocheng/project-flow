/**
 * Child-process control shared by every layer that spawns work: the store writer
 * (`lib/core.mjs`), the gate runner (`lib/runner.mjs`) and the read-only check
 * runner (`lib/checks.mjs`).
 *
 * These four items used to exist **twice** — once here in core and once in
 * `lib/checks.mjs`, because checks is deliberately not allowed to import core.
 * A win32 kill fix therefore had to be applied in two places, and a missed one
 * would leave the checks path silently running the old bug on real Windows.
 * They live in this module instead: it imports neither core nor checks, so the
 * "checks stays core-free" rule is intact and the duplicate is gone (task-52).
 */
import { spawnSync } from 'node:child_process'

/**
 * win32: after `taskkill /T /F` a surviving grandchild can keep the stdio pipes
 * open, so the `close` event may never arrive; a step resolves after this grace.
 */
const WIN32_KILL_GRACE_MS = 2000

/** `taskkill` gets its own bound so a wedged helper can never block the runner. */
const TASKKILL_TIMEOUT_MS = 5000

/**
 * Best-effort `taskkill /PID <pid> /T /F`: `/T` includes descendants, `/F` forces.
 * It returns instead of throwing so a dead pid or a missing taskkill degrades to
 * the direct-child fallback. The impl is injectable via `killProcessTree`.
 */
function runTaskkillSync(pid) {
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: TASKKILL_TIMEOUT_MS,
      windowsHide: true,
    })
    return { ok: result.status === 0, status: result.status, error: result.error ?? null }
  } catch (error) {
    return { ok: false, status: null, error }
  }
}

/**
 * Terminate one child **and its descendants**.
 *
 * POSIX (unchanged): the child is spawned detached, so `kill(-pid, SIGKILL)`
 * takes the whole process group; only if that fails do we kill the direct child.
 * win32: `child.kill()` terminates `cmd.exe` only — a surviving grandchild keeps
 * the stdio pipes open and `close` never fires. `taskkill /T /F` kills the tree
 * first; the direct kill stays as the best-effort fallback.
 *
 * Both callers spawn detached on POSIX (the gate runner and the read-only check
 * runner), so the group kill applies to either.
 *
 * Non-contract API: exported so tests can inject `platform` / `killImpl` /
 * `taskkillImpl` and cover the win32 branch off Windows.
 */
export function killProcessTree(child, control = {}) {
  const platform = typeof control.platform === 'string' ? control.platform : process.platform
  const pid = child !== null && child !== undefined ? child.pid : undefined
  if (platform === 'win32') {
    const taskkillImpl = typeof control.taskkillImpl === 'function' ? control.taskkillImpl : runTaskkillSync
    const result = typeof pid === 'number' ? taskkillImpl(pid) : { ok: false, error: null }
    try {
      child?.kill?.('SIGKILL')
    } catch {
      // already gone
    }
    return { via: 'taskkill', ok: result?.ok === true, error: result?.error ?? null }
  }
  const killImpl = typeof control.killImpl === 'function' ? control.killImpl : process.kill
  try {
    if (typeof pid === 'number') {
      killImpl(-pid, 'SIGKILL')
      return { via: 'group', ok: true, error: null }
    }
  } catch {
    // Group killed failed (ESRCH, or a child that is not a group leader).
  }
  try {
    child?.kill?.('SIGKILL')
    return { via: 'direct', ok: true, error: null }
  } catch (error) {
    return { via: 'direct', ok: false, error }
  }
}

export { runTaskkillSync, TASKKILL_TIMEOUT_MS, WIN32_KILL_GRACE_MS }
