// lib/desc.mjs —— 描述台账的模型层（纯逻辑 + 只读文件系统）
//
// 职责边界（CONTRACT §3.7 与设计规格 §5/§8，D3 据此冻结接口）：
//   - 本模块**不写任何文件**：build / set / apply 的「锁内编排 + 原子写」全在
//     `lib/core.mjs`（D3）。这里只返回「算好的记录」，写盘由调用方决定。
//   - 依赖方向固定 `core → desc → source-scan / util`：本模块不 import core，
//     source-scan 是叶子。这样 `test/t-20261107-module-boundaries.test.mjs`
//     的无环断言成立。
//   - 全部输出确定性：数组排序稳定、没有墙钟时间（记录时间戳由调用方传 now）。
//     渲染**刻意不带任何时间戳**：`project.generated_at` 每次 build 都会刷新，
//     把它写进 Markdown 会让 `render --check` 在每次 build 后必然 stale。
//
// 检查项形状（`checkProject` / `checkPlan` 共用，D3 的输出层直接消费）：
//
//   { kind, path, module?, detail, hint, level }
//
// `level` 是 'fail' | 'warn'：**调用方必须按 level 分区**——`warn` 项不进
// failed、只进 warnings。带 warn 的只有两类（spec §6）：非 strict 下的
// `undescribed-file`，以及 git 不可用 / base 失效（`git-unavailable` /
// `git-base-changed`）。把 warn 当 fail 会让「文件还没描述」变成假红。
//
// 计划与记录的分工（spec §2.3 / §7）：
//   - `normalizePlanInput` 只归一 + 校验「计划的形状」；
//   - `applyPlanToRecords` 把计划语义**声明式**地落进记录（可重复执行，
//     第二次 `applied:false`），结构性不可能（成员不存在 / 删不存在的模块）
//     抛 `FlowError('invalid')`；
//   - 「计划没落地 / 覆盖不全 / 缺语义 / 有未计划改动」由 `checkPlan` 报，
//     不在这里抛错。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, posix, resolve, sep } from 'node:path'

import { languageOf, scanSource } from './source-scan.mjs'
import { FlowError, deepClone, formatIso, invalid, isPlainObject, toPosix } from './util.mjs'

// ------------------------------------------------------------------ 常量

const SCHEMA = 1

/** 模块 id：小写字母/数字开头，后面 0–40 个 `[a-z0-9-]`（最多 41 字符）。 */
const MODULE_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
const MODULE_ID_MAX = 41

const MIN_SEMANTICS_CHARS = 10
const DEFAULT_MAX_FILES = 2000
const DEFAULT_MAX_SCAN_BYTES = 1024 * 1024

/** 模块边的 `why` 最多保留前几对。 */
const WHY_LIMIT = 3

/** 计划里的任务 id 会变成文件名，必须是单段安全字符。 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const JS_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx']

const MODULE_OPS = new Set(['add', 'change', 'remove'])
const FILE_OPS = new Set(['add', 'change', 'remove'])
const IMPORT_KINDS = new Set(['static', 'reexport', 'dynamic', 'side-effect'])
const LANGUAGES = new Set(['js', 'python', 'unknown'])

/** spec §1 的默认 include/exclude（契约缺省时兜底，保证纯函数可自洽）。 */
const DEFAULT_INCLUDE = [
  '**/*.mjs',
  '**/*.js',
  '**/*.cjs',
  '**/*.ts',
  '**/*.tsx',
  '**/*.jsx',
  '**/*.py',
]
const DEFAULT_EXCLUDE = [
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
  '.agents/**',
  'docs/**',
]

// ------------------------------------------------------------- 通用小工具

/** 稳定文本比较（UTF-16 码元序，不用 locale，跨平台/跨 locale 一致）。 */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/** 调用方传入的 now：Date | ISO 字符串 | 毫秒数；缺省取当前时间。 */
function isoOf(now) {
  if (now instanceof Date) {
    return Number.isNaN(now.getTime()) ? formatIso(new Date()) : formatIso(now)
  }
  if (typeof now === 'string' && now.trim() !== '') return now.trim()
  if (typeof now === 'number' && Number.isFinite(now)) return formatIso(new Date(now))
  return formatIso(new Date())
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function integerOr(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

function stringListOf(value, fallback) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string')
  return fallback
}

/**
 * 描述节的取值：兼容「整份契约」与「只有 description 节」两种入参。
 * 老 flow.json 没有 description 节时按顶层读，缺键由各调用点兜默认。
 */
function descriptionConfigOf(contract) {
  if (!isPlainObject(contract)) return {}
  if (isPlainObject(contract.description)) return contract.description
  return contract
}

function minSemanticsOf(options = {}) {
  return positiveInt(options.minSemanticsChars, MIN_SEMANTICS_CHARS)
}

/** 语义归一：trim + 内部空白折叠（spec §2.2 的「语义比较」）。 */
function normalizedSemantics(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function semanticsLength(value) {
  return normalizedSemantics(value).length
}

function hasSemantics(value, min = MIN_SEMANTICS_CHARS) {
  return semanticsLength(value) >= min
}

function sameSemantics(left, right) {
  return normalizedSemantics(left) === normalizedSemantics(right)
}

/** 语义字段归一：必须是字符串，非空且（折叠后）达到下限。 */
function semanticsField(value, label, options = {}) {
  const min = minSemanticsOf(options)
  if (typeof value !== 'string') throw invalid(`${label} 必须是字符串`)
  const text = value.trim()
  const length = semanticsLength(text)
  if (length === 0) throw invalid(`${label} 不能为空`)
  if (length < min) throw invalid(`${label} 至少需要 ${min} 个非空白字符（当前 ${length}）`)
  return text
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeNormalizePath(value) {
  try {
    return normalizeSourcePath(value)
  } catch {
    return null
  }
}

/** `scannedMap` 既可以是 Map，也可以是 {path: scanned} 的普通对象。 */
function scannedIndexOf(scannedMap) {
  const index = new Map()
  const put = (key, value) => {
    const relative = safeNormalizePath(key) ?? safeNormalizePath(isPlainObject(value) ? value.path : null)
    if (relative === null) return
    index.set(relative, value)
  }
  if (scannedMap instanceof Map) {
    for (const [key, value] of scannedMap) put(key, value)
    return index
  }
  if (isPlainObject(scannedMap)) {
    for (const [key, value] of Object.entries(scannedMap)) put(key, value)
  }
  return index
}

/** 记录索引：path → record（按归一化后的 path 作键，保持首个）。 */
function recordIndexOf(records) {
  const index = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record)) continue
    const relative = safeNormalizePath(record.path)
    if (relative === null || index.has(relative)) continue
    index.set(relative, record)
  }
  return index
}

// ------------------------------------------------------------------ 路径

/**
 * 规范化源码路径（spec §3）：`\`→`/`、去 `./`、折叠空段；
 * 拒绝绝对路径、`..` 与控制字符，拒绝 flow store 自身（`.agents/flow`）。
 *
 * @param {unknown} value 调用方给的路径
 * @returns {string} posix 风格的仓库相对路径
 * @throws {FlowError} code=`invalid`
 */
export function normalizeSourcePath(value) {
  if (typeof value !== 'string') throw invalid('path 必须是字符串')
  const posixValue = toPosix(value.trim())
  if (posixValue === '') throw invalid('path 不能为空')
  if (posixValue.startsWith('/')) throw invalid(`path 不能是绝对路径：${value}`)
  if (/^[A-Za-z]:/.test(posixValue)) throw invalid(`path 不能是绝对路径：${value}`)

  const segments = []
  for (const raw of posixValue.split('/')) {
    if (raw === '' || raw === '.') continue
    if (raw === '..') throw invalid(`path 不能包含 ..：${value}`)
    if (raw.includes('\0') || /[\u0000-\u001f\u007f]/.test(raw)) {
      throw invalid(`path 不能包含控制字符：${JSON.stringify(value)}`)
    }
    segments.push(raw)
  }
  if (segments.length === 0) throw invalid(`path 规范化后为空：${JSON.stringify(value)}`)

  const joined = segments.join('/')
  if (joined === '.agents/flow' || joined.startsWith('.agents/flow/')) {
    throw invalid(`path 不能指向 flow store：${joined}`)
  }
  return joined
}

/**
 * 记录文件名（不含 `.json` 后缀）：每段 `encodeURIComponent`，段内 `*`
 * 额外转成 `%2A`，段之间用 `%2F` 连接（spec §3）。
 *
 * @param {string} value 源码路径
 * @returns {string} 可逆的文件名主干
 */
export function encodePath(value) {
  const relative = normalizeSourcePath(value)
  return relative
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/\*/g, '%2A'))
    .join('%2F')
}

/**
 * `encodePath` 的逆运算。**只接受主干**：store 里文件的 `.json` 后缀由调用方
 * 先去掉再解码（否则路径自身以 `.json` 结尾时会歧义，往返不成立）。
 *
 * @param {string} id 编码后的主干
 * @returns {string} 源码路径
 */
export function decodePath(id) {
  if (typeof id !== 'string') throw invalid('id 必须是字符串')
  if (id === '') throw invalid('id 不能为空')
  const segments = id.split(/%2[fF]/)
  const decoded = segments.map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch {
      throw invalid(`id 不是合法的路径编码：${JSON.stringify(id)}`)
    }
  })
  return normalizeSourcePath(decoded.join('/'))
}

// ------------------------------------------------------------- glob（最小）

const REGEX_SPECIALS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '/'])

function escapeRegExpChar(ch) {
  return REGEX_SPECIALS.has(ch) ? `\\${ch}` : ch
}

function segmentRegExp(segment) {
  let out = ''
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += escapeRegExpChar(ch)
  }
  return out
}

/**
 * 最小 glob → RegExp（spec §3）：
 *   - `**` 作为**整段**时匹配零或多段；
 *   - `*` 段内任意串（不含分隔符）、`?` 段内单字符；
 *   - 其它字符按字面量。
 */
function globToRegExp(pattern) {
  const normalized = toPosix(String(pattern).trim())
  const segments = normalized.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return null

  let out = '^'
  // 下一个普通段前是否要补一个分隔符（`**` 的分组已经吃掉/没吃掉分隔符）。
  let slash = false
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const last = index === segments.length - 1
    if (segment === '**') {
      if (last) {
        out += index === 0 ? '.*' : '(?:/[^/]+)*'
        slash = false
      } else if (index === 0) {
        out += '(?:[^/]+/)*'
        slash = false
      } else {
        out += '(?:/[^/]+)*'
        slash = true
      }
      continue
    }
    if (slash) out += '/'
    out += segmentRegExp(segment)
    slash = true
  }
  out += '$'
  return new RegExp(out)
}

function globPathOf(value) {
  let normalized = toPosix(String(value))
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  return normalized.replace(/\/{2,}/g, '/')
}

