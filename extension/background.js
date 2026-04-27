/**
 * NeoVision Bridge — Chrome Extension Background Service Worker
 * (build: cache-bust 2026-04-26)
 *
 * Creates and supervises the offscreen document that holds the WebSocket
 * connection to the NeoVision daemon. When a command arrives from the
 * daemon (forwarded by offscreen.js), handleCommand() executes it using
 * Chrome extension APIs and the result is returned via sendResponse.
 *
 * This gives ANY AI agent with MCP access full browser control
 * through a real Chrome session — real cookies, real fingerprints, no CAPTCHAs.
 */

// ─── State ───────────────────────────────────────────────────────

let connected = false;
let currentPort = 7665;
let managedTabId = null;
let managedWindowId = null;
let tabGroupId = null;

// ─── Network capture ─────────────────────────────────────────────
//
// chrome.webRequest listeners track request lifecycle per tab. Events are
// keyed by chrome's requestId so we can join them across the lifecycle.
// On completion (or error), the joined entry is pushed to a per-tab ring
// buffer. Daemon clients read via the read_network_requests command.
const NETWORK_BUFFER_MAX = 1000;   // per tab
const networkBuffers = new Map();   // tabId -> Array<entry>
const networkInflight = new Map();  // requestId -> partial entry (may be on different tab)

function pushNetworkEntry(tabId, entry) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  let buf = networkBuffers.get(tabId);
  if (!buf) {
    buf = [];
    networkBuffers.set(tabId, buf);
  }
  buf.push(entry);
  if (buf.length > NETWORK_BUFFER_MAX) buf.shift();
}

if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  const filter = { urls: ['<all_urls>'] };

  chrome.webRequest.onBeforeRequest.addListener((d) => {
    networkInflight.set(d.requestId, {
      requestId: d.requestId, tabId: d.tabId,
      url: d.url, method: d.method, type: d.type,
      startedAt: d.timeStamp, completedAt: null,
      statusCode: null, statusLine: null, fromCache: false,
      error: null, responseHeaders: null,
    });
  }, filter);

  if (chrome.webRequest.onHeadersReceived) {
    chrome.webRequest.onHeadersReceived.addListener((d) => {
      const e = networkInflight.get(d.requestId);
      if (!e) return;
      e.statusCode = d.statusCode;
      e.statusLine = d.statusLine;
      // Capture a few useful response headers (content-type, content-length)
      // — full headers can be huge.
      if (d.responseHeaders) {
        const interesting = ['content-type', 'content-length', 'cf-ray', 'x-frame-options', 'set-cookie'];
        e.responseHeaders = {};
        for (const h of d.responseHeaders) {
          const n = (h.name || '').toLowerCase();
          if (interesting.includes(n)) e.responseHeaders[n] = h.value;
        }
      }
    }, filter, ['responseHeaders']);
  }

  chrome.webRequest.onCompleted.addListener((d) => {
    const e = networkInflight.get(d.requestId);
    if (!e) return;
    networkInflight.delete(d.requestId);
    e.completedAt = d.timeStamp;
    e.fromCache = d.fromCache;
    if (e.statusCode === null) e.statusCode = d.statusCode;
    pushNetworkEntry(e.tabId, e);
  }, filter);

  chrome.webRequest.onErrorOccurred.addListener((d) => {
    const e = networkInflight.get(d.requestId);
    if (!e) return;
    networkInflight.delete(d.requestId);
    e.completedAt = d.timeStamp;
    e.error = d.error;
    pushNetworkEntry(e.tabId, e);
  }, filter);
}

// ─── Console capture ─────────────────────────────────────────────
//
// Per-tab ring buffer of recent console.* and window.onerror events. The
// content script forwards via runtime.sendMessage; daemon clients read via
// the read_console_messages command.
const CONSOLE_BUFFER_MAX = 500;   // per tab
const consoleBuffers = new Map();   // tabId -> Array<entry>

function pushConsoleEntry(tabId, entry) {
  let buf = consoleBuffers.get(tabId);
  if (!buf) {
    buf = [];
    consoleBuffers.set(tabId, buf);
  }
  buf.push(entry);
  if (buf.length > CONSOLE_BUFFER_MAX) buf.shift();
}

// Injects the main-world console wrapper into a tab. Called on every
// committed navigation so each fresh page gets the wrapper.
async function injectConsoleCapture(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['console-capture.js'],
      world: 'MAIN',
      injectImmediately: true,
    });
  } catch (e) {
    // chrome:// pages, devtools, file:// without permission etc. just fail
    // silently — these aren't pages we care about for console capture.
  }
}

// ─── Logging ─────────────────────────────────────────────────────
//
// Logs everywhere: the local devtools console (so a developer with the SW
// inspector open sees them in real time) AND the daemon, which appends to
// ~/.neo-vision/logs/extension.log so they persist on disk and the user can
// grep for issues without opening chrome://extensions. Critical for debugging
// — until this existed, most extension errors were invisible.
function neoLog(level, msgText, ctx) {
  const out = ctx === undefined
    ? `[NeoVision][bg] ${msgText}`
    : `[NeoVision][bg] ${msgText} ${typeof ctx === 'string' ? ctx : safeStringify(ctx)}`;
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
  try {
    chrome.runtime.sendMessage(
      { type: 'offscreen_cmd', cmd: 'log', level, src: 'background', msg: msgText, ctx },
      () => { void chrome.runtime.lastError; }   // intentionally ignore — we already logged locally
    );
  } catch (_) { /* offscreen may not exist yet during startup */ }
}

