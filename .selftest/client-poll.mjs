/**
 * T-20261028-56 · project-flow polling-contract check.
 *
 * Drives the Panel component with an inline-effect hook runtime and a fake
 * window/document/fetch, then asserts the brief's polling rules:
 *   - one immediate GET to `api/project-flow/state?root=<workspace cwd>`
 *     (document relative, no-store, encoded root);
 *   - 2500 ms interval, abort on the next request and on unmount;
 *   - no request while document.hidden, immediate refresh on visibilitychange;
 *   - a failed poll records the error but never overwrites the last snapshot;
 *   - payloads with `gate: null` or without `contract` still poll normally;
 *   - without a resolved workspace root the panel polls nothing at all.
 *
 * It also drives `ErrorState` directly: the `not-initialized` card's Initialize
 * button issues exactly one `POST api/project-flow/init` with
 * `{"root":"<workspace>"}`, calls `onInitialized` only on `ok:true`, and records
 * the host message on failure; every other code keeps the read-only Retry button.
 *
 * No network, no host access.
 *
 * Run: node .selftest/client-poll.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../client.js', import.meta.url));
const PROBE_DIR = fileURLToPath(new URL('./.client-probe/', import.meta.url));
const PROBE = PROBE_DIR + 'client.poll.js';
const SOURCE = readFileSync(SRC, 'utf8');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL ${name}`);
    console.log('     ' + String((error && error.message) || error).split('\n').join('\n     '));
  }
}

const ANCHOR = "    return {\n      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],";
const REPLACEMENT =
  "    return {\n      __probe: { Panel: Panel, normalize: normalize, ErrorState: ErrorState },\n      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],";
assert.equal(SOURCE.split(ANCHOR).length - 1, 1, 'probe anchor not found exactly once');
mkdirSync(PROBE_DIR, { recursive: true });
writeFileSync(PROBE, SOURCE.replace(ANCHOR, REPLACEMENT));

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      captured = def;
      return def;
    },
  },
};
await import(new URL('./.client-probe/client.poll.js', import.meta.url).href);

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const DEFAULT_ROOT = '/tmp/pf-demo/Alpha';

const PAYLOAD = {
  ok: true,
  generatedAt: '2026-10-28T11:30:00+08:00',
  contract: { source: 'flow.json', schema: 1, name: 'Alpha' },
  root: '/tmp/pf-demo/Alpha',
  roots: [{ path: '/tmp/pf-demo/Alpha', name: 'Alpha' }],
  experiments: { total: 0, groups: [] },
  tasks: { total: 0, counts: { other: 0 } },
  gate: { lines: [], mtime: null },
  heartbeats: [],
  runs: [],
  warnings: [],
};

function makeEnv(options) {
  const env = {
    hidden: options.hidden === true,
    fetches: [],
    intervals: [],
    aborts: [],
    visibilityHandlers: [],
    stateCalls: [],
    cleanups: [],
    respond: options.respond,
  };

  env.fetch = (url, init) => {
    env.fetches.push({ url, init });
    return env.respond(url, init);
  };

  env.document = {
    get hidden() {
      return env.hidden;
    },
    addEventListener(type, handler) {
      if (type === 'visibilitychange') env.visibilityHandlers.push(handler);
    },
    removeEventListener(type, handler) {
      env.visibilityHandlers = env.visibilityHandlers.filter((item) => item !== handler);
    },
  };

  env.window = {
    fetch: env.fetch,
    setInterval(fn, delay) {
      env.intervals.push({ fn, delay });
      return env.intervals.length;
    },
    clearInterval(id) {
      env.intervals[id - 1] = null;
    },
  };

  env.AbortController = class RecordingAbortController {
    constructor() {
      this.signal = { aborted: false };
      env.aborts.push(this);
    }
    abort() {
      this.signal.aborted = true;
    }
  };

  env.react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: Symbol.for('react.fragment'),
    Component: class Component {},
    useState(initial) {
      const index = env.stateIndex === undefined ? 0 : env.stateIndex;
      env.stateIndex = index + 1;
      const value = typeof initial === 'function' ? initial() : initial;
      return [
        value,
        (next) => {
          env.stateCalls.push({ index, next: typeof next === 'function' ? next(value) : next });
        },
      ];
    },
    useEffect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') env.cleanups.push(cleanup);
      return cleanup;
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

  return env;
}

function boot(options = {}) {
  const env = makeEnv(options);
  globalThis.document = env.document;
  globalThis.window = Object.assign({}, globalThis.window, env.window);
  globalThis.AbortController = env.AbortController;
  const plugin = captured.factory((id) => {
    if (id === 'react') return env.react;
    throw new Error(`unexpected require("${id}")`);
  });
  /* The panel is workspace-scoped; every boot names the workspace it polls. */
  const workspaceRoot = Object.prototype.hasOwnProperty.call(options, 'workspaceRoot')
    ? options.workspaceRoot
    : DEFAULT_ROOT;
  const element = plugin.__probe.Panel({ t: (key) => key, workspaceRoot });
  return { env, element, probe: plugin.__probe };
}

