// T-20261104-12 B2：CLI + 工具面的实验分流（schema2 七字段 / review / productize /
// cleanup / task --experiment / check experiments / 六态计数）。
//
// 全部用真实 CLI（spawnSync bin/flow.mjs）验证参数、退出码、JSON 形状与落盘结果；
// core 的字段校验与分流规则由 B1 的 test/core.test.mjs 覆盖，这里只覆盖 CLI 面。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initProject } from '../lib/core.mjs'
import { apply } from '../index.js'

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

// ------------------------------------------------------------------ helpers
function initRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-b2-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  return root
}

function bareRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-b2-${label}-`))
  TEMP_ROOTS.push(root)
  return root
}

/** Minimal plugin ctx double: registers the flow_* tools (same shape as host wiring). */
function pluginCtx({ root }) {
  const registeredTools = new Map()
  const services = {
    webServer: { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:4021' },
    tools: { register: (definition) => { registeredTools.set(definition.name, definition); return () => {} } },
    skills: { register: () => () => {} },
    workingDirectory: { get: () => root },
    workspaceRegistry: { list: () => [{ path: root, title: path.basename(root) }] },
  }
  const ctx = {
    get: (name) => services[name],
    effect: (fn) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on: () => () => {},
    logger: { warn() {} },
  }
  return { ctx, registeredTools }
}

function runCli(cwd, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' })
  let json = null
  const text = result.stdout.trim()
  if (text.startsWith('{')) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

const SEVEN = [
  '--hypothesis', 'H',
  '--direction', '降低 tie 率',
  '--expected', 'tie_mean<=1.0',
  '--primary-metric', 'tie_mean',
  '--guardrail', 'p95_ms',
  '--falsify', 'tie_mean>1.05',
  '--window-days', '7',
  '--stop-loss', 'p95 恶化 >10%',
]

function addExperiment(root, extra = []) {
  const result = runCli(root, ['exp', 'add', '--title', '实验', ...SEVEN, ...extra, '--json'])
  assert.equal(result.code, 0, `exp add 失败：${result.stderr}\\n${result.stdout}`)
  return result.json.data
}

function enableExperiments(root) {
  const file = path.join(root, '.dsh', 'flow', 'flow.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  manifest.experiments = { ...(manifest.experiments ?? {}), enabled: true }
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2))
}

function addReleaseGate(root) {
  const add = runCli(root, [
    'gate', 'add', '--id', 'release', '--title', '发布门禁', '--phase', 'release',
    '--step', 'ok=true>>exit 0',
  ])
  assert.equal(add.code, 0, add.stderr)
}

// ------------------------------------------------------------ seven fields
test('exp add：缺七字段 → exit 2 且点名缺失键；window-days 非正整数 → 2', () => {
  const root = initRoot('fields')
  const missing = runCli(root, ['exp', 'add', '--title', 'T'])
  assert.equal(missing.code, 2)
  for (const key of ['direction', 'expected', 'primaryMetric', 'guardrails', 'falsify', 'windowDays', 'stopLoss']) {
    assert.match(missing.stderr, new RegExp(key), `错误信息应点名 ${key}：${missing.stderr}`)
  }
  const badWindow = runCli(root, ['exp', 'add', '--title', 'T', ...SEVEN.slice(0, -2), '--window-days', '0', '--stop-loss', 'S'])
  assert.equal(badWindow.code, 2)
  assert.match(badWindow.stderr, /window-days/)
})

test('exp review：只读自查返回 verdict/branch/missing，恒 exit 0，不改记录', () => {
  const root = initRoot('review')
  const record = addExperiment(root)
  const before = fs.readFileSync(path.join(root, '.dsh', 'flow', 'experiments', `${record.id}.json`), 'utf8')
  const review = runCli(root, ['exp', 'review', record.id, '--json'])
  assert.equal(review.code, 0)
  assert.equal(review.json.data.verdict, 'complete')
  assert.equal(review.json.data.branch, 'uncertain')
  assert.deepEqual(review.json.data.missing, [])
  const after = fs.readFileSync(path.join(root, '.dsh', 'flow', 'experiments', `${record.id}.json`), 'utf8')
  assert.equal(after, before, 'review 不得写文件')
  // 位置参数等价于 --id
  const byFlag = runCli(root, ['exp', 'review', '--id', record.id])
  assert.equal(byFlag.code, 0)
})

test('exp productize：非 confirmed → 2；gate 时间基准早于确认 → 2；通过后幂等 already', async () => {
  const root = initRoot('productize')
  addReleaseGate(root)
  const gateRun = runCli(root, ['gate', 'run', 'release'])
  assert.equal(gateRun.code, 0)
  const record = addExperiment(root)

  const openCall = runCli(root, ['exp', 'productize', record.id])
  assert.equal(openCall.code, 2)
  assert.match(openCall.stderr, /confirmed/)

  // 时间戳只到秒：等过一秒，确保 confirmed 的 updated_at 晚于门禁 run 的 finished_at。
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const confirm = runCli(root, ['exp', 'update', record.id, '--status', 'confirmed', '--measured', 'ok', '--metrics', '{"tie":0.9}'])
  assert.equal(confirm.code, 0, confirm.stderr)

  // 确认发生在 gate run 之后 → 时间基准不满足。
  const early = runCli(root, ['exp', 'productize', record.id])
  assert.equal(early.code, 2)
  assert.match(early.stderr, /no passing run finished at\/after/)

  // 重新跑门禁 → 通过，且第二次调用幂等。
  assert.equal(runCli(root, ['gate', 'run', 'release']).code, 0)
  const first = runCli(root, ['exp', 'productize', record.id, '--json'])
  assert.equal(first.code, 0, first.stderr)
  assert.equal(first.json.data.already, false)
  assert.equal(typeof first.json.data.productizedAt, 'string')
  assert.equal(first.json.data.productizeGate.id, 'release')
  const second = runCli(root, ['exp', 'productize', record.id, '--json'])
  assert.equal(second.code, 0)
  assert.equal(second.json.data.already, true)
})

test('exp cleanup：写 cleanup/cleanupAt；schema1 记录 → 2', () => {
  const root = initRoot('cleanup')
  const record = addExperiment(root)
  const cleaned = runCli(root, ['exp', 'cleanup', record.id, '--flag', 'ff1', '--flag', 'ff2', '--code', 'src/x.js', '--data', 'tmp.csv', '--json'])
  assert.equal(cleaned.code, 0, cleaned.stderr)
  assert.deepEqual(cleaned.json.data.cleanup.flags, ['ff1', 'ff2'])
  assert.equal(typeof cleaned.json.data.cleanupAt, 'string')

  // schema1 旧记录只读：直接写一条 legacy 记录后 cleanup 必须 2。
  const legacyId = 'E-20260101-99'
  fs.writeFileSync(
    path.join(root, '.dsh', 'flow', 'experiments', `${legacyId}.json`),
    JSON.stringify({ schema: 1, id: legacyId, title: 'legacy', status: 'refuted', created_at: '2026-01-01T00:00:00+08:00', updated_at: '2026-01-01T00:00:00+08:00' }),
  )
  const legacy = runCli(root, ['exp', 'cleanup', legacyId, '--flag', 'x'])
  assert.equal(legacy.code, 2)
  assert.match(legacy.stderr, /schema1|legacy/)
  const legacyReview = runCli(root, ['exp', 'review', legacyId, '--json'])
  assert.equal(legacyReview.code, 0)
  assert.equal(legacyReview.json.data.verdict, 'incomplete')
  assert.match(JSON.stringify(legacyReview.json.data.missing), /schema2/)
})

// ------------------------------------------------------------ task --experiment
test('task --experiment：格式非法 → 2；不存在 → warning 仍写入；存在 → 正常关联', () => {
  const root = initRoot('task-link')
  const record = addExperiment(root)

  const malformed = runCli(root, ['task', 'add', '--type', 'feat', '--title', 'bad', '--experiment', '1bad'])
  assert.equal(malformed.code, 2)

  const missing = runCli(root, ['task', 'add', '--type', 'feat', '--title', 'missing', '--experiment', 'E-20260101-99', '--json'])
  assert.equal(missing.code, 0)
  assert.equal(missing.json.data.experiment, 'E-20260101-99')
  assert.ok(missing.json.warnings.some((line) => line.includes('task-experiment-missing')))

  const linked = runCli(root, ['task', 'add', '--type', 'feat', '--title', 'linked', '--experiment', record.id, '--json'])
  assert.equal(linked.code, 0)
  assert.equal(linked.json.data.experiment, record.id)
})

// ------------------------------------------------------------ check experiments
test('check experiments：enabled=false 跳过 exit 0；失败 exit 1 + failed[]；warnings 不阻断', () => {
  const root = initRoot('check')
  const disabled = runCli(root, ['check', 'experiments'])
  assert.equal(disabled.code, 0)
  assert.match(disabled.stdout, /experiments.enabled=false|未开启/)

  enableExperiments(root)
  const record = addExperiment(root)
  const confirm = runCli(root, ['exp', 'update', record.id, '--status', 'confirmed', '--measured', 'ok', '--metrics', '{"tie":0.9}'])
  assert.equal(confirm.code, 0, confirm.stderr)
  const failing = runCli(root, ['check', 'experiments', '--json'])
  assert.equal(failing.code, 1)
  assert.ok(failing.json.error.failed.some((item) => item.rule === 'experiment-productize'))

  addReleaseGate(root)
  assert.equal(runCli(root, ['gate', 'run', 'release']).code, 0)
  assert.equal(runCli(root, ['exp', 'productize', record.id]).code, 0)
  const passing = runCli(root, ['check', 'experiments'])
  assert.equal(passing.code, 0)

  // warnings（inconclusive 缺 learned）不阻断。
  const inconclusive = addExperiment(root, ['--title', '不确定'])
  assert.equal(runCli(root, ['exp', 'update', inconclusive.id, '--status', 'inconclusive']).code, 0)
  const warned = runCli(root, ['check', 'experiments', '--json'])
  assert.equal(warned.code, 0)
  assert.ok((warned.json.data?.warnings ?? []).some((line) => String(line.message ?? line).includes('inconclusive')))
})

// ------------------------------------------------------------ 六态计数 / 分流
test('status --json：实验计数含六态（inconclusive/pivoted）；refuted 闭环 review 通过', () => {
  const root = initRoot('counts')
  const refuted = addExperiment(root, ['--title', '被证伪'])
  assert.equal(runCli(root, ['exp', 'update', refuted.id, '--status', 'refuted']).code, 0)
  // refuted 的 learned/cleanup 走 update + cleanup 两个动作闭环。
  assert.equal(runCli(root, ['exp', 'update', refuted.id, '--learned', '假设不成立']).code, 0)
  assert.equal(runCli(root, ['exp', 'cleanup', refuted.id, '--flag', 'ff']).code, 0)
  const review = runCli(root, ['exp', 'review', refuted.id, '--json'])
  assert.equal(review.json.data.verdict, 'complete')
  assert.equal(review.json.data.branch, 'failure')

  const pivotSource = addExperiment(root, ['--title', '转向源'])
  const pivotSuccessor = addExperiment(root, ['--title', '转向目标', '--parent', pivotSource.id])
  assert.equal(runCli(root, ['exp', 'update', pivotSource.id, '--status', 'pivoted', '--learned', '换方向']).code, 0)
  assert.equal(runCli(root, ['exp', 'update', pivotSuccessor.id, '--status', 'inconclusive']).code, 0)

  const status = runCli(root, ['status', '--json'])
  assert.equal(status.code, 0)
  const counts = status.json.data.counts.experiments
  for (const key of ['open', 'confirmed', 'refuted', 'abandoned', 'inconclusive', 'pivoted', 'total']) {
    assert.equal(typeof counts[key], 'number', `counts.experiments.${key} 缺失`)
  }
  assert.equal(counts.refuted, 1)
  assert.equal(counts.pivoted, 1)
  assert.equal(counts.inconclusive, 1)
})

// ------------------------------------------------- tool layer（task-121）
test('flow_exp list（工具层）：counts 六态齐全（含 inconclusive/pivoted），空 store 全零', async () => {
  const root = initRoot('tool-counts')
  const dir = path.join(root, '.dsh', 'flow', 'experiments')
  fs.mkdirSync(dir, { recursive: true })
  const record = (id, status, extra = {}) => ({
    schema: 2,
    id,
    title: `实验 ${id}`,
    hypothesis: 'H',
    direction: 'D',
    expected: 'E',
    primaryMetric: 'M',
    guardrails: ['G'],
    falsify: 'F',
    windowDays: 7,
    stopLoss: 'S',
    status,
    factor: '',
    parent: null,
    scale: 'small',
    measured: '',
    metrics: {},
    commits: [],
    notes: '',
    learned: '',
    cleanup: { flags: [], code: [], data: [] },
    cleanupAt: null,
    productizedAt: null,
    productizeGate: null,
    created_at: '2026-11-01T09:00:00+08:00',
    updated_at: '2026-11-01T09:00:00+08:00',
    ...extra,
  })
  fs.writeFileSync(path.join(dir, 'E-20261101-01.json'), JSON.stringify(record('E-20261101-01', 'open')))
  fs.writeFileSync(path.join(dir, 'E-20261101-02.json'), JSON.stringify(record('E-20261101-02', 'inconclusive')))
  fs.writeFileSync(path.join(dir, 'E-20261101-03.json'), JSON.stringify(record('E-20261101-03', 'pivoted', { learned: '换方向' })))
  fs.writeFileSync(path.join(dir, 'E-20261101-04.json'), JSON.stringify(record('E-20261101-04', 'refuted', { learned: '不成立' })))

  const { ctx, registeredTools } = pluginCtx({ root })
  apply(ctx)
  const expTool = registeredTools.get('flow_exp')
  assert.ok(expTool, 'flow_exp 应注册')
  const exec = { agent: { session: { cwd: root } } }

  const listed = await expTool.execute({ action: 'list', root }, exec)
  assert.equal(listed.store, true)
  assert.deepEqual(listed.counts, {
    total: 4,
    open: 1,
    confirmed: 0,
    refuted: 1,
    abandoned: 0,
    inconclusive: 1,
    pivoted: 1,
  })

  const empty = bareRoot('tool-empty')
  const emptyListed = await expTool.execute({ action: 'list', root: empty }, { agent: { session: { cwd: empty } } })
  assert.equal(emptyListed.store, false)
  assert.deepEqual(emptyListed.counts, {
    total: 0,
    open: 0,
    confirmed: 0,
    refuted: 0,
    abandoned: 0,
    inconclusive: 0,
    pivoted: 0,
  })
})
