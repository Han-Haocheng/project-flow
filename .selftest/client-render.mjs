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
 * T-08 (card A) adds the queue view of the task card: the `TasksCard` checks run
 * through a small hook runtime (`renderWithState`) so a group toggle can be
 * clicked and the re-rendered tree inspected, exactly like the panel behaves
 * across a 2.5 s poll. They assert the fixed group order (active → draft →
 * recentDone), folded-by-default draft/recent groups, a ≤12-row first screen on
 * a 50+ task ledger, the "N more" line for EVERY truncated group (the silent
 * 25-row cut on active/recent is the regression under test), the front-end queue
 * head, and the aria-expanded / aria-controls wiring of the group toggles.
 *
 * Run: node .selftest/client-render.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { legacyExperimentsWarning } from '../lib/state-snapshot.mjs';

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
  "    return {\n      __probe: { zh, en, normalize, Panel, PanelRoot, PanelBody, PanelTitle, HeaderAction, ExperimentTree, TasksCard, TaskRow, TaskDetail, GatesCard, SignalsCard, TopBar, Footer, ErrorState, DetailBlock, PanelIcon, PanelGlyph, relativeFromSeconds, ageText, runPanel: Panel, CSS, DecisionsCard, normalizeDecisions, decisionAnswerCommand },\n      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],";

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
/*
 * Minimal hook runtime. `useState` keeps one slot list per component function and
 * marks the frame dirty when a setter runs, so `renderWithState` can re-render
 * until the state settles — that is what lets these checks drive a group toggle
 * and then observe the re-rendered tree, the way the real panel behaves after a
 * click (and across a 2.5 s poll, since the frames are keyed by component, not by
 * props). Direct `probe.X(...)` calls keep the old stateless behaviour.
 */
let hookFrame = null;
const hookFrames = new Map();
const ReactStub = {
  createElement,
  Fragment: Symbol.for('react.fragment'),
  Component,
  useState(initial) {
    if (hookFrame === null) return [typeof initial === 'function' ? initial() : initial, () => {}];
    const frame = hookFrame;
    const slot = frame.index++;
    if (Object.hasOwn(frame.slots, slot) === false) {
      frame.slots[slot] = typeof initial === 'function' ? initial() : initial;
    }
    const set = (next) => {
      frame.slots[slot] = typeof next === 'function' ? next(frame.slots[slot]) : next;
      frame.dirty = true;
    };
    return [frame.slots[slot], set];
  },
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

/**
 * Render a function component with a persistent hook frame. Slots are keyed by
 * the component function, so state survives a new `props` object — exactly the
 * situation a poll refresh produces. `reset` starts a fresh instance.
 */
function renderWithState(component, props, options = {}) {
  if (options.reset === true) hookFrames.delete(component);
  let frame = hookFrames.get(component);
  if (frame === undefined) {
    frame = { slots: {}, index: 0, dirty: false };
    hookFrames.set(component, frame);
  }
  const previous = hookFrame;
  hookFrame = frame;
  let tree;
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      frame.index = 0;
      frame.dirty = false;
      tree = component(props);
      if (frame.dirty === false) break;
    }
  } finally {
    hookFrame = previous;
  }
  return tree;
}

/**
 * Render ExperimentTree with its section fold OPEN. It starts collapsed (that is
 * the B3 contract), so every legacy "rows render" check goes through here and
 * asserts the closed state on the way in.
 */
function openTree(exp, translate = t) {
  const closed = renderWithState(probe.ExperimentTree, { exp, t: translate, now: NOW }, { reset: true });
  const toggle = collect(closed, 'project-flow-groupToggle')[0];
  /* An empty ledger has no fold header at all (the guide replaces it). */
  if (toggle === undefined) return closed;
  assert.equal(toggle.props['aria-controls'], 'project-flow-expTree', 'the fold header must control project-flow-expTree');
  assert.equal(toggle.props['aria-expanded'], false, 'the experiment tree must start folded');
  assert.equal(collect(closed, 'project-flow-row').length, 0, 'a folded tree must not render rows');
  toggle.props.onClick({});
  return renderWithState(probe.ExperimentTree, { exp, t: translate, now: NOW });
}

/** A freshly mounted TasksCard (hook state reset) for the given payload. */
function mountTasks(tasks, translate = t) {
  return renderWithState(probe.TasksCard, { tasks, t: translate, now: NOW }, { reset: true });
}

/** The fold toggle of one group, addressed by its aria-controls target. */
function groupToggle(node, group) {
  const target = 'project-flow-group-' + group;
  const button = collect(node, 'project-flow-groupToggle').find(
    (element) => element.props && element.props['aria-controls'] === target
  );
  assert.ok(button, `group toggle missing: ${group}`);
  return button;
}

/** Click one group's toggle and return the re-rendered tree (state persists). */
function toggleGroup(node, group, tasks, translate = t) {
  groupToggle(node, group).props.onClick({});
  return renderWithState(probe.TasksCard, { tasks, t: translate, now: NOW });
}

