// yt-track.js — passive YouTube listening tracker.
//
// ── WHAT THIS FILE OWNS ─────────────────────────────────────────────────────
// Classification and accrual for ONE page: it decides whether the video is
// Japanese (from YouTube's own ASR caption language), shows that verdict on a
// draggable chip, and accrues wall-clock seconds while audio is actually
// playing.
//
// It does not own the number and it does not talk to the tracker. Accrued
// seconds are handed to background.js in batches (`yt-accrue`), which keeps the
// per-logical-day totals across tabs and does the posting; this file only asks
// it to publish early when playback stops (`yt-post-now`). The page is the sole
// holder of a batch until the background acknowledges it — see flushAccrual.
//
// The signal: every auto-captioned video carries a caption track with
// kind="asr", and its languageCode is YouTube's own speech-recognition verdict
// on the spoken audio. We key on the ASR track SPECIFICALLY — an English video
// with a fan-uploaded Japanese subtitle track has a `ja` track and is not
// Japanese listening.

const LOG = "[konseki-yt]";

// ── Page-context access ──────────────────────────────────────────────────────
// YouTube attaches its player API to the #movie_player element as JS expandos,
// which Firefox's Xray vision hides from content scripts. wrappedJSObject waives
// that. Chrome would need a page-script injection instead; we're Firefox-first.

function unwrap(o) {
  try { return (o && o.wrappedJSObject) || o; } catch { return o; }
}

function getPlayer() {
  const el = document.getElementById("movie_player");
  return el ? unwrap(el) : null;
}

function playerResponse() {
  try {
    const w = unwrap(window);
    return w && w.ytInitialPlayerResponse;
  } catch {
    return null;
  }
}

// ── Reading the caption tracklist ────────────────────────────────────────────
// SOURCE OF TRUTH: the player response, NOT getOption('captions','tracklist').
//
// This is the second attempt at this. getOption() reads the *captions module*,
// which reloads on its own schedule after an SPA navigation — so it happily
// serves the PREVIOUS video's tracklist while the player has already moved on.
// Guarding on getVideoData().video_id did not help, because that updates
// immediately: the id looked fresh while the tracklist was stale, and a
// Japanese verdict carried onto the next English video (and vice versa).
//
// A player response carries its own videoDetails.videoId, so it can PROVE which
// video it describes. That self-validation is the whole point — anything that
// can't prove it is not trusted, and we keep polling instead.
//
// Page objects are copied into plain content-script objects field by field;
// don't hand a page array to Array.prototype methods.

function normalizeTracks(raw) {
  const out = [];
  try {
    const n = raw.length | 0;
    for (let i = 0; i < n; i++) {
      const t = raw[i];
      if (!t) continue;
      out.push({
        languageCode: String(t.languageCode || t.language_code || ""),
        vssId:        String(t.vssId || t.vss_id || ""),
        kind:         String(t.kind || ""),
      });
    }
  } catch {}
  return out;
}

function responseVideoId(r) {
  try {
    return r && r.videoDetails && r.videoDetails.videoId
      ? String(r.videoDetails.videoId) : null;
  } catch {
    return null;
  }
}

// A player response that demonstrably describes `expectedId`, or null if the
// player hasn't caught up. Pass no id (tests, first load) to take whatever is
// available. Order: live player API first, then the page global.
function freshPlayerResponse(expectedId) {
  const p = getPlayer();
  try {
    if (p && typeof p.getPlayerResponse === "function") {
      const r = p.getPlayerResponse();
      if (r && (!expectedId || responseVideoId(r) === expectedId)) return r;
    }
  } catch {}
  try {
    const r = playerResponse();
    if (r && (!expectedId || responseVideoId(r) === expectedId)) return r;
  } catch {}
  return null;
}

function tracksFromResponse(r) {
  try {
    const tl = r && r.captions
      && r.captions.playerCaptionsTracklistRenderer
      && r.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (tl && tl.length) return normalizeTracks(tl);
  } catch {}
  return [];
}

// The ASR track is the one YouTube generated itself. vssId "a.<lang>" is the
// same signal as kind="asr"; both are checked because which one is populated
// varies by source.
function asrLanguage(tracks) {
  const asr = tracks.find(t => t.kind === "asr" || t.vssId.startsWith("a."));
  if (!asr || !asr.languageCode) return null;
  return asr.languageCode.toLowerCase().split("-")[0];
}

