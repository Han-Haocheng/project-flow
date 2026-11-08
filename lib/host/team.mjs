// project-flow — Host Team-board read half: caller cache, one read-only sync
// round for the status block, panel enrichment and the panel-state assembly.
// Split out of index.js so the Team seam has its own write region
// (docs/module-boundaries.md).

import { brief } from '../state-snapshot.mjs'
import { buildSnapshot, requireCore } from '../state-snapshot.mjs'
import { readTeamBoard, reconcileLinks, teamStatusOf } from '../team-sync.mjs'
import { applyAgentLiveness, applyHeartbeatVisibility, rootSessionVerdict } from './session.mjs'
import { canonicalRoot, hasStoreAsync, rootName } from './shared.mjs'

// ------------------------------------------------- P3a: read-only team board
//
// The Team service needs a live Agent as its authorization credential
// (`listTasks(caller)`), and the panel read path has no Agent of its own. The
// last main session seen by `agent/created` / `agent/pre-step` is remembered
// here; without one the board is `available:false` and the panel hides the line
// instead of inventing zeros.

const TEAM_UNAVAILABLE = Object.freeze({
  available: false,
  members: 0,
  tasks: 0,
  linked: 0,
  missing: 0,
  orphaned: 0,
})

const TEAM_CALLERS = new WeakMap()

/** Per-mount caller slot; the WeakMap key is the plugin context, not a module global. */
export function teamCallerState(ctx) {
  let state = TEAM_CALLERS.get(ctx)
  if (state === undefined) {
    state = { agent: undefined }
    TEAM_CALLERS.set(ctx, state)
  }
  return state
}

/** Remember the last main-session agent (the read credential); failures are ignored. */
export function rememberTeamCaller(ctx, agent) {
  try {
    if (rootSessionVerdict(ctx, agent) !== true) return
    teamCallerState(ctx).agent = agent
  } catch {
    // no agents service / disposed session: keep whatever caller we had
  }
}

export function teamCallerOf(ctx) {
  try {
    const state = TEAM_CALLERS.get(ctx)
    return state === undefined ? undefined : state.agent
  } catch {
    return undefined
  }
}

/** One read-only sync round for a status block; never throws. */
export async function teamStatusFor(ctx, agent, root) {
  try {
    if (typeof root !== 'string' || root === '') return { ...TEAM_UNAVAILABLE }
    const c = requireCore()
    const contract = c.loadContract(root).contract
    return await teamStatusOf(ctx, agent, root, contract)
  } catch (error) {
    return { ...TEAM_UNAVAILABLE, reason: brief(error) }
  }
}

/**
 * Panel enrichment, next to `applyAgentLiveness`: same host-side, post-fork shape.
 *
 * No store read here: `payload.tasks.teamLinks` was computed inside the snapshot
 * fork, so this path keeps the §9.1.1 invariant (zero synchronous store access on
 * the request main thread). The only host call is the in-memory Team service.
 */
export async function applyTeamBoard(ctx, payload) {
  if (payload === null || typeof payload !== 'object') return payload
  try {
    const board = readTeamBoard(ctx, teamCallerOf(ctx))
    if (board.ok !== true) {
      payload.team = { ...TEAM_UNAVAILABLE, reason: board.reason }
      return payload
    }
    const rawLinks = payload.tasks !== null && typeof payload.tasks === 'object' ? payload.tasks.teamLinks : []
    const links = Array.isArray(rawLinks)
      ? rawLinks.map((link) => ({ ledgerId: typeof link.id === 'string' ? link.id : '', boardId: typeof link.teamTaskId === 'string' ? link.teamTaskId : '' }))
      : []
    const result = reconcileLinks(links, board)
    payload.team = {
      available: true,
      members: board.members.length,
      tasks: board.tasks.length,
      linked: result.matched.length,
      missing: result.missing.length,
      orphaned: result.orphaned.length,
    }
  } catch (error) {
    payload.team = { ...TEAM_UNAVAILABLE, reason: brief(error) }
  }
  return payload
}
