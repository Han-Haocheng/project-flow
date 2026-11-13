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
  setJsonMode,
} from '../lib/cli/shared.mjs'
import { cmdExp } from '../lib/cli/exp.mjs'
import { cmdTask } from '../lib/cli/tasks.mjs'
import { cmdGate } from '../lib/cli/gates.mjs'
import { cmdHeartbeat } from '../lib/cli/heartbeat.mjs'
import { cmdDecision } from '../lib/cli/decisions.mjs'
import { cmdDesc } from '../lib/cli/desc.mjs'
import { cmdCheck } from '../lib/cli/check.mjs'
import { cmdAspect } from '../lib/cli/aspect.mjs'
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
  'json', 'force', 'uninstall', 'yes', 'help', 'no-gates', 'require-active', 'dry-run', 'open', 'all',
  // T-20261108 D4：`desc plan/show/rebase`、`desc render --check`、`check description --strict`
  'strict', 'show', 'rebase', 'no-semantic-change', 'check',
  // T-20261111155622：门禁步骤 expect 手误默认拒绝，只有显式开这个开关才容错
  'allow-unknown-expect',
  // 2026-11-12 裁定 3：门禁分结构/行为；门禁运行默认跑完全部步骤，--fail-fast 才首败即停。
  // `gate rules --init/--record` 是规则文件防篡改的写命令（裁定 1），都是纯开关。
  'fail-fast', 'init', 'record', 'purge',
  // T-20261113163323：done 无 reviewer 回执时的显式覆盖（必须配 --reason）。
  'no-dispatch',
])
const VALUE_FLAGS = new Set([
  'root', 'name', 'keep', 'stale-hours',
  'title', 'hypothesis', 'factor', 'parent', 'expected', 'scale', 'notes',
  'status', 'measured', 'metrics', 'commits',
  'owner', 'goal', 'role', 'outcome',
  'id', 'phase', 'step', 'enabled', 'timeout', 'limit',
  'allow', 'marker', 'threshold', 'file', 'type', 'type-map', 'stage', 'team', 'summary', 'merged-into', 'mount', 'mount-kind',
  'session', 'agent', 'claim', 'note', 'task',
  'question', 'kind', 'option', 'default', 'recommendation', 'rationale',
  'blocks', 'affects', 'supersedes', 'choice', 'reason', 'by', 'days',
  'older-than', 'older-than-hours',
  // T-12 B2（schema2 七字段 / 分流 / 关联）
  'direction', 'primary-metric', 'guardrail', 'falsify', 'window-days', 'stop-loss',
  'learned', 'experiment', 'gate', 'flag', 'code', 'data',
  // T-20261108 D4：描述台账的取值参数
  'path', 'graph', 'input', 'template', 'out', 'project-semantics',
  // 2026-11-12 裁定 3：门禁挂载点（layer/module/feature/aspect + module/aspect 的 target）。
  'mount-level', 'mount-target',
  // 2026-11-12 裁定 6：aspect 锁的租约参数（--ttl 秒 / --wait 毫秒）与占用对象。
  'ttl', 'wait', 'aspect',
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
  // 面板状态快照（T-20261112154725）：前端（web/TUI）唯一允许读的台账面。
  state: Object.freeze({ flags: [] }),
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
    add: { flags: ['id', 'title', 'type', 'status', 'owner', 'notes', 'experiment', 'parent', 'stage', 'reason', 'merged-into', 'mount', 'mount-kind'] },
    // `--commits` 与 `flow exp update` 对齐（T-20261113110938 ①）：逗号分隔的短 sha 列表。
    update: { flags: ['id', 'title', 'type', 'status', 'owner', 'notes', 'experiment', 'parent', 'stage', 'commits', 'no-dispatch', 'reason', 'merged-into', 'mount', 'mount-kind'] },
    // T-20261113163323：派工回执原语（claim 开放 → release 闭合）。
    claim: { flags: ['id', 'agent', 'role', 'session', 'reason'] },
    release: { flags: ['id', 'agent', 'outcome', 'reason', 'role', 'summary', 'file'] },
    // T-20261113170144：任务内交接产物（put/list/show；正文拷贝进 .agents/reports）。
    art: { flags: ['id', 'role', 'summary', 'file', 'agent'] },
    archive: { flags: ['older-than', 'dry-run'] },
    sweep: { flags: ['older-than-hours', 'dry-run'] },
    normalize: { flags: ['type-map', 'dry-run'] },
    link: { flags: ['id', 'team'] },
    unlink: { flags: ['id'] },
    // 下一步查表（只读）与可执行验收（写 verification 回执）。
    next: { flags: ['id'] },
    verify: { flags: ['id', 'timeout'] },
    // T-20261113163505：rm 默认撤销（需 --reason）；--purge 才物理删除并写审计。
    rm: { flags: ['id', 'yes', 'reason', 'purge'] },
  }),
  gate: Object.freeze({
    list: { flags: [] },
    show: { flags: ['id'] },
    // 2026-11-12 裁定 3：结构门禁可挂四层（layer/module/feature/aspect），行为门禁
    // 只准挂 feature；`--fail-fast` 传进 runGate 决定首败即停还是跑完再汇总。
    add: {
      flags: ['id', 'title', 'phase', 'kind', 'mount-level', 'mount-target', 'fail-fast', 'allow-unknown-expect'],
      repeat: ['step'],
    },
    update: {
      flags: ['id', 'title', 'phase', 'enabled', 'kind', 'mount-level', 'mount-target', 'fail-fast', 'allow-unknown-expect'],
      repeat: ['step'],
    },
    enable: { flags: ['id'] },
    disable: { flags: ['id'] },
    rm: { flags: ['id', 'yes'] },
    run: { flags: ['id', 'phase', 'timeout', 'force', 'fail-fast'] },
    logs: { flags: ['id', 'limit'] },
    // T-20261113163505：把 commit 阶段门禁绑到 git pre-commit（默认不自动安装）。
    'install-hook': { flags: ['force', 'uninstall', 'phase'] },
    // 2026-11-12 裁定 1：规则文件校验和的初始化与「改规则必须留痕」。
    rules: { flags: ['init', 'record', 'reason', 'by'] },
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
  // 2026-11-12 裁定 6：aspect 锁（登记即串行，不阻断）。--file 是单值（补文件域），
  // 不重复；--aspect 只支持 flag 形式，位置参数暂不归一化。
  aspect: Object.freeze({
    flags: ['session', 'ttl', 'wait', 'aspect', 'file', 'force', 'dry-run', 'reason', 'by'],
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
    case 'state':
      return runState(ctx)
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
    case 'aspect':
      return cmdAspect(ctx, sub)
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
  // 帮助文案单源在 lib/cli/mcp-server.mjs（cli 写域）；那一行还写着 `node bin/mcp.mjs`。
  // 从 `flow mcp-serve` 进来时必须把入口名改成用户实际敲的命令，否则帮助在教旧用法。
  // 只替换入口名，正文（协议/能力/参数）仍来自同一份 USAGE。
  const wantsHelp = argv.includes('--help') || argv.includes('-h')
  if (wantsHelp) {
    out(server.USAGE.replace('node bin/mcp.mjs', 'flow mcp-serve'))
    return 0
  }
  return await server.main(argv)
}

/**
 * `flow [--root <dir>] mcp-serve [options]`：全局参数可以前置，命令名必须出现在
 * 第一个非全局 token 位置（`--help` 前置时仍按 CLI 帮助处理，不吞掉用户要看的总览）。
 * 返回交给 MCP 服务端解析的 argv；不是 mcp-serve 形式时返回 null。
 */
function mcpServeInvocation(argv) {
  const globals = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === 'mcp-serve') return { args: [...globals, ...argv.slice(index + 1)] }
    if (token === '--help' || token === '-h') return null
    if (token === '--root') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) return null
      globals.push(token, value)
      index += 1
      continue
    }
    if (token.startsWith('--root=')) {
      globals.push(token)
      continue
    }
    return null
  }
  return null
}

