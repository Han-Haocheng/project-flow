// project-flow — aspect 锁：把「每个 aspect 只有一个所有者」的审批串行，换成自动占用
// （T-20261112183138，阶段 2 裁定 6；2026-11-12）。
//
// 背景：aspect 少而稳，但每个 aspect 只有一个所有者 → 所有者成为串行瓶颈（实测：
// 一个 state-machine aspect 涉及 5 张卡，全要等一个人裁决）。本模块把「占用」做成机器
// 可判的登记 + 租约：
//   1. 开工时登记 aspect + 预期文件（不是审批，只是占用声明）；
//   2. 同一 aspect 已有在途占用时，新占用**排队等待**（acquire 的 waitMs），释放条件 =
//      占用方 release / 租约到期 / 存活判据判死；
//   3. 存活判据复用 heartbeats 的 `livenessOf`（host/boot_id/pid/pid_start + 注册表 + TTL），
//      绝不允许「死会话占域 6 小时」再次发生；
//   4. 没有注册表能力的调用方用 TTL-only 租约，状态里显式标 `ttl-only`；
//   5. 不同 aspect 互不阻塞；锁状态可查询（listAspectLocks）。
//
// 存储：.agents/aspect-locks/<aspect>.json（每个 aspect 一个文件，与 tasks/decisions 平级）。
// 写入一律在 store 文件锁内（withLock），读路径不加锁。

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'

import { writeJsonAtomic } from '../atomic.mjs'
import { hostTag } from '../lock.mjs'
import { RECORD_ROOT, assertInitialized, normalizeContract, withLock } from '../store/contract.mjs'
import { resolveProjectRoot } from '../store/git-root.mjs'
import { livenessOf, registryVerdictOf } from '../heartbeats/records.mjs'
import { FlowError, formatIso, isPlainObject, noteWarning, toPosix } from '../util.mjs'

export const ASPECT_LOCK_SCHEMA = 1
/** 默认租约：30 分钟。占用方必须定期 renew（长 turn 用 turn-stopping keepalive 之类）。 */
export const ASPECT_LOCK_DEFAULT_TTL_SECONDS = 30 * 60
/**
 * 排队等待的默认预算：1500ms。
 *
 * 裁定 6 的「自动串行」是**有界等待**：开工入口最多等这么久，等不到就放行并在结果里
 * 标 pending（谁在占、等了多久），绝不让人干等、也不阻断开工。可用插件配置
 * `config.aspectLock.waitMs`（0–300000）覆盖；缺省值只在这里定义一次，调用方不许
 * 再写死数字。
 */
export const ASPECT_LOCK_DEFAULT_WAIT_MS = 1500
const ASPECT_LOCK_WAIT_MAX_MS = 5 * 60 * 1000

/** 从插件配置读排队预算：`config.aspectLock.waitMs`，非法/缺失回落默认 1500ms。 */
export function aspectLockWaitMs(config) {
  const section = isPlainObject(config) && isPlainObject(config.aspectLock) ? config.aspectLock : null
  const value = section !== null && Number.isFinite(section.waitMs) ? section.waitMs : NaN
  if (Number.isFinite(value) && value >= 0) return Math.min(Math.floor(value), ASPECT_LOCK_WAIT_MAX_MS)
  return ASPECT_LOCK_DEFAULT_WAIT_MS
}
/** 排队轮询间隔（毫秒）。 */
const ASPECT_POLL_MS = 100
/** 单次 acquire 最多愿意等的上限；超过这是调用方写错了，不是锁的问题。 */
const ASPECT_WAIT_MAX_MS = 5 * 60 * 1000
const ASPECT_FILE_MAX = 200
const ASPECT_WAITER_MAX = 20
/** 强制释放的审计留痕（force 是越过占用方的动作，必须查得清谁、为什么）。 */
const ASPECT_RELEASE_LOG = 'aspect-release-log.json'
const ASPECT_RELEASE_LOG_MAX = 200
const ASPECT_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

