// T-15（task-187）：任务必填字段 `type`（conventional 10 值）。
//
// 只使用 os.tmpdir() 下的一次性项目；覆盖 core 校验/读投影、CLI 退出码矩阵、
// flow_task 工具 schema 与 SPEC↔handler 一致性。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FlowError,
  TASK_TYPES,
  addTask as addTaskCore,
  getTask,
  initProject,
  listTasks,
  loadContract,
  updateTask,
} from '../lib/core.mjs'
import { apply } from '../index.js'
// `flow_task` is mounted by its own module entry since the plugin split.
import { apply as applyTasks } from '../tasks.js'
import { TASK_ADD_FIELDS, TASK_UPDATE_FIELDS } from '../lib/plugin/shared.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
const BIN_SOURCE = fs.readFileSync(BIN, 'utf8')
const TEMP_ROOTS = []

/**
 * The `flags` array of one `SPEC.task.<command>` entry, parsed out of the CLI source.
 *
 * Why parse instead of matching a literal: the array's ORDER carries no meaning for
 * the CLI (`VALUE_FLAGS` is set semantics), so pinning it as a literal would turn a
 * harmless reordering — anyone sorting the list alphabetically — into a red test that
 * blames the wrong person. What the assertion actually protects is MEMBERSHIP
 * (`type` must be declared, or the CLI rejects `--type`), so the check has to read the
 * members and compare as a set.
 *
 * Failure discipline: an unparseable source THROWS. Returning `[]` would let
 * `flags.includes('type')` fail for the right reason but `flags.includes(…)` in other
 * shapes pass vacuously — an empty read must never look like a clean source.
 *
 * The `task:` section is anchored by slicing between `task: Object.freeze({` and the
 * next `gate: Object.freeze({`; a slice is required because `exp`/`gate` declare
 * commands with the same names (`add`, `update`) and a bare regex would happily match
 * those instead.
 */
function specTaskFlags(source, command) {
  const start = source.indexOf('task: Object.freeze({')
  if (start < 0) throw new Error('SPEC.task 段未找到：bin/flow.mjs 的 `task: Object.freeze({` 锚点变了')
  const end = source.indexOf('gate: Object.freeze({', start)
  if (end < 0) throw new Error('SPEC.task 段未闭合：`gate: Object.freeze({` 锚点变了')
  const section = source.slice(start, end)
  const match = new RegExp(`(?:^|\\n)\\s*${command}:\\s*\\{\\s*flags:\\s*\\[([^\\]]*)\\]`).exec(section)
  if (match === null) {
    throw new Error(`SPEC.task.${command}.flags 未解析到：声明形状变了，断言不能静默降级为空数组`)
  }
  const flags = match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry !== '')
  // A parsed-but-empty list is indistinguishable from "the source says nothing";
  // refuse it so a broken regex cannot masquerade as a passing set comparison.
  if (flags.length === 0) throw new Error(`SPEC.task.${command}.flags 解析为空：拒绝把空数组当成有效结果`)
  return flags
}

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-type-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  return root
}

function runCli(cwd, args) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env })
  let json = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = null
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

function expectInvalid(fn, pattern) {
  assert.throws(
    fn,
    (error) => error instanceof FlowError && error.code === 'invalid' && pattern.test(error.message),
  )
}

function pluginCtx({ root, logger }) {
  const registeredTools = new Map()
  const routes = []
  const services = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
      getOrigin() {
        return 'http://127.0.0.1:4021'
      },
    },
    tools: {
      register(definition) {
        registeredTools.set(definition.name, definition)
        return () => registeredTools.delete(definition.name)
      },
    },
    skills: { register() { return () => {} } },
    workingDirectory: { get() { return root } },
    workspaceRegistry: { list() { return [{ path: root, title: path.basename(root) }] } },
  }
  const ctx = {
    get(name) { return services[name] },
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    on() { return () => {} },
    logger: logger ?? { warn() {} },
  }
  return { ctx, registeredTools }
}

