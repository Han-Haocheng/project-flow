// 检查命令实现（自 bin/flow.mjs 原样搬出）
//
// `flow check *`（脚本检查 + 内置检查路由）。

import { CliError, collectWarnings, drainCoreWarnings, out, readInteger, readPositiveInteger, readString } from './shared.mjs'
import { loadTypeMap, warnTypeMapExtras } from './tasks.mjs'

export async function loadChecks() {
  try {
    return await import(new URL('../checks.mjs', import.meta.url).href)
  } catch (error) {
    const missing =
      error?.code === 'ERR_MODULE_NOT_FOUND' && /lib[/\\]checks\.mjs/.test(String(error.message))
    const detail = missing
      ? '缺少 lib/checks.mjs（flow check 的检查目录未随包提供）'
      : error?.message || String(error)
    throw new CliError('io', `无法加载检查模块：${detail}`)
  }
}

export async function cmdCheck(ctx, sub, BUILTIN_CHECKS) {
  // 内置检查（bin 特判路由到 core，不经过 scripts/ 目录）：
  // `decisions`、T-12 的 `experiments`、任务格式门禁 `tasks`，以及描述台账 `description`。
  if (sub === 'decisions') return runCheckDecisions(ctx)
  if (sub === 'experiments') return runCheckExperiments(ctx)
  if (sub === 'tasks') return runCheckTasks(ctx)
  if (sub === 'description') return runCheckDescription(ctx)
  const checks = await loadChecks()
  const names = checks.CHECKS.map((entry) => entry.name)
  // usage 与未知检查提示共用完整目录（脚本检查 + 内置检查），不再漏列内置项。
  const listed = [...new Set([...names, ...BUILTIN_CHECKS.map((entry) => entry.name)])]
  const { flags } = ctx

  if (!sub) {
    throw new CliError('usage', `用法: flow check <list|${listed.join('|')}> [options]`)
  }

  if (sub === 'list') {
    const items = [...checks.listChecks(), ...BUILTIN_CHECKS]
    if (!ctx.json) {
      out('机械检查（脚本相对包根路径；只读，不写 .agents/flow；内置项注明 core 实现）')
      out('')
      items.forEach((item, index) => {
        if (index > 0) out('')
        out(`${item.name}  [${item.interpreter}]  ${item.description}`)
        out(`  脚本  ${item.script}`)
        out(`  用法  flow check ${item.name} ${item.args}`)
      })
    }
    return { checks: items }
  }

  // 本地预检：未知检查名在这里就按完整目录（含 decisions）报错，
  // 不落到 checks.buildInvocation 的漏列消息（那会漏掉内置项）。
  if (!listed.includes(sub)) {
    throw new CliError('usage', `未知检查 "${sub}"（可用 ${listed.join('|')}）`)
  }

  const timeoutSeconds = readPositiveInteger(
    flags,
    'timeout',
    '--timeout 需要正整数秒（单次检查的超时，默认 120）',
  )
  const threshold = readInteger(flags, 'threshold')

  const result = await checks.runCheck(sub, {
    root: ctx.root,
    allows: ctx.allows,
    marker: readString(flags, 'marker'),
    threshold,
    file: readString(flags, 'file'),
    type: readString(flags, 'type'),
    timeoutSeconds,
    passthrough: !ctx.json,
  })
  return result
}

/**
 * `flow check decisions`: open + blocking decisions whose affects match a staged
 * file fail the check. Read-only; the only `check` implementation routed to
 * core instead of `lib/checks.mjs` (which stays core-free).
 */
export function runCheckDecisions(ctx) {
  const { core } = ctx
  const loaded = core.loadContract(ctx.root)
  collectWarnings(loaded.warnings)
  const started = Date.now()
  const result = core.checkDecisions(ctx.root, loaded.contract)
  const durationMs = Date.now() - started
  const lines = []
  if (result.failed.length === 0) {
    lines.push(`✓ decisions：open ${result.open} · blocking ${result.blocking} · 暂存 ${result.staged.length} 个文件`)
  } else {
    for (const item of result.failed) {
      lines.push(`✗ ${item.id} 阻塞 ${item.blocks.join(',')}：affects 命中 ${item.matched.join(', ')}`)
    }
    const first = result.failed[0]
    try {
      const record = core.getDecision(ctx.root, loaded.contract, first.id)
      const options = Array.isArray(record.options) ? record.options.map((option) => option.id) : []
      const choice =
        typeof record.recommendation === 'string' && record.recommendation !== ''
          ? record.recommendation
          : typeof record.default === 'string' && record.default !== ''
            ? record.default
            : (options[0] ?? '')
      if (choice !== '') lines.push(`先回答：flow decision answer ${first.id} --choice ${choice}`)
    } catch {
      // 提示是尽力而为，读不到就不打印
    }
  }
  const stdout = lines.join('\n')
  if (!ctx.json) {
    for (const line of lines) out(line)
  }
  if (result.failed.length === 0) {
    return { check: 'decisions', exitCode: 0, stdout, stderr: '', durationMs, open: result.open, blocking: result.blocking, failed: [] }
  }
  const error = new Error('检查未通过：decisions（阻塞决策命中暂存文件）')
  error.code = 'check-failed'
  error.silent = true
  error.payload = {
    check: 'decisions',
    exitCode: 1,
    stdout,
    stderr: '',
    durationMs,
    open: result.open,
    blocking: result.blocking,
    failed: result.failed,
  }
  throw error
}

