// project-flow Host stage 2 self-test — local, no deps, /tmp fixtures only.
//
// Loads index.js with a mock Cordis context (webServer + tools + skills +
// workingDirectory), builds a real `.dsh/flow` store through lib/core.mjs, and
// drives the four tools plus the HTTP endpoint in store mode, and the
// uninitialized empty state.

import { spawnSync } from 'node:child_process'
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

/** `tasks.draft` row shape: exactly {id,title,owner,updated_at}, all strings. */
function draftRowOk(row) {
  return (
    row !== null &&
    typeof row === 'object' &&
    JSON.stringify(Object.keys(row)) === JSON.stringify(['id', 'title', 'owner', 'updated_at']) &&
    typeof row.id === 'string' &&
    typeof row.title === 'string' &&
    typeof row.owner === 'string' &&
    typeof row.updated_at === 'string'
  )
}

/** Newest-first order; an unparseable stamp sorts last (as the Host does). */
function draftRowsDesc(rows) {
  if (Array.isArray(rows) === false) return false
  let previous = Number.POSITIVE_INFINITY
  for (const row of rows) {
    const stamp = Date.parse(row.updated_at)
    const value = Number.isFinite(stamp) ? stamp : Number.NEGATIVE_INFINITY
    if (value > previous) return false
    previous = value
  }
  return true
}

// ------------------------------------------------------------- fake context

const registeredTools = new Map()
const registeredSkills = new Map()
const routes = []
const disposers = []

const guards = []
const toolsService = {
  register(definition) {
    registeredTools.set(definition.name, definition)
    return () => registeredTools.delete(definition.name)
  },
  guard(check) {
    guards.push(check)
    return () => {
      const at = guards.indexOf(check)
      if (at >= 0) guards.splice(at, 1)
    }
  },
}

// The host `agents` registry double: `roots()` reports live top-level agents and
// `get(id)` any live agent, which is exactly what the plugin's root-session
// verdict consumes.
const liveAgents = new Map()
const rootAgentIds = new Set()
const agentsService = {
  list() {
    return [...liveAgents.values()]
  },
  roots() {
    return [...liveAgents.entries()].filter(([id]) => rootAgentIds.has(id)).map(([, agent]) => agent)
  },
  get(id) {
    return liveAgents.get(id)
  },
}

// `agent/pre-step` listener double; the plugin registers one reminder hook.
const preStepHandlers = []

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
    agents: agentsService,
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
    on(name, handler) {
      if (name !== 'agent/pre-step') return () => {}
      preStepHandlers.push(handler)
      return () => {
        const at = preStepHandlers.indexOf(handler)
        if (at >= 0) preStepHandlers.splice(at, 1)
      }
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
const initResult = core.initProject(storeRoot, { name: 'Host2Test', noGates: true })

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
  registryPaths: [storeRoot, noStoreRoot],
})

apply(ctx)

check('store fixture initialized', initResult.created.includes('.dsh/flow/flow.json'), JSON.stringify(initResult))
eq('routes registered', routes.length, 3)
const route = routes.find((entry) => entry.path === '/api/project-flow/state')
const initRoute = routes.find((entry) => entry.path === '/api/project-flow/init')
const gateRoute = routes.find((entry) => entry.path === '/api/project-flow/gate')
check('state route present', route !== undefined && route.kind === 'exact')
check('init route present', initRoute !== undefined && initRoute.kind === 'exact')
check('gate route present', gateRoute !== undefined && gateRoute.kind === 'exact')

// ------------------------------------------------------------- tool surface

const EXPECTED_TOOLS = ['flow_status', 'flow_exp', 'flow_task', 'flow_gate', 'flow_heartbeat']
check('five tools registered', registeredTools.size === 5, `got ${[...registeredTools.keys()].join(', ')}`)
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

