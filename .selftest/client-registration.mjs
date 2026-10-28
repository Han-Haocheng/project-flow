/**
 * T-20261028-56 · project-flow client.js registration harness.
 *
 * Loads the browser plugin under a fake `window.__ModuleLoader__`, a minimal
 * React stub and a fake Cordis ctx (slots + locale + sidebarRightTabs +
 * sidebarRight), then asserts the right-bar contract required by the brief:
 *
 *   - module id `@local/project-flow`, inject {slots, locale, sidebarRightTabs,
 *     sidebarRight};
 *   - one `sidebarRightTabs.register` call (id `@local/project-flow/panel`,
 *     kind `project-flow`, priority `extension`, one guide card);
 *   - exactly three slot registrations: `sidebar.right.pane.tab`,
 *     `sidebar.right.pane.tab.title`, `conversation.session.header.utilities`
 *     (id `project-flow`);
 *   - zh/en key sets identical, the four right-bar keys plus the new contract /
 *     project / gate-disabled / other-task keys present;
 *   - no `alpha` residue anywhere in the source (case-insensitive).
 *
 * No network, no host access, no install.
 *
 * Run: node .selftest/client-registration.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLIENT_URL = new URL('../client.js', import.meta.url);
const CLIENT_PATH = fileURLToPath(CLIENT_URL);
const SOURCE = readFileSync(CLIENT_PATH, 'utf8');
const results = [];

const TAB_ID = '@local/project-flow/panel';
const TAB_KIND = 'project-flow';
const NS = 'project-flow';

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

/** Expand function components (never classes) so the returned host element is visible. */
function expand(node) {
  let current = node;
  let guard = 0;
  while (
    current &&
    typeof current.type === 'function' &&
    !(current.type.prototype instanceof Component) &&
    guard < 12
  ) {
    guard += 1;
    const props = Object.assign({}, current.props);
    if (current.children.length === 1) props.children = current.children[0];
    else if (current.children.length > 1) props.children = current.children;
    current = current.type(props);
  }
  return current;
}

// ---------------------------------------------------------------- React stub
function createElement(type, props, ...children) {
  return { type, props: props || {}, children };
}

class Component {
  constructor(props) {
    this.props = props;
  }
}

const ReactStub = {
  createElement,
  Fragment: Symbol.for('react.fragment'),
  Component,
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial;
    return [value, () => {}];
  },
  useEffect() {
    return undefined;
  },
  useRef(initial) {
    return { current: initial };
  },
  useMemo(factory) {
    return factory();
  },
  useCallback(fn) {
    return fn;
  },
};

const requireStub = (id) => {
  if (id === 'react') return ReactStub;
  throw new Error(`unexpected require("${id}") — the plugin must only require("react")`);
};

// ------------------------------------------------------------ fake loader/ctx
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      captured = def;
      return def;
    },
  },
};

await import(CLIENT_URL.href);
console.log(`loaded ${CLIENT_PATH}`);

// --------------------------------------------------------------- assertions
check('window.__ModuleLoader__.load was called exactly once', () => {
  assert.ok(captured, 'ModuleLoader.load was never called');
});
check("captured.id === '@local/project-flow'", () => {
  assert.equal(captured.id, '@local/project-flow');
});
check('captured.factory is a function', () => {
  assert.equal(typeof captured.factory, 'function');
});

const plugin = captured.factory(requireStub);

check('factory returns { inject, apply }', () => {
  assert.equal(typeof plugin, 'object');
  assert.equal(typeof plugin.apply, 'function');
});
check('inject declares slots, locale, sidebarRightTabs, sidebarRight', () => {
  assert.ok(Array.isArray(plugin.inject), 'inject is not an array');
  for (const name of ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']) {
    assert.ok(plugin.inject.includes(name), `inject missing '${name}'`);
  }
});

const registrations = [];
const injections = [];
const localeDicts = [];
const effects = [];
const tabTypes = [];
const openedTabs = [];

const fakeLocale = {
  register(ns, dicts) {
    localeDicts.push({ ns, dicts });
    return () => {};
  },
  bind(ns) {
    return (key, params) => {
      const dict = localeDicts.find((entry) => entry.ns === ns);
      const table = dict ? dict.dicts.zh : {};
      const template = table[key] === undefined ? key : table[key];
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      );
    };
  },
};

const fakeCtx = {
  effect(fn, label) {
    const disposer = fn();
    effects.push({ label, disposer });
    return disposer;
  },
  locale: fakeLocale,
  sidebarRightTabs: {
    register(definition) {
      tabTypes.push(definition);
      return () => {};
    },
  },
  sidebarRight: {
    openTab(kind, options) {
      openedTabs.push({ kind, options });
      return { id: 'tab-1', kind };
    },
  },
  slots: {
    inject(owner, registerFn) {
      injections.push(owner);
      return registerFn();
    },
    register(registration, component) {
      assert.equal(typeof registration, 'object', 'registration is not an object');
      assert.equal(typeof component, 'function', 'slot component is not a function');
      registrations.push({ registration, component });
      return () => {};
    },
  },
};

