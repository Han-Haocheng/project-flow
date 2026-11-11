// project-flow — 记录读写原语（store 模块，2026-11-11 Phase 1 物理拆分）。
//
// 这里只放"与业务语义无关"的记录层能力：读目录成集合、读单条、id 生成、
// 字段校验原语、排序、目标占用保护。**不 import core**，也不碰契约/门禁/任务
// 的规则——那些仍在 lib/core.mjs 里，core 从本模块 import 这些原语。

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { FlowError, dateStamp, invalid, isPlainObject, noteWarning, pad, timeStamp, timeValue, toPosix } from '../util.mjs'

/**
 * Read every `<id>.json` record under `dir`. Unreadable records are skipped and
 * reported once as `unreadable:`. Pass `issues` (an array) to also collect their
 * absolute paths, so callers can count them instead of letting a broken file
 * silently disappear from the totals.
 */
export function readCollection(dir, issues) {
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new FlowError('io', `cannot read ${toPosix(dir)}: ${error.message}`)
  }
  const items = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!isPlainObject(parsed)) throw new Error('record is not a JSON object')
      items.push({ file, name, record: parsed })
    } catch (error) {
      noteWarning(`unreadable: ${toPosix(file)}: ${error.message}`)
      if (Array.isArray(issues)) issues.push(file)
    }
  }
  return items
}

/** `options.unreadable` collector from an optional list-call argument. */
export function unreadableCollector(options) {
  return isPlainObject(options) && Array.isArray(options.unreadable) ? options.unreadable : undefined
}

/**
 * Refuse to write a record whose target file already exists. The file may be a
 * record we could not parse (hand-edited or truncated); overwriting it would
 * destroy the only copy and silently reuse its id. `nextId` skips readable ids,
 * so this guard fires for unreadable/foreign files and explicit `--id` requests.
 *
 * A directory at the target path is deliberately *not* a conflict: it cannot be
 * a record, and the atomic write already fails it with `io`/`cannot write`.
 */
export function assertTargetFree(dir, id) {
  const file = join(dir, `${id}.json`)
  let occupiedByDirectory = false
  try {
    occupiedByDirectory = lstatSync(file).isDirectory()
  } catch (error) {
    if (error?.code === 'ENOENT') return
    // Unreadable metadata: treat it as occupied rather than clobbering a file.
  }
  if (occupiedByDirectory) return
  throw new FlowError(
    'conflict',
    `record id ${id} is already occupied by ${toPosix(resolve(file))} (possibly unreadable); fix or remove that file, then retry`,
  )
}

export function assertSafeId(id, label = 'id') {
  if (typeof id !== 'string' || id.length === 0) throw invalid(`${label} must be a non-empty string`)
  if (id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw invalid(`${label} is not a safe path segment: ${id}`)
  }
  return id
}

export function readRecord(dir, id, kind) {
  assertSafeId(id)
  const file = join(dir, `${id}.json`)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new FlowError('not-found', `${kind} ${id} not found`)
    throw new FlowError('io', `cannot read ${toPosix(file)}: ${error.message}`)
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) throw new Error('record is not a JSON object')
    return parsed
  } catch (error) {
    throw new FlowError('io', `invalid ${kind} record ${toPosix(file)}: ${error.message}`)
  }
}

export function sortByUpdatedDesc(records) {
  return records.sort((left, right) => {
    const delta = timeValue(right.updated_at) - timeValue(left.updated_at)
    if (delta !== 0) return delta
    return String(right.id ?? '').localeCompare(String(left.id ?? ''))
  })
}

/**
 * Oldest-created first (FIFO queue / claim order). A record whose `created_at`
 * is missing or unparseable sorts last — an unknown age must not jump the queue —
 * and the id orders ties deterministically.
 */
export function sortByCreatedAsc(records) {
  const createdAt = (record) => {
    const parsed = Date.parse(isPlainObject(record) && typeof record.created_at === 'string' ? record.created_at : '')
    return Number.isFinite(parsed) ? parsed : null
  }
  return records.sort((left, right) => {
    const a = createdAt(left)
    const b = createdAt(right)
    if (a !== null && b !== null) {
      if (a !== b) return a - b
    } else if (a === null && b !== null) return 1
    else if (a !== null && b === null) return -1
    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
  })
}

export function nextId(prefix, existingIds, date = new Date()) {
  const stamp = dateStamp(date)
  const pattern = new RegExp(`^${prefix}-${stamp}-(\\d{2})$`)
  let max = 0
  for (const id of existingIds) {
    if (typeof id !== 'string') continue
    const match = pattern.exec(id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  for (let index = max + 1; index <= 99; index += 1) {
    const candidate = `${prefix}-${stamp}-${pad(index)}`
    if (!existingIds.has(candidate)) return candidate
  }
  throw new FlowError('conflict', `no free ${prefix} id left for ${stamp}`)
}

/**
 * Timestamp task id (T-08 B1, D-20261105-05): `T-YYYYMMDDHHMMSS`; a second task
 * in the same second appends `-02`, `-03`, … (never `-01`). No manifest counter:
 * the clock is the monotonic source, the existing ids only resolve same-second
 * collisions. >99 tasks in one second is a conflict.
 */
export function nextTaskId(existingIds, date = new Date()) {
  const base = `T-${timeStamp(date)}`
  if (existingIds.has(base) === false) return base
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${base}-${pad(index)}`
    if (existingIds.has(candidate) === false) return candidate
  }
  throw new FlowError('conflict', `no free T id left for ${timeStamp(date)} (same-second limit 99)`)
}

export function assertPattern(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw invalid(`${label} has an invalid format: ${JSON.stringify(value)}`)
  }
  return value
}

export function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${label} must be a non-empty string`)
  return value.trim()
}

export function optionalText(value, label, fallback = '') {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw invalid(`${label} must be a string`)
  return value
}

export function optionalBoolean(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw invalid(`${label} must be a boolean`)
  return value
}

export function optionalEnum(value, label, allowed, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(`${label} must be one of ${allowed.join(', ')}`)
  }
  return value
}

export function optionalInt(value, label, fallback, min) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw invalid(`${label} must be an integer >= ${min}`)
  }
  return value
}

export function stringArray(value, label, fallback = []) {
  if (value === undefined || value === null) return fallback
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalid(`${label} must be an array of strings`)
  }
  return value.slice()
}


export function statusCounts(items, statuses) {
  const counts = { total: items.length }
  for (const status of statuses) counts[status] = 0
  for (const item of items) {
    if (typeof item.status === 'string' && Object.hasOwn(counts, item.status)) counts[item.status] += 1
  }
  return counts
}
