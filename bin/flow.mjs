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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
  init      初始化 .agents/flow（--name X --force --no-gates）
  status    项目名、契约源、实验/任务/门禁/决策计数与最近记录

  exp list | show <id> | tree
  exp add [--id E-YYYYMMDD-NN] --title T --hypothesis H --direction TEXT --expected E
          --primary-metric M --guardrail G [--guardrail G]...
          --falsify F --window-days N --stop-loss S
          [--factor F] [--parent ID] [--scale S] [--notes N]
  exp update <id> [--title T] [--status open|confirmed|refuted|abandoned|inconclusive|pivoted]
          [--direction TEXT] [--expected E] [--primary-metric M] [--guardrail G]...
          [--falsify F] [--window-days N] [--stop-loss S] [--learned L]
          [--hypothesis H] [--factor F] [--parent ID] [--scale S]
          [--measured M] [--metrics JSON] [--commits a,b] [--notes N]
  exp review <id>               只读自查：verdict/branch/missing（恒退出 0）
  exp productize <id> [--gate release]
  exp cleanup <id> [--flag F]... [--code C]... [--data D]...
  exp rm <id> [--yes]

  task list | show <id>
  task add --title T --type <t> [--id T-YYYYMMDDHHMMSS] [--status draft|active|done|archived]
           [--stage <s>] [--owner O] [--notes N] [--experiment E-id] [--parent T-id]
  task update <id> [--title T] [--type <t>] [--status draft|active|done|archived]
           [--stage <s>] [--owner O] [--notes N] [--experiment E-id] [--parent T-id]
          type 必填（add）：feat|fix|docs|style|refactor|perf|test|chore|build|ci（commit 类型）
          stage（可选）：created|queued-analysis|analyzing|queued-implementation|implementing|
           queued-review|reviewing|done|archived；写 stage 时 status 自动派生（见 CONTRACT §3.2.1）
          标题即目标（goal 已并入 title）；title/type 不可改（update），旧记录由格式门禁迁移
          父子：--parent 的父任务须存在、禁自指/禁环；--parent ''|none|null 清空为根
  task link <TASK-ID> --team <BOARD-ID>   # 挂载团队板 id（只写本地台账，零外部写入）
  task unlink <TASK-ID>                   # 解除挂载（team=null；同样零外部写入）
  task archive [--older-than N] [--dry-run]
          归档已完成的旧任务（阈值取 tasks.archiveAfterDays，默认 7，0=关闭；--dry-run 只预览不写盘）
  task normalize [--type-map <file.json>] [--dry-run]
          归一旧记录：goal 并入 title、按 map 补 type（--dry-run 只报告不改盘；不会猜 type）
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

  desc status [--json]          描述台账计数与 enforce/enabled（未建立时只提示）
  desc build [--dry-run]        按源码同步结构（hash/import/模块边），不碰已写语义
  desc show [--path <src>] [--graph tree|mermaid] [--json]
                                无 --path：文件树；有 --path：该文件的模块表与模块边；
                                --graph mermaid：直接打印完整渲染文档
  desc set --input <json>       写文件/模块语义（对象=单文件补丁，数组=多文件补丁）
  desc set --project-semantics <text>   写项目语义（project.json 必须已由 build 建立）
  desc plan <T-id> --template <src>     打印计划骨架（当前记录；无记录则扫源码）
  desc plan <T-id> --input <json>       建/改语义变更计划（已存在 = 修订）
  desc plan <T-id> --show               打印当前计划（没有则提示「无计划」）
  desc plan <T-id> --no-semantic-change --reason <text>
  desc plan <T-id> --rebase             按当前 HEAD/工作树重算 base（implemented 计划只刷新 base）
  desc apply <T-id> [--dry-run]         把计划语义落进记录并冻结计划（幂等）
  desc render [--out <path>] [--check]  打印/写出确定性 Markdown；--check 与现算比对

  check list
  check staged --allow <path> [--allow <path> ...]
  check release-baseline --marker <text> [--threshold <N>]
  check decisions | check experiments
  check tasks [--type-map <file.json>]
  check description [--task <T-id>] [--strict]
  check state [--file <path>]
  check doc --file <path> --type task|design|incident|release
  check decisions                内置检查：阻塞决策命中暂存文件时失败（core 实现）
  check tasks                    内置检查：旧任务记录未归一（残留 goal 键 / 缺 type）时失败
  check description              内置检查：描述台账漂移（缺记录/陈旧 hash/成员/模块边/语义）时失败

  心跳只面向主会话（同一项目的多个主会话互相避让）：子会话不登记心跳，
  在子会话里运行 heartbeat start/update/end 会被明确拒绝；list/status 只读，
  可随时调用。心跳根固定为项目主工作区（linked worktree 也写主工作区）。

  机械检查（只读，不写 .agents/flow）：运行包里 skills/ai-collaborative-dev-workflow/
  scripts/ 下的检查脚本；超时用 --timeout <seconds>（默认 120）。
  check decisions / check experiments / check tasks / check description 是内置检查：
  bin 特判路由到 core.checkDecisions / core.checkExperiments / core.normalizeTaskFormat /
  core.checkDescription（只读），不跑 scripts/；lib/checks.mjs 仍不 import core、
  不读写 store。
  check tasks 的 --type-map <file.json> 是 { "<T-id>": "<type>" } 草稿文件，只用来
  判断 missing-type 是否可消；值必须是十个 type 之一，否则按用法错误退 2。
  check tasks 永远不会替你猜 type，也不能写盘；归一由 flow task normalize 执行。

  描述台账（desc）：台账在 .agents/description/（project.json + files/ + tasks/）。
  status/build/show/render 只读（--out 是唯一的文件写出），set 写语义，plan 写分析阶段
  的语义变更计划，apply 把计划落进记录并冻结；check description 失败 exit 1。
  desc render --check 与 description.render 现算比对，不一致 exit 1；--out 与
  description.render 都必须落在项目根内（越界按用法错误退 1）。

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
  3 脚本或解释器缺失 · 4 启动/IO 失败（含超时）。
  实验相关：exp review 恒 0（只读自查）；exp productize 未过门禁 → 2；
  check experiments 失败 → 1（warnings 不阻断）。`

const EXIT = { usage: 1, invalid: 2, notFound: 3, io: 4 }
// `check-failed` 只由检查族抛出：`flow check` 走下面的 `CHECK_EXIT_BY_CODE`，
// `flow desc render --check` 走这张表（同样按「检查失败 → 1」归一）。
const EXIT_BY_CODE = { usage: 1, invalid: 2, 'not-found': 3, conflict: 2, io: 4, 'check-failed': 1 }

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

const BOOL_FLAGS = new Set([
  'json', 'force', 'yes', 'help', 'no-gates', 'require-active', 'dry-run', 'open', 'all',
  // T-20261108 D4：`desc plan/show/rebase`、`desc render --check`、`check description --strict`
  'strict', 'show', 'rebase', 'no-semantic-change', 'check',
])
const VALUE_FLAGS = new Set([
  'root', 'name',
  'title', 'hypothesis', 'factor', 'parent', 'expected', 'scale', 'notes',
  'status', 'measured', 'metrics', 'commits',
  'owner', 'goal',
  'id', 'phase', 'step', 'enabled', 'timeout', 'limit',
  'allow', 'marker', 'threshold', 'file', 'type', 'type-map', 'stage', 'team',
  'session', 'agent', 'claim', 'note', 'task',
  'question', 'kind', 'option', 'default', 'recommendation', 'rationale',
  'blocks', 'affects', 'supersedes', 'choice', 'reason', 'by', 'days',
  'older-than',
  // T-12 B2（schema2 七字段 / 分流 / 关联）
  'direction', 'primary-metric', 'guardrail', 'falsify', 'window-days', 'stop-loss',
  'learned', 'experiment', 'gate', 'flag', 'code', 'data',
  // T-20261108 D4：描述台账的取值参数
  'path', 'graph', 'input', 'template', 'out', 'project-semantics',
])
const REPEAT_FLAGS = new Set([
  'step', 'allow', 'claim', 'option', 'blocks', 'affects',
  // T-12 B2：可重复的七字段/清理清单
  'guardrail', 'flag', 'code', 'data',
])

/**
 * Per-command accepted flags (T-20261030-15): `--help`/`--root`/`--json` are
 * global, everything else must be declared here. A command with subcommands is
 * keyed by action; single-command entries use `{ flags }` directly. `repeat`
 * lists flags the parser collects into arrays (`--step`, `--claim`, ...).
 *
 * Keep this table in sync with the handlers: `test/t-20261030-15-flag-spec.test.mjs`
 * cross-checks it against the literal flag reads in this file.
 */
export const SPEC = Object.freeze({
  init: Object.freeze({ flags: ['name', 'force', 'no-gates'] }),
  status: Object.freeze({ flags: [] }),
  exp: Object.freeze({
    list: { flags: [] },
    show: { flags: ['id'] },
    tree: { flags: [] },
    add: {
      flags: ['id', 'title', 'hypothesis', 'factor', 'parent', 'scale', 'notes',
        'direction', 'expected', 'primary-metric', 'falsify', 'window-days', 'stop-loss'],
      repeat: ['guardrail'],
    },
    update: {
      flags: ['id', 'title', 'hypothesis', 'factor', 'parent', 'scale', 'notes', 'status',
        'measured', 'metrics', 'commits', 'direction', 'expected', 'primary-metric',
        'falsify', 'window-days', 'stop-loss', 'learned'],
      repeat: ['guardrail'],
    },
    review: { flags: ['id'] },
    productize: { flags: ['id', 'gate'] },
    cleanup: { flags: ['id'], repeat: ['flag', 'code', 'data'] },
    rm: { flags: ['id', 'yes'] },
  }),
  task: Object.freeze({
    list: { flags: [] },
    show: { flags: ['id'] },
    add: { flags: ['id', 'title', 'type', 'status', 'owner', 'notes', 'experiment', 'parent', 'stage'] },
    update: { flags: ['id', 'title', 'type', 'status', 'owner', 'notes', 'experiment', 'parent', 'stage'] },
    archive: { flags: ['older-than', 'dry-run'] },
    normalize: { flags: ['type-map', 'dry-run'] },
    link: { flags: ['id', 'team'] },
    unlink: { flags: ['id'] },
    rm: { flags: ['id', 'yes'] },
  }),
  gate: Object.freeze({
    list: { flags: [] },
    show: { flags: ['id'] },
    add: { flags: ['id', 'title', 'phase'], repeat: ['step'] },
    update: { flags: ['id', 'title', 'phase', 'enabled'], repeat: ['step'] },
    enable: { flags: ['id'] },
    disable: { flags: ['id'] },
    rm: { flags: ['id', 'yes'] },
    run: { flags: ['id', 'phase', 'timeout', 'force'] },
    logs: { flags: ['id', 'limit'] },
  }),
  heartbeat: Object.freeze({
    start: { flags: ['goal', 'task', 'agent', 'session', 'note'], repeat: ['claim'] },
    update: { flags: ['status', 'note', 'goal', 'task', 'session'], repeat: ['claim'] },
    end: { flags: ['status', 'note', 'session'] },
    list: { flags: ['all'] },
    status: { flags: ['require-active', 'session'] },
    gc: { flags: ['dry-run'] },
  }),
  decision: Object.freeze({
    ask: {
      flags: ['question', 'kind', 'default', 'recommendation', 'rationale', 'supersedes'],
      repeat: ['option', 'blocks', 'affects'],
    },
    list: { flags: ['open', 'all'] },
    show: { flags: ['id'] },
    answer: { flags: ['id', 'choice', 'note', 'by'] },
    withdraw: { flags: ['id', 'reason', 'by'] },
    gc: { flags: ['days', 'dry-run'] },
  }),
  // T-20261108 D4：描述台账命令面（spec §9）。每个 handler 真正读的 flag 都在这张
  // 表里；`id` 声明在 plan/apply 上，是因为位置参数 `<T-id>` 由 main 归一到 flags.id。
  desc: Object.freeze({
    status: { flags: [] },
    build: { flags: ['dry-run'] },
    show: { flags: ['path', 'graph'] },
    set: { flags: ['input', 'project-semantics'] },
    plan: { flags: ['id', 'input', 'template', 'show', 'no-semantic-change', 'reason', 'rebase'] },
    apply: { flags: ['id', 'dry-run'] },
    render: { flags: ['out', 'check'] },
  }),
  check: Object.freeze({
    list: { flags: [] },
    staged: { flags: ['timeout'], repeat: ['allow'] },
    'release-baseline': { flags: ['marker', 'threshold', 'timeout'] },
    state: { flags: ['file', 'timeout'] },
    doc: { flags: ['file', 'type', 'timeout'] },
    decisions: { flags: [] },
    experiments: { flags: [] },
    tasks: { flags: ['type-map'] },
    description: { flags: ['task', 'strict'] },
  }),
})

/** Flags every command accepts. `-h` is normalized to `help` in `parseArgv`. */
const GLOBAL_FLAGS = Object.freeze(['root', 'json', 'help'])

/** Resolve the accepted-flag spec; unknown command/action returns null. */
function specOfSpec(command, action) {
  if (typeof command !== 'string' || Object.hasOwn(SPEC, command) === false) return null
  const entry = SPEC[command]
  if (Object.hasOwn(entry, 'flags')) return action === undefined ? entry : null
  if (typeof action !== 'string' || Object.hasOwn(entry, action) === false) return null
  return entry[action]
}

/** Human-readable flag list for an error message. */
function describeFlags(spec) {
  const soft = Array.isArray(spec.flags) ? spec.flags : []
  const repeat = Array.isArray(spec.repeat) ? spec.repeat : []
  return [...soft.map((name) => `--${name}`), ...repeat.map((name) => `--${name}`)]
    .concat(GLOBAL_FLAGS.map((name) => `--${name}`))
    .join(' ')
}

/**
 * Reject flags a command did not declare (T-20261030-15). Runs before dispatch,
 * so an unsupported flag can never reach a core write. `--help` is handled
 * earlier by `main` and wins over this check.
 */
function assertFlagsAllowed(parsed) {
  const [command, action] = parsed.positional
  const spec = specOfSpec(command, action)
  if (spec === null) return
  const allowed = new Set([...GLOBAL_FLAGS, ...(Array.isArray(spec.flags) ? spec.flags : [])])
  const repeatAllowed = new Set(Array.isArray(spec.repeat) ? spec.repeat : [])
  const label = action === undefined ? `flow ${command}` : `flow ${command} ${action}`
  for (const name of Object.keys(parsed.flags)) {
    if (name === 'help') continue
    if (allowed.has(name)) continue
    throw new CliError('usage', `${label} 不支持 --${name}（可用：${describeFlags(spec)}）`)
  }
  for (const name of Object.keys(parsed.repeated)) {
    if (repeatAllowed.has(name)) continue
    throw new CliError('usage', `${label} 不支持 --${name}（可用：${describeFlags(spec)}）`)
  }
}

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
    guardrails: repeated.guardrail || [],
    cleanupFlags: repeated.flag || [],
    cleanupCodes: repeated.code || [],
    cleanupData: repeated.data || [],
    repeated,
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

// ⚠ 与 `lib/util.mjs` 的 `pad` **同名不同物，绝不可去重**：这里是 CLI 表格列补齐
// （按显示宽度 `textWidth` 算、支持左右对齐）；util 那个是 `padStart(width,'0')`
// 的时间戳补零。按名字合并会把 CLI 表格整列对齐改坏。
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

/**
 * `--input` 的 JSON 解析（对象**或数组**：`desc set` 的单/多文件补丁）。
 * 与 `readJsonObject` 分开是因为「对象数组」在这条通道上是合法形状，而
 * `readJsonObject` 的契约（exp --metrics、decision 输入）明确拒绝数组。
 */
function readJsonValue(flags, name) {
  const raw = readString(flags, name)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new CliError('usage', `--${name} 需要合法 JSON（对象或对象数组）`)
  }
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

  // 描述计数是**展示层**的读（spec §9）：不进 `data.status`（面板数据模型不动），
  // 只在 store 已初始化时读；读不到给 null 而不是零值（"读不到"必须与"很干净"可分）。
  let description = null
  if (initialized) {
    try {
      const project = core.readDescriptionProject(ctx.root, contract)
      const counts = core.descriptionStatus(ctx.root, contract)
      description = {
        established: project !== null || counts.files > 0,
        files: counts.files,
        modules: counts.modules,
        missingSemantics: counts.missingSemantics,
        plans: counts.plans,
        described: counts.described,
      }
    } catch (error) {
      collectWarnings([`description-status-unavailable: ${error?.message ?? String(error)}`])
    }
  }

  const expCounts = countsOf(experiments, ['open', 'confirmed', 'refuted', 'abandoned', 'inconclusive', 'pivoted'])
  const taskCounts = countsOf(tasks, ['draft', 'active', 'done', 'archived'])
  const gateEnabled = gates.filter((gate) => gate.enabled !== false).length

  // §9 状态块：只在 store 存在时读。未初始化时**不给零值块**——"读不到"必须与
  // "很干净"可区分（本会话反复打的假绿就是这两者被混为一谈）。
  let statusBlock = null
  if (initialized) {
    try {
      statusBlock = await statusBlockOf(ctx, ctx.root, contract)
    } catch (error) {
      collectWarnings([`status-block-unavailable: ${error?.message ?? String(error)}`])
    }
  }

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
      // 只在 store 存在时给（未初始化时不给零值：与 data.status 同一条纪律）。
      ...(description === null
        ? {}
        : {
            description: {
              files: description.files,
              modules: description.modules,
              missingSemantics: description.missingSemantics,
              plans: description.plans,
              described: description.described,
            },
          }),
    },
    heartbeats,
    decisions,
    recent: {
      experiments: experiments.slice(0, 3),
      tasks: tasks.slice(0, 3),
      gateRuns: recentRuns.slice(0, 3),
    },
    // `status` 缺席 = store 未初始化/不可读；不是"零任务"。
    ...(statusBlock === null ? {} : { status: statusBlock }),
  }

  if (!ctx.json) {
    const lines = [
      ['项目', data.name],
      ['根目录', ctx.root],
    ]
    if (!initialized) {
      lines.push(['契约', '未初始化（未找到 .agents/flow/flow.json）'])
      lines.push(['下一步', 'flow init'])
    } else {
      lines.push(['契约', `${loaded.source}（schema ${contract.schema ?? '?'}）`])
      lines.push(['存储', store || contract?.store?.root || '.agents/flow'])
      lines.push([
        '实验',
        `${experiments.length}（open ${expCounts.open} · confirmed ${expCounts.confirmed} · refuted ${expCounts.refuted} · abandoned ${expCounts.abandoned} · inconclusive ${expCounts.inconclusive} · pivoted ${expCounts.pivoted}${unreadableTail(unreadable.experiments)}）`,
      ])
      lines.push([
        '任务',
        `${tasks.length}（draft ${taskCounts.draft} · active ${taskCounts.active} · done ${taskCounts.done} · archived ${taskCounts.archived}${unreadableTail(unreadable.tasks)}）`,
      ])
      lines.push([
        '门禁',
        `${gates.length}（启用 ${gateEnabled}${unreadableTail(unreadable.gates)}）`,
      ])
      lines.push([
        '描述',
        description === null
          ? '读取失败（见警告）'
          : description.established
            ? `${description.files} 文件 · ${description.modules} 模块 · 缺语义 ${description.missingSemantics} · 计划 ${description.plans}`
            : '未建立（flow desc build）',
      ])
      lines.push(['待决策', `${decisions.counts.open}（阻塞 ${decisions.counts.blocking}）`])
      const hiddenBeats = Number(heartbeats.counts.hidden) || 0
      const deadBeats = Number(heartbeats.counts.dead) || 0
      lines.push([
        '心跳',
        `${heartbeats.counts.total}（可能已停 ${heartbeats.counts.stale}${deadBeats > 0 ? ` · 已结束 ${deadBeats}` : ''}${hiddenBeats > 0 ? ` · 旧子会话隐藏 ${hiddenBeats}` : ''}）`,
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
      if (statusBlock !== null) {
        out('')
        printStatusBlock(statusBlock)
      }
    }
  }
  return data
}

// ------------------------------------------------- T-12 B2：实验字段与自查

/** Split repeatable/comma flags into trimmed, non-empty entries. */
function splitEntries(values) {
  return (Array.isArray(values) ? values : [])
    .flatMap((entry) => String(entry ?? '').split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Collect the schema-2 seven judging fields from CLI flags. Missing required
 * fields are named in one `invalid` error (exit 2, CONTRACT §5.1).
 */
function experimentSeven(flags, ctx, { required }) {
  const fields = {}
  const text = (key, flag) => {
    const value = readString(flags, flag)
    if (value !== undefined && value.trim() !== '') fields[key] = value.trim()
  }
  text('direction', 'direction')
  text('expected', 'expected')
  text('primaryMetric', 'primary-metric')
  text('falsify', 'falsify')
  text('stopLoss', 'stop-loss')
  const guardrails = splitEntries(ctx.guardrails)
  if (guardrails.length > 0) fields.guardrails = guardrails
  const windowRaw = readString(flags, 'window-days')
  if (windowRaw !== undefined && windowRaw.trim() !== '') {
    const days = Number(windowRaw)
    if (!Number.isInteger(days) || days < 1) {
      throw new CliError('invalid', '--window-days 必须是正整数（观测周期，天）')
    }
    fields.windowDays = days
  }
  if (required) {
    const missing = ['direction', 'expected', 'primaryMetric', 'guardrails', 'falsify', 'windowDays', 'stopLoss']
      .filter((key) => fields[key] === undefined)
    if (missing.length > 0) {
      throw new CliError('invalid', `exp add 缺少 schema-2 必填字段：${missing.join(', ')}`)
    }
  }
  return fields
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
    for (const key of ['title', 'hypothesis', 'factor', 'scale', 'notes']) {
      const value = readString(flags, key)
      if (value !== undefined) input[key] = value
    }
    // 未初始化是用法错误（退出 1），先于 schema2 字段校验；与 task archive 一致。
    if (existsSync(path.join(ctx.root, '.agents', 'flow', 'flow.json')) === false) {
      throw new CliError('usage', '未初始化（未找到 .agents/flow/flow.json）；先运行 flow init')
    }
    if (!input.title) throw new CliError('usage', '用法: flow exp add --title T [...]')
    Object.assign(input, experimentSeven(flags, ctx, { required: true }))
    const explicitId = readString(flags, 'id')
    if (explicitId !== undefined && explicitId.trim() !== '') input.id = explicitId.trim()
    const parent = readString(flags, 'parent')
    if (parent !== undefined) input.parent = parent === '' || parent === 'null' ? null : parent
    const record = await core.addExperiment(ctx.root, contract, input)
    if (!ctx.json) out(`已创建实验 ${record.id}  ${record.title}`)
    return record
  }

  if (sub === 'update') {
    const id = requireString(flags, 'id', '用法: flow exp update <id> [...]')
    const patch = {}
    for (const key of ['title', 'hypothesis', 'factor', 'scale', 'measured', 'notes']) {
      const value = readString(flags, key)
      if (value !== undefined) patch[key] = value
    }
    Object.assign(patch, experimentSeven(flags, ctx, { required: false }))
    const learned = readString(flags, 'learned')
    if (learned !== undefined) patch.learned = learned
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

  if (sub === 'review') {
    const id = requireString(flags, 'id', '用法: flow exp review <id>')
    const record = await core.getExperiment(ctx.root, contract, id)
    const records = await core.listExperiments(ctx.root, contract)
    const hasSuccessor = (experimentId) =>
      records.some((item) => item.id !== experimentId && item.parent === experimentId)
    const review = core.reviewExperimentRecord(record, { hasSuccessor })
    if (!ctx.json) {
      out(`${review.id}  verdict ${review.verdict} · branch ${review.branch}`)
      out(review.missing.length === 0 ? '  missing: （无）' : `  missing: ${review.missing.join(', ')}`)
    }
    return review
  }

  if (sub === 'productize') {
    const id = requireString(flags, 'id', '用法: flow exp productize <id> [--gate release]')
    const gateId = readString(flags, 'gate')
    const result = await core.productizeExperiment(ctx.root, contract, id, gateId === undefined ? {} : { gateId })
    if (!ctx.json) {
      if (result.already) out(`已产品化（already）：${result.id} @ ${result.productizedAt}`)
      else out(`已产品化 ${result.id}（gate ${result.productizeGate?.id ?? 'release'} @ ${result.productizeGate?.runAt ?? '-'}）`)
    }
    return result
  }

  if (sub === 'cleanup') {
    const id = requireString(flags, 'id', '用法: flow exp cleanup <id> [--flag F]... [--code C]... [--data D]...')
    const result = await core.cleanupExperiment(ctx.root, contract, id, {
      flags: splitEntries(ctx.cleanupFlags),
      code: splitEntries(ctx.cleanupCodes),
      data: splitEntries(ctx.cleanupData),
    })
    if (!ctx.json) {
      out(`${result.changed ? '已记录清理' : '清理未变化'}：${result.id} @ ${result.cleanupAt}`)
      out(`  flags ${result.cleanup.flags.length} · code ${result.cleanup.code.length} · data ${result.cleanup.data.length}`)
    }
    return result
  }

  if (sub === 'rm') {
    const id = requireString(flags, 'id', '用法: flow exp rm <id> [--yes]')
    await confirmDelete(ctx, `实验 ${id}`)
    const result = await core.removeExperiment(ctx.root, contract, id)
    if (!ctx.json) out(`已删除实验 ${id}`)
    return result
  }

  throw new CliError('usage', `未知子命令 exp ${sub}（可用 list|show|tree|add|update|review|productize|cleanup|rm）`)
}

/** 文本模式的归档结果（core 返回 {archived, candidates, days, cutoff, dryRun, locked}）。 */
function printArchiveResult(result, days, dryRun) {
  const ids = result !== null && typeof result === 'object' && Array.isArray(result.archived) ? result.archived : []
  const candidates = result !== null && typeof result === 'object' && Number.isInteger(result.candidates) ? result.candidates : ids.length
  const cutoff =
    result !== null && typeof result === 'object' && (typeof result.cutoff === 'string' || typeof result.cutoff === 'number')
      ? String(result.cutoff)
      : ''
  const suffix = cutoff === '' ? '' : `，早于 ${cutoff}`
  if (result !== null && typeof result === 'object' && result.locked === true) {
    out('归档被写锁占用，本次跳过（下次运行会重试）')
    return
  }
  if (dryRun === true) {
    out(
      `检测到 ${candidates} 个到期任务（阈值 ${days} 天${suffix}）` +
        `${ids.length > 0 ? `：${ids.join(', ')}` : ''}（dry-run，未写盘）`,
    )
    return
  }
  if (ids.length === 0) out(`没有需要归档的任务（阈值 ${days} 天${suffix}）`)
  else out(`已归档 ${ids.length} 个任务（阈值 ${days} 天${suffix}）：${ids.join(', ')}`)
}

/**
 * `--parent <T-id>`：`''`/`none`/`null` 表示清空（根）。其余原样交给 core 校验
 * （宽引用/父须存在/禁自指/禁环 → invalid/退出码 2）。
 */
function readParentFlag(flags, core) {
  const raw = readString(flags, 'parent')
  if (raw === undefined) return undefined
  // 归一规则与 `flow_task` 共用 core.normalizeParentInput（''/none/null → 根）。
  return core.normalizeParentInput(raw)
}

async function cmdTask(ctx, sub) {
  const { core, flags } = ctx
  if (!sub) throw new CliError('usage', '用法: flow task <list|show|add|update|archive|normalize|link|unlink|rm>')
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
    for (const key of ['title', 'type', 'status', 'stage', 'owner', 'notes']) {
      const value = readString(flags, key)
      if (value !== undefined) input[key] = value
    }
    const experiment = readString(flags, 'experiment')
    if (experiment !== undefined) input.experiment = experiment.trim() === '' ? null : experiment
    const explicitId = readString(flags, 'id')
    if (explicitId !== undefined && explicitId.trim() !== '') input.id = explicitId.trim()
    const parent = readParentFlag(flags, core)
    if (parent !== undefined) input.parent = parent
    if (!input.title) throw new CliError('usage', '用法: flow task add --title T [...]')
    const record = await core.addTask(ctx.root, contract, input)
    if (!ctx.json) out(`已创建任务 ${record.id}  ${record.title}`)
    return record
  }

  if (sub === 'update') {
    const id = requireString(flags, 'id', '用法: flow task update <id> [...]')
    const patch = {}
    for (const key of ['title', 'type', 'status', 'stage', 'owner', 'notes']) {
      const value = readString(flags, key)
      if (value !== undefined) patch[key] = value
    }
    const experiment = readString(flags, 'experiment')
    if (experiment !== undefined) patch.experiment = experiment.trim() === '' ? null : experiment
    const parent = readParentFlag(flags, core)
    if (parent !== undefined) patch.parent = parent
    if (Object.keys(patch).length === 0) {
      throw new CliError('usage', 'task update 至少需要一个字段参数（如 --status）')
    }
    const record = await core.updateTask(ctx.root, contract, id, patch)
    if (!ctx.json) out(`已更新任务 ${record.id}  ${record.status || '-'}  ${record.title}`)
    return record
  }

  if (sub === 'archive') {
    const olderThan = readPositiveInteger(flags, 'older-than', '--older-than 需要正整数天数（例如 --older-than 30）')
    const dryRun = flags['dry-run'] === true
    // 与 task add 同一条判定（core 的 STORE_CONTRACT 是固定的 .agents/flow/flow.json）：
    // 未初始化按用法错误退出 1，由命令自己给出可操作的下一步。
    if (existsSync(path.join(ctx.root, '.agents', 'flow', 'flow.json')) === false) {
      throw new CliError('usage', '未初始化（未找到 .agents/flow/flow.json）；先运行 flow init')
    }
    // 0=关闭与越界 clamp/warning 都由 core.archiveTasks 统一判定（含 --older-than 覆盖）；
    // CLI 只负责人类输出与 `closed` 标记，不重复一套窗口逻辑。
    const reported = await core.archiveTasks(ctx.root, contract, {
      ...(olderThan === undefined ? {} : { days: olderThan }),
      dryRun,
    })
    const result =
      reported !== null && typeof reported === 'object' && reported.days === 0 ? { ...reported, closed: true } : reported
    if (!ctx.json) {
      if (result !== null && typeof result === 'object' && result.days === 0) {
        out('任务归档已关闭（tasks.archiveAfterDays=0）；用 --older-than N 显式指定天数')
      } else {
        printArchiveResult(result, result?.days, dryRun)
      }
    }
    return result
  }

  if (sub === 'normalize') {
    // 写盘通道与只读门禁（check tasks）分开：--dry-run 只报告，真跑在 core 写锁内迁移。
    return runTaskNormalize(ctx)
  }

  if (sub === 'link') {
    const teamSync = await loadTeamSync()
    const id = requireString(flags, 'id', '用法: flow task link <TASK-ID> --team <BOARD-ID>')
    const boardId = requireString(flags, 'team', '用法: flow task link <TASK-ID> --team <BOARD-ID>')
    const record = teamSync.linkTask(ctx.root, contract, id, boardId)
    if (!ctx.json) out(`已挂载 ${record.id} → ${record.team?.taskId ?? boardId}`)
    return record
  }

  if (sub === 'unlink') {
    const teamSync = await loadTeamSync()
    const id = requireString(flags, 'id', '用法: flow task unlink <TASK-ID>')
    const record = teamSync.unlinkTask(ctx.root, contract, id)
    if (!ctx.json) out(`已解除 ${record.id} 的团队板挂载`)
    return record
  }

  if (sub === 'rm') {
    const id = requireString(flags, 'id', '用法: flow task rm <id> [--yes]')
    await confirmDelete(ctx, `任务 ${id}`)
    const result = await core.removeTask(ctx.root, contract, id)
    if (!ctx.json) out(`已删除任务 ${id}`)
    return result
  }

  throw new CliError('usage', `未知子命令 task ${sub}（可用 list|show|add|update|archive|normalize|rm）`)
}

// ---------------------------------------------------------------- flow desc

/**
 * `description.enforce`/`enabled` 的展示值。契约层把 `enforce` 定为 `string`
 * （spec §1），未知值由 core 静默降级为 `auto`；这里用同一份
 * `DESCRIPTION_ENFORCE_MODES` 归一，避免 status 展示一个 core 根本不认的模式。
 */
function descModeOf(core, contract) {
  const config =
    contract !== null && contract !== undefined && typeof contract.description === 'object' && contract.description !== null
      ? contract.description
      : {}
  const raw = typeof config.enforce === 'string' ? config.enforce.trim() : ''
  return {
    enabled: config.enabled !== false,
    enforce: Array.isArray(core.DESCRIPTION_ENFORCE_MODES) && core.DESCRIPTION_ENFORCE_MODES.includes(raw) ? raw : 'auto',
  }
}

/** `--out` / `description.render` 的 containment：路径必须落在项目根内。 */
function descInsideRoot(root, value) {
  const base = path.resolve(root)
  const absolute = path.resolve(base, value)
  return { absolute, inside: absolute === base || absolute.startsWith(base + path.sep) }
}

/** 人类输出里的根相对 POSIX 路径（Windows 反斜杠也归一成 `/`）。 */
function descRelativeLabel(root, absolute) {
  return path.relative(path.resolve(root), absolute).split(path.sep).join('/')
}

/** 描述文件树（`flow desc show` 无 --path）：目录 → 文件（模块数）。 */
function descTreeLines(records) {
  const groups = new Map()
  for (const record of records) {
    const file = typeof record.path === 'string' ? record.path : ''
    const cut = file.lastIndexOf('/')
    const dir = cut < 0 ? '.' : file.slice(0, cut)
    const name = cut < 0 ? file : file.slice(cut + 1)
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir).push({ name, modules: Array.isArray(record.modules) ? record.modules.length : 0 })
  }
  const lines = []
  for (const dir of [...groups.keys()].sort()) {
    if (dir !== '.') lines.push(`${dir}/`)
    const entries = groups.get(dir).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    const width = Math.max(...entries.map((entry) => textWidth(entry.name)))
    for (const entry of entries) {
      lines.push(`${dir === '.' ? '' : '  '}${pad(entry.name, width)}  ${entry.modules} 模块`)
    }
  }
  return lines
}

/** 计划的一句话形状（人类输出用）。 */
function descPlanShape(plan) {
  if (plan.noSemanticChange === true) return `noSemanticChange · ${plan.reason}`
  const files = Array.isArray(plan.files) ? plan.files : []
  const modules = files.reduce((sum, file) => sum + (Array.isArray(file.modules) ? file.modules.length : 0), 0)
  return `${files.length} 文件 · ${modules} 模块`
}

/** 计划的人类可读展开（`flow desc plan --show`）。 */
function printDescPlan(plan) {
  const base = plan.base !== null && typeof plan.base === 'object' ? plan.base : {}
  out(`计划 ${plan.task}  ${plan.status}  base ${base.commit ?? 'null'}${base.clean === false ? '（工作树不干净）' : ''}`)
  out(
    `更新 ${fmtTime(plan.updated_at)} · history ${Array.isArray(plan.history) ? plan.history.length : 0} 条` +
      `${typeof plan.implemented_at === 'string' && plan.implemented_at !== '' ? ` · applied ${fmtTime(plan.implemented_at)}` : ''}`,
  )
  if (plan.noSemanticChange === true) {
    out(`无语义变更：${plan.reason}`)
    return
  }
  const files = Array.isArray(plan.files) ? plan.files : []
  if (files.length === 0) out('（计划没有文件）')
  for (const file of files) {
    out(`  ${file.op}  ${file.path}${typeof file.semantics === 'string' && file.semantics !== '' ? `  ${clip(file.semantics, 60)}` : ''}`)
    for (const module of Array.isArray(file.modules) ? file.modules : []) {
      const members = Array.isArray(module.members) ? `  [${module.members.join('、')}]` : ''
      out(
        `    ${module.op ?? 'change'}  ${module.id}${typeof module.semantics === 'string' && module.semantics !== '' ? `  ${clip(module.semantics, 50)}` : ''}${members}`,
      )
    }
  }
}

/**
 * `lib/desc.mjs` 的懒加载：**只给 `desc plan --template` 的源码扫描用**。
 * 台账的读/写/校验仍全部经 core；模板是分析阶段的脚手架，扫描是纯读。
 */
async function loadDescModel() {
  try {
    return await import(new URL('../lib/desc.mjs', import.meta.url).href)
  } catch (error) {
    throw new CliError('io', `无法加载描述模型（lib/desc.mjs）：${error?.message || String(error)}`)
  }
}

/**
 * `flow desc plan --template <src>` 的骨架：有记录时用记录里的文件/模块（语义预填
 * 当前值，便于只改该改的）；没有记录时扫源码，按 build 的种子模块给**空语义**骨架。
 * 只打印，不写盘。
 */
async function descPlanTemplate(core, root, contract, src) {
  let record = null
  try {
    record = core.getDescriptionFile(root, contract, src)
  } catch (error) {
    if (error?.code !== 'not-found') throw error
  }
  if (record !== null) {
    return {
      files: [
        {
          path: record.path,
          op: 'change',
          semantics: typeof record.semantics === 'string' ? record.semantics : '',
          modules: (Array.isArray(record.modules) ? record.modules : []).map((module) => ({
            id: module.id,
            op: 'change',
            semantics: typeof module.semantics === 'string' ? module.semantics : '',
          })),
        },
      ],
    }
  }
  const desc = await loadDescModel()
  const maxScanBytes = Number(contract?.description?.maxScanBytes)
  const scanned = desc.scanSourceAt(root, src, {
    ...(Number.isInteger(maxScanBytes) && maxScanBytes > 0 ? { maxScanBytes } : {}),
  })
  if (typeof scanned.skipped === 'string') {
    throw new CliError('usage', `无法扫描 ${src}（${scanned.skipped}）；--template 只接受项目内的源文件`)
  }
  const created = desc.createRecord(scanned)
  return {
    files: [
      {
        path: created.path,
        op: 'add',
        semantics: '',
        modules: (Array.isArray(created.modules) ? created.modules : []).map((module) => ({
          id: module.id,
          op: 'add',
          semantics: '',
          members: Array.isArray(module.members) ? [...module.members] : [],
        })),
      },
    ],
  }
}

async function cmdDesc(ctx, sub) {
  const { core, flags } = ctx
  if (!sub) {
    throw new CliError('usage', '用法: flow desc <status|build|show|set|plan|apply|render>')
  }
  const contract = loadContractFor(ctx, ctx.root)

  if (sub === 'status') {
    core.assertInitialized(ctx.root)
    const project = core.readDescriptionProject(ctx.root, contract)
    const counts = core.descriptionStatus(ctx.root, contract)
    const mode = descModeOf(core, contract)
    const established = project !== null || counts.files > 0
    const data = {
      established,
      name: project !== null && typeof project.name === 'string' ? project.name : null,
      semantics: project !== null && typeof project.semantics === 'string' ? project.semantics : '',
      files: counts.files,
      modules: counts.modules,
      missingSemantics: counts.missingSemantics,
      plans: counts.plans,
      described: counts.described,
      enabled: mode.enabled,
      enforce: mode.enforce,
    }
    if (!ctx.json) {
      if (!established) {
        out('描述台账  未建立描述（先跑 flow desc build）')
      } else {
        out(`描述台账  ${data.files} 文件 · ${data.modules} 模块 · 缺语义 ${data.missingSemantics} · 计划 ${data.plans}`)
        out(`覆盖  ${data.described}/${data.files} 个文件已写语义`)
        out(`模式  enabled=${data.enabled ? 'true' : 'false'} · enforce=${data.enforce}`)
      }
    }
    return data
  }

  if (sub === 'build') {
    const dryRun = flags['dry-run'] === true
    const result = core.buildDescription(ctx.root, contract, { dryRun })
    collectWarnings(result.warnings)
    if (!ctx.json) {
      out(
        `${dryRun ? '描述预演（--dry-run，未写盘）' : '描述已同步'}：新建 ${result.created} · 更新 ${result.updated} · 未变 ${result.unchanged} · 剪枝 ${result.pruned}`,
      )
    }
    return result
  }

  if (sub === 'show') {
    core.assertInitialized(ctx.root)
    const source = readString(flags, 'path')
    const graph = readString(flags, 'graph')
    if (graph !== undefined && graph !== 'tree' && graph !== 'mermaid') {
      throw new CliError('usage', '--graph 只支持 tree | mermaid')
    }
    if (graph === 'mermaid') {
      const markdown = core.renderDescription(ctx.root, contract)
      if (markdown === null) {
        if (!ctx.json) out('（还没有描述台账；先跑 flow desc build）')
        return { graph: null }
      }
      if (!ctx.json) out(markdown)
      return { graph: markdown }
    }
    if (source !== undefined) {
      let record = null
      try {
        record = core.getDescriptionFile(ctx.root, contract, source)
      } catch (error) {
        if (error?.code !== 'not-found') throw error
      }
      if (record === null) {
        if (!ctx.json) out(`（没有 ${source} 的描述记录；先跑 flow desc build）`)
        return { path: source, record: null }
      }
      if (!ctx.json) {
        out(`${record.path}  ${record.language ?? 'unknown'}  ${record.lines ?? 0} 行  ${record.hash ?? ''}`)
        out(`语义  ${typeof record.semantics === 'string' && record.semantics !== '' ? record.semantics : '（未填写）'}`)
        const modules = Array.isArray(record.modules) ? record.modules : []
        out('')
        out(`模块（${modules.length}）`)
        if (modules.length > 0) {
          out(
            table(
              ['模块', '标题', '语义', '成员'],
              modules.map((module) => [
                module.id,
                clip(module.title ?? '-', 24),
                clip(typeof module.semantics === 'string' && module.semantics !== '' ? module.semantics : '（未填写）', 48),
                clip(Array.isArray(module.members) ? module.members.join('、') : '-', 48),
              ]),
            ),
          )
        } else {
          out('（没有模块）')
        }
        const edges = Array.isArray(record.moduleEdges) ? record.moduleEdges : []
        out('')
        out(`模块边（${edges.length}）`)
        if (edges.length > 0) {
          out(
            table(
              ['从', '到', '次数', '依据'],
              edges.map((edge) => [
                edge.from,
                edge.to,
                String(edge.count ?? 0),
                Array.isArray(edge.why) ? edge.why.join('；') : '',
              ]),
            ),
          )
        } else {
          out('（没有模块边）')
        }
      }
      return record
    }
    const records = core.listDescriptionFiles(ctx.root, contract)
    const counts = core.descriptionStatus(ctx.root, contract)
    if (!ctx.json) {
      if (records.length === 0) {
        out('（没有描述记录；先跑 flow desc build）')
      } else {
        out(`描述台账  ${counts.files} 文件 · ${counts.modules} 模块`)
        out('')
        for (const line of descTreeLines(records)) out(line)
      }
    }
    return {
      counts: { files: counts.files, modules: counts.modules },
      files: records.map((record) => ({
        path: record.path,
        modules: Array.isArray(record.modules) ? record.modules.length : 0,
      })),
    }
  }

  if (sub === 'set') {
    const inputRaw = readString(flags, 'input')
    const projectSemantics = readString(flags, 'project-semantics')
    if (inputRaw === undefined && projectSemantics === undefined) {
      throw new CliError('usage', '用法: flow desc set --input <json> | --project-semantics <text>')
    }
    if (inputRaw !== undefined && projectSemantics !== undefined) {
      throw new CliError('usage', '--input 与 --project-semantics 不能同时使用（一次只写一类语义）')
    }
    if (projectSemantics !== undefined) {
      const project = core.setDescriptionProject(ctx.root, contract, { semantics: projectSemantics })
      if (!ctx.json) out(`已更新项目语义（${project.name ?? 'project'}）`)
      return project
    }
    const patch = readJsonValue(flags, 'input')
    if (patch === null || typeof patch !== 'object') {
      throw new CliError('usage', '--input 需要 JSON 对象（单文件补丁）或对象数组（多文件补丁）')
    }
    const result = core.setDescriptionFile(ctx.root, contract, patch)
    if (!ctx.json) out(result.changed ? `已更新 ${result.records.length} 个文件记录` : '（没有变化）')
    return result
  }

  if (sub === 'plan') {
    core.assertInitialized(ctx.root)
    const id = requireString(
      flags,
      'id',
      '用法: flow desc plan <T-id> --template <src> | --input <json> | --show | --rebase | --no-semantic-change --reason R',
    )
    const template = readString(flags, 'template')
    const inputRaw = readString(flags, 'input')
    const show = flags['show'] === true
    const rebase = flags['rebase'] === true
    const noChange = flags['no-semantic-change'] === true
    const modes = [
      ...(template === undefined ? [] : ['--template']),
      ...(inputRaw === undefined ? [] : ['--input']),
      ...(show ? ['--show'] : []),
      ...(rebase ? ['--rebase'] : []),
      ...(noChange ? ['--no-semantic-change'] : []),
    ]
    if (modes.length === 0) {
      throw new CliError(
        'usage',
        'flow desc plan 需要一种模式：--template <src> | --input <json> | --show | --rebase | --no-semantic-change --reason R',
      )
    }
    if (modes.length > 1) {
      throw new CliError('usage', `flow desc plan 一次只能用一种模式（收到 ${modes.join('、')}）`)
    }
    if (show) {
      const plan = core.getDescriptionPlan(ctx.root, contract, id)
      if (!ctx.json) {
        if (plan === null) out('无计划（flow desc plan <T-id> --template <src>）')
        else printDescPlan(plan)
      }
      return { plan, amended: false }
    }
    if (template !== undefined) {
      const skeleton = await descPlanTemplate(core, ctx.root, contract, template)
      if (!ctx.json) out(JSON.stringify(skeleton, null, 2))
      return skeleton
    }
    if (rebase) {
      const plan = core.getDescriptionPlan(ctx.root, contract, id)
      if (plan === null) {
        throw new CliError('usage', `任务 ${id} 还没有计划；先 flow desc plan ${id} --input <json>`)
      }
      // `setDescriptionPlan` 每次提交都会经 `planBaseOf` 按当前 HEAD/工作树重算 base；
      // implemented 计划带 `rebase:true` 时只刷新 base（语义与 implemented_at 不变）。
      const implemented = plan.status === 'implemented'
      const input =
        plan.noSemanticChange === true
          ? { noSemanticChange: true, reason: plan.reason }
          : { files: plan.files }
      const result = core.setDescriptionPlan(ctx.root, contract, id, input, { rebase: true })
      const note = implemented
        ? '计划已 implemented，--rebase 只刷新 base（语义与 implemented_at 不变）'
        : 'setDescriptionPlan 每次提交都会重算 base；本次提交已按当前 HEAD/工作树刷新'
      if (!ctx.json) out(note)
      return { ...result, rebased: true, note }
    }
    if (noChange) {
      const reason = readString(flags, 'reason')
      if (reason === undefined || reason.trim() === '') {
        throw new CliError('usage', '--no-semantic-change 需要 --reason <text>（说明为什么没有语义变更）')
      }
      const result = core.setDescriptionPlan(ctx.root, contract, id, { noSemanticChange: true, reason })
      if (!ctx.json) out(`已${result.amended ? '修订' : '创建'}计划 ${id}：无语义变更（${result.plan.reason}）`)
      return result
    }
    const input = readJsonValue(flags, 'input')
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new CliError('usage', '--input 需要一个 JSON 对象（计划输入，含 files 或 noSemanticChange）')
    }
    const result = core.setDescriptionPlan(ctx.root, contract, id, input)
    if (!ctx.json) out(`已${result.amended ? '修订' : '创建'}计划 ${id}（${result.plan.status} · ${descPlanShape(result.plan)}）`)
    return result
  }

  if (sub === 'apply') {
    core.assertInitialized(ctx.root)
    const id = requireString(flags, 'id', '用法: flow desc apply <T-id> [--dry-run]')
    const dryRun = flags['dry-run'] === true
    const result = core.applyDescriptionPlan(ctx.root, contract, id, { dryRun })
    collectWarnings(result.warnings)
    if (!ctx.json) {
      if (result.applied === false) out(`计划 ${id} 已是 implemented（幂等，未重复应用）`)
      else out(`${dryRun ? '将应用' : '已应用'}计划 ${id}（${descPlanShape(result.plan)}）`)
    }
    return result
  }

  if (sub === 'render') {
    core.assertInitialized(ctx.root)
    const markdown = core.renderDescription(ctx.root, contract)
    if (markdown === null) {
      throw new CliError('usage', '还没有描述台账（先跑 flow desc build），再 flow desc render')
    }
    const data = { checked: null }
    if (flags['check'] === true) {
      const configured = typeof contract?.description?.render === 'string' ? contract.description.render.trim() : ''
      if (configured === '') {
        if (!ctx.json) out('（description.render 未配置，--check 跳过）')
      } else {
        const target = descInsideRoot(ctx.root, configured)
        if (!target.inside) {
          throw new CliError('usage', `description.render 逃出项目根：${configured}`)
        }
        let actual = null
        try {
          actual = readFileSync(target.absolute, 'utf8')
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw new CliError('io', `读取渲染文件失败：${configured}（${error.code ?? error.message}）`)
          }
        }
        if (actual === null) {
          const error = new Error(`渲染文件不存在：${configured}（先跑 flow desc render --out ${configured}）`)
          error.code = 'check-failed'
          throw error
        }
        if (actual.replace(/\r\n/g, '\n') !== markdown) {
          const error = new Error(`渲染文件与现算内容不一致：${configured}`)
          error.code = 'check-failed'
          throw error
        }
        if (!ctx.json) out(`✓ 渲染文件与现算内容一致：${configured}`)
        data.checked = true
      }
    }
    const outPath = readString(flags, 'out')
    if (outPath !== undefined) {
      const target = descInsideRoot(ctx.root, outPath)
      if (!target.inside) {
        throw new CliError('usage', `--out 必须落在项目根内：${outPath}`)
      }
      mkdirSync(path.dirname(target.absolute), { recursive: true })
      writeFileSync(target.absolute, markdown)
      const label = descRelativeLabel(ctx.root, target.absolute)
      if (!ctx.json) out(`已写入 ${label}`)
      return { ...data, path: label, bytes: Buffer.byteLength(markdown, 'utf8') }
    }
    if (!ctx.json) out(markdown)
    return { ...data, markdown }
  }

  throw new CliError('usage', `未知子命令 desc ${sub}（可用 status|build|show|set|plan|apply|render）`)
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

// --------------------------------------------------- §9 项目状态块（P1 数据面）
//
// 装配逻辑**不在本文件**：`lib/capture.mjs` 的 `buildStatusBlock` 是工具返回
// （`flow_status` / `flow_heartbeat update`）与 CLI 共用的唯一真源。这里只做两件事：
// 动态加载它（保持 CLI 不静态依赖 lib/ 的既有约定）与显示截断（不是排序规则）。

/** Display cap for `heartbeat update` — the stack itself is already ordered by capture.mjs. */
const HEARTBEAT_STACK_ROWS = 5

/**
 * The §9 block for a heartbeat write. A block failure must never fail the
 * heartbeat itself (the write already landed): return null and warn.
 */
async function heartbeatStatusBlock(ctx, root, contract, stackRows) {
  try {
    return await statusBlockOf(ctx, root, contract, stackRows)
  } catch (error) {
    collectWarnings([`status-block-unavailable: ${error?.message ?? String(error)}`])
    return null
  }
}

async function loadCapture() {
  return import(new URL('../lib/capture.mjs', import.meta.url).href)
}

/**
 * The §9 status block for `root`. `stackRows` only truncates the **display** of the
 * already-sorted stack; `unfinished` keeps the true count.
 */
async function statusBlockOf(ctx, root, contract, stackRows = null) {
  const capture = await loadCapture()
  const block = capture.buildStatusBlock(ctx.core, root, contract)
  if (stackRows === null || block.stack.length <= stackRows) return block
  return { ...block, stack: block.stack.slice(0, stackRows) }
}

/** Human rendering of the block. Callers must guard with `!ctx.json` (out() always writes). */
function printStatusBlock(block, options = {}) {
  const { stackNote = '', hideFolded = false } = options
  const stages = Object.entries(block.counts)
    .filter(([, count]) => count > 0)
    .map(([stage, count]) => `${stage} ${count}`)
  out(`项目状态  未完成 ${block.unfinished}${stages.length > 0 ? ` ｜ ${stages.join(' · ')}` : ''}${block.recentCaptured.length > 0 ? ` ｜ 自动建 ${block.recentCaptured.length}` : ''}`)
  if (block.stack.length === 0) {
    out('  栈  空（没有未完成的任务）')
    return
  }
  const folded = block.unfinished - block.stack.length
  const foldedNote = folded > 0 && hideFolded === false ? `（共 ${block.unfinished} 条，其余折叠）` : ''
  out(`  栈  ${block.stack.length} 条${foldedNote}${stackNote}`)
  block.stack.forEach((item, index) => {
    out(`    ${index + 1}. ${item.id}  [${item.stageZh}]  ${clip(item.title, 48)}`)
  })
}

function printHeartbeatList(section, showAll = false) {
  const items = Array.isArray(section?.items) ? section.items : []
  const counts = section?.counts ?? { total: 0, active: 0, stale: 0, dead: 0 }
  const hidden = Number(counts.hidden) || 0
  const hiddenByVisibility = Number(section?.hiddenByVisibility) || 0
  const dead = items.filter((item) => item.liveness === 'dead').length
  out(
    `心跳 ${counts.total} 条（active ${counts.active} · stale ${counts.stale} · dead ${Number(counts.dead) || dead}${hidden > 0 ? ` · 旧子会话隐藏 ${hidden}` : ''}）  目录 ${section?.dir ?? '-'}`,
  )
  if (hidden > 0) out('提示：agent=subagent 的旧心跳已隐藏；flow heartbeat gc 可清理。')
  if (items.length === 0) {
    out(hiddenByVisibility > 0 ? '（没有可见的心跳）' : '（没有心跳记录）')
    if (hiddenByVisibility > 0) out(`已隐藏 ${hiddenByVisibility} 条（已结束/可能已停，--all 查看）`)
    return
  }
  out('')
  out(
    table(
      ['session', 'agent', 'status', '存活', '年龄', 'task', 'claims', 'goal'],
      items.map((item) => [
        shortSession(item.session),
        clip(item.agent || '-', 12),
        item.status || '-',
        item.liveness || '-',
        fmtAge(item.ageSeconds),
        item.task || '-',
        clip(fmtClaims(item.claims), 36),
        clip(item.goal || item.last_action || '-', 40),
      ]),
    ),
  )
  const deadItems = items.filter((item) => item.liveness === 'dead')
  if (deadItems.length > 0) out(`已结束（dead）：${deadItems.map((item) => item.file).join(', ')}`)
  const stale = items.filter((item) => item.stale === true && item.liveness !== 'dead')
  if (stale.length > 0) out(`可能已停：${stale.map((item) => item.file).join(', ')}`)
  if (hiddenByVisibility > 0 && showAll === false) {
    out(`已隐藏 ${hiddenByVisibility} 条（已结束/可能已停，--all 查看）`)
  }
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
    const options = { writer: 'cli' }
    if (sessionFlag !== undefined) options.session = sessionFlag
    for (const [key, option] of [['agent', 'agent'], ['goal', 'goal'], ['task', 'task']]) {
      const value = readString(flags, key)
      if (value !== undefined) options[option] = value
    }
    if (ctx.claims.length > 0) options.claims = ctx.claims
    if (note !== undefined) options.last_action = note
    const record = await core.startHeartbeat(root, contract, options)
    const block = await heartbeatStatusBlock(ctx, root, contract, null)
    if (!ctx.json) {
      out(`已开始心跳${record.createdTask ? `（新建任务 ${record.createdTask}）` : ''}`)
      printHeartbeat(record)
      if (block !== null) {
        out('')
        printStatusBlock(block)
      }
    }
    // 与工具侧（flow_status / flow_heartbeat update）同构：块的五个键平铺在 data 上。
    return block === null ? record : { ...record, ...block }
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
    const record = await core.updateHeartbeat(root, contract, sessionFlag, patch, { writer: 'cli' })
    const block = await heartbeatStatusBlock(ctx, root, contract, HEARTBEAT_STACK_ROWS)
    if (!ctx.json) {
      out('已更新心跳')
      printHeartbeat(record)
      if (block !== null) {
        out('')
        printStatusBlock(block, {
          stackNote: `（本轮只显示前 ${HEARTBEAT_STACK_ROWS} 条，共 ${block.unfinished} 条）`,
          hideFolded: true,
        })
      }
    }
    return block === null ? record : { ...record, ...block }
  }

  if (sub === 'end') {
    assertMainSessionHeartbeat('end')
    const options = { writer: 'cli' }
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
    const showAll = flags.all === true
    const section = core.readHeartbeatSection(root, contract, { visibility: showAll ? 'all' : 'active' })
    if (!ctx.json) printHeartbeatList(section, showAll)
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
      const verdict =
        typeof result.liveness === 'string' && result.liveness !== '' ? result.liveness : 'unknown'
      out(`存活  ${verdict}${typeof result.reason === 'string' && result.reason !== '' ? `（${result.reason}）` : ''}`)
    }
    if (requireActive && result.active !== true) {
      const verdict =
        typeof result.liveness === 'string' && result.liveness !== ''
          ? `，存活 ${result.liveness}${typeof result.reason === 'string' && result.reason !== '' ? `（${result.reason}）` : ''}`
          : ''
      const detail = result.record === null ? '没有心跳文件' : `心跳状态为 ${result.record.status || '未知'}${verdict}`
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
  Object.freeze({
    name: 'experiments',
    interpreter: 'core',
    script: 'lib/core.mjs#checkExperiments',
    description: '实验分流未闭环（schema2 缺字段/confirmed 未产品化/refuted·pivoted 缺 learned·cleanup）时失败（内置检查，只读）',
    args: '（无额外参数；experiments.enabled=false 时跳过）',
  }),
  Object.freeze({
    name: 'tasks',
    interpreter: 'core',
    script: 'lib/core.mjs#normalizeTaskFormat',
    description: '旧任务记录未归一（残留 goal 键 / 缺 type）时失败（内置检查：bin 特判路由 core，只读）',
    args: '[--type-map <file.json>]',
  }),
  Object.freeze({
    name: 'description',
    interpreter: 'core',
    script: 'lib/core.mjs#checkDescription',
    description: '描述台账漂移（缺记录/陈旧 hash/未归属声明/模块图不一致/缺语义）时失败（内置检查：bin 特判路由 core，只读）',
    args: '[--task <T-id>] [--strict]',
  }),
])

async function cmdCheck(ctx, sub) {
  // 内置检查（bin 特判路由到 core，不经过 scripts/ 目录）：
  // `decisions`、T-12 的 `experiments`、任务格式门禁 `tasks`，以及描述台账 `description`。
  if (sub === 'decisions') return runCheckDecisions(ctx)
  if (sub === 'experiments') return runCheckExperiments(ctx)
  if (sub === 'tasks') return runCheckTasks(ctx)
  if (sub === 'description') return runCheckDescription(ctx)
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
      out('机械检查（脚本相对包根路径；只读，不写 .agents/flow；内置项注明 core 实现）')
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
    /* Answer first, then apply a veto automatically (task-75). The veto module
       is loaded lazily like core, so a package missing it reports through the
       same io path instead of breaking every command. An apply failure must not
       fail the answer; it surfaces as a warning. */
    const veto = await import(new URL('../lib/veto.mjs', import.meta.url).href)
    const applied = veto.answerDecisionAndApply(ctx.root, contract, id, patch)
    const record = applied.decision
    if (applied.vetoWarning !== undefined) {
      collectWarnings([`veto auto-apply skipped: ${applied.vetoWarning}`])
    }
    if (!ctx.json) {
      out(`已回答决策 ${record.id}（${record.answer.choice}）`)
      if (applied.vetoApplied === true) out(`已自动应用否决结果：任务 ${applied.task.id} → ${applied.task.stage}`)
      printRecord(record)
    }
    return applied.vetoWarning === undefined ? record : { ...record, vetoApplied: false, vetoWarning: applied.vetoWarning }
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

/**
 * `flow check experiments`: read-only; `experiments.enabled=false` skips (exit 0)
 * and prints why. Failures exit 1 with `failed[]`; advisory warnings never block.
 */
function runCheckExperiments(ctx) {
  const { core } = ctx
  const loaded = core.loadContract(ctx.root)
  collectWarnings(loaded.warnings)
  const started = Date.now()
  const enabled = loaded.contract?.experiments?.enabled === true
  const result = core.checkExperiments(ctx.root, loaded.contract)
  const durationMs = Date.now() - started
  const lines = []
  if (enabled === false) {
    lines.push('✓ experiments：实验功能未开启（experiments.enabled=false），跳过')
  } else if (result.failed.length === 0) {
    lines.push(`✓ experiments：checked ${result.checked} · legacy ${result.legacy}`)
  } else {
    for (const item of result.failed) lines.push(`✗ ${item.id} ${item.rule}：${item.message}`)
  }
  for (const warning of Array.isArray(result.warnings) ? result.warnings : []) {
    lines.push(`! ${warning.id} ${warning.rule}：${warning.message}`)
  }
  const stdout = lines.join('\n')
  if (!ctx.json) {
    for (const line of lines) out(line)
  }
  if (enabled === false || result.failed.length === 0) {
    return {
      check: 'experiments',
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs,
      enabled,
      checked: result.checked,
      legacy: result.legacy,
      failed: [],
      warnings: result.warnings,
    }
  }
  const error = new Error('检查未通过：experiments（实验分流未闭环）')
  error.code = 'check-failed'
  error.silent = true
  error.payload = {
    check: 'experiments',
    exitCode: 1,
    stdout,
    stderr: '',
    durationMs,
    enabled,
    checked: result.checked,
    legacy: result.legacy,
    failed: result.failed,
    warnings: result.warnings,
  }
  throw error
}

/**
 * Read and validate `--type-map` (a CLI input channel, hence bin-side rather
 * than core: core only ever sees an already-validated `typeById` object). Every
 * malformed shape is a `usage` error (exit 2), never a check failure: a wrong
 * config must not be mistaken for a dirty ledger. Runs before the core call, so
 * it never takes the store lock and never writes.
 */
function loadTypeMap(root, mapPath) {
  if (mapPath.trim() === '') {
    throw new CliError('usage', '--type-map 需要一个文件路径（形如 .dsh-ops/type-map.json）')
  }
  const file = path.resolve(root, mapPath)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new CliError('usage', `--type-map 文件不存在：${mapPath}（${error.code ?? error.message}）`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError('usage', `--type-map 不是合法 JSON：${mapPath}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('usage', `--type-map 顶层必须是对象 { "<T-id>": "<type>" }：${mapPath}`)
  }
  const types = coreRef.TASK_TYPES
  const out = {}
  for (const [id, value] of Object.entries(parsed)) {
    const type = typeof value === 'string' ? value.trim() : ''
    if (types.includes(type) === false) {
      throw new CliError(
        'usage',
        `--type-map 里 ${id} 的值 ${JSON.stringify(value)} 不是合法 type（可用 ${types.join('|')}）：${mapPath}`,
      )
    }
    out[id] = type
  }
  return out
}

