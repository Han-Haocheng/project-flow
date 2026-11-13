// 实验命令实现（自 bin/flow.mjs 原样搬出）
//
// `flow exp *`。

import path from 'node:path'
import { existsSync } from 'node:fs'

import { CliError, clip, confirmDelete, fmtTime, loadContractFor, out, printRecord, printTree, readJsonObject, readList, readString, requireString, table } from './shared.mjs'
import { experiments } from '../backend/api.mjs'

/** Split repeatable/comma flags into trimmed, non-empty entries. */
export function splitEntries(values) {
  return (Array.isArray(values) ? values : [])
    .flatMap((entry) => String(entry ?? '').split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Collect the schema-2 seven judging fields from CLI flags. Missing required
 * fields are named in one `invalid` error (exit 2, CONTRACT §5.1).
 */
export function experimentSeven(flags, ctx, { required }) {
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

export async function cmdExp(ctx, sub) {
  const { flags } = ctx
  if (!sub) throw new CliError('usage', '用法: flow exp <list|show|tree|add|update|rm>')
  const contract = loadContractFor(ctx, ctx.root)

  if (sub === 'list') {
    const records = await experiments.listExperiments(ctx.root, contract)
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
    const record = await experiments.getExperiment(ctx.root, contract, id)
    if (!ctx.json) printRecord(record)
    return record
  }

  if (sub === 'tree') {
    const records = await experiments.listExperiments(ctx.root, contract)
    const tree = experiments.experimentTree(records)
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
    const record = await experiments.addExperiment(ctx.root, contract, input)
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
    const record = await experiments.updateExperiment(ctx.root, contract, id, patch)
    if (!ctx.json) out(`已更新实验 ${record.id}  ${record.status || '-'}  ${record.title}`)
    return record
  }

  if (sub === 'review') {
    const id = requireString(flags, 'id', '用法: flow exp review <id>')
    const record = await experiments.getExperiment(ctx.root, contract, id)
    const records = await experiments.listExperiments(ctx.root, contract)
    const hasSuccessor = (experimentId) =>
      records.some((item) => item.id !== experimentId && item.parent === experimentId)
    const review = experiments.reviewExperimentRecord(record, { hasSuccessor })
    if (!ctx.json) {
      out(`${review.id}  verdict ${review.verdict} · branch ${review.branch}`)
      out(review.missing.length === 0 ? '  missing: （无）' : `  missing: ${review.missing.join(', ')}`)
    }
    return review
  }

  if (sub === 'productize') {
    const id = requireString(flags, 'id', '用法: flow exp productize <id> [--gate release]')
    const gateId = readString(flags, 'gate')
    const result = await experiments.productizeExperiment(ctx.root, contract, id, gateId === undefined ? {} : { gateId })
    if (!ctx.json) {
      if (result.already) out(`已产品化（already）：${result.id} @ ${result.productizedAt}`)
      else out(`已产品化 ${result.id}（gate ${result.productizeGate?.id ?? 'release'} @ ${result.productizeGate?.runAt ?? '-'}）`)
    }
    return result
  }

  if (sub === 'cleanup') {
    const id = requireString(flags, 'id', '用法: flow exp cleanup <id> [--flag F]... [--code C]... [--data D]...')
    const result = await experiments.cleanupExperiment(ctx.root, contract, id, {
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
    const result = await experiments.removeExperiment(ctx.root, contract, id)
    if (!ctx.json) out(`已删除实验 ${id}`)
    return result
  }

  throw new CliError('usage', `未知子命令 exp ${sub}（可用 list|show|tree|add|update|review|productize|cleanup|rm）`)
}
