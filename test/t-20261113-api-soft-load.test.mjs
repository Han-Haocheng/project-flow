// 2026-11-13（T-20261113125709）：api 软加载的降级路径。
//
// 手法与 test/t-20261107-state-degradation.test.mjs 同源：把真实 lib/ 逐字节复制到临时目录，
// **唯独不放 core.mjs**，再用子进程 import 副本里的 lib/backend/api.mjs。父进程断言：
//   - import 本身成功（旧静态 import 会在这里直接 ERR_MODULE_NOT_FOUND）；
//   - 命名空间成员存在且是函数（tools/host/CLI 可以在 import 阶段完成装配）；
//   - 调用任意 core 成员抛可读错误（文案与 state-snapshot.requireCore 逐字对齐，code=io）；
//   - 降级常量/诊断/初始化按约定不抛：TASK_TYPES=[]、DESCRIPTION_ENFORCE_MODES=[]、
//     drainWarnings()=[]、initialized()=false。
// 同时断言副本里确实没有 core.mjs——否则测的是正常路径而不是降级。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const LIB = path.join(REPO, 'lib')
const TEMP_DIRS = []

after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pf-api-soft-${label}-`))
  TEMP_DIRS.push(dir)
  return dir
}

/** 复制真实 lib/，排除 core.mjs（只排除它，其余依赖保持逐字节一致）。 */
function stageLibWithoutCore(label) {
  const dir = tempRoot(label)
  const target = path.join(dir, 'lib')
  fs.cpSync(LIB, target, {
    recursive: true,
    filter: (src) => path.basename(src) !== 'core.mjs',
  })
  assert.equal(fs.existsSync(path.join(target, 'core.mjs')), false, 'staged copy must not contain core.mjs')
  return { dir, lib: target }
}

test('降级：core.mjs 缺失时 api 仍可 import，成员存在，调用抛可读 io 错误', () => {
  const { dir, lib } = stageLibWithoutCore('degraded')
  const apiUrl = pathToFileURL(path.join(lib, 'backend', 'api.mjs')).href
  const probe = path.join(dir, 'probe.mjs')
  fs.writeFileSync(
    probe,
    [
      `const api = await import(${JSON.stringify(apiUrl)})`,
      'const out = {',
      "  imported: true,",
      "  listTasks: typeof api.tasks.listTasks,",
      "  runGate: typeof api.gates.runGate,",
      "  loadContract: typeof api.contract.loadContract,",
      "  flowError: typeof api.FlowError,",
      "  taskTypes: api.tasks.TASK_TYPES,",
      "  enforceModes: api.DESCRIPTION_ENFORCE_MODES,",
      "  drained: api.warnings.drainWarnings(),",
      "  initialized: api.contract.initialized('/tmp/pf-soft-load-missing-root'),",
      '}',
      'try {',
      "  api.tasks.listTasks('/tmp/pf-soft-load-missing-root', {})",
      '} catch (error) {',
      '  out.error = {',
      '    name: error && error.name,',
      '    code: error && error.code,',
      '    message: error && error.message,',
      '    isFlowError: error instanceof api.FlowError,',
      '  }',
      '}',
      'process.stdout.write(JSON.stringify(out))',
      '',
    ].join('\n'),
  )
  const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(run.status, 0, `probe failed: ${run.stderr}`)
  const out = JSON.parse(run.stdout)

  assert.equal(out.imported, true, 'api import must not throw when core.mjs is missing')
  assert.equal(out.listTasks, 'function', '降级命名空间成员必须存在（插件能完成装配）')
  assert.equal(out.runGate, 'function')
  assert.equal(out.loadContract, 'function')
  assert.equal(out.flowError, 'function')

  assert.equal(out.initialized, false, 'initialized() 在缺失时返回 false，不抛')
  assert.deepEqual(out.taskTypes, [], 'TASK_TYPES 降级为空表')
  assert.deepEqual(out.enforceModes, [], 'DESCRIPTION_ENFORCE_MODES 降级为空表')
  assert.deepEqual(out.drained, [], 'drainWarnings() 降级为空数组（诊断不抛）')

  assert.ok(out.error, '调用 core 成员必须抛错，而不是静默成功')
  assert.equal(out.error.name, 'FlowError')
  assert.equal(out.error.code, 'io')
  assert.equal(out.error.isFlowError, true, '抛出的错误必须是 api.FlowError 的实例（兜底类）')
  // 与 state-snapshot.requireCore 的文案逐字对齐（含修复提示）。
  assert.match(out.error.message, /^project flow core is not installed \(lib\/core\.mjs could not be loaded\)/)
  assert.match(out.error.message, /reinstall the project-flow plugin or use the CLI: node bin\/flow\.mjs/)
})

test('正例对照：同一份 api 在真实仓库里 core 可用，成员仍是 core 原函数引用', async () => {
  const api = await import('../lib/backend/api.mjs')
  const core = await import('../lib/core.mjs')
  assert.equal(api.tasks.listTasks, core.listTasks, '健康路径不得因软加载变成包装函数')
  assert.equal(api.contract.loadContract, core.loadContract)
  assert.equal(api.FlowError, core.FlowError)
  assert.notDeepEqual(api.tasks.TASK_TYPES, [], '健康路径的 TASK_TYPES 必须是真实清单')
})
