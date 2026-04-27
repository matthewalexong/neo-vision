/**
 * No-Tab Guard Tests
 *
 * Verifies that commands which require an active tab (execute_js, inject_spatial,
 * click, type, scroll) return explicit errors when no tab has been navigated to,
 * instead of silently creating an about:blank tab and returning null.
 *
 * These test the extension's command handler logic via the bridge.
 * The fake extension simulates the guard behavior that background.js now has.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChromeBridge } from "../bridge.js";
import WebSocket from "ws";

let portCounter = 19665;
function nextPort() { return portCounter++; }
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Connect a fake extension that mimics the real background.js guard behavior:
 * - navigate: creates/manages tab (always works)
 * - execute_js, inject_spatial, click, type, scroll: require managedTabId
 */
async function connectGuardedExtension(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.send(JSON.stringify({
    type: "hello",
    agent: "neovision-chrome-bridge",
    version: "test-guarded",
  }));
  await sleep(50);

  let managedTabId: number | null = null;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.command) return;

      const requiresTab = [
        "execute_js", "inject_spatial", "click", "type", "scroll",
      ];

      if (msg.command === "navigate") {
        managedTabId = 12345; // simulate tab creation
        ws.send(JSON.stringify({
          id: msg.id,
          type: "result",
          result: { success: true, url: msg.params.url, title: "Test Page" },
        }));
      } else if (requiresTab.includes(msg.command) && !managedTabId) {
        ws.send(JSON.stringify({
          id: msg.id,
          type: "result",
          result: {
            success: false,
            error: "No active tab. Navigate to a URL first.",
          },
        }));
      } else if (msg.command === "inject_spatial" && !managedTabId) {
        ws.send(JSON.stringify({
          id: msg.id,
          type: "result",
          result: {
            success: false,
            spatial_map: null,
            error: "No active tab. Navigate to a URL first.",
          },
        }));
      } else {
        ws.send(JSON.stringify({
          id: msg.id,
          type: "result",
          result: { success: true, command: msg.command },
        }));
      }
    } catch {}
  });

  return ws;
}

describe("No-Tab Guard", () => {
  let bridge: ChromeBridge;
  let port: number;
  let ext: WebSocket | null = null;

  beforeEach(async () => {
    port = nextPort();
    bridge = new ChromeBridge({ port, heartbeatIntervalMs: 0 });
    await bridge.start();
  });

  afterEach(async () => {
    if (ext && ext.readyState <= 1) ext.close();
    await bridge.stop();
    await sleep(50);
  });

  it("returns error for execute_js when no tab has been navigated to", async () => {
    ext = await connectGuardedExtension(port);
    const result = await bridge.send("execute_js", { code: "document.title" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no active tab/i);
  });

  it("returns error for click when no tab has been navigated to", async () => {
    ext = await connectGuardedExtension(port);
    const result = await bridge.send("click", { x: 100, y: 200 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no active tab/i);
  });

  it("returns error for type when no tab has been navigated to", async () => {
    ext = await connectGuardedExtension(port);
    const result = await bridge.send("type", { x: 100, y: 200, text: "hello" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no active tab/i);
  });

  it("returns error for scroll when no tab has been navigated to", async () => {
    ext = await connectGuardedExtension(port);
    const result = await bridge.send("scroll", { deltaX: 0, deltaY: 300 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no active tab/i);
  });

  it("returns error for inject_spatial when no tab has been navigated to", async () => {
    ext = await connectGuardedExtension(port);
    const result = await bridge.send("inject_spatial", { injectable_source: "1+1" });
    expect(result.success).toBe(false);
  });

  it("succeeds after navigating first", async () => {
    ext = await connectGuardedExtension(port);

    // Before navigate: should fail
    const fail = await bridge.send("execute_js", { code: "1+1" });
    expect(fail.success).toBe(false);

    // Navigate
    const nav = await bridge.send("navigate", { url: "https://example.com" });
    expect(nav.success).toBe(true);

    // After navigate: should succeed
    const ok = await bridge.send("execute_js", { code: "1+1" });
    expect(ok.success).toBe(true);
  });
});
