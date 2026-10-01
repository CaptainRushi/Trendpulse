/**
 * SheetsClient — the seam between the repo and the Sheets API.
 * Production uses the googleapis adapter (realClient.ts); tests use the
 * in-memory fake. The repo never touches googleapis types directly.
 */

export type SheetsErrorCode = "QUOTA" | "FORBIDDEN" | "RANGE_NOT_FOUND" | "SHEET_NOT_FOUND";

export class SheetsApiError extends Error {
  readonly status?: number | undefined;
  readonly errorCode?: SheetsErrorCode | undefined;
  readonly retryAfterSeconds?: number | undefined;

  constructor(
    message: string,
    opts: {
      status?: number | undefined;
      errorCode?: SheetsErrorCode | undefined;
      retryAfterSeconds?: number | undefined;
    } = {},
  ) {
    super(message);
    this.name = "SheetsApiError";
    this.status = opts.status;
    this.errorCode = opts.errorCode;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/** Retry 429 and 5xx only. 403/400 must surface immediately with fix hints. */
export function isRetryableSheetsError(error: unknown): boolean {
  if (!(error instanceof SheetsApiError)) return false;
  return error.status === 429 || (error.status !== undefined && error.status >= 500);
}

/**
 * The tab a write targeted was deleted (or never init'ed).
 * Detected by code, or by status + the API's range phrasing as fallback.
 */
export function isMissingRangeError(error: unknown): boolean {
  if (!(error instanceof SheetsApiError)) return false;
  if (error.errorCode === "RANGE_NOT_FOUND") return true;
  if (error.status !== 400 && error.status !== 404) return false;
  return /unable to parse range|range .* not found|requested entity was not found/i.test(error.message);
}

export interface TabRangeUpdate {
  /** A1 notation, e.g. "sorted_trends!X42". Tab names here never need quoting. */
  range: string;
  values: string[][];
}

export interface SheetsClient {
  getTabTitles(spreadsheetId: string): Promise<string[]>;
  addTab(spreadsheetId: string, title: string): Promise<void>;
  /** First row of the tab, or null when the tab is empty. */
  getFirstRow(spreadsheetId: string, tab: string): Promise<string[] | null>;
  writeFirstRow(spreadsheetId: string, tab: string, headers: string[]): Promise<void>;
  appendRows(spreadsheetId: string, tab: string, rows: string[][]): Promise<void>;
  /** All values including the header row. Throws RANGE_NOT_FOUND when missing. */
  getAllValues(spreadsheetId: string, tab: string): Promise<string[][]>;
  batchUpdate(spreadsheetId: string, updates: TabRangeUpdate[]): Promise<void>;
  /**
   * Delete whole rows by 0-based sheet index (header is row 0):
   * removes [startRowIndex, endRowIndexExclusive). No-op when empty.
   * Throws SHEET_NOT_FOUND when the tab is missing.
   */
  deleteRows(
    spreadsheetId: string,
    tab: string,
    startRowIndex: number,
    endRowIndexExclusive: number,
  ): Promise<void>;
}
