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
 * RESIDUAL (2026-11-08): the real Host `UserMessage` has no `timestamp`, so that
 * window can only classify payloads that carry one (fixtures/legacy records). An
 * already-captured replay is still deduped by the persisted `source.key` at
 * flush; never-captured old history is not filtered — closing that needs a
 * Host-provided message time (CONTRACT §5.4.1).
 *
 * The Host's `UserMessage` is `{id, role, content, source}` — it has a **stable
 * `id`** and **no `timestamp`** (the plan's `{role, content, timestamp}` sketch
 * was wrong; see @deepseek-ai/dsh-llm's message typings). The dedupe key is
 * therefore derived from the message id: `sha256(['id', id, text,
 * ...attachmentIds].join('\0'))`, with the legacy `sha256(timestamp + '\0' +
 * text)` kept as the fallback for fixtures/records without an id. It is written
 * to the ledger as `source.key`, which is what makes dedupe survive a restart;
 * the in-memory `seen`/`lastKeys` sets only make the common path cheap.
 *
 * A message may carry durable attachment references (screenshots, files). They
 * are normalized into `source.attachments` by {@link attachmentsOfContent} so a
 * later reader can tell "text only" from "two screenshots + one sentence"; the
 * text pipeline alone would silently collapse them into the caption.
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

/**
 * Known system-generated prefixes that must never become tasks.
 *
 * `background job …` 是宿主的后台任务完成通知（2026-11-09 实测：真实台账里
 * 5 张「background job workflow-… finished」卡，全是通知、不是用户请求）。
 * 它和用户自己说的话一样以 `role:'user'` 出现，只能按文本前缀排除。
 */
export const SYSTEM_MESSAGE_PREFIXES = Object.freeze(['【project-flow】', '<system-reminder>', '[WIP]', 'background job '])

/**
 * 队友消息的文本约定（task-76，旧兜底）：早期宿主 `UserMessage` 没有 sender
 * 元数据，只能认 `Team message from exec-panel: …` 前缀。2026-11-11 起结构判据
 * （见 {@link PEER_SOURCE_KINDS}）是主判据，这里只留给没有 `source` 的旧夹具/
 * 旧记录；语义仍是 `excludedBy='peer'`（"错误捕获了同伴回报"）。
 *
 * Kept separate from SYSTEM_MESSAGE_PREFIXES so `excludedBy` can report `peer`
 * (a distinct failure class: "we captured a teammate's report").
 */
export const PEER_MESSAGE_PREFIXES = Object.freeze(['Team message from '])

/**
 * Peer reports also arrive as `Agent <id> sent a message: …` (2026-11-11 实测：
 * 子代理回报被建成了任务卡 T-20261111155926，占住栈顶）。这条形状比固定前缀
 * 更需要精确边界：只认「Agent + 单个 id + sent a message:」，避免把用户自己
 * 写的 "Agent 设计说明" 之类误杀。
 */
export const PEER_MESSAGE_PATTERN = /^Agent\s+[A-Za-z0-9][A-Za-z0-9_-]*\s+sent a message:/

/**
 * 结构化来源判据 = **宿主契约真值**（2026-11-11 核对 DSH 安装包）。宿主
 * `UserMessage` 恒带 `source`（`@deepseek-ai/dsh-llm` 的
 * `MessageBase {id, content, source}`，见 lib/types/message.d.ts）；同伴/子代理
 * 消息的 `source.kind` 有三个真值：
 *
 * - `agent-message`：相邻 agent 消息，`{kind:'agent-message', form:'relay',
 *   senderSessionId}`，由 `@deepseek-ai/dsh-subagent` 的
 *   continuation-messages.js（`agentMessageSource` / `createAgentMessage`）构造，
 *   content 首块是 `Agent <id> sent a message: `；
 * - `team-message`：队友消息，`{kind:'team-message', teamId, messageId,
 *   senderId, senderName}`；
 * - `subagent-settled`：子代理结束通知，`{kind:'subagent-settled',
 *   form:'notice', summary, senderSessionId}`。
 *
 * 人类消息的 `source.kind` 恒为 `'user'`（user-rpc 也是 `kind:'user'`），不在表内。
 * `peer`/`teammate`/`agent`/`subagent` 是早期猜测的别名，仅保留兼容旧夹具/旧记录。
 */
const PEER_SOURCE_KINDS = Object.freeze([
  'agent-message',
  'team-message',
  'subagent-settled',
  'peer',
  'teammate',
  'agent',
  'subagent',
])

/**
 * Is this payload message a peer/subagent report rather than the person's words?
 *
 * 双判据（结构化优先，文本兜底）：宿主 `UserMessage` 的 `source.kind` 就能区分
 * 同伴/子代理（见 {@link PEER_SOURCE_KINDS}），按结构判定比猜文本可靠；没有
 * `source` 的旧夹具/旧记录才退回前缀/形状匹配。文本判据只在文案变化时兜底，
 * 不再是唯一信号。
 */
export function isPeerMessage(message, text) {
  const source = isPlainObject(message) && isPlainObject(message.source) ? message.source : null
  if (source !== null) {
    const kind = typeof source.kind === 'string' ? source.kind.trim().toLowerCase() : ''
    if (PEER_SOURCE_KINDS.includes(kind)) return true
    /* 宿主契约字段是 senderSessionId / senderId / senderName；sender / agentId /
       agent_id / from 是老别名。人类消息 source 只有 `{kind:'user'}`（或
       user-rpc 的 `{kind:'user', rpcId}`），不含这些字段——字段兜底不会误杀
       普通用户消息。 */
    for (const field of ['senderSessionId', 'senderId', 'senderName', 'sender', 'agentId', 'agent_id', 'from']) {
      if (typeof source[field] === 'string' && source[field].trim() !== '') return true
    }
  }
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') return false
  if (PEER_MESSAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true
  return PEER_MESSAGE_PATTERN.test(trimmed)
}

/**
 * Command prefix (D-20261108-02 = command). The user defined the interface:
 * **chat is a task; `/command` is not.** This is not a heuristic over text — it
 * is an explicit structural signal, so a command message is never captured.
 * Commands are parsed by `lib/commands.mjs` for the reminder only; parsing never
 * writes the ledger and this module never executes anything.
 */
export const COMMAND_PREFIX = '/'

/**
 * Why a text is excluded, or `null`. `stale`/`dup` are decided per message in
 * {@link recordPreStep} (they need the timestamp / previous-step sets), so they
 * never appear here.
 */
export function exclusionReasonOf(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith(CAPTURE_CONTEXT_SENTINEL)) return 'sentinel'
  if (SYSTEM_MESSAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return 'prefix'
  if (PEER_MESSAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return 'peer'
  /* 文本兜底与 {@link PEER_MESSAGE_PATTERN} 同口径：`isExcludedText`（纯函数）
     与 `recordPreStep`（真实路径）必须对同一形状得出同一结论，否则两处会分叉。 */
  if (PEER_MESSAGE_PATTERN.test(trimmed)) return 'peer'
  return null
}

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

/** Done / archived / cancelled no longer need the session's attention. */
export function isUnfinished(record) {
  /* Control-word captures (D-20261108-01) stay in the ledger but never occupy
     the stack; `stack` and `unfinished` both derive from this one predicate. */
  if (isPlainObject(record.source) && record.source.kind === 'control') return false
  const stage = effectiveStage(record)
  return stage !== 'done' && stage !== 'archived' && stage !== 'cancelled'
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

/** The legacy dedupe key of one utterance (fixtures/records without a message id). */
export function utteranceKey(timestamp, text) {
  const material = `${timestamp === undefined || timestamp === null ? '' : String(timestamp)}\0${text}`
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * The dedupe key of one utterance.
 *
 * The Host's `UserMessage` carries a stable `id` and no timestamp, so the id is
 * the identity: two *different* messages that happen to share the same text must
 * become two tasks, while the same message replayed on the next step (or after a
 * restart) must dedupe. Records written before this card keep their legacy
 * `sha256(timestamp + '\0' + text)` keys untouched; a message without an id
 * falls back to that exact material (plus attachment ids when present) so old
 * fixtures and hand-made payloads keep working.
 */
export function utteranceKeyOf(message, text, attachments) {
  const source = isPlainObject(message) ? message : {}
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  const ids = []
  if (Array.isArray(attachments)) {
    for (const entry of attachments) {
      if (isPlainObject(entry) && typeof entry.attachmentId === 'string' && entry.attachmentId !== '') ids.push(entry.attachmentId)
    }
  }
  if (id !== '') {
    const material = ['id', id, text, ...ids].join('\0')
    return createHash('sha256').update(material, 'utf8').digest('hex')
  }
  const timestamp = source.timestamp
  const material = `${timestamp === undefined || timestamp === null ? '' : String(timestamp)}\0${text}${ids.length === 0 ? '' : `\0${ids.join('\0')}`}`
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * Durable attachment references carried by one message, normalized to a flat,
 * validatable shape (`{kind:'image'|'file', attachmentId, …}`).
 *
 * The Host's content blocks reference stored attachments — never raw bytes:
 * `{type:'image', attachment:{attachmentId, mediaType, bytes, width, height, name?}}`
 * and `{type:'file', attachment:{attachmentId, name, bytes}}` (see
 * @deepseek-ai/dsh-attachment). A block whose guaranteed fields are missing is
 * **skipped** instead of coerced to zeros: zeros would look like a real 0-byte
 * attachment, which is worse than an absent row. This runs on the per-step
 * critical path, so it must never throw.
 */
export function attachmentsOfContent(content) {
  const blocks = Array.isArray(content) ? content : [content]
  const attachments = []
  for (const block of blocks) {
    if (isPlainObject(block) === false) continue
    if (block.type !== 'image' && block.type !== 'file') continue
    const ref = block.attachment
    if (isPlainObject(ref) === false) continue
    const attachmentId = typeof ref.attachmentId === 'string' ? ref.attachmentId.trim() : ''
    if (attachmentId === '') continue
    if (block.type === 'image') {
      const mediaType = typeof ref.mediaType === 'string' ? ref.mediaType.trim() : ''
      if (mediaType === '') continue
      if (Number.isInteger(ref.bytes) === false || ref.bytes < 0) continue
      if (Number.isInteger(ref.width) === false || ref.width <= 0) continue
      if (Number.isInteger(ref.height) === false || ref.height <= 0) continue
      const entry = {
        kind: 'image',
        attachmentId,
        mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
      }
      if (typeof ref.name === 'string' && ref.name !== '') entry.name = ref.name
      if (block.offloaded === true) entry.offloaded = true
      attachments.push(entry)
      continue
    }
    const name = typeof ref.name === 'string' ? ref.name.trim() : ''
    if (name === '') continue
    if (Number.isInteger(ref.bytes) === false || ref.bytes < 0) continue
    attachments.push({ kind: 'file', attachmentId, name, bytes: ref.bytes })
  }
  return attachments
}

/** Rule ① + ②: plugin-injected context and known system prompts never count. */
export function isExcludedText(text) {
  if (typeof text !== 'string') return true
  const trimmed = text.trim()
  if (trimmed === '') return true
  return exclusionReasonOf(trimmed) !== null
}

/** One `UserMessage` → `{ text, at, key, attachments }`, or `null` when it carries neither text nor attachments. */
export function extractUtterance(message) {
  if (isPlainObject(message) === false) return null
  if (message.role !== 'user') return null
  const text = textOfContent(message.content).trim()
  const attachments = attachmentsOfContent(message.content)
  if (text === '' && attachments.length === 0) return null
  return { text, at: stampOf(message.timestamp), key: utteranceKeyOf(message, text, attachments), attachments }
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
 * Display title for a message that carries attachments but no text. It names
 * *what* was sent (never a fake sentence), so the panel/status block stays
 * readable and `source.text` can honestly remain `''`.
 */
export function attachmentTitle(attachments) {
  const rows = Array.isArray(attachments) ? attachments.filter((entry) => isPlainObject(entry)) : []
  const images = rows.filter((entry) => entry.kind === 'image').length
  const files = rows.filter((entry) => entry.kind === 'file').length
  const parts = []
  if (images > 0) parts.push(`图片 ×${images}`)
  if (files > 0) parts.push(`文件 ×${files}`)
  return parts.length === 0 ? '[附件]' : `[附件] ${parts.join('、')}`
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
  return {
    buckets: new Map(),
    mountedAt: Date.now(),
    /* Diagnostics (regression 2): "nothing happened" and "it failed" used to be
       the same value. `skipped` names the exact exit (`no-target` / `no-core` /
       `no-contract` / `nothing-pending` / `flush-failed` / `ok`, plus the
       pre-step reasons `no-messages` / `filtered-out` / `queued-n`). */
    lastAt: null,
    lastCreated: 0,
    lastPending: 0,
    lastMessages: 0,
    lastSkip: null,
    lastExcludedBy: null,
    lastError: null,
  }
}

/** Copy a diagnostic patch onto the state; a null state is "capture off" (no-op). */
function markCapture(state, patch) {
  if (isPlainObject(state) === false) return
  if (isPlainObject(patch) === false) return
  if (typeof patch.at === 'string') state.lastAt = patch.at
  if (Number.isInteger(patch.created) && patch.created >= 0) state.lastCreated = patch.created
  if (Number.isInteger(patch.pending) && patch.pending >= 0) state.lastPending = patch.pending
  if (Number.isInteger(patch.messages) && patch.messages >= 0) state.lastMessages = patch.messages
  if (typeof patch.excludedBy === 'string' && patch.excludedBy !== '') state.lastExcludedBy = patch.excludedBy
  if (typeof patch.skipped === 'string' && patch.skipped !== '') {
    /* `nothing-pending` is the weakest reason: it must not erase the pre-step
       explanation for *why* nothing was queued this turn. */
    const weak = patch.skipped === 'nothing-pending'
    const strongPrevious = state.lastSkip === 'no-messages' || state.lastSkip === 'filtered-out' || state.lastSkip === 'no-target'
    if (!(weak && strongPrevious)) state.lastSkip = patch.skipped
  }
  if (patch.error === null) state.lastError = null
  else if (typeof patch.error === 'string' && patch.error !== '') state.lastError = patch.error
}

/**
 * Record one of the five turn-stopping exits (`no-target` / `no-core` /
 * `no-contract` / `nothing-pending` / `flush-failed`; `ok` when rows were
 * written). Exported so `index.js` has exactly one implementation of the
 * diagnostic contract and tests can drive every constant.
 */
export function noteCaptureGate(state, skipped, extra) {
  const patch = isPlainObject(extra) ? { ...extra } : {}
  const at = typeof patch.at === 'string' ? patch.at : new Date().toISOString()
  /* Pre-step reasons are stronger than the generic "queue was empty": if this
     turn's messages were absent or all excluded, that is *why* the flush found
     nothing — keep it instead of flattening everything to `nothing-pending`. */
  if (
    skipped === 'nothing-pending' &&
    isPlainObject(state) &&
    (state.lastSkip === 'no-messages' || state.lastSkip === 'filtered-out' || state.lastSkip === 'no-target')
  ) {
    markCapture(state, { ...patch, at })
    return
  }
  markCapture(state, { ...patch, skipped, at })
}

function describe(error) {
  if (error === null || error === undefined) return 'unknown error'
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
  return message.length > 200 ? `${message.slice(0, 197)}...` : message
}

/**
 * Status-block view of the last capture attempt: `null` when capture is off,
 * otherwise `{lastRun, created, error}`. `error` is the difference between
 * "nothing to capture" (empty string) and "it failed" (message).
 */
export function captureSummary(state) {
  if (isPlainObject(state) === false) return null
  return {
    lastAt: typeof state.lastAt === 'string' ? state.lastAt : null,
    created: Number.isInteger(state.lastCreated) && state.lastCreated >= 0 ? state.lastCreated : 0,
    pending: Number.isInteger(state.lastPending) && state.lastPending >= 0 ? state.lastPending : 0,
    messages: Number.isInteger(state.lastMessages) && state.lastMessages >= 0 ? state.lastMessages : 0,
    skipped: typeof state.lastSkip === 'string' && state.lastSkip !== '' ? state.lastSkip : null,
    excludedBy: typeof state.lastExcludedBy === 'string' && state.lastExcludedBy !== '' ? state.lastExcludedBy : null,
    error: typeof state.lastError === 'string' && state.lastError !== '' ? state.lastError : null,
  }
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
export function recordPreStep(state, input, onError) {
  try {
    const source = isPlainObject(input) ? input : {}
    const messages = Array.isArray(source.messages) ? source.messages : []
    const root = typeof source.root === 'string' ? source.root : ''
    const session = typeof source.session === 'string' ? source.session : ''
    if (root === '' || session === '') {
      markCapture(state, { messages: messages.length, skipped: 'no-target' })
      return 0
    }
    if (messages.length === 0) {
      markCapture(state, { messages: 0, skipped: 'no-messages' })
      return 0
    }
    if (isPlainObject(state) === false || state.buckets instanceof Map === false) return 0
    const key = bucketKey(root, session)
    let bucket = state.buckets.get(key)
    if (bucket === undefined) {
      bucket = { pending: [], lastKeys: new Set(), seen: new Set() }
      state.buckets.set(key, bucket)
    }
    const current = new Set()
    const fresh = []
    /* Last exclusion reason wins: the point is to say *why* the newest message
       the plugin saw did not become a task. */
    let excludedBy = null
    for (const message of messages) {
      // Raw content matters here: `extractUtterance` trims, but the command rule
      // is defined on `trimStart()` of what the user typed (leading spaces are
      // still a command). Keep the raw text for that one decision.
      const rawText = textOfContent(message === null || message === undefined ? undefined : message.content)
      const utterance = extractUtterance(message)
      if (utterance === null) continue
      // The diff baseline includes excluded messages too: a replayed system
      // reminder must not look "new" on the next step.
      current.add(utterance.key)
      // Explicit contract first: `/command` is not chat, so it is never a task.
      if (rawText.trimStart().startsWith(COMMAND_PREFIX)) {
        excludedBy = 'command'
        continue
      }
      const structural = exclusionReasonOf(utterance.text)
      if (structural !== null) {
        excludedBy = structural
        continue
      }
      /* 2026-11-11：peer 判定升级为双判据（结构化 source 优先，文本形状兜底）。
         `Agent <id> sent a message:` 之前只按固定前缀匹配，漏掉了子代理回报。 */
      if (isPeerMessage(message, utterance.text)) {
        excludedBy = 'peer'
        continue
      }
      // Defect 2: only what the user said around this mount counts. A resumed
      // session replays days-old history on the first step; those messages must
      // not become tasks (nor occupy the stack top above the newest request).
      // RESIDUAL (2026-11-08): the real Host `UserMessage` has no timestamp, so
      // this guard only fires for fixtures/records that carry one; filtering a
      // resumed replay needs a Host-provided message time (see CONTRACT §5.4.1).
      const stamp = timestampMsOf(message.timestamp)
      if (stamp !== null && stamp < mountedAtOf(state) - CAPTURE_GRACE_MS) {
        excludedBy = 'stale'
        continue
      }
      if (bucket.lastKeys.has(utterance.key) || bucket.seen.has(utterance.key)) {
        excludedBy = 'dup'
        continue
      }
      fresh.push(utterance)
    }
    markCapture(state, { excludedBy })
    bucket.lastKeys = current
    for (const utterance of fresh) bucket.pending.push(utterance)
    markCapture(state, {
      messages: messages.length,
      pending: bucket.pending.length,
      skipped: fresh.length === 0 ? 'filtered-out' : 'queued-n',
    })
    return fresh.length
  } catch (error) {
    markCapture(state, { skipped: 'pre-step-failed', error: `recordPreStep: ${describe(error)}` })
    if (typeof onError === 'function') {
      try {
        onError(error)
      } catch {
        // the warning sink itself must not break the step
      }
    }
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
  const mark = (createdCount, error, skip, pending) => {
    markCapture(state, {
      at: new Date().toISOString(),
      created: createdCount,
      skipped: skip,
      pending: Number.isInteger(pending) && pending >= 0 ? pending : 0,
      error: error === null || error === undefined ? null : `flushCapture: ${describe(error)}`,
    })
  }
  const input = isPlainObject(options) ? options : {}
  const core = input.core
  const root = typeof input.root === 'string' ? input.root : ''
  const contract = input.contract
  const session = typeof input.session === 'string' ? input.session : ''
  if (isPlainObject(core) === false || root === '' || session === '') {
    mark(0, null, 'no-target')
    return { created: [], skipped: 0 }
  }
  const bucket = bucketOf(state, root, session)
  if (bucket === null || bucket.pending.length === 0) {
    mark(0, null, 'nothing-pending')
    return { created: [], skipped: 0 }
  }
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
  /* 分支来源（2026-11-09 审计项 11）：一次 flush 只探一次 git，写进每条卡片的
     `source.branch`；非 git / 分离 HEAD 时键不存在（面板就不出徽标）。 */
  const branch = typeof core.gitBranchOf === 'function' ? core.gitBranchOf(root) : null
  let index = 0
  try {
    for (; index < ordered.length; index += 1) {
      const utterance = ordered[index]
      if (existing.has(utterance.key)) continue
      // A message with attachments but no text still becomes a task; its title
      // names the attachments instead of pretending the user typed something.
      const titleOfUtterance = utterance.text === '' ? attachmentTitle(utterance.attachments) : clipTitle(utterance.text)
      const source = {
        // D-20261108-02: every captured chat message is an utterance. `control`
        // remains a valid legacy value in core, but is never written again.
        kind: 'utterance',
        key: utterance.key,
        at: utterance.at,
        text: sourceTextOf(utterance.text),
      }
      if (Array.isArray(utterance.attachments) && utterance.attachments.length > 0) {
        source.attachments = utterance.attachments.map((entry) => ({ ...entry }))
      }
      if (branch !== null) source.branch = branch
      const task = core.addTask(root, contract, {
        type: CAPTURED_TASK_TYPE,
        title: titleOfUtterance,
        stage: 'created',
        /* The capture's session owns the task (D-20261108-05 = extend-owner):
           `owner` is the task's session field, so another live session cannot
           take it over, and a dead session's cards are released by the host
           sweep (`releaseDeadSessionTasks`). */
        owner: session,
        source,
      })
      // Persist `created` first, then the plugin's own advance: the stage machine
      // only documents this edge, so the two writes are visible in order.
      core.updateTask(root, contract, task.id, { stage: 'queued-analysis' })
      bucket.seen.add(utterance.key)
      created.push({ id: task.id, key: utterance.key, at: utterance.at, title: titleOfUtterance })
    }
    mark(created.length, null, created.length === 0 ? 'nothing-pending' : 'ok', bucket.pending.length)
    return { created, skipped: ordered.length - created.length }
  } catch (error) {
    // Put every not-yet-written sentence back so the next turn retries them.
    bucket.pending.unshift(...ordered.slice(index))
    mark(0, error, 'flush-failed')
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

export function buildStatusBlock(core, root, contract, team, capture) {
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
    /* Regression 2: "nothing captured" and "capture failed" must be separable. */
    capture: captureSummary(capture),
    unfinished: unfinished.length,
    recentCaptured,
  }
}

function stageName(stage) {
  // Single stage table, never restated here.
  return STAGE_ZH[stage] ?? stage
}
