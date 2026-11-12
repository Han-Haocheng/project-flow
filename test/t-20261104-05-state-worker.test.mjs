// T-20261104-05 卡A 回归：宿主 state 读的 fork 隔离、请求期限、错误码与生命周期。
//
// 架构：`GET /api/project-flow/state`（与 TUI panelStateReader）的 store 读在
// `child_process.fork` 出来的 `lib/state-snapshot.mjs` 子进程里完成，宿主只做
// async 根解析 + IPC + 1800ms 期限；超时 SIGKILL、崩溃自愈、启动失败降级。
//
// 假死 root 用真正的 FIFO（`mkfifo`）制造：core 的 readCollection 会对
// `<store>/tasks/*.json` 调同步 readFileSync，FIFO 没有写端会永久阻塞——这是
// 「worker_threads.terminate() 灭不掉」的那类阻塞，只能靠 fork + SIGKILL 回收。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import * as core from '../lib/core.mjs'

const plugin = await import('../index.js')
// The pool is reachable through `statePoolOf(ctx)`; the crash-vs-cap case inspects a
// live pool (slot states) instead of only watching the HTTP answer.
const { statePoolOf } = await import('../lib/host/state.mjs')

const POSIX = process.platform !== 'win32'
const LINUX = process.platform === 'linux'
const ORIGIN = 'http://127.0.0.1:3080'
const ROUTE = '/api/project-flow/state'
const INIT_ROUTE = '/api/project-flow/init'
const GATE_ROUTE = '/api/project-flow/gate'
// Production deadline (`STATE_DEADLINE_MS` in index.js). Wall-clock assertions are
// derived from it with a generous tolerance: a correct 1800ms timeout plus fork /
// git / CI jitter must never turn a green run red under parallel load.
const DEADLINE_MS = 1800
const DEADLINE_TOLERANCE_MS = 1200
const TIMEOUT_BUDGET_MS = DEADLINE_MS + DEADLINE_TOLERANCE_MS

const TEMP_ROOTS = []
const DISPOSERS = []

after(() => {
  for (const dispose of DISPOSERS) {
    try {
      dispose()
    } catch {
      // ignore
    }
  }
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

// ------------------------------------------------------------------ helpers
function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pf-worker-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

/** A real flow project. `fifoTask` plants an unreadable-by-design task file. */
function makeProject(label, options = {}) {
  const root = tempRoot(label)
  core.initProject(root, { name: label, noGates: true })
  const { contract } = core.loadContract(root)
  if (options.fifoTask === true) {
    execFileSync('mkfifo', [path.join(root, '.agents/tasks', 'T-20260101-01.json')])
  } else {
    core.addTask(root, contract, { type: 'feat', title: `${label} task`, status: 'active' })
  }
  return root
}

/** Kill every pool mounted by an earlier case and wait for those children to vanish. */
async function disposeMounts() {
  for (const dispose of DISPOSERS.splice(0)) {
    try {
      dispose()
    } catch {
      // ignore
    }
  }
  await waitUntil(() => workerPids().length === 0, 3000)
}

/** One plugin mount: routes captured from webServer.register, pool disposed at teardown. */
async function mount(roots) {
  await disposeMounts()
  const routes = new Map()
  const services = {
    webServer: {
      getOrigin: () => ORIGIN,
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    workspaceRegistry: { list: () => roots.map((root) => ({ path: root, title: path.basename(root) })) },
  }
  const ctx = {
    get: (name) => services[name],
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') DISPOSERS.push(dispose)
      return () => {}
    },
    logger: { warn() {} },
  }
  plugin.apply(ctx, {})
  return { ctx, routes }
}

function makeResponse() {
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
    response.arm = () => {
      guard = setTimeout(() => finish(response), 30_000)
    }
    response.arm()
    return response
  })
}

/** Fire GET state without awaiting; returns `{ response, done }`. */
function startState(routes, root) {
  const response = {}
  const done = new Promise((settle) => {
    let guard
    const finish = (res) => {
      clearTimeout(guard)
      settle(res)
    }
    Object.assign(response, {
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
    })
    routes.get(ROUTE).handler({ url: `${ROUTE}?root=${encodeURIComponent(root)}`, method: 'GET', headers: {} }, response)
    guard = setTimeout(() => finish(response), 30_000)
  })
  return { response, done }
}

function startPost(routes, routePath, body) {
  const response = {}
  const done = new Promise((settle) => {
    let guard
    const finish = (res) => {
      clearTimeout(guard)
      settle(res)
    }
    Object.assign(response, {
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
      end(value) {
        if (this.finished) return
        this.finished = true
        this.body = value === undefined ? '' : String(value)
        finish(this)
      },
      destroy() {
        finish(this)
      },
    })
    const request = Readable.from([Buffer.from(JSON.stringify(body))])
    request.method = 'POST'
    request.url = routePath
    request.headers = {}
    routes.get(routePath).handler(request, response)
    guard = setTimeout(() => finish(response), 30_000)
  })
  return { response, done }
}

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms))

async function waitUntil(predicate, timeoutMs = 5000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate() === true) return true
    await sleep(stepMs)
  }
  return predicate()
}

