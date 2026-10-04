/**
 * ComposioGateway (docs/15 PACKAGE C1) — direct tool execution, no sessions,
 * no agent loop. Transport is plain fetch against the v3.1 execute endpoint
 * (verified shape; SDK would only swap this function — see DECISIONS.md).
 *
 * Every call resolves its slug from tools.lock.json first: an unpinned or
 * mismatched lock fails with COMPOSIO_TOOL_MISSING before any network.
 * The API key is redacted from every error that leaves this module.
 */
import { ComposioError } from "./errors.js";
import { loadToolLock, requireOpSlug, type ToolLock } from "./tool-map.js";

export const COMPOSIO_EXEC_BASE_URL = "https://backend.composio.dev/api/v3.1";

export interface ExecuteResult {
  ok: boolean;
  /** Tool payload on success; absent on failure. */
  data?: unknown;
  /** Readable error on failure (key redacted). */
  error?: string;
  status?: number | undefined;
  retryAfterSeconds?: number | undefined;
  latencyMs: number;
}

export interface CallRecord {
  slug: string;
  ok: boolean;
  latencyMs: number;
}

export interface ComposioGateway {
  execute(op: string, args: Record<string, unknown>): Promise<ExecuteResult>;
}

export interface GatewayOptions {
  apiKey: string;
  userId: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Hook for integration_calls recording (C4); never receives the key. */
  onCall?: (record: CallRecord) => void;
}

/** Extract a readable message from Composio's string-or-object error shape. */
export function gatewayErrorMessage(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && raw !== "") return raw;
  if (raw !== null && typeof raw === "object") {
    const message = (raw as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return fallback;
}

export class RestComposioGateway implements ComposioGateway {
  private readonly lock: ToolLock;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onCall: ((record: CallRecord) => void) | undefined;

  constructor(options: GatewayOptions, lock: ToolLock = loadToolLock()) {
    this.lock = lock;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onCall = options.onCall;
  }

  /** gatewayErrorMessage + API-key redaction (CMP-14: key never leaks). */
  private clean(raw: unknown, fallback: string): string {
    return gatewayErrorMessage(raw, fallback).split(this.apiKey).join("[REDACTED]");
  }

  async execute(op: string, args: Record<string, unknown>): Promise<ExecuteResult> {
    const started = Date.now();
    const done = (result: Omit<ExecuteResult, "latencyMs">): ExecuteResult => {
      const full = { ...result, latencyMs: Date.now() - started };
      if (this.onCall) {
        this.onCall({ slug: safeSlug, ok: full.ok, latencyMs: full.latencyMs });
      }
      return full;
    };
    let safeSlug = op;
    try {
      safeSlug = requireOpSlug(this.lock, op);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return done({ ok: false, error: message });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${COMPOSIO_EXEC_BASE_URL}/tools/execute/${safeSlug}`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ arguments: args }),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: { successful?: boolean; data?: unknown; error?: unknown };
      try {
        parsed = JSON.parse(text) as { successful?: boolean; data?: unknown; error?: unknown };
      } catch {
        return done({ ok: false, error: `Composio tool ${safeSlug} returned non-JSON (${String(res.status)})`, status: res.status });
      }
      if (!res.ok || parsed.successful === false) {
        return done({
          ok: false,
          error: this.clean(parsed.error, `Composio tool ${safeSlug} failed (${String(res.status)})`),
          status: res.status,
        });
      }
      return done({ ok: true, data: parsed.data, status: res.status });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return done({ ok: false, error: `Composio tool ${safeSlug} timed out after ${String(this.timeoutMs)}ms` });
      }
      return done({
        ok: false,
        error: this.clean(error instanceof Error ? error.message : String(error), `Composio tool ${safeSlug} failed`),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build the production gateway; missing key is COMPOSIO_NOT_CONFIGURED, not a crash. */
export function createGateway(options: Omit<GatewayOptions, "apiKey"> & { apiKey: string }): ComposioGateway {
  if (options.apiKey === "") {
    throw new ComposioError("COMPOSIO_NOT_CONFIGURED", "COMPOSIO_API_KEY not set — run npm run composio:setup.");
  }
  return new RestComposioGateway(options);
}
