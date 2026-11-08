// task-73 P3a：团队板**只读**对账。零外部写入：createTask/updateTask/spawnTeammate/
// sendMessage 一个都不调用；reconcile 只返回三类结果，绝不写台账或团队板。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { addTask, getTask, initProject, listTasks, loadContract, updateTask } from '../lib/core.mjs'
import { linkTask, readTeamBoard, reconcile, teamStatusOf, teamTaskIdOf, unlinkTask } from '../lib/team-sync.mjs'
import { buildStatusBlock } from '../lib/capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
const TEMP_ROOTS = []

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

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-t73-team-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t73-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

test.after(() => {
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

const TEAM = Object.freeze({
  taskId: 'team-task-1',
  revision: 3,
  owner: 'exec-panel',
  syncedAt: '2026-11-07T18:00:00+08:00',
})

// ---------------------------------------------------------------- ① team 字段

test('① team：创建白名单接受 {taskId, revision, owner, syncedAt} 并原样读回', () => {
  const { root, contract } = freshProject('field')
  const task = addTask(root, contract, { type: 'feat', title: '共享任务', team: TEAM })
  assert.deepEqual(task.team, TEAM)
  const read = getTask(root, contract, task.id)
  assert.deepEqual(read.team, TEAM, 'the read projection must keep the team link')
})

test('① team：owner 可为 null，缺省归一为 null', () => {
  const { root, contract } = freshProject('owner-null')
  const withNull = addTask(root, contract, { type: 'feat', title: 'a', team: { ...TEAM, owner: null } })
  assert.equal(withNull.team.owner, null)
  const omitted = addTask(root, contract, { type: 'feat', title: 'b', team: { taskId: 't2', revision: 0, syncedAt: '2026-11-07T18:00:00+08:00' } })
  assert.equal(omitted.team.owner, null, 'an omitted owner normalizes to null')
})

test('① team：非法字段一律 invalid（revision 负数/字符串、taskId 空、syncedAt 空、owner 类型）', () => {
  const { root, contract } = freshProject('invalid')
  const cases = [
    [{ ...TEAM, revision: -1 }, /team\.revision/],
    [{ ...TEAM, revision: '1' }, /team\.revision/],
    [{ ...TEAM, revision: 1.5 }, /team\.revision/],
    [{ ...TEAM, taskId: '  ' }, /team\.taskId/],
    [{ ...TEAM, syncedAt: '' }, /team\.syncedAt/],
    [{ ...TEAM, owner: 42 }, /team\.owner/],
    ['not-an-object', /team must be an object/],
  ]
  for (const [team, pattern] of cases) {
    assert.throws(
      () => addTask(root, contract, { type: 'feat', title: 'bad', team }),
      (error) => error.code === 'invalid' && pattern.test(error.message),
      `expected invalid for ${JSON.stringify(team)}`
    )
  }
  assert.equal(listTasks(root, contract).length, 0, 'a rejected add must not write a record')
})

// task-83 改写了这条契约：`team` 从"只可创建"改为"可更新"，但**只由专用入口写**
// （`linkTask`/`unlinkTask`）。core 的 patch 路径仍做形状校验，且工具面白名单不含它。
test('① team：可更新，但只走专用入口——core patch 仍做形状校验', () => {
  const { root, contract } = freshProject('update')
  const task = addTask(root, contract, { type: 'feat', title: 'x', team: TEAM })

  // 形状合法的 patch 现在能写（单写者仍是 core；入口由 linkTask/unlinkTask 收口）
  const moved = updateTask(root, contract, task.id, { team: { ...TEAM, revision: 4 } })
  assert.equal(moved.team.revision, 4)
  assert.deepEqual(getTask(root, contract, task.id).team, { ...TEAM, revision: 4 })

  // 形状非法 → invalid，且不落盘
  for (const bad of [
    { taskId: '' },
    { taskId: 'x', revision: -1 },
    { taskId: 'x', revision: 1.5 },
    { taskId: 'x', revision: 0, owner: 42 },
    { taskId: 'x', revision: 0, syncedAt: '' },
    'not-an-object',
  ]) {
    assert.throws(
      () => updateTask(root, contract, task.id, { team: bad }),
      (error) => error.code === 'invalid' && /^team/.test(error.message),
      `非法 team 必须被拒：${JSON.stringify(bad)}`,
    )
  }
  assert.equal(getTask(root, contract, task.id).team.revision, 4, '被拒的 patch 不得写盘')

  // 工具面白名单不含 team：会话无法通过 flow_task 改链接（源文本断言，防"两处口径"）
  const toolsSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'plugin', 'shared.mjs'), 'utf8')
  const updateFields = /TASK_UPDATE_FIELDS = Object\.freeze\(\[([^\]]*)\]/.exec(toolsSource)
  assert.ok(updateFields, '找不到 TASK_UPDATE_FIELDS 定义')
  assert.equal(/['"]team['"]/.test(updateFields[1]), false, '工具面不得暴露 team')
})

test('① team：缺失完全不影响存量行为（没有 team 字段的记录照常读写）', () => {
  const { root, contract } = freshProject('absent')
  const task = addTask(root, contract, { type: 'fix', title: 'without team' })
  assert.equal(Object.hasOwn(task, 'team'), false, 'no team key is invented')
  updateTask(root, contract, task.id, { notes: 'updated' })
  const read = getTask(root, contract, task.id)
  assert.equal(Object.hasOwn(read, 'team'), false)
  assert.equal(read.notes, 'updated')
})

// ------------------------------------------------------- ② 只读对账（team-sync）

/** Fake `agents`-style context: `get('agentTeams')` returns the service. */
function teamCtx(service) {
  return { get: (name) => (name === 'agentTeams' ? service : undefined) }
}

function boardTask(id, revision = 1) {
  return {
    id,
    revision,
    subject: 'board ' + id,
    description: '',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
  }
}

const FAKE_AGENT = { id: 'session-main', session: { cwd: '/tmp/whatever' } }

test('② 无团队服务：readTeamBoard 返回 {ok:false}，不抛', () => {
  const board = readTeamBoard({ get: () => undefined }, FAKE_AGENT)
  assert.equal(board.ok, false)
  assert.equal(board.reason, 'no-team-service')
  // 服务缺失但 ctx.get 抛错也不能炸
  const throwing = readTeamBoard({ get: () => { throw new Error('no such service') } }, FAKE_AGENT)
  assert.equal(throwing.ok, false)
})

test('② 无 caller：服务在、agent 缺失 → {ok:false, reason:"no-caller"}（真实 API 需要 caller）', () => {
  const service = { listTasks: () => [], listMembers: () => [] }
  const board = readTeamBoard(teamCtx(service), undefined)
  assert.equal(board.ok, false)
  assert.equal(board.reason, 'no-caller')
})

test('② 正例：2 张板上任务 → readTeamBoard 形状正确，reconcile matched 2', async () => {
  const { root, contract } = freshProject('matched')
  addTask(root, contract, { type: 'feat', title: 'a', team: { taskId: 'T-A', revision: 2, owner: 'exec-panel', syncedAt: '2026-11-07T18:00:00+08:00' } })
  addTask(root, contract, { type: 'feat', title: 'b', team: { taskId: 'T-B', revision: 1, owner: null, syncedAt: '2026-11-07T18:01:00+08:00' } })
  const service = {
    listTasks: () => [boardTask('T-A', 2), boardTask('T-B', 1)],
    listMembers: () => [
      { id: 's1', name: 'lead', role: 'lead', status: 'running' },
      { id: 's2', name: 'exec-panel', role: 'teammate', status: 'inactive' },
    ],
  }
  const board = readTeamBoard(teamCtx(service), FAKE_AGENT)
  assert.equal(board.ok, true)
  assert.equal(board.members.length, 2)
  assert.equal(board.tasks.length, 2)
  assert.deepEqual(board.tasks[0], {
    id: 'T-A',
    revision: 2,
    subject: 'board T-A',
    status: 'pending',
    owner: null,
    blockedBy: [],
    writeScopes: [],
  })
  const result = await reconcile(root, contract, board)
  /* Arrays carry **ledger** task ids: "which of my tasks matched". `orphaned`
     carries board ids, because it names board rows no ledger task owns. */
  assert.deepEqual(result.matched.sort(), listTasks(root, contract).map((task) => task.id).sort())
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.orphaned, [])
})

test('② missing：台账有链接、板上没有 → missing 1，不删记录、不抛', async () => {
  const { root, contract } = freshProject('missing')
  const task = addTask(root, contract, { type: 'feat', title: 'gone', team: { taskId: 'T-GONE', revision: 3, owner: null, syncedAt: '2026-11-07T18:00:00+08:00' } })
  const board = readTeamBoard(teamCtx({ listTasks: () => [], listMembers: () => [] }), FAKE_AGENT)
  const result = await reconcile(root, contract, board)
  assert.deepEqual(result.matched, [])
  assert.deepEqual(result.missing, [task.id])
  assert.deepEqual(result.orphaned, [])
  assert.ok(getTask(root, contract, task.id), 'a read must not delete the ledger record')
})

test('② orphaned：板上多一条台账没有的 → orphaned 1', async () => {
  const { root, contract } = freshProject('orphaned')
  addTask(root, contract, { type: 'feat', title: 'linked', team: { taskId: 'T-A', revision: 1, owner: null, syncedAt: '2026-11-07T18:00:00+08:00' } })
  const board = readTeamBoard(
    teamCtx({ listTasks: () => [boardTask('T-A'), boardTask('T-ORPHAN')], listMembers: () => [] }),
    FAKE_AGENT
  )
  const result = await reconcile(root, contract, board)
  assert.equal(result.matched.length, 1)
  assert.deepEqual(result.orphaned, ['T-ORPHAN'])
})

test('② 坏服务：返回非数组/抛错 → {ok:false}，reconcile 对不可用板返回空三类', async () => {
  const { root, contract } = freshProject('bad-service')
  const throwing = { listTasks: () => { throw new Error('boom') }, listMembers: () => [] }
  assert.equal(readTeamBoard(teamCtx(throwing), FAKE_AGENT).ok, false)
  const bad = { listTasks: () => ({ not: 'an array' }), listMembers: () => [] }
  assert.equal(readTeamBoard(teamCtx(bad), FAKE_AGENT).ok, false)
  addTask(root, contract, { type: 'feat', title: 'x', team: { taskId: 'T-A', revision: 1, owner: null, syncedAt: '2026-11-07T18:00:00+08:00' } })
  const result = await reconcile(root, contract, { ok: false, reason: 'no-team-service' })
  assert.deepEqual(result, { matched: [], missing: [], orphaned: [] }, 'an unavailable board yields empty classes, not a crash')
})

test('② teamTaskIdOf：无 team / 坏 team / 空 taskId 一律 ""', () => {
  assert.equal(teamTaskIdOf({}), '')
  assert.equal(teamTaskIdOf({ team: null }), '')
  assert.equal(teamTaskIdOf({ team: { taskId: '  ' } }), '')
  assert.equal(teamTaskIdOf({ team: { taskId: 'T-A' } }), 'T-A')
})

// ------------------------------------------------------------ ③ 状态块 team 分支

const coreDouble = () => ({ listTasks })

test('③ 状态块：没有 team 参数 → available:false + 0 计数（不假装 0）', () => {
  const block = buildStatusBlock(coreDouble(), '/tmp/none', {})
  assert.deepEqual(block.team, { available: false, members: 0, tasks: 0, linked: 0, missing: 0, orphaned: 0 })
})

test('③ 状态块：传入真实 teamStatusOf 结果 → 原样投影（含 available:true）', () => {
  const block = buildStatusBlock(coreDouble(), '/tmp/none', {}, {
    available: true,
    members: 3,
    tasks: 4,
    linked: 3,
    missing: 1,
    orphaned: 2,
  })
  assert.deepEqual(block.team, { available: true, members: 3, tasks: 4, linked: 3, missing: 1, orphaned: 2 })
})

test('③ 状态块：畸形 team 参数降级为 available:false，不崩', () => {
  for (const bad of [{ available: 'yes', members: -3, tasks: 'x' }, 'nope', null, 7]) {
    const block = buildStatusBlock(coreDouble(), '/tmp/none', {}, bad)
    assert.deepEqual(block.team, { available: false, members: 0, tasks: 0, linked: 0, missing: 0, orphaned: 0 })
  }
})

test('③ teamStatusOf：无服务 → available:false 且 members/tasks 保留 0（带 reason 供诊断）', async () => {
  const { root, contract } = freshProject('status-unavailable')
  const status = await teamStatusOf({ get: () => undefined }, FAKE_AGENT, root, contract)
  assert.equal(status.available, false)
  assert.equal(status.members, 0)
  assert.equal(status.tasks, 0)
  assert.equal(status.linked, 0)
  assert.equal(status.reason, 'no-team-service')
})

test('③ teamStatusOf：真实读取 → members/tasks/linked/missing/orphaned 全来自对账', async () => {
  const { root, contract } = freshProject('status-real')
  addTask(root, contract, { type: 'feat', title: 'a', team: { taskId: 'T-A', revision: 1, owner: null, syncedAt: '2026-11-07T18:00:00+08:00' } })
  addTask(root, contract, { type: 'feat', title: 'b', team: { taskId: 'T-B', revision: 1, owner: null, syncedAt: '2026-11-07T18:00:00+08:00' } })
  addTask(root, contract, { type: 'feat', title: 'c', team: { taskId: 'T-GONE', revision: 1, owner: null, syncedAt: '2026-11-07T18:00:00+08:00' } })
  const service = {
    listTasks: () => [boardTask('T-A'), boardTask('T-B'), boardTask('T-ORPHAN')],
    listMembers: () => [
      { id: 's1', name: 'lead', role: 'lead', status: 'running' },
      { id: 's2', name: 'p', role: 'teammate', status: 'running' },
      { id: 's3', name: 'q', role: 'teammate', status: 'inactive' },
    ],
  }
  const status = await teamStatusOf(teamCtx(service), FAKE_AGENT, root, contract)
  assert.deepEqual(status, { available: true, members: 3, tasks: 3, linked: 2, missing: 1, orphaned: 1 })
  // 同一结果喂给状态块，字段不丢。
  const block = buildStatusBlock(coreDouble(), root, contract, status)
  assert.deepEqual(block.team, status)
})

// ------------------------------------------------------- ⑥ 零写入（本卡最重要）

/** Every regular file under `dir`: relative path → {sha256, mtimeMs}. */
function fingerprint(dir) {
  const out = new Map()
  const walk = (current, prefix) => {
    for (const name of fs.readdirSync(current).sort()) {
      const abs = path.join(current, name)
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) {
        walk(abs, prefix === '' ? name : prefix + '/' + name)
        continue
      }
      if (stat.isFile() === false) continue
      const rel = prefix === '' ? name : prefix + '/' + name
      out.set(rel, {
        sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
        mtimeMs: stat.mtimeMs,
      })
    }
  }
  walk(dir, '')
  return out
}

