#!/usr/bin/env node
// 模块写域与语义图哨兵（2026-11-08 建立；2026-11-12 阶段 1「最小语义层」扩展）。
//
// 为什么需要它（本轮真实问题）：
//   - lib/core.mjs / index.js / client.js / CONTRACT.md 几个大文件同时被多个模块修改，
//     没有任何机械边界，冲突只能靠人记；
//   - 项目已有的 t-20261107-module-boundaries 只守「依赖无环 / 不 import core」，
//     t-20261107-module-map-drift 只守「CONTRACT 1.1 覆盖 lib 文件」——都不回答
//     「这个改动该不该由本模块来写」。
//
// 单一真源是 docs/module-domain.json，本脚本是它唯一的执行者：
//   - owns      独占写域（精确路径或 dir/ 前缀）——回答「谁能改」；
//   - shared    共享写域（其他模块可以改，但只能改 sections 登记的区段）；
//   - tests     测试归属（测试跟着被测模块走，不跟着目录走）；
//   - sections  文件内一字不差的锚点行（from/to），verify 检查存在、唯一、顺序；
//   - roles     职责角色（角色不是人、不是 session；人的归属由心跳/claims 管）；
//   - aspects   横切关注面——回答「改它要谁知道 / 谁复核」，不给写权、不产生审批闸；
//   - unmanaged 归属宇宙之外的 git 跟踪文件（.selftest/ 探针、.github/、LICENSE 等）。
//
// owns 与 aspect 的区别（三句话）：
//   1. owns 回答「谁能改」，aspect 回答「改它要谁知道 / 谁复核」；
//   2. owns 排他（一个文件恰好一个 owner），aspect 天然多归属（一个文件可属多个关注面）；
//   3. owns 参与 check 的越界判定（会 exit 1），aspect 不参与越界判定、不产生审批闸。
//
// 用法：
//   node scripts/module-domain.mjs verify [<file>] [--json]
//   node scripts/module-domain.mjs matrix
//   node scripts/module-domain.mjs check --module tasks [--files a,b | --stdin]
//   node scripts/module-domain.mjs owners --files a,b [--json]
//   node scripts/module-domain.mjs owners --stdin [--json]
//   node scripts/module-domain.mjs owners --diff [--base <rev>] [--json]
//   node scripts/module-domain.mjs owners --cached [--json]
//
// 全局选项：--root <dir>（默认脚本上级目录）、--data <file>（默认 <root>/docs/module-domain.json）。
// 退出码：0 通过（owners：全部 owned/shared/exempt）；1 数据问题 / 越界 / 反查有未归属；2 用法或环境错误。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let ROOT = path.resolve(HERE, '..')
let DATA_FILE = path.join(ROOT, 'docs', 'module-domain.json')

/** 扫描文件时跳过的目录 / 文件（不是模块产物，或属于运行时数据）。 */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.dsh', '.dsh-ops', '.selftest', '.github'])
const IGNORED_FILES = new Set(['icon.svg', 'LICENSE', 'dsh-desktop.log', 'package-lock.json'])
/** 不属于任何模块的路径前缀（台账数据 / 会话工作目录 / 构建产物）：反查时直接算豁免。 */
const NON_MODULE_PREFIXES = ['.dsh/', '.dsh-ops/', '.selftest/', '.github/', 'node_modules/']
/** 归属宇宙的扫描根：仓库根出现别的目录时 verify 告警。 */
const WATCH_DIRS = new Set(['lib', 'bin', 'test', 'scripts', 'locale', 'skills', 'docs'])
/** aspect 数量上限（刹车，不是目标）。 */
const ASPECT_MAX = 6
/** role / aspect 的 id 形态。 */
const ID_PATTERN = /^[a-z][a-z0-9-]{2,40}$/

const die = (message, code = 2) => {
  process.stderr.write('module-domain: ' + message + '\n')
  process.exit(code)
}

function loadData() {
  let raw
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8')
  } catch (error) {
    die('读不到 ' + path.relative(ROOT, DATA_FILE) + '：' + error.message)
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    die(path.relative(ROOT, DATA_FILE) + ' 不是合法 JSON：' + error.message)
  }
  if (data === null || typeof data !== 'object' || data.schema !== 1) {
    die('module-domain.json 必须是 schema 1 对象')
  }
  return data
}

/** 仓库相对 POSIX 路径。 */
const rel = (absolute) => path.relative(ROOT, absolute).split(path.sep).join('/')

/** 递归列出一个目录下的普通文件（跳过 IGNORED_DIRS）。 */
function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      walk(absolute, out)
      continue
    }
    if (entry.isFile() && IGNORED_FILES.has(entry.name) === false) out.push(rel(absolute))
  }
  return out
}

/** 实际参与模块归属的文件集合（源码 / 测试 / 数据 / 文档 / 技能）。 */
function actualFiles() {
  const files = [
    ...walk(path.join(ROOT, 'lib')),
    ...walk(path.join(ROOT, 'bin')),
    ...walk(path.join(ROOT, 'test')),
    ...walk(path.join(ROOT, 'scripts')),
    ...walk(path.join(ROOT, 'locale')),
    ...walk(path.join(ROOT, 'skills')),
    ...walk(path.join(ROOT, 'docs')),
  ]
  for (const name of fs.readdirSync(ROOT)) {
    if (name.endsWith('.js') || name === 'CONTRACT.md' || name === 'README.md') files.push(name)
    if (['dsh-plugin.json', 'cordis.patch.yml', 'package.json'].includes(name)) files.push(name)
  }
  return [...new Set(files)].sort()
}