/** aspect 锁目录：.agents/aspect-locks。 */
export function aspectLockDir(root) {
  return join(resolveProjectRoot(root), RECORD_ROOT, 'aspect-locks')
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

function assertAspect(value) {
  const aspect = typeof value === 'string' ? value.trim() : ''
  if (ASPECT_ID_RE.test(aspect) === false) {
    throw new FlowError('usage', 'aspect 名不合法（^[a-z0-9][a-z0-9-]{1,40}$）：' + JSON.stringify(value === undefined ? null : value))
  }
  return aspect
}

function normalizeFiles(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value) === false) throw new FlowError('invalid', 'aspect 的预期文件必须是数组')
  const files = []
  for (const entry of value) {
    let file = typeof entry === 'string' ? toPosix(entry.trim()) : ''
    if (file.startsWith('./')) file = file.slice(2)
    if (file === '') continue
    if (files.includes(file)) continue
    files.push(file)
    if (files.length > ASPECT_FILE_MAX) throw new FlowError('invalid', 'aspect 预期文件过多（max ' + ASPECT_FILE_MAX + '）')
  }
  return files
}

function lockFileOf(dir, aspect) {
  return join(dir, aspect + '.json')
}

function readLockFile(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    noteWarning('aspect-lock-unreadable: ' + toPosix(file) + ': ' + error.message)
    return null
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    noteWarning('aspect-lock-invalid: ' + toPosix(file) + ': ' + error.message)
    return null
  }
  if (isPlainObject(value) === false || value.schema !== ASPECT_LOCK_SCHEMA || typeof value.aspect !== 'string') {
    noteWarning('aspect-lock-invalid: ' + toPosix(file) + ': 形状不合法')
    return null
  }
  return value
}

function recordFiles(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new FlowError('io', 'cannot read ' + toPosix(dir) + ': ' + error.message)
  }
  const records = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const record = readLockFile(join(dir, name))
    if (record !== null) records.push(record)
  }
  records.sort((left, right) => left.aspect.localeCompare(right.aspect))
  return records
}

function ttlOf(owner) {
  return Number.isFinite(owner.ttl_seconds) && owner.ttl_seconds > 0 ? owner.ttl_seconds : ASPECT_LOCK_DEFAULT_TTL_SECONDS
}

/** 一次 renew 之后租约到期的时间（ISO），无法解析时为 null。 */
function leaseExpiresAtOf(owner) {
  const renewed = Date.parse(typeof owner.renewed_at === 'string' ? owner.renewed_at : '')
  const reference = Number.isFinite(renewed) ? renewed : Date.parse(typeof owner.acquired_at === 'string' ? owner.acquired_at : '')
  if (Number.isFinite(reference) === false) return null
  return new Date(reference + ttlOf(owner) * 1000).toISOString()
}

/**
 * 一条 aspect 锁的存活判定（纯函数，无写盘）。
 *
 * 证据顺序：注册表（可选）→ host/boot_id/pid/pid_start（`livenessOf`）→ TTL 租约。
 * - `dead` / `foreign`：占用方确定不在了（或不是本机的），立即释放；
 * - 租约到期：`expired`，立即释放（"停止续期即视为放弃"）；
 * - 其余：`held`（占用方还活着且租约有效）。
 * `evidence: 'ttl-only'` 表示调用方没给注册表探针，可靠性降了一档。
 *
 * @param {object} record 锁文件内容
 * @param {{now?:number, sessionLive?:(s:string)=>boolean|undefined, host?:string, bootId?:string}} [options]
 */
