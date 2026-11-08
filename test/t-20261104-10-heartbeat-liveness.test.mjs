// T-20261104-10 卡 B：心跳存活语义的消费面回归（CLI / TUI / core 接口）。
//
// 只使用 os.tmpdir() 下的一次性项目。index.js 的 GET state 投影与 agents 正向
// 证据用例在卡 A 的 index.js 解冻后追加到本文件末尾（见文件尾部 TODO 段）。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { initProject, livenessOf, loadContract, readHeartbeatSection, startHeartbeat } from '../lib/core.mjs'
import { panelModel } from '../tui-panel.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')
const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flow-liveness-${label}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function freshProject(label) {
  const root = tempRoot(label)
  initProject(root, { name: label, noGates: true })
  const { contract } = loadContract(root)
  return { root, contract }
}

function runCli(cwd, args, env = {}) {
  const childEnv = {
    ...process.env,
    DSH_SESSION_ID: Object.hasOwn(env, 'DSH_SESSION_ID') ? env.DSH_SESSION_ID : '',
  }
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: childEnv })
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

/** A real, already-reaped pid: `kill(pid, 0)` fails, so liveness must be dead. */
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', ''])
  assert.equal(typeof result.pid, 'number')
  assert.throws(() => process.kill(result.pid, 0), `helper pid ${result.pid} should be reaped`)
  return result.pid
}

function heartbeatFile(root, session) {
  return path.join(root, '.agents', 'heartbeat', `${session}.json`)
}

