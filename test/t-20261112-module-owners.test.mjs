// owners 反查守卫（2026-11-12，语义层 ST1）：给一批文件，反查它们属于哪些模块 / 区段 / aspect。
//
// 合流时真正需要回答的问题是「这次 diff 动了谁的写域」，而不是「某个模块改这个文件越不越界」。
//   - owned   ：文件在本模块 owns（或 tests）里；
//   - shared  ：文件被别的模块 owns，但在本模块 shared + sections 里（列出可改区段）；
//   - exempt  ：unmanaged 登记（.selftest/ 探针、.github/、LICENSE 等）或非模块路径；
//   - UNKNOWN ：没有任何归属 —— 必须 exit 1，不许「空集假绿」。
//
// git 输入用临时仓库验证（--cached / --base / rename），显式列表和 stdin 不碰 git。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(REPO, 'scripts', 'module-domain.mjs')
const TEMP_DIRS = []

after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

/** 跑哨兵脚本，返回 { status, stdout, stderr }（永远不抛）。 */
function run(args, options) {
  const opts = options ?? {}
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: opts.cwd ?? REPO,
    encoding: 'utf8',
    input: opts.input,
  })
  if (result.error) return { status: -1, stdout: '', stderr: String(result.error.message) }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 建一个一次性 git 仓库：一个模块 owns a.mjs，数据文件随仓库走。 */
function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-module-owners-'))
  TEMP_DIRS.push(root)
  const dataFile = path.join(root, 'module-domain.json')
  fs.writeFileSync(
    dataFile,
    JSON.stringify(
      {
        schema: 1,
        note: 'owners 测试夹具',
        rules: [],
        modules: {
          fixture: { title: '测试模块', owns: ['a.mjs'], shared: [], sections: {}, tests: [] },
        },
        sections: {},
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(root, 'a.mjs'), 'export const a = 1\n')
  git(root, ['init', '-q'])
  git(root, ['add', 'a.mjs'])
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one'])
  return { root: root, dataFile: dataFile }
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd: cwd, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' 失败：' + (result.error?.message ?? result.stderr))
  }
  return result.stdout ?? ''
}

test('owners --files 反查四类归属，有未归属时 exit 1', () => {
  const result = run(['owners', '--files', 'lib/stage.mjs,lib/core.mjs,.gitignore,lib/new-thing.mjs'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /owned\s+lib\/stage\.mjs/)
  assert.match(result.stdout, /shared\s+lib\/core\.mjs/)
  assert.match(result.stdout, /exempt\s+\.gitignore/)
  assert.match(result.stdout, /UNKNOWN lib\/new-thing\.mjs/)
  assert.match(result.stderr, /1 个文件未归属/)
})

test('owners 全部已知时 exit 0，并给出模块汇总', () => {
  const result = run(['owners', '--files', 'lib/stage.mjs,lib/core.mjs,.gitignore'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /汇总：模块 /)
  assert.match(result.stdout, /exempt 1/)
  assert.match(result.stdout, /未归属 0/)
})

test('owners 的 shared 行列出「谁 owns + 可改哪些区段」', () => {
  const result = run(['owners', '--files', 'lib/core.mjs'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /store \(owns\)/)
  assert.match(result.stdout, /framework 可改: aggregate/)
})

test('owners 的 aspect 汇总来自 aspect.files 声明', () => {
  const result = run(['owners', '--files', 'client.js', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout).files[0]
  assert.equal(row.attribution, 'shared')
  assert.deepEqual(row.owners, ['panel'])
  assert.ok(row.sharedBy.includes('tasks'))
  assert.ok(row.aspects.includes('state-machine'), 'client.js 属于 state-machine')
  assert.ok(row.aspects.includes('liveness'), 'client.js 属于 liveness')
})

test('owners --json 形状稳定：schema / files / summary / ok', () => {
  const result = run(['owners', '--files', 'lib/stage.mjs', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.schema, 1)
  assert.equal(payload.range, null)
  assert.equal(payload.ok, true)
  assert.equal(payload.files.length, 1)
  const row = payload.files[0]
  assert.equal(row.path, 'lib/stage.mjs')
  assert.equal(row.attribution, 'owned')
  assert.deepEqual(row.owners, ['tasks'])
  assert.ok(row.aspects.includes('state-machine'), 'lib/stage.mjs 属于 state-machine')
  assert.ok(payload.summary.modules.tasks >= 1)
  assert.equal(payload.summary.aspects['state-machine'], 1)
  assert.equal(payload.summary.unknown, 0)
})

test('owners --json：shared 文件带 owners / sharedBy / sections', () => {
  const result = run(['owners', '--files', 'lib/core.mjs', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const row = JSON.parse(result.stdout).files[0]
  assert.equal(row.attribution, 'shared')
  assert.deepEqual(row.owners, ['store'])
  assert.ok(row.sharedBy.includes('framework'))
  const framework = row.sections.find((section) => section.module === 'framework')
  assert.ok(framework !== undefined, 'framework 应在 sections 里出现')
  assert.deepEqual(framework.keys, ['aggregate'])
})

test('owners --stdin 与 --files 等价', () => {
  const result = run(['owners', '--stdin'], { input: 'lib/stage.mjs\nlib/core.mjs\n' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /owned\s+lib\/stage\.mjs/)
  assert.match(result.stdout, /shared\s+lib\/core\.mjs/)
})

test('已删除文件（磁盘上不存在）仍按 owns 前缀反查归属', () => {
  const result = run(['owners', '--files', 'lib/tasks/gone.mjs,lib/core.mjs', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.files[0].attribution, 'owned')
  assert.deepEqual(payload.files[0].owners, ['tasks'])
})

test('owners --cached 反查暂存区改动', () => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo.root, 'a.mjs'), 'export const a = 2\n')
  git(repo.root, ['add', 'a.mjs'])
  const result = run(['owners', '--root', repo.root, '--data', repo.dataFile, '--cached', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.range, '--cached')
  assert.equal(payload.files.length, 1)
  assert.equal(payload.files[0].path, 'a.mjs')
  assert.equal(payload.files[0].status, 'M')
  assert.equal(payload.files[0].attribution, 'owned')
})

test('owners --cached 对 rename 只报新文件名', () => {
  const repo = tempRepo()
  git(repo.root, ['mv', 'a.mjs', 'b.mjs'])
  const result = run(['owners', '--root', repo.root, '--data', repo.dataFile, '--cached', '--json'])
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.files.length, 1)
  assert.equal(payload.files[0].path, 'b.mjs')
  assert.equal(payload.files[0].status, 'R')
})

test('owners --diff 默认使用 HEAD~1...HEAD 并打印实际范围', () => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo.root, 'a.mjs'), 'export const a = 3\n')
  git(repo.root, ['add', 'a.mjs'])
  git(repo.root, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'two'])
  const result = run(['owners', '--root', repo.root, '--data', repo.dataFile, '--diff'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /变更范围：HEAD~1\.\.\.HEAD/)
  assert.match(result.stdout, /owned\s+a\.mjs/)
})

test('owners 没有输入时是用法错误（exit 2），不静默返回空集', () => {
  const result = run(['owners'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /owners 需要/)
})
