// project-flow — 决策域（decisions 模块，2026-11-11 Phase 1 拆分）。
//
// 决策台账（`D-` 记录）：指纹去重、选项归一、答案/撤回、GC、按归档会话清理、
// 提醒投影与阻塞门（`flow check decisions`）。依赖方向：decisions → store
// （records/contract）+ util + atomic + paths + tasks，**不 import core**。
//
// 与任务域的耦合都是单向的：`addDecision` 读 `paths.tasks` 校验 `blocks` 里的任务
// id；归档决策时 `clearDecisionPointers` 用 `listTasks`/`updateTask` 清掉任务上的
// 悬空 `decision` 指针（`source: 'internal'` 走内部写，不过语义门）。方向固定
// decisions → tasks，tasks 不 import 本模块，因此不成环。
//
// 公共常量与实现一起留在本模块；core 只 import 聚合所需的两项
// （`summarizeDecisions`/`DECISION_REMIND_MAX`）并原样 re-export，公共 API 不变。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from '../atomic.mjs'
import { pathMemoOf } from '../paths.mjs'
import { FlowError, deepClone, formatIso, invalid, isPlainObject, noteWarning, timeValue } from '../util.mjs'
import { assertInitialized, normalizeContract, storePaths, withLock } from '../store/contract.mjs'
import {
  DECISION_ID_RE,
  assertPattern,
  assertTargetFree,
  nextId,
  optionalEnum,
  optionalText,
  readCollection,
  readRecord,
  requireText,
} from '../store/records.mjs'
import { listTasks, updateTask } from '../tasks/records.mjs'

/** Decision record schema; independent of the store schema. */
export const DECISION_SCHEMA = 1
/** Every accepted status; only `open` is actionable. */
export const DECISION_STATUS = Object.freeze(['open', 'answered', 'withdrawn', 'superseded'])
/** Decision kinds. `approval` and `input` options are fixed by core. */
export const DECISION_KINDS = Object.freeze(['choice', 'approval', 'input'])
/** Escalation: pending this many turns in the asking session, or this many hours overall. */
export const DECISION_ESCALATE_TURNS = 3
export const DECISION_ESCALATE_HOURS = 24
/** `flow decision gc` keeps closed records this many days by default. */
export const DECISION_GC_DAYS = 90
/** Host reminder/panel detail cap (consumed by B/C waves). */
export const DECISION_REMIND_MAX = 3

const DECISION_OPTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/
const DECISION_QUESTION_MAX = 200
const DECISION_RATIONALE_MAX = 300
const DECISION_BY = ['user', 'agent']
const DECISION_APPROVAL_OPTIONS = Object.freeze([
  Object.freeze({ id: 'approve', label: '同意', impact: '批准该动作，可以继续执行' }),
  Object.freeze({ id: 'reject', label: '拒绝', impact: '拒绝该动作，停止推进' }),
])

function codePointLength(value) {
  return [...String(value)].length
}

/**
 * Dedupe fingerprint: sha256(kind + "\n" + normalize(question)) first 16 hex.
 * `normalize` = NFKC, then drop every whitespace and punctuation, then lowercase.
 * Core alone computes it; callers never pass one in.
 */
function decisionFingerprint(kind, question) {
  const normalized = String(question)
    .normalize('NFKC')
    .replace(/[\s\p{P}]+/gu, '')
    .toLowerCase()
  return createHash('sha256').update(`${kind}\n${normalized}`, 'utf8').digest('hex').slice(0, 16)
}

/** Repo-relative POSIX path/prefix: `\` -> `/`, drop `./` and trailing `/`, reject absolute/`..`. */
function normalizeDecisionAffect(value) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid('affects entries must be non-empty strings')
  const raw = value.trim().replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw invalid(`affects entries must be repository-relative paths: ${JSON.stringify(value)}`)
  }
  const segments = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw invalid(`affects entry escapes the repository root: ${JSON.stringify(value)}`)
    segments.push(segment)
  }
  if (segments.length === 0) throw invalid(`affects entry must name a path: ${JSON.stringify(value)}`)
  return segments.join('/')
}

function normalizeDecisionAffects(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid('affects must be an array of strings')
  const affects = []
  for (const item of value) {
    const path = normalizeDecisionAffect(item)
    if (!affects.includes(path)) affects.push(path)
  }
  return affects
}

function normalizeDecisionBlocks(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw invalid('blocks must be an array of task ids')
  }
  const blocks = []
  for (const item of value) {
    const id = item.trim()
    if (!blocks.includes(id)) blocks.push(id)
  }
  return blocks
}

