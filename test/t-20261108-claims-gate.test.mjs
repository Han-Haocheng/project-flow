// 心跳 claims 写守卫：`edit` / `write` 只能落进本会话登记的文件域。
//
// 语义（2026-11-08 用户定）：心跳里的 `claims` 不再只是广播约定，而是**授权**——
// 「没有登记文件域」= 没有写权限。子代理不做心跳，因此由父会话的文件域负责；
// 关闭开关 `config.claims: false` 回到旧行为（只广播不拦截）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { initProject, livenessOf, loadContract, readHeartbeatSection, startHeartbeat, updateHeartbeat } from '../lib/core.mjs'
import { foreignClaimOwner } from '../lib/host/session.mjs'

const TEMP_ROOTS = []
const HARNESSES = []

function makeHarness(root, config = {}) {
  const handlers = new Map()
  const effects = []
  const live = new Map()
  const roots = new Set()
  const guards = []
  const registered = new Map()
  const toolsService = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    guard(check) {
      guards.push(check)
      return () => {}
    },
    get(name) {
      return registered.get(name) ?? (name.startsWith('flow_') ? { name } : undefined)
    },
  }
  const agents = {
    list: () => [...live.values()],
    roots: () => [...live.entries()].filter(([id]) => roots.has(id)).map(([, agent]) => agent),
    get: (id) => live.get(id),
  }
  const webServer = { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:0' }
  const ctx = {
    get(name) {
      if (name === 'tools') return toolsService
      if (name === 'agents') return agents
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    on(name, handler) {
      const set = handlers.get(name) ?? new Set()
      set.add(handler)
      handlers.set(name, set)
      return () => set.delete(handler)
    },
    logger: { warn() {} },
  }
  const harness = {
    ctx,
    guards,
    addAgent(id, { root: isRoot = true } = {}) {
      const scope = { get: (name) => (name === 'tools' ? toolsService : undefined) }
      const agent = { id, session: { cwd: root, header: { origin: 'main' } }, ctx: scope }
      live.set(id, agent)
      if (isRoot) roots.add(id)
      return agent
    },
    guardOf() {
      assert.equal(guards.length, 1, `expected one host guard, got ${guards.length}`)
      return guards[0]
    },
    handler(name) {
      const set = handlers.get(name)
      return set === undefined ? [] : [...set]
    },
    dispose() {
      for (const dispose of effects.splice(0)) {
        try {
          dispose()
        } catch {
          // best effort
        }
      }
    },
  }
  HARNESSES.push(harness)
  apply(ctx, config)
  return harness
}

function freshProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-claims-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: `claims-${label}`, noGates: true })
  return { root, contract: loadContract(root).contract }
}

const call = (name, args, agent) => ({ name, arguments: args, agent })

