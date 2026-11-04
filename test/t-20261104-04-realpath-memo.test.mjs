// T-20261104-04 回归：一次 GET state / panelStateReader 内，同一路径的同步
// realpathSync 至多 1 次；memo 是「每请求」的，绝不是进程级缓存。
//
// 探针机制（与 t-20261104-01-state.test.mjs 同）：
//   node:fs 的 ESM 命名导出是模块槽绑定，`syncBuiltinESMExports()` 把 fs 对象上
//   *当前*的值同步进这些槽。因此顺序必须是「先静态导入 index.js / core.mjs（与生产
//   同序），再 patch fs.realpathSync，再 sync」；patch 生效期间不再动态 import 任何
//   模块（ESM loader 自己也用 realpathSync 加载源码，会被计入）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

import * as core from '../lib/core.mjs'

// 静态导入已完成，此时还没有任何 patch。
const plugin = await import('../index.js')

// ------------------------------------------------------------------ fixture
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-realpath-memo-'))
const ROOT = path.join(FIXTURE, 'project')
fs.mkdirSync(ROOT, { recursive: true })
const writeJson = (rel, value) => {
  const file = path.join(ROOT, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
const STAMP = '2026-01-01T00:00:00+08:00'
writeJson('.dsh/flow/flow.json', {
  schema: 2,
  name: 'memo-fixture',
  // 相对但当前不存在的文件：containment 会走「最近存在祖先」的失败回溯，
  // 这正是一请求内最容易被重复 realpath 的形态。
  tasks: { current: 'notes/current.md' },
})
writeJson('.dsh/flow/experiments/E-20260101-01.json', {
  schema: 1,
  id: 'E-20260101-01',
  title: 'exp one',
  hypothesis: 'h',
  factor: 'f',
  expected: 'e',
  measured: 'm',
  status: 'open',
  created_at: STAMP,
  updated_at: STAMP,
})
writeJson('.dsh/flow/tasks/T-20260101-01.json', {
  schema: 1,
  id: 'T-20260101-01',
  title: 'task one',
  status: 'active',
  created_at: STAMP,
  updated_at: STAMP,
})
writeJson('.dsh/flow/gates/precommit.json', { schema: 1, id: 'precommit', title: 'precommit', enabled: true, steps: [] })
writeJson('.dsh/flow/logs/precommit/run-1.json', {
  schema: 1,
  id: 'run-1',
  started_at: STAMP,
  finished_at: STAMP,
  ok: true,
  steps: [],
})
writeJson('.dsh/flow/decisions/D-20260101-01.json', {
  schema: 1,
  id: 'D-20260101-01',
  question: 'q',
  kind: 'choice',
  status: 'open',
  options: [{ id: 'a', label: 'A', impact: 'x' }],
  recommendation: 'a',
  rationale: 'r',
  created_at: STAMP,
  updated_at: STAMP,
})
writeJson('.agents/heartbeat/session-a.json', {
  schema: 1,
  session: 'session-a',
  workspace: 'memo',
  goal: 'g',
  status: 'working',
  started_at: STAMP,
  updated_at: STAMP,
  turn: 1,
  stats: { steps: 1 },
})

// ------------------------------------------------------------- ctx + routes
const ORIGIN = 'http://127.0.0.1:3080'
const ROUTE = '/api/project-flow/state'
const routes = new Map()
const services = {
  webServer: {
    getOrigin: () => ORIGIN,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  workspaceRegistry: { list: () => [{ path: ROOT, title: 'memo-fixture' }] },
}
const ctx = {
  get: (name) => services[name],
  effect: (callback) => {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  logger: { warn() {} },
}
plugin.apply(ctx, {})
const stateRoute = routes.get(ROUTE)
const readPanelState = plugin.panelStateReader(ctx)

function requestState() {
  return new Promise((settle) => {
    const response = {
      statusCode: 0,
      body: '',
      headersSent: false,
      finished: false,
      writeHead(status) {
        this.statusCode = status
        this.headersSent = true
        return this
      },
      setHeader() {},
      end(body) {
        if (this.finished) return
        this.finished = true
        this.body = body === undefined ? '' : String(body)
        settle(this)
      },
      destroy() {
        settle(this)
      },
    }
    stateRoute.handler({ url: `${ROUTE}?root=${encodeURIComponent(ROOT)}`, method: 'GET', headers: {} }, response)
    const guard = setTimeout(() => settle(response), 20_000)
    guard.unref()
  })
}

// -------------------------------------------------------------------- probe
const ORIGINAL_REALPATH = fs.realpathSync
let counts = new Map()
const installProbe = () => {
  counts = new Map()
  fs.realpathSync = function probedRealpath(target, ...rest) {
    const key = String(target)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return ORIGINAL_REALPATH.call(this, target, ...rest)
  }
  syncBuiltinESMExports()
}
const restoreProbe = () => {
  fs.realpathSync = ORIGINAL_REALPATH
  syncBuiltinESMExports()
}
const totalOf = (map) => [...map.values()].reduce((sum, n) => sum + n, 0)
const repeatedOf = (map) => [...map].filter(([, n]) => n > 1)

/** One measured section: install, run, restore (restore runs even when `run` throws). */
async function measured(run) {
  const before = new Map(counts)
  installProbe()
  try {
    const value = await run()
    return { value, counts: new Map(counts), before }
  } finally {
    restoreProbe()
  }
}

// -------------------------------------------------------------------- cases
test('GET state：每个路径的同步 realpath 至多 1 次，且被请求 root 不再重复 realpath', async () => {
  const { value: response, counts: seen } = await measured(() => requestState())

  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true, JSON.stringify(payload.error ?? payload.warnings ?? null))
  // 语义不变：四个 section 都读到了 fixture 的记录。
  assert.equal(payload.experiments.total, 1)
  assert.equal(payload.tasks.total, 1)
  assert.equal(payload.gates.length, 1)
  assert.equal(payload.decisions.counts.open, 1)
  assert.equal(payload.heartbeats.length, 1)

  const repeated = repeatedOf(seen)
  assert.deepEqual(
    repeated,
    [],
    `同一请求内不得重复 realpath：${repeated.map(([p, n]) => `${n}x ${p}`).join(', ')}`,
  )
  // 至少覆盖 store 目录 + 心跳目录 + tasks.current 的失败回溯。
  assert.ok(seen.size >= 6, `期望 ≥6 个不同路径被校验，实际 ${seen.size}`)
  assert.ok(totalOf(seen) >= seen.size)
  // root 本身由 canonicalRoot 的异步 realpath 得到并预置进 memo：同步 realpath 0 次。
  assert.equal(seen.get(ROOT) ?? 0, 0, '被请求 root 不得再做一次同步 realpath')
})

test('panelStateReader（TUI 读路径）：同样每路径 ≤1 次', async () => {
  const { value: payload, counts: seen } = await measured(() => readPanelState(ROOT))

  assert.equal(payload.ok, true)
  assert.deepEqual(repeatedOf(seen), [], `TUI 读路径重复 realpath：${repeatedOf(seen).map(([p]) => p).join(', ')}`)
  assert.ok(seen.size >= 5)
})

test('memo 是每请求的：相邻两次请求各自重新 realpath（没有进程级缓存）', async () => {
  const flowDir = path.join(ROOT, '.dsh', 'flow')
  const first = await measured(() => requestState())
  const second = await measured(() => requestState())

  assert.equal(first.counts.get(flowDir), 1, '第一次请求应 realpath 一次 store 目录')
  // 若存在进程级缓存，第二次请求会是 0 次——这正是「挂载状态会变」不允许的。
  assert.equal(second.counts.get(flowDir), 1, '第二次请求必须重新 realpath（不得跨请求复用）')
  assert.equal(totalOf(second.counts), totalOf(first.counts), '两次请求的调用规模应一致')
  assert.deepEqual(repeatedOf(first.counts), [])
  assert.deepEqual(repeatedOf(second.counts), [])
})

test('并发隔离：两个同时在途的请求各自解析一次，互不共享 memo', async () => {
  const flowDir = path.join(ROOT, '.dsh', 'flow')
  // 两个 handler 在同一事件循环上交错执行（每个 await 都让出）：各自的 Map 互不可见。
  const { counts: seen } = await measured(() => Promise.all([requestState(), requestState()]))

  // 若共享了进程级/请求间缓存，第二次会出现 1 次而不是 2 次；
  // 若同一请求内重复解析，则会 >2 次。
  assert.equal(seen.get(flowDir), 2, `两个并发请求应各 realpath 一次 store 目录，实际 ${seen.get(flowDir) ?? 0}`)
  assert.ok(totalOf(seen) >= seen.size)
  const overTwo = [...seen].filter(([, n]) => n > 2)
  assert.deepEqual(overTwo, [], `同一路径被解析超过 2 次，说明请求内未去重：${overTwo.map(([p, n]) => `${n}x ${p}`).join(', ')}`)
})

test('core 对外同步 API 向后兼容：不传 memo 时仍逐次 realpath，结果与带 memo 完全一致', async () => {
  const loaded = core.loadContract(ROOT)
  const withoutMemo = await measured(async () => core.readStoreState(ROOT, loaded.contract))
  const withMemo = await measured(async () => core.readStoreState(ROOT, loaded.contract, { pathMemo: new Map() }))

  // 旧行为保留：CLI/工具共用路径没有 memo，仍按次 realpath（这里 store 目录被多次校验）。
  const flowDir = path.join(ROOT, '.dsh', 'flow')
  assert.ok(
    (withoutMemo.counts.get(flowDir) ?? 0) >= 2,
    `无 memo 时应保持旧的逐次 realpath，实际 ${withoutMemo.counts.get(flowDir) ?? 0} 次`,
  )
  // 带 memo 时同一次调用内每路径 ≤1。
  assert.deepEqual(repeatedOf(withMemo.counts), [])
  // 结果不因 memo 改变（containment 判定、store 路径、错误码都不变）。
  assert.deepEqual(withMemo.value, withoutMemo.value)
})
