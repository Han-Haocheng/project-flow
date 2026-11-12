// T-20261108 · D4：`flow desc` 命令面与 `check description` 的 CLI 契约。
//
// 被测对象是 bin/flow.mjs 的接线：参数登记（SPEC/VALUE_FLAGS/BOOL_FLAGS）、
// 位置参数 `<T-id>`、退出码映射、以及「只读命令真的只读」。core 的存储/校验
// 语义由 t-20261108-desc-core.test.mjs 覆盖，这里只钉**通道**：
//   - status/build/show/set/plan/apply/render 的文本与 --json 形状；
//   - 用法错 1、校验错 2、check 失败 1；
//   - `flow desc plan T-xxx …` 不得退「多余的参数」；
//   - check description 在「未建立 → 绿」「建了但漂移 → 红」两端可辨；
//   - `flow status` 的描述行与 `--json.counts.description` 同口径。
//
// 全部在 os.tmpdir() 下的一次性项目里跑（真实 CLI，spawnSync）。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

// ------------------------------------------------------------------ helpers

function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-desccmd-${label}-`))
  TEMP_ROOTS.push(root)
  return root
}

function writeFile(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  return absolute
}

function freshProject(label, files = {}) {
  const root = tempRoot(label)
  const init = runCli(root, ['init', '--name', label, '--no-gates', '--json'])
  assert.equal(init.code, 0, init.stdout + init.stderr)
  for (const [relative, content] of Object.entries(files)) writeFile(root, relative, content)
  return root
}

function runCli(cwd, args) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env })
  let json = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = null
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

function addTask(root, title, extra = []) {
  const result = runCli(root, ['task', 'add', '--type', 'feat', '--title', title, ...extra, '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  return result.json.data
}

function setStage(root, id, stage) {
  const result = runCli(root, ['task', 'update', id, '--stage', stage, '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  return result.json.data
}

function descDir(root) {
  return path.join(root, '.agents', 'description')
}

function readDescRecords(root) {
  const dir = path.join(descDir(root), 'files')
  if (fs.existsSync(dir) === false) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
}

/** 目录树快照（相对路径 + 大小 + mtime），用来证明只读/预演命令零写盘。 */
function snapshotTree(dir) {
  const out = []
  const walk = (absolute, prefix) => {
    let entries
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const child = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const childAbsolute = path.join(absolute, entry.name)
      if (entry.isDirectory()) {
        out.push(`${child}/`)
        walk(childAbsolute, child)
        continue
      }
      const stat = fs.statSync(childAbsolute)
      out.push(`${child}:${stat.size}:${stat.mtimeMs}`)
    }
  }
  walk(dir, '')
  return out
}

/** 改 `flow.json` 的 `description` 成员（只用于 --check 的 render 路径夹具）。 */
function patchDescriptionConfig(root, patch) {
  const file = path.join(root, '.agents', 'flow', 'flow.json')
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'))
  contract.description = { ...(contract.description ?? {}), ...patch }
  fs.writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`)
}

const FILE_SEMANTICS = '文件语义：a 模块在夹具工程中的职责说明。'
const MODULE_SEMANTICS = '模块语义：a 片段负责的职责说明。'
const PROJECT_SEMANTICS = '项目语义：这是一个用于验证 desc 命令面的夹具工程。'

/** 给所有记录补文件/模块语义，并写项目语义（check 全绿的前置）。 */
function describeAll(root) {
  const records = readDescRecords(root)
  const patches = records.map((record) => ({
    path: record.path,
    semantics: `文件语义：${record.path} 在夹具工程中的职责说明。`,
    modules: (Array.isArray(record.modules) ? record.modules : []).map((module) => ({
      id: module.id,
      semantics: `模块语义：${module.id} 在 ${record.path} 中的职责说明。`,
    })),
  }))
  if (patches.length > 0) {
    const set = runCli(root, ['desc', 'set', '--input', JSON.stringify(patches), '--json'])
    assert.equal(set.code, 0, set.stdout + set.stderr)
  }
  const project = runCli(root, ['desc', 'set', '--project-semantics', PROJECT_SEMANTICS, '--json'])
  assert.equal(project.code, 0, project.stdout + project.stderr)
}

