/**
 * Jev SystemOne typed classifier (docs/11 §1, CLAUDE.md contract).
 * POST {base}{path}, Bearer key, body {model, state, questions};
 * answers come back typed — choice picks a criterion key, noul scores 0–1.
 * Jev writes nothing: no JSON repair here (a bad shape throws
 * JevValidationError deterministically). HTTP 429/5xx retry with backoff
 * honoring Retry-After; the key never enters records or error strings.
 */
import { z } from "zod";
import type { LlmCallRecord } from "./client.js";

/** State values are capped so the whole state stays within the limit. */
export const MAX_STATE_CHARS = 4000;

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria?: Record<string, string> | undefined;
}

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;
export type JevQuestions = Record<string, JevQuestion>;
export type JevState = Record<string, string>;

export type JevAnswer =
  | { kind: "choice"; choice: string; confidence: number; flags: string[] }
  | { kind: "noul"; noul: number; flags: string[] };
export type JevAnswers = Record<string, JevAnswer>;

export class JevHttpError extends Error {
  readonly status?: number | undefined;
  readonly retryAfterSeconds?: number | undefined;
  constructor(
    message: string,
    opts: { status?: number | undefined; retryAfterSeconds?: number | undefined } = {},
  ) {
    super(message);
    this.name = "JevHttpError";
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export class JevTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevTimeoutError";
  }
}

export class JevValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevValidationError";
  }
}

/** Run budget exhausted — the run goes partial, items stay pending (no fallback). */
export class JevBudgetExceeded extends Error {
  readonly spentUsd: number;
  constructor(spentUsd: number, budgetUsd: number) {
    super(`Jev run budget exceeded: spent $${spentUsd.toFixed(4)} of $${budgetUsd.toFixed(2)}`);
    this.name = "JevBudgetExceeded";
    this.spentUsd = spentUsd;
  }
}

export interface JevClientOptions {
  baseUrl: string;
  path?: string | undefined;
  apiKey: string;
  model: string;
  /** Max parallel classifications. Default 8 (JEV_CONCURRENCY). */
  concurrency?: number | undefined;
  /** Price per million input tokens. Answers are free. Default 0.04. */
  pricePerMInput?: number | undefined;
  /** Stop classifying past this spend. Default 1.00. */
  budgetUsd?: number | undefined;
  timeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
  baseDelayMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  onCall?: ((record: LlmCallRecord) => void) | undefined;
}

export interface ClassifyResult {
  answers: JevAnswers;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
  latencyMs: number;
}

/** Tiny semaphore — also the unit under test for LLM-14. */
export function createSemaphore(slots: number): {
  acquire: () => Promise<() => void>;
  inFlight: () => number;
} {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    inFlight: () => active,
    acquire: () => {
      if (active < slots) {
        active += 1;
        return Promise.resolve(() => {
          release();
        });
      }
      return new Promise<() => void>((resolve) => {
        waiting.push(() => {
          active += 1;
          resolve(() => {
            release();
          });
        });
      });
      function release(): void {
        active -= 1;
        waiting.shift()?.();
      }
    },
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number(),
});
const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number() });
const JevResponse = z.object({ answers: z.record(z.union([ChoiceAnswer, NoulAnswer])) });
type RawJevAnswer = z.infer<typeof ChoiceAnswer> | z.infer<typeof NoulAnswer>;

export class JevClient {
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly semaphore: ReturnType<typeof createSemaphore>;
  private readonly pricePerMInput: number;
  private readonly budgetUsd: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onCall?: ((record: LlmCallRecord) => void) | undefined;
  private spent = 0;

  constructor(options: JevClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.path = options.path ?? "/v1/systemone";
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.semaphore = createSemaphore(options.concurrency ?? 8);
    this.pricePerMInput = options.pricePerMInput ?? 0.04;
    this.budgetUsd = options.budgetUsd ?? 1.0;
    this.timeoutMs = options.timeoutMs ?? 90000;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.onCall = options.onCall;
  }

  get modelId(): string {
    return this.model;
  }

  /** Spend so far this run (answers are free; input priced per estimate). */
  get spentUsd(): number {
    return this.spent;
  }

  async classify(
    state: JevState,
    questions: JevQuestions,
    tag = "jev_classify",
  ): Promise<ClassifyResult> {
    const release = await this.semaphore.acquire();
    const started = this.now();
    try {
      const capped = capState(state);
      const stateChars = JSON.stringify(capped).length;
      const tokensIn = Math.max(1, Math.ceil(stateChars / 4));
      const costUsd = (tokensIn / 1_000_000) * this.pricePerMInput;
      if (this.spent + costUsd > this.budgetUsd) {
        throw new JevBudgetExceeded(this.spent, this.budgetUsd);
      }
      const body = await this.post({ model: this.model, state: capped, questions }, tag, started);
      const answers = coerceAll(questions, body.answers);
      this.spent += costUsd;
      this.report({
        tag,
        status: "ok",
        tokensIn,
        tokensOut: 0,
        latencyMs: this.now() - started,
        attempt: body.attempts,
        costUsd,
      });
      return { answers, tokensIn, tokensOut: 0, costUsd, model: this.model, latencyMs: this.now() - started };
    } finally {
      release();
    }
  }

