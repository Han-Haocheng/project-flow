// T-20261113153750 A0：工作树隔离探针（只验证，不改行为）。
//
// 真实行为探针（临时 git 仓库 + 临时 worktree，跑完必 remove）：
//   1) 树内 flow state --json 读到主树台账（树内没有 .agents/flow）；
//   2) 树内 heartbeat start 写主树心跳，不写树内；
//   3) 树内 git status 干净、.agents 被 ignore；
//   4) 树内 desc plan 的 base.commit = 分支 HEAD、base.clean = true；
//   5) 分支未合并时主树 check description 的实际结果（如实记录，不伪造）；
//   6) merge --no-ff 后仍绿，worktree remove 后干净。
//
// 所有 git 操作都在一次性临时仓库里，不碰真实分支/真实 worktree。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { addTask, initProject, loadContract } from '../lib/core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
const BRANCH = 'probe/a0-worktree'
const DIRTY = 'lib/a0-probe.mjs'

/** 干净子进程环境：不带宿主会话 id，模拟独立 CLI。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env, PROJECT_FLOW_CLAIM_GATE: 'off', ...extra }
  delete env.DSH_SESSION_ID
  return env
}

function run(cwd, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: options.env ?? cleanEnv(),
    timeout: options.timeout ?? 120000,
  })
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error === undefined ? null : result.error.message,
  }
}

function git(cwd, args) {
  return run(cwd, 'git', args)
}

function gitOk(cwd, args) {
  const result = git(cwd, args)
  assert.equal(result.code, 0, `git ${args.join(' ')} 失败：${result.stderr || result.error}`)
  return result.stdout.trim()
}

function flow(cwd, args) {
  return run(cwd, process.execPath, [BIN, ...args])
}

function flowJson(cwd, args, label) {
  const result = flow(cwd, [...args, '--json'])
  let body = null
  try {
    body = JSON.parse(result.stdout)
  } catch {
    // 解析失败在下面统一报错，附带原始输出。
  }
  assert.ok(
    body !== null,
    `${label} 没有输出可解析的 JSON（exit ${result.code}）：${(result.stdout || result.stderr).slice(0, 500)}`,
  )
  return { result, body }
}

test('A0 工作树隔离：台账/心跳/保护/计划/合流实测', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-a0-worktree-'))
  const tree = path.join(root, '.agents', 'worktrees', 'probe-a0')
  let worktreeAdded = false
  try {
    // ---- 临时仓库（.agents 与临时 worktree 目录都被忽略） ----
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(root, '.gitignore'), '.agents/\n*.tmp-*\n')
    fs.writeFileSync(path.join(root, 'lib', 'a0-probe.mjs'), 'export const a0 = 1\n')
    gitOk(root, ['init', '-q', '-b', 'main'])
    gitOk(root, ['config', 'user.email', 'a0-probe@example.invalid'])
    gitOk(root, ['config', 'user.name', 'A0 Probe'])
    gitOk(root, ['add', '.gitignore', DIRTY])
    gitOk(root, ['commit', '-q', '-m', 'fixture: base'])

    // 台账建在主树（.agents 被忽略，不参与 git）。
    initProject(root, { name: 'a0-probe', noGates: true })
    const { contract } = loadContract(root)
    const task = addTask(root, contract, { type: 'feat', title: 'A0 工作树探针', stage: 'queued-analysis' })

    // ---- 临时 worktree + 分支（只在临时仓库内） ----
    fs.mkdirSync(path.dirname(tree), { recursive: true })
    gitOk(root, ['worktree', 'add', '-q', '-b', BRANCH, tree, 'HEAD'])
    worktreeAdded = true
    fs.appendFileSync(path.join(tree, DIRTY), '// branch-only change\n')
    gitOk(tree, ['add', DIRTY])
    gitOk(tree, ['commit', '-q', '-m', 'fixture: branch change'])
    const branchHead = gitOk(tree, ['rev-parse', 'HEAD'])
    assert.equal(gitOk(tree, ['status', '--porcelain']), '', '夹具前提：树内工作树必须干净')

    await t.test('1) 树内 flow state --json 读主树台账', (t2) => {
      const { body } = flowJson(tree, ['state'], 'flow state')
      assert.equal(body.ok, true)
      // 实际行为：payload.root 是当前工作区（树内），但台账数据来自主树——
      // 树内没有 .agents/flow，却能看到只在主树创建的任务，就是主树台账的证据。
      t2.diagnostic('payload.root=' + body.data.root + '（实际：当前工作区）')
      assert.equal(fs.existsSync(path.join(tree, '.agents', 'flow', 'flow.json')), false, '树内不得有 .agents/flow')
      assert.ok(JSON.stringify(body.data).includes(task.id), `树内 state 必须读到主树任务 ${task.id}`)
    })

    await t.test('2) 树内 heartbeat start 写主树心跳', () => {
      const session = 'a0-probe-wt-' + process.pid
      const started = flowJson(tree, ['heartbeat', 'start', '--session', session, '--goal', 'A0 worktree probe'], 'heartbeat start')
      assert.equal(started.result.code, 0, started.result.stderr)
      const mainBeat = path.join(root, '.agents', 'heartbeat', session + '.json')
      const treeBeat = path.join(tree, '.agents', 'heartbeat', session + '.json')
      assert.equal(fs.existsSync(mainBeat), true, '心跳必须落在主树 .agents/heartbeat')
      assert.equal(fs.existsSync(treeBeat), false, '树内不得出现心跳文件')
      flowJson(tree, ['heartbeat', 'end', '--session', session], 'heartbeat end')
    })

    await t.test('3) 树内 git status 干净且 .agents 被 ignore', () => {
      assert.equal(gitOk(tree, ['status', '--porcelain']), '', '树内 git status 必须干净')
      const ignored = git(tree, ['check-ignore', '-v', path.join('.agents', 'flow', 'flow.json')])
      assert.equal(ignored.code, 0, '.agents/flow/flow.json 必须被 gitignore 命中：' + ignored.stderr)
      assert.match(ignored.stdout, /\.agents\//, 'git check-ignore 的规则应来自 .agents/')
    })

    await t.test('4) 树内 desc plan 的 base.commit = 分支 HEAD、clean = true', () => {
      const planned = flowJson(
        tree,
        ['desc', 'plan', task.id, '--no-semantic-change', '--reason', 'A0 worktree probe'],
        'desc plan',
      )
      assert.equal(planned.result.code, 0, planned.result.stderr)
      const plan = planned.body?.data?.plan ?? planned.body?.data
      assert.ok(plan !== null && typeof plan === 'object', 'desc plan 必须返回计划对象')
      assert.equal(plan.base?.commit, branchHead, 'base.commit 必须取树内分支 HEAD（不是主树 HEAD）')
      assert.equal(plan.base?.clean, true, '树内干净时 base.clean 必须为 true')
      assert.notEqual(plan.base.commit, gitOk(root, ['rev-parse', 'HEAD']), '夹具前提：分支 HEAD 与主树 HEAD 不同')
    })

    let unmerged = null
    await t.test('5) 分支未合并时主树 check description 的实际结果（如实记录）', (t2) => {
      const { result, body } = flowJson(root, ['check', 'description'], 'check description')
      unmerged = { exit: result.code, ok: body?.data?.ok ?? body?.ok ?? null }
      t2.diagnostic('未合并 check description：exit=' + unmerged.exit + ' ok=' + String(unmerged.ok))
      assert.equal(typeof unmerged.ok, 'boolean', 'check description 必须返回可读的 ok 布尔值')
    })

    await t.test('6) merge --no-ff 后仍绿，worktree remove 后干净', (t2) => {
      gitOk(root, ['merge', '--no-ff', '-m', 'merge: A0 probe', BRANCH])
      const merged = flowJson(root, ['check', 'description'], 'check description after merge')
      const ok = merged.body?.data?.ok ?? merged.body?.ok ?? null
      t2.diagnostic('合并后 check description：exit=' + merged.result.code + ' ok=' + String(ok))
      assert.equal(ok, true, 'merge --no-ff 后 check description 必须仍绿')

      gitOk(root, ['worktree', 'remove', '--force', tree])
      worktreeAdded = false
      assert.equal(fs.existsSync(tree), false, 'worktree remove 后目录必须消失')
      assert.equal(gitOk(root, ['worktree', 'list', '--porcelain']).includes(tree), false, 'worktree list 不得再列出已删除的树')
      assert.equal(gitOk(root, ['status', '--porcelain']), '', 'remove 后主树工作区必须干净')
      assert.equal(gitOk(root, ['status', '--porcelain']).includes('.agents'), false, '主树 status 不得含 .agents')
    })
  } finally {
    if (worktreeAdded === true) {
      try {
        git(root, ['worktree', 'remove', '--force', tree])
      } catch {
        // best effort
      }
    }
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

test('A0 补测：有描述数据时分支改动归入 plan.files → 主树绿；plan 外改动 → unplanned-change 红', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-a0-desc-'))
  const tree = path.join(root, '.agents', 'worktrees', 'probe-desc')
  const branch = 'probe/a0-desc'
  let worktreeAdded = false
  const target = 'lib/a0-probe.mjs'
  const other = 'lib/b0-other.mjs'
  const fileSemantics = 'A0 probe file semantics long enough'
  const otherSemantics = 'A0 other file semantics long enough'
  try {
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(root, '.gitignore'), '.agents/\n*.tmp-*\n')
    fs.writeFileSync(path.join(root, target), 'export const a0 = 1\n')
    fs.writeFileSync(path.join(root, other), 'export const b0 = 1\n')
    gitOk(root, ['init', '-q', '-b', 'main'])
    gitOk(root, ['config', 'user.email', 'a0-desc@example.invalid'])
    gitOk(root, ['config', 'user.name', 'A0 Desc Probe'])
    gitOk(root, ['add', '.gitignore', target, other])
    gitOk(root, ['commit', '-q', '-m', 'fixture: base'])

    initProject(root, { name: 'a0-desc-probe', noGates: true })
    const { contract } = loadContract(root)

    // ---- 最小 description 台账：2 个源码文件 + 文件/模块语义 ----
    const built = flowJson(root, ['desc', 'build'], 'desc build')
    assert.equal(built.result.code, 0, built.result.stderr)
    const projectSet = flowJson(root, ['desc', 'set', '--project-semantics', 'A0 描述补测项目语义'], 'desc set project')
    assert.equal(projectSet.result.code, 0, projectSet.result.stderr)
    for (const [file, moduleId, semantics] of [
      [target, 'a0-probe', fileSemantics],
      [other, 'b0-other', otherSemantics],
    ]) {
      const patch = JSON.stringify({ path: file, semantics, modules: [{ id: moduleId, semantics }] })
      const written = flowJson(root, ['desc', 'set', '--input', patch], `desc set ${file}`)
      assert.equal(written.result.code, 0, written.result.stderr)
    }
    const baseline = flowJson(root, ['check', 'description'], 'baseline check description')
    assert.equal(baseline.result.code, 0, '夹具前提：主树基线 description 必须绿：' + baseline.result.stdout)
    assert.equal(baseline.body.ok, true)

    const added = flowJson(
      root,
      ['task', 'add', '--type', 'feat', '--title', 'A0 描述补测', '--stage', 'implementing'],
      'task add',
    )
    assert.equal(added.result.code, 0, added.result.stderr)
    const taskId = added.body.data.id

    // ---- 临时 worktree：分支修改计划内文件并提交 ----
    fs.mkdirSync(path.dirname(tree), { recursive: true })
    gitOk(root, ['worktree', 'add', '-q', '-b', branch, tree, 'HEAD'])
    worktreeAdded = true
    fs.appendFileSync(path.join(tree, target), '// branch-only change\n')
    gitOk(tree, ['add', target])
    gitOk(tree, ['commit', '-q', '-m', 'fixture: branch change'])
    const branchHead = gitOk(tree, ['rev-parse', 'HEAD'])
    assert.equal(gitOk(tree, ['status', '--porcelain']), '', '夹具前提：树内干净')

    // ---- 树内建计划（base=分支 HEAD）并在树内 apply，让「planned→implemented」成立 ----
    const planInput = JSON.stringify({ files: [{ path: target, op: 'change', semantics: fileSemantics }] })
    const planned = flowJson(tree, ['desc', 'plan', taskId, '--input', planInput], 'desc plan')
    assert.equal(planned.result.code, 0, planned.result.stderr)
    const plan = planned.body?.data?.plan ?? planned.body?.data
    assert.equal(plan.base?.commit, branchHead, '计划 base.commit 必须指向分支 HEAD')
    assert.equal(plan.base?.clean, true)
    const applied = flowJson(tree, ['desc', 'apply', taskId], 'desc apply')
    assert.equal(applied.result.code, 0, applied.result.stderr)
    assert.equal(applied.body?.data?.plan?.status, 'implemented', 'apply 后计划必须 implemented（否则 check 必红 plan-unrealized）')

    // ---- 分支未合并时，主树 check --task：分支改动落在 plan.files → 绿 ----
    const green = flowJson(root, ['check', 'description', '--task', taskId], 'check description with data')
    t.diagnostic('有描述数据、未合并 check：exit=' + green.result.code + ' ok=' + String(green.body?.ok))
    assert.equal(green.result.code, 0, '有描述数据时分支改动应被 plan.files 吸收，主树 check 必须 exit 0：' + green.result.stdout.slice(0, 600))
    assert.equal(green.body.ok, true, 'check description 必须 ok=true')

    // ---- plan 外改动：必须红且给出 unplanned-change ----
    fs.appendFileSync(path.join(root, other), '// unplanned change\n')
    const red = flowJson(root, ['check', 'description', '--task', taskId], 'check description with unplanned change')
    const failedKinds = (red.body?.error?.failed ?? red.body?.data?.failed ?? []).map((item) => item.kind)
    t.diagnostic('plan 外改动 check：exit=' + red.result.code + ' kinds=' + failedKinds.join(','))
    assert.equal(red.result.code, 1, 'plan 外改动必须让 check 变红')
    assert.ok(failedKinds.includes('unplanned-change'), '必须报 unplanned-change：' + red.result.stdout.slice(0, 600))
  } finally {
    if (worktreeAdded === true) {
      try {
        git(root, ['worktree', 'remove', '--force', tree])
      } catch {
        // best effort
      }
    }
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

