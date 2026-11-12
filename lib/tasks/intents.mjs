// project-flow — 台账 intent（saga 式多步写事务）与中断恢复补偿（T-20261112183138-02，2026-11-12）。
//
// 问题：派工这类动作是**多步写**——起子代理 → 写 checkpoint+推进阶段 → 写证据。三步之间
// 崩掉任何一步，台账就不一致：已 spawn 但没有回执（孤儿子代理）、已推进阶段但没写证据。
// 当时只有「文件锁 + 单记录 CAS」：锁只保证**单次**写原子，跨记录的多步动作没有事务、没有补偿。
//
// 这里补的是 saga：
//   1. 动作开始前先落一条 intent（kind / target / 预期步骤 / 会话与宿主证据）；
//   2. 每完成一步在 intent 上打勾（done），全部完成则收口为 done；
//   3. 恢复扫描（宿主会话创建时、CLI 命令入口）找未完成的 intent，按 kind 的补偿器
//      收口：done（补齐了）或 aborted（明确放弃并留痕）；
//   4. 补偿器必须**幂等**（同一 intent 重复恢复不产生副作用）；
//   5. 同一 kind + 同一 target 的在途 intent 互斥（并发第二个直接 conflict）。
//
// 存储：.agents/intents/<id>.json（与 tasks/decisions 平级，.agents/ 已被 git 忽略）。
// 依赖方向：tasks → store/util/atomic/lock；与 records.mjs 不互相 import（records 不知道 intent）。

import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'

import { writeJsonAtomic } from '../atomic.mjs'
import { hostTag } from '../lock.mjs'
import { RECORD_ROOT, assertInitialized, normalizeContract, withLock } from '../store/contract.mjs'
import { resolveProjectRoot } from '../store/git-root.mjs'
import { assertTargetFree, nextId, readCollection } from '../store/records.mjs'
import { FlowError, formatIso, invalid, isPlainObject, noteWarning, toPosix } from '../util.mjs'
import { getTask, updateTask } from './records.mjs'

export const INTENT_SCHEMA = 1
/** intent 的唯一在途状态与两个终态。 */
export const INTENT_STATES = Object.freeze(['open', 'done', 'aborted'])
/** 单步名上限与一条 intent 的步骤数上限（够表达 saga，又不至于写成日志）。 */
const INTENT_STEP_MAX = 40
const INTENT_STEPS_MAX = 12
const INTENT_KIND_MAX = 60
/** 列表/恢复扫描单次最多处理的记录数（目录被写爆时不至于卡死命令）。 */
const INTENT_SCAN_MAX = 500
/** 收口后的 intent 保留天数（审计留痕，之后可用 pruneIntents 清理）。 */
export const INTENT_KEEP_DAYS = 7
const INTENT_ID_RE = /^I-\d{8}-\d{2}$/

/** kind → 补偿器。补偿器由各 kind 的拥有者在模块加载时注册（内建 dispatch）。 */
const COMPENSATORS = new Map()

/**
 * 注册（或覆盖）某类 intent 的补偿器。
 *
 * 补偿器签名：(intent, context) => {state:'done'|'aborted'|'skipped', detail?}
 * - done：不完整状态已被补齐/可安全视为完成；
 * - aborted：明确放弃本次动作并留痕；
 * - skipped：这次无法判定（例如依赖的会话还活着），保持 open 等下次扫描。
 * 必须是幂等的：同一 intent 重复恢复不能重复写台账。
 */
export function configureIntentCompensators(input) {
  if (isPlainObject(input) === false) return
  for (const [kind, fn] of Object.entries(input)) {
    if (typeof fn === 'function') COMPENSATORS.set(kind, fn)
  }
}

/** 当前已注册补偿器的 kind 列表（体检/测试用）。 */
export function intentCompensatorKinds() {
  return [...COMPENSATORS.keys()].sort()
}

// ------------------------------------------------------------------ 路径与读

