/**
 * T-20261030-26 · project-flow data-path render check.
 *
 * The deliverable's factory only exposes { inject, apply }, so this script
 * derives a probe copy in .selftest/.client-probe/ by inserting a `__probe`
 * field into the returned object (one literal string replacement, asserted),
 * then renders every panel component against a store fixture, an empty payload,
 * a missing `contract` and hostile values. It also replays the Host-side
 * state-*.json fixtures when they exist (including a `not-initialized`
 * workspace response), which proves the client and the real Host payload agree
 * on the contract shape. The panel is workspace-scoped, so `PanelBody` resolves
 * `sessionId` + `useSessions` into the `workspaceRoot` the `Panel` polls and
 * keys on.
 *
 * No network, no host access.
 *
 * Run: node .selftest/client-render.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../client.js', import.meta.url));
const PROBE_DIR = fileURLToPath(new URL('./.client-probe/', import.meta.url));
const PROBE = PROBE_DIR + 'client.probe.js';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL ${name}`);
    console.log('     ' + String((error && error.message) || error).split('\n').join('\n     '));
  }
}

// ------------------------------------------------------------- probe source
const ANCHOR = "    return {\n      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],";
const PROBE_NAME =
  "    return {\n      __probe: { normalize, Panel, PanelRoot, PanelBody, PanelTitle, HeaderAction, ExperimentTree, TasksCard, TaskRow, TaskDetail, GatesCard, SignalsCard, TopBar, Footer, ErrorState, DetailBlock, PanelIcon, PanelGlyph, relativeFromSeconds, ageText, runPanel: Panel, CSS, DecisionsCard, normalizeDecisions, decisionAnswerCommand },\n      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],";

const source = readFileSync(SRC, 'utf8');
assert.equal(source.split(ANCHOR).length - 1, 1, 'probe anchor not found exactly once');
mkdirSync(PROBE_DIR, { recursive: true });
writeFileSync(PROBE, source.replace(ANCHOR, PROBE_NAME));

// ---------------------------------------------------------------- React stub
const createElement = (type, props, ...children) => ({ type, props: props || {}, children });
class Component {
  constructor(props) {
    this.props = props;
  }
}
const ReactStub = {
  createElement,
  Fragment: Symbol.for('react.fragment'),
  Component,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => undefined,
  useRef: (initial) => ({ current: initial }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
};
const requireStub = (id) => {
  if (id === 'react') return ReactStub;
  throw new Error(`unexpected require("${id}")`);
};

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      captured = def;
      return def;
    },
  },
};

await import(new URL('./.client-probe/client.probe.js', import.meta.url).href);
assert.ok(captured, 'probe module did not call __ModuleLoader__.load');
const plugin = captured.factory(requireStub);
const probe = plugin.__probe;
assert.ok(probe, 'probe export missing (replacement failed)');

// ------------------------------------------------------- locale via fake ctx
const localeDicts = [];
const fakeCtx = {
  effect: (fn) => {
    fn();
    return () => {};
  },
  locale: {
    register(ns, dicts) {
      localeDicts.push({ ns, dicts });
      return () => {};
    },
    bind(ns) {
      return (key, params) => {
        const entry = localeDicts.find((item) => item.ns === ns);
        const table = entry ? entry.dicts.zh : {};
        const template = table[key] === undefined ? key : table[key];
        if (!params) return template;
        return template.replace(/\{(\w+)\}/g, (match, name) =>
          Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
        );
      };
    },
  },
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: { openTab: () => undefined },
  slots: { inject: (owner, fn) => fn(), register: () => () => {} },
};
plugin.apply(fakeCtx);
const t = localeDicts.length ? fakeCtx.locale.bind('project-flow') : (key) => key;
const tEn = (key, params) => {
  const entry = localeDicts.find((item) => item.ns === 'project-flow');
  const table = entry ? entry.dicts.en : {};
  const template = table[key] === undefined ? key : table[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
};

// ------------------------------------------------------------------ fixtures
/**
 * Canonical decision item keys, copied verbatim from the cross-domain contract
 * (Host payload / CLI / panel share the exact same 11 keys). The panel-domain
 * check below diffs `normalizeDecision`'s output against this literal array.
 */
const DECISION_ITEM_KEYS = [
  'id',
  'kind',
  'status',
  'question',
  'blocks',
  'options',
  'recommendation',
  'default',
  'escalated',
  'ageSeconds',
  'asked_at',
];
const DECISION_COUNT_KEYS = ['open', 'blocking', 'escalated', 'answered', 'withdrawn', 'superseded', 'total'];
const ZERO_DECISION_COUNTS = { open: 0, blocking: 0, escalated: 0, answered: 0, withdrawn: 0, superseded: 0, total: 0 };

