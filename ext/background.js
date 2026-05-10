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

browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.audible === undefined) return;

  const cfg = await browser.storage.local.get([
    "timerAudioDetect", "timerTabId",
    "timerRunning", "timerPaused", "timerAutoPaused", "timerWaiting", "timerStart", "timerElapsed",
  ]);
  if (!cfg.timerAudioDetect || cfg.timerTabId !== tabId) return;

  if (changeInfo.audible) {
    if (cfg.timerWaiting) {
      await browser.storage.local.set({ timerWaiting: false, timerRunning: true, timerPaused: false, timerStart: Date.now() });
    } else if (cfg.timerPaused && cfg.timerAutoPaused) {
      await browser.storage.local.set({ timerRunning: true, timerPaused: false, timerAutoPaused: false, timerStart: Date.now() });
    }
  } else {
    if (cfg.timerRunning) {
      const elapsed = Math.max(0, (cfg.timerElapsed || 0) + Math.floor((Date.now() - cfg.timerStart) / 1000) - 3);
      await browser.storage.local.set({ timerRunning: false, timerPaused: true, timerAutoPaused: true, timerElapsed: elapsed, timerStart: null });
    }
  }
});

browser.runtime.onMessage.addListener(async (msg) => {
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

  const cfg   = await browser.storage.local.get(["port", "token"]);
  const port  = cfg.port  || 18463;
  const token = (cfg.token || "").trim();

  if (!token) return; // not configured yet

  try {
    await fetch(`http://127.0.0.1:${port}/import`, {
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