function buildDecisionOptions(kind, input) {
  if (kind === 'approval') {
    if (Array.isArray(input.options) && input.options.length > 0) {
      throw invalid('approval decisions use the fixed options approve|reject; do not pass options')
    }
    return DECISION_APPROVAL_OPTIONS.map((option) => ({ ...option }))
  }
  if (kind === 'input') {
    if (Array.isArray(input.options) && input.options.length > 0) throw invalid('input decisions take no options')
    return []
  }
  if (!Array.isArray(input.options) || input.options.length < 2) {
    throw invalid('choice decisions need at least two options')
  }
  const seen = new Set()
  return input.options.map((option, index) => {
    const label = `options[${index}]`
    if (!isPlainObject(option)) throw invalid(`${label} must be an object`)
    const id = assertPattern(option.id, DECISION_OPTION_ID_RE, `${label}.id`)
    if (seen.has(id)) throw invalid(`duplicate option id: ${id}`)
    seen.add(id)
    return {
      ...deepClone(option),
      id,
      label: requireText(option.label, `${label}.label`),
      impact: requireText(option.impact, `${label}.impact`),
    }
  })
}

function decisionOptionId(options, value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${label} is required`)
  const choice = value.trim()
  if (!options.some((option) => option.id === choice)) {
    throw invalid(`${label} must be one of ${options.map((option) => option.id).join(', ')}`)
  }
  return choice
}

function normalizeDecisionSupersedes(value, ctx) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalid('supersedes must be a decision id or null')
  const id = value.trim()
  assertPattern(id, DECISION_ID_RE, 'supersedes')
  const target = ctx.byId.get(id)
  if (target === undefined) throw invalid(`supersedes references a decision that does not exist: ${id}`)
  if (target.status === 'superseded') throw invalid(`superseded decision cannot be superseded again: ${id}`)
  return id
}

/** Validate and normalize one new record; `ctx` carries existing ids, records and task ids. */
function normalizeDecisionFields(record, ctx) {
  record.question = requireText(record.question, 'question')
  if (codePointLength(record.question) > DECISION_QUESTION_MAX) {
    throw invalid(`question is longer than ${DECISION_QUESTION_MAX} characters`)
  }
  if (!DECISION_KINDS.includes(record.kind)) throw invalid(`kind must be one of ${DECISION_KINDS.join(', ')}`)
  record.options = buildDecisionOptions(record.kind, record)
  if (record.kind === 'choice' || record.kind === 'approval') {
    // `approval` 省略 `recommendation` 时固定推荐 `approve`（想推荐拒绝必须显式传
    // `reject`）；`choice` 仍必填（D02）。显式给值一律按 option 校验。
    const omitted =
      record.recommendation === undefined || record.recommendation === null || record.recommendation === ''
    record.recommendation =
      record.kind === 'approval' && omitted
        ? 'approve'
        : decisionOptionId(record.options, record.recommendation, 'recommendation')
    record.default =
      record.default === undefined || record.default === null || record.default === ''
        ? null
        : decisionOptionId(record.options, record.default, 'default')
  } else {
    record.recommendation =
      typeof record.recommendation === 'string' && record.recommendation.trim() !== ''
        ? record.recommendation.trim()
        : null
    record.default =
      typeof record.default === 'string' && record.default.trim() !== '' ? record.default.trim() : null
  }
  record.rationale = requireText(record.rationale, 'rationale')
  if (codePointLength(record.rationale) > DECISION_RATIONALE_MAX) {
    throw invalid(`rationale is longer than ${DECISION_RATIONALE_MAX} characters`)
  }
  if (record.status !== undefined && record.status !== 'open') throw invalid('a new decision is always open')
  record.status = 'open'
  record.blocks = normalizeDecisionBlocks(record.blocks)
  for (const id of record.blocks) {
    if (ctx.taskIds.has(id) === false) throw invalid(`blocks references a task that does not exist: ${id}`)
  }
  record.affects = normalizeDecisionAffects(record.affects)
  if (record.blocks.length > 0 && record.affects.length === 0) {
    throw invalid('a blocking decision must declare at least one affects entry')
  }
  record.supersedes = normalizeDecisionSupersedes(record.supersedes, ctx)
  record.answer = null
  record.answered_at = null
  record.withdraw = null
  record.superseded_by = null
  record.fingerprint = decisionFingerprint(record.kind, record.question)
  return record
}

function buildDecision(input, ctx) {
  if (!isPlainObject(input)) throw invalid('decision must be an object')
  for (const key of ['schema', 'fingerprint', 'superseded_by', 'answered_at', 'answer', 'withdraw']) {
    if (Object.hasOwn(input, key)) throw invalid(`decision ${key} is maintained by core and cannot be passed`)
  }
  const record = deepClone(input)
  record.schema = DECISION_SCHEMA
  if (input.id === undefined) {
    record.id = nextId('D', ctx.existingIds)
  } else {
    assertPattern(input.id, DECISION_ID_RE, 'decision id')
    if (ctx.existingIds.has(input.id)) throw new FlowError('conflict', `decision ${input.id} already exists`)
    record.id = input.id
  }
  normalizeDecisionFields(record, ctx)
  let askedAt = formatIso()
  if (input.asked_at !== undefined) {
    if (typeof input.asked_at !== 'string' || Number.isNaN(Date.parse(input.asked_at))) {
      throw invalid('asked_at must be an ISO 8601 timestamp')
    }
    askedAt = input.asked_at
  }
  record.asked_at = askedAt
  record.created_at = askedAt
  record.updated_at = askedAt
  record.asked_session =
    typeof input.asked_session === 'string' && input.asked_session.trim() !== '' ? input.asked_session.trim() : null
  record.asked_turn = Number.isInteger(input.asked_turn) ? input.asked_turn : null
  return record
}

function decisionRecords(paths) {
  return readCollection(paths.decisions).map((item) => item.record)
}

function decisionIds(paths) {
  const ids = new Set()
  for (const item of readCollection(paths.decisions)) {
    ids.add(typeof item.record.id === 'string' ? item.record.id : item.name.slice(0, -5))
  }
  return ids
}

function decisionSortedNewest(records) {
  return records
    .slice()
    .sort((left, right) => timeValue(right.updated_at) - timeValue(left.updated_at))
}

/**
 * One decision with display annotations: `escalated`, `turnAge` (only for the
 * asking session) and `ageSeconds` (from `asked_at`). Escalation is `⚠` when the
 * asking session is this many turns ahead or the record is this many hours old.
 */
function annotateDecision(record, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const session = typeof options.session === 'string' ? options.session : ''
  const turn = Number.isInteger(options.turn) ? options.turn : null
  const asked = Date.parse(typeof record.asked_at === 'string' ? record.asked_at : '')
  const ageSeconds = Number.isFinite(asked) ? Math.max(0, Math.floor((now - asked) / 1000)) : null
  const turnAge =
    session !== '' && record.asked_session === session && turn !== null && Number.isInteger(record.asked_turn)
      ? turn - record.asked_turn
      : null
  const escalated =
    (turnAge !== null && turnAge >= DECISION_ESCALATE_TURNS) ||
    (ageSeconds !== null && ageSeconds >= DECISION_ESCALATE_HOURS * 60 * 60)
  return { ...record, escalated, turnAge, ageSeconds }
}

/** Open records: escalated first, then oldest `asked_at` first, then id. */
function decisionOpenOrder(left, right) {
  const delta = Number(right.escalated === true) - Number(left.escalated === true)
  if (delta !== 0) return delta
  const leftAt = Date.parse(typeof left.asked_at === 'string' ? left.asked_at : '')
  const rightAt = Date.parse(typeof right.asked_at === 'string' ? right.asked_at : '')
  const leftStamp = Number.isFinite(leftAt) ? leftAt : Number.POSITIVE_INFINITY
  const rightStamp = Number.isFinite(rightAt) ? rightAt : Number.POSITIVE_INFINITY
  if (leftStamp !== rightStamp) return leftStamp - rightStamp
  return String(left.id ?? '').localeCompare(String(right.id ?? ''))
}

/**
 * Decision list. Default: open only (escalated first, oldest first). `all: true`
 * appends the closed records, newest `updated_at` first.
 * @param {{all?:boolean, session?:string, turn?:number|null, now?:number}} [options]
 */
/**
 * Session ownership of one decision: a record belongs to the session that asked
 * it. A record without `asked_session` (legacy / CLI without DSH_SESSION_ID) is
 * owned by nobody, so it never shows up in a session-scoped read.
 */
function decisionOwnedBy(record, session) {
  const owner = typeof record.asked_session === 'string' ? record.asked_session.trim() : ''
  return owner !== '' && owner === session
}

/**
 * The session filter shared by `listDecisions` / `summarizeDecisions`: an empty
 * `session` keeps the global view (panel / human CLI), a non-empty one keeps
 * only that session's records (agent-facing reminder / flow_decision tool).
 */
function decisionSessionOf(options) {
  return typeof options.session === 'string' ? options.session.trim() : ''
}

export function listDecisions(root, contract, options = {}) {
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const session = decisionSessionOf(input)
  const annotated = decisionRecords(storePaths(root, c))
    .map((record) => annotateDecision(record, input))
    .filter((record) => session === '' || decisionOwnedBy(record, session))
  const open = annotated.filter((record) => record.status === 'open').sort(decisionOpenOrder)
  if (input.all !== true) return open
  const closed = annotated
    .filter((record) => record.status !== 'open')
    .sort((left, right) => {
      const delta = timeValue(right.updated_at) - timeValue(left.updated_at)
      return delta !== 0 ? delta : String(right.id ?? '').localeCompare(String(left.id ?? ''))
    })
  return [...open, ...closed]
}

export function getDecision(root, contract, id) {
  const c = normalizeContract(root, contract)
  return readRecord(storePaths(root, c).decisions, id, 'decision')
}

/** Closed-record hint for the conflict message that blocks re-asking the same question. */
function decisionClosedHint(record) {
  if (record.status === 'answered' && isPlainObject(record.answer)) {
    return `${record.id} is answered (choice ${record.answer.choice})`
  }
  if (record.status === 'withdrawn' && isPlainObject(record.withdraw)) {
    return `${record.id} is withdrawn (${record.withdraw.reason})`
  }
  return `${record.id} is ${String(record.status)}`
}

/**
 * Ask one decision. Fingerprint dedupe (§4.5 of the design):
 * 1. same fingerprint has an open record → reuse it (`created: false`);
 * 2. same fingerprint has a closed record → `conflict` unless `supersedes` names
 *    exactly that record; the old record becomes `superseded` and keeps its
 *    answer/withdraw for audit;
 * 3. otherwise create.
 * @returns {{decision:object, created:boolean}}
 */
export function addDecision(root, contract, input) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const records = decisionRecords(paths)
    const byId = new Map(records.filter((record) => typeof record.id === 'string').map((record) => [record.id, record]))
    const taskIds = new Set(
      readCollection(paths.tasks)
        .map((item) => item.record.id)
        .filter((id) => typeof id === 'string'),
    )
    const candidate = buildDecision(input, { existingIds: decisionIds(paths), byId, taskIds })
    const same = records.filter((record) => record.fingerprint === candidate.fingerprint)
    const openSame = decisionSortedNewest(same.filter((record) => record.status === 'open'))[0]
    if (openSame !== undefined) return { decision: openSame, created: false }
    const closedSame = decisionSortedNewest(same.filter((record) => record.status !== 'open'))[0]
    let target = null
    if (closedSame !== undefined) {
      if (candidate.supersedes !== closedSame.id) {
        throw new FlowError(
          'conflict',
          `decision already closed: ${decisionClosedHint(closedSame)}; re-ask the same question with supersedes=${closedSame.id}`,
        )
      }
      target = closedSame
    } else if (candidate.supersedes !== null) {
      target = byId.get(candidate.supersedes) ?? null
    }
    assertTargetFree(paths.decisions, candidate.id)
    writeJsonAtomic(join(paths.decisions, `${candidate.id}.json`), candidate)
    if (target !== null) {
      const next = {
        ...deepClone(target),
        status: 'superseded',
        superseded_by: candidate.id,
        updated_at: formatIso(),
      }
      writeJsonAtomic(join(paths.decisions, `${next.id}.json`), next)
    }
    return { decision: candidate, created: true }
  })
}

function requireOpenDecision(record, action) {
  if (record.status === 'open') return record
  throw new FlowError('conflict', `decision ${record.id} is ${String(record.status)}; terminal records cannot be ${action}`)
}

/**
 * Close an open decision with the user's choice. `choice` must name an option
 * id (`input` decisions take free text); `by` records who confirmed it.
 */
export function answerDecision(root, contract, id, input = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const patch = isPlainObject(input) ? input : {}
  return withLock(root, c, (paths) => {
    const current = requireOpenDecision(readRecord(paths.decisions, id, 'decision'), 'answered')
    const by = optionalEnum(patch.by, 'by', DECISION_BY, 'user')
    let choice
    if (current.kind === 'input') {
      choice = requireText(patch.choice, 'choice')
    } else {
      const options = Array.isArray(current.options) ? current.options : []
      choice = decisionOptionId(options, patch.choice, 'choice')
    }
    const note = optionalText(patch.note, 'note', '')
    const at = formatIso()
    const next = { ...current, status: 'answered', answer: { choice, note, at, by }, answered_at: at, updated_at: at }
    writeJsonAtomic(join(paths.decisions, `${next.id}.json`), next)
    return next
  })
}

/** Close an open decision without answering it; a reason is required. */
export function withdrawDecision(root, contract, id, input = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const patch = isPlainObject(input) ? input : {}
  return withLock(root, c, (paths) => {
    const current = requireOpenDecision(readRecord(paths.decisions, id, 'decision'), 'withdrawn')
    const reason = requireText(patch.reason, 'reason')
    const by = optionalEnum(patch.by, 'by', DECISION_BY, 'user')
    const at = formatIso()
    const next = { ...current, status: 'withdrawn', withdraw: { reason, at, by }, updated_at: at }
    writeJsonAtomic(join(paths.decisions, `${next.id}.json`), next)
    return next
  })
}

/**
 * Remove closed decisions whose last write is older than the retention window.
 * Open records are never removed; `dryRun` only reports.
 * @returns {{removed:string[], kept:number, dryRun:boolean}}
 */
export function gcDecisions(root, contract, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const days = input.days === undefined || input.days === null ? DECISION_GC_DAYS : input.days
  if (!Number.isInteger(days) || days < 1) throw invalid('days must be an integer >= 1')
  const dryRun = input.dryRun === true
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const cutoff = days * 24 * 60 * 60 * 1000
  return withLock(root, c, (paths) => {
    const result = { removed: [], kept: 0, dryRun }
    for (const item of readCollection(paths.decisions)) {
      const record = item.record
      if (record.status === 'open') {
        result.kept += 1
        continue
      }
      const stamp = timeValue(record.updated_at)
      // A broken timestamp cannot prove the record is old: keep it.
      if (Number.isFinite(stamp) === false || now - stamp <= cutoff) {
        result.kept += 1
        continue
      }
      result.removed.push(typeof record.id === 'string' ? record.id : item.name.slice(0, -5))
      if (dryRun === true) continue
      try {
        unlinkSync(item.file)
      } catch (error) {
        noteWarning(`decision-gc-failed: ${item.name}: ${error.message}`)
      }
    }
    result.removed.sort()
    return result
  })
}

/** Clear `task.decision` pointers that named a decision removed with its session. */
function clearDecisionPointers(root, contract, removedIds) {
  const wanted = new Set(removedIds)
  const cleared = []
  let tasks
  try {
    tasks = listTasks(root, contract)
  } catch (error) {
    noteWarning(`decision-archive-pointer-scan-failed: ${error.message}`)
    return cleared
  }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const pointer = typeof task.decision === 'string' ? task.decision.trim() : ''
    if (pointer === '' || wanted.has(pointer) === false) continue
    try {
      // A decision that left with its session can never be answered: clear the
      // dangling veto pointer so the task does not keep a promise nobody can keep.
      updateTask(root, contract, task.id, { decision: null }, { source: 'internal' })
      cleared.push(task.id)
    } catch (error) {
      noteWarning(`decision-archive-pointer-failed: ${task.id}: ${error.message}`)
    }
  }
  cleared.sort()
  return cleared
}

/**
 * Remove every decision owned by an archived session (open and closed alike):
 * a decision belongs to the conversation that asked it and must not outlive it.
 * The durable archive set comes from the Host (`workspaceRegistry.archivedSessionIds`);
 * this function only applies it. Records without `asked_session` are never
 * touched (nobody archived them), and the call is idempotent.
 *
 * Veto decisions also leave a `decision` pointer on their task; clearing it is
 * part of "no leftovers" and is reported in `clearedTasks`.
 *
 * @param {string[]} archivedSessionIds session ids the Host reports as archived
 * @param {{dryRun?:boolean}} [options]
 * @returns {{removed:string[], clearedTasks:string[], dryRun:boolean, archived:number}}
 */
export function purgeArchivedDecisions(root, contract, archivedSessionIds, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  if (!Array.isArray(archivedSessionIds)) throw invalid('archivedSessionIds must be an array of session ids')
  const archived = new Set(
    archivedSessionIds
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item !== ''),
  )
  const input = isPlainObject(options) ? options : {}
  const dryRun = input.dryRun === true
  const removed = withLock(root, c, (paths) => {
    const out = []
    for (const item of readCollection(paths.decisions)) {
      const record = item.record
      const owner = typeof record.asked_session === 'string' ? record.asked_session.trim() : ''
      if (owner === '' || archived.has(owner) === false) continue
      out.push(typeof record.id === 'string' ? record.id : item.name.slice(0, -5))
      if (dryRun === true) continue
      try {
        unlinkSync(item.file)
      } catch (error) {
        noteWarning(`decision-archive-purge-failed: ${item.name}: ${error.message}`)
      }
    }
    out.sort()
    return out
  })
  const clearedTasks = dryRun === true || removed.length === 0 ? [] : clearDecisionPointers(root, c, removed)
  return { removed, clearedTasks, dryRun, archived: archived.size }
}

/**
 * Read-only projection for the Host reminder, panel and `flow status`:
 * `{items, counts}` where items are the open decisions in the canonical order
 * and counts cover `{open, blocking, escalated, answered, withdrawn, superseded,
 * total}`. `limit` truncates `items` (counts stay session-scoped with the filter);
 * a non-empty `session` restricts both items and counts to that session's
 * records — the agent-facing reminder/tool view. No `session` = global view
 * (panel, human CLI).
 * @param {{limit?:number, session?:string, turn?:number|null, now?:number}} [options]
 */
export function summarizeDecisions(root, contract, options = {}) {
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const session = decisionSessionOf(input)
  const annotated = decisionRecords(storePaths(root, c, { pathMemo: pathMemoOf(options) }))
    .map((record) => annotateDecision(record, input))
    .filter((record) => session === '' || decisionOwnedBy(record, session))
  const open = annotated.filter((record) => record.status === 'open').sort(decisionOpenOrder)
  const counts = {
    open: open.length,
    blocking: open.filter(
      (record) => Array.isArray(record.blocks) && record.blocks.length > 0 && Array.isArray(record.affects) && record.affects.length > 0,
    ).length,
    escalated: open.filter((record) => record.escalated === true).length,
    answered: annotated.filter((record) => record.status === 'answered').length,
    withdrawn: annotated.filter((record) => record.status === 'withdrawn').length,
    superseded: annotated.filter((record) => record.status === 'superseded').length,
    total: annotated.length,
  }
  const limit = Number.isInteger(input.limit) && input.limit >= 0 ? input.limit : null
  return { items: limit === null ? open : open.slice(0, limit), counts }
}

/** One staged file against one decision's affects entries (file === prefix or below it). */
function decisionAffectsMatch(affects, stagedPath) {
  for (const entry of affects) {
    if (stagedPath === entry) return true
    if (stagedPath.startsWith(`${entry}/`)) return true
  }
  return false
}

/** Staged paths for `check decisions`: the explicit override, else `git diff --cached`. */
function decisionStagedFiles(root, options) {
  if (Array.isArray(options.staged)) {
    return options.staged
      .map((item) => String(item ?? '').trim().replace(/\\/g, '/'))
      .filter((item) => item !== '')
  }
  const result = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error !== undefined && result.error !== null) {
    throw new FlowError('io', `git diff --cached failed: ${result.error.message}`)
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const detail = String(result.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''
    throw new FlowError('io', `git diff --cached failed${detail === '' ? '' : `: ${detail}`}`)
  }
  return String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * The blocking-decision gate (`flow check decisions`, read-only, never writes):
 * fails when an open decision with a non-empty `blocks` declares an `affects`
 * prefix that matches one of the staged files.
 * @param {{staged?:string[]}} [options] `staged` overrides git (tests/callers)
 * @returns {{open:number, blocking:number, staged:string[], failed:object[]}}
 */
export function checkDecisions(root, contract, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const input = isPlainObject(options) ? options : {}
  const open = decisionRecords(storePaths(root, c)).filter((record) => record.status === 'open')
  const blocking = open.filter(
    (record) => Array.isArray(record.blocks) && record.blocks.length > 0 && Array.isArray(record.affects) && record.affects.length > 0,
  )
  const staged = decisionStagedFiles(root, input)
  const failed = []
  for (const record of blocking) {
    const matched = staged.filter((file) => decisionAffectsMatch(record.affects, file))
    if (matched.length === 0) continue
    failed.push({
      id: record.id,
      question: record.question,
      blocks: record.blocks,
      affects: record.affects,
      matched,
    })
  }
  return { open: open.length, blocking: blocking.length, staged, failed }
}
