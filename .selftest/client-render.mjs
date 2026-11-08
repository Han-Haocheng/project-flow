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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addTask as addTaskCore, initProject, loadContract } from '../lib/core.mjs';

/** T-15 fixtures: default type unless the call supplies one. */
function addTask(root, contract, input = {}, options) {
  return addTaskCore(root, contract, { type: 'feat', ...input }, options);
}
import { buildSnapshot, legacyExperimentsWarning } from '../lib/state-snapshot.mjs';

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
  "    return {\n      __probe: { zh, en, normalize, PanelView, readDisplayPrefs, writeDisplayPrefs, cardCollapsed, FoldCard, DisplayBar, DisplayRow: DisplayBar, Panel, PanelRoot, PanelBody, PanelTitle, HeaderAction, ExperimentTree, TasksCard, TaskRow, TaskDetail, GatesCard, SignalsCard, TopBar, Footer, ErrorState, DetailBlock, PanelIcon, PanelGlyph, relativeFromSeconds, ageText, runPanel: Panel, CSS, DecisionsCard, normalizeDecisions, decisionAnswerCommand },\n      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],";

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
  contract: { source: '.agents/flow/flow.json', schema: 2, name: 'demo-alpha' },
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
        type: 'feat',
        title: 'active task',
        status: 'active',
        owner: 'coord',
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
  assert.equal(view.contract.source, '.agents/flow/flow.json');
  assert.equal(view.contract.schema, 2);
  assert.equal(view.exp.total, 3);
  assert.equal(view.exp.items.length, 3);
  assert.equal(view.exp.tree.length, 2);
  assert.equal(view.exp.open, 1);
  assert.equal(view.exp.confirmed, 1);
  assert.equal(view.exp.refuted, 1);
  assert.equal(view.tasks.counts.done, 28);
  assert.equal(view.tasks.counts.other, 0);
  // Task rows carry their type plus every detail field in all three groups.
  const active = view.tasks.active[0];
  assert.equal(active.type, 'feat');
  assert.equal(active.title, 'active task');
  assert.equal(active.notes, '展开详情里的备注');
  assert.deepEqual(active.scope, { allow: ['client.js', 'index.js'], deny: ['lib/'] });
  assert.deepEqual(active.acceptance, ['node --check client.js', 'node .selftest/client-render.mjs']);
  assert.deepEqual(active.commits, ['f5f176bc']);
  assert.equal(active.created_at, '2026-10-28T08:00:00+08:00');
  /* A legacy row without `type` degrades to the empty string, never to null. */
  assert.equal(view.tasks.draft[0].type, '');
  assert.deepEqual(view.tasks.draft[0].scope, { allow: ['README.md'], deny: [] });
  assert.equal(view.tasks.recentDone[0].type, '');
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
  assert.equal(hostile.tasks.recentDone[0].type, '');
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
  const dynamic = ['tasks.status.', 'gates.phase.', 'hb.status.', 'tasks.stage.'];
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

// ---------------------------------------------------- task tree (T-13 A3)
/** A→B→C chain in the active group, plus a cross-group child and a draft parent. */
function treeTasks(overrides = {}) {
  return probe.normalize({
    tasks: {
      total: 5,
      counts: { draft: 1, active: 4, done: 1, archived: 0, other: 0 },
      current: 'T-A',
      active: [
        /* task-71: stages drive the buckets; A/B/C/X sit in the open 待办 bucket,
           D sits in 分析中 (folded) so X keeps the cross-group badge case. */
        { id: 'T-A', title: 'A 根任务', status: 'active', stage: 'created', parent: null, depth: 0 },
        { id: 'T-B', title: 'B 子任务', status: 'active', stage: 'created', parent: 'T-A', depth: 1 },
        { id: 'T-C', title: 'C 孙任务', status: 'active', stage: 'created', parent: 'T-B', depth: 2 },
        { id: 'T-X', title: 'X 跨组任务', status: 'active', stage: 'created', parent: 'T-D', depth: 1 },
      ],
      draft: [{ id: 'T-D', title: 'D 草稿任务', status: 'draft', stage: 'analyzing', parent: null, depth: 0 }],
      recentDone: [{ id: 'T-E', title: 'E 完成', status: 'done', stage: 'done', parent: null, depth: 0 }],
      ...overrides,
    },
  }).tasks;
}

/* `textOf(row)` walks the whole subtree, so a parent row also "contains" its
   children's text. Identify a row by its own title instead. */
const rowTitleOf = (row) => {
  const title = collect(row, 'project-flow-taskTitle')[0];
  return title ? textOf(title) : '';
};
const rowOf = (card, title) => collect(card, 'project-flow-taskRow').find((row) => rowTitleOf(row) === title);

const caretOf = (card, controlsId) =>
  collect(card, 'project-flow-taskCaret').find((button) => button.props['aria-controls'] === controlsId);

check('TasksCard tree: A→B→C nest with 12px indent, connector class and aria-level, capped at 4', () => {
  const card = mountTasks(treeTasks());
  const rows = () => collect(card, 'project-flow-taskRow');
  // Default: one level open → A and its child B render, B's child C stays folded.
  assert.equal(rows().length, 3, 'the default shows the root plus one level (A, B, X)');
  assert.ok(rows().some((row) => textOf(row).includes('A 根任务')));
  assert.ok(rows().some((row) => textOf(row).includes('B 子任务')));
  assert.ok(!rows().some((row) => textOf(row).includes('C 孙任务')), 'a depth-2 row starts folded');

  const a = rowOf(card, 'A 根任务');
  const b = rowOf(card, 'B 子任务');
  assert.equal(a.props['aria-level'], 1, 'the root is level 1');
  assert.equal(a.props['data-depth'], 0);
  assert.equal(String(a.props.className).includes('project-flow-taskNested'), false, 'a root is not indented');
  assert.equal(b.props['aria-level'], 2, 'a child is level 2');
  assert.equal(b.props['data-depth'], 1);
  assert.equal(String(b.props.className).includes('project-flow-taskNested'), true, 'a child must be indented');
  assert.equal(b.props.style['--d'], 1, 'the indents step is 12px per level (CSS uses --d * 12px)');

  // The connector/indent rules exist and are 12px based.
  assert.ok(source.includes('.project-flow-taskNested{padding-left:calc(var(--d,1) * 12px)'), 'indent rule missing');
  assert.ok(source.includes('.project-flow-taskChildren{'), 'child list rule missing');
  /* Pin each rule on its own: a single `source.includes(...)` lets one of the two
     connector rules silently drop to l1 while the other keeps the assertion green
     (task-183 M2b). Each block is matched inside its own selector, never across. */
  /* A selector may appear in several rules (the control-row buttons share one
     combined border rule, then override colour in a second rule), so collect
     every enclosing rule body for the selector and require each body that
     declares a border to use l2. Matching the first `selector{` hit would pick
     the colour-only rule and miss a silenced connector (task-183 M2b). */
  const ruleBodies = (selector) => {
    const bodies = [];
    let index = source.indexOf(selector);
    while (index >= 0) {
      const open = source.indexOf('{', index);
      const end = open >= 0 ? source.indexOf('}', open) : -1;
      const between = open >= 0 ? source.slice(index + selector.length, open) : '}';
      const isOwnRule = open >= 0 && end > open && !/[{}]/.test(between);
      if (isOwnRule) bodies.push(source.slice(open, end));
      index = source.indexOf(selector, index + selector.length);
    }
    assert.ok(bodies.length > 0, 'missing rule: ' + selector);
    return bodies;
  };
  for (const [selector, label] of [
    ['.project-flow-taskNested', 'the nested row connector'],
    ['.project-flow-taskChildren', 'the child list connector'],
    ['.project-flow-displayAll', 'the control-row button border'],
  ]) {
    const bordered = ruleBodies(selector).filter((body) => /border/.test(body));
    assert.ok(bordered.length > 0, label + ' declares no border rule');
    for (const body of bordered) {
      assert.match(body, /border(-left)?:1px solid var\(--dsw-alias-border-l2\)/, label + ' must use border-l2 inside its own rule');
      assert.ok(!/--dsw-alias-border-l(?!\d)/.test(body), label + ' must not use the removed bare border-l');
    }
  }

  // Expanding B reveals C at the next level; the child <ul> is a group.
  const bCaret = caretOf(card, 'project-flow-taskChildren-T-B');
  assert.ok(bCaret, 'B needs a caret');
  assert.equal(bCaret.props['aria-expanded'], false, 'B starts folded');
  bCaret.props.onClick({ stopPropagation() {} });
  const opened = renderWithState(probe.TasksCard, { tasks: treeTasks(), t, now: NOW });
  assert.ok(collect(opened, 'project-flow-taskRow').some((row) => textOf(row).includes('C 孙任务')), 'C must appear');
  const c = rowOf(opened, 'C 孙任务');
  assert.equal(c.props['aria-level'], 3);
  const groups = collect(opened, 'project-flow-taskChildren').filter((list) => list.props.role === 'group');
  assert.ok(groups.length >= 2, 'nested lists carry role=group');

  // Depth is visually capped at 3 → aria-level never exceeds 4.
  const deep = mountTasks(
    treeTasks({
      active: [
        { id: 'D0', title: 'd0', status: 'active', parent: null, depth: 0 },
        { id: 'D1', title: 'd1', status: 'active', parent: 'D0', depth: 1 },
        { id: 'D2', title: 'd2', status: 'active', parent: 'D1', depth: 2 },
        { id: 'D3', title: 'd3', status: 'active', parent: 'D2', depth: 3 },
        { id: 'D4', title: 'd4', status: 'active', parent: 'D3', depth: 4 },
      ],
      counts: { draft: 0, active: 5, done: 0, archived: 0, other: 0 },
    })
  );
  for (const caret of collect(deep, 'project-flow-taskCaret')) {
    if (caret.props['aria-expanded'] === false) caret.props.onClick({ stopPropagation() {} });
  }
  let levels = collect(deep, 'project-flow-taskRow').map((row) => row.props['aria-level']);
  assert.ok(levels.length > 0);
  for (const level of levels) assert.ok(level >= 1 && level <= 4, 'aria-level stays inside 1..4, got ' + level);
});

check('TasksCard tree: a cross-group child becomes a root row with a 父在…badge', () => {
  const card = mountTasks(treeTasks());
  const x = rowOf(card, 'X 跨组任务');
  assert.ok(x, 'a cross-group child must still render');
  assert.equal(x.props['aria-level'], 1, 'it stays a root row, it is not nested');
  assert.equal(x.props['data-depth'], 0);
  const badge = collect(x, 'project-flow-taskBadge')[0];
  assert.ok(badge, 'the badge is missing');
  assert.equal(textOf(badge), '父在分析中', 'the badge must name the parent stage group: ' + textOf(badge));

  // A parent that is not in the payload at all reads as archived.
  const orphan = mountTasks(
    treeTasks({ active: [{ id: 'T-Z', title: 'Z 孤儿', status: 'active', parent: 'T-GONE', depth: 1 }] })
  );
  const z = collect(orphan, 'project-flow-taskRow')[0];
  assert.equal(textOf(collect(z, 'project-flow-taskBadge')[0]), '父在已完成');
});

