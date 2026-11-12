// T-20261112161101 · 重构⑤：CLI --json 契约的守卫测试。
//
// --json 是前后端唯一的接口（用户边界：前端通过 CLI 调用后端），所以这里不测
// 「输出好看不好看」，只测**形状**：
//   1. 信封恒为 {schemaVersion, ok, data|error, warnings}，版本号与契约文件一致；
//   2. 每条命令的真实 --json 输出都符合 lib/cli/contract.mjs 登记的形状
//      （未登记字段即失败 —— 增/删/改字段必须同步契约）；
//   3. SPEC（bin 的命令/参数表）与 DATA_SHAPES 一一对应，没有漏登记的命令，
//      也没有已删除命令的幽灵形状；
//   4. 契约测试**自证有效**：故意改名/加字段/错类型/错版本都必须被校验器抓住；
//   5. --json 与人类输出分工：--json 只吐单行 JSON、不写 stderr、不掺人类文案。
//
// 只使用 os.tmpdir() 下的一次性项目（含一个 git 仓库，因为 check 族需要暂存区）。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initProject } from '../lib/core.mjs'
import {
  CLI_CONTRACT_VERSION,
  DATA_SHAPES,
  RECORD_SHAPES,
  TOOL_SHAPES,
  commandKeys,
  validateEnvelope,
  validateCommandData,
  validateInvocation,
  validateShape,
  contractDocument,
  canonicalEnvelope,
} from '../lib/cli/contract.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BIN = path.join(ROOT, 'bin', 'flow.mjs')
const DOC = path.join(ROOT, 'docs', 'cli-contract.md')
const BIN_SOURCE = fs.readFileSync(BIN, 'utf8')

const TEMP_ROOTS = []
after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-contract-' + label + '-'))
  TEMP_ROOTS.push(dir)
  return dir
}

const ENV = { ...process.env }
delete ENV.DSH_SESSION_ID
delete ENV.DSH_AGENT_ID

