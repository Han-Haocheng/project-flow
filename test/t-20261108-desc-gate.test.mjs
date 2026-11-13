// T-20261108 · D3：描述阶段门（`assertDescriptionGate` + `updateTask` 集成）。
//
// 门禁是整套描述台账唯一的强制点，也是唯一「会让现有 30+ 处 updateTask 调用
// 变红」的改动。所以本文件先钉住那三条豁免（`auto` 无记录 / 子任务 /
// `source:'internal'`），再钉目标边的允许与拒绝各一例——只测拒绝会让一个「永远
// 报错」的实现看起来正确，只测允许会让一个「永远放行」的实现看起来正确。
//
// 覆盖：
//   - 三条目标边（queued-implementation / queued-review / done）的允许与拒绝；
//   - `enforce` 三态（auto 有/无记录、on、off）与 `enabled:false`；
//   - 豁免：子任务、`source:'internal'`、只写 status 的补丁；
//   - 存量盘上无 `stage` 的记录（`from` 必须走 `projectTaskStage` 投影）；
//   - `done` 的测试证据时间窗（`implemented_at` 早/晚）；
//   - `unplanned-change`（临时 git 仓库）；
//   - 失败消息的形状（最多 3 条 + 总数 + 修复命令）。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  FlowError,
  addTask,
  applyDescriptionPlan,
  assertDescriptionGate,
  buildDescription,
  checkDescription,
  getDescriptionFile,
  getDescriptionPlan,
  getTask,
  initProject,
  listDescriptionFiles,
  loadContract,
  saveContract,
  setDescriptionFile,
  setDescriptionPlan,
  updateTask,
} from '../lib/core.mjs'
import {
  DESCRIPTION_GATE_STAGES,
  DESCRIPTION_STAGE_POLICY,
  descriptionApplyStages,
  descriptionPlanStages,
} from '../lib/description/records.mjs'
import { STAGE_IDS } from '../lib/stage.mjs'

const PROJECT_SEMANTICS = '项目语义：描述阶段门的测试工程。'
const NOW = '2026-11-08T12:00:00+08:00'
const EARLIER = '2026-11-08T11:00:00+08:00'
const LATER = '2026-11-08T13:00:00+08:00'
const NEW_SEMANTICS = '这一段新的语义说明足够长并且描述职责。'

const SOURCES = {
  'lib/a.mjs': '// ---- 契约\nexport function alpha() {}\n',
  'lib/b.mjs': "import { alpha } from './a.mjs'\nexport function beta() { return alpha() }\n",
}

const TEMP_ROOTS = []
after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

// ------------------------------------------------------------------ helpers

function tempRoot(label = 'desc-gate') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `project-flow-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function writeFile(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  return absolute
}

/** 空台账工程（`flow init` 不种门禁 + 写源文件），**不** build 描述。 */
function bareProject(label, files = SOURCES) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true })
  for (const [relative, content] of Object.entries(files)) writeFile(root, relative, content)
  return { root, contract: loadContract(root).contract }
}

function setProjectSemantics(root, text = PROJECT_SEMANTICS) {
  const file = path.join(root, '.agents', 'description', 'project.json')
  const project = JSON.parse(fs.readFileSync(file, 'utf8'))
  project.semantics = text
  fs.writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`)
}

/**
 * `auto + 有记录` 的工程：build 后把每条记录的文件/模块语义与项目语义都填好，
 * 断言 `checkDescription` 确实全绿——门禁的「允许」用例必须建立在一个真绿的
 * 台账上，否则拒绝可能来自任何一条无关的漂移。
 */
function describedProject(label, files = SOURCES) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true })
  for (const [relative, content] of Object.entries(files)) writeFile(root, relative, content)
  const contract = loadContract(root).contract
  buildDescription(root, contract)
  const patches = listDescriptionFiles(root, contract).map((record) => ({
    path: record.path,
    semantics: `文件语义：${record.path} 在门禁工程里的职责。`,
    modules: (Array.isArray(record.modules) ? record.modules : []).map((module) => ({
      id: module.id,
      semantics: `模块语义：${module.id} 的职责说明。`,
    })),
  }))
  if (patches.length > 0) setDescriptionFile(root, contract, patches)
  setProjectSemantics(root)
  const clean = checkDescription(root, contract)
  assert.equal(clean.ok, true, `夹具必须全绿：${JSON.stringify(clean.failed)}`)
  return { root, contract }
}

