/**
 * Settings: effective values (env > settings rows > defaults) with masked
 * secrets, plus validated partial updates. Secrets are read-only metadata
 * here — credential values live in the environment, never in this API.
 * A schedule_cron/timezone change hot-restarts the scheduler in place.
 */
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readSettingsMap, effectiveMaxCategories } from "../config/settings.js";
import type { TrendPulseConfig } from "../config/env.js";
import { DEFAULT_SCORE_WEIGHTS } from "../sorting/score.js";
import { badRequest } from "./errors.js";
import type { AppContext } from "./context.js";
import { validateCategorySources, validateMyCategories } from "../categories/registry.js";

type SettingType = "boolean" | "integer" | "string" | "string[]" | "weights" | "object";

interface SettingSpec {
  type: SettingType;
  min?: number;
  /** Inclusive upper bound for integers (e.g. TOP_PER_CATEGORY 1-10). */
  max?: number;
  /** Resolve the effective value from env-derived config. */
  fromConfig: (config: TrendPulseConfig) => unknown;
  /** False for keys with no env backing (compiled default, not env). */
  envBacked?: boolean;
}

const SPECS: Record<string, SettingSpec> = {
  setup_complete: { type: "boolean", fromConfig: () => false, envBacked: false },
  setup_step: { type: "string", fromConfig: () => "", envBacked: false },
  timezone: { type: "string", fromConfig: (c) => c.tz },
  schedule_cron: { type: "string", fromConfig: (c) => c.scheduleCron },
  run_missed_on_start: { type: "boolean", fromConfig: (c) => c.runMissedOnStart },
  niches: { type: "string[]", fromConfig: (c) => c.niches },
  trends_geo: { type: "string", fromConfig: (c) => c.trendsGeo },
  sheet_id: { type: "string", fromConfig: (c) => c.googleSheetId },
  omniroute_base_url: { type: "string", fromConfig: (c) => c.omnirouteBaseUrl },
  omniroute_extract_model: { type: "string", fromConfig: (c) => c.omnirouteExtractModel },
  jev_base_url: { type: "string", fromConfig: (c) => c.jevBaseUrl },
  jev_model: { type: "string", fromConfig: (c) => c.jevModel },
  score_weights: { type: "weights", fromConfig: () => DEFAULT_SCORE_WEIGHTS, envBacked: false },
  sort_batch_size: { type: "integer", min: 1, fromConfig: (c) => c.sortBatchSize },
  retention_days: { type: "integer", min: 1, fromConfig: (c) => c.retentionDays },
  retention_mode: { type: "string", fromConfig: (c) => c.retentionMode },
  max_items_per_source: { type: "integer", min: 1, fromConfig: (c) => c.maxItemsPerSource },
  dedupe_days: { type: "integer", min: 0, fromConfig: (c) => c.dedupeDays },
  user_agent: { type: "string", fromConfig: (c) => c.userAgent },
  llm_concurrency: { type: "integer", min: 1, fromConfig: (c) => c.llmConcurrency },
  llm_timeout_ms: { type: "integer", min: 1000, fromConfig: (c) => c.llmTimeoutMs },
  sheet_cache_ttl_s: { type: "integer", min: 0, fromConfig: (c) => c.sheetCacheTtlS },
  my_categories: { type: "string[]", fromConfig: () => [], envBacked: false },
  top_per_category: { type: "integer", min: 1, max: 10, fromConfig: (c) => c.topPerCategory },
  max_categories: { type: "integer", min: 1, fromConfig: (c) => c.maxCategories },
  include_general_sources: { type: "boolean", fromConfig: (c) => c.includeGeneralSources },
  category_sources: { type: "object", fromConfig: () => ({}), envBacked: false },
  enable_playwright: { type: "boolean", fromConfig: (c) => c.enablePlaywright },
  theme: { type: "string", fromConfig: () => "system", envBacked: false },
};

/** Secret keys: presence only, values never leave the server. */
const SECRETS: Record<string, (config: TrendPulseConfig) => boolean> = {
  omniroute_api_key: (c) => c.omnirouteApiKey !== "",
  jev_api_key: (c) => c.jevApiKey !== "",
  google_service_account: (c) =>
    c.googleServiceAccountJsonPath !== "" && existsSync(c.googleServiceAccountJsonPath),
  github_token: (c) => c.githubToken !== "",
  reddit_client_id: (c) => c.redditClientId !== "",
  reddit_client_secret: (c) => c.redditClientSecret !== "",
  youtube_api_key: (c) => c.youtubeApiKey !== "",
  producthunt_token: (c) => c.producthuntToken !== "",
  dashboard_password: (c) => c.dashboardPassword !== "",
};

export interface SettingView {
  value: unknown;
  is_set: boolean;
  secret: boolean;
  source: "env" | "settings" | "default";
}

