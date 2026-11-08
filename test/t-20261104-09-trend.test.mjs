// T-20261104-09 卡 A：任务进度趋势派生（`payload.tasks.trend`）。
//
// The ledger only keeps the current state, so the series is derived, never
// stored: `created` comes from `created_at` (exact), `done` / `archived` prefer
// `done_at` / `archived_at` and fall back to `updated_at` (approximate — any
// later patch resets it). The first day that leaned on a fallback is reported as
// `estimatedFrom` so the panel can mark that segment with `≈`.
//
// The tests pin: local-calendar day buckets (DST-safe), the window bounds
// (`to`=today, `from`=`to-(days-1)`), empty days inside the window, out-of-window
// and malformed records being ignored, the 60-day cap, the payload budget, and
// that building the snapshot writes nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addTask as addTaskCore, initProject, loadContract } from '../lib/core.mjs'

/** T-15: `addTask` now requires `type`; fixtures default to feat (use addTaskCore to test the missing-type error). */
function addTask(root, contract, input = {}, options) {
  return addTaskCore(root, contract, { type: 'feat', ...input }, options)
}
import { buildSnapshot, deriveTrend } from '../lib/state-snapshot.mjs'

const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime() // local 2026-11-04 12:00
/** Local-calendar ISO instant, so the test is timezone independent. */
const at = (month, day, hour = 10) => new Date(2026, month - 1, day, hour, 0, 0).toISOString()

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pf-trend-${label}-`))
}

test('deriveTrend: local-day buckets, window bounds and an empty day inside the window', () => {
  const tasks = [
    { id: 'T-1', status: 'active', created_at: at(11, 1) },
    { id: 'T-2', status: 'done', created_at: at(11, 1), updated_at: at(11, 2) },
    { id: 'T-3', status: 'done', created_at: at(10, 30), updated_at: at(11, 4) },
    { id: 'T-4', status: 'archived', created_at: at(10, 30), updated_at: at(11, 3) },
    { id: 'T-5', status: 'done', created_at: at(9, 1), updated_at: at(9, 2) }, // before the window
  ]
  const trend = deriveTrend(tasks, { now: NOW, days: 5 })

  assert.equal(trend.days, 5)
  assert.equal(trend.to, '2026-11-04', 'to must be the local day of now')
  assert.equal(trend.from, '2026-10-31', 'from must be to-(days-1) on the local calendar')
  assert.equal(trend.created.length, 5)
  assert.equal(trend.done.length, 5)
  assert.equal(trend.archived.length, 5)
  // 10-31 · 11-01 · 11-02 · 11-03 · 11-04
  assert.deepEqual(trend.created, [0, 2, 0, 0, 0], 'created is bucketed by created_at, exact')
  assert.deepEqual(trend.done, [0, 0, 1, 0, 1], 'done falls back to updated_at')
  assert.deepEqual(trend.archived, [0, 0, 0, 1, 0], 'archived falls back to updated_at')
  assert.equal(trend.estimatedFrom, '2026-11-02', 'the first approximated day must be reported')
})

test('deriveTrend: done_at / archived_at beat updated_at and clear estimatedFrom', () => {
  const exact = deriveTrend(
    [
      {
        id: 'T-1',
        status: 'done',
        created_at: at(11, 1),
        done_at: at(11, 2),
        updated_at: at(11, 4), // a later patch must not move the bar
      },
    ],
    { now: NOW, days: 5 }
  )
  assert.deepEqual(exact.done, [0, 0, 1, 0, 0], 'done_at wins over updated_at')
  assert.equal(exact.estimatedFrom, null, 'an exact done_at needs no ≈ marker')

  const archived = deriveTrend(
    [
      {
        id: 'T-2',
        status: 'archived',
        created_at: at(10, 1),
        archived_at: at(11, 3),
        updated_at: at(11, 4),
      },
    ],
    { now: NOW, days: 5 }
  )
  assert.deepEqual(archived.archived, [0, 0, 0, 1, 0], 'archived_at wins over updated_at')
  assert.equal(archived.estimatedFrom, null)
})

test('deriveTrend: out-of-window, future and malformed records are ignored without throwing', () => {
  const trend = deriveTrend(
    [
      { id: 'old', status: 'done', created_at: at(9, 1), updated_at: at(9, 2) },
      { id: 'future', status: 'done', created_at: '2099-01-01T00:00:00Z', updated_at: '2099-01-02T00:00:00Z' },
      { id: 'bad', status: 'done', created_at: 'not a date', updated_at: 'still not a date' },
      { id: 'empty', status: 'done' },
      null,
      'nope',
    ],
    { now: NOW, days: 5 }
  )
  assert.deepEqual(trend.created, [0, 0, 0, 0, 0])
  assert.deepEqual(trend.done, [0, 0, 0, 0, 0])
  assert.deepEqual(trend.archived, [0, 0, 0, 0, 0])
  assert.equal(trend.estimatedFrom, null)

  const empty = deriveTrend(undefined, { now: NOW })
  assert.equal(empty.days, 14, 'the default window is 14 days')
  assert.equal(empty.created.length, 14)
  assert.equal(empty.from, '2026-10-22')
  assert.equal(empty.estimatedFrom, null, 'an empty store has nothing to approximate')
  assert.ok(empty.created.every((value) => value === 0))
})

test('deriveTrend: the window is clamped to [1, 60] and the caller may widen estimatedFrom', () => {
  assert.equal(deriveTrend([], { now: NOW, days: 0 }).days, 1)
  assert.equal(deriveTrend([], { now: NOW, days: 1 }).days, 1)
  assert.equal(deriveTrend([], { now: NOW, days: 100 }).days, 60, 'MAX_TREND_DAYS caps the window')
  assert.equal(deriveTrend([], { now: NOW }).days, 14)

  const widened = deriveTrend([], {
    now: NOW,
    days: 5,
    estimatedFrom: '2026-11-01',
  })
  assert.equal(widened.estimatedFrom, '2026-11-01', 'a caller-reported approximation start is honored')
})

test('deriveTrend: 400 tasks stay well under 5ms (pure arithmetic, no fs)', () => {
  const tasks = Array.from({ length: 400 }, (_, index) => ({
    id: `T-${index}`,
    status: index % 3 === 0 ? 'done' : index % 3 === 1 ? 'active' : 'archived',
    created_at: at(10, 1 + (index % 28)),
    updated_at: at(11, 1 + (index % 4)),
    ...(index % 2 === 0 ? { done_at: at(11, 1 + (index % 4)) } : {}),
  }))
  deriveTrend(tasks, { now: NOW, days: 30 }) // warm up the JIT
  const runs = []
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now()
    const trend = deriveTrend(tasks, { now: NOW, days: 30 })
    runs.push(performance.now() - started)
    assert.equal(trend.created.length, 30)
  }
  const best = Math.min(...runs)
  assert.ok(best < 5, `deriveTrend(400 tasks) took ${best.toFixed(2)}ms, expected < 5ms`)
})

test('payload: tasks.trend is optional, bounded and never writes to the store', async () => {
  const root = tempRoot('payload')
  initProject(root, { name: 'trend', noGates: true })
  const { contract } = loadContract(root)
  addTask(root, contract, { title: 'chore: one', status: 'active', created_at: at(11, 1), updated_at: at(11, 1) })
  addTask(root, contract, { title: 'chore: two', status: 'done', created_at: at(11, 1), updated_at: at(11, 2) })
  addTask(root, contract, { title: 'chore: three', status: 'done', created_at: at(11, 2), updated_at: at(11, 4) })

  const storeDir = path.join(root, '.agents', 'flow')
  const snapshotStore = () => {
    const out = {}
    for (const relative of fs.readdirSync(storeDir, { recursive: true })) {
      const file = path.join(storeDir, relative)
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      out[relative] = { bytes: fs.readFileSync(file, 'utf8'), mtimeMs: stat.mtimeMs }
    }
    return out
  }

  const before = snapshotStore()
  const payload = await buildSnapshot({ root, now: NOW })
  const after = snapshotStore()

  assert.deepEqual(after, before, 'deriving the trend must not touch the store')
  const trend = payload.tasks && payload.tasks.trend
  assert.ok(trend, 'payload.tasks.trend is missing')
  assert.equal(trend.days, 14)
  assert.equal(trend.created.length, 14)
  assert.equal(trend.done.length, 14)
  const created = trend.created.reduce((sum, value) => sum + value, 0)
  assert.equal(created, 3, 'every task is counted once in the created series')
  const bytes = Buffer.byteLength(JSON.stringify(trend))
  assert.ok(bytes <= 1024, `the 14-day trend is ${bytes} B, expected <= 1024 B`)

  const wide = deriveTrend(
    Array.from({ length: 60 }, (_, index) => ({ id: `T-${index}`, status: 'active', created_at: at(10, 1 + (index % 28)) })),
    { now: NOW, days: 60 }
  )
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) <= 1024, 'the 60-day trend must stay under ~1 KB')
})