function run(cwd, args) {
  const result = spawnSync(process.execPath, [BIN, '--root', cwd, ...args], {
    cwd,
    encoding: 'utf8',
    env: ENV,
  })
  let json = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = null
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

/** SPEC 表只在 bin 源码里（import 会执行 main），用与 flag-spec 测试相同的解析法。 */
function specFromSource() {
  const start = BIN_SOURCE.indexOf('export const SPEC = Object.freeze({')
  assert.ok(start > 0, 'bin/flow.mjs 里找不到 SPEC 表')
  const open = BIN_SOURCE.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let index = open; index < BIN_SOURCE.length; index += 1) {
    const char = BIN_SOURCE[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  assert.ok(end > open, 'SPEC 表括号不配对')
  return new Function('return (' + BIN_SOURCE.slice(open, end) + ')')()
}

/** SPEC 展开成契约命令键：单命令用命令名，多子命令用 command.action。 */
function specCommandKeys() {
  const keys = []
  for (const [command, entry] of Object.entries(specFromSource())) {
    if (Object.hasOwn(entry, 'flags')) keys.push(command)
    else for (const action of Object.keys(entry)) keys.push(command + '.' + action)
  }
  return keys.sort()
}

function describeCommand(key) {
  const [command, action] = key.split('.')
  return action === undefined ? [command, '--json'] : [command, action, '--json']
}

// ---------------------------------------------------------------- 信封

test('信封：成功路径带 schemaVersion/data/warnings，无多余顶层字段', () => {
  const root = tempRoot('envelope')
  initProject(root, { name: 'env' })
  const result = run(root, ['status', '--json'])
  assert.equal(result.code, 0, result.stderr)
  const parts = result.stdout.trim().split('\n')
  assert.equal(parts.length, 1, '--json 的 stdout 必须恰好一行 JSON：' + JSON.stringify(result.stdout))
  assert.deepEqual(Object.keys(result.json).sort(), ['data', 'ok', 'schemaVersion', 'warnings'])
  assert.equal(result.json.schemaVersion, CLI_CONTRACT_VERSION)
  assert.equal(result.json.ok, true)
  assert.deepEqual(validateEnvelope(result.json), [])
  assert.deepEqual(validateCommandData('status', result.json.data), [])
  assert.equal(result.stderr, '', '--json 成功路径不写 stderr')
})

test('信封：失败路径只带 error，退出码按 error.code 映射', () => {
  const root = tempRoot('envelope-fail')
  initProject(root, { name: 'envf' })
  const cases = [
    { args: ['nope'], code: 1, errorCode: 'usage' },
    { args: ['task', 'show', 'T-29990101-99'], code: 3, errorCode: 'not-found' },
    { args: ['task', 'add', '--title', 'x', '--type', 'not-a-type'], code: 2, errorCode: 'invalid' },
    { args: ['task', 'next', 'T-29990101-99'], code: 3, errorCode: 'not-found' },
  ]
  for (const item of cases) {
    const result = run(root, item.args.concat(['--json']))
    assert.equal(result.code, item.code, item.args.join(' ') + ' 的退出码')
    assert.equal(result.json.ok, false)
    assert.deepEqual(Object.keys(result.json).sort(), ['error', 'ok', 'schemaVersion', 'warnings'])
    assert.equal(result.json.error.code, item.errorCode)
    assert.equal(typeof result.json.error.message, 'string')
    assert.deepEqual(validateEnvelope(result.json), [])
  }
})

test('信封：gate run 的门禁失败仍是 ok:true / exit 0，用 data.ok 表达', () => {
  const root = tempRoot('gate-ok')
  initProject(root, { name: 'gok' })
  const added = run(root, ['gate', 'add', '--id', 'boom', '--title', 'B', '--phase', 'manual', '--step', 'fail=exit 3', '--json'])
  assert.equal(added.code, 0, added.stderr)
  const result = run(root, ['gate', 'run', 'boom', '--json'])
  assert.equal(result.code, 0, '门禁失败不改变退出码：' + result.stderr)
  assert.deepEqual(validateInvocation('gate.run', result.json), [])
  assert.equal(result.json.ok, true, '命令本身成功')
  assert.equal(result.json.data.ok, false, '门禁结果用 data.ok 表达')
  assert.equal(result.json.data.steps[0].exit, 3)
})

test('信封：Warnings 恒为数组，且 --json 下不重复写 stderr', () => {
  const root = tempRoot('envelope-warn')
  initProject(root, { name: 'envw', noGates: true })
  // 坏记录 → core warning；--json 只走信封顶层 warnings。
  fs.mkdirSync(path.join(root, '.agents', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(root, '.agents', 'tasks', 'T-20260101-01.json'), '{oops')
  const result = run(root, ['task', 'list', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.ok(Array.isArray(result.json.warnings))
  assert.ok(result.json.warnings.some((line) => line.startsWith('unreadable:')), JSON.stringify(result.json.warnings))
  assert.equal(result.stderr, '')
})

test('status.intents：未完成 saga intent 在 status 里可读，形状与登记一致', () => {
  const root = tempRoot('intents')
  initProject(root, { name: 'it' })
  const dir = path.join(root, '.agents', 'intents')
  fs.mkdirSync(dir, { recursive: true })
  const intent = {
    schema: 1,
    id: 'I-20261112-01',
    kind: 'dispatch',
    target: { task: 'T-1', role: 'implementer' },
    steps: ['spawn', 'receipt'],
    done: ['spawn'],
    state: 'open',
    session: 's1',
    pid: null,
    host: 'test',
    note: '',
    data: {},
    started_at: '2026-11-12T20:00:00+08:00',
    updated_at: '2026-11-12T20:00:00+08:00',
  }
  fs.writeFileSync(path.join(dir, intent.id + '.json'), JSON.stringify(intent))
  const result = run(root, ['status', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(validateInvocation('status', result.json), [])
  assert.equal(result.json.data.intents.open, 1)
  const row = result.json.data.intents.items[0]
  assert.equal(row.id, intent.id)
  assert.deepEqual(row.missing, ['receipt'])
  assert.deepEqual(Object.keys(row).sort(), ['done', 'id', 'kind', 'missing', 'steps', 'target', 'updated_at'])
})

// ---------------------------------------------------------------- 覆盖

test('契约覆盖：SPEC 的每个命令键都有 data 形状，且没有幽灵形状', () => {
  const spec = specCommandKeys()
  const registered = commandKeys()
  assert.ok(spec.length >= 60, 'SPEC 只解析出 ' + spec.length + ' 个命令键，解析器坏了')
  const missing = spec.filter((key) => Object.hasOwn(DATA_SHAPES, key) === false)
  assert.deepEqual(missing, [], '这些命令没有登记 --json data 形状：' + missing.join(', '))
  const ghosts = registered.filter((key) => spec.includes(key) === false)
  assert.deepEqual(ghosts, [], '契约里登记了 SPEC 中不存在的命令（幽灵形状）：' + ghosts.join(', '))
})

test('契约文档：A 命令索引表与注册表逐行一致，且命令总数文字准确', () => {
  const doc = fs.readFileSync(DOC, 'utf8')
  const start = doc.indexOf('### A 命令索引')
  const end = doc.indexOf('## 5 记录形状')
  assert.ok(start > 0 && end > start, '文档里找不到 A 命令索引表')
  const table = doc.slice(start, end)
  const rows = [...table.matchAll(/^\| (flow [a-z0-9.-]+(?: [a-z0-9-]+)*) \|/gm)].map((match) =>
    match[1].replace(/^flow /, '').replace(/ /g, '.'),
  )
  assert.deepEqual(rows.slice().sort(), commandKeys(), 'A 表与注册表必须一一对应（不多不少）')
  const declared = /当前 (\d+) 条/.exec(doc)
  assert.ok(declared !== null, '变更记录/正文必须写明当前命令总数')
  assert.equal(Number(declared[1]), commandKeys().length, '命令总数的文字必须与注册表一致')
})

test('契约覆盖：docs/cli-contract.md 逐个登记了全部命令键', () => {
  const doc = fs.readFileSync(DOC, 'utf8')
  const missing = commandKeys().filter((key) => doc.includes('flow ' + key.replace('.', ' ')) === false)
  assert.deepEqual(missing, [], '文档漏了这些命令：' + missing.join(', '))
  assert.ok(doc.includes('schemaVersion'), '文档必须写 schemaVersion')
  assert.ok(doc.includes(String(CLI_CONTRACT_VERSION)), '文档必须写当前契约版本号')
})

// ---------------------------------------------------------------- 逐命令形状

test('契约形状：每条命令真实 --json 输出都符合登记形状', () => {
  const root = tempRoot('run')
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'lib', 'a.mjs'), 'export const a = 1\n')
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/\n')
  const git = (args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, 'git ' + args.join(' ') + ': ' + result.stderr)
    return result.stdout
  }
  git(['init', '-q'])
  git(['add', '-A'])
  git(['-c', 'user.email=contract@test', '-c', 'user.name=contract', 'commit', '-qm', 'init'])

  const problems = []
  const covered = new Set()

  const idOf = (result) => {
    const data = result.json?.data
    if (data === null || data === undefined) return null
    if (typeof data.id === 'string') return data.id
    if (Array.isArray(data) && typeof data[0]?.id === 'string') return data[0].id
    if (typeof data.decision?.id === 'string') return data.decision.id
    return null
  }

  /** 跑一条命令并校验信封 + data；返回 {code, data} 供后续步骤取 id。 */
  const expect = (key, args) => {
    covered.add(key)
    const result = run(root, args.concat(['--json']))
    if (result.json === null) {
      problems.push(key + '：stdout 不是 JSON（' + JSON.stringify(result.stdout.slice(0, 120)) + '）stderr=' + result.stderr.slice(0, 200))
      return result
    }
    const errors = validateInvocation(key, result.json)
    for (const error of errors) problems.push(key + ' ' + args.join(' ') + ' → ' + error)
    return result
  }

  /** check 族脚本检查：成功路径要外部环境，失败路径的 error 也必须带运行结果五字段。 */
  const expectErrorRun = (key, args, fields = ['check', 'exitCode', 'stdout', 'stderr']) => {
    covered.add(key)
    const result = run(root, args.concat(['--json']))
    assert.equal(result.json?.ok, false, key + ' 期望失败：' + result.stdout)
    // checks.runCheck 的失败载荷带 check/exitCode/stdout/stderr；成功 data 才带 durationMs。
    // 内置检查（gate rules）不跑子进程，所以只有 check/exitCode。
    for (const field of fields) {
      if (Object.hasOwn(result.json.error, field) === false) {
        problems.push(key + ' 的 error 缺少运行结果字段 ' + field)
      }
    }
    if (result.json.error.check !== key.split('.')[1]) {
      problems.push(key + ' 的 error.check 应为 ' + key.split('.')[1] + '，实际 ' + result.json.error.check)
    }
    return result
  }

  expect('init', ['init', '--name', 'contract'])
  expect('status', ['status'])
  expect('state', ['state'])
  expect('aspect', ['aspect', 'list'])
  expect('doctor', ['doctor'])
  expect('backup', ['backup'])

  const expAdded = expect('exp.add', [
    'exp', 'add', '--title', 'T1', '--hypothesis', 'H', '--direction', 'D', '--expected', 'E',
    '--primary-metric', 'M', '--guardrail', 'G', '--falsify', 'F', '--window-days', '7', '--stop-loss', 'S',
  ])
  const expId = idOf(expAdded)
  expect('exp.list', ['exp', 'list'])
  expect('exp.show', ['exp', 'show', expId])
  expect('exp.tree', ['exp', 'tree'])
  expect('exp.review', ['exp', 'review', expId])
  expect('exp.update', ['exp', 'update', expId, '--status', 'confirmed', '--measured', 'm', '--metrics', '{"x":1}'])
  expect('exp.cleanup', ['exp', 'cleanup', expId, '--flag', 'f1'])

  const taskAdded = expect('task.add', ['task', 'add', '--title', 'TK', '--type', 'feat', '--stage', 'implementing'])
  const taskId = idOf(taskAdded)
  expect('task.list', ['task', 'list'])
  expect('task.show', ['task', 'show', taskId])
  expect('task.update', ['task', 'update', taskId, '--notes', 'notes'])
  expect('task.next', ['task', 'next', taskId])
  expect('task.verify', ['task', 'verify', taskId])
  expect('task.normalize', ['task', 'normalize', '--dry-run'])
  expect('task.archive', ['task', 'archive', '--dry-run'])
  expect('task.sweep', ['task', 'sweep', '--dry-run'])
  expect('task.link', ['task', 'link', taskId, '--team', 'B-1'])
  expect('task.unlink', ['task', 'unlink', taskId])

  expect('gate.list', ['gate', 'list'])
  expect('gate.show', ['gate', 'show', 'precommit'])
  expect('gate.add', ['gate', 'add', '--id', 'g1', '--title', 'G', '--phase', 'manual', '--step', 'a=exit 0'])
  expect('gate.update', ['gate', 'update', 'g1', '--enabled', 'false'])
  expect('gate.enable', ['gate', 'enable', 'g1'])
  expect('gate.run', ['gate', 'run', 'g1'])
  expect('gate.run', ['gate', 'run', '--phase', 'manual'])
  expect('gate.logs', ['gate', 'logs', 'g1'])
  expect('gate.disable', ['gate', 'disable', 'g1'])
  expect('gate.rm', ['gate', 'rm', 'g1', '--yes'])

  expect('heartbeat.start', ['heartbeat', 'start', '--session', 's1', '--goal', 'G'])
  expect('heartbeat.update', ['heartbeat', 'update', '--session', 's1', '--status', 'idle'])
  expect('heartbeat.status', ['heartbeat', 'status', '--session', 's1'])
  expect('heartbeat.list', ['heartbeat', 'list', '--all'])
  expect('heartbeat.end', ['heartbeat', 'end', '--session', 's1'])
  expect('heartbeat.rm', ['heartbeat', 'rm', 's1', '--yes'])
  expect('heartbeat.gc', ['heartbeat', 'gc', '--dry-run'])

  const asked = expect('decision.ask', [
    'decision', 'ask', '--question', 'Q', '--kind', 'choice',
    '--option', 'a=A>>i', '--option', 'b=B>>i', '--recommendation', 'a', '--rationale', 'R',
  ])
  const decisionId = asked.json.data.decision.id
  expect('decision.list', ['decision', 'list'])
  expect('decision.show', ['decision', 'show', decisionId])
  expect('decision.answer', ['decision', 'answer', decisionId, '--choice', 'a'])
  const withdrawn = expect('decision.ask', ['decision', 'ask', '--question', 'Q2', '--kind', 'input', '--rationale', 'R'])
  expect('decision.withdraw', ['decision', 'withdraw', withdrawn.json.data.decision.id, '--reason', 'R'])
  expect('decision.gc', ['decision', 'gc', '--dry-run'])

  expect('desc.status', ['desc', 'status'])
  expect('desc.build', ['desc', 'build'])
  expect('desc.show', ['desc', 'show'])
  expect('desc.show', ['desc', 'show', '--graph', 'mermaid'])
  expect('desc.set', ['desc', 'set', '--project-semantics', '这是一个足够长的项目语义描述'])
  expect('desc.plan', ['desc', 'plan', taskId, '--template', 'lib/a.mjs'])
  expect('desc.plan', ['desc', 'plan', taskId, '--input', '{"files":[{"path":"lib/a.mjs","op":"change"}]}'])
  expect('desc.plan', ['desc', 'plan', taskId, '--show'])
  expect('desc.apply', ['desc', 'apply', taskId, '--dry-run'])
  expect('desc.render', ['desc', 'render'])

  expect('check.list', ['check', 'list'])
  expect('check.tasks', ['check', 'tasks'])
  expect('check.experiments', ['check', 'experiments'])
  expect('check.decisions', ['check', 'decisions'])
  expectErrorRun('check.description', ['check', 'description'])
  expectErrorRun('gate.rules', ['gate', 'rules'], ['check', 'exitCode'])
  fs.writeFileSync(path.join(root, 'b.txt'), 'y\n')
  git(['add', 'b.txt'])
  expect('check.staged', ['check', 'staged', '--allow', 'b.txt'])
  expectErrorRun('check.release-baseline', ['check', 'release-baseline', '--marker', 'RELEASE'])
  expectErrorRun('check.state', ['check', 'state'])
  expectErrorRun('check.doc', ['check', 'doc', '--file', 'lib/a.mjs', '--type', 'task'])

  // productize 需要 release 门禁有一次通过运行，且 finished_at 晚于实验进入 confirmed 的时刻。
  run(root, ['gate', 'update', 'release', '--step', 'pass=exit 0', '--json'])
  run(root, ['gate', 'run', 'release', '--force', '--json'])
  const productized = run(root, ['exp', 'productize', expId, '--json'])
  covered.add('exp.productize')
  for (const error of validateInvocation('exp.productize', productized.json)) problems.push('exp.productize → ' + error)
  expect('exp.rm', ['exp', 'rm', expId, '--yes'])
  expect('task.rm', ['task', 'rm', taskId, '--yes'])

  assert.deepEqual(problems, [], '契约形状不符：\n' + problems.join('\n'))

  // 覆盖守卫：SPEC 的每个命令键都被真实执行过一次（正例），否则上面的循环会假绿。
  const spec = specCommandKeys()
  const uncovered = spec.filter((key) => covered.has(key) === false)
  assert.deepEqual(uncovered, [], '这些命令没有真实执行过（覆盖缺口）：' + uncovered.join(', '))
})

// ---------------------------------------------------------------- 更深的 data 路径

/** 直接改一条任务记录（验收/否决指针这类 CLI 没有写入口的字段，测试只能种数据）。 */
function patchTaskRecord(root, id, patch) {
  const file = path.join(root, '.agents', 'tasks', id + '.json')
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  Object.assign(record, patch)
  fs.writeFileSync(file, JSON.stringify(record, null, 1))
}

test('task.verify：带可执行验收时返回执行明细 + verification 回执（通过/失败两种信封）', () => {
  const root = tempRoot('verify')
  initProject(root, { name: 'ver' })
  const node = JSON.stringify(process.execPath)
  const added = run(root, ['task', 'add', '--title', 'V', '--type', 'feat', '--stage', 'implementing', '--json'])
  assert.equal(added.code, 0, added.stderr)
  const id = added.json.data.id
  patchTaskRecord(root, id, { acceptance: [{ cmd: node + ' -e "process.exit(0)"' }] })

  const passed = run(root, ['task', 'verify', id, '--json'])
  assert.equal(passed.code, 0, passed.stderr)
  assert.deepEqual(validateInvocation('task.verify', passed.json), [])
  assert.equal(passed.json.data.ok, true)
  assert.equal(passed.json.data.executed, 1)
  assert.equal(passed.json.data.passed, 1)
  assert.deepEqual(passed.json.data.failed, [])
  assert.equal(passed.json.data.repair, null, '全通过时 repair 为 null')
  assert.equal(passed.json.data.verification.ok, true)
  assert.equal(typeof passed.json.data.verification.signature, 'string')
  assert.deepEqual(Object.keys(passed.json.data.steps[0]).sort(), [
    'durationMs', 'exit', 'index', 'kind', 'ok', 'repair', 'tail', 'target',
  ])

  patchTaskRecord(root, id, { acceptance: [{ cmd: node + ' -e "process.exit(3)"' }] })
  const failed = run(root, ['task', 'verify', id, '--json'])
  assert.equal(failed.code, 1, '验收失败按 check-failed 退 1')
  assert.equal(failed.json.ok, false)
  assert.equal(failed.json.error.code, 'check-failed')
  // 失败时验收明细挂在 error.verification（信封的 data 分支不出现）。
  assert.deepEqual(validateCommandData('task.verify', failed.json.error.verification), [])
  assert.equal(failed.json.error.verification.ok, false)
  assert.deepEqual(failed.json.error.verification.failed, ['cmd:' + node + ' -e "process.exit(3)"'])
})

test('decision.answer：否决决策答 modify 后自动把任务退回 queued-analysis（data 仍是决策记录）', () => {
  const root = tempRoot('veto')
  initProject(root, { name: 'veto' })
  const added = run(root, ['task', 'add', '--title', '被否决的任务', '--type', 'feat', '--stage', 'analyzing', '--json'])
  assert.equal(added.code, 0, added.stderr)
  const taskId = added.json.data.id
  const asked = run(root, [
    'decision', 'ask', '--question', '要修改后重新入栈，还是移到已完成？', '--kind', 'choice',
    '--option', 'modify=修改>>回到 queued-analysis 重新分析',
    '--option', 'delete=删除>>阶段置 done，交给 7 天归档',
    '--recommendation', 'modify', '--rationale', '分析期否决', '--json',
  ])
  assert.equal(asked.code, 0, asked.stderr)
  const decisionId = asked.json.data.decision.id
  // 种上 core 侧的否决指针：CLI 没有写 veto/decision 字段的入口（由 flow_veto 工具写）。
  patchTaskRecord(root, taskId, {
    decision: decisionId,
    veto: { by: 'analysis', reason: '测试否决', at: '2026-11-12T20:00:00+08:00' },
  })

  const answered = run(root, ['decision', 'answer', decisionId, '--choice', 'modify', '--json'])
  assert.equal(answered.code, 0, answered.stderr)
  assert.deepEqual(validateInvocation('decision.answer', answered.json), [])
  assert.equal(answered.json.data.status, 'answered')
  assert.equal(answered.json.data.answer.choice, 'modify')
  assert.equal(Object.hasOwn(answered.json.data, 'vetoApplied'), false, '自动应用成功时不追加 vetoApplied')

  const task = run(root, ['task', 'show', taskId, '--json'])
  assert.equal(task.code, 0, task.stderr)
  assert.equal(task.json.data.stage, 'queued-analysis', 'modify 必须把任务退回分析队列')
  assert.equal(task.json.data.decision, null, '答完清空 decision 指针')
  assert.equal(task.json.data.veto.reason, '测试否决', 'veto 是历史，答案不清它')
})

test('字段出现条件：变体路径的形状（archive closed / heartbeat createdTask / desc 变体 / productize 幂等）', () => {
  const root = tempRoot('variants')
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'lib', 'a.mjs'), 'export const a = 1\n')
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/\n')
  const git = (args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, 'git ' + args.join(' ') + ': ' + result.stderr)
  }
  git(['init', '-q'])
  git(['add', '-A'])
  git(['-c', 'user.email=contract@test', '-c', 'user.name=contract', 'commit', '-qm', 'init'])
  const init = run(root, ['init', '--name', 'var', '--json'])
  assert.equal(init.code, 0, init.stderr)

  // 1) task.archive：archiveAfterDays=0 → closed:true 且 cutoff=null（不归档时没有阈值时间）
  const flowFile = path.join(root, '.agents', 'flow', 'flow.json')
  const manifest = JSON.parse(fs.readFileSync(flowFile, 'utf8'))
  manifest.tasks.archiveAfterDays = 0
  fs.writeFileSync(flowFile, JSON.stringify(manifest, null, 1))
  const closed = run(root, ['task', 'archive', '--json'])
  assert.equal(closed.code, 0, closed.stderr)
  assert.deepEqual(validateInvocation('task.archive', closed.json), [])
  assert.equal(closed.json.data.closed, true)
  assert.equal(closed.json.data.cutoff, null)

  // 2) heartbeat.start --task <显式任务>：createdTask 键存在但为 null（只在自动建卡时有值）
  const task = run(root, ['task', 'add', '--title', 'HT', '--type', 'feat', '--json'])
  const taskId = task.json.data.id
  const started = run(root, ['heartbeat', 'start', '--session', 'vs', '--task', taskId, '--json'])
  assert.equal(started.code, 0, started.stderr)
  assert.deepEqual(validateInvocation('heartbeat.start', started.json), [])
  assert.equal(Object.hasOwn(started.json.data, 'createdTask'), true, 'createdTask 键恒在')
  assert.equal(started.json.data.createdTask, null)

  // 3) desc 变体：set --input 单补丁 → {records, changed}；show --path 命中 → 文件记录本身
  const built = run(root, ['desc', 'build', '--json'])
  assert.equal(built.code, 0, built.stderr)
  const patch = JSON.stringify({ path: 'lib/a.mjs', semantics: '这是一个足够长的文件语义描述文本' })
  const setResult = run(root, ['desc', 'set', '--input', patch, '--json'])
  assert.equal(setResult.code, 0, setResult.stderr)
  assert.deepEqual(validateInvocation('desc.set', setResult.json), [])
  assert.equal(setResult.json.data.changed, true)
  assert.equal(Array.isArray(setResult.json.data.records), true)
  const shown = run(root, ['desc', 'show', '--path', 'lib/a.mjs', '--json'])
  assert.equal(shown.code, 0, shown.stderr)
  assert.deepEqual(validateInvocation('desc.show', shown.json), [])
  assert.equal(shown.json.data.path, 'lib/a.mjs')
  assert.equal(typeof shown.json.data.semantics, 'string')

  // 4) exp.productize 幂等：第二次 already:true（首调 already:false）
  const exp = run(root, ['exp', 'add', '--title', 'T1', '--hypothesis', 'H', '--direction', 'D', '--expected', 'E',
    '--primary-metric', 'M', '--guardrail', 'G', '--falsify', 'F', '--window-days', '7', '--stop-loss', 'S', '--json'])
  const expId = exp.json.data.id
  run(root, ['exp', 'update', expId, '--status', 'confirmed', '--measured', 'm', '--metrics', '{"x":1}', '--json'])
  run(root, ['gate', 'update', 'release', '--step', 'pass=exit 0', '--json'])
  run(root, ['gate', 'run', 'release', '--force', '--json'])
  const first = run(root, ['exp', 'productize', expId, '--json'])
  assert.equal(first.code, 0, first.stderr)
  assert.deepEqual(validateInvocation('exp.productize', first.json), [])
  assert.equal(first.json.data.already, false)
  const second = run(root, ['exp', 'productize', expId, '--json'])
  assert.equal(second.code, 0, second.stderr)
  assert.deepEqual(validateInvocation('exp.productize', second.json), [])
  assert.equal(second.json.data.already, true, '重复产品化必须幂等')

  // 5) gate add --allow-unknown-expect：落盘记录仍过 shape，且 unknown expect 不炸
  const gate = run(root, ['gate', 'add', '--id', 'uk', '--title', 'UK', '--phase', 'manual', '--step', 'x=exit:1', '--allow-unknown-expect', '--json'])
  assert.equal(gate.code, 0, gate.stderr)
  assert.deepEqual(validateInvocation('gate.add', gate.json), [])
})

test('aspect 锁命令面：list/acquire/renew/release/sweep 五种 data 形状 + pending 与惰性清扫', () => {
  const root = tempRoot('aspect')
  // 关键：夹具必须像真实仓库一样有 docs/module-domain.json 的 aspects 定义。
  // 没有定义时锁行是「裸投影」，正是这个差异让上一次漏登记（定义投影会多字段）。
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'lib', 'stage.mjs'), 'export const stage = 1\n')
  fs.writeFileSync(
    path.join(root, 'docs', 'module-domain.json'),
    JSON.stringify({
      schema: 1,
      aspects: {
        'state-machine': { title: '任务状态机', files: ['lib/stage.mjs'], ownerRole: 'tasks-owner' },
      },
      modules: {},
    }),
  )
  initProject(root, { name: 'asp' })
  const lockFile = (aspect) => path.join(root, '.agents', 'aspect-locks', aspect + '.json')

  // 1) acquire 成功：锁投影（owner/files/state/releasable/...），files 来自 aspect 定义
  const acquired = run(root, ['aspect', 'acquire', '--aspect', 'state-machine', '--session', 's1', '--json'])
  assert.equal(acquired.code, 0, acquired.stderr)
  assert.deepEqual(validateInvocation('aspect', acquired.json), [])
  assert.equal(acquired.json.data.acquired, true)
  assert.deepEqual(acquired.json.data.lock.files, ['lib/stage.mjs'])
  assert.equal(acquired.json.data.lock.state, 'held')
  assert.equal(acquired.json.data.lock.owner.session, 's1')

  // 一次性 CLI 进程结束后占用方 pid 就死了；把 pid 改成测试进程（活着的），
  // 才能稳定验证「被活着占用方挡住」的 pending 分支。
  const lock = JSON.parse(fs.readFileSync(lockFile('state-machine'), 'utf8'))
  lock.owner.pid = process.pid
  fs.writeFileSync(lockFile('state-machine'), JSON.stringify(lock, null, 1))

  // 2) list：定义投影 + 锁 + 计数（held 1）；没有 module-domain 时无 source、无 swept
  const listed = run(root, ['aspect', 'list', '--json'])
  assert.equal(listed.code, 0, listed.stderr)
  assert.deepEqual(validateInvocation('aspect', listed.json), [])
  assert.equal(listed.json.data.counts.held, 1)
  assert.equal(listed.json.data.counts.aspects, 1)
  assert.equal(listed.json.data.source, 'docs/module-domain.json')
  assert.deepEqual(listed.json.data.aspects.map((item) => item.title), ['任务状态机'])
  assert.equal(listed.json.data.locks.length, 1)
  assert.equal(listed.json.data.locks[0].aspect, 'state-machine')
  assert.equal(Object.hasOwn(listed.json.data, 'swept'), false)

  // 3) acquire 被活着占用方挡住：pending 分支（不阻断，waitedMs 是数字）
  const pending = run(root, ['aspect', 'acquire', '--aspect', 'state-machine', '--session', 's2', '--wait', '0', '--json'])
  assert.equal(pending.code, 0, pending.stderr)
  assert.deepEqual(validateInvocation('aspect', pending.json), [])
  assert.equal(pending.json.data.acquired, false)
  assert.equal(pending.json.data.holder.owner.session, 's1')
  assert.equal(typeof pending.json.data.waitedMs, 'number')

  // 4) renew 两种分支：非占用方 not-owner；占用方成功带新 lock
  const renewFail = run(root, ['aspect', 'renew', '--aspect', 'state-machine', '--session', 's2', '--json'])
  assert.equal(renewFail.code, 0, renewFail.stderr)
  assert.deepEqual(validateInvocation('aspect', renewFail.json), [])
  assert.equal(renewFail.json.data.renewed, false)
  assert.equal(renewFail.json.data.reason, 'not-owner')
  const renewOk = run(root, ['aspect', 'renew', '--aspect', 'state-machine', '--session', 's1', '--ttl', '60', '--json'])
  assert.equal(renewOk.code, 0, renewOk.stderr)
  assert.deepEqual(validateInvocation('aspect', renewOk.json), [])
  assert.equal(renewOk.json.data.renewed, true)
  assert.equal(renewOk.json.data.lock.ttlSeconds, 60)

  // 5) release：force 分支带 forced + 审计 reason；释放后再释放是 no-lock
  const forced = run(root, [
    'aspect', 'release', '--aspect', 'state-machine', '--session', 's2', '--force', '--reason', '测试强制释放', '--json',
  ])
  assert.equal(forced.code, 0, forced.stderr)
  assert.deepEqual(validateInvocation('aspect', forced.json), [])
  assert.equal(forced.json.data.released, true)
  assert.equal(forced.json.data.forced, true)
  assert.equal(forced.json.data.aspect, 'state-machine')
  const releaseAgain = run(root, ['aspect', 'release', '--aspect', 'state-machine', '--session', 's1', '--json'])
  assert.equal(releaseAgain.code, 0, releaseAgain.stderr)
  assert.deepEqual(validateInvocation('aspect', releaseAgain.json), [])
  assert.equal(releaseAgain.json.data.released, false)
  assert.equal(releaseAgain.json.data.reason, 'no-lock')

  // 6) 惰性清扫：CLI acquire 留下的死占用方锁会被下一次 list 回收，并带可选 swept
  const dead = run(root, ['aspect', 'acquire', '--aspect', 'ghost', '--session', 's9', '--json'])
  assert.equal(dead.code, 0, dead.stderr)
  const swept = run(root, ['aspect', 'list', '--json'])
  assert.equal(swept.code, 0, swept.stderr)
  assert.deepEqual(validateInvocation('aspect', swept.json), [])
  assert.deepEqual(swept.json.data.swept, ['ghost'])
  assert.deepEqual(swept.json.data.locks, [])

  // 7) sweep：{root,dir,dryRun,released[],kept[]}（需要 --aspect 与 --session，当前实现如此）
  const swept2 = run(root, ['aspect', 'sweep', '--aspect', 'ghost', '--session', 's1', '--dry-run', '--json'])
  assert.equal(swept2.code, 0, swept2.stderr)
  assert.deepEqual(validateInvocation('aspect', swept2.json), [])
  assert.equal(swept2.json.data.dryRun, true)
  assert.deepEqual(swept2.json.data.released, [])
  assert.deepEqual(swept2.json.data.kept, [])
})