const statusUninitialized = await statusTool.execute({ root: noStoreRoot }, exec)
eq('flow_status: uninitialized store false', statusUninitialized.store, false)
eq('flow_status: uninitialized contract source', statusUninitialized.contract.source, 'defaults')
eq('flow_status: uninitialized experiments total 0', statusUninitialized.experiments.total, 0)
eq('flow_status: uninitialized tasks total 0', statusUninitialized.tasks.total, 0)
check('flow_status: uninitialized gates empty', Array.isArray(statusUninitialized.gates) && statusUninitialized.gates.length === 0)

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


// ---------------------------------------------- heartbeat scope (main only)

const heartbeatTool = registeredTools.get('flow_heartbeat')

/** A mock live agent: `id` plus the durable session header the verdict falls back to. */
function mockAgent(id, cwd, header = {}) {
  return { id, session: { cwd, header: { version: 4, id, createdAt: 0, isSeeded: false, ...header } } }
}
function registerRootAgent(agent) {
  liveAgents.set(agent.id, agent)
  rootAgentIds.add(agent.id)
}
function registerChildAgent(agent) {
  liveAgents.set(agent.id, agent)
}

/** Drive the registered pre-step reminder hook with a synthetic decision. */
async function runPreStep(agent) {
  if (preStepHandlers.length === 0) return null
  return preStepHandlers[0]({ agent, step: 1, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
}

const hbRootAgent = mockAgent('session-hb-root', storeRoot)
registerRootAgent(hbRootAgent)
const hbRootExec = { agent: hbRootAgent }

const reminded = await runPreStep(hbRootAgent)
check(
  'pre-step: root session without heartbeat is reminded',
  reminded !== null && Array.isArray(reminded.messages) && reminded.messages.length === 1 && reminded.messages[0].role === 'user',
  JSON.stringify(reminded),
)
eq('guard: one heartbeat guard registered', guards.length, 1)
const rootEditReason = guards[0]?.({ name: 'edit', agent: hbRootAgent })
check(
  'guard: root without heartbeat denies edit',
  typeof rootEditReason === 'string' && rootEditReason.includes('flow_heartbeat start'),
  String(rootEditReason),
)
check('guard: bash is never denied', guards[0]?.({ name: 'bash', agent: hbRootAgent }) === undefined)

// A delegated child: no reminder, no write gate, and the tool refuses to write.
const hbSubAgent = mockAgent('session-hb-sub', storeRoot, {
  origin: 'subagent',
  delegationDepth: 1,
  parentSession: hbRootAgent.id,
})
registerChildAgent(hbSubAgent)
const subExec = { agent: hbSubAgent }
const subReminder = await runPreStep(hbSubAgent)
check(
  'pre-step: subagent is not reminded',
  subReminder !== null && (subReminder.messages === undefined || subReminder.messages.length === 0),
  JSON.stringify(subReminder),
)
check('guard: subagent is never denied a write', guards[0]?.({ name: 'edit', agent: hbSubAgent }) === undefined)
const subHeartbeatFile = join(storeRoot, '.agents/heartbeat', `${hbSubAgent.id}.json`)
const refused = await throws(
  'flow_heartbeat: subagent start refused',
  () => heartbeatTool.execute({ action: 'start', goal: '子代理不应写心跳' }, subExec),
  (message) => message.includes('main sessions') && message.includes('subagent'),
)
check('flow_heartbeat: refusal writes no file', refused && existsSync(subHeartbeatFile) === false)

// The main session starts its heartbeat: reminder and gate clear.
const hbStarted = await heartbeatTool.execute({ action: 'start', goal: 'host heartbeat scope', task: taskId }, hbRootExec)
eq('flow_heartbeat start: session', hbStarted.session, hbRootAgent.id)
eq('flow_heartbeat start: ledger root', hbStarted.root, storeRoot)
const hbFile = join(storeRoot, '.agents/heartbeat', `${hbRootAgent.id}.json`)
check('flow_heartbeat start: file written', existsSync(hbFile))
const afterStart = await runPreStep(hbRootAgent)
check(
  'pre-step: working heartbeat needs no reminder',
  afterStart !== null && (afterStart.messages === undefined || afterStart.messages.length === 0),
)
check('guard: working heartbeat allows edit', guards[0]?.({ name: 'edit', agent: hbRootAgent }) === undefined)
const hbList = await heartbeatTool.execute({ action: 'list' }, hbRootExec)
eq('flow_heartbeat list: one visible heartbeat', hbList.items.length, 1)
eq('flow_heartbeat list: no hidden legacy yet', hbList.counts.hidden, 0)
const hbEnded = await heartbeatTool.execute({ action: 'end', note: '收尾' }, hbRootExec)
eq('flow_heartbeat end: done', hbEnded.heartbeat.status, 'done')

// A record left by the removed subagent automation is hidden from reads/panel.
const legacyHeartbeatFile = join(storeRoot, '.agents/heartbeat', 'session-legacy-host2.json')
writeFileSync(
  legacyHeartbeatFile,
  JSON.stringify({
    schema: 1,
    session: 'session-legacy-host2',
    agent: 'subagent',
    status: 'working',
    last_action: '子代理运行 legacy',
    updated_at: new Date().toISOString(),
  }),
)
const hiddenList = await heartbeatTool.execute({ action: 'list' }, hbRootExec)
eq('flow_heartbeat list: legacy subagent counted hidden', hiddenList.counts.hidden, 1)
check(
  'flow_heartbeat list: legacy subagent not in items',
  hiddenList.items.every((item) => item.session !== 'session-legacy-host2'),
)
const storeWithLegacy = (await call(route, `${route.path}?root=${encodeURIComponent(storeRoot)}`)).json ?? {}
check(
  'state payload: legacy subagent heartbeat hidden',
  Array.isArray(storeWithLegacy.heartbeats) && storeWithLegacy.heartbeats.every((item) => item.session !== 'session-legacy-host2'),
  JSON.stringify(storeWithLegacy.heartbeats),
)

// A linked-worktree session writes the *main* worktree ledger.
const wtMain = mkdtempSync(join(tmpdir(), 'project-flow-host2-wt-main-'))
core.initProject(wtMain, { name: 'WorktreeMain', noGates: true })
function gitRun(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}
gitRun(wtMain, ['init', '-q'])
gitRun(wtMain, ['add', '-A'])
gitRun(wtMain, [
  '-c', 'user.name=Host2',
  '-c', 'user.email=host2@example.invalid',
  '-c', 'commit.gpgsign=false',
  'commit', '-q', '--no-verify', '-m', 'init',
])
const wtDir = mkdtempSync(join(tmpdir(), 'project-flow-host2-wt-dir-'))
const wtCheckout = join(wtDir, 'checkout')
gitRun(wtMain, ['worktree', 'add', '-q', wtCheckout, '-b', 'hb-host2-wt'])
const wtAgent = mockAgent('session-hb-wt', wtCheckout)
registerRootAgent(wtAgent)
const wtStarted = await heartbeatTool.execute({ action: 'start', root: wtCheckout, goal: 'worktree 心跳' }, { agent: wtAgent })
eq('flow_heartbeat worktree: ledger root is the main worktree', wtStarted.root, wtMain)
eq('flow_heartbeat worktree: workspace reported', wtStarted.workspace, wtCheckout)
check(
  'flow_heartbeat worktree: file lands in the main ledger',
  existsSync(join(wtMain, '.agents/heartbeat', `${wtAgent.id}.json`)),
)
check(
  'flow_heartbeat worktree: nothing written under the worktree',
  existsSync(join(wtCheckout, '.agents/heartbeat', `${wtAgent.id}.json`)) === false,
)
const wtState = (await call(route, `${route.path}?root=${encodeURIComponent(wtCheckout)}`)).json ?? {}
check(
  'state payload: worktree heartbeat visible from the worktree workspace',
  Array.isArray(wtState.heartbeats) && wtState.heartbeats.some((item) => item.session === wtAgent.id),
  JSON.stringify(wtState.heartbeats),
)
check(
  'state payload: worktree section does not leak another project ledger',
  Array.isArray(wtState.heartbeats) && wtState.heartbeats.every((item) => item.session !== hbRootAgent.id),
  JSON.stringify(wtState.heartbeats),
)

// --------------------------------------------------------------- skills

const SKILL_NAMES = ['project-flow-init', 'project-flow-usage', 'ai-collaborative-dev-workflow']

/** Instruction file of one bundled skill: directory layout first, flat layout second. */
function skillFileOf(name) {
  const directory = join(pkgRoot, 'skills', name, 'SKILL.md')
  if (existsSync(directory)) return directory
  const flat = join(pkgRoot, 'skills', `${name}.md`)
  return existsSync(flat) ? flat : undefined
}

const skillFiles = SKILL_NAMES.filter((name) => skillFileOf(name) !== undefined)
for (const name of skillFiles) {
  const skill = registeredSkills.get(name)
  if (check(`skills: ${name} registered`, skill !== undefined) === false) continue
  eq(`skills: ${name} name`, skill.name, name)
  check(`skills: ${name} content non-empty`, typeof skill.content === 'string' && skill.content.trim().length > 0)
  check(`skills: ${name} description`, typeof skill.description === 'string' && skill.description.length > 0)
  check(`skills: ${name} whenToUse`, typeof skill.whenToUse === 'string' && skill.whenToUse.length > 0)
  /* The registry's loaded-definition validation rejects a non-string source. */
  eq(`skills: ${name} source`, skill.source, 'bundled')
}

// The workflow skill uses the directory layout: the registration must carry a
// directory resourceBase, otherwise the model cannot resolve the references/,
// assets/ and scripts/ paths that SKILL.md mentions relatively.
const workflowSkill = registeredSkills.get('ai-collaborative-dev-workflow')
if (check('dir skill: registered', workflowSkill !== undefined) === true) {
  eq('dir skill: source', workflowSkill.source, 'bundled')
  check('dir skill: content non-empty', typeof workflowSkill.content === 'string' && workflowSkill.content.trim().length > 0)
  check(
    'dir skill: frontmatter stripped from the body',
    typeof workflowSkill.content === 'string' &&
      workflowSkill.content.startsWith('# ') &&
      workflowSkill.content.includes('与 project-flow 插件的分工'),
  )
  check(
    'dir skill: description',
    typeof workflowSkill.description === 'string' && workflowSkill.description.length > 0,
    JSON.stringify(workflowSkill.description),
  )
  check(
    'dir skill: description comes from SKILL.md frontmatter',
    typeof workflowSkill.description === 'string' &&
      workflowSkill.description.startsWith('通用 AI 协作开发工作流') &&
      workflowSkill.description.includes('中心-贡献者'),
    JSON.stringify(workflowSkill.description),
  )
  check(
    'dir skill: whenToUse',
    typeof workflowSkill.whenToUse === 'string' && workflowSkill.whenToUse.length > 0,
    JSON.stringify(workflowSkill.whenToUse),
  )
  const resourceBase = workflowSkill.resourceBase
  check(
    'dir skill: resourceBase is a directory base',
    resourceBase !== null && typeof resourceBase === 'object' && resourceBase.kind === 'directory',
    JSON.stringify(resourceBase),
  )
  const basePath =
    resourceBase !== null && typeof resourceBase === 'object' && typeof resourceBase.path === 'string' ? resourceBase.path : ''
  check(
    'dir skill: resourceBase path ends with skills/ai-collaborative-dev-workflow',
    basePath.endsWith(join('skills', 'ai-collaborative-dev-workflow')),
    basePath,
  )
  check(
    'dir skill: SKILL.md exists at resourceBase',
    basePath.length > 0 && existsSync(join(basePath, 'SKILL.md')),
    basePath,
  )
}
if (skillFiles.length < SKILL_NAMES.length) {
  console.log(
    `SKIP skills files missing for: ${SKILL_NAMES.filter((name) => !skillFiles.includes(name)).join(', ')} — warning expected in payload`,
  )
}

// -------------------------------------------------------- HTTP store payload

// Two drafts with fixed on-disk timestamps: the payload must surface them
// newest-first and fill a missing owner with an empty string.
const olderDraft = await taskTool.execute({ action: 'add', title: '草稿旧', status: 'draft', owner: 'alice' }, exec)
const newerDraft = await taskTool.execute({ action: 'add', title: '草稿新', status: 'draft' }, exec)
for (const [task, stamp] of [
  [olderDraft.task, '2026-10-28T09:00:00+08:00'],
  [newerDraft.task, '2026-10-28T11:00:00+08:00'],
]) {
  writeFileSync(join(storeRoot, '.dsh', 'flow', 'tasks', `${task.id}.json`), JSON.stringify({ ...task, updated_at: stamp }))
}

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
eq('store payload: tasks total', store.tasks?.total, 3)
eq('store payload: tasks counts done', store.tasks?.counts?.done, 1)
eq('store payload: tasks counts draft', store.tasks?.counts?.draft, 2)
check('store payload: tasks current null', store.tasks?.current === null)
check('store payload: tasks active array', Array.isArray(store.tasks?.active))
check('store payload: tasks recentDone array', Array.isArray(store.tasks?.recentDone) && store.tasks.recentDone[0]?.id === taskId)
check(
  'store payload: tasks draft array length',
  Array.isArray(store.tasks?.draft) && store.tasks.draft.length === 2,
  JSON.stringify(store.tasks?.draft),
)
check('store payload: tasks draft newest first', draftRowsDesc(store.tasks?.draft), JSON.stringify(store.tasks?.draft))
eq('store payload: tasks draft[0] is newest', store.tasks?.draft?.[0]?.id, newerDraft.task?.id)
eq('store payload: tasks draft[1] is older', store.tasks?.draft?.[1]?.id, olderDraft.task?.id)
check('store payload: tasks draft row shape', store.tasks?.draft?.every(draftRowOk), JSON.stringify(store.tasks?.draft))
eq('store payload: tasks draft missing owner empty', store.tasks?.draft?.[0]?.owner, '')
eq('store payload: tasks draft owner kept', store.tasks?.draft?.[1]?.owner, 'alice')
eq('store payload: tasks draft updated_at kept', store.tasks?.draft?.[1]?.updated_at, '2026-10-28T09:00:00+08:00')
check('store payload: gates array', Array.isArray(store.gates) && store.gates.length === 1)
eq('store payload: gate lastRun ok false', store.gates?.[0]?.lastRun?.ok, false)
check('store payload: gate lastRun steps present', Array.isArray(store.gates?.[0]?.lastRun?.steps))
check('store payload: no legacy gate/runs/team sections', store.gate === undefined && store.runs === undefined && store.team === undefined)
if (skillFiles.length < SKILL_NAMES.length) {
  check(
    'store payload: missing-skill warning surfaced',
    Array.isArray(store.warnings) &&
      store.warnings.some((line) => typeof line === 'string' && line.includes('skills:') && line.includes('not found')),
    JSON.stringify(store.warnings),
  )
}

// ------------------------------------------------ uninitialized workspace

const noStoreRes = await call(route, `${route.path}?root=${encodeURIComponent(noStoreRoot)}`)
const noStore = noStoreRes.json ?? {}
eq('uninitialized payload: 200', noStoreRes.status, 200)
eq('uninitialized payload: ok false', noStore.ok, false)
eq('uninitialized payload: not-initialized', noStore.error?.code, 'not-initialized')
check(
  'uninitialized payload: no ledger sections',
  noStore.experiments === undefined && noStore.tasks === undefined && noStore.gates === undefined && noStore.heartbeats === undefined,
)
check(
  'uninitialized payload: no legacy/runs/gate/team fields',
  noStore.runs === undefined && noStore.gate === undefined && noStore.team === undefined,
)

// -------------------------------------------------- draft cap (MAX_DRAFT_TASKS)

// 55 drafts must project to the newest 50, never the whole ledger.
const capRoot = mkdtempSync(join(tmpdir(), 'project-flow-host2-cap-'))
core.initProject(capRoot, { name: 'CapTest', noGates: true })
const capContract = core.loadContract(capRoot).contract
const capIds = []
for (let index = 0; index < 55; index += 1) {
  const record = core.addTask(capRoot, capContract, {
    title: `草稿 ${index}`,
    status: 'draft',
    owner: 'cap',
    updated_at: `2026-10-30T00:00:${String(index).padStart(2, '0')}+08:00`,
  })
  capIds.push(record.id)
}
const capState = (await call(route, `${route.path}?root=${encodeURIComponent(capRoot)}`)).json ?? {}
check(
  'draft cap: 55 drafts capped to 50',
  Array.isArray(capState.tasks?.draft) && capState.tasks.draft.length === 50,
  JSON.stringify(capState.tasks?.draft?.length),
)
eq('draft cap: newest kept first', capState.tasks?.draft?.[0]?.id, capIds[54])
eq('draft cap: oldest kept last', capState.tasks?.draft?.[49]?.id, capIds[5])
eq('draft cap: total still counts every task', capState.tasks?.total, 55)

// ----------------------------------------- malicious manifest: containment
//
// A store contract must not point the panel at a file outside its own project
// root. Every sentinel below lives in its own /tmp directory and uses text that
// never appears in a path, so a hit proves the content was leaked.

const secretRoot = mkdtempSync(join(tmpdir(), 'project-flow-host2-secret-'))
const CURRENT_SECRET = 'TOP-SECRET-HOST2-CURRENT'
const GATE_SECRET = 'TOP-SECRET-HOST2-GATE'
const RUN_SECRET = 'TOP-SECRET-HOST2-RUN'

const secretCurrentFile = join(secretRoot, 'current')
writeFileSync(secretCurrentFile, `${CURRENT_SECRET}\n`)
const secretGateFile = join(secretRoot, 'gate.log')
writeFileSync(secretGateFile, `${GATE_SECRET}\n`)
const secretRunDir = join(secretRoot, 'runs')
mkdirSync(secretRunDir, { recursive: true })
writeFileSync(join(secretRunDir, 'run.log'), `${RUN_SECRET}\n`)

const evilStoreRoot = mkdtempSync(join(tmpdir(), 'project-flow-host2-evil-store-'))
mkdirSync(join(evilStoreRoot, '.dsh', 'flow'), { recursive: true })
writeFileSync(
  join(evilStoreRoot, '.dsh', 'flow', 'flow.json'),
  JSON.stringify({
    schema: 2,
    name: 'EvilStore',
    tasks: { source: 'json', current: secretCurrentFile },
    // Removed legacy sections are tolerated as unknown contract keys but never read.
    gate: { log: secretGateFile },
    runs: { dirs: [secretRunDir] },
  }),
)

function hasWarning(payload, needle) {
  const warnings = Array.isArray(payload?.warnings) ? payload.warnings : []
  return warnings.some((line) => typeof line === 'string' && line.includes(needle))
}

const evilStore = (await call(route, `${route.path}?root=${encodeURIComponent(evilStoreRoot)}`)).json ?? {}
eq('evil store: payload ok', evilStore.ok, true)
eq('evil store: tasks.current null', evilStore.tasks?.current, null)
check('evil store: tasks.current warning', hasWarning(evilStore, 'manifest-path-rejected: tasks.current:'), JSON.stringify(evilStore.warnings))
check('evil store: removed gate/runs sections are not projected', evilStore.gate === undefined && evilStore.runs === undefined)
check(
  'evil store: no sentinel content in payload',
  [GATE_SECRET, RUN_SECRET, CURRENT_SECRET].every((secret) => JSON.stringify(evilStore).includes(secret) === false),
)


// ------------------------------------------------------ no-store behavior

const noStoreWrite = await throws(
  'no-store: flow_exp add errors actionably',
  () => expTool.execute({ action: 'add', root: noStoreRoot, title: 'nope' }, exec),
  (message) => message.includes('project flow store not found') && message.includes('node bin/flow.mjs init'),
)
check('no-store: error was raised', noStoreWrite)

const noStoreStatus = await statusTool.execute({ root: noStoreRoot }, exec)
eq('no-store: flow_status store false', noStoreStatus.store, false)
eq('no-store: flow_status root', noStoreStatus.root, noStoreRoot)
eq('no-store: flow_status contract source', noStoreStatus.contract.source, 'defaults')
eq('no-store: flow_status experiments total 0', noStoreStatus.experiments.total, 0)
eq('no-store: flow_status tasks total 0', noStoreStatus.tasks.total, 0)
check('no-store: flow_status gates empty', Array.isArray(noStoreStatus.gates) && noStoreStatus.gates.length === 0)

const noStoreExp = await expTool.execute({ action: 'list', root: noStoreRoot }, exec)
eq('no-store: flow_exp list store false', noStoreExp.store, false)
eq('no-store: flow_exp list total 0', noStoreExp.total, 0)
check(
  'no-store: flow_exp list empty note',
  Array.isArray(noStoreExp.items) && noStoreExp.items.length === 0 && typeof noStoreExp.note === 'string',
)

const noStoreTaskList = await taskTool.execute({ action: 'list', root: noStoreRoot }, exec)
eq('no-store: flow_task list store false', noStoreTaskList.store, false)
eq('no-store: flow_task list total 0', noStoreTaskList.total, 0)

const noStoreGateList = await gateTool.execute({ action: 'list', root: noStoreRoot }, exec)
check(
  'no-store: flow_gate list explains missing store',
  Array.isArray(noStoreGateList.gates) && noStoreGateList.gates.length === 0 && typeof noStoreGateList.note === 'string',
)

// ------------------------------------------------------------- remove chain

const removedExp = await expTool.execute({ action: 'remove', id: expId }, exec)
eq('flow_exp remove: removed true', removedExp.removed, true)
await throws('flow_exp show after remove: not found', () => expTool.execute({ action: 'show', id: expId }, exec), 'not found')

const removedTask = await taskTool.execute({ action: 'remove', id: taskId }, exec)
eq('flow_task remove: removed true', removedTask.removed, true)

const removedDraftOlder = await taskTool.execute({ action: 'remove', id: olderDraft.task?.id }, exec)
eq('flow_task remove: older draft true', removedDraftOlder.removed, true)
const removedDraftNewer = await taskTool.execute({ action: 'remove', id: newerDraft.task?.id }, exec)
eq('flow_task remove: newer draft true', removedDraftNewer.removed, true)

const removedGate = await gateTool.execute({ action: 'remove', id: 'smoke' }, exec)
eq('flow_gate remove: removed true', removedGate.removed, true)

const emptyStore = await call(route, `${route.path}?root=${encodeURIComponent(storeRoot)}`)
eq('store payload after removals: experiments 0', emptyStore.json?.experiments?.total, 0)
eq('store payload after removals: tasks 0', emptyStore.json?.tasks?.total, 0)
check(
  'store payload after removals: tasks draft empty array',
  Array.isArray(emptyStore.json?.tasks?.draft) && emptyStore.json.tasks.draft.length === 0,
  JSON.stringify(emptyStore.json?.tasks?.draft),
)
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
eq('inject path: five tools registered', injectedTools.size, 5)
eq('inject path: three skills registered', injectedSkills.size, 3)
check('inject path: fiber returned by ctx.inject', injectedFiber !== undefined)
for (const dispose of injectedRouteDisposers.splice(0)) dispose()
eq('inject path: disposal unregisters tools', injectedTools.size, 0)
eq('inject path: disposal unregisters skills', injectedSkills.size, 0)

// ------------------------------------------------------------- cleanup

for (const root of [storeRoot, noStoreRoot, capRoot, wtMain, wtDir, secretRoot, evilStoreRoot]) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