export function aspectLockStateOf(record, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const owner = isPlainObject(record) && isPlainObject(record.owner) ? record.owner : {}
  const leaseExpiresAt = leaseExpiresAtOf(owner)
  const probe = typeof input.sessionLive === 'function' ? input.sessionLive : null
  const host = typeof input.host === 'string' && input.host !== '' ? input.host : hostTag()
  // 判活口径只有一份：注册表负证据（同 host + 本进程 pid 才可判死）就在
  // heartbeats 的 registryVerdictOf 里，这里只把锁的 owner 证据喂进去。
  const registryLive =
    probe === null
      ? undefined
      : registryVerdictOf(
          {
            session: typeof owner.session === 'string' ? owner.session : '',
            host: typeof owner.host === 'string' ? owner.host : '',
            pid: Number.isInteger(owner.pid) ? owner.pid : undefined,
          },
          { sessionLive: probe, host, ownerPid: process.pid },
        )
  const verdict = livenessOf(
    {
      session: typeof owner.session === 'string' ? owner.session : '',
      host: typeof owner.host === 'string' ? owner.host : '',
      boot_id: typeof owner.boot_id === 'string' ? owner.boot_id : '',
      pid: Number.isInteger(owner.pid) ? owner.pid : undefined,
      pid_start: Number.isFinite(owner.pid_start) ? owner.pid_start : undefined,
      updated_at: typeof owner.renewed_at === 'string' ? owner.renewed_at : owner.acquired_at,
    },
    {
      now,
      host,
      ...(typeof input.bootId === 'string' ? { bootId: input.bootId } : {}),
      ...(registryLive === undefined ? {} : { registryLive }),
    },
  )
  const expired = leaseExpiresAt !== null && now > Date.parse(leaseExpiresAt)
  const evidence = probe === null ? 'ttl-only' : verdict.evidence
  let state
  let releasable
  if (verdict.liveness === 'dead' || verdict.liveness === 'foreign') {
    state = verdict.liveness
    releasable = true
  } else if (expired) {
    state = 'expired'
    releasable = true
  } else {
    state = 'held'
    releasable = false
  }
  return {
    aspect: isPlainObject(record) && typeof record.aspect === 'string' ? record.aspect : '',
    state,
    releasable,
    reason: verdict.reason,
    evidence,
    ageSeconds: Number.isFinite(verdict.ageSeconds) ? verdict.ageSeconds : null,
    leaseExpiresAt,
    ttlSeconds: ttlOf(owner),
  }
}

function projectLock(record, options) {
  const owner = isPlainObject(record.owner) ? record.owner : {}
  const state = aspectLockStateOf(record, options)
  return {
    aspect: record.aspect,
    files: Array.isArray(record.files) ? record.files.filter((file) => typeof file === 'string') : [],
    owner: {
      session: typeof owner.session === 'string' ? owner.session : '',
      pid: Number.isInteger(owner.pid) ? owner.pid : null,
      host: typeof owner.host === 'string' ? owner.host : '',
      acquired_at: typeof owner.acquired_at === 'string' ? owner.acquired_at : null,
      renewed_at: typeof owner.renewed_at === 'string' ? owner.renewed_at : null,
      ttl_seconds: ttlOf(owner),
    },
    waiters: Array.isArray(record.waiters) ? record.waiters.slice(0, ASPECT_WAITER_MAX) : [],
    state: state.state,
    releasable: state.releasable,
    reason: state.reason,
    evidence: state.evidence,
    leaseExpiresAt: state.leaseExpiresAt,
    ttlSeconds: state.ttlSeconds,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : null,
  }
}

/**
 * 锁状态查询（只读，不加写锁）。
 *
 * @param {{sessionLive?:(s:string)=>boolean|undefined}} [options] 注入注册表探针时
 *   每条的 evidence/状态按注册表口径判定；不注入则 `ttl-only`。
 */
export function listAspectLocks(root, contract, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const absRoot = resolveProjectRoot(root)
  const dir = aspectLockDir(absRoot)
  const items = recordFiles(dir).map((record) => projectLock(record, input))
  return {
    root: toPosix(absRoot),
    dir: toPosix(relative(absRoot, dir)) || '.',
    items,
    counts: {
      total: items.length,
      held: items.filter((item) => item.state === 'held').length,
      releasable: items.filter((item) => item.releasable === true).length,
    },
  }
}

// ------------------------------------------------------------------ 写 API

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms))

function ownerInput(root, input) {
  const session = typeof input.session === 'string' ? input.session.trim() : ''
  if (session === '') throw new FlowError('usage', 'aspect acquire 需要 session（占用方会话 id）')
  const ttl = Number.isFinite(input.ttlSeconds) && input.ttlSeconds > 0
    ? Math.floor(input.ttlSeconds)
    : ASPECT_LOCK_DEFAULT_TTL_SECONDS
  return {
    session,
    pid: process.pid,
    host: hostTag(),
    acquired_at: formatIso(),
    renewed_at: formatIso(),
    ttl_seconds: ttl,
  }
}

/**
 * 一次同步尝试：拿锁成功返回 {acquired:true, lock}；被活着的占用方挡住返回
 * {acquired:false, holder} 并登记排队者。写盘在 store 锁内。
 */