/**
 * D6 warnings for a `--type-map`: a key the ledger does not have, or one whose
 * record already carries a (different) type. Both are advisory only — the map is
 * allowed to be wider than what is missing (an AI-produced candidate list is),
 * and an already-typed record is never rewritten (CONTRACT §3.2 rule 3).
 * Read-only: `listTasks` uses the `{ unreadable }` collector so a broken file is
 * counted as a warning instead of being mistaken for "id absent".
 */
function warnTypeMapExtras(core, root, contract, typeById) {
  const known = new Map()
  const unreadable = []
  for (const record of core.listTasks(root, contract, { unreadable })) {
    if (typeof record?.id === 'string') known.set(record.id, record)
  }
  for (const file of unreadable) core.noteWarning(`unreadable: ${file}`)
  for (const [id, type] of Object.entries(typeById)) {
    const record = known.get(id)
    if (record === undefined) {
      core.noteWarning(`type-map-unknown-id: ${id}`)
      continue
    }
    const current = typeof record.type === 'string' ? record.type.trim() : ''
    if (current !== '' && current !== type) {
      core.noteWarning(`type-map-unused: ${id} 已有 type "${current}"`)
    }
  }
}

/**
 * `flow check tasks`: legacy task-format gate. Read-only (`fix: false`, no lock,
 * no write); issues exit 1, a malformed `--type-map` exits 2, and the type is
 * never guessed — a missing `type` stays an issue until the map supplies one.
 */
