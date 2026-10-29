// project-flow Host self-test harness — local, no deps.
//
// Loads index.js with a mock Cordis context (webServer + workspaceRegistry),
// then drives the two registered routes — explicit `?root=<dir>`, process-cwd,
// the init write and error paths — with plain request/response doubles. Every
// response body is written to .selftest/state-*.json for inspection.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = dirname(here)
const alpha = '/tmp/pf-demo/alpha'
const IQB = '/tmp/pf-demo/qbank'
const PLAIN = '/tmp/project-flow-selftest/plain'
const PLAIN_SUB = PLAIN + '/sub'
const INIT = '/tmp/project-flow-selftest/init'
const STRANGER = '/tmp/project-flow-selftest/stranger'
const ORIGIN = 'http://127.0.0.1:44453'
const TITLES = { [PLAIN]: 'PlainWorkspace', [INIT]: 'InitWorkspace' }

const { apply } = await import(join(pkgRoot, 'index.js'))

// ------------------------------------------------------------- fake context

const routes = []
const disposers = []
const webServer = {
  register(route) {
    routes.push(route)
    return () => {
      const at = routes.indexOf(route)
      if (at >= 0) routes.splice(at, 1)
    }
  },
  getOrigin() {
    return ORIGIN
  },
}

function makeCtx(registryPaths) {
  const registry = {
    list() {
      return registryPaths.map((path) => ({ path, title: TITLES[path] ?? path.split('/').pop() }))
    },
  }
  return {
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
  }
}

function fakeResponse(done) {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = { ...state.headers, ...headers }
    },
    setHeader(name, value) {
      state.headers[name] = value
    },
    end(body) {
      if (body !== undefined) state.body = String(body)
      done()
    },
    destroy() {},
    get headersSent() {
      return state.status !== 0
    },
  }
}

/**
 * Minimal request double. `on()` collects listeners; when a body is supplied it
 * is emitted once on a macrotask (after the handler has subscribed), so the same
 * object works for GET-style requests that never read a body.
 */