/**
 * 构造一个 `(path) => boolean` 的匹配器（任一模式命中即 true）。
 *
 * @param {string|string[]} patterns glob 模式（数组按「或」组合）
 * @returns {(value: string) => boolean}
 */
export function globMatcher(patterns) {
  const list = Array.isArray(patterns) ? patterns : typeof patterns === 'string' ? [patterns] : null
  if (list === null) throw invalid('globMatcher 需要字符串或字符串数组')
  const regexps = list
    .filter((pattern) => typeof pattern === 'string')
    .map((pattern) => globToRegExp(pattern))
    .filter((regexp) => regexp !== null)
  return (value) => {
    if (typeof value !== 'string' || value === '') return false
    const normalized = globPathOf(value)
    if (normalized === '') return false
    return regexps.some((regexp) => regexp.test(normalized))
  }
}

/** include ∧ ¬exclude：计划/检查共用的「参与描述的文件范围」。 */
function scopeMatcherOf(contract) {
  const config = descriptionConfigOf(contract)
  const include = globMatcher(stringListOf(config.include, DEFAULT_INCLUDE))
  const exclude = globMatcher(stringListOf(config.exclude, DEFAULT_EXCLUDE))
  return (value) => include(value) && !exclude(value)
}

// --------------------------------------------------------- 只读文件系统

function absoluteOf(root, relative) {
  return resolve(root, ...relative.split('/'))
}

/**
 * 列出参与描述的文件（spec §5）：递归走目录，按 path 排序；跳过符号链接、
 * 非普通文件；include/exclude 见 §3；超过 maxFiles 只取前 maxFiles 个并给
 * 一条 warning。
 *
 * @param {string} root 项目根
 * @param {object} contract flow 契约（或只给 description 节）
 * @returns {{files: {path: string, abs: string}[], warnings: string[]}}
 */
export function listSourceFiles(root, contract) {
  if (typeof root !== 'string' || root.trim() === '') throw invalid('root 必须是项目根路径')
  const config = descriptionConfigOf(contract)
  const include = globMatcher(stringListOf(config.include, DEFAULT_INCLUDE))
  const exclude = globMatcher(stringListOf(config.exclude, DEFAULT_EXCLUDE))
  const maxFiles = positiveInt(config.maxFiles, DEFAULT_MAX_FILES)

  const base = resolve(root)
  let stats
  try {
    stats = statSync(base)
  } catch {
    throw new FlowError('not-found', `项目根不存在：${base}`)
  }
  if (!stats.isDirectory()) throw invalid(`项目根不是目录：${base}`)

  const warnings = []
  const found = []
  const walk = (relativeDir, depth) => {
    if (depth > 64) return
    const absolute = relativeDir === '' ? base : join(base, ...relativeDir.split('/'))
    let entries
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
    } catch (error) {
      warnings.push(`unreadable-dir: ${relativeDir || '.'}（${error.code ?? 'ENOENT'}）`)
      return
    }
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      // 不跟随符号链接：目录与文件都直接跳过（spec §3）。
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (exclude(relative)) continue
        walk(relative, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (exclude(relative)) continue
      if (!include(relative)) continue
      found.push(relative)
    }
  }
  walk('', 0)

  found.sort(compareText)
  if (found.length > maxFiles) {
    warnings.push(
      `max-files: 命中 ${found.length} 个文件，超过 maxFiles=${maxFiles}，只取 path 排序后的前 ${maxFiles} 个`
    )
    found.length = maxFiles
  }
  return { files: found.map((relative) => ({ path: relative, abs: absoluteOf(base, relative) })), warnings }
}

/** 文件行数：末尾换行不算多一行（`"a\n"` 是 1 行），空文件 0 行。 */
function countLines(text) {
  if (text === '') return 0
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  if (text.endsWith('\n')) lines -= 1
  return lines
}

