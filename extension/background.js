/**
 * NeoVision Bridge — Chrome Extension Background Service Worker
 *
 * Connects to the NeoVision MCP server via WebSocket.
 * Receives commands (navigate, executeJs, click, type, injectSpatial, etc.)
 * and executes them in the browser using Chrome extension APIs.
 *
 * This gives ANY AI agent with MCP access full browser control
 * through a real Chrome session — real cookies, real fingerprints, no CAPTCHAs.
 */

// ─── Config ──────────────────────────────────────────────────────
const BASE_PORT = 7665;
const MAX_PORT = 7674;  // Try ports 7665–7674 (matches server-side range)
let ws = null;
let connected = false;
let reconnectTimer = null;
let currentPort = BASE_PORT;  // Track which port we're connected to
let managedTabId = null;  // The tab we're controlling
let tabGroupId = null;

// ─── WebSocket Connection ────────────────────────────────────────

/**
 * Try connecting to ports BASE_PORT through MAX_PORT sequentially.
 * On first success, stay on that port. On reconnect after disconnect,
 * scan all ports again (server may have moved).
 */
function connect(wsUrl) {
  if (ws && ws.readyState <= 1) return; // already open/connecting

  // If a specific URL was passed (e.g. from popup), use it directly
  if (wsUrl) {
    return connectToUrl(wsUrl);
  }

  // Otherwise, scan the port range
  connectWithPortScan(BASE_PORT);
}

function connectWithPortScan(port) {
  if (connected) return; // connected during scan
  if (port > MAX_PORT) {
    // All ports failed — wait and retry from the beginning
    console.log(`[NeoVision] No bridge found on ports ${BASE_PORT}-${MAX_PORT}. Retrying in 5s...`);
    updateBadge("OFF", "#ef4444");
    reconnectTimer = setTimeout(() => connectWithPortScan(BASE_PORT), 5000);
    return;
  }

  const url = `ws://localhost:${port}`;
  console.log(`[NeoVision] Trying ${url}...`);

  const testWs = new WebSocket(url);

  // Give each port 2 seconds to connect before moving on
  const portTimeout = setTimeout(() => {
    if (testWs.readyState !== 1) {
      testWs.close();
      connectWithPortScan(port + 1);
    }
  }, 2000);

  testWs.onopen = () => {
    clearTimeout(portTimeout);
    // This port works — adopt this WebSocket
    ws = testWs;
    connected = true;
    currentPort = port;
    console.log(`[NeoVision] Connected to MCP bridge on port ${port}`);
    clearTimeout(reconnectTimer);
    updateBadge("ON", "#22c55e");
    attachWsHandlers(testWs);
    // Announce ourselves
    sendWs({ type: "hello", agent: "neovision-chrome-bridge", version: "0.2.0" });
  };

  testWs.onerror = () => {
    clearTimeout(portTimeout);
    testWs.close();
    // Try next port immediately
    connectWithPortScan(port + 1);
  };
}

function connectToUrl(wsUrl) {
  console.log(`[NeoVision] Connecting to ${wsUrl}...`);
  const newWs = new WebSocket(wsUrl);

  newWs.onopen = () => {
    ws = newWs;
    connected = true;
    console.log("[NeoVision] Connected to MCP bridge");
    clearTimeout(reconnectTimer);
    updateBadge("ON", "#22c55e");
    attachWsHandlers(newWs);
    sendWs({ type: "hello", agent: "neovision-chrome-bridge", version: "0.2.0" });
  };

  newWs.onerror = (err) => {
    console.error("[NeoVision] WebSocket error:", err);
    newWs.close();
  };

  newWs.onclose = () => {
    connected = false;
    console.log("[NeoVision] Disconnected. Scanning ports in 5s...");
    updateBadge("OFF", "#ef4444");
    reconnectTimer = setTimeout(() => connectWithPortScan(BASE_PORT), 5000);
  };
}

