#!/usr/bin/env node

/**
 * NeoVision Daemon — The Hub Process
 *
 * This is the ONE long-running process that owns the Chrome extension
 * WebSocket connection. All clients (MCP instances, bots, scripts) talk
 * to it via the HTTP API.
 *
 * Architecture:
 *   Chrome Extension ←WebSocket→ Daemon (this) ←HTTP→ MCP Server / Bots
 *
 * Start: npx neo-vision-daemon
 *    or: node dist/daemon.js
 */

import { ChromeBridge } from "./bridge.js";
import { RequestQueue } from "./queue.js";
import { HttpApi } from "./http-api.js";
import { statSync, renameSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const BRIDGE_PORT = parseInt(process.env.NEO_VISION_BRIDGE_PORT || "7665", 10);
const API_PORT = parseInt(process.env.NEO_VISION_API_PORT || "7680", 10);

// ─── Log rotation ─────────────────────────────────────────────────
//
// Launchd captures our stdout/stderr to ~/.neo-vision/logs/daemon{,-error}.log
// and ~/.neo-vision/logs/extension.log via plist redirects. These files grow
// forever — daemon-error.log was 2.1MB after a few weeks of normal use with
// no rotation in place. At startup, rotate any log >10MB so we don't fill
// the user's disk over months.
const LOG_DIR = join(homedir(), ".neo-vision", "logs");
const ROTATE_FILES = ["daemon.log", "daemon-error.log", "extension.log"];
const ROTATE_THRESHOLD_BYTES = 10 * 1024 * 1024;   // 10 MB

function rotateLogsIfNeeded() {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  for (const name of ROTATE_FILES) {
    const path = join(LOG_DIR, name);
    if (!existsSync(path)) continue;
    let size = 0;
    try { size = statSync(path).size; } catch { continue; }
    if (size <= ROTATE_THRESHOLD_BYTES) continue;
    const archived = path + ".1";
    try {
      // Move existing .1 to .2 to keep one round-trip of history.
      if (existsSync(archived)) {
        try { renameSync(archived, path + ".2"); } catch {}
      }
      renameSync(path, archived);
      // Recreate empty file so launchd's redirect target still exists.
      writeFileSync(path, "");
      console.error(`[Daemon] rotated ${name} (was ${(size / 1024 / 1024).toFixed(1)} MB) → ${name}.1`);
    } catch (e) {
      console.error(`[Daemon] log rotation failed for ${name}:`, e);
    }
  }
}

// Module-level handles so the shutdown signal handler can reach them.
let _bridge: ChromeBridge | null = null;
let _queue: RequestQueue | null = null;
let _api: HttpApi | null = null;

async function main() {
  rotateLogsIfNeeded();

  console.error("╔═══════════════════════════════════════════════╗");
  console.error("║         NeoVision Daemon — Hub Process        ║");
  console.error("╚═══════════════════════════════════════════════╝");
  console.error("");

  // 1. Start the WebSocket bridge (connects to Chrome extension)
  const bridge = new ChromeBridge({ port: BRIDGE_PORT });
  const queue = new RequestQueue();
  const api = new HttpApi(bridge, queue, API_PORT);
  _bridge = bridge; _queue = queue; _api = api;


  try {
    await bridge.start();
    const status = bridge.getStatus();
    console.error(`[Daemon] Bridge WebSocket server on port ${status.port}`);
    console.error(`[Daemon] Extension connected: ${status.extension}`);
  } catch (err) {
    console.error("[Daemon] Warning: Could not start bridge:", err);
    console.error("[Daemon] The HTTP API will start but commands will fail until the extension connects.");
  }

  // 2. Start the HTTP API (clients POST here)
  try {
    await api.start();
    console.error(`[Daemon] HTTP API listening on port ${API_PORT}`);
    console.error("");
    console.error(`[Daemon] Ready! Clients POST to http://localhost:${API_PORT}/api/*`);
    console.error(`[Daemon] Endpoints:`);
    console.error(`  POST /api/navigate    — Navigate to URL`);
    console.error(`  POST /api/snapshot    — Spatial DOM snapshot`);
    console.error(`  POST /api/click       — Click at coordinates`);
    console.error(`  POST /api/type        — Type text`);
    console.error(`  POST /api/scroll      — Scroll page`);
    console.error(`  POST /api/execute_js  — Run JavaScript`);
    console.error(`  POST /api/screenshot  — Take screenshot`);
    console.error(`  POST /api/query       — Query cached snapshot`);
    console.error(`  GET  /api/status      — Bridge + queue status`);
    console.error("");
  } catch (err) {
    console.error("[Daemon] Fatal: Could not start HTTP API:", err);
    process.exit(1);
  }

  // 3. Periodic status logging
  setInterval(() => {
    const bridgeStatus = bridge.getStatus();
    const queueStats = queue.getStats();
    if (!bridgeStatus.extension) {
      console.error(
        `[Daemon] Extension disconnected. Waiting for reconnection on port ${bridgeStatus.port}...`
      );
    }
    if (queueStats.pending > 0) {
      console.error(
        `[Daemon] Queue: ${queueStats.pending} pending, ${queueStats.totalProcessed} processed, ${queueStats.totalErrors} errors`
      );
    }
  }, 30000);
}

main().catch((err) => {
  console.error("[Daemon] Fatal error:", err);
  process.exit(1);
});

// Clean shutdown — drain pending requests, close the WebSocket politely,
// give the HTTP server a chance to finish in-flight responses. Bounded by a
// hard deadline so a stuck client can't block us forever.
let _shuttingDown = false;
async function shutdown(signal: string) {
  if (_shuttingDown) {
    // Second signal — caller is impatient. Hard-exit.
    console.error(`[Daemon] ${signal} during shutdown — forcing exit`);
    process.exit(1);
  }
  _shuttingDown = true;
  console.error(`\n[Daemon] Received ${signal}, draining queue and shutting down...`);

  const HARD_DEADLINE_MS = 5000;
  const deadline = Date.now() + HARD_DEADLINE_MS;
  const forceExit = setTimeout(() => {
    console.error("[Daemon] Hard deadline reached, force-exiting");
    process.exit(1);
  }, HARD_DEADLINE_MS);
  forceExit.unref?.();

  try {
    // Drain queue: reject everything pending so callers get a clean error
    // instead of a TCP reset mid-request.
    if (_queue) {
      const stats = _queue.getStats();
      if (stats.pending > 0 || stats.processing) {
        console.error(`[Daemon]   queue: ${stats.pending} pending, processing=${stats.processing} — draining`);
      }
      _queue.drain("Daemon shutting down");
    }

    // Close HTTP server (stops accepting new requests; existing ones drain).
    if (_api && typeof (_api as any).stop === "function") {
      try { await (_api as any).stop(); } catch (e) { console.error("[Daemon] api.stop failed:", e); }
    }

    // Close the WebSocket bridge. The extension will reconnect on next launch.
    if (_bridge && typeof (_bridge as any).stop === "function") {
      try { await (_bridge as any).stop(); } catch (e) { console.error("[Daemon] bridge.stop failed:", e); }
    }

    const remainingMs = Math.max(0, deadline - Date.now());
    console.error(`[Daemon] Drain complete (${HARD_DEADLINE_MS - remainingMs}ms). Goodbye.`);
    clearTimeout(forceExit);
    process.exit(0);
  } catch (e) {
    console.error("[Daemon] Error during shutdown:", e);
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
