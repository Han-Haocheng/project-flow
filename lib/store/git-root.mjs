// project-flow — git 探测与项目根归一（store 模块，2026-11-11 Phase 1）。
//
// 为什么独立成文件：`loadContract` / `storePaths`（契约层）与心跳台账都要问
// 「这个目录属于哪个项目的台账」。归一规则只有一份，放在这里，两边都 import，
// 避免契约层与心跳层各写一套 git 探测。
//
// 规则（与 CONTRACT §3.1 "台账根 = 项目主工作区" 一致）：
// - 没有 `.git` 的目录就是它自己（不为普通目录 spawn git）；
// - 只有**工作树根**会被重定向到 `git worktree list` 的第一条；
// - git 答不出来就原样返回。

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const GIT_PROBE_TIMEOUT_MS = 4000
const GIT_PROBE_MAX_BUFFER = 4 * 1024 * 1024

export function gitProbe(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: GIT_PROBE_TIMEOUT_MS,
    maxBuffer: GIT_PROBE_MAX_BUFFER,
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) return undefined
  return typeof result.stdout === 'string' ? result.stdout.trim() : undefined
}

export function gitMainWorktree(dir) {
  // `worktree list --porcelain` prints the main worktree first, with an absolute path.
  const listed = gitProbe(dir, ['worktree', 'list', '--porcelain'])
  if (listed !== undefined) {
    for (const line of listed.split('\n')) {
      if (line.startsWith('worktree ') === false) continue
      const candidate = line.slice('worktree '.length).trim()
      if (candidate !== '') return resolve(candidate)
    }
  }
  // Fallback: the common dir is `<main>/.git` even from a linked worktree.
  const commonDir = gitProbe(dir, ['rev-parse', '--git-common-dir'])
  if (commonDir !== undefined && commonDir !== '') return dirname(resolve(dir, commonDir))
  return undefined
}

const PROJECT_ROOT_CACHE = new Map()

export function resolveProjectRoot(root) {
  const absRoot = resolve(root)
  const cached = PROJECT_ROOT_CACHE.get(absRoot)
  if (cached !== undefined) return cached
  let result = absRoot
  try {
    if (existsSync(join(absRoot, '.git'))) {
      const top = gitProbe(absRoot, ['rev-parse', '--show-toplevel'])
      if (top !== undefined && top !== '' && resolve(absRoot, top) === absRoot) {
        const main = gitMainWorktree(absRoot)
        if (main !== undefined && main !== '') result = main
      }
    }
  } catch {
    result = absRoot
  }
  PROJECT_ROOT_CACHE.set(absRoot, result)
  return result
}
