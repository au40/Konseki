// background.js — receives sync messages from content.js, POSTs to tracker.
// Holds settings (port + token) in browser.storage.local so they never
// touch the page context.

async function updateBadge() {
  const { token } = await browser.storage.local.get("token");
  if ((token || "").trim()) {
    browser.action.setBadgeText({ text: "" });
    return;
  }
  browser.action.setBadgeBackgroundColor({ color: "#e53935" });
  if (browser.action.setBadgeTextColor) {
    browser.action.setBadgeTextColor({ color: "#ffffff" });
  }
  browser.action.setBadgeText({ text: "‼" });
}

updateBadge();
browser.runtime.onStartup.addListener(updateBadge);
browser.runtime.onInstalled.addListener(updateBadge);

// Recover a session that was running/paused/waiting when the browser was last closed.
// Freezes the elapsed time and parks it in a "paused + recovered" state so the popup
// can prompt the user to log or discard it.
async function recoverStaleTimer() {
  const cfg = await browser.storage.local.get([
    "timerRunning", "timerPaused", "timerWaiting",
    "timerStart", "timerElapsed", "timerActivity", "timerLastTick",
  ]);

  const wasActive = cfg.timerRunning || cfg.timerPaused || cfg.timerWaiting;
  if (!wasActive) return;

  // Nothing meaningful to recover — clear and bail.
  if (!cfg.timerActivity) {
    await browser.storage.local.remove([
      "timerRunning", "timerPaused", "timerWaiting", "timerStart", "timerElapsed",
      "timerActivity", "timerAutoPaused", "timerAudioDetect", "timerTabId", "timerMode",
      "timerRecovered", "timerLastTick",
    ]);
    return;
  }

  let elapsed = cfg.timerElapsed || 0;
  if (cfg.timerRunning && cfg.timerStart) {
    // Use the last heartbeat as the "alive until" timestamp. Falls back to
    // timerStart (zero gain) if no heartbeat ever fired (session < HEARTBEAT_MS).
    const lastAlive = cfg.timerLastTick || cfg.timerStart;
    elapsed += Math.max(0, Math.floor((lastAlive - cfg.timerStart) / 1000));
  }

  await browser.storage.local.set({
    timerRunning:    false,
    timerPaused:     true,
    timerWaiting:    false,
    timerAutoPaused: false,
    timerStart:      null,
    timerElapsed:    elapsed,
    timerRecovered:  true,
  });
  await browser.storage.local.remove("timerLastTick");
}

browser.runtime.onStartup.addListener(recoverStaleTimer);

// Heartbeat: while the timer is running, persist a "last alive" timestamp every
// ~10s so recovery after a crash doesn't have to guess how long the session ran.
const HEARTBEAT_MS = 10000;
let heartbeatInterval = null;

async function writeHeartbeat() {
  const cfg = await browser.storage.local.get("timerRunning");
  if (!cfg.timerRunning) {
    stopHeartbeat();
    return;
  }
  await browser.storage.local.set({ timerLastTick: Date.now() });
}

function startHeartbeat() {
  if (heartbeatInterval) return;
  writeHeartbeat();
  heartbeatInterval = setInterval(writeHeartbeat, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (!heartbeatInterval) return;
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
}

// Re-attach the heartbeat after a background-script reload if the timer is running.
browser.storage.local.get("timerRunning").then(cfg => {
  if (cfg.timerRunning) startHeartbeat();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("timerRunning" in changes)) return;
  if (changes.timerRunning.newValue) startHeartbeat();
  else stopHeartbeat();
});

async function audioAutoPause(cfg, deductSeconds = 0) {
  if (!cfg.timerRunning) return;
  const raw = (cfg.timerElapsed || 0) + Math.floor((Date.now() - cfg.timerStart) / 1000) - deductSeconds;
  const elapsed = Math.max(0, raw);
  await browser.storage.local.set({
    timerRunning: false, timerPaused: true, timerAutoPaused: true,
    timerElapsed: elapsed, timerStart: null,
  });
}

browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.audible === undefined && changeInfo.url === undefined) return;

  const cfg = await browser.storage.local.get([
    "timerAudioDetect", "timerTabId",
    "timerRunning", "timerPaused", "timerAutoPaused", "timerWaiting", "timerStart", "timerElapsed",
  ]);
  if (!cfg.timerAudioDetect || cfg.timerTabId !== tabId) return;

  // Navigation away from the playing page — pause immediately. Catches the case
  // where the user pauses then navigates before Firefox's audible debounce fires.
  if (changeInfo.url !== undefined) {
    await audioAutoPause(cfg);
    return;
  }

  if (changeInfo.audible) {
    if (cfg.timerWaiting) {
      await browser.storage.local.set({ timerWaiting: false, timerRunning: true, timerPaused: false, timerStart: Date.now() });
    } else if (cfg.timerPaused && cfg.timerAutoPaused) {
      await browser.storage.local.set({ timerRunning: true, timerPaused: false, timerAutoPaused: false, timerStart: Date.now() });
    }
  } else {
    await audioAutoPause(cfg, 3);
  }
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  const cfg = await browser.storage.local.get([
    "timerAudioDetect", "timerTabId",
    "timerRunning", "timerStart", "timerElapsed",
  ]);
  if (!cfg.timerAudioDetect || cfg.timerTabId !== tabId) return;
  await audioAutoPause(cfg);
});

// ── YouTube passive tracker — the day counter ────────────────────────────────
// Accrual lives here, not in yt-track.js, because it has to be shared across
// tabs and outlive any one page. Posting lives here too, further down.
//
// Storage shape, keyed by LOGICAL date so a rollover hour splits the day the
// way the app does:
//
//   ytDays: { "2026-08-10": 4212.5, "2026-08-09": 1800 }
//
// A map rather than a single bucket so a day that closes while the tracker is
// unreachable isn't lost — every date is posted on its own and pruned only on a
// confirmed store (ytPostPending / ytPrunePosted below).

const YT_DAYS_KEY     = "ytDays";
const YT_ROLLOVER_KEY = "rolloverHour";   // fetched from the desktop; 0 until the first fetch lands
const YT_KEEP_DAYS    = 14;

// ── The ledger — what made up the day's number ───────────────────────────────
// `ytDays` is one anonymous total per day, which is fine until something counts
// that shouldn't have: nothing remembers what went into it, so there is nothing
// to take back out. The ledger is that memory.
//
//   ytLedger: { "2026-08-22": { "<videoId>": { secs, title, channel, channelId, why, last } } }
//
// Three rules keep it worth trusting:
//
//   * It records the CLAMPED credit (below), never the seconds the page
//     reported. Otherwise two tabs playing at once would put more into the
//     ledger than into the day, and the list wouldn't add up to the number it
//     claims to explain.
//   * Credits with no videoId land under "unattributed" rather than being
//     dropped, so the list stays reconcilable across an extension upgrade.
//   * It is SUBORDINATE. `ytDays` is what gets posted; this only explains it.
//     Never rederive the day total as a sum of these entries — the ledger is
//     pruned on a far shorter horizon and would silently shrink older days.
//
// Browser-local and never posted anywhere. The tracker still stores one pooled
// row per logical day; per-video data deliberately does not leave here.
const YT_LEDGER_KEY  = "ytLedger";
const YT_LEDGER_DAYS = 2;                 // today and yesterday; see below
const YT_UNATTRIBUTED = "unattributed";

let ytLastCredit = 0;

