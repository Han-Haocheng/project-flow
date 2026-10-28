// project-flow Host stage 2 self-test — local, no deps, /tmp fixtures only.
//
// Loads index.js with a mock Cordis context (webServer + tools + skills +
// workingDirectory), builds a real `.dsh/flow` store through lib/core.mjs, and
// drives the four tools plus the HTTP endpoint in both store and legacy modes.
// Run: node .selftest/host2-tools.mjs

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = dirname(here)
const ORIGIN = 'http://127.0.0.1:44453'

let core
try {
  core = await import(pathToFileURL(join(pkgRoot, 'lib', 'core.mjs')).href)
} catch (error) {
  console.log(`SKIP core unavailable: ${error.message}`)
  process.exit(0)
}

const { apply } = await import(pathToFileURL(join(pkgRoot, 'index.js')).href)

// --------------------------------------------------------------- assertions

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS ${label}`)
    return true
  }
  failed += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}

function eq(label, actual, expected) {
  return check(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

async function throws(label, fn, include) {
  try {
    await fn()
    return check(label, false, 'did not throw')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const ok = typeof include === 'function' ? include(message) : message.includes(include)
    return check(label, ok, message)
  }
}

// ------------------------------------------------------------- fake context

const registeredTools = new Map()
const registeredSkills = new Map()
const routes = []
const disposers = []

const toolsService = {
  register(definition) {
    registeredTools.set(definition.name, definition)
    return () => registeredTools.delete(definition.name)
  },
}

const skillsService = {
  register(skill) {
    registeredSkills.set(skill.name, skill)
    return () => registeredSkills.delete(skill.name)
  },
}

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

function makeCtx({ workingDirectory, registryPaths }) {
  const services = {
    webServer,
    tools: toolsService,
    skills: skillsService,
    workingDirectory,
    workspaceRegistry: {
      list() {
        return registryPaths.map((path) => ({ path, title: path.split('/').pop() }))
      },
    },
  }
  return {
    get(name) {
      return services[name]
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
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

async function call(route, url) {
  let finish
  const finished = new Promise((settle) => {
    finish = settle
  })
  const response = fakeResponse(finish)
  const timer = setTimeout(finish, 30_000)
  route.handler({ method: 'GET', url: url ?? route.path, headers: {} }, response)
  await finished
  clearTimeout(timer)
  let json
  try {
    json = JSON.parse(response.state.body)
  } catch {
    json = undefined
  }
  return { status: response.state.status, json, raw: response.state.body }
}

// --------------------------------------------------------------- fixtures

const storeRoot = mkdtempSync(join(tmpdir(), 'project-flow-host2-store-'))
const initResult = core.initProject(storeRoot, { name: 'Host2Test' })

const legacyRoot = mkdtempSync(join(tmpdir(), 'project-flow-host2-legacy-'))
mkdirSync(join(legacyRoot, 'ledger', 'tasks'), { recursive: true })
writeFileSync(
  join(legacyRoot, 'flow.json'),
  JSON.stringify({
    schema: 1,
    name: 'LegacyTest',
    experiments: { source: 'none' },
    tasks: { source: 'json', dir: 'ledger/tasks' },
    gate: { log: 'ledger/gate.log' },
    heartbeats: { source: 'md', dir: 'ledger/hb' },
    runs: { dirs: [] },
  }),
)
writeFileSync(
  join(legacyRoot, 'ledger', 'tasks', 'task-1.json'),
  JSON.stringify({
    id: 'T-LEGACY-01',
    title: 'Legacy task',
    status: 'active',
    owner: 'me',
    goal: 'stay green',
    updated_at: '2026-10-28T10:00:00+08:00',
  }),
)
writeFileSync(join(legacyRoot, 'ledger', 'gate.log'), 'legacy gate line\n')

const noStoreRoot = mkdtempSync(join(tmpdir(), 'project-flow-host2-nostore-'))

// --------------------------------------------------------------- apply

const session = { cwd: storeRoot }
const exec = { agent: { session } }
const ctx = makeCtx({
  workingDirectory: {
    get(received) {
      if (received !== session) throw new Error('unknown session')
      return storeRoot
    },
  },
  registryPaths: [storeRoot, legacyRoot],
})

apply(ctx)

check('store fixture initialized', initResult.created.includes('.dsh/flow/flow.json'), JSON.stringify(initResult))
eq('route registered', routes.length, 1)
const route = routes[0]

// ------------------------------------------------------------- tool surface

const EXPECTED_TOOLS = ['flow_status', 'flow_exp', 'flow_task', 'flow_gate']
check('four tools registered', registeredTools.size === 4, `got ${[...registeredTools.keys()].join(', ')}`)
for (const name of EXPECTED_TOOLS) {
  const definition = registeredTools.get(name)
  if (check(`${name}: registered`, definition !== undefined) === false) continue
  check(`${name}: description non-empty`, typeof definition.description === 'string' && definition.description.length > 20)
  check(
    `${name}: parameters object schema`,
    definition.parameters?.type === 'object' &&
      definition.parameters.additionalProperties === false &&
      Array.isArray(definition.parameters.required),
    JSON.stringify(definition.parameters),
  )
  check(`${name}: execute is function`, typeof definition.execute === 'function')
  check(`${name}: render function`, typeof definition.output?.render === 'function')
  eq(`${name}: concurrency safety`, definition.isConcurrencySafe, name === 'flow_status')
  const rendered = definition.output.render({}, { ok: true })
  check(
    `${name}: render returns text block`,
    Array.isArray(rendered) && rendered.length === 1 && rendered[0].type === 'text' && JSON.parse(rendered[0].text).ok === true,
  )
}

// The Harness tool registry enforces a JSON-Schema subset: type/oneOf/
// properties/required/additionalProperties/items/enum/const plus annotations.
// A keyword such as `minimum` would reject registration in production, so keep
// the local check in sync with that subset.
const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

function schemaIssues(schema, path, out) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    out.push(`${path} must be a schema object`)
    return out
  }
  for (const key of Object.keys(schema)) {
    if (ALLOWED_SCHEMA_KEYS.has(key) === false) out.push(`${path}.${key} is not a supported keyword`)
  }
  const type = schema.type
  if (schema.oneOf !== undefined) {
    if (Array.isArray(schema.oneOf) === false) out.push(`${path}.oneOf must be an array`)
    else schema.oneOf.forEach((entry, index) => schemaIssues(entry, `${path}.oneOf[${index}]`, out))
  } else if (typeof type !== 'string') {
    out.push(`${path}.type must be a string`)
  }
  if (schema.properties !== undefined) {
    for (const [key, child] of Object.entries(schema.properties)) schemaIssues(child, `${path}.properties.${key}`, out)
  }
  if (schema.items !== undefined) schemaIssues(schema.items, `${path}.items`, out)
  return out
}

for (const name of EXPECTED_TOOLS) {
  const definition = registeredTools.get(name)
  if (definition === undefined) continue
  const issues = [
    ...schemaIssues(definition.parameters, 'parameters', []),
    ...schemaIssues(definition.output?.schema, 'output.schema', []),
  ]
  check(`${name}: schemas inside the registry subset`, issues.length === 0, issues.join('; '))
}

const expTool = registeredTools.get('flow_exp')
const taskTool = registeredTools.get('flow_task')
const gateTool = registeredTools.get('flow_gate')
const statusTool = registeredTools.get('flow_status')

// ----------------------------------------------------------- flow_status

const statusStore = await statusTool.execute({}, exec)
eq('flow_status: store root resolved from session', statusStore.root, storeRoot)
eq('flow_status: store true', statusStore.store, true)
eq('flow_status: contract source', statusStore.contract.source, '.dsh/flow/flow.json')
eq('flow_status: contract name', statusStore.contract.name, 'Host2Test')
eq('flow_status: experiments total 0', statusStore.experiments.total, 0)
check('flow_status: gate list empty', Array.isArray(statusStore.gates) && statusStore.gates.length === 0)

const statusLegacy = await statusTool.execute({ root: legacyRoot }, exec)
eq('flow_status: explicit root wins over session', statusLegacy.root, legacyRoot)
eq('flow_status: legacy store false', statusLegacy.store, false)
eq('flow_status: legacy contract source', statusLegacy.contract.source, 'flow.json')

// --------------------------------------------------------- flow_exp chain

const createdExp = await expTool.execute(
  {
    action: 'add',
    title: '竞争性信用分配能否让预测分化',
    hypothesis: '限制信用分配范围会提高分化',
    factor: 'learning',
    expected: 'c <= 1',
    scale: 'small',
  },
  exec,
)
const expId = createdExp.experiment?.id
check('flow_exp add: id generated', typeof expId === 'string' && /^E-\d{8}-\d{2}$/.test(expId), expId)
eq('flow_exp add: status open', createdExp.experiment?.status, 'open')

const listedExp = await expTool.execute({ action: 'list' }, exec)
eq('flow_exp list: total 1', listedExp.total, 1)
eq('flow_exp list: items length 1', listedExp.items.length, 1)
eq('flow_exp list: store true', listedExp.store, true)

const shownExp = await expTool.execute({ action: 'show', id: expId }, exec)
eq('flow_exp show: id', shownExp.experiment?.id, expId)
eq('flow_exp show: hypothesis', shownExp.experiment?.hypothesis, '限制信用分配范围会提高分化')

const updatedExp = await expTool.execute({ action: 'update', id: expId, status: 'confirmed', measured: 'c=0.8' }, exec)
eq('flow_exp update: status', updatedExp.experiment?.status, 'confirmed')
eq('flow_exp update: measured', updatedExp.experiment?.measured, 'c=0.8')

const treeExp = await expTool.execute({ action: 'tree' }, exec)
check('flow_exp tree: one root', Array.isArray(treeExp.tree) && treeExp.tree.length === 1 && treeExp.tree[0].id === expId)

// -------------------------------------------------------- flow_task chain

const createdTask = await taskTool.execute(
  { action: 'add', title: '工具注册', status: 'active', owner: 'agent', goal: '4 tools + 2 skills', acceptance: ['selftest green'] },
  exec,
)
const taskId = createdTask.task?.id
check('flow_task add: id generated', typeof taskId === 'string' && /^T-\d{8}-\d{2}$/.test(taskId), taskId)

const listedTask = await taskTool.execute({ action: 'list' }, exec)
eq('flow_task list: total 1', listedTask.total, 1)
eq('flow_task list: active count', listedTask.counts.active, 1)

const shownTask = await taskTool.execute({ action: 'show', id: taskId }, exec)
eq('flow_task show: owner', shownTask.task?.owner, 'agent')

const updatedTask = await taskTool.execute({ action: 'update', id: taskId, status: 'done', commits: ['abc1234'] }, exec)
eq('flow_task update: status', updatedTask.task?.status, 'done')
check('flow_task update: commits', Array.isArray(updatedTask.task?.commits) && updatedTask.task.commits[0] === 'abc1234')

// -------------------------------------------------------- flow_gate chain

const createdGate = await gateTool.execute(
  {
    action: 'add',
    id: 'smoke',
    title: '冒烟',
    phase: 'commit',
    steps: [
      { id: 'ok', run: 'true', expect: 'exit 0', timeoutSeconds: 10 },
      { id: 'bad', run: 'false', expect: 'exit 0', timeoutSeconds: 10 },
    ],
  },
  exec,
)
eq('flow_gate add: id', createdGate.gate?.id, 'smoke')
eq('flow_gate add: steps 2', createdGate.gate?.steps.length, 2)

const runResult = await gateTool.execute({ action: 'run', id: 'smoke' }, exec)
eq('flow_gate run: overall false', runResult.run?.ok, false)
eq('flow_gate run: both steps attempted', runResult.run?.steps.length, 2)
eq('flow_gate run: first step ok', runResult.run?.steps[0]?.ok, true)
eq('flow_gate run: second step failed', runResult.run?.steps[1]?.ok, false)

const logsResult = await gateTool.execute({ action: 'logs', id: 'smoke', limit: 5 }, exec)
check('flow_gate logs: run recorded', Array.isArray(logsResult.runs) && logsResult.runs.length === 1)
eq('flow_gate logs: stored ok false', logsResult.runs?.[0]?.ok, false)

const gateList = await gateTool.execute({ action: 'list' }, exec)
eq('flow_gate list: one gate', gateList.gates?.length, 1)
check('flow_gate list: lastRun attached', gateList.gates?.[0]?.lastRun?.ok === false)

const gateShown = await gateTool.execute({ action: 'show', id: 'smoke' }, exec)
eq('flow_gate show: title', gateShown.gate?.title, '冒烟')

const gateUpdated = await gateTool.execute({ action: 'update', id: 'smoke', enabled: false }, exec)
eq('flow_gate update: enabled', gateUpdated.gate?.enabled, false)

// --------------------------------------------------------------- skills

const skillFiles = ['project-flow-init', 'project-flow-usage'].filter((name) =>
  existsSync(join(pkgRoot, 'skills', `${name}.md`)),
)
for (const name of skillFiles) {
  const skill = registeredSkills.get(name)
  if (check(`skills: ${name} registered`, skill !== undefined) === false) continue
  eq(`skills: ${name} name`, skill.name, name)
  check(`skills: ${name} content non-empty`, typeof skill.content === 'string' && skill.content.trim().length > 0)
  check(`skills: ${name} description`, typeof skill.description === 'string' && skill.description.length > 0)
  check(`skills: ${name} whenToUse`, typeof skill.whenToUse === 'string' && skill.whenToUse.length > 0)
}
if (skillFiles.length < 2) {
  console.log(`SKIP skills files missing for: ${['project-flow-init', 'project-flow-usage'].filter((n) => !skillFiles.includes(n)).join(', ')} — warning expected in payload`)
}

// -------------------------------------------------------- HTTP store payload

const storeRes = await call(route, `${route.path}?root=${encodeURIComponent(storeRoot)}`)
const store = storeRes.json ?? {}
eq('store payload: 200', storeRes.status, 200)
eq('store payload: ok', store.ok, true)
eq('store payload: contract source', store.contract?.source, '.dsh/flow/flow.json')
eq('store payload: contract schema', store.contract?.schema, 2)
eq('store payload: contract name', store.contract?.name, 'Host2Test')
eq('store payload: experiments source', store.experiments?.source, 'store')
eq('store payload: experiments total', store.experiments?.total, 1)
eq('store payload: counts confirmed', store.experiments?.counts?.confirmed, 1)
eq('store payload: items length', store.experiments?.items?.length, 1)
check('store payload: tree array with children', Array.isArray(store.experiments?.tree) && store.experiments.tree[0]?.id === expId && Array.isArray(store.experiments.tree[0].children))
check('store payload: groups empty', Array.isArray(store.experiments?.groups) && store.experiments.groups.length === 0)
eq('store payload: tasks total', store.tasks?.total, 1)
eq('store payload: tasks counts done', store.tasks?.counts?.done, 1)
check('store payload: tasks current null', store.tasks?.current === null)
check('store payload: tasks active array', Array.isArray(store.tasks?.active))
check('store payload: tasks recentDone array', Array.isArray(store.tasks?.recentDone) && store.tasks.recentDone[0]?.id === taskId)
check('store payload: gates array', Array.isArray(store.gates) && store.gates.length === 1)
eq('store payload: gate lastRun ok false', store.gates?.[0]?.lastRun?.ok, false)
check('store payload: gate lastRun steps present', Array.isArray(store.gates?.[0]?.lastRun?.steps))
check('store payload: gate log null', store.gate === null)
if (skillFiles.length < 2) {
  check(
    'store payload: missing-skill warning surfaced',
    Array.isArray(store.warnings) &&
      store.warnings.some((line) => typeof line === 'string' && line.includes('skills:') && line.includes('not found')),
    JSON.stringify(store.warnings),
  )
}

// ------------------------------------------------------- HTTP legacy payload

const legacyRes = await call(route, `${route.path}?root=${encodeURIComponent(legacyRoot)}`)
const legacy = legacyRes.json ?? {}
eq('legacy payload: 200', legacyRes.status, 200)
eq('legacy payload: ok', legacy.ok, true)
eq('legacy payload: contract source', legacy.contract?.source, 'flow.json')
eq('legacy payload: experiments source', legacy.experiments?.source, 'git-trailers')
check('legacy payload: items empty array', Array.isArray(legacy.experiments?.items) && legacy.experiments.items.length === 0)
check('legacy payload: tree empty array', Array.isArray(legacy.experiments?.tree) && legacy.experiments.tree.length === 0)
check('legacy payload: groups array', Array.isArray(legacy.experiments?.groups))
check('legacy payload: gates empty array', Array.isArray(legacy.gates) && legacy.gates.length === 0)
eq('legacy payload: tasks total', legacy.tasks?.total, 1)
eq('legacy payload: tasks current null', legacy.tasks?.current, null)
check('legacy payload: active task title', legacy.tasks?.active?.[0]?.title === 'Legacy task')
check('legacy payload: gate log present', Array.isArray(legacy.gate?.lines) && legacy.gate.lines[0] === 'legacy gate line')

// ------------------------------------------------------ no-store behavior

const noStoreWrite = await throws(
  'no-store: flow_exp add errors actionably',
  () => expTool.execute({ action: 'add', root: noStoreRoot, title: 'nope' }, exec),
  (message) => message.includes('project flow store not found') && message.includes('node bin/flow.mjs init'),
)
check('no-store: error was raised', noStoreWrite)

const noStoreStatus = await statusTool.execute({ root: noStoreRoot }, exec)
eq('no-store: flow_status still reads legacy', noStoreStatus.store, false)
eq('no-store: flow_status root', noStoreStatus.root, noStoreRoot)

const noStoreLegacyExp = await expTool.execute({ action: 'list', root: legacyRoot }, exec)
eq('legacy: flow_exp list falls back to git trailers', noStoreLegacyExp.store, false)
eq('legacy: flow_exp list source', noStoreLegacyExp.source, 'git-trailers')

const legacyTaskList = await taskTool.execute({ action: 'list', root: legacyRoot }, exec)
eq('legacy: flow_task list total', legacyTaskList.total, 1)
eq('legacy: flow_task list store false', legacyTaskList.store, false)

const legacyGateList = await gateTool.execute({ action: 'list', root: legacyRoot }, exec)
check('legacy: flow_gate list explains missing store', Array.isArray(legacyGateList.gates) && legacyGateList.gates.length === 0 && typeof legacyGateList.note === 'string')

// ------------------------------------------------------------- remove chain

const removedExp = await expTool.execute({ action: 'remove', id: expId }, exec)
eq('flow_exp remove: removed true', removedExp.removed, true)
await throws('flow_exp show after remove: not found', () => expTool.execute({ action: 'show', id: expId }, exec), 'not found')

const removedTask = await taskTool.execute({ action: 'remove', id: taskId }, exec)
eq('flow_task remove: removed true', removedTask.removed, true)

const removedGate = await gateTool.execute({ action: 'remove', id: 'smoke' }, exec)
eq('flow_gate remove: removed true', removedGate.removed, true)

const emptyStore = await call(route, `${route.path}?root=${encodeURIComponent(storeRoot)}`)
eq('store payload after removals: experiments 0', emptyStore.json?.experiments?.total, 0)
eq('store payload after removals: tasks 0', emptyStore.json?.tasks?.total, 0)
eq('store payload after removals: gates 0', emptyStore.json?.gates?.length, 0)

// ------------------------------------------------------------ dispose

for (const dispose of disposers.splice(0)) {
  try {
    dispose()
  } catch {
    // checked below by the registry state
  }
}
eq('dispose: tools unregistered', registeredTools.size, 0)
eq('dispose: skills unregistered', registeredSkills.size, 0)

// ------------------------------------------------- injection (Cordis) path
//
// Production registers through ctx.inject(['tools'], ...) and scoped effects.
// Exercise that shape with a minimal fake so the fallback path is not the only
// one covered.

const injectedTools = new Map()
const injectedSkills = new Map()
const childDisposers = []
const injectedRouteDisposers = []

const injectWebServer = {
  register() {
    return () => {}
  },
  getOrigin() {
    return ORIGIN
  },
}

const childCtx = {
  get(name) {
    if (name === 'tools') {
      return {
        register(definition) {
          injectedTools.set(definition.name, definition)
          return () => injectedTools.delete(definition.name)
        },
      }
    }
    if (name === 'skills') {
      return {
        register(skill) {
          injectedSkills.set(skill.name, skill)
          return () => injectedSkills.delete(skill.name)
        },
      }
    }
    if (name === 'workingDirectory') return { get: () => storeRoot }
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') childDisposers.push(dispose)
    return () => {}
  },
}

let injectedFiber
const injectCtx = {
  get(name) {
    if (name === 'webServer') return injectWebServer
    if (name === 'workspaceRegistry') return { list: () => [] }
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') injectedRouteDisposers.push(dispose)
    return () => {}
  },
  inject(dependencies, callback) {
    for (const dependency of dependencies) callback(childCtx)
    let disposed = false
    injectedFiber = {
      dispose() {
        if (disposed) return
        disposed = true
        for (const dispose of childDisposers.splice(0)) dispose()
      },
    }
    return injectedFiber
  },
}

apply(injectCtx)
eq('inject path: four tools registered', injectedTools.size, 4)
eq('inject path: two skills registered', injectedSkills.size, 2)
check('inject path: fiber returned by ctx.inject', injectedFiber !== undefined)
for (const dispose of injectedRouteDisposers.splice(0)) dispose()
eq('inject path: disposal unregisters tools', injectedTools.size, 0)
eq('inject path: disposal unregisters skills', injectedSkills.size, 0)

// ------------------------------------------------------------- cleanup

for (const root of [storeRoot, legacyRoot, noStoreRoot]) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
