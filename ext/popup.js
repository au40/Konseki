// ── Settings ──────────────────────────────────────────────────────────────────
const portEl   = document.getElementById("port");
const tokenEl  = document.getElementById("token");
const saveBtn  = document.getElementById("save");
const statusEl = document.getElementById("status");

const FALLBACK_ACTIVITY_TYPES = ["Listening", "Reading", "Speaking", "Vocabulary", "Other"];

function populateActivitySelect(types) {
  const prev = activitySelect.value;
  activitySelect.innerHTML = "";
  for (const t of types) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = t;
    activitySelect.appendChild(opt);
  }
  // Restore previous selection if still present
  if ([...activitySelect.options].some(o => o.value === prev)) {
    activitySelect.value = prev;
  }
}

async function fetchActivityTypes() {
  const cfg   = await browser.storage.local.get(["port", "token"]);
  const port  = cfg.port  || 18463;
  const token = (cfg.token || "").trim();
  if (!token) return;
  try {
    const resp  = await fetch(`http://127.0.0.1:${port}/activity-types`, {
      headers: { "X-Tracker-Token": token },
    });
    if (resp.ok) {
      const types = await resp.json();
      if (Array.isArray(types) && types.length) populateActivitySelect(types);
    }
  } catch {
    // Tracker not running — keep fallback list
  }
}

browser.storage.local.get(["port", "token"]).then(cfg => {
  portEl.value  = cfg.port  || 18463;
  tokenEl.value = cfg.token || "";
});

saveBtn.addEventListener("click", async () => {
  const port  = parseInt(portEl.value) || 18463;
  const token = tokenEl.value.trim();

  if (!token) {
    statusEl.textContent = "Token cannot be empty.";
    statusEl.className   = "err";
    return;
  }
  if (port < 1024 || port > 65535) {
    statusEl.textContent = "Port must be between 1024 and 65535.";
    statusEl.className   = "err";
    return;
  }

  await browser.storage.local.set({ port, token });
  browser.action.setBadgeText({ text: "" });
  statusEl.textContent = "Saved.";
  statusEl.className   = "";

  // Dismiss the "paste your token" / "no token set" prompt if it's showing
  if (timerStatus.classList.contains("err") && /token/i.test(timerStatus.textContent)) {
    timerStatus.textContent = "";
    timerStatus.className   = "";
  }

  fetchActivityTypes();
  setTimeout(() => { statusEl.textContent = ""; }, 2000);
});

// ── Stopwatch ─────────────────────────────────────────────────────────────────
const timerDisplay   = document.getElementById("timer-display");
const activitySelect = document.getElementById("activity-select");
const pauseBtn       = document.getElementById("pause-btn");
const startStopBtn   = document.getElementById("start-stop-btn");
const timerStatus    = document.getElementById("timer-status");
const modeSeg            = document.getElementById("mode-seg");
const modeBtns           = Array.from(modeSeg.querySelectorAll(".seg-btn"));
const discardBtn         = document.getElementById("discard-btn");
const discardRow         = document.getElementById("discard-row");

function getSelectedMode() {
  return modeSeg.querySelector(".seg-btn.active")?.dataset.mode || "video";
}

modeBtns.forEach(btn => {
  btn.addEventListener("click", async () => {
    if (btn.disabled || btn.classList.contains("active")) return;
    const newMode = btn.dataset.mode;
    modeBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // While a session is paused, persist the change so Resume picks up the new mode
    // and adjust the side-channels (audible listener flag, media-listener injection).
    const cfg = await browser.storage.local.get(["timerPaused", "timerTabId"]);
    if (!cfg.timerPaused) return;

    await browser.storage.local.set({ timerMode: newMode });
    if (newMode === "audio") {
      await browser.storage.local.set({ timerAudioDetect: true });
    } else {
      await browser.storage.local.remove("timerAudioDetect");
    }
    if (newMode === "video" && cfg.timerTabId) {
      try { await browser.scripting.executeScript({ target: { tabId: cfg.timerTabId }, files: ["media-listener.js"] }); } catch {}
    }
  });
});

let timerInterval = null;
let discardConfirmTimeout = null;

function resetDiscardBtn() {
  clearTimeout(discardConfirmTimeout);
  discardConfirmTimeout = null;
  discardBtn.dataset.confirming = "";
  discardBtn.classList.remove("confirm");
  discardBtn.textContent = "Discard";
}

