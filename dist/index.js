/**
 * NeoVision — Programmatic API
 *
 * See the web the way Neo sees the Matrix.
 * Integrate spatial DOM mapping into any agent harness:
 * Claude Code, Cowork, OpenClaw, AntiGravity, LangChain, CrewAI, etc.
 *
 * Extension-only architecture: the Chrome extension drives the real browser.
 * Use ChromeBridge directly, or run the MCP server and connect via the extension.
 */
export { queryMap } from "./query.js";
// ─── Injectable (browser-side spatial snapshot) ──────────────────
export { INJECTABLE_SOURCE, getInjectableScript, getInjectableInstaller, } from "./injectable.js";
// ─── Chrome Bridge (extension-based browser control) ───────────────
export { ChromeBridge } from "./bridge.js";
// ─── Hub-and-Spoke (daemon + HTTP API + queue) ──────────────────
export { RequestQueue } from "./queue.js";
export { HttpApi } from "./http-api.js";
export { HttpClient } from "./http-client.js";
// ─── Pacing (human-like throttling for scraping) ─────────────────
export { PacingEngine, getCaptchaDetector, CAPTCHA_DETECTOR_SOURCE, } from "./pacing.js";
//# sourceMappingURL=index.js.map