function attachWsHandlers(socket) {
  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      const result = await handleCommand(msg);
      if (msg.id) {
        sendWs({ id: msg.id, type: "result", result });
      }
    } catch (err) {
      console.error("[NeoVision] Error handling message:", err);
      if (event.data) {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id) {
            sendWs({ id: msg.id, type: "error", error: err.message });
          }
        } catch (_) {}
      }
    }
  };

  socket.onclose = () => {
    connected = false;
    ws = null;
    console.log("[NeoVision] Disconnected. Scanning ports in 5s...");
    updateBadge("OFF", "#ef4444");
    reconnectTimer = setTimeout(() => connectWithPortScan(BASE_PORT), 5000);
  };

  socket.onerror = (err) => {
    console.error("[NeoVision] WebSocket error:", err);
    socket.close();
  };
}

function sendWs(data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ─── Tab Management ──────────────────────────────────────────────

async function getOrCreateTab() {
  // If we have a managed tab, check it still exists
  if (managedTabId) {
    try {
      const tab = await chrome.tabs.get(managedTabId);
      if (tab) return managedTabId;
    } catch (_) {
      managedTabId = null;
    }
  }

  // Create a new tab in a tab group
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  managedTabId = tab.id;

  // Create a tab group for NeoVision
  try {
    tabGroupId = await chrome.tabs.group({ tabIds: [managedTabId] });
    await chrome.tabGroups.update(tabGroupId, {
      title: "NeoVision",
      color: "green",
      collapsed: false
    });
  } catch (e) {
    console.warn("[NeoVision] Could not create tab group:", e);
  }

  return managedTabId;
}

// ─── Command Handler ─────────────────────────────────────────────

async function handleCommand(msg) {
  const { command, params } = msg;

  switch (command) {

    // ── Navigate to URL ──
    case "navigate": {
      const tabId = params.tabId || await getOrCreateTab();
      await chrome.tabs.update(tabId, { url: params.url });
      // Wait for page to load
      await waitForTabLoad(tabId, params.timeout || 30000);
      const tab = await chrome.tabs.get(tabId);
      return {
        success: true,
        url: tab.url,
        title: tab.title
      };
    }

    // ── Query DOM elements ──
    // MV3 blocks eval/new Function everywhere — no arbitrary JS execution.
    // Instead, expose specific DOM query commands with static funcs + args.
    case "query_dom": {
      // params: { selector, attributes: ["href","textContent",...], limit: 20, filter: {attr:"href", contains:"/biz/"} }
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector, attributes, limit, filter) => {
          let elements = Array.from(document.querySelectorAll(selector));
          if (filter && filter.attr && filter.contains) {
            elements = elements.filter(el => {
              const val = filter.attr === "textContent" ? el.textContent : el.getAttribute(filter.attr);
              return val && val.includes(filter.contains);
            });
          }
          return elements.slice(0, limit).map(el => {
            const obj = {};
            for (const attr of attributes) {
              if (attr === "textContent") obj[attr] = (el.textContent || "").trim().substring(0, 200);
              else if (attr === "innerText") obj[attr] = (el.innerText || "").trim().substring(0, 200);
              else if (attr === "innerHTML") obj[attr] = (el.innerHTML || "").substring(0, 500);
              else if (attr === "tagName") obj[attr] = el.tagName.toLowerCase();
              else obj[attr] = el.getAttribute(attr);
            }
            return obj;
          });
        },
        args: [params.selector, params.attributes || ["textContent"], params.limit || 100, params.filter || null],
        world: "ISOLATED"
      });
      return { success: true, elements: results[0]?.result ?? [] };
    }

    // ── Extract LD+JSON structured data ──
    case "query_ldjson": {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const scripts = document.querySelectorAll('script[type="application/ld+json"]');
          const data = [];
          for (const s of scripts) {
            try { data.push(JSON.parse(s.textContent)); } catch {}
          }
          return data;
        },
        world: "ISOLATED"
      });
      return { success: true, data: results[0]?.result ?? [] };
    }

    // ── Click first element matching selector ──
    case "click_selector": {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => {
          const el = document.querySelector(selector);
          if (!el) return { found: false };
          el.click();
          return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().substring(0, 80) };
        },
        args: [params.selector],
        world: "ISOLATED"
      });
      return { success: true, result: results[0]?.result ?? { found: false } };
    }

    // ── Count elements matching selector ──
    case "query_count": {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => document.querySelectorAll(selector).length,
        args: [params.selector],
        world: "ISOLATED"
      });
      return { success: true, count: results[0]?.result ?? 0 };
    }

    // ── Execute JavaScript (legacy — uses script tag injection for MAIN world) ──
    case "execute_js": {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      // MV3 blocks eval/new Function in ALL extension contexts.
      // For MAIN world: inject a <script> tag into the page DOM.
      // For ISOLATED world: not possible without eval — use query_dom instead.
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (codeStr) => {
          // Inject code via <script> tag — runs in page's MAIN world
          const id = "__nv_" + Math.random().toString(36).slice(2);
          const script = document.createElement("script");
          script.textContent = "window['" + id + "']=" + codeStr + ";";
          document.documentElement.appendChild(script);
          script.remove();
          const result = window[id];
          delete window[id];
          return result;
        },
        args: [params.code],
        world: "MAIN"
      });
      return { success: true, result: results[0]?.result ?? null };
    }

    // ── Inject NeoVision spatial snapshot ──
    case "inject_spatial": {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const code = params.injectable_source;
      // Same script-tag injection for spatial snapshots (needs MAIN world DOM access)
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (codeStr) => {
          const id = "__nv_" + Math.random().toString(36).slice(2);
          const script = document.createElement("script");
          script.textContent = "window['" + id + "']=" + codeStr + ";";
          document.documentElement.appendChild(script);
          script.remove();
          const result = window[id];
          delete window[id];
          return result;
        },
        args: [code],
        world: "MAIN"
      });
      return { success: true, spatial_map: results[0]?.result ?? null };
    }

    // ── Click at coordinates ──
    case "click": {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const { x, y, button = "left" } = params;
      // Use content script to dispatch click events
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y, button) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return { success: false, error: "No element at coordinates" };

          const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
          for (const eventType of events) {
            const evt = new MouseEvent(eventType, {
              clientX: x, clientY: y,
              button: button === "right" ? 2 : 0,
              bubbles: true, cancelable: true, view: window
            });
            el.dispatchEvent(evt);
          }
          return {
            success: true,
            element: el.tagName.toLowerCase(),
            text: (el.textContent || "").trim().substring(0, 80)
          };
        },
        args: [x, y, button],
        world: "MAIN"
      });
      return results[0]?.result ?? { success: false, error: "Script failed" };
    }

    // ── Type text (focus element at coords first) ──
    case "type": {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const { x, y, text, clearFirst = false } = params;
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y, text, clearFirst) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return { success: false, error: "No element at coordinates" };

          el.focus();
          if (clearFirst && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
            el.value = "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }

          // For input/textarea, set value directly and fire events
          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            el.value = (clearFirst ? "" : el.value) + text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            // For contentEditable, use execCommand
            document.execCommand("insertText", false, text);
          }

          return { success: true, element: el.tagName.toLowerCase() };
        },
        args: [x, y, text, clearFirst],
        world: "MAIN"
      });
      return results[0]?.result ?? { success: false, error: "Script failed" };
    }

    // ── Scroll ──
    case "scroll": {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const { x = 640, y = 360, deltaX = 0, deltaY = 0 } = params;
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y, dx, dy) => {
          const el = document.elementFromPoint(x, y) || document.documentElement;
          el.scrollBy({ left: dx, top: dy, behavior: "smooth" });
        },
        args: [x, y, deltaX, deltaY],
        world: "MAIN"
      });
      return { success: true };
    }

    // ── Get page info ──
    case "get_page_info": {
      const tabId = params.tabId || managedTabId;
      if (!tabId) return { success: false, error: "No active tab" };
      const tab = await chrome.tabs.get(tabId);
      return {
        success: true,
        url: tab.url,
        title: tab.title,
        tabId: tab.id,
        status: tab.status
      };
    }

    // ── Get page text content ──
    case "get_page_text": {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Try to get article content first, fall back to body
          const article = document.querySelector("article") || document.querySelector("main") || document.body;
          return article ? article.innerText.substring(0, 50000) : "";
        },
        world: "MAIN"
      });
      return { success: true, text: results[0]?.result ?? "" };
    }

    // ── Wait ──
    case "wait": {
      const ms = (params.seconds || 3) * 1000;
      await new Promise(r => setTimeout(r, ms));
      return { success: true, waited: params.seconds };
    }

    // ── Screenshot (capture visible tab) ──
    case "screenshot": {
      const tabId = params.tabId || managedTabId;
      if (!tabId) return { success: false, error: "No active tab" };
      // Ensure tab is active for capture
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(r => setTimeout(r, 200));
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
      return {
        success: true,
        screenshot: dataUrl,
        format: "png",
        encoding: "base64-dataurl"
      };
    }

    // ── List tabs in our group ──
    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      const ourTabs = tabGroupId
        ? tabs.filter(t => t.groupId === tabGroupId)
        : (managedTabId ? tabs.filter(t => t.id === managedTabId) : []);
      return {
        success: true,
        tabs: ourTabs.map(t => ({ id: t.id, url: t.url, title: t.title }))
      };
    }

    // ── List ALL open tabs (for finding user's logged-in sessions) ──
    case "list_all_tabs": {
      const tabs = await chrome.tabs.query({});
      return {
        success: true,
        tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
      };
    }

    // ── Create new tab ──
    case "create_tab": {
      const tab = await chrome.tabs.create({ url: params.url || "about:blank", active: false });
      if (tabGroupId) {
        await chrome.tabs.group({ tabIds: [tab.id], groupId: tabGroupId });
      }
      return { success: true, tabId: tab.id, url: tab.url };
    }

    // ── Close tab ──
    case "close_tab": {
      await chrome.tabs.remove(params.tabId);
      if (params.tabId === managedTabId) managedTabId = null;
      return { success: true };
    }

    // ── Ping (health check) ──
    case "ping": {
      return { success: true, pong: true, timestamp: Date.now() };
    }

    default:
      return { success: false, error: `Unknown command: ${command}` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // resolve anyway, page might still be usable
    }, timeout);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Extra settle time for SPAs
        setTimeout(resolve, 500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ─── Lifecycle ───────────────────────────────────────────────────

// Keepalive: Chrome MV3 kills service workers after 30s idle.
// An alarm every 25s wakes the worker so the WebSocket stays alive.
chrome.alarms.create("neovision-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "neovision-keepalive") {
    if (!connected) {
      console.log("[NeoVision] Keepalive: scanning ports...");
      connect();
    }
  }
});

// Auto-connect on extension load
chrome.runtime.onInstalled.addListener(() => {
  console.log("[NeoVision] Extension installed");
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  connect();
});

// Listen for popup messages (manual connect/disconnect)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "connect") {
    connect(msg.wsUrl);  // pass explicit URL if provided, otherwise scans
    sendResponse({ status: "connecting" });
  } else if (msg.type === "disconnect") {
    if (ws) ws.close();
    ws = null;
    connected = false;
    clearTimeout(reconnectTimer);
    updateBadge("OFF", "#ef4444");
    sendResponse({ status: "disconnected" });
  } else if (msg.type === "status") {
    sendResponse({ connected, port: currentPort, managedTabId, tabGroupId });
  }
  return true; // async response
});

// Start connection — scan port range
connect();