function tryAcquireOnce(root, contract, aspect, files, session, options) {
  const absRoot = resolveProjectRoot(root)
  const c = normalizeContract(absRoot, contract)
  const dir = aspectLockDir(absRoot)
  const input = isPlainObject(options) ? options : {}
  const file = lockFileOf(dir, aspect)
  return withLock(absRoot, c, () => {
    ensureDir(dir)
    const current = readLockFile(file)
    if (current !== null) {
      const state = aspectLockStateOf(current, input)
      if (state.releasable === false) {
        // 占用方还活着：把自己挂进 waiters（幂等），让面板/CLI 看得见排队。
        const waiters = Array.isArray(current.waiters) ? current.waiters.filter((waiter) => isPlainObject(waiter) && typeof waiter.session === 'string' && waiter.session !== session) : []
        waiters.push({ session, since: formatIso() })
        const next = { ...current, waiters: waiters.slice(-ASPECT_WAITER_MAX), updated_at: formatIso() }
        writeJsonAtomic(file, next)
        return { acquired: false, holder: projectLock(next, input) }
      }
      // 可回收（dead/foreign/expired）：旧的 waiters 保留（除自己），新的接管。
    }
    const waiters = current !== null && Array.isArray(current.waiters)
      ? current.waiters.filter((waiter) => isPlainObject(waiter) && typeof waiter.session === 'string' && waiter.session !== session).slice(-ASPECT_WAITER_MAX)
      : []
    const now = formatIso()
    const record = {
      schema: ASPECT_LOCK_SCHEMA,
      aspect,
      files,
      owner: { ...ownerInput(absRoot, { session, ttlSeconds: input.ttlSeconds }), acquired_at: now, renewed_at: now },
      waiters,
      updated_at: now,
    }
    writeJsonAtomic(file, record)
    return { acquired: true, lock: projectLock(record, input) }
  })
}

/**
 * 占用一个 aspect。同一 aspect 被活着的占用方挡住时**排队等待**（轮询），
 * 等满 waitMs 仍未拿到就返回 {acquired:false, holder}——不抛错，让调用方决定
 * 是继续等、换 aspect 还是升级给人。
 *
 * @param {{aspect:string, files?:string[], session:string, ttlSeconds?:number, waitMs?:number, pollMs?:number, sessionLive?:(s:string)=>boolean|undefined}} input
 * @returns {Promise<{acquired:true, lock:object} | {acquired:false, holder:object|null, waitedMs:number}>}
 */
export async function acquireAspectLock(root, contract, input = {}) {
  const value = isPlainObject(input) ? input : {}
  const absRoot = resolveProjectRoot(root)
  assertInitialized(absRoot)
  const aspect = assertAspect(value.aspect)
  const files = normalizeFiles(value.files)
  const session = typeof value.session === 'string' ? value.session.trim() : ''
  if (session === '') throw new FlowError('usage', 'aspect acquire 需要 session（占用方会话 id）')
  const waitMs = Number.isFinite(value.waitMs) && value.waitMs > 0 ? Math.min(Math.floor(value.waitMs), ASPECT_WAIT_MAX_MS) : 0
  const pollMs = Number.isFinite(value.pollMs) && value.pollMs > 0 ? Math.floor(value.pollMs) : ASPECT_POLL_MS
  const options = {
    ...(typeof value.sessionLive === 'function' ? { sessionLive: value.sessionLive } : {}),
    ...(typeof value.host === 'string' ? { host: value.host } : {}),
    // 租约时长随占用一起落盘（ownerInput 从 options.ttlSeconds 取）。
    ...(Number.isFinite(value.ttlSeconds) && value.ttlSeconds > 0 ? { ttlSeconds: value.ttlSeconds } : {}),
  }
  const started = Date.now()
  for (;;) {
    const result = tryAcquireOnce(absRoot, contract, aspect, files, session, options)
    if (result.acquired === true) return result
    const elapsed = Date.now() - started
    if (waitMs === 0 || elapsed >= waitMs) {
      return { acquired: false, holder: result.holder, waitedMs: elapsed }
    }
    await sleep(Math.min(pollMs, Math.max(1, waitMs - elapsed)))
  }
}