// ── Dubbing ──────────────────────────────────────────────────────────────────
// YouTube auto-dubbing serves an English audio track over Japanese audio. The
// ASR track still says `ja`, but you aren't hearing Japanese. Best-effort: the
// selected track's id usually carries a lang= parameter.

function selectedAudioLang() {
  const p = getPlayer();
  if (!p || typeof p.getAudioTrack !== "function") return null;
  try {
    const t = p.getAudioTrack();
    if (!t) return null;
    const id = String(t.id || "");
    const m = id.match(/lang=([a-z]{2,3})/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

// ── Metadata fallbacks ───────────────────────────────────────────────────────

const KANA = /[぀-ヿ]/;   // kana is Japanese-specific; kanji alone is not

// Title and channel come from the SAME validated response the tracks did, so
// they can't describe a different video than the verdict does. A stale channelId
// would poison the cache with the previous video's channel — worse than not
// caching at all.
function metaFromResponse(r) {
  let title = "", channelId = "";
  try {
    const vd = r && r.videoDetails;
    if (vd) {
      title     = String(vd.title || "");
      channelId = String(vd.channelId || "");
    }
  } catch {}
  return { title, channelId };
}

// ── Channel verdict cache ────────────────────────────────────────────────────
// Most immersion is repeat channels, so this becomes the hot path quickly and
// rescues videos whose ASR is disabled (music, some channels).

const CACHE_KEY = "ytChannelVerdicts";
const DEBUG_KEY = "ytDebug";       // set true in storage to re-enable probe logs
const TIMER_KEY = "timerRunning";  // the manual stopwatch — see the yield below
let channelCache = {};
let DEBUG = false;

// ── Yielding to the manual stopwatch ─────────────────────────────────────────
// The two features measure the same wall clock, and neither used to know the
// other existed. Starting a stopwatch session on a YouTube tab logged its own
// row while this tracker kept accruing, so the same minutes landed in `sessions`
// twice — there is no cross-source overlap detection, so the day total, Stats,
// the heatmap and goals were all inflated by however long they overlapped.
//
// The passive tracker yields to the explicit one, on ANY tab, not just the tab
// the stopwatch is attached to: starting a session is a deliberate act and this
// is not, and a stopwatch running on one tab while YouTube plays on another
// double-counts exactly the same way.
//
// Gated on `timerRunning` alone. `timerWaiting` is armed-but-counting-nothing
// (the background flips it to running once audio starts, which we see), and a
// paused or crash-recovered session can sit for hours without being an active
// measurement — neither should suppress real listening.
let manualTimer = false;

async function loadSettings() {
  try {
    const got = await browser.storage.local.get([CACHE_KEY, DEBUG_KEY, TIMER_KEY]);
    channelCache = got[CACHE_KEY] || {};
    DEBUG        = !!got[DEBUG_KEY];
    manualTimer  = !!got[TIMER_KEY];
  } catch {
    channelCache = {};
  }
}

// The stopwatch starts and stops from the popup, so the state can flip under a
// page that's already loaded. Wrapped because a top-level throw in a content
// script kills the whole tracker silently.
function watchManualTimer() {
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes || !(TIMER_KEY in changes)) return;
      manualTimer = !!changes[TIMER_KEY].newValue;
      if (state.videoId) render();
    });
  } catch {}
}

async function rememberChannel(channelId, isJa) {
  if (!channelId) return;
  channelCache[channelId] = isJa ? "ja" : "other";
  try {
    await browser.storage.local.set({ [CACHE_KEY]: channelCache });
  } catch {}
}

// ── Classification ───────────────────────────────────────────────────────────
// Ladder: ASR verdict → channel cache → kana in title → ask.
// `verdict` is "ja" | "other" | "unknown"; "unknown" is what surfaces the
// yes/no prompt rather than guessing.

