#!/usr/bin/env node
// 模块写域哨兵（2026-11-08，整体框架会话）：让并行会话在动手前就知道「哪些文件归我」。
//
// 为什么需要它（本轮真实问题）：
//   - `lib/core.mjs`（5k 行）、`index.js`（3.2k 行）、`client.js`（4.2k 行）、`CONTRACT.md`
//     （190 KB）同时被任务 / 决策 / 心跳 / 描述几个会话修改，没有任何机械边界，
//     冲突只能靠人记；
//   - 项目已有的 `t-20261107-module-boundaries` 只守「依赖无环 / 不 import core」，
//     `t-20261107-module-map-drift` 只守「CONTRACT §1.1 覆盖 lib 文件」——都不回答
//     「这个改动该不该由本模块来写」。
//
// 单一真源是 `docs/module-domain.json`：
//   - `owns`   独占写域（精确路径或 `dir/` 前缀）；
//   - `shared` 共享写域（其他模块可以改，但只能改 `sections` 登记的区段）；
//   - `tests`  测试归属（测试跟着被测模块走，不跟着目录走）。
//
// 用法：
//   node scripts/module-domain.mjs verify                     # 数据完整性（CI/gate 用）
//   node scripts/module-domain.mjs matrix                     # 打印模块矩阵
//   node scripts/module-domain.mjs check --module tasks       # 按 git 改动判断是否越界
//   node scripts/module-domain.mjs check --module tasks --files lib/desc.mjs
//   node scripts/module-domain.mjs check --module framework --stdin   # 从 stdin 读路径
//
// 退出码：0 通过；1 越界或数据不完整；2 用法/环境错误。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DATA_FILE = path.join(ROOT, 'docs', 'module-domain.json')

/** 扫描文件时跳过的目录 / 文件（不是模块产物，或属于运行时数据）。 */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.dsh', '.dsh-ops', '.selftest', '.github'])
const IGNORED_FILES = new Set(['icon.svg', 'LICENSE', 'dsh-desktop.log', 'package-lock.json'])
/** 不属于任何模块的路径前缀（台账数据 / 会话工作目录 / 构建产物）：check 时直接跳过。 */
const NON_MODULE_PREFIXES = ['.dsh/', '.dsh-ops/', '.selftest/', '.github/', 'node_modules/']

const die = (message, code = 2) => {
  process.stderr.write(`module-domain: ${message}\n`)
  process.exit(code)
}

function loadData() {
  let raw
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8')
  } catch (error) {
    die(`读不到 ${path.relative(ROOT, DATA_FILE)}：${error.message}`)
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    die(`${path.relative(ROOT, DATA_FILE)} 不是合法 JSON：${error.message}`)
  }
  if (data === null || typeof data !== 'object' || data.schema !== 1) {
    die('module-domain.json 必须是 schema 1 对象')
  }
  return data
}

/** 仓库相对 POSIX 路径。 */
const rel = (absolute) => path.relative(ROOT, absolute).split(path.sep).join('/')

/** 递归列出一个目录下的普通文件（跳过 IGNORED_DIRS）。 */
function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      walk(absolute, out)
      continue
    }
    if (entry.isFile() && IGNORED_FILES.has(entry.name) === false) out.push(rel(absolute))
  }
  return out
}

/** 实际参与模块归属的文件集合（源码 / 测试 / 数据 / 文档 / 技能）。 */
function actualFiles() {
  const files = [
    ...walk(path.join(ROOT, 'lib')),
    ...walk(path.join(ROOT, 'bin')),
    ...walk(path.join(ROOT, 'test')),
    ...walk(path.join(ROOT, 'scripts')),
    ...walk(path.join(ROOT, 'locale')),
    ...walk(path.join(ROOT, 'skills')),
    ...walk(path.join(ROOT, 'docs')),
  ]
  for (const name of fs.readdirSync(ROOT)) {
    if (name.endsWith('.js') || name === 'CONTRACT.md' || name === 'README.md') files.push(name)
    if (['dsh-plugin.json', 'cordis.patch.yml', 'package.json'].includes(name)) files.push(name)
  }
  return [...new Set(files)].sort()
}

/** 一个 `owns` 条目是精确文件还是目录前缀。 */
const isDirEntry = (entry) => entry.endsWith('/')
/** 精确路径或目录前缀匹配。 */
const matches = (entry, file) => (isDirEntry(entry) ? file === entry.slice(0, -1) || file.startsWith(entry) : file === entry)
/** 匹配一段 owns 列表，返回命中的最具体条目（目录前缀也算）。 */
function matchOwned(owns, file) {
  const hits = (Array.isArray(owns) ? owns : []).filter((entry) => matches(entry, file))
  hits.sort((a, b) => b.length - a.length)
  return hits[0]
}

/** 模块清单（保持 JSON 顺序）。 */
const moduleNames = (data) => Object.keys(data.modules)