function expectGateError(fn, stage, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FlowError, `应抛 FlowError，实际 ${error?.name}: ${error?.message}`)
    assert.equal(error.code, 'invalid', `阶段门必须是 invalid（exit 2），实际 ${error.code}：${error.message}`)
    assert.match(error.message, new RegExp(`^description gate: ${stage}: `), error.message)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

/** 写窗口/形状类的 invalid（不是阶段门，消息不带 `description gate:` 前缀）。 */
function expectInvalid(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FlowError, `应抛 FlowError，实际 ${error?.name}: ${error?.message}`)
    assert.equal(error.code, 'invalid', `应为 invalid（exit 2），实际 ${error.code}：${error.message}`)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

function stageOf(root, contract, id) {
  return getTask(root, contract, id).stage
}

function writeGateLog(root, gateId, finishedAt, ok) {
  const dir = path.join(root, '.agents/flow/logs', gateId)
  fs.mkdirSync(dir, { recursive: true })
  const record = {
    gate: gateId,
    title: gateId,
    started_at: finishedAt,
    finished_at: finishedAt,
    durationMs: 1,
    ok,
    steps: [],
  }
  fs.writeFileSync(path.join(dir, `run-${finishedAt.replace(/[:+]/g, '-')}.json`), `${JSON.stringify(record, null, 2)}\n`)
}

function clearGateLogs(root, gateId) {
  fs.rmSync(path.join(root, '.agents/flow/logs', gateId), { recursive: true, force: true })
}

