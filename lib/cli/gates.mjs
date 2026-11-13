// 门禁命令实现（自 bin/flow.mjs 原样搬出）
//
// `flow gate *` 与门禁展示助手。

import { CliError, clip, confirmDelete, fmtDuration, fmtTime, loadContractFor, out, pad, parseStep, readInteger, readString, requireString, table, textWidth } from './shared.mjs'
import { checkRules, initRules, recordRuleChange } from '../gates/rules.mjs'
import { gates as gateApi } from '../backend/api.mjs'

/** add/update 的分类字段（只有显式给出才进 patch，缺省不覆盖已有值）。 */
function gateClassFromFlags(flags) {
  const fields = {}
  const kind = readString(flags, 'kind')
  if (kind !== undefined) fields.kind = kind
  const level = readString(flags, 'mount-level')
  const target = readString(flags, 'mount-target')
  if (level !== undefined || target !== undefined) {
    fields.mount = {}
    if (level !== undefined) fields.mount.level = level
    if (target !== undefined) fields.mount.target = target
  }
  if (flags['fail-fast'] === true) fields.failFast = true
  return fields
}

export async function cmdGate(ctx, sub) {
  const { flags } = ctx
  if (!sub) throw new CliError('usage', '用法: flow gate <list|show|add|update|rm|run|logs|rules>')
  const contract = loadContractFor(ctx, ctx.root)

  // 规则文件防篡改（裁定 1）：默认 check；--init 建基线，--record 留痕并推进基线。
  if (sub === 'rules') {
    if (flags.init === true && flags.record === true) {
      throw new CliError('usage', '--init 与 --record 不能同时使用')
    }
    if (flags.init === true) {
      const result = initRules(ctx.root, contract, {
        reason: readString(flags, 'reason'),
        by: readString(flags, 'by'),
      })
      if (!ctx.json) {
        out(`已建立规则文件校验和基线：${result.files.length} 个监视对象（${result.files.join('、')}）`)
        out(`基线时间 ${result.baselineAt}`)
      }
      return result
    }
    if (flags.record === true) {
      const result = recordRuleChange(ctx.root, contract, {
        reason: readString(flags, 'reason'),
        by: readString(flags, 'by'),
      })
      if (!ctx.json) {
        if (result.changed !== true) out('规则文件没有变化，未写入留痕记录')
        else {
          out(`已留痕并推进规则基线：${result.entry.changes.length} 处改动`)
          for (const change of result.entry.changes) {
            out(`  ${change.section === undefined ? change.path : `${change.path}#${change.section}`}  ${String(change.from ?? '无').slice(0, 12)} → ${String(change.to ?? '无').slice(0, 12)}`)
          }
          out(`理由 ${result.entry.reason}  记录 ${result.guardPath}`)
        }
      }
      return result
    }
    const result = checkRules(ctx.root, contract)
    if (!ctx.json) {
      if (result.ok === true) {
        out(`✓ rules：规则文件校验和与基线一致（基线 ${result.baselineAt}）`)
        for (const entry of result.watched ?? []) out(`  · ${entry.label}  ${entry.path}`)
      } else if (result.code === 'unrecorded-change') {
        for (const diff of result.changed ?? []) {
          out(`✗ ${diff.section === undefined ? diff.path : `${diff.path}#${diff.section}`}  ${String(diff.from ?? '无').slice(0, 12)} → ${String(diff.to ?? '无').slice(0, 12)}`)
        }
        out(`结构问题：${result.changed?.length ?? 0} 处规则文件改动没有留痕`)
        out(`修复：${result.hint}`)
      } else {
        out(`✗ rules（${result.code}）：${result.hint}`)
        for (const issue of result.issues ?? []) out(`  · ${issue.kind} ${issue.path} — ${issue.detail}`)
      }
    }
    if (result.ok !== true) {
      const error = new CliError('check-failed', `规则文件防篡改检查未通过：${result.code}`)
      error.silent = ctx.json !== true
      // 入口会把 error.code 统一成 check-failed；规则检查的具体原因放在 guardCode。
      error.payload = { check: 'rules', exitCode: 1, guardCode: result.code, ...result }
      throw error
    }
    return result
  }

  if (sub === 'list') {
    const gates = await gateApi.listGates(ctx.root, contract)
    const items = []
    for (const gate of gates) {
      let lastRun = null
      try {
        const runs = await gateApi.listGateRuns(ctx.root, contract, gate.id, 1)
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
            ['ID', 'phase', '分类', '启用', '步骤', '最近运行', '标题'],
            items.map((gate) => [
              gate.id,
              gate.phase || '-',
              describeGateKind(gate),
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
    const gate = await gateApi.getGate(ctx.root, contract, id)
    if (!ctx.json) printGate(gate)
    return gate
  }

  if (sub === 'add') {
    const id = requireString(flags, 'id', '用法: flow gate add --id SLUG --title T --phase commit|release|manual')
    const title = requireString(flags, 'title', 'gate add 需要 --title')
    const phase = requireString(flags, 'phase', 'gate add 需要 --phase commit|release|manual')
    const input = { id, title, phase, ...gateClassFromFlags(flags) }
    if (ctx.steps.length > 0) input.steps = ctx.steps.map(parseStep)
    const gate = await gateApi.addGate(ctx.root, contract, input, {
      allowUnknownExpect: flags['allow-unknown-expect'] === true,
    })
    if (!ctx.json) out(`已创建门禁 ${gate.id}  ${gate.phase}  ${describeGateKind(gate)}  ${gate.title}`)
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
    Object.assign(patch, gateClassFromFlags(flags))
    if (Object.keys(patch).length === 0) {
      throw new CliError('usage', 'gate update 至少需要一个字段参数（如 --enabled false）')
    }
    const gate = await gateApi.updateGate(ctx.root, contract, id, patch, {
      allowUnknownExpect: flags['allow-unknown-expect'] === true,
    })
    if (!ctx.json) out(`已更新门禁 ${gate.id}  ${gate.enabled === false ? '已禁用' : '启用'}  ${describeGateKind(gate)}  ${gate.title}`)
    return gate
  }

  if (sub === 'enable' || sub === 'disable') {
    const id = requireString(flags, 'id', `用法: flow gate ${sub} <id>`)
    const gate = await gateApi.updateGate(ctx.root, contract, id, { enabled: sub === 'enable' })
    if (!ctx.json) out(`已${sub === 'enable' ? '启用' : '禁用'}门禁 ${gate.id}  ${gate.title}`)
    return gate
  }

  if (sub === 'rm') {
    const id = requireString(flags, 'id', '用法: flow gate rm <id> [--yes]')
    await confirmDelete(ctx, `门禁 ${id}`)
    const result = await gateApi.removeGate(ctx.root, contract, id)
    if (!ctx.json) out(`已删除门禁 ${id}`)
    return result
  }

  if (sub === 'run') {
    const phase = readString(flags, 'phase')
    const timeoutSeconds = readInteger(flags, 'timeout')
    const options = { force: flags.force === true }
    if (timeoutSeconds !== undefined) options.timeoutMs = timeoutSeconds * 1000
    // 运行期覆盖：默认跟随门禁定义的 failFast（默认 false = 分段执行）。
    if (flags['fail-fast'] === true) options.failFast = true
    if (phase !== undefined) {
      if (flags.id !== undefined) throw new CliError('usage', 'gate run 的 --phase 与 <id> 不能同时使用')
      const summary = await gateApi.runGatesByPhase(ctx.root, contract, phase, options)
      if (!ctx.json) printGatePhaseRun(summary)
      return summary
    }
    const id = requireString(
      flags,
      'id',
      '用法: flow gate run <id>|--phase commit|release|manual [--timeout SECONDS] [--force]',
    )
    const run = await gateApi.runGate(ctx.root, contract, id, options)
    if (!ctx.json) printRun(run)
    return run
  }

  if (sub === 'logs') {
    const id = requireString(flags, 'id', '用法: flow gate logs <id> [--limit N]')
    const limit = readInteger(flags, 'limit')
    const runs = await gateApi.listGateRuns(ctx.root, contract, id, limit === undefined ? 5 : limit)
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

/** 门禁分类的一行人读标签：结构（挂哪层）/ 行为（功能层）。 */
export function describeGateKind(gate) {
  const kind = gate?.kind === 'structure' ? 'structure' : 'behavior'
  const level = gate?.mount?.level ?? 'feature'
  const target = gate?.mount?.target === undefined ? '' : `:${gate.mount.target}`
  return `${kind === 'structure' ? '结构' : '行为'}(${level}${target})`
}

export function printGate(gate) {
  const keys = ['id', 'title', 'phase', 'enabled', 'kind', 'mount', 'failFast', 'created_at', 'updated_at']
  const labelWidth = Math.max(...keys.map((key) => textWidth(key)))
  for (const key of keys) {
    let value = gate[key]
    if (value === undefined || value === null) continue
    if (key === 'enabled') value = value === false ? 'false（已禁用）' : 'true'
    if (key === 'kind') value = `${value}（${value === 'structure' ? '结构门禁' : '行为门禁'}）`
    if (key === 'mount') value = `${value.level}${value.target === undefined ? '' : ` → ${value.target}`}`
    if (key === 'failFast') value = value === true ? 'true（首败即停）' : 'false（分段执行：失败后继续跑）'
    out(`${pad(`${key}:`, labelWidth + 1)}  ${value}`)
  }
  const steps = Array.isArray(gate.steps) ? gate.steps : []
  out('')
  out(`steps（${steps.length}）`)
  for (const step of steps) {
    const kind = step.kind === 'structure' ? '结构' : '行为'
    out(`  ${step.id}  [${kind}]  ${step.expect || 'exit 0'}`)
    out(`    run: ${step.run}`)
    if (step.timeoutSeconds !== undefined) out(`    timeout: ${step.timeoutSeconds}s`)
  }
}

export function printRun(run) {
  out(`运行门禁 ${run.gate}${run.title ? `（${run.title}）` : ''}  ${run.kind === 'structure' ? '结构门禁' : '行为门禁'}`)
  const steps = Array.isArray(run.steps) ? run.steps : []
  for (const step of steps) {
    const kind = step.kind === 'structure' ? '结构' : '行为'
    out(`  ${step.ok ? '✓' : '✗'} [${kind}] ${step.id}  ${step.expect || ''} → exit ${step.exit ?? '?'}  ${fmtDuration(step.durationMs)}`)
    if (!step.ok && step.tail) {
      for (const line of String(step.tail).split('\n').slice(-20)) out(`      ${line}`)
    }
  }
  const passed = steps.filter((step) => step.ok).length
  out(`结果  ${run.ok ? '通过' : '失败'}  ${passed}/${steps.length} 步  ${fmtDuration(run.durationMs)}`)
  for (const kind of ['structure', 'behavior']) {
    const segment = run.segments?.[kind]
    if (segment === undefined || segment.total === 0) continue
    out(
      `  ${kind === 'structure' ? '结构' : '行为'}：${segment.passed}/${segment.total} 步` +
        (segment.ok === true ? '' : `  （${kind === 'structure' ? '结构问题' : '行为问题'}）`),
    )
  }
  const failFast = run.failFast === true ? 'true（首败即停）' : 'false（分段执行）'
  out(`failFast  ${failFast}`)
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
  // 分类呈现：结构问题先报（定义/归属/契约），行为问题后报（功能没做出来）。
  for (const kind of ['structure', 'behavior']) {
    const group = runs.filter((run) => (run.kind === 'structure' ? 'structure' : 'behavior') === kind)
    if (group.length === 0) continue
    const groupFailed = group.filter((run) => run.ok !== true).length
    const label = kind === 'structure' ? '结构门禁' : '行为门禁'
    const failLabel = kind === 'structure' ? '结构问题' : '行为问题'
    out(`${label}：${group.length} 条 · 通过 ${group.length - groupFailed} · 失败 ${groupFailed}${groupFailed === 0 ? '' : `（${failLabel}）`}`)
    for (const run of group) {
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
  }
  for (const item of skipped) out(`  ↷ ${item.id} 跳过（${item.reason}）`)
  if (failed.length > 0) {
    // 兼容既有输出的汇总行（测试与人类脚本都按它读），分类行紧随其后。
    out(`失败 ${failed.length} 条：${failed.map((run) => run.gate).join(', ')}`)
    const structure = failed.filter((run) => run.kind === 'structure').map((run) => run.gate)
    const behavior = failed.filter((run) => run.kind !== 'structure').map((run) => run.gate)
    if (structure.length > 0) out(`结构问题 ${structure.length} 条：${structure.join(', ')}`)
    if (behavior.length > 0) out(`行为问题 ${behavior.length} 条：${behavior.join(', ')}`)
  }
  if (failed.length === 0 && skipped.length === 0) out('全部通过')
}