/** 一个 owns/shared/aspect.files 条目是精确文件还是目录前缀。 */
const isDirEntry = (entry) => entry.endsWith('/')
/** 精确路径或目录前缀匹配。 */
const matches = (entry, file) => (isDirEntry(entry) ? file === entry.slice(0, -1) || file.startsWith(entry) : file === entry)
/** 匹配一段 owns 列表，返回命中的最具体条目（目录前缀也算）。 */
function matchOwned(owns, file) {
  const hits = (Array.isArray(owns) ? owns : []).filter((entry) => matches(entry, file))
  hits.sort((a, b) => b.length - a.length)
  return hits[0]
}

/** 模块清单（保持 JSON 顺序）。 */
const moduleNames = (data) => Object.keys(data.modules ?? {})

/**
 * 一次扫描产出反向索引：file -> { owners, sharedBy, aspects }。
 *
 * files 可以比归属宇宙大（例如 owners 要反查已删除文件，或临时文件）；
 * verify 的 ① 只用 actualFiles()，反查则把输入文件一起传进来。
 */
function buildIndex(data, files) {
  const index = new Map()
  const names = moduleNames(data)
  const aspectFiles = Object.entries(data.aspects ?? {}).map(([id, aspect]) => [
    id,
    (Array.isArray(aspect?.files) ? aspect.files : []).filter((entry) => typeof entry === 'string' && entry !== ''),
  ])
  for (const file of files) {
    const entry = { owners: [], sharedBy: [], aspects: [] }
    for (const name of names) {
      const mod = data.modules[name] ?? {}
      const ownsHit = matchOwned(mod.owns, file) !== undefined || (Array.isArray(mod.tests) && mod.tests.includes(file))
      if (ownsHit) entry.owners.push(name)
      if (Array.isArray(mod.shared) && mod.shared.some((candidate) => matches(candidate, file))) entry.sharedBy.push(name)
    }
    for (const [id, declared] of aspectFiles) {
      if (declared.some((candidate) => matches(candidate, file))) entry.aspects.push(id)
    }
    index.set(file, entry)
  }
  return index
}

// ------------------------------------------------------- 锚点诊断（只影响报错文本）
/** 全角 → ASCII 的**解释用**归一化表；匹配规则永远是 trim 后全行精确相等。 */
const WIDTH_MAP = new Map([
  ['\uFF08', '('],
  ['\uFF09', ')'],
  ['\uFF3B', '['],
  ['\uFF3D', ']'],
  ['\uFF5B', '{'],
  ['\uFF5D', '}'],
  ['\uFF1A', ':'],
  ['\uFF0C', ','],
  ['\uFF1B', ';'],
  ['\uFF01', '!'],
  ['\uFF1F', '?'],
  ['\u201C', '"'],
  ['\u201D', '"'],
  ['\u2018', "'"],
  ['\u2019', "'"],
  ['\u3000', ' '],
  ['\u2014', '-'],
  ['\u2013', '-'],
])

/** 只用于解释：全角/宽字符归一化 + 连续空格折叠（不做 NFKC，避免制造假匹配）。 */
function normalizeAnchor(text) {
  let output = ''
  for (const character of text) output += WIDTH_MAP.get(character) ?? character
  return output.replace(/ {2,}/g, ' ')
}

/** 码点标签：U+FF08 '（'（不可见字符也当场暴露）。 */
const codepointLabel = (character) => {
  const code = character.codePointAt(0)
  return 'U+' + code.toString(16).toUpperCase().padStart(4, '0') + ' ' + JSON.stringify(character)
}

/** 第一个不同的下标（按 UTF-16 单元；显示时换算成码点列）。 */
function firstDiffIndex(left, right) {
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1
  return index
}

/** 最长公共子串长度（只用于给候选行打分）。 */
function longestCommonSubstring(left, right) {
  if (left === '' || right === '') return 0
  const row = new Array(right.length + 1).fill(0)
  let best = 0
  for (let i = 1; i <= left.length; i += 1) {
    let previous = 0
    for (let j = 1; j <= right.length; j += 1) {
      const saved = row[j]
      row[j] = left[i - 1] === right[j - 1] ? previous + 1 : 0
      if (row[j] > best) best = row[j]
      previous = saved
    }
  }
  return best
}

