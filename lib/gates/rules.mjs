// project-flow — 规则文件防篡改（2026-11-12 裁定 1：校验和 + 改规则必须留痕）。
//
// 背景：曾有人提议把规则文件（写域真源、契约锚点区段、流程契约开关）移到
// `~/.project-flow` 藏起来防 agent 篡改。Lead 已否决：藏路径 ≠ 权限，还会让台账
// 与项目脱钩。替代方案是**可审计**：给规则文件记校验和基线，改了就丢基线 =
// 门禁红；必须显式留一条带理由的 rule-change 记录才能推进基线。
//
// 监视对象（顺序即输出顺序）：
//   1. `docs/module-domain.json` —— 写域单一真源（全文）；
//   2. `CONTRACT.md` 的锚点区段 —— 区段定义读 module-domain.json 的
//      `sections['CONTRACT.md']`，只对 from..to 之间的正文算校验和（区段外的
//      正常编辑不需要留痕）；
//   3. `<store>/flow.json` —— 流程契约开关（全文；文件不存在时跳过，因为干净
//      克隆里 .agents/ 被 gitignore）。
//
// 基线与 trail 存在 store 根下的 `rule-guard.json`。它在 .agents/ 里、不进
// git——和决策台账同一处境，审计口径是「台账内可查」而不是「git 历史可查」；
// 真正进 git 的是受保护的规则文件本身，改它们必然出现在 diff 里。
//
// 本模块只依赖 store/atomic/util（不 import core），供 CLI 直接调用。

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { writeJsonAtomic } from '../atomic.mjs'
import { FlowError, formatIso, isPlainObject, toPosix } from '../util.mjs'
import { assertInitialized, normalizeContract, storePaths, withLock } from '../store/contract.mjs'
import { requireText } from '../store/records.mjs'

/** 基线与 trail 的文件名（store 根下）。 */
export const RULE_GUARD_FILE = 'rule-guard.json'
/** trail 最多保留条数（老的滚出，防文件无限增长）。 */
export const RULE_TRAIL_LIMIT = 200
/** 一条 rule-change 理由的最短长度：留痕要能独立看懂，不允许「改规则」三个字。 */
export const MIN_REASON_CHARS = 4

/** 监视对象声明（path 相对项目根；optional 的文件缺失时跳过而不是报错）。 */
export const RULE_WATCH = Object.freeze([
  Object.freeze({ path: 'docs/module-domain.json', scope: 'file', label: '写域真源' }),
  Object.freeze({
    path: 'CONTRACT.md',
    scope: 'sections',
    label: '契约锚点区段',
    anchorsFrom: 'docs/module-domain.json',
  }),
  Object.freeze({ path: '.agents/flow/flow.json', scope: 'file', optional: true, label: '流程契约开关' }),
])

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function readTextOrNull(abs) {
  try {
    return readFileSync(abs, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw new FlowError('io', `cannot read rule file ${toPosix(abs)}: ${error?.message || String(error)}`)
  }
}

function loadJsonOrNull(abs) {
  const text = readTextOrNull(abs)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new FlowError('io', `rule file is not valid JSON: ${toPosix(abs)}: ${error?.message || String(error)}`)
  }
}

/**
 * 锚点区段校验和：与 `scripts/module-domain.mjs verify` 用同一套锚点语义
 * （from/to 都是 trim 后全行相等；from 全局唯一；to 全局唯一且必须在 from 之后；
 * to 为 null 表示到文件末尾）。范围含首尾两行。
 *
 * 定位失败不是「跳过」而是 issue：锚点找不到时静默跳过等于给篡改开后门。
 */