function safeStringify(v) {
  try { return JSON.stringify(v); }
  catch { return String(v); }
}

// Replacement for `if (chrome.runtime.lastError) {}` — call after a Chrome
// API callback to log any error that occurred. Returns true if there was an
// error so callers can branch.
function checkLastError(context) {
  if (chrome.runtime.lastError) {
    neoLog('warn', `chrome.runtime.lastError in ${context}`, chrome.runtime.lastError.message);
    return true;
  }
  return false;
}

// ─── Build hash (matches daemon-side computation) ────────────────
//
// The daemon computes SHA-256 of background.js + spatial-snapshot.js +
// offscreen.js + manifest.json (concatenated, in that order) on startup.
// We compute the same hash here, on first request, by fetching our own
// extension files via chrome.runtime.getURL.
//
// When the daemon connects, it asks for our hash via `fingerprint`. If
// our hash differs from its on-disk hash, it pushes `reload_self`, which
// calls chrome.runtime.reload() — reading the new code from the unpacked
// extension folder. Net effect: no manual chrome://extensions reload
// after the initial install.

let cachedBuildHash = null;

async function computeBuildHash() {
  if (cachedBuildHash) return cachedBuildHash;
  const files = ["background.js", "spatial-snapshot.js", "offscreen.js", "manifest.json"];
  const decoder = new TextDecoder();
  let combined = "";
  for (const f of files) {
    try {
      const resp = await fetch(chrome.runtime.getURL(f));
      const buf = await resp.arrayBuffer();
      combined += decoder.decode(buf);
    } catch (_) { /* missing file — skip */ }
  }
  const data = new TextEncoder().encode(combined);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  cachedBuildHash = hex.slice(0, 16); // matches daemon's slice(0, 16)
  return cachedBuildHash;
}

// ─── Offscreen Document ──────────────────────────────────────────

async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Maintain persistent WebSocket connection to NeoVision daemon'
    });
  } catch (err) {
    console.error('[NeoVision] Failed to create offscreen document:', err);
  }
}

async function syncStateFromOffscreen() {
  try {
    if (!(await chrome.offscreen.hasDocument())) return;
    chrome.runtime.sendMessage(
      { type: 'offscreen_cmd', cmd: 'get_status' },
      (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        connected = resp.connected;
        if (resp.port) currentPort = resp.port;
        updateBadge(connected ? 'ON' : 'OFF', connected ? '#22c55e' : '#ef4444');
      }
    );
  } catch (_) {}
}

// ─── Badge ───────────────────────────────────────────────────────

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ─── Tab Management ──────────────────────────────────────────────

// Tab management:
//   - One managed tab, lives in a dedicated unfocused Chrome window.
//   - Across SW reloads, we adopt any existing NeoVision-grouped tab and
//     close orphan duplicates. If a NeoVision tab is found in a non-managed
//     window, we keep it where it is (don't disturb the user further).
//   - When creating a fresh tab we use a new unfocused window so navigation
//     never interrupts the user's primary Chrome window — including
//     fullscreen video.
//
// Safety invariant: managedTabId is ONLY set after a chrome.tabs.get verifies
// the tab actually exists. Every code path that returns a tabId either
// returned a verified id or threw. The navigate handler refuses to call
// chrome.tabs.update with anything other than a finite number, so even a
// bug here can't hijack the user's active tab.
const TAB_GROUP_TITLE = 'NeoVision';
const NEOVISION_WINDOW_FLAG = 'neovision-managed';   // marker used in window titles (not directly settable; we use tab grouping instead)
// Use a non-default window position so the user can spot/close the helper window.
const NEOVISION_WINDOW_GEOM = { width: 1280, height: 800, left: 80, top: 80 };

// Verify a tabId actually exists and return the Tab object, or null.
async function verifyTab(tabId) {
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return null;
  try { return await chrome.tabs.get(tabId); }
  catch { return null; }
}

