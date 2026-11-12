// CLI 共用助手（自 bin/flow.mjs 原样搬出）
//
// 纯搬移：函数体与 bin 中逐字一致；error/warning/输出/读取助手
// 由 bin 入口与 lib/cli/* 命令模块共用。命令模块不得反向 import bin。
//
// 例外：`--input` 支持「JSON 文件路径」，因此 `readJsonValue` 需要
// `node:fs`/`node:path`；其余函数仍是纯搬移。

import path from 'node:path'
import { readFileSync } from 'node:fs'

export class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

export let jsonMode = false

/** 入口在 main() 里设置一次；ESM live binding 让命令模块读到同一份状态。 */
export function setJsonMode(value) {
  jsonMode = value
}

// Warnings are collected from two sources — `loadContract().warnings` (manifest
// diagnostics) and `core.drainWarnings()` (lock takeover, unreadable records,
// containment, gate expect typos) — and surfaced exactly once per invocation:
// `warnings: [...]` in the `--json` envelope, `警告: <text>` on stderr otherwise.
export const pendingWarnings = []

export let coreRef = null

/** 入口装载 core 后注入；loadTypeMap/check 的少量读路径仍需要原始 core。 */
export function setCoreRef(value) {
  coreRef = value
}

export function out(text) {
  process.stdout.write(`${text}\n`)
}

export function errOut(text) {
  process.stderr.write(`${text}\n`)
}

export function emitJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

export function charWidth(ch) {
  const cp = ch.codePointAt(0)
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2
  }
  return 1
}

export function textWidth(value) {
  let width = 0
  for (const ch of String(value)) width += charWidth(ch)
  return width
}

// ⚠ 与 `lib/util.mjs` 的 `pad` **同名不同物，绝不可去重**：这里是 CLI 表格列补齐
// （按显示宽度 `textWidth` 算、支持左右对齐）；util 那个是 `padStart(width,'0')`
// 的时间戳补零。按名字合并会把 CLI 表格整列对齐改坏。
export function pad(value, width, align = 'left') {
  const text = String(value ?? '')
  const diff = width - textWidth(text)
  if (diff <= 0) return text
  return align === 'right' ? ' '.repeat(diff) + text : text + ' '.repeat(diff)
}

export function clip(value, max = 60) {
  const text = String(value ?? '')
  if (textWidth(text) <= max) return text
  let width = 0
  let result = ''
  for (const ch of text) {
    width += charWidth(ch)
    if (width > max - 1) break
    result += ch
  }
  return `${result}…`
}

export function table(headers, rows, aligns = []) {
  const widths = headers.map((header, index) =>
    Math.max(textWidth(header), ...rows.map((row) => textWidth(row[index] ?? ''))),
  )
  const render = (cells) =>
    cells
      .map((cell, index) => pad(cell ?? '', widths[index], aligns[index]))
      .join('  ')
      .replace(/\s+$/, '')
  return [
    render(headers),
    widths.map((width) => '─'.repeat(width)).join('  '),
    ...rows.map(render),
  ].join('\n')
}

export function fmtTime(iso) {
  if (!iso) return '-'
  return String(iso).replace('T', ' ').slice(0, 16)
}