after(() => {
  for (const harness of HARNESSES) harness.dispose()
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

/** Open a heartbeat for `session` and register the given claims. */
function withClaims(root, contract, session, claims) {
  startHeartbeat(root, contract, { session, createTask: false, goal: 'claims test' })
  if (claims.length > 0) updateHeartbeat(root, contract, session, { claims })
}

test('claims 精确文件：登记过的文件放行', () => {
  const { root, contract } = freshProject('exact')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-exact')
  withClaims(root, contract, 'session-exact', ['lib/host/enforce.mjs'])
  const guard = harness.guardOf()
  assert.equal(guard(call('edit', { file_path: path.join(root, 'lib/host/enforce.mjs') }, agent)), undefined)
})

test('claims 目录前缀：`lib/` 覆盖其下任意文件', () => {
  const { root, contract } = freshProject('dir')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-dir')
  withClaims(root, contract, 'session-dir', ['lib/'])
  const guard = harness.guardOf()
  assert.equal(guard(call('write', { file_path: path.join(root, 'lib/x/y.mjs') }, agent)), undefined)
})

test('超出文件域：拒绝，文案点名当前域与补登记命令', () => {
  const { root, contract } = freshProject('out')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-out')
  withClaims(root, contract, 'session-out', ['lib/'])
  const guard = harness.guardOf()
  const reason = guard(call('edit', { file_path: path.join(root, 'test/x.mjs') }, agent))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /lib\//)
  assert.match(reason, /test\/x\.mjs/)
  assert.match(reason, /flow_heartbeat update --claim/)
})

test('空 claims：没有登记文件域就没有写权限', () => {
  const { root, contract } = freshProject('empty')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-empty')
  startHeartbeat(root, contract, { session: 'session-empty', createTask: false, goal: 'empty' })
  const guard = harness.guardOf()
  const reason = guard(call('edit', { file_path: path.join(root, 'lib/a.mjs') }, agent))
  assert.match(reason, /没有登记文件域/)
  assert.match(reason, /flow_heartbeat update --claim/)
})

test('无心跳记录：拒绝并提示先登记', () => {
  const { root } = freshProject('nobeat')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-nobeat')
  const guard = harness.guardOf()
  const reason = guard(call('write', { file_path: path.join(root, 'a.txt') }, agent))
  assert.match(reason, /心跳未登记/)
})

test('子代理豁免：没有心跳的子代理由父会话文件域负责', () => {
  const { root, contract } = freshProject('sub')
  const harness = makeHarness(root)
  const parent = harness.addAgent('session-parent')
  withClaims(root, contract, 'session-parent', ['lib/'])
  const sub = harness.addAgent('session-child', { root: false })
  const guard = harness.guardOf()
  assert.equal(guard(call('edit', { file_path: path.join(root, 'test/x.mjs') }, sub)), undefined)
  // 父会话的域仍然生效
  assert.match(guard(call('edit', { file_path: path.join(root, 'test/x.mjs') }, parent)), /文件域/)
})

test('config.claims=false：回到旧行为（只广播不拦截）', () => {
  const { root, contract } = freshProject('off')
  const harness = makeHarness(root, { claims: false })
  const agent = harness.addAgent('session-off')
  withClaims(root, contract, 'session-off', ['lib/'])
  const guard = harness.guardOf()
  assert.equal(guard(call('edit', { file_path: path.join(root, 'test/x.mjs') }, agent)), undefined)
})

test('非 edit/write 工具不受 claims 门影响', () => {
  const { root } = freshProject('other')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-other')
  const guard = harness.guardOf()
  assert.equal(guard(call('flow_status', {}, agent)), undefined)
  assert.equal(guard(call('read', { file_path: path.join(root, 'x.mjs') }, agent)), undefined)
})

test('路径逃逸：目标在项目根外，直接拒绝', () => {
  const { root, contract } = freshProject('escape')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-escape')
  withClaims(root, contract, 'session-escape', ['lib/'])
  const guard = harness.guardOf()
  const reason = guard(call('edit', { file_path: path.join(root, '..', 'outside.txt') }, agent))
  assert.match(reason, /不在项目根内/)
})

// --------------------------------------------------------- dsh-ops 结构写工具
//
// ops_write_file / ops_edit_file / ops_replace / ops_move / ops_copy / ops_remove
// 是宿主的替代写工具；它们原来绕过 claims 门禁，并行会话各自 claim 不同文件
// 的约束因此形同虚设。下面把同一个域判定钉在这些工具参数上。

test('ops_write_file：域外目标同样被拒', () => {
  const { root, contract } = freshProject('ops-write-out')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-ops-write-out')
  withClaims(root, contract, 'session-ops-write-out', ['lib/'])
  const guard = harness.guardOf()
  const reason = guard(call('ops_write_file', { path: path.join(root, 'test/x.mjs') }, agent))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /test\/x\.mjs/)
  assert.match(reason, /flow_heartbeat update --claim/)
})

test('ops_edit_file：域内目标放行', () => {
  const { root, contract } = freshProject('ops-edit-in')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-ops-edit-in')
  withClaims(root, contract, 'session-ops-edit-in', ['lib/'])
  const guard = harness.guardOf()
  assert.equal(guard(call('ops_edit_file', { path: path.join(root, 'lib/host/shared.mjs') }, agent)), undefined)
})

test('ops_replace：`path` 是目录根，按目录前缀判域', () => {
  const { root, contract } = freshProject('ops-replace-dir')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-ops-replace-dir')
  withClaims(root, contract, 'session-ops-replace-dir', ['lib/host/'])
  const guard = harness.guardOf()
  // 目录本身及其子目录都在域内
  assert.equal(guard(call('ops_replace', { path: path.join(root, 'lib/host') }, agent)), undefined)
  // 目录根不在域内则整批拒绝
  assert.match(guard(call('ops_replace', { path: path.join(root, 'test') }, agent)), /test 不在其中/)
  // 别的会话 claim 了目录里的具体文件：整批替换同样会碰到它，必须拒绝。
  const other = harness.addAgent('session-ops-replace-other')
  withClaims(root, contract, 'session-ops-replace-other', ['lib/host/x.mjs'])
  assert.match(guard(call('ops_replace', { path: path.join(root, 'lib/host') }, agent)), /session-ops-replace-other/)
})

test('ops_move / ops_copy：源与目标任一越界即拒', () => {
  const { root, contract } = freshProject('ops-move')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-ops-move')
  withClaims(root, contract, 'session-ops-move', ['lib/'])
  const guard = harness.guardOf()
  // 源在域内、目标越界：拒绝，并点名目标路径
  assert.match(
    guard(call('ops_move', { path: path.join(root, 'lib/a.mjs'), to: path.join(root, 'test/b.mjs') }, agent)),
    /目标路径 .*test\/b\.mjs 不在项目根内|test\/b\.mjs/,
  )
  // 目标在域内、源越界：同样拒绝
  assert.match(guard(call('ops_copy', { path: path.join(root, 'test/a.mjs'), to: path.join(root, 'lib/b.mjs') }, agent)), /test\/a\.mjs/)
  // 目标逃出项目根也拒绝
  assert.match(guard(call('ops_move', { path: path.join(root, 'lib/a.mjs'), to: path.join(root, '..', 'outside.txt') }, agent)), /不在项目根内/)
})

test('ops_remove：域内删除放行、域外删除拒绝', () => {
  const { root, contract } = freshProject('ops-remove')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-ops-remove')
  withClaims(root, contract, 'session-ops-remove', ['lib/'])
  const guard = harness.guardOf()
  assert.equal(guard(call('ops_remove', { path: path.join(root, 'lib/tmp.mjs') }, agent)), undefined)
  assert.match(guard(call('ops_remove', { path: path.join(root, 'test/tmp.mjs') }, agent)), /test\/tmp\.mjs/)
})

test('只读 ops_* 工具不在门禁集合内，不拦', () => {
  const { root } = freshProject('ops-readonly')
  const harness = makeHarness(root)
  // 无心跳、无 claims：只读工具照样放行。
  const agent = harness.addAgent('session-ops-readonly')
  const guard = harness.guardOf()
  const readOnlyTools = ['ops_read_files', 'ops_grep', 'ops_glob', 'ops_stat', 'ops_diff', 'ops_inspect_local_file']
  for (const name of readOnlyTools) {
    assert.equal(guard(call(name, { path: path.join(root, 'test/x.mjs') }, agent)), undefined, `${name} 不应被 claims 门禁拦截`)
  }
})

test('ops_write_file：被别的活会话 claim 时同样拒绝（跨会话反查生效）', () => {
  const { root, contract } = freshProject('ops-foreign')
  const harness = makeHarness(root)
  const mine = harness.addAgent('session-ops-foreign-a')
  const other = harness.addAgent('session-ops-foreign-b')
  withClaims(root, contract, 'session-ops-foreign-a', ['lib/'])
  withClaims(root, contract, 'session-ops-foreign-b', ['lib/host/'])
  const guard = harness.guardOf()
  const reason = guard(call('ops_write_file', { path: path.join(root, 'lib/host/x.mjs') }, mine))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /session-ops-foreign-b/)
  assert.equal(guard(call('ops_write_file', { path: path.join(root, 'lib/other/x.mjs') }, mine)), undefined)
  // 反向同样生效：对方的域里也在本会话的 lib/ 范围内。
  assert.match(guard(call('ops_write_file', { path: path.join(root, 'lib/host/x.mjs') }, other)), /session-ops-foreign-a/)
})