function hashOf(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

/**
 * 读一个源文件（只读、不跟随符号链接、不出根）。
 *
 * @param {string} root 项目根
 * @param {string} value 仓库相对路径
 * @param {{maxBytes?: number, maxScanBytes?: number}} [options]
 * @returns {{text: string, hash: string, bytes: number, lines: number} | {skipped: string}}
 */
export function readSource(root, value, options = {}) {
  if (typeof root !== 'string' || root.trim() === '') throw invalid('root 必须是项目根路径')
  const maxBytes = positiveInt(options.maxBytes ?? options.maxScanBytes, DEFAULT_MAX_SCAN_BYTES)
  const relative = safeNormalizePath(value)
  if (relative === null) return { skipped: 'unsafe-path' }

  const base = resolve(root)
  const absolute = absoluteOf(base, relative)

  // 先做真实路径出根判定：中间目录可能是符号链接。
  let realBase
  try {
    realBase = realpathSync(base)
  } catch {
    realBase = base
  }
  let realFile
  try {
    realFile = realpathSync(absolute)
  } catch (error) {
    return { skipped: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'not-found' : 'unreadable' }
  }
  if (realFile !== realBase && !realFile.startsWith(realBase + sep)) return { skipped: 'outside-root' }

  let stats
  try {
    stats = lstatSync(absolute)
  } catch (error) {
    return { skipped: error.code === 'ENOENT' ? 'not-found' : 'unreadable' }
  }
  if (stats.isSymbolicLink()) return { skipped: 'symlink' }
  if (!stats.isFile()) return { skipped: 'not-regular' }
  if (stats.size > maxBytes) return { skipped: 'too-large' }

  let buffer
  try {
    buffer = readFileSync(absolute)
  } catch {
    return { skipped: 'unreadable' }
  }
  if (buffer.includes(0)) return { skipped: 'binary' }

  const text = buffer.toString('utf8')
  return { text, hash: hashOf(buffer), bytes: buffer.length, lines: countLines(text) }
}

function stripSpecifierSuffix(specifier) {
  const cut = specifier.search(/[?#]/)
  return cut === -1 ? specifier : specifier.slice(0, cut)
}

/** 依赖 spec 的 `target` 只认「存在且是普通文件」的解析结果。 */
function firstExistingFile(root, candidates) {
  for (const candidate of candidates) {
    if (candidate === '' || candidate === '.' || candidate.startsWith('../')) continue
    if (posix.isAbsolute(candidate)) continue
    const absolute = absoluteOf(resolve(root), candidate)
    try {
      if (statSync(absolute).isFile()) return candidate
    } catch {
      // 不存在就试下一个候选。
    }
  }
  return null
}

function resolveJsTarget(root, fromPath, specifier) {
  if (!specifier.startsWith('.')) return null
  const joined = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  if (joined === '.' || joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) return null
  const candidates = [joined]
  if (posix.extname(joined) === '') {
    for (const extension of JS_EXTENSIONS) candidates.push(joined + extension)
    for (const extension of JS_EXTENSIONS) candidates.push(`${joined}/index${extension}`)
  }
  return firstExistingFile(root, candidates)
}

function resolvePythonTarget(root, fromPath, specifier) {
  const match = /^(\.+)(.*)$/.exec(specifier)
  if (!match) return null
  const dots = match[1].length
  const rest = match[2]

  let base = posix.dirname(fromPath)
  if (base === '.') base = ''
  for (let index = 1; index < dots; index += 1) {
    if (base === '') return null
    base = posix.dirname(base)
    if (base === '.') base = ''
  }

  const tail = rest.replace(/^\./, '').split('.').filter((part) => part !== '').join('/')
  const prefix = base === '' ? '' : `${base}/`
  const candidates = []
  if (tail === '') {
    if (prefix === '') return null
    candidates.push(`${prefix}__init__.py`)
  } else {
    candidates.push(`${prefix}${tail}.py`)
    candidates.push(`${prefix}${tail}/__init__.py`)
  }
  return firstExistingFile(root, candidates)
}

function resolveImportTarget(root, fromPath, specifier) {
  const clean = stripSpecifierSuffix(specifier)
  if (clean === '') return null
  if (languageOf(fromPath) === 'python') return resolvePythonTarget(root, fromPath, clean)
  return resolveJsTarget(root, fromPath, clean)
}

/**
 * 把扫描器的裸 import 归一成记录形状（spec §2.2）：
 * `{specifier, kind, target}`；相对 specifier 解析不到时 target:null 且保留
 * `raw`（`ghost-import` 用）；裸包 / `node:` / 协议 URL 一律 target:null。
 */
function normalizeImports(root, fromPath, imports) {
  const out = []
  for (const entry of Array.isArray(imports) ? imports : []) {
    if (!isPlainObject(entry) || typeof entry.specifier !== 'string') continue
    const specifier = entry.specifier
    const kind = IMPORT_KINDS.has(entry.kind) ? entry.kind : 'static'
    const target = resolveImportTarget(root, fromPath, specifier)
    if (target !== null) {
      out.push({ specifier, kind, target })
      continue
    }
    if (specifier.startsWith('.')) out.push({ specifier, kind, target: null, raw: specifier })
    else out.push({ specifier, kind, target: null })
  }
  return out
}

function normalizeLanguage(value) {
  return LANGUAGES.has(value) ? value : 'unknown'
}

/**
 * 扫描一个源文件：`readSource` + `scanSource` + import target 解析。
 *
 * 返回对象额外挂一个**不可枚举**的 `text`：`createRecord` 的段注释种子要用它，
 * 但它不进 JSON、不进深比、也绝不进记录（记录 schema 里没有源码正文）。
 * 调用方若把结果展开（`{...scanned}`）会丢掉 text，此时种子退化成单模块。
 *
 * @param {string} root 项目根
 * @param {string} value 仓库相对路径
 * @param {{maxBytes?: number, maxScanBytes?: number}} [options]
 * @returns {{path: string, language: string, imports: object[], declarations: object[],
 *            hash: string, bytes: number, lines: number} | {path: string, skipped: string}}
 */
export function scanSourceAt(root, value, options = {}) {
  const relative = safeNormalizePath(value)
  if (relative === null) return { path: String(value ?? ''), skipped: 'unsafe-path' }
  const read = readSource(root, relative, options)
  if (read.skipped) return { path: relative, skipped: read.skipped }

  const scan = scanSource(relative, read.text)
  const scanned = {
    path: relative,
    language: scan.language,
    imports: normalizeImports(root, relative, scan.imports),
    declarations: Array.isArray(scan.declarations) ? scan.declarations : [],
    hash: read.hash,
    bytes: read.bytes,
    lines: read.lines,
  }
  Object.defineProperty(scanned, 'text', { value: read.text, enumerable: false, configurable: true })
  return scanned
}

// ------------------------------------------------------- 种子模块（build）

/**
 * 名字 → 模块 id 的 slug：小写、非字母数字折成 `-`、截到 41 字符。
 * 中文段名 slug 为空，由调用方回退到 `section-N`。
 */
function slugify(value) {
  let out = ''
  let dash = false
  for (const ch of String(value ?? '').toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      out += ch
      dash = false
    } else if (out !== '' && !dash) {
      out += '-'
      dash = true
    }
  }
  out = out.replace(/-+$/, '')
  if (out.length > MODULE_ID_MAX) out = out.slice(0, MODULE_ID_MAX).replace(/-+$/, '')
  return out
}

/** 同 id 冲突时依次尝试 `-2`、`-3`……（仍不超过 41 字符）。 */
function uniqueModuleId(raw, used) {
  const base = raw === '' ? 'module' : raw
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`
    const head = base.slice(0, MODULE_ID_MAX - tail.length).replace(/-+$/, '')
    const candidate = `${head === '' ? 'm' : head}${tail}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  throw invalid('模块 id 冲突过多，无法生成唯一 id')
}

function moduleOf(id, title, members) {
  return { id, title: title === '' ? id : title, semantics: '', members: [...members] }
}

/**
 * JS 段注释：列首 `// ---- 段名`（2 个以上连字符，可带尾部连字符）。
 * 返回 `{line, name}`，line 是 1-based 行号。
 */
function scanSectionMarkers(text) {
  const markers = []
  const lines = String(text ?? '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\/\/\s*-{2,}\s*(.*?)\s*$/.exec(lines[index])
    if (!match) continue
    const name = match[1].replace(/[\s-]+$/, '').trim()
    markers.push({ line: index + 1, name })
  }
  return markers
}

function baseNameWithoutExtension(relativePath) {
  const name = posix.basename(relativePath)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** JS：按段注释切段播种；无标记则单模块（文件名去扩展名 slug）。 */
function seedJsModules(scanned, declarations) {
  const text = typeof scanned.text === 'string' ? scanned.text : ''
  const markers = scanSectionMarkers(text)
  const used = new Set()
  const modules = []

  if (markers.length === 0) {
    const stem = baseNameWithoutExtension(scanned.path)
    const id = uniqueModuleId(slugify(stem), used)
    modules.push(moduleOf(id, stem === '' ? id : stem, declarations.map((declaration) => declaration.name)))
    return modules
  }

  const owned = new Set()
  const take = (from, to) => {
    const members = []
    for (const declaration of declarations) {
      if (declaration.startLine < from || declaration.startLine > to) continue
      if (owned.has(declaration.name)) continue
      owned.add(declaration.name)
      members.push(declaration.name)
    }
    return members
  }

  const head = take(1, markers[0].line)
  if (head.length > 0) modules.push(moduleOf('top', 'top', head))

  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]
    const to = index + 1 < markers.length ? markers[index + 1].line : Number.MAX_SAFE_INTEGER
    const members = take(marker.line + 1, to)
    if (members.length === 0) continue // 空段不建模块（否则 build 就自带 empty-module）
    const slug = slugify(marker.name)
    const id = uniqueModuleId(slug === '' ? `section-${index + 1}` : slug, used)
    modules.push(moduleOf(id, marker.name === '' ? `section-${index + 1}` : marker.name, members))
  }
  return modules
}

/** Python：每个 class 一个模块，其余（函数/顶层赋值）归 `top-level`。 */
function seedPythonModules(scanned, declarations) {
  const used = new Set()
  const modules = []
  const topLevel = []
  for (const declaration of declarations) {
    if (declaration.kind === 'class') {
      const id = uniqueModuleId(slugify(declaration.name), used)
      modules.push(moduleOf(id, declaration.name, [declaration.name]))
    } else {
      topLevel.push(declaration.name)
    }
  }
  if (topLevel.length > 0) {
    const id = uniqueModuleId('top-level', used)
    modules.push(moduleOf(id, 'top-level', topLevel))
  }
  return modules
}

function seedModules(scanned, declarations) {
  if (declarations.length === 0) return []
  if (scanned.language === 'js') return seedJsModules(scanned, declarations)
  if (scanned.language === 'python') return seedPythonModules(scanned, declarations)
  return []
}

// ------------------------------------------------------------ 记录播种

function declarationsOf(scanned, label) {
  if (!isPlainObject(scanned)) throw invalid(`${label} 需要扫描结果`)
  if (typeof scanned.skipped === 'string') {
    throw invalid(`${label}: 文件被跳过（${scanned.skipped}）：${scanned.path ?? ''}`)
  }
  return Array.isArray(scanned.declarations) ? scanned.declarations : []
}

/**
 * 新建一条文件记录（spec §2.2）：结构齐全、`semantics:''`；JS 按段注释种子
 * 模块、Python 按 class 种子、其它语言留空数组；模块边按种子成员现算。
 *
 * @param {object} scanned `scanSourceAt` 的成功结果
 * @param {{now?: Date|string|number}} [options]
 */
export function createRecord(scanned, options = {}) {
  if (!isPlainObject(scanned)) throw invalid('createRecord 需要扫描结果')
  if (typeof scanned.skipped === 'string') {
    throw invalid(`无法为跳过的文件建记录：${scanned.path ?? ''}（${scanned.skipped}）`)
  }
  const relative = normalizeSourcePath(scanned.path)
  const declarations = declarationsOf(scanned, 'createRecord')
  const modules = seedModules(scanned, declarations)
  const now = isoOf(options.now)
  return {
    schema: SCHEMA,
    path: relative,
    language: normalizeLanguage(scanned.language),
    hash: typeof scanned.hash === 'string' ? scanned.hash : '',
    bytes: integerOr(scanned.bytes, 0),
    lines: integerOr(scanned.lines, 0),
    semantics: '',
    modules,
    imports: normalizeImportsFromScanned(scanned),
    moduleEdges: deriveModuleEdges(modules, declarations),
    created_at: now,
    updated_at: now,
  }
}

/** scanned.imports 已是记录形状时原样保留（只剔掉非对象与非法 kind）。 */
function normalizeImportsFromScanned(scanned) {
  const out = []
  for (const entry of Array.isArray(scanned.imports) ? scanned.imports : []) {
    if (!isPlainObject(entry) || typeof entry.specifier !== 'string') continue
    const item = {
      specifier: entry.specifier,
      kind: IMPORT_KINDS.has(entry.kind) ? entry.kind : 'static',
      target: typeof entry.target === 'string' ? entry.target : null,
    }
    if (typeof entry.raw === 'string') item.raw = entry.raw
    out.push(item)
  }
  return out
}

/** 结构字段的稳定指纹（reconcile 判「有没有变化」用）。 */
function structuralKey(record) {
  return JSON.stringify({
    language: normalizeLanguage(record.language),
    hash: typeof record.hash === 'string' ? record.hash : '',
    bytes: integerOr(record.bytes, 0),
    lines: integerOr(record.lines, 0),
    imports: Array.isArray(record.imports) ? record.imports : [],
    moduleEdges: canonicalEdges(record.moduleEdges),
  })
}

/**
 * 对账（spec §5）：只同步 `hash/bytes/lines/language/imports/moduleEdges`，
 * **保留** `semantics/modules`（含已失效成员，留给 check 报 unknown-member）。
 * 无变化返回原记录且 `changed:false`（调用方据此跳过写盘）。
 *
 * @param {object} existing 现有记录
 * @param {object} scanned 最新扫描结果
 * @param {{now?: Date|string|number}} [options]
 */
export function reconcileRecord(existing, scanned, options = {}) {
  if (!isPlainObject(existing)) throw invalid('reconcileRecord 需要现有记录')
  const declarations = declarationsOf(scanned, 'reconcileRecord')
  const next = deepClone(existing)
  next.schema = Number.isInteger(next.schema) ? next.schema : SCHEMA
  next.path = normalizeSourcePath(next.path)
  next.language = normalizeLanguage(scanned.language)
  next.hash = typeof scanned.hash === 'string' ? scanned.hash : ''
  next.bytes = integerOr(scanned.bytes, 0)
  next.lines = integerOr(scanned.lines, 0)
  next.imports = normalizeImportsFromScanned(scanned)
  next.modules = Array.isArray(next.modules) ? next.modules : []
  // 2026-11-09（建议清单第 4 项）：build 对账时把「落在已有段/文件里、却不在任何
  // 模块成员表」的顶层声明自动补进对应模块。锚点就是真源：声明在哪个段就归哪个
  // 模块；无锚点的单模块文件归它的唯一模块。只追加、不删人工成员、不凭空造模块
  // （没有语义的模块会让 check 从 unassigned-member 变成 missing-semantics，等于
  // 把红挪个位置）。手工拆分过的模块表原样保留。
  const assigned = autoAssignMembers(next, scanned)
  next.modules = assigned.modules
  next.moduleEdges = deriveModuleEdges(next.modules, declarations)

  const changed =
    structuralKey(existing) !== structuralKey(next) ||
    JSON.stringify(Array.isArray(existing.modules) ? existing.modules : []) !== JSON.stringify(next.modules)
  if (!changed) return { record: existing, changed: false }
  next.updated_at = isoOf(options.now)
  return { record: next, changed: true }
}

/** 一条声明是否已被任何模块的成员表收下。 */
function memberOwnerOf(modules, name) {
  for (const module of modules) {
    if (!isPlainObject(module) || Array.isArray(module.members) === false) continue
    if (module.members.includes(name)) return module
  }
  return null
}

/**
 * 自动兜底归属（2026-11-09，建议清单第 4 项）。
 *
 * 规则（确定性、只看锚点与已有模块，不猜语义）：
 * - JS 有段锚点（`// ---- 段名`）：未归属声明落在哪个段，就补进「该段已有成员所属
 *   的模块」；该段没有任何成员时按段名 slug 找同名模块，找不到就跳过（留给 check）。
 * - 无锚点：只有**恰好一个模块**时才把未归属声明补给它（手工拆成多模块的文件保持
 *   原样，因为归属已经不可推断）；模块表为空时按文件名 stem 建一个（与
 *   `createRecord` 的播种同形）。
 * - 第一个锚点之前的声明归 `top` 模块（存在才补，不存在跳过）。
 * - 永不删除、永不重排已有成员；目标模块不存在时不复活被删模块。
 *
 * @returns `{modules}`（没有变化时返回原数组引用）
 */
export function autoAssignMembers(record, scanned) {
  if (!isPlainObject(record) || !isPlainObject(scanned)) return { modules: isPlainObject(record) && Array.isArray(record.modules) ? record.modules : [] }
  const modules = Array.isArray(record.modules) ? record.modules.map((module) => deepClone(module)) : []
  const declarations = Array.isArray(scanned.declarations) ? scanned.declarations : []
  if (declarations.length === 0) return { modules: record.modules }

  const unassigned = declarations.filter(
    (declaration) =>
      isPlainObject(declaration) &&
      typeof declaration.name === 'string' &&
      declaration.name !== '' &&
      memberOwnerOf(modules, declaration.name) === null,
  )
  if (unassigned.length === 0) return { modules: record.modules }

  const text = typeof scanned.text === 'string' ? scanned.text : ''
  const markers = normalizeLanguage(scanned.language) === 'js' ? scanSectionMarkers(text) : []
  if (markers.length === 0) {
    if (modules.length === 0) {
      const stem = baseNameWithoutExtension(record.path)
      const id = uniqueModuleId(slugify(stem), new Set())
      const created = moduleOf(id, stem === '' ? id : stem, [])
      created.members = unassigned.map((declaration) => declaration.name)
      return { modules: [...modules, created] }
    }
    if (modules.length !== 1 || isPlainObject(modules[0]) === false) return { modules: record.modules }
    appendMembers(modules[0], unassigned)
    return { modules }
  }

  const segmentIndexOf = (line) => {
    let index = -1
    for (let at = 0; at < markers.length; at += 1) {
      if (Number(line) > markers[at].line) index = at
      else break
    }
    return index
  }
  /** 段内已有成员所属的模块（去重后应唯一；多模块混居时让 check 报 duplicate）。 */
  const moduleOfSegment = (index) => {
    const from = index < 0 ? 1 : markers[index].line + 1
    const to = index + 1 < markers.length ? markers[index + 1].line : Number.MAX_SAFE_INTEGER
    const owners = new Map()
    for (const declaration of declarations) {
      if (!isPlainObject(declaration) || Number(declaration.startLine) < from || Number(declaration.startLine) >= to) continue
      const owner = memberOwnerOf(modules, declaration.name)
      if (owner !== null) owners.set(owner.id, owner)
    }
    if (owners.size === 1) return [...owners.values()][0]
    if (owners.size > 1) return null
    const wanted = index < 0 ? 'top' : slugify(markers[index].name)
    return modules.find((module) => isPlainObject(module) && module.id === wanted) ?? null
  }

  const ordered = declarations
    .filter((declaration) => isPlainObject(declaration) && Number.isFinite(Number(declaration.startLine)))
    .slice()
    .sort((left, right) => Number(left.startLine) - Number(right.startLine))
  /** 段内多模块混居时的兜底：归「最近的已归属声明」所在模块（前一个优先，再后一个）。 */
  const nearestOwnerOf = (declaration) => {
    const at = ordered.findIndex((item) => item.name === declaration.name)
    for (let index = at - 1; index >= 0; index -= 1) {
      const owner = memberOwnerOf(modules, ordered[index].name)
      if (owner !== null) return owner
    }
    for (let index = at + 1; index < ordered.length; index += 1) {
      const owner = memberOwnerOf(modules, ordered[index].name)
      if (owner !== null) return owner
    }
    return null
  }

  const grouped = new Map()
  const single = modules.length === 1 && isPlainObject(modules[0]) ? modules[0] : null
  for (const declaration of unassigned) {
    // 单模块文件里出现的「装饰性」段锚点（例如文件中间的一行 `// ---- 标题`）不改变
    // 归属：整个文件只有一个模块，未归属声明就该归它。多模块文件按段推断；段内混居
    // （同一段里有两个模块的成员）时按最近邻兜底，避免把新声明一直挂在未归属上。
    const target =
      single !== null
        ? single
        : (moduleOfSegment(segmentIndexOf(declaration.startLine)) ?? nearestOwnerOf(declaration))
    if (target === null || isPlainObject(target) === false) continue
    const bucket = grouped.get(target.id) ?? []
    bucket.push(declaration)
    grouped.set(target.id, bucket)
  }
  if (grouped.size === 0) return { modules: record.modules }
  for (const module of modules) {
    const bucket = grouped.get(module.id)
    if (bucket !== undefined && isPlainObject(module)) appendMembers(module, bucket)
  }
  return { modules }
}

/** 追加声明名（去重、保序；不改已有顺序）。 */
function appendMembers(module, declarations) {
  const members = Array.isArray(module.members) ? module.members : []
  for (const declaration of declarations) {
    if (typeof declaration.name !== 'string' || declaration.name === '') continue
    if (members.includes(declaration.name)) continue
    members.push(declaration.name)
  }
  module.members = members
}

// ------------------------------------------------------------ 模块边推导

function edgeComparator(left, right) {
  return compareText(left.from, right.from) || compareText(left.to, right.to)
}

function canonicalEdges(edges) {
  if (!Array.isArray(edges)) return []
  return edges
    .filter((edge) => isPlainObject(edge) && typeof edge.from === 'string' && typeof edge.to === 'string')
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      count: integerOr(edge.count, 0),
      why: Array.isArray(edge.why)
        ? edge.why.filter((entry) => typeof entry === 'string').slice(0, WHY_LIMIT)
        : [],
    }))
    .sort(edgeComparator)
}