function ytLogicalDate(ts, rolloverHour) {
  const d = new Date(ts);
  if (rolloverHour > 0 && d.getHours() < rolloverHour) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Credits are a read-modify-write on storage, so they're serialised. Without
// this, two tabs reporting at the same moment can both read the same total and
// one write silently wins.
let ytQueue = Promise.resolve();
function ytSerial(fn) {
  const next = ytQueue.then(fn, fn);
  ytQueue = next.catch(() => {});
  return next;
}

async function ytRead() {
  const cfg = await browser.storage.local.get([YT_DAYS_KEY, YT_ROLLOVER_KEY, YT_LEDGER_KEY]);
  return {
    days:     cfg[YT_DAYS_KEY] || {},
    ledger:   cfg[YT_LEDGER_KEY] || {},
    rollover: parseInt(cfg[YT_ROLLOVER_KEY], 10) || 0,
  };
}

// `meta` describes the video the seconds came from: { videoId, title, channel,
// channelId, why }. Absent (an older content script mid-upgrade) the credit
// still lands on the day — it just lands under "unattributed" in the ledger.
async function ytCredit(secs, meta) {
  const { days, ledger, rollover } = await ytRead();
  const now = Date.now();

  // Two tabs playing at once must not both credit the same wall-clock second.
  // The counter can never grow faster than real time, whatever reports arrive —
  // which also backstops the content script's own jump guard.
  const room   = ytLastCredit ? Math.max(0, (now - ytLastCredit) / 1000) : secs;
  const credit = Math.max(0, Math.min(secs, room));
  ytLastCredit = now;

  const date = ytLogicalDate(now, rollover);
  if (credit > 0) {
    days[date] = (days[date] || 0) + credit;

    // Same clamped `credit` as the day got, written in the same storage set, so
    // the two can't drift apart even if one write were to fail.
    const day = ledger[date] || (ledger[date] = {});
    const id  = (meta && meta.videoId) || YT_UNATTRIBUTED;
    const e   = day[id] || (day[id] = { secs: 0 });
    e.secs += credit;
    e.last  = now;
    if (meta) {
      // Refreshed rather than written once: the title arrives a beat after the
      // first credit on a slow classify, and `why` can legitimately change
      // mid-video (an ASR verdict settling, or you clicking to count it).
      if (meta.title)     e.title     = meta.title;
      if (meta.channel)   e.channel   = meta.channel;
      if (meta.channelId) e.channelId = meta.channelId;
      if (meta.why)       e.why       = meta.why;
    }

    await browser.storage.local.set({ [YT_DAYS_KEY]: days, [YT_LEDGER_KEY]: ledger });
  }
  return days[date] || 0;
}

// ── Removing a video's time ──────────────────────────────────────────────────
// The correction the ledger exists to make possible: take one video's seconds
// back out of the day and re-post the corrected total. Serialised against
// credits — it is a read-modify-write of the same two maps — and it posts
// immediately rather than waiting for the interval, because a correction the
// user can't see land is a correction they'll make twice.
//
// Floored at zero: the day can't go negative, and a day that reaches zero is
// posted as zero, which deletes its row server-side.
function ytRemoveVideo(date, videoId) {
  return ytSerial(async () => {
    const cfg    = await browser.storage.local.get([YT_DAYS_KEY, YT_LEDGER_KEY]);
    const days   = cfg[YT_DAYS_KEY]   || {};
    const ledger = cfg[YT_LEDGER_KEY] || {};
    const day    = ledger[date];
    const entry  = day && day[videoId];
    if (!entry) return { ok: false, error: "no such entry" };

    days[date] = Math.max(0, (days[date] || 0) - (entry.secs || 0));
    delete day[videoId];
    if (!Object.keys(day).length) delete ledger[date];

    await browser.storage.local.set({ [YT_DAYS_KEY]: days, [YT_LEDGER_KEY]: ledger });
    return { ok: true, dayTotal: days[date] };
  });
}

// ── Posting ──────────────────────────────────────────────────────────────────
// Each cycle re-posts the CUMULATIVE total for any day whose figure has moved
// since it was last confirmed. Every post carries the full total, so a dropped
// request is corrected by the next one rather than lost — and a drain replaying
// an inbox row rewrites the same row instead of adding a second.

const YT_POSTED_KEY = "ytPosted";     // {date: secs} the tracker has confirmed
const YT_DEVICE_KEY = "deviceName";   // names THIS machine's rows; set in the popup
const YT_MIN_SECS   = 60;             // don't mint a row for a stray click
const YT_POST_MS    = 120000;

// Each machine owns its own row per logical day, and the day's total is their
// sum. Without a per-device key, a second machine's post would land on the same
// row and OVERWRITE the first's total rather than add to it — silently, and
// looking exactly like a quiet day.
//
// Blank device name means no key, which is the pre-multi-device behaviour and
// stays correct for a single machine. The tracker adopts those keyless rows the
// first time a named post arrives, so naming a machine later doesn't double-count.
function ytClientId(device, date) {
  return device ? `youtube:${device}:${date}` : null;
}

let ytLastPost = 0;

// The HOST matters here, not just the port. This used to be hardcoded to
// 127.0.0.1, which was right when the desktop was the only place a post could
// go — but it meant a machine that isn't running Konseki could never deliver
// its YouTube time at all. Pointed at the always-on inbox, it can.
async function ytAuth() {
  const cfg = await browser.storage.local.get(["host", "port", "token", YT_DEVICE_KEY]);
  return {
    host:   (cfg.host || "").trim() || "127.0.0.1",
    port:   cfg.port || 18463,
    token:  (cfg.token || "").trim(),
    device: (cfg[YT_DEVICE_KEY] || "").trim(),
  };
}

// rollover_hour is the one setting this device can't derive on its own, and
// without it the extension buckets accrual into the wrong logical day.
async function ytFetchConfig() {
  const { host, port, token } = await ytAuth();
  if (!token) return;
  try {
    const r = await fetch(`http://${host}:${port}/config`, {
      headers: { "X-Tracker-Token": token },
    });
    if (!r.ok) return;
    const body = await r.json();
    const rh = parseInt(body.rollover_hour, 10);
    if (Number.isFinite(rh)) {
      await browser.storage.local.set({ [YT_ROLLOVER_KEY]: String(rh) });
    }
  } catch {
    // Tracker not running — keep the last known value.
  }
}

async function ytPostPending() {
  const cfg    = await browser.storage.local.get([YT_DAYS_KEY, YT_POSTED_KEY]);
  const days   = cfg[YT_DAYS_KEY]   || {};
  const posted = cfg[YT_POSTED_KEY] || {};
  const { host, port, token, device } = await ytAuth();
  if (!token) return;

  let changed = false;
  for (const date of Object.keys(days).sort()) {
    const secs = days[date];
    // The floor stops a stray click MINTING a row. It must not stop us
    // CORRECTING one: a date already in `posted` has a row out there, and if a
    // correction drops it below the floor the row has to follow it down (zero
    // deletes it server-side). Without the second clause the extension would
    // believe it had corrected a day whose stored total never moved.
    if (secs < YT_MIN_SECS && !(date in posted)) continue;
    if (posted[date] === secs)   continue;
    try {
      const r = await fetch(`http://${host}:${port}/import`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "X-Tracker-Token": token },
        body: JSON.stringify({
          source:       "youtube",
          session_date: date,
          time_seconds: secs,
          client_id:    ytClientId(device, date),
        }),
      });
      if (!r.ok) continue;
      const body = await r.json().catch(() => ({}));
      // A 200 carrying {"error": ...} is a FAILURE. The status code alone is
      // not proof the row was stored — this is what bit the stopwatch.
      if (body && body.error) continue;
      posted[date] = secs;
      changed = true;
    } catch {
      // Tracker unreachable. The day stays put and retries next cycle; we hold
      // the only copy until it lands.
    }
  }
  // Only `posted` is written here — never `days`, which a concurrent credit
  // may have advanced while these requests were in flight.
  if (changed) await browser.storage.local.set({ [YT_POSTED_KEY]: posted });
}

