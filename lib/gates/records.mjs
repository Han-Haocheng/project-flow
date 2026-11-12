// project-flow — 门禁域（gates 模块，2026-11-11 Phase 1 拆分）。
//
// 门禁定义、步骤归一、运行记录与运行日志读取。依赖方向：gates → store
// （records/contract）+ runner + util，**不 import core**；core 从这里 import
// 并重新导出公共 API（listGates/getGate/addGate/updateGate/removeGate/runGate…）。

import { unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { pathMemoOf } from '../paths.mjs'
import { writeJsonAtomic } from '../atomic.mjs'
import { EXPECT_SYNTAX_HELP, expectSyntaxKnown, runStep } from '../runner.mjs'
import { FlowError, deepClone, formatIso, invalid, isPlainObject, noteWarning, timeValue, toPosix } from '../util.mjs'
import { assertInitialized, normalizeContract, storePaths, withLock } from '../store/contract.mjs'
import {
  assertPattern, assertSafeId, assertTargetFree, optionalBoolean, optionalEnum, optionalInt,
  optionalText, readCollection, readRecord, requireText, sortByUpdatedDesc, unreadableCollector,
} from '../store/records.mjs'

const GATE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/
const GATE_PHASES = ['commit', 'release', 'manual']
// 门禁分两类（2026-11-12 裁定 3）：结构门禁可挂四层，行为门禁只能挂功能层。
const GATE_KINDS = ['structure', 'behavior']
const GATE_MOUNT_LEVELS = ['layer', 'module', 'feature', 'aspect']
const MOUNT_LEVEL_NEEDS_TARGET = new Set(['module', 'aspect'])
const BEHAVIOR_MOUNT_LEVEL = 'feature'
const DEFAULT_MOUNT_LEVEL = 'feature'
const MOUNT_TARGET_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  if (!GATE_ID_RE.test(slug)) throw invalid(`cannot derive a gate id from ${JSON.stringify(value)}; pass an explicit id`)
  return slug
}

/**
 * 归一挂载点：`{level, target?}`。
 *
 * 四层（裁定 3）：`layer` 层次（整仓横切）/ `module` 模块 / `feature` 功能 /
 * `aspect` 横切关注面。结构门禁四层都能挂；行为门禁只准挂功能层——行为门禁
 * 验证的是「功能被做出来没有」，挂到模块/aspect 上会把「模块有人改过」误当
 * 「功能可用」。module/aspect 必须给出 `target`（挂在哪一个上），否则挂载点不完整。
 */
function normalizeMount(mount) {
  if (mount === undefined || mount === null) return { level: DEFAULT_MOUNT_LEVEL }
  if (!isPlainObject(mount)) throw invalid('mount must be an object like {level, target?}')
  const level = optionalEnum(mount.level, 'mount.level', GATE_MOUNT_LEVELS, DEFAULT_MOUNT_LEVEL)
  const rawTarget = optionalText(mount.target, 'mount.target', '')
  const target = rawTarget.trim()
  if (target !== '' && MOUNT_TARGET_RE.test(target) === false) {
    throw invalid(`mount.target has an invalid format: ${JSON.stringify(target)}（小写字母/数字/连字符）`)
  }
  if (target === '' && MOUNT_LEVEL_NEEDS_TARGET.has(level)) {
    throw invalid(`mount.target is required when mount.level=${level}`)
  }
  return target === '' ? { level } : { level, target }
}

/**
 * 分类 × 挂载点合法性：行为门禁挂非功能层是定义期错误，不是运行期警告。
 * 理由：分类错了不会让门禁红，只会让「结构绿」被当成「功能可用」，静默到上线。
 */
function assertMountLegal(kind, mount) {
  if (kind === 'behavior' && mount.level !== BEHAVIOR_MOUNT_LEVEL) {
    throw invalid(
      `behavior 门禁只能挂在功能层（mount.level=${BEHAVIOR_MOUNT_LEVEL}），` +
        `收到 mount.level=${mount.level}；结构门禁才可挂 layer|module|aspect`,
    )
  }
}

