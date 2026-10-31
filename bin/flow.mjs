#!/usr/bin/env node
// project-flow CLI（schema 2）
//
// 唯一写入口：本文件不自己读写台账、不做校验，所有存储/校验/门禁执行都委托给
// lib/core.mjs。core 只依赖 node:fs/path/child_process，CLI 只做参数解析与输出。
// `flow check` 另委托 lib/checks.mjs（只读，不写 store）。
//
// 退出码：0 成功 · 1 用法 · 2 校验 · 3 未找到 · 4 IO
// `flow check` 复用同一组数字但含义按检查归一：0 通过 · 1 检查失败 ·
// 2 用法/配置错误 · 3 脚本或解释器缺失 · 4 启动/IO 失败/超时。

import path from 'node:path'
import process from 'node:process'
import os from 'node:os'
import { readFileSync, readdirSync } from 'node:fs'
import * as zlib from 'node:zlib'

// A closed downstream pipe (`flow status | head`) must end quietly, not throw.
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') process.exit(0)
})

const USAGE = `project-flow CLI（schema 2）

用法
  flow <command> [options]
  flow --root <dir> <command> [--json]

命令
  init      初始化 .dsh/flow（--name X --force --no-gates）
  status    项目名、契约源、实验/任务/门禁/决策计数与最近记录

  exp list | show <id> | tree
  exp add --title T [--hypothesis H] [--factor F] [--parent ID]
          [--expected E] [--scale S] [--notes N]
  exp update <id> [--title T] [--status open|confirmed|refuted|abandoned]
          [--hypothesis H] [--factor F] [--parent ID] [--expected E] [--scale S]
          [--measured M] [--metrics JSON] [--commits a,b] [--notes N]
  exp rm <id> [--yes]

  task list | show <id>
  task add --title T [--status draft|active|done|archived] [--owner O]
           [--goal G] [--notes N]
  task update <id> [--title T] [--status draft|active|done|archived]
           [--owner O] [--goal G] [--notes N]
  task rm <id> [--yes]

  gate list | show <id>
  gate add --id SLUG --title T --phase commit|release|manual [--step 'id=run>>expect' ...]
  gate update <id> [--title T] [--phase commit|release|manual]
           [--enabled true|false] [--step 'id=run>>expect' ...]
  gate enable <id> | disable <id>
  gate rm <id> [--yes]
  gate run <id> [--timeout SECONDS] [--force]
  gate run --phase commit|release|manual [--timeout SECONDS] [--force]
  gate logs <id> [--limit N]

  heartbeat start [--goal G] [--task ID] [--claim PATH]... [--agent A]
                  [--session S] [--note T]
  heartbeat update [--status working|idle] [--note T] [--goal G] [--task ID]
                   [--claim PATH]... [--session S]
  heartbeat end [--note T] [--session S]
  heartbeat list
  heartbeat status [--require-active] [--session S]
  heartbeat gc [--dry-run]      清理旧子会话心跳（agent=subagent 的历史文件）

  decision ask --question Q --kind choice|approval|input
               [--option 'id=label>>impact']... [--default ID] [--recommendation ID]
               [--rationale R] [--blocks T-id]... [--affects PATH]... [--supersedes D-id]
  decision list [--open] [--all]
  decision show <id>
  decision answer <id> --choice C [--note N] [--by user|agent]
  decision withdraw <id> --reason R [--by user|agent]
  decision gc [--days N] [--dry-run]

  check list
  check staged --allow <path> [--allow <path> ...]
  check release-baseline --marker <text> [--threshold <N>]
  check state [--file <path>]
  check doc --file <path> --type task|design|incident|release
  check decisions                内置检查：阻塞决策命中暂存文件时失败（core 实现）

  心跳只面向主会话（同一项目的多个主会话互相避让）：子会话不登记心跳，
  在子会话里运行 heartbeat start/update/end 会被明确拒绝；list/status 只读，
  可随时调用。心跳根固定为项目主工作区（linked worktree 也写主工作区）。

  机械检查（只读，不写 .dsh/flow）：运行包里 skills/ai-collaborative-dev-workflow/
  scripts/ 下的检查脚本；超时用 --timeout <seconds>（默认 120）。
  check decisions 是唯一内置检查：bin 特判路由到 core.checkDecisions（只读），
  不跑 scripts/；lib/checks.mjs 仍不 import core、不读写 store。

  决策只面向主会话：需要用户拍板的问题先 ask 建记录再提问，用户回答当轮 answer；
  open 同题复用、已关闭同题必须 --supersedes；阻塞决策（blocks 非空）影响暂存文件时
  check decisions 让 precommit 失败。

全局
  --root <dir>   项目根目录（默认当前目录）
  --json         机器可读输出：{ok:true,data,warnings} 或 {ok:false,error,warnings}
                 （warnings 恒为数组，可为空；契约修复/不可读记录/锁接管等诊断都在里面）
  -h, --help     显示本帮助

退出码
  0 成功 · 1 用法错误 · 2 校验失败 · 3 未找到 · 4 IO/环境错误
  注意：gate run 的门禁失败以 data.ok=false 表达，命令本身成功时仍退出 0。
  check 复用同一组数字：0 通过 · 1 检查失败 · 2 用法/配置错误 ·
  3 脚本或解释器缺失 · 4 启动/IO 失败（含超时）。`

const EXIT = { usage: 1, invalid: 2, notFound: 3, io: 4 }
const EXIT_BY_CODE = { usage: 1, invalid: 2, 'not-found': 3, conflict: 2, io: 4 }

// `flow check` 的退出码词汇（数字与插件一致，语义按检查归一，见 CONTRACT §6）。
const CHECK_EXIT_BY_CODE = {
  usage: 2,
  'check-failed': 1,
  'check-missing': 3,
  'check-io': 4,
  'not-found': 3,
  io: 4,
}

// status 只逐条展示最近的心跳，其余用总数提示。
const STATUS_HEARTBEAT_ROWS = 5

const BOOL_FLAGS = new Set(['json', 'force', 'yes', 'help', 'no-gates', 'require-active', 'dry-run', 'open', 'all'])
const VALUE_FLAGS = new Set([
  'root', 'name',
  'title', 'hypothesis', 'factor', 'parent', 'expected', 'scale', 'notes',
  'status', 'measured', 'metrics', 'commits',
  'owner', 'goal',
  'id', 'phase', 'step', 'enabled', 'timeout', 'limit',
  'allow', 'marker', 'threshold', 'file', 'type',
  'session', 'agent', 'claim', 'note', 'task',
  'question', 'kind', 'option', 'default', 'recommendation', 'rationale',
  'blocks', 'affects', 'supersedes', 'choice', 'reason', 'by', 'days',
])
const REPEAT_FLAGS = new Set(['step', 'allow', 'claim', 'option', 'blocks', 'affects'])

class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

// ---------------------------------------------------------------- 参数解析

function parseArgv(argv) {
  const flags = {}
  const repeated = {}
  const positional = []
  const errors = []

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '-h') {
      flags.help = true
      continue
    }
    if (tok.startsWith('--')) {
      let name = tok.slice(2)
      let value
      const eq = name.indexOf('=')
      if (eq >= 0) {
        value = name.slice(eq + 1)
        name = name.slice(0, eq)
      }
      if (!name) {
        errors.push('无效参数 "--"')
        continue
      }
      if (!BOOL_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
        errors.push(`未知参数 --${name}`)
        continue
      }
      if (value === undefined) {
        if (BOOL_FLAGS.has(name)) {
          value = true
        } else {
          const next = argv[i + 1]
          if (next !== undefined && !next.startsWith('--')) {
            value = next
            i++
          } else {
            errors.push(`--${name} 需要一个值`)
            continue
          }
        }
      } else if (BOOL_FLAGS.has(name) && value !== 'true') {
        errors.push(`--${name} 不接受值`)
        continue
      } else if (BOOL_FLAGS.has(name)) {
        value = true
      }
      if (REPEAT_FLAGS.has(name)) {
        ;(repeated[name] ||= []).push(String(value))
      } else {
        flags[name] = value
      }
      continue
    }
    if (tok.startsWith('-') && tok !== '-') {
      errors.push(`未知参数 ${tok}`)
      continue
    }
    positional.push(tok)
  }

  return {
    flags,
    steps: repeated.step || [],
    allows: repeated.allow || [],
    claims: repeated.claim || [],
    decisionOptions: repeated.option || [],
    blocks: repeated.blocks || [],
    affects: repeated.affects || [],
    positional,
    errors,
  }
}