function buildDescriptionCli(root) {
  const result = runCli(root, ['desc', 'build', '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  return result.json.data
}

// ------------------------------------------------------------------- status

test('desc status：未建立只提示，--json 给五计数 + enforce/enabled；未初始化 root 退 1', () => {
  const root = freshProject('status')
  const text = runCli(root, ['desc', 'status'])
  assert.equal(text.code, 0, text.stdout + text.stderr)
  assert.match(text.stdout, /未建立描述/)
  assert.match(text.stdout, /flow desc build/)

  const json = runCli(root, ['desc', 'status', '--json'])
  assert.equal(json.code, 0, json.stdout + json.stderr)
  assert.equal(json.json.data.established, false)
  for (const key of ['files', 'modules', 'missingSemantics', 'plans', 'described']) {
    assert.ok(Object.hasOwn(json.json.data, key), `desc status 应给 ${key}`)
    assert.equal(json.json.data[key], 0)
  }
  assert.equal(json.json.data.enabled, true)
  assert.equal(json.json.data.enforce, 'auto')

  // 未初始化的 root：core.assertInitialized 抛 usage（不是零值台账、不是崩溃）。
  const empty = tempRoot('status-uninit')
  const uninit = runCli(empty, ['desc', 'status', '--json'])
  assert.equal(uninit.code, 1, uninit.stdout + uninit.stderr)
  assert.equal(uninit.json.error.code, 'usage')
  assert.equal(fs.existsSync(path.join(empty, '.agents')), false, '只读命令不得建 .agents')
})

// -------------------------------------------------------------------- build

test('desc build：--dry-run 零写盘；真跑建记录；再跑全部 unchanged', () => {
  const root = freshProject('build', {
    'lib/a.mjs': 'export function alpha() {}\n',
    'lib/b.mjs': 'export function beta() {}\n',
  })
  const before = snapshotTree(descDir(root))
  const dry = runCli(root, ['desc', 'build', '--dry-run', '--json'])
  assert.equal(dry.code, 0, dry.stdout + dry.stderr)
  assert.equal(dry.json.data.created, 2)
  assert.deepEqual(snapshotTree(descDir(root)), before, '--dry-run 必须零写盘')

  const first = buildDescriptionCli(root)
  assert.equal(first.created, 2)
  assert.equal(first.pruned, 0)

  const second = buildDescriptionCli(root)
  assert.equal(second.created, 0)
  assert.equal(second.updated, 0)
  assert.equal(second.unchanged, 2, '无结构变化时不重写记录')

  const status = runCli(root, ['desc', 'status', '--json'])
  assert.equal(status.json.data.established, true)
  assert.equal(status.json.data.files, 2)
  assert.equal(status.json.data.modules, 2)
  assert.equal(status.json.data.missingSemantics, 4, '两个文件缺文件语义 + 两个模块缺模块语义')
})

// ---------------------------------------------------------------------- set

test('desc set：单文件/多文件补丁、项目语义、空数组 no-op；xor 与缺记录分别退 1/2', () => {
  const root = freshProject('set', {
    'lib/a.mjs': 'export function alpha() {}\n',
    'lib/b.mjs': 'export function beta() {}\n',
  })
  buildDescriptionCli(root)
  const records = readDescRecords(root)
  const recordA = records.find((record) => record.path === 'lib/a.mjs')
  const moduleId = recordA.modules[0].id

  // 单对象 = 单文件补丁
  const single = runCli(root, [
    'desc',
    'set',
    '--input',
    JSON.stringify({
      path: 'lib/a.mjs',
      semantics: FILE_SEMANTICS,
      modules: [{ id: moduleId, semantics: MODULE_SEMANTICS }],
    }),
    '--json',
  ])
  assert.equal(single.code, 0, single.stdout + single.stderr)
  assert.equal(single.json.data.changed, true)
  assert.equal(readDescRecords(root).find((record) => record.path === 'lib/a.mjs').semantics, FILE_SEMANTICS)

  // 数组 = 多文件补丁
  const recordB = readDescRecords(root).find((record) => record.path === 'lib/b.mjs')
  const multi = runCli(root, [
    'desc',
    'set',
    '--input',
    JSON.stringify([
      { path: 'lib/b.mjs', semantics: '文件语义：b 模块的职责说明也足够长。', modules: [{ id: recordB.modules[0].id, semantics: MODULE_SEMANTICS }] },
    ]),
    '--json',
  ])
  assert.equal(multi.code, 0, multi.stdout + multi.stderr)
  assert.equal(readDescRecords(root).find((record) => record.path === 'lib/b.mjs').semantics, '文件语义：b 模块的职责说明也足够长。')

  // 空数组 = no-op（不是错误）
  const empty = runCli(root, ['desc', 'set', '--input', '[]', '--json'])
  assert.equal(empty.code, 0, empty.stdout + empty.stderr)
  assert.equal(empty.json.data.changed, false)

  // 项目语义
  const project = runCli(root, ['desc', 'set', '--project-semantics', PROJECT_SEMANTICS, '--json'])
  assert.equal(project.code, 0, project.stdout + project.stderr)
  assert.equal(project.json.data.semantics, PROJECT_SEMANTICS)
  assert.equal(runCli(root, ['desc', 'status', '--json']).json.data.semantics, PROJECT_SEMANTICS)

  // 两类语义同时写 = 用法错（1）
  const both = runCli(root, ['desc', 'set', '--input', '{}', '--project-semantics', 'x'])
  assert.equal(both.code, 1, both.stdout + both.stderr)
  // 什么都不给 = 用法错（1）
  assert.equal(runCli(root, ['desc', 'set']).code, 1)

  // 记录不存在 = 校验错（2），文案提示先 build
  writeFile(root, 'lib/late.mjs', 'export function late() {}\n')
  const missing = runCli(root, [
    'desc',
    'set',
    '--input',
    JSON.stringify({ path: 'lib/late.mjs', semantics: FILE_SEMANTICS }),
    '--json',
  ])
  assert.equal(missing.code, 2, missing.stdout + missing.stderr)
  assert.equal(missing.json.error.code, 'invalid')
  assert.match(missing.json.error.message, /flow desc build/)
})

// --------------------------------------------------------------------- plan

test('desc plan：--template 不写盘（有记录=change、无记录=扫源码 add）；--show 无计划', () => {
  const root = freshProject('template', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescriptionCli(root)
  const task = addTask(root, '模板任务', ['--stage', 'analyzing'])
  const before = snapshotTree(descDir(root))

  const template = runCli(root, ['desc', 'plan', task.id, '--template', 'lib/a.mjs', '--json'])
  assert.equal(template.code, 0, template.stdout + template.stderr)
  const skeleton = template.json.data
  assert.ok(Array.isArray(skeleton.files), '骨架必须是可直接编辑的计划输入')
  assert.equal(skeleton.files[0].path, 'lib/a.mjs')
  assert.equal(skeleton.files[0].op, 'change', '已有记录 → change')
  assert.equal(typeof skeleton.files[0].semantics, 'string')
  assert.ok(Array.isArray(skeleton.files[0].modules))
  assert.deepEqual(snapshotTree(descDir(root)), before, '--template 只打印，不写盘')

  // 无记录 → 扫源码，给带 members 的 add 骨架
  writeFile(root, 'lib/late.mjs', 'export function lateFn() {}\nexport class LateClass {}\n')
  const added = runCli(root, ['desc', 'plan', task.id, '--template', 'lib/late.mjs', '--json'])
  assert.equal(added.code, 0, added.stdout + added.stderr)
  assert.equal(added.json.data.files[0].path, 'lib/late.mjs')
  assert.equal(added.json.data.files[0].op, 'add')
  assert.equal(added.json.data.files[0].semantics, '')
  assert.ok(added.json.data.files[0].modules[0].members.includes('lateFn'))

  // --show：还没有计划时给「无计划」，不是错误
  const show = runCli(root, ['desc', 'plan', task.id, '--show'])
  assert.equal(show.code, 0, show.stdout + show.stderr)
  assert.match(show.stdout, /无计划/)
  assert.doesNotMatch(show.stderr, /多余的参数/)

  // 未知源文件是用法错，不是崩溃
  const badSource = runCli(root, ['desc', 'plan', task.id, '--template', 'lib/nope.mjs'])
  assert.equal(badSource.code, 1, badSource.stdout + badSource.stderr)
  assert.match(badSource.stderr, /无法扫描/)
})

test('desc plan：--input 建/修订、--no-semantic-change 必须 --reason、--rebase 重记 base、模式互斥', () => {
  const root = freshProject('plan', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescriptionCli(root)
  const task = addTask(root, '计划任务', ['--stage', 'analyzing'])
  const input = {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: '文件语义：这一版改后的描述足够长。' }],
  }

  const first = runCli(root, ['desc', 'plan', task.id, '--input', JSON.stringify(input), '--json'])
  assert.equal(first.code, 0, first.stdout + first.stderr)
  assert.equal(first.json.data.amended, false)
  assert.equal(first.json.data.plan.status, 'planned')
  assert.equal(first.json.data.plan.files.length, 1)

  const second = runCli(root, ['desc', 'plan', task.id, '--input', JSON.stringify(input), '--json'])
  assert.equal(second.code, 0, second.stdout + second.stderr)
  assert.equal(second.json.data.amended, true, '已有计划再写一次 = 修订')
  assert.equal(second.json.data.plan.history.length, 2, '每次修订追加一条 history')

  const shown = runCli(root, ['desc', 'plan', task.id, '--show', '--json'])
  assert.equal(shown.code, 0, shown.stdout + shown.stderr)
  assert.equal(shown.json.data.plan.files[0].path, 'lib/a.mjs')

  // --no-semantic-change 缺 --reason 是用法错（1），补上后退 0
  const noReason = runCli(root, ['desc', 'plan', task.id, '--no-semantic-change'])
  assert.equal(noReason.code, 1, noReason.stdout + noReason.stderr)
  assert.match(noReason.stderr, /--reason/)
  const noChange = runCli(root, ['desc', 'plan', task.id, '--no-semantic-change', '--reason', '只改注释', '--json'])
  assert.equal(noChange.code, 0, noChange.stdout + noChange.stderr)
  assert.equal(noChange.json.data.plan.noSemanticChange, true)

  // 一次只允许一种模式
  const both = runCli(root, ['desc', 'plan', task.id, '--input', '{}', '--show'])
  assert.equal(both.code, 1, both.stdout + both.stderr)
  // 没有模式 = 用法错
  assert.equal(runCli(root, ['desc', 'plan', task.id]).code, 1)

  // --rebase：setDescriptionPlan 每次提交都会重算 base，CLI 明说这一点后照常提交
  const rebased = runCli(root, ['desc', 'plan', task.id, '--rebase', '--json'])
  assert.equal(rebased.code, 0, rebased.stdout + rebased.stderr)
  assert.equal(rebased.json.data.rebased, true)
  assert.match(rebased.json.data.note, /base/)
  assert.equal(rebased.json.data.plan.status, 'planned')
  assert.equal(rebased.json.data.plan.history.length, 4, '修订 1 + 修订 2 + noSemanticChange + rebase')
})

// -------------------------------------------------------------------- apply

test('desc apply：non-implementing 退 2；--dry-run 零写盘；apply 幂等且语义已落盘', () => {
  const root = freshProject('apply', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescriptionCli(root)
  const task = addTask(root, '应用任务', ['--stage', 'analyzing'])
  const input = {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: '文件语义：应用之后的新描述足够长。' }],
  }
  const planned = runCli(root, ['desc', 'plan', task.id, '--input', JSON.stringify(input), '--json'])
  assert.equal(planned.code, 0, planned.stdout + planned.stderr)

  // 还没到 implementing → 校验错（2）
  const early = runCli(root, ['desc', 'apply', task.id, '--json'])
  assert.equal(early.code, 2, early.stdout + early.stderr)
  assert.equal(early.json.error.code, 'invalid')

  /* 阶段边由 core 校验：analyzing → implementing 没有直接边，先过待实现。 */
  setStage(root, task.id, 'queued-implementation')
  setStage(root, task.id, 'implementing')
  const before = snapshotTree(descDir(root))
  const dry = runCli(root, ['desc', 'apply', task.id, '--dry-run', '--json'])
  assert.equal(dry.code, 0, dry.stdout + dry.stderr)
  assert.equal(dry.json.data.applied, true)
  assert.deepEqual(snapshotTree(descDir(root)), before, '--dry-run 必须零写盘')

  const applied = runCli(root, ['desc', 'apply', task.id, '--json'])
  assert.equal(applied.code, 0, applied.stdout + applied.stderr)
  assert.equal(applied.json.data.applied, true)
  assert.equal(applied.json.data.plan.status, 'implemented')
  assert.match(
    readDescRecords(root).find((record) => record.path === 'lib/a.mjs').semantics,
    /应用之后的新描述/,
  )

  // 幂等：第二次 applied=false，且不是错误
  const again = runCli(root, ['desc', 'apply', task.id, '--json'])
  assert.equal(again.code, 0, again.stdout + again.stderr)
  assert.equal(again.json.data.applied, false)
  assert.equal(again.json.data.plan.implemented_at, applied.json.data.plan.implemented_at)
})

test('desc plan --rebase：implemented 计划只刷新 base（exit 0、语义与 implemented_at 不变）', () => {
  const root = freshProject('plan-rebase-impl', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescriptionCli(root)
  describeAll(root)
  const task = addTask(root, 'rebase 已实现', ['--stage', 'analyzing'])
  const input = {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: '文件语义：implemented 之后 rebase 不得改这一版。' }],
  }
  const planned = runCli(root, ['desc', 'plan', task.id, '--input', JSON.stringify(input), '--json'])
  assert.equal(planned.code, 0, planned.stdout + planned.stderr)
  setStage(root, task.id, 'queued-implementation')
  setStage(root, task.id, 'implementing')
  const applied = runCli(root, ['desc', 'apply', task.id, '--json'])
  assert.equal(applied.code, 0, applied.stdout + applied.stderr)
  const implementedAt = applied.json.data.plan.implemented_at
  const historyLength = applied.json.data.plan.history.length

  const rebased = runCli(root, ['desc', 'plan', task.id, '--rebase', '--json'])
  assert.equal(rebased.code, 0, rebased.stdout + rebased.stderr)
  assert.equal(rebased.json.data.rebased, true)
  assert.equal(rebased.json.data.plan.status, 'implemented')
  assert.equal(rebased.json.data.plan.implemented_at, implementedAt, 'rebase 不得改动 implemented_at')
  assert.equal(rebased.json.data.plan.history.length, historyLength + 1)
  assert.match(rebased.json.data.note, /implemented/)
  assert.equal(
    readDescRecords(root).find((record) => record.path === 'lib/a.mjs').semantics,
    input.files[0].semantics,
    'rebase 只刷新 base，不得重写语义',
  )

  // 非 rebase 路径仍冻结：--input 在 implemented 计划上 exit 2。
  const frozen = runCli(root, ['desc', 'plan', task.id, '--input', JSON.stringify(input), '--json'])
  assert.equal(frozen.code, 2, frozen.stdout + frozen.stderr)
  assert.equal(frozen.json.error.code, 'invalid')
  assert.match(frozen.json.error.message, /已 implemented/)
})

