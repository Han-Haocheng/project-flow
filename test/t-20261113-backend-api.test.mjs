// 2026-11-13（T-20261112154526 切片 1）：后端单一 API 层骨架 + 只读入口迁移。
//
// 本文件守三层，且每层都先证「断言会咬人」再证「当前是绿的」：
//   ① 正例：api 确实从 ../core.mjs 取能力；check.mjs 确实 import api（防文件消失/改名后假绿）；
//   ② 反例：check.mjs / state.mjs 不得 import core、不得再摸 ctx.core；
//          lib/cli/ 下除白名单（MCP 文件，另卡）外不得出现 core import；
//   ③ 行为：api 是转发不是包装——函数引用同一、返回值 deepEqual、FlowError 原样抛。
//
// 豁免必须写进本文件的 allowlist 并注明切片，不允许"顺手"放宽。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as core from '../lib/core.mjs'
import * as api from '../lib/backend/api.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const API_FILE = 'lib/backend/api.mjs'
/** 切片 1 已迁到 api 的 adapter：不得再 import core / 摸 ctx.core。 */
const MIGRATED_ADAPTERS = ['lib/cli/check.mjs', 'lib/cli/state.mjs']
/** 仍允许直接 import core 的 lib/cli 文件：MCP 另立卡（切片 4）。 */
const CLI_CORE_IMPORT_ALLOWLIST = new Set(['lib/cli/mcp-server.mjs'])
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

test('结构：api 是 core 的入口；已迁 adapter 只 import api，不再 import core', () => {
  // 扫描器自证：已知违规样本必须命中，合法说明符必须原样取到。
  assert.deepEqual(importSpecifiers("import { x } from '../core.mjs'").filter(isCoreSpecifier), ['../core.mjs'])
  assert.deepEqual(
    importSpecifiers("const c = await import('../backend/api.mjs')"),
    ['../backend/api.mjs'],
  )

  const apiSpecs = importSpecifiers(readRepo(API_FILE))
  assert.deepEqual(apiSpecs.filter(isCoreSpecifier), ['../core.mjs'], 'api 必须且只能 import 一个 core')

  for (const file of MIGRATED_ADAPTERS) {
    const source = readRepo(file)
    assert.deepEqual(
      importSpecifiers(source).filter(isCoreSpecifier),
      [],
      `${file} 不得直接 import core（只经 lib/backend/api.mjs）`,
    )
    assert.doesNotMatch(source, /\bctx\.core\b/, `${file} 不得再使用 ctx.core`)
  }

  assert.ok(
    importSpecifiers(readRepo('lib/cli/check.mjs')).includes('../backend/api.mjs'),
    'check.mjs 必须 import api（正例：迁移真的发生了）',
  )

  const cliDir = path.join(REPO, 'lib', 'cli')
  const cliFiles = fs.readdirSync(cliDir).filter((name) => name.endsWith('.mjs'))
  assert.ok(cliFiles.length >= 8, `lib/cli 文件数异常（${cliFiles.length}），断言会假绿`)
  const offenders = cliFiles
    .map((name) => `lib/cli/${name}`)
    .filter((rel) => CLI_CORE_IMPORT_ALLOWLIST.has(rel) === false)
    .filter((rel) => importSpecifiers(readRepo(rel)).some(isCoreSpecifier))
  assert.deepEqual(offenders, [], `lib/cli 下出现未登记的 core import：${offenders.join(', ')}`)
})

// ------------------------------------------------------------------ 行为断言

test('行为：api 转发不是包装——函数引用与 core 完全相同', () => {
  const pairs = [
    ['contract.loadContract', api.contract.loadContract, core.loadContract],
    ['contract.assertInitialized', api.contract.assertInitialized, core.assertInitialized],
    ['contract.storePaths', api.contract.storePaths, core.storePaths],
    ['warnings.drainWarnings', api.warnings.drainWarnings, core.drainWarnings],
    ['warnings.noteWarning', api.warnings.noteWarning, core.noteWarning],
    ['tasks.listTasks', api.tasks.listTasks, core.listTasks],
    ['tasks.normalizeTaskFormat', api.tasks.normalizeTaskFormat, core.normalizeTaskFormat],
    ['decisions.getDecision', api.decisions.getDecision, core.getDecision],
    ['checks.checkDecisions', api.checks.checkDecisions, core.checkDecisions],
    ['checks.checkExperiments', api.checks.checkExperiments, core.checkExperiments],
    ['checks.checkDescription', api.checks.checkDescription, core.checkDescription],
  ]
  for (const [name, actual, expected] of pairs) {
    assert.equal(actual, expected, `${name} 必须是 core 的原函数引用（包装会改变返回值/错误）`)
  }
  assert.equal(api.TASK_TYPES, core.TASK_TYPES, 'TASK_TYPES 必须是 core 的同一数组')
  assert.ok(Array.isArray(api.warnings.drainWarnings()), 'drainWarnings 返回 core 的数组（空也要是数组）')
})

test('行为：loadContract / storePaths 与 core 返回逐字段一致', () => {
  const root = tempRoot('contract')
  core.initProject(root, { name: 'api-slice1', noGates: true })

  const mine = api.contract.loadContract(root)
  const theirs = core.loadContract(root)
  assert.deepEqual(mine, theirs, 'api.loadContract 不得改写 core 的返回（含 warnings/source）')
  assert.equal(mine.contract.name, 'api-slice1')

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