/**
 * 模块边（spec §2.2）：模块 A 的成员声明在代码里引用了模块 B 的成员 ⇒ A→B。
 * `count` = 命中对数（去重），`why` = 前 3 对 `"a → b"`；边按 (from,to) 排序，
 * 自环丢弃。成员名跨模块重复时以**先出现的模块**为归属（确定性）。
 *
 * @param {object[]} modules `[{id, members}]`
 * @param {object[]} declarations `scanSource` 的 declarations
 * @returns {{from: string, to: string, count: number, why: string[]}[]}
 */
export function deriveModuleEdges(modules, declarations) {
  const owner = new Map()
  for (const module of Array.isArray(modules) ? modules : []) {
    if (!isPlainObject(module) || typeof module.id !== 'string' || module.id === '') continue
    for (const member of Array.isArray(module.members) ? module.members : []) {
      if (typeof member !== 'string' || member === '') continue
      if (!owner.has(member)) owner.set(member, module.id)
    }
  }

  const pairs = new Map() // `${from}\u0000${to}` → Map(`${a}\u0000${b}` → [a, b])
  for (const declaration of Array.isArray(declarations) ? declarations : []) {
    if (!isPlainObject(declaration) || typeof declaration.name !== 'string') continue
    const from = owner.get(declaration.name)
    if (from === undefined) continue
    const identifiers = Array.isArray(declaration.identifiers) ? declaration.identifiers : []
    for (const identifier of identifiers) {
      if (typeof identifier !== 'string') continue
      const to = owner.get(identifier)
      if (to === undefined || to === from) continue
      const edgeKey = `${from}\u0000${to}`
      let bucket = pairs.get(edgeKey)
      if (bucket === undefined) {
        bucket = new Map()
        pairs.set(edgeKey, bucket)
      }
      bucket.set(`${declaration.name}\u0000${identifier}`, [declaration.name, identifier])
    }
  }

  const edges = []
  for (const [edgeKey, bucket] of pairs) {
    const [from, to] = edgeKey.split('\u0000')
    const hits = [...bucket.values()].sort(
      (left, right) => compareText(left[0], right[0]) || compareText(left[1], right[1])
    )
    edges.push({
      from,
      to,
      count: hits.length,
      why: hits.slice(0, WHY_LIMIT).map(([source, target]) => `${source} → ${target}`),
    })
  }
  return edges.sort(edgeComparator)
}

// ---------------------------------------------------------- 文件补丁（set）

/**
 * 归一 + 校验单文件补丁（`flow desc set --input` 的一项）。
 *
 * - `id` 必须匹配 `^[a-z0-9][a-z0-9-]{0,40}$`；
 * - `members` 去重（保序）、不接受空串；
 * - `semantics` 非空且 ≥ minSemanticsChars（默认 10）；
 * - `op:'remove'` 只接受 id；`op:'add'` 必须给 semantics + 非空 members。
 *
 * @throws {FlowError} code=`invalid`
 */
export function validateFilePatch(patch, options = {}) {
  if (!isPlainObject(patch)) throw invalid('文件补丁必须是对象')
  const min = minSemanticsOf(options)
  const relative = normalizeSourcePath(patch.path)
  const normalized = { path: relative }

  if (patch.semantics !== undefined) {
    normalized.semantics = semanticsField(patch.semantics, `${relative} 的 semantics`, { minSemanticsChars: min })
  }

  if (patch.modules !== undefined) {
    if (!Array.isArray(patch.modules)) throw invalid(`${relative}: modules 必须是数组`)
    const seen = new Set()
    normalized.modules = patch.modules.map((entry, index) =>
      validateModulePatch(entry, `${relative} 第 ${index + 1} 个模块`, { minSemanticsChars: min }, seen)
    )
  }
  return normalized
}

function validateModulePatch(entry, label, options, seenIds) {
  if (!isPlainObject(entry)) throw invalid(`${label} 必须是对象`)
  if (typeof entry.id !== 'string' || !MODULE_ID_RE.test(entry.id)) {
    throw invalid(`${label} 的 id 非法：${JSON.stringify(entry.id)}（要求 ${MODULE_ID_RE}）`)
  }
  if (seenIds.has(entry.id)) throw invalid(`${label}: 同一补丁里的模块 id 重复：${entry.id}`)
  seenIds.add(entry.id)

  const module = { id: entry.id }
  if (entry.op !== undefined) {
    if (!MODULE_OPS.has(entry.op)) {
      throw invalid(`${label}: op 必须是 add|change|remove，实际 ${JSON.stringify(entry.op)}`)
    }
    module.op = entry.op
  }
  // `remove` 先判「只给 id」：否则一个语义过短的附带字段会报出误导性的长度错误。
  if (module.op === 'remove') {
    for (const key of ['title', 'semantics', 'members']) {
      if (entry[key] !== undefined) throw invalid(`${label}: op=remove 只接受 id`)
    }
    return module
  }
  if (entry.title !== undefined) {
    if (typeof entry.title !== 'string') throw invalid(`${label}: title 必须是字符串`)
    module.title = entry.title.trim()
  }
  if (entry.semantics !== undefined) {
    module.semantics = semanticsField(entry.semantics, `${label} 的 semantics`, options)
  }
  if (entry.members !== undefined) {
    module.members = memberListOf(entry.members, label)
  }

  if (module.op === 'add') {
    if (module.semantics === undefined) throw invalid(`${label}: op=add 必须给 semantics`)
    if (module.members === undefined) throw invalid(`${label}: op=add 必须给 members`)
    if (module.members.length === 0) throw invalid(`${label}: op=add 的 members 不能为空`)
    return module
  }
  if (
    module.semantics === undefined &&
    module.title === undefined &&
    module.members === undefined
  ) {
    throw invalid(`${label}: 至少给出 semantics / title / members 之一，或显式 op`)
  }
  return module
}

function memberListOf(value, label) {
  if (!Array.isArray(value)) throw invalid(`${label}: members 必须是字符串数组`)
  const seen = new Set()
  const members = []
  for (const member of value) {
    if (typeof member !== 'string') throw invalid(`${label}: members 必须是字符串数组`)
    const name = member.trim()
    if (name === '') throw invalid(`${label}: members 不能含空字符串`)
    if (seen.has(name)) continue // 归一：同模块内去重（保序）
    seen.add(name)
    members.push(name)
  }
  return members
}

