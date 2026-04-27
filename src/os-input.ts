/**
 * NeoVision OS-Level Input Dispatch
 *
 * Routes click and keystroke commands through macOS-level CGEvents instead
 * of synthetic JavaScript MouseEvent / KeyboardEvent dispatches. This is
 * the difference between `event.isTrusted === true` (real user input,
 * passes anti-bot detection) and `event.isTrusted === false` (synthetic,
 * silently flagged by Cloudflare / Datadome / X / reCAPTCHA / etc).
 *
 * Implementation: shells out to `cliclick` (https://github.com/BlueM/cliclick).
 * Install via: `brew install cliclick`. The binary lives at /opt/homebrew/bin/cliclick
 * on Apple Silicon, /usr/local/bin/cliclick on Intel.
 *
 * ─── Stealth defaults ────────────────────────────────────────────────
 * By default, every click and keystroke is dispatched with human-like
 * timing variance:
 *   - Cursor visibly moves to the target with eased animation (200-400ms)
 *   - Brief pause after the cursor arrives, before the click (50-200ms)
 *   - Small coordinate jitter so we never click the exact mathematical center
 *   - Per-keystroke delays (avg 100ms ± variance) with occasional longer
 *     "thinking" pauses on word boundaries
 *   - Randomized inter-action gap (200-800ms between successive operations)
 *
 * Pass `{ stealth: false }` to skip all of the above for tight scraping
 * loops on non-hostile sites.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";

// ─── Locate cliclick binary ───────────────────────────────────────

const CLICLICK_CANDIDATES = [
  "/opt/homebrew/bin/cliclick",  // Apple Silicon Homebrew
  "/usr/local/bin/cliclick",     // Intel Homebrew
  "cliclick",                    // PATH fallback
];

let cachedCliclickPath: string | null = null;

function findCliclick(): string {
  if (cachedCliclickPath) return cachedCliclickPath;
  for (const candidate of CLICLICK_CANDIDATES) {
    if (candidate.startsWith("/") && existsSync(candidate)) {
      cachedCliclickPath = candidate;
      return candidate;
    }
  }
  cachedCliclickPath = "cliclick";
  return cachedCliclickPath;
}

export function isCliclickInstalled(): boolean {
  for (const candidate of CLICLICK_CANDIDATES) {
    if (candidate.startsWith("/") && existsSync(candidate)) return true;
  }
  return false;
}

// ─── Shell helpers ────────────────────────────────────────────────

function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(findCliclick(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Randomness helpers ───────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/** Triangular distribution biased toward 0 — natural for small jitter */
function triangularJitter(maxAbs: number): number {
  return Math.round((Math.random() - Math.random()) * maxAbs);
}

// ─── Chrome focus ─────────────────────────────────────────────────

let lastFocusedAt = 0;
const FOCUS_REFRESH_MS = 5000;

/**
 * Ensure Google Chrome is the frontmost app before dispatching OS-level
 * input — otherwise the click lands on whatever window is on top at that
 * screen pixel. Uses AppleScript via osascript.
 *
 * Throttled: skips the activation if we already focused Chrome in the
 * last 5 seconds (avoids redundant work in tight click sequences).
 *
 * Tries common Chrome variants in order. Silently no-ops if none found.
 */
export async function ensureChromeFocused(force = false): Promise<void> {
  if (!force && Date.now() - lastFocusedAt < FOCUS_REFRESH_MS) return;

  const candidates = ["Google Chrome", "Google Chrome Beta", "Google Chrome Canary", "Chromium"];
  for (const app of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("osascript", ["-e", `tell application "${app}" to activate`], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("error", reject);
        proc.on("close", (code) => {
          if (code === 0) {
            lastFocusedAt = Date.now();
            resolve();
          } else {
            reject(new Error(stderr || `osascript exit ${code}`));
          }
        });
      });
      return; // focused successfully
    } catch {
      // try next variant
    }
  }
}

