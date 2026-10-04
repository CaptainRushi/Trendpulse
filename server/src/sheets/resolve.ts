/**
 * Single place that picks the Sheets client (Doc: wizard trap — five call
 * sites duplicated the `composioApiKey !== ""` ternary and disagreed).
 * Priority: explicit SHEETS_MODE=service_account → key file; default
 * composio mode → usable local key file first (no network, no third party),
 * then Composio; anything else is a clear error naming both options.
 */
import type { TrendPulseConfig } from "../config/env.js";
import { loadServiceAccountKeyFile } from "./auth.js";
import { SheetsApiError, type SheetsClient } from "./client.js";
import { ComposioSheetsClient } from "./composioClient.js";
import { createRealSheetsClient } from "./realClient.js";

export interface ResolvedSheets {
  client: SheetsClient;
  via: "service-account" | "composio";
  /** Email for the share hint, or "composio". */
  detail: string;
}

/** Local key file parses — usable without any network. Never throws. */
export function keyFileUsable(path: string): boolean {
  try {
    loadServiceAccountKeyFile(path);
    return true;
  } catch {
    return false;
  }
}

function viaFile(config: TrendPulseConfig): ResolvedSheets {
  try {
    const bundle = createRealSheetsClient(config.googleServiceAccountJsonPath);
    return { client: bundle.client, via: "service-account", detail: bundle.serviceAccountEmail };
  } catch (error) {
    throw new SheetsApiError(error instanceof Error ? error.message : String(error), {});
  }
}

export function resolveSheetsClient(config: TrendPulseConfig): ResolvedSheets {
  if (config.sheetsMode === "service_account") {
    return viaFile(config);
  }
  if (config.sheetsMode === "composio") {
    if (keyFileUsable(config.googleServiceAccountJsonPath)) return viaFile(config);
    if (config.composioApiKey !== "") {
      const client = new ComposioSheetsClient({
        apiKey: config.composioApiKey,
        userId: config.composioUserId,
        timeoutMs: config.composioCallTimeoutMs,
      });
      return { client, via: "composio", detail: "composio" };
    }
    throw new SheetsApiError(
      "no sheets credential: share the sheet with the service-account email as Editor " +
        `(key file missing at '${config.googleServiceAccountJsonPath}'), or set COMPOSIO_API_KEY and connect Google.`,
      {},
    );
  }
  throw new SheetsApiError(`SHEETS_MODE='${config.sheetsMode}' has no runtime client — use composio or service_account.`, {});
}
