// 2026-11-13（T-20261113110938）：验收 / 门禁执行面的三处收口。
//
//   ① `flow task update --commits a,b`：与 `flow exp update --commits` 对齐（参数面登记在
//      bin/flow.mjs 的 SPEC，实现读写在 lib/cli/tasks.mjs）；
//   ② acceptance 的 `cmd:` 里再包 `flow gate run` / `flow.mjs gate run` 是反模式：verify
//      在执行任何步骤之前直接 usage 拒绝，并提示改写成 `gate:<gateId>`；
//   ③ lib/runner.mjs 的 runStep：POSIX 上子进程 exit 后启动 drain 宽限（默认 2s，可用
//      control.drainMs 注入），孙进程持有 stdout 时不再无限等 'close'。
//
// 只用 os.tmpdir() 下的一次性项目；CLI 用真实子进程（spawnSync bin/flow.mjs）。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { initProject, loadContract, updateTask } from '../lib/core.mjs'
import { runStep } from '../lib/runner.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flow-exec-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function freshProject(label) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true })
  return { root, contract: loadContract(root).contract }
}

function runCli(cwd, args) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env, timeout: 60000 })
  let json = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = null
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

function addTaskCli(root, args) {
  const result = runCli(root, ['task', 'add', ...args, '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  return result.json.data
}

/** 验收只能走记录写入路径（CLI 没有 --acceptance），与既有 verify 测试同一手法。 */
function setAcceptance(root, contract, id, acceptance) {
  return updateTask(root, contract, id, { acceptance }, { source: 'internal' })
}

// =============================================================== ① --commits

test('task update --commits：逗号分隔的短 sha 列表写回 records，并能从 show 读回', () => {
  const { root } = freshProject('task-commits')
  const created = addTaskCli(root, ['--type', 'fix', '--title', '提交回填', '--id', 'T-20261113120001'])
  assert.deepEqual(created.commits, [], '新任务 commits 初始为空数组')

  const updated = runCli(root, ['task', 'update', 'T-20261113120001', '--commits', 'abc1234,def5678', '--json'])
  assert.equal(updated.code, 0, updated.stdout + updated.stderr)
  assert.deepEqual(updated.json.data.commits, ['abc1234', 'def5678'], 'update 的 data 直接带回 commits')

  const shown = runCli(root, ['task', 'show', 'T-20261113120001', '--json'])
  assert.equal(shown.code, 0, shown.stdout + shown.stderr)
  assert.deepEqual(shown.json.data.commits, ['abc1234', 'def5678'], '落盘后读回一致')

  // 与 exp update 的 readList 语义一致：空串清空为 []，而不是留一个空字符串元素。
  const cleared = runCli(root, ['task', 'update', 'T-20261113120001', '--commits', '', '--json'])
  assert.equal(cleared.code, 0, cleared.stdout + cleared.stderr)
  assert.deepEqual(cleared.json.data.commits, [])
})

test('--commits 只登记在 task update：task add 仍按 usage 拒绝（白名单未放宽）', () => {
  const { root } = freshProject('task-commits-add')
  const result = runCli(root, ['task', 'add', '--type', 'fix', '--title', 'x', '--commits', 'abc1234'])
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /task add 不支持 --commits/)
})

// =============================================================== ② cmd: 反模式

test('verify：cmd: 里包 flow.mjs gate run 在执行前 usage 拒绝，并提示 gate:<gateId>', () => {
  const { root, contract } = freshProject('nested-gate')
  addTaskCli(root, ['--type', 'fix', '--title', '反模式', '--id', 'T-20261113120002'])
  const sentinel = path.join(root, 'ran.txt')
  // 命令体先写哨兵再包门禁：只要 verify 真的执行了它，哨兵就会出现。
  const command =
    `node -e "require('node:fs').writeFileSync(process.argv[1],'ran')" ${JSON.stringify(sentinel)}` +
    ' && node bin/flow.mjs gate run precommit'
  setAcceptance(root, contract, 'T-20261113120002', [`cmd:${command}`])

  const result = runCli(root, ['task', 'verify', 'T-20261113120002', '--json'])
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'usage', '反模式是用法错误，不是 check-failed')
  assert.match(result.json.error.message, /反模式/)
  assert.match(result.json.error.message, /第 1 项/)
  assert.match(result.json.error.message, /flow gate run/)
  assert.match(result.json.error.message, /gate:<gateId>/, '必须提示改写成 gate:<gateId>')
  assert.equal(fs.existsSync(sentinel), false, '拒绝发生在执行前：命令体没有跑')
})

