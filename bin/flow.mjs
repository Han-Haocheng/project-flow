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

// A closed downstream pipe (`flow status | head`) must end quietly, not throw.
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') process.exit(0)
})

const USAGE = `project-flow CLI（schema 2）

用法
  flow <command> [options]
  flow --root <dir> <command> [--json]

命令
  init      初始化 .dsh/flow（--name X --force --no-gates --migrate trailers|tasks|all）
  status    项目名、契约源、实验/任务/门禁计数与最近记录

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

  check list
  check staged --allow <path> [--allow <path> ...]
  check release-baseline --marker <text> [--threshold <N>]
  check state [--file <path>]
  check doc --file <path> --type task|design|incident|release

  机械检查（只读，不写 .dsh/flow）：运行包里 skills/ai-collaborative-dev-workflow/
  scripts/ 下的检查脚本；超时用 --timeout <seconds>（默认 120）。

全局
  --root <dir>   项目根目录（默认当前目录）
  --json         机器可读输出：{ok:true,data} 或 {ok:false,error:{code,message}}
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

const BOOL_FLAGS = new Set(['json', 'force', 'yes', 'help', 'no-gates', 'require-active'])
const VALUE_FLAGS = new Set([
  'root', 'name', 'migrate',
  'title', 'hypothesis', 'factor', 'parent', 'expected', 'scale', 'notes',
  'status', 'measured', 'metrics', 'commits',
  'owner', 'goal',
  'id', 'phase', 'step', 'enabled', 'timeout', 'limit',
  'allow', 'marker', 'threshold', 'file', 'type',
  'session', 'agent', 'claim', 'note',
])
const REPEAT_FLAGS = new Set(['step', 'allow', 'claim'])

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

  return { flags, steps: repeated.step || [], allows: repeated.allow || [], claims: repeated.claim || [], positional, errors }
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

function showWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return
  for (const warning of warnings) errOut(`警告: ${typeof warning === 'string' ? warning : JSON.stringify(warning)}`)
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
  const migrate = readString(flags, 'migrate')
  if (migrate !== undefined) {
    if (migrate === 'all') options.migrate = ['trailers', 'tasks']
    else if (migrate === 'trailers' || migrate === 'tasks') options.migrate = [migrate]
    else throw new CliError('usage', '--migrate 只接受 trailers | tasks | all')
  }

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
    for (const [kind, label] of [['trailers', '实验 trailer'], ['tasks', '旧任务']]) {
      const imported = result?.imported?.[kind]
      if (imported === undefined) continue
      if (typeof imported === 'number') {
        out(`迁移 ${label}: ${imported}`)
      } else if (imported && typeof imported === 'object') {
        const count = imported.imported ?? imported.count ?? 0
        const skipped = imported.skipped ?? 0
        out(`迁移 ${label}: 新增 ${count} · 跳过 ${skipped}`)
      }
    }
  }
  showWarnings(result?.warnings)
  return result
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
  const contract = loaded.contract
  const initialized = loaded.source !== 'defaults'

  let experiments = []
  let tasks = []
  let gates = []
  let store = null
  if (initialized) {
    ctx.contract = contract
    experiments = await core.listExperiments(ctx.root, contract)
    tasks = await core.listTasks(ctx.root, contract)
    gates = await core.listGates(ctx.root, contract)
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
      experiments: { total: experiments.length, ...expCounts },
      tasks: { total: tasks.length, ...taskCounts },
      gates: { total: gates.length, enabled: gateEnabled },
    },
    heartbeats,
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
        `${experiments.length}（open ${expCounts.open} · confirmed ${expCounts.confirmed} · refuted ${expCounts.refuted} · abandoned ${expCounts.abandoned}）`,
      ])
      lines.push([
        '任务',
        `${tasks.length}（draft ${taskCounts.draft} · active ${taskCounts.active} · done ${taskCounts.done} · archived ${taskCounts.archived}）`,
      ])
      lines.push(['门禁', `${gates.length}（启用 ${gateEnabled}）`])
      lines.push(['心跳', `${heartbeats.counts.total}（可能已停 ${heartbeats.counts.stale}）`])
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
  showWarnings(loaded.warnings)
  return data
}

async function cmdExp(ctx, sub) {
  const { core, flags } = ctx
  if (!sub) throw new CliError('usage', '用法: flow exp <list|show|tree|add|update|rm>')
  const contract = ctx.contract || (ctx.contract = core.loadContract(ctx.root).contract)

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
  const contract = ctx.contract || (ctx.contract = core.loadContract(ctx.root).contract)

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
  const contract = ctx.contract || (ctx.contract = core.loadContract(ctx.root).contract)

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
  out(`心跳 ${counts.total} 条（active ${counts.active} · stale ${counts.stale}）  目录 ${section?.dir ?? '-'}`)
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
  if (!sub) throw new CliError('usage', '用法: flow heartbeat <start|update|end|list|status>')
  const contract = ctx.contract || (ctx.contract = core.loadContract(ctx.root).contract)
  const sessionFlag = readString(flags, 'session')
  const note = readString(flags, 'note')

  if (sub === 'start') {
    const options = {}
    if (sessionFlag !== undefined) options.session = sessionFlag
    for (const [key, option] of [['agent', 'agent'], ['goal', 'goal'], ['task', 'task']]) {
      const value = readString(flags, key)
      if (value !== undefined) options[option] = value
    }
    if (ctx.claims.length > 0) options.claims = ctx.claims
    if (note !== undefined) options.last_action = note
    const record = await core.startHeartbeat(ctx.root, contract, options)
    if (!ctx.json) {
      out(`已开始心跳${record.createdTask ? `（新建任务 ${record.createdTask}）` : ''}`)
      printHeartbeat(record)
    }
    return record
  }

  if (sub === 'update') {
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
    const record = await core.updateHeartbeat(ctx.root, contract, sessionFlag, patch)
    if (!ctx.json) {
      out('已更新心跳')
      printHeartbeat(record)
    }
    return record
  }

  if (sub === 'end') {
    const options = {}
    if (sessionFlag !== undefined) options.session = sessionFlag
    const status = readString(flags, 'status')
    if (status !== undefined) {
      if (status !== 'done' && status !== 'missed') throw new CliError('usage', 'heartbeat end 的 --status 只接受 done | missed')
      options.status = status
    }
    if (note !== undefined) options.note = note
    const record = await core.endHeartbeat(ctx.root, contract, options)
    if (!ctx.json) {
      out(`已结束心跳 ${shortSession(record.session)}  ${record.status}`)
      printHeartbeat(record)
    }
    return record
  }

  if (sub === 'list') {
    const section = core.readHeartbeatSection(ctx.root, contract)
    if (!ctx.json) printHeartbeatList(section)
    return section
  }

  if (sub === 'status') {
    const result = core.heartbeatStatus(ctx.root, contract, sessionFlag)
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

  throw new CliError('usage', `未知子命令 heartbeat ${sub}（可用 start|update|end|list|status）`)
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

async function cmdCheck(ctx, sub) {
  const checks = await loadChecks()
  const names = checks.CHECKS.map((entry) => entry.name)
  const { flags } = ctx

  if (!sub) {
    throw new CliError('usage', `用法: flow check <list|${names.join('|')}> [options]`)
  }

  if (sub === 'list') {
    const items = checks.listChecks()
    if (!ctx.json) {
      out('机械检查（脚本相对包根路径；只读，不写 .dsh/flow）')
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
    case 'check':
      return cmdCheck(ctx, sub)
    default:
      throw new CliError('usage', `未知命令 "${command}"（可用 init|status|exp|task|gate|heartbeat|check；-h 查看帮助）`)
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
  const ctx = {
    core,
    root,
    flags: parsed.flags,
    steps: parsed.steps,
    allows: parsed.allows,
    claims: parsed.claims,
    json: jsonMode,
    contract: null,
  }

  // show/update/rm/run/logs 允许把 id 作为位置参数：flow exp show E-xxx
  const [command, action, ...extra] = parsed.positional
  if (extra.length > 1) {
    throw new CliError('usage', `多余的参数：${extra.slice(1).join(' ')}`)
  }
  if (
    ['exp', 'task', 'gate'].includes(command) &&
    ['show', 'update', 'rm', 'run', 'logs', 'enable', 'disable'].includes(action) &&
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
  if (jsonMode) emitJson({ ok: true, data })
  return 0
}

main()
  .then((code) => {
    process.exitCode = code ?? 0
  })
  .catch((error) => {
    const code = typeof error?.code === 'string' ? error.code : 'io'
    const detail = { code, message: error?.message || String(error) }
    // CheckError 自带检查上下文（check/exitCode/stdout/stderr），直接并入 error 对象。
    const payload =
      error?.payload && typeof error.payload === 'object' ? { ...error.payload, ...detail } : detail
    const mapped =
      (topCommand === 'check' ? CHECK_EXIT_BY_CODE[code] : undefined) ?? exitCodeOf(code)
    if (jsonMode) emitJson({ ok: false, error: payload })
    else if (error?.silent !== true) errOut(`错误（${payload.code}）：${payload.message}`)
    process.exitCode = mapped
  })
