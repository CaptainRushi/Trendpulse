import { describe, expect, it } from "vitest";
import { SheetsApiError } from "../../src/sheets/client.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";

function quotaError(retryAfterSeconds?: number): SheetsApiError {
  return new SheetsApiError("Quota exceeded", { status: 429, retryAfterSeconds });
}

describe("SheetsWriteQueue", () => {
  it("runs tasks one at a time in enqueue order", async () => {
    const queue = new SheetsWriteQueue({ minGapMs: 0 });
    const order: string[] = [];
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((label) =>
        queue.enqueue(label, async () => {
          order.push(label);
        }),
      ),
    );
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("enforces the minimum gap between write calls", async () => {
    const queue = new SheetsWriteQueue({ minGapMs: 80 });
    const started: number[] = [];
    const task = async (): Promise<void> => {
      started.push(Date.now());
    };
    await queue.enqueue("one", task);
    await queue.enqueue("two", task);
    expect(started).toHaveLength(2);
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(60);
  });

  it("retries a 429 then succeeds", async () => {
    const queue = new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() });
    let attempts = 0;
    const result = await queue.enqueue("quota", async () => {
      attempts += 1;
      if (attempts < 3) throw quotaError();
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("honors Retry-After over the computed backoff", async () => {
    const slept: number[] = [];
    const queue = new SheetsWriteQueue({
      minGapMs: 0,
      baseDelayMs: 1000,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    let attempts = 0;
    await queue.enqueue("retry-after", async () => {
      attempts += 1;
      if (attempts === 1) throw quotaError(5);
    });
    expect(slept).toEqual([5000]);
  });

  it("uses exponential backoff without Retry-After (1s, 2s)", async () => {
    const slept: number[] = [];
    const queue = new SheetsWriteQueue({
      minGapMs: 0,
      baseDelayMs: 1000,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    let attempts = 0;
    await queue.enqueue("backoff", async () => {
      attempts += 1;
      if (attempts < 3) throw new SheetsApiError("Server error", { status: 500 });
    });
    expect(slept).toEqual([1000, 2000]);
  });

  it("throws immediately on non-retryable errors (403)", async () => {
    const queue = new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() });
    let attempts = 0;
    await expect(
      queue.enqueue("forbidden", async () => {
        attempts += 1;
        throw new SheetsApiError("Forbidden", { status: 403 });
      }),
    ).rejects.toThrow("Forbidden");
    expect(attempts).toBe(1);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const queue = new SheetsWriteQueue({
      minGapMs: 0,
      maxAttempts: 2,
      sleep: () => Promise.resolve(),
    });
    let attempts = 0;
    await expect(
      queue.enqueue("doomed", async () => {
        attempts += 1;
        throw new SheetsApiError("Flaky", { status: 503 });
      }),
    ).rejects.toThrow("Flaky");
    expect(attempts).toBe(2);
  });

  it("a failing task does not break later tasks", async () => {
    const queue = new SheetsWriteQueue({ minGapMs: 0, sleep: () => Promise.resolve() });
    await expect(
      queue.enqueue("bad", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(queue.enqueue("good", async () => "fine")).resolves.toBe("fine");
  });
});
