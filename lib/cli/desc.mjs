// 描述台账命令实现（自 bin/flow.mjs 原样搬出）
//
// `flow desc *`。

import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { CliError, clip, collectWarnings, fmtTime, loadContractFor, out, pad, readJsonValue, readString, requireString, table, textWidth } from './shared.mjs'

/**
 * `description.enforce`/`enabled` 的展示值。契约层把 `enforce` 定为 `string`
 * （spec §1），未知值由 core 静默降级为 `auto`；这里用同一份
 * `DESCRIPTION_ENFORCE_MODES` 归一，避免 status 展示一个 core 根本不认的模式。
 */
export function descModeOf(core, contract) {
  const config =
    contract !== null && contract !== undefined && typeof contract.description === 'object' && contract.description !== null
      ? contract.description
      : {}
  const raw = typeof config.enforce === 'string' ? config.enforce.trim() : ''
  return {
    enabled: config.enabled !== false,
    enforce: Array.isArray(core.DESCRIPTION_ENFORCE_MODES) && core.DESCRIPTION_ENFORCE_MODES.includes(raw) ? raw : 'auto',
  }
}

/** `--out` / `description.render` 的 containment：路径必须落在项目根内。 */
export function descInsideRoot(root, value) {
  const base = path.resolve(root)
  const absolute = path.resolve(base, value)
  return { absolute, inside: absolute === base || absolute.startsWith(base + path.sep) }
}

/** 人类输出里的根相对 POSIX 路径（Windows 反斜杠也归一成 `/`）。 */
export function descRelativeLabel(root, absolute) {
  return path.relative(path.resolve(root), absolute).split(path.sep).join('/')
}

/** 描述文件树（`flow desc show` 无 --path）：目录 → 文件（模块数）。 */
export function descTreeLines(records) {
  const groups = new Map()
  for (const record of records) {
    const file = typeof record.path === 'string' ? record.path : ''
    const cut = file.lastIndexOf('/')
    const dir = cut < 0 ? '.' : file.slice(0, cut)
    const name = cut < 0 ? file : file.slice(cut + 1)
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir).push({ name, modules: Array.isArray(record.modules) ? record.modules.length : 0 })
  }
  const lines = []
  for (const dir of [...groups.keys()].sort()) {
    if (dir !== '.') lines.push(`${dir}/`)
    const entries = groups.get(dir).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    const width = Math.max(...entries.map((entry) => textWidth(entry.name)))
    for (const entry of entries) {
      lines.push(`${dir === '.' ? '' : '  '}${pad(entry.name, width)}  ${entry.modules} 模块`)
    }
  }
  return lines
}

/** 计划的一句话形状（人类输出用）。 */
export function descPlanShape(plan) {
  if (plan.noSemanticChange === true) return `noSemanticChange · ${plan.reason}`
  const files = Array.isArray(plan.files) ? plan.files : []
  const modules = files.reduce((sum, file) => sum + (Array.isArray(file.modules) ? file.modules.length : 0), 0)
  return `${files.length} 文件 · ${modules} 模块`
}

/** 计划的人类可读展开（`flow desc plan --show`）。 */
export function printDescPlan(plan) {
  const base = plan.base !== null && typeof plan.base === 'object' ? plan.base : {}
  out(`计划 ${plan.task}  ${plan.status}  base ${base.commit ?? 'null'}${base.clean === false ? '（工作树不干净）' : ''}`)
  out(
    `更新 ${fmtTime(plan.updated_at)} · history ${Array.isArray(plan.history) ? plan.history.length : 0} 条` +
      `${typeof plan.implemented_at === 'string' && plan.implemented_at !== '' ? ` · applied ${fmtTime(plan.implemented_at)}` : ''}`,
  )
  if (plan.noSemanticChange === true) {
    out(`无语义变更：${plan.reason}`)
    return
  }
  const files = Array.isArray(plan.files) ? plan.files : []
  if (files.length === 0) out('（计划没有文件）')
  for (const file of files) {
    out(`  ${file.op}  ${file.path}${typeof file.semantics === 'string' && file.semantics !== '' ? `  ${clip(file.semantics, 60)}` : ''}`)
    for (const module of Array.isArray(file.modules) ? file.modules : []) {
      const members = Array.isArray(module.members) ? `  [${module.members.join('、')}]` : ''
      out(
        `    ${module.op ?? 'change'}  ${module.id}${typeof module.semantics === 'string' && module.semantics !== '' ? `  ${clip(module.semantics, 50)}` : ''}${members}`,
      )
    }
  }
}

