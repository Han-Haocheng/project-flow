// project-flow — 描述台账域（description 模块，2026-11-11 Phase 1 拆分）。
//
// 描述台账（CONTRACT §3.7）的锁内编排与读路径：build/set/plan/apply 在 `withLock`
// 内落盘；project/files/plan/status/render/check 无锁只读。纯计算（源文件扫描、
// 计划归一、记录对账、Markdown 渲染）仍留在 `lib/desc.mjs`，本模块只做"模型层不能
// 做的事"：锁作用域、契约节归一、阶段门适配。
//
// 依赖方向：description → desc + store（records/contract/git-root）+ util + atomic
// + paths + tasks + gates，**不 import core**。与任务/门禁的耦合都是单向读：计划
// 读写校验任务阶段（`getTask`/`projectTaskStage`），`checkDescription` 的测试证据
// 取门禁运行记录（`listGateRuns`）。反向的 tasks → description 由 core 装配时注入
// （`configureTasks({ descriptionGate })`），因此不成环。
//
// 阶段门单独放在同域 `./gate.mjs`。为了让那个适配器复用同一份实现（而不是复制
// 判定逻辑），本文件额外导出下列内部件——它们**不经 core 对外 re-export**，公共
// API 不变：
//   `DESCRIPTION_GATE_STAGES`、`descriptionConfigOf`、`descriptionEnforce`、
//   `descriptionFilesAt`、`descriptionIssue`、`descriptionPaths`、`readJsonRecord`。

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { writeJsonAtomic } from '../atomic.mjs'
import { pathMemoOf } from '../paths.mjs'
import { FlowError, formatIso, invalid, isPlainObject, noteWarning, toPosix } from '../util.mjs'
import { assertInitialized, normalizeContract, storePaths, withLock } from '../store/contract.mjs'
import { assertSafeId, readCollection } from '../store/records.mjs'
import { gitProbe } from '../store/git-root.mjs'
import { listGateRuns } from '../gates/records.mjs'
import { getTask, projectTaskStage } from '../tasks/records.mjs'
import * as desc from '../desc.mjs'

//
// The description ledger (CONTRACT §3.7). Everything computable without
// touching the store lives in `lib/desc.mjs`; this module owns the three things
// the model layer must not do:
//   1. lock-scoped orchestration of the write paths (`withLock` + `writeJsonAtomic`);
//   2. contract/section normalization (paths, enforce mode, thresholds);
//   3. the shared read/check + issue surface the stage gate (`./gate.mjs`) reuses.
// Every read path — `readDescriptionProject`, `listDescriptionFiles`,
// `getDescriptionFile`, `getDescriptionPlan`, `descriptionStatus`,
// `checkDescription`, `renderDescription` — is lock-free and writes nothing. A read
// that grabbed the write lock would turn a transient `archive-locked` conflict
// into a false red, and `check description` runs inside a seeded precommit gate.

export const DESCRIPTION_SCHEMA = 1
export const DESCRIPTION_ENFORCE_MODES = Object.freeze(['auto', 'on', 'off'])

const DESCRIPTION_MIN_SEMANTICS = 10
const DESCRIPTION_MAX_SCAN_BYTES = 1024 * 1024

/** Stages whose transition runs the description gate (spec §7 table). */
export const DESCRIPTION_GATE_STAGES = Object.freeze(['queued-implementation', 'queued-review', 'done'])
/** Stages that may create or amend a semantic-change plan (spec §2.3). */
const DESCRIPTION_PLAN_STAGES = Object.freeze(['queued-analysis', 'analyzing', 'implementing'])

/** The `description` section, tolerating either a whole contract or just the section. */
export function descriptionConfigOf(contract) {
  if (!isPlainObject(contract)) return {}
  return isPlainObject(contract.description) ? contract.description : contract
}

/** `minSemanticsChars`, repaired to the schema default when unusable. */
function descriptionMinSemantics(config) {
  const number = Number(config.minSemanticsChars)
  return Number.isInteger(number) && number > 0 ? number : DESCRIPTION_MIN_SEMANTICS
}

/** `maxScanBytes`, repaired to the schema default when unusable. */
function descriptionMaxScanBytes(config) {
  const number = Number(config.maxScanBytes)
  return Number.isInteger(number) && number > 0 ? number : DESCRIPTION_MAX_SCAN_BYTES
}

/**
 * `enforce` normalized to one of the three modes. An unknown value degrades to
 * `auto` with a warning instead of failing: `enforce` is deliberately typed
 * `string` at the contract layer (spec §1), so a typo must not take the ledger
 * down.
 */
