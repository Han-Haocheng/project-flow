// `flow check` 回归测试：全部在 os.tmpdir() 下的一次性目录里跑，不联网、不碰真实项目。
//
// git 一律在临时仓库内初始化；提交身份/签名用 `-c` 显式给出，并通过
// GIT_CONFIG_GLOBAL/SYSTEM 指向 os.devNull，绝不依赖宿主机的全局 git 配置。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.GIT_CONFIG_GLOBAL = os.devNull
process.env.GIT_CONFIG_SYSTEM = os.devNull
process.env.GIT_CONFIG_NOSYSTEM = '1'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')

const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结论
    }
  }
})

// ------------------------------------------------------------------ helpers

function tempRoot(label = 'case') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flow-check-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

const GIT_IDENTITY = [
  '-c', 'user.name=Flow Check',
  '-c', 'user.email=flow-check@example.invalid',
  '-c', 'commit.gpgsign=false',
  '-c', 'init.defaultBranch=main',
]

function git(root, args) {
  const result = spawnSync('git', [...GIT_IDENTITY, '-C', root, ...args], { encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} 失败（exit ${result.status}）：${result.stderr || result.stdout}`,
  )
  return result.stdout
}

function commitAll(root, message) {
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', message])
}

/** 建一个带初始提交的临时 git 仓库；src/ 与 other/ 各有一个已跟踪文件。 */
function gitRepo(label = 'repo') {
  const root = tempRoot(label)
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'other'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'base.js'), 'export const base = 1\n')
  fs.writeFileSync(path.join(root, 'other', 'base.js'), 'export const other = 1\n')
  git(root, ['init', '-q'])
  commitAll(root, 'chore: fixture')
  return root
}

/** 发布基线仓库：marker 提交后再追加 after 个提交。 */
function releaseRepo(label, after = 3) {
  const root = tempRoot(label)
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n')
  git(root, ['init', '-q'])
  commitAll(root, 'chore: release v1.0')
  for (let i = 0; i < after; i++) {
    fs.writeFileSync(path.join(root, `step-${i}.txt`), `${i}\n`)
    commitAll(root, `feat: step ${i}`)
  }
  return root
}

function runCli(root, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  })
  let json = null
  if (args.includes('--json')) {
    const text = result.stdout.trim()
    assert.ok(text !== '', `期望 JSON 输出，实际为空。stderr: ${result.stderr}`)
    try {
      json = JSON.parse(text)
    } catch (error) {
      assert.fail(`stdout 不是合法 JSON：${text}\n（${error.message}）`)
    }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

function pythonAvailable() {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  return !probe.error && probe.status === 0
}

const STATE_VALID = [
  'state_version: 1',
  'updated_at: 2026-10-28T19:00:00+08:00',
  'baseline: 0000000000000000000000000000000000000000',
  '',
  '## Active',
  '- 无',
  '',
].join('\n')

// -------------------------------------------------------------------- list

test('check list --json 暴露四项检查与包内脚本路径', () => {
  const root = tempRoot('list')
  const result = runCli(root, ['check', 'list', '--json'])
  assert.equal(result.code, 0)
  assert.equal(result.json.ok, true)
  const checks = result.json.data.checks
  assert.deepEqual(
    checks.map((item) => item.name),
    ['staged', 'release-baseline', 'state', 'doc'],
  )
  for (const item of checks) {
    assert.ok(['bash', 'python3'].includes(item.interpreter), `解释器异常：${item.interpreter}`)
    assert.match(item.script, /^skills\/ai-collaborative-dev-workflow\/scripts\//)
    assert.ok(item.description.length > 0)
    assert.ok(item.args.length > 0)
  }
})

test('check list 纯文本列出用法（不 spawn 脚本）', () => {
  const root = tempRoot('list-plain')
  const result = runCli(root, ['check', 'list'])
  assert.equal(result.code, 0)
  for (const needle of ['check staged --allow', 'check release-baseline --marker', 'check state', 'check doc --file']) {
    assert.ok(result.stdout.includes(needle), `缺少：${needle}\n${result.stdout}`)
  }
})

test('未知检查名是用法错误（exit 2）', () => {
  const root = tempRoot('unknown')
  const result = runCli(root, ['check', 'bogus', '--json'])
  assert.equal(result.code, 2)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'usage')
  assert.match(result.json.error.message, /未知检查/)
})

test('flow check --help 仍可用并列出 check 用法', () => {
  const root = tempRoot('help')
  const result = runCli(root, ['check', '--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /check staged --allow/)
  assert.match(result.stdout, /check release-baseline --marker/)
  assert.match(result.stdout, /check doc --file/)
})

test('解释器缺失映射为 check-missing（exit 3）', () => {
  const root = gitRepo('missing-interpreter')
  fs.writeFileSync(path.join(root, 'src', 'feature.js'), 'x\n')
  git(root, ['add', 'src/feature.js'])

  // PATH 为空：脚本文件在，但 `bash` 起不来 → check-missing。
  const result = spawnSync(process.execPath, [BIN, 'check', 'staged', '--allow', 'src', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
  })
  assert.equal(result.status, 3, `stderr: ${result.stderr}`)
  const json = JSON.parse(result.stdout)
  assert.equal(json.ok, false)
  assert.equal(json.error.code, 'check-missing')
})

test('超时映射为 check-io（exit 4）且 1 秒内返回', (t) => {
  if (process.platform === 'win32') {
    t.skip('该用例依赖 POSIX 进程组杀掉慢子进程')
    return
  }
  const root = gitRepo('check-timeout')
  fs.writeFileSync(path.join(root, 'COLLAB_STATE.md'), STATE_VALID)

  // 假的慢 git：让 check_state.sh 卡在 `git rev-parse` 上。
  const fakeDir = path.join(tempRoot('fake-git'), 'bin')
  fs.mkdirSync(fakeDir, { recursive: true })
  const fakeGit = path.join(fakeDir, 'git')
  fs.writeFileSync(fakeGit, '#!/bin/bash\nsleep 30\n')
  fs.chmodSync(fakeGit, 0o755)

  const started = Date.now()
  const result = spawnSync(process.execPath, [BIN, 'check', 'state', '--timeout', '1', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ''}` },
    timeout: 20000,
  })
  const elapsed = Date.now() - started
  assert.equal(result.status, 4, `stderr: ${result.stderr}`)
  const json = JSON.parse(result.stdout)
  assert.equal(json.ok, false)
  assert.equal(json.error.code, 'check-io')
  assert.equal(json.error.exitCode, null)
  assert.match(json.error.message, /超时/)
  assert.ok(elapsed < 10000, `超时应尽快返回，实际 ${elapsed}ms`)
})

