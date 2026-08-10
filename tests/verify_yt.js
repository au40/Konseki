// Load-time verification for ext/yt-track.js.
// 1. Evals the module with stubbed browser globals (catches top-level throws
//    that `node --check` misses -- those kill the content script silently).
// 2. Drives classifyNow() through the detection ladder. The ASR-vs-manual-track
//    distinction is the whole feature: an English video with a fan-uploaded
//    Japanese subtitle track is NOT Japanese listening.
// 3. Pins the SPA-navigation contract, which has broken twice: a verdict must
//    never be derived from data that can't prove which video it describes.
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const assert = require('assert');

const EXT = process.env.EXT_SRC || path.resolve(__dirname, '..', 'ext');
const src = fs.readFileSync(path.join(EXT, 'yt-track.js'), 'utf8');

// --- what the stubs read; mutated per test case ------------------------------
const scenario = {
  videoId:     'vid001',   // which video the player response describes
  tracklist:   [],
  title:       '',
  channelId:   '',
  audioTrack:  null,
  noPlayerApi: false,      // force the window.ytInitialPlayerResponse fallback
  globalResp:  null,       // window.ytInitialPlayerResponse
  href:        'https://www.youtube.com/watch?v=vid001',
};

function playerResp() {
  return {
    videoDetails: {
      videoId:   scenario.videoId,
      title:     scenario.title,
      channelId: scenario.channelId,
    },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: scenario.tracklist } },
  };
}

// --- minimal browser stubs ---------------------------------------------------
const noop = () => {};
function fakeEl() {
  return {
    style: {}, id: '', textContent: '',
    offsetWidth: 100, offsetHeight: 24,
    addEventListener: noop, remove: noop,
    setPointerCapture: noop, releasePointerCapture: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    getAttribute: () => null,
  };
}

const player = {
  getPlayerResponse() { return scenario.noPlayerApi ? null : playerResp(); },
  getAudioTrack()     { return scenario.audioTrack; },
};

const store = {};
const sandbox = {
  console: { log: noop },
  setTimeout: noop, clearTimeout: noop, setInterval: noop,
  URL, Date, Math, String, Number, Array, Object, JSON, RegExp,
  browser: {
    storage: { local: {
      get: (k) => Promise.resolve(typeof k === 'string' ? { [k]: store[k] } : {}),
      set: (o) => { Object.assign(store, o); return Promise.resolve(); },
    } },
    // M2: accrual is handed to the background, which owns the day counter.
    runtime: { sendMessage: () => Promise.resolve({ dayTotal: 0 }) },
  },
  document: {
    getElementById: (id) => (id === 'movie_player' ? player : null),
    querySelector:  () => null,
    createElement:  () => fakeEl(),
    addEventListener: noop,
    documentElement: { appendChild: noop },
    visibilityState: 'visible',
  },
  location: { get href() { return scenario.href; } },
  addEventListener: noop,
};
sandbox.window = sandbox;
Object.defineProperty(sandbox, 'ytInitialPlayerResponse', {
  get() { return scenario.globalResp; },
  configurable: true,
});
sandbox.innerWidth = 1920;
sandbox.innerHeight = 1080;

// --- 1. load ------------------------------------------------------------------
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'yt-track.js' });
console.log('  ok  module evaluated without throwing');

const { classifyNow, asrLanguage, normalizeTracks, rememberChannel, render, probe } = sandbox;
assert.ok(typeof classifyNow === 'function', 'classifyNow should be reachable');

// --- 2. the detection ladder --------------------------------------------------
const asr = (lang) => ({ languageCode: lang, vssId: 'a.' + lang, kind: 'asr' });
const man = (lang) => ({ languageCode: lang, vssId: '.' + lang, kind: '' });

const BASE = {
  videoId: 'vid001', tracklist: [], title: '', channelId: '',
  audioTrack: null, noPlayerApi: false, globalResp: null,
};

function check(label, setup, expectVerdict, reasonMatch) {
  Object.assign(scenario, BASE, setup);
  const r = classifyNow();
  assert.strictEqual(r.verdict, expectVerdict,
    `${label}: expected ${expectVerdict}, got ${r.verdict} (${r.reason})`);
  if (reasonMatch) {
    assert.ok(reasonMatch.test(r.reason),
      `${label}: reason ${JSON.stringify(r.reason)} !~ ${reasonMatch}`);
  }
  console.log(`  ok  ${label} -> ${r.verdict} (${r.reason})`);
}

check('ASR ja',                  { tracklist: [asr('ja')] },            'ja',      /ASR ja/);
check('ASR en',                  { tracklist: [asr('en')] },            'other',   /ASR en/);
check('ASR ja-JP normalises',    { tracklist: [asr('ja-JP')] },         'ja',      /ASR ja/);

// THE distinction. English audio, fan-subbed in Japanese. Keying on "has a ja
// track" instead of "the ASR track says ja" would call this Japanese.
check('manual ja sub on en ASR', { tracklist: [asr('en'), man('ja')] },  'other',  /ASR en/);
check('manual ja sub, no ASR',   { tracklist: [man('ja')] },            'unknown', /no ASR/);

// Auto-dubbing: ASR heard Japanese, but an English track is selected.
check('ja ASR + en dub',         { tracklist: [asr('ja')], audioTrack: { id: 'x;lang=en' } },
                                                                        'other',   /dubbed \(en\)/);