/**
 * `lib/desc.mjs` 的懒加载：**只给 `desc plan --template` 的源码扫描用**。
 * 台账的读/写/校验仍全部经 core；模板是分析阶段的脚手架，扫描是纯读。
 */
export async function loadDescModel() {
  try {
    return await import(new URL('../desc.mjs', import.meta.url).href)
  } catch (error) {
    throw new CliError('io', `无法加载描述模型（lib/desc.mjs）：${error?.message || String(error)}`)
  }
}

/**
 * `flow desc plan --template <src>` 的骨架：有记录时用记录里的文件/模块（语义预填
 * 当前值，便于只改该改的）；没有记录时扫源码，按 build 的种子模块给**空语义**骨架。
 * 只打印，不写盘。
 */
export async function descPlanTemplate(core, root, contract, src) {
  let record = null
  try {
    record = core.getDescriptionFile(root, contract, src)
  } catch (error) {
    if (error?.code !== 'not-found') throw error
  }
  if (record !== null) {
    return {
      files: [
        {
          path: record.path,
          op: 'change',
          semantics: typeof record.semantics === 'string' ? record.semantics : '',
          modules: (Array.isArray(record.modules) ? record.modules : []).map((module) => ({
            id: module.id,
            op: 'change',
            semantics: typeof module.semantics === 'string' ? module.semantics : '',
          })),
        },
      ],
    }
  }
  const desc = await loadDescModel()
  const maxScanBytes = Number(contract?.description?.maxScanBytes)
  const scanned = desc.scanSourceAt(root, src, {
    ...(Number.isInteger(maxScanBytes) && maxScanBytes > 0 ? { maxScanBytes } : {}),
  })
  if (typeof scanned.skipped === 'string') {
    throw new CliError('usage', `无法扫描 ${src}（${scanned.skipped}）；--template 只接受项目内的源文件`)
  }
  const created = desc.createRecord(scanned)
  return {
    files: [
      {
        path: created.path,
        op: 'add',
        semantics: '',
        modules: (Array.isArray(created.modules) ? created.modules : []).map((module) => ({
          id: module.id,
          op: 'add',
          semantics: '',
          members: Array.isArray(module.members) ? [...module.members] : [],
        })),
      },
    ],
  }
}