function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
}

function getElapsed(cfg) {
  const base = cfg.timerElapsed || 0;
  if (cfg.timerRunning && cfg.timerStart) {
    return base + Math.floor((Date.now() - cfg.timerStart) / 1000);
  }
  return base;
}

function tick(cfg) {
  timerDisplay.textContent = formatTime(getElapsed(cfg));
}

function applyState(cfg) {
  clearInterval(timerInterval);
  timerInterval = null;

  const active   = cfg.timerRunning || cfg.timerPaused || cfg.timerWaiting;
  const lockMode = cfg.timerRunning || cfg.timerWaiting;  // mode is editable while paused
  modeBtns.forEach(b => { b.disabled = !!lockMode; });
  if (active && cfg.timerMode) {
    modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === cfg.timerMode));
  }
  discardRow.style.display = active ? "" : "none";
  if (!active) resetDiscardBtn();

  if (cfg.timerRunning) {
    // Running
    timerDisplay.classList.remove("paused");
    timerDisplay.classList.add("running");
    pauseBtn.textContent = "Pause";
    pauseBtn.style.display = "";
    startStopBtn.textContent = "Log";
    startStopBtn.className = "stop-btn";
    activitySelect.disabled = true;
    tick(cfg);
    timerInterval = setInterval(() => tick(cfg), 1000);

  } else if (cfg.timerPaused) {
    // Paused (or recovered from a closed/crashed browser)
    timerDisplay.classList.remove("running");
    timerDisplay.classList.add("paused");
    pauseBtn.textContent = "Resume";
    pauseBtn.style.display = cfg.timerRecovered ? "none" : "";
    startStopBtn.textContent = "Log";
    startStopBtn.className = "stop-btn";
    activitySelect.disabled = true;
    timerDisplay.textContent = formatTime(cfg.timerElapsed || 0);
    if (cfg.timerRecovered) {
      timerStatus.textContent = "Recovered session — log or discard?";
      timerStatus.className   = "";
    }

  } else if (cfg.timerWaiting) {
    // Armed — waiting for first play event
    timerDisplay.classList.remove("running", "paused");
    timerDisplay.textContent = formatTime(cfg.timerElapsed || 0);
    pauseBtn.style.display = "none";
    startStopBtn.textContent = "Log";
    startStopBtn.className = "stop-btn";
    activitySelect.disabled = true;
    timerStatus.textContent = "Waiting for playback…";
    timerStatus.className   = "";

  } else {
    // Idle
    timerDisplay.classList.remove("running", "paused");
    timerDisplay.textContent = "00:00:00";
    pauseBtn.style.display = "none";
    startStopBtn.textContent = "Start";
    startStopBtn.className = "";
    activitySelect.disabled = false;
    timerStatus.textContent = "";
  }
}

// Restore state and fetch activity types when popup opens
browser.storage.local.get(
  ["timerRunning", "timerPaused", "timerWaiting", "timerStart", "timerElapsed", "timerActivity", "timerMode", "timerRecovered", "token"]
).then(cfg => {
  if (cfg.timerActivity) activitySelect.value = cfg.timerActivity;
  applyState(cfg);
  if (!(cfg.token || "").trim()) {
    timerStatus.textContent = "Paste your token in Extension Settings below.";
    timerStatus.className   = "err";
  }
});

// Keep popup in sync when background.js mutates timer state (e.g. audio detect pause)
const TIMER_KEYS = ["timerRunning", "timerPaused", "timerWaiting", "timerStart", "timerElapsed", "timerAutoPaused", "timerRecovered", "timerMode"];
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!TIMER_KEYS.some(k => k in changes)) return;
  browser.storage.local.get(TIMER_KEYS).then(applyState);
});

// Populate with fallback immediately, then overwrite with live list
populateActivitySelect(FALLBACK_ACTIVITY_TYPES);
fetchActivityTypes();