// Create a fresh background window for the NeoVision managed tab. Polls until
// the window has at least one tab so we never operate on undefined tabIds.
//
// Window state: we tried `focused: false` with `type: 'normal'` — Chrome on
// macOS auto-merges background windows into the user's focused window within
// ~14ms (saw it in logs). Using `state: 'minimized'` instead — the window is
// created off-screen as minimized and won't get folded into the main window.
async function createDedicatedWindow() {
  const win = await chrome.windows.create({
    url: 'about:blank',
    type: 'normal',
    state: 'minimized',
  });
  if (!win || typeof win.id !== 'number') {
    throw new Error('windows.create returned no window');
  }
  managedWindowId = win.id;

  // Poll for tabs in the new window. chrome.windows.create's win.tabs is
  // sometimes empty in the immediate Promise resolution; query directly.
  let tabId = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const tabs = await chrome.tabs.query({ windowId: managedWindowId }).catch(() => []);
    if (tabs && tabs.length && typeof tabs[0].id === 'number') {
      tabId = tabs[0].id; break;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  if (tabId === null) {
    // Fallback: create the tab explicitly in our window.
    const t = await chrome.tabs.create({ windowId: managedWindowId, url: 'about:blank', active: false });
    if (typeof t?.id !== 'number') throw new Error('tabs.create after windows.create still returned no id');
    tabId = t.id;
  }

  // Verify before assigning to managedTabId.
  const verified = await verifyTab(tabId);
  if (!verified) throw new Error(`new tab ${tabId} could not be verified`);
  return verified.id;
}

async function getOrCreateTab() {
  // 1. Already-known managed tab still alive?
  if (managedTabId) {
    const verified = await verifyTab(managedTabId);
    if (verified) return managedTabId;
    managedTabId = null;
  }

  // 2. Adopt an existing NeoVision-grouped tab from a previous lifetime,
  //    closing any duplicates. Wrapped: if anything fails we fall through.
  try {
    const groups = await chrome.tabGroups.query({ title: TAB_GROUP_TITLE });
    let adopted = null;
    const orphans = [];
    for (const g of groups) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      for (const t of tabs) {
        if (adopted === null) adopted = t.id;
        else orphans.push(t.id);
      }
    }
    if (adopted) {
      const verified = await verifyTab(adopted);
      if (verified) {
        const adoptedId = verified.id;
        managedTabId = adoptedId;
        managedWindowId = verified.windowId;   // stays in whichever window the user already had it
        neoLog('info', 'adopted existing NeoVision tab', { tabId: adoptedId, windowId: managedWindowId, orphansClosed: orphans.length });
        if (orphans.length) {
          await chrome.tabs.remove(orphans).catch(e => neoLog('warn', 'orphan cleanup failed', e?.message));
        }
        return adoptedId;   // return the local var, not module state — listeners might null managedTabId asynchronously
      }
    }
  } catch (e) {
    neoLog('warn', 'adoption scan failed (non-fatal)', e?.message);
  }

  // 3. No existing tab — create a fresh dedicated window with a tab inside.
  let tabId;
  try {
    tabId = await createDedicatedWindow();
  } catch (e) {
    neoLog('error', 'createDedicatedWindow failed — refusing to fall back to active window', e?.message);
    throw e;   // navigate handler's hard guard will reject undefined tabId, so we never hijack
  }

  managedTabId = tabId;
  neoLog('info', 'created fresh managed tab in dedicated window', { tabId, windowId: managedWindowId });

  // Group it under the NeoVision label for adoption next time.
  try {
    tabGroupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(tabGroupId, {
      title: TAB_GROUP_TITLE,
      color: 'green',
      collapsed: false,
    });
  } catch (e) {
    neoLog('warn', 'could not create tab group (non-fatal)', e?.message);
  }
  return tabId;   // return the local var, not module state — listeners might null managedTabId asynchronously
}

// ─── Command Handler ─────────────────────────────────────────────

