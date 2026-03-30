import type { Page } from "playwright";
import type { SpatialMap } from "./schema.js";
import { takeSnapshot, type SnapshotOptions } from "./snapshot.js";
import { humanDelay, humanSleep, typingDelay } from "./stealth.js";

// ─── Bezier Mouse Movement ─────────────────────────────────────
//
// Instead of teleporting the cursor to (x, y), we trace a bezier
// curve from the current position with randomized control points
// and variable step timing.  This is the single biggest behavioral
// signal that separates bots from humans.

interface Point {
  x: number;
  y: number;
}

/**
 * Generate a random offset for bezier control points.
 * Larger distances get proportionally wider curves.
 */
function controlPointOffset(distance: number): number {
  const spread = Math.min(distance * 0.4, 200);
  return (Math.random() - 0.5) * 2 * spread;
}

/**
 * Evaluate a cubic bezier at parameter t ∈ [0, 1].
 */
function bezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * Move the mouse from its current position to (targetX, targetY)
 * along a natural-looking bezier curve with jittered timing.
 */
async function humanMouseMove(page: Page, targetX: number, targetY: number): Promise<void> {
  // Get current mouse position (default to a random start if first move)
  const viewport = page.viewportSize()!;
  const start: Point = (page as any).__lastMousePos ?? {
    x: Math.random() * viewport.width * 0.8 + viewport.width * 0.1,
    y: Math.random() * viewport.height * 0.8 + viewport.height * 0.1,
  };

  const dx = targetX - start.x;
  const dy = targetY - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // For very short moves, just move directly with a small delay
  if (distance < 10) {
    await page.mouse.move(targetX, targetY);
    (page as any).__lastMousePos = { x: targetX, y: targetY };
    return;
  }

  // Generate two control points with random offsets
  const cp1: Point = {
    x: start.x + dx * 0.25 + controlPointOffset(distance),
    y: start.y + dy * 0.25 + controlPointOffset(distance),
  };
  const cp2: Point = {
    x: start.x + dx * 0.75 + controlPointOffset(distance),
    y: start.y + dy * 0.75 + controlPointOffset(distance),
  };

  // Number of steps scales with distance — more steps for longer moves
  const steps = Math.max(12, Math.min(60, Math.round(distance / 8)));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Ease-in-out: slow start, fast middle, slow end
    const eased = t < 0.5
      ? 2 * t * t
      : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const x = bezier(eased, start.x, cp1.x, cp2.x, targetX);
    const y = bezier(eased, start.y, cp1.y, cp2.y, targetY);

    await page.mouse.move(x, y);

    // Variable delay per step: faster in the middle, slower at edges
    const edgeFactor = 1 + 2 * Math.abs(t - 0.5); // 1 at center, 2 at edges
    const stepDelay = Math.round((2 + Math.random() * 4) * edgeFactor);
    if (stepDelay > 2) {
      await page.waitForTimeout(stepDelay);
    }
  }

  // Final position — ensure we land exactly on target
  await page.mouse.move(targetX, targetY);
  (page as any).__lastMousePos = { x: targetX, y: targetY };
}

/**
 * Small random offset from an element's exact center.
 * Humans don't click the mathematical center — they click near it.
 */
function jitterTarget(x: number, y: number, radius: number = 3): Point {
  const angle = Math.random() * Math.PI * 2;
  const r = Math.random() * radius;
  return {
    x: x + Math.cos(angle) * r,
    y: y + Math.sin(angle) * r,
  };
}

// ─── Public Actions ────────────────────────────────────────────

/**
 * Click at a coordinate with human-like mouse movement, jitter,
 * and variable timing.  Returns an updated spatial map.
 */