// Pruning drops a day only once the tracker has CONFIRMED it. An unconfirmed
// day is the only copy of that time. Serialised against credits because it
// rewrites the whole map.
function ytPrunePosted() {
  return ytSerial(async () => {
    const cfg    = await browser.storage.local.get([YT_DAYS_KEY, YT_POSTED_KEY, YT_ROLLOVER_KEY, YT_LEDGER_KEY]);
    const days   = cfg[YT_DAYS_KEY]   || {};
    const posted = cfg[YT_POSTED_KEY] || {};
    const ledger = cfg[YT_LEDGER_KEY] || {};
    const rollover = parseInt(cfg[YT_ROLLOVER_KEY], 10) || 0;
    const cutoff = ytLogicalDate(Date.now() - YT_KEEP_DAYS * 86400000, rollover);

    let changed = false;
    for (const d of Object.keys(days)) {
      if (d < cutoff && posted[d] === days[d]) {
        delete days[d];
        delete posted[d];
        changed = true;
      }
    }

    // The ledger goes on a much shorter leash than the counter: it exists so
    // you can find last night's mistake this morning, not to archive what you
    // watched. Its cutoff is INDEPENDENT of the confirmation check above —
    // dropping an explanation is harmless, dropping an unposted day is not.
    const ledgerCutoff = ytLogicalDate(Date.now() - YT_LEDGER_DAYS * 86400000, rollover);
    let ledgerChanged = false;
    for (const d of Object.keys(ledger)) {
      if (d <= ledgerCutoff) { delete ledger[d]; ledgerChanged = true; }
    }

    if (changed || ledgerChanged) {
      const patch = {};
      if (changed)       { patch[YT_DAYS_KEY] = days; patch[YT_POSTED_KEY] = posted; }
      if (ledgerChanged) { patch[YT_LEDGER_KEY] = ledger; }
      await browser.storage.local.set(patch);
    }
  });
}

