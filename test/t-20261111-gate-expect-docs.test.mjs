// T-20261111155622：expect 容错语义变更后，文档 / CLI 帮助必须同步。
//
// 审查退回的直接原因是「功能改了、文档还写旧语义」：CONTRACT §3.3 说未知 expect
// 运行时按 exit 0 处理，§5 的命令参考与 --step 说明没列 --allow-unknown-expect，
// 警告流没列 gate-expect-invalid，`flow --help` 也没列该 flag。这里用源码/文档
// 双向断言把它钉住，防止下一次再漂移。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BIN = path.join(ROOT, 'bin', 'flow.mjs')
const CONTRACT = fs.readFileSync(path.join(ROOT, 'CONTRACT.md'), 'utf8')

test('CONTRACT §3.3：未知 expect 定义期拒绝，运行期失败记 gate-expect-invalid', () => {
  assert.match(CONTRACT, /未知写法在定义期直接拒绝/)
  assert.match(CONTRACT, /step\.allowUnknownExpect: true/)
  assert.match(CONTRACT, /gate-expect-invalid/)
  // 旧语义（运行时按 exit 0 处理）必须消失。
  assert.doesNotMatch(CONTRACT, /运行时按 `exit 0` 处理并记 `gate-expect-unknown`/)
})

test('CONTRACT §5：警告流、CLI 参考与 --step 说明都列出新 flag / 新语义', () => {
  const addAt = CONTRACT.indexOf('flow gate add    --id SLUG')
  assert.ok(addAt > 0, '§5.1 CLI 参考里找不到 gate add')
  const gateBlock = CONTRACT.slice(addAt, CONTRACT.indexOf('flow gate enable', addAt))
  assert.match(gateBlock, /flow gate add[\s\S]*--allow-unknown-expect/)
  assert.match(gateBlock, /flow gate update[\s\S]*--allow-unknown-expect/)

  const stepAt = CONTRACT.indexOf('- `--step` 格式')
  assert.ok(stepAt > 0, '§5 里找不到 --step 说明')
  const stepNote = CONTRACT.slice(stepAt, CONTRACT.indexOf('- `gate run --timeout', stepAt))
  assert.match(stepNote, /定义期直接 `invalid` 拒绝/)
  assert.match(stepNote, /--allow-unknown-expect/)

  // §5 警告流：运行期「判失败」的诊断名必须列出来（与 gate-expect-unknown 不同）。
  const warnAt = CONTRACT.indexOf('**警告流**')
  assert.ok(warnAt > 0, '§5 里找不到警告流说明')
  assert.match(CONTRACT.slice(warnAt, CONTRACT.indexOf('### 5.1', warnAt)), /gate-expect-invalid/)
})

test('flow --help：gate add/update 列出 --allow-unknown-expect 并说明定义期拒绝', () => {
  const result = spawnSync(process.execPath, [BIN, '--help'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const help = result.stdout
  assert.match(help, /gate add[\s\S]{0,240}--allow-unknown-expect/)
  assert.match(help, /gate update[\s\S]{0,240}--allow-unknown-expect/)
  assert.match(help, /expect 未知写法[\s\S]{0,40}定义期直接拒绝/)
})
