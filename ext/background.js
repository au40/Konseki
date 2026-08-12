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
// M2: ACCRUAL ONLY. Nothing here posts to the tracker; that's M3.
//
// This lives in the background rather than the content script because it has to
// be shared across tabs and outlive any one page. Storage shape, keyed by
// LOGICAL date so a rollover hour splits the day the way the app does:
//
//   ytDays: { "2026-08-10": 4212.5, "2026-08-09": 1800 }
//
// A map rather than a single bucket so a day that closes while the tracker is
// unreachable isn't lost — M3 posts each date and prunes only on a confirmed
// store.

const YT_DAYS_KEY     = "ytDays";
const YT_ROLLOVER_KEY = "rolloverHour";   // fetched from the desktop in M3; 0 until then
const YT_KEEP_DAYS    = 14;

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
  const cfg = await browser.storage.local.get([YT_DAYS_KEY, YT_ROLLOVER_KEY]);
  return {
    days:     cfg[YT_DAYS_KEY] || {},
    rollover: parseInt(cfg[YT_ROLLOVER_KEY], 10) || 0,
  };
}

async function ytCredit(secs) {
  const { days, rollover } = await ytRead();
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
    await browser.storage.local.set({ [YT_DAYS_KEY]: days });
  }
  return days[date] || 0;
}

// ── M3: posting ──────────────────────────────────────────────────────────────
// Each cycle re-posts the CUMULATIVE total for any day whose figure has moved
// since it was last confirmed. Every post carries the full total, so a dropped
// request is corrected by the next one rather than lost — and a drain replaying
// an inbox row rewrites the same row instead of adding a second.

const YT_POSTED_KEY = "ytPosted";     // {date: secs} the tracker has confirmed
const YT_MIN_SECS   = 60;             // don't mint a row for a stray click
const YT_POST_MS    = 120000;

let ytLastPost = 0;

async function ytAuth() {
  const cfg = await browser.storage.local.get(["port", "token"]);
  return { port: cfg.port || 18463, token: (cfg.token || "").trim() };
}

// rollover_hour is the one setting this device can't derive on its own, and
// without it the extension buckets accrual into the wrong logical day.
async function ytFetchConfig() {
  const { port, token } = await ytAuth();
  if (!token) return;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/config`, {
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
  const { port, token } = await ytAuth();
  if (!token) return;

  let changed = false;
  for (const date of Object.keys(days).sort()) {
    const secs = days[date];
    if (secs < YT_MIN_SECS)      continue;
    if (posted[date] === secs)   continue;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/import`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "X-Tracker-Token": token },
        body: JSON.stringify({ source: "youtube", session_date: date, time_seconds: secs }),
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
    const cfg    = await browser.storage.local.get([YT_DAYS_KEY, YT_POSTED_KEY, YT_ROLLOVER_KEY]);
    const days   = cfg[YT_DAYS_KEY]   || {};
    const posted = cfg[YT_POSTED_KEY] || {};
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
    if (changed) {
      await browser.storage.local.set({ [YT_DAYS_KEY]: days, [YT_POSTED_KEY]: posted });
    }
  });
}

async function ytPostCycle() {
  ytLastPost = Date.now();
  await ytFetchConfig();
  await ytPostPending();
  await ytPrunePosted();
}

ytPostCycle();
setInterval(ytPostCycle, YT_POST_MS);

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === "yt-accrue") {
    const dayTotal = await ytSerial(() => ytCredit(Number(msg.secs) || 0));
    // Opportunistic: a background event page can be unloaded, taking its
    // setInterval with it. Watching keeps messages arriving, so drive the post
    // cycle from here too rather than trusting the timer to survive.
    if (Date.now() - ytLastPost >= YT_POST_MS) ytPostCycle();
    return { dayTotal };
  }

  if (msg.type === "yt-day-total") {
    const { days, rollover } = await ytRead();
    return { dayTotal: days[ytLogicalDate(Date.now(), rollover)] || 0 };
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
