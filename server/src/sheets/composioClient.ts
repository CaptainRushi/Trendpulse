/**
 * Gateway-backed Composio SheetsClient (docs/15 PACKAGE C3).
 * All operations resolve their tool slug from tools.lock.json at call time;
 * writes funnel through the single writer queue (1.1s gap, Retry-After
 * backoff). Appends are idempotent: after any failed append the key column
 * of the tail window is re-read and landed rows are dropped before retry.
 */
import { SheetsApiError } from "./client.js";
import type { SheetsClient, SheetsErrorCode, TabRangeUpdate } from "./client.js";
import { TAB_KEY_COLUMNS } from "./schema.js";
import { SheetsWriteQueue } from "./queue.js";
import {
  createGateway,
  RestComposioGateway,
  type CallRecord,
  type ComposioGateway,
  type ExecuteResult,
} from "../integrations/composio/gateway.js";
import type { ToolLock } from "../integrations/composio/tool-map.js";

export interface ComposioClientOptions {
  apiKey: string;
  userId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  lock?: ToolLock;
  queue?: SheetsWriteQueue;
  onCall?: (record: CallRecord) => void;
  gateway?: ComposioGateway;
}

interface SheetInfo {
  title: string;
  tabs: { title: string; sheetId: number }[];
}

function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Key column for idempotent retry; unknown tabs (archive_*) fall back to column 0. */
function keyColumn(tab: string): number {
  const found: unknown = TAB_KEY_COLUMNS[tab];
  return typeof found === "number" ? found : 0;
}

/** "TAB!A121:S220" → end row (1-based). -1 when unparseable. */
function parseUpdatedEndRow(updatedRange: string): number {
  const match = /:([A-Za-z]+)(\d+)$/.exec(updatedRange);
  return match?.[2] ? Number(match[2]) : -1;
}

export class ComposioSheetsClient implements SheetsClient {
  private readonly gateway: ComposioGateway;
  private readonly queue: SheetsWriteQueue;
  /** spreadsheetId → {tabs, rowCounts} (row counts include the header row). */
  private readonly infoCache = new Map<string, { tabs: Map<string, number>; rows: Map<string, number> }>();

