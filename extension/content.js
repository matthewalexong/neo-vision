/**
 * NeoVision Bridge — Content Script
 *
 * Injected into every page. Provides a message bridge between
 * the background service worker and the page context.
 * Handles spatial snapshot injection and DOM queries.
 */

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "neo_ping") {
    sendResponse({ alive: true, url: location.href });
    return true;
  }

  if (msg.type === "neo_get_metadata") {
    const meta = {
      url: location.href,
      title: document.title,
      charset: document.characterSet,
      lang: document.documentElement.lang,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        pageHeight: document.documentElement.scrollHeight,
        pageWidth: document.documentElement.scrollWidth
      }
    };
    sendResponse(meta);
    return true;
  }
});

// ─── Console capture forwarding ──────────────────────────────────
//
// console-capture.js (main world, injected by background.js) wraps the
// page's console.* methods and posts {source:'__neovision_console__', ...}
// via window.postMessage. We listen here (isolated world) and forward to
// background.js, which keeps a per-tab ring buffer.
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.source !== "__neovision_console__") return;
  // Source must be the same window — ignore postMessages from iframes etc.
  if (e.source !== window) return;
  try {
    chrome.runtime.sendMessage({
      type: "neo_console_log",
      level: d.level,
      args: d.args,
      ts: d.ts,
      url: d.url,
    }, () => { void chrome.runtime.lastError; });
  } catch { /* extension context invalidated mid-call */ }
});

console.log("[NeoVision] Content script loaded on", location.href);