/** 三元候选：归一化相等 → 前缀/后缀包含（长度差 ≤ 8）→ 相似度最高。最多 max 条。 */
function closestLines(lines, anchor, max = 3) {
  const target = normalizeAnchor(anchor)
  const scored = []
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim()
    if (text === '') continue
    const normalized = normalizeAnchor(text)
    if (normalized === target) {
      scored.push({ line: i, text: text, reason: '归一化后相等（只差全角/不可见字符）', score: 1000 })
      continue
    }
    const overlap = longestCommonSubstring(normalized, target)
    const ratio = overlap / Math.max(normalized.length, target.length, 1)
    const contained =
      (normalized.startsWith(target) || normalized.endsWith(target) || target.startsWith(normalized) || target.endsWith(normalized)) &&
      Math.abs(normalized.length - target.length) <= 8
    if (contained) scored.push({ line: i, text: text, reason: '前缀/后缀包含（长度差 ≤ 8）', score: 500 + ratio })
    else if (ratio >= 0.5) scored.push({ line: i, text: text, reason: '相似度 ' + Math.round(ratio * 100) + '%', score: ratio * 100 })
  }
  scored.sort((left, right) => right.score - left.score || left.line - right.line)
  return scored.slice(0, max)
}

/** 统计全行精确命中的行号（0 基）。匹配规则：trim 后相等，不做归一化。 */
function exactPositions(lines, anchor) {
  const positions = []
  for (let i = 0; i < lines.length; i += 1) if (lines[i].trim() === anchor) positions.push(i)
  return positions
}

/**
 * 锚点不匹配时的可读诊断：打印期望行、最接近的实际行、逐码点差异。
 * 只在 0 次 / 多次命中时调用；匹配语义不受影响。
 */
function anchorDiagnostics(file, lines, anchor, positions, which) {
  const extra = []
  if (positions.length > 1) {
    for (const position of positions) extra.push('      ' + file + ':' + (position + 1) + ': ' + JSON.stringify(lines[position].trim()))
    return {
      extra,
      hint: '锚点必须全行唯一：缩到唯一前缀，或换用相邻唯一行定位（当前只支持单行锚点）',
    }
  }
  extra.push('      期望: ' + JSON.stringify(anchor))
  const candidates = closestLines(lines, anchor)
  for (const candidate of candidates) {
    extra.push('      最接近: ' + file + ':' + (candidate.line + 1) + ' ' + JSON.stringify(candidate.text))
    extra.push('        原因: ' + candidate.reason)
    extra.push('      期望: ' + JSON.stringify(anchor))
    extra.push('      实际: ' + JSON.stringify(candidate.text))
    const at = firstDiffIndex(anchor, candidate.text)
    if (at < anchor.length && at < candidate.text.length) {
      const column = [...anchor.slice(0, at)].length + 1
      extra.push('        第 ' + column + ' 列不同: 期望 ' + codepointLabel(anchor[at]) + ' 不等于 实际 ' + codepointLabel(candidate.text[at]))
    }
  }
  if (candidates.length === 0) extra.push('      文件里没有相似行：先确认这段是否被整段替换，或文件是否被改名')
  else if (candidates.some((candidate) => candidate.reason.startsWith('归一化'))) extra.push('      只差不可见/全角字符，建议直接复制实际行回 json')
  return {
    extra,
    hint:
      which === 'to'
        ? '若该标题已被删除，请把 to 指向新的下一段锚点，或改为 null（表示到文件末尾）'
        : '把实际行改成期望行，或把 json 里的 from 改成实际行；不改锚点以外的内容',
  }
}

// ------------------------------------------------------------------ verify
const serializeProblem = (problem) => ({
  kind: problem.kind,
  path: problem.path ?? null,
  module: problem.module ?? null,
  detail: problem.detail,
  hint: problem.hint ?? null,
  extra: problem.extra ?? [],
  level: problem.level ?? 'error',
})

