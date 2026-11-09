// 台账根归一到项目主工作区（2026-11-09）：worktree 会话与 CLI 读写同一份台账。
//
// 背景：心跳早就归一主工作区，但 store 写路径仍按 cwd 解析，导致每个 worktree
// 长出一份会漂移的私账（实测 108 / 100 / 96 / 99 / 2 条任务）。这里锁定新规则：
// 只有**工作树根**会被重定向，普通子目录保持自己的作用域。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as core from '../lib/core.mjs'

const TEMP_ROOTS = []

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pf-wtroot-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

/** A committed repo with a flow ledger at its root, plus one linked worktree. */
function repoWithWorktree(label) {
  const base = tempDir(label)
  const main = path.join(base, 'main')
  fs.mkdirSync(main, { recursive: true })
  git(main, ['init', '-q', '-b', 'main'])
  git(main, ['config', 'user.email', 'test@example.com'])
  git(main, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(main, 'README.md'), 'x\n')
  git(main, ['add', '.'])
  git(main, ['commit', '-q', '-m', 'init'])
  core.initProject(main, { name: label, noGates: true })
  const checkout = path.join(base, 'wt')
  git(main, ['worktree', 'add', '-q', checkout, '-b', `branch-${label}`])
  return { base, main, checkout, label }
}

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

test('resolveProjectRoot：工作树根 → 主工作区；主工作区/普通目录保持自身', () => {
  const { main, checkout } = repoWithWorktree('resolve')
  assert.equal(core.resolveProjectRoot(checkout), fs.realpathSync(main))
  assert.equal(core.resolveProjectRoot(main), fs.realpathSync(main))
  // 普通临时目录没有 .git，不会被任何父仓库吞并
  const plain = tempDir('plain')
  assert.equal(core.resolveProjectRoot(plain), plain)
})

test('普通子目录不归一：仓库里的子目录保持自己的作用域', () => {
  const { main } = repoWithWorktree('subdir')
  const sub = path.join(main, 'packages', 'demo')
  fs.mkdirSync(sub, { recursive: true })
  assert.equal(core.resolveProjectRoot(sub), sub)
})

test('storePaths：worktree 与主工作区解析出同一组路径', () => {
  const { main, checkout } = repoWithWorktree('paths')
  const mainContract = core.loadContract(main).contract
  const wtContract = core.loadContract(checkout).contract
  const a = core.storePaths(main, mainContract)
  const b = core.storePaths(checkout, wtContract)
  assert.equal(fs.realpathSync(a.store), fs.realpathSync(b.store))
  assert.equal(fs.realpathSync(a.tasks), fs.realpathSync(b.tasks))
})

test('写路径归一：在 worktree 里 addTask 落到主工作区台账', () => {
  const { main, checkout } = repoWithWorktree('write')
  const contract = core.loadContract(checkout).contract
  core.addTask(checkout, contract, { type: 'feat', title: 'from worktree', status: 'active' })
  const mainTasks = core.listTasks(main, core.loadContract(main).contract)
  const titles = mainTasks.map((task) => task.title)
  assert.ok(titles.includes('from worktree'), `主工作区应看到 worktree 写入的任务，实际：${titles.join('|')}`)
  // worktree 目录下不应再长出第二份台账
  assert.equal(fs.existsSync(path.join(checkout, '.agents', 'tasks', 'x.json')), false)
})

test('init 归一：在 worktree 里 init 也在主工作区建台账', () => {
  const base = tempDir('initwt')
  const main = path.join(base, 'main')
  fs.mkdirSync(main, { recursive: true })
  git(main, ['init', '-q', '-b', 'main'])
  git(main, ['config', 'user.email', 'test@example.com'])
  git(main, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(main, 'a.txt'), 'x\n')
  git(main, ['add', '.'])
  git(main, ['commit', '-q', '-m', 'init'])
  const checkout = path.join(base, 'wt')
  git(main, ['worktree', 'add', '-q', checkout, '-b', 'init-wt'])

  core.initProject(checkout, { name: 'init-from-worktree', noGates: true })
  assert.equal(fs.existsSync(path.join(main, '.agents', 'flow', 'flow.json')), true, '主工作区应有契约')
  assert.equal(fs.existsSync(path.join(checkout, '.agents', 'flow', 'flow.json')), false, 'worktree 不应长出自己的台账')
})
