// task-73 P3a — the **read-only** half of Team-board sync.
//
// The Team service is a Host service (`ctx.agentTeams`); its read methods take
// the calling Agent as the authority credential (`listTasks(caller)`,
// `listMembers(agent)`) — the plan's sketch without `caller` is wrong, and a
// missing caller must degrade instead of guessing.
//
// Read paths (`readTeamBoard` / `reconcile`) never write. The two explicit local
// entries `linkTask` / `unlinkTask` DO write the ledger (only the `team` field, via
// api.tasks.updateTask) — per call, inside core's store lock. They never touch the
// Team service.

import { tasks as taskApi } from './backend/api.mjs'
import { FlowError, invalid, isPlainObject } from './util.mjs'

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
 * Link one ledger task to an external Team-board task id (P3b, task-83).
 *
 * **Local only**: writes the ledger through `updateTask` and never touches the
 * Team service — bringing the board in line is a separate, explicit step (the
 * dispatch trigger is deliberately not implemented yet). The patch carries
 * `team` and nothing else, so `stage`/`status` are untouched: linking is not a
 * state transition.
 *
 * @param options `{revision?, owner?, syncedAt?}`; defaults `0`, `null`, now.
 * @returns the updated ledger record (as `updateTask` returns it).
 */
export function linkTask(root, contract, taskId, boardTaskId, options = {}) {
  const task = requireLedgerTask(root, contract, taskId)
  const boardId = typeof boardTaskId === 'string' ? boardTaskId.trim() : ''
  if (boardId === '') throw invalid('team board id must be a non-empty string')
  const input = isPlainObject(options) ? options : {}
  if (input.revision !== undefined && (Number.isInteger(input.revision) === false || input.revision < 0)) {
    throw invalid('team.revision must be a non-negative integer')
  }
  if (input.owner !== undefined && input.owner !== null && typeof input.owner !== 'string') {
    throw invalid('team.owner must be a string or null')
  }
  if (input.syncedAt !== undefined && (typeof input.syncedAt !== 'string' || input.syncedAt.trim() === '')) {
    throw invalid('team.syncedAt must be a non-empty timestamp string')
  }
  return taskApi.updateTask(root, contract, task.id, {
    team: {
      taskId: boardId,
      revision: input.revision === undefined ? 0 : input.revision,
      owner: input.owner === undefined ? null : input.owner,
      syncedAt: input.syncedAt === undefined ? new Date().toISOString() : input.syncedAt.trim(),
    },
  })
}

/**
 * Remove one ledger task's Team-board link (local only). Sets `team` to `null`
 * — the key stays present so the record reads "explicitly unlinked" instead of
 * "never linked" — and leaves `stage`/`status` alone.
 */
export function unlinkTask(root, contract, taskId) {
  const task = requireLedgerTask(root, contract, taskId)
  return taskApi.updateTask(root, contract, task.id, { team: null })
}