const NOW = Date.UTC(2026, 9, 28, 3, 30, 0);
const fixture = {
  ok: true,
  generatedAt: '2026-10-28T11:30:00+08:00',
  contract: { source: '.dsh/flow/flow.json', schema: 2, name: 'demo-alpha' },
  roots: [{ path: '/tmp/pf-demo/alpha', name: 'demo-alpha' }],
  root: '/tmp/pf-demo/alpha',
  head: { sha: 'f5f176bc1234', subject: 'feat: demo', branch: 'dev', dirty: 2 },
  experiments: {
    source: 'store',
    total: 3,
    counts: { total: 3, open: 1, confirmed: 1, refuted: 1, abandoned: 0 },
    items: [
      {
        id: 'E-20261028-01',
        title: 'baseline',
        hypothesis: '第一批\n换行保留',
        factor: 'focus',
        parent: null,
        expected: 'exp',
        measured: 'meas',
        scale: 'small',
        status: 'confirmed',
        metrics: { acc: 0.9 },
        commits: ['f5f176bc'],
        notes: 'n1',
        created_at: '2026-10-28T09:00:00+08:00',
        updated_at: '2026-10-28T10:00:00+08:00',
      },
      {
        id: 'E-20261028-02',
        title: 'child',
        hypothesis: 'x'.repeat(400),
        parent: 'E-20261028-01',
        status: 'refuted',
        expected: '',
        measured: '',
        scale: '',
        metrics: {},
        commits: [],
        notes: '',
        updated_at: '2026-10-28T09:00:00+08:00',
      },
      {
        id: 'E-20261028-03',
        hypothesis: 'open one',
        parent: null,
        status: 'open',
        updated_at: '2026-10-28T08:00:00+08:00',
      },
    ],
    tree: [
      { id: 'E-20261028-01', children: [{ id: 'E-20261028-02', children: [] }] },
      { id: 'E-20261028-03', children: [] },
    ],
  },
  tasks: {
    total: 49,
    counts: { draft: 20, active: 1, done: 28, archived: 0, other: 0 },
    current: { id: 'T-20261028-56', title: 'client half' },
    active: [
      {
        id: 'T-2',
        title: 'active task',
        status: 'active',
        owner: 'coord',
        goal: '看见任务目标与内容，而不是编号',
        notes: '展开详情里的备注',
        scope: { allow: ['client.js', 'index.js'], deny: ['lib/'] },
        acceptance: ['node --check client.js', 'node .selftest/client-render.mjs'],
        commits: ['f5f176bc'],
        created_at: '2026-10-28T08:00:00+08:00',
        updated_at: '2026-10-28T10:00:00+08:00',
        gate: '',
      },
    ],
    draft: [
      {
        id: 'T-D1',
        title: 'draft one',
        status: 'draft',
        owner: 'alice',
        goal: '草稿也有目标',
        notes: '',
        scope: { allow: ['README.md'], deny: [] },
        acceptance: ['草稿验收'],
        commits: [],
        created_at: '2026-10-28T07:00:00+08:00',
        updated_at: '2026-10-28T10:00:00+08:00',
        gate: '',
      },
    ],
    recentDone: [
      {
        id: 'T-3',
        title: 'done task',
        status: 'done',
        owner: '',
        goal: '完成的目标',
        notes: '',
        scope: { allow: [], deny: [] },
        acceptance: ['完成验收'],
        commits: ['12556a8'],
        created_at: '2026-10-28T06:00:00+08:00',
        updated_at: '2026-10-28T09:00:00+08:00',
        gate: 'pass',
      },
      {
        id: 'T-4',
        title: 'gate failed task',
        status: 'done',
        owner: '',
        goal: '',
        notes: '',
        scope: { allow: [], deny: [] },
        acceptance: [],
        commits: [],
        created_at: '2026-10-28T05:00:00+08:00',
        updated_at: '2026-10-28T08:00:00+08:00',
        gate: 'fail',
      },
      {
        id: 'T-5',
        title: 'gate null task',
        status: 'done',
        owner: '',
        goal: '',
        notes: '',
        scope: { allow: [], deny: [] },
        acceptance: [],
        commits: [],
        created_at: '2026-10-28T04:00:00+08:00',
        updated_at: '2026-10-28T07:00:00+08:00',
        gate: null,
      },
    ],
  },
  gates: [
    {
      id: 'smoke',
      title: '冒烟',
      phase: 'commit',
      enabled: true,
      steps: [{ id: 'ok', run: 'true', expect: 'exit 0', timeoutSeconds: 600 }],
      lastRun: {
        started_at: '2026-10-28T10:00:00+08:00',
        ok: true,
        durationMs: 850,
        steps: [{ id: 'ok', ok: true, exit: 0, tail: 'pass\n' }],
      },
    },
    { id: 'broken', title: 'broken gate', phase: 'manual', enabled: false, steps: [], lastRun: null },
  ],
  heartbeats: {
    dir: '.agents/heartbeat',
    items: [
      {
        file: 'session-aaaa.json',
        session: 'session-aaaa',
        agent: 'alpha',
        status: 'working',
        goal: 'ship the panel',
        task: 'T-20261028-56',
        claims: ['client.js'],
        last_action: 'editing client.js',
        ageSeconds: 60,
        stale: false,
        mtime: NOW - 60 * 1000,
        updated_at: '2026-10-28T11:29:00+08:00',
        stats: { turns: 3, missed: 0 },
      },
      {
        file: 'session-bbbb.json',
        session: 'session-bbbb',
        agent: 'beta',
        status: 'missed',
        goal: '',
        task: '',
        claims: [],
        last_action: '',
        ageSeconds: 178000,
        stale: true,
        mtime: 1761447480000,
        stats: { turns: 1, missed: 2 },
      },
    ],
    counts: { total: 2, active: 1, stale: 1 },
  },
  /* Two open decisions in payload order: the first is escalated and blocks a
     task; the second has no recommendation and falls back to options[0]. */
  decisions: {
    counts: { open: 2, blocking: 1, escalated: 1, answered: 0, withdrawn: 0, superseded: 0, total: 2 },
    items: [
      {
        id: 'D-20261028-01',
        kind: 'approval',
        status: 'open',
        question: 'Merge the client branch?',
        blocks: ['T-20261028-56'],
        options: [
          { id: 'approve', label: 'approve' },
          { id: 'reject', label: 'reject' },
        ],
        recommendation: 'approve',
        default: 'reject',
        escalated: true,
        ageSeconds: 7200,
        asked_at: '2026-10-28T09:30:00+08:00',
      },
      {
        id: 'D-20261028-02',
        kind: 'choice',
        status: 'open',
        question: 'Panel first or CLI first?',
        blocks: [],
        options: [
          { id: 'panel', label: 'panel' },
          { id: 'cli', label: 'cli' },
        ],
        recommendation: '',
        default: '',
        escalated: false,
        ageSeconds: 60,
        asked_at: '2026-10-28T09:29:00+08:00',
      },
    ],
  },
  warnings: ['w1', 'w2'],
};


// -------------------------------------------------------------- tree walking
function isClass(type) {
  return typeof type === 'function' && type.prototype instanceof Component;
}

function childProps(node) {
  const props = Object.assign({}, node.props);
  if (node.children.length === 1) props.children = node.children[0];
  else if (node.children.length > 1) props.children = node.children;
  return props;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  // Function components are expanded so nested pieces (Chip/Section/ListRow)
  // are inspected as the JSX they return.
  if (typeof node.type === 'function' && !isClass(node.type)) {
    walk(node.type(childProps(node)), visit);
    return;
  }
  visit(node);
  if (Array.isArray(node.children)) node.children.forEach((child) => walk(child, visit));
}

function collect(node, className) {
  const found = [];
  walk(node, (element) => {
    const cls = element.props && element.props.className;
    if (typeof cls === 'string' && cls.split(/\s+/).includes(className)) found.push(element);
  });
  return found;
}

function collectType(node, type) {
  const found = [];
  walk(node, (element) => {
    if (element.type === type) found.push(element);
  });
  return found;
}

/** Text nodes of an expanded element tree (function components included). */
function textOf(node) {
  const out = [];
  walk(node, (element) => {
    (element.children || []).forEach((child) => {
      if (typeof child === 'string' || typeof child === 'number') out.push(String(child));
    });
  });
  return out.join('\n');
}

function clickEverything(node) {
  let clicks = 0;
  walk(node, (element) => {
    if (element.type === 'button' && element.props && typeof element.props.onClick === 'function') {
      element.props.onClick({ preventDefault() {}, stopPropagation() {} });
      clicks += 1;
    }
  });
  return clicks;
}

const view = probe.normalize(fixture);

// ------------------------------------------------------------------- checks
check('normalize: full fixture keeps counts, contract and order', () => {
  assert.equal(view.root, '/tmp/pf-demo/alpha');
  assert.equal(view.roots.length, 1);
  assert.equal(view.roots[0].name, 'demo-alpha');
  assert.equal(view.contract.source, '.dsh/flow/flow.json');
  assert.equal(view.contract.schema, 2);
  assert.equal(view.exp.total, 3);
  assert.equal(view.exp.items.length, 3);
  assert.equal(view.exp.tree.length, 2);
  assert.equal(view.exp.open, 1);
  assert.equal(view.exp.confirmed, 1);
  assert.equal(view.exp.refuted, 1);
  assert.equal(view.tasks.counts.done, 28);
  assert.equal(view.tasks.counts.other, 0);
  // Task rows carry their goal plus every detail field in all three groups.
  const active = view.tasks.active[0];
  assert.equal(active.goal, '看见任务目标与内容，而不是编号');
  assert.equal(active.notes, '展开详情里的备注');
  assert.deepEqual(active.scope, { allow: ['client.js', 'index.js'], deny: ['lib/'] });
  assert.deepEqual(active.acceptance, ['node --check client.js', 'node .selftest/client-render.mjs']);
  assert.deepEqual(active.commits, ['f5f176bc']);
  assert.equal(active.created_at, '2026-10-28T08:00:00+08:00');
  assert.equal(view.tasks.draft[0].goal, '草稿也有目标');
  assert.deepEqual(view.tasks.draft[0].scope, { allow: ['README.md'], deny: [] });
  assert.equal(view.tasks.recentDone[0].goal, '完成的目标');
  assert.equal(view.tasks.recentDone[0].gate, 'pass');
  assert.equal(view.gates.length, 2);
  assert.equal(view.gates[0].lastRun.ok, true);
  assert.equal(view.heartbeats.length, 2);
  assert.equal(view.heartbeatCounts.active, 1);
  assert.equal(view.warnings.length, 2);
});

check('normalize: empty payload yields zeroed, renderable data', () => {
  const empty = probe.normalize({});
  assert.equal(empty.root, '');
  assert.equal(empty.contract, null);
  assert.equal(empty.exp.total, 0);
  assert.deepEqual(empty.exp.items, []);
  assert.deepEqual(empty.exp.tree, []);
  assert.equal(empty.tasks.total, 0);
  assert.equal(empty.tasks.counts.draft, 0);
  assert.deepEqual(empty.tasks.draft, []);
  assert.equal(empty.tasks.counts.other, 0);
  assert.equal(empty.tasks.current, null);
  assert.equal(empty.gates, null);
  assert.deepEqual(empty.heartbeats, []);
  assert.equal(empty.heartbeatCounts.total, 0);
  assert.deepEqual(empty.decisions.items, []);
  assert.deepEqual(empty.decisions.counts, ZERO_DECISION_COUNTS);
  assert.deepEqual(empty.warnings, []);
});