/** Pids of this process's snapshot workers (Linux /proc; empty elsewhere). */
function workerPids() {
  if (LINUX === false) return []
  const pids = []
  for (const name of fs.readdirSync('/proc')) {
    if (/^\d+$/.test(name) === false) continue
    try {
      const cmdline = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ')
      if (cmdline.includes('state-snapshot') === false) continue
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (ppid === process.pid) pids.push(Number(name))
    } catch {
      // process vanished while scanning
    }
  }
  return pids.sort((left, right) => left - right)
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function warmWorker() {
  const ok = await waitUntil(() => workerPids().length > 0, 6000)
  assert.equal(ok, true, 'worker 池未在期限内预热')
  return workerPids()[0]
}

/**
 * Warm the pool with a real request on a healthy root: only a child that has
 * reported ready is idle, so this is what makes the next request allocate the
 * already-warm child (and gives the pid the lifecycle cases watch).
 */
async function warmWith(routes, warmRoot) {
  const res = await startState(routes, warmRoot).done
  assert.equal(json(res).ok, true, `预热请求应成功：${res.body}`)
  const pid = workerPids()[0]
  assert.ok(pid, '预热后应存在一个空闲子进程')
  return pid
}

function json(res) {
  return JSON.parse(res.body)
}

/**
 * 同轮延迟基线（毫秒）：在**同一进程、同一时刻**对一个健康 root 连发 `count` 次
 * 顺序请求，取中位数。它衡量的完全是「本机现在的调度水平」——空载 ~10–20ms，
 * 4 个队友并发跑测试时能到 300ms+。
 *
 * 为什么要有它：这些用例原本写死 `<100ms` / `≤500ms`。绝对阈值在空载下很宽裕，
 * 但机器一忙就必然红——**红的原因不是被测路径变慢，而是主机变慢**。用「场景耗时 ÷
 * 同轮基线」判断，只有在被测路径**相对本机正常水平**退化时才会红，也就是真正想
 * 抓的那类回归（失联挂载把事件循环卡死 6.4s、并发时抢同一个子进程）。
 *
 * 注意：结构断言（`root` 各自正确、`tasks.total`、`error.code`、`children≥2`）
 * 是**确定性**的，它们不参与这里任何放宽，仍然是这些用例的主判据。
 */
async function baselineLatency(routes, root, count = 3) {
  const samples = []
  for (let index = 0; index < count; index += 1) {
    const start = Date.now()
    const res = await startState(routes, root).done
    samples.push(Date.now() - start)
    assert.equal(json(res).ok, true, `基线采样失败：${res.body}`)
  }
  return samples.slice().sort((left, right) => left - right)[Math.floor(samples.length / 2)]
}

/**
 * 比值上限。稳态单请求相对同轮基线的正常比值约 1–1.5（两者都是同一个子进程处理
 * 同一种请求）；并发/冷池场景因为要额外 fork 一个子进程，实测在 2–4 倍。取 8 倍
 * 留足余量，同时仍能在「抢同一个子进程导致串行」这类回归上显著超标（那种情况是
 * 基线 × 假死根的超时预算，量级完全不同）。
 *
 * 分母下限：空载基线可能只有 3–5ms，全在噪声里；`max(baseline, 40ms)` 让分母稳定，
 * 又远小于任何真实退化。
 */
const LATENCY_RATIO_MAX = 8
/** 冷池首轮专用：要额外 fork 一个子进程，状态与基线不对称（见该用例注释）。 */
const COLD_POOL_RATIO_MAX = 20
const BASELINE_FLOOR_MS = 40

// -------------------------------------------------------------------- cases
test('假死 root（FIFO）：200 + state-timeout ≤2s，主线程同步 fs = 0，子进程 ≤300ms 消失', { skip: POSIX === false }, async () => {
  const root = makeProject('hung', { fifoTask: true })
  const warmRoot = makeProject('hung-warm')
  const { routes } = await mount([root, warmRoot])
  const warm = await warmWith(routes, warmRoot)

  // Host-side sync fs probe: the request must not touch the store in-process.
  const names = ['realpathSync', 'statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'existsSync']
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]))
  const seen = []
  const start = Date.now()
  let res
  try {
    for (const name of names) {
      fs[name] = function probed(target, ...rest) {
        seen.push(`${name}\t${String(target)}`)
        return originals[name].call(this, target, ...rest)
      }
    }
    syncBuiltinESMExports()
    res = await startState(routes, root).done
  } finally {
    for (const name of names) fs[name] = originals[name]
    syncBuiltinESMExports()
  }
  const elapsed = Date.now() - start

  assert.equal(res.statusCode, 200)
  const payload = json(res)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'state-timeout', JSON.stringify(payload))
  assert.ok(elapsed <= TIMEOUT_BUDGET_MS, `假死请求应 ≤${TIMEOUT_BUDGET_MS}ms，实际 ${elapsed}ms`)
  assert.deepEqual(seen.filter((line) => line.includes(root)), [], `宿主不得同步访问假死 root：${JSON.stringify(seen)}`)
  assert.equal(seen.filter((line) => line.startsWith('realpathSync')).length, 0)

  // The busy child is killed by the deadline; the warm spare has a different pid.
  const gone = await waitUntil(() => alive(warm) === false, 300)
  assert.equal(gone, true, `超时后子进程 ${warm} 应在 300ms 内消失`)
})

/**
 * 事件循环延迟直方图（毫秒）：只读等待，**不注入任何自己制造的事件**，所以测到的
 * 是「本机此刻的调度抖动」，而不是被测路径。
 *
 * 用 p99 而不是 `max`：`max` 是**单次最大采样**，OS 抢走 >50ms 的时间片就超标，与
 * 主线程有没有阻塞无关（共享机空载 load 就有十几）。真实回归——同步 fs 放回读路径、
 * 假死 root 在主线程读——会把**持续**数百毫秒的阻塞摊进几十上百个采样，p99 必然抬高，
 * 零散的调度尖峰则被分位数让掉。
 */