function sectionDigests(root, fileName, defs) {
  const abs = join(root, fileName)
  const text = readTextOrNull(abs)
  const issues = []
  if (text === null) {
    return { missing: true, sections: {}, issues, anchors: 0 }
  }
  const lines = text.split(/\r?\n/)
  const sections = {}
  let anchors = 0
  for (const [key, def] of Object.entries(isPlainObject(defs) ? defs : {})) {
    const from = def !== null && typeof def === 'object' && typeof def.from === 'string' ? def.from.trim() : ''
    if (from === '') {
      issues.push({ kind: 'anchor-invalid', path: fileName, section: key, detail: `区段 ${key} 缺 from 锚点` })
      continue
    }
    const starts = []
    lines.forEach((line, index) => {
      if (line.trim() === from) starts.push(index)
    })
    if (starts.length !== 1) {
      issues.push({
        kind: 'anchor-missing',
        path: fileName,
        section: key,
        detail: `from 锚点出现 ${starts.length} 次（必须恰好 1 次）：${JSON.stringify(from)}`,
      })
      continue
    }
    const start = starts[0]
    let end = lines.length - 1
    if (def.to !== null && def.to !== undefined) {
      const to = typeof def.to === 'string' ? def.to.trim() : ''
      const ends = []
      lines.forEach((line, index) => {
        if (line.trim() === to) ends.push(index)
      })
      if (ends.length !== 1) {
        issues.push({
          kind: 'anchor-missing',
          path: fileName,
          section: key,
          detail: `to 锚点出现 ${ends.length} 次（必须恰好 1 次）：${JSON.stringify(to)}`,
        })
        continue
      }
      if (ends[0] <= start) {
        issues.push({
          kind: 'anchor-order',
          path: fileName,
          section: key,
          detail: `to 锚点不在 from 之后（${ends[0]} <= ${start}）`,
        })
        continue
      }
      end = ends[0]
    }
    sections[key] = sha256(lines.slice(start, end + 1).join('\n'))
    anchors += 1
  }
  return { missing: false, sections, issues, anchors }
}

/**
 * 监视对象清单（把 store 内的 flow.json 解析成相对项目根的 POSIX 路径，
 * 这样自定义 store.root 也能被正确监视与展示）。
 */
export function watchedRules(root, contract) {
  const c = normalizeContract(resolve(root), contract)
  const paths = storePaths(resolve(root), c)
  const storeRel = toPosix(relative(resolve(root), paths.store))
  return RULE_WATCH.map((entry) =>
    entry.anchorsFrom === undefined
      ? entry
      : { ...entry, path: entry.path === '.agents/flow/flow.json' ? (storeRel === '' ? 'flow.json' : `${storeRel}/flow.json`) : entry.path },
  )
}

/** `store/rule-guard.json` 的绝对路径。 */
export function ruleGuardPath(root, contract) {
  const c = normalizeContract(resolve(root), contract)
  return join(storePaths(resolve(root), c).store, RULE_GUARD_FILE)
}

/**
 * 现算规则文件快照。
 * @returns {{ok:boolean, files:object, issues:object[], watched:object[]}}
 */
export function snapshotRules(root, contract) {
  const base = resolve(root)
  const c = normalizeContract(base, contract)
  const watched = watchedRules(base, c)
  const files = {}
  const issues = []
  const contractName = 'CONTRACT.md'
  // CONTRACT.md 的区段定义来自 module-domain.json；它坏了就没有可信锚点表。
  let contractDefs = null
  const moduleDomain = watched.find((entry) => entry.path === 'docs/module-domain.json')
  if (moduleDomain !== undefined) {
    try {
      const data = loadJsonOrNull(join(base, 'docs/module-domain.json'))
      if (data !== null && isPlainObject(data.sections) && isPlainObject(data.sections[contractName])) {
        contractDefs = data.sections[contractName]
      } else if (data !== null) {
        issues.push({
          kind: 'section-source-missing',
          path: 'docs/module-domain.json',
          detail: `没有 sections[${JSON.stringify(contractName)}] 区段定义，契约锚点无法校验`,
        })
      }
    } catch (error) {
      if (!(error instanceof FlowError)) throw error
      issues.push({ kind: 'section-source-unreadable', path: 'docs/module-domain.json', detail: error.message })
    }
  }

  for (const entry of watched) {
    const abs = join(base, entry.path)
    if (entry.scope === 'sections') {
      if (contractDefs === null) continue
      const result = sectionDigests(base, entry.path, contractDefs)
      issues.push(...result.issues)
      if (result.missing === true) {
        issues.push({ kind: 'rule-file-missing', path: entry.path, detail: '受保护的规则文件不存在' })
        continue
      }
      files[entry.path] = { scope: 'sections', sections: result.sections, anchors: result.anchors }
      continue
    }
    const text = readTextOrNull(abs)
    if (text === null) {
      if (entry.optional === true) continue
      issues.push({ kind: 'rule-file-missing', path: entry.path, detail: '受保护的规则文件不存在' })
      continue
    }
    files[entry.path] = { scope: 'file', sha256: sha256(text) }
  }
  return { ok: issues.length === 0, files, issues, watched }
}

