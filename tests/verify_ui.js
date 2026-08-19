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
  get HEATMAP_CAP_HOURS() { return HEATMAP_CAP_HOURS; },
  get charts()   { return charts; },
  set charts(v)  { charts = v; },
  reserveLegendRoom, positionDailyBrush,
  get BRUSH_FOLLOW() { return BRUSH_FOLLOW; },
  applyTheme, ctAlpha, paletteIndex, portalColorFor, setChartEmpty, heatmapColor,
  rollDetailSeries, twRolling, splitBarDatasets, bucketHasMember, splitTooltip, speedSegmentColors,
  memberLegendLabels,
  bucketDaily, statsMetricAvail, statsCumSeries, sparkHTML, goalBurnupSeries, dateFromISO,
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

console.log('\n--- heatmap continuous ramp ---');
const hc = h => P.heatmapColor(h * 3600);
check('no reading is the categorical empty shade', hc(0), '#1E1E30');
check('any reading floors at the first ramp stop', P.heatmapColor(1), 'rgb(26,59,74)');
check('an exact anchor hits that stop',             hc(1),   'rgb(30,107,82)');
check('the cap hits the top stop',                  hc(3),   'rgb(78,203,160)');
check('past the cap clamps, it does not wrap',      hc(9),   hc(3));
check('a negative/garbage value is treated as empty', P.heatmapColor(-5), '#1E1E30');
// The point of the change: values inside one old bucket must differ.
const inBucket = new Set([hc(1.1), hc(1.4), hc(1.7), hc(1.9)]);
check('four values inside the old 1–2h bucket are four colors', inBucket.size, 4);
// halfway between #1e6b52 (30,107,82) and #26a06e (38,160,110)
check('a midpoint is between its anchors', hc(1.5), 'rgb(34,134,96)');
check('the ramp is monotonic in green',
      [0.5, 1, 1.5, 2, 2.5, 3].map(h => +hc(h).match(/,(\d+),/)[1])
        .every((g, i, a) => i === 0 || g > a[i - 1]), true);
check('the cap is the documented 3h', P.HEATMAP_CAP_HOURS, 3);

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

console.log('\n--- Stats cumulative view (replaces the dual-axis overlay) ---');
// The old overlay drew its running total on a second y-axis whose unit followed
// granularity: minutes at day granularity, hours above it, with the tick
// formatter dividing by 60 to hide the difference. The single-axis view plots
// HOURS at every granularity — that's what the axis and the tooltip both claim,
// so the series has to actually be in them. Same days, three granularities.
const cumDays = [
  { date: '2026-03-02', seconds: 3600,  chars: 1000 },   // Mon
  { date: '2026-03-03', seconds: 1800,  chars:  500 },
  { date: '2026-03-04', seconds: 0,     chars:    0 },   // idle day, as the backend sends it
  { date: '2026-03-09', seconds: 7200,  chars: 2500 },   // next Mon
];
['day', 'week', 'month'].forEach(g => {
  const b = P.bucketDaily(cumDays, g);
  const c = P.statsCumSeries(b, false);
  check(`${g} granularity: cumulative time is hours, not minutes`,
        c[c.length - 1], 3.5);
});
const cumDay = P.bucketDaily(cumDays, 'day');
const cumT   = P.statsCumSeries(cumDay, false);
check('one point per bucket', cumT.length, cumDay.labels.length);
check('the running total is non-decreasing',
      cumT.every((v, i) => i === 0 || v >= cumT[i - 1]), true);
check('an idle day carries the total forward instead of dropping to zero',
      cumT[cumDay.labels.indexOf('03-04')], 1.5);
const cumC = P.statsCumSeries(cumDay, true);
check('chars pass through unscaled', cumC[cumC.length - 1], 4000);
check('an empty range yields an empty series',
      P.statsCumSeries(P.bucketDaily([], 'day'), false).length, 0);
check('a bucket with no secs is tolerated', P.statsCumSeries({}, false).length, 0);

// The media/series panels feed the SAME helper off rollDetailSeries, which rolls
// long titles up to weekly buckets. The running total has to survive that: one
// point per week bucket, still ending on the title's real total.
const longDaily = Array.from({ length: 120 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  chars: 1000, seconds: 1800,
}));
const cumRolled = P.rollDetailSeries(longDaily, null, 90);
const rollCum = P.statsCumSeries(cumRolled, false);
check('weekly rollup still yields one cumulative point per bucket',
      rollCum.length, cumRolled.labels.length);
