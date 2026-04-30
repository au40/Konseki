// background.js — receives sync messages from content.js, POSTs to tracker.
// Holds settings (port + token) in browser.storage.local so they never
// touch the page context.

browser.runtime.onMessage.addListener(async (msg) => {
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