/** Group keys in render order, for the fixed active → draft → recentDone order. */
function groupOrder(node) {
  return collect(node, 'project-flow-group').map((element) => element.props && element.props.key);
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
  const tree = openTree(view.exp);
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
  const tree = openTree(view.exp);
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
  const tree = openTree(payload.exp);
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

check('i18n: zh/en dictionaries stay in lockstep (keys, placeholders, ASCII-only en, every t() key defined)', () => {
  const zh = probe.zh;
  const en = probe.en;
  assert.ok(zh && en, 'the zh/en dictionaries are not exposed through __probe');
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(zhKeys, enKeys, 'zh/en key sets differ');
  const placeholders = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const mismatch = zhKeys.filter((key) => placeholders(zh[key]) !== placeholders(en[key]));
  assert.deepEqual(mismatch, [], `placeholder mismatch between zh and en: ${mismatch.join(', ')}`);
  const chinese = enKeys.filter((key) => /[\u4e00-\u9fff]/.test(String(en[key])));
  assert.deepEqual(chinese, [], `en still contains Chinese: ${chinese.join(', ')}`);
  // Every literal t('…') must resolve; the dynamic prefixes are whitelisted but
  // must exist in the dictionary (so a renamed bucket cannot go silent).
  const dynamic = ['tasks.status.', 'gates.phase.', 'hb.status.'];
  const used = [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((key) => !(key in zh) && !dynamic.some((prefix) => key.startsWith(prefix)));
  assert.deepEqual(missing, [], `t() keys with no zh definition: ${missing.join(', ')}`);
  for (const prefix of dynamic) {
    assert.ok(zhKeys.some((key) => key.startsWith(prefix)), `dynamic prefix ${prefix}* has no keys`);
  }
});

check('ExperimentTree: row expansion is keyed by experiment id and survives a reorder', () => {
  // Same defect class the T-08 review rejected for the task groups: expansion
  // state keyed by render index silently collapses when rows move.
  const build = (ids) =>
    probe.normalize({
      experiments: {
        total: ids.length,
        counts: { total: ids.length, open: ids.length },
        items: ids.map((id) => ({ id, title: 'exp ' + id, status: 'open' })),
        tree: [],
      },
    }).exp;
  const first = build(['E-B', 'E-A']);
  let tree = openTree(first);
  const rows = collect(tree, 'project-flow-row');
  assert.equal(rows.length, 2, 'expected two experiment rows');
  const target = rows.find((row) => textOf(row).includes('E-A'));
  assert.ok(target, 'row for E-A missing');
  target.props.onClick({});
  tree = renderWithState(probe.ExperimentTree, { exp: first, t, now: NOW });
  const before = collect(tree, 'project-flow-row').find((row) => textOf(row).includes('E-A'));
  assert.equal(before.props['aria-expanded'], true, 'the clicked row did not expand');

  // A refresh that reverses the row order must keep the SAME experiment open.
  const after = renderWithState(probe.ExperimentTree, {
    exp: build(['E-A', 'E-B']),
    t,
    now: NOW,
  });
  const aAfter = collect(after, 'project-flow-row').find((row) => textOf(row).includes('E-A'));
  const bAfter = collect(after, 'project-flow-row').find((row) => textOf(row).includes('E-B'));
  assert.equal(aAfter.props['aria-expanded'], true, 'expansion lost when rows reordered (state keyed by render index)');
  assert.equal(bAfter.props['aria-expanded'], false, 'the other row must stay collapsed');
});

check('host contract: a closed experiment area points at the opt-in flag once, and never auto-enables', () => {
  const closed = { experiments: {} };                      // legacy manifest: no flag at all
  const open = { experiments: { enabled: true } };
  const records = [{ id: 'E-1', status: 'open' }];

  const first = legacyExperimentsWarning(closed, records, '/tmp/pf-legacy-a');
  assert.ok(typeof first === 'string', 'a legacy manifest with records must warn');
  assert.ok(first.startsWith('experiments-disabled-legacy: 1 '), 'unexpected warning copy: ' + first);
  assert.ok(first.includes('experiments.enabled=true'), 'the warning must say how to opt in');
  assert.ok(/never enabled|nothing is enabled|not enabled/i.test(first), 'the warning must state it will not auto-enable');

  assert.equal(
    legacyExperimentsWarning(closed, records, '/tmp/pf-legacy-a'),
    null,
    'the warning must be one-shot per root (a 2.5 s poll must not storm)'
  );
  assert.equal(legacyExperimentsWarning(closed, [], '/tmp/pf-legacy-b'), null, 'no records means nothing to warn about');
  assert.equal(legacyExperimentsWarning(open, records, '/tmp/pf-legacy-c'), null, 'an open area must not warn');
  assert.ok(
    typeof legacyExperimentsWarning(closed, records, '/tmp/pf-legacy-d') === 'string',
    'each root gets its own single warning'
  );
});

// -------------------------------------------------- task trend (T-09 card C)
/** 14-day trend fixture: created 6 · done 4 · archived 1, one empty day. */
function trendTasks(overrides = {}) {
  return probe.normalize({
    tasks: {
      total: 6,
      counts: { draft: 0, active: 1, done: 4, archived: 1, other: 0 },
      current: null,
      active: [{ id: 'T-A1', title: 'active one' }],
      recentDone: [],
      draft: [],
      trend: {
        from: '2026-10-22',
        to: '2026-11-04',
        days: 14,
        estimatedFrom: null,
        created: [0, 1, 0, 0, 2, 0, 0, 1, 0, 0, 0, 1, 0, 1],
        done: [1, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0],
        archived: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ...overrides,
      },
    },
  }).tasks;
}

const trendLines = (card) => collect(card, 'project-flow-trendLine');
const linePoints = (line) =>
  String(line.props.points)
    .split(' ')
    .filter(Boolean)
    .map((pair) => pair.split(',').map(Number));
const trendDayTitles = (card) =>
  collect(card, 'project-flow-trendDay').map((day) => {
    const title = (day.children || []).find((child) => child && child.type === 'title');
    return title ? String(title.children[0]) : '';
  });
const approxLines = (card) => trendLines(card).filter((line) => String(line.props.className).includes('project-flow-trendLine--approx'));

check('TasksCard: trend twin lines (created/done), shared peak, per-day hover titles and legend', () => {
  const card = mountTasks(trendTasks());
  const text = textOf(card);
  assert.ok(text.includes('近 14 天 · 新增 6 · 完成 4 · 归档 1'), 'trend summary missing: ' + text.slice(0, 200));
  assert.ok(text.includes('近 14 天 · 新增 6 · 完成 4'), 'the chart-level title is missing');

  const charts = collect(card, 'project-flow-trendChart');
  assert.equal(charts.length, 1, 'expected exactly one trend chart');
  assert.equal(charts[0].type, 'svg');
  assert.equal(charts[0].props.width, '100%');
  assert.equal(charts[0].props.height, 26, 'the band is 26 px tall');
  assert.equal(charts[0].props.viewBox, '0 0 14 26');
  assert.equal(charts[0].props.preserveAspectRatio, 'none');

  // Exactly two lines, one point per day, both flat at full opacity.
  const lines = trendLines(card);
  assert.equal(lines.length, 2, 'expected the created and done lines only');
  const createdLine = lines.find((line) => String(line.props.className).includes('project-flow-trendLineCreated'));
  const doneLine = lines.find((line) => String(line.props.className).includes('project-flow-trendLineDone'));
  assert.ok(createdLine && doneLine, 'both series need a polyline');
  for (const line of lines) {
    assert.equal(linePoints(line).length, 14, 'one point per day');
    assert.equal(line.props.opacity, 1, 'an exact series is fully opaque');
    assert.equal(line.props.strokeDasharray, undefined, 'an exact series is not dashed');
  }
  assert.equal(approxLines(card).length, 0, 'no dashed segment without estimatedFrom');

  // Shared peak = 2 (a created day), so the mapping is y = 25 - 12*v.
  const created = linePoints(createdLine);
  const done = linePoints(doneLine);
  assert.deepEqual(created[0], [0.5, 25], 'a zero value sits on the baseline');
  assert.deepEqual(created[4], [4.5, 1], 'the peak value reaches the 1 px top pad');
  assert.deepEqual(done[0], [0.5, 13], 'a done value of 1 lands at 25 - 12 = 13');
  assert.deepEqual(done[6], [6.5, 1]);
  assert.deepEqual(created[13], [13.5, 13], 'v=1 → 25 - 12 = 13');
  for (const [x, y] of created.concat(done)) {
    assert.ok(x >= 0 && x <= 14, 'points stay inside the viewBox: ' + x);
    assert.ok(y >= 1 && y <= 25, 'points stay inside the 1 px pads: ' + y);
  }

  // One mono-line dot per NON-ZERO day (5 created + 3 done), never on a zero.
  assert.equal(collect(card, 'project-flow-trendPoint').length, 8, 'dots only mark non-zero days');
  assert.equal(collect(card, 'project-flow-trendPointCreated').length, 5);
  assert.equal(collect(card, 'project-flow-trendPointDone').length, 3);
  const dotXs = collect(card, 'project-flow-trendPoint').map((dot) => dot.props.cx);
  assert.ok(!dotXs.includes(2.5), 'a zero day must not get a dot');

  // Hover: one transparent hit column per day with all three counters.
  const hits = collect(card, 'project-flow-trendDay');
  assert.equal(hits.length, 14, 'one hit column per day');
  for (const hit of hits) {
    assert.equal(hit.props.width, 1, 'each hit column is one day wide');
    assert.equal(hit.props.height, 26);
  }
  const titles = trendDayTitles(card);
  assert.equal(titles[0], '10-22 新增 0 · 完成 1 · 归档 0', 'the first day title must carry all three numbers');
  assert.equal(titles[4], '10-26 新增 2 · 完成 0 · 归档 0');
  for (const title of titles) assert.match(title, /新增 \d+ · 完成 \d+ · 归档 \d+/, 'every day needs the three counters');

  // Legend: two colour keys, both localized.
  const legend = collect(card, 'project-flow-trendLegendItem');
  assert.equal(legend.length, 2, 'the legend needs the created and done swatches');
  const legendText = legend.map((item) => textOf(item)).join('|');
  assert.ok(legendText.includes('新增') && legendText.includes('完成'), 'legend copy missing: ' + legendText);

  // The peak is per line, not per day total: 3 created + 3 done on one day must put
  // BOTH lines at the top (a summed peak would halve them).
  const both = mountTasks(trendTasks({ created: [3, ...new Array(13).fill(0)], done: [3, ...new Array(13).fill(0)] }));
  const bothLines = trendLines(both);
  const createdTop = linePoints(bothLines.find((line) => String(line.props.className).includes('Created')))[0];
  const doneTop = linePoints(bothLines.find((line) => String(line.props.className).includes('Done')))[0];
  assert.deepEqual(createdTop, [0.5, 1], 'a per-line peak must reach the top');
  assert.deepEqual(doneTop, [0.5, 1], 'both lines share that same peak');

  // Only the first and last dates are labelled.
  const axis = collect(card, 'project-flow-trendAxis');
  assert.equal(axis.length, 1);
  assert.deepEqual(axis[0].children.map((child) => child.children[0]), ['10-22', '11-04']);
});

check('TasksCard: the approximated tail is dashed at 60% and the summary gets ≈', () => {
  const card = mountTasks(trendTasks({ estimatedFrom: '2026-11-01' }));
  assert.equal(collect(card, 'project-flow-trendApprox').length, 1, 'the ≈ marker is missing');
  assert.ok(textOf(card).includes('≈'), 'the summary must show ≈ for an approximated segment');

  const lines = trendLines(card);
  const dashed = approxLines(card);
  assert.equal(lines.length, 4, 'each series splits into an exact and a dashed part');
  assert.equal(dashed.length, 2, 'both series need a dashed tail');
  for (const line of dashed) {
    assert.equal(line.props.opacity, 0.6, 'the approximated tail drops to 60%');
    assert.equal(line.props.strokeDasharray, '2 1.5', 'the approximated tail is dashed');
    const points = linePoints(line);
    assert.equal(points[0][0], 10.5, 'the dashed part starts at estimatedFrom (index 10)');
    assert.equal(points[points.length - 1][0], 13.5, 'and runs to the window tail');
  }
  for (const line of lines.filter((entry) => entry.props.opacity === 1)) {
    assert.equal(linePoints(line).length, 11, 'the exact part covers indexes 0..10 (shared cut point)');
  }
  // The cut is marked so the dashes read as a deliberate boundary, not a glitch.
  assert.equal(collect(card, 'project-flow-trendApproxPoint').length, 2, 'a boundary marker is expected per series');
  assert.ok(trendDayTitles(card)[10].includes('近似'), 'an approximated day title must say why');
  assert.ok(!trendDayTitles(card)[0].includes('近似'), 'an exact day must not claim approximation');
  assert.equal(
    approxLines(mountTasks(trendTasks())).length,
    0,
    'an exact series must not render a dashed segment'
  );
});

check('TasksCard: estimatedFrom boundaries — from covers the window, to marks only the last point', () => {
  const approxShape = (card) => ({
    exact: trendLines(card).filter((line) => line.props.opacity === 1).length,
    dashed: approxLines(card).length,
    dashedPoints: approxLines(card).map((line) => linePoints(line).length),
    markers: collect(card, 'project-flow-trendApproxPoint').length,
    hasApprox: collect(card, 'project-flow-trendApprox').length,
  });

  // estimatedFrom === from → the whole window is approximated: no solid lines at all.
  const all = approxShape(mountTasks(trendTasks({ estimatedFrom: '2026-10-22' })));
  assert.deepEqual(all, { exact: 0, dashed: 2, dashedPoints: [14, 14], markers: 0, hasApprox: 1 });
  assert.equal(approxLines(mountTasks(trendTasks({ estimatedFrom: '2026-10-22' })))[0].props.opacity, 0.6);

  // estimatedFrom === to → only the last point is approximated.
  const tailCard = mountTasks(trendTasks({ estimatedFrom: '2026-11-04' }));
  const tail = approxShape(tailCard);
  assert.equal(tail.exact, 2, 'both series stay solid up to the last day');
  assert.equal(tail.dashed, 2, 'the last point still needs a dashed marker segment');
  assert.deepEqual(tail.dashedPoints, [1, 1], 'a single approximated day is a one-point segment');
  assert.equal(tail.markers, 2);
  assert.equal(tail.hasApprox, 1);
  assert.equal(linePoints(trendLines(tailCard).find((line) => line.props.opacity === 1))[0][0], 0.5);

  // Before the window head: the whole window is the approximated segment.
  const before = approxShape(mountTasks(trendTasks({ estimatedFrom: '2026-10-01' })));
  assert.deepEqual(before, { exact: 0, dashed: 2, dashedPoints: [14, 14], markers: 0, hasApprox: 1 });
  // After the window tail: nothing in this window was approximated.
  const after = approxShape(mountTasks(trendTasks({ estimatedFrom: '2026-12-01' })));
  assert.deepEqual(after, { exact: 2, dashed: 0, dashedPoints: [], markers: 0, hasApprox: 0 });
});

check('TasksCard: estimatedFrom exactly one day past the tail stays unmarked (index === days)', () => {
  /* The off-by-one cell: `index >= days` must not silently become `> days`. */
  const edge = mountTasks(trendTasks({ estimatedFrom: '2026-11-05' }));
  assert.equal(trendLines(edge).length, 2, 'both series stay whole');
  assert.equal(approxLines(edge).length, 0, 'index === days must not add a dashed segment');
  assert.equal(collect(edge, 'project-flow-trendApproxPoint').length, 0, 'index === days must not add a marker');
  assert.equal(collect(edge, 'project-flow-trendApprox').length, 0, 'index === days must not add the ≈ marker');
  assert.ok(!textOf(edge).includes('≈'), 'index === days must not print ≈ in the summary');
});

check('normalize: trend numbers are coerced on purpose, but the shape stays strict', () => {
  // Numeric strings are accepted (documented tolerance — payload is our own snapshot).
  const loose = probe.normalize({
    tasks: {
      total: 1,
      counts: {},
      current: null,
      active: [],
      recentDone: [],
      draft: [],
      trend: { from: '2026-10-22', to: '2026-11-04', days: '14', created: new Array(14).fill(1), done: new Array(14).fill(0), archived: new Array(14).fill(0) },
    },
  }).tasks.trend;
  assert.ok(loose, 'a numeric-string days must still produce a trend');
  assert.equal(loose.days, 14, 'days must be coerced to a number');
  assert.deepEqual(loose.created, new Array(14).fill(1), 'series entries are coerced too');
  assert.deepEqual(loose.archived, new Array(14).fill(0));

  const reject = (trend) =>
    probe.normalize({ tasks: { total: 0, counts: {}, current: null, active: [], recentDone: [], draft: [], trend } }).tasks.trend;
  assert.equal(reject({ from: '2026-10-22', to: '2026-11-04', days: 'fourteen', created: [], done: [], archived: [] }), null);
  assert.equal(reject({ from: '2026-10-22', to: '2026-11-04', days: 0, created: [], done: [], archived: [] }), null);
  assert.equal(reject({ from: '2026-10-22', to: '2026-11-04', days: 401, created: [], done: [], archived: [] }), null);
  assert.equal(reject({ from: '2026-10-22', to: '2026-11-04', days: 1.5, created: [1], done: [0], archived: [0] }), null);
  assert.equal(
    reject({ from: '2026-10-22', to: '2026-11-04', days: 3, created: [1, 2], done: [0, 0, 0], archived: [0, 0, 0] }),
    null,
    'a mis-sized series must hide the row'
  );
});

check('TasksCard: no trend section for an older payload, placeholder for an all-zero window', () => {
  const legacy = probe.normalize({
    tasks: { total: 1, counts: { active: 1 }, current: null, active: [{ id: 'T-A1', title: 'a' }], recentDone: [], draft: [] },
  }).tasks;
  assert.equal(legacy.trend, null, 'a payload without trend normalizes to null');
  const card = mountTasks(legacy);
  assert.equal(collect(card, 'project-flow-trend').length, 0, 'an older payload must not render the trend row');
  assert.ok(!textOf(card).includes('近 14 天'), 'an older payload must not render the summary');

  const zero = mountTasks(trendTasks({ created: new Array(14).fill(0), done: new Array(14).fill(0), archived: new Array(14).fill(0) }));
  assert.equal(collect(zero, 'project-flow-trendChart').length, 0, 'an all-zero window must not draw bars');
  assert.equal(collect(zero, 'project-flow-trendEmpty').length, 1, 'an all-zero window needs the placeholder');
  assert.ok(textOf(zero).includes('暂无趋势'), 'the placeholder copy is missing');
  assert.ok(textOf(zero).includes('近 14 天 · 新增 0 · 完成 0 · 归档 0'), 'the zero summary is missing');

  // Malformed trend sections collapse to null instead of throwing.
  const broken = probe.normalize({ tasks: { total: 0, counts: {}, current: null, active: [], recentDone: [], draft: [], trend: { days: 3, created: [1] } } }).tasks;
  assert.equal(broken.trend, null, 'a mis-sized trend series must be dropped');
});

check('TasksCard: trend copy is locale-paired (en has no Chinese left)', () => {
  const english = mountTasks(trendTasks(), tEn);
  const text = textOf(english);
  assert.ok(text.includes('Last 14d · 6 new · 4 done · 1 archived'), 'en trend summary missing: ' + text.slice(0, 160));
  const trendText = collect(english, 'project-flow-trend').map((node) => textOf(node)).join('\n');
  assert.ok(!/[\u4e00-\u9fff]/.test(trendText), 'en trend block still contains Chinese');
  assert.ok(textOf(english).includes('10-22') && textOf(english).includes('11-04'), 'the axis labels are locale independent');
});

// ---------------------------------------- experiment area is opt-in (T-12 B3)
check('normalize: experiments.enabled is strict-true and the counts carry six states', () => {
  const withFlag = probe.normalize({ experiments: { enabled: true, total: 2, counts: { open: 2 }, items: [{ id: 'E-1' }], tree: [] } }).exp;
  assert.equal(withFlag.enabled, true, 'enabled:true must open the area');
  assert.equal(withFlag.total, 2);
  assert.equal(withFlag.items.length, 1);
  const closed = probe.normalize({ experiments: { enabled: false, counts: { open: 0 } } }).exp;
  assert.equal(closed.enabled, false, 'enabled:false must close the area');
  assert.deepEqual(closed.items, [], 'a closed payload ships no items');
  assert.deepEqual(closed.tree, [], 'a closed payload ships no tree');
  assert.equal(closed.total, 0);
  const missing = probe.normalize({ experiments: { counts: { open: 1 } } }).exp;
  assert.equal(missing.enabled, false, 'a payload without the flag must close the area');
  for (const state of ['open', 'confirmed', 'refuted', 'abandoned', 'inconclusive', 'pivoted']) {
    assert.equal(typeof withFlag.counts[state], 'number', `normalize must expose the six-state count ${state}`);
  }
});

check('ExperimentTree: folded by default, the fold target always exists, count chip carries the total', () => {
  const closed = renderWithState(probe.ExperimentTree, { exp: view.exp, t, now: NOW }, { reset: true });
  const toggles = collect(closed, 'project-flow-groupToggle');
  assert.equal(toggles.length, 1, 'expected exactly one section fold header');
  assert.equal(toggles[0].props['aria-expanded'], false, 'the tree must start folded');
  assert.equal(toggles[0].props['aria-controls'], 'project-flow-expTree');
  // The target element itself: a div with the controlled id, hidden while folded.
  const holder = (function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.props && node.props.id === 'project-flow-expTree') return node;
    for (const child of node.children || []) {
      const hit = Array.isArray(child) ? null : find(child);
      if (hit) return hit;
    }
    for (const child of node.children || []) {
      if (Array.isArray(child)) for (const entry of child) { const hit = find(entry); if (hit) return hit; }
    }
    return null;
  })(closed);
  assert.ok(holder, 'aria-controls target project-flow-expTree does not exist');
  assert.equal(holder.props.hidden, true, 'the folded tree container must be hidden');
  assert.equal(collect(closed, 'project-flow-row').length, 0, 'a folded tree renders no rows');
  const countChip = collect(closed, 'project-flow-groupCount')[0];
  assert.ok(countChip, 'the fold header needs a count chip');
  assert.equal(String(countChip.children[0]), view.exp.total + ' 条', 'the count chip must carry the experiment total');
});