// ---------------------------------------------------------------- 自证有效

test('自证：改名/加字段/错类型/错枚举/错版本都必须被校验器抓住', () => {
  const root = tempRoot('selfproof')
  initProject(root, { name: 'sp' })
  const payload = run(root, ['status', '--json']).json
  assert.deepEqual(validateInvocation('status', payload), [], '基线必须先通过')

  const clone = () => JSON.parse(JSON.stringify(payload))

  // 1) 字段改名：真实输出里的 initialized 改成 initialised
  const renamed = clone()
  renamed.data.initialised = renamed.data.initialized
  delete renamed.data.initialized
  const renameErrors = validateCommandData('status', renamed.data)
  assert.ok(
    renameErrors.some((error) => error.includes('data.initialized') && error.includes('缺少必填字段')),
    '字段改名必须报缺失：' + renameErrors.join('；'),
  )
  assert.ok(
    renameErrors.some((error) => error.includes('data.initialised') && error.includes('未登记字段')),
    '字段改名必须报未登记：' + renameErrors.join('；'),
  )

  // 2) 多出未登记字段（字段增删必须同步契约）
  const extended = clone()
  extended.data.surprise = 1
  assert.ok(validateCommandData('status', extended.data).some((error) => error.includes('data.surprise')))

  // 3) 类型改变
  const retyped = clone()
  retyped.data.schema = '2'
  assert.ok(validateCommandData('status', retyped.data).some((error) => error.includes('data.schema')))

  // 4) 枚举越界（任务状态）
  const badEnum = { ...payload.data.recent.tasks[0] }
  const taskPayload = run(root, ['task', 'add', '--title', 'x', '--type', 'feat', '--json']).json
  assert.deepEqual(validateInvocation('task.add', taskPayload), [])
  const badTask = JSON.parse(JSON.stringify(taskPayload))
  badTask.data.status = 'doing'
  assert.ok(validateCommandData('task.add', badTask.data).some((error) => error.includes('不在枚举')))

  // 5) 信封版本不符（前端据此判断兼容性）
  const future = clone()
  future.schemaVersion = CLI_CONTRACT_VERSION + 1
  assert.ok(validateEnvelope(future).some((error) => error.includes('schemaVersion')))

  // 6) 信封顶层多字段
  const extra = clone()
  extra.meta = {}
  assert.ok(validateEnvelope(extra).some((error) => error.includes('未登记字段')))

  // 7) 失败信封带 data / 成功信封带 error 都是违约
  const both = clone()
  both.error = { code: 'usage', message: 'x' }
  assert.ok(validateEnvelope(both).some((error) => error.includes('不得带 error')))
  const failure = { schemaVersion: CLI_CONTRACT_VERSION, ok: false, data: {}, warnings: [] }
  assert.ok(validateEnvelope(failure).some((error) => error.includes('失败信封')))

  // 8) 未登记的命令键
  assert.ok(validateCommandData('nope.command', {}).some((error) => error.includes('未登记')))
})

