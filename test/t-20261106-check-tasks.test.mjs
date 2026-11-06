// T-20261105224822 · A 分片：`flow check tasks` 内置检查（全只读）的验收测试。
//
// 覆盖任务书 §5 的 A1–A10。全部在 os.tmpdir() 下的一次性项目里跑（`--root` 显式传参，
// 绝不依赖 cwd），真实台账只在 A5/A8 的「只读复核」里跑一次、只读不写。
//
// A5 的规格经 lead 裁决（2026-11-06）：`check tasks` 只读，所以**带合法 map 时
// `missing-type` 仍然是 issue**（map 只改变 suggestion 文案与 typeMap 回带），
// 归零必须由 `flow task normalize` 真写盘达成。这是防假绿的核心断言。

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

/** 初始化一个临时 flow 项目（不播种门禁），返回根目录。 */
function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-check-tasks-${label}-`))
  TEMP_ROOTS.push(root)
  const code = `
    const { initProject } = await import(${JSON.stringify(CORE)})
    initProject(process.argv[1], { name: 'acc', noGates: true })
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, root], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `initProject 失败：${result.stderr || result.stdout}`)
  fs.mkdirSync(path.join(root, '.dsh', 'flow', 'tasks'), { recursive: true })
  return root
}

/** 写一条旧格式任务记录（`goal` 键 + 可选缺 `type`）。 */
function writeTask(root, id, body) {
  const record = {
    id,
    status: 'draft',
    created_at: '2026-01-01T00:00:00+08:00',
    updated_at: '2026-01-02T09:00:00+08:00',
    schema: 1,
    ...body,
  }
  fs.writeFileSync(
    path.join(root, '.dsh', 'flow', 'tasks', `${id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  )
}

/** 任务书 §5 公共前置的两条记录：T-01 有 goal+缺 type，T-02 有 goal 且有 type。 */
function seedLegacyPair(root) {
  writeTask(root, 'T-20260101-01', { title: '旧标题', goal: '旧目标' })
  writeTask(root, 'T-20260101-02', { title: '有类型', goal: '', type: 'fix', status: 'done' })
}

/** `.dsh/flow` 全量字节 + 大小 + mtime 快照（只读，唯一能证明零写盘的手段）。 */
function snapshotStore(root) {
  const base = path.join(root, '.dsh', 'flow')
  const rows = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(full)
        const stat = fs.statSync(full)
        rows.push(`${path.relative(base, full)} ${createHash('sha256').update(bytes).digest('hex')} ${stat.size} ${stat.mtimeMs}`)
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

/** 跑 CLI；`--json` 时解析 stdout。cwd 恒为临时 root。 */
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
    json = JSON.parse(text)
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

// -------------------------------------------------------------------- A1

test('A1：check tasks 只读零写盘（bytes+size+mtime 全等、无 .lock）', () => {
  const root = freshProject('a1')
  seedLegacyPair(root)
  const before = snapshotStore(root)
  const result = runCli(root, ['--root', root, 'check', 'tasks'])
  assert.equal(result.code, 1)
  const after = snapshotStore(root)
  assert.equal(after, before, '只读检查不得改写任何字节/mtime，也不得留下 .lock')
  assert.doesNotMatch(after, /locks:.+/)
})

// -------------------------------------------------------------------- A2

test('A2：有 issue → exit 1、code=check-failed、counts 正确', () => {
  const root = freshProject('a2')
  seedLegacyPair(root)
  const result = runCli(root, ['--root', root, 'check', 'tasks', '--json'])
  assert.equal(result.code, 1)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'check-failed')
  assert.deepEqual(result.json.error.counts, { 'legacy-goal': 2, 'missing-type': 1 })
  assert.equal(result.json.error.exitCode, 1)
  assert.deepEqual(
    result.json.error.issues.map((item) => item.kind),
    ['legacy-goal', 'missing-type', 'legacy-goal'],
    '按文件的读入顺序，不排序',
  )
  // issues[] 逐字取 core 结构，不加工、不裁剪。
  for (const item of result.json.error.issues) {
    assert.deepEqual(Object.keys(item).sort(), ['goal', 'id', 'kind', 'suggestion', 'title'])
  }
})

// -------------------------------------------------------------------- A3

test('A3：人类输出逐条 ✗ + 合计行 + 可复制提示', () => {
  const root = freshProject('a3')
  seedLegacyPair(root)
  const result = runCli(root, ['--root', root, 'check', 'tasks'])
  assert.equal(result.code, 1)
  assert.ok(
    result.stdout.includes('✗ T-20260101-01 [legacy-goal] title = "旧标题 — 旧目标"'),
    `缺少逐条行：\n${result.stdout}`,
  )
  assert.ok(result.stdout.includes('✗ T-20260101-02 [legacy-goal] drop the legacy goal key'))
  assert.ok(result.stdout.includes('合计 3 条：legacy-goal 2 · missing-type 1'), result.stdout)
  assert.ok(result.stdout.includes('flow task normalize --type-map'), result.stdout)
  // silent=true：失败时不再补一条「错误（check-failed）…」。
  assert.doesNotMatch(result.stderr, /错误（check-failed）/)
})

// -------------------------------------------------------------------- A4

test('A4：--json 信封键集精确（不多不少）', () => {
  const root = freshProject('a4')
  seedLegacyPair(root)
  const result = runCli(root, ['--root', root, 'check', 'tasks', '--json'])
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'ok', 'warnings'])
  assert.deepEqual(
    Object.keys(result.json.error).sort(),
    ['check', 'code', 'counts', 'durationMs', 'exitCode', 'issues', 'message', 'ok', 'stderr', 'stdout', 'typeMap'],
  )
  assert.deepEqual(Object.keys(result.json.error.counts).sort(), ['legacy-goal', 'missing-type'])
  assert.deepEqual(Object.keys(result.json.error.issues[0]).sort(), ['goal', 'id', 'kind', 'suggestion', 'title'])
  assert.equal(result.json.error.typeMap, null)
  assert.equal(result.json.error.check, 'tasks')
  assert.equal(result.json.error.message, '检查未通过：tasks（旧任务记录未归一）')
  assert.ok(Array.isArray(result.json.warnings))
})

// -------------------------------------------------------------------- A5
// lead 裁决（2026-11-06）：check tasks 只读 ⇒ 带合法 map 时 missing-type 仍是 issue，
// 只有 suggestion 变化 + typeMap 回带。这是防「门禁在台账没修好时骗自己绿」。

test('A5：合法 map 只改 suggestion / 回带 typeMap，不消 missing-type，且零写盘', () => {
  const root = freshProject('a5')
  seedLegacyPair(root)
  const mapFile = writeJson(root, 'map.json', { 'T-20260101-01': 'feat' })
  const before = snapshotStore(root)

  const result = runCli(root, ['--root', root, 'check', 'tasks', '--type-map', mapFile, '--json'])
  assert.equal(result.code, 1, '台账没写盘就仍是红')
  assert.equal(result.json.ok, false)
  // ① 计数不因 map 而减少：T-01 仍缺 type（盘上真相）。
  assert.deepEqual(result.json.error.counts, { 'legacy-goal': 2, 'missing-type': 1 })
  // ② suggestion 变成「将要写入的值」，与无 map 时的兜底文案不同。
  const mapped = result.json.error.issues.find((item) => item.kind === 'missing-type')
  assert.equal(mapped.suggestion, 'type = "feat"')
  // ③ typeMap 回带路径。
  assert.equal(result.json.error.typeMap, mapFile)
  // 文件零写盘。
  assert.equal(snapshotStore(root), before, '--type-map 校验与预演都不得写盘')

  const withoutMap = runCli(root, ['--root', root, 'check', 'tasks', '--json'])
  const unmapped = withoutMap.json.error.issues.find((item) => item.kind === 'missing-type')
  assert.equal(unmapped.suggestion, 'supply type for this id via typeById (one of the ten enum values)')
  assert.equal(withoutMap.json.error.typeMap, null)
})

test('A5b：带 map 时人类输出提示「已校验但 check 不写盘」', () => {
  const root = freshProject('a5b')
  seedLegacyPair(root)
  const mapFile = writeJson(root, 'map.json', { 'T-20260101-01': 'feat' })
  const result = runCli(root, ['--root', root, 'check', 'tasks', '--type-map', mapFile])
  assert.equal(result.code, 1)
  assert.ok(result.stdout.includes(`${mapFile} 已校验`), result.stdout)
  assert.ok(result.stdout.includes('flow task normalize --type-map'), result.stdout)
  assert.ok(result.stdout.includes('check 不写盘'), result.stdout)
})

// -------------------------------------------------------------------- A6

test('A6：--type-map 非法枚举 → exit 2 usage，消息点名 id 与值', () => {
  const root = freshProject('a6')
  seedLegacyPair(root)
  const bad = writeJson(root, 'bad.json', { 'T-20260101-01': 'revert' })
  const before = snapshotStore(root)
  const result = runCli(root, ['--root', root, 'check', 'tasks', '--type-map', bad, '--json'])
  assert.equal(result.code, 2, '配置错必须是 2，不是 1（不能与「台账脏」混报）')
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'usage')
  assert.match(result.json.error.message, /不是合法 type/)
  assert.match(result.json.error.message, /revert/)
  assert.match(result.json.error.message, /T-20260101-01/)
  assert.equal(snapshotStore(root), before, '非法 map 不得触碰台账')
})

// -------------------------------------------------------------------- A7

test('A7：--type-map 其余坏形态（不存在/坏 JSON/非对象/空串/非字符串值）同样 exit 2', () => {
  const root = freshProject('a7')
  seedLegacyPair(root)
  const missing = path.join(root, 'nope.json')
  const broken = path.join(root, 'broken.json')
  fs.writeFileSync(broken, '{ bad')
  const array = writeJson(root, 'array.json', [1, 2])
  const nullish = writeJson(root, 'null.json', null)
  const nonString = writeJson(root, 'num.json', { 'T-20260101-01': 7 })
  const blank = writeJson(root, 'blank.json', { 'T-20260101-01': '   ' })

  const cases = [
    [missing, /文件不存在/],
    [broken, /不是合法 JSON/],
    [array, /顶层必须是对象/],
    [nullish, /顶层必须是对象/],
    [nonString, /不是合法 type/],
    [blank, /不是合法 type/],
    ['', /需要一个文件路径/],
  ]
  for (const [mapArg, pattern] of cases) {
    const result = runCli(root, ['--root', root, 'check', 'tasks', '--type-map', mapArg, '--json'])
    assert.equal(result.code, 2, `--type-map ${mapArg} 应退 2，实际 ${result.code}`)
    assert.equal(result.json.error.code, 'usage', `--type-map ${mapArg} 应是 usage`)
    assert.match(result.json.error.message, pattern, `--type-map ${mapArg} 文案不对：${result.json.error.message}`)
  }
})

// -------------------------------------------------------------------- A8

test('A8：不给 map 时 missing-type 保留（绝不自动猜 type）', () => {
  const root = freshProject('a8')
  seedLegacyPair(root)
  const result = runCli(root, ['--root', root, 'check', 'tasks', '--json'])
  assert.equal(result.json.error.counts['missing-type'], 1)
  assert.equal(result.json.error.typeMap, null)
  // 未被 map 覆盖的 id 仍在 issues 里。
  assert.ok(result.json.error.issues.some((item) => item.id === 'T-20260101-01' && item.kind === 'missing-type'))
})

test('A8b：真实台账只读复核（不写盘，数字取自 --json，不硬编码）', () => {
  const before = spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--', '.dsh'], { encoding: 'utf8' })
  const result = runCli(REPO, ['--root', REPO, 'check', 'tasks', '--json'])
  // 真实台账有旧记录 → 必为 exit 1；除非将来 P3 归零，那时通过也算对。
  if (result.code === 0) {
    assert.deepEqual(result.json.data.counts, { 'legacy-goal': 0, 'missing-type': 0 })
  } else {
    assert.equal(result.code, 1)
    assert.equal(result.json.error.code, 'check-failed')
    assert.equal(result.json.error.issues.length,
      result.json.error.counts['legacy-goal'] + result.json.error.counts['missing-type'])
  }
  const after = spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--', '.dsh'], { encoding: 'utf8' })
  assert.equal(after.stdout, before.stdout, '真实台账只读复核不得改动 .dsh/')
})

// -------------------------------------------------------------------- A9

test('A9：check list 收录第 7 项 tasks（精确列表 + 五键）', () => {
  const root = freshProject('a9')
  const result = runCli(root, ['--root', root, 'check', 'list', '--json'])
  assert.equal(result.code, 0)
  assert.deepEqual(
    result.json.data.checks.map((item) => item.name),
    ['staged', 'release-baseline', 'state', 'doc', 'decisions', 'experiments', 'tasks'],
  )
  const tasks = result.json.data.checks[6]
  assert.deepEqual(tasks, {
    name: 'tasks',
    interpreter: 'core',
    script: 'lib/core.mjs#normalizeTaskFormat',
    description: '旧任务记录未归一（残留 goal 键 / 缺 type）时失败（内置检查：bin 特判路由 core，只读）',
    args: '[--type-map <file.json>]',
  })
  const plain = runCli(root, ['--root', root, 'check', 'list'])
  assert.ok(plain.stdout.includes('tasks  [core]'), plain.stdout)
  assert.ok(plain.stdout.includes('check tasks [--type-map <file.json>]'), plain.stdout)
})

// -------------------------------------------------------------------- A10

test('A10：未知检查提示列出 tasks；--help 列出 check tasks', () => {
  const root = freshProject('a10')
  const bogus = runCli(root, ['--root', root, 'check', 'bogus'])
  assert.equal(bogus.code, 2)
  assert.match(bogus.stderr, /tasks/, `未知检查提示应列出 tasks：${bogus.stderr}`)
  const help = runCli(root, ['--root', root, '--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /check tasks/)
})

// ------------------------------------------------------- 防误伤：只读纪律

test('SPEC 白名单放行 --type-map（VALUE_FLAGS 已收录），未声明参数仍退 2', () => {
  const root = freshProject('spec')
  seedLegacyPair(root)
  const mapFile = writeJson(root, 'map.json', { 'T-20260101-01': 'feat' })
  // 被 VALUE_FLAGS 收录 ⇒ 解析器不再报「未知参数 --type-map」，而是进入 handler。
  const accepted = runCli(root, ['--root', root, 'check', 'tasks', '--type-map', mapFile, '--json'])
  assert.equal(accepted.code, 1, '放行后应由 handler 给出 check-failed，而不是解析器的用法错误')
  assert.equal(accepted.json.error.code, 'check-failed')
  assert.equal(accepted.json.error.typeMap, mapFile)
  // 未声明的 flag 仍被拒（两层：--fix 不在 VALUE_FLAGS/BOOL_FLAGS ⇒ 解析器「未知参数」；
  // 若进了 SPEC 之外的值参数则由 assertFlagsAllowed「不支持」）。两者都是 usage/exit 2。
  const rejected = runCli(root, ['--root', root, 'check', 'tasks', '--fix', '--json'])
  assert.equal(rejected.code, 2)
  assert.match(rejected.json.error.message, /未知参数 --fix|不支持 --fix/)
})

// ------------------------------------------------- D6：type-map 的两条 warning

test('D6：type-map 里台账不存在的 id → type-map-unknown-id warning（不阻断）', () => {
  const root = freshProject('d6-unknown')
  seedLegacyPair(root)
  const mapFile = writeJson(root, 'map.json', { 'T-20990101-01': 'docs' })
  const result = runCli(root, ['--root', root, 'check', 'tasks', '--type-map', mapFile, '--json'])
  // warning 不改变退出码：该 root 自身有 issue，所以仍是 1；关键是 warning 通道出现。
  assert.ok(
    JSON.stringify(result.json.warnings).includes('type-map-unknown-id: T-20990101-01'),
    `warnings 缺 type-map-unknown-id：${JSON.stringify(result.json.warnings)}`
  )
})

test('D6：type-map 覆盖已有 type 且不同 → type-map-unused warning（记录不被改）', () => {
  const root = freshProject('d6-unused')
  seedLegacyPair(root)
  const before = fs.readFileSync(path.join(root, '.dsh/flow/tasks/T-20260101-02.json'), 'utf8')
  const mapFile = writeJson(root, 'map.json', { 'T-20260101-02': 'chore' })
  const result = runCli(root, ['--root', root, 'check', 'tasks', '--type-map', mapFile, '--json'])
  assert.ok(
    JSON.stringify(result.json.warnings).includes('type-map-unused: T-20260101-02'),
    `warnings 缺 type-map-unused：${JSON.stringify(result.json.warnings)}`
  )
  assert.equal(
    fs.readFileSync(path.join(root, '.dsh/flow/tasks/T-20260101-02.json'), 'utf8'),
    before,
    'check 只读：已有 type 的记录一个字节都不许变'
  )
})

test('D6：map 里既有未知 id 又有已有 type 的键 → 两条 warning 都出现', () => {
  const root = freshProject('d6-both')
  seedLegacyPair(root)
  const mapFile = writeJson(root, 'map.json', { 'T-20260101-02': 'chore', 'T-20990101-01': 'docs' })
  const result = runCli(root, ['--root', root, 'check', 'tasks', '--type-map', mapFile, '--json'])
  const flat = JSON.stringify(result.json.warnings)
  assert.ok(flat.includes('type-map-unused: T-20260101-02'), flat)
  assert.ok(flat.includes('type-map-unknown-id: T-20990101-01'), flat)
})

// ------------------------------------------- P1-1：未初始化的 root 必须 usage(2)

test('P1-1：未初始化的 root 走 usage(exit 2)，不把「没有台账」报成「台账很干净」', () => {
  // review-core 在 task-10 里发现的缺口：`normalizeTaskFormat({fix:false})` 对空目录返回
  // `{ok:true, issues:[]}`，若不先拦，门禁会把"根本没台账"报成"零 issue"——假绿。
  // 兄弟检查 `check decisions`/`check experiments` 同样场景都返回 2（CONTRACT §6.2）。
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-check-tasks-uninit-'))
  TEMP_ROOTS.push(bare)
  const result = runCli(bare, ['--root', bare, 'check', 'tasks', '--json'])
  assert.equal(result.code, 2, `未初始化应为 exit 2，实际 ${result.code}：${JSON.stringify(result.json)}`)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'usage')
  assert.match(result.json.error.message, /run flow init first/)
  // 未初始化时也不得创建 store。
  assert.equal(fs.existsSync(path.join(bare, '.dsh')), false, '失败路径不得创建 store')
})