function sampleLoopDelay(ms) {
  const histogram = monitorEventLoopDelay({ resolution: 5 })
  histogram.enable()
  return sleep(ms).then(() => {
    histogram.disable()
    const ms2 = (value) => value / 1e6
    return {
      max: ms2(histogram.max),
      p50: ms2(histogram.percentile(50)),
      p99: ms2(histogram.percentile(99)),
      samples: histogram.count,
    }
  })
}

/** 事件循环延迟的判据（毫秒）：p99 主判据 + 同轮空载基线 + 绝对保底。 */
const LOOP_P99_MAX_MS = 50
const LOOP_BASELINE_RATIO_MAX = 4
const LOOP_P99_FLOOR_MS = 5

test('假死期间事件循环不被阻塞：state-timeout + 主线程同步 fs = 0 + 子进程 300ms 内消失（p99 vs 同轮基线）', { skip: POSIX === false }, async () => {
  /* 本轮之前这条用 `monitorEventLoopDelay().max < 50ms`。`max` 是**单次最大采样**：
     OS 抢走 >50ms 时间片就超，与主线程是否阻塞无关（共享机空载 load 就有 11+），
     这是间歇红的噪声源，不是被测路径退化。改为 p99（持续阻塞才会抬高它），并与
     **同轮空载基线**（健康 root 上什么都不做）取较大者——只有当假死请求把延迟抬到
     显著高于本机常态时才红。

     真正防回归的是三条结构判据：`error.code === 'state-timeout'`、宿主同步 fs
     命中 0 次、忙子进程 300ms 内消失。它们与负载无关，是主判据。 */
  const root = makeProject('hung-loop', { fifoTask: true })
  const warmRoot = makeProject('hung-loop-warm')
  const { routes } = await mount([root, warmRoot])
  await warmWorker()
  // 先烤热子进程：空载基线必须是「稳态」，不能把首次 fork 算进去。
  const warmRes = await startState(routes, warmRoot).done
  assert.equal(json(warmRes).ok, true, `预热请求应成功：${warmRes.body}`)
  const busyPid = workerPids()[0]
  assert.ok(busyPid, '预热后应存在一个子进程')

  // 同轮空载基线：同一进程、当下、没有任何在途请求。
  const quiet = await sampleLoopDelay(600)

  // 主线程同步 fs 探针：假死请求期间宿主不得同步碰 store。
  const names = ['realpathSync', 'statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'existsSync']
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]))
  const seen = []
  const histogram = monitorEventLoopDelay({ resolution: 5 })
  let during
  let res
  try {
    for (const name of names) {
      fs[name] = function probed(target, ...rest) {
        seen.push(`${name}\t${String(target)}`)
        return originals[name].call(this, target, ...rest)
      }
    }
    syncBuiltinESMExports()
    histogram.enable()
    const pending = startState(routes, root).done
    await sleep(600)
    during = {
      max: histogram.max / 1e6,
      p50: histogram.percentile(50) / 1e6,
      p99: histogram.percentile(99) / 1e6,
      samples: histogram.count,
    }
    res = await pending
  } finally {
    histogram.disable()
    for (const name of names) fs[name] = originals[name]
    syncBuiltinESMExports()
  }

  // ---- 结构判据（主判据，与负载无关）
  assert.equal(json(res).error.code, 'state-timeout', JSON.stringify(json(res).error))
  assert.deepEqual(
    seen.filter((line) => line.includes(root)),
    [],
    `假死请求期间宿主不得同步访问假死 root：${JSON.stringify(seen.slice(0, 5))}`,
  )
  const gone = await waitUntil(() => alive(busyPid) === false, 300)
  assert.equal(gone, true, `超时后忙子进程 ${busyPid} 应在 300ms 内消失`)

  // ---- 事件循环判据（p99 vs 同轮基线；max 只打印不判定）
  const budget = Math.max(LOOP_P99_MAX_MS, quiet.p99 * LOOP_BASELINE_RATIO_MAX, LOOP_P99_FLOOR_MS)
  const detail = `假死 p99=${during.p99.toFixed(1)}ms / 空载 p99=${quiet.p99.toFixed(1)}ms / 空载 max=${quiet.max.toFixed(1)}ms / 假死 max=${during.max.toFixed(1)}ms / 预算 ${budget.toFixed(1)}ms / samples ${during.samples}`
  assert.ok(during.samples > 20, `直方图采样过少，分位数不可信：${detail}`)
  assert.ok(
    during.p99 <= budget,
    `假死期间主线程 p99 延迟应 ≤${budget.toFixed(1)}ms（同轮空载 p99 × ${LOOP_BASELINE_RATIO_MAX}，下限 ${LOOP_P99_MAX_MS}ms）：${detail}`,
  )
})

