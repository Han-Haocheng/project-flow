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
import {
  CliError,
  drainCoreWarnings,
  emitJson,
  errOut,
  jsonMode,
  out,
  pendingWarnings,
  printWarnings,
  setCoreRef,
  setJsonMode,
} from '../lib/cli/shared.mjs'
import { cmdExp } from '../lib/cli/exp.mjs'
import { cmdTask } from '../lib/cli/tasks.mjs'
import { cmdGate } from '../lib/cli/gates.mjs'
import { cmdHeartbeat } from '../lib/cli/heartbeat.mjs'
import { cmdDecision } from '../lib/cli/decisions.mjs'
import { cmdDesc } from '../lib/cli/desc.mjs'
import { cmdCheck } from '../lib/cli/check.mjs'
import { cmdBackup, cmdDoctor, cmdInit, cmdStatus, USAGE } from '../lib/cli/misc.mjs'

// A closed downstream pipe (`flow status | head`) must end quietly, not throw.
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') process.exit(0)
})

const EXIT = { usage: 1, invalid: 2, notFound: 3, io: 4 }
// `check-failed` 只由检查族抛出：`flow check` 走下面的 `CHECK_EXIT_BY_CODE`，
// `flow desc render --check` 走这张表（同样按「检查失败 → 1」归一）。
const EXIT_BY_CODE = {
  usage: 1, invalid: 2, 'not-found': 3, conflict: 2, io: 4, 'check-failed': 1,
  // `flow task next` 的「没有下一步」：终态（done/archived）不是错误，但按约定必须
  // 退非 0（0 表示确实还有下一步可走），所以单列一个码，消息里写清原因。
  terminal: 3,
}

// `flow check` 的退出码词汇（数字与插件一致，语义按检查归一，见 CONTRACT §6）。
const CHECK_EXIT_BY_CODE = {
  usage: 2,
  'check-failed': 1,
  'check-missing': 3,
  'check-io': 4,
  'not-found': 3,
  io: 4,
}

