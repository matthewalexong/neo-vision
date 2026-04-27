/**
 * RequestQueue Tests — Red-Green TDD
 *
 * Tests cover:
 * 1. FIFO serialization — commands execute one at a time, in order
 * 2. Queue timeout — requests that wait too long in queue get rejected
 * 3. Execution timeout — requests that take too long to execute get rejected
 * 4. Double-rejection guard — both timeouts firing should not crash
 * 5. Drain — all pending requests get rejected
 * 6. Stats tracking — processed/error counts are accurate
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RequestQueue } from "../queue.js";

describe("RequestQueue", () => {
  let queue: RequestQueue;

  beforeEach(() => {
    queue = new RequestQueue();
  });

  // ─── FIFO Serialization ────────────────────────────────────────

  it("executes requests one at a time in FIFO order", async () => {
    const order: number[] = [];

    const p1 = queue.enqueue(async () => {
      order.push(1);
      await sleep(50);
      return "a";
    });
    const p2 = queue.enqueue(async () => {
      order.push(2);
      return "b";
    });
    const p3 = queue.enqueue(async () => {
      order.push(3);
      return "c";
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");
    expect(r3).toBe("c");
    expect(order).toEqual([1, 2, 3]);
  });

  it("does not run the next request until the current one finishes", async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await sleep(30);
      concurrentCount--;
      return true;
    };

    await Promise.all([
      queue.enqueue(task),
      queue.enqueue(task),
      queue.enqueue(task),
    ]);

    expect(maxConcurrent).toBe(1);
  });

  // ─── Timeout: Waiting in Queue ─────────────────────────────────

  it("rejects a request that waits too long in the queue", async () => {
    // First request blocks for 200ms. Second has a 50ms timeout.
    const p1 = queue.enqueue(async () => {
      await sleep(200);
      return "done";
    }, 5000);

    const p2 = queue.enqueue(async () => "should not run", 50);

    await expect(p2).rejects.toThrow(/timed out/i);
    await p1; // first should still complete
  });

  // ─── Timeout: Execution ────────────────────────────────────────

  it("rejects a request whose execution exceeds the timeout", async () => {
    const p = queue.enqueue(async () => {
      await sleep(500);
      return "too slow";
    }, 50);

    await expect(p).rejects.toThrow(/timed out/i);
  });

  // ─── Double-Rejection Guard ────────────────────────────────────
  // If a request times out in the queue AND the execution also errors,
  // the promise should only reject once (no unhandled rejection).

  it("does not double-reject when both queue and execution timeout fire", async () => {
    // Block the queue so the second item waits
    const blocker = queue.enqueue(async () => {
      await sleep(150);
      return "blocking";
    }, 5000);

    // This one has a very short timeout — it will timeout waiting in queue
    // AND if it somehow starts, the execution would also be slow.
    let rejected = 0;
    const p = queue.enqueue(async () => {
      await sleep(500);
      return "never";
    }, 30);

    try {
      await p;
    } catch {
      rejected++;
    }

    await blocker;
    expect(rejected).toBe(1); // exactly one rejection, not two
  });

  // ─── Drain ─────────────────────────────────────────────────────

  it("rejects all pending requests when drained", async () => {
    // Block queue so items pile up
    const blocker = queue.enqueue(async () => {
      await sleep(200);
      return "blocking";
    }, 5000);

    const p1 = queue.enqueue(async () => "a");
    const p2 = queue.enqueue(async () => "b");

    // Drain while blocker is running
    await sleep(10);
    queue.drain("test drain");

    await expect(p1).rejects.toThrow("test drain");
    await expect(p2).rejects.toThrow("test drain");
    // Blocker should still complete (it's already executing)
    await expect(blocker).resolves.toBe("blocking");
  });

  // ─── Stats ─────────────────────────────────────────────────────

  it("tracks processed count and errors accurately", async () => {
    await queue.enqueue(async () => "ok");
    await queue.enqueue(async () => "ok2");

    try {
      await queue.enqueue(async () => {
        throw new Error("fail");
      });
    } catch {}

    const stats = queue.getStats();
    expect(stats.totalProcessed).toBe(2);
    expect(stats.totalErrors).toBe(1);
    expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports pending count correctly", async () => {
    // Block queue
    const blocker = queue.enqueue(async () => {
      await sleep(100);
      return true;
    });

    queue.enqueue(async () => true);
    queue.enqueue(async () => true);

    await sleep(10); // let blocker start
    const stats = queue.getStats();
    expect(stats.pending).toBe(2);
    expect(stats.processing).toBe(true);

    await blocker;
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
