/**
 * Composio REST API adapter implementing SheetsClient.
 * Replaces the service-account JSON key approach — only needs COMPOSIO_API_KEY.
 *
 * Composio API: POST https://backend.composio.dev/api/v3.1/tools/execute/{tool_slug}
 * Auth: x-api-key header. Body: {"arguments": {...}}
 */
import { SheetsApiError } from "./client.js";
import type { SheetsClient, TabRangeUpdate } from "./client.js";

const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1";
const COMPOSIO_TIMEOUT_MS = 30000;

interface ComposioResponse<T = unknown> {
  successful?: boolean;
  data?: T;
  // Gateway failures (e.g. 401) return error as an object {message, code, slug};
  // tool-execution failures return it as a string. Both must stay readable.
  error?: unknown;
}

/** Extract a readable message from Composio's string-or-object error shape. */
function composioErrorMessage(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && raw !== "") return raw;
  if (raw !== null && typeof raw === "object") {
    const message = (raw as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return fallback;
}

async function callComposio<T>(
  toolSlug: string,
  args: Record<string, unknown>,
  apiKey: string,
): Promise<T> {
  const url = `${COMPOSIO_BASE_URL}/tools/execute/${toolSlug}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPOSIO_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ arguments: args }),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: ComposioResponse<T>;
    try {
      parsed = JSON.parse(text) as ComposioResponse<T>;
    } catch {
      throw new SheetsApiError(`Composio returned non-JSON response (${res.status})`, {
        status: res.status,
      });
    }
    if (!res.ok || parsed.successful === false) {
      const msg = composioErrorMessage(parsed.error, `Composio tool ${toolSlug} failed (${res.status})`);
      const errorCode = res.status === 403 ? "FORBIDDEN" : res.status === 429 ? "QUOTA" : undefined;
      throw new SheetsApiError(msg, { status: res.status, errorCode });
    }
    return parsed.data as T;
  } catch (error) {
    if (error instanceof SheetsApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new SheetsApiError(`Composio tool ${toolSlug} timed out after ${COMPOSIO_TIMEOUT_MS}ms`, {});
    }
    throw new SheetsApiError(
      `Composio tool ${toolSlug} failed: ${error instanceof Error ? error.message : String(error)}`,
      {},
    );
  } finally {
    clearTimeout(timer);
  }
}

export class ComposioSheetsClient implements SheetsClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async getTabTitles(spreadsheetId: string): Promise<string[]> {
    const data = await callComposio<{ sheet_names?: string[]; sheets?: string[] }>(
      "GOOGLESHEETS_GET_SHEET_NAMES",
      { spreadsheet_id: spreadsheetId },
      this.apiKey,
    );
    return data.sheet_names ?? data.sheets ?? [];
  }

  async addTab(spreadsheetId: string, title: string): Promise<void> {
    await callComposio(
      "GOOGLESHEETS_ADD_SHEET",
      { spreadsheet_id: spreadsheetId, title },
      this.apiKey,
    );
  }

  async getFirstRow(spreadsheetId: string, tab: string): Promise<string[] | null> {
    const data = await callComposio<{ values?: string[][] }>(
      "GOOGLESHEETS_VALUES_GET",
      { spreadsheet_id: spreadsheetId, range: `${tab}!1:1` },
      this.apiKey,
    );
    const rows = data.values ?? [];
    if (rows.length === 0) return null;
    return (rows[0] ?? []).map(String);
  }

  async writeFirstRow(spreadsheetId: string, tab: string, headers: string[]): Promise<void> {
    await callComposio(
      "GOOGLESHEETS_VALUES_UPDATE",
      {
        spreadsheet_id: spreadsheetId,
        range: `${tab}!A1`,
        values: [headers],
        value_input_option: "RAW",
      },
      this.apiKey,
    );
  }

  async appendRows(spreadsheetId: string, tab: string, rows: string[][]): Promise<void> {
    await callComposio(
      "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
      {
        spreadsheet_id: spreadsheetId,
        range: tab,
        values: rows,
        value_input_option: "RAW",
      },
      this.apiKey,
    );
  }

  async getAllValues(spreadsheetId: string, tab: string): Promise<string[][]> {
    const data = await callComposio<{ values?: string[][] }>(
      "GOOGLESHEETS_VALUES_GET",
      { spreadsheet_id: spreadsheetId, range: tab },
      this.apiKey,
    );
    return (data.values ?? []).map((row) => row.map((cell) => String(cell)));
  }

  async batchUpdate(spreadsheetId: string, updates: TabRangeUpdate[]): Promise<void> {
    await callComposio(
      "GOOGLESHEETS_UPDATE_VALUES_BATCH",
      {
        spreadsheet_id: spreadsheetId,
        data: updates.map((u) => ({ range: u.range, values: u.values })),
        value_input_option: "RAW",
      },
      this.apiKey,
    );
  }

  /**
   * Composio has no "delete dimension" tool. Clear the cell values instead —
   * parseDataRows already skips blank rows, so retention still works.
   */
  async deleteRows(
    spreadsheetId: string,
    tab: string,
    startRowIndex: number,
    endRowIndexExclusive: number,
  ): Promise<void> {
    if (endRowIndexExclusive <= startRowIndex) return;
    const count = endRowIndexExclusive - startRowIndex;
    const emptyRows = Array.from({ length: count }, () => [""]);
    await callComposio(
      "GOOGLESHEETS_VALUES_UPDATE",
      {
        spreadsheet_id: spreadsheetId,
        range: `${tab}!A${startRowIndex + 1}`,
        values: emptyRows,
        value_input_option: "RAW",
      },
      this.apiKey,
    );
  }
}
