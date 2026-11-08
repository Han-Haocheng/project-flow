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
import { initProject, loadContract, startHeartbeat, updateHeartbeat } from '../lib/core.mjs'

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
