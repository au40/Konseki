// content.js — runs only on https://reader.ttsu.app/*
// Reads today's stats from ッツ Reader's IndexedDB and POSTs directly to the
// local tracker. Fetches directly rather than via background to avoid MV3
// background lifecycle issues.

const IDB_NAME  = "books";
const IDB_STORE = "statistic";

function localDateISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function recentDateSet(days = 7) {
  const s = new Set();
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    s.add(localDateISO(d));
  }
  return s;
}

function readTodayEntries() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.close();
        return resolve([]);
      }

      const tx    = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const all   = store.getAll();

      all.onerror = () => { db.close(); reject(all.error); };
      all.onsuccess = () => {
        db.close();
        const recent  = recentDateSet(7);
        const entries = (all.result || [])
          .map(v => {
            if (typeof v === "string") {
              try { return JSON.parse(v); } catch { return null; }
            }
            return v;
          })
          .filter(e => e && recent.has(e.dateKey));
        resolve(entries);
      };
    };
  });
}

async function postToTracker(entries) {
  const cfg   = await browser.storage.local.get(["host", "port", "token"]);
  const host  = (cfg.host || "").trim() || "127.0.0.1";
  const port  = cfg.port  || 18463;
  const token = (cfg.token || "").trim();
  console.log("[immersion-sync] postToTracker — token set:", !!token, "host:", host, "port:", port, "entries:", entries.length);
  if (!token) return;

  const r = await fetch(`http://${host}:${port}/import`, {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "X-Tracker-Token": token,
    },
    body: JSON.stringify({ source: "ttsureader", entries }),
  });
  console.log("[immersion-sync] response:", r.status);
}

// Debounced sync — coalesces rapid triggers.
// Only POSTs when total chars for today have actually increased since last send.
let _debounceTimer = null;
let _lastSentChars = 0;

function scheduleSync(reason) {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(async () => {
    try {
      const entries    = await readTodayEntries();
      console.log("[immersion-sync] scheduleSync:", reason, "— entries:", entries.length, "lastChars:", _lastSentChars);
      if (entries.length === 0) return;
      const totalChars = entries.reduce((s, e) => s + (e.charactersRead || 0), 0);
      if (totalChars === _lastSentChars) return;
      _lastSentChars = totalChars;
      await postToTracker(entries);
    } catch (e) {
      console.log("[immersion-sync] error:", e);
    }
  }, 800);
}

console.log("[immersion-sync] content script loaded");

// ── Trigger: pause / play button clicks ──────────────────────────────────────
document.addEventListener("click", (e) => {
  const el = e.target.closest("button, [role='button']");
  if (!el) return;

  const ariaLabel  = (el.getAttribute("aria-label") || "").toLowerCase();
  const ariaPressed = el.getAttribute("aria-pressed");
  const cls        = (el.className || "").toLowerCase();

  const looksLikeToggle =
    ariaLabel.includes("pause") ||
    ariaLabel.includes("play")  ||
    cls.includes("pause")       ||
    cls.includes("play")        ||
    ariaPressed !== null;

  if (looksLikeToggle) scheduleSync("pause-play");
}, { capture: true });

// ── Trigger: tab hidden ───────────────────────────────────────────────────────
document.addEventListener("visibilitychange", () => {
  if (document.hidden) scheduleSync("visibility-hidden");
});

// ── Trigger: page unload ─────────────────────────────────────────────────────
window.addEventListener("pagehide", () => scheduleSync("pagehide"));

// ── Trigger: 60s heartbeat while tab is visible ──────────────────────────────
setInterval(() => {
  if (!document.hidden) scheduleSync("heartbeat");
}, 60_000);
