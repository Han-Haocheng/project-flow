// project-flow — Host write routes: init (create a ledger) and gate (toggle one
// gate). Both are the only writes the panel can perform; they hand the root to
// lib/core.mjs after the same root scoping the read route applies. Split out of
// index.js so the route surface has its own write region (docs/module-boundaries.md).

import { brief, isPlainObject } from '../state-snapshot.mjs'
import { contract as backendContract, gates } from '../backend/api.mjs'
import {
  MAX_INIT_BODY_BYTES,
  MAX_INIT_CREATED,
  MAX_INIT_WARNINGS,
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
} from './shared.mjs'

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
export async function handleInit(ctx, request, response) {
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
    // The shared writer: api.contract.initProject keeps validation, locking and the
    // atomic write in one place (the same entry the CLI uses).
    result = backendContract.initProject(root, { name })
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

export async function handleGate(ctx, request, response) {
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
    const loaded = backendContract.loadContract(root)
    gate = gates.updateGate(root, loaded.contract, id, { enabled: parsed.enabled })
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
