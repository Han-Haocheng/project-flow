// T-20261112183139（阶段 3）：门禁分类（结构 / 行为）+ 挂载点校验 + 分段执行。
//
// 裁定 3：结构门禁可挂四层（layer/module/feature/aspect），行为门禁只能挂功能层；
// 门禁定义里的 failFast 默认 false —— 结构失败不再挡住行为结果（旧行为是首败即停，
// 曾出现「description 红了后面 5 步全没跑」）。本文件只走 core API；CLI 的
// --kind/--mount-level/--fail-fast 参数面由 frontend 线接线后另测。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')

function runCli(cwd, args) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

import {
  addGate,
  getGate,
  initProject,
  listGates,
  loadContract,
  runGate,
  runGatesByPhase,
  updateGate,
} from '../lib/core.mjs'
import { summarizeSegments } from '../lib/gates/records.mjs'

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

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-kinds-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  const { contract } = loadContract(root)
  return { root, contract }
}

function expectFlowError(fn, code) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught !== null, '应当抛错')
  assert.equal(caught.code, code, `期望 FlowError(${code})，实际 ${caught.code}: ${caught.message}`)
  return caught
}

test('默认分类：kind=behavior、挂功能层、failFast=false，步骤继承门禁分类', () => {
  const { root, contract } = freshProject('default')
  const gate = addGate(root, contract, {
    id: 'g-default',
    title: '默认门禁',
    phase: 'commit',
    steps: [{ id: 'a', run: 'true' }, { id: 'b', run: 'true' }],
  })
  assert.equal(gate.kind, 'behavior')
  assert.deepEqual(gate.mount, { level: 'feature' })
  assert.equal(gate.failFast, false)
  assert.deepEqual(gate.steps.map((step) => step.kind), ['behavior', 'behavior'])
  // 落盘的记录与返回一致（更新后再读）。
  assert.equal(getGate(root, contract, 'g-default').kind, 'behavior')
})

test('结构门禁可挂四层；行为门禁挂非功能层 → invalid', () => {
  const { root, contract } = freshProject('mount')
  for (const mount of [
    { level: 'layer' },
    { level: 'module', target: 'gates' },
    { level: 'feature' },
    { level: 'aspect', target: 'concurrency' },
  ]) {
    const gate = addGate(root, contract, {
      id: `s-${mount.level}`,
      title: `结构-${mount.level}`,
      phase: 'manual',
      kind: 'structure',
      mount,
      steps: [{ id: 'a', run: 'true' }],
    })
    assert.equal(gate.kind, 'structure')
    assert.deepEqual(gate.mount, mount)
  }

  const err = expectFlowError(
    () =>
      addGate(root, contract, {
        id: 'b-module',
        title: '行为挂模块',
        phase: 'commit',
        kind: 'behavior',
        mount: { level: 'module', target: 'tasks' },
      }),
    'invalid',
  )
  assert.match(err.message, /behavior 门禁只能挂在功能层/)
  assert.match(err.message, /mount\.level=module/)

  // 非法枚举 / 缺 target / 非法 target 字符，都是定义期 invalid。
  expectFlowError(
    () => addGate(root, contract, { id: 'k-bad', title: 'x', phase: 'manual', kind: 'other' }),
    'invalid',
  )
  expectFlowError(
    () => addGate(root, contract, { id: 'm-bad', title: 'x', phase: 'manual', mount: { level: 'bogus' } }),
    'invalid',
  )
  const noTarget = expectFlowError(
    () =>
      addGate(root, contract, {
        id: 'm-noid',
        title: 'x',
        phase: 'manual',
        kind: 'structure',
        mount: { level: 'module' },
      }),
    'invalid',
  )
  assert.match(noTarget.message, /mount\.target is required/)
  expectFlowError(
    () =>
      addGate(root, contract, {
        id: 'm-chars',
        title: 'x',
        phase: 'manual',
        kind: 'structure',
        mount: { level: 'module', target: 'Bad_Target' },
      }),
    'invalid',
  )
})