check('rollup does not lose time from the running total',
      Math.round(rollCum[rollCum.length - 1] * 100) / 100, 60);
check('the rolled-up total matches the unrolled one',
      rollCum[rollCum.length - 1],
      P.statsCumSeries(P.rollDetailSeries(longDaily, null, null), false).slice(-1)[0]);

console.log('\n--- M4: shelf activity strip ---');
const spark = P.sparkHTML([0, 60, 600, 0, 300], '#5B8CFF');
const heights = [...spark.matchAll(/height:(\d+)%/g)].map(m => +m[1]);
check('one bar per day', heights.length, 5);
check('the busiest day is full height', Math.max(...heights), 100);
check('empty days are zero height', heights[0], 0);
// Scaled to the title's OWN max, so a lightly-read title still shows shape.
check('a small day still clears the visibility floor', heights[1] >= 12, true);
check('bars are proportional to their own max', heights[4], 50);
check('empty series renders the placeholder strip',
      P.sparkHTML([0, 0, 0], '#5B8CFF').includes('spark-empty'), true);
check('a missing series is tolerated',
      P.sparkHTML(undefined, '#5B8CFF').includes('spark-empty'), true);

console.log('\n--- M6: goal burn-up geometry ---');
// A 10-day chars goal: start Mar 1, deadline Mar 11 (10 days of pace), target
// 100k. Four days read at 5k/day, so the run rate is half what's needed.
// projected_end / projected_days_delta are what db.py derives from that pace —
// 100k at 5k/day is reached on day index 20, i.e. start + 19 = Mar 20, nine
// days past the deadline. The fixture has to satisfy db.py's arithmetic or the
// projection-slope check below is asserting against a pace nobody computed.
const burnGoal = {
  metric: 'chars_read', target: 100000,
  start_date: '2026-03-01', deadline: '2026-03-11',
  projected_end: '2026-03-20', projected_days_delta: 9,
};
const burnDates = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'];
const burnCum   = [5000, 10000, 15000, 20000];
const BU = P.goalBurnupSeries(burnGoal, burnDates, burnCum);

check('axis starts at the goal start', BU.labels[0], '2026-03-01');
check('axis extends past the deadline to the projected finish',
      BU.labels[BU.labels.length - 1], '2026-03-20');
check('axis is dense (one label per day)', BU.labels.length, 20);
check('actual carries the backend series', BU.actual.slice(0, 4).join(','), '5000,10000,15000,20000');
// The whole point of the null pad: drawing the actual line to the deadline
// would claim progress that has not happened.
check('actual is null past the last real day', BU.actual[4], null);
check('actual never resumes', BU.actual.slice(4).every(v => v === null), true);

check('pace starts at zero', BU.pace[0], 0);
check('pace hits the target exactly on the deadline',
      BU.pace[BU.labels.indexOf('2026-03-11')], 100000);
check('pace is the same target/total_days the card uses', BU.pace[1], 10000);
check('pace stops at the deadline', BU.pace[BU.labels.indexOf('2026-03-12')], null);
check('target line is flat at the target', BU.scope.every(v => v === 100000), true);

// The projection must LEAVE from the last actual point, not from zero or from
// the pace line, and land on the target on projected_end.
const pStart = BU.labels.indexOf('2026-03-04'), pEnd = BU.labels.indexOf('2026-03-20');
check('projection starts at the last actual value', BU.projected[pStart], 20000);
check('projection is null before today', BU.projected[pStart - 1], null);
check('projection lands on the target at projected_end', BU.projected[pEnd], 100000);
check('projection is null after projected_end', BU.projected[pEnd + 1], undefined);
// Straight line => the implied daily rate matches the observed 5k/day pace
// db.py extrapolated projected_end from.
check('projection runs at the observed pace (5k/day)',
      Math.round(BU.projected[pStart + 1] - BU.projected[pStart]), 5000);
check('slack is the deadline-relative flip of projected_days_delta', BU.slack, -9);

// The axis plots `short`; `labels` stays ISO so the tooltip can name the day.
check('short labels are MM-DD', BU.short[0], '03-01');
check('short labels stay aligned with the ISO ones', BU.short.length, BU.labels.length);

// Ahead of schedule: the axis must NOT stretch past the deadline just because
// the projection lands early, or the chart grows a meaningless empty tail.
const early = P.goalBurnupSeries(
  { ...burnGoal, projected_end: '2026-03-07', projected_days_delta: -4 },
  burnDates, [15000, 30000, 45000, 60000]);
check('an early projection leaves the axis at the deadline',
      early.labels[early.labels.length - 1], '2026-03-11');
