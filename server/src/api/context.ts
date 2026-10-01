/**
 * Shared API context: everything routes need, nothing they shouldn't
 * construct. Sheets/LLM clients stay lazy (per-request repo builds) so the
 * app boots and serves health without credentials.
 */
import type { Logger } from "pino";
import type { StateDb } from "../db/sqlite.js";
import type { TrendPulseConfig } from "../config/env.js";
import type { SheetsClient } from "../sheets/client.js";
import { SheetsRepo } from "../sheets/repo.js";
import { createRealSheetsClient } from "../sheets/realClient.js";
import { SheetsApiError } from "../sheets/client.js";
import type { LlmExtractor } from "../llm/extract.js";
import type { JevJsonClient } from "../sorting/map.js";
import { Orchestrator } from "../pipeline/orchestrator.js";
import { pipelineBus } from "../pipeline/events.js";
import type { EventBus } from "../pipeline/events.js";
import type { PipelineScheduler } from "../scheduler/cron.js";
import { createLogger } from "../utils/logger.js";
export interface AppContext {
  version: string;
  config: TrendPulseConfig;
  db: StateDb;
  log?: Logger;
  events?: EventBus;
  sheetsClient?: SheetsClient;
  fetchImpl?: typeof fetch;
  jevClient?: JevJsonClient;
  extractor?: LlmExtractor;
  /** Live scheduler (hot-restarted on schedule_cron/timezone PUT). */
  scheduler?: PipelineScheduler;
  /** Setup-probe fallback (Phase 2 compat): server-level OmniRoute route. */
  omnirouteBaseUrl?: string | undefined;
  omnirouteApiKey?: string | undefined;
}

export function appLogger(ctx: AppContext): Logger {
  return ctx.log ?? createLogger(ctx.config.logLevel);
}

export function appEvents(ctx: AppContext): EventBus {
  return ctx.events ?? pipelineBus;
}

/** Per-request repo; missing/unreadable credentials become SheetsApiError. */
export function appRepo(ctx: AppContext): SheetsRepo {
  let client: SheetsClient;
  try {
    client =
      ctx.sheetsClient ?? createRealSheetsClient(ctx.config.googleServiceAccountJsonPath).client;
  } catch (error) {
    throw new SheetsApiError(error instanceof Error ? error.message : String(error), {});
  }
  return new SheetsRepo(client, {
    spreadsheetId: ctx.config.googleSheetId,
    cacheTtlS: ctx.config.sheetCacheTtlS,
  });
}

export function appOrchestrator(ctx: AppContext): Orchestrator {
  return new Orchestrator({
    db: ctx.db,
    config: ctx.config,
    log: appLogger(ctx),
    events: appEvents(ctx),
    ...(ctx.sheetsClient ? { sheetsClient: ctx.sheetsClient } : {}),
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.jevClient ? { jevClient: ctx.jevClient } : {}),
    ...(ctx.extractor ? { extractor: ctx.extractor } : {}),
  });
}