const okResponseFor = (payload) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload),
});
const okResponse = () => okResponseFor(PAYLOAD);
const failResponse = () => ({
  ok: false,
  status: 400,
  text: async () =>
    JSON.stringify({ ok: false, error: { code: 'no-project', message: 'not a project' } }),
});

/** Render `ErrorState` alone against a fresh hook runtime + fake fetch. */
function bootErrorState(props, options = {}) {
  const env = makeEnv({ respond: options.respond || okResponse });
  globalThis.document = env.document;
  globalThis.window = Object.assign({}, globalThis.window, env.window);
  globalThis.AbortController = env.AbortController;
  const plugin = captured.factory((id) => {
    if (id === 'react') return env.react;
    throw new Error(`unexpected require("${id}")`);
  });
  const t = (key, params) => (params ? key + '(' + JSON.stringify(params) + ')' : key);
  const element = plugin.__probe.ErrorState(
    Object.assign({ t, workspaceRoot: DEFAULT_ROOT }, props)
  );
  return { env, element };
}

const findButton = (element) =>
  (element.children || []).find((child) => child && child.type === 'button');

const first = boot({ respond: okResponse });
await flush();

await check('first poll: one immediate GET to the workspace-scoped endpoint', () => {
  assert.equal(first.env.fetches.length, 1, 'expected exactly one initial request');
  assert.equal(
    first.env.fetches[0].url,
    'api/project-flow/state?root=%2Fmnt%2Fd%2FProject%2FAlpha',
    'first fetch URL is not the encoded workspace root'
  );
  assert.equal(first.env.fetches[0].init.method, 'GET');
  assert.equal(first.env.fetches[0].init.cache, 'no-store');
  assert.equal(first.env.fetches[0].init.headers.accept, 'application/json');
  assert.ok(first.env.fetches[0].init.signal, 'request is not abortable');
});

await check('poll interval is 2500 ms, relative-time clock is 1000 ms', () => {
  const poll = first.env.intervals.find((entry) => entry && entry.delay === 2500);
  assert.ok(poll, 'no 2500 ms interval registered');
  const clock = first.env.intervals.find((entry) => entry && entry.delay === 1000);
  assert.ok(clock, 'no 1000 ms relative-time clock registered');
});

await check('successful poll stores the snapshot and clears the error', () => {
  const stored = first.env.stateCalls.find((call) => call.index === 0);
  assert.ok(stored, 'snapshot was not stored');
  assert.equal(stored.next.root, '/tmp/pf-demo/Alpha');
  assert.equal(stored.next.contract.source, 'flow.json');
  assert.ok(
    first.env.stateCalls.some((call) => call.index === 1 && call.next === null),
    'error state was not cleared'
  );
  assert.ok(
    first.env.stateCalls.some((call) => call.index === 2 && typeof call.next === 'number'),
    'last-success timestamp not recorded'
  );
});

await check('a failed poll records the host error and keeps the last snapshot', async () => {
  const before = first.env.stateCalls.length;
  const snapshotWrites = first.env.stateCalls.filter((call) => call.index === 0).length;
  first.env.respond = failResponse;
  const poll = first.env.intervals.find((entry) => entry && entry.delay === 2500);
  poll.fn();
  await flush();
  const after = first.env.stateCalls.slice(before);
  assert.ok(
    after.some((call) => call.index === 1 && call.next && call.next.code === 'no-project'),
    'error was not recorded with the host code'
  );
  assert.equal(
    first.env.stateCalls.filter((call) => call.index === 0).length,
    snapshotWrites,
    'a failed poll overwrote the last good snapshot'
  );
  assert.equal(first.env.fetches.length, 2);
});

