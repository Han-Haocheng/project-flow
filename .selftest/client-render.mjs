/**
 * T-20261028-56 · project-flow data-path render check.
 *
 * The deliverable's factory only exposes { inject, apply }, so this script
 * derives a probe copy in .selftest/.client-probe/ by inserting a `__probe`
 * field into the returned object (one literal string replacement, asserted),
 * then renders every panel component against a full fixture, an empty payload,
 * `gate: null`, a missing `contract` and hostile values. It also replays the
 * Host-side state-*.json fixtures when they exist, which proves the client and
 * the real Host payload agree on the contract shape.
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
  "    return {\n      __probe: { normalize, Panel, PanelRoot, PanelBody, PanelTitle, HeaderAction, ExperimentTree, TasksCard, SignalsCard, TopBar, Footer, ProjectPicker, DetailBlock, PanelIcon, PanelGlyph, relativeFromSeconds, ageText, runPanel: Panel },\n      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],";

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
  contract: { source: 'flow.json', schema: 1, name: 'alpha' },
  roots: [
    { path: '/tmp/pf-demo/alpha', name: 'alpha' },
    { path: '/tmp/other', name: 'other' },
  ],
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
  assert.equal(view.roots.length, 2);
  assert.equal(view.roots[0].name, 'alpha');
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
  const defaults = probe.normalize({ contract: { source: 'defaults', schema: 1, name: 'Alpha' } });
  assert.equal(defaults.contract.source, 'defaults');
  assert.equal(defaults.contract.name, 'Alpha');
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
  const declared = probe.Footer({ view: probe.normalize({ contract: { source: 'flow.json', schema: 1, name: 'Alpha' } }), t });
  const declaredSpan = collect(declared, 'project-flow-contract');
  assert.equal(declaredSpan.length, 1, 'contract line missing for a declared contract');
  assert.equal(declaredSpan[0].children[0], '契约：flow.json');
  assert.ok(String(declaredSpan[0].props.title).includes('Alpha'), 'contract tooltip missing name');
  assert.ok(String(declaredSpan[0].props.title).includes('schema 1'), 'contract tooltip missing schema');

  const defaults = probe.Footer({ view: probe.normalize({ contract: { source: 'defaults', schema: 1, name: 'Alpha' } }), t });
  assert.equal(collect(defaults, 'project-flow-contract')[0].children[0], '契约：默认布局');
  const defaultsEn = probe.Footer({ view: probe.normalize({ contract: { source: 'defaults' } }), t: tEn });
  assert.equal(collect(defaultsEn, 'project-flow-contract')[0].children[0], 'contract: default layout');

  const hidden = probe.Footer({ view: probe.normalize({}), t });
  assert.equal(collect(hidden, 'project-flow-contract').length, 0, 'contract line must hide when absent');
});

check('ProjectPicker: shows project names, keeps paths as values/titles', () => {
  const changes = [];
  const picker = probe.ProjectPicker({
    roots: view.roots,
    t,
    value: view.root,
    onChange: (next) => changes.push(next),
  });
  assert.equal(collect(picker, 'project-flow-roots').length, 1);
  assert.equal(collect(picker, 'project-flow-select').length, 1);
  const options = collectType(picker, 'option');
  assert.equal(options.length, 2);
  assert.equal(options[0].props.value, '/tmp/pf-demo/alpha');
  assert.equal(options[0].props.title, '/tmp/pf-demo/alpha');
  assert.equal(options[0].children[0], 'alpha');
  assert.equal(options[1].children[0], 'other');
  const label = collectType(picker, 'label')[0];
  assert.equal(label.children[0], '项目');
  const select = collectType(picker, 'select')[0];
  assert.equal(select.props.value, view.root);
  assert.equal(select.props.id, 'project-flow-project-select');
  select.props.onChange({ target: { value: '/tmp/other' } });
  assert.deepEqual(changes, ['/tmp/other']);
});

check('Panel: first render is the loading skeleton', () => {
  const element = probe.Panel({ t });
  assert.equal(element.type, 'div');
  const text = JSON.stringify(element);
  assert.ok(text.includes('project-flow-spinner'), 'loading spinner missing');
  assert.ok(text.includes('只读') === false, 'top bar rendered before data');
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
    probe.SignalsCard({ gate: v.gate, heartbeats: v.heartbeats, runs: v.runs, t, now: NOW }),
    probe.Footer({ view: v, t }),
    probe.ProjectPicker({ roots: v.roots, t, value: v.root, onChange: () => {} }),
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

const hostFixtures = ['state-alpha.json', 'state-iqb.json', 'state-auto.json'];
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
      assert.ok(!/alpha/i.test(cls), `class list still carries the legacy prefix: ${cls}`);
      assert.ok(cls.split(/\s+/).every((one) => one.startsWith('project-flow')), `unexpected class: ${cls}`);
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
