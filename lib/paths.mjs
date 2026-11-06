/**
 * Manifest path containment: every store path declared in `flow.json` must
 * resolve inside the project root, symlinks included. Unsafe values never throw
 * here — the caller falls back to its default and a warning names the key.
 *
 * Split out of `lib/core.mjs` (task-49) as a pure move; `lib/core.mjs`
 * re-exports the public name.
 */

import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

import { noteWarning } from './util.mjs'

//
// Every path declared by the manifest (`store.root`, `experiments.dir`,
// `tasks.dir`, `gates.dir`, `gates.logs`, `tasks.current`, `heartbeats.dir`)
// must stay inside the project root. `resolve()`
// alone is not enough: an absolute value or `..` escapes lexically, and a
// symlink inside the root can point anywhere. Unsafe values never throw here;
// the caller degrades to its default and a warning names the key and raw value.

const UNSAFE_PATH_PREVIEW_MAX = 200

/** One-line, bounded preview of a rejected manifest value (never file content). */
function unsafePathPreview(value) {
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, UNSAFE_PATH_PREVIEW_MAX)
}

function noteUnsafeManifestPath(label, value, reason) {
  noteWarning(`manifest-path-rejected: ${label}: ${unsafePathPreview(value)}: ${reason}`)
}

/** `child` equals `parent` or sits below it, on the platform's case convention. */
function pathWithin(parent, child) {
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = fold(parent)
  const target = fold(child)
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * `realpathSync` through a request-scoped memo.
 *
 * The memo is a plain `Map` the caller creates for one request (HTTP handler,
 * TUI read) and passes down explicitly; it is deliberately never a module-level
 * cache, because a mount can appear or disappear between requests and a process
 * wide cache would answer with a stale location.
 *
 * The memo also remembers a failed resolution (the error, rethrown per lookup)
 * for the rest of that request: one read request must not re-walk the same
 * missing/absent ancestor — that is exactly the lost-mount cost this memo exists
 * to avoid. Only read-only request paths pass a memo, so nothing can create the
 * directory between two lookups of the same request.
 *
 * @param {string} path absolute path to resolve
 * @param {Map<string,string|Error>|undefined} memo request-scoped memo, or undefined
 * @returns {string} the real path
 */
function memoizedRealpath(path, memo) {
  if (memo === undefined) return realpathSync(path)
  const cached = memo.get(path)
  if (cached instanceof Error) throw cached
  if (cached !== undefined) return cached
  try {
    const real = realpathSync(path)
    memo.set(path, real)
    return real
  } catch (error) {
    const stored = error instanceof Error ? error : Object.assign(new Error(String(error)), { code: error?.code })
    memo.set(path, stored)
    throw stored
  }
}

/** The request-scoped realpath memo carried by an optional options bag. */
function pathMemoOf(options) {
  if (options === null || typeof options !== 'object') return undefined
  return options.pathMemo instanceof Map ? options.pathMemo : undefined
}

/**
 * Resolve every symlink on `target` and prove the final location is inside
 * `absRoot`. A target that does not exist yet is checked through its nearest
 * existing ancestor, so `link -> /etc` is rejected before anything is written
 * through it. A dangling symlink is treated as unsafe (a write would create the
 * file at its target).
 *
 * `memo` (optional) is the caller's per-request realpath memo: the same root and
 * the same target are then resolved at most once per request instead of once per
 * containment check.
 */
function realPathStaysInside(absRoot, target, memo) {
  let realRoot
  try {
    realRoot = memoizedRealpath(absRoot, memo)
  } catch {
    // The project root does not exist yet: only the lexical check is meaningful.
    return pathWithin(absRoot, target)
  }
  let current = target
  for (;;) {
    try {
      return pathWithin(realRoot, memoizedRealpath(current, memo))
    } catch (error) {
      const code = error !== null && error !== undefined ? error.code : undefined
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return false
      try {
        if (lstatSync(current).isSymbolicLink()) return false
      } catch {
        // The component is absent: keep walking up toward the root.
      }
      const parent = dirname(current)
      if (parent === current) return false
      current = parent
    }
  }
}

/**
 * Resolve one manifest-declared path and require it to stay inside `root`.
 *
 * Rules: a non-empty string is required; absolute input is rejected unless
 * `options.allowAbsolute` is set (only `store.root` may opt in, and only when
 * the real location is still inside the root); `..` escapes are rejected; an
 * existing target, or its nearest existing ancestor, is re-checked through
 * `realpath` so a symlink cannot lead outside.
 *
 * @param {string} root project root
 * @param {unknown} value raw manifest value
 * @param {string} label manifest key, used in the warning
 * @param {{allowAbsolute?: boolean, pathMemo?: Map<string,string|Error>}} [options]
 *   `pathMemo` is the caller's per-request realpath memo (see
 *   {@link memoizedRealpath}); omitted, every check calls `realpathSync` as before.
 * @returns {string|undefined} absolute in-root path, or undefined when unsafe
 */
export function containedPath(root, value, label, options = {}) {
  const absRoot = resolve(root)
  const name = typeof label === 'string' && label.trim() !== '' ? label.trim() : 'path'
  const allowAbsolute = options !== null && typeof options === 'object' && options.allowAbsolute === true
  const memo = pathMemoOf(options)
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const raw = value.trim()
  const target = isAbsolute(raw) ? resolve(raw) : resolve(absRoot, raw)
  if (isAbsolute(raw) && allowAbsolute !== true) {
    noteUnsafeManifestPath(name, raw, 'absolute paths are not allowed')
    return undefined
  }
  // Relative values are always lexical children; absolute `store.root` values
  // may still reach the root through its real path, so let realpath decide.
  if (pathWithin(absRoot, target) !== true && realPathStaysInside(absRoot, target, memo) !== true) {
    noteUnsafeManifestPath(name, raw, 'escapes the project root')
    return undefined
  }
  if (realPathStaysInside(absRoot, target, memo) !== true) {
    noteUnsafeManifestPath(name, raw, 'a symlink resolves outside the project root')
    return undefined
  }
  return target
}

/** Contained directory or the given in-root fallback when the value is absent/unsafe. */
function containedDir(absRoot, value, label, fallback, memo) {
  const contained = containedPath(absRoot, value, label, memo === undefined ? {} : { pathMemo: memo })
  return contained === undefined ? fallback : contained
}

export { containedDir, pathMemoOf }
