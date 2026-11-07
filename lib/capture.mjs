/**
 * P1 capture pipeline (task-64): every user sentence becomes a task.
 *
 * The split is deliberate and is the reason this module is separate from
 * `index.js`:
 *
 * - `agent/pre-step` is on **every step's critical path** — {@link recordPreStep}
 *   only touches memory (filter, diff, queue); no filesystem call, no throw.
 * - `agent/turn-stopping` is serial and awaited by the host — {@link flushCapture}
 *   is the only writer: it persists the queued sentences, writes
 *   `source={kind:'utterance', key, at, text}`, and advances each new task from
 *   `created` to `queued-analysis`.
 *
 * `source.text` keeps the **full** sentence (up to {@link SOURCE_TEXT_MAX}, with an
 * explicit truncation marker past it). `title` is clipped to 120 for the panel,
 * so without the full text the tail of a long sentence would be lost for good —
 * a hash cannot be read back.
 *
 * The state records `mountedAt`: a resumed session replays days-old history on
 * its first `pre-step`, and capturing that history would flood the LIFO stack
 * (so the newest real request would sit below old ones). Only utterances from
 * {@link CAPTURE_GRACE_MS} around the mount are user intent *now*; older ones are
 * skipped, while a brand-new session's very first sentence is still captured.
 *
 * A `UserMessage` has no stable per-batch identity we can trust (the plan's
 * contract: `{role, content, timestamp}`), so the dedupe key is
 * `sha256(timestamp + '\0' + plain text)`. It is written to the ledger as
 * `source.key`, which is what makes dedupe survive a process restart; the
 * in-memory `seen`/`lastKeys` sets only make the common path cheap.
 *
 * Three exclusions prevent self-eating (each has its own test — a combined case
 * cannot say which rule broke):
 * 1. `<flow-context>` sentinel = the plugin's own injected context;
 * 2. known system prefixes (`【project-flow】`, `<system-reminder>`, `[WIP]`);
 * 3. only messages that are new since the previous step (the host replays the
 *    same user batch on every step of a turn; without the diff every step would
 *    create another task and those tasks would then be "captured" again).
 *
 * The module never imports `lib/core.mjs`: callers inject the core module, so a
 * host without a loadable core keeps working (capture is simply skipped).
 */
import { createHash } from 'node:crypto'
import { DEFAULT_STAGE, STAGE_IDS, STAGE_ZH, legacyStageFromStatus } from './stage.mjs'

/** Sentinel prefix of context the plugin itself injects (P2 will emit it). */
export const CAPTURE_CONTEXT_SENTINEL = '<flow-context>'

/** Known system-generated prefixes that must never become tasks. */
export const SYSTEM_MESSAGE_PREFIXES = Object.freeze(['【project-flow】', '<system-reminder>', '[WIP]'])

/** Status-block bounds (§9 + §6.3 escape hatch). */
export const STACK_LIMIT = 8
export const RECENT_CAPTURED_LIMIT = 3

/** Captured tasks carry the least committed type until analysis re-labels them. */
export const CAPTURED_TASK_TYPE = 'chore'

/** A task title stays readable (the panel clips at 120 anyway). */
const TITLE_MAX = 120

/**
 * Full text kept on `source.text`. Past this the value is still stored, but with
 * an explicit `…[truncated N chars]` marker: a silent cut would be the same data
 * loss as not storing it at all, only harder to notice.
 */
export const SOURCE_TEXT_MAX = 4000

/**
 * Mount baseline: utterances older than `mountedAt - CAPTURE_GRACE_MS` are
 * history replayed by a resumed session, not something the user just said.
 * 30 s of slack covers the gap between session resume and the first step.
 */
export const CAPTURE_GRACE_MS = 30_000

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

function timeValue(value) {
  const stamp = Date.parse(typeof value === 'string' ? value : '')
  return Number.isFinite(stamp) ? stamp : Number.NEGATIVE_INFINITY
}

/** `created_at` descending, `id` descending as the tie-break (§11 LIFO). */
export function compareStack(a, b) {
  const left = isPlainObject(a) ? a : {}
  const right = isPlainObject(b) ? b : {}
  const delta = timeValue(right.created_at) - timeValue(left.created_at)
  if (delta !== 0) return delta
  const leftId = typeof left.id === 'string' ? left.id : ''
  const rightId = typeof right.id === 'string' ? right.id : ''
  if (leftId === rightId) return 0
  return leftId < rightId ? 1 : -1
}

