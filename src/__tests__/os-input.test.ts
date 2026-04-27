/**
 * os-input.ts tests — pure-logic verification.
 *
 * These tests verify the page → screen coordinate math and cliclick
 * detection without ever actually invoking cliclick or moving the
 * mouse. The dispatch functions (osClick, osType) are NOT tested
 * here because they side-effect the real desktop — those want
 * end-to-end testing on a real machine.
 */

import { describe, it, expect } from "vitest";
import { pageToScreen, isCliclickInstalled, type WindowGeometry } from "../os-input.js";

const baseGeom: WindowGeometry = {
  window: { left: 100, top: 50, width: 1280, height: 800 },
  viewport: { width: 1280, height: 720 },
  chrome_offset: { x: 0, y: 80 },
  scroll: { x: 0, y: 0 },
  device_pixel_ratio: 2,
};

describe("pageToScreen", () => {
  it("translates page (0,0) to screen window-origin + chrome offset", () => {
    const screen = pageToScreen({ x: 0, y: 0 }, baseGeom);
    expect(screen).toEqual({ x: 100, y: 130 }); // 50 + 80
  });

  it("adds page coordinates to the window origin", () => {
    const screen = pageToScreen({ x: 200, y: 300 }, baseGeom);
    expect(screen).toEqual({ x: 300, y: 430 });
  });

  it("subtracts page scroll offset", () => {
    const scrolled: WindowGeometry = {
      ...baseGeom,
      scroll: { x: 0, y: 500 },
    };
    // An element at page y=600 with scroll y=500 is visually at viewport y=100.
    // So screen y = 50 (window top) + 80 (chrome bar) + 100 (viewport y) = 230.
    const screen = pageToScreen({ x: 0, y: 600 }, scrolled);
    expect(screen).toEqual({ x: 100, y: 230 });
  });

  it("does NOT multiply by devicePixelRatio (cliclick uses CSS pixels)", () => {
    // macOS handles HiDPI internally. We pass logical pixels to cliclick.
    const screen = pageToScreen({ x: 100, y: 100 }, baseGeom);
    // If we wrongly multiplied by DPR=2, we'd get x=300 (200 + 100) — fail.
    expect(screen.x).toBeLessThan(300);
  });

  it("rounds non-integer results", () => {
    const screen = pageToScreen({ x: 100.7, y: 200.3 }, baseGeom);
    expect(Number.isInteger(screen.x)).toBe(true);
    expect(Number.isInteger(screen.y)).toBe(true);
  });

  it("handles a window not at screen origin", () => {
    const offWindow: WindowGeometry = {
      ...baseGeom,
      window: { left: 500, top: 200, width: 1280, height: 800 },
    };
    const screen = pageToScreen({ x: 50, y: 50 }, offWindow);
    expect(screen).toEqual({ x: 550, y: 330 }); // 200 + 80 + 50
  });

  it("handles non-zero chrome_offset.x (uncommon but possible)", () => {
    const offset: WindowGeometry = {
      ...baseGeom,
      chrome_offset: { x: 10, y: 80 },
    };
    const screen = pageToScreen({ x: 100, y: 100 }, offset);
    expect(screen).toEqual({ x: 210, y: 230 }); // 100 + 10 + 100
  });
});

describe("isCliclickInstalled", () => {
  it("returns a boolean (true/false based on actual filesystem)", () => {
    const result = isCliclickInstalled();
    expect(typeof result).toBe("boolean");
  });
});
