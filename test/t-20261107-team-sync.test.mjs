// task-73 P3a：团队板**只读**对账。零外部写入：createTask/updateTask/spawnTeammate/
// sendMessage 一个都不调用；reconcile 只返回三类结果，绝不写台账或团队板。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addTask, getTask, initProject, listTasks, loadContract, updateTask } from '../lib/core.mjs'
import { readTeamBoard, reconcile, teamStatusOf, teamTaskIdOf } from '../lib/team-sync.mjs'
import { buildStatusBlock } from '../lib/capture.mjs'

const TEMP_ROOTS = []

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

test('① team：create-only —— update 带 team 一律 invalid，即便值没变', () => {
  const { root, contract } = freshProject('update')
  const task = addTask(root, contract, { type: 'feat', title: 'x', team: TEAM })
  assert.throws(
    () => updateTask(root, contract, task.id, { team: { ...TEAM, revision: 4 } }),
    (error) => error.code === 'invalid' && /task team cannot be changed/.test(error.message)
  )
  assert.throws(
    () => updateTask(root, contract, task.id, { team: TEAM }),
    (error) => error.code === 'invalid' && /task team cannot be changed/.test(error.message),
    'an unchanged team is still a change attempt'
  )
  assert.deepEqual(getTask(root, contract, task.id).team, TEAM, 'the rejected patch must not write')
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