// ── Pause / Resume ────────────────────────────────────────────────────────────
pauseBtn.addEventListener("click", async () => {
  const cfg = await browser.storage.local.get(
    ["timerRunning", "timerPaused", "timerStart", "timerElapsed", "timerMode", "timerTabId"]
  );

  if (cfg.timerRunning) {
    // → Pause: freeze elapsed, clear start
    const elapsed = getElapsed(cfg);
    await browser.storage.local.set({
      timerRunning: false,
      timerPaused:  true,
      timerElapsed: elapsed,
      timerStart:   null,
    });
    applyState({ timerRunning: false, timerPaused: true, timerElapsed: elapsed });
    return;
  }

  if (!cfg.timerPaused) return;

  // → Resume: behavior depends on the mode the session was started in
  const mode    = cfg.timerMode || "manual";
  const tabId   = cfg.timerTabId;
  const elapsed = cfg.timerElapsed || 0;

  async function reinjectOverlay() {
    if (!tabId) return;
    try { await browser.scripting.executeScript({ target: { tabId }, files: ["timer-overlay.js"] }); } catch {}
  }

  async function resumeRunning() {
    const timerStart = Date.now();
    await browser.storage.local.set({
      timerRunning:    true,
      timerPaused:     false,
      timerWaiting:    false,
      timerAutoPaused: false,
      timerStart,
    });
    applyState({ timerRunning: true, timerStart, timerElapsed: elapsed });
    await reinjectOverlay();
  }

  async function resumeWaiting() {
    await browser.storage.local.set({
      timerRunning:    false,
      timerPaused:     false,
      timerWaiting:    true,
      timerAutoPaused: false,
      timerStart:      null,
    });
    applyState({ timerWaiting: true, timerElapsed: elapsed });
    await reinjectOverlay();
  }

  if (mode === "manual") {
    await resumeRunning();
    return;
  }

  if (mode === "audio") {
    let audible = false;
    if (tabId) {
      try {
        const tab = await browser.tabs.get(tabId);
        audible = tab?.audible || false;
      } catch {}
    }
    if (audible) await resumeRunning();
    else         await resumeWaiting();
    return;
  }

  // mode === "video": re-probe the page for an actively playing media element
  if (tabId) {
    try { await browser.scripting.executeScript({ target: { tabId }, files: ["media-listener.js"] }); } catch {}
  }
  let videoState = { found: false, playing: false };
  if (tabId) {
    try {
      const check = await browser.scripting.executeScript({
        target: { tabId },
        func: () => {
          const els = Array.from(document.querySelectorAll("video, audio"));
          return {
            found:   els.length > 0,
            playing: els.some(el => !el.paused && !el.ended && el.readyState > 2),
          };
        },
      });
      videoState = check?.[0]?.result ?? videoState;
    } catch {}
  }

  if (videoState.playing) await resumeRunning();
  else                    await resumeWaiting();
});

// ── Discard ───────────────────────────────────────────────────────────────────
discardBtn.addEventListener("click", async () => {
  const cfg = await browser.storage.local.get(
    ["timerRunning", "timerPaused", "timerWaiting", "timerStart", "timerElapsed"]
  );
  const elapsed = getElapsed(cfg);
  const trivial = elapsed <= 30;
  const confirming = discardBtn.dataset.confirming === "1";

  if (trivial || confirming) {
    resetDiscardBtn();
    timerStatus.onclick = null;
    await browser.storage.local.remove(
      ["timerRunning", "timerPaused", "timerWaiting", "timerStart", "timerElapsed", "timerActivity", "timerAutoPaused", "timerAudioDetect", "timerTabId", "timerMode", "timerRecovered", "timerLastTick"]
    );
    applyState({});
    if (elapsed >= 1) {
      timerStatus.textContent = `Discarded ${formatTime(elapsed)}.`;
      timerStatus.className   = "";
      setTimeout(() => { timerStatus.textContent = ""; }, 2500);
    }
    return;
  }

  // First click on a non-trivial session — request confirmation
  discardBtn.dataset.confirming = "1";
  discardBtn.classList.add("confirm");
  discardBtn.textContent = `Discard ${formatTime(elapsed)}?`;
  discardConfirmTimeout = setTimeout(resetDiscardBtn, 4000);
});

