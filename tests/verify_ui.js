// Load-time verification for ui.js.
// 1. Evals the module with stubbed browser globals (catches top-level throws
//    that `node --check` misses -- those blank every page).
// 2. Feeds refreshChartTheme() the REAL :root values parsed out of ui.css, then
//    asserts CT resolves to the exact hex literals the chart configs used to
//    hardcode. That proves the dark theme renders byte-identically.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = process.env.UI_SRC || path.resolve(__dirname, '..', 'src');
const uiJs  = fs.readFileSync(path.join(SRC, 'ui.js'), 'utf8');
const uiCss = fs.readFileSync(path.join(SRC, 'ui.css'), 'utf8');

// --- parse :root { --var: value; } out of ui.css -----------------------------
function parseBlock(css, selector) {
  const re = new RegExp(selector.replace(/[[\]"]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  if (!m) throw new Error('could not find CSS block: ' + selector);
  const vars = {};
  for (const line of m[1].split(';')) {
    const kv = line.match(/(--[\w-]+)\s*:\s*(.+)/);
    if (kv) vars[kv[1]] = kv[2].trim();
  }
  return vars;
}
const rootVars = parseBlock(uiCss, ':root');
const mintVars = { ...rootVars, ...parseBlock(uiCss, '[data-theme="mint"]') };

let activeVars = rootVars;

// --- minimal browser stubs ---------------------------------------------------
const noop = () => {};
const fakeEl = new Proxy({}, {
  get(t, k) {
    if (k === 'style' || k === 'dataset' || k === 'classList') return fakeEl;
    if (k === 'getContext') return () => fakeEl;
    if (k === 'appendChild' || k === 'addEventListener' || k === 'remove') return noop;
    if (k === 'toggle' || k === 'add' || k === 'contains') return noop;
    if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
    if (k === 'checked') return false;
    if (typeof k === 'string') return noop;
    return undefined;
  },
  set() { return true; },
});

const documentElement = {
  _theme: null,
  setAttribute(n, v) { if (n === 'data-theme') { this._theme = v; activeVars = mintVars; } },
  removeAttribute(n) { if (n === 'data-theme') { this._theme = null; activeVars = rootVars; } },
};

const sandbox = {
  console,
  document: {
    documentElement,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => fakeEl,
    addEventListener: noop,
    body: fakeEl,
  },
  getComputedStyle: () => ({ getPropertyValue: n => activeVars[n] || '' }),
  window: {},
  Chart: function () { return fakeEl; },
  flatpickr: () => fakeEl,
  requestAnimationFrame: noop,
  setTimeout: noop,
  setInterval: noop,
  navigator: { userAgent: 'node' },
  location: { href: '' },
};
sandbox.Chart.defaults = { color: '', borderColor: '', font: {} };
sandbox.Chart.register = noop;
sandbox.globalThis = sandbox;
sandbox.addEventListener = noop;
sandbox.removeEventListener = noop;
sandbox.pywebview = { api: new Proxy({}, { get: () => async () => ({}) }) };
sandbox.window = sandbox;

// --- run ---------------------------------------------------------------------
let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

// top-level `let`/`const` are lexical bindings, not globalThis properties, so
// expose the ones under test through getters that follow reassignment.
const PROBE = `
;globalThis.__probe = {
  get CT()             { return CT; },
  get HEATMAP_COLORS() { return HEATMAP_COLORS; },
  get PORTAL_PALETTE() { return PORTAL_PALETTE; },
  set portalColorMap(v) { portalColorMap = v; },
  set portalSelected(v) { portalSelected = v; },
  applyTheme, ctAlpha, paletteIndex, portalColorFor, setChartEmpty,
  rollDetailSeries, twRolling, splitBarDatasets, speedSegmentColors, memberLegendLabels,
  bucketDaily, statsMetricAvail,
};`;

try {
  vm.createContext(sandbox);
  vm.runInContext(uiJs + PROBE, sandbox, { filename: 'ui.js' });
  console.log('PASS  ui.js evaluated with no top-level throw\n');
} catch (e) {
  console.log('FAIL  ui.js threw at load time: ' + e.message);
  console.log(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

const P = sandbox.__probe;
// applyTheme() ends by rebuilding the active page; that needs a real DOM, so let
// it fail after the color work it is under test for has already happened.
const setTheme = t => { try { P.applyTheme(t); } catch (e) { /* loadPage needs DOM */ } };

console.log('--- dark theme must be byte-identical to the old hardcoded hex ---');
const CT = P.CT;
check('CT.grid    (was #2E2E48)', CT.grid,    '#2E2E48');
check('CT.dim     (was #9090A8)', CT.dim,     '#9090A8');
check('CT.accent  (was #5B8CFF)', CT.accent,  '#5B8CFF');
check('CT.success (was #4ECBA0)', CT.success, '#4ECBA0');
check('CT.card    (was #24243A)', CT.card,    '#24243A');
check('Chart.defaults.color       (was #9090A8)', sandbox.Chart.defaults.color,       '#9090A8');
check('Chart.defaults.borderColor (was #2E2E48)', sandbox.Chart.defaults.borderColor, '#2E2E48');

console.log('\n--- ctAlpha reproduces the old rgba fill exactly ---');
check("ctAlpha('#4ECBA0', 0.08)", P.ctAlpha('#4ECBA0', 0.08), 'rgba(78,203,160,0.08)');

console.log('\n--- mint keeps its hand-tuned chart text/grid ---');
setTheme('mint');
check('CT.dim  pinned',         P.CT.dim,    '#8AADA9');
check('CT.grid pinned',         P.CT.grid,   '#C2E4DC');
check('CT.accent follows mint', P.CT.accent, '#2EAA92');

console.log('\n--- switching back to dark restores exact dark values ---');
setTheme('dark');
check('CT.grid   restored', P.CT.grid,   '#2E2E48');
check('CT.dim    restored', P.CT.dim,    '#9090A8');
check('CT.accent restored', P.CT.accent, '#5B8CFF');
check('HEATMAP_COLORS dark ramp intact',
      JSON.stringify(P.HEATMAP_COLORS),
      JSON.stringify(['#1E1E30', '#1a3b4a', '#1e6b52', '#26a06e', '#4ECBA0']));

console.log('\n--- #3 stable per-title colors ---');
const PP = P.PORTAL_PALETTE;
const pick = (title, alsoSelected = []) => {
  P.portalColorMap = {};
  P.portalSelected = new Set([title, ...alsoSelected]);
  alsoSelected.forEach(t => P.portalColorFor(t));   // they claim first
  return P.portalColorFor(title);
};
const solo = title => {
  P.portalColorMap = {};
  P.portalSelected = new Set([title]);
  return P.portalColorFor(title);
};

check('paletteIndex is in range', P.paletteIndex('ヴァニタスの手記', PP.length) < PP.length, true);
check('paletteIndex is deterministic',
      P.paletteIndex('同じ', 10) === P.paletteIndex('同じ', 10), true);
check("solo title gets its own hash color",
      solo('Re:Zero'), PP[P.paletteIndex('Re:Zero', PP.length)]);
check('same title, second run, same color', solo('Re:Zero'), solo('Re:Zero'));

// Order independence only holds for a non-colliding pair, so assert that first.
const A = 'Steins;Gate', B = 'Clannad';
const collide = P.paletteIndex(A, PP.length) === P.paletteIndex(B, PP.length);
check(`test pair ${A}/${B} does not hash-collide`, collide, false);
check('A same whether picked before or after B', pick(A), pick(A, [B]));
check('B same whether picked before or after A', pick(B), pick(B, [A]));
check('A and B are distinguishable', pick(A, [B]) !== pick(B), true);

// Collision must still resolve to distinct colors — that is what the view is for.
const seen = new Set();
const many = ['一', '二', '三', '四', '五', '六', '七', '八'];
P.portalColorMap = {};
P.portalSelected = new Set(many);
many.forEach(t => seen.add(P.portalColorFor(t)));
check('8 simultaneous titles all get distinct colors', seen.size, 8);

console.log('\n--- #5 empty-state helper ---');
let threw = null;
try { P.setChartEmpty('does-not-exist', 'msg'); } catch (e) { threw = e.message; }
check('setChartEmpty tolerates a missing canvas', threw, null);

console.log('\n--- M2: rollDetailSeries ---');
// 100 days, deliberately uneven speed so a mean-of-daily-speeds would differ
// from the correct total-chars / total-secs.
const mkDay = (i) => {
  const d = new Date(2026, 0, 1 + i);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fast = i % 2 === 0;
  return {
    date: iso,
    chars: fast ? 20000 : 2000,
    seconds: fast ? 3600 : 3600,
    by_milestone: { a: { chars: fast ? 20000 : 2000, secs: 3600 } },
  };
};
const days100 = Array.from({ length: 100 }, (_, i) => mkDay(i));
const days30  = days100.slice(0, 30);

const passthru = P.rollDetailSeries(days30, days30.map(r => r.by_milestone), 90);
check('under threshold: no rollup', passthru.labels.length, 30);
check('under threshold: labels are MM-DD', passthru.labels[0], days30[0].date.slice(5));

const rolled = P.rollDetailSeries(days100, days100.map(r => r.by_milestone), 90);
check('over threshold: rolls up to weeks', rolled.labels.length < 100, true);
check('rollup conserves total chars',
      rolled.chars.reduce((a, b) => a + b, 0),
      days100.reduce((a, r) => a + r.chars, 0));
check('rollup conserves total secs',
      rolled.secs.reduce((a, b) => a + b, 0),
      days100.reduce((a, r) => a + r.seconds, 0));
check('rollup conserves split chars',
      rolled.split.reduce((a, s) => a + (s.a ? s.a.chars : 0), 0),
      days100.reduce((a, r) => a + r.by_milestone.a.chars, 0));

// The invariant at the aggregation layer, with hand-computed expected values so
// the assertion can actually fail. Two days in one bucket, chosen so that
// mean-of-daily-speeds and total-chars/total-secs are far apart:
//   day A 10000 chars / 1h  -> 10000/h
//   day B  1000 chars / 10h ->   100/h
//   mean of daily speeds  = 5050/h   <- what a naive average would give
//   chars/secs over bucket = 11000 / 11h = 1000/h  <- the only correct answer
const pair = [
  { date: '2026-01-01', chars: 10000, seconds: 3600 },
  { date: '2026-01-02', chars: 1000,  seconds: 36000 },
];
const pr = P.rollDetailSeries(pair, null, 1);   // weeklyOver=1 forces the rollup
check('both days land in one week bucket', pr.labels.length, 1);
const bucketSpeed = pr.chars[0] / (pr.secs[0] / 3600);
check('bucket speed is chars/secs (1000/h)', Math.round(bucketSpeed), 1000);
check('bucket speed is NOT the mean of daily speeds (5050/h)',
      Math.round(bucketSpeed) === 5050, false);

// The old day-of-month key merged Jan/Feb/Mar into one bucket. Distinct weeks
// must stay distinct.
const acrossMonths = [
  { date: '2026-01-02', chars: 1, seconds: 60 },
  { date: '2026-02-02', chars: 1, seconds: 60 },
  { date: '2026-03-02', chars: 1, seconds: 60 },
];
check('dates in different months do not share a bucket',
      P.rollDetailSeries(acrossMonths, null, 1).labels.length, 3);
check('a full year rolls into ~52 weekly buckets, not 6',
      P.rollDetailSeries(
        Array.from({ length: 365 }, (_, i) => {
          const d = new Date(2026, 0, 1 + i);
          return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
                   chars: 1, seconds: 60 };
        }), null, 90).labels.length >= 52, true);

check('no split source is tolerated', P.rollDetailSeries(days30, null, null).split.length, 30);
check('empty series is tolerated', P.rollDetailSeries([], null, 90).labels.length, 0);

console.log('\n--- M2: twRolling basis ---');
// twRolling must be time-weighted over the window (sum chars / sum secs), which
// is the same rule as everywhere else.
const tw = P.twRolling([100, 300], [3600, 3600], 2);
check('7d rolling uses summed chars over summed secs',
      Math.round(tw[1]), Math.round((100 + 300) / ((3600 + 3600) / 3600)));

console.log('\n--- M2: split datasets (bars + per-member speed) ---');
const members = [
  { key: 'm1', color: '#AAA111', label: 'Part One' },
  { key: 'm2', color: '#BBB222', label: 'Part Two' },
  { key: 'm3', color: '#CCC333', label: 'Never read' },
];
// m1 reads fast, m2 slow — so a per-member line must NOT collapse to one number.
const splitDays = [
  { m1: { chars: 6000, secs: 3600 }, m2: { chars: 500, secs: 3600 } },
  { m1: { chars: 6000, secs: 3600 }, m2: { chars: 500, secs: 3600 } },
];

const bars = P.splitBarDatasets(splitDays, members, 'chars', 1, 'milestone');
check('bar split drops members with no data', bars.length, 2);
check('bar split keeps member colors', bars[0].backgroundColor, '#AAA111');
check('bar split uses the given stack name', bars[0].stack, 'milestone');
check('bar split scales values', P.splitBarDatasets(splitDays, members, 'secs', 1 / 60, 's')[0].data[0], 60);

console.log('\n--- M2: milestone handoff on the same day (regression) ---');
// Milestone A is read days 0-3; on day 3 it finishes and B starts; B runs 3-6.
// twRolling's window is trailing, so before the clamp A kept emitting values on
// days 4,5,6 and its line ran on past the end, overlapping B.
const handoffMembers = [
  { key: 'A', color: '#A00000', label: 'Part One' },
  { key: 'B', color: '#00A000', label: 'Part Two' },
];
const handoff = [
  { A: { chars: 5000, secs: 3600 } },                                  // 0
  { A: { chars: 5000, secs: 3600 } },                                  // 1
  { A: { chars: 5000, secs: 3600 } },                                  // 2
  { A: { chars: 1000, secs: 900 }, B: { chars: 2000, secs: 2700 } },   // 3 handoff
  { B: { chars: 3000, secs: 3600 } },                                  // 4
  { B: { chars: 3000, secs: 3600 } },                                  // 5
  { B: { chars: 3000, secs: 3600 } },                                  // 6
];
const { colors, active } = P.speedSegmentColors(handoff, handoffMembers);

// The point of coloring instead of recomputing: there are no per-member series,
// so no trailing-window boundary exists to get wrong. Each bucket simply takes
// the color of whoever dominated it, and the underlying curve is untouched.
check('one color per bucket', colors.length, handoff.length);
check('days 0-2 are milestone A', colors.slice(0, 3).every(c => c === '#A00000'), true);
check('handoff day takes the dominant member (B 2000 chars vs A 1000)', colors[3], '#00A000');
check('days 4-6 are milestone B', colors.slice(4).every(c => c === '#00A000'), true);
check('legend lists both members', active.map(o => o.label).join(','), 'Part One,Part Two');

// A bucket nobody read gets no color; the segment falls back to the base line.
check('an empty bucket has no color',
      P.speedSegmentColors([{}], handoffMembers).colors[0], null);

// Chars-less reading still colors, falling back to whoever logged the most time.
check('a chars-less bucket falls back to the most time',
      P.speedSegmentColors([{ A: { chars: 0, secs: 60 }, B: { chars: 0, secs: 3600 } }],
                           handoffMembers).colors[0], '#00A000');

// Members never read at all stay out of the key.
check('unread members are excluded from the key',
      P.speedSegmentColors(handoff,
        [...handoffMembers, { key: 'Z', color: '#000', label: 'Never' }]).active.length, 2);

// Chart.js v4 draws legend text with `ctx.fillStyle = item.fontColor` and no
// fallback -- an item without it renders BLACK no matter what labels.color says.
const legendLabels = P.memberLegendLabels(handoffMembers);
check('legend items carry an explicit fontColor', legendLabels[0].fontColor, '#9090A8');
check('every legend item has one', legendLabels.every(l => !!l.fontColor), true);
check('legend swatch uses the member color', legendLabels[0].fillStyle, '#A00000');
check('legend text is the member label', legendLabels[1].text, 'Part Two');
check('memberLegendLabels tolerates null', P.memberLegendLabels(null).length, 0);

console.log('\n--- M3: Stats speed basis carried through bucketing ---');
// Durations differ so sum(chars)/sum(secs) and the mean of daily speeds diverge.
const spdDays = [
  { date: '2026-03-02', seconds: 3600,  chars: 10000, spd_chars: 10000, spd_secs: 3600 },
  { date: '2026-03-03', seconds: 36000, chars: 1000,  spd_chars: 1000,  spd_secs: 36000 },
];
const byDay = P.bucketDaily(spdDays, 'day');
check('day granularity carries spdChars', byDay.spdChars.join(','), '10000,1000');
check('day granularity carries spdSecs',  byDay.spdSecs.join(','),  '3600,36000');

const byMonth = P.bucketDaily(spdDays, 'month');
check('bucketing conserves spdChars', byMonth.spdChars.reduce((a, b) => a + b, 0), 11000);
check('bucketing conserves spdSecs',  byMonth.spdSecs.reduce((a, b) => a + b, 0),  39600);
check('both days land in one month bucket', byMonth.labels.length, 1);
const mSpeed = byMonth.spdChars[0] / (byMonth.spdSecs[0] / 3600);
check('bucket speed is chars/secs (1000/h)', Math.round(mSpeed), 1000);
check('bucket speed is NOT the mean of daily speeds (5050/h)',
      Math.round(mSpeed) === 5050, false);

// Week bucketing used to parse ISO dates as UTC while reading getDay() locally,
// so west of UTC every weekday came back one early: weeks ran Tue->Mon and each
// Monday fell into the previous week's bar.
const mondayFirst = ['2026-03-02', '2026-03-03', '2026-03-08']    // Mon, Tue, Sun
  .map(d => ({ date: d, seconds: 60, chars: 1 }));
const wk = P.bucketDaily(mondayFirst, 'week');
check('Mon-Sun is one week bucket, not two', wk.labels.length, 1);
const nextMonday = P.bucketDaily(
  [{ date: '2026-03-08', seconds: 60, chars: 1 },     // Sunday
   { date: '2026-03-09', seconds: 60, chars: 1 }],    // Monday -> new week
  'week');
check('a new Monday starts a new bucket', nextMonday.labels.length, 2);

console.log('\n--- M3: metric availability is data-driven ---');
check('all three available with chars + speed basis',
      JSON.stringify(P.statsMetricAvail(byDay)), '{"time":true,"chars":true,"speed":true}');
const listening = P.bucketDaily(
  [{ date: '2026-03-02', seconds: 3600, chars: 0, spd_chars: 0, spd_secs: 0 }], 'day');
check('a chars-less range offers Time only',
      JSON.stringify(P.statsMetricAvail(listening)), '{"time":true,"chars":false,"speed":false}');
const empty = P.bucketDaily([{ date: '2026-03-02', seconds: 0, chars: 0 }], 'day');
check('an empty range offers nothing',
      JSON.stringify(P.statsMetricAvail(empty)), '{"time":false,"chars":false,"speed":false}');
check('missing spd_* fields default to 0, not NaN',
      P.bucketDaily([{ date: '2026-03-02', seconds: 60, chars: 5 }], 'day').spdChars[0], 0);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