function verify(options) {
  const opts = options ?? {}
  const data = loadData()
  const problems = []
  const warnings = []
  const fail = (kind, detail, rest) => {
    const item = { kind: kind, detail: detail, level: 'error' }
    if (rest !== undefined) Object.assign(item, rest)
    problems.push(item)
  }
  const warn = (detail) => warnings.push(detail)

  const universe = actualFiles()
  const targets = opts.file !== undefined ? [opts.file] : universe
  const index = buildIndex(data, [...new Set([...universe, ...targets])])

  // ① 每个受管文件恰好一个 owns
  for (const file of targets) {
    const entry = index.get(file)
    if (entry === undefined || entry.owners.length === 0) {
      fail('未归属', file + '（没有任何模块的 owns 匹配它）', { path: file })
      continue
    }
    if (entry.owners.length > 1) fail('重复归属', file + ' → ' + entry.owners.join('|'), { path: file })
  }

  // ② owns / shared / tests 里没有幽灵
  for (const name of moduleNames(data)) {
    const mod = data.modules[name]
    for (const entry of mod.owns ?? []) {
      if (isDirEntry(entry)) {
        if (fs.existsSync(path.join(ROOT, entry)) === false) fail('幽灵目录', name + ' owns "' + entry + '"', { module: name })
        continue
      }
      if (fs.existsSync(path.join(ROOT, entry)) === false) fail('幽灵文件', name + ' owns "' + entry + '"', { module: name })
    }
    for (const entry of mod.shared ?? []) {
      if (fs.existsSync(path.join(ROOT, entry)) === false) fail('幽灵共享', name + ' shared "' + entry + '"', { module: name })
    }
    for (const test of mod.tests ?? []) {
      if (fs.existsSync(path.join(ROOT, test)) === false) fail('幽灵测试', name + ' tests "' + test + '"', { module: name })
    }
  }

  // ③ 同一模块不得 owns + shared 同一个文件
  for (const [file, entry] of index) {
    for (const owner of entry.owners) {
      if (entry.sharedBy.includes(owner)) fail('自相矛盾', file + ' 既是 ' + owner + ' 的 owns 又被它自己 shared', { path: file, module: owner })
    }
  }

  // ④ sections 锚点：存在、唯一、顺序；不匹配时打印期望行 vs 最接近实际行 + 逐码点差异
  for (const [file, sections] of Object.entries(data.sections ?? {})) {
    const absolute = path.join(ROOT, file)
    if (fs.existsSync(absolute) === false) {
      fail('sections 指向不存在的文件', file, { path: file })
      continue
    }
    const lines = fs.readFileSync(absolute, 'utf8').split('\n')
    let last = -1
    let lastKey = null
    for (const [key, section] of Object.entries(sections)) {
      if (section === null || typeof section !== 'object') {
        fail('区段形状', 'sections/' + file + '/' + key + ' 必须是 {from,to}', { path: file })
        continue
      }
      const from = typeof section.from === 'string' ? section.from.trim() : ''
      if (from === '') {
        fail('锚点', 'sections/' + file + '/' + key + ' 缺 from 锚点', {
          path: file,
          hint: 'from 必须是非空字符串，且与文件里某一行 trim 后完全相等',
        })
        continue
      }
      const positions = exactPositions(lines, from)
      if (positions.length !== 1) {
        const diagnostic = anchorDiagnostics(file, lines, from, positions, 'from')
        fail('锚点', 'sections/' + file + '/' + key + ' 的 from 锚点匹配 ' + positions.length + ' 行（必须恰好 1 行）', {
          path: file,
          extra: diagnostic.extra,
          hint: diagnostic.hint,
        })
        continue
      }
      if (positions[0] <= last) {
        fail('锚点', 'sections/' + file + '/' + key + ' 的 from 锚点不在前一段之后（顺序漂移）', {
          path: file,
          extra: ['      前一段 ' + lastKey + ' 的 from 在 :' + (last + 1) + ' 行，本条在 :' + (positions[0] + 1) + ' 行（必须严格递增）'],
          hint: '调整 docs/module-domain.json 里的区段顺序，或修正其中一条锚点',
        })
      }
      last = positions[0]
      lastKey = key
      if (section.to !== null && section.to !== undefined) {
        const to = typeof section.to === 'string' ? section.to.trim() : ''
        const toPositions = exactPositions(lines, to)
        if (toPositions.length !== 1) {
          const diagnostic = anchorDiagnostics(file, lines, to, toPositions, 'to')
          fail('锚点', 'sections/' + file + '/' + key + ' 的 to 锚点匹配 ' + toPositions.length + ' 行（必须恰好 1 行）', {
            path: file,
            extra: diagnostic.extra,
            hint: diagnostic.hint,
          })
        } else if (toPositions[0] <= positions[0]) {
          fail('锚点', 'sections/' + file + '/' + key + ' 的 to 不在 from 之后', {
            path: file,
            extra: ['      from 在 :' + (positions[0] + 1) + '，to 在 :' + (toPositions[0] + 1)],
            hint: '把 to 指向 from 之后的唯一行，或改为 null（表示到文件末尾）',
          })
        }
      }
    }
  }

  // ⑤ 模块引用的区段必须已定义（owns 自用区段也走这条）
  for (const name of moduleNames(data)) {
    const refs = data.modules[name].sections ?? {}
    for (const [file, keys] of Object.entries(refs)) {
      if (Array.isArray(keys) === false) {
        fail('区段引用形状', '模块 ' + name + ' 的 sections["' + file + '"] 必须是数组', { module: name, path: file })
        continue
      }
      const known = Object.keys(data.sections?.[file] ?? {})
      for (const key of keys) {
        if (known.includes(key) === false) fail('未定义区段', '模块 ' + name + ' 引用了未定义的区段：' + file + ' → "' + key + '"', { module: name, path: file })
      }
    }
  }

  // ⑥ 登记区段的文件必须在本模块写域（owns ∪ shared）里；owns 自用区段合法
  for (const name of moduleNames(data)) {
    const mod = data.modules[name]
    for (const file of Object.keys(mod.sections ?? {})) {
      const inOwns = matchOwned(mod.owns, file) !== undefined || (mod.tests ?? []).includes(file)
      const inShared = (mod.shared ?? []).some((entry) => matches(entry, file))
      if (inOwns === false && inShared === false) {
        fail('越域区段', '模块 ' + name + ' 在自己的写域之外声明了区段：' + file, {
          module: name,
          path: file,
          hint: '区段只能登记在自己 owns 或 shared 的文件上',
        })
      }
    }
  }

  // ⑦ 顶层每个区段至少被一个模块引用（否则它是「谁都可以改」的孤儿）
  const referenced = new Set()
  for (const name of moduleNames(data)) {
    for (const [file, keys] of Object.entries(data.modules[name].sections ?? {})) {
      for (const key of Array.isArray(keys) ? keys : []) referenced.add(file + '#' + key)
    }
  }
  for (const [file, sections] of Object.entries(data.sections ?? {})) {
    for (const key of Object.keys(sections ?? {})) {
      if (referenced.has(file + '#' + key) === false) {
        fail('孤儿区段', file + ' → "' + key + '"（没有模块登记它，等于谁都可以改）', {
          path: file,
          hint: '在负责该文件的模块 sections 里引用它，或删掉这个区段',
        })
      }
    }
  }

  // ⑧ shared 必须登记 ≥1 个区段（整文件共享 = 没有边界；阶段 1 的核心补口）
  for (const name of moduleNames(data)) {
    const mod = data.modules[name]
    const refs = mod.sections ?? {}
    for (const entry of mod.shared ?? []) {
      const covered = isDirEntry(entry)
        ? Object.keys(refs).some((file) => matches(entry, file))
        : Array.isArray(refs[entry]) && refs[entry].length > 0
      if (covered === false) {
        fail('共享未登记区段', name + ' 可改 "' + entry + '" 任意位置（先在该文件登记区段并引用）', {
          module: name,
          path: entry,
          hint: 'shared 文件必须登记至少一个区段，否则等于整文件可改',
        })
      }
    }
  }

  // ⑨ roles：职责角色（不是人、不是 session）
  const roles = data.roles ?? {}
  const usedRoles = new Set()
  for (const [id, role] of Object.entries(roles)) {
    if (ID_PATTERN.test(id) === false) fail('role id 形态非法', 'role/' + id + '（须匹配 ^[a-z][a-z0-9-]{2,40}$）')
    const semantics = typeof role?.semantics === 'string' ? role.semantics.trim() : ''
    if (semantics.length < 10) fail('role 语义过短', 'role/' + id + ' 的 semantics 少于 10 字符（一句话说明这个角色负责什么）')
    const modules = Array.isArray(role?.modules) ? role.modules : []
    if (modules.length === 0) fail('role 无模块', 'role/' + id + ' 的 modules 为空（角色必须声明负责哪些模块）')
    for (const moduleName of modules) {
      if (moduleNames(data).includes(moduleName) === false) fail('role 指向未知模块', 'role/' + id + ' 指向未知模块：' + String(moduleName))
    }
  }

  // ⑩ aspects：横切关注面（文件必须存在且在归属宇宙内、ownerRole 可解析、数量 ≤ 6）
  const aspects = data.aspects ?? {}
  const aspectIds = Object.keys(aspects)
  if (aspectIds.length > ASPECT_MAX) {
    fail('aspect 数量超限', aspectIds.length + ' 大于 ' + ASPECT_MAX + '：新增需给出三条判据（已有独立守卫测试 + 跨 ≥2 模块 + 漏了会出正确性事故）')
  }
  for (const [id, aspect] of Object.entries(aspects)) {
    if (ID_PATTERN.test(id) === false) fail('aspect id 形态非法', 'aspect/' + id + '（须匹配 ^[a-z][a-z0-9-]{2,40}$）')
    const semantics = typeof aspect?.semantics === 'string' ? aspect.semantics.trim() : ''
    if (semantics.length < 10) fail('aspect 语义过短', 'aspect/' + id + ' 的 semantics 少于 10 字符（一句话说明它保证什么不变量）')
    const rationale = typeof aspect?.rationale === 'string' ? aspect.rationale.trim() : ''
    if (rationale.length < 20) fail('aspect 缺少理由', 'aspect/' + id + ' 的 rationale 少于 20 字符（增删 aspect 的理由要跟着 diff 走）')
    const ownerRole = aspect?.ownerRole
    if (typeof ownerRole !== 'string' || Object.prototype.hasOwnProperty.call(roles, ownerRole) === false) {
      fail('aspect ownerRole 未定义', 'aspect/' + id + ' 的 ownerRole 未定义：' + String(ownerRole))
    } else {
      usedRoles.add(ownerRole)
    }
    const files = Array.isArray(aspect?.files) ? aspect.files : []
    if (files.length === 0) fail('aspect 无文件', 'aspect/' + id + ' 的 files 为空（必须显式声明涉及哪些文件）')
    const seen = new Set()
    for (const entry of files) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        fail('aspect 文件非法', 'aspect/' + id + ' 的 files 里有空路径')
        continue
      }
      if (seen.has(entry)) fail('aspect 文件重复', 'aspect/' + id + ' 重复声明文件：' + entry)
      seen.add(entry)
      if (fs.existsSync(path.join(ROOT, entry)) === false) {
        fail('aspect 文件不存在', 'aspect/' + id + ' 的文件不存在：' + entry, { path: entry })
        continue
      }
      const inUniverse = isDirEntry(entry) ? universe.some((file) => matches(entry, file)) : (index.get(entry)?.owners.length ?? 0) > 0
      if (inUniverse === false) {
        fail('aspect 文件未归属', 'aspect/' + id + ' 的文件未被任何模块归属：' + entry, {
          path: entry,
          hint: '先把文件登记进某个模块的 owns/shared/tests，或从 aspect.files 移除',
        })
      }
    }
  }
  for (const id of Object.keys(roles)) {
    if (usedRoles.has(id) === false) warn('role/' + id + ' 未被任何 aspect 使用（角色可以保留，但请确认不是遗留）')
  }

  // ⑪ unmanaged：归属宇宙之外的 git 跟踪文件（.selftest/ 探针、.github/、LICENSE 等）
  const unmanaged = Array.isArray(data.unmanaged) ? data.unmanaged : []
  const unmanagedSeen = new Set()
  for (const item of unmanaged) {
    const file = typeof item?.path === 'string' ? item.path : ''
    if (file === '') {
      fail('unmanaged 条目非法', 'unmanaged 里的条目缺少 path')
      continue
    }
    if (unmanagedSeen.has(file)) fail('unmanaged 重复', 'unmanaged 重复登记：' + file, { path: file })
    unmanagedSeen.add(file)
    if (fs.existsSync(path.join(ROOT, file)) === false) fail('unmanaged 条目不存在', file, { path: file, hint: '删掉这条，或修正路径' })
    const entry = index.get(file)
    if (entry !== undefined && entry.owners.length > 0) {
      fail('unmanaged 冲突', 'unmanaged 条目与模块归属冲突：' + file, { path: file, hint: '它已被模块 owns 覆盖，不该再登记成 unmanaged' })
    }
  }

  // ⑫ 仓库根出现归属宇宙之外的目录（warn，不判红：新目录先提醒补扫描范围）
  let rootEntries = []
  try {
    rootEntries = fs.readdirSync(ROOT, { withFileTypes: true })
  } catch {
    rootEntries = []
  }
  for (const entry of rootEntries) {
    if (entry.isDirectory() === false) continue
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name) || WATCH_DIRS.has(entry.name)) continue
    warn('扫描根未纳入归属：' + entry.name + '/（新代码目录？请补进 actualFiles 的扫描范围或 unmanaged）')
  }

  if (opts.json === true) {
    process.stdout.write(
      JSON.stringify({ ok: problems.length === 0, problems: problems.map(serializeProblem), warnings: warnings }, null, 2) + '\n',
    )
    return problems.length === 0 ? 0 : 1
  }
  if (problems.length > 0) {
    process.stderr.write('module-domain verify：' + problems.length + ' 个问题\n')
    for (const problem of problems) {
      process.stderr.write('  - ' + problem.kind + '：' + problem.detail + '\n')
      for (const line of problem.extra ?? []) process.stderr.write(line + '\n')
      if (problem.hint !== undefined) process.stderr.write('    hint: ' + problem.hint + '\n')
    }
    for (const warning of warnings) process.stderr.write('  ! ' + warning + '\n')
    return 1
  }
  process.stdout.write('module-domain verify：OK（' + moduleNames(data).length + ' 个模块，' + universe.length + ' 个文件）\n')
  for (const warning of warnings) process.stdout.write('  ! ' + warning + '\n')
  return 0
}

