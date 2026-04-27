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

// Clean shutdown
async function shutdown(signal: string) {
  console.error(`\n[Daemon] Received ${signal}, shutting down...`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
