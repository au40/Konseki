// Injected into the active tab on Start. Shows a live timer in the corner.
// Guards against double-injection.
if (!window.__immersionOverlayActive) {
  window.__immersionOverlayActive = true;

  const overlay = document.createElement("div");
  overlay.id = "__immersion-overlay";
  Object.assign(overlay.style, {
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
    pointerEvents:  "none",
    userSelect:     "none",
    backdropFilter: "blur(6px)",
    border:         "1px solid rgba(155, 155, 199, 0.25)",
    letterSpacing:  "0.05em",
    transition:     "opacity 0.3s",
  });
  document.documentElement.appendChild(overlay);

  function formatTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map(v => String(v).padStart(2, "0")).join(":");
  }

  async function tick() {
    const cfg = await browser.storage.local.get(
      ["timerRunning", "timerPaused", "timerWaiting", "timerStart", "timerElapsed"]
    );

    if (cfg.timerWaiting) {
      overlay.textContent = "⏱ Waiting…";
      overlay.style.opacity = "0.55";
    } else if (cfg.timerRunning && cfg.timerStart) {
      const elapsed = (cfg.timerElapsed || 0) + Math.floor((Date.now() - cfg.timerStart) / 1000);
      overlay.textContent = "⏱ " + formatTime(elapsed);
      overlay.style.opacity = "1";
    } else if (cfg.timerPaused) {
      overlay.textContent = "⏸ " + formatTime(cfg.timerElapsed || 0);
      overlay.style.opacity = "0.65";
    } else {
      // Session ended — clean up
      overlay.remove();
      clearInterval(interval);
    }
  }

  tick();
  const interval = setInterval(tick, 1000);
}