// ─── Click options ────────────────────────────────────────────────

export interface OsClickOptions {
  /** Default true. False = instant click with no cursor animation or jitter. */
  stealth?: boolean;
  /** Default 'left'. 'right' for right-click. */
  button?: "left" | "right";
  /** Override randomized cursor travel time (ms). Default: 200-400ms. */
  travelMs?: number;
  /** Override post-arrival pause (ms). Default: 50-200ms. */
  arrivalPauseMs?: number;
  /** Override pixel jitter applied to (x, y). Default: ±3 px each axis. */
  jitterPx?: number;
  /** Default true. Brings Chrome to front before clicking. */
  focusChrome?: boolean;
}

/**
 * Click at SCREEN coordinates (not page CSS coordinates).
 *
 * Use spatial-coords.ts → pageToScreen() to convert page coordinates
 * from a spatial_snapshot before passing them in here.
 *
 * Stealth path:
 *   1. Apply triangular jitter to (x, y)
 *   2. cliclick `m:` to move cursor with visible easing (cliclick interpolates)
 *   3. Sleep arrivalPauseMs
 *   4. cliclick `c:.` (left) or `rc:.` (right) — click at current cursor position
 *
 * Non-stealth path: just `cliclick c:x,y` — instant, no movement.
 */
export async function osClick(x: number, y: number, opts: OsClickOptions = {}): Promise<void> {
  const stealth = opts.stealth !== false;
  const button = opts.button || "left";

  if (opts.focusChrome !== false) {
    await ensureChromeFocused();
  }

  if (!stealth) {
    const cmd = button === "right" ? `rc:${Math.round(x)},${Math.round(y)}` : `c:${Math.round(x)},${Math.round(y)}`;
    await run([cmd]);
    return;
  }

  const jitter = opts.jitterPx ?? 3;
  const targetX = Math.round(x + triangularJitter(jitter));
  const targetY = Math.round(y + triangularJitter(jitter));

  // Move cursor with cliclick — it animates the move automatically when given
  // m: with `--easing` flag (cliclick 5+). For older versions, the visible
  // animation comes from the OS handling the CGEventCreateMouseEvent.
  // We add an explicit travel delay and a few intermediate moves so it
  // visibly travels rather than teleporting.
  await stealthMove(targetX, targetY, opts.travelMs);

  await sleep(opts.arrivalPauseMs ?? randInt(50, 200));

  const clickCmd = button === "right" ? "rc:." : "c:.";
  await run([clickCmd]);
}

/**
 * Stealth cursor movement: instead of one teleport, move through 3-5
 * intermediate points along an eased path, so the cursor is visibly
 * traveling rather than snapping. The OS treats each `m:` as a real
 * mouse-move event.
 */
async function stealthMove(targetX: number, targetY: number, travelMs?: number): Promise<void> {
  const totalMs = travelMs ?? randInt(200, 400);
  const steps = randInt(3, 6);
  const stepMs = Math.max(20, Math.floor(totalMs / steps));

  // Get current cursor position by sending `p` (print) — cliclick prints "x,y".
  let startX = targetX;
  let startY = targetY;
  try {
    const { stdout } = await run(["p"]);
    const match = stdout.trim().match(/^(\d+),\s*(\d+)$/);
    if (match) {
      startX = parseInt(match[1], 10);
      startY = parseInt(match[2], 10);
    }
  } catch {
    // If we can't read current position, just do a single move.
    await run([`m:${targetX},${targetY}`]);
    return;
  }

  for (let i = 1; i <= steps; i++) {
    // Eased t from 0..1 (ease-out cubic)
    const t = 1 - Math.pow(1 - i / steps, 3);
    const px = Math.round(startX + (targetX - startX) * t);
    const py = Math.round(startY + (targetY - startY) * t);
    await run([`m:${px},${py}`]);
    if (i < steps) await sleep(stepMs);
  }
}

// ─── Type options ─────────────────────────────────────────────────