test('update：分类/挂载点/failFast 可改，且非法挂载点同样被拒', () => {
  const { root, contract } = freshProject('update')
  addGate(root, contract, { id: 'gate-x', title: 'x', phase: 'manual', steps: [{ id: 'a', run: 'true' }] })
  const updated = updateGate(root, contract, 'gate-x', {
    kind: 'structure',
    mount: { level: 'aspect', target: 'state-machine' },
    failFast: true,
  })
  assert.equal(updated.kind, 'structure')
  assert.deepEqual(updated.mount, { level: 'aspect', target: 'state-machine' })
  assert.equal(updated.failFast, true)
  expectFlowError(
    () => updateGate(root, contract, 'gate-x', { kind: 'behavior', mount: { level: 'aspect', target: 'state-machine' } }),
    'invalid',
  )
})

test('分段执行：结构步骤失败不阻断行为步骤，segments 分别计数；failFast 才停', async () => {
  const { root, contract } = freshProject('segments')
  addGate(root, contract, {
    id: 'mixed',
    title: '混合门禁',
    phase: 'commit',
    kind: 'structure',
    steps: [
      { id: 'struc-fail', run: 'echo missing-anchor >&2; exit 1', expect: 'exit 0', kind: 'structure' },
      { id: 'behav-ok', run: 'echo ok', expect: 'contains:ok', kind: 'behavior' },
      { id: 'behav-fail', run: 'exit 2', expect: 'exit 0', kind: 'behavior' },
    ],
  })

  const record = await runGate(root, contract, 'mixed')
  assert.equal(record.ok, false)
  assert.equal(record.failFast, false)
  assert.equal(record.steps.length, 3, '默认跑完全部步骤')
  assert.deepEqual(record.steps.map((step) => step.kind), ['structure', 'behavior', 'behavior'])
  assert.equal(record.segments.structure.total, 1)
  assert.equal(record.segments.structure.failed, 1)
  assert.equal(record.segments.structure.ok, false)
  assert.equal(record.segments.behavior.total, 2)
  assert.equal(record.segments.behavior.passed, 1)
  assert.equal(record.segments.behavior.failed, 1)
  assert.equal(record.segments.behavior.ok, false)

  const strict = await runGate(root, contract, 'mixed', { failFast: true })
  assert.equal(strict.steps.length, 1, 'failFast=true 时首败即停（旧行为可显式恢复）')
  assert.equal(strict.segments.behavior.total, 0, '没跑到的步骤不得算通过')
  assert.equal(strict.segments.behavior.ok, true)
})

test('summarizeSegments：未执行的步骤不计入任何分段（防「没跑=通过」假绿）', () => {
  const steps = [
    { id: 'a', kind: 'structure' },
    { id: 'b', kind: 'behavior' },
  ]
  const results = [{ id: 'a', ok: false }]
  const segments = summarizeSegments(results, steps)
  assert.equal(segments.structure.total, 1)
  assert.equal(segments.behavior.total, 0)
  assert.equal(segments.behavior.ok, true)
  assert.deepEqual(segments.structure.steps, ['a'])
})