check('TasksCard tree: the parent caret does not steal the row click (detail stays closed)', () => {
  const card = mountTasks(treeTasks());
  const rowA = rowOf(card, 'A 根任务');
  const headOfA = collect(rowA, 'project-flow-taskHead')[0];
  const caret = collect(rowA, 'project-flow-taskCaret')[0];
  assert.ok(caret, 'the root parent needs a caret');

  // Simulate a bubbling click: the caret must stop propagation, so the head's
  // detail toggle never runs.
  let stopped = false;
  caret.props.onClick({ stopPropagation: () => { stopped = true; } });
  if (!stopped) headOfA.props.onClick({});
  const after = renderWithState(probe.TasksCard, { tasks: treeTasks(), t, now: NOW });
  assert.equal(stopped, true, 'the caret click must call stopPropagation');
  assert.equal(collect(after, 'project-flow-taskDetail').length, 0, 'the caret must not open the task detail');
  // The caret collapsed A instead: its child list is hidden and the child rows go away.
  const aAfter = rowOf(after, 'A 根任务');
  assert.equal(collect(aAfter, 'project-flow-taskCaret')[0].props['aria-expanded'], false, 'the caret collapses the subtree');
  const listAfter = collect(after, 'project-flow-taskChildren').find((list) => list.props.id === 'project-flow-taskChildren-T-A');
  assert.equal(listAfter.props.hidden, true, 'a collapsed subtree hides its list');
  assert.equal(rowOf(after, 'B 子任务'), undefined, 'a collapsed child is not rendered');
  // Re-opening restores the child at its level.
  collect(aAfter, 'project-flow-taskCaret')[0].props.onClick({ stopPropagation() {} });
  const reopenedTree = renderWithState(probe.TasksCard, { tasks: treeTasks(), t, now: NOW });
  assert.equal(rowOf(reopenedTree, 'B 子任务').props['aria-level'], 2, 're-opening restores the nesting');

  // The row head itself still opens the detail.
  const reopened = renderWithState(probe.TasksCard, { tasks: treeTasks(), t, now: NOW }, { reset: true });
  const head2 = collect(rowOf(reopened, 'A 根任务'), 'project-flow-taskHead')[0];
  head2.props.onClick({});
  const detailed = renderWithState(probe.TasksCard, { tasks: treeTasks(), t, now: NOW });
  assert.equal(collect(detailed, 'project-flow-taskDetail').length, 1, 'the row head must open the detail');
});

check('TasksCard tree: the fold state is keyed by task id and survives a reordered poll', () => {
  const first = renderWithState(probe.TasksCard, { tasks: treeTasks(), t, now: NOW }, { reset: true });
  caretOf(first, 'project-flow-taskChildren-T-B').props.onClick({ stopPropagation() {} });
  const opened = renderWithState(probe.TasksCard, { tasks: treeTasks(), t, now: NOW });
  assert.ok(collect(opened, 'project-flow-taskRow').some((row) => textOf(row).includes('C 孙任务')), 'C must be open');

  // Same rows, reversed order: the id-keyed state must keep C visible.
  const reversed = treeTasks();
  reversed.active = reversed.active.slice().reverse();
  const after = renderWithState(probe.TasksCard, { tasks: reversed, t, now: NOW });
  assert.ok(
    collect(after, 'project-flow-taskRow').some((row) => textOf(row).includes('C 孙任务')),
    'the subtree must stay open after a reorder'
  );
  const bRow = rowOf(after, 'B 子任务');
  assert.equal(collect(bRow, 'project-flow-taskCaret')[0].props['aria-expanded'], true, 'B stays expanded');
});

check('TasksCard tree: the preview budget counts rendered rows, child rows included', () => {
  const previewTasks = treeTasks({
      counts: { draft: 0, active: 7, done: 0, archived: 0, other: 0 },
      active: [
        { id: 'P0', title: 'p0 根', status: 'active', parent: null, depth: 0 },
        { id: 'P1', title: 'p1 子', status: 'active', parent: 'P0', depth: 1 },
        { id: 'P2', title: 'p2 子', status: 'active', parent: 'P0', depth: 1 },
        { id: 'P3', title: 'p3 子', status: 'active', parent: 'P0', depth: 1 },
        { id: 'P4', title: 'p4 子', status: 'active', parent: 'P0', depth: 1 },
        { id: 'P5', title: 'p5 根', status: 'active', parent: null, depth: 0 },
        { id: 'P6', title: 'p6 根', status: 'active', parent: null, depth: 0 },
      ],
  });
  const flat = mountTasks(previewTasks);
  const rows = collect(flat, 'project-flow-taskRow');
  assert.equal(rows.length, 6, 'the preview shows exactly six rendered rows (parent + children)');
  assert.ok(rows.some((row) => textOf(row).includes('p1 子')), 'child rows count toward the budget');
  const activeGroup = collect(flat, 'project-flow-group').find((group) => group.props.key === 'todo');
  const more = collect(activeGroup, 'project-flow-more');
  assert.equal(more.length, 1, 'the overflow line is missing');
  assert.equal(textOf(more[0]), '还有 1 条未显示');
  // Expanding the group lifts the preview and renders everything.
  const opened = toggleGroup(flat, 'todo', previewTasks);
  assert.equal(collect(opened, 'project-flow-taskRow').length, 7, 'expanding lifts the preview to every row');
});

check('TasksCard tree: an older payload without parent renders flat (no caret, no badge)', () => {
  const legacy = probe.normalize({
    tasks: {
      total: 2,
      counts: { active: 2 },
      current: 'T-1',
      active: [
        { id: 'T-1', title: '旧任务一', status: 'active' },
        { id: 'T-2', title: '旧任务二', status: 'active' },
      ],
    },
  }).tasks;
  assert.equal(legacy.active[0].parent, null, 'a missing parent must normalize to null');
  const card = mountTasks(legacy);
  const rows = collect(card, 'project-flow-taskRow');
  assert.equal(rows.length, 2, 'both legacy rows render');
  for (const row of rows) {
    assert.equal(row.props['aria-level'], 1, 'legacy rows stay at level 1');
    assert.equal(String(row.props.className).includes('project-flow-taskNested'), false);
    assert.equal(collect(row, 'project-flow-taskCaret').length, 0, 'no caret without children');
    assert.equal(collect(row, 'project-flow-taskBadge').length, 0, 'no badge without a parent');
  }
});

// ------------------------------------- PanelView: switches, folds, no writes
//
// `PanelView` is the data-state body of the panel, split out of `Panel` so it can
// be mounted without the polling effect. These checks click the real control row
// and assert: a switch removes exactly its own card, 「全部收起」wins over a
// per-card caret, the preferences survive a remount, and nothing — switch, fold or
// remount — performs a network call or writes a byte.
const FIXTURE_STORE = fileURLToPath(new URL('./state-store.json', import.meta.url));

/** The captured Host payload plus a trend section (captured before the trend existed). */
function panelViewPayload() {
  const payload = JSON.parse(readFileSync(FIXTURE_STORE, 'utf8'));
  payload.experiments = Object.assign({}, payload.experiments, { enabled: true });
  /* task-71: stage annotations turn the fixture into three stage buckets:
     待办 (the draft row), 实现中 (the active row), 已完成 (recentDone). */
  payload.tasks = Object.assign({}, payload.tasks, {
    active: (payload.tasks.active || []).map((row) => Object.assign({}, row, { stage: 'implementing' })),
    draft: (payload.tasks.draft || []).map((row) => Object.assign({}, row, { stage: 'created' })),
    recentDone: (payload.tasks.recentDone || []).map((row) => Object.assign({}, row, { stage: 'done' })),
    trend: {
      from: '2026-10-22',
      to: '2026-11-04',
      days: 14,
      estimatedFrom: null,
      created: [0, 1, 0, 0, 2, 0, 0, 1, 0, 0, 0, 1, 0, 1],
      done: [1, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0],
      archived: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  });
  return payload;
}

function panelViewProps(view, extra = {}) {
  return Object.assign({ view, t, now: NOW, workspaceRoot: '/tmp/pf-view', sessionId: 'view-session' }, extra);
}

const cardTitleTexts = (tree) => collect(tree, 'project-flow-cardTitle').map((title) => textOf(title));
const PREF_KEY = (view) => 'project-flow.display:' + String((view && view.root) || '');
const bodyHidden = (tree) => collect(tree, 'project-flow-cardBody').map((body) => body.props.hidden === true);

// --------------------------- contrast + aria + per-root state (task-185)
/** WCAG relative luminance for a #rrggbb colour. */
function contrastRatio(foreground, background) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const rgb = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const lum = (hex) => {
    const [r, g, b] = rgb(hex).map(channel);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(foreground), lum(background)].sort((left, right) => right - left);
  return (hi + 0.05) / (lo + 0.05);
}

