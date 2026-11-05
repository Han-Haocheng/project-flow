// T-20261104-04 回归（T-05 后迁移）：请求级 realpath 去重的两个落点现在分居两个进程——
//
//   * 宿主请求路径：不再读 store，同步 fs（尤其 realpathSync）必须是 0 次；
//   * 快照函数（lib/state-snapshot.mjs 的 buildSnapshot，也是 fork 子进程里跑的代码）：
//     一次调用内同一路径的同步 realpath 至多 1 次，且 memo 每次调用新建（不跨请求复用）。
//
// 探针机制（与 t-20261104-01-state.test.mjs 同）：
//   node:fs 的 ESM 命名导出是模块槽绑定，`syncBuiltinESMExports()` 把 fs 对象上
//   *当前*的值同步进这些槽。顺序必须是「先静态导入 index.js / core.mjs，再 patch，
//   再 sync」；patch 生效期间不再动态 import 任何模块。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

import * as core from '../lib/core.mjs'
import { buildSnapshot } from '../lib/state-snapshot.mjs'

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
  // T-13 起默认只展示仍存活的心跳：fixture 用当前时间（无证据 → unknown，新鲜可见）。
  updated_at: new Date().toISOString(),
  turn: 1,
  stats: { steps: 1 },
})

// ------------------------------------------------------------- ctx + routes
const ORIGIN = 'http://127.0.0.1:3080'
const ROUTE = '/api/project-flow/state'
const routes = new Map()
const disposers = []
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
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  logger: { warn() {} },
}
plugin.apply(ctx, {})
const stateRoute = routes.get(ROUTE)
const readPanelState = plugin.panelStateReader(ctx)

function requestState() {
  return new Promise((settle) => {
    let guard
    const finish = (response) => {
      clearTimeout(guard)
      settle(response)
    }
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
        finish(this)
      },
      destroy() {
        finish(this)
      },
    }
    stateRoute.handler({ url: `${ROUTE}?root=${encodeURIComponent(ROOT)}`, method: 'GET', headers: {} }, response)
    // 兜底：handler 不 settle 时让用例失败而不是挂住测试进程（结束即清掉）。
    guard = setTimeout(() => finish(response), 20_000)
  })
}

// -------------------------------------------------------------------- probe
const SYNC_NAMES = ['realpathSync', 'statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'existsSync']
const ORIGINALS = Object.fromEntries(SYNC_NAMES.map((name) => [name, fs[name]]))
let counts = new Map()
let syncCalls = []

const installProbe = () => {
  counts = new Map()
  syncCalls = []
  for (const name of SYNC_NAMES) {
    fs[name] = function probedSync(target, ...rest) {
      const key = String(target)
      syncCalls.push(`${name}\t${key}`)
      if (name === 'realpathSync') counts.set(key, (counts.get(key) ?? 0) + 1)
      return ORIGINALS[name].call(this, target, ...rest)
    }
  }
  syncBuiltinESMExports()
}
const restoreProbe = () => {
  for (const name of SYNC_NAMES) fs[name] = ORIGINALS[name]
  syncBuiltinESMExports()
}
const insideRoot = (line) => {
  const target = line.split('\t')[1]
  return target === ROOT || target.startsWith(`${ROOT}${path.sep}`)
}
const repeatedOf = (map) => [...map].filter(([, n]) => n > 1)

/** One measured section: install, run, restore (restore runs even when `run` throws). */
async function measured(run) {
  installProbe()
  try {
    const value = await run()
    return { value, counts: new Map(counts), syncCalls: [...syncCalls] }
  } finally {
    restoreProbe()
  }
}

// -------------------------------------------------------------------- cases
test('宿主 GET state：store 读取在 fork 子进程里，主线程同步 realpathSync = 0', async () => {
  const { value: response, counts: seen, syncCalls: calls } = await measured(() => requestState())

  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body)
  // 快照确实被读出来了（证明是子进程完成，而不是宿主跳过了读）。
  assert.equal(payload.ok, true, JSON.stringify(payload.error ?? payload.warnings ?? null))
  assert.equal(payload.experiments.total, 1)
  assert.equal(payload.tasks.total, 1)
  assert.equal(payload.gates.length, 1)
  assert.equal(payload.decisions.counts.open, 1)
  assert.equal(payload.heartbeats.length, 1)

  assert.equal(seen.size, 0, `宿主请求路径不得出现同步 realpath：${JSON.stringify([...seen])}`)
  const storeCalls = calls.filter((line) => insideRoot(line))
  assert.deepEqual(storeCalls, [], `宿主请求路径不得同步访问被请求 root 内部：${JSON.stringify(storeCalls)}`)
})