function classifyNow(expectedId) {
  // THE navigation guard. Everything downstream is read off ONE player response
  // that proved it describes `expectedId`. Until such a response exists we
  // refuse to classify — no partial reads, no mixing a fresh id with a stale
  // tracklist, which is exactly how the verdict used to carry across videos.
  const resp = freshPlayerResponse(expectedId);
  if (expectedId && !resp) {
    return {
      verdict: "unknown", reason: "player not ready",
      meta: { title: "", channelId: "" }, settled: false, validated: false,
    };
  }

  const tracks  = tracksFromResponse(resp);
  const asrLang = asrLanguage(tracks);
  const meta    = metaFromResponse(resp);
  const dubLang = selectedAudioLang();

  if (dubLang && dubLang !== "ja" && asrLang === "ja") {
    return { verdict: "other", reason: `dubbed (${dubLang})`, meta, settled: true };
  }

  if (asrLang) {
    const isJa = asrLang === "ja";
    return {
      verdict: isJa ? "ja" : "other",
      reason:  `ASR ${asrLang}`,
      meta,
      settled: true,
      cacheable: true,
    };
  }

  const cached = meta.channelId && channelCache[meta.channelId];
  if (cached) {
    return { verdict: cached, reason: "channel remembered", meta, settled: true };
  }

  // Unsettled, but the response we read was VALIDATED — so "no tracks" is a
  // fact about the video, not a loading state. scheduleClassify uses this to
  // stop polling early instead of burning the full budget (live streams have no
  // ASR track and would otherwise sit on "checking…" for 12s every time).
  if (meta.title && KANA.test(meta.title)) {
    return { verdict: "unknown", reason: "kana in title, no ASR", meta, settled: false, validated: true };
  }

  return { verdict: "unknown", reason: "no ASR track", meta, settled: false, validated: true };
}

// ── State ────────────────────────────────────────────────────────────────────

const TICK_MS       = 1000;
const MAX_CREDIT_MS = TICK_MS * 2;   // jump guard — see below
const ANNOUNCE_MS   = 4500;

const state = {
  videoId:    null,
  channelId:  "",
  verdict:    "unknown",
  reason:     "",
  override:   null,     // true = count anyway, false = never count, null = auto
  checking:   false,    // still polling — distinct from "asked and unsure"
  secs:       0,
  lastTick:   0,
  announceUntil: 0,
  gateWhy:    "",
};

function tracking() {
  if (state.override === true)  return true;
  if (state.override === false) return false;
  return state.verdict === "ja";
}

// ── Accrual gate ─────────────────────────────────────────────────────────────
// A content script can't see tab.audible (that's a background-script concept),
// so "playing and not muted" stands in for it. Deliberately NOT gated on
// visibility: a backgrounded tab still playing unmuted audio is real listening.

function accrualGate(v = document.querySelector("video")) {
  if (!v)                                    return { ok: false, why: "no video" };
  if (v.ended)                               return { ok: false, why: "ended" };
  if (v.paused)                              return { ok: false, why: "paused" };
  if (v.readyState <= 2)                     return { ok: false, why: "buffering" };
  if (v.muted || v.volume === 0)             return { ok: false, why: "muted" };
  return { ok: true, why: "" };
}

// ── Liveness: did this second actually contain playback? ─────────────────────
// The gate above asks whether the page LOOKS like it's playing, and that isn't
// the same question. Hitting play flips `paused` to false instantly, but YouTube
// then spends a couple of seconds on its own spin-up — refetching a segment
// after a long pause, an ad check, restarting the decoder — with the spinner up
// and nothing audible. `readyState` doesn't catch it: the buffer is usually
// still populated, so the element reports 3 or 4 throughout. Every one of those
// seconds used to be credited.
//
// currentTime can't lie about it. The playhead only moves when frames are
// actually being played, and it is frozen solid through a spinner — whatever the
// rest of the element claims. So it's read as a LIVENESS BOOLEAN only, never as
// the credit amount; the amount stays wall-clock for the reason below. This also
// covers mid-video rebuffers and ad transitions, which the unpause case is just
// the most visible instance of.
let lastMediaTime = null;
let stalled       = false;   // read by render() so the chip can say why it froze