check('normalize: contract defaults and schema are kept', () => {
  const defaults = probe.normalize({ contract: { source: 'defaults', schema: 1, name: 'demo-alpha' } });
  assert.equal(defaults.contract.source, 'defaults');
  assert.equal(defaults.contract.name, 'demo-alpha');
  assert.equal(probe.normalize({ contract: 'nope' }).contract, null);
});

check('normalize: a payload without an experiments section stays empty', () => {
  const bare = probe.normalize({ ok: true });
  assert.equal(bare.exp.total, 0);
  assert.equal(bare.exp.confirmed, 0);
  assert.deepEqual(bare.exp.items, []);
  assert.deepEqual(bare.exp.tree, []);
});

check('normalize: hostile values do not throw', () => {
  const hostile = probe.normalize({
    experiments: { items: [null, 3, { id: 7, status: 'weird' }], tree: [null, { id: 'x', children: 'nope' }] },
    tasks: { counts: null, active: 'nope', recentDone: [{}] },
    heartbeats: [null, {}, { claims: 'nope' }],
    warnings: 'x',
    contract: [],
  });
  assert.equal(hostile.exp.items.length, 1, 'only the object experiment survives');
  assert.equal(hostile.exp.tree.length, 1, 'only the object tree node survives');
  assert.equal(hostile.exp.total, 0);
  assert.equal(hostile.tasks.counts.active, 0);
  assert.equal(hostile.tasks.counts.other, 0);
  assert.equal(hostile.tasks.recentDone.length, 1, 'the object task row survives');
  assert.deepEqual(hostile.tasks.recentDone[0].scope, { allow: [], deny: [] });
  assert.deepEqual(hostile.tasks.recentDone[0].acceptance, []);
  assert.deepEqual(hostile.tasks.recentDone[0].commits, []);
  assert.equal(hostile.tasks.recentDone[0].goal, '');
  assert.equal(hostile.tasks.recentDone[0].created_at, '');
  assert.equal(hostile.heartbeats.length, 2, 'non-object heartbeats are dropped');
  assert.deepEqual(hostile.heartbeats[1].claims, [], 'non-array claims degrade to empty');
  assert.equal(hostile.contract, null);
  assert.deepEqual(hostile.warnings, []);
});

check('ExperimentTree: renders the store tree rows, verdicts and chips', () => {
  const tree = probe.ExperimentTree({ exp: view.exp, t });
  const rows = collect(tree, 'project-flow-row');
  assert.equal(rows.length, 3, 'expected three experiment rows');
  assert.equal(collect(tree, 'project-flow-branch').length, 3);
  const branches = collect(tree, 'project-flow-branch').map((element) => element.children.join(''));
  assert.ok(branches.includes('└─'), 'missing last-child connector');
  assert.ok(branches.includes('├─'), 'missing middle connector');
  assert.equal(collect(tree, 'project-flow-verdict--confirmed').length, 1);
  assert.equal(collect(tree, 'project-flow-verdict--refuted').length, 1);
  assert.equal(collect(tree, 'project-flow-verdict--open').length, 1);
  assert.ok(collect(tree, 'project-flow-chip').length >= 5, 'statistics chips missing');
  const body = JSON.stringify(tree);
  assert.ok(body.includes('E-20261028-02'), 'child experiment id missing');
  assert.ok(body.includes('store'), 'store source chip missing');
});

check('ExperimentTree: click handlers are safe', () => {
  const tree = probe.ExperimentTree({ exp: view.exp, t });
  assert.ok(clickEverything(tree) >= 3, 'expected one handler per tree row');
});

check('ExperimentTree: empty experiment shows the store guidance', () => {
  const tree = probe.ExperimentTree({ exp: probe.normalize({}).exp, t });
  const text = JSON.stringify(tree);
  assert.ok(text.includes('还没有实验记录。'), 'store guidance copy missing');
  assert.ok(!text.includes('trailer'), 'guidance still mentions git trailers');
  assert.equal(collect(tree, 'project-flow-row').length, 0);
});

check('ExperimentTree: a missing tree rebuilds the forest from parent', () => {
  const payload = probe.normalize({
    experiments: {
      items: [
        { id: 'E-1', title: 'root', status: 'open' },
        { id: 'E-2', title: 'child', parent: 'E-1', status: 'confirmed' },
      ],
    },
  });
  const tree = probe.ExperimentTree({ exp: payload.exp, t });
  assert.equal(collect(tree, 'project-flow-row').length, 2);
  assert.equal(collect(tree, 'project-flow-branch').length, 2);
  assert.ok(JSON.stringify(collect(tree, 'project-flow-row')[0]).includes('E-1'));
});

check('DetailBlock: keeps original newlines in a <pre>', () => {
  const item = { id: 'E-x', hypothesis: '第一批\n换行保留', expected: 'exp', measured: 'meas' };
  const detail = probe.DetailBlock({ item, t });
  const values = collect(detail, 'project-flow-detailValue');
  assert.equal(values.length, 3);
  assert.equal(values[0].type, 'pre');
  assert.ok(values[0].children[0].includes('\n'), 'hypothesis newline lost');
  assert.equal(collect(detail, 'project-flow-detailLabel').length, 3);
});

check('TasksCard: chips, current task and one row per task', () => {
  const card = probe.TasksCard({ tasks: view.tasks, t, now: NOW });
  assert.equal(collect(card, 'project-flow-chip').length, 4, 'other chip should stay hidden at 0');
  const body = JSON.stringify(card);
  assert.ok(body.includes('T-20261028-56'), 'current task id missing');
  assert.ok(body.includes('client half'), 'current task title missing');
  // Rows: one draft, one active, three recent-done.
  assert.equal(collect(card, 'project-flow-taskRow').length, 5);
  assert.equal(collect(card, 'project-flow-gateMark--ok').length, 1);
  assert.equal(collect(card, 'project-flow-gateMark--error').length, 1);
  // The list itself never leaks an id or a commit before the detail opens.
  const text = textOf(card);
  for (const hidden of ['T-D1', 'T-3', 'T-4', 'T-5', '12556a8']) {
    assert.ok(!text.includes(hidden), `collapsed rows must not show '${hidden}'`);
  }
});

check('TasksCard: rows show title then goal and use the business id as key', () => {
  const payload = probe.normalize({
    tasks: {
      total: 2,
      counts: { active: 1, draft: 1 },
      current: null,
      draft: [{ id: 'T-D9', title: '标题乙', owner: '', goal: '', updated_at: '2026-10-28T09:00:00+08:00' }],
      active: [
        {
          id: 'T-A9',
          title: '标题甲',
          status: 'active',
          owner: 'alice',
          goal: '目标甲',
          updated_at: '2026-10-28T10:00:00+08:00',
        },
      ],
      recentDone: [],
    },
  });
  const card = probe.TasksCard({ tasks: payload.tasks, t, now: NOW });
  const body = JSON.stringify(card);
  const text = textOf(card);
  assert.ok(!text.includes('T-A9'), 'active row leaked its id');
  assert.ok(!text.includes('T-D9'), 'draft row leaked its id');
  // Drafts render first, so the title order is draft → active.
  assert.deepEqual(
    collect(card, 'project-flow-taskTitle').map((element) => element.children[0]),
    ['标题乙', '标题甲']
  );
  const goals = collect(card, 'project-flow-taskGoal');
  assert.equal(goals.length, 1, 'a row without a goal must not reserve the second line');
  assert.equal(goals[0].children[0], '目标甲', 'goal missing from the second line');
  assert.equal(goals[0].props.title, '目标甲', 'goal needs a full-text tooltip');
  assert.ok(body.includes('"key":"T-D9"'), 'draft row key is not its business id');
  assert.ok(body.includes('"key":"T-A9"'), 'active row key is not its business id');
  assert.ok(textOf(card).includes('负责人 alice'), 'owner meta missing');
});

