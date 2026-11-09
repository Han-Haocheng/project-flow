/**
 * Local ledger snapshots and the `flow doctor` integrity report.
 *
 * Why this exists: `.agents/` is git-ignored (2026-11-08 core convention), so git
 * offers *no* protection for the ledger — a `checkout` of an older commit that
 * still tracked `.agents`, followed by `reset --hard`, deletes it wholesale
 * (this happened on 2026-11-09). The only durable safety net is a local copy,
 * which is what `createBackup` writes and `doctorReport` checks the freshness of.
 *
 * Zero dependencies: a snapshot is a plain directory copy (`fs.cpSync`), not a
 * tarball, so it needs no archiver and stays inspectable/restorable by hand.
 *
 * Design boundaries:
 * - `lib/core.mjs` never imports this module (the store must not depend on the
 *   recovery tooling); the CLI and the plugin entry do.
 * - Snapshots live in `<root>/.agents-backups/`, outside the store, so a broken
 *   store can still be replaced by a snapshot without touching the snapshot.
 * - `.agents/worktrees/` and `.agents/tmp/` are excluded from every snapshot:
 *   worktrees are separate checkouts that may contain their own `.agents` copy,
 *   which would recurse and balloon the snapshot.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Sibling of the store; must be git-ignored (see the repo's `.gitignore`). */
export const BACKUP_DIR = '.agents-backups'

/** How many snapshots `createBackup` keeps by default. */
export const DEFAULT_KEEP = 5

/** `doctorReport` warns when the newest snapshot is older than this. */
export const DEFAULT_STALE_HOURS = 24

/** Top-level store entries a snapshot never copies: separate checkouts and scratch. */
const EXCLUDED_TOP = new Set(['worktrees', 'tmp'])

/**
 * Excluded by *position inside the store*, never by substring of the absolute
 * path: a project living under `/tmp/...` must still get a full snapshot.
 */
function isExcluded(store, source) {
  const inside = relative(store, source)
  if (inside === '') return false
  const head = inside.replaceAll('\\', '/').split('/')[0]
  return EXCLUDED_TOP.has(head)
}

/** Absolute path of the snapshot directory for one project root. */
export function backupDirOf(root) {
  return join(resolve(root), BACKUP_DIR)
}

/** `YYYYMMDD-HHMMSS`, local time: sortable by name and readable in a listing. */
export function backupStamp(now = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join('-')
}

/** Count regular files below one directory; unreadable subtrees count as 0. */
export function countFiles(dir) {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name))
    else if (entry.isFile()) total += 1
  }
  return total
}

/** Recursive byte size; unreadable entries count as 0. */
function dirSize(dir) {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirSize(path)
      else if (entry.isFile()) total += statSync(path).size
    } catch {
      // vanished mid-walk
    }
  }
  return total
}

/**
 * Every snapshot, newest first.
 *
 * @param {string} root project root
 * @returns {{name:string, path:string, mtimeMs:number, files:number}[]}
 */
export function listBackups(root) {
  const dir = backupDirOf(root)
  if (existsSync(dir) === false) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (entry.isDirectory() === false) continue
    const path = join(dir, entry.name)
    try {
      rows.push({ name: entry.name, path, mtimeMs: statSync(path).mtimeMs, files: countFiles(path) })
    } catch {
      // a snapshot being removed concurrently simply disappears from the list
    }
  }
  rows.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))
  return rows
}

/** Newest snapshot, or `undefined`. */
export function latestBackup(root) {
  return listBackups(root)[0]
}

/**
 * Copy `.agents/` into a new timestamped snapshot and prune the oldest ones.
 *
 * @param {string} root project root
 * @param {{keep?:number, now?:Date}} [options]
 * @returns {{name:string, path:string, files:number, pruned:string[], bytes:number}}
 */
export function createBackup(root, options = {}) {
  const absRoot = resolve(root)
  const store = join(absRoot, '.agents')
  if (existsSync(store) === false) {
    throw new Error(`no .agents store in ${absRoot}; run: node bin/flow.mjs init`)
  }
  const input = options !== null && typeof options === 'object' ? options : {}
  const keep = Number.isInteger(input.keep) && input.keep > 0 ? input.keep : DEFAULT_KEEP
  const now = input.now instanceof Date ? input.now : new Date()
  const dir = backupDirOf(absRoot)
  mkdirSync(dir, { recursive: true })

  // One snapshot per second: a second call in the same second gets a distinct
  // name instead of silently merging into the first.
  let name = backupStamp(now)
  let target = join(dir, name)
  for (let suffix = 2; existsSync(target) === true; suffix += 1) {
    name = `${backupStamp(now)}-${suffix}`
    target = join(dir, name)
  }
  cpSync(store, target, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => isExcluded(store, source) === false,
  })

  const pruned = []
  for (const old of listBackups(absRoot).slice(keep)) {
    try {
      rmSync(old.path, { recursive: true, force: true })
      pruned.push(old.name)
    } catch {
      // a snapshot we cannot remove is reported as kept, never fatal
    }
  }
  return { name, path: target, files: countFiles(target), pruned, bytes: dirSize(target) }
}

/** `git -C <root> <args>` trimmed stdout, or `undefined` when git cannot answer. */
function gitProbe(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 4000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error !== undefined) return undefined
  // `check-ignore` uses exit 1 for "not ignored", which is an answer, not a failure.
  if (result.status !== 0) return { status: result.status, stdout: String(result.stdout ?? '').trim() }
  return { status: 0, stdout: String(result.stdout ?? '').trim() }
}

