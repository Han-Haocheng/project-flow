// T-20261030-15：CLI 每命令参数白名单（SPEC）+ 未声明 flag 拒绝 + id 对齐。
//
// 只使用 os.tmpdir() 下的一次性项目；用真实 CLI（spawnSync bin/flow.mjs）验证
// 退出码、错误消息与「失败发生在任何 core 写之前」（未初始化 root 不产生 .dsh）。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initProject, loadContract } from '../lib/core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flow-spec-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function freshProject(label, options = {}) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true, ...options })
  return root
}

function runCli(cwd, args) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** SPEC literal from bin source (the table is exported but importing bin runs main). */
function specFromSource() {
  const start = BIN_SOURCE.indexOf('export const SPEC = Object.freeze({')
  assert.ok(start > 0, 'SPEC 表未找到')
  const open = BIN_SOURCE.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let index = open; index < BIN_SOURCE.length; index += 1) {
    const char = BIN_SOURCE[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) { end = index + 1; break }
    }
  }
  assert.ok(end > open, 'SPEC 表括号不配对')
  // SPEC 里只有纯字面量：用 Function 求值（不是生产路径，仅测试读取）。
  return new Function(`return (${BIN_SOURCE.slice(open, end)})`)()
}

function collectSpecFlags(spec) {
  const soft = new Set()
  const repeat = new Set()
  const entries = []
  const walk = (command, action, entry) => {
    for (const name of Array.isArray(entry.flags) ? entry.flags : []) soft.add(name)
    for (const name of Array.isArray(entry.repeat) ? entry.repeat : []) repeat.add(name)
    entries.push({ command, action, flags: entry.flags ?? [], repeat: entry.repeat ?? [] })
  }
  for (const [command, entry] of Object.entries(spec)) {
    if (Object.hasOwn(entry, 'flags')) walk(command, undefined, entry)
    else for (const [action, sub] of Object.entries(entry)) walk(command, action, sub)
  }
  return { soft, repeat, entries }
}

// ------------------------------------------------------------ 未声明 flag 矩阵
const UNDECLARED = [
  ['status', ['status', '--title', 'x'], '--title'],
  ['init', ['init', '--title', 'x'], '--title'],
  ['exp list', ['exp', 'list', '--status', 'open'], '--status'],
  ['exp list', ['exp', 'list', '--limit', '3'], '--limit'],
  ['exp add', ['exp', 'add', '--learned', 'L'], '--learned'],
  ['task add', ['task', 'add', '--title', 'x', '--allow', 'src'], '--allow'],
  ['task add', ['task', 'add', '--title', 'x', '--metrics', '{}'], '--metrics'],
  ['task list', ['task', 'list', '--title', 'x'], '--title'],
  ['gate run', ['gate', 'run', '--id', 'g', '--allow', 'src'], '--allow'],
  ['heartbeat status', ['heartbeat', 'status', '--title', 'x'], '--title'],
  ['decision list', ['decision', 'list', '--allow', 'src'], '--allow'],
  ['check list', ['check', 'list', '--marker', 'm'], '--marker'],
]

test('未声明 flag：每命令 exit 1、点名 flag、且在任何 core 写之前失败（root 无 .dsh）', () => {
  for (const [label, args, flag] of UNDECLARED) {
    const root = tempRoot('reject')
    const result = runCli(root, [...args])
    // check 子命令沿用检查词汇：usage 错误按 §6 是 exit 2，其余命令是 exit 1。
    const expected = args[0] === 'check' ? 2 : 1
    assert.equal(result.code, expected, `${label} ${flag}: 应 exit ${expected}，实际 ${result.code}\n${result.stderr}`)
    assert.match(result.stderr, new RegExp(`不支持 ${flag}`), `${label}: 错误消息应点名 ${flag}\n${result.stderr}`)
    assert.match(result.stderr, /可用：/, `${label}: 错误消息应列出可用 flag`)
    assert.equal(fs.existsSync(path.join(root, '.dsh')), false, `${label}: 失败前不得创建 store`)
  }
})

