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

console.log("[NeoVision] Content script loaded on", location.href);
