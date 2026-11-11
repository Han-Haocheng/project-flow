// project-flow — 契约与存储路径（store 模块，2026-11-11 Phase 1）。
//
// 这一层回答两个问题：**这个项目的契约是什么**、**记录写到哪里**。它建立在
// 记录原语（records.mjs）与 git 归一（git-root.mjs）之上，也是锁入口
// （withLock）的唯一定义处——所有写路径都从这里拿 paths + 锁。
//
// 边界：本模块不认识任务/决策/门禁/描述的业务规则；`defaultContract` 只提供
// schema 默认值（含记录目录），目录解析走 paths.mjs 的 containment。core 从
// 这里 import 并重新导出公共 API（loadContract / storePaths / …）。

import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { ensureDir, writeJsonAtomic } from '../atomic.mjs'
import { LOCK_FILE, acquireLock, releaseLock, sweepStaleTemps } from '../lock.mjs'
import { containedDir, containedPath, pathMemoOf } from '../paths.mjs'
import { FlowError, deepClone, invalid, isPlainObject } from '../util.mjs'
import { resolveProjectRoot } from './git-root.mjs'

export const SCHEMA_VERSION = 2
export const STORE_REL = '.agents/flow'
export const RECORD_ROOT = '.agents'
export const CONTRACT_REL = '.agents/flow/flow.json'
export const TASK_ARCHIVE_AFTER_DAYS = 7
export const TASK_ARCHIVE_MAX_DAYS = 3650
export const DAY_MS = 86_400_000

export function defaultContract(root) {
  return {
    schema: SCHEMA_VERSION,
    name: basename(resolve(root)),
    store: { root: STORE_REL },
    experiments: {
      source: 'store',
      dir: '.agents/experiments',
      /** Panel switch only (T-12): default closed; writes/checks keep working. */
      enabled: false,
    },
    tasks: {
      source: 'json',
      dir: '.agents/tasks',
      current: null,
      recentLimit: 6,
      archiveAfterDays: TASK_ARCHIVE_AFTER_DAYS,
      // 没有可执行验收项时的策略：warn（默认）| strict | off
      requireAcceptance: 'warn',
    },
    gates: { dir: '.agents/gates', logs: '.agents/flow/logs' },
    heartbeats: { source: 'json', dir: '.agents/heartbeat', max: 20 },
    decisions: { dir: '.agents/decisions' },
    // Description ledger (CONTRACT §3.7). ⚠ Every member here needs a
    // companion row in `contractShapes()`: `sanitizeContract` reads
    // `defaults.description.<member>` while building the shape table, so a member
    // added here alone is silently never validated, and a shape row added alone
    // throws a `TypeError` on the *first* `storePaths` call of every command.
    // `include`/`exclude` must stay fresh literals — `deepClone` on the fallback
    // is what keeps two contracts from sharing one array instance.
    description: {
      dir: '.agents/description',
      enabled: true,
      enforce: 'auto',
      testGate: 'tests',
      include: ['**/*.mjs', '**/*.js', '**/*.cjs', '**/*.ts', '**/*.tsx', '**/*.jsx', '**/*.py'],
      exclude: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '.dsh/**',
        'test/**',
        '**/*.test.mjs',
        '**/*.spec.mjs',
        '.selftest/**',
        // 本机实验目录（复制整仓做并发/破坏性测试等）：不进描述台账。
        // 只收 `.scratch/**` 这一个惯用名，别顺手加 `.tmp/**` / `.work/**`。
        '.scratch/**',
        '.agents/**',
        'docs/**',
      ],
      render: '',
      minSemanticsChars: 10,
      maxFiles: 2000,
      maxScanBytes: 1048576,
      gitCheck: true,
    },
  }
}

