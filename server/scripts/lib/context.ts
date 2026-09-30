/**
 * Shared CollectContext builder for the CLI entry points (collect, doctor).
 * Production wiring: real HttpClient + rate limiter, redacting logger, and
 * the extractor client when OMNIROUTE_API_KEY is present (webpage source
 * degrades to a per-page error stat otherwise — never throws).
 */
import type { CollectContext } from "../../src/collectors/types.js";
import { HttpClient } from "../../src/collectors/http.js";
import { loadConfig } from "../../src/config/env.js";
import type { LlmExtractor } from "../../src/llm/extract.js";
import { createExtractor } from "../../src/llm/extract.js";
import { createExtractorClient } from "../../src/llm/factory.js";
import { DomainRateLimiter } from "../../src/utils/rate-limit.js";
import { createLogger } from "../../src/utils/logger.js";

export function buildCollectContext(runId: string, limitOverride?: number): CollectContext {
  const config = loadConfig();
  const http = new HttpClient({
    userAgent: config.userAgent,
    limiter: new DomainRateLimiter({}),
  });
  const llm: LlmExtractor = config.omnirouteApiKey
    ? createExtractor(createExtractorClient(config))
    : {
        model: "(unset)",
        extract: () => Promise.reject(new Error("OMNIROUTE_API_KEY not set — webpage extraction skipped")),
      };
  return {
    runId,
    limit: limitOverride ?? config.maxItemsPerSource,
    niches: config.niches,
    geo: config.trendsGeo,
    enablePlaywright: config.enablePlaywright,
    http,
    llm,
    signal: new AbortController().signal,
    log: createLogger(process.env["LOG_LEVEL"] ?? "info"),
    config: {},
  };
}