test('⑥ 零写入：跑完 readTeamBoard + reconcile + teamStatusOf 后，台账每个文件 mtime/sha256/文件数不变', async () => {
  const { root, contract } = freshProject('readonly')
  addTask(root, contract, { type: 'feat', title: 'linked', team: { taskId: 'T-A', revision: 1, owner: null, syncedAt: '2026-11-07T18:00:00+08:00' } })
  addTask(root, contract, { type: 'feat', title: 'missing', team: { taskId: 'T-GONE', revision: 1, owner: null, syncedAt: '2026-11-07T18:00:00+08:00' } })
  addTask(root, contract, { type: 'fix', title: 'plain' })
  const storeDir = path.join(root, '.dsh', 'flow')
  const before = fingerprint(storeDir)
  const beforeCount = before.size
  assert.ok(beforeCount >= 2, 'the fixture must contain ledger files')

  const service = {
    listTasks: () => [boardTask('T-A'), boardTask('T-ORPHAN')],
    listMembers: () => [{ id: 's1', name: 'lead', role: 'lead', status: 'running' }],
  }
  const ctx = teamCtx(service)
  const board = readTeamBoard(ctx, FAKE_AGENT)
  assert.equal(board.ok, true)
  await reconcile(root, contract, board)
  const status = await teamStatusOf(ctx, FAKE_AGENT, root, contract)
  assert.deepEqual(status, { available: true, members: 1, tasks: 2, linked: 1, missing: 1, orphaned: 1 })
  buildStatusBlock({ listTasks }, root, contract, status)

  const after = fingerprint(storeDir)
  assert.equal(after.size, beforeCount, 'file count changed (a read must not add/remove ledger files)')
  assert.deepEqual([...after.keys()], [...before.keys()], 'the file set changed')
  for (const [file, snapshot] of before) {
    assert.equal(after.get(file).mtimeMs, snapshot.mtimeMs, `mtime changed for ${file} (a read wrote it)`)
    assert.equal(after.get(file).sha256, snapshot.sha256, `content changed for ${file} (a read wrote it)`)
  }
  // 台账内容仍可读且与跑之前一致。
  assert.equal(listTasks(root, contract).length, 3)
})