check('TasksCard: the goal line is clamped to two lines by the stylesheet', () => {
  const rule = probe.CSS.split('\n').find((line) => line.startsWith('.project-flow-taskGoal{'));
  assert.ok(rule, 'goal CSS rule missing');
  assert.ok(rule.includes('-webkit-line-clamp:2'), 'goal is not clamped to two lines');
  assert.ok(rule.includes('-webkit-box-orient:vertical'), 'goal clamp box missing');
  assert.ok(rule.includes('overflow:hidden'), 'goal clamp does not hide the overflow');
  const titleRule = probe.CSS.split('\n').find((line) => line.startsWith('.project-flow-taskTitle{'));
  assert.ok(titleRule && titleRule.includes('text-overflow:ellipsis'), 'title has no ellipsis');
});

check('TaskRow: expanded detail carries every ledger field including the id', () => {
  const task = view.tasks.active[0];
  const row = probe.TaskRow({ task, t, now: NOW, open: true, onToggle: () => {} });
  assert.equal(collect(row, 'project-flow-taskDetail').length, 1, 'detail block missing');
  assert.deepEqual(collect(row, 'project-flow-detailLabel').map((element) => element.children[0]), [
    '编号',
    '目标',
    '备注',
    '文件域（允许）',
    '文件域（禁止）',
    '验收',
    '提交',
    '创建于',
    '更新于',
  ]);
  const values = collect(row, 'project-flow-detailValue').map((element) => element.children[0]);
  assert.equal(values[0], 'T-2', 'detail must show the business id');
  assert.equal(values[1], '看见任务目标与内容，而不是编号');
  assert.equal(values[2], '展开详情里的备注');
  assert.equal(values[3], 'client.js\nindex.js', 'scope.allow must keep one entry per line');
  assert.equal(values[4], 'lib/');
  assert.equal(values[5], 'node --check client.js\nnode .selftest/client-render.mjs');
  assert.equal(values[6], 'f5f176b', 'commits are short shas');
  assert.equal(values[7], '2026-10-28T08:00:00+08:00');
  assert.equal(values[8], '2026-10-28T10:00:00+08:00');
});

check('TaskRow: aria-expanded, click and keyboard Enter/Space toggle the detail', () => {
  const calls = [];
  const onToggle = (id) => calls.push(id);
  const task = view.tasks.draft[0];
  const collapsed = probe.TaskRow({ task, t, now: NOW, open: false, onToggle });
  const head = collect(collapsed, 'project-flow-taskHead')[0];
  assert.equal(head.type, 'div', 'row head should be a focusable div (role=button)');
  assert.equal(head.props.role, 'button');
  assert.equal(head.props.tabIndex, 0, 'row head is not keyboard reachable');
  assert.equal(head.props['aria-expanded'], false);
  assert.equal(collect(collapsed, 'project-flow-taskDetail').length, 0, 'collapsed row rendered a detail');
  head.props.onClick({});
  assert.deepEqual(calls, ['T-D1'], 'click did not toggle the draft id');

  let prevented = 0;
  head.props.onKeyDown({ key: 'Enter', preventDefault: () => (prevented += 1) });
  assert.deepEqual(calls, ['T-D1', 'T-D1'], 'Enter did not toggle the row');
  assert.equal(prevented, 1, 'Enter was not claimed by the row');
  head.props.onKeyDown({ key: 'a', preventDefault: () => (prevented += 1) });
  assert.equal(calls.length, 2, 'a non-toggle key must not expand the row');
  head.props.onKeyDown({ key: ' ' });
  assert.equal(calls.length, 3, 'Space did not toggle the row');

  const expanded = probe.TaskRow({ task, t, now: NOW, open: true, onToggle });
  const openHead = collect(expanded, 'project-flow-taskHead')[0];
  assert.equal(openHead.props['aria-expanded'], true);
  assert.equal(collect(expanded, 'project-flow-taskDetail').length, 1, 'expanded row has no detail');
});

check('TaskDetail: empty fields degrade to the dash placeholder', () => {
  const detail = probe.TaskDetail({ task: { id: 'T-empty' }, t });
  const values = collect(detail, 'project-flow-detailValue').map((element) => element.children[0]);
  assert.equal(values.length, 9);
  assert.equal(values[0], 'T-empty');
  assert.equal(values[1], '—', 'empty goal must show the dash');
  assert.equal(values[8], '—', 'empty timestamp must show the dash');
});

check('TasksCard: an unknown task status bucket still renders', () => {
  const otherOnly = probe.normalize({
    tasks: { total: 2, counts: { other: 2 }, current: null, active: [], recentDone: [] },
  });
  const card = probe.TasksCard({ tasks: otherOnly.tasks, t, now: NOW });
  assert.equal(collect(card, 'project-flow-chip').length, 5, 'other chip missing');
  const body = JSON.stringify(card);
  assert.ok(body.includes('2 其它'), 'other count not rendered');
  assert.ok(body.includes('任务台账里没有进行中的任务。'), 'active list empty state missing');
  assert.equal(collect(card, 'project-flow-taskRow').length, 0);
});

check('TasksCard: empty tasks render the generic ledger copy', () => {
  const card = probe.TasksCard({ tasks: probe.normalize({}).tasks, t, now: NOW });
  const body = JSON.stringify(card);
  assert.ok(body.includes('任务台账里没有进行中的任务。'), 'active empty copy missing');
  assert.ok(body.includes('任务台账里还没有完成的任务。'), 'recent empty copy missing');
  assert.ok(!body.includes('JSON'), 'empty copy still names a JSON ledger');
  assert.equal(collect(card, 'project-flow-taskRow').length, 0);
});

check('TasksCard: drafts render a todo section ahead of the active list', () => {
  const payload = probe.normalize({
    tasks: {
      total: 3,
      counts: { draft: 2, active: 1 },
      current: null,
      draft: [
        {
          id: 'T-D1',
          title: 'draft one',
          owner: 'alice',
          goal: '草稿一的目标',
          scope: { allow: ['README.md'] },
          updated_at: '2026-10-28T10:00:00+08:00',
        },
        {
          id: 'T-D2',
          title: 'draft two',
          owner: '',
          goal: '',
          updated_at: '2026-10-20T10:00:00+08:00',
        },
      ],
      active: [
        { id: 'T-A1', title: 'active one', status: 'active', owner: '', goal: '活动目标', updated_at: '2026-10-28T09:00:00+08:00' },
      ],
      recentDone: [],
    },
  });
  assert.equal(payload.tasks.draft.length, 2, 'normalize dropped the draft array');
  assert.equal(payload.tasks.draft[0].goal, '草稿一的目标');
  const card = probe.TasksCard({ tasks: payload.tasks, t, now: NOW });
  const body = JSON.stringify(card);
  assert.ok(body.includes('待办（草稿）'), 'draft section title missing');
  assert.equal(collect(card, 'project-flow-taskRow').length, 3, 'expected two drafts + one active row');
  assert.deepEqual(
    collect(card, 'project-flow-taskTitle').map((element) => element.children[0]),
    ['draft one', 'draft two', 'active one'],
    'drafts must render before the active list'
  );
  assert.deepEqual(
    collect(card, 'project-flow-taskGoal').map((element) => element.children[0]),
    ['草稿一的目标', '活动目标'],
    'draft goals must render on the second line'
  );
  assert.ok(body.includes('负责人 alice') || textOf(card).includes('负责人 alice'), 'draft owner missing');
  assert.ok(!textOf(card).includes('T-D1'), 'draft row must not show its id by default');

  const english = probe.TasksCard({ tasks: payload.tasks, t: tEn, now: NOW });
  // Data (the user's Chinese goals) may be Chinese; the chrome must not be.
  const englishText = textOf(english).split('草稿一的目标').join('').split('活动目标').join('');
  assert.ok(englishText.includes('Todo (drafts)'), 'en draft section title missing');
  assert.ok(englishText.includes('owner alice'), 'en owner meta missing');
  assert.ok(!/[\u4e00-\u9fff]/.test(englishText), 'en draft section still contains Chinese');
});