export async function click(
  page: Page,
  x: number,
  y: number,
  button: "left" | "right" | "middle" = "left",
  clickCount: number = 1,
  snapshotOptions: SnapshotOptions
): Promise<SpatialMap> {
  const target = jitterTarget(x, y);

  // Move mouse along a bezier curve to the target
  await humanMouseMove(page, target.x, target.y);

  // Brief hover pause — humans don't click the instant they arrive
  await humanSleep(page, 80);

  // Click
  await page.mouse.click(target.x, target.y, { button, clickCount });

  // Wait for DOM to settle after click
  await humanSleep(page, 400);

  // Try to wait for network idle, but don't fail if it times out
  try {
    await page.waitForLoadState("networkidle", { timeout: 3000 });
  } catch {
    // Page might not have network activity, that's fine
  }

  return takeSnapshot(page, snapshotOptions);
}

/**
 * Type text with human-like per-character delay variation,
 * optional click-to-focus with bezier movement.
 */
export async function type(
  page: Page,
  text: string,
  options: {
    x?: number;
    y?: number;
    clearFirst?: boolean;
    pressEnter?: boolean;
  },
  snapshotOptions: SnapshotOptions
): Promise<SpatialMap> {
  // Click target if coordinates provided — with full human movement
  if (options.x !== undefined && options.y !== undefined) {
    const target = jitterTarget(options.x, options.y);
    await humanMouseMove(page, target.x, target.y);
    await humanSleep(page, 60);
    await page.mouse.click(target.x, target.y);
    await humanSleep(page, 120);
  }

  // Clear existing content if requested
  if (options.clearFirst) {
    // Use Cmd+A on Mac, Ctrl+A elsewhere (Playwright handles this)
    await page.keyboard.press("Meta+a");
    await humanSleep(page, 50);
    await page.keyboard.press("Backspace");
    await humanSleep(page, 80);
  }

  // Type character by character with variable delay
  // Humans type in bursts — faster within words, pauses between words
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    await page.keyboard.type(char, { delay: 0 });

    if (char === " ") {
      // Slightly longer pause between words
      await page.waitForTimeout(typingDelay() + Math.round(Math.random() * 60));
    } else {
      await page.waitForTimeout(typingDelay());
    }

    // Occasional micro-pause mid-word (thinking hesitation)
    if (Math.random() < 0.05 && i < text.length - 1) {
      await page.waitForTimeout(150 + Math.round(Math.random() * 200));
    }
  }

  // Press enter if requested
  if (options.pressEnter) {
    await humanSleep(page, 200);
    await page.keyboard.press("Enter");
    await humanSleep(page, 400);
    try {
      await page.waitForLoadState("networkidle", { timeout: 3000 });
    } catch {
      // fine
    }
  }

  return takeSnapshot(page, snapshotOptions);
}

/**
 * Scroll with human-like incremental steps instead of a single
 * instant jump.  Humans scroll in discrete wheel ticks with
 * variable timing.
 */
export async function scroll(
  page: Page,
  deltaX: number = 0,
  deltaY: number = 0,
  x?: number,
  y?: number,
  snapshotOptions?: SnapshotOptions
): Promise<SpatialMap> {
  const scrollX = x ?? page.viewportSize()!.width / 2;
  const scrollY = y ?? page.viewportSize()!.height / 2;

  // Move mouse to scroll position with human motion
  await humanMouseMove(page, scrollX, scrollY);
  await humanSleep(page, 100);

  // Break scroll into multiple wheel events (like real scroll ticks)
  const totalDelta = Math.abs(deltaY) + Math.abs(deltaX);
  const ticks = Math.max(3, Math.min(12, Math.round(totalDelta / 100)));

  for (let i = 0; i < ticks; i++) {
    const fraction = 1 / ticks;
    const tickDx = deltaX * fraction;
    const tickDy = deltaY * fraction;

    // Add slight variation to each tick
    const jitteredDx = tickDx + (Math.random() - 0.5) * 5;
    const jitteredDy = tickDy + (Math.random() - 0.5) * 5;

    await page.mouse.wheel(jitteredDx, jitteredDy);
    await page.waitForTimeout(humanDelay(40, 0.5));
  }

  // Let scroll settle
  await humanSleep(page, 250);

  return takeSnapshot(page, snapshotOptions!);
}
