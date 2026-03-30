#!/usr/bin/env tsx

/**
 * Standalone test: snapshot a real page and dump the spatial map JSON.
 *
 * Usage: npx tsx src/test-snapshot.ts [url]
 * Default URL: https://example.com
 */

import { chromium } from "playwright";
import { takeSnapshot } from "./snapshot.js";

const url = process.argv[2] || "https://example.com";

async function main() {
  console.error(`Launching browser...`);
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1.0,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });

  const page = await context.newPage();

  // Disable animations
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `;
    document.documentElement.appendChild(style);
  });

  console.error(`Navigating to ${url}...`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Wait for any redirects to settle
  await page.waitForTimeout(3000);
  try { await page.waitForLoadState("domcontentloaded", { timeout: 5000 }); } catch {};

  console.error(`Taking snapshot...`);
  const start = Date.now();
  const map = await takeSnapshot(page, {
    settleMs: 1000,
    includeNonVisible: false,
    maxDepth: 50,
    verbosity: "actionable",
  });
  const elapsed = Date.now() - start;

  // Output the spatial map to stdout
  console.log(JSON.stringify(map, null, 2));

  // Print stats to stderr
  console.error(`\n--- Snapshot Stats ---`);
  console.error(`URL: ${map.url}`);
  console.error(`Viewport: ${map.viewport.width}x${map.viewport.height}`);
  console.error(`Page bounds: ${map.page_bounds.width}x${map.page_bounds.height}`);
  console.error(`Total elements: ${map.stats.total_elements}`);
  console.error(`Actionable: ${map.stats.actionable_elements}`);
  console.error(`Focusable: ${map.stats.focusable_elements}`);
  console.error(`Max depth: ${map.stats.max_depth}`);
  console.error(`Snapshot time: ${elapsed}ms`);
  console.error(`JSON size: ${JSON.stringify(map).length} bytes`);

  await browser.close();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