test('契约文档：contractDocument() 可序列化且与注册表一致', () => {
  const doc = contractDocument()
  const text = JSON.stringify(doc)
  assert.equal(typeof text, 'string')
  const parsed = JSON.parse(text)
  assert.equal(parsed.schemaVersion, CLI_CONTRACT_VERSION)
  assert.deepEqual(Object.keys(parsed.commands).sort(), commandKeys())
  for (const key of Object.keys(parsed.records)) {
    assert.equal(typeof parsed.records[key].kind, 'string', '记录形状 ' + key + ' 必须是合法形状')
  }
  for (const [name, shape] of Object.entries(parsed.commands)) {
    assert.ok(shape !== null && typeof shape === 'object', name + ' 的形状必须是对象')
    assert.equal(typeof shape.kind, 'string', name + ' 的形状必须有 kind')
  }
  // 信封字段集与契约文件一致
  assert.deepEqual(parsed.envelope.success.shape, ['schemaVersion', 'ok', 'data', 'warnings'])
  assert.deepEqual(parsed.envelope.failure.shape, ['schemaVersion', 'ok', 'error', 'warnings'])
})

test('信封规范化：canonicalEnvelope 补版本并把 warnings 归成数组', () => {
  const ok = canonicalEnvelope({ ok: true, data: { a: 1 }, warnings: ['w'] })
  assert.deepEqual(Object.keys(ok), ['schemaVersion', 'ok', 'data', 'warnings'])
  assert.equal(ok.schemaVersion, CLI_CONTRACT_VERSION)
  const fixed = canonicalEnvelope({ ok: false, error: { code: 'usage', message: 'm' } })
  assert.deepEqual(fixed.warnings, [])
  // 非信封载荷原样返回（emitJson 仍是通用出口）
  const raw = { anything: 1 }
  assert.equal(canonicalEnvelope(raw), raw)
})

