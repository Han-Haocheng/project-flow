// lib/cli/health.mjs — 只读健康聚合（T-20261113153750-02）。
//
// collectHealth 把散落在各域的只读判定收进一份 findings，形状与 flow doctor 完全一致
// （{id, level, message, hint?}）：doctor 直接输出，status 取前 20 条放进 data.health。
//
// 纪律：
// - 只读：不取 store 写锁、不写盘、不跑补偿；
// - 失败隔离：单个检查抛错只产生一条 warn（unavailable），不让 doctor/status 崩；
// - profile：full = doctor（含描述深查与规则防篡改）；fast = status（廉价读，跳过深查）；
// - 判定口径不复制：claims 用 tasks/records 的 claimStateOf，锁用 aspect-lock 的
//   listAspectLocks，规则用 gates/rules 的 checkRules，基线用 backup 的 doctorReport。

import path from 'node:path'
import { accessSync, constants, statSync } from 'node:fs'

import { NEXT_TERMINAL_STAGES } from '../stage.mjs'
import { doctorReport } from '../backup.mjs'
import { api } from '../backend/api.mjs'
import { listAspectLocks } from '../host/aspect-lock.mjs'
import { checkRules } from '../gates/rules.mjs'

export const HEALTH_LEVELS = Object.freeze(['ok', 'warn', 'error'])
/** status 的 data.health.findings 上限（doctor 用 full 时也不该无限增长）。 */
export const HEALTH_FINDING_LIMIT = 20

function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (Number.isFinite(number) === false) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function errorText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function finding(id, level, message, hint) {
  const item = { id, level, message }
  if (typeof hint === 'string' && hint !== '') item.hint = hint
  return item
}

function worstLevel(findings) {
  if (findings.some((item) => item.level === 'error')) return 'error'
  if (findings.some((item) => item.level === 'warn')) return 'warn'
  return 'ok'
}

/** 终态只有一个真源：lib/stage.mjs 的 NEXT_TERMINAL_STAGES（done/archived/cancelled）。 */
const TERMINAL_STAGES = new Set(NEXT_TERMINAL_STAGES)

function isTerminalStage(stage) {
  return typeof stage === 'string' && TERMINAL_STAGES.has(stage)
}

function loadContractLoose(root) {
  try {
    const loaded = api.contract.loadContract(root)
    return loaded !== null && typeof loaded === 'object' && loaded.contract !== undefined ? loaded.contract : null
  } catch {
    return null
  }
}

/** 与 flow task list 同一口径：done 会话不算活，其余以 liveness === 'live' 为准。 */
function heartbeatProbe(root, contract) {
  if (contract === null || contract === undefined) return undefined
  return (session) => {
    try {
      const status = api.heartbeats.heartbeatStatus(root, contract, session)
      const record = status !== null && typeof status === 'object' ? status.record : null
      if (record !== null && record !== undefined && record.status === 'done') return false
      return status.liveness === 'live'
    } catch {
      return undefined
    }
  }
}

/**
 * 心跳目录可读性探测：readHeartbeatSection 对不可读/非目录的心跳目录静默返回 0 条，
 * 若只看条数会得到「0 条（ok）」的假绿；这里补一条明证（只读，不写盘）。
 * source=none 表示心跳未启用（没有目录是预期），不探测。
 */
function heartbeatDirIssue(root, section, contract) {
  const config = contract !== null && contract !== undefined && contract.heartbeats !== undefined && contract.heartbeats !== null ? contract.heartbeats : {}
  if (config.source === 'none') return null
  const dirText = section !== null && section !== undefined && typeof section.dir === 'string' ? section.dir : ''
  if (dirText === '' || dirText === '.') return null
  const workspace =
    section !== null && section !== undefined && typeof section.root === 'string' && section.root !== '' ? section.root : path.resolve(root)
  const dirPath = path.isAbsolute(dirText) ? dirText : path.resolve(workspace, dirText)
  let stats
  try {
    stats = statSync(dirPath, { throwIfNoEntry: false })
  } catch (error) {
    return '心跳目录不可访问（' + dirText + '）：' + errorText(error)
  }
  if (stats === undefined || stats === null) return '心跳目录不存在（' + dirText + '）'
  if (stats.isDirectory() !== true) return '心跳目录不是目录（' + dirText + '）'
  try {
    accessSync(dirPath, constants.R_OK | constants.X_OK)
  } catch (error) {
    return '心跳目录不可读（' + dirText + '）：' + errorText(error)
  }
  return null
}