/**
 * 续租（占用方定期调用；停止续期 = 放弃，TTL 到期自动释放）。
 * 只有占用方自己可以续租；锁已不在/已被接管时返回 {renewed:false}。
 */
export function renewAspectLock(root, contract, input = {}) {
  const value = isPlainObject(input) ? input : {}
  const absRoot = resolveProjectRoot(root)
  assertInitialized(absRoot)
  const aspect = assertAspect(value.aspect)
  const session = typeof value.session === 'string' ? value.session.trim() : ''
  if (session === '') throw new FlowError('usage', 'aspect renew 需要 session')
  const c = normalizeContract(absRoot, contract)
  const dir = aspectLockDir(absRoot)
  const file = lockFileOf(dir, aspect)
  return withLock(absRoot, c, () => {
    const current = readLockFile(file)
    if (current === null) return { renewed: false, reason: 'no-lock' }
    if (isPlainObject(current.owner) === false || current.owner.session !== session) {
      return { renewed: false, reason: 'not-owner' }
    }
    const now = formatIso()
    const next = {
      ...current,
      owner: {
        ...current.owner,
        renewed_at: now,
        ...(Number.isFinite(value.ttlSeconds) && value.ttlSeconds > 0 ? { ttl_seconds: Math.floor(value.ttlSeconds) } : {}),
      },
      updated_at: now,
    }
    writeJsonAtomic(file, next)
    return { renewed: true, lock: projectLock(next, value) }
  })
}

/**
 * 释放（占用方提交/放弃）。只有占用方自己能释放；`force:true` 供维护者收死锁。
 * 幂等：锁不在时返回 {released:false}。
 */
/**
 * 释放（占用方提交/放弃）。
 *
 * - 只有占用方自己能释放；`force:true` 是**越过占用方**的维护者动作，必须给出
 *   `reason`，并在释放前把 `{at, aspect, owner, by, reason, forced}` 追加进
 *   `.agents/aspect-release-log.json`（保留最近 200 条）——否则以后查不清是谁、为什么
 *   把别人的占用拿掉了。
 * - 幂等：锁不在时返回 `{released:false}`。
 */
export function releaseAspectLock(root, contract, input = {}) {
  const value = isPlainObject(input) ? input : {}
  const absRoot = resolveProjectRoot(root)
  assertInitialized(absRoot)
  const aspect = assertAspect(value.aspect)
  const session = typeof value.session === 'string' ? value.session.trim() : ''
  const forced = value.force === true
  if (session === '' && forced === false) throw new FlowError('usage', 'aspect release 需要 session（或 force:true）')
  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
  if (forced === true && reason === '') {
    throw new FlowError('usage', '强制释放 aspect ' + aspect + ' 必须给 reason：force 越过占用方，必须留痕')
  }
  const c = normalizeContract(absRoot, contract)
  const dir = aspectLockDir(absRoot)
  const file = lockFileOf(dir, aspect)
  return withLock(absRoot, c, () => {
    const current = readLockFile(file)
    if (current === null) return { released: false, reason: 'no-lock' }
    const owner = isPlainObject(current.owner) ? current.owner : {}
    if (forced === false && owner.session !== session) {
      throw new FlowError('conflict', 'aspect ' + aspect + ' 由会话 ' + String(owner.session || '?') + ' 持有；只有它自己能释放（维护者可用 force:true + reason）')
    }
    if (forced === true) appendAspectReleaseLog(absRoot, {
      at: formatIso(),
      aspect,
      owner: typeof owner.session === 'string' ? owner.session : '',
      ownerPid: Number.isInteger(owner.pid) ? owner.pid : null,
      by: typeof value.by === 'string' && value.by.trim() !== '' ? value.by.trim() : (session === '' ? 'cli' : session),
      reason,
      forced: true,
    })
    try {
      unlinkSync(file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw new FlowError('io', 'cannot remove ' + toPosix(file) + ': ' + error.message)
    }
    return { released: true, aspect, owner: { session: owner.session, pid: owner.pid }, ...(forced ? { forced: true, reason } : {}) }
  })
}

/** 追加一条强制释放审计（保留最近 200 条；文件缺失/损坏时重新开始，不让它挡住释放）。 */
function appendAspectReleaseLog(absRoot, entry) {
  const file = join(absRoot, RECORD_ROOT, ASPECT_RELEASE_LOG)
  let entries = []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (isPlainObject(parsed) && Array.isArray(parsed.entries)) entries = parsed.entries.filter((item) => isPlainObject(item))
  } catch {
    entries = []
  }
  entries.unshift(entry)
  writeJsonAtomic(file, { schema: 1, entries: entries.slice(0, ASPECT_RELEASE_LOG_MAX) })
}

