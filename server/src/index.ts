import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "./config/loadEnv.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { applyMigrations, openDatabase } from "./db/sqlite.js";
import { Orchestrator } from "./pipeline/orchestrator.js";
import { PipelineScheduler, resolveCronCategories } from "./scheduler/cron.js";
import { recoverOnBoot } from "./scheduler/lock.js";
import { ScraplingSupervisor, setScrapingSupervisor } from "./scraping/supervisor.js";
import { createLogger, setRootLogger } from "./utils/logger.js";
import { APP_VERSION } from "./version.js";
import { HttpClient } from "./collectors/http.js";
import { readSettingsMap } from "./config/settings.js";
import { pipelineBus } from "./pipeline/events.js";
import { PulseSampler, isPipelineActive } from "./pulse/sampler.js";
import { resolvePulseConfig } from "./pulse/config.js";
import { buildRefreshers, sqliteEtagStore } from "./pulse/refreshers.js";

loadEnvFiles();

const here = dirname(fileURLToPath(import.meta.url));

function defaultDbPath(): string {
  if (process.env["STATE_DB_PATH"] !== undefined && process.env["STATE_DB_PATH"] !== "") {
    return process.env["STATE_DB_PATH"];
  }
  // Anchor repo root from this file's location, which differs dev vs prod:
  //   dev (tsx):  server/src/index.ts       → up 2 = repo root
  //   prod:       server/dist/src/index.js  → up 3 = repo root
  const up = here.endsWith(join("dist", "src")) ? ["..", "..", ".."] : ["..", ".."];
  return join(here, ...up, "data", "state.db");
}

/** Built web UI for single-port production (TRD §2); absent in dev/test. */
function webDistDir(): string | undefined {
  const up = here.endsWith(join("dist", "src")) ? ["..", "..", "..", "web", "dist"] : ["..", "web", "dist"];
  const dir = join(here, ...up);
  return dir;
}

async function main(): Promise<void> {
  // Fail fast on bad env — readable error, non-zero exit (Rule: config first).
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  setRootLogger(logger);

  if (config.host !== "127.0.0.1") {
    logger.warn(
      "HOST is not loopback; dashboard is password-protected and exposed — only use on trusted networks",
    );
  }

  const dbPath = defaultDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  const applied = applyMigrations(db);
  if (applied.length > 0) logger.info({ applied }, "applied SQLite migrations");

  // Stale-lock recovery + scheduler live here (TRD §10). Clients are built
  // lazily per run, so boot never crashes on missing credentials.
  const recovered = recoverOnBoot(db);
  if (recovered.interruptedRuns.length > 0) {
    logger.warn({ runs: recovered.interruptedRuns }, "interrupted runs left by a previous process");
  }
  if (recovered.releasedStaleLocks > 0) {
    logger.info({ count: recovered.releasedStaleLocks }, "released dead pipeline locks");
  }

  // Scrapling sidecar (S1 stretch): opt-in via SCRAPLING_ENABLED. A dead
  // sidecar never blocks boot — the webpage collector degrades to native.
  const scraping = new ScraplingSupervisor({
    baseUrl: config.scrapingUrl,
    enabled: config.scrapingEnabled,
    log: logger,
  });
  setScrapingSupervisor(scraping);
  if (config.scrapingEnabled) {
    try {
      await scraping.start();
      logger.info("scrapling sidecar healthy");
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "scrapling sidecar unavailable at boot; webpage falls back to native fetch",
      );
    }
    const shutdown = (): void => {
      void scraping.stop().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  // Pulse sampler (Doc 16): HTTP-only refresh cycles on a timer. Boot never
  // blocks on it; a dead network just yields skipped cycles.
  const pulseHttp = new HttpClient({ userAgent: config.userAgent, maxAttempts: 1, cache: sqliteEtagStore(db) });
  const pulseConfig = resolvePulseConfig(config, readSettingsMap(db));
  const pulse = new PulseSampler({
    db,
    config: pulseConfig,
    ...(pulseConfig.intervalMs === undefined ? {} : { intervalMs: pulseConfig.intervalMs }),
    refreshers: buildRefreshers({
      http: pulseHttp,
      ...(config.githubToken !== "" ? { githubToken: config.githubToken } : {}),
    }),
    isPipelineActive: () => isPipelineActive(db),
    emit: (type, data) => {
      pipelineBus.emit("pulse", type, data);
    },
    today: () => new Date().toLocaleDateString("en-CA", { timeZone: config.tz }),
    nowIso: () => new Date().toISOString(),
    log: (message) => {
      logger.info({ msg: message }, "pulse");
    },
  });
  if (config.pulseEnabled) {
    pulse.start();
    const stopPulse = (): void => {
      pulse.stop();
    };
    process.once("SIGINT", stopPulse);
    process.once("SIGTERM", stopPulse);
  }

  const orchestrator = new Orchestrator({ db, config, log: logger });
  const scheduler = new PipelineScheduler({
    cronExpression: config.scheduleCron,
    timezone: config.tz,
    log: logger,
    onTrigger: (trigger) => {
      // Cron honors the my_categories settings key (empty = none selected).
      const categories = resolveCronCategories(db);
      return orchestrator.startRun({ trigger, ...(categories.length > 0 ? { categories } : {}) });
    },
  });
  scheduler.start();

  const today = new Date().toLocaleDateString("en-CA", { timeZone: config.tz });
  const missedToday = scheduler.needsCatchup(db, today);
  if (config.autoResume) {
    for (const runId of recovered.interruptedRuns) {
      logger.info({ runId }, "auto-resuming interrupted run");
      void orchestrator.retryRun(runId).catch((error: unknown) => {
        logger.error(
          { runId, err: error instanceof Error ? error.message : String(error) },
          "auto-resume failed",
        );
      });
    }
  }
  if (config.runMissedOnStart && missedToday && recovered.interruptedRuns.length === 0) {
    logger.info("no successful run today — starting catch-up run");
    void orchestrator.startRun({ trigger: "catchup" }).catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "catch-up run failed",
      );
    });
  }

  const app = await buildApp({
    version: APP_VERSION,
    config,
    db,
    log: logger,
    scheduler,
    staticDir: webDistDir(),
    ...(config.pulseEnabled ? { pulse } : {}),
  });
  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info(`TrendPulse listening on http://${config.host}:${String(config.port)}`);
  } catch (error) {
    logger.error({ err: error }, "failed to start server");
    db.close();
    await app.close();
    process.exitCode = 1;
  }
}

await main();