export function descriptionEnforce(config) {
  const value = typeof config.enforce === 'string' ? config.enforce.trim() : ''
  if (DESCRIPTION_ENFORCE_MODES.includes(value)) return value
  if (value !== '') {
    noteWarning(`description-enforce-invalid: ${value} (expected ${DESCRIPTION_ENFORCE_MODES.join('|')}); using auto`)
  }
  return 'auto'
}

/** Relative POSIX path or `null`; never throws (records may carry junk). */
function safeRelativePath(value) {
  try {
    return desc.normalizeSourcePath(value)
  } catch {
    return null
  }
}

/** `now` option of the write paths: `Date` / ISO / epoch → local ISO seconds. */
function descriptionNow(value) {
  if (value === undefined || value === null) return formatIso()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? formatIso(date) : formatIso()
}

/** Absolute layout of the ledger under an already-resolved store directory. */
function descriptionLayoutOf(dir) {
  return { dir, project: join(dir, 'project.json'), files: join(dir, 'files'), tasks: join(dir, 'tasks') }
}

/** Same layout, resolved from the contract (read paths take no lock). */
export function descriptionPaths(root, contract, options = {}) {
  return descriptionLayoutOf(storePaths(root, contract, options).description)
}

/** One JSON record: `null` when absent or damaged (a damaged file is a warning). */
export function readJsonRecord(file, label) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    noteWarning(`unreadable: ${toPosix(file)}: ${error.message}`)
    return null
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) throw new Error('record is not a JSON object')
    return parsed
  } catch (error) {
    noteWarning(`unreadable: ${toPosix(file)}: ${error.message} (${label})`)
    return null
  }
}

function compareByPath(left, right) {
  const a = typeof left.path === 'string' ? left.path : ''
  const b = typeof right.path === 'string' ? right.path : ''
  return a < b ? -1 : a > b ? 1 : 0
}

/** File records of the ledger, sorted by `path` (spec §8 returns record arrays). */
export function descriptionFilesAt(dpaths, unreadable) {
  const issues = Array.isArray(unreadable) ? unreadable : undefined
  return readCollection(dpaths.files, issues).map((item) => item.record).sort(compareByPath)
}

/**
 * Stable content revision of the ledger: every record minus its timestamps, sorted
 * by `path`. Deterministic, so two builds over the same content produce the same
 * `revision`, while **any** semantic or structural change bumps it. Timestamps are
 * excluded on purpose: they only move when a record already changed, and keeping
 * them would make the value churn on a rewrite of identical content.
 */
function descriptionRevisionOf(records) {
  const material = records
    .map((record) => {
      const { created_at: _createdAt, updated_at: _updatedAt, ...rest } = record
      return { ...rest, path: typeof rest.path === 'string' ? rest.path : '' }
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return `sha256:${createHash('sha256').update(JSON.stringify(material)).digest('hex')}`
}

/** Count the plan files of the ledger (`tasks/<T-id>.json`). */
function descriptionPlanCount(dpaths) {
  let names
  try {
    names = readdirSync(dpaths.tasks)
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw new FlowError('io', `cannot read ${toPosix(dpaths.tasks)}: ${error.message}`)
  }
  return names.filter((name) => name.toLowerCase().endsWith('.json')).length
}

/**
 * Rewrite `project.json` from the current record set, preserving `semantics` and
 * `name` (the two hand-written facts) and recomputing `revision`/`counts`/stamps.
 * A no-op when the computed record is byte-identical, so `set` on an unchanged
 * ledger does not churn the file.
 */
function writeDescriptionProject(dpaths, contract, absRoot, records, now) {
  const previous = readJsonRecord(dpaths.project, 'description project')
  const summary = desc.summarize(records, { minSemanticsChars: descriptionMinSemantics(descriptionConfigOf(contract)) })
  const next = {
    schema: DESCRIPTION_SCHEMA,
    name:
      previous !== null && typeof previous.name === 'string' && previous.name.trim() !== ''
        ? previous.name.trim()
        : typeof contract.name === 'string' && contract.name.trim() !== ''
          ? contract.name.trim()
          : basename(absRoot),
    semantics: previous !== null && typeof previous.semantics === 'string' ? previous.semantics : '',
    revision: descriptionRevisionOf(records),
    generated_at: now,
    updated_at: now,
    counts: {
      files: summary.files,
      modules: summary.modules,
      described: summary.described,
      missingSemantics: summary.missingSemantics,
    },
  }
  if (previous !== null && JSON.stringify(previous) === JSON.stringify(next)) return next
  writeJsonAtomic(dpaths.project, next)
  return next
}

/**
 * `flow.json` 的 `description` 节（spec §8）。
 * @returns {object|null} `project.json`，不存在或损坏时 `null`（损坏另记 warning）
 */
export function readDescriptionProject(root, contract) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  return readJsonRecord(descriptionPaths(absRoot, c).project, 'description project')
}

/**
 * 文件记录数组，按 `path` 升序。
 * @param {{unreadable?: string[], pathMemo?: Map<string,string|Error>}} [options]
 *   `unreadable` 收集读不出来的绝对路径（计数用），不传则只记 warning
 */
export function listDescriptionFiles(root, contract, options = {}) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const opts = isPlainObject(options) ? options : {}
  const dpaths = descriptionPaths(absRoot, c, { pathMemo: pathMemoOf(opts) })
  return descriptionFilesAt(dpaths, opts.unreadable)
}