function coerceValue(key: string, spec: SettingSpec, raw: unknown): unknown {
  const fail = (why: string): never => {
    throw badRequest(`Invalid value for '${key}': ${why}.`);
  };
  switch (spec.type) {
    case "boolean":
      if (typeof raw !== "boolean") fail("expected a boolean");
      return raw;
    case "integer":
      if (
        typeof raw !== "number" ||
        !Number.isInteger(raw) ||
        raw < (spec.min ?? 0) ||
        (spec.max !== undefined && raw > spec.max)
      ) {
        fail(`expected an integer >= ${String(spec.min ?? 0)}${spec.max === undefined ? "" : ` and <= ${String(spec.max)}`}`);
      }
      return raw;
    case "string":
      if (typeof raw !== "string") fail("expected a string");
      if (key === "retention_mode" && raw !== "archive" && raw !== "delete") {
        fail("expected archive or delete");
      }
      return raw;
    case "string[]":
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
        fail("expected an array of strings");
      }
      if (key === "my_categories") {
        try {
          return validateMyCategories(raw);
        } catch (error) {
          fail(error instanceof Error ? error.message : "invalid categories");
        }
      }
      return raw;
    case "object": {
      if (key === "category_sources") {
        try {
          return validateCategorySources(raw);
        } catch (error) {
          fail(error instanceof Error ? error.message : "invalid sources");
        }
      }
      throw badRequest(`Invalid value for '${key}': expected an object.`);
    }
    case "weights": {
      if (typeof raw !== "object" || raw === null) fail("expected an object");
      const record = raw as Record<string, unknown>;
      for (const part of ["engagement", "diversity", "relevance", "novelty"]) {
        const n = record[part];
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
          fail("expected non-negative numbers for engagement/diversity/relevance/novelty");
        }
      }
      return { engagement: record["engagement"], diversity: record["diversity"], relevance: record["relevance"], novelty: record["novelty"] };
    }
  }
}

function effectiveView(
  ctx: AppContext,
  rows: Map<string, unknown>,
): Record<string, SettingView> {
  const view: Record<string, SettingView> = {};
  for (const [key, spec] of Object.entries(SPECS)) {
    if (rows.has(key)) {
      view[key] = { value: rows.get(key), is_set: true, secret: false, source: "settings" };
    } else if (spec.envBacked === false) {
      view[key] = { value: spec.fromConfig(ctx.config), is_set: false, secret: false, source: "default" };
    } else {
      view[key] = { value: spec.fromConfig(ctx.config), is_set: true, secret: false, source: "env" };
    }
  }
  for (const [key, isSet] of Object.entries(SECRETS)) {
    const set = isSet(ctx.config);
    view[key] = { value: set ? "••••" : "", is_set: set, secret: true, source: "env" };
  }
  return view;
}

const SettingsResponse = z.object({
  settings: z.record(
    z.string(),
    z.object({
      value: z.unknown(),
      is_set: z.boolean(),
      secret: z.boolean(),
      source: z.enum(["env", "settings", "default"]),
    }),
  ),
});

export function registerSettings(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/settings", () => {
    const rows = readSettingsMap(ctx.db);
    return SettingsResponse.parse({ settings: effectiveView(ctx, rows) });
  });

  app.put("/api/settings", (request) => {
    if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
      throw badRequest("Body must be a JSON object of setting keys to values.");
    }
    const updates = request.body as Record<string, unknown>;
    const upsert = ctx.db.prepare(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`,
    );
    const updated: string[] = [];
    // my_categories is capped by the effective MAX_CATEGORIES: a
    // max_categories value in the same payload wins, else the stored row,
    // else the env default.
    let maxCats = effectiveMaxCategories(ctx.db, ctx.config);
    const pendingMax = updates["max_categories"];
    if (pendingMax !== undefined) {
      const maxSpec = SPECS["max_categories"];
      if (!maxSpec) throw badRequest("Unknown setting 'max_categories'.");
      maxCats = coerceValue("max_categories", maxSpec, pendingMax) as number;
    }
    const write = ctx.db.transaction(() => {
      for (const [key, raw] of Object.entries(updates)) {
        const spec = SPECS[key];
        if (!spec) {
          if (SECRETS[key]) {
            throw badRequest(
              `Setting '${key}' is a secret managed via environment — not writable here.`,
            );
          }
          throw badRequest(`Unknown setting '${key}'.`);
        }
        if (key === "my_categories") {
          try {
            upsert.run(key, JSON.stringify(validateMyCategories(raw, maxCats)));
          } catch (error) {
            throw badRequest(
              `Invalid value for 'my_categories': ${error instanceof Error ? error.message : "invalid categories"}.`,
            );
          }
          updated.push(key);
          continue;
        }
        upsert.run(key, JSON.stringify(coerceValue(key, spec, raw)));
        updated.push(key);
      }
    });
    write();

    // Hot reload: schedule/timezone changes re-arm the scheduler in place.
    let schedulerRestarted = false;
    if ((updated.includes("schedule_cron") || updated.includes("timezone")) && ctx.scheduler) {
      const rows = readSettingsMap(ctx.db);
      const view = effectiveView(ctx, rows);
      const cron = view["schedule_cron"]?.value;
      const timezone = view["timezone"]?.value;
      if (typeof cron === "string" && typeof timezone === "string") {
        ctx.scheduler.reschedule(cron, timezone);
        schedulerRestarted = true;
      }
    }
    return { updated, scheduler_restarted: schedulerRestarted };
  });
}