/** 记录的 modules 归一（缺字段补默认，成员去重保序）。 */
function normalizeModules(modules) {
  const out = []
  for (const module of Array.isArray(modules) ? modules : []) {
    if (!isPlainObject(module) || typeof module.id !== 'string' || module.id === '') continue
    const members = []
    const seen = new Set()
    for (const member of Array.isArray(module.members) ? module.members : []) {
      if (typeof member !== 'string' || member === '' || seen.has(member)) continue
      seen.add(member)
      members.push(member)
    }
    out.push({
      id: module.id,
      title: typeof module.title === 'string' && module.title !== '' ? module.title : module.id,
      semantics: typeof module.semantics === 'string' ? module.semantics : '',
      members,
    })
  }
  return out
}

function memberOwnersOf(modules) {
  const owners = new Map()
  for (const module of modules) {
    for (const member of module.members) {
      const list = owners.get(member)
      if (list === undefined) owners.set(member, [module.id])
      else list.push(module.id)
    }
  }
  return owners
}

function duplicatedMembers(owners) {
  return new Set([...owners].filter(([, ids]) => ids.length > 1).map(([member]) => member))
}

/**
 * 把单文件补丁落进记录：`op` add/change/remove 增删改模块，成员必须真实
 * 存在于当前扫描声明；未给 `semantics` 的字段保持原值。`moduleEdges` 按新
 * 成员重新推导。无变化返回原记录且 `changed:false`。
 *
 * 注意：直接补丁的 `members` 是**整体替换**（`flow desc set` 的语义）；计划
 * 的 `members` 是**增量断言**，由 `applyPlanToRecords` 先求并集再调这里。
 *
 * @param {object} record 现有记录
 * @param {object} patch 未经归一或已归一化的单文件补丁
 * @param {object} scanned 该文件的最新扫描结果
 * @param {{now?: Date|string|number, minSemanticsChars?: number}} [options]
 * @returns {{record: object, changed: boolean}}
 */
export function applyFilePatch(record, patch, scanned, options = {}) {
  if (!isPlainObject(record)) throw invalid('applyFilePatch 需要现有记录')
  const normalized = validateFilePatch(patch, options)
  const recordPath = normalizeSourcePath(record.path)
  if (recordPath !== normalized.path) {
    throw invalid(`补丁路径与记录不一致：${normalized.path} ≠ ${recordPath}`)
  }
  const declarations = declarationsOf(scanned, 'applyFilePatch')
  const known = new Set()
  for (const declaration of declarations) {
    if (isPlainObject(declaration) && typeof declaration.name === 'string') known.add(declaration.name)
  }

  const originalModules = normalizeModules(record.modules)
  const modules = deepClone(originalModules)
  const beforeOwners = memberOwnersOf(originalModules)
  const duplicatesBefore = duplicatedMembers(beforeOwners)

  const patches = Array.isArray(normalized.modules) ? normalized.modules : []
  // 先删后改：同一个补丁里「把成员从 A 移到 B」才可行。
  for (const entry of patches.filter((item) => item.op === 'remove')) {
    const index = modules.findIndex((module) => module.id === entry.id)
    if (index === -1) throw invalid(`模块不存在，无法删除：${entry.id}`)
    modules.splice(index, 1)
  }
  for (const entry of patches.filter((item) => item.op !== 'remove')) {
    const index = modules.findIndex((module) => module.id === entry.id)
    if (entry.op === 'add' && index !== -1) throw invalid(`模块已存在：${entry.id}`)
    if (entry.op === 'change' && index === -1) throw invalid(`模块不存在：${entry.id}`)
    if (entry.members !== undefined) {
      for (const member of entry.members) {
        if (!known.has(member)) throw invalid(`成员不在扫描声明中：${member}（模块 ${entry.id}）`)
      }
    }
    if (index === -1) {
      if (entry.semantics === undefined) throw invalid(`新增模块必须给出 semantics：${entry.id}`)
      modules.push({
        id: entry.id,
        title: entry.title !== undefined && entry.title !== '' ? entry.title : entry.id,
        semantics: entry.semantics,
        members: entry.members === undefined ? [] : [...entry.members],
      })
      continue
    }
    if (entry.semantics !== undefined) modules[index].semantics = entry.semantics
    if (entry.title !== undefined) modules[index].title = entry.title === '' ? entry.id : entry.title
    if (entry.members !== undefined) modules[index].members = [...entry.members]
  }

  // 只禁止「本补丁新造出来的」跨模块重复：修一条老记录时不该被历史脏数据卡住。
  const duplicatesAfter = duplicatedMembers(memberOwnersOf(modules))
  for (const member of duplicatesAfter) {
    if (duplicatesBefore.has(member)) continue
    const ids = memberOwnersOf(modules).get(member) ?? []
    throw invalid(`成员跨模块重复：${member}（${ids.join(' / ')}）`)
  }

  const next = deepClone(record)
  next.schema = Number.isInteger(next.schema) ? next.schema : SCHEMA
  next.path = recordPath
  next.semantics = normalized.semantics !== undefined ? normalized.semantics : (typeof record.semantics === 'string' ? record.semantics : '')
  next.modules = modules
  next.moduleEdges = deriveModuleEdges(modules, declarations)

  const beforeKey = JSON.stringify({
    semantics: typeof record.semantics === 'string' ? record.semantics : '',
    modules: originalModules,
    moduleEdges: canonicalEdges(record.moduleEdges),
  })
  const afterKey = JSON.stringify({
    semantics: next.semantics,
    modules: next.modules,
    moduleEdges: next.moduleEdges,
  })
  if (beforeKey === afterKey) return { record, changed: false }
  next.updated_at = isoOf(options.now)
  return { record: next, changed: true }
}

// ------------------------------------------------------------ 计划核对

/** 检查项构造（level 见文件头）。 */
function issue(kind, path, detail, hint, options = {}) {
  const item = {
    kind,
    path,
    detail: String(detail ?? ''),
    hint: String(hint ?? ''),
    level: options.level === 'warn' ? 'warn' : 'fail',
  }
  if (typeof options.module === 'string' && options.module !== '') item.module = options.module
  return item
}

function sortIssues(items) {
  return items.sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.kind, right.kind) ||
      compareText(left.module ?? '', right.module ?? '') ||
      compareText(left.detail, right.detail)
  )
}

/**
 * 计划语义一致性核对（apply / check 共用）：把「计划要求」与「记录现状」
 * 逐项对比，返回**未落地项**（空数组 = 完全落地）。只比语义文本与结构
 * （模块存在性、成员子集），不管合法性与覆盖（那是 checkProject/checkPlan）。
 *
 * @param {object} plan 计划记录（可以是未归一的原始输入）
 * @param {object[]} records 现有文件记录
 * @returns {{kind: string, path: string, module?: string, detail: string, hint: string, level: string}[]}
 */
export function planRealization(plan, records) {
  if (!isPlainObject(plan)) return [issue('plan-missing', '.', '没有语义变更计划', 'flow desc plan <T> --input <json>')]
  const index = recordIndexOf(records)
  const items = []

  for (const entry of Array.isArray(plan.files) ? plan.files : []) {
    if (!isPlainObject(entry)) continue
    const relative = safeNormalizePath(entry.path)
    if (relative === null) {
      items.push(issue('plan-unrealized', String(entry.path ?? '.'), '计划里的路径非法', '修正计划里的 path'))
      continue
    }
    const record = index.get(relative)

    if (entry.op === 'remove') {
      if (record !== undefined) {
        items.push(issue('plan-unrealized', relative, '计划删除的文件仍有记录', 'flow desc build 或手工清理该记录'))
      }
      continue
    }
    if (record === undefined) {
      items.push(issue('missing-record', relative, '计划内文件没有描述记录', 'flow desc build'))
      continue
    }
    if (entry.semantics !== undefined && !sameSemantics(entry.semantics, record.semantics)) {
      items.push(
        issue('plan-unrealized', relative, '文件语义与计划不一致', `flow desc apply ${plan.task ?? '<T-id>'}`)
      )
    }

    const modules = normalizeModules(record.modules)
    for (const module of Array.isArray(entry.modules) ? entry.modules : []) {
      if (!isPlainObject(module) || typeof module.id !== 'string') continue
      const actual = modules.find((item) => item.id === module.id)
      if (module.op === 'remove') {
        if (actual !== undefined) {
          items.push(issue('plan-unrealized', relative, `模块 ${module.id} 应删除但仍存在`, 'flow desc apply <T-id>', { module: module.id }))
        }
        continue
      }
      if (actual === undefined) {
        items.push(issue('plan-unrealized', relative, `模块 ${module.id} 不存在`, 'flow desc apply <T-id>', { module: module.id }))
        continue
      }
      if (module.semantics !== undefined && !sameSemantics(module.semantics, actual.semantics)) {
        items.push(
          issue('plan-unrealized', relative, '模块语义与计划不一致', 'flow desc apply <T-id>', { module: module.id })
        )
      }
      if (module.title !== undefined && oneLine(module.title) !== oneLine(actual.title)) {
        items.push(issue('plan-unrealized', relative, '模块标题与计划不一致', 'flow desc apply <T-id>', { module: module.id }))
      }
      if (Array.isArray(module.members)) {
        const missing = module.members.filter(
          (member) => typeof member === 'string' && !actual.members.includes(member)
        )
        if (missing.length > 0) {
          items.push(
            issue('plan-unrealized', relative, `成员未落地：${missing.join('、')}`, 'flow desc apply <T-id>', {
              module: module.id,
            })
          )
        }
      }
    }
  }
  return items
}

// ------------------------------------------------------------ 项目检查

/**
 * 项目级漂移检查（spec §6，只读）。
 *
 * @param {{project?: object, records: object[], scannedMap: Map|object}} input
 * @param {object} contract flow 契约（或 description 节）
 * @param {{strict?: boolean, root?: string, renderText?: string,
 *          minSemanticsChars?: number}} [options]
 */