check('TasksCard: no draft rows means no todo section', () => {
  const payload = probe.normalize({
    tasks: {
      total: 2,
      counts: { draft: 0, active: 1, done: 1 },
      current: null,
      active: [{ id: 'T-A1', title: 'active one', owner: '' }],
      recentDone: [{ id: 'T-DONE', title: 'done one', commits: [], gate: null }],
    },
  });
  assert.deepEqual(payload.tasks.draft, [], 'an absent draft array normalizes to empty');
  const card = probe.TasksCard({ tasks: payload.tasks, t, now: NOW });
  const body = JSON.stringify(card);
  assert.ok(!body.includes('待办（草稿）'), 'empty draft section must not render');
  assert.equal(collect(card, 'project-flow-taskRow').length, 2, 'active/recent rows must be unchanged');

  // Older / hostile payloads must not crash or invent a section.
  const hostile = probe.TasksCard({
    tasks: { total: 1, counts: { draft: '2' }, draft: 'nope', active: [], recentDone: [] },
    t,
    now: NOW,
  });
  assert.ok(hostile, 'hostile draft field rendered nothing');
  assert.ok(!JSON.stringify(hostile).includes('待办（草稿）'), 'non-array draft must not render a section');
});

check('TasksCard: draft list caps at 25 rows and reports the overflow', () => {
  const drafts = Array.from({ length: 30 }, (_, index) => ({
    id: 'T-D' + String(index + 1).padStart(2, '0'),
    title: 'draft ' + (index + 1),
  }));
  const payload = probe.normalize({
    tasks: { total: 30, counts: { draft: 30 }, current: null, draft: drafts, active: [], recentDone: [] },
  });
  const card = probe.TasksCard({ tasks: payload.tasks, t, now: NOW });
  assert.equal(collect(card, 'project-flow-taskRow').length, 25, 'draft rows must cap at 25');
  const body = JSON.stringify(card);
  assert.ok(body.includes('draft 25'), 'last visible draft row missing');
  assert.ok(!body.includes('draft 26'), 'a 26th draft row leaked through');
  assert.ok(body.includes('还有 5 条未显示'), 'draft overflow copy missing');
  assert.equal(collect(card, 'project-flow-more').length, 1, 'overflow line missing');

  const english = probe.TasksCard({ tasks: payload.tasks, t: tEn, now: NOW });
  const englishText = JSON.stringify(english);
  assert.ok(englishText.includes('5 more not shown'), 'en overflow copy missing');
  assert.ok(!/[\u4e00-\u9fff]/.test(englishText), 'en overflow copy still contains Chinese');
});

// ------------------------------------------------------------- decisions (T-23)
check('normalize: decisions keep payload order, counts and the 11 shared keys', () => {
  const decisions = view.decisions;
  assert.equal(decisions.counts.open, 2);
  assert.equal(decisions.counts.blocking, 1);
  assert.equal(decisions.counts.total, 2);
  assert.equal(decisions.items.length, 2);
  assert.equal(decisions.items[0].id, 'D-20261028-01', 'the payload order was re-sorted');
  assert.equal(decisions.items[1].id, 'D-20261028-02');
  assert.equal(decisions.items[0].escalated, true);
  assert.equal(decisions.items[1].escalated, false);
  assert.deepEqual(decisions.items[0].blocks, ['T-20261028-56']);
  assert.deepEqual(decisions.items[1].options, [
    { id: 'panel', label: 'panel' },
    { id: 'cli', label: 'cli' },
  ]);
  // The row key set/order is the cross-domain contract, verbatim.
  assert.deepEqual(Object.keys(decisions.items[0]), DECISION_ITEM_KEYS);
  assert.deepEqual(Object.keys(decisions.items[1]), DECISION_ITEM_KEYS);
  assert.deepEqual(Object.keys(decisions.counts), DECISION_COUNT_KEYS);
});

check('normalize: a missing or hostile decisions section stays empty', () => {
  const bare = Object.assign({}, fixture);
  delete bare.decisions;
  const normalized = probe.normalize(bare);
  assert.deepEqual(normalized.decisions.items, []);
  assert.deepEqual(normalized.decisions.counts, ZERO_DECISION_COUNTS);
  assert.doesNotThrow(() => renderParts(bare), 'renderParts threw without a decisions section');
  assert.ok(JSON.stringify(renderParts(bare)).length > 100, 'payload parts rendered nothing');

  const hostile = probe.normalize({
    decisions: {
      items: [null, 3, 'nope', { id: 7, blocks: 'x', options: 'y', escalated: 'true', ageSeconds: 'soon' }],
      counts: 'nope',
    },
  });
  assert.equal(hostile.decisions.items.length, 1, 'only the object decision survives');
  assert.equal(hostile.decisions.items[0].id, '7');
  assert.deepEqual(hostile.decisions.items[0].blocks, []);
  assert.deepEqual(hostile.decisions.items[0].options, []);
  assert.equal(hostile.decisions.items[0].escalated, false, 'a truthy string is not an escalation');
  assert.equal(hostile.decisions.items[0].ageSeconds, null);
  assert.deepEqual(hostile.decisions.counts, ZERO_DECISION_COUNTS);
  assert.deepEqual(probe.normalize({ decisions: 'nope' }).decisions, {
    items: [],
    counts: ZERO_DECISION_COUNTS,
  });
  assert.deepEqual(probe.normalize({}).decisions, { items: [], counts: ZERO_DECISION_COUNTS });
});

check('DecisionsCard: title counts, ids, kind chips, ⚠ and copy buttons', () => {
  const card = probe.DecisionsCard({ decisions: view.decisions, t, now: NOW });
  assert.ok(card, 'card did not render');
  assert.equal(collect(card, 'project-flow-decisions').length, 1, 'the full-width card is missing');
  const text = textOf(card);
  assert.ok(text.includes('待决策 2'), 'title count missing');
  assert.ok(text.includes('阻塞 1'), 'blocking count missing');
  assert.ok(text.includes('D-20261028-01') && text.includes('D-20261028-02'), 'both decision ids must show');
  const rows = collect(card, 'project-flow-decisionRow');
  assert.equal(rows.length, 2, 'expected one row per pending decision');
  assert.ok(textOf(rows[0]).includes('⚠'), 'the escalated row lost its warning mark');
  assert.ok(!textOf(rows[1]).includes('⚠'), 'a non-escalated row must not carry the mark');
  assert.equal(collect(card, 'project-flow-chip').length, 3, 'two kind chips + one blocking chip');
  assert.equal(collect(card, 'project-flow-chip--warn').length, 1, 'the blocking chip is not flagged');
  assert.equal(collect(card, 'project-flow-decisionCopy').length, 2, 'one copy button per row');
  // The button tooltip is the exact line the user will paste.
  assert.equal(
    collect(card, 'project-flow-decisionCopy')[0].props.title,
    'flow decision answer D-20261028-01 --choice approve'
  );
  assert.equal(
    collect(card, 'project-flow-decisionCopy')[0].props['aria-label'],
    '复制决策 D-20261028-01 的回答命令'
  );
  assert.deepEqual(
    collect(card, 'project-flow-decisionId').map((element) => element.children[0]),
    ['D-20261028-01', 'D-20261028-02'],
    'rows must keep the payload order'
  );
  assert.ok(text.includes('T-20261028-56'), 'the blocked task id is missing');
  assert.ok(text.includes('2 小时前'), 'the escalated row has no age text');
  assert.ok(text.includes('1 分钟前'), 'the second row has no age text');
});

check('DecisionsCard: no open decision renders nothing at all', () => {
  const idle = probe.normalize({ decisions: { counts: { open: 0, total: 3 }, items: [] } });
  const card = probe.DecisionsCard({ decisions: idle.decisions, t, now: NOW });
  assert.equal(card, null, 'an idle board must not reserve a decision card');
  assert.equal(collect(card, 'project-flow-decisions').length, 0);
  const missing = probe.DecisionsCard({ decisions: probe.normalize({}).decisions, t, now: NOW });
  assert.equal(missing, null, 'a missing section must render nothing');
});

check('DecisionsCard: open rows without items show the defensive empty copy', () => {
  const card = probe.DecisionsCard({
    decisions: { counts: { open: 2, blocking: 0 }, items: [] },
    t,
    now: NOW,
  });
  assert.equal(collect(card, 'project-flow-decisions').length, 1, 'the card must still render');
  assert.ok(textOf(card).includes('没有待决策'), 'empty copy missing');
  assert.equal(collect(card, 'project-flow-decisionCopy').length, 0, 'no rows means no buttons');
});

