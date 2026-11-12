// 其余命令实现（自 bin/flow.mjs 原样搬出）
//
// `init` / `status` / `backup` / `doctor` 与 USAGE 帮助正文。

import path from 'node:path'
import { createBackup, doctorReport } from '../backup.mjs'
import { listIntents } from '../tasks/intents.mjs'

import { decisionSessionInfo, decisionSuspended } from './decisions.mjs'
import { fmtAge, printStatusBlock, statusBlockOf } from './heartbeat.mjs'
import { CliError, clip, collectWarnings, fmtDuration, fmtTime, jsonMode, out, pad, readString, textWidth } from './shared.mjs'

export const USAGE = `project-flow CLI（schema 2）

用法
  flow <command> [options]
  flow --root <dir> <command> [--json]

命令
  init      初始化 .agents/flow（--name X --force --no-gates）
  status    项目名、契约源、实验/任务/门禁/决策计数与最近记录
  backup [--keep N]          给 .agents 台账拍本地快照（默认保留 5 份，存到 .agents-backups/）
  doctor [--stale-hours N]   台账体检：契约/记录目录/git 忽略/快照新鲜度（error 时退出 1）

  exp list | show <id> | tree
  exp add [--id E-YYYYMMDD-NN] --title T --hypothesis H --direction TEXT --expected E
          --primary-metric M --guardrail G [--guardrail G]...
          --falsify F --window-days N --stop-loss S
          [--factor F] [--parent ID] [--scale S] [--notes N]
  exp update <id> [--title T] [--status open|confirmed|refuted|abandoned|inconclusive|pivoted]
          [--direction TEXT] [--expected E] [--primary-metric M] [--guardrail G]...
          [--falsify F] [--window-days N] [--stop-loss S] [--learned L]
          [--hypothesis H] [--factor F] [--parent ID] [--scale S]
          [--measured M] [--metrics JSON] [--commits a,b] [--notes N]
  exp review <id>               只读自查：verdict/branch/missing（恒退出 0）
  exp productize <id> [--gate release]
  exp cleanup <id> [--flag F]... [--code C]... [--data D]...
  exp rm <id> [--yes]

  task list | show <id> | next <id> | verify <id>
  task add --title T --type <t> [--id T-YYYYMMDDHHMMSS] [--status draft|active|done|archived]
           [--stage <s>] [--owner O] [--notes N] [--experiment E-id] [--parent T-id]
  task update <id> [--title T] [--type <t>] [--status draft|active|done|archived]
           [--stage <s>] [--owner O] [--notes N] [--experiment E-id] [--parent T-id]
          type 必填（add）：feat|fix|docs|style|refactor|perf|test|chore|build|ci（commit 类型）
          stage（可选）：created|queued-analysis|analyzing|queued-implementation|implementing|
           queued-review|reviewing|done|archived；写 stage 时 status 自动派生（见 CONTRACT §3.2.1）
          标题即目标（goal 已并入 title）；title/type 不可改（update），旧记录由格式门禁迁移
          owner 是任务的会话归属：--owner <会话 id> 领取；--owner none|null 释放为未指定会话；
          活跃会话的任务不能被其他会话改写/释放（见 CONTRACT §3.2.1）
          父子：--parent 的父任务须存在、禁自指/禁环；--parent ''|none|null 清空为根
  task next <id> [--json]
          只读查表：打印这个任务的唯一下一步——目标阶段、该谁做（session/plugin/
          reviewer）、必做动作、验证命令、推进命令；有多条合法边时给主推荐 + 备选。
          终态（done/archived）或未知 id 退出非 0（不推理，只读 lib/stage.mjs 的边表）。
  task verify <id> [--timeout SECONDS]
          按 acceptance 顺序执行 cmd:<shell 命令> / gate:<gateId>，把结论回填到任务的
          verification 字段；任一项失败退出 1 并给修复命令（默认每项超时 600 秒）。
          进入 reviewing/done 前必须先通过验收；任务没有可执行验收项时默认只警告
          （tasks.requireAcceptance=strict 可改为拒绝，见 lib/tasks/records.mjs）。
  task link <TASK-ID> --team <BOARD-ID>   # 挂载团队板 id（只写本地台账，零外部写入）
  task unlink <TASK-ID>                   # 解除挂载（team=null；同样零外部写入）
  task archive [--older-than N] [--dry-run]
          归档已完成的旧任务（阈值取 tasks.archiveAfterDays，默认 7，0=关闭；--dry-run 只预览不写盘）
  task sweep [--older-than-hours N] [--dry-run]
          消息卡收口：把「从没被领取」的捕获卡（stage=待分析、无 notes/commits/回执、未指定会话）
          自动完成；默认 24 小时，--dry-run 只报告不写盘
  task normalize [--type-map <file.json>] [--dry-run]
          归一旧记录：goal 并入 title、按 map 补 type（--dry-run 只报告不改盘；不会猜 type）
  task rm <id> [--yes]

  gate list | show <id>
  gate add --id SLUG --title T --phase commit|release|manual [--step 'id=run>>expect' ...]
           [--allow-unknown-expect]
  gate update <id> [--title T] [--phase commit|release|manual]
           [--enabled true|false] [--step 'id=run>>expect' ...] [--allow-unknown-expect]
          expect 未知写法（如 exit:1）定义期直接拒绝；仅 --allow-unknown-expect 才按 exit 0 容错
  gate enable <id> | disable <id>
  gate rm <id> [--yes]
  gate run <id> [--timeout SECONDS] [--force]
  gate run --phase commit|release|manual [--timeout SECONDS] [--force]
  gate logs <id> [--limit N]

  heartbeat start [--goal G] [--task ID] [--claim PATH]... [--agent A]
                  [--session S] [--note T]
  heartbeat update [--status working|idle|waiting] [--note T] [--goal G] [--task ID]
                   [--claim PATH]... [--session S]
  heartbeat end [--note T] [--session S]
  heartbeat list
  heartbeat status [--require-active] [--session S]
  heartbeat rm <session>        移除一条心跳记录（归档自动移除，这里是人的逃生口）
  heartbeat gc [--dry-run] [--older-than-hours N]
          清理旧心跳：agent=subagent 的历史文件 + 已结束超过 N 小时（默认只清 subagent）

  aspect list                   列出 aspect 定义（docs/module-domain.json）与当前占用
  aspect acquire --aspect X [--file P] [--session S] [--ttl 秒] [--wait 毫秒]
         登记占用一个 aspect；被活着的占用方挡住时最多等 --wait（默认 1500ms），
         等不到**不阻断**：返回占用方与等待时长（裁定 6：登记与锁都放行，真重叠再升级）
  aspect renew --aspect X [--session S] [--ttl 秒]     续租（停止续期 = 放弃，TTL 到期自动释放）
  aspect release --aspect X [--session S] [--force --reason R [--by WHO]]
         释放（只有占用方能释放；force 越过占用方，必须给 reason 并写审计日志）
  aspect sweep [--dry-run]      回收占用方已死/租约到期的锁（活着的占用方保留）

  decision ask --question Q --kind choice|approval|input
               [--option 'id=label>>impact']... [--default ID] [--recommendation ID]
               [--rationale R] [--blocks T-id]... [--affects PATH]... [--supersedes D-id]
  decision list [--open] [--all]
  decision show <id>
  decision answer <id> --choice C [--note N] [--by user|agent]
  decision withdraw <id> --reason R [--by user|agent]
  decision gc [--days N] [--dry-run]

  desc status [--json]          描述台账计数与 enforce/enabled（未建立时只提示）
  desc build [--dry-run]        按源码同步结构（hash/import/模块边），不碰已写语义
  desc show [--path <src>] [--graph tree|mermaid] [--json]
                                无 --path：文件树；有 --path：该文件的模块表与模块边；
                                --graph mermaid：直接打印完整渲染文档
  desc set --input <json|file>  写文件/模块语义（对象=单文件补丁，数组=多文件补丁）
  desc set --project-semantics <text>   写项目语义（project.json 必须已由 build 建立）
  desc plan <T-id> --template <src>     打印计划骨架（当前记录；无记录则扫源码）
  desc plan <T-id> --input <json|file>  建/改变更计划（已存在 = 修订；文件路径相对项目根）
  desc plan <T-id> --show               打印当前计划（没有则提示「无计划」）
  desc plan <T-id> --no-semantic-change --reason <text>
  desc plan <T-id> --rebase             按当前 HEAD/工作树重算 base（implemented 计划只刷新 base）
  desc apply <T-id> [--dry-run]         把计划语义落进记录并冻结计划（幂等）
  desc render [--out <path>] [--check]  打印/写出确定性 Markdown；--check 与现算比对

  check list
  check staged --allow <path> [--allow <path> ...]
  check release-baseline --marker <text> [--threshold <N>]
  check decisions | check experiments
  check tasks [--type-map <file.json>]
  check description [--task <T-id>] [--strict]
  check state [--file <path>]
  check doc --file <path> --type task|design|incident|release
  check decisions                内置检查：阻塞决策命中暂存文件时失败（core 实现）
  check tasks                    内置检查：旧任务记录未归一（残留 goal 键 / 缺 type）时失败
  check description              内置检查：描述台账漂移（缺记录/陈旧 hash/成员/模块边/语义）时失败

  心跳只面向主会话（同一项目的多个主会话互相避让）：子会话不登记心跳，
  在子会话里运行 heartbeat start/update/end 会被明确拒绝；list/status 只读，
  可随时调用。心跳根固定为项目主工作区（linked worktree 也写主工作区）。

  机械检查（只读，不写 .agents/flow）：运行包里 skills/ai-collaborative-dev-workflow/
  scripts/ 下的检查脚本；超时用 --timeout <seconds>（默认 120）。
  check decisions / check experiments / check tasks / check description 是内置检查：
  bin 特判路由到 core.checkDecisions / core.checkExperiments / core.normalizeTaskFormat /
  core.checkDescription（只读），不跑 scripts/；lib/checks.mjs 仍不 import core、
  不读写 store。
  check tasks 的 --type-map <file.json> 是 { "<T-id>": "<type>" } 草稿文件，只用来
  判断 missing-type 是否可消；值必须是十个 type 之一，否则按用法错误退 2。
  check tasks 永远不会替你猜 type，也不能写盘；归一由 flow task normalize 执行。

  描述台账（desc）：台账在 .agents/description/（project.json + files/ + tasks/）。
  status/build/show/render 只读（--out 是唯一的文件写出），set 写语义，plan 写分析阶段
  的语义变更计划，apply 把计划落进记录并冻结；check description 失败 exit 1。
  desc render --check 与 description.render 现算比对，不一致 exit 1；--out 与
  description.render 都必须落在项目根内（越界按用法错误退 1）。

  决策只面向主会话：需要用户拍板的问题先 ask 建记录再提问，用户回答当轮 answer；
  open 同题复用、已关闭同题必须 --supersedes；阻塞决策（blocks 非空）影响暂存文件时
  check decisions 让 precommit 失败。

全局
  --root <dir>   项目根目录（默认当前目录）
  --json         机器可读输出：{ok:true,data,warnings} 或 {ok:false,error,warnings}
                 （warnings 恒为数组，可为空；契约修复/不可读记录/锁接管等诊断都在里面）
  -h, --help     显示本帮助

退出码
  0 成功 · 1 用法错误 · 2 校验失败 · 3 未找到 · 4 IO/环境错误
  注意：gate run 的门禁失败以 data.ok=false 表达，命令本身成功时仍退出 0。
  check 复用同一组数字：0 通过 · 1 检查失败 · 2 用法/配置错误 ·
  3 脚本或解释器缺失 · 4 启动/IO 失败（含超时）。
  实验相关：exp review 恒 0（只读自查）；exp productize 未过门禁 → 2；
  check experiments 失败 → 1（warnings 不阻断）。`

