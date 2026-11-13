// 台账快照与体检（2026-11-09）：.agents 被 git 忽略后，git 不再提供任何保护，
// 本地快照是唯一恢复源；doctor 把“能不能用/有没有风险”变成可执行报告。
import { test, after } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initProject, loadContract } from '../lib/core.mjs'
import { beginIntent } from '../lib/tasks/intents.mjs'
import { BACKUP_DIR, backupHealthWarning, createBackup, doctorReport, listBackups } from '../lib/backup.mjs'

const TEMP_ROOTS = []
const BIN = new URL('../bin/flow.mjs', import.meta.url).pathname

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-backup-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `backup-${label}`, noGates: true })
  return root
}

after(() => {
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

test('createBackup：复制 .agents 到 .agents-backups/<stamp>，并报告文件与字节', () => {
  const root = freshProject('create')
  const result = createBackup(root, { now: new Date(2026, 10, 9, 10, 0, 0) })
  assert.equal(result.name, '20261109-100000')
  assert.ok(result.files > 0)
  assert.ok(result.bytes > 0)
  assert.ok(fs.existsSync(path.join(result.path, 'flow', 'flow.json')))
  assert.ok(fs.existsSync(path.join(root, BACKUP_DIR, result.name)))
})

test('createBackup：跳过 worktrees 与 tmp，避免递归与临时垃圾', () => {
  const root = freshProject('exclude')
  fs.mkdirSync(path.join(root, '.agents', 'worktrees', 'wt1', '.agents'), { recursive: true })
  fs.writeFileSync(path.join(root, '.agents', 'worktrees', 'wt1', '.agents', 'marker.txt'), 'x')
  fs.mkdirSync(path.join(root, '.agents', 'tmp'), { recursive: true })
  fs.writeFileSync(path.join(root, '.agents', 'tmp', 'scratch.log'), 'x')
  const result = createBackup(root, { now: new Date(2026, 10, 9, 10, 1, 0) })
  assert.equal(fs.existsSync(path.join(result.path, 'worktrees')), false)
  assert.equal(fs.existsSync(path.join(result.path, 'tmp')), false)
  assert.ok(fs.existsSync(path.join(result.path, 'flow', 'flow.json')))
})

test('createBackup：--keep 剪枝最旧快照，保留 N 份', () => {
  const root = freshProject('prune')
  const names = []
  for (let index = 0; index < 4; index += 1) {
    const result = createBackup(root, { keep: 2, now: new Date(2026, 10, 9, 10, 2, index) })
    names.push(result.name)
  }
  const kept = listBackups(root).map((row) => row.name)
  assert.equal(kept.length, 2)
  assert.deepEqual(kept.sort(), names.slice(-2).sort())
})

test('createBackup：无台账时报错而不是写空快照', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-backup-empty-'))
  TEMP_ROOTS.push(root)
  assert.throws(() => createBackup(root), /no \.agents store/)
})

test('doctorReport：健康台账只有 ok（快照新鲜时）', () => {
  const root = freshProject('healthy')
  createBackup(root, { now: new Date() })
  const report = doctorReport(root, { now: Date.now() })
  const levels = report.findings.map((item) => item.level)
  assert.equal(report.ok, true)
  assert.equal(levels.includes('error'), false)
  assert.equal(report.findings.find((item) => item.id === 'backup').level, 'ok')
})

test('doctorReport：契约坏掉时报 error 并给出修复提示', () => {
  const root = freshProject('broken')
  fs.writeFileSync(path.join(root, '.agents', 'flow', 'flow.json'), '{ not json')
  const report = doctorReport(root)
  const contract = report.findings.find((item) => item.id === 'contract')
  assert.equal(report.ok, false)
  assert.equal(contract.level, 'error')
  assert.match(contract.hint, /flow\.mjs init/)
})

test('doctorReport：没有快照时报 warn 并指向 flow backup', () => {
  const root = freshProject('nobackup')
  const report = doctorReport(root)
  const backup = report.findings.find((item) => item.id === 'backup')
  assert.equal(backup.level, 'warn')
  assert.match(backup.hint, /flow\.mjs backup/)
})

test('doctorReport：快照过期（默认 24h）报 warn', () => {
  const root = freshProject('stale')
  const created = createBackup(root)
  // 快照的新鲜度看目录 mtime（真实写盘时间），不能靠伪造 now：把 mtime 拨回 48h 前。
  const old = new Date(Date.now() - 48 * 3600 * 1000)
  fs.utimesSync(created.path, old, old)
  const report = doctorReport(root)
  assert.equal(report.findings.find((item) => item.id === 'backup').level, 'warn')
  // 放宽阈值后同一份快照可以判 ok
  const relaxed = doctorReport(root, { staleHours: 72 })
  assert.equal(relaxed.findings.find((item) => item.id === 'backup').level, 'ok')
})

test('backupHealthWarning：无台账静默；无快照/过期给出可执行提示；新鲜时静默', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-backup-none-'))
  TEMP_ROOTS.push(empty)
  assert.equal(backupHealthWarning(empty), undefined)

  const root = freshProject('warn')
  const missing = backupHealthWarning(root)
  assert.match(missing, /flow\.mjs backup/)

  createBackup(root)
  assert.equal(backupHealthWarning(root), undefined)

  const stale = backupHealthWarning(root, { now: Date.now() + 48 * 3600 * 1000 })
  assert.match(stale, /小时未更新/)
})