/** 读基线记录；不存在返回 null。 */
export function readRuleGuard(root, contract) {
  const abs = ruleGuardPath(root, contract)
  const data = loadJsonOrNull(abs)
  if (data === null) return null
  if (!isPlainObject(data) || !isPlainObject(data.baseline)) {
    throw new FlowError('io', `rule guard record is malformed: ${toPosix(abs)}`)
  }
  return data
}

/**
 * 逐路径 diff：返回 [{path, scope, unit, key?, from, to}]。
 * `ignorePaths` 是 optional 监视对象（缺失不算篡改，例如干净克隆里没有 flow.json）。
 */
export function diffRuleSnapshot(baselineFiles, currentFiles, ignorePaths = []) {
  const base = isPlainObject(baselineFiles) ? baselineFiles : {}
  const current = isPlainObject(currentFiles) ? currentFiles : {}
  const ignored = new Set(Array.isArray(ignorePaths) ? ignorePaths : [])
  const diffs = []
  const paths = [...new Set([...Object.keys(current), ...Object.keys(base)])].sort()
  for (const path of paths) {
    const before = base[path]
    const after = current[path]
    if (!isPlainObject(before) || !isPlainObject(after)) {
      if ((before === undefined || after === undefined) && ignored.has(path)) continue
      diffs.push({ path, scope: after?.scope ?? before?.scope ?? 'file', unit: 'file', from: before?.sha256 ?? null, to: after?.sha256 ?? null })
      continue
    }
    if (after.scope === 'sections') {
      const beforeSections = isPlainObject(before.sections) ? before.sections : {}
      const afterSections = isPlainObject(after.sections) ? after.sections : {}
      for (const key of [...new Set([...Object.keys(beforeSections), ...Object.keys(afterSections)])].sort()) {
        if (beforeSections[key] !== afterSections[key]) {
          diffs.push({
            path,
            scope: 'sections',
            unit: 'section',
            key,
            from: beforeSections[key] ?? null,
            to: afterSections[key] ?? null,
          })
        }
      }
      continue
    }
    if (before.sha256 !== after.sha256) {
      diffs.push({ path, scope: 'file', unit: 'file', from: before.sha256 ?? null, to: after.sha256 ?? null })
    }
  }
  return diffs
}

/** 当前快照里没有出现的 optional 监视对象路径（diff 时忽略它们的缺失）。 */
function optionalRulePaths(snapshot) {
  const present = new Set(Object.keys(snapshot.files ?? {}))
  return (snapshot.watched ?? []).filter((entry) => entry.optional === true && !present.has(entry.path)).map((entry) => entry.path)
}

function formatDiffs(diffs) {
  return diffs
    .map((diff) =>
      diff.unit === 'section'
        ? `${diff.path}#${diff.key}（${String(diff.from ?? '无').slice(0, 12)} → ${String(diff.to ?? '无').slice(0, 12)}）`
        : `${diff.path}（${String(diff.from ?? '无').slice(0, 12)} → ${String(diff.to ?? '无').slice(0, 12)}）`,
    )
    .join('；')
}

/** 建立初始基线；已存在基线时拒绝（改规则必须走 record 留痕）。 */
export function initRules(root, contract, options = {}) {
  const base = resolve(root)
  assertInitialized(base)
  const c = normalizeContract(base, contract)
  const snapshot = snapshotRules(base, c)
  if (snapshot.ok !== true) {
    throw new FlowError('invalid', `规则文件当前状态无法建立基线：${snapshot.issues.map((item) => item.detail).join('；')}`)
  }
  const by = typeof options.by === 'string' && options.by.trim() !== '' ? options.by.trim() : 'agent'
  const reason =
    typeof options.reason === 'string' && options.reason.trim() !== ''
      ? options.reason.trim()
      : '初始化规则文件校验和基线'
  return withLock(base, c, () => {
    const abs = ruleGuardPath(base, c)
    const existing = readRuleGuard(base, c)
    if (existing !== null) {
      throw new FlowError('conflict', `规则基线已存在（${toPosix(abs)}）；改规则请用 flow gate rules record --reason "..." 留痕`)
    }
    const now = formatIso()
    const record = {
      schema: 1,
      created_at: now,
      updated_at: now,
      initialized_by: by,
      initialized_reason: reason,
      baseline: { at: now, files: snapshot.files },
      trail: [],
    }
    writeJsonAtomic(abs, record)
    return { guard: record, baselineAt: now, files: Object.keys(snapshot.files) }
  })
}