// --------------------------------------------- 跨会话判活（T-20261112163241，2026-11-12）
//
// 事故：会话已停止、pid 已不存在，它 claim 的 CONTRACT.md 仍阻塞别人写入 63 分钟。
// 判活现在按投影里的 `liveness`（pid / pid_start / boot_id / host 的证据）：
// dead / foreign / stale 一律不占域；live 即使记录老旧也占域；没有存活证据的旧记录
// 退回 6 小时老化兜底。

const HEARTBEAT_DIR = path.join('.agents', 'heartbeat')

function heartbeatPath(root, session) {
  return path.join(root, HEARTBEAT_DIR, `${session}.json`)
}

/** 直接改心跳 JSON：绕过写 API 的 pid 证据，才能造出"证据死了"的记录。 */
function patchHeartbeat(root, session, patch) {
  const file = heartbeatPath(root, session)
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  const next = { ...record, ...patch }
  fs.writeFileSync(file, JSON.stringify(next, null, 2))
  return next
}

/** 只写给定字段的心跳（默认不带 host / pid / boot_id 存活证据）。 */
function rawHeartbeat(root, record) {
  fs.mkdirSync(path.join(root, HEARTBEAT_DIR), { recursive: true })
  fs.writeFileSync(heartbeatPath(root, record.session), JSON.stringify(record, null, 2))
  return record
}

/** 一条投影行形状的心跳（可覆盖任意字段）。 */
function projectedItem(overrides = {}) {
  return { session: 'session-x', status: 'idle', liveness: 'live', claims: ['CONTRACT.md'], stale: false, ...overrides }
}