// ------------------------------------------------------------------- check
function changedFiles() {
  const result = spawnSync('git', ['status', '--porcelain', '-uall'], { encoding: 'utf8', cwd: ROOT })
  if (result.error) die('git 不可用：' + result.error.message)
  if (result.status !== 0) die('git status 失败：' + (result.stderr || '').trim())
  const files = []
  for (const line of result.stdout.split('\n')) {
    const text = line.trimEnd()
    if (text === '') continue
    // porcelain v1: XY <path>；重命名行是 "XY old -> new"
    const body = text.slice(3)
    const target = body.includes(' -> ') ? body.slice(body.indexOf(' -> ') + 4) : body
    if (NON_MODULE_PREFIXES.some((prefix) => target === prefix || target.startsWith(prefix))) continue
    files.push(target)
  }
  return files
}

function classify(data, index, moduleName, files) {
  const mod = data.modules[moduleName]
  if (mod === undefined) die('未知模块：' + moduleName + '（可用：' + moduleNames(data).join(', ') + '）')
  const rows = []
  for (const file of files) {
    if (matchOwned(mod.owns, file) !== undefined || (mod.tests ?? []).includes(file)) {
      rows.push({ file: file, verdict: 'owned' })
      continue
    }
    if ((mod.shared ?? []).some((entry) => matches(entry, file))) {
      const refs = (mod.sections ?? {})[file] ?? []
      rows.push({ file: file, verdict: 'shared', sections: refs })
      continue
    }
    const entry = index.get(file)
    const owner = entry !== undefined && entry.owners.length > 0 ? entry.owners.join('|') : '(无)'
    rows.push({ file: file, verdict: 'foreign', owner: owner })
  }
  return rows
}