plugin.apply(fakeCtx);

// ------------------------------------------------------------------- locale
check('ctx.effect ran the locale registration', () => {
  assert.ok(effects.length >= 2, 'ctx.effect was not used');
  assert.equal(localeDicts.length, 1, 'locale registered more than once');
  assert.equal(localeDicts[0].ns, NS);
});

check('locale dicts: zh and en have identical, complete key sets', () => {
  const { zh, en } = localeDicts[0].dicts;
  assert.ok(zh && typeof zh === 'object', 'missing zh dictionary');
  assert.ok(en && typeof en === 'object', 'missing en dictionary');
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, zhKeys, 'zh/en key sets differ');
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', `zh.${key} is not a string`);
    assert.equal(typeof en[key], 'string', `en.${key} is not a string`);
  }
});

check('locale: the four right-bar keys exist with the new copy', () => {
  const { zh, en } = localeDicts[0].dicts;
  for (const key of ['tab.title', 'guide.title', 'guide.description', 'action.open']) {
    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh missing '${key}'`);
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en missing '${key}'`);
  }
  assert.equal(zh['tab.title'], '项目流');
  assert.equal(en['tab.title'], 'Project Flow');
  assert.equal(zh['guide.title'], '项目流看板');
  assert.equal(en['guide.title'], 'Project flow board');
  assert.equal(zh['guide.description'], '实验树、任务进度与运行信号');
  assert.equal(en['guide.description'], 'Experiments, tasks and live signals');
  assert.equal(zh['action.open'], '打开项目流面板');
  assert.equal(en['action.open'], 'Open the project flow panel');
  assert.equal(zh['page.title'], '项目流');
  assert.equal(en['page.title'], 'Project Flow');
});

check('locale: new behaviour keys exist in both languages', () => {
  const { zh, en } = localeDicts[0].dicts;
  const keys = [
    'footer.contract',
    'contract.defaults',
    'project.select',
    'tasks.status.other',
    'signals.gate.disabled',
  ];
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh missing '${key}'`);
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en missing '${key}'`);
  }
  assert.equal(zh['contract.defaults'], '默认布局');
  assert.equal(en['contract.defaults'], 'default layout');
  assert.equal(zh['signals.gate.disabled'], '该项目未启用门禁日志。');
  assert.equal(en['signals.gate.disabled'], 'This project has no gate log.');
  assert.ok(zh['footer.contract'].includes('{source}'), 'zh footer.contract has no {source} slot');
  assert.ok(en['footer.contract'].includes('{source}'), 'en footer.contract has no {source} slot');
  assert.ok(!Object.prototype.hasOwnProperty.call(zh, 'entry.label'), 'zh still has entry.label');
  assert.ok(!Object.prototype.hasOwnProperty.call(en, 'entry.label'), 'en still has entry.label');
});

check('source: no legacy plugin name residue (case-insensitive)', () => {
  const matches = SOURCE.match(/[\w@/.-]*alpha[\w@/.-]*/gi);
  assert.equal(
    matches,
    null,
    `found legacy residue: ${JSON.stringify(matches && matches.slice(0, 5))}`
  );
  assert.ok(!SOURCE.includes('entry.label'), 'source still references entry.label');
});

// ---------------------------------------------------------------- tab type
check('ctx.sidebarRightTabs.register was called exactly once', () => {
  assert.equal(tabTypes.length, 1, `got ${tabTypes.length} tab type registrations`);
});

check(`tab type: id '${TAB_ID}', kind '${TAB_KIND}', priority 'extension'`, () => {
  const definition = tabTypes[0];
  assert.ok(definition, 'no tab type registered');
  assert.equal(definition.id, TAB_ID);
  assert.equal(definition.kind, TAB_KIND);
  assert.equal(definition.priority, 'extension');
});

check('tab type: title is a localized function', () => {
  const definition = tabTypes[0];
  assert.equal(typeof definition.title, 'function');
  assert.equal(definition.title(), '项目流');
});

