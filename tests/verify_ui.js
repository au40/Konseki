// Load-time verification for ui.js.
// 1. Evals the module with stubbed browser globals (catches top-level throws
//    that `node --check` misses -- those blank every page).
// 2. Feeds refreshChartTheme() the REAL :root values parsed out of ui.css, then
//    asserts CT resolves to them, so charts draw from the page's own palette.
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
const lightVars = { ...rootVars, ...parseBlock(uiCss, '[data-theme="light"]') };
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

// Inline custom properties on <html> (the text colour) outrank the stylesheet.
const inlineVars = {};
const documentElement = {
  _theme: null,
  getAttribute(n) { return n === 'data-theme' ? this._theme : null; },
  setAttribute(n, v) { if (n === 'data-theme') { this._theme = v; activeVars = v === 'light' ? lightVars : rootVars; } },
  removeAttribute(n) { if (n === 'data-theme') { this._theme = null; activeVars = rootVars; } },
  style: { setProperty(n, v) { inlineVars[n] = v; }, removeProperty(n) { delete inlineVars[n]; } },
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
  getComputedStyle: () => ({ getPropertyValue: n => inlineVars[n] || activeVars[n] || '' }),
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
  ctAlpha, paletteIndex, portalColorFor, setChartEmpty, heatmapColor,
  detailSeries, twRolling, splitBarDatasets, bucketHasMember, splitTooltip, speedSegmentColors,
  memberLegendLabels,
  bucketDaily, statsMetricAvail, statsCumSeries, sparkHTML, goalBurnupSeries, dateFromISO,
  hourBlockBars,
  dashRingArcs, lineSparkSVG, applyMode, normMode, modeIsLight,
  TEXT_COLORS, MODE_SURFACE, MODE_CARD, TEXT_TARGETS, textVarsFor, applyTextColor, textTintFragment,
  hexMix, contrastRatio, textCustomPair,
  get appSettings() { return appSettings; }, set appSettings(v) { appSettings = v; },
  goalHasPeriodLine, goalDailyShare, fmtGoalMetric, todayGoalRows, goalBankedChip, fmtGoalDays,
  mediaGridItems, seriesCardFacts,
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

console.log('--- charts read the :root palette ---');
const CT = P.CT;
check('CT.grid',    CT.grid,    '#24262B');
check('CT.dim',     CT.dim,     '#8C9099');
check('CT.accent',  CT.accent,  '#8EA6FF');
check('CT.success', CT.success, '#6FCFAE');
check('CT.card',    CT.card,    '#141518');
check('Chart.defaults.color follows --dim',        sandbox.Chart.defaults.color,       '#8C9099');
check('Chart.defaults.borderColor follows --grid', sandbox.Chart.defaults.borderColor, '#24262B');
check('heatmap ramp',
      JSON.stringify(P.HEATMAP_COLORS),
      JSON.stringify(['#1A1C20', '#222E4A', '#2F4580', '#5068BE', '#9DB2FF']));

console.log('\n--- Light mode: charts and heatmap follow it, and Dark comes back exactly ---');
P.applyMode('light', false);
check('CT.accent follows light',  P.CT.accent, '#4361D8');
check('CT.card follows light',    P.CT.card,   '#FAF9F6');
check('CT.grid follows light',    P.CT.grid,   '#E0DCD3');
check('chart text follows light', sandbox.Chart.defaults.color, '#68635A');
check('light heatmap ramp',
      JSON.stringify(P.HEATMAP_COLORS),
      JSON.stringify(['#E7E3DA', '#D3D8F2', '#A6B3EC', '#6F86E0', '#3F5BD2']));
P.applyMode('dark', false);
check('CT.accent back to dark', P.CT.accent, '#8EA6FF');
check('CT.card back to dark',   P.CT.card,   '#141518');
check('dark heatmap ramp back',
      JSON.stringify(P.HEATMAP_COLORS),
      JSON.stringify(['#1A1C20', '#222E4A', '#2F4580', '#5068BE', '#9DB2FF']));
check('a theme name from an older version reads as dark', P.normMode('mint'), 'dark');
check('so does a missing setting',                        P.normMode(undefined), 'dark');
check('Match Windows without a system answer is dark',    P.modeIsLight('system'), false);
check('Light is light',                                   P.modeIsLight('light'), true);

console.log('\n--- text colour: pairs per mode, labels mixed from it, default untouched ---');
const lightCss = parseBlock(uiCss, '[data-theme="light"]');
check('MODE_SURFACE.dark matches ui.css',  P.MODE_SURFACE.dark,  rootVars['--surface']);
check('MODE_SURFACE.light matches ui.css', P.MODE_SURFACE.light, lightCss['--surface']);
check('MODE_CARD.dark matches ui.css',     P.MODE_CARD.dark,     rootVars['--card']);
check('MODE_CARD.light matches ui.css',    P.MODE_CARD.light,    lightCss['--card']);
check('Default is the stylesheet\'s own dark text',  P.TEXT_COLORS[0].pair[0], rootVars['--text']);
check('Default is the stylesheet\'s own light text', P.TEXT_COLORS[0].pair[1], lightCss['--text']);
check('contrast of white on black', Math.round(P.contrastRatio('#FFFFFF', '#000000')), 21);
const near = (a, b) => Math.abs(a - b) < 0.02;
check('label targets are the default palette\'s own label contrast',
      near(P.contrastRatio(rootVars['--dim'], P.MODE_CARD.dark), 5.71) &&
      near(P.contrastRatio(lightCss['--dim'], P.MODE_CARD.light), 5.66), true);
check('caption targets are the default palette\'s own caption contrast',
      near(P.contrastRatio(rootVars['--muted'], P.MODE_CARD.dark), 2.94) &&
      near(P.contrastRatio(lightCss['--muted'], P.MODE_CARD.light), 2.66), true);
check('every preset is readable on tiles: 9:1+ in Dark, 7:1+ in Light',
      P.TEXT_COLORS.every(t => P.contrastRatio(t.pair[0], P.MODE_CARD.dark) >= 9 &&
                               P.contrastRatio(t.pair[1], P.MODE_CARD.light) >= 7), true);
// A name has to match what you see in both modes; this is what caught a
// "Rose" ink that read as brown and a "Violet" that read as navy.
const hueOf = h => {
  const n = parseInt(h.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return { hue: 0, sat: 0 };
  let hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  const l = (mx + mn) / 2;
  return { hue, sat: d / (1 - Math.abs(2 * l - 1)) };
};
const HUES = { amber: [20, 45], blue: [205, 235], green: [120, 155], rose: [325, 350], violet: [250, 275] };
for (const t of P.TEXT_COLORS.slice(1)) {
  const [lo, hi] = HUES[t.id];
  const ok = t.pair.every(h => { const c = hueOf(h); return c.hue >= lo && c.hue <= hi && c.sat >= 0.4; });
  check(`${t.name} looks ${t.name.toLowerCase()} in both modes (hue and saturation)`, ok, true);
}
for (const key of ['dark', 'light']) {
  const ok = P.TEXT_COLORS.slice(1).every(t => {
    const v = P.textVarsFor(t.id, '', key), card = P.MODE_CARD[key];
    const tc = P.contrastRatio(v.text, card), dc = P.contrastRatio(v.dim, card), mc = P.contrastRatio(v.muted, card);
    return dc >= 4.5 && dc <= tc && mc < dc && Math.abs(mc - P.TEXT_TARGETS[key].muted) < 0.2;
  });
  check(`${key}: every preset's labels stay at 4.5:1+, under the text, captions under the labels`, ok, true);
}
check('Default sets nothing', P.textVarsFor('default', '', 'dark'), null);
check('an unknown id sets nothing', P.textVarsFor('teal', '', 'dark'), null);

P.appSettings = { ...P.appSettings, text_color: 'amber', text_custom: '' };
P.applyMode('dark', false);
check('Amber: text', P.CT.text, '#F1D6A4');
check('Amber: labels at the default label contrast', near(P.contrastRatio(P.CT.dim, P.MODE_CARD.dark), 5.71) || P.contrastRatio(P.CT.dim, P.MODE_CARD.dark) - 5.71 < 0.1, true);
check('chart text follows the labels', sandbox.Chart.defaults.color, P.CT.dim);
P.applyMode('light', false);
check('Amber in Light uses its light half', P.CT.text, '#784719');
check('...with labels at 4.5:1 or more', P.contrastRatio(P.CT.dim, P.MODE_CARD.light) >= 4.5, true);
check('the start-up fragment carries both modes',
      /^[0-9A-F]{6}(\.[0-9A-F]{6}){2}-[0-9A-F]{6}(\.[0-9A-F]{6}){2}$/.test(P.textTintFragment()), true);
P.applyMode('dark', false);

P.appSettings = { ...P.appSettings, text_color: 'custom', text_custom: '#ffcc99,#332211' };
P.applyMode('dark', false);
check('Custom: dark half', P.CT.text, '#FFCC99');
P.applyMode('light', false);
check('Custom: light half', P.CT.text, '#332211');
P.applyMode('dark', false);
check('a broken custom half falls back to the default', P.textCustomPair('nope,#332211').dark, '#E7E8EB');

P.appSettings = { ...P.appSettings, text_color: 'default', text_custom: '' };
P.applyMode('dark', false);
check('back to Default clears the override', P.CT.text, '#E7E8EB');
check('...and the stylesheet\'s labels return', P.CT.dim, '#8C9099');
check('Default needs no start-up fragment', P.textTintFragment(), '');

console.log('\n--- the pre-paint script in ui.html reads what tracker.py passes ---');
const uiHtml = fs.readFileSync(path.join(SRC, 'ui.html'), 'utf8');
const prePaint = (uiHtml.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
check('ui.html opens with the pre-paint script', /theme=\(light\|system\)/.test(prePaint), true);
function runPrePaint(hash, systemLight = false) {
  const out = { attr: null, props: {} };
  const ctx = {
    location: { hash },
    window: { matchMedia: () => ({ matches: systemLight }) },
    document: { documentElement: {
      setAttribute: (n, v) => { if (n === 'data-theme') out.attr = v; },
      style: { setProperty: (n, v) => { out.props[n] = v; } } } },
  };
  vm.runInNewContext(prePaint, ctx);
  return out;
}
P.appSettings = { ...P.appSettings, text_color: 'amber', text_custom: '' };
const amberTint = P.textTintFragment();
P.appSettings = { ...P.appSettings, text_color: 'default' };
check('no fragment: Dark, default text', JSON.stringify(runPrePaint('')), JSON.stringify({ attr: null, props: {} }));
check('#theme=light paints light', runPrePaint('#theme=light').attr, 'light');
check('#theme=system follows a light system', runPrePaint('#theme=system', true).attr, 'light');
check('#theme=system stays dark on a dark system', runPrePaint('#theme=system', false).attr, null);
check('a tint paints the dark half in Dark', runPrePaint('#tint=' + amberTint).props['--text'], '#F1D6A4');
check('...and the light half in Light', runPrePaint('#theme=light&tint=' + amberTint).props['--text'], '#784719');
check('...with all three colours', Object.keys(runPrePaint('#tint=' + amberTint).props).length, 3);
check('a malformed tint paints nothing', Object.keys(runPrePaint('#tint=ABC.DEF').props).length, 0);

console.log('\n--- ctAlpha reproduces the old rgba fill exactly ---');
check("ctAlpha('#4ECBA0', 0.08)", P.ctAlpha('#4ECBA0', 0.08), 'rgba(78,203,160,0.08)');

console.log('\n--- dashboard ring arcs ---');
const sumFrac = arcs => Math.round(arcs.reduce((a, x) => a + x.frac, 0) * 1e6) / 1e6;
const acts3 = [['Reading', 118 * 60], ['Listening', 41 * 60], ['Vocabulary', 18 * 60]];
const under = P.dashRingArcs(acts3, 177 * 60, 180 * 60);
check('under target: arcs fill today / target of the circle', sumFrac(under), Math.round(177 / 180 * 1e6) / 1e6);
check('arcs start where the previous one ends', under[1].start, under[0].frac);
check('first arc starts at the top', under[0].start, 0);
// todaySec is always the sum of the same rows the activities come from.
const acts200 = [['Reading', 140 * 60], ['Listening', 42 * 60], ['Vocabulary', 18 * 60]];
check('over target: the circle is today, so arcs still fit', sumFrac(P.dashRingArcs(acts200, 200 * 60, 180 * 60)), 1);
check('no target: the ring is the activity mix', sumFrac(P.dashRingArcs(acts3, 177 * 60, 0)), 1);
check('no time today draws no arcs', P.dashRingArcs([], 0, 180 * 60).length, 0);
check('a zero-second activity gets no arc',
      P.dashRingArcs([['Reading', 600], ['Listening', 0]], 600, 0).length, 1);

console.log('\n--- goal daily share (shared by the goal card and Today\'s goals) ---');
// 500h goal, 87.7h left, 2h 57m done today, 78 days left after today.
const g500 = { label: '500 hours this year', metric: 'time_seconds', is_complete: false, is_overdue: false,
               days_left: 78, remaining: 87.7 * 3600, today_completed: 177 * 60 };
check('share adds today back and spreads over the days left incl. today',
      Math.round(P.goalDailyShare(g500)), Math.round((87.7 * 3600 + 177 * 60) / 79));
check('share holds steady through the day: more reading today, same target',
      Math.round(P.goalDailyShare({ ...g500, remaining: g500.remaining - 600, today_completed: g500.today_completed + 600 })),
      Math.round(P.goalDailyShare(g500)));
check('a live goal gets a period line', P.goalHasPeriodLine(g500), true);
check('a complete goal does not',       P.goalHasPeriodLine({ ...g500, is_complete: true }), false);
check('an overdue goal does not',       P.goalHasPeriodLine({ ...g500, is_overdue: true }), false);
// The deadline day is a reading day (db.py counts both ends); overdue starts
// the day after, and is_overdue is what says so.
check('but its deadline day still does', P.goalHasPeriodLine({ ...g500, days_left: 0 }), true);
check('overdue wins on a zero days_left', P.goalHasPeriodLine({ ...g500, days_left: 0, is_overdue: true }), false);
check('nor one with nothing left',      P.goalHasPeriodLine({ ...g500, remaining: 0 }), false);
check('time goals format as time',  P.fmtGoalMetric(g500, 4128), '1h 8m');
check('chars goals format as chars', P.fmtGoalMetric({ metric: 'chars_read' }, 5255), '5.3k');

const gChars  = { ...g500, label: '1M chars', metric: 'chars_read', remaining: 387600, today_completed: 27550 };
const gListen = { ...g500, label: 'Listening', remaining: 55.5 * 3600, today_completed: 41 * 60 };
const rowsT = P.todayGoalRows([g500, gChars, gListen,
  { ...g500, label: 'Finished', user_finished: true },
  { ...g500, label: 'Overdue', is_overdue: true }]);
check('Today\'s goals keeps only live, unfinished goals', rowsT.length, 3);
check('goals still short of today\'s share come first', rowsT[0].g.label, 'Listening');
check('the rest keep their Goals-page order', rowsT.slice(1).map(r => r.g.label).join(','), '500 hours this year,1M chars');
check('the tile\'s share is the card\'s share', rowsT[1].share, P.goalDailyShare(g500));
check('no goals is an empty tile, not a crash', P.todayGoalRows(undefined).length, 0);

console.log('\n--- stat tile sparkline ---');
check('fewer than two points draws nothing', P.lineSparkSVG([null, 5, null], '#fff'), '');
const gapped = P.lineSparkSVG([1, 2, null, 3, 4], '#fff');
check('a missing day breaks the line into two runs', (gapped.match(/M/g) || []).length, 2);
const flat = P.lineSparkSVG([7, 7, 7], '#fff', 96, 40);
check('a flat series sits mid-height', /cy="20\.0"/.test(flat), true);
const trailing = P.lineSparkSVG([1, 2, 3, null], '#fff', 96, 40);
check('the endpoint dot marks the last real day, not a missing one', /cx="63\.0"/.test(trailing), true);

console.log('\n--- heatmap continuous ramp ---');
const hc = h => P.heatmapColor(h * 3600);
check('no reading is the categorical empty shade', hc(0), '#1A1C20');
check('any reading floors at the first ramp stop', P.heatmapColor(1), 'rgb(34,46,74)');
check('an exact anchor hits that stop',             hc(1),   'rgb(47,69,128)');
check('the cap hits the top stop',                  hc(3),   'rgb(157,178,255)');
check('past the cap clamps, it does not wrap',      hc(9),   hc(3));
check('a negative/garbage value is treated as empty', P.heatmapColor(-5), '#1A1C20');
// The point of the change: values inside one old bucket must differ.
const inBucket = new Set([hc(1.1), hc(1.4), hc(1.7), hc(1.9)]);
check('four values inside the old 1–2h bucket are four colors', inBucket.size, 4);
// halfway between #2F4580 (47,69,128) and #5068BE (80,104,190)
check('a midpoint is between its anchors', hc(1.5), 'rgb(64,87,159)');
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

console.log('\n--- M2: detailSeries ---');
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

const short = P.detailSeries(days30, days30.map(r => r.by_milestone));
check('one bar per day', short.labels.length, 30);
check('labels are MM-DD', short.labels[0], days30[0].date.slice(5));

// A long title stays daily — no weekly rollup past ~3 months any more.
const long = P.detailSeries(days100, days100.map(r => r.by_milestone));
check('a 100-day title is still one bar per day', long.labels.length, 100);
check('the last label is the last day', long.labels[99], days100[99].date.slice(5));
check('chars pass through per day', long.chars[1], days100[1].chars);
check('secs pass through per day', long.secs[1], days100[1].seconds);
check('split passes through per day', long.split[1].a.chars, days100[1].by_milestone.a.chars);

check('no split source is tolerated', P.detailSeries(days30, null).split.length, 30);
check('empty series is tolerated', P.detailSeries([], null).labels.length, 0);

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
check('legend items carry an explicit fontColor', legendLabels[0].fontColor, '#8C9099');
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

// The media/series panels feed the SAME helper off detailSeries. A long title
// gets one cumulative point per day, ending on the title's real total.
const longDaily = Array.from({ length: 120 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  chars: 1000, seconds: 1800,
}));
const detailCum = P.statsCumSeries(P.detailSeries(longDaily, null), false);
check('a long title yields one cumulative point per day', detailCum.length, 120);
check('the running total ends on the title total',
      Math.round(detailCum[detailCum.length - 1] * 100) / 100, 60);

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
// A 10-day chars goal: start Mar 1, deadline Mar 10 (both ends are reading
// days, so 10 days of pace), target 100k. Four days read at 5k/day, so the run
// rate is half what's needed. projected_end / projected_days_delta are what
// db.py derives from that pace — 100k at 5k/day is reached on day index 20,
// i.e. start + 19 = Mar 20, ten days past the deadline. The fixture has to satisfy db.py's arithmetic or the
// projection-slope check below is asserting against a pace nobody computed.
const burnGoal = {
  metric: 'chars_read', target: 100000,
  start_date: '2026-03-01', deadline: '2026-03-10',
  projected_end: '2026-03-20', projected_days_delta: 10,
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

// End-of-day totals, like `actual`: the start day already owes one share.
// (It used to start at 0 and rise over 9 steps, so it ran a day behind the
// card's marker and the real 10-day plan.)
check("pace ends the start day on one day's share", BU.pace[0], 10000);
check('pace hits the target exactly on the deadline',
      BU.pace[BU.labels.indexOf('2026-03-10')], 100000);
check('pace is the same target/total_days the card uses', BU.pace[1], 20000);
check('pace stops at the deadline', BU.pace[BU.labels.indexOf('2026-03-11')], null);
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
check('a projection past the deadline is late', BU.late, true);

// The axis plots `short`; `labels` stays ISO so the tooltip can name the day.
check('short labels are MM-DD', BU.short[0], '03-01');
check('short labels stay aligned with the ISO ones', BU.short.length, BU.labels.length);

// Ahead of schedule: the axis must NOT stretch past the deadline just because
// the projection lands early, or the chart grows a meaningless empty tail.
const early = P.goalBurnupSeries(
  { ...burnGoal, projected_end: '2026-03-07', projected_days_delta: -3 },
  burnDates, [15000, 30000, 45000, 60000]);
check('an early projection leaves the axis at the deadline',
      early.labels[early.labels.length - 1], '2026-03-10');
check('an early projection is not late', early.late, false);

// Time goals plot in hours; the series arrives in seconds.
const timeGoal = P.goalBurnupSeries(
  { metric: 'time_seconds', target: 36000, start_date: '2026-03-01',
    deadline: '2026-03-11', projected_end: null, projected_days_delta: null },
  ['2026-03-01', '2026-03-02'], [3600, 9000]);
check('time series is scaled to hours', timeGoal.actual.slice(0, 2).join(','), '1,2.5');
check('time target is scaled to hours', timeGoal.scope[0], 10);
check('no projection without a projected_end', timeGoal.projected, null);
check('no projection is not late', timeGoal.late, false);

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

console.log('\n--- goal days-banked chip ---');
// banked_days / banked_amount come from db.py; the chip only words them.
const tg = { metric: 'time_seconds' };
check('no figure means no chip (complete, overdue, not started)',
      P.goalBankedChip({ ...tg, banked_days: null, banked_amount: null }), null);
check('a sliver either way reads as on plan',
      P.goalBankedChip({ ...tg, banked_days: -0.03, banked_amount: -100 }).text, 'on plan');
const ahead = P.goalBankedChip({ ...tg, banked_days: 1.7, banked_amount: 6000 });
check('ahead names days and the amount', ahead.text, '1.7 days ahead (+1h 40m)');
check('ahead is the success tone', ahead.tone, 'success');
const behind = P.goalBankedChip({ ...tg, banked_days: -2.3, banked_amount: -8280 });
check('behind names days and the amount', behind.text, '2.3 days behind (−2h 18m)');
check('behind is the warn tone', behind.tone, 'warn');
check('one day is singular',
      P.goalBankedChip({ ...tg, banked_days: 1.02, banked_amount: 3672 }).text, '1 day ahead (+1h 1m)');
check('ten days and up drop the decimal',
      P.goalBankedChip({ ...tg, banked_days: 50.4, banked_amount: 181440 }).text.startsWith('50 days ahead'), true);
check('a chars goal words the amount in chars',
      P.goalBankedChip({ metric: 'chars_read', banked_days: 2.469, banked_amount: 12345 }).text,
      '2.5 days ahead (+12.3k)');

console.log('\n--- goal auto-raise ---');
// Base 100k over Mar 1–10 (10k/day), raised 10k when Mar 3 closed; today Mar 4.
const raisedGoal = { metric: 'chars_read', target: 110000, base_target: 100000,
  start_date: '2026-03-01', deadline: '2026-03-10',
  projected_end: '2026-03-08', projected_days_delta: -2 };
const RB = P.goalBurnupSeries(raisedGoal, ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'],
  [10000, 50000, 60000, 70000], [0, 0, 10000, 10000]);
check('before a raise the pace line is the base plan', RB.pace[1], 20000);
check('the pace line steps up on the day the raise landed', RB.pace[2], 40000);
check('the step keeps the base slope, it does not steepen', RB.pace[3] - RB.pace[2], 10000);
check('the pace line lands on the raised target', RB.pace[RB.labels.indexOf('2026-03-10')], 110000);
check('the target line starts at the base', RB.scope[0], 100000);
check('and steps up with the raise', RB.scope[2], 110000);
check('days ahead carry the full raise', RB.scope[RB.scope.length - 1], 110000);
check('the projection lands on the raised target',
      RB.projected[RB.labels.indexOf('2026-03-08')], 110000);
check('no raise series is no step', P.goalBurnupSeries(burnGoal, burnDates, burnCum).scope[3], 100000);

const capped = { metric: 'chars_read', raise_cap_days: 3 };
check('over the cap during today says so',
      P.goalBankedChip({ ...capped, banked_days: 3.4, banked_amount: 34000 }).text,
      '3.4 days ahead (+34.0k) · over the 3-day cap');
check('at the cap is just ahead',
      P.goalBankedChip({ ...capped, banked_days: 3, banked_amount: 30000 }).text, '3 days ahead (+30.0k)');
check('behind never mentions the cap',
      P.goalBankedChip({ ...capped, banked_days: -1, banked_amount: -10000 }).text, '1 day behind (−10.0k)');
check('a fractional cap words as a fraction', P.fmtGoalDays(0.5), '0.5 days');
check('the cap adjective is hyphenated', P.fmtGoalDays(0.5, true), '0.5-day');

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

// hourBlockBars -- the "how long each 100 hours took" bars. The in-progress
// block must not render as a finished one: drawn solid it reads as a very slow
// block rather than as still running, which inverts the chart's whole message.
console.log('\n--- hour blocks: the in-progress bar must look unfinished ---');
const hb = P.hourBlockBars([
  { index: 1, days: 63, active_days: 55, hours: 100, complete: true },
  { index: 2, days: 25, active_days: 24, hours: 100, complete: true },
  { index: 3, days: 76, active_days: 26, hours: 76.5, complete: false },
], 100);
check('labels name the hour mark each block ENDS on', hb.labels.join(','), '100h,200h,300h');
check('a finished block is solid accent',    hb.bg[0], P.CT.accent);
check('and carries no border',               hb.width[0], 0);
check('the in-progress block is washed out', hb.bg[2], P.ctAlpha(P.CT.accent, 0.14));
check('and is dashed',                       hb.dash[2].join(','), '4,3');
check('a finished block is not dashed',      hb.dash[0].length, 0);
check('bar heights are calendar days',       hb.days.join(','), '63,25,76');

// The label follows the seg size, not the row index: a 250h block at index 2 is
// the 500h mark. Getting this wrong mislabels every bar on any non-default size.
const hb250 = P.hourBlockBars([{ index: 2, days: 10, active_days: 9, hours: 250, complete: true }], 250);
check('block size drives the mark, not the row', hb250.labels[0], '500h');

check('no blocks yields no bars', P.hourBlockBars([], 100).labels.length, 0);

// mediaGridItems / seriesCardFacts -- under a status filter a series shows only
// its matching volumes: 2+ stay a stack badged shown/total, one is a plain card.
console.log('\n--- media grid: series group by status ---');
const vol = (title, status, secs, extra = {}) =>
  ({ title, status, total_secs: secs, activity_type: 'Reading', total_chars: 100, ...extra });
const gridMedia = [
  vol('A1', 'completed', 100), vol('A2', 'completed', 200), vol('A3', 'in_progress', 300),
  vol('Anime', null, 50, { activity_type: 'Anime', total_chars: 0 }),
  vol('B1', 'dropped', 40), vol('B2', 'on_hold', 60),
  vol('Solo', 'completed', 70),
];
const gridSeries = [
  { id: 1, name: 'A', total_secs: 9999, members: ['A1', 'A2', 'A3', 'Anime'].map(title => ({ title })) },
  { id: 2, name: 'B', total_secs: 9999, members: ['B1', 'B2'].map(title => ({ title })) },
];
const gridByTitle = new Map(gridMedia.map(m => [m.title, m]));
const summary = items => items.map(i =>
  `${i.kind}:${i.key}${i.shown ? '[' + i.shown.map(x => x.title).join(',') + ']' : ''}`).join(' ');

check('All: every series is one whole stack, then titles outside a series',
  summary(P.mediaGridItems(gridMedia, gridSeries, 'all')), 'series:s:1 series:s:2 title:t:Solo');
check('Completed: two matching volumes stay a stack of just those',
  summary(P.mediaGridItems(gridMedia, gridSeries, 'completed')), 'series:s:1[A1,A2] title:t:Solo');
check('In progress: a lone match is a plain card in its series\' slot',
  summary(P.mediaGridItems(gridMedia, gridSeries, 'in_progress')), 'title:s:1');
check('...carrying the volume itself',
  P.mediaGridItems(gridMedia, gridSeries, 'in_progress')[0].data.title, 'A3');
check('a series with no match contributes nothing',
  summary(P.mediaGridItems(gridMedia, gridSeries, 'on_hold')), 'title:s:2');

const shownA = gridSeries[0].members.slice(0, 2);
const partial = P.seriesCardFacts(gridSeries[0], gridByTitle, shownA);
check('a partial stack is badged shown/total, the anime not counted', partial.badge, '2/3');
check('...its time is just its own volumes', partial.secs, 300);
check('...and its line is the filter\'s status', partial.status, 'completed');
const whole = P.seriesCardFacts(gridSeries[0], gridByTitle);
check('a whole series keeps the plain member count', whole.badge, '4');
check('a whole series\' time is its volume cards summed, not get_series\' raw total', whole.secs, 650);
check('a status-less volume on its own draws no line',
  P.seriesCardFacts(gridSeries[0], gridByTitle, [{ title: 'Anime' }]).status, null);
check('a volume missing from the grid data adds no time',
  P.seriesCardFacts({ members: [{ title: 'A1' }, { title: 'gone' }] }, gridByTitle).secs, 100);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