function buildStep(step, index, seen, options = {}, gateKind = 'behavior') {
  const label = `steps[${index}]`
  if (!isPlainObject(step)) throw invalid(`${label} must be an object`)
  const id = step.id === undefined ? `step-${index + 1}` : requireText(step.id, `${label}.id`)
  if (seen.has(id)) throw invalid(`duplicate step id: ${id}`)
  seen.add(id)
  const run = requireText(step.run, `${label}.run`)
  const rawExpect = optionalText(step.expect, `${label}.expect`, 'exit 0')
  const expect = rawExpect.trim() === '' ? 'exit 0' : rawExpect
  // 门禁定义时就把 expect 手误挡下来：未知写法默认直接拒绝（invalid），不再
  // 「警告 + 按 exit 0 放行」——后者会把本该失败的门禁静默变成通过。
  // 只有显式 `--allow-unknown-expect`（或记录上已带 allowUnknownExpect）才容错。
  const unknown = expectSyntaxKnown(expect) === false
  const allowedNow = options.allowUnknownExpect === true
  const alreadyAllowed = step.allowUnknownExpect === true
  if (unknown && !allowedNow && !alreadyAllowed) {
    throw invalid(
      `步骤 ${JSON.stringify(id)} 的 expect ${JSON.stringify(expect)} 无法识别；合法写法：${EXPECT_SYNTAX_HELP}。` +
        '若确实需要容错，请显式开启容错（CLI `--allow-unknown-expect` / flow_gate `allowUnknownExpect: true`；' +
        '此时该步会按 exit 0 放行并保留警告）。',
    )
  }
  if (unknown && allowedNow) {
    noteWarning(
      `gate-expect-unknown: 步骤 ${JSON.stringify(id)} 的 expect ${JSON.stringify(expect)} 无法识别，` +
        '已按 --allow-unknown-expect 放行（该步按 exit 0 判定）',
    )
  }
  const timeoutSeconds = optionalInt(step.timeoutSeconds, `${label}.timeoutSeconds`, 600, 1)
  // 单步可覆盖门禁的分类（同一条链里允许结构步骤与行为步骤并存），默认继承。
  const kind = optionalEnum(step.kind, `${label}.kind`, GATE_KINDS, gateKind)
  const record = { ...deepClone(step), id, run, expect: expect.trim(), timeoutSeconds, kind }
  if (unknown && (allowedNow || alreadyAllowed)) record.allowUnknownExpect = true
  return record
}

function validateGateFields(record, options = {}) {
  assertPattern(record.id, GATE_ID_RE, 'gate id')
  record.title = requireText(record.title, 'title')
  record.phase = optionalEnum(record.phase, 'phase', GATE_PHASES, 'manual')
  record.enabled = optionalBoolean(record.enabled, 'enabled', true)
  record.kind = optionalEnum(record.kind, 'kind', GATE_KINDS, 'behavior')
  record.mount = normalizeMount(record.mount)
  assertMountLegal(record.kind, record.mount)
  // 默认不再「首败即停」：结构失败必须能看见后面的行为结果（裁定 3）。
  record.failFast = optionalBoolean(record.failFast, 'failFast', false)
  if (!Array.isArray(record.steps)) throw invalid('steps must be an array')
  const seen = new Set()
  record.steps = record.steps.map((step, index) => buildStep(step, index, seen, options, record.kind))
  return record
}

export function buildGate(input, ctx, options = {}) {
  if (!isPlainObject(input)) throw invalid('gate must be an object')
  const record = deepClone(input)
  record.schema = 1
  if (input.id === undefined) {
    record.id = slugify(requireText(input.title, 'title'))
  } else {
    assertPattern(input.id, GATE_ID_RE, 'gate id')
    record.id = input.id
  }
  if (ctx.existingIds.has(record.id)) throw new FlowError('conflict', `gate ${record.id} already exists`)
  if (record.steps === undefined) record.steps = []
  validateGateFields(record, options)
  const now = formatIso()
  record.created_at = typeof input.created_at === 'string' ? input.created_at : now
  record.updated_at = typeof input.updated_at === 'string' ? input.updated_at : now
  return record
}