// ================================================================= task-83 P3b ①
//
// 本地挂载链路：`linkTask`/`unlinkTask` **只写本地台账**，一个 Team 服务调用都没有。
// 它们不是状态推进——挂载前后 `stage`/`status` 必须逐字不变（变异会打这条）。

test('④ linkTask：写入正确 team，且 stage/status 一字不动', () => {
  const { root, contract } = freshProject('link')
  // 夹具用 analyzing：若实现里偷偷写 stage:'implementing'，这里立刻可见
  const task = addTask(root, contract, { type: 'feat', title: '挂载', stage: 'analyzing' })
  const before = getTask(root, contract, task.id)
  assert.equal(before.stage, 'analyzing')
  assert.equal(before.status, 'active')

  const linked = linkTask(root, contract, task.id, 'board-42')
  assert.deepEqual(linked.team, {
    taskId: 'board-42',
    revision: 0,
    owner: null,
    syncedAt: linked.team.syncedAt,
  })
  assert.match(linked.team.syncedAt, /^\d{4}-\d{2}-\d{2}T/)
  // 挂载不是状态推进
  assert.equal(linked.stage, before.stage, 'linkTask 不许改 stage')
  assert.equal(linked.status, before.status, 'linkTask 不许改 status')
  assert.equal(linked.title, before.title)
  assert.equal(getTask(root, contract, task.id).team.taskId, 'board-42', '必须落盘')

  // 显式 options 原样写入
  const custom = linkTask(root, contract, task.id, 'board-43', {
    revision: 7,
    owner: 'exec-core',
    syncedAt: '2026-11-08T10:00:00+08:00',
  })
  assert.deepEqual(custom.team, { taskId: 'board-43', revision: 7, owner: 'exec-core', syncedAt: '2026-11-08T10:00:00+08:00' })
})