test('CLI：backup --keep 与 doctor --stale-hours 是已声明 flag（VALUE_FLAGS 回归）', () => {
  const root = freshProject('cli-value-flags')
  createBackup(root, { now: new Date(2026, 10, 9, 10, 0, 0) })
  assert.equal(listBackups(root).length, 1)

  const backup = spawnSync(process.execPath, [BIN, '--root', root, 'backup', '--keep', '1', '--json'], {
    encoding: 'utf8',
  })
  assert.equal(backup.status, 0, `backup --keep 1 必须被识别：${backup.stderr}`)
  const parsed = JSON.parse(backup.stdout)
  assert.equal(parsed.ok, true)
  // 先有 1 份，CLI 再拍 1 份，--keep 1 只保留最新的一份。
  assert.equal(listBackups(root).length, 1, '--keep 1 必须把旧快照清到只剩 1 份')

  const doctor = spawnSync(process.execPath, [BIN, '--root', root, 'doctor', '--stale-hours', '1', '--json'], {
    encoding: 'utf8',
  })
  assert.equal(doctor.status, 0, `doctor --stale-hours 必须被识别：${doctor.stderr}`)
  assert.equal(JSON.parse(doctor.stdout).ok, true)
})

test('flow doctor：健康聚合常驻——未完成 intent 以 warn 出现，且原有 5 条 finding 仍在', () => {
  const root = freshProject('doctor-health')
  createBackup(root, { now: new Date() })
  const { contract } = loadContract(root)
  beginIntent(root, contract, { kind: 'probe', steps: ['step-a'] })
  const doctor = spawnSync(process.execPath, [BIN, '--root', root, 'doctor', '--json'], { encoding: 'utf8' })
  assert.equal(doctor.status, 0, doctor.stderr)
  const data = JSON.parse(doctor.stdout).data
  const ids = data.findings.map((item) => item.id)
  for (const id of ['store', 'contract', 'records', 'git-ignored', 'backup', 'intents']) {
    assert.ok(ids.includes(id), '缺少 finding ' + id)
  }
  const intents = data.findings.find((item) => item.id === 'intents')
  assert.equal(intents.level, 'warn')
  assert.match(intents.message, /1 条未完成动作/)
  assert.equal(typeof data.ok, 'boolean')
})

test('flow doctor：未完成 intent 超过 10 条时提示「数量偏多」', () => {
  const root = freshProject('doctor-health-many')
  createBackup(root, { now: new Date() })
  const { contract } = loadContract(root)
  for (let index = 0; index < 11; index += 1) {
    beginIntent(root, contract, { kind: 'probe', target: { probe: index }, steps: ['step-' + index] })
  }
  const doctor = spawnSync(process.execPath, [BIN, '--root', root, 'doctor', '--json'], { encoding: 'utf8' })
  assert.equal(doctor.status, 0, doctor.stderr)
  const data = JSON.parse(doctor.stdout).data
  const intents = data.findings.find((item) => item.id === 'intents')
  assert.equal(intents.level, 'warn')
  assert.match(intents.message, /11 条未完成动作/)
  assert.match(intents.message, /数量偏多，考虑排查/)
})