await check('no request while document.hidden, immediate refresh when visible again', async () => {
  const fetchesBefore = first.env.fetches.length;
  first.env.hidden = true;
  first.env.respond = okResponse;
  const poll = first.env.intervals.find((entry) => entry && entry.delay === 2500);
  poll.fn();
  await flush();
  assert.equal(first.env.fetches.length, fetchesBefore, 'fetched while hidden');

  assert.ok(first.env.visibilityHandlers.length >= 1, 'no visibilitychange listener');
  first.env.hidden = false;
  first.env.visibilityHandlers[0]();
  await flush();
  assert.equal(first.env.fetches.length, fetchesBefore + 1, 'visibility did not refresh immediately');
});

await check('the next request aborts the in-flight one', async () => {
  // Hold the response open so a controller stays in flight.
  let release = null;
  first.env.respond = () =>
    new Promise((resolve) => {
      release = () => resolve(okResponse());
    });
  const poll = first.env.intervals.find((entry) => entry && entry.delay === 2500);
  poll.fn();
  await flush();
  const inFlight = first.env.aborts[first.env.aborts.length - 1];
  assert.equal(inFlight.signal.aborted, false);
  poll.fn();
  assert.equal(inFlight.signal.aborted, true, 'previous request was not aborted');
  release();
  await flush();
});

await check('unmount aborts the request and removes the visibility listener', async () => {
  const pollCleanup = first.env.cleanups[first.env.cleanups.length - 1];
  const listeners = first.env.visibilityHandlers.length;
  pollCleanup();
  assert.equal(first.env.visibilityHandlers.length, listeners - 1, 'listener not removed');
});

// ------------------------------------------------ no resolved workspace yet
const pendingBoot = boot({ workspaceRoot: undefined, respond: okResponse });
await flush();
await check('a Panel without a workspace root polls nothing', () => {
  assert.equal(pendingBoot.env.fetches.length, 0, 'requested before a workspace was known');
  assert.equal(
    pendingBoot.env.intervals.filter((entry) => entry && entry.delay === 2500).length,
    0,
    'a 2500 ms polling interval was registered'
  );
  const clock = pendingBoot.env.intervals.find((entry) => entry && entry.delay === 1000);
  assert.ok(clock, 'the relative-time clock should still run');
  assert.ok(
    JSON.stringify(pendingBoot.element).includes('workspace.pending'),
    'pending card does not use the workspace.pending locale'
  );
});

// ------------------------------------------------------- hidden at mount
const hiddenBoot = boot({ hidden: true, respond: okResponse });
await flush();
await check('mounting while hidden sends no request at all', () => {
  assert.equal(hiddenBoot.env.fetches.length, 0, 'requested while document.hidden');
});

// ------------------------------------------------------- network rejection
const brokenBoot = boot({
  respond: () => Promise.reject(new TypeError('failed to fetch')),
});
await flush();
await check('a transport error is captured without throwing', () => {
  const error = brokenBoot.env.stateCalls.find((call) => call.index === 1);
  assert.ok(error, 'transport error not recorded');
  assert.equal(error.next.code, 'network');
  assert.equal(brokenBoot.env.stateCalls.filter((call) => call.index === 0).length, 0);
});

// --------------------------------------------- optional payload shapes
const gateNullBoot = boot({
  respond: () => okResponseFor(Object.assign({}, PAYLOAD, { gate: null, contract: undefined })),
});
await flush();
await check('a payload with gate:null and no contract still polls and stores', () => {
  const stored = gateNullBoot.env.stateCalls.find((call) => call.index === 0);
  assert.ok(stored, 'snapshot with gate:null was rejected');
  assert.equal(stored.next.gate, null, 'raw payload should keep gate:null');
  assert.equal(stored.next.contract, undefined, 'contract should be absent');
  const normalized = gateNullBoot.probe.normalize(stored.next);
  assert.equal(normalized.gate.disabled, true, 'gate:null must map to the disabled flag');
  assert.equal(normalized.contract, null, 'missing contract must normalize to null');
  assert.equal(gateNullBoot.env.stateCalls.filter((call) => call.index === 1)[0].next, null);
});

