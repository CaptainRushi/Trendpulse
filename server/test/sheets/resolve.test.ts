import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { SheetsApiError } from "../../src/sheets/client.js";
import { ComposioSheetsClient } from "../../src/sheets/composioClient.js";
import { GoogleSheetsClient } from "../../src/sheets/realClient.js";
import { keyFileUsable, resolveSheetsClient } from "../../src/sheets/resolve.js";

function keyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tp-sheets-"));
  const path = join(dir, "key.json");
  writeFileSync(path, JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: "k" }));
  return path;
}

describe("resolveSheetsClient priority", () => {
  it("usable key file wins over a present Composio key", () => {
    const config = loadConfig({
      SHEETS_MODE: "composio",
      COMPOSIO_API_KEY: "ck_present_but_unused",
      GOOGLE_SERVICE_ACCOUNT_JSON_PATH: keyFile(),
    });
    expect(keyFileUsable(config.googleServiceAccountJsonPath)).toBe(true);
    const resolved = resolveSheetsClient(config);
    expect(resolved.via).toBe("service-account");
    expect(resolved.client).toBeInstanceOf(GoogleSheetsClient);
  });

  it("falls back to Composio when no key file exists", () => {
    const config = loadConfig({
      SHEETS_MODE: "composio",
      COMPOSIO_API_KEY: "ck_x",
      GOOGLE_SERVICE_ACCOUNT_JSON_PATH: "./does-not-exist.json",
    });
    const resolved = resolveSheetsClient(config);
    expect(resolved.via).toBe("composio");
    expect(resolved.client).toBeInstanceOf(ComposioSheetsClient);
  });

  it("names both options when nothing is configured", () => {
    const config = loadConfig({
      SHEETS_MODE: "composio",
      COMPOSIO_API_KEY: "",
      GOOGLE_SERVICE_ACCOUNT_JSON_PATH: "./does-not-exist.json",
    });
    let message = "";
    try {
      resolveSheetsClient(config);
    } catch (error) {
      expect(error).toBeInstanceOf(SheetsApiError);
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("COMPOSIO_API_KEY");
    expect(message).toContain("service-account");
  });
});