function valueType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function contractShapes(defaults) {
  return [
    ['store', [['root', 'string', defaults.store.root]]],
    ['experiments', [
      ['source', 'string', defaults.experiments.source],
      ['dir', 'string', defaults.experiments.dir],
      ['enabled', 'boolean', defaults.experiments.enabled],
    ]],
    ['tasks', [
      ['source', 'string', defaults.tasks.source],
      ['dir', 'string', defaults.tasks.dir],
      ['current', 'string|null', defaults.tasks.current],
      ['recentLimit', 'number', defaults.tasks.recentLimit],
      ['archiveAfterDays', 'number', defaults.tasks.archiveAfterDays],
      ['requireAcceptance', 'string', defaults.tasks.requireAcceptance],
    ]],
    ['gates', [
      ['dir', 'string', defaults.gates.dir],
      ['logs', 'string', defaults.gates.logs],
    ]],
    ['heartbeats', [
      ['source', 'string', defaults.heartbeats.source],
      ['dir', 'string', defaults.heartbeats.dir],
      ['max', 'number', defaults.heartbeats.max],
    ]],
    ['decisions', [['dir', 'string', defaults.decisions.dir]]],
    // `enforce` stays a plain `string` by design (spec §1): an unknown mode is not a
    // manifest error, it degrades to `auto` in `descriptionEnforce()`.
    ['description', [
      ['dir', 'string', defaults.description.dir],
      ['enabled', 'boolean', defaults.description.enabled],
      ['enforce', 'string', defaults.description.enforce],
      ['testGate', 'string', defaults.description.testGate],
      ['include', 'string[]', defaults.description.include],
      ['exclude', 'string[]', defaults.description.exclude],
      ['render', 'string', defaults.description.render],
      ['minSemanticsChars', 'number', defaults.description.minSemanticsChars],
      ['maxFiles', 'number', defaults.description.maxFiles],
      ['maxScanBytes', 'number', defaults.description.maxScanBytes],
      ['gitCheck', 'boolean', defaults.description.gitCheck],
    ]],
  ]
}

function matchesContractKind(value, kind) {
  if (kind === 'string') return typeof value === 'string'
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (kind === 'boolean') return typeof value === 'boolean'
  if (kind === 'string|null') return value === null || typeof value === 'string'
  // Whole-array check, no partial filtering (spec §1): `[]` is valid, one non-string
  // element rejects the entire array so the fallback is the documented default
  // rather than a surprising "half of your patterns, plus defaults".
  if (kind === 'string[]') return Array.isArray(value) && value.every((item) => typeof item === 'string')
  return false
}

function sanitizeContract(root, raw) {
  const absRoot = resolve(root)
  const defaults = defaultContract(absRoot)
  const issues = []
  if (!isPlainObject(raw)) return { contract: defaults, issues }

  const contract = deepClone(raw)
  const issue = (key, expected, value) => {
    issues.push(`manifest-invalid: ${key}: expected ${expected}, got ${valueType(value)}`)
  }

  if (contract.name !== undefined && (typeof contract.name !== 'string' || contract.name.trim() === '')) {
    issue('name', 'non-empty string', contract.name)
  }
  if (typeof contract.name !== 'string' || contract.name.trim() === '') contract.name = defaults.name

  for (const [section, fields] of contractShapes(defaults)) {
    const value = contract[section]
    // A missing/null section is a normal partial manifest: fill it silently.
    if (value === undefined || value === null) {
      contract[section] = deepClone(defaults[section])
      continue
    }
    if (!isPlainObject(value)) {
      issue(section, 'object', value)
      contract[section] = deepClone(defaults[section])
      continue
    }
    for (const [member, kind, fallback] of fields) {
      if (value[member] === undefined) {
        value[member] = deepClone(fallback)
        continue
      }
      if (matchesContractKind(value[member], kind)) continue
      issue(`${section}.${member}`, kind, value[member])
      value[member] = deepClone(fallback)
    }
  }

  // Empty path strings were always treated as "use the default" downstream;
  // normalize them here so the returned contract is self-consistent.
  if (typeof contract.store.root !== 'string' || contract.store.root.trim() === '') contract.store.root = STORE_REL
  contract.schema = SCHEMA_VERSION
  return { contract, issues }
}

export function normalizeContract(root, contract) {
  return sanitizeContract(root, contract).contract
}