/** 存量任务记录：盘上**没有** `stage`（`from` 必须靠读投影算出来）。 */
function writeLegacyTask(root, id, status = 'active') {
  const record = {
    schema: 1,
    id,
    title: '存量任务',
    type: 'feat',
    status,
    parent: null,
    owner: '',
    scope: { allow: [], deny: [] },
    acceptance: [],
    checkpoints: [],
    commits: [],
    notes: '',
    created_at: NOW,
    updated_at: NOW,
  }
  const dir = path.join(root, '.agents', 'tasks')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/** 直接写一条带 `stage` 的任务记录：把卡「放到」任意阶段（不经阶段机/门禁）。 */
function writeStagedTask(root, taskId, stage) {
  const record = {
    schema: 1,
    id: taskId,
    title: `策略表用例 ${stage}`,
    type: 'feat',
    status: 'active',
    stage,
    parent: null,
    owner: '',
    scope: { allow: [], deny: [] },
    acceptance: [],
    checkpoints: [],
    commits: [],
    notes: '',
    created_at: NOW,
    updated_at: NOW,
  }
  const dir = path.join(root, '.agents', 'tasks')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${taskId}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

function writePlanFile(root, taskId, plan) {
  const dir = path.join(root, '.agents', 'description', 'tasks')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${taskId}.json`), `${JSON.stringify(plan, null, 2)}\n`)
}

// ------------------------------------------------------------------- git

function hasGit() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
}

function gitRun(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'flow',
      GIT_AUTHOR_EMAIL: 'flow@example.com',
      GIT_COMMITTER_NAME: 'flow',
      GIT_COMMITTER_EMAIL: 'flow@example.com',
    },
  })
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败：${result.stderr}`)
  return String(result.stdout ?? '').trim()
}

// ======================================================= 豁免一：auto 无记录

test('auto + 无记录：三条目标边全部放行（守住现有大量 updateTask 调用）', () => {
  const { root, contract } = bareProject('gate-auto-empty')
  const task = addTask(root, contract, { title: '空台账', type: 'feat' })
  for (const stage of ['queued-analysis', 'analyzing', 'queued-implementation', 'implementing', 'queued-review', 'reviewing', 'done']) {
    assert.equal(updateTask(root, contract, task.id, { stage }).stage, stage)
  }
  // 没建描述 → 一次 build 都不该被门禁读到。
  assert.equal(fs.existsSync(path.join(root, '.agents/description/files')), false)
})

// ================================================= 目标边：queued-implementation

test('queued-implementation：auto + 有记录 + 无计划 → 拒绝，且盘上零残留', () => {
  const { root, contract } = describedProject('gate-qi-noplan')
  /* 直接建在 analyzing：created → analyzing 不是合约边，本卡只接管 update 的写入。 */
  const task = addTask(root, contract, { title: '无计划', type: 'feat', stage: 'analyzing' })

  expectGateError(
    () => updateTask(root, contract, task.id, { stage: 'queued-implementation' }),
    'queued-implementation',
    /plan-missing.*flow desc plan/
  )
  // 门禁在 writeJsonAtomic 之前抛：阶段没有半截写入。
  assert.equal(stageOf(root, contract, task.id), 'analyzing')
})

test('queued-implementation：合法计划放行；files 为空（且无 noSemanticChange）拒绝', () => {
  const { root, contract } = describedProject('gate-qi-plan')
  const task = addTask(root, contract, { title: '计划形状', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, { files: [{ path: 'lib/a.mjs', op: 'change', semantics: NEW_SEMANTICS }] })
  assert.equal(updateTask(root, contract, task.id, { stage: 'queued-implementation' }).stage, 'queued-implementation')

  // 手写一个「files 空且没声明无语义变更」的计划 → 形状不合法。
  const other = addTask(root, contract, { title: '坏计划', type: 'feat', stage: 'analyzing' })
  const plan = getDescriptionPlan(root, contract, task.id)
  writePlanFile(root, other.id, { ...plan, task: other.id, files: [], noSemanticChange: false, reason: '' })
  expectGateError(
    () => updateTask(root, contract, other.id, { stage: 'queued-implementation' }),
    'queued-implementation',
    /plan-invalid/
  )

  // noSemanticChange + 非空 reason 的等价路径必须放行。
  const third = addTask(root, contract, { title: '无变化', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, third.id, { noSemanticChange: true, reason: '只改注释' })
  assert.equal(updateTask(root, contract, third.id, { stage: 'queued-implementation' }).stage, 'queued-implementation')
})

test('queued-implementation：enforce=off 时不看计划；enabled:false 一律放行', () => {
  const { root, contract } = describedProject('gate-qi-off')
  const off = saveContract(root, { ...contract, description: { ...contract.description, enforce: 'off' } })
  const task = addTask(root, off, { title: 'off', type: 'feat', stage: 'analyzing' })
  assert.equal(updateTask(root, off, task.id, { stage: 'queued-implementation' }).stage, 'queued-implementation')

  const disabled = saveContract(root, {
    ...off,
    description: { ...off.description, enforce: 'on', enabled: false },
  })
  const second = addTask(root, disabled, { title: 'disabled', type: 'feat', stage: 'analyzing' })
  assert.equal(updateTask(root, disabled, second.id, { stage: 'queued-implementation' }).stage, 'queued-implementation')
})

test('enforce=on：台账里一条记录都没有也照样约束（与 auto 的区别）', () => {
  const { root, contract } = bareProject('gate-on-empty')
  const strict = saveContract(root, { ...contract, description: { ...contract.description, enforce: 'on' } })
  const task = addTask(root, strict, { title: 'on 空台账', type: 'feat', stage: 'analyzing' })
  expectGateError(
    () => updateTask(root, strict, task.id, { stage: 'queued-implementation' }),
    'queued-implementation',
    /plan-missing/
  )
})

test('enforce=auto 两态：无记录放行、有记录拦截（同一段调用序列）', () => {
  const { root, contract } = bareProject('gate-auto-two')
  const task = addTask(root, contract, { title: 'auto 两态', type: 'feat', stage: 'analyzing' })
  // 无记录 → 放行。
  assert.equal(updateTask(root, contract, task.id, { stage: 'queued-implementation' }).stage, 'queued-implementation')

  // 造出记录之后，同一条边就要看计划了。
  buildDescription(root, contract)
  const second = addTask(root, contract, { title: 'auto 两态二', type: 'feat', stage: 'analyzing' })
  expectGateError(
    () => updateTask(root, contract, second.id, { stage: 'queued-implementation' }),
    'queued-implementation',
    /plan-missing/
  )
})

// ========================================================= 目标边：queued-review

test('queued-review：计划还没 apply → 拒绝；apply 且台账全绿 → 放行', () => {
  const { root, contract } = describedProject('gate-qr')
  const task = addTask(root, contract, { title: '待审查', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: NEW_SEMANTICS }],
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })

  expectGateError(
    () => updateTask(root, contract, task.id, { stage: 'queued-review' }),
    'queued-review',
    /plan-unrealized.*flow desc apply/
  )
  assert.equal(stageOf(root, contract, task.id), 'implementing')

  applyDescriptionPlan(root, contract, task.id, { now: NOW })
  assert.equal(updateTask(root, contract, task.id, { stage: 'queued-review' }).stage, 'queued-review')
})

test('queued-review：失败消息最多 3 条 + 总数 + 修复命令', () => {
  const files = {
    'lib/a.mjs': 'export function alpha() {}\n',
    'lib/b.mjs': 'export function beta() {}\n',
    'lib/c.mjs': 'export function gamma() {}\n',
    'lib/d.mjs': 'export function delta() {}\n',
  }
  const { root, contract } = describedProject('gate-qr-many', files)
  const task = addTask(root, contract, { title: '多条失败', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, {
    files: Object.keys(files).map((relative) => ({ path: relative, op: 'change', semantics: NEW_SEMANTICS })),
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })

  let message = ''
  try {
    updateTask(root, contract, task.id, { stage: 'queued-review' })
  } catch (error) {
    message = error.message
  }
  // 排序按 path：计划状态项（`.`）在前，其后是逐个文件的未落地项。
  assert.match(
    message,
    /^description gate: queued-review: plan-unrealized \. plan-unrealized lib\/a\.mjs plan-unrealized lib\/b\.mjs /,
    message
  )
  assert.match(message, /…（共 5 项）/, message)
  assert.match(message, /— flow desc apply /, message)
  // 只展示前 3 条：第 4 条路径不应出现在前半段。
  const head = message.split('…（共')[0]
  assert.equal(head.split('plan-unrealized').length - 1, 3, head)
})

// =============================================================== 目标边：done

test('done：没有测试证据 → 拒绝；补一条晚于 implemented_at 的绿记录 → 放行', () => {
  const { root, contract } = describedProject('gate-done')
  const task = addTask(root, contract, { title: '收口', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: NEW_SEMANTICS }],
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })
  applyDescriptionPlan(root, contract, task.id, { now: NOW })
  updateTask(root, contract, task.id, { stage: 'queued-review' })
  updateTask(root, contract, task.id, { stage: 'reviewing' })

  expectGateError(
    () => updateTask(root, contract, task.id, { stage: 'done' }),
    'done',
    /tests-missing.*flow gate run tests/
  )
  assert.equal(stageOf(root, contract, task.id), 'reviewing')

  writeGateLog(root, 'tests', LATER, true)
  assert.equal(updateTask(root, contract, task.id, { stage: 'done' }).stage, 'done')
})