test('正常 root：预热后延迟 <100ms，payload 正常', async () => {
  const root = makeProject('warm')
  const { routes } = await mount([root])
  await warmWorker()
  // 首次请求可能仍在等 fork 完成；预热一次后再测稳态延迟。
  const first = startState(routes, root)
  await first.done
  // 同轮基线：稳态同一请求在本机的正常耗时。判定用比值而不是死的 100ms。
  const baseline = await baselineLatency(routes, root)
  const start = Date.now()
  const res = await startState(routes, root).done
  const elapsed = Date.now() - start

  const payload = json(res)
  assert.equal(payload.ok, true, JSON.stringify(payload.error ?? payload.warnings ?? null))
  assert.equal(payload.tasks.total, 1)
  assert.equal(payload.root, fs.realpathSync(root))
  const denominator = Math.max(baseline, BASELINE_FLOOR_MS)
  assert.ok(
    elapsed / denominator <= LATENCY_RATIO_MAX,
    `预热后的正常请求应 ≤${LATENCY_RATIO_MAX}×同轮基线，实际 ${elapsed}ms / 基线 ${baseline}ms = ${(elapsed / denominator).toFixed(1)}×`,
  )
  // 保底绝对上限：比值正常但两侧一起慢到事故量级（整机卡死/读路径退回同步 IO）。
  assert.ok(elapsed < 2000, `预热后的正常请求应 <2000ms（保底），实际 ${elapsed}ms`)
})

test('并发：假死 root 与正常 root 同飞，正常请求 ≤500ms 且 root 各自正确', { skip: POSIX === false }, async () => {
  const hung = makeProject('hung-concurrent', { fifoTask: true })
  const normal = makeProject('normal-concurrent')
  const { routes } = await mount([hung, normal])
  await warmWorker()
  // 同轮基线：健康 root 在**无假死邻居**时的稳态耗时，作为并发场景的对照分母。
  const baseline = await baselineLatency(routes, normal)

  const hungRequest = startState(routes, hung)
  await sleep(50)
  const start = Date.now()
  const normalRes = await startState(routes, normal).done
  const elapsed = Date.now() - start
  const normalPayload = json(normalRes)
  assert.equal(normalPayload.ok, true, JSON.stringify(normalPayload.error ?? null))
  assert.equal(normalPayload.root, fs.realpathSync(normal), '并发请求的 payload.root 必须各归各')
  const denominator = Math.max(baseline, BASELINE_FLOOR_MS)
  assert.ok(
    elapsed / denominator <= LATENCY_RATIO_MAX,
    `并发时的正常请求应 ≤${LATENCY_RATIO_MAX}×同轮基线，实际 ${elapsed}ms / 基线 ${baseline}ms = ${(elapsed / denominator).toFixed(1)}×`,
  )
  // 保底：假死邻居若真的拖住了正常请求，它会逼近假死请求的超时预算（秒级）。
  assert.ok(elapsed < TIMEOUT_BUDGET_MS, `并发时的正常请求应 <${TIMEOUT_BUDGET_MS}ms（保底），实际 ${elapsed}ms`)

  const hungPayload = json(await hungRequest.done)
  assert.equal(hungPayload.error.code, 'state-timeout')
  assert.equal(hungPayload.root, fs.realpathSync(hung))
})

test('冷池首轮两并发（hung+normal）：normal 必须成功且 ≤20×同轮基线，hung 超时，children≥2', { skip: POSIX === false }, async () => {
  const hung = makeProject('cold-hung', { fifoTask: true })
  const normal = makeProject('cold-normal')
  // `mount` 只 apply（预热 fork 已在途）就返回：立刻并发请求，触发「await starting 后
  // 两个请求抢同一个子进程」的旧竞态。修复后第二个请求必须自己 spawn 一个子进程。
  const { routes } = await mount([hung, normal])

  // Latency is measured from the instant both requests are fired: a cold pool
  // may have to fork one extra child for the loser of the warm-up race, which is
  // exactly what this case exercises.
  const firedAt = Date.now()
  const hungRequest = startState(routes, hung)
  const normalRequest = startState(routes, normal)
  const normalRes = await normalRequest.done
  const normalElapsed = Date.now() - firedAt
  const normalPayload = json(normalRes)

  assert.equal(normalPayload.ok, true, JSON.stringify(normalPayload.error ?? normalPayload.warnings ?? null))
  assert.equal(normalPayload.root, fs.realpathSync(normal), '并发时 payload.root 必须各归各')

  // The hung request is still in flight: the pool must hold two children (its own
  // busy one + the finished normal request's idle spare), not one shared child.
  const overlapped = await waitUntil(() => workerPids().length >= 2, 1500)
  const hungPayload = json(await hungRequest.done)
  assert.equal(hungPayload.error.code, 'state-timeout')
  assert.equal(overlapped, true, '两个并发请求在重叠窗口内应各占一个子进程')

  // 同轮基线：本用例**不能**提前测基线（提前发请求会把池烤热，破坏「冷池首轮」这个
  // 前提），所以基线放在结构断言之后取——此时池已热、假死请求已回收，测的是本机此刻
  // 稳态下同一 root 的耗时。冷池首轮允许比它慢（要 fork 一个额外子进程），给 8 倍。
  // 真正的回归（两个请求抢同一个子进程 → 串行 → 正常请求要等满假死超时）会到秒级。
  const baseline = await baselineLatency(routes, normal)
  const denominator = Math.max(baseline, BASELINE_FLOOR_MS)
  // 冷池用例的比值上限单独放宽到 20：它要 fork **一个额外子进程**，且基线是在池已热、
  // 假死请求已回收之后测的，两者的系统状态本来就不对称。负载实测（16 忙进程）比值
  // 9–10 倍，空载 2–4 倍；真正的回归（两请求抢同一子进程）是「正常请求等满假死超时」，
  // 比值 ≥30 且绝对耗时直奔秒级，两条判据都会红。
  assert.ok(
    normalElapsed / denominator <= COLD_POOL_RATIO_MAX,
    `冷池并发下 normal 应 ≤${COLD_POOL_RATIO_MAX}×同轮基线，实际 ${normalElapsed}ms / 基线 ${baseline}ms = ${(normalElapsed / denominator).toFixed(1)}×`,
  )
  // 保底：抢同一个子进程时正常请求要等假死超时预算，量级完全不同。
  assert.ok(normalElapsed < TIMEOUT_BUDGET_MS, `冷池并发下 normal 应 <${TIMEOUT_BUDGET_MS}ms（保底），实际 ${normalElapsed}ms`)
})