/** 每个文件的归属：{ owner, sharedBy }。 */
function ownershipIndex(data) {
  const index = new Map()
  for (const name of moduleNames(data)) {
    const mod = data.modules[name]
    for (const file of actualFiles()) {
      const owned = matchOwned(mod.owns, file) !== undefined || (mod.tests ?? []).includes(file)
      if (owned) {
        const current = index.get(file) ?? { owner: null, sharedBy: [] }
        if (current.owner !== null && current.owner !== name) {
          current.owner = `${current.owner}|${name}`
        } else {
          current.owner = name
        }
        index.set(file, current)
      }
      if (Array.isArray(mod.shared) && mod.shared.some((entry) => matches(entry, file))) {
        const current = index.get(file) ?? { owner: null, sharedBy: [] }
        if (current.sharedBy.includes(name) === false) current.sharedBy.push(name)
        index.set(file, current)
      }
    }
  }
  return index
}

// ------------------------------------------------------------------ verify
function verify(fileArg) {
  const data = loadData()
  const problems = []
  const files = fileArg !== undefined ? [fileArg] : actualFiles()
  const index = ownershipIndex(data)

  // ① 每个文件恰好一个 owns
  for (const file of files) {
    const entry = index.get(file)
    if (entry === undefined || entry.owner === null) {
      problems.push(`未归属：${file}（没有任何模块的 owns 匹配它）`)
      continue
    }
    if (entry.owner.includes('|')) problems.push(`重复归属：${file} → ${entry.owner}`)
  }

  // ② owns 里没有幽灵文件（目录条目除外）
  for (const name of moduleNames(data)) {
    for (const entry of data.modules[name].owns ?? []) {
      if (isDirEntry(entry)) {
        if (fs.existsSync(path.join(ROOT, entry)) === false) problems.push(`幽灵目录：${name} owns "${entry}"`)
        continue
      }
      if (fs.existsSync(path.join(ROOT, entry)) === false) problems.push(`幽灵文件：${name} owns "${entry}"`)
    }
    for (const entry of data.modules[name].shared ?? []) {
      if (fs.existsSync(path.join(ROOT, entry)) === false) problems.push(`幽灵共享：${name} shared "${entry}"`)
    }
    for (const test of data.modules[name].tests ?? []) {
      if (fs.existsSync(path.join(ROOT, test)) === false) problems.push(`幽灵测试：${name} tests "${test}"`)
    }
  }

  // ③ 跨模块 owns/shared 不允许重叠：一个文件最多被 owned 一次、shared 多次没问题
  for (const [file, entry] of index) {
    if (entry.owner !== null && entry.owner.includes('|') === false) {
      if (entry.sharedBy.includes(entry.owner)) {
        problems.push(`自相矛盾：${file} 既是 ${entry.owner} 的 owns 又被它自己 shared`)
      }
    }
  }

  // ④ sections 锚点存在、唯一、顺序正确
  for (const [file, sections] of Object.entries(data.sections ?? {})) {
    const absolute = path.join(ROOT, file)
    if (fs.existsSync(absolute) === false) {
      problems.push(`sections 指向不存在的文件：${file}`)
      continue
    }
    const lines = fs.readFileSync(absolute, 'utf8').split('\n')
    let last = -1
    for (const [key, section] of Object.entries(sections)) {
      if (section === null || typeof section !== 'object') {
        problems.push(`sections/${file}/${key} 必须是 {from,to}`)
        continue
      }
      const from = typeof section.from === 'string' ? section.from.trim() : ''
      if (from === '') {
        problems.push(`sections/${file}/${key} 缺 from 锚点`)
        continue
      }
      const positions = lines.reduce((acc, line, i) => (line.trim() === from ? acc.concat(i) : acc), [])
      if (positions.length !== 1) {
        problems.push(`sections/${file}/${key} 的 from 锚点出现 ${positions.length} 次（必须恰好 1 次）`)
        continue
      }
      if (positions[0] <= last) problems.push(`sections/${file}/${key} 的 from 锚点不在前一段之后（顺序漂移）`)
      last = positions[0]
      if (section.to !== null && section.to !== undefined) {
        const to = typeof section.to === 'string' ? section.to.trim() : ''
        const toPositions = lines.reduce((acc, line, i) => (line.trim() === to ? acc.concat(i) : acc), [])
        if (toPositions.length !== 1) problems.push(`sections/${file}/${key} 的 to 锚点出现 ${toPositions.length} 次`)
        else if (toPositions[0] <= positions[0]) problems.push(`sections/${file}/${key} 的 to 不在 from 之后`)
      }
    }
  }

  // ⑤ 每个 shared 文件都必须有 owns 归属，且 section 名在 sections 里存在
  for (const name of moduleNames(data)) {
    const mod = data.modules[name]
    for (const entry of mod.shared ?? []) {
      const absolute = path.join(ROOT, entry)
      if (fs.existsSync(absolute) === false) continue
      const indexEntry = index.get(entry)
      if (indexEntry === undefined || indexEntry.owner === null) {
        problems.push(`共享文件没有 owns：${name} shared "${entry}"，但没有任何模块 owns 它`)
      }
      const refs = (mod.sections ?? {})[entry] ?? []
      const known = Object.keys(data.sections?.[entry] ?? {})
      for (const ref of refs) {
        if (known.includes(ref) === false) problems.push(`模块 ${name} 引用了未定义的区段：${entry} → "${ref}"`)
      }
    }
  }

  if (problems.length > 0) {
    process.stderr.write(`module-domain verify：${problems.length} 个问题\n`)
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
    return 1
  }
  process.stdout.write(`module-domain verify：OK（${moduleNames(data).length} 个模块，${files.length} 个文件）\n`)
  return 0
}

