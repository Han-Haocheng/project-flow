// T-20261111183641（fix/cas）：task revision 与 updateTask `expectedRevision` 的
// 核心/并发回归。
//
// 守三层：
//   ① `taskRevision`/`taskRevisionOf` 是确定性签名（键序无关、字段敏感、哈希磁盘
//      原记录而不是读投影）；
//   ② `updateTask` 只在 `expectedRevision` 等于当前签名时写入；陈旧签名抛 conflict
//      且磁盘零写入；
//   ③ 非字符串 / 空值的 `expectedRevision` 必须 invalid——静默忽略等于绕过 CAS。
//
// 并发层用两个真实子进程同时带着同一 revision 写：断言「恰好一个成功、一个
// conflict」，从不断言谁赢（由调度决定），避免 flaky。
//
// 只使用 os.tmpdir() 下的一次性项目，测试结束统一删除。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FlowError,
  addTask,
  getTask,
  initProject,
  loadContract,
  taskRevision,
  taskRevisionOf,
  updateTask,
} from '../lib/core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE_PATH = path.resolve(HERE, '..', 'lib', 'core.mjs')
const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort: a leftover temp dir must not fail the suite
    }
  }
})

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flow-cas-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function freshProject(label) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true })
  const { contract } = loadContract(root)
  return { root, contract }
}

function taskFile(root, id) {
  return path.join(root, '.agents', 'tasks', `${id}.json`)
}

function readTaskOnDisk(root, id) {
  return JSON.parse(fs.readFileSync(taskFile(root, id), 'utf8'))
}

function captureFlowError(fn) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof FlowError, `expected FlowError, got ${error?.name}: ${error?.message}`)
    return error
  }
  assert.fail('expected a FlowError, but the call returned normally')
}