test('verify：对象形态 {cmd} 同样拒绝；裸 flow gate run 也命中', () => {
  const { root, contract } = freshProject('nested-gate-object')
  addTaskCli(root, ['--type', 'fix', '--title', '对象反模式', '--id', 'T-20261113120003'])
  setAcceptance(root, contract, 'T-20261113120003', [{ cmd: 'flow gate run precommit', expect: 'exit 0' }])

  const result = runCli(root, ['task', 'verify', 'T-20261113120003', '--json'])
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.equal(result.json.error.code, 'usage')
  assert.match(result.json.error.message, /gate:<gateId>/)
})

// =============================================================== ③ drain 宽限

/** Minimal injected child: EventEmitter + stdio streams + pid + kill spy. */
function fakeChild(pid = 7001) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kills = []
  child.kill = (signal) => {
    child.kills.push(signal)
    return true
  }
  return child
}

test('runStep POSIX：子进程 exit 后按 drainMs 结算，不等永不到来的 close', async () => {
  const child = fakeChild(7001)
  child.stdout.write('partial output\n')
  let killed = false
  const started = Date.now()
  const pending = runStep(
    os.tmpdir(),
    { id: 'drain', run: 'orphan-holder', expect: 'exit 7' },
    10000,
    40,
    {
      platform: 'linux',
      drainMs: 50,
      spawnImpl: () => child,
      killImpl: () => {
        killed = true
        return true
      },
    },
  )
  // 子进程退出，但孙进程仍持有 stdout：'close' 永远不来。
  child.emit('exit', 7)
  const result = await pending
  const elapsed = Date.now() - started

  assert.equal(killed, false, 'exit 后 drain 不是超时路径，不该杀进程组')
  assert.equal(result.exit, 7, '按 exit code 判定，不因缺 close 变成 null')
  assert.equal(result.ok, true, 'expect exit 7 应判通过')
  assert.match(result.tail, /partial output/, '已收集输出照常进 tail')
  assert.ok(elapsed >= 40, `至少等满 drain 宽限（实际 ${elapsed}ms）`)
  assert.ok(elapsed < 1500, `drain 后应及时 resolve（实际 ${elapsed}ms）`)
  assert.equal(child.stdout.destroyed, true, 'drain 结算时释放 stdio，避免句柄残留')
})

test('runStep POSIX：close 先到则立即结算（drain 计时器不改变原有语义）', async () => {
  const child = fakeChild(7002)
  const started = Date.now()
  const pending = runStep(
    os.tmpdir(),
    { id: 'close-first', run: 'ok', expect: 'exit 0' },
    10000,
    40,
    { platform: 'linux', drainMs: 5000, spawnImpl: () => child },
  )
  child.emit('exit', 0)
  child.emit('close', 0)
  const result = await pending
  assert.equal(result.ok, true)
  assert.ok(Date.now() - started < 1000, 'close 先到不应被 drain 宽限拖住')
})

test(
  'runStep POSIX 真实孙进程：持有 stdout 时按 drain 宽限结束（远早于孙进程 5s）',
  {
    skip:
      process.platform === 'win32'
        ? 'POSIX-only 行为；win32 由既有的超时 grace 用例覆盖'
        : false,
  },
  async () => {
    // 父进程立刻 exit，孙进程继承 stdout 睡 5s：没有 drain 宽限时 close 要等到 5s。
    const run =
      'node -e "require(\'node:child_process\').spawn(\'sleep\',[\'5\'],{stdio:\'inherit\'});process.exit(0)"'
    const started = Date.now()
    const result = await runStep(os.tmpdir(), { id: 'real-drain', run, expect: 'exit 0' }, 20000, 40, {
      drainMs: 150,
    })
    const elapsed = Date.now() - started

    assert.equal(result.exit, 0, result.tail)
    assert.equal(result.ok, true)
    assert.ok(elapsed >= 140, `至少等满注入的 drain 宽限（实际 ${elapsed}ms）`)
    assert.ok(elapsed < 3000, `应远早于孙进程 5s 的结束时间（实际 ${elapsed}ms）`)
  },
)