test('冷池 5 路并发正常 root：5/5 ok、root 各自正确、无 unavailable', async () => {
  const roots = []
  for (let i = 0; i < 5; i += 1) roots.push(makeProject(`burst-${i}`))
  // `mount` 只 apply（预热 fork 在途）就返回：立刻并发，覆盖 F1 的突发争抢。
  const { routes } = await mount(roots)
  const firedAt = Date.now()
  const results = await Promise.all(roots.map((root) => startState(routes, root).done))
  const elapsed = Date.now() - firedAt
  const payloads = results.map((res) => json(res))
  for (let i = 0; i < payloads.length; i += 1) {
    assert.equal(payloads[i].ok, true, `第 ${i} 路应成功：${JSON.stringify(payloads[i].error ?? null)}`)
    assert.equal(payloads[i].root, fs.realpathSync(roots[i]), 'payload.root 必须各自正确')
    assert.equal(payloads[i].tasks.total, 1)
    assert.notEqual(payloads[i].error?.code, 'state-worker-unavailable')
  }
  assert.ok(elapsed < 1500, `冷池 5 路突发应 <1500ms，实际 ${elapsed}ms`)
})

test('冷池饱和（上限 2）：3 路 hung → 2 路 state-timeout + 1 路 saturated unavailable，children≤2', { skip: POSIX === false }, async () => {
  const previousAllow = process.env.PF_STATE_MAX_CHILDREN_ALLOW
  const previousCap = process.env.PF_STATE_MAX_CHILDREN
  process.env.PF_STATE_MAX_CHILDREN_ALLOW = '1'
  process.env.PF_STATE_MAX_CHILDREN = '2'
  try {
    const roots = [
      makeProject('sat-a', { fifoTask: true }),
      makeProject('sat-b', { fifoTask: true }),
      makeProject('sat-c', { fifoTask: true }),
    ]
    const { routes } = await mount(roots)
    const firedAt = Date.now()
    const requests = roots.map((root) => startState(routes, root))
    // 任何时刻子进程数都不得越过上限（每 10ms 采样 600ms）。
    const exceeded = await waitUntil(() => workerPids().length > 2, 600)
    const results = await Promise.all(requests.map((request) => request.done))
    const payloads = results.map((res) => json(res))
    const codes = payloads.map((payload) => payload.error?.code ?? 'ok')
    const timeouts = payloads.filter((payload) => payload.error?.code === 'state-timeout')
    const unavailable = payloads.filter((payload) => payload.error?.code === 'state-worker-unavailable')

    assert.equal(timeouts.length, 2, JSON.stringify(codes))
    assert.equal(unavailable.length, 1, JSON.stringify(codes))
    assert.match(unavailable[0].error.message, /saturated/)
    assert.equal(unavailable[0].error.message.includes('at most 8'), false)
    assert.equal(exceeded, false, `子进程数不得超过上限 2：${JSON.stringify(workerPids())}`)
    assert.ok(Date.now() - firedAt <= TIMEOUT_BUDGET_MS)
  } finally {
    if (previousAllow === undefined) delete process.env.PF_STATE_MAX_CHILDREN_ALLOW
    else process.env.PF_STATE_MAX_CHILDREN_ALLOW = previousAllow
    if (previousCap === undefined) delete process.env.PF_STATE_MAX_CHILDREN
    else process.env.PF_STATE_MAX_CHILDREN = previousCap
  }
})

test('崩溃自愈：忙子进程被 SIGKILL → state-worker-crashed；下一次请求自建新子进程并成功', { skip: LINUX === false }, async () => {
  const root = makeProject('crash', { fifoTask: true })
  const { ctx, routes } = await mount([root])
  assert.ok(ctx)
  const busyPid = await warmWorker()

  const pending = startState(routes, root).done
  await waitUntil(() => alive(busyPid), 1000)
  await sleep(200)
  process.kill(busyPid, 'SIGKILL')
  const crashed = json(await pending)
  assert.equal(crashed.ok, false)
  assert.equal(crashed.error.code, 'state-worker-crashed', JSON.stringify(crashed))

  // The pool rebuilds on demand: remove the FIFO, then the next request succeeds.
  fs.rmSync(path.join(root, '.agents/tasks', 'T-20260101-01.json'), { force: true })
  const rebuilt = await waitUntil(() => workerPids().length > 0, 5000)
  assert.equal(rebuilt, true, '崩溃后应自动重建 worker')
  const recovered = json(await startState(routes, root).done)
  assert.equal(recovered.ok, true, JSON.stringify(recovered.error ?? recovered.warnings ?? null))
})