test('done 时间边界：绿记录早于 implemented_at → 仍拒绝；失败的记录不算证据', () => {
  const { root, contract } = describedProject('gate-done-window')
  const task = addTask(root, contract, { title: '时间窗', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: NEW_SEMANTICS }],
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })
  applyDescriptionPlan(root, contract, task.id, { now: NOW })
  updateTask(root, contract, task.id, { stage: 'queued-review' })
  updateTask(root, contract, task.id, { stage: 'reviewing' })

  writeGateLog(root, 'tests', EARLIER, true)
  expectGateError(() => updateTask(root, contract, task.id, { stage: 'done' }), 'done', /早于要求的时间点|tests-missing/)

  clearGateLogs(root, 'tests')
  writeGateLog(root, 'tests', LATER, false)
  expectGateError(() => updateTask(root, contract, task.id, { stage: 'done' }), 'done', /tests-missing/)

  clearGateLogs(root, 'tests')
  writeGateLog(root, 'tests', LATER, true)
  assert.equal(updateTask(root, contract, task.id, { stage: 'done' }).stage, 'done')
})

// ================================================================== 豁免

test('豁免：parent 非空的子任务推 done 放行（auto + 有记录条件下）', () => {
  const { root, contract } = describedProject('gate-exempt-subtask')
  const parent = addTask(root, contract, { title: '父任务', type: 'feat', stage: 'analyzing' })
  /* 子任务建在 analyzing：analyzing → done 才是汇总收口边（created → done 不在边表里）。 */
  const child = addTask(root, contract, { title: '子任务', type: 'feat', parent: parent.id, stage: 'analyzing' })
  assert.equal(updateTask(root, contract, child.id, { stage: 'done' }).stage, 'done')
  // 父任务走同一路径 → 被拦（证明豁免只对子任务生效）。
  const sibling = addTask(root, contract, { title: '根任务', type: 'feat', stage: 'analyzing' })
  expectGateError(() => updateTask(root, contract, sibling.id, { stage: 'done' }), 'done')
})