test('未声明 flag（通过 = 提供的值）同样被拒；已初始化项目也不写盘', () => {
  const root = freshProject('reject-init')
  const before = fs.readFileSync(path.join(root, '.dsh/flow/flow.json'), 'utf8')
  const result = runCli(root, ['task', 'add', '--title', 'x', '--allow', 'src'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /task add 不支持 --allow/)
  assert.equal(fs.readFileSync(path.join(root, '.dsh/flow/flow.json'), 'utf8'), before, 'conflict/usage 前不得改写 manifest')
})

// ------------------------------------------------------------ 已声明组合回归
test('已声明组合：task/exp/gate/heartbeat/decision/check 的合法 flag 仍 rc0', () => {
  const root = freshProject('accept', { noGates: false })
  const cases = [
    ['task add', ['task', 'add', '--title', '任务一', '--id', 'T-20261105-01', '--owner', 'lead', '--goal', 'g', '--notes', 'n']],
    ['task add parent', ['task', 'add', '--title', '子任务', '--parent', 'T-20261105-01']],
    ['task update', ['task', 'update', 'T-20261105-01', '--status', 'active', '--notes', 'n2']],
    ['exp add', ['exp', 'add', '--id', 'E-20261105-01', '--title', '实验', '--hypothesis', 'H', '--direction', 'D',
      '--expected', 'E', '--primary-metric', 'M', '--guardrail', 'p95', '--guardrail', 'err', '--falsify', 'F',
      '--window-days', '7', '--stop-loss', 'S']],
    ['exp update', ['exp', 'update', 'E-20261105-01', '--learned', 'L', '--status', 'inconclusive']],
    ['gate add', ['gate', 'add', '--id', 'g1', '--title', 'G', '--phase', 'release', '--step', 'ok=true>>exit 0']],
    ['gate update', ['gate', 'update', 'g1', '--enabled', 'false']],
    ['gate logs', ['gate', 'logs', 'g1', '--limit', '3']],
    ['heartbeat list', ['heartbeat', 'list', '--all']],
    ['heartbeat gc', ['heartbeat', 'gc', '--dry-run']],
    ['decision gc', ['decision', 'gc', '--days', '3650', '--dry-run']],
    ['decision list', ['decision', 'list', '--open', '--all']],
    ['check list', ['check', 'list']],
    ['exp list', ['exp', 'list']],
    ['task list', ['task', 'list']],
  ]
  for (const [label, args] of cases) {
    const result = runCli(root, args)
    assert.equal(result.code, 0, `${label} 应 rc0，实际 ${result.code}\n${result.stdout}\n${result.stderr}`)
  }
})

test('全局 flag 放行；--help 优先于未知 flag / 未用 flag', () => {
  const root = freshProject('help')
  assert.equal(runCli(root, ['--root', root, '--json', 'task', 'list']).code, 0)
  const unknownHelp = runCli(root, ['nope', '--help'])
  assert.equal(unknownHelp.code, 0)
  assert.match(unknownHelp.stdout, /用法/)
  const badFlagHelp = runCli(root, ['task', 'add', '--allow', 'src', '--help'])
  assert.equal(badFlagHelp.code, 0)
  assert.match(badFlagHelp.stdout, /用法/)
  const shortHelp = runCli(root, ['exp', 'list', '-h'])
  assert.equal(shortHelp.code, 0)
  assert.match(shortHelp.stdout, /用法/)
})

// ------------------------------------------------------------ id 对齐（验收）
test('task add --id 与 exp add --id：显式 id 成功；冲突/非法 → exit 2', () => {
  const root = freshProject('ids')
  const task = runCli(root, ['task', 'add', '--title', '显式', '--id', 'T-20261105-01', '--json'])
  assert.equal(task.code, 0, task.stdout + task.stderr)
  assert.match(task.stdout, /T-20261105-01/)

  const dup = runCli(root, ['task', 'add', '--title', '重复', '--id', 'T-20261105-01', '--json'])
  assert.equal(dup.code, 2, '重复 id 必须 conflict/invalid')

  const exp = runCli(root, ['exp', 'add', '--id', 'E-20261105-01', '--title', 'E', '--hypothesis', 'H',
    '--direction', 'D', '--expected', 'E', '--primary-metric', 'M', '--guardrail', 'g', '--falsify', 'F',
    '--window-days', '7', '--stop-loss', 'S', '--json'])
  assert.equal(exp.code, 0, exp.stdout + exp.stderr)
  assert.match(exp.stdout, /E-20261105-01/)
})

// ------------------------------------------------------------ SPEC ↔ handler 一致性
test('SPEC 与 handler 双向一致：declared ⊆ source；handler 读取的 flag ⊆ declared；dispatch 命令都在 SPEC', () => {
  const spec = specFromSource()
  const { soft, repeat, entries } = collectSpecFlags(spec)

  // 每个声明的 flag 都在源码里真实出现（SPEC 之外还至少一处）。
  for (const flag of [...soft, ...repeat]) {
    const occurrences = BIN_SOURCE.split(`'${flag}'`).length - 1
    assert.ok(occurrences >= 2, `SPEC 声明了 --${flag}，但 handler/usage 里找不到使用`)
  }

  // handler 里所有 `readString(flags, 'x')` / `flags['x']` / `flags.x` 都必须被某个 SPEC 条目声明。
  const reads = new Set()
  for (const match of BIN_SOURCE.matchAll(/read(?:String|List|Integer|PositiveInteger|JsonObject|PositiveInteger)\(\s*flags,\s*'([^']+)'/g)) reads.add(match[1])
  for (const match of BIN_SOURCE.matchAll(/flags\['([^']+)'\]/g)) reads.add(match[1])
  for (const match of BIN_SOURCE.matchAll(/flags\.([A-Za-z][A-Za-z0-9_-]*)/g)) reads.add(match[1])
  const declared = new Set([...soft, ...repeat])
  const RESERVED = new Set(['length', 'name', 'prototype', 'constructor', 'hasOwnProperty', 'toString', 'valueOf'])
  for (const flag of reads) {
    if (RESERVED.has(flag)) continue
    if (['help', 'json', 'root', 'force', 'all', 'note', 'session'].includes(flag)) continue
    assert.ok(declared.has(flag), `handler 读取了 --${flag}，但 SPEC 没声明（会被误拒）`)
  }

  // dispatch 的每个 command 都要有 SPEC 条目。
  const commands = new Set()
  for (const match of BIN_SOURCE.matchAll(/case '([a-z]+)':\n\s*return cmd[A-Z]/g)) commands.add(match[1])
  for (const command of commands) {
    if (command === 'init') continue
    assert.ok(Object.hasOwn(spec, command), `dispatch 命令 ${command} 缺少 SPEC 条目`)
  }
  assert.ok(entries.length >= 30, `SPEC 条目过少：${entries.length}`)
})