export function fmtDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '-'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 10000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.round(value / 1000)}s`
}

/** Append warnings, skipping non-strings and duplicates (order preserved). */
export function collectWarnings(list) {
  if (!Array.isArray(list)) return
  for (const item of list) {
    if (typeof item !== 'string' || item === '') continue
    if (pendingWarnings.includes(item) === false) pendingWarnings.push(item)
  }
}

/** Take (and clear) the core diagnostic log; safe before core loads. */
export function drainCoreWarnings() {
  try {
    if (coreRef !== null && typeof coreRef.drainWarnings === 'function') collectWarnings(coreRef.drainWarnings())
  } catch {
    // Diagnostics must never fail a command.
  }
}

/** Contract for `root` with its manifest warnings collected (cached per root). */
export function loadContractFor(ctx, root) {
  if (ctx.contract !== null && ctx.contractRoot === root) return ctx.contract
  const loaded = ctx.core.loadContract(root)
  collectWarnings(loaded.warnings)
  ctx.contract = loaded.contract
  ctx.contractRoot = root
  return ctx.contract
}

/** Print the collected warnings (human mode only; `--json` carries them in the envelope). */
export function printWarnings() {
  for (const warning of pendingWarnings) errOut(`警告: ${warning}`)
}

export function readString(flags, name) {
  if (flags[name] === undefined) return undefined
  return String(flags[name])
}

export function readInteger(flags, name) {
  if (flags[name] === undefined) return undefined
  const value = Number(flags[name])
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError('usage', `--${name} 需要一个非负整数`)
  }
  return value
}

export function readPositiveInteger(flags, name, hint) {
  if (flags[name] === undefined) return undefined
  const value = Number(flags[name])
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError('usage', hint || `--${name} 需要一个正整数`)
  }
  return value
}

export function readJsonObject(flags, name) {
  const raw = readString(flags, name)
  if (raw === undefined) return undefined
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CliError('usage', `--${name} 需要合法 JSON，例如 '{"tie":0.5}'`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('usage', `--${name} 需要一个 JSON 对象`)
  }
  return parsed
}

/** `--input` 的两种写法提示（内联 JSON / JSON 文件路径）；错误消息统一带它。 */
function jsonInputHint(name) {
  return `写法：--${name} '{"files":[…]}'（内联 JSON 对象或数组）或 --${name} plan.json（JSON 文件路径）`
}

/**
 * `--input` 的读入层（对象**或数组**：`desc set` 的单/多文件补丁）。
 *
 * 两种写法：首字符（去前导空白/BOM 后）是 `{` 或 `[` 当内联 JSON，否则当
 * JSON 文件路径（相对 `baseDir`，与 `--type-map` 一样以项目根为基准）。
 * 与 `readJsonObject` 分开是因为「对象数组」在这条通道上是合法形状，而
 * `readJsonObject` 的契约（exp --metrics、decision 输入）明确拒绝数组。
 */
export function readJsonValue(flags, name, baseDir = process.cwd()) {
  const raw = readString(flags, name)
  if (raw === undefined) return undefined
  const text = raw.replace(/^\uFEFF/, '').trim()
  if (text === '') {
    throw new CliError('usage', `--${name} 不能为空\n${jsonInputHint(name)}`)
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new CliError('usage', `--${name} 内联 JSON 不合法：${error.message}\n${jsonInputHint(name)}`)
    }
  }
  const file = path.isAbsolute(text) ? text : path.resolve(baseDir, text)
  let body
  try {
    body = readFileSync(file, 'utf8')
  } catch (error) {
    const why = error?.code === 'EISDIR' ? '是一个目录，不是文件' : `读不到（${error?.code ?? error?.message}）`
    throw new CliError('usage', `--${name} 文件${why}：${raw}\n${jsonInputHint(name)}`)
  }
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new CliError('usage', `--${name} 文件不是合法 JSON：${raw}\n${error.message}\n${jsonInputHint(name)}`)
  }
}

export function readList(flags, name) {
  const raw = readString(flags, name)
  if (raw === undefined) return undefined
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

export function requireString(flags, name, hint) {
  const value = readString(flags, name)
  if (value === undefined || value.trim() === '') {
    throw new CliError('usage', hint)
  }
  return value
}

export function parseStep(raw) {
  const text = String(raw).trim()
  if (!text) throw new CliError('usage', "--step 不能为空，格式：'id=命令>>expect'")
  const arrow = text.indexOf('>>')
  let left = text
  let expect = 'exit 0'
  if (arrow >= 0) {
    left = text.slice(0, arrow)
    const tail = text.slice(arrow + 2).trim()
    if (tail) expect = tail
  }
  const eq = left.indexOf('=')
  if (eq <= 0) {
    throw new CliError('usage', `--step 格式应为 'id=命令>>expect'，收到：${text}`)
  }
  const id = left.slice(0, eq).trim()
  const run = left.slice(eq + 1).trim()
  if (!id || !run) {
    throw new CliError('usage', `--step 的 id 与命令都不能为空：${text}`)
  }
  return { id, run, expect }
}

export function printRecord(record) {
  const known = [
    'id', 'title', 'status', 'hypothesis', 'factor', 'parent', 'expected',
    'scale', 'measured', 'owner', 'goal', 'phase', 'enabled', 'created_at', 'updated_at',
  ]
  const keys = [...known.filter((key) => record[key] !== undefined), ...Object.keys(record).filter((key) => !known.includes(key) && key !== 'steps' && key !== 'schema').sort()]
  const labelWidth = Math.max(...keys.map((key) => textWidth(key)))
  for (const key of keys) {
    const value = record[key]
    if (value === null || value === undefined) continue
    let text
    if (Array.isArray(value)) text = value.join(', ')
    else if (typeof value === 'object') text = JSON.stringify(value)
    else if (typeof value === 'boolean') text = value ? '是' : '否'
    else text = String(value)
    if (text === '' || text === '[]') continue
    out(`${pad(`${key}:`, labelWidth + 1)}  ${text}`)
  }
}

export function printTree(nodes, prefix = '') {
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1
    const branch = prefix === '' ? '' : last ? '└─ ' : '├─ '
    out(`${prefix}${branch}${node.id}  ${node.status || '-'}  ${node.title || ''}`)
    if (Array.isArray(node.children) && node.children.length > 0) {
      printTree(node.children, prefix === '' ? '  ' : `${prefix}${last ? '   ' : '│  '}`)
    }
  })
}

export async function confirmDelete(ctx, label) {
  if (ctx.flags.yes === true) return
  if (ctx.json) throw new CliError('usage', 'rm 需要 --yes（--json 模式不交互）')
  if (!process.stdin.isTTY) {
    throw new CliError('usage', 'rm 需要 --yes（非交互环境）')
  }
  let readline
  try {
    readline = await import('node:readline/promises')
  } catch {
    throw new CliError('usage', 'rm 需要 --yes（当前环境无法交互确认）')
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`确认删除${label}？[y/N] `)
    if (!/^y(es)?$/i.test(answer.trim())) {
      out('已取消')
      process.exit(0)
    }
  } finally {
    rl.close()
  }
}
