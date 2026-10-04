/**
 * Connection probes for the setup wizard (and doctor, Phase 9).
 * Both return {ok:false, error} with actionable copy instead of throwing —
 * the wizard renders the error verbatim next to a fix hint.
 */
import { z } from "zod";
import { LlmClient, LlmHttpError, LlmTimeoutError, LlmValidationError } from "./client.js";
import { JevClient, JevHttpError, JevTimeoutError } from "./jev.js";

export interface ProbeSuccess {
  ok: true;
  latencyMs: number;
}

export interface OmnirouteProbeSuccess extends ProbeSuccess {
  models: string[];
}

export interface JevProbeSuccess extends ProbeSuccess {
  model: string;
  /** Sample classification answer (direct SystemOne path only). */
  choice?: string | undefined;
  confidence?: number | undefined;
}

export interface ProbeFailure {
  ok: false;
  latencyMs: number;
  error: string;
}

export type OmnirouteProbeResult = OmnirouteProbeSuccess | ProbeFailure;
export type JevProbeResult = JevProbeSuccess | ProbeFailure;

export interface ProbeOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

const SampleReply = z.object({ ok: z.boolean() });

/**
 * GET {base}/models — proves the gateway is up, keyed, and serving.
 * Generous default timeout: gateways serving thousands of models answer
 * slowly (observed 15 s+), and a timeout here shows up as a settings error.
 */
export async function testOmnirouteConnection(options: ProbeOptions): Promise<OmnirouteProbeResult> {
  const started = Date.now();
  const client = new LlmClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey ?? "",
    model: "",
    clientName: "extractor",
    timeoutMs: options.timeoutMs ?? 45000,
    maxAttempts: 1,
    fetchImpl: options.fetchImpl,
  });
  try {
    const models = await client.listModels();
    return { ok: true, models, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: friendlyError(options.baseUrl, error) };
  }
}

export interface JevProbeOptions extends ProbeOptions {
  model: string;
  /** SystemOne path (JEV_PATH). Wizard callers may omit it. */
  path?: string | undefined;
  /** Used when baseUrl is empty (Jev rides OmniRoute). */
  fallback?: { baseUrl: string; apiKey: string } | undefined;
}

/**
 * One real SystemOne classification against a direct endpoint — proves the
 * Jev contract, not just reachability. Empty baseUrl keeps the legacy chat
 * round-trip through the OmniRoute fallback.
 */
export async function testJevConnection(options: JevProbeOptions): Promise<JevProbeResult> {
  const started = Date.now();
  if (options.model.trim() === "") {
    return { ok: false, latencyMs: 0, error: "Set a Jev model id first (e.g. the model or combo id in OmniRoute)." };
  }
  const baseUrl = options.baseUrl.trim();
  if (baseUrl !== "") {
    // Tolerate a pasted full endpoint (…/v1/systemone) as well as split BASE+PATH.
    const path = options.path ?? "/v1/systemone";
    const client = new JevClient({
      baseUrl,
      path: baseUrl.replace(/\/+$/, "").endsWith(path) ? "" : path,
      apiKey: options.apiKey ?? "",
      model: options.model,
      timeoutMs: options.timeoutMs ?? 30000,
      maxAttempts: 1,
      fetchImpl: options.fetchImpl,
    });
    try {
      const result = await client.classify(
        { title: "Probe item", snippet: "A connectivity check, not a real trend." },
        {
          category: {
            type: "choice",
            instructions: "Which category best fits this item?",
            criteria: { Tech: "technology", Other: "anything else" },
          },
          quality: { type: "noul", instructions: "Is this substantive, not spam?" },
        },
        "test",
      );
      const picked = result.answers["category"];
      const choice = picked?.kind === "choice" ? { choice: picked.choice, confidence: picked.confidence } : {};
      return { ok: true, model: options.model, latencyMs: Date.now() - started, ...choice };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: friendlyError(baseUrl, error) };
    }
  }
  const fallbackBase = options.fallback?.baseUrl ?? "";
  if (fallbackBase.trim() === "") {
    return { ok: false, latencyMs: 0, error: "No Jev endpoint configured: set JEV_BASE_URL or the OmniRoute URL." };
  }
  const client = new LlmClient({
    baseUrl: fallbackBase,
    apiKey: options.fallback?.apiKey ?? "",
    model: options.model,
    clientName: "jev",
    timeoutMs: options.timeoutMs ?? 30000,
    maxAttempts: 1,
    fetchImpl: options.fetchImpl,
  });
  try {
    await client.json({
      system: 'Return JSON only: {"ok": true}',
      user: "Reply with the JSON object.",
      schema: SampleReply,
      temperature: 0,
      tag: "test",
    });
    return { ok: true, model: options.model, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: friendlyError(fallbackBase, error) };
  }
}

/** Map client errors to the wizard's plain-words copy (UI §8). */
export function friendlyError(baseUrl: string, error: unknown): string {
  if (error instanceof LlmTimeoutError || error instanceof JevTimeoutError) {
    return `Timed out reaching ${baseUrl}. Is the service running there?`;
  }
  if (error instanceof LlmValidationError) {
    return `The endpoint answered but not with valid JSON (${error.message}). Check that the URL points at an OpenAI-compatible chat endpoint and the model id is right.`;
  }
  if (error instanceof LlmHttpError || error instanceof JevHttpError) {
    if (error.status === 401 || error.status === 403) {
      return `Unauthorized (HTTP ${String(error.status)}) at ${baseUrl}. Check the API key.`;
    }
    if (error.status === 429) {
      return `Rate limited (HTTP 429) at ${baseUrl}. Wait a minute or check the provider quota, then press Test again.`;
    }
    if (error.status !== undefined) {
      return `HTTP ${String(error.status)} from ${baseUrl}: ${error.message}`;
    }
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(error.message)) {
      return `Not reachable at ${baseUrl}. Start the service (or check the URL) and press Test again.`;
    }
    return `${error.message} (${baseUrl})`;
  }
  if (error instanceof Error) return `${error.message} (${baseUrl})`;
  return `Unexpected error talking to ${baseUrl}.`;
}