/**
 * `flow check experiments`: read-only; `experiments.enabled=false` skips (exit 0)
 * and prints why. Failures exit 1 with `failed[]`; advisory warnings never block.
 */
export function runCheckExperiments(ctx) {
  const { core } = ctx
  const loaded = core.loadContract(ctx.root)
  collectWarnings(loaded.warnings)
  const started = Date.now()
  const enabled = loaded.contract?.experiments?.enabled === true
  const result = core.checkExperiments(ctx.root, loaded.contract)
  const durationMs = Date.now() - started
  const lines = []
  if (enabled === false) {
    lines.push('✓ experiments：实验功能未开启（experiments.enabled=false），跳过')
  } else if (result.failed.length === 0) {
    lines.push(`✓ experiments：checked ${result.checked} · legacy ${result.legacy}`)
  } else {
    for (const item of result.failed) lines.push(`✗ ${item.id} ${item.rule}：${item.message}`)
  }
  for (const warning of Array.isArray(result.warnings) ? result.warnings : []) {
    lines.push(`! ${warning.id} ${warning.rule}：${warning.message}`)
  }
  const stdout = lines.join('\n')
  if (!ctx.json) {
    for (const line of lines) out(line)
  }
  if (enabled === false || result.failed.length === 0) {
    return {
      check: 'experiments',
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs,
      enabled,
      checked: result.checked,
      legacy: result.legacy,
      failed: [],
      warnings: result.warnings,
    }
  }
  const error = new Error('检查未通过：experiments（实验分流未闭环）')
  error.code = 'check-failed'
  error.silent = true
  error.payload = {
    check: 'experiments',
    exitCode: 1,
    stdout,
    stderr: '',
    durationMs,
    enabled,
    checked: result.checked,
    legacy: result.legacy,
    failed: result.failed,
    warnings: result.warnings,
  }
  throw error
}

/**
 * `flow check tasks`: legacy task-format gate. Read-only (`fix: false`, no lock,
 * no write); issues exit 1, a malformed `--type-map` exits 2, and the type is
 * never guessed — a missing `type` stays an issue until the map supplies one.
 */
