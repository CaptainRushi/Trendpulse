/**
 * googleapis adapter implementing SheetsClient, plus the pure HTTP-error
 * mapper (unit-tested without credentials).
 *
 * Conventions (recorded in DECISIONS.md):
 * - Writes use valueInputOption RAW: what we send is what lands in the cell,
 *   so "TRUE" stays the string "TRUE" our parser expects.
 * - Reads use UNFORMATTED_VALUE: numbers/bools arrive typed (never locale
 *   formatted), and the mappers coerce every cell defensively anyway.
 */
import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";
import { SHEETS_SCOPE, loadServiceAccountKeyFile } from "./auth.js";
import { SheetsApiError } from "./client.js";
import type { SheetsClient, SheetsErrorCode, TabRangeUpdate } from "./client.js";

/** Minimal Gaxios-shaped error — only the fields we read. */
interface HttpErrorShape {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  response?: {
    status?: unknown;
    headers?: Record<string, unknown>;
    data?: unknown;
  };
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && (typeof value === "string" || typeof value === "number")) {
      return String(value);
    }
  }
  return undefined;
}

/** Classify a googleapis/Gaxios failure into SheetsApiError. Pure: no I/O. */
export function mapSheetsHttpError(error: unknown): SheetsApiError {
  if (error instanceof SheetsApiError) return error;
  const shape = (error ?? {}) as HttpErrorShape;
  const response = shape.response;
  const status =
    typeof response?.status === "number"
      ? response.status
      : typeof shape.status === "number"
        ? shape.status
        : typeof shape.code === "number"
          ? shape.code
          : undefined;
  const message =
    typeof shape.message === "string" && shape.message !== "" ? shape.message : "Sheets request failed";

  let errorCode: SheetsErrorCode | undefined;
  if (status === 429) errorCode = "QUOTA";
  else if (status === 403) errorCode = "FORBIDDEN";
  else if (status === 404 && /requested entity was not found/i.test(message)) {
    errorCode = "SHEET_NOT_FOUND";
  } else if (status === 400 && /unable to parse range|range .* not found/i.test(message)) {
    errorCode = "RANGE_NOT_FOUND";
  }

  const retryAfterRaw = headerValue(response?.headers, "retry-after");
  const retryAfterSeconds =
    retryAfterRaw !== undefined && retryAfterRaw !== "" && Number.isFinite(Number(retryAfterRaw))
      ? Number(retryAfterRaw)
      : undefined;

  return new SheetsApiError(message, { status, errorCode, retryAfterSeconds });
}

async function call<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapSheetsHttpError(error);
  }
}

export class GoogleSheetsClient implements SheetsClient {
  private readonly api: sheets_v4.Sheets;

  constructor(api: sheets_v4.Sheets) {
    this.api = api;
  }

  async getTabTitles(spreadsheetId: string): Promise<string[]> {
    const res = await call("getTabTitles", () =>
      this.api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" }),
    );
    return (res.data.sheets ?? [])
      .map((s) => s.properties?.title ?? "")
      .filter((t) => t !== "");
  }

  async addTab(spreadsheetId: string, title: string): Promise<void> {
    await call("addTab", () =>
      this.api.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      }),
    );
  }

  async getFirstRow(spreadsheetId: string, tab: string): Promise<string[] | null> {
    const res = await call("getFirstRow", () =>
      this.api.spreadsheets.values.get({
        spreadsheetId,
        range: `${tab}!1:1`,
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
    );
    const rows = res.data.values ?? [];
    if (rows.length === 0) return null;
    return (rows[0] ?? []).map(String);
  }

  async writeFirstRow(spreadsheetId: string, tab: string, headers: string[]): Promise<void> {
    await call("writeFirstRow", () =>
      this.api.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] },
      }),
    );
  }

  async appendRows(spreadsheetId: string, tab: string, rows: string[][]): Promise<void> {
    await call("appendRows", () =>
      this.api.spreadsheets.values.append({
        spreadsheetId,
        range: tab,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: rows },
      }),
    );
  }

  async getAllValues(spreadsheetId: string, tab: string): Promise<string[][]> {
    const res = await call("getAllValues", () =>
      this.api.spreadsheets.values.get({
        spreadsheetId,
        range: tab,
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
    );
    return (res.data.values ?? []).map((row) => row.map((cell) => String(cell)));
  }

  async batchUpdate(spreadsheetId: string, updates: TabRangeUpdate[]): Promise<void> {
    await call("batchUpdate", () =>
      this.api.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: updates.map((u) => ({ range: u.range, values: u.values })),
        },
      }),
    );
  }

  async deleteRows(
    spreadsheetId: string,
    tab: string,
    startRowIndex: number,
    endRowIndexExclusive: number,
  ): Promise<void> {
    if (endRowIndexExclusive <= startRowIndex) return;
    await call("deleteRows", async () => {
      const meta = await this.api.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties",
      });
      const sheetId = (meta.data.sheets ?? []).find((s) => s.properties?.title === tab)?.properties
        ?.sheetId;
      if (sheetId === undefined || sheetId === null) {
        throw new SheetsApiError(`Requested entity was not found (tab '${tab}')`, {
          status: 404,
          errorCode: "SHEET_NOT_FOUND",
        });
      }
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: startRowIndex,
                  endIndex: endRowIndexExclusive,
                },
              },
            },
          ],
        },
      });
    });
  }
}

export interface RealClientBundle {
  client: SheetsClient;
  serviceAccountEmail: string;
}

/** Build the production client from the configured key file. */
export function createRealSheetsClient(keyFilePath: string): RealClientBundle {
  const key = loadServiceAccountKeyFile(keyFilePath);
  const auth = new google.auth.JWT({
    email: key.clientEmail,
    key: key.privateKey,
    scopes: [SHEETS_SCOPE],
  });
  const api = google.sheets({ version: "v4", auth });
  return { client: new GoogleSheetsClient(api), serviceAccountEmail: key.clientEmail };
}
