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
export declare class PacingEngine {
    private config;
    private pageCount;
    private batchPage;
    private batchNumber;
    private captchaCount;
    private consecutiveCaptchas;
    private successCount;
    private slowdownFactor;
    private sessionStart;
    private totalDelay;
    private lastInstruction;
    constructor(config?: PacingConfig);
    /**
     * Get the next pacing instruction.
     * Call this BEFORE each page navigation.
     */
    next(): PacingInstruction;
    /**
     * Record a successful page extraction.
     * Call this AFTER successfully extracting data from a page.
     */
    recordSuccess(): void;
    /**
     * Record a CAPTCHA encounter.
     * Call this when a page returns a CAPTCHA instead of content.
     */
    recordCaptcha(): void;
    /**
     * Reset the consecutive CAPTCHA counter.
     * Call this after the user manually solves a CAPTCHA.
     */
    recordCaptchaSolved(): void;
    /**
     * Get current session statistics.
     */
    getStats(): PacingStats;
    /**
     * Get the last instruction (for resuming after a break).
     */
    getLastInstruction(): PacingInstruction | null;
    /**
     * Estimate total time for N remaining pages.
     */
    estimateTime(remainingPages: number): {
        totalMs: number;
        totalHuman: string;
        batches: number;
        breaks: number;
    };
    private randomDelay;
    private randomBetween;
    private formatMs;
}
export declare const CAPTCHA_DETECTOR_SOURCE: string;
/**
 * Returns the CAPTCHA detector as a ready-to-inject JS string.
 */
export declare function getCaptchaDetector(): string;