/**
 * 一条文件记录（读不到 → `not-found`）。
 * @param {string} value 仓库相对路径
 */
export function getDescriptionFile(root, contract, value) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const relative = desc.normalizeSourcePath(value)
  const dpaths = descriptionPaths(absRoot, c)
  const record = readJsonRecord(join(dpaths.files, `${desc.encodePath(relative)}.json`), 'description file')
  if (record === null) {
    throw new FlowError('not-found', `description file ${relative} not found (run flow desc build first)`)
  }
  return record
}

/**
 * 任务的语义变更计划（spec §2.3），没有则 `null`。
 * @param {string} taskId 任务 id（同时是文件名，需通过安全段校验）
 */
export function getDescriptionPlan(root, contract, taskId) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  assertSafeId(taskId, 'task id')
  const dpaths = descriptionPaths(absRoot, c)
  return readJsonRecord(join(dpaths.tasks, `${taskId}.json`), 'description plan')
}

/**
 * 展示用计数（spec §8）：`{files, modules, missingSemantics, plans, described}`。
 * `missingSemantics` 按**待填单元**计（文件 1 + 每个模块 1），口径与
 * `project.json` 的 `counts` 缓存一致（`desc.summarize` 是唯一实现）。
 */
export function descriptionStatus(root, contract) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const dpaths = descriptionPaths(absRoot, c)
  const min = descriptionMinSemantics(descriptionConfigOf(c))
  const summary = desc.summarize(descriptionFilesAt(dpaths), { minSemanticsChars: min })
  return {
    files: summary.files,
    modules: summary.modules,
    missingSemantics: summary.missingSemantics,
    plans: descriptionPlanCount(dpaths),
    described: summary.described,
  }
}

/**
 * 确定性 Markdown（spec §10）；台账为空（无 project.json 且无记录）时返回 `null`，
 * 让调用方能区分「还没建描述」与「渲染出空文档」。
 * @returns {string|null}
 */
export function renderDescription(root, contract) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const project = readDescriptionProject(absRoot, c)
  const records = descriptionFilesAt(descriptionPaths(absRoot, c))
  if (project === null && records.length === 0) return null
  const view = project ?? { schema: DESCRIPTION_SCHEMA, name: c.name, semantics: '' }
  return desc.renderMarkdown(view, records)
}

/** 检查项 / 跳过提示的统一形状（`failed` 与 `warnings` 同构）。 */
export function descriptionIssue(kind, path, detail, hint, options = {}) {
  const item = {
    kind,
    path: typeof path === 'string' && path !== '' ? path : '.',
    detail: String(detail ?? ''),
    hint: String(hint ?? ''),
    level: options.level === 'fail' ? 'fail' : 'warn',
  }
  if (typeof options.module === 'string' && options.module !== '') item.module = options.module
  return item
}

/**
 * 描述台账漂移检查（spec §6，只读）。
 *
 * `enforce` 决定「没建描述」算不算失败：`auto`（默认）在 store 里已有 ≥1 条文件
 * 记录时才生效，因此所有老项目第一次跑 precommit 的 `description` 步都是绿的；
 * `on` 无条件生效；`off` 与 `description.enabled: false` 一律跳过（`ok:true` +
 * 一条说明性 warning）。跳过不是假绿：`mode` 与 warning 的 `kind` 都写进返回值。
 *
 * @param {{taskId?: string, strict?: boolean, requireTests?: boolean, stage?: string}} [options]
 *   `taskId` 追加 §7 的计划项；`stage` 只用于 `requireTests` 的默认值
 *   （`reviewing` 默认要求测试证据，`done` 由阶段门显式传 `requireTests:true`）
 * @returns {{ok: boolean, mode: string, counts: object, failed: object[], warnings: object[]}}
 */