test('type：add 缺 type / 空串 / 非法值 / 旧 revert 都 invalid', () => {
  const { contract } = loadContract(freshProject('missing'))
  expectInvalid(() => addTaskCore(freshProject('missing2'), contract, { title: '缺 type' }), /type is required/)
  expectInvalid(() => addTaskCore(freshProject('empty'), contract, { type: '', title: '空' }), /type is required/)
  expectInvalid(() => addTaskCore(freshProject('bogus'), contract, { type: 'bogus', title: '坏' }), /type must be one of/)
  expectInvalid(() => addTaskCore(freshProject('revert'), contract, { type: 'revert', title: '旧枚举' }), /type must be one of/)
})

test('type：10 个合法值逐一可建，且读回一致', () => {
  const root = freshProject('valid')
  const { contract } = loadContract(root)
  assert.deepEqual(TASK_TYPES, ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci'])
  for (const type of TASK_TYPES) {
    const task = addTaskCore(root, contract, { type, title: `${type} 任务` })
    assert.equal(task.type, type)
    assert.equal(getTask(root, contract, task.id).type, type)
  }
  assert.equal(listTasks(root, contract).length, TASK_TYPES.length)
})

test('type：update 一律拒绝（④ 不可改），非法值也让位同一条不可改文案', () => {
  const root = freshProject('update')
  const { contract } = loadContract(root)
  const task = addTaskCore(root, contract, { type: 'feat', title: '改类型' })
  // ④：type 参与统计，改了历史就漂移；core 单点拦截，文案与 id/schema/created_at 同句式。
  expectInvalid(() => updateTask(root, contract, task.id, { type: 'fix' }), /task type cannot be changed/)
  expectInvalid(() => updateTask(root, contract, task.id, { type: 'bogus' }), /task type cannot be changed/)
  assert.equal(updateTask(root, contract, task.id, { status: 'active' }).type, 'feat', '未给 type 保留原值')
})

test('type：旧记录（无 type）读投影为 null、不迁移；update 其它字段不补写 type', () => {
  const root = freshProject('legacy')
  const { contract } = loadContract(root)
  const legacy = {
    schema: 1,
    id: 'T-20261105-01',
    title: '旧任务',
    status: 'draft',
    owner: '',
    goal: '',
    parent: null,
    scope: { allow: [], deny: [] },
    acceptance: [],
    checkpoints: [],
    commits: [],
    notes: '',
    created_at: '2026-11-05T10:00:00+08:00',
    updated_at: '2026-11-05T10:00:00+08:00',
  }
  const file = path.join(root, '.dsh/flow/tasks', 'T-20261105-01.json')
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2) + '\n')

  assert.equal(getTask(root, contract, legacy.id).type, null)
  assert.equal(listTasks(root, contract)[0].type, null)

  const updated = updateTask(root, contract, legacy.id, { status: 'active' })
  assert.equal(updated.type, null)
  assert.equal(Object.hasOwn(updated, 'type'), true, '读投影有 type:null')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(Object.hasOwn(onDisk, 'type'), false, '写路径不迁移、不补写 type')
  assert.equal(onDisk.status, 'active')
})