test("豁免：source:'internal' 放行，同一调用不传该选项被拒绝；assertDescriptionGate 支持两种入参形态", () => {
  const { root, contract } = describedProject('gate-exempt-internal')
  const task = addTask(root, contract, { title: '内部写', type: 'feat', stage: 'analyzing' })
  const target = getTask(root, contract, task.id)

  // 门禁函数本身：选项包形态（`{task, from, to, source}`）。
  expectGateError(
    () => assertDescriptionGate(root, contract, { task: target, from: 'analyzing', to: 'queued-implementation' }),
    'queued-implementation'
  )
  assert.equal(
    assertDescriptionGate(root, contract, { task: target, from: 'analyzing', to: 'queued-implementation', source: 'internal' }),
    undefined
  )
  // 记录形态（spec §8 的 `(…, nextTask, {source, from, to})`）。
  assert.equal(
    assertDescriptionGate(root, contract, target, { source: 'internal', from: 'analyzing', to: 'done' }),
    undefined
  )

  // updateTask 侧：不传 options 会被拦，传了才放行。
  expectGateError(
    () => updateTask(root, contract, task.id, { stage: 'queued-implementation' }),
    'queued-implementation'
  )
  assert.equal(
    updateTask(root, contract, task.id, { stage: 'queued-implementation' }, { source: 'internal' }).stage,
    'queued-implementation'
  )
})

test('豁免：只写 status/notes 的补丁不触发门禁（即使台账里有记录且没有计划）', () => {
  const { root, contract } = describedProject('gate-exempt-status')
  const task = addTask(root, contract, { title: '只写状态', type: 'feat', stage: 'analyzing' })
  // 先证明这条调用前面确实是「有记录、无计划」的拦截态。
  expectGateError(() => updateTask(root, contract, task.id, { stage: 'queued-implementation' }), 'queued-implementation')

  const patched = updateTask(root, contract, task.id, { notes: '只改备注', status: 'active' })
  assert.equal(patched.notes, '只改备注')
  assert.equal(stageOf(root, contract, task.id), 'analyzing')

  // 极端证明：门禁根本没读描述目录（整棵删掉也不报）。
  fs.rmSync(path.join(root, '.agents/description'), { recursive: true, force: true })
  const again = updateTask(root, contract, task.id, { notes: '描述目录都没了' })
  assert.equal(again.notes, '描述目录都没了')
})