function runCheckTasks(ctx) {
  const { core } = ctx
  const loaded = core.loadContract(ctx.root)
  collectWarnings(loaded.warnings)
  // P1-1（review-core）：未初始化的 root 必须走 usage(exit 2)，与 CONTRACT §6.2 及兄弟检查
  // `check decisions`/`check experiments` 一致。`normalizeTaskFormat({fix:false})` 对空目录
  // 返回 `{ok:true, issues:[]}`，若不先拦，门禁会把"根本没台账"报成"台账很干净"——假绿。
  core.assertInitialized(ctx.root)
  const mapPath = readString(ctx.flags, 'type-map')
  const typeById = mapPath === undefined ? {} : loadTypeMap(ctx.root, mapPath)
  if (mapPath !== undefined) warnTypeMapExtras(core, ctx.root, loaded.contract, typeById)
  const started = Date.now()
  const result = core.normalizeTaskFormat(ctx.root, loaded.contract, { fix: false, typeById })
  const durationMs = Date.now() - started
  // D6 map diagnostics + `unreadable:` land in the core log; surface them now so
  // they reach the envelope even on the check-failed path.
  drainCoreWarnings()
  const ratio = (kind) => result.issues.filter((item) => item.kind === kind).length
  const counts = { 'legacy-goal': ratio('legacy-goal'), 'missing-type': ratio('missing-type') }
  const typeMap = mapPath ?? null
  const lines = []
  if (result.ok) {
    lines.push(`✓ tasks：legacy-goal 0 · missing-type 0${mapPath === undefined ? '' : ` · type-map ${mapPath}`}`)
  } else {
    for (const item of result.issues) lines.push(`✗ ${item.id} [${item.kind}] ${item.suggestion}`)
    lines.push(`合计 ${result.issues.length} 条：legacy-goal ${counts['legacy-goal']} · missing-type ${counts['missing-type']}`)
    if (counts['missing-type'] > 0) {
      lines.push('先确认 type：flow task normalize --type-map <file.json>（check tasks 只读，不会替你猜 type）')
    } else {
      lines.push('可以先归一：flow task normalize --dry-run 复查，再 flow task normalize')
    }
    // 给了 map 但记录仍在盘上缺 type：map 只是被校验通过，写盘要另跑 task normalize。
    if (mapPath !== undefined) {
      lines.push(`--type-map ${mapPath} 已校验（合法 type），但 check 不写盘；跑 flow task normalize --type-map ${mapPath} 才会真正补 type`)
    }
  }
  const stdout = lines.join('\n')
  if (!ctx.json) {
    for (const line of lines) out(line)
  }
  if (result.ok) {
    return { check: 'tasks', exitCode: 0, stdout, stderr: '', durationMs, ok: true, counts, issues: [], typeMap }
  }
  const error = new Error('检查未通过：tasks（旧任务记录未归一）')
  error.code = 'check-failed'
  error.silent = true
  error.payload = {
    check: 'tasks',
    exitCode: 1,
    stdout,
    stderr: '',
    durationMs,
    ok: false,
    counts,
    issues: result.issues,
    typeMap,
  }
  throw error
}

