// task-73 P3a — the **read-only** half of Team-board sync.
//
// The Team service is a Host service (`ctx.agentTeams`); its read methods take
// the calling Agent as the authority credential (`listTasks(caller)`,
// `listMembers(agent)`) — the plan's sketch without `caller` is wrong, and a
// missing caller must degrade instead of guessing.
//
// Nothing in this module writes: `reconcile` only reads the ledger
// (`listTasks`) and the already-read board, so the caller can prove read-only
// behaviour by fingerprinting the ledger before and after.

import { listTasks } from './core.mjs'
import { isPlainObject } from './util.mjs'

const TEAM_SERVICE = 'agentTeams'

function brief(error) {
  if (error === null || error === undefined) return 'unknown error'
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
  return message.length > 200 ? `${message.slice(0, 197)}...` : message
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/** The Team service from a plugin/TUI context, or null when it is not mounted. */
function teamServiceOf(ctx) {
  if (ctx === null || ctx === undefined) return null
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(TEAM_SERVICE) : undefined
    if (viaGet !== undefined && viaGet !== null) return viaGet
    const direct = ctx[TEAM_SERVICE]
    return direct === undefined ? null : direct
  } catch {
    // A missing service may throw from some context implementations;
    // "unavailable" is a normal state, not an error to surface.
    return null
  }
}

/** The linked board task id of one ledger record, or '' when it has no link. */
export function teamTaskIdOf(task) {
  if (isPlainObject(task) === false) return ''
  const team = task.team
  if (isPlainObject(team) === false) return ''
  return typeof team.taskId === 'string' ? team.taskId.trim() : ''
}

/**
 * Read the Team board through the Host service.
 *
 * @param ctx    plugin context (service lookup only — no writes)
 * @param agent  the live Agent used as the read credential (required by the
 *               real Host API; a missing one degrades to `no-caller`)
 * @returns `{ ok:true, members, tasks }` with bounded, normalized rows; or
 *          `{ ok:false, reason }` — never throws, so a ledger write path can
 *          call it without a try/catch of its own.
 */
export function readTeamBoard(ctx, agent) {
  const service = teamServiceOf(ctx)
  if (service === null) return { ok: false, reason: 'no-team-service' }
  if (typeof service.listTasks !== 'function' || typeof service.listMembers !== 'function') {
    return { ok: false, reason: 'no-team-service' }
  }
  if (agent === null || agent === undefined) return { ok: false, reason: 'no-caller' }
  try {
    const tasks = service.listTasks(agent)
    const members = service.listMembers(agent)
    /* Real Host methods are synchronous. A Promise here means a newer/unknown
       contract: report the mismatch instead of storing a Promise. */
    if (tasks !== null && typeof tasks === 'object' && typeof tasks.then === 'function') {
      return { ok: false, reason: 'async-team-service' }
    }
    if (Array.isArray(tasks) === false || Array.isArray(members) === false) {
      return { ok: false, reason: 'bad-team-board' }
    }
    return {
      ok: true,
      members: members.map((member) => ({
        id: textOf(member && member.id),
        name: textOf(member && member.name),
        role: textOf(member && member.role),
        status: textOf(member && member.status),
      })),
      tasks: tasks.map((task) => ({
        id: textOf(task && task.id),
        revision: Number.isInteger(task && task.revision) && task.revision >= 0 ? task.revision : 0,
        subject: textOf(task && task.subject),
        status: textOf(task && task.status),
        owner: typeof (task && task.ownerName) === 'string' ? task.ownerName : null,
        blockedBy: Array.isArray(task && task.blockedBy) ? task.blockedBy.slice() : [],
        writeScopes: Array.isArray(task && task.writeScopes) ? task.writeScopes.slice() : [],
      })),
    }
  } catch (error) {
    return { ok: false, reason: 'team-service-error', message: brief(error) }
  }
}

/**
 * Compare the ledger's `team.taskId` links with one board read.
 *
 * **Read-only**: reads `listTasks(root, contract)` and the passed board; it
 * never writes the ledger, the board, or any file.
 *
 * @returns `{ matched, missing, orphaned }` — arrays of task ids:
 *   - `matched`  ledger task ids whose board task still exists;
 *   - `missing`  ledger task ids whose board task is gone (the ledger record is
 *                kept: P3a must not delete anything on a read);
 *   - `orphaned` board task ids that no ledger task links to.
 */
export async function reconcile(root, contract, board) {
  const tasks = listTasks(root, contract)
  const links = []
  for (const task of tasks) {
    const boardId = teamTaskIdOf(task)
    if (boardId === '') continue
    links.push({ ledgerId: textOf(task.id), boardId })
  }
  return reconcileLinks(links, board)
}

/**
 * The pure comparison behind {@link reconcile}: `links` are `{ledgerId, boardId}`
 * pairs already extracted from the ledger. The panel read path uses this with
 * `tasks.teamLinks` from the forked snapshot, so the host main thread never has
 * to read the store (see CONTRACT §9.1.1 / §10).
 */
export function reconcileLinks(links, board) {
  /* An unavailable board is not "everything is missing": unknown is its own
     state, so the caller renders `available:false` instead of alarming counts. */
  if (isPlainObject(board) === false || board.ok !== true) return { matched: [], missing: [], orphaned: [] }
  const rows = Array.isArray(links) ? links.filter((entry) => isPlainObject(entry) && textOf(entry.boardId) !== '') : []
  const boardIds = []
  if (Array.isArray(board.tasks)) {
    for (const task of board.tasks) {
      const id = textOf(task && task.id)
      if (id !== '') boardIds.push(id)
    }
  }
  const onBoard = new Set(boardIds)
  const referenced = new Set(rows.map((entry) => entry.boardId))
  const matched = []
  const missing = []
  for (const entry of rows) {
    if (onBoard.has(entry.boardId)) matched.push(textOf(entry.ledgerId))
    else missing.push(textOf(entry.ledgerId))
  }
  const orphaned = [...new Set(boardIds)].filter((id) => referenced.has(id) === false)
  return { matched, missing, orphaned }
}

/**
 * The status-block / panel projection of one read-only sync round.
 *
 * `available` is the whole point: without the Team service we report
 * `available:false` and zero counts — "cannot read" must never look like "nothing
 * there" (a fake 0 is the failure mode this repo has hit repeatedly).
 *
 * @returns `{available, members, tasks, linked, missing, orphaned, reason?}`
 */
export async function teamStatusOf(ctx, agent, root, contract) {
  const board = readTeamBoard(ctx, agent)
  if (board.ok !== true) {
    return {
      available: false,
      members: 0,
      tasks: 0,
      linked: 0,
      missing: 0,
      orphaned: 0,
      reason: board.reason,
    }
  }
  const result = await reconcile(root, contract, board)
  return {
    available: true,
    members: board.members.length,
    tasks: board.tasks.length,
    linked: result.matched.length,
    missing: result.missing.length,
    orphaned: result.orphaned.length,
  }
}
