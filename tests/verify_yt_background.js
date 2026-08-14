// Load-time verification for the YouTube day counter in ext/background.js.
// Evals background.js with stubbed browser globals, captures its onMessage
// listener, and drives yt-accrue / yt-day-total directly.
//
// The two things worth pinning: the LOGICAL date (a rollover hour must move
// early-morning time onto the previous day, the way the app does it) and the
// wall-clock clamp (two tabs playing at once must not both credit the same
// second).
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const assert = require('assert');

const EXT = process.env.EXT_SRC || path.resolve(__dirname, '..', 'ext');
const src = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');

// --- controllable clock -------------------------------------------------------
let NOW = new Date('2026-08-10T13:00:00').getTime();
class FakeDate extends Date {
  constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
  static now() { return NOW; }
}
const at = (iso) => { NOW = new Date(iso).getTime(); };

// --- storage stub -------------------------------------------------------------
const store = {};
function get(keys) {
  const out = {};
  const list = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
  for (const k of list) if (k in store) out[k] = store[k];
  return Promise.resolve(out);
}
function set(obj) { Object.assign(store, obj); return Promise.resolve(); }

const noop = () => {};
let onMessage = null;
let onPermsAdded = null;

// --- tabs / scripting stubs ---------------------------------------------------
// The permissions.onAdded handler re-injects yt-track.js into tabs that were
// already open when access was granted; these capture what it asked for.
let openTabs    = [];
let tabsQueried = [];
let injected    = [];

// --- fetch stub ---------------------------------------------------------------
let fetchCalls = [];
let fetchImpl  = () => ({ ok: true, json: () => Promise.resolve({ ok: true, logged: true }) });
function fakeFetch(url, opts) {
  fetchCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
  return Promise.resolve(fetchImpl(url, opts));
}

const sandbox = {
  console: { log: noop },
  setInterval: () => 1, clearInterval: noop, setTimeout: noop,
  fetch: fakeFetch,
  Date: FakeDate, Math, String, Number, Object, Array, JSON, Promise, parseInt,
  browser: {
    storage: {
      local: { get, set, remove: noop },
      onChanged: { addListener: noop },
    },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setBadgeTextColor: noop },
    runtime: {
      onStartup:   { addListener: noop },
      onInstalled: { addListener: noop },
      onMessage:   { addListener: (fn) => { onMessage = fn; } },
    },
    tabs: {
      onUpdated: { addListener: noop }, onRemoved: { addListener: noop },
      get:   () => Promise.resolve({}),
      query: (q) => { tabsQueried.push(q); return Promise.resolve(openTabs); },
    },
    scripting: {
      executeScript: (a) => { injected.push(a); return Promise.resolve([]); },
    },
    permissions: { onAdded: { addListener: (fn) => { onPermsAdded = fn; } } },
  },
};
sandbox.window = sandbox;

vm.runInContext(src, vm.createContext(sandbox), { filename: 'background.js' });
console.log('  ok  background.js evaluated without throwing');
assert.ok(typeof onMessage === 'function', 'onMessage listener should be registered');

const accrue = (secs) => onMessage({ type: 'yt-accrue', secs });
const total  = ()     => onMessage({ type: 'yt-day-total' });

// NOTE: the clamp's `ytLastCredit` is module-global and survives reset(), which
// is correct in production but means THIS FILE MUST ONLY MOVE THE CLOCK
// FORWARD. Rewinding leaves ytLastCredit in the future, every credit clamps to
// zero, and the failure looks like a broken counter rather than a broken test.
function reset(rollover) {
  for (const k of Object.keys(store)) delete store[k];
  if (rollover !== undefined) store.rolloverHour = String(rollover);
}

