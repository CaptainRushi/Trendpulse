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
  return new LlmClient({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: endpoint.model,
    clientName: "jev",
    timeoutMs: config.llmTimeoutMs,
    onCall: hooks.onCall,
  });
}