function check(data, index, moduleName, files) {
  const rows = classify(data, index, moduleName, files)
  const foreign = rows.filter((row) => row.verdict === 'foreign')
  for (const row of rows) {
    if (row.verdict === 'owned') process.stdout.write('  owned   ' + row.file + '\n')
    else if (row.verdict === 'shared') {
      const sections = row.sections.length > 0 ? '（只可改区段：' + row.sections.join(', ') + '）' : '（未登记区段，先改边界）'
      process.stdout.write('  shared  ' + row.file + ' ' + sections + '\n')
    } else process.stdout.write('  FOREIGN ' + row.file + ' → 属于 ' + row.owner + '\n')
  }
  if (foreign.length > 0) {
    process.stderr.write('module-domain check：' + foreign.length + ' 个越界文件（模块 ' + moduleName + '）\n')
    return 1
  }
  process.stdout.write('module-domain check：OK（模块 ' + moduleName + '，' + rows.length + ' 个文件）\n')
  return 0
}

// ------------------------------------------------------------------ owners
function gitNameStatus(diffArgs) {
  const result = spawnSync('git', ['diff', ...diffArgs, '--name-status', '-M', '--diff-filter=ACMRD'], { encoding: 'utf8', cwd: ROOT })
  if (result.error) die('git 不可用：' + result.error.message)
  if (result.status !== 0) die('git diff 失败：' + (result.stderr || '').trim())
  const rows = []
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    rows.push({ path: parts[parts.length - 1], status: parts[0].slice(0, 1) })
  }
  return rows
}