test('type：旧记录带手写 null / \'\' 时，update 其它字段同样可用且不补写 type', () => {
  // T-20261106124556。`type` 的「缺失」有三种落盘形态：键不存在（上一条用例）、
  // `null`、`''`。CONTRACT §3.2 对三者一视同仁，但 `validateTaskFields` 只放行
  // 第一种，另两种曾让**任何** update 都抛 `invalid`——读得出来、改不动。
  // 修法在 `applyTaskPatch`（仅 update 路径）里把缺失语义归一后再校验：一条记录
  // 缺 type 不应冻结它的 status/owner/notes。`buildTask` 与 `normalizeTaskFormat`
  // 的严格性不受影响（后者见 normalize 的 B7：缺 type 时整条不写，goal 不丢）。
  const root = freshProject('legacy-null')
  const { contract } = loadContract(root)
  const write = (id, type) => {
    const record = {
      schema: 1,
      id,
      title: `旧任务 ${id}`,
      status: 'draft',
      owner: '',
      parent: null,
      scope: { allow: [], deny: [] },
      acceptance: [],
      checkpoints: [],
      commits: [],
      notes: '',
      created_at: '2026-11-05T10:00:00+08:00',
      updated_at: '2026-11-05T10:00:00+08:00',
      ...(type === undefined ? {} : { type }),
    }
    const file = path.join(root, '.dsh/flow/tasks', `${id}.json`)
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
    return file
  }

  for (const [id, type] of [['T-20261105-11', null], ['T-20261105-12', '']]) {
    const file = write(id, type)
    // 之前：invalid: type must be one of … —— 一条缺 type 的记录冻结了所有字段。
    const updated = updateTask(root, contract, id, { status: 'active', notes: '补备注' })
    assert.equal(updated.status, 'active', `type=${JSON.stringify(type)} 的记录必须能改 status`)
    assert.equal(updated.notes, '补备注')
    assert.equal(updated.type, type, '读投影原样返回（不迁移；只有缺键才补 null）')
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(onDisk.type, type, 'update 不得改写/补写 type，原字面值原样留在盘上')
    assert.equal(Object.hasOwn(onDisk, 'type'), true, 'type 键仍在（不删键）')
    assert.equal(onDisk.notes, '补备注')
  }

  // 非空且不在十枚举内的字符串仍被拒（④ 的严格性不因这次放宽而松动）。
  const bogusFile = write('T-20261105-13', 'nope')
  expectInvalid(() => updateTask(root, contract, 'T-20261105-13', { notes: 'x' }), /type must be one of/)
  assert.equal(JSON.parse(fs.readFileSync(bogusFile, 'utf8')).type, 'nope', '非法串记录字节不变')
})