export function runCheckTasks(ctx) {
  const { core } = ctx
  const loaded = core.loadContract(ctx.root)
  collectWarnings(loaded.warnings)
  // P1-1（review-core）：未初始化的 root 必须走 usage(exit 2)，与 CONTRACT §6.2 及兄弟检查
  // `check decisions`/`check experiments` 一致。`normalizeTaskFormat({fix:false})` 对空目录
  // 返回 `{ok:true, issues:[]}`，若不先拦，门禁会把"根本没台账"报成"台账很干净"——假绿。
  core.assertInitialized(ctx.root)
  const mapPath = readString(ctx.flags, 'type-map')
  const typeById = mapPath === undefined ? {} : loadTypeMap(ctx.root, mapPath)
  if (mapPath !== undefined) warnTypeMapExtras(core, ctx.root, loaded.contract, typeById)
  const started = Date.now()
  const result = core.normalizeTaskFormat(ctx.root, loaded.contract, { fix: false, typeById })
  const durationMs = Date.now() - started
  // D6 map diagnostics + `unreadable:` land in the core log; surface them now so
  // they reach the envelope even on the check-failed path.
  drainCoreWarnings()
  const ratio = (kind) => result.issues.filter((item) => item.kind === kind).length
  const counts = { 'legacy-goal': ratio('legacy-goal'), 'missing-type': ratio('missing-type') }
  const typeMap = mapPath ?? null
  const lines = []
  if (result.ok) {
    lines.push(`✓ tasks：legacy-goal 0 · missing-type 0${mapPath === undefined ? '' : ` · type-map ${mapPath}`}`)
  } else {
    for (const item of result.issues) lines.push(`✗ ${item.id} [${item.kind}] ${item.suggestion}`)
    lines.push(`合计 ${result.issues.length} 条：legacy-goal ${counts['legacy-goal']} · missing-type ${counts['missing-type']}`)
    if (counts['missing-type'] > 0) {
      lines.push('先确认 type：flow task normalize --type-map <file.json>（check tasks 只读，不会替你猜 type）')
    } else {
      lines.push('可以先归一：flow task normalize --dry-run 复查，再 flow task normalize')
    }
    // 给了 map 但记录仍在盘上缺 type：map 只是被校验通过，写盘要另跑 task normalize。
    if (mapPath !== undefined) {
      lines.push(`--type-map ${mapPath} 已校验（合法 type），但 check 不写盘；跑 flow task normalize --type-map ${mapPath} 才会真正补 type`)
    }
  }
  const stdout = lines.join('\n')
  if (!ctx.json) {
    for (const line of lines) out(line)
  }
  if (result.ok) {
    return { check: 'tasks', exitCode: 0, stdout, stderr: '', durationMs, ok: true, counts, issues: [], typeMap }
  }
  const error = new Error('检查未通过：tasks（旧任务记录未归一）')
  error.code = 'check-failed'
  error.silent = true
  error.payload = {
    check: 'tasks',
    exitCode: 1,
    stdout,
    stderr: '',
    durationMs,
    ok: false,
    counts,
    issues: result.issues,
    typeMap,
  }
  throw error
}

/**
 * `flow check description`：描述台账漂移检查（spec §6/§9）。只读；`enforce=auto`
 * 且台账还没建立时通过（并把「未建立描述，跳过」写进 stdout 与 warnings）。
 * 失败逐行给 `kind path[:module] — detail`，末行是汇总后的修复命令。
 */
export function runCheckDescription(ctx) {
  const { core } = ctx
  const loaded = core.loadContract(ctx.root)
  collectWarnings(loaded.warnings)
  // 未初始化的 root 必须走 usage（check 族映射为 exit 2），不能把「没有台账」
  // 报告成「台账很干净」——与 runCheckTasks 同一条防假绿纪律。
  core.assertInitialized(ctx.root)
  const taskId = readString(ctx.flags, 'task')
  const strict = ctx.flags['strict'] === true
  const started = Date.now()
  const result = core.checkDescription(ctx.root, loaded.contract, {
    ...(taskId === undefined ? {} : { taskId }),
    strict,
  })
  const durationMs = Date.now() - started
  // core 侧 warning（如 git 不可用、扫描跳过）也要进信封。
  drainCoreWarnings()
  const counts = result.counts
  const lines = []
  const skip = result.warnings.find(
    (item) => item.kind === 'description-skipped' || item.kind === 'description-disabled',
  )
  if (result.ok) {
    if (skip !== undefined) {
      lines.push(`✓ description：${skip.detail}（mode ${result.mode}${skip.hint === '' ? '' : `；先跑 ${skip.hint}`}）`)
    } else {
      lines.push(
        `✓ description：文件 ${counts.files} · 模块 ${counts.modules} · 缺语义 ${counts.missingSemantics} · 计划 ${counts.plans}（mode ${result.mode}${strict ? ' · --strict' : ''}）`,
      )
    }
    for (const warning of result.warnings) {
      if (warning === skip) continue
      lines.push(`! ${warning.kind} ${warning.path} — ${warning.detail}`)
    }
  } else {
    for (const item of result.failed) {
      lines.push(`✗ ${item.kind} ${item.path}${item.module === undefined ? '' : `:${item.module}`} — ${item.detail}`)
    }
    const hints = [...new Set(result.failed.map((item) => item.hint).filter((hint) => hint !== ''))]
    lines.push(`修复：${hints.join('；')}`)
  }
  const stdout = lines.join('\n')
  if (!ctx.json) {
    for (const line of lines) out(line)
  }
  const payload = {
    check: 'description',
    exitCode: result.ok ? 0 : 1,
    stdout,
    stderr: '',
    durationMs,
    mode: result.mode,
    counts,
    failed: result.failed,
    warnings: result.warnings,
  }
  if (result.ok) return payload
  const error = new Error('检查未通过：description（描述台账漂移）')
  error.code = 'check-failed'
  error.silent = true
  error.payload = payload
  throw error
}
