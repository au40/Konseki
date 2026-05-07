// Injected into the active tab on Start. Guards against double-injection.
if (!window.__immersionListenerActive) {
  window.__immersionListenerActive = true;

  function attachListeners(el) {
    if (el.__immersionBound) return;
    el.__immersionBound = true;
    el.addEventListener("play",  () => browser.runtime.sendMessage({ type: "media-play" }));
    el.addEventListener("pause", () => browser.runtime.sendMessage({ type: "media-pause" }));
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