check('CSS: the plugin-local ok/warn/error text tokens clear WCAG on both themes', () => {
  /* Host values measured in task-178 (theme: body / body[data-ds-dark-theme]):
     state-success #22c55e, state-warn #f59e0b, state-error #ec1313 (light) /
     #f25a5a (dark); light label #0f1115 / secondary #61666b, dark label #f9fafb
     / secondary #cfd3d6; chip background = bg-layer-2 (#ffffff / #2c2c2e). */
  const okSource = /--project-flow-ok-text\s*:\s*color-mix\(in srgb, var\(--dsw-alias-state-success-primary\) (\d+)%, var\(--dsw-alias-label-primary\)\)/;
  const warnSource = /--project-flow-warn-text\s*:\s*color-mix\(in srgb, var\(--dsw-alias-state-warn-primary\) (\d+)%, var\(--dsw-alias-label-primary\)\)/;
  const errorSource = /--project-flow-error-text\s*:\s*color-mix\(in srgb, var\(--dsw-alias-state-error-primary\) (\d+)%, var\(--dsw-alias-label-primary\)\)/;
  const okMatch = okSource.exec(source);
  const warnMatch = warnSource.exec(source);
  const errorMatch = errorSource.exec(source);
  assert.ok(okMatch, 'the ok token must mix the host success colour with the label colour');
  assert.ok(warnMatch, 'the warn token must mix the host warn colour with the label colour');
  assert.ok(errorMatch, 'the error token must mix the host error colour with the label colour');
  assert.equal(okMatch[1], '52');
  assert.equal(warnMatch[1], '52');
  assert.equal(errorMatch[1], '52');
  /* No literal colour, no theme branch: the mix follows whatever the host set. */
  assert.ok(!/#[0-9a-f]{6}/i.test(source), 'the plugin must not hardcode a hex colour');
  assert.ok(!/@media\s*\(prefers-color-scheme/.test(source), 'no OS theme branch is needed (and viewport media queries are banned)');
  assert.ok(source.includes('--project-flow-ok-text:var(--dsw-alias-state-success-primary)'), 'a non-color-mix fallback is required');
  assert.ok(source.includes('--project-flow-error-text:var(--dsw-alias-state-error-primary)'), 'the error token needs the same fallback');

  const mix = (base, label, share) => {
    const a = [1, 3, 5].map((o) => parseInt(base.slice(o, o + 2), 16));
    const b = [1, 3, 5].map((o) => parseInt(label.slice(o, o + 2), 16));
    const mixed = a.map((value, index) => value * share + b[index] * (1 - share));
    return '#' + mixed.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('');
  };
  const share = Number(okMatch[1]) / 100;
  const themes = [
    { name: 'light', label: '#0f1115', secondary: '#61666b', error: '#ec1313', chip: '#ffffff', card: '#ffffff' },
    { name: 'dark', label: '#f9fafb', secondary: '#cfd3d6', error: '#f25a5a', chip: '#2c2c2e', card: '#232324' },
  ];
  for (const theme of themes) {
    const okText = mix('#22c55e', theme.label, share);
    const warnText = mix('#f59e0b', theme.label, share);
    const errorText = mix(theme.error, theme.label, share);
    const okRatio = contrastRatio(okText, theme.chip);
    const warnRatio = contrastRatio(warnText, theme.chip);
    const errorRatio = contrastRatio(errorText, theme.chip);
    assert.ok(okRatio >= 4.5, `${theme.name} ok text ${okText} is ${okRatio.toFixed(2)}:1 (needs 4.5)`);
    assert.ok(warnRatio >= 4.5, `${theme.name} warn text ${warnText} is ${warnRatio.toFixed(2)}:1 (needs 4.5)`);
    assert.ok(errorRatio >= 4.5, `${theme.name} error text ${errorText} is ${errorRatio.toFixed(2)}:1 (needs 4.5)`);
    /* Chip text is 10.5-11px body-level type, so the WHOLE family needs 4.5:1,
       not just ok/warn: the secondary-label chips included (P1-2). */
    const secondaryRatio = contrastRatio(theme.secondary, theme.chip);
    assert.ok(secondaryRatio >= 4.5, `${theme.name} secondary chip text ${theme.secondary} is ${secondaryRatio.toFixed(2)}:1 (needs 4.5)`);
    /* The trend line / dots are graphics: the lower 3:1 bar, same token. */
    assert.ok(contrastRatio(okText, theme.card) >= 3, `${theme.name} trend line is below 3:1`);
  }
  assert.ok(source.includes('.project-flow-trendLineDone{stroke:var(--project-flow-ok-text);}'), 'trend done line must use the token');
  assert.ok(source.includes('.project-flow-chip--ok{color:var(--project-flow-ok-text);}'), 'ok chip must use the token');
  assert.ok(source.includes('.project-flow-chip--warn{color:var(--project-flow-warn-text);}'), 'warn chip must use the token');
  assert.ok(source.includes('.project-flow-chip--error{color:var(--project-flow-error-text);}'), 'error chip must use the error token');
  assert.ok(source.includes('.project-flow-chip--hb-working{color:var(--project-flow-ok-text);}'), 'hb-working must use the ok token');
  assert.ok(source.includes('.project-flow-chip--hb-idle{color:var(--project-flow-warn-text);}'), 'hb-idle must use the warn token');
  assert.ok(source.includes('.project-flow-chip--hb-missed{color:var(--project-flow-error-text);}'), 'hb-missed must use the error token');
  /* The host state-* primaries (and `opacity`) are still reachable: pin the
     three dimmed chips to a plain token, since opacity composites the text
     towards the chip background and drops the light-theme ratio to 2.8-3.7:1. */
  for (const selector of ['.project-flow-chip--muted', '.project-flow-chip--hb-done', '.project-flow-chip--hb-dead']) {
    const rule = source.split('\n').find((line) => line.startsWith(selector + '{'));
    assert.ok(rule, selector + ' rule missing');
    assert.ok(!/opacity\s*:/.test(rule), selector + ' must not dim text with opacity (P1-2)');
    assert.ok(rule.includes('color:var(--dsw-alias-label-secondary);'), selector + ' must keep the secondary label colour');
  }
  assert.ok(
    source.includes('.project-flow-chip--hb-dead{color:var(--dsw-alias-label-secondary);text-decoration:line-through;}'),
    'hb-dead keeps the strike-through as a non-colour cue'
  );
  assert.ok(!/--dsw-alias-[a-z0-9-]+\s*:/.test(source), 'the plugin must not redeclare a host alias');
  /* The chip family is not the only 10.5-11px body text that inherited a host
     state primary: these sibling rules did too (light 2.15-4.50:1 on the
     layer-1 card/stale background). They must paint text with the plugin
     tokens; border/background/box-shadow uses of the aliases stay untouched. */
  const STATE_PRIMARY_AS_COLOR = /(?:^|[;{])color:var\(--dsw-alias-state-[a-z]+-primary\)/;
  const textRules = [
    ['.project-flow-stale', 'warn'],
    ['.project-flow-gateRun--ok', 'ok'],
    ['.project-flow-gateRun--fail', 'error'],
    ['.project-flow-gateError', 'error'],
    ['.project-flow-gateMark--ok', 'ok'],
    ['.project-flow-gateMark--error', 'error'],
    ['.project-flow-verdict--open', 'warn'],
    ['.project-flow-verdict--confirmed', 'ok'],
    ['.project-flow-verdict--refuted', 'error'],
    ['.project-flow-decisionMark', 'warn']
  ];
  for (const [selector, expected] of textRules) {
    const rule = source.split('\n').find((line) => line.startsWith(selector + '{'));
    assert.ok(rule, selector + ' rule missing');
    assert.ok(
      !STATE_PRIMARY_AS_COLOR.test(rule),
      selector + ' must not use a bare host state primary as its text colour'
    );
    const declaration = /(?:^|[;{])color:var\((--project-flow-(ok|warn|error)-text)\)/.exec(rule);
    assert.ok(declaration, selector + ' must paint body text with a plugin text token');
    assert.equal(declaration[2], expected, selector + ' must use the ' + expected + ' text token');
    for (const theme of themes) {
      const base = expected === 'error' ? theme.error : expected === 'ok' ? '#22c55e' : '#f59e0b';
      const text = mix(base, theme.label, share);
      const ruleRatio = contrastRatio(text, theme.card);
      assert.ok(ruleRatio >= 4.5, `${theme.name} ${selector} text ${text} is ${ruleRatio.toFixed(2)}:1 (needs 4.5)`);
    }
  }
  /* The two remaining stale-block details are not `color` declarations:
     `staleCode` used to dim 10.5px text with opacity (light 3.90:1), and the
     1px `staleMark` ring is a non-text graphic whose host warn primary is
     2.15:1. Both must use the secondary label colour (>=4.5 text / >=3 ring). */
  const staleCode = source.split('\n').find((line) => line.startsWith('.project-flow-staleCode{'));
  assert.ok(staleCode, '.project-flow-staleCode rule missing');
  assert.ok(!/opacity\s*:/.test(staleCode), '.project-flow-staleCode must not dim its text with opacity');
  assert.ok(
    staleCode.includes('color:var(--dsw-alias-label-secondary);'),
    '.project-flow-staleCode must use the secondary label colour'
  );
  const staleMark = source.split('\n').find(
    (line) => line.startsWith('.project-flow-staleMark{') && line.includes('border:')
  );
  assert.ok(staleMark, '.project-flow-staleMark rule missing');
  assert.ok(
    !/--dsw-alias-state-[a-z]+-primary/.test(staleMark),
    '.project-flow-staleMark ring must not use a bare host state primary'
  );
  assert.ok(
    staleMark.includes('border:1px solid var(--dsw-alias-label-secondary);'),
    '.project-flow-staleMark ring must use the secondary label colour'
  );
  for (const theme of themes) {
    const secondaryRatio = contrastRatio(theme.secondary, theme.card);
    assert.ok(
      secondaryRatio >= 4.5,
      `${theme.name} staleCode text ${theme.secondary} is ${secondaryRatio.toFixed(2)}:1 (needs 4.5)`
    );
    assert.ok(
      secondaryRatio >= 3,
      `${theme.name} staleMark ring ${theme.secondary} is ${secondaryRatio.toFixed(2)}:1 (needs 3)`
    );
  }
});

check('PanelView: aria-busy tracks refreshing, and the live region only writes on a transition', () => {
  const view = probe.normalize(panelViewPayload());
  /* P1-3: `.project-flow-view` holds [srOnly status, body]; the body div — NOT
     the outer element — carries aria-busy, so the live region is a SIBLING of
     the busy subtree (AT may defer changes inside a busy subtree). */
  const busyHost = (tree) => {
    const outer = collect(tree, 'project-flow-view')[0];
    assert.equal(outer.props['aria-busy'], undefined, 'aria-busy must not sit on the element that contains the live region');
    const host = (outer.children || []).find(
      (child) => child && child.props && Object.prototype.hasOwnProperty.call(child.props, 'aria-busy')
    );
    assert.ok(host, 'the inner body div carrying aria-busy is missing');
    assert.deepEqual(collect(host, 'project-flow-srOnly'), [], 'the live region must not be inside the busy subtree');
    return host;
  };
  const render = (extra = {}) =>
    renderWithState(probe.PanelView, panelViewProps(view, extra), { reset: Object.keys(extra).length === 0 });
  render(); // establish the idle baseline
  const idle = renderWithState(probe.PanelView, panelViewProps(view), { reset: true });
  assert.equal(busyHost(idle).props['aria-busy'], undefined, 'idle is not busy');
  assert.equal(textOf(collect(idle, 'project-flow-srOnly')[0]), '', 'the live region starts empty');

  const busy = renderWithState(probe.PanelView, panelViewProps(view, { refreshing: true }));
  assert.equal(busyHost(busy).props['aria-busy'], true, 'refreshing must set aria-busy');
  assert.equal(textOf(collect(busy, 'project-flow-srOnly')[0]), '正在刷新…');
  const stillBusy = renderWithState(probe.PanelView, panelViewProps(view, { refreshing: true }));
  assert.equal(textOf(collect(stillBusy, 'project-flow-srOnly')[0]), '正在刷新…', 'a repeat render keeps the same text (no rewrite)');

  const settled = renderWithState(probe.PanelView, panelViewProps(view));
  assert.equal(busyHost(settled).props['aria-busy'], undefined);
  assert.equal(textOf(collect(settled, 'project-flow-srOnly')[0]), '已更新', 'settling announces once');
  const failed = renderWithState(probe.PanelView, panelViewProps(view, { failed: true }));
  assert.equal(textOf(collect(failed, 'project-flow-srOnly')[0]), '读取失败');
  const live = collect(failed, 'project-flow-srOnly')[0];
  assert.equal(live.props.role, 'status');
  assert.equal(live.props['aria-live'], 'polite');

  /* P1-1 regression: retrying after a failure sets refreshing while the stale
     error is still present. `refreshing` must win the phase race, otherwise the
     phase never leaves 'error' and the start of the retry is never announced. */
  const retry = renderWithState(probe.PanelView, panelViewProps(view, { refreshing: true, failed: true }));
  assert.equal(busyHost(retry).props['aria-busy'], true, 'a retry after an error is busy');
  assert.equal(
    textOf(collect(retry, 'project-flow-srOnly')[0]),
    '正在刷新…',
    'refreshing must outrank a stale failure, so the retry announces its start'
  );
});

check('UI state: grouping/expansion is cached per root and restored on the way back', () => {
  const make = (root) => {
    const payload = panelViewPayload();
    payload.root = root;
    /* The captured fixture has no draft rows, and the fold state needs rows to
       be observable: inject two so "folded" vs "expanded" is a row count. */
    payload.tasks = Object.assign({}, payload.tasks, {
      /* task-71: the stage buckets only render when they hold rows, so the fold
         state needs a non-empty, folded bucket: 分析中. */
      active: payload.tasks.active.concat([
        { id: 'T-D1', title: 'draft one', status: 'active', stage: 'analyzing' },
        { id: 'T-D2', title: 'draft two', status: 'active', stage: 'analyzing' },
      ]),
    });
    payload.tasks.counts = Object.assign({}, payload.tasks.counts, { active: payload.tasks.counts.active + 2 });
    return probe.normalize(payload);
  };
  const alpha = make('/w/alpha');
  const beta = make('/w/beta');
  const draftRows = (tree) => {
    const group = collect(tree, 'project-flow-group').find((entry) => entry.props.key === 'analyzing');
    return group ? collect(group, 'project-flow-taskRow').length : 0;
  };
  withStorage({}, () => {
    const first = renderWithState(probe.PanelView, panelViewProps(alpha), { reset: true });
    assert.equal(draftRows(first), 0, 'the analyzing group starts folded');
    const toggle = collect(first, 'project-flow-groupToggle').find((button) => button.props['aria-controls'] === 'project-flow-group-analyzing');
    assert.ok(toggle, 'analyzing group toggle missing');
    toggle.props.onClick({});

    const openedAlpha = renderWithState(probe.PanelView, panelViewProps(alpha));
    assert.ok(draftRows(openedAlpha) > 0, 'expanding the analyzing group must render its rows');

    const other = renderWithState(probe.PanelView, panelViewProps(beta));
    assert.equal(draftRows(other), 0, 'another root must start from its own defaults');

    const back = renderWithState(probe.PanelView, panelViewProps(alpha));
    assert.ok(draftRows(back) > 0, 'returning to the first root restores its grouping');
    assert.equal(draftRows(beta), 0, 'the second root stays folded');
  });
});

check('PanelView: each switch removes exactly its own card (and the grid re-flows)', () => {
  const payload = panelViewPayload();
  const view = probe.normalize(payload);
  withStorage({}, (store) => {
    const full = renderWithState(probe.PanelView, panelViewProps(view), { reset: true });
    assert.equal(collect(full, 'project-flow-cardFold').length, 5, 'every card needs a fold caret');
    assert.equal(collect(full, 'project-flow-trend').length, 1, 'the trend row starts visible');
    const titles = cardTitleTexts(full);
    for (const wanted of ['任务进度', '实验树', '实时信号', '待决策']) {
      assert.ok(titles.some((text) => text.includes(wanted)), 'missing card: ' + wanted + ' in ' + titles.join(' | '));
    }
    const gridFull = collect(full, 'project-flow-grid')[0];
    assert.equal(String(gridFull.props.className).includes('project-flow-grid--single'), false, 'two columns by default');

    // heartbeats off
    store.setItem(PREF_KEY(view), JSON.stringify({ v: 1, showHeartbeats: false }));
    const noBeats = renderWithState(probe.PanelView, panelViewProps(view), { reset: true });
    assert.ok(!cardTitleTexts(noBeats).some((text) => text.includes('实时信号')), 'the heartbeat card must disappear');
    assert.equal(collect(noBeats, 'project-flow-cardFold').length, 4);
    assert.equal(collect(noBeats, 'project-flow-trend').length, 1, 'the other cards stay');

    // trend off
    store.setItem(PREF_KEY(view), JSON.stringify({ v: 1, showTrend: false }));
    const noTrend = renderWithState(probe.PanelView, panelViewProps(view), { reset: true });
    assert.equal(collect(noTrend, 'project-flow-trend').length, 0, 'the trend row must vanish, not render zeros');
    assert.ok(cardTitleTexts(noTrend).some((text) => text.includes('实时信号')), 'heartbeat card stays');

    // experiments off (local switch) → single column, no experiment card
    store.setItem(PREF_KEY(view), JSON.stringify({ v: 1, showExperiments: false }));
    const noExp = renderWithState(probe.PanelView, panelViewProps(view), { reset: true });
    assert.ok(!cardTitleTexts(noExp).some((text) => text.includes('实验树')), 'the experiment card must vanish');
    assert.equal(String(collect(noExp, 'project-flow-grid')[0].props.className).includes('project-flow-grid--single'), true, 'the grid must collapse to one column');

    // project switch wins over the local one
    const closed = probe.normalize(Object.assign({}, payload, { experiments: { enabled: false, total: 0 } }));
    store.setItem(PREF_KEY(closed), JSON.stringify({ v: 1, showExperiments: true }));
    const projectOff = renderWithState(probe.PanelView, panelViewProps(closed), { reset: true });
    assert.ok(!cardTitleTexts(projectOff).some((text) => text.includes('实验树')), 'experiments.enabled=false must keep the card out');
    assert.equal(String(collect(projectOff, 'project-flow-grid')[0].props.className).includes('project-flow-grid--single'), true);
    const expSwitch = collect(projectOff, 'project-flow-displayToggle')[0];
    assert.equal(expSwitch.props.disabled, true, 'the experiment switch is disabled for this project');
  });
});

check('PanelView: 全部收起 wins over a per-card caret, and the preferences survive a remount', () => {
  const view = probe.normalize(panelViewPayload());
  withStorage({}, (store) => {
    const mounted = renderWithState(probe.PanelView, panelViewProps(view), { reset: true });
    assert.deepEqual(bodyHidden(mounted), new Array(5).fill(false), 'every card starts open');

    collect(mounted, 'project-flow-displayAll')[0].props.onClick({});
    const collapsed = renderWithState(probe.PanelView, panelViewProps(view));
    assert.deepEqual(bodyHidden(collapsed), new Array(5).fill(true), 'collapse-all folds every card');

    // A per-card caret cannot punch a hole in the 总控 mode (D-13).
    collect(collapsed, 'project-flow-cardFold')[0].props.onClick({});
    const afterCaret = renderWithState(probe.PanelView, panelViewProps(view));
    assert.deepEqual(bodyHidden(afterCaret), new Array(5).fill(true), 'a caret click must not open one card while all are collapsed');
    assert.equal(collect(afterCaret, 'project-flow-cardFold')[0].props['aria-expanded'], false);

    // Only 「全部展开」 resets the mode.
    collect(afterCaret, 'project-flow-displayAll')[0].props.onClick({});
    const expanded = renderWithState(probe.PanelView, panelViewProps(view));
    assert.deepEqual(bodyHidden(expanded), new Array(5).fill(false), 'expand-all reopens every card');

    // Persistence: a switch survives an unmount + remount of the component.
    collect(expanded, 'project-flow-displayToggle')[1].props.onClick({}); // trend off
    const remounted = renderWithState(probe.PanelView, panelViewProps(view), { reset: true });
    assert.equal(collect(remounted, 'project-flow-trend').length, 0, 'the trend switch must survive a remount');
    assert.equal(JSON.parse(store.getItem(PREF_KEY(view))).showTrend, false, 'the preference is stored under the workspace root');
  });
});

check('PanelView: the widened static guard forbids any transport inside the whole view component', () => {
  /* Static first line of defence; the runtime interceptors above are the proof.
     The scope is the entire PanelView body, so a transport smuggled into
     updateDisplay / foldCard / toggleCard is caught even if no test clicks it. */
  const start = source.indexOf('function PanelView(props)');
  const end = source.indexOf('function Panel(props)', start);
  assert.ok(start > 0 && end > start, 'PanelView region not found');
  const region = source.slice(start, end);
  const forbidden = [
    [/fetch\s*\(/, 'fetch('],
    [/\bwriteFile|appendFile|createWriteStream|execFile|\bspawn\s*\(/, 'a file/process write'],
    [/\/api\//, '/api/'],
    [/\/state\//, '/state/'],
    [/XMLHttpRequest/, 'XMLHttpRequest'],
    [/WebSocket/, 'WebSocket'],
    [/sendBeacon/, 'sendBeacon'],
  ];
  for (const [pattern, label] of forbidden) {
    assert.ok(!pattern.test(region), 'PanelView must not reference ' + label);
  }
  for (const name of ['updateDisplay', 'foldCard', 'toggleCard']) {
    assert.ok(region.includes(name), name + ' must stay inside PanelView');
  }
});

check('PanelView: switches and folds never call fetch and never touch the fixture store', () => {
  const view = probe.normalize(panelViewPayload());
  const before = { bytes: readFileSync(FIXTURE_STORE), mtimeMs: fs.statSync(FIXTURE_STORE).mtimeMs };
  const calls = [];
  const beaconCalls = [];
  const xhrCalls = [];
  const wsCalls = [];
  const previousWindowFetch = typeof window !== 'undefined' && window ? window.fetch : undefined;
  const previousGlobalFetch = globalThis.fetch;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousXhr = globalThis.XMLHttpRequest;
  const previousWs = globalThis.WebSocket;
  if (typeof window === 'undefined') globalThis.window = {};
  const recorder = (...args) => {
    calls.push(String(args[0]));
    return Promise.reject(new Error('the display switches must not reach the network'));
  };
  /* Every transport a careless switch could reach for, both surfaces: panel code
     may use window.fetch, a test double the global one, and a "write the server"
     mutation has four other doors (beacon / XHR / WebSocket / fetch). */
  window.fetch = recorder;
  globalThis.fetch = recorder;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      sendBeacon: (url) => {
        beaconCalls.push(String(url));
        return true;
      },
    },
  });
  globalThis.XMLHttpRequest = class FakeXhr {
    open(method, url) {
      xhrCalls.push('open:' + String(url));
    }
    send() {
      xhrCalls.push('send');
    }
  };
  globalThis.WebSocket = class FakeWebSocket {
    constructor(url) {
      wsCalls.push(String(url));
    }
  };
  try {
    withStorage({}, () => {
      const mounted = renderWithState(probe.PanelView, panelViewProps(view), { reset: true });
      for (const button of collect(mounted, 'project-flow-displayToggle')) button.props.onClick({});
      collect(mounted, 'project-flow-displayAll')[0].props.onClick({});
      const collapsed = renderWithState(probe.PanelView, panelViewProps(view));
      for (const caret of collect(collapsed, 'project-flow-cardFold')) caret.props.onClick({});
      renderWithState(probe.PanelView, panelViewProps(view), { reset: true });
    });
  } finally {
    if (previousWindowFetch === undefined) delete window.fetch;
    else window.fetch = previousWindowFetch;
    globalThis.fetch = previousGlobalFetch;
    if (navigatorDescriptor === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    if (previousXhr === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = previousXhr;
    if (previousWs === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWs;
  }
  assert.deepEqual(calls, [], 'display switches must not call fetch at all: ' + calls.join(', '));
  assert.deepEqual(beaconCalls, [], 'display switches must not call sendBeacon: ' + beaconCalls.join(', '));
  assert.deepEqual(xhrCalls, [], 'display switches must not open an XHR: ' + xhrCalls.join(', '));
  assert.deepEqual(wsCalls, [], 'display switches must not open a WebSocket: ' + wsCalls.join(', '));
  const after = readFileSync(FIXTURE_STORE);
  assert.ok(before.bytes.equals(after), 'the fixture store must stay byte-identical');
  assert.equal(fs.statSync(FIXTURE_STORE).mtimeMs, before.mtimeMs, 'the fixture store mtime must not change');
  assert.deepEqual(probe.normalize(panelViewPayload()), view, 'normalize must stay pure (the payload is unchanged)');
  // The display helpers own exactly one storage write and no I/O surface at all.
  const region = source.slice(source.indexOf('const DISPLAY_KEY'), source.indexOf('function PanelView'));
  assert.ok(region.length > 0);
  assert.ok(!/fetch\s*\(/.test(region), 'display helpers must not call fetch');
  assert.ok(!/writeFile|appendFile|createWriteStream|execFile|\bspawn\s*\(/.test(region), 'display helpers must not write files or spawn');
  assert.ok(!/\/state\/|\/api\//.test(region), 'display helpers must not reference a Host endpoint');
  assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon/.test(region), 'display helpers must not use another transport');
  assert.ok(region.includes("'project-flow.display:'"), 'the one storage write must stay namespaced');
});

// ------------------------------ real-payload trend end-to-end (task-165)
//
// The approximation marker has to survive the WHOLE chain: core reads the ledger,
// `projectTaskTimes` backfills a missing `done_at` from `updated_at` and flags it
// (`doneAtEstimated`), `buildSnapshot` derives `tasks.trend`, `normalize` keeps
// it, and `TasksCard` draws the dashed tail. Fixtures that inject a payload (the
// checks above) never exercise that projection, which is exactly how the `≈` was
// lost once: old done records looked exact because `done_at` had been backfilled.
// So this case builds a real project and asks the real `buildSnapshot`.
const TREND_NOW = new Date(2026, 10, 4, 12).getTime();
const trendDay = (day) => new Date(2026, 9, day, 10).toISOString();

/** A temp project with one done task, patched on disk to control done_at. */
async function makeRealTrendProject(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-trend-'));
  initProject(root, { name: 'e2e-trend', noGates: true });
  const { contract } = loadContract(root);
  const made = addTask(root, contract, {
    /* `type` became mandatory in core (T-20261105-01): a task without it throws. */
    type: 'chore',
    title: 'chore: trend e2e',
    status: 'active',
    created_at: trendDay(20),
    updated_at: trendDay(28),
  });
  const file = path.join(root, '.agents', 'tasks', made.id + '.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(record);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  const payload = await buildSnapshot({ root, now: TREND_NOW });
  return { root, payload };
}

/* Legacy shape: done with only `updated_at` — the approximation must be reported. */
const realLegacyTrend = await makeRealTrendProject((record) => {
  record.status = 'done';
  delete record.done_at;
  record.updated_at = trendDay(28);
});
/* Modern shape: an explicit `done_at` — the day is exact, so no ≈ anywhere. */
const realExactTrend = await makeRealTrendProject((record) => {
  record.status = 'done';
  record.done_at = trendDay(27);
  record.updated_at = trendDay(28);
});

check('trend ≈ (real payload): a done task without done_at keeps estimatedFrom through the projection', () => {
  const trend = realLegacyTrend.payload.tasks && realLegacyTrend.payload.tasks.trend;
  assert.ok(trend, 'buildSnapshot lost tasks.trend');
  /* The core projection backfills done_at from updated_at on this legacy record;
     the estimate flag is the only thing that keeps the approximation visible. */
  assert.equal(trend.estimatedFrom, '2026-10-28', 'the projection dropped the estimated marker: ' + JSON.stringify(trend));
  assert.ok(trend.done.reduce((sum, value) => sum + value, 0) >= 1, 'the done task must land in the done series');

  const card = mountTasks(probe.normalize(realLegacyTrend.payload).tasks);
  const summary = collect(card, 'project-flow-trendSummary')[0];
  assert.ok(summary && textOf(summary).includes('近 14 天 · 新增'), 'the trend summary is missing: ' + (summary ? textOf(summary) : 'none'));
  /* ≈ is its own sibling marker, so the whole head is checked. */
  assert.equal(collect(card, 'project-flow-trendApprox').length, 1, 'the ≈ marker is missing');
  assert.ok(textOf(card).includes('≈'), 'the rendered trend must show ≈ for a projected approximation');
  const dashed = approxLines(card);
  assert.equal(dashed.length, 2, 'both series need a dashed tail');
  for (const line of dashed) {
    assert.equal(line.props.opacity, 0.6, 'the approximated tail drops to 60%');
    assert.equal(line.props.strokeDasharray, '2 1.5', 'the approximated tail is dashed');
  }
  assert.equal(collect(card, 'project-flow-trendApproxPoint').length, 2, 'the cut point needs a marker');
  const titles = trendDayTitles(card);
  assert.ok(
    titles.some((title) => title.startsWith('10-28') && title.includes('近似')),
    'the approximated day title must say why: ' + titles[6]
  );
});

check('trend ≈ (real payload): an explicit done_at stays exact — no ≈, no dashed segment', () => {
  const trend = realExactTrend.payload.tasks && realExactTrend.payload.tasks.trend;
  assert.ok(trend, 'buildSnapshot lost tasks.trend');
  assert.equal(trend.estimatedFrom, null, 'an explicit done_at must not be flagged as estimated');
  const card = mountTasks(probe.normalize(realExactTrend.payload).tasks);
  assert.equal(collect(card, 'project-flow-trendApprox').length, 0, 'no ≈ marker for an exact series');
  assert.equal(approxLines(card).length, 0, 'no dashed segment for an exact series');
  assert.equal(collect(card, 'project-flow-trendApproxPoint').length, 0, 'no cut marker for an exact series');
  assert.ok(!textOf(card).includes('≈'));
  const titles = trendDayTitles(card);
  assert.ok(titles.some((title) => title.startsWith('10-27')), 'the exact day must be plotted: ' + titles[5]);
});

for (const project of [realLegacyTrend, realExactTrend]) {
  try {
    fs.rmSync(project.root, { recursive: true, force: true });
  } catch (error) {
    /* a leftover temp dir is harmless */
  }
}

// -------------------------------- CSS alias hygiene (T-20261030-07 / task-182)
//
// A `var(--dsw-alias-…)` that does not exist resolves to nothing at computed-value
// time, so the whole declaration silently disappears — that is how the task-tree
// connector (`--dsw-alias-border-l`, absent from the theme) shipped invisible.
//
// Whitelist source: `@deepseek-ai/dsh-client-ui-theme/lib/client.js`, the aliases
// declared in its `body` and `body[data-ds-dark-theme]` blocks (114 names). To
// regenerate: `grep -o '--dsw-alias-[a-z0-9-]*:' <that file> | sort -u`.
const THEME_ALIAS_NAMES = `
  bg-base bg-document-preview bg-document-selection bg-layer-1 bg-layer-2 bg-layer-3 bg-mask-1 bg-mask-2
  bg-mask-3 bg-mask-drop bg-mask-photo bg-module-platform bg-multi-select bg-overlay bg-skeleton border-inverted
  border-inverted2 border-l1 border-l2 border-l2-darkmode-thin border-l3 border-l4 brand-primary brand-primary-invert
  brand-primary-new-colorprimary-new-color brand-text button-contrast-fill button-elevated-fill button-floating-fill button-floating-hover button-ghost-active-border button-ghost-active-fill
  button-ghost-active-hover button-info-fill button-info-hover button-primary-dimmed button-primary-fill button-primary-hover button-tool-bar-fill button-tool-bar-fill-invisible
  button-tool-bar-hover code-diff-added code-diff-deleted file-diff-added-bg file-diff-added-gutter file-diff-added-marker file-diff-deleted-bg file-diff-deleted-gutter
  file-diff-deleted-marker illustration-background illustration-backing illustration-detail illustration-inset illustration-shadow illustration-surface interactive-bg-active
  interactive-bg-hover interactive-bg-hover-accent interactive-bg-hover-danger interactive-bg-hover-solid label-caption label-deep-diving label-deep-diving-shimmer label-dimmed
  label-document-preview label-primary label-primary-bluish label-primary-dimmed label-primary-foreground label-primary-inverted label-secondary label-shimmer
  label-tertiary link markdown-citation markdown-code-block markdown-code-block-banner markdown-code-segment-selected markdown-code-segment-unselected markdown-inline-code
  markdown-placeholder markdown-tag menu-group-header-fill menu-icon onboarding-accent onboarding-card-fill onboarding-checkbox-border onboarding-secondary-fill
  scrollbar-bg-l1 scrollbar-bg-l2 scrollbar-hover-l1 scrollbar-hover-l2 settings-card-fill settings-card-stroke state-business-primary state-business-tertiary
  state-done-primary state-error-primary state-error-secondary state-idle-primary state-success-primary state-success-secondary state-success-tertiary state-warn-label
  state-warn-primary state-warn-secondary state-warn-tertiary switch-thumb toast-bg toast-label tooltip-bg tooltip-key-bg
  turn-trigger-bg turn-trigger-bg-hover
`.trim()
const THEME_ALIASES = new Set(THEME_ALIAS_NAMES.split(/\s+/).map((name) => '--dsw-alias-' + name))

check('CSS: every var(--dsw-…) / var(--project-flow-…) reference resolves', () => {
  const text = readFileSync(SRC, 'utf8');
  const used = new Set();
  for (const match of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
    if (match[1].startsWith('--dsw-') || match[1].startsWith('--project-flow-')) used.add(match[1]);
  }
  assert.ok(used.size > 0, 'no design-token references found at all');

  const undefinedAliases = [...used].filter((name) => name.startsWith('--dsw-') && !THEME_ALIASES.has(name));
  assert.deepEqual(undefinedAliases, [], 'undefined host alias (its declaration silently drops): ' + undefinedAliases.join(', '));

  /* Plugin-local properties must be declared in this file before use. */
  const declared = new Set([...text.matchAll(/(--project-flow-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
  const localUndefined = [...used].filter((name) => name.startsWith('--project-flow-') && !declared.has(name));
  assert.deepEqual(localUndefined, [], 'plugin property used without a declaration: ' + localUndefined.join(', '));

  /* The exact regression this card fixes: no bare `border-l` (only l1..l4 exist). */
  assert.ok(!/--dsw-alias-border-l(?!\d)/.test(text), '--dsw-alias-border-l is not a theme alias; use l1..l4');
  assert.ok(text.includes('var(--dsw-alias-border-l2)'), 'the tree connector / display buttons must use border-l2');
});

// ------------------------------------------------ display row (T-13 A5)
const DISPLAY_DEFAULTS = { allCollapsed: false, showExperiments: true, showTrend: true, showHeartbeats: true };

/** Run with a fake `window.localStorage`; restores the previous one afterwards. */
function withStorage(seed, run) {
  const previous = typeof window !== 'undefined' && window ? window.localStorage : undefined;
  const data = new Map(Object.entries(seed || {}));
  const fake = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    key: (index) => Array.from(data.keys())[index] ?? null,
    get length() { return data.size; },
  };
  if (typeof window === 'undefined') globalThis.window = {};
  window.localStorage = fake;
  try {
    return run(fake);
  } finally {
    if (previous === undefined) delete window.localStorage;
    else window.localStorage = previous;
  }
}

check('display prefs: defaults, per-root persistence, corrupt/version/shape fallbacks', () => {
  withStorage({}, (store) => {
    assert.deepEqual(probe.readDisplayPrefs('/w/a'), DISPLAY_DEFAULTS, 'first visit keeps every default');
    probe.writeDisplayPrefs('/w/a', { allCollapsed: true, showExperiments: false, showTrend: false, showHeartbeats: true });
    const stored = JSON.parse(store.getItem('project-flow.display:/w/a'));
    assert.deepEqual(stored, { v: 1, allCollapsed: true, showExperiments: false, showTrend: false, showHeartbeats: true }, 'the persisted shape is versioned');
    assert.deepEqual(probe.readDisplayPrefs('/w/a'), { allCollapsed: true, showExperiments: false, showTrend: false, showHeartbeats: true });
    // Two roots never share preferences.
    assert.deepEqual(probe.readDisplayPrefs('/w/b'), DISPLAY_DEFAULTS, 'a second root keeps its own defaults');
    probe.writeDisplayPrefs('/w/b', { showTrend: false });
    assert.deepEqual(probe.readDisplayPrefs('/w/a'), { allCollapsed: true, showExperiments: false, showTrend: false, showHeartbeats: true }, 'root a is untouched');
    assert.deepEqual(probe.readDisplayPrefs('/w/b'), { allCollapsed: false, showExperiments: true, showTrend: false, showHeartbeats: true });
    // Broken values fall back instead of throwing.
    store.setItem('project-flow.display:/w/c', '{not json');
    assert.deepEqual(probe.readDisplayPrefs('/w/c'), DISPLAY_DEFAULTS, 'corrupt JSON');
    store.setItem('project-flow.display:/w/d', JSON.stringify({ v: 2, allCollapsed: true }));
    assert.deepEqual(probe.readDisplayPrefs('/w/d'), DISPLAY_DEFAULTS, 'version mismatch');
    store.setItem('project-flow.display:/w/e', JSON.stringify({ v: 1, allCollapsed: 'yes', showTrend: 0 }));
    assert.deepEqual(probe.readDisplayPrefs('/w/e'), DISPLAY_DEFAULTS, 'wrong field types');
    store.setItem('project-flow.display:/w/f', JSON.stringify({ v: 1, allCollapsed: true, showTrend: false }));
    assert.deepEqual(probe.readDisplayPrefs('/w/f'), { allCollapsed: true, showExperiments: true, showTrend: false, showHeartbeats: true }, 'partial file keeps defaults for missing keys');
  });
  // No storage at all: defaults and a false write result, never a throw.
  const previous = window.localStorage;
  delete window.localStorage;
  assert.deepEqual(probe.readDisplayPrefs('/w/g'), DISPLAY_DEFAULTS);
  assert.equal(probe.writeDisplayPrefs('/w/g', { allCollapsed: true }), false);
  window.localStorage = previous;
});

check('DisplayBar: collapse-all plus three switches; the experiments switch disables when the project says off', () => {
  withStorage({}, (store) => {
    let seen = null;
    const display = probe.readDisplayPrefs('/w/panel');
    const bar = probe.DisplayBar({
      t,
      display,
      experimentsEnabled: true,
      onAllCollapsed: (next) => { seen = { all: next }; },
      onToggle: (key) => { seen = { key }; },
    });
    const all = collect(bar, 'project-flow-displayAll')[0];
    assert.equal(textOf(all), '全部收起', 'the default label collapses');
    all.props.onClick({});
    assert.deepEqual(seen, { all: true }, 'the control row asks for collapse-all');
    // Expanding after a collapse flips the label.
    const expandedBar = probe.DisplayBar({ t, display: { ...display, allCollapsed: true }, experimentsEnabled: true, onAllCollapsed: (next) => { seen = { all: next }; } });
    assert.equal(textOf(collect(expandedBar, 'project-flow-displayAll')[0]), '全部展开');
    collect(expandedBar, 'project-flow-displayAll')[0].props.onClick({});
    assert.deepEqual(seen, { all: false });

    const toggles = collect(bar, 'project-flow-displayToggle');
    assert.equal(toggles.length, 3, 'experiments / trend / heartbeats');
    assert.deepEqual(toggles.map((button) => textOf(button)), ['实验', '趋势', '心跳']);
    toggles[1].props.onClick({});
    assert.deepEqual(seen, { key: 'showTrend' });
    assert.equal(toggles[1].props['aria-pressed'], true);

    // experiments.enabled=false: the switch renders disabled and dispatches nothing.
    let dispatched = null;
    const off = probe.DisplayBar({ t, display, experimentsEnabled: false, onToggle: (key) => { dispatched = key; } });
    const expToggle = collect(off, 'project-flow-displayToggle')[0];
    assert.equal(expToggle.props.disabled, true);
    assert.equal(expToggle.props['aria-disabled'], true);
    expToggle.props.onClick({});
    assert.equal(dispatched, null, 'a disabled switch must not dispatch');
    // and the project flag keeps the card out of the panel entirely
    assert.ok(source.includes('view.exp.enabled === true && display.showExperiments !== false'), 'the panel must gate the card on both switches');
  });
});

check('fold: 全部收起 wins over a manual expand, every card gets a resolvable caret', () => {
  assert.equal(probe.cardCollapsed({ allCollapsed: true }, false), true, 'collapse-all must beat a manual expand');
  assert.equal(probe.cardCollapsed({ allCollapsed: true }, true), true);
  assert.equal(probe.cardCollapsed({ allCollapsed: false }, true), true);
  assert.equal(probe.cardCollapsed({ allCollapsed: false }, false), false);

  /* FoldCard is the real wrapper: it owns the title row and hides the card. */
  const card = probe.TasksCard({ tasks: view.tasks, t, now: NOW });
  const fold = { t, collapsed: false, onToggle: () => {}, controlsId: 'project-flow-cardBody-tasks', titleKey: 'tasks.title', card };
  const folded = probe.FoldCard(fold);
  const caret = collect(folded, 'project-flow-cardFold')[0];
  const body = collect(folded, 'project-flow-cardBody')[0];
  assert.ok(caret, 'the card title needs a fold caret');
  assert.equal(caret.props['aria-expanded'], true);
  assert.equal(caret.props['aria-controls'], 'project-flow-cardBody-tasks');
  assert.equal(body.props.id, 'project-flow-cardBody-tasks', 'the aria-controls target must resolve');
  assert.equal(body.props.hidden, undefined, 'an open card is not hidden');
  const collapsed = probe.FoldCard({ ...fold, collapsed: true });
  assert.equal(collect(collapsed, 'project-flow-cardBody')[0].props.hidden, true);
  assert.equal(collect(collapsed, 'project-flow-cardFold')[0].props['aria-expanded'], false);
  // The fold bar carries the card title, so the card itself drops its copy.
  assert.ok(textOf(collect(folded, 'project-flow-cardTitle')[0]).length > 0, 'the fold bar needs the title');
  assert.equal(collect(probe.TasksCard({ tasks: view.tasks, t, now: NOW, showTitle: false }), 'project-flow-cardTitle').length, 0, 'showTitle:false must drop the card copy');
  // PanelView routes all five cards through FoldCard.
  const viewStart = source.indexOf('function PanelView(props)');
  for (const key of ['decisions', 'experiments', 'tasks', 'gates', 'signals']) {
    assert.ok(new RegExp("foldCard\\(\\s*'" + key + "'").test(source.slice(viewStart)), 'card not folded: ' + key);
  }
});

check('section switches: trend off hides the trend row, heartbeat hidden count only when positive', () => {
  const off = mountTasks(trendTasks());
  assert.equal(collect(off, 'project-flow-trend').length, 1, 'the trend row renders by default');
  const hiddenTrend = renderWithState(probe.TasksCard, { tasks: trendTasks(), t, now: NOW, showTrend: false }, { reset: true });
  assert.equal(collect(hiddenTrend, 'project-flow-trend').length, 0, 'showTrend=false must drop the row, not render zeros');
  assert.ok(!textOf(hiddenTrend).includes('近 14 天'), 'no summary either');

  const signals = (extra) =>
    probe.SignalsCard({ heartbeats: view.heartbeats, heartbeatCounts: view.heartbeatCounts, t, now: NOW, ...extra });
  assert.equal(collect(signals({ heartbeatsHidden: 3 }), 'project-flow-hiddenCount').length, 1);
  assert.ok(textOf(signals({ heartbeatsHidden: 3 })).includes('+3 条已隐藏'), 'the hidden count text is missing');
  assert.equal(collect(signals({ heartbeatsHidden: 0 }), 'project-flow-hiddenCount').length, 0, 'zero hides the line');
  assert.equal(collect(signals({}), 'project-flow-hiddenCount').length, 0, 'a missing field hides the line');
});

check('display prefs never touch the ledger: the panel only writes its own storage key', () => {
  const writes = source.match(/\.setItem\(|\.removeItem\(/g) || [];
  assert.equal(writes.length, 1, 'the panel must have exactly one storage write (display prefs), got ' + writes.length);
  assert.ok(!/localStorage\s*\.\s*(setItem|removeItem|clear)/.test(source), 'no direct localStorage writes outside the guarded helper');
  assert.ok(source.includes("project-flow.display:"), 'the namespaced storage key is missing');
  assert.ok(!/writeFileSync|appendFileSync|createWriteStream/.test(source), 'the panel must never write files');
  assert.ok(!/flow\.json/.test(source), 'the panel must not touch flow.json');
  const snapshot = JSON.stringify({ v: 1, allCollapsed: true, showExperiments: false, showTrend: false, showHeartbeats: true });
  withStorage({}, (store) => {
    probe.writeDisplayPrefs('/w/ledger', { allCollapsed: true, showExperiments: false, showTrend: false, showHeartbeats: true });
    assert.equal(store.getItem('project-flow.display:/w/ledger'), snapshot, 'the persisted value is exactly the versioned preference object');
    for (const key of store.length ? Array.from({ length: store.length }, (_, index) => store.key(index)) : []) {
      assert.ok(key.startsWith('project-flow.display:'), 'unexpected storage key: ' + key);
    }
  });
});

check('TaskRow: the caret label says 收起 when expanded and 展开 when collapsed', () => {
  const open = rowOf(mountTasks(treeTasks()), 'A 根任务');
  const openCaret = collect(open, 'project-flow-taskCaret')[0];
  assert.match(openCaret.props['aria-label'], /收起 1 个子任务/, 'an expanded parent offers collapse: ' + openCaret.props['aria-label']);
  openCaret.props.onClick({ stopPropagation() {} });
  const collapsed = renderWithState(probe.TasksCard, { tasks: treeTasks(), t, now: NOW });
  const collapsedCaret = collect(rowOf(collapsed, 'A 根任务'), 'project-flow-taskCaret')[0];
  assert.match(collapsedCaret.props['aria-label'], /展开 1 个子任务/, 'a collapsed parent offers expand');
});

check('TaskRow: stage badge renders after type: title and greys finished stages (task-71)', () => {
  const render = (task) => probe.TaskRow({ task, t, now: NOW, open: false, onToggle: () => {} });
  const inProgress = render({ id: 'T-S1', type: 'feat', title: '进行中', status: 'active', stage: 'implementing' });
  const activeBadges = collect(inProgress, 'project-flow-taskStage');
  assert.equal(activeBadges.length, 1, 'an in-progress row needs exactly one stage badge');
  assert.equal(textOf(activeBadges[0]), '实现中', 'the badge must use the Chinese stage label');
  assert.equal(activeBadges[0].props.title, 'implementing', 'the badge keeps the English id as its tooltip');
  assert.ok(!String(activeBadges[0].props.className).includes('--closed'), 'in-progress must not use the closed tone');
  // Position: after `type: title` in the row head.
  const head = collect(inProgress, 'project-flow-taskHead')[0];
  const title = collect(inProgress, 'project-flow-taskTitle')[0];
  assert.ok(textOf(title) === 'feat: 进行中', 'the title line must stay `type: title`');
  const children = head.children.filter(Boolean);
  assert.ok(
    children.indexOf(activeBadges[0]) > children.indexOf(title),
    'the stage badge must come after the title line'
  );

  const done = render({ id: 'T-S2', title: '完成', status: 'done', stage: 'done' });
  const doneBadge = collect(done, 'project-flow-taskStage')[0];
  assert.equal(textOf(doneBadge), '已完成');
  assert.ok(String(doneBadge.props.className).includes('--closed'), 'finished work takes the closed (secondary) tone');
  const archived = render({ id: 'T-S3', title: '归档', status: 'archived', stage: 'archived' });
  assert.ok(String(collect(archived, 'project-flow-taskStage')[0].props.className).includes('--closed'));
  assert.equal(textOf(collect(archived, 'project-flow-taskStage')[0]), '已归档');

  // An older payload without `stage` renders no badge (no invented stage).
  const legacy = render({ id: 'T-S4', title: '旧行', status: 'active' });
  assert.equal(collect(legacy, 'project-flow-taskStage').length, 0, 'a row without stage must not show a badge');

  // Stylesheet: the badge exists and the closed tone is the secondary label colour.
  assert.ok(probe.CSS.includes('.project-flow-taskStage{'), 'stage badge CSS rule missing');
  assert.ok(
    probe.CSS.includes('.project-flow-taskStage--closed{color:var(--dsw-alias-label-secondary);}'),
    'the closed stage badge must use the secondary label colour'
  );
});

check('TasksCard: control-word captures fold into one muted line (task-77)', () => {
  const base = probe.normalize({})
  const tasks = probe.normalize({
    tasks: {
      total: 3,
      counts: { active: 1 },
      active: [{ id: 'T-2', title: 'active', status: 'active' }],
      control: { count: 2, ids: ['T-10', 'T-11'] },
    },
  }).tasks;
  const card = renderWithState(probe.TasksCard, { tasks, t, now: NOW }, { reset: true });
  const line = collect(card, 'project-flow-controlFold')[0];
  assert.ok(line, 'control captures need their folded line');
  assert.equal(textOf(line), '历史控制词 2 条（遗留，不再新增）');
  assert.equal(collect(card, 'project-flow-taskRow').length, 1, 'control rows are not rendered as tasks');

  // count 0 (or absent) hides the line entirely.
  const none = renderWithState(probe.TasksCard, { tasks: base.tasks, t, now: NOW }, { reset: true });
  assert.equal(collect(none, 'project-flow-controlFold').length, 0);

  const english = renderWithState(
    probe.TasksCard,
    { tasks: probe.normalize({ tasks: { total: 2, counts: { active: 1 }, active: [{ id: 'T-2' }], control: { count: 1, ids: ['T-10'] } } }).tasks, t: tEn, now: NOW },
    { reset: true }
  );
  assert.equal(textOf(collect(english, 'project-flow-controlFold')[0]), 'Legacy control words: 1 (no longer recorded)');
});

check('TasksCard: the team line renders only when the board was readable (task-73)', () => {
  const tasks = probe.normalize({}).tasks;
  const team = { available: true, members: 3, tasks: 4, linked: 2, missing: 1, orphaned: 2 };
  const withTeam = renderWithState(probe.TasksCard, { tasks, team, t, now: NOW }, { reset: true });
  const line = collect(withTeam, 'project-flow-teamLine')[0];
  assert.ok(line, 'an available board needs the team line');
  assert.equal(textOf(line), '团队 3 成员 · 4 张共享任务 · 2 条未关联');

  // unavailable must HIDE the line, never print 0s ("cannot read" ≠ "nothing there").
  const unavailable = renderWithState(
    probe.TasksCard,
    { tasks, team: { available: false, members: 0, tasks: 0, linked: 0, missing: 0, orphaned: 0 }, t, now: NOW },
    { reset: true }
  );
  assert.equal(collect(unavailable, 'project-flow-teamLine').length, 0, 'available:false must hide the line');

  // An older payload without `team` also hides it.
  const absent = renderWithState(probe.TasksCard, { tasks, t, now: NOW }, { reset: true });
  assert.equal(collect(absent, 'project-flow-teamLine').length, 0, 'a payload without team hides the line');

  const english = renderWithState(probe.TasksCard, { tasks, team, t: tEn, now: NOW }, { reset: true });
  assert.equal(
    textOf(collect(english, 'project-flow-teamLine')[0]),
    'Team 3 members · 4 shared tasks · 2 unlinked'
  );
});

check('TasksCard: the queue head takes tasks.current even when it is not active[0]', () => {
  const tasks = probe.normalize({
    tasks: {
      total: 3,
      counts: { active: 3 },
      current: 'T-C',
      active: [
        { id: 'T-A', title: '第一行' },
        { id: 'T-B', title: '第二行' },
        { id: 'T-C', title: '真实的队列头' },
      ],
    },
  }).tasks;
  const card = mountTasks(tasks);
  const head = collect(card, 'project-flow-queueHead')[0];
  assert.ok(head, 'the queue head line is missing');
  assert.ok(textOf(head).includes('T-C'), 'the head must be tasks.current: ' + textOf(head));
  assert.ok(textOf(head).includes('真实的队列头'));
  assert.ok(!textOf(head).includes('T-A'), 'active[0] must not win when current is set');
  assert.ok(collect(card, 'project-flow-taskRow').length <= 12, 'the first screen stays within 12 rows');
});

check('TasksCard: chips, current task, folded groups and one row per task', () => {
  const card = mountTasks(view.tasks);
  assert.equal(collect(card, 'project-flow-chip').length, 4, 'other chip should stay hidden at 0');
  const body = JSON.stringify(card);
  assert.ok(body.includes('T-20261028-56'), 'current task id missing');
  assert.ok(body.includes('client half'), 'current task title missing');
  // Groups: one draft, one active, three recent-done. Draft and recent start
  // folded, so the mount renders only the active preview.
  assert.equal(collect(card, 'project-flow-taskRow').length, 2, 'the open 待办 preview shows both todo rows');
  assert.deepEqual(groupOrder(card), ['todo', 'done'], 'group order is not 待办 -> 已完成');
  assert.equal(collect(card, 'project-flow-more').length, 1, 'the folded 已完成 group must announce its hidden rows');
  const opened = toggleGroup(card, 'done', view.tasks);
  assert.equal(collect(opened, 'project-flow-taskRow').length, 5, 'expanding must reveal every row');
  assert.equal(collect(opened, 'project-flow-gateMark--ok').length, 1);
  assert.equal(collect(opened, 'project-flow-gateMark--error').length, 1);
  // 用户 ③ 决策：id 作为署名常驻（旧「行不得泄露 id」设计已反转），commit 仍只在详情里。
  const signatures = collect(opened, 'project-flow-taskSignature').map((element) => element.children[0]);
  assert.deepEqual(signatures, ['T-2', 'T-D1', 'T-3', 'T-4', 'T-5'], 'every row must sign its business id');
  const rowText = collect(opened, 'project-flow-taskRow').map((row) => textOf(row)).join('\n');
  assert.ok(!rowText.includes('12556a8'), 'collapsed rows must not show a commit');
});

check('TasksCard: 首行是 type: title、第二行是 notes、署名是 id，行 key 仍是业务 id', () => {
  const payload = probe.normalize({
    tasks: {
      total: 2,
      counts: { active: 1, draft: 1 },
      current: null,
      // 旧记录没有 type：降级为裸 title，不显示占位符。
      draft: [{ id: 'T-D9', title: '标题乙', owner: '', notes: '', updated_at: '2026-10-28T09:00:00+08:00' }],
      active: [
        {
          id: 'T-A9',
          type: 'feat',
          title: '标题甲',
          status: 'active',
          owner: 'alice',
          notes: '备注甲',
          updated_at: '2026-10-28T10:00:00+08:00',
        },
      ],
      recentDone: [],
    },
  });
  const card = mountTasks(payload.tasks);
  // 队列头仍然显式点名 id：它是正在做的任务，不是行。
  assert.equal(collect(card, 'project-flow-queueId')[0].children[0], 'T-A9', 'queue head does not name the active id');
  // 用户 ③ 决策：id 作为署名常驻（旧「行不得泄露 id」设计已反转）。
  const collapsedSignatures = collect(card, 'project-flow-taskSignature');
  assert.equal(collapsedSignatures.length, 2, 'both 待办 rows must sign their ids');
  assert.deepEqual(
    collapsedSignatures.map((element) => element.children[0]),
    ['T-A9', 'T-D9'],
    'signatures must be the business ids'
  );
  const opened = card;
  const body = JSON.stringify(opened);
  // 有 type → `type: title`；无 type → 裸 title。
  assert.deepEqual(
    collect(opened, 'project-flow-taskTitle').map((element) => element.children[0]),
    ['feat: 标题甲', '标题乙']
  );
  assert.equal(
    collect(opened, 'project-flow-taskTitle')[0].props.title,
    'feat: 标题甲',
    'the tooltip must show the same composite string'
  );
  assert.equal(collect(opened, 'project-flow-taskTitle')[1].props.title, '标题乙', 'a missing type must not add a prefix');
  // 第二行 = notes：非空才渲染，空则整行不出现。
  const notes = collect(opened, 'project-flow-taskNotes');
  assert.equal(notes.length, 1, 'a row without notes must not reserve the second line');
  assert.equal(notes[0].children[0], '备注甲', 'notes missing from the second line');
  assert.equal(notes[0].props.title, '备注甲', 'notes needs a full-text tooltip');
  // 署名 = id，每行都有，tooltip 同一个 id。
  const signatures = collect(opened, 'project-flow-taskSignature');
  assert.deepEqual(signatures.map((element) => element.children[0]), ['T-A9', 'T-D9'], 'every row signs its id');
  assert.deepEqual(signatures.map((element) => element.props.title), ['T-A9', 'T-D9'], 'signature tooltip is the id');
  assert.ok(body.includes('"key":"T-D9"'), 'draft row key is not its business id');
  assert.ok(body.includes('"key":"T-A9"'), 'active row key is not its business id');
  assert.ok(textOf(opened).includes('会话 alice'), 'owner meta missing');
});

check('TasksCard: a row whose type is not a string degrades to the bare title', () => {
  const payload = probe.normalize({
    tasks: {
      total: 1,
      counts: { active: 1 },
      current: null,
      active: [{ id: 'T-X9', title: '标题丙', status: 'active', type: {} }],
      recentDone: [],
    },
  });
  assert.equal(payload.tasks.active[0].type, '', 'a non-string type must normalize to the empty string');
  const card = mountTasks(payload.tasks);
  const title = collect(card, 'project-flow-taskTitle')[0];
  assert.equal(title.children[0], '标题丙', 'a non-string type must not paint a prefix');
  assert.equal(title.props.title, '标题丙');
});

check('TasksCard: the notes line is clamped to two lines by the stylesheet', () => {
  const rule = probe.CSS.split('\n').find((line) => line.startsWith('.project-flow-taskNotes{'));
  assert.ok(rule, 'notes CSS rule missing');
  assert.ok(rule.includes('-webkit-line-clamp:2'), 'notes is not clamped to two lines');
  assert.ok(rule.includes('-webkit-box-orient:vertical'), 'notes clamp box missing');
  assert.ok(rule.includes('overflow:hidden'), 'notes clamp does not hide the overflow');
  const titleRule = probe.CSS.split('\n').find((line) => line.startsWith('.project-flow-taskTitle{'));
  assert.ok(titleRule && titleRule.includes('text-overflow:ellipsis'), 'title has no ellipsis');
  const signatureRule = probe.CSS.split('\n').find((line) => line.startsWith('.project-flow-taskSignature{'));
  assert.ok(signatureRule, 'signature CSS rule missing');
  assert.ok(signatureRule.includes('max-width:40%'), 'the signature must cap its width');
  assert.ok(signatureRule.includes('text-overflow:ellipsis'), 'a long id must ellipsize');
  assert.ok(signatureRule.includes('color:var(--dsw-alias-label-secondary)'), 'the signature must stay secondary');
});

check('TaskRow: expanded detail carries every ledger field including the id', () => {
  const task = view.tasks.active[0];
  const row = probe.TaskRow({ task, t, now: NOW, open: true, onToggle: () => {} });
  assert.equal(collect(row, 'project-flow-taskDetail').length, 1, 'detail block missing');
  assert.deepEqual(collect(row, 'project-flow-detailLabel').map((element) => element.children[0]), [
    '编号',
    '类型',
    '标题',
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
  assert.equal(values[1], 'feat', 'detail must show the type');
  assert.equal(values[2], 'active task', 'detail must show the raw title without the type prefix');
  assert.equal(values[3], '展开详情里的备注');
  assert.equal(values[4], 'client.js\nindex.js', 'scope.allow must keep one entry per line');
  assert.equal(values[5], 'lib/');
  assert.equal(values[6], 'node --check client.js\nnode .selftest/client-render.mjs');
  assert.equal(values[7], 'f5f176b', 'commits are short shas');
  assert.equal(values[8], '2026-10-28T08:00:00+08:00');
  assert.equal(values[9], '2026-10-28T10:00:00+08:00');
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
  assert.equal(values.length, 10);
  assert.equal(values[0], 'T-empty');
  assert.equal(values[1], '—', 'empty type must show the dash');
  assert.equal(values[2], '—', 'empty title must show the dash');
  assert.equal(values[9], '—', 'empty timestamp must show the dash');
});

check('TasksCard: an unknown task status bucket still renders', () => {
  const otherOnly = probe.normalize({
    tasks: { total: 2, counts: { other: 2 }, current: null, active: [], recentDone: [] },
  });
  const card = probe.TasksCard({ tasks: otherOnly.tasks, t, now: NOW });
  assert.equal(collect(card, 'project-flow-chip').length, 5, 'other chip missing');
  const body = JSON.stringify(card);
  assert.ok(body.includes('2 其它'), 'other count not rendered');
  assert.ok(body.includes('任务台账里还没有任务。'), 'empty stage copy missing');
  assert.equal(collect(card, 'project-flow-taskRow').length, 0);
});

check('TasksCard: empty tasks render the generic ledger copy', () => {
  const card = probe.TasksCard({ tasks: probe.normalize({}).tasks, t, now: NOW });
  const body = JSON.stringify(card);
  assert.ok(body.includes('任务台账里还没有任务。'), 'empty stage copy missing');
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
          notes: '草稿一的备注',
          scope: { allow: ['README.md'] },
          updated_at: '2026-10-28T10:00:00+08:00',
        },
        {
          id: 'T-D2',
          title: 'draft two',
          owner: '',
          notes: '',
          updated_at: '2026-10-20T10:00:00+08:00',
        },
      ],
      active: [
        { id: 'T-A1', title: 'active one', status: 'active', owner: '', notes: '活动备注', updated_at: '2026-10-28T09:00:00+08:00' },
      ],
      recentDone: [],
    },
  });
  assert.equal(payload.tasks.draft.length, 2, 'normalize dropped the draft array');
  assert.equal(payload.tasks.draft[0].notes, '草稿一的备注');

  const card = mountTasks(payload.tasks);
  const body = JSON.stringify(card);
  /* task-71: active and draft rows without a stage both bucket into 待办, so the
     three records render as one preview (no separate draft section any more). */
  assert.ok(body.includes('待办'), 'todo group header missing');
  assert.deepEqual(groupOrder(card), ['todo'], 'the pipeline buckets must stay empty for this payload');
  assert.equal(groupToggle(card, 'todo').props['aria-expanded'], true, 'the todo group starts open');
  assert.equal(collect(card, 'project-flow-taskRow').length, 3, 'the todo preview renders all three rows');
  const opened = card;
  assert.deepEqual(
    collect(opened, 'project-flow-taskTitle').map((element) => element.children[0]),
    ['active one', 'draft one', 'draft two'],
    'active rows must render before draft rows inside the bucket'
  );
  assert.deepEqual(
    collect(opened, 'project-flow-taskNotes').map((element) => element.children[0]),
    ['活动备注', '草稿一的备注'],
    'notes must render on the second line (an empty notes row is skipped)'
  );
  assert.ok(textOf(opened).includes('会话 alice'), 'draft owner missing');
  // 用户 ③ 决策：id 作为署名常驻，不再是「默认隐藏」。
  assert.deepEqual(
    collect(opened, 'project-flow-taskSignature').map((element) => element.children[0]),
    ['T-A1', 'T-D1', 'T-D2'],
    'every row must sign its business id'
  );

  const english = mountTasks(payload.tasks, tEn);
  // Data (the user's Chinese notes/titles) may be Chinese; the chrome must not be.
  const englishText = textOf(english)
    .split('草稿一的备注').join('')
    .split('活动备注').join('')
    .split('draft one').join('')
    .split('draft two').join('')
    .split('active one').join('');
  assert.ok(englishText.includes('Todo'), 'en todo group header missing');
  assert.ok(englishText.includes('session alice'), 'en owner meta missing');
  assert.ok(!/[\u4e00-\u9fff]/.test(englishText), 'en draft group still contains Chinese');
});

check('TasksCard: no draft rows means no todo section', () => {
  const payload = probe.normalize({
    tasks: {
      total: 2,
      counts: { draft: 0, active: 1, done: 1 },
      current: null,
      active: [{ id: 'T-A1', title: 'active one', owner: '' }],
      recentDone: [{ id: 'T-DONE', title: 'done one', status: 'done', commits: [], gate: null }],
    },
  });
  assert.deepEqual(payload.tasks.draft, [], 'an absent draft array normalizes to empty');
  const card = mountTasks(payload.tasks);
  const body = JSON.stringify(card);
  assert.equal(groupOrder(card).includes('draft'), false, 'the old draft group key must be gone');
  assert.equal(groupOrder(card).includes('todo'), true, 'the active row lands in the 待办 bucket');
  assert.equal(collect(card, 'project-flow-taskRow').length, 1, 'the 待办 preview renders its single row');
  const expanded = toggleGroup(card, 'done', payload.tasks);
  assert.equal(collect(expanded, 'project-flow-taskRow').length, 2, 'expanding 已完成 must reveal the second row');

  // Older / hostile payloads must not crash or invent a section.
  const hostile = probe.TasksCard({
    tasks: { total: 1, counts: { draft: '2' }, draft: 'nope', active: [], recentDone: [] },
    t,
    now: NOW,
  });
  assert.ok(hostile, 'hostile draft field rendered nothing');
  assert.ok(JSON.stringify(hostile).includes('任务台账里还没有任务。'), 'a payload without rows shows the empty line');
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
  // task-71: draft rows (created) land in the open 待办 bucket → preview first.
  assert.equal(collect(card, 'project-flow-taskRow').length, 6, 'the 待办 preview shows the first 6 rows');
  assert.ok(JSON.stringify(card).includes('还有 24 条未显示'), 'preview overflow not announced');

  const opened = toggleGroup(card, 'todo', payload.tasks);
  assert.equal(collect(opened, 'project-flow-taskRow').length, 25, 'bucket rows must cap at 25');
  const body = JSON.stringify(opened);
  assert.ok(body.includes('draft 25'), 'last visible draft row missing');
  assert.ok(!body.includes('draft 26'), 'a 26th draft row leaked through');
  assert.ok(body.includes('还有 5 条未显示'), 'draft overflow copy missing');
  assert.equal(collect(opened, 'project-flow-more').length, 1, 'overflow line missing');

  const english = toggleGroup(mountTasks(payload.tasks, tEn), 'todo', payload.tasks, tEn);
  const englishText = JSON.stringify(english);
  assert.ok(englishText.includes('5 more not shown'), 'en overflow copy missing');
  assert.ok(!/[\u4e00-\u9fff]/.test(englishText), 'en overflow copy still contains Chinese');
});

// ---------------------------------------- task card: queue view (T-08 卡 A)
check('TasksCard: 50+ tasks keep the task card inside a 12-row first screen', () => {
  const rows = (prefix, length, status = '') =>
    Array.from({ length }, (_, index) => ({
      id: prefix + String(index + 1).padStart(2, '0'),
      title: prefix + ' ' + (index + 1),
      ...(status ? { status } : {}),
    }));
  const payload = probe.normalize({
    tasks: {
      total: 58,
      counts: { active: 25, draft: 25, done: 8 },
      current: null,
      active: rows('A', 25),
      draft: rows('D', 25),
      recentDone: rows('R', 8, 'done'),
    },
  });
  const card = mountTasks(payload.tasks);
  const firstScreen = collect(card, 'project-flow-taskRow').length;
  assert.ok(firstScreen <= 12, `first screen renders ${firstScreen} task rows (> 12)`);
  assert.equal(firstScreen, 6, 'the 待办 bucket should open on exactly the preview row count');
  const body = JSON.stringify(card);
  /* task-71: active + draft both bucket into 待办 (50 rows); done is folded. */
  assert.ok(body.includes('还有 44 条未显示'), '待办 overflow (50-6) not announced');
  assert.ok(body.includes('还有 8 条未显示'), 'folded 已完成 overflow not announced');
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
      { id: 'T-D1', title: 'draft one', stage: 'analyzing' },
      { id: 'T-D2', title: 'draft two', stage: 'analyzing' },
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
  // 2 待办 rows preview + 2 folded 分析中 rows.
  assert.equal(collect(card, 'project-flow-taskRow').length, 2, 'the folded 分析中 group must not render rows');

  const opened = toggleGroup(card, 'analyzing', first);
  assert.equal(collect(opened, 'project-flow-taskRow').length, 4, 'the 分析中 group did not expand');

  // A poll refresh hands the component a NEW payload with reordered rows: the
  // fold state must follow the group NAME, so it stays open.
  const refreshed = build(true);
  const afterPoll = renderWithState(probe.TasksCard, { tasks: refreshed, t, now: NOW });
  assert.equal(groupToggle(afterPoll, 'analyzing').props['aria-expanded'], true, 'the fold state was lost on refresh');
  assert.equal(collect(afterPoll, 'project-flow-taskRow').length, 4, 'row count changed after refresh');

  const closed = toggleGroup(afterPoll, 'analyzing', refreshed);
  assert.equal(groupToggle(closed, 'analyzing').props['aria-expanded'], false, 'the 分析中 group did not collapse');
  assert.equal(collect(closed, 'project-flow-taskRow').length, 2, 'collapsed 分析中 must render only the 2 待办 rows');
  const afterSecondPoll = renderWithState(probe.TasksCard, { tasks: build(false), t, now: NOW });
  assert.equal(groupToggle(afterSecondPoll, 'analyzing').props['aria-expanded'], false, 'a collapsed group reopened on refresh');
});

check('TasksCard: active overflow announces the hidden rows instead of truncating', () => {
  const active = Array.from({ length: 40 }, (_, index) => ({ id: 'A' + String(index + 1).padStart(2, '0'), title: 'active ' + (index + 1) }));
  const tasks = probe.normalize({ tasks: { total: 40, counts: { active: 40 }, current: null, active, recentDone: [] } }).tasks;
  const card = mountTasks(tasks);
  assert.equal(collect(card, 'project-flow-taskRow').length, 6, '待办 preview drifted');
  assert.ok(JSON.stringify(card).includes('还有 34 条未显示'), '待办 overflow copy missing (silent truncation)');
  const opened = toggleGroup(card, 'todo', tasks);
  assert.equal(collect(opened, 'project-flow-taskRow').length, 25, 'expanded 待办 must cap at MAX_LIST_ROWS');
  assert.ok(JSON.stringify(opened).includes('还有 15 条未显示'), 'expanded 待办 overflow copy missing');
});

check('TasksCard: empty groups keep every aria-controls target resolvable', () => {
  // Empty is a normal state (nothing in progress, nothing completed yet). The
  // toggle must never point at an id that does not exist in the tree.
  const empty = mountTasks(probe.normalize({}).tasks);
  /* task-71: an empty ledger renders no groups at all (never six empty buckets),
     so there is no toggle whose aria-controls could dangle. */
  assert.equal(collect(empty, 'project-flow-groupToggle').length, 0, 'an empty ledger must render no groups');
  assert.ok(textOf(empty).includes('任务台账里还没有任务。'), 'the empty ledger copy is missing');
  assert.equal(collect(empty, 'project-flow-taskRow').length, 0, 'an empty ledger must render no rows');
  // Every rendered group keeps its aria-controls target resolvable.
  const onlyActive = mountTasks(probe.normalize({ tasks: { total: 1, counts: { active: 1 }, current: null, active: [{ id: 'T-A1', title: 'a' }], recentDone: [] } }).tasks);
  const activeLists = collect(onlyActive, 'project-flow-taskList');
  assert.equal(collect(onlyActive, 'project-flow-groupToggle').length, 1, 'only the non-empty 待办 group renders');
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
        { id: 'T-R1', title: 'done one', status: 'done', gate: 'pass' },
        { id: 'T-R2', title: 'done two', status: 'done', gate: 'fail' },
      ],
    },
  }).tasks;
  assert.equal(before.draft.length, 0, 'the old payload must have no draft group');

  const card = mountTasks(before);
  assert.deepEqual(groupOrder(card), ['todo', 'done'], 'a payload without drafts renders two groups');
  const opened = toggleGroup(card, 'done', before);
  assert.equal(groupToggle(opened, 'done').props['aria-expanded'], true, 'done group did not expand');
  assert.equal(collect(opened, 'project-flow-taskRow').length, 3, 'expected 1 待办 + 2 已完成 rows');

  // Next poll: a NEW group (分析中) shows up between 待办 and 已完成.
  const after = probe.normalize({
    tasks: {
      total: 4,
      counts: { active: 2, done: 2 },
      current: null,
      active: [
        { id: 'T-A1', title: 'active one' },
        { id: 'T-N1', title: 'analyzing one', status: 'active', stage: 'analyzing' },
      ],
      recentDone: [
        { id: 'T-R1', title: 'done one', status: 'done', gate: 'pass' },
        { id: 'T-R2', title: 'done two', status: 'done', gate: 'fail' },
      ],
    },
  }).tasks;
  const refreshed = renderWithState(probe.TasksCard, { tasks: after, t, now: NOW });
  assert.deepEqual(groupOrder(refreshed), ['todo', 'analyzing', 'done'], 'group order changed unexpectedly');
  assert.equal(
    groupToggle(refreshed, 'done').props['aria-expanded'],
    true,
    'PROBE-A: the done group re-collapsed when a new group appeared ahead of it (state keyed by render index)'
  );
  assert.equal(
    collect(refreshed, 'project-flow-taskRow').length,
    3,
    'PROBE-A: expected 1 待办 + 2 已完成 rows (the new 分析中 group is folded)'
  );
  assert.equal(groupToggle(refreshed, 'analyzing').props['aria-expanded'], false, 'the new analyzing group must start folded');
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
  assert.equal(toggles.length, 2, 'expected one toggle per rendered stage group');
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
  assert.equal(chevron(card, 'done'), '\u25B8', 'a folded group must show the closed chevron');
  assert.equal(chevron(toggleGroup(card, 'done', view.tasks), 'done'), '\u25BE', 'an expanded group must show the open chevron');
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
    if (rule.includes('color:')) assert.ok(/var\(--dsw-alias-[a-z0-9-]+\)|var\(--project-flow-(?:ok|warn|error)-text\)/.test(rule), 'color without a token: ' + rule);
  }
});

check('Panel: the decision card mounts above the two-column grid', () => {
  const text = readFileSync(SRC, 'utf8');
  const viewStart = text.indexOf('function PanelView(props)');
  const card = text.indexOf("foldCard(\n          'decisions'", viewStart);
  const grid = text.indexOf("' project-flow-grid--single'", viewStart);
  assert.ok(card > viewStart, 'PanelView does not mount DecisionsCard');
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

check('Gate switch: a worktree session writes to ledgerRoot, never to its own checkout', () => {
  /* D-20261108: the panel reads the project main worktree's ledger, so the only
     correct write root is `ledgerRoot`. Posting the session cwd would flip the
     gate in that worktree's committed store copy — invisible to the next poll. */
  const payload = panelViewPayload();
  payload.root = '/tmp/pf-wt/checkout';
  payload.ledgerRoot = '/tmp/pf-wt/main';
  payload.worktree = true;
  payload.currentHead = { sha: 'abc1234', subject: 'wt work', branch: 'panel-wt', dirty: 0 };
  const view = probe.normalize(payload);
  assert.equal(view.ledgerRoot, '/tmp/pf-wt/main');

  const calls = [];
  const previousFetch = window.fetch;
  window.fetch = (url, init) => {
    const body = JSON.parse(String(init && init.body));
    calls.push({ url: String(url), body });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, root: body.root, gate: { id: body.id, enabled: false } }),
    });
  };
  try {
    const full = renderWithState(probe.PanelView, panelViewProps(view), { reset: true });
    const switches = collect(full, 'project-flow-switch');
    assert.ok(switches.length >= 1, 'no gate switch rendered');
    switches[0].props.onClick();
    assert.equal(calls.length, 1, 'the switch must POST exactly once');
    assert.ok(calls[0].url.includes('api/project-flow/gate'), 'wrong endpoint: ' + calls[0].url);
    assert.equal(calls[0].body.root, '/tmp/pf-wt/main', 'gate write root must be the ledger root, not the session cwd');
  } finally {
    if (previousFetch === undefined) delete window.fetch;
    else window.fetch = previousFetch;
  }
});

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
