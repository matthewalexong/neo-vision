/**
 * NeoVision Request Queue — Per-tab serial, cross-tab parallel.
 *
 * Browser actions on the SAME tab must serialize (you can't click two things
 * in one tab at once). Actions on DIFFERENT tabs can absolutely run in
 * parallel — Chrome handles concurrent commands targeting different tabIds
 * fine, and the user's parallel typing/clicking proves humans do this all
 * day.
 *
 * Implementation: each tabId (or "global" for tab-less commands) gets its
 * own FIFO bucket. Each bucket processes serially within itself. Buckets
 * run in parallel.
 *
 * Backward-compat: callers that pass no tabId go to the "global" bucket and
 * behave exactly like the old single-queue model among themselves. A caller
 * that mixes tab-targeted and global commands gets parallelism between tabs
 * but still serializes against the global bucket — matching the old default.
 */

export interface QueuedRequest<T = any> {
  id: string;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
  enqueuedAt: number;
  timeoutMs: number;
}

export interface QueueStats {
  pending: number;
  processing: boolean;
  totalProcessed: number;
  totalErrors: number;
  avgLatencyMs: number;
}

const GLOBAL_BUCKET = "global";

export class RequestQueue {
  // One FIFO queue per bucket key. Bucket key is the tabId (string) or
  // "global" for tab-less commands.
  private buckets = new Map<string, QueuedRequest[]>();
  // Buckets currently processing an item — used to prevent concurrent
  // execution within the same bucket.
  private processingBuckets = new Set<string>();
  private counter = 0;
  private totalProcessed = 0;
  private totalErrors = 0;
  private totalLatencyMs = 0;

  /**
   * Enqueue a command for execution. If tabId is provided, the command
   * serializes only against other commands targeting the SAME tabId — it
   * runs in parallel with commands targeting different tabs.
   */
  enqueue<T>(execute: () => Promise<T>, timeoutMs = 60000, tabId?: number | string): Promise<T> {
    const id = `q_${++this.counter}_${Date.now()}`;
    const bucketKey = tabId !== undefined && tabId !== null ? String(tabId) : GLOBAL_BUCKET;

    return new Promise<T>((resolve, reject) => {
      const item: QueuedRequest<T> = {
        id,
        execute,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        timeoutMs,
      };
      let bucket = this.buckets.get(bucketKey);
      if (!bucket) {
        bucket = [];
        this.buckets.set(bucketKey, bucket);
      }
      bucket.push(item);
      this.processBucket(bucketKey);
    });
  }

  /** Process the next item in the given bucket, if not already processing it. */
  private async processBucket(bucketKey: string): Promise<void> {
    if (this.processingBuckets.has(bucketKey)) return;
    const bucket = this.buckets.get(bucketKey);
    if (!bucket || bucket.length === 0) return;

    // Global commands historically blocked everything. Preserve that semantics
    // so tab-less callers don't accidentally race against tab-targeted ones:
    // when global is processing, tab buckets pause; when global is idle, tab
    // buckets run freely.
    if (bucketKey !== GLOBAL_BUCKET && this.processingBuckets.has(GLOBAL_BUCKET)) return;

    this.processingBuckets.add(bucketKey);
    const item = bucket.shift()!;

    // Already timed out while queued?
    const waitTime = Date.now() - item.enqueuedAt;
    if (waitTime > item.timeoutMs) {
      this.totalErrors++;
      item.reject(new Error(`Request ${item.id} timed out after ${waitTime}ms in queue`));
      this.processingBuckets.delete(bucketKey);
      this.processBucket(bucketKey);
      return;
    }

    const remainingTimeout = item.timeoutMs - waitTime;
    const timer = setTimeout(() => {
      this.totalErrors++;
      item.reject(new Error(`Request ${item.id} execution timed out after ${remainingTimeout}ms`));
    }, remainingTimeout);

    try {
      const result = await item.execute();
      clearTimeout(timer);
      const latency = Date.now() - item.enqueuedAt;
      this.totalProcessed++;
      this.totalLatencyMs += latency;
      item.resolve(result);
    } catch (err) {
      clearTimeout(timer);
      this.totalErrors++;
      item.reject(err);
    } finally {
      this.processingBuckets.delete(bucketKey);
      // Continue this bucket if more items remain.
      if (bucket.length > 0) {
        setImmediate(() => this.processBucket(bucketKey));
      }
      // If we just released the global bucket, kick all tab buckets that may
      // have been paused waiting for global to finish.
      if (bucketKey === GLOBAL_BUCKET) {
        for (const key of this.buckets.keys()) {
          if (key !== GLOBAL_BUCKET) setImmediate(() => this.processBucket(key));
        }
      }
    }
  }

  /** Get queue stats */
  getStats(): QueueStats {
    let pending = 0;
    for (const b of this.buckets.values()) pending += b.length;
    return {
      pending,
      processing: this.processingBuckets.size > 0,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
      avgLatencyMs: this.totalProcessed > 0
        ? Math.round(this.totalLatencyMs / this.totalProcessed)
        : 0,
    };
  }

  /** Per-bucket stats — useful for debugging concurrency. */
  getBucketStats(): Array<{ bucket: string; pending: number; processing: boolean }> {
    const out: Array<{ bucket: string; pending: number; processing: boolean }> = [];
    for (const [key, bucket] of this.buckets.entries()) {
      out.push({
        bucket: key,
        pending: bucket.length,
        processing: this.processingBuckets.has(key),
      });
    }
    return out;
  }

  /** Drain all buckets, rejecting all pending requests */
  drain(reason = "Queue drained"): void {
    for (const bucket of this.buckets.values()) {
      for (const item of bucket) item.reject(new Error(reason));
    }
    this.buckets.clear();
  }
}
