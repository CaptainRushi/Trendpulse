/**
 * Extractor client factory. Same OpenAI-compatible protocol as the sorter
 * writer; Jev classification goes through JevClient (SystemOne) directly.
 */
import type { TrendPulseConfig } from "../config/env.js";
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