// ------------------------------------------------------- ErrorState initialize
await check('ErrorState init: one POST to api/project-flow/init with the workspace root', async () => {
  let initialized = 0;
  let release = null;
  const booted = bootErrorState(
    {
      info: { code: 'not-initialized' },
      workspaceRoot: '/tmp/pf-demo/Alpha',
      onInitialized: () => {
        initialized += 1;
      },
    },
    {
      respond: () =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              okResponseFor({
                ok: true,
                root: '/tmp/pf-demo/Alpha',
                name: 'Alpha',
                alreadyInitialized: false,
                created: ['.dsh/flow'],
                imported: 0,
                warnings: [],
              })
            );
        }),
    }
  );

  assert.equal(booted.env.fetches.length, 0, 'rendering the card must not fetch');
  const button = findButton(booted.element);
  assert.ok(button, 'init button missing');
  assert.equal(button.children[0], 'empty.init', 'idle label is not empty.init');
  assert.equal(button.props.disabled, false, 'init button must start enabled');

  const pending = button.props.onClick({ preventDefault() {} });
  await flush();

  assert.equal(booted.env.fetches.length, 1, 'expected exactly one init request');
  const request = booted.env.fetches[0];
  assert.equal(request.url, 'api/project-flow/init');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.credentials, 'same-origin');
  assert.equal(request.init.headers['content-type'], 'application/json');
  assert.equal(request.init.headers.accept, 'application/json');
  assert.equal(request.init.body, '{"root":"/tmp/pf-demo/Alpha"}');
  assert.ok(
    booted.env.stateCalls.some((call) => call.index === 0 && call.next === true),
    'in-flight state (disabled button) not recorded'
  );
  assert.equal(initialized, 0, 'onInitialized fired before the response resolved');
  assert.equal(typeof release, 'function', 'init request never reached the host');

  release();
  await pending;
  await flush();

  assert.equal(initialized, 1, 'onInitialized must be called exactly once on ok:true');
  assert.equal(booted.env.fetches.length, 1, 'a successful init must not retry the POST');
});

await check('ErrorState init: a failing response records the host message and keeps the card', async () => {
  let initialized = 0;
  const booted = bootErrorState(
    {
      info: { code: 'not-initialized' },
      onInitialized: () => {
        initialized += 1;
      },
    },
    {
      respond: () => ({
        ok: false,
        status: 500,
        text: async () =>
          JSON.stringify({ ok: false, error: { code: 'init-failed', message: 'boom' } }),
      }),
    }
  );

  const button = findButton(booted.element);
  await button.props.onClick({ preventDefault() {} });
  await flush();

  assert.equal(initialized, 0, 'onInitialized must not fire on a failed init');
  assert.equal(booted.env.fetches.length, 1);
  assert.equal(booted.env.fetches[0].url, 'api/project-flow/init');
  const message = booted.env.stateCalls.find(
    (call) => typeof call.next === 'string' && call.next.includes('boom')
  );
  assert.ok(message, 'the host message was not recorded in local state');
  assert.equal(message.index, 1, 'the message must be stored in the message state slot');
  assert.ok(
    booted.env.stateCalls.some((call) => call.index === 0 && call.next === false),
    'the init button was not re-enabled after the failure'
  );
});

await check('ErrorState: a generic code keeps Retry and issues no POST', async () => {
  let retries = 0;
  const booted = bootErrorState({
    info: { code: 'no-project' },
    onRetry: () => {
      retries += 1;
    },
  });

  const text = JSON.stringify(booted.element);
  assert.ok(text.includes('error.retry'), 'generic retry label missing');
  assert.ok(!text.includes('error.initHint'), 'init hint leaked into a generic error card');
  assert.ok(!text.includes('empty.init'), 'initialize label leaked into a generic error card');
  const button = findButton(booted.element);
  assert.ok(button, 'retry button missing');
  assert.equal(button.props.disabled, undefined, 'the retry button must not be disabled');

  await button.props.onClick({ preventDefault() {} });
  await flush();
  assert.equal(retries, 1, 'retry handler not wired');
  assert.equal(booted.env.fetches.length, 0, 'a generic error code must not POST anything');
});

// ------------------------------------------------------------- source wiring
await check('the workspace root is sent as an encoded ?root= query', () => {
  assert.ok(
    SOURCE.includes("'?root=' + encodeURIComponent(workspaceRoot)"),
    'encoded ?root= workspace wiring missing'
  );
  assert.ok(!SOURCE.includes('ProjectPicker'), 'global project switcher still present');
  assert.ok(SOURCE.includes("cache: 'no-store'"), 'no-store cache mode missing');
  assert.ok(SOURCE.includes('new AbortController()'), 'AbortController missing');
  assert.ok(SOURCE.includes("document.addEventListener('visibilitychange'"), 'visibility wiring missing');
});

const failed = results.filter((entry) => !entry.ok);
console.log('');
console.log(`assertions                 = ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error('CLIENT POLL CHECK FAILED');
  process.exitCode = 1;
}