export function checkDescription(root, contract, options = {}) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const opts = isPlainObject(options) ? options : {}
  const config = descriptionConfigOf(c)
  const min = descriptionMinSemantics(config)
  const maxScanBytes = descriptionMaxScanBytes(config)
  const strict = opts.strict === true
  const mode = descriptionEnforce(config)
  const dpaths = descriptionPaths(absRoot, c)
  const records = descriptionFilesAt(dpaths)
  const summary = desc.summarize(records, { minSemanticsChars: min })

  const finish = (failed, warnings) => ({
    ok: failed.length === 0,
    mode,
    counts: {
      files: summary.files,
      modules: summary.modules,
      missingSemantics: summary.missingSemantics,
      plans: descriptionPlanCount(dpaths),
      described: summary.described,
      failed: failed.length,
      warnings: warnings.length,
    },
    failed,
    warnings,
  })

  // §6 末条：`enforce=auto` 且台账里一条记录都没有 → 跳过（老项目的默认态）。
  if (config.enabled === false) {
    return finish([], [descriptionIssue('description-disabled', '.', 'description.enabled=false，跳过描述检查', '')])
  }
  if (mode === 'auto' && records.length === 0) {
    return finish([], [descriptionIssue('description-skipped', '.', '未建立描述，跳过', 'flow desc build')])
  }

  // 全 include 范围都要扫：`undescribed-file` 靠 scannedMap 的键集合，只扫记录会
  // 让「新加的文件从没被描述」永远报不出来。
  const listed = desc.listSourceFiles(absRoot, c)
  const warnings = []
  for (const warning of listed.warnings) {
    warnings.push(descriptionIssue('scan-warning', '.', warning, '检查 description.include/exclude'))
  }
  const scannedMap = new Map()
  for (const file of listed.files) {
    const scanned = desc.scanSourceAt(absRoot, file.path, { maxScanBytes })
    if (typeof scanned.skipped === 'string') {
      warnings.push(descriptionIssue('scan-skipped', file.path, `扫描跳过：${scanned.skipped}`, 'flow desc build'))
      continue
    }
    scannedMap.set(file.path, scanned)
  }

  const project = readDescriptionProject(absRoot, c)
  const items = desc.checkProject({ project, records, scannedMap }, c, {
    strict,
    root: absRoot,
    minSemanticsChars: min,
  })

  const taskId = typeof opts.taskId === 'string' && opts.taskId !== '' ? opts.taskId : null
  if (taskId !== null) {
    // 不存在的任务按**用法**错报（exit 2）：调用方传错了 id，不能渲染成「检查通过」。
    try {
      getTask(absRoot, c, taskId)
    } catch (error) {
      if (error instanceof FlowError && error.code === 'not-found') {
        throw new FlowError('usage', `task ${taskId} not found (cannot check its description plan)`)
      }
      throw error
    }
    const plan = readJsonRecord(join(dpaths.tasks, `${taskId}.json`), 'description plan')
    const testGate = typeof config.testGate === 'string' ? config.testGate.trim() : ''
    let gateRuns = []
    if (testGate !== '') {
      try {
        gateRuns = listGateRuns(absRoot, c, testGate, 5)
      } catch (error) {
        if (!(error instanceof FlowError)) throw error
        warnings.push(descriptionIssue('test-gate-invalid', '.', `testGate 不可用（${testGate}）：${error.message}`, '修正 description.testGate'))
      }
    }
    const requireTests = opts.requireTests !== undefined ? opts.requireTests === true : opts.stage === 'reviewing'
    items.push(
      ...desc.checkPlan(plan, {
        root: absRoot,
        contract: c,
        records,
        scannedMap,
        project,
        gateRuns,
        requireTests,
        minSemanticsChars: min,
      })
    )
  }

  const failed = []
  for (const item of items) {
    if (item.level === 'warn') warnings.push(item)
    else failed.push(item)
  }
  return finish(failed, warnings)
}

/**
 * `flow desc build`（spec §5）：`listSourceFiles` → `scanSourceAt` → 建/对账记录 →
 * 剪枝 → 重算 `project.json`。`dryRun` 走**完全不加锁**的预演路径，一次盘都不写。
 *
 * @param {{dryRun?: boolean, now?: Date|string|number}} [options]
 * @returns {{created:number, updated:number, unchanged:number, pruned:number, warnings:string[]}}
 */
