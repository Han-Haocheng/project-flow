// aspect 锁 waiter 的两项非阻塞修复（T-20261112183138 的 P3 备查项）：
//
//   ① waiters 按 since 过期：ASPECT_WAITER_TTL_MS（默认 10 分钟，可用
//      PROJECT_FLOW_ASPECT_WAITER_TTL_MS 或 waiterTtlMs 注入覆盖）之外的排队者
//      在读取/清扫时被丢弃；since 解析失败按过期处理（不抛）。FIFO 上限
//      ASPECT_WAITER_MAX=20 的截断保持不变。
//   ② 幂等重试零写盘：同一 session 已在 waiters 且内容不变时，轮询中的 acquire
//      不再重写锁文件；只在首次挂入或内容变化时写。since 保持首次入队时间。
//
// 用例只碰 os.tmpdir() 下的一次性项目，不依赖仓库真源。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initProject, loadContract } from '../lib/core.mjs'
import {
  ASPECT_WAITER_TTL_MS,
  acquireAspectLock,
  listAspectLocks,
  sweepAspectLocks,
} from '../lib/host/aspect-lock.mjs'

const ASPECT = 'state-machine'
const TEMP_ROOTS = []

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-aspect-waiter-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `aspect-waiter-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

function lockFileOf(root) {
  return path.join(root, '.agents', 'aspect-locks', ASPECT + '.json')
}

function readRecord(root) {
  return JSON.parse(fs.readFileSync(lockFileOf(root), 'utf8'))
}

function writeRecord(root, record) {
  fs.writeFileSync(lockFileOf(root), JSON.stringify(record, null, 2))
}

function statOf(root) {
  return fs.statSync(lockFileOf(root), { bigint: true })
}

after(() => {
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

test('waiter TTL：since 超期/无法解析的排队者被丢弃（不抛）', async () => {
  const { root, contract } = freshProject('stale')
  await acquireAspectLock(root, contract, {
    aspect: ASPECT,
    session: 'session-owner',
    ttlSeconds: 600,
    waiterTtlMs: ASPECT_WAITER_TTL_MS,
  })
  await acquireAspectLock(root, contract, {
    aspect: ASPECT,
    session: 'session-stale',
    waitMs: 0,
    waiterTtlMs: ASPECT_WAITER_TTL_MS,
  })
  const now = Date.now()

  const record = readRecord(root)
  assert.equal(record.waiters.length, 1)
  record.waiters[0].since = new Date(now - ASPECT_WAITER_TTL_MS - 60_000).toISOString()
  writeRecord(root, record)
  const listed = listAspectLocks(root, contract, { now, waiterTtlMs: ASPECT_WAITER_TTL_MS })
  assert.deepEqual(listed.items[0].waiters, [], '超过默认 TTL 的 waiter 从读投影里丢弃')

  record.waiters[0].since = 'not-a-date'
  writeRecord(root, record)
  assert.deepEqual(
    listAspectLocks(root, contract, { now, waiterTtlMs: ASPECT_WAITER_TTL_MS }).items[0].waiters,
    [],
    'since 解析失败按过期处理',
  )

  record.waiters[0].since = null
  writeRecord(root, record)
  assert.deepEqual(
    listAspectLocks(root, contract, { now, waiterTtlMs: ASPECT_WAITER_TTL_MS }).items[0].waiters,
    [],
    'since 形状不对也按过期处理',
  )
})

test('waiter TTL：未超期保留原 since；注入 TTL 可覆盖', async () => {
  const { root, contract } = freshProject('fresh')
  await acquireAspectLock(root, contract, {
    aspect: ASPECT,
    session: 'session-owner',
    ttlSeconds: 600,
    waiterTtlMs: ASPECT_WAITER_TTL_MS,
  })
  await acquireAspectLock(root, contract, {
    aspect: ASPECT,
    session: 'session-fresh',
    waitMs: 0,
    waiterTtlMs: ASPECT_WAITER_TTL_MS,
  })

  const now = Date.now()
  const record = readRecord(root)
  record.waiters[0].since = new Date(now - 60_000).toISOString()
  writeRecord(root, record)

  const kept = listAspectLocks(root, contract, { now, waiterTtlMs: ASPECT_WAITER_TTL_MS })
  assert.equal(kept.items[0].waiters.length, 1)
  assert.equal(kept.items[0].waiters[0].session, 'session-fresh')
  assert.equal(kept.items[0].waiters[0].since, record.waiters[0].since, '保留首次入队时间，不刷新')

  // 注入更短的 TTL：同样 60s 前的 waiter 视为过期；注入更长则保留。
  assert.deepEqual(listAspectLocks(root, contract, { now, waiterTtlMs: 30_000 }).items[0].waiters, [])
  assert.equal(listAspectLocks(root, contract, { now, waiterTtlMs: 120_000 }).items[0].waiters.length, 1)
})

test('waiter TTL：环境变量可覆盖默认值（毫秒）', async () => {
  const { root, contract } = freshProject('env')
  await acquireAspectLock(root, contract, { aspect: ASPECT, session: 'session-owner', ttlSeconds: 600 })
  await acquireAspectLock(root, contract, { aspect: ASPECT, session: 'session-env', waitMs: 0 })
  const record = readRecord(root)
  record.waiters[0].since = new Date(Date.now() - 2 * 60_000).toISOString()
  writeRecord(root, record)

  const previous = process.env.PROJECT_FLOW_ASPECT_WAITER_TTL_MS
  process.env.PROJECT_FLOW_ASPECT_WAITER_TTL_MS = '60000'
  try {
    assert.deepEqual(listAspectLocks(root, contract).items[0].waiters, [], 'env 60s < 2min → 过期')
  } finally {
    if (previous === undefined) delete process.env.PROJECT_FLOW_ASPECT_WAITER_TTL_MS
    else process.env.PROJECT_FLOW_ASPECT_WAITER_TTL_MS = previous
  }
  assert.equal(
    listAspectLocks(root, contract, { waiterTtlMs: ASPECT_WAITER_TTL_MS }).items[0].waiters.length,
    1,
    '恢复默认 10min 后重新可见',
  )
  assert.equal(ASPECT_WAITER_TTL_MS, 10 * 60 * 1000)
})

test('waiter TTL：sweep 清理活锁里的过期 waiter，owner 不动', async () => {
  const { root, contract } = freshProject('sweep')
  await acquireAspectLock(root, contract, {
    aspect: ASPECT,
    session: 'session-owner',
    ttlSeconds: 600,
    waiterTtlMs: ASPECT_WAITER_TTL_MS,
  })
  await acquireAspectLock(root, contract, {
    aspect: ASPECT,
    session: 'session-stale',
    waitMs: 0,
    waiterTtlMs: ASPECT_WAITER_TTL_MS,
  })
  await acquireAspectLock(root, contract, {
    aspect: ASPECT,
    session: 'session-fresh',
    waitMs: 0,
    waiterTtlMs: ASPECT_WAITER_TTL_MS,
  })
  const now = Date.now()
  const record = readRecord(root)
  record.waiters.find((waiter) => waiter.session === 'session-stale').since = new Date(
    now - ASPECT_WAITER_TTL_MS - 60_000,
  ).toISOString()
  writeRecord(root, record)

  const swept = sweepAspectLocks(root, contract, { now, waiterTtlMs: ASPECT_WAITER_TTL_MS })
  assert.deepEqual(swept.released, [], '占用方仍活着 → 不释放锁')
  assert.deepEqual(swept.kept.map((item) => item.aspect), [ASPECT])
  const afterSweep = readRecord(root)
  assert.deepEqual(afterSweep.waiters.map((waiter) => waiter.session), ['session-fresh'], '活锁只清 waiter')
  assert.equal(afterSweep.owner.session, 'session-owner')
})

test('幂等重试：同一 session 的 waiter 不变时，轮询不重写锁文件', async () => {
  const { root, contract } = freshProject('idempotent')
  await acquireAspectLock(root, contract, {
    aspect: ASPECT,
    session: 'session-owner',
    ttlSeconds: 600,
    waiterTtlMs: ASPECT_WAITER_TTL_MS,
  })
  const ownerStat = statOf(root)

  const first = await acquireAspectLock(root, contract, {
    aspect: ASPECT,
    session: 'session-wait',
    waitMs: 0,
    waiterTtlMs: ASPECT_WAITER_TTL_MS,
  })
  assert.equal(first.acquired, false)
  assert.equal(first.holder.waiters.length, 1)
  const enqueuedStat = statOf(root)
  assert.notEqual(enqueuedStat.ino, ownerStat.ino, '首次挂入 waiter 必须写盘')

  const before = statOf(root)
  const recordBefore = readRecord(root)
  // 350ms / 10ms ≈ 35 次轮询：每次都会重读锁，但 waiter 内容不变 → 一次都不写。
  const again = await acquireAspectLock(root, contract, {
    aspect: ASPECT,
    session: 'session-wait',
    waitMs: 350,
    pollMs: 10,
    waiterTtlMs: ASPECT_WAITER_TTL_MS,
  })
  assert.equal(again.acquired, false)
  const after = statOf(root)
  assert.equal(after.ino, before.ino, 'inode 不变 = 没有发生原子重写（rename）')
  assert.equal(after.mtimeNs, before.mtimeNs, 'mtime 不变 = 轮询零写盘')
  assert.deepEqual(readRecord(root), recordBefore)
  assert.equal(recordBefore.waiters[0].since, first.holder.waiters[0].since, 'since 保持首次入队时间')
})

test('waiter FIFO：上限截断仍保留最近 20 个', async () => {
  const { root, contract } = freshProject('fifo')
  await acquireAspectLock(root, contract, {
    aspect: ASPECT,
    session: 'session-owner',
    ttlSeconds: 600,
    waiterTtlMs: ASPECT_WAITER_TTL_MS,
  })
  for (let index = 0; index <= 20; index += 1) {
    await acquireAspectLock(root, contract, {
      aspect: ASPECT,
      session: 'session-wait-' + String(index).padStart(2, '0'),
      waitMs: 0,
      waiterTtlMs: ASPECT_WAITER_TTL_MS,
    })
  }
  const waiters = readRecord(root).waiters
  assert.equal(waiters.length, 20, 'ASPECT_WAITER_MAX=20')
  assert.equal(waiters[0].session, 'session-wait-01', 'FIFO 丢掉最早的一个')
  assert.equal(waiters[19].session, 'session-wait-20')
  assert.equal(listAspectLocks(root, contract).items[0].waiters.length, 20)
})
