// 锁协议与原子写耐久性测试。
//
// 全部单进程、确定性：过期锁用「真实已死进程」的 pid 构造（`deadPid()`），
// 从不依赖真实时钟等待 30 秒，也不断言谁赢（并发留给了 concurrency.test.mjs）。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FlowError,
  addTask,
  drainWarnings,
  initProject,
  loadContract,
  renameWithRetrySync,
  storePaths,
  withLock,
} from '../lib/core.mjs'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const CORE_PATH = path.join(TEST_DIR, '..', 'lib', 'core.mjs')
const REPO_ROOT = path.join(TEST_DIR, '..')
const HOST_TAG = `${os.hostname()}|${process.platform}`

const tempDirs = []
after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort: a leftover temp dir must not fail the suite
    }
  }
})

/** A pid that is guaranteed to be gone: spawn a no-op, take its pid, then prove it is dead. */
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', ''])
  const pid = result.pid
  assert.equal(typeof pid, 'number', 'spawnSync should report the child pid')
  assert.throws(() => process.kill(pid, 0), `spawned helper pid ${pid} should already be reaped`)
  return pid
}

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-lock-${label}-`))
  tempDirs.push(root)
  initProject(root)
  const { contract } = loadContract(root)
  drainWarnings()
  return { root, contract, lockPath: path.join(root, '.dsh/flow/.lock') }
}

function readLock(lockPath) {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'))
}

function writeLock(lockPath, record) {
  fs.writeFileSync(lockPath, JSON.stringify(record))
}

function staleRecord(pid, secondsAgo, extra = {}) {
  return {
    schema: 1,
    pid,
    host: HOST_TAG,
    at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    token: 'stale-owner',
    ...extra,
  }
}

// ------------------------------------------------------------ A1 锁协议

test('锁协议 a：持锁记录含 schema/pid/host/at/token（UUID），退出即删除', () => {
  const { root, contract, lockPath } = freshProject('a')
  let inside
  withLock(root, contract, (paths) => {
    assert.equal(path.dirname(lockPath), paths.store)
    inside = readLock(lockPath)
  })
  assert.equal(inside.schema, 1)
  assert.equal(inside.pid, process.pid)
  assert.equal(inside.host, HOST_TAG, 'host 必须是 hostname|platform，区分 WSL/Windows PID namespace')
  assert.match(inside.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.match(inside.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.equal(fs.existsSync(lockPath), false, '正常结束应释放锁')
  assert.deepEqual(drainWarnings(), [])
})

test('锁协议 b：token 不匹配时只警告不删（不误删第三方新锁）', () => {
  const { root, contract, lockPath } = freshProject('b')
  const foreign = { schema: 1, pid: process.pid, host: HOST_TAG, at: new Date().toISOString(), token: 'foreign' }
  withLock(root, contract, () => {
    writeLock(lockPath, foreign)
  })
  assert.ok(fs.existsSync(lockPath), '别人的锁必须留在原地')
  assert.equal(readLock(lockPath).token, 'foreign')
  assert.ok(
    drainWarnings().some((item) => item.startsWith('lock-release-skipped:')),
    '应留下 lock-release-skipped warning',
  )
})

test('锁协议 c：锁不可读时释放只警告不删', () => {
  const { root, contract, lockPath } = freshProject('c')
  withLock(root, contract, () => {
    fs.writeFileSync(lockPath, 'not a json lock')
  })
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'not a json lock')
  assert.ok(drainWarnings().some((item) => item.startsWith('lock-release-skipped:')))
})

test('锁协议 d：过期但 owner 仍存活（本进程）→ conflict，且锁不被删', () => {
  const { root, contract, lockPath } = freshProject('d')
  writeLock(lockPath, staleRecord(process.pid, 60))
  assert.throws(
    () => withLock(root, contract, () => assert.fail('must not enter the critical section')),
    (error) => error instanceof FlowError && error.code === 'conflict' && /locked by another writer/.test(error.message),
  )
  assert.equal(readLock(lockPath).token, 'stale-owner', '冲突时不应擅自删掉他人锁')
})

test('锁协议 e：过期且 owner 已死 → 接管成功、lock-stale warning、结束后锁消失', () => {
  const { root, contract, lockPath } = freshProject('e')
  writeLock(lockPath, staleRecord(deadPid(), 60))
  drainWarnings()
  let entered = false
  withLock(root, contract, () => {
    entered = true
  })
  assert.equal(entered, true)
  const warnings = drainWarnings()
  assert.ok(warnings.some((item) => item.startsWith('lock-stale:')), `expected lock-stale, got ${warnings.join(' | ')}`)
  assert.equal(fs.existsSync(lockPath), false)
})

test('锁协议 f：旧形状 {pid,at} 无 token/host 仍可按 pid 接管（向后兼容）', () => {
  const { root, contract, lockPath } = freshProject('f')
  writeLock(lockPath, { pid: deadPid(), at: new Date(Date.now() - 120_000).toISOString() })
  drainWarnings()
  let entered = false
  withLock(root, contract, () => {
    entered = true
  })
  assert.equal(entered, true)
  assert.ok(drainWarnings().some((item) => item.startsWith('lock-stale:')))
  assert.equal(fs.existsSync(lockPath), false)
})

test('锁协议 g：新鲜锁即使 owner 已死也按年龄拒绝（不判活）', () => {
  const { root, contract, lockPath } = freshProject('g')
  writeLock(lockPath, staleRecord(deadPid(), 0))
  assert.throws(
    () => withLock(root, contract, () => assert.fail('must not enter the critical section')),
    (error) => error instanceof FlowError && error.code === 'conflict' && /locked by another writer/.test(error.message),
  )
  assert.ok(fs.existsSync(lockPath), '新鲜锁必须原样保留')
})

test('锁协议 h：异机锁 60 秒内只冲突，超过 60 秒才可接管（不调 kill）', () => {
  const { root, contract, lockPath } = freshProject('foreign')
  // pid 写成本进程：若实现错误地对异机锁调用 kill，会误判 ALIVE → 冲突。
  writeLock(lockPath, staleRecord(process.pid, 45, { host: 'other-host|linux' }))
  assert.throws(
    () => withLock(root, contract, () => assert.fail('must not enter the critical section')),
    (error) => error instanceof FlowError && error.code === 'conflict',
  )

  writeLock(lockPath, staleRecord(process.pid, 120, { host: 'other-host|linux' }))
  drainWarnings()
  let entered = false
  withLock(root, contract, () => {
    entered = true
  })
  assert.equal(entered, true, '异机锁超过 FOREIGN_STALE_MS 后应可接管（不判活）')
  assert.ok(drainWarnings().some((item) => item.startsWith('lock-stale:')))
  assert.equal(fs.existsSync(lockPath), false)
})

test('锁协议 i：不可解析锁按 mtime 判龄（45s 冲突 / 90s 接管且 pid 未知）', () => {
  const { root, contract, lockPath } = freshProject('unknown-lock')
  fs.writeFileSync(lockPath, 'garbage lock')
  const fourtyFive = new Date(Date.now() - 45_000)
  fs.utimesSync(lockPath, fourtyFive, fourtyFive)
  drainWarnings()
  assert.throws(
    () => withLock(root, contract, () => assert.fail('must not enter the critical section')),
    (error) => error instanceof FlowError && error.code === 'conflict' && /locked by another writer/.test(error.message),
  )
  assert.ok(fs.existsSync(lockPath), 'UNKNOWN 锁在 60 秒宽限期内必须保留')

  const ninety = new Date(Date.now() - 90_000)
  fs.utimesSync(lockPath, ninety, ninety)
  drainWarnings()
  let entered = false
  withLock(root, contract, () => {
    entered = true
  })
  assert.equal(entered, true)
  const warnings = drainWarnings()
  assert.ok(
    warnings.some((item) => item.startsWith('lock-stale:') && /pid \?/.test(item)),
    `UNKNOWN 锁的 lock-stale 应标 pid ?：${warnings.join(' | ')}`,
  )
  assert.equal(fs.existsSync(lockPath), false)
})

// ------------------------------------------------------- 接管 claim（F1/F2/F3）
//
// claim 是 `.lock.takeover-claim`（锁旁边、store 根内），只在接管过期锁时创建。
// 恢复必须是 CAS：rename 到 …takeover-claim.tmp-<pid>-<seq> → 回读比对 → 一致才删。
// 下面三条是确定性用例（不需要多进程），覆盖死 claim、零字节 claim、活 claim。

test('claim 恢复 CAS：死 pid claim 残留 → 立即恢复并接管成功，claim 消失', () => {
  const { root, contract, lockPath } = freshProject('claim-dead')
  const claimPath = `${lockPath}.takeover-claim`
  writeLock(lockPath, staleRecord(deadPid(), 60))
  writeLock(claimPath, staleRecord(deadPid(), 0))
  drainWarnings()

  let entered = false
  withLock(root, contract, () => {
    entered = true
  })
  assert.equal(entered, true)
  assert.equal(fs.existsSync(claimPath), false, '死 claim 必须被恢复清除')
  assert.equal(fs.existsSync(lockPath), false)
  const warnings = drainWarnings()
  assert.ok(warnings.some((item) => item.startsWith('lock-stale:')), warnings.join(' | '))
  assert.equal(
    warnings.some((item) => item.startsWith('lock-claim-stale:')),
    false,
    '死 claim 恢复是常规路径，不记 zombie 警告',
  )
})

test('claim 恢复 CAS：零字节 claim（mtime 90s）→ 恢复成功且无残留', () => {
  const { root, contract, lockPath } = freshProject('claim-empty')
  const claimPath = `${lockPath}.takeover-claim`
  writeLock(lockPath, staleRecord(deadPid(), 60))
  fs.writeFileSync(claimPath, '')
  const old = new Date(Date.now() - 90_000)
  fs.utimesSync(claimPath, old, old)
  drainWarnings()

  let entered = false
  withLock(root, contract, () => {
    entered = true
  })
  assert.equal(entered, true)
  assert.equal(fs.existsSync(claimPath), false)
  const leftovers = fs
    .readdirSync(path.dirname(lockPath))
    .filter((name) => name.includes('.takeover-claim') || name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'claim 恢复的临时副本必须落在清扫命名内且不残留')
})

test('claim 超时自愈：活 pid 但年龄 > 10 分钟的僵死 claim → 恢复并记 lock-claim-stale', () => {
  const { root, contract, lockPath } = freshProject('claim-zombie')
  const claimPath = `${lockPath}.takeover-claim`
  writeLock(lockPath, staleRecord(deadPid(), 60))
  writeLock(claimPath, {
    schema: 1,
    pid: process.pid,
    host: HOST_TAG,
    at: new Date(Date.now() - 11 * 60_000).toISOString(),
    token: 'zombie',
  })
  drainWarnings()

  let entered = false
  withLock(root, contract, () => {
    entered = true
  })
  assert.equal(entered, true, '僵死 claim 不应永久阻塞接管')
  assert.equal(fs.existsSync(claimPath), false)
  assert.equal(fs.existsSync(lockPath), false)
  const warnings = drainWarnings()
  assert.ok(
    warnings.some((item) => item.startsWith('lock-claim-stale: recovered ')),
    `expected lock-claim-stale, got ${warnings.join(' | ')}`,
  )
})

test('claim 恢复 CAS：活 claim 造成 conflict、claim 保留；无过期锁时不创建 claim', () => {
  const { root, contract, lockPath } = freshProject('claim-live')
  const claimPath = `${lockPath}.takeover-claim`
  writeLock(lockPath, staleRecord(deadPid(), 60))
  writeLock(claimPath, staleRecord(process.pid, 0))
  drainWarnings()

  assert.throws(
    () => withLock(root, contract, () => assert.fail('must not enter the critical section')),
    (error) =>
      error instanceof FlowError &&
      error.code === 'conflict' &&
      /takeover is already in progress/.test(error.message) &&
      error.message.includes(claimPath) &&
      /if no takeover is running, remove /.test(error.message),
  )
  assert.ok(fs.existsSync(claimPath), '活 claim 不能被恢复者删除')
  assert.equal(readLock(claimPath).pid, process.pid)

  // 没有过期锁时走普通获取路径：不得创建 claim。
  fs.rmSync(claimPath)
  fs.rmSync(lockPath)
  withLock(root, contract, () => {})
  assert.equal(fs.existsSync(claimPath), false, '普通获取不应创建 takeover claim')
})

// ------------------------------------------------------------ A3 原子写

test('原子写：fsync 在 rename 之前（源码断言；黑盒不可观测）', () => {
  const source = fs.readFileSync(CORE_PATH, 'utf8')
  const start = source.indexOf('function writeJsonAtomic(')
  assert.ok(start > 0, 'writeJsonAtomic 必须存在')
  const end = source.indexOf('\nfunction ', start + 1)
  const body = source.slice(start, end === -1 ? undefined : end)
  const fsyncAt = body.indexOf('fsyncSync(fd)')
  const renameAt = body.indexOf('renameWithRetrySync(temp, file)')
  assert.ok(fsyncAt > 0, 'writeJsonAtomic 必须 fsync 临时文件')
  assert.ok(renameAt > fsyncAt, 'fsync 必须发生在 rename 之前')
  assert.ok(body.includes('fsyncDirBestEffort(dirname(file))'), 'rename 后应对父目录 best-effort fsync')
})

test('原子写：rename 仅对 EPERM/EBUSY/EACCES 退避重试，最多 4 次', () => {
  const calls = []
  const sleeps = []
  const errors = [
    Object.assign(new Error('busy'), { code: 'EBUSY' }),
    Object.assign(new Error('perm'), { code: 'EPERM' }),
  ]
  renameWithRetrySync('from', 'to', {
    renameImpl: () => {
      calls.push('rename')
      if (calls.length <= errors.length) throw errors[calls.length - 1]
    },
    sleepImpl: (ms) => sleeps.push(ms),
  })
  assert.equal(calls.length, 3, '两次失败后成功，共 3 次 rename')
  assert.deepEqual(sleeps, [10, 50], '退避序列 10/50/150ms，只 sleep 失败间隔')

  let attempts = 0
  const exhaustedSleeps = []
  assert.throws(
    () =>
      renameWithRetrySync('from', 'to', {
        renameImpl: () => {
          attempts += 1
          throw Object.assign(new Error('denied'), { code: 'EACCES' })
        },
        sleepImpl: (ms) => exhaustedSleeps.push(ms),
      }),
    (error) => error instanceof FlowError && error.code === 'io' && /^cannot write /.test(error.message),
  )
  assert.equal(attempts, 4, '恒 EACCES 时共尝试 4 次')
  assert.deepEqual(exhaustedSleeps, [10, 50, 150])

  let permanentAttempts = 0
  const permanentSleeps = []
  assert.throws(
    () =>
      renameWithRetrySync('from', 'to', {
        renameImpl: () => {
          permanentAttempts += 1
          throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })
        },
        sleepImpl: (ms) => permanentSleeps.push(ms),
      }),
    (error) => error instanceof FlowError && error.code === 'io',
  )
  assert.equal(permanentAttempts, 1, 'ENOTDIR 不是瞬态错误，不应重试')
  assert.deepEqual(permanentSleeps, [])
})

test('陈旧 tmp：withLock 清理 10 分钟前的 .tmp-*，保留新鲜文件与非内部命名', () => {
  const { root, contract } = freshProject('sweep')
  const paths = storePaths(root, contract)
  const stale = path.join(paths.experiments, 'x.json.tmp-999999-0')
  const fresh = path.join(paths.experiments, `y.json.tmp-${process.pid}-0`)
  const takeover = path.join(paths.store, '.lock.takeover-999999-abcdef')
  const keepRecord = path.join(paths.tasks, 'keep.json')
  const keepUnknown = path.join(paths.tasks, 'weird.tmp-old')
  const keepDir = path.join(paths.tasks, 'dir.json.tmp-999999-1')
  for (const file of [stale, fresh, takeover, keepRecord, keepUnknown]) fs.writeFileSync(file, '{}')
  fs.mkdirSync(keepDir)
  const old = new Date(Date.now() - 11 * 60_000)
  fs.utimesSync(stale, old, old)
  fs.utimesSync(takeover, old, old)

  drainWarnings()
  withLock(root, contract, () => {})

  assert.equal(fs.existsSync(stale), false, '超过 10 分钟的 tmp 应被清理')
  assert.equal(fs.existsSync(takeover), false, '超过 10 分钟的 takeover 残留应被清理')
  assert.equal(fs.existsSync(fresh), true, '新鲜的 tmp 可能属于一个正在写的进程，必须保留')
  assert.equal(fs.existsSync(keepRecord), true, '.json 不是 tmp，绝不能删')
  assert.equal(fs.existsSync(keepUnknown), true, '未知名不匹配内部模式，绝不能删')
  assert.equal(fs.statSync(keepDir).isDirectory(), true, '目录（即使名字像 tmp）必须保留')
  assert.ok(
    drainWarnings().some((item) => item.startsWith('stale-temp-cleaned:')),
    '清理后应留下 stale-temp-cleaned warning',
  )
})

test('原子写：坏文件仍会 warning，成功写入后锁与 tmp 都不残留', () => {
  const { root, contract } = freshProject('write')
  const paths = storePaths(root, contract)
  const task = addTask(root, contract, { title: 'durable' })
  assert.equal(fs.existsSync(path.join(paths.store, '.lock')), false)
  const leftovers = fs
    .readdirSync(paths.tasks)
    .filter((name) => name.includes('.tmp-') || name.includes('.takeover-'))
  assert.deepEqual(leftovers, [])
  assert.equal(readLock(path.join(paths.tasks, `${task.id}.json`)).title, 'durable')
})

test('.gitignore 覆盖锁与内部临时文件', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')
  const lines = text.split('\n').map((line) => line.trim())
  for (const expected of ['.dsh/flow/.lock', '*.tmp-*', '.dsh/flow/.lock.takeover-*']) {
    assert.ok(lines.includes(expected), `.gitignore 缺少 ${expected}`)
  }
})