check('ExperimentTree: expanding the section renders the tree, and the empty ledger keeps the guide', () => {
  const opened = openTree(view.exp);
  assert.ok(collect(opened, 'project-flow-row').length >= 1, 'expanding must reveal the rows');
  const empty = probe.normalize({}).exp;
  const emptyTree = renderWithState(probe.ExperimentTree, { exp: empty, t, now: NOW }, { reset: true });
  assert.equal(collect(emptyTree, 'project-flow-groupToggle').length, 0, 'an empty ledger needs no fold header');
  const text = JSON.stringify(emptyTree);
  assert.ok(text.includes('exp.empty') || text.includes('还没有实验记录'), 'empty guide title missing');
  assert.ok(text.includes('exp.emptyHint') || text.includes('flow exp add'), 'empty guide hint missing');
});

check('Panel wiring: the experiment card is opt-in, single column keeps the literal grid class', () => {
  const text = readFileSync(SRC, 'utf8');
  assert.ok(text.includes("className: 'project-flow-grid'"), 'the literal grid class must survive (single-column modifier is appended)');
  assert.ok(text.includes('project-flow-grid--single'), 'the single-column modifier class is missing');
  assert.ok(text.includes('view.exp.enabled === true'), 'the Panel does not gate the experiment card on the payload flag');
  const experiment = text.indexOf('ExperimentTree, { exp: view.exp');
  const tasks = text.indexOf('TasksCard, { tasks: view.tasks');
  assert.ok(experiment > 0 && tasks > 0 && experiment < tasks, 'the experiment card must mount before the task card (left column first)');
  // The modifier must win over the wide two-column rule.
  const single = text.indexOf('.project-flow-grid--single{');
  const wide = text.indexOf('.project-flow-grid{grid-template-columns:minmax(0,1.15fr)');
  assert.ok(single > 0, 'the single-column stylesheet rule is missing');
  assert.ok(wide > 0 && single > wide, 'the single-column rule must come after the two-column rule');
});