test('--timeout 非正整数是用法错误（exit 2），合法值透传', () => {
  const root = gitRepo('timeout-usage')
  fs.writeFileSync(path.join(root, 'COLLAB_STATE.md'), STATE_VALID)
  for (const value of ['0', '-1', 'abc', '1.5']) {
    const bad = runCli(root, ['check', 'state', '--timeout', value, '--json'])
    assert.equal(bad.code, 2, `--timeout ${value} 应被拒绝`)
    assert.equal(bad.json.error.code, 'usage')
  }
  const ok = runCli(root, ['check', 'state', '--timeout', '30', '--json'])
  assert.equal(ok.code, 0, `stderr: ${ok.stderr}`)
})

// ------------------------------------------------------------------ staged

test('staged：暂存区全在 --allow 内通过', () => {
  const root = gitRepo('staged-ok')
  fs.writeFileSync(path.join(root, 'src', 'feature.js'), 'export const feature = 2\n')
  git(root, ['add', 'src/feature.js'])

  const result = runCli(root, ['check', 'staged', '--allow', 'src', '--json'])
  assert.equal(result.code, 0)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.data.check, 'staged')
  assert.equal(result.json.data.exitCode, 0)
  assert.match(result.json.data.stdout, /\[OK\] 暂存区全部在允许清单内/)
  assert.equal(result.json.data.stderr, '')
  assert.equal(typeof result.json.data.durationMs, 'number')
})

test('staged：--allow 的 ./ 前缀与结尾 / 被规范化（脚本只认裸前缀）', () => {
  const root = gitRepo('staged-normalize')
  fs.writeFileSync(path.join(root, 'src', 'feature.js'), 'n\n')
  git(root, ['add', 'src/feature.js'])
  for (const allow of ['src', 'src/', './src', './src/']) {
    const result = runCli(root, ['check', 'staged', '--allow', allow, '--json'])
    assert.equal(result.code, 0, `--allow ${allow} 应通过。stderr: ${result.stderr}`)
  }
})