export function buildDescription(root, contract, options = {}) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const opts = isPlainObject(options) ? options : {}
  const dryRun = opts.dryRun === true
  const now = descriptionNow(opts.now)

  const run = (dpaths) => {
    const config = descriptionConfigOf(c)
    const min = descriptionMinSemantics(config)
    const maxScanBytes = descriptionMaxScanBytes(config)
    const listed = desc.listSourceFiles(absRoot, c)
    const warnings = [...listed.warnings]

    const indexed = new Map()
    for (const record of descriptionFilesAt(dpaths)) {
      const relative = safeRelativePath(record.path)
      if (relative === null) {
        warnings.push(`invalid-record: ${JSON.stringify(record.path)}（path 不合法，已忽略）`)
        continue
      }
      if (!indexed.has(relative)) indexed.set(relative, record)
    }

    let created = 0
    let updated = 0
    let unchanged = 0
    const writes = []
    const keep = new Set()
    for (const file of listed.files) {
      // `keep` before the skip check: a file the scanner refuses (too big, …) must
      // not lose the record that already describes it.
      keep.add(file.path)
      const scanned = desc.scanSourceAt(absRoot, file.path, { maxScanBytes })
      if (typeof scanned.skipped === 'string') {
        warnings.push(`skipped: ${file.path}（${scanned.skipped}）`)
        continue
      }
      const existing = indexed.get(file.path)
      if (existing === undefined) {
        const record = desc.createRecord(scanned, { now })
        indexed.set(file.path, record)
        writes.push(record)
        created += 1
        continue
      }
      const result = desc.reconcileRecord(existing, scanned, { now })
      if (!result.changed) {
        unchanged += 1
        continue
      }
      indexed.set(file.path, result.record)
      writes.push(result.record)
      updated += 1
    }

    const deletes = []
    for (const relative of [...indexed.keys()]) {
      if (keep.has(relative)) continue
      indexed.delete(relative)
      deletes.push(relative)
    }
    const pruned = deletes.length

    const finalRecords = [...indexed.values()].sort(compareByPath)
    const previousProject = readJsonRecord(dpaths.project, 'description project')
    const touched = created + updated + pruned
    const stamp = touched > 0 || previousProject === null
      ? now
      : (typeof previousProject.generated_at === 'string' && previousProject.generated_at !== '' ? previousProject.generated_at : now)
    const updatedAt = touched > 0 || previousProject === null
      ? now
      : (typeof previousProject.updated_at === 'string' && previousProject.updated_at !== '' ? previousProject.updated_at : now)
    const summary = desc.summarize(finalRecords, { minSemanticsChars: min })
    const nextProject = {
      schema: DESCRIPTION_SCHEMA,
      name:
        previousProject !== null && typeof previousProject.name === 'string' && previousProject.name.trim() !== ''
          ? previousProject.name.trim()
          : typeof c.name === 'string' && c.name.trim() !== ''
            ? c.name.trim()
            : basename(absRoot),
      // `semantics` is hand-written; build only ever preserves it.
      semantics: previousProject !== null && typeof previousProject.semantics === 'string' ? previousProject.semantics : '',
      revision: descriptionRevisionOf(finalRecords),
      generated_at: stamp,
      updated_at: updatedAt,
      counts: {
        files: summary.files,
        modules: summary.modules,
        described: summary.described,
        missingSemantics: summary.missingSemantics,
      },
    }

    if (!dryRun) {
      for (const record of writes) {
        writeJsonAtomic(join(dpaths.files, `${desc.encodePath(record.path)}.json`), record)
      }
      for (const relative of deletes) {
        try {
          unlinkSync(join(dpaths.files, `${desc.encodePath(relative)}.json`))
        } catch (error) {
          if (error.code !== 'ENOENT') throw new FlowError('io', `cannot remove ${toPosix(relative)} record: ${error.message}`)
        }
      }
      // "No change, no write": identical project.json keeps its stamps, otherwise
      // every build would dirty the file (and `render --check` would chase it).
      if (previousProject === null || JSON.stringify(previousProject) !== JSON.stringify(nextProject)) {
        writeJsonAtomic(dpaths.project, nextProject)
      }
    }

    return { created, updated, unchanged, pruned, warnings }
  }

  if (dryRun) return run(descriptionPaths(absRoot, c))
  return withLock(absRoot, c, (paths) => run(descriptionLayoutOf(paths.description)))
}

/**
 * `flow desc set`（spec §9）：把单文件补丁（或补丁数组）落进**已存在**的记录。
 *
 * 记录必须已存在——`set` 只写语义与成员归属，不负责发现新文件（那是 build 的
 * 活），所以缺失时报 `invalid` 并提示先 build，而不是悄悄建一条半截记录。
 * 补丁的 `members` 是**整体替换**（`desc.applyFilePatch` 的语义）。
 *
 * @param {object|object[]} patchOrPatches 单补丁或补丁数组（空数组 = no-op）
 * @returns {{records: object[], changed: boolean}} `records` 是**实际写盘**的记录
 */
