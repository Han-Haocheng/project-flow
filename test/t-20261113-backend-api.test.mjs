// 2026-11-13（T-20261112154526 切片 1–5 + T-20261113131413）：后端单一 API 层覆盖 CLI/工具/宿主/会话/装配面/MCP。
//
// 本文件守三层，且每层都先证「断言会咬人」再证「当前是绿的」：
//   ① 正例：api 从 ../core.mjs 取能力；已迁文件确实 import api（防文件消失/改名后假绿）；
//   ② 反例：lib/cli/**、team-sync、veto 不得 import core、不得再摸 ctx.core；
//          core 入口白名单只剩 api + mcp-server（静态/动态 import 形式都扫）；
//   ③ 行为：api 是转发不是包装——函数引用同一、返回值 deepEqual、FlowError 原样抛。
//
// 豁免必须写进本文件的 allowlist 并注明切片，不允许"顺手"放宽。
// 已知例外：lib/cli/state.mjs 的活路径走 state-snapshot 读网关（切片 1 裁定），因此它
// 不 import api，但它同样不得 import core / 摸 ctx.core。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as core from '../lib/core.mjs'
import * as api from '../lib/backend/api.mjs'
import { acceptancePlan, recordTaskVerification, verificationStateOf } from '../lib/tasks/records.mjs'
import { listIntents, recoverIntents } from '../lib/tasks/intents.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const API_FILE = 'lib/backend/api.mjs'
/** 切片 1+2 已迁到 api 的 adapter / 域助手：不得再 import core、摸 ctx.core。 */
const MIGRATED = [
  'lib/cli/check.mjs',
  'lib/cli/state.mjs',
  'lib/cli/tasks.mjs',
  'lib/cli/exp.mjs',
  'lib/cli/gates.mjs',
  'lib/cli/decisions.mjs',
  'lib/cli/heartbeat.mjs',
  'lib/cli/desc.mjs',
  'lib/cli/misc.mjs',
  'lib/team-sync.mjs',
  'lib/veto.mjs',
  'lib/tools/tasks.mjs',
  'lib/tools/subtasks.mjs',
  'lib/tools/gates.mjs',
  'lib/tools/experiments.mjs',
  'lib/host/tools.mjs',
  'lib/host/routes.mjs',
  'lib/host/session.mjs',
  'lib/host/enforce.mjs',
  'lib/host/team.mjs',
  'lib/cli/mcp-server.mjs',
]
/** 已迁文件中唯一不 import api 的例外（面板读网关，切片 1 裁定）。 */
const NO_API_IMPORT_EXCEPTIONS = new Set(['lib/cli/state.mjs'])
/** 全库唯一允许直接 import core 的文件（MCP 已于 T-20261113131413 收进 api）。 */
const CORE_IMPORT_ALLOWLIST = new Set([API_FILE])
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flow-api-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function readRepo(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8')
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(rel, out)
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) out.push(rel)
  }
  return out
}

/**
 * 抽取真正的 import / export-from / 动态 import 说明符。
 * 注释里的 "import ..." 不会命中（要求 import/from 在语句边界）；这是结构断言不假绿的前提。
 */