test('⑤ unlinkTask：team 置 null（键保留=显式解除，不是从没挂过），stage/status 不动', () => {
  const { root, contract } = freshProject('unlink')
  const task = addTask(root, contract, { type: 'fix', title: '解除', stage: 'reviewing' })
  linkTask(root, contract, task.id, 'board-9')
  const before = getTask(root, contract, task.id)

  const unlinked = unlinkTask(root, contract, task.id)
  assert.equal(unlinked.team, null, 'unlink 后必须是 null')
  assert.equal(Object.hasOwn(getTask(root, contract, task.id), 'team'), true, '键要保留：null 表示"已解除"')
  assert.equal(unlinked.stage, before.stage)
  assert.equal(unlinked.status, before.status)
})

test('⑥ linkTask 之后 reconcile 计入 matched（不再 orphaned）', async () => {
  const { root, contract } = freshProject('reconcile-link')
  const task = addTask(root, contract, { type: 'feat', title: '对账' })
  linkTask(root, contract, task.id, 'board-77')

  const board = {
    ok: true,
    members: [],
    tasks: [{ id: 'board-77', title: '板上任务' }],
  }
  const result = await reconcile(root, contract, board)
  assert.ok(result.matched.includes(task.id), `matched 必须包含 ${task.id}，实际 ${JSON.stringify(result)}`)
  assert.deepEqual(result.orphaned, [], '板上那条被挂上了，不再是 orphaned')
  assert.deepEqual(result.missing, [])
})