export async function cmdDesc(ctx, sub) {
  const { core, flags } = ctx
  if (!sub) {
    throw new CliError('usage', '用法: flow desc <status|build|show|set|plan|apply|render>')
  }
  const contract = loadContractFor(ctx, ctx.root)

  if (sub === 'status') {
    core.assertInitialized(ctx.root)
    const project = core.readDescriptionProject(ctx.root, contract)
    const counts = core.descriptionStatus(ctx.root, contract)
    const mode = descModeOf(core, contract)
    const established = project !== null || counts.files > 0
    const data = {
      established,
      name: project !== null && typeof project.name === 'string' ? project.name : null,
      semantics: project !== null && typeof project.semantics === 'string' ? project.semantics : '',
      files: counts.files,
      modules: counts.modules,
      missingSemantics: counts.missingSemantics,
      plans: counts.plans,
      described: counts.described,
      enabled: mode.enabled,
      enforce: mode.enforce,
    }
    if (!ctx.json) {
      if (!established) {
        out('描述台账  未建立描述（先跑 flow desc build）')
      } else {
        out(`描述台账  ${data.files} 文件 · ${data.modules} 模块 · 缺语义 ${data.missingSemantics} · 计划 ${data.plans}`)
        out(`覆盖  ${data.described}/${data.files} 个文件已写语义`)
        out(`模式  enabled=${data.enabled ? 'true' : 'false'} · enforce=${data.enforce}`)
      }
    }
    return data
  }

  if (sub === 'build') {
    const dryRun = flags['dry-run'] === true
    const result = core.buildDescription(ctx.root, contract, { dryRun })
    collectWarnings(result.warnings)
    if (!ctx.json) {
      out(
        `${dryRun ? '描述预演（--dry-run，未写盘）' : '描述已同步'}：新建 ${result.created} · 更新 ${result.updated} · 未变 ${result.unchanged} · 剪枝 ${result.pruned}`,
      )
    }
    return result
  }

  if (sub === 'show') {
    core.assertInitialized(ctx.root)
    const source = readString(flags, 'path')
    const graph = readString(flags, 'graph')
    if (graph !== undefined && graph !== 'tree' && graph !== 'mermaid') {
      throw new CliError('usage', '--graph 只支持 tree | mermaid')
    }
    if (graph === 'mermaid') {
      const markdown = core.renderDescription(ctx.root, contract)
      if (markdown === null) {
        if (!ctx.json) out('（还没有描述台账；先跑 flow desc build）')
        return { graph: null }
      }
      if (!ctx.json) out(markdown)
      return { graph: markdown }
    }
    if (source !== undefined) {
      let record = null
      try {
        record = core.getDescriptionFile(ctx.root, contract, source)
      } catch (error) {
        if (error?.code !== 'not-found') throw error
      }
      if (record === null) {
        if (!ctx.json) out(`（没有 ${source} 的描述记录；先跑 flow desc build）`)
        return { path: source, record: null }
      }
      if (!ctx.json) {
        out(`${record.path}  ${record.language ?? 'unknown'}  ${record.lines ?? 0} 行  ${record.hash ?? ''}`)
        out(`语义  ${typeof record.semantics === 'string' && record.semantics !== '' ? record.semantics : '（未填写）'}`)
        const modules = Array.isArray(record.modules) ? record.modules : []
        out('')
        out(`模块（${modules.length}）`)
        if (modules.length > 0) {
          out(
            table(
              ['模块', '标题', '语义', '成员'],
              modules.map((module) => [
                module.id,
                clip(module.title ?? '-', 24),
                clip(typeof module.semantics === 'string' && module.semantics !== '' ? module.semantics : '（未填写）', 48),
                clip(Array.isArray(module.members) ? module.members.join('、') : '-', 48),
              ]),
            ),
          )
        } else {
          out('（没有模块）')
        }
        const edges = Array.isArray(record.moduleEdges) ? record.moduleEdges : []
        out('')
        out(`模块边（${edges.length}）`)
        if (edges.length > 0) {
          out(
            table(
              ['从', '到', '次数', '依据'],
              edges.map((edge) => [
                edge.from,
                edge.to,
                String(edge.count ?? 0),
                Array.isArray(edge.why) ? edge.why.join('；') : '',
              ]),
            ),
          )
        } else {
          out('（没有模块边）')
        }
      }
      return record
    }
    const records = core.listDescriptionFiles(ctx.root, contract)
    const counts = core.descriptionStatus(ctx.root, contract)
    if (!ctx.json) {
      if (records.length === 0) {
        out('（没有描述记录；先跑 flow desc build）')
      } else {
        out(`描述台账  ${counts.files} 文件 · ${counts.modules} 模块`)
        out('')
        for (const line of descTreeLines(records)) out(line)
      }
    }
    return {
      counts: { files: counts.files, modules: counts.modules },
      files: records.map((record) => ({
        path: record.path,
        modules: Array.isArray(record.modules) ? record.modules.length : 0,
      })),
    }
  }

  if (sub === 'set') {
    const inputRaw = readString(flags, 'input')
    const projectSemantics = readString(flags, 'project-semantics')
    if (inputRaw === undefined && projectSemantics === undefined) {
      throw new CliError('usage', '用法: flow desc set --input <json> | --project-semantics <text>')
    }
    if (inputRaw !== undefined && projectSemantics !== undefined) {
      throw new CliError('usage', '--input 与 --project-semantics 不能同时使用（一次只写一类语义）')
    }
    if (projectSemantics !== undefined) {
      const project = core.setDescriptionProject(ctx.root, contract, { semantics: projectSemantics })
      if (!ctx.json) out(`已更新项目语义（${project.name ?? 'project'}）`)
      return project
    }
    const patch = readJsonValue(flags, 'input', ctx.root)
    if (patch === null || typeof patch !== 'object') {
      throw new CliError('usage', '--input 需要 JSON 对象（单文件补丁）或对象数组（多文件补丁）')
    }
    const result = core.setDescriptionFile(ctx.root, contract, patch)
    if (!ctx.json) out(result.changed ? `已更新 ${result.records.length} 个文件记录` : '（没有变化）')
    return result
  }

  if (sub === 'plan') {
    core.assertInitialized(ctx.root)
    const id = requireString(
      flags,
      'id',
      '用法: flow desc plan <T-id> --template <src> | --input <json> | --show | --rebase | --no-semantic-change --reason R',
    )
    const template = readString(flags, 'template')
    const inputRaw = readString(flags, 'input')
    const show = flags['show'] === true
    const rebase = flags['rebase'] === true
    const noChange = flags['no-semantic-change'] === true
    const modes = [
      ...(template === undefined ? [] : ['--template']),
      ...(inputRaw === undefined ? [] : ['--input']),
      ...(show ? ['--show'] : []),
      ...(rebase ? ['--rebase'] : []),
      ...(noChange ? ['--no-semantic-change'] : []),
    ]
    if (modes.length === 0) {
      throw new CliError(
        'usage',
        'flow desc plan 需要一种模式：--template <src> | --input <json> | --show | --rebase | --no-semantic-change --reason R',
      )
    }
    if (modes.length > 1) {
      throw new CliError('usage', `flow desc plan 一次只能用一种模式（收到 ${modes.join('、')}）`)
    }
    if (show) {
      const plan = core.getDescriptionPlan(ctx.root, contract, id)
      if (!ctx.json) {
        if (plan === null) out('无计划（flow desc plan <T-id> --template <src>）')
        else printDescPlan(plan)
      }
      return { plan, amended: false }
    }
    if (template !== undefined) {
      const skeleton = await descPlanTemplate(core, ctx.root, contract, template)
      if (!ctx.json) out(JSON.stringify(skeleton, null, 2))
      return skeleton
    }
    if (rebase) {
      const plan = core.getDescriptionPlan(ctx.root, contract, id)
      if (plan === null) {
        throw new CliError('usage', `任务 ${id} 还没有计划；先 flow desc plan ${id} --input <json>`)
      }
      // `setDescriptionPlan` 每次提交都会经 `planBaseOf` 按当前 HEAD/工作树重算 base；
      // implemented 计划带 `rebase:true` 时只刷新 base（语义与 implemented_at 不变）。
      const implemented = plan.status === 'implemented'
      const input =
        plan.noSemanticChange === true
          ? { noSemanticChange: true, reason: plan.reason }
          : { files: plan.files }
      const result = core.setDescriptionPlan(ctx.root, contract, id, input, { rebase: true })
      const note = implemented
        ? '计划已 implemented，--rebase 只刷新 base（语义与 implemented_at 不变）'
        : 'setDescriptionPlan 每次提交都会重算 base；本次提交已按当前 HEAD/工作树刷新'
      if (!ctx.json) out(note)
      return { ...result, rebased: true, note }
    }
    if (noChange) {
      const reason = readString(flags, 'reason')
      if (reason === undefined || reason.trim() === '') {
        throw new CliError('usage', '--no-semantic-change 需要 --reason <text>（说明为什么没有语义变更）')
      }
      const result = core.setDescriptionPlan(ctx.root, contract, id, { noSemanticChange: true, reason })
      if (!ctx.json) out(`已${result.amended ? '修订' : '创建'}计划 ${id}：无语义变更（${result.plan.reason}）`)
      return result
    }
    const input = readJsonValue(flags, 'input', ctx.root)
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new CliError('usage', '--input 需要一个 JSON 对象（计划输入，含 files 或 noSemanticChange）')
    }
    const result = core.setDescriptionPlan(ctx.root, contract, id, input)
    if (!ctx.json) out(`已${result.amended ? '修订' : '创建'}计划 ${id}（${result.plan.status} · ${descPlanShape(result.plan)}）`)
    return result
  }

  if (sub === 'apply') {
    core.assertInitialized(ctx.root)
    const id = requireString(flags, 'id', '用法: flow desc apply <T-id> [--dry-run]')
    const dryRun = flags['dry-run'] === true
    const result = core.applyDescriptionPlan(ctx.root, contract, id, { dryRun })
    collectWarnings(result.warnings)
    if (!ctx.json) {
      if (result.applied === false) out(`计划 ${id} 已是 implemented（幂等，未重复应用）`)
      else out(`${dryRun ? '将应用' : '已应用'}计划 ${id}（${descPlanShape(result.plan)}）`)
    }
    return result
  }

  if (sub === 'render') {
    core.assertInitialized(ctx.root)
    const markdown = core.renderDescription(ctx.root, contract)
    if (markdown === null) {
      throw new CliError('usage', '还没有描述台账（先跑 flow desc build），再 flow desc render')
    }
    const data = { checked: null }
    if (flags['check'] === true) {
      const configured = typeof contract?.description?.render === 'string' ? contract.description.render.trim() : ''
      if (configured === '') {
        if (!ctx.json) out('（description.render 未配置，--check 跳过）')
      } else {
        const target = descInsideRoot(ctx.root, configured)
        if (!target.inside) {
          throw new CliError('usage', `description.render 逃出项目根：${configured}`)
        }
        let actual = null
        try {
          actual = readFileSync(target.absolute, 'utf8')
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw new CliError('io', `读取渲染文件失败：${configured}（${error.code ?? error.message}）`)
          }
        }
        if (actual === null) {
          const error = new Error(`渲染文件不存在：${configured}（先跑 flow desc render --out ${configured}）`)
          error.code = 'check-failed'
          throw error
        }
        if (actual.replace(/\r\n/g, '\n') !== markdown) {
          const error = new Error(`渲染文件与现算内容不一致：${configured}`)
          error.code = 'check-failed'
          throw error
        }
        if (!ctx.json) out(`✓ 渲染文件与现算内容一致：${configured}`)
        data.checked = true
      }
    }
    const outPath = readString(flags, 'out')
    if (outPath !== undefined) {
      const target = descInsideRoot(ctx.root, outPath)
      if (!target.inside) {
        throw new CliError('usage', `--out 必须落在项目根内：${outPath}`)
      }
      mkdirSync(path.dirname(target.absolute), { recursive: true })
      writeFileSync(target.absolute, markdown)
      const label = descRelativeLabel(ctx.root, target.absolute)
      if (!ctx.json) out(`已写入 ${label}`)
      return { ...data, path: label, bytes: Buffer.byteLength(markdown, 'utf8') }
    }
    if (!ctx.json) out(markdown)
    return { ...data, markdown }
  }

  throw new CliError('usage', `未知子命令 desc ${sub}（可用 status|build|show|set|plan|apply|render）`)
}