  private report(record: Omit<LlmCallRecord, "client" | "model">): void {
    this.onCall?.({ ...record, client: "jev", model: this.model });
  }

  private async post(
    body: { model: string; state: JevState; questions: JevQuestions },
    tag: string,
    started: number,
  ): Promise<{ answers: Record<string, RawJevAnswer>; attempts: number }> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response: Response;
      try {
        response = await this.postWithTimeout(body, this.timeoutMs);
      } catch (error) {
        if (!isAbort(error)) throw new JevHttpError(`jev request failed: ${messageOf(error)}`, {});
        if (attempt >= this.maxAttempts) {
          this.report({ tag, status: "timeout", tokensIn: 0, tokensOut: 0, latencyMs: this.now() - started, attempt, error: `timed out after ${String(this.timeoutMs)}ms` });
          throw new JevTimeoutError(`jev request timed out after ${String(this.timeoutMs)}ms`);
        }
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= this.maxAttempts) {
          this.report({ tag, status: "http_error", httpStatus: response.status, tokensIn: 0, tokensOut: 0, latencyMs: this.now() - started, attempt, error: `HTTP ${String(response.status)}` });
          throw new JevHttpError(`jev request failed with HTTP ${String(response.status)}`, {
            status: response.status,
            retryAfterSeconds: retryAfterOf(response),
          });
        }
        await this.sleep(backoffDelay(this.baseDelayMs, attempt, retryAfterOf(response)));
        continue;
      }
      if (!response.ok) {
        this.report({ tag, status: "http_error", httpStatus: response.status, tokensIn: 0, tokensOut: 0, latencyMs: this.now() - started, attempt, error: `HTTP ${String(response.status)}` });
        throw new JevHttpError(`jev request failed with HTTP ${String(response.status)}`, { status: response.status });
      }
      const parsed = JevResponse.safeParse((await response.json()) as unknown);
      if (!parsed.success) {
        this.report({ tag, status: "invalid", httpStatus: response.status, tokensIn: 0, tokensOut: 0, latencyMs: this.now() - started, attempt, error: "unreadable answers envelope" });
        throw new JevValidationError("jev response had no readable answers envelope");
      }
      return { answers: parsed.data.answers, attempts: attempt };
    }
  }

  private async postWithTimeout(body: unknown, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.apiKey !== "") headers["authorization"] = `Bearer ${this.apiKey}`;
      return await this.fetchImpl(`${this.baseUrl}${this.path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Truncate each value to an equal share so total state stays within budget. */
export function capState(state: JevState): JevState {
  const keys = Object.keys(state);
  if (keys.length === 0) return {};
  const share = Math.max(1, Math.floor(MAX_STATE_CHARS / keys.length));
  const out: JevState = {};
  for (const key of keys) out[key] = (state[key] ?? "").slice(0, share);
  return out;
}

/** Apply one raw answer (or absence) with the Step-3 coercion rules. */
export function coerceAnswer(
  question: JevQuestion,
  raw: { type: "choice"; choice: string; confidence: number } | { type: "noul"; noul: number } | undefined,
): JevAnswer {
  if (question.type === "noul") {
    if (raw?.type !== "noul" || !Number.isFinite(raw.noul)) {
      return { kind: "noul", noul: 0, flags: ["label_missing"] };
    }
    if (raw.noul < 0 || raw.noul > 1) {
      return { kind: "noul", noul: Math.min(1, Math.max(0, raw.noul)), flags: ["noul_clamped"] };
    }
    return { kind: "noul", noul: raw.noul, flags: [] };
  }
  if (raw?.type !== "choice") {
    return { kind: "choice", choice: "none", confidence: 0, flags: ["label_missing"] };
  }
  const keys = question.criteria === undefined ? undefined : Object.keys(question.criteria);
  const confidence = Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0;
  if (keys !== undefined && !keys.includes(raw.choice)) {
    return { kind: "choice", choice: "none", confidence: 0, flags: ["choice_coerced"] };
  }
  return { kind: "choice", choice: raw.choice, confidence, flags: [] };
}

function coerceAll(questions: JevQuestions, answers: Record<string, RawJevAnswer>): JevAnswers {
  const out: JevAnswers = {};
  for (const [name, question] of Object.entries(questions)) {
    const raw = answers[name];
    out[name] =
      raw === undefined
        ? coerceAnswer(question, undefined)
        : raw.type === "choice"
          ? coerceAnswer(question, { type: "choice", choice: raw.choice, confidence: raw.confidence })
          : coerceAnswer(question, { type: "noul", noul: raw.noul });
  }
  return out;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryAfterOf(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function backoffDelay(baseMs: number, attempt: number, retryAfterSeconds: number | undefined): number {
  const backoff = baseMs * 2 ** (attempt - 1);
  if (retryAfterSeconds !== undefined) return Math.max(backoff, Math.round(retryAfterSeconds * 1000));
  return backoff;
}