test('宿主 panelStateReader（TUI 读路径）：同样 0 次同步 store 访问', async () => {
  const { value: payload, counts: seen, syncCalls: calls } = await measured(() => readPanelState(ROOT))

  assert.equal(payload.ok, true)
  assert.equal(payload.tasks.total, 1)
  assert.equal(seen.size, 0)
  assert.deepEqual(calls.filter((line) => insideRoot(line)), [])
})

test('快照函数：一次调用内同一路径的生命周期 realpath ≤1 次，且每次调用新建 memo', async () => {
  const snapshotOf = () => buildSnapshot({ root: ROOT, realRoot: ROOT, entry: { path: ROOT, name: 'memo-fixture' }, hostWarnings: [] })

  const first = await measured(snapshotOf)
  assert.equal(first.value.ok, true)
  assert.deepEqual(repeatedOf(first.counts), [], `同一快照内重复 realpath：${JSON.stringify([...first.counts])}`)
  assert.ok(first.counts.size >= 5, `期望 ≥5 个不同路径被校验，实际 ${first.counts.size}`)
  // 被请求 root 由 canonicalRoot 得到并预置进 memo：本函数内不再 realpath 一次。
  assert.equal(first.counts.get(ROOT) ?? 0, 0)

  // 第二次调用必须重新 realpath（memo 是每调用/每请求的，不是进程级缓存）。
  const second = await measured(snapshotOf)
  const repeatedPaths = [...first.counts.keys()].filter((key) => (second.counts.get(key) ?? 0) > 0)
  assert.ok(repeatedPaths.length >= 5, `第二次调用应重新解析同一批路径：${JSON.stringify([...second.counts])}`)
  assert.deepEqual(repeatedOf(second.counts), [])
})

test('快照函数并发隔离：两个同时在途的调用各解析一次，互不共享 memo', async () => {
  const snapshotOf = () => buildSnapshot({ root: ROOT, realRoot: ROOT, entry: { path: ROOT, name: 'memo-fixture' }, hostWarnings: [] })
  const { counts: seen } = await measured(() => Promise.all([snapshotOf(), snapshotOf()]))

  const flowDir = path.join(ROOT, '.dsh', 'flow')
  assert.equal(seen.get(flowDir), 2, `两个并发快照应各 realpath 一次 store 目录，实际 ${seen.get(flowDir) ?? 0}`)
  const overTwo = [...seen].filter(([, n]) => n > 2)
  assert.deepEqual(overTwo, [], `同一路径被解析超过 2 次，说明调用内未去重：${JSON.stringify(overTwo)}`)
})

test('core 对外同步 API 向后兼容：不传 memo 时仍逐次 realpath，结果与带 memo 完全一致', async () => {
  const loaded = core.loadContract(ROOT)
  const withoutMemo = await measured(async () => core.readStoreState(ROOT, loaded.contract))
  const withMemo = await measured(async () => core.readStoreState(ROOT, loaded.contract, { pathMemo: new Map() }))

  // 旧行为保留：CLI/工具共用路径没有 memo，仍按次 realpath（store 目录被多次校验）。
  const flowDir = path.join(ROOT, '.dsh', 'flow')
  assert.ok(
    (withoutMemo.counts.get(flowDir) ?? 0) >= 2,
    `无 memo 时应保持旧的逐次 realpath，实际 ${withoutMemo.counts.get(flowDir) ?? 0} 次`,
  )
  assert.deepEqual(repeatedOf(withMemo.counts), [])
  // 结果不因 memo 改变（containment 判定、store 路径、错误码都不变）。
  assert.deepEqual(withMemo.value, withoutMemo.value)
})

// 清理：关掉 worker 池（其子进程随 IPC 断开退出）、恢复 fs 内置、删除一次性 fixture。
after(() => {
  restoreProbe()
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      // ignore
    }
  }
  fs.rmSync(FIXTURE, { recursive: true, force: true })
})
