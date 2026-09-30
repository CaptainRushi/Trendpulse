/**
 * Single-writer queue for the Sheets API. All writes funnel through one
 * instance: tasks run strictly in order (concurrency 1), consecutive API
 * calls are spaced by minGapMs (per-minute quota), and 429/5xx failures are
 * retried with exponential backoff that honors Retry-After. 403/400 surface
 * immediately — retrying those only burns quota and hides config errors.
 */
import { SheetsApiError, isRetryableSheetsError } from "./client.js";

export interface SheetsQueueOptions {
  /** Minimum gap between the *start* of consecutive API calls. Default 1100. */
  minGapMs?: number;
  /** Total attempts per task including the first. Default 4 (1 + 3 retries). */
  maxAttempts?: number;
  /** First backoff delay; doubles per retry. Default 1000. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SheetsWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStartAt = 0;
  private readonly minGapMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: SheetsQueueOptions = {}) {
    this.minGapMs = options.minGapMs ?? 1100;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  /**
   * Run task after all previously enqueued tasks settle. A rejected task
   * rejects its own promise but never breaks the chain for later tasks.
   */
  enqueue<T>(label: string, task: () => Promise<T>): Promise<T> {
    const run: Promise<T> = this.tail.then(() => this.execute(label, task));
    // Swallow here so the shared tail stays alive; the caller still sees it.
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async execute<T>(label: string, task: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.waitForGap();
      this.lastStartAt = this.now();
      try {
        return await task();
      } catch (error) {
        if (!isRetryableSheetsError(error) || attempt >= this.maxAttempts) {
          throw enrichError(label, attempt, error);
        }
        await this.sleep(this.retryDelayMs(error, attempt));
      }
    }
  }

  private async waitForGap(): Promise<void> {
    const elapsed = this.now() - this.lastStartAt;
    // lastStartAt starts at 0, so the very first call never waits.
    if (this.lastStartAt !== 0 && elapsed < this.minGapMs) {
      await this.sleep(this.minGapMs - elapsed);
    }
  }

  private retryDelayMs(error: unknown, attempt: number): number {
    const backoff = this.baseDelayMs * 2 ** (attempt - 1);
    const retryAfter =
      error !== null && typeof error === "object" && "retryAfterSeconds" in error
        ? (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
        : undefined;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
      // Honor the server's ask when it exceeds our backoff; never shorten it.
      return Math.max(backoff, Math.round(retryAfter * 1000));
    }
    return backoff;
  }
}

/**
 * Add attempt context without changing the error's identity: SheetsApiError
 * stays a SheetsApiError (status/code intact) so callers can still branch on
 * RANGE_NOT_FOUND for the auto-reinit path.
 */
function enrichError(label: string, attempt: number, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const message = `sheets write '${label}' failed (attempt ${String(attempt)}): ${detail}`;
  if (error instanceof SheetsApiError) {
    return new SheetsApiError(message, {
      status: error.status,
      errorCode: error.errorCode,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }
  return new Error(message, { cause: error });
}