function mediaAdvanced(v, wallMs) {
  const prev = lastMediaTime;
  // Sampled on EVERY tick, including blocked ones, so the reference is always
  // the previous second's position. Sampling only while accruing would leave a
  // stale reference across a pause, and the first tick after resuming would
  // measure against wherever the playhead was minutes ago.
  lastMediaTime = v ? v.currentTime : null;
  if (prev === null || lastMediaTime === null || v.seeking) return false;

  const adv    = lastMediaTime - prev;
  const expect = (wallMs / 1000) * (v.playbackRate || 1);
  // Upper bound rejects a scrub or an ad swapping the element out: those land as
  // a jump far larger than the elapsed wall time (or a negative one), which is
  // motion but not playback. Lower bound scales down with the interval so an
  // early tick isn't misread as a stall.
  return adv > Math.min(0.05, expect * 0.25) && adv < expect * 3 + 1;
}

// Wall-clock, not currentTime: at 1.5x speed a 60-minute video is 40 minutes of
// your life, and currentTime deltas would log 60.
//
// The jump guard is the important part. Any wall-clock accumulator has to cap
// how much a single tick can credit, or one closed laptop lid — sleep,
// hibernate, throttled background timer — dumps hours into the counter at once.
function tickAccrual() {
  const now  = Date.now();
  const prev = state.lastTick || now;
  state.lastTick = now;

  // The stopwatch is checked FIRST so `why` names the real reason — and so the
  // publish below fires the moment a session starts, handing over whatever this
  // page had accrued before it yielded.
  const video = document.querySelector("video");
  const gate  = manualTimer
    ? { ok: false, why: "manual timer" }
    : tracking()
      ? accrualGate(video)
      : { ok: false, why: state.verdict === "unknown" ? "unsure" : "not Japanese" };
  state.gateWhy = gate.why;

  // Sampled before any early return — see mediaAdvanced.
  const advanced = mediaAdvanced(video, now - prev);

  // Stopping accrual — paused, muted, ended, or the video stopped qualifying —
  // is the moment the day's total is final until playback resumes, so publish it
  // now instead of letting it sit for up to a post interval. This is also the
  // LAST tick that sends the background anything: after it, no accrue message
  // arrives, and the background's own interval may have died with its event
  // page (see background.js), so nothing else is guaranteed to wake it.
  //
  // Sampling the gate once a second rather than listening for `pause` is
  // deliberate: YouTube fires pause on every seek, and a scrub's pause/play pair
  // usually lands inside one tick and is never seen. The background floors the
  // rate for the ones that don't.
  if (wasAccruing && !gate.ok) flushAndPost();
  wasAccruing = gate.ok;

  if (!gate.ok) { stalled = false; return; }

  // A stall suppresses the CREDIT only — it deliberately does not flow into
  // `wasAccruing` above. If it did, a buffer hiccup would publish the day total,
  // and then the real pause a minute later would find `wasAccruing` already
  // false and publish nothing, leaving the total unposted until the background's
  // next interval. Stopping and stalling are different events; only the first
  // means "this day's figure is final for now".
  stalled = !advanced;
  if (stalled) return;

  let delta = now - prev;
  if (delta > MAX_CREDIT_MS) delta = TICK_MS;   // credit one interval, never the gap
  state.secs  += delta / 1000;
  pendingSecs += delta / 1000;
}

// ── Handing accrual to the background ────────────────────────────────────────
// The per-video counter above is display only. The DAY counter lives in the
// background script, because it has to be shared across tabs and survive this
// page going away. We batch a few seconds at a time to keep the message volume
// down; the cost of a crash is bounded by FLUSH_MS.

const FLUSH_MS  = 5000;
const ANCHOR_MS = 30000;
let pendingSecs  = 0;
let lastFlush    = 0;
let wasAccruing  = false;

// ── The number on the chip is the DAY total ──────────────────────────────────
// Not this video's. The day total is the figure that actually exists downstream:
// the background keeps one per logical date and every post rewrites that day's
// single row. The per-video counter was the one number in the pipeline that
// corresponded to nothing stored, and it reset on every navigation — so "did the
// last hour register?" couldn't be answered from the page it was watched on.
// (`state.secs` still runs, for the tooltip.)
//
// ANCHORED, not polled. `dayAnchor` is the background's figure as of the last
// exchange; the seconds this page hasn't handed over yet are added on top.
// Rendering the background's number alone would jump FLUSH_MS at a time, and
// summing locally would OVER-report: the background clamps each credit to the
// wall clock (background.js), so two tabs playing at once can't both bill the
// same second. The anchor is what will be posted; pendingSecs only keeps it
// ticking in between.
//
// It steps back to ~zero at the rollover hour — the logical day changed under
// it. That's honest, and the only moment the number ever goes down.
let dayAnchor = 0;
let anchorAt  = 0;