test('契约注册表自检：每个形状合法、ref 可解析、必填字段都存在', () => {
  const KINDS = new Set(['any', 'string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'ref', 'union'])
  const seenRefs = new Set()
  const problems = []
  const walk = (shape, path) => {
    if (shape === null || typeof shape !== 'object') {
      problems.push(path + '：形状不是对象')
      return
    }
    if (KINDS.has(shape.kind) === false) {
      problems.push(path + '：未知 kind ' + JSON.stringify(shape.kind))
      return
    }
    if (shape.kind === 'ref') {
      if (typeof shape.name !== 'string' || Object.hasOwn(RECORD_SHAPES, shape.name) === false) {
        problems.push(path + '：ref 指向未登记的记录 ' + JSON.stringify(shape.name))
      } else {
        seenRefs.add(shape.name)
      }
      return
    }
    if (shape.kind === 'array') {
      walk(shape.items, path + '[]')
      return
    }
    if (shape.kind === 'union') {
      if (Array.isArray(shape.of) === false || shape.of.length === 0) problems.push(path + '：union 没有分支')
      else shape.of.forEach((branch, index) => walk(branch, path + '|' + index))
      return
    }
    if (shape.kind === 'object') {
      if (shape.fields === null || typeof shape.fields !== 'object') {
        problems.push(path + '：object 缺 fields')
        return
      }
      for (const [name, field] of Object.entries(shape.fields)) walk(field, path + '.' + name)
      const required = Array.isArray(shape.required) ? shape.required : Object.keys(shape.fields)
      for (const name of required) {
        if (Object.hasOwn(shape.fields, name) === false) problems.push(path + '：required 里的 ' + name + ' 没有登记形状')
      }
      if (new Set(required).size !== required.length) problems.push(path + '：required 有重复项')
      return
    }
    if (shape.enum !== undefined) {
      if (Array.isArray(shape.enum) === false || shape.enum.length === 0) problems.push(path + '：enum 必须是非空数组')
    }
  }
  for (const [key, shape] of Object.entries(DATA_SHAPES)) walk(shape, 'commands.' + key)
  for (const [name, shape] of Object.entries(TOOL_SHAPES)) walk(shape, 'toolShapes.' + name)
  for (const [name, shape] of Object.entries(RECORD_SHAPES)) walk(shape, 'records.' + name)
  assert.deepEqual(problems, [], '契约注册表自身不合法：\n' + problems.join('\n'))

  // 记录形状都得被至少一条命令引用，否则是死形状（改了也没人校验）。
  const unreferenced = Object.keys(RECORD_SHAPES).filter((name) => seenRefs.has(name) === false)
  assert.deepEqual(unreferenced, [], '这些记录形状没有被任何命令引用：' + unreferenced.join(', '))
})

// ---------------------------------------------------------------- 人类/机器分工

test('--json 与人类输出分工：默认输出不掺信封，--json 不掺人类文案', () => {
  const root = tempRoot('split')
  initProject(root, { name: 'split' })
  const human = run(root, ['status'])
  assert.equal(human.code, 0)
  assert.notEqual(human.stdout.trim().startsWith('{'), true, '人类输出不得以 JSON 信封开头')
  assert.equal(human.stdout.includes('"schemaVersion"'), false)

  const machine = run(root, ['status', '--json'])
  assert.equal(machine.code, 0)
  assert.equal(machine.stderr, '')
  const lines = machine.stdout.trimEnd().split('\n')
  assert.equal(lines.length, 1, '--json 只允许一行 JSON')
  assert.doesNotThrow(() => JSON.parse(lines[0]))
})

test('形状校验器：union / ref / any 的边界行为', () => {
  // union 取第一个匹配分支；ref 解析记录形状；any 放行一切
  const shape = { kind: 'union', of: [{ kind: 'object', fields: { a: { kind: 'string' } }, required: ['a'] }, { kind: 'null' }] }
  assert.deepEqual(validateShape(shape, null, '$'), [])
  assert.deepEqual(validateShape(shape, { a: 'x' }, '$'), [])
  assert.notDeepEqual(validateShape(shape, { a: 1 }, '$'), [])
  assert.deepEqual(validateShape({ kind: 'any' }, { whatever: [1, 2] }, '$'), [])
  assert.notDeepEqual(validateShape({ kind: 'ref', name: 'nope' }, {}, '$'), [])
  // 记录形状递归引用（status 里的 recent.tasks）能被解析
  const statusShape = DATA_SHAPES.status
  assert.deepEqual(
    validateShape(statusShape.fields.counts, [1, 2, 3], '$.data.counts').length > 0,
    true,
    '数组不是 object，必须报错',
  )
})