export function checkProject(input, contract, options = {}) {
  const source = isPlainObject(input) ? input : {}
  const projectProvided = source.project !== undefined
  const project = isPlainObject(source.project) ? source.project : null
  const records = Array.isArray(source.records) ? source.records.filter(isPlainObject) : []
  const scanned = scannedIndexOf(source.scannedMap)
  const config = descriptionConfigOf(contract)
  const min = positiveInt(options.minSemanticsChars ?? config.minSemanticsChars, MIN_SEMANTICS_CHARS)
  const strict = options.strict === true
  const items = []

  const recordPaths = new Set()
  for (const record of records.slice().sort((left, right) => compareText(String(left.path), String(right.path)))) {
    const relative = safeNormalizePath(record.path)
    if (relative === null) {
      items.push(issue('invalid-record', String(record.path ?? '.'), '记录里的 path 非法', 'flow desc build'))
      continue
    }
    recordPaths.add(relative)
    const scan = scanned.get(relative)
    const declarations = isPlainObject(scan) && Array.isArray(scan.declarations) ? scan.declarations : []
    const structural = isPlainObject(scan) && typeof scan.skipped !== 'string'

    if (structural) {
      if (record.hash !== scan.hash) {
        items.push(issue('stale-hash', relative, '记录 hash 与当前文件不一致', 'flow desc build'))
      }
      for (const entry of Array.isArray(scan.imports) ? scan.imports : []) {
        if (!isPlainObject(entry) || typeof entry.specifier !== 'string') continue
        if (!entry.specifier.startsWith('.')) continue
        if (entry.target !== null && entry.target !== undefined) continue
        items.push(issue('ghost-import', relative, `相对 import 解析不到目标：${entry.specifier}`, '修正 import 或补上目标文件'))
      }
    }

    const modules = normalizeModules(record.modules)
    const moduleIds = new Set(modules.map((module) => module.id))

    if (structural) {
      if (declarations.length > 0 && modules.length === 0) {
        items.push(issue('modules-missing', relative, `有 ${declarations.length} 条顶层声明但没有模块`, 'flow desc build 后补模块语义'))
      }

      const owned = new Map()
      for (const module of modules) {
        for (const member of module.members) {
          const list = owned.get(member)
          if (list === undefined) owned.set(member, [module.id])
          else list.push(module.id)
        }
      }

      for (const declaration of declarations) {
        if (!isPlainObject(declaration) || typeof declaration.name !== 'string') continue
        if (owned.has(declaration.name)) continue
        const line = integerOr(declaration.startLine, 0)
        items.push(
          issue('unassigned-member', relative, `未归属的顶层声明：${declaration.name}（第 ${line} 行）`, 'flow desc set 把它归进一个模块')
        )
      }

      const known = new Set(declarations.filter(isPlainObject).map((declaration) => declaration.name))
      for (const module of modules) {
        for (const member of module.members) {
          if (!known.has(member)) {
            items.push(
              issue('unknown-member', relative, `成员不在当前声明中：${member}`, 'flow desc build 后修正成员归属', {
                module: module.id,
              })
            )
          }
        }
      }

      for (const [member, ids] of owned) {
        if (ids.length < 2) continue
        const first = ids[0]
        if (!moduleIds.has(first)) continue
        items.push(
          issue('duplicate-member', relative, `成员被多个模块声明：${member}（${ids.join('、')}）`, 'flow desc set 删掉重复归属', {
            module: first,
          })
        )
      }
    }

    for (const module of modules) {
      if (module.members.length === 0) {
        items.push(issue('empty-module', relative, '模块没有任何成员', 'flow desc set 补成员或删除该模块', { module: module.id }))
      }
      if (!hasSemantics(module.semantics, min)) {
        items.push(
          issue('missing-semantics', relative, `模块语义缺失或不足 ${min} 个字符`, 'flow desc set --input <json>', {
            module: module.id,
          })
        )
      }
    }
    if (!hasSemantics(record.semantics, min)) {
      items.push(issue('missing-semantics', relative, `文件语义缺失或不足 ${min} 个字符`, 'flow desc set --input <json>'))
    }

    // 边：先判合法（指向未知模块 / 自环），合法的再判是否过期。
    const storedEdges = Array.isArray(record.moduleEdges) ? record.moduleEdges : []
    let invalidEdge = false
    for (const edge of storedEdges) {
      if (!isPlainObject(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
        items.push(issue('invalid-edge', relative, '模块边结构非法', 'flow desc build 重算模块边'))
        invalidEdge = true
        continue
      }
      if (!moduleIds.has(edge.from) || !moduleIds.has(edge.to) || edge.from === edge.to) {
        items.push(
          issue('invalid-edge', relative, `模块边指向未知模块或自环：${edge.from} → ${edge.to}`, 'flow desc build 重算模块边')
        )
        invalidEdge = true
      }
    }
    if (structural && !invalidEdge) {
      const derived = deriveModuleEdges(modules, declarations)
      if (JSON.stringify(canonicalEdges(storedEdges)) !== JSON.stringify(derived)) {
        items.push(issue('stale-module-edges', relative, '模块边与当前代码不一致', 'flow desc build'))
      }
    }
  }

  // 未描述文件：include 命中但没有记录（warn，strict 升级为 fail）。
  for (const relative of scanned.keys()) {
    if (recordPaths.has(relative)) continue
    if (relative === '') continue
    items.push(
      issue('undescribed-file', relative, '文件在描述范围内但没有记录', 'flow desc build 建记录后补语义', {
        level: strict ? 'fail' : 'warn',
      })
    )
  }

  if (projectProvided && project === null && records.length > 0) {
    items.push(issue('missing-semantics', '.', '缺少 project.json（项目语义无处安放）', 'flow desc build'))
  } else if (project !== null) {
    if (!hasSemantics(project.semantics, min)) {
      items.push(issue('missing-semantics', '.', `项目语义缺失或不足 ${min} 个字符`, '在 project.json 里填写 semantics 后 flow desc build'))
    }
    const renderPath = typeof config.render === 'string' ? config.render.trim() : ''
    if (renderPath !== '') {
      const actual = renderedContentOf(renderPath, options)
      if (actual === null) {
        items.push(issue('render-stale', '.', `渲染文件不存在：${renderPath}`, 'flow desc render'))
      } else if (actual !== undefined && actual !== renderMarkdown(project, records)) {
        items.push(issue('render-stale', '.', `渲染文件与现算内容不一致：${renderPath}`, 'flow desc render'))
      }
    }
  }

  return sortIssues(items)
}

/** 渲染文件的现状：字符串（已归一 CRLF）或 null（不存在）；undefined = 读不到。 */
function renderedContentOf(renderPath, options) {
  if (typeof options.renderText === 'string') return options.renderText.replace(/\r\n/g, '\n')
  if (typeof options.root !== 'string' || options.root.trim() === '') return undefined
  const base = resolve(options.root)
  const absolute = resolve(base, renderPath)
  if (absolute !== base && !absolute.startsWith(base + sep)) return undefined
  try {
    return readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n')
  } catch (error) {
    return error.code === 'ENOENT' ? null : undefined
  }
}

// ------------------------------------------------------------ 计划归一

function normalizeBase(value, now) {
  if (value === undefined || value === null) return { commit: null, clean: true, recorded_at: now }
  if (!isPlainObject(value)) throw invalid('计划 base 必须是对象')
  let commit = null
  if (value.commit !== undefined && value.commit !== null) {
    if (typeof value.commit !== 'string' || value.commit.trim() === '' || /\s/.test(value.commit)) {
      throw invalid(`计划 base.commit 非法：${JSON.stringify(value.commit)}`)
    }
    commit = value.commit.trim()
  }
  let clean = true
  if (value.clean !== undefined) {
    if (typeof value.clean !== 'boolean') throw invalid('计划 base.clean 必须是布尔值')
    clean = value.clean
  }
  return {
    commit,
    clean,
    recorded_at: typeof value.recorded_at === 'string' && value.recorded_at !== '' ? value.recorded_at : now,
  }
}

function normalizeHistoryEntry(entry, now) {
  if (!isPlainObject(entry)) return null
  return {
    at: typeof entry.at === 'string' && entry.at !== '' ? entry.at : now,
    stage: typeof entry.stage === 'string' ? entry.stage : '',
    note: typeof entry.note === 'string' ? entry.note : '',
  }
}

function normalizePlanModule(entry, label, options, seenIds) {
  if (!isPlainObject(entry)) throw invalid(`${label} 必须是对象`)
  const normalized = validateModulePatch(entry, label, options, seenIds)
  // 计划的模块 op 缺省按 change 落地：apply 是声明式的（存在即改、不存在即增）。
  if (normalized.op === undefined) normalized.op = 'change'
  if (normalized.op === 'change' && normalized.semantics === undefined && normalized.members === undefined && normalized.title === undefined) {
    throw invalid(`${label}: op=change 至少给 semantics/title/members 之一`)
  }
  return normalized
}

function normalizePlanFile(entry, index, options) {
  if (!isPlainObject(entry)) throw invalid(`计划 files[${index}] 必须是对象`)
  const relative = normalizeSourcePath(entry.path)
  if (!FILE_OPS.has(entry.op)) {
    throw invalid(`计划 files[${index}]（${relative}）的 op 必须是 add|change|remove`)
  }
  const out = { path: relative, op: entry.op }

  if (entry.op === 'remove') {
    if (entry.semantics !== undefined || entry.modules !== undefined) {
      throw invalid(`${relative}: op=remove 只接受 path`)
    }
    return out
  }

  if (entry.semantics !== undefined) {
    out.semantics = semanticsField(entry.semantics, `${relative} 的 semantics`, options)
  }
  if (entry.op === 'add' && out.semantics === undefined) {
    throw invalid(`${relative}: op=add 必须给 semantics`)
  }

  const modules = []
  if (entry.modules !== undefined) {
    if (!Array.isArray(entry.modules)) throw invalid(`${relative}: modules 必须是数组`)
    const seen = new Set()
    entry.modules.forEach((module, moduleIndex) => {
      modules.push(normalizePlanModule(module, `${relative} 第 ${moduleIndex + 1} 个模块`, options, seen))
    })
  }
  if (entry.op === 'add' && modules.length === 0) {
    throw invalid(`${relative}: op=add 必须给至少一个模块`)
  }
  if (modules.length > 0) out.modules = modules
  return out
}

/**
 * 归一 + 校验计划输入（spec §2.3）：`files` 非空 **xor**
 * `noSemanticChange:true` + 非空 `reason`；每次修订追加一条 history。
 *
 * @param {object} input CLI/调用方给的原始计划
 * @param {{task?: string, now?: Date|string|number, stage?: string,
 *          base?: object, minSemanticsChars?: number}} [options]
 */
export function normalizePlanInput(input, options = {}) {
  if (!isPlainObject(input)) throw invalid('计划必须是对象')
  const now = isoOf(options.now)
  const min = minSemanticsOf(options)
  const label = { minSemanticsChars: min }

  const task = typeof options.task === 'string' && options.task !== '' ? options.task : input.task
  if (typeof task !== 'string' || !TASK_ID_RE.test(task)) {
    throw invalid(`计划缺少合法的任务 id：${JSON.stringify(task)}`)
  }

  const noSemanticChange = input.noSemanticChange === true
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (input.noSemanticChange !== undefined && typeof input.noSemanticChange !== 'boolean') {
    throw invalid('计划 noSemanticChange 必须是布尔值')
  }

  let files = []
  if (input.files !== undefined) {
    if (!Array.isArray(input.files)) throw invalid('计划 files 必须是数组')
    files = input.files.map((entry, index) => normalizePlanFile(entry, index, label))
  }

  if (noSemanticChange && files.length > 0) throw invalid('noSemanticChange 与 files 不能同时给出')
  if (!noSemanticChange && files.length === 0) {
    throw invalid('计划必须给出 files，或 noSemanticChange:true 加 reason')
  }
  if (noSemanticChange && reason === '') throw invalid('noSemanticChange 必须给出非空 reason')

  const seen = new Set()
  for (const file of files) {
    if (seen.has(file.path)) throw invalid(`计划里同一路径出现多次：${file.path}`)
    seen.add(file.path)
  }

  const status = input.status === 'implemented' ? 'implemented' : 'planned'
  const implementedAt = status === 'implemented'
    ? (typeof input.implemented_at === 'string' && input.implemented_at !== '' ? input.implemented_at : now)
    : null

  const history = []
  for (const entry of Array.isArray(input.history) ? input.history : []) {
    const normalized = normalizeHistoryEntry(entry, now)
    if (normalized !== null) history.push(normalized)
  }
  const stage = typeof options.stage === 'string' && options.stage !== ''
    ? options.stage
    : (typeof input.stage === 'string' ? input.stage : 'analyzing')
  const note = typeof input.note === 'string' ? input.note : ''
  history.push({ at: now, stage, note })

  return {
    schema: SCHEMA,
    task,
    status,
    base: normalizeBase(options.base !== undefined ? options.base : input.base, now),
    noSemanticChange,
    reason,
    files,
    created_at: typeof input.created_at === 'string' && input.created_at !== '' ? input.created_at : now,
    updated_at: now,
    implemented_at: implementedAt,
    history,
  }
}

/**
 * 把计划语义落进记录（spec §5/§7）：声明式、可重复执行——第二次返回
 * `applied:false`。计划里模块的 `members` 是**增量断言**（并集），不是整体
 * 替换；结构性不可能（成员不在当前声明、删除不存在的模块）抛 `invalid`。
 *
 * @param {object} plan 计划记录
 * @param {object[]} records 现有文件记录
 * @param {Map|object} scannedMap path → scanned
 * @param {{now?: Date|string|number, minSemanticsChars?: number}} [options]
 * @returns {{records: object[], applied: boolean}}
 */
export function applyPlanToRecords(plan, records, scannedMap, options = {}) {
  if (!isPlainObject(plan)) throw invalid('applyPlanToRecords 需要计划记录')
  if (!Array.isArray(records)) throw invalid('applyPlanToRecords 需要记录数组')
  const scanned = scannedIndexOf(scannedMap)
  const working = records.filter(isPlainObject).map((record) => deepClone(record))
  let applied = false

  for (const entry of Array.isArray(plan.files) ? plan.files : []) {
    if (!isPlainObject(entry)) continue
    const relative = normalizeSourcePath(entry.path)
    const index = working.findIndex((record) => safeNormalizePath(record.path) === relative)

    if (entry.op === 'remove') {
      if (index !== -1) {
        working.splice(index, 1)
        applied = true
      }
      continue
    }

    const fileScan = scanned.get(relative)
    if (!isPlainObject(fileScan) || typeof fileScan.skipped === 'string') {
      throw invalid(`计划内文件没有可用扫描结果：${relative}（先跑 flow desc build）`)
    }

    let target = index === -1 ? createRecord(fileScan, { now: options.now }) : working[index]
    if (index === -1) applied = true

    const patch = { path: relative }
    if (entry.semantics !== undefined) patch.semantics = entry.semantics
    const modules = []
    for (const module of Array.isArray(entry.modules) ? entry.modules : []) {
      if (!isPlainObject(module) || typeof module.id !== 'string') continue
      const existing = normalizeModules(target.modules).find((item) => item.id === module.id)
      if (module.op === 'remove') {
        if (existing === undefined) continue // 幂等：已经删掉了
        modules.push({ id: module.id, op: 'remove' })
        continue
      }
      if (existing === undefined && module.semantics === undefined) {
        throw invalid(`计划新增模块缺 semantics：${relative}#${module.id}`)
      }
      const next = { id: module.id }
      if (module.title !== undefined) next.title = module.title
      if (module.semantics !== undefined) next.semantics = module.semantics
      if (Array.isArray(module.members)) {
        // 增量断言：并集（记录里已有但计划没提的成员保持不变）。
        next.members = [...new Set([...(existing === undefined ? [] : existing.members), ...module.members])]
      }
      modules.push(next)
    }
    if (modules.length > 0) patch.modules = modules

    const result = applyFilePatch(target, patch, fileScan, options)
    target = result.record
    if (result.changed) applied = true
    if (index === -1) working.push(target)
    else working[index] = target
  }

  working.sort((left, right) => compareText(String(left.path), String(right.path)))
  return { records: working, applied }
}

// ------------------------------------------------------------ 计划检查

function parseTime(value) {
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 测试证据起点 = max(implemented_at, 计划内记录 updated_at)（spec §2.3/§7）。 */
function testEvidenceFloor(plan, records) {
  const planned = new Set()
  for (const entry of Array.isArray(plan.files) ? plan.files : []) {
    const relative = isPlainObject(entry) ? safeNormalizePath(entry.path) : null
    if (relative !== null) planned.add(relative)
  }
  let floor = parseTime(plan.implemented_at)
  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record)) continue
    const relative = safeNormalizePath(record.path)
    if (relative === null || !planned.has(relative)) continue
    const updated = parseTime(record.updated_at)
    if (updated > floor) floor = updated
  }
  return floor
}