/**
 * `flow check description`：描述台账漂移检查（spec §6/§9）。只读；`enforce=auto`
 * 且台账还没建立时通过（并把「未建立描述，跳过」写进 stdout 与 warnings）。
 * 失败逐行给 `kind path[:module] — detail`，末行是汇总后的修复命令。
 */
function runCheckDescription(ctx) {
  const { core } = ctx
  const loaded = core.loadContract(ctx.root)
  collectWarnings(loaded.warnings)
  // 未初始化的 root 必须走 usage（check 族映射为 exit 2），不能把「没有台账」
  // 报告成「台账很干净」——与 runCheckTasks 同一条防假绿纪律。
  core.assertInitialized(ctx.root)
  const taskId = readString(ctx.flags, 'task')
  const strict = ctx.flags['strict'] === true
  const started = Date.now()
  const result = core.checkDescription(ctx.root, loaded.contract, {
    ...(taskId === undefined ? {} : { taskId }),
    strict,
  })
  const durationMs = Date.now() - started
  // core 侧 warning（如 git 不可用、扫描跳过）也要进信封。
  drainCoreWarnings()
  const counts = result.counts
  const lines = []
  const skip = result.warnings.find(
    (item) => item.kind === 'description-skipped' || item.kind === 'description-disabled',
  )
  if (result.ok) {
    if (skip !== undefined) {
      lines.push(`✓ description：${skip.detail}（mode ${result.mode}${skip.hint === '' ? '' : `；先跑 ${skip.hint}`}）`)
    } else {
      lines.push(
        `✓ description：文件 ${counts.files} · 模块 ${counts.modules} · 缺语义 ${counts.missingSemantics} · 计划 ${counts.plans}（mode ${result.mode}${strict ? ' · --strict' : ''}）`,
      )
    }
    for (const warning of result.warnings) {
      if (warning === skip) continue
      lines.push(`! ${warning.kind} ${warning.path} — ${warning.detail}`)
    }
  } else {
    for (const item of result.failed) {
      lines.push(`✗ ${item.kind} ${item.path}${item.module === undefined ? '' : `:${item.module}`} — ${item.detail}`)
    }
    const hints = [...new Set(result.failed.map((item) => item.hint).filter((hint) => hint !== ''))]
    lines.push(`修复：${hints.join('；')}`)
  }
  const stdout = lines.join('\n')
  if (!ctx.json) {
    for (const line of lines) out(line)
  }
  const payload = {
    check: 'description',
    exitCode: result.ok ? 0 : 1,
    stdout,
    stderr: '',
    durationMs,
    mode: result.mode,
    counts,
    failed: result.failed,
    warnings: result.warnings,
  }
  if (result.ok) return payload
  const error = new Error('检查未通过：description（描述台账漂移）')
  error.code = 'check-failed'
  error.silent = true
  error.payload = payload
  throw error
}