// ── Start / Log ───────────────────────────────────────────────────────────────
startStopBtn.addEventListener("click", async () => {
  const cfg = await browser.storage.local.get(
    ["timerRunning", "timerPaused", "timerWaiting", "timerStart", "timerElapsed", "port", "token"]
  );

  if (!cfg.timerRunning && !cfg.timerPaused && !cfg.timerWaiting) {
    // → Start
    const activity = activitySelect.value;

    async function startRunning(tabId, mode) {
      const timerStart = Date.now();
      await browser.storage.local.set({
        timerRunning: true, timerPaused: false,
        timerStart, timerElapsed: 0, timerActivity: activity,
        timerMode: mode, timerTabId: tabId ?? null,
      });
      applyState({ timerRunning: true, timerStart, timerElapsed: 0 });
      if (tabId) {
        try { await browser.scripting.executeScript({ target: { tabId }, files: ["timer-overlay.js"] }); } catch {}
      }
    }

    async function startWaiting(tabId, mode) {
      await browser.storage.local.set({
        timerWaiting: true, timerRunning: false,
        timerPaused: false, timerElapsed: 0, timerActivity: activity,
        timerMode: mode, timerTabId: tabId ?? null,
      });
      applyState({ timerWaiting: true, timerElapsed: 0 });
      try { await browser.scripting.executeScript({ target: { tabId }, files: ["timer-overlay.js"] }); } catch {}
    }

    // Get current tab id (best-effort)
    let tabId = null;
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id ?? null;
    } catch {}

    const mode = getSelectedMode();

    // Manual mode — skip detection entirely
    if (mode === "manual") {
      await startRunning(tabId, "manual");
      return;
    }

    // Audio mode — watch tab audible state instead of video elements
    if (mode === "audio" && tabId) {
      let currentlyAudible = false;
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        currentlyAudible = tab?.audible || false;
      } catch {}
      await browser.storage.local.set({ timerAudioDetect: true });
      if (currentlyAudible) {
        await startRunning(tabId, "audio");
      } else {
        await startWaiting(tabId, "audio");
      }
      return;
    }

    // Inject listener (best-effort — failures don't block detection)
    if (tabId) {
      try { await browser.scripting.executeScript({ target: { tabId }, files: ["media-listener.js"] }); } catch {}
    }

    // Detect video state: exists? already playing?
    let videoState = { found: false, playing: false };
    if (tabId) {
      try {
        const check = await browser.scripting.executeScript({
          target: { tabId },
          func: () => {
            const els = Array.from(document.querySelectorAll("video, audio"));
            return {
              found:   els.length > 0,
              playing: els.some(el => !el.paused && !el.ended && el.readyState > 2),
            };
          },
        });
        videoState = check?.[0]?.result ?? videoState;
      } catch {}
    }

    if (videoState.playing) {
      // Video already playing — start ticking immediately
      await startRunning(tabId, "video");
    } else if (videoState.found) {
      // Video exists but paused — wait for play event
      await startWaiting(tabId, "video");
    } else {
      // No video found — prompt
      timerStatus.textContent = "No video detected! Activate manual logging?";
      timerStatus.className   = "prompt";
      timerStatus.onclick = async () => {
        timerStatus.onclick     = null;
        timerStatus.className   = "";
        timerStatus.textContent = "";
        modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === "manual"));
        await startRunning(tabId, "manual");
      };
    }
    return;
  }

  // → Stop (from running, paused, or waiting)
  timerStatus.onclick = null;
  const elapsed  = getElapsed(cfg);
  const activity = activitySelect.value;

  await browser.storage.local.remove(
    ["timerRunning", "timerPaused", "timerWaiting", "timerStart", "timerElapsed", "timerActivity", "timerAutoPaused", "timerAudioDetect", "timerTabId", "timerMode", "timerRecovered", "timerLastTick"]
  );
  applyState({});

  if (elapsed < 1) return;

  const port  = cfg.port  || 18463;
  const token = cfg.token || "";

  if (!token) {
    timerStatus.textContent = "No token set — configure in Settings.";
    timerStatus.className   = "err";
    return;
  }

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/log-manual`, {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-Tracker-Token": token,
      },
      body: JSON.stringify({
        activity_type: activity,
        time_seconds:  elapsed,
      }),
    });

    if (resp.ok) {
      timerStatus.textContent = `Logged ${formatTime(elapsed)} of ${activity}`;
      timerStatus.className   = "";
      setTimeout(() => { timerStatus.textContent = ""; }, 4000);
    } else {
      timerStatus.textContent = "Failed to log — is the tracker running?";
      timerStatus.className   = "err";
    }
  } catch {
    timerStatus.textContent = "Could not connect to tracker.";
    timerStatus.className   = "err";
  }
});