function opMatches(plannedOp, actualStatus) {
  if (plannedOp === 'add') return actualStatus === 'add'
  if (plannedOp === 'remove') return actualStatus === 'remove'
  return actualStatus === 'change'
}

/**
 * 阶段门用的计划检查（spec §7）。
 *
 * @param {object} plan 计划记录（可以是未归一的原始输入）
 * @param {{records: object[], scannedMap: Map|object, root?: string,
 *          contract?: object, requireTests?: boolean, gateRuns?: object[],
 *          project?: object, minSemanticsChars?: number}} context
 * @returns {{kind: string, path: string, module?: string, detail: string, hint: string, level: string}[]}
 */
export function checkPlan(plan, context = {}) {
  if (!isPlainObject(plan)) {
    return [issue('plan-missing', '.', '任务没有语义变更计划', 'flow desc plan <T-id> --input <json>')]
  }
  const records = Array.isArray(context.records) ? context.records.filter(isPlainObject) : []
  const scanned = scannedIndexOf(context.scannedMap)
  const contract = isPlainObject(context.contract) ? context.contract : {}
  const config = descriptionConfigOf(contract)
  const min = positiveInt(context.minSemanticsChars ?? config.minSemanticsChars, MIN_SEMANTICS_CHARS)
  const items = []

  if (plan.status !== 'implemented') {
    items.push(
      issue('plan-unrealized', '.', `计划状态是 ${plan.status ?? 'planned'}，还没有 apply`, `flow desc apply ${plan.task ?? '<T-id>'}`)
    )
  }

  items.push(...planRealization(plan, records))

  // 计划内文件必须通过 §6 的全量检查（只取计划路径与项目级项）。
  const plannedPaths = new Set()
  for (const entry of Array.isArray(plan.files) ? plan.files : []) {
    if (!isPlainObject(entry)) continue
    const relative = safeNormalizePath(entry.path)
    if (relative !== null) plannedPaths.add(relative)
    if (entry.op === 'remove') continue
    if (relative !== null && !scanned.has(relative)) {
      items.push(issue('plan-unrealized', relative, '计划内文件不存在或不在扫描范围', '确认文件已写好后重跑 flow desc build'))
    }
  }
  const projectItems = checkProject(
    {
      project: context.project,
      records,
      scannedMap: context.scannedMap,
    },
    contract,
    { strict: false, minSemanticsChars: min }
  )
  for (const item of projectItems) {
    if (item.level !== 'fail') continue
    if (item.path === '.' || plannedPaths.has(item.path)) items.push(item)
  }

  // 未计划改动（gitCheck 且 git 可用时）；git 不可用只给 warning。
  const gitCheck = config.gitCheck !== false
  if (gitCheck) {
    const probe = gitProbe(context.root)
    if (!probe.ok) {
      items.push(
        issue('git-unavailable', '.', `git 不可用（${probe.reason ?? 'unknown'}），跳过未计划改动检查`, '在 git 工作树里执行', {
          level: 'warn',
        })
      )
    } else {
      const base = isPlainObject(plan.base) && typeof plan.base.commit === 'string' ? plan.base.commit : null
      if (base === null) {
        items.push(
          issue('git-base-changed', '.', '计划没有记录 base.commit，无法比对未计划改动', `flow desc plan ${plan.task ?? '<T-id>'} --rebase`, {
            level: 'warn',
          })
        )
      } else {
        const changed = gitChangedFiles(context.root, base, scopeMatcherOf(contract))
        if (!changed.ok) {
          items.push(
            issue('git-base-changed', '.', `计划 base 提交不可用（${changed.reason ?? 'unknown'}）`, `flow desc plan ${plan.task ?? '<T-id>'} --rebase`, {
              level: 'warn',
            })
          )
        } else {
          const plannedOps = new Map()
          for (const entry of Array.isArray(plan.files) ? plan.files : []) {
            if (!isPlainObject(entry)) continue
            const relative = safeNormalizePath(entry.path)
            if (relative !== null) plannedOps.set(relative, entry.op)
          }
          for (const file of changed.files) {
            const plannedOp = plannedOps.get(file.path)
            if (plannedOp === undefined) {
              items.push(
                issue('unplanned-change', file.path, `计划外的改动（${file.status}）`, '把它写进计划，或还原这处改动')
              )
              continue
            }
            if (!opMatches(plannedOp, file.status)) {
              items.push(
                issue(
                  'unplanned-change',
                  file.path,
                  `计划 op=${plannedOp}，实际是 ${file.status}`,
                  '修正计划里的 op 或还原这处改动'
                )
              )
            }
          }
        }
      }
    }
  }

  // 测试证据：testGate 最近一条通过记录的 finished_at 必须晚于起点。
  const requireTests = context.requireTests === true
  const testGate = typeof config.testGate === 'string' ? config.testGate.trim() : ''
  if (requireTests && testGate !== '') {
    const floor = testEvidenceFloor(plan, records)
    let best = null
    for (const run of Array.isArray(context.gateRuns) ? context.gateRuns : []) {
      if (!isPlainObject(run)) continue
      const gate = typeof run.gate === 'string' ? run.gate : run.id
      if (gate !== testGate || run.ok !== true) continue
      const at = parseTime(run.finished_at)
      if (at === 0) continue
      if (best === null || at > best.at) best = { at, run }
    }
    if (best === null) {
      items.push(issue('tests-missing', '.', `没有 ${testGate} 的通过记录`, `flow gate run ${testGate}`))
    } else if (best.at < floor) {
      items.push(
        issue(
          'tests-missing',
          '.',
          `${testGate} 的最近一条通过记录（${best.run.finished_at}）早于要求的时间点`,
          `重跑 flow gate run ${testGate}`
        )
      )
    }
  }

  return sortIssues(items)
}

