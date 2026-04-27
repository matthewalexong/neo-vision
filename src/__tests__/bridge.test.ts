/**
 * ChromeBridge Tests — Red-Green TDD
 *
 * Tests cover connectivity reliability:
 * 1. Extension identification — hello handshake works
 * 2. Stale connection cleanup — unidentified connections closed after timeout
 * 3. Extension reconnection — new extension replaces old one cleanly
 * 4. Pending request rejection on disconnect
 * 5. Heartbeat / ping-pong — stale connections detected (RED — not yet implemented)
 * 6. Command send/receive round-trip
 * 7. Command timeout
 * 8. Port fallback — tries next port when default is busy
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChromeBridge } from "../bridge.js";
import WebSocket from "ws";

// Use high ports to avoid conflicts
let portCounter = 17665;
function nextPort() {
  return portCounter++;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Connect a fake extension to the bridge and send hello */
async function connectFakeExtension(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  // Send hello to identify as extension
  ws.send(JSON.stringify({
    type: "hello",
    agent: "neovision-chrome-bridge",
    version: "0.2.0-test",
  }));
  // Give bridge time to process hello
  await sleep(50);
  return ws;
}

/** Connect a fake extension that auto-responds to commands */
async function connectRespondingExtension(port: number): Promise<WebSocket> {
  const ws = await connectFakeExtension(port);
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.command) {
        // Auto-respond with success
        ws.send(JSON.stringify({
          id: msg.id,
          type: "result",
          result: { echo: msg.command, params: msg.params },
        }));
      }
    } catch {}
  });
  return ws;
}

