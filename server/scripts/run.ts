/**
 * pipeline — Phase 6 CLI: full runs, resume, and re-sort.
 *
 * Usage:
 *   npm run pipeline -- start [--source <key> ...] [--stages a,b,...] [--date YYYY-MM-DD] [--limit N]
 *   npm run pipeline -- retry <runId> [--from-stage <stage>]
 *   npm run pipeline -- resort --date YYYY-MM-DD
 *
 * Progress goes to stderr (stage/source/done lines); the final summary is
 * JSON on stdout. Exit 1 on failure; a busy pipeline reports the holder.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnvFiles } from "../src/config/loadEnv.js";
import pino from "pino";
import { loadConfig } from "../src/config/env.js";
import { applyMigrations, openDatabase } from "../src/db/sqlite.js";
import { EventBus } from "../src/pipeline/events.js";
import { Orchestrator, STAGES } from "../src/pipeline/orchestrator.js";
import type { RunSummary, StageName } from "../src/pipeline/orchestrator.js";
import { LockBusyError } from "../src/scheduler/lock.js";
import type { SourceKey } from "../src/sheets/schema.js";
import { repoDbPath } from "./lib/dbPath.js";

loadEnvFiles();

const USAGE =
  "usage:\n" +
  "  npm run pipeline -- start [--source <key> ...] [--stages a,b,...] [--date YYYY-MM-DD] [--limit N]\n" +
  "  npm run pipeline -- retry <runId> [--from-stage <stage>]\n" +
  "  npm run pipeline -- resort --date YYYY-MM-DD\n" +
  `stages: ${STAGES.join(", ")}\n`;

function parseDate(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`${flag} needs a value`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${flag} needs YYYY-MM-DD, got '${value}'`);
  return value;
}

function parseStages(value: string | undefined): StageName[] {
  if (value === undefined) throw new Error("--stages needs a value");
  const stages = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stage of stages) {
    if (!(STAGES as readonly string[]).includes(stage)) {
      throw new Error(`unknown stage '${stage}' (stages: ${STAGES.join(", ")})`);
    }
  }
  return stages as StageName[];
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) throw new Error("--limit needs a value");
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--limit needs a positive integer, got '${value}'`);
  return n;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  try {
    if (command === "start") await commandStart(argv.slice(1));
    else if (command === "retry") await commandRetry(argv.slice(1));
    else if (command === "resort") await commandResort(argv.slice(1));
    else throw new Error(`unknown command '${command ?? ""}'`);
  } catch (error) {
    if (error instanceof LockBusyError) {
      process.stderr.write(`pipeline is already running (run ${error.holderRunId})\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.stderr.write(USAGE);
    process.exitCode = 1;
  }
}

function buildOrchestrator(): Orchestrator {
  const config = loadConfig();
  const dbPath = repoDbPath(import.meta.url);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  applyMigrations(db);
  const events = new EventBus();
  events.subscribe((event) => {
    if (event.type === "stage") {
      const stage = typeof event.data["stage"] === "string" ? event.data["stage"] : "?";
      const status = typeof event.data["status"] === "string" ? event.data["status"] : "?";
      process.stderr.write(`[${event.runId.slice(0, 8)}] stage ${stage}: ${status}\n`);
    } else if (event.type === "source") {
      const source = typeof event.data["source"] === "string" ? event.data["source"] : "?";
      const status = typeof event.data["status"] === "string" ? event.data["status"] : "?";
      const items = typeof event.data["items"] === "number" ? event.data["items"] : 0;
      process.stderr.write(`[${event.runId.slice(0, 8)}] source ${source}: ${status} (${String(items)} items)\n`);
    } else if (event.type === "done" || event.type === "error") {
      process.stderr.write(`[${event.runId.slice(0, 8)}] ${event.type}\n`);
    }
  });
  return new Orchestrator({
    db,
    config,
    log: pino({ level: process.env["LOG_LEVEL"] ?? "info" }),
    events,
  });
}

function printSummary(summary: RunSummary): void {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function commandStart(args: string[]): Promise<void> {
  const sources: string[] = [];
  let stages: StageName[] | undefined;
  let date: string | undefined;
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--source") {
      const value = args[++i];
      if (value === undefined) throw new Error("--source needs a value");
      sources.push(value);
    } else if (arg === "--stages") {
      stages = parseStages(args[++i]);
    } else if (arg === "--date") {
      date = parseDate(args[++i], "--date");
    } else if (arg === "--limit") {
      limit = parseLimit(args[++i]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  const orch = buildOrchestrator();
  const summary = await orch.startRun({
    trigger: "manual",
    ...(date ? { runDate: date } : {}),
    ...(stages ? { stages } : {}),
    ...(sources.length > 0 ? { sources: sources as SourceKey[] } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  printSummary(summary);
  if (summary.status === "failed") process.exitCode = 1;
}

async function commandRetry(args: string[]): Promise<void> {
  const runId = args[0];
  if (runId === undefined || runId.startsWith("--")) throw new Error("retry needs a runId");
  let fromStage: StageName | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--from-stage") {
      const value = args[++i];
      if (value === undefined || !(STAGES as readonly string[]).includes(value)) {
        throw new Error(`--from-stage needs one of: ${STAGES.join(", ")}`);
      }
      fromStage = value as StageName;
    } else {
      throw new Error(`unknown argument: ${args[i] ?? ""}`);
    }
  }
  const orch = buildOrchestrator();
  const summary = await orch.retryRun(runId, fromStage);
  printSummary(summary);
  if (summary.status === "failed") process.exitCode = 1;
}

async function commandResort(args: string[]): Promise<void> {
  let date: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date") date = parseDate(args[++i], "--date");
    else throw new Error(`unknown argument: ${args[i] ?? ""}`);
  }
  if (!date) throw new Error("resort needs --date YYYY-MM-DD");
  const orch = buildOrchestrator();
  const summary = await orch.resortRun(date);
  printSummary(summary);
  if (summary.status === "failed") process.exitCode = 1;
}

await main();