export function loadContract(root) {
  const absRoot = resolveProjectRoot(root)
  const warnings = []
  const file = join(absRoot, CONTRACT_REL)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { contract: defaultContract(absRoot), source: 'defaults', warnings }
    }
    warnings.push(`manifest-invalid: ${CONTRACT_REL}: ${error.message}`)
    return { contract: defaultContract(absRoot), source: 'defaults', warnings }
  }
  if (!isPlainObject(raw)) {
    warnings.push(`manifest-invalid: ${CONTRACT_REL}: not a JSON object`)
    return { contract: defaultContract(absRoot), source: 'defaults', warnings }
  }
  // Sanitize first (type repairs), then keep the historical `schema:` text as-is.
  const { contract, issues } = sanitizeContract(absRoot, raw)
  for (const issue of issues) warnings.push(issue)
  if (raw.schema !== undefined && raw.schema !== SCHEMA_VERSION) {
    warnings.push(`schema: ${raw.schema} (expected ${SCHEMA_VERSION})`)
  }
  return { contract, source: CONTRACT_REL, warnings }
}

export function saveContract(root, contract) {
  const absRoot = resolve(root)
  if (!isPlainObject(contract)) throw invalid('contract must be an object')
  const merged = normalizeContract(absRoot, contract)
  merged.schema = SCHEMA_VERSION
  withLock(absRoot, merged, () => writeJsonAtomic(join(absRoot, CONTRACT_REL), merged))
  return merged
}

export function resolveDir(absRoot, value, label, fallbackName, store, memo) {
  // Record dirs live next to the store, not inside it: `.agents/flow` carries
  // only the contract and the gate logs, while tasks/decisions/gates/experiments/
  // description sit directly under `.agents/` (2026-11-08 layout change).
  const fallback = join(absRoot, RECORD_ROOT, fallbackName)
  if (typeof value !== 'string' || value.trim() === '') return fallback
  return containedDir(absRoot, value, label, fallback, memo)
}

export function storePaths(root, contract, options = {}) {
  const absRoot = resolveProjectRoot(root)
  const memo = pathMemoOf(options)
  const c = normalizeContract(absRoot, contract)
  const storeValue = c.store && typeof c.store.root === 'string' && c.store.root.trim() !== '' ? c.store.root : STORE_REL
  const storeFallback = join(absRoot, STORE_REL)
  // Absolute `store.root` is tolerated only while it still resolves inside the
  // project root; anything else (including `..` and symlink escapes) falls back.
  const store = containedPath(absRoot, storeValue, 'store.root', { allowAbsolute: true, pathMemo: memo }) ?? storeFallback
  return {
    store,
    experiments: resolveDir(absRoot, c.experiments && c.experiments.dir, 'experiments.dir', 'experiments', store, memo),
    tasks: resolveDir(absRoot, c.tasks && c.tasks.dir, 'tasks.dir', 'tasks', store, memo),
    gates: resolveDir(absRoot, c.gates && c.gates.dir, 'gates.dir', 'gates', store, memo),
    logs: resolveDir(absRoot, c.gates && c.gates.logs, 'gates.logs', 'logs', store, memo),
    decisions: resolveDir(absRoot, c.decisions && c.decisions.dir, 'decisions.dir', 'decisions', store, memo),
    // `resolveDir` (not `join(store, …)`) is mandatory here: it gives the root
    // containment, the "a custom store.root carries its stock subdirs along"
    // redirect and the `pathMemo` reuse in one call.
    description: resolveDir(absRoot, c.description && c.description.dir, 'description.dir', 'description', store, memo),
  }
}

export function assertInitialized(root) {
  const absRoot = resolveProjectRoot(root)
  if (!existsSync(join(absRoot, CONTRACT_REL))) {
    throw new FlowError('usage', 'run flow init first (.agents/flow/flow.json is missing)')
  }
}

export function initLockContract(absRoot) {
  try {
    return loadContract(absRoot).contract
  } catch {
    return defaultContract(absRoot)
  }
}

export function withLock(root, contract, fn, options = {}) {
  const paths = storePaths(root, contract)
  ensureDir(paths.store)
  const lockPath = join(paths.store, LOCK_FILE)
  const token = acquireLock(lockPath)
  try {
    // `init` bootstraps an empty store and drives its own directories; it opts
    // out of the stale-temp sweep so the sweep throttle (`lastSweepAt`) is not
    // consumed by an init that has no writers' leftovers to clean.
    if (isPlainObject(options) === false || options.sweep !== false) sweepStaleTemps(paths)
    return fn(paths)
  } finally {
    releaseLock(lockPath, token)
  }
}