/** intent 目录：.agents/intents（与其它记录目录平级，不放进 store）。 */
export function intentsDir(root) {
  return join(resolveProjectRoot(root), RECORD_ROOT, 'intents')
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/** 一条磁盘 intent 的最小结构校验；坏记录跳过并发 warning，不炸整次扫描。 */
function looksLikeIntent(record) {
  return (
    isPlainObject(record) &&
    typeof record.id === 'string' &&
    INTENT_ID_RE.test(record.id) &&
    typeof record.kind === 'string' &&
    record.kind.trim() !== '' &&
    INTENT_STATES.includes(record.state)
  )
}

/** 目录里的全部可读 intent（不做状态过滤，按 id 升序）。 */
function readIntentRecords(dir) {
  const records = []
  for (const entry of readCollection(dir, undefined)) {
    if (looksLikeIntent(entry.record)) records.push(entry.record)
    else noteWarning('intent-invalid: ' + toPosix(dir) + ': 形状不合法，已跳过')
  }
  records.sort((left, right) => left.id.localeCompare(right.id))
  return records
}

/** 读投影：磁盘字段 + 派生的进度字段（done/steps 仍是原始数组）。 */
function projectIntent(record) {
  const steps = Array.isArray(record.steps) ? record.steps.filter((step) => typeof step === 'string') : []
  const done = Array.isArray(record.done) ? record.done.filter((step) => typeof step === 'string') : []
  const missing = steps.filter((step) => done.includes(step) === false)
  return {
    schema: record.schema,
    id: record.id,
    kind: record.kind,
    target: isPlainObject(record.target) ? record.target : {},
    steps,
    done,
    missing,
    stepCount: steps.length,
    doneCount: done.length,
    state: record.state,
    session: typeof record.session === 'string' ? record.session : '',
    pid: Number.isInteger(record.pid) ? record.pid : null,
    host: typeof record.host === 'string' ? record.host : '',
    note: typeof record.note === 'string' ? record.note : '',
    data: isPlainObject(record.data) ? record.data : {},
    result: isPlainObject(record.result) ? record.result : null,
    error: record.error === null || record.error === undefined ? null : record.error,
    started_at: typeof record.started_at === 'string' ? record.started_at : null,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : null,
    ended_at: typeof record.ended_at === 'string' ? record.ended_at : null,
  }
}

function assertIntentId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (INTENT_ID_RE.test(id) === false) throw invalid('intent id 不合法：' + JSON.stringify(value === undefined ? null : value))
  return id
}

/** 一条 intent，或 null（不存在 / 形状不合法）。 */
export function readIntent(root, contract, id) {
  const absRoot = resolveProjectRoot(root)
  const intentId = assertIntentId(id)
  const file = join(intentsDir(absRoot), intentId + '.json')
  let record
  try {
    record = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new FlowError('io', 'cannot read ' + toPosix(file) + ': ' + error.message)
  }
  return looksLikeIntent(record) ? projectIntent(record) : null
}

/**
 * intent 列表（默认全部状态，按 updated_at 倒序）。
 *
 * @param {{state?:string, limit?:number}} [options]
 */
export function listIntents(root, contract, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const absRoot = resolveProjectRoot(root)
  const dir = intentsDir(absRoot)
  let records = readIntentRecords(dir)
  const state = typeof input.state === 'string' ? input.state.trim() : ''
  if (state !== '') records = records.filter((record) => record.state === state)
  const items = records
    .map(projectIntent)
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)) || left.id.localeCompare(right.id))
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, INTENT_SCAN_MAX) : INTENT_SCAN_MAX
  return {
    root: toPosix(absRoot),
    dir: toPosix(relative(absRoot, dir)) || '.',
    items: items.slice(0, limit),
    counts: {
      total: records.length,
      open: records.filter((record) => record.state === 'open').length,
      done: records.filter((record) => record.state === 'done').length,
      aborted: records.filter((record) => record.state === 'aborted').length,
    },
  }
}

// ------------------------------------------------------------------ 参数校验

function requireKind(value) {
  const kind = typeof value === 'string' ? value.trim() : ''
  if (kind === '') throw invalid('intent 需要 kind（动作类型，例如 dispatch）')
  if (kind.length > INTENT_KIND_MAX) throw invalid('intent kind 太长（max ' + INTENT_KIND_MAX + '）：' + kind.length)
  return kind
}

function normalizeSteps(value) {
  if (!Array.isArray(value)) throw invalid('intent 需要 steps 数组（预期步骤）')
  if (value.length === 0) throw invalid('intent 的 steps 不能为空')
  if (value.length > INTENT_STEPS_MAX) throw invalid('intent 步骤过多（max ' + INTENT_STEPS_MAX + '）')
  const steps = []
  for (const entry of value) {
    const step = typeof entry === 'string' ? entry.trim() : ''
    if (step === '') throw invalid('intent 的步骤名不能为空')
    if (step.length > INTENT_STEP_MAX) throw invalid('intent 步骤名太长（max ' + INTENT_STEP_MAX + '）：' + step)
    if (steps.includes(step)) throw invalid('intent 步骤重复：' + step)
    steps.push(step)
  }
  return steps
}