/** The ledger record, or `invalid` — a link to a task that does not exist is a caller bug. */
function requireLedgerTask(root, contract, taskId) {
  const id = typeof taskId === 'string' ? taskId.trim() : ''
  if (id === '') throw invalid('task id must be a non-empty string')
  const task = taskApi.getTask(root, contract, id)
  if (task === null || task === undefined) throw new FlowError('not-found', `task ${id} not found`)
  return task
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
 * **Read-only**: reads `api.tasks.listTasks(root, contract)` and the passed board; it
 * never writes the ledger, the board, or any file.
 *
 * @returns `{ matched, missing, orphaned }` — arrays of task ids:
 *   - `matched`  ledger task ids whose board task still exists;
 *   - `missing`  ledger task ids whose board task is gone (the ledger record is
 *                kept: P3a must not delete anything on a read);
 *   - `orphaned` board task ids that no ledger task links to.
 */
export async function reconcile(root, contract, board) {
  const tasks = taskApi.listTasks(root, contract)
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

// ------------------------------------------- P3b 第二批：团队板自动挂载与终态同步
//
// 计划 §16 的口径：**默认 off、dispatch 模式、建一次 + 终态一次**。映射是显式的，
// 不做启发式：派工即开工 → 板卡 `pending → in_progress`（create + claim）；台账到
// `done` → 板卡 `in_progress → completed`（complete）。其它阶段（回退、重开）不动
// 板卡状态，也不自动 reopen——那需要人判断。
//
// 所有失败都返回 `{mounted:false, reason}` / `{completed:false, reason}`，绝不抛：
// 团队板是旁路账本，不能因为板上出错把派工或阶段推进拖垮。

/** `config.team.mount === true` 才挂载（默认 off，见 CONTRACT §10.1）。 */
export function teamMountEnabled(config) {
  if (isPlainObject(config) === false) return false
  const team = config.team
  return isPlainObject(team) && team.mount === true
}

/** 板卡字段有长度上限（subject 200 / description 16384），这里按上限截断。 */
function clipText(value, limit) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  return text.length <= limit ? text : text.slice(0, limit - 1)
}

/**
 * 派工时把台账任务挂到团队板：建一次（createTask）+ 领取一次（claim）。
 * 已挂过的任务直接返回 `created:false`，不重复建卡。
 *
 * @returns `{mounted, taskId?, revision?, created?, reason?, message?}`
 */
export async function mountTaskOnBoard(ctx, agent, task, root, contract) {
  const service = teamServiceOf(ctx)
  if (service === null || typeof service.createTask !== 'function' || typeof service.updateTask !== 'function') {
    return { mounted: false, reason: 'no-team-service' }
  }
  if (agent === null || agent === undefined) return { mounted: false, reason: 'no-caller' }
  if (isPlainObject(task) === false || typeof task.id !== 'string' || task.id === '') {
    return { mounted: false, reason: 'bad-task' }
  }
  const existing = teamTaskIdOf(task)
  if (existing !== '') return { mounted: true, taskId: existing, created: false }
  const subject = clipText(task.title, 200)
  if (subject === '') return { mounted: false, reason: 'bad-title' }
  const description = clipText(typeof task.notes === 'string' && task.notes.trim() !== '' ? task.notes : subject, 16000)
  const scope = isPlainObject(task.scope) && Array.isArray(task.scope.allow)
    ? task.scope.allow.filter((item) => typeof item === 'string' && item.trim() !== '')
    : []
  let view
  try {
    view = await service.createTask(agent, {
      subject,
      description,
      ...(scope.length === 0 ? {} : { writeScopes: scope }),
    })
  } catch (error) {
    return { mounted: false, reason: 'create-failed', message: brief(error) }
  }
  const boardId = isPlainObject(view) && typeof view.id === 'string' ? view.id.trim() : ''
  if (boardId === '') return { mounted: false, reason: 'bad-team-view' }
  let revision = isPlainObject(view) && Number.isInteger(view.revision) ? view.revision : 1
  try {
    const claimed = await service.updateTask(agent, { taskId: boardId, expectedRevision: revision, action: 'claim' })
    if (isPlainObject(claimed) && Number.isInteger(claimed.revision)) revision = claimed.revision
  } catch {
    // 领取失败不阻断挂载：板卡停在 pending，人能接手；仍把链接写进台账。
  }
  try {
    const linked = linkTask(root, contract, task.id, boardId, { revision, syncedAt: new Date().toISOString() })
    return { mounted: true, taskId: boardId, revision, created: true, record: linked }
  } catch (error) {
    return { mounted: false, reason: 'link-failed', taskId: boardId, message: brief(error) }
  }
}

/**
 * 台账任务到 `done` 时把已挂载的板卡完成一次（幂等：已完成直接返回 `already:true`）。
 *
 * @returns `{completed, taskId?, revision?, already?, reason?, message?}`
 */
export async function completeBoardTask(ctx, agent, task) {
  const service = teamServiceOf(ctx)
  if (service === null || typeof service.updateTask !== 'function') return { completed: false, reason: 'no-team-service' }
  if (agent === null || agent === undefined) return { completed: false, reason: 'no-caller' }
  const boardId = teamTaskIdOf(task)
  if (boardId === '') return { completed: false, reason: 'not-linked' }
  const board = readTeamBoard(ctx, agent)
  if (board.ok !== true) return { completed: false, reason: board.reason }
  const current = board.tasks.find((row) => row.id === boardId)
  if (current === undefined) return { completed: false, reason: 'board-task-missing' }
  if (current.status === 'completed') return { completed: true, taskId: boardId, already: true }
  if (current.status !== 'in_progress') return { completed: false, reason: `board-status-${current.status}` }
  try {
    const next = await service.updateTask(agent, { taskId: boardId, expectedRevision: current.revision, action: 'complete' })
    return {
      completed: true,
      taskId: boardId,
      revision: isPlainObject(next) && Number.isInteger(next.revision) ? next.revision : current.revision,
    }
  } catch (error) {
    return { completed: false, reason: 'complete-failed', message: brief(error) }
  }
}