// ------------------------------------------------------------ 汇总 / 渲染

/**
 * 计数（project.json 的 counts 缓存）：`missingSemantics` 按**待填单元**计
 * （文件 1 + 每个模块 1），`described` 只数通过语义下限的文件。
 *
 * @param {object[]} records
 * @param {{minSemanticsChars?: number}} [options]
 */
export function summarize(records, options = {}) {
  const min = minSemanticsOf(options)
  const list = Array.isArray(records) ? records.filter(isPlainObject) : []
  let modules = 0
  let described = 0
  let missingSemantics = 0
  for (const record of list) {
    if (hasSemantics(record.semantics, min)) described += 1
    else missingSemantics += 1
    const recordModules = normalizeModules(record.modules)
    modules += recordModules.length
    for (const module of recordModules) {
      if (!hasSemantics(module.semantics, min)) missingSemantics += 1
    }
  }
  return { files: list.length, modules, described, missingSemantics }
}

function escapeMermaidLabel(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '&quot;')
}

function tableCell(value) {
  const text = oneLine(value)
  return text === '' ? '（未描述）' : text.replace(/\|/g, '\\|')
}

function memberCell(members) {
  return members.length === 0 ? '（无）' : members.join('、')
}

/** 文件关系图：节点按 path 序号，边按 (from,to)；根目录文件在子图之外。 */
function fileGraphLines(list) {
  const ids = new Map(list.map((record, index) => [record.path, `n${index}`]))
  const groups = new Map()
  const roots = []
  for (const record of list) {
    const slash = record.path.indexOf('/')
    if (slash === -1) {
      roots.push(record)
      continue
    }
    const group = record.path.slice(0, slash)
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(record)
  }

  const lines = ['graph LR']
  for (const record of roots) {
    lines.push(`  ${ids.get(record.path)}["${escapeMermaidLabel(record.path)}"]`)
  }
  for (const group of [...groups.keys()].sort(compareText)) {
    if (/^[A-Za-z0-9_.-]+$/.test(group)) lines.push(`  subgraph ${group}`)
    else lines.push(`  subgraph g_${escapeMermaidLabel(group).replace(/[^A-Za-z0-9_]/g, '_')}["${escapeMermaidLabel(group)}"]`)
    for (const record of groups.get(group)) {
      lines.push(`    ${ids.get(record.path)}["${escapeMermaidLabel(record.path)}"]`)
    }
    lines.push('  end')
  }

  const edges = new Set()
  for (const record of list) {
    for (const entry of Array.isArray(record.imports) ? record.imports : []) {
      if (!isPlainObject(entry) || typeof entry.target !== 'string') continue
      const target = safeNormalizePath(entry.target)
      if (target === null || target === record.path) continue
      if (!ids.has(target)) continue
      edges.add(`${record.path}\u0000${target}`)
    }
  }
  const ordered = [...edges]
    .map((key) => key.split('\u0000'))
    .sort((left, right) => compareText(left[0], right[0]) || compareText(left[1], right[1]))
  for (const [from, to] of ordered) {
    lines.push(`  ${ids.get(from)} --> ${ids.get(to)}`)
  }
  return lines
}

/** 模块图：只画 (from,to) 都在本文件模块表里的边。 */
function moduleGraphLines(record) {
  const modules = normalizeModules(record.modules)
  const ids = new Map(modules.map((module, index) => [module.id, `m${index}`]))
  const edges = canonicalEdges(record.moduleEdges).filter(
    (edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to
  )
  if (edges.length === 0) return []
  const lines = ['graph LR']
  for (const edge of edges) {
    lines.push(`  ${ids.get(edge.from)}["${escapeMermaidLabel(edge.from)}"] --> ${ids.get(edge.to)}["${escapeMermaidLabel(edge.to)}"]`)
  }
  return lines
}

/**
 * 确定性 Markdown（spec §10 骨架）：文件按 path、模块按记录顺序、边按
 * (from,to)；Mermaid 节点 id 用序号、标签转引义号。**不含墙钟时间**：
 * 同样的 project + records 永远渲染出同样的字节。
 *
 * @param {object} project project.json
 * @param {object[]} records 文件记录
 * @returns {string}
 */
export function renderMarkdown(project, records) {
  const name = isPlainObject(project) && typeof project.name === 'string' && project.name.trim() !== ''
    ? project.name.trim()
    : '（未命名）'
  const list = (Array.isArray(records) ? records.filter(isPlainObject) : [])
    .map((record) => ({ ...record, path: safeNormalizePath(record.path) ?? String(record.path ?? '') }))
    .sort((left, right) => compareText(left.path, right.path))
  const stats = summarize(list)

  const lines = []
  lines.push(`# 项目描述：${name}`)
  lines.push('')
  lines.push('> 生成物：由 `flow desc render` 从 `.agents/description/` 生成，不要手改。')
  lines.push(`> 文件 ${stats.files} ｜ 模块 ${stats.modules} ｜ 未描述 ${stats.missingSemantics}`)
  lines.push('')
  lines.push('## 1 项目语义')
  lines.push('')
  lines.push(oneLine(isPlainObject(project) ? project.semantics : '') === '' ? '（未描述）' : String(project.semantics).trim())
  lines.push('')
  lines.push('## 2 文件关系图')
  lines.push('')
  if (list.length === 0) {
    lines.push('（无文件）')
  } else {
    lines.push('```mermaid')
    for (const line of fileGraphLines(list)) lines.push(line)
    lines.push('```')
  }
  lines.push('')
  lines.push('## 3 文件与模块')
  lines.push('')
  if (list.length === 0) {
    lines.push('（无文件）')
  }
  list.forEach((record, index) => {
    lines.push(`### 3.${index + 1} ${record.path}`)
    lines.push('')
    lines.push(oneLine(record.semantics) === '' ? '（未描述）' : String(record.semantics).trim())
    lines.push('')
    const graph = moduleGraphLines(record)
    if (graph.length > 0) {
      lines.push('```mermaid')
      for (const line of graph) lines.push(line)
      lines.push('```')
      lines.push('')
    }
    const modules = normalizeModules(record.modules)
    if (modules.length === 0) {
      lines.push('（无模块）')
      lines.push('')
      return
    }
    lines.push('| 模块 | 语义 | 成员 |')
    lines.push('|---|---|---|')
    for (const module of modules) {
      lines.push(`| ${module.id.replace(/\|/g, '\\|')} | ${tableCell(module.semantics)} | ${memberCell(module.members)} |`)
    }
    lines.push('')
  })

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return `${lines.join('\n')}\n`
}

// ------------------------------------------------------------------ git

const GIT_TIMEOUT_MS = 15000

function runGit(root, args) {
  let result
  try {
    result = spawnSync('git', ['-C', root, '-c', 'core.quotepath=false', ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch {
    return { ok: false, reason: 'git-failed', stdout: '' }
  }
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, reason: result.error.code === 'ENOENT' ? 'git-not-installed' : 'git-failed', stdout: '' }
  }
  if (result.status !== 0) return { ok: false, reason: 'git-failed', stdout: String(result.stdout ?? '') }
  return { ok: true, stdout: String(result.stdout ?? '') }
}

/**
 * git 探测：`{ok, head, reason?}`。不是工作树 / 没有提交 / 没装 git 都返回
 * `ok:false`（调用方降级为 warning，不阻断）。
 *
 * @param {string} root 项目根
 */
export function gitProbe(root) {
  if (typeof root !== 'string' || root.trim() === '') return { ok: false, head: null, reason: 'no-root' }
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) {
    return { ok: false, head: null, reason: inside.reason === 'git-not-installed' ? 'git-not-installed' : 'not-a-repository' }
  }
  if (inside.stdout.trim() !== 'true') return { ok: false, head: null, reason: 'not-a-work-tree' }
  const head = runGit(root, ['rev-parse', 'HEAD'])
  if (!head.ok || head.stdout.trim() === '') return { ok: false, head: null, reason: 'no-commits' }
  return { ok: true, head: head.stdout.trim() }
}

function statusOfGitCode(code) {
  if (code === 'A') return 'add'
  if (code === 'D') return 'remove'
  return 'change'
}

/**
 * base 之后的改动 + 未跟踪文件：`{ok, files:[{path,status}], reason?}`。
 * `status` 是 `add|change|remove`；`matcher(path)` 为假但不删掉（过滤交给
 * 调用方）时直接跳过。base 不存在 / git 不可用返回 `ok:false`。
 *
 * @param {string} root
 * @param {string} baseCommit
 * @param {(path: string) => boolean} [matcher]
 */
export function gitChangedFiles(root, baseCommit, matcher) {
  const probe = gitProbe(root)
  if (!probe.ok) return { ok: false, files: [], reason: probe.reason }
  if (typeof baseCommit !== 'string' || baseCommit.trim() === '' || /\s/.test(baseCommit)) {
    return { ok: false, files: [], reason: 'base-missing' }
  }
  const base = baseCommit.trim()
  if (!runGit(root, ['cat-file', '-e', `${base}^{commit}`]).ok) {
    return { ok: false, files: [], reason: 'base-missing' }
  }

  const changed = new Map()
  const diff = runGit(root, ['diff', '--name-status', '--no-renames', '-z', base, '--'])
  if (!diff.ok) return { ok: false, files: [], reason: 'diff-failed' }
  const diffTokens = diff.stdout.split('\0').filter((token) => token !== '')
  for (let index = 0; index + 1 < diffTokens.length; index += 2) {
    const code = diffTokens[index]
    const filePath = diffTokens[index + 1]
    if (typeof code !== 'string' || code === '' || typeof filePath !== 'string' || filePath === '') continue
    changed.set(filePath, statusOfGitCode(code.slice(0, 1)))
  }

  const status = runGit(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'])
  if (!status.ok) return { ok: false, files: [], reason: 'status-failed' }
  for (const entry of status.stdout.split('\0')) {
    if (entry.length < 4 || entry.slice(0, 2) !== '??') continue
    changed.set(entry.slice(3), 'add')
  }

  const matches = typeof matcher === 'function' ? matcher : () => true
  const files = [...changed]
    .filter(([filePath]) => matches(filePath))
    .map(([filePath, fileStatus]) => ({ path: filePath, status: fileStatus }))
    .sort((left, right) => compareText(left.path, right.path))
  return { ok: true, files }
}