/**
 * 显式留痕并推进基线。理由必填；没有实际变化时返回 changed:false（不写盘）。
 */
export function recordRuleChange(root, contract, options = {}) {
  const base = resolve(root)
  assertInitialized(base)
  const c = normalizeContract(base, contract)
  const reason = requireText(options.reason, 'reason').trim()
  if (reason.length < MIN_REASON_CHARS) {
    throw new FlowError('usage', `reason 至少 ${MIN_REASON_CHARS} 个字：留痕要能独立看懂，不能只写「改规则」`)
  }
  const by =
    typeof options.by === 'string' && options.by.trim() !== ''
      ? options.by.trim()
      : options.by === 'user'
        ? 'user'
        : 'agent'
  const snapshot = snapshotRules(base, c)
  if (snapshot.ok !== true) {
    throw new FlowError('invalid', `规则文件当前状态无法留痕：${snapshot.issues.map((item) => item.detail).join('；')}`)
  }
  return withLock(base, c, () => {
    const guard = readRuleGuard(base, c)
    if (guard === null) {
      throw new FlowError('usage', '规则基线还没建立：先跑 flow gate rules init')
    }
    const diffs = diffRuleSnapshot(guard.baseline?.files, snapshot.files, optionalRulePaths(snapshot))
    if (diffs.length === 0) {
      return { changed: false, guard, guardPath: toPosix(ruleGuardPath(base, c)) }
    }
    const now = formatIso()
    const entry = {
      at: now,
      by: by === 'user' ? 'user' : 'agent',
      reason,
      changes: diffs.map((diff) =>
        diff.unit === 'section'
          ? { path: diff.path, scope: 'sections', section: diff.key, from: diff.from, to: diff.to }
          : { path: diff.path, scope: diff.scope, from: diff.from, to: diff.to },
      ),
    }
    const next = {
      ...guard,
      schema: 1,
      baseline: { at: now, files: snapshot.files },
      trail: [...(Array.isArray(guard.trail) ? guard.trail : []), entry].slice(-RULE_TRAIL_LIMIT),
      updated_at: now,
    }
    writeJsonAtomic(ruleGuardPath(base, c), next)
    return { changed: true, guard: next, entry, guardPath: toPosix(ruleGuardPath(base, c)) }
  })
}

/**
 * 校验规则文件未被无留痕地改动。
 * @returns {{ok:boolean, code?:string, baselineAt?:string, changed?:object[], diffs?:object[], issues?:object[], hint?:string, watched?:object[]}}
 */
export function checkRules(root, contract) {
  const base = resolve(root)
  const c = normalizeContract(base, contract)
  const watched = watchedRules(base, c)
  const snapshot = snapshotRules(base, c)
  if (snapshot.ok !== true) {
    return {
      ok: false,
      code: 'rule-anchor',
      issues: snapshot.issues,
      watched,
      hint: '锚点定位失败：先修 docs/module-domain.json 的 sections 或 CONTRACT.md 的锚点行',
    }
  }
  const guard = readRuleGuard(base, c)
  if (guard === null) {
    return {
      ok: false,
      code: 'guard-missing',
      watched,
      hint: '规则基线还没建立：先跑 flow gate rules init（之后改规则必须 flow gate rules record --reason "..."）',
    }
  }
  const diffs = diffRuleSnapshot(guard.baseline?.files, snapshot.files, optionalRulePaths(snapshot))
  if (diffs.length === 0) {
    return { ok: true, code: 'unchanged', baselineAt: guard.baseline?.at ?? null, changed: [], watched, trail: Array.isArray(guard.trail) ? guard.trail.length : 0 }
  }
  return {
    ok: false,
    code: 'unrecorded-change',
    baselineAt: guard.baseline?.at ?? null,
    changed: diffs,
    diffs,
    watched,
    hint: `规则文件被改成未留痕状态：${formatDiffs(diffs)}。确认改动合理后跑 flow gate rules record --reason "<理由>" 留痕并推进基线`,
  }
}
