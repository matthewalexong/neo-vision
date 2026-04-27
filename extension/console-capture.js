// NeoVision console capture — runs in MAIN world to wrap the page's
// real console object. Sends each call out via window.postMessage so
// the content script (isolated world) can forward to background.js.
//
// Loaded via chrome.scripting.executeScript({files:[...]}) which bypasses
// page CSP — direct main-world injection via <script>.textContent fails on
// CSP-strict sites.
//
// Idempotent: re-runs are no-ops thanks to the marker on window.

(function () {
  if (window.__neoVisionConsoleCapture) return;
  window.__neoVisionConsoleCapture = true;

  const TAG = "__neovision_console__";
  const MAX_ARG_LEN = 2000;

  function safeStringify(v) {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    const t = typeof v;
    if (t === "string") return v.slice(0, MAX_ARG_LEN);
    if (t === "number" || t === "boolean") return String(v);
    if (v instanceof Error) {
      return `${v.name}: ${v.message}\n${(v.stack || "").slice(0, 1000)}`;
    }
    try {
      return JSON.stringify(v).slice(0, MAX_ARG_LEN);
    } catch {
      return Object.prototype.toString.call(v);
    }
  }

  const levels = ["log", "info", "warn", "error", "debug"];
  for (const level of levels) {
    const original = console[level];
    if (typeof original !== "function") continue;
    console[level] = function (...args) {
      try {
        const serialized = args.map(safeStringify);
        window.postMessage({
          source: TAG,
          level,
          args: serialized,
          ts: Date.now(),
          url: location.href,
        }, "*");
      } catch {
        /* never break the page if our hook throws */
      }
      return original.apply(this, args);
    };
  }

  // Also capture window.onerror and unhandledrejection — these are the most
  // common "page broke silently" signals.
  window.addEventListener("error", (e) => {
    try {
      window.postMessage({
        source: TAG,
        level: "error",
        args: [`Uncaught ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`],
        ts: Date.now(),
        url: location.href,
      }, "*");
    } catch {}
  });
  window.addEventListener("unhandledrejection", (e) => {
    try {
      const reason = e.reason instanceof Error
        ? `${e.reason.name}: ${e.reason.message}`
        : safeStringify(e.reason);
      window.postMessage({
        source: TAG,
        level: "error",
        args: [`Unhandled rejection: ${reason}`],
        ts: Date.now(),
        url: location.href,
      }, "*");
    } catch {}
  });
})();
