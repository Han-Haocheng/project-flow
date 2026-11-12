// 任务命令实现（自 bin/flow.mjs 原样搬出）
//
// `flow task *`、next/verify、archive/sweep/normalize 与任务格式门禁助手。

import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

import { CliError, clip, collectWarnings, confirmDelete, coreRef, drainCoreWarnings, fmtDuration, fmtTime, loadContractFor, out, printRecord, readPositiveInteger, readString, requireString, table, textWidth } from './shared.mjs'
import { recoverIntents } from '../tasks/intents.mjs'

/** 文本模式的归档结果（core 返回 {archived, candidates, days, cutoff, dryRun, locked}）。 */
export function printArchiveResult(result, days, dryRun) {
  const ids = result !== null && typeof result === 'object' && Array.isArray(result.archived) ? result.archived : []
  const candidates = result !== null && typeof result === 'object' && Number.isInteger(result.candidates) ? result.candidates : ids.length
  const cutoff =
    result !== null && typeof result === 'object' && (typeof result.cutoff === 'string' || typeof result.cutoff === 'number')
      ? String(result.cutoff)
      : ''
  const suffix = cutoff === '' ? '' : `，早于 ${cutoff}`
  if (result !== null && typeof result === 'object' && result.locked === true) {
    out('归档被写锁占用，本次跳过（下次运行会重试）')
    return
  }
  if (dryRun === true) {
    out(
      `检测到 ${candidates} 个到期任务（阈值 ${days} 天${suffix}）` +
        `${ids.length > 0 ? `：${ids.join(', ')}` : ''}（dry-run，未写盘）`,
    )
    return
  }
  if (ids.length === 0) out(`没有需要归档的任务（阈值 ${days} 天${suffix}）`)
  else out(`已归档 ${ids.length} 个任务（阈值 ${days} 天${suffix}）：${ids.join(', ')}`)
}

/** 任务列表标题列宽（显示宽度，宽字符按 2 算；与改动前一致）。 */
const TASK_LIST_TITLE_WIDTH = 56
/** 捕获噪声标记（M5）：只在文本列表出现，`--json` 不动。 */
const CAPTURE_MARK = ' [capture]'

/**
 * 任务列表的标题列（T-20261112151422 / M5）。
 *
 * `source.kind === 'utterance'` 且**未到终态**的卡在列尾加 `[capture]`：这正是需要
 * 人工清理的「捕获噪声卡」；已 done/archived 的旧捕获卡不标（标记的目的是待办可见，
 * 不是给历史记账加噪）。标记的宽度先让出来再裁剪标题，保证整列不超过
 * {@link TASK_LIST_TITLE_WIDTH} 个显示宽度（中文标题也成立）。
 */
export function listTitle(record, terminalStages = []) {
  const terminal = terminalStages instanceof Set ? terminalStages : new Set(terminalStages)
  const capture = record?.source?.kind === 'utterance' && terminal.has(record.stage) === false
  if (capture === false) return clip(record?.title, TASK_LIST_TITLE_WIDTH)
  return `${clip(record?.title, TASK_LIST_TITLE_WIDTH - textWidth(CAPTURE_MARK))}${CAPTURE_MARK}`
}

/**
 * `--parent <T-id>`：`''`/`none`/`null` 表示清空（根）。其余原样交给 core 校验
 * （宽引用/父须存在/禁自指/禁环 → invalid/退出码 2）。
 */
export function readParentFlag(flags, core) {
  const raw = readString(flags, 'parent')
  if (raw === undefined) return undefined
  // 归一规则与 `flow_task` 共用 core.normalizeParentInput（''/none/null → 根）。
  return core.normalizeParentInput(raw)
}

/** 会写台账的子命令：跑一次 intent 恢复扫描（多步写崩溃后的补偿入口）。 */
const TASK_WRITE_SUBS = new Set(['add', 'update', 'archive', 'sweep', 'normalize', 'link', 'unlink', 'rm'])