check('slack is positive when finishing early', early.slack, 4);

// Time goals plot in hours; the series arrives in seconds.
const timeGoal = P.goalBurnupSeries(
  { metric: 'time_seconds', target: 36000, start_date: '2026-03-01',
    deadline: '2026-03-11', projected_end: null, projected_days_delta: null },
  ['2026-03-01', '2026-03-02'], [3600, 9000]);
check('time series is scaled to hours', timeGoal.actual.slice(0, 2).join(','), '1,2.5');
check('time target is scaled to hours', timeGoal.scope[0], 10);
check('no projection without a projected_end', timeGoal.projected, null);
check('no slack without a delta', timeGoal.slack, null);

// Degenerate + hostile inputs: a same-day goal, and a goal with no reading yet.
const sameDay = P.goalBurnupSeries(
  { metric: 'chars_read', target: 5000, start_date: '2026-03-01',
    deadline: '2026-03-01' }, ['2026-03-01'], [1000]);
check('a same-day goal is one bucket', sameDay.labels.length, 1);
check('a same-day pace line sits at the target, not zero', sameDay.pace[0], 5000);
check('an empty series still draws the pace line',
      P.goalBurnupSeries(burnGoal, [], []).actual.every(v => v === null), true);
check('a malformed start date yields no axis',
      P.goalBurnupSeries({ ...burnGoal, start_date: '' }, [], []), null);

// Local date parsing — `new Date('2026-03-02')` is UTC midnight and reads back
// a day early west of UTC, which is the bug M3 hit in the week bucketing.
check('dateFromISO parses local, not UTC', P.dateFromISO('2026-03-02').getDate(), 2);
check('a 366-day goal spans a leap year without drift',
      P.goalBurnupSeries({ metric: 'chars_read', target: 1, start_date: '2028-01-01',
                           deadline: '2028-12-31' }, [], []).labels.length, 366);

// --- legend room must not destroy a live chart on a scaled display -----------
// Regression: the guard used to read the canvas `height` attribute back, but
// Chart.js owns that attribute once a chart is live and rewrites it in DEVICE
// pixels (base x devicePixelRatio). At any scaling other than 100% it therefore
// never matched, so every render destroyed the chart -- and upsertChart()'s
// morphBars slide needs a live chart to morph FROM. The Stats bars lost their
// sliding transition, silently, and only for devicePixelRatio != 1.
console.log('\n--- legend room must not destroy a live chart on a scaled display ---');
const DPR = 1.25;                       // 125% Windows display scaling
const canvasStub = {
  attrs: { height: '180' }, dataset: {},
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
  setAttribute(n, v) { this.attrs[n] = String(v); },
};
let destroyed = 0;
const liveChart = { destroy() { destroyed++; } };
sandbox.document.getElementById = id => (id === 'chart-daily' ? canvasStub : null);
P.charts = {};

P.reserveLegendRoom('chart-daily', 'daily', 180, false);
check('the first call tags the canvas at its base height', canvasStub.getAttribute('height'), '180');

P.charts = { daily: liveChart };        // new Chart(...) — Chart.js now owns the attribute
canvasStub.setAttribute('height', String(Math.floor(180 * DPR)));
check('Chart.js rewrote the attribute in device pixels', canvasStub.getAttribute('height'), '225');

P.reserveLegendRoom('chart-daily', 'daily', 180, false);
check('an unchanged legend state leaves the live chart alone', destroyed, 0);
check('so upsertChart still has a chart to morph from', P.charts.daily, liveChart);

P.reserveLegendRoom('chart-daily', 'daily', 180, true);
check('turning the legend on still rebuilds', destroyed, 1);
check('and still grows the canvas by one legend row', canvasStub.getAttribute('height'), '211');
check('the rebuilt chart is dropped from the registry', P.charts.daily, undefined);

P.charts = { daily: liveChart };
canvasStub.setAttribute('height', String(Math.floor(211 * DPR)));
P.reserveLegendRoom('chart-daily', 'daily', 180, true);
check('a split chart is also left alone on the next render', destroyed, 1);