// ── The third term, and why the number needs one ─────────────────────────────
// Seconds handed to the background but not yet confirmed. They belong to NEITHER
// of the other two for the length of the round trip: `pendingSecs` has been
// zeroed (the page gave them away) and `dayAnchor` has not moved yet (the reply
// hasn't landed). Without this term the chip renders the gap.
//
// And it renders it every single flush, not just on a slow one: flushAccrual()
// is called WITHOUT await from the tick loop, so it runs synchronously as far as
// its first await — zeroing pendingSecs — and hands back a pending promise. The
// very next line of that tick is render(). So the paint always happens inside
// the gap, and the chip drops by the whole batch (up to FLUSH_MS of listening)
// until a later tick picks the anchor up. That read as the timer bouncing around
// wildly, because the extra flush triggers below (every accrual stop: an ad, a
// rebuffer, a mute, a seek) mean flushes are far more frequent than once per 5s.
//
// Only the display was ever wrong — the seconds themselves are handed over and
// posted correctly either way. Kept as a separate counter rather than "just
// don't zero pendingSecs until the reply" because those seconds must not be sent
// twice if a second flush overlaps this one.
let inFlight  = 0;

function dayTotal() {
  return dayAnchor + pendingSecs + inFlight;
}

function takeAnchor(res) {
  if (res && typeof res.dayTotal === "number") {
    dayAnchor = res.dayTotal;
    anchorAt  = Date.now();
  }
}

// A paused page never flushes, so its anchor would sit still while another tab
// racks up time. Re-read it occasionally rather than show a figure that stopped
// moving hours ago.
async function refreshAnchor(force) {
  if (!force && Date.now() - anchorAt < ANCHOR_MS) return;
  try {
    takeAnchor(await browser.runtime.sendMessage({ type: "yt-day-total" }));
  } catch {}
}

// Returns whether the background now holds everything this page had accrued.
async function flushAccrual() {
  lastFlush = Date.now();
  if (pendingSecs <= 0) { await refreshAnchor(false); return true; }

  const secs  = pendingSecs;
  pendingSecs = 0;
  inFlight   += secs;        // still ours to DISPLAY until the anchor moves
  try {
    // The reply carries the day total the background now holds — other tabs'
    // contributions and its wall-clock clamp included — so every flush re-anchors
    // the chip to the figure that will actually be posted.
    //
    // takeAnchor and the -= are one step with no await between them, which is
    // what makes the handover seamless: the instant these seconds stop being
    // counted here they are already inside dayAnchor. Reversing the two would
    // reintroduce the gap in miniature.
    takeAnchor(await browser.runtime.sendMessage({ type: "yt-accrue", secs }));
    inFlight -= secs;
    return true;
  } catch {
    // The page holds the only copy until the background acknowledges it — the
    // same rule the stopwatch learned the hard way. Put it back and retry.
    inFlight    -= secs;
    pendingSecs += secs;
    return false;
  }
}

// Order matters: the batch above is worth up to FLUSH_MS of listening, so
// posting before it lands publishes a total that's seconds short. A failed
// flush means the page still holds those seconds — say nothing rather than
// have the tracker show a figure we know is stale.
async function flushAndPost() {
  if (!(await flushAccrual())) return;
  try {
    await browser.runtime.sendMessage({ type: "yt-post-now" });
  } catch {}
}

// ── The chip ─────────────────────────────────────────────────────────────────
// Shares the visual language of timer-overlay.js (the stopwatch chip) but keeps
// its own position key, so the two features stay independent. It announces on a
// new video, then settles into the live timer.

const POS_KEY = "ytOverlayPos";
let chip = null, dragging = false, didDrag = false, offsetX = 0, offsetY = 0;

