/**
 * T-20261104-01 · project-flow polling-contract check (single-flight poll).
 *
 * Drives the Panel component with an inline-effect hook runtime and a fake
 * window/document/fetch, then asserts the brief's polling rules:
 *   - one immediate GET to `api/project-flow/state?root=<workspace cwd>`
 *     (document relative, no-store, encoded root);
 *   - SINGLE FLIGHT: exactly one request at a time. While a request is in flight
 *     no poll timer is armed at all, so advancing 2500 ms neither aborts it nor
 *     starts a second one; the next poll is armed only after the previous one
 *     settles (success or failure), 2500 ms measured from that settle;
 *   - abort is teardown-only: unmount aborts the in-flight request and clears
 *     the pending timer;
 *   - no request while document.hidden (the chain stays parked), immediate
 *     refresh on visibilitychange, and no parallel request when one is already
 *     in flight (that visibility refresh is honored on settle instead);
 *   - a failed poll records the error but never overwrites the last snapshot;
 *   - payloads without `contract` or `gates` still poll normally, and the
 *     tab's `sessionId` is never sent as a query parameter;
 *   - without a resolved workspace root the panel polls nothing at all.
 *
 * The "single-flight hardening" section at the bottom adds the edge cases the
 * first pass left open: a queue-behind refresh surviving a FAILED settle, pings
 * collapsing into one catch-up request, a duplicated/stale tick starting nothing,
 * a mid-life AbortError being ignored (never recorded, chain intact), a parked
 * hidden chain creating no request and no AbortController, an effect restart
 * (workspace switch) leaving the torn-down chain silent, and a mixed sequence in
 * which no two requests ever overlap and nothing but teardown aborts.
 *
 * It also drives `ErrorState` directly: the `not-initialized` card's Initialize
 * button issues exactly one `POST api/project-flow/init` with
 * `{"root":"<workspace>"}`, calls `onInitialized` only on `ok:true`, and records
 * the host message on failure; every other code keeps the read-only Retry button.
 *
 * No network, no host access. "Advancing time" is modelled by firing the poll
 * timers the panel armed through `window.setTimeout`: the panel has no other
 * polling clock, which is exactly what the single-flight contract asserts.
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

const DEFAULT_ROOT = '/tmp/pf-demo/alpha';

const PAYLOAD = {
  ok: true,
  generatedAt: '2026-10-28T11:30:00+08:00',
  contract: { source: 'flow.json', schema: 2, name: 'demo-alpha' },
  root: '/tmp/pf-demo/alpha',
  roots: [{ path: '/tmp/pf-demo/alpha', name: 'demo-alpha' }],
  experiments: { source: 'store', total: 0, counts: { open: 0 }, items: [], tree: [] },
  tasks: { total: 0, counts: { other: 0 } },
  gates: [],
  heartbeats: { dir: '.agents/heartbeat', items: [], counts: { total: 0 } },
  warnings: [],
};

function makeEnv(options) {
  const env = {
    hidden: options.hidden === true,
    fetches: [],
    intervals: [],
    timers: [],
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
    /*
     * The single-flight poll arms one `POLL_MS` timeout per settled request, so
     * the fake clock records them instead of running them: a test fires them
     * explicitly through `runTimers()` to mean "2500 ms have elapsed".
     */
    setTimeout(fn, delay) {
      env.timers.push({ fn, delay, live: true });
      return env.timers.length;
    },
    clearTimeout(id) {
      const entry = env.timers[id - 1];
      if (entry) entry.live = false;
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
  const sessionId = options.sessionId;
  const element = plugin.__probe.Panel({ t: (key) => key, workspaceRoot, sessionId });
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

/* Armed-but-not-yet-fired fake timeouts, optionally filtered by delay. */
const liveTimers = (env, delay) =>
  env.timers.filter((entry) => entry && entry.live && (delay === undefined || entry.delay === delay));

/*
 * "Advance the wall clock" by firing every timeout the panel armed right now.
 * Under the single-flight contract the panel arms exactly one POLL_MS timeout
 * per settled request, so calling this while a request is in flight fires
 * nothing at all — that is what the in-flight assertions below rely on.
 */
function runTimers(env, delay) {
  const due = liveTimers(env, delay);
  for (const entry of due) {
    entry.live = false;
    entry.fn();
  }
  return due.length;
}

/** A fetch whose response stays open until the returned `release()` runs. */
function holdResponses(env) {
  let release = null;
  env.respond = () =>
    new Promise((resolve) => {
      release = () => resolve(okResponse());
    });
  return { release: () => release() };
}

const first = boot({ respond: okResponse });
await flush();

await check('first poll: one immediate GET to the workspace-scoped endpoint', () => {
  assert.equal(first.env.fetches.length, 1, 'expected exactly one initial request');
  assert.equal(
    first.env.fetches[0].url,
    'api/project-flow/state?root=%2Ftmp%2Fpf-demo%2Falpha',
    'first fetch URL is not the encoded workspace root'
  );
  assert.equal(first.env.fetches[0].init.method, 'GET');
  assert.equal(first.env.fetches[0].init.cache, 'no-store');
  assert.equal(first.env.fetches[0].init.headers.accept, 'application/json');
  assert.ok(first.env.fetches[0].init.signal, 'request is not abortable');
});

await check('the poll re-arms 2500 ms after settling, clock is 1000 ms', () => {
  // One settle → one armed POLL_MS timeout (no fixed interval any more).
  assert.equal(
    liveTimers(first.env, 2500).length,
    1,
    'a settled poll must arm exactly one 2500 ms timeout'
  );
  assert.equal(
    first.env.intervals.filter((entry) => entry && entry.delay === 2500).length,
    0,
    'a 2500 ms interval is still registered instead of a settle-relative timeout'
  );
  const clock = first.env.intervals.filter((entry) => entry && entry.delay === 1000);
  assert.equal(clock.length, 1, 'expected exactly one 1000 ms relative-time clock');
});

await check('successful poll stores the snapshot and clears the error', () => {
  const stored = first.env.stateCalls.find((call) => call.index === 0);
  assert.ok(stored, 'snapshot was not stored');
  assert.equal(stored.next.root, '/tmp/pf-demo/alpha');
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

await check('single flight: a slow request is neither aborted nor duplicated', async () => {
  // Replaces the old "the next tick aborts the in-flight request" assertion:
  // that behaviour is exactly the defect (a 6.4 s host vs a 2.5 s tick).
  const held = holdResponses(first.env);
  const before = first.env.fetches.length;
  assert.equal(runTimers(first.env, 2500), 1, 'the settled poll was not armed exactly once');
  await flush();
  assert.equal(first.env.fetches.length, before + 1, 'the armed tick did not issue a GET');
  const inFlight = first.env.aborts[first.env.aborts.length - 1];
  assert.equal(inFlight.signal.aborted, false, 'the new request started pre-aborted');

  // While the request is in flight no poll timer exists, so advancing 2500 ms
  // neither cancels it nor starts a second request.
  assert.equal(liveTimers(first.env, 2500).length, 0, 'a poll was armed while one was in flight');
  assert.equal(runTimers(first.env, 2500), 0, 'advancing 2500 ms while in flight fired a tick');
  await flush();
  assert.equal(first.env.fetches.length, before + 1, 'a second GET raced the in-flight one');
  assert.equal(inFlight.signal.aborted, false, 'the in-flight request was self-cancelled');

  // Settling is what re-arms the chain, 2500 ms from that moment.
  held.release();
  await flush();
  assert.equal(liveTimers(first.env, 2500).length, 1, 'settling did not re-arm the next poll');
  assert.equal(first.env.fetches.length, before + 1, 'settling fired a request instead of arming');
  assert.equal(runTimers(first.env, 2500), 1, 'the re-armed poll did not fire after 2500 ms');
  await flush();
  assert.equal(first.env.fetches.length, before + 2, 'the re-armed poll did not issue the next GET');
});

// -------------------------------------------------- failure keeps the snapshot
const failBoot = boot({ respond: okResponse });
await flush();

await check('a failed poll records the host error, keeps the snapshot, re-arms', async () => {
  failBoot.env.respond = failResponse;
  const before = failBoot.env.stateCalls.length;
  const snapshotWrites = failBoot.env.stateCalls.filter((call) => call.index === 0).length;
  assert.equal(runTimers(failBoot.env, 2500), 1, 'the settled poll was not armed');
  await flush();
  const after = failBoot.env.stateCalls.slice(before);
  assert.ok(
    after.some((call) => call.index === 1 && call.next && call.next.code === 'no-project'),
    'error was not recorded with the host code'
  );
  assert.equal(
    failBoot.env.stateCalls.filter((call) => call.index === 0).length,
    snapshotWrites,
    'a failed poll overwrote the last good snapshot'
  );
  assert.equal(failBoot.env.fetches.length, 2, 'the failed tick must issue exactly one GET');
  assert.equal(liveTimers(failBoot.env, 2500).length, 1, 'a failure must still re-arm the chain');
  assert.equal(runTimers(failBoot.env, 2500), 1, 'the chain died after a failure');
  await flush();
  assert.equal(failBoot.env.fetches.length, 3, 'the chain did not retry after a failure');
});

// ------------------------------------------------------- hidden / visibility
const visBoot = boot({ respond: okResponse });
await flush();

await check('no request while document.hidden, one immediate refresh when visible', async () => {
  const fetchesBefore = visBoot.env.fetches.length;
  visBoot.env.hidden = true;
  assert.equal(runTimers(visBoot.env, 2500), 1, 'the settled poll was not armed');
  await flush();
  assert.equal(visBoot.env.fetches.length, fetchesBefore, 'fetched while hidden');
  // The hidden chain stays parked instead of dying: it keeps re-arming.
  assert.equal(liveTimers(visBoot.env, 2500).length, 1, 'the hidden chain stopped re-arming');
  assert.equal(runTimers(visBoot.env, 2500), 1, 'the parked hidden chain did not re-arm');
  await flush();
  assert.equal(visBoot.env.fetches.length, fetchesBefore, 'fetched while still hidden');

  assert.ok(visBoot.env.visibilityHandlers.length >= 1, 'no visibilitychange listener');
  visBoot.env.hidden = false;
  visBoot.env.visibilityHandlers[0]();
  await flush();
  assert.equal(
    visBoot.env.fetches.length,
    fetchesBefore + 1,
    'visibility did not refresh immediately'
  );
  assert.equal(liveTimers(visBoot.env, 2500).length, 1, 'the refresh did not re-arm exactly once');
});

let releaseInflight = null;
const inflightVis = boot({
  respond: () =>
    new Promise((resolve) => {
      releaseInflight = () => resolve(okResponse());
    }),
});
await flush();

await check('visibilitychange while a request is in flight starts no second request', async () => {
  assert.equal(inflightVis.env.fetches.length, 1, 'expected exactly one initial request');
  const inFlight = inflightVis.env.aborts[inflightVis.env.aborts.length - 1];
  inflightVis.env.visibilityHandlers[0]();
  await flush();
  assert.equal(inflightVis.env.fetches.length, 1, 'visibility started a parallel request');
  assert.equal(inFlight.signal.aborted, false, 'visibility aborted the in-flight request');
  assert.equal(liveTimers(inflightVis.env, 2500).length, 0, 'a tick was armed while in flight');

  // The queued visibility refresh is honored when the request settles: exactly
  // one extra GET (not two), still single flight.
  releaseInflight();
  await flush();
  assert.equal(inflightVis.env.fetches.length, 2, 'the queued visibility refresh was dropped');
  assert.equal(liveTimers(inflightVis.env, 2500).length, 0, 'two requests overlapped');
  assert.equal(typeof releaseInflight, 'function', 'the second request never reached the host');
  releaseInflight();
  await flush();
  assert.equal(liveTimers(inflightVis.env, 2500).length, 1, 'the chain did not re-arm after settling');
});

// ------------------------------------------------------------------- teardown
const teardownBoot = boot({ respond: okResponse });
await flush();

await check('unmount clears the pending timer and removes the visibility listener', async () => {
  const cleanup = teardownBoot.env.cleanups[teardownBoot.env.cleanups.length - 1];
  const listeners = teardownBoot.env.visibilityHandlers.length;
  const before = teardownBoot.env.fetches.length;
  assert.equal(liveTimers(teardownBoot.env, 2500).length, 1, 'expected an armed poll before unmount');
  cleanup();
  assert.equal(liveTimers(teardownBoot.env, 2500).length, 0, 'the poll timer survived unmount');
  assert.equal(teardownBoot.env.visibilityHandlers.length, listeners - 1, 'listener not removed');
  assert.equal(runTimers(teardownBoot.env, 2500), 0, 'unmount left a fireable timer behind');
  await flush();
  assert.equal(teardownBoot.env.fetches.length, before, 'a request was issued after unmount');
});

const abortBoot = boot({
  respond: () =>
    new Promise((resolve) => {
      releaseInflight = () => resolve(okResponse());
    }),
});
await flush();

await check('unmount aborts the in-flight request and never re-arms the chain', async () => {
  const cleanup = abortBoot.env.cleanups[abortBoot.env.cleanups.length - 1];
  const inFlight = abortBoot.env.aborts[abortBoot.env.aborts.length - 1];
  const callsBefore = abortBoot.env.stateCalls.length;
  assert.equal(inFlight.signal.aborted, false, 'request started pre-aborted');
  cleanup();
  assert.equal(inFlight.signal.aborted, true, 'unmount did not abort the in-flight request');
  const before = abortBoot.env.fetches.length;
  releaseInflight();
  await flush();
  assert.equal(liveTimers(abortBoot.env, 2500).length, 0, 'the unmounted chain re-armed itself');
  assert.equal(abortBoot.env.fetches.length, before, 'a request was issued after unmount');
  assert.equal(abortBoot.env.stateCalls.length, callsBefore, 'state was written after unmount');
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
  assert.equal(
    pendingBoot.env.timers.filter((entry) => entry && entry.delay === 2500).length,
    0,
    'a poll timeout was armed without a workspace'
  );
  assert.equal(runTimers(pendingBoot.env), 0, 'a timer fired without a workspace');
  assert.equal(pendingBoot.env.fetches.length, 0, 'a timer issued a request without a workspace');
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
  // The chain is parked, not dead: it re-arms itself without fetching.
  assert.equal(liveTimers(hiddenBoot.env, 2500).length, 1, 'the hidden chain did not stay parked');
  assert.equal(runTimers(hiddenBoot.env, 2500), 1, 'the parked chain did not re-arm');
  assert.equal(hiddenBoot.env.fetches.length, 0, 'a hidden tick issued a request');
});

// ------------------------------------------------------- network rejection
const brokenBoot = boot({
  respond: () => Promise.reject(new TypeError('failed to fetch')),
});
await flush();
await check('a transport error is captured without throwing and the chain re-arms', () => {
  const error = brokenBoot.env.stateCalls.find((call) => call.index === 1);
  assert.ok(error, 'transport error not recorded');
  assert.equal(error.next.code, 'network');
  assert.equal(brokenBoot.env.stateCalls.filter((call) => call.index === 0).length, 0);
  assert.equal(liveTimers(brokenBoot.env, 2500).length, 1, 'a transport error must still re-arm');
});

// --------------------------------------------- optional payload shapes
const bareBoot = boot({
  respond: () => okResponseFor(Object.assign({}, PAYLOAD, { contract: undefined, gates: undefined })),
});
await flush();
await check('a payload without contract or gates still polls and stores', () => {
  const stored = bareBoot.env.stateCalls.find((call) => call.index === 0);
  assert.ok(stored, 'snapshot without contract/gates was rejected');
  assert.equal(stored.next.contract, undefined, 'contract should be absent');
  assert.equal(stored.next.gates, undefined, 'gates should be absent');
  const normalized = bareBoot.probe.normalize(stored.next);
  assert.equal(normalized.contract, null, 'missing contract must normalize to null');
  assert.equal(normalized.gates, null, 'missing gates must normalize to null');
  assert.equal(bareBoot.env.stateCalls.filter((call) => call.index === 1)[0].next, null);
});

// ------------------------------------------------ session id is not a query
const sessionBoot = boot({ sessionId: 'session-aaaa', respond: okResponse });
await flush();
await check('the session id is never appended to the polling URL', () => {
  assert.equal(sessionBoot.env.fetches.length, 1, 'expected exactly one initial request');
  assert.equal(
    sessionBoot.env.fetches[0].url,
    'api/project-flow/state?root=%2Ftmp%2Fpf-demo%2Falpha',
    'sessionId leaked into the state URL'
  );
  assert.ok(!sessionBoot.env.fetches[0].url.includes('session='), 'query still carries a session parameter');
});

// ------------------------------------------------------- ErrorState initialize
await check('ErrorState init: one POST to api/project-flow/init with the workspace root', async () => {
  let initialized = 0;
  let release = null;
  const booted = bootErrorState(
    {
      info: { code: 'not-initialized' },
      workspaceRoot: '/tmp/pf-demo/alpha',
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
                root: '/tmp/pf-demo/alpha',
                name: 'demo-alpha',
                alreadyInitialized: false,
                created: ['.agents/flow'],
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
  assert.equal(request.init.body, '{"root":"/tmp/pf-demo/alpha"}');
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

// ------------------------------------- single-flight hardening (audit pass)
/*
 * Blind spots the first pass left open, closed here:
 *   - a visibility refresh that had to queue behind a FAILED poll is honored the
 *     moment it settles, not 2500 ms later;
 *   - repeated visibility pings during one flight collapse into ONE catch-up
 *     request instead of one per ping;
 *   - a mid-life AbortError is not a teardown: it is ignored, never recorded as
 *     a poll failure, and never kills the chain;
 *   - a parked hidden chain issues no request and creates no AbortController, so
 *     hiding a tab leaks nothing, and unmount still clears the parked tick;
 *   - an effect restart (workspace switch / manual refresh) aborts only the old
 *     request, and the torn-down chain writes nothing and arms nothing after it;
 *   - across a mixed sequence of ticks, pings, failures and hidden parks, no two
 *     requests ever overlap and nothing but teardown aborts a request.
 */

/** A fetch whose every response stays open until its own release runs. */
function holdQueue(env) {
  const queue = [];
  env.respond = () =>
    new Promise((resolve, reject) => {
      queue.push({ resolve, reject });
    });
  return {
    queue,
    release(index, response) {
      queue[index].resolve(response || okResponse());
    },
  };
}

const abortError = () =>
  Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

await check('a queued visibility refresh survives a FAILED settle and fires at once', async () => {
  const queuedFail = boot({ respond: okResponse });
  await flush();
  const held = holdQueue(queuedFail.env);
  assert.equal(runTimers(queuedFail.env, 2500), 1, 'the settled poll was not armed');
  await flush();
  assert.equal(queuedFail.env.fetches.length, 2, 'the armed tick did not issue a GET');
  assert.equal(held.queue.length, 1, 'the second request never reached the host');

  queuedFail.env.visibilityHandlers[0]();
  await flush();
  assert.equal(queuedFail.env.fetches.length, 2, 'visibility raced the in-flight request');
  assert.equal(liveTimers(queuedFail.env, 2500).length, 0, 'a tick was armed while in flight');

  held.release(0, failResponse());
  await flush();
  assert.equal(
    queuedFail.env.fetches.length,
    3,
    'the queued visibility refresh was dropped by a failed settle'
  );
  assert.equal(
    liveTimers(queuedFail.env, 2500).length,
    0,
    'a tick was armed next to the catch-up refresh instead of being superseded'
  );
  const failure = queuedFail.env.stateCalls.find(
    (call) => call.index === 1 && call.next && call.next.code === 'no-project'
  );
  assert.ok(failure, 'the failed poll did not record the host error');
  assert.equal(typeof failure.next.at, 'number', 'the recorded failure carries no timestamp');
  assert.ok(
    queuedFail.env.stateCalls.some(
      (call) => call.index === 0 && call.next && call.next.root === DEFAULT_ROOT
    ),
    'the last good snapshot was not kept across the failure'
  );

  held.release(1);
  await flush();
  assert.equal(liveTimers(queuedFail.env, 2500).length, 1, 'the chain did not re-arm after the catch-up');
});

await check('repeated visibility pings during one flight collapse into one refresh', async () => {
  const pinged = boot({ respond: okResponse });
  await flush();
  const held = holdQueue(pinged.env);
  assert.equal(runTimers(pinged.env, 2500), 1, 'the settled poll was not armed');
  await flush();
  assert.equal(pinged.env.fetches.length, 2, 'the armed tick did not issue a GET');

  pinged.env.visibilityHandlers[0]();
  pinged.env.visibilityHandlers[0]();
  pinged.env.visibilityHandlers[0]();
  await flush();
  assert.equal(pinged.env.fetches.length, 2, 'a visibility ping raced the in-flight request');

  held.release(0);
  await flush();
  assert.equal(pinged.env.fetches.length, 3, 'three pings produced more than one catch-up request');
  assert.equal(liveTimers(pinged.env, 2500).length, 0, 'the catch-up refresh armed a tick while in flight');
  held.release(1);
  await flush();
  assert.equal(liveTimers(pinged.env, 2500).length, 1, 'the chain did not settle back into one tick');
  assert.equal(pinged.env.fetches.length, 3, 'settling fired a request instead of arming one');
});

await check('a duplicated poll tick cannot start a second parallel request', async () => {
  // The guard the single-flight loop keeps in `poll` defends against a tick that
  // fires twice (double-armed timer, a stale callback, a replayed task): it must
  // neither start a parallel request nor cancel the one already in flight.
  const dup = boot({ respond: okResponse });
  await flush();
  const held = holdQueue(dup.env);
  const tick = liveTimers(dup.env, 2500)[0];
  assert.ok(tick, 'expected exactly one armed tick before the duplicate fire');

  tick.live = false;
  tick.fn();
  await flush();
  assert.equal(dup.env.fetches.length, 2, 'the tick did not issue a GET');
  const inFlight = dup.env.aborts[dup.env.aborts.length - 1];

  tick.fn();
  await flush();
  assert.equal(dup.env.fetches.length, 2, 'a duplicated tick started a second parallel request');
  assert.equal(inFlight.signal.aborted, false, 'a duplicated tick cancelled the in-flight request');
  assert.equal(liveTimers(dup.env, 2500).length, 0, 'a duplicated tick armed a poll during a flight');

  held.release(0);
  await flush();
  assert.equal(liveTimers(dup.env, 2500).length, 1, 'the chain lost its tick after a duplicated fire');
  assert.equal(dup.env.fetches.length, 2, 'settling fired a request instead of arming one');
});

await check('a mid-life AbortError is ignored, not recorded, and keeps the chain armed', async () => {
  const aborted = boot({ respond: () => Promise.reject(abortError()) });
  await flush();
  assert.equal(aborted.env.fetches.length, 1, 'expected exactly one initial request');
  assert.ok(
    !aborted.env.stateCalls.some((call) => call.index === 1),
    'an AbortError was recorded as a poll failure'
  );
  assert.ok(
    !aborted.env.stateCalls.some((call) => call.index === 0),
    'an AbortError wrote a snapshot'
  );
  assert.equal(aborted.env.aborts.length, 1, 'expected exactly one AbortController');
  assert.equal(aborted.env.aborts[0].signal.aborted, false, 'a mid-life AbortError aborted the controller');
  assert.equal(liveTimers(aborted.env, 2500).length, 1, 'an AbortError killed the poll chain');
});

await check('a parked hidden chain leaks nothing and unmount clears its tick', async () => {
  const parked = boot({ hidden: true, respond: okResponse });
  await flush();
  assert.equal(parked.env.fetches.length, 0, 'requested while hidden');
  assert.equal(parked.env.aborts.length, 0, 'an AbortController was created while hidden');
  assert.equal(liveTimers(parked.env, 2500).length, 1, 'the hidden chain armed no tick');

  assert.equal(runTimers(parked.env, 2500), 1, 'the parked tick did not re-arm');
  await flush();
  assert.equal(parked.env.fetches.length, 0, 'a parked tick issued a request');
  assert.equal(parked.env.aborts.length, 0, 'a parked tick created an AbortController');
  assert.equal(liveTimers(parked.env, 2500).length, 1, 'the parked chain stopped re-arming');

  const cleanup = parked.env.cleanups[parked.env.cleanups.length - 1];
  cleanup();
  assert.equal(liveTimers(parked.env, 2500).length, 0, 'unmount left the parked tick behind');
  assert.equal(runTimers(parked.env, 2500), 0, 'unmount left a fireable parked tick');
  await flush();
  assert.equal(parked.env.fetches.length, 0, 'a request was issued after unmount');
});

await check('an effect restart aborts only the old request and the old chain stays silent', async () => {
  const switchQueue = [];
  const switched = boot({
    respond: () =>
      new Promise((resolve, reject) => {
        switchQueue.push({ resolve, reject });
      }),
  });
  await flush();
  assert.equal(switched.env.fetches.length, 1, 'expected exactly one initial request');
  assert.equal(switchQueue.length, 1, 'the first request never reached the host');
  const oldController = switched.env.aborts[0];
  const cleanup = switched.env.cleanups[switched.env.cleanups.length - 1];

  cleanup();
  assert.equal(oldController.signal.aborted, true, 'teardown did not abort the in-flight request');

  // The restart a `reloadKey` bump / workspace switch performs: same env, a new
  // effect body scoped to another workspace root.
  switched.probe.Panel({ t: (key) => key, workspaceRoot: '/tmp/pf-demo/beta' });
  await flush();
  assert.equal(switched.env.fetches.length, 2, 'the restarted chain did not poll immediately');
  assert.equal(
    switched.env.fetches[1].url,
    'api/project-flow/state?root=%2Ftmp%2Fpf-demo%2Fbeta',
    'the restarted chain polled the old workspace'
  );

  // The torn-down chain settles afterwards: it must stay completely silent.
  const writesBeforeSettle = switched.env.stateCalls.length;
  switchQueue[0].resolve(okResponse());
  await flush();
  assert.equal(
    switched.env.stateCalls.length,
    writesBeforeSettle,
    'the torn-down chain wrote state after teardown'
  );
  assert.equal(liveTimers(switched.env, 2500).length, 0, 'the torn-down chain armed a tick');

  // The fresh chain is an ordinary single-flight chain.
  switchQueue[1].resolve(okResponse());
  await flush();
  assert.equal(liveTimers(switched.env, 2500).length, 1, 'the restarted chain did not arm exactly one tick');
  assert.equal(switched.env.fetches.length, 2, 'the restarted chain fired a request instead of arming');
});

await check('single flight holds across a mixed sequence and only teardown aborts', async () => {
  const stats = { concurrent: 0, max: 0, calls: 0 };
  const releases = [];
  const mixed = boot({
    respond: () => {
      stats.calls += 1;
      stats.concurrent += 1;
      stats.max = Math.max(stats.max, stats.concurrent);
      return new Promise((resolve, reject) => {
        releases.push({
          resolve: (value) => {
            stats.concurrent -= 1;
            resolve(value);
          },
          reject: (error) => {
            stats.concurrent -= 1;
            reject(error);
          },
        });
      });
    },
  });
  const settleOk = (call) => releases[call - 1].resolve(okResponse());
  const settleFail = (call, error) => releases[call - 1].reject(error);

  await flush();
  assert.equal(stats.calls, 1, 'mount did not poll immediately');
  assert.equal(stats.concurrent, 1, 'expected exactly one request in flight');
  assert.equal(runTimers(mixed.env, 2500), 0, 'a tick was armed during the first request');

  settleOk(1);
  await flush();
  assert.equal(stats.concurrent, 0, 'the settle left the request counted as in flight');
  assert.equal(liveTimers(mixed.env, 2500).length, 1, 'the settle did not arm exactly one tick');

  // A visible ping replaces the pending tick with an immediate request.
  mixed.env.visibilityHandlers[0]();
  await flush();
  assert.equal(stats.calls, 2, 'the visible ping did not refresh immediately');
  assert.equal(liveTimers(mixed.env, 2500).length, 0, 'the visible ping left the superseded tick armed');
  assert.equal(runTimers(mixed.env, 2500), 0, 'a superseded tick was still fireable');

  // A ping while that request is in flight is queued, not raced.
  mixed.env.visibilityHandlers[0]();
  await flush();
  assert.equal(stats.calls, 2, 'a second ping raced the in-flight request');
  settleFail(2, new TypeError('failed to fetch'));
  await flush();
  assert.equal(stats.calls, 3, 'the queued ping was dropped by a failed settle');
  assert.equal(stats.concurrent, 1, 'the catch-up request did not start');
  assert.ok(
    mixed.env.stateCalls.some((call) => call.index === 1 && call.next && call.next.code === 'network'),
    'the transport failure was not recorded on the queued settle'
  );

  settleOk(3);
  await flush();
  assert.equal(liveTimers(mixed.env, 2500).length, 1, 'the chain did not settle into one tick');

  // Hidden settles park the chain without fetching.
  assert.equal(runTimers(mixed.env, 2500), 1, 'the armed tick did not fire');
  await flush();
  assert.equal(stats.calls, 4, 'the fired tick did not issue a GET');
  mixed.env.hidden = true;
  settleOk(4);
  await flush();
  assert.equal(liveTimers(mixed.env, 2500).length, 1, 'a hidden settle did not park the chain');
  assert.equal(runTimers(mixed.env, 2500), 1, 'the parked tick did not re-arm');
  await flush();
  assert.equal(stats.calls, 4, 'a parked hidden tick issued a request');

  // Back to visible: immediate refresh, chain intact.
  mixed.env.hidden = false;
  mixed.env.visibilityHandlers[0]();
  await flush();
  assert.equal(stats.calls, 5, 'the tab did not refresh on becoming visible');
  settleFail(5, new TypeError('failed to fetch'));
  await flush();
  assert.equal(liveTimers(mixed.env, 2500).length, 1, 'a transport error killed the chain');

  assert.equal(stats.max, 1, 'two requests overlapped at some point');
  assert.ok(
    mixed.env.aborts.every((ctl) => ctl.signal.aborted === false),
    'a request was aborted outside teardown'
  );
});

// ------------------------------------------------------------- source wiring
await check('source wiring: encoded ?root=, settle-relative poll, teardown-only abort', () => {
  assert.ok(
    SOURCE.includes("'?root=' + encodeURIComponent(workspaceRoot)"),
    'encoded ?root= workspace wiring missing'
  );
  assert.ok(!SOURCE.includes('&session='), 'state URL still concatenates a session parameter');
  assert.ok(SOURCE.includes('sessionId'), 'sessionId no longer reaches the panel (heartbeat highlight lost)');
  assert.ok(!SOURCE.includes('ProjectPicker'), 'global project switcher still present');
  assert.ok(SOURCE.includes("cache: 'no-store'"), 'no-store cache mode missing');
  assert.ok(SOURCE.includes('new AbortController()'), 'AbortController missing');
  assert.ok(SOURCE.includes("document.addEventListener('visibilitychange'"), 'visibility wiring missing');
  // The poll is a settle-relative timeout chain, not a fixed interval.
  assert.ok(SOURCE.includes('window.setTimeout'), 'the next poll is not armed with a timeout');
  assert.ok(SOURCE.includes('window.clearTimeout'), 'the poll timer is never cleared');
  assert.ok(!SOURCE.includes('setInterval(() => void load'), 'the fixed polling interval is still wired');
  // Abort no longer runs on every tick (that self-cancel was the defect).
  assert.ok(!SOURCE.includes('controller.abort()'), 'a poll tick still aborts the previous request');
});

const failed = results.filter((entry) => !entry.ok);
console.log('');
console.log(`assertions                 = ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error('CLIENT POLL CHECK FAILED');
  process.exitCode = 1;
}
