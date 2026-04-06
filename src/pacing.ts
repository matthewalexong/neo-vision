/**
 * NeoVision Pacing Engine
 *
 * Human-like throttling for multi-page scraping sessions.
 * Designed for the hybrid mode (injectable + Claude in Chrome)
 * where you're navigating through the user's real browser and
 * need to avoid triggering anti-bot systems like DataDome.
 *
 * The core insight: anti-bot systems don't just look at speed —
 * they look at PATTERNS. A human doesn't visit pages in a
 * perfectly timed loop. They pause to read, sometimes scroll,
 * occasionally take longer breaks. This module reproduces that
 * natural variance.
 *
 * Usage via MCP:
 *   1. Call spatial_pace with action: "start" to begin a session
 *   2. Before each page, call spatial_pace with action: "next"
 *      — it returns the delay to wait and whether to take a break
 *   3. After the session, call spatial_pace with action: "end"
 *
 * Usage programmatically:
 *   import { PacingEngine } from 'neo-vision';
 *   const pacer = new PacingEngine({ batchSize: 12, minDelay: 3000 });
 *   for (const url of urls) {
 *     const instruction = pacer.next();
 *     await sleep(instruction.delay);
 *     if (instruction.action === 'break') await sleep(instruction.breakDuration!);
 *     // ... navigate and extract ...
 *     pacer.recordSuccess(); // or pacer.recordCaptcha()
 *   }
 */

// ─── Configuration ────────────────────────────────────────────────

export interface PacingConfig {
  /** Min delay between pages in ms. Default: 3000 (3s) */
  minDelay?: number;
  /** Max delay between pages in ms. Default: 12000 (12s) */
  maxDelay?: number;
  /** Pages per batch before a longer break. Default: 10 */
  batchSize?: number;
  /** Min break duration between batches in ms. Default: 60000 (1min) */
  minBreak?: number;
  /** Max break duration between batches in ms. Default: 180000 (3min) */
  maxBreak?: number;
  /** Probability of an extra-long "reading" pause (0-1). Default: 0.15 */
  readingPauseProbability?: number;
  /** Duration range for reading pauses [min, max] in ms. Default: [8000, 20000] */
  readingPauseRange?: [number, number];
  /** How much to slow down after a CAPTCHA (multiplier). Default: 2.5 */
  captchaSlowdownFactor?: number;
  /** Max consecutive CAPTCHAs before stopping. Default: 2 */
  maxConsecutiveCaptchas?: number;
}

const DEFAULTS: Required<PacingConfig> = {
  minDelay: 3000,
  maxDelay: 12000,
  batchSize: 10,
  minBreak: 60000,
  maxBreak: 180000,
  readingPauseProbability: 0.15,
  readingPauseRange: [8000, 20000],
  captchaSlowdownFactor: 2.5,
  maxConsecutiveCaptchas: 2,
};

// ─── Pacing Instruction ──────────────────────────────────────────

export interface PacingInstruction {
  /** What to do: "continue" = wait then proceed, "break" = take a longer break, "stop" = too many CAPTCHAs */
  action: "continue" | "break" | "stop";
  /** Milliseconds to wait before the next page */
  delay: number;
  /** Human-readable delay (e.g., "4.2s") */
  delayHuman: string;
  /** If action is "break", how long the break should be */
  breakDuration?: number;
  /** Human-readable break duration */
  breakHuman?: string;
  /** Current page number in session */
  pageNumber: number;
  /** Current page number in batch */
  batchPage: number;
  /** Current batch number */
  batchNumber: number;
  /** Pages remaining in current batch before next break */
  pagesUntilBreak: number;
  /** Whether this delay includes an extra "reading pause" */
  hasReadingPause: boolean;
  /** Session stats */
  stats: PacingStats;
  /** Why this instruction was given */
  reason: string;
}

export interface PacingStats {
  totalPages: number;
  totalCaptchas: number;
  consecutiveCaptchas: number;
  totalSuccesses: number;
  sessionStarted: string;
  elapsedMs: number;
  currentSlowdownFactor: number;
  avgDelayMs: number;
}

// ─── Engine ──────────────────────────────────────────────────────