test('gate run --phase：先跑结构门禁再跑行为门禁，结构失败不阻断行为门禁', async () => {
  const { root, contract } = freshProject('phase')
  addGate(root, contract, {
    id: 'z-structure',
    title: '结构门禁',
    phase: 'commit',
    kind: 'structure',
    mount: { level: 'layer' },
    steps: [{ id: 'bad-anchor', run: 'exit 1', expect: 'exit 0' }],
  })
  addGate(root, contract, {
    id: 'a-behavior',
    title: '行为门禁',
    phase: 'commit',
    kind: 'behavior',
    steps: [{ id: 'ok', run: 'true', expect: 'exit 0' }],
  })
  addGate(root, contract, {
    id: 'm-manual',
    title: '别的 phase',
    phase: 'manual',
    kind: 'structure',
    steps: [{ id: 'no', run: 'exit 1', expect: 'exit 0' }],
  })

  const summary = await runGatesByPhase(root, contract, 'commit')
  assert.deepEqual(summary.runs.map((run) => run.gate), ['z-structure', 'a-behavior'], '结构门禁排在行为门禁前')
  assert.equal(summary.runs[0].ok, false)
  assert.equal(summary.runs[1].ok, true, '结构失败后行为门禁仍然执行并通过')
  assert.equal(summary.segments.structure.gates, 1)
  assert.equal(summary.segments.structure.ok, false)
  assert.deepEqual(summary.segments.structure.failed, ['z-structure'])
  assert.equal(summary.segments.behavior.gates, 1)
  assert.equal(summary.segments.behavior.ok, true)
  // manual phase 不应混进来。
  assert.ok(listGates(root, contract).some((gate) => gate.id === 'm-manual'))
})

// ------------------------------------------------------------------ CLI 参数面
// 参数面由 bin/flow.mjs 的 SPEC 声明（frontend 线接线）；这里锁住「分类能从人敲
// 的命令进得去、非法挂载点从命令行也被拒、--fail-fast 语义可覆盖」。

test('CLI：gate add --kind/--mount-level/--mount-target 落盘，list/show 呈现分类', () => {
  const { root } = freshProject('cli-add')
  const added = runCli(root, [
    'gate', 'add', '--id', 'anchors', '--title', '锚点结构门禁', '--phase', 'commit',
    '--kind', 'structure', '--mount-level', 'aspect', '--mount-target', 'contract-text',
    '--step', 'anchors=node -e "process.exit(0)">>exit 0',
    '--json',
  ])
  assert.equal(added.code, 0, added.stdout + added.stderr)
  const gate = JSON.parse(added.stdout).data
  assert.equal(gate.kind, 'structure')
  assert.deepEqual(gate.mount, { level: 'aspect', target: 'contract-text' })

  const listed = runCli(root, ['gate', 'list'])
  assert.match(listed.stdout, /结构\(aspect:contract-text\)/)

  const shown = runCli(root, ['gate', 'show', 'anchors'])
  assert.match(shown.stdout, /kind:\s+structure/)
  assert.match(shown.stdout, /mount:\s+aspect → contract-text/)
  assert.match(shown.stdout, /\[结构\]/)

  // 行为门禁挂非功能层：定义期拒绝（invalid → exit 2），且不落盘。
  const rejected = runCli(root, [
    'gate', 'add', '--id', 'bad-mount', '--title', 'x', '--phase', 'commit',
    '--kind', 'behavior', '--mount-level', 'module', '--mount-target', 'gates',
  ])
  assert.equal(rejected.code, 2, rejected.stdout + rejected.stderr)
  assert.match(rejected.stderr, /behavior 门禁只能挂在功能层/)
  assert.equal(fs.existsSync(path.join(root, '.agents/gates/bad-mount.json')), false)
})

test('CLI：gate run --fail-fast 覆盖默认分段执行', async () => {
  const { root, contract } = freshProject('cli-failfast')
  addGate(root, contract, {
    id: 'chain',
    title: '链',
    phase: 'manual',
    steps: [
      { id: 'first-bad', run: 'exit 1', expect: 'exit 0', kind: 'structure' },
      { id: 'second-ok', run: 'true', expect: 'exit 0', kind: 'behavior' },
    ],
  })
  const slow = runCli(root, ['gate', 'run', 'chain', '--json'])
  assert.equal(slow.code, 0, '门禁失败不改变退出码（由 ok 字段表达）')
  const slowRun = JSON.parse(slow.stdout).data
  assert.equal(slowRun.steps.length, 2)
  assert.equal(slowRun.failFast, false)

  const strict = runCli(root, ['gate', 'run', 'chain', '--fail-fast', '--json'])
  const strictRun = JSON.parse(strict.stdout).data
  assert.equal(strictRun.failFast, true)
  assert.equal(strictRun.steps.length, 1, '--fail-fast 恢复首败即停')
})

