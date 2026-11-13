// 决策命令实现（自 bin/flow.mjs 原样搬出）
//
// `flow decision *` 与会话归属判定。

import { CliError, clip, collectWarnings, loadContractFor, out, printRecord, readPositiveInteger, readString, requireString, table } from './shared.mjs'
import { decisions, heartbeats } from '../backend/api.mjs'

/** `id=label>>impact` (same shape family as `gate add --step`). Core validates the content. */
export function parseDecisionOption(raw) {
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
export function decisionSessionInfo(ctx, contract) {
  const session = typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID.trim() : ''
  if (session === '') return { session: '', turn: null }
  try {
    const status = heartbeats.heartbeatStatus(ctx.root, contract, session)
    const record = status !== null && typeof status === 'object' ? status.record : null
    const turn = record !== null && record !== undefined && Number.isInteger(record.turn) ? record.turn : null
    return { session, turn }
  } catch {
    return { session, turn: null }
  }
}

/** 挂起 display: turns for the asking session, otherwise the age since asked_at. */
export function decisionSuspended(item) {
  const turnAge = Number.isInteger(item?.turnAge) ? item.turnAge : null
  if (turnAge !== null) return `${turnAge} 轮`
  const age = item?.ageSeconds
  if (!Number.isFinite(age)) return '-'
  if (age < 3600) return `${Math.max(1, Math.round(age / 60))} 分钟`
  if (age < 86400) return `${Math.round(age / 3600)} 小时`
  return `${Math.round(age / 86400)} 天`
}

export function printDecisionList(items, counts) {
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

export async function cmdDecision(ctx, sub) {
  const { flags } = ctx
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
    // kind 与 --option 的组合语义在这里拒绝，不静默丢弃：approval 固定
    // approve|reject、input 无选项，core 对这两种 kind 带 options 也是 invalid。
    if (kind !== 'choice' && ctx.decisionOptions.length > 0) {
      throw new CliError(
        'usage',
        `decision ask --kind ${kind} 不支持 --option：approval 固定 approve|reject，input 不接受选项；需要自定义选项请用 --kind choice`,
      )
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
    const result = await decisions.addDecision(ctx.root, contract, input)
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
    const items = await decisions.listDecisions(ctx.root, contract, { all: flags.all === true, ...info })
    const summary = decisions.summarizeDecisions(ctx.root, contract, info)
    if (!ctx.json) printDecisionList(items, summary.counts)
    return { items, counts: summary.counts }
  }

  if (sub === 'show') {
    const id = requireString(flags, 'id', '用法: flow decision show <id>')
    const record = await decisions.getDecision(ctx.root, contract, id)
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
    const veto = await import(new URL('../veto.mjs', import.meta.url).href)
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
    const record = decisions.withdrawDecision(ctx.root, contract, id, patch)
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
    const result = decisions.gcDecisions(ctx.root, contract, options)
    if (!ctx.json) {
      out(`${dryRun ? '将清理' : '已清理'}决策 ${result.removed.length} 条（保留 ${result.kept} 条）`)
      for (const id of result.removed) out(`  - ${id}`)
      if (result.removed.length === 0) out('（没有超过保留期的已关闭决策）')
    }
    return result
  }

  throw new CliError('usage', `未知子命令 decision ${sub}（可用 ask|list|show|answer|withdraw|gc）`)
}