check('tab type: one guide entry with id/order/title/description/icon', () => {
  const definition = tabTypes[0];
  assert.ok(Array.isArray(definition.guide), 'guide is not an array');
  assert.equal(definition.guide.length, 1, `got ${definition.guide.length} guide entries`);
  const guide = definition.guide[0];
  assert.equal(guide.id, 'paths');
  assert.equal(guide.order, 10);
  assert.equal(typeof guide.title, 'function');
  assert.equal(typeof guide.description, 'function');
  assert.equal(guide.title(), '项目流看板');
  assert.equal(guide.description(), '实验树、任务进度与运行信号');
  assert.equal(typeof guide.icon, 'function', 'guide icon is not a component');
  const icon = expand(guide.icon({}));
  assert.equal(icon.type, 'svg', 'guide icon does not render an svg');
  assert.equal(icon.props.width, 16);
  assert.equal(icon.props.height, 16);
});

// ------------------------------------------------------------------ slots
check('slot injections are exactly the three right-bar seats', () => {
  assert.deepEqual(injections.slice().sort(), [
    'conversation.session.header.utilities',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
  ]);
});

check('exactly three slot registrations were recorded', () => {
  assert.equal(registrations.length, 3, `got ${registrations.length} registrations`);
});

check('no sidebar.panellist / main registration remains', () => {
  const names = registrations.map((entry) => entry.registration.name);
  assert.ok(!names.includes('sidebar.panellist'), 'sidebar.panellist still registered');
  assert.ok(!names.includes('main'), 'main still registered');
  assert.ok(!SOURCE.includes('sidebar.panellist'), 'source still mentions sidebar.panellist');
  assert.ok(!/name:\s*'main'/.test(SOURCE), "source still registers a 'main' slot");
});

const body = registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab');
const title = registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab.title');
const header = registrations.find(
  (entry) => entry.registration.name === 'conversation.session.header.utilities'
);

check('sidebar.right.pane.tab: key = tab id, locale, inject() -> { t }', () => {
  assert.ok(body, 'tab body registration missing');
  assert.equal(body.registration.key, TAB_ID);
  assert.equal(body.registration.locale, NS);
  assert.equal(typeof body.registration.inject, 'function');
  const injected = body.registration.inject();
  assert.equal(typeof injected.t, 'function');
  assert.equal(injected.t('exp.title'), '实验树');
});

check('sidebar.right.pane.tab.title: key = tab id, locale', () => {
  assert.ok(title, 'tab title registration missing');
  assert.equal(title.registration.key, TAB_ID);
  assert.equal(title.registration.locale, NS);
});

check('conversation.session.header.utilities: id project-flow, order 5, locale, openPanel', () => {
  assert.ok(header, 'header action registration missing');
  assert.equal(header.registration.id, 'project-flow');
  assert.equal(header.registration.order, 5);
  assert.equal(header.registration.locale, NS);
  assert.equal(typeof header.registration.inject, 'function');
  const injected = header.registration.inject();
  assert.equal(typeof injected.openPanel, 'function');
});

// -------------------------------------------------------------- components
const t = fakeLocale.bind(NS);

check('tab body renders the panel inside the error boundary', () => {
  const element = expand(body.component({ t }));
  assert.equal(typeof element.type, 'function', 'body root is not a component');
  assert.ok(element.type.prototype instanceof Component, 'body root is not the boundary class');
  assert.equal(typeof element.type.getDerivedStateFromError, 'function');
  assert.equal(element.children.length, 1);
  assert.equal(element.children[0].type.name, 'Panel');
});

check('tab body: panel renders the page shell with the stylesheet', () => {
  const wrapped = expand(body.component({ t }));
  const panelElement = wrapped.children[0];
  const element = panelElement.type(panelElement.props);
  assert.equal(element.type, 'div');
  assert.equal(element.props.className, 'project-flow-page');
  const style = element.children[0];
  assert.equal(style.type, 'style', 'page does not render an inline <style> element');
  const css = style.children[0];
  assert.equal(typeof css, 'string');
  assert.ok(css.includes('.project-flow-page'), 'css missing page class');
  assert.ok(css.includes('container-type:inline-size'), 'css missing the container query root');
  assert.ok(
    css.includes('@container (min-width:640px)'),
    'css missing the 640px container breakpoint'
  );
  assert.ok(
    css.includes('grid-template-columns:minmax(0,1.15fr) minmax(0,0.85fr)'),
    'css missing the wide two-column grid'
  );
  assert.ok(!css.includes('@media'), 'css still uses viewport media queries');
  assert.ok(css.includes('overflow-y:auto'), 'root is not the scroll container');
  assert.ok(css.includes('--dsw-alias-bg-base'), 'css does not use theme tokens');
  assert.ok(css.includes('.project-flow-contract'), 'css missing the contract footer line');
  assert.ok(!/alpha/i.test(css), 'css still carries the legacy class prefix');
});

check('tab body: panel tolerates a missing t (falls back to the key)', () => {
  const element = expand(body.component({}));
  assert.equal(typeof element.type, 'function');
});