/** target 是自由的短对象；只做「可 JSON 化 + 非空对象」的规范化。 */
function normalizeTarget(value) {
  if (value === undefined || value === null) return {}
  if (isPlainObject(value) === false) throw invalid('intent target 必须是对象')
  let json
  try {
    json = JSON.stringify(value)
  } catch (error) {
    throw invalid('intent target 无法序列化：' + error.message)
  }
  if (json.length > 2000) throw invalid('intent target 太大（max 2000 字符）')
  return JSON.parse(json)
}

/** 稳定序列化（键排序），用于「同一 target」的冲突判定。 */
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
  }
  const json = JSON.stringify(value)
  return json === undefined ? 'null' : json
}

function targetKey(kind, target) {
  return kind + '\u0000' + stableJson(target)
}

// ------------------------------------------------------------------ 写 API

/**
 * 开一条 intent（多步写的第一步，**在动作发生之前**调用）。
 *
 * 冲突策略（并发两个 intent 操作同一任务）：同 kind + 同 target 的在途 intent 是同一个
 * 动作的第二份副本，直接 conflict 并点名在途那条；不同 kind 或不同 target（例如同一任务
 * 的两个角色）互不阻塞。确实要并行时传 allowParallel: true——那时调用方必须自己保证
 * 两步之间不互相覆盖。
 *
 * @param {{kind:string, steps:string[], target?:object, session?:string, note?:string, id?:string, allowParallel?:boolean}} input
 */
export function beginIntent(root, contract, input = {}) {
  const value = isPlainObject(input) ? input : {}
  const absRoot = resolveProjectRoot(root)
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const kind = requireKind(value.kind)
  const steps = normalizeSteps(value.steps)
  const target = normalizeTarget(value.target)
  const session = typeof value.session === 'string' ? value.session.trim() : ''
  const note = typeof value.note === 'string' ? value.note.trim() : ''
  const explicitId = value.id === undefined || value.id === null ? '' : assertIntentId(value.id)
  const key = targetKey(kind, target)
  const dir = intentsDir(absRoot)
  return withLock(absRoot, c, () => {
    ensureDir(dir)
    const records = readIntentRecords(dir)
    if (value.allowParallel !== true) {
      const open = records.find((record) => record.state === 'open' && targetKey(record.kind, record.target) === key)
      if (open !== undefined) {
        throw new FlowError(
          'conflict',
          '同一目标已有在途 intent ' + open.id + '（kind=' + kind + '）；先完成或 abort 它再开新的（确需并行传 allowParallel=true）',
        )
      }
    }
    const id = explicitId === '' ? nextId('I', new Set(records.map((record) => record.id))) : explicitId
    assertTargetFree(dir, id)
    const now = formatIso()
    const record = {
      schema: INTENT_SCHEMA,
      id,
      kind,
      target,
      steps,
      done: [],
      state: 'open',
      session,
      pid: process.pid,
      host: hostTag(),
      note,
      data: {},
      result: null,
      error: null,
      started_at: now,
      updated_at: now,
      ended_at: null,
    }
    writeJsonAtomic(join(dir, id + '.json'), record)
    return projectIntent(record)
  })
}

/** 在锁内读一条可写的 open intent；终态是幂等 no-op（返回 null）。 */
function withOpenIntent(root, contract, id, fn) {
  const absRoot = resolveProjectRoot(root)
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const intentId = assertIntentId(id)
  const dir = intentsDir(absRoot)
  return withLock(absRoot, c, () => {
    const file = join(dir, intentId + '.json')
    let current
    try {
      current = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') throw new FlowError('not-found', 'intent ' + intentId + ' 不存在')
      throw new FlowError('io', 'cannot read ' + toPosix(file) + ': ' + error.message)
    }
    if (looksLikeIntent(current) === false) throw new FlowError('io', 'intent ' + intentId + ' 形状不合法，拒绝改写')
    if (current.state !== 'open') return null
    const next = fn(current)
    const stamped = { ...next, updated_at: formatIso() }
    writeJsonAtomic(file, stamped)
    return projectIntent(stamped)
  })
}

/**
 * 给某一步打勾（幂等：重复打勾不重复写；已收口的 intent 是 no-op）。
 *
 * @param {{data?:object}} [options] 额外的恢复线索（例如 spawn 的 childId）
 */