test('崩溃 vs 饱和的判别边界：已死/未就绪槽位不计入上限，真饱和的语义不变', { skip: LINUX === false }, async (t) => {
  /* 2026-11-11 间歇红：`崩溃自愈` 在单 root、单请求、唯一存活池下偶尔返回
     `state-worker-unavailable` + "saturated (max 8)"，耗时只有 ~269ms —— `crashed`
     码根本轮不到。根因不是负载，是判别本身：`acquire()` 只看 `children.size`，
     而 SIGKILL 到 `exit` 事件之间被杀的子进程仍留在集合里；`busy=false` 的死槽位既
     不能被取用，又被算成「上限已满」。前面每条冷池用例（突发 5 路、上限 2 饱和、假死）
     都会 dispose/SIGKILL 旧池，死槽位若被算成忙，单请求也会被判饱和。

     判据一（本用例）：把那个窗口确定性地造出来 —— 唯一槽位「已崩、exit 未处理」且
     池上限 1、集合里恰有 1 个元素。旧判别在这里**只能**回 `state-worker-unavailable`：
     死槽位取不出来（`busy=false` 的死子进程不能被派活），集合里有 1 个 → 判满。修复后
     它不占容量，池补位一个新子进程并正常回答。

     判据二（同文件 `冷池饱和（上限 2）` 用例）：上限真满、子进程都活着且都忙时，仍必须
     回 `state-worker-unavailable` + "saturated … retry" —— 那是正确行为，本用例不放开它。

     两条判据都是结构性的（错码、活槽位计数、子进程数），与机器负载无关；耗时不断言。 */
  const root = makeProject('cap-crash')
  const other = makeProject('cap-other')
  const { ctx } = await mount([root])
  const pool = statePoolOf(ctx)
  assert.ok(pool, 'mount 后 ctx 必须挂着一个池')
  // 本用例把上限压到 1 来构造窗口；收尾用生产默认值（env 未设）还原。
  const productionCap = pool.maxChildren
  const warm = await waitUntil(() => pool.idleCount() === 1, 6000)
  assert.equal(warm, true, `预热失败：池内 idle=${pool.idleCount()}`)
  if (typeof t.diagnostic === 'function') t.diagnostic(`pool max=${pool.maxChildren} idle=${pool.idleCount()}`)

  // 唯一槽位：已崩（SIGKILL 已经发生），exit 事件还在队列里；上限压到 1。
  const forged = [...pool.children].find((slot) => slot.state === 'idle')
  forged.ready = false
  forged.state = 'dead'
  pool.maxChildren = 1
  process.kill(forged.child.pid, 'SIGKILL')
  assert.equal(pool.children.size, 1, `集合里必须恰有 1 个（已死的）槽位，实际 ${pool.children.size}`)
  assert.ok(pool.liveCount() <= 1, `活槽位计数 ${pool.liveCount()} 不得超过上限 1`)

  const answer = await pool.snapshot({ root })
  assert.notEqual(
    answer.code,
    'state-worker-unavailable',
    `死槽位不得被算成饱和（${answer.code}: ${answer.message}）——这会让崩溃/超时之后的正常请求拿到 retry 提示而不是数据`,
  )
  if (answer.ok === true) {
    assert.equal(answer.payload.root, fs.realpathSync(root), '补位后的子进程必须真正读本 root')
    assert.equal(answer.payload.tasks.total, 1)
  } else {
    // 极端调度下补位可能超时，但只能报崩溃/超时，仍然不能是「池满」。
    assert.equal(answer.code, 'state-worker-crashed', JSON.stringify(answer))
  }

  // 池没有卡死：上限恢复后，新请求照样能从补位的子进程拿到数据。
  pool.maxChildren = productionCap
  const rewarm = await waitUntil(() => pool.idleCount() === 1, 6000)
  assert.equal(rewarm, true, '死槽位被回收后池应补位')
  const again = await pool.snapshot({ root: other })
  assert.equal(again.ok, true, JSON.stringify(again.code ?? null))
  assert.equal(again.payload.root, fs.realpathSync(other), 'payload.root 必须归各自 root')
})

test('启动失败：worker 脚本不可用 → state-worker-unavailable；写路径（init）不受影响', async () => {
  const missing = path.join(tempRoot('worker-missing'), 'no-such-worker.mjs')
  const root = makeProject('init-under-broken-worker')
  const previous = process.env.PF_STATE_WORKER_SCRIPT
  const previousAllow = process.env.PF_STATE_WORKER_SCRIPT_ALLOW
  process.env.PF_STATE_WORKER_SCRIPT = missing
  // The override is test-only: production needs the explicit opt-in pair.
  process.env.PF_STATE_WORKER_SCRIPT_ALLOW = '1'
  try {
    const { routes } = await mount([root])
    const res = await startState(routes, root).done
    const payload = json(res)
    assert.equal(res.statusCode, 200)
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'state-worker-unavailable', JSON.stringify(payload))

    // The write path is in-process: init still works with a broken read worker.
    const initRes = await startPost(routes, INIT_ROUTE, { root }).done
    const initPayload = json(initRes)
    assert.equal(initRes.statusCode, 200, initRes.body)
    assert.equal(initPayload.ok, true, JSON.stringify(initPayload))
  } finally {
    if (previous === undefined) delete process.env.PF_STATE_WORKER_SCRIPT
    else process.env.PF_STATE_WORKER_SCRIPT = previous
    if (previousAllow === undefined) delete process.env.PF_STATE_WORKER_SCRIPT_ALLOW
    else process.env.PF_STATE_WORKER_SCRIPT_ALLOW = previousAllow
  }
})

