// Load-time + behavioural verification for the extension popup.
//
// The stopwatch's Log path is a data-loss path: it used to clear the timer state
// BEFORE posting, so any failed post destroyed the session with nothing to retry
// from. Reading the code is not proof it's fixed, so this drives the real click
// handler against a stubbed browser and asserts on what's left in storage.
//
//   node tests/verify_popup.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = process.env.EXT_SRC || path.resolve(__dirname, '..', 'ext');
const popupJs = fs.readFileSync(path.join(SRC, 'popup.js'), 'utf8');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}` +
              (ok ? '' : ` (expected ${JSON.stringify(expected)})`));
}

// ── stubs ─────────────────────────────────────────────────────────────────────
function makeEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', disabled: false, className: '',
    dataset: {}, style: {}, onclick: null, options: [],
    _listeners: {},
    appendChild() {}, remove() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(ev, fn) { this._listeners[ev] = fn; },
    closest: () => null,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function buildSandbox(storage, fetchImpl) {
  const els = {};
  const el = id => (els[id] = els[id] || makeEl(id));

  const store = { ...storage };
  const browser = {
    storage: {
      local: {
        get: async keys => {
          const ks = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of ks) if (k in store) out[k] = store[k];
          return out;
        },
        set: async obj => { Object.assign(store, obj); },
        remove: async keys => {
          for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
        },
      },
      onChanged: { addListener() {} },
    },
    action:    { setBadgeText() {} },
    tabs:      { query: async () => [{ id: 1, audible: false }], get: async () => ({ audible: false }) },
    scripting: { executeScript: async () => [{ result: { found: false, playing: false } }] },
  };

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    document: {
      getElementById: el,
      createElement: () => makeEl('created'),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    browser,
    fetch: fetchImpl,
    setTimeout: (fn) => 0,           // never auto-fire; tests drive explicitly
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    AbortController,
    crypto: require('crypto').webcrypto,
    Date, JSON, Math, Array, Object, String, Number, Promise, Error,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, els, store, el };
}

// popup.js calls fetchActivityTypes() at module load, so a naive stub would have
// its first (or only) response eaten before the test ever presses a button.
// Route /activity-types to a benign reply and give the test only /log-manual.
function load(storage, logManualImpl) {
  const routed = async (url, opts) => {
    if (String(url).includes('/activity-types')) {
      return { ok: true, status: 200, json: async () => ['Reading', 'Listening'] };
    }
    return logManualImpl(url, opts);
  };
  const ctx = buildSandbox(storage, routed);
  try {
    vm.runInContext(popupJs, ctx.sandbox, { filename: 'popup.js' });
  } catch (e) {
    console.log('FAIL  popup.js threw at load time: ' + e.message);
    console.log(e.stack.split('\n').slice(0, 4).join('\n'));
    process.exit(1);
  }
  return ctx;
}

// A session that has been running for ~10 minutes.
const RUNNING = {
  timerRunning: true,
  timerStart:   Date.now() - 600000,
  timerElapsed: 0,
  timerMode:    'manual',
  host: '127.0.0.1', port: 18463, token: 'tok',
};

const okResponse   = { ok: true,  status: 200, json: async () => ({ ok: true }) };
const rejResponse  = { ok: true,  status: 200, json: async () => ({ ok: true, error: 'time_seconds must be > 0' }) };
const forbidden    = { ok: false, status: 403, json: async () => ({}) };

async function pressLog(ctx) {
  await ctx.els['start-stop-btn']._listeners.click();
}

(async () => {
  console.log('--- loads with no top-level throw ---');
  load({}, async () => okResponse);
  console.log('PASS  popup.js evaluated\n');

  console.log('--- the bug: a failed post must NOT destroy the session ---');
  {
    const ctx = load(RUNNING, async () => { throw new Error('ECONNREFUSED'); });
    await pressLog(ctx);
    check('timer state is retained', 'timerElapsed' in ctx.store, true);
    check('session is frozen as paused', ctx.store.timerPaused, true);
    check('the clock is stopped', ctx.store.timerStart, null);
    check('elapsed is pinned at ~600s', Math.abs(ctx.store.timerElapsed - 600) <= 2, true);
    check('activity is preserved for the retry', 'timerActivity' in ctx.store, true);
    check('the button is usable again', ctx.els['start-stop-btn'].disabled, false);
    check('the error invites a retry',
          /retry/i.test(ctx.els['timer-status'].textContent), true);
  }

  console.log('\n--- a retry logs the SAME duration, not a longer one ---');
  {
    let sent = null;
    let failNext = true;
    const ctx = load(RUNNING, async (url, opts) => {
      if (failNext) { failNext = false; throw new Error('down'); }
      sent = JSON.parse(opts.body);
      return okResponse;
    });
    await pressLog(ctx);
    const frozen = ctx.store.timerElapsed;
    await new Promise(r => setImmediate(r));
    await pressLog(ctx);                       // retry against a healthy server
    check('retry posts the frozen elapsed', sent.time_seconds, frozen);
    check('retry still carries captured_at', typeof sent.captured_at, 'string');
  }

  console.log('\n--- idempotency key: stable across retries, fresh per session ---');
  {
    const sent = [];
    let healthy = false;
    const ctx = load(RUNNING, async (url, opts) => {
      sent.push(JSON.parse(opts.body));
      if (!healthy) throw new Error('down');
      return okResponse;
    });
    await pressLog(ctx);                       // fails
    await pressLog(ctx);                       // fails again
    check('a key is sent at all', typeof sent[0].client_id, 'string');
    check('the key is non-trivial', sent[0].client_id.length >= 16, true);
    check('retry reuses the SAME key', sent[1].client_id, sent[0].client_id);
    check('the key is persisted for a later retry',
          ctx.store.timerClientId, sent[0].client_id);

    healthy = true;
    await pressLog(ctx);                       // succeeds
    check('success used the same key still', sent[2].client_id, sent[0].client_id);
    check('the key is cleared with the session',
          'timerClientId' in ctx.store, false);
  }

  console.log('\n--- a NEW session must not reuse the previous key ---');
  {
    // Reusing a key across genuinely different sessions would make the server
    // silently drop the second one — losing data in a new way.
    const sent = [];
    const ctx = load(RUNNING, async (url, opts) => {
      sent.push(JSON.parse(opts.body));
      return okResponse;
    });
    await pressLog(ctx);
    Object.assign(ctx.store, RUNNING);          // a second session begins
    await pressLog(ctx);
    check('two sessions, two keys', sent[0].client_id !== sent[1].client_id, true);
  }

  console.log('\n--- a successful post clears the session ---');
  {
    const ctx = load(RUNNING, async () => okResponse);
    await pressLog(ctx);
    const leftovers = Object.keys(ctx.store).filter(k => k.startsWith('timer'));
    check('no timer keys survive', leftovers, []);
    check('confirmation names the duration',
          /Logged 00:10:00/.test(ctx.els['timer-status'].textContent), true);
  }

  console.log('\n--- a 200 carrying an error is NOT treated as stored ---');
  {
    const ctx = load(RUNNING, async () => rejResponse);
    await pressLog(ctx);
    check('session is kept', ctx.store.timerPaused, true);
    check("the server's reason is shown",
          ctx.els['timer-status'].textContent, 'time_seconds must be > 0');
  }

  console.log('\n--- a 403 points at the token instead of a retry ---');
  {
    const ctx = load(RUNNING, async () => forbidden);
    await pressLog(ctx);
    check('session is kept', ctx.store.timerPaused, true);
    check('message mentions the token',
          /token/i.test(ctx.els['timer-status'].textContent), true);
  }

  console.log('\n--- no token configured: keep the session, do not post ---');
  {
    let posted = false;
    const ctx = load({ ...RUNNING, token: '' }, async () => { posted = true; return okResponse; });
    await pressLog(ctx);
    check('nothing was posted', posted, false);
    check('session is kept', ctx.store.timerPaused, true);
    check('elapsed is preserved', Math.abs(ctx.store.timerElapsed - 600) <= 2, true);
  }

  console.log('\n--- a sub-second session is discarded, not posted ---');
  {
    let posted = false;
    const ctx = load({ ...RUNNING, timerStart: Date.now() },
                     async () => { posted = true; return okResponse; });
    await pressLog(ctx);
    check('nothing was posted', posted, false);
    check('no timer keys survive',
          Object.keys(ctx.store).filter(k => k.startsWith('timer')), []);
  }

  console.log('\n--- Discard still wipes everything ---');
  {
    const ctx = load({ ...RUNNING, timerRunning: false, timerPaused: true, timerElapsed: 5 },
                     async () => okResponse);
    await ctx.els['discard-btn']._listeners.click();
    check('no timer keys survive',
          Object.keys(ctx.store).filter(k => k.startsWith('timer')), []);
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