export function recordIntentStep(root, contract, id, step, options = {}) {
  const value = isPlainObject(options) ? options : {}
  const stepName = typeof step === 'string' ? step.trim() : ''
  if (stepName === '') throw invalid('intent step 名不能为空')
  const data = isPlainObject(value.data) ? { ...value.data } : null
  return withOpenIntent(root, contract, id, (current) => {
    const steps = Array.isArray(current.steps) ? current.steps : []
    if (steps.includes(stepName) === false) {
      throw invalid('intent ' + current.id + ' 没有步骤 ' + stepName + '（预期：' + steps.join('、') + '）')
    }
    const done = Array.isArray(current.done) ? current.done.slice() : []
    const nextData = data === null ? current.data : { ...(isPlainObject(current.data) ? current.data : {}), ...data }
    if (done.includes(stepName)) return { ...current, data: nextData }
    done.push(stepName)
    return { ...current, done, data: nextData }
  })
}

/**
 * 收口一条 intent。默认要求所有步骤都已打勾（防止半截状态被静默当成完成）；
 * 恢复补偿确认可以安全视为完成时传 {partial: true} 显式越权。
 */
export function finishIntent(root, contract, id, options = {}) {
  const value = isPlainObject(options) ? options : {}
  return withOpenIntent(root, contract, id, (current) => {
    const steps = Array.isArray(current.steps) ? current.steps : []
    const done = Array.isArray(current.done) ? current.done : []
    const missing = steps.filter((step) => done.includes(step) === false)
    if (missing.length > 0 && value.partial !== true) {
      throw invalid('intent ' + current.id + ' 还有未完成的步骤：' + missing.join('、') + '（确认可安全收口请传 partial=true）')
    }
    const now = formatIso()
    return {
      ...current,
      state: 'done',
      result: isPlainObject(value.result) ? { ...value.result } : current.result,
      ended_at: now,
    }
  })
}

/** 明确放弃一条 intent 并留痕（error 存原因）；已收口则 no-op。 */
export function abortIntent(root, contract, id, options = {}) {
  const value = isPlainObject(options) ? options : {}
  const reason = typeof value.reason === 'string' && value.reason.trim() !== '' ? value.reason.trim() : 'aborted'
  return withOpenIntent(root, contract, id, (current) => ({
    ...current,
    state: 'aborted',
    error: reason,
    ended_at: formatIso(),
  }))
}

// ------------------------------------------------------------------ 恢复补偿

/**
 * 扫描未完成的 intent 并按 kind 补偿（saga recovery）。
 *
 * 幂等：只处理 state === 'open' 的记录，收口后不再进入；同一 intent 重复扫描不会产生
 * 第二份副作用（补偿器自己必须也幂等，见 configureIntentCompensators）。
 *
 * @param {{dryRun?:boolean, compensators?:object, isSessionLive?:(s:string)=>boolean|undefined}} [options]
 * @returns {{scanned:number, applied:boolean, items:object[], counts:object}}
 */
export function recoverIntents(root, contract, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const absRoot = resolveProjectRoot(root)
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const apply = input.dryRun !== true
  const dir = intentsDir(absRoot)
  const records = readIntentRecords(dir).filter((record) => record.state === 'open').slice(0, INTENT_SCAN_MAX)
  const overrides = isPlainObject(input.compensators) ? input.compensators : null
  const items = []
  for (const record of records) {
    const intent = projectIntent(record)
    // 全部步骤都打勾 = 动作其实已完成，只是崩在收口之前：直接补记完成。
    if (intent.missing.length === 0) {
      if (apply) finishIntent(absRoot, c, intent.id, { partial: true, result: { recovered: 'all-steps-done' } })
      items.push({ id: intent.id, kind: intent.kind, action: 'completed', detail: '所有步骤已打勾，补记收口' })
      continue
    }
    const override = overrides !== null && typeof overrides[intent.kind] === 'function' ? overrides[intent.kind] : null
    const compensator = override !== null ? override : COMPENSATORS.get(intent.kind)
    if (typeof compensator !== 'function') {
      items.push({ id: intent.id, kind: intent.kind, action: 'skipped', reason: '没有 kind=' + intent.kind + ' 的补偿器' })
      continue
    }
    let outcome
    try {
      outcome = compensator(intent, { root: absRoot, contract: c, isSessionLive: input.isSessionLive })
    } catch (error) {
      const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error === undefined ? '' : error)
      items.push({ id: intent.id, kind: intent.kind, action: 'failed', error: message })
      continue
    }
    const settled = isPlainObject(outcome) && (outcome.state === 'done' || outcome.state === 'aborted') ? outcome.state : 'skipped'
    const detail = isPlainObject(outcome) && typeof outcome.detail === 'string' ? outcome.detail : ''
    if (settled === 'skipped') {
      items.push({ id: intent.id, kind: intent.kind, action: 'skipped', reason: detail })
      continue
    }
    if (apply) {
      if (settled === 'done') finishIntent(absRoot, c, intent.id, { partial: true, result: { recovered: detail } })
      else abortIntent(absRoot, c, intent.id, { reason: detail === '' ? 'recovered:' + intent.kind : detail })
    }
    items.push({ id: intent.id, kind: intent.kind, action: settled, detail })
  }
  const counts = { completed: 0, done: 0, aborted: 0, skipped: 0, failed: 0 }
  for (const item of items) {
    if (item.action === 'completed') counts.completed += 1
    else if (item.action === 'done') counts.done += 1
    else if (item.action === 'aborted') counts.aborted += 1
    else if (item.action === 'failed') counts.failed += 1
    else counts.skipped += 1
  }
  return { root: toPosix(absRoot), dir: toPosix(relative(absRoot, dir)) || '.', scanned: records.length, applied: apply, items, counts }
}

