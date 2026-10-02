/**
 * OpenAI-compatible chat client shared by the extractor and Jev.
 * Implements TRD §5 exactly: response_format json_object, fence stripping,
 * zod validation, ONE repair call at temperature 0, then LlmValidationError
 * (the caller splits the batch — never a run crash). Network/5xx/429 are
 * retried with exponential backoff honoring Retry-After. One llm_calls row
 * is reported per completed POST (initial + repair carry their own token
 * usage) plus one row for a terminal network failure. Prompt bodies never
 * enter the log record type, so full prompts are unloggable by construction.
 */
import { z } from "zod";

export type LlmClientName = "extractor" | "jev";
export type LlmCallStatus = "ok" | "invalid" | "http_error" | "timeout";

export class LlmHttpError extends Error {
  readonly status?: number | undefined;
  readonly retryAfterSeconds?: number | undefined;
  constructor(
    message: string,
    opts: { status?: number | undefined; retryAfterSeconds?: number | undefined } = {},
  ) {
    super(message);
    this.name = "LlmHttpError";
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmTimeoutError";
  }
}

export class LlmValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmValidationError";
  }
}

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface LlmCallRecord {
  tag: string;
  client: LlmClientName;
  model: string;
  status: LlmCallStatus;
  httpStatus?: number | undefined;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  attempt: number;
  error?: string | undefined;
  /** Estimated spend (Jev input pricing). Absent for pre-cost callers. */
  costUsd?: number | undefined;
}

export interface LlmClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  clientName: LlmClientName;
  timeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
  baseDelayMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  onCall?: ((record: LlmCallRecord) => void) | undefined;
}

export interface JsonRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  tag: string;
}

export interface JsonResult<T> {
  data: T;
  usage: LlmUsage;
  model: string;
  latencyMs: number;
  repaired: boolean;
}

interface ChatContent {
  content: string | null;
  usage: LlmUsage;
  httpStatus: number;
  /** Set when the 200 envelope itself was unreadable (gateway glitch). */
  envelopeError?: string | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Bound the raw reply quoted back in the repair prompt. */
const MAX_QUOTED_REPLY = 4000;

export class LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly clientName: LlmClientName;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onCall?: ((record: LlmCallRecord) => void) | undefined;

