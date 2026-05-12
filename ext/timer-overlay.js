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
    pointerEvents:  "auto",
    userSelect:     "none",
    backdropFilter: "blur(6px)",
    border:         "1px solid rgba(155, 155, 199, 0.25)",
    letterSpacing:  "0.05em",
    cursor:         "grab",
    transition:     "opacity 0.3s",
  });
  document.documentElement.appendChild(overlay);

  // ── Drag-to-reposition (persists across page loads via storage) ─────────────
  function applyStoredPos(pos) {
    if (!pos || typeof pos.left !== "number" || typeof pos.top !== "number") return;
    const maxLeft = window.innerWidth  - overlay.offsetWidth;
    const maxTop  = window.innerHeight - overlay.offsetHeight;
    overlay.style.right = "auto";
    overlay.style.left  = Math.max(0, Math.min(maxLeft, pos.left)) + "px";
    overlay.style.top   = Math.max(0, Math.min(maxTop,  pos.top))  + "px";
  }
  browser.storage.local.get("overlayPos").then(({ overlayPos }) => applyStoredPos(overlayPos));

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  let didDrag = false;

  overlay.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    didDrag  = false;
    overlay.setPointerCapture(e.pointerId);
    const rect = overlay.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    overlay.style.cursor = "grabbing";
    overlay.style.transition = "none";
    e.preventDefault();
  });

  overlay.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    didDrag = true;
    const maxLeft = window.innerWidth  - overlay.offsetWidth;
    const maxTop  = window.innerHeight - overlay.offsetHeight;
    overlay.style.right = "auto";
    overlay.style.left  = Math.max(0, Math.min(maxLeft, e.clientX - offsetX)) + "px";
    overlay.style.top   = Math.max(0, Math.min(maxTop,  e.clientY - offsetY)) + "px";
  });

  async function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    try { overlay.releasePointerCapture(e.pointerId); } catch {}
    overlay.style.cursor = "grab";
    overlay.style.transition = "opacity 0.3s";
    if (didDrag) {
      const rect = overlay.getBoundingClientRect();
      await browser.storage.local.set({ overlayPos: { left: rect.left, top: rect.top } });
    }
  }
  overlay.addEventListener("pointerup",     endDrag);
  overlay.addEventListener("pointercancel", endDrag);

  function formatTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map(v => String(v).padStart(2, "0")).join(":");
  }

  let stopped = false;

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
      stopped = true;
      window.__immersionOverlayActive = false;
    }
  }

  function scheduleTick() {
    const delay = 1000 - (Date.now() % 1000);
    setTimeout(async () => {
      if (stopped) return;
      await tick();
      if (!stopped) scheduleTick();
    }, delay);
  }

  tick();
  scheduleTick();
}