// ------------------------------------------------------ pre-commit hook（T-20261113163505）
const NL = String.fromCharCode(10)

function gitRepo(label) {
  const { root } = freshProject(label)
  const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', env: process.env })
  assert.equal(init.status, 0, 'git init 失败：' + init.stderr)
  return root
}

function hookFile(root) {
  return path.join(root, '.git', 'hooks', 'pre-commit')
}

test('gate install-hook：默认不自动安装，显式执行后写可执行 hook（无绝对路径）', () => {
  const root = gitRepo('hook-install')
  assert.equal(fs.existsSync(hookFile(root)), false, 'init 后不应自动安装 hook')

  const result = runCli(root, ['gate', 'install-hook'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const file = hookFile(root)
  assert.equal(fs.existsSync(file), true)
  const content = fs.readFileSync(file, 'utf8')
  assert.ok(content.startsWith('#!/bin/sh' + NL), 'hook 必须自带 shebang')
  assert.ok(content.includes('project-flow-managed-hook: pre-commit'), 'hook 必须有标记行')
  assert.ok(content.includes('flow gate run --phase commit'), 'hook 必须调用 phase 运行')
  assert.equal(content.includes(root), false, 'hook 不得写死安装时的绝对路径')
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o111, 0o111, 'hook 必须可执行')
  assert.ok(result.stdout.includes('已安装'))
  assert.ok(result.stdout.includes('--uninstall'), '输出必须说明如何卸载')
  assert.ok(result.stdout.includes('自动纳入'), '输出必须说明新增 commit 门禁自动纳入')
})

test('gate install-hook 幂等：重复安装内容不变，changed=false', () => {
  const root = gitRepo('hook-idem')
  assert.equal(runCli(root, ['gate', 'install-hook']).code, 0)
  const first = fs.readFileSync(hookFile(root), 'utf8')
  const again = runCli(root, ['gate', 'install-hook', '--json'])
  assert.equal(again.code, 0, again.stdout + again.stderr)
  assert.equal(fs.readFileSync(hookFile(root), 'utf8'), first, '内容必须保持不变')
  assert.equal(JSON.parse(again.stdout).data.changed, false)
})

test('gate install-hook：已有非本工具 hook 默认不覆盖；--force 才覆盖', () => {
  const root = gitRepo('hook-foreign')
  const file = hookFile(root)
  const foreign = '#!/bin/sh' + NL + 'echo custom' + NL
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, foreign, { mode: 0o755 })

  const blocked = runCli(root, ['gate', 'install-hook'])
  assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr)
  assert.ok(blocked.stderr.includes('--force'), '错误必须提示 --force')
  assert.equal(fs.readFileSync(file, 'utf8'), foreign, '非本工具 hook 不得被改')

  const forced = runCli(root, ['gate', 'install-hook', '--force'])
  assert.equal(forced.code, 0, forced.stdout + forced.stderr)
  assert.ok(fs.readFileSync(file, 'utf8').includes('project-flow-managed-hook: pre-commit'))
})

test('gate install-hook --uninstall：只删本工具生成；非本工具与冲突参数是可读失败', () => {
  const root = gitRepo('hook-uninstall')
  assert.equal(runCli(root, ['gate', 'install-hook']).code, 0)
  const removed = runCli(root, ['gate', 'install-hook', '--uninstall'])
  assert.equal(removed.code, 0, removed.stdout + removed.stderr)
  assert.equal(fs.existsSync(hookFile(root)), false)
  assert.ok(removed.stdout.includes('已卸载'))

  const again = runCli(root, ['gate', 'install-hook', '--uninstall', '--json'])
  assert.equal(again.code, 0, again.stdout + again.stderr)
  assert.equal(JSON.parse(again.stdout).data.removed, false)

  const file = hookFile(root)
  const foreign = '#!/bin/sh' + NL + 'echo foreign' + NL
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, foreign)
  const refused = runCli(root, ['gate', 'install-hook', '--uninstall'])
  assert.equal(refused.code, 1, refused.stdout + refused.stderr)
  assert.ok(refused.stderr.includes('不是本工具生成'))
  assert.equal(fs.readFileSync(file, 'utf8'), foreign, '非本工具 hook 不得被删')

  const both = runCli(root, ['gate', 'install-hook', '--uninstall', '--force'])
  assert.equal(both.code, 1)
  assert.ok(both.stderr.includes('不能同时使用'))
})