// 面板状态快照（T-20261112154725）：前端唯一允许读的台账面。实现放
// lib/cli/state.mjs；这里动态 import，保持其它命令「先解析参数、后加载 core」的
// 惰性（state 会连带加载 state-snapshot 的投影层）。
async function runState(ctx) {
  let mod
  try {
    mod = await import(new URL('../lib/cli/state.mjs', import.meta.url).href)
  } catch (error) {
    throw new CliError('io', `无法加载面板快照模块（lib/cli/state.mjs）：${error?.message || String(error)}`)
  }
  return await mod.cmdState(ctx)
}

function exitCodeOf(code) {
  return EXIT_BY_CODE[code] ?? EXIT.io
}

async function main() {
  // `flow [--root <dir>] mcp-serve` 先于一切 cli 输出装置分流：这条通道的 stdout 是
  // JSON-RPC，不能出现 usage / 信封 / 警告。前置的全局参数原样转给 MCP 服务端解析。
  const mcpServe = mcpServeInvocation(process.argv.slice(2))
  if (mcpServe !== null) return await runMcpServe(mcpServe.args)

  const parsed = parseArgv(process.argv.slice(2))
  setJsonMode(parsed.flags.json === true)
  topCommand = parsed.positional[0] ?? ''

  if (parsed.flags.help === true) {
    out(USAGE)
    // USAGE 由 lib/cli/misc.mjs 维护（CLI 域）；单可执行新增的 MCP 子命令在这里
    // 补一行，避免为了一个入口去改另一个模块的文件。
    out('  state                      面板状态快照（--json；前端经此读台账，不直连 store）')
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
  const ctx = {
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
  /* flow task art <put|list|show> <id>：第三段是动词，不是多余的参数。 */
  if (command === 'task' && action === 'art') {
    const verb = extra.shift()
    if (verb === undefined || ['put', 'list', 'show'].includes(verb) === false) {
      throw new CliError('usage', '用法: flow task art <put|list|show> <id> [options]')
    }
    ctx.artAction = verb
  }
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
        // T-20261113163323：`flow task claim T-xxx` / `flow task release T-xxx`
        'claim', 'release',
        // T-20261113170144：`flow task art put|list|show <id>`
        'art',
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
