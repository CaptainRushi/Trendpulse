import { z } from "zod";

// Env vars arrive as strings; "false"/"0"/"" mean false, everything else
// truthy check is explicit so e.g. "false" is not read as true.
function boolField(defaultValue: boolean): z.ZodType<boolean, z.ZodTypeDef, string | undefined> {
  return z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw === "") return defaultValue;
      const v = raw.trim().toLowerCase();
      if (["1", "true", "yes", "y", "on"].includes(v)) return true;
      if (["0", "false", "no", "n", "off"].includes(v)) return false;
      throw new Error(`expected boolean, got ${JSON.stringify(raw)}`);
    });
}

function numField(defaultValue: number): z.ZodType<number, z.ZodTypeDef, string | undefined> {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw === "") return defaultValue;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected number, got ${JSON.stringify(raw)}` });
        return z.NEVER;
      }
      return n;
    });
}

const EnvSchema = z.object({
  PORT: numField(4317).pipe(z.number().int().min(1).max(65535)),
  HOST: z.string().default("127.0.0.1"),
  TZ: z.string().default("UTC"),
  DASHBOARD_PASSWORD: z.string().default(""),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  SCHEDULE_CRON: z.string().default("0 6 * * *"),
  RUN_MISSED_ON_START: boolField(true),
  AUTO_RESUME: boolField(false),

  GOOGLE_SERVICE_ACCOUNT_JSON_PATH: z.string().default("./secrets/service-account.json"),
  GOOGLE_SHEET_ID: z.string().default(""),
  SHEET_CACHE_TTL_S: numField(60).pipe(z.number().int().min(0)),

  OMNIROUTE_BASE_URL: z.string().default("http://localhost:20128/v1"),
  OMNIROUTE_API_KEY: z.string().default(""),
  OMNIROUTE_EXTRACT_MODEL: z.string().default(""),
  OMNIROUTE_WRITER_MODEL: z.string().default(""),
  OMNIROUTE_FALLBACK_MODEL: z.string().default(""),

  // Empty = route Jev through OmniRoute (see resolveJevEndpoint).
  // Day-1 default per docs/12 is https://api.typesafe.ai; empty stays
  // supported for local-only setups without a direct Jev key.
  JEV_BASE_URL: z.string().default(""),
  JEV_PATH: z.string().default("/v1/systemone"),
  JEV_API_KEY: z.string().default(""),
  JEV_MODEL: z.string().default("jev-latest"),
  JEV_CONCURRENCY: numField(8).pipe(z.number().int().min(1).max(32)),
  JEV_PRICE_PER_M_INPUT: numField(0.04).pipe(z.number().nonnegative()),
  JEV_RUN_BUDGET_USD: numField(1.0).pipe(z.number().nonnegative()),
  JEV_FALLBACK: boolField(true),
  QUALITY_MIN: numField(0.5).pipe(z.number().min(0).max(1)),
  LLM_CONCURRENCY: numField(2).pipe(z.number().int().min(1).max(16)),
  LLM_TIMEOUT_MS: numField(90000).pipe(z.number().int().min(1000)),

  TRENDS_GEO: z.string().default("US"),
  NICHES: z.string().default(""),
  MAX_ITEMS_PER_SOURCE: numField(50).pipe(z.number().int().min(1)),
  DEDUPE_DAYS: numField(3).pipe(z.number().int().min(0)),
  USER_AGENT: z.string().default("TrendPulse/1.0 (+local)"),
  ENABLE_PLAYWRIGHT: boolField(false),
  SCRAPLING_ENABLED: boolField(false),
  SCRAPLING_URL: z.string().default("http://127.0.0.1:4318"),

  REDDIT_CLIENT_ID: z.string().default(""),
  REDDIT_CLIENT_SECRET: z.string().default(""),
  GITHUB_TOKEN: z.string().default(""),
  YOUTUBE_API_KEY: z.string().default(""),
  PRODUCTHUNT_TOKEN: z.string().default(""),

  SORT_BATCH_SIZE: numField(30).pipe(z.number().int().min(1)),
  TOP_N: numField(50).pipe(z.number().int().min(1)),
  RETENTION_DAYS: numField(30).pipe(z.number().int().min(1)),
  RETENTION_MODE: z.enum(["archive", "delete"]).default("archive"),
});

export type RawEnv = Record<string, string | undefined>;

export interface TrendPulseConfig {
  port: number;
  host: string;
  tz: string;
  dashboardPassword: string;
  logLevel: string;
  scheduleCron: string;
  runMissedOnStart: boolean;
  autoResume: boolean;
  googleServiceAccountJsonPath: string;
  googleSheetId: string;
  sheetCacheTtlS: number;
  omnirouteBaseUrl: string;
  omnirouteApiKey: string;
  omnirouteExtractModel: string;
  omnirouteWriterModel: string;
  omnirouteFallbackModel: string;
  jevBaseUrl: string;
  jevPath: string;
  jevApiKey: string;
  jevModel: string;
  jevConcurrency: number;
  jevPricePerMInput: number;
  jevRunBudgetUsd: number;
  jevFallback: boolean;
  qualityMin: number;
  llmConcurrency: number;
  llmTimeoutMs: number;
  trendsGeo: string;
  niches: string[];
  maxItemsPerSource: number;
  dedupeDays: number;
  userAgent: string;
  enablePlaywright: boolean;
  scrapingEnabled: boolean;
  scrapingUrl: string;
  redditClientId: string;
  redditClientSecret: string;
  githubToken: string;
  youtubeApiKey: string;
  producthuntToken: string;
  sortBatchSize: number;
  topN: number;
  retentionDays: number;
  retentionMode: "archive" | "delete";
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "::ffff:127.0.0.1" || h === "localhost";
}

/** Parse env (defaults to process.env). Throws a readable Error listing every bad var. */
export function loadConfig(env: RawEnv = process.env): TrendPulseConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      return `  - ${key}: ${issue.message}`;
    });
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;

  if (!isLoopbackHost(e.HOST) && e.DASHBOARD_PASSWORD === "") {
    throw new Error(
      "Invalid environment configuration:\n  - DASHBOARD_PASSWORD: required when HOST is not loopback (binding to a non-localhost address without a password would expose the dashboard)",
    );
  }

  return {
    port: e.PORT,
    host: e.HOST,
    tz: e.TZ,
    dashboardPassword: e.DASHBOARD_PASSWORD,
    logLevel: e.LOG_LEVEL,
    scheduleCron: e.SCHEDULE_CRON,
    runMissedOnStart: e.RUN_MISSED_ON_START,
    autoResume: e.AUTO_RESUME,
    googleServiceAccountJsonPath: e.GOOGLE_SERVICE_ACCOUNT_JSON_PATH,
    googleSheetId: e.GOOGLE_SHEET_ID,
    sheetCacheTtlS: e.SHEET_CACHE_TTL_S,
    omnirouteBaseUrl: e.OMNIROUTE_BASE_URL,
    omnirouteApiKey: e.OMNIROUTE_API_KEY,
    omnirouteExtractModel: e.OMNIROUTE_EXTRACT_MODEL,
    omnirouteWriterModel: e.OMNIROUTE_WRITER_MODEL,
    omnirouteFallbackModel: e.OMNIROUTE_FALLBACK_MODEL,
    jevBaseUrl: e.JEV_BASE_URL.trim(),
    jevPath: e.JEV_PATH,
    jevApiKey: e.JEV_API_KEY,
    jevModel: e.JEV_MODEL,
    jevConcurrency: e.JEV_CONCURRENCY,
    jevPricePerMInput: e.JEV_PRICE_PER_M_INPUT,
    jevRunBudgetUsd: e.JEV_RUN_BUDGET_USD,
    jevFallback: e.JEV_FALLBACK,
    qualityMin: e.QUALITY_MIN,
    llmConcurrency: e.LLM_CONCURRENCY,
    llmTimeoutMs: e.LLM_TIMEOUT_MS,
    trendsGeo: e.TRENDS_GEO,
    niches: e.NICHES.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    maxItemsPerSource: e.MAX_ITEMS_PER_SOURCE,
    dedupeDays: e.DEDUPE_DAYS,
    userAgent: e.USER_AGENT,
    enablePlaywright: e.ENABLE_PLAYWRIGHT,
    scrapingEnabled: e.SCRAPLING_ENABLED,
    scrapingUrl: e.SCRAPLING_URL.replace(/\/+$/, ""),
    redditClientId: e.REDDIT_CLIENT_ID,
    redditClientSecret: e.REDDIT_CLIENT_SECRET,
    githubToken: e.GITHUB_TOKEN,
    youtubeApiKey: e.YOUTUBE_API_KEY,
    producthuntToken: e.PRODUCTHUNT_TOKEN,
    sortBatchSize: e.SORT_BATCH_SIZE,
    topN: e.TOP_N,
    retentionDays: e.RETENTION_DAYS,
    retentionMode: e.RETENTION_MODE,
  };
}

export interface JevEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** "omniroute" when JEV_BASE_URL is empty and Jev rides the gateway. */
  via: "omniroute" | "direct";
}

/**
 * Jev is a configurable model: empty JEV_BASE_URL means Jev calls go to
 * OMNIROUTE_BASE_URL with JEV_MODEL (a model/combo id inside OmniRoute).
 */
export function resolveJevEndpoint(config: TrendPulseConfig): JevEndpoint {
  if (config.jevBaseUrl === "") {
    return {
      baseUrl: config.omnirouteBaseUrl,
      apiKey: config.omnirouteApiKey,
      model: config.jevModel,
      via: "omniroute",
    };
  }
  return { baseUrl: config.jevBaseUrl, apiKey: config.jevApiKey, model: config.jevModel, via: "direct" };
}