/** Write one heartbeat JSON record (with optional age backdating of updated_at). */
function writeHeartbeat(root, session, record) {
  const dir = path.join(root, '.agents', 'heartbeat')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(heartbeatFile(root, session), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return heartbeatFile(root, session)
}

/** Start a host-form heartbeat (real host/pid evidence) and optionally mutate it. */
function hostHeartbeat(root, contract, session, overrides = {}) {
  const record = startHeartbeat(root, contract, { session, createTask: false, goal: session })
  return { ...record, ...overrides }
}

// ------------------------------------------------------------------ core API

test('livenessOf 返回对象：dead 会话的 verdict/reason/counts.dead 与 core 契约一致', () => {
  const { root, contract } = freshProject('api')
  const live = hostHeartbeat(root, contract, 'live-session')
  const dead = { ...live, session: 'dead-session', pid: deadPid(), updated_at: new Date().toISOString() }
  writeHeartbeat(root, 'dead-session', dead)

  const verdict = livenessOf(dead)
  assert.equal(typeof verdict, 'object')
  assert.equal(verdict.liveness, 'dead')
  assert.equal(verdict.reason, 'pid-gone')
  assert.ok(Number.isFinite(verdict.ageSeconds))
  assert.equal(livenessOf(live).liveness, 'live')

  const visibleSection = readHeartbeatSection(root, contract)
  assert.equal(visibleSection.counts.total, 2)
  assert.equal(visibleSection.counts.active, 1, 'dead 会话不计 active')
  assert.equal(visibleSection.counts.dead, 1)
  assert.deepEqual(visibleSection.items.map((item) => item.file), ['live-session.json'], 'dead 默认隐藏')
  assert.equal(visibleSection.hiddenByVisibility, 1)

  const section = readHeartbeatSection(root, contract, { visibility: 'all' })
  assert.equal(section.items.find((item) => item.file === 'dead-session.json').liveness, 'dead')
})

// ----------------------------------------------------------------------- CLI

test('bin heartbeat list：显示 dead 计数、存活列与「已结束」清单', () => {
  const { root, contract } = freshProject('cli-list')
  const live = hostHeartbeat(root, contract, 'live-session')
  writeHeartbeat(root, 'dead-session', {
    ...live, session: 'dead-session', pid: deadPid(), updated_at: new Date().toISOString(),
  })

  const text = runCli(root, ['heartbeat', 'list'])
  assert.equal(text.code, 0, text.stderr)
  assert.match(text.stdout, /dead 1/, '计数口径不变：dead 仍计入')
  assert.ok(!text.stdout.includes('dead-session.json'), '默认不列 dead 行')
  assert.ok(!text.stdout.includes('已结束（dead）'), '默认不打印 dead 清单')
  assert.match(text.stdout, /已隐藏 1 条（已结束\/可能已停，--all 查看）/, text.stdout)
  assert.match(text.stdout, /存活/, 'list 表头应有存活列')

  const json = runCli(root, ['heartbeat', 'list', '--json'])
  assert.equal(json.code, 0)
  assert.equal(json.json.data.counts.dead, 1)
  assert.equal(json.json.data.counts.active, 1)
  assert.equal(json.json.data.hiddenByVisibility, 1)
  const visible = json.json.data.items.map((item) => item.file)
  assert.deepEqual(visible, ['live-session.json'], '默认 items 只有可见行')

  const all = runCli(root, ['heartbeat', 'list', '--all', '--json'])
  assert.equal(all.code, 0)
  assert.equal(all.json.data.hiddenByVisibility, 0)
  const items = Object.fromEntries(all.json.data.items.map((item) => [item.file, item]))
  assert.equal(items['dead-session.json'].liveness, 'dead')
  assert.equal(items['live-session.json'].liveness, 'live')
  const allText = runCli(root, ['heartbeat', 'list', '--all'])
  assert.match(allText.stdout, /已结束（dead）：dead-session\.json/, allText.stdout)
})

test('bin heartbeat status：输出存活 verdict；--require-active 对 dead 会话退出 1', () => {
  const { root, contract } = freshProject('cli-status')
  const live = hostHeartbeat(root, contract, 'target')
  writeHeartbeat(root, 'target', {
    ...live, pid: deadPid(), status: 'working', updated_at: new Date().toISOString(),
  })

  const human = runCli(root, ['heartbeat', 'status', '--session', 'target'])
  assert.equal(human.code, 0, human.stderr)
  assert.match(human.stdout, /存活\s+dead（pid-gone）/, human.stdout)

  const required = runCli(root, ['heartbeat', 'status', '--session', 'target', '--require-active', '--json'])
  assert.equal(required.code, 1, required.stdout)
  assert.equal(required.json.ok, false)
  assert.equal(required.json.error.code, 'usage')
  assert.match(required.json.error.message, /存活 dead（pid-gone）/, required.json.error.message)

  // 活会话仍 exit 0（回归：别把正常会话拦掉）。
  hostHeartbeat(root, contract, 'alive')
  const alive = runCli(root, ['heartbeat', 'status', '--session', 'alive', '--require-active', '--json'])
  assert.equal(alive.code, 0, alive.stdout)
  assert.equal(alive.json.data.liveness, 'live')
})

// ----------------------------------------------------------------------- TUI

function tuiFixture(heartbeats) {
  return {
    ok: true,
    contract: { source: '.agents/flow/flow.json', schema: 2, name: 'tui' },
    tasks: { total: 0, counts: {}, active: [], draft: [], recentDone: [] },
    experiments: { total: 0, items: [] },
    gates: [],
    heartbeats,
    decisions: { items: [], counts: { open: 0 } },
    warnings: [],
  }
}

test('TUI：dead 心跳不再算 working，行用 × + 已结束 + error tone', () => {
  const model = panelModel(tuiFixture([
    { file: 'dead.json', session: 'dead', status: 'working', liveness: 'dead', reason: 'pid-gone', goal: '死会话', ageSeconds: 5 },
    { file: 'live.json', session: 'live', status: 'working', liveness: 'live', reason: 'pid-alive', goal: '活会话', ageSeconds: 5 },
  ]), { width: 80, height: 40, now: Date.now() })
  const section = model.sections.find((item) => item.title === '心跳')
  assert.ok(section, '缺少心跳段')
  const texts = section.rows.map((row) => row.text)
  assert.equal(texts[0], '活跃 1 · 已结束 1 / 共 2', texts.join(' | '))
  const deadRow = section.rows.find((row) => row.text.includes('死会话'))
  assert.equal(deadRow, undefined, 'T-13：dead 行默认隐藏')
  const liveRow = section.rows.find((row) => row.text.includes('活会话'))
  assert.ok(liveRow.text.startsWith('▶'), liveRow.text)
  assert.equal(liveRow.tone, 'accent')
  assert.ok(texts.some((text) => text.includes('+1 条已隐藏（--all 见 CLI）')), texts.join(' | '))
})

test('TUI：旧记录（无 liveness 字段）行为同今日，仍按 status 显示', () => {
  const model = panelModel(tuiFixture([
    { file: 'legacy.json', session: 'legacy', status: 'working', goal: '旧记录', ageSeconds: 5 },
  ]), { width: 80, height: 40, now: Date.now() })
  const section = model.sections.find((item) => item.title === '心跳')
  assert.equal(section.rows[0].text, '活跃 1 / 共 1', 'dead=0 时不再输出「已结束 0」')
  assert.ok(section.rows.some((row) => row.text.startsWith('▶')))
  assert.equal(section.rows.slice(1).some((row) => row.text.includes('已结束')), false)
})

test('client.js 接线：dead 会话用 hb-dead chip 替代 working，头部计数含 dead', () => {
  const source = fs.readFileSync(path.resolve(HERE, '..', 'client.js'), 'utf8')
  assert.ok(source.includes("'hb.status.dead'"), '缺少 dead 文案 key')
  assert.ok(source.includes('project-flow-chip--hb-dead'), '缺少 dead chip 样式')
  assert.ok(source.includes("dead: asNumber(countsSrc.dead"), 'counts.dead 未透传')
  assert.ok(source.includes("beat.liveness === 'dead'"), 'dead 判定未接 liveness')
  assert.ok(source.includes("t('hb.counts', { active: hbActive, dead: hbDead, total: hbTotal })"), '头部计数未带 dead')
  assert.ok(source.includes("Chip, { tone: 'hb-dead' }"), 'dead 行仍走 working chip')
})

// ----------------------------------------------- index.js 消费面（T-10 卡B）

const ROOT = path.resolve(HERE, '..')
let pluginPromise = null

/** Import the host half once (dynamic: the file is not a static dependency). */
function plugin() {
  if (pluginPromise === null) pluginPromise = import('../index.js')
  return pluginPromise
}

/** Minimal host `agents` service double: roots/list/get all report these ids. */
function liveAgents(ids) {
  const list = ids.map((id) => ({ id }))
  return {
    roots: () => list,
    list: () => list,
    get: (id) => list.find((agent) => agent.id === id),
  }
}

/** Minimal Cordis ctx: service map + immediate effects (disposed by disposeAll). */
function makeCtx({ root, agents, tools } = {}) {
  const services = new Map()
  const routes = new Map()
  const disposers = []
  const webServer = {
    getOrigin: () => 'http://127.0.0.1:3080',
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  services.set('webServer', webServer)
  services.set('workspaceRegistry', { list: () => [] })
  services.set('workingDirectory', { get: () => root })
  if (agents !== undefined) services.set('agents', agents)
  if (tools !== undefined) services.set('tools', tools)
  const ctx = {
    get(name) {
      return services.get(name)
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    logger: { warn() {} },
  }
  return {
    ctx,
    routes,
    disposeAll() {
      while (disposers.length > 0) {
        try {
          disposers.pop()()
        } catch {
          // disposal must never fail the test
        }
      }
    },
  }
}

async function panelPayload(ctx, root) {
  const mod = await plugin()
  return await mod.panelStateReader(ctx)(root)
}

function heartbeatRow(payload, session) {
  const rows = Array.isArray(payload.heartbeats) ? payload.heartbeats : []
  return rows.find((item) => item.session === session)
}

test('GET state：dead 心跳带 liveness/reason，TUI 视图不计入 working', async () => {
  const { root, contract } = freshProject('state-dead')
  const live = hostHeartbeat(root, contract, 'live-session')
  writeHeartbeat(root, 'dead-session', {
    ...live, session: 'dead-session', pid: deadPid(), updated_at: new Date().toISOString(),
  })

  const host = makeCtx({ root })
  try {
    const payload = await panelPayload(host.ctx, root)
    assert.equal(payload.ok, true)
    assert.equal(heartbeatRow(payload, 'dead-session'), undefined, 'GET state 默认 payload 不含 dead 行')
    assert.equal(heartbeatRow(payload, 'live-session').liveness, 'live')
    const core = await import('../lib/core.mjs')
    const all = core.readHeartbeatSection(root, contract, { visibility: 'all' })
    const dead = all.items.find((item) => item.file === 'dead-session.json')
    assert.equal(dead.liveness, 'dead')
    assert.equal(dead.reason, 'pid-gone')
    const model = panelModel(payload, { width: 80, height: 40, now: Date.now() })
    const section = model.sections.find((item) => item.title === '心跳')
    /* T-13 A5/D-14: the dead row is hidden from the list but still counted in the
       total, so 「共 total」 stays honest while the visible rows stay short. */
    assert.equal(payload.heartbeatsHidden, 1, 'the hidden dead row is reported in the payload')
    assert.equal(section.rows[0].text, '活跃 1 / 共 2', 'dead 不回填 payload，也不计入 working，但计入总数')
    const visibleBeats = section.rows.slice(1).filter((entry) => /^[▶×✓·]/.test(entry.text))
    assert.equal(visibleBeats.length, 1, 'only the live session is rendered: ' + visibleBeats.map((entry) => entry.text).join(' | '))
    assert.ok(visibleBeats[0].text.includes('live-session') || visibleBeats[0].text.startsWith('▶'), 'the visible row is the live one')
  } finally {
    host.disposeAll()
  }
})

test('GET state：agents 命中把 >6h 旧心跳标为 live/agent-live；无 agents 时仍 stale', async () => {
  const { root, contract } = freshProject('state-agents')
  writeHeartbeat(root, 'busy-session', {
    session: 'busy-session', status: 'working', goal: '忙',
    updated_at: new Date(Date.now() - 7 * 3_600_000).toISOString(),
  })

  const plain = makeCtx({ root })
  try {
    const before = await panelPayload(plain.ctx, root)
    assert.equal(heartbeatRow(before, 'busy-session'), undefined, 'stale 且无 agents 证据 → 隐藏')
    assert.equal(before.heartbeatsHidden, 1, '被隐藏条数要暴露给面板')
    const core = await import('../lib/core.mjs')
    const all = core.readHeartbeatSection(root, contract, { visibility: 'all' })
    assert.equal(all.items.find((item) => item.file === 'busy-session.json').liveness, 'stale')
  } finally {
    plain.disposeAll()
  }

  // T-13（task-143）：快照取全量 → agents 标注 → 宿主过滤。stale 行在 agents 命中
  // 后变成 live/agent-live，必须**保留**（这是旧串行批次的语义缺口）。
  const file = heartbeatFile(root, 'busy-session')
  const bytesBefore = fs.readFileSync(file, 'utf8')
  const mtimeBefore = fs.statSync(file).mtimeMs
  const withAgents = makeCtx({ root, agents: liveAgents(['busy-session']) })
  try {
    const after = await panelPayload(withAgents.ctx, root)
    const row = heartbeatRow(after, 'busy-session')
    assert.ok(row !== undefined, 'agents 命中的 stale 行不能被隐藏')
    assert.equal(row.liveness, 'live')
    assert.equal(row.reason, 'agent-live')
    assert.equal(after.heartbeatsHidden, 0)
    assert.ok(after.heartbeats.every((item) => item.liveness !== 'dead'), 'dead 行仍不得出现')
  } finally {
    withAgents.disposeAll()
  }
  assert.equal(fs.readFileSync(file, 'utf8'), bytesBefore, '读路径不得改写心跳文件')
  assert.equal(fs.statSync(file).mtimeMs, mtimeBefore, '读路径不得触碰 mtime')
})

test('GET state：agents 命中也不覆盖 dead（pid 证据优先）', async () => {
  const { root, contract } = freshProject('state-dead-agents')
  const live = hostHeartbeat(root, contract, 'crashed-session')
  writeHeartbeat(root, 'crashed-session', { ...live, pid: deadPid(), updated_at: new Date().toISOString() })

  const host = makeCtx({ root, agents: liveAgents(['crashed-session']) })
  try {
    const payload = await panelPayload(host.ctx, root)
    assert.equal(heartbeatRow(payload, 'crashed-session'), undefined, 'dead 默认隐藏（agents 证据也不回填）')
    assert.equal(payload.heartbeatsHidden, 1, 'dead 行计入隐藏条数')
    assert.ok(payload.heartbeats.every((item) => item.liveness !== 'dead'), 'payload 不得携带 dead 行')
  } finally {
    host.disposeAll()
  }
})

test('GET state payload 兼容：heartbeats 仍是行数组，旧记录行为同今日', async () => {
  const { root } = freshProject('state-compat')
  writeHeartbeat(root, 'fresh-legacy', {
    session: 'fresh-legacy', status: 'working', updated_at: new Date().toISOString(),
  })
  writeHeartbeat(root, 'old-legacy', {
    session: 'old-legacy', status: 'working',
    updated_at: new Date(Date.now() - 7 * 3_600_000).toISOString(),
  })

  const host = makeCtx({ root })
  try {
    const payload = await panelPayload(host.ctx, root)
    assert.equal(payload.ok, true)
    assert.ok(Array.isArray(payload.heartbeats), 'heartbeats 仍是行数组（旧 client 兼容）')
    for (const key of ['root', 'roots', 'contract', 'head', 'tasks', 'gates', 'decisions']) {
      assert.ok(Object.hasOwn(payload, key), `GET state 缺少既有字段 ${key}`)
    }
    assert.equal(heartbeatRow(payload, 'fresh-legacy').liveness, 'unknown')
    assert.equal(heartbeatRow(payload, 'old-legacy'), undefined, 'stale 旧记录默认隐藏')
    assert.equal(payload.heartbeatsHidden, 1, 'stale 旧记录计入隐藏条数')
    for (const row of payload.heartbeats) {
      assert.equal(typeof row.liveness, 'string')
      assert.equal(typeof row.reason, 'string')
    }
    const model = panelModel(payload, { width: 80, height: 40, now: Date.now() })
    const section = model.sections.find((item) => item.title === '心跳')
    /* Same rule as above: one fresh row visible, one stale row hidden, total 2. */
    assert.equal(section.rows[0].text, '活跃 1 / 共 2', '只有新鲜旧记录可见，但 total 含隐藏行')
    const visibleBeats = section.rows.slice(1).filter((entry) => /^[▶×✓·]/.test(entry.text))
    assert.equal(visibleBeats.length, 1, 'the hidden stale row must not render a beat line')
    assert.ok(visibleBeats[0].text.includes('fresh-legacy'), 'the fresh legacy row stays visible')
  } finally {
    host.disposeAll()
  }
})

test('session-open 门禁：死会话 heartbeat status --require-active 退出 1 → gate ok=false', () => {
  const root = tempRoot('gate-dead')
  initProject(root, { name: 'gate-dead' }) // seeds session-open / precommit
  const { contract } = loadContract(root)
  const live = hostHeartbeat(root, contract, 'gate-session')
  writeHeartbeat(root, 'gate-session', { ...live, pid: deadPid(), updated_at: new Date().toISOString() })

  const run = runCli(root, ['gate', 'run', 'session-open', '--json'], { DSH_SESSION_ID: 'gate-session' })
  assert.equal(run.code, 0, run.stderr)
  assert.equal(run.json.data.ok, false, JSON.stringify(run.json.data.steps))
  assert.equal(run.json.data.steps[0].ok, false)
  assert.equal(run.json.data.steps[0].exit, 1)
})

test('活跃>6h + agents 命中：编辑/写门禁不拦；无 agents 或 status=done 仍拦', async () => {
  const { root } = freshProject('guard-live')
  writeHeartbeat(root, 'busy', {
    session: 'busy', status: 'working', goal: '忙',
    updated_at: new Date(Date.now() - 7 * 3_600_000).toISOString(),
  })
  writeHeartbeat(root, 'done', {
    session: 'done', status: 'done', updated_at: new Date().toISOString(),
  })

  const mod = await plugin()
  const agentFor = (session) => ({ id: session, session: { cwd: root, header: { origin: 'root' } } })
  const makeTools = () => {
    let guard = null
    return {
      register: () => () => {},
      guard: (fn) => {
        guard = fn
        return () => {}
      },
      getGuard: () => guard,
    }
  }

  const withAgents = makeCtx({ root, agents: liveAgents(['busy', 'done']), tools: makeTools() })
  mod.apply(withAgents.ctx, {})
  try {
    const guard = withAgents.ctx.get('tools').getGuard()
    assert.equal(guard({ name: 'edit', agent: agentFor('busy') }), undefined, 'agents 命中且 >6h 不应硬拦')
    assert.match(String(guard({ name: 'edit', agent: agentFor('done') })), /flow_heartbeat update/, 'done 仍要拦')
  } finally {
    withAgents.disposeAll()
  }

  const withoutAgents = makeCtx({ root, tools: makeTools() })
  mod.apply(withoutAgents.ctx, {})
  try {
    const guard = withoutAgents.ctx.get('tools').getGuard()
    assert.match(String(guard({ name: 'edit', agent: agentFor('busy') })), /flow_heartbeat update/, '无 agents 时 stale 仍拦')
  } finally {
    withoutAgents.disposeAll()
  }
})

test('F1 软链入口：经 /tmp 软链调用 CLI，foreign 心跳证据仍保留（不覆盖 host/pid）', () => {
  const { root } = freshProject('symlink-cli')
  const foreignPid = deadPid()
  writeHeartbeat(root, 'foreign-session', {
    schema: 1,
    session: 'foreign-session',
    status: 'working',
    goal: '另一台机器',
    updated_at: new Date().toISOString(),
    host: 'other-machine|linux',
    boot_id: 'other-boot',
    pid: foreignPid,
    pid_start: 1,
  })

  const linkDir = tempRoot('cli-link')
  const link = path.join(linkDir, 'flow') // 模拟 npm 全局 flow -> bin/flow.mjs 软链名
  fs.symlinkSync(BIN, link)

  const result = spawnSync(
    process.execPath,
    [link, 'heartbeat', 'update', '--session', 'foreign-session', '--status', 'idle', '--json'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, DSH_SESSION_ID: '' } },
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const stored = JSON.parse(fs.readFileSync(heartbeatFile(root, 'foreign-session'), 'utf8'))
  assert.equal(stored.host, 'other-machine|linux', '软链入口的 CLI 仍不得覆盖 foreign host')
  assert.equal(stored.boot_id, 'other-boot')
  assert.equal(stored.pid, foreignPid)
  assert.equal(stored.pid_start, 1)
  assert.equal(livenessOf(stored).liveness, 'foreign', '不得被误判 dead')
})