test('判活：pid 已不存在的心跳不占域（dead 跳过）', () => {
  // 单元：liveness=dead 时，即使 status=idle 且未过 6h，也不再是待避让的域。
  const deadItem = projectedItem({ session: 'session-dead', liveness: 'dead' })
  assert.equal(foreignClaimOwner([deadItem], 'session-mine', 'CONTRACT.md'), null)
  // 集成：把一个真实心跳的 pid 改成不存在的值，门禁放行。
  const { root, contract } = freshProject('dead-owner')
  const harness = makeHarness(root)
  const mine = harness.addAgent('session-dead-mine')
  withClaims(root, contract, 'session-dead-mine', ['lib/', 'CONTRACT.md'])
  withClaims(root, contract, 'session-dead-owner', ['CONTRACT.md'])
  const record = patchHeartbeat(root, 'session-dead-owner', { pid: 2147483646, pid_start: 1 })
  assert.equal(livenessOf(record).liveness, 'dead')
  assert.equal(harness.guardOf()(call('edit', { file_path: path.join(root, 'CONTRACT.md') }, mine)), undefined)
})

test('判活：pid 存活的心跳仍占域（live 不因记录老旧被跳过）', () => {
  const { root, contract } = freshProject('live-owner')
  const harness = makeHarness(root)
  const mine = harness.addAgent('session-live-mine')
  withClaims(root, contract, 'session-live-mine', ['lib/', 'CONTRACT.md'])
  withClaims(root, contract, 'session-live-owner', ['CONTRACT.md'])
  // 心跳由本测试进程写入，它的 pid 就是存活证据。
  const row = readHeartbeatSection(root, contract, { visibility: 'all' }).items.find(
    (item) => item.session === 'session-live-owner',
  )
  assert.equal(row.liveness, 'live')
  const reason = harness.guardOf()(call('edit', { file_path: path.join(root, 'CONTRACT.md') }, mine))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /session-live-owner/)
})

test('判活：host 不同的心跳跳过（foreign 不跨机器占域）', () => {
  const { root, contract } = freshProject('foreign-owner')
  const harness = makeHarness(root)
  const mine = harness.addAgent('session-foreign-mine')
  withClaims(root, contract, 'session-foreign-mine', ['lib/', 'CONTRACT.md'])
  withClaims(root, contract, 'session-foreign-owner', ['CONTRACT.md'])
  const record = patchHeartbeat(root, 'session-foreign-owner', { host: 'other-host|linux' })
  assert.equal(livenessOf(record).liveness, 'foreign')
  assert.equal(harness.guardOf()(call('edit', { file_path: path.join(root, 'CONTRACT.md') }, mine)), undefined)
})

test('判活：无存活证据时按 6 小时老化兜底（老记录放行、新记录仍占域）', () => {
  const { root, contract } = freshProject('age-fallback')
  const harness = makeHarness(root)
  const mine = harness.addAgent('session-age-mine')
  withClaims(root, contract, 'session-age-mine', ['CONTRACT.md', 'README.md'])
  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()
  rawHeartbeat(root, { schema: 1, session: 'session-age-old', status: 'idle', claims: ['CONTRACT.md'], updated_at: sevenHoursAgo })
  rawHeartbeat(root, { schema: 1, session: 'session-age-new', status: 'idle', claims: ['README.md'], updated_at: new Date().toISOString() })
  const items = readHeartbeatSection(root, contract, { visibility: 'all' }).items
  assert.equal(items.find((item) => item.session === 'session-age-old').liveness, 'stale')
  assert.equal(items.find((item) => item.session === 'session-age-new').liveness, 'unknown')
  const guard = harness.guardOf()
  // 老记录：没有存活证据且已过 6h，放行。
  assert.equal(guard(call('edit', { file_path: path.join(root, 'CONTRACT.md') }, mine)), undefined)
  // 新记录：同样没有存活证据，但没过 6h，仍按活会话占域。
  const reason = guard(call('edit', { file_path: path.join(root, 'README.md') }, mine))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /session-age-new/)
})

test('判活：自己会话不自我阻塞', () => {
  assert.equal(foreignClaimOwner([projectedItem({ session: 'session-self' })], 'session-self', 'CONTRACT.md'), null)
  const { root, contract } = freshProject('self-claim')
  const harness = makeHarness(root)
  const agent = harness.addAgent('session-self-claim')
  withClaims(root, contract, 'session-self-claim', ['CONTRACT.md'])
  assert.equal(harness.guardOf()(call('edit', { file_path: path.join(root, 'CONTRACT.md') }, agent)), undefined)
})

