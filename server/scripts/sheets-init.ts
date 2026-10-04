/**
 * sheets:init — create the four tabs (+ headers, frozen row 1) in the real sheet.
 * Needs GOOGLE_SHEET_ID (or --create with a Composio key) and credentials;
 * otherwise prints exactly what is missing and exits 1 (no stack trace).
 */
import { existsSync } from "node:fs";
import { loadEnvFiles } from "../src/config/loadEnv.js";
import { loadConfig } from "../src/config/env.js";
import { SheetsWriteQueue } from "../src/sheets/queue.js";
import { createRealSheetsClient } from "../src/sheets/realClient.js";
import { ComposioSheetsClient } from "../src/sheets/composioClient.js";
import { SheetsRepo } from "../src/sheets/repo.js";

loadEnvFiles();

const config = loadConfig();
const createFlag = process.argv.includes("--create");
let sheetId = config.googleSheetId;

const useComposio = config.sheetsMode === "composio" || config.composioApiKey !== "";
const client: ComposioSheetsClient | ReturnType<typeof createRealSheetsClient>["client"] = useComposio
  ? new ComposioSheetsClient({
      apiKey: config.composioApiKey,
      userId: config.composioUserId,
      timeoutMs: config.composioCallTimeoutMs,
    })
  : createRealSheetsClient(config.googleServiceAccountJsonPath).client;
const authLabel = useComposio ? "composio" : "service-account";

const missing: string[] = [];
if (sheetId === "" && !(createFlag && client instanceof ComposioSheetsClient)) {
  missing.push("GOOGLE_SHEET_ID (or --create with a Composio key)");
}
if (config.composioApiKey === "" && !existsSync(config.googleServiceAccountJsonPath)) {
  missing.push("COMPOSIO_API_KEY or service-account key file");
}
if (missing.length > 0) {
  process.stdout.write("sheets:init skipped — missing:\n");
  for (const m of missing) process.stdout.write(`  - ${m}\n`);
  process.exit(1);
}

if (sheetId === "" && client instanceof ComposioSheetsClient) {
  const created = await client.createSpreadsheet("TrendPulse");
  sheetId = created.spreadsheetId;
  process.stdout.write(`created spreadsheet: ${created.spreadsheetUrl || sheetId}\n`);
  process.stdout.write("save it as GOOGLE_SHEET_ID in .env, then re-run sheets:init.\n");
}

const repo = new SheetsRepo(client, {
  spreadsheetId: sheetId,
  cacheTtlS: config.sheetCacheTtlS,
  queue: new SheetsWriteQueue(),
});
const { created } = await repo.init();
const tabs = await client.getTabTitles(sheetId);
process.stdout.write(`auth: ${authLabel}\n`);
process.stdout.write(`tabs: ${tabs.join(", ")}\n`);
process.stdout.write(
  created.length === 0 ? "already initialized (no tabs created)\n" : `created: ${created.join(", ")}\n`,
);
