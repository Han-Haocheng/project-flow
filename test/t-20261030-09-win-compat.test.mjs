// T-20261030-09 Windows 兼容：超时杀进程树 + rename 退避重试 + 心跳保留名/ADS 校验。
//
// 全部确定性、无需真实 Windows：
// - win32 分支通过注入 `platform` / `taskkillImpl` / `killImpl` / `spawnImpl` 覆盖；
// - rename 退避用注入的 `renameImpl` / `sleepImpl` 在真实目录上制造瞬时与耗尽失败；
// - 保留名清单通过公开的 heartbeat API 逐项正反例（不直接调私有校验函数）。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import {
  FlowError,
  endHeartbeat,
  heartbeatStatus,
  initProject,
  killProcessTree,
  loadContract,
  runStep,
  startHeartbeat,
  updateHeartbeat,
  writeJsonAtomic,
} from '../lib/core.mjs'
import {
  killProcessTree as killCheckProcessTree,
  superviseCheckChild,
} from '../lib/checks.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

const TEMP_DIRS = []
after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort：残留临时目录不能影响测试结果
    }
  }
})

// ------------------------------------------------------------------ helpers

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flow-win32-${label}-`))
  TEMP_DIRS.push(dir)
  return dir
}

function freshProject(label) {
  const root = tempDir(label)
  initProject(root, { name: label, noGates: true })
  const { contract } = loadContract(root)
  return { root, contract }
}

function expectFlowError(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FlowError, `expected FlowError, got ${error?.name}: ${error?.message}`)
    assert.equal(error.code, code)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function codeError(code) {
  return Object.assign(new Error(code), { code })
}

/** Minimal injected child: EventEmitter + stdio streams + pid + kill spy. */
function fakeChild(pid = 4242) {
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

function tempResidue(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))
}

// ------------------------------------------------- A. 超时杀进程树（win32）

test('runStep win32：超时先 taskkill /T /F，grace 内 resolve 而不是挂着等 close', async () => {
  const child = fakeChild(4242)
  const spawned = []
  const taskkillPids = []
  const started = Date.now()
  const result = await runStep(
    path.join(os.tmpdir(), 'unused-root'),
    { id: 'slow', run: 'slow.cmd', expect: 'exit 0' },
    30,
    40,
    {
      platform: 'win32',
      graceMs: 40,
      spawnImpl: (command, options) => {
        spawned.push({ command, options })
        return child
      },
      killImpl: () => {
        throw new Error('win32 分支不得走 POSIX 进程组 kill')
      },
      taskkillImpl: (pid) => {
        taskkillPids.push(pid)
        return { ok: true, status: 0, error: null }
      },
    },
  )
  const elapsed = Date.now() - started

  assert.equal(spawned.length, 1, '步骤只 spawn 一次')
  assert.equal(spawned[0].command, 'slow.cmd')
  assert.equal(spawned[0].options.shell, true)
  assert.equal(spawned[0].options.detached, false, 'win32 不用 detached 进程组')
  assert.deepEqual(taskkillPids, [4242], 'taskkill 拿到的是子进程 pid')
  assert.deepEqual(child.kills, ['SIGKILL'], 'taskkill 之后仍直接杀子进程兜底')
  assert.equal(result.exit, null, '被杀且收不到 close → exit 为 null')
  assert.equal(result.ok, false, '超时步骤必须记为失败')
  assert.ok(elapsed >= 30, `至少等满超时（实际 ${elapsed}ms）`)
  assert.ok(elapsed < 1500, `grace 兜底后应及时 resolve（实际 ${elapsed}ms）`)
  assert.equal(child.stdout.destroyed, true, 'grace resolve 时释放 stdio，避免句柄残留')
})

test('runStep win32：taskkill 失败也照样 grace resolve（兜底不依赖它成功）', async () => {
  const child = fakeChild(7777)
  const started = Date.now()
  const result = await runStep(
    os.tmpdir(),
    { id: 'slow', run: 'slow.cmd', expect: 'exit 0' },
    25,
    40,
    {
      platform: 'win32',
      graceMs: 30,
      spawnImpl: () => child,
      taskkillImpl: () => ({ ok: false, status: 1, error: null }),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(result.exit, null)
  assert.deepEqual(child.kills, ['SIGKILL'], 'taskkill 不成功时直接杀子进程兜底')
  assert.ok(Date.now() - started < 1500)
})

test('runStep 非 win32：仍是进程组 SIGKILL，且不启用 grace（只等 close）', async () => {
  const child = fakeChild(4343)
  const spawned = []
  const groupKills = []
  let settled = false
  const pending = runStep(
    os.tmpdir(),
    { id: 'slow', run: 'sleep 9', expect: 'exit 0' },
    25,
    40,
    {
      platform: 'linux',
      graceMs: 5, // 注入也不该生效：非 win32 行为不变
      spawnImpl: (command, options) => {
        spawned.push({ command, options })
        return child
      },
      killImpl: (target, signal) => {
        groupKills.push([target, signal])
        return true
      },
      taskkillImpl: () => {
        throw new Error('非 win32 不得调用 taskkill')
      },
    },
  ).then((value) => {
    settled = true
    return value
  })

  await delay(80)
  assert.equal(spawned[0].options.detached, true, 'POSIX 仍以 detached 进程组启动')
  assert.deepEqual(groupKills, [[-4343, 'SIGKILL']], 'POSIX 杀整个进程组')
  assert.equal(settled, false, '非 win32 不启用 grace，仍等 close')

  child.emit('close', 143)
  const result = await pending
  assert.equal(result.exit, 143)
  assert.equal(result.ok, false, 'expect exit 0，143 不算通过')
})

test('killProcessTree：win32 走 taskkill、POSIX 走进程组，失败各自退化', () => {
  const winChild = fakeChild(111)
  const winPids = []
  const win = killProcessTree(winChild, {
    platform: 'win32',
    taskkillImpl: (pid) => {
      winPids.push(pid)
      return { ok: true, status: 0, error: null }
    },
  })
  assert.equal(win.via, 'taskkill')
  assert.equal(win.ok, true)
  assert.deepEqual(winPids, [111])
  assert.deepEqual(winChild.kills, ['SIGKILL'])

  const noPid = fakeChild()
  delete noPid.pid
  const skipped = killProcessTree(noPid, {
    platform: 'win32',
    taskkillImpl: () => {
      throw new Error('没有 pid 不应调用 taskkill')
    },
  })
  assert.equal(skipped.via, 'taskkill')
  assert.equal(skipped.ok, false)
  assert.deepEqual(noPid.kills, ['SIGKILL'], '没有 pid 时只直杀子进程')

  const posixChild = fakeChild(222)
  const groupTargets = []
  const group = killProcessTree(posixChild, {
    platform: 'linux',
    killImpl: (target, signal) => {
      groupTargets.push([target, signal])
      return true
    },
  })
  assert.equal(group.via, 'group')
  assert.deepEqual(groupTargets, [[-222, 'SIGKILL']])
  assert.deepEqual(posixChild.kills, [], '进程组杀成功就不重复直杀')

  const fallbackChild = fakeChild(333)
  const fallback = killProcessTree(fallbackChild, {
    platform: 'linux',
    killImpl: () => {
      throw codeError('ESRCH')
    },
  })
  assert.equal(fallback.via, 'direct')
  assert.deepEqual(fallbackChild.kills, ['SIGKILL'], '进程组已消失时直杀子进程')
})

test('flow check win32：superviseCheckChild 超时走 taskkill，并在 grace 后 resolve', async () => {
  const child = fakeChild(5150)
  const taskkillPids = []
  const started = Date.now()
  const outcome = await superviseCheckChild(child, 25, {
    platform: 'win32',
    graceMs: 30,
    killImpl: () => {
      throw new Error('win32 分支不得走 POSIX 进程组 kill')
    },
    taskkillImpl: (pid) => {
      taskkillPids.push(pid)
      return { ok: true, status: 0, error: null }
    },
  })
  assert.deepEqual(taskkillPids, [5150])
  assert.deepEqual(child.kills, ['SIGKILL'])
  assert.equal(outcome.timedOut, true, '超时标记要留给 runCheck 报 check-io')
  assert.equal(outcome.code, null)
  assert.equal(outcome.signal, null)
  assert.ok(Date.now() - started < 1500, 'grace 兜底，不能挂死')
  assert.equal(child.stderr.destroyed, true)
})

test('flow check 非 win32：superviseCheckChild 进程组 SIGKILL 且等到 close', async () => {
  const child = fakeChild(5151)
  const groupKills = []
  let settled = false
  const pending = superviseCheckChild(child, 25, {
    platform: 'linux',
    graceMs: 5,
    killImpl: (target, signal) => {
      groupKills.push([target, signal])
      return true
    },
    taskkillImpl: () => {
      throw new Error('非 win32 不得调用 taskkill')
    },
  }).then((value) => {
    settled = true
    return value
  })

  await delay(80)
  assert.deepEqual(groupKills, [[-5151, 'SIGKILL']])
  assert.equal(settled, false, '非 win32 不启用 grace')

  child.emit('close', null, 'SIGKILL')
  const outcome = await pending
  assert.equal(outcome.timedOut, true)
  assert.equal(outcome.signal, 'SIGKILL')
})

test('killProcessTree（checks）：与 core 同语义，导出仅供注入', () => {
  const child = fakeChild(9191)
  const pids = []
  const result = killCheckProcessTree(child, {
    platform: 'win32',
    taskkillImpl: (pid) => {
      pids.push(pid)
      return { ok: true, status: 0, error: null }
    },
  })
  assert.equal(result.via, 'taskkill')
  assert.deepEqual(pids, [9191])
  assert.deepEqual(child.kills, ['SIGKILL'])
})

// --------------------------------------------- B. rename 退避与残留（原子写）

test('原子写：rename 瞬时 EBUSY/EPERM 退避重试后成功，且不残留 .tmp-*', () => {
  const dir = tempDir('rename-retry')
  const file = path.join(dir, 'record.json')
  const sleeps = []
  let attempts = 0
  writeJsonAtomic(
    file,
    { version: 1 },
    {
      renameImpl: (from, to) => {
        attempts += 1
        if (attempts === 1) throw codeError('EBUSY')
        if (attempts === 2) throw codeError('EPERM')
        fs.renameSync(from, to)
      },
      sleepImpl: (ms) => sleeps.push(ms),
    },
  )
  assert.equal(attempts, 3, '两次瞬时失败后第三次成功')
  assert.deepEqual(sleeps, [10, 50], '默认退避序列 10/50/150ms，只 sleep 失败间隔')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1 }, '最终内容完整')
  assert.deepEqual(tempResidue(dir), [], '成功后不残留临时文件')
})

test('原子写：rename 恒 EACCES 重试 4 次后抛 io，且不残留 .tmp-*', () => {
  const dir = tempDir('rename-exhausted')
  const file = path.join(dir, 'record.json')
  const sleeps = []
  let attempts = 0
  assert.throws(
    () =>
      writeJsonAtomic(
        file,
        { version: 1 },
        {
          renameImpl: () => {
            attempts += 1
            throw codeError('EACCES')
          },
          sleepImpl: (ms) => sleeps.push(ms),
        },
      ),
    (error) =>
      error instanceof FlowError &&
      error.code === 'io' &&
      new RegExp(`^cannot write .*record\\.json:`).test(error.message),
  )
  assert.equal(attempts, 4, '退避 10/50/150ms 后共 4 次尝试')
  assert.deepEqual(sleeps, [10, 50, 150], '耗尽退避参数')
  assert.deepEqual(tempResidue(dir), [], '失败路径必须清掉自己的临时文件')
  assert.equal(fs.existsSync(file), false, '目标文件不应出现半成品')
})

test('原子写：非瞬态 rename 错误立即失败（不重试），同样不残留临时文件', () => {
  const dir = tempDir('rename-permanent')
  const file = path.join(dir, 'record.json')
  let attempts = 0
  const sleeps = []
  assert.throws(
    () =>
      writeJsonAtomic(
        file,
        { version: 1 },
        {
          renameImpl: () => {
            attempts += 1
            throw codeError('ENOTDIR')
          },
          sleepImpl: (ms) => sleeps.push(ms),
        },
      ),
    (error) => error instanceof FlowError && error.code === 'io',
  )
  assert.equal(attempts, 1, 'ENOTDIR 不是瞬态错误，只试一次')
  assert.deepEqual(sleeps, [])
  assert.deepEqual(tempResidue(dir), [])
})

// ------------------------------------ C. 心跳 session：保留名 / ADS / 结尾点空格

const RESERVED_DEVICE_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]

test('心跳 session：Windows 保留名（大小写 + 带扩展名）逐项拒绝', () => {
  const { root, contract } = freshProject('win-reserved')
  for (const name of RESERVED_DEVICE_NAMES) {
    for (const bad of [name, name.toLowerCase(), `${name}.json`, `${name.toLowerCase()}.tar.gz`]) {
      expectFlowError(
        () => startHeartbeat(root, contract, { session: bad }),
        'invalid',
        /heartbeat session is not a safe file name/,
      )
    }
  }
  // 读/更新/结束路径共用同一校验（不是只有 start 拦）
  for (const bad of ['CON.txt', 'nul.tar.gz', 'LPT9.log']) {
    expectFlowError(() => heartbeatStatus(root, contract, bad), 'invalid', /not a safe file name/)
    expectFlowError(() => updateHeartbeat(root, contract, bad, { status: 'idle' }), 'invalid', /not a safe file name/)
    expectFlowError(() => endHeartbeat(root, contract, { session: bad }), 'invalid', /not a safe file name/)
  }
})

test('心跳 session：非法字符 [<>:"|?*]（含 NTFS ADS）逐项拒绝', () => {
  const { root, contract } = freshProject('win-chars')
  const bad = ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b', 'stash:stream', 'session:host']
  for (const name of bad) {
    expectFlowError(
      () => startHeartbeat(root, contract, { session: name }),
      'invalid',
      /heartbeat session is not a safe file name/,
    )
  }
})

test('心跳 session：结尾点/空格逐项拒绝（原始值，trim 不能掩盖）', () => {
  const { root, contract } = freshProject('win-tail')
  for (const bad of ['ends-with-dot.', 'ends-with-space ', 'x.', 'a .', 'a.b.']) {
    expectFlowError(
      () => startHeartbeat(root, contract, { session: bad }),
      'invalid',
      /trailing dot or space/,
    )
  }
})

test('心跳 session：反例——不是保留名的近似写法仍然可用并落盘', () => {
  const { root, contract } = freshProject('win-allow')
  const saved = process.env.DSH_SESSION_ID
  delete process.env.DSH_SESSION_ID
  const good = [
    'session-79c1c4e6-ecf5-40a9-98c2-fd7a373a2a85',
    'CONSOLE',
    'com0',
    'lpt10',
    'auxiliary',
    'nulled',
    'session.con',
    'session@host',
    'a.b.c',
    'x'.repeat(80),
  ]
  try {
    for (const name of good) {
      const record = startHeartbeat(root, contract, { session: name, createTask: false })
      assert.equal(record.session, name, `${name} 应原样保留`)
      const file = path.join(root, '.agents/heartbeat', `${name}.json`)
      assert.ok(fs.existsSync(file), `${name} 应写入 ${file}`)
      endHeartbeat(root, contract, { session: name })
    }
  } finally {
    if (saved === undefined) delete process.env.DSH_SESSION_ID
    else process.env.DSH_SESSION_ID = saved
  }
})

test('心跳 session：既有安全规则不回归（空/过长/穿越/控制字符）', () => {
  const { root, contract } = freshProject('win-existing')
  expectFlowError(() => startHeartbeat(root, contract, { session: '   ' }), 'usage', /session is required/)
  expectFlowError(() => startHeartbeat(root, contract, { session: 's'.repeat(81) }), 'invalid', /too long/)
  for (const bad of ['../evil', 'a/b', 'a\\b', '..', 'a\u0000b', 'a\nb']) {
    expectFlowError(() => startHeartbeat(root, contract, { session: bad }), 'invalid', /not a safe file name/)
  }
})

// ------------------------------------------------------- D. 契约文本与实现同步

test('契约同步：CONTRACT.md 与实现同改（保留名/ADS/结尾点空格、win32 taskkill/grace）', () => {
  const contractText = fs.readFileSync(path.join(REPO_ROOT, 'CONTRACT.md'), 'utf8')
  const coreText = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'core.mjs'), 'utf8')
  const checksText = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'checks.mjs'), 'utf8')

  const required = [
    'Windows 保留设备名',
    'NTFS ADS',
    '结尾点或空格',
    'taskkill /PID <pid> /T /F',
    '2 秒 grace',
  ]
  for (const needle of required) {
    assert.ok(contractText.includes(needle), `CONTRACT.md 缺少约束文本：${needle}`)
  }
  for (const needle of ['WINDOWS_RESERVED_SESSION_NAMES', 'WINDOWS_UNSAFE_SESSION_CHARS_RE', 'WIN32_KILL_GRACE_MS']) {
    assert.ok(coreText.includes(needle), `lib/core.mjs 缺少实现：${needle}`)
  }
  for (const needle of ['WIN32_KILL_GRACE_MS', "'taskkill', ['/PID'"]) {
    assert.ok(checksText.includes(needle), `lib/checks.mjs 缺少实现：${needle}`)
  }
  assert.ok(coreText.includes("'taskkill', ['/PID'"), 'core 的 taskkill 参数必须带 /PID /T /F')
  for (const token of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
    assert.ok(contractText.includes(token), `CONTRACT.md 保留名清单缺少 ${token}`)
  }
})

test('CONTRACT.md 写明 rename 重试次数与退避（10/50/150ms、最多 4 次）', () => {
  const contractText = fs.readFileSync(path.join(REPO_ROOT, 'CONTRACT.md'), 'utf8')
  assert.ok(contractText.includes('10/50/150ms'), 'CONTRACT 写明退避序列')
  assert.ok(contractText.includes('最多 4 次'), 'CONTRACT 写明上限次数')
})

// ------------------------------------------------------ E. POSIX 真实子进程收尾

test(
  'POSIX 真实子进程：runStep 超时后进程组被收掉，不残留子进程',
  {
    skip:
      process.platform === 'win32'
        ? 'POSIX-only 行为；win32 分支由上面的注入用例覆盖（taskkill + grace）'
        : false,
  },
  async () => {
    let realChild = null
    const result = await runStep(
      os.tmpdir(),
      { id: 'real-sleep', run: 'sleep 30', expect: 'exit 0' },
      120,
      40,
      {
        spawnImpl: (command, options) => {
          realChild = spawn(command, options)
          return realChild
        },
      },
    )
    assert.equal(result.ok, false, '超时步骤记为失败')
    assert.ok(realChild !== null && typeof realChild.pid === 'number')
    await delay(50)
    assert.throws(
      () => process.kill(realChild.pid, 0),
      `进程组杀完后 pid ${realChild.pid} 应已消失`,
    )
  },
)