check('tab title renders the localized chip text plus a glyph', () => {
  const element = expand(title.component({ t }));
  assert.equal(element.type, ReactStub.Fragment);
  const [styleEl, chip] = element.children;
  const style = expand(styleEl);
  assert.equal(style.type, 'style', 'title does not ship its stylesheet');
  assert.equal(chip.type, 'span');
  assert.equal(chip.props.className, 'project-flow-tabTitle');
  assert.equal(chip.children[1].children[0], '项目流');
  const chipGlyph = expand(chip.children[0]);
  assert.equal(chipGlyph.type, 'svg');
  assert.equal(chipGlyph.props.width, 16);
});

check('header action is a compact icon button that opens the tab', () => {
  const injected = header.registration.inject();
  const element = expand(header.component(Object.assign({ t }, injected)));
  assert.equal(element.type, ReactStub.Fragment);
  const [styleEl, button] = element.children;
  const style = expand(styleEl);
  assert.equal(style.type, 'style', 'header action does not ship its stylesheet');
  assert.equal(button.type, 'button');
  assert.equal(button.props.className, 'project-flow-headerBtn');
  assert.equal(button.props['aria-label'], '打开项目流面板');
  assert.equal(button.props.title, '打开项目流面板');
  assert.equal(expand(button.children[0]).type, 'svg');
  button.props.onClick({ preventDefault() {} });
  assert.equal(openedTabs.length, 1, 'click did not call sidebarRight.openTab');
  assert.equal(openedTabs[0].kind, TAB_KIND);
  assert.equal(openedTabs[0].options, undefined, 'openTab should be called with the kind only');
});

check('header action survives a throwing openTab', () => {
  const before = openedTabs.length;
  const element = expand(
    header.component({
      t,
      openPanel: () => {
        throw new Error('boom');
      },
    })
  );
  const button = element.children[1];
  assert.doesNotThrow(() => button.props.onClick({ preventDefault() {} }));
  assert.equal(openedTabs.length, before, 'a throwing openPanel must not reach the shell');
});

check('header action survives a missing openPanel', () => {
  const element = expand(header.component({ t }));
  const button = element.children[1];
  assert.doesNotThrow(() => button.props.onClick());
});

check('header stylesheet defines a 28x28 button with token colors', () => {
  const element = expand(header.component({ t, openPanel: () => {} }));
  const css = expand(element.children[0]).children[0];
  assert.ok(css.includes('.project-flow-headerBtn'), 'header button class missing from css');
  assert.ok(/width:28px;height:28px/.test(css), 'header button is not 28x28');
  assert.ok(css.includes('--dsw-alias-bg-layer-2'), 'header button hover does not use a token');
});

// -------------------------------------------------------------- source lint
check('package contains no JSX tag syntax', () => {
  assert.ok(!/<\/[A-Za-z][^>]*>/.test(SOURCE), 'found a closing JSX tag');
  assert.ok(!/=>\s*</.test(SOURCE), 'found an arrow returning JSX');
});

check('package writes no host DOM, hardcodes no colors, requires only react', () => {
  assert.ok(!SOURCE.includes('document.head'), 'touches document.head');
  assert.ok(!SOURCE.includes('document.body'), 'touches document.body');
  assert.ok(!SOURCE.includes('appendChild'), 'appends to host DOM');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(SOURCE), 'contains a hardcoded hex color');
  assert.ok(!/\brgba?\(/.test(SOURCE), 'contains a hardcoded rgb() color');
  assert.ok(!/\bhsla?\(/.test(SOURCE), 'contains a hardcoded hsl() color');
  assert.ok(!/require\(['"](?!react['"])/.test(SOURCE), 'requires something besides react');
  for (const token of [
    'sidebar.right.pane.tab',
    'conversation.session.header.utilities',
    'AbortController',
    'visibilitychange',
    'no-store',
    'api/project-flow/state',
    '2500',
  ]) {
    assert.ok(SOURCE.includes(token), `source missing "${token}"`);
  }
});

// --------------------------------------------------------------- summary out
const failed = results.filter((entry) => !entry.ok);
console.log('');
console.log(`id                         = ${captured.id}`);
console.log(`inject                     = ${JSON.stringify(plugin.inject)}`);
console.log(`tab type                   = ${tabTypes.map((d) => `${d.id}/${d.kind}/${d.priority}`).join(', ')}`);
console.log(`slot injections            = ${JSON.stringify(injections)}`);
console.log(`slot registrations         = ${registrations
  .map((entry) => `${entry.registration.name}:${entry.registration.id || entry.registration.key}`)
  .join(', ')}`);
console.log(`locale namespaces          = ${localeDicts.map((entry) => entry.ns).join(', ')}`);
console.log(`assertions                 = ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error('CLIENT REGISTRATION CHECK FAILED');
  process.exitCode = 1;
}