function buildChip() {
  if (chip) return chip;
  chip = document.createElement("div");
  chip.id = "__konseki-yt-chip";
  Object.assign(chip.style, {
    position:       "fixed",
    // Sits BELOW the stopwatch overlay's default 12px, not on it. The two chips
    // are styled identically and keep separate position keys (`overlayPos` vs
    // POS_KEY), so at the same default they stacked pixel-on-pixel: the
    // stopwatch, appended later at the same z-index, painted on top and ate the
    // pointer events — which made this chip's click-to-override, including the
    // "click to count" prompt, unreachable underneath it.
    top:            "52px",
    right:          "12px",
    zIndex:         "2147483647",
    background:     "rgba(20, 20, 32, 0.82)",
    color:          "#eee",
    fontFamily:     "monospace",
    fontSize:       "13px",
    padding:        "5px 11px",
    borderRadius:   "20px",
    pointerEvents:  "auto",
    userSelect:     "none",
    backdropFilter: "blur(6px)",
    border:         "1px solid rgba(155, 155, 199, 0.25)",
    letterSpacing:  "0.05em",
    cursor:         "grab",
    transition:     "opacity 0.3s",
  });
  document.documentElement.appendChild(chip);

  browser.storage.local.get(POS_KEY).then(got => {
    const pos = got[POS_KEY];
    if (!pos || typeof pos.left !== "number") return;
    chip.style.right = "auto";
    chip.style.left  = Math.max(0, Math.min(window.innerWidth  - chip.offsetWidth,  pos.left)) + "px";
    chip.style.top   = Math.max(0, Math.min(window.innerHeight - chip.offsetHeight, pos.top))  + "px";
  }).catch(() => {});

  chip.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    dragging = true; didDrag = false;
    chip.setPointerCapture(e.pointerId);
    const r = chip.getBoundingClientRect();
    offsetX = e.clientX - r.left;
    offsetY = e.clientY - r.top;
    chip.style.cursor = "grabbing";
    e.preventDefault();
  });

  chip.addEventListener("pointermove", e => {
    if (!dragging) return;
    didDrag = true;
    chip.style.right = "auto";
    chip.style.left  = Math.max(0, Math.min(window.innerWidth  - chip.offsetWidth,  e.clientX - offsetX)) + "px";
    chip.style.top   = Math.max(0, Math.min(window.innerHeight - chip.offsetHeight, e.clientY - offsetY)) + "px";
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    try { chip.releasePointerCapture(e.pointerId); } catch {}
    chip.style.cursor = "grab";
    if (didDrag) {
      const r = chip.getBoundingClientRect();
      browser.storage.local.set({ [POS_KEY]: { left: r.left, top: r.top } }).catch(() => {});
    } else {
      cycleOverride();
    }
  }
  chip.addEventListener("pointerup",     endDrag);
  chip.addEventListener("pointercancel", endDrag);

  return chip;
}

// Click cycles auto → count anyway → never count → auto, and remembers the
// channel. Ambiguity gets surfaced rather than threshold-tuned.
function cycleOverride() {
  if (state.override === null)       state.override = true;
  else if (state.override === true)  state.override = false;
  else                               state.override = null;

  if (state.override !== null) rememberChannel(state.channelId, state.override);
  console.log(LOG, "override →", state.override);
  render();
}

function formatTime(total) {
  const s = Math.floor(total);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(v => String(v).padStart(2, "0")).join(":");
}


// The per-video reading the chip used to show, plus the verdict — kept where it
// costs no width. The day total is labelled "this device" because that's what it
// is: this machine's row for the logical day, not the app's total for the day.
function tooltip() {
  const lines = [
    `Today, this device: ${formatTime(dayTotal())}`,
    `This video: ${formatTime(state.secs)}`,
  ];
  if (state.reason)  lines.push(state.reason);
  return lines.join("\n");
}

