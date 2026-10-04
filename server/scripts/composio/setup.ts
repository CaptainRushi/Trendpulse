/**
 * composio:setup (docs/15 PACKAGE C2) — key check, managed auth config,
 * connect link, wait for ACTIVE, create-or-paste spreadsheet, test.
 * Flags: --create, --sheet-id <id>. Without a key it prints setup steps
 * and exits 1; tab init is `npm run sheets:init` (C3).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { loadEnvFiles } from "../../src/config/loadEnv.js";
import { loadConfig } from "../../src/config/env.js";
import { upsertEnvLines } from "../../src/config/envFile.js";
import { applyMigrations, openDatabase } from "../../src/db/sqlite.js";
import { writeSetting } from "../../src/config/settings.js";
import { checkToolLock, loadToolLock } from "../../src/integrations/composio/tool-map.js";
import { createGateway } from "../../src/integrations/composio/gateway.js";
import {
  ensureAuthConfig,
  getConnection,
  startConnection,
  waitForActive,
} from "../../src/integrations/composio/auth.js";
import { ComposioError } from "../../src/integrations/composio/errors.js";
import { repoDbPath } from "../lib/dbPath.js";

loadEnvFiles();

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, "..", "..");
const envPath = join(repoRoot, ".env");

const args = process.argv.slice(2);
const sheetIdFlag = (() => {
  const at = args.indexOf("--sheet-id");
  return at >= 0 ? (args[at + 1] ?? "") : "";
})();
const createFlag = args.includes("--create");

function saveEnv(values: Map<string, string>): void {
  const existing = readFileSync(envPath, "utf8").split("\n");
  writeFileSync(envPath, `${upsertEnvLines(existing, values).join("\n").replace(/\n+$/, "")}\n`);
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Best effort — the printed link is the fallback.
  }
}

const config = loadConfig();
if (config.composioApiKey === "") {
  process.stdout.write(
    "Composio is not configured yet (3 steps):\n" +
      "  1. Sign up at composio.dev, create a project, copy its API key.\n" +
      "  2. Put it in .env as COMPOSIO_API_KEY and re-run npm run composio:setup.\n" +
      "  3. Approve the Google connect link this script prints.\n",
  );
  process.exit(1);
}

const lockProblems = checkToolLock(loadToolLock());
if (lockProblems.length > 0) {
  process.stdout.write(`note: tool lock not pinned yet (${lockProblems[0] as string})\n`);
}

const authCtx = {
  apiKey: config.composioApiKey,
  userId: config.composioUserId,
  timeoutMs: config.composioCallTimeoutMs,
};

try {
  const authConfigId = await ensureAuthConfig(authCtx, config.composioGooglesheetsAuthConfigId);
  if (authConfigId !== config.composioGooglesheetsAuthConfigId) {
    saveEnv(new Map([["COMPOSIO_GOOGLESHEETS_AUTH_CONFIG_ID", authConfigId]]));
    process.stdout.write(`auth config: ${authConfigId} (saved to .env)\n`);
  } else {
    process.stdout.write(`auth config: ${authConfigId}\n`);
  }

  const dbPath = repoDbPath(import.meta.url);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  applyMigrations(db);

  let accountId = "";
  const stored = db.prepare("SELECT value_json FROM settings WHERE key = 'composio_connection'").get() as
    | { value_json: string }
    | undefined;
  if (stored) {
    try {
      const parsed = JSON.parse(stored.value_json) as { requestId?: string };
      if (parsed.requestId) {
        const current = await getConnection(authCtx, parsed.requestId);
        if (current.status === "ACTIVE" && current.accountId) {
          accountId = current.accountId;
          process.stdout.write("google connection already ACTIVE — skipping re-connect.\n");
        }
      }
    } catch {
      // Fall through to a fresh connection.
    }
  }

  if (accountId === "") {
    const started = await startConnection(authCtx, authConfigId);
    process.stdout.write(`\nApprove Google access here:\n  ${started.redirectUrl}\n`);
    openBrowser(started.redirectUrl);
    const active = await waitForActive(authCtx, started.requestId);
    accountId = active.accountId ?? "";
    writeSetting(db, "composio_connection", { status: "ACTIVE", accountId, requestId: started.requestId });
    process.stdout.write("google connection ACTIVE.\n");
  }
  writeSetting(db, "composio_auth_config_id", authConfigId);
  db.close();

  const gateway = createGateway(authCtx);
  let sheetId = sheetIdFlag !== "" ? sheetIdFlag : config.googleSheetId;
  if (sheetId === "" && !createFlag) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Create the TrendPulse spreadsheet for me? [Y/n] ")).trim().toLowerCase();
    rl.close();
    if (answer === "" || answer === "y" || answer === "yes") {
      const created = (await gateway.execute("createSpreadsheet", { title: "TrendPulse" })).data as
        | { spreadsheetId?: string }
        | undefined;
      if (!created?.spreadsheetId) throw new ComposioError("COMPOSIO_TOOL_ERROR", "spreadsheet create returned no id.");
      sheetId = created.spreadsheetId;
    } else {
      const rl2 = createInterface({ input: process.stdin, output: process.stdout });
      sheetId = (await rl2.question("Paste the spreadsheet id: ")).trim();
      rl2.close();
    }
  } else if (sheetId === "" && createFlag) {
    const created = (await gateway.execute("createSpreadsheet", { title: "TrendPulse" })).data as
      | { spreadsheetId?: string }
      | undefined;
    if (!created?.spreadsheetId) throw new ComposioError("COMPOSIO_TOOL_ERROR", "spreadsheet create returned no id.");
    sheetId = created.spreadsheetId;
  }
  if (sheetId === "") throw new ComposioError("SHEET_ID_INVALID", "no spreadsheet id — re-run with --create or --sheet-id <id>.");
  saveEnv(new Map([["GOOGLE_SHEET_ID", sheetId]]));

  const info = (await gateway.execute("spreadsheetInfo", { spreadsheet_id: sheetId })).data as
    | { title?: string; tabs?: { title: string }[] }
    | undefined;
  const tabs = info?.tabs?.map((t) => t.title) ?? [];
  process.stdout.write(
    `\nsummary: connected account ${accountId === "" ? "(default)" : accountId}, ` +
      `spreadsheet '${info?.title ?? sheetId}' (${String(tabs.length)} tabs: ${tabs.join(", ")}).\n` +
      "next: npm run sheets:init\n",
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`composio:setup failed: ${message}\n`);
  process.exit(1);
}
