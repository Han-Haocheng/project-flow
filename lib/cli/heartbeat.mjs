// 心跳命令实现（自 bin/flow.mjs 原样搬出）
//
// 主会话判定、心跳根、status 块与 `flow heartbeat *` 的输出。

import path from 'node:path'
import os from 'node:os'
import * as zlib from 'node:zlib'
import { readFileSync, readdirSync } from 'node:fs'

import { CliError, clip, collectWarnings, fmtTime, loadContractFor, out, pad, readPositiveInteger, readString, table, textWidth } from './shared.mjs'

/**
 * One decompressed session log header, or `undefined`. Session logs live under
 * `<DSH_HOME>/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl[.zstd]`;
 * the header's `origin`/`delegationDepth` are the durable record of whether a
 * session is a delegated child. Best effort only: an unreadable status is
 * "unknown" and is treated like a main session (never a silent refusal).
 */
export function readSessionHeader(session) {
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
export function zstdText(buffer) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('zlib.zstdDecompressSync is unavailable')
  return zlib.zstdDecompressSync(buffer).toString('utf8')
}

/** `subagent` / `main` for a known session header; `undefined` when unknown. */
export function sessionOriginOf(session) {
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
export function assertMainSessionHeartbeat(command) {
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
export function heartbeatWorkspaceOf(core, root) {
  if (typeof core.resolveHeartbeatWorkspace === 'function') {
    const resolved = core.resolveHeartbeatWorkspace(root)
    if (resolved !== null && typeof resolved === 'object' && typeof resolved.root === 'string' && resolved.root !== '') {
      return { root: resolved.root, degraded: resolved.degraded === true, reason: resolved.reason || '' }
    }
  }
  return { root, degraded: false, reason: '' }
}

/** Relative age for heartbeat rows ("刚刚", "3 小时前", …). */
export function fmtAge(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return '-'
  const total = Math.max(0, value)
  if (total < 60) return '刚刚'
  if (total < 3600) return `${Math.round(total / 60)} 分钟前`
  if (total < 86400) return `${Math.round(total / 3600)} 小时前`
  return `${Math.round(total / 86400)} 天前`
}

/** Short session label for tables (drops a `session-` prefix, keeps 8 chars). */
export function shortSession(value) {
  const text = String(value ?? '').trim().replace(/^session-/, '')
  if (text === '') return '-'
  return text.length <= 10 ? text : text.slice(0, 8)
}

export function fmtClaims(claims) {
  if (!Array.isArray(claims) || claims.length === 0) return '-'
  return claims.join(', ')
}

/** Human-readable heartbeat summary (start/update/end/status all reuse it). */
export function printHeartbeat(record) {
  const updatedAt = typeof record.updated_at === 'string' ? Date.parse(record.updated_at) : Number.NaN
  const age = Number.isFinite(updatedAt) ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000)) : null
  const rows = [
    ['session', shortSession(record.session)],
    ['title', record.title || '-'],
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

/** Display cap for `heartbeat update` — the stack itself is already ordered by capture.mjs. */
export const HEARTBEAT_STACK_ROWS = 5

/**
 * The §9 block for a heartbeat write. A block failure must never fail the
 * heartbeat itself (the write already landed): return null and warn.
 */
export async function heartbeatStatusBlock(ctx, root, contract, stackRows) {
  try {
    return await statusBlockOf(ctx, root, contract, stackRows)
  } catch (error) {
    collectWarnings([`status-block-unavailable: ${error?.message ?? String(error)}`])
    return null
  }
}

export async function loadCapture() {
  return import(new URL('../capture.mjs', import.meta.url).href)
}

/**
 * The §9 status block for `root`. `stackRows` only truncates the **display** of the
 * already-sorted stack; `unfinished` keeps the true count.
 */
export async function statusBlockOf(ctx, root, contract, stackRows = null) {
  const capture = await loadCapture()
  const block = capture.buildStatusBlock(ctx.core, root, contract)
  if (stackRows === null || block.stack.length <= stackRows) return block
  return { ...block, stack: block.stack.slice(0, stackRows) }
}

/** Human rendering of the block. Callers must guard with `!ctx.json` (out() always writes). */
export function printStatusBlock(block, options = {}) {
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

export function printHeartbeatList(section, showAll = false) {
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
      ['session', 'title', 'agent', 'status', '存活', '年龄', 'task', 'claims', 'goal'],
      items.map((item) => [
        shortSession(item.session),
        clip(item.title || '-', 24),
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

export async function cmdHeartbeat(ctx, sub) {
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
      if (status !== 'working' && status !== 'idle' && status !== 'waiting') {
        throw new CliError('usage', '--status 只接受 working | idle | waiting')
      }
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

  if (sub === 'rm') {
    if (typeof core.removeHeartbeat !== 'function') {
      throw new CliError('io', 'heartbeat rm 需要更新的 lib/core.mjs（缺少 removeHeartbeat）')
    }
    const target = typeof flags.id === 'string' && flags.id !== '' ? flags.id : sessionFlag
    if (target === undefined || target === '') throw new CliError('usage', '用法: flow heartbeat rm <session>')
    const result = core.removeHeartbeat(root, contract, target)
    if (!ctx.json) {
      out(
        result.removed
          ? `已移除心跳 ${shortSession(result.session)}`
          : `没有心跳记录可移除（${shortSession(result.session)}）`,
      )
    }
    return result
  }

  if (sub === 'gc') {
    if (typeof core.gcLegacyHeartbeats !== 'function') {
      throw new CliError('io', 'heartbeat gc 需要更新的 lib/core.mjs（缺少 gcLegacyHeartbeats）')
    }
    const dryRun = flags['dry-run'] === true
    const hours = readPositiveInteger(
      flags,
      'older-than-hours',
      '--older-than-hours 需要正整数小时（例如 --older-than-hours 24）',
    )
    const result = core.gcLegacyHeartbeats(root, contract, {
      dryRun,
      ...(hours === undefined ? {} : { olderThanHours: hours }),
    })
    if (!ctx.json) {
      const removed = Array.isArray(result.removed) ? result.removed : []
      const legacyCount = removed.filter((item) => item.reason === 'subagent').length
      const deadCount = removed.filter((item) => item.reason === 'dead').length
      const endedCount = removed.filter((item) => item.reason === 'ended').length
      out(
        `${dryRun ? '将清理' : '已清理'}旧心跳 ${removed.length} 条（子会话 ${legacyCount} · 判死 ${deadCount} · 已结束 ${endedCount}；保留 ${result.kept} 条）  目录 ${result.dir}`,
      )
      for (const item of removed) {
        const label = item.reason === 'subagent' ? 'subagent' : item.reason === 'dead' ? '判死' : '已结束'
        out(`  - ${item.file}  ${item.status || '-'}  ${label}`)
      }
      if (removed.length === 0) out('（没有可清理的旧心跳）')
      if (hours === undefined) out('提示：加 --older-than-hours N 可同时回收「已结束超过 N 小时」的记录')
    }
    return result
  }

  throw new CliError('usage', `未知子命令 heartbeat ${sub}（可用 start|update|end|list|status|rm|gc）`)
}
