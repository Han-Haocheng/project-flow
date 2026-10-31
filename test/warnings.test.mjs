// T-04：契约容错、警告全链路（CLI / 插件）、坏记录与 nextId 守卫。
//
// 三组用例的测试名以固定前缀开头，便于按需 grep：
//   `契约错型矩阵：…` / `坏记录+nextId：…` / `expect 拼错：…`
// 另外覆盖 CLI `--json` 信封与插件（index.js）的 drain 语义。
//
// 全部使用 os.tmpdir() 下的一次性项目，绝不触碰真实台账。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FlowError,
  addGate,
  addTask,
  containedPath,
  drainWarnings,
  getTask,
  initProject,
  listTasks,
  loadContract,
  readStoreState,
  removeTask,
  saveContract,
} from '../lib/core.mjs'
import { apply, panelStateReader } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')

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

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `project-flow-warn-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function freshProject(label) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true })
  const { contract } = loadContract(root)
  drainWarnings()
  return { root, contract, store: path.join(root, '.dsh/flow') }
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function writeFlowJson(root, payload) {
  fs.writeFileSync(path.join(root, '.dsh/flow/flow.json'), JSON.stringify(payload))
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function runCli(cwd, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' })
  let json = null
  const text = result.stdout.trim()
  if (text.startsWith('{')) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

// ------------------------------------------------ 契约错型矩阵（A1）

test('契约错型矩阵：section 写成错误类型时回退默认值并记 manifest-invalid', () => {
  const root = tempRoot('contract-matrix')
  initProject(root, { noGates: true })
  drainWarnings()
  const defaults = loadContract(root).contract

  const cases = [
    { payload: { store: 'x' }, key: 'store', check: (c) => assert.deepEqual(c.store, defaults.store) },
    { payload: { store: 5 }, key: 'store', check: (c) => assert.deepEqual(c.store, defaults.store) },
    { payload: { store: true }, key: 'store', check: (c) => assert.deepEqual(c.store, defaults.store) },
    { payload: { store: { root: 5 } }, key: 'store.root', check: (c) => assert.equal(c.store.root, '.dsh/flow') },
    { payload: { experiments: 'x' }, key: 'experiments', check: (c) => assert.deepEqual(c.experiments, defaults.experiments) },
    { payload: { experiments: 5 }, key: 'experiments', check: (c) => assert.deepEqual(c.experiments, defaults.experiments) },
    { payload: { experiments: [1] }, key: 'experiments', check: (c) => assert.deepEqual(c.experiments, defaults.experiments) },
    { payload: { tasks: 'x' }, key: 'tasks', check: (c) => assert.deepEqual(c.tasks, defaults.tasks) },
    { payload: { tasks: 7 }, key: 'tasks', check: (c) => assert.deepEqual(c.tasks, defaults.tasks) },
    { payload: { tasks: { current: 5 } }, key: 'tasks.current', check: (c) => assert.equal(c.tasks.current, null) },
    { payload: { tasks: { recentLimit: 'six' } }, key: 'tasks.recentLimit', check: (c) => assert.equal(c.tasks.recentLimit, 6) },
    { payload: { gates: 1 }, key: 'gates', check: (c) => assert.deepEqual(c.gates, defaults.gates) },
    { payload: { heartbeats: [] }, key: 'heartbeats', check: (c) => assert.deepEqual(c.heartbeats, defaults.heartbeats) },
    { payload: { decisions: 'x' }, key: 'decisions', check: (c) => assert.deepEqual(c.decisions, defaults.decisions) },
    { payload: { name: 5 }, key: 'name', check: (c) => assert.equal(c.name, path.basename(path.resolve(root))) },
  ]

  for (const { payload, key, check } of cases) {
    writeFlowJson(root, payload)
    let loaded
    assert.doesNotThrow(() => {
      loaded = loadContract(root)
    }, `loadContract must not throw for ${JSON.stringify(payload)}`)
    check(loaded.contract)
    assert.ok(
      loaded.warnings.some((item) => item.startsWith(`manifest-invalid: ${key}:`)),
      `${JSON.stringify(payload)} → ${JSON.stringify(loaded.warnings)}`,
    )
  }
})

test('契约错型矩阵：未知 section 与 legacy runs 原样保留且不产生 warning', () => {
  const root = tempRoot('contract-unknown')
  initProject(root, { noGates: true })
  writeFlowJson(root, { schema: 2, name: 'kept', runs: 'legacy', unknown: 123, experiments: { dir: 'data/experiments' } })
  drainWarnings()
  const loaded = loadContract(root)
  assert.equal(loaded.contract.runs, 'legacy')
  assert.equal(loaded.contract.unknown, 123)
  assert.equal(loaded.contract.experiments.dir, 'data/experiments')
  assert.deepEqual(loaded.warnings, [])
  assert.deepEqual(drainWarnings(), [], 'normalizeContract 不应产生 warning')
})

test('契约错型矩阵：错型契约下 CLI status/task list 仍退出 0 并携带 warnings', () => {
  const root = tempRoot('contract-cli')
  initProject(root, { noGates: true })
  writeFlowJson(root, { store: 'x', tasks: 5 })

  const status = runCli(root, ['status', '--json'])
  assert.equal(status.code, 0, status.stderr)
  assert.equal(status.json.ok, true)
  assert.ok(Array.isArray(status.json.warnings))
  assert.ok(status.json.warnings.some((item) => item.startsWith('manifest-invalid: store:')))
  assert.ok(status.json.warnings.some((item) => item.startsWith('manifest-invalid: tasks:')))

  const list = runCli(root, ['task', 'list', '--json'])
  assert.equal(list.code, 0, list.stderr)
  assert.deepEqual(list.json.data, [])
  assert.equal(list.stderr, '', '--json 模式不应往 stderr 打 warning')
  assert.ok(list.json.warnings.some((item) => item.startsWith('manifest-invalid:')))
})

test('契约错型矩阵：saveContract 写入错型字段时静默修复而不是抛 TypeError', () => {
  const { root, contract } = freshProject('contract-save')
  const saved = saveContract(root, { ...contract, store: 'nope', tasks: 'nope' })
  assert.deepEqual(saved.store, { root: '.dsh/flow' })
  assert.equal(saved.tasks.current, null)
  assert.equal(saved.schema, 2)
  assert.deepEqual(drainWarnings(), [], 'saveContract 走 normalizeContract，静默修复')
})

// ------------------------------------------- 坏记录 + nextId 守卫（A3）

test('坏记录+nextId：坏文件不被覆盖，自动 id 与显式 id 都 conflict', () => {
  const { root, contract } = freshProject('bad-record-guard')
  const id = `T-${stamp()}-01`
  const file = path.join(root, '.dsh/flow/tasks', `${id}.json`)
  fs.writeFileSync(file, '{ broken')
  drainWarnings()

  assert.throws(
    () => addTask(root, contract, { title: 'auto' }),
    (error) => error instanceof FlowError && error.code === 'conflict' && /already occupied/.test(error.message),
  )
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken', '坏文件内容必须原样保留')
  assert.ok(fs.readdirSync(path.dirname(file)).every((name) => name === `${id}.json`), '冲突时不应写入任何新文件')

  drainWarnings()
  assert.throws(
    () => addTask(root, contract, { id, title: 'explicit' }),
    (error) => error instanceof FlowError && error.code === 'conflict' && error.message.includes(id),
  )
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken')
  // 已知代价：坏文件占着 -01 时，当天自动 id 也会持续 conflict（中心已接受）。
  assert.throws(() => addTask(root, contract, { title: 'auto again' }), /already occupied/)

  // 换个没被占用的 id 仍可写；撞可读记录仍是 already exists（守卫不误报）。
  const other = addTask(root, contract, { id: `T-${stamp()}-02`, title: 'other' })
  assert.equal(other.id, `T-${stamp()}-02`)
  assert.throws(() => addTask(root, contract, { id: other.id, title: 'dup' }), /already exists/)
  assert.ok(drainWarnings().some((item) => item.startsWith('unreadable:')))
})

test('坏记录+nextId：unreadable 计数与 warning 一致（status 与 readStoreState）', () => {
  const { root, contract } = freshProject('bad-record-count')
  addTask(root, contract, { title: 'good' })
  fs.writeFileSync(path.join(root, '.dsh/flow/tasks', `T-${stamp()}-99.json`), 'not json')
  drainWarnings()

  const state = readStoreState(root, contract)
  assert.equal(state.tasks.counts.total, 1, 'total 仍是可读记录数')
  assert.equal(state.tasks.counts.unreadable, 1)
  assert.equal(state.tasks.items.length, 1)
  assert.ok(drainWarnings().some((item) => item.startsWith('unreadable:')))

  const status = runCli(root, ['status', '--json'])
  assert.equal(status.code, 0)
  assert.equal(status.json.data.counts.tasks.unreadable, 1)
  assert.equal(status.json.data.counts.tasks.total, 1)
  assert.ok(status.json.warnings.some((item) => item.startsWith('unreadable:')))

  const human = runCli(root, ['status'])
  assert.equal(human.code, 0)
  assert.ok(human.stderr.includes('警告: unreadable:'), human.stderr)
  assert.ok(human.stdout.includes('+1 无法读取'), human.stdout)
})

test('坏记录+nextId：99 用尽时仍是 no free T id left', () => {
  const { root, contract } = freshProject('ids-full')
  for (let index = 1; index <= 99; index += 1) {
    addTask(root, contract, { id: `T-${stamp()}-${String(index).padStart(2, '0')}`, title: `t${index}` })
  }
  assert.throws(() => addTask(root, contract, { title: 'overflow' }), /no free T id left for \d{8}/)
})

test('坏记录+nextId：显式 id 撞可读记录仍是 already exists（不误报 occupied）', () => {
  const { root, contract } = freshProject('explicit-id')
  const created = addTask(root, contract, { title: 'first' })
  assert.throws(
    () => addTask(root, contract, { id: created.id, title: 'dup' }),
    (error) => error instanceof FlowError && error.code === 'conflict' && /already exists/.test(error.message),
  )
})

// -------------------------------------------------- expect 拼错（A2 ⑤）

test('expect 拼错：gate add 的 gate-expect-unknown 走 CLI 信封与 stderr', () => {
  const { root } = freshProject('expect-typo')

  const json = runCli(root, [
    'gate', 'add', '--id', 'typo', '--title', '拼错', '--phase', 'manual', '--step', 'a=echo hi>>exitt 0', '--json',
  ])
  assert.equal(json.code, 0, json.stderr)
  assert.equal(json.json.ok, true)
  assert.ok(
    Array.isArray(json.json.warnings) && json.json.warnings.some((item) => item.startsWith('gate-expect-unknown:')),
    JSON.stringify(json.json.warnings),
  )
  assert.equal(json.stderr, '', '--json 模式不应往 stderr 打 warning')

  const human = runCli(root, [
    'gate', 'add', '--id', 'typo2', '--title', '拼错2', '--phase', 'manual', '--step', 'a=echo hi>>exitt 0',
  ])
  assert.equal(human.code, 0)
  assert.ok(human.stderr.includes('警告: gate-expect-unknown:'), human.stderr)
})

// ---------------------------------------------- CLI 警告信封（A2 其余）

test('CLI 警告：坏记录在人类输出走 stderr，在 --json 走顶层 warnings 且 stderr 为空', () => {
  const { root } = freshProject('cli-warnings')
  fs.writeFileSync(path.join(root, '.dsh/flow/tasks', `T-${stamp()}-01.json`), '{ broken')

  const human = runCli(root, ['task', 'list'])
  assert.equal(human.code, 0)
  assert.equal(human.stdout.trim(), '（没有任务记录）')
  assert.ok(human.stderr.includes('警告: unreadable:'), human.stderr)

  const json = runCli(root, ['task', 'list', '--json'])
  assert.equal(json.code, 0)
  assert.equal(json.stderr, '')
  assert.ok(Array.isArray(json.json.warnings))
  assert.ok(json.json.warnings.some((item) => item.startsWith('unreadable:')))
  assert.deepEqual(json.json.data, [], 'data 形状不变（list 的 data 仍是数组）')
})

test('CLI 警告：失败路径同样带 warnings，错误形状不变', () => {
  const { root } = freshProject('cli-error-warnings')
  fs.writeFileSync(path.join(root, '.dsh/flow/tasks', `T-${stamp()}-01.json`), '{ broken')

  const json = runCli(root, ['task', 'add', '--title', 'blocked', '--json'])
  assert.equal(json.code, 2, 'conflict 映射退出码 2')
  assert.equal(json.json.ok, false)
  assert.equal(json.json.error.code, 'conflict')
  assert.ok(/already occupied/.test(json.json.error.message))
  assert.ok(Array.isArray(json.json.warnings))
  assert.ok(json.json.warnings.some((item) => item.startsWith('unreadable:')))
  assert.equal(json.stderr, '')

  const human = runCli(root, ['task', 'add', '--title', 'blocked'])
  assert.equal(human.code, 2)
  assert.ok(human.stderr.includes('警告: unreadable:'), human.stderr)
  const warningAt = human.stderr.indexOf('警告:')
  const errorAt = human.stderr.indexOf('错误（conflict）')
  assert.ok(warningAt >= 0 && errorAt > warningAt, 'warning 应在错误行之前')
})

test('CLI 警告：check decisions 的 core warning 进入信封且 data 形状不变', () => {
  const { root } = freshProject('cli-check-warnings')
  git(root, ['init', '-q'])
  fs.writeFileSync(path.join(root, '.dsh/flow/decisions', 'D-20260101-01.json'), '{ broken')

  const json = runCli(root, ['check', 'decisions', '--json'])
  assert.equal(json.code, 0, json.stderr)
  assert.equal(json.json.ok, true)
  assert.equal(json.json.data.check, 'decisions')
  assert.equal(json.json.data.exitCode, 0)
  assert.deepEqual(json.json.data.failed, [])
  assert.ok(json.json.warnings.some((item) => item.startsWith('unreadable:')), JSON.stringify(json.json.warnings))
})

test('CLI 警告：gate run 的子进程 warning 只进 step.tail，不转发到父 warnings', () => {
  const { root, contract } = freshProject('gate-run-tail')
  addGate(root, contract, {
    id: 'noisy',
    title: '噪音门禁',
    phase: 'manual',
    steps: [{ id: 'warn', run: 'echo child-warning >&2; exit 0', expect: 'exit 0' }],
  })
  drainWarnings()

  const json = runCli(root, ['gate', 'run', 'noisy', '--json'])
  assert.equal(json.code, 0, json.stderr)
  assert.equal(json.json.data.ok, true)
  assert.ok(json.json.data.steps[0].tail.includes('child-warning'), JSON.stringify(json.json.data.steps[0]))
  assert.deepEqual(json.json.warnings, [], '子进程输出不进入父进程 warnings')
  assert.equal(json.stderr, '')
})

// ------------------------------------------------ 插件 warnings（A5）

function pluginCtx({ root, skillsRegister, logger }) {
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
    skills: {
      register(skill) {
        if (typeof skillsRegister === 'function') skillsRegister(skill)
        return () => {}
      },
    },
    workingDirectory: {
      get() {
        return root
      },
    },
    workspaceRegistry: {
      list() {
        return [{ path: root, title: path.basename(root) }]
      },
    },
  }
  const ctx = {
    get(name) {
      return services[name]
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on() {
      return () => {}
    },
    logger,
  }
  return { ctx, registeredTools }
}

test('插件：apply 两次后上一次失败诊断消失，本次真实失败仍记录', async () => {
  const { root } = freshProject('plugin-apply')
  let failSkills = true
  const logger = { messages: [], warn(message) { this.messages.push(String(message)) } }
  const { ctx } = pluginCtx({
    root,
    logger,
    skillsRegister() {
      if (failSkills) throw new Error('boom-skill')
    },
  })

  apply(ctx)
  const read = panelStateReader(ctx)
  const first = await read(root)
  assert.ok(
    first.warnings.some((item) => item.includes('skills: cannot register') && item.includes('boom-skill')),
    JSON.stringify(first.warnings),
  )

  failSkills = false
  apply(ctx)
  const second = await read(root)
  assert.equal(
    second.warnings.some((item) => item.includes('boom-skill')),
    false,
    `上次失败诊断必须被清掉：${JSON.stringify(second.warnings)}`,
  )
})

test('插件：工具成功结果附加 core warnings，失败时 logger.warn 且 message 不变', async () => {
  const { root } = freshProject('plugin-tools')
  fs.writeFileSync(path.join(root, '.dsh/flow/tasks', `T-${stamp()}-01.json`), '{ broken')
  const loggerMessages = []
  const logger = { warn(message) { loggerMessages.push(String(message)) } }
  const { ctx, registeredTools } = pluginCtx({ root, logger })
  apply(ctx)

  const taskTool = registeredTools.get('flow_task')
  assert.ok(taskTool, 'flow_task 应注册')

  const listed = await taskTool.execute({ action: 'list', root }, { agent: { session: { cwd: root } } })
  assert.ok(Array.isArray(listed.warnings), '成功结果应带 warnings')
  assert.ok(listed.warnings.some((item) => item.startsWith('unreadable:')), JSON.stringify(listed.warnings))
  assert.deepEqual(listed.items, [])

  let thrown = null
  try {
    await taskTool.execute({ action: 'add', title: 'blocked', root }, { agent: { session: { cwd: root } } })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof FlowError, '失败应抛出原始错误')
  assert.equal(thrown.code, 'conflict')
  assert.ok(/already occupied/.test(thrown.message), thrown.message)
  assert.equal(/project-flow:|unreadable:/.test(thrown.message), false, 'error.message 不得被改写')
  assert.ok(
    loggerMessages.some((item) => item.includes('flow_task') && item.includes('unreadable:')),
    JSON.stringify(loggerMessages),
  )
})

// ---------------------------------------------- 面板轮询不得偷警告（A5）

test('插件：面板读路径 drain 后丢弃，不把警告转进 payload', async () => {
  const { root } = freshProject('plugin-panel-drain')
  const { ctx } = pluginCtx({ root, logger: { warn() {} } })
  apply(ctx)
  ;(await panelStateReader(ctx)(root)).warnings // 先跑一轮，确保 apply/首轮状态已稳定
  drainWarnings()

  // 制造一条 core 全局 warning：它不会被面板本轮读取重新产生（tasks.current 为 null）。
  containedPath(root, '/definitely/outside/the/project', 'store.root')
  const state = await panelStateReader(ctx)(root)
  assert.equal(Array.isArray(state.warnings), true)
  assert.equal(
    state.warnings.some((item) => item.startsWith('manifest-path-rejected:')),
    false,
    '面板轮询不能把 core 全局警告转进 payload',
  )
  assert.deepEqual(drainWarnings(), [], '面板轮询已经 drain，下一次工具调用不会看到旧警告')
})

// ------------------------------------------------------- 细粒度回归

test('坏记录：移除坏文件后同一 id 可正常创建', () => {
  const { root, contract } = freshProject('bad-record-recover')
  const id = `T-${stamp()}-01`
  const file = path.join(root, '.dsh/flow/tasks', `${id}.json`)
  fs.writeFileSync(file, '{ broken')
  assert.throws(() => addTask(root, contract, { title: 'blocked' }), /already occupied/)
  fs.rmSync(file)
  const created = addTask(root, contract, { title: 'recovered' })
  assert.equal(created.id, id)
  assert.equal(getTask(root, contract, id).title, 'recovered')
  assert.deepEqual(listTasks(root, contract).map((item) => item.id), [id])
  removeTask(root, contract, id)
  assert.deepEqual(listTasks(root, contract), [])
})