  constructor(options: LlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.clientName = options.clientName;
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

  /**
   * One logical JSON call: initial attempt + at most one repair.
   * Network failures retry inside each POST; validation failures never do
   * (a retry would return the same bad JSON — repair once, then throw).
   */
  async json<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
    const started = this.now();
    const timeout = request.timeoutMs ?? this.timeoutMs;
    const first = await this.postWithRetry(
      request.tag,
      [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      request.temperature,
      request.maxTokens,
      timeout,
      started,
    );
    const firstParsed = parseContent(request.schema, first);
    if (firstParsed.ok) {
      this.report({
        tag: request.tag,
        status: "ok",
        httpStatus: first.httpStatus,
        tokensIn: first.usage.tokensIn,
        tokensOut: first.usage.tokensOut,
        latencyMs: this.now() - started,
        attempt: 1,
      });
      return {
        data: firstParsed.data,
        usage: first.usage,
        model: this.model,
        latencyMs: this.now() - started,
        repaired: false,
      };
    }
    this.report({
      tag: request.tag,
      status: "invalid",
      httpStatus: first.httpStatus,
      tokensIn: first.usage.tokensIn,
      tokensOut: first.usage.tokensOut,
      latencyMs: this.now() - started,
      attempt: 1,
      error: firstParsed.error,
    });

    const repairUser =
      `The previous reply was not valid JSON. Validation error: ${firstParsed.error}\n` +
      `Previous reply (fix it, keep the same content):\n${first.content?.slice(0, MAX_QUOTED_REPLY) ?? "(empty)"}\n` +
      `Return the same content as valid JSON matching the schema. JSON only.`;
    const second = await this.postWithRetry(
      request.tag,
      [
        { role: "system", content: request.system },
        { role: "user", content: repairUser },
      ],
      0,
      request.maxTokens,
      timeout,
      started,
    );
    const secondParsed = parseContent(request.schema, second);
    if (secondParsed.ok) {
      this.report({
        tag: request.tag,
        status: "ok",
        httpStatus: second.httpStatus,
        tokensIn: second.usage.tokensIn,
        tokensOut: second.usage.tokensOut,
        latencyMs: this.now() - started,
        attempt: 2,
      });
      return {
        data: secondParsed.data,
        usage: addUsage(first.usage, second.usage),
        model: this.model,
        latencyMs: this.now() - started,
        repaired: true,
      };
    }
    this.report({
      tag: request.tag,
      status: "invalid",
      httpStatus: second.httpStatus,
      tokensIn: second.usage.tokensIn,
      tokensOut: second.usage.tokensOut,
      latencyMs: this.now() - started,
      attempt: 2,
      error: secondParsed.error,
    });
    throw new LlmValidationError(
      `LLM returned invalid JSON twice (tag=${request.tag}, model=${this.model}): ${secondParsed.error}`,
    );
  }

  /** GET {base}/models → id list. Used by the OmniRoute setup probe. */
  async listModels(timeoutMs?: number): Promise<string[]> {
    const timeout = timeoutMs ?? this.timeoutMs;
    let response: Response;
    try {
      response = await this.getWithTimeout(`${this.baseUrl}/models`, timeout);
    } catch (error) {
      if (isAbort(error)) throw new LlmTimeoutError(`models request timed out after ${String(timeout)}ms`);
      throw new LlmHttpError(`models request failed: ${messageOf(error)}`, {});
    }
    if (!response.ok) {
      throw new LlmHttpError(`models request failed with HTTP ${String(response.status)}`, {
        status: response.status,
        retryAfterSeconds: retryAfterOf(response),
      });
    }
    const body: unknown = await response.json();
    const parsed = z
      .object({ data: z.array(z.object({ id: z.string() })) })
      .safeParse(body);
    if (!parsed.success) {
      throw new LlmValidationError("models response had no data array");
    }
    return parsed.data.data.map((m) => m.id);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private report(record: Omit<LlmCallRecord, "client" | "model">): void {
    this.onCall?.({ ...record, client: this.clientName, model: this.model });
  }

  /**
   * POST with network retries. Terminal network failure is reported
   * (tokens 0) and rethrown unchanged so callers keep the error class.
   */
  private async postWithRetry(
    tag: string,
    messages: { role: string; content: string }[],
    temperature: number | undefined,
    maxTokens: number | undefined,
    timeoutMs: number,
    started: number,
  ): Promise<ChatContent> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await this.postOnce(messages, temperature, maxTokens, timeoutMs);
      } catch (error) {
        const retryable = error instanceof LlmHttpError || error instanceof LlmTimeoutError;
        if (!retryable || attempt >= this.maxAttempts) {
          this.report({
            tag,
            status: error instanceof LlmTimeoutError ? "timeout" : "http_error",
            httpStatus: error instanceof LlmHttpError ? error.status : undefined,
            tokensIn: 0,
            tokensOut: 0,
            latencyMs: this.now() - started,
            attempt,
            error: messageOf(error),
          });
          throw error;
        }
        await this.sleep(backoffDelay(this.baseDelayMs, attempt, retryAfterOfError(error)));
      }
    }
  }

  private async postOnce(
    messages: { role: string; content: string }[],
    temperature: number | undefined,
    maxTokens: number | undefined,
    timeoutMs: number,
  ): Promise<ChatContent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      response_format: { type: "json_object" },
    };
    if (temperature !== undefined) body["temperature"] = temperature;
    if (maxTokens !== undefined) body["max_tokens"] = maxTokens;

    let response: Response;
    try {
      response = await this.postWithTimeout(`${this.baseUrl}/chat/completions`, body, timeoutMs);
    } catch (error) {
      if (isAbort(error)) {
        throw new LlmTimeoutError(`chat request timed out after ${String(timeoutMs)}ms (model=${this.model})`);
      }
      throw new LlmHttpError(`chat request failed: ${messageOf(error)}`, {});
    }
    if (!response.ok) {
      throw new LlmHttpError(`chat request failed with HTTP ${String(response.status)}`, {
        status: response.status,
        retryAfterSeconds: retryAfterOf(response),
      });
    }
    const text = await response.text();
    // Some gateways (OmniRoute auto mode) always stream SSE chunks, even
    // without stream:true — accumulate delta.content instead of JSON.parse.
    if (text.trimStart().startsWith("data:")) {
      const streamed = parseSseCompletion(text);
      if (streamed === undefined) {
        return {
          content: null,
          usage: { tokensIn: 0, tokensOut: 0 },
          httpStatus: response.status,
          envelopeError: "stream had no content chunks",
        };
      }
      return { content: streamed.content, usage: streamed.usage, httpStatus: response.status };
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(text) as unknown;
    } catch {
      return {
        content: null,
        usage: { tokensIn: 0, tokensOut: 0 },
        httpStatus: response.status,
        envelopeError: "chat response was not JSON",
      };
    }
    const parsed = z
      .object({
        choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).optional(),
        usage: z
          .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
          .optional(),
      })
      .safeParse(envelope);
    if (!parsed.success || !parsed.data.choices || parsed.data.choices.length === 0) {
      // A 200 with an unreadable envelope is a validation problem, not a
      // network problem: it flows into the repair path, never blind-retry.
      return {
        content: null,
        usage: { tokensIn: 0, tokensOut: 0 },
        httpStatus: response.status,
        envelopeError: "chat response had no usable choice",
      };
    }
    return {
      content: parsed.data.choices[0]?.message.content ?? null,
      usage: {
        tokensIn: parsed.data.usage?.prompt_tokens ?? 0,
        tokensOut: parsed.data.usage?.completion_tokens ?? 0,
      },
      httpStatus: response.status,
    };
  }

  private async postWithTimeout(
    url: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async getWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    if (this.apiKey === "") return { ...extra };
    return { ...extra, authorization: `Bearer ${this.apiKey}` };
  }
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

