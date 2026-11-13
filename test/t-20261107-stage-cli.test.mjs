// task-63：CLI 通道 `--stage`（D4 验收判据 3/4/6）。
//
// 这张卡只补**通道**：`stage` 早已在 core 的可更新白名单里并校验收值，缺的是
// bin/flow.mjs 的三处登记（`VALUE_FLAGS` 白名单、`SPEC.task.*.flags`、handler 字段循环）。
//
// 特别防的坑：`VALUE_FLAGS` 漏登记时的报错是「未知参数 --stage」——**看起来像功能没做，
// 实际是白名单没登记**，排查方向相反。所以第一条用例专门断言"它不是未知参数"。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { archiveTasks, loadContract, updateTask } from '../lib/core.mjs'
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

function backdateTask(root, id, when = '2026-11-13T16:00:00+08:00') {
  const record = readTask(root, id)
  record.created_at = when
  fs.writeFileSync(taskFile(root, id), JSON.stringify(record, null, 1))
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

test('warn 模式：同一条边放行但带 task-dispatch-warn（hard 用例仍在上面）', () => {
  const root = freshProject('claim-warn')
  const task = addTaskCli(root, 'warn 模式', ['--stage', 'implementing', '--owner', 'someone'])
  process.env.PROJECT_FLOW_CLAIM_GATE = 'warn'
  try {
    const moved = runCli(root, ['task', 'update', task.id, '--stage', 'queued-review', '--json'])
    assert.equal(moved.code, 0, 'warn 模式必须放行：' + moved.stdout + moved.stderr)
    assert.ok(
      (moved.json.warnings || []).some((line) => line.startsWith('task-dispatch-warn:')),
      '放行必须带 task-dispatch-warn：' + JSON.stringify(moved.json.warnings),
    )
    assert.equal(moved.json.data.stage, 'queued-review')
    assert.ok(
      (moved.json.warnings || []).some((line) => line.startsWith('claim-gate-bypassed: mode=warn')),
      '非 hard 模式必须显式写 claim-gate-bypassed：' + JSON.stringify(moved.json.warnings),
    )
    assert.equal(
      (moved.json.data.checkpoints || []).some((item) => item.kind === 'legacy-bypass'),
      false,
      'warn 模式不得偷偷写 legacy-bypass 标记',
    )
  } finally {
    delete process.env.PROJECT_FLOW_CLAIM_GATE
  }
})

// ------------------------------- T-20261113163323：claim/release 与派工回执阶段门

function claimCli(root, id, args) {
  return runCli(root, ['task', 'claim', id, ...args, '--json'])
}

function releaseCli(root, id, args) {
  return runCli(root, ['task', 'release', id, ...args, '--json'])
}

test('claim/release：回执形状（kind/role/agent/session/from/to/at）、owner 与两条互斥', () => {
  const root = freshProject('claim')
  const a = addTaskCli(root, '甲卡', ['--stage', 'queued-implementation'])
  const b = addTaskCli(root, '乙卡', ['--stage', 'queued-implementation'])

  const claimed = claimCli(root, a.id, ['--agent', 'agent-x', '--role', 'implementer', '--session', 'session-x', '--reason', '领取实现'])
  assert.equal(claimed.code, 0, claimed.stdout + claimed.stderr)
  const record = claimed.json.data
  assert.equal(record.owner, 'session-x', 'claim 有 session 时把 owner 设为该会话')
  const entry = record.checkpoints.at(-1)
  assert.deepEqual(Object.keys(entry).sort(), ['agent', 'at', 'from', 'kind', 'note', 'role', 'session', 'to'])
  assert.equal(entry.kind, 'claim')
  assert.equal(entry.role, 'implementer')
  assert.equal(entry.agent, 'agent-x')
  assert.equal(entry.session, 'session-x')
  assert.equal(entry.from, 'queued-implementation')
  assert.equal(entry.to, 'implementing')
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(Object.hasOwn(entry, 'closedAt'), false, 'open 回执没有 closedAt')
  assert.equal(entry.note, '领取实现', '--reason 必须落盘为 note（不再静默丢弃）')

  // 同一卡第二条 open claim：点名当前持有者
  const again = claimCli(root, a.id, ['--agent', 'agent-y', '--role', 'reviewer'])
  assert.equal(again.code, 2, again.stdout + again.stderr)
  assert.equal(again.json?.error?.code, 'invalid')
  assert.match(again.json.error.message, /already has an open claim/)
  assert.match(again.json.error.message, /agent-x/)

  // 同一 agent 跨卡：点名对方任务 id
  const other = claimCli(root, b.id, ['--agent', 'agent-x', '--role', 'analyzer'])
  assert.equal(other.code, 2, other.stdout + other.stderr)
  assert.match(other.json.error.message, new RegExp('open claim on task ' + a.id))

  // release 只关闭匹配 agent 的 claim，写 closedAt + outcome
  const released = releaseCli(root, a.id, ['--agent', 'agent-x', '--outcome', 'ok'])
  assert.equal(released.code, 0, released.stdout + released.stderr)
  const closed = released.json.data.checkpoints.at(-1)
  assert.equal(closed.outcome, 'ok')
  assert.match(closed.closedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(released.json.data.owner, 'session-x', 'release 不清 owner')

  const noClaim = releaseCli(root, a.id, ['--agent', 'agent-x', '--outcome', 'ok'])
  assert.equal(noClaim.code, 2, '已闭合后再 release 必须报没有 open claim')
  assert.match(noClaim.json.error.message, /no open claim/)
})

test('阶段门：→implementing 必须有 open claim；legacy 一次性放行并落标记', () => {
  const root = freshProject('gate-implementing')
  /* 新建卡不算 legacy（评审必修 1）：legacy 只看 created_at 是否早于协议切换点。 */
  const fresh = addTaskCli(root, '新卡', ['--stage', 'queued-implementation', '--owner', 'someone'])
  const freshBlocked = runCli(root, ['task', 'update', fresh.id, '--stage', 'implementing', '--json'])
  assert.equal(freshBlocked.code, 2, '切换点之后创建的卡不放行：' + freshBlocked.stdout + freshBlocked.stderr)
  assert.match(freshBlocked.json.error.message, /open claim/)

  /* 存量 owner 卡同样享受一次迁移放行（评审必修 4：owner 不参与 legacy 判定）。 */
  const legacy = addTaskCli(root, '老卡', ['--stage', 'queued-implementation', '--owner', 'old-owner'])
  backdateTask(root, legacy.id)
  const moved = runCli(root, ['task', 'update', legacy.id, '--stage', 'implementing', '--json'])
  assert.equal(moved.code, 0, moved.stdout + moved.stderr)
  assert.ok(
    (moved.json.warnings || []).some((line) => line.startsWith('task-dispatch-legacy:')),
    '切换点前的卡要写 legacy warning：' + JSON.stringify(moved.json.warnings),
  )
  assert.equal(moved.json.data.checkpoints.at(-1).kind, 'legacy-bypass', '放行必须落一次性标记')
  const second = runCli(root, ['task', 'update', legacy.id, '--stage', 'queued-review', '--json'])
  assert.equal(second.code, 2, '标记落盘后不再享受 legacy：' + second.stdout + second.stderr)
  assert.match(second.json.error.message, /本轮|缺少已关闭|尚未闭合/)

  const owned = addTaskCli(root, '有主卡', ['--stage', 'queued-implementation', '--owner', 'someone'])
  const blocked = runCli(root, ['task', 'update', owned.id, '--stage', 'implementing', '--json'])
  assert.equal(blocked.code, 2, blocked.stdout + blocked.stderr)
  assert.equal(blocked.json.error.code, 'invalid')
  assert.match(blocked.json.error.message, /open claim/)
  assert.match(blocked.json.error.message, new RegExp('flow task claim ' + owned.id))

  const claimed = claimCli(root, owned.id, ['--agent', 'impl', '--role', 'implementer'])
  assert.equal(claimed.code, 0, claimed.stdout + claimed.stderr)
  const ok = runCli(root, ['task', 'update', owned.id, '--stage', 'implementing', '--json'])
  assert.equal(ok.code, 0, ok.stdout + ok.stderr)
})

test('阶段门：→queued-review 必须有已关闭 outcome=ok 的 implementer claim', () => {
  const root = freshProject('gate-review')
  const task = addTaskCli(root, '实现卡', ['--stage', 'queued-implementation', '--owner', 'someone'])
  assert.equal(claimCli(root, task.id, ['--agent', 'impl', '--role', 'implementer']).code, 0)
  assert.equal(runCli(root, ['task', 'update', task.id, '--stage', 'implementing', '--json']).code, 0)

  const open = runCli(root, ['task', 'update', task.id, '--stage', 'queued-review', '--json'])
  assert.equal(open.code, 2, open.stdout + open.stderr)
  assert.match(open.json.error.message, /尚未闭合|不是 outcome=ok/)

  assert.equal(releaseCli(root, task.id, ['--agent', 'impl', '--outcome', 'aborted']).code, 0)
  const aborted = runCli(root, ['task', 'update', task.id, '--stage', 'queued-review', '--json'])
  assert.equal(aborted.code, 2, 'aborted 不算实现完成')
  assert.match(aborted.json.error.message, /尚未闭合|不是 outcome=ok/)

  assert.equal(claimCli(root, task.id, ['--agent', 'impl', '--role', 'implementer']).code, 0)
  assert.equal(releaseCli(root, task.id, ['--agent', 'impl', '--outcome', 'ok']).code, 0)
  const ok = runCli(root, ['task', 'update', task.id, '--stage', 'queued-review', '--json'])
  assert.equal(ok.code, 0, ok.stdout + ok.stderr)

  /* 轮次隔离（评审必修 2）：上一轮 closed ok 不能被本轮复用——新 claim 一开，
     最后一条回执就是 open，queued-review 必须再次要求 release。 */
  const reopened = addTaskCli(root, '轮次卡', ['--stage', 'queued-implementation', '--owner', 'someone'])
  assert.equal(claimCli(root, reopened.id, ['--agent', 'impl', '--role', 'implementer']).code, 0)
  assert.equal(releaseCli(root, reopened.id, ['--agent', 'impl', '--outcome', 'ok']).code, 0)
  assert.equal(claimCli(root, reopened.id, ['--agent', 'impl', '--role', 'implementer']).code, 0, '新一轮 claim')
  assert.equal(runCli(root, ['task', 'update', reopened.id, '--stage', 'implementing', '--json']).code, 0)
  const reused = runCli(root, ['task', 'update', reopened.id, '--stage', 'queued-review', '--json'])
  assert.equal(reused.code, 2, '本轮 open claim 未闭合，不得复用上一轮 closed ok')
  assert.match(reused.json.error.message, /尚未闭合|不是 outcome=ok/)
})

test('阶段门：reviewing→done 必须有已关闭 reviewer claim；--no-dispatch 覆盖写原因', () => {
  const root = freshProject('gate-done')
  const task = addTaskCli(root, '审查卡', ['--stage', 'reviewing', '--owner', 'someone'])
  const blocked = runCli(root, ['task', 'update', task.id, '--stage', 'done', '--json'])
  assert.equal(blocked.code, 2, blocked.stdout + blocked.stderr)
  assert.match(blocked.json.error.message, /尚未闭合|不是 outcome=ok/)
  assert.match(blocked.json.error.message, /--no-dispatch/)

  const noReason = runCli(root, ['task', 'update', task.id, '--stage', 'done', '--no-dispatch', '--json'])
  assert.equal(noReason.code, 1, '--no-dispatch 缺 --reason 是用法错误')
  assert.equal(noReason.json?.error?.code, 'usage')
  assert.match(noReason.json.error.message, /--reason/)

  const overridden = runCli(root, ['task', 'update', task.id, '--stage', 'done', '--no-dispatch', '--reason', '紧急修复，由 lead 复核', '--json'])
  assert.equal(overridden.code, 0, overridden.stdout + overridden.stderr)
  const last = overridden.json.data.checkpoints.at(-1)
  assert.equal(last.kind, 'no-dispatch')
  assert.equal(last.reason, '紧急修复，由 lead 复核')
  assert.equal(last.stage, 'done')
  assert.ok((overridden.json.warnings || []).some((line) => line.startsWith('task-dispatch-override:')),
    '覆盖必须留 warning：' + JSON.stringify(overridden.json.warnings))

  const reviewed = addTaskCli(root, '正常审查', ['--stage', 'reviewing', '--owner', 'someone'])
  assert.equal(claimCli(root, reviewed.id, ['--agent', 'rev', '--role', 'reviewer']).code, 0)
  assert.equal(releaseCli(root, reviewed.id, ['--agent', 'rev', '--outcome', 'ok']).code, 0)
  const done = runCli(root, ['task', 'update', reviewed.id, '--stage', 'done', '--json'])
  assert.equal(done.code, 0, done.stdout + done.stderr)
})

test('孤儿检测：open claim 的 owner 会话判死不活 → list JSON orphan + 文本 [orphan]', () => {
  const root = freshProject('orphan')
  const task = addTaskCli(root, '孤儿卡', ['--stage', 'implementing'])
  const claimed = claimCli(root, task.id, ['--agent', 'impl', '--role', 'implementer', '--session', 'ghost-session'])
  assert.equal(claimed.code, 0, claimed.stdout + claimed.stderr)

  const listed = runCli(root, ['task', 'list', '--json'])
  assert.equal(listed.code, 0, listed.stdout + listed.stderr)
  const row = listed.json.data.find((item) => item.id === task.id)
  assert.ok(row !== undefined)
  assert.equal(row.claim.kind, 'claim')
  assert.equal(row.claim.agent, 'impl')
  assert.equal(row.claim.session, 'ghost-session')
  assert.equal(row.claim.orphan, true, '没有心跳的会话不能证明活，open claim 必须标 orphan')

  const text = runCli(root, ['task', 'list'])
  assert.equal(text.code, 0, text.stderr)
  assert.match(text.stdout, /\[orphan\]/)
})

// ------------------------------- T-20261113170144：任务内交接产物 artifacts

test('art put/list/show：拷贝正文、指针形状与 sha256、每角色保留最近 3 条', () => {
  const root = freshProject('art')
  const task = addTaskCli(root, '产物卡', ['--stage', 'implementing'])
  const taskFile = path.join(root, 'report.md')
  fs.writeFileSync(taskFile, '实现报告正文\n')
  const put = runCli(root, ['task', 'art', 'put', task.id, '--role', 'implementer', '--summary', '实现完成', '--file', 'report.md', '--json'])
  assert.equal(put.code, 0, put.stdout + put.stderr)
  const artifact = put.json.data.artifacts.at(-1)
  assert.equal(artifact.role, 'implementer')
  assert.equal(artifact.stage, 'implementing')
  assert.equal(artifact.summary, '实现完成')
  assert.match(artifact.path, new RegExp('^\\.agents/reports/' + task.id + '/implementer-'))
  assert.equal(artifact.sha256, createHash('sha256').update(fs.readFileSync(taskFile)).digest('hex'))
  assert.ok(fs.existsSync(path.join(root, artifact.path)), '正文必须拷贝进 .agents/reports')

  const listed = runCli(root, ['task', 'art', 'list', task.id, '--json'])
  assert.equal(listed.code, 0, listed.stdout + listed.stderr)
  assert.equal(listed.json.data.length, 1)
  assert.equal(listed.json.data[0].sha256, artifact.sha256)

  const shown = runCli(root, ['task', 'art', 'show', task.id, '--role', 'implementer', '--json'])
  assert.equal(shown.code, 0, shown.stdout + shown.stderr)
  assert.equal(shown.json.data.task, task.id)
  assert.equal(shown.json.data.artifact.sha256, artifact.sha256)
  assert.match(shown.json.data.content, /实现报告正文/)

  // 每角色只保留最近 3 条：第 4 条把最旧的挤掉，其它角色不受影响。
  for (const summary of ['第二版', '第三版', '第四版']) {
    const again = runCli(root, ['task', 'art', 'put', task.id, '--role', 'implementer', '--summary', summary, '--file', 'report.md', '--json'])
    assert.equal(again.code, 0, again.stdout + again.stderr)
  }
  const latest = runCli(root, ['task', 'art', 'list', task.id, '--role', 'implementer', '--json'])
  assert.equal(latest.json.data.length, 3, '每卡每角色最多保留 3 条')
  assert.deepEqual(latest.json.data.map((item) => item.summary), ['第二版', '第三版', '第四版'])
})

test('art：release 携带产物指针（不造第二套回执）', () => {
  const root = freshProject('art-release')
  const task = addTaskCli(root, '释放带产物', ['--stage', 'queued-implementation'])
  fs.writeFileSync(path.join(root, 'review.md'), '审查结论：accept\n')
  assert.equal(claimCli(root, task.id, ['--agent', 'impl', '--role', 'implementer']).code, 0)
  const released = runCli(root, [
    'task', 'release', task.id, '--agent', 'impl', '--outcome', 'ok',
    '--file', 'review.md', '--summary', '审查结论 accept', '--json',
  ])
  assert.equal(released.code, 0, released.stdout + released.stderr)
  const closed = released.json.data.checkpoints.at(-1)
  assert.equal(closed.outcome, 'ok')
  assert.equal(closed.artifact.role, 'implementer')
  assert.match(closed.artifact.path, new RegExp('^\\.agents/reports/' + task.id + '/'))
  assert.equal(released.json.data.artifacts.length, 1, '指针同时进 task.artifacts')
  assert.equal(released.json.data.artifacts[0].sha256, closed.artifact.sha256)
})

test('art：缺交接产物只警告 task-artifact-missing，不阻断阶段门', () => {
  const root = freshProject('art-warn')
  const missing = addTaskCli(root, '缺产物', ['--stage', 'implementing'])
  assert.equal(claimCli(root, missing.id, ['--agent', 'impl', '--role', 'implementer']).code, 0)
  assert.equal(releaseCli(root, missing.id, ['--agent', 'impl', '--outcome', 'ok']).code, 0)
  const warned = runCli(root, ['task', 'update', missing.id, '--stage', 'queued-review', '--json'])
  assert.equal(warned.code, 0, warned.stdout + warned.stderr)
  assert.ok(
    (warned.json.warnings || []).some((line) => line.startsWith('task-artifact-missing:')),
    '缺产物必须给 warning：' + JSON.stringify(warned.json.warnings),
  )

  const withArt = addTaskCli(root, '有产物', ['--stage', 'implementing'])
  fs.writeFileSync(path.join(root, 'impl.md'), '实现细节\n')
  assert.equal(runCli(root, ['task', 'art', 'put', withArt.id, '--role', 'implementer', '--summary', '实现完成', '--file', 'impl.md', '--json']).code, 0)
  assert.equal(claimCli(root, withArt.id, ['--agent', 'impl2', '--role', 'implementer']).code, 0)
  assert.equal(releaseCli(root, withArt.id, ['--agent', 'impl2', '--outcome', 'ok']).code, 0)
  const clean = runCli(root, ['task', 'update', withArt.id, '--stage', 'queued-review', '--json'])
  assert.equal(clean.code, 0, clean.stdout + clean.stderr)
  assert.equal(
    (clean.json.warnings || []).some((line) => line.startsWith('task-artifact-missing:')),
    false,
    '已有 implementer 产物时不应再警告：' + JSON.stringify(clean.json.warnings),
  )
})

test('art 负向：sha256/path 越界/task-id 段/绝对路径/软链全部拒绝', () => {
  const root = freshProject('art-negative')
  const contract = loadContract(root).contract
  const task = addTaskCli(root, '负向产物', ['--stage', 'implementing'])
  const base = {
    role: 'implementer',
    stage: 'implementing',
    summary: '摘要',
    path: '.agents/reports/' + task.id + '/ok.md',
    sha256: 'a'.repeat(64),
    agent: '',
    at: '2026-11-13T16:00:00+08:00',
  }
  const writeArtifacts = (artifacts) => updateTask(root, contract, task.id, { artifacts }, { source: 'internal' })
  // 合法基线先过，证明拒绝来自具体字段而不是整体坏掉。
  assert.equal(writeArtifacts([base]).artifacts.length, 1)
  assert.throws(() => writeArtifacts([{ ...base, sha256: 'xyz' }]), /sha256/)
  assert.throws(() => writeArtifacts([{ ...base, path: '.agents/reports/' + task.id + '/../other/a.md' }]), /path/)
  assert.throws(() => writeArtifacts([{ ...base, path: '.agents/reports/T-OTHER/x.md' }]), /path/)
  assert.throws(() => writeArtifacts([{ ...base, path: '/tmp/abs.md' }]), /path/)

  // 拷贝源：仓外绝对路径、软链（即使是根内路径）都必须拒绝。
  const outside = path.join(os.tmpdir(), 'pf-art-outside-' + Date.now() + '.md')
  fs.writeFileSync(outside, 'outside bytes\n')
  const abs = runCli(root, ['task', 'art', 'put', task.id, '--role', 'implementer', '--summary', '越界', '--file', outside, '--json'])
  assert.equal(abs.code, 2, abs.stdout + abs.stderr)
  assert.equal(abs.json?.error?.code, 'invalid')

  const link = path.join(root, 'link-report.md')
  let symlinked = true
  try {
    fs.symlinkSync(outside, link)
  } catch {
    symlinked = false
  }
  if (symlinked) {
    const sym = runCli(root, ['task', 'art', 'put', task.id, '--role', 'implementer', '--summary', '软链', '--file', 'link-report.md', '--json'])
    assert.equal(sym.code, 2, '软链必须被拒：' + sym.stdout + sym.stderr)
    assert.match(sym.json.error.message, /symlink|regular file/)
  }
  fs.rmSync(outside, { force: true })
})

// ------------------------------- T-20261113163505：终态 cancelled（撤销）

test('cancelled：任意非终态可撤销但必须带 reason；无出边；列表/统计单列', () => {
  const root = freshProject('cancelled')
  const task = addTaskCli(root, '要撤销的卡', ['--stage', 'analyzing'])

  const missing = runCli(root, ['task', 'update', task.id, '--stage', 'cancelled', '--json'])
  assert.equal(missing.code, 1, '缺 reason 是用法错误')
  assert.match(missing.json.error.message, /--reason/)

  const cancelled = runCli(root, ['task', 'update', task.id, '--stage', 'cancelled', '--reason', '需求取消', '--json'])
  assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr)
  assert.equal(cancelled.json.data.stage, 'cancelled')
  assert.equal(cancelled.json.data.status, 'cancelled')
  assert.equal(cancelled.json.data.cancelReason, '需求取消')
  assert.match(String(cancelled.json.data.cancelled_at), /^\d{4}-\d{2}-\d{2}T/)

  const out = runCli(root, ['task', 'update', task.id, '--stage', 'done', '--json'])
  assert.equal(out.code, 2, 'cancelled 是终态：' + out.stdout + out.stderr)
  assert.match(out.json.error.message, /terminal|cannot move/)

  const listed = runCli(root, ['task', 'list', '--json'])
  assert.equal(listed.code, 0, listed.stderr)
  assert.equal(listed.json.data.find((row) => row.id === task.id).status, 'cancelled')
  const status = runCli(root, ['status', '--json'])
  assert.equal(status.json.data.counts.tasks.cancelled, 1, '撤销必须单列计数，不混入 done')
})

test('cancelled：rm 默认撤销（台账保留），--purge 才物理删除并写审计', () => {
  const root = freshProject('cancel-rm')
  const task = addTaskCli(root, '移除即撤销', ['--stage', 'implementing'])

  const noReason = runCli(root, ['task', 'rm', task.id, '--yes', '--json'])
  assert.equal(noReason.code, 1, 'rm 缺 --reason 是用法错误')

  const removed = runCli(root, ['task', 'rm', task.id, '--yes', '--reason', '重复卡', '--json'])
  assert.equal(removed.code, 0, removed.stdout + removed.stderr)
  assert.equal(removed.json.data.removed, false)
  assert.equal(removed.json.data.cancelled, true)
  assert.ok(fs.existsSync(taskFile(root, task.id)), '默认 rm 禁止物理删除')
  const after = runCli(root, ['task', 'show', task.id, '--json'])
  assert.equal(after.json.data.stage, 'cancelled')
  assert.equal(after.json.data.cancelReason, '重复卡')

  const purged = runCli(root, ['task', 'rm', task.id, '--yes', '--reason', '彻底清理', '--purge', '--json'])
  assert.equal(purged.code, 0, purged.stdout + purged.stderr)
  assert.equal(purged.json.data.purged, true)
  assert.equal(fs.existsSync(taskFile(root, task.id)), false)
  const auditDir = path.join(root, '.agents', 'flow', 'logs', 'task-purge')
  assert.ok(fs.existsSync(auditDir), '--purge 必须写审计目录')
  const audits = fs.readdirSync(auditDir).filter((name) => name.startsWith(task.id))
  assert.equal(audits.length, 1, '每次 purge 一条审计')
})

test('cancelled：mergedInto 预留字段（目标须存在、禁自指）；归档只从 done', () => {
  const root = freshProject('cancel-merge')
  const target = addTaskCli(root, '并入目标', ['--stage', 'analyzing'])
  const source = addTaskCli(root, '并入源', ['--stage', 'analyzing'])

  const unknown = runCli(root, ['task', 'update', source.id, '--stage', 'cancelled', '--reason', '并入', '--merged-into', 'T-NOPE', '--json'])
  assert.equal(unknown.code, 2, 'mergedInto 目标必须存在')
  assert.match(unknown.json.error.message, /mergedInto target not found/)

  const self = runCli(root, ['task', 'update', source.id, '--stage', 'cancelled', '--reason', '并入', '--merged-into', source.id, '--json'])
  assert.equal(self.code, 2, '禁止并入自己')

  const merged = runCli(root, ['task', 'update', source.id, '--stage', 'cancelled', '--reason', '并入目标卡', '--merged-into', target.id, '--json'])
  assert.equal(merged.code, 0, merged.stdout + merged.stderr)
  assert.equal(merged.json.data.mergedInto, target.id)

  const contract = loadContract(root).contract
  const file = taskFile(root, source.id)
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  record.updated_at = '2026-01-01T00:00:00+08:00'
  fs.writeFileSync(file, JSON.stringify(record, null, 1))
  const archived = archiveTasks(root, contract, { now: Date.parse('2026-06-01T00:00:00+08:00'), days: 7 })
  assert.equal(archived.archived.includes(source.id), false, 'cancelled 不得被归档清扫')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stage, 'cancelled')
})