// ---------------------------------------------------------------- 输出工具

let jsonMode = false
// 顶层命令名：catch 里据此选择退出码词汇（`flow check` 用检查语义）。
let topCommand = ''

function out(text) {
  process.stdout.write(`${text}\n`)
}

function errOut(text) {
  process.stderr.write(`${text}\n`)
}

function emitJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function charWidth(ch) {
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

function textWidth(value) {
  let width = 0
  for (const ch of String(value)) width += charWidth(ch)
  return width
}

function pad(value, width, align = 'left') {
  const text = String(value ?? '')
  const diff = width - textWidth(text)
  if (diff <= 0) return text
  return align === 'right' ? ' '.repeat(diff) + text : text + ' '.repeat(diff)
}

function clip(value, max = 60) {
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

function table(headers, rows, aligns = []) {
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

function fmtTime(iso) {
  if (!iso) return '-'
  return String(iso).replace('T', ' ').slice(0, 16)
}

function fmtDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '-'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 10000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.round(value / 1000)}s`
}


// --------------------------------------------- 心跳：主会话判定与心跳根

/**
 * One decompressed session log header, or `undefined`. Session logs live under
 * `<DSH_HOME>/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl[.zstd]`;
 * the header's `origin`/`delegationDepth` are the durable record of whether a
 * session is a delegated child. Best effort only: an unreadable status is
 * "unknown" and is treated like a main session (never a silent refusal).
 */
function readSessionHeader(session) {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = configured !== '' ? path.resolve(configured) : path.join(os.homedir(), '.dsh')
  const sessionsDir = path.join(home, 'sessions')
  let projects
  try {
    projects = readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (project.isDirectory() !== true) continue
    const dir = path.join(sessionsDir, project.name, session)
    for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
      const file = path.join(dir, name)
      let buffer
      try {
        buffer = readFileSync(file)
      } catch {
        continue
      }
      let text
      try {
        text = name.endsWith('.zstd') ? zstdText(buffer) : buffer.toString('utf8')
      } catch {
        return undefined
      }
      const first = text.split('\n', 1)[0]
      let header
      try {
        header = JSON.parse(first)
      } catch {
        return undefined
      }
      if (header === null || typeof header !== 'object') return undefined
      if (header.id !== undefined && header.id !== session) continue
      return header
    }
  }
  return undefined
}

/** Decompress one session log when Node's zlib supports zstd. */
function zstdText(buffer) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('zlib.zstdDecompressSync is unavailable')
  return zlib.zstdDecompressSync(buffer).toString('utf8')
}

/** `subagent` / `main` for a known session header; `undefined` when unknown. */
function sessionOriginOf(session) {
  const header = readSessionHeader(session)
  if (header === undefined) return undefined
  if (header.origin === 'subagent') return 'subagent'
  if (Number.isInteger(header.delegationDepth) && header.delegationDepth > 0) return 'subagent'
  return 'main'
}

/**
 * Refuse a heartbeat write from inside a subagent. The main-session ledger is
 * the only heartbeat surface, so a delegated child must report back instead of
 * writing a file the panel would hide. The calling session is `DSH_SESSION_ID`;
 * no ambient session means an interactive CLI run, which is allowed.
 */
function assertMainSessionHeartbeat(command) {
  const session = typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID.trim() : ''
  if (session === '') return
  if (sessionOriginOf(session) !== 'subagent') return
  throw new CliError(
    'usage',
    `heartbeat ${command} 只面向主会话：当前 CLI 运行在子会话 ${shortSession(session)} 内，` +
      '子会话不登记心跳（不会写入心跳文件）。请在最终报告里向主会话汇报进度，由主会话登记/收尾心跳。',
  )
}

/** The heartbeat ledger root of the current workspace: the project main worktree, else the workspace. */
function heartbeatWorkspaceOf(core, root) {
  if (typeof core.resolveHeartbeatWorkspace === 'function') {
    const resolved = core.resolveHeartbeatWorkspace(root)
    if (resolved !== null && typeof resolved === 'object' && typeof resolved.root === 'string' && resolved.root !== '') {
      return { root: resolved.root, degraded: resolved.degraded === true, reason: resolved.reason || '' }
    }
  }
  return { root, degraded: false, reason: '' }
}

/** Relative age for heartbeat rows ("刚刚", "3 小时前", …). */
function fmtAge(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return '-'
  const total = Math.max(0, value)
  if (total < 60) return '刚刚'
  if (total < 3600) return `${Math.round(total / 60)} 分钟前`
  if (total < 86400) return `${Math.round(total / 3600)} 小时前`
  return `${Math.round(total / 86400)} 天前`
}

/** Short session label for tables (drops a `session-` prefix, keeps 8 chars). */
function shortSession(value) {
  const text = String(value ?? '').trim().replace(/^session-/, '')
  if (text === '') return '-'
  return text.length <= 10 ? text : text.slice(0, 8)
}

function fmtClaims(claims) {
  if (!Array.isArray(claims) || claims.length === 0) return '-'
  return claims.join(', ')
}

// Warnings are collected from two sources — `loadContract().warnings` (manifest
// diagnostics) and `core.drainWarnings()` (lock takeover, unreadable records,
// containment, gate expect typos) — and surfaced exactly once per invocation:
// `warnings: [...]` in the `--json` envelope, `警告: <text>` on stderr otherwise.
const pendingWarnings = []
// `core` as loaded by main(); the catch path needs it to drain late warnings.
let coreRef = null

/** Append warnings, skipping non-strings and duplicates (order preserved). */
function collectWarnings(list) {
  if (!Array.isArray(list)) return
  for (const item of list) {
    if (typeof item !== 'string' || item === '') continue
    if (pendingWarnings.includes(item) === false) pendingWarnings.push(item)
  }
}

/** Take (and clear) the core diagnostic log; safe before core loads. */
function drainCoreWarnings() {
  try {
    if (coreRef !== null && typeof coreRef.drainWarnings === 'function') collectWarnings(coreRef.drainWarnings())
  } catch {
    // Diagnostics must never fail a command.
  }
}

/** Contract for `root` with its manifest warnings collected (cached per root). */
function loadContractFor(ctx, root) {
  if (ctx.contract !== null && ctx.contractRoot === root) return ctx.contract
  const loaded = ctx.core.loadContract(root)
  collectWarnings(loaded.warnings)
  ctx.contract = loaded.contract
  ctx.contractRoot = root
  return ctx.contract
}

/** Print the collected warnings (human mode only; `--json` carries them in the envelope). */
function printWarnings() {
  for (const warning of pendingWarnings) errOut(`警告: ${warning}`)
}

// ---------------------------------------------------------------- 参数取值

function readString(flags, name) {
  if (flags[name] === undefined) return undefined
  return String(flags[name])
}

function readInteger(flags, name) {
  if (flags[name] === undefined) return undefined
  const value = Number(flags[name])
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError('usage', `--${name} 需要一个非负整数`)
  }
  return value
}

function readPositiveInteger(flags, name, hint) {
  if (flags[name] === undefined) return undefined
  const value = Number(flags[name])
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError('usage', hint || `--${name} 需要一个正整数`)
  }
  return value
}

function readJsonObject(flags, name) {
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

function readList(flags, name) {
  const raw = readString(flags, name)
  if (raw === undefined) return undefined
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function requireString(flags, name, hint) {
  const value = readString(flags, name)
  if (value === undefined || value.trim() === '') {
    throw new CliError('usage', hint)
  }
  return value
}

function parseStep(raw) {
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

// ---------------------------------------------------------------- 命令实现

async function cmdInit(ctx) {
  const { core, flags } = ctx
  const options = {}
  const name = readString(flags, 'name')
  if (name !== undefined) options.name = name
  if (flags.force === true) options.force = true
  if (flags['no-gates'] === true) options.noGates = true
  const result = await core.initProject(ctx.root, options)

  if (!ctx.json) {
    const projectName = result?.name || ctx.contract?.name || path.basename(ctx.root)
    out(`已初始化 ${ctx.root}（${projectName}）`)
    if (Array.isArray(result?.created) && result.created.length > 0) {
      out(`新建 ${result.created.length} 个文件：`)
      for (const file of result.created) out(`  ${file}`)
    }
    if (Array.isArray(result?.seededGates) && result.seededGates.length > 0) {
      out(`种入默认门禁 ${result.seededGates.length} 条：${result.seededGates.join(', ')}`)
      out('  用 flow gate list 查看；不需要的用 flow gate disable <id>，已有一条门禁时不会再种。')
    }
  }
  collectWarnings(result?.warnings)
  return result
}

/** ` · +N 无法读取` suffix for human status lines (empty when every record parsed). */
function unreadableTail(list) {
  const count = Array.isArray(list) ? list.length : 0
  return count > 0 ? ` · +${count} 无法读取` : ''
}

function countsOf(items, keys) {
  const counts = Object.fromEntries(keys.map((key) => [key, 0]))
  for (const item of items) {
    const status = item?.status
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status]++
  }
  return counts
}

async function cmdStatus(ctx) {
  const { core } = ctx
  const loaded = core.loadContract(ctx.root)
  collectWarnings(loaded.warnings)
  const contract = loaded.contract
  const initialized = loaded.source !== 'defaults'

  // Invalid records are skipped from the rows but never vanish from the counts:
  // each family reports how many files could not be parsed alongside its totals.
  const unreadable = { experiments: [], tasks: [], gates: [] }
  let experiments = []
  let tasks = []
  let gates = []
  let store = null
  if (initialized) {
    ctx.contract = contract
    ctx.contractRoot = ctx.root
    experiments = await core.listExperiments(ctx.root, contract, { unreadable: unreadable.experiments })
    tasks = await core.listTasks(ctx.root, contract, { unreadable: unreadable.tasks })
    gates = await core.listGates(ctx.root, contract, { unreadable: unreadable.gates })
    try {
      store = core.storePaths(ctx.root, contract).store
    } catch {
      store = null
    }
  }

  const recentRuns = []
  if (initialized) {
    for (const gate of gates) {
      try {
        const runs = await core.listGateRuns(ctx.root, contract, gate.id, 1)
        if (Array.isArray(runs) && runs[0]) recentRuns.push({ gate: gate.id, ...runs[0] })
      } catch {
        // 运行日志缺失/损坏不影响 status
      }
    }
    recentRuns.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))
  }

  // 心跳独立于 store 聚合，未初始化也读取（与面板一致）。
  const heartbeats = core.readHeartbeatSection(ctx.root, contract)

  // 待决策段：与提醒/面板同一份读模型（open 排序：升级优先、asked_at 旧的在前）。
  let decisions = {
    items: [],
    counts: { open: 0, blocking: 0, escalated: 0, answered: 0, withdrawn: 0, superseded: 0, total: 0 },
  }
  if (initialized) {
    try {
      const info = decisionSessionInfo(ctx, contract)
      const summary = core.summarizeDecisions(ctx.root, contract, { ...info, limit: 3 })
      decisions = { items: summary.items, counts: summary.counts }
    } catch {
      // 决策读取失败不影响 status 的其余部分
    }
  }

  const expCounts = countsOf(experiments, ['open', 'confirmed', 'refuted', 'abandoned'])
  const taskCounts = countsOf(tasks, ['draft', 'active', 'done', 'archived'])
  const gateEnabled = gates.filter((gate) => gate.enabled !== false).length

  const data = {
    root: ctx.root,
    name: contract.name || path.basename(ctx.root),
    initialized,
    contractSource: loaded.source,
    schema: contract.schema,
    store,
    counts: {
      experiments: { total: experiments.length, ...expCounts, unreadable: unreadable.experiments.length },
      tasks: { total: tasks.length, ...taskCounts, unreadable: unreadable.tasks.length },
      gates: { total: gates.length, enabled: gateEnabled, unreadable: unreadable.gates.length },
    },
    heartbeats,
    decisions,
    recent: {
      experiments: experiments.slice(0, 3),
      tasks: tasks.slice(0, 3),
      gateRuns: recentRuns.slice(0, 3),
    },
  }

  if (!ctx.json) {
    const lines = [
      ['项目', data.name],
      ['根目录', ctx.root],
    ]
    if (!initialized) {
      lines.push(['契约', '未初始化（未找到 .dsh/flow/flow.json）'])
      lines.push(['下一步', 'flow init'])
    } else {
      lines.push(['契约', `${loaded.source}（schema ${contract.schema ?? '?'}）`])
      lines.push(['存储', store || contract?.store?.root || '.dsh/flow'])
      lines.push([
        '实验',
        `${experiments.length}（open ${expCounts.open} · confirmed ${expCounts.confirmed} · refuted ${expCounts.refuted} · abandoned ${expCounts.abandoned}${unreadableTail(unreadable.experiments)}）`,
      ])
      lines.push([
        '任务',
        `${tasks.length}（draft ${taskCounts.draft} · active ${taskCounts.active} · done ${taskCounts.done} · archived ${taskCounts.archived}${unreadableTail(unreadable.tasks)}）`,
      ])
      lines.push([
        '门禁',
        `${gates.length}（启用 ${gateEnabled}${unreadableTail(unreadable.gates)}）`,
      ])
      lines.push(['待决策', `${decisions.counts.open}（阻塞 ${decisions.counts.blocking}）`])
      const hiddenBeats = Number(heartbeats.counts.hidden) || 0
      lines.push([
        '心跳',
        `${heartbeats.counts.total}（可能已停 ${heartbeats.counts.stale}${hiddenBeats > 0 ? ` · 旧子会话隐藏 ${hiddenBeats}` : ''}）`,
      ])
    }
    const labelWidth = Math.max(...lines.map(([label]) => textWidth(label)))
    for (const [label, value] of lines) out(`${pad(label, labelWidth)}  ${value}`)

    if (initialized) {
      const beats = heartbeats.items
      if (beats.length > 0) {
        const shown = beats.slice(0, STATUS_HEARTBEAT_ROWS)
        const nameWidth = Math.max(...shown.map((beat) => textWidth(beat.file)))
        const ageWidth = Math.max(...shown.map((beat) => textWidth(fmtAge(beat.ageSeconds))))
        for (const beat of shown) {
          const label = beat.status
            ? `${beat.status}${beat.last_action ? ` · ${beat.last_action}` : ''}`
            : beat.last_action
          out(`  ${pad(beat.file, nameWidth)}  ${pad(fmtAge(beat.ageSeconds), ageWidth)}  ${clip(label || '-', 60)}`)
        }
        if (beats.length > STATUS_HEARTBEAT_ROWS) {
          out(`  … 其余 ${beats.length - STATUS_HEARTBEAT_ROWS} 条（共 ${beats.length} 条）`)
        }
      }
    }

    if (initialized) {
      if (decisions.items.length > 0) {
        out('')
        out(`待决策 ${decisions.counts.open}（阻塞 ${decisions.counts.blocking}）`)
        for (const item of decisions.items) {
          out(
            `  ${item.escalated === true ? '⚠ ' : ''}${item.id}  [${item.kind}]  ${clip(item.question, 48)}  ${decisionSuspended(item)}`,
          )
        }
      }
      if (data.recent.experiments.length > 0) {
        out('')
        out('最近实验')
        for (const record of data.recent.experiments) {
          out(`  ${record.id}  ${record.status || '-'}  ${clip(record.title, 48)}  ${fmtTime(record.updated_at)}`)
        }
      }
      if (data.recent.tasks.length > 0) {
        out('')
        out('最近任务')
        for (const record of data.recent.tasks) {
          out(`  ${record.id}  ${record.status || '-'}  ${clip(record.title, 48)}  ${fmtTime(record.updated_at)}`)
        }
      }
      const runs = data.recent.gateRuns
      if (runs.length > 0) {
        out('')
        out('最近门禁运行')
        for (const run of runs) {
          const steps = Array.isArray(run.steps) ? run.steps : []
          const passed = steps.filter((step) => step.ok).length
          out(
            `  ${run.gate || '-'}  ${run.ok ? '通过' : '失败'}  ${fmtTime(run.started_at)}  ${passed}/${steps.length} 步  ${fmtDuration(run.durationMs)}`,
          )
        }
      }
    }
  }
  return data
}

async function cmdExp(ctx, sub) {
  const { core, flags } = ctx
  if (!sub) throw new CliError('usage', '用法: flow exp <list|show|tree|add|update|rm>')
  const contract = loadContractFor(ctx, ctx.root)

  if (sub === 'list') {
    const records = await core.listExperiments(ctx.root, contract)
    if (!ctx.json) {
      if (records.length === 0) out('（没有实验记录）')
      else {
        out(
          table(
            ['ID', '状态', 'factor', '更新', '标题'],
            records.map((record) => [
              record.id,
              record.status || '-',
              clip(record.factor || '-', 24),
              fmtTime(record.updated_at),
              clip(record.title, 56),
            ]),
          ),
        )
      }
    }
    return records
  }

  if (sub === 'show') {
    const id = requireString(flags, 'id', '用法: flow exp show <id>（用 --id 或直接作为位置参数）')
    const record = await core.getExperiment(ctx.root, contract, id)
    if (!ctx.json) printRecord(record)
    return record
  }

  if (sub === 'tree') {
    const records = await core.listExperiments(ctx.root, contract)
    const tree = core.experimentTree(records)
    if (!ctx.json) {
      if (tree.length === 0) out('（没有实验记录）')
      else printTree(tree)
    }
    return tree
  }

  if (sub === 'add') {
    const input = {}
    for (const key of ['title', 'hypothesis', 'factor', 'expected', 'scale', 'notes']) {
      const value = readString(flags, key)
      if (value !== undefined) input[key] = value
    }
    const parent = readString(flags, 'parent')
    if (parent !== undefined) input.parent = parent === '' || parent === 'null' ? null : parent
    if (!input.title) throw new CliError('usage', '用法: flow exp add --title T [...]')
    const record = await core.addExperiment(ctx.root, contract, input)
    if (!ctx.json) out(`已创建实验 ${record.id}  ${record.title}`)
    return record
  }

  if (sub === 'update') {
    const id = requireString(flags, 'id', '用法: flow exp update <id> [...]')
    const patch = {}
    for (const key of ['title', 'hypothesis', 'factor', 'expected', 'scale', 'measured', 'notes']) {
      const value = readString(flags, key)
      if (value !== undefined) patch[key] = value
    }
    const parent = readString(flags, 'parent')
    if (parent !== undefined) patch.parent = parent === '' || parent === 'null' ? null : parent
    const status = readString(flags, 'status')
    if (status !== undefined) patch.status = status
    const metrics = readJsonObject(flags, 'metrics')
    if (metrics !== undefined) patch.metrics = metrics
    const commits = readList(flags, 'commits')
    if (commits !== undefined) patch.commits = commits
    if (Object.keys(patch).length === 0) {
      throw new CliError('usage', 'exp update 至少需要一个字段参数（如 --status / --measured）')
    }
    const record = await core.updateExperiment(ctx.root, contract, id, patch)
    if (!ctx.json) out(`已更新实验 ${record.id}  ${record.status || '-'}  ${record.title}`)
    return record
  }

  if (sub === 'rm') {
    const id = requireString(flags, 'id', '用法: flow exp rm <id> [--yes]')
    await confirmDelete(ctx, `实验 ${id}`)
    const result = await core.removeExperiment(ctx.root, contract, id)
    if (!ctx.json) out(`已删除实验 ${id}`)
    return result
  }

  throw new CliError('usage', `未知子命令 exp ${sub}（可用 list|show|tree|add|update|rm）`)
}

async function cmdTask(ctx, sub) {
  const { core, flags } = ctx
  if (!sub) throw new CliError('usage', '用法: flow task <list|show|add|update|rm>')
  const contract = loadContractFor(ctx, ctx.root)

  if (sub === 'list') {
    const records = await core.listTasks(ctx.root, contract)
    if (!ctx.json) {
      if (records.length === 0) out('（没有任务记录）')
      else {
        out(
          table(
            ['ID', '状态', 'owner', '更新', '标题'],
            records.map((record) => [
              record.id,
              record.status || '-',
              clip(record.owner || '-', 16),
              fmtTime(record.updated_at),
              clip(record.title, 56),
            ]),
          ),
        )
      }
    }
    return records
  }

  if (sub === 'show') {
    const id = requireString(flags, 'id', '用法: flow task show <id>')
    const record = await core.getTask(ctx.root, contract, id)
    if (!ctx.json) printRecord(record)
    return record
  }

  if (sub === 'add') {
    const input = {}
    for (const key of ['title', 'status', 'owner', 'goal', 'notes']) {
      const value = readString(flags, key)
      if (value !== undefined) input[key] = value
    }
    if (!input.title) throw new CliError('usage', '用法: flow task add --title T [...]')
    const record = await core.addTask(ctx.root, contract, input)
    if (!ctx.json) out(`已创建任务 ${record.id}  ${record.title}`)
    return record
  }

  if (sub === 'update') {
    const id = requireString(flags, 'id', '用法: flow task update <id> [...]')
    const patch = {}
    for (const key of ['title', 'status', 'owner', 'goal', 'notes']) {
      const value = readString(flags, key)
      if (value !== undefined) patch[key] = value
    }
    if (Object.keys(patch).length === 0) {
      throw new CliError('usage', 'task update 至少需要一个字段参数（如 --status）')
    }
    const record = await core.updateTask(ctx.root, contract, id, patch)
    if (!ctx.json) out(`已更新任务 ${record.id}  ${record.status || '-'}  ${record.title}`)
    return record
  }

  if (sub === 'rm') {
    const id = requireString(flags, 'id', '用法: flow task rm <id> [--yes]')
    await confirmDelete(ctx, `任务 ${id}`)
    const result = await core.removeTask(ctx.root, contract, id)
    if (!ctx.json) out(`已删除任务 ${id}`)
    return result
  }

  throw new CliError('usage', `未知子命令 task ${sub}（可用 list|show|add|update|rm）`)
}

async function cmdGate(ctx, sub) {
  const { core, flags } = ctx
  if (!sub) throw new CliError('usage', '用法: flow gate <list|show|add|update|rm|run|logs>')
  const contract = loadContractFor(ctx, ctx.root)

  if (sub === 'list') {
    const gates = await core.listGates(ctx.root, contract)
    const items = []
    for (const gate of gates) {
      let lastRun = null
      try {
        const runs = await core.listGateRuns(ctx.root, contract, gate.id, 1)
        lastRun = Array.isArray(runs) && runs[0] ? runs[0] : null
      } catch {
        lastRun = null
      }
      items.push({ ...gate, lastRun })
    }
    if (!ctx.json) {
      if (items.length === 0) out('（没有门禁定义）')
      else {
        out(
          table(
            ['ID', 'phase', '启用', '步骤', '最近运行', '标题'],
            items.map((gate) => [
              gate.id,
              gate.phase || '-',
              gate.enabled === false ? '否' : '是',
              String(Array.isArray(gate.steps) ? gate.steps.length : 0),
              gate.lastRun
                ? `${gate.lastRun.ok ? '通过' : '失败'} ${fmtTime(gate.lastRun.started_at)}`
                : '-',
              clip(gate.title, 40),
            ]),
          ),
        )
      }
    }
    return items
  }

  if (sub === 'show') {
    const id = requireString(flags, 'id', '用法: flow gate show <id>')
    const gate = await core.getGate(ctx.root, contract, id)
    if (!ctx.json) printGate(gate)
    return gate
  }

  if (sub === 'add') {
    const id = requireString(flags, 'id', '用法: flow gate add --id SLUG --title T --phase commit|release|manual')
    const title = requireString(flags, 'title', 'gate add 需要 --title')
    const phase = requireString(flags, 'phase', 'gate add 需要 --phase commit|release|manual')
    const input = { id, title, phase }
    if (ctx.steps.length > 0) input.steps = ctx.steps.map(parseStep)
    const gate = await core.addGate(ctx.root, contract, input)
    if (!ctx.json) out(`已创建门禁 ${gate.id}  ${gate.phase}  ${gate.title}`)
    return gate
  }

  if (sub === 'update') {
    const id = requireString(flags, 'id', '用法: flow gate update <id> [...]')
    const patch = {}
    const title = readString(flags, 'title')
    if (title !== undefined) patch.title = title
    const phase = readString(flags, 'phase')
    if (phase !== undefined) patch.phase = phase
    const enabled = readString(flags, 'enabled')
    if (enabled !== undefined) {
      if (enabled !== 'true' && enabled !== 'false') {
        throw new CliError('usage', '--enabled 只接受 true | false')
      }
      patch.enabled = enabled === 'true'
    }
    if (ctx.steps.length > 0) patch.steps = ctx.steps.map(parseStep)
    if (Object.keys(patch).length === 0) {
      throw new CliError('usage', 'gate update 至少需要一个字段参数（如 --enabled false）')
    }
    const gate = await core.updateGate(ctx.root, contract, id, patch)
    if (!ctx.json) out(`已更新门禁 ${gate.id}  ${gate.enabled === false ? '已禁用' : '启用'}  ${gate.title}`)
    return gate
  }

  if (sub === 'enable' || sub === 'disable') {
    const id = requireString(flags, 'id', `用法: flow gate ${sub} <id>`)
    const gate = await core.updateGate(ctx.root, contract, id, { enabled: sub === 'enable' })
    if (!ctx.json) out(`已${sub === 'enable' ? '启用' : '禁用'}门禁 ${gate.id}  ${gate.title}`)
    return gate
  }

  if (sub === 'rm') {
    const id = requireString(flags, 'id', '用法: flow gate rm <id> [--yes]')
    await confirmDelete(ctx, `门禁 ${id}`)
    const result = await core.removeGate(ctx.root, contract, id)
    if (!ctx.json) out(`已删除门禁 ${id}`)
    return result
  }

  if (sub === 'run') {
    const phase = readString(flags, 'phase')
    const timeoutSeconds = readInteger(flags, 'timeout')
    const options = { force: flags.force === true }
    if (timeoutSeconds !== undefined) options.timeoutMs = timeoutSeconds * 1000
    if (phase !== undefined) {
      if (flags.id !== undefined) throw new CliError('usage', 'gate run 的 --phase 与 <id> 不能同时使用')
      const summary = await core.runGatesByPhase(ctx.root, contract, phase, options)
      if (!ctx.json) printGatePhaseRun(summary)
      return summary
    }
    const id = requireString(
      flags,
      'id',
      '用法: flow gate run <id>|--phase commit|release|manual [--timeout SECONDS] [--force]',
    )
    const run = await core.runGate(ctx.root, contract, id, options)
    if (!ctx.json) printRun(run)
    return run
  }

  if (sub === 'logs') {
    const id = requireString(flags, 'id', '用法: flow gate logs <id> [--limit N]')
    const limit = readInteger(flags, 'limit')
    const runs = await core.listGateRuns(ctx.root, contract, id, limit === undefined ? 5 : limit)
    if (!ctx.json) {
      if (!Array.isArray(runs) || runs.length === 0) out('（没有运行记录）')
      else {
        for (const run of runs) {
          const steps = Array.isArray(run.steps) ? run.steps : []
          const passed = steps.filter((step) => step.ok).length
          out(
            `${run.ok ? '通过' : '失败'}  ${fmtTime(run.started_at)}  ${passed}/${steps.length} 步  ${fmtDuration(run.durationMs)}`,
          )
          for (const step of steps) {
            out(`  ${step.ok ? '✓' : '✗'} ${step.id}  ${step.expect || ''} → exit ${step.exit ?? '?'}  ${fmtDuration(step.durationMs)}`)
            if (!step.ok && step.tail) {
              for (const line of String(step.tail).split('\n').slice(-10)) out(`      ${line}`)
            }
          }
          out('')
        }
      }
    }
    return runs
  }

  throw new CliError('usage', `未知子命令 gate ${sub}（可用 list|show|add|update|enable|disable|rm|run|logs）`)
}

// ---------------------------------------------------------------- 心跳

/** Human-readable heartbeat summary (start/update/end/status all reuse it). */
function printHeartbeat(record) {
  const updatedAt = typeof record.updated_at === 'string' ? Date.parse(record.updated_at) : Number.NaN
  const age = Number.isFinite(updatedAt) ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000)) : null
  const rows = [
    ['session', shortSession(record.session)],
    ['agent', record.agent || '-'],
    ['goal', record.goal || '-'],
    ['task', record.task || '-'],
    ['claims', fmtClaims(record.claims)],
    ['status', record.status || '-'],
    ['年龄', age === null ? '-' : fmtAge(age)],
    ['turn', record.turn ?? '-'],
    ['last_action', record.last_action || '-'],
    ['started_at', fmtTime(record.started_at)],
    ['updated_at', fmtTime(record.updated_at)],
    ['ended_at', record.ended_at ? fmtTime(record.ended_at) : '-'],
    ['stats', record.stats ? `turns ${record.stats.turns ?? '-'} · missed ${record.stats.missed ?? '-'}` : '-'],
  ]
  const width = Math.max(...rows.map(([label]) => textWidth(label)))
  for (const [label, value] of rows) out(`${pad(label, width)}  ${value}`)
}

function printHeartbeatList(section) {
  const items = Array.isArray(section?.items) ? section.items : []
  const counts = section?.counts ?? { total: 0, active: 0, stale: 0 }
  const hidden = Number(counts.hidden) || 0
  out(
    `心跳 ${counts.total} 条（active ${counts.active} · stale ${counts.stale}${hidden > 0 ? ` · 旧子会话隐藏 ${hidden}` : ''}）  目录 ${section?.dir ?? '-'}`,
  )
  if (hidden > 0) out('提示：agent=subagent 的旧心跳已隐藏；flow heartbeat gc 可清理。')
  if (items.length === 0) {
    out('（没有心跳记录）')
    return
  }
  out('')
  out(
    table(
      ['session', 'agent', 'status', '年龄', 'task', 'claims', 'goal'],
      items.map((item) => [
        shortSession(item.session),
        clip(item.agent || '-', 12),
        item.status || '-',
        fmtAge(item.ageSeconds),
        item.task || '-',
        clip(fmtClaims(item.claims), 36),
        clip(item.goal || item.last_action || '-', 40),
      ]),
    ),
  )
  const stale = items.filter((item) => item.stale === true)
  if (stale.length > 0) out(`可能已停：${stale.map((item) => item.file).join(', ')}`)
}

async function cmdHeartbeat(ctx, sub) {
  const { core, flags } = ctx
  if (!sub) throw new CliError('usage', '用法: flow heartbeat <start|update|end|list|status|gc>')
  // The ledger root is the project main worktree, so a session in a linked
  // worktree still reads/writes the same heartbeat files.
  const workspace = heartbeatWorkspaceOf(core, ctx.root)
  const root = workspace.root
  // The degraded case is diagnosed once by core (`heartbeat-root-degraded:` in
  // every heartbeat read/write); collecting a second copy here duplicated it.
  const contract = loadContractFor(ctx, root)
  const sessionFlag = readString(flags, 'session')
  const note = readString(flags, 'note')

  if (sub === 'start') {
    assertMainSessionHeartbeat('start')
    const options = {}
    if (sessionFlag !== undefined) options.session = sessionFlag
    for (const [key, option] of [['agent', 'agent'], ['goal', 'goal'], ['task', 'task']]) {
      const value = readString(flags, key)
      if (value !== undefined) options[option] = value
    }
    if (ctx.claims.length > 0) options.claims = ctx.claims
    if (note !== undefined) options.last_action = note
    const record = await core.startHeartbeat(root, contract, options)
    if (!ctx.json) {
      out(`已开始心跳${record.createdTask ? `（新建任务 ${record.createdTask}）` : ''}`)
      printHeartbeat(record)
    }
    return record
  }

  if (sub === 'update') {
    assertMainSessionHeartbeat('update')
    const patch = {}
    const status = readString(flags, 'status')
    if (status !== undefined) {
      if (status !== 'working' && status !== 'idle') throw new CliError('usage', '--status 只接受 working | idle')
      patch.status = status
    }
    if (note !== undefined) patch.last_action = note
    const goal = readString(flags, 'goal')
    if (goal !== undefined) patch.goal = goal
    const task = readString(flags, 'task')
    if (task !== undefined) patch.task = task === '' ? null : task
    if (ctx.claims.length > 0) patch.claims = ctx.claims
    if (Object.keys(patch).length === 0) {
      throw new CliError('usage', 'heartbeat update 至少需要一个字段参数（如 --status idle / --note T）')
    }
    const record = await core.updateHeartbeat(root, contract, sessionFlag, patch)
    if (!ctx.json) {
      out('已更新心跳')
      printHeartbeat(record)
    }
    return record
  }

  if (sub === 'end') {
    assertMainSessionHeartbeat('end')
    const options = {}
    if (sessionFlag !== undefined) options.session = sessionFlag
    const status = readString(flags, 'status')
    if (status !== undefined) {
      if (status !== 'done' && status !== 'missed') throw new CliError('usage', 'heartbeat end 的 --status 只接受 done | missed')
      options.status = status
    }
    if (note !== undefined) options.note = note
    const record = await core.endHeartbeat(root, contract, options)
    if (!ctx.json) {
      out(`已结束心跳 ${shortSession(record.session)}  ${record.status}`)
      printHeartbeat(record)
    }
    return record
  }

  if (sub === 'list') {
    const section = core.readHeartbeatSection(root, contract)
    if (!ctx.json) printHeartbeatList(section)
    return section
  }

  if (sub === 'status') {
    const result = core.heartbeatStatus(root, contract, sessionFlag)
    const requireActive = flags['require-active'] === true
    if (!ctx.json) {
      if (result.record === null) {
        out(`无心跳记录（session ${shortSession(sessionFlag ?? process.env.DSH_SESSION_ID)}）`)
      } else {
        printHeartbeat(result.record)
      }
    }
    if (requireActive && result.active !== true) {
      const detail = result.record === null ? '没有心跳文件' : `心跳状态为 ${result.record.status || '未知'}`
      throw new CliError('usage', `没有 active 心跳（${detail}）；先运行 flow heartbeat start`)
    }
    return result
  }

  if (sub === 'gc') {
    if (typeof core.gcLegacyHeartbeats !== 'function') {
      throw new CliError('io', 'heartbeat gc 需要更新的 lib/core.mjs（缺少 gcLegacyHeartbeats）')
    }
    const dryRun = flags['dry-run'] === true
    const result = core.gcLegacyHeartbeats(root, contract, { dryRun })
    if (!ctx.json) {
      const removed = Array.isArray(result.removed) ? result.removed : []
      out(
        `${dryRun ? '将清理' : '已清理'}旧子会话心跳 ${removed.length} 条（保留 ${result.kept} 条）  目录 ${result.dir}`,
      )
      for (const item of removed) out(`  - ${item.file}  ${item.status || '-'}`)
      if (removed.length === 0) out('（没有 agent=subagent 的旧心跳）')
    }
    return result
  }

  throw new CliError('usage', `未知子命令 heartbeat ${sub}（可用 start|update|end|list|status|gc）`)
}

// ---------------------------------------------------------------- flow check

async function loadChecks() {
  try {
    return await import(new URL('../lib/checks.mjs', import.meta.url).href)
  } catch (error) {
    const missing =
      error?.code === 'ERR_MODULE_NOT_FOUND' && /lib[/\\]checks\.mjs/.test(String(error.message))
    const detail = missing
      ? '缺少 lib/checks.mjs（flow check 的检查目录未随包提供）'
      : error?.message || String(error)
    throw new CliError('io', `无法加载检查模块：${detail}`)
  }
}

// 内置检查：由 bin 特判路由到 core，不进 scripts/ 目录（lib/checks.mjs 保持 core-free）。
// 形状与 `checks.listChecks()` 的元素同构（五键），让 `check list` 的目录与脚本检查一致。
const BUILTIN_CHECKS = Object.freeze([
  Object.freeze({
    name: 'decisions',
    interpreter: 'core',
    script: 'lib/core.mjs#checkDecisions',
    description: '阻塞决策的 affects 命中暂存文件时失败（内置检查：bin 特判路由 core，只读）',
    args: '（无额外参数）',
  }),
])

async function cmdCheck(ctx, sub) {
  // `decisions` 是唯一内置检查：bin 特判路由到 core，不经过 scripts/ 目录。
  if (sub === 'decisions') return runCheckDecisions(ctx)
  const checks = await loadChecks()
  const names = checks.CHECKS.map((entry) => entry.name)
  // usage 与未知检查提示共用完整目录（脚本检查 + 内置检查），不再漏列内置项。
  const listed = [...new Set([...names, ...BUILTIN_CHECKS.map((entry) => entry.name)])]
  const { flags } = ctx

  if (!sub) {
    throw new CliError('usage', `用法: flow check <list|${listed.join('|')}> [options]`)
  }

  if (sub === 'list') {
    const items = [...checks.listChecks(), ...BUILTIN_CHECKS]
    if (!ctx.json) {
      out('机械检查（脚本相对包根路径；只读，不写 .dsh/flow；内置项注明 core 实现）')
      out('')
      items.forEach((item, index) => {
        if (index > 0) out('')
        out(`${item.name}  [${item.interpreter}]  ${item.description}`)
        out(`  脚本  ${item.script}`)
        out(`  用法  flow check ${item.name} ${item.args}`)
      })
    }
    return { checks: items }
  }

  // 本地预检：未知检查名在这里就按完整目录（含 decisions）报错，
  // 不落到 checks.buildInvocation 的漏列消息（那会漏掉内置项）。
  if (!listed.includes(sub)) {
    throw new CliError('usage', `未知检查 "${sub}"（可用 ${listed.join('|')}）`)
  }

  const timeoutSeconds = readPositiveInteger(
    flags,
    'timeout',
    '--timeout 需要正整数秒（单次检查的超时，默认 120）',
  )
  const threshold = readInteger(flags, 'threshold')

  const result = await checks.runCheck(sub, {
    root: ctx.root,
    allows: ctx.allows,
    marker: readString(flags, 'marker'),
    threshold,
    file: readString(flags, 'file'),
    type: readString(flags, 'type'),
    timeoutSeconds,
    passthrough: !ctx.json,
  })
  return result
}

// ---------------------------------------------------------------- flow decision

/** `id=label>>impact` (same shape family as `gate add --step`). Core validates the content. */
function parseDecisionOption(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') throw new CliError('usage', "--option 不能为空，格式：'id=label>>impact'")
  const arrow = text.indexOf('>>')
  const head = arrow >= 0 ? text.slice(0, arrow) : text
  const impact = arrow >= 0 ? text.slice(arrow + 2).trim() : ''
  const eq = head.indexOf('=')
  if (eq <= 0) throw new CliError('usage', `--option 格式应为 'id=label>>impact'，收到：${text}`)
  return { id: head.slice(0, eq).trim(), label: head.slice(eq + 1).trim(), impact }
}

/** Current main-session id + heartbeat turn, for list/ask escalation annotations. */
function decisionSessionInfo(ctx, contract) {
  const session = typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID.trim() : ''
  if (session === '') return { session: '', turn: null }
  try {
    const status = ctx.core.heartbeatStatus(ctx.root, contract, session)
    const record = status !== null && typeof status === 'object' ? status.record : null
    const turn = record !== null && record !== undefined && Number.isInteger(record.turn) ? record.turn : null
    return { session, turn }
  } catch {
    return { session, turn: null }
  }
}

/** 挂起 display: turns for the asking session, otherwise the age since asked_at. */
function decisionSuspended(item) {
  const turnAge = Number.isInteger(item?.turnAge) ? item.turnAge : null
  if (turnAge !== null) return `${turnAge} 轮`
  const age = item?.ageSeconds
  if (!Number.isFinite(age)) return '-'
  if (age < 3600) return `${Math.max(1, Math.round(age / 60))} 分钟`
  if (age < 86400) return `${Math.round(age / 3600)} 小时`
  return `${Math.round(age / 86400)} 天`
}

function printDecisionList(items, counts) {
  out(
    `决策 ${counts.total}（open ${counts.open} · 阻塞 ${counts.blocking} · 升级 ${counts.escalated} · answered ${counts.answered} · withdrawn ${counts.withdrawn} · superseded ${counts.superseded}）`,
  )
  if (items.length === 0) {
    out('（没有待决策）')
    return
  }
  const rows = items.map((item) => [
    `${item.escalated === true ? '⚠ ' : ''}${item.id}`,
    item.kind || '-',
    item.status || '-',
    Array.isArray(item.blocks) && item.blocks.length > 0 ? item.blocks.join(',') : '-',
    decisionSuspended(item),
    clip(item.question, 48),
  ])
  out(table(['ID', '类型', '状态', '阻塞', '挂起', '问题'], rows))
}

async function cmdDecision(ctx, sub) {
  const { core, flags } = ctx
  const contract = loadContractFor(ctx, ctx.root)

  if (!sub) throw new CliError('usage', '用法: flow decision <ask|list|show|answer|withdraw|gc>')

  if (sub === 'ask') {
    const kind = requireString(flags, 'kind', '用法: flow decision ask --question Q --kind choice|approval|input')
    const question = requireString(flags, 'question', 'flow decision ask 需要 --question')
    const input = {
      question,
      kind,
      rationale: requireString(flags, 'rationale', 'flow decision ask 需要 --rationale'),
    }
    if (kind === 'choice') {
      // 选项数量由 core 校验（invalid → 退出码 2），CLI 只做格式解析。
      input.options = ctx.decisionOptions.map(parseDecisionOption)
    }
    const recommendation = readString(flags, 'recommendation')
    if (recommendation !== undefined) input.recommendation = recommendation
    const fallback = readString(flags, 'default')
    if (fallback !== undefined) input.default = fallback
    if (ctx.blocks.length > 0) input.blocks = ctx.blocks
    if (ctx.affects.length > 0) input.affects = ctx.affects
    const supersedes = readString(flags, 'supersedes')
    if (supersedes !== undefined) input.supersedes = supersedes
    const info = decisionSessionInfo(ctx, contract)
    if (info.session !== '') input.asked_session = info.session
    if (info.turn !== null) input.asked_turn = info.turn
    const result = await core.addDecision(ctx.root, contract, input)
    if (!ctx.json) {
      if (result.created === true) {
        out(`已创建决策 ${result.decision.id}  [${result.decision.kind}] ${result.decision.question}`)
      } else {
        out(`已存在 open 决策 ${result.decision.id}（未重复创建）`)
      }
    }
    return result
  }

  if (sub === 'list') {
    const info = decisionSessionInfo(ctx, contract)
    const items = await core.listDecisions(ctx.root, contract, { all: flags.all === true, ...info })
    const summary = core.summarizeDecisions(ctx.root, contract, info)
    if (!ctx.json) printDecisionList(items, summary.counts)
    return { items, counts: summary.counts }
  }

  if (sub === 'show') {
    const id = requireString(flags, 'id', '用法: flow decision show <id>')
    const record = await core.getDecision(ctx.root, contract, id)
    if (!ctx.json) printRecord(record)
    return record
  }

  if (sub === 'answer') {
    const id = requireString(flags, 'id', '用法: flow decision answer <id> --choice C')
    const patch = { choice: requireString(flags, 'choice', 'flow decision answer 需要 --choice') }
    const note = readString(flags, 'note')
    if (note !== undefined) patch.note = note
    const by = readString(flags, 'by')
    if (by !== undefined) patch.by = by
    const record = core.answerDecision(ctx.root, contract, id, patch)
    if (!ctx.json) {
      out(`已回答决策 ${record.id}（${record.answer.choice}）`)
      printRecord(record)
    }
    return record
  }

  if (sub === 'withdraw') {
    const id = requireString(flags, 'id', '用法: flow decision withdraw <id> --reason R')
    // `--reason` 缺省由 core 按 §4.5 判 invalid（退出码 2），CLI 不吞掉这条规则。
    const patch = {}
    const reason = readString(flags, 'reason')
    if (reason !== undefined) patch.reason = reason
    const by = readString(flags, 'by')
    if (by !== undefined) patch.by = by
    const record = core.withdrawDecision(ctx.root, contract, id, patch)
    if (!ctx.json) {
      out(`已撤回决策 ${record.id}（${record.withdraw.reason}）`)
      printRecord(record)
    }
    return record
  }

  if (sub === 'gc') {
    const days = readPositiveInteger(flags, 'days', '--days 需要正整数（保留天数）')
    const dryRun = flags['dry-run'] === true
    const options = { dryRun }
    if (days !== undefined) options.days = days
    const result = core.gcDecisions(ctx.root, contract, options)
    if (!ctx.json) {
      out(`${dryRun ? '将清理' : '已清理'}决策 ${result.removed.length} 条（保留 ${result.kept} 条）`)
      for (const id of result.removed) out(`  - ${id}`)
      if (result.removed.length === 0) out('（没有超过保留期的已关闭决策）')
    }
    return result
  }

  throw new CliError('usage', `未知子命令 decision ${sub}（可用 ask|list|show|answer|withdraw|gc）`)
}

/**
 * `flow check decisions`: open + blocking decisions whose affects match a staged
 * file fail the check. Read-only; the only `check` implementation routed to
 * core instead of `lib/checks.mjs` (which stays core-free).
 */
function runCheckDecisions(ctx) {
  const { core } = ctx
  const loaded = core.loadContract(ctx.root)
  collectWarnings(loaded.warnings)
  const started = Date.now()
  const result = core.checkDecisions(ctx.root, loaded.contract)
  const durationMs = Date.now() - started
  const lines = []
  if (result.failed.length === 0) {
    lines.push(`✓ decisions：open ${result.open} · blocking ${result.blocking} · 暂存 ${result.staged.length} 个文件`)
  } else {
    for (const item of result.failed) {
      lines.push(`✗ ${item.id} 阻塞 ${item.blocks.join(',')}：affects 命中 ${item.matched.join(', ')}`)
    }
    const first = result.failed[0]
    try {
      const record = core.getDecision(ctx.root, loaded.contract, first.id)
      const options = Array.isArray(record.options) ? record.options.map((option) => option.id) : []
      const choice =
        typeof record.recommendation === 'string' && record.recommendation !== ''
          ? record.recommendation
          : typeof record.default === 'string' && record.default !== ''
            ? record.default
            : (options[0] ?? '')
      if (choice !== '') lines.push(`先回答：flow decision answer ${first.id} --choice ${choice}`)
    } catch {
      // 提示是尽力而为，读不到就不打印
    }
  }
  const stdout = lines.join('\n')
  if (!ctx.json) {
    for (const line of lines) out(line)
  }
  if (result.failed.length === 0) {
    return { check: 'decisions', exitCode: 0, stdout, stderr: '', durationMs, open: result.open, blocking: result.blocking, failed: [] }
  }
  const error = new Error('检查未通过：decisions（阻塞决策命中暂存文件）')
  error.code = 'check-failed'
  error.silent = true
  error.payload = {
    check: 'decisions',
    exitCode: 1,
    stdout,
    stderr: '',
    durationMs,
    open: result.open,
    blocking: result.blocking,
    failed: result.failed,
  }
  throw error
}

// ---------------------------------------------------------------- 展示辅助

function printRecord(record) {
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

function printGate(gate) {
  const keys = ['id', 'title', 'phase', 'enabled', 'created_at', 'updated_at']
  const labelWidth = Math.max(...keys.map((key) => textWidth(key)))
  for (const key of keys) {
    let value = gate[key]
    if (value === undefined || value === null) continue
    if (key === 'enabled') value = value === false ? 'false（已禁用）' : 'true'
    out(`${pad(`${key}:`, labelWidth + 1)}  ${value}`)
  }
  const steps = Array.isArray(gate.steps) ? gate.steps : []
  out('')
  out(`steps（${steps.length}）`)
  for (const step of steps) {
    out(`  ${step.id}  ${step.expect || 'exit 0'}`)
    out(`    run: ${step.run}`)
    if (step.timeoutSeconds !== undefined) out(`    timeout: ${step.timeoutSeconds}s`)
  }
}

function printRun(run) {
  out(`运行门禁 ${run.gate}${run.title ? `（${run.title}）` : ''}`)
  const steps = Array.isArray(run.steps) ? run.steps : []
  for (const step of steps) {
    out(`  ${step.ok ? '✓' : '✗'} ${step.id}  ${step.expect || ''} → exit ${step.exit ?? '?'}  ${fmtDuration(step.durationMs)}`)
    if (!step.ok && step.tail) {
      for (const line of String(step.tail).split('\n').slice(-20)) out(`      ${line}`)
    }
  }
  const passed = steps.filter((step) => step.ok).length
  out(`结果  ${run.ok ? '通过' : '失败'}  ${passed}/${steps.length} 步  ${fmtDuration(run.durationMs)}`)
  if (run.log) out(`日志  ${run.log}`)
}

/** Batch result of `gate run --phase`: runs, skips and failures in one summary. */
function printGatePhaseRun(summary) {
  const runs = Array.isArray(summary?.runs) ? summary.runs : []
  const skipped = Array.isArray(summary?.skipped) ? summary.skipped : []
  const failed = runs.filter((run) => run.ok !== true)
  out(
    `phase ${summary?.phase ?? '-'}：运行 ${runs.length} 条 · 通过 ${runs.length - failed.length} · 失败 ${failed.length} · 跳过 ${skipped.length}`,
  )
  for (const run of runs) {
    const steps = Array.isArray(run.steps) ? run.steps : []
    const passed = steps.filter((step) => step.ok).length
    const error = run.error ? `  ${run.error.code}: ${run.error.message}` : ''
    out(`  ${run.ok === true ? '✓' : '✗'} ${run.gate}${run.title ? `（${run.title}）` : ''}  ${passed}/${steps.length} 步  ${fmtDuration(run.durationMs)}${error}`)
    if (run.ok !== true) {
      for (const step of steps) {
        if (step.ok === true || !step.tail) continue
        out(`      ${step.id} → exit ${step.exit ?? '?'}`)
        for (const line of String(step.tail).split('\n').slice(-10)) out(`        ${line}`)
      }
    }
  }
  for (const item of skipped) out(`  ↷ ${item.id} 跳过（${item.reason}）`)
  if (failed.length > 0) out(`失败 ${failed.length} 条：${failed.map((run) => run.gate).join(', ')}`)
  if (failed.length === 0 && skipped.length === 0) out('全部通过')
}

function printTree(nodes, prefix = '') {
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1
    const branch = prefix === '' ? '' : last ? '└─ ' : '├─ '
    out(`${prefix}${branch}${node.id}  ${node.status || '-'}  ${node.title || ''}`)
    if (Array.isArray(node.children) && node.children.length > 0) {
      printTree(node.children, prefix === '' ? '  ' : `${prefix}${last ? '   ' : '│  '}`)
    }
  })
}

async function confirmDelete(ctx, label) {
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

// ---------------------------------------------------------------- 入口

async function loadCore() {
  try {
    return await import(new URL('../lib/core.mjs', import.meta.url).href)
  } catch (error) {
    const missing = error?.code === 'ERR_MODULE_NOT_FOUND' && /lib[/\\]core\.mjs/.test(String(error.message))
    const detail = missing
      ? '缺少 lib/core.mjs（project-flow 的核心模块未随包提供或被删除）'
      : error?.message || String(error)
    throw new CliError(
      'io',
      `无法加载 project-flow 核心：${detail}\n` +
        '处理：确认安装的是完整包（lib/ 与 bin/ 同级），或从仓库根重新安装 project-flow。',
    )
  }
}

function exitCodeOf(code) {
  return EXIT_BY_CODE[code] ?? EXIT.io
}

async function dispatch(ctx, parsed) {
  const [command, action] = parsed.positional
  const sub = action
  switch (command) {
    case 'init':
      return cmdInit(ctx)
    case 'status':
      return cmdStatus(ctx)
    case 'exp':
      return cmdExp(ctx, sub)
    case 'task':
      return cmdTask(ctx, sub)
    case 'gate':
      return cmdGate(ctx, sub)
    case 'heartbeat':
      return cmdHeartbeat(ctx, sub)
    case 'decision':
      return cmdDecision(ctx, sub)
    case 'check':
      return cmdCheck(ctx, sub)
    default:
      throw new CliError('usage', `未知命令 "${command}"（可用 init|status|exp|task|gate|heartbeat|decision|check；-h 查看帮助）`)
  }
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2))
  jsonMode = parsed.flags.json === true
  topCommand = parsed.positional[0] ?? ''

  if (parsed.flags.help === true) {
    out(USAGE)
    return 0
  }
  if (parsed.errors.length > 0) throw new CliError('usage', parsed.errors.join('；'))
  if (parsed.positional.length === 0) {
    out(USAGE)
    return 0
  }

  const root = parsed.flags.root === undefined ? process.cwd() : path.resolve(String(parsed.flags.root))
  const core = await loadCore()
  coreRef = core
  const ctx = {
    core,
    root,
    flags: parsed.flags,
    steps: parsed.steps,
    allows: parsed.allows,
    claims: parsed.claims,
    decisionOptions: parsed.decisionOptions,
    blocks: parsed.blocks,
    affects: parsed.affects,
    json: jsonMode,
    contract: null,
    contractRoot: null,
  }

  // show/update/rm/run/logs 允许把 id 作为位置参数：flow exp show E-xxx
  const [command, action, ...extra] = parsed.positional
  if (extra.length > 1) {
    throw new CliError('usage', `多余的参数：${extra.slice(1).join(' ')}`)
  }
  if (
    ['exp', 'task', 'gate', 'decision'].includes(command) &&
    ['show', 'update', 'rm', 'run', 'logs', 'enable', 'disable', 'answer', 'withdraw'].includes(action) &&
    // `gate run --phase X` takes no id.
    !(command === 'gate' && action === 'run' && parsed.flags.phase !== undefined)
  ) {
    if (extra.length === 0 && parsed.flags.id === undefined) {
      throw new CliError('usage', `用法: flow ${command} ${action} <id> [options]`)
    }
    if (extra[0] !== undefined && parsed.flags.id === undefined) parsed.flags.id = extra[0]
    if (extra[0] !== undefined && parsed.flags.id !== undefined && extra[0] !== parsed.flags.id) {
      throw new CliError('usage', `id 冲突：位置参数 ${extra[0]} 与 --id ${parsed.flags.id}`)
    }
  } else if (extra.length > 0) {
    throw new CliError('usage', `多余的参数：${extra.join(' ')}`)
  }

  const data = await dispatch(ctx, parsed)
  // Collect late diagnostics (lock takeover, unreadable records, expect typos)
  // after the command ran, so they never interleave with its own output.
  drainCoreWarnings()
  if (jsonMode) emitJson({ ok: true, data, warnings: pendingWarnings })
  else printWarnings()
  return 0
}

main()
  .then((code) => {
    process.exitCode = code ?? 0
  })
  .catch((error) => {
    // A failure path still drains: core may have warned before throwing.
    drainCoreWarnings()
    const code = typeof error?.code === 'string' ? error.code : 'io'
    const detail = { code, message: error?.message || String(error) }
    // CheckError 自带检查上下文（check/exitCode/stdout/stderr），直接并入 error 对象。
    const payload =
      error?.payload && typeof error.payload === 'object' ? { ...error.payload, ...detail } : detail
    const mapped =
      (topCommand === 'check' ? CHECK_EXIT_BY_CODE[code] : undefined) ?? exitCodeOf(code)
    if (jsonMode) emitJson({ ok: false, error: payload, warnings: pendingWarnings })
    else {
      printWarnings()
      if (error?.silent !== true) errOut(`错误（${payload.code}）：${payload.message}`)
    }
    process.exitCode = mapped
  })