export class PacingEngine {
  private config: Required<PacingConfig>;
  private pageCount = 0;
  private batchPage = 0;
  private batchNumber = 1;
  private captchaCount = 0;
  private consecutiveCaptchas = 0;
  private successCount = 0;
  private slowdownFactor = 1.0;
  private sessionStart: Date;
  private totalDelay = 0;
  private lastInstruction: PacingInstruction | null = null;

  constructor(config?: PacingConfig) {
    this.config = { ...DEFAULTS, ...config };
    this.sessionStart = new Date();
  }

  /**
   * Get the next pacing instruction.
   * Call this BEFORE each page navigation.
   */
  next(): PacingInstruction {
    this.pageCount++;
    this.batchPage++;

    // Check if we should stop due to too many CAPTCHAs
    if (this.consecutiveCaptchas >= this.config.maxConsecutiveCaptchas) {
      const instruction: PacingInstruction = {
        action: "stop",
        delay: 0,
        delayHuman: "0s",
        pageNumber: this.pageCount,
        batchPage: this.batchPage,
        batchNumber: this.batchNumber,
        pagesUntilBreak: 0,
        hasReadingPause: false,
        stats: this.getStats(),
        reason: `Stopped: ${this.consecutiveCaptchas} consecutive CAPTCHAs detected. The site is actively blocking. Wait 10+ minutes or solve the CAPTCHA manually before resuming.`,
      };
      this.lastInstruction = instruction;
      return instruction;
    }

    // Check if we need a batch break
    if (this.batchPage > this.config.batchSize) {
      const breakDuration = this.randomBetween(
        this.config.minBreak * this.slowdownFactor,
        this.config.maxBreak * this.slowdownFactor
      );
      const delay = this.randomDelay();

      this.batchPage = 1;
      this.batchNumber++;

      const instruction: PacingInstruction = {
        action: "break",
        delay,
        delayHuman: this.formatMs(delay),
        breakDuration,
        breakHuman: this.formatMs(breakDuration),
        pageNumber: this.pageCount,
        batchPage: this.batchPage,
        batchNumber: this.batchNumber,
        pagesUntilBreak: this.config.batchSize,
        hasReadingPause: false,
        stats: this.getStats(),
        reason: `Batch ${this.batchNumber - 1} complete (${this.config.batchSize} pages). Taking a ${this.formatMs(breakDuration)} break to look human. Then wait ${this.formatMs(delay)} before page ${this.pageCount}.`,
      };

      this.totalDelay += delay + breakDuration;
      this.lastInstruction = instruction;
      return instruction;
    }

    // Normal page — calculate randomized delay
    let delay = this.randomDelay();
    let hasReadingPause = false;

    // Random "reading pause" — simulates a human who stopped to read
    if (Math.random() < this.config.readingPauseProbability) {
      const [minPause, maxPause] = this.config.readingPauseRange;
      const readingPause = this.randomBetween(minPause, maxPause);
      delay += readingPause;
      hasReadingPause = true;
    }

    const pagesUntilBreak = this.config.batchSize - this.batchPage;

    const instruction: PacingInstruction = {
      action: "continue",
      delay,
      delayHuman: this.formatMs(delay),
      pageNumber: this.pageCount,
      batchPage: this.batchPage,
      batchNumber: this.batchNumber,
      pagesUntilBreak,
      hasReadingPause,
      stats: this.getStats(),
      reason: hasReadingPause
        ? `Page ${this.pageCount} (batch ${this.batchNumber}, ${this.batchPage}/${this.config.batchSize}). Wait ${this.formatMs(delay)} (includes reading pause). ${pagesUntilBreak} pages until break.`
        : `Page ${this.pageCount} (batch ${this.batchNumber}, ${this.batchPage}/${this.config.batchSize}). Wait ${this.formatMs(delay)}. ${pagesUntilBreak} pages until break.`,
    };

    this.totalDelay += delay;
    this.lastInstruction = instruction;
    return instruction;
  }

  /**
   * Record a successful page extraction.
   * Call this AFTER successfully extracting data from a page.
   */
  recordSuccess(): void {
    this.successCount++;
    this.consecutiveCaptchas = 0;
    // Gradually ease back toward normal speed after CAPTCHAs
    if (this.slowdownFactor > 1.0) {
      this.slowdownFactor = Math.max(1.0, this.slowdownFactor * 0.85);
    }
  }