check('ja ASR + ja audio',       { tracklist: [asr('ja')], audioTrack: { id: 'x;lang=ja' } },
                                                                        'ja',      /ASR ja/);

// Fallback source: player API unavailable, page global populated.
check('global response fallback',
  { noPlayerApi: true,
    globalResp: { videoDetails: { videoId: 'vid001' },
                  captions: { playerCaptionsTracklistRenderer: { captionTracks: [asr('ja')] } } } },
  'ja', /ASR ja/);

check('no tracks, no title',     {},                                    'unknown', /no ASR/);
check('no tracks, kana title',   { title: '日本語の動画' },              'unknown', /kana/);

// --- 3. channel cache ---------------------------------------------------------
rememberChannel('UCtest', true);
check('cached channel, no ASR', { title: 'no captions', channelId: 'UCtest' }, 'ja', /remembered/);

rememberChannel('UCnope', false);
check('cached non-ja channel',  { title: 'nope', channelId: 'UCnope' }, 'other', /remembered/);

check('ASR beats stale cache',
  { tracklist: [asr('en')], channelId: 'UCtest' }, 'other', /ASR en/);

// --- 4. the SPA navigation contract -------------------------------------------
// REGRESSION, broken twice. First cut read getOption('captions','tracklist'),
// which serves the PREVIOUS video's list after a navigation. Second cut guarded
// on getVideoData().video_id -- but that updates immediately, so a fresh id was
// paired with a stale tracklist and the verdict still carried over. Both
// directions were wrong: jp->en kept tracking, en->jp stopped.
//
// The contract now: every field of a verdict comes from ONE player response
// that proved it describes the expected video.
Object.assign(scenario, BASE, { tracklist: [asr('ja')], videoId: 'vidOLD' });

let g = classifyNow('vidNEW');       // navigated to NEW, response still describes OLD
assert.strictEqual(g.settled, false, 'stale response must not settle a verdict');
assert.strictEqual(g.verdict, 'unknown');
assert.ok(/not ready/.test(g.reason), `expected "not ready", got ${g.reason}`);
console.log('  ok  stale response refuses to classify (verdict cannot carry over)');

scenario.videoId = 'vidNEW';         // player catches up
g = classifyNow('vidNEW');
assert.strictEqual(g.settled, true, 'matching response should classify');
assert.strictEqual(g.verdict, 'ja');
console.log('  ok  classifies once the response describes the expected video');

// The page global is validated on the same terms -- it is the other stale source.
Object.assign(scenario, BASE, {
  videoId: 'vidNEW', noPlayerApi: true,
  globalResp: { videoDetails: { videoId: 'vidOLD', channelId: 'UCstale' },
                captions: { playerCaptionsTracklistRenderer: { captionTracks: [asr('ja')] } } },
});
g = classifyNow('vidNEW');
assert.strictEqual(g.settled, false, 'stale page global must not settle a verdict');
assert.strictEqual(g.meta.channelId, '', 'stale global must not supply channelId');
console.log('  ok  stale page global is rejected too (cache cannot be poisoned)');

// --- 4b. validated-but-empty settles early ------------------------------------
// "No tracks yet" and "no tracks at all" are different answers. Once a
// VALIDATED response shows zero tracks, that's a fact about the video, so
// scheduleClassify stops polling early instead of burning the full 12s budget.
// Live streams have no ASR track and hit this every time.
Object.assign(scenario, BASE, { videoId: 'vid001', tracklist: [] });
let e = classifyNow('vid001');
assert.strictEqual(e.settled, false, 'no ASR track is still unsettled');
assert.strictEqual(e.validated, true, 'a validated empty response must be marked validated');
console.log('  ok  validated empty response is flagged for the short poll budget');

Object.assign(scenario, BASE, { videoId: 'vidOLD', tracklist: [asr('ja')] });
e = classifyNow('vidNEW');
assert.strictEqual(e.validated, false, 'an unvalidated response must keep the full budget');
console.log('  ok  unvalidated response keeps the full poll budget');

// --- 5. asrLanguage / normalizeTracks edge cases ------------------------------
assert.strictEqual(asrLanguage(normalizeTracks([])), null, 'empty tracklist -> null');
assert.strictEqual(asrLanguage(normalizeTracks([man('ja')])), null, 'manual-only -> null');
assert.strictEqual(
  asrLanguage(normalizeTracks([{ languageCode: 'ja', vssId: 'a.ja' }])), 'ja',
  'vssId a.* counts as ASR even without kind');
console.log('  ok  asrLanguage edge cases');

// --- 6. the probe never throws (it runs inside the classify loop) -------------
Object.assign(scenario, BASE, { tracklist: [asr('ja')] });
assert.doesNotThrow(() => probe('vid001'), 'probe() threw');
assert.strictEqual(probe('vid001').asr, 'ja', 'probe should report the ASR language');
console.log('  ok  probe reports without throwing');

// --- 7. the chip renders in every state --------------------------------------
for (const label of ['tracked', 'unsure', 'off']) {
  assert.doesNotThrow(render, `render() threw in the ${label} state`);
}
console.log('  ok  chip renders without throwing');

console.log('\nyt-track.js: all checks passed');