(async () => {
  // --- 1. a plain credit lands on today ---------------------------------------
  reset(0);
  at('2026-08-10T13:00:00');
  let r = await accrue(60);
  assert.strictEqual(r.dayTotal, 60, `expected 60, got ${r.dayTotal}`);
  assert.strictEqual(store.ytDays['2026-08-10'], 60, 'should credit the calendar date');
  console.log('  ok  credit lands on the current logical day');

  // --- 2. the wall-clock clamp -------------------------------------------------
  // Two tabs both reporting 5s at the same instant. Real time has not advanced,
  // so the second must credit nothing.
  reset(0);
  at('2026-08-10T14:00:00');
  await accrue(5);                       // primes ytLastCredit
  const before = store.ytDays['2026-08-10'];
  r = await accrue(5);                   // same millisecond, second tab
  assert.strictEqual(r.dayTotal, before, `clamp failed: ${before} -> ${r.dayTotal}`);
  console.log('  ok  a second tab cannot credit the same wall-clock second');

  // ... but once real time passes, a credit is allowed again.
  at('2026-08-10T14:00:10');
  r = await accrue(5);
  assert.strictEqual(r.dayTotal, before + 5, 'credit should resume after time passes');
  console.log('  ok  credit resumes once wall-clock time advances');

  // A report larger than the elapsed wall time is trimmed to what really passed.
  at('2026-08-10T14:00:12');             // 2s later
  const b2 = store.ytDays['2026-08-10'];
  r = await accrue(3600);                // a tab claiming an hour
  assert.ok(r.dayTotal - b2 <= 2.001, `runaway report not trimmed: +${r.dayTotal - b2}`);
  console.log('  ok  an oversized report is trimmed to elapsed real time');

  // --- 3. the rollover hour ----------------------------------------------------
  // 01:00 with rollover_hour=4 is still the PREVIOUS logical day, matching
  // get_today() in db.py. This is what keeps late-night watching on the right
  // date without needing the attribution table.
  reset(4);
  at('2026-08-11T01:00:00');
  r = await accrue(120);
  assert.strictEqual(store.ytDays['2026-08-10'], 120,
    `01:00 with rollover 4 should credit 2026-08-10, got ${JSON.stringify(store.ytDays)}`);
  assert.ok(!store.ytDays['2026-08-11'], 'must not credit the calendar date');
  console.log('  ok  01:00 with rollover_hour=4 credits the previous logical day');

  at('2026-08-11T05:00:00');             // past the rollover hour
  await accrue(60);
  assert.strictEqual(store.ytDays['2026-08-11'], 60, '05:00 should credit the new day');
  console.log('  ok  past the rollover hour, credit moves to the new day');

  reset(0);                              // rollover 0 => logical == calendar
  at('2026-08-12T01:00:00');
  await accrue(60);
  assert.strictEqual(store.ytDays['2026-08-12'], 60, 'rollover 0 should credit the calendar date');
  console.log('  ok  rollover_hour=0 keeps logical day == calendar day');

  // --- 4. yt-day-total reads the current logical day ---------------------------
  reset(4);
  store.ytDays = { '2026-08-12': 999, '2026-08-13': 5 };
  at('2026-08-13T02:00:00');             // before the rollover hour
  r = await total();
  assert.strictEqual(r.dayTotal, 999, `expected the previous logical day, got ${r.dayTotal}`);
  at('2026-08-13T09:00:00');             // after it
  r = await total();
  assert.strictEqual(r.dayTotal, 5, `expected the new day, got ${r.dayTotal}`);
  console.log('  ok  yt-day-total follows the rollover boundary');

  // --- 5. crediting must never drop a day --------------------------------------
  // M2 pruned inside ytCredit on age alone. M3 moved that out: pruning is now
  // conditional on a CONFIRMED post (section 11), because an unposted day is the
  // only copy of that time. So a credit must leave every existing day intact,
  // however old.
  reset(0);
  store.ytDays = { '2026-07-01': 100, '2026-09-01': 50 };
  at('2026-09-01T13:00:00');
  await accrue(1);
  assert.strictEqual(store.ytDays['2026-07-01'], 100,
    'crediting must not prune an unposted day, however old');
  assert.ok(store.ytDays['2026-09-01'] > 50, 'the current day should still be credited');
  console.log('  ok  crediting never drops an unposted day');

  // --- 6. an unrelated message is ignored --------------------------------------
  reset(0);
  const res = await onMessage({ type: 'not-ours' });
  assert.strictEqual(res, undefined, 'unknown message types should fall through');
  console.log('  ok  unrelated messages fall through untouched');

  // --- 7. M3: fetching rollover_hour -------------------------------------------
  const { ytFetchConfig, ytPostPending, ytPrunePosted } = sandbox;
  reset(0);
  store.token = 'tok';
  at('2026-09-02T12:00:00');
  fetchImpl = () => ({ ok: true, json: () => Promise.resolve({ rollover_hour: 4 }) });
  await ytFetchConfig();
  assert.strictEqual(store.rolloverHour, '4', 'rollover_hour should be stored');
  console.log('  ok  rollover_hour is fetched and stored');

  // --- 8. M3: posting cumulative day totals ------------------------------------
  reset(0);
  store.token  = 'tok';
  store.ytDays = { '2026-09-01': 3600 };
  fetchImpl = () => ({ ok: true, json: () => Promise.resolve({ ok: true, logged: true }) });
  fetchCalls = [];
  await ytPostPending();
  assert.strictEqual(fetchCalls.length, 1, 'should post once');
  assert.deepStrictEqual(fetchCalls[0].body,
    { source: 'youtube', session_date: '2026-09-01', time_seconds: 3600,
      client_id: null });
  assert.ok(fetchCalls[0].url.startsWith('http://127.0.0.1:'),
    'an unset host should still fall back to loopback');
  assert.strictEqual(store.ytPosted['2026-09-01'], 3600, 'confirmed total should be recorded');
  console.log('  ok  posts the cumulative total and records the confirmation');

  fetchCalls = [];                       // unchanged day must not re-post
  await ytPostPending();
  assert.strictEqual(fetchCalls.length, 0, 'an unchanged day should not be re-posted');
  console.log('  ok  an unchanged day is not re-posted');

  store.ytDays['2026-09-01'] = 4000;     // day grew
  fetchCalls = [];
  await ytPostPending();
  assert.strictEqual(fetchCalls.length, 1, 'a grown day should re-post');
  assert.strictEqual(fetchCalls[0].body.time_seconds, 4000, 'must send the FULL total, not a delta');
  console.log('  ok  a grown day re-posts the full total');

  // --- 9. M3: what counts as failure -------------------------------------------
  // A 200 carrying {"error": ...} is NOT proof of storage. This is the exact
  // trap that cost the stopwatch a session: the status code alone lies.
  reset(0);
  store.token  = 'tok';
  store.ytDays = { '2026-09-01': 3600 };
  fetchImpl = () => ({ ok: true, json: () => Promise.resolve({ error: 'session_date must be YYYY-MM-DD' }) });
  await ytPostPending();
  assert.ok(!(store.ytPosted && store.ytPosted['2026-09-01']),
    'a 200 carrying {error} must not be treated as stored');
  assert.strictEqual(store.ytDays['2026-09-01'], 3600, 'the day must be kept for retry');
  console.log('  ok  a 200 carrying {error} counts as failure, day kept for retry');

  fetchImpl = () => ({ ok: false, status: 500, json: () => Promise.resolve({}) });
  await ytPostPending();
  assert.ok(!(store.ytPosted && store.ytPosted['2026-09-01']), 'a 500 must not confirm');
  console.log('  ok  a non-2xx response does not confirm');

  fetchImpl = () => { throw new Error('tracker down'); };
  await ytPostPending();
  assert.strictEqual(store.ytDays['2026-09-01'], 3600, 'an unreachable tracker must not lose the day');
  console.log('  ok  an unreachable tracker loses nothing');

  // --- 10. M3: the floor --------------------------------------------------------
  reset(0);
  store.token  = 'tok';
  store.ytDays = { '2026-09-01': 30 };   // a stray click
  fetchImpl = () => ({ ok: true, json: () => Promise.resolve({ ok: true }) });
  fetchCalls = [];
  await ytPostPending();
  assert.strictEqual(fetchCalls.length, 0, 'a sub-minute day should not mint a row');
  console.log('  ok  a sub-minute day is not posted');

  // --- 11. M3: pruning only what was confirmed ---------------------------------
  // THE rule: an unconfirmed day is the only copy of that time. Pruning it
  // because it is old would delete data that never reached the tracker.
  reset(0);
  store.ytDays   = { '2026-06-01': 100, '2026-06-02': 200, '2026-09-01': 50 };
  store.ytPosted = { '2026-06-01': 100 };          // only the first confirmed
  at('2026-09-02T12:00:00');
  await ytPrunePosted();
  assert.ok(!store.ytDays['2026-06-01'], 'confirmed + old should be pruned');
  assert.strictEqual(store.ytDays['2026-06-02'], 200, 'UNCONFIRMED old day must survive');
  assert.strictEqual(store.ytDays['2026-09-01'], 50, 'recent day must survive');
  console.log('  ok  pruning drops only confirmed days, never unconfirmed ones');

  // A partially-confirmed day (posted, then grew) is not fully confirmed.
  reset(0);
  store.ytDays   = { '2026-06-01': 500 };
  store.ytPosted = { '2026-06-01': 100 };
  at('2026-09-02T13:00:00');
  await ytPrunePosted();
  assert.strictEqual(store.ytDays['2026-06-01'], 500, 'a day that grew since posting must survive');
  console.log('  ok  a day that grew since its last post is not pruned');

  // --- 12. multi-device: configured host + per-device key ----------------------
  // Both fetches used to be hardcoded to 127.0.0.1, which meant a machine not
  // running Konseki could never deliver its YouTube time at all. Pointed at the
  // always-on inbox, it can — and the key is what stops two machines' totals
  // from overwriting each other once they both can.
  reset(0);
  store.token      = 'tok';
  store.host       = 'konsekiserv.local';
  store.port       = 18463;
  store.deviceName = 'laptop';
  store.ytDays     = { '2026-09-01': 3600 };
  fetchImpl  = () => ({ ok: true, json: () => Promise.resolve({ ok: true, logged: true }) });
  fetchCalls = [];
  await ytPostPending();
  assert.strictEqual(fetchCalls[0].url, 'http://konsekiserv.local:18463/import',
    'posts must go to the configured host, not loopback');
  assert.strictEqual(fetchCalls[0].body.client_id, 'youtube:laptop:2026-09-01',
    'the key must name the device and the logical day');
  console.log('  ok  posts to the configured host with a per-device key');

  // The config fetch has to follow the same host, or a machine with no local
  // tracker can never learn the rollover hour it needs to date its own posts.
  reset(0);
  store.token = 'tok';
  store.host  = 'konsekiserv.local';
  store.port  = 18463;
  fetchCalls  = [];
  fetchImpl   = () => ({ ok: true, json: () => Promise.resolve({ rollover_hour: 4 }) });
  await ytFetchConfig();
  assert.strictEqual(fetchCalls[0].url, 'http://konsekiserv.local:18463/config',
    'the config fetch must follow the configured host too');
  assert.strictEqual(store.rolloverHour, '4');
  console.log('  ok  the rollover fetch follows the configured host');

  // A blank device name is the single-machine case and must stay keyless —
  // that is what the tracker adopts when the machine is named later.
  reset(0);
  store.token      = 'tok';
  store.deviceName = '';
  store.ytDays     = { '2026-09-01': 3600 };
  fetchImpl  = () => ({ ok: true, json: () => Promise.resolve({ ok: true, logged: true }) });
  fetchCalls = [];
  await ytPostPending();
  assert.strictEqual(fetchCalls[0].body.client_id, null,
    'an unnamed device must send no key');
  console.log('  ok  an unnamed device posts without a key');

  // --- 13. granting YouTube access reaches tabs that are already open ----------
  // Firefox MV3 makes host_permissions opt-in, and granting one does NOT load
  // the content script into tabs that already exist. Without this handler,
  // allowing YouTube from the popup looks like it did nothing until every tab is
  // reloaded. Re-injecting is safe: yt-track.js guards on __konsekiYtActive.
  assert.ok(typeof onPermsAdded === 'function',
    'a permissions.onAdded listener should be registered');

  openTabs = [{ id: 7 }, { id: 9 }, {}];   // the last has no id — must be skipped
  tabsQueried = []; injected = [];
  await onPermsAdded({ origins: ['https://www.youtube.com/*'] });
  // Compared field by field, not deepStrictEqual: objects minted inside the vm
  // context carry that realm's Object.prototype and never match a host literal.
  assert.deepStrictEqual(tabsQueried.map(q => q.url), ['https://www.youtube.com/*'],
    'should only look at YouTube tabs');
  assert.deepStrictEqual(injected.map(a => a.target.tabId), [7, 9],
    'should inject into every open YouTube tab with an id');
  assert.ok(injected.every(a => a.files.includes('yt-track.js')), 'should inject the tracker');
  console.log('  ok  granting YouTube access injects into already-open tabs');

  tabsQueried = []; injected = [];
  await onPermsAdded({ origins: ['https://example.com/*'] });
  assert.strictEqual(injected.length, 0, 'an unrelated grant must inject nothing');
  assert.strictEqual(tabsQueried.length, 0, 'an unrelated grant must not even query tabs');
  console.log('  ok  an unrelated permission grant is ignored');

  console.log('\nbackground.js YouTube day counter + posting: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