check('DecisionsCard: rows missing from the payload are reported as more', () => {
  const decisions = {
    counts: { open: 5, blocking: 2 },
    items: [
      { id: 'D-a', kind: 'approval', question: 'a', recommendation: 'yes' },
      { id: 'D-b', kind: 'choice', question: 'b', options: [{ id: 'x' }] },
      { id: 'D-c', kind: 'input', question: 'c', recommendation: 'say hi' },
    ],
  };
  const card = probe.DecisionsCard({ decisions, t, now: NOW });
  assert.ok(textOf(card).includes('待决策 5'), 'the title must report the host count');
  assert.ok(textOf(card).includes('阻塞 2'), 'blocking copy missing');
  assert.ok(textOf(card).includes('还有 2 条'), 'overflow copy missing');
  assert.equal(collect(card, 'project-flow-more').length, 1, 'the overflow line must render once');

  const english = probe.DecisionsCard({
    decisions: { counts: { open: 3, blocking: 1 }, items: [decisions.items[0]] },
    t: tEn,
    now: NOW,
  });
  assert.ok(textOf(english).includes('3 pending decisions'), 'en title missing');
  assert.ok(textOf(english).includes('2 more'), 'en overflow copy missing');
});

check('decisionAnswerCommand: recommendation, default, options[0] and input quoting', () => {
  assert.equal(
    probe.decisionAnswerCommand({
      id: 'D-1',
      kind: 'approval',
      recommendation: 'approve',
      default: 'reject',
      options: [{ id: 'opt' }],
    }),
    'flow decision answer D-1 --choice approve',
    'the recommendation must win'
  );
  assert.equal(
    probe.decisionAnswerCommand({
      id: 'D-2',
      kind: 'approval',
      recommendation: '',
      default: 'reject',
      options: [{ id: 'opt' }],
    }),
    'flow decision answer D-2 --choice reject',
    'the default is the second source'
  );
  assert.equal(
    probe.decisionAnswerCommand({ id: 'D-3', kind: 'choice', options: [{ id: 'panel' }, { id: 'cli' }] }),
    'flow decision answer D-3 --choice panel',
    'options[0] is the last source'
  );
  assert.equal(
    probe.decisionAnswerCommand({ id: 'D-4', kind: 'input', recommendation: 'use A then B' }),
    'flow decision answer D-4 --choice "use A then B"',
    'an input decision quotes its free text'
  );
  // No choice source at all: no command, hence no button.
  assert.equal(probe.decisionAnswerCommand({ id: 'D-5', kind: 'approval' }), '');
  assert.equal(probe.decisionAnswerCommand({ kind: 'approval', recommendation: 'x' }), '', 'an id is required');
  assert.equal(probe.decisionAnswerCommand(null), '');
  assert.equal(probe.decisionAnswerCommand('nope'), '');
});

check('DecisionsCard: a decision without a choice renders no copy button', () => {
  const card = probe.DecisionsCard({
    decisions: {
      counts: { open: 1, blocking: 0 },
      items: [{ id: 'D-9', kind: 'note', status: 'open', question: 'No options, no default' }],
    },
    t,
    now: NOW,
  });
  assert.equal(collect(card, 'project-flow-decisionRow').length, 1, 'the row itself must still render');
  assert.equal(collect(card, 'project-flow-decisionCopy').length, 0, 'a choiceless decision must not offer a button');
});

check('DecisionsCard: clicking every copy button is safe without a clipboard', () => {
  const card = probe.DecisionsCard({ decisions: view.decisions, t, now: NOW });
  assert.equal(clickEverything(card), 2, 'expected one clickable copy button per row');
  assert.doesNotThrow(() => clickEverything(card), 'a clipboard-less environment threw');
});

check('DecisionsCard: the English dictionary renders no Chinese chrome', () => {
  const card = probe.DecisionsCard({ decisions: view.decisions, t: tEn, now: NOW });
  const english = textOf(card);
  assert.ok(english.includes('2 pending decisions'), 'en title missing');
  assert.ok(english.includes('1 blocking'), 'en blocking copy missing');
  assert.ok(english.includes('Copy answer command'), 'en copy label missing');
  assert.ok(!/[\u4e00-\u9fff]/.test(english), 'en decision card text still contains Chinese');
  assert.ok(!/[\u4e00-\u9fff]/.test(JSON.stringify(card)), 'en decision card props still contain Chinese');
});

check('DecisionsCard: the new stylesheet rules use theme tokens', () => {
  const rules = probe.CSS.split('\n').filter((line) => line.startsWith('.project-flow-decision'));
  assert.ok(rules.length >= 6, `decision stylesheet rules missing (${rules.length})`);
  for (const rule of rules) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rule), 'hardcoded hex color: ' + rule);
    assert.ok(!/\brgba?\(/.test(rule) && !/\bhsla?\(/.test(rule), 'hardcoded color function: ' + rule);
    if (rule.includes('color:')) assert.ok(rule.includes('var(--dsw-alias-'), 'color without a token: ' + rule);
  }
});

check('Panel: the decision card mounts above the two-column grid', () => {
  const text = readFileSync(SRC, 'utf8');
  const card = text.indexOf('React.createElement(DecisionsCard, { decisions: view.decisions, t, now })');
  const grid = text.indexOf("className: 'project-flow-grid'");
  assert.ok(card > 0, 'the Panel does not mount DecisionsCard');
  assert.ok(grid > card, 'the decision card must render before the grid');
});

check('SignalsCard: rich heartbeats render status, goal, claims and the current highlight', () => {
  const card = probe.SignalsCard({
    heartbeats: view.heartbeats,
    heartbeatCounts: view.heartbeatCounts,
    t,
    now: NOW,
    sessionId: 'session-aaaa',
  });
  const body = JSON.stringify(card);
  assert.ok(body.includes('工作中'), 'status chip missing');
  assert.ok(body.includes('ship the panel'), 'goal missing');
  assert.ok(body.includes('client.js'), 'claim missing');
  assert.ok(body.includes('可能已停'), 'stale copy missing');
  assert.equal(collect(card, 'project-flow-beat').length, 2, 'expected two heartbeat rows');
  assert.equal(collect(card, 'project-flow-beat--current').length, 1, 'current heartbeat not highlighted');
  assert.equal(collect(card, 'project-flow-chip--warn').length, 1, 'stale heartbeat not flagged');
  assert.equal(collect(card, 'project-flow-pre').length, 0, 'no log block should render');
});

check('SignalsCard: empty heartbeats render the empty copy', () => {
  const card = probe.SignalsCard({ heartbeats: [], heartbeatCounts: { total: 0 }, t, now: NOW });
  const body = JSON.stringify(card);
  assert.ok(body.includes('没有心跳文件。'), 'heartbeat empty copy missing');
  assert.equal(collect(card, 'project-flow-beat').length, 0);
  assert.equal(collect(card, 'project-flow-pre').length, 0);
});

check('GatesCard: definitions, enabled summary and last run', () => {
  const card = probe.GatesCard({ gates: view.gates, t, now: NOW, workspaceRoot: view.root });
  const body = JSON.stringify(card);
  assert.ok(body.includes('启用 1 / 共 2'), 'enabled summary missing');
  assert.ok(body.includes('冒烟'), 'gate title missing');
  assert.ok(body.includes('从未运行'), 'never-run copy missing');
  assert.ok(body.includes('smoke'), 'gate id key missing');
  assert.equal(collect(card, 'project-flow-gate').length, 2, 'expected two gate rows');
  assert.equal(collect(card, 'project-flow-switch').length, 2, 'enable switches missing');
});

check('SignalsCard: hostile heartbeat props do not throw', () => {
  const card = probe.SignalsCard({ heartbeats: null, heartbeatCounts: null, t, now: NOW });
  assert.ok(card, 'card did not render');
  assert.ok(JSON.stringify(card).includes('没有心跳文件。'));
});

