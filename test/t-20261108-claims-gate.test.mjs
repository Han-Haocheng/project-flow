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
import {
  HEARTBEAT_STALE_SECONDS,
  heartbeatStatus,
  initProject,
  livenessOf,
  loadContract,
  readHeartbeatSection,
  startHeartbeat,
  updateHeartbeat,
} from '../lib/core.mjs'
import { foreignClaimOwner } from '../lib/host/session.mjs'
import { hostTag } from '../lib/lock.mjs'

const TEMP_ROOTS = []
const HARNESSES = []

function makeHarness(root, config = {}, { agents: agentsCapable = true, enumerateChildren = true } = {}) {
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
    // 某些宿主的 list() 不穷举子会话（gatekeeper 审查场景）：get() 仍然认识它们。
    list: () =>
      enumerateChildren
        ? [...live.values()]
        : [...live.entries()].filter(([id]) => roots.has(id)).map(([, agent]) => agent),
    roots: () => [...live.entries()].filter(([id]) => roots.has(id)).map(([, agent]) => agent),
    get: (id) => live.get(id),
  }
  const webServer = { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:0' }
  const ctx = {
    get(name) {
      if (name === 'tools') return toolsService
      if (name === 'agents') return agentsCapable ? agents : undefined
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
  // T-20261112184401：宿主有 agents 注册表时，注册表是判活的最终证据——一个"活着"
  // 的会话当然在注册表里；不登记就等于告诉宿主"这个会话已经不在了"（另有专测）。
  harness.addAgent('session-live-owner')
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

// --------------------------------- 按会话注册表判活 + TTL 租约（T-20261112184401，2026-11-12）
//
// pid 是**宿主进程 pid，多会话共用**：宿主退出 → /proc 查不到 → dead（这是止血卡
// T-20261112163241 覆盖的那类事故）；但**宿主还活着、某个会话已停止** → pid 仍在 →
// live → 会话继续占域。pid 只能回答"宿主死了没有"，回答不了"这个会话还活着没有"。
//
// 彻底解法：宿主 `agents` 注册表是判活的第一证据——
//   ① 注册表说会话不在了（且记录是本进程写的）→ 立即判死释放；
//   ② 注册表说会话在 → 记录老旧也判活，不会被误抢；
//   ③ 没有注册表能力（CLI / 无 agents 服务的宿主）→ 降级为 TTL 租约，读投影显式标
//      `ttl-only`，租约 = 最后一次续期（updated_at）+ HEARTBEAT_STALE_SECONDS；
//   ④ 注册表与 TTL 冲突 → 注册表优先（说死就立即释放，说活就继续占域）。

test('livenessOf：registryLive=true 压过 pid 证据（注册表说会话在 = 活）', () => {
  const record = {
    schema: 1,
    session: 's',
    status: 'working',
    host: hostTag(),
    pid: 2147483646,
    updated_at: new Date().toISOString(),
  }
  const pidOnly = livenessOf(record)
  assert.equal(pidOnly.liveness, 'dead')
  assert.equal(pidOnly.reason, 'pid-gone')
  assert.equal(pidOnly.evidence, 'pid')
  const registry = livenessOf(record, { registryLive: true })
  assert.equal(registry.liveness, 'live')
  assert.equal(registry.reason, 'agent-live')
  assert.equal(registry.evidence, 'registry')
})

test('livenessOf：registryLive=false 立即判死，压过 pid 与 TTL（注册表优先）', () => {
  // pid 仍活 + 记录刚续期：旧判据只会说 live；注册表说会话没了就必须判死。
  const record = {
    schema: 1,
    session: 's',
    status: 'working',
    host: hostTag(),
    pid: process.pid,
    updated_at: new Date().toISOString(),
  }
  assert.equal(livenessOf(record).liveness, 'live')
  const registry = livenessOf(record, { registryLive: false })
  assert.equal(registry.liveness, 'dead')
  assert.equal(registry.reason, 'session-gone')
  assert.equal(registry.evidence, 'registry')
  assert.equal(registry.ageSeconds, 0)
  // 跨机器记录仍是 foreign：注册表不替别的机器说话。
  const foreign = livenessOf({ ...record, host: 'other-machine|linux' }, { registryLive: false })
  assert.equal(foreign.liveness, 'foreign')
  assert.equal(foreign.evidence, 'host')
})

test('livenessOf：无任何证据时走 TTL 租约（fresh=unknown / 过期=stale），并标 evidence=ttl', () => {
  const fresh = { schema: 1, session: 's', status: 'idle', updated_at: new Date().toISOString() }
  assert.equal(livenessOf(fresh).liveness, 'unknown')
  assert.equal(livenessOf(fresh).evidence, 'ttl')
  const old = { ...fresh, updated_at: new Date(Date.now() - (HEARTBEAT_STALE_SECONDS + 60) * 1000).toISOString() }
  assert.equal(livenessOf(old).liveness, 'stale')
  assert.equal(livenessOf(old).evidence, 'ttl')
})

test('投影：宿主还活着但会话已停止 → dead/session-gone（pid 存活不再骗过判活）', () => {
  const { root, contract } = freshProject('stopped-session')
  withClaims(root, contract, 'session-stopped', ['CONTRACT.md'])
  // 记录由本进程写（pid === 本进程 pid），注册表却没有这个会话 = 会话已停止。
  const stopped = new Set()
  const sessionLive = (session) => stopped.has(session)
  const section = readHeartbeatSection(root, contract, { visibility: 'all', sessionLive })
  const row = section.items.find((item) => item.session === 'session-stopped')
  assert.equal(row.liveness, 'dead')
  assert.equal(row.reason, 'session-gone')
  assert.equal(row.livenessEvidence, 'registry')
  assert.equal(section.livenessEvidence, 'registry')
  // dead 行默认视图里消失（文件还在）。
  const visible = readHeartbeatSection(root, contract, { sessionLive })
  assert.deepEqual(visible.items, [])
  assert.equal(visible.counts.dead, 1)
})

test('投影：注册表说会话在 → 记录老旧也判活（不会被别人误抢）', () => {
  const { root, contract } = freshProject('renewed')
  withClaims(root, contract, 'session-renewed', ['CONTRACT.md'])
  // 7 小时没续期，且抹掉 pid/boot 证据：只剩 TTL 会判 stale，注册表说活就该判活。
  const record = JSON.parse(fs.readFileSync(heartbeatPath(root, 'session-renewed'), 'utf8'))
  delete record.pid
  delete record.pid_start
  delete record.boot_id
  record.updated_at = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()
  fs.writeFileSync(heartbeatPath(root, 'session-renewed'), JSON.stringify(record, null, 2))
  const ttlOnly = readHeartbeatSection(root, contract, { visibility: 'all' })
  assert.equal(ttlOnly.items.find((item) => item.session === 'session-renewed').liveness, 'stale')
  const registry = readHeartbeatSection(root, contract, {
    visibility: 'all',
    sessionLive: (session) => session === 'session-renewed',
  })
  const row = registry.items.find((item) => item.session === 'session-renewed')
  assert.equal(row.liveness, 'live')
  assert.equal(row.reason, 'agent-live')
  assert.equal(row.livenessEvidence, 'registry')
})

test('投影：注册表不能替别的 DSH 进程判死（记录 pid 不是本进程）', () => {
  const { root, contract } = freshProject('other-process')
  // 同机器同 host tag，但没有 pid：本进程无法证明是自己的记录，注册表无权判死。
  rawHeartbeat(root, {
    schema: 1,
    session: 'session-other-process',
    status: 'working',
    host: hostTag(),
    updated_at: new Date().toISOString(),
  })
  const section = readHeartbeatSection(root, contract, { visibility: 'all', sessionLive: () => false })
  const row = section.items.find((item) => item.session === 'session-other-process')
  assert.equal(row.liveness, 'unknown', '没有 pid 就不是本进程的记录，注册表无权判死')
  assert.equal(row.livenessEvidence, 'ttl')
  // 有别人的 pid（不是 process.pid）时同样不判 session-gone，交给 pid/TTL。
  rawHeartbeat(root, {
    schema: 1,
    session: 'session-foreign-pid',
    status: 'working',
    host: hostTag(),
    pid: process.pid + 1,
    updated_at: new Date().toISOString(),
  })
  const second = readHeartbeatSection(root, contract, { visibility: 'all', sessionLive: () => false })
  assert.notEqual(second.items.find((item) => item.session === 'session-foreign-pid').reason, 'session-gone')
})

test('投影：没有注册表能力 → 整批标 ttl-only，租约到期时间可查（可靠性降一档）', () => {
  const { root, contract } = freshProject('ttl-only')
  withClaims(root, contract, 'session-ttl', ['CONTRACT.md'])
  const section = readHeartbeatSection(root, contract, { visibility: 'all' })
  assert.equal(section.livenessEvidence, 'ttl-only')
  assert.equal(section.leaseSeconds, HEARTBEAT_STALE_SECONDS)
  const row = section.items.find((item) => item.session === 'session-ttl')
  assert.equal(typeof row.leaseExpiresAt, 'string')
  const renewed = Date.parse(row.updated_at)
  assert.equal(Date.parse(row.leaseExpiresAt) - renewed, HEARTBEAT_STALE_SECONDS * 1000, '租约 = 续期时间 + TTL')
})

test('heartbeatStatus：sessionLive=false 立即 inactive/session-gone；无注册表时标 ttl 证据', () => {
  const { root, contract } = freshProject('status')
  withClaims(root, contract, 'session-status', ['CONTRACT.md'])
  const withoutRegistry = heartbeatStatus(root, contract, 'session-status')
  assert.equal(withoutRegistry.active, true)
  assert.equal(withoutRegistry.livenessEvidence, 'pid')
  const stopped = heartbeatStatus(root, contract, 'session-status', { sessionLive: () => false })
  assert.equal(stopped.active, false)
  assert.equal(stopped.liveness, 'dead')
  assert.equal(stopped.reason, 'session-gone')
  assert.equal(stopped.livenessEvidence, 'registry')
  const live = heartbeatStatus(root, contract, 'session-status', { sessionLive: () => true })
  assert.equal(live.active, true)
  assert.equal(live.reason, 'agent-live')
})

test('验收①：宿主活着但会话已停止 → 立即释放它占的文件域', () => {
  const { root, contract } = freshProject('guard-stopped')
  const harness = makeHarness(root)
  const mine = harness.addAgent('session-guard-mine')
  withClaims(root, contract, 'session-guard-mine', ['lib/', 'CONTRACT.md'])
  withClaims(root, contract, 'session-guard-stopped', ['CONTRACT.md'])
  // 停止的会话不在注册表里：即使心跳刚续期、pid 仍活，也不占域。
  assert.equal(harness.guardOf()(call('edit', { file_path: path.join(root, 'CONTRACT.md') }, mine)), undefined)
})

test('验收②：活会话在注册表里 → 不被误抢', () => {
  const { root, contract } = freshProject('guard-live')
  const harness = makeHarness(root)
  const mine = harness.addAgent('session-guard-live-mine')
  harness.addAgent('session-guard-live-owner')
  withClaims(root, contract, 'session-guard-live-mine', ['lib/', 'CONTRACT.md'])
  withClaims(root, contract, 'session-guard-live-owner', ['CONTRACT.md'])
  const reason = harness.guardOf()(call('edit', { file_path: path.join(root, 'CONTRACT.md') }, mine))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /session-guard-live-owner/)
})

test('验收③：没有注册表能力的宿主按 TTL 租约释放（过期放行、新鲜仍占）', () => {
  const { root, contract } = freshProject('guard-ttl')
  const harness = makeHarness(root, {}, { agents: false })
  const mine = harness.addAgent('session-guard-ttl-mine')
  withClaims(root, contract, 'session-guard-ttl-mine', ['CONTRACT.md', 'README.md'])
  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()
  rawHeartbeat(root, { schema: 1, session: 'session-ttl-old', status: 'idle', claims: ['CONTRACT.md'], updated_at: sevenHoursAgo })
  rawHeartbeat(root, { schema: 1, session: 'session-ttl-new', status: 'idle', claims: ['README.md'], updated_at: new Date().toISOString() })
  const guard = harness.guardOf()
  assert.equal(guard(call('edit', { file_path: path.join(root, 'CONTRACT.md') }, mine)), undefined, '租约过期 → 释放')
  const fresh = guard(call('edit', { file_path: path.join(root, 'README.md') }, mine))
  assert.equal(typeof fresh, 'string', '租约未过期 → 仍占域')
  assert.match(fresh, /session-ttl-new/)
})

test('验收④：注册表说死优先于 TTL（新鲜记录也立即释放）；说活优先于 pid-gone', () => {
  const row = (overrides = {}) =>
    projectedItem({ session: 'session-conflict', status: 'idle', livenessEvidence: 'registry', ...overrides })
  // 注册表判死的投影行：不占域（即使 claims 还在、记录不 stale）。
  assert.equal(foreignClaimOwner([row({ liveness: 'dead', reason: 'session-gone' })], 'session-mine', 'CONTRACT.md'), null)
  // 注册表判活的投影行：继续占域。
  const owner = foreignClaimOwner([row({ liveness: 'live', reason: 'agent-live' })], 'session-mine', 'CONTRACT.md')
  assert.equal(owner.session, 'session-conflict')
})


// ------------------------------- agents.get 单会话探针（T-20261112202457 加固）
//
// 负证据如果只看 roots()+list() 的集合快照，某些宿主不穷举子会话时会把**活着的同进程
// 子会话**判成 session-gone 并释放文件域。判定必须先用 agents.get(session) 单会话探针。

test('判活加固：agents.list 不穷举子会话时，agents.get 仍证明子会话活着（不丢域）', () => {
  const { root, contract } = freshProject('probe-get')
  const harness = makeHarness(root, {}, { enumerateChildren: false })
  const mine = harness.addAgent('session-probe-mine')
  // 子会话：list() 看不到，但 get() 认识它 —— 这正是 gatekeeper 担心的宿主形状。
  harness.addAgent('session-probe-child', { root: false })
  withClaims(root, contract, 'session-probe-mine', ['CONTRACT.md'])
  withClaims(root, contract, 'session-probe-child', ['CONTRACT.md'])
  const reason = harness.guardOf()(call('edit', { file_path: path.join(root, 'CONTRACT.md') }, mine))
  assert.equal(typeof reason, 'string', '活着的子会话不因 list() 不穷举就被判 session-gone')
  assert.match(reason, /session-probe-child/)
})