// Posting has three drivers now — the interval, an accrue message, and a pause —
// so runs can overlap. They're serialised not for the server's sake (every post
// is an idempotent rewrite of its own row) but for `posted`: two concurrent runs
// read the same map and whichever writes last drops the other's confirmations,
// costing a needless re-post of every day next cycle.
//
// A request arriving mid-run sets the flag rather than joining the run, because
// the run in flight read storage BEFORE that request's seconds were credited —
// folding it in would mean the caller's whole point (publish the total as of
// now) waited for the next interval. Passes are no-ops once every day matches
// `posted`, so the loop settles immediately.
let ytPosting   = null;
let ytPostAgain = false;

function ytPostOnce() {
  if (ytPosting) {
    ytPostAgain = true;
    return ytPosting;
  }
  ytPosting = (async () => {
    try {
      do {
        ytPostAgain = false;
        await ytPostPending();
      } while (ytPostAgain);
    } catch {}
    ytPosting = null;
  })();
  return ytPosting;
}

// Pause-driven post. Deliberately NOT the full cycle: the config fetch and the
// prune are periodic housekeeping, not per-event work.
//
// The floor is the seek guard. The content script's once-a-second gate sampling
// already swallows most scrubs, but a slow seek or an ad transition shows up as
// a genuine pause, and a scrub-heavy video would otherwise post on every one.
const YT_FORCE_MS = 10000;
let ytLastForce = 0;

function ytPostForced() {
  const now = Date.now();
  if (now - ytLastForce < YT_FORCE_MS) return Promise.resolve();
  ytLastForce = now;
  return ytPostOnce();
}

async function ytPostCycle() {
  ytLastPost = Date.now();
  await ytFetchConfig();
  await ytPostOnce();
  await ytPrunePosted();
}

ytPostCycle();
setInterval(ytPostCycle, YT_POST_MS);

