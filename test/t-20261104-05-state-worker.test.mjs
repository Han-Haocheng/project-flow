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
    execFileSync('mkfifo', [path.join(root, '.dsh/flow/tasks', 'T-20260101-01.json')])
  } else {
    core.addTask(root, contract, { title: `${label} task`, status: 'active' })
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

test('假死期间事件循环不被阻塞：monitorEventLoopDelay max < 50ms', { skip: POSIX === false }, async () => {
  const root = makeProject('hung-loop', { fifoTask: true })
  const { routes } = await mount([root])
  await warmWorker()

  const histogram = monitorEventLoopDelay({ resolution: 5 })
  histogram.enable()
  try {
    const pending = startState(routes, root).done
    await sleep(600)
    const maxDuring = histogram.max / 1e6
    const res = await pending
    assert.equal(json(res).error.code, 'state-timeout')
    assert.ok(maxDuring < 50, `假死期间事件循环最大延迟 ${maxDuring.toFixed(1)}ms，应 <50ms`)
  } finally {
    histogram.disable()
  }
})

test('正常 root：预热后延迟 <100ms，payload 正常', async () => {
  const root = makeProject('warm')
  const { routes } = await mount([root])
  await warmWorker()
  // 首次请求可能仍在等 fork 完成；预热一次后再测稳态延迟。
  const first = startState(routes, root)
  await first.done
  const start = Date.now()
  const res = await startState(routes, root).done
  const elapsed = Date.now() - start

  const payload = json(res)
  assert.equal(payload.ok, true, JSON.stringify(payload.error ?? payload.warnings ?? null))
  assert.equal(payload.tasks.total, 1)
  assert.equal(payload.root, fs.realpathSync(root))
  assert.ok(elapsed < 100, `预热后的正常请求应 <100ms，实际 ${elapsed}ms`)
})

test('并发：假死 root 与正常 root 同飞，正常请求 ≤500ms 且 root 各自正确', { skip: POSIX === false }, async () => {
  const hung = makeProject('hung-concurrent', { fifoTask: true })
  const normal = makeProject('normal-concurrent')
  const { routes } = await mount([hung, normal])
  await warmWorker()

  const hungRequest = startState(routes, hung)
  await sleep(50)
  const start = Date.now()
  const normalRes = await startState(routes, normal).done
  const elapsed = Date.now() - start
  const normalPayload = json(normalRes)
  assert.equal(normalPayload.ok, true, JSON.stringify(normalPayload.error ?? null))
  assert.equal(normalPayload.root, fs.realpathSync(normal), '并发请求的 payload.root 必须各归各')
  assert.ok(elapsed <= 500, `并发时的正常请求应 ≤500ms，实际 ${elapsed}ms`)

  const hungPayload = json(await hungRequest.done)
  assert.equal(hungPayload.error.code, 'state-timeout')
  assert.equal(hungPayload.root, fs.realpathSync(hung))
})

test('冷池首轮两并发（hung+normal）：normal 必须成功且 <500ms，hung 超时，children≥2', { skip: POSIX === false }, async () => {
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
  assert.ok(normalElapsed < 500, `冷池并发下 normal 应 <500ms，实际 ${normalElapsed}ms`)

  // The hung request is still in flight: the pool must hold two children (its own
  // busy one + the finished normal request's idle spare), not one shared child.
  const overlapped = await waitUntil(() => workerPids().length >= 2, 1500)
  const hungPayload = json(await hungRequest.done)
  assert.equal(hungPayload.error.code, 'state-timeout')
  assert.equal(overlapped, true, '两个并发请求在重叠窗口内应各占一个子进程')
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
  fs.rmSync(path.join(root, '.dsh/flow/tasks', 'T-20260101-01.json'), { force: true })
  const rebuilt = await waitUntil(() => workerPids().length > 0, 5000)
  assert.equal(rebuilt, true, '崩溃后应自动重建 worker')
  const recovered = json(await startState(routes, root).done)
  assert.equal(recovered.ok, true, JSON.stringify(recovered.error ?? recovered.warnings ?? null))
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