check('TopBar: head, dirty marker, live dot, refresh and read-only chip', () => {
  const bar = probe.TopBar({
    view,
    t,
    now: NOW,
    lastOkAt: NOW - 2000,
    failed: false,
    refreshing: false,
    onRefresh: () => {},
  });
  const body = JSON.stringify(bar);
  assert.ok(body.includes('f5f176b'), 'short HEAD sha missing');
  assert.ok(body.includes('dev'), 'branch missing');
  assert.equal(collect(bar, 'project-flow-dirtyDot').length, 1);
  assert.equal(collect(bar, 'project-flow-liveDot').length, 1);
  assert.equal(collect(bar, 'project-flow-btn').length, 1);
  assert.ok(body.includes('只读'), 'read-only chip missing');
  // failed variant flips the dot and the label
  const stale = probe.TopBar({
    view,
    t,
    now: NOW,
    lastOkAt: NOW - 65000,
    failed: true,
    refreshing: true,
    onRefresh: () => {},
  });
  assert.equal(collect(stale, 'project-flow-liveDot--stale').length, 1);
  assert.equal(collect(stale, 'project-flow-btn')[0].props.disabled, true);
});

check('TopBar: missing head fields still render', () => {
  const bare = probe.TopBar({
    view: probe.normalize({}),
    t,
    now: NOW,
    lastOkAt: 0,
    failed: true,
    refreshing: false,
    onRefresh: () => {},
  });
  assert.equal(collect(bare, 'project-flow-pill').length, 1, 'live pill expected when head fields are absent');
  assert.equal(collect(bare, 'project-flow-pill')[0].props.className.includes('project-flow-live'), true);
  assert.equal(collect(bare, 'project-flow-chip').length, 1, 'read-only chip expected');
});

check('Footer: project, generatedAt and expandable warnings', () => {
  const footer = probe.Footer({ view, t });
  const link = collect(footer, 'project-flow-footerLink');
  assert.equal(link.length, 1);
  assert.equal(link[0].props['aria-expanded'], false);
  const body = JSON.stringify(footer);
  assert.ok(body.includes('2026-10-28T11:30:00+08:00'), 'generatedAt missing');
  assert.ok(body.includes('项目: /tmp/pf-demo/alpha'), 'project label missing');
  const empty = probe.Footer({ view: probe.normalize({}), t });
  assert.equal(collect(empty, 'project-flow-footerLink').length, 0);
});

check('Footer: contract source line (file source, defaults, missing)', () => {
  const declared = probe.Footer({ view: probe.normalize({ contract: { source: 'flow.json', schema: 1, name: 'demo-alpha' } }), t });
  const declaredSpan = collect(declared, 'project-flow-contract');
  assert.equal(declaredSpan.length, 1, 'contract line missing for a declared contract');
  assert.equal(declaredSpan[0].children[0], '契约：flow.json');
  assert.ok(String(declaredSpan[0].props.title).includes('demo-alpha'), 'contract tooltip missing name');
  assert.ok(String(declaredSpan[0].props.title).includes('schema 1'), 'contract tooltip missing schema');

  const defaults = probe.Footer({ view: probe.normalize({ contract: { source: 'defaults', schema: 1, name: 'demo-alpha' } }), t });
  assert.equal(collect(defaults, 'project-flow-contract')[0].children[0], '契约：默认布局');
  const defaultsEn = probe.Footer({ view: probe.normalize({ contract: { source: 'defaults' } }), t: tEn });
  assert.equal(collect(defaultsEn, 'project-flow-contract')[0].children[0], 'contract: default layout');

  const hidden = probe.Footer({ view: probe.normalize({}), t });
  assert.equal(collect(hidden, 'project-flow-contract').length, 0, 'contract line must hide when absent');
});

check('ErrorState: not-initialized shows the init guidance and one Initialize button', () => {
  const element = probe.ErrorState({
    t,
    info: { code: 'not-initialized', message: 'no ledger' },
    workspaceRoot: '/tmp/pf-demo/alpha',
    onInitialized: () => {},
  });
  const text = JSON.stringify(element);
  assert.ok(text.includes('未初始化'), 'empty.title copy missing');
  assert.ok(text.includes('这个工作区还没有项目流台账。'), 'error.notInitialized copy missing');
  assert.ok(text.includes('node bin/flow.mjs init'), 'error.initHint copy missing');
  assert.ok(text.includes('点「初始化」'), 'error.initHint does not lead with the button');
  assert.ok(!text.includes('重试'), 'generic retry label leaked into the not-initialized card');
  const buttons = collect(element, 'project-flow-btn');
  assert.equal(buttons.length, 1, 'init button missing');
  assert.equal(buttons[0].children[0], '初始化');
  assert.equal(buttons[0].props.disabled, false, 'init button starts enabled');

  const english = probe.ErrorState({
    t: tEn,
    info: { code: 'not-initialized', message: 'no ledger' },
    workspaceRoot: '/tmp/pf-demo/alpha',
    onInitialized: () => {},
  });
  const englishText = JSON.stringify(english);
  assert.ok(englishText.includes('Click Initialize'), 'en init hint copy missing');
  assert.ok(englishText.includes('node bin/flow.mjs init'), 'en init hint command missing');
  assert.equal(collect(english, 'project-flow-btn')[0].children[0], 'Initialize');

  // Every other code keeps today's copy (and must not show the init hint).
  const generic = probe.ErrorState({ t, info: { code: 'no-project' }, onRetry: () => {} });
  const genericText = JSON.stringify(generic);
  assert.ok(genericText.includes('无法读取实验状态'), 'error.title copy missing');
  assert.ok(genericText.includes('当前目录不是可读取的项目。'), 'error.noProject copy missing');
  assert.ok(!genericText.includes('node bin/flow.mjs'), 'init hint leaked into a generic error');
  assert.ok(!genericText.includes('初始化'), 'init button label leaked into a generic error');
  const genericButtons = collect(generic, 'project-flow-btn');
  assert.equal(genericButtons.length, 1, 'generic retry button missing');
  assert.equal(genericButtons[0].children[0], '重试');
});

check('normalize: a not-initialized payload is tolerated', () => {
  const notInitialized = {
    ok: false,
    root: '/tmp/pf-demo/alpha',
    roots: [{ path: '/tmp/pf-demo/alpha', name: 'demo-alpha' }],
    error: { code: 'not-initialized', message: 'this workspace has no ledger' },
  };
  const normalized = probe.normalize(notInitialized);
  assert.equal(normalized.root, '/tmp/pf-demo/alpha');
  assert.equal(normalized.roots.length, 1);
  assert.equal(normalized.roots[0].name, 'demo-alpha');
  assert.equal(normalized.exp.total, 0);
  assert.equal(normalized.contract, null);
  assert.ok(JSON.stringify(renderParts(notInitialized)).length > 100, 'payload parts rendered nothing');
});

check('Panel: first render is the loading skeleton', () => {
  const element = probe.Panel({ t, workspaceRoot: '/tmp/pf-demo/alpha' });
  assert.equal(element.type, 'div');
  assert.equal(collect(element, 'project-flow-spinner').length, 1, 'loading spinner missing');
  assert.ok(textOf(element).includes('读取中…'), 'generic loading copy missing');
  assert.ok(!textOf(element).includes('只读'), 'top bar rendered before data');
});

check('Panel: no workspaceRoot renders the pending card and no snapshot', () => {
  // useEffect is stubbed out, so the polling effect never runs here; the point is
  // the workspace-pending copy plus the spinner, not a top bar.
  const element = probe.Panel({ t });
  assert.equal(element.type, 'div');
  const card = collect(element, 'project-flow-loadingCard');
  assert.equal(card.length, 1, 'loading card missing');
  const cardText = textOf(card[0]);
  assert.ok(cardText.includes('正在读取当前工作区…'), 'workspace.pending copy missing');
  assert.ok(!cardText.includes('读取中…'), 'generic loading copy leaked into the pending card');
  assert.equal(collect(card[0], 'project-flow-spinner').length, 1, 'spinner missing in the pending card');
  assert.ok(!textOf(element).includes('只读'), 'top bar rendered before a workspace is known');
});