function fakeRequest({ method, url, headers, body }) {
  const listeners = { data: [], end: [], error: [] }
  const request = {
    method,
    url,
    headers,
    on(name, listener) {
      if (Array.isArray(listeners[name]) === false) listeners[name] = []
      listeners[name].push(listener)
      return request
    },
    resume() {},
    destroy() {},
  }
  if (body !== undefined) {
    setImmediate(() => {
      for (const listener of listeners.data) listener(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'))
      for (const listener of listeners.end) listener()
    })
  }
  return request
}

async function call(route, { method = 'GET', url, origin, body } = {}) {
  let finish
  const finished = new Promise((settle) => {
    finish = settle
  })
  const response = fakeResponse(finish)
  const headers = {}
  if (origin !== undefined) headers.origin = origin
  const timer = setTimeout(finish, 30_000)
  route.handler(fakeRequest({ method, url: url ?? route.path, headers, body }), response)
  await finished
  clearTimeout(timer)
  let json
  try {
    json = JSON.parse(response.state.body)
  } catch {
    json = undefined
  }
  return { status: response.state.status, headers: response.state.headers, json, raw: response.state.body }
}

function save(name, payload) {
  writeFileSync(join(here, `state-${name}.json`), JSON.stringify(payload, null, 2))
}

// --------------------------------------------------------------- assertions

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function summary(label, res) {
  const json = res.json ?? {}
  console.log(
    `${label}: status=${res.status} ok=${json.ok} root=${json.root} contract=${
      json.contract === undefined ? '-' : `${json.contract.source}/${json.contract.name}`
    } exp=${json.experiments?.total ?? '-'} tasks=${json.tasks?.total ?? '-'} gate=${
      json.gate === null ? 'null' : (json.gate?.lines?.length ?? '-')
    } hb=${json.heartbeats?.length ?? '-'} runs=${json.runs?.length ?? '-'} warnings=${json.warnings?.length ?? '-'}`,
  )
}

// ------------------------------------------------------------ fixture: fake

const fakeRoot = '/tmp/project-flow-selftest/fake'
mkdirSync(join(fakeRoot, 'ledger/tasks'), { recursive: true })
mkdirSync(join(fakeRoot, 'out'), { recursive: true })
writeFileSync(
  join(fakeRoot, 'flow.json'),
  JSON.stringify(
    {
      schema: 1,
      name: 'FakeProject',
      experiments: { source: 'none' },
      tasks: { source: 'json', dir: 'ledger/tasks' },
      gate: { log: 'ledger/gate.log' },
      heartbeats: { source: 'md', dir: 'ledger/hb' },
      runs: { dirs: ['out', 'build/agent-*'] },
    },
    null,
    2,
  ),
)

const brokenRoot = '/tmp/project-flow-selftest/broken'
mkdirSync(brokenRoot, { recursive: true })
writeFileSync(join(brokenRoot, 'flow.json'), '{ this is not json }')

// A registered workspace with no ledger at all, plus one of its subdirectories.
mkdirSync(PLAIN_SUB, { recursive: true })
// An existing directory that is neither registered nor carries a manifest.
mkdirSync(STRANGER, { recursive: true })
// A registered workspace that starts empty and is initialized through POST below.
mkdirSync(INIT, { recursive: true })
rmSync(join(INIT, '.dsh'), { recursive: true, force: true })

// --------------------------------------------------------------------- run

apply(makeCtx([alpha, IQB, fakeRoot, brokenRoot, PLAIN, INIT]))
check('routes registered', routes.length === 2, `routes=${routes.length}`)
const route = routes.find((entry) => entry.path === '/api/project-flow/state')
const initRoute = routes.find((entry) => entry.path === '/api/project-flow/init')
check('state route is exact GET path', route?.kind === 'exact' && route?.path === '/api/project-flow/state', JSON.stringify(route?.kind))
check(
  'init route is exact POST path',
  initRoute?.kind === 'exact' && initRoute?.path === '/api/project-flow/init',
  JSON.stringify(initRoute?.kind),
)

// --------------------------------------------------- no root param (process cwd)

const originalCwd = process.cwd()

process.chdir(fakeRoot)
const auto = await call(route)
save('auto', auto.json)
summary(`auto(root omitted, cwd=${fakeRoot})`, auto)
check('auto: 200 + ok', auto.status === 200 && auto.json?.ok === true)
check('auto: root is the cwd workspace', auto.json?.root === fakeRoot, auto.json?.root)
check('auto: exactly one root listed', Array.isArray(auto.json?.roots) && auto.json.roots.length === 1, `roots=${auto.json?.roots?.length}`)
check('auto: listed root is the cwd workspace', auto.json?.roots?.[0]?.path === fakeRoot, JSON.stringify(auto.json?.roots))
check('auto: no-store header', auto.headers['cache-control'] === 'no-store')

process.chdir(PLAIN)
const cwdPlain = await call(route)
summary(`auto(root omitted, cwd=${PLAIN})`, cwdPlain)
check('cwd plain: 200', cwdPlain.status === 200)
check('cwd plain: ok false + no-project', cwdPlain.json?.ok === false && cwdPlain.json?.error?.code === 'no-project', JSON.stringify(cwdPlain.json?.error))
check('cwd plain: roots empty', Array.isArray(cwdPlain.json?.roots) && cwdPlain.json.roots.length === 0, `roots=${cwdPlain.json?.roots?.length}`)
check('cwd plain: root null', cwdPlain.json?.root === null)

process.chdir(originalCwd)

const alpha = await call(route, { url: `${route.path}?root=${encodeURIComponent(alpha)}` })
save('alpha', alpha.json)
summary('alpha', alpha)
check('alpha: 200 + ok', alpha.status === 200 && alpha.json?.ok === true)
const alphaSource = alpha.json?.contract?.source
check(
  'alpha: contract.source is defaults or a store contract',
  alphaSource === 'defaults' || alphaSource === '.dsh/flow/flow.json',
  alphaSource,
)
check('alpha: contract name alpha', alpha.json?.contract?.name === 'alpha', alpha.json?.contract?.name)
check('alpha: experiments.total >= 1', alpha.json?.experiments?.total >= 1, alpha.json?.experiments?.total)
check('alpha: tasks.total >= 49', alpha.json?.tasks?.total >= 49, alpha.json?.tasks?.total)
check('alpha: gate is a log object or disabled (null)', alpha.json?.gate === null || (Array.isArray(alpha.json.gate?.lines) && alpha.json.gate.lines.length > 0), alpha.json?.gate === null ? 'null' : 'lines')
check('alpha: gate has mtime/size when enabled', alpha.json?.gate === null || (typeof alpha.json.gate.mtime === 'number' && alpha.json.gate.size > 0))
check('alpha: heartbeats non-empty', Array.isArray(alpha.json?.heartbeats) && alpha.json.heartbeats.length > 0)
check('alpha: head.sha present', typeof alpha.json?.head?.sha === 'string' && alpha.json.head.sha.length >= 7, JSON.stringify(alpha.json?.head))
check('alpha: tasks.current is a string or absent', alpha.json?.tasks?.current === null || typeof alpha.json?.tasks?.current === 'string', alpha.json?.tasks?.current)
check('alpha: run shape bounded', alpha.json?.runs.length <= 4)
check('alpha: root is the requested workspace', alpha.json?.root === alpha, alpha.json?.root)
check('alpha: exactly one root listed', alpha.json?.roots?.length === 1, JSON.stringify(alpha.json?.roots))

const iqb = await call(route, { url: `${route.path}?root=${encodeURIComponent(IQB)}` })
save('iqb', iqb.json)
summary('iqb', iqb)
check('iqb: 200 + ok', iqb.status === 200 && iqb.json?.ok === true)
check('iqb: contract.source flow.json', iqb.json?.contract?.source === 'flow.json', iqb.json?.contract?.source)
check('iqb: contract name qbank', iqb.json?.contract?.name === 'qbank', iqb.json?.contract?.name)
check('iqb: tasks.total == 2', iqb.json?.tasks?.total === 2, iqb.json?.tasks?.total)
check('iqb: tasks source markdown (other count 2)', iqb.json?.tasks?.counts?.other === 2, JSON.stringify(iqb.json?.tasks?.counts))
check('iqb: task titles from markdown', iqb.json?.tasks?.recentDone.length === 0 && Array.isArray(iqb.json?.tasks?.active))
check('iqb: gate == null', iqb.json?.gate === null)
check('iqb: experiments.total == 0', iqb.json?.experiments?.total === 0, iqb.json?.experiments?.total)
check('iqb: heartbeats from json adapter', Array.isArray(iqb.json?.heartbeats) && iqb.json.heartbeats.length === 1, iqb.json?.heartbeats?.length)
check(
  'iqb: heartbeat statusLine joins status + last_action',
  typeof iqb.json?.heartbeats?.[0]?.statusLine === 'string' &&
    iqb.json.heartbeats[0].statusLine.startsWith('aligned · '),
  iqb.json?.heartbeats?.[0]?.statusLine?.slice(0, 60),
)
check('iqb: heartbeat age from updated_at', iqb.json?.heartbeats?.[0]?.ageSeconds > 1000, iqb.json?.heartbeats?.[0]?.ageSeconds)
check('iqb: root is the requested workspace', iqb.json?.root === IQB, iqb.json?.root)
check('iqb: exactly one root listed', iqb.json?.roots?.length === 1, JSON.stringify(iqb.json?.roots))

const fake = await call(route, { url: `${route.path}?root=${encodeURIComponent(fakeRoot)}` })
save('fake', fake.json)
summary('fake', fake)
check('fake: 200 + ok', fake.status === 200 && fake.json?.ok === true)
check('fake: contract.source flow.json', fake.json?.contract?.source === 'flow.json')
check('fake: experiments empty', fake.json?.experiments?.total === 0 && fake.json.experiments.groups.length === 0)
check('fake: tasks empty', fake.json?.tasks?.total === 0 && fake.json.tasks.counts.other === 0)
check('fake: gate shape with missing file', fake.json?.gate?.lines.length === 0 && fake.json.gate.size === 0)
check('fake: heartbeats empty', Array.isArray(fake.json?.heartbeats) && fake.json.heartbeats.length === 0)
check('fake: runs empty', Array.isArray(fake.json?.runs) && fake.json.runs.length === 0)
check('fake: head nulls (non-git)', JSON.stringify(fake.json?.head) === JSON.stringify({ sha: null, subject: null, branch: null, dirty: null }), JSON.stringify(fake.json?.head))
check('fake: gate-missing warning', (fake.json?.warnings ?? []).some((line) => line.includes('gate log missing')))
check('fake: root is the requested workspace', fake.json?.root === fakeRoot, fake.json?.root)
check('fake: exactly one root listed', fake.json?.roots?.length === 1, JSON.stringify(fake.json?.roots))

const broken = await call(route, { url: `${route.path}?root=${encodeURIComponent(brokenRoot)}` })
save('broken', broken.json)
summary('broken', broken)
check('broken: 200 + ok', broken.status === 200 && broken.json?.ok === true)
check('broken: falls back to defaults', broken.json?.contract?.source === 'defaults')
check('broken: manifest-invalid warning', (broken.json?.warnings ?? []).some((line) => line.startsWith('manifest-invalid')), JSON.stringify(broken.json?.warnings))
check('broken: root is the requested workspace', broken.json?.root === brokenRoot, broken.json?.root)
check('broken: exactly one root listed', broken.json?.roots?.length === 1, JSON.stringify(broken.json?.roots))

// --------------------------------------------- registered but uninitialized

const plain = await call(route, { url: `${route.path}?root=${encodeURIComponent(PLAIN)}` })
save('not-initialized', plain.json)
summary('plain', plain)
check('plain: 200', plain.status === 200)
check('plain: ok false + not-initialized', plain.json?.ok === false && plain.json?.error?.code === 'not-initialized', JSON.stringify(plain.json?.error))
check('plain: root is the requested workspace', plain.json?.root === PLAIN, plain.json?.root)
check('plain: exactly one root listed', plain.json?.roots?.length === 1, JSON.stringify(plain.json?.roots))
check('plain: name is the registered workspace title', plain.json?.roots?.[0]?.name === 'PlainWorkspace', JSON.stringify(plain.json?.roots?.[0]))
check('plain: no ledger read from another project', plain.json?.contract === undefined && plain.json?.tasks === undefined)

const plainSub = await call(route, { url: `${route.path}?root=${encodeURIComponent(PLAIN_SUB)}` })
summary('plain/sub', plainSub)
check('plain/sub: 200', plainSub.status === 200)
check(
  'plain/sub: not-initialized (inside a registered workspace)',
  plainSub.json?.ok === false && plainSub.json?.error?.code === 'not-initialized',
  JSON.stringify(plainSub.json?.error),
)
check('plain/sub: root is the requested directory', plainSub.json?.root === PLAIN_SUB, plainSub.json?.root)
check('plain/sub: exactly one root listed', plainSub.json?.roots?.length === 1, JSON.stringify(plainSub.json?.roots))

// ---------------------------------------------------------------- boundaries

const etc = await call(route, { url: `${route.path}?root=${encodeURIComponent('/etc')}` })
save('unknown-root', etc.json)
summary('unknown-root(/etc)', etc)
check('unknown-root: 400', etc.status === 400)
check('unknown-root: code unknown-root', etc.json?.error?.code === 'unknown-root', JSON.stringify(etc.json?.error))

const post = await call(route, { method: 'POST' })
check('POST: 405', post.status === 405)
check('POST: allow header', post.headers.allow === 'GET')
check('POST: code method-not-allowed', post.json?.error?.code === 'method-not-allowed')

const evil = await call(route, { url: `${route.path}?root=${encodeURIComponent(alpha)}`, origin: 'https://evil.example' })
check('foreign origin: 403', evil.status === 403)
check('foreign origin: code forbidden', evil.json?.error?.code === 'forbidden')

const sameOrigin = await call(route, { url: `${route.path}?root=${encodeURIComponent(alpha)}`, origin: ORIGIN })
check('same origin: 200', sameOrigin.status === 200 && sameOrigin.json?.ok === true)

const unknown = await call(route, { url: `${route.path}?root=${encodeURIComponent(STRANGER)}` })
check('unknown tmp path: 400 unknown-root', unknown.status === 400 && unknown.json?.error?.code === 'unknown-root', JSON.stringify(unknown.json?.error))

const missing = await call(route, { url: `${route.path}?root=${encodeURIComponent('/tmp/definitely-not-a-project-flow-root')}` })
check('missing path: 400 bad-root', missing.status === 400 && missing.json?.error?.code === 'bad-root', JSON.stringify(missing.json?.error))

// ------------------------------------------------------- init write endpoint

const initFirst = await call(initRoute, { method: 'POST', body: JSON.stringify({ root: INIT }) })
save('init', initFirst.json)
check('init: 200 + ok', initFirst.status === 200 && initFirst.json?.ok === true, `status=${initFirst.status}`)
check('init: alreadyInitialized false', initFirst.json?.alreadyInitialized === false, JSON.stringify(initFirst.json?.alreadyInitialized))
check(
  'init: created contains .dsh/flow/flow.json',
  Array.isArray(initFirst.json?.created) && initFirst.json.created.includes('.dsh/flow/flow.json'),
  JSON.stringify(initFirst.json?.created),
)
check('init: name is the workspace title', initFirst.json?.name === 'InitWorkspace', initFirst.json?.name)

const initState = await call(route, { url: `${route.path}?root=${encodeURIComponent(INIT)}` })
summary('init GET', initState)
check('init GET: 200 + ok', initState.status === 200 && initState.json?.ok === true, `status=${initState.status}`)
check(
  'init GET: contract source store contract',
  initState.json?.contract?.source === '.dsh/flow/flow.json',
  initState.json?.contract?.source,
)
check('init GET: contract name InitWorkspace', initState.json?.contract?.name === 'InitWorkspace', initState.json?.contract?.name)

const initSecond = await call(initRoute, { method: 'POST', body: JSON.stringify({ root: INIT }) })
check('init again: 200 + ok', initSecond.status === 200 && initSecond.json?.ok === true)
check('init again: alreadyInitialized true', initSecond.json?.alreadyInitialized === true, JSON.stringify(initSecond.json?.alreadyInitialized))
check(
  'init again: created empty',
  Array.isArray(initSecond.json?.created) && initSecond.json.created.length === 0,
  JSON.stringify(initSecond.json?.created),
)

const initStranger = await call(initRoute, { method: 'POST', body: JSON.stringify({ root: STRANGER }) })
check(
  'init stranger: 400 unknown-root',
  initStranger.status === 400 && initStranger.json?.error?.code === 'unknown-root',
  JSON.stringify(initStranger.json?.error),
)

const initNoRoot = await call(initRoute, { method: 'POST', body: '{}' })
check(
  'init no root: 400 bad-root',
  initNoRoot.status === 400 && initNoRoot.json?.error?.code === 'bad-root',
  JSON.stringify(initNoRoot.json?.error),
)

const initEvil = await call(initRoute, { method: 'POST', body: JSON.stringify({ root: INIT }), origin: 'https://evil.example' })
check(
  'init foreign origin: 403 forbidden',
  initEvil.status === 403 && initEvil.json?.error?.code === 'forbidden',
  JSON.stringify(initEvil.json?.error),
)

const initGet = await call(initRoute)
check('init GET: 405', initGet.status === 405, `status=${initGet.status}`)
check('init GET: allow POST', initGet.headers.allow === 'POST', JSON.stringify(initGet.headers.allow))
check('init GET: code method-not-allowed', initGet.json?.error?.code === 'method-not-allowed')

const initBadJson = await call(initRoute, { method: 'POST', body: '{not json' })
check(
  'init bad json: 400 bad-request',
  initBadJson.status === 400 && initBadJson.json?.error?.code === 'bad-request',
  JSON.stringify(initBadJson.json?.error),
)

// ------------------------------------------------------------ dispose check

for (const dispose of disposers) dispose()
check('dispose unregisters route', routes.length === 0, `routes=${routes.length}`)

// No registry and a cwd without any ledger marker: the endpoint must still answer.
process.chdir(PLAIN)
apply(makeCtx([]))
const emptyCtxRoute = routes.find((entry) => entry.path === '/api/project-flow/state')
const none = await call(emptyCtxRoute)
save('no-project', none.json)
summary('no-project', none)
check('no-project: 200', none.status === 200)
check('no-project: ok false + code', none.json?.ok === false && none.json?.error?.code === 'no-project', JSON.stringify(none.json))
check('no-project: roots empty', Array.isArray(none.json?.roots) && none.json.roots.length === 0)
check('no-project: root null', none.json?.root === null)
process.chdir(originalCwd)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
