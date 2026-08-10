// yt-track.js — passive YouTube listening tracker.
//
// ── M1: DETECTION + INDICATOR ONLY. THIS FILE POSTS NOTHING. ─────────────────
// It classifies each video by YouTube's own ASR caption language, shows that
// verdict on-page, and ticks a local counter you can watch. No fetch, no
// storage of accrued time, no server contact. Accrual persistence lands in M2
// and posting in M3 — see plans/YOUTUBE-PLAN.md.
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
let channelCache = {};
let DEBUG = false;

async function loadSettings() {
  try {
    const got = await browser.storage.local.get([CACHE_KEY, DEBUG_KEY]);
    channelCache = got[CACHE_KEY] || {};
    DEBUG        = !!got[DEBUG_KEY];
  } catch {
    channelCache = {};
  }
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

function accrualGate() {
  const v = document.querySelector("video");
  if (!v)                                    return { ok: false, why: "no video" };
  if (v.ended)                               return { ok: false, why: "ended" };
  if (v.paused)                              return { ok: false, why: "paused" };
  if (v.readyState <= 2)                     return { ok: false, why: "buffering" };
  if (v.muted || v.volume === 0)             return { ok: false, why: "muted" };
  return { ok: true, why: "" };
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

  if (!tracking()) { state.gateWhy = state.verdict === "unknown" ? "unsure" : "not Japanese"; return; }

  const gate = accrualGate();
  state.gateWhy = gate.why;
  if (!gate.ok) return;

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

const FLUSH_MS = 5000;
let pendingSecs = 0;
let lastFlush   = 0;
let dayTotal    = 0;

async function flushAccrual() {
  lastFlush = Date.now();
  if (pendingSecs <= 0) return;

  const secs  = pendingSecs;
  pendingSecs = 0;
  try {
    const res = await browser.runtime.sendMessage({ type: "yt-accrue", secs });
    if (res && typeof res.dayTotal === "number") dayTotal = res.dayTotal;
  } catch {
    // The page holds the only copy until the background acknowledges it — the
    // same rule the stopwatch learned the hard way. Put it back and retry.
    pendingSecs += secs;
  }
}

async function refreshDayTotal() {
  try {
    const res = await browser.runtime.sendMessage({ type: "yt-day-total" });
    if (res && typeof res.dayTotal === "number") dayTotal = res.dayTotal;
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
    top:            "12px",
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

// Day totals read better coarse — "1h 47m" beside a ticking per-video clock.
function formatShort(total) {
  const s = Math.floor(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function render() {
  const el = buildChip();

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

  const today = dayTotal >= 60 ? "  ·  today " + formatShort(dayTotal) : "";
  const gate  = accrualGate();
  if (gate.ok) {
    el.textContent   = "▶ 日本語 · " + formatTime(state.secs) + today;
    el.style.opacity = "1";
  } else if (gate.why === "muted") {
    el.textContent   = "🔇 muted — not counting" + today;
    el.style.opacity = "0.65";
  } else {
    el.textContent   = "⏸ " + formatTime(state.secs) + today;
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
    const m = u.pathname.match(/^\/shorts\/([\w-]+)/);
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
  await refreshDayTotal();
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

  console.log(LOG, "M2 loaded — accrual is local only, nothing is posted");
}

if (!window.__konsekiYtActive) {
  window.__konsekiYtActive = true;
  start();
}