check('PanelRoot: wraps Panel in the error boundary', () => {
  const element = probe.PanelRoot({ t });
  assert.equal(typeof element.type, 'function');
  assert.equal(element.children[0].type.name, 'Panel');
});

check('relative time: seconds, minutes, hours, days, absolute fallback', () => {
  assert.equal(probe.relativeFromSeconds(2, t), '刚刚');
  assert.equal(probe.relativeFromSeconds(25, t), '25 秒前');
  assert.equal(probe.relativeFromSeconds(120, t), '2 分钟前');
  assert.equal(probe.relativeFromSeconds(7200, t), '2 小时前');
  assert.equal(probe.relativeFromSeconds(2 * 86400, t), '2 天前');
  assert.equal(probe.relativeFromSeconds(30 * 86400, t), null);
  assert.equal(probe.ageText(60, null, NOW, t), '1 分钟前');
  assert.equal(probe.ageText(null, NOW - 60 * 1000, NOW, t), '1 分钟前');
  assert.equal(probe.ageText(null, null, NOW, t), null);
});

// ------------------------------------------------------- right-bar seats
check('PanelBody: wraps the panel in the error boundary and forwards t', () => {
  const element = probe.PanelBody({ t });
  assert.equal(typeof element.type, 'function');
  const boundary = probe.PanelBody({ t });
  const boundaryEl = boundary.type(boundary.props);
  assert.ok(boundaryEl, 'body did not render');
  const inner = probe.PanelRoot({ t });
  assert.equal(inner.children[0].type.name, 'Panel');
});

check('PanelBody: resolves the session workspace and keys the panel by it', () => {
  const element = probe.PanelBody({
    t,
    sessionId: 'session-x',
    useSessions: (selector) =>
      selector({ byId: { 'session-x': { cwd: '/tmp/pf-demo/alpha' } } }),
  });
  assert.equal(element.props.workspaceRoot, '/tmp/pf-demo/alpha');
  assert.equal(element.props.key, '/tmp/pf-demo/alpha');
  const rootElement = element.type(element.props);
  assert.ok(rootElement.type.prototype instanceof Component, 'panel root is not the boundary class');
  const panelElement = rootElement.children[0];
  assert.equal(panelElement.type.name, 'Panel');
  assert.equal(panelElement.props.workspaceRoot, '/tmp/pf-demo/alpha');

  // No session / no cwd yet: the panel is keyed as pending and gets no root.
  const pending = probe.PanelBody({ t });
  assert.equal(pending.props.workspaceRoot, undefined);
  assert.equal(pending.props.key, 'pending');

  const unknownSession = probe.PanelBody({
    t,
    sessionId: 'session-y',
    useSessions: (selector) => selector({ byId: { 'session-x': { cwd: '/tmp/pf-demo/alpha' } } }),
  });
  assert.equal(unknownSession.props.workspaceRoot, undefined);
  assert.equal(unknownSession.props.key, 'pending');

  const emptyCwd = probe.PanelBody({
    t,
    sessionId: 'session-x',
    useSessions: (selector) => selector({ byId: { 'session-x': { cwd: '' } } }),
  });
  assert.equal(emptyCwd.props.workspaceRoot, undefined, 'empty cwd must stay pending');
});

check('PanelTitle: renders the localized chip text and a 16px glyph', () => {
  const element = probe.PanelTitle({ t });
  const chip = element.children.find((child) => child && child.type === 'span');
  assert.ok(chip, 'chip span missing');
  assert.equal(chip.props.className, 'project-flow-tabTitle');
  assert.equal(chip.children[1].children[0], '项目流');
});

check('HeaderAction: 28x28 opener button, click delegates, no throw on failure', () => {
  let opened = 0;
  const element = probe.HeaderAction({ t, openPanel: () => { opened += 1; } });
  const button = element.children.find((child) => child && child.type === 'button');
  assert.ok(button, 'header button missing');
  assert.equal(button.props['aria-label'], '打开项目流面板');
  button.props.onClick({ preventDefault() {} });
  assert.equal(opened, 1);
  const broken = probe.HeaderAction({ t, openPanel: () => { throw new Error('x'); } });
  const brokenButton = broken.children.find((child) => child && child.type === 'button');
  assert.doesNotThrow(() => brokenButton.props.onClick({ preventDefault() {} }));
});

// ------------------------------------------- replay real Host state fixtures
function renderParts(payload) {
  const v = probe.normalize(payload);
  return [
    probe.TopBar({ view: v, t, now: NOW, lastOkAt: NOW, failed: false, refreshing: false, onRefresh: () => {} }),
    probe.DecisionsCard({ decisions: v.decisions, t, now: NOW }),
    probe.ExperimentTree({ exp: v.exp, t }),
    probe.TasksCard({ tasks: v.tasks, t, now: NOW }),
    probe.GatesCard({ gates: v.gates || [], t, now: NOW, workspaceRoot: v.root }),
    probe.SignalsCard({ heartbeats: v.heartbeats, heartbeatCounts: v.heartbeatCounts, t, now: NOW }),
    probe.Footer({ view: v, t }),
  ];
}

/** Every className rendered by the parts (data values are not inspected). */
function renderedClassNames(parts) {
  const names = [];
  parts.forEach((part) =>
    walk(part, (element) => {
      const cls = element.props && element.props.className;
      if (typeof cls === 'string') names.push(cls);
    })
  );
  return names;
}

const hostFixtures = ['state-store.json', 'state-not-initialized.json'];
let replayed = 0;
for (const name of hostFixtures) {
  const path = fileURLToPath(new URL('./' + name, import.meta.url));
  if (!existsSync(path)) continue;
  check(`Host fixture ${name}: renders without throwing`, () => {
    const payload = JSON.parse(readFileSync(path, 'utf8'));
    const parts = renderParts(payload);
    const html = JSON.stringify(parts);
    assert.ok(html.length > 100, 'render produced nothing');
    const classes = renderedClassNames(parts);
    assert.ok(classes.length > 0, 'render produced no class names');
    for (const cls of classes) {
      assert.ok(cls.split(/\s+/).every((one) => one.startsWith('project-flow')), `unexpected class: ${cls}`);
    }
    if (name === 'state-store.json') {
      const text = JSON.stringify(parts);
      assert.ok(text.includes('E-20261028-02'), 'store fixture: nested child node missing from render');
      assert.ok(text.includes('smoke'), 'store fixture: gate definition missing from render');
      assert.ok(text.includes('门禁'), 'store fixture: gates section title missing');
      // P10: the decisions section of the real store payload reaches the card.
      assert.ok(text.includes('待决策 3'), 'store fixture: decisions title missing');
      assert.ok(text.includes('D-20261028-01'), 'store fixture: first decision id missing');
      assert.ok(text.includes('D-20261028-03'), 'store fixture: input decision id missing');
      const decisionCards = parts.filter((part) => collect(part, 'project-flow-decisions').length === 1);
      assert.equal(decisionCards.length, 1, 'store fixture: decision card not rendered');
      const decisionRows = collect(decisionCards[0], 'project-flow-decisionRow');
      assert.equal(decisionRows.length, 3, 'store fixture: expected three decision rows');
      const copyButtons = collect(decisionCards[0], 'project-flow-decisionCopy');
      assert.equal(copyButtons.length, 3, 'store fixture: expected three copy buttons');
      assert.ok(
        copyButtons.some((element) => String(element.props.title).includes('flow decision answer')),
        'store fixture: no answer command rendered'
      );
      assert.equal(
        copyButtons[0].props.title,
        'flow decision answer D-20261028-01 --choice approve',
        'store fixture: approval command is wrong'
      );
      assert.equal(
        copyButtons[2].props.title,
        'flow decision answer D-20261028-03 --choice "周六 22:00 之后"',
        'store fixture: the input decision is not quoted'
      );
    }
    replayed += 1;
  });
}

// ------------------------------------------------------------------- summary
const failed = results.filter((entry) => !entry.ok);
console.log('');
console.log(`probe                      = ${PROBE}`);
console.log(`host fixtures replayed     = ${replayed}/${hostFixtures.length}`);
console.log(`assertions                 = ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error('CLIENT RENDER CHECK FAILED');
  process.exitCode = 1;
}
