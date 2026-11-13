// 2026-11-13（T-20261112154526 切片 1+2）：后端单一 API 层 + CLI/域助手迁移。
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
]
/** 已迁文件中唯一不 import api 的例外（面板读网关，切片 1 裁定）。 */
const NO_API_IMPORT_EXCEPTIONS = new Set(['lib/cli/state.mjs'])
/** 仍允许直接 import core 的 lib 文件：MCP 另立卡（切片 4）。 */
const CORE_IMPORT_ALLOWLIST = new Set([API_FILE, 'lib/cli/mcp-server.mjs'])
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
  assert.deepEqual(importers, [API_FILE, 'lib/cli/mcp-server.mjs'].sort(), 'core import 入口白名单漂移')
})

test('结构：bin/state-snapshot 仍是仅有的两个 URL/CORE_URL 加载点（非 import 说明符，单独守）', () => {
  assert.match(readRepo('bin/flow.mjs'), /\.\.\/lib\/core\.mjs/, 'bin 的 URL loader 不可静默消失')
  assert.match(readRepo('lib/state-snapshot.mjs'), /core\.mjs/, 'state-snapshot 的 core 网关不可静默消失')
  // 切片 3 才收 bin 的注入面：现在 bin 仍 setCoreRef（本断言防止有人提前删坏）。
  assert.match(readRepo('bin/flow.mjs'), /setCoreRef\(core\)/, '切片 3 前 bin 仍应注入 coreRef')
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