const BOOL_FLAGS = new Set([
  'json', 'force', 'yes', 'help', 'no-gates', 'require-active', 'dry-run', 'open', 'all',
  // T-20261108 D4：`desc plan/show/rebase`、`desc render --check`、`check description --strict`
  'strict', 'show', 'rebase', 'no-semantic-change', 'check',
  // T-20261111155622：门禁步骤 expect 手误默认拒绝，只有显式开这个开关才容错
  'allow-unknown-expect',
])
const VALUE_FLAGS = new Set([
  'root', 'name', 'keep', 'stale-hours',
  'title', 'hypothesis', 'factor', 'parent', 'expected', 'scale', 'notes',
  'status', 'measured', 'metrics', 'commits',
  'owner', 'goal',
  'id', 'phase', 'step', 'enabled', 'timeout', 'limit',
  'allow', 'marker', 'threshold', 'file', 'type', 'type-map', 'stage', 'team',
  'session', 'agent', 'claim', 'note', 'task',
  'question', 'kind', 'option', 'default', 'recommendation', 'rationale',
  'blocks', 'affects', 'supersedes', 'choice', 'reason', 'by', 'days',
  'older-than', 'older-than-hours',
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
 * cross-checks it against the literal flag reads in `bin/flow.mjs` + `lib/cli/*.mjs`.
 */
export const SPEC = Object.freeze({
  init: Object.freeze({ flags: ['name', 'force', 'no-gates'] }),
  status: Object.freeze({ flags: [] }),
  backup: Object.freeze({ flags: ['keep'] }),
  doctor: Object.freeze({ flags: ['stale-hours'] }),
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
    sweep: { flags: ['older-than-hours', 'dry-run'] },
    normalize: { flags: ['type-map', 'dry-run'] },
    link: { flags: ['id', 'team'] },
    unlink: { flags: ['id'] },
    // 下一步查表（只读）与可执行验收（写 verification 回执）。
    next: { flags: ['id'] },
    verify: { flags: ['id', 'timeout'] },
    rm: { flags: ['id', 'yes'] },
  }),
  gate: Object.freeze({
    list: { flags: [] },
    show: { flags: ['id'] },
    add: { flags: ['id', 'title', 'phase', 'allow-unknown-expect'], repeat: ['step'] },
    update: { flags: ['id', 'title', 'phase', 'enabled', 'allow-unknown-expect'], repeat: ['step'] },
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
    rm: { flags: ['id', 'session', 'yes'] },
    gc: { flags: ['dry-run', 'older-than-hours'] },
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
// 输出/JSON 信封/warnings/读取助手已搬至 lib/cli/shared.mjs；本段锚点保留给 module-domain。

// --------------------------------------------- 心跳：主会话判定与心跳根
// 主会话判定/心跳根/status 块在 lib/cli/heartbeat.mjs（misc 的 status 复用）。

// ---------------------------------------------------------------- 命令实现
// 各域命令实现在 lib/cli/*.mjs；本段只保留内置检查目录与命令→handler 派发表。
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

async function dispatch(ctx, parsed) {
  const [command, action] = parsed.positional
  const sub = action
  switch (command) {
    case 'init':
      return cmdInit(ctx)
    case 'status':
      return cmdStatus(ctx)
    case 'backup':
      return cmdBackup(ctx)
    case 'doctor':
      return cmdDoctor(ctx)
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
      return cmdCheck(ctx, sub, BUILTIN_CHECKS)
    default:
      throw new CliError('usage', `未知命令 "${command}"（可用 init|status|exp|task|gate|heartbeat|decision|desc|check；-h 查看帮助）`)
  }
}

// ------------------------------------------------- T-12 B2：实验字段与自查
// 实验字段/自查实现已搬至 lib/cli/exp.mjs；锚点保留给 module-domain。

// ---------------------------------------------------------------- 入口
// 顶层命令名：catch 里据此选择退出码词汇（`flow check` 用检查语义）。
let topCommand = ''

// ------------------------------------------- 单可执行：MCP 是 CLI 的子命令
//
// T-20261112154655：后端只有一个可执行 `flow`。MCP adapter 从「第二个 bin」
// 降为 `flow mcp-serve` 子命令，与 `flow <command>` 平级、共用同一份 core
// （协议与工具面全在 lib/cli/mcp-server.mjs，本文件只转发，不复制实现）。
//
// 这一支在参数解析与核心加载之前分流：stdio 协议期间 stdout 只属于 JSON-RPC，
// 不能混入 usage / JSON 信封 / 警告；`--root`/`--timeout`/`--help` 等参数由
// MCP 服务端自己的解析器消费（形状见 lib/cli/mcp-server.mjs 的 parseServerArgs）。
async function runMcpServe(argv) {
  let server
  try {
    server = await import(new URL('../lib/cli/mcp-server.mjs', import.meta.url).href)
  } catch (error) {
    throw new CliError('io', `无法加载 MCP 服务端（lib/cli/mcp-server.mjs）：${error?.message || String(error)}`)
  }
  return await server.main(argv)
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

async function main() {
  // `flow mcp-serve` 先于一切 cli 输出装置分流：这条通道的 stdout 是 JSON-RPC，
  // 不能出现 usage / 信封 / 警告。参数原样交给 MCP 服务端解析。
  if (process.argv[2] === 'mcp-serve') return await runMcpServe(process.argv.slice(3))

  const parsed = parseArgv(process.argv.slice(2))
  setJsonMode(parsed.flags.json === true)
  topCommand = parsed.positional[0] ?? ''

  if (parsed.flags.help === true) {
    out(USAGE)
    // USAGE 由 lib/cli/misc.mjs 维护（CLI 域）；单可执行新增的 MCP 子命令在这里
    // 补一行，避免为了一个入口去改另一个模块的文件。
    out('  mcp-serve                  以 stdio 启动 MCP adapter（与 flow <command> 同一份 core）')
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
  setCoreRef(core)
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
    (['exp', 'task', 'gate', 'decision', 'desc'].includes(command) &&
      [
        'show', 'update', 'rm', 'run', 'logs', 'enable', 'disable', 'answer', 'withdraw',
        // task-83 P3b：`flow task link T-xxx --team B-yyy` / `flow task unlink T-xxx`
        'link', 'unlink',
        // T-12 B2：exp 的三个新子命令同样允许 `flow exp review E-xxx`
        'review', 'productize', 'cleanup',
        // T-20261108 D4：`flow desc plan T-xxx …` / `flow desc apply T-xxx`
        'plan', 'apply',
        // 2026-11-11：`flow task next T-xxx` / `flow task verify T-xxx`
        'next', 'verify',
      ].includes(action) &&
      // `gate run --phase X` takes no id；`desc show` 是展示命令，不带 id。
      !(command === 'gate' && action === 'run' && parsed.flags.phase !== undefined) &&
      !(command === 'desc' && action === 'show')) ||
    // 心跳只有 `rm <session>` 把会话 id 作为位置参数（start/update/end 的
    // `--session` 是 flag，不走这条路径）。
    (command === 'heartbeat' && action === 'rm')
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
