import { apply } from '../index.js'

const routes = []
const ctx = {
  get(name) {
    if (name === 'workspaceRegistry') return { list: () => [{ path: '/tmp/pf-demo/alpha' }] }
    return undefined
  },
  webServer: { getOrigin: () => 'http://127.0.0.1:44453', register(route) { routes.push(route); return () => {} } },
  effect(fn) { return fn() },
}
apply(ctx)
const handler = routes[0].handler
function call(url) {
  return new Promise((resolve) => {
    const response = {
      headers: {},
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) },
      end(body) { resolve({ status: this.status, body: JSON.parse(String(body)) }) },
    }
    handler({ method: 'GET', url, headers: {} }, response)
  })
}
for (const url of ['/api/project-flow/state?root=/tmp/pf-demo/qbank', '/api/project-flow/state?root=/etc']) {
  const { status, body } = await call(url)
  console.log(url, '->', status, body.ok, body.root, body.contract?.source, 'roots=', (body.roots || []).map((r) => r.path), 'tasks=', body.tasks?.total, 'gate=', body.gate === null ? 'null' : body.gate?.lines?.length, 'hb=', body.heartbeats?.length)
}