  /**
   * Record a CAPTCHA encounter.
   * Call this when a page returns a CAPTCHA instead of content.
   */
  recordCaptcha(): void {
    this.captchaCount++;
    this.consecutiveCaptchas++;
    this.slowdownFactor *= this.config.captchaSlowdownFactor;
  }

  /**
   * Reset the consecutive CAPTCHA counter.
   * Call this after the user manually solves a CAPTCHA.
   */
  recordCaptchaSolved(): void {
    this.consecutiveCaptchas = 0;
    // Keep the slowdown factor elevated but reduce it somewhat
    this.slowdownFactor = Math.max(1.5, this.slowdownFactor * 0.6);
  }

  /**
   * Get current session statistics.
   */
  getStats(): PacingStats {
    const elapsed = Date.now() - this.sessionStart.getTime();
    return {
      totalPages: this.pageCount,
      totalCaptchas: this.captchaCount,
      consecutiveCaptchas: this.consecutiveCaptchas,
      totalSuccesses: this.successCount,
      sessionStarted: this.sessionStart.toISOString(),
      elapsedMs: elapsed,
      currentSlowdownFactor: Math.round(this.slowdownFactor * 100) / 100,
      avgDelayMs: this.pageCount > 0 ? Math.round(this.totalDelay / this.pageCount) : 0,
    };
  }

  /**
   * Get the last instruction (for resuming after a break).
   */
  getLastInstruction(): PacingInstruction | null {
    return this.lastInstruction;
  }

  /**
   * Estimate total time for N remaining pages.
   */
  estimateTime(remainingPages: number): { totalMs: number; totalHuman: string; batches: number; breaks: number } {
    const avgDelay = this.pageCount > 0
      ? this.totalDelay / this.pageCount
      : (this.config.minDelay + this.config.maxDelay) / 2;
    const batches = Math.ceil(remainingPages / this.config.batchSize);
    const breaks = Math.max(0, batches - 1);
    const avgBreak = (this.config.minBreak + this.config.maxBreak) / 2;
    const totalMs = Math.round(remainingPages * avgDelay + breaks * avgBreak);
    return {
      totalMs,
      totalHuman: this.formatMs(totalMs),
      batches,
      breaks,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────

  private randomDelay(): number {
    return this.randomBetween(
      this.config.minDelay * this.slowdownFactor,
      this.config.maxDelay * this.slowdownFactor
    );
  }

  private randomBetween(min: number, max: number): number {
    return Math.round(min + Math.random() * (max - min));
  }

  private formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
}

// ─── CAPTCHA Detection Helper ────────────────────────────────────
//
// Injectable JS snippet that checks if the current page is a
// CAPTCHA/block page instead of real content. Run this after
// navigation to detect if you've been flagged.

export const CAPTCHA_DETECTOR_SOURCE = `
(function() {
  var signals = {
    hasDataDome: !!document.querySelector('iframe[src*="captcha-delivery"], iframe[src*="datadome"], #datadome-popup'),
    hasRecaptcha: !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]'),
    hasHCaptcha: !!document.querySelector('.h-captcha, iframe[src*="hcaptcha"]'),
    hasCloudflareTurnstile: !!document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare"]'),
    titleSuggestsBlock: /verify|captcha|blocked|denied|robot|security check|access denied/i.test(document.title),
    bodyTextSuggestsBlock: false,
    hasNoMainContent: false
  };
  var bodyText = (document.body && document.body.innerText || "").substring(0, 500).toLowerCase();
  signals.bodyTextSuggestsBlock = /please verify|are you a robot|unusual traffic|automated access|captcha|blocked your ip|access denied/i.test(bodyText);
  var main = document.querySelector('main, [role="main"], #content, .content, article');
  signals.hasNoMainContent = !main || (main.textContent || "").trim().length < 50;
  var isCaptcha = signals.hasDataDome || signals.hasRecaptcha || signals.hasHCaptcha ||
                  signals.hasCloudflareTurnstile || signals.titleSuggestsBlock ||
                  (signals.bodyTextSuggestsBlock && signals.hasNoMainContent);
  return JSON.stringify({
    is_captcha: isCaptcha,
    signals: signals,
    url: window.location.href,
    title: document.title
  });
})()
`.trim();

/**
 * Returns the CAPTCHA detector as a ready-to-inject JS string.
 */
export function getCaptchaDetector(): string {
  return CAPTCHA_DETECTOR_SOURCE;
}
