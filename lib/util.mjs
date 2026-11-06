/**
 * Low-level primitives shared by the flow store: the stable error type, plain
 * object/clone helpers, timestamp formatting, the warning channel, and the
 * per-process temp-name suffix.
 *
 * Split out of `lib/core.mjs` (task-49) as a pure move: no logic changed and
 * `lib/core.mjs` re-exports every public name, so all existing import paths and
 * export names are unchanged.
 */

/** Stable error type; `code` is one of invalid|not-found|conflict|io|usage. */
export class FlowError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FlowError'
    this.code = code
  }
}

function invalid(message) {
  return new FlowError('invalid', message)
}

// ------------------------------------------------------------ tiny helpers

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = deepClone(item)
    return out
  }
  return value
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

/** Local time as `YYYY-MM-DDTHH:mm:ss+HH:MM` (no dependency on Intl). */
function formatIso(date = new Date()) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

function dateStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

/** Local-time `YYYYMMDDHHMMSS` used by timestamp task ids. */
function timeStamp(date = new Date()) {
  return `${dateStamp(date)}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function timeValue(value) {
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function toPosix(value) {
  return String(value).split('\\').join('/')
}

const warningLog = []
const WARNING_CAP = 200

function noteWarningEntry(message) {
  if (warningLog.length < WARNING_CAP) warningLog.push(String(message))
}

/**
 * Record a diagnostic into the log `drainWarnings()` returns. Extra alias for
 * the CLI's *non-core* input channels: `--type-map` diagnostics (an unknown id /
 * a key whose record already has a type) belong to a file the bin layer parses,
 * yet they must reach the caller through the one warnings channel (CONTRACT
 * §5.1) instead of growing a second one. Not part of the stable API surface.
 */
export { noteWarningEntry as noteWarning }
// Internal callers keep the old local name.
const noteWarning = noteWarningEntry

/**
 * Diagnostics collected by the last operations (stale-lock takeover, unknown
 * `expect` syntax, unreadable files). Not part of the public contract; the CLI
 * may surface it on stderr.
 */
export function drainWarnings() {
  return warningLog.splice(0, warningLog.length)
}

/**
 * Monotonic per-process suffix for our temp names (atomic writes and lock
 * takeover recovery). It lives here because an ES module cannot assign to an
 * imported binding: both writers must advance the same counter.
 */
let tempSeq = 0
function nextTempSuffix() {
  return `${process.pid}-${tempSeq++}`
}

export {
  dateStamp,
  deepClone,
  formatIso,
  invalid,
  isPlainObject,
  nextTempSuffix,
  pad,
  timeStamp,
  timeValue,
  toPosix,
}
