// project-flow — Host shared layer.
//
// Constants and helpers used by more than one host module: package/route
// constants, workspace scoping (pure path arithmetic for registered rows — an
// unavailable mount must not cost a request an fs call) and the JSON HTTP
// helpers. Moved out of index.js so the host modules never have to reach into
// the plugin entry (see docs/module-boundaries.md).

import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readManifestName, storeContractPath } from '../state-snapshot.mjs'
import { makeToolRoot } from '../plugin/shared.mjs'
import { service } from '../plugin/mount.mjs'

export const toolRoot = makeToolRoot({ service })
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const ROUTE_PATH = '/api/project-flow/state'
export const INIT_ROUTE_PATH = '/api/project-flow/init'
export const GATE_ROUTE_PATH = '/api/project-flow/gate'
export const MAX_INIT_BODY_BYTES = 8 * 1024
export const MAX_INIT_CREATED = 50
export const MAX_INIT_WARNINGS = 20
// Tools whose target path must stay inside the session's heartbeat file domain
// (claims). `edit`/`write` are the built-in file tools; the ops_* structured
// tools are the host's replacement set (dsh-ops) and used to bypass the gate
// entirely. Only write/delete/move tools are listed: the read-only ops tools
// (ops_read_files, ops_grep, ops_glob, ops_stat, ops_diff,
// ops_inspect_local_file) are never blocked. `bash` / `terminal_send` are also
// intentionally absent: their command text can touch arbitrary paths, so no
// reliable target can be extracted — gating a guessed target would be either
// trivially bypassed or block legitimate read-only work, so the exception is
// explicit rather than an oversight.
export const OPS_WRITE_GATE_TOOLS = new Set([
  'ops_write_file',
  'ops_edit_file',
  // `path` is a directory root for the batch tools: the whole subtree must be
  // inside the domain (claimMatches already treats a claim as a prefix).
  'ops_replace',
  'ops_move',
  'ops_copy',
  'ops_remove',
])
export const HEARTBEAT_GATE_TOOLS = new Set(['edit', 'write', ...OPS_WRITE_GATE_TOOLS])
export const HEARTBEAT_SESSION_MAX = 80
export const HEARTBEAT_SESSION_PATTERN = /^[A-Za-z0-9._:-]+$/


export const SUBAGENT_ORIGIN = 'subagent'

// ------------------------------------------------------- workspace inspection


/** Async `hasStore` for the HTTP/panel request path. */
export async function hasStoreAsync(root) {
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
export async function canonicalRoot(path) {
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
export async function isDirectory(path) {
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
export function workspacePath(value) {
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
export function listWorkspaces(ctx) {
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
export function rootWithin(root, base) {
  if (root === base) return true
  const prefix = base.endsWith(sep) ? base : base + sep
  return root.startsWith(prefix)
}

/** Whether a root is a registered workspace, inside one, or declares its own flow store. */
export async function rootAccepted(root, workspaces) {
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
export async function rootName(root, workspaces) {
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

export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

export function sendError(response, status, code, message) {
  const error = { code }
  if (typeof message === 'string' && message.length > 0) error.message = message
  sendJson(response, status, { ok: false, error })
}

export function originAllowed(ctx, request) {
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


export function readBody(request, limit = MAX_INIT_BODY_BYTES) {
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
