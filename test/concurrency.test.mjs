// 并发写测试：真 spawn 多个进程同时写同一个 store。
//
// 只断言「不变量」（id 唯一、成功者都有完整文件、失败者都是 conflict、文件数守恒、
// 结束后无锁/临时文件残留），**从不断言谁赢**——谁先拿到锁由操作系统调度决定，
// 断言赢家会让用例变成 flaky。
//
// 过期锁用真实「已死进程」的 pid 构造（`deadPid()`），不用魔数 999999：
// 服务器上真可能有个 999999 在跑，那样用例会假红。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { addTask, initProject, loadContract, storePaths } from '../lib/core.mjs'

const CORE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'core.mjs')
const HOST_TAG = `${os.hostname()}|${process.platform}`
const CHILD_TIMEOUT_MS = 20_000

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
  assert.throws(
    () => process.kill(pid, 0),
    `spawned helper pid ${pid} should already be reaped`,
  )
  return pid
}

/** Child program: wait for the shared `go` file, then add one task and print one JSON line. */
const CHILD_SOURCE = `
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const [corePath, root, label, readyFile, goFile] = process.argv.slice(2)
const { loadContract, addTask, drainWarnings } = await import(pathToFileURL(corePath).href)

fs.writeFileSync(readyFile, label)
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const deadline = Date.now() + 5000
while (!fs.existsSync(goFile)) {
  if (Date.now() > deadline) process.exit(3)
  Atomics.wait(sleeper, 0, 0, 1)
}

try {
  const { contract } = loadContract(root)
  const task = addTask(root, contract, { title: 'child ' + label })
  process.stdout.write(JSON.stringify({ ok: true, id: task.id, warnings: drainWarnings() }) + '\\n')
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, code: error && error.code, message: error && error.message, warnings: drainWarnings() }) + '\\n',
  )
}
`

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-race-${label}-`))
  tempDirs.push(root)
  initProject(root)
  const { contract } = loadContract(root)
  return { root, contract, paths: storePaths(root, contract) }
}

/** Print-friendly tail of a child's stderr, so a timeout failure is diagnosable. */
function diagnose(stderr, stdout) {
  const text = `${stderr ?? ''}${stdout ?? ''}`.trim()
  return text === '' ? '(child produced no output)' : text.slice(-800)
}

function collect(proc, label) {
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
      resolve({ label, timedOut: true, stdout, stderr })
    }, CHILD_TIMEOUT_MS)
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
      resolve({ label, timedOut: false, code, stdout, stderr })
    })
  })
}

function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (!check()) {
    if (Date.now() > deadline) assert.fail(label)
    Atomics.wait(sleeper, 0, 0, 5)
  }
}

/**
 * One race round: `children` processes call `addTask` at the same moment, optionally
 * against a pre-written stale lock. Returns the observation set; the caller asserts.
 */
async function raceRound({ label, children, staleLock }) {
  const { root, contract, paths } = freshProject(label)
  // A pre-existing record makes "file count == preset + successes" a real equation.
  addTask(root, contract, { title: 'preset' })
  const lockPath = path.join(paths.store, '.lock')
  assert.equal(fs.existsSync(lockPath), false, 'seed writes must have released the lock')
  if (staleLock === true) {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ schema: 1, pid: deadPid(), host: HOST_TAG, at: new Date(Date.now() - 120_000).toISOString(), token: 'stale-owner' }),
    )
  }

  const childFile = path.join(root, '.child.mjs')
  fs.writeFileSync(childFile, CHILD_SOURCE)
  const goFile = path.join(root, '.child-go')
  const labels = Array.from({ length: children }, (_, index) => String(index + 1))

  const jobs = labels.map((childLabel) => {
    const readyFile = path.join(root, `.child-ready-${childLabel}`)
    const proc = spawn(process.execPath, [childFile, CORE_PATH, root, childLabel, readyFile, goFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { label: childLabel, proc, readyFile }
  })

  const results = []
  try {
    waitFor(
      () => jobs.every((job) => fs.existsSync(job.readyFile)),
      `children did not become ready in 15s: ${jobs
        .map((job) => `${job.label}=${job.proc.exitCode ?? job.proc.signalCode ?? 'running'}`)
        .join(', ')}`,
    )
    fs.writeFileSync(goFile, 'go')
    results.push(...(await Promise.all(jobs.map((job) => collect(job.proc, job.label)))))
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

  const payloads = results.map((result) => {
    if (result.timedOut) {
      return { label: result.label, timedOut: true, raw: result }
    }
    const line = result.stdout
      .split('\n')
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .pop()
    assert.ok(line, `child ${result.label} printed no result line: ${diagnose(result.stderr, result.stdout)}`)
    return { label: result.label, ...JSON.parse(line), raw: result }
  })
  return { paths, payloads }
}

function assertInvariants({ paths, payloads }, roundLabel) {
  const failures = payloads.filter((payload) => payload.ok !== true)
  for (const failure of failures) {
    assert.equal(failure.timedOut, undefined, `${roundLabel}: child ${failure.label} timed out`)
    assert.equal(
      failure.code,
      'conflict',
      `${roundLabel}: child ${failure.label} failed with ${failure.code}: ${failure.message ?? ''}`,
    )
  }
  const successes = payloads.filter((payload) => payload.ok === true)
  assert.ok(successes.length >= 1, `${roundLabel}: nobody could write despite the stale lock`)

  const ids = successes.map((payload) => payload.id)
  assert.equal(new Set(ids).size, ids.length, `${roundLabel}: two writers minted the same id (${ids.join(', ')})`)

  for (const id of ids) {
    const file = path.join(paths.tasks, `${id}.json`)
    assert.ok(fs.existsSync(file), `${roundLabel}: ${id} was reported as written but the file is missing`)
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(record.id, id, `${roundLabel}: ${id}.json holds another record (${record.id})`)
  }

  const files = fs.readdirSync(paths.tasks).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 1 + successes.length, `${roundLabel}: task file count does not match preset + successes`)

  const leftovers = []
  for (const dir of [paths.store, paths.experiments, paths.tasks, paths.gates, paths.logs, paths.decisions]) {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.lock' || name.includes('.tmp-') || name.includes('.takeover-')) leftovers.push(path.join(dir, name))
    }
  }
  assert.deepEqual(leftovers, [], `${roundLabel}: lock/temp files survived the round`)
}

test('并发：过期锁接管下 3 个进程并发写，id 唯一且无记录被覆盖', { timeout: 180_000 }, async () => {
  for (let round = 1; round <= 8; round += 1) {
    assertInvariants(await raceRound({ label: `stale-${round}`, children: 3, staleLock: true }), `stale round ${round}`)
  }
})

test('并发：无锁起跑 2 个进程，双成功也必须是两个不同 id', { timeout: 120_000 }, async () => {
  for (let round = 1; round <= 3; round += 1) {
    assertInvariants(await raceRound({ label: `free-${round}`, children: 2, staleLock: false }), `free round ${round}`)
  }
})
