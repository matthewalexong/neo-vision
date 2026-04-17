/**
 * NeoVision Bridge — Offscreen Document
 *
 * Holds the persistent WebSocket connection to the NeoVision daemon.
 * Lives outside the service worker so it survives MV3's 30s idle kill.
 *
 * Message flow:
 *   Daemon → WebSocket → offscreen.js → chrome.runtime.sendMessage → background.js
 *   background.js → sendResponse → offscreen.js → WebSocket → Daemon
 */

// ─── Config ──────────────────────────────────────────────────────
const BASE_PORT = 7665;
const MAX_PORT = 7674;
let ws = null;
let connected = false;
let reconnectTimer = null;
let currentPort = BASE_PORT;
let heartbeatInterval = null;

// ─── WebSocket Connection ────────────────────────────────────────

function connect(wsUrl) {
  if (ws && ws.readyState <= 1) return; // already open/connecting
  if (wsUrl) {
    connectToUrl(wsUrl);
  } else {
    connectWithPortScan(BASE_PORT);
  }
}

function connectWithPortScan(port) {
  if (connected) return;
  if (port > MAX_PORT) {
    console.log(`[NeoVision] No bridge found on ports ${BASE_PORT}-${MAX_PORT}. Retrying in 5s...`);
    notifyState(false, null);
    reconnectTimer = setTimeout(() => connectWithPortScan(BASE_PORT), 5000);
    return;
  }

  const url = `ws://localhost:${port}`;
  console.log(`[NeoVision] Trying ${url}...`);
  const testWs = new WebSocket(url);

  const portTimeout = setTimeout(() => {
    if (testWs.readyState !== 1) {
      testWs.close();
      connectWithPortScan(port + 1);
    }
  }, 2000);

  testWs.onopen = () => {
    clearTimeout(portTimeout);
    ws = testWs;
    connected = true;
    currentPort = port;
    clearTimeout(reconnectTimer);
    console.log(`[NeoVision] Connected to MCP bridge on port ${port}`);
    notifyState(true, port);
    attachWsHandlers(testWs);
    sendWs({ type: 'hello', agent: 'neovision-chrome-bridge', version: '0.2.0' });
    startHeartbeat();
  };

  testWs.onerror = () => {
    clearTimeout(portTimeout);
    testWs.close();
    connectWithPortScan(port + 1);
  };
}

function connectToUrl(wsUrl) {
  console.log(`[NeoVision] Connecting to ${wsUrl}...`);
  const newWs = new WebSocket(wsUrl);

  newWs.onopen = () => {
    ws = newWs;
    connected = true;
    clearTimeout(reconnectTimer);
    console.log('[NeoVision] Connected to MCP bridge');
    notifyState(true, currentPort);
    attachWsHandlers(newWs);
    sendWs({ type: 'hello', agent: 'neovision-chrome-bridge', version: '0.2.0' });
    startHeartbeat();
  };

  newWs.onerror = (err) => {
    console.error('[NeoVision] WebSocket error:', err);
    newWs.close();
  };

  newWs.onclose = () => {
    connected = false;
    ws = null;
    stopHeartbeat();
    console.log('[NeoVision] Disconnected. Scanning ports in 5s...');
    notifyState(false, null);
    reconnectTimer = setTimeout(() => connectWithPortScan(BASE_PORT), 5000);
  };
}

function attachWsHandlers(socket) {
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      console.error('[NeoVision] Bad JSON from daemon:', err);
      return;
    }

    // Forward command to background.js for execution via Chrome APIs.
    // background.js responds via sendResponse with the fully-formed WS reply.
    chrome.runtime.sendMessage({ type: 'ws_command', msg }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[NeoVision] Background error:', chrome.runtime.lastError.message);
        return;
      }
      if (response) {
        sendWs(response);
      }
    });
  };

  socket.onclose = () => {
    connected = false;
    ws = null;
    stopHeartbeat();
    console.log('[NeoVision] Disconnected. Scanning ports in 5s...');
    notifyState(false, null);
    reconnectTimer = setTimeout(() => connectWithPortScan(BASE_PORT), 5000);
  };

  socket.onerror = (err) => {
    console.error('[NeoVision] WebSocket error:', err);
    socket.close();
  };
}

function sendWs(data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

// ─── Heartbeat ───────────────────────────────────────────────────

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    sendWs({ type: 'heartbeat' });
  }, 15000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ─── Background Notifications ────────────────────────────────────

function notifyState(isConnected, port) {
  chrome.runtime.sendMessage(
    { type: 'ws_state', connected: isConnected, port },
    () => { if (chrome.runtime.lastError) {} }
  );
}

// ─── Message Listener (from background.js) ───────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'offscreen_cmd') return false;

  switch (msg.cmd) {
    case 'connect':
      connect(msg.wsUrl);
      break;

    case 'disconnect':
      if (ws) ws.close();
      ws = null;
      connected = false;
      clearTimeout(reconnectTimer);
      stopHeartbeat();
      notifyState(false, null);
      break;

    case 'get_status':
      sendResponse({ connected, port: currentPort });
      return true;
  }

  return false;
});

// ─── Start ───────────────────────────────────────────────────────

connect();
