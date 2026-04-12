/**
 * NeoVision — Programmatic API
 *
 * See the web the way Neo sees the Matrix.
 * Use this to integrate spatial DOM mapping into any agent harness:
 * Claude Code, Cowork, OpenClaw, AntiGravity, LangChain, CrewAI, etc.
 *
 * Usage:
 *   import { SpatialBrowser } from 'neo-vision';
 *
 *   const browser = new SpatialBrowser({ mode: 'stealth' });
 *   const map = await browser.snapshot('https://example.com');
 *   console.log(map.elements.filter(e => e.actionable));
 *   await browser.click(map.elements[5].click_center!);
 *   await browser.close();
 */

export { queryMap, type QueryFilters } from "./query.js";
export type {
  SpatialMap,
  SpatialElement,
  SpatialMapStats,
  Bounds,
  Point,
  ComputedLayout,
} from "./schema.js";

// ─── Injectable (browser-side spatial snapshot) ──────────────────
export {
  INJECTABLE_SOURCE,
  getInjectableScript,
  getInjectableInstaller,
} from "./injectable.js";
export type {
  InjectableSpatialMap,
  InjectableSpatialElement,
  InjectableBounds,
  InjectablePoint,
  InjectableOptions,
} from "./injectable.js";

// ─── Chrome Bridge (extension-based browser control) ───────────────
export { ChromeBridge, type BridgeConfig } from "./bridge.js";

// ─── Hub-and-Spoke (daemon + HTTP API + queue) ──────────────────
export { RequestQueue, type QueueStats, type QueuedRequest } from "./queue.js";
export { HttpApi, type HttpApiConfig } from "./http-api.js";
export { HttpClient, type HttpClientConfig } from "./http-client.js";

// ─── Pacing (human-like throttling for scraping) ─────────────────
export {
  PacingEngine,
  getCaptchaDetector,
  CAPTCHA_DETECTOR_SOURCE,
} from "./pacing.js";
export type {
  PacingConfig,
  PacingInstruction,
  PacingStats,
} from "./pacing.js";

