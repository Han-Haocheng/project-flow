// T-20261105224822 · B 分片：`flow task normalize`（旧任务格式归一的唯一写盘通道）。
//
// 覆盖任务书 §5 的 B1–B9。写盘实验一律在 os.tmpdir() 下的一次性项目里跑，
// `--root` 显式传绝对路径（不依赖 cwd），真实仓库只在末尾跑一次 `--dry-run`。
//
// 退出码口径（lead 授权「不明确就用约定」）：`task` 族不是 `check` 族，
// 用法错误沿既有 EXIT_BY_CODE（usage→1），写盘成功与 --dry-run 都退 0。
// 这与 `task bogus` / `task add --goal` 等既有行为一致。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const BIN = path.join(REPO, 'bin', 'flow.mjs')
const CORE = path.join(REPO, 'lib', 'core.mjs')

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

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-task-normalize-${label}-`))
  TEMP_ROOTS.push(root)
  const code = `
    const { initProject } = await import(${JSON.stringify(CORE)})
    initProject(process.argv[1], { name: 'acc', noGates: true })
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, root], { encoding: 'utf8' })
  assert.equal(result.status, 0, `initProject 失败：${result.stderr || result.stdout}`)
  fs.mkdirSync(path.join(root, '.dsh', 'flow', 'tasks'), { recursive: true })
  return root
}

