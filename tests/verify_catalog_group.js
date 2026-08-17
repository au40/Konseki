// Load-time verification for the Catalog page's series grouping.
//
// The grouping is display-only, but it is ordering-sensitive: a series takes
// the position of its FIRST member so the list doesn't reshuffle as volumes
// arrive, singleton series must not be wrapped in a header that hides nothing,
// and members must only render while their group is open. None of that is
// reachable from pytest, so it is exercised here against a recording DOM.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = process.env.UI_SRC || path.resolve(__dirname, '..', 'src');
const uiJs = fs.readFileSync(path.join(SRC, 'ui.js'), 'utf8');

// --- a DOM that records what was appended ------------------------------------
function makeEl(tag) {
  return {
    tagName: tag, className: '', innerHTML: '', style: {}, children: [],
    dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return { onclick: null, set textContent(v) {}, style: {} }; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    getContext() { return this; }, remove() {},
  };
}

const body = makeEl('tbody');
const empty = makeEl('p');
const nodes = { 'catalog-body': body, 'catalog-empty': empty };

const noop = () => {};
const documentStub = {
  getElementById: (id) => nodes[id] || makeEl('div'),
  createElement: makeEl,
  querySelector: () => makeEl('div'),
  querySelectorAll: () => [],
  addEventListener: noop,
  documentElement: { setAttribute: noop, removeAttribute: noop, style: { setProperty: noop } },
  body: makeEl('body'),
};

const sandbox = {
  document: documentStub,
  window: { addEventListener: noop, pywebview: { api: {} }, matchMedia: () => ({ matches: false, addEventListener: noop }) },
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: noop, localStorage: { getItem: () => null, setItem: noop },
  navigator: { userAgent: 'node' }, location: { href: '' },
  Chart: function () { return { destroy: noop, update: noop, data: {}, options: {} }; },
  getComputedStyle: () => ({ getPropertyValue: () => '#000000' }),
  fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
  alert: noop, confirm: () => true,
};
sandbox.globalThis = sandbox;
sandbox.window.document = documentStub;
// ui.js styles Chart.js globals at load time — same stub shape verify_ui.js uses.
sandbox.Chart.defaults = { color: '', borderColor: '', font: {} };
sandbox.Chart.register = noop;
// `catalogRows` (let) and `catOpenSeries` (const) are lexical bindings, so they
// never become sandbox properties. Same probe trick verify_ui.js uses to reach
// them: append an accessor object over the module's own scope.
const PROBE = `
globalThis.__cat = {
  set catalogRows(v) { catalogRows = v; },
  get catOpenSeries() { return catOpenSeries; },
  renderCatalogBody, catSeriesAggregate,
};`;
vm.createContext(sandbox);
vm.runInContext(uiJs + PROBE, sandbox, { filename: 'ui.js' });
const P = sandbox.__cat;

// --- assertions --------------------------------------------------------------
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}` +
              (ok ? '' : `  (expected ${JSON.stringify(expected)})`));
}

function row(name, opts = {}) {
  return {
    id: opts.id || name.length, name, display_name: name,
    reading_type: opts.type || 'manga', chars: opts.chars || 0,
    volumes: opts.volumes || 0, linked: true,
    series_key: opts.key || '', series_label: opts.label || '',
  };
}

function render(rows) {
  P.catalogRows = rows;
  body.children = [];
  P.renderCatalogBody();
  return body.children.map(c => c.className || 'plain');
}

console.log('--- series grouping in the catalog table ---');

// 1. No series → every row plain, in order.
check('ungrouped rows render flat',
  render([row('A'), row('B'), row('C')]),
  ['plain', 'plain', 'plain']);

// 2. A real group collapses to a single header row by default.
const grouped = [
  row('Vol 1', { key: 'series:1', label: 'My Series' }),
  row('Vol 2', { key: 'series:1', label: 'My Series' }),
  row('Vol 3', { key: 'series:1', label: 'My Series' }),
];
check('a series collapses to one header', render(grouped), ['cat-series-row']);

// 3. Opening it reveals members, marked as nested.
P.catOpenSeries.add('series:1');
check('opening reveals its members',
  render(grouped),
  ['cat-series-row open', 'cat-member-row', 'cat-member-row', 'cat-member-row']);
P.catOpenSeries.clear();

// 4. A series with ONE catalog entry is not wrapped — a header hiding nothing
//    is worse than no header.
check('a singleton series stays a plain row',
  render([row('Only', { key: 'series:9', label: 'Lonely' })]),
  ['plain']);

// 5. Ordering: the series sits where its FIRST member sat, not at either end.
check('the group holds its first member\'s position',
  render([
    row('Aardvark'),
    row('Vol 1', { key: 'series:1', label: 'My Series' }),
    row('Vol 2', { key: 'series:1', label: 'My Series' }),
    row('Zebra'),
  ]),
  ['plain', 'cat-series-row', 'plain']);

// 6. Interleaved members still collapse into one header at the first position.
check('non-adjacent members still gather into one group',
  render([
    row('Vol 1', { key: 'series:1', label: 'S' }),
    row('Loose'),
    row('Vol 2', { key: 'series:1', label: 'S' }),
  ]),
  ['cat-series-row', 'plain']);

// 7. Two distinct series don't merge.
check('separate series stay separate',
  render([
    row('A1', { key: 'series:1', label: 'One' }),
    row('A2', { key: 'series:1', label: 'One' }),
    row('B1', { key: 'series:2', label: 'Two' }),
    row('B2', { key: 'series:2', label: 'Two' }),
  ]),
  ['cat-series-row', 'cat-series-row']);

console.log('\n--- header aggregate ---');
check('manga members total in volumes',
  P.catSeriesAggregate([row('a', { volumes: 3 }), row('b', { volumes: 4 })]),
  '7 vols');
check('one volume is singular',
  P.catSeriesAggregate([row('a', { volumes: 1 })]), '1 vol');
check('an unfinished series reads as zero, not blank',
  P.catSeriesAggregate([row('a'), row('b')]), '0 vols');
check('a mixed series shows both units',
  P.catSeriesAggregate([
    row('a', { volumes: 2 }),
    row('b', { type: 'book', chars: 50000 }),
  ]),
  '2 vols · 50.0k chars');   // fmtChars is the app's compact format, not raw digits

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