describe("ChromeBridge", () => {
  let bridge: ChromeBridge;
  let port: number;
  let connections: WebSocket[] = [];

  beforeEach(async () => {
    port = nextPort();
    bridge = new ChromeBridge({ port });
    connections = [];
  });

  afterEach(async () => {
    // Close all test connections
    for (const ws of connections) {
      if (ws.readyState <= 1) ws.close();
    }
    await bridge.stop();
    await sleep(50);
  });

  function track(ws: WebSocket): WebSocket {
    connections.push(ws);
    return ws;
  }

  // ─── Extension Identification ──────────────────────────────────

  it("identifies extension via hello handshake", async () => {
    await bridge.start();
    expect(bridge.ready).toBe(false);

    const ext = track(await connectFakeExtension(port));
    expect(bridge.ready).toBe(true);

    const status = bridge.getStatus();
    expect(status.bridge).toBe(true);
    expect(status.extension).toBe(true);
  });

  it("does not mark non-hello connections as extension", async () => {
    await bridge.start();

    const ws = track(new WebSocket(`ws://localhost:${port}`));
    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Send a command instead of hello
    ws.send(JSON.stringify({ id: "test1", command: "ping" }));
    await sleep(50);

    // Bridge should not think extension is connected (no hello)
    // But it should identify this as an external client
    expect(bridge.ready).toBe(false);
  });

  // ─── Stale Connection Cleanup ──────────────────────────────────

  it("closes connections that don't identify within timeout", async () => {
    // We need a bridge with a short identification timeout for testing.
    // Currently it's hardcoded at 10s — this test documents the behavior
    // but we'll use a shorter timeout in the fixed version.
    await bridge.start();

    const ws = track(new WebSocket(`ws://localhost:${port}`));
    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Don't send anything — connection should be closed after timeout
    const closed = new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });

    // Default timeout is 10s — use the actual code's timeout
    const code = await closed;
    expect(code).toBe(4000); // Identification timeout code
  }, 15000);

  // ─── Extension Reconnection ────────────────────────────────────

  it("replaces old extension connection when new one sends hello", async () => {
    await bridge.start();

    // Connect first extension
    const ext1 = track(await connectFakeExtension(port));
    expect(bridge.ready).toBe(true);

    // Track if ext1 gets closed
    const ext1Closed = new Promise<number>((resolve) => {
      ext1.on("close", (code) => resolve(code));
    });

    // Connect second extension
    const ext2 = track(await connectFakeExtension(port));
    expect(bridge.ready).toBe(true);

    // First extension should have been closed with replacement code
    const code = await ext1Closed;
    expect(code).toBe(4001);
  });

  // ─── Pending Request Rejection on Disconnect ───────────────────

  it("rejects all pending requests when extension disconnects", async () => {
    await bridge.start();
    const ext = track(await connectRespondingExtension(port));

    // Verify basic communication works
    const ping = await bridge.send("ping");
    expect(ping.echo).toBe("ping");

    // Now send a command but close extension before responding
    const ext2 = track(await connectFakeExtension(port));
    // ext2 doesn't auto-respond

    // Send command that will never get a response
    const pending = bridge.send("slow_command", {}, 5000);

    // Close the extension
    await sleep(20);
    ext2.close();

    await expect(pending).rejects.toThrow(/disconnect/i);
  });

  // ─── Command Round-Trip ────────────────────────────────────────

  it("sends commands and receives responses", async () => {
    await bridge.start();
    const ext = track(await connectRespondingExtension(port));

    const result = await bridge.send("navigate", { url: "https://example.com" });
    expect(result.echo).toBe("navigate");
    expect(result.params.url).toBe("https://example.com");
  });

  it("handles error responses from extension", async () => {
    await bridge.start();

    const ext = track(await connectFakeExtension(port));
    ext.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.command) {
        ext.send(JSON.stringify({
          id: msg.id,
          type: "error",
          error: "Tab not found",
        }));
      }
    });

    await expect(bridge.send("screenshot")).rejects.toThrow("Tab not found");
  });

  // ─── Command Timeout ───────────────────────────────────────────

  it("times out commands that get no response", async () => {
    await bridge.start();
    // Extension connects but never responds to commands
    const ext = track(await connectFakeExtension(port));

    const start = Date.now();
    await expect(bridge.send("hang", {}, 200)).rejects.toThrow(/timed out/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(500);
  });

  // ─── Port Fallback ─────────────────────────────────────────────

  it("falls back to next port when default is busy", async () => {
    // Occupy the first port
    const blocker = new (await import("ws")).WebSocketServer({ port });
    await new Promise<void>((resolve) => blocker.on("listening", resolve));

    try {
      await bridge.start();
      const status = bridge.getStatus();
      // Should have moved to port + 1
      expect(status.port).toBe(port + 1);
      expect(status.bridge).toBe(true);
    } finally {
      blocker.close();
    }
  });

  // ─── Heartbeat ──────────────────────────────────────────────────

  it("detects stale connections via heartbeat ping/pong", async () => {
    // Use a fast heartbeat for testing
    const hbPort = nextPort();
    const hbBridge = new ChromeBridge({
      port: hbPort,
      heartbeatIntervalMs: 100,
      heartbeatMaxMissed: 2,
    });

    try {
      await hbBridge.start();

      // Connect extension but disable pong auto-response
      const ext = track(new WebSocket(`ws://localhost:${hbPort}`));
      await new Promise<void>((resolve) => ext.on("open", resolve));
      ext.send(JSON.stringify({
        type: "hello",
        agent: "neovision-chrome-bridge",
        version: "test",
      }));
      await sleep(50);
      expect(hbBridge.ready).toBe(true);

      // Disable pong responses — simulates a half-open/stale connection
      // ws library auto-responds to pings by default, so we need to
      // override that by removing the listener and not responding
      ext.on("ping", () => {
        // Explicitly do NOT pong — suppress the default auto-pong
      });
      // Remove the built-in auto-pong by setting pong to false
      (ext as any)._receiver._writableState = (ext as any)._receiver._writableState;
      // Actually, ws auto-pongs at the protocol level. To truly suppress it,
      // we need to prevent the pong from being sent. The simplest way is to
      // monkey-patch the socket's pong method:
      ext.pong = () => {}; // no-op, suppress auto-pong

      // Wait for heartbeat to detect: 100ms interval × (2 missed + 1) = ~300ms
      await sleep(500);

      expect(hbBridge.ready).toBe(false);
    } finally {
      await hbBridge.stop();
    }
  });

  // ─── Configurable Identification Timeout ───────────────────────

  it("supports configurable identification timeout", async () => {
    const fastBridge = new ChromeBridge({
      port: nextPort(),
      identifyTimeoutMs: 500,
    });

    try {
      await fastBridge.start();
      const p = fastBridge.getStatus().port;

      const ws = track(new WebSocket(`ws://localhost:${p}`));
      await new Promise<void>((resolve) => ws.on("open", resolve));

      const closed = new Promise<number>((resolve) => {
        ws.on("close", (code) => resolve(code));
      });

      // Should close in ~500ms, not 10s
      const start = Date.now();
      const code = await closed;
      const elapsed = Date.now() - start;

      expect(code).toBe(4000);
      expect(elapsed).toBeLessThan(2000); // Well under 10s
    } finally {
      await fastBridge.stop();
    }
  });

  // ─── Graceful stop ─────────────────────────────────────────────

  it("cleans up on stop", async () => {
    await bridge.start();
    const ext = track(await connectRespondingExtension(port));
    expect(bridge.ready).toBe(true);

    await bridge.stop();
    expect(bridge.ready).toBe(false);
  });
});