function writeTask(root, id, body) {
  const record = {
    id,
    status: 'draft',
    created_at: '2026-01-01T00:00:00+08:00',
    updated_at: '2026-01-02T09:00:00+08:00',
    schema: 1,
    ...body,
  }
  fs.writeFileSync(path.join(root, '.dsh', 'flow', 'tasks', `${id}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

function readTask(root, id) {
  return JSON.parse(fs.readFileSync(path.join(root, '.dsh', 'flow', 'tasks', `${id}.json`), 'utf8'))
}

/** 任务书 §5 公共前置的两条记录。 */
function seedLegacyPair(root) {
  writeTask(root, 'T-20260101-01', { title: '旧标题', goal: '旧目标' })
  writeTask(root, 'T-20260101-02', { title: '有类型', goal: '', type: 'fix', status: 'done' })
}

/** `.dsh/flow` 全量 sha256 + size + mtime 快照：证明零写盘 / 幂等的唯一手段。 */
function snapshotStore(root) {
  const base = path.join(root, '.dsh', 'flow')
  const rows = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const stat = fs.statSync(full)
        rows.push(`${path.relative(base, full)} ${createHash('sha256').update(fs.readFileSync(full)).digest('hex')} ${stat.size} ${stat.mtimeMs}`)
      }
    }
  }
  walk(base)
  rows.push(`locks:${fs.readdirSync(base).filter((name) => name.endsWith('.lock')).join(',')}`)
  return rows.join('\n')
}

function writeJson(root, name, value) {
  const file = path.join(root, name)
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

function runCli(root, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: process.env })
  let json = null
  if (args.includes('--json')) {
    const text = result.stdout.trim()
    assert.ok(text !== '', `期望 JSON 输出，实际为空。stderr: ${result.stderr}`)
    json = JSON.parse(text)
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

// -------------------------------------------------------------------- B1

test('B1：--dry-run 零写盘（bytes+size+mtime 全等）且 exit 0', () => {
  const root = freshProject('b1')
  seedLegacyPair(root)
  const before = snapshotStore(root)
  const result = runCli(root, ['--root', root, 'task', 'normalize', '--dry-run'])
  assert.equal(result.code, 0, '--dry-run 是报告不是门禁，恒 0')
  assert.equal(snapshotStore(root), before, '--dry-run 不得改写任何字节/mtime，也不得留 .lock')
  assert.match(result.stdout, /--dry-run：未写盘/)
  // 逐条列出将要做的变更（不是只给总数）。
  assert.match(result.stdout, /T-20260101-01/)
  assert.match(result.stdout, /旧标题.*→.*旧标题 — 旧目标/)
})

// -------------------------------------------------------------------- B2

test('B2：不给 map 真跑 → goal 合并/删除成功，missing-type 残留，data.ok=false，exit 0', () => {
  const root = freshProject('b2')
  seedLegacyPair(root)
  const result = runCli(root, ['--root', root, 'task', 'normalize', '--json'])
  assert.equal(result.code, 0, '写盘跑完即 0，残留用 data.ok:false 表达（gate run 同一哲学）')
  assert.deepEqual([...result.json.data.fixed].sort(), ['T-20260101-01', 'T-20260101-02'])
  assert.equal(result.json.data.ok, false, 'T-01 仍缺 type → 未归零')
  assert.equal(result.json.data.fix, true)
  assert.equal(result.json.data.dryRun, false)
  const first = readTask(root, 'T-20260101-01')
  assert.equal(Object.hasOwn(first, 'goal'), false, 'goal 键已删除')
  assert.equal(first.title, '旧标题 — 旧目标')
  assert.equal(Object.hasOwn(first, 'type'), false, '没有 map 时绝不猜 type')
  assert.equal(Object.hasOwn(readTask(root, 'T-20260101-02'), 'goal'), false)
})

// -------------------------------------------------------------------- B3

test('B3：补 type 不刷新 updated_at（格式归一不是编辑）', () => {
  const root = freshProject('b3')
  seedLegacyPair(root)
  const mapFile = writeJson(root, 'map.json', { 'T-20260101-01': 'feat' })
  runCli(root, ['--root', root, 'task', 'normalize', '--type-map', mapFile])
  const record = readTask(root, 'T-20260101-01')
  assert.equal(record.updated_at, '2026-01-02T09:00:00+08:00', 'updated_at 必须原样保留')
  assert.equal(record.type, 'feat')
  assert.equal(record.title, '旧标题 — 旧目标')
})

// -------------------------------------------------------------------- B4

test('B4：已有 type 不被 map 穿透（规则 3）', () => {
  const root = freshProject('b4')
  seedLegacyPair(root)
  const mapFile = writeJson(root, 'map.json', { 'T-20260101-01': 'feat', 'T-20260101-02': 'feat' })
  const result = runCli(root, ['--root', root, 'task', 'normalize', '--type-map', mapFile, '--json'])
  assert.equal(readTask(root, 'T-20260101-02').type, 'fix', 'record.type 仍是 fix，不被 map 的 feat 覆盖')
  // D6：map 里对已有 type 且不同值的 key → advisory warning，不阻断。
  assert.ok(
    result.json.warnings.some((w) => /type-map-unused: T-20260101-02/.test(w)),
    `应有一条 type-map-unused warning：${JSON.stringify(result.json.warnings)}`,
  )
  assert.equal(result.code, 0, 'advisory warning 不阻断')
})

// -------------------------------------------------------------------- B5

test('B5：幂等——第二遍写 0 字节，data.fixed 为空', () => {
  const root = freshProject('b5')
  seedLegacyPair(root)
  const mapFile = writeJson(root, 'map.json', { 'T-20260101-01': 'feat', 'T-20260101-02': 'fix' })
  runCli(root, ['--root', root, 'task', 'normalize', '--type-map', mapFile])
  const before = snapshotStore(root)
  const again = runCli(root, ['--root', root, 'task', 'normalize', '--type-map', mapFile, '--json'])
  assert.deepEqual(again.json.data.fixed, [], '第二遍无待迁移项')
  assert.equal(again.json.data.ok, true)
  assert.equal(snapshotStore(root), before, '第二遍必须写 0 字节')
})

// -------------------------------------------------------------------- B6

test('B6：全量 map 归一后 data.ok=true，再 check tasks → exit 0', () => {
  const root = freshProject('b6')
  seedLegacyPair(root)
  const mapFile = writeJson(root, 'map.json', { 'T-20260101-01': 'feat', 'T-20260101-02': 'fix' })
  const run = runCli(root, ['--root', root, 'task', 'normalize', '--type-map', mapFile, '--json'])
  assert.equal(run.json.data.ok, true)
  assert.deepEqual(run.json.data.remaining, { 'legacy-goal': 0, 'missing-type': 0 })
  const check = runCli(root, ['--root', root, 'check', 'tasks'])
  assert.equal(check.code, 0, '台账真归一后门禁必须转绿')
  assert.ok(check.stdout.includes('✓ tasks：legacy-goal 0 · missing-type 0'), check.stdout)
})

// -------------------------------------------------------------------- B7

test('B7：type:null 记录无 map 时整条不写（不丢 goal），有 map 时一次跑通', () => {
  const root = freshProject('b7')
  writeTask(root, 'T-20260101-03', { title: '丙', goal: '丁', type: null })
  const before = snapshotStore(root)
  const bare = runCli(root, ['--root', root, 'task', 'normalize', '--json'])
  assert.equal(snapshotStore(root), before, 'type:null 且缺 map → 整条跳过，bytes+mtime 不变')
  assert.deepEqual(bare.json.data.fixed, [])
  const untouched = readTask(root, 'T-20260101-03')
  assert.equal(Object.hasOwn(untouched, 'goal'), true, 'goal 不得丢')
  assert.equal(untouched.type, null)
  assert.ok(
    bare.json.warnings.some((w) => /task-normalize-skipped: T-20260101-03/.test(w)),
    `应有一条 task-normalize-skipped：${JSON.stringify(bare.json.warnings)}`,
  )

  const mapFile = writeJson(root, 'map7.json', { 'T-20260101-03': 'feat' })
  const run = runCli(root, ['--root', root, 'task', 'normalize', '--type-map', mapFile, '--json'])
  assert.deepEqual(run.json.data.fixed, ['T-20260101-03'])
  const after = readTask(root, 'T-20260101-03')
  assert.equal(after.title, '丙 — 丁')
  assert.equal(after.type, 'feat')
  assert.equal(Object.hasOwn(after, 'goal'), false)
})

// -------------------------------------------------------------------- B8

test('B8：坏 JSON 记录不阻断、不静默（warnings 含 unreadable，fixed 不含它）', () => {
  const root = freshProject('b8')
  seedLegacyPair(root)
  fs.writeFileSync(path.join(root, '.dsh', 'flow', 'tasks', 'broken.json'), '{ bad')
  const result = runCli(root, ['--root', root, 'task', 'normalize', '--json'])
  assert.equal(result.code, 0, '一条坏记录不得卡住整个迁移')
  assert.ok(
    result.json.warnings.some((w) => w.startsWith('unreadable:')),
    `warnings 应含 unreadable:：${JSON.stringify(result.json.warnings)}`,
  )
  assert.equal(result.json.data.fixed.includes('broken'), false)
  assert.deepEqual([...result.json.data.fixed].sort(), ['T-20260101-01', 'T-20260101-02'], '其余记录照常迁移')
})

// -------------------------------------------------------------------- B9

test('B9：--type-map 非法值退 2（task 族用法错误口径）且不写盘', () => {
  const root = freshProject('b9')
  seedLegacyPair(root)
  const bad = writeJson(root, 'bad.json', { 'T-20260101-01': 'revert' })
  const before = snapshotStore(root)
  const result = runCli(root, ['--root', root, 'task', 'normalize', '--type-map', bad, '--json'])
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'usage')
  assert.match(result.json.error.message, /不是合法 type/)
  assert.match(result.json.error.message, /revert/)
  assert.equal(snapshotStore(root), before, 'map 校验早于 core，坏 map 不得写盘')
  // 坏形态集合与 check tasks 共用同一个 loadTypeMap（行为一致）。
  for (const [arg, pattern] of [
    [path.join(root, 'nope.json'), /文件不存在/],
    ['', /需要一个文件路径/],
  ]) {
    const run = runCli(root, ['--root', root, 'task', 'normalize', '--type-map', arg, '--json'])
    assert.equal(run.json.error.code, 'usage')
    assert.match(run.json.error.message, pattern)
  }
  assert.equal(snapshotStore(root), before)
})

// ------------------------------------------------------- 长标题 / 未初始化

test('合并后 title 超宽时 --dry-run 标出待复查条目', () => {
  const root = freshProject('long')
  // 40 个汉字 = 80 列；goal 再叠 60 个汉字，合并后 title 远超 120 列。
  const long = '很长的目标'.repeat(12)
  writeTask(root, 'T-20260101-09', { title: '短标题', goal: long })
  const result = runCli(root, ['--root', root, 'task', 'normalize', '--dry-run'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /合并后 title 超过 120 列 1 条/, result.stdout)
  assert.match(result.stdout, /T-20260101-09/)
  // 报告带 id，--json 回带同一份清单。
  const json = runCli(root, ['--root', root, 'task', 'normalize', '--dry-run', '--json'])
  assert.deepEqual(json.json.data.longTitles, ['T-20260101-09'])
})

test('空台账 --dry-run 明确说没有待迁移项；未初始化是用法错误', () => {
  const root = freshProject('empty')
  const result = runCli(root, ['--root', root, 'task', 'normalize', '--dry-run'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /没有待迁移的旧记录/)

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-task-normalize-uninit-'))
  TEMP_ROOTS.push(bare)
  const failed = runCli(bare, ['--root', bare, 'task', 'normalize', '--json'])
  assert.notEqual(failed.code, 0, '未初始化必须报错，且不得静默成功')
  assert.equal(failed.json.ok, false)
  assert.equal(fs.existsSync(path.join(bare, '.dsh')), false, '失败路径不得创建 store')
})

test('真实台账体检：--dry-run 报告可读且 .dsh/flow 零改动（环境不满足则 skip）', (t) => {
  // 环境耦合三连 guard（brief-test-env-coupling §3.3）：台账目录存在 → 非空 → 在 git 工作树内。
  // 不满足就 skip 并说明，**不要**断言具体条数——P3 归零后 49/42 会变成 0/0，硬编码即假红。
  const tasksDir = path.join(REPO, '.dsh', 'flow', 'tasks')
  if (fs.existsSync(tasksDir) === false) return t.skip('需要仓库真实台账（.dsh/flow/tasks 不存在）')
  const records = fs.readdirSync(tasksDir).filter((name) => name.endsWith('.json'))
  if (records.length === 0) return t.skip('需要仓库真实台账（tasks 目录为空）')
  const inTree = spawnSync('git', ['-C', REPO, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
  if (inTree.status !== 0) return t.skip('需要 git 工作树（零写盘指纹依赖 git）')
  // 零写盘用 size+mtime 指纹（不用 `git status`：非 git 目录里 git 退 128、stdout 空串，
  // assert.equal 既会假红也会假通过——brief-test-env-coupling §3.3）。
  const fingerprint = () => {
    const out = []
    for (const name of fs.readdirSync(tasksDir).sort()) {
      if (name.endsWith('.json') === false) continue
      const st = fs.statSync(path.join(tasksDir, name))
      out.push(`${name}:${st.size}:${st.mtimeMs}`)
    }
    return out.join('\n')
  }
  const before = fingerprint()
  const result = runCli(REPO, ['--root', REPO, 'task', 'normalize', '--dry-run'])
  assert.equal(result.code, 0)
  // 两种合法形态：有待迁移项 → 明说未写盘；已归零 → 明说没有待迁移项。二者都不得写盘。
  assert.ok(
    /--dry-run：未写盘/.test(result.stdout) || /没有待迁移的旧记录/.test(result.stdout),
    `--dry-run 报告形态异常：${result.stdout.slice(0, 200)}`
  )
  assert.equal(fingerprint(), before, '真实台账 --dry-run 不得改动 .dsh/flow/tasks（size+mtime）')
})