test('存量盘上无 stage 的记录：from 走 projectTaskStage 投影（同阶重写幂等／跳级文案用投影起点）', () => {
  const { root, contract } = describedProject('gate-legacy')
  // status=active → 投影成 queued-analysis；盘上没有 stage 字段。
  writeLegacyTask(root, 'T-20260101000000', 'active')
  assert.equal(stageOf(root, contract, 'T-20260101000000'), 'queued-analysis')

  // from = queued-analysis（投影）→ to = queued-analysis → 同一阶段，门禁跳过。
  // 若实现直接读 `current.stage`（undefined），这里会被当成真实迁移而拦下。
  assert.equal(
    updateTask(root, contract, 'T-20260101000000', { stage: 'queued-analysis' }).stage,
    'queued-analysis'
  )

  // 换一条真的迁移 → 阶段边先拒（T-20261112151328）。文案里的 from 必须是**投影**出来的
  // queued-analysis：若实现直接读 `current.stage`（undefined），会变成 unknown stage。
  writeLegacyTask(root, 'T-20260101000001', 'active')
  assert.throws(
    () => updateTask(root, contract, 'T-20260101000001', { stage: 'queued-implementation' }),
    (error) =>
      error instanceof FlowError &&
      error.code === 'invalid' &&
      /stage queued-analysis cannot move to "queued-implementation"/.test(error.message),
    'legacy 记录的 from 必须是 projectTaskStage 投影'
  )
})

// ========================================================== 未计划改动（git）

test('unplanned-change：计划外的新文件让 queued-review 失败', (t) => {
  if (!hasGit()) {
    t.skip('未安装 git')
    return
  }
  const root = tempRoot('gate-unplanned')
  gitRun(root, ['init', '-q'])
  gitRun(root, ['config', 'user.name', 'flow'])
  gitRun(root, ['config', 'user.email', 'flow@example.com'])
  for (const [relative, content] of Object.entries(SOURCES)) writeFile(root, relative, content)
  gitRun(root, ['add', '-A'])
  gitRun(root, ['commit', '-qm', 'init'])

  initProject(root, { name: 'unplanned', noGates: true })
  const contract = loadContract(root).contract
  buildDescription(root, contract)
  setDescriptionFile(root, contract, [
    {
      path: 'lib/a.mjs',
      semantics: '文件语义：lib/a.mjs 在未计划改动用例里的职责。',
      modules: [{ id: moduleIdOf(root, contract, 'lib/a.mjs'), semantics: '模块语义：契约模块的职责说明。' }],
    },
    {
      path: 'lib/b.mjs',
      semantics: '文件语义：lib/b.mjs 在未计划改动用例里的职责。',
      modules: [{ id: moduleIdOf(root, contract, 'lib/b.mjs'), semantics: '模块语义：用法模块的职责说明。' }],
    },
  ])
  setProjectSemantics(root)
  const clean = checkDescription(root, contract)
  assert.equal(clean.ok, true, JSON.stringify(clean.failed))

  const task = addTask(root, contract, { title: '未计划改动', type: 'feat', stage: 'analyzing' })
  setDescriptionPlan(root, contract, task.id, {
    files: [{ path: 'lib/a.mjs', op: 'change', semantics: NEW_SEMANTICS }],
  })
  updateTask(root, contract, task.id, { stage: 'queued-implementation' })
  updateTask(root, contract, task.id, { stage: 'implementing' })

  // 计划外的未跟踪新文件（include 命中）。
  writeFile(root, 'lib/extra.mjs', 'export function extra() {}\n')
  applyDescriptionPlan(root, contract, task.id, { now: NOW })

  expectGateError(
    () => updateTask(root, contract, task.id, { stage: 'queued-review' }),
    'queued-review',
    /unplanned-change lib\/extra\.mjs/
  )
})

function moduleIdOf(root, contract, relative) {
  return getDescriptionFile(root, contract, relative).modules[0].id
}

// ==================================================== 单一真源：DESCRIPTION_STAGE_POLICY