/**
 * 清扫：删掉所有可回收的锁（占用方已死/换机/租约到期），返回清单。
 * 活着的占用方一律保留——清理不替人做决定。
 */
export function sweepAspectLocks(root, contract, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const absRoot = resolveProjectRoot(root)
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const dir = aspectLockDir(absRoot)
  const dryRun = input.dryRun === true
  return withLock(absRoot, c, () => {
    const released = []
    const kept = []
    for (const record of recordFiles(dir)) {
      const state = aspectLockStateOf(record, input)
      if (state.releasable === false) {
        kept.push({ aspect: record.aspect, state: state.state })
        continue
      }
      released.push({ aspect: record.aspect, state: state.state, owner: isPlainObject(record.owner) ? record.owner.session : null })
      if (dryRun === false) {
        try {
          unlinkSync(lockFileOf(dir, record.aspect))
        } catch (error) {
          if (error.code !== 'ENOENT') throw new FlowError('io', 'cannot remove aspect lock ' + record.aspect + ': ' + error.message)
        }
      }
    }
    return { root: toPosix(absRoot), dir: toPosix(relative(absRoot, dir)) || '.', dryRun, released, kept }
  })
}

// ------------------------------------------------- aspect 定义（只读）与任务接入

/**
 * 只读解析项目内的 aspect 定义（`docs/module-domain.json` 的 `aspects`）。
 *
 * ST1 已把 aspect 定义为单一真源；本模块**不建**第二个注册表，只做只读投影。
 * 文档缺失/损坏 → 空表 + warning：没有 aspect 定义时下面所有接入都是 no-op，
 * 不会因为文档问题挡住派工。
 *
 * @returns {{source:string|null, aspects:object}} aspects: id → {id,title,semantics,ownerRole,files}
 */
export function readAspectDefinitions(root) {
  const absRoot = resolveProjectRoot(root)
  const file = join(absRoot, 'docs', 'module-domain.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') noteWarning('aspect-definitions-unreadable: ' + toPosix(file) + ': ' + error.message)
    return { source: null, aspects: {} }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    noteWarning('aspect-definitions-invalid: ' + toPosix(file) + ': ' + error.message)
    return { source: null, aspects: {} }
  }
  const declared = isPlainObject(parsed) && isPlainObject(parsed.aspects) ? parsed.aspects : {}
  const aspects = {}
  for (const [id, def] of Object.entries(declared)) {
    if (isPlainObject(def) === false) continue
    aspects[id] = {
      id,
      title: typeof def.title === 'string' ? def.title : '',
      semantics: typeof def.semantics === 'string' ? def.semantics : '',
      ownerRole: typeof def.ownerRole === 'string' ? def.ownerRole : '',
      files: Array.isArray(def.files) ? def.files.filter((entry) => typeof entry === 'string' && entry.trim() !== '') : [],
    }
  }
  return { source: toPosix(relative(absRoot, file)), aspects }
}

/** 两条路径是否重叠（相等，或其中一条是另一条的目录前缀；两边都接受尾斜杠）。 */
function pathOverlaps(left, right) {
  const a = toPosix(left)
  const b = toPosix(right)
  if (a === '' || b === '') return false
  if (a === b) return true
  const aDir = a.endsWith('/') ? a : a + '/'
  const bDir = b.endsWith('/') ? b : b + '/'
  return a.startsWith(bDir) || b.startsWith(aDir)
}

/**
 * 任务声明的文件域（`task.scope.allow`）覆盖到哪些 aspect（按定义里 files 求交集，
 * 双向前缀匹配）。结果按 aspect id 字典序，保证多 aspect 的获取顺序稳定（防交叉死锁）。
 */