function readStdin() {
  return fs
    .readFileSync(0, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function describeOwners(data, index, rows) {
  const unmanaged = new Map(
    (Array.isArray(data.unmanaged) ? data.unmanaged : [])
      .filter((item) => typeof item?.path === 'string')
      .map((item) => [item.path, typeof item.reason === 'string' ? item.reason : 'unmanaged']),
  )
  const result = []
  for (const row of rows) {
    const file = row.path
    const entry = index.get(file) ?? { owners: [], sharedBy: [], aspects: [] }
    let attribution
    let reason = null
    if (unmanaged.has(file)) {
      attribution = 'exempt'
      reason = unmanaged.get(file)
    } else if (NON_MODULE_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix))) {
      attribution = 'exempt'
      reason = '非模块路径'
    } else if (entry.owners.length === 0 && entry.sharedBy.length === 0) attribution = 'unknown'
    else if (entry.sharedBy.length > 0) attribution = 'shared'
    else attribution = 'owned'
    const sections = []
    for (const name of [...new Set([...entry.owners, ...entry.sharedBy])]) {
      const keys = (data.modules[name]?.sections ?? {})[file]
      if (keys !== undefined) sections.push({ module: name, file: file, keys: keys })
    }
    result.push({
      path: file,
      status: row.status ?? '',
      owners: entry.owners,
      sharedBy: entry.sharedBy,
      sections: sections,
      aspects: entry.aspects,
      attribution: attribution,
      reason: reason,
    })
  }
  return result
}

function ownersCommand(data, argv) {
  const json = argv.includes('--json')
  const filtered = argv.filter((arg) => arg !== '--json')
  const filesFlag = filtered.indexOf('--files')
  const baseFlag = filtered.indexOf('--base')
  const base = baseFlag !== -1 ? filtered[baseFlag + 1] : undefined
  if (baseFlag !== -1 && (base === undefined || base.startsWith('--'))) die('--base 需要一个 git 版本')
  let rows = []
  let range = null
  if (filesFlag !== -1) {
    const list = filtered[filesFlag + 1]
    if (list === undefined) die('--files 需要一个逗号分隔的路径列表')
    rows = list
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((file) => ({ path: file, status: '' }))
  } else if (filtered.includes('--stdin')) {
    rows = readStdin().map((file) => ({ path: file, status: '' }))
  } else if (filtered.includes('--cached')) {
    range = '--cached'
    rows = gitNameStatus(['--cached'])
  } else if (filtered.includes('--diff') || base !== undefined) {
    const from = base ?? 'HEAD~1'
    range = from + '...HEAD'
    rows = gitNameStatus([range])
  } else {
    die('owners 需要 --files / --stdin / --diff / --cached 之一')
  }
  const deduped = new Map()
  for (const row of rows) deduped.set(row.path, row)
  const list = [...deduped.values()]
  if (list.length === 0) {
    process.stdout.write('module-domain owners：没有可反查的文件\n')
    return 0
  }
  const files = list.map((row) => row.path)
  const index = buildIndex(data, [...new Set([...actualFiles(), ...files])])
  const result = describeOwners(data, index, list)

  const moduleCounts = new Map()
  const aspectCounts = new Map()
  let exempt = 0
  let unknown = 0
  for (const row of result) {
    if (row.attribution === 'unknown') {
      unknown += 1
      continue
    }
    if (row.attribution === 'exempt') {
      exempt += 1
      continue
    }
    for (const name of new Set([...row.owners, ...row.sharedBy])) moduleCounts.set(name, (moduleCounts.get(name) ?? 0) + 1)
    for (const id of row.aspects) aspectCounts.set(id, (aspectCounts.get(id) ?? 0) + 1)
  }

  if (json) {
    const summary = {
      modules: Object.fromEntries(moduleCounts),
      aspects: Object.fromEntries(aspectCounts),
      exempt: exempt,
      unknown: unknown,
    }
    process.stdout.write(
      JSON.stringify(
        {
          schema: 1,
          range: range,
          files: result.map((row) => ({
            path: row.path,
            status: row.status,
            owners: row.owners,
            sharedBy: row.sharedBy,
            sections: row.sections,
            aspects: row.aspects,
            attribution: row.attribution,
          })),
          summary: summary,
          ok: unknown === 0,
        },
        null,
        2,
      ) + '\n',
    )
    return unknown === 0 ? 0 : 1
  }

  if (range !== null) process.stdout.write('变更范围：' + range + '\n')
  const pad = (text, width) => text + ' '.repeat(Math.max(0, width - text.length))
  for (const row of result) {
    const label = row.attribution === 'owned' ? 'owned' : row.attribution === 'shared' ? 'shared' : row.attribution === 'exempt' ? 'exempt' : 'UNKNOWN'
    let line = '  ' + pad(label, 8) + pad(row.path, 32)
    if (row.attribution === 'owned') {
      line += ' → ' + row.owners.join('|')
      if (row.aspects.length > 0) line += '   aspect: ' + row.aspects.join(', ')
    } else if (row.attribution === 'shared') {
      line += ' → ' + row.owners.join('|') + ' (owns)'
      line +=
        '   ' +
        row.sharedBy
          .map((name) => {
            const found = row.sections.find((section) => section.module === name)
            return name + ' 可改: ' + (found !== undefined ? found.keys.join(',') : '(未登记)')
          })
          .join('; ')
      if (row.aspects.length > 0) line += '   aspect: ' + row.aspects.join(', ')
    } else if (row.attribution === 'exempt') {
      line += ' → (unmanaged)   ' + (row.reason ?? '')
    } else {
      line += ' → (无)   先补归属（owns / shared / unmanaged）'
    }
    process.stdout.write(line + '\n')
  }
  const moduleText =
    moduleCounts.size === 0
      ? '无'
      : moduleCounts.size +
        '（' +
        [...moduleCounts.entries()].map(([name, count]) => name + ' x' + count).join(', ') +
        '）'
  const aspectText = aspectCounts.size === 0 ? '无' : [...aspectCounts.keys()].join(', ')
  process.stdout.write('汇总：模块 ' + moduleText + ' · aspect ' + aspectText + ' · exempt ' + exempt + ' · 未归属 ' + unknown + '\n')
  if (unknown > 0) {
    process.stderr.write('module-domain owners：' + unknown + ' 个文件未归属（先补 owns / shared 或 unmanaged）\n')
    return 1
  }
  return 0
}