function importSpecifiers(source) {
  const specs = []
  const patterns = [
    /\bimport\s+(?:[^'"]*?\sfrom\s*)?(['"])([^'"]+)\1/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s*(['"])([^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(match[2])
  }
  return specs
}

function isCoreSpecifier(spec) {
  return spec.endsWith('/core.mjs') || spec === './core.mjs'
}

// ------------------------------------------------------------------ 结构断言

test('结构：api 是 core 的唯一 adapter 入口；已迁文件只 import api，不再 import core', () => {
  // 扫描器自证：已知违规样本必须命中，合法说明符必须原样取到。
  assert.deepEqual(importSpecifiers("import { x } from '../core.mjs'").filter(isCoreSpecifier), ['../core.mjs'])
  assert.deepEqual(importSpecifiers("import { x } from './core.mjs'").filter(isCoreSpecifier), ['./core.mjs'])
  assert.deepEqual(importSpecifiers("const c = await import('../backend/api.mjs')"), ['../backend/api.mjs'])

  const apiSpecs = importSpecifiers(readRepo(API_FILE))
  assert.deepEqual(apiSpecs.filter(isCoreSpecifier), ['../core.mjs'], 'api 必须且只能 import 一个 core')

  for (const file of MIGRATED) {
    const source = readRepo(file)
    assert.deepEqual(
      importSpecifiers(source).filter(isCoreSpecifier),
      [],
      `${file} 不得直接 import core（只经 lib/backend/api.mjs）`,
    )
    assert.doesNotMatch(source, /\bctx\.core\b/, `${file} 不得再使用 ctx.core`)
    if (NO_API_IMPORT_EXCEPTIONS.has(file) === false) {
      assert.ok(
        importSpecifiers(source).some((spec) => spec.endsWith('/backend/api.mjs')),
        `${file} 必须 import api（正例：迁移真的发生了）`,
      )
    }
  }

  // lib/cli 全目录：除 MCP 文件外不得出现 core import（防止"没列进 MIGRATED 的新文件"漏网）。
  const cliFiles = fs.readdirSync(path.join(REPO, 'lib', 'cli')).filter((name) => name.endsWith('.mjs'))
  assert.ok(cliFiles.length >= 8, `lib/cli 文件数异常（${cliFiles.length}），断言会假绿`)
  const cliOffenders = cliFiles
    .map((name) => `lib/cli/${name}`)
    .filter((rel) => CORE_IMPORT_ALLOWLIST.has(rel) === false)
    .filter((rel) => importSpecifiers(readRepo(rel)).some(isCoreSpecifier))
  assert.deepEqual(cliOffenders, [], `lib/cli 下出现未登记的 core import：${cliOffenders.join(', ')}`)

  // lib/cli 全目录：不得再出现 ctx.core（切片 2 收口；bin 的注入面切片 3 再删）。
  const ctxCoreOffenders = cliFiles
    .map((name) => `lib/cli/${name}`)
    .filter((rel) => /\bctx\.core\b/.test(readRepo(rel)))
  assert.deepEqual(ctxCoreOffenders, [], `lib/cli 下仍在使用 ctx.core：${ctxCoreOffenders.join(', ')}`)

  // 全库静态/动态 core import：只允许 api 与 MCP 文件（bin 的 URL loader 与
  // state-snapshot 的 CORE_URL 不是 import 说明符，下面单独正例断言它们仍是唯一 loader）。
  const importers = [...walk('lib'), ...walk('bin')]
    .filter((rel) => importSpecifiers(readRepo(rel)).some(isCoreSpecifier))
    .sort()
  assert.deepEqual(importers, [API_FILE], '全库 core import 白名单只剩 api.mjs')
})

test('结构：bin 的 coreRef/ctx.core 注入面已退场，加载点只剩 api 与 state-snapshot', () => {
  const bin = readRepo('bin/flow.mjs')
  const shared = readRepo('lib/cli/shared.mjs')
  // 判定样本先自证会咬人。
  assert.match('setCoreRef(core)', /\bsetCoreRef\s*\(/)
  assert.doesNotMatch('const ctx = { root }', /\bsetCoreRef\s*\(/)
  assert.match('const c = loadCore()', /\bloadCore\s*\(/)
  // 反例：bin 不再加载/注入 core；shared 不再持有 coreRef。
  assert.doesNotMatch(bin, /\bsetCoreRef\s*\(/, 'bin 不得再 setCoreRef')
  assert.doesNotMatch(bin, /\bloadCore\s*\(/, 'bin 不得再自带 core loader')
  assert.doesNotMatch(bin, /\bctx\.core\b|\bcore:\s*core\b/, 'ctx 不得再注入 core')
  assert.doesNotMatch(shared, /\bcoreRef\b|\bsetCoreRef\s*\(/, 'shared 不得再持有 coreRef')
  // warnings 仍是单通道：shared 直接转发 api（其成员就是 core.drainWarnings 本身）。
  assert.match(shared, /backendWarnings\.drainWarnings\(\)/, 'drainCoreWarnings 必须走 api 单通道')
  // MCP 不再自建 core loader（进程内三工具经 api，10 个工具仍走 CLI 子进程）。
  const mcp = readRepo('lib/cli/mcp-server.mjs')
  assert.match('const c = loadCore()', /\bloadCore\s*\(/)
  assert.doesNotMatch(mcp, /\bloadCore\s*\(/, 'MCP 不得再自建 core loader')
  assert.deepEqual(importSpecifiers(mcp).filter(isCoreSpecifier), [], 'MCP 不得再 import core')
  // orchestrator 的依赖注入点必须是 api.tasks（不再有逐方法包一层的 core shim）。
  assert.match(mcp, /orchestrator\.core = tasks/, 'orchestrator 必须注入 api.tasks')
  assert.doesNotMatch(mcp, /getTask: \(a, b, c\) =>/, '不得恢复 core shim')
  // 降级加载点仍在 state-snapshot（index 启动探测与降级测试依赖）。
  assert.match(readRepo('lib/state-snapshot.mjs'), /CORE_URL/, 'state-snapshot 的降级加载点必须在')
})

test('结构：网关调用只剩 state-snapshot 内部，index 仅保留启动降级探测', () => {
  const GATEWAY_CALL = /\b(?:requireCore|coreModule)\s*\(/
  // 扫描器自证：已知违规样本必须命中，api 调用不得命中。
  assert.match('const c = requireCore()', GATEWAY_CALL)
  assert.match('snapshots.coreModule()', GATEWAY_CALL)
  assert.doesNotMatch('api.tasks.listTasks()', GATEWAY_CALL)

  // 全库（lib/**、bin/**、index.js）只剩 state-snapshot 自己调用网关。
  const callers = [...walk('lib'), ...walk('bin'), 'index.js']
    .filter((rel) => GATEWAY_CALL.test(readRepo(rel)))
    .sort()
  assert.deepEqual(callers, ['lib/state-snapshot.mjs'], `网关调用者白名单漂移：${callers.join(', ')}`)

  // index.js 的唯一网关用途是启动降级探测（保留），不得再直接拿 core 模块。
  const index = readRepo('index.js')
  assert.match(index, /coreAvailable\(\) === false/, '启动降级探测必须保留')
  assert.match(index, /coreUnavailableMessage\(\)/, '降级文案来源必须保留')
  assert.doesNotMatch(index, GATEWAY_CALL, 'index 不得再调用网关')
  assert.doesNotMatch(index, /^\s*(?:coreModule|requireCore),$/m, 'index 不得再从 state-snapshot import 网关')
  assert.deepEqual(importSpecifiers(index).filter(isCoreSpecifier), [], 'index 不得 import core')
})

test('结构：降级网关保留在 state-snapshot，tools/host 不再走 requireCore/coreModule', () => {
  // 网关本身必须在：state-degradation 测试与 index.js 的启动降级探测依赖它和两条文案
  // （它不是正常读写路径；正常路径全部经 api）。
  const snapshot = readRepo('lib/state-snapshot.mjs')
  assert.match(snapshot, /function requireCore\(/, 'requireCore 不得删除（session/降级测试依赖）')
  assert.match(snapshot, /function coreModule\(/, 'coreModule 不得删除')
  assert.match(snapshot, /core-unavailable: lib\/core\.mjs could not be loaded/, '降级文案不得改写')
  assert.match(snapshot, /is not installed/, '降级文案的安装提示不得改写')

  // 反例：本片迁移面不得再调用网关；判定样本先自证会咬人。
  const GATEWAY_CALL = /\b(?:requireCore|coreModule)\s*\(/
  assert.match('const c = requireCore()', GATEWAY_CALL)
  assert.match('snapshots.coreModule()', GATEWAY_CALL)
  assert.doesNotMatch('api.tasks.listTasks()', GATEWAY_CALL)
  for (const file of MIGRATED) {
    const source = readRepo(file)
    assert.doesNotMatch(source, GATEWAY_CALL, `${file} 不得再走 requireCore/coreModule`)
  }

  // 正例：tools/host 确实 import api（迁移真的发生，而不是仅删除调用）。
  for (const file of [
    'lib/tools/tasks.mjs',
    'lib/tools/subtasks.mjs',
    'lib/tools/gates.mjs',
    'lib/tools/experiments.mjs',
    'lib/host/tools.mjs',
    'lib/host/routes.mjs',
  ]) {
    assert.ok(
      importSpecifiers(readRepo(file)).some((spec) => spec.endsWith('/backend/api.mjs')),
      `${file} 必须 import api`,
    )
  }
  // host/tools 的心跳降级提示仍用网关的可读文案（不自造一条）。
  assert.match(readRepo('lib/host/tools.mjs'), /coreUnavailableMessage\(\)/, '降级 warning 必须复用 state-snapshot 的文案')
})

// ------------------------------------------------------------------ 行为断言

test('行为：api 转发不是包装——函数引用与 core / 域模块完全相同', () => {
  const pairs = [
    ['contract.loadContract', api.contract.loadContract, core.loadContract],
    ['contract.assertInitialized', api.contract.assertInitialized, core.assertInitialized],
    ['contract.storePaths', api.contract.storePaths, core.storePaths],
    ['contract.initProject', api.contract.initProject, core.initProject],
    ['contract.resolveProjectRoot', api.contract.resolveProjectRoot, core.resolveProjectRoot],
    ['warnings.drainWarnings', api.warnings.drainWarnings, core.drainWarnings],
    ['warnings.noteWarning', api.warnings.noteWarning, core.noteWarning],
    ['tasks.listTasks', api.tasks.listTasks, core.listTasks],
    ['tasks.getTask', api.tasks.getTask, core.getTask],
    ['tasks.updateTask', api.tasks.updateTask, core.updateTask],
    ['tasks.addTask', api.tasks.addTask, core.addTask],
    ['tasks.normalizeTaskFormat', api.tasks.normalizeTaskFormat, core.normalizeTaskFormat],
    ['tasks.queueDispatch', api.tasks.queueDispatch, core.queueDispatch],
    ['tasks.ackDispatch', api.tasks.ackDispatch, core.ackDispatch],
    ['tasks.closeDispatch', api.tasks.closeDispatch, core.closeDispatch],
    ['tasks.listDispatches', api.tasks.listDispatches, core.listDispatches],
    ['tasks.releaseTask', api.tasks.releaseTask, core.releaseTask],
    ['tasks.TASK_TYPES', api.tasks.TASK_TYPES, core.TASK_TYPES],
    ['gates.runGate', api.gates.runGate, core.runGate],
    ['gates.listGates', api.gates.listGates, core.listGates],
    ['experiments.addExperiment', api.experiments.addExperiment, core.addExperiment],
    ['decisions.answerDecision', api.decisions.answerDecision, core.answerDecision],
    ['decisions.summarizeDecisions', api.decisions.summarizeDecisions, core.summarizeDecisions],
    ['heartbeats.heartbeatStatus', api.heartbeats.heartbeatStatus, core.heartbeatStatus],
    ['heartbeats.startHeartbeat', api.heartbeats.startHeartbeat, core.startHeartbeat],
    ['description.buildDescription', api.description.buildDescription, core.buildDescription],
    ['checks.checkDecisions', api.checks.checkDecisions, core.checkDecisions],
    ['checks.checkExperiments', api.checks.checkExperiments, core.checkExperiments],
    ['checks.checkDescription', api.checks.checkDescription, core.checkDescription],
    ['runner.runStep', api.runner.runStep, core.runStep],
  ]
  for (const [name, actual, expected] of pairs) {
    assert.equal(actual, expected, `${name} 必须是 core 的原函数引用（包装会改变返回值/错误）`)
  }
  // core 没 re-export 的最小补口：必须指向域模块原函数，不能自实现。
  assert.equal(api.tasks.acceptancePlan, acceptancePlan)
  assert.equal(api.tasks.verificationStateOf, verificationStateOf)
  assert.equal(api.tasks.recordTaskVerification, recordTaskVerification)
  assert.equal(api.intents.recoverIntents, recoverIntents)
  assert.equal(api.intents.listIntents, listIntents)
  assert.equal(api.FlowError, core.FlowError, 'FlowError 必须是同一个类（adapter 的 instanceof 判定）')
  assert.equal(api.TASK_TYPES, core.TASK_TYPES, 'TASK_TYPES 必须是 core 的同一数组')
  assert.equal(api.api.tasks, api.tasks, '合并视图 api.api 与命名空间指向同一对象')
  assert.ok(Array.isArray(api.warnings.drainWarnings()), 'drainWarnings 返回 core 的数组（空也要是数组）')
})

test('行为：loadContract / storePaths 与 core 返回逐字段一致', () => {
  const root = tempRoot('contract')
  core.initProject(root, { name: 'api-slice2', noGates: true })

  const mine = api.contract.loadContract(root)
  const theirs = core.loadContract(root)
  assert.deepEqual(mine, theirs, 'api.loadContract 不得改写 core 的返回（含 warnings/source）')
  assert.equal(mine.contract.name, 'api-slice2')

  assert.deepEqual(
    api.contract.storePaths(root, mine.contract),
    core.storePaths(root, mine.contract),
    'storePaths 必须是同一投影（adapter 不能自己拼 .agents 路径）',
  )
})

test('行为：initialized() 只折叠 usage，assertInitialized 原样抛 FlowError', () => {
  const bare = tempRoot('bare')
  assert.equal(api.contract.initialized(bare), false, '未初始化必须回答 false')

  let thrown
  try {
    api.contract.assertInitialized(bare)
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof core.FlowError, '错误类型必须是 core.FlowError（bin 靠 code 映射退出码）')
  assert.equal(thrown.code, 'usage')
  assert.match(thrown.message, /run flow init first/)

  core.initProject(bare, { name: 'api-bare', noGates: true })
  assert.equal(api.contract.initialized(bare), true)
  assert.doesNotThrow(() => api.contract.assertInitialized(bare))
})
