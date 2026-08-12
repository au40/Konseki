// Injected into the active tab on Start. Guards against double-injection.
if (!window.__immersionListenerActive) {
  window.__immersionListenerActive = true;

  // A muted / zero-volume video is not something the user is *listening* to —
  // e.g. YouTube's homepage masthead autoplays a muted preview. Treat those as
  // "not playing" so they neither start nor resume the timer.
  const audible = el => !el.paused && !el.ended && !el.muted && el.volume > 0;

  function attachListeners(el) {
    if (el.__immersionBound) return;
    el.__immersionBound = true;
    // Report the *current* audibility, not just the raw event: a muted play
    // sends a pause (no-op if idle), an unmute while playing sends a play.
    const report = () => browser.runtime.sendMessage({ type: audible(el) ? "media-play" : "media-pause" });
    el.addEventListener("play",         report);
    el.addEventListener("playing",      report);
    el.addEventListener("volumechange", report);
    el.addEventListener("pause", () => browser.runtime.sendMessage({ type: "media-pause" }));
    el.addEventListener("ended", () => browser.runtime.sendMessage({ type: "media-pause" }));
  }

  document.querySelectorAll("video, audio").forEach(attachListeners);

  // Catch video elements added after injection (YouTube SPA navigation, etc.)
  new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.("video, audio")) attachListeners(node);
        node.querySelectorAll?.("video, audio").forEach(attachListeners);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}