/**
 * 清理已收口且够旧的 intent（默认 7 天）。dryRun 只报告不删。
 * 在途 intent 永远不删：它是恢复扫描的唯一线索。
 */
export function pruneIntents(root, contract, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const absRoot = resolveProjectRoot(root)
  assertInitialized(absRoot)
  const c = normalizeContract(absRoot, contract)
  const days = Number.isFinite(input.olderThanDays) && input.olderThanDays >= 0 ? input.olderThanDays : INTENT_KEEP_DAYS
  const cutoff = Date.now() - days * 86_400_000
  const dryRun = input.dryRun === true
  const dir = intentsDir(absRoot)
  const removed = []
  const kept = []
  for (const record of readIntentRecords(dir)) {
    if (record.state === 'open') {
      kept.push(record.id)
      continue
    }
    const stamp = Date.parse(typeof record.ended_at === 'string' ? record.ended_at : record.updated_at)
    if (Number.isFinite(stamp) === false || stamp > cutoff) {
      kept.push(record.id)
      continue
    }
    removed.push(record.id)
    if (dryRun === false) {
      try {
        unlinkSync(join(dir, record.id + '.json'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw new FlowError('io', 'cannot remove intent ' + record.id + ': ' + error.message)
      }
    }
  }
  return { root: toPosix(absRoot), dir: toPosix(relative(absRoot, dir)) || '.', days, dryRun, removed, kept }
}

// ------------------------------------------------------------------ 内建补偿器

/**
 * 内建 dispatch 补偿器：派工的 saga 是 spawn → receipt（起子代理 → 写回执+推进阶段）。
 *
 * - spawn 未打勾：子代理根本没起来，台账没动 —— 直接 aborted；
 * - spawn 已打勾、receipt 未打勾：**孤儿子代理**。补偿只做可逆的留痕（往任务 notes
 *   追加一条点火标记），绝不替它推进阶段——推进阶段是派工语义，恢复阶段不能替人做
 *   决定。幂等：notes 里已有同一 childId 的标记就不再写。
 */
export function dispatchIntentCompensator(intent, context = {}) {
  const input = isPlainObject(context) ? context : {}
  const done = Array.isArray(intent.done) ? intent.done : []
  if (done.includes('spawn') === false) {
    return { state: 'aborted', detail: 'spawn 未发生：子代理没起来，台账未动，直接放弃本次派工' }
  }
  const childId = isPlainObject(intent.data) && typeof intent.data.childId === 'string' ? intent.data.childId : ''
  const taskId = isPlainObject(intent.target) && typeof intent.target.task === 'string' ? intent.target.task.trim() : ''
  if (taskId === '') return { state: 'aborted', detail: '已 spawn 但 target 缺 task id，无法留痕（孤儿子代理没有可关联的卡）' }
  const root = typeof input.root === 'string' ? input.root : ''
  const contract = input.contract
  const task = root === '' ? null : getTask(root, contract, taskId)
  if (task === null) return { state: 'aborted', detail: '已 spawn 但任务 ' + taskId + ' 已不存在，孤儿子代理 ' + (childId === '' ? intent.id : childId) }
  const child = childId === '' ? '（无 childId）' : childId
  const marker = 'intent ' + intent.id + '：孤儿派工 ' + child + ' 已起子代理但台账回执缺失，可能仍在运行'
  const notes = typeof task.notes === 'string' ? task.notes : ''
  if (notes.includes(marker)) return { state: 'aborted', detail: '孤儿派工标记已存在，幂等跳过写盘' }
  const next = notes === '' ? marker : notes + '\n' + marker
  updateTask(root, contract, taskId, { notes: next }, { source: 'internal' })
  return { state: 'aborted', detail: '已把孤儿子代理 ' + child + ' 记到任务 ' + taskId + ' notes' }
}

COMPENSATORS.set('dispatch', dispatchIntentCompensator)