function render() {
  // ── One chip at a time ──────────────────────────────────────────────────────
  // While the manual stopwatch is running it owns the corner: timer-overlay.js
  // has its own chip up, counting, and this tracker has yielded to it (see the
  // yield note above). Standing down entirely beats the old behaviour of showing
  // a SECOND chip reading "⏸ manual timer" — two overlays stacked in the corner,
  // one of them present only to announce that it isn't the one working.
  //
  // Only this chip hides, never the stopwatch's. A stopwatch session is
  // something the user deliberately started; it stays visible in every state,
  // including paused, because it is the only place that session is shown. So
  // when the stopwatch is merely paused or waiting — not counting — this chip
  // comes back and does the counting, which is exactly the intended split.
  //
  // Nothing is lost by hiding: the click-to-override control this chip carries
  // only affects accrual, and accrual is suppressed for as long as it's hidden.
  if (manualTimer) { hideChip(); return; }

  const el = buildChip();
  el.title = tooltip();

  if (Date.now() < state.announceUntil && tracking()) {
    el.textContent    = "● Tracking — 日本語";
    el.style.opacity  = "1";
    el.style.color    = "#9be89b";
    return;
  }
  el.style.color = "#eee";

  // Still polling. Deliberately NOT the ask prompt — showing "click to count"
  // while we're merely waiting reads as a verdict and invites a click that
  // wasn't needed.
  if (state.checking && state.override === null) {
    el.textContent   = "⋯ checking…";
    el.style.opacity = "0.5";
    return;
  }

  if (state.verdict === "unknown" && state.override === null) {
    el.textContent   = "? Japanese — click to count";
    el.style.opacity = "0.7";
    return;
  }

  if (!tracking()) {
    el.textContent   = state.override === false ? "— off (click to re-enable)" : "— not Japanese";
    el.style.opacity = "0.55";
    return;
  }

  // Tracking: just a stopwatch, matching timer-overlay.js. The announcement
  // above is what tells you a new video is being tracked; once that's said,
  // this should be as quiet as the manual timer is.
  const gate = accrualGate();
  if (gate.ok && stalled) {
    // Playing by every other measure, but the playhead isn't moving — YouTube is
    // spinning up. The frozen number IS the evidence that the wait isn't being
    // counted; the glyph says why it's frozen rather than leaving it looking stuck.
    el.textContent   = "⧗ " + formatTime(dayTotal());
    el.style.opacity = "0.65";
  } else if (gate.ok) {
    el.textContent   = "⏱ " + formatTime(dayTotal());
    el.style.opacity = "1";
  } else if (gate.why === "muted") {
    el.textContent   = "🔇 muted";
    el.style.opacity = "0.65";
  } else {
    el.textContent   = "⏸ " + formatTime(dayTotal());
    el.style.opacity = "0.65";
  }
}

function hideChip() {
  if (!chip) return;
  chip.remove();
  chip = null;
}

// ── Navigation ───────────────────────────────────────────────────────────────