export function setDescriptionFile(root, contract, patchOrPatches) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const patches = Array.isArray(patchOrPatches) ? patchOrPatches : [patchOrPatches]
  if (patches.length === 0) return { records: [], changed: false }
  const config = descriptionConfigOf(c)
  const min = descriptionMinSemantics(config)
  const maxScanBytes = descriptionMaxScanBytes(config)

  return withLock(absRoot, c, (paths) => {
    const dpaths = descriptionLayoutOf(paths.description)
    const now = formatIso()
    const indexed = new Map()
    for (const record of descriptionFilesAt(dpaths)) {
      const relative = safeRelativePath(record.path)
      if (relative !== null && !indexed.has(relative)) indexed.set(relative, record)
    }

    const written = []
    for (const patch of patches) {
      const normalized = desc.validateFilePatch(patch, { minSemanticsChars: min })
      const relative = normalized.path
      const existing = indexed.get(relative)
      if (existing === undefined) {
        throw invalid(`${relative}: 记录不存在（先跑 flow desc build 建记录，再 flow desc set）`)
      }
      const scanned = desc.scanSourceAt(absRoot, relative, { maxScanBytes })
      if (typeof scanned.skipped === 'string') {
        throw invalid(`${relative}: 无法扫描（${scanned.skipped}），不能写语义`)
      }
      const result = desc.applyFilePatch(existing, normalized, scanned, { now, minSemanticsChars: min })
      if (!result.changed) continue
      indexed.set(relative, result.record)
      written.push(result.record)
    }

    for (const record of written) {
      writeJsonAtomic(join(dpaths.files, `${desc.encodePath(record.path)}.json`), record)
    }
    if (written.length > 0) {
      writeDescriptionProject(dpaths, c, absRoot, [...indexed.values()].sort(compareByPath), now)
    }
    return { records: written, changed: written.length > 0 }
  })
}

/**
 * `flow desc set --project-semantics`（spec §9）：只写 `project.json` 的手写事实
 * `semantics`，其余字段（`name`/`revision`/`counts`/`generated_at`）原样保留，
 * 只把 `updated_at` 刷新到本次写入（`now` 与其它写路径同源，测试可显式注入）。
 *
 * `project.json` 必须已存在：`set` 不负责建台账，那是 `build` 的活——与
 * `setDescriptionFile` 同一条纪律（缺失时报 `invalid` 并提示先 build，而不是
 * 悄悄造一个只有语义、没有记录的 project.json）。
 *
 * @param {{semantics: string, now?: Date|string|number}} input
 * @returns {object} 写盘后的 `project.json`
 */
export function setDescriptionProject(root, contract, input = {}) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  const opts = isPlainObject(input) ? input : {}
  const semantics = typeof opts.semantics === 'string' ? opts.semantics.trim() : ''
  if (semantics === '') {
    throw invalid('project semantics 不能为空（flow desc set --project-semantics <text>）')
  }
  const now = descriptionNow(opts.now)
  return withLock(absRoot, c, (paths) => {
    const dpaths = descriptionLayoutOf(paths.description)
    const project = readJsonRecord(dpaths.project, 'description project')
    if (project === null) {
      throw invalid(`description project.json 不存在（先跑 flow desc build 建台账）`)
    }
    const next = { ...project, semantics, updated_at: now }
    writeJsonAtomic(dpaths.project, next)
    return next
  })
}

/**
 * 把已有计划与本次输入合并成 `normalizePlanInput` 的入参。
 * 已有计划的 `history` 被带上（归一器每次追加一条），`files`/`noSemanticChange`
 * 的一处切换会自动清掉对侧，避免「改成 noSemanticChange 却被旧 files 卡住」。
 */
function mergePlanInput(existing, input) {
  const fresh = isPlainObject(input) ? input : {}
  const merged = isPlainObject(existing) ? { ...existing, ...fresh } : { ...fresh }
  if (isPlainObject(existing)) {
    merged.created_at = typeof existing.created_at === 'string' ? existing.created_at : merged.created_at
    merged.history = Array.isArray(existing.history) ? existing.history : []
    // 冻结的 implemented 计划已在调用点拒绝；重写一律回到 planned。
    merged.status = 'planned'
    merged.implemented_at = null
  }
  if (merged.noSemanticChange === true && fresh.files === undefined) delete merged.files
  if (fresh.files !== undefined && fresh.noSemanticChange === undefined) delete merged.noSemanticChange
  return merged
}

/** include ∧ ¬exclude 的匹配器（计划 base 的 git 干净性检查用）。 */
function descriptionScopeMatcher(contract) {
  const config = descriptionConfigOf(contract)
  const include = desc.globMatcher(Array.isArray(config.include) ? config.include : [])
  const exclude = desc.globMatcher(Array.isArray(config.exclude) ? config.exclude : [])
  return (value) => typeof value === 'string' && value !== '' && include(value) && !exclude(value)
}

