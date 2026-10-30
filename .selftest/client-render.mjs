/**
 * T-20261028-56 · project-flow data-path render check.
 *
 * The deliverable's factory only exposes { inject, apply }, so this script
 * derives a probe copy in .selftest/.client-probe/ by inserting a `__probe`
 * field into the returned object (one literal string replacement, asserted),
 * then renders every panel component against a full fixture, an empty payload,
 * `gate: null`, a missing `contract` and hostile values. It also replays the
 * Host-side state-*.json fixtures when they exist (including a
 * `not-initialized` workspace response), which proves the client and the real
 * Host payload agree on the contract shape. The panel is workspace-scoped, so
 * `PanelBody` resolves `sessionId` + `useSessions` into the `workspaceRoot` the
 * `Panel` polls and keys on.
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
  "    return {\n      __probe: { normalize, Panel, PanelRoot, PanelBody, PanelTitle, HeaderAction, ExperimentTree, TasksCard, GatesCard, SignalsCard, TopBar, Footer, ErrorState, DetailBlock, PanelIcon, PanelGlyph, relativeFromSeconds, ageText, runPanel: Panel },\n      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],";

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
const NOW = Date.UTC(2026, 9, 28, 3, 30, 0);
const fixture = {
  ok: true,
  generatedAt: '2026-10-28T11:30:00+08:00',
  contract: { source: 'flow.json', schema: 1, name: 'demo-alpha' },
  roots: [{ path: '/tmp/pf-demo/alpha', name: 'demo-alpha' }],
  root: '/tmp/pf-demo/alpha',
  head: { sha: 'f5f176bc1234', subject: 'feat: demo', branch: 'dev', dirty: 2 },
  experiments: {
    total: 3,
    confirmed: 1,
    refuted: 1,
    open: 1,
    groups: [
      {
        factor: '未分组',
        items: [
          {
            id: 'H1-baseline',
            verdict: 'confirmed',
            date: '2026-10-28',
            sha: 'f5f176bc',
            hypothesis: '第一批\n换行保留',
            expected: 'exp',
            measured: 'meas',
            scale: 'small',
          },
          { id: 'H2-long', verdict: 'refuted', date: '2026-10-27', sha: 'aaaaaaa', hypothesis: 'x'.repeat(400) },
        ],
      },
      {
        factor: 'focus',
        items: [{ id: 'H3-open', verdict: 'open', date: '2026-10-26', sha: 'bbbbbbb' }],
      },
    ],
  },
  tasks: {
    total: 49,
    counts: { draft: 20, active: 1, done: 28, archived: 0, other: 0 },
    current: { id: 'T-20261028-56', title: 'client half' },
    active: [
      { id: 'T-2', title: 'active task', status: 'active', owner: 'coord', updated_at: '2026-10-28T10:00:00+08:00', goal: 'g' },
    ],
    recentDone: [
      { id: 'T-3', title: 'done task', updated_at: '2026-10-28T09:00:00+08:00', commits: ['12556a8'], gate: 'pass' },
      { id: 'T-4', title: 'gate failed task', commits: [], gate: 'fail' },
      { id: 'T-5', title: 'gate null task', commits: [], gate: null },
    ],
  },
  gate: { lines: ['a', 'b', 'c'], mtime: NOW - 3600 * 1000, size: 28954 },
  heartbeats: [
    { file: '.agents/heartbeat/a.md', title: 'alpha', statusLine: 'working', ageSeconds: 10800, mtime: NOW - 10800 * 1000 },
    { file: 'b.md', title: '', statusLine: '', ageSeconds: 178000, mtime: 1761447480000 },
  ],
  runs: [{ path: '.agents/tmp/t47/FINAL_sum.txt', ageSeconds: 60, size: 1200, lines: ['l1', 'l2'] }],
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
  assert.equal(view.contract.source, 'flow.json');
  assert.equal(view.contract.schema, 1);
  assert.equal(view.exp.total, 3);
  assert.equal(view.exp.groups[0].factor, '未分组');
  assert.equal(view.exp.groups[0].items.length, 2);
  assert.equal(view.tasks.counts.done, 28);
  assert.equal(view.tasks.counts.other, 0);
  assert.equal(view.gate.lines.length, 3);
  assert.equal(view.gate.disabled, false);
  assert.equal(view.heartbeats.length, 2);
  assert.equal(view.runs.length, 1);
  assert.equal(view.warnings.length, 2);
});

check('normalize: empty payload yields zeroed, renderable data', () => {
  const empty = probe.normalize({});
  assert.equal(empty.root, '');
  assert.equal(empty.contract, null);
  assert.equal(empty.exp.total, 0);
  assert.deepEqual(empty.exp.groups, []);
  assert.equal(empty.tasks.total, 0);
  assert.equal(empty.tasks.counts.draft, 0);
  assert.deepEqual(empty.tasks.draft, []);
  assert.equal(empty.tasks.counts.other, 0);
  assert.equal(empty.tasks.current, null);
  assert.equal(empty.gate.mtime, null);
  assert.equal(empty.gate.disabled, false);
  assert.deepEqual(empty.warnings, []);
});

check('normalize: gate === null becomes the disabled flag, not an error', () => {
  const noGate = probe.normalize({ gate: null, experiments: { total: 0, groups: [] } });
  assert.equal(noGate.gate.disabled, true);
  assert.deepEqual(noGate.gate.lines, []);
  assert.equal(noGate.gate.mtime, null);
});

check('normalize: contract defaults and schema are kept', () => {
  const defaults = probe.normalize({ contract: { source: 'defaults', schema: 1, name: 'demo-alpha' } });
  assert.equal(defaults.contract.source, 'defaults');
  assert.equal(defaults.contract.name, 'demo-alpha');
  assert.equal(probe.normalize({ contract: 'nope' }).contract, null);
});

check('normalize: legacy `exp` key is still accepted', () => {
  const legacy = probe.normalize({ exp: { total: 2, confirmed: 1, groups: [] } });
  assert.equal(legacy.exp.total, 2);
  assert.equal(legacy.exp.confirmed, 1);
});

check('normalize: hostile values do not throw', () => {
  const hostile = probe.normalize({
    experiments: { groups: [null, { items: [null, 3, { id: 7, verdict: 'weird' }] }, 5] },
    tasks: { counts: null, active: 'nope', recentDone: [{}] },
    gate: { lines: 'not-an-array', mtime: 'NaN' },
    heartbeats: [null, {}],
    runs: [null, { lines: null }],
    warnings: 'x',
    contract: [],
  });
  assert.equal(hostile.exp.groups.length, 3);
  assert.equal(hostile.exp.groups[1].items.length, 1);
  assert.equal(hostile.tasks.counts.active, 0);
  assert.equal(hostile.tasks.counts.other, 0);
  assert.equal(hostile.gate.mtime, null);
  assert.equal(hostile.gate.lines.length, 0);
  assert.equal(hostile.contract, null);
});

check('ExperimentTree: renders groups, rows, chips and connectors', () => {
  const tree = probe.ExperimentTree({ exp: view.exp, t });
  const rows = collect(tree, 'project-flow-row');
  assert.equal(rows.length, 3, 'expected three experiment rows');
  assert.equal(collect(tree, 'project-flow-groupHead').length, 2);
  assert.equal(collect(tree, 'project-flow-connector').length, 3);
  const connectors = collect(tree, 'project-flow-connector').map((element) => element.children.join(''));
  assert.ok(connectors.includes('└─'), 'missing last-child connector');
  assert.ok(connectors.includes('├─'), 'missing middle connector');
  assert.equal(collect(tree, 'project-flow-verdict--confirmed').length, 1);
  assert.equal(collect(tree, 'project-flow-verdict--refuted').length, 1);
  assert.equal(collect(tree, 'project-flow-verdict--open').length, 1);
  assert.ok(collect(tree, 'project-flow-chip').length >= 4, 'statistics chips missing');
});

check('ExperimentTree: click handlers are safe', () => {
  const tree = probe.ExperimentTree({ exp: view.exp, t });
  assert.ok(clickEverything(tree) >= 5, 'expected group + row handlers');
});

check('ExperimentTree: empty experiment shows the generic trailer guidance', () => {
  const tree = probe.ExperimentTree({ exp: probe.normalize({}).exp, t });
  const text = JSON.stringify(tree);
  assert.ok(text.includes('实验 trailer'), 'generic guidance copy missing');
  assert.ok(!text.includes('exp.py'), 'guidance still names exp.py');
  assert.equal(collect(tree, 'project-flow-row').length, 0);
});

check('DetailBlock: keeps original newlines in a <pre>', () => {
  const detail = probe.DetailBlock({ item: fixture.experiments.groups[0].items[0], t });
  const values = collect(detail, 'project-flow-detailValue');
  assert.equal(values.length, 3);
  assert.equal(values[0].type, 'pre');
  assert.ok(values[0].children[0].includes('\n'), 'hypothesis newline lost');
  assert.equal(collect(detail, 'project-flow-detailLabel').length, 3);
});

check('TasksCard: chips, current task, active and recent rows', () => {
  const card = probe.TasksCard({ tasks: view.tasks, t, now: NOW });
  assert.equal(collect(card, 'project-flow-chip').length, 4, 'other chip should stay hidden at 0');
  const body = JSON.stringify(card);
  assert.ok(body.includes('T-20261028-56'), 'current task id missing');
  assert.ok(body.includes('client half'), 'current task title missing');
  assert.ok(body.includes('12556a8'), 'commit short hash missing');
  assert.equal(collect(card, 'project-flow-listRow').length, 4);
  assert.equal(collect(card, 'project-flow-gateMark--ok').length, 1);
  assert.equal(collect(card, 'project-flow-gateMark--error').length, 1);
});

check('TasksCard: a markdown/no-ledger project (only `other`) renders', () => {
  const otherOnly = probe.normalize({
    tasks: { total: 2, counts: { other: 2 }, current: null, active: [], recentDone: [] },
  });
  const card = probe.TasksCard({ tasks: otherOnly.tasks, t, now: NOW });
  assert.equal(collect(card, 'project-flow-chip').length, 5, 'other chip missing');
  const body = JSON.stringify(card);
  assert.ok(body.includes('2 其它'), 'other count not rendered');
  assert.ok(body.includes('任务台账里没有进行中的任务。'), 'active list empty state missing');
  assert.equal(collect(card, 'project-flow-listRow').length, 0);
});

check('TasksCard: empty tasks render the generic ledger copy', () => {
  const card = probe.TasksCard({ tasks: probe.normalize({}).tasks, t, now: NOW });
  const body = JSON.stringify(card);
  assert.ok(body.includes('任务台账里没有进行中的任务。'), 'active empty copy missing');
  assert.ok(body.includes('任务台账里还没有完成的任务。'), 'recent empty copy missing');
  assert.ok(!body.includes('JSON'), 'empty copy still names a JSON ledger');
  assert.equal(collect(card, 'project-flow-listRow').length, 0);
});

check('TasksCard: drafts render a todo section ahead of the active list', () => {
  const payload = probe.normalize({
    tasks: {
      total: 3,
      counts: { draft: 2, active: 1 },
      current: null,
      draft: [
        { id: 'T-D1', title: 'draft one', owner: 'alice', updated_at: '2026-10-28T10:00:00+08:00' },
        { id: 'T-D2', title: 'draft two', owner: '', updated_at: '2026-10-20T10:00:00+08:00' },
      ],
      active: [
        { id: 'T-A1', title: 'active one', status: 'active', owner: '', updated_at: '2026-10-28T09:00:00+08:00' },
      ],
      recentDone: [],
    },
  });
  assert.equal(payload.tasks.draft.length, 2, 'normalize dropped the draft array');
  const card = probe.TasksCard({ tasks: payload.tasks, t, now: NOW });
  const body = JSON.stringify(card);
  assert.ok(body.includes('待办（草稿）'), 'draft section title missing');
  assert.equal(collect(card, 'project-flow-listRow').length, 3, 'expected two drafts + one active row');
  const ids = collect(card, 'project-flow-listId').map((element) => element.children[0]);
  assert.deepEqual(ids, ['T-D1', 'T-D2', 'T-A1'], 'drafts must render before the active list');
  assert.ok(body.includes('draft one'), 'draft title missing');
  assert.ok(body.includes('draft two'), 'second draft title missing');
  assert.ok(body.includes('负责人 alice'), 'draft owner missing');
  assert.ok(collect(card, 'project-flow-listMeta').length >= 2, 'draft meta line missing');

  const english = probe.TasksCard({ tasks: payload.tasks, t: tEn, now: NOW });
  const englishText = JSON.stringify(english);
  assert.ok(englishText.includes('Todo (drafts)'), 'en draft section title missing');
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
  assert.equal(collect(card, 'project-flow-listRow').length, 2, 'active/recent rows must be unchanged');

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
  assert.equal(collect(card, 'project-flow-listRow').length, 25, 'draft rows must cap at 25');
  const body = JSON.stringify(card);
  assert.ok(body.includes('T-D25'), 'last visible draft row missing');
  assert.ok(!body.includes('T-D26'), 'a 26th draft row leaked through');
  assert.ok(body.includes('还有 5 条未显示'), 'draft overflow copy missing');
  assert.equal(collect(card, 'project-flow-more').length, 1, 'overflow line missing');

  const english = probe.TasksCard({ tasks: payload.tasks, t: tEn, now: NOW });
  const englishText = JSON.stringify(english);
  assert.ok(englishText.includes('5 more not shown'), 'en overflow copy missing');
  assert.ok(!/[\u4e00-\u9fff]/.test(englishText), 'en overflow copy still contains Chinese');
});

check('SignalsCard: gate tail, stale heartbeat warning and collapsed runs', () => {
  const card = probe.SignalsCard({
    gate: view.gate,
    heartbeats: view.heartbeats,
    runs: view.runs,
    t,
    now: NOW,
  });
  const pre = collect(card, 'project-flow-pre');
  assert.equal(pre.length, 1, 'gate log <pre> missing (runs are collapsed by default)');
  assert.equal(pre[0].children[0], 'a\nb\nc');
  assert.equal(collect(card, 'project-flow-chip--warn').length, 1, 'stale heartbeat not flagged');
  assert.equal(collect(card, 'project-flow-runHead').length, 1, 'run row missing');
  assert.ok(clickEverything(card) >= 4, 'section + run toggles missing');
});

check('SignalsCard: empty signals render the empty copy', () => {
  const empty = probe.normalize({});
  const card = probe.SignalsCard({
    gate: empty.gate,
    heartbeats: empty.heartbeats,
    runs: empty.runs,
    t,
    now: NOW,
  });
  const body = JSON.stringify(card);
  assert.ok(body.includes('还没有门禁日志。'), 'gate empty copy missing');
  assert.ok(body.includes('没有心跳文件。'), 'heartbeat empty copy missing');
  assert.ok(body.includes('近 15 分钟没有运行中的输出。'), 'runs empty copy missing');
  assert.equal(collect(card, 'project-flow-pre').length, 0);
});

check('SignalsCard: gate null shows the disabled copy instead of an empty log', () => {
  const noGate = probe.normalize({ gate: null });
  const card = probe.SignalsCard({
    gate: noGate.gate,
    heartbeats: [],
    runs: [],
    t,
    now: NOW,
  });
  const body = JSON.stringify(card);
  assert.ok(body.includes('该项目未启用门禁日志。'), 'gate-disabled copy missing');
  assert.ok(!body.includes('还没有门禁日志。'), 'generic empty copy leaked');
  assert.equal(collect(card, 'project-flow-pre').length, 0);
  const english = probe.SignalsCard({
    gate: noGate.gate,
    heartbeats: [],
    runs: [],
    t: tEn,
    now: NOW,
  });
  assert.ok(JSON.stringify(english).includes('This project has no gate log.'), 'en copy missing');
});

check('SignalsCard: a literal null gate prop does not throw', () => {
  const card = probe.SignalsCard({ gate: null, heartbeats: null, runs: null, t, now: NOW });
  assert.ok(card, 'card did not render');
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
    probe.ExperimentTree({ exp: v.exp, t }),
    probe.TasksCard({ tasks: v.tasks, t, now: NOW }),
    probe.GatesCard({ gates: v.gates, t, now: NOW }),
    probe.SignalsCard({ gate: v.gate, heartbeats: v.heartbeats, runs: v.runs, t, now: NOW }),
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

const hostFixtures = ['state-auto.json', 'state-store.json', 'state-not-initialized.json'];
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