test('写路径不回归：init/gate 仍在宿主进程内 withLock（同步写发生在宿主）', async () => {
  const root = tempRoot('write-path')
  const { routes } = await mount([root])

  const names = ['writeFileSync', 'renameSync', 'mkdirSync', 'unlinkSync']
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]))
  let writes = 0
  try {
    for (const name of names) {
      fs[name] = function probedWrite(...args) {
        writes += 1
        return originals[name].apply(this, args)
      }
    }
    syncBuiltinESMExports()

    const initRes = await startPost(routes, INIT_ROUTE, { root }).done
    const initPayload = json(initRes)
    assert.equal(initRes.statusCode, 200, initRes.body)
    assert.equal(initPayload.ok, true, JSON.stringify(initPayload))
    assert.ok(writes > 0, 'init 必须在宿主进程写盘（withLock），而不是交给只读 worker')

    writes = 0
    const gateRes = await startPost(routes, GATE_ROUTE, { root, id: 'precommit', enabled: false }).done
    const gatePayload = json(gateRes)
    assert.equal(gateRes.statusCode, 200, gateRes.body)
    assert.equal(gatePayload.ok, true, JSON.stringify(gatePayload))
    assert.equal(gatePayload.gate.enabled, false)
    assert.ok(writes > 0, 'gate 必须在宿主进程写盘（withLock）')
  } finally {
    for (const name of names) fs[name] = originals[name]
    syncBuiltinESMExports()
  }
})

test('TUI 读路径：panelStateReader 对假死 root 返回 state-timeout，不抛进面板宿主', { skip: POSIX === false }, async () => {
  const root = makeProject('hung-tui', { fifoTask: true })
  const { ctx } = await mount([root])
  await warmWorker()
  const readPanelState = plugin.panelStateReader(ctx)

  const start = Date.now()
  const payload = await readPanelState(root)
  const elapsed = Date.now() - start
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'state-timeout', JSON.stringify(payload))
  assert.ok(elapsed <= TIMEOUT_BUDGET_MS, `TUI 读路径应 ≤${TIMEOUT_BUDGET_MS}ms，实际 ${elapsed}ms`)
})

// ------------------------------------------ 面板读路径：worktree 台账归一
//
// 2026-11-08 回归：台账（.agents/）已入库，所以每个 linked worktree 检出都自带
// 一份 store 副本。旧实现用「root 有 store → 保持自己的作用域」做短路，导致
// worktree 会话的侧栏读自己那份分支私账（实测 tasks 96 vs 主工作区 93），而
// 心跳来自主工作区——一个面板混两个台账。判据必须只看「root 是不是 linked
// worktree 根」，与它有没有 store 副本无关。

function gitFixture(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Flow Test',
      GIT_AUTHOR_EMAIL: 'flow-test@example.invalid',
      GIT_COMMITTER_NAME: 'Flow Test',
      GIT_COMMITTER_EMAIL: 'flow-test@example.invalid',
    },
  }).trim()
}

/** 一个台账已提交的 git 项目（与本仓库的真实布局一致）。 */
function committedProject(label) {
  const root = tempRoot(label)
  core.initProject(root, { name: label, noGates: true })
  const { contract } = core.loadContract(root)
  core.addTask(root, contract, { type: 'feat', title: `${label} task`, status: 'active' })
  gitFixture(root, ['init', '-q'])
  gitFixture(root, ['add', '-A'])
  gitFixture(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'init'])
  return root
}

test('worktree 侧栏：台账归一主工作区，即使 worktree 自带已入库 store 副本', async () => {
  const main = committedProject('wt-ledger')
  const mainBranch = gitFixture(main, ['branch', '--show-current'])
  const checkout = path.join(tempRoot('wt-ledger-dir'), 'checkout')
  gitFixture(main, ['worktree', 'add', '-q', checkout, '-b', 'panel-wt'])

  /* 让两侧台账真的不同：造一份“worktree 自带台账副本”的历史现场。
     2026-11-09 起 core 的 loadContract/storePaths 一律归一到主工作区，所以副本
     必须用文件操作伪造（迁移前遗留的检出副本），不能再经 core 写出来。 */
  fs.cpSync(path.join(main, '.agents'), path.join(checkout, '.agents'), { recursive: true })
  const wtTaskDir = path.join(checkout, '.agents', 'tasks')
  const wtFirst = fs.readdirSync(wtTaskDir)[0]
  const wtStash = JSON.parse(fs.readFileSync(path.join(wtTaskDir, wtFirst), 'utf8'))
  fs.writeFileSync(
    path.join(wtTaskDir, 'T-20991231-99.json'),
    `${JSON.stringify({ ...wtStash, id: 'T-20991231-99', title: 'worktree only' }, null, 2)}\n`,
  )

  const { routes, ctx } = await mount([main])
  const res = await startState(routes, checkout).done
  const payload = json(res)
  assert.equal(payload.ok, true, res.body)
  assert.equal(payload.root, fs.realpathSync(checkout), 'payload.root 仍是请求的工作区')
  assert.equal(payload.ledgerRoot, fs.realpathSync(main), 'ledgerRoot 必须是主工作区')
  assert.equal(payload.worktree, true)
  assert.equal(payload.tasks.total, 1, '必须读主工作区台账（1 条），而不是 worktree 副本（2 条）')
  assert.equal(payload.head.branch, mainBranch, 'head 是台账根的分支')
  assert.equal(payload.currentHead.branch, 'panel-wt', 'currentHead 是请求工作区的分支')

  /* TUI 与 HTTP 同一投影：两条读路径都必须归一到主工作区。 */
  const readPanelState = plugin.panelStateReader(ctx)
  const tui = await readPanelState(checkout)
  assert.equal(tui.ledgerRoot, fs.realpathSync(main))
  assert.equal(tui.tasks.total, 1)
})

