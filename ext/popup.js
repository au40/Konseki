// ── Settings ──────────────────────────────────────────────────────────────────
const portEl   = document.getElementById("port");
const tokenEl  = document.getElementById("token");
const saveBtn  = document.getElementById("save");
const statusEl = document.getElementById("status");

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
  statusEl.textContent = "Saved.";
  statusEl.className   = "";
  setTimeout(() => { statusEl.textContent = ""; }, 2000);
});

// ── Stopwatch ─────────────────────────────────────────────────────────────────
const timerDisplay   = document.getElementById("timer-display");
const activitySelect = document.getElementById("activity-select");
const pauseBtn       = document.getElementById("pause-btn");
const startStopBtn   = document.getElementById("start-stop-btn");
const timerStatus    = document.getElementById("timer-status");

let timerInterval = null;

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

  if (cfg.timerRunning) {
    // Running
    timerDisplay.classList.remove("paused");
    timerDisplay.classList.add("running");
    pauseBtn.textContent = "Pause";
    pauseBtn.style.display = "";
    startStopBtn.textContent = "Stop";
    startStopBtn.className = "stop-btn";
    activitySelect.disabled = true;
    tick(cfg);
    timerInterval = setInterval(() => tick(cfg), 1000);

  } else if (cfg.timerPaused) {
    // Paused
    timerDisplay.classList.remove("running");
    timerDisplay.classList.add("paused");
    pauseBtn.textContent = "Resume";
    pauseBtn.style.display = "";
    startStopBtn.textContent = "Stop";
    startStopBtn.className = "stop-btn";
    activitySelect.disabled = true;
    timerDisplay.textContent = formatTime(cfg.timerElapsed || 0);

  } else {
    // Idle
    timerDisplay.classList.remove("running", "paused");
    timerDisplay.textContent = "00:00:00";
    pauseBtn.style.display = "none";
    startStopBtn.textContent = "Start";
    startStopBtn.className = "";
    activitySelect.disabled = false;
  }
}

// Restore state when popup opens
browser.storage.local.get(
  ["timerRunning", "timerPaused", "timerStart", "timerElapsed", "timerActivity"]
).then(cfg => {
  if (cfg.timerActivity) activitySelect.value = cfg.timerActivity;
  applyState(cfg);
});

// ── Pause / Resume ────────────────────────────────────────────────────────────
pauseBtn.addEventListener("click", async () => {
  const cfg = await browser.storage.local.get(
    ["timerRunning", "timerPaused", "timerStart", "timerElapsed"]
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

  } else if (cfg.timerPaused) {
    // → Resume: start a new active period
    const timerStart = Date.now();
    await browser.storage.local.set({
      timerRunning: true,
      timerPaused:  false,
      timerStart,
    });
    applyState({ timerRunning: true, timerStart, timerElapsed: cfg.timerElapsed || 0 });
  }
});

// ── Start / Stop ──────────────────────────────────────────────────────────────
startStopBtn.addEventListener("click", async () => {
  const cfg = await browser.storage.local.get(
    ["timerRunning", "timerPaused", "timerStart", "timerElapsed", "port", "token"]
  );

  if (!cfg.timerRunning && !cfg.timerPaused) {
    // → Start
    const timerStart = Date.now();
    await browser.storage.local.set({
      timerRunning: true,
      timerPaused:  false,
      timerStart,
      timerElapsed: 0,
      timerActivity: activitySelect.value,
    });
    applyState({ timerRunning: true, timerStart, timerElapsed: 0 });
    return;
  }

  // → Stop (from running or paused)
  const elapsed  = getElapsed(cfg);
  const activity = activitySelect.value;

  await browser.storage.local.remove(
    ["timerRunning", "timerPaused", "timerStart", "timerElapsed", "timerActivity"]
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