test('staged：清单外文件被暂存则失败（exit 1 / check-failed）', () => {
  const root = gitRepo('staged-fail')
  fs.writeFileSync(path.join(root, 'other', 'feature.js'), 'export const other = 2\n')
  git(root, ['add', 'other/feature.js'])

  const result = runCli(root, ['check', 'staged', '--allow', 'src', '--json'])
  assert.equal(result.code, 1)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'check-failed')
  assert.equal(result.json.error.check, 'staged')
  assert.equal(result.json.error.exitCode, 1)
  assert.match(result.json.error.stderr, /归属外/)
  assert.equal(result.json.error.stdout, '')
})

test('staged：空暂存区失败（脚本自身的检查）', () => {
  const root = gitRepo('staged-empty')
  const result = runCli(root, ['check', 'staged', '--allow', 'src', '--json'])
  assert.equal(result.code, 1)
  assert.equal(result.json.error.code, 'check-failed')
  assert.match(result.json.error.stderr, /暂存区为空/)
})

test('staged：缺 --allow 是用法错误（exit 2）', () => {
  const root = gitRepo('staged-usage')
  const result = runCli(root, ['check', 'staged', '--json'])
  assert.equal(result.code, 2)
  assert.equal(result.json.error.code, 'usage')
  assert.match(result.json.error.message, /--allow/)
})

test('staged：纯文本模式原样转发脚本输出与退出码', () => {
  const root = gitRepo('staged-plain')
  fs.writeFileSync(path.join(root, 'src', 'feature.js'), 'x\n')
  git(root, ['add', 'src/feature.js'])

  const pass = runCli(root, ['check', 'staged', '--allow', 'src'])
  assert.equal(pass.code, 0)
  assert.match(pass.stdout, /\[OK\] 暂存区全部在允许清单内/)

  fs.writeFileSync(path.join(root, 'other', 'feature.js'), 'y\n')
  git(root, ['add', 'other/feature.js'])
  const fail = runCli(root, ['check', 'staged', '--allow', 'src'])
  assert.equal(fail.code, 1)
  assert.match(fail.stderr, /归属外/)
  assert.doesNotMatch(fail.stderr, /错误（/)
})

test('全局 --root 生效：脚本在项目根而不是当前目录执行', () => {
  const root = gitRepo('root-flag')
  const elsewhere = tempRoot('root-elsewhere')
  fs.writeFileSync(path.join(root, 'src', 'feature.js'), 'z\n')
  git(root, ['add', 'src/feature.js'])

  const result = runCli(elsewhere, ['--root', root, 'check', 'staged', '--allow', 'src', '--json'])
  assert.equal(result.code, 0, `stderr: ${result.stderr}`)
  assert.equal(result.json.ok, true)
})

// --------------------------------------------------------- release-baseline

test('release-baseline：达到阈值通过、低于阈值失败、缺基线失败', () => {
  const root = releaseRepo('release', 3)
  const marker = 'chore: release v1.0'

  const pass = runCli(root, [
    'check', 'release-baseline', '--marker', marker, '--threshold', '2', '--json',
  ])
  assert.equal(pass.code, 0, `stderr: ${pass.stderr}`)
  assert.match(pass.json.data.stdout, /baseline=[0-9a-f]{7,}/)
  assert.match(pass.json.data.stdout, /count=3/)
  assert.match(pass.json.data.stdout, /release_due=yes/)

  const fail = runCli(root, [
    'check', 'release-baseline', '--marker', marker, '--threshold', '5', '--json',
  ])
  assert.equal(fail.code, 1)
  assert.equal(fail.json.error.code, 'check-failed')
  assert.match(fail.json.error.stdout, /count=3/)
  assert.match(fail.json.error.stdout, /release_due=no/)

  const missing = runCli(root, [
    'check', 'release-baseline', '--marker', 'no-such-marker', '--json',
  ])
  assert.equal(missing.code, 1)
  assert.equal(missing.json.error.code, 'check-failed')
  assert.match(missing.json.error.stderr, /未找到发布基线/)
})

test('release-baseline：不给 --threshold 时交给脚本默认值（10）', () => {
  const root = releaseRepo('release-default', 3)
  const result = runCli(root, ['check', 'release-baseline', '--marker', 'chore: release v1.0', '--json'])
  assert.equal(result.code, 1)
  assert.match(result.json.error.stdout, /count=3/)
  assert.match(result.json.error.stdout, /release_due=no/)
})