function applyGatePatch(record, patch, options = {}) {
  if (!isPlainObject(patch)) throw invalid('gate patch must be an object')
  for (const key of ['id', 'schema', 'created_at']) {
    if (Object.hasOwn(patch, key)) throw invalid(`gate ${key} cannot be changed`)
  }
  const next = { ...record }
  for (const [key, value] of Object.entries(deepClone(patch))) next[key] = value
  next.id = record.id
  next.schema = 1
  next.created_at = record.created_at
  validateGateFields(next, options)
  next.updated_at = formatIso()
  return next
}

export function gateIds(paths) {
  const ids = new Set()
  for (const item of readCollection(paths.gates)) {
    ids.add(typeof item.record.id === 'string' ? item.record.id : item.name.slice(0, -5))
  }
  return ids
}

export function listGates(root, contract, options = {}) {
  const memo = pathMemoOf(options)
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c, { pathMemo: memo })
  return sortByUpdatedDesc(readCollection(paths.gates, unreadableCollector(options)).map((item) => item.record))
}

export function getGate(root, contract, id) {
  const c = normalizeContract(root, contract)
  return readRecord(storePaths(root, c).gates, id, 'gate')
}

export function addGate(root, contract, input, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const record = buildGate(input, { existingIds: gateIds(paths) }, options)
    assertTargetFree(paths.gates, record.id)
    writeJsonAtomic(join(paths.gates, `${record.id}.json`), record)
    return record
  })
}

export function updateGate(root, contract, id, patch, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const current = readRecord(paths.gates, id, 'gate')
    const next = applyGatePatch(current, patch, options)
    writeJsonAtomic(join(paths.gates, `${next.id}.json`), next)
    return next
  })
}

export function removeGate(root, contract, id) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  return withLock(root, c, (paths) => {
    const file = join(paths.gates, `${assertSafeId(id)}.json`)
    try {
      unlinkSync(file)
    } catch (error) {
      if (error.code === 'ENOENT') throw new FlowError('not-found', `gate ${id} not found`)
      throw new FlowError('io', `cannot remove ${toPosix(file)}: ${error.message}`)
    }
    return { id, removed: true }
  })
}

function isoFileStamp(date) {
  return formatIso(date).replace(/:/g, '-').replace(/\./g, '-')
}

function emptySegment(kind) {
  return { kind, total: 0, passed: 0, failed: 0, ok: true, steps: [] }
}

/**
 * 分类聚合：结构/行为各自算成败。用**已执行**的步骤计数（failFast 下没跑到的步
 * 不计入 —— 把「没跑」算成「通过」就是假绿）。
 */
export function summarizeSegments(results, steps) {
  const segments = { structure: emptySegment('structure'), behavior: emptySegment('behavior') }
  const byId = new Map()
  for (const step of Array.isArray(steps) ? steps : []) byId.set(step.id, step)
  for (const result of Array.isArray(results) ? results : []) {
    const step = byId.get(result.id)
    const kind = step !== undefined && GATE_KINDS.includes(step.kind) ? step.kind : 'behavior'
    const segment = segments[kind]
    segment.total += 1
    segment.steps.push(result.id)
    if (result.ok === true) segment.passed += 1
    else {
      segment.failed += 1
      segment.ok = false
    }
  }
  return segments
}

function gateKindOf(gate) {
  return GATE_KINDS.includes(gate?.kind) ? gate.kind : 'behavior'
}

function stepKindOf(step, gateKind) {
  return GATE_KINDS.includes(step?.kind) ? step.kind : gateKind
}

/** 失败按分类给出可读标签：结构问题 / 行为问题（人类输出与 hint 共用）。 */
export function segmentLabel(kind) {
  return kind === 'structure' ? '结构问题' : '行为问题'
}

