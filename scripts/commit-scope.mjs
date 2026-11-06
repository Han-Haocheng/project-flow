#!/usr/bin/env node
// 提交范围哨兵（T-20261106220001 / task-46）：**台账与源码不得同提交**。
//
// 为什么需要它（都是真实发生过的）：
//   - 有人误在仓库根跑了 `normalizeTaskFormat({fix:true})`，一次改写了真实台账
//     49 个文件，然后它随一笔源码提交一起进了历史；`check tasks` 对此**永远是绿的**
//     （误写后的台账恰好是它能接受的状态），所以只能靠"范围"这条独立维度拦。
//   - P3 归零那笔声称"只含 tasks/"，实际混进了 `decisions/D-20261106-01.json`。
//
// 规则（暂存区非空时）：
//   1. 若含 `.dsh/flow/` 下的文件，且同时含仓库源码/测试 → 失败（exit 1）。
//   2. 反之亦然：纯源码提交里出现 `.dsh/flow/` 数据文件 → 失败。
//
// 明确**不**拦的情况（避免误报）：
//   - 空暂存区（`git commit --allow-empty`、或只是在跑 precommit 看结果）→ 通过。
//   - `.dsh/flow/` 之外的数据/配置（如 `.dsh-ops/`，它已被 .gitignore 忽略）。
//   - `docs`/`skills` 与台账同提交：文档经常要随台账一起解释口径，本哨兵不管文档。
//   - 单类提交（只有台账，或只有源码）→ 通过。
//
// 用法：
//   node scripts/commit-scope.mjs            # 检查 git 暂存区
//   node scripts/commit-scope.mjs --list     # 同时打印分类明细（排障用）
//   node scripts/commit-scope.mjs --stdin    # 从 stdin 读文件列表（测试用，绕过 git）
//
// 退出码：0 = 范围合法；1 = 台账与源码混提；2 = 环境错误（不是 git 仓库 / git 失败）。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

/** 台账（store）路径前缀：`.dsh/flow/` 下的一切。 */
const STORE_PREFIX = '.dsh/flow/'

/**
 * 源码/测试路径：这些一旦和台账同提交，就无法用「只回退台账」或「只回退代码」的
 * 单笔 revert 止损。
 */
const CODE_PREFIXES = ['lib/', 'bin/', 'test/', '.selftest/', 'skills/', 'scripts/']
const CODE_FILES = new Set([
  'index.js',
  'client.js',
  'tasks.js',
  'tui-panel.js',
  'package.json',
  'tsconfig.json',
])

/** 判断一个仓库相对 POSIX 路径属于台账还是源码。 */
function classify(file) {
  if (file.startsWith(STORE_PREFIX)) return 'store'
  if (CODE_PREFIXES.some((prefix) => file.startsWith(prefix))) return 'code'
  if (CODE_FILES.has(file)) return 'code'
  return 'other'
}

/** 读暂存区文件名（相对仓库根、POSIX 分隔）。 */
function stagedFiles() {
  const result = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRD'], {
    encoding: 'utf8',
  })
  if (result.error) return { error: result.error.message }
  if (result.status !== 0) return { error: (result.stderr || '').trim() || `git 退出码 ${result.status}` }
  return { files: result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '') }
}

function main(argv) {
  const list = argv.includes('--list')
  const fromStdin = argv.includes('--stdin')

  let files
  if (fromStdin) {
    // 测试用：`printf 'a\nb\n' | node scripts/commit-scope.mjs --stdin`
    // `0` 是 stdin 的 fd；同步读全部，不依赖 TTY。
    let text
    try {
      text = fs.readFileSync(0, 'utf8')
    } catch (error) {
      process.stderr.write(`commit-scope: 无法读取 stdin：${error.message}\n`)
      return 2
    }
    files = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  } else {
    const outcome = stagedFiles()
    if (outcome.error !== undefined) {
      process.stderr.write(`commit-scope: 无法读取暂存区：${outcome.error}\n`)
      return 2
    }
    files = outcome.files
  }

  const store = []
  const code = []
  const other = []
  for (const file of files) {
    const kind = classify(file)
    if (kind === 'store') store.push(file)
    else if (kind === 'code') code.push(file)
    else other.push(file)
  }

  if (list) {
    const dump = (label, items) => {
      if (items.length === 0) return
      process.stdout.write(`${label}（${items.length}）：\n`)
      for (const item of items) process.stdout.write(`  ${item}\n`)
    }
    dump('台账', store)
    dump('源码/测试', code)
    dump('其它', other)
  }

  if (files.length === 0) {
    process.stdout.write('commit-scope: 暂存区为空，跳过\n')
    return 0
  }

  if (store.length > 0 && code.length > 0) {
    process.stdout.write('commit-scope: ✗ 台账与源码同提交\n')
    process.stdout.write(`  台账 ${store.length} 个，例如：${store.slice(0, 3).join(', ')}\n`)
    process.stdout.write(`  源码 ${code.length} 个，例如：${code.slice(0, 3).join(', ')}\n`)
    process.stdout.write('  请拆成两笔（台账一笔、源码一笔），否则任何一方出问题都无法单独 revert。\n')
    process.stdout.write('  只想改台账：git commit -- <paths>；只想改源码：先 git restore --staged .dsh/flow\n')
    return 1
  }

  process.stdout.write(
    `commit-scope: ✓ 范围单一（台账 ${store.length} · 源码/测试 ${code.length} · 其它 ${other.length}）\n`,
  )
  return 0
}

process.exitCode = main(process.argv.slice(2))
