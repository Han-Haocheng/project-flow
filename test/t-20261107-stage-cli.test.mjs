// task-63：CLI 通道 `--stage`（D4 验收判据 3/4/6）。
//
// 这张卡只补**通道**：`stage` 早已在 core 的可更新白名单里并校验收值，缺的是
// bin/flow.mjs 的三处登记（`VALUE_FLAGS` 白名单、`SPEC.task.*.flags`、handler 字段循环）。
//
// 特别防的坑：`VALUE_FLAGS` 漏登记时的报错是「未知参数 --stage」——**看起来像功能没做，
// 实际是白名单没登记**，排查方向相反。所以第一条用例专门断言"它不是未知参数"。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
const ROOT = path.resolve(HERE, '..')
const BIN_SOURCE = fs.readFileSync(BIN, 'utf8')

/** CLI 实现源码：bin 入口 +（拆分后）lib/cli 命令模块；缺失目录时只扫 bin。 */
function cliImplementationSource() {
  const dir = path.join(ROOT, 'lib', 'cli')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort() : []
  return [BIN_SOURCE, ...files.map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))].join('\n')
}
const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-stagecli-${label}-`))
  TEMP_ROOTS.push(root)
  const init = runCli(root, ['init', '--name', label, '--no-gates', '--json'])
  assert.equal(init.code, 0, init.stderr)
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

function taskFile(root, id) {
  return path.join(root, '.agents', 'tasks', `${id}.json`)
}

function readTask(root, id) {
  return JSON.parse(fs.readFileSync(taskFile(root, id), 'utf8'))
}

function addTaskCli(root, title, extra = []) {
  const result = runCli(root, ['task', 'add', '--type', 'feat', '--title', title, ...extra, '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  return result.json.data
}

const NINE = [
  'created', 'queued-analysis', 'analyzing', 'queued-implementation', 'implementing',
  'queued-review', 'reviewing', 'done', 'archived',
]

// -------------------------------------------------- 判据 3：真能写入（且不是"未知参数"）

test('D4-3：--stage 真能写入（add 与 update），且**不是**「未知参数」', () => {
  const root = freshProject('write')

  // add 直接带 stage
  const created = addTaskCli(root, '带阶段新建', ['--stage', 'analyzing'])
  assert.equal(created.stage, 'analyzing')
  assert.equal(created.status, 'active', 'stage 派生 status')
  assert.equal(readTask(root, created.id).stage, 'analyzing', 'add 的 stage 必须落盘')

  // update 带 stage：**这条就是本卡最容易漏的白名单路径**
  // 目标取 analyzing 的合法后继（阶段边由 core 校验，T-20261112151328）。
  const updated = runCli(root, ['task', 'update', created.id, '--stage', 'queued-implementation', '--json'])
  assert.equal(updated.code, 0, updated.stdout + updated.stderr)
  // 白名单漏登记时这里是 usage/「未知参数 --stage」——专门钉住这个反向排查陷阱
  assert.equal(updated.json?.error, undefined, 'update --stage 不得报错')
  assert.doesNotMatch(updated.stderr ?? '', /未知参数/)
  assert.doesNotMatch(JSON.stringify(updated.json ?? {}), /未知参数/)
  assert.equal(updated.json?.data?.stage, 'queued-implementation')
  assert.equal(readTask(root, created.id).stage, 'queued-implementation', 'update 的 stage 必须落盘')
  assert.equal(readTask(root, created.id).status, 'active')

  // 同一道门：CLI 写非后继阶段必须被 core 拒（queued-implementation → reviewing 没有合约边）
  const illegal = runCli(root, ['task', 'update', created.id, '--stage', 'reviewing', '--json'])
  assert.equal(illegal.code, 2, illegal.stdout + illegal.stderr)
  assert.equal(illegal.json?.error?.code, 'invalid')
  assert.match(illegal.json?.error?.message ?? '', /cannot move to "reviewing"/)
  assert.equal(readTask(root, created.id).stage, 'queued-implementation', '被拒的写入不得落盘')

  // --help 必须列出它（SPEC → describeFlags 的同一张表）
  const help = runCli(root, ['task', 'update', '--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /--stage/)

})

// ------------------------------------------------------ 判据 4：非法值拒绝

test('D4-4：--stage 非法值 → exit 2 / invalid，文案按顺序列出九个值', () => {
  const root = freshProject('invalid')
  const task = addTaskCli(root, '非法阶段')

  for (const bad of ['nope', 'IN-PROGRESS', 'Analysing']) {
    const result = runCli(root, ['task', 'update', task.id, '--stage', bad, '--json'])
    assert.equal(result.code, 2, `${bad}: ${result.stdout}${result.stderr}`)
    assert.equal(result.json?.error?.code, 'invalid')
    const message = result.json?.error?.message ?? ''
    assert.match(message, /stage must be one of/)
    for (const id of NINE) assert.ok(message.includes(id), `文案必须列出 ${id}`)
    // 被拒的写入不得落盘
    assert.equal(Object.hasOwn(readTask(root, task.id), 'stage'), false)
  }
})

// ------------------------------- 判据 6：status 同批派生，且 done_at 也要写上

test('D4-6：--stage done → status=done **且** done_at 有值（stampTaskTimes 也要走到）', () => {
  const root = freshProject('derive')
  const task = addTaskCli(root, '走到完成')
  assert.equal(Object.hasOwn(readTask(root, task.id), 'stage'), false, '没给 stage 时不写该键')

  // 阶段边由 core 校验（T-20261112151328）：created 不能直接跳 done，按合法路径走完。
  for (const stage of ['queued-analysis', 'analyzing']) {
    const step = runCli(root, ['task', 'update', task.id, '--stage', stage, '--json'])
    assert.equal(step.code, 0, step.stdout + step.stderr)
  }
  const done = runCli(root, ['task', 'update', task.id, '--stage', 'done', '--json'])
  assert.equal(done.code, 0, done.stdout + done.stderr)
  const onDisk = readTask(root, task.id)
  assert.equal(onDisk.stage, 'done')
  assert.equal(onDisk.status, 'done', 'status 必须由 stage 派生并落盘')
  assert.match(String(onDisk.done_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    'done_at 必须由 stampTaskTimes 写入——只有 status 没有完成时间会让面板排序错')

  // 归档阶段：status=archived 且 archived_at 有值（done_at 保留）
  const archived = runCli(root, ['task', 'update', task.id, '--stage', 'archived', '--json'])
  assert.equal(archived.code, 0, archived.stdout + archived.stderr)
  const afterArchive = readTask(root, task.id)
  assert.equal(afterArchive.status, 'archived')
  assert.match(String(afterArchive.archived_at), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(afterArchive.done_at, onDisk.done_at, '归档保留原 done_at')

  // 阶段机没有反向边：archived 是终态，「回流水线」这条写入必须被拒（不静默改阶段）。
  // 会话面向的「恢复」需要自己的合约边，属于后续卡（本卡只接管写入口，不新造边）。
  const back = runCli(root, ['task', 'update', task.id, '--stage', 'implementing', '--json'])
  assert.equal(back.code, 2, back.stdout + back.stderr)
  assert.match(
    String(back.json?.error?.message ?? back.stderr),
    /terminal|cannot move to/,
    '终态必须给出「没有后继」的拒绝文案',
  )
  assert.equal(readTask(root, task.id).stage, 'archived', '被拒的写入不得落盘')

  // 只给 --status 仍然可用（既有调用方），stage 原样不动
  const statusOnly = runCli(root, ['task', 'update', task.id, '--status', 'done', '--json'])
  assert.equal(statusOnly.code, 0, statusOnly.stdout + statusOnly.stderr)
  assert.equal(readTask(root, task.id).stage, 'archived', '只写 status 不得改 stage')

  // 两者同给且矛盾 → invalid（派生冲突，不能写入）
  const conflict = runCli(root, ['task', 'update', task.id, '--stage', 'implementing', '--status', 'done', '--json'])
  assert.equal(conflict.code, 2, conflict.stdout + conflict.stderr)
  assert.equal(conflict.json?.error?.code, 'invalid')
  assert.match(conflict.json?.error?.message ?? '', /implies status active/)
})

// ------------------------------------- 回归：白名单三处登记必须同时存在

test('回归：VALUE_FLAGS / SPEC / handler 三处登记齐备（少一处就静默失效）', () => {
  // ① VALUE_FLAGS：值是 `'stage',` 出现在 VALUE_FLAGS 段内
  const valueFlagsBlock = BIN_SOURCE.slice(
    BIN_SOURCE.indexOf('const VALUE_FLAGS = new Set(['),
    BIN_SOURCE.indexOf('])', BIN_SOURCE.indexOf('const VALUE_FLAGS = new Set([')),
  )
  assert.match(valueFlagsBlock, /'stage'/, "VALUE_FLAGS 漏登记会让 --stage 以「未知参数」被拒")

  // ② SPEC：task add/update 都声明
  assert.match(BIN_SOURCE, /add: \{ flags: \[[^\]]*'stage'[^\]]*\] \}/)
  assert.match(BIN_SOURCE, /update: \{ flags: \[[^\]]*'stage'[^\]]*\] \}/)

  // ③ handler：声明了却读不到 = 静默丢弃（比报错更糟）。本文件的字段是**循环**读取，
  //    所以钉的是 add / update 两个循环的元素表，而不是 `readString(flags, 'stage')`。
  const wanted = ['title', 'type', 'status', 'stage', 'owner', 'notes']
  const loops = [...cliImplementationSource().matchAll(/for \(const key of \[([^\]]*)\]\)/g)]
    .map((match) => match[1].split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean))
    .filter((members) => wanted.every((field) => members.includes(field)))
  assert.equal(loops.length, 2, `handler 的 add/update 字段循环都必须含 stage（实际 ${loops.length} 处）`)
})
