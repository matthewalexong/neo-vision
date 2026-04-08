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
export type { SpatialMap, SpatialElement, SpatialMapStats, Bounds, Point, ComputedLayout, } from "./schema.js";
export { INJECTABLE_SOURCE, getInjectableScript, getInjectableInstaller, } from "./injectable.js";
export type { InjectableSpatialMap, InjectableSpatialElement, InjectableBounds, InjectablePoint, InjectableOptions, } from "./injectable.js";
export { ChromeBridge, type BridgeConfig } from "./bridge.js";
export { PacingEngine, getCaptchaDetector, CAPTCHA_DETECTOR_SOURCE, } from "./pacing.js";
export type { PacingConfig, PacingInstruction, PacingStats, } from "./pacing.js";
