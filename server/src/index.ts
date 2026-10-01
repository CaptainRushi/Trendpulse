import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { applyMigrations, openDatabase } from "./db/sqlite.js";
import { Orchestrator } from "./pipeline/orchestrator.js";
import { PipelineScheduler } from "./scheduler/cron.js";
import { recoverOnBoot } from "./scheduler/lock.js";
import { createLogger, setRootLogger } from "./utils/logger.js";
import { APP_VERSION } from "./version.js";

dotenv.config();

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

  const orchestrator = new Orchestrator({ db, config, log: logger });
  const scheduler = new PipelineScheduler({
    cronExpression: config.scheduleCron,
    timezone: config.tz,
    log: logger,
    onTrigger: (trigger) => orchestrator.startRun({ trigger }),
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

  const app = buildApp({
    version: APP_VERSION,
    config,
    db,
    log: logger,
    scheduler,
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