// ---------------------------------------------------------------- 任务格式归一

/** 合并后的 title 超过这个宽度就提示复查（面板首行是 `type: title`，§9.1.4）。 */
const TASK_TITLE_REVIEW_WIDTH = 120

/**
 * 待迁移记录在写盘后的 `title` 预览，按 `normalizeTaskRecord` 的同一条规则算
 * （只有 goal 非空、title 非空且两者不同才合并）。用于 `--dry-run` 的变更对照与
 * 长标题统计，不写盘。
 */
function plannedTaskTitle(record) {
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const goal = typeof record.goal === 'string' ? record.goal.trim() : ''
  if (goal === '' || title === '' || goal === title) return null
  return `${title} — ${goal}`
}

/** 文本显示宽度（CJK 记 2 列），用于判断合并后的 title 会不会顶掉面板布局。 */
function displayWidthOf(text) {
  let width = 0
  for (const char of String(text)) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char) ? 2 : 1
  }
  return width
}

/**
 * `flow task normalize`: the only write path for legacy task format (`goal` merge /
 * `type` backfill), kept deliberately separate from `check tasks` so the gate family
 * stays read-only. `--dry-run` is a report: `fix:false`, no lock, no write, exit 0.
 * Never guesses `type` — a record without a mapping stays unfixed and is reported.
 */