function expectFlowError(fn, code, pattern) {
  const error = captureFlowError(fn)
  assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`)
  if (pattern !== undefined) assert.match(error.message, pattern)
  return error
}

// ------------------------------------------------------ ① revision 语义

test('taskRevision：键序无关、字段敏感、非法输入返回空串', () => {
  const base = {
    schema: 1,
    id: 'T-20261111120000',
    type: 'feat',
    title: 'cas',
    status: 'active',
    stage: 'analyzing',
    owner: '',
    notes: 'n',
    commits: ['abc1234'],
    checkpoints: [{ kind: 'dispatch', from: 'queued-analysis', to: 'analyzing' }],
    scope: { allow: ['lib/'], deny: [] },
    acceptance: ['cmd:true'],
    created_at: '2026-11-11T12:00:00+08:00',
    updated_at: '2026-11-11T12:00:01+08:00',
  }
  const revision = taskRevision(base)
  assert.match(revision, /^[0-9a-f]{16}$/, 'revision 是 16 位十六进制签名')

  // 键序（包括嵌套对象）不影响签名。
  const reordered = Object.fromEntries(Object.entries(base).reverse())
  const nestedReordered = { ...base, scope: { deny: [], allow: ['lib/'] } }
  assert.equal(taskRevision(reordered), revision)
  assert.equal(taskRevision(nestedReordered), revision)

  // 任一字段变化都换签名：阶段、notes、checkpoints、scope、时间戳。
  for (const [label, variant] of Object.entries({
    stage: { ...base, stage: 'implementing' },
    notes: { ...base, notes: 'changed' },
    checkpoints: { ...base, checkpoints: [] },
    scope: { ...base, scope: { allow: [], deny: [] } },
    updated_at: { ...base, updated_at: '2026-11-11T12:00:02+08:00' },
  })) {
    assert.notEqual(taskRevision(variant), revision, `${label} 变化必须换签名`)
  }

  for (const bad of [null, undefined, 'record', 42, true, []]) {
    assert.equal(taskRevision(bad), '', `非法输入 ${String(bad)} 应返回空串`)
  }
})

test('taskRevisionOf：读磁盘原记录，与 taskRevision(record) 一致，未找到抛 not-found', () => {
  const { root, contract } = freshProject('cas-revision-of')
  const created = addTask(root, contract, { type: 'feat', title: 'revision of' })
  const first = taskRevisionOf(root, contract, created.id)
  assert.match(first, /^[0-9a-f]{16}$/)
  assert.equal(first, taskRevision(readTaskOnDisk(root, created.id)))

  const updated = updateTask(root, contract, created.id, { notes: '改了 notes' })
  const second = taskRevisionOf(root, contract, created.id)
  assert.notEqual(second, first, '写后 revision 必须变化')
  assert.equal(second, taskRevision(readTaskOnDisk(root, created.id)))
  // updateTask 返回的是读投影（可能补 stage 等派生键），CAS 基准始终是磁盘原记录；
  // 二者不是同一形状，因此这里只断言返回对象确实反映了这次写入。
  assert.equal(updated.notes, '改了 notes')

  expectFlowError(() => taskRevisionOf(root, contract, 'T-19990101000000'), 'not-found')
})

test('taskRevisionOf 哈希磁盘记录而非读投影（dispatch 的首选能力探测）', () => {
  const { root, contract } = freshProject('cas-projection')
  const created = addTask(root, contract, { type: 'feat', title: 'legacy' })
  // 模拟 legacy 记录：磁盘上没有 type/stage，读投影会补齐它们；两者签名因此不同，
  // 而 CAS 基准必须来自磁盘原记录（否则派工读到的 revision 永远对不上）。
  const record = readTaskOnDisk(root, created.id)
  delete record.type
  delete record.stage
  fs.writeFileSync(taskFile(root, created.id), `${JSON.stringify(record, null, 2)}\n`)

  const revision = taskRevisionOf(root, contract, created.id)
  assert.equal(revision, taskRevision(record), 'taskRevisionOf 必须哈希磁盘记录')
  const projected = getTask(root, contract, created.id)
  assert.equal(projected.type, null, '读投影会补 type: null')
  assert.equal(typeof projected.stage, 'string', '读投影会派生 stage')
  assert.notEqual(taskRevision(projected), revision, '投影签名与磁盘签名不是同一基准')
})

// ------------------------------------------------------ ② CAS 写入

test('updateTask：正确 expectedRevision 放行，写后 revision 前移', () => {
  const { root, contract } = freshProject('cas-ok')
  const created = addTask(root, contract, { type: 'feat', title: 'cas ok' })
  const before = taskRevisionOf(root, contract, created.id)

  const updated = updateTask(
    root,
    contract,
    created.id,
    { notes: 'CAS 放行', status: 'active' },
    { expectedRevision: before },
  )
  assert.equal(updated.notes, 'CAS 放行')
  assert.equal(updated.status, 'active')

  const after = taskRevisionOf(root, contract, created.id)
  assert.notEqual(after, before)
  assert.equal(after, taskRevision(readTaskOnDisk(root, created.id)))
})

test('updateTask：stale expectedRevision 抛 conflict、零写入，文案给出重读入口', () => {
  const { root, contract } = freshProject('cas-stale')
  const created = addTask(root, contract, { type: 'feat', title: 'cas stale' })
  const stale = taskRevisionOf(root, contract, created.id)

  // 另一个会话先写成功（模拟「读取后被并发修改」）。
  updateTask(root, contract, created.id, { notes: '别人先写' })
  const current = taskRevisionOf(root, contract, created.id)
  assert.notEqual(current, stale)
  const bytesBefore = fs.readFileSync(taskFile(root, created.id), 'utf8')

  const error = expectFlowError(
    () => updateTask(root, contract, created.id, { notes: '我迟到的结论' }, { expectedRevision: stale }),
    'conflict',
    /revision mismatch/,
  )
  assert.match(error.message, new RegExp(stale), '冲突文案必须回显期望签名')
  assert.match(error.message, new RegExp(current), '冲突文案必须回显当前签名')
  assert.match(error.message, /stage=/, '冲突文案应带 stage，便于判断记录被谁推进')
  assert.match(error.message, /updated_at=/, '冲突文案应带 updated_at')
  assert.match(error.message, new RegExp(`flow task show ${created.id}`), '文案必须给出重读入口')

  assert.equal(fs.readFileSync(taskFile(root, created.id), 'utf8'), bytesBefore, '冲突必须零写入')
  assert.equal(getTask(root, contract, created.id).notes, '别人先写', '迟到的写入不得覆盖赢家')
})

test('updateTask：别的任务的 revision 同样不匹配（签名不是“任意 16 位串”）', () => {
  const { root, contract } = freshProject('cas-other-id')
  const first = addTask(root, contract, { type: 'feat', title: 'first' })
  const second = addTask(root, contract, { type: 'feat', title: 'second' })
  const otherRevision = taskRevisionOf(root, contract, second.id)

  expectFlowError(
    () => updateTask(root, contract, first.id, { notes: 'x' }, { expectedRevision: otherRevision }),
    'conflict',
    /revision mismatch/,
  )
  assert.equal(getTask(root, contract, first.id).notes, '')
})

test('updateTask：不传 expectedRevision 保持旧行为（向后兼容）', () => {
  const { root, contract } = freshProject('cas-absent')
  const created = addTask(root, contract, { type: 'feat', title: 'no cas' })
  const updated = updateTask(root, contract, created.id, { notes: '旧调用方' })
  assert.equal(updated.notes, '旧调用方')
})

// ----------------------------------------- ③ 非字符串 / 空值不得被忽略

test('updateTask：非字符串 expectedRevision 一律 invalid 且零写入（不能静默退化为无 CAS）', () => {
  const { root, contract } = freshProject('cas-non-string')
  const created = addTask(root, contract, { type: 'feat', title: 'bad type' })
  const bytesBefore = fs.readFileSync(taskFile(root, created.id), 'utf8')

  for (const [label, value] of Object.entries({
    number: 123,
    null: null,
    boolean: true,
    object: {},
    array: [],
    undefined: undefined,
  })) {
    const error = captureFlowError(() =>
      updateTask(root, contract, created.id, { notes: `bad ${label}` }, { expectedRevision: value }),
    )
    assert.equal(error.code, 'invalid', `${label} 应返回 invalid，实际 ${error.code}`)
    assert.match(error.message, /expectedRevision/, `${label} 的文案必须点名 expectedRevision`)
    assert.match(error.message, /非空字符串/, `${label} 的文案必须说明合法形状`)
    assert.equal(fs.readFileSync(taskFile(root, created.id), 'utf8'), bytesBefore, `${label} 不得产生写入`)
  }
})

test('updateTask：空串/空白 expectedRevision 同样 invalid（空值不是“省略”）', () => {
  const { root, contract } = freshProject('cas-blank')
  const created = addTask(root, contract, { type: 'feat', title: 'blank' })
  const bytesBefore = fs.readFileSync(taskFile(root, created.id), 'utf8')

  for (const value of ['', '   ', '\t\n']) {
    const error = captureFlowError(() =>
      updateTask(root, contract, created.id, { notes: `blank ${JSON.stringify(value)}` }, { expectedRevision: value }),
    )
    assert.equal(error.code, 'invalid')
    assert.match(error.message, /非空字符串/)
    assert.equal(fs.readFileSync(taskFile(root, created.id), 'utf8'), bytesBefore)
  }
  assert.equal(getTask(root, contract, created.id).notes, '')
})

// ------------------------------------------------------ ④ 真并发

const CHILD_SOURCE = `
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const [corePath, root, id, revision, readyFile, goFile, label] = process.argv.slice(2)
const core = await import(pathToFileURL(corePath).href)

fs.writeFileSync(readyFile, label)
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const deadline = Date.now() + 10000
while (!fs.existsSync(goFile)) {
  if (Date.now() > deadline) process.exit(3)
  Atomics.wait(sleeper, 0, 0, 2)
}

try {
  const { contract } = core.loadContract(root)
  let attempt = 0
  let task
  for (;;) {
    try {
      task = core.updateTask(root, contract, id, { notes: 'writer ' + label }, { expectedRevision: revision })
      break
    } catch (error) {
      /* 锁是「拒绝」而不是「排队」：另一个进程正在写时先退避重试，直到拿到锁后
         再让 CAS 判定。这样失败者一定是在读后写上撞到 revision mismatch，
         而不是把锁竞争误当成 CAS 结论。 */
      if (error && error.code === 'conflict' && /store is locked/.test(String(error.message)) && attempt < 100) {
        attempt += 1
        Atomics.wait(sleeper, 0, 0, 20)
        continue
      }
      throw error
    }
  }
  process.stdout.write(
    JSON.stringify({ ok: true, label, revision: core.taskRevisionOf(root, contract, id) }) + '\\n',
  )
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, label, code: error && error.code, message: error && error.message }) + '\\n',
  )
}
`

function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (!check()) {
    if (Date.now() > deadline) assert.fail(label)
    Atomics.wait(sleeper, 0, 0, 5)
  }
}

function collect(proc) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        proc.kill('SIGKILL')
      } catch {
        // already exited
      }
      resolve({ timedOut: true, stdout, stderr })
    }, 20_000)
    proc.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    proc.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    proc.on('error', (error) => {
      stderr += `spawn error: ${error.message}\n`
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

test('并发：两个子进程带同一 revision 同时写，恰好一个成功、一个 conflict', async () => {
  const { root, contract } = freshProject('cas-race')
  const created = addTask(root, contract, { type: 'feat', title: 'race' })
  const revision = taskRevisionOf(root, contract, created.id)
  assert.match(revision, /^[0-9a-f]{16}$/)

  const childFile = path.join(root, '.cas-child.mjs')
  fs.writeFileSync(childFile, CHILD_SOURCE)
  const goFile = path.join(root, '.cas-go')
  const jobs = ['A', 'B'].map((label) => {
    const readyFile = path.join(root, `.cas-ready-${label}`)
    const proc = spawn(process.execPath, [childFile, CORE_PATH, root, created.id, revision, readyFile, goFile, label], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { label, proc, readyFile }
  })

  const results = []
  try {
    waitFor(
      () => jobs.every((job) => fs.existsSync(job.readyFile)),
      `children did not become ready: ${jobs.map((job) => `${job.label}=${job.proc.exitCode ?? 'running'}`).join(', ')}`,
    )
    fs.writeFileSync(goFile, 'go')
    results.push(...(await Promise.all(jobs.map((job) => collect(job.proc)))))
  } finally {
    for (const job of jobs) {
      if (job.proc.exitCode === null && job.proc.signalCode === null) {
        try {
          job.proc.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  }

  const payloads = results.map((result, index) => {
    assert.notEqual(result.timedOut, true, `child ${jobs[index].label} timed out`)
    const line = result.stdout
      .split('\n')
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .pop()
    assert.ok(line, `child ${jobs[index].label} printed no result line: ${result.stderr.slice(-500)}`)
    return JSON.parse(line)
  })

  const wins = payloads.filter((payload) => payload.ok === true)
  const conflicts = payloads.filter((payload) => payload.ok === false)
  assert.equal(wins.length, 1, `exactly one writer wins: ${JSON.stringify(payloads)}`)
  assert.equal(conflicts.length, 1, `the loser must conflict, not crash: ${JSON.stringify(payloads)}`)
  assert.equal(conflicts[0].code, 'conflict')
  assert.match(conflicts[0].message, /revision mismatch/)

  // 磁盘只落下赢家那一次写入；stage/notes 不得出现两套互相矛盾的结论。
  const disk = readTaskOnDisk(root, created.id)
  assert.equal(disk.notes, `writer ${wins[0].label}`)
  assert.equal(getTask(root, contract, created.id).notes, `writer ${wins[0].label}`)
  // 赢家报回的 revision 必须等于「磁盘当前签名」。两边都取磁盘基准比较：
  // 子进程用 `taskRevisionOf`（读磁盘原记录，见 CHILD_SOURCE），这里也用
  // `taskRevisionOf` 重新读一次磁盘——**不要**拿 `taskRevision(返回记录)` 比，
  // `updateTask` 返回的是读投影（补派生 stage），与磁盘不是同一基准。
  assert.equal(wins[0].revision, taskRevisionOf(root, contract, created.id), '赢家返回的记录就是磁盘上的记录')
  assert.equal(wins[0].revision, taskRevision(disk), '赢家的 revision 等于本进程读到的磁盘签名')
  assert.notEqual(taskRevisionOf(root, contract, created.id), revision)

  // 失败事务不得留下锁或临时文件，任务目录仍只有那一条记录。
  assert.equal(fs.existsSync(path.join(root, '.agents', 'flow', '.lock')), false, 'no lock must remain')
  assert.deepEqual(
    fs.readdirSync(path.join(root, '.agents', 'tasks')),
    [`${created.id}.json`],
    'no half-written task files',
  )
})