test('⑦ linkTask 入参校验：空 board id / 非法 revision / 任务不存在 → 明确的错误', () => {
  const { root, contract } = freshProject('link-invalid')
  const task = addTask(root, contract, { type: 'feat', title: '校验' })

  for (const [fn, label] of [
    [() => linkTask(root, contract, task.id, ''), '空 board id'],
    [() => linkTask(root, contract, task.id, '   '), '纯空白 board id'],
    [() => linkTask(root, contract, task.id, 'b', { revision: -1 }), 'revision 负数'],
    [() => linkTask(root, contract, task.id, 'b', { revision: 1.5 }), 'revision 非整数'],
    [() => linkTask(root, contract, task.id, 'b', { owner: 42 }), 'owner 类型'],
    [() => linkTask(root, contract, task.id, 'b', { syncedAt: '' }), 'syncedAt 空'],
  ]) {
    assert.throws(fn, (error) => error.code === 'invalid', `${label} 必须 invalid`)
  }
  assert.throws(
    () => linkTask(root, contract, 'T-19990101-01', 'b'),
    (error) => error.code === 'not-found',
    '不存在的任务必须 not-found（不是静默创建）',
  )
  assert.equal(getTask(root, contract, task.id).team, undefined, '被拒的调用不得写盘')
})

