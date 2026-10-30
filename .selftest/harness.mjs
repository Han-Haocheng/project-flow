// project-flow Host self-test harness — local, no deps, self-contained.
//
// Loads index.js with a mock Cordis context (webServer + workspaceRegistry),
// then drives the registered routes — explicit `?root=<dir>`, process-cwd, the
// init write and error paths — with plain request/response doubles.
//
// Every fixture is synthesized under os.tmpdir(): two initialized store
// projects (a full one and a minimal one), a retired legacy layout, a broken
// store manifest, an uninitialized workspace and a stranger directory. Response
// bodies are written to a throwaway directory for inspection, never back into
// the tracked .selftest/ tree.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = dirname(here)
const TMP = mkdtempSync(join(tmpdir(), 'project-flow-harness-'))
const STATE = join(TMP, 'state')
const ALPHA = join(TMP, 'alpha')
const QBANK = join(TMP, 'qbank')
const PLAIN = join(TMP, 'plain')
const PLAIN_SUB = PLAIN + '/sub'
const INIT = join(TMP, 'init')
const STRANGER = join(TMP, 'stranger')
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
  writeFileSync(join(STATE, `state-${name}.json`), JSON.stringify(payload, null, 2))
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
    } exp=${json.experiments?.total ?? '-'} tasks=${json.tasks?.total ?? '-'} hb=${
      json.heartbeats?.length ?? '-'
    } warnings=${json.warnings?.length ?? '-'}`,
  )
}

// ------------------------------------------ fixture: legacy layout (retired)
//
// A project that still has the old root `flow.json` + `.agents` ledger is *not*
// a flow store any more: without `.dsh/flow/flow.json` the endpoint reports the
// uninitialized empty state instead of reading the legacy files.

const legacyRoot = join(TMP, 'legacy')
mkdirSync(join(legacyRoot, 'ledger/tasks'), { recursive: true })
writeFileSync(
  join(legacyRoot, 'flow.json'),
  JSON.stringify({ schema: 1, name: 'LegacyProject', experiments: { source: 'none' }, tasks: { source: 'json', dir: 'ledger/tasks' } }),
)
writeFileSync(join(legacyRoot, 'ledger/tasks', 'task-1.json'), JSON.stringify({ id: 'T-LEGACY-01', title: 'legacy', status: 'active' }))

// A broken store contract: schema 2 exists but its JSON is invalid, so the
// reader falls back to defaults and reports a manifest warning.
const brokenRoot = join(TMP, 'broken')
mkdirSync(join(brokenRoot, '.dsh', 'flow'), { recursive: true })
writeFileSync(join(brokenRoot, '.dsh/flow/flow.json'), '{ this is not json }')

// ------------------------------------------------- fixtures: store projects
//
// Store mode is a directory with `.dsh/flow/flow.json` plus the collections the
// manifest declares. Both projects below are synthesized from scratch, so the
// harness never depends on a developer machine's real project paths.

function writeStoreManifest(root, { name }) {
  mkdirSync(join(root, '.dsh/flow/experiments'), { recursive: true })
  mkdirSync(join(root, '.dsh/flow/tasks'), { recursive: true })
  mkdirSync(join(root, '.dsh/flow/gates'), { recursive: true })
  mkdirSync(join(root, '.dsh/flow/logs'), { recursive: true })
  mkdirSync(join(root, '.agents/heartbeat'), { recursive: true })
  writeFileSync(
    join(root, '.dsh/flow/flow.json'),
    JSON.stringify(
      {
        schema: 2,
        name,
        store: { root: '.dsh/flow' },
        experiments: { source: 'store', dir: '.dsh/flow/experiments' },
        tasks: { source: 'json', dir: '.dsh/flow/tasks', current: null, recentLimit: 6 },
        gates: { dir: '.dsh/flow/gates', logs: '.dsh/flow/logs' },
        heartbeats: { source: 'json', dir: '.agents/heartbeat', max: 20 },
      },
      null,
      2,
    ),
  )
}

function writeStoreRecord(root, collection, record) {
  writeFileSync(join(root, '.dsh/flow', collection, `${record.id}.json`), JSON.stringify(record, null, 2))
}

function storeExperiment(id, overrides = {}) {
  return {
    schema: 1,
    id,
    title: `实验 ${id}`,
    hypothesis: 'A 改善 B',
    factor: 'focus',
    expected: 'a<=1',
    scale: 'small',
    status: 'open',
    measured: '',
    metrics: {},
    commits: [],
    notes: '',
    parent: null,
    created_at: '2026-10-28T10:00:00+08:00',
    updated_at: '2026-10-28T10:00:00+08:00',
    ...overrides,
  }
}

function storeTask(id, overrides = {}) {
  return {
    schema: 1,
    id,
    title: `任务 ${id}`,
    status: 'draft',
    owner: '',
    goal: '',
    scope: { allow: [], deny: [] },
    acceptance: [],
    checkpoints: [],
    commits: [],
    notes: '',
    created_at: '2026-10-28T10:00:00+08:00',
    updated_at: '2026-10-28T10:00:00+08:00',
    ...overrides,
  }
}

function storeHeartbeat(session, overrides = {}) {
  return {
    schema: 1,
    session,
    agent: 'lead',
    status: 'working',
    goal: 'demo 目标',
    task: null,
    claims: [],
    last_action: '推进 demo',
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

// alpha: a full store project — parent/child experiments, tasks in all three
// open states, one gate definition, an enabled gate log and one heartbeat.
writeStoreManifest(ALPHA, { name: 'demo-alpha' })
writeStoreRecord(
  ALPHA,
  'experiments',
  storeExperiment('E-20261028-01', {
    title: '基线实验',
    status: 'confirmed',
    measured: '+3%',
    commits: ['abc1234'],
  }),
)
writeStoreRecord(ALPHA, 'experiments', storeExperiment('E-20261028-02', { title: '子实验', parent: 'E-20261028-01' }))
writeStoreRecord(ALPHA, 'tasks', storeTask('T-20261028-01', { title: '已完成任务', status: 'done' }))
writeStoreRecord(ALPHA, 'tasks', storeTask('T-20261028-02', { title: '进行中任务', status: 'active' }))
writeStoreRecord(ALPHA, 'tasks', storeTask('T-20261028-03', { title: '草稿任务' }))
writeStoreRecord(ALPHA, 'gates', {
  schema: 1,
  id: 'smoke',
  title: '冒烟门禁',
  phase: 'commit',
  enabled: true,
  steps: [{ id: 'unit', run: 'true', expect: 'exit 0', timeoutSeconds: 60 }],
  created_at: '2026-10-28T10:00:00+08:00',
  updated_at: '2026-10-28T10:00:00+08:00',
})
writeFileSync(
  join(ALPHA, '.agents/heartbeat', 'session-alpha.json'),
  JSON.stringify(storeHeartbeat('session-alpha', { goal: 'alpha 目标', task: 'T-20261028-02' })),
)

// qbank: a second store project with no experiments, no gate log, two tasks
// and a JSON heartbeat that the panel renders through the json adapter.
writeStoreManifest(QBANK, { name: 'demo-qbank' })
writeStoreRecord(QBANK, 'tasks', storeTask('T-20261028-11', { title: '已完成评审', status: 'done' }))
writeStoreRecord(QBANK, 'tasks', storeTask('T-20261028-12', { title: '进行中实现', status: 'active' }))
writeFileSync(
  join(QBANK, '.agents/heartbeat', 'session-qbank.json'),
  JSON.stringify(
    storeHeartbeat('session-qbank', {
      status: 'aligned',
      task: null,
      last_action: '等待复核',
      updated_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    }),
  ),
)

// Response bodies go to a throwaway directory so a run never dirties the tree.
mkdirSync(STATE, { recursive: true })

// A registered workspace with no ledger at all, plus one of its subdirectories.
mkdirSync(PLAIN_SUB, { recursive: true })
// An existing directory that is neither registered nor carries a manifest.
mkdirSync(STRANGER, { recursive: true })
// A registered workspace that starts empty and is initialized through POST below.
mkdirSync(INIT, { recursive: true })

// --------------------------------------------------------------------- run

apply(makeCtx([ALPHA, QBANK, legacyRoot, brokenRoot, PLAIN, INIT]))
check('routes registered', routes.length === 3, `routes=${routes.length}`)
const route = routes.find((entry) => entry.path === '/api/project-flow/state')
const initRoute = routes.find((entry) => entry.path === '/api/project-flow/init')
const gateRoute = routes.find((entry) => entry.path === '/api/project-flow/gate')
check('gate route is exact POST path', gateRoute?.kind === 'exact' && gateRoute?.path === '/api/project-flow/gate', JSON.stringify(gateRoute?.kind))
check('state route is exact GET path', route?.kind === 'exact' && route?.path === '/api/project-flow/state', JSON.stringify(route?.kind))
check(
  'init route is exact POST path',
  initRoute?.kind === 'exact' && initRoute?.path === '/api/project-flow/init',
  JSON.stringify(initRoute?.kind),
)

// --------------------------------------------------- no root param (process cwd)

const originalCwd = process.cwd()

process.chdir(ALPHA)
const auto = await call(route)
save('auto', auto.json)
summary(`auto(root omitted, cwd=${ALPHA})`, auto)
check('auto: 200 + ok', auto.status === 200 && auto.json?.ok === true)
check('auto: root is the cwd workspace', auto.json?.root === ALPHA, auto.json?.root)
check('auto: exactly one root listed', Array.isArray(auto.json?.roots) && auto.json.roots.length === 1, `roots=${auto.json?.roots?.length}`)
check('auto: listed root is the cwd workspace', auto.json?.roots?.[0]?.path === ALPHA, JSON.stringify(auto.json?.roots))
check('auto: no-store header', auto.headers['cache-control'] === 'no-store')

process.chdir(PLAIN)

process.chdir(ALPHA)

// ---------------------------------------- initialized store project (alpha)

const alpha = await call(route, { url: `${route.path}?root=${encodeURIComponent(ALPHA)}` })
save('alpha', alpha.json)
summary('alpha', alpha)
check('alpha: 200 + ok', alpha.status === 200 && alpha.json?.ok === true)
check(
  'alpha: contract.source is the store contract',
  alpha.json?.contract?.source === '.dsh/flow/flow.json',
  alpha.json?.contract?.source,
)
check('alpha: contract name demo-alpha', alpha.json?.contract?.name === 'demo-alpha', alpha.json?.contract?.name)
check('alpha: contract schema 2', alpha.json?.contract?.schema === 2, alpha.json?.contract?.schema)
check('alpha: experiments.total == 2', alpha.json?.experiments?.total === 2, alpha.json?.experiments?.total)
check(
  'alpha: experiment status counts',
  alpha.json?.experiments?.counts?.confirmed === 1 && alpha.json?.experiments?.counts?.open === 1,
  JSON.stringify(alpha.json?.experiments?.counts),
)
check(
  'alpha: parent link exposed in the tree',
  JSON.stringify(alpha.json?.experiments?.tree ?? []).includes('E-20261028-02'),
  JSON.stringify(alpha.json?.experiments?.tree),
)
check('alpha: tasks.total == 3', alpha.json?.tasks?.total === 3, alpha.json?.tasks?.total)
check(
  'alpha: task status counts',
  alpha.json?.tasks?.counts?.active === 1 &&
    alpha.json?.tasks?.counts?.done === 1 &&
    alpha.json?.tasks?.counts?.draft === 1,
  JSON.stringify(alpha.json?.tasks?.counts),
)
check(
  'alpha: recentDone lists the done task',
  alpha.json?.tasks?.recentDone?.length === 1 && alpha.json.tasks.recentDone[0].id === 'T-20261028-01',
  JSON.stringify(alpha.json?.tasks?.recentDone),
)
check('alpha: tasks.current is null', alpha.json?.tasks?.current === null, alpha.json?.tasks?.current)
check(
  'alpha: gates list one definition',
  alpha.json?.gates?.length === 1 && alpha.json.gates[0].id === 'smoke',
  JSON.stringify(alpha.json?.gates),
)
check(
  'alpha: retired gate/runs/team sections are absent',
  alpha.json?.gate === undefined && alpha.json?.runs === undefined && alpha.json?.team === undefined,
  JSON.stringify(Object.keys(alpha.json ?? {})),
)
check(
  'alpha: one heartbeat with statusLine',
  Array.isArray(alpha.json?.heartbeats) &&
    alpha.json.heartbeats.length === 1 &&
    typeof alpha.json.heartbeats[0].statusLine === 'string' &&
    alpha.json.heartbeats[0].statusLine.startsWith('working · '),
  JSON.stringify(alpha.json?.heartbeats),
)
check(
  'alpha: head nulls (non-git)',
  JSON.stringify(alpha.json?.head) === JSON.stringify({ sha: null, subject: null, branch: null, dirty: null }),
  JSON.stringify(alpha.json?.head),
)
check('alpha: root is the requested workspace', alpha.json?.root === ALPHA, alpha.json?.root)
check('alpha: exactly one root listed', alpha.json?.roots?.length === 1, JSON.stringify(alpha.json?.roots))
check(
  'alpha: root name comes from the store contract',
  alpha.json?.roots?.[0]?.name === 'demo-alpha',
  JSON.stringify(alpha.json?.roots),
)

// ---------------------------------- second store project, no gate (qbank)

const qbank = await call(route, { url: `${route.path}?root=${encodeURIComponent(QBANK)}` })
save('qbank', qbank.json)
summary('qbank', qbank)
check('qbank: 200 + ok', qbank.status === 200 && qbank.json?.ok === true)
check(
  'qbank: contract.source is the store contract',
  qbank.json?.contract?.source === '.dsh/flow/flow.json',
  qbank.json?.contract?.source,
)
check('qbank: contract name demo-qbank', qbank.json?.contract?.name === 'demo-qbank', qbank.json?.contract?.name)
check('qbank: tasks.total == 2', qbank.json?.tasks?.total === 2, qbank.json?.tasks?.total)
check(
  'qbank: task status counts (active 1, done 1, other 0)',
  qbank.json?.tasks?.counts?.active === 1 &&
    qbank.json?.tasks?.counts?.done === 1 &&
    qbank.json?.tasks?.counts?.other === 0,
  JSON.stringify(qbank.json?.tasks?.counts),
)
check(
  'qbank: recentDone lists the done task',
  qbank.json?.tasks?.recentDone?.length === 1 && qbank.json.tasks.recentDone[0].id === 'T-20261028-11',
  JSON.stringify(qbank.json?.tasks?.recentDone),
)
check('qbank: experiments.total == 0', qbank.json?.experiments?.total === 0, qbank.json?.experiments?.total)
check(
  'qbank: heartbeats from json adapter',
  Array.isArray(qbank.json?.heartbeats) && qbank.json.heartbeats.length === 1,
  qbank.json?.heartbeats?.length,
)
check(
  'qbank: heartbeat statusLine joins status + last_action',
  typeof qbank.json?.heartbeats?.[0]?.statusLine === 'string' &&
    qbank.json.heartbeats[0].statusLine.startsWith('aligned · '),
  qbank.json?.heartbeats?.[0]?.statusLine?.slice(0, 60),
)
check('qbank: heartbeat age from updated_at', qbank.json?.heartbeats?.[0]?.ageSeconds > 1000, qbank.json?.heartbeats?.[0]?.ageSeconds)
check('qbank: root is the requested workspace', qbank.json?.root === QBANK, qbank.json?.root)
check('qbank: exactly one root listed', qbank.json?.roots?.length === 1, JSON.stringify(qbank.json?.roots))
check(
  'qbank: root name comes from the store contract',
  qbank.json?.roots?.[0]?.name === 'demo-qbank',
  JSON.stringify(qbank.json?.roots),
)

// ------------------------------------------ retired legacy layout
//
// The old root `flow.json` is not a store: the workspace is reported as
// uninitialized, with no ledger section and no legacy read path.

const legacy = await call(route, { url: `${route.path}?root=${encodeURIComponent(legacyRoot)}` })
save('legacy', legacy.json)
summary('legacy', legacy)
check('legacy: 200', legacy.status === 200)
check('legacy: ok false + not-initialized', legacy.json?.ok === false && legacy.json?.error?.code === 'not-initialized', JSON.stringify(legacy.json?.error))
check('legacy: no ledger sections', legacy.json?.experiments === undefined && legacy.json?.tasks === undefined && legacy.json?.contract === undefined)
check('legacy: no legacy/runs/gate/team fields', legacy.json?.runs === undefined && legacy.json?.gate === undefined && legacy.json?.team === undefined)
check('legacy: root is the requested workspace', legacy.json?.root === legacyRoot, legacy.json?.root)

const broken = await call(route, { url: `${route.path}?root=${encodeURIComponent(brokenRoot)}` })
save('broken', broken.json)
summary('broken', broken)
check('broken: 200 + ok', broken.status === 200 && broken.json?.ok === true)
check('broken: falls back to defaults', broken.json?.contract?.source === 'defaults')
check('broken: manifest-invalid warning', (broken.json?.warnings ?? []).some((line) => line.includes('manifest-invalid')), JSON.stringify(broken.json?.warnings))
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

const evil = await call(route, { url: `${route.path}?root=${encodeURIComponent(ALPHA)}`, origin: 'https://evil.example' })
check('foreign origin: 403', evil.status === 403)
check('foreign origin: code forbidden', evil.json?.error?.code === 'forbidden')

const sameOrigin = await call(route, { url: `${route.path}?root=${encodeURIComponent(ALPHA)}`, origin: ORIGIN })
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

console.log(`responses written to ${STATE}`)
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
