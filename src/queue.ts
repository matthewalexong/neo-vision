/**
 * NeoVision Request Queue — Serializes all browser commands.
 *
 * Only one browser action can happen at a time (you can't click two things
 * simultaneously in a single Chrome tab). This queue ensures that regardless
 * of how many clients (MCP instances, HTTP API callers, external bots) are
 * sending commands, they execute one at a time in FIFO order.
 *
 * Each queued item gets a unique ticket ID so callers can track their request.
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

export class RequestQueue {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private counter = 0;
  private totalProcessed = 0;
  private totalErrors = 0;
  private totalLatencyMs = 0;

  /**
   * Enqueue a command for serial execution.
   * Returns a promise that resolves with the command's result.
   */
  enqueue<T>(execute: () => Promise<T>, timeoutMs = 60000): Promise<T> {
    const id = `q_${++this.counter}_${Date.now()}`;

    return new Promise<T>((resolve, reject) => {
      const item: QueuedRequest<T> = {
        id,
        execute,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        timeoutMs,
      };

      this.queue.push(item);
      this.processNext();
    });
  }

  /** Process the next item in the queue (if not already processing) */
  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const item = this.queue.shift()!;

    // Check if this request has already timed out while waiting in the queue
    const waitTime = Date.now() - item.enqueuedAt;
    if (waitTime > item.timeoutMs) {
      this.totalErrors++;
      item.reject(new Error(`Request ${item.id} timed out after ${waitTime}ms in queue`));
      this.processing = false;
      this.processNext();
      return;
    }

    // Set a timeout for the actual execution
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
      this.processing = false;
      // Process next item (use setImmediate to avoid stack overflow on long queues)
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }

  /** Get queue stats */
  getStats(): QueueStats {
    return {
      pending: this.queue.length,
      processing: this.processing,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
      avgLatencyMs: this.totalProcessed > 0
        ? Math.round(this.totalLatencyMs / this.totalProcessed)
        : 0,
    };
  }

  /** Drain the queue, rejecting all pending requests */
  drain(reason = "Queue drained"): void {
    for (const item of this.queue) {
      item.reject(new Error(reason));
    }
    this.queue = [];
  }
}