function retryAfterOfError(error: LlmHttpError | LlmTimeoutError): number | undefined {
  return error instanceof LlmHttpError ? error.retryAfterSeconds : undefined;
}

function backoffDelay(baseMs: number, attempt: number, retryAfterSeconds: number | undefined): number {
  const backoff = baseMs * 2 ** (attempt - 1);
  if (retryAfterSeconds !== undefined) return Math.max(backoff, Math.round(retryAfterSeconds * 1000));
  return backoff;
}

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return { tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut };
}

/** Accumulate an SSE chat stream into one content string + usage. */
function parseSseCompletion(text: string): { content: string | null; usage: LlmUsage } | undefined {
  const chunkSchema = z.object({
    choices: z.array(z.object({ delta: z.object({ content: z.string().optional() }).optional() })).optional(),
    usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional(),
  });
  let content = "";
  let usage: LlmUsage = { tokensIn: 0, tokensOut: 0 };
  let chunks = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let data: unknown;
    try {
      data = JSON.parse(payload) as unknown;
    } catch {
      return undefined;
    }
    const parsed = chunkSchema.safeParse(data);
    if (!parsed.success) return undefined;
    chunks += 1;
    const delta = parsed.data.choices?.[0]?.delta?.content;
    if (delta !== undefined) content += delta;
    const usageData = parsed.data.usage;
    if (usageData !== undefined) {
      usage = { tokensIn: usageData.prompt_tokens ?? 0, tokensOut: usageData.completion_tokens ?? 0 };
    }
  }
  if (chunks === 0) return undefined;
  return { content: content === "" ? null : content, usage };
}

type ParseOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

/** Envelope problems count as invalid content (repair path), not network. */
function parseContent<T>(schema: z.ZodType<T>, response: ChatContent): ParseOutcome<T> {
  if (response.envelopeError !== undefined) return { ok: false, error: response.envelopeError };
  return tryParse(schema, response.content);
}

/** Fence-strip → parse → (brace-extract → parse) → zod validate. */
function tryParse<T>(schema: z.ZodType<T>, content: string | null): ParseOutcome<T> {
  if (content === null || content.trim() === "") {
    return { ok: false, error: "empty reply" };
  }
  const stripped = stripFences(content);
  const direct = tryJsonParse(stripped);
  if (direct.ok) return validate(schema, direct.value);
  const extracted = extractBalancedObject(stripped);
  if (extracted !== undefined) {
    const reparsed = tryJsonParse(extracted);
    if (reparsed.ok) return validate(schema, reparsed.value);
  }
  return { ok: false, error: direct.error };
}

function validate<T>(schema: z.ZodType<T>, value: unknown): ParseOutcome<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  return { ok: false, error: issue ? `${issue.path.join(".")}: ${issue.message}` : "schema mismatch" };
}

function tryJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" };
  }
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/** First balanced {...} respecting strings/escapes — handles trailing text. */
function extractBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
