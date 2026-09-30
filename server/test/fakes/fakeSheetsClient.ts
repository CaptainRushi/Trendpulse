/**
 * In-memory SheetsClient for tests. Mimics the real API's observable behavior:
 * - append/get on a missing tab throws 400 RANGE_NOT_FOUND (like values.append)
 * - appends preserve order; values stored as given
 * - programmable failures to simulate 429/5xx/403
 */
import { SheetsApiError } from "../../src/sheets/client.js";
import type { SheetsClient, SheetsErrorCode, TabRangeUpdate } from "../../src/sheets/client.js";

export interface PlannedFailure {
  method?: string;
  times: number;
  status: number;
  errorCode?: SheetsErrorCode | undefined;
  retryAfterSeconds?: number | undefined;
  message?: string;
}

export interface FakeCall {
  method: string;
  tab: string;
  rows: number;
  at: number;
}

function parseTab(rangeOrTab: string): string {
  const bang = rangeOrTab.indexOf("!");
  return bang === -1 ? rangeOrTab : rangeOrTab.slice(0, bang);
}

export class FakeSheetsClient implements SheetsClient {
  /** title → rows. Row 0 is the header row (may be absent = fresh tab). */
  readonly tabs = new Map<string, string[][]>();
  readonly calls: FakeCall[] = [];
  private failures: PlannedFailure[] = [];

  /** Next N matching calls throw the given Sheets error. */
  failNext(failure: PlannedFailure): void {
    this.failures.push({ ...failure });
  }

  deleteTab(title: string): void {
    this.tabs.delete(title);
  }

  rowCount(title: string): number {
    return this.tabs.get(title)?.length ?? 0;
  }

  private maybeFail(method: string): void {
    const idx = this.failures.findIndex(
      (f) => f.times > 0 && (f.method === undefined || f.method === method),
    );
    if (idx === -1) return;
    const f = this.failures[idx]!;
    f.times -= 1;
    throw new SheetsApiError(f.message ?? `${String(f.status)} injected failure`, {
      status: f.status,
      errorCode: f.errorCode,
      retryAfterSeconds: f.retryAfterSeconds,
    });
  }

  private log(method: string, tab: string, rows: number): void {
    this.calls.push({ method, tab, rows, at: Date.now() });
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  async getTabTitles(): Promise<string[]> {
    this.maybeFail("getTabTitles");
    this.log("getTabTitles", "", 0);
    return [...this.tabs.keys()];
  }

  async addTab(title: string): Promise<void> {
    this.maybeFail("addTab");
    this.log("addTab", title, 0);
    if (!this.tabs.has(title)) this.tabs.set(title, []);
  }

  async getFirstRow(_spreadsheetId: string, tab: string): Promise<string[] | null> {
    this.maybeFail("getFirstRow");
    this.log("getFirstRow", tab, 0);
    return this.tabs.get(tab)?.[0] ?? null;
  }

  async writeFirstRow(_spreadsheetId: string, tab: string, headers: string[]): Promise<void> {
    this.maybeFail("writeFirstRow");
    this.log("writeFirstRow", tab, headers.length);
    const rows = this.tabs.get(tab) ?? [];
    rows[0] = [...headers];
    this.tabs.set(tab, rows);
  }

  async appendRows(_spreadsheetId: string, tab: string, rows: string[][]): Promise<void> {
    // Log the attempt before failing: the call reached the API either way.
    this.log("appendRows", tab, rows.length);
    this.maybeFail("appendRows");
    const existing = this.tabs.get(tab);
    if (existing === undefined) {
      throw new SheetsApiError(`Unable to parse range: '${tab}'!A1`, {
        status: 400,
        errorCode: "RANGE_NOT_FOUND",
      });
    }
    for (const row of rows) existing.push([...row]);
  }

  async getAllValues(_spreadsheetId: string, tab: string): Promise<string[][]> {
    this.maybeFail("getAllValues");
    this.log("getAllValues", tab, 0);
    const rows = this.tabs.get(tab);
    if (rows === undefined) {
      throw new SheetsApiError(`Requested entity was not found.`, {
        status: 404,
        errorCode: "RANGE_NOT_FOUND",
      });
    }
    return rows.map((r) => [...r]);
  }

  async batchUpdate(_spreadsheetId: string, updates: TabRangeUpdate[]): Promise<void> {
    this.maybeFail("batchUpdate");
    this.log(
      "batchUpdate",
      updates.map((u) => u.range).join(","),
      updates.length,
    );
    for (const update of updates) {
      const tab = parseTab(update.range);
      const rows = this.tabs.get(tab);
      if (rows === undefined) {
        throw new SheetsApiError(`Unable to parse range: '${update.range}'`, {
          status: 400,
          errorCode: "RANGE_NOT_FOUND",
        });
      }
      const match = update.range.match(/!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
      if (!match) throw new Error(`FakeSheetsClient: unsupported range ${update.range}`);
      const startRow = Number(match[2]);
      const startCol = columnToIndex(match[1]!);
      update.values.forEach((valueRow, r) => {
        valueRow.forEach((value, c) => {
          const target = rows[startRow - 1 + r];
          if (target) target[startCol + c] = value;
        });
      });
    }
  }
}

function columnToIndex(col: string): number {
  let index = 0;
  for (const ch of col) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}