// status 只逐条展示最近的心跳，其余用总数提示。
export const STATUS_HEARTBEAT_ROWS = 5

export async function cmdInit(ctx) {
  const { core, flags } = ctx
  const options = {}
  const name = readString(flags, 'name')
  if (name !== undefined) options.name = name
  if (flags.force === true) options.force = true
  if (flags['no-gates'] === true) options.noGates = true
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
  }
  collectWarnings(result?.warnings)
  return result
}

/** ` · +N 无法读取` suffix for human status lines (empty when every record parsed). */
export function unreadableTail(list) {
  const count = Array.isArray(list) ? list.length : 0
  return count > 0 ? ` · +${count} 无法读取` : ''
}

export function countsOf(items, keys) {
  const counts = Object.fromEntries(keys.map((key) => [key, 0]))
  for (const item of items) {
    const status = item?.status
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status]++
  }
  return counts
}

export async function cmdStatus(ctx) {
  const { core } = ctx
  const loaded = core.loadContract(ctx.root)
  collectWarnings(loaded.warnings)
  const contract = loaded.contract
  const initialized = loaded.source !== 'defaults'

  // Invalid records are skipped from the rows but never vanish from the counts:
  // each family reports how many files could not be parsed alongside its totals.
  const unreadable = { experiments: [], tasks: [], gates: [] }
  let experiments = []
  let tasks = []
  let gates = []
  let store = null
  if (initialized) {
    ctx.contract = contract
    ctx.contractRoot = ctx.root
    experiments = await core.listExperiments(ctx.root, contract, { unreadable: unreadable.experiments })
    tasks = await core.listTasks(ctx.root, contract, { unreadable: unreadable.tasks })
    gates = await core.listGates(ctx.root, contract, { unreadable: unreadable.gates })
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

  // 待决策段：与提醒/面板同一份读模型（open 排序：升级优先、asked_at 旧的在前）。
  let decisions = {
    items: [],
    counts: { open: 0, blocking: 0, escalated: 0, answered: 0, withdrawn: 0, superseded: 0, total: 0 },
  }
  if (initialized) {
    try {
      const info = decisionSessionInfo(ctx, contract)
      const summary = core.summarizeDecisions(ctx.root, contract, { ...info, limit: 3 })
      decisions = { items: summary.items, counts: summary.counts }
    } catch {
      // 决策读取失败不影响 status 的其余部分
    }
  }

  // 描述计数是**展示层**的读（spec §9）：不进 `data.status`（面板数据模型不动），
  // 只在 store 已初始化时读；读不到给 null 而不是零值（"读不到"必须与"很干净"可分）。
  let description = null
  if (initialized) {
    try {
      const project = core.readDescriptionProject(ctx.root, contract)
      const counts = core.descriptionStatus(ctx.root, contract)
      description = {
        established: project !== null || counts.files > 0,
        files: counts.files,
        modules: counts.modules,
        missingSemantics: counts.missingSemantics,
        plans: counts.plans,
        described: counts.described,
      }
    } catch (error) {
      collectWarnings([`description-status-unavailable: ${error?.message ?? String(error)}`])
    }
  }

  // 未完成的 saga intent（T-20261112183138-02）：多步写崩溃后遗留的线索。读不到不影响
  // status 的其余部分；没有目录就是"没有在途动作"，与"读不到"区分开（后者进 warnings）。
  let intents = null
  if (initialized) {
    try {
      const section = listIntents(ctx.root, contract, { state: 'open', limit: 10 })
      intents = {
        open: section.counts.open,
        items: section.items.map((item) => ({
          id: item.id,
          kind: item.kind,
          target: item.target,
          steps: item.steps,
          done: item.done,
          missing: item.missing,
          updated_at: item.updated_at,
        })),
      }
    } catch (error) {
      collectWarnings([`intents-unavailable: ${error?.message ?? String(error)}`])
    }
  }

  const expCounts = countsOf(experiments, ['open', 'confirmed', 'refuted', 'abandoned', 'inconclusive', 'pivoted'])
  const taskCounts = countsOf(tasks, ['draft', 'active', 'done', 'archived'])
  const gateEnabled = gates.filter((gate) => gate.enabled !== false).length

  // §9 状态块：只在 store 存在时读。未初始化时**不给零值块**——"读不到"必须与
  // "很干净"可区分（本会话反复打的假绿就是这两者被混为一谈）。
  let statusBlock = null
  if (initialized) {
    try {
      statusBlock = await statusBlockOf(ctx, ctx.root, contract)
    } catch (error) {
      collectWarnings([`status-block-unavailable: ${error?.message ?? String(error)}`])
    }
  }

  const data = {
    root: ctx.root,
    name: contract.name || path.basename(ctx.root),
    initialized,
    contractSource: loaded.source,
    schema: contract.schema,
    store,
    counts: {
      experiments: { total: experiments.length, ...expCounts, unreadable: unreadable.experiments.length },
      tasks: { total: tasks.length, ...taskCounts, unreadable: unreadable.tasks.length },
      gates: { total: gates.length, enabled: gateEnabled, unreadable: unreadable.gates.length },
      // 只在 store 存在时给（未初始化时不给零值：与 data.status 同一条纪律）。
      ...(description === null
        ? {}
        : {
            description: {
              files: description.files,
              modules: description.modules,
              missingSemantics: description.missingSemantics,
              plans: description.plans,
              described: description.described,
            },
          }),
    },
    heartbeats,
    decisions,
    ...(intents === null ? {} : { intents }),
    recent: {
      experiments: experiments.slice(0, 3),
      tasks: tasks.slice(0, 3),
      gateRuns: recentRuns.slice(0, 3),
    },
    // `status` 缺席 = store 未初始化/不可读；不是"零任务"。
    ...(statusBlock === null ? {} : { status: statusBlock }),
  }

  // 台账根可能与请求根不同（worktree 会话共享主工作区台账）：显式给出，避免误解。
  const ledgerRoot = core.resolveProjectRoot(ctx.root)
  if (ledgerRoot !== path.resolve(ctx.root)) data.ledgerRoot = ledgerRoot
  if (!ctx.json) {
    const lines = [
      ['项目', data.name],
      ['根目录', ctx.root],
      ...(ledgerRoot === path.resolve(ctx.root) ? [] : [['台账根', ledgerRoot]]),
    ]
    if (!initialized) {
      lines.push(['契约', '未初始化（未找到 .agents/flow/flow.json）'])
      lines.push(['下一步', 'flow init'])
    } else {
      lines.push(['契约', `${loaded.source}（schema ${contract.schema ?? '?'}）`])
      // 「存储」只指契约目录会误导：五类记录在 .agents/ 的兄弟目录里（T-20261109095142 审计项）。
      const storeText = store || contract?.store?.root || '.agents/flow'
      const storeAbs = path.isAbsolute(storeText) ? storeText : path.resolve(ctx.root, storeText)
      const recordsRel = path.relative(ctx.root, path.dirname(storeAbs)) || '.'
      lines.push(['记录根', `${recordsRel}（tasks/ decisions/ gates/ experiments/ description/ 与 flow/ 平级）`])
      lines.push([
        '实验',
        `${experiments.length}（open ${expCounts.open} · confirmed ${expCounts.confirmed} · refuted ${expCounts.refuted} · abandoned ${expCounts.abandoned} · inconclusive ${expCounts.inconclusive} · pivoted ${expCounts.pivoted}${unreadableTail(unreadable.experiments)}）`,
      ])
      lines.push([
        '任务',
        `${tasks.length}（draft ${taskCounts.draft} · active ${taskCounts.active} · done ${taskCounts.done} · archived ${taskCounts.archived}${unreadableTail(unreadable.tasks)}）`,
      ])
      lines.push([
        '门禁',
        `${gates.length}（启用 ${gateEnabled}${unreadableTail(unreadable.gates)}）`,
      ])
      lines.push([
        '描述',
        description === null
          ? '读取失败（见警告）'
          : description.established
            ? `${description.files} 文件 · ${description.modules} 模块 · 缺语义 ${description.missingSemantics} · 计划 ${description.plans}`
            : '未建立（flow desc build）',
      ])
      lines.push(['待决策', `${decisions.counts.open}（阻塞 ${decisions.counts.blocking}）`])
      if (intents !== null && intents.open > 0) {
        // 未完成 intent 的可见面（T-20261112183138-02）：多步写崩在中间时，这条是
        // "有一个动作没走完"的唯一线索；列到状态里，别让它只留在 .agents/intents/。
        const labels = intents.items
          .slice(0, 3)
          .map((item) => `${item.id}(${item.kind} 缺 ${item.missing.join('/') || '-'})`)
          .join('、')
        lines.push(['未完成动作', `${intents.open} 条：${labels}${intents.open > 3 ? ' …' : ''}`])
      }
      const hiddenBeats = Number(heartbeats.counts.hidden) || 0
      const deadBeats = Number(heartbeats.counts.dead) || 0
      lines.push([
        '心跳',
        `${heartbeats.counts.total}（可能已停 ${heartbeats.counts.stale}${deadBeats > 0 ? ` · 已结束 ${deadBeats}` : ''}${hiddenBeats > 0 ? ` · 旧子会话隐藏 ${hiddenBeats}` : ''}）`,
      ])
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
      if (decisions.items.length > 0) {
        out('')
        out(`待决策 ${decisions.counts.open}（阻塞 ${decisions.counts.blocking}）`)
        for (const item of decisions.items) {
          out(
            `  ${item.escalated === true ? '⚠ ' : ''}${item.id}  [${item.kind}]  ${clip(item.question, 48)}  ${decisionSuspended(item)}`,
          )
        }
      }
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
      if (statusBlock !== null) {
        out('')
        printStatusBlock(statusBlock)
      }
    }
  }
  return data
}

/** Human-readable byte size for the backup report. */
export function byteText(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${unit === 0 ? String(size) : size.toFixed(1)} ${units[unit]}`
}

export async function cmdBackup(ctx) {
  const raw = ctx.flags['keep']
  let keep
  if (raw !== undefined) {
    keep = Number.parseInt(String(raw), 10)
    if (!Number.isInteger(keep) || keep < 1) throw new CliError('usage', '--keep 需要正整数')
  }
  let result
  try {
    result = createBackup(ctx.root, keep === undefined ? {} : { keep })
  } catch (error) {
    throw new CliError('io', error.message)
  }
  if (jsonMode === false) {
    out(`已创建快照 ${result.name}（${result.files} 个文件，${byteText(result.bytes)}）`)
    out(`位置 ${path.relative(ctx.root, result.path) || result.path}`)
    if (result.pruned.length > 0) out(`已剪枝 ${result.pruned.length} 份旧快照：${result.pruned.join('、')}`)
  }
  return { name: result.name, path: result.path, files: result.files, bytes: result.bytes, pruned: result.pruned }
}

export async function cmdDoctor(ctx) {
  const raw = ctx.flags['stale-hours']
  let staleHours
  if (raw !== undefined) {
    staleHours = Number.parseFloat(String(raw))
    if (!Number.isFinite(staleHours) || staleHours <= 0) throw new CliError('usage', '--stale-hours 需要正数')
  }
  const report = doctorReport(ctx.root, staleHours === undefined ? {} : { staleHours })
  if (jsonMode === false) {
    for (const finding of report.findings) {
      const mark = finding.level === 'ok' ? '✓' : finding.level === 'warn' ? '!' : '✗'
      out(`${mark} ${finding.id}：${finding.message}${finding.hint === undefined ? '' : `（建议：${finding.hint}）`}`)
    }
    const errors = report.findings.filter((item) => item.level === 'error').length
    const warns = report.findings.filter((item) => item.level === 'warn').length
    out(`结果 ${report.ok ? '可用' : '不可用'}（error ${errors} · warn ${warns}）`)
  }
  if (report.ok === false) {
    const errors = report.findings.filter((item) => item.level === 'error').map((item) => item.message)
    throw new CliError('check-failed', `台账不可用：${errors.join('；')}`)
  }
  return report
}