function labelList(values, limit) {
  return values.slice(0, limit).join('、')
}

/**
 * 只读健康聚合。
 *
 * @param {string} root 项目根
 * @param {object|null} contract 已加载契约；null 时自行只读加载
 * @param {{profile?:'fast'|'full', staleHours?:number, limit?:number, maxFindings?:number}} [options]
 * @returns {Promise<{root:string, level:'ok'|'warn'|'error', ok:boolean, counts:{ok:number,warn:number,error:number}, findings:object[], truncated:boolean}>}
 */
export async function collectHealth(root, contract, options = {}) {
  const input = options !== null && typeof options === 'object' ? options : {}
  const profile = input.profile === 'full' ? 'full' : 'fast'
  const limit = clampInteger(input.limit, 3, 1, 10)
  const maxFindings = clampInteger(input.maxFindings, HEALTH_FINDING_LIMIT, 1, 200)
  const findings = []
  const add = (id, level, message, hint) => findings.push(finding(id, level, message, hint))
  const guard = async (id, run) => {
    try {
      await run()
    } catch (error) {
      add(id, 'warn', 'unavailable：' + errorText(error) + '（不代表健康）', '检查项读取失败；重跑 flow doctor 观察')
    }
  }

  const contractValue = contract === null || contract === undefined ? loadContractLoose(root) : contract

  // 1. 基线：与 flow doctor 原有的 5 条完全一致（id/level/message/hint 不改）。
  await guard('baseline', () => {
    const report = doctorReport(root, Number.isFinite(input.staleHours) ? { staleHours: input.staleHours } : {})
    for (const item of report.findings) add(item.id, item.level, item.message, item.hint)
  })

  let initialized = false
  if (contractValue !== null && contractValue !== undefined) {
    try {
      initialized = api.contract.initialized(root)
    } catch {
      initialized = false
    }
  }

  if (initialized) {
    const probe = heartbeatProbe(root, contractValue)

    // 2. 心跳：只在「有 working 会话不可用」或「不可用会话名下还有未完成任务」时告警；
    //    已结束/历史心跳不报（那是正常历史，不是健康问题）。
    await guard('heartbeats', () => {
      const section = api.heartbeats.readHeartbeatSection(root, contractValue, { visibility: 'all' })
      const issue = heartbeatDirIssue(root, section, contractValue)
      if (issue !== null) {
        add(
          'heartbeats',
          'warn',
          'unavailable：' + issue + '（不代表健康；心跳条数不可信）',
          '检查 .agents/heartbeat 的类型与权限；flow heartbeat list --all',
        )
        return
      }
      const items = Array.isArray(section.items) ? section.items : []
      const nonLive = items.filter((item) => item.liveness !== 'live')
      const working = nonLive.filter((item) => item.status === 'working')
      const unfinished = nonLive.filter(
        (item) => item.task !== null && item.task !== undefined && isTerminalStage(item.taskStage) === false,
      )
      const notable = []
      for (const item of working.concat(unfinished)) {
        if (notable.indexOf(item) === -1) notable.push(item)
      }
      if (notable.length > 0) {
        const labels = notable
          .slice(0, limit)
          .map((item) => String(item.session || item.file || '?') + '(' + String(item.liveness) + (item.status ? '/' + item.status : '') + ')')
          .join('、')
        add(
          'heartbeats',
          'warn',
          notable.length + ' 条心跳的会话不可用/不新鲜，且仍有 working 会话或未完成任务：' + labels,
          'flow heartbeat list --all；flow heartbeat status --require-active（当前项目检查）',
        )
      } else {
        add('heartbeats', 'ok', '心跳 ' + items.length + ' 条（active ' + String(section.counts && section.counts.active !== undefined ? section.counts.active : 0) + '）')
      }
    })

    // 3. 未完成动作（saga intent）：intents 是「动作没走完」的唯一线索。
    await guard('intents', () => {
      const section = api.intents.listIntents(root, contractValue, { state: 'open', limit: 10 })
      const open = section.counts && Number.isInteger(section.counts.open) ? section.counts.open : 0
      if (open === 0) {
        add('intents', 'ok', '没有未完成动作')
        return
      }
      const labels = (Array.isArray(section.items) ? section.items : [])
        .slice(0, limit)
        .map((item) => item.id + '(' + item.kind + ' 缺 ' + (Array.isArray(item.missing) && item.missing.length > 0 ? item.missing.join('/') : '-') + ')')
        .join('、')
      add(
        'intents',
        'warn',
        open + ' 条未完成动作：' + labels + (open > 10 ? '；数量偏多，考虑排查' : ''),
        '下一次 flow task 写命令会自动 recover（没有 flow task recover 命令）；先用 flow task list --json 确认受影响的卡',
      )
    })

    // 4. claim 孤儿：回执带 session 且该会话判死/判不清。
    await guard('claims', async () => {
      const tasks = await api.tasks.listTasks(root, contractValue)
      const records = await import(new URL('../tasks/records.mjs', import.meta.url).href)
      const orphan = []
      for (const task of tasks) {
        const claim = records.claimStateOf(task, { isSessionLive: probe })
        if (claim !== null && claim.orphan === true) orphan.push({ id: task.id })
      }
      if (orphan.length > 0) {
        add(
          'claims',
          'warn',
          orphan.length + ' 张卡有孤儿 claim：' + labelList(orphan.map((item) => item.id), limit),
          'flow task list --json（orphan 标记）；flow task release <id>',
        )
      } else {
        add('claims', 'ok', '没有孤儿 claim')
      }
    })

    // 5. aspect 锁：可回收（判死/foreign/租约到期）的锁应该被扫掉。
    await guard('locks', () => {
      const locks = listAspectLocks(root, contractValue, probe === undefined ? {} : { sessionLive: probe })
      const releasable = locks.items.filter((item) => item.releasable === true)
      if (releasable.length > 0) {
        add(
          'locks',
          'warn',
          releasable.length + ' 个 aspect 锁可回收：' + labelList(releasable.map((item) => item.aspect), limit),
          'flow aspect list；flow aspect sweep',
        )
      } else {
        add('locks', 'ok', 'aspect 锁 ' + locks.counts.total + ' 个（held ' + locks.counts.held + '）')
      }
    })

    // 6. 不可读记录：目录存在不代表记录可解析。
    await guard('records-unreadable', async () => {
      const unreadable = { tasks: [], experiments: [], gates: [] }
      await api.tasks.listTasks(root, contractValue, { unreadable: unreadable.tasks })
      await api.experiments.listExperiments(root, contractValue, { unreadable: unreadable.experiments })
      await api.gates.listGates(root, contractValue, { unreadable: unreadable.gates })
      const total = unreadable.tasks.length + unreadable.experiments.length + unreadable.gates.length
      if (total > 0) {
        add(
          'records-unreadable',
          'warn',
          total + ' 个记录文件无法解析（tasks ' + unreadable.tasks.length + ' / experiments ' + unreadable.experiments.length + ' / gates ' + unreadable.gates.length + '）',
          '检查 .agents 下对应 JSON；flow doctor 会继续报告',
        )
      } else {
        add('records-unreadable', 'ok', '记录文件均可解析')
      }
    })

    // 7. 阻塞决策：blocks 命中 affects 的 open 决策。
    await guard('decisions-blocking', () => {
      const summary = api.decisions.summarizeDecisions(root, contractValue, { limit })
      const blocking = summary.counts && Number.isInteger(summary.counts.blocking) ? summary.counts.blocking : 0
      if (blocking > 0) {
        add(
          'decisions-blocking',
          'warn',
          blocking + ' 个阻塞决策待答：' + labelList((Array.isArray(summary.items) ? summary.items : []).map((item) => item.id), limit),
          'flow decision list --open --all；flow decision answer <id> --choice <option>',
        )
      } else {
        add('decisions-blocking', 'ok', '没有阻塞决策（open ' + String(summary.counts && summary.counts.open !== undefined ? summary.counts.open : 0) + '）')
      }
    })

    // 8. 门禁：启用中的门禁最近一次运行失败。
    await guard('gates', async () => {
      const gates = await api.gates.listGates(root, contractValue)
      const enabled = (Array.isArray(gates) ? gates : []).filter((gate) => gate.enabled !== false)
      const failed = []
      for (const gate of enabled) {
        const runs = await api.gates.listGateRuns(root, contractValue, gate.id, 1)
        const latest = Array.isArray(runs) ? runs[0] : null
        if (latest !== null && latest !== undefined && latest.ok !== true) failed.push({ id: gate.id, at: latest.started_at })
      }
      if (failed.length > 0) {
        add(
          'gates',
          'warn',
          failed.length + ' 个启用门禁最近一次失败：' + labelList(failed.map((item) => item.id + '@' + String(item.at || '-')), limit),
          'flow gate logs <id>',
        )
      } else {
        add('gates', 'ok', '启用门禁 ' + enabled.length + ' 个，最近运行无失败')
      }
    })

    // 9. 描述台账：缺语义是常态欠账；full 时再跑严格检查（新文件/陈旧 hash）。
    await guard('description', () => {
      const counts = api.description.descriptionStatus(root, contractValue)
      if (counts.files > 0 && counts.missingSemantics > 0) {
        add(
          'description',
          'warn',
          counts.missingSemantics + ' 个描述单元缺语义（文件 ' + counts.files + '、模块 ' + counts.modules + '）',
          'flow desc status；flow check description',
        )
      } else {
        add('description', 'ok', counts.files > 0 ? '描述台账完整（文件 ' + counts.files + '）' : '未建立描述（可忽略；需要时 flow desc build）')
      }
      if (profile === 'full') {
        const result = api.checks.checkDescription(root, contractValue)
        if (result.ok !== true) {
          const failed = (Array.isArray(result.failed) ? result.failed : [])
            .slice(0, limit)
            .map((item) => (item !== null && typeof item === 'object' ? String(item.id || item.path || '?') : '?'))
          add('description-check', 'warn', '描述检查未通过：' + labelList(failed, limit), 'flow check description')
        }
      }
    })

    // 10. 规则文件防篡改（仅 full；guard-missing 视为可选未启用，不告警）。
    if (profile === 'full') {
      await guard('rule-guard', () => {
        const result = checkRules(root, contractValue)
        if (result.ok === true) add('rule-guard', 'ok', '规则文件与基线一致')
        else if (result.code === 'guard-missing') add('rule-guard', 'ok', '规则基线未建立（可选：flow gate rules init）')
        else add('rule-guard', 'warn', '规则文件检查未通过（' + String(result.code) + '）：' + String(result.hint || ''), 'flow gate rules init / flow gate rules record --reason "..."')
      })
    }
  }

  const counts = { ok: 0, warn: 0, error: 0 }
  for (const item of findings) {
    if (counts[item.level] !== undefined) counts[item.level] += 1
  }
  const level = worstLevel(findings)
  const capped = findings.slice(0, maxFindings)
  return {
    root: path.resolve(root),
    level,
    ok: level !== 'error',
    counts,
    findings: capped,
    truncated: findings.length > capped.length,
  }
}