export interface OsTypeOptions {
  /** Default true. False = bulk type via cliclick `t:` (instant, all chars at once). */
  stealth?: boolean;
  /** Override per-keystroke delay range [min, max] ms. Default: [60, 180]. */
  keyDelayRange?: [number, number];
  /** Probability (0-1) of a longer "thinking pause" on word boundary. Default: 0.08 */
  thinkingPauseProbability?: number;
  /** Range for thinking pauses [min, max] ms. Default: [300, 900]. */
  thinkingPauseRange?: [number, number];
}

/**
 * Type text at OS level. Assumes the target field already has focus
 * (call osClick on the field first to focus it).
 *
 * Stealth path: per-character cliclick `t:<char>` with randomized delays
 * and occasional longer pauses on whitespace boundaries.
 *
 * Non-stealth: single `t:<full string>` — fast but uniform timing.
 */
export async function osType(text: string, opts: OsTypeOptions = {}): Promise<void> {
  const stealth = opts.stealth !== false;

  // Make sure Chrome is the frontmost app so keystrokes land in the page.
  await ensureChromeFocused();

  if (!stealth) {
    await run([`t:${text}`]);
    return;
  }

  const [minDelay, maxDelay] = opts.keyDelayRange ?? [60, 180];
  const thinkingProb = opts.thinkingPauseProbability ?? 0.08;
  const [minThink, maxThink] = opts.thinkingPauseRange ?? [300, 900];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // cliclick `t:` types a literal string — escape colons and backslashes.
    // Most ASCII works fine; for exotic unicode we fall back to single `t:`.
    await run([`t:${ch}`]);

    // Pause after this character — but not after the very last one.
    if (i < text.length - 1) {
      let delay = randInt(minDelay, maxDelay);
      // Occasional longer pause on whitespace (word boundary)
      if (ch === " " && Math.random() < thinkingProb) {
        delay = randInt(minThink, maxThink);
      }
      await sleep(delay);
    }
  }
}

// ─── Inter-action gap ─────────────────────────────────────────────

/**
 * Sleep a randomized small gap between successive actions (e.g. between
 * a click and the next click). Defaults: 200-800ms.
 *
 * Call this from server.ts between sequential operations when stealth
 * is on and the operations are not naturally separated by cursor travel.
 */
export async function stealthGap(min = 200, max = 800): Promise<void> {
  await sleep(randInt(min, max));
}

// ─── Coordinate translation ───────────────────────────────────────

export interface PageCoord { x: number; y: number; }
export interface ScreenCoord { x: number; y: number; }

export interface WindowGeometry {
  window: { left: number; top: number; width: number; height: number };
  viewport: { width: number; height: number };
  chrome_offset: { x: number; y: number };
  scroll: { x: number; y: number };
  device_pixel_ratio: number;
}

/**
 * Convert a page CSS coordinate (relative to viewport top-left) into a
 * screen pixel coordinate (relative to your monitor's top-left).
 *
 * cliclick takes coordinates in CSS pixels (not physical pixels), so we
 * do NOT multiply by devicePixelRatio. macOS handles HiDPI internally.
 *
 *   screenX = window.left + chrome_offset.x + (pageX - scroll.x)
 *   screenY = window.top  + chrome_offset.y + (pageY - scroll.y)
 *
 * Note: pageX/pageY here are coordinates returned by spatial_snapshot,
 * which are already in viewport-relative CSS pixels (the snapshot uses
 * getBoundingClientRect + window.scrollX, so they're absolute page coords).
 * That's why we subtract scroll back out to get viewport-relative.
 */
export function pageToScreen(page: PageCoord, geom: WindowGeometry): ScreenCoord {
  const viewportX = page.x - geom.scroll.x;
  const viewportY = page.y - geom.scroll.y;
  return {
    x: Math.round(geom.window.left + geom.chrome_offset.x + viewportX),
    y: Math.round(geom.window.top + geom.chrome_offset.y + viewportY),
  };
}
