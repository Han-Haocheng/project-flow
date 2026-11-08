// 模块写域守卫（2026-11-08，整体框架会话）。
//
// 背景：并行会话（任务 / 决策 / 心跳 / 描述）都在改同一批共享文件
// （`lib/core.mjs`、`index.js`、`client.js`、`CONTRACT.md`），此前只有
// 「依赖无环」与「§1.1 覆盖 lib 文件」两条守卫，没有任何机械手段回答
// 「这个改动该不该由本模块写」。
//
// 本文件守两层：
//   ① 数据完整性：`docs/module-domain.json` 覆盖实际文件、锚点存在且顺序正确、
//      共享文件都有 owns 归属 —— 交给 `scripts/module-domain.mjs verify`；
//   ② 边界真的会咬人：`check --module` 对越界文件必须 exit 1，对自有文件 exit 0。
//      没有 ② 的话，verify 坏了也会"绿"（脚本解析失败返回空集合的经典假绿）。
//
// 只测脚本的对外契约，不复制它的匹配算法——算法只有一处真源。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(REPO, 'scripts', 'module-domain.mjs')
const DATA_FILE = path.join(REPO, 'docs', 'module-domain.json')

/** 跑哨兵脚本，返回 { status, stdout, stderr }（永远不抛）。 */
function run(args, input) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    input,
  })
  if (result.error) return { status: -1, stdout: '', stderr: String(result.error.message) }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
const modules = data.modules

test('写域数据可被 verify 完整通过（覆盖 / 锚点 / 幽灵文件）', () => {
  const result = run(['verify'])
  assert.equal(result.status, 0, `verify 失败：\n${result.stderr}`)
  assert.match(result.stdout, /module-domain verify：OK/)
})

test('每个有源码职责的模块都登记了独占文件', () => {
  // heartbeats 没有独立源码文件（全在 core/index 的区段里），显式跳过而不是假装通过。
  const fileless = new Set(['heartbeats'])
  for (const name of Object.keys(modules)) {
    if (fileless.has(name)) {
      assert.ok((modules[name].owns ?? []).length === 0, `${name} 声称无独占文件，却登记了 owns`)
      continue
    }
    assert.ok((modules[name].owns ?? []).length > 0, `模块 ${name} 没有任何独占文件`)
  }
})

test('关键归属不漂移（抽五个最容易被误改的文件）', () => {
  const expectations = [
    ['tasks', 'lib/stage.mjs'],
    ['tasks', 'lib/capture.mjs'],
    ['decisions', 'lib/veto.mjs'],
    ['description', 'lib/desc.mjs'],
    ['panel', 'lib/state-snapshot.mjs'],
    ['store', 'lib/core.mjs'],
    ['framework', 'index.js'],
  ]
  for (const [moduleName, file] of expectations) {
    assert.ok((modules[moduleName].owns ?? []).includes(file), `${moduleName} 应独占 ${file}`)
  }
})

test('共享写域只出现在别的模块的 owns 里（不得自共享）', () => {
  for (const [name, mod] of Object.entries(modules)) {
    for (const entry of mod.shared ?? []) {
      const ownHit = (mod.owns ?? []).some((own) => (own.endsWith('/') ? entry.startsWith(own) : entry === own))
      assert.equal(ownHit, false, `${name} 的 owns 与 shared 同时包含 ${entry}`)
    }
  }
})

test('越界文件被 check 判红（exit 1），自有文件判绿（exit 0）', () => {
  const foreign = run(['check', '--module', 'tasks', '--files', 'lib/desc.mjs'])
  assert.equal(foreign.status, 1, `任务模块改描述模块的文件应判红，实际 status=${foreign.status}\n${foreign.stdout}${foreign.stderr}`)
  assert.match(foreign.stderr, /1 个越界文件/)

  const owned = run(['check', '--module', 'tasks', '--files', 'lib/stage.mjs'])
  assert.equal(owned.status, 0, `任务模块改自己的文件应判绿，实际 status=${owned.status}\n${owned.stdout}${owned.stderr}`)
  assert.match(owned.stdout, /owned\s+lib\/stage\.mjs/)
})

test('共享文件被识别为 shared 并给出可改区段', () => {
  const result = run(['check', '--module', 'tasks', '--files', 'lib/core.mjs'])
  assert.equal(result.status, 0, `共享文件不应判越界：${result.stderr}`)
  assert.match(result.stdout, /shared\s+lib\/core\.mjs/)
  assert.match(result.stdout, /tasks/)
})

test('matrix 打印全部模块', () => {
  const result = run(['matrix'])
  assert.equal(result.status, 0, result.stderr)
  for (const name of Object.keys(modules)) {
    assert.ok(result.stdout.includes(name), `matrix 缺模块 ${name}`)
  }
})