function currentVideoId() {
  try {
    const u = new URL(location.href);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    // /live/<id> is the canonical share link for a stream and YouTube serves it
    // AT that path — 200, not a redirect to /watch (only its <link rel=canonical>
    // points there). A null id makes onNavigate hide the chip and every tick bail,
    // so the whole tracker used to no-op on any live stream opened by share link.
    //
    // NOT covered, both deliberately:
    //   /embed/<id>     — the iframe player. This script has no `all_frames`, which
    //                     defaults to false, so it only ever runs in the TOP frame;
    //                     a player embedded on someone else's site is a subframe and
    //                     never loads it. Matching the path would only fire if you
    //                     opened an embed URL directly in the address bar.
    //   /@channel/live  — carries no id in the URL at all. Reaching it means taking
    //                     identity from the player response instead, which inverts
    //                     the navigation guard's premise.
    // Both are pinned as null in the URL-shape checks in tests/verify_yt.js.
    const m = u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

let classifyTimer = null;

// The captions module lazy-loads and the player takes a moment to admit it has
// navigated, so a fresh video needs a grace period before "no ASR track" means
// anything. 30 x 400ms = 12s, generous enough for a cold load on slow wifi.
const CLASSIFY_POLL_MS  = 400;
const CLASSIFY_ATTEMPTS = 30;
// Once a validated response says there are no caption tracks, that's an answer,
// not a pending state. A couple more polls guard against a transient, then stop.
const EMPTY_ATTEMPTS    = 3;

// Compact diagnostic: which sources exist, which video each claims to describe,
// and what we read off them. Logged once per navigation and again if we give up,
// so a wrong verdict can be diagnosed from the console without a repro session.
function probe(expectedId) {
  const p = getPlayer();
  const out = { want: expectedId, player: !!p };
  try {
    out.hasGetPlayerResponse = !!(p && typeof p.getPlayerResponse === "function");
    if (out.hasGetPlayerResponse) out.apiRespId = responseVideoId(p.getPlayerResponse());
  } catch (e) { out.apiRespErr = String(e); }
  try { out.globalRespId = responseVideoId(playerResponse()); } catch {}
  try {
    const r = freshPlayerResponse(expectedId);
    out.matched = !!r;
    const tracks = tracksFromResponse(r);
    out.trackCount = tracks.length;
    out.langs = tracks.map(t => (t.kind === "asr" || t.vssId.startsWith("a.") ? "asr:" : "") + t.languageCode).join(",");
    out.asr = asrLanguage(tracks);
  } catch (e) { out.trackErr = String(e); }
  try { out.audio = selectedAudioLang(); } catch {}
  return out;
}

// The captions module lazy-loads, so a fresh navigation has no tracklist for a
// second or two. Poll until it settles, then give up and fall down the ladder.
function scheduleClassify(attempt = 0) {
  clearTimeout(classifyTimer);
  const forId = state.videoId;
  if (attempt === 0 && DEBUG) console.log(LOG, "probe", probe(forId));
  const res = classifyNow(forId);

  // A navigation that landed while this poll was in flight wins; drop the
  // result on the floor rather than writing it onto the new video.
  if (forId !== state.videoId) return;

  if (res.meta.channelId) state.channelId = res.meta.channelId;
  state.verdict = res.verdict;
  state.reason  = res.reason;

  if (res.settled) {
    state.checking = false;
    if (res.cacheable && res.meta.channelId) {
      rememberChannel(res.meta.channelId, res.verdict === "ja");
    }
    console.log(LOG, "classified", forId, res.verdict, "—", res.reason);
    if (tracking() && !state.announceUntil) state.announceUntil = Date.now() + ANNOUNCE_MS;
    render();
    return;
  }

  const budget = res.validated ? EMPTY_ATTEMPTS : CLASSIFY_ATTEMPTS;
  if (attempt < budget) {
    state.checking = true;
    classifyTimer  = setTimeout(() => scheduleClassify(attempt + 1), CLASSIFY_POLL_MS);
    render();
    return;
  }

  state.checking = false;
  console.log(LOG, "unresolved", forId, "—", res.reason, probe(forId));
  render();
}

// The announcement fires on videoId change ONLY — never on unpause.
function onNavigate() {
  const id = currentVideoId();
  if (id === state.videoId) return;

  // Leaving a video counts as stopping. tickAccrual can't see this one: it
  // returns early once videoId is null, so navigating to the homepage mid-video
  // would strand the last batch until the next pagehide. Clearing the flag first
  // stops the next tick from publishing a second time for the same stop.
  if (wasAccruing) { wasAccruing = false; flushAndPost(); }

  // The new video's playhead has nothing to do with the old one's, so prime the
  // liveness reference fresh rather than measuring the first tick against it.
  lastMediaTime = null;
  stalled       = false;

  clearTimeout(classifyTimer);
  state.videoId       = id;
  state.channelId     = "";
  state.verdict       = "unknown";
  state.reason        = "";
  state.override      = null;
  state.checking      = !!id;
  state.secs          = 0;
  state.lastTick      = 0;
  state.announceUntil = 0;

  if (!id) { state.checking = false; hideChip(); return; }

  console.log(LOG, "video →", id);
  render();              // repaint immediately; never leave the old verdict up
  scheduleClassify();
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  await loadSettings();
  watchManualTimer();
  refreshAnchor(true);     // show today's total straight away, not 00:00:00
  onNavigate();

  document.addEventListener("yt-navigate-finish", onNavigate, true);
  window.addEventListener("popstate", onNavigate);

  // Hand off whatever we're holding before the page can be torn down.
  window.addEventListener("pagehide", () => { flushAccrual(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushAccrual();
  });

  setInterval(() => {
    onNavigate();                 // backstop: catches nav events we didn't see
    if (!state.videoId) return;
    tickAccrual();
    if (Date.now() - lastFlush >= FLUSH_MS) flushAccrual();
    render();
  }, TICK_MS);

  console.log(LOG, "loaded — accruing to the background, which posts");
}

if (!window.__konsekiYtActive) {
  window.__konsekiYtActive = true;
  start();
}
