/**
 * NeoVision Bridge — Chrome Extension Background Service Worker
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
let tabGroupId = null;

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

async function getOrCreateTab() {
  if (managedTabId) {
    try {
      const tab = await chrome.tabs.get(managedTabId);
      if (tab) return managedTabId;
    } catch (_) {
      managedTabId = null;
    }
  }

  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  managedTabId = tab.id;

  try {
    tabGroupId = await chrome.tabs.group({ tabIds: [managedTabId] });
    await chrome.tabGroups.update(tabGroupId, {
      title: 'NeoVision',
      color: 'green',
      collapsed: false
    });
  } catch (e) {
    console.warn('[NeoVision] Could not create tab group:', e);
  }

  return managedTabId;
}

// ─── Command Handler ─────────────────────────────────────────────

async function handleCommand(msg) {
  const { command, params } = msg;

  switch (command) {

    // ── Navigate to URL ──
    case 'navigate': {
      const tabId = params.tabId || await getOrCreateTab();
      await chrome.tabs.update(tabId, { url: params.url });
      await waitForTabLoad(tabId, params.timeout || 30000);
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

    // ── Execute JavaScript (legacy — uses script tag injection for MAIN world) ──
    case 'execute_js': {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
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
      return { success: true, result: results[0]?.result ?? null };
    }

    // ── Inject NeoVision spatial snapshot ──
    case 'inject_spatial': {
      const tabId = params.tabId || managedTabId || await getOrCreateTab();
      const code = params.injectable_source;
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
        args: [code],
        world: 'MAIN'
      });
      return { success: true, spatial_map: results[0]?.result ?? null };
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

    // ── List tabs in our group ──
    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      const ourTabs = tabGroupId
        ? tabs.filter(t => t.groupId === tabGroupId)
        : (managedTabId ? tabs.filter(t => t.id === managedTabId) : []);
      return {
        success: true,
        tabs: ourTabs.map(t => ({ id: t.id, url: t.url, title: t.title }))
      };
    }

    // ── List ALL open tabs ──
    case 'list_all_tabs': {
      const tabs = await chrome.tabs.query({});
      return {
        success: true,
        tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
      };
    }

    // ── Create new tab ──
    case 'create_tab': {
      const tab = await chrome.tabs.create({ url: params.url || 'about:blank', active: false });
      if (tabGroupId) {
        await chrome.tabs.group({ tabIds: [tab.id], groupId: tabGroupId });
      }
      return { success: true, tabId: tab.id, url: tab.url };
    }

    // ── Close tab ──
    case 'close_tab': {
      await chrome.tabs.remove(params.tabId);
      if (params.tabId === managedTabId) managedTabId = null;
      return { success: true };
    }

    // ── Ping (health check) ──
    case 'ping': {
      return { success: true, pong: true, timestamp: Date.now() };
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

// ─── Lifecycle ───────────────────────────────────────────────────

// Alarm: ensure the offscreen document exists every ~24s.
// Recreates it if Chrome garbage-collected it while the service worker was sleeping.
chrome.alarms.create('neovision-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'neovision-keepalive') {
    ensureOffscreen();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[NeoVision] Extension installed');
  ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen().then(syncStateFromOffscreen);
});

// Startup: create offscreen document and sync connection state
ensureOffscreen().then(syncStateFromOffscreen);