test('type：CLI 退出码矩阵（缺 type / 非法 / 合法 / update）', () => {
  const root = freshProject('cli')
  const missing = runCli(root, ['task', 'add', '--title', '缺 type', '--json'])
  assert.equal(missing.code, 2, missing.stdout + missing.stderr)
  assert.equal(missing.json?.error?.code, 'invalid')
  assert.match(missing.json?.error?.message ?? '', /type is required/)

  const bogus = runCli(root, ['task', 'add', '--title', '坏类型', '--type', 'bogus', '--json'])
  assert.equal(bogus.code, 2)
  assert.match(bogus.json?.error?.message ?? '', /type must be one of feat, fix, docs/)

  const ok = runCli(root, ['task', 'add', '--title', '合法', '--type', 'feat', '--json'])
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(ok.json?.data?.type, 'feat')

  // ④：--type 仍声明（走 core 的统一文案），但 update 一律 exit 2 invalid。
  const updated = runCli(root, ['task', 'update', ok.json.data.id, '--type', 'fix', '--json'])
  assert.equal(updated.code, 2, updated.stdout + updated.stderr)
  assert.equal(updated.json?.error?.code, 'invalid')
  assert.equal(updated.json?.error?.message, 'task type cannot be changed')

  const badUpdate = runCli(root, ['task', 'update', ok.json.data.id, '--type', 'nope', '--json'])
  assert.equal(badUpdate.code, 2)
  assert.equal(badUpdate.json?.error?.code, 'invalid')
  assert.equal(badUpdate.json?.error?.message, 'task type cannot be changed', '不可改拦截先于枚举校验')

  const help = runCli(root, ['task', 'add', '--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /--type/)
  assert.match(help.stdout, /feat\|fix\|docs\|style\|refactor\|perf\|test\|chore\|build\|ci/)
  assert.equal(/revert/.test(help.stdout), false)
})

test('type：flow_task schema enum/必填 + SPEC↔handler 白名单含 type', async () => {
  const root = freshProject('tool')
  const { ctx, registeredTools } = pluginCtx({ root })
  apply(ctx)
  applyTasks(ctx)
  const taskTool = registeredTools.get('flow_task')
  assert.ok(taskTool, 'flow_task 应注册（由 tasks.js 模块入口注册）')
  const typeSchema = taskTool.parameters.properties.type
  assert.equal(typeSchema.type, 'string')
  assert.deepEqual(typeSchema.enum, ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci'])
  assert.match(taskTool.description, /type.*required on add.*feat\/fix/i)

  const exec = { agent: { session: { cwd: root } } }
  await assert.rejects(
    taskTool.execute({ action: 'add', title: '工具缺 type' }, exec),
    (error) => error instanceof FlowError && error.code === 'invalid' && /type is required/.test(error.message),
  )
  const created = await taskTool.execute({ action: 'add', type: 'feat', title: '工具建' }, exec)
  assert.equal(created.task.type, 'feat')
  await assert.rejects(
    taskTool.execute({ action: 'update', id: created.task.id, type: 'chore' }, exec),
    (error) => error instanceof FlowError && error.code === 'invalid' && error.message === 'task type cannot be changed',
    '工具侧与 core 同一句文案（白名单放行 type，由 core 拦）',
  )

  // SPEC 与 handler 同步：task add/update 都声明了 type，help/用法列出 10 值。
  //
  // 这里断言的是**成员资格**，不是数组长相：CLI 只问 "type 在不在 flags 里"（VALUE_FLAGS
  // 是集合语义），顺序对行为零影响。旧的 `assert.match(BIN_SOURCE, /add: \{ flags: \['id',
  // 'title', 'type'/)` 只验了一个**前缀**，既没证明全体成员都在，又会因为别人给 flags
  // 排序而红——task-63 加 `stage` 时就撞上过，被迫改成"只能往末尾追加"。
  const addFlags = specTaskFlags(BIN_SOURCE, 'add')
  const updateFlags = specTaskFlags(BIN_SOURCE, 'update')
  for (const [command, flags] of [['add', addFlags], ['update', updateFlags]]) {
    assert.ok(flags.includes('type'), `SPEC.task.${command}.flags 必须声明 type（否则 CLI 拒绝 --type）`)
    // 更强：原来只验前 3 个，现在验的是 SPEC 里声明的**全体**都必须在 handler 白名单里可读。
    assert.ok(flags.includes('id') && flags.includes('title'), `SPEC.task.${command}.flags 缺 id/title`)
  }
  assert.match(BIN_SOURCE, /feat\|fix\|docs\|style\|refactor\|perf\|test\|chore\|build\|ci/)

  // A11：`goal` 已从工具 schema/白名单里删除（②），只在"已合并"说明里出现。
  assert.equal(taskTool.parameters.properties.goal, undefined, 'flow_task 不再暴露 goal 参数')
  assert.equal(taskTool.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(taskTool.parameters.properties).includes('goal'), false)
  assert.match(taskTool.description, /`goal` was merged into `title`/)
  assert.deepEqual(TASK_ADD_FIELDS.includes('goal'), false)
  assert.deepEqual(TASK_UPDATE_FIELDS.includes('goal'), false)
  // ④：title/type 仍透传给 core（白名单不另造第二种错误形态）。
  assert.equal(TASK_UPDATE_FIELDS.includes('title'), true)
  assert.equal(TASK_UPDATE_FIELDS.includes('type'), true)
  // update 的 flags 是 add 的超集之外的同一套声明的成员资格，不再是字面前缀。
  assert.ok(updateFlags.includes('status'), 'SPEC.task.update.flags 必须声明 status')
  assert.ok(updateFlags.includes('owner'), 'SPEC.task.update.flags 必须声明 owner')
  assert.ok(updateFlags.includes('notes'), 'SPEC.task.update.flags 必须声明 notes')
})

// ------------------------------------------------------------------ 顺序无关

/**
 * The membership checks above, factored out so they can be replayed against a
 * REWRITTEN copy of the CLI source. Keeping one implementation means the guard
 * below proves something about the real assertions, not about a look-alike.
 */
function assertTypeDeclaredInSpec(source) {
  const addFlags = specTaskFlags(source, 'add')
  const updateFlags = specTaskFlags(source, 'update')
  for (const [command, flags] of [['add', addFlags], ['update', updateFlags]]) {
    assert.ok(flags.includes('type'), `SPEC.task.${command}.flags 必须声明 type`)
  }
  for (const flag of ['status', 'owner', 'notes']) {
    assert.ok(updateFlags.includes(flag), `SPEC.task.update.flags 必须声明 ${flag}`)
  }
}

test('SPEC.task flags：成员资格与数组顺序无关（打乱顺序仍绿，删掉 type 必红）', () => {
  // 正向：把 task 段里两个 flags 数组**逆序**，成员一个不变 —— 判定必须仍然通过。
  // 这正是 task-63 的场景（给 flags 插了 'stage' 导致旧的字面前缀断言红）。
  const taskStart = BIN_SOURCE.indexOf('task: Object.freeze({')
  const taskEnd = BIN_SOURCE.indexOf('gate: Object.freeze({', taskStart)
  assert.ok(taskStart >= 0 && taskEnd > taskStart, 'SPEC.task 段锚点必须存在')
  const section = BIN_SOURCE.slice(taskStart, taskEnd)
  const reversed = section.replace(/flags:\s*\[([^\]]*)\]/g, (whole, inner) => {
    const entries = inner
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
    return `flags: [${entries.reverse().join(', ')}]`
  })
  assert.notEqual(reversed, section, '样本改写必须真的发生，否则本用例什么都没证明')
  const reordered = BIN_SOURCE.slice(0, taskStart) + reversed + BIN_SOURCE.slice(taskEnd)
  // 自检的是「确实换过序」这件事本身，而不是某个特定元素落在哪个位置——把判据写成
  // "type 不在首位"会在这个文件自己就被重排过（比如 type 本来就在末尾）时误报。
  const beforeOrder = JSON.stringify(specTaskFlags(BIN_SOURCE, 'add'))
  const afterOrder = JSON.stringify(specTaskFlags(reordered, 'add'))
  assert.notEqual(afterOrder, beforeOrder, '样本必须真的换了顺序，否则本用例什么都没证明')
  assert.deepEqual(afterOrder.slice(1, -1).split(',').sort(), beforeOrder.slice(1, -1).split(',').sort(), '换序不得改变成员')
  assertTypeDeclaredInSpec(reordered)

  // 反向：从 add 的 flags 里删掉 type —— 同一组断言必须红，证明解耦没有把判据放松。
  const withoutType = BIN_SOURCE.replace(
    /(task: Object\.freeze\(\{[\s\S]*?\badd:\s*\{\s*flags:\s*\[)([^\]]*)(\])/,
    (whole, head, inner, tail) => `${head}${inner.replace(/,\s*'type'|'type',\s*/g, '').replace(/'type'/g, '')}${tail}`,
  )
  assert.notEqual(withoutType, BIN_SOURCE, '删 type 的改写必须真的发生')
  assert.throws(() => assertTypeDeclaredInSpec(withoutType), /必须声明 type/, '删掉 type 必须让成员资格断言失败')

  // 解析失败必须显式抛错，绝不静默降级为空数组（空数组会让 includes 假绿）。
  assert.throws(() => specTaskFlags('// no SPEC here', 'add'), /SPEC\.task 段未找到/)
  assert.throws(
    () => specTaskFlags(BIN_SOURCE.replace(/task: Object\.freeze\(\{[\s\S]*?gate: Object\.freeze\(\{/, 'gate: Object.freeze({')),
    /SPEC\.task/,
  )
})