/** Parse the contract without importing core (doctor must work when core is broken). */
function readContract(root) {
  const path = join(resolve(root), '.agents', 'flow', 'flow.json')
  if (existsSync(path) === false) return { ok: false, path, message: '契约文件不存在' }
  try {
    return { ok: true, path, contract: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { ok: false, path, message: `契约 JSON 解析失败：${error.message}` }
  }
}

/**
 * One integrity report for a project's ledger.
 *
 * Levels: `ok` (usable), `warn` (works but a known risk), `error` (the ledger is
 * not in a state the plugin can use). The report never throws for a broken
 * store: a doctor that dies on the patient is useless.
 *
 * @param {string} root project root
 * @param {{staleHours?:number, now?:number}} [options]
 * @returns {{ok:boolean, root:string, findings:{id:string, level:string, message:string, hint?:string}[]}}
 */
export function doctorReport(root, options = {}) {
  const absRoot = resolve(root)
  const input = options !== null && typeof options === 'object' ? options : {}
  const staleHours = Number.isFinite(input.staleHours) && input.staleHours > 0 ? input.staleHours : DEFAULT_STALE_HOURS
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const findings = []
  const add = (id, level, message, hint) =>
    findings.push(hint === undefined ? { id, level, message } : { id, level, message, hint })

  // 1. store present
  const store = join(absRoot, '.agents')
  const storeOk = existsSync(store)
  add('store', storeOk ? 'ok' : 'error', storeOk ? '台账目录存在' : `没有台账：${store}`, storeOk ? undefined : 'node bin/flow.mjs init')

  // 2. contract parses
  const contract = readContract(absRoot)
  if (contract.ok) {
    const record = contract.contract !== null && typeof contract.contract === 'object' ? contract.contract : {}
    if (record.schema === 2) add('contract', 'ok', '契约可读（schema 2）')
    else add('contract', 'warn', `契约 schema=${String(record.schema)}，预期 2`, '检查 .agents/flow/flow.json')
  } else {
    add('contract', 'error', contract.message, 'node bin/flow.mjs init（或从备份恢复）')
  }

  // 3. record directories from the contract (fall back to the defaults)
  if (storeOk && contract.ok) {
    const record = contract.contract
    const dirs = {
      tasks: record.tasks && typeof record.tasks.dir === 'string' ? record.tasks.dir : '.agents/tasks',
      decisions: record.decisions && typeof record.decisions.dir === 'string' ? record.decisions.dir : '.agents/decisions',
      gates: record.gates && typeof record.gates.dir === 'string' ? record.gates.dir : '.agents/gates',
      description: record.description && typeof record.description.dir === 'string' ? record.description.dir : '.agents/description',
      heartbeat: record.heartbeats && typeof record.heartbeats.dir === 'string' ? record.heartbeats.dir : '.agents/heartbeat',
    }
    const missing = Object.entries(dirs)
      .filter(([, relative]) => existsSync(join(absRoot, relative)) === false)
      .map(([key]) => key)
    if (missing.length === 0) add('records', 'ok', '记录目录齐全')
    else add('records', 'warn', `缺少记录目录：${missing.join('、')}`, 'node bin/flow.mjs init 会补齐默认目录')
  }

  // 4. git state: the store must be ignored and never tracked
  const tracked = gitProbe(absRoot, ['ls-files', '--', '.agents'])
  if (tracked !== undefined) {
    const count = tracked.status === 0 && tracked.stdout !== '' ? tracked.stdout.split('\n').length : 0
    if (count > 0) {
      add('git-ignored', 'warn', `.agents 仍有 ${count} 个文件被 git 跟踪（checkout/reset 会删台账）`, 'git rm -r --cached .agents')
    } else {
      const ignored = gitProbe(absRoot, ['check-ignore', '.agents'])
      if (ignored !== undefined && ignored.status === 0) add('git-ignored', 'ok', '.agents 已被 git 忽略')
      else add('git-ignored', 'warn', '.agents 未被 .gitignore 忽略：git 操作会更危险', '把 `.agents/` 加进 .gitignore')
    }
  }

  // 5. backup freshness
  const latest = latestBackup(absRoot)
  if (latest === undefined) {
    add('backup', 'warn', '还没有台账快照', 'node bin/flow.mjs backup')
  } else {
    const ageHours = (now - latest.mtimeMs) / 3600000
    if (ageHours > staleHours) {
      add('backup', 'warn', `最近快照 ${latest.name} 已 ${ageHours.toFixed(1)} 小时`, 'node bin/flow.mjs backup')
    } else {
      add('backup', 'ok', `最近快照 ${latest.name}（${latest.files} 个文件，${ageHours.toFixed(1)} 小时前）`)
    }
  }

  return { ok: findings.every((item) => item.level !== 'error'), root: absRoot, findings }
}

/**
 * One-line mount warning when the ledger has no fresh snapshot; `undefined` when
 * there is nothing to say (or no ledger at all — an uninitialized project does
 * not need a backup reminder).
 */
export function backupHealthWarning(root, options = {}) {
  const input = options !== null && typeof options === 'object' ? options : {}
  const staleHours = Number.isFinite(input.staleHours) && input.staleHours > 0 ? input.staleHours : DEFAULT_STALE_HOURS
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  if (existsSync(join(resolve(root), '.agents')) === false) return undefined
  const latest = latestBackup(root)
  if (latest === undefined) {
    return 'project-flow: 台账还没有本地快照（.agents 已被 git 忽略）；建议先运行：node bin/flow.mjs backup'
  }
  const ageHours = (now - latest.mtimeMs) / 3600000
  if (ageHours <= staleHours) return undefined
  return `project-flow: 台账快照已 ${ageHours.toFixed(0)} 小时未更新；建议运行：node bin/flow.mjs backup`
}