check('TasksCard: chips, current task, folded groups and one row per task', () => {
  const card = mountTasks(view.tasks);
  assert.equal(collect(card, 'project-flow-chip').length, 4, 'other chip should stay hidden at 0');
  const body = JSON.stringify(card);
  assert.ok(body.includes('T-20261028-56'), 'current task id missing');
  assert.ok(body.includes('client half'), 'current task title missing');
  // Groups: one draft, one active, three recent-done. Draft and recent start
  // folded, so the mount renders only the active preview.
  assert.equal(collect(card, 'project-flow-taskRow').length, 1, 'folded groups must not render rows');
  assert.deepEqual(groupOrder(card), ['active', 'draft', 'recentDone'], 'group order is not active -> draft -> recentDone');
  assert.equal(collect(card, 'project-flow-more').length, 2, 'each folded group must announce its hidden rows');
  const opened = toggleGroup(toggleGroup(card, 'draft', view.tasks), 'recentDone', view.tasks);
  assert.equal(collect(opened, 'project-flow-taskRow').length, 5, 'expanding must reveal every row');
  assert.equal(collect(opened, 'project-flow-gateMark--ok').length, 1);
  assert.equal(collect(opened, 'project-flow-gateMark--error').length, 1);
  // Rows themselves never leak an id or a commit before the detail opens.
  const rowText = collect(opened, 'project-flow-taskRow').map((row) => textOf(row)).join('\n');
  for (const hidden of ['T-D1', 'T-3', 'T-4', 'T-5', '12556a8']) {
    assert.ok(!rowText.includes(hidden), `collapsed rows must not show '${hidden}'`);
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
  const card = mountTasks(payload.tasks);
  // The queue-head line is the one deliberate place that names an id: it is the
  // task being worked on, not a row.
  assert.equal(collect(card, 'project-flow-queueId')[0].children[0], 'T-A9', 'queue head does not name the active id');
  const collapsedRowText = collect(card, 'project-flow-taskRow').map((row) => textOf(row)).join('\n');
  assert.ok(!collapsedRowText.includes('T-A9'), 'active row leaked its id');
  const opened = toggleGroup(card, 'draft', payload.tasks);
  const body = JSON.stringify(opened);
  const rowText = collect(opened, 'project-flow-taskRow').map((row) => textOf(row)).join('\n');
  assert.ok(!rowText.includes('T-D9'), 'draft row leaked its id');
  // The active group comes first, then the (now expanded) draft group.
  assert.deepEqual(
    collect(opened, 'project-flow-taskTitle').map((element) => element.children[0]),
    ['标题甲', '标题乙']
  );
  const goals = collect(opened, 'project-flow-taskGoal');
  assert.equal(goals.length, 1, 'a row without a goal must not reserve the second line');
  assert.equal(goals[0].children[0], '目标甲', 'goal missing from the second line');
  assert.equal(goals[0].props.title, '目标甲', 'goal needs a full-text tooltip');
  assert.ok(body.includes('"key":"T-D9"'), 'draft row key is not its business id');
  assert.ok(body.includes('"key":"T-A9"'), 'active row key is not its business id');
  assert.ok(textOf(opened).includes('负责人 alice'), 'owner meta missing');
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

check('TasksCard: the active group comes first, then the folded draft group', () => {
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

  const card = mountTasks(payload.tasks);
  const body = JSON.stringify(card);
  assert.ok(body.includes('待办（草稿）'), 'draft group header missing');
  assert.deepEqual(groupOrder(card), ['active', 'draft', 'recentDone'], 'group order is not active -> draft -> recentDone');
  assert.equal(groupToggle(card, 'draft').props['aria-expanded'], false, 'the draft group must start folded');
  assert.equal(groupToggle(card, 'active').props['aria-expanded'], true, 'the active group must start open');
  assert.equal(collect(card, 'project-flow-taskRow').length, 1, 'a folded draft group must not render rows');

  const opened = toggleGroup(card, 'draft', payload.tasks);
  assert.equal(groupToggle(opened, 'draft').props['aria-expanded'], true, 'the draft toggle did not expand');
  assert.equal(collect(opened, 'project-flow-taskRow').length, 3, 'expected one active + two expanded draft rows');
  assert.deepEqual(
    collect(opened, 'project-flow-taskTitle').map((element) => element.children[0]),
    ['active one', 'draft one', 'draft two'],
    'the active group must render before the draft group'
  );
  assert.deepEqual(
    collect(opened, 'project-flow-taskGoal').map((element) => element.children[0]),
    ['活动目标', '草稿一的目标'],
    'draft goals must render on the second line'
  );
  assert.ok(textOf(opened).includes('负责人 alice'), 'draft owner missing');
  const draftRowText = collect(opened, 'project-flow-taskRow').map((row) => textOf(row)).join('\n');
  assert.ok(!draftRowText.includes('T-D1'), 'a draft row must not show its id by default');

  const english = toggleGroup(mountTasks(payload.tasks, tEn), 'draft', payload.tasks, tEn);
  // Data (the user's Chinese goals/titles) may be Chinese; the chrome must not be.
  const englishText = textOf(english)
    .split('草稿一的目标').join('')
    .split('活动目标').join('')
    .split('draft one').join('')
    .split('draft two').join('')
    .split('active one').join('');
  assert.ok(englishText.includes('Todo (drafts)'), 'en draft group header missing');
  assert.ok(englishText.includes('owner alice'), 'en owner meta missing');
  assert.ok(!/[\u4e00-\u9fff]/.test(englishText), 'en draft group still contains Chinese');
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
  const card = mountTasks(payload.tasks);
  const body = JSON.stringify(card);
  assert.ok(!body.includes('待办（草稿）'), 'empty draft section must not render');
  assert.equal(groupOrder(card).includes('draft'), false, 'an empty draft group must not render a header');
  assert.equal(collect(card, 'project-flow-taskRow').length, 1, 'only the active preview renders while recent is folded');
  assert.equal(
    collect(toggleGroup(card, 'recentDone', payload.tasks), 'project-flow-taskRow').length,
    2,
    'expanding recent must reveal the second row'
  );

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
  const card = mountTasks(payload.tasks);
  // Folded with 30 drafts: no rows, but the hidden count is announced (never a
  // silent cut).
  assert.equal(collect(card, 'project-flow-taskRow').length, 0, 'a folded group must not render rows');
  assert.ok(JSON.stringify(card).includes('还有 30 条未显示'), 'folded overflow not announced');

  const opened = toggleGroup(card, 'draft', payload.tasks);
  assert.equal(collect(opened, 'project-flow-taskRow').length, 25, 'draft rows must cap at 25');
  const body = JSON.stringify(opened);
  assert.ok(body.includes('draft 25'), 'last visible draft row missing');
  assert.ok(!body.includes('draft 26'), 'a 26th draft row leaked through');
  assert.ok(body.includes('还有 5 条未显示'), 'draft overflow copy missing');
  assert.equal(collect(opened, 'project-flow-more').length, 1, 'overflow line missing');

  const english = toggleGroup(mountTasks(payload.tasks, tEn), 'draft', payload.tasks, tEn);
  const englishText = JSON.stringify(english);
  assert.ok(englishText.includes('5 more not shown'), 'en overflow copy missing');
  assert.ok(!/[\u4e00-\u9fff]/.test(englishText), 'en overflow copy still contains Chinese');
});

// ---------------------------------------- task card: queue view (T-08 卡 A)
check('TasksCard: 50+ tasks keep the task card inside a 12-row first screen', () => {
  const rows = (prefix, length) =>
    Array.from({ length }, (_, index) => ({ id: prefix + String(index + 1).padStart(2, '0'), title: prefix + ' ' + (index + 1) }));
  const payload = probe.normalize({
    tasks: {
      total: 58,
      counts: { active: 25, draft: 25, done: 8 },
      current: null,
      active: rows('A', 25),
      draft: rows('D', 25),
      recentDone: rows('R', 8),
    },
  });
  const card = mountTasks(payload.tasks);
  const firstScreen = collect(card, 'project-flow-taskRow').length;
  assert.ok(firstScreen <= 12, `first screen renders ${firstScreen} task rows (> 12)`);
  assert.equal(firstScreen, 6, 'the active group should open on exactly the preview row count');
  const body = JSON.stringify(card);
  assert.ok(body.includes('还有 19 条未显示'), 'active overflow (25-6) not announced');
  assert.ok(body.includes('还有 25 条未显示'), 'folded draft overflow not announced');
  assert.ok(body.includes('还有 8 条未显示'), 'folded recent overflow not announced');
  // Counts are never lost: the chips still come from the payload counts.
  assert.equal(collect(card, 'project-flow-chip').length, 4);
  assert.ok(body.includes('25 进行中'), 'active chip count drifted');
});

check('TasksCard: the fold state is keyed by group name and survives a poll refresh', () => {
  const build = (reverse) => {
    const active = [
      { id: 'T-A1', title: 'active one' },
      { id: 'T-A2', title: 'active two' },
    ];
    const draft = [
      { id: 'T-D1', title: 'draft one' },
      { id: 'T-D2', title: 'draft two' },
    ];
    return probe.normalize({
      tasks: {
        total: 4,
        counts: { active: 2, draft: 2 },
        current: null,
        active: reverse ? active.slice().reverse() : active,
        draft: reverse ? draft.slice().reverse() : draft,
        recentDone: [],
      },
    }).tasks;
  };
  const first = build(false);
  const card = mountTasks(first);
  // 2 active rows preview + 2 folded drafts.
  assert.equal(collect(card, 'project-flow-taskRow').length, 2, 'the folded draft group must not render rows');

  const opened = toggleGroup(card, 'draft', first);
  assert.equal(collect(opened, 'project-flow-taskRow').length, 4, 'the draft group did not expand');

  // A poll refresh hands the component a NEW payload with reordered rows: the
  // fold state must follow the group NAME, so it stays open.
  const refreshed = build(true);
  const afterPoll = renderWithState(probe.TasksCard, { tasks: refreshed, t, now: NOW });
  assert.equal(groupToggle(afterPoll, 'draft').props['aria-expanded'], true, 'the fold state was lost on refresh');
  assert.equal(collect(afterPoll, 'project-flow-taskRow').length, 4, 'row count changed after refresh');

  const closed = toggleGroup(afterPoll, 'draft', refreshed);
  assert.equal(groupToggle(closed, 'draft').props['aria-expanded'], false, 'the draft group did not collapse');
  assert.equal(collect(closed, 'project-flow-taskRow').length, 2, 'collapsed draft must render only the 2 active rows');
  const afterSecondPoll = renderWithState(probe.TasksCard, { tasks: build(false), t, now: NOW });
  assert.equal(groupToggle(afterSecondPoll, 'draft').props['aria-expanded'], false, 'a collapsed group reopened on refresh');
});

check('TasksCard: active overflow announces the hidden rows instead of truncating', () => {
  const active = Array.from({ length: 40 }, (_, index) => ({ id: 'A' + String(index + 1).padStart(2, '0'), title: 'active ' + (index + 1) }));
  const tasks = probe.normalize({ tasks: { total: 40, counts: { active: 40 }, current: null, active, recentDone: [] } }).tasks;
  const card = mountTasks(tasks);
  assert.equal(collect(card, 'project-flow-taskRow').length, 6, 'active preview drifted');
  assert.ok(JSON.stringify(card).includes('还有 34 条未显示'), 'active overflow copy missing (silent truncation)');
  const opened = toggleGroup(card, 'active', tasks);
  assert.equal(collect(opened, 'project-flow-taskRow').length, 25, 'expanded active must cap at MAX_LIST_ROWS');
  assert.ok(JSON.stringify(opened).includes('还有 15 条未显示'), 'expanded active overflow copy missing');
});

check('TasksCard: empty groups keep every aria-controls target resolvable', () => {
  // Empty is a normal state (nothing in progress, nothing completed yet). The
  // toggle must never point at an id that does not exist in the tree.
  const empty = mountTasks(probe.normalize({}).tasks);
  const toggles = collect(empty, 'project-flow-groupToggle');
  assert.ok(toggles.length >= 2, 'the active and recent groups must render even when empty');
  const lists = collect(empty, 'project-flow-taskList');
  for (const toggle of toggles) {
    const target = toggle.props['aria-controls'];
    assert.ok(target, 'a group toggle lost its aria-controls');
    assert.ok(
      lists.some((element) => element.props.id === target),
      `empty group aria-controls target ${target} does not exist (dangling reference)`
    );
  }
  assert.equal(collect(empty, 'project-flow-taskRow').length, 0, 'an empty ledger must render no rows');
  // Same guarantee when only the recent group is empty but active has a row.
  const onlyActive = mountTasks(probe.normalize({ tasks: { total: 1, counts: { active: 1 }, current: null, active: [{ id: 'T-A1', title: 'a' }], recentDone: [] } }).tasks);
  const activeLists = collect(onlyActive, 'project-flow-taskList');
  for (const toggle of collect(onlyActive, 'project-flow-groupToggle')) {
    const target = toggle.props['aria-controls'];
    assert.ok(activeLists.some((element) => element.props.id === target), `dangling aria-controls: ${target}`);
  }
});

check('TasksCard: PROBE-A — a group appearing later must not lose the fold state', () => {
  // Regression guard for "fold state keyed by render order" mutants: the old
  // payload has no draft group at all, so recentDone sits at render index 1; the
  // next poll adds the draft group and pushes recentDone to index 2. A state
  // keyed by index would silently re-collapse it.
  const before = probe.normalize({
    tasks: {
      total: 3,
      counts: { active: 1, done: 2 },
      current: null,
      active: [{ id: 'T-A1', title: 'active one' }],
      recentDone: [
        { id: 'T-R1', title: 'done one', gate: 'pass' },
        { id: 'T-R2', title: 'done two', gate: 'fail' },
      ],
    },
  }).tasks;
  assert.equal(before.draft.length, 0, 'the old payload must have no draft group');

  const card = mountTasks(before);
  assert.deepEqual(groupOrder(card), ['active', 'recentDone'], 'a payload without drafts renders two groups');
  const opened = toggleGroup(card, 'recentDone', before);
  assert.equal(groupToggle(opened, 'recentDone').props['aria-expanded'], true, 'recent group did not expand');
  assert.equal(collect(opened, 'project-flow-taskRow').length, 3, 'expected 1 active + 2 recent rows');

  // Next poll: a draft group shows up in the middle of the render order.
  const after = probe.normalize({
    tasks: {
      total: 4,
      counts: { active: 1, draft: 1, done: 2 },
      current: null,
      active: [{ id: 'T-A1', title: 'active one' }],
      draft: [{ id: 'T-D1', title: 'draft one' }],
      recentDone: [
        { id: 'T-R1', title: 'done one', gate: 'pass' },
        { id: 'T-R2', title: 'done two', gate: 'fail' },
      ],
    },
  }).tasks;
  const refreshed = renderWithState(probe.TasksCard, { tasks: after, t, now: NOW });
  assert.deepEqual(groupOrder(refreshed), ['active', 'draft', 'recentDone'], 'group order changed unexpectedly');
  assert.equal(
    groupToggle(refreshed, 'recentDone').props['aria-expanded'],
    true,
    'PROBE-A: the recent group re-collapsed when a new group appeared ahead of it (state keyed by render index)'
  );
  assert.equal(
    collect(refreshed, 'project-flow-taskRow').length,
    3,
    'PROBE-A: expected 1 active + 2 recent rows (the new draft group is folded)'
  );
  assert.equal(groupToggle(refreshed, 'draft').props['aria-expanded'], false, 'the new draft group must start folded');
});

check('TasksCard: the queue head names the first active row and degrades when empty', () => {
  const tasks = probe.normalize({
    tasks: { total: 2, counts: { active: 1 }, current: null, active: [{ id: 'T-Q1', title: '队首任务' }], recentDone: [] },
  }).tasks;
  const card = mountTasks(tasks);
  assert.equal(collect(card, 'project-flow-queueId')[0].children[0], 'T-Q1', 'the queue head must name the first active id');
  assert.equal(collect(card, 'project-flow-queueTitle')[0].children[0], '队首任务', 'the queue head must show the active title');
  const empty = mountTasks(probe.normalize({ tasks: { total: 0, counts: {}, current: null, active: [], recentDone: [] } }).tasks);
  assert.equal(collect(empty, 'project-flow-queueId').length, 0, 'an empty queue must not render an id');
  assert.ok(textOf(empty).includes('暂无进行中任务'), 'the empty queue copy is missing');
});

check('TasksCard: group toggles are real buttons with aria-expanded and aria-controls', () => {
  const card = mountTasks(view.tasks);
  const toggles = collect(card, 'project-flow-groupToggle');
  assert.equal(toggles.length, 3, 'expected one toggle per rendered group');
  for (const toggle of toggles) {
    assert.equal(toggle.type, 'button', 'a group toggle must be a <button>');
    assert.equal(toggle.props.type, 'button', 'a group toggle must not submit a form');
    assert.equal(typeof toggle.props.onClick, 'function', 'a group toggle has no click handler');
    assert.equal(typeof toggle.props['aria-expanded'], 'boolean', 'a group toggle is missing aria-expanded');
    const target = toggle.props['aria-controls'];
    assert.ok(target, 'a group toggle is missing aria-controls');
    const list = collect(card, 'project-flow-taskList').find((element) => element.props.id === target);
    assert.ok(list, `aria-controls target ${target} does not exist`);
  }
  const chevron = (node, group) => collect(groupToggle(node, group), 'project-flow-groupChevron')[0].children[0];
  assert.equal(chevron(card, 'draft'), '\u25B8', 'a folded group must show the closed chevron');
  assert.equal(chevron(toggleGroup(card, 'draft', view.tasks), 'draft'), '\u25BE', 'an expanded group must show the open chevron');
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
    openTree(v.exp),
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
