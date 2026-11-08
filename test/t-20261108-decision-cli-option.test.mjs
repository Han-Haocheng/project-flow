// T-20261108120326：decision CLI 对 kind 不适用的 --option 必须拒绝，不得静默忽略。
//
// 契约：`--kind approval` 固定 approve|reject、`--kind input` 不接受选项；core
// （buildDecisionOptions）与 `flow_decision` 工具对这两种 kind 带 options 都报
// invalid，CLI 不能"看起来成功"——不静默丢弃参数是最低一致性要求。
//
// 模块归属：decisions（测试跟被测模块走），已登记在
// `docs/module-domain.json` 的 `modules.decisions.tests`。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initProject, loadContract, storePaths } from '../lib/core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
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

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-decision-cli-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `t-decision-cli-${label}`, noGates: true })
  return root
}

function runCli(root, args) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  const result = spawnSync(process.execPath, [BIN, '--root', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

// 决策目录从契约解析，不写死布局（`.agents/decisions` 由 flow.json 的
// decisions.dir 决定，测试跟随实现而不是跟随某次迁移）。
function decisionIds(root) {
  const { contract } = loadContract(root)
  const dir = storePaths(root, contract).decisions
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

// manifest 路径同样取自契约来源，避免第二次布局迁移时再改测试。
function manifestText(root) {
  const { source } = loadContract(root)
  assert.notEqual(source, 'defaults', 'fresh project 应已写出 flow.json')
  return fs.readFileSync(path.join(root, source), 'utf8')
}

function parseJson(stdout) {
  const text = stdout.trim()
  assert.ok(text !== '', '期望 JSON 输出，实际为空')
  return JSON.parse(text)
}

test('approval/input 带 --option：exit 1、点名 --option 与 kind，且不写台账', () => {
  const root = freshProject('reject')
  const manifestBefore = manifestText(root)
  const decisionsBefore = decisionIds(root)

  const approval = runCli(root, [
    'decision', 'ask',
    '--question', 'probe-approval',
    '--kind', 'approval',
    '--option', 'a=A>>A',
    '--rationale', 'r',
  ])
  assert.equal(approval.code, 1, `approval 应 exit 1\n${approval.stdout}\n${approval.stderr}`)
  assert.match(approval.stderr, /不支持 --option/, approval.stderr)
  assert.match(approval.stderr, /--kind approval/, approval.stderr)
  assert.match(approval.stderr, /approve\|reject/, approval.stderr)

  const input = runCli(root, [
    'decision', 'ask',
    '--question', 'probe-input',
    '--kind', 'input',
    '--option', 'a=A>>A',
    '--rationale', 'r',
  ])
  assert.equal(input.code, 1, `input 应 exit 1\n${input.stdout}\n${input.stderr}`)
  assert.match(input.stderr, /不支持 --option/, input.stderr)
  assert.match(input.stderr, /--kind input/, input.stderr)
  assert.match(input.stderr, /不接受选项/, input.stderr)

  // usage 失败必须早于任何 core 写：台账目录与 manifest 都不得变化。
  assert.deepEqual(decisionIds(root), decisionsBefore, '被拒的调用不得留下决策记录')
  assert.equal(
    manifestText(root),
    manifestBefore,
    '被拒的调用不得改写 manifest',
  )
})

test('approval/input 不带 --option 仍成功：approval 固定选项、input 无选项', () => {
  const root = freshProject('accept')

  const approval = runCli(root, [
    '--json',
    'decision', 'ask',
    '--question', 'probe-ok',
    '--kind', 'approval',
    '--rationale', 'r',
  ])
  assert.equal(approval.code, 0, approval.stdout + approval.stderr)
  const approvalRecord = parseJson(approval.stdout).data.decision
  assert.equal(approvalRecord.kind, 'approval')
  assert.deepEqual(approvalRecord.options.map((option) => option.id), ['approve', 'reject'])

  const input = runCli(root, [
    '--json',
    'decision', 'ask',
    '--question', 'probe-input-ok',
    '--kind', 'input',
    '--rationale', 'r',
  ])
  assert.equal(input.code, 0, input.stdout + input.stderr)
  const inputRecord = parseJson(input.stdout).data.decision
  assert.equal(inputRecord.kind, 'input')
  assert.deepEqual(inputRecord.options, [])
})

test('choice 带 --option 的合法路径不受影响：两个选项原样落账', () => {
  const root = freshProject('choice')
  const result = runCli(root, [
    '--json',
    'decision', 'ask',
    '--question', '选哪个',
    '--kind', 'choice',
    '--option', 'a=甲>>影响甲',
    '--option', 'b=乙>>影响乙',
    '--recommendation', 'a',
    '--rationale', 'r',
  ])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const record = parseJson(result.stdout).data.decision
  assert.equal(record.kind, 'choice')
  assert.deepEqual(record.options.map((option) => option.id), ['a', 'b'])
  assert.deepEqual(record.options.map((option) => option.label), ['甲', '乙'])
})