/** The effective stage of one task, deriving legacy statuses into the machine. */
export function effectiveStage(record) {
  if (isPlainObject(record) === false) return DEFAULT_STAGE
  const stage = typeof record.stage === 'string' ? record.stage.trim() : ''
  if (STAGE_IDS.includes(stage)) return stage
  // No usable explicit stage: derive from `status` through the ONE shared rule.
  // Never re-map locally — this second fallback is exactly what diverged from
  // `legacyStageFromStatus` (active -> 'created' here vs 'queued-analysis'
  // there) and made raw records disagree with projected ones (task-68).
  return legacyStageFromStatus(record.status)
}

/** A stage that is done or archived no longer needs the session's attention. */
export function isUnfinished(record) {
  const stage = effectiveStage(record)
  return stage !== 'done' && stage !== 'archived'
}

/** The pure text of one message: string content or the text blocks of an array. */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content) === false) {
    if (isPlainObject(content) && content.type === 'text' && typeof content.text === 'string') return content.text
    return ''
  }
  const parts = []
  for (const block of content) {
    if (isPlainObject(block) && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** The dedupe key of one utterance (the plan's only stable identity). */
export function utteranceKey(timestamp, text) {
  const material = `${timestamp === undefined || timestamp === null ? '' : String(timestamp)}\0${text}`
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/** Rule ① + ②: plugin-injected context and known system prompts never count. */
export function isExcludedText(text) {
  if (typeof text !== 'string') return true
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (trimmed.startsWith(CAPTURE_CONTEXT_SENTINEL)) return true
  return SYSTEM_MESSAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/** One `UserMessage` → `{ text, at, key }`, or `null` when it carries no text. */
export function extractUtterance(message) {
  if (isPlainObject(message) === false) return null
  if (message.role !== 'user') return null
  const text = textOfContent(message.content).trim()
  if (text === '') return null
  const timestamp = message.timestamp
  return { text, at: stampOf(timestamp), key: utteranceKey(timestamp, text) }
}

/** `source.at`: the message timestamp when it is a string, else now. */
function stampOf(timestamp) {
  if (typeof timestamp === 'string' && timestamp.trim() !== '') return timestamp.trim()
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return new Date(timestamp).toISOString()
  return new Date().toISOString()
}

/** Title bound: `source.text` keeps the full sentence; this is display only. */
function clipTitle(text) {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text
}

/**
 * The full sentence for `source.text`, explicitly marked when it exceeds the cap
 * (dropping the tail silently would be exactly the defect this field fixes).
 */
function sourceTextOf(text) {
  if (text.length <= SOURCE_TEXT_MAX) return text
  return `${text.slice(0, SOURCE_TEXT_MAX)}…[truncated ${text.length - SOURCE_TEXT_MAX} chars]`
}

/** Epoch ms of a message timestamp (`number` or parseable string), else `null`. */
function timestampMsOf(timestamp) {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp
  if (typeof timestamp === 'string' && timestamp.trim() !== '') {
    const parsed = Date.parse(timestamp)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * The per-mount capture state: one bucket per (root, session) plus the mount
 * instant used by the history window. A new mount therefore starts a new window
 * (a resumed session's replayed history is older than the grace period).
 */
export function createCaptureState() {
  return { buckets: new Map(), mountedAt: Date.now() }
}

function bucketKey(root, session) {
  return `${root}\0${session}`
}

function bucketOf(state, root, session) {
  if (isPlainObject(state) === false || state.buckets instanceof Map === false) return null
  return state.buckets.get(bucketKey(root, session)) ?? null
}

/** The mount instant; a hand-built state without one degrades to "now". */
function mountedAtOf(state) {
  return isPlainObject(state) && Number.isFinite(state.mountedAt) ? state.mountedAt : Date.now()
}

/**
 * Memory-only `agent/pre-step` recorder. Returns how many utterances were
 * queued. Never throws and never touches disk: a broken payload means "nothing
 * to capture", never a failed step.
 */
export function recordPreStep(state, input) {
  try {
    const source = isPlainObject(input) ? input : {}
    const messages = Array.isArray(source.messages) ? source.messages : []
    const root = typeof source.root === 'string' ? source.root : ''
    const session = typeof source.session === 'string' ? source.session : ''
    if (root === '' || session === '' || messages.length === 0) return 0
    if (isPlainObject(state) === false || state.buckets instanceof Map === false) return 0
    const key = bucketKey(root, session)
    let bucket = state.buckets.get(key)
    if (bucket === undefined) {
      bucket = { pending: [], lastKeys: new Set(), seen: new Set() }
      state.buckets.set(key, bucket)
    }
    const current = new Set()
    const fresh = []
    for (const message of messages) {
      const utterance = extractUtterance(message)
      if (utterance === null) continue
      // The diff baseline includes excluded messages too: a replayed system
      // reminder must not look "new" on the next step.
      current.add(utterance.key)
      if (isExcludedText(utterance.text)) continue
      // Defect 2: only what the user said around this mount counts. A resumed
      // session replays days-old history on the first step; those messages must
      // not become tasks (nor occupy the stack top above the newest request).
      const stamp = timestampMsOf(message.timestamp)
      if (stamp !== null && stamp < mountedAtOf(state) - CAPTURE_GRACE_MS) continue
      if (bucket.lastKeys.has(utterance.key)) continue
      if (bucket.seen.has(utterance.key)) continue
      fresh.push(utterance)
    }
    bucket.lastKeys = current
    for (const utterance of fresh) bucket.pending.push(utterance)
    return fresh.length
  } catch {
    return 0
  }
}

/** Pending sentences for one (root, session), oldest first; for tests/inspection. */
export function pendingUtterances(state, root, session) {
  const bucket = bucketOf(state, root, session)
  return bucket === null ? [] : bucket.pending.slice()
}

/**
 * Serial writer: drain the queue and persist each new sentence.
 *
 * `core` is injected (`lib/core.mjs`). The ledger `source.key` snapshot is taken
 * **before** the loop, so a restart dedupes against everything an earlier flush
 * wrote, while in-batch duplicates (which rule ③ should have removed) are still
 * visible as separate tasks instead of being silently swallowed.
 *
 * Returns `{created, skipped}`; throws only when a ledger write throws (the
 * caller turns that into one mount warning and keeps the unprocessed queue).
 */
export function flushCapture(state, options) {
  const input = isPlainObject(options) ? options : {}
  const core = input.core
  const root = typeof input.root === 'string' ? input.root : ''
  const contract = input.contract
  const session = typeof input.session === 'string' ? input.session : ''
  if (isPlainObject(core) === false || root === '' || session === '') return { created: [], skipped: 0 }
  const bucket = bucketOf(state, root, session)
  if (bucket === null || bucket.pending.length === 0) return { created: [], skipped: 0 }
  const pending = bucket.pending.splice(0)
  const existing = new Set()
  try {
    const tasks = Array.isArray(core.listTasks(root, contract)) ? core.listTasks(root, contract) : []
    for (const task of tasks) {
      if (isPlainObject(task) && isPlainObject(task.source) && typeof task.source.key === 'string') {
        existing.add(task.source.key)
      }
    }
  } catch {
    // A broken ledger read is reported by the write call itself; dedupe degrades
    // to the in-memory `seen` set instead of dropping the whole flush.
  }
  const ordered = pending.slice().sort(compareUtteranceDesc)
  const created = []
  let index = 0
  try {
    for (; index < ordered.length; index += 1) {
      const utterance = ordered[index]
      if (existing.has(utterance.key)) continue
      const task = core.addTask(root, contract, {
        type: CAPTURED_TASK_TYPE,
        title: clipTitle(utterance.text),
        stage: 'created',
        source: { kind: 'utterance', key: utterance.key, at: utterance.at, text: sourceTextOf(utterance.text) },
      })
      // Persist `created` first, then the plugin's own advance: the stage machine
      // only documents this edge, so the two writes are visible in order.
      core.updateTask(root, contract, task.id, { stage: 'queued-analysis' })
      bucket.seen.add(utterance.key)
      created.push({ id: task.id, key: utterance.key, at: utterance.at, title: clipTitle(utterance.text) })
    }
    return { created, skipped: ordered.length - created.length }
  } catch (error) {
    // Put every not-yet-written sentence back so the next turn retries them.
    bucket.pending.unshift(...ordered.slice(index))
    throw error
  }
}

function compareUtteranceDesc(a, b) {
  const delta = timeValue(b.at) - timeValue(a.at)
  if (delta !== 0) return delta
  const left = typeof a.key === 'string' ? a.key : ''
  const right = typeof b.key === 'string' ? b.key : ''
  return left < right ? 1 : left > right ? -1 : 0
}

/** All tasks, projected to effective stages; tolerant of an unreadable ledger. */
function readTasks(core, root, contract) {
  try {
    const tasks = core.listTasks(root, contract)
    if (Array.isArray(tasks) === false) return []
    return tasks
      .filter((task) => isPlainObject(task))
      .map((task) => ({ ...task, stage: effectiveStage(task) }))
  } catch {
    return []
  }
}

/** The stack: unfinished tasks, newest first (§11). */
export function captureStack(core, root, contract) {
  return readTasks(core, root, contract).filter((task) => isUnfinished(task)).sort(compareStack)
}

/** The stack top (the task the session should be working on), or `null`. */
export function stackTop(core, root, contract) {
  const stack = captureStack(core, root, contract)
  return stack.length === 0 ? null : stack[0]
}

/**
 * The §9 status block. Shared by `flow_status`, `flow_heartbeat update` and (in
 * a later card) the CLI. `recentCaptured` is the escape hatch of §6.3: the three
 * newest auto-created tasks are always visible, so a mis-capture or a missed
 * capture cannot hide.
 */
/** `available:false` skeleton: counts stay 0, but the block never pretends to know. */
const TEAM_UNAVAILABLE = Object.freeze({
  available: false,
  members: 0,
  tasks: 0,
  linked: 0,
  missing: 0,
  orphaned: 0,
})

/** Normalize a caller-provided team status; anything malformed degrades to unavailable. */
function teamStatusOf(value) {
  if (isPlainObject(value) === false) return { ...TEAM_UNAVAILABLE }
  const count = (number) => (Number.isInteger(number) && number >= 0 ? number : 0)
  return {
    available: value.available === true,
    members: count(value.members),
    tasks: count(value.tasks),
    linked: count(value.linked),
    missing: count(value.missing),
    orphaned: count(value.orphaned),
  }
}

export function buildStatusBlock(core, root, contract, team) {
  const tasks = readTasks(core, root, contract)
  const unfinished = tasks.filter((task) => isUnfinished(task)).sort(compareStack)
  const counts = {}
  for (const stage of STAGE_IDS) counts[stage] = 0
  for (const task of tasks) {
    // Defense in depth: a caller may hand us records that never went through the
    // core projection. `effectiveStage` applies the same status fallback, so the
    // counts cannot silently drop such a record (task-68).
    const stage = effectiveStage(task)
    if (Object.hasOwn(counts, stage)) counts[stage] += 1
  }
  const stack = unfinished.slice(0, STACK_LIMIT).map((task) => ({
    id: typeof task.id === 'string' ? task.id : '',
    type: typeof task.type === 'string' ? task.type : null,
    stage: task.stage,
    stageZh: stageName(task.stage),
    title: typeof task.title === 'string' ? task.title : '',
    created_at: typeof task.created_at === 'string' ? task.created_at : '',
  }))
  const recentCaptured = tasks
    .filter((task) => isPlainObject(task.source) && task.source.kind === 'utterance')
    .sort(compareStack)
    .slice(0, RECENT_CAPTURED_LIMIT)
    .map((task) => ({
      id: typeof task.id === 'string' ? task.id : '',
      title: typeof task.title === 'string' ? task.title : '',
      at: typeof task.source.at === 'string' ? task.source.at : '',
      stage: task.stage,
      stageZh: stageName(task.stage),
    }))
  return {
    stack,
    counts,
    // P3a: the caller (tool/panel read path) passes the real sync result. Without
    // a Team service the block says `available:false` and keeps 0 counts — a
    // fake 0 would make "cannot read" indistinguishable from "nothing there".
    team: teamStatusOf(team),
    unfinished: unfinished.length,
    recentCaptured,
  }
}

function stageName(stage) {
  // Single stage table, never restated here.
  return STAGE_ZH[stage] ?? stage
}