// Granting site access doesn't retroactively load the content script into tabs
// that are already open — without this, allowing YouTube from the popup appears
// to do nothing until every tab is reloaded. Injecting is safe on a tab that
// already has it: yt-track.js guards on `window.__konsekiYtActive`.
browser.permissions.onAdded.addListener(async (perms) => {
  const origins = (perms && perms.origins) || [];
  if (!origins.some(o => o.includes("youtube.com"))) return;
  try {
    const tabs = await browser.tabs.query({ url: "https://www.youtube.com/*" });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["yt-track.js"] });
      } catch {}
    }
  } catch {}
});

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === "yt-accrue") {
    const dayTotal = await ytSerial(() => ytCredit(Number(msg.secs) || 0, msg.video));
    // Opportunistic: a background event page can be unloaded, taking its
    // setInterval with it. Watching keeps messages arriving, so drive the post
    // cycle from here too rather than trusting the timer to survive.
    if (Date.now() - ytLastPost >= YT_POST_MS) ytPostCycle();
    return { dayTotal };
  }

  // Sent when the page stops accruing, right after its final yt-accrue — so the
  // seconds being published are already in storage by the time this arrives.
  if (msg.type === "yt-post-now") {
    await ytPostForced();
    return;
  }

  // The popup's breakdown of the day. Shaped here rather than in the popup so
  // the ledger's storage layout stays private to this file.
  if (msg.type === "yt-ledger") {
    const { days, ledger, rollover } = await ytRead();
    const today = ytLogicalDate(Date.now(), rollover);

    const dates = Object.keys(ledger);
    // Today is always listed, even with nothing in it — an empty list reads as
    // "nothing has counted yet", where a missing section reads as broken.
    if (dates.indexOf(today) === -1) dates.push(today);

    const out = dates.sort().reverse().map((date) => ({
      date,
      total:   days[date] || 0,
      entries: Object.keys(ledger[date] || {})
        .map((videoId) => Object.assign({ videoId }, ledger[date][videoId]))
        .sort((a, b) => (b.secs || 0) - (a.secs || 0)),
    }));
    return { today, days: out, unattributed: YT_UNATTRIBUTED };
  }

  if (msg.type === "yt-remove-video") {
    const res = await ytRemoveVideo(msg.date, msg.videoId);
    // Posted straight away, not via ytPostForced: its 10s floor exists to
    // swallow scrub-driven pauses, and swallowing a correction instead would
    // leave the user staring at an unchanged number in the app.
    if (res.ok) await ytPostOnce();
    return res;
  }

  if (msg.type === "yt-day-total") {
    const { days, rollover } = await ytRead();
    // activeAt is when a credit last landed. The popup turns that into "tracking
    // now" — it has no other way to know, since the accrual lives in whichever
    // tab happens to be playing.
    return {
      dayTotal: days[ytLogicalDate(Date.now(), rollover)] || 0,
      activeAt: ytLastCredit,
    };
  }

  if (msg.type === "media-pause") {
    const cfg = await browser.storage.local.get(["timerRunning", "timerStart", "timerElapsed", "timerMode"]);
    if (cfg.timerMode !== "video") return;
    if (!cfg.timerRunning) return;
    const elapsed = (cfg.timerElapsed || 0) + Math.floor((Date.now() - cfg.timerStart) / 1000);
    await browser.storage.local.set({
      timerRunning:   false,
      timerPaused:    true,
      timerAutoPaused: true,
      timerElapsed:   elapsed,
      timerStart:     null,
    });
    return;
  }

  if (msg.type === "media-play") {
    const cfg = await browser.storage.local.get(["timerWaiting", "timerPaused", "timerAutoPaused", "timerMode"]);
    if (cfg.timerMode !== "video") return;
    if (cfg.timerWaiting) {
      // First play after Start — begin ticking for the first time
      await browser.storage.local.set({
        timerWaiting: false,
        timerRunning: true,
        timerPaused:  false,
        timerStart:   Date.now(),
      });
      return;
    }
    if (!cfg.timerPaused || !cfg.timerAutoPaused) return;
    await browser.storage.local.set({
      timerRunning:    true,
      timerPaused:     false,
      timerAutoPaused: false,
      timerStart:      Date.now(),
    });
    return;
  }

  if (msg.type !== "sync") return;

  const cfg   = await browser.storage.local.get(["host", "port", "token"]);
  const host  = (cfg.host || "").trim() || "127.0.0.1";
  const port  = cfg.port  || 18463;
  const token = (cfg.token || "").trim();

  if (!token) return; // not configured yet

  try {
    await fetch(`http://${host}:${port}/import`, {
      method: "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-Tracker-Token": token,
      },
      body: JSON.stringify({ source: msg.source, entries: msg.entries }),
    });
  } catch {
    // Tracker not running — drop silently per design
  }
});