async function handleCommand(msg) {
  const { command, params } = msg;

  switch (command) {

    // ── Navigate to URL ──
    case 'navigate': {
      const tabId = params.tabId || await getOrCreateTab();
      // CRITICAL GUARD: chrome.tabs.update(undefined, ...) defaults to the
      // user's currently-active tab — which means we can navigate whatever
      // they're watching/reading right now. If we don't have a valid tabId,
      // refuse to proceed instead of clobbering their active tab.
      if (typeof tabId !== 'number' || !Number.isFinite(tabId)) {
        const err = new Error('refused_navigate_undefined_tab: no managed tab; would have hijacked user active tab');
        neoLog('error', err.message, { params, managedTabId, managedWindowId });
        throw err;
      }
      // Clear stale console buffer for this tab — caller is starting a new
      // navigation, old logs aren't relevant to the new page.
      consoleBuffers.delete(tabId);
      // Explicitly do NOT activate the tab — keeps the user's focus where it is.
      await chrome.tabs.update(tabId, { url: params.url, active: false });
      await waitForTabLoad(tabId, params.timeout || 30000);
      // Re-inject console capture after the new page is loaded.
      injectConsoleCapture(tabId);
      const tab = await chrome.tabs.get(tabId);
      return {
        success: true,
        url: tab.url,
        title: tab.title
      };
    }

    // ── Query DOM elements ──
    case 'query_dom': {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector, attributes, limit, filter) => {
          let elements = Array.from(document.querySelectorAll(selector));
          if (filter && filter.attr && filter.contains) {
            elements = elements.filter(el => {
              const val = filter.attr === 'textContent' ? el.textContent : el.getAttribute(filter.attr);
              return val && val.includes(filter.contains);
            });
          }
          return elements.slice(0, limit).map(el => {
            const obj = {};
            for (const attr of attributes) {
              if (attr === 'textContent') obj[attr] = (el.textContent || '').trim().substring(0, 200);
              else if (attr === 'innerText') obj[attr] = (el.innerText || '').trim().substring(0, 200);
              else if (attr === 'innerHTML') obj[attr] = (el.innerHTML || '').substring(0, 500);
              else if (attr === 'tagName') obj[attr] = el.tagName.toLowerCase();
              else obj[attr] = el.getAttribute(attr);
            }
            return obj;
          });
        },
        args: [params.selector, params.attributes || ['textContent'], params.limit || 100, params.filter || null],
        world: 'ISOLATED'
      });
      return { success: true, elements: results[0]?.result ?? [] };
    }

    // ── Extract LD+JSON structured data ──
    case 'query_ldjson': {
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
        world: 'ISOLATED'
      });
      return { success: true, data: results[0]?.result ?? [] };
    }

    // ── Click first element matching selector ──
    case 'click_selector': {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => {
          const el = document.querySelector(selector);
          if (!el) return { found: false };
          el.click();
          return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80) };
        },
        args: [params.selector],
        world: 'ISOLATED'
      });
      return { success: true, result: results[0]?.result ?? { found: false } };
    }

    // ── Count elements matching selector ──
    case 'query_count': {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => document.querySelectorAll(selector).length,
        args: [params.selector],
        world: 'ISOLATED'
      });
      return { success: true, count: results[0]?.result ?? 0 };
    }

    // ── Execute JavaScript ──
    //
    // Two execution worlds, selected by `params.world`:
    //
    //   'isolated' (default) — runs in the extension's content-script context.
    //     PRO: bypasses the page's CSP entirely (content scripts have no CSP
    //     applied). Eval / Function work freely. This is the only path that
    //     works on x.com, GitHub, banks, and any site with a strict
    //     script-src directive.
    //     CON: cannot read page-defined window globals (e.g., the page's
    //     React state object, custom globals set by site JS). DOM is fully
    //     accessible — querySelector, getBoundingClientRect, etc. all work.
    //     For most automation use cases, this is what you want.
    //
    //   'main' — runs in the page's main world via a <script> tag injection.
    //     PRO: full access to page-defined window globals.
    //     CON: silently fails on CSP-strict sites because the injected
    //     <script>'s textContent is evaluated as inline script and gets
    //     blocked by `script-src` directives lacking 'unsafe-inline'.
    //     Use only when you genuinely need page-world variable access AND
    //     the target site has a permissive CSP.
    case 'execute_js': {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const world = (params.world || 'isolated').toLowerCase();

      if (world === 'main') {
        // MAIN-world via script-tag injection (legacy, CSP-fragile).
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (codeStr) => {
            const id = '__nv_' + Math.random().toString(36).slice(2);
            const script = document.createElement('script');
            script.textContent = "window['" + id + "']=" + codeStr + ';';
            document.documentElement.appendChild(script);
            script.remove();
            const result = window[id];
            delete window[id];
            return result;
          },
          args: [params.code],
          world: 'MAIN'
        });
        return { success: true, world: 'main', result: results[0]?.result ?? null };
      }

      // ISOLATED-world via Function() — no CSP, no page-world variable access.
      // The Function constructor is allowed in content-script contexts because
      // they do not enforce the page's CSP and do not have an extension CSP
      // applied (extension CSP only governs extension pages, not content scripts).
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (codeStr) => {
          try {
            // Wrap in `return ${codeStr}` semantics — match what the MAIN-world
            // path does (the user's expression is the return value).
            return Function('"use strict"; return (' + codeStr + ');')();
          } catch (e) {
            return { __nv_error: String(e && e.message || e) };
          }
        },
        args: [params.code],
        world: 'ISOLATED'
      });
      const result = results[0]?.result;
      if (result && typeof result === 'object' && result.__nv_error) {
        return { success: false, world: 'isolated', error: result.__nv_error };
      }
      return { success: true, world: 'isolated', result: result ?? null };
    }

    // ── Inject NeoVision spatial snapshot (CSP-safe two-call pattern) ──
    //
    // Old pattern injected the snapshot source as a <script> textContent,
    // which is killed silently by strict script-src directives (x.com, etc).
    // New pattern uses chrome.scripting.executeScript with `files:` to install
    // a bundled extension script into MAIN world (bypasses page CSP because
    // it's extension-loaded), then a second executeScript with `func:` to
    // invoke the installed function and capture its return value.
    //
    // The `params.injectable_source` field is now ignored — we always use
    // the bundled extension/spatial-snapshot.js. Snapshot options are passed
    // as structured args to the second call.
    case 'inject_spatial': {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const opts = params.snapshot_options || {};

      // Step 1: install window.__neoVisionSnapshot from bundled file (CSP-safe).
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['spatial-snapshot.js'],
        world: 'MAIN'
      });

      // Step 2: invoke the installed function. The `func` body has no inline
      // script tag and no eval — just a static call to the installed global.
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (snapshotOpts) => {
          if (typeof window.__neoVisionSnapshot !== 'function') {
            return { __nv_error: 'snapshot function not installed' };
          }
          try {
            return window.__neoVisionSnapshot(snapshotOpts);
          } catch (e) {
            return { __nv_error: String(e && e.message || e) };
          }
        },
        args: [opts],
        world: 'MAIN'
      });

      const result = results[0]?.result;
      if (result && result.__nv_error) {
        return { success: false, error: result.__nv_error };
      }
      return { success: true, spatial_map: result ?? null };
    }

    // ── Window geometry (for OS-level input coordinate translation) ──
    //
    // Returns everything needed to convert a page CSS coordinate into a
    // screen pixel coordinate for cliclick / OS-level input dispatch:
    //   - window.left/top: Chrome window position on screen
    //   - chromeOffsetY: height of tabs+address bar inside the window
    //   - innerWidth/innerHeight: page viewport size
    //   - devicePixelRatio: for HiDPI/Retina displays
    //   - scrollX/scrollY: current page scroll offset
    //
    // All values are read via Chrome extension APIs + a cheap MAIN-world
    // call for window.devicePixelRatio (which is the only value not
    // available from chrome.windows.get / chrome.tabs.get).
    case 'get_window_geometry': {
      const tabId = params.tabId || managedTabId;
      if (!tabId) return { success: false, error: 'No active tab' };

      const tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId);

      // One MAIN-world call for the page-side values. This is a static
      // func with no dynamic code, so it's CSP-safe on every site.
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          scrollX: window.scrollX || 0,
          scrollY: window.scrollY || 0,
          screenX: window.screenX,
          screenY: window.screenY,
        }),
        world: 'MAIN'
      });
      const page = results[0]?.result || {};

      // chromeOffsetY = vertical pixels between window top edge and the
      // start of the page viewport (tabs + address bar + bookmarks bar).
      const chromeOffsetY = (win.height && page.innerHeight)
        ? Math.max(0, win.height - page.innerHeight)
        : 0;
      const chromeOffsetX = (win.width && page.innerWidth)
        ? Math.max(0, Math.floor((win.width - page.innerWidth) / 2))
        : 0;

      return {
        success: true,
        window: {
          left: win.left ?? page.screenX ?? 0,
          top: win.top ?? page.screenY ?? 0,
          width: win.width ?? page.outerWidth ?? 0,
          height: win.height ?? page.outerHeight ?? 0,
          state: win.state,
          focused: win.focused,
        },
        viewport: {
          width: page.innerWidth ?? 0,
          height: page.innerHeight ?? 0,
        },
        chrome_offset: { x: chromeOffsetX, y: chromeOffsetY },
        scroll: { x: page.scrollX ?? 0, y: page.scrollY ?? 0 },
        device_pixel_ratio: page.devicePixelRatio ?? 1,
      };
    }

    // ── Click at coordinates ──
    case 'click': {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const { x, y, button = 'left' } = params;
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y, button) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return { success: false, error: 'No element at coordinates' };

          // Fire full event chain on the element
          const fireEvents = (target) => {
            const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
            for (const eventType of events) {
              const evt = new MouseEvent(eventType, {
                clientX: x, clientY: y,
                button: button === 'right' ? 2 : 0,
                bubbles: true, cancelable: true, view: window
              });
              target.dispatchEvent(evt);
            }
          };

          fireEvents(el);

          // For React apps (X, Facebook, etc.): also try .click() on the
          // nearest button/anchor/[role=button] ancestor if the direct
          // dispatch didn't trigger React's synthetic handler.
          let reactTarget = el;
          while (reactTarget && reactTarget !== document.body) {
            if (reactTarget.tagName === 'BUTTON' || reactTarget.tagName === 'A' ||
                reactTarget.getAttribute('role') === 'button' ||
                reactTarget.dataset?.testid) {
              if (reactTarget !== el) {
                reactTarget.click();  // Native .click() often works better for React
              }
              break;
            }
            reactTarget = reactTarget.parentElement;
          }

          return {
            success: true,
            element: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().substring(0, 80)
          };
        },
        args: [x, y, button],
        world: 'MAIN'
      });
      return results[0]?.result ?? { success: false, error: 'Script failed' };
    }

    // ── Type text (focus element at coords first) ──
    case 'type': {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const { x, y, text, clearFirst = false } = params;
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y, text, clearFirst) => {
          let el = document.elementFromPoint(x, y);
          if (!el) return { success: false, error: 'No element at coordinates' };

          // Walk up to find the actual editable element.
          // X.com, Slack, Notion, etc. use nested divs inside a contenteditable.
          // elementFromPoint may return a child span/div that isn't editable itself.
          let editable = el;
          let found = false;

          // Check if the element or any ancestor is contenteditable
          let walk = el;
          while (walk && walk !== document.body) {
            if (walk.isContentEditable || walk.contentEditable === 'true') {
              editable = walk;
              found = true;
              break;
            }
            if (walk.tagName === 'INPUT' || walk.tagName === 'TEXTAREA') {
              editable = walk;
              found = true;
              break;
            }
            walk = walk.parentElement;
          }

          // Also check data-testid for X.com's compose box specifically
          if (!found) {
            const xCompose = document.querySelector('[data-testid="tweetTextarea_0"], [data-testid="tweetTextarea_0_label"], [role="textbox"][contenteditable="true"]');
            if (xCompose) {
              editable = xCompose;
              found = true;
            }
          }

          editable.focus();

          // Small delay to let focus register on React apps
          return new Promise(resolve => setTimeout(() => {
            if (editable.tagName === 'INPUT' || editable.tagName === 'TEXTAREA') {
              if (clearFirst) {
                editable.value = '';
                editable.dispatchEvent(new Event('input', { bubbles: true }));
              }
              editable.value = (clearFirst ? '' : editable.value) + text;
              editable.dispatchEvent(new Event('input', { bubbles: true }));
              editable.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (editable.isContentEditable || editable.contentEditable === 'true') {
              // Contenteditable: use execCommand for React/X.com compat
              if (clearFirst) {
                editable.textContent = '';
                editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
              }
              // Focus and place cursor at end
              const range = document.createRange();
              const sel = window.getSelection();
              range.selectNodeContents(editable);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);

              // Insert text via execCommand (triggers React's onChange)
              document.execCommand('insertText', false, text);
            } else {
              // Fallback: try execCommand anyway
              document.execCommand('insertText', false, text);
            }

            resolve({
              success: true,
              element: editable.tagName.toLowerCase(),
              contentEditable: editable.isContentEditable || false,
              method: editable.isContentEditable ? 'execCommand' : 'value',
            });
          }, 100));
        },
        args: [x, y, text, clearFirst],
        world: 'MAIN'
      });
      return results[0]?.result ?? { success: false, error: 'Script failed' };
    }

    // ── Scroll ──
    case 'scroll': {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const { x = 640, y = 360, deltaX = 0, deltaY = 0 } = params;
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y, dx, dy) => {
          const el = document.elementFromPoint(x, y) || document.documentElement;
          el.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
        },
        args: [x, y, deltaX, deltaY],
        world: 'MAIN'
      });
      return { success: true };
    }

    // ── Get page info ──
    case 'get_page_info': {
      const tabId = params.tabId || managedTabId;
      if (!tabId) return { success: false, error: 'No active tab' };
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
    case 'get_page_text': {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const article = document.querySelector('article') || document.querySelector('main') || document.body;
          return article ? article.innerText.substring(0, 50000) : '';
        },
        world: 'MAIN'
      });
      return { success: true, text: results[0]?.result ?? '' };
    }

    // ── Wait ──
    case 'wait': {
      const ms = (params.seconds || 3) * 1000;
      await new Promise(r => setTimeout(r, ms));
      return { success: true, waited: params.seconds };
    }

    // ── Screenshot (capture visible tab) ──
    case 'screenshot': {
      const tabId = params.tabId || managedTabId;
      if (!tabId) return { success: false, error: 'No active tab' };
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(r => setTimeout(r, 200));
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      return {
        success: true,
        screenshot: dataUrl,
        format: 'png',
        encoding: 'base64-dataurl'
      };
    }

    // ── List tabs the extension considers managed ──
    // Queries by tab-group title rather than the cached tabGroupId, which
    // becomes stale across SW reloads. Returns every tab in any group titled
    // "NeoVision", plus managedTabId if it exists outside a group.
    case 'list_tabs': {
      const tabs = [];
      try {
        const groups = await chrome.tabGroups.query({ title: TAB_GROUP_TITLE });
        const seen = new Set();
        for (const g of groups) {
          const groupTabs = await chrome.tabs.query({ groupId: g.id });
          for (const t of groupTabs) {
            if (seen.has(t.id)) continue;
            seen.add(t.id);
            tabs.push({
              tabId: t.id, id: t.id,   // both keys for compat with old clients
              windowId: t.windowId, url: t.url, title: t.title,
              active: t.active, status: t.status, groupId: t.groupId,
            });
          }
        }
        if (managedTabId && !seen.has(managedTabId)) {
          const t = await chrome.tabs.get(managedTabId).catch(() => null);
          if (t) tabs.push({
            tabId: t.id, id: t.id, windowId: t.windowId,
            url: t.url, title: t.title, active: t.active, status: t.status, groupId: t.groupId,
          });
        }
      } catch (e) {
        neoLog('warn', 'list_tabs failed', e?.message);
      }
      return { success: true, tabs, managedTabId, managedWindowId };
    }

    // ── List ALL open tabs (regardless of group) ──
    case 'list_all_tabs': {
      const tabs = await chrome.tabs.query({});
      return {
        success: true,
        tabs: tabs.map(t => ({ id: t.id, tabId: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
      };
    }

    // ── Ping (health check) ──
    case 'ping': {
      return { success: true, pong: true, timestamp: Date.now() };
    }

    // ── Read recent console messages from a tab ──
    // Returns the buffered console.* and uncaught error events captured by
    // the main-world wrapper. tabId optional — defaults to managedTabId.
    // Pass {clear: true} to drop the buffer after reading.
    case 'read_console_messages': {
      const tid = (params && typeof params.tabId === 'number') ? params.tabId : managedTabId;
      if (typeof tid !== 'number') {
        return { success: true, tabId: null, messages: [], note: 'no tabId given and no managedTabId set' };
      }
      const buf = consoleBuffers.get(tid) || [];
      const limit = (params && typeof params.limit === 'number') ? params.limit : buf.length;
      const messages = buf.slice(-limit);
      if (params && params.clear) consoleBuffers.delete(tid);
      return { success: true, tabId: tid, messages, total_buffered: buf.length };
    }

    // ── Read recent network requests from a tab ──
    // Returns the buffered request lifecycle entries captured via
    // chrome.webRequest. tabId optional — defaults to managedTabId. Optional
    // {limit, clear, urlPattern, errorsOnly} filters.
    case 'read_network_requests': {
      const tid = (params && typeof params.tabId === 'number') ? params.tabId : managedTabId;
      if (typeof tid !== 'number') {
        return { success: true, tabId: null, requests: [], note: 'no tabId given and no managedTabId set' };
      }
      let buf = networkBuffers.get(tid) || [];
      if (params && params.urlPattern) {
        const pat = String(params.urlPattern).toLowerCase();
        buf = buf.filter(e => (e.url || '').toLowerCase().includes(pat));
      }
      if (params && params.errorsOnly) {
        buf = buf.filter(e => e.error || (e.statusCode && e.statusCode >= 400));
      }
      const limit = (params && typeof params.limit === 'number') ? params.limit : buf.length;
      const requests = buf.slice(-limit);
      if (params && params.clear) networkBuffers.delete(tid);
      return { success: true, tabId: tid, requests, total_buffered: (networkBuffers.get(tid) || []).length };
    }

    // ── Tab pool: spawn a new tab in the dedicated window ──
    // Ensures the dedicated window exists, creates a tab inside it, adds it
    // to the existing NeoVision group (or creates one if none exists in
    // that window), and returns the new tabId.
    case 'spawn_tab': {
      // Bootstrap the dedicated window if we don't have one yet.
      if (!managedWindowId || !(await chrome.windows.get(managedWindowId).catch(() => null))) {
        await getOrCreateTab();   // creates the first tab + window as a side-effect
      }
      const url = (params && params.url) || 'about:blank';
      let tab;
      try {
        tab = await chrome.tabs.create({ windowId: managedWindowId, url, active: false });
      } catch (e) {
        neoLog('error', 'spawn_tab tabs.create failed', e?.message);
        throw e;
      }
      if (typeof tab?.id !== 'number') {
        throw new Error('spawn_tab: tabs.create returned no id');
      }
      // Add to the existing NeoVision group in this window if one exists,
      // otherwise create a new group titled NeoVision.
      try {
        let existingGroupId = null;
        try {
          const existingGroups = await chrome.tabGroups.query({
            title: TAB_GROUP_TITLE,
            windowId: managedWindowId,
          });
          if (existingGroups && existingGroups.length) existingGroupId = existingGroups[0].id;
        } catch {}
        const groupOpts = existingGroupId !== null
          ? { tabIds: [tab.id], groupId: existingGroupId }
          : { tabIds: [tab.id] };
        const groupId = await chrome.tabs.group(groupOpts);
        if (existingGroupId === null) {
          await chrome.tabGroups.update(groupId, {
            title: TAB_GROUP_TITLE, color: 'green', collapsed: false,
          });
        }
      } catch (e) {
        neoLog('warn', 'spawn_tab grouping failed (non-fatal)', e?.message);
      }
      neoLog('info', 'spawned tab in dedicated window', { tabId: tab.id, windowId: managedWindowId, url });
      return { success: true, tabId: tab.id, windowId: managedWindowId, url: tab.url };
    }

    // ── Tab pool: close a managed tab ──
    // Only closes tabs that are in the NeoVision group or equal managedTabId.
    // Refuses to close arbitrary user tabs as a safety measure.
    case 'close_tab': {
      const targetId = params && typeof params.tabId === 'number' ? params.tabId : null;
      if (targetId === null) return { success: false, error: 'close_tab: tabId required' };
      // Verify the tab is one of ours.
      let isOurs = false;
      try {
        const t = await chrome.tabs.get(targetId);
        if (t && (t.id === managedTabId)) isOurs = true;
        if (!isOurs && typeof t?.groupId === 'number' && t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
          const g = await chrome.tabGroups.get(t.groupId).catch(() => null);
          if (g && g.title === TAB_GROUP_TITLE) isOurs = true;
        }
      } catch (e) {
        return { success: false, error: `close_tab: tab ${targetId} not found` };
      }
      if (!isOurs) {
        return { success: false, error: `close_tab: tab ${targetId} is not a NeoVision tab; refusing to close` };
      }
      try { await chrome.tabs.remove(targetId); }
      catch (e) {
        neoLog('warn', 'close_tab remove failed', e?.message);
        return { success: false, error: e?.message };
      }
      neoLog('info', 'closed managed tab', { tabId: targetId });
      // If we closed the primary managedTabId, clear it so the next command recreates one.
      if (targetId === managedTabId) managedTabId = null;
      return { success: true, closed: targetId };
    }

    // ── Self-reload (auto-update on code change) ──
    //
    // The daemon sends this when it detects that the extension files on disk
    // have changed since the running extension was loaded. chrome.runtime.reload()
    // forces Chrome to re-read the unpacked extension from /load-extension/ path,
    // picking up the new code without manual intervention.
    //
    // After reload, Chrome restarts the extension's service worker; selfHeal()
    // runs on the fresh code and reconnects to the daemon.
    case 'reload_self': {
      console.log('[NeoVision] Daemon requested reload_self — reloading extension');
      // Defer slightly so we can ack the daemon before tearing ourselves down.
      setTimeout(() => chrome.runtime.reload(), 100);
      return { success: true, reloading: true };
    }

    // ── Code fingerprint (lets daemon verify which version is running) ──
    case 'fingerprint': {
      // Hash matches the daemon's computeExtensionHash() — first 16 hex
      // chars of SHA-256 over background.js + spatial-snapshot.js +
      // offscreen.js + manifest.json. Mismatch → daemon pushes reload_self.
      const build = await computeBuildHash();
      return { success: true, build };
    }

    default:
      return { success: false, error: `Unknown command: ${command}` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ─── Message Handler ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Console capture forwarded from content.js (main-world wraps console,
  // postMessage to content.js, content.js forwards here). Stored in a
  // per-tab ring buffer; read_console_messages command returns it.
  if (msg.type === 'neo_console_log' && sender.tab) {
    pushConsoleEntry(sender.tab.id, {
      level: msg.level || 'log',
      args: msg.args || [],
      ts: msg.ts || Date.now(),
      url: msg.url || sender.tab.url,
    });
    return false;
  }

  // Command from daemon, forwarded by offscreen.js — execute and respond
  if (msg.type === 'ws_command') {
    const daemonMsg = msg.msg;
    handleCommand(daemonMsg)
      .then(result => {
        sendResponse(daemonMsg.id
          ? { id: daemonMsg.id, type: 'result', result }
          : null);
      })
      .catch(err => {
        sendResponse(daemonMsg.id
          ? { id: daemonMsg.id, type: 'error', error: err.message }
          : null);
      });
    return true; // keep channel open for async response
  }

  // Connection state change from offscreen.js — update badge and cached state
  if (msg.type === 'ws_state') {
    connected = msg.connected;
    if (msg.port) currentPort = msg.port;
    updateBadge(connected ? 'ON' : 'OFF', connected ? '#22c55e' : '#ef4444');
    return false;
  }

  // Popup: manual connect — relay to offscreen
  if (msg.type === 'connect') {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage(
        { type: 'offscreen_cmd', cmd: 'connect', wsUrl: msg.wsUrl },
        () => { if (chrome.runtime.lastError) {} }
      );
    });
    sendResponse({ status: 'connecting' });
    return true;
  }

  // Popup: manual disconnect — relay to offscreen
  if (msg.type === 'disconnect') {
    chrome.runtime.sendMessage(
      { type: 'offscreen_cmd', cmd: 'disconnect' },
      () => { if (chrome.runtime.lastError) {} }
    );
    connected = false;
    updateBadge('OFF', '#ef4444');
    sendResponse({ status: 'disconnected' });
    return true;
  }

  // Popup: status query — return cached state
  if (msg.type === 'status') {
    sendResponse({ connected, port: currentPort, managedTabId, tabGroupId });
    return true;
  }
});

// ─── Lifecycle / Self-healing ────────────────────────────────────
//
// MV3 service workers get killed every ~30s of idle. When they die, the
// offscreen document holding the WebSocket can be GC'd too. The alarm
// below is the standard MV3 "keep-alive" trick: schedule a chrome.alarms
// tick faster than the kill timer to prevent recycling, and use each tick
// to verify both the offscreen document AND the WebSocket connection.
// If either has died, we recreate / reconnect.
//
// 0.4 minutes = 24s. Below the ~30s idle kill threshold.
chrome.alarms.create('neovision-keepalive', { periodInMinutes: 0.4 });

// Track when the user closes the neovision window so we recreate cleanly
// instead of leaking a stale managedWindowId.
chrome.windows.onRemoved.addListener((winId) => {
  if (winId === managedWindowId) {
    neoLog('info', 'managed window removed', { winId });
    managedWindowId = null;
    managedTabId = null;
    tabGroupId = null;
  }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (tabId === managedTabId && !removeInfo.isWindowClosing) {
    neoLog('info', 'managed tab removed (window not closing)', { tabId, removeInfo });
    managedTabId = null;
    tabGroupId = null;
  }
  // Always free the console buffer for closed tabs so we don't leak memory.
  consoleBuffers.delete(tabId);
});

// Auto-inject console capture on every page-load complete. This catches
// pages the user navigated to manually (not via /api/navigate) and pages
// that reload themselves. Idempotent — console-capture.js short-circuits
// if already injected.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !/^https?:\/\//.test(tab.url)) return;
  // Clear console buffer when URL changed (covers SPA route changes too,
  // since browser tells us status: complete on the new URL).
  if (changeInfo.url) consoleBuffers.delete(tabId);
  injectConsoleCapture(tabId);
});