/**
 * 计划的 `base`（spec §2.3/§7）：git 可用时要求 include 范围的工作树干净，
 * 并记下当时的 HEAD；脏工作树直接拒绝，否则 `unplanned-change` 事后无法归因。
 * git 不可用 / `gitCheck:false` → `commit:null` + warning（不阻断）。
 */
function planBaseOf(absRoot, contract, now) {
  const config = descriptionConfigOf(contract)
  if (config.gitCheck === false) return { commit: null, clean: true, recorded_at: now }
  const probe = desc.gitProbe(absRoot)
  if (!probe.ok) {
    noteWarning(`description git: 不可用（${probe.reason ?? 'unknown'}），base.commit 记 null`)
    return { commit: null, clean: true, recorded_at: now }
  }
  const changed = desc.gitChangedFiles(absRoot, probe.head, descriptionScopeMatcher(contract))
  if (!changed.ok) {
    noteWarning(`description git: 无法比对工作树（${changed.reason ?? 'unknown'}），base.commit 记 ${probe.head}`)
    return { commit: probe.head, clean: false, recorded_at: now }
  }
  if (changed.files.length > 0) {
    const preview = changed.files.slice(0, 5).map((file) => `${file.path}（${file.status}）`).join('、')
    const more = changed.files.length > 5 ? ` 等 ${changed.files.length} 项` : ''
    throw invalid(`描述范围内有未提交改动，先提交再建计划：${preview}${more}`)
  }
  return { commit: probe.head, clean: true, recorded_at: now }
}

/**
 * `flow desc plan`（spec §2.3/§9）：建/改一个任务的语义变更计划。
 *
 * - 任务必须存在，且 `stage ∈ {queued-analysis, analyzing, implementing}`；
 * - `implemented` 的计划已冻结（apply 之后不能再改，否则代码与语义会漂）；
 * - 冻结的唯一例外：`options.rebase === true` 时只刷新 `base` 与 `updated_at` 并追加一条
 *   `history`，`status` / `implemented_at` / `files` / 语义字段一律不动（`--rebase` 出口）；
 * - 已有计划再次写入 = 修订：追加一条 `history`，`amended:true`。
 *
 * @param {string} taskId 任务 id
 * @param {object} input 计划输入（`files` / `noSemanticChange` / `reason` / …）
 * @param {{rebase?: boolean}} [options] 写路径选项：`rebase` 只对 implemented 计划生效（只刷新 base）
 * @returns {{plan: object, amended: boolean, rebased?: boolean}}
 */
export function setDescriptionPlan(root, contract, taskId, input, options = {}) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  assertSafeId(taskId, 'task id')
  const min = descriptionMinSemantics(descriptionConfigOf(c))

  return withLock(absRoot, c, (paths) => {
    const dpaths = descriptionLayoutOf(paths.description)
    const now = formatIso()
    // 不存在的任务由 getTask 抛 not-found（写入路径的既有契约）。
    const task = getTask(absRoot, c, taskId)
    const stage = projectTaskStage(task).stage
    if (!DESCRIPTION_PLAN_STAGES.includes(stage)) {
      throw invalid(
        `task ${taskId} 在阶段 ${stage} 不能写语义变更计划（只允许 ${DESCRIPTION_PLAN_STAGES.join(' / ')}）`
      )
    }
    const existing = readJsonRecord(join(dpaths.tasks, `${taskId}.json`), 'description plan')
    const opts = isPlainObject(options) ? options : {}
    if (existing !== null && existing.status === 'implemented') {
      if (opts.rebase !== true) {
        throw invalid(
          `计划 ${taskId} 已 implemented（apply 之后冻结）；要改语义请新开任务；只刷新 base 用 flow desc plan ${taskId} --rebase`
        )
      }
      // 冻结例外（CONTRACT §3.7）：base-only 刷新。只动 base/updated_at/history，
      // 语义、status、implemented_at、files 一律保持原样；planBaseOf 的干净性要求不变。
      const base = planBaseOf(absRoot, c, now)
      const previous = isPlainObject(existing.base) && typeof existing.base.commit === 'string' ? existing.base.commit : '(none)'
      const next = typeof base.commit === 'string' ? base.commit : '(none)'
      const plan = {
        ...existing,
        schema: DESCRIPTION_SCHEMA,
        base,
        updated_at: now,
        history: [
          ...(Array.isArray(existing.history) ? existing.history : []),
          { at: now, stage, note: `rebase：base ${previous} → ${next}（只刷新比较基准；语义、状态、implemented_at 不变）` },
        ],
      }
      writeJsonAtomic(join(dpaths.tasks, `${taskId}.json`), plan)
      return { plan, amended: true, rebased: true }
    }
    const base = planBaseOf(absRoot, c, now)
    const plan = desc.normalizePlanInput(mergePlanInput(existing, input), {
      task: taskId,
      now,
      stage,
      base,
      minSemanticsChars: min,
    })
    writeJsonAtomic(join(dpaths.tasks, `${taskId}.json`), plan)
    return { plan, amended: existing !== null }
  })
}