// ------------------------------------------------------------------ matrix
function matrix(data) {
  const rows = []
  for (const name of moduleNames(data)) {
    const mod = data.modules[name]
    rows.push({
      module: name,
      title: mod.title,
      owns: (mod.owns ?? []).length,
      shared: (mod.shared ?? []).length,
      tests: (mod.tests ?? []).length,
    })
  }
  const width = Math.max(...rows.map((row) => row.module.length), 6)
  process.stdout.write('模块'.padEnd(width) + '  独占  共享  测试  职责\n')
  for (const row of rows) {
    process.stdout.write(
      row.module.padEnd(width) +
        '  ' +
        String(row.owns).padStart(3) +
        '  ' +
        String(row.shared).padStart(4) +
        '  ' +
        String(row.tests).padStart(4) +
        '  ' +
        row.title +
        '\n',
    )
  }
  return 0
}

// -------------------------------------------------------------------- main
/** 取出一个带值选项（--root/--data），返回剩余 argv。 */
function takeOption(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return { value: undefined, argv: argv }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) die(name + ' 需要一个值')
  return { value: value, argv: argv.slice(0, index).concat(argv.slice(index + 2)) }
}

function main(rawArgv) {
  let argv = rawArgv.slice()
  const rootOption = takeOption(argv, '--root')
  argv = rootOption.argv
  if (rootOption.value !== undefined) ROOT = path.resolve(rootOption.value)
  const dataOption = takeOption(argv, '--data')
  argv = dataOption.argv
  if (dataOption.value !== undefined) DATA_FILE = path.resolve(ROOT, dataOption.value)

  const command = argv[0]
  if (command === 'verify') {
    const rest = argv.slice(1).filter((arg) => arg !== '--json')
    if (rest.length > 1) die('verify 最多接受一个文件参数')
    return verify({ file: rest[0], json: argv.includes('--json') })
  }
  if (command === 'matrix') return matrix(loadData())
  if (command === 'check') {
    const data = loadData()
    const moduleFlag = argv.indexOf('--module')
    if (moduleFlag === -1 || argv[moduleFlag + 1] === undefined) die('check 需要 --module <name>')
    const moduleName = argv[moduleFlag + 1]
    let files
    if (argv.includes('--stdin')) files = readStdin()
    else {
      const filesFlag = argv.indexOf('--files')
      files = filesFlag !== -1 ? (argv[filesFlag + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean) : changedFiles()
    }
    if (files.length === 0) {
      process.stdout.write('module-domain check：没有待检查的改动（模块 ' + moduleName + '）\n')
      return 0
    }
    const index = buildIndex(data, [...new Set([...actualFiles(), ...files])])
    return check(data, index, moduleName, files)
  }
  if (command === 'owners') return ownersCommand(loadData(), argv.slice(1))
  die('用法：module-domain.mjs verify [file] [--json] | matrix | check --module <name> [--files a,b | --stdin] | owners --files a,b | --stdin | --diff [--base rev] | --cached [--json]')
  return 2
}

process.exit(main(process.argv.slice(2)))
