// aspect 命令实现（T-20261112183138，裁定 6）：占用登记 / 租约续期 / 释放 / 清扫 / 查询。
//
// 命令面：flow aspect <list|acquire|renew|release|sweep> [--aspect X] [--session S]
//         [--file P]... [--ttl 秒] [--wait 毫秒] [--force] [--dry-run] [--json]
//
// 与 `flow heartbeat` 同一条纪律：命令只做动作，不猜语义。aspect 定义（含文件域）
// 从 docs/module-domain.json 只读解析；没有定义时 acquire 只登记 aspect 名，files 由
// --file 显式给出（可为空）。

import process from 'node:process'

import { CliError, clip, jsonMode, loadContractFor, out, readString, table } from './shared.mjs'
import {
  acquireAspectLock,
  aspectLockWaitMs,
  listAspectLocks,
  readAspectDefinitions,
  releaseAspectLock,
  renewAspectLock,
  sweepAspectLocks,
} from '../host/aspect-lock.mjs'

const ASPECT_SUBS = ['list', 'acquire', 'renew', 'release', 'sweep']

/** `--session` 或环境变量；两者都没有时给出可执行提示。 */
function sessionOf(ctx, required) {
  const flag = readString(ctx.flags, 'session')
  const session = flag !== undefined ? flag.trim() : (typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID.trim() : '')
  if (session === '' && required) {
    throw new CliError('usage', 'aspect 命令需要 --session <会话 id>（或设置 DSH_SESSION_ID）')
  }
  return session
}