/**
 * `flow desc apply`（spec §7）：把计划语义落进文件记录，然后冻结计划。
 *
 * - 只允许在 `implementing` 阶段（其它阶段报 `invalid`，提示先回实现阶段）；
 * - 记录先写、计划**后**冻结：反过来会让 `checkPlan` 看到 implemented 却读不到
 *   语义，把一个失败变成两个；
 * - 幂等：计划已是 `implemented` 时直接返回 `applied:false`，`implemented_at`
 *   保留首次时间。
 *
 * @param {string} taskId 任务 id
 * @param {{dryRun?: boolean, now?: Date|string|number}} [options]
 * @returns {{plan: object, applied: boolean, warnings: string[]}}
 */
export function applyDescriptionPlan(root, contract, taskId, options = {}) {
  assertInitialized(root)
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  assertSafeId(taskId, 'task id')
  const opts = isPlainObject(options) ? options : {}
  const dryRun = opts.dryRun === true
  const config = descriptionConfigOf(c)
  const min = descriptionMinSemantics(config)
  const maxScanBytes = descriptionMaxScanBytes(config)
  const now = descriptionNow(opts.now)

  const run = (dpaths) => {
    const task = getTask(absRoot, c, taskId)
    const stage = projectTaskStage(task).stage
    if (stage !== 'implementing') {
      throw invalid(`task ${taskId} 在阶段 ${stage} 不能 apply 描述计划（先把任务推进到 implementing）`)
    }
    const plan = readJsonRecord(join(dpaths.tasks, `${taskId}.json`), 'description plan')
    if (plan === null) {
      throw invalid(`task ${taskId} 没有语义变更计划（先 flow desc plan ${taskId} --input <json>）`)
    }
    if (plan.status === 'implemented') return { plan, applied: false, warnings: [] }

    const records = descriptionFilesAt(dpaths)
    const scannedMap = new Map()
    for (const entry of Array.isArray(plan.files) ? plan.files : []) {
      if (!isPlainObject(entry) || entry.op === 'remove') continue
      const relative = safeRelativePath(entry.path)
      if (relative === null) continue
      const scanned = desc.scanSourceAt(absRoot, relative, { maxScanBytes })
      if (typeof scanned.skipped === 'string') throw invalid(`${relative}: 无法扫描（${scanned.skipped}），不能 apply`)
      scannedMap.set(relative, scanned)
    }

    const result = desc.applyPlanToRecords(plan, records, scannedMap, { now, minSemanticsChars: min })
    const nextPlan = {
      ...plan,
      schema: DESCRIPTION_SCHEMA,
      status: 'implemented',
      // 首次 apply 的时间一旦写上就不再改：测试证据的起点依赖它（spec §2.3）。
      implemented_at:
        typeof plan.implemented_at === 'string' && plan.implemented_at !== '' ? plan.implemented_at : now,
      updated_at: now,
      history: Array.isArray(plan.history) ? plan.history : [],
    }

    if (!dryRun) {
      const before = new Map()
      for (const record of records) {
        const relative = safeRelativePath(record.path)
        if (relative !== null) before.set(relative, record)
      }
      const after = new Map()
      for (const record of result.records) {
        const relative = safeRelativePath(record.path)
        if (relative !== null) after.set(relative, record)
      }
      for (const [relative, record] of after) {
        const previous = before.get(relative)
        if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(record)) continue
        writeJsonAtomic(join(dpaths.files, `${desc.encodePath(relative)}.json`), record)
      }
      // 计划里的 `op:remove` 会从记录集里消失：记录文件也要跟着删，否则 build
      // 之前 `getDescriptionFile` 还能读到一条幽灵记录。
      for (const relative of before.keys()) {
        if (after.has(relative)) continue
        try {
          unlinkSync(join(dpaths.files, `${desc.encodePath(relative)}.json`))
        } catch (error) {
          if (error.code !== 'ENOENT') throw new FlowError('io', `cannot remove ${toPosix(relative)} record: ${error.message}`)
        }
      }
      writeJsonAtomic(join(dpaths.tasks, `${taskId}.json`), nextPlan)
      writeDescriptionProject(dpaths, c, absRoot, result.records, now)
    }
    return { plan: nextPlan, applied: true, warnings: [] }
  }

  if (dryRun) return run(descriptionPaths(absRoot, c))
  return withLock(absRoot, c, (paths) => run(descriptionLayoutOf(paths.description)))
}