// --- the range brush must follow the plot area through a resize --------------
// The brush is an overlay measured against chart.chartArea. Chart.js's onResize
// fires BEFORE the relayout and its ResizeObserver is rAF-throttled, so both of
// the obvious hooks read the PRE-resize geometry and leave the handles parked at
// the old width -- jutting into the graph after a maximize, still draggable, and
// mapping pointer x to the wrong days. BRUSH_FOLLOW's afterLayout is the first
// point where chartArea is final.
console.log('\n--- the range brush must follow the plot area through a resize ---');
const styled = () => ({
  style: {}, dataset: {}, hidden: false, offsetLeft: 16, offsetTop: 16,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop, querySelectorAll: () => [],
  querySelector(sel) {
    const k = this._k || (this._k = {});
    return k[sel] || (k[sel] = { style: {}, textContent: '', addEventListener: noop });
  },
});
const brushEl = styled();
sandbox.document.getElementById = id =>
  id === 'daily-brush' ? brushEl : (id === 'chart-daily' ? styled() : null);

const dailyChart = { chartArea: { left: 62, right: 500, top: 8, bottom: 180 } };
P.charts = { daily: dailyChart };

P.positionDailyBrush();
check('the brush spans the plot area', brushEl.style.width, '438px');
check('and starts at its left edge', brushEl.style.left, '78px');

dailyChart.chartArea.right = 1200;      // maximize: Chart.js re-lays the chart out
P.BRUSH_FOLLOW.afterLayout(dailyChart);
check('afterLayout re-measures it', brushEl.style.width, '1138px');
check('vertically too', brushEl.style.height, '172px');

P.BRUSH_FOLLOW.afterLayout({ chartArea: { left: 0, right: 10, top: 0, bottom: 10 } });
check('another chart layout leaves it alone', brushEl.style.width, '1138px');

P.charts = {};                          // mid-construction: charts.daily not assigned yet
P.BRUSH_FOLLOW.afterLayout(dailyChart);
check('the construction pass is skipped, not mis-measured', brushEl.hidden, false);

// --- a split tooltip must not list members that weren't read that bucket -----
// Stacked split = one dataset per member across EVERY bucket, and the tooltip is
// index-mode, so a member with nothing that day still drew a row: "Part Two:
// 0 chars" under a bar it had no share of. bucketHasMember is the tooltip's
// filter; "any reading at all" is the test, so a chars-less sitting still lists.
console.log('\n--- a split tooltip must not list members that were not read ---');
const tipSplit = [
  { A: { chars: 5000, secs: 3600 } },                                 // 0: A only
  { A: { chars: 1000, secs: 600 }, B: { chars: 2000, secs: 1800 } },  // 1: handoff
  { B: { chars: 0, secs: 1800 } },                                    // 2: chars-less
  {},                                                                 // 3: nothing
];
check('the member read that bucket lists',        P.bucketHasMember(tipSplit, 0, 'A'), true);
check('the one that was not does not',            P.bucketHasMember(tipSplit, 0, 'B'), false);
check('both list on a handoff bucket',            P.bucketHasMember(tipSplit, 1, 'B'), true);
check('chars-less reading still counts as data',  P.bucketHasMember(tipSplit, 2, 'B'), true);
check('an empty bucket lists nobody',             P.bucketHasMember(tipSplit, 3, 'A'), false);
check('a bucket past the end is not a crash',     P.bucketHasMember(tipSplit, 9, 'A'), false);
check('a dataset with no member key always shows', P.bucketHasMember(tipSplit, 3, undefined), true);

// the datasets have to carry the key the filter looks up, or every row vanishes
const keyed = P.splitBarDatasets(splitDays, members, 'chars', 1, 'milestone');
check('split datasets carry their member key', keyed[0].memberKey, 'm1');

// splitTooltip is the shared rail behind both split charts (Stats
// split-by-activity and the media/series detail split). Filtering rows out means
// the title/footer callbacks can be handed an EMPTY array, which Chart.js passes
// through unguarded -- c[0] would throw, and the hovered day would lose its name.
const tipLabels = ['02-01', '02-02', '02-03'];
const tipHas = (i, ds) => i === 1 || ds.key === 'keep';
const st = P.splitTooltip(tipLabels, tipHas, c => `Total: ${c.length}`);
check('the filter delegates to the predicate', st.filter({ dataIndex: 0, dataset: { key: 'drop' } }), false);
check('and keeps what the predicate keeps',    st.filter({ dataIndex: 1, dataset: { key: 'drop' } }), true);
check('the title names the hovered bucket',    st.title([{ dataIndex: 2 }]), '02-03');

st.filter({ dataIndex: 2, dataset: { key: 'drop' } });   // hover a bucket where all rows drop
check('a fully filtered bucket still names its day', st.title([]), '02-03');
check('and shows no total',                          st.footer([]), undefined);
check('a bucket with rows still totals them',        st.footer([1, 2]), 'Total: 2');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
