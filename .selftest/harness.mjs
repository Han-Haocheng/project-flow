// project-flow Host self-test harness — local, read-only, no deps.
//
// Loads index.js with a mock Cordis context (webServer + workspaceRegistry),
// then drives the registered route with plain request/response doubles. Every
// response body is written to .selftest/state-*.json for inspection.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = dirname(here)
const alpha = '/tmp/pf-demo/alpha'
const IQB = '/tmp/pf-demo/qbank'
const ORIGIN = 'http://127.0.0.1:44453'

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
      return registryPaths.map((path) => ({ path, title: path.split('/').pop() }))
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

async function call(route, { method = 'GET', url, origin } = {}) {
  let finish
  const finished = new Promise((settle) => {
    finish = settle
  })
  const response = fakeResponse(finish)
  const headers = {}
  if (origin !== undefined) headers.origin = origin
  const timer = setTimeout(finish, 30_000)
  route.handler({ method, url: url ?? route.path, headers }, response)
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

// --------------------------------------------------------------------- run

apply(makeCtx([alpha, IQB, fakeRoot, brokenRoot]))
check('route registered', routes.length === 1, `routes=${routes.length}`)
const route = routes[0]
check('route is exact GET path', route.kind === 'exact' && route.path === '/api/project-flow/state', JSON.stringify(route.kind))

const auto = await call(route)
save('auto', auto.json)
summary('auto(root omitted)', auto)
check('auto: 200 + ok', auto.status === 200 && auto.json?.ok === true)
check('auto: every candidate root listed', Array.isArray(auto.json?.roots) && auto.json.roots.length === 4, `roots=${auto.json?.roots?.length}`)
check('auto: root is a real candidate', [alpha, IQB, fakeRoot, brokenRoot].includes(auto.json?.root))
check('auto: no-store header', auto.headers['cache-control'] === 'no-store')

const alpha = await call(route, { url: `${route.path}?root=${encodeURIComponent(alpha)}` })
save('alpha', alpha.json)
summary('alpha', alpha)
check('alpha: 200 + ok', alpha.status === 200 && alpha.json?.ok === true)
check('alpha: contract.source defaults', alpha.json?.contract?.source === 'defaults', alpha.json?.contract?.source)
check('alpha: contract name alpha', alpha.json?.contract?.name === 'alpha', alpha.json?.contract?.name)
check('alpha: experiments.total >= 1', alpha.json?.experiments?.total >= 1, alpha.json?.experiments?.total)
check('alpha: tasks.total >= 49', alpha.json?.tasks?.total >= 49, alpha.json?.tasks?.total)
check('alpha: gate.lines non-empty', Array.isArray(alpha.json?.gate?.lines) && alpha.json.gate.lines.length > 0)
check('alpha: gate has mtime/size', typeof alpha.json?.gate?.mtime === 'number' && alpha.json.gate.size > 0)
check('alpha: heartbeats non-empty', Array.isArray(alpha.json?.heartbeats) && alpha.json.heartbeats.length > 0)
check('alpha: head.sha present', typeof alpha.json?.head?.sha === 'string' && alpha.json.head.sha.length >= 7, JSON.stringify(alpha.json?.head))
check('alpha: tasks.current present', typeof alpha.json?.tasks?.current === 'string', alpha.json?.tasks?.current)
check('alpha: run shape bounded', alpha.json?.runs.length <= 4)

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

const broken = await call(route, { url: `${route.path}?root=${encodeURIComponent(brokenRoot)}` })
save('broken', broken.json)
summary('broken', broken)
check('broken: 200 + ok', broken.status === 200 && broken.json?.ok === true)
check('broken: falls back to defaults', broken.json?.contract?.source === 'defaults')
check('broken: manifest-invalid warning', (broken.json?.warnings ?? []).some((line) => line.startsWith('manifest-invalid')), JSON.stringify(broken.json?.warnings))

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

const unknown = await call(route, { url: `${route.path}?root=/tmp/definitely-not-a-project-flow-root` })
check('unknown path: 400 unknown-root', unknown.status === 400 && unknown.json?.error?.code === 'unknown-root')

// ------------------------------------------------------------ dispose check

for (const dispose of disposers) dispose()
check('dispose unregisters route', routes.length === 0, `routes=${routes.length}`)

// No registry and a cwd without any ledger marker: the endpoint must still answer.
apply(makeCtx([]))
const emptyCtxRoute = routes[routes.length - 1]
const none = await call(emptyCtxRoute)
save('no-project', none.json)
summary('no-project', none)
check('no-project: 200', none.status === 200)
check('no-project: ok false + code', none.json?.ok === false && none.json?.error?.code === 'no-project', JSON.stringify(none.json))
check('no-project: roots empty', Array.isArray(none.json?.roots) && none.json.roots.length === 0)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
