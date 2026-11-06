// T-20261107 · 协作技能与 flow 台账的作用域边界（P1 设计债，review-panel task-43）。
//
// 背景：`skills/ai-collaborative-dev-workflow/scripts/task` 是 Python 参考实现，自带
// `.agents/tasks/` 存储；project-flow 插件只读 `.dsh/flow/`。两者互不相认——照协作技能跑
// `scripts/task new` 会写进 flow **永远不会读**的目录（实测：`flow task list` 显示「没有任务记录」）。
//
// 本文件守两件事：
//   A. references 里每一处 `.agents/tasks/` 都带「flow 不读」限定语，不再让读者以为那是 flow 台账；
//   B. `scripts/task` 检测到 `.dsh/flow/flow.json` 时**必须**打 SHADOW_LEDGER 警告，
//      且没有 flow 台账时**不得**误报——同时不删它的任何功能。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SKILL = path.join(REPO, 'skills', 'ai-collaborative-dev-workflow')

const TEMP_ROOTS = []
after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
})

/** references/ 下所有 md，连同路径与全文。 */
function referenceDocs() {
  const dir = path.join(SKILL, 'references')
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }))
}

/** 「flow 不读」限定语的几种写法；命中任一即视为已标注。 */
const SCOPE_QUALIFIER = /flow 插件\s*\*{0,2}不读|flow\s*\*{0,2}不读\s*\*{0,2}\s*它|不读\s*`?\.agents\/tasks/;

/** 一处提及前后 window 个字符内是否带限定语（限定语可能在同行、上文或下一行）。 */
function qualifiedNearby(text, index, window = 260) {
  const from = Math.max(0, index - window)
  const to = Math.min(text.length, index + window)
  return SCOPE_QUALIFIER.test(text.slice(from, to))
}

test('协作技能 A1：references 中每处 `.agents/tasks/` 都标注「flow 不读」', () => {
  const offenders = []
  for (const { name, text } of referenceDocs()) {
    const needle = '.agents/tasks/'
    let index = text.indexOf(needle)
    while (index !== -1) {
      if (!qualifiedNearby(text, index)) {
        const line = text.slice(0, index).split('\n').length
        offenders.push(`${name}:${line}`)
      }
      index = text.indexOf(needle, index + needle.length)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些位置的 .agents/tasks/ 没说明「flow 插件不读」，读者会误以为它是 flow 台账：${offenders.join(', ')}`,
  )
})

test('协作技能 A2：没有一处把 `.agents/tasks/` 说成 flow 的台账/真源', () => {
  const bad = []
  for (const { name, text } of referenceDocs()) {
    // 同一行里同时出现「flow」与「台账」，又提到 .agents/tasks/ → 极可能是在说它是 flow 的台账。
    for (const [i, line] of text.split('\n').entries()) {
      if (!line.includes('.agents/tasks/')) continue
      if (/flow/.test(line) && /台账/.test(line) && !SCOPE_QUALIFIER.test(line)) {
        bad.push(`${name}:${i + 1}`)
      }
    }
  }
  assert.deepEqual(bad, [], `这些行把 .agents/tasks/ 与 flow 台账混为一谈：${bad.join(', ')}`)
})

test('协作技能 A3：project-flow-init 明确「旧台账不再被读取」', () => {
  const text = fs.readFileSync(path.join(REPO, 'skills', 'project-flow-init.md'), 'utf8')
  assert.match(text, /不再被读取|不再自动迁移/, 'project-flow-init 应说明旧 .agents/tasks/ 不再被读取')
})

// ------------------------------------------------------- scripts/task 行为

const TASK_SCRIPT = path.join(SKILL, 'scripts', 'task')
const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0

function tempRepo(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-collab-${label}-`))
  TEMP_ROOTS.push(root)
  spawnSync('git', ['init', '-q', '.'], { cwd: root })
  return root
}

/** 在 root 下跑 scripts/task，返回 {status, stdout, stderr}。
 * `--root` 是 argparse 的**顶层**参数，必须排在子命令之前（放在末尾会报 unrecognized）。 */
function runTask(root, args) {
  return spawnSync('python3', [TASK_SCRIPT, '--root', root, ...args], { cwd: root, encoding: 'utf8' })
}

test('协作技能 A4：有 flow 台账时 scripts/task 必须打 SHADOW_LEDGER 警告', { skip: hasPython === false }, () => {
  const root = tempRepo('warn')
  // 造一个最小的 flow 台账标记（不依赖 bin/flow.mjs，纯文件即可）。
  fs.mkdirSync(path.join(root, '.dsh', 'flow', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(root, '.dsh', 'flow', 'flow.json'), JSON.stringify({ name: 'p', gates: [] }))
  const result = runTask(root, ['list'])
  assert.match(
    result.stderr,
    /SHADOW_LEDGER/,
    `flow 台账存在时没有警告（stderr=${JSON.stringify(result.stderr)}）`,
  )
  // 警告必须说清「写到哪里」与「flow 不读」，不能只说一句含糊的话。
  assert.match(result.stderr, /\.agents\/tasks/, '警告应点名脚本自己的存储 .agents/tasks/')
  assert.match(result.stderr, /不读/, '警告应说明 flow 不读该目录')
})

test('协作技能 A5：没有 flow 台账时不得误报警告', { skip: hasPython === false }, () => {
  const root = tempRepo('nowarn')
  const result = runTask(root, ['list'])
  assert.doesNotMatch(
    result.stderr,
    /SHADOW_LEDGER/,
    `没有 flow 台账却报了警告（stderr=${JSON.stringify(result.stderr)}）`,
  )
})

test('协作技能 A6：警告不改变退出码，功能照常（不许删功能）', { skip: hasPython === false }, () => {
  const root = tempRepo('keeps')
  fs.mkdirSync(path.join(root, '.dsh', 'flow', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(root, '.dsh', 'flow', 'flow.json'), JSON.stringify({ name: 'p', gates: [] }))
  const created = runTask(root, [
    'new', '--title', '影子任务', '--goal', 'G', '--allow', 'src/',
    '--acceptance', 'true=>exit 0', '--understanding', 'ok',
  ])
  assert.equal(created.status, 0, `scripts/task new 应仍然成功：${created.stderr}`)
  // 它照旧写自己的存储——这正是要警告的原因，不是要阻止。
  const tasksDir = path.join(root, '.agents', 'tasks')
  const files = fs.readdirSync(tasksDir).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 1, `应在 .agents/tasks/ 下写入 1 条（实际 ${files.length}）`)
  // 且 flow 的目录里一条都不能多——脚本绝不跨写到 flow 真源。
  assert.deepEqual(fs.readdirSync(path.join(root, '.dsh', 'flow', 'tasks')), [], 'scripts/task 不得写进 .dsh/flow/tasks/')
})
