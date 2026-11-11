// T-20261111155622（P2）：`flow_gate` 工具侧也要能显式开启 expect 容错。
//
// 定义期未知 expect 默认 `invalid` 拒绝；模型工具用户没有 CLI flag，所以补
// `allowUnknownExpect` 布尔参数并透传给 core。它是**选项**，不是门禁记录字段：
// 落盘只写 `step.allowUnknownExpect`，不写 `gate.allowUnknownExpect`。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { apply as applyGates } from '../gates.js'
import { drainWarnings, initProject } from '../lib/core.mjs'

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

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-gate-tool-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  return root
}

/** 只挂 `gates.js` 子插件；工具包装（warnings 合并）走生产 mount 路径。 */
function toolHarness(root) {
  const tools = new Map()
  const services = new Map([
    ['workingDirectory', { get: () => root }],
    ['tools', {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      guard: () => () => {},
    }],
  ])
  const ctx = {
    get: (name) => services.get(name),
    effect: (callback) => {
      callback()
      return () => {}
    },
    logger: { warn() {} },
  }
  applyGates(ctx, {})
  const tool = tools.get('flow_gate')
  assert.ok(tool, 'flow_gate 应已注册')
  return { tool, exec: { agent: { session: { cwd: root } } } }
}

const gateFile = (root, id) => path.join(root, '.agents/gates', `${id}.json`)

test('flow_gate schema：暴露 allowUnknownExpect 布尔参数（add/update 选项）', () => {
  const { tool } = toolHarness(freshProject('schema'))
  const prop = tool.parameters.properties.allowUnknownExpect
  assert.equal(prop?.type, 'boolean')
  assert.match(prop.description, /unknown/i)
  assert.match(prop.description, /add\/update/)
})

test('flow_gate add：未知 expect 默认 reject（invalid），不落盘', async () => {
  const root = freshProject('reject')
  const { tool, exec } = toolHarness(root)
  await assert.rejects(
    () => tool.execute({
      action: 'add',
      id: 'tg',
      title: 'G',
      phase: 'manual',
      steps: [{ run: 'true', expect: 'exit:1' }],
    }, exec),
    (error) => error.code === 'invalid'
      && /步骤 "step-1"/.test(error.message)
      && /"exit:1"/.test(error.message)
      && /--allow-unknown-expect/.test(error.message)
      && /allowUnknownExpect/.test(error.message),
  )
  assert.equal(fs.existsSync(gateFile(root, 'tg')), false, '被拒的定义不得落盘')
})

test('flow_gate add：allowUnknownExpect:true 才放行，落 step 标记并返回定义期 warning', async () => {
  const root = freshProject('allow')
  const { tool, exec } = toolHarness(root)
  drainWarnings()
  const result = await tool.execute({
    action: 'add',
    id: 'tg',
    title: 'G',
    phase: 'manual',
    steps: [{ run: 'true', expect: 'exit:1' }],
    allowUnknownExpect: true,
  }, exec)

  assert.equal(result.gate.steps[0].allowUnknownExpect, true)
  assert.equal(result.gate.allowUnknownExpect, undefined, '开关是选项，不得写成门禁记录字段')
  assert.ok(
    Array.isArray(result.warnings) && result.warnings.some((item) => item.startsWith('gate-expect-unknown:')),
    JSON.stringify(result.warnings),
  )
  const onDisk = JSON.parse(fs.readFileSync(gateFile(root, 'tg'), 'utf8'))
  assert.equal(onDisk.steps[0].allowUnknownExpect, true)
  assert.equal(onDisk.allowUnknownExpect, undefined)
})

test('flow_gate update：默认拒绝非法 expect 且不落盘；显式开关才接受', async () => {
  const root = freshProject('update')
  const { tool, exec } = toolHarness(root)
  await tool.execute({
    action: 'add',
    id: 'tg',
    title: 'G',
    phase: 'manual',
    steps: [{ run: 'true', expect: 'exit 0' }],
  }, exec)
  const before = fs.readFileSync(gateFile(root, 'tg'), 'utf8')

  await assert.rejects(
    () => tool.execute({ action: 'update', id: 'tg', steps: [{ run: 'false', expect: 'exit:abc' }] }, exec),
    (error) => error.code === 'invalid' && /allowUnknownExpect/.test(error.message),
  )
  assert.equal(fs.readFileSync(gateFile(root, 'tg'), 'utf8'), before, '被拒的 update 不得落盘')

  const accepted = await tool.execute({
    action: 'update',
    id: 'tg',
    steps: [{ run: 'false', expect: 'exit:abc' }],
    allowUnknownExpect: true,
  }, exec)
  assert.equal(accepted.gate.steps[0].allowUnknownExpect, true)
})

test('flow_gate：allowUnknownExpect 只属于 add/update，传给其他动作即 invalid', async () => {
  const root = freshProject('action')
  const { tool, exec } = toolHarness(root)
  await assert.rejects(
    () => tool.execute({ action: 'list', allowUnknownExpect: true }, exec),
    /does not accept "allowUnknownExpect"/,
  )
})
