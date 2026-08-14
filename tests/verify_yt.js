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
const sent  = [];        // every runtime.sendMessage the content script fires
let dayTotalReply = 0;   // what the background answers with — the chip's anchor
const storageListeners = [];
const sandbox = {
  console: { log: noop },
  setTimeout: noop, clearTimeout: noop, setInterval: noop,
  URL, Date, Math, String, Number, Array, Object, JSON, RegExp,
  browser: {
    storage: {
      local: {
        get: (k) => Promise.resolve(typeof k === 'string' ? { [k]: store[k] } : {}),
        set: (o) => { Object.assign(store, o); return Promise.resolve(); },
      },
      // The stopwatch is started from the popup, so the tracker learns that a
      // manual session began through onChanged — never a re-read.
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
    // M2: accrual is handed to the background, which owns the day counter.
    // Recorded so the accrual tests can assert WHEN the day total is published:
    // a stall must not publish, a real stop must. The reply is the day total the
    // background now holds — the chip anchors its number to it.
    runtime: {
      sendMessage: (m) => { sent.push(m); return Promise.resolve({ dayTotal: dayTotalReply }); },
    },
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

// --- 4c. URL shapes ------------------------------------------------------------
// currentVideoId is the on/off switch for the entire tracker: a null id makes
// onNavigate hide the chip and every tick return early. /live/<id> — the share
// link YouTube hands out for a stream, and a path it serves 200 at rather than
// redirecting — used to return null, so live streams were never tracked at all.
const urlCases = [
  ['https://www.youtube.com/watch?v=abc12345678',            'abc12345678'],
  ['https://www.youtube.com/shorts/abc12345678',             'abc12345678'],
  ['https://www.youtube.com/live/abc12345678',               'abc12345678'],
  ['https://www.youtube.com/live/abc12345678?feature=share', 'abc12345678'],
  // The iframe player. Not matched on purpose: the content script has no
  // `all_frames`, so it runs in the top frame only and an embedded player (a
  // subframe of someone else's page) never loads it. Matching this would only
  // fire for an embed URL typed straight into the address bar.
  ['https://www.youtube.com/embed/abc12345678',              null],
  // No id anywhere in the URL — the documented gap. Supporting it means taking
  // identity from the player response, which is a different contract.
  ['https://www.youtube.com/@SomeChannel/live',              null],
  ['https://www.youtube.com/live',                           null],
  ['https://www.youtube.com/',                               null],
  ['https://www.youtube.com/feed/subscriptions',             null],
];
for (const [href, want] of urlCases) {
  scenario.href = href;
  assert.strictEqual(sandbox.currentVideoId(), want,
    `${href} -> expected ${want}, got ${sandbox.currentVideoId()}`);
}
scenario.href = 'https://www.youtube.com/watch?v=vid001';   // restore for later sections
console.log(`  ok  currentVideoId handles ${urlCases.length} URL shapes (incl. /live/<id>)`);

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

// --- 8. accrual liveness ------------------------------------------------------
// THE bug this section pins: "not paused" is not the same as "playing". Pressing
// play flips `paused` to false instantly, but YouTube then spends a couple of
// seconds spinning up with the spinner on screen — and `readyState` stays 3-4
// throughout, because the buffer is still populated. Those seconds were credited.
//
// The tests drive tickAccrual() directly against a fake clock and a fake <video>,
// so a stall is reproducible rather than something you have to sit and watch.
// `state`, `stalled` and `lastMediaTime` are lexical (const/let), so they aren't
// properties of the sandbox — reach them through the context.
const { tickAccrual, render: draw } = sandbox;
const st = vm.runInContext('state', ctx);

const vid = {
  paused: false, ended: false, muted: false, volume: 1,
  readyState: 4, currentTime: 0, playbackRate: 1, seeking: false,
};
sandbox.document.querySelector = (sel) => (sel === 'video' ? vid : null);

let clock = 1700000000000;
sandbox.Date = { now: () => clock };     // yt-track.js only ever calls Date.now()

// One second of wall clock, during which the playhead moved `mediaAdv` seconds.
// mediaAdv = 0 is a stall: the clock ran, the video didn't.
function tick(mediaAdv, wallMs = 1000) {
  clock += wallMs;
  vid.currentTime += mediaAdv;
  tickAccrual();
}

function resetAccrual() {
  st.override = true;                    // force tracking() regardless of verdict
  st.secs = 0;
  st.lastTick = 0;
  vid.currentTime = 0;
  vid.paused = false; vid.muted = false; vid.seeking = false;
  vid.readyState = 4; vid.playbackRate = 1;
  vm.runInContext('lastMediaTime = null; wasAccruing = false; stalled = false;', ctx);
  sent.length = 0;
}
const isStalled = () => vm.runInContext('stalled', ctx);
const getChip   = () => vm.runInContext('chip', ctx);

// Flip the manual stopwatch the way the popup does: write the key, then let the
// storage listener the tracker registered carry the news. A re-read would not —
// the tracker only reads `timerRunning` once, at load.
function setManualTimer(on) {
  store.timerRunning = on;
  for (const fn of storageListeners) fn({ timerRunning: { newValue: on } }, 'local');
}

// flushAndPost() is async, so a handful of `await Promise.resolve()` is NOT
// enough to settle it — and an under-drained queue makes the negative assertion
// in 8f pass vacuously. setImmediate runs after the whole microtask queue.
const drain = () => new Promise(r => setImmediate(r));

// start() is async, so its `await loadSettings()` leaves onNavigate() sitting in
// the microtask queue for as long as this file stays synchronous — it would fire
// at the FIRST await below and reset state.secs/override mid-test, which is
// exactly what made 8f pass against a build it should have failed. Let it land
// before any scenario is set up.
async function accrualChecks() {
  await drain();

// -- 8a. baseline: playing normally credits wall-clock seconds -----------------
resetAccrual();
tick(1);                                  // primes the reference; credits nothing
tick(1); tick(1); tick(1);
assert.ok(Math.abs(st.secs - 3) < 0.01, `normal playback should credit 3s, got ${st.secs}`);
console.log('  ok  playing normally credits one second per second');

// -- 8b. THE REGRESSION: the unpause spin-up is not credited -------------------
resetAccrual();
tick(1); tick(1);                         // playing
vid.paused = true;
tick(0); tick(0);                         // paused — no credit, obviously
const atPause = st.secs;

vid.paused = false;                       // user hits play...
// ...and YouTube takes ~3s to actually start. Every legacy check passes here:
assert.strictEqual(vid.paused, false);
assert.ok(vid.readyState > 2, 'buffer is still populated during the spin-up');
assert.strictEqual(vm.runInContext('accrualGate()', ctx).ok, true,
  'the old gate DOES pass during the spin-up — that is why the playhead check exists');
tick(0); tick(0); tick(0);                // spinner: clock runs, playhead frozen
assert.strictEqual(st.secs, atPause,
  `spin-up must credit nothing, gained ${st.secs - atPause}s`);
assert.strictEqual(isStalled(), true, 'a frozen playhead should mark the tick stalled');
console.log('  ok  the 3-second unpause spin-up credits nothing');

tick(1); tick(1);                         // playback actually starts
assert.ok(Math.abs(st.secs - (atPause + 2)) < 0.01,
  `playback should resume crediting, got ${st.secs - atPause}s`);
assert.strictEqual(isStalled(), false, 'stall flag should clear once the playhead moves');
console.log('  ok  crediting resumes the moment the playhead moves again');

// -- 8c. the chip says why it froze -------------------------------------------
resetAccrual();
tick(1); tick(1);
tick(0);                                  // stall
draw();
assert.ok(sandbox.document.createElement().textContent !== undefined);
const chipEl = vm.runInContext('chip', ctx);
assert.ok(chipEl.textContent.startsWith('⧗'),
  `stalled chip should show the loading glyph, got ${JSON.stringify(chipEl.textContent)}`);
tick(1); draw();
assert.ok(chipEl.textContent.startsWith('⏱'),
  `playing chip should show the stopwatch, got ${JSON.stringify(chipEl.textContent)}`);
console.log('  ok  chip shows ⧗ while stalled and ⏱ while playing');

// -- 8d. playback rate: real minutes of your life, not video minutes -----------
// The liveness check must stay a BOOLEAN. If it ever leaked into the amount, a
// 1.5x tick would credit 1.5s.
resetAccrual();
vid.playbackRate = 1.5;
tick(1.5); tick(1.5); tick(1.5);
assert.ok(Math.abs(st.secs - 2) < 0.01, `1.5x should credit wall-clock 2s, got ${st.secs}`);
console.log('  ok  1.5x playback still credits wall-clock seconds');

resetAccrual();
vid.playbackRate = 0.5;
tick(0.5); tick(0.5); tick(0.5);
assert.ok(Math.abs(st.secs - 2) < 0.01, `0.5x should credit wall-clock 2s, got ${st.secs}`);
console.log('  ok  0.5x playback is not mistaken for a stall');

// -- 8e. scrubbing is motion, not playback ------------------------------------
resetAccrual();
tick(1); tick(1);
const beforeSeek = st.secs;
vid.seeking = true;  tick(30);            // drag the scrubber forward
vid.seeking = false; tick(0);             // landed, now buffering at the new spot
assert.strictEqual(st.secs, beforeSeek, `a seek credited ${st.secs - beforeSeek}s`);
console.log('  ok  seeking forward credits nothing');

resetAccrual();
tick(1); tick(1);
const beforeBack = st.secs;
tick(-20);                                // jump backwards
assert.strictEqual(st.secs, beforeBack, 'a backwards jump credited time');
console.log('  ok  jumping backwards credits nothing');

// -- 8f. a stall must NOT publish the day total -------------------------------
// If a stall flipped wasAccruing, the real pause that follows would find it
// already false and publish nothing — the day would sit unposted until the
// background's next 2-minute interval.
async function postingContract() {
  resetAccrual();
  tick(1); tick(1);
  await drain();
  sent.length = 0;

  tick(0); tick(0);                       // stall
  await drain();
  assert.ok(!sent.some(m => m.type === 'yt-post-now'),
    'a stall must not publish the day total');
  console.log('  ok  a stall does not publish the day total');

  // Pausing straight out of the stall, without playback resuming in between —
  // the sequence where "just fold the stall into wasAccruing" loses the publish
  // entirely, because the flag is already false when the real stop arrives.
  vid.paused = true;
  tick(0);                                // a REAL stop
  await drain();
  assert.ok(sent.some(m => m.type === 'yt-post-now'),
    'pausing after a stall must still publish — the stall must not have eaten the transition');
  console.log('  ok  pausing after a stall still publishes');
}

// -- 8g. clock jumps ----------------------------------------------------------
function clockJumps() {
  // Laptop lid closed for an hour with the video "playing": the playhead did not
  // move, so nothing is credited. The old jump guard credited a full second here.
  resetAccrual();
  tick(1); tick(1);
  const beforeSleep = st.secs;
  tick(0, 3600000);
  assert.strictEqual(st.secs, beforeSleep, 'a sleeping machine credited time');
  console.log('  ok  sleeping through an hour credits nothing');

  // Backgrounded tab whose timer was throttled: the video really did play for a
  // minute, so it's live — but the jump guard still caps the credit at one tick.
  resetAccrual();
  tick(1); tick(1);
  const beforeThrottle = st.secs;
  tick(60, 60000);
  const gained = st.secs - beforeThrottle;
  assert.ok(Math.abs(gained - 1) < 0.01,
    `a throttled tick should credit one interval, got ${gained}s`);
  console.log('  ok  a throttled background tick credits one interval, not the gap');
}

// -- 9. the chip shows the DAY total, anchored to the background --------------
// The per-video counter it used to show reset on every navigation and matched
// nothing downstream: what gets stored is one cumulative row per logical day.
// The number is the background's figure plus what this page still holds — not a
// local sum, because the background clamps credits to the wall clock and two
// tabs playing at once must not both bill the same second.
async function dayTotalDisplay() {
  const flush = vm.runInContext('flushAccrual', ctx);

  resetAccrual();
  vm.runInContext('dayAnchor = 0; anchorAt = 0; pendingSecs = 0;', ctx);
  dayTotalReply = 0;

  tick(1); tick(1); tick(1); tick(1);        // first primes, then 3s of playback
  draw();
  assert.strictEqual(getChip().textContent, '⏱ 00:00:03',
    `unflushed seconds should show, got ${JSON.stringify(getChip().textContent)}`);

  // The background says the day already holds an hour — earlier videos, or
  // another tab. The chip must follow that, not this video's 3 seconds.
  dayTotalReply = 3600;
  await flush();
  draw();
  assert.strictEqual(getChip().textContent, '⏱ 01:00:00',
    `chip should re-anchor to the day total, got ${JSON.stringify(getChip().textContent)}`);
  console.log('  ok  chip shows the day total, not the per-video counter');

  tick(1); tick(1);
  draw();
  assert.strictEqual(getChip().textContent, '⏱ 01:00:02',
    `chip should tick on top of the anchor between flushes, got ${JSON.stringify(getChip().textContent)}`);
  console.log('  ok  chip ticks per second on top of the anchor');

  // The per-video reading isn't gone, it moved to where it costs no width.
  assert.ok(Math.abs(st.secs - 5) < 0.01, `per-video counter should still run, got ${st.secs}`);
  assert.ok(/This video: 00:00:05/.test(getChip().title),
    `tooltip should carry the per-video time, got ${JSON.stringify(getChip().title)}`);
  console.log('  ok  per-video time survives in the tooltip');

  // A page holding nothing still re-reads the total, so a tab left paused while
  // another one plays doesn't sit on a figure that stopped moving hours ago.
  sent.length = 0;
  vm.runInContext('pendingSecs = 0; anchorAt = 0;', ctx);
  dayTotalReply = 7200;
  await flush();
  assert.ok(sent.some(m => m.type === 'yt-day-total'),
    'an idle flush should re-read the day total');
  draw();
  assert.ok(getChip().textContent.includes('02:00:00'),
    `idle chip should pick up another tab's viewing, got ${JSON.stringify(getChip().textContent)}`);
  console.log('  ok  an idle page re-reads the day total');

  // -- the number must never go BACKWARDS across a flush -----------------------
  // The tick loop calls flushAccrual() WITHOUT awaiting it, so it runs as far as
  // its first await — zeroing pendingSecs — and returns a pending promise. The
  // very next line of that tick is render(). So the paint lands inside the
  // handover window, and if those seconds belong to neither counter for its
  // duration the chip drops by the whole batch and jumps back a tick later.
  // That is not a slow-round-trip edge case: it happened on EVERY flush, and
  // read as the timer bouncing around wildly.
  //
  // Reproduced the way the tick loop actually runs it — flush un-awaited, paint
  // immediately after — so a regression cannot hide behind an await this loop
  // does not perform.
  resetAccrual();
  vm.runInContext('dayAnchor = 0; anchorAt = 0; pendingSecs = 0; inFlight = 0;', ctx);
  let bg = 0;
  dayTotalReply = 0;
  const readOut = (s) => Number(String(s).replace(/\D/g, '')) || 0;

  const shown = [];
  for (let i = 0; i < 12; i++) {
    tick(1);
    if (i % 4 === 3) {                       // a flush tick, un-awaited
      bg += vm.runInContext('pendingSecs', ctx);
      dayTotalReply = bg;
      flush();
    }
    draw();
    shown.push(readOut(getChip().textContent));
    await drain();                           // let the reply land, as a real tick would
  }

  const back = shown.filter((v, i) => i && v < shown[i - 1]);
  assert.strictEqual(back.length, 0,
    `the chip stepped backwards ${back.length} time(s) across flushes: ${shown.join(' ')}`);
  console.log('  ok  the chip never steps backwards across a flush');
}

// -- 10. the tracker yields to the manual stopwatch ---------------------------
// Both features measure the same wall clock, and neither used to know the other
// existed: a stopwatch session started on a YouTube tab logged its own row while
// this kept accruing, so the same minutes landed in `sessions` twice with no
// cross-source overlap detection downstream to catch it.
async function manualYield() {
  resetAccrual();
  vm.runInContext('dayAnchor = 0; anchorAt = 0; pendingSecs = 0;', ctx);
  dayTotalReply = 0;
  tick(1); tick(1); tick(1);                 // 2s of real listening
  const before = st.secs;
  sent.length = 0;

  setManualTimer(true);
  assert.strictEqual(vm.runInContext('manualTimer', ctx), true,
    'the tracker should see the stopwatch start');

  tick(1); tick(1); tick(1);
  assert.strictEqual(st.secs, before,
    `a running stopwatch must suppress accrual, gained ${st.secs - before}s`);
  console.log('  ok  a running stopwatch suppresses YouTube accrual');

  await drain();
  assert.ok(sent.some(m => m.type === 'yt-post-now'),
    'yielding must publish what was accrued before the stopwatch started');
  console.log('  ok  yielding publishes the seconds accrued before it');

  // ONE chip at a time. timer-overlay.js already has its own chip up and
  // counting; this one used to sit under it reading "⏸ manual timer" — two
  // overlays stacked in the corner, the second present only to announce it
  // wasn't the one working. It stands down instead.
  draw();
  assert.strictEqual(getChip(), null,
    `the chip must be gone while the stopwatch owns the corner, got ` +
    JSON.stringify(getChip() && getChip().textContent));
  console.log('  ok  the chip stands down while the stopwatch is running');

  // Armed-but-waiting and paused sessions count nothing, so they must not
  // suppress real listening — only `timerRunning` does. The chip has to come
  // BACK for those, or a paused stopwatch would leave the corner empty while
  // this tracker was the one actually counting.
  setManualTimer(false);
  tick(1); tick(1);
  assert.ok(st.secs > before, 'accrual must resume when the stopwatch stops');
  console.log('  ok  accrual resumes when the stopwatch stops');

  draw();
  assert.ok(getChip() && /\d\d:\d\d:\d\d/.test(getChip().textContent),
    `the chip must return when the stopwatch stops, got ` +
    JSON.stringify(getChip() && getChip().textContent));
  console.log('  ok  the chip comes back when the stopwatch stops');
}

  clockJumps();
  await postingContract();
  await dayTotalDisplay();
  await manualYield();
}

accrualChecks()
  .then(() => console.log('\nyt-track.js: all checks passed'))
  .catch(e => { console.error(e); process.exit(1); });