// ------------------------------------------------------------------- check
function changedFiles() {
  const result = spawnSync('git', ['status', '--porcelain', '-uall'], { encoding: 'utf8', cwd: ROOT })
  if (result.error) die(`git 不可用：${result.error.message}`)
  if (result.status !== 0) die(`git status 失败：${(result.stderr || '').trim()}`)
  const files = []
  for (const line of result.stdout.split('\n')) {
    const text = line.trimEnd()
    if (text === '') continue
    // porcelain v1: XY <path>；重命名行是 "XY old -> new"
    const body = text.slice(3)
    const target = body.includes(' -> ') ? body.slice(body.indexOf(' -> ') + 4) : body
    if (NON_MODULE_PREFIXES.some((prefix) => target === prefix || target.startsWith(prefix))) continue
    files.push(target)
  }
  return files
}

function classify(data, moduleName, files) {
  const mod = data.modules[moduleName]
  if (mod === undefined) die(`未知模块：${moduleName}（可用：${moduleNames(data).join(', ')}）`)
  const rows = []
  for (const file of files) {
    if (matchOwned(mod.owns, file) !== undefined || (mod.tests ?? []).includes(file)) {
      rows.push({ file, verdict: 'owned' })
      continue
    }
    const shared = (mod.shared ?? []).some((entry) => matches(entry, file))
    if (shared) {
      const refs = (mod.sections ?? {})[file] ?? []
      rows.push({ file, verdict: 'shared', sections: refs })
      continue
    }
    const other = moduleNames(data).find((name) => matchOwned(data.modules[name].owns, file) !== undefined)
    rows.push({ file, verdict: 'foreign', owner: other ?? '(无)' })
  }
  return rows
}

function check(data, moduleName, files) {
  const rows = classify(data, moduleName, files)
  const foreign = rows.filter((row) => row.verdict === 'foreign')
  for (const row of rows) {
    if (row.verdict === 'owned') process.stdout.write(`  owned   ${row.file}\n`)
    else if (row.verdict === 'shared') {
      const sections = row.sections.length > 0 ? `（只可改区段：${row.sections.join(', ')}）` : '（未登记区段，先改边界）'
      process.stdout.write(`  shared  ${row.file} ${sections}\n`)
    } else process.stdout.write(`  FOREIGN ${row.file} → 属于 ${row.owner}\n`)
  }
  if (foreign.length > 0) {
    process.stderr.write(`module-domain check：${foreign.length} 个越界文件（模块 ${moduleName}）\n`)
    return 1
  }
  process.stdout.write(`module-domain check：OK（模块 ${moduleName}，${rows.length} 个文件）\n`)
  return 0
}

// ------------------------------------------------------------------ matrix
function matrix(data) {
  const rows = []
  for (const name of moduleNames(data)) {
    const mod = data.modules[name]
    rows.push({
      module: name,
      title: mod.title,
      owns: (mod.owns ?? []).length,
      shared: (mod.shared ?? []).length,
      tests: (mod.tests ?? []).length,
    })
  }
  const width = Math.max(...rows.map((row) => row.module.length), 6)
  process.stdout.write(`${'模块'.padEnd(width)}  独占  共享  测试  职责\n`)
  for (const row of rows) {
    process.stdout.write(
      `${row.module.padEnd(width)}  ${String(row.owns).padStart(3)}  ${String(row.shared).padStart(4)}  ${String(row.tests).padStart(4)}  ${row.title}\n`,
    )
  }
  return 0
}

// -------------------------------------------------------------------- main
function main(argv) {
  const command = argv[0]
  if (command === 'verify') return verify(argv[1])
  if (command === 'matrix') return matrix(loadData())
  if (command === 'check') {
    const data = loadData()
    const moduleFlag = argv.indexOf('--module')
    if (moduleFlag === -1 || argv[moduleFlag + 1] === undefined) die('check 需要 --module <name>')
    const moduleName = argv[moduleFlag + 1]
    let files
    if (argv.includes('--stdin')) {
      files = fs
        .readFileSync(0, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    } else {
      const filesFlag = argv.indexOf('--files')
      files = filesFlag !== -1 ? (argv[filesFlag + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : changedFiles()
    }
    if (files.length === 0) {
      process.stdout.write(`module-domain check：没有待检查的改动（模块 ${moduleName}）\n`)
      return 0
    }
    return check(data, moduleName, files)
  }
  die('用法：module-domain.mjs verify | matrix | check --module <name> [--files a,b | --stdin]')
  return 2
}

process.exit(main(process.argv.slice(2)))
