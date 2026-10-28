#!/usr/bin/env node
// project-flow CLI（schema 2）
//
// 唯一写入口：本文件不自己读写台账、不做校验，所有存储/校验/门禁执行都委托给
// lib/core.mjs。core 只依赖 node:fs/path/child_process，CLI 只做参数解析与输出。
//
// 退出码：0 成功 · 1 用法 · 2 校验 · 3 未找到 · 4 IO

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
  init      初始化 .dsh/flow（--name X --force --migrate trailers|tasks|all）
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
  gate rm <id> [--yes]
  gate run <id> [--timeout SECONDS]
  gate logs <id> [--limit N]

全局
  --root <dir>   项目根目录（默认当前目录）
  --json         机器可读输出：{ok:true,data} 或 {ok:false,error:{code,message}}
  -h, --help     显示本帮助

退出码
  0 成功 · 1 用法错误 · 2 校验失败 · 3 未找到 · 4 IO/环境错误
  注意：gate run 的门禁失败以 data.ok=false 表达，命令本身成功时仍退出 0。`

const EXIT = { usage: 1, invalid: 2, notFound: 3, io: 4 }
const EXIT_BY_CODE = { usage: 1, invalid: 2, 'not-found': 3, conflict: 2, io: 4 }

const BOOL_FLAGS = new Set(['json', 'force', 'yes', 'help'])
const VALUE_FLAGS = new Set([
  'root', 'name', 'migrate',
  'title', 'hypothesis', 'factor', 'parent', 'expected', 'scale', 'notes',
  'status', 'measured', 'metrics', 'commits',
  'owner', 'goal',
  'id', 'phase', 'step', 'enabled', 'timeout', 'limit',
])
const REPEAT_FLAGS = new Set(['step'])

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

  return { flags, steps: repeated.step || [], positional, errors }
}

// ---------------------------------------------------------------- 输出工具

let jsonMode = false

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
    }
    const labelWidth = Math.max(...lines.map(([label]) => textWidth(label)))
    for (const [label, value] of lines) out(`${pad(label, labelWidth)}  ${value}`)

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

  if (sub === 'rm') {
    const id = requireString(flags, 'id', '用法: flow gate rm <id> [--yes]')
    await confirmDelete(ctx, `门禁 ${id}`)
    const result = await core.removeGate(ctx.root, contract, id)
    if (!ctx.json) out(`已删除门禁 ${id}`)
    return result
  }

  if (sub === 'run') {
    const id = requireString(flags, 'id', '用法: flow gate run <id> [--timeout SECONDS]')
    const timeoutSeconds = readInteger(flags, 'timeout')
    const options = {}
    if (timeoutSeconds !== undefined) options.timeoutMs = timeoutSeconds * 1000
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

  throw new CliError('usage', `未知子命令 gate ${sub}（可用 list|show|add|update|rm|run|logs）`)
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
    default:
      throw new CliError('usage', `未知命令 "${command}"（可用 init|status|exp|task|gate；-h 查看帮助）`)
  }
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2))
  jsonMode = parsed.flags.json === true

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
    ['show', 'update', 'rm', 'run', 'logs'].includes(action)
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
    const code = error?.name === 'FlowError' || typeof error?.code === 'string' ? error.code : 'io'
    const mapped = exitCodeOf(code)
    const payload = { code: typeof code === 'string' ? code : 'io', message: error?.message || String(error) }
    if (jsonMode) emitJson({ ok: false, error: payload })
    else errOut(`错误（${payload.code}）：${payload.message}`)
    process.exitCode = mapped
  })