test('单一真源：策略表覆盖九个阶段，门名单与两处写窗口全部由表派生', () => {
  // 表必须与阶段机逐行对齐：多一行 = 留下一个无人读的口径，少一行 = 静默放行。
  assert.deepEqual(Object.keys(DESCRIPTION_STAGE_POLICY), [...STAGE_IDS])
  for (const stage of STAGE_IDS) {
    const row = DESCRIPTION_STAGE_POLICY[stage]
    assert.deepEqual(Object.keys(row).sort(), ['apply', 'gate', 'plan', 'requireTests'], stage)
    assert.ok(['plan', 'full', null].includes(row.gate), stage)
  }

  // 派生视图 = 表的投影（不是另写一组数组）。
  assert.deepEqual(
    [...DESCRIPTION_GATE_STAGES],
    STAGE_IDS.filter((stage) => DESCRIPTION_STAGE_POLICY[stage].gate !== null)
  )
  assert.deepEqual([...DESCRIPTION_GATE_STAGES], ['queued-implementation', 'queued-review', 'done'])
  assert.deepEqual([...descriptionPlanStages()], [
    'queued-analysis',
    'analyzing',
    'queued-implementation',
    'implementing',
    'queued-review',
  ])
  assert.deepEqual([...descriptionApplyStages()], ['implementing', 'queued-review'])
  assert.deepEqual(STAGE_IDS.filter((stage) => DESCRIPTION_STAGE_POLICY[stage].requireTests), ['done'])

  /* 不变式（本卡存在的理由）：凡是设了描述门的阶段，门的修复命令必须在**同一阶段**
     可执行。queued-review 的 gate 是 'full'（会拒绝未落地的计划），所以它必须同时
     在 plan/apply 窗口里；queued-implementation 的 gate 是 'plan'（要求计划存在），
     所以它必须在 plan 窗口里。任一条不成立 = 永远过不去的门。 */
  for (const stage of DESCRIPTION_GATE_STAGES) {
    const row = DESCRIPTION_STAGE_POLICY[stage]
    if (row.gate === 'plan') assert.equal(row.plan, true, `${stage}: plan 门要求计划存在，本阶段却写不了计划`)
    // 「计划欠账」档的 full 门（queued-review）：apply 与补计划都必须在同阶段可执行。
    if (row.gate === 'full' && row.requireTests === false) {
      assert.equal(row.apply, true, `${stage}: full 门拒绝未落地计划，本阶段却 apply 不了`)
      assert.equal(row.plan, true, `${stage}: apply 之前先要有计划可补`)
    }
    /* done 是 full 门但只欠「测试证据」，修复命令是 `flow gate run`（与阶段无关，
       不属于 plan/apply 写窗口）；而且它的欠账必须在 queued-review 就结清——done 是
       终态侧的阶段，不会把一张计划未落地的卡再往前推。 */
    if (row.requireTests === true) assert.equal(row.apply, false, stage)
  }
})

test('单一真源：九个阶段的 plan/apply 行为逐行等于策略表（行为断言，不只是结构断言）', () => {
  const { root, contract } = describedProject('gate-policy-window')
  const body = { files: [{ path: 'lib/a.mjs', op: 'change', semantics: NEW_SEMANTICS }] }

  for (const stage of STAGE_IDS) {
    const id = `T-POLICY-${stage}`
    writeStagedTask(root, id, stage)
    const row = DESCRIPTION_STAGE_POLICY[stage]

    if (row.plan === true) {
      const result = setDescriptionPlan(root, contract, id, body)
      assert.equal(result.plan.task, id, stage)
      assert.equal(result.plan.status, 'planned', stage)
    } else {
      expectInvalid(
        () => setDescriptionPlan(root, contract, id, body),
        /只允许 queued-analysis \/ analyzing \/ queued-implementation \/ implementing \/ queued-review/
      )
    }

    if (row.apply === true) {
      const applied = applyDescriptionPlan(root, contract, id, { now: NOW })
      assert.equal(applied.applied, true, `${stage}: 表说能 apply`)
      assert.equal(applied.plan.status, 'implemented', stage)
    } else {
      expectInvalid(
        () => applyDescriptionPlan(root, contract, id, { now: NOW }),
        /只允许 implementing \/ queued-review/
      )
    }
  }
})