test('release-baseline：缺 --marker 是用法错误（exit 2）', () => {
  const root = releaseRepo('release-usage', 1)
  const result = runCli(root, ['check', 'release-baseline', '--json'])
  assert.equal(result.code, 2)
  assert.equal(result.json.error.code, 'usage')
  assert.match(result.json.error.message, /--marker/)
})

// ------------------------------------------------------------------- state

test('state：缺失状态文件失败（exit 1）', () => {
  const root = gitRepo('state-missing')
  const result = runCli(root, ['check', 'state', '--json'])
  assert.equal(result.code, 1)
  assert.equal(result.json.error.code, 'check-failed')
  assert.match(result.json.error.stderr, /状态文件不存在/)
})

test('state：最小合规 COLLAB_STATE.md 通过，且 --file 被转发', () => {
  const root = gitRepo('state-ok')
  fs.writeFileSync(path.join(root, 'COLLAB_STATE.md'), STATE_VALID)

  const defaults = runCli(root, ['check', 'state', '--json'])
  assert.equal(defaults.code, 0, `stderr: ${defaults.stderr}`)
  assert.match(defaults.json.data.stdout, /\[OK\] 状态文件基础检查通过/)

  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs', 'CUSTOM_STATE.md'), STATE_VALID.replace('state_version: 1', 'state_version: 2'))
  const custom = runCli(root, ['check', 'state', '--file', 'docs/CUSTOM_STATE.md', '--json'])
  assert.equal(custom.code, 0, `stderr: ${custom.stderr}`)
  assert.match(custom.json.data.stdout, /\[OK\] 状态文件基础检查通过/)

  // 默认文件不存在但自定义文件存在：若 --file 没被转发就会失败。
  fs.rmSync(path.join(root, 'COLLAB_STATE.md'))
  const after = runCli(root, ['check', 'state', '--file', 'docs/CUSTOM_STATE.md', '--json'])
  assert.equal(after.code, 0, `stderr: ${after.stderr}`)
})

// --------------------------------------------------------------------- doc

test('doc：合规 task 文档通过、缺章节失败（并转发 --root 的文档标准）', (t) => {
  if (!pythonAvailable()) {
    t.skip('python3 不可用，跳过 doc 检查')
    return
  }

  const root = tempRoot('doc')
  const elsewhere = tempRoot('doc-elsewhere')
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true })

  // 自定义文档标准：只有 --root 被转发到 doc_check.py 时才会被读到。
  fs.writeFileSync(
    path.join(root, '.agents', 'doc-standard.json'),
    JSON.stringify({ required_sections: { task: ['目标', '验收'] } }, null, 2),
  )
  fs.writeFileSync(
    path.join(root, 'docs', 'T-min.md'),
    ['# 任务书', '', '## 目标', '实现 flow check 包装。', '', '## 验收', 'node --test test/ 通过。', ''].join('\n'),
  )

  const pass = runCli(elsewhere, [
    '--root', root, 'check', 'doc', '--file', 'docs/T-min.md', '--type', 'task', '--json',
  ])
  assert.equal(pass.code, 0, `stdout: ${pass.stdout}\nstderr: ${pass.stderr}`)
  assert.equal(pass.json.ok, true)
  assert.match(pass.json.data.stdout, /^OK$/m)

  // 退回默认标准后同一份文档缺 §范围/§不变量 等章节 → 失败。
  fs.rmSync(path.join(root, '.agents', 'doc-standard.json'))
  const fail = runCli(elsewhere, [
    '--root', root, 'check', 'doc', '--file', 'docs/T-min.md', '--type', 'task', '--json',
  ])
  assert.equal(fail.code, 1)
  assert.equal(fail.json.error.code, 'check-failed')
  assert.equal(fail.json.error.exitCode, 1)
  assert.match(fail.json.error.stderr, /缺少章节/)
})

test('doc：缺 --type / 非法 --type 是用法错误（exit 2）', (t) => {
  if (!pythonAvailable()) {
    t.skip('python3 不可用，跳过 doc 检查')
    return
  }
  const root = tempRoot('doc-usage')
  fs.writeFileSync(path.join(root, 'T.md'), '# x\n')

  const missing = runCli(root, ['check', 'doc', '--file', 'T.md', '--json'])
  assert.equal(missing.code, 2)
  assert.equal(missing.json.error.code, 'usage')
  assert.match(missing.json.error.message, /--type/)

  const bad = runCli(root, ['check', 'doc', '--file', 'T.md', '--type', 'note', '--json'])
  assert.equal(bad.code, 2)
  assert.equal(bad.json.error.code, 'usage')
})