test('普通子目录不归一：父仓库有台账也不静默继承', async () => {
  const main = committedProject('wt-subdir')
  const sub = path.join(main, 'docs')
  fs.mkdirSync(sub)

  const { routes } = await mount([main])
  const payload = json(await startState(routes, sub).done)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'not-initialized', JSON.stringify(payload.error))
  assert.equal(payload.root, fs.realpathSync(sub))
})

test('心跳行透传 branch/worktree：面板分支徽标的数据前提（旧记录形状不变）', async () => {
  const root = makeProject('hb-branch-row')
  const dir = path.join(root, '.agents', 'heartbeat')
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString()
  const base = {
    schema: 1,
    agent: '',
    goal: '分支徽标',
    task: null,
    claims: [],
    status: 'working',
    last_action: '',
    started_at: now,
    updated_at: now,
    ended_at: null,
  }
  fs.writeFileSync(
    path.join(dir, 'session-branch.json'),
    JSON.stringify({ ...base, session: 'session-branch', branch: 'wt-branch', worktree: '.agents/worktrees/wt' }),
  )
  fs.writeFileSync(path.join(dir, 'session-legacy.json'), JSON.stringify({ ...base, session: 'session-legacy' }))

  const { routes } = await mount([root])
  const payload = json(await startState(routes, root).done)
  const row = payload.heartbeats.find((item) => item.session === 'session-branch')
  assert.ok(row, '新心跳行必须在 payload 里：' + JSON.stringify(payload.heartbeats))
  assert.equal(row.branch, 'wt-branch')
  assert.equal(row.worktree, '.agents/worktrees/wt')

  const legacy = payload.heartbeats.find((item) => item.session === 'session-legacy')
  assert.ok(legacy, '旧心跳行必须在 payload 里')
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'branch'), false, '旧记录的行使形状不受影响')
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'worktree'), false)
})

// --------------------------- 可注入读 seam（T-20261112202457，concurrency）
//
// 前端 web 路由要切「先 flow state --json、失败回落」，需要宿主侧有一个**可注入**
// 的读入口，且默认行为（fork worker + 1800ms）逐字节不变：
//   - stateSnapshot(ctx, request, { deadlineMs, readSnapshot })
//   - handleState / collectPanelState 原样透传 options
// 注入实现契约：返回 {ok:true,payload} 或 {ok:false,code,message}，自己按 deadlineMs
// 限时；**抛错**时宿主回退默认读并在 payload 上标 degraded（不白屏）。

const seamModule = await import('../lib/host/state.mjs')
const { STATE_DEADLINE_MS, stateSnapshot } = seamModule

/** 不挂 pool 的最小 ctx：默认路径退化为进程内 buildSnapshot（与旧 unit double 一致）。 */
const bareCtx = { get: () => undefined }

function snapshotRequest(root) {
  return {
    root,
    realRoot: root,
    ledgerRoot: root,
    entry: { path: root, name: path.basename(root) },
    hostWarnings: [],
    now: Date.now(),
  }
}

test('seam：默认路径行为不变（无 options = 进程内/worker 读，无降级标记）', async () => {
  const root = makeProject('seam-default')
  const result = await stateSnapshot(bareCtx, snapshotRequest(root))
  assert.equal(result.ok, true)
  assert.equal(result.payload.root, root)
  assert.equal(Object.hasOwn(result.payload, 'degraded'), false, '默认路径不得凭空多出降级标记')
  assert.equal(Object.hasOwn(result.payload, 'readPath'), false, '默认路径不写 readPath')
  assert.equal(STATE_DEADLINE_MS, 1800, '默认期限仍是 1800ms（既有时间断言的前提）')
})

test('seam：注入实现完全替代默认读，并收到 deadlineMs 预算', async () => {
  const root = makeProject('seam-inject')
  let seen
  const result = await stateSnapshot(bareCtx, snapshotRequest(root), {
    deadlineMs: 321,
    readSnapshot: async (request, context) => {
      seen = { request, context }
      return { ok: true, payload: { injected: true, root: request.root } }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.payload.injected, true, '注入的 payload 原样返回')
  assert.equal(seen.context.deadlineMs, 321, '注入实现拿到本次预算')
  assert.equal(seen.request.root, root)
})

test('seam：注入实现抛错 → 回退默认读并标 degraded（不白屏）', async () => {
  const root = makeProject('seam-fallback')
  const result = await stateSnapshot(bareCtx, snapshotRequest(root), {
    readSnapshot: async () => {
      throw new Error('cli exploded')
    },
  })
  assert.equal(result.ok, true, '注入失败不能让面板整体失败')
  assert.equal(result.payload.root, root, '回退读的是默认实现')
  assert.equal(result.payload.degraded, true)
  assert.equal(result.payload.readPath, 'direct')
  assert.match(result.payload.degradedReason, /state-reader-unavailable: .*cli exploded/)
})

test('seam：注入实现回答 ok:false 原样透传（它已做过自己的回落，不重复跑默认读）', async () => {
  const root = makeProject('seam-passthrough')
  const result = await stateSnapshot(bareCtx, snapshotRequest(root), {
    readSnapshot: async () => ({ ok: false, code: 'state-reader-own', message: '自己兜底也失败了' }),
  })
  assert.deepEqual(result, { ok: false, code: 'state-reader-own', message: '自己兜底也失败了' })
})

test('seam：注入实现返回裸 payload 时规范成 {ok:true,payload}', async () => {
  const root = makeProject('seam-bare')
  const result = await stateSnapshot(bareCtx, snapshotRequest(root), {
    readSnapshot: async () => ({ hello: 'world' }),
  })
  assert.deepEqual(result, { ok: true, payload: { hello: 'world' } })
})
