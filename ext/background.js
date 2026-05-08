// background.js — receives sync messages from content.js, POSTs to tracker.
// Holds settings (port + token) in browser.storage.local so they never
// touch the page context.

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
    const cfg = await browser.storage.local.get(["timerRunning", "timerStart", "timerElapsed"]);
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
    const cfg = await browser.storage.local.get(["timerWaiting", "timerPaused", "timerAutoPaused"]);
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