  constructor(apiKeyOrOptions: string | ComposioClientOptions) {
    const options: ComposioClientOptions =
      typeof apiKeyOrOptions === "string" ? { apiKey: apiKeyOrOptions } : apiKeyOrOptions;
    if (options.gateway) {
      this.gateway = options.gateway;
    } else {
      const base = {
        apiKey: options.apiKey,
        userId: options.userId ?? "trendpulse-local",
        timeoutMs: options.timeoutMs ?? 60000,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.onCall ? { onCall: options.onCall } : {}),
      };
      this.gateway = options.lock ? new RestComposioGateway(base, options.lock) : createGateway(base);
    }
    this.queue = options.queue ?? new SheetsWriteQueue();
  }

  private async checked<T>(op: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.gateway.execute(op, args);
    if (!result.ok) throw mapGatewayError(op, result);
    return result.data as T;
  }

  private cachedEntry(spreadsheetId: string): { tabs: Map<string, number>; rows: Map<string, number> } {
    let entry = this.infoCache.get(spreadsheetId);
    if (!entry) {
      entry = { tabs: new Map(), rows: new Map() };
      this.infoCache.set(spreadsheetId, entry);
    }
    return entry;
  }

  private async refreshInfo(spreadsheetId: string): Promise<Map<string, number>> {
    const info = await this.checked<SheetInfo>("spreadsheetInfo", { spreadsheet_id: spreadsheetId });
    const tabList = Array.isArray(info.tabs) ? info.tabs : [];
    const tabs = new Map(tabList.map((t) => [t.title, t.sheetId]));
    this.cachedEntry(spreadsheetId).tabs = tabs;
    return tabs;
  }

  private async tabIds(spreadsheetId: string): Promise<Map<string, number>> {
    const cached = this.cachedEntry(spreadsheetId).tabs;
    if (cached.size > 0) return cached;
    return this.refreshInfo(spreadsheetId);
  }

  /** Create a spreadsheet, then init tabs+headers (CMP-12). Returns id + URL. */
  async createSpreadsheet(title: string): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
    const created = await this.checked<{ spreadsheetId?: string; spreadsheetUrl?: string }>("createSpreadsheet", {
      title,
    });
    if (!created.spreadsheetId) {
      throw new SheetsApiError("spreadsheet create returned no id", { status: 500 });
    }
    return { spreadsheetId: created.spreadsheetId, spreadsheetUrl: created.spreadsheetUrl ?? "" };
  }

  async getTabTitles(spreadsheetId: string): Promise<string[]> {
    return [...(await this.tabIds(spreadsheetId)).keys()];
  }

  async addTab(spreadsheetId: string, title: string): Promise<void> {
    await this.queue.enqueue(`addTab ${title}`, () =>
      this.checked("addSheet", { spreadsheet_id: spreadsheetId, title }),
    );
    await this.refreshInfo(spreadsheetId);
  }

  async getFirstRow(spreadsheetId: string, tab: string): Promise<string[] | null> {
    const data = await this.checked<{ valueRanges?: { values?: unknown[][] }[] }>("readRanges", {
      spreadsheet_id: spreadsheetId,
      ranges: [`${tab}!1:1`],
    });
    const rows = data.valueRanges?.[0]?.values ?? [];
    if (rows.length === 0) return null;
    return (rows[0] ?? []).map(String);
  }

  async writeFirstRow(spreadsheetId: string, tab: string, headers: string[]): Promise<void> {
    await this.queue.enqueue(`writeFirstRow ${tab}`, () =>
      this.checked("writeRange", {
        spreadsheet_id: spreadsheetId,
        range: `${tab}!A1`,
        values: [headers],
        value_input_option: "RAW",
      }),
    );
    this.cachedEntry(spreadsheetId).rows.set(tab, 1);
  }

  async appendRows(spreadsheetId: string, tab: string, rows: string[][]): Promise<void> {
    if (rows.length === 0) return;
    await this.queue.enqueue(`appendRows ${tab} x${String(rows.length)}`, () => this.appendOnce(spreadsheetId, tab, rows));
  }

  /** One append attempt + idempotent retry (CMP-05). Runs inside the queue. */
  private async appendOnce(spreadsheetId: string, tab: string, rows: string[][]): Promise<void> {
    try {
      const data = await this.checked<{ updatedRange?: string }>("appendRows", {
        spreadsheet_id: spreadsheetId,
        range: tab,
        values: rows,
        value_input_option: "RAW",
      });
      this.noteAppended(spreadsheetId, tab, rows.length, data.updatedRange);
      return;
    } catch (error) {
      if (!(error instanceof SheetsApiError)) throw error;
    }
    // Ambiguous failure: the rows may have landed. Drop the ones that did.
    const keyIndex = keyColumn(tab);
    const keys = new Set(rows.map((r) => r[keyIndex] ?? ""));
    const landed = await this.readKeyColumn(spreadsheetId, tab, rows.length + 50, keyIndex);
    const missing = rows.filter((r) => !landed.has(r[keyIndex] ?? ""));
    if (missing.length === 0) {
      this.noteAppended(spreadsheetId, tab, rows.length, undefined);
      return;
    }
    if (missing.length === rows.length && keys.size > 0) {
      // Nothing landed (or keys unreadable) — single straight retry.
      const data = await this.checked<{ updatedRange?: string }>("appendRows", {
        spreadsheet_id: spreadsheetId,
        range: tab,
        values: rows,
        value_input_option: "RAW",
      });
      this.noteAppended(spreadsheetId, tab, rows.length, data.updatedRange);
      return;
    }
    const data = await this.checked<{ updatedRange?: string }>("appendRows", {
      spreadsheet_id: spreadsheetId,
      range: tab,
      values: missing,
      value_input_option: "RAW",
    });
    this.noteAppended(spreadsheetId, tab, rows.length, data.updatedRange);
  }

  private noteAppended(spreadsheetId: string, tab: string, count: number, updatedRange: string | undefined): void {
    const entry = this.cachedEntry(spreadsheetId);
    if (updatedRange) {
      const endRow = parseUpdatedEndRow(updatedRange);
      if (endRow > 0) {
        entry.rows.set(tab, endRow);
        return;
      }
    }
    entry.rows.set(tab, (entry.rows.get(tab) ?? 1) + count);
  }

  /** Key-column values of the tail window (for dedup). */
  private async readKeyColumn(
    spreadsheetId: string,
    tab: string,
    tailRows: number,
    keyCol: number,
  ): Promise<Set<string>> {
    const known = this.cachedEntry(spreadsheetId).rows.get(tab);
    const letter = columnLetter(keyCol);
    const range = known !== undefined && known > 1 ? `${tab}!${letter}${String(Math.max(2, known - tailRows + 1))}:${letter}` : `${tab}!${letter}:${letter}`;
    const data = await this.checked<{ valueRanges?: { values?: unknown[][] }[] }>("readRanges", {
      spreadsheet_id: spreadsheetId,
      ranges: [range],
    });
    const values = data.valueRanges?.[0]?.values ?? [];
    return new Set(values.flat().map(String));
  }

  async getAllValues(spreadsheetId: string, tab: string): Promise<string[][]> {
    const data = await this.checked<{ valueRanges?: { values?: unknown[][] }[] }>("readRanges", {
      spreadsheet_id: spreadsheetId,
      ranges: [tab],
    });
    const values = data.valueRanges?.[0]?.values ?? [];
    if (values.length > 0) this.cachedEntry(spreadsheetId).rows.set(tab, values.length);
    return values.map((row) => row.map((cell) => String(cell)));
  }

  async batchUpdate(spreadsheetId: string, updates: TabRangeUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    await this.queue.enqueue(`batchUpdate x${String(updates.length)}`, () =>
      this.checked("updateRanges", {
        spreadsheet_id: spreadsheetId,
        data: updates.map((u) => ({ range: u.range, values: u.values })),
        value_input_option: "RAW",
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
    const ids = await this.tabIds(spreadsheetId);
    const sheetId = ids.get(tab);
    if (sheetId === undefined) {
      throw new SheetsApiError(`Requested entity was not found (tab '${tab}')`, {
        status: 404,
        errorCode: "SHEET_NOT_FOUND",
      });
    }
    await this.queue.enqueue(`deleteRows ${tab} ${String(startRowIndex)}-${String(endRowIndexExclusive)}`, () =>
      this.checked("deleteRows", {
        spreadsheet_id: spreadsheetId,
        sheet_id: sheetId,
        tab,
        start_index: startRowIndex,
        end_index_exclusive: endRowIndexExclusive,
      }),
    );
    this.cachedEntry(spreadsheetId).rows.delete(tab);
  }
}

/** Gateway failure → SheetsApiError with the repo/queue-compatible codes (CMP-11). */
export function mapGatewayError(op: string, result: ExecuteResult): SheetsApiError {
  const message = result.error ?? `Composio ${op} failed`;
  const status = result.status;
  let errorCode: SheetsErrorCode | undefined;
  if (status === 429) errorCode = "QUOTA";
  else if (status === 403) errorCode = "FORBIDDEN";
  else if (status === 404 && /requested entity was not found/i.test(message)) errorCode = "SHEET_NOT_FOUND";
  else if ((status === 400 || status === 404) && /unable to parse range|range .* not found/i.test(message)) {
    errorCode = "RANGE_NOT_FOUND";
  }
  return new SheetsApiError(message, { status, errorCode, retryAfterSeconds: result.retryAfterSeconds });
}