test('⑧ CLI：flow task link/unlink 真实子进程跑通（--json 信封 + 落盘）', () => {
  const { root } = freshProject('cli-link')
  const created = runCli(root, ['task', 'add', '--type', 'feat', '--title', 'CLI 挂载', '--stage', 'reviewing', '--json'])
  assert.equal(created.code, 0, created.stdout + created.stderr)
  const taskId = created.json.data.id

  const linked = runCli(root, ['task', 'link', taskId, '--team', 'board-cli-1', '--json'])
  assert.equal(linked.code, 0, linked.stdout + linked.stderr)
  assert.equal(linked.json.data.team.taskId, 'board-cli-1')
  assert.equal(linked.json.data.stage, 'reviewing', 'CLI 挂载也不许动 stage')
  assert.equal(linked.json.data.status, 'active')
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.dsh', 'flow', 'tasks', `${taskId}.json`), 'utf8'))
  assert.equal(onDisk.team.taskId, 'board-cli-1')
  assert.equal(onDisk.stage, 'reviewing')
  assert.equal(onDisk.status, 'active')

  const unlinked = runCli(root, ['task', 'unlink', taskId, '--json'])
  assert.equal(unlinked.code, 0, unlinked.stdout + unlinked.stderr)
  assert.equal(unlinked.json.data.team, null)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.dsh', 'flow', 'tasks', `${taskId}.json`), 'utf8')).team, null)
  assert.equal(unlinked.json.data.stage, 'reviewing', 'unlink 同样不许动 stage')
})

test('⑨ CLI：link 缺 --team / 多余参数 → usage exit 1（不是静默成功）', () => {
  const { root } = freshProject('cli-usage')
  const created = runCli(root, ['task', 'add', '--type', 'feat', '--title', '用法', '--json'])
  const taskId = created.json.data.id

  const noTeam = runCli(root, ['task', 'link', taskId, '--json'])
  assert.equal(noTeam.code, 1)
  assert.equal(noTeam.json.error.code, 'usage')

  const extra = runCli(root, ['task', 'link', taskId, '--team', 'b', 'oops', '--json'])
  assert.equal(extra.code, 1)
  assert.equal(extra.json.error.code, 'usage')
})