export function aspectsForFiles(definitions, files) {
  const aspects = isPlainObject(definitions) && isPlainObject(definitions.aspects)
    ? definitions.aspects
    : isPlainObject(definitions) ? definitions : {}
  const claims = Array.isArray(files)
    ? files.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => toPosix(entry.trim()))
    : []
  if (claims.length === 0) return []
  const hits = []
  for (const [id, def] of Object.entries(aspects)) {
    if (isPlainObject(def) === false) continue
    const aspectFiles = Array.isArray(def.files) ? def.files.filter((entry) => typeof entry === 'string') : []
    if (aspectFiles.some((aspectFile) => claims.some((claim) => pathOverlaps(claim, aspectFile)))) {
      hits.push({ id, files: aspectFiles })
    }
  }
  hits.sort((left, right) => left.id.localeCompare(right.id))
  return hits
}

/**
 * 派工/开工时按任务文件域获取相关 aspect 的占用（`flow dispatch` / queued-* 放行点）。
 *
 * 语义（裁定 6）：aspect 占用是**自动串行**，不是审批——等不到锁也**不阻断开工**，
 * 只把 pending 的占用方带回结果，让调用方在面板/日志里看得出在等谁，真重叠时再
 * 升级给人。没有 aspect 定义、任务没有 scope.allow、或没有会话 id 时都是 no-op。
 *
 * @param {{task:object, session:string, waitMs?:number, ttlSeconds?:number}} input
 * @returns {Promise<{aspects:string[], acquired:string[], pending:object[], skipped?:string}>}
 */
export async function acquireTaskAspects(root, contract, input = {}) {
  const value = isPlainObject(input) ? input : {}
  const task = isPlainObject(value.task) ? value.task : {}
  const session = typeof value.session === 'string' ? value.session.trim() : ''
  if (session === '') return { aspects: [], acquired: [], pending: [], skipped: 'no-session' }
  const scope = isPlainObject(task.scope) ? task.scope : {}
  const definitions = readAspectDefinitions(root)
  const hits = aspectsForFiles(definitions, Array.isArray(scope.allow) ? scope.allow : [])
  if (hits.length === 0) return { aspects: [], acquired: [], pending: [], skipped: 'no-aspect-overlap' }
  const waitMs = Number.isFinite(value.waitMs) && value.waitMs > 0 ? Math.floor(value.waitMs) : 0
  const acquired = []
  const pending = []
  for (const hit of hits) {
    const result = await acquireAspectLock(root, contract, {
      aspect: hit.id,
      files: hit.files,
      session,
      waitMs,
      ...(Number.isFinite(value.ttlSeconds) && value.ttlSeconds > 0 ? { ttlSeconds: value.ttlSeconds } : {}),
      ...(typeof value.sessionLive === 'function' ? { sessionLive: value.sessionLive } : {}),
    })
    if (result.acquired === true) {
      acquired.push(hit.id)
      continue
    }
    pending.push({
      aspect: hit.id,
      holder: isPlainObject(result.holder) && isPlainObject(result.holder.owner) ? result.holder.owner.session : null,
      waitedMs: Number.isFinite(result.waitedMs) ? result.waitedMs : null,
    })
  }
  return { aspects: hits.map((hit) => hit.id), acquired, pending }
}

/**
 * 占用方放弃（会话结束）时释放它持有的全部 aspect 锁。幂等：没有锁就是空结果。
 * 只释放 owner.session 匹配的锁，绝不碰别人。
 */
export function releaseAspectLocksForSession(root, contract, session) {
  const id = typeof session === 'string' ? session.trim() : ''
  if (id === '') return { released: [] }
  const absRoot = resolveProjectRoot(root)
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const dir = aspectLockDir(absRoot)
  return withLock(absRoot, c, () => {
    const released = []
    for (const record of recordFiles(dir)) {
      const owner = isPlainObject(record.owner) ? record.owner : {}
      if (owner.session !== id) continue
      try {
        unlinkSync(lockFileOf(dir, record.aspect))
        released.push(record.aspect)
      } catch (error) {
        if (error.code !== 'ENOENT') noteWarning('aspect-lock-release-failed: ' + record.aspect + ': ' + error.message)
      }
    }
    return { released }
  })
}
