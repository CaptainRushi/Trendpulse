/**
 * live:composio (docs/15 PACKAGE C6) — end-to-end against the real API.
 * Refuses without COMPOSIO_API_KEY and refuses any spreadsheet whose title
 * does not start with TrendPulse (never touches user data). Prints per-op
 * calls/latency and the monthly budget consumed.
 */
import { loadEnvFiles } from "../../src/config/loadEnv.js";
import { loadConfig } from "../../src/config/env.js";
import { applyMigrations, openDatabase } from "../../src/db/sqlite.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ComposioSheetsClient } from "../../src/sheets/composioClient.js";
import { SheetsRepo } from "../../src/sheets/repo.js";
import { SheetsWriteQueue } from "../../src/sheets/queue.js";
import { recordCall, budgetUsage } from "../../src/integrations/composio/budget.js";
import { createGateway } from "../../src/integrations/composio/gateway.js";
import { repoDbPath } from "../lib/dbPath.js";

loadEnvFiles();
const config = loadConfig();

if (config.composioApiKey === "") {
  process.stdout.write("WAITING: COMPOSIO_API_KEY not set — live check needs a key and a connected Google account.\n");
  process.exit(2);
}

const dbPath = repoDbPath(import.meta.url);
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);
applyMigrations(db);

const client = new ComposioSheetsClient({
  apiKey: config.composioApiKey,
  userId: config.composioUserId,
  timeoutMs: config.composioCallTimeoutMs,
  onCall: (record) => {
    recordCall(db, "live_composio", record);
  },
});
const instantQueue = new SheetsWriteQueue({
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});

let sheetId = config.googleSheetId;
if (sheetId === "") {
  const created = await client.createSpreadsheet("TrendPulse-LIVE");
  sheetId = created.spreadsheetId;
  process.stdout.write(`created: ${created.spreadsheetUrl || sheetId}\n`);
} else {
  // Safety: never touch a spreadsheet that is not ours.
  const gateway = createGateway({ apiKey: config.composioApiKey, userId: config.composioUserId, timeoutMs: config.composioCallTimeoutMs });
  const info = await gateway.execute("spreadsheetInfo", { spreadsheet_id: sheetId });
  if (!info.ok) {
    process.stdout.write(`WAITING: cannot reach the sheet (${info.error ?? "tool failed"}) — fix the key and connection first.\n`);
    process.exit(2);
  }
  const title = (info.data as { title?: string } | undefined)?.title ?? "";
  if (!title.startsWith("TrendPulse")) {
    process.stdout.write(`REFUSED: spreadsheet title '${title}' does not start with TrendPulse — live check only touches its own sheets.\n`);
    process.exit(3);
  }
  process.stdout.write(`target: '${title}'\n`);
}

const repo = new SheetsRepo(client, { spreadsheetId: sheetId, queue: instantQueue });
const { created } = await repo.init();
process.stdout.write(`init: created [${created.join(", ")}]\n`);

// 600 rows → two batches; then read back, mark latest, retain.
const now = new Date().toISOString();
const batch = Array.from({ length: 600 }, (_, i) => ({
  id: `live-${now}-${String(i)}`,
  run_id: "live_composio",
  collected_at: now,
  source: "hackernews" as const,
  source_item_id: null,
  url: "https://example.com/live",
  title: `live ${String(i)}`,
  snippet: "",
  author: null,
  published_at: null,
  engagement_score: null,
  engagement_extra: {},
  engagement_norm: 0,
  language: null,
  region: null,
  content_hash: `live-h${String(i)}`,
  merged_sources: [],
  extraction_model: null,
  source_label: null,
}));
const appended = await repo.appendRaw(batch);
process.stdout.write(`append: ${String(appended.rowsAppended)} rows in ${String(appended.batches)} batches\n`);

const read = await repo.readRaw({ runId: "live_composio" });
process.stdout.write(`read back: ${String(read.rows.length)} rows, ${String(read.warnings)} warnings\n`);

const usage = budgetUsage(db, config.composioMonthlyCallBudget);
process.stdout.write(`budget: ${String(usage.used)}/${String(usage.limit)} calls this month\n`);
process.stdout.write("live:composio done — verify the TrendPulse-LIVE sheet, then delete it.\n");
db.close();
