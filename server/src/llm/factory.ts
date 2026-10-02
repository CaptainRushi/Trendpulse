/**
 * The two logical LLM clients. Same OpenAI-compatible protocol; different
 * jobs and credentials. Jev resolves via resolveJevEndpoint: empty
 * JEV_BASE_URL means Jev rides OmniRoute with JEV_MODEL (TRD §5).
 */
import type { TrendPulseConfig } from "../config/env.js";
import { resolveJevEndpoint } from "../config/env.js";
import { LlmClient } from "./client.js";
import type { LlmCallRecord } from "./client.js";

export interface ClientHooks {
  onCall?: (record: LlmCallRecord) => void;
}

export function createExtractorClient(config: TrendPulseConfig, hooks: ClientHooks = {}): LlmClient {
  if (config.omnirouteExtractModel.trim() === "") {
    throw new Error(
      "Missing model: set OMNIROUTE_EXTRACT_MODEL to the extractor model id in OmniRoute.",
    );
  }
  return new LlmClient({
    baseUrl: config.omnirouteBaseUrl,
    apiKey: config.omnirouteApiKey,
    model: config.omnirouteExtractModel,
    clientName: "extractor",
    timeoutMs: config.llmTimeoutMs,
    onCall: hooks.onCall,
  });
}

export function createJevClient(config: TrendPulseConfig, hooks: ClientHooks = {}): LlmClient {
  const endpoint = resolveJevEndpoint(config);
  if (endpoint.model.trim() === "") {
    throw new Error("Missing model: set JEV_MODEL to the Jev model id (e.g. jev-latest).");
  }
  return new LlmClient({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: endpoint.model,
    clientName: "jev",
    timeoutMs: config.llmTimeoutMs,
    onCall: hooks.onCall,
  });
}
