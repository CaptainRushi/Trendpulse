import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { applyMigrations, openDatabase } from "./db/sqlite.js";
import { createLogger, setRootLogger } from "./utils/logger.js";

dotenv.config();

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_VERSION = "0.1.0";

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

  const app = buildApp({ version: SERVER_VERSION });
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