// ------------------------------------------------------------------- render

test('desc render：未建立退 1；--out 写根内文件、越界退 1；--check 未配置 0 / 缺失与不一致 1', () => {
  const root = freshProject('render', { 'lib/a.mjs': 'export function alpha() {}\n' })

  // 还没 build：null 不是「空文档」，按用法错提示先 build
  const unbuilt = runCli(root, ['desc', 'render', '--json'])
  assert.equal(unbuilt.code, 1, unbuilt.stdout + unbuilt.stderr)
  assert.equal(unbuilt.json.error.code, 'usage')

  buildDescriptionCli(root)
  describeAll(root)

  const text = runCli(root, ['desc', 'render'])
  assert.equal(text.code, 0, text.stdout + text.stderr)
  assert.match(text.stdout, /# 项目描述/)
  assert.match(text.stdout, /```mermaid/)

  // 未配置 description.render：--check 是明确的「跳过」而不是红
  const skipped = runCli(root, ['desc', 'render', '--check'])
  assert.equal(skipped.code, 0, skipped.stdout + skipped.stderr)
  assert.match(skipped.stdout, /未配置/)

  // 配置了 render 但文件不存在 → 检查失败（1 / check-failed）
  patchDescriptionConfig(root, { render: 'DESCRIPTION.md' })
  const missing = runCli(root, ['desc', 'render', '--check', '--json'])
  assert.equal(missing.code, 1, missing.stdout + missing.stderr)
  assert.equal(missing.json.error.code, 'check-failed')

  // --out 写根内文件；路径必须 containment
  const written = runCli(root, ['desc', 'render', '--out', 'DESCRIPTION.md', '--json'])
  assert.equal(written.code, 0, written.stdout + written.stderr)
  assert.equal(written.json.data.path, 'DESCRIPTION.md')
  assert.ok(fs.existsSync(path.join(root, 'DESCRIPTION.md')))

  const consistent = runCli(root, ['desc', 'render', '--check'])
  assert.equal(consistent.code, 0, consistent.stdout + consistent.stderr)
  assert.match(consistent.stdout, /一致/)

  const escape = runCli(root, ['desc', 'render', '--out', '../outside.md'])
  assert.equal(escape.code, 1, escape.stdout + escape.stderr)
  assert.match(escape.stderr, /项目根内/)
  assert.equal(fs.existsSync(path.join(root, '..', 'outside.md')), false, '越界路径不得被写出')

  // 手改渲染文件 → 与现算不一致 → 检查失败（1）
  fs.writeFileSync(path.join(root, 'DESCRIPTION.md'), '# 手改\n')
  const stale = runCli(root, ['desc', 'render', '--check'])
  assert.equal(stale.code, 1, stale.stdout + stale.stderr)
})

// --------------------------------------------------------------------- show

test('desc show：文件树/单文件模块表/--graph mermaid/--json；非法 graph 退 1', () => {
  const root = freshProject('show', {
    'lib/a.mjs': 'export function alpha() {}\nexport function beta() {}\n',
    'bin/x.mjs': 'export function run() {}\n',
  })
  buildDescriptionCli(root)
  describeAll(root)

  const tree = runCli(root, ['desc', 'show', '--json'])
  assert.equal(tree.code, 0, tree.stdout + tree.stderr)
  assert.deepEqual(tree.json.data.counts, { files: 2, modules: 2 })
  assert.equal(tree.json.data.files.length, 2)
  for (const file of tree.json.data.files) {
    assert.equal(typeof file.path, 'string')
    assert.ok(file.modules >= 1)
  }

  const human = runCli(root, ['desc', 'show'])
  assert.equal(human.code, 0, human.stdout + human.stderr)
  assert.match(human.stdout, /2 文件 · 2 模块/)
  assert.match(human.stdout, /lib\//)

  const one = runCli(root, ['desc', 'show', '--path', 'lib/a.mjs', '--json'])
  assert.equal(one.code, 0, one.stdout + one.stderr)
  assert.equal(one.json.data.path, 'lib/a.mjs')
  assert.equal(one.json.data.modules.length, 1)
  assert.ok(one.json.data.moduleEdges !== undefined)

  const oneHuman = runCli(root, ['desc', 'show', '--path', 'lib/a.mjs'])
  assert.equal(oneHuman.code, 0, oneHuman.stdout + oneHuman.stderr)
  assert.match(oneHuman.stdout, /模块（1）/)
  assert.match(oneHuman.stdout, /alpha、beta/)

  const mermaid = runCli(root, ['desc', 'show', '--graph', 'mermaid'])
  assert.equal(mermaid.code, 0, mermaid.stdout + mermaid.stderr)
  assert.match(mermaid.stdout, /# 项目描述/)
  assert.match(mermaid.stdout, /```mermaid/)

  const badGraph = runCli(root, ['desc', 'show', '--graph', 'dot'])
  assert.equal(badGraph.code, 1, badGraph.stdout + badGraph.stderr)

  // 没记录的文件：明确「先 build」，不是崩也不是假成功
  const absent = runCli(root, ['desc', 'show', '--path', 'lib/none.mjs', '--json'])
  assert.equal(absent.code, 0, absent.stdout + absent.stderr)
  assert.equal(absent.json.data.record, null)

  // 未知子命令 = 用法错（1）
  assert.equal(runCli(root, ['desc', 'bogus']).code, 1)
  assert.equal(runCli(root, ['desc']).code, 1)
})

// ---------------------------------------------------------- check description

test('check description：未建立→0 跳过；缺语义→1；补齐→0；改文件不 build→1 且 stale-hash', () => {
  const root = freshProject('check', { 'lib/a.mjs': 'export function alpha() {}\n' })

  // 未建立 + enforce=auto → 通过并在 stdout 说明原因（老项目的默认态）
  const skipped = runCli(root, ['check', 'description'])
  assert.equal(skipped.code, 0, skipped.stdout + skipped.stderr)
  assert.match(skipped.stdout, /未建立描述/)

  buildDescriptionCli(root)
  const missing = runCli(root, ['check', 'description', '--json'])
  assert.equal(missing.code, 1, missing.stdout + missing.stderr)
  assert.equal(missing.json.error.code, 'check-failed')
  assert.equal(missing.json.error.check, 'description')
  assert.ok(missing.json.error.failed.some((item) => item.kind === 'missing-semantics'))

  describeAll(root)
  const green = runCli(root, ['check', 'description', '--json'])
  assert.equal(green.code, 0, green.stdout + green.stderr)
  assert.equal(green.json.data.check, 'description')
  assert.equal(green.json.data.exitCode, 0)
  assert.equal(green.json.data.counts.missingSemantics, 0)
  assert.ok(green.json.data.counts.files >= 1)
  assert.match(green.json.data.stdout, /文件 1 · 模块 1 · 缺语义 0 · 计划 0/)

  // 改了源码但没 build：陈旧 hash 必须被点名（不是一句"检查失败"）
  writeFile(root, 'lib/a.mjs', 'export function alpha() { return 1 }\n')
  const stale = runCli(root, ['check', 'description', '--json'])
  assert.equal(stale.code, 1, stale.stdout + stale.stderr)
  assert.equal(stale.json.error.code, 'check-failed')
  assert.ok(
    stale.json.error.failed.some((item) => item.kind === 'stale-hash' && item.path === 'lib/a.mjs'),
    JSON.stringify(stale.json.error.failed),
  )
  assert.match(stale.json.error.stdout, /stale-hash lib\/a\.mjs/)

  // 不存在的 --task 是用法错（2），不能渲染成"通过"
  const unknownTask = runCli(root, ['check', 'description', '--task', 'T-20260101-01', '--json'])
  assert.equal(unknownTask.code, 2, unknownTask.stdout + unknownTask.stderr)
  assert.equal(unknownTask.json.error.code, 'usage')
})

// ------------------------------------------------------------ status 行接线

test('flow status：描述行与 --json.counts.description 同口径；描述在 check list 里', () => {
  const root = freshProject('status-built', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescriptionCli(root)

  const human = runCli(root, ['status'])
  assert.equal(human.code, 0, human.stdout + human.stderr)
  assert.match(human.stdout, /描述\s+1 文件 · 1 模块 · 缺语义 2 · 计划 0/)

  const json = runCli(root, ['status', '--json'])
  assert.equal(json.code, 0, json.stdout + json.stderr)
  assert.deepEqual(json.json.data.counts.description, {
    files: 1,
    modules: 1,
    missingSemantics: 2,
    plans: 0,
    described: 0,
  })

  const list = runCli(root, ['check', 'list', '--json'])
  assert.equal(list.code, 0, list.stdout + list.stderr)
  assert.equal(list.json.data.checks[7].name, 'description')
})

// --------------------------------------------- --input 双形态（T-20261112151401）
//
// `--input` 同时接受「内联 JSON」与「JSON 文件路径」：去前导空白/BOM 后首字符
// 是 `{`/`[` 走内联，否则一律当路径（相对 `--root`，与 `--type-map` 同口径）。
// 下面钉的是这条通道：两种形态都真的落盘，三档读文件错误各自可辨。

const PLAN_FROM_FILE = { noSemanticChange: true, reason: '夹具：无语义变更' }

test('desc --input：文件路径与内联 JSON 双形态（相对/绝对/空格/BOM/前导空白）', () => {
  const root = freshProject('input-forms', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescriptionCli(root)
  const task = addTask(root, '输入形态任务', ['--stage', 'analyzing'])
  writeFile(root, 'plan.json', JSON.stringify(PLAN_FROM_FILE))

  // 相对路径文件 → 读进来并真的写进计划
  const fromFile = runCli(root, ['desc', 'plan', task.id, '--input', 'plan.json', '--json'])
  assert.equal(fromFile.code, 0, fromFile.stdout + fromFile.stderr)
  assert.equal(fromFile.json.data.plan.noSemanticChange, true)
  const shown = runCli(root, ['desc', 'plan', task.id, '--show', '--json'])
  assert.equal(shown.code, 0, shown.stdout + shown.stderr)
  assert.equal(shown.json.data.plan.noSemanticChange, true, '文件里的计划必须真落盘')

  // desc set 与 desc plan 共用同一个读入函数：数组文件也走文件分支
  writeFile(root, 'patches.json', '[]')
  const setFile = runCli(root, ['desc', 'set', '--input', 'patches.json'])
  assert.equal(setFile.code, 0, setFile.stdout + setFile.stderr)
  assert.match(setFile.stdout, /没有变化/)

  // 内联回归
  const inline = runCli(root, ['desc', 'set', '--input', '[]'])
  assert.equal(inline.code, 0, inline.stdout + inline.stderr)
  assert.match(inline.stdout, /没有变化/)

  // 文件名带空格（spawnSync 传数组，等价于真实用户加引号）
  writeFile(root, 'plan with space.json', JSON.stringify(PLAN_FROM_FILE))
  const spaced = runCli(root, ['desc', 'plan', task.id, '--input', 'plan with space.json', '--json'])
  assert.equal(spaced.code, 0, spaced.stdout + spaced.stderr)

  // 前导空白的内联 JSON（trim 之后首字符才作判据）
  const padded = runCli(root, ['desc', 'plan', task.id, '--input', `  ${JSON.stringify(PLAN_FROM_FILE)}`, '--json'])
  assert.equal(padded.code, 0, padded.stdout + padded.stderr)

  // BOM（Windows 编辑器常见产物）
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(PLAN_FROM_FILE))])
  writeFile(root, 'bom.json', bom)
  const bomRead = runCli(root, ['desc', 'plan', task.id, '--input', 'bom.json', '--json'])
  assert.equal(bomRead.code, 0, bomRead.stdout + bomRead.stderr)

  // 绝对路径；以及非 ASCII + 空格叠加的绝对路径
  const absolute = path.join(root, 'plan.json')
  const absoluteRun = runCli(root, ['desc', 'plan', task.id, '--input', absolute, '--json'])
  assert.equal(absoluteRun.code, 0, absoluteRun.stdout + absoluteRun.stderr)
  const nested = writeFile(root, '目标 目录/计划.json', JSON.stringify(PLAN_FROM_FILE))
  const nestedRun = runCli(root, ['desc', 'plan', task.id, '--input', nested, '--json'])
  assert.equal(nestedRun.code, 0, nestedRun.stdout + nestedRun.stderr)
})