test('gate install-hook：--phase release 与非 git 目录都是可读失败（exit 1），不落文件', () => {
  const root = gitRepo('hook-phase')
  const released = runCli(root, ['gate', 'install-hook', '--phase', 'release'])
  assert.equal(released.code, 1, released.stdout + released.stderr)
  assert.ok(released.stderr.includes('只绑定 --phase commit'))
  assert.equal(fs.existsSync(hookFile(root)), false)

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-hook-nogit-'))
  TEMP_ROOTS.push(plain)
  initProject(plain, { name: 'nogit', noGates: true })
  const nogit = runCli(plain, ['gate', 'install-hook'])
  assert.equal(nogit.code, 1, nogit.stdout + nogit.stderr)
  assert.ok(nogit.stderr.includes('不在 git 工作区'))
  assert.equal(fs.existsSync(path.join(plain, '.git')), false)
})

test('gate install-hook：core.hooksPath（husky/自定义）命中时写到该目录并告知', () => {
  const root = gitRepo('hook-hookspath')
  const conf = spawnSync('git', ['-C', root, 'config', 'core.hooksPath', '.husky'], { encoding: 'utf8' })
  assert.equal(conf.status, 0, conf.stderr)

  const result = runCli(root, ['gate', 'install-hook'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const file = path.join(root, '.husky', 'pre-commit')
  assert.equal(fs.existsSync(file), true, '必须写进 core.hooksPath')
  assert.equal(fs.existsSync(hookFile(root)), false, '不得再写 .git/hooks')
  assert.ok(fs.readFileSync(file, 'utf8').includes('project-flow-managed-hook: pre-commit'))
  assert.ok(result.stdout.includes('core.hooksPath'), '输出必须告知 hooksPath')
  assert.ok(result.stdout.includes('主工作区'), '输出必须说明影响主工作区提交')

  const again = runCli(root, ['gate', 'install-hook', '--json'])
  assert.equal(again.code, 0, again.stdout + again.stderr)
  const againData = JSON.parse(again.stdout).data
  assert.equal(againData.hooksPath, '.husky')
  assert.equal(againData.hook, file)
  assert.equal(againData.changed, false, '重复安装必须幂等（changed:false）')

  const removed = runCli(root, ['gate', 'install-hook', '--uninstall'])
  assert.equal(removed.code, 0, removed.stdout + removed.stderr)
  assert.equal(fs.existsSync(file), false, '卸载也必须按 hooksPath 走')
})

test('gate install-hook：core.hooksPath 的 ~ 由 git --path 展开（不得写成 <repo>/~/hooks）', () => {
  const root = gitRepo('hook-tilde')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-hook-home-'))
  TEMP_ROOTS.push(home)
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const conf = spawnSync('git', ['-C', root, 'config', 'core.hooksPath', '~/hooks'], { encoding: 'utf8', env: process.env })
    assert.equal(conf.status, 0, conf.stderr)

    const result = runCli(root, ['gate', 'install-hook', '--json'])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    const data = JSON.parse(result.stdout).data
    const expected = path.join(home, 'hooks')
    assert.equal(data.hooksPath, expected, '~ 必须展开成绝对路径')
    assert.equal(data.hook, path.join(expected, 'pre-commit'))
    assert.equal(fs.existsSync(path.join(expected, 'pre-commit')), true)
    assert.equal(fs.existsSync(path.join(root, '~', 'hooks', 'pre-commit')), false, '不得写成 <repo>/~/hooks')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})

test('hook：--json 缺 data.runs 时 fail-closed（不能因 every([]) 放行）', () => {
  const root = gitRepo('hook-no-runs')
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-fake-bin-'))
  TEMP_ROOTS.push(fakeDir)
  const fakeFlow = path.join(fakeDir, 'flow')
  const payload = JSON.stringify({ schemaVersion: 1, ok: true, warnings: [] })
  fs.writeFileSync(fakeFlow, '#!/bin/sh\nprintf %s ' + "'" + payload + "'" + '\nexit 0\n', { mode: 0o755 })
  assert.equal(runCli(root, ['gate', 'install-hook']).code, 0)

  const env = { ...process.env, PATH: fakeDir + ':' + (process.env.PATH ?? '') }
  const result = spawnSync('sh', [hookFile(root)], { cwd: root, encoding: 'utf8', env })
  assert.equal(result.status, 1, '缺 data.runs 必须拦下：' + result.stdout + result.stderr)
  assert.ok(result.stderr.includes('提交被拦下'), '必须给出可读原因')
})


test('E2E：装 hook 后 commit 阶段红门禁真的拦下 git commit；改绿后放行', () => {
  const root = gitRepo('hook-e2e')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.symlinkSync(BIN, path.join(bin, 'flow.mjs'))

  const added = runCli(root, ['gate', 'add', '--id', 'red', '--title', '红门禁', '--phase', 'commit', '--step', 'bad=exit 1'])
  assert.equal(added.code, 0, added.stdout + added.stderr)
  assert.equal(runCli(root, ['gate', 'install-hook']).code, 0)

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'flow-test', GIT_AUTHOR_EMAIL: 'flow@test',
    GIT_COMMITTER_NAME: 'flow-test', GIT_COMMITTER_EMAIL: 'flow@test',
  }
  const blocked = spawnSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'blocked'], { encoding: 'utf8', env })
  assert.notEqual(blocked.status, 0, '红门禁必须拦下提交：' + blocked.stdout + blocked.stderr)
  assert.ok((blocked.stdout + blocked.stderr).includes('提交被拦下'), 'hook 必须给出可读原因')
  const count = spawnSync('git', ['-C', root, 'rev-list', '--count', '--all'], { encoding: 'utf8', env })
  assert.equal(count.stdout.trim(), '0', '被拦下的提交不得落库')

  assert.equal(runCli(root, ['gate', 'update', 'red', '--step', 'ok=exit 0']).code, 0)
  const allowed = spawnSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'allowed'], { encoding: 'utf8', env })
  assert.equal(allowed.status, 0, '绿门禁必须放行：' + allowed.stdout + allowed.stderr)
})

test('hook 判定收窄：步骤 stdout 出现 "ok":false 但门禁通过时 commit 放行（不误伤）', () => {
  const root = gitRepo('hook-noise')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.symlinkSync(BIN, path.join(bin, 'flow.mjs'))
  fs.writeFileSync(path.join(root, 'print-noise.mjs'), 'process.stdout.write(' + JSON.stringify('"ok":false') + ')')

  const added = runCli(root, ['gate', 'add', '--id', 'noisy', '--title', '噪声', '--phase', 'commit', '--step', 'noise=node print-noise.mjs'])
  assert.equal(added.code, 0, added.stdout + added.stderr)
  assert.equal(runCli(root, ['gate', 'install-hook']).code, 0)

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'flow-test', GIT_AUTHOR_EMAIL: 'flow@test',
    GIT_COMMITTER_NAME: 'flow-test', GIT_COMMITTER_EMAIL: 'flow@test',
  }
  const committed = spawnSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'ok'], { encoding: 'utf8', env })
  assert.equal(committed.status, 0, '步骤输出里的 "ok":false 不应误拦：' + committed.stdout + committed.stderr)
})