async function runTaskNormalize(ctx) {
  const { core } = ctx
  const dryRun = ctx.flags['dry-run'] === true
  // P1-1（review-core task-17）：`--dry-run` 也必须在未初始化 root 上走 usage。
  // `normalizeTaskFormat({fix:false})` 对空目录返回 `{ok:true, issues:[]}`，"读不到台账"
  // 与"台账很干净"会输出成同一句话——复查 §3.3③ 时会被当成"已归零"（静默假绿）。
  core.assertInitialized(ctx.root)
  const contract = loadContractFor(ctx, ctx.root)
  const mapPath = readString(ctx.flags, 'type-map')
  const typeById = mapPath === undefined ? {} : loadTypeMap(ctx.root, mapPath)
  if (mapPath !== undefined) warnTypeMapExtras(core, ctx.root, contract, typeById)

  // 预览用只读一遍（`fix:false` 不取锁）：--dry-run 直接用它，真跑用它算「写盘后还剩什么」。
  const planned = core.normalizeTaskFormat(ctx.root, contract, { fix: false, typeById })
  let result = planned
  let landed = []
  if (dryRun === false) {
    result = core.normalizeTaskFormat(ctx.root, contract, { fix: true, typeById })
    landed = Array.isArray(result.fixed) ? result.fixed : []
  }
  drainCoreWarnings()

  const records = new Map()
  for (const record of core.listTasks(ctx.root, contract)) {
    if (typeof record?.id === 'string') records.set(record.id, record)
  }
  const ratio = (kind) => result.issues.filter((item) => item.kind === kind).length
  const counts = { 'legacy-goal': ratio('legacy-goal'), 'missing-type': ratio('missing-type') }
  const remaining = { 'legacy-goal': 0, 'missing-type': 0 }
  if (dryRun === false) {
    // 写盘后的真实残留（core 的 ok 就是这个判定）：直接问一遍盘上状态，不自己推。
    const after = core.normalizeTaskFormat(ctx.root, contract, { fix: false, typeById })
    for (const item of after.issues) remaining[item.kind] = (remaining[item.kind] ?? 0) + 1
  }

  const lines = []
  const longTitles = []
  if (planned.issues.length === 0) {
    lines.push('（没有待迁移的旧记录）')
  } else if (dryRun) {
    for (const id of [...new Set(planned.issues.map((item) => item.id))]) {
      const record = records.get(id)
      const merged = plannedTaskTitle(record ?? {})
      const current = typeof record?.type === 'string' ? record.type.trim() : ''
      const mapped = typeById[id] === undefined ? null : typeById[id]
      const parts = [`${id}`]
      parts.push(merged === null ? '删 goal 键' : `title: ${JSON.stringify(record?.title ?? '')} → ${JSON.stringify(merged)}`)
      // 已有 type 的记录永不被 map 穿透（CONTRACT §3.2 规则 3）：只有真缺 type 才提补齐。
      if (current === '') parts.push(mapped === null ? 'type 仍缺（map 未覆盖）' : `type → ${JSON.stringify(mapped)}`)
      else parts.push(`type ${JSON.stringify(current)} 不动`)
      lines.push(`· ${parts.join(' · ')}`)
      if (merged !== null && displayWidthOf(merged) > TASK_TITLE_REVIEW_WIDTH) {
        longTitles.push({ id, width: displayWidthOf(merged), title: merged })
      }
    }
    lines.push(`将归一 ${new Set(planned.issues.map((item) => item.id)).size} 条：legacy-goal ${counts['legacy-goal']} · missing-type ${counts['missing-type']}（--dry-run：未写盘）`)
  } else {
    for (const id of landed) lines.push(`✓ 已归一 ${id}`)
    lines.push(`已归一 ${landed.length} 条（legacy-goal ${counts['legacy-goal']} · missing-type ${counts['missing-type']}）`)
    const left = remaining['legacy-goal'] + remaining['missing-type']
    if (left > 0) {
      lines.push(`仍有 ${left} 条待处理（legacy-goal ${remaining['legacy-goal']} · 缺 type：${remaining['missing-type']} 条）`)
      if (remaining['missing-type'] > 0) {
        lines.push('补 type 后再跑：flow task normalize --type-map <file.json>（不会替你猜 type）')
      }
    }
  }
  if (longTitles.length > 0) {
    lines.push(`⚠ 合并后 title 超过 ${TASK_TITLE_REVIEW_WIDTH} 列 ${longTitles.length} 条（面板首行是 type: title，请复查）：`)
    for (const item of longTitles) lines.push(`  ⚠ ${item.id} ${item.width} 列 ${clip(item.title, 60)}`)
  }
  const stdout = lines.join('\n')
  if (!ctx.json) {
    for (const line of lines) out(line)
  }
  return {
    fix: dryRun !== true,
    dryRun,
    ok: remaining['legacy-goal'] + remaining['missing-type'] === 0,
    issues: result.issues,
    fixed: landed,
    counts,
    remaining: dryRun ? null : remaining,
    longTitles: longTitles.map((item) => item.id),
    typeMap: mapPath ?? null,
  }
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

/**
 * The Team-sync module (P3b). Loaded lazily like `loadCore`: `flow --help` and the
 * unrelated commands must not pay for a module they never call, and a package
 * missing `lib/team-sync.mjs` still has a working CLI for everything else.
 *
 * Both entries write the **local ledger only** — linking never calls the Team
 * service, so there is no external write to fail halfway.
 */
async function loadTeamSync() {
  try {
    return await import(new URL('../lib/team-sync.mjs', import.meta.url).href)
  } catch (error) {
    throw new CliError('io', `无法加载团队板同步模块（lib/team-sync.mjs）：${error?.message || String(error)}`)
  }
}

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
    case 'desc':
      return cmdDesc(ctx, sub)
    case 'check':
      return cmdCheck(ctx, sub)
    default:
      throw new CliError('usage', `未知命令 "${command}"（可用 init|status|exp|task|gate|heartbeat|decision|desc|check；-h 查看帮助）`)
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
  // T-20261030-15：未声明的 flag 在这里失败（exit 1），早于任何 core 读写。
  assertFlagsAllowed(parsed)

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
    guardrails: parsed.guardrails,
    cleanupFlags: parsed.cleanupFlags,
    cleanupCodes: parsed.cleanupCodes,
    cleanupData: parsed.cleanupData,
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
    ['exp', 'task', 'gate', 'decision', 'desc'].includes(command) &&
    [
      'show', 'update', 'rm', 'run', 'logs', 'enable', 'disable', 'answer', 'withdraw',
      // task-83 P3b：`flow task link T-xxx --team B-yyy` / `flow task unlink T-xxx`
      'link', 'unlink',
      // T-12 B2：exp 的三个新子命令同样允许 `flow exp review E-xxx`
      'review', 'productize', 'cleanup',
      // T-20261108 D4：`flow desc plan T-xxx …` / `flow desc apply T-xxx`
      'plan', 'apply',
    ].includes(action) &&
    // `gate run --phase X` takes no id；`desc show` 是展示命令，不带 id。
    !(command === 'gate' && action === 'run' && parsed.flags.phase !== undefined) &&
    !(command === 'desc' && action === 'show')
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