/** `--ttl`（秒）/ `--wait`（毫秒）的可选整数参数。 */
function optionalIntOf(ctx, name, { min = 0, unit = '' } = {}) {
  const raw = readString(ctx.flags, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (Number.isInteger(value) === false || value < min) {
    throw new CliError('usage', '--' + name + ' 需要一个 ' + (min > 0 ? '正' : '非负') + '整数' + (unit === '' ? '' : '（单位：' + unit + '）'))
  }
  return value
}

/** aspect id：`--aspect`；缺省时 acquire/renew/release/sweep 报 usage。 */
function aspectOf(ctx, required) {
  const aspect = readString(ctx.flags, 'aspect')
  const id = aspect !== undefined ? aspect.trim() : ''
  if (id === '' && required) throw new CliError('usage', '需要 --aspect <aspect-id>（见 flow aspect list）')
  return id
}

function aspectFilesOf(ctx, aspectId) {
  const definitions = readAspectDefinitions(ctx.root)
  const declared = definitions.aspects[aspectId]
  const files = declared !== undefined && Array.isArray(declared.files) ? declared.files.slice() : []
  const explicit = readString(ctx.flags, 'file')
  if (explicit !== undefined && explicit.trim() !== '' && files.includes(explicit.trim()) === false) files.push(explicit.trim())
  return { files, definitions }
}

/** 占用/锁的一条文本行。 */
function printLockList(items, definitions) {
  if (items.length === 0) {
    out('（没有 aspect 占用）')
    return
  }
  out(
    table(
      ['aspect', '占用方', '状态', '证据', '租约到期', '文件域'],
      items.map((item) => [
        item.aspect,
        item.owner.session || '-',
        item.state + (item.releasable === true ? '（可回收）' : ''),
        item.evidence,
        item.leaseExpiresAt === null ? '-' : item.leaseExpiresAt,
        clip(item.files.join(', ') || '-', 48),
      ]),
    ),
  )
  const unknown = items.filter((item) => definitions.aspects[item.aspect] === undefined).map((item) => item.aspect)
  if (unknown.length > 0) out('提示：' + unknown.join('、') + ' 不在 docs/module-domain.json 的 aspects 里（占用仍生效，只是没有定义的文件域/语义）。')
}

export async function cmdAspect(ctx, sub) {
  const action = sub === undefined || sub === '' ? 'list' : sub
  if (ASPECT_SUBS.includes(action) === false) {
    throw new CliError('usage', '用法: flow aspect <' + ASPECT_SUBS.join('|') + '>')
  }
  const contract = loadContractFor(ctx, ctx.root)
  const definitions = readAspectDefinitions(ctx.root)

  if (action === 'list') {
    const section = listAspectLocks(ctx.root, contract)
    const aspects = Object.keys(definitions.aspects).sort().map((id) => ({
      id,
      title: definitions.aspects[id].title,
      files: definitions.aspects[id].files,
      ownerRole: definitions.aspects[id].ownerRole,
    }))
    const data = {
      aspects,
      locks: section.items,
      counts: { ...section.counts, aspects: aspects.length },
      ...(definitions.source === null ? {} : { source: definitions.source }),
    }
    if (jsonMode === true) return data
    out('aspect 定义 ' + aspects.length + ' 条' + (definitions.source === null ? '（没有 docs/module-domain.json）' : '（' + definitions.source + '）'))
    if (aspects.length > 0) {
      out(table(['aspect', '语义', '文件域'], aspects.map((item) => [item.id, clip(item.title, 24) || '-', clip(item.files.join(', '), 56)])))
      out('')
    }
    out('占用 ' + section.counts.held + ' 条（可回收 ' + section.counts.releasable + '）')
    printLockList(section.items, definitions)
    return data
  }

  const aspect = aspectOf(ctx, true)
  const session = sessionOf(ctx, true)
  const ttlSeconds = optionalIntOf(ctx, 'ttl', { min: 1, unit: '秒' })
  const waitMs = optionalIntOf(ctx, 'wait', { min: 0, unit: '毫秒' })

  if (action === 'acquire') {
    const { files } = aspectFilesOf(ctx, aspect)
    const result = await acquireAspectLock(ctx.root, contract, {
      aspect,
      files,
      session,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      ...(waitMs === undefined ? {} : { waitMs }),
    })
    if (jsonMode === true) return result
    if (result.acquired === true) {
      out('已占用 aspect ' + aspect + '（租约到期 ' + String(result.lock.leaseExpiresAt ?? '-') + '）')
    } else {
      const holder = result.holder !== null && result.holder !== undefined ? result.holder.owner : null
      out('aspect ' + aspect + ' 被会话 ' + String(holder?.session ?? '?') + ' 占用；等了 ' + String(result.waitedMs ?? 0) + 'ms 仍没拿到（裁定 6：不阻断，自行决定等/换/升级）。')
    }
    return result
  }

  if (action === 'renew') {
    const result = renewAspectLock(ctx.root, contract, {
      aspect,
      session,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    })
    if (jsonMode === true) return result
    if (result.renewed === true) out('已续租 aspect ' + aspect + '（新到期 ' + String(result.lock.leaseExpiresAt ?? '-') + '）')
    else out('没有续租：' + (result.reason === 'not-owner' ? '占用方不是你' : '锁已不存在'))
    return result
  }

  if (action === 'release') {
    const force = ctx.flags.force === true
    const result = releaseAspectLock(ctx.root, contract, { aspect, session, force })
    if (jsonMode === true) return result
    out(result.released === true ? '已释放 aspect ' + aspect : '没有可释放的锁（aspect ' + aspect + '）')
    return result
  }

  // sweep：清扫可回收（判死/租约到期）的锁；--force 无效，活着的占用方一律保留。
  const dryRun = ctx.flags['dry-run'] === true
  const result = sweepAspectLocks(ctx.root, contract, { dryRun })
  if (jsonMode === true) return result
  if (result.released.length === 0) {
    out('没有可回收的 aspect 锁（活着 ' + result.kept.length + ' 条保留）')
  } else {
    out((dryRun ? '可回收' : '已回收') + ' ' + result.released.length + ' 条 aspect 锁：' + result.released.map((item) => item.aspect + '（' + item.state + '）').join('、'))
    if (dryRun) out('（dry-run，未写盘）')
  }
  return result
}