/**
 * Ask the offscreen document whether it's still connected to the daemon.
 * Returns false if no offscreen exists, no response, or socket dead.
 */
function checkOffscreenConnected() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'offscreen_cmd', cmd: 'get_status' },
      (resp) => {
        if (chrome.runtime.lastError || !resp) return resolve(false);
        resolve(!!resp.connected);
      }
    );
    // Safety net: if no response within 1s, treat as not connected.
    setTimeout(() => resolve(false), 1000);
  });
}

/**
 * Self-heal: ensure offscreen exists AND its WebSocket is connected.
 * If the WS is dead, send it a connect command to reinitiate.
 */
async function selfHeal() {
  try {
    await ensureOffscreen();
    const isConnected = await checkOffscreenConnected();
    if (!isConnected) {
      // Tell the offscreen document to reconnect. The offscreen handler
      // already does port-scanning + retries internally, so this just
      // kicks it if it's idle.
      chrome.runtime.sendMessage(
        { type: 'offscreen_cmd', cmd: 'connect' },
        () => { if (chrome.runtime.lastError) {} }
      );
    }
    syncStateFromOffscreen();
  } catch (err) {
    console.error('[NeoVision] selfHeal error:', err);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'neovision-keepalive') {
    selfHeal();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  neoLog('info', 'extension installed/updated');
  selfHeal();
});

chrome.runtime.onStartup.addListener(() => {
  selfHeal();
});

// Startup: ensure everything is wired and connected.
selfHeal();