export async function runGate(root, contract, id, options = {}) {
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c)
  const gate = readRecord(paths.gates, id, 'gate')
  if (gate.enabled === false && options.force !== true) {
    throw new FlowError('usage', `gate ${id} is disabled; pass --force to run it`)
  }
  const kind = gateKindOf(gate)
  const failFast = typeof options.failFast === 'boolean' ? options.failFast : gate.failFast === true
  const steps = Array.isArray(gate.steps) ? gate.steps : []
  const tailLines = Number.isFinite(options.tailLines) && options.tailLines > 0 ? Math.floor(options.tailLines) : 40
  const override = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : null
  const startedAt = new Date()
  const results = []
  let ok = true
  for (const step of steps) {
    const perStep = Number.isInteger(step.timeoutSeconds) && step.timeoutSeconds > 0 ? step.timeoutSeconds : 600
    const timeoutMs = override !== null ? override : perStep * 1000
    const result = await runStep(root, step, timeoutMs, tailLines)
    results.push({ ...result, kind: stepKindOf(step, kind) })
    if (result.ok !== true) {
      ok = false
      // 默认分段执行：结构红了仍然把行为步骤跑完；failFast 才回到首败即停。
      if (failFast) break
    }
  }
  const finishedAt = new Date()
  const record = {
    gate: gate.id,
    title: gate.title,
    kind,
    mount: gate.mount === undefined ? { level: DEFAULT_MOUNT_LEVEL } : gate.mount,
    failFast,
    started_at: formatIso(startedAt),
    finished_at: formatIso(finishedAt),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok,
    segments: summarizeSegments(results, steps),
    steps: results,
  }
  const logDir = join(paths.logs, gate.id)
  withLock(root, c, () => writeJsonAtomic(join(logDir, `${isoFileStamp(startedAt)}.json`), record))
  return record
}

export async function runGatesByPhase(root, contract, phase, options = {}) {
  if (!GATE_PHASES.includes(phase)) throw invalid(`phase must be one of ${GATE_PHASES.join(', ')}`)
  assertInitialized(root)
  const c = normalizeContract(root, contract)
  const opts = isPlainObject(options) ? options : {}
  const force = opts.force === true
  const passThrough = { force }
  if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) passThrough.timeoutMs = Math.floor(opts.timeoutMs)
  if (Number.isFinite(opts.tailLines) && opts.tailLines > 0) passThrough.tailLines = Math.floor(opts.tailLines)
  if (typeof opts.failFast === 'boolean') passThrough.failFast = opts.failFast

  // 分类顺序：先跑结构门禁，再跑行为门禁。结构失败不阻断行为门禁的执行
  // （批量运行本来就不首败即停；分类只决定顺序与结果呈现）。
  const kindOrder = (gate) => (gateKindOf(gate) === 'structure' ? 0 : 1)
  const gates = listGates(root, c)
    .filter((gate) => gate.phase === phase)
    .sort((left, right) => kindOrder(left) - kindOrder(right) || String(left.id).localeCompare(String(right.id)))

  const runs = []
  const skipped = []
  for (const gate of gates) {
    // A disabled gate is skipped even with force: batch runs follow the switch.
    if (gate.enabled === false) {
      skipped.push({ id: gate.id, reason: 'disabled' })
      continue
    }
    try {
      runs.push(await runGate(root, c, gate.id, passThrough))
    } catch (error) {
      if (!(error instanceof FlowError)) throw error
      runs.push({
        gate: gate.id,
        title: gate.title,
        kind: gateKindOf(gate),
        ok: false,
        steps: [],
        segments: summarizeSegments([], []),
        error: { code: error.code, message: error.message },
      })
    }
  }
  const segments = { structure: { gates: 0, failed: [], ok: true }, behavior: { gates: 0, failed: [], ok: true } }
  for (const run of runs) {
    const kind = GATE_KINDS.includes(run.kind) ? run.kind : 'behavior'
    segments[kind].gates += 1
    if (run.ok !== true) {
      segments[kind].ok = false
      segments[kind].failed.push(run.gate)
    }
  }
  return { phase, runs, skipped, segments }
}

export function listGateRuns(root, contract, gateId, limit = 5, options = {}) {
  const memo = pathMemoOf(options)
  const c = normalizeContract(root, contract)
  const paths = storePaths(root, c, { pathMemo: memo })
  assertSafeId(gateId, 'gate id')
  const items = readCollection(join(paths.logs, gateId))
  items.sort((left, right) => timeValue(right.record.started_at) - timeValue(left.record.started_at))
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 5
  return items.slice(0, size).map((item) => item.record)
}