test('desc --input：读文件失败三档可读错误（读不到/是目录/非 JSON），全部 usage 退 1', () => {
  const root = freshProject('input-errors', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescriptionCli(root)
  const task = addTask(root, '输入错误任务', ['--stage', 'analyzing'])

  const missing = runCli(root, ['desc', 'plan', task.id, '--input', 'nope.json', '--json'])
  assert.equal(missing.code, 1, missing.stdout + missing.stderr)
  assert.equal(missing.json.error.code, 'usage')
  assert.match(missing.json.error.message, /读不到/)
  assert.match(missing.json.error.message, /nope\.json/)
  assert.match(missing.json.error.message, /内联 JSON/)
  assert.match(missing.json.error.message, /文件路径/)
  assert.doesNotMatch(missing.json.error.message, /需要合法 JSON（对象或对象数组）/, '旧的通用文案不该再出现')

  const directory = runCli(root, ['desc', 'plan', task.id, '--input', '.agents', '--json'])
  assert.equal(directory.code, 1, directory.stdout + directory.stderr)
  assert.equal(directory.json.error.code, 'usage')
  assert.match(directory.json.error.message, /目录/)

  writeFile(root, 'bad.json', '{bad')
  const broken = runCli(root, ['desc', 'plan', task.id, '--input', 'bad.json', '--json'])
  assert.equal(broken.code, 1, broken.stdout + broken.stderr)
  assert.equal(broken.json.error.code, 'usage')
  assert.match(broken.json.error.message, /不是合法 JSON/)
  assert.match(broken.json.error.message, /bad\.json/)

  const empty = runCli(root, ['desc', 'set', '--input', '', '--json'])
  assert.equal(empty.code, 1, empty.stdout + empty.stderr)
  assert.equal(empty.json.error.code, 'usage')
  assert.match(empty.json.error.message, /不能为空/)
  assert.match(empty.json.error.message, /内联 JSON/)
})

test('desc --input：相对路径以 --root 为基准（不是进程 cwd）', () => {
  const root = freshProject('input-root', { 'lib/a.mjs': 'export function alpha() {}\n' })
  buildDescriptionCli(root)
  const task = addTask(root, '输入基准任务', ['--stage', 'analyzing'])
  writeFile(root, 'plans/p.json', JSON.stringify(PLAN_FROM_FILE))

  const elsewhere = tempRoot('input-cwd')
  const run = runCli(elsewhere, ['--root', root, 'desc', 'plan', task.id, '--input', 'plans/p.json', '--json'])
  assert.equal(run.code, 0, run.stdout + run.stderr)
  assert.equal(run.json.data.plan.noSemanticChange, true)
})

test(
  'desc --input：win32 盘符路径原样回显（不当相对路径拼到 cwd 下）',
  { skip: process.platform !== 'win32' },
  () => {
    const root = freshProject('input-win', { 'lib/a.mjs': 'export function alpha() {}\n' })
    buildDescriptionCli(root)
    const task = addTask(root, '盘符路径任务', ['--stage', 'analyzing'])
    const drivePath = 'C:\\Users\\x\\plan.json'
    const run = runCli(root, ['desc', 'plan', task.id, '--input', drivePath, '--json'])
    assert.equal(run.code, 1, run.stdout + run.stderr)
    assert.ok(run.json.error.message.includes(drivePath), run.json.error.message)
  },
)