export async function cmdTask(ctx, sub) {
  const { core, flags } = ctx
  if (!sub) {
    throw new CliError(
      'usage',
      '用法: flow task <list|show|next|verify|add|update|archive|sweep|normalize|link|unlink|rm>',
    )
  }
  const contract = loadContractFor(ctx, ctx.root)

  /* T-20261112183138-02：命令入口恢复扫描。只写一次（幂等），失败只记 warning——
     补偿扫描不该挡住用户本来要做的命令。 */
  if (TASK_WRITE_SUBS.has(sub)) {
    try {
      const recovered = recoverIntents(ctx.root, contract)
      if (ctx.json !== true && recovered.items.length > 0) {
        const settled = recovered.items.filter((item) => item.action !== 'skipped').length
        out(`intent 恢复：扫描 ${recovered.scanned} 条，处理 ${settled} 条`)
      }
    } catch (error) {
      collectWarnings([`intent-recovery-skipped: ${error?.message ?? String(error)}`])
    }
  }

  if (sub === 'list') {
    const records = await core.listTasks(ctx.root, contract)
    if (!ctx.json) {
      if (records.length === 0) out('（没有任务记录）')
      else {
        /* 捕获噪声标记（T-20261112151422 / M5）：`source.kind === 'utterance'` 且
           还没到终态的行，在标题列尾加 `[capture]`，让「待人工清理的捕获卡」一眼可见。
           终态集合取自阶段机的单一真源（懒加载，与 `flow task next` 同一入口）。
           文本模式专用：`--json` 不改形状（`source` 本来就在记录里）。 */
        const utterance = records.some((record) => record?.source?.kind === 'utterance')
        const terminal = utterance === false ? new Set() : new Set((await loadStageModel()).NEXT_TERMINAL_STAGES)
        out(
          table(
            ['ID', '状态', 'owner', '更新', '标题'],
            records.map((record) => [
              record.id,
              record.status || '-',
              clip(record.owner || '-', 16),
              fmtTime(record.updated_at),
              listTitle(record, terminal),
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
    for (const key of ['title', 'type', 'status', 'stage', 'owner', 'notes']) {
      const value = readString(flags, key)
      if (value !== undefined) input[key] = value
    }
    const experiment = readString(flags, 'experiment')
    if (experiment !== undefined) input.experiment = experiment.trim() === '' ? null : experiment
    const explicitId = readString(flags, 'id')
    if (explicitId !== undefined && explicitId.trim() !== '') input.id = explicitId.trim()
    const parent = readParentFlag(flags, core)
    if (parent !== undefined) input.parent = parent
    if (!input.title) throw new CliError('usage', '用法: flow task add --title T [...]')
    const record = await core.addTask(ctx.root, contract, input)
    if (!ctx.json) out(`已创建任务 ${record.id}  ${record.title}`)
    return record
  }

  if (sub === 'update') {
    const id = requireString(flags, 'id', '用法: flow task update <id> [...]')
    const patch = {}
    for (const key of ['title', 'type', 'status', 'stage', 'owner', 'notes']) {
      const value = readString(flags, key)
      if (value !== undefined) patch[key] = value
    }
    const experiment = readString(flags, 'experiment')
    if (experiment !== undefined) patch.experiment = experiment.trim() === '' ? null : experiment
    const parent = readParentFlag(flags, core)
    if (parent !== undefined) patch.parent = parent
    if (Object.keys(patch).length === 0) {
      throw new CliError('usage', 'task update 至少需要一个字段参数（如 --status）')
    }
    if (Object.hasOwn(patch, 'owner')) patch.owner = core.normalizeOwnerInput(patch.owner)
    /* Session ownership (D-20261108-05 = extend-owner): the CLI is an operator
       entry, so it does not impersonate a session; but it must not let anyone
       rewrite a task held by a **live** session. Liveness comes from the
       heartbeat ledger (pid/boot evidence), the same rule the panel uses. */
    const ownerOptions = {}
    if (Object.hasOwn(patch, 'owner')) {
      ownerOptions.isSessionLive = (session) => {
        try {
          const status = core.heartbeatStatus(ctx.root, contract, session)
          // A closed heartbeat (`endHeartbeat` → status done) is not an active
          // session even while its pid is still the host process.
          if (status.record !== null && status.record !== undefined && status.record.status === 'done') return false
          return status.liveness === 'live'
        } catch {
          return undefined
        }
      }
    }
    const record = await core.updateTask(ctx.root, contract, id, patch, ownerOptions)
    if (!ctx.json) out(`已更新任务 ${record.id}  ${record.status || '-'}  ${record.title}`)
    return record
  }

  if (sub === 'archive') {
    const olderThan = readPositiveInteger(flags, 'older-than', '--older-than 需要正整数天数（例如 --older-than 30）')
    const dryRun = flags['dry-run'] === true
    // 与 task add 同一条判定（core 的 STORE_CONTRACT 是固定的 .agents/flow/flow.json）：
    // 未初始化按用法错误退出 1，由命令自己给出可操作的下一步。
    if (existsSync(path.join(ctx.root, '.agents', 'flow', 'flow.json')) === false) {
      throw new CliError('usage', '未初始化（未找到 .agents/flow/flow.json）；先运行 flow init')
    }
    // 0=关闭与越界 clamp/warning 都由 core.archiveTasks 统一判定（含 --older-than 覆盖）；
    // CLI 只负责人类输出与 `closed` 标记，不重复一套窗口逻辑。
    const reported = await core.archiveTasks(ctx.root, contract, {
      ...(olderThan === undefined ? {} : { days: olderThan }),
      dryRun,
    })
    const result =
      reported !== null && typeof reported === 'object' && reported.days === 0 ? { ...reported, closed: true } : reported
    if (!ctx.json) {
      if (result !== null && typeof result === 'object' && result.days === 0) {
        out('任务归档已关闭（tasks.archiveAfterDays=0）；用 --older-than N 显式指定天数')
      } else {
        printArchiveResult(result, result?.days, dryRun)
      }
    }
    return result
  }

  if (sub === 'sweep') {
    const hours = readPositiveInteger(
      flags,
      'older-than-hours',
      '--older-than-hours 需要正整数小时（例如 --older-than-hours 24）',
    )
    const dryRun = flags['dry-run'] === true
    if (existsSync(path.join(ctx.root, '.agents', 'flow', 'flow.json')) === false) {
      throw new CliError('usage', '未初始化（未找到 .agents/flow/flow.json）；先运行 flow init')
    }
    const result = await core.sweepUtteranceTasks(ctx.root, contract, {
      ...(hours === undefined ? {} : { olderThanHours: hours }),
      dryRun,
    })
    if (!ctx.json) {
      const closed = Array.isArray(result.closed) ? result.closed : []
      if (closed.length === 0) {
        out(`没有需要归档的捕获噪声卡（阈值 ${result.olderThanHours} 小时）`)
      } else {
        /* 结果语义是 archived（M4，Lead 裁决），文案跟着说「归档」；字段名 closed 保留
           给既有调用方/测试，避免额外的契约变更。 */
        out(`${dryRun ? '将归档' : '已归档'} ${closed.length} 张捕获噪声卡（阈值 ${result.olderThanHours} 小时）：`)
        for (const row of closed) out(`  ${row.id}  ${row.ageHours}h  ${clip(row.title, 56)}`)
        if (dryRun) out('（--dry-run：没有写盘）')
      }
    }
    return result
  }

  if (sub === 'normalize') {
    // 写盘通道与只读门禁（check tasks）分开：--dry-run 只报告，真跑在 core 写锁内迁移。
    return runTaskNormalize(ctx)
  }

  if (sub === 'link') {
    const teamSync = await loadTeamSync()
    const id = requireString(flags, 'id', '用法: flow task link <TASK-ID> --team <BOARD-ID>')
    const boardId = requireString(flags, 'team', '用法: flow task link <TASK-ID> --team <BOARD-ID>')
    const record = teamSync.linkTask(ctx.root, contract, id, boardId)
    if (!ctx.json) out(`已挂载 ${record.id} → ${record.team?.taskId ?? boardId}`)
    return record
  }

  if (sub === 'unlink') {
    const teamSync = await loadTeamSync()
    const id = requireString(flags, 'id', '用法: flow task unlink <TASK-ID>')
    const record = teamSync.unlinkTask(ctx.root, contract, id)
    if (!ctx.json) out(`已解除 ${record.id} 的团队板挂载`)
    return record
  }

  if (sub === 'next') {
    const id = requireString(flags, 'id', '用法: flow task next <id>')
    const stage = await loadStageModel()
    const taskModel = await loadTaskModel()
    const record = await core.getTask(ctx.root, contract, id)
    const current = typeof record.stage === 'string' && record.stage !== '' ? record.stage : stage.DEFAULT_STAGE
    const verification = taskModel.verificationStateOf(record)
    const acceptance = {
      executable: verification.executable,
      cmd: verification.cmd,
      gate: verification.gate,
      passed: verification.passed,
      verified: verification.ok === true,
      fresh: verification.fresh,
      at: verification.at,
      verifyCommand: verification.executable > 0 ? `flow task verify ${record.id}` : null,
    }
    const base = {
      id: record.id,
      title: typeof record.title === 'string' ? record.title : '',
      stage: current,
      stageZh: stage.STAGE_ZH[current] ?? current,
      owner: typeof record.owner === 'string' ? record.owner : '',
      terminal: stage.NEXT_TERMINAL_STAGES.includes(current),
    }
    // 终态：明确说「没有下一步」，并按约定退非 0（3）。`done` 的归档是插件的边，
    // 不当作"下一步"——否则命令会永远有输出，"完成"这个事实被稀释。
    if (base.terminal) {
      const message =
        current === 'archived'
          ? `任务 ${record.id} 已归档（archived）：终态，没有下一步`
          : `任务 ${record.id} 已完成（done）：没有可执行的下一步（归档由插件按 tasks.archiveAfterDays 自动完成，或 flow task archive）`
      const error = new CliError('terminal', message)
      error.payload = { ...base, next: null, alternatives: [], acceptance }
      throw error
    }
    const step = stage.stageNextStep(current)
    const next = step.primary === null ? null : nextEdgeView(step.primary, record.id)
    const alternatives = step.alternatives.map((row) => nextEdgeView(row, record.id))
    const data = { ...base, actor: next === null ? step.actor : next.actor, next, alternatives, acceptance }
    if (!ctx.json) {
      out(`任务 ${record.id}  ${base.stageZh}（${base.stage}）  owner: ${base.owner === '' ? '-' : base.owner}`)
      if (next === null) {
        out('下一步  （这条阶段没有出边）')
      } else {
        out(`下一步  → ${next.stageZh}（${next.stage}）  ${next.actor}${next.back ? '  回退边' : '  主推荐'}`)
        out(`动作    ${next.action === '' ? '-' : next.action}`)
        out(`命令    ${next.command}`)
        out(`验证    ${next.verify === null ? '（无需验证）' : next.verify}`)
      }
      for (const row of alternatives) {
        out(`备选    → ${row.stageZh}（${row.stage}）  ${row.actor}${row.back ? '  回退边' : ''}`)
        out(`        ${row.action === '' ? '-' : row.action}`)
        out(`        ${row.command}`)
        if (row.verify !== null) out(`        ${row.verify}`)
      }
      out(`验收    ${acceptanceStateText(acceptance)}`)
      if (acceptance.executable > 0 && acceptance.passed !== true) {
        out(`提示    进入 reviewing/done 前必须先跑 ${acceptance.verifyCommand}`)
      }
    }
    return data
  }

  if (sub === 'verify') {
    const id = requireString(flags, 'id', '用法: flow task verify <id>')
    const timeoutSeconds = readPositiveInteger(flags, 'timeout', '--timeout 需要正整数秒（例如 --timeout 300）')
    const taskModel = await loadTaskModel()
    const record = await core.getTask(ctx.root, contract, id)
    const plan = taskModel.acceptancePlan(record)
    // 没有可执行验收项：不跑任何命令、不写回执、退出 0，但把"什么都没验"说清楚。
    // 静默成功会让调用方以为验收过了，比失败更危险。
    if (plan.steps.length === 0) {
      if (!ctx.json) {
        out(`验收 ${record.id}  没有可执行验收项（acceptance 里没有 cmd: / gate: 条目）`)
        out('做法    把验收写成 cmd:<shell 命令> 或 gate:<gateId>（flow_task update 的 acceptance 字段可写）')
        out(`重跑    flow task verify ${record.id}`)
      }
      return {
        id: record.id,
        ok: true,
        executed: 0,
        passed: 0,
        failed: [],
        steps: [],
        skipped: 'no-executable-acceptance',
        verification: null,
      }
    }
    if (!ctx.json) {
      out(
        `验收 ${record.id}  阶段 ${typeof record.stage === 'string' ? record.stage : '-'}  可执行 ${plan.steps.length} 项` +
          `（cmd ${plan.steps.filter((item) => item.kind === 'cmd').length}` +
          ` · gate ${plan.steps.filter((item) => item.kind === 'gate').length}）`,
      )
    }
    const steps = []
    for (const item of plan.steps) {
      if (item.kind === 'gate') {
        const started = Date.now()
        let result
        try {
          const run = await core.runGate(ctx.root, contract, item.target, {})
          const failedSteps = Array.isArray(run.steps) ? run.steps.filter((one) => one.ok !== true) : []
          // 门禁失败时把内层步骤的 id/exit 也带出来：只报"gate X 没通过"没法定位。
          const gateTail = failedSteps
            .map((one) => {
              const head = `${one.id} exit ${one.exit ?? '?'}`
              return typeof one.tail === 'string' && one.tail !== '' ? `${head}\n${one.tail}` : head
            })
            .join('\n')
          result = {
            index: item.index,
            kind: 'gate',
            target: item.target,
            ok: run.ok === true,
            exit: null,
            durationMs: Number.isFinite(run.durationMs) ? run.durationMs : Date.now() - started,
            tail: gateTail,
            repair: `flow gate run ${item.target}`,
          }
        } catch (error) {
          if (!(error instanceof core.FlowError)) throw error
          // 门禁缺失/被禁用也是"没通过"：不能把跑不起来的门禁当成证据。
          result = {
            index: item.index,
            kind: 'gate',
            target: item.target,
            ok: false,
            exit: null,
            durationMs: Date.now() - started,
            tail: error.message,
            repair: `flow gate run ${item.target}`,
            error: { code: error.code, message: error.message },
          }
        }
        steps.push(result)
        if (!ctx.json) printAcceptanceStep(result)
        continue
      }
      const seconds = item.timeoutSeconds === null || item.timeoutSeconds === undefined
        ? (timeoutSeconds === undefined ? 600 : timeoutSeconds)
        : item.timeoutSeconds
      const run = await core.runStep(
        ctx.root,
        { id: `acceptance-${item.index + 1}`, run: item.target, expect: item.expect },
        seconds * 1000,
        40,
      )
      const result = {
        index: item.index,
        kind: 'cmd',
        target: item.target,
        ok: run.ok === true,
        exit: run.exit,
        durationMs: run.durationMs,
        tail: run.ok === true ? '' : (typeof run.tail === 'string' ? run.tail : ''),
        repair: `flow task verify ${record.id}`,
      }
      steps.push(result)
      if (!ctx.json) printAcceptanceStep(result)
    }
    const failed = steps.filter((step) => step.ok !== true)
    const ok = failed.length === 0
    const written = taskModel.recordTaskVerification(ctx.root, contract, record.id, {
      ok,
      signature: plan.signature,
      steps: steps.map((step) => ({
        index: step.index,
        kind: step.kind,
        target: step.target,
        ok: step.ok,
        exit: step.exit,
        durationMs: step.durationMs,
        tail: step.tail,
      })),
    })
    const data = {
      id: record.id,
      ok,
      executed: steps.length,
      passed: steps.length - failed.length,
      failed: failed.map((step) => `${step.kind}:${step.target}`),
      steps,
      verification: written.verification ?? null,
      repair: ok ? null : `flow task verify ${record.id}`,
    }
    if (!ctx.json) {
      out(
        `结果  ${ok ? '通过' : '未通过'}  ${steps.length - failed.length}/${steps.length}` +
          (ok ? '' : `（失败 ${failed.map((step) => `${step.kind}:${step.target}`).join('、')}）`),
      )
      if (ok) out(`回执  已写入 verification（${fmtTime(data.verification.at)}）`)
      else {
        out(`修复  ${data.repair}`)
        const gateRepairs = [...new Set(failed.filter((step) => step.kind === 'gate').map((step) => step.repair))]
        if (gateRepairs.length > 0) out(`      门禁可单独查：${gateRepairs.join('；')}`)
        out('      进入 reviewing/done 前必须让验收全绿')
      }
    }
    if (!ok) {
      const error = new CliError('check-failed', `验收未通过：${failed.length}/${steps.length} 项失败（${data.failed.join('、')}） — 修复后重跑 ${data.repair}`)
      error.payload = { verification: data }
      throw error
    }
    return data
  }

  if (sub === 'rm') {
    const id = requireString(flags, 'id', '用法: flow task rm <id> [--yes]')
    await confirmDelete(ctx, `任务 ${id}`)
    const result = await core.removeTask(ctx.root, contract, id)
    if (!ctx.json) out(`已删除任务 ${id}`)
    return result
  }

  throw new CliError(
    'usage',
    `未知子命令 task ${sub}（可用 list|show|next|verify|add|update|archive|sweep|normalize|link|unlink|rm）`,
  )
}

/** `lib/stage.mjs`（边表 + 每边动作/验证命令）。懒加载，`flow --help` 不付钱。 */
export async function loadStageModel() {
  try {
    return await import(new URL('../stage.mjs', import.meta.url).href)
  } catch (error) {
    throw new CliError('io', `无法加载阶段机（lib/stage.mjs）：${error?.message || String(error)}`)
  }
}

/** `lib/tasks/records.mjs` 的任务域（验收解析 / 验证回执的读写入口）。 */
export async function loadTaskModel() {
  try {
    return await import(new URL('../tasks/records.mjs', import.meta.url).href)
  } catch (error) {
    throw new CliError('io', `无法加载任务域（lib/tasks/records.mjs）：${error?.message || String(error)}`)
  }
}

/** doctrine 模板的 `{id}` 占位符代入（stage.mjs 不认识记录，不做渲染）。 */
export function renderNextTemplate(template, id) {
  if (typeof template !== 'string' || template === '') return ''
  return template.split('{id}').join(id)
}

/** 一条边的人类可读块（`next` 的主动作与备选共用）。 */
export function nextEdgeView(row, id) {
  return {
    stage: row.stage,
    stageZh: row.zh,
    actor: row.actor,
    back: row.back === true,
    action: renderNextTemplate(row.action, id),
    verify: row.verify === null || row.verify === undefined ? null : renderNextTemplate(row.verify, id),
    command: renderNextTemplate(row.command, id),
  }
}

/** 验收状态的一句话（人类输出用）：可执行项数与最近结论。 */
export function acceptanceStateText(acceptance) {
  const head = `${acceptance.executable} 项可执行（cmd ${acceptance.cmd} · gate ${acceptance.gate}）`
  if (acceptance.executable === 0) return `${head} · 没有可执行验收项`
  if (acceptance.passed === true) return `${head} · 最近验证 通过${acceptance.at === null ? '' : ` ${fmtTime(acceptance.at)}`}`
  if (acceptance.at === null) return `${head} · 未验证`
  if (acceptance.fresh === false) return `${head} · 最近验证已过期（验收被改动）`
  return `${head} · 最近验证 未通过`
}

/**
 * 一条验收步骤的人类输出（边跑边打，长命令不会看起来像卡住）。
 *
 * cmd 步恒打 `exit N`：失败时即使命令一个字都没输出也要能看出退出码；门禁步的
 * 内层退出码在 tail 里（`<step> exit N`），外层没有单独退出码。
 */
export function printAcceptanceStep(step) {
  const mark = step.ok === true ? '✓' : '✗'
  const exit = step.kind === 'cmd' && Number.isInteger(step.exit) ? `  exit ${step.exit}` : ''
  out(`${mark} acceptance[${step.index + 1}]  ${step.kind}:${step.target}${exit}  ${fmtDuration(step.durationMs)}`)
  if (step.ok !== true && typeof step.tail === 'string' && step.tail !== '') {
    for (const line of step.tail.split('\n').slice(-10)) out(`    ${line}`)
  }
}

/** 合并后的 title 超过这个宽度就提示复查（面板首行是 `type: title`，§9.1.4）。 */
export const TASK_TITLE_REVIEW_WIDTH = 120

/**
 * 待迁移记录在写盘后的 `title` 预览，按 `normalizeTaskRecord` 的同一条规则算
 * （只有 goal 非空、title 非空且两者不同才合并）。用于 `--dry-run` 的变更对照与
 * 长标题统计，不写盘。
 */
export function plannedTaskTitle(record) {
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const goal = typeof record.goal === 'string' ? record.goal.trim() : ''
  if (goal === '' || title === '' || goal === title) return null
  return `${title} — ${goal}`
}

/** 文本显示宽度（CJK 记 2 列），用于判断合并后的 title 会不会顶掉面板布局。 */
export function displayWidthOf(text) {
  let width = 0
  for (const char of String(text)) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char) ? 2 : 1
  }
  return width
}

/**
 * `flow task normalize`: the only write path for legacy task format (`goal` merge /
 * `type` backfill), kept deliberately separate from `check tasks` so the gate family
 * stays read-only. `--dry-run` is a report: `fix:false`, no lock, no write, exit 0.
 * Never guesses `type` — a record without a mapping stays unfixed and is reported.
 */
export async function runTaskNormalize(ctx) {
  const { core } = ctx
  const dryRun = ctx.flags['dry-run'] === true
  // P1-1（review-core task-17）：`--dry-run` 也必须在未初始化 root 上走 usage。
  // `normalizeTaskFormat({fix:false})` 对空目录返回 `{ok:true, issues:[]}`，"读不到台账"
  // 与"台账很干净"会输出成同一句话——复查 §3.3③ 时会被当成"已归零"（静默假绿）。
  core.assertInitialized(ctx.root)
  const contract = loadContractFor(ctx, ctx.root)
  const mapPath = readString(ctx.flags, 'type-map')
  const typeById = mapPath === undefined ? {} : loadTypeMap(ctx.root, mapPath)
  if (mapPath !== undefined) warnTypeMapExtras(core, ctx.root, contract, typeById)

  // 预览用只读一遍（`fix:false` 不取锁）：--dry-run 直接用它，真跑用它算「写盘后还剩什么」。
  const planned = core.normalizeTaskFormat(ctx.root, contract, { fix: false, typeById })
  let result = planned
  let landed = []
  if (dryRun === false) {
    result = core.normalizeTaskFormat(ctx.root, contract, { fix: true, typeById })
    landed = Array.isArray(result.fixed) ? result.fixed : []
  }
  drainCoreWarnings()

  const records = new Map()
  for (const record of core.listTasks(ctx.root, contract)) {
    if (typeof record?.id === 'string') records.set(record.id, record)
  }
  const ratio = (kind) => result.issues.filter((item) => item.kind === kind).length
  const counts = { 'legacy-goal': ratio('legacy-goal'), 'missing-type': ratio('missing-type') }
  const remaining = { 'legacy-goal': 0, 'missing-type': 0 }
  if (dryRun === false) {
    // 写盘后的真实残留（core 的 ok 就是这个判定）：直接问一遍盘上状态，不自己推。
    const after = core.normalizeTaskFormat(ctx.root, contract, { fix: false, typeById })
    for (const item of after.issues) remaining[item.kind] = (remaining[item.kind] ?? 0) + 1
  }

  const lines = []
  const longTitles = []
  if (planned.issues.length === 0) {
    lines.push('（没有待迁移的旧记录）')
  } else if (dryRun) {
    for (const id of [...new Set(planned.issues.map((item) => item.id))]) {
      const record = records.get(id)
      const merged = plannedTaskTitle(record ?? {})
      const current = typeof record?.type === 'string' ? record.type.trim() : ''
      const mapped = typeById[id] === undefined ? null : typeById[id]
      const parts = [`${id}`]
      parts.push(merged === null ? '删 goal 键' : `title: ${JSON.stringify(record?.title ?? '')} → ${JSON.stringify(merged)}`)
      // 已有 type 的记录永不被 map 穿透（CONTRACT §3.2 规则 3）：只有真缺 type 才提补齐。
      if (current === '') parts.push(mapped === null ? 'type 仍缺（map 未覆盖）' : `type → ${JSON.stringify(mapped)}`)
      else parts.push(`type ${JSON.stringify(current)} 不动`)
      lines.push(`· ${parts.join(' · ')}`)
      if (merged !== null && displayWidthOf(merged) > TASK_TITLE_REVIEW_WIDTH) {
        longTitles.push({ id, width: displayWidthOf(merged), title: merged })
      }
    }
    lines.push(`将归一 ${new Set(planned.issues.map((item) => item.id)).size} 条：legacy-goal ${counts['legacy-goal']} · missing-type ${counts['missing-type']}（--dry-run：未写盘）`)
  } else {
    for (const id of landed) lines.push(`✓ 已归一 ${id}`)
    lines.push(`已归一 ${landed.length} 条（legacy-goal ${counts['legacy-goal']} · missing-type ${counts['missing-type']}）`)
    const left = remaining['legacy-goal'] + remaining['missing-type']
    if (left > 0) {
      lines.push(`仍有 ${left} 条待处理（legacy-goal ${remaining['legacy-goal']} · 缺 type：${remaining['missing-type']} 条）`)
      if (remaining['missing-type'] > 0) {
        lines.push('补 type 后再跑：flow task normalize --type-map <file.json>（不会替你猜 type）')
      }
    }
  }
  if (longTitles.length > 0) {
    lines.push(`⚠ 合并后 title 超过 ${TASK_TITLE_REVIEW_WIDTH} 列 ${longTitles.length} 条（面板首行是 type: title，请复查）：`)
    for (const item of longTitles) lines.push(`  ⚠ ${item.id} ${item.width} 列 ${clip(item.title, 60)}`)
  }
  const stdout = lines.join('\n')
  if (!ctx.json) {
    for (const line of lines) out(line)
  }
  return {
    fix: dryRun !== true,
    dryRun,
    ok: remaining['legacy-goal'] + remaining['missing-type'] === 0,
    issues: result.issues,
    fixed: landed,
    counts,
    remaining: dryRun ? null : remaining,
    longTitles: longTitles.map((item) => item.id),
    typeMap: mapPath ?? null,
  }
}

/**
 * Read and validate `--type-map` (a CLI input channel, hence bin-side rather
 * than core: core only ever sees an already-validated `typeById` object). Every
 * malformed shape is a `usage` error (exit 2), never a check failure: a wrong
 * config must not be mistaken for a dirty ledger. Runs before the core call, so
 * it never takes the store lock and never writes.
 */
export function loadTypeMap(root, mapPath) {
  if (mapPath.trim() === '') {
    throw new CliError('usage', '--type-map 需要一个文件路径（形如 .dsh-ops/type-map.json）')
  }
  const file = path.resolve(root, mapPath)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new CliError('usage', `--type-map 文件不存在：${mapPath}（${error.code ?? error.message}）`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError('usage', `--type-map 不是合法 JSON：${mapPath}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('usage', `--type-map 顶层必须是对象 { "<T-id>": "<type>" }：${mapPath}`)
  }
  const types = coreRef.TASK_TYPES
  const out = {}
  for (const [id, value] of Object.entries(parsed)) {
    const type = typeof value === 'string' ? value.trim() : ''
    if (types.includes(type) === false) {
      throw new CliError(
        'usage',
        `--type-map 里 ${id} 的值 ${JSON.stringify(value)} 不是合法 type（可用 ${types.join('|')}）：${mapPath}`,
      )
    }
    out[id] = type
  }
  return out
}

/**
 * D6 warnings for a `--type-map`: a key the ledger does not have, or one whose
 * record already carries a (different) type. Both are advisory only — the map is
 * allowed to be wider than what is missing (an AI-produced candidate list is),
 * and an already-typed record is never rewritten (CONTRACT §3.2 rule 3).
 * Read-only: `listTasks` uses the `{ unreadable }` collector so a broken file is
 * counted as a warning instead of being mistaken for "id absent".
 */
export function warnTypeMapExtras(core, root, contract, typeById) {
  const known = new Map()
  const unreadable = []
  for (const record of core.listTasks(root, contract, { unreadable })) {
    if (typeof record?.id === 'string') known.set(record.id, record)
  }
  for (const file of unreadable) core.noteWarning(`unreadable: ${file}`)
  for (const [id, type] of Object.entries(typeById)) {
    const record = known.get(id)
    if (record === undefined) {
      core.noteWarning(`type-map-unknown-id: ${id}`)
      continue
    }
    const current = typeof record.type === 'string' ? record.type.trim() : ''
    if (current !== '' && current !== type) {
      core.noteWarning(`type-map-unused: ${id} 已有 type "${current}"`)
    }
  }
}

/**
 * The Team-sync module (P3b). Loaded lazily like `loadCore`: `flow --help` and the
 * unrelated commands must not pay for a module they never call, and a package
 * missing `lib/team-sync.mjs` still has a working CLI for everything else.
 *
 * Both entries write the **local ledger only** — linking never calls the Team
 * service, so there is no external write to fail halfway.
 */
export async function loadTeamSync() {
  try {
    return await import(new URL('../team-sync.mjs', import.meta.url).href)
  } catch (error) {
    throw new CliError('io', `无法加载团队板同步模块（lib/team-sync.mjs）：${error?.message || String(error)}`)
  }
}
