// 门禁命令实现（自 bin/flow.mjs 原样搬出）
//
// `flow gate *` 与门禁展示助手。

import { CliError, clip, confirmDelete, fmtDuration, fmtTime, loadContractFor, out, pad, parseStep, readInteger, readString, requireString, table, textWidth } from './shared.mjs'

export async function cmdGate(ctx, sub) {
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
    const gate = await core.addGate(ctx.root, contract, input, {
      allowUnknownExpect: flags['allow-unknown-expect'] === true,
    })
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
    const gate = await core.updateGate(ctx.root, contract, id, patch, {
      allowUnknownExpect: flags['allow-unknown-expect'] === true,
    })
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

export function printGate(gate) {
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

export function printRun(run) {
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
export function printGatePhaseRun(summary) {
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